// tests/unit/session-lease.test.mjs —— 多会话 tab 所有权租约：互斥/续租/共享/释放/冲突证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LEASE_TTL_MS,
  createSessionLeases,
} from '../../lib/session-lease.mjs';

function clocked(options = {}) {
  let now = 1_000_000;
  const leases = createSessionLeases({ now: () => now, defaultTtlMs: 60_000, ...options });
  return { leases, advance: (ms) => { now += ms; return now; } };
}

test('独占租约：第二个会话被拒绝，冲突证据包含 holder/取得时间/原因/剩余租期/epoch', () => {
  const { leases } = clocked();
  const first = leases.acquire(7, 's1', { reason: 'session-start' });
  assert.equal(first.ok, true);
  assert.equal(first.acquired, true);
  assert.equal(first.lease.holder, 's1');
  const second = leases.acquire(7, 's2', { reason: 'rebind' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E_TAB_LEASE_HELD');
  const conflict = second.conflict;
  assert.equal(conflict.tabId, 7);
  assert.equal(conflict.holder, 's1');
  assert.equal(conflict.reason, 'session-start');
  assert.equal(conflict.requestedBy, 's2');
  assert.equal(conflict.requestedReason, 'rebind');
  assert.equal(conflict.epoch, 1);
  assert.equal(conflict.remainingMs > 0, true);
  assert.equal(conflict.expiresAt > conflict.acquiredAt, true);
  assert.equal(conflict.history.length >= 1, true);
  assert.equal(conflict.history.some((item) => item.type === 'acquire' && item.to === 's1'), true);
});

test('同一会话重复 acquire 是续租（renewed），不换代', () => {
  const { leases, advance } = clocked();
  const first = leases.acquire(1, 's1', { reason: 'session-start' });
  const epoch = first.lease.epoch;
  advance(500);
  const renewed = leases.acquire(1, 's1', { reason: 'tab-claim' });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.lease.epoch, epoch);
  assert.equal(renewed.lease.leaseRemainingMs > first.lease.leaseRemainingMs - 1000, true);
  assert.equal(leases.status(1).history.filter((item) => item.type === 'renew').length, 1);
});

test('非幂等动作 UNKNOWN 之外的场景：non-holder renew 被拒绝并给证据', () => {
  const { leases } = clocked();
  leases.acquire(1, 's1');
  const result = leases.renew(1, 's2', { reason: 'touch' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_TAB_LEASE_NOT_HELD');
  assert.equal(result.conflict.holder, 's1');
  assert.equal(result.conflict.requestedBy, 's2');
  const noLease = leases.renew(99, 's2');
  assert.equal(noLease.ok, false);
  assert.equal(noLease.conflict.reason, 'no-lease');
});

test('共享 join：不抢 holder，只登记参与者；参与者 release 只摘自己', () => {
  const { leases } = clocked();
  leases.acquire(7, 's1', { reason: 'session-start' });
  const joined = leases.join(7, 's2', { reason: 'share-attach' });
  assert.equal(joined.ok, true);
  assert.equal(joined.shared, true);
  assert.equal(joined.holder, 's1');
  assert.equal(leases.status(7).participantCount, 2);
  assert.deepEqual(leases.participants(7).map((item) => item.sessionId).sort(), ['s1', 's2']);
  // 参与者离开：holder 不变。
  const released = leases.release(7, 's2', { reason: 'session-stop' });
  assert.equal(released.ok, true);
  assert.equal(released.removed, true);
  assert.equal(released.released, false);
  assert.equal(leases.ownerOf(7), 's1');
  assert.equal(leases.status(7).participantCount, 1);
});

test('holder release：按接入顺序晋升下一个参与者（handoff 证据）', () => {
  const { leases } = clocked();
  leases.acquire(7, 's1', { reason: 'session-start' });
  leases.join(7, 's2', { reason: 'share-attach' });
  leases.join(7, 's3', { reason: 'share-attach' });
  const released = leases.release(7, 's1', { reason: 'session-stop' });
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(released.promotedTo, 's2');
  const status = leases.status(7);
  assert.equal(status.holder, 's2');
  assert.equal(status.epoch, 2);
  assert.equal(status.history.some((item) => item.type === 'handoff' && item.from === 's1' && item.to === 's2'), true);
});

test('holder release 且无参与者：租约删除，ownerOf 为空', () => {
  const { leases } = clocked();
  leases.acquire(3, 's1');
  const released = leases.release(3, 's1', { reason: 'cleanup' });
  assert.equal(released.ok, true);
  assert.equal(released.promotedTo, null);
  assert.equal(leases.status(3), null);
  assert.equal(leases.ownerOf(3), null);
});

test('租约到期：无参与者则 holder 清空，有参与者则晋升；过期幂等', () => {
  const { leases, advance } = clocked();
  leases.acquire(4, 's1', { ttlMs: 1_000 });
  advance(1_500);
  const expired = leases.settle(4);
  assert.equal(expired.holder, null);
  assert.equal(expired.lastEvent.type, 'expire');
  // 幂等：再 settle 不重复写事件。
  const events = leases.status(4).history.length;
  leases.settle(4);
  assert.equal(leases.status(4).history.length, events);

  leases.acquire(5, 'a', { ttlMs: 1_000 });
  leases.join(5, 'b', { reason: 'share-attach' });
  advance(1_500);
  const promoted = leases.settle(5);
  assert.equal(promoted.holder, 'b');
  assert.equal(promoted.history.some((item) => item.type === 'expire' && item.to === 'b'), true);
});

test('holder 失联（isSessionAlive=false）时新会话 takeover，保留证据', () => {
  const alive = new Set(['s1']);
  const { leases } = clocked({ isSessionAlive: (id) => alive.has(id) });
  leases.acquire(8, 's1', { reason: 'session-start' });
  alive.delete('s1');
  const takeover = leases.acquire(8, 's2', { reason: 'rebind' });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.takeover, true);
  assert.equal(takeover.lease.holder, 's2');
  assert.equal(takeover.lease.epoch, 2);
  const event = takeover.lease.history.find((item) => item.type === 'takeover');
  assert.equal(event.from, 's1');
  assert.equal(event.to, 's2');
  // 原 holder 已不在参与者里。
  assert.equal(leases.participants(8).some((item) => item.sessionId === 's1'), false);
});

test('transfer：holder 显式转交；非 holder 转交被拒绝', () => {
  const { leases } = clocked();
  leases.acquire(9, 's1', { reason: 'session-start' });
  leases.join(9, 's2', { reason: 'share-attach' });
  assert.equal(leases.transfer(9, 's1', 's2', { reason: 'handoff' }), true);
  assert.equal(leases.ownerOf(9), 's2');
  assert.equal(leases.status(9).epoch, 2);
  assert.equal(leases.transfer(9, 's1', 's2'), false, '旧 holder 不能再转交');
  assert.equal(leases.transfer(99, 's1', 's2'), false);
});

test('force release 需要显式 by 并留下证据；非参与者普通 release 被拒', () => {
  const { leases } = clocked();
  leases.acquire(10, 's1', { reason: 'session-start' });
  const denied = leases.release(10, 's2', { reason: 'cleanup' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'E_TAB_LEASE_NOT_HELD');
  assert.equal(denied.conflict.holder, 's1');
  const forced = leases.release(10, 's2', { reason: 'operator-unlock', force: true, by: 'admin' });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(forced.evidence.from, 's1');
  assert.equal(forced.evidence.by, 'admin');
  assert.equal(leases.status(10), null);
});

test('conflict() 不抛错：租约空闲时 clear=true，占用时给出结构化证据', () => {
  const { leases } = clocked();
  assert.deepEqual(leases.conflict(30, 's1'), { tabId: 30, holder: null, clear: true, at: 1_000_000 });
  leases.acquire(30, 's1');
  const clearForHolder = leases.conflict(30, 's1');
  assert.equal(clearForHolder.clear, true);
  const busy = leases.conflict(30, 's2', { reason: 'rebind' });
  assert.equal(busy.clear, false);
  assert.equal(busy.holder, 's1');
  assert.equal(busy.requestedBy, 's2');
  assert.equal(Array.isArray(busy.history), true);
});

test('snapshot / history / clear：多 tab 视图与事件历史', () => {
  const { leases } = clocked();
  leases.acquire(41, 's1', { reason: 'session-start' });
  leases.acquire(42, 's2', { reason: 'session-start' });
  leases.join(41, 's3', { reason: 'share-attach' });
  const snapshot = leases.snapshot();
  assert.deepEqual(snapshot.map((item) => item.tabId), [41, 42]);
  assert.equal(snapshot[0].participantCount, 2);
  assert.equal(snapshot[1].holder, 's2');
  const events = leases.history(41);
  assert.equal(events.length >= 2, true);
  assert.equal(events.every((item) => item.tabId === 41), true);
  leases.clear();
  assert.deepEqual(leases.snapshot(), []);
});

test('非法 tabId/sessionId 参数被拒绝；默认 TTL 有上下限', () => {
  const { leases } = clocked();
  assert.throws(() => leases.acquire('x', 's1'), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => leases.acquire(1, ''), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => leases.join(1, null), (error) => error.code === 'E_BAD_ARG');
  const acquired = leases.acquire(1, 's1', { ttlMs: 5 });
  assert.equal(acquired.lease.ttlMs, 1_000, 'TTL 下限 1s');
  const acquired2 = leases.acquire(2, 's2', { ttlMs: 10_000_000 });
  assert.equal(acquired2.lease.ttlMs, 600_000, 'TTL 上限 10min');
  assert.equal(DEFAULT_LEASE_TTL_MS, 60_000);
});
