import test from 'node:test';
import assert from 'node:assert/strict';
import { DEBUG_ACTIONS, DEBUG_FIELDS, debugCapabilities, QUERY_LIMITS } from '../../extension/src/debug/capabilities.js';

test('debugCapabilities exposes actions and limits', () => {
  const caps = debugCapabilities(true, { version: '1.2.3', build: 'b1' });
  assert.equal(caps.schema_version, 1);
  assert.deepEqual(caps.extension, { version: '1.2.3', build: 'b1' });
  assert.equal(caps.storage.request_limit, 2000);
  assert.equal(caps.storage.history_count, 50);
  assert.equal(caps.parameters.budget.default, 65536);
  assert.deepEqual(caps.parameters.fields.optional, DEBUG_FIELDS);
  assert.equal(caps.network_controls.rule_limit, 32);
});

test('ephemeral capabilities hide pin/unpin', () => {
  const caps = debugCapabilities(false);
  assert.equal(caps.actions.includes('pin'), false);
  assert.equal(caps.actions.includes('unpin'), false);
  assert.equal(DEBUG_ACTIONS.includes('pin'), true);
  assert.equal(QUERY_LIMITS.limit.default, 30);
});

test('capabilities lists unsupported features', () => {
  const caps = debugCapabilities();
  assert(caps.unsupported.includes('cpu_profiling'));
  assert(caps.unsupported.includes('binary_request_editing'));
  assert.equal(caps.performance.metrics.length, 9);
});
