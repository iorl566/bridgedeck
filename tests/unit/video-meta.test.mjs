import test from 'node:test';
import assert from 'node:assert/strict';
import { base64OfBytes, chunksHavePosition, journalSummary, sha256Hex } from '../../extension/src/lib/video-meta.js';

test('journalSummary 输出稳定字段', () => {
  assert.equal(journalSummary(null), null);
  const summary = journalSummary({ fragmented: true, initBytes: 10, fragments: [1, 2], completeBytes: 20, trailingBytes: 3, completeFrames: false, openFragment: true });
  assert.deepEqual(summary, {
    fragmented: true,
    init_bytes: 10,
    fragments: 2,
    complete_bytes: 20,
    trailing_bytes: 3,
    complete_frames: false,
    open_fragment: true,
  });
});

test('chunksHavePosition 识别编码分片', () => {
  assert.equal(chunksHavePosition([{ index: 1 }, { position: 0 }]), true);
  assert.equal(chunksHavePosition([{ index: 1 }]), false);
  assert.equal(chunksHavePosition(null), false);
});

test('video-meta 哈希与 base64', async () => {
  assert.equal(base64OfBytes(new Uint8Array([104, 105])), 'aGk=');
  const hex = await sha256Hex(new Blob(['hi']));
  assert.equal(hex.length, 64);
  assert.match(hex, /^[0-9a-f]+$/);
});
