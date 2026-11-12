import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionCheckError, actionError, parseExpectations } from '../../extension/src/cooperation/action-checks.js';

test('parseExpectations accepts valid checks', () => {
  assert.deepEqual(parseExpectations(undefined), []);
  const checks = [
    { target: '@e1', field: 'text', equals: 'x' },
    { target: '@e2', field: 'checked', equals: true },
    { target: '@e3', field: 'exists', equals: false },
    { target: '@e4', field: 'attribute', attribute: 'href', equals: null },
  ];
  assert.deepEqual(parseExpectations(checks), checks);
});

test('parseExpectations rejects malformed checks', () => {
  assert.equal(parseExpectations(Array.from({ length: 17 }, () => ({ target: 't', field: 'exists', equals: true }))).code, 'invalid_params');
  assert.equal(parseExpectations([{ target: ' ', field: 'text', equals: 'x' }]).code, 'invalid_params');
  assert.equal(parseExpectations([{ target: 't', field: 'text', equals: 1 }]).code, 'invalid_params');
  assert.equal(parseExpectations([{ target: 't', field: 'checked', equals: 'yes' }]).code, 'invalid_params');
  assert.equal(parseExpectations([{ target: 't', field: 'attribute', equals: 'x' }]).code, 'invalid_params');
  assert.equal(parseExpectations([{ target: 't', field: 'exists', equals: true, extra: 1 }]).code, 'invalid_params');
});

test('actionError builds a permission error with recovery', () => {
  const error = actionError('target_moved', 'moved', 'target', 'retry', { backend_node_id: 1 });
  assert.equal(error.code, 'permission_denied');
  assert.equal(error.data.reason, 'target_moved');
  assert.equal(error.data.phase, 'target');
  assert.equal(error.data.effect_state, 'none');
  assert.equal(error.data.backend_node_id, 1);
});

test('ActionCheckError preserves the rpc error', () => {
  const error = new ActionCheckError({ message: 'failed', code: 'permission_denied' });
  assert.equal(error.name, 'ActionCheckError');
  assert.equal(error.message, 'failed');
  assert.equal(error.rpcError.code, 'permission_denied');
});
