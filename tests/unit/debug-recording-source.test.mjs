import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecording } from '../../extension/src/debug/recording.js';

const recording = {
  saved_at: 500,
  run: { session_id: 's1', id: 'd1', state: 'stopped', next_since: 3, requests: 1, dropped_requests: 0, dropped_operations: 0, coverage: [], started_at: 1, stopped_at: 400 },
  operations: [{ id: 'o1', method: 'tool.click', sequence: 1, started_at: 100, finished_at: 200, state: 'complete', before: { state: 'available', at: 90, text: 'a', fields: [] }, after: { state: 'available', at: 210, text: 'b', fields: [] } }],
  requests: [{ id: 'n1', sequence: 2, started_at: 120, method: 'GET', url: 'https://site.test/api', resource_type: 'XHR', status: 200, state: 'complete', request_body: { state: 'empty' }, response_body: { state: 'empty' }, request_headers: { a: '1' }, response_headers: { b: '2' } }],
  console: [{ id: 'c1', at: 130, level: 'log', text: 'x' }],
  pages: [{ at: 90, fields: [] }, { at: 210, fields: [] }],
  performance: [{ id: 'p1', at: 1 }],
  rules: [{ id: 'r1' }],
  replays: [],
};

test('readRecording paginates pages/console/performance', () => {
  const pages = readRecording(recording, { action: 'pages', limit: 1 });
  assert.equal(pages.pages.length, 1);
  assert.equal(pages.next_offset, 1);
  assert.equal(pages.truncated, true);
  const perf = readRecording(recording, { action: 'performance', limit: 1 });
  assert.equal(perf.performance.length, 1);
});

test('readRecording filters and paginates requests', () => {
  const result = readRecording(recording, { action: 'requests', kind: 'business', limit: 10 });
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].id, 'n1');
  assert.equal(result.next_since, 2);
  assert.equal(result.truncated, false);
});

test('readRecording projects a single request with headers/body', () => {
  const result = readRecording(recording, { action: 'request', id: 'n1', part: 'headers' });
  assert.equal(result.request.id, 'n1');
  assert.deepEqual(result.request.request_headers, { a: '1' });
  assert.throws(() => readRecording(recording, { action: 'request', id: 'missing' }));
});

test('readRecording returns operation context and evidence', () => {
  const result = readRecording(recording, { action: 'operation', id: 'o1' });
  assert.equal(result.operation.id, 'o1');
  assert.equal(result.requests[0].id, 'n1');
  assert(result.evidence.gaps);
  assert.throws(() => readRecording(recording, { action: 'operation', id: 'missing' }));
});
