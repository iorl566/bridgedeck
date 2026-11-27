import test from 'node:test';
import assert from 'node:assert/strict';
import { findNonCaseFailures } from '../../lib/eval-e2e-extra.mjs';

const results = new Map([
  ['5b', { id: '5b', ok: true, detail: 'ok' }],
  ['35', { id: '35', ok: false, detail: 'timeout' }],
  ['23u', { id: '23u', ok: false, detail: 'uia' }],
]);

test('findNonCaseFailures 只报未列入 eval 的失败', () => {
  const extra = findNonCaseFailures([{ id: '5b' }, { id: '35' }], results);
  assert.deepEqual(extra, [{ id: '23u', detail: 'uia' }]);
});

test('findNonCaseFailures 用例失败不算额外失败', () => {
  assert.deepEqual(findNonCaseFailures([{ id: '5b' }, { id: '35' }, { id: '23u' }], results), []);
  assert.deepEqual(findNonCaseFailures([], results).length, 2);
});
