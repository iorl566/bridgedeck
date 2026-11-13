import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  SIGNATURE_ALG,
  SIGNATURE_ALG_ED25519,
  ed25519PublicKeyFromPrivate,
  publicKeyId,
  signRelease,
  signReleaseEd25519,
  verifyReleaseSignature,
} from '../../lib/release-sign.mjs';

function manifest(version = '0.1.2') {
  return {
    version,
    artifacts: [
      { name: 'b.zip', file: 'dist/b.zip', bytes: 2, sha256: 'b'.repeat(64) },
      { name: 'a.tar.gz', file: 'dist/a.tar.gz', bytes: 1, sha256: 'a'.repeat(64) },
    ],
  };
}

test('hmac signature verifies and rejects tampering', () => {
  const signed = { ...manifest(), signature: signRelease(manifest(), 'secret') };
  assert.equal(signed.signature.alg, SIGNATURE_ALG);
  assert.equal(verifyReleaseSignature(signed, 'secret'), true);
  assert.equal(verifyReleaseSignature(signed, 'wrong'), false);

  const tampered = { ...signed, version: '0.1.3' };
  assert.equal(verifyReleaseSignature(tampered, 'secret'), false);
});

test('ed25519 signature verifies with the derived public key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  const signed = { ...manifest(), signature: signReleaseEd25519(manifest(), privatePem) };
  assert.equal(signed.signature.alg, SIGNATURE_ALG_ED25519);
  assert.equal(signed.signature.keyId, publicKeyId(publicKey));
  assert.equal(verifyReleaseSignature(signed, publicPem), true);
  assert.equal(verifyReleaseSignature(signed, ed25519PublicKeyFromPrivate(privatePem)), true);

  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(verifyReleaseSignature(signed, other), false);
});

test('ed25519 signature rejects tampered artifacts and keyId', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  const signed = { ...manifest(), signature: signReleaseEd25519(manifest(), privatePem) };
  const tampered = {
    ...signed,
    artifacts: signed.artifacts.map((item) => (item.name === 'b.zip' ? { ...item, sha256: 'c'.repeat(64) } : item)),
  };
  assert.equal(verifyReleaseSignature(tampered, publicPem), false);

  const wrongId = { ...signed, signature: { ...signed.signature, keyId: '0000000000000000' } };
  assert.equal(verifyReleaseSignature(wrongId, publicPem), false);
});

test('canonical order does not depend on artifact input order', () => {
  const forward = manifest();
  const reversed = { ...forward, artifacts: [...forward.artifacts].reverse() };
  assert.equal(
    verifyReleaseSignature({ ...forward, signature: signRelease(forward, 'secret') }, 'secret'),
    true,
  );
  assert.equal(
    verifyReleaseSignature({ ...reversed, signature: signRelease(forward, 'secret') }, 'secret'),
    true,
  );
});
