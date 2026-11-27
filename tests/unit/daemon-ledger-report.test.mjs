// tests/unit/daemon-ledger-report.test.mjs —— 账本快照/恢复对账/批量和解报告。
//
// 覆盖 daemon/ledger-report.js 的两层：
//   1) 纯函数：buildLedgerSnapshot / indexLedgerTabs / digest / 校验 / 比较 / reconcile 计划；
//   2) 报告器：createLedgerReport 的 snapshot/persist/read/restore/reconcile/summary；
//   3) 与真实 IntentLedger（lib/intent-ledger.mjs）的集成：pending→unknown 语义保持，
//      崩溃恢复的非幂等动作必须显式 confirmed|not-applied 才能解除阻断。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SNAPSHOT_MAX_PENDING,
  LEDGER_SNAPSHOT_KIND,
  LEDGER_SNAPSHOT_SCHEMA,
  buildLedgerSnapshot,
  canonicalJson,
  compareLedgerSnapshots,
  createLedgerReport,
  indexLedgerTabs,
  ledgerSnapshotDigest,
  planLedgerReconcile,
  validateLedgerSnapshot,
} from '../../daemon/ledger-report.js';
import { IntentLedger, createMemoryLedgerStorage } from '../../lib/intent-ledger.mjs';
import { recoverLedgerOnStartup } from '../../daemon/session-recovery.js';

const NOW = Date.parse('2026-11-26T02:00:00.000Z');

function entry(overrides = {}) {
  return {
    id: 'lt_' + Math.random().toString(16).slice(2, 10),
    at: new Date(NOW - 5_000).toISOString(),
    method: 'click',
    tabId: 7,
    sessionId: 's1',
    keys: ['selector'],
    target: { ref: '@e1' },
    state: 'unknown',
    nonIdempotent: true,
    replayBlocked: true,
    recovered: true,
    ...overrides,
  };
}

function fakeLedger(entries) {
  const state = { entries, reconcileCalls: [], resolveCalls: [], recovery: null };
  const isPending = (item) => item.state === 'active' || item.state === 'stale' || item.state === 'unknown';
  const explicitOutcome = (outcome) => ['confirmed', 'not-applied', 'applied', 'none'].includes(String(outcome));
  return {
    state,
    status({ limit = 20 } = {}) {
      const pending = state.entries.filter(isPending);
      return {
        staleMs: 15_000,
        pending,
        recent: state.entries.slice(-Math.max(1, limit)).reverse(),
        recovery: state.recovery,
        wal: { lines: 2, parsed: 2, corrupted: 0, tornTail: false, duplicates: 0, outOfOrder: 0 },
        durability: { fsync: true, appends: 2, syncs: 2, degraded: false, lastError: null },
      };
    },
    stats() {
      return {
        entries: { total: state.entries.length },
        wal: { corrupted: 0 },
        durability: { fsync: true },
        recovery: state.recovery,
        nextSeq: 3,
        entriesAll: state.entries,
      };
    },
    reconcile(tabId, outcome) {
      state.reconcileCalls.push({ tabId, outcome });
      let resolved = 0;
      for (const item of state.entries) {
        if (item.tabId !== tabId || (item.state !== 'stale' && item.state !== 'unknown')) continue;
        if (item.recovered === true && item.nonIdempotent === true && !explicitOutcome(outcome)) continue;
        item.state = 'resolved';
        item.outcome = outcome;
        resolved += 1;
      }
      return resolved;
    },
    resolve(id, outcome) {
      state.resolveCalls.push({ id, outcome });
      const item = state.entries.find((current) => current.id === id);
      item.state = 'resolved';
      return item;
    },
  };
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ledger-report-'));
}

// ---------------------------------------------------------------------------
// 纯函数：快照结构 / 校验 / 摘要
// ---------------------------------------------------------------------------

test('buildLedgerSnapshot：schema/kind/计数/按 tab 索引/digest/pending 截断', () => {
  const pending = [
    entry({ id: 'lt_a', state: 'unknown', replayBlocked: true }),
    entry({ id: 'lt_b', state: 'stale', replayBlocked: false, recovered: false, tabId: 8 }),
    entry({ id: 'lt_c', state: 'active', replayBlocked: false, tabId: null, method: 'navigate' }),
  ];
  const snapshot = buildLedgerSnapshot({
    status: { staleMs: 15_000, pending, recent: pending.slice(0, 1), wal: { lines: 3 }, durability: { fsync: true } },
    stats: { entriesAll: pending },
    now: NOW,
    maxPending: 2,
  });
  assert.equal(snapshot.schema, LEDGER_SNAPSHOT_SCHEMA);
  assert.equal(snapshot.kind, LEDGER_SNAPSHOT_KIND);
  assert.equal(snapshot.at, new Date(NOW).toISOString());
  assert.equal(snapshot.counts.pending, 3);
  assert.equal(snapshot.counts.pendingUnknown, 1);
  assert.equal(snapshot.counts.pendingStale, 1);
  assert.equal(snapshot.counts.pendingActive, 1);
  assert.equal(snapshot.counts.replayBlocked, 1);
  assert.equal(snapshot.counts.tabs, 3);
  assert.equal(snapshot.pending.length, 2);
  assert.equal(snapshot.pendingTruncated, true);
  assert.equal(snapshot.pendingTruncatedCount, 1);
  assert.equal(snapshot.tabs.length, 3);
  assert.match(snapshot.digest, /^[0-9a-f]{16}$/);
  assert.equal(snapshot.pending[0].ageMs, 5_000);
  assert.equal(validateLedgerSnapshot(snapshot).ok, true);
});

test('indexLedgerTabs：按 tab 聚合状态/会话/方法并排序', () => {
  const tabs = indexLedgerTabs([
    entry({ id: 'lt_1', tabId: 7, state: 'unknown', sessionId: 's1', method: 'click' }),
    entry({ id: 'lt_2', tabId: 7, state: 'stale', sessionId: 's2', method: 'fill', replayBlocked: false }),
    entry({ id: 'lt_3', tabId: 9, state: 'unknown', sessionId: 's1', method: 'navigate' }),
  ], { now: NOW });
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].tabId, 7, 'pending 多的 tab 在前');
  assert.equal(tabs[0].pending, 2);
  assert.equal(tabs[0].unknown, 1);
  assert.equal(tabs[0].stale, 1);
  assert.deepEqual(tabs[0].sessions.sort(), ['s1', 's2']);
  assert.deepEqual(tabs[0].methods.sort(), ['click', 'fill']);
  assert.equal(tabs[0].oldestAgeMs, 5_000);
  assert.equal(tabs[1].tabId, 9);
});

test('digest/validate：键排序稳定；篡改字段后 digest 不一致', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  const snapshot = buildLedgerSnapshot({ status: { pending: [entry({ id: 'lt_x' })] }, now: NOW });
  const again = buildLedgerSnapshot({ status: { pending: [entry({ id: 'lt_x' })] }, now: NOW });
  assert.equal(snapshot.digest, again.digest, '同内容快照 digest 必须一致');
  assert.equal(ledgerSnapshotDigest(snapshot), snapshot.digest);
  const tampered = { ...snapshot, counts: { ...snapshot.counts, pending: 99 } };
  const validation = validateLedgerSnapshot(tampered);
  assert.equal(validation.ok, false);
  assert.equal(validation.digestOk, false);
  assert.equal(validation.errors.some((item) => item.includes('digest')), true);
  assert.equal(validateLedgerSnapshot({ schema: 2, kind: 'x' }).ok, false);
  assert.equal(validateLedgerSnapshot(null).ok, false);
});

test('compareLedgerSnapshots：已结算/新增未知/仍阻断 三类漂移', () => {
  const previous = buildLedgerSnapshot({
    status: { pending: [entry({ id: 'lt_old' }), entry({ id: 'lt_still' }), entry({ id: 'lt_gone' })] },
    now: NOW - 10_000,
  });
  const current = buildLedgerSnapshot({
    status: {
      pending: [
        entry({ id: 'lt_still' }),
        entry({ id: 'lt_new', state: 'unknown' }),
      ],
    },
    now: NOW,
  });
  const comparison = compareLedgerSnapshots(previous, current);
  assert.equal(comparison.drift, true);
  assert.equal(comparison.stable, false);
  assert.deepEqual(comparison.resolvedSince.map((item) => item.id).sort(), ['lt_gone', 'lt_old']);
  assert.deepEqual(comparison.becameUnknown.map((item) => item.id), ['lt_new']);
  assert.deepEqual(comparison.stillBlocked.map((item) => item.id), ['lt_still']);
  assert.equal(comparison.counts.previousPending, 3);
  assert.equal(comparison.counts.currentPending, 2);
  const empty = compareLedgerSnapshots(null, current);
  assert.equal(empty.counts.previousPending, 0);
  assert.equal(empty.counts.becameUnknown, 2);
});

test('planLedgerReconcile：eligible/protected/active 三分，显式结论解锁恢复动作', () => {
  const status = {
    pending: [
      entry({ id: 'lt_recovered', recovered: true, nonIdempotent: true, state: 'unknown' }),
      entry({ id: 'lt_normal', recovered: false, nonIdempotent: true, state: 'stale' }),
      entry({ id: 'lt_active', state: 'active', replayBlocked: false }),
      entry({ id: 'lt_other_tab', tabId: 8, state: 'unknown' }),
    ],
  };
  const implicit = planLedgerReconcile({ status, tabId: 7, outcome: 'reconciled', now: NOW });
  assert.equal(implicit.candidates, 3);
  assert.deepEqual(implicit.eligible.map((item) => item.id), ['lt_normal']);
  assert.deepEqual(implicit.protected.map((item) => item.id), ['lt_recovered']);
  assert.equal(implicit.protected[0].reason, 'explicit-outcome-required');
  assert.deepEqual(implicit.active.map((item) => item.id), ['lt_active']);
  assert.deepEqual(implicit.tabIds, [7]);
  assert.equal(implicit.skipped, 2);

  const explicit = planLedgerReconcile({ status, tabId: 7, outcome: 'confirmed', now: NOW });
  assert.deepEqual(explicit.eligible.map((item) => item.id).sort(), ['lt_normal', 'lt_recovered']);
  assert.equal(explicit.explicit, true);
  assert.equal(explicit.protected.length, 0);

  const all = planLedgerReconcile({ status, tabId: null, outcome: 'reconciled', now: NOW });
  assert.deepEqual(all.tabIds, [7, 8]);
  assert.equal(all.candidates, 4);
});

// ---------------------------------------------------------------------------
// 报告器：持久化 / 恢复 / reconcile
// ---------------------------------------------------------------------------

test('createLedgerReport：持久化快照可读回、digest 校验、篡改可见', () => {
  const home = tempHome();
  try {
    const ledger = fakeLedger([entry({ id: 'lt_p1' })]);
    const report = createLedgerReport({ ledger, dir: home, now: () => NOW, log: () => {} });
    assert.equal(report.snapshotPath, path.join(home, 'ledger-snapshot.json'));
    const missing = report.readPersistedSnapshot();
    assert.equal(missing.exists, false);
    assert.equal(missing.error, 'E_LEDGER_IO');

    const persisted = report.persistSnapshot();
    assert.equal(persisted.ok, true);
    assert.ok(fs.existsSync(persisted.path));
    assert.match(persisted.digest, /^[0-9a-f]{16}$/);
    const read = report.readPersistedSnapshot();
    assert.equal(read.ok, true);
    assert.equal(read.validation.digestOk, true);
    assert.equal(read.snapshot.counts.pending, 1);

    // 手工篡改：digest 不一致 → restore 报不可用，但仍返回当前账本状态（不自动解锁）。
    const raw = JSON.parse(fs.readFileSync(persisted.path, 'utf8'));
    raw.counts.pending = 42;
    fs.writeFileSync(persisted.path, JSON.stringify(raw), 'utf8');
    const tampered = report.restore();
    assert.equal(tampered.exists, true);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.error, 'E_LEDGER_IO');
    assert.equal(tampered.current.pending, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('createLedgerReport.restore：无快照返回 exists=false；有快照时给出漂移且不调用 reconcile', () => {
  const home = tempHome();
  try {
    const ledger = fakeLedger([entry({ id: 'lt_keep', state: 'unknown' }), entry({ id: 'lt_done', state: 'unknown' })]);
    const report = createLedgerReport({ ledger, dir: home, now: () => NOW, log: () => {} });
    const absent = report.restore();
    assert.equal(absent.exists, false);
    assert.equal(absent.ok, true);
    assert.equal(absent.restored, 0);
    assert.equal(absent.current.pending, 2);

    report.persistSnapshot();
    // 快照之后 lt_done 被显式 resolve；lt_keep 仍是 unknown。
    ledger.state.entries = ledger.state.entries.filter((item) => item.id !== 'lt_done');
    ledger.state.entries.push(entry({ id: 'lt_new', state: 'unknown' }));
    const restored = report.restore();
    assert.equal(restored.exists, true);
    assert.equal(restored.ok, true);
    assert.equal(restored.digestOk, true);
    assert.equal(restored.drift.counts.resolvedSince, 1);
    assert.equal(restored.drift.counts.becameUnknown, 1);
    assert.equal(restored.drift.counts.stillBlocked, 1);
    assert.equal(restored.blocked, 1, '仍阻断数量必须保留');
    assert.deepEqual(ledger.state.reconcileCalls, [], '恢复对账不得自动 reconcile');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('createLedgerReport.reconcile：按 tab 批量和解、dry-run、缺参数报 E_BAD_ARG', () => {
  const home = tempHome();
  try {
    const ledger = fakeLedger([
      entry({ id: 'lt_a', tabId: 7, state: 'unknown', recovered: false }),
      entry({ id: 'lt_b', tabId: 7, state: 'stale', recovered: false }),
      entry({ id: 'lt_c', tabId: 8, state: 'unknown', recovered: false }),
    ]);
    const report = createLedgerReport({ ledger, dir: home, now: () => NOW, log: () => {} });

    const bad = report.reconcile({ tabId: null });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'E_BAD_ARG');

    const dry = report.reconcile({ tabId: 7, outcome: 'reconciled', dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.wouldResolve, 2);
    assert.deepEqual(ledger.state.reconcileCalls, [], 'dry-run 不能真的和解');

    const applied = report.reconcile({ tabId: 7, outcome: 'reconciled', by: 'unit' });
    assert.equal(applied.ok, true);
    assert.equal(applied.resolved, 2);
    assert.equal(applied.candidates, 2);
    assert.deepEqual(applied.perTab, [{ tabId: 7, resolved: 2 }]);
    assert.equal(applied.remaining.pending, 1);
    assert.deepEqual(ledger.state.reconcileCalls, [{ tabId: 7, outcome: 'reconciled' }]);

    const all = report.reconcile({ all: true, outcome: 'reconciled' });
    assert.equal(all.resolved, 1);
    assert.deepEqual(all.tabIds, [8]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('createLedgerReport.summary：pending 分状态 + 快照/恢复证据', () => {
  const home = tempHome();
  try {
    const ledger = fakeLedger([
      entry({ id: 'lt_u', state: 'unknown', replayBlocked: true }),
      entry({ id: 'lt_s', state: 'stale', replayBlocked: false }),
    ]);
    const report = createLedgerReport({ ledger, dir: home, now: () => NOW, log: () => {} });
    const summary = report.summary();
    assert.equal(summary.pending, 2);
    assert.equal(summary.unknown, 1);
    assert.equal(summary.stale, 1);
    assert.equal(summary.replayBlocked, 1);
    assert.equal(summary.tabs, 1);
    assert.equal(summary.snapshot.path, path.join(home, 'ledger-snapshot.json'));
    assert.equal(summary.snapshot.restore.exists, false);
    report.persistSnapshot();
    const after = report.summary();
    assert.equal(after.snapshot.restore.exists, true);
    assert.equal(after.snapshot.restore.ok, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 与真实账本集成：pending → unknown / 非幂等必须显式 resolve
// ---------------------------------------------------------------------------

test('真实 IntentLedger：崩溃恢复后 pending→unknown，批量 reconcile 保持阻断直到显式结论', () => {
  const storage = createMemoryLedgerStorage();
  const first = new IntentLedger({ storage, now: () => NOW - 60_000 });
  const begun = first.begin('click', { selector: '#go' }, { tabId: 7, sessionId: 's1' });
  assert.equal(begun.state, 'active');

  // 模拟进程崩溃后重启：同一份存储被新实例读取，recover() 把 pending 升级为 unknown。
  const second = new IntentLedger({ storage, now: () => NOW });
  const recovery = recoverLedgerOnStartup(second, { legacyState: 'unknown', reason: 'daemon-restart' });
  assert.equal(recovery.ok, true);
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.unknown >= 1, true);

  const report = createLedgerReport({ ledger: second, dir: null, now: () => NOW, log: () => {} });
  const snapshot = report.snapshot();
  assert.equal(snapshot.counts.pendingUnknown, 1);
  assert.equal(snapshot.counts.replayBlocked, 1);
  assert.equal(snapshot.tabs[0].tabId, 7);

  // 隐式结论：恢复后的非幂等动作受保护，不允许自动解锁。
  const implicit = report.reconcile({ tabId: 7, outcome: 'reconciled' });
  assert.equal(implicit.ok, true);
  assert.equal(implicit.resolved, 0);
  assert.equal(implicit.protected.length, 1);
  assert.equal(implicit.protected[0].reason, 'explicit-outcome-required');
  assert.equal(second.status({}).pending.length, 1);
  assert.equal(second.status({}).pending[0].replayBlocked, true);

  // 显式结论：confirmed 才解除阻断。
  const explicit = report.reconcile({ tabId: 7, outcome: 'confirmed', by: 'unit-test' });
  assert.equal(explicit.resolved, 1);
  assert.equal(second.status({}).pending.length, 0);
  const resolvedEntry = second.entries.find((item) => item.id === begun.id);
  assert.equal(resolvedEntry.state, 'resolved');
  assert.equal(resolvedEntry.resolution.effect, 'applied');
});

test('DEFAULT_SNAPSHOT_MAX_PENDING 生效：pending 列表截断但计数完整', () => {
  const many = Array.from({ length: DEFAULT_SNAPSHOT_MAX_PENDING + 5 }, (_, index) => entry({ id: 'lt_' + index }));
  const snapshot = buildLedgerSnapshot({ status: { pending: many }, now: NOW });
  assert.equal(snapshot.pending.length, DEFAULT_SNAPSHOT_MAX_PENDING);
  assert.equal(snapshot.pendingTruncated, true);
  assert.equal(snapshot.pendingTruncatedCount, 5);
  assert.equal(snapshot.counts.pending, DEFAULT_SNAPSHOT_MAX_PENDING + 5);
  assert.equal(snapshot.counts.tabs, 1);
});
