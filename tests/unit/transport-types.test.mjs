import test from 'node:test';
import assert from 'node:assert/strict';
import { isEventFrame, isRequestFrame, isResponseFrame } from '../../extension/src/transport/types.js';

test('protocol frame guards classify frames', () => {
  assert.equal(isRequestFrame({ id: '1', method: 'ping' }), true);
  assert.equal(isRequestFrame({ event: 'x' }), false);
  assert.equal(isResponseFrame({ id: '1', result: null }), true);
  assert.equal(isResponseFrame({ id: '1', error: { code: 'timeout', message: 'x' } }), true);
  assert.equal(isResponseFrame({ id: 1, result: null }), false);
  assert.equal(isEventFrame({ event: 'session.ended' }), true);
  assert.equal(isEventFrame({ method: 'x' }), false);
});
