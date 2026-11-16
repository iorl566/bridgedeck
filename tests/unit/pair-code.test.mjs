import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairCode, normalizePairCode, pairCodeMatches } from '../../lib/pair-code.mjs';

test('6 位配对码格式与比较', () => {
  const code = createPairCode();
  assert.match(code, /^\d{6}$/);
  assert.equal(normalizePairCode(' 12 34 56 '), '123456');
  assert.equal(normalizePairCode('12345'), '');
  assert.equal(normalizePairCode('abcdef'), '');
  assert.equal(pairCodeMatches(code, code), true);
  assert.equal(pairCodeMatches(code, code === '000000' ? '000001' : '000000'), false);
  assert.equal(pairCodeMatches('', ''), false);
});
