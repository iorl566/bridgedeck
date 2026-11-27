// tests/unit/har-roundtrip.test.mjs —— HAR 1.2 往返保真 / 规范化幂等 / 无 requestId 关联 / WS 帧。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHar, exportHarFromArchive } from '../../lib/har.mjs';
import { importHar, normalizeHarWithCorrelation } from '../../lib/har-import.mjs';
import {
  attachWebSocketMessages,
  correlateHarEntries,
  headersToObject,
  inferResourceType,
  normalizeHar,
  normalizeHarEntry,
  normalizeWebSocketMessages,
  parseTime,
  validateHar,
} from '../../lib/har-normalize.mjs';

const START = Date.parse('2026-11-25T00:00:00.000Z');

function detail(overrides = {}) {
  return {
    entry: {
      id: 1,
      requestId: '1000.1',
      method: 'GET',
      url: 'https://api.test/users?page=2',
      status: 200,
      mime: 'application/json',
      type: 'XHR',
      startedAt: START,
      durationMs: 38,
      finishedAt: START + 38,
      responseBytes: 320,
      transferSize: 340,
      frameId: 'F2',
      framePath: 'F1/F2',
      protocol: 'h2',
      serverIPAddress: '203.0.113.7',
      fromCache: false,
    },
    requestHeaders: { 'x-request-id': 'r1', accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}',
    timings: {
      blocked: 2, dns: 1, connect: 3, ssl: 1, send: 1, wait: 30, receive: 4,
      totalMs: 40, _queueingMs: 2, _ttfbMs: 34, _contentDownloadMs: 4,
    },
    frame: { frameId: 'F2', parentFrameId: 'F1', depth: 1, path: 'F1/F2', url: 'https://api.test/frame' },
    ...overrides,
  };
}

function wsDetail() {
  return {
    entry: {
      id: 2,
      requestId: '1000.2',
      method: 'GET',
      url: 'wss://echo.test/socket',
      status: 101,
      mime: '',
      type: 'WebSocket',
      startedAt: START + 100,
      durationMs: 0,
      responseBytes: 0,
      transferSize: 0,
    },
    requestHeaders: { upgrade: 'websocket' },
    responseHeaders: { 'sec-websocket-accept': 'abc' },
    webSocket: {
      id: 7,
      requestId: '1000.2',
      url: 'wss://echo.test/socket',
      closed: true,
      frames: [
        { direction: 'sent', opcode: 1, payload: 'hello', at: START + 120 },
        { direction: 'received', opcode: 1, payload: 'x'.repeat(5000), at: START + 130 },
      ],
    },
  };
}

test('buildHar 导出保真：_resourceType/_transferSize/timings/frame/WS 帧', () => {
  const har = buildHar([detail(), wsDetail()], { pageUrl: 'https://api.test/', pageTitle: 'API' });
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries.length, 2);
  const entry = har.log.entries[0];
  assert.equal(entry._resourceType, 'XHR');
  assert.equal(entry._transferSize, 340);
  assert.equal(entry.response._transferSize, 340);
  assert.equal(entry._requestId, '1000.1');
  assert.equal(entry._frameId, 'F2');
  assert.equal(entry._framePath, 'F1/F2');
  assert.equal(entry.timings.totalMs, 40);
  assert.equal(entry.timings._queueingMs, 2);
  assert.equal(entry.timings._ttfbMs, 34);
  assert.equal(entry.timings._contentDownloadMs, 4);
  assert.equal(entry.timings.wait, 30);
  assert.equal(entry.response.content.text, '{"ok":true}');
  assert.deepEqual(headersToObject(entry.response.headers), { 'content-type': 'application/json' });

  const wsEntry = har.log.entries[1];
  assert.equal(wsEntry._resourceType, 'WebSocket');
  assert.equal(wsEntry._webSocketMessages.length, 2);
  const large = wsEntry._webSocketMessages[1];
  assert.equal(large.type, 'receive');
  assert.equal(large._truncated, true);
  assert.equal(large._originalLength, 5000);
  assert.equal(large.data.length < 5000, true);
  assert.equal(wsEntry._webSocketConnection.closed, true);
  assert.equal(wsEntry._webSocketConnection.frameCount, 2);
});

test('HAR 往返：export → import → 再 export 关键字段不丢', () => {
  const har = buildHar([detail(), wsDetail()]);
  const archive = importHar(har, { id: 'roundtrip-1' });
  assert.equal(archive.source, 'har');
  assert.equal(archive.requests.length, 2);
  const first = archive.requests[0];
  assert.equal(first.requestId, '1000.1');
  assert.equal(first.generatedRequestId, false);
  assert.equal(first.resourceType, 'XHR');
  assert.equal(first.type, 'XHR');
  assert.equal(first.transferSize, 340);
  assert.equal(first.frameId, 'F2');
  assert.equal(first.framePath, 'F1/F2');
  assert.equal(first.timings._ttfbMs, 34);
  assert.equal(first.timings.wait, 30);
  assert.equal(first.requestHeaders['x-request-id'], 'r1');
  assert.equal(first.responseBody, '{"ok":true}');
  const ws = archive.requests[1];
  assert.equal(ws.webSocketMessages.length, 2);
  assert.equal(ws.webSocket.closed, true);
  assert.equal(ws.webSocketMessages[1]._truncated, true);
  assert.equal(archive.summary.webSocketFrames, 2);
  assert.equal(archive.summary.webSockets, 1);

  const reExported = exportHarFromArchive(archive);
  const second = importHar(reExported);
  assert.equal(second.requests.length, 2);
  assert.equal(second.requests[0].resourceType, 'XHR');
  assert.equal(second.requests[0].transferSize, 340);
  assert.equal(second.requests[0].frameId, 'F2');
  assert.equal(second.requests[1].webSocketMessages.length, 2);
  assert.equal(second.requests[1].webSocket.closed, true);
  const back = normalizeHar(har).log.entries;
  const again = normalizeHar(reExported).log.entries;
  assert.equal(again[0].request.url, back[0].request.url);
  assert.equal(again[0].response.content.text, back[0].response.content.text);
  assert.equal(again[0].timings._ttfbMs, back[0].timings._ttfbMs);
  assert.equal(validateHar(reExported).ok, true);
});

test('normalizeHar 幂等：对规范化结果再规范化逐字段相等', () => {
  const once = normalizeHar(buildHar([detail()]));
  const twice = normalizeHar(once);
  assert.deepEqual(twice, once);
  const entry = once.log.entries[0];
  assert.equal(normalizeHarEntry(entry, 0).request.method, 'GET');
  assert.equal(validateHar(once).ok, true);
});

test('validateHar 报告结构问题而不是抛异常', () => {
  assert.equal(validateHar(null).ok, false);
  const bad = {
    log: {
      version: '1.1',
      entries: [
        { startedDateTime: 'not-a-date', request: { url: '', method: '' }, response: { status: 1200 }, timings: { wait: -5 } },
        null,
      ],
    },
  };
  const result = validateHar(bad);
  assert.equal(result.ok, false);
  const codes = result.issues.map((issue) => issue.code);
  for (const code of ['bad-version', 'bad-entry', 'bad-time', 'missing-url', 'missing-method', 'bad-status', 'bad-timing']) {
    assert.equal(codes.includes(code), true, '缺少 issue: ' + code);
  }
});

test('无 requestId 时按 method+url+时间邻域关联 WebSocket 帧', () => {
  const noIdHar = buildHar([{
    entry: {
      id: 3,
      method: 'GET',
      url: 'wss://echo.test/live',
      status: 101,
      type: 'WebSocket',
      startedAt: START + 5000,
      durationMs: 0,
      responseBytes: 0,
    },
    requestHeaders: { upgrade: 'websocket' },
    responseHeaders: {},
  }]);
  const socket = {
    id: 9,
    requestId: 'socket-request-9',
    url: 'wss://echo.test/live',
    createdAt: START + 5100,
    closed: false,
    frames: [{ direction: 'received', opcode: 1, payload: 'frame-1', at: START + 5200 }],
  };
  const near = importHar(noIdHar, { sockets: [socket] });
  assert.equal(near.requests[0].webSocketMessages.length, 1);
  assert.equal(near.requests[0].correlation.matchedBy, 'method-url-time');
  assert.equal(near.summary.wsMatchedBy.byUrlTime, 1);
  assert.equal(near.requests[0].generatedRequestId, true);

  // 时间邻域外（socket 创建时间晚了 20s）不关联
  const far = importHar(noIdHar, { sockets: [{ ...socket, createdAt: START + 25000 }] });
  assert.equal(far.requests[0].webSocketMessages.length, 0);
  assert.equal(far.summary.wsMatchedBy.matched, 0);
});

test('attachWebSocketMessages 优先 requestId，并输出关联证据', () => {
  const entries = normalizeHar(buildHar([wsDetail()])).log.entries;
  const sockets = [
    { id: 1, requestId: '1000.2', url: 'wss://echo.test/socket', createdAt: START + 100, frames: [{ direction: 'sent', opcode: 1, payload: 'by-id' }] },
    { id: 2, requestId: 'other', url: 'wss://echo.test/socket', createdAt: START + 100, frames: [{ direction: 'sent', opcode: 1, payload: 'by-url' }] },
  ];
  const attached = attachWebSocketMessages(entries, sockets);
  assert.equal(attached.matched, 1);
  assert.equal(attached.byRequestId, 1);
  assert.equal(attached.byUrlTime, 0);
  assert.equal(attached.entries[0]._webSocketMessages[0].data, 'by-id');
  assert.equal(attached.unmatched, 1);
});

test('correlateHarEntries 按时间窗分组同 method+url 请求', () => {
  const entries = normalizeHar({
    log: {
      version: '1.2',
      entries: [
        { startedDateTime: '2026-11-25T00:00:00.000Z', request: { method: 'GET', url: 'https://a.test/poll' }, response: { status: 200 } },
        { startedDateTime: '2026-11-25T00:00:00.400Z', request: { method: 'GET', url: 'https://a.test/poll' }, response: { status: 200 } },
        { startedDateTime: '2026-11-25T00:00:05.000Z', request: { method: 'GET', url: 'https://a.test/poll' }, response: { status: 200 } },
        { startedDateTime: '2026-11-25T00:00:00.100Z', request: { method: 'POST', url: 'https://a.test/poll' }, response: { status: 200 } },
      ],
    },
  }).log.entries;
  const result = correlateHarEntries(entries, { timeWindowMs: 500 });
  assert.equal(result.requests, 4);
  assert.equal(result.groups.length, 3);
  assert.equal(result.correlated, 1);
  const grouped = result.entries.filter((entry) => entry._correlation && entry._correlation.neighbors > 0);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]._correlation.indexInGroup, 1);
  assert.equal(grouped[0]._correlation.deltaMs, 400);
  assert.equal(result.entries[0]._correlation.matchedBy, 'method-url-time');
});

test('normalizeWebSocketMessages：按 UTF-8 字节截断且标记原始长度', () => {
  const messages = normalizeWebSocketMessages([
    { direction: 'received', opcode: 2, payload: '中文'.repeat(10), at: START },
  ], { maxPayload: 12 });
  assert.equal(messages[0].type, 'receive');
  assert.equal(messages[0]._truncated, true);
  assert.equal(messages[0]._originalLength, 60);
  assert.equal(Buffer.byteLength(messages[0].data, 'utf8') <= 12, true);
  assert.equal(messages[0].data.includes('\uFFFD'), false);
});

test('工具函数：parseTime / inferResourceType / headersToObject', () => {
  assert.equal(parseTime('2026-11-25T00:00:00.000Z'), START);
  assert.equal(parseTime(START), START);
  assert.equal(parseTime(1700000000), 1700000000000);
  assert.equal(parseTime('nope'), null);
  assert.equal(inferResourceType({ _resourceType: 'XHR' }), 'XHR');
  assert.equal(inferResourceType({ response: { content: { mimeType: 'text/css' } } }), 'Stylesheet');
  assert.equal(inferResourceType({ request: { url: 'https://a/app.js' } }), 'Script');
  assert.deepEqual(headersToObject([{ name: 'a', value: '1' }, { name: 'a', value: '2' }]), { a: '1, 2' });
});

test('normalizeHarWithCorrelation 返回关联后的 HAR 与分组证据', () => {
  const har = buildHar([wsDetail()]);
  const result = normalizeHarWithCorrelation(har);
  assert.equal(result.har.log.entries.length, 1);
  assert.equal(result.correlation.requests, 1);
  assert.equal(Array.isArray(result.correlation.groups), true);
});
