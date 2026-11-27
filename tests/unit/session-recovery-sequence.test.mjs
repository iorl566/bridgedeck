// tests/unit/session-recovery-sequence.test.mjs —— 崩溃恢复处置序列：
// 恢复清单（全部 auto=false）、混合意图的人工 resolve、单条账本语义（E_LEDGER_RESOLVE_REQUIRED/
// 重复 resolve/冲突结论）、按 tab reconcile 与恢复报告之间的联动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentLedger, createMemoryLedgerStorage } from '../../lib/intent-ledger.mjs';
import { createLedgerReport } from '../../daemon/ledger-report.js';
import {
  applyManualResolve,
  buildRecoveryChecklist,
  buildRecoveryReport,
  createRecoveryReporter,
  planManualResolve,
} from '../../daemon/recovery-report.js';

const NOW = 1_700_000_000_000;

function crashLedger(entries = []) {
  const storage = createMemoryLedgerStorage();
  const before = new IntentLedger({ storage, fsync: false, now: () => NOW });
  for (const entry of entries) before.begin(entry.method, {}, { tabId: entry.tabId, sessionId: entry.sessionId });
  const ledger = new IntentLedger({ storage, fsync: false, now: () => NOW });
  ledger.recover({ legacyState: 'unknown', reason: 'sequence-test' });
  return ledger;
}

// ---------------------------------------------------------------------------
// 处置清单
// ---------------------------------------------------------------------------

test('buildRecoveryChecklist：按严重度排序、所有步骤 auto=false、可序列化', () => {
  const report = buildRecoveryReport({
    ledgerStatus: {
      pending: [
        { id: 'lt_a', at: new Date(NOW - 1_000).toISOString(), method: 'click', tabId: 7, state: 'unknown', recovered: true, nonIdempotent: true, replayBlocked: true },
        { id: 'lt_b', at: new Date(NOW - 1_000).toISOString(), method: 'debug.start', tabId: 7, state: 'unknown', recovered: true, nonIdempotent: false, replayBlocked: false },
        { id: 'lt_c', at: new Date(NOW - 1_000).toISOString(), method: 'observe', tabId: 7, state: 'active', recovered: false, replayBlocked: false },
      ],
    },
    sessionPlan: { stats: { invalid: 1, duplicates: 0, expired: 0, restore: 1 } },
    leaseReport: { totals: {}, orphans: [], reclaim: null, conflicts: [{ code: 'x', severity: 'high' }] },
    now: NOW,
  });
  const checklist = report.checklist;
  assert.ok(checklist);
  assert.equal(checklist.canAutoResolve, false);
  const steps = checklist.items.map((item) => item.step);
  assert.deepEqual(steps, ['resolve-manual', 'reconcile-or-resolve', 'wait-active', 'inspect-sessions-file', 'inspect-lease-conflicts']);
  assert.equal(checklist.counts.manual, 1);
  assert.equal(checklist.counts.reconcile, 1);
  assert.equal(checklist.counts.wait, 1);
  assert.equal(checklist.counts.inspect, 2);
  assert.equal(checklist.items.every((item) => item.auto === false), true);
  assert.equal(checklist.items[0].requiredOutcomes.includes('confirmed'), true);
  assert.match(checklist.note, /不会自动 resolve/);
  assert.equal(typeof JSON.stringify(checklist), 'string');
  // 干净报告 → clean。
  const clean = buildRecoveryChecklist(buildRecoveryReport({ ledgerStatus: { pending: [] }, now: NOW }));
  assert.deepEqual(clean.items.map((item) => item.step), ['clean']);
  assert.equal(clean.canAutoResolve, false);
  assert.equal(buildRecoveryChecklist(null).canAutoResolve, false);
});

test('buildRecoveryChecklist：直接传入构造报告也可用（不经 buildRecoveryReport）', () => {
  const checklist = buildRecoveryChecklist({
    at: NOW,
    manualResolve: {
      required: [{ id: 'lt_x', method: 'navigate', tabId: 1, requiredOutcomes: ['confirmed', 'not-applied'] }],
      candidates: [],
      stillActive: [],
    },
    sessions: { plan: null },
    summary: { leaseConflicts: { high: 0 } },
  });
  assert.equal(checklist.items.length, 1);
  assert.equal(checklist.items[0].auto, false);
  assert.equal(checklist.items[0].severity, 'high');
  assert.match(checklist.items[0].action, /confirmed/);
});

// ---------------------------------------------------------------------------
// 混合意图：非幂等恢复必须显式，普通未知可 reconcile
// ---------------------------------------------------------------------------

test('混合崩溃意图：reconcile 只结算可结算项，非幂等仍 protected；逐条 confirmed 后才清零', () => {
  const ledger = crashLedger([
    { method: 'click', tabId: 7, sessionId: 's1' },
    { method: 'debug.start', tabId: 7, sessionId: 's1' },
  ]);
  const reporter = createRecoveryReporter({ ledger, now: () => NOW, log: () => {} });
  const pending = ledger.status({}).pending;
  assert.equal(pending.length, 2);
  const nonIdempotentEntry = pending.find((entry) => entry.method === 'click');
  const controlEntry = pending.find((entry) => entry.method === 'debug.start');
  assert.ok(nonIdempotentEntry && controlEntry);
  assert.equal(nonIdempotentEntry.replayBlocked, true);
  // 用旧结论 reconcile 两个 id：只有非幂等的那个被 protected。
  const plan = planManualResolve({ status: ledger.status({}), targets: [nonIdempotentEntry.id, controlEntry.id], outcome: 'reconciled' });
  assert.equal(plan.counts.protected, 1);
  assert.equal(plan.counts.eligible, 1);
  const applied = applyManualResolve({ ledger, plan, by: 'ops' });
  assert.equal(applied.counts.resolved, 1);
  assert.equal(applied.autoResolved, 0);
  assert.equal(applied.resolved[0].id, controlEntry.id);
  // 非幂等仍阻断：再次 begin 同 tab 非幂等动作会被账本拒绝。
  assert.throws(
    () => ledger.begin('navigate', {}, { tabId: 7, sessionId: 's1' }),
    (error) => error.code === 'E_LEDGER_PENDING' || error.code === 'E_LEDGER_RESOLVE_REQUIRED',
  );
  // 显式 confirmed 后解锁。
  const resolved = ledger.resolve(nonIdempotentEntry.id, 'confirmed', { by: 'human' });
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.resolution.effect, 'applied');
  assert.equal(ledger.status({}).pending.length, 0);
  const nav = ledger.begin('navigate', {}, { tabId: 7, sessionId: 's1' });
  assert.ok(nav, '解锁后同 tab 非幂等动作可以再次落账');
  ledger.finish(nav, 'done');
  // 报告刷新后人工项清零。
  const after = reporter.report();
  assert.equal(after.summary.manualRequired, 0);
  assert.equal(after.checklist.items[0].step, 'clean');
});

// ---------------------------------------------------------------------------
// 单条账本语义
// ---------------------------------------------------------------------------

test('账本单条 resolve：旧结论 E_LEDGER_RESOLVE_REQUIRED、显式 not-applied、重复 resolve 幂等', () => {
  const ledger = crashLedger([{ method: 'click', tabId: 7, sessionId: 's1' }]);
  const id = ledger.status({}).pending[0].id;
  assert.throws(
    () => ledger.resolve(id, 'abandoned', { by: 'ops' }),
    (error) => {
      assert.equal(error.code, 'E_LEDGER_RESOLVE_REQUIRED');
      assert.deepEqual(error.data.allowedOutcomes, ['confirmed', 'not-applied']);
      assert.equal(error.data.recovered, true);
      return true;
    },
  );
  // not-applied 显式结论：效果 none。
  const resolved = ledger.resolve(id, 'not-applied', { by: 'ops' });
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.resolution.effect, 'none');
  assert.equal(resolved.resolution.explicit, true);
  // 相同结论重复 resolve：duplicate 证据，不重复写。
  const duplicate = ledger.resolve(id, 'not-applied', { by: 'ops' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.resolution.effect, 'none');
  // 不同结论重复 resolve：冲突错误。
  assert.throws(
    () => ledger.resolve(id, 'confirmed'),
    (error) => /^E_LEDGER_/.test(String(error.code || '')),
  );
});

test('createLedgerReport.reconcile：按 tab 批量和解时保护崩溃恢复的非幂等意图', () => {
  const ledger = crashLedger([
    { method: 'click', tabId: 7, sessionId: 's1' },
    { method: 'debug.start', tabId: 7, sessionId: 's1' },
    { method: 'debug.start', tabId: 8, sessionId: 's1' },
  ]);
  const report = createLedgerReport({ ledger, now: () => NOW, log: () => {} });
  const plan = report.reconcile({ tabId: 7, outcome: 'reconciled', by: 'ops', dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.eligible, 1);
  assert.equal(plan.protected.length, 1);
  assert.equal(plan.protected[0].method, 'click');
  const applied = report.reconcile({ tabId: 7, outcome: 'reconciled', by: 'ops' });
  assert.equal(applied.resolved, 1);
  assert.equal(applied.remaining.eligible, 0);
  assert.equal(applied.remaining.protected, 1);
  // tab 8 仍 pending（本次只处理 tab 7）。
  assert.equal(ledger.status({}).pending.length, 2);
});

// ---------------------------------------------------------------------------
// 报告/摘要联动
// ---------------------------------------------------------------------------

test('恢复报告与 reporter.summary：手动 resolve 后报告与摘要同步刷新', () => {
  const ledger = crashLedger([{ method: 'click', tabId: 7, sessionId: 's1' }]);
  const reporter = createRecoveryReporter({ ledger, now: () => NOW, log: () => {} });
  const summaryBefore = reporter.summary();
  assert.equal(summaryBefore.manualRequired, 1);
  assert.equal(summaryBefore.hasReport, false);
  const report = reporter.report();
  assert.equal(report.checklist.items[0].step, 'resolve-manual');
  assert.equal(reporter.summary().hasReport, true);
  const id = ledger.status({}).pending[0].id;
  const applied = reporter.manualResolve({ ids: [id], outcome: 'confirmed' });
  assert.equal(applied.counts.resolved, 1);
  const summaryAfter = reporter.summary();
  assert.equal(summaryAfter.manualRequired, 0);
  assert.ok(summaryAfter.lastManual);
  assert.equal(summaryAfter.lastManual.outcome, 'confirmed');
  assert.equal(summaryAfter.lastManual.resolved, 1);
  assert.equal(reporter.lastManual.autoResolved, 0);
});

test('恢复报告可重复构造：同一账本下 report() 结果结构稳定（幂等只读）', () => {
  const ledger = crashLedger([{ method: 'navigate', tabId: 9, sessionId: 's1' }]);
  const reporter = createRecoveryReporter({ ledger, now: () => NOW, log: () => {} });
  const first = reporter.report();
  const second = reporter.report();
  assert.equal(first.summary.manualRequired, second.summary.manualRequired);
  assert.deepEqual(first.manualResolve.required.map((item) => item.id), second.manualResolve.required.map((item) => item.id));
  assert.deepEqual(first.checklist.items.map((item) => item.step), second.checklist.items.map((item) => item.step));
  assert.equal(ledger.status({}).pending.length, 1, '只读报告不写账本');
});
