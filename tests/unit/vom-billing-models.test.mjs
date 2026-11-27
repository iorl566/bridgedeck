import test from 'node:test';
import assert from 'node:assert/strict';
import { createBillingLedger, listBillingModels } from '../../extension/src/lib/vom-billing.js';

test('createBillingLedger 支持切换模型', () => {
  assert.ok(listBillingModels().includes('chars-per-4'));
  const a = createBillingLedger([{ name: '提交', role: 'button' }], { model: 'cjk-heuristic-v2' });
  const b = createBillingLedger([{ name: '提交', role: 'button' }], { model: 'chars-per-4' });
  assert.equal(a.model, 'cjk-heuristic-v2');
  assert.equal(b.model, 'chars-per-4');
  assert.notEqual(a.totalTokens, b.totalTokens);
});

test('未知模型报错', () => {
  assert.throws(() => createBillingLedger([], { model: 'nope' }), /未知 VOM billing model/);
});
