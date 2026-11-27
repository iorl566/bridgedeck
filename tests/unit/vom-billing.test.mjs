import test from 'node:test';
import assert from 'node:assert/strict';
import { createBillingLedger, registerBillingModel, listBillingModels, VOM_BILLING_MODEL } from '../../extension/src/lib/vom-billing.js';
import { setO200kData } from '../../extension/src/lib/o200k.js';

const SYNTHETIC = (() => {
  const lines = [];
  for (let byte = 0; byte < 256; byte += 1) lines.push(Buffer.from([byte]).toString('base64') + ' ' + byte);
  lines.push(Buffer.from('ab').toString('base64') + ' 300');
  return lines.join('\n');
})();
setO200kData(SYNTHETIC);

test('createBillingLedger 汇总节点 token', () => {
  const ledger = createBillingLedger([{ name: '提交', role: 'button', tag: 'button' }, { name: 'hello' }]);
  assert.equal(ledger.model, VOM_BILLING_MODEL);
  assert.equal(ledger.nodes, 2);
  assert.ok(ledger.totalTokens > 0);
  assert.ok(ledger.textTokens > 0);
  assert.equal(ledger.structuralTokens, 16);
});

test('createBillingLedger 空输入', () => {
  const ledger = createBillingLedger([]);
  assert.equal(ledger.totalTokens, 0);
  assert.equal(ledger.averageTokens, 0);
});

test('registerBillingModel 注入自定义 tokenizer', () => {
  const name = registerBillingModel('test-char', { text: (value) => String(value || '').length, unit: () => 5 });
  assert.equal(name, 'test-char');
  assert.ok(listBillingModels().includes('test-char'));
  const ledger = createBillingLedger([{ name: 'abc' }], { model: 'test-char' });
  assert.equal(ledger.totalTokens, 5);
});

test('o200k 模型使用真实词表估算', () => {
  const lines = [];
  for (let byte = 0; byte < 256; byte += 1) lines.push(Buffer.from([byte]).toString('base64') + ' ' + byte);
  lines.push(Buffer.from('ab').toString('base64') + ' 300');
  setO200kData(lines.join('\n'));
  const ledger = createBillingLedger([{ name: 'ab', role: 'button' }], { model: 'o200k' });
  assert.equal(ledger.model, 'o200k');
  assert.equal(ledger.textTokens, 8);
  assert.equal(ledger.totalTokens, 16);
});
