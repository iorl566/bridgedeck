// tests/unit/lease-sweep.test.mjs —— 租约过期回收（sweep）的边界矩阵与失败降级：
// 动作顺序、force-clear、dryRun、定时器、批量续租失败、证据环裁剪、异常不冒泡。
//
// 这里用脚本化的 fake lease 实例（只实现 lease-ops 消费到的方法），精确控制
// settle/释放的结果，覆盖 lib/session-lease 不容易构造的路径（无 holder 残留、release 抛错等）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaseOps } from '../../daemon/lease-ops.js';

const NOW = 1_700_000_000_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 脚本化 fake lease：
 * - tabs: Map<tabId, {holder, participants:[], expiresAt, ttlMs, epoch, history}>
 * - release(tabId, sessionId, opts) 按动作顺序记录调用，可注入抛错；
 * - status/snapshot 不做 settle（保持 fixture 原样，便于覆盖 reclaim 判定）。
 */
function fakeLease({ tabs = [], throwOnRelease = null } = {}) {
  const table = new Map();
  for (const tab of tabs) table.set(Number(tab.tabId), { history: [], epoch: 1, ttlMs: 60_000, ...tab });
  const calls = [];
  const lease = {
    calls,
    table,
    acquire(tabId, sessionId) {
      table.set(Number(tabId), { holder: sessionId, participants: [sessionId], expiresAt: NOW + 60_000, ttlMs: 60_000, epoch: 1, history: [] });
      return { ok: true, acquired: true, lease: { holder: sessionId, epoch: 1 } };
    },
    join(tabId, sessionId) {
      const entry = table.get(Number(tabId));
      if (!entry.participants.includes(sessionId)) entry.participants.push(sessionId);
      return { ok: true, joined: true, shared: true, holder: entry.holder, lease: { holder: entry.holder, epoch: entry.epoch } };
    },
    renew(tabId, sessionId) {
      const entry = table.get(Number(tabId));
      if (!entry || entry.holder !== sessionId) return { ok: false, code: 'E_TAB_LEASE_NOT_HELD', conflict: { tabId: Number(tabId), holder: entry ? entry.holder : null, requestedBy: sessionId } };
      entry.expiresAt = NOW + 60_000;
      return { ok: true, renewed: true, lease: { holder: sessionId, epoch: entry.epoch, leaseRemainingMs: 60_000 } };
    },
    transfer() { return false; },
    ownerOf(tabId) {
      const entry = table.get(Number(tabId));
      return entry ? entry.holder : null;
    },
    participants(tabId) {
      const entry = table.get(Number(tabId));
      return entry ? entry.participants.map((sessionId) => ({ sessionId })) : [];
    },
    status(tabId) {
      const entry = table.get(Number(tabId));
      if (!entry) return null;
      return {
        tabId: Number(tabId),
        holder: entry.holder,
        epoch: entry.epoch,
        ttlMs: entry.ttlMs,
        expiresAt: entry.expiresAt,
        leaseRemainingMs: Math.max(0, entry.expiresAt - NOW),
        participantCount: entry.participants.length,
        participants: entry.participants.map((sessionId) => ({ sessionId, role: sessionId === entry.holder ? 'holder' : 'participant' })),
        history: entry.history,
      };
    },
    snapshot() {
      return [...table.keys()].map((tabId) => lease.status(tabId)).filter(Boolean);
    },
    history(tabId) {
      const entry = table.get(Number(tabId));
      return entry ? entry.history.slice() : [];
    },
    conflict() { return { clear: true }; },
    clear() { table.clear(); },
    release(tabId, sessionId, options = {}) {
      calls.push({ tabId: Number(tabId), sessionId, options });
      if (typeof throwOnRelease === 'function') throwOnRelease(tabId, sessionId, options);
      const entry = table.get(Number(tabId));
      if (!entry) return { ok: true, released: false, removed: false, reason: 'no-lease' };
      if (options.force === true && options.by) {
        const from = entry.holder;
        entry.holder = null;
        entry.participants = entry.participants.filter((item) => item !== from);
        entry.epoch += 1;
        if (!entry.participants.length) table.delete(Number(tabId));
        return { ok: true, released: true, removed: true, forced: true, evidence: { from, by: options.by } };
      }
      if (entry.holder === sessionId) {
        entry.participants = entry.participants.filter((item) => item !== sessionId);
        const promoted = entry.participants.find((item) => item !== sessionId) || null;
        if (promoted) {
          entry.holder = promoted;
          entry.epoch += 1;
          return { ok: true, released: true, promotedTo: promoted, lease: lease.status(tabId) };
        }
        entry.holder = null;
        if (!entry.participants.length) table.delete(Number(tabId));
        return { ok: true, released: true, promotedTo: null };
      }
      if (entry.participants.includes(sessionId)) {
        entry.participants = entry.participants.filter((item) => item !== sessionId);
        return { ok: true, released: false, removed: true, holder: entry.holder };
      }
      return { ok: false, code: 'E_TAB_LEASE_NOT_HELD', conflict: { tabId: Number(tabId), holder: entry.holder, requestedBy: sessionId } };
    },
  };
  return lease;
}

function opsFor(lease, sessions = [], options = {}) {
  const sessionMap = new Map();
  for (const session of sessions) sessionMap.set(session.sessionId, session);
  return createLeaseOps({
    leases: lease,
    sessions: sessionMap,
    now: () => NOW,
    defaultTtlMs: 60_000,
    log: () => {},
    recordTouches: false,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// 动作顺序与 force-clear
// ---------------------------------------------------------------------------

test('sweep：失联 participant 先摘、再释放 holder；动作顺序与 promotedTo 进证据', () => {
  const lease = fakeLease({
    tabs: [{
      tabId: 9,
      holder: 'dead-holder',
      participants: ['dead-holder', 'dead-2', 'alive'],
      expiresAt: NOW + 10_000,
    }],
  });
  const ops = opsFor(lease, [{ sessionId: 'alive', tabId: 9, startedAt: NOW - 1_000 }]);
  const result = ops.sweep();
  assert.equal(result.plan.reclaim.length, 1);
  assert.deepEqual(
    result.applied.details.map((detail) => detail.action),
    ['detach-participant', 'release-holder'],
  );
  assert.equal(result.applied.detached, 1);
  assert.equal(result.applied.released, 1);
  assert.equal(result.applied.promoted, 1);
  assert.equal(result.applied.errors, 0);
  const holderRelease = result.applied.details.find((detail) => detail.action === 'release-holder');
  assert.equal(holderRelease.promotedTo, 'alive');
  assert.equal(lease.table.get(9).holder, 'alive');
  const reap = ops.evidence({ type: 'reap' });
  assert.equal(reap.length, 1);
  assert.equal(reap[0].tabId, 9);
  assert.equal(reap[0].holder, 'dead-holder');
  assert.equal(reap[0].promotedTo, 'alive');
});

test('sweep：holder 为 null 且参与者全失联 → force-clear（by=lease-sweeper）', () => {
  const lease = fakeLease({
    tabs: [{ tabId: 15, holder: null, participants: ['dead-a', 'dead-b'], expiresAt: 0 }],
  });
  const ops = opsFor(lease);
  const result = ops.sweep();
  assert.equal(result.applied.detached, 2);
  assert.equal(result.applied.cleared, 1);
  assert.equal(lease.table.has(15), false);
  const forceCall = lease.calls.find((call) => call.options.force === true);
  assert.equal(forceCall.options.by, 'lease-sweeper');
  assert.equal(forceCall.sessionId, 'lease-sweeper');
});

test('sweep dryRun：计划完整、零副作用、lease release 零调用', () => {
  const lease = fakeLease({
    tabs: [{ tabId: 21, holder: 'ghost', participants: ['ghost'], expiresAt: NOW + 30_000 }],
  });
  const ops = opsFor(lease);
  const result = ops.sweep({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.reclaim.length, 1);
  assert.equal(result.applied.released, 0);
  assert.equal(lease.calls.length, 0);
  assert.equal(lease.table.get(21).holder, 'ghost');
  assert.equal(result.remaining, 1);
});

test('sweep：多个 tab 独立处理，存活 holder 的 tab 不产生 release', () => {
  const lease = fakeLease({
    tabs: [
      { tabId: 30, holder: 'ghost', participants: ['ghost'], expiresAt: NOW + 10_000 },
      { tabId: 31, holder: 'alive', participants: ['alive'], expiresAt: NOW + 10_000 },
      { tabId: 32, holder: 'ghost2', participants: ['ghost2'], expiresAt: NOW - 1 },
    ],
  });
  const ops = opsFor(lease, [{ sessionId: 'alive', tabId: 31, startedAt: NOW - 1_000 }]);
  const result = ops.sweep();
  assert.deepEqual(result.plan.reclaim.map((item) => item.tabId), [30, 32]);
  assert.equal(result.applied.released, 2);
  assert.equal(lease.calls.every((call) => [30, 32].includes(call.tabId)), true);
  assert.equal(lease.table.get(31).holder, 'alive');
});

test('sweep：release 抛错 → 计入 errors 并写 error 证据，不冒泡、继续处理后续 tab', () => {
  const lease = fakeLease({
    tabs: [
      { tabId: 40, holder: 'ghost-a', participants: ['ghost-a'], expiresAt: NOW + 10_000 },
      { tabId: 41, holder: 'ghost-b', participants: ['ghost-b'], expiresAt: NOW + 10_000 },
    ],
    throwOnRelease: (tabId) => {
      if (tabId === 40) throw Object.assign(new Error('release boom'), { code: 'E_INTERNAL' });
    },
  });
  const ops = opsFor(lease);
  const result = ops.sweep();
  assert.equal(result.applied.errors, 1);
  assert.equal(result.applied.released, 1);
  assert.equal(lease.table.get(40).holder, 'ghost-a', '抛错的 tab 保持原状');
  assert.equal(lease.table.has(41), false, '后续 tab 继续回收');
  const errors = ops.evidence({ type: 'error' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].tabId, 40);
  assert.equal(errors[0].message, 'release boom');
});

// ---------------------------------------------------------------------------
// 批量续租
// ---------------------------------------------------------------------------

test('renewDue：个别续租失败只记 failed，不影响其它 tab', () => {
  const lease = fakeLease({
    tabs: [
      { tabId: 50, holder: 's1', participants: ['s1'], expiresAt: NOW + 2_000 },
      { tabId: 51, holder: 'ghost', participants: ['ghost'], expiresAt: NOW + 2_000 },
    ],
  });
  const ops = opsFor(lease, [{ sessionId: 's1', tabId: 50, startedAt: NOW - 1 }]);
  const result = ops.renewDue({ withinMs: 10_000 });
  assert.equal(result.applied.renewed, 1);
  assert.equal(result.applied.failed, 0);
  assert.equal(result.applied.details.find((detail) => detail.tabId === 50).ok, true);
  assert.equal(result.due.some((item) => item.tabId === 51), false, '失联 holder 不进入续租候选');
  assert.equal(lease.table.get(50).expiresAt > NOW + 30_000, true);
});

test('renewDue dryRun：不修改任何租约的 expiresAt', () => {
  const lease = fakeLease({ tabs: [{ tabId: 55, holder: 's1', participants: ['s1'], expiresAt: NOW + 1_000 }] });
  const ops = opsFor(lease, [{ sessionId: 's1', tabId: 55, startedAt: NOW - 1 }]);
  const before = lease.table.get(55).expiresAt;
  const result = ops.renewDue({ withinMs: 10_000, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.due.length, 1);
  assert.equal(lease.table.get(55).expiresAt, before);
  assert.equal(result.applied.renewed, 0);
});

// ---------------------------------------------------------------------------
// 定时器 / 证据环
// ---------------------------------------------------------------------------

test('startSweeper：按 interval 触发 sweep（unref 不阻塞测试进程），stop 后不再触发', async () => {
  const lease = fakeLease({ tabs: [] });
  const ops = opsFor(lease, [], { sweepIntervalMs: 250 });
  const started = ops.startSweeper({ intervalMs: 250 });
  assert.equal(started.running, true);
  assert.equal(started.intervalMs, 250);
  let ticks = 0;
  for (let index = 0; index < 80; index += 1) {
    await sleep(50);
    ticks = ops.stats().sweeper.ticks;
    if (ticks >= 1) break;
  }
  assert.equal(ticks >= 1, true, '定时器应在 1s 内至少触发一次');
  ops.stopSweeper();
  const afterStop = ops.stats().sweeper.ticks;
  await sleep(300);
  assert.equal(ops.stats().sweeper.ticks, afterStop, 'stop 后不再 tick');
});

test('定时回收异常：sweeper.lastError 记录并继续存活', async () => {
  const lease = fakeLease({ tabs: [] });
  // 用会抛错的 sessions.values() 让 sweep 顶层异常，验证定时器捕获而不是让进程崩溃。
  const evilSessions = new Map();
  evilSessions.values = () => { throw Object.assign(new Error('sessions boom'), { code: 'E_INTERNAL' }); };
  const ops = createLeaseOps({
    leases: lease,
    sessions: evilSessions,
    now: () => NOW,
    log: () => {},
    sweepIntervalMs: 250,
  });
  ops.startSweeper({ intervalMs: 250 });
  let lastError = null;
  for (let index = 0; index < 120; index += 1) {
    await sleep(50);
    lastError = ops.stats().sweeper.lastError;
    if (lastError) break;
  }
  ops.stopSweeper();
  assert.ok(lastError, '应记录定时回收异常');
  assert.match(lastError.message, /sessions boom/);
  // 停止后仍可正常取报告（sweep 不再被定时触发）。
  assert.equal(ops.stats().sweeper.running, false);
});

test('证据环：容量裁剪后最旧事件被丢弃，report 只带最近证据', () => {
  const lease = fakeLease({ tabs: [] });
  const ops = opsFor(lease, [], { evidenceLimit: 3 });
  ops.acquire(1, 's1');
  ops.acquire(2, 's1');
  ops.acquire(3, 's1');
  ops.acquire(4, 's1');
  const all = ops.evidence({ limit: 100 });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((item) => item.tabId), [2, 3, 4]);
  const report = ops.report({ limit: 2 });
  assert.equal(report.evidence.length <= 4, true);
  assert.equal(report.counters.evidenceSize, 3);
});
