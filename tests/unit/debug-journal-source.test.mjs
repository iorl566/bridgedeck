import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonBytes, mergeRequest, requestMetadata, retentionPriority } from '../../extension/src/debug/journal.js';

const base = {
  id: 'n1',
  request_headers: { a: '1' },
  response_headers: { b: '2' },
  timing: { total: 1 },
  request_body: { state: 'available', text: 'req' },
  response_body: { state: 'available', text: 'res' },
  resource_type: 'XHR',
};

test('requestMetadata drops bodies and headers/timing', () => {
  const meta = requestMetadata(base);
  assert.deepEqual(meta.request_body, { state: 'available' });
  assert.deepEqual(meta.response_body, { state: 'available' });
  assert.equal(meta.request_headers, undefined);
  assert.equal(meta.response_headers, undefined);
  assert.equal(meta.timing, undefined);
});

test('mergeRequest preserves previously captured bodies on eviction', () => {
  const previous = { ...base, pinned: true };
  const current = { ...base, request_body: { state: 'evicted' }, response_body: { state: 'evicted' } };
  const merged = mergeRequest(previous, current);
  assert.deepEqual(merged.request_body, previous.request_body);
  assert.deepEqual(merged.response_body, previous.response_body);
  assert.equal(merged.pinned, true);
});

test('jsonBytes and retentionPriority classify evidence', () => {
  assert.equal(jsonBytes({ a: 1 }), 7);
  assert.equal(retentionPriority({ pinned: true }), 9);
  assert.equal(retentionPriority({ status: 500 }), 4);
  assert.equal(retentionPriority({ resource_type: 'XHR' }), 2);
  assert.equal(retentionPriority({ resource_type: 'Image' }), 0);
});
