import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncodedWriter } from '../../extension/src/lib/encoded-writer.js';
import { normalizeBudget } from '../../extension/src/lib/video-budget.js';

class FakeTransaction {
  constructor(puts) {
    this.puts = puts;
  }
  objectStore() {
    return {
      put: (value) => {
        this.puts.push(value);
      },
      clear: () => {
        this.puts.length = 0;
      },
    };
  }
  set oncomplete(handler) {
    queueMicrotask(handler);
  }
  set onerror(_handler) {
    // 不触发
  }
}

function fakeOpenDb(puts) {
  return async () => ({
    transaction: () => new FakeTransaction(puts),
    close: () => {},
  });
}

function setup(overrides = {}) {
  const parts = [];
  const appended = [];
  const puts = [];
  let clockValue = 1000;
  const meta = { recordingId: 'rec-w', startedAt: 1000, mime: 'video/mp4', tabId: 5 };
  const writer = createEncodedWriter({
    openDb: fakeOpenDb(puts),
    CHUNK_STORE: 'chunks',
    getEncodedMeta: () => meta,
    writeEncodedPart: async (id, sequence, position, data) => {
      parts.push({ id, sequence, position, bytes: data.byteLength });
      return overrides.writePart !== false;
    },
    appendSegment: async (id, segment, options) => {
      appended.push({ id, segment, options });
      if (overrides.appendThrows) throw new Error('manifest down');
      return { ok: true, persisted: true, code: null };
    },
    hash: overrides.hash || (async () => 'c'.repeat(64)),
    clock: () => clockValue,
    ...(overrides.budget ? { budget: overrides.budget } : {}),
  });
  return {
    writer,
    parts,
    appended,
    puts,
    meta,
    advance: (delta) => { clockValue += delta; },
    setClock: (value) => { clockValue = value; },
  };
}

test('storeEncodedChunk：写 OPFS 分片 + manifest 分片描述（index/atMs/bytes/codec/lastFrameAt/checksum）', async () => {
  const ctx = setup();
  const first = await ctx.writer.storeEncodedChunk('rec-w', 0, new Uint8Array(10));
  assert.equal(first.ok, true);
  assert.equal(first.index, 0);
  assert.equal(first.storage, 'opfs');
  assert.equal(first.segment.atMs, 0);
  assert.equal(first.segment.checksum, 'c'.repeat(64));
  assert.equal(first.segment.codec, 'avc');

  ctx.advance(1000);
  const second = await ctx.writer.storeEncodedChunk('rec-w', 10, new Uint8Array(20));
  assert.equal(second.ok, true);
  assert.equal(second.index, 1);
  assert.equal(second.segment.atMs, 1000);
  assert.equal(second.segment.lastFrameAt, 1000);

  assert.equal(ctx.parts.length, 2);
  assert.deepEqual(ctx.parts.map((item) => item.sequence), [0, 1]);
  assert.equal(ctx.appended.length, 2);
  assert.equal(ctx.appended[0].segment.bytes, 10);
  assert.equal(ctx.appended[1].segment.bytes, 20);
  assert.equal(ctx.appended[1].options.codec, 'avc');
  assert.equal(ctx.appended[1].options.startedAt, 1000);
  assert.deepEqual(ctx.writer.segments().map((item) => item.index), [0, 1]);
  assert.deepEqual(ctx.writer.summary(), {
    chunks: 0,
    encodedSegments: 2,
    encodedBytes: 30,
    segments: 2,
    lastAppend: { ok: true, code: null, index: 1, persisted: true },
  });
  assert.equal(ctx.writer.encodedBytes(), 30);
});

test('storeEncodedChunk：OPFS 写失败回退 IndexedDB，manifest 仍追加', async () => {
  const ctx = setup({ writePart: false });
  const result = await ctx.writer.storeEncodedChunk('rec-w', 0, new Uint8Array(8));
  assert.equal(result.ok, true);
  assert.equal(result.storage, 'idb');
  assert.equal(ctx.puts.length, 1);
  assert.equal(ctx.puts[0].key, 'enc:rec-w:00000000');
  assert.equal(ctx.puts[0].position, 0);
  assert.equal(ctx.puts[0].recordingId, 'rec-w');
  assert.equal(ctx.appended.length, 1);
  assert.equal(ctx.writer.lastAppend().ok, true);
});

test('storeEncodedChunk：manifest 追加异常/哈希异常不中断录制', async () => {
  const broken = setup({ appendThrows: true, hash: async () => { throw new Error('subtle down'); } });
  const result = await broken.writer.storeEncodedChunk('rec-w', 0, new Uint8Array(5));
  assert.equal(result.ok, true);
  assert.equal(result.segment.checksum, '');
  assert.equal(broken.writer.lastAppend(), null);
  // 哈希失败时仍会尝试追加（checksum 为空，由 manifest 层给 warning）
  assert.equal(broken.appended.length, 1);
  assert.equal(broken.appended[0].segment.checksum, '');
});

test('storeEncodedChunk：预算读数随分片返回（单段超限 → pause-segment）', async () => {
  const budget = normalizeBudget({ maxSegmentBytes: 64 * 1024, maxTotalBytes: 1024 * 1024 }).budget;
  const ctx = setup({ budget });
  const result = await ctx.writer.storeEncodedChunk('rec-w', 0, new Uint8Array(70 * 1024));
  assert.equal(result.ok, true);
  assert.equal(result.budget.action, 'pause-segment');
  assert.equal(result.budget.code, 'E_VIDEO_BUDGET_SEGMENT');
  assert.equal(result.budget.exceeded, 1);
});

test('storeChunk：MediaRecorder 分片走 IndexedDB 并带序号/时间', async () => {
  const ctx = setup();
  ctx.advance(250);
  const result = await ctx.writer.storeChunk(new Blob([new Uint8Array(4)]), ctx.meta);
  assert.equal(result.ok, true);
  assert.equal(result.index, 0);
  assert.equal(ctx.puts.length, 1);
  assert.equal(ctx.puts[0].key, 'rec-w:000000');
  assert.equal(ctx.puts[0].index, 0);
  assert.equal(ctx.puts[0].at, 1250);
  assert.equal(ctx.writer.currentChunkIndex(), 1);
  assert.equal(await ctx.writer.storeChunk(null, ctx.meta).then((item) => item.ok), false);
  assert.equal(await ctx.writer.storeChunk(new Blob([]), ctx.meta).then((item) => item.ok), false);
});

test('reset：清空分片计数/字节/摘要', async () => {
  const ctx = setup();
  await ctx.writer.storeEncodedChunk('rec-w', 0, new Uint8Array(10));
  ctx.advance(10);
  await ctx.writer.storeChunk(new Blob([new Uint8Array(2)]), ctx.meta);
  assert.equal(ctx.writer.currentChunkIndex(), 1);
  ctx.writer.reset();
  assert.equal(ctx.writer.currentChunkIndex(), 0);
  assert.equal(ctx.writer.encodedBytes(), 0);
  assert.deepEqual(ctx.writer.segments(), []);
  assert.equal(ctx.writer.lastAppend(), null);
  const after = await ctx.writer.storeEncodedChunk('rec-w', 0, new Uint8Array(3));
  assert.equal(after.index, 0);
});
