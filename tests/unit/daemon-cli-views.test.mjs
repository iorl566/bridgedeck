// tests/unit/daemon-cli-views.test.mjs —— `bridge daemon ledger|transfer|queue|doctor` 的人类输出渲染。
//
// cli/lib/daemon-views.mjs 是纯渲染层：这里用真实形态的 daemon 返回结构断言关键行/列，
// 保证 CLI 输出字段与 daemon 视图字段一致（字段名漂移会在这里先失败）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  doctorAreaSummary,
  doctorExitCode,
  formatDurationMs,
  renderDoctorReport,
  renderLedgerReconcile,
  renderLedgerRestore,
  renderLedgerSnapshot,
  renderLedgerStatus,
  renderQueueStatus,
  renderTransferStatus,
} from '../../cli/lib/daemon-views.mjs';

function pendingEntry(overrides = {}) {
  return {
    id: 'lt_aaaaaaaa',
    method: 'click',
    tabId: 7,
    sessionId: 's1',
    state: 'unknown',
    replayBlocked: true,
    recovered: true,
    at: '2026-11-26T01:00:00.000Z',
    ...overrides,
  };
}

test('formatDurationMs：ms/s/m 三档', () => {
  assert.equal(formatDurationMs(0), '0ms');
  assert.equal(formatDurationMs(12.4), '12ms');
  assert.equal(formatDurationMs(1500), '1.5s');
  assert.equal(formatDurationMs(95_000), '1m35s');
  assert.equal(formatDurationMs(120_000), '2m');
});

test('renderLedgerStatus：空账本给出待确认/持久化/恢复摘要', () => {
  const text = renderLedgerStatus({
    staleMs: 15_000,
    pending: [],
    recent: [],
    wal: { lines: 3, parsed: 3, corrupted: 0, tornTail: false, duplicates: 0, outOfOrder: 0 },
    durability: { fsync: true, appends: 3, degraded: false },
    recovery: { ok: true, recovered: 2, replayBlocked: 1, reason: 'daemon-restart' },
  });
  assert.match(text, /待确认 0 条/);
  assert.match(text, /没有待确认的变异操作/);
  assert.match(text, /WAL：解析 3\/3 行/);
  assert.match(text, /持久化：fsync on/);
  assert.match(text, /pending→unknown 2/);
  assert.match(text, /replayBlocked 1/);
});

test('renderLedgerStatus：pending 表格包含 method/tab/session/state 与 blocked 提示', () => {
  const text = renderLedgerStatus({
    staleMs: 15_000,
    pending: [pendingEntry(), pendingEntry({ id: 'lt_bbbbbbbb', method: 'fill', tabId: null, state: 'stale', replayBlocked: false })],
    recent: [{ id: 'lt_cccccccc', method: 'navigate', state: 'resolved', outcome: 'confirmed', at: '2026-11-26T01:02:00.000Z' }],
    wal: { lines: 2, parsed: 2, corrupted: 1, tornTail: true, duplicates: 1, outOfOrder: 1 },
    durability: { fsync: false, appends: 2, degraded: true, lastError: { code: 'E_LEDGER_WAL_IO' } },
    recovery: { ok: false, error: 'ledger-unavailable' },
  });
  assert.match(text, /lt_aaaaaaaa/);
  assert.match(text, /unknown \[blocked\]/);
  assert.match(text, /stale/);
  assert.match(text, /最近记录/);
  assert.match(text, /navigate  resolved → confirmed/);
  assert.match(text, /损坏 1/);
  assert.match(text, /尾部撕裂/);
  assert.match(text, /fsync off/);
  assert.match(text, /降级：E_LEDGER_WAL_IO/);
  assert.match(text, /启动恢复：降级/);
});

test('renderLedgerSnapshot：schema/digest/按 tab 表格/persisted/restore 汇总', () => {
  const text = renderLedgerSnapshot({
    snapshot: {
      schema: 1,
      at: '2026-11-26T02:00:00.000Z',
      digest: 'abcdef1234567890',
      counts: { pending: 3, pendingUnknown: 2, pendingStale: 1, pendingActive: 0, replayBlocked: 2, tabs: 2, total: 9 },
      pendingTruncated: true,
      pendingTruncatedCount: 5,
      tabs: [
        { tabId: 7, pending: 2, unknown: 1, stale: 1, active: 0, replayBlocked: 1, oldestAgeMs: 5000 },
        { tabId: null, pending: 1, unknown: 1, stale: 0, active: 0, replayBlocked: 1, oldestAgeMs: 1000 },
      ],
    },
    persisted: { ok: true, path: 'C:/home/ledger-snapshot.json', bytes: 2048 },
    restore: { exists: false, ok: true, path: 'C:/home/ledger-snapshot.json' },
  });
  assert.match(text, /账本快照 schema=1/);
  assert.match(text, /digest=abcdef1234567890/);
  assert.match(text, /pending 3（unknown 2，stale 1，active 0）/);
  assert.match(text, /pending 列表已截断，省略 5 条/);
  assert.match(text, /tab/);
  assert.match(text, /对账快照已写入：C:\/home\/ledger-snapshot\.json/);
  assert.match(text, /恢复对账：没有历史快照/);
});

test('renderLedgerRestore：缺失/损坏/漂移三类证据', () => {
  const missing = renderLedgerRestore({ exists: false });
  assert.match(missing.join('\n'), /没有历史快照/);

  const broken = renderLedgerRestore({ exists: true, ok: false, error: 'E_LEDGER_SNAPSHOT_INVALID', validation: { errors: ['digest 不一致', 'schema 不是 1'] } });
  assert.match(broken.join('\n'), /快照不可用（E_LEDGER_SNAPSHOT_INVALID）/);
  assert.match(broken.join('\n'), /digest 不一致/);

  const drift = renderLedgerRestore({
    exists: true,
    ok: true,
    snapshotAt: '2026-11-26T01:00:00.000Z',
    ageMs: 65_000,
    digestOk: true,
    current: { pending: 2, unknown: 1, replayBlocked: 1 },
    blocked: 1,
    drift: {
      drift: true,
      counts: { resolvedSince: 2, becameUnknown: 1, stillBlocked: 1, previousPending: 3, currentPending: 2 },
      resolvedSince: [{ id: 'lt_a', method: 'click', tabId: 7 }],
      becameUnknown: [{ id: 'lt_b', method: 'fill', tabId: 8 }],
      stillBlocked: [{ id: 'lt_c', method: 'press', tabId: null }],
    },
  });
  assert.match(drift.join('\n'), /恢复对账：快照 2026-11-26T01:00:00\.000Z/);
  assert.match(drift.join('\n'), /当前：pending 2，unknown 1，replayBlocked 1/);
  assert.match(drift.join('\n'), /漂移：快照后已结算 2 条，新增未知 1 条，仍阻断 1 条/);
  assert.match(drift.join('\n'), /警告：新增未知意图不会被自动解锁/);
  assert.match(drift.join('\n'), /已结算：click@tab7/);
  assert.match(drift.join('\n'), /仍阻断：press@tab-/);
});

test('renderLedgerReconcile：dry-run / protected / perTab / remaining', () => {
  const dry = renderLedgerReconcile({
    ok: true,
    requested: { tabId: 7, all: false, outcome: 'reconciled', explicit: false, by: 'cli' },
    dryRun: true,
    wouldResolve: 3,
    skipped: 2,
  });
  assert.match(dry, /tab 7，结论 reconciled/);
  assert.match(dry, /dry-run：可和解 3 条，跳过 2 条/);

  const applied = renderLedgerReconcile({
    ok: true,
    requested: { all: true, outcome: 'confirmed', explicit: true, by: 'cli' },
    candidates: 5,
    resolved: 3,
    skipped: 2,
    protected: [{ id: 'lt_p', method: 'click', tabId: 7, reason: 'explicit-outcome-required' }],
    active: [{ id: 'lt_a' }],
    perTab: [{ tabId: 7, resolved: 2 }, { tabId: 8, resolved: 1 }],
    remaining: { pending: 2, eligible: 0, protected: 1, active: 1 },
  });
  assert.match(applied, /全部 tab/);
  assert.match(applied, /结论 confirmed（显式）/);
  assert.match(applied, /候选 5 条：已和解 3 条，跳过 2 条/);
  assert.match(applied, /受保护/);
  assert.match(applied, /仍在执行（active，不能和解）：1 条/);
  assert.match(applied, /按 tab：tab7=2, tab8=1/);
  assert.match(applied, /剩余 pending 2/);

  assert.match(renderLedgerReconcile({ ok: false, error: 'E_BAD_ARG', message: 'ledger reconcile 需要 tabId 或 all=true' }), /和解失败：ledger reconcile 需要 tabId 或 all=true/);
});

test('renderTransferStatus：配额行/会话表/传输表/截断提示', () => {
  const empty = renderTransferStatus({
    quota: { maxConcurrent: 16, maxTotalBytes: 512, usagePercent: 0, slotsPercent: 0, maxPerSession: 8, maxSessionBytes: 256, idleTtlMs: 600_000, finishedTtlMs: 600_000 },
    counts: { total: 0, active: 0, finished: 0, uploads: 0, downloads: 0 },
    bytes: { reserved: 0, received: 0 },
    sessions: [],
    transfers: [],
  });
  assert.match(empty, /传输配额：并发 0\/16（0%）/);
  assert.match(empty, /单会话上限 8 个/);
  assert.match(empty, /没有进行中\/暂存的传输/);

  const table = renderTransferStatus({
    quota: { maxConcurrent: 16, maxTotalBytes: 1024 * 1024, usagePercent: 12.5, slotsPercent: 6.3, maxPerSession: 8, maxSessionBytes: 256, idleTtlMs: 600_000, finishedTtlMs: 600_000 },
    counts: { total: 2, active: 1, finished: 1, uploads: 1, downloads: 1 },
    bytes: { reserved: 2 * 1024 * 1024, received: 1024 },
    counters: { quotaRejected: 2, checksumFailed: 1, sweepRemoved: 3 },
    sessions: [{ sessionId: 's1', active: 1, reservedBytes: 2048, receivedBytes: 1024 }],
    transfers: [
      { transferId: 'tr_aaaaaaaaaaaaaaaa', sessionId: 's1', name: 'report.pdf', direction: 'upload', percent: 25, received: 512, byteSize: 2048, idleMs: 1200, finished: false, verified: false },
      { transferId: 'tr_bbbbbbbbbbbbbbbb', sessionId: 's2', name: 'video.webm', direction: 'download', percent: 100, received: 1024, byteSize: 1024, idleMs: 0, finished: true, verified: true },
    ],
    truncated: true,
  });
  assert.match(table, /配额拒绝 2/);
  assert.match(table, /校验失败 1/);
  assert.match(table, /清理 3/);
  assert.match(table, /tr_aaaaaaaaaaaaaaaa/);
  assert.match(table, /report\.pdf/);
  assert.match(table, /25%/);
  assert.match(table, /finished\/verified/);
  assert.match(table, /列表已截断/);
});

test('renderQueueStatus：总量/公平性/会话表/tab 表/拒绝原因', () => {
  const empty = renderQueueStatus({
    capacity: 64,
    limits: { maxInflight: 64, maxInflightPerSession: 8, maxPendingPerSession: 64 },
    totals: { dispatch: 0, completed: 0, failed: 0, rejected: 0, pending: 0 },
    inflight: { current: 0, limit: 64, peak: 0 },
    fairness: { strategy: 'round-robin-per-tab', jainIndex: null, maxConsecutive: 0, longestQueuedMs: 0, tabs: [] },
    rejects: { total: 0, byReason: {} },
    sessions: [],
  });
  assert.match(empty, /命令队列：容量 64/);
  assert.match(empty, /公平性：round-robin-per-tab，Jain -/);
  assert.match(empty, /还没有命令进入队列/);

  const busy = renderQueueStatus({
    capacity: 64,
    limits: { maxInflight: 64, maxInflightPerSession: 8, maxPendingPerSession: 64 },
    totals: { dispatch: 10, completed: 7, failed: 1, rejected: 2, pending: 3 },
    inflight: { current: 2, limit: 64, peak: 5 },
    fairness: {
      strategy: 'round-robin-per-tab',
      jainIndex: 0.83,
      maxConsecutive: 2,
      longestQueuedMs: 1500,
      tabs: [{ tabKey: 'tab:7', holder: 's1', queued: 2, served: 5, maxConsecutive: 2, longestQueuedMs: 1500, fairness: 0.9 }],
    },
    rejects: { total: 2, byReason: { 'session-pending': 1, 'session-inflight': 1 } },
    sessions: [
      {
        sessionId: 's1', pending: 2, inflight: 1, completed: 4, completedSharePercent: 57.1, rejected: 1,
        wait: { p50Ms: 12, p95Ms: 90 }, tabWait: { p95Ms: 30 },
        lastReject: { code: 'E_QUEUE_FULL', reason: 'session-pending', method: 'click', at: 1_700_000_000_000 },
      },
    ],
  });
  assert.match(busy, /排队 3，执行中 2\/64（峰值 5）/);
  assert.match(busy, /拒绝原因：session-pending=1, session-inflight=1/);
  assert.match(busy, /tab 调度/);
  assert.match(busy, /tab:7/);
  assert.match(busy, /最近拒绝/);
  assert.match(busy, /E_QUEUE_FULL  session-pending  click/);
});

test('renderDoctorReport / doctorExitCode / doctorAreaSummary：状态标签与退出码一致', () => {
  const report = {
    at: '2026-11-26T02:00:00.000Z',
    status: 'warn',
    checks: [
      { id: 'ledger.pending', area: 'ledger', status: 'warn', detail: '待确认 1 条' },
      { id: 'queue.fairness', area: 'queue', status: 'ok', detail: '最长连续 1' },
    ],
    summary: { total: 2, ok: 1, warn: 1, fail: 0 },
  };
  const text = renderDoctorReport(report);
  assert.match(text, /daemon 自检：warn（检查 2 项，ok 1，warn 1，fail 0）/);
  assert.match(text, /\[warn\] ledger\.pending/);
  assert.match(text, /\[ok\]   queue\.fairness/);
  assert.equal(doctorExitCode(report), 0);
  assert.equal(doctorExitCode({ status: 'ok' }), 0);
  assert.equal(doctorExitCode({ status: 'fail' }), 1);
  assert.equal(doctorExitCode(null), 0);

  const area = doctorAreaSummary(report, 'ledger');
  assert.equal(area.status, 'warn');
  assert.equal(area.checks.length, 1);
  assert.match(area.detail, /待确认 1 条/);
  assert.equal(doctorAreaSummary(report, 'transfer').status, 'ok');
  assert.equal(doctorAreaSummary({ status: 'fail', checks: [{ area: 'queue', status: 'fail', detail: 'x' }] }, 'queue').status, 'fail');
});

test('渲染函数对残缺 daemon 返回结构容错（不抛错）', () => {
  assert.doesNotThrow(() => renderLedgerStatus({}));
  assert.doesNotThrow(() => renderLedgerSnapshot({}));
  assert.doesNotThrow(() => renderTransferStatus({}));
  assert.doesNotThrow(() => renderQueueStatus({}));
  assert.doesNotThrow(() => renderDoctorReport({}));
  assert.equal(renderLedgerSnapshot({}).startsWith('账本'), true, '没有 snapshot 时退回账本状态渲染');
});
