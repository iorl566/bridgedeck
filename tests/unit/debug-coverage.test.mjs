// tests/unit/debug-coverage.test.mjs —— 抓取覆盖率与缺口报告的根因分类。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COVERAGE_PHASES,
  COVERAGE_VERSION,
  GAP_CATEGORIES,
  buildDebugCoverage,
  classifyGapReason,
  countTraceEvents,
  gapCountsByCategory,
  hasGapCategory,
  normalizeJournal,
  normalizeWebSockets,
  summarizeCoverage,
} from '../../extension/src/lib/debug-coverage.js';

function completeInput(overrides = {}) {
  return {
    session: { id: 'tab-1', tabId: 1, active: true, bodies: true, startedAt: 1_000 },
    requests: [{ requestId: 'req-1', id: 1, method: 'GET', url: '/api/a', status: 200, startedAt: 1_100, durationMs: 12 }],
    requestsTotal: 1,
    console: [{ level: 'log', text: 'hi', at: 1_105 }],
    consoleTotal: 1,
    frames: [{ frameId: 0, parentFrameId: -1, url: 'https://x.test/' }],
    frameTotal: 1,
    websockets: { sockets: [{ id: 1 }], total: 1 },
    trace: { traceEvents: [{ name: 'Task', ts: 1000 }] },
    screenshots: [{ id: 'shot-1', at: 1_150, kind: 'longshot' }],
    journal: {
      seq: 3,
      bytes: 200,
      events: [{ seq: 1, type: 'start', at: 1_000 }, { seq: 2, type: 'pin', at: 1_090 }],
      evictions: { total: 0, counts: {}, sessions: {}, recent: [] },
    },
    limits: { requests: 200, console: 200 },
    now: 2_000,
    ...overrides,
  };
}

test('全部订阅且无截断时 complete=true、score=1', () => {
  const report = buildDebugCoverage(completeInput());
  assert.equal(report.version, COVERAGE_VERSION);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.complete, true);
  assert.equal(report.coverage.complete, true);
  assert.equal(report.coverage.score.phase, 1);
  assert.equal(report.coverage.score.request, 1);
  assert.equal(report.coverage.score.console, 1);
  assert.equal(report.coverage.score.journal, 1);
  assert.equal(report.coverage.score.overall, 1);
  assert.deepEqual(report.coverage.observedPhases.sort(), [...COVERAGE_PHASES].sort());
  assert.equal(report.coverage.phases.network.subscribed, true);
  assert.equal(report.coverage.phases.network.observed, true);
  assert.equal(report.coverage.counts.requests.finished, 1);
  assert.equal(report.coverage.counts.requests.pending, 0);
  assert.equal(report.session.durationMs, 1_000);
});

test('未订阅类缺口：帧/websocket/trace/截图/journal/响应正文', () => {
  const report = buildDebugCoverage(completeInput({
    session: { id: 'tab-1', tabId: 1, active: true, bodies: false, startedAt: 1_000 },
    frames: null,
    websockets: null,
    trace: null,
    screenshots: null,
    journal: null,
  }));
  assert.equal(report.complete, false);
  const kinds = report.gaps.map((gap) => gap.kind).sort();
  assert.deepEqual(kinds, [
    'frames-subscription',
    'journal-subscription',
    'response-body',
    'screenshots-subscription',
    'trace-subscription',
    'websockets-subscription',
  ]);
  for (const gap of report.gaps) {
    assert.equal(gap.category, GAP_CATEGORIES.NOT_SUBSCRIBED, gap.kind + ' 分类应为未订阅');
    assert.equal(gap.phase.length > 0, true);
  }
  assert.equal(hasGapCategory(report, GAP_CATEGORIES.NOT_SUBSCRIBED), true);
  assert.equal(report.coverage.phases.frames.subscribed, false);
  assert.equal(report.coverage.phases.trace.observed, false);
  assert.equal(report.coverage.score.request, 1); // body 缺口不影响请求完成率
});

test('超限类缺口：requests/console 缓冲截断 + count 精确', () => {
  const report = buildDebugCoverage(completeInput({
    requests: Array.from({ length: 3 }, (_, index) => ({
      requestId: 'req-' + index,
      id: index + 1,
      method: 'GET',
      url: '/api/' + index,
      status: 200,
      startedAt: 1_100 + index,
    })),
    requestsTotal: 10,
    console: [{ level: 'log', text: 'a' }],
    consoleTotal: 7,
  }));
  const network = report.gaps.find((gap) => gap.kind === 'network-buffer');
  assert.ok(network);
  assert.equal(network.category, GAP_CATEGORIES.LIMIT);
  assert.equal(network.count, 7);
  assert.equal(network.detail.kept, 3);
  assert.equal(network.detail.total, 10);
  assert.equal(network.detail.limit, 200);

  const consoleGap = report.gaps.find((gap) => gap.kind === 'console-buffer');
  assert.ok(consoleGap);
  assert.equal(consoleGap.category, GAP_CATEGORIES.LIMIT);
  assert.equal(consoleGap.count, 6);
  assert.equal(report.coverage.phases.network.truncated, true);
  assert.equal(report.coverage.phases.console.truncated, true);
  assert.equal(report.coverage.score.request, 0.3);
});

test('失败/未完成类缺口：pending/failed/console 采集失败', () => {
  const report = buildDebugCoverage(completeInput({
    requests: [
      { requestId: 'req-1', id: 1, method: 'GET', url: '/ok', status: 200, startedAt: 1_100 },
      { requestId: 'req-2', id: 2, method: 'GET', url: '/pending', status: null, startedAt: 1_110 },
      { requestId: 'req-3', id: 3, method: 'POST', url: '/failed', status: 0, error: 'net::ERR_FAILED', startedAt: 1_120 },
      { requestId: 'req-4', id: 4, method: 'GET', url: '/404', status: 404, startedAt: 1_130 },
    ],
    requestsTotal: 4,
    consoleError: 'console hook not ready',
    frames: [
      { frameId: 0, parentFrameId: -1, url: 'https://x.test/' },
      { frameId: 7, parentFrameId: 0, url: 'https://frame.test/x', errorOccurred: true },
    ],
  }));
  const pending = report.gaps.find((gap) => gap.kind === 'request-pending');
  assert.ok(pending);
  assert.equal(pending.category, GAP_CATEGORIES.INCOMPLETE);
  assert.equal(pending.count, 1);
  const failed = report.gaps.find((gap) => gap.kind === 'request-failed');
  assert.ok(failed);
  assert.equal(failed.category, GAP_CATEGORIES.FAILED);
  assert.equal(failed.count, 1);
  const collect = report.gaps.find((gap) => gap.kind === 'console-collect');
  assert.ok(collect);
  assert.equal(collect.category, GAP_CATEGORIES.FAILED);
  assert.match(collect.detail.error, /hook/);
  const frameError = report.gaps.find((gap) => gap.kind === 'frames-error');
  assert.ok(frameError);
  assert.equal(frameError.category, GAP_CATEGORIES.FAILED);
  assert.equal(frameError.count, 1);
  assert.deepEqual(frameError.detail.frameIds, [7]);
  assert.equal(report.coverage.counts.frames.errors, 1);
  assert.equal(report.coverage.counts.requests.finished, 3);
  assert.equal(report.coverage.counts.requests.pending, 1);
  assert.equal(report.coverage.counts.requests.httpErrors, 1);
  assert.equal(hasGapCategory(report, GAP_CATEGORIES.INCOMPLETE), true);
  assert.equal(hasGapCategory(report, GAP_CATEGORIES.FAILED), true);
});

test('被丢弃类缺口：journal 环形缓冲淘汰计数与原因明细', () => {
  const report = buildDebugCoverage(completeInput({
    journal: {
      seq: 10,
      bytes: 2_000,
      events: [{ seq: 8, type: 'rule', at: 1_000 }, { seq: 10, type: 'stop', at: 1_100 }],
      evictions: {
        total: 8,
        counts: { 'session-ring-limit': 6, 'byte-budget': 2 },
        sessions: { 'tab-1': 8 },
        recent: [{ seq: 1, sessionId: 'tab-1', reason: 'session-ring-limit', at: 900 }],
      },
    },
  }));
  const gap = report.gaps.find((item) => item.kind === 'journal-eviction');
  assert.ok(gap);
  assert.equal(gap.category, GAP_CATEGORIES.DROPPED);
  assert.equal(gap.count, 8);
  assert.deepEqual(gap.detail.byReason, { 'session-ring-limit': 6, 'byte-budget': 2 });
  assert.equal(gap.detail.recent[0].reason, 'session-ring-limit');
  assert.equal(report.coverage.phases.journal.truncated, true);
  assert.equal(report.coverage.score.journal, 0.2);
});

test('空输入/未开始会话：明确 unsupported 之外的 not-subscribed 与 no-data', () => {
  const report = buildDebugCoverage({});
  assert.equal(report.complete, false);
  assert.equal(report.session.active, false);
  assert.ok(report.gaps.some((gap) => gap.kind === 'session-inactive' && gap.category === GAP_CATEGORIES.NOT_SUBSCRIBED));
  assert.equal(report.coverage.score.overall, null);
  assert.equal(report.coverage.observedPhases.length, 0);

  const emptyActive = buildDebugCoverage({
    session: { id: 'tab-1', tabId: 1, active: true, bodies: false, startedAt: 1_000 },
    requests: [],
    requestsTotal: 0,
    console: [],
    frames: [],
    websockets: { sockets: [], total: 0 },
    trace: [],
    screenshots: [],
    journal: { events: [], evictions: { total: 0, counts: {}, recent: [] } },
  });
  const kinds = emptyActive.gaps.map((gap) => gap.kind);
  assert.ok(kinds.includes('network-empty'));
  assert.ok(kinds.includes('frames-empty'));
  assert.ok(kinds.includes('trace-empty'));
  assert.ok(kinds.includes('response-body') === false); // 没有请求时不再报正文缺口
  assert.equal(emptyActive.gaps.find((gap) => gap.kind === 'network-empty').category, GAP_CATEGORIES.INCOMPLETE);
  assert.equal(emptyActive.gaps.find((gap) => gap.kind === 'frames-empty').category, GAP_CATEGORIES.INCOMPLETE);
});

test('classifyGapReason 词表映射与未知原因显式 unsupported', () => {
  assert.equal(classifyGapReason('limit'), GAP_CATEGORIES.LIMIT);
  assert.equal(classifyGapReason('bodies-not-enabled'), GAP_CATEGORIES.NOT_SUBSCRIBED);
  assert.equal(classifyGapReason('tracing-not-started'), GAP_CATEGORIES.NOT_SUBSCRIBED);
  assert.equal(classifyGapReason('buffer-overflow'), GAP_CATEGORIES.DROPPED);
  assert.equal(classifyGapReason('collect-failed'), GAP_CATEGORIES.FAILED);
  assert.equal(classifyGapReason('still-open'), GAP_CATEGORIES.INCOMPLETE);
  assert.equal(classifyGapReason('weird-new-reason'), GAP_CATEGORIES.UNSUPPORTED);
  assert.equal(classifyGapReason(null), GAP_CATEGORIES.UNSUPPORTED);
});

test('normalize 工具：journal/websocket/trace 三种入参形态', () => {
  const journalFromArray = normalizeJournal([{ type: 'start', at: 1 }]);
  assert.equal(journalFromArray.available, true);
  assert.equal(journalFromArray.events.length, 1);
  assert.equal(normalizeJournal(null).available, false);
  assert.equal(normalizeJournal({ events: [{ type: 'a' }], evictions: { total: 2, counts: { 'byte-budget': 2 } } }).evictions.total, 2);

  assert.deepEqual(normalizeWebSockets(null), { subscribed: false, sockets: [], total: 0 });
  assert.equal(normalizeWebSockets([{ id: 1 }]).total, 1);
  assert.deepEqual(normalizeWebSockets({ sockets: [{ id: 1 }], total: 5 }), { subscribed: true, sockets: [{ id: 1 }], total: 5 });

  assert.deepEqual(countTraceEvents(null), { subscribed: false, count: 0 });
  assert.equal(countTraceEvents([{ name: 'a' }]).count, 1);
  assert.equal(countTraceEvents({ traceEvents: [{}, {}] }).count, 2);
  assert.equal(countTraceEvents({ events: [{}] }).count, 1);
});

test('summary/分类聚合可用于 history 索引', () => {
  const report = buildDebugCoverage(completeInput({ requestsTotal: 5, consoleTotal: 3 }));
  const summary = summarizeCoverage(report);
  assert.equal(summary.version, COVERAGE_VERSION);
  assert.equal(summary.complete, false);
  assert.equal(summary.gaps, 2);
  assert.deepEqual(summary.categories, { limit: 2 });
  assert.equal(summary.phases.network.subscribed, true);
  assert.equal(summary.phases.network.count, 1);
  assert.equal(summary.score.request, 0.2);
  assert.deepEqual(gapCountsByCategory(report.gaps), { limit: 2 });
  assert.equal(hasGapCategory(report, GAP_CATEGORIES.LIMIT), true);
  assert.equal(hasGapCategory(report, GAP_CATEGORIES.DROPPED), false);
  // summarizeCoverage 也接受直接传 coverage 对象（history 里只存了 coverage）
  const fromCoverage = summarizeCoverage({ coverage: report.coverage, gaps: report.gaps });
  assert.equal(fromCoverage.gaps, 2);
});
