import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { VIDEO_SEGMENT_CODES } from '../../extension/src/lib/video-manifest.js';

class FakeFileHandle {
  constructor(name, data = new Uint8Array()) {
    this.name = name;
    this.kind = 'file';
    this.data = data;
  }
  async getFile() {
    const data = this.data;
    return {
      size: data.byteLength,
      text: async () => new TextDecoder().decode(data),
      arrayBuffer: async () => data.slice().buffer,
    };
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (value) => {
        chunks.push(typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
      },
      close: async () => {
        const total = chunks.reduce((sum, item) => sum + item.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const item of chunks) {
          merged.set(item, offset);
          offset += item.byteLength;
        }
        this.data = merged;
      },
    };
  }
}

class FakeDirectoryHandle {
  constructor(name = 'root') {
    this.name = name;
    this.kind = 'directory';
    this.entries = new Map();
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    const existing = this.entries.get(name);
    if (existing && existing.kind === 'directory') return existing;
    if (!create) throw new Error('not found');
    const dir = new FakeDirectoryHandle(name);
    this.entries.set(name, dir);
    return dir;
  }
  async getFileHandle(name, { create = false } = {}) {
    const existing = this.entries.get(name);
    if (existing && existing.kind === 'file') return existing;
    if (!create) throw new Error('not found');
    const file = new FakeFileHandle(name);
    this.entries.set(name, file);
    return file;
  }
  async removeEntry(name, { recursive = false } = {}) {
    if (!this.entries.has(name)) throw new Error('not found');
    this.entries.delete(name);
    return recursive;
  }
  async *values() {
    for (const entry of this.entries.values()) yield entry;
  }
}

function installFakeOpfs() {
  const root = new FakeDirectoryHandle();
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { getDirectory: async () => root } },
    configurable: true,
    writable: true,
  });
  return root;
}

const store = await import('../../extension/src/lib/opfs-encoded-store.js');
const blobs = await import('../../extension/src/lib/encoded-blob.js');

function sha(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function segment(index, bytes, options = {}) {
  return {
    index,
    atMs: options.atMs != null ? options.atMs : index * 1000,
    bytes: bytes.byteLength,
    codec: 'avc',
    lastFrameAt: options.lastFrameAt != null ? options.lastFrameAt : index * 1000 + 500,
    checksum: sha(bytes),
  };
}

test('appendEncodedSegment：v1 manifest 升级为 v2 并持久化分片描述', async () => {
  installFakeOpfs();
  assert.equal(await store.writeEncodedManifest('r1', { tabId: 7, url: 'https://x', title: 'T', mime: 'video/mp4', startedAt: 100 }), true);
  const data0 = new Uint8Array([1, 2, 3]);
  const data1 = new Uint8Array([4, 5]);
  assert.equal(await store.writeEncodedPart('r1', 0, 0, data0), true);
  assert.equal(await store.writeEncodedPart('r1', 1, 3, data1), true);
  const first = await store.appendEncodedSegment('r1', segment(0, data0, { atMs: 0, lastFrameAt: 500 }));
  assert.equal(first.ok, true);
  assert.equal(first.persisted, true);
  const second = await store.appendEncodedSegment('r1', segment(1, data1, { atMs: 1000, lastFrameAt: 2000 }));
  assert.equal(second.ok, true);
  assert.equal(second.persisted, true);

  const manifest = await store.readSegmentManifest('r1');
  assert.equal(manifest.version, 2);
  assert.equal(manifest.recordingId, 'r1');
  assert.equal(manifest.tabId, 7);
  assert.equal(manifest.segments.length, 2);
  assert.equal(manifest.stats.bytes, 5);
  assert.equal(manifest.segments[1].checksum, sha(data1));

  const described = await store.describeEncodedRecording('r1');
  assert.equal(described.parts.length, 2);
  assert.equal(described.plan.recovered, true);
  assert.equal(described.plan.completeness, 'complete');
  assert.equal(described.plan.bytes, 5);

  const duplicate = await store.appendEncodedSegment('r1', segment(0, data0, { atMs: 5000, lastFrameAt: 6000 }));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, VIDEO_SEGMENT_CODES.SEGMENT_INDEX_DUPLICATE);
  assert.equal(duplicate.persisted, false);

  const regression = await store.appendEncodedSegment('r1', segment(2, new Uint8Array([9]), { atMs: 1, lastFrameAt: 2 }));
  assert.equal(regression.ok, false);
  assert.equal(regression.code, VIDEO_SEGMENT_CODES.SEGMENT_TIME_REGRESSION);

  const sealed = await store.sealEncodedManifestDetailed('r1', { endedAt: 2000, bytes: 5 });
  assert.equal(sealed.ok, true);
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.persisted, true);
  assert.equal(sealed.manifest.sealed, true);
  assert.equal(sealed.manifest.seal.digest.length, 64);
  assert.equal(sealed.manifest.seal.segments, 2);
  assert.equal(sealed.manifest.seal.durability, 'verified');
  const readBack = await store.readEncodedManifest('r1');
  assert.equal(readBack.sealed, true);
  assert.equal(readBack.bytes, 5);

  const sealedAppend = await store.appendEncodedSegment('r1', segment(2, new Uint8Array([9])));
  assert.equal(sealedAppend.ok, false);
  assert.equal(sealedAppend.code, VIDEO_SEGMENT_CODES.MANIFEST_SEALED);
  assert.equal(await store.sealEncodedManifest('r1', { bytes: 5 }), true);
});

test('sealEncodedManifestDetailed：连续性错误拒绝 seal，缺 manifest 返回结构化原因', async () => {
  installFakeOpfs();
  await store.writeSegmentManifest('bad', {
    version: 2,
    recordingId: 'bad',
    codec: 'avc',
    segments: [
      { index: 0, atMs: 0, bytes: 2, codec: 'avc', lastFrameAt: 1, checksum: 'a'.repeat(64) },
      { index: 2, atMs: 100, bytes: 2, codec: 'avc', lastFrameAt: 2, checksum: 'b'.repeat(64) },
    ],
  });
  const rejected = await store.sealEncodedManifestDetailed('bad');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, VIDEO_SEGMENT_CODES.SEAL_INVALID);
  assert.equal(rejected.persisted, false);
  const stillOpen = await store.readEncodedManifest('bad');
  assert.notEqual(stillOpen.sealed, true);

  const missing = await store.sealEncodedManifestDetailed('nope');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, VIDEO_SEGMENT_CODES.MANIFEST_MISSING);
  assert.equal(await store.sealEncodedManifest('nope'), false);

  const noSegments = await store.writeEncodedManifest('legacy', { tabId: 1 });
  assert.equal(noSegments, true);
  const legacySeal = await store.sealEncodedManifestDetailed('legacy', { bytes: 0 });
  assert.equal(legacySeal.ok, true);
  assert.equal(legacySeal.manifest.version, 2);
  assert.equal((await store.readEncodedManifest('legacy')).sealed, true);
});

test('describeEncodedRecording / scanEncodedRecordings：截断与缺片计划', async () => {
  installFakeOpfs();
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([4, 5, 6]);
  await store.writeSegmentManifest('trunc', { version: 2, recordingId: 'trunc', codec: 'avc', segments: [segment(0, a), segment(1, b, { atMs: 1000, lastFrameAt: 2000 })] });
  await store.writeEncodedPart('trunc', 0, 0, a);
  await store.writeEncodedPart('trunc', 1, 3, b.subarray(0, 2));

  const trunc = await store.describeEncodedRecording('trunc');
  assert.equal(trunc.plan.recovered, true);
  assert.equal(trunc.plan.completeness, 'partial');
  assert.equal(trunc.plan.truncatedSegments.length, 1);
  assert.equal(trunc.plan.bytes, 5);

  const assembled = await blobs.assembleEncodedRecording('trunc');
  assert.equal(assembled.assembly, 'manifest');
  assert.equal(assembled.ok, true);
  assert.equal(assembled.blob.size, 5);
  assert.deepEqual([...new Uint8Array(await assembled.blob.arrayBuffer())], [1, 2, 3, 4, 5]);
  const attached = await blobs.assembleEncodedBlob('trunc');
  assert.equal(attached.recovery.assembly, 'manifest');
  assert.equal(attached.recovery.plan.completeness, 'partial');

  const c = new Uint8Array([7, 8]);
  await store.writeSegmentManifest('gap', {
    version: 2,
    recordingId: 'gap',
    codec: 'avc',
    segments: [segment(0, a), segment(1, b, { atMs: 1000, lastFrameAt: 2000 }), segment(2, c, { atMs: 2000, lastFrameAt: 3000 })],
  });
  await store.writeEncodedPart('gap', 0, 0, a);
  await store.writeEncodedPart('gap', 2, 6, c);
  const gap = await store.describeEncodedRecording('gap');
  assert.equal(gap.plan.completeness, 'partial');
  assert.equal(gap.plan.keptSegments.length, 1);
  assert.equal(gap.plan.droppedSegments.length, 2);
  const gapAssembled = await blobs.assembleEncodedRecording('gap');
  assert.equal(gapAssembled.assembly, 'manifest');
  assert.deepEqual([...new Uint8Array(await gapAssembled.blob.arrayBuffer())], [1, 2, 3]);

  const scanned = await store.scanEncodedRecordings();
  assert.equal(scanned.length, 2);
  assert.equal(scanned.every((item) => item.manifest && item.plan), true);
  assert.equal(scanned.some((item) => item.plan.completeness === 'partial'), true);

  // 没有编码分片时返回 none（调用方回退 IndexedDB）
  const none = await blobs.assembleEncodedRecording('empty-rec');
  assert.equal(none.assembly, 'none');
  assert.equal(none.ok, false);
  assert.equal(await blobs.assembleEncodedBlob('empty-rec'), null);
});
