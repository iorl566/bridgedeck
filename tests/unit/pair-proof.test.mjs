import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEndpoint, pairProof, randomNonce, verifyPairProof } from '../../lib/pair-proof.mjs';

const ctx = {
  endpoint: 'ws://127.0.0.1:52900/ws',
  role: 'control',
  clientNonce: 'client-1',
  serverNonce: 'server-1',
};

test('endpoint 规范化', () => {
  assert.equal(normalizeEndpoint('ws://127.0.0.1:52900/ws/?x=1#h'), 'ws://127.0.0.1:52900/ws');
  assert.equal(normalizeEndpoint('not a url'), '');
});

test('证明可复算且绑定 endpoint/role/nonce', () => {
  const proof = pairProof('token-1', ctx);
  assert.match(proof, /^[0-9a-f]{64}$/);
  assert.equal(verifyPairProof('token-1', proof, ctx), true);
  assert.equal(verifyPairProof('token-1', proof, { ...ctx, endpoint: 'ws://evil:1/ws' }), false);
  assert.equal(verifyPairProof('token-1', proof, { ...ctx, role: 'read' }), false);
  assert.equal(verifyPairProof('token-1', proof, { ...ctx, serverNonce: 'server-2' }), false);
  assert.equal(verifyPairProof('token-2', proof, ctx), false);
});

test('缺字段/空输入返回空', () => {
  assert.equal(pairProof('', ctx), '');
  assert.equal(pairProof('token', { ...ctx, clientNonce: '' }), '');
  assert.equal(verifyPairProof('token', '', ctx), false);
  assert.equal(randomNonce().length, 32);
});
