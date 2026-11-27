// tests/unit/waterfall-attribution-deep.test.mjs —— W9-C：瀑布归因（queueing/TTFB/download）、
// 慢请求阈值、流式不伪造完成、跨 frame 上卷、降级选择、以及 archive._waterfall 接线。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTRIBUTION_PHASES,
  DEFAULT_SLOW_MS,
  WATERFALL_ATTRIBUTION_VERSION,
  attributePhase,
  attributeRequests,
  attributeWaterfall,
  auditCompletion,
  correlateFrames,
  explainAttribution,
  selectWaterfallEntries,
  selectWaterfallRows,
  summarizeWaterfallAttribution,
} from '../../lib/waterfall-attribution.mjs';
import { importHar } from '../../lib/har-import.mjs';

const BASE = 1_700_000_000_000;

function rowOf({ queueingMs = 0, ttfbMs = 0, contentDownloadMs = 0, ...rest } = {}) {
  return {
    id: 1,
    requestId: 'r1',
    method: 'GET',
    url: 'https://a.test/',
    status: 200,
    type: 'XHR',
    durationMs: queueingMs + ttfbMs + contentDownloadMs,
    finished: true,
    frame: null,
    bytes: 100,
    error: null,
    timings: { queueingMs, ttfbMs, contentDownloadMs },
    ...rest,
  };
}

function documentEntry(overrides = {}) {
  return {
    id: 1,
    requestId: 'r1',
    method: 'GET',
    url: 'https://a.test/',
    status: 200,
    type: 'Document',
    startedAt: BASE,
    responseAt: BASE + 100,
    finishedAt: BASE + 120,
    durationMs: 120,
    finished: true,
    responseBytes: 1000,
    frameId: 'F1',
    timing: {
      dnsStart: 10, dnsEnd: 12,
      connectStart: 12, connectEnd: 20,
      sendStart: 21, sendEnd: 22,
      receiveHeadersEnd: 100,
    },
    ...overrides,
  };
}

function streamingEntry(overrides = {}) {
  return {
    id: 2,
    requestId: 'r2',
    method: 'GET',
    url: 'https://a.test/events',
    status: 200,
    type: 'EventSource',
    startedAt: BASE + 30,
    responseAt: BASE + 80,
    finished: false,
    streaming: true,
    chunked: true,
    frameId: 'F2',
    ...overrides,
  };
}

function slowEntry(overrides = {}) {
  return {
    id: 3,
    requestId: 'r3',
    method: 'GET',
    url: 'https://a.test/slow',
    status: 500,
    type: 'XHR',
    startedAt: BASE + 200,
    responseAt: BASE + 2100,
    finishedAt: BASE + 2500,
    durationMs: 2500,
    finished: true,
    error: 'net::ERR_FAILED',
    frameId: 'F9',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 三段归因
// ---------------------------------------------------------------------------

test('attributePhase：queueing / TTFB / download 主导判定与并列优先级', () => {
  const queueBound = attributePhase(rowOf({ queueingMs: 80, ttfbMs: 10, contentDownloadMs: 10 }));
  assert.equal(queueBound.phase, 'queueing');
  assert.equal(queueBound.code, 'connection-or-queue-wait');
  assert.equal(queueBound.ms, 80);
  assert.equal(queueBound.share, 80);
  assert.equal(queueBound.ties, false);
  assert.equal(queueBound.totalMs, 100);

  const serverBound = attributePhase(rowOf({ queueingMs: 5, ttfbMs: 70, contentDownloadMs: 25 }));
  assert.equal(serverBound.phase, 'ttfb');
  assert.equal(serverBound.code, 'server-processing');
  assert.equal(serverBound.share, 70);

  const payloadBound = attributePhase(rowOf({ queueingMs: 5, ttfbMs: 25, contentDownloadMs: 70 }));
  assert.equal(payloadBound.phase, 'download');
  assert.equal(payloadBound.code, 'payload-transfer');

  // 三段都为 0 → unknown，不伪造归因
  const unknown = attributePhase(rowOf({}));
  assert.equal(unknown.phase, 'unknown');
  assert.equal(unknown.code, 'insufficient-timings');
  assert.equal(unknown.ms, 0);
  assert.equal(unknown.share, 0);
  assert.equal(unknown.ties, false);

  // 并列时固定优先级 queueing > ttfb > download
  const tied = attributePhase(rowOf({ queueingMs: 10, ttfbMs: 10, contentDownloadMs: 10 }));
  assert.equal(tied.ties, true);
  assert.equal(tied.phase, 'queueing');
  assert.equal(tied.share, 33.3);

  // 非法值按 0 处理，不产生 NaN
  const messy = attributePhase({ timings: { queueingMs: 'x', ttfbMs: -5, contentDownloadMs: 12 } });
  assert.equal(messy.phase, 'download');
  assert.equal(Number.isFinite(messy.share), true);
});

test('attributePhase：贡献度数组完整且总和一致', () => {
  const attribution = attributePhase(rowOf({ queueingMs: 20, ttfbMs: 40, contentDownloadMs: 60 }));
  assert.deepEqual(attribution.contributions.map((item) => item.phase), ATTRIBUTION_PHASES);
  assert.deepEqual(attribution.contributions.map((item) => item.ms), [20, 40, 60]);
  assert.equal(attribution.contributions.reduce((sum, item) => sum + item.share, 0), 100);
  assert.equal(attribution.totalMs, 120);
});

test('explainAttribution：code/reason/hint 结构化，未知 code 有兜底', () => {
  const explained = explainAttribution(attributePhase(rowOf({ ttfbMs: 50 })));
  assert.equal(explained.code, 'server-processing');
  assert.equal(explained.phase, 'ttfb');
  assert.equal(explained.share, 100);
  assert.equal(typeof explained.reason, 'string');
  assert.equal(typeof explained.hint, 'string');
  assert.equal(explained.reason.length > 5, true);
  const fallback = explainAttribution({ code: 'nope' });
  assert.equal(fallback.code, 'nope');
  assert.equal(typeof fallback.reason, 'string');
  assert.equal(explainAttribution(null).code, 'insufficient-timings');
});

// ---------------------------------------------------------------------------
// 降级选择
// ---------------------------------------------------------------------------

test('selectWaterfallEntries：错误 > 慢请求 > 流式未完成 > 最早，且确定性', () => {
  const entries = [];
  for (let index = 0; index < 10; index += 1) {
    entries.push({
      id: index + 1,
      startedAt: BASE + index,
      durationMs: 10 + index,
      status: index === 7 ? 500 : 200,
      finished: index !== 8,
      streaming: index === 8,
      url: 'https://a.test/' + index,
    });
  }
  const selection = selectWaterfallEntries(entries, { limit: 4, slowMs: 15 });
  assert.equal(selection.total, 10);
  assert.equal(selection.kept, 4);
  assert.equal(selection.dropped, 6);
  assert.equal(selection.strategy, 'errors-then-slow-then-open-then-earliest');
  assert.equal(selection.reasons.error, 1);
  assert.equal(selection.reasons.slow > 0, true);
  // 被选中的条目保持时间顺序
  const times = selection.entries.map((entry) => entry.startedAt);
  assert.deepEqual(times, times.slice().sort((a, b) => a - b));
  // 确定性
  const again = selectWaterfallEntries(entries, { limit: 4, slowMs: 15 });
  assert.deepEqual(again.entries.map((entry) => entry.id), selection.entries.map((entry) => entry.id));
  // 未超限时原样返回
  const small = selectWaterfallEntries(entries.slice(0, 3), { limit: 10 });
  assert.equal(small.strategy, 'none');
  assert.equal(small.dropped, 0);
  // 非法条目被忽略
  assert.equal(selectWaterfallEntries([null, {}, 'x'], { limit: 5 }).total, 0);
});

test('selectWaterfallRows：对已有 rows 的降级同策略（保留错误/慢/未完成）', () => {
  const rows = [];
  for (let index = 0; index < 8; index += 1) {
    rows.push(rowOf({
      queueingMs: 0,
      ttfbMs: 10 + index,
      contentDownloadMs: 0,
      durationMs: 10 + index,
      status: index === 2 ? 503 : 200,
      finished: index !== 5,
      frame: null,
      bytes: 10,
      id: index + 1,
    }));
  }
  const selection = selectWaterfallRows(rows, { limit: 3, slowMs: 15 });
  assert.equal(selection.kept, 3);
  assert.equal(selection.dropped, 5);
  assert.equal(selection.reasons.error, 1);
  assert.equal(selection.rows.some((row) => row.status === 503), true);
  assert.equal(selection.rows.some((row) => row.finished === false), true);
  const noLimit = selectWaterfallRows(rows, { limit: 100 });
  assert.equal(noLimit.strategy, 'none');
  assert.equal(noLimit.dropped, 0);
});

// ---------------------------------------------------------------------------
// 流式诚实性
// ---------------------------------------------------------------------------

test('auditCompletion：识别"没有 loadingFinished 的流式输入"与不可核验完成', () => {
  const audit = auditCompletion([
    documentEntry(),
    streamingEntry(),
    { finished: true, url: 'https://a.test/no-evidence' },
    { finished: true, finishedAt: BASE, url: 'https://a.test/complete' },
    { durationMs: 12, url: 'https://a.test/no-timings' },
  ]);
  assert.equal(audit.total, 5);
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.violations.map((item) => item.code), ['streaming-claims-finished', 'finished-without-evidence']);
  assert.equal(audit.unverifiable.length, 1);
  assert.equal(audit.unverifiable[0].code, 'no-phase-timings');
  // 只有正常输入时 ok=true
  assert.equal(auditCompletion([documentEntry()]).ok, true);
  assert.equal(auditCompletion([]).ok, true);
});

// ---------------------------------------------------------------------------
// 跨 frame 关联
// ---------------------------------------------------------------------------

test('correlateFrames：子 frame 上卷到父 frame，self 口径独立，孤儿单独列出', () => {
  const frames = new Map([
    ['F1', { frameId: 'F1', depth: 0, path: 'F1', url: 'https://a.test/' }],
    ['F2', { frameId: 'F2', parentFrameId: 'F1', depth: 1, path: 'F1/F2', url: 'https://a.test/frame' }],
    ['F3', { frameId: 'F3', parentFrameId: 'F2', depth: 2, path: 'F1/F2/F3', url: 'https://a.test/frame3' }],
  ]);
  const rows = [
    rowOf({ id: 1, frame: { frameId: 'F1', depth: 0, path: 'F1' }, durationMs: 10, bytes: 100 }),
    rowOf({ id: 2, frame: { frameId: 'F2', depth: 1, path: 'F1/F2' }, durationMs: 20, bytes: 200 }),
    rowOf({ id: 3, frame: { frameId: 'F3', depth: 2, path: 'F1/F2/F3' }, durationMs: 30, bytes: 300 }),
    rowOf({ id: 4, frame: { frameId: 'F9', depth: 0, path: 'F9' }, durationMs: 5, bytes: 50 }),
    rowOf({ id: 5, frame: null, durationMs: 1, bytes: 1 }),
  ];
  const result = correlateFrames(rows, { frames });
  assert.equal(result.frameCount, 4);
  assert.equal(result.unattributed, 1);
  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].frameId, 'F9');
  const root = result.frames.find((frame) => frame.frameId === 'F1');
  const child = result.frames.find((frame) => frame.frameId === 'F2');
  const grandchild = result.frames.find((frame) => frame.frameId === 'F3');
  // self 口径
  assert.equal(root.selfCount, 1);
  assert.equal(root.selfDurationMs, 10);
  // 上卷：F1 = F1 + F2 + F3；F2 = F2 + F3
  assert.equal(root.count, 3);
  assert.equal(root.durationMs, 60);
  assert.equal(root.bytes, 600);
  assert.equal(child.count, 2);
  assert.equal(child.durationMs, 50);
  assert.equal(grandchild.count, 1);
  assert.deepEqual(child.childFrames, ['F3']);
  assert.deepEqual(root.childFrames, ['F2']);
  assert.equal(result.rolledUp >= 2, true);
  // 排序：上卷后的总时长降序
  assert.deepEqual(result.frames.map((frame) => frame.frameId).slice(0, 3), ['F1', 'F2', 'F3']);
});

test('correlateFrames：没有 frames 注册表时按行内 frame 归属，不误报孤儿', () => {
  const rows = [rowOf({ id: 1, frame: { frameId: 'X1', depth: 0, path: 'X1' }, durationMs: 5, bytes: 5 })];
  const result = correlateFrames(rows, {});
  assert.equal(result.orphans.length, 0);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].frameId, 'X1');
  assert.equal(result.frames[0].selfCount, 1);
});

// ---------------------------------------------------------------------------
// 归因主入口
// ---------------------------------------------------------------------------

test('attributeWaterfall：分项合计/占比/主导段/慢请求/流式/审计/降级一次给全', () => {
  const frames = new Map([
    ['F1', { frameId: 'F1', depth: 0, path: 'F1', url: 'https://a.test/' }],
    ['F2', { frameId: 'F2', parentFrameId: 'F1', depth: 1, path: 'F1/F2', url: 'https://a.test/frame' }],
  ]);
  const entries = [documentEntry(), streamingEntry(), slowEntry()];
  const attribution = attributeWaterfall(entries, { slowMs: 1000, now: BASE + 300, frames });
  assert.equal(attribution.version, WATERFALL_ATTRIBUTION_VERSION);
  assert.equal(attribution.rows.length, 3);
  // 行级归因完整
  for (const row of attribution.rows) {
    assert.equal(typeof row.attribution.phase, 'string');
    assert.equal(Array.isArray(row.attribution.contributions), true);
    assert.equal(typeof row.slow, 'boolean');
    assert.equal(typeof row.honestDuration === 'string' || row.honestDuration === true, true);
  }
  // 60/30 文档请求：TTFB 100，下载 20，queueing 10
  const doc = attribution.rows[0];
  assert.equal(doc.attribution.phase, 'ttfb');
  assert.equal(doc.slow, false);
  assert.equal(doc.honestDuration, true);
  // 流式行：open、诚实时长（270ms < slowMs=1000，不算慢）
  const stream = attribution.rows[1];
  assert.equal(stream.finished, false);
  assert.equal(stream.honestDuration, 'live-until-now');
  assert.equal(stream.slow, false);
  // 慢请求阈值：2500ms 的错误请求
  assert.equal(attribution.slow.thresholdMs, 1000);
  assert.equal(attribution.slow.count >= 1, true);
  assert.equal(attribution.slow.rows[0].id, 3);
  assert.equal(attribution.slow.rows[0].status, 500);
  assert.equal(attribution.slow.byType['server-processing'] >= 1, true);
  // 三段汇总
  const totals = attribution.phases.totals;
  assert.equal(totals.queueingMs, 10);
  assert.equal(totals.ttfbMs > 100, true);
  assert.equal(totals.contentDownloadMs > 0, true);
  const shares = attribution.phases.shares;
  assert.equal(shares.queueing + shares.ttfb + shares.download > 99, true);
  assert.equal(typeof attribution.phases.dominant.phase, 'string');
  // 流式
  assert.equal(attribution.streaming.count, 1);
  assert.equal(attribution.streaming.finished, 2);
  assert.match(attribution.streaming.honesty, /never reported as finished/);
  // 错误
  assert.equal(attribution.errors.count, 1);
  assert.equal(attribution.errors.rows[0].error, 'net::ERR_FAILED');
  // 审计（传入原始 entries 才审计）
  assert.equal(attribution.audit.ok, true);
  assert.equal(attribution.degraded.limited, false);
  assert.equal(attribution.degraded.dropped, 0);
});

test('attributeWaterfall：慢请求阈值可配，slow 行按耗时降序且只含超过阈值者', () => {
  const attribution = attributeWaterfall([
    documentEntry({ durationMs: 120 }),
    docEntryWith(500, 'https://a.test/mid'),
    docEntryWith(1500, 'https://a.test/slow'),
  ], { slowMs: 400, now: BASE + 2000 });
  assert.equal(attribution.slow.thresholdMs, 400);
  assert.equal(attribution.slow.count, 2);
  assert.deepEqual(attribution.slow.rows.map((row) => row.durationMs), [1500, 500]);
  for (const row of attribution.slow.rows) {
    assert.equal(row.durationMs >= 400, true);
    assert.equal(typeof row.code, 'string');
  }
});

function docEntryWith(durationMs, url) {
  return {
    id: Math.round(durationMs),
    requestId: 'r-' + durationMs,
    method: 'GET',
    url,
    status: 200,
    type: 'XHR',
    startedAt: BASE,
    responseAt: BASE + Math.round(durationMs / 2),
    finishedAt: BASE + durationMs,
    durationMs,
    finished: true,
    responseBytes: 10,
  };
}

test('attributeWaterfall：rows 输入使用 HAR 分项计时（不把总时长全塞给 TTFB）', () => {
  const rows = [
    rowOf({ id: 1, queueingMs: 100, ttfbMs: 10, contentDownloadMs: 10 }),
    rowOf({ id: 2, queueingMs: 10, ttfbMs: 100, contentDownloadMs: 10 }),
    rowOf({ id: 3, queueingMs: 10, ttfbMs: 10, contentDownloadMs: 100 }),
  ];
  const attribution = attributeWaterfall({ rows }, { slowMs: 1000 });
  assert.deepEqual(attribution.rows.map((row) => row.attribution.phase), ['queueing', 'ttfb', 'download']);
  assert.equal(attribution.phases.totals.queueingMs, 120);
  assert.equal(attribution.phases.totals.ttfbMs, 120);
  assert.equal(attribution.phases.totals.contentDownloadMs, 120);
  assert.equal(attribution.phases.counts.unknown, 0);
});

test('attributeWaterfall：rows 超限时降级并记录 dropped/strategy/notes', () => {
  const rows = [];
  for (let index = 0; index < 300; index += 1) {
    rows.push(rowOf({ id: index + 1, ttfbMs: 10 + (index % 5), durationMs: 10 + (index % 5), url: 'https://a.test/' + index }));
  }
  const attribution = attributeWaterfall({ rows }, { limit: 50, slowMs: 12 });
  assert.equal(attribution.rows.length, 50);
  assert.equal(attribution.degraded.limited, true);
  assert.equal(attribution.degraded.total, 300);
  assert.equal(attribution.degraded.kept, 50);
  assert.equal(attribution.degraded.dropped, 250);
  assert.equal(attribution.degraded.strategy, 'errors-then-slow-then-open-then-earliest');
  assert.equal(attribution.degraded.notes.length >= 1, true);
  // 降级信息在紧凑摘要里也保留
  const summary = summarizeWaterfallAttribution(attribution);
  assert.equal(summary.degraded.dropped, 250);
  assert.equal(summary.degraded.limited, true);
});

test('attributeWaterfall：没有任何分项计时时归因 unknown 并说明原因', () => {
  const attribution = attributeWaterfall({
    rows: [rowOf({ id: 1, queueingMs: 0, ttfbMs: 0, contentDownloadMs: 0, durationMs: 100, timings: { queueingMs: 0, ttfbMs: 0, contentDownloadMs: 0 } })],
  });
  assert.equal(attribution.rows[0].attribution.phase, 'unknown');
  assert.equal(attribution.phases.totalMs, 0);
  assert.equal(attribution.degraded.notes.some((note) => note.includes('unknown')), true);
});

// ---------------------------------------------------------------------------
// 紧凑摘要与便捷入口
// ---------------------------------------------------------------------------

test('summarizeWaterfallAttribution：控制体积（Top 截断），保留关键证据', () => {
  const attribution = attributeWaterfall([
    documentEntry(),
    streamingEntry(),
    slowEntry(),
  ], { slowMs: 1000, now: BASE + 300 });
  const summary = summarizeWaterfallAttribution(attribution, { topSlow: 1, topFrames: 1 });
  assert.equal(summary.version, WATERFALL_ATTRIBUTION_VERSION);
  assert.equal(summary.requests, 3);
  assert.equal(summary.slow.count >= 1, true);
  assert.equal(summary.slow.top.length, 1);
  assert.equal(summary.streaming.count, 1);
  assert.equal(existsUndefined(summary), false);
});

function existsUndefined(value) {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some((item) => existsUndefined(item));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => existsUndefined(item));
  }
  return false;
}

test('attributeRequests：从 archive 风格 requests 直接得到归因 + 摘要', () => {
  const requests = [
    {
      id: 1,
      requestId: 'r1',
      method: 'GET',
      url: 'https://a.test/a',
      status: 200,
      type: 'XHR',
      startedAt: BASE,
      durationMs: 120,
      finishedAt: BASE + 120,
      timings: { _queueingMs: 10, _ttfbMs: 100, _contentDownloadMs: 10, totalMs: 120 },
      frameId: 'F1',
    },
  ];
  const result = attributeRequests(requests, { slowMs: 50 });
  assert.equal(result.attribution.rows.length, 1);
  assert.equal(result.attribution.rows[0].attribution.phase, 'ttfb');
  assert.equal(result.summary.slow.count, 1);
  assert.equal(DEFAULT_SLOW_MS, 1000);
});

// ---------------------------------------------------------------------------
// 运行时接线：importHar 的 archive._waterfall
// ---------------------------------------------------------------------------

test('importHar：归档自动附瀑布归因摘要（旧字段不变，只新增 _waterfall / summary 新键）', () => {
  const har = {
    log: {
      version: '1.2',
      pages: [{ id: 'p1', title: 'X', startedDateTime: new Date(BASE).toISOString(), pageTimings: {} }],
      entries: [
        {
          startedDateTime: new Date(BASE).toISOString(),
          time: 120,
          request: { method: 'GET', url: 'https://a.test/a', headers: [] },
          response: { status: 200, bodySize: 10, headers: [], content: { size: 10, mimeType: 'text/plain', text: 'ok' } },
          timings: { blocked: 10, dns: -1, connect: -1, send: 0, wait: 100, receive: 10, _queueingMs: 10, _ttfbMs: 100, _contentDownloadMs: 10, totalMs: 120 },
          _requestId: 'r1',
          _frameId: 'F1',
          _finishedAt: BASE + 120,
          _startedAt: BASE,
        },
        {
          startedDateTime: new Date(BASE + 50).toISOString(),
          time: 2500,
          request: { method: 'GET', url: 'https://a.test/slow', headers: [] },
          response: { status: 500, bodySize: 0, headers: [], content: { size: 0, mimeType: 'text/plain' } },
          timings: { blocked: 1, dns: -1, connect: -1, send: 0, wait: 2490, receive: 9, _queueingMs: 1, _ttfbMs: 2490, _contentDownloadMs: 9, totalMs: 2500 },
          _requestId: 'r2',
          _frameId: 'F1',
          _startedAt: BASE + 50,
          _finishedAt: BASE + 2550,
          _error: 'net::ERR_FAILED',
        },
      ],
    },
  };
  const archive = importHar(har, { now: BASE, slowMs: 1000 });
  // 旧字段保持不变
  assert.equal(archive.requests.length, 2);
  assert.equal(archive.summary.requests, 2);
  assert.equal(archive.summary.webSocketFrames, 0);
  // 新字段：归因摘要
  assert.equal(archive._waterfall.version, WATERFALL_ATTRIBUTION_VERSION);
  assert.equal(archive._waterfall.requests, 2);
  assert.equal(archive._waterfall.slow.count, 1);
  assert.equal(archive._waterfall.slow.thresholdMs, 1000);
  assert.equal(archive._waterfall.slow.top[0].requestId, 'r2');
  assert.equal(archive._waterfall.errors.count, 1);
  assert.equal(archive.summary.slowRequests, 1);
  assert.equal(typeof archive.summary.streamingRequests, 'number');
  // 慢请求/错误在 compact 摘要里仍可读
  assert.equal(archive._waterfall.phases.totals.ttfbMs >= 2490, true);
});
