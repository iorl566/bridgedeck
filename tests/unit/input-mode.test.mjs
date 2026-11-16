import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultInputMode } from '../../lib/input-mode.mjs';

test('默认原生输入，--synthetic 才降级', () => {
  assert.deepEqual(defaultInputMode({ ref: '@e1' }, {}), { ref: '@e1', trusted: true });
  assert.deepEqual(defaultInputMode({ ref: '@e1' }, { synthetic: true }), { ref: '@e1', trusted: false, synthetic: true });
  assert.deepEqual(defaultInputMode({ ref: '@e1', trusted: false }, {}), { ref: '@e1', trusted: true });
});
