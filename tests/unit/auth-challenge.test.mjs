import test from 'node:test';
import assert from 'node:assert/strict';
import { authKeyId, authProof, verifyAuthProof } from '../../lib/auth-challenge.mjs';

test('keyId is stable and does not expose the token', () => {
  const id = authKeyId('secret-token');
  assert.equal(id.length, 32);
  assert.equal(id, authKeyId('secret-token'));
  assert.notEqual(id, 'secret-token');
});

test('proof verifies only for the matching token/challenge', () => {
  const proof = authProof('secret-token', 'nonce-1');
  assert.equal(verifyAuthProof('secret-token', 'nonce-1', proof), true);
  assert.equal(verifyAuthProof('wrong-token', 'nonce-1', proof), false);
  assert.equal(verifyAuthProof('secret-token', 'nonce-2', proof), false);
  assert.equal(verifyAuthProof('secret-token', 'nonce-1', '00'), false);
});
