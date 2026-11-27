import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TabControl,
  CONTROL_MODES,
  DEFAULT_CONTROL_LEASE_MS,
  MIN_CONTROL_LEASE_MS,
  MAX_CONTROL_LEASE_MS,
} from '../../lib/tab-control.mjs';

/** 可控时钟：租约到期/续租都能精确断言，不依赖真实时间。 */
function createClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; return now; },
  };
}

function setup({ mode = 'exclusive', leaseMs = 10_000 } = {}) {
  const clock = createClock();
  const control = new TabControl({ now: clock.now, defaultLeaseMs: leaseMs });
  control.attach(7, 'A', { mode });
  control.attach(7, 'B');
  return { clock, control };
}

test('常量与模式清单稳定', () => {
  assert.deepEqual(CONTROL_MODES, ['open', 'exclusive']);
  assert.equal(DEFAULT_CONTROL_LEASE_MS, 60_000);
  assert.ok(MIN_CONTROL_LEASE_MS < DEFAULT_CONTROL_LEASE_MS);
  assert.ok(MAX_CONTROL_LEASE_MS > DEFAULT_CONTROL_LEASE_MS);
});

test('单会话 tab 不参与仲裁：没登记时一律放行', () => {
  const control = new TabControl();
  const decision = control.check(7, 'A', { mutating: true, method: 'click' });
  assert.equal(decision.ok, true);
  assert.equal(decision.control, null);
});

test('attach 建立 primary/holder，status 反映共享会话', () => {
  const { control } = setup();
  const status = control.status(7);
  assert.equal(status.primary, 'A');
  assert.equal(status.holder, 'A');
  assert.equal(status.shared, true);
  assert.equal(status.sessionCount, 2);
  assert.deepEqual(status.sessions, ['A', 'B']);
  assert.equal(status.mode, 'exclusive');
  assert.equal(status.holderIsPrimary, true);
});

test('exclusive：非持有者变更被拒（E_CONTROL_NOT_HELD），带上 holder/epoch', () => {
  const { control } = setup();
  const epochBefore = control.status(7).epoch;
  const decision = control.check(7, 'B', { mutating: true, method: 'click' });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'E_CONTROL_NOT_HELD');
  assert.equal(decision.data.holder, 'A');
  assert.equal(decision.data.mode, 'exclusive');
  assert.equal(decision.data.method, 'click');
  assert.match(decision.data.hint, /handoff/);
  // 被拒不算换代：epoch 与 holder 都不变
  assert.equal(control.status(7).epoch, epochBefore);
  assert.equal(control.status(7).holder, 'A');
});

test('exclusive：持有者写动作续租，epoch 不变', () => {
  const { clock, control } = setup({ leaseMs: 10_000 });
  clock.advance(4_000);
  assert.equal(control.status(7).leaseRemainingMs, 6_000);
  const decision = control.check(7, 'A', { mutating: true, method: 'fill' });
  assert.equal(decision.ok, true);
  assert.equal(decision.renewed, true);
  assert.equal(control.status(7).leaseRemainingMs, 10_000);
  assert.equal(control.status(7).epoch, 0);
});

test('只读动作永远放行，且不续租', () => {
  const { clock, control } = setup({ leaseMs: 10_000 });
  clock.advance(4_000);
  for (const sid of ['A', 'B']) {
    const decision = control.check(7, sid, { mutating: false, method: 'observe' });
    assert.equal(decision.ok, true);
    assert.equal(decision.readOnly, true);
  }
  assert.equal(control.status(7).leaseRemainingMs, 6_000);
});

test('租约到期 → holder 变空（epoch+1）；随后先到先得', () => {
  const { clock, control } = setup({ leaseMs: 5_000 });
  clock.advance(5_001);
  const expired = control.status(7);
  assert.equal(expired.holder, null);
  assert.equal(expired.epoch, 1);
  assert.equal(expired.lastTransition.reason, 'expire');

  const acquired = control.check(7, 'B', { mutating: true, method: 'click' });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.acquired, true);
  assert.equal(control.status(7).holder, 'B');
  assert.equal(control.status(7).epoch, 2);

  // 原持有者再写被拒
  const blocked = control.check(7, 'A', { mutating: true, method: 'click' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'E_CONTROL_NOT_HELD');
  assert.equal(blocked.data.holder, 'B');
});

test('open 模式：共享写不拦，但记录当前写者（epoch 随写者切换推进）', () => {
  const { control } = setup({ mode: 'open' });
  const first = control.check(7, 'B', { mutating: true, method: 'click' });
  assert.equal(first.ok, true);
  assert.equal(first.acquired, true);
  assert.equal(control.status(7).holder, 'B');
  const back = control.check(7, 'A', { mutating: true, method: 'fill' });
  assert.equal(back.ok, true);
  assert.equal(control.status(7).holder, 'A');
  assert.equal(control.status(7).epoch, 2);
});

test('claim：空闲可认领；被占 E_CONTROL_BUSY；已持有算续租', () => {
  const { clock, control } = setup({ leaseMs: 5_000 });
  const busy = control.claim(7, 'B');
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'E_CONTROL_BUSY');
  assert.equal(busy.data.holder, 'A');
  assert.match(busy.data.hint, /handoff/);

  clock.advance(5_001); // 租约到期 → 空闲
  const claimed = control.claim(7, 'B', { leaseMs: 20_000 });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.acquired, true);
  assert.equal(control.status(7).holder, 'B');
  assert.equal(control.status(7).leaseRemainingMs, 20_000);

  const renewed = control.claim(7, 'B');
  assert.equal(renewed.ok, true);
  assert.equal(renewed.renewed, true);
});

test('claim：主会话可以无条件收回被借出的控制权（其余会话不行）', () => {
  const { control } = setup();
  const handoff = control.handoff(7, 'A', 'B');
  assert.equal(handoff.ok, true);
  assert.equal(control.status(7).holder, 'B');

  const back = control.claim(7, 'A');
  assert.equal(back.ok, true);
  assert.equal(back.acquired, true);
  assert.equal(back.preempted, 'B');
  assert.equal(control.status(7).holder, 'A');
  assert.equal(control.status(7).holderIsPrimary, true);
});

test('release：非持有者被拒；持有者释放后 holder 为空、epoch+1、租约清零', () => {
  const { control } = setup();
  const denied = control.release(7, 'B');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'E_CONTROL_NOT_HELD');

  const released = control.release(7, 'A');
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  const status = control.status(7);
  assert.equal(status.holder, null);
  assert.equal(status.epoch, 1);
  assert.equal(status.leaseRemainingMs, 0);
  assert.equal(status.lastTransition.reason, 'release');
});

test('handoff：源必须是持有者，目标必须同 tab，不能转给自己', () => {
  const { control } = setup();
  control.attach(8, 'C');

  assert.equal(control.handoff(7, 'B', 'A').code, 'E_CONTROL_NOT_HELD');
  assert.equal(control.handoff(7, 'A', 'C').code, 'E_BAD_ARG');
  assert.equal(control.handoff(7, 'A', 'A').code, 'E_BAD_ARG');
  assert.equal(control.handoff(7, 'A', undefined).code, 'E_BAD_ARG');

  const ok = control.handoff(7, 'A', 'B', { leaseMs: 3_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.from, 'A');
  assert.equal(ok.to, 'B');
  const status = control.status(7);
  assert.equal(status.holder, 'B');
  assert.equal(status.epoch, 1);
  assert.equal(status.leaseRemainingMs, 3_000);
  assert.equal(status.holderIsPrimary, false);
  assert.equal(status.lastTransition.reason, 'handoff');
});

test('expectEpoch CAS：不匹配 E_CONTROL_STALE，匹配才执行', () => {
  const { control } = setup();
  const stale = control.handoff(7, 'A', 'B', { expectEpoch: 5 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'E_CONTROL_STALE');
  assert.equal(stale.data.epoch, 0);
  assert.equal(stale.data.expectEpoch, 5);

  const ok = control.handoff(7, 'A', 'B', { expectEpoch: 0 });
  assert.equal(ok.ok, true);

  const staleRelease = control.release(7, 'B', { expectEpoch: 0 });
  assert.equal(staleRelease.code, 'E_CONTROL_STALE');
  const bad = control.claim(7, 'B', { expectEpoch: 'nope' });
  assert.equal(bad.code, 'E_BAD_ARG');
});

test('unregister：主会话离开 → 最老共享会话接手 primary 与控制权', () => {
  const { control } = setup();
  control.attach(7, 'C');
  const outcome = control.unregister(7, 'A');
  assert.equal(outcome.removed, true);
  assert.equal(outcome.closed, false);
  assert.equal(outcome.promotedTo, 'B');
  const status = control.status(7);
  assert.equal(status.primary, 'B');
  assert.equal(status.holder, 'B');
  assert.deepEqual(status.sessions, ['B', 'C']);
  assert.ok(status.epoch >= 1);
});

test('unregister：最后一个会话离开 → 控制记录整体清空', () => {
  const control = new TabControl();
  control.attach(7, 'A');
  const outcome = control.unregister(7, 'A');
  assert.equal(outcome.closed, true);
  assert.equal(outcome.promotedTo, null);
  assert.equal(control.status(7), null);
  assert.deepEqual(control.snapshot(), []);
});

test('unregister：共享会话离开不影响主会话的控制权', () => {
  const { control } = setup();
  const outcome = control.unregister(7, 'B');
  assert.equal(outcome.removed, true);
  assert.equal(outcome.promotedTo, null);
  assert.equal(outcome.closed, false);
  const status = control.status(7);
  assert.equal(status.primary, 'A');
  assert.equal(status.holder, 'A');
  assert.equal(status.shared, false);
});

test('sync 自愈：补齐新会话、剔除消失会话、holder 失效时回落到 primary', () => {
  const { control } = setup();
  // 新共享会话加入
  let view = control.sync(7, ['A', 'B', 'C']);
  assert.deepEqual(view.sessions, ['A', 'B', 'C']);
  assert.equal(view.holder, 'A');
  // holder 消失：epoch 推进并回落到 primary
  control.handoff(7, 'A', 'C');
  const epochBefore = control.status(7).epoch;
  view = control.sync(7, ['A', 'B']);
  assert.equal(view.holder, 'A');
  assert.equal(view.primary, 'A');
  assert.ok(view.epoch > epochBefore);
  // 没有会话了：记录被清掉
  assert.equal(control.sync(7, []), null);
  assert.equal(control.status(7), null);
});

test('sync 可以按需切换模式（只在变化时记录）', () => {
  const { control } = setup({ mode: 'open' });
  const changed = control.sync(7, ['A', 'B'], { mode: 'exclusive' });
  assert.equal(changed.mode, 'exclusive');
  assert.equal(changed.lastTransition.reason, 'mode');
  const same = control.sync(7, ['A', 'B'], { mode: 'exclusive' });
  assert.equal(same.mode, 'exclusive');
});

test('setMode 校验非法模式并保持幂等', () => {
  const { control } = setup({ mode: 'open' });
  assert.equal(control.setMode(7, 'nope').code, 'E_BAD_ARG');
  assert.equal(control.setMode(7, 'open').unchanged, true);
  const changed = control.setMode(7, 'exclusive');
  assert.equal(changed.ok, true);
  assert.equal(changed.unchanged, false);
  assert.equal(control.status(7).mode, 'exclusive');
  // 未登记的 tab + 没有会话 id：E_NO_SESSION
  assert.equal(control.setMode(99, 'open').code, 'E_NO_SESSION');
});

test('租约时长归一：过小/过大/非法都夹到合法区间', () => {
  const { control } = setup({ leaseMs: 1_000 });
  const small = control.claim(7, 'A', { leaseMs: 10 });
  assert.equal(small.ok, true);
  assert.equal(control.status(7).leaseMs, MIN_CONTROL_LEASE_MS);

  control.handoff(7, 'A', 'B', { leaseMs: 99_999_999 });
  assert.equal(control.status(7).leaseMs, MAX_CONTROL_LEASE_MS);

  control.handoff(7, 'B', 'A', { leaseMs: 'abc' });
  assert.equal(control.status(7).leaseMs, MAX_CONTROL_LEASE_MS); // 非法值沿用原租约
});

test('history 有上限，lastTransition 记录每次变化', () => {
  const clock = createClock();
  const control = new TabControl({ now: clock.now, defaultLeaseMs: 1_000, historyLimit: 3 });
  control.attach(7, 'A', { mode: 'open' });
  control.attach(7, 'B');
  for (let i = 0; i < 5; i += 1) {
    control.check(7, i % 2 ? 'A' : 'B', { mutating: true, method: 'click' });
    clock.advance(10);
  }
  const status = control.status(7);
  assert.equal(status.history.length, 3);
  assert.ok(status.lastTransition);
  assert.equal(status.lastTransition.reason, 'implicit');
});

test('touch 只续租当前持有者，其他会话无效', () => {
  const { clock, control } = setup({ leaseMs: 10_000 });
  clock.advance(4_000);
  control.touch(7, 'B');
  assert.equal(control.status(7).leaseRemainingMs, 6_000);
  control.touch(7, 'A', { leaseMs: 20_000 });
  assert.equal(control.status(7).leaseRemainingMs, 20_000);
  assert.equal(control.status(7).holder, 'A');
  assert.equal(control.touch(99, 'A'), null);
});

test('sync 的 primary 提示优先于“最老会话”（daemon 重启后共享会话先登记也能纠正）', () => {
  const control = new TabControl();
  control.attach(7, 'B'); // 极端情况：只有共享会话先登记
  const view = control.sync(7, ['A', 'B'], { primary: 'A' });
  assert.equal(view.primary, 'A');
  assert.equal(view.holder, 'A');
  assert.equal(view.epoch, 1);
  // 再同步一次不会重复换代
  const again = control.sync(7, ['A', 'B'], { primary: 'A' });
  assert.equal(again.epoch, 1);
});

test('clear/forget 清空登记表', () => {
  const { control } = setup();
  assert.equal(control.snapshot().length, 1);
  control.forget(7);
  assert.equal(control.status(7), null);
  control.attach(9, 'X');
  control.clear();
  assert.deepEqual(control.snapshot(), []);
});
