import test from 'node:test';
import assert from 'node:assert/strict';

class FakeFileHandle {
  constructor(name, data = new Uint8Array()) { this.name = name; this.kind = 'file'; this.data = data; }
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
        for (const item of chunks) { merged.set(item, offset); offset += item.byteLength; }
        this.data = merged;
      },
    };
  }
}

class FakeDirectoryHandle {
  constructor(name = 'root') { this.name = name; this.kind = 'directory'; this.entries = new Map(); }
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
    if (recursive) { this.entries.delete(name); return; }
    if (this.entries.has(name)) { this.entries.delete(name); return; }
    throw new Error('not found');
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

test('OPFS manifest 往返 + 残留扫描', async () => {
  const root = installFakeOpfs();
  assert.equal(await store.writeEncodedManifest('r1', { tabId: 7, url: 'https://x', title: 'T', mime: 'video/mp4' }), true);
  assert.equal(await store.writeEncodedPart('r1', 0, 0, new Uint8Array([1, 2, 3])), true);
  assert.equal(await store.writeEncodedPart('r1', 1, 3, new Uint8Array([4, 5])), true);
  const manifest = await store.readEncodedManifest('r1');
  assert.equal(manifest.recordingId, 'r1');
  assert.equal(manifest.tabId, 7);
  const manifests = await store.listEncodedManifests();
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].recordingId, 'r1');
  assert.equal(manifests[0].parts, 2);
  const parts = await store.listEncodedParts('r1');
  assert.deepEqual(parts.map((item) => item.position), [0, 3]);
  const blob = await store.assembleEncodedParts(parts);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4, 5]);
  assert.equal(await store.clearEncodedParts('r1'), true);
  assert.deepEqual(await store.listEncodedManifests(), []);
  assert.ok(root);
});

test('assembleEncodedParts 按 position 补零', async () => {
  const blob = await store.assembleEncodedParts([
    { position: 2, blob: new Blob([new Uint8Array([9])]) },
    { position: 0, blob: new Blob([new Uint8Array([7])]) },
  ]);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [7, 0, 9]);
  assert.equal(await store.assembleEncodedParts([]), null);
});

test('verifyEncodedParts 校验连续性与字节数', async () => {
  installFakeOpfs();
  await store.writeEncodedPart('v1', 0, 0, new Uint8Array([1, 2, 3]));
  await store.writeEncodedPart('v1', 1, 3, new Uint8Array([4, 5]));
  const ok = await store.verifyEncodedParts('v1');
  assert.deepEqual(ok, { ok: true, parts: 2, bytes: 5 });
  await store.writeEncodedPart('v2', 0, 4, new Uint8Array([9]));
  const gap = await store.verifyEncodedParts('v2');
  assert.equal(gap.ok, false);
  assert.equal(gap.reason, 'gap');
  assert.deepEqual(await store.verifyEncodedParts('none'), { ok: false, reason: 'empty', parts: 0, bytes: 0 });
});


test('sealEncodedManifest 标记 sealed', async () => {
  installFakeOpfs();
  await store.writeEncodedManifest('s1', { tabId: 1, createdAt: 1 });
  await store.writeEncodedPart('s1', 0, 0, new Uint8Array([1]));
  assert.equal(await store.sealEncodedManifest('s1', { bytes: 1 }), true);
  const manifest = await store.readEncodedManifest('s1');
  assert.equal(manifest.sealed, true);
  assert.equal(manifest.bytes, 1);
  const listed = await store.listEncodedManifests();
  assert.equal(listed[0].sealed, true);
});
