import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTextFrame, frameBytes } from '../../lib/transport-frame.mjs';

test('decodeTextFrame parses valid JSON', () => {
  const result = decodeTextFrame('{"type":"hello"}');
  assert.equal(result.ok, true);
  assert.equal(result.value.type, 'hello');
  assert.equal(result.bytes, 16);
});

test('decodeTextFrame rejects invalid JSON', () => {
  const result = decodeTextFrame('{bad');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_BAD_JSON');
});

test('decodeTextFrame enforces max bytes', () => {
  const big = 'x'.repeat(100);
  const result = decodeTextFrame(big, { maxBytes: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_TOO_LARGE');
  assert.equal(frameBytes(big), 100);
});
