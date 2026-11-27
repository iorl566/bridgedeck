import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyFragments, readContainerPrefix } from '../../extension/src/lib/video-verify.js';

function sha(buffer) {
  return createHash('sha256').update(Buffer.from(buffer)).digest('hex');
}

function blobOf(parts) {
  return new Blob(parts, { type: 'video/mp4' });
}

test('verifyFragments：按 bytes 切片并逐片校验 SHA-256', async () => {
  const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
  const blob = blobOf(parts);
  const fragments = parts.map((part, index) => ({ index, bytes: part.byteLength, sha256: sha(part) }));
  const result = await verifyFragments(blob, fragments);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.coveredBytes, 6);
  assert.equal(result.complete, true);
});

test('verifyFragments：篡改/缺哈希会报告', async () => {
  const blob = blobOf([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  const bad = [
    { index: 0, bytes: 2, sha256: sha(new Uint8Array([9, 9])) },
    { index: 1, bytes: 2 },
  ];
  const result = await verifyFragments(blob, bad);
  assert.equal(result.complete, true);
  assert.deepEqual(result.mismatches, [
    { index: 0, reason: 'mismatch' },
    { index: 1, reason: 'missing-hash' },
  ]);
});

test('verifyFragments：未覆盖完整 blob 时 complete=false', async () => {
  const blob = blobOf([new Uint8Array([1, 2, 3])]);
  const result = await verifyFragments(blob, [{ index: 0, bytes: 2, sha256: sha(new Uint8Array([1, 2])) }]);
  assert.equal(result.complete, false);
});

test('readContainerPrefix：只读前缀且不超过上限', async () => {
  const blob = blobOf([new Uint8Array(2048).fill(7)]);
  const prefix = await readContainerPrefix(blob, 64);
  assert.equal(prefix.byteLength, 64);
  assert.equal(prefix[0], 7);
});
