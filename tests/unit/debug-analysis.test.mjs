import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDebugCapture, filterDebugRequests, requestKind } from '../../lib/debug-analysis.mjs';

const requests = [
  { id: 1, method: 'GET', url: 'https://a.test/api', status: 200, type: 'XHR', durationMs: 12, commandId: 'c1' },
  { id: 2, method: 'GET', url: 'https://a.test/img.png', status: 200, type: 'Image', durationMs: 800 },
  { id: 3, method: 'POST', url: 'https://a.test/api', status: 500, type: 'Fetch', durationMs: 1500, error: 'boom', commandId: 'c1' },
];

test('requestKind classifies business/resource/extension', () => {
  assert.equal(requestKind(requests[0]), 'business');
  assert.equal(requestKind(requests[1]), 'resource');
  assert.equal(requestKind({ method: 'GET', url: 'chrome-extension://x/y' }), 'extension');
});

test('filterDebugRequests supports url/method/status/duration/kind', () => {
  assert.equal(filterDebugRequests(requests, { url: '/api' }).length, 2);
  assert.equal(filterDebugRequests(requests, { method: 'POST' }).length, 1);
  assert.equal(filterDebugRequests(requests, { status: 500 }).length, 1);
  assert.equal(filterDebugRequests(requests, { minDuration: 1000 }).length, 1);
  assert.equal(filterDebugRequests(requests, { kind: 'resource' }).length, 1);
});

test('analyzeDebugCapture reports slow/errors/duplicates/groups', () => {
  const result = analyzeDebugCapture({ requests, console: [{ level: 'warn' }] }, { slowMs: 500 });
  assert.deepEqual(result.counts, { requests: 3, console: 1 });
  assert.equal(result.status['200'], 2);
  assert.equal(result.status['500'], 1);
  assert.equal(result.slow.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.duplicates[0].url, 'https://a.test/api');
  assert.equal(result.groups[0].commandId, 'c1');
  assert.equal(result.consoleLevel.warn, 1);
});
