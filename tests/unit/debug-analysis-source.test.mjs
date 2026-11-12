import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRecording } from '../../extension/src/debug/analysis.js';

const req = (id, overrides = {}) => ({
  id, method: 'GET', url: 'https://site.test/api?page=1', frame_id: 'f1', loader_id: 'l1',
  started_at: 100, finished_at: 200, state: 'complete', status: 200, resource_type: 'XHR',
  duration_ms: 100, transfer_bytes: 10, request_body: { state: 'empty' },
  ...overrides,
});
const recording = {
  run: { session_id: 's1', coverage: [], dropped_requests: 0 },
  requests: [req('a'), req('b', { started_at: 300 }), req('c', { url: 'https://site.test/other', duration_ms: 900 }), req('d', { url: 'chrome-extension://x/y' })],
  operations: [{ id: 'o1', started_at: 90, finished_at: 250 }],
};

test('analyzeRecording aggregate groups by method+endpoint', () => {
  const result = analyzeRecording(recording, { action: 'aggregate', slow_ms: 500 });
  assert.equal(result.analysis.included, 3);
  assert.equal(result.analysis.groups, 2);
  assert.equal(result.aggregates[0].count, 2);
  assert.equal(result.aggregates[0].timing_samples, 2);
  assert.equal(result.aggregates[0].slow, 0);
});

test('analyzeRecording duplicates detects same document/window', () => {
  const result = analyzeRecording(recording, { action: 'duplicates', window_ms: 1000 });
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].extra_requests, 1);
  assert.deepEqual(result.duplicates[0].operation_ids, ['o1']);
  assert.equal(result.analysis.suspected_extra_requests, 1);
});

test('analyzeRecording excludes extension and controlled by default', () => {
  const withControl = {
    ...recording,
    requests: [req('a'), req('b', { intervention: { type: 'block', state: 'applied' } })],
  };
  const result = analyzeRecording(withControl, { action: 'aggregate' });
  assert.equal(result.analysis.included, 1);
  assert.equal(result.analysis.excluded_controlled, 1);
  assert.equal(result.analysis.coverage.includes('retained_requests_only'), true);
});
