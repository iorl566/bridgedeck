import test from 'node:test';
import assert from 'node:assert/strict';
import { checkActionPolicy, isMutatingAction, originOf } from '../../extension/src/lib/action-policy.js';

test('只读白名单与 fail-closed', () => {
  assert.equal(isMutatingAction('observe'), false);
  assert.equal(isMutatingAction('screenshot'), false);
  assert.equal(isMutatingAction('click'), true);
  assert.equal(isMutatingAction('unknown.future'), true);
});

test('readOnly 拒绝变更、允许读取', () => {
  assert.equal(checkActionPolicy('observe', { readOnly: true }), null);
  assert.equal(checkActionPolicy('click', { readOnly: true }).code, 'E_READ_ONLY');
  assert.equal(checkActionPolicy('tab.policy', { readOnly: true }), null);
});

test('allowedOrigins 只拦导航类动作', () => {
  const allowed = ['https://ok.test'];
  assert.equal(checkActionPolicy('navigate', { allowedOrigins: allowed, url: 'https://ok.test/a' }), null);
  assert.equal(checkActionPolicy('navigate', { allowedOrigins: allowed, url: 'https://bad.test/a' }).code, 'E_FORBIDDEN');
  assert.equal(checkActionPolicy('click', { allowedOrigins: allowed, url: 'https://bad.test/a' }), null);
});

test('originOf 规范化', () => {
  assert.equal(originOf('https://a.test/x'), 'https://a.test');
  assert.equal(originOf('not a url'), '');
});
