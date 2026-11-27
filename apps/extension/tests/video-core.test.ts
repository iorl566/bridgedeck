// tests/video-core.test.ts —— video 服务底层单测：状态机 / 容器与分片日记 / 哈希 / 清单 / 存储。
//
// 全部离线：不触达 chrome.*，也不起离屏文档。fixture MP4 用最小 ISO BMFF box 字节拼出来，
// 这样 faststart/fragmented 判定是「按真实字节」验证的，不是按 mime 猜的。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoStateMachine, restoreVideoStateMachine } from '../src/video/state.ts';
import {
  analyzeContainer,
  completeFragmentPackage,
  fragmentJournal,
  journalSummary,
  pickVideoMime,
} from '../src/video/mp4.ts';
import { base64FromBytes, bytesFromBase64, isSha256Hex, sha256Hex, toArrayBuffer } from '../src/video/hash.ts';
import { buildManifest, validateManifest } from '../src/video/manifest.ts';
import { chunkKey, createMemoryVideoStore, toPublicRecord } from '../src/video/store.ts';
import { verifyRecording } from '../src/video/verify.ts';
import type { FragmentEntry, VideoRecord } from '../src/video/types.ts';

// ---------------------------------------------------------------------------
// 最小 MP4 夹具
// ---------------------------------------------------------------------------

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  return concat([be32(8 + payload.length), asciiBytes(type), payload]);
}

/** ftyp + moov + mdat（faststart，非 fragmented）。 */
export function makeFaststartMp4(): Uint8Array {
  return concat([
    box('ftyp', concat([asciiBytes('isom'), new Uint8Array(4)])),
    box('moov', new Uint8Array(16)),
    box('mdat', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
  ]);
}

/** ftyp + mdat + moov（非 faststart）。 */
export function makeTailMoovMp4(): Uint8Array {
  return concat([
    box('ftyp', concat([asciiBytes('isom'), new Uint8Array(4)])),
    box('mdat', new Uint8Array([1, 2, 3, 4])),
    box('moov', new Uint8Array(16)),
  ]);
}

/** ftyp + moov + (moof + mdat) × 2（fragmented）。 */
export function makeFragmentedMp4(): Uint8Array {
  const parts: Uint8Array[] = [
    box('ftyp', concat([asciiBytes('isom'), new Uint8Array(4)])),
    box('moov', new Uint8Array(16)),
  ];
  for (let index = 0; index < 2; index += 1) {
    parts.push(box('moof', be32(index)));
    parts.push(box('mdat', new Uint8Array(6)));
  }
  return concat(parts);
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/** 一条完整记录的最小骨架（测试按需覆盖字段，避免每个用例重复 20 行）。 */
function createRecordShell(id: string): VideoRecord {
  return {
    id,
    tabId: 1,
    url: 'https://example.test/',
    title: 'fixture',
    startedAt: 1,
    endedAt: 2,
    mime: 'video/mp4',
    bytes: 0,
    completeness: 'complete',
    stop_reason: 'user',
    chunk_count: 1,
    fragments: [],
    finish_via: 'encoder',
    complete_frames: true,
    faststart: true,
    journal: null,
    durability: 'verified',
    durability_policy: 'browser-readback',
    fsync_supported: false,
    storage_persisted: true,
    storage_quota: null,
    storage_backend: 'memory',
    recording_state: 'ready',
    blob: new Blob([]),
  };
}

test('video-state：idle → recording → finalizing → ready 合法迁移', () => {
  let now = 1000;
  const machine = createVideoStateMachine({ id: 'rec-1', now: () => now });
  assert.equal(machine.state, 'idle');
  const started = machine.send('start', { reason: 'tabCapture' });
  assert.equal(started.ok, true);
  assert.equal(machine.state, 'recording');
  assert.equal(machine.startedAt, 1000);
  now = 1500;
  const stopping = machine.send('stop', { reason: 'user' });
  assert.equal(stopping.ok, true);
  assert.equal(machine.state, 'finalizing');
  const sealed = machine.send('seal', { reason: 'user', bytes: 1234 });
  assert.equal(sealed.ok, true);
  assert.equal(machine.state, 'ready');
  assert.equal(machine.elapsedMs(), 500);
  assert.equal(machine.snapshot().transitions.length, 3);
});

test('video-state：非法迁移不改变状态并给出证据', () => {
  const machine = createVideoStateMachine({ id: 'rec-2', now: () => 10 });
  const rejected = machine.send('stop');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.state, 'idle');
  assert.equal(rejected.evidence.rejection, 'illegal_transition');
  assert.deepEqual(rejected.evidence.allowed, ['start', 'recover']);
});

test('video-state：快照/还原 + 坏快照降级', () => {
  const machine = createVideoStateMachine({ id: 'rec-3', now: () => 100 });
  machine.send('start');
  machine.send('stop');
  const restored = restoreVideoStateMachine(machine.snapshot(), { now: () => 200 });
  assert.equal(restored.restored, true);
  assert.equal(restored.machine.id, 'rec-3');
  assert.equal(restored.machine.state, 'finalizing');
  assert.equal(restored.machine.startedAt, 100);

  const bad = restoreVideoStateMachine({ id: 'x', state: 'bogus' }, { now: () => 1 });
  assert.equal(bad.restored, false);
  assert.equal(bad.machine.state, 'idle');
  assert.equal((bad.evidence ?? {}).reason, 'bad_state');

  const missing = restoreVideoStateMachine(null, { now: () => 1, id: 'fallback' });
  assert.equal(missing.restored, false);
  assert.equal(missing.machine.id, 'fallback');
});

// ---------------------------------------------------------------------------
// 容器 / 分片日记
// ---------------------------------------------------------------------------

test('video-mp4：faststart 只有 moov 真在 mdat 前才为 true', () => {
  const fast = analyzeContainer(makeFaststartMp4());
  assert.equal(fast.format, 'mp4');
  assert.equal(fast.hasFtyp, true);
  assert.equal(fast.hasMoov, true);
  assert.equal(fast.fragmented, false);
  assert.equal(fast.faststart, true);

  const tail = analyzeContainer(makeTailMoovMp4());
  assert.equal(tail.faststart, false);
  assert.equal(tail.moovOffset !== null && tail.mdatOffset !== null && tail.moovOffset > tail.mdatOffset, true);
});

test('video-mp4：fMP4 分片日记按 moof+mdat 成对记录；容器层 moov 前置=true 但服务层不据此声明 faststart', () => {
  const fragmented = makeFragmentedMp4();
  const container = analyzeContainer(fragmented);
  assert.equal(container.fragmented, true);
  // 容器层只看 box 偏移：moov 在第一个 mdat 之前，所以 faststart=true；
  // 服务/离屏把「有 moof」排除在 faststart 声明之外（见 offscreen.ts assembleResult）。
  assert.equal(container.faststart, true);
  const journal = fragmentJournal(fragmented);
  assert.equal(journal.fragments.length, 2);
  assert.equal(journal.fragments[0]?.bytes, 8 + 4 + 8 + 6);
  assert.equal(journal.completeFrames, true);
  assert.equal(journal.completeBytes, fragmented.length);
  assert.equal(journal.initBytes, 16 + 24);
  const summary = journalSummary(journal);
  assert.equal(summary?.fragments, 2);
  assert.equal(summary?.complete_bytes, fragmented.length);
});

test('video-mp4：完帧裁切按 completeBytes 截断并过滤越界分片', () => {
  const raw = makeFaststartMp4();
  const journal = fragmentJournal(raw);
  // 人为制造尾部截断：completeBytes 指向 mdat 之前。
  const trimmedJournal = { ...journal, completeBytes: journal.completeBytes - 4 };
  const fragments: FragmentEntry[] = [
    { index: 0, at: 1, bytes: 4, sha256: 'a'.repeat(64) },
    { index: 1, at: 2, bytes: 999, sha256: 'b'.repeat(64) },
  ];
  const packaged = completeFragmentPackage(raw, trimmedJournal, fragments);
  assert.equal(packaged.bytes.length, trimmedJournal.completeBytes);
  assert.equal(packaged.trimmedBytes, 4);
  assert.equal(packaged.fragments.length, 1);
  assert.equal(packaged.chunkCount, 1);
});

test('video-mp4：mime 选择按真实支持情况，不硬编 mp4', () => {
  assert.equal(pickVideoMime(() => true), 'video/mp4;codecs=avc1.42E01E');
  assert.equal(pickVideoMime((mime) => mime === 'video/webm;codecs=vp9'), 'video/webm;codecs=vp9');
  assert.equal(pickVideoMime(() => false), '');
});

// 关键证据（E2E 20c2 / 35 的 faststart 断言）：离屏编码器用的 mediabunny
// `Mp4OutputFormat({ fastStart: 'in-memory' })` 产出的确实是 moov 前置、无 moof 的文件。
// 这里在 Node 里用同一库 + 同参数直接 mux 一段合成 AVC packet，再用本模块的容器分析/verify 复核，
// 保证「faststart 不是配置自称，而是字节事实」。
test('video-mp4：mediabunny fastStart:in-memory 真实产出 ftyp/moov/mdat（无 moof）且 verify 通过', async () => {
  const { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } = await import('mediabunny');
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const source = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(source);
  await output.start();
  const avcC = new Uint8Array([1, 0x42, 0xe0, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x1e, 0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80]);
  const decoderConfig = { codec: 'avc1.42E01E', codedWidth: 1280, codedHeight: 800, description: avcC };
  const sample = new Uint8Array([0, 0, 0, 3, 0x65, 0x88, 0x84]);
  for (let index = 0; index < 12; index += 1) {
    const packet = new EncodedPacket(sample, index === 0 ? 'key' : 'delta', index / 10, 1 / 10);
    await source.add(packet, index === 0 ? { decoderConfig } : undefined);
  }
  await output.finalize();
  const bytes = new Uint8Array(target.buffer as ArrayBuffer);

  const container = analyzeContainer(bytes);
  assert.equal(container.format, 'mp4');
  assert.equal(container.hasMoov, true);
  assert.equal(container.hasMoof, false);
  assert.equal(container.faststart, true);
  assert.equal((container.moovOffset ?? -1) >= 0 && (container.moovOffset ?? -1) < (container.mdatOffset ?? -1), true);
  assert.deepEqual(container.boxes.slice(0, 3), ['ftyp', 'moov', 'mdat']);
  const journal = fragmentJournal(bytes);
  assert.equal(journal.completeFrames, true);

  const digest = await sha256Hex(bytes);
  const record: VideoRecord = {
    ...createRecordShell('rec-mux'),
    bytes: bytes.length,
    fragments: [{ index: 0, at: 1, bytes: bytes.length, sha256: digest }],
    blob: new Blob([toArrayBuffer(bytes)], { type: 'video/mp4' }),
  };
  const report = await verifyRecording(record);
  assert.equal(report.verified, true);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.container.format, 'mp4');
  assert.equal(report.container.faststart, true);
  assert.equal(report.journal?.fragments, 0);
});

// ---------------------------------------------------------------------------
// 哈希 / base64
// ---------------------------------------------------------------------------

test('video-hash：sha256 十六进制与 base64 往返', async () => {
  const digest = await sha256Hex(asciiBytes('abc'));
  assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(isSha256Hex(digest), true);
  assert.equal(isSha256Hex('not-a-hash'), false);

  const bytes = new Uint8Array([0, 1, 2, 254, 255, 65, 66, 67]);
  const encoded = base64FromBytes(bytes);
  assert.deepEqual(Array.from(bytesFromBase64(encoded)), Array.from(bytes));
});

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

test('video-manifest：构建后可校验；字节/分片数被篡改则报问题', () => {
  const fragments: FragmentEntry[] = [
    { index: 0, at: 1, bytes: 5, sha256: 'c'.repeat(64) },
    { index: 1, at: 2, bytes: 7, sha256: 'd'.repeat(64) },
  ];
  const manifest = buildManifest({
    recordingId: 'rec-m',
    mime: 'video/mp4',
    startedAt: 10,
    endedAt: 20,
    bytes: 12,
    completeness: 'complete',
    stopReason: 'user',
    finishVia: 'encoder',
    faststart: true,
    fragments,
    completeBytes: 12,
    storageBackend: 'indexeddb',
  });
  assert.equal(manifest.version, 1);
  assert.equal(manifest.fragmentCount, 2);
  const ok = validateManifest(manifest);
  assert.equal(ok.ok, true);

  const tampered = validateManifest({ ...manifest, bytes: 99, fragmentCount: 5 });
  assert.equal(tampered.ok, false);
  assert.deepEqual(tampered.problems.map((item) => item.code).sort(), ['MANIFEST_BYTES', 'MANIFEST_COUNT']);
});

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

function fakeRecord(id: string, overrides: Partial<VideoRecord> = {}): VideoRecord {
  const bytes = makeFaststartMp4();
  return {
    id,
    tabId: 1,
    url: 'https://example.test/',
    title: 'fixture',
    startedAt: 100,
    endedAt: 200,
    mime: 'video/mp4',
    bytes: bytes.length,
    completeness: 'complete',
    stop_reason: 'user',
    chunk_count: 1,
    fragments: [{ index: 0, at: 100, bytes: bytes.length, sha256: 'e'.repeat(64) }],
    finish_via: 'encoder',
    complete_frames: true,
    faststart: true,
    journal: null,
    durability: 'verified',
    durability_policy: 'browser-readback',
    fsync_supported: false,
    storage_persisted: true,
    storage_quota: 1024,
    storage_backend: 'memory',
    recording_state: 'ready',
    sealed: true,
    seal: { at: 200 },
    blob: new Blob([toArrayBuffer(bytes)], { type: 'video/mp4' }),
    ...overrides,
  };
}

test('video-store：内存实现记录/分片 CRUD 与公开面剥离 blob', async () => {
  const store = createMemoryVideoStore();
  await store.putRecord(fakeRecord('rec-a'));
  await store.putRecord(fakeRecord('rec-b', { startedAt: 300 }));
  const list = await store.listRecords();
  assert.equal(list.length, 2);
  assert.ok(await store.getRecord('rec-a'));

  const publicRecord = toPublicRecord(fakeRecord('rec-a'));
  assert.equal('blob' in publicRecord, false);
  assert.equal(publicRecord.id, 'rec-a');

  const key = chunkKey('rec-a', 2);
  assert.equal(key, 'rec-a:000002');
  const chunk = {
    key,
    recordingId: 'rec-a',
    index: 2,
    at: 5,
    meta: { recordingId: 'rec-a', mime: 'video/mp4' },
    blob: new Blob([new Uint8Array([1, 2, 3])]),
  };
  await store.putChunks([chunk, { ...chunk, key: chunkKey('rec-a', 1), index: 1 }]);
  const chunks = await store.listChunks('rec-a');
  assert.deepEqual(chunks.map((item) => item.index), [1, 2]);
  await store.clearChunks('rec-a');
  assert.equal((await store.listChunks()).length, 0);
  await store.deleteRecord('rec-a');
  assert.equal(await store.getRecord('rec-a'), null);
});
