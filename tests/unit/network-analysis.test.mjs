import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWaterfall } from '../../lib/network-waterfall.mjs';
import { importHar } from '../../lib/har-import.mjs';

test('buildWaterfall 相对时间轴/慢请求/分类', () => {
  const result = buildWaterfall([
    { id: 1, method: 'GET', url: '/a', status: 200, type: 'XHR', startedAt: 1000, durationMs: 20, responseBytes: 10 },
    { id: 2, method: 'GET', url: '/b', status: 500, type: 'Script', startedAt: 1010, durationMs: 50, error: 'failed' },
  ]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].startOffsetMs, 0);
  assert.equal(result.rows[1].startOffsetMs, 10);
  assert.equal(result.summary.wallMs, 60);
  assert.equal(result.summary.slowest.id, 2);
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.byType.XHR, 1);
  assert.equal(buildWaterfall([]).summary.count, 0);
});

test('importHar 转成 archive 兼容请求', () => {
  const archive = importHar({
    log: {
      pages: [{ title: 'X' }],
      entries: [{
        startedDateTime: '2026-01-01T00:00:00.000Z',
        time: 12.6,
        request: { method: 'GET', url: 'https://x/a', bodySize: 0 },
        response: { status: 200, bodySize: 8 },
      }],
    },
  }, { id: 'h1' });
  assert.equal(archive.id, 'h1');
  assert.equal(archive.requests.length, 1);
  assert.equal(archive.requests[0].status, 200);
  assert.equal(archive.requests[0].durationMs, 13);
  assert.equal(archive.source, 'har');
  assert.equal(importHar({}).requests.length, 0);
});
