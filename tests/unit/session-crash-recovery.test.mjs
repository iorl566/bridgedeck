// tests/unit/session-crash-recovery.test.mjs —— 崩溃恢复端到端（纯组合层）：
// 持久化会话分类 → 状态机 recovering → tab 租约重建 → 租约对账/恢复报告 → 人工 resolve 后才解锁。
import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentLedger, createMemoryLedgerStorage } from '../../lib/intent-ledger.mjs';
import { createSessionState } from '../../lib/session-state.mjs';
import { createSessionLeases } from '../../lib/session-lease.mjs';
import {
  SESSION_RECOVERY_TTL_MS,
  createSessionRecovery,
  planPersistedSessionRecovery,
  recoverLedgerOnStartup,
} from '../../daemon/session-recovery.js';
import { createLeaseOps } from '../../daemon/lease-ops.js';
import { createRecoveryReporter } from '../../daemon/recovery-report.js';

const NOW = 1_700_000_000_000;

function makeWorld({ rows = [], crashEntries = [] } = {}) {
  let now = NOW;
  const sessions = new Map();
  const state = createSessionState({ now: () => now });
  const leases = createSessionLeases({ now: () => now, defaultTtlMs: 60_000, isSessionAlive: () => true });
  const leaseOps = createLeaseOps({ leases, sessions, sessionState: state, now: () => now, log: () => {} });
  const recovery = createSessionRecovery({ sessions, sessionState: state, sessionLeases: leases, log: () => {}, now: () => now });
  const plan = planPersistedSessionRecovery(rows, { now });
  recovery.recordSessionPlan(plan);
  for (const item of plan.restore) sessions.set(item.sessionId, item.record);
  recovery.applySessionPlan(plan);
  // 账本崩溃：写 WAL → 新账本读回并 recover（pending→unknown，非幂等 replayBlocked）。
  let ledger = null;
  if (crashEntries.length) {
    const storage = createMemoryLedgerStorage();
    const before = new IntentLedger({ storage, fsync: false, now: () => now });
    for (const entry of crashEntries) before.begin(entry.method, {}, { tabId: entry.tabId, sessionId: entry.sessionId });
    ledger = new IntentLedger({ storage, fsync: false, now: () => now });
    const summary = recoverLedgerOnStartup(ledger, { reason: 'test-crash' });
    recovery.recordLedger(summary);
  }
  const reporter = ledger
    ? createRecoveryReporter({ ledger, recovery, recoverySnapshot: () => recovery.snapshot(), leaseOps, sessions, now: () => now, log: () => {} })
    : null;
  return {
    sessions, state, leases, leaseOps, recovery, plan, ledger, reporter,
    advance: (ms) => { now += ms; },
    finishRecovery() {
      const reconcile = leaseOps.reconcile({ apply: false });
      recovery.recordLeaseReconcile(reconcile.plan);
      if (reporter) recovery.recordRecoveryReport(reporter.report());
      return reconcile.plan;
    },
  };
}

function persistedRow(sessionId, tabId, ageMs = 5_000, overrides = {}) {
  return { sessionId, instanceId: 'i1', tabId, windowId: 0, url: '', title: '', startedAt: NOW - ageMs, ...overrides };
}

test('崩溃序列：会话恢复 + 同 tab 租约重建（最老为 holder）+ 恢复报告挂到 recovery 快照', () => {
  const world = makeWorld({
    rows: [
      persistedRow('s-new', 7, 1_000),
      persistedRow('s-old', 7, 9_000),
      persistedRow('s-other', 8, 5_000),
      persistedRow('s-dead', 9, SESSION_RECOVERY_TTL_MS + 1),
    ],
    crashEntries: [{ method: 'click', tabId: 7, sessionId: 's-old' }],
  });
  assert.equal(world.plan.restore.length, 3);
  assert.equal(world.plan.expired.length, 1);
  assert.equal(world.sessions.size, 3);
  assert.equal(world.state.phase('s-old'), 'recovering');
  assert.equal(world.leases.ownerOf(7), 's-old');
  assert.deepEqual(world.leases.participants(7).map((item) => item.sessionId).sort(), ['s-new', 's-old']);
  assert.equal(world.leases.ownerOf(8), 's-other');
  const reconcile = world.finishRecovery();
  assert.equal(reconcile.stats.conflicts, 0);
  const snapshot = world.recovery.snapshot();
  assert.equal(snapshot.sessions.live, 3);
  assert.equal(snapshot.sessions.plan.restore, 3);
  assert.equal(snapshot.leases.length, 2);
  assert.ok(snapshot.leaseReconcile, 'snapshot 应带租约对账证据');
  assert.equal(snapshot.leaseReconcile.stats.leases, 2);
  assert.ok(snapshot.report, 'snapshot 应带恢复报告摘要');
  assert.equal(snapshot.report.autoResolved, 0);
  assert.equal(snapshot.report.manualRequired, 1);
  assert.equal(snapshot.report.explicitOnly, 1);
  assert.deepEqual(Object.keys(snapshot.report).includes('policy'), false);
  const report = world.recovery.recoveryReport();
  assert.equal(report.ledger.recovered, 1);
  assert.equal(report.report.explicitOnly, 1);
  assert.equal(report.leaseReconcile.stats.leases >= 1, true);
});

test('崩溃恢复不自动 resolve：unknown 保持阻断，人工 confirmed 后才解锁', () => {
  const world = makeWorld({
    rows: [persistedRow('s1', 7)],
    crashEntries: [
      { method: 'click', tabId: 7, sessionId: 's1' },
      { method: 'navigate', tabId: 8, sessionId: 's1' },
    ],
  });
  world.finishRecovery();
  const pending = world.ledger.status({}).pending;
  assert.equal(pending.length, 2);
  assert.equal(pending.every((entry) => entry.state === 'unknown'), true);
  assert.equal(pending.every((entry) => entry.recovered === true), true);
  assert.equal(pending.every((entry) => entry.replayBlocked === true), true);
  // 恢复报告要求人工；autoResolved 保持 0。
  const report = world.reporter.report();
  assert.equal(report.summary.autoResolved, 0);
  assert.equal(report.manualResolve.required.length, 2);
  // 旧结论（abandoned）不能解锁。
  const ids = pending.map((entry) => entry.id);
  const blocked = world.reporter.manualResolve({ ids, outcome: 'abandoned', dryRun: true });
  assert.equal(blocked.counts.protected, 2);
  assert.equal(world.ledger.status({}).pending.length, 2);
  // confirmed 二选一后解锁。
  const applied = world.reporter.manualResolve({ ids, outcome: 'confirmed', by: 'human' });
  assert.equal(applied.counts.resolved, 2);
  assert.equal(world.ledger.status({}).pending.length, 0);
  // 报告刷新后不再要求人工。
  const after = world.reporter.report();
  assert.equal(after.summary.manualRequired, 0);
  assert.equal(after.recommendations[0].code, 'clean');
});

test('持久化会话坏行/重复行：恢复计划给证据，不阻塞其余会话', () => {
  const world = makeWorld({
    rows: [
      persistedRow('s1', 7),
      persistedRow('s1', 7), // 重复
      persistedRow('s2', 'x'), // 坏 tabId
      { sessionId: 's3', tabId: 8, startedAt: 0 }, // 缺 startedAt
      persistedRow('s4', 8),
    ],
  });
  assert.equal(world.plan.restore.length, 2);
  assert.equal(world.plan.duplicates.length, 1);
  assert.equal(world.plan.invalid.length, 2);
  assert.equal(world.sessions.size, 2);
  assert.equal(world.leases.ownerOf(7), 's1');
  assert.equal(world.leases.ownerOf(8), 's4');
  const snapshot = world.recovery.snapshot();
  assert.equal(snapshot.sessions.plan.invalid, 2);
  assert.equal(snapshot.sessions.plan.duplicates, 1);
});

test('恢复后租约对账：会话缺租约只报告不抢占（apply=false），apply 时才补登', () => {
  const world = makeWorld({ rows: [persistedRow('s1', 7)] });
  // 模拟"租约重建漏了"：清掉租约后再对账。
  world.leases.clear();
  world.sessions.set('s2', persistedRow('s2', 7, 2_000));
  world.state.recover('s2');
  const reconcile = world.leaseOps.reconcile({ apply: false });
  assert.equal(reconcile.plan.adopt.length, 2);
  assert.equal(world.leases.ownerOf(7), null, '默认不自动补登');
  world.recovery.recordLeaseReconcile(reconcile.plan);
  assert.equal(world.recovery.snapshot().leaseReconcile.stats.adopt, 2);
  const applied = world.leaseOps.reconcile({ apply: true });
  assert.equal(applied.applied.adopted + applied.applied.joined, 2);
  assert.equal(world.leases.ownerOf(7), 's1', '最老会话（s1）先 acquire 成为 holder');
  assert.equal(world.leases.participants(7).length, 2);
});

test('恢复报告：租约残租/冲突进入报告建议，但不触发任何自动回收', () => {
  const world = makeWorld({ rows: [persistedRow('s1', 7), persistedRow('s2', 8)] });
  // 制造一个崩溃残留：tab 9 的租约 holder 不在会话集合里。
  world.leases.acquire(9, 'ghost', { reason: 'session-start' });
  world.leases.acquire(8, 's2', { reason: 'session-start' });
  world.leases.release(8, 's2', { reason: 'cleanup' });
  world.sessions.get('s1').tabId = 8; // s1 登记在 8 但没有租约 → 冲突
  const reconcile = world.leaseOps.reconcile({ apply: false });
  world.recovery.recordLeaseReconcile(reconcile.plan);
  assert.equal(reconcile.plan.stats.releaseOrphans, 1);
  assert.equal(world.leases.ownerOf(9), 'ghost', '对账只出计划，不自动回收');
  const snapshot = world.recovery.snapshot();
  assert.equal(snapshot.leaseReconcile.releaseOrphans.length, 1);
  assert.equal(snapshot.leaseReconcile.releaseOrphans[0].holder, 'ghost');
  // sweep 显式执行才回收。
  const sweep = world.leaseOps.sweep();
  assert.equal(sweep.applied.released, 1);
  assert.equal(world.leases.ownerOf(9), null);
});

test('recoverLedgerOnStartup + createSessionRecovery：降级不抛错，快照仍可用', () => {
  const state = createSessionState({ now: () => NOW });
  const recovery = createSessionRecovery({ sessions: new Map(), sessionState: state, log: () => {}, now: () => NOW });
  const degraded = recoverLedgerOnStartup(null);
  recovery.recordLedger(degraded);
  const snapshot = recovery.snapshot();
  assert.equal(snapshot.ledger.ok, false);
  assert.equal(snapshot.leases.length, 0);
  assert.equal(snapshot.leaseReconcile, null);
  assert.equal(snapshot.report, null);
  // recordRecoveryReport(null) 清空摘要，不抛错。
  assert.equal(recovery.recordRecoveryReport(null), null);
  assert.equal(recovery.recoveryReport().report, null);
});
