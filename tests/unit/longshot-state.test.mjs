import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LONGSHOT_STATES,
  LONGSHOT_STATE_LIST,
  LONGSHOT_EVENTS,
  allowedTransitions,
  longshotTransitionTable,
  canTransition,
  isTerminalLongshotState,
  describeLongshotState,
  createLongshotStateMachine,
} from '../../extension/src/lib/longshot-state.js';

function machine(options = {}) {
  let clock = 1000;
  const instance = createLongshotStateMachine({ now: () => clock, ...options });
  return {
    instance,
    tick(ms = 1) {
      clock += ms;
      return clock;
    },
    now() {
      return clock;
    },
  };
}

test('迁移表：无重复 from+event，覆盖全部 7 状态，事件名来自 LONGSHOT_EVENTS', () => {
  const table = longshotTransitionTable();
  const seen = new Set();
  const eventNames = new Set(Object.values(LONGSHOT_EVENTS));
  for (const rule of table) {
    assert.ok(eventNames.has(rule.event), '未知事件 ' + rule.event);
    for (const from of rule.from) {
      assert.ok(LONGSHOT_STATE_LIST.includes(from), '未知状态 ' + from);
      const key = from + '|' + rule.event;
      assert.equal(seen.has(key), false, '重复迁移 ' + key);
      seen.add(key);
    }
  }
  for (const state of LONGSHOT_STATE_LIST) {
    assert.ok(table.some((rule) => rule.from.includes(state)), '状态 ' + state + ' 没有出边');
  }
  assert.deepEqual(LONGSHOT_STATE_LIST, ['idle', 'capturing', 'stitching', 'stale', 'sealed', 'recovered', 'failed']);
});

test('allowedTransitions/canTransition：idle 与 terminal 的出边', () => {
  assert.deepEqual(allowedTransitions('idle').map((rule) => rule.event), ['capture.begin', 'recover.begin', 'fail', 'reset']);
  assert.equal(canTransition('capturing', 'stitch.begin'), true);
  assert.equal(canTransition('capturing', 'seal'), false);
  assert.equal(canTransition('stale', 'stale.retry'), true);
  assert.equal(canTransition('stale', 'capture.progress'), true);
  assert.equal(canTransition('sealed', 'capture.begin'), false);
  assert.equal(canTransition('unknown', 'capture.begin'), false);
  assert.deepEqual(allowedTransitions('bogus').map((rule) => rule.event), allowedTransitions('idle').map((rule) => rule.event));
  assert.equal(isTerminalLongshotState('sealed'), true);
  assert.equal(isTerminalLongshotState('failed'), true);
  assert.equal(isTerminalLongshotState('recovered'), false);
  assert.equal(describeLongshotState('capturing'), '采集中');
  assert.match(describeLongshotState('weird'), /未知状态/);
});

test('正常路径：idle→capturing→stitching→sealed 且证据完整', () => {
  const h = machine();
  const begin = h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 3, url: 'https://x', dpr: 1.5, totalSegments: 2 });
  assert.equal(begin.ok, true);
  assert.equal(begin.from, 'idle');
  assert.equal(begin.to, 'capturing');
  assert.equal(begin.duplicate, false);
  assert.deepEqual(begin.evidence.facts, { tabId: 3, url: 'https://x', totalSegments: 2, dpr: 1.5 });
  assert.equal(begin.state.state, 'capturing');
  assert.equal(begin.state.label, '采集中');
  h.tick();
  const progress = h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_PROGRESS, { tiles: 12, segments: 1 });
  assert.equal(progress.ok, true);
  assert.equal(progress.state.tiles, 12);
  const stitch = h.instance.transition('cap-a', LONGSHOT_EVENTS.STITCH_BEGIN, { tiles: 12, segments: 1 });
  assert.equal(stitch.to, 'stitching');
  const seal = h.instance.transition('cap-a', LONGSHOT_EVENTS.SEAL, { totalSegments: 1, sealedSegments: 1, hashVerified: true });
  assert.equal(seal.ok, true);
  assert.equal(seal.to, 'sealed');
  assert.equal(h.instance.isTerminal('cap-a'), true);
  const snapshot = h.instance.snapshot('cap-a');
  assert.equal(snapshot.state, 'sealed');
  assert.equal(snapshot.tiles, 12);
  assert.equal(snapshot.hashVerified, true);
  assert.equal(snapshot.transitions, 4);
  assert.deepEqual(snapshot.history.map((entry) => entry.event), ['capture.begin', 'capture.progress', 'stitch.begin', 'seal']);
  const counters = h.instance.counters();
  assert.equal(counters.transitions, 4);
  assert.equal(counters.seals, 1);
  assert.equal(counters.runs, 1);
  assert.deepEqual(counters.states, { sealed: 1 });
});

test('非法迁移被拒绝：证据含 from/to/event/allowed', () => {
  const h = machine();
  h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  const rejected = h.instance.transition('cap-a', LONGSHOT_EVENTS.SEAL, { totalSegments: 1 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'LONGSHOT_TRANSITION');
  assert.equal(rejected.evidence.from, 'capturing');
  assert.equal(rejected.evidence.to, null, '调用方没有声明目标时证据如实为 null');
  assert.equal(rejected.evidence.event, 'seal');
  assert.ok(Array.isArray(rejected.evidence.allowed));
  assert.ok(rejected.evidence.allowed.some((rule) => rule.event === 'stitch.begin'));
  assert.equal(rejected.evidence.facts.totalSegments, 1);
  assert.match(rejected.error, /非法长截图迁移：capturing -\[seal\]-> \?/);
  const withTarget = h.instance.transition('cap-a', LONGSHOT_EVENTS.SEAL, { totalSegments: 1, to: 'sealed' });
  assert.equal(withTarget.evidence.to, 'sealed', '调用方声明的目标进入证据');
  assert.equal(h.instance.snapshot('cap-a').rejected, 2);
  assert.equal(h.instance.snapshot('cap-a').lastRejection.code, 'LONGSHOT_TRANSITION');
  // terminal 不能再开始采集
  h.instance.transition('cap-a', LONGSHOT_EVENTS.STITCH_BEGIN, { tiles: 1 });
  h.instance.transition('cap-a', LONGSHOT_EVENTS.SEAL, { totalSegments: 1, sealedSegments: 1, hashVerified: true });
  const restart = h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  assert.equal(restart.ok, false);
  assert.equal(restart.evidence.from, 'sealed');
  // 未命中迁移表时 to 取调用方声明的目标（可为 null）
  const unknown = h.instance.transition('cap-a', 'bogus.event', { to: 'stitching' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.evidence.to, 'stitching');
});

test('seal 闸门：缺 total/分片不齐/hash 未校验都拒绝', () => {
  const h = machine();
  h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  h.instance.transition('cap-a', LONGSHOT_EVENTS.STITCH_BEGIN, { tiles: 2 });
  const noTotal = h.instance.transition('cap-a', LONGSHOT_EVENTS.SEAL, {});
  assert.equal(noTotal.code, 'LONGSHOT_NO_TOTAL');
  const incomplete = h.instance.transition('cap-a', LONGSHOT_EVENTS.SEAL, { totalSegments: 2, sealedSegments: 1 });
  assert.equal(incomplete.code, 'LONGSHOT_INCOMPLETE');
  assert.match(incomplete.error, /1\/2/);
  const unverified = h.instance.transition('cap-a', LONGSHOT_EVENTS.SEAL, { totalSegments: 2, sealedSegments: 2, hashVerified: false });
  assert.equal(unverified.code, 'LONGSHOT_HASH_UNVERIFIED');
  assert.equal(unverified.evidence.to, 'sealed');
  const pass = h.instance.transition('cap-a', LONGSHOT_EVENTS.SEAL, { totalSegments: 2, sealedSegments: 2, hashVerified: true });
  assert.equal(pass.ok, true);
});

test('capture.begin 需要 tabId 证据', () => {
  const h = machine();
  const rejected = h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { url: 'https://x' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'LONGSHOT_NO_TAB');
  assert.equal(rejected.evidence.to, 'capturing');
  assert.equal(rejected.evidence.facts.url, 'https://x');
});

test('stale 路径：detected→retry 回采集，次数上限拒绝', () => {
  const h = machine({ maxStaleAttempts: 3 });
  h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  const detected = h.instance.transition('cap-a', LONGSHOT_EVENTS.STALE_DETECTED, { changed: ['scrollHeight'], action: 'extend' });
  assert.equal(detected.to, 'stale');
  assert.deepEqual(detected.evidence.facts.changed, ['scrollHeight']);
  const progress = h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_PROGRESS, { tiles: 5 });
  assert.equal(progress.ok, true, 'stale 原地修复可继续报进度');
  const retry = h.instance.transition('cap-a', LONGSHOT_EVENTS.STALE_RETRY, { attempts: 1, maxStaleAttempts: 3 });
  assert.equal(retry.ok, true);
  assert.equal(retry.to, 'capturing');
  assert.equal(h.instance.snapshot('cap-a').staleRetries, 1);
  h.instance.transition('cap-a', LONGSHOT_EVENTS.STALE_DETECTED, { changed: ['scrollHeight'] });
  const exhausted = h.instance.transition('cap-a', LONGSHOT_EVENTS.STALE_RETRY, { attempts: 3, maxStaleAttempts: 3 });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, 'LONGSHOT_STALE_BUDGET');
  assert.match(exhausted.error, /3 已达上限 3/);
  assert.ok(exhausted.evidence.allowed.some((rule) => rule.event === 'stale.retry'));
  // 默认上限 3：不传 attempts 时按已重试次数+1 计算
  const h2 = machine();
  h2.instance.transition('cap-b', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  h2.instance.transition('cap-b', LONGSHOT_EVENTS.STALE_DETECTED, {});
  h2.instance.transition('cap-b', LONGSHOT_EVENTS.STALE_RETRY, { attempts: 1 });
  h2.instance.transition('cap-b', LONGSHOT_EVENTS.STALE_DETECTED, {});
  h2.instance.transition('cap-b', LONGSHOT_EVENTS.STALE_RETRY, { attempts: 2 });
  h2.instance.transition('cap-b', LONGSHOT_EVENTS.STALE_DETECTED, {});
  const third = h2.instance.transition('cap-b', LONGSHOT_EVENTS.STALE_RETRY, {});
  assert.equal(third.code, 'LONGSHOT_STALE_BUDGET');
});

test('stale 原地修复后可 stitch.begin 继续拼接', () => {
  const h = machine();
  h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  h.instance.transition('cap-a', LONGSHOT_EVENTS.STALE_DETECTED, { action: 'extend' });
  const stitch = h.instance.transition('cap-a', LONGSHOT_EVENTS.STITCH_BEGIN, { tiles: 3, segments: 1 });
  assert.equal(stitch.ok, true);
  assert.equal(stitch.to, 'stitching');
});

test('recover.begin：未封版有分片 → recovered；已封版/无分片拒绝', () => {
  const h = machine();
  const ok = h.instance.transition('cap-a', LONGSHOT_EVENTS.RECOVER_BEGIN, { tiles: 4, manifestSealed: false, dpr: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.to, 'recovered');
  assert.equal(ok.state.recovered, true);
  assert.equal(h.instance.counters().recoveries, 1);
  const sealed = h.instance.transition('cap-b', LONGSHOT_EVENTS.RECOVER_BEGIN, { tiles: 4, manifestSealed: true });
  assert.equal(sealed.code, 'LONGSHOT_ALREADY_SEALED');
  const empty = h.instance.transition('cap-c', LONGSHOT_EVENTS.RECOVER_BEGIN, { tiles: 0 });
  assert.equal(empty.code, 'LONGSHOT_NO_TILES');
  // recovered 可以再封版（恢复产物写文件后仍要封版记账）
  const seal = h.instance.transition('cap-a', LONGSHOT_EVENTS.SEAL, { totalSegments: 4, sealedSegments: 4, hashVerified: true });
  assert.equal(seal.ok, true);
  assert.equal(seal.to, 'sealed');
});

test('fail/reset：任意状态可 reset，失败原因留证据', () => {
  const h = machine();
  h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  const failed = h.instance.transition('cap-a', LONGSHOT_EVENTS.FAIL, { reason: 'debugger detached', tiles: 2 });
  assert.equal(failed.to, 'failed');
  assert.equal(failed.state.failedReason, 'debugger detached');
  assert.equal(failed.state.terminal, true);
  const repeat = h.instance.transition('cap-a', LONGSHOT_EVENTS.FAIL, { reason: 'again' });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.duplicate, true);
  assert.equal(h.instance.snapshot('cap-a').failures, 1, '重复失败不重复计数');
  const reset = h.instance.transition('cap-a', LONGSHOT_EVENTS.RESET, {});
  assert.equal(reset.to, 'idle');
  assert.equal(h.instance.snapshot('cap-a').recovered, false);
  assert.equal(h.instance.counters().resets, 1);
  // 每个非终态都能 fail
  for (const state of ['idle', 'capturing', 'stitching', 'stale', 'recovered']) {
    assert.equal(canTransition(state, 'fail'), true, state + ' 应允许 fail');
  }
});

test('重复声明同一迁移是幂等：只更新事实不重复计数', () => {
  const h = machine();
  h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  const first = h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_PROGRESS, { tiles: 1 });
  const second = h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_PROGRESS, { tiles: 2 });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.ok, true);
  const snapshot = h.instance.snapshot('cap-a');
  assert.equal(snapshot.tiles, 2);
  assert.equal(snapshot.transitions, 2);
  assert.equal(h.instance.counters().duplicates, 1);
});

test('参数与隔离：空 captureId/缺 event 返回 E_BAD_ARG；history 有界；maxRuns 淘汰', () => {
  const h = machine({ historyLimit: 3, maxRuns: 2 });
  assert.equal(h.instance.transition('', 'capture.begin', { tabId: 1 }).code, 'E_BAD_ARG');
  assert.equal(h.instance.transition(null, 'capture.begin', { tabId: 1 }).code, 'E_BAD_ARG');
  h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  assert.equal(h.instance.transition('cap-a', '', {}).code, 'E_BAD_ARG');
  for (let index = 0; index < 6; index += 1) {
    h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_PROGRESS, { tiles: index });
  }
  assert.equal(h.instance.snapshot('cap-a').history.length, 3);
  h.instance.transition('cap-b', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  h.instance.transition('cap-c', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1 });
  assert.deepEqual(h.instance.list().map((run) => run.captureId).sort(), ['cap-b', 'cap-c']);
  assert.equal(h.instance.snapshot('cap-a'), null);
  assert.equal(h.instance.get('cap-b'), 'capturing');
  assert.equal(h.instance.clear('cap-b'), true);
  assert.equal(h.instance.clear('cap-b'), false);
  assert.equal(h.instance.snapshot('cap-b'), null);
});

test('evidence：紧凑运行证据（无历史数组）', () => {
  const h = machine();
  h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 7, url: 'u', dpr: 2, totalSegments: 3 });
  h.instance.transition('cap-a', LONGSHOT_EVENTS.CAPTURE_PROGRESS, { tiles: 9, segments: 1 });
  const evidence = h.instance.evidence('cap-a');
  assert.equal(evidence.captureId, 'cap-a');
  assert.equal(evidence.state, 'capturing');
  assert.equal(evidence.event, 'capture.progress');
  assert.equal(evidence.tiles, 9);
  assert.equal(evidence.totalSegments, 3);
  assert.equal(evidence.terminal, false);
  assert.equal(evidence.history, undefined);
  assert.equal(h.instance.evidence('missing'), null);
});
