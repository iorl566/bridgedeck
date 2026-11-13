import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATION_MAX_BYTES, enforceOperationLimit, jsonByteLength } from '../../lib/limits.mjs';

test('jsonByteLength counts UTF-8 bytes', () => {
  assert.equal(jsonByteLength('a'), 3);
  assert.equal(jsonByteLength('中'), 5);
  assert.equal(jsonByteLength(undefined), 4);
});

test('enforceOperationLimit rejects oversized results', () => {
  assert.deepEqual(enforceOperationLimit({ ok: true }), { ok: true });
  assert.throws(
    () => enforceOperationLimit({ text: 'x'.repeat(OPERATION_MAX_BYTES) }),
    (error) => error.code === 'E_RESULT_TOO_LARGE' && error.data.limit === OPERATION_MAX_BYTES,
  );
});

test('jsonByteLength handles primitives and objects', () => {
  assert.equal(jsonByteLength(null), 4);
  assert.equal(jsonByteLength(123), 3);
  assert.equal(jsonByteLength({ a: 1 }), 7);
  assert.equal(jsonByteLength([1, 2]), 5);
});

test('jsonByteLength returns Infinity for circular values', () => {
  const value = {};
  value.self = value;
  assert.equal(jsonByteLength(value), Infinity);
});

test('enforceOperationLimit message and data are stable', () => {
  try {
    enforceOperationLimit({ text: 'x'.repeat(OPERATION_MAX_BYTES) });
    assert.fail('should throw');
  } catch (error) {
    assert.match(error.message, /4\d{6}/);
    assert.equal(error.data.bytes > OPERATION_MAX_BYTES, true);
  }
});

test('enforceOperationLimit returns the original reference', () => {
  const value = { ok: true, nested: { n: 1 } };
  assert.equal(enforceOperationLimit(value), value);
});
