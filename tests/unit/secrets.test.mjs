import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSecretName, redactFillResult, resolveSecretValue } from '../../lib/secrets.mjs';

const env = { BB_SECRET_PASSWORD: 's3cret', BB_SECRET_API_KEY: 'token' };

test('secret 名称归一化与占位符解析', () => {
  assert.equal(normalizeSecretName('api-key'), 'API_KEY');
  assert.deepEqual(resolveSecretValue({ secret: 'password' }, env), { value: 's3cret', used: true, name: 'PASSWORD' });
  assert.deepEqual(resolveSecretValue({ value: 'x-{{secret:api_key}}-y' }, env), { value: 'x-token-y', used: true, name: '' });
  assert.deepEqual(resolveSecretValue({ value: 'plain' }, env), { value: 'plain', used: false, name: '' });
  assert.throws(() => resolveSecretValue({ secret: 'missing' }, env), /BB_SECRET_MISSING/);
  assert.throws(() => resolveSecretValue({ secret: 'x', value: 'y' }, env), /不能同时/);
});

test('填充结果脱敏', () => {
  assert.deepEqual(redactFillResult({ actual_value: 's3cret', ok: true }), { actual_value: '********', ok: true, redacted: true });
});
