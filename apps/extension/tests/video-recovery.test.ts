// tests/video-recovery.test.ts —— 第八批 V：视频真实链路回归（字节传输 / 失败清理 / prune+recover）。
//
// 覆盖 tools/e2e.mjs 里真实暴露过的断点：
// - 20c/35r：chrome.runtime.sendMessage 是 JSON 序列化，Uint8Array 会变数字键对象 →
//   离屏结果必须走 data_base64；service 侧要能解码（并兼容同上下文 Uint8Array / 旧数字键对象）。
// - 20c2/20g/35：失败/超时/离屏 error 后的僵尸活动录制必须被清掉，新 start 不被永久阻塞。
// - 35r：video list 只读 store，不因离屏文档/结果缺失整体报错；prune/recover 在失败过的状态仍可用。

import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoService, type VideoCdp } from '../src/video/service.ts';
import { createMemoryVideoStore } from '../src/video/store.ts';
import { createStorageAdapter, type OffscreenPort, type StorageAreaLike } from '../src/video/runtime.ts';
import { sha256Hex, toArrayBuffer } from '../src/video/hash.ts';
import { fragmentJournal, journalSummary } from '../src/video/mp4.ts';
import {
  decodeOffscreenResultBytes,
  encodeOffscreenResult,
  type OffscreenRecordingResult,
} from '../src/video/offscreen-protocol.ts';
import type { VideoRecord } from '../src/video/types.ts';

// ---------------------------------------------------------------------------
// 最小 MP4 夹具（faststart：ftyp → moov → mdat）
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
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  return concat([be32(8 + payload.length), asciiBytes(type), payload]);
}

function makeFaststartMp4(): Uint8Array {
  return concat([
    box('ftyp', concat([asciiBytes('isom'), new Uint8Array(4)])),
    box('moov', new Uint8Array(16)),
    box('mdat', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
  ]);
}

// ---------------------------------------------------------------------------
// fake 运行时
// ---------------------------------------------------------------------------

type Reply = unknown | ((message: Record<string, unknown>) => unknown);

class FakePort implements OffscreenPort {
  readonly documentAvailable = true;
  posts: Array<Record<string, unknown>> = [];
  ensureCount = 0;
  closeCount = 0;
  replies = new Map<string, Reply>();
  handlers: Array<(message: Record<string, unknown>) => void> = [];

  async ensure(): Promise<void> { this.ensureCount += 1; }
  async close(): Promise<void> { this.closeCount += 1; }
  async post<T = Record<string, unknown>>(message: Record<string, unknown>): Promise<T | null> {
    this.posts.push(message);
    const type = String(message.type ?? '');
    if (!this.replies.has(type)) return { ok: true } as T;
    const reply = this.replies.get(type);
    return (typeof reply === 'function' ? (reply as (value: Record<string, unknown>) => unknown)(message) : reply) as T;
  }
  onMessage(handler: (message: Record<string, unknown>) => void): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((item) => item !== handler); };
  }
  emit(message: Record<string, unknown>): void {
    for (const handler of this.handlers) handler(message);
  }
  lastPost(type: string): Record<string, unknown> | null {
    return this.posts.filter((item) => item.type === type).at(-1) ?? null;
  }
  countPosts(type: string): number {
    return this.posts.filter((item) => item.type === type).length;
  }
}

class FakeCdp implements VideoCdp {
  sends: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = [];
  handlers = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  released: string[] = [];

  async send(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sends.push({ tabId, method, params });
    return {};
  }
  onEvent(tabId: number, method: string, handler: (params: Record<string, unknown>) => void): () => void {
    const key = tabId + ':' + method;
    this.handlers.set(key, [...(this.handlers.get(key) ?? []), handler]);
    return () => {};
  }
  async acquire(): Promise<void> {}
  release(_tabId: number, feature: string): void { this.released.push(feature); }
  emit(tabId: number, method: string, params: Record<string, unknown>): void {
    for (const handler of this.handlers.get(tabId + ':' + method) ?? []) handler(params);
  }
  called(method: string): boolean { return this.sends.some((item) => item.method === method); }
}

function createFakeArea(): StorageAreaLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys?: string | string[] | null) {
      if (keys === undefined || keys === null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items: Record<string, unknown>) { Object.assign(data, items); },
    async remove(keys: string | string[]) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete data[key];
    },
  };
}

interface HarnessOptions {
  tabCaptureError?: Error;
  withCdp?: boolean;
  now?: () => number;
}

function createHarness(options: HarnessOptions = {}) {
  const store = createMemoryVideoStore();
  const port = new FakePort();
  const area = createFakeArea();
  const cdp = options.withCdp ? new FakeCdp() : undefined;
  let idSeed = 0;
  const service = new VideoService({
    tabs: {
      async get(tabId: number) {
        if (tabId !== 7) throw new Error('No tab with id ' + tabId);
        return { id: 7, url: 'https://example.test/page', title: 'Fixture', windowId: 1 };
      },
    },
    port,
    store,
    storage: createStorageAdapter(area),
    tabCapture: {
      async getMediaStreamId() {
        if (options.tabCaptureError) throw options.tabCaptureError;
        return 'stream-1';
      },
    },
    ...(cdp ? { cdp } : {}),
    now: options.now ?? (() => 1_000_000),
    newId: () => 'rec-test-' + String(++idSeed),
    probeStorage: async (backend) => ({ backend, persisted: true, quota: 2048, usage: 3 }),
  });
  service.attach();
  return { service, store, port, area, cdp };
}

function flush(ms = 15): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await flush(10);
  }
  throw new Error('waitFor 超时');
}

async function makeOffscreenResult(overrides: Partial<OffscreenRecordingResult> = {}): Promise<OffscreenRecordingResult> {
  const data = makeFaststartMp4();
  const sha = await sha256Hex(data);
  return {
    ok: true,
    id: 'rec-test-1',
    tabId: 7,
    url: 'https://example.test/page',
    title: 'Fixture',
    startedAt: 1_000_000,
    endedAt: 1_002_000,
    mime: 'video/mp4',
    data,
    completeness: 'complete',
    stop_reason: 'user',
    chunk_count: 1,
    fragments: [{ index: 0, at: 1_000_000, bytes: data.length, sha256: sha }],
    finish_via: 'encoder',
    complete_frames: true,
    faststart: true,
    journal: journalSummary(fragmentJournal(data)),
    mode: 'frames',
    ...overrides,
  };
}

/** 真实浏览器 messaging 的等价物：JSON 序列化后再解码（Uint8Array 会变成数字键对象）。 */
function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function fakeStoredRecord(id: string, overrides: Partial<VideoRecord> = {}): VideoRecord {
  const data = makeFaststartMp4();
  return {
    id,
    tabId: 7,
    url: 'https://example.test/page',
    title: 'Fixture',
    startedAt: 100,
    endedAt: 200,
    mime: 'video/mp4',
    bytes: data.length,
    completeness: 'complete',
    stop_reason: 'user',
    chunk_count: 1,
    fragments: [{ index: 0, at: 100, bytes: data.length, sha256: 'f'.repeat(64) }],
    finish_via: 'encoder',
    complete_frames: true,
    faststart: true,
    journal: null,
    durability: 'verified',
    durability_policy: 'browser-readback',
    fsync_supported: false,
    storage_persisted: true,
    storage_quota: 2048,
    storage_backend: 'memory',
    recording_state: 'ready',
    blob: new Blob([toArrayBuffer(data)], { type: 'video/mp4' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) 字节传输：base64 线格式 + 兼容旧数字键对象
// ---------------------------------------------------------------------------

test('video-transport：encodeOffscreenResult → JSON → decode 字节完全一致', async () => {
  const result = await makeOffscreenResult();
  const wire = jsonRoundTrip(encodeOffscreenResult(result)) as Record<string, unknown>;
  assert.equal(wire.data, undefined, '线格式不应带 Uint8Array');
  assert.equal(typeof wire.data_base64, 'string');
  assert.equal(wire.data_bytes, result.data.length);
  const decoded = decodeOffscreenResultBytes(wire);
  assert.equal(decoded.reason, null);
  assert.ok(decoded.bytes);
  assert.deepEqual(Array.from(decoded.bytes), Array.from(result.data));
});

test('video-transport：缺字节时给出结构化 transport 证据（不伪造）', async () => {
  const missing = decodeOffscreenResultBytes({ ok: true, id: 'r1' });
  assert.equal(missing.bytes, null);
  assert.match(String(missing.reason), /缺少视频字节/);
  assert.equal(missing.transport.has_base64, false);
  assert.equal(missing.transport.data_shape, 'undefined');

  // 旧实现：Uint8Array 被 JSON 序列化成数字键对象 → 仍能重建（兼容历史回包）。
  const result = await makeOffscreenResult();
  const legacy: Record<string, string> = {};
  for (let i = 0; i < result.data.length; i += 1) legacy[String(i)] = String(result.data[i]);
  const rebuilt = decodeOffscreenResultBytes({ ok: true, id: 'r1', data: jsonRoundTrip(legacy) });
  assert.ok(rebuilt.bytes);
  assert.deepEqual(Array.from(rebuilt.bytes), Array.from(result.data));
});

// ---------------------------------------------------------------------------
// 2) tabCapture 被拒 → CDP 截帧兜底 → base64 DONE → status ready（20c 链路）
// ---------------------------------------------------------------------------

test('video-recovery：tabCapture 拒绝 → CDP 截帧兜底 → base64 回包 → bytes>0/ready（20c）', async () => {
  const { service, port, store, cdp } = createHarness({
    withCdp: true,
    tabCaptureError: new Error('Extension has not been invoked for the current page'),
  });
  port.replies.set('bb.rec.start-frames', { ok: true, mime: 'video/mp4', startedAt: 1_000_000, mode: 'frames', encoder: 'avc' });
  const started = await service.start({ tabId: 7, durationMs: 3000 });
  assert.equal(started.mode, 'debugger', 'tabCapture 拒绝后必须走调试器截帧');
  assert.equal(started.mime, 'video/mp4');
  assert.equal(cdp?.called('Page.startScreencast'), true);
  assert.equal(port.lastPost('bb.rec.start'), null);

  // fake CDP 帧序列 → service 转发给离屏（data URL）。
  cdp?.emit(7, 'Page.screencastFrame', { data: 'AAAA', sessionId: 1 });
  cdp?.emit(7, 'Page.screencastFrame', { data: 'BBBB', sessionId: 2 });
  await waitFor(() => port.countPosts('bb.rec.frame') === 2);
  assert.equal(port.lastPost('bb.rec.frame')?.data, 'data:image/jpeg;base64,BBBB');
  assert.equal(cdp?.called('Page.screencastFrameAck'), true);

  // 离屏结果按真实 messaging 走一圈（JSON）：Uint8Array 必须被换成 base64。
  const result = await makeOffscreenResult();
  const wire = jsonRoundTrip(encodeOffscreenResult(result)) as Record<string, unknown>;
  port.emit({ from: 'offscreen', type: 'bb.rec.done', result: wire });
  await waitFor(async () => (await store.listRecords()).length === 1);

  const status = await service.status({ recording: 'rec-test-1' });
  assert.equal(status.active, false);
  assert.equal(status.state, 'ready');
  assert.equal(status.completeness, 'complete');
  assert.equal(status.faststart, true);
  assert.equal(status.finish_via, 'encoder');
  const fragments = status.fragments as Array<{ bytes?: number; sha256?: string }>;
  assert.ok(Array.isArray(fragments) && fragments.length >= 1);
  assert.ok(fragments.every((item) => Number(item.bytes) > 0 && /^[0-9a-f]{64}$/.test(String(item.sha256))));
  assert.equal(Number(status.bytes), result.data.length);

  const fetched = await service.fetch({ recording: 'rec-test-1' });
  const saved = Buffer.from(String(fetched.base64), 'base64');
  assert.deepEqual(Array.from(saved.subarray(0, 8)), Array.from(result.data.subarray(0, 8)));
  assert.equal(saved.subarray(4, 8).toString('ascii'), 'ftyp');
});

// ---------------------------------------------------------------------------
// 3) 离屏 error / 结果缺字节：清活动态，后续 start 不被永久阻塞（20c2/20g/35）
// ---------------------------------------------------------------------------

test('video-recovery：离屏结果缺字节 → 清活动态 + list 不抛错 + 下一次 start 成功', async () => {
  const { service, port, area, store } = createHarness();
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: 1_000_000, mode: 'stream' });
  await service.start({ tabId: 7, durationMs: 3000 });
  assert.equal(service.phase(), 'recording');

  // 模拟 JSON 传输丢字节（旧 bug 的形状）：id 有、data 没有。
  port.emit({
    from: 'offscreen',
    type: 'bb.rec.done',
    result: { ok: true, id: 'rec-test-1', mime: 'video/mp4', fragments: [], endedAt: 1_002_000 },
  });
  await waitFor(() => service.describe().active === null);
  assert.equal(area.data['bb.video.active'], undefined);
  assert.equal((await store.listRecords()).length, 0);
  assert.match(String(service.describe().last_error), /缺少视频字节/);

  const listed = await service.list();
  assert.deepEqual(listed.recordings, [], 'list 不应因离屏缺失整体报错');
  const status = await service.status({});
  assert.equal(status.active, false);
  assert.equal(status.state, 'none');

  // 新 start 不再被僵尸挡住。
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: 2_000_000, mode: 'stream' });
  const again = await service.start({ tabId: 7 });
  assert.equal(again.recordingId, 'rec-test-2');
  assert.equal(service.phase(), 'recording');
});

// ---------------------------------------------------------------------------
// 4) stop 失败 / 到期失败：清活动态 + list 仍只读 store（35r 的失败后 store）
// ---------------------------------------------------------------------------

test('video-recovery：stop 拿不到结果 → stop 超时清活动态，list 仍能列出旧记录', async () => {
  let clock = 1_000_000;
  const { service, port, area, store } = createHarness({ now: () => clock });
  await store.putRecord(fakeStoredRecord('rec-existing', { startedAt: 900, endedAt: 900 }));
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: clock, mode: 'stream' });
  // STOP/LAST 明确无结果（离屏结果丢了）。
  port.replies.set('bb.rec.stop', { ok: true });
  port.replies.set('bb.rec.last', { ok: true });
  await service.start({ tabId: 7, durationMs: 1000 });
  clock += 10_000; // 越过 deadline，僵尸录制已不可能产出结果
  await assert.rejects(
    () => service.stop({ recording: 'rec-test-1' }),
    (error: unknown) => (error as { code?: string }).code === 'E_VIDEO_STOP_TIMEOUT',
  );
  assert.equal(service.describe().active, null, 'stop 失败后活动态必须被清掉');
  assert.equal(area.data['bb.video.active'], undefined);

  const listed = await service.list();
  const ids = (listed.recordings as Array<{ id?: string }>).map((item) => item.id);
  assert.deepEqual(ids, ['rec-existing'], 'list 只读 store，不应因离屏结果缺失报错');

  // 旧录制被清理后，新 start 可接管。
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: clock, mode: 'stream' });
  const again = await service.start({ tabId: 7 });
  assert.equal(again.recordingId, 'rec-test-2');
});

test('video-recovery：旧录制超时后新 start 直接接管（不需要先 status/list）', async () => {
  let clock = 1_000_000;
  const { service, port } = createHarness({ now: () => clock });
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: clock, mode: 'stream' });
  await service.start({ tabId: 7, durationMs: 1000 });
  clock += 10_000; // 旧录制已过 deadline 且离屏无回包 → 视为不可救
  const again = await service.start({ tabId: 7, durationMs: 2000 });
  assert.equal(again.recordingId, 'rec-test-2');
  assert.equal(service.phase(), 'recording');
});

test('video-recovery：duration 到期 SW 兜底自动收尾（不依赖离屏定时器）', async () => {
  const { service, port } = createHarness({ now: () => Date.now() });
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: Date.now(), mode: 'stream' });
  port.replies.set('bb.rec.stop', { ok: true });
  port.replies.set('bb.rec.last', { ok: true });
  await service.start({ tabId: 7, durationMs: 250 });
  assert.equal(service.phase(), 'recording');
  await waitFor(() => service.describe().active === null, 5000);
  assert.equal(service.phase(), 'idle');
  const status = await service.status({});
  assert.equal(status.active, false);
});

// ---------------------------------------------------------------------------
// 5) prune / recover 在失败后仍可用（20g / 35r）
// ---------------------------------------------------------------------------

test('video-recovery：失败清理后 prune 仍能清理过期记录', async () => {
  let clock = 1_000_000;
  const { service, port, store } = createHarness({ now: () => clock });
  await store.putRecord(fakeStoredRecord('rec-old', { startedAt: 1, endedAt: 1 }));
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: clock, mode: 'stream' });
  port.replies.set('bb.rec.stop', { ok: true });
  port.replies.set('bb.rec.last', { ok: true });
  await service.start({ tabId: 7, durationMs: 1000 });
  clock += 10_000;
  await service.stop({ recording: 'rec-test-1' }).catch(() => null);
  const pruned = await service.prune({ ttlMs: 1 });
  assert.equal(pruned.removed, 1);
  assert.equal(pruned.remaining, 0);
  const listed = await service.list();
  assert.deepEqual(listed.recordings, []);
});

test('video-recovery：失败清理后 recover 仍能扫描分片并落库（35r）', async () => {
  let clock = 1_000_000;
  const { service, port, store } = createHarness({ now: () => clock });
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: clock, mode: 'stream' });
  port.replies.set('bb.rec.stop', { ok: true });
  port.replies.set('bb.rec.last', { ok: true });
  await service.start({ tabId: 7, durationMs: 1000 });
  clock += 10_000;
  await service.stop({ recording: 'rec-test-1' }).catch(() => null);
  assert.equal(service.describe().active, null);

  const data = makeFaststartMp4();
  const half = Math.floor(data.length / 2);
  const id = 'recover-drill-test';
  const meta = { recordingId: id, tabId: 0, url: 'e2e://recover', title: 'recover drill', startedAt: clock, mime: 'video/mp4' };
  await store.putChunks([
    { key: id + ':000000', recordingId: id, index: 0, at: clock, meta, blob: new Blob([data.slice(0, half)], { type: 'video/mp4' }) },
    { key: id + ':000001', recordingId: id, index: 1, at: clock + 1, meta, blob: new Blob([data.slice(half)], { type: 'video/mp4' }) },
  ]);
  const recovered = await service.recover({});
  assert.equal(recovered.id, id);
  assert.equal(recovered.bytes, data.length);
  assert.equal(recovered.stop_reason, 'recovered');
  assert.equal(recovered.completeness, 'partial');
  const fragments = recovered.fragments as Array<{ bytes?: number; sha256?: string }>;
  assert.equal(fragments.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0), data.length);
  assert.ok(fragments.every((item) => /^[0-9a-f]{64}$/.test(String(item.sha256))));

  const listed = await service.list();
  const found = (listed.recordings as Array<{ id?: string; bytes?: number }>).find((item) => item.id === id);
  assert.equal(found?.bytes, data.length);
});

// ---------------------------------------------------------------------------
// 6) --force-frames：离屏编码器起不来时回退 tabCapture（不直接失败）
// ---------------------------------------------------------------------------

test('video-recovery：--force-frames 首帧编码失败 → 回退 tabCapture → 结果仍 encoder/mp4', async () => {
  const { service, port, cdp } = createHarness({ withCdp: true });
  port.replies.set('bb.rec.start-frames', { ok: false, error: 'WebCodecs/mediabunny 编码器不可用（avc：不支持）' });
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: 1_000_000, mode: 'stream', encoder: 'vp9' });
  const result = await makeOffscreenResult({ mode: 'frames', finish_via: 'encoder', faststart: true });
  port.replies.set('bb.rec.stop', { ok: true, result: jsonRoundTrip(encodeOffscreenResult(result)) });
  const started = await service.start({ tabId: 7, durationMs: 3000, forceFrames: true });
  assert.equal(started.mime, 'video/mp4');
  assert.equal(started.mode, 'tabCapture', '逐帧编码器起不来时必须回退 tabCapture 而不是直接失败');
  // 首帧尝试在离屏回 ok:false 前已 Page.enable，但没走到 startScreencast 就回退了。
  assert.equal(cdp?.called('Page.enable'), true);
  assert.equal(cdp?.called('Page.startScreencast'), false);
  assert.equal(port.lastPost('bb.rec.start')?.streamId, 'stream-1');
  const stopped = await service.stop({ recording: 'rec-test-1' });
  assert.equal(stopped.completeness, 'complete');
  assert.equal(stopped.finish_via, 'encoder');
  assert.equal(stopped.faststart, true);
  assert.equal(stopped.mime, 'video/mp4');
});

test('video-recovery：全部采集路径失败 → E_VIDEO_CAPTURE 且 errors 结构化（不伪造）', async () => {
  const { service, port } = createHarness({
    withCdp: true,
    tabCaptureError: new Error('Extension has not been invoked for the current page'),
  });
  port.replies.set('bb.rec.start-frames', { ok: false, error: 'WebCodecs/mediabunny 编码器不可用' });
  await assert.rejects(
    () => service.start({ tabId: 7, durationMs: 3000 }),
    (error: unknown) => {
      const coded = error as { code?: string; data?: { errors?: unknown } };
      assert.equal(coded.code, 'E_VIDEO_CAPTURE');
      const errors = (coded.data?.errors ?? []) as string[];
      assert.ok(errors.length >= 2, '应记录每条失败来源：' + JSON.stringify(errors));
      return true;
    },
  );
  assert.equal(service.describe().active, null);
});
