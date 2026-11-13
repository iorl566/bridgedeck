import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeError, toWireError } from '../../extension/src/errors.js';

test('bridgeError keeps known codes and downgrades unknown ones', () => {
  assert.equal(bridgeError('E_BAD_ARG', 'x').code, 'E_BAD_ARG');
  assert.equal(bridgeError('E_NOT_REAL', 'x').code, 'E_INTERNAL');
});

test('toWireError preserves data and maps unknown exceptions', () => {
  const wire = toWireError(bridgeError('E_TIMEOUT', 'slow', { ms: 10 }));
  assert.deepEqual(wire, { code: 'E_TIMEOUT', message: 'slow', data: { ms: 10 } });
  const unknown = toWireError(new Error('boom'));
  assert.equal(unknown.code, 'E_INTERNAL');
  assert.match(unknown.message, /boom/);
});
