// tests/unit/session-recovery-report.test.mjs —— 崩溃恢复报告与人工 resolve 语义：
// pending/unknown 分类、恢复报告（autoResolved=0）、计划/执行两段式、非幂等强制显式结论。
import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentLedger, createMemoryLedgerStorage } from '../../lib/intent-ledger.mjs';
import {
  RECOVERY_MANUAL_POLICY,
  RECOVERY_REPORT_KIND,
  RECOVERY_REPORT_SCHEMA,
  applyManualResolve,
  buildRecoveryReport,
  classifyPendingEntry,
  classifyRecoveryEntries,
  createRecoveryReporter,
  describeManualResolution,
  isExplicitRecoveryOutcome,
  normalizeRecoveryOutcome,
  planManualResolve,
  summarizeRecoveryReport,
} from '../../daemon/recovery-report.js';

const NOW = 1_700_000_000_000;

function pendingEntry(overrides = {}) {
  return {
    id: 'lt_1',
    at: new Date(NOW - 5_000).toISOString(),
    method: 'click',
    tabId: 7,
    sessionId: 's1',
    state: 'unknown',
    recovered: true,
    nonIdempotent: true,
    replayBlocked: true,
    keys: [],
    target: { ref: '@e1' },
    ...overrides,
  };
}

/** 用内存存储模拟"崩溃 → 重启"：第一个 ledger 写 WAL，第二个 ledger 读同一 WAL 后 recover。 */
function crashedLedger(entries = [{ method: 'click', tabId: 7, sessionId: 's1' }], { recover = true } = {}) {
  const storage = createMemoryLedgerStorage();
  const first = new IntentLedger({ storage, fsync: false, now: () => NOW });
  for (const entry of entries) first.begin(entry.method, {}, { tabId: entry.tabId, sessionId: entry.sessionId });
  const second = new IntentLedger({ storage, fsync: false, now: () => NOW });
  if (recover) second.recover({ legacyState: 'unknown', reason: 'test-crash' });
  return second;
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

test('classifyPendingEntry：崩溃恢复的非幂等未知 → 必须人工二选一', () => {
  const entry = classifyPendingEntry(pendingEntry(), { now: NOW });
  assert.equal(entry.class, 'manual-required');
  assert.equal(entry.manualRequired, true);
  assert.equal(entry.autoResolvable, false);
  assert.equal(entry.explicitOnly, true);
  assert.deepEqual(entry.requiredOutcomes, ['confirmed', 'not-applied']);
  assert.deepEqual(entry.allowedOutcomes, ['confirmed', 'not-applied']);
  assert.equal(entry.recommendation, 'ask-human-confirmed-or-not-applied');
  assert.equal(entry.ageMs, 5_000);
  assert.equal(entry.tabId, 7);
  assert.equal(entry.replayBlocked, true);
  // 非恢复的 unknown（普通超时）→ 可人工/批量 resolve。
  const legacy = classifyPendingEntry(pendingEntry({ recovered: false, replayBlocked: false }), { now: NOW });
  assert.equal(legacy.explicitOnly, false);
  assert.equal(legacy.class, 'reconcile-eligible');
  assert.equal(legacy.manualRequired, true);
  assert.equal(legacy.requiredOutcomes.includes('reconciled'), true);
  // active：仍在执行，不能 resolve。
  const active = classifyPendingEntry(pendingEntry({ state: 'active', recovered: false, replayBlocked: false }), { now: NOW });
  assert.equal(active.class, 'still-active');
  assert.equal(active.manualRequired, false);
  assert.equal(active.recommendation, 'wait-for-completion');
  // stale：未知/过期。
  const stale = classifyPendingEntry(pendingEntry({ state: 'stale', recovered: false }), { now: NOW });
  assert.equal(stale.class, 'reconcile-eligible');
  // 非对象容错。
  const invalid = classifyPendingEntry(null);
  assert.equal(invalid.class, 'settled');
  assert.equal(invalid.manualRequired, false);
});

test('classifyRecoveryEntries：按 tab/method 聚合、截断标记、计数自洽', () => {
  const entries = [
    pendingEntry({ id: 'lt_a', tabId: 7, method: 'click' }),
    pendingEntry({ id: 'lt_b', tabId: 7, method: 'navigate', recovered: false, replayBlocked: false }),
    pendingEntry({ id: 'lt_c', tabId: 8, method: 'click', state: 'active', recovered: false, replayBlocked: false }),
    pendingEntry({ id: 'lt_d', tabId: null, method: 'fill', recovered: false, replayBlocked: false }),
  ];
  const classified = classifyRecoveryEntries(entries, { now: NOW });
  assert.equal(classified.counts.total, 4);
  assert.equal(classified.counts.explicitOnly, 1);
  assert.equal(classified.counts.stillActive, 1);
  assert.equal(classified.counts.reconcileEligible, 2);
  assert.equal(classified.counts.manualRequired, 3);
  assert.equal(classified.counts.replayBlocked, 1);
  assert.equal(classified.byTab.find((tab) => tab.tabId === 7).entries, 2);
  assert.equal(classified.byTab.find((tab) => tab.tabId === 7).manualRequired, 2);
  assert.equal(classified.byTab.find((tab) => tab.tabId === null).entries, 1);
  assert.equal(classified.byMethod.find((item) => item.method === 'click').entries, 2);
  assert.equal(classified.byMethod.find((item) => item.method === 'click').explicitOnly, 1);
  const truncated = classifyRecoveryEntries(entries, { now: NOW, maxEntries: 2 });
  assert.equal(truncated.counts.listed, 2);
  assert.equal(truncated.counts.truncated, true);
  assert.equal(classifyRecoveryEntries(null).counts.total, 0);
});

// ---------------------------------------------------------------------------
// 恢复报告
// ---------------------------------------------------------------------------

test('buildRecoveryReport：账本/会话/租约/人工策略合成，autoResolved 恒为 0', () => {
  const ledgerStatus = {
    staleMs: 15_000,
    pending: [
      pendingEntry({ id: 'lt_x', tabId: 7, method: 'click' }),
      pendingEntry({ id: 'lt_y', tabId: 7, method: 'navigate', recovered: false, replayBlocked: false }),
    ],
    wal: { parsed: 2 },
    durability: { fsync: true },
  };
  const sessionPlan = { stats: { total: 4, restore: 2, expired: 1, invalid: 1, duplicates: 0 } };
  const leaseReport = {
    totals: { tabs: 1, conflicts: 1 },
    orphans: [{ tabId: 7, holder: 'ghost' }],
    reclaim: { stats: { reclaim: 1 } },
    conflicts: [
      { code: 'lease-holder-missing', severity: 'high' },
      { code: 'session-without-lease', severity: 'info' },
    ],
  };
  const report = buildRecoveryReport({
    ledgerStatus,
    recovery: { recovered: 2 },
    sessionPlan,
    leaseReport,
    now: NOW,
  });
  assert.equal(report.schema, RECOVERY_REPORT_SCHEMA);
  assert.equal(report.kind, RECOVERY_REPORT_KIND);
  assert.equal(report.summary.autoResolved, 0);
  assert.equal(report.summary.policy, 'never-auto-resolve');
  assert.equal(report.summary.explicitOnly, 1);
  assert.equal(report.summary.manualRequired, 2);
  assert.equal(report.ledger.pending, 2);
  assert.equal(report.sessions.plan.restore, 2);
  assert.equal(report.leases.conflicts.high, 1);
  assert.equal(report.leases.orphans, 1);
  assert.equal(report.manualResolve.policy.autoResolve, false);
  assert.equal(report.manualResolve.required.length, 1);
  assert.equal(report.manualResolve.candidates.length, 1);
  assert.equal(report.tabs.length, 1);
  assert.equal(report.methods.length, 2);
  assert.equal(report.invariants.every((item) => item.ok === true), true);
  const codes = report.recommendations.map((item) => item.code);
  assert.equal(codes.includes('resolve-explicit'), true);
  assert.equal(codes.includes('inspect-sessions-file'), true);
  assert.equal(codes.includes('lease-conflicts'), true);
  // 可序列化（status/CLI 会直接 JSON 输出）。
  assert.equal(typeof JSON.stringify(report), 'string');
});

test('buildRecoveryReport：干净状态给 clean 建议；无 pending 时 manualResolve 为空', () => {
  const report = buildRecoveryReport({ ledgerStatus: { pending: [] }, now: NOW });
  assert.equal(report.summary.manualRequired, 0);
  assert.equal(report.manualResolve.required.length, 0);
  assert.deepEqual(report.recommendations.map((item) => item.code), ['clean']);
  assert.deepEqual(report.leases, null);
  const summary = summarizeRecoveryReport(report);
  assert.equal(summary.autoResolved, 0);
  assert.equal(summary.manualRequired, 0);
  assert.equal(summary.manualResolve.policy.autoResolve, false);
  assert.equal(summarizeRecoveryReport(null), null);
});

test('normalizeRecoveryOutcome / isExplicitRecoveryOutcome / describeManualResolution', () => {
  assert.equal(normalizeRecoveryOutcome('confirmed').explicit, true);
  assert.equal(normalizeRecoveryOutcome('not-applied').effect, 'none');
  assert.equal(normalizeRecoveryOutcome('abandoned').explicit, false);
  assert.equal(normalizeRecoveryOutcome('nope'), null);
  assert.equal(normalizeRecoveryOutcome(undefined).outcome, 'abandoned');
  assert.equal(isExplicitRecoveryOutcome('confirmed'), true);
  assert.equal(isExplicitRecoveryOutcome('reconciled'), false);
  const text = describeManualResolution(classifyPendingEntry(pendingEntry(), { now: NOW }));
  assert.match(text, /非幂等/);
  assert.match(text, /confirmed/);
  const activeText = describeManualResolution(classifyPendingEntry(pendingEntry({ state: 'active' }), { now: NOW }));
  assert.match(activeText, /仍在执行/);
  assert.match(describeManualResolution(null), /未知恢复条目/);
});

// ---------------------------------------------------------------------------
// 人工 resolve 计划
// ---------------------------------------------------------------------------

test('planManualResolve：非法结论/空目标快速失败；eligible/protected/active/missing 分类', () => {
  const status = {
    pending: [
      pendingEntry({ id: 'lt_explicit', recovered: true, nonIdempotent: true }),
      pendingEntry({ id: 'lt_legacy', recovered: false, nonIdempotent: false, replayBlocked: false }),
      pendingEntry({ id: 'lt_active', state: 'active', recovered: false }),
    ],
  };
  const badOutcome = planManualResolve({ status, targets: ['lt_explicit'], outcome: 'nope' });
  assert.equal(badOutcome.ok, false);
  assert.equal(badOutcome.error, 'E_BAD_ARG');
  assert.deepEqual(badOutcome.allowedOutcomes, ['confirmed', 'not-applied', 'applied', 'none', 'abandoned', 'reconciled']);
  assert.equal(planManualResolve({ status, targets: [] }).error, 'E_BAD_ARG');
  // 旧结论不能解锁崩溃恢复的非幂等意图。
  const protectedPlan = planManualResolve({ status, targets: ['lt_explicit'], outcome: 'abandoned' });
  assert.equal(protectedPlan.ok, true);
  assert.equal(protectedPlan.counts.protected, 1);
  assert.deepEqual(protectedPlan.targets[0].requiredOutcomes, ['confirmed', 'not-applied']);
  // 显式结论 → eligible。
  const eligible = planManualResolve({ status, targets: ['lt_explicit', 'lt_legacy'], outcome: 'confirmed' });
  assert.equal(eligible.counts.eligible, 2);
  assert.equal(eligible.explicit, true);
  assert.equal(eligible.effect, 'applied');
  // 普通 legacy 未知可用 abandoned（非显式）。
  const legacy = planManualResolve({ status, targets: ['lt_legacy'], outcome: 'abandoned' });
  assert.equal(legacy.counts.eligible, 1);
  assert.equal(legacy.explicit, false);
  // active/缺失。
  const mixed = planManualResolve({ status, targets: ['lt_active', 'lt_missing', 'lt_explicit'], outcome: 'confirmed' });
  assert.equal(mixed.counts.active, 1);
  assert.equal(mixed.counts.missing, 1);
  assert.equal(mixed.counts.eligible, 1);
  assert.equal(mixed.policy.autoResolve, false);
  assert.equal(mixed.policy.allowResolveActive, false);
  // 去重 + by 透传。
  const deduped = planManualResolve({ status, targets: ['lt_explicit', 'lt_explicit'], outcome: 'confirmed', by: 'ops' });
  assert.equal(deduped.counts.requested, 1);
  assert.equal(deduped.by, 'ops');
});

test('applyManualResolve：只结算 eligible，protected/active/missing 永不自动解锁', () => {
  const status = {
    pending: [
      pendingEntry({ id: 'lt_ok', recovered: true, nonIdempotent: true }),
      pendingEntry({ id: 'lt_blocked', recovered: true, nonIdempotent: true }),
    ],
  };
  const plan = planManualResolve({ status, targets: ['lt_ok', 'lt_blocked', 'lt_missing'], outcome: 'confirmed' });
  // 手动把 blocked 标成 protected（模拟策略收紧）。
  plan.targets.find((item) => item.id === 'lt_blocked').status = 'protected';
  const calls = [];
  const ledger = {
    resolve(id, outcome, options) {
      calls.push({ id, outcome, options });
      return { id, state: 'resolved', outcome };
    },
  };
  const result = applyManualResolve({ ledger, plan, by: 'tester', now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.autoResolved, 0);
  assert.equal(result.counts.resolved, 1);
  assert.equal(result.counts.skipped, 2);
  assert.deepEqual(calls.map((call) => call.id), ['lt_ok']);
  assert.equal(calls[0].options.by, 'tester');
  assert.deepEqual(result.protected.map((item) => item.id), ['lt_blocked']);
  assert.deepEqual(result.missing, ['lt_missing']);
  // resolve 抛错 → failed 记录，不影响其它条目。
  const throwingLedger = {
    resolve(id) {
      if (id === 'lt_ok') throw Object.assign(new Error('boom'), { code: 'E_LEDGER_IO' });
      return { id, state: 'resolved' };
    },
  };
  const plan2 = planManualResolve({
    status: { pending: [pendingEntry({ id: 'lt_ok' }), pendingEntry({ id: 'lt_ok2' })] },
    targets: ['lt_ok', 'lt_ok2'],
    outcome: 'confirmed',
  });
  const failed = applyManualResolve({ ledger: throwingLedger, plan: plan2 });
  assert.equal(failed.ok, false);
  assert.equal(failed.failed.length, 1);
  assert.equal(failed.failed[0].code, 'E_LEDGER_IO');
  assert.equal(failed.resolved.length, 1);
  assert.equal(applyManualResolve({ ledger: null, plan }).error, 'E_INTERNAL');
  assert.equal(applyManualResolve({ ledger: { resolve() {} }, plan: { ok: false } }).ok, false);
});

// ---------------------------------------------------------------------------
// 端到端：真实账本崩溃恢复 + reporter
// ---------------------------------------------------------------------------

test('createRecoveryReporter：真实 WAL 崩溃恢复 → 报告 → 人工 confirmed 解锁', () => {
  const ledger = crashedLedger([
    { method: 'click', tabId: 7, sessionId: 's1' },
    { method: 'session.pause', tabId: 7, sessionId: 's1' },
  ]);
  assert.equal(ledger.status({}).pending.length, 2);
  const reporter = createRecoveryReporter({ ledger, now: () => NOW, log: () => {}, sessions: new Map() });
  const report = reporter.report({ limit: 5 });
  assert.equal(report.manualResolve.required.length, 2);
  assert.equal(report.summary.explicitOnly, 2);
  assert.equal(report.summary.autoResolved, 0);
  const summary = reporter.summary();
  assert.equal(summary.manualRequired, 2);
  assert.equal(summary.explicitOnly, 2);
  assert.equal(summary.policy.autoResolve, false);
  assert.equal(summary.lastManual, null);
  // dryRun：只出计划，账本仍是 pending。
  const ids = ledger.status({}).pending.map((entry) => entry.id);
  const dry = reporter.manualResolve({ ids, outcome: 'confirmed', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.counts.eligible, 2);
  assert.equal(ledger.status({}).pending.length, 2);
  // 旧结论被 protected。
  const blocked = reporter.manualResolve({ ids, outcome: 'abandoned', dryRun: true });
  assert.equal(blocked.counts.protected, 2);
  // 显式 confirmed → 结算。
  const applied = reporter.manualResolve({ ids, outcome: 'confirmed', by: 'ops' });
  assert.equal(applied.ok, true);
  assert.equal(applied.counts.resolved, 2);
  assert.equal(applied.autoResolved, 0);
  assert.equal(ledger.status({}).pending.length, 0);
  assert.equal(reporter.lastManual.counts.resolved, 2);
  const after = reporter.report();
  assert.equal(after.summary.explicitOnly, 0);
  // 重复 resolve 已结算记录：pending 里已不存在 → missing，不报错。
  const again = reporter.manualResolve({ ids, outcome: 'confirmed', dryRun: true });
  assert.equal(again.counts.missing, 2);
  // reset 清空报告缓存。
  const reset = reporter.reset();
  assert.equal(reset.lastManual, null);
  assert.equal(reporter.lastReport, null);
});

test('createRecoveryReporter：账本读取失败降级为空 pending，summary 不抛错', () => {
  const brokenLedger = {
    status() { throw new Error('ledger boom'); },
    resolve() { throw new Error('resolve boom'); },
  };
  const reporter = createRecoveryReporter({ ledger: brokenLedger, now: () => NOW, log: () => {} });
  const report = reporter.report();
  assert.equal(report.ledger.pending, 0);
  assert.equal(report.summary.manualRequired, 0);
  const summary = reporter.summary();
  assert.equal(summary.pending, 0);
  const plan = reporter.manualResolve({ ids: ['lt_x'], outcome: 'confirmed', dryRun: true });
  assert.equal(plan.counts.missing, 1);
});

test('RECOVERY_MANUAL_POLICY：只读常量语义（不自动 resolve + 显式结论清单）', () => {
  assert.equal(RECOVERY_MANUAL_POLICY.autoResolve, false);
  assert.deepEqual([...RECOVERY_MANUAL_POLICY.explicitOutcomes], ['confirmed', 'not-applied']);
  assert.equal(RECOVERY_MANUAL_POLICY.requireExplicitForRecoveredNonIdempotent, true);
  assert.equal(Array.isArray(RECOVERY_MANUAL_POLICY.legacyOutcomes), true);
});
