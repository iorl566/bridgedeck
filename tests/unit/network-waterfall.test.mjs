// tests/unit/network-waterfall.test.mjs —— 瀑布分项计时 / 跨 frame / 流式(chunked)不伪造 done。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWaterfall,
  deriveCdpTimings,
  timingsForEntry,
} from '../../extension/src/lib/network-waterfall.js';

const BASE = 1_700_000_000_000;

function documentEntry() {
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
    transferSize: 1200,
    frameId: 'F1',
    framePath: 'F1',
    frameUrl: 'https://a.test/',
    timing: {
      dnsStart: 10, dnsEnd: 12,
      connectStart: 12, connectEnd: 20,
      sslStart: 14, sslEnd: 18,
      sendStart: 21, sendEnd: 22,
      receiveHeadersEnd: 100,
    },
  };
}

function streamingEntry() {
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
    framePath: 'F1/F2',
    frameUrl: 'https://a.test/frame',
    chunks: [
      { at: BASE + 100, dataLength: 10, encodedDataLength: 10 },
      { at: BASE + 150, dataLength: 20, encodedDataLength: 20 },
    ],
  };
}

test('deriveCdpTimings：queueing/dns/connect/send/wait/TTFB/content-download 分项', () => {
  const timings = deriveCdpTimings(documentEntry());
  assert.equal(timings.queueingMs, 10); // dnsStart 之前的等待
  assert.equal(timings.dnsMs, 2);
  assert.equal(timings.connectMs, 8);
  assert.equal(timings.sslMs, 4);
  assert.equal(timings.sendMs, 1);
  assert.equal(timings.waitMs, 78);
  assert.equal(timings.ttfbMs, 100);
  assert.equal(timings.contentDownloadMs, 20);
  assert.equal(timings.totalMs, 120);
  assert.equal(timings.derivedFrom, 'cdp-timing');
  assert.equal(timings.open, false);
});

test('deriveCdpTimings：没有 CDP timing 时退化为 responseAt/duration，流式标记 open', () => {
  const entry = streamingEntry();
  const timings = deriveCdpTimings(entry, { now: BASE + 200 });
  assert.equal(timings.derivedFrom, 'response-at');
  assert.equal(timings.ttfbMs, 50);
  assert.equal(timings.contentDownloadMs, 120);
  assert.equal(timings.totalMs, 170);
  assert.equal(timings.open, true);
  const noResponse = timingsForEntry({ startedAt: BASE, durationMs: 33 });
  assert.equal(noResponse.ttfbMs, 33);
  assert.equal(noResponse.contentDownloadMs, 0);
  assert.equal(noResponse.totalMs, 33);
});

test('buildWaterfall：分项入行、跨 frame 汇总、流式行不伪造 done', () => {
  const frames = new Map([
    ['F1', { frameId: 'F1', parentFrameId: null, depth: 0, path: 'F1', url: 'https://a.test/' }],
    ['F2', { frameId: 'F2', parentFrameId: 'F1', depth: 1, path: 'F1/F2', url: 'https://a.test/frame' }],
  ]);
  const result = buildWaterfall([documentEntry(), streamingEntry()], { frames, now: BASE + 200 });
  assert.equal(result.rows.length, 2);
  const [doc, stream] = result.rows;
  assert.equal(doc.startOffsetMs, 0);
  assert.equal(doc.durationMs, 120);
  assert.equal(doc.endOffsetMs, 120);
  assert.equal(doc.queueingMs, 10);
  assert.equal(doc.ttfbMs, 100);
  assert.equal(doc.contentDownloadMs, 20);
  assert.equal(doc.finished, true);
  assert.equal(doc.streaming, false);
  assert.equal(doc.frame.depth, 0);
  assert.equal(stream.startOffsetMs, 30);
  assert.equal(stream.durationMs, 170); // now - startedAt，不是伪造一个完成时长
  assert.equal(stream.finished, false);
  assert.equal(stream.streaming, true);
  assert.equal(stream.open, true);
  assert.equal(stream.chunked, true);
  assert.equal(stream.chunkCount, 2);
  assert.equal(stream.chunksBytes, 30);
  assert.equal(stream.frame.path, 'F1/F2');
  assert.equal(stream.frame.depth, 1);
  assert.equal(result.summary.count, 2);
  assert.equal(result.summary.wallMs, 200);
  assert.equal(result.summary.streaming, 1);
  assert.equal(result.summary.unfinished, 1);
  assert.equal(result.summary.chunked, 1);
  assert.equal(result.summary.transferBytes, 1230);
  assert.equal(result.summary.phaseTotals.queueingMs, 10);
  assert.equal(result.summary.phaseTotals.ttfbMs, 150);
  assert.equal(result.summary.phaseTotals.contentDownloadMs, 140);
  assert.deepEqual(result.summary.byFrame.map((frame) => frame.frameId).sort(), ['F1', 'F2']);
  assert.equal(result.summary.byFrame.find((frame) => frame.frameId === 'F2').count, 1);
  assert.equal(result.summary.byType.Document, 1);
  assert.equal(result.summary.byType.EventSource, 1);
  assert.equal(result.summary.errors, 0);
});

test('buildWaterfall：limit/过滤/空输入/{frameId} 过滤', () => {
  const filtered = buildWaterfall([documentEntry(), streamingEntry()], {
    filter: { frameId: 'F2' },
    now: BASE + 200,
  });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].type, 'EventSource');
  const byUrl = buildWaterfall([documentEntry(), streamingEntry()], { filter: { urlContains: '/events' }, now: BASE + 200 });
  assert.equal(byUrl.rows.length, 1);
  const limited = buildWaterfall([documentEntry(), streamingEntry()], { limit: 1, now: BASE + 200 });
  assert.equal(limited.rows.length, 1);
  assert.equal(limited.rows[0].id, 2);
  const empty = buildWaterfall([]);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.summary.phaseTotals, {
    queueingMs: 0, ttfbMs: 0, contentDownloadMs: 0, dnsMs: 0, connectMs: 0, sendMs: 0, waitMs: 0,
  });
  assert.equal(empty.summary.frames.length, 0);
});

test('buildWaterfall：错误/状态码计入 errors，frame 用对象映射也可解析', () => {
  const failed = {
    ...documentEntry(),
    id: 3,
    status: 500,
    error: 'net::ERR_FAILED',
    frameId: 'F9',
  };
  const result = buildWaterfall([failed], { frames: { F9: { frameId: 'F9', depth: 2, path: 'F1/F9' } } });
  assert.equal(result.rows[0].error, 'net::ERR_FAILED');
  assert.equal(result.rows[0].frame.depth, 2);
  assert.equal(result.summary.errors, 1);
});
