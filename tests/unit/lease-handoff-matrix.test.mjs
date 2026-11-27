// tests/unit/lease-handoff-matrix.test.mjs —— 多会话租约 handoff/transfer/takeover 场景矩阵：
// 晋升链、epoch 单调、证据类型、强制释放、续租不换代，以及固定种子随机操作下的不变量。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLeases } from '../../lib/session-lease.mjs';
import { createLeaseOps } from '../../daemon/lease-ops.js';
import { buildOwnershipMatrix } from '../../daemon/lease-registry.js';

const NOW = 1_700_000_000_000;

function world({ ttlMs = 60_000 } = {}) {
  let now = NOW;
  const sessions = new Map();
  const leases = createSessionLeases({ now: () => now, defaultTtlMs: ttlMs, isSessionAlive: () => true });
  const ops = createLeaseOps({ leases, sessions, now: () => now, defaultTtlMs: ttlMs, log: () => {} });
  function addSession(sessionId, tabId, overrides = {}) {
    const session = { sessionId, tabId, startedAt: now - 1_000, shared: false, ...overrides };
    sessions.set(sessionId, session);
    return session;
  }
  return {
    ops, leases, sessions, addSession,
    advance: (ms) => { now += ms; },
    clock: () => now,
  };
}

/** 每次操作后都检查的租约不变量（兼容 lib snapshot 的 leaseRemainingMs 字段名）。 */
function assertLeaseInvariants(leases, { tabs = null } = {}) {
  const snapshot = leases.snapshot();
  for (const row of snapshot) {
    if (tabs && !tabs.includes(row.tabId)) continue;
    const remainingMs = row.remainingMs === undefined ? row.leaseRemainingMs : row.remainingMs;
    assert.equal(Number.isInteger(row.tabId), true);
    assert.equal(row.epoch >= 0, true);
    assert.equal(remainingMs <= row.ttlMs, true, '剩余租期不能超过 TTL: ' + JSON.stringify({ tabId: row.tabId, remainingMs, ttlMs: row.ttlMs, expiresAt: row.expiresAt, epoch: row.epoch }));
    const participantIds = row.participants.map((item) => item.sessionId);
    assert.equal(new Set(participantIds).size, participantIds.length, '参与者不能重复');
    if (row.holder) {
      assert.equal(participantIds.includes(row.holder), true, 'holder 必须在参与者里');
      assert.equal(row.participantCount >= 1, true);
    } else {
      assert.equal(remainingMs, 0);
    }
    assert.equal(row.history.length <= 5, true, '视图只暴露最近 5 条历史');
  }
}

// ---------------------------------------------------------------------------
// 晋升链
// ---------------------------------------------------------------------------

test('handoff 链：s1→s2→s3，epoch 每次换代 +1，最终租约删除', () => {
  const w = world();
  w.addSession('s1', 7);
  w.addSession('s2', 7, { shared: true });
  w.addSession('s3', 7, { shared: true });
  w.ops.acquire(7, 's1', { reason: 'session-start' });
  w.ops.join(7, 's2', { reason: 'share-attach' });
  w.ops.join(7, 's3', { reason: 'share-attach' });
  assert.equal(w.leases.status(7).epoch, 1);
  assert.equal(w.leases.participants(7).length, 3);
  const first = w.ops.release(7, 's1', { reason: 'session-stop' });
  assert.equal(first.promotedTo, 's2');
  assert.equal(w.leases.ownerOf(7), 's2');
  assert.equal(w.leases.status(7).epoch, 2);
  assertLeaseInvariants(w.leases);
  const second = w.ops.release(7, 's2', { reason: 'session-stop' });
  assert.equal(second.promotedTo, 's3');
  assert.equal(w.leases.ownerOf(7), 's3');
  assert.equal(w.leases.status(7).epoch, 3);
  const third = w.ops.release(7, 's3', { reason: 'session-stop' });
  assert.equal(third.promotedTo, null);
  assert.equal(w.leases.status(7), null);
  // 证据链：handoff 两次 + release。
  const history = w.ops.evidence({ tabId: 7 });
  assert.equal(history.filter((item) => item.promotedTo).length >= 2, true);
  assertLeaseInvariants(w.leases);
});

test('晋升按接入顺序优先存活：lib 层先按接入序，ops.sweep 再回收失联 holder 并晋升存活者', () => {
  const leases = createSessionLeases({ now: () => NOW, defaultTtlMs: 60_000, isSessionAlive: () => true });
  const sessions = new Map([
    ['s1', { sessionId: 's1', tabId: 1, startedAt: NOW - 3_000 }],
    ['s2', { sessionId: 's2', tabId: 1, startedAt: NOW - 2_000 }],
    ['s3', { sessionId: 's3', tabId: 1, startedAt: NOW - 1_000 }],
  ]);
  const ops = createLeaseOps({ leases, sessions, now: () => NOW, log: () => {} });
  ops.acquire(1, 's1', { reason: 'session-start' });
  ops.join(1, 's2', { reason: 'share-attach' });
  ops.join(1, 's3', { reason: 'share-attach' });
  // s2 失联（从会话集合移除）：lib 的 release 只看接入顺序，会把 holder 给 s2。
  sessions.delete('s2');
  const released = ops.release(1, 's1', { reason: 'session-stop' });
  assert.equal(released.promotedTo, 's2');
  assert.equal(leases.ownerOf(1), 's2');
  // ops 层的 sweep 能识别 s2 失联：回收并晋升存活的 s3。
  const sweep = ops.sweep();
  assert.equal(sweep.applied.released, 1);
  assert.equal(sweep.applied.promoted, 1);
  assert.equal(leases.ownerOf(1), 's3');
  assert.equal(leases.participants(1).some((item) => item.sessionId === 's2'), false, '失联参与者被清理');
  assertLeaseInvariants(leases);
});

// ---------------------------------------------------------------------------
// transfer / force release / takeover
// ---------------------------------------------------------------------------

test('transfer：holder 链式转交，非 holder 转交被拒绝且留冲突证据', () => {
  const w = world();
  w.addSession('s1', 2);
  w.addSession('s2', 2, { shared: true });
  w.addSession('s3', 2, { shared: true });
  w.ops.acquire(2, 's1', { reason: 'session-start' });
  w.ops.join(2, 's2', { reason: 'share-attach' });
  w.ops.join(2, 's3', { reason: 'share-attach' });
  assert.equal(w.ops.transfer(2, 's2', 's3', { reason: 'handoff' }), false, '非 holder 不能转交');
  assert.equal(w.ops.transfer(2, 's1', 's2', { reason: 'handoff' }), true);
  assert.equal(w.leases.ownerOf(2), 's2');
  assert.equal(w.leases.status(2).epoch, 2);
  assert.equal(w.ops.transfer(2, 's2', 's3', { reason: 'handoff' }), true);
  assert.equal(w.leases.ownerOf(2), 's3');
  assert.equal(w.leases.status(2).epoch, 3);
  assert.equal(w.ops.transfer(99, 's1', 's2'), false);
  assert.equal(w.ops.evidence({ type: 'transfer' }).length, 2);
  assert.equal(w.ops.evidence({ type: 'conflict' }).some((item) => item.op === 'transfer'), true);
  assertLeaseInvariants(w.leases);
});

test('force release：必须显式 by；强制后 holder 清空、只摘 holder 不清参与者', () => {
  const w = world();
  w.ops.acquire(3, 's1', { reason: 'session-start' });
  w.ops.join(3, 's2', { reason: 'share-attach' });
  w.addSession('s1', 3);
  // 非参与者、非 holder 的强制回收（例如运维 unlock）。
  const noBy = w.ops.release(3, 'operator', { force: true, reason: 'operator-unlock' });
  assert.equal(noBy.code, 'E_BAD_ARG');
  const forced = w.ops.release(3, 'operator', { force: true, by: 'admin', reason: 'operator-unlock' });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(forced.evidence.from, 's1');
  assert.equal(forced.evidence.by, 'admin');
  // holder 清空、s2 仍是参与者（不会把 s2 一起清掉）。
  assert.equal(w.leases.ownerOf(3), null);
  assert.deepEqual(w.leases.participants(3).map((item) => item.sessionId), ['s2']);
  assertLeaseInvariants(w.leases);
  // 参与者可以重新 acquire 成为 holder。
  const reacquired = w.ops.acquire(3, 's2', { reason: 'rebind' });
  assert.equal(reacquired.ok, true);
  assert.equal(w.leases.ownerOf(3), 's2');
});

test('崩溃 takeover：回收后新会话 acquire，epoch 递增且证据保留', () => {
  const w = world();
  w.ops.acquire(4, 'ghost', { reason: 'session-start' });
  w.addSession('new', 4);
  assert.equal(w.leases.ownerOf(4), 'ghost');
  const sweep = w.ops.sweep();
  assert.equal(sweep.applied.released, 1);
  assert.equal(w.leases.status(4), null);
  const acquired = w.ops.acquire(4, 'new', { reason: 'session-start' });
  assert.equal(acquired.ok, true);
  assert.equal(w.leases.ownerOf(4), 'new');
  // 新租约 epoch 从 1 重新开始（旧条目已删除），但 reap 证据在 ops 环里。
  assert.equal(acquired.lease.epoch, 1);
  assert.equal(w.ops.evidence({ type: 'reap' }).length >= 1, true);
  assertLeaseInvariants(w.leases);
});

// ---------------------------------------------------------------------------
// 续租稳定性
// ---------------------------------------------------------------------------

test('续租不换代：多轮 touch/renew 后 epoch 与 holder 不变，TTL 剩余重置', () => {
  const w = world();
  w.addSession('s1', 5);
  w.ops.acquire(5, 's1', { reason: 'session-start' });
  const epoch = w.leases.status(5).epoch;
  const acquiredAt = w.leases.status(5).acquiredAt;
  for (let round = 0; round < 8; round += 1) {
    w.advance(20_000);
    const result = w.ops.touch(5, 's1', { reason: 'command' });
    assert.equal(result.ok, true);
    assert.equal(w.leases.status(5).epoch, epoch, 'touch 永不换代');
  }
  assert.equal(w.leases.ownerOf(5), 's1');
  assert.equal(w.leases.status(5).acquiredAt, acquiredAt, 'acquiredAt 不因续租变化');
  assert.equal(w.leases.status(5).leaseRemainingMs > 30_000, true);
  const renew = w.ops.renew(5, 's1', { reason: 'renew' });
  assert.equal(renew.ok, true);
  assert.equal(w.leases.status(5).epoch, epoch);
  assertLeaseInvariants(w.leases);
});

// ---------------------------------------------------------------------------
// 固定种子随机操作：不变量与证据一致性
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('固定种子随机操作 120 步：不抛错、不变量成立、报告可序列化', () => {
  const random = mulberry32(20261126);
  const w = world();
  w.addSession('s1', 10);
  w.addSession('s2', 10, { shared: true });
  w.addSession('s3', 10, { shared: true });
  w.addSession('s4', 11);
  let operations = 0;
  for (let step = 0; step < 120; step += 1) {
    const tabId = random() < 0.8 ? 10 : 11;
    const sessionId = ['s1', 's2', 's3'][Math.floor(random() * 3)];
    const action = random();
    if (action < 0.28) {
      w.ops.acquire(tabId, sessionId, { reason: 'session-start' });
    } else if (action < 0.5) {
      w.ops.join(tabId, sessionId, { reason: 'share-attach' });
    } else if (action < 0.66) {
      w.ops.renew(tabId, sessionId, { reason: 'renew' });
    } else if (action < 0.78) {
      w.ops.touch(tabId, sessionId, { reason: 'command' });
    } else if (action < 0.9) {
      w.ops.release(tabId, sessionId, { reason: 'session-stop' });
    } else if (action < 0.96) {
      w.ops.transfer(tabId, sessionId, ['s1', 's2', 's3'][Math.floor(random() * 3)], { reason: 'handoff' });
    } else {
      w.advance(10_000);
      w.ops.sweep({ dryRun: true });
    }
    operations += 1;
    assertLeaseInvariants(w.leases);
  }
  assert.equal(operations, 120);
  const report = w.ops.report({ limit: 10 });
  assert.equal(report.kind, 'bridge/tab-ownership');
  assert.equal(typeof JSON.stringify(report), 'string');
  assert.equal(report.counters.acquire + report.counters.join >= 1, true);
  const matrix = buildOwnershipMatrix({
    leases: w.leases.snapshot(),
    sessions: [...w.sessions.values()],
    now: w.clock(),
    isAlive: () => true,
  });
  assert.equal(matrix.totals.tabs >= 1, true);
  assert.equal(matrix.conflicts.every((item) => typeof item.code === 'string'), true);
});

test('重复 release 幂等：同一 holder 连发 3 次不抛错，最多一次晋升', () => {
  const w = world();
  w.ops.acquire(20, 's1', { reason: 'session-start' });
  w.ops.join(20, 's2', { reason: 'share-attach' });
  const first = w.ops.release(20, 's1', { reason: 'session-stop' });
  const second = w.ops.release(20, 's1', { reason: 'session-stop' });
  const third = w.ops.release(20, 's1', { reason: 'session-stop' });
  assert.equal(first.promotedTo, 's2');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E_TAB_LEASE_NOT_HELD');
  assert.equal(third.ok, false);
  assert.equal(w.leases.ownerOf(20), 's2');
  assert.equal(w.leases.status(20).epoch, 2, '重复 release 不会多次换代');
  assertLeaseInvariants(w.leases);
});
