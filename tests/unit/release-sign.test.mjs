import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRelease, signRelease, verifyReleaseSignature } from '../../lib/release-sign.mjs';

const manifest = {
  version: '0.1.1',
  generatedAt: 'ignored',
  artifacts: [
    { name: 'b.zip', file: 'dist/b.zip', bytes: 2, sha256: 'bb' },
    { name: 'a.zip', file: 'dist/a.zip', bytes: 1, sha256: 'aa' },
  ],
};

test('canonical release ignores generatedAt and sorts artifacts', () => {
  const a = canonicalRelease(manifest);
  const b = canonicalRelease({ ...manifest, generatedAt: 'different' });
  assert.equal(a, b);
  assert.match(a, /"name":"a.zip".*"name":"b.zip"/);
});

test('sign and verify roundtrip', () => {
  const signature = signRelease(manifest, 'secret');
  assert.equal(signature.alg, 'hmac-sha256');
  const signed = { ...manifest, signature };
  assert.equal(verifyReleaseSignature(signed, 'secret'), true);
  assert.equal(verifyReleaseSignature(signed, 'wrong'), false);
});

test('tampered artifact fails verification', () => {
  const signed = { ...manifest, signature: signRelease(manifest, 'secret') };
  signed.artifacts = [{ ...signed.artifacts[0], bytes: 999 }, signed.artifacts[1]];
  assert.equal(verifyReleaseSignature(signed, 'secret'), false);
});
