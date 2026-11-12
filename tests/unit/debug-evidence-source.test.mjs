import test from 'node:test';
import assert from 'node:assert/strict';
import { consoleSource, operationContext, operationEvidence, requestKind } from '../../extension/src/debug/evidence-model.js';

const operation = { id: 'o1', method: 'tool.click', started_at: 100, finished_at: 200, state: 'complete' };
const next = { id: 'o2', method: 'tool.fill', started_at: 300 };
const recording = {
  saved_at: 500,
  run: { stopped_at: 999, coverage: [], dropped_requests: 0, dropped_console: 0, dropped_operations: 0 },
  operations: [operation, next],
  requests: [
    { id: 'r1', started_at: 120, method: 'GET', url: 'https://site.test/api', resource_type: 'XHR', response_body: { state: 'empty' }, request_body: { state: 'empty' } },
    { id: 'r2', started_at: 350, method: 'GET', url: 'https://site.test/img', resource_type: 'Image', response_body: { state: 'empty' }, request_body: { state: 'empty' } },
  ],
  console: [{ id: 'c1', at: 130, level: 'log', text: 'x' }],
  pages: [],
};

test('requestKind and consoleSource classify', () => {
  assert.equal(requestKind({ url: 'https://x', method: 'POST' }), 'business');
  assert.equal(requestKind({ url: 'https://x', method: 'GET', resource_type: 'Image' }), 'resource');
  assert.equal(requestKind({ url: 'chrome-extension://x' }), 'extension');
  assert.equal(consoleSource('https://x'), 'website');
  assert.equal(consoleSource('chrome-extension://x'), 'extension');
  assert.equal(consoleSource('https://x', 'security'), 'browser');
});

test('operationContext filters by operation window', () => {
  const context = operationContext(recording, operation);
  assert.deepEqual(context.requests.map((item) => item.id), ['r1']);
  assert.deepEqual(context.console.map((item) => item.id), ['c1']);
  assert.deepEqual(context.links, [{ request_id: 'r1', relation: 'window' }]);
  assert.deepEqual(context.operation.request_ids, ['r1']);
});

test('operationEvidence reports gaps and changes', () => {
  const full = {
    ...recording,
    operations: [operation],
    pages: [],
    run: { ...recording.run, coverage: [] },
  };
  const withPages = {
    ...full,
    requests: [],
    console: [],
    pages: [],
  };
  const evidence = operationEvidence(withPages, {
    ...operation,
    before: { state: 'available', text: 'a\nb', at: 100, fields: [] },
    after: { state: 'available', text: 'a\nc', at: 200, fields: [] },
  });
  assert.equal(evidence.gaps.includes('before_unavailable'), false);
  assert.deepEqual(evidence.changes.added, ['c']);
  assert.deepEqual(evidence.changes.removed, ['b']);
  assert.equal(evidence.changes.truncated, false);
});
