// tests/unit/cli-diagnostic-summary.test.mjs —— `bridge debug` / `bridge trace` 的结论化摘要
// （cli/lib/diagnostic-summary.mjs）。既测纯归一，也用真实 lib（journal/analysis/evidence/
// perf-insights/trace-summary）跑一遍集成路径，确保摘要在真实数据形状上成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIAGNOSTIC_SEVERITY,
  classifyGap,
  formatDebugAnalyzeLines,
  formatDebugArchiveLines,
  formatDebugArchivesLines,
  formatDebugCoverageLines,
  formatDebugEvidenceLines,
  formatDebugHistoryLines,
  formatDebugJournalLines,
  formatDebugPerformanceLines,
  formatDebugRequestsLines,
  formatDebugStatusLines,
  formatDebugStopLines,
  formatTraceDiffLines,
  formatTraceStatusLines,
  formatTraceStopLines,
  formatTraceSummaryLines,
  summarizeDebugAnalyze,
  summarizeDebugArchive,
  summarizeDebugArchives,
  summarizeDebugCorrelation,
  summarizeDebugCoverage,
  summarizeDebugEvidence,
  summarizeDebugHistory,
  summarizeDebugJournal,
  summarizeDebugJournalExport,
  summarizeDebugJournalResult,
  summarizeDebugRequests,
  summarizeDebugStatus,
  summarizeDebugStop,
  summarizePerformanceInsights,
  summarizeTraceDiff,
  summarizeTraceReport,
  summarizeTraceStatus,
  summarizeTraceStop,
  verdictOf,
} from '../../cli/lib/diagnostic-summary.mjs';
import { buildDebugJournal } from '../../lib/debug-journal.mjs';
import { analyzeDebugCapture } from '../../lib/debug-analysis.mjs';
import { buildDebugEvidence } from '../../lib/debug-evidence.mjs';
import { analyzePerformance } from '../../lib/perf-insights.mjs';
import { summarizeTrace, diffTraceSummary } from '../../lib/trace-summary.mjs';

function captureSnapshot() {
  return {
    active: true,
    url: 'https://example.test/checkout',
    title: 'Checkout',
    startedAt: 1_760_000_000_000,
    requests: [
      { id: 1, method: 'GET', url: 'https://example.test/api/cart', status: 200, type: 'Fetch', startedAt: 1_760_000_000_100, durationMs: 40, commandId: 'cmd-1' },
      { id: 2, method: 'POST', url: 'https://example.test/api/order', status: 500, type: 'Fetch', startedAt: 1_760_000_000_200, durationMs: 700, commandId: 'cmd-1' },
      { id: 3, method: 'GET', url: 'https://example.test/api/cart', status: null, type: 'XHR', startedAt: 1_760_000_000_300, durationMs: 0, error: 'net::ERR_ABORTED' },
    ],
    console: [{ level: 'error', text: 'boom', at: 1_760_000_000_250 }],
    journal: [{ type: 'start', at: 1_760_000_000_050, ok: true }],
    context: { url: 'https://example.test/checkout', title: 'Checkout' },
  };
}

function coverageFixture() {
  return {
    version: 1,
    generatedAt: '2026-11-25T00:00:00.000Z',
    coverage: {
      version: 1,
      phases: {
        session: { subscribed: true, observed: true, count: 1 },
        network: { subscribed: true, observed: true, count: 3 },
        console: { subscribed: true, observed: true, count: 1 },
        trace: { subscribed: false, observed: false, count: 0 },
        journal: { subscribed: true, observed: true, count: 1 },
      },
      counts: { requests: { observed: 3, total: 5 } },
      score: { phase: 0.8, request: 0.6, console: 1, journal: 1, overall: 0.82 },
      complete: false,
      subscribedPhases: ['session', 'network', 'console', 'journal'],
      observedPhases: ['session', 'network', 'console', 'journal'],
    },
    gaps: [
      { kind: 'trace-subscription', phase: 'trace', reason: 'tracing-not-started', category: 'not-subscribed' },
      { kind: 'request-limit', phase: 'network', reason: 'max-requests', category: 'limit', count: 2 },
      { kind: 'request-pending', phase: 'network', reason: 'pending', category: 'incomplete', count: 1 },
    ],
    complete: false,
  };
}

// ---------------------------------------------------------------------------
// 基础：verdict 排序 / 缺口词表单源
// ---------------------------------------------------------------------------

test('verdictOf：取最高严重度，空列表是 ok', () => {
  assert.deepEqual(verdictOf([]), { code: 'ok', severity: 'ok', label: '无异常' });
  const verdict = verdictOf([
    { code: 'a', severity: 'notice', label: '提示' },
    { code: 'b', severity: 'error', label: '错误' },
    { code: 'c', severity: 'warn', label: '警告' },
  ]);
  assert.equal(verdict.code, 'b');
  assert.equal(verdict.severity, DIAGNOSTIC_SEVERITY.ERROR);
});

test('classifyGap 复用扩展侧 reason→category 词表', () => {
  assert.equal(classifyGap('max-requests'), 'limit');
  assert.equal(classifyGap('pending'), 'incomplete');
  assert.equal(classifyGap('not-subscribed'), 'not-subscribed');
  assert.equal(classifyGap('全新未知原因'), 'unsupported');
});

// ---------------------------------------------------------------------------
// 调试：覆盖率
// ---------------------------------------------------------------------------

test('summarizeDebugCoverage：缺口按根因聚合 + 分数/阶段', () => {
  const summary = summarizeDebugCoverage(coverageFixture());
  assert.equal(summary.complete, false);
  assert.equal(summary.gaps, 3);
  assert.deepEqual(summary.categories, { 'not-subscribed': 1, limit: 1, incomplete: 1 });
  assert.equal(summary.score.overall, 0.82);
  assert.equal(summary.phases.total, 5);
  assert.deepEqual(summary.phases.observed.length, 4);
  assert.equal(summary.counts.requests, 3);
  assert.ok(summary.categoryLabels.some((item) => item.label.includes('超限截断')));
});

test('summarizeDebugCoverage：旧形状（无 coverage.phases）也安全', () => {
  const summary = summarizeDebugCoverage({ requests: { total: 2 }, console: { total: 1 }, gaps: [], complete: true });
  assert.equal(summary.complete, true);
  assert.equal(summary.gaps, 0);
  assert.deepEqual(summary.categories, {});
  assert.deepEqual(summary.phases, { total: 0, observed: [], subscribed: [] });
});

test('summarizeDebugCoverage：直接从 gaps 推断分类（无 category 字段）', () => {
  const summary = summarizeDebugCoverage({ gaps: [{ kind: 'x', reason: 'buffer-overflow' }, { kind: 'y', reason: 'failed' }] });
  assert.deepEqual(summary.categories, { dropped: 1, failed: 1 });
});

// ---------------------------------------------------------------------------
// 调试：journal / correlation / export
// ---------------------------------------------------------------------------

test('summarizeDebugRequests：匹配/总数/状态分布/失败与 pending 结论', () => {
  const all = [
    { id: 1, method: 'GET', url: 'https://x/a', status: 200 },
    { id: 2, method: 'POST', url: 'https://x/b', status: 500 },
    { id: 3, method: 'GET', url: 'https://x/a', status: null },
    { id: 4, method: 'GET', url: 'https://x/c', status: 404 },
  ];
  const summary = summarizeDebugRequests(all, all.slice(0, 2), { limit: 2 });
  assert.equal(summary.total, 4);
  assert.equal(summary.matched, 2);
  assert.equal(summary.truncated, true);
  assert.equal(summary.limit, 2);
  assert.equal(summary.byStatus['500'], 1);
  assert.equal(summary.byMethod.POST, 1);
  assert.ok(summary.findings.some((item) => item.code === 'requests-failed'));
  assert.equal(summary.verdict.severity, DIAGNOSTIC_SEVERITY.WARN);

  const empty = summarizeDebugRequests([], [], {});
  assert.equal(empty.matched, 0);
  assert.ok(empty.findings.some((item) => item.code === 'requests-empty'));
  assert.ok(empty.nextSteps[0].includes('去掉 --filter'));
});

test('summarizeDebugRequests：pending 只提示不升级为 error', () => {
  const pending = summarizeDebugRequests([{ id: 1, method: 'GET', status: null }], [{ id: 1, method: 'GET', status: null }], {});
  assert.ok(pending.findings.some((item) => item.code === 'requests-pending'));
  assert.equal(pending.verdict.severity, DIAGNOSTIC_SEVERITY.NOTICE);
});

test('summarizeDebugJournal：真实 buildDebugJournal 输出（计数/截断/跨度）', () => {
  const journal = buildDebugJournal(captureSnapshot(), { operations: [{ ts: 1_760_000_000_150, id: 'op1', method: 'click', ok: true, durationMs: 20 }], limit: 2 });
  const summary = summarizeDebugJournal(journal);
  assert.equal(summary.total, 6);
  assert.deepEqual(summary.counts, { total: 6, debug: 1, operation: 1, request: 3, console: 1 });
  assert.equal(summary.truncated, true);
  assert.equal(summary.evictions, 0);
  assert.ok(summary.spanMs > 0);
});

test('summarizeDebugJournal：兼容 store 快照（count/byType/timeRange/evictions）', () => {
  const summary = summarizeDebugJournal({
    count: 7,
    byType: { start: 2, stop: 1, rule_add: 4 },
    evictions: { total: 3, counts: { buffer: 3 } },
    timeRange: { from: 1000, to: 5000 },
    bytes: 1024,
    seq: 12,
  });
  assert.equal(summary.total, 7);
  assert.equal(summary.counts.debug, 7);
  assert.equal(summary.evictions, 3);
  assert.equal(summary.spanMs, 4000);
  assert.equal(summary.bytes, 1024);
  assert.equal(summary.seq, 12);
});

test('summarizeDebugCorrelation：链接覆盖字段保留', () => {
  const summary = summarizeDebugCorrelation({
    timeAligned: true,
    requests: 3,
    linked: 2,
    unlinked: 1,
    traceEvents: 9,
    orphanTraceEvents: 4,
    screenshots: 1,
    linkedScreenshots: 1,
    journalEvents: 5,
    byMethod: { GET: 2, POST: 1 },
    byStatus: { '200': 2, '500': 1 },
    slowest: [{ id: 2 }],
  });
  assert.equal(summary.timeAligned, true);
  assert.equal(summary.linked, 2);
  assert.equal(summary.orphanTraceEvents, 4);
  assert.deepEqual(summary.byMethod, { GET: 2, POST: 1 });
});

test('summarizeDebugJournalExport：校验状态显式（verified/verifyReason）', () => {
  const summary = summarizeDebugJournalExport({ events: 6, requests: 3, gaps: 2, bytes: 900, verified: false, verifyReason: 'digest-mismatch', digest: 'ab'.repeat(32) });
  assert.equal(summary.verified, false);
  assert.equal(summary.verifyReason, 'digest-mismatch');
  assert.equal(summary.events, 6);

  const empty = summarizeDebugJournalExport(null);
  assert.equal(empty.verified, false);
  assert.equal(empty.bytes, null);
});

// ---------------------------------------------------------------------------
// 调试：stop / status / history
// ---------------------------------------------------------------------------

test('summarizeDebugStop：缺口/journal 校验/关联结论齐全', () => {
  const result = {
    ok: true,
    id: 'dbg-1',
    requests: 3,
    console: 1,
    ...coverageFixture(),
    correlation: { timeAligned: true, requests: 3, linked: 0, unlinked: 3, traceEvents: 0, orphanTraceEvents: 0, screenshots: 0, linkedScreenshots: 0, journalEvents: 4, byMethod: {}, byStatus: {}, slowest: [] },
    journalExport: { events: 6, requests: 3, gaps: 3, bytes: 900, verified: false, verifyReason: 'digest-mismatch' },
    record: { journalSummary: { count: 4, byType: { start: 1, stop: 1 }, evictions: { total: 2 } } },
  };
  const summary = summarizeDebugStop(result);
  assert.equal(summary.id, 'dbg-1');
  assert.equal(summary.requests, 3);
  assert.equal(summary.console, 1);
  assert.equal(summary.coverage.gaps, 3);
  assert.equal(summary.journal.evictions, 2);
  assert.equal(summary.journal.total, 4);
  assert.ok(summary.findings.some((item) => item.code === 'correlation-unlinked'));
  assert.ok(summary.findings.some((item) => item.code === 'journal-export-unverified'));
  assert.ok(summary.findings.some((item) => item.code === 'journal-evicted'));
  assert.equal(summary.verdict.severity, DIAGNOSTIC_SEVERITY.WARN);
  assert.ok(summary.nextSteps.some((step) => step.includes('bridge debug archive')));
});

test('summarizeDebugStop：空采集不报假 warn', () => {
  const summary = summarizeDebugStop({ ok: true, requests: 0, console: 0, gaps: [], complete: true });
  assert.equal(summary.requests, 0);
  assert.ok(summary.findings.some((item) => item.code === 'empty-capture'));
  assert.equal(summary.verdict.severity, DIAGNOSTIC_SEVERITY.NOTICE);
});

test('summarizeDebugStatus：采集中摘要含规模/journal/覆盖结论', () => {
  const snapshot = captureSnapshot();
  const journal = buildDebugJournal(snapshot, { operations: [], limit: 10 });
  const result = {
    ...snapshot,
    journalSummary: journal,
    coverage: coverageFixture().coverage,
    gaps: coverageFixture().gaps,
    complete: false,
    correlation: { requests: 3, linked: 2, unlinked: 1, traceEvents: 0, orphanTraceEvents: 0, screenshots: 0, linkedScreenshots: 0, journalEvents: 1, byMethod: {}, byStatus: {}, slowest: [] },
    websockets: [],
    frames: [{ frameId: 1 }],
    screenshots: [],
  };
  const summary = summarizeDebugStatus(result);
  assert.equal(summary.active, true);
  assert.equal(summary.requests, 3);
  assert.equal(summary.console, 1);
  assert.equal(summary.frames, 1);
  assert.equal(summary.journal.total, 5);
  assert.equal(summary.coverage.gaps, 3);
  assert.ok(summary.nextSteps.some((step) => step.includes('bridge debug stop')));
});

test('summarizeDebugHistory：有/无历史两种下一步', () => {
  const withHistory = summarizeDebugHistory([{ id: 'abcdef123456', name: 'old', requests: 4, console: 1 }]);
  assert.equal(withHistory.available, 1);
  assert.equal(withHistory.latest.id, 'abcdef123456');
  assert.ok(withHistory.nextSteps.some((step) => step.includes('bridge debug start')));

  const empty = summarizeDebugHistory([]);
  assert.equal(empty.latest, null);
  assert.ok(empty.nextSteps[0].includes('bridge debug start'));
});

// ---------------------------------------------------------------------------
// 调试：analyze / evidence / archives / performance（真实 lib 集成）
// ---------------------------------------------------------------------------

test('summarizeDebugAnalyze：真实 analyzeDebugCapture 输出 → 失败/重复/慢/pending 结论', () => {
  const analysis = analyzeDebugCapture(captureSnapshot(), { slowMs: 500 });
  const summary = summarizeDebugAnalyze(analysis);
  assert.equal(summary.counts.requests, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.slow, 1);
  assert.equal(summary.status.pending, 1);
  assert.ok(summary.findings.some((item) => item.code === 'http-errors'));
  assert.ok(summary.findings.some((item) => item.code === 'duplicate-urls'));
  assert.ok(summary.nextSteps.some((step) => step.includes('bridge debug request')));
});

test('summarizeDebugAnalyze：干净采集给出 analysis-ok', () => {
  const analysis = analyzeDebugCapture({ requests: [{ id: 1, method: 'GET', url: 'https://x/y', status: 200, type: 'Fetch', durationMs: 5 }] });
  const summary = summarizeDebugAnalyze(analysis);
  assert.equal(summary.verdict.severity, DIAGNOSTIC_SEVERITY.OK);
  assert.equal(summary.findings[0].code, 'analysis-ok');
});

test('summarizeDebugEvidence：真实 buildDebugEvidence 输出 → sha256 完整性', () => {
  const evidence = buildDebugEvidence(captureSnapshot(), { session: 's1', operations: [{ id: 'op1', method: 'click', ts: 1_760_000_000_150, ok: true, commandId: 'cmd-1' }] });
  const summary = summarizeDebugEvidence(evidence);
  assert.equal(summary.counts.requests, 3);
  assert.equal(summary.counts.console, 1);
  assert.equal(summary.counts.operations, 1);
  assert.equal(summary.integrity.complete, true);
  assert.equal(summary.integrity.requestsSha256.length, 16);
  assert.equal(summary.verdict.severity, DIAGNOSTIC_SEVERITY.OK);

  const broken = summarizeDebugEvidence({ counts: { requests: 0, console: 0 }, operations: [], integrity: {} });
  assert.equal(broken.integrity.complete, false);
  assert.ok(broken.findings.some((item) => item.code === 'integrity-missing'));
});

test('summarizeDebugArchives：数量/字节/不完整归档', () => {
  const summary = summarizeDebugArchives([
    { id: 'a', requests: 3, bytes: 100, complete: true },
    { id: 'b', requests: 2, bytes: 50, complete: false },
  ], { total: 2, live: 1, requests: 5, bytes: 150 });
  assert.equal(summary.total, 2);
  assert.equal(summary.live, 1);
  assert.equal(summary.incomplete, 1);
  assert.equal(summary.requests, 5);
  assert.ok(summary.findings.some((item) => item.code === 'archives-incomplete'));
  assert.ok(summary.nextSteps.some((step) => step.includes('bridge debug query --dir')));
});

test('summarizeDebugArchive：预算截断与 gaps 进 findings', () => {
  const summary = summarizeDebugArchive({
    id: 'arch-1',
    createdAt: '2026-11-25T00:00:00.000Z',
    summary: { requests: 2, console: 1, journal: 3, bytes: 900 },
    coverage: { complete: false, budget: { maxRequests: 2, maxConsole: 1, maxBytes: 1000 }, kept: { requests: 2, console: 1 }, dropped: { requests: 5, console: 2 } },
    gaps: [{ kind: 'request-limit', reason: 'max-requests', category: 'limit' }],
  });
  assert.equal(summary.id, 'arch-1');
  assert.equal(summary.requests, 2);
  assert.equal(summary.complete, false);
  assert.ok(summary.findings.some((item) => item.code === 'archive-trimmed'));
  assert.ok(summary.findings.some((item) => item.code === 'archive-gap-limit'));
  assert.equal(summary.verdict.severity, DIAGNOSTIC_SEVERITY.WARN);
});

test('summarizePerformanceInsights：真实 analyzePerformance 输出 → 长任务/首屏结论', () => {
  const insights = analyzePerformance({ ttfb: 1200, domContentLoaded: 2500, load: 4000, lcp: 3000, cls: 0.2, longTasks: { count: 6, maxMs: 300 }, resources: { count: 200, transferBytes: 3 * 1024 * 1024 } });
  const summary = summarizePerformanceInsights(insights);
  assert.equal(summary.warnings, 6);
  assert.ok(summary.findings.some((item) => item.code === 'perf-LONG_TASK'));
  assert.ok(summary.nextSteps.some((step) => step.includes('bridge trace start')));
  assert.ok(summary.nextSteps.some((step) => step.includes('bridge debug aggregate')));

  const healthy = summarizePerformanceInsights(analyzePerformance({ ttfb: 100, load: 500 }));
  assert.equal(healthy.verdict.severity, DIAGNOSTIC_SEVERITY.OK);
});

// ---------------------------------------------------------------------------
// Trace：状态 / 停止
// ---------------------------------------------------------------------------

test('summarizeTraceStatus：录制中给出事件数与时长，未开始给下一步', () => {
  const tracing = summarizeTraceStatus({ tabId: 12, tracing: true, events: 0, categories: 'devtools.timeline', startedAt: 1000 }, { now: 3500 });
  assert.equal(tracing.tracing, true);
  assert.equal(tracing.elapsedMs, 2500);
  assert.ok(tracing.findings.some((item) => item.code === 'no-events-yet'));
  assert.ok(tracing.nextSteps.some((step) => step.includes('bridge trace stop')));

  const idle = summarizeTraceStatus({ tabId: 12, tracing: false, events: 0 });
  assert.equal(idle.elapsedMs, null);
  assert.ok(idle.nextSteps.some((step) => step.includes('bridge trace start')));
});

test('summarizeTraceStop：扩展 summary 归一 + 空事件/事件倾斜/空 payload 结论', () => {
  const summary = summarizeTraceStop({
    ok: true,
    tabId: 12,
    events: 120,
    durationMs: 800,
    summary: {
      events: 120,
      spanMs: 700,
      categories: [{ category: 'devtools.timeline', count: 100 }, { category: 'v8.execute', count: 20 }],
      topNames: [{ name: 'FunctionCall', count: 90 }],
    },
    trace: '{"traceEvents":[]}',
  });
  assert.equal(summary.events, 120);
  assert.equal(summary.spanMs, 700);
  assert.equal(summary.categories[0].key, 'devtools.timeline');
  assert.equal(summary.topNames[0].key, 'FunctionCall');
  assert.ok(summary.findings.some((item) => item.code === 'event-skew'));
  assert.ok(summary.nextSteps.some((step) => step.includes('bridge trace summary')));

  const empty = summarizeTraceStop({ ok: true, events: 0, durationMs: 5, summary: {}, trace: '' });
  assert.ok(empty.findings.some((item) => item.code === 'no-events'));
  assert.ok(empty.findings.some((item) => item.code === 'trace-empty-payload'));
  assert.equal(empty.verdict.severity, DIAGNOSTIC_SEVERITY.WARN);
});

// ---------------------------------------------------------------------------
// Trace：summary / diff（真实 lib 集成）
// ---------------------------------------------------------------------------

function perfTrace(overrides = {}) {
  return {
    traceEvents: [
      { ph: 'X', name: 'Task', cat: 'toplevel', pid: 1, tid: 1, ts: 1_000_000, dur: 300_000 },
      { ph: 'X', name: 'FunctionCall', cat: 'v8.execute', pid: 1, tid: 1, ts: 1_010_000, dur: 120_000 },
      { ph: 'X', name: 'Paint', cat: 'devtools.timeline', pid: 1, tid: 1, ts: 1_100_000, dur: 20_000 },
      { ph: 'b', name: 'AsyncTask', cat: 'devtools.timeline', pid: 1, tid: 1, ts: 1_200_000, dur: 10_000, id: 'a1' },
    ],
    ...overrides,
  };
}

test('summarizeTraceReport：真实 summarizeTrace 输出 → span/阶段/关键路径占比', () => {
  const summary = summarizeTrace(perfTrace(), { top: 20 });
  const report = summarizeTraceReport(summary);
  assert.equal(report.events, 4);
  assert.equal(report.durationMs, 200);
  assert.equal(report.spans.total, 4);
  assert.ok(report.spans.topPhases.length >= 2);
  assert.ok(report.spans.topPhases.some((item) => item.label === '完整事件'));
  assert.ok(report.spans.topPhases.some((item) => item.label === '异步开始'));
  assert.equal(report.spans.criticalPath.metric, 'self');
  assert.ok(report.spans.criticalPath.totalMs > 0);
  assert.equal(report.spans.criticalPath.share > 0, true);
  assert.equal(report.longTaskCount, 2);
  assert.equal(report.longestTaskMs, 300);
  assert.ok(report.findings.some((item) => item.code === 'long-tasks'));
});

test('summarizeTraceReport：空 trace 给 no-events，且不伪造 span', () => {
  const report = summarizeTraceReport(summarizeTrace({ traceEvents: [] }));
  assert.equal(report.events, 0);
  assert.equal(report.spans, null);
  assert.equal(report.findings[0].code, 'no-events');
  assert.equal(report.verdict.severity, DIAGNOSTIC_SEVERITY.NOTICE);
});

test('summarizeTraceReport：容忍残缺 spanSummary（不抛异常）', () => {
  const report = summarizeTraceReport({
    events: 10,
    durationMs: 100,
    spanSummary: { spans: 2, roots: 2, unfinished: 1, truncated: true, dropped: 3, byPhase: [{ key: 'X', count: 2, selfMs: 5 }], frames: [], criticalPath: { totalMs: 80, spanCount: 2, metric: 'self' } },
  });
  assert.ok(report.findings.some((item) => item.code === 'incomplete-capture'));
  assert.equal(report.spans.truncated, true);
  assert.equal(report.spans.criticalPath.share, 0.8);
});

test('summarizeTraceDiff：真实 diffTraceSummary 输出 → 时长回归/长任务增加', () => {
  const base = summarizeTrace(perfTrace());
  const head = summarizeTrace({
    traceEvents: [
      ...perfTrace().traceEvents,
      { ph: 'X', name: 'FunctionCall', cat: 'v8.execute', pid: 1, tid: 1, ts: 1_250_000, dur: 400_000 },
    ],
  });
  const diff = diffTraceSummary(base, head);
  const summary = summarizeTraceDiff(diff);
  assert.equal(summary.events.delta, 1);
  assert.ok(summary.durationMs.delta > 0);
  assert.ok(summary.findings.some((item) => item.code === 'duration-regression'));
  assert.ok(summary.findings.some((item) => item.code === 'more-long-tasks'));
  assert.ok(summary.nextSteps.some((step) => step.includes('bridge trace view')));
});

test('summarizeTraceDiff：无变化给 notice，改善给出 OK 级 finding', () => {
  const same = summarizeTraceDiff({ events: { base: 5, head: 5, delta: 0 }, durationMs: { base: 100, head: 100, delta: 0 }, longTaskCount: { base: 0, head: 0, delta: 0 } });
  assert.equal(same.findings[0].code, 'no-change');

  const faster = summarizeTraceDiff({ events: { base: 10, head: 8, delta: -2 }, durationMs: { base: 1000, head: 600, delta: -400 }, longTaskCount: { base: 2, head: 0, delta: -2 } });
  assert.ok(faster.findings.some((item) => item.code === 'duration-improvement'));
  assert.equal(faster.verdict.severity, DIAGNOSTIC_SEVERITY.OK);
});

// ---------------------------------------------------------------------------
// 文本格式化
// ---------------------------------------------------------------------------

test('formatDebug*Lines：结论/发现/下一步都在文本里', () => {
  const coverageText = formatDebugCoverageLines(coverageFixture()).join('\n');
  assert.match(coverageText, /覆盖摘要：complete=false（缺口 3 条），综合分 0.82/);
  assert.match(coverageText, /缺口分类：/);
  assert.match(coverageText, /阶段：观测 4\/5/);

  const stopText = formatDebugStopLines({ ok: true, requests: 1, console: 1, gaps: [], complete: true, correlation: { requests: 1, linked: 1 } }).join('\n');
  assert.match(stopText, /采集摘要：/);
  assert.match(stopText, /记录：请求 1 \/ 控制台 1/);

  const statusText = formatDebugStatusLines({ ...captureSnapshot(), gaps: [], complete: true }).join('\n');
  assert.match(statusText, /采集摘要：/);
  assert.match(statusText, /规模：请求 3 \/ 控制台 1/);

  const historyText = formatDebugHistoryLines([{ id: 'abcdef123456', name: 'old', requests: 2 }]).join('\n');
  assert.match(historyText, /历史摘要：1 条/);
  assert.match(historyText, /abcdef12\(old\)/);

  const analyzeText = formatDebugAnalyzeLines(analyzeDebugCapture(captureSnapshot())).join('\n');
  assert.match(analyzeText, /分析结论：/);
  assert.match(analyzeText, /发现：/);

  const evidenceText = formatDebugEvidenceLines(buildDebugEvidence(captureSnapshot())).join('\n');
  assert.match(evidenceText, /证据摘要：/);
  assert.match(evidenceText, /sha256 齐全/);

  const archivesText = formatDebugArchivesLines([{ id: 'a', requests: 1, bytes: 10, complete: true }], { total: 1, bytes: 10 }).join('\n');
  assert.match(archivesText, /归档摘要：1 份/);

  const perfText = formatDebugPerformanceLines(analyzePerformance({ ttfb: 1200 })).join('\n');
  assert.match(perfText, /性能结论：/);

  const journalText = formatDebugJournalLines(buildDebugJournal(captureSnapshot(), { operations: [], limit: 3 })).join('\n');
  assert.match(journalText, /journal 摘要：/);
  assert.match(journalText, /事件 5/);

  const requestsText = formatDebugRequestsLines(summarizeDebugRequests([{ id: 1, status: 500, method: 'POST' }], [{ id: 1, status: 500, method: 'POST' }], { limit: 10 })).join('\n');
  assert.match(requestsText, /请求摘要：匹配 1 \/ 共 1/);
  assert.match(requestsText, /状态：500×1/);

  const archiveBuildText = formatDebugArchiveLines({ id: 'a', summary: { requests: 1, console: 0, journal: 0, bytes: 10 }, coverage: { complete: true } }).join('\n');
  assert.match(archiveBuildText, /归档摘要：/);
  assert.match(archiveBuildText, /规模：请求 1/);
});

test('formatTrace*Lines：结论/阶段/关键路径/下一步都在文本里', () => {
  const statusText = formatTraceStatusLines({ tracing: true, events: 10, startedAt: Date.now() - 100 }).join('\n');
  assert.match(statusText, /trace 摘要：/);
  assert.match(statusText, /录制中：10 事件/);

  const stopText = formatTraceStopLines({ ok: true, events: 12, durationMs: 500, summary: { spanMs: 400, categories: [{ category: 'v8.execute', count: 12 }], topNames: [{ name: 'FunctionCall', count: 10 }] }, trace: '{}' }).join('\n');
  assert.match(stopText, /事件 12 \/ 录制 500ms \/ 跨度 400ms/);
  assert.match(stopText, /类别：v8.execute×12/);

  const summaryText = formatTraceSummaryLines(summarizeTrace(perfTrace())).join('\n');
  assert.match(summaryText, /trace 结论：/);
  assert.match(summaryText, /阶段分布：/);
  assert.match(summaryText, /关键路径：/);

  const diffText = formatTraceDiffLines(diffTraceSummary(summarizeTrace(perfTrace()), summarizeTrace(perfTrace()))).join('\n');
  assert.match(diffText, /差分结论：/);
});

test('summarizeDebugJournalResult：空/截断/驱逐给不同结论', () => {
  const empty = summarizeDebugJournalResult({ counts: { total: 0 }, events: [] });
  assert.ok(empty.findings.some((item) => item.code === 'journal-empty'));

  const truncated = summarizeDebugJournalResult({ counts: { total: 30, debug: 30, operation: 0, request: 0, console: 0 }, events: [], truncated: true, evictions: { total: 4 } });
  assert.ok(truncated.findings.some((item) => item.code === 'journal-truncated'));
  assert.ok(truncated.findings.some((item) => item.code === 'journal-evicted'));
  assert.equal(truncated.verdict.severity, DIAGNOSTIC_SEVERITY.WARN);
});
