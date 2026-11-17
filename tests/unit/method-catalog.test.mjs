import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMethod, listMethods } from '../../lib/method-catalog.mjs';
import { METHOD_EFFECT } from '../../lib/protocol.mjs';

test('每个协议方法都有 catalog 解释', () => {
  const methods = listMethods();
  assert.equal(methods.length, Object.keys(METHOD_EFFECT).length);
  for (const entry of methods) {
    assert.ok(entry.feature, entry.method + ' 缺少 feature');
    assert.equal(typeof entry.receipt, 'boolean');
  }
  assert.equal(describeMethod('click').receipt, true);
  assert.equal(describeMethod('observe').receipt, false);
  assert.equal(describeMethod('cooperate.sync').feature, 'cooperation');
});
