// tests/unit/debug-correlation.test.mjs —— requestId ↔ trace ↔ 截图/时间线关联 + 查询分页。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRELATION_VERSION,
  aggregateByRequestId,
  buildDebugCorrelation,
  buildTimeline,
  findLink,
  mergeRequestRecords,
  normalizeRequestRecord,
  normalizeScreenshot,
  normalizeTraceEvent,
  parseHarEntriesForCorrelation,
  queryRequests,
  summarizeCorrelation,
} from '../../extension/src/lib/debug-correlation.js';

function networkRequest(overrides = {}) {
  return {
    id: 1,
    method: 'GET',
    url: 'https://x.test/api/a',
    status: 200,
    startedAt: 100,
    durationMs: 20,
    responseBytes: 64,
    ...overrides,
  };
}

test('normalizeRequestRecord 兼容 network / HAR / 非法输入', () => {
  const network = normalizeRequestRecord(networkRequest());
  assert.equal(network.requestId, 'req-1');
  assert.equal(network.generatedRequestId, false);
  assert.equal(network.method, 'GET');
  assert.equal(network.status, 200);
  assert.equal(network.endAt, 120);
  assert.equal(network.source, 'network');
  assert.equal(network.requestBytes, 0);
  assert.equal(network.responseBytes, 64);

  const har = normalizeRequestRecord({
    startedDateTime: '2026-01-01T00:00:00.000Z',
    time: 12.6,
    request: { method: 'post', url: 'https://x.test/b', bodySize: 10 },
    response: { status: 201, bodySize: 250 },
  }, 2);
  assert.equal(har.method, 'POST');
  assert.equal(har.status, 201);
  assert.equal(har.durationMs, 13);
  assert.equal(har.startedAt, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(har.type, 'har');
  assert.equal(har.source, 'har');
  assert.equal(har.generatedRequestId, true);
  assert.equal(har.requestId, 'har-3');
  assert.equal(har.responseBytes, 250);

  assert.equal(normalizeRequestRecord(null), null);
  assert.equal(normalizeRequestRecord({ method: 'GET', url: '' }), null);
  assert.equal(normalizeRequestRecord({ requestId: 'r-9', url: 'https://x.test/c' }).requestId, 'r-9');
});

test('normalizeTraceEvent：µs→ms、requestId/url 提取、traceOrigin 对齐', () => {
  const plain = normalizeTraceEvent({
    name: 'ResourceSendRequest',
    cat: 'devtools.timeline',
    ph: 'X',
    tid: 7,
    ts: 1_500_000,
    dur: 5_000,
    args: { data: { requestId: 'req-7', url: 'https://x.test/a?q=1', method: 'GET', statusCode: 200 } },
  });
  assert.equal(plain.name, 'ResourceSendRequest');
  assert.equal(plain.ts, 1500);
  assert.equal(plain.durMs, 5);
  assert.equal(plain.requestId, 'req-7');
  assert.equal(plain.url, 'https://x.test/a?q=1');
  assert.equal(plain.at, null);
  assert.equal(plain.args.method, 'GET');

  const aligned = normalizeTraceEvent({ name: 'X', ts: 2_000_000, args: { data: {} } }, { traceOrigin: 10_000 });
  assert.equal(aligned.ts, 2000);
  assert.equal(aligned.at, 12_000);
  assert.equal(aligned.requestId, null);

  const absolute = normalizeTraceEvent({ name: 'Y', at: 777, ts: 1, args: {} });
  assert.equal(absolute.at, 777);
  assert.equal(normalizeTraceEvent(null), null);
});

test('normalizeScreenshot 时间来源与非法输入', () => {
  const shot = normalizeScreenshot({ id: 5, at: 123, kind: 'longshot', width: 100, height: 200, label: 'L' }, 0);
  assert.deepEqual(
    { id: shot.id, at: shot.at, kind: shot.kind, width: shot.width, height: shot.height, label: shot.label },
    { id: '5', at: 123, kind: 'longshot', width: 100, height: 200, label: 'L' },
  );
  const fromIso = normalizeScreenshot({ createdAt: '2026-01-01T00:00:01.000Z' });
  assert.equal(fromIso.at, Date.parse('2026-01-01T00:00:01.000Z'));
  assert.equal(fromIso.id, 'shot-1');
  assert.equal(normalizeScreenshot({ id: 'no-time' }), null);
});

test('buildDebugCorrelation：requestId 优先 + 截图/ journal 时间窗 + orphan 统计', () => {
  const correlation = buildDebugCorrelation({
    session: { id: 'tab-1', tabId: 1 },
    requests: [
      networkRequest(),
      networkRequest({ id: 2, method: 'POST', url: 'https://x.test/api/b', startedAt: 5_000, status: null, durationMs: null }),
    ],
    trace: [
      { name: 'ResourceSendRequest', ts: 1_500_000, dur: 2_000, args: { data: { requestId: 'req-1', url: 'https://x.test/api/a' } } },
      { name: 'OrphanTask', ts: 3_000_000, dur: 1_000, args: { data: { requestId: 'req-404' } } },
    ],
    traceOrigin: 1_000,
    screenshots: [{ id: 'shot-1', at: 110, kind: 'longshot' }, { id: 'shot-2', at: 9_000 }],
    journal: [{ seq: 1, type: 'pin', at: 105 }, { seq: 2, type: 'rule', at: 100_000 }],
    now: 20_000,
  });
  assert.equal(correlation.version, CORRELATION_VERSION);
  assert.equal(correlation.timeAligned, true);
  assert.equal(correlation.links.length, 2);

  const first = correlation.links[0];
  assert.equal(first.requestId, 'req-1');
  assert.equal(first.trace.matchedBy, 'requestId');
  assert.equal(first.trace.count, 1);
  assert.equal(first.trace.events[0].ts, 1500);
  assert.equal(first.trace.events[0].at, 2500);
  assert.equal(first.screenshots.length, 1);
  assert.equal(first.screenshots[0].id, 'shot-1');
  assert.equal(first.screenshots[0].deltaMs, 10);
  assert.equal(first.screenshots[0].nearest, true);
  assert.deepEqual(first.journal.map((event) => event.type), ['pin']);
  assert.equal(first.journal[0].direct, false);
  assert.deepEqual(first.correlated, { trace: true, screenshots: true, journal: true, any: true });

  const second = correlation.links[1];
  assert.equal(second.trace.count, 0);
  assert.equal(second.screenshots.length, 0);
  assert.equal(second.journal.length, 0);
  assert.equal(second.correlated.any, false);

  assert.equal(correlation.unlinked.length, 1);
  assert.equal(correlation.unlinked[0].requestId, 'req-2');
  assert.equal(correlation.orphanTraceEvents.length, 1);
  assert.equal(correlation.orphanTraceEvents[0].name, 'OrphanTask');

  assert.deepEqual(correlation.summary.requests, 2);
  assert.deepEqual(correlation.summary.linked, 1);
  assert.deepEqual(correlation.summary.unlinked, 1);
  assert.deepEqual(correlation.summary.traceEvents, 2);
  assert.deepEqual(correlation.summary.orphanTraceEvents, 1);
  assert.deepEqual(correlation.summary.screenshots, 2);
  assert.deepEqual(correlation.summary.linkedScreenshots, 1);
  assert.deepEqual(correlation.summary.journalEvents, 2);
  assert.deepEqual(correlation.summary.linkedJournalEvents, 1);
  assert.deepEqual(correlation.summary.byMethod, { GET: 1, POST: 1 });
  assert.deepEqual(correlation.summary.byStatus, { 200: 1, pending: 1 });
  assert.equal(correlation.byRequestId['req-1'].traceEvents, 1);

  // timeline：request 100 → journal 105 → screenshot 110 → trace 2500 → request 5000
  assert.deepEqual(correlation.timeline.map((row) => row.kind), ['request', 'journal', 'screenshot', 'trace', 'request']);
  assert.deepEqual(correlation.timeline.map((row) => row.at), [100, 105, 110, 2500, 5000]);
});

test('buildDebugCorrelation：URL / URL-key 兜底匹配', () => {
  const exact = buildDebugCorrelation({
    requests: [networkRequest({ requestId: 'req-A', url: 'https://x.test/api/a' })],
    trace: [{ name: 'R', ts: 1000, args: { data: { url: 'https://x.test/api/a' } } }],
  });
  assert.equal(exact.links[0].trace.matchedBy, 'url');
  assert.equal(exact.links[0].trace.count, 1);

  const keyed = buildDebugCorrelation({
    requests: [networkRequest({ requestId: 'req-B', url: 'https://x.test/api/a?token=hidden' })],
    trace: [{ name: 'R', ts: 1000, args: { data: { url: 'https://x.test/api/a?other=1' } } }],
  });
  assert.equal(keyed.links[0].trace.matchedBy, 'url-key');

  const none = buildDebugCorrelation({
    requests: [networkRequest({ requestId: 'req-C', url: 'https://x.test/api/a' })],
    trace: [{ name: 'R', ts: 1000, args: { data: { requestId: 'req-X', url: 'https://y.test/z' } } }],
  });
  assert.equal(none.links[0].trace.matchedBy, null);
  assert.equal(none.links[0].correlated.trace, false);
});

test('HAR 关联：URL-key 匹配 trace，且与 network 记录按 URL+时间邻域合并 sources', () => {
  const har = {
    log: {
      entries: [{
        startedDateTime: '2026-01-01T00:00:00.000Z',
        time: 8,
        request: { method: 'GET', url: 'https://x.test/api/har?q=1' },
        response: { status: 200 },
      }],
    },
  };
  const fromHar = buildDebugCorrelation({
    har,
    trace: [{ name: 'R', ts: 1000, args: { data: { url: 'https://x.test/api/har?q=2' } } }],
    screenshots: [{ id: 's', at: Date.parse('2026-01-01T00:00:00.050Z') }],
  });
  assert.equal(fromHar.summary.requests, 1);
  assert.equal(fromHar.timeAligned, false); // trace 没有绝对时间
  assert.equal(fromHar.links[0].trace.matchedBy, 'url-key');
  assert.equal(fromHar.links[0].screenshots.length, 1);
  assert.equal(fromHar.links[0].screenshots[0].deltaMs, 50);
  assert.deepEqual(fromHar.links[0].sources, ['har']);

  const merged = buildDebugCorrelation({
    requests: [{
      id: 1,
      method: 'GET',
      url: 'https://x.test/api/har?q=1',
      status: null,
      startedAt: Date.parse('2026-01-01T00:00:00.500Z'),
      durationMs: null,
    }],
    har,
    trace: [{ name: 'R', ts: 1000, args: { data: { requestId: 'req-1' } } }],
  });
  assert.equal(merged.summary.requests, 1, 'HAR 不应该把同一请求复制成第二条');
  assert.deepEqual(merged.links[0].sources.sort(), ['har', 'network']);
  assert.equal(merged.links[0].status, 200);
  assert.equal(merged.links[0].trace.matchedBy, 'requestId');

  assert.deepEqual(parseHarEntriesForCorrelation({}), []);
  assert.equal(parseHarEntriesForCorrelation(har).length, 1);
});

test('mergeRequestRecords：显式 requestId 合并、不同 requestId 不合并', () => {
  const merged = mergeRequestRecords([
    { requestId: 'req-1', id: 1, method: 'GET', url: 'https://x/a', status: null, startedAt: 100, source: 'network' },
    { requestId: 'req-1', id: 1, method: 'GET', url: 'https://x/a', status: 204, durationMs: 5, startedAt: 100, responseBytes: 10, source: 'har' },
    { requestId: 'req-2', id: 2, method: 'GET', url: 'https://x/a', status: 200, startedAt: 100, source: 'network' },
  ]);
  assert.equal(merged.length, 2);
  const first = merged.find((record) => record.requestId === 'req-1');
  assert.equal(first.status, 204);
  assert.equal(first.durationMs, 5);
  assert.equal(first.responseBytes, 10);
  assert.deepEqual(first.sources, ['network', 'har']);
  const second = merged.find((record) => record.requestId === 'req-2');
  assert.deepEqual(second.sources, ['network']);
});

test('queryRequests：url/method/status/时间窗过滤 + offset/page 分页', () => {
  const records = [
    normalizeRequestRecord({ id: 1, method: 'GET', url: 'https://x.test/api/a', status: 200, startedAt: 1_000, durationMs: 10 }),
    normalizeRequestRecord({ id: 2, method: 'POST', url: 'https://x.test/api/b', status: 201, startedAt: 2_000, durationMs: 50 }),
    normalizeRequestRecord({ id: 3, method: 'GET', url: 'https://x.test/api/c', status: 500, startedAt: 3_000, durationMs: 30 }),
    normalizeRequestRecord({ id: 4, method: 'GET', url: 'https://x.test/static/a.js', status: null, startedAt: 4_000, durationMs: null }),
    normalizeRequestRecord({ id: 5, method: 'DELETE', url: 'https://x.test/api/d', status: 0, error: 'net::ERR_FAILED', startedAt: 5_000, durationMs: 5 }),
  ];
  assert.equal(queryRequests(records, {}).total, 5);

  const byUrl = queryRequests(records, { url: '/api/' });
  assert.deepEqual(byUrl.items.map((record) => record.requestId), ['req-1', 'req-2', 'req-3', 'req-5']);
  assert.equal(queryRequests(records, { url: /\.js$/ }).total, 1);

  assert.deepEqual(queryRequests(records, { method: 'get' }).items.map((record) => record.id), [1, 3, 4]);
  assert.deepEqual(queryRequests(records, { status: 200 }).items.map((record) => record.id), [1]);
  assert.deepEqual(queryRequests(records, { status: 'pending' }).items.map((record) => record.id), [4]);
  assert.deepEqual(queryRequests(records, { status: 'error' }).items.map((record) => record.id), [5]);
  assert.deepEqual(queryRequests(records, { status: [200, 201] }).items.map((record) => record.id), [1, 2]);
  assert.deepEqual(queryRequests(records, { status: { min: 400 } }).items.map((record) => record.id), [3]);
  assert.deepEqual(queryRequests(records, { statusMin: 200, statusMax: 500 }).total, 3);
  assert.equal(queryRequests(records, { requestId: 'req-3' }).total, 1);

  const windowed = queryRequests(records, { timeWindow: { from: 2_000, to: 4_000 } });
  assert.deepEqual(windowed.items.map((record) => record.id), [2, 3, 4]);
  assert.equal(queryRequests(records, { since: 3_000 }).total, 3);
  assert.equal(queryRequests(records, { until: 2_000 }).total, 2);

  const page1 = queryRequests(records, { limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.equal(page1.returned, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextOffset, 2);
  const page2 = queryRequests(records, { limit: 2, page: 2 });
  assert.deepEqual(page2.items.map((record) => record.id), [3, 4]);
  assert.equal(page2.offset, 2);
  const page3 = queryRequests(records, { limit: 2, page: 3 });
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextOffset, null);
  assert.equal(page3.returned, 1);
  assert.equal(queryRequests(records, { limit: 2, offset: 99 }).returned, 0);
  assert.equal(queryRequests(records, { limit: 2, offset: 99 }).hasMore, false);

  assert.deepEqual(queryRequests(records, { order: 'desc', limit: 2 }).items.map((record) => record.id), [5, 4]);
  assert.deepEqual(queryRequests(records, { sort: 'duration', order: 'desc', limit: 2 }).items.map((record) => record.id), [2, 3]);
  assert.deepEqual(queryRequests(records, { sort: 'status', limit: 2 }).items.map((record) => record.id), [4, 5]);
});

test('queryRequests 也接受 link 列表（history detail 场景）', () => {
  const correlation = buildDebugCorrelation({
    requests: [networkRequest(), networkRequest({ id: 2, url: 'https://x.test/api/b', status: 404, startedAt: 200 })],
  });
  const hits = queryRequests(correlation.links, { url: '/api/a' });
  assert.equal(hits.total, 1);
  assert.equal(hits.items[0].requestId, 'req-1');
  assert.equal(queryRequests([], {}).total, 0);
  assert.equal(queryRequests(null, { method: 'GET' }).total, 0);
});

test('aggregateByRequestId / findLink / summarizeCorrelation / buildTimeline 辅助接口', () => {
  const records = [
    { requestId: 'req-1', id: 1, method: 'GET', url: 'https://x/a', startedAt: 100, traceEvents: 1, sources: ['network'] },
    { requestId: 'req-1', id: 1, method: 'GET', url: 'https://x/a', startedAt: 100, status: 200, sources: ['har'] },
    { requestId: 'req-2', id: 2, method: 'POST', url: 'https://x/b', startedAt: 200, sources: ['network'] },
  ];
  const aggregated = aggregateByRequestId(records);
  assert.equal(aggregated.length, 2);
  const first = aggregated.find((record) => record.requestId === 'req-1');
  assert.equal(first.status, 200);
  assert.deepEqual(first.sources.sort(), ['har', 'network']);

  const correlation = buildDebugCorrelation({ requests: [networkRequest({ requestId: 'req-1' })] });
  assert.equal(findLink(correlation, { requestId: 'req-1' }).requestId, 'req-1');
  assert.equal(findLink(correlation, { id: 1 }).requestId, 'req-1');
  assert.equal(findLink(correlation, { urlContains: '/api/a' }).requestId, 'req-1');
  assert.equal(findLink(correlation, { requestId: 'nope' }), null);

  const summary = summarizeCorrelation(correlation);
  assert.equal(summary.version, CORRELATION_VERSION);
  assert.equal(summary.requests, 1);
  assert.equal(summary.timeAligned, false);
  assert.deepEqual(summary.byMethod, { GET: 1 });

  const timeline = buildTimeline([{
    requestId: 'req-1',
    method: 'GET',
    url: '/a',
    startedAt: 100,
    durationMs: 5,
    trace: { events: [{ name: 'T', at: 150, durMs: 5 }] },
    screenshots: [{ id: 's', at: 200, kind: 'shot', label: 'L' }],
    journal: [{ seq: 1, type: 'pin', at: 300 }],
  }], { limit: 10 });
  assert.deepEqual(timeline.map((row) => row.kind), ['request', 'trace', 'screenshot', 'journal']);

  const noTrace = buildTimeline([{ requestId: 'req-1', startedAt: 100, trace: { events: [{ name: 'T', at: 150 }] } }], { includeTrace: false });
  assert.equal(noTrace.length, 1);
  const capped = buildTimeline(Array.from({ length: 3 }, (_, index) => ({ requestId: 'r' + index, startedAt: index })), { limit: 2 });
  assert.equal(capped.length, 2);
});
