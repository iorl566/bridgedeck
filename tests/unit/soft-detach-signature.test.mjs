import test from 'node:test';
import assert from 'node:assert/strict';
import { sameSignature, signatureOfTab } from '../../extension/src/lib/soft-detach-signature.js';

test('同一页签名一致', () => {
  const a = signatureOfTab({ url: 'https://a.test/x', title: 'A', status: 'complete' });
  const b = signatureOfTab({ url: 'https://a.test/x', title: 'A', status: 'complete' });
  assert.equal(a, b);
  assert.equal(sameSignature(a, b), true);
});

test('URL/title 变化即不同', () => {
  const base = signatureOfTab({ url: 'https://a.test/x', title: 'A' });
  assert.notEqual(base, signatureOfTab({ url: 'https://a.test/y', title: 'A' }));
  assert.notEqual(base, signatureOfTab({ url: 'https://a.test/x', title: 'B' }));
  assert.equal(sameSignature(base, ''), false);
  assert.equal(sameSignature('', ''), false);
});

test('空输入安全', () => {
  assert.equal(signatureOfTab(null), '');
  assert.equal(signatureOfTab({}), signatureOfTab({ url: '', title: '', status: '' }));
});
