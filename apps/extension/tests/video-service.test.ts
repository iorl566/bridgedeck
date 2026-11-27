// tests/video-service.test.ts —— VideoService 单测：启动/停止/状态/保存/校验/prune/恢复/丢弃。
//
// 全部 fake：假离屏端口、假 chrome.storage 区、假 tabs、假 tabCapture、假 CDP、假时钟。
// 覆盖 tools/e2e.mjs 的 video 断言口径（20c / 20c2 / 20g / 35 / 35r 的服务侧行为）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoService, type VideoCdp } from '../src/video/service.ts';
import { createMemoryVideoStore } from '../src/video/store.ts';
import { createStorageAdapter, type OffscreenPort, type StorageAreaLike } from '../src/video/runtime.ts';
import { sha256Hex, toArrayBuffer } from '../src/video/hash.ts';
import { fragmentJournal, journalSummary } from '../src/video/mp4.ts';
import type { OffscreenRecordingResult } from '../src/video/offscreen-protocol.ts';
import type { VideoRecord } from '../src/video/types.ts';

// ---------------------------------------------------------------------------
// 最小 MP4 夹具（与 video-core.test.ts 同款；测试之间不互相 import 以免重复注册用例）
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
  async post<T = Record<string, unknown>>(message: Record<string, unknown>, _options?: { retries?: number; intervalMs?: number }): Promise<T | null> {
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
  tabUrl?: string;
  tabCaptureError?: Error;
  withCdp?: boolean;
  now?: () => number;
}

function createHarness(options: HarnessOptions = {}) {
  const store = createMemoryVideoStore();
  const port = new FakePort();
  const area = createFakeArea();
  const storage = createStorageAdapter(area);
  const cdp = options.withCdp ? new FakeCdp() : undefined;
  const tabUrl = options.tabUrl ?? 'https://example.test/page';
  const tabs = {
    async get(tabId: number) {
      if (tabId !== 7) throw new Error('No tab with id ' + tabId);
      return { id: 7, url: tabUrl, title: 'Fixture', windowId: 1 };
    },
  };
  const tabCapture = {
    async getMediaStreamId() {
      if (options.tabCaptureError) throw options.tabCaptureError;
      return 'stream-1';
    },
  };
  const service = new VideoService({
    tabs,
    port,
    store,
    storage,
    tabCapture,
    ...(cdp ? { cdp } : {}),
    now: options.now ?? (() => 1000),
    newId: () => 'rec-test-1',
    probeStorage: async (backend) => ({ backend, persisted: true, quota: 2048, usage: 3 }),
  });
  service.attach();
  return { service, store, port, area, storage, cdp, tabCapture };
}

function flush(ms = 15): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await flush(5);
  }
  throw new Error('waitFor 超时');
}

async function makeOffscreenResult(overrides: Partial<OffscreenRecordingResult> = {}): Promise<OffscreenRecordingResult> {
  const data = makeFaststartMp4();
  const sha = await sha256Hex(data);
  const journal = journalSummary(fragmentJournal(data));
  return {
    ok: true,
    id: 'rec-test-1',
    tabId: 7,
    url: 'https://example.test/page',
    title: 'Fixture',
    startedAt: 1000,
    endedAt: 2000,
    mime: 'video/mp4',
    data,
    completeness: 'complete',
    stop_reason: 'user',
    chunk_count: 1,
    fragments: [{ index: 0, at: 1000, bytes: data.length, sha256: sha }],
    finish_via: 'encoder',
    complete_frames: true,
    faststart: true,
    journal,
    mode: 'stream',
    ...overrides,
  };
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
// 启动 / 停止
// ---------------------------------------------------------------------------

test('video-service：video.start 走 tabCapture → 离屏，写入活动态', async () => {
  const { service, port, area } = createHarness();
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: 1000, mode: 'stream', encoder: 'avc' });
  const started = await service.start({ tabId: 7, durationMs: 3000 });
  assert.equal(started.recordingId, 'rec-test-1');
  assert.equal(started.mime, 'video/mp4');
  assert.equal(started.mode, 'tabCapture');
  assert.equal(started.recording_state, 'recording');
  assert.equal(port.ensureCount, 1);
  const startPost = port.lastPost('bb.rec.start');
  assert.ok(startPost);
  assert.equal(startPost?.streamId, 'stream-1');
  assert.equal(startPost?.durationMs, 3000);
  assert.ok(area.data['bb.video.active']);
  assert.equal(service.phase(), 'recording');
});

test('video-service：已存在活动录制时拒绝并发（E_SESSION_BUSY）', async () => {
  const { service, port } = createHarness();
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: 1000, mode: 'stream' });
  await service.start({ tabId: 7 });
  await assert.rejects(() => service.start({ tabId: 7 }), (error: unknown) => (error as { code?: string }).code === 'E_SESSION_BUSY');
});

test('video-service：受限页面/非法 tabId 结构化拒绝', async () => {
  const harness = createHarness({ tabUrl: 'chrome://settings' });
  await assert.rejects(
    () => harness.service.start({ tabId: 7 }),
    (error: unknown) => (error as { code?: string }).code === 'E_VIDEO_RESTRICTED_PAGE',
  );
  const other = createHarness();
  await assert.rejects(
    () => other.service.start({}),
    (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG',
  );
});

test('video-service：video.stop 等离屏结果 → 落库并关闭离屏文档', async () => {
  const { service, port, store } = createHarness();
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: 1000, mode: 'stream' });
  const result = await makeOffscreenResult();
  port.replies.set('bb.rec.stop', { ok: true, result });
  await service.start({ tabId: 7 });
  const stopped = await service.stop({ recording: 'rec-test-1' });
  assert.equal(stopped.recordingId, 'rec-test-1');
  assert.equal(stopped.bytes, result.data.length);
  assert.equal(stopped.completeness, 'complete');
  assert.equal(stopped.finish_via, 'encoder');
  assert.equal(stopped.faststart, true);
  const record = await store.getRecord('rec-test-1');
  assert.ok(record);
  assert.equal(record?.storage_persisted, true);
  assert.equal(record?.durability_policy, 'browser-readback');
  assert.equal(record?.fsync_supported, false);
  assert.equal(port.closeCount, 1);
});

test('video-service：没有录制时 video.stop 返回 E_VIDEO_IDLE', async () => {
  const { service } = createHarness();
  await assert.rejects(() => service.stop({}), (error: unknown) => (error as { code?: string }).code === 'E_VIDEO_IDLE');
});

// ---------------------------------------------------------------------------
// 离屏 done 消息 → 状态/列表/保存/校验（对齐 E2E 35）
// ---------------------------------------------------------------------------

test('video-service：bb.rec.done 落库后 status/list/fetch/verify 字段满足 E2E 口径', async () => {
  const { service, port, store } = createHarness();
  port.replies.set('bb.rec.start', { ok: true, mime: 'video/mp4', startedAt: 1000, mode: 'stream' });
  const result = await makeOffscreenResult();
  await service.start({ tabId: 7, durationMs: 1200 });
  port.emit({ from: 'offscreen', type: 'bb.rec.done', result });
  await waitFor(async () => (await store.listRecords()).length === 1);

  const status = await service.status({});
  assert.equal(status.active, false);
  assert.equal(status.state, 'ready');
  assert.equal(status.completeness, 'complete');
  assert.ok(status.stop_reason === 'user' || status.stop_reason === 'duration');
  assert.equal(status.finish_via, 'encoder');
  assert.equal(status.complete_frames, true);
  assert.equal(status.faststart, true);
  assert.ok(Array.isArray(status.fragments) && (status.fragments as Array<{ sha256?: string }>).length >= 1);
  assert.ok((status.fragments as Array<{ sha256?: string }>).every((item) => /^[0-9a-f]{64}$/.test(String(item.sha256))));

  const listed = await service.list();
  const recordings = listed.recordings as Array<Record<string, unknown>>;
  assert.equal(recordings.length, 1);
  assert.equal(recordings[0]?.storage_persisted, true);
  assert.equal(recordings[0]?.durability_policy, 'browser-readback');
  assert.equal(recordings[0]?.fsync_supported, false);
  assert.equal(recordings[0]?.faststart, true);

  const fetched = await service.fetch({ recording: 'rec-test-1' });
  assert.equal(fetched.bytes, result.data.length);
  assert.equal(fetched.faststart, true);
  const decoded = Buffer.from(String(fetched.base64), 'base64');
  assert.equal(decoded.length, result.data.length);
  assert.equal(decoded.subarray(4, 8).toString('ascii'), 'ftyp');

  const verified = await service.verify({ recording: 'rec-test-1' });
  assert.equal(verified.verified, true);
  assert.deepEqual(verified.mismatches, []);
  const container = verified.container as { format?: string; faststart?: boolean };
  assert.equal(container.format, 'mp4');
  assert.equal(container.faststart, true);
});

test('video-service：分片 SHA-256 不一致时 verify 报 mismatch', async () => {
  const { service, store } = createHarness();
  const result = await makeOffscreenResult();
  const bad = { ...fakeStoredRecord('rec-bad'), fragments: [{ index: 0, at: 1, bytes: 10, sha256: '0'.repeat(64) }], blob: new Blob([toArrayBuffer(result.data)], { type: 'video/mp4' }), bytes: result.data.length };
  await store.putRecord(bad);
  const verified = await service.verify({ recording: 'rec-bad' });
  assert.equal(verified.verified, false);
  assert.equal((verified.mismatches as unknown[]).length, 1);
});

// ---------------------------------------------------------------------------
// prune（对齐 E2E 20g）
// ---------------------------------------------------------------------------

test('video-service：prune --ttl 1ms 清理过期录制，list 不再出现', async () => {
  const { service, store } = createHarness({ now: () => 10_000 });
  await store.putRecord(fakeStoredRecord('rec-old', { startedAt: 1000, endedAt: 1000 }));
  await store.putRecord(fakeStoredRecord('rec-new', { startedAt: 9_999, endedAt: 9_999 }));
  const pruned = await service.prune({ ttlMs: 1 });
  assert.equal(pruned.removed, 1);
  assert.equal(pruned.remaining, 1);
  const listed = await service.list();
  const ids = (listed.recordings as Array<{ id?: string }>).map((item) => item.id);
  assert.deepEqual(ids, ['rec-new']);
});

test('video-service：discard 删除记录并清空分片', async () => {
  const { service, store } = createHarness();
  await store.putRecord(fakeStoredRecord('rec-del'));
  await store.putChunks([{ key: 'rec-del:000000', recordingId: 'rec-del', index: 0, at: 1, meta: {}, blob: new Blob([new Uint8Array([1])]) }]);
  await service.discard({ recording: 'rec-del' });
  assert.equal(await store.getRecord('rec-del'), null);
  assert.equal((await store.listChunks('rec-del')).length, 0);
  await assert.rejects(() => service.discard({}), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
});

// ---------------------------------------------------------------------------
// recover（对齐 E2E 35r）
// ---------------------------------------------------------------------------

test('video-service：recover 扫描分片 → partial/recovered，字节与分片 sha 对齐；再次 recover 失败', async () => {
  const { service, store } = createHarness({ now: () => 5_000 });
  const data = makeFaststartMp4();
  const half = Math.floor(data.length / 2);
  const id = 'recover-drill-test';
  const meta = { recordingId: id, tabId: 0, url: 'e2e://recover', title: 'recover drill', startedAt: 4000, mime: 'video/mp4' };
  await store.putChunks([
    { key: id + ':000000', recordingId: id, index: 0, at: 4000, meta, blob: new Blob([data.slice(0, half)], { type: 'video/mp4' }) },
    { key: id + ':000001', recordingId: id, index: 1, at: 4001, meta, blob: new Blob([data.slice(half)], { type: 'video/mp4' }) },
  ]);
  const recovered = await service.recover({});
  assert.equal(recovered.id, id);
  assert.equal(recovered.recordingId, id);
  assert.equal(recovered.bytes, data.length);
  assert.equal(recovered.stop_reason, 'recovered');
  assert.equal(recovered.completeness, 'partial');
  const fragments = recovered.fragments as Array<{ bytes?: number; sha256?: string }>;
  assert.equal(fragments.length, 2);
  assert.equal(fragments.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0), data.length);
  assert.ok(fragments.every((item) => /^[0-9a-f]{64}$/.test(String(item.sha256))));

  const listed = await service.list();
  const found = (listed.recordings as Array<{ id?: string; bytes?: number }>).find((item) => item.id === id);
  assert.equal(found?.bytes, data.length);
  assert.equal((await store.listChunks(id)).length, 0);
  await assert.rejects(() => service.recover({}), (error: unknown) => (error as { code?: string }).code === 'E_VIDEO_NO_FRAGMENTS');
});

// ---------------------------------------------------------------------------
// --force-frames（对齐 E2E 20c2）
// ---------------------------------------------------------------------------

test('video-service：--force-frames 走 CDP 截帧 + 离屏编码（finish_via=encoder/faststart）', async () => {
  const { service, port, cdp } = createHarness({ withCdp: true });
  port.replies.set('bb.rec.start-frames', { ok: true, mime: 'video/mp4', startedAt: 1000, mode: 'frames', encoder: 'avc' });
  const result = await makeOffscreenResult({ mode: 'frames', finish_via: 'encoder', faststart: true });
  port.replies.set('bb.rec.stop', { ok: true, result });
  const started = await service.start({ tabId: 7, durationMs: 3000, forceFrames: true });
  assert.equal(started.mode, 'debugger');
  assert.equal(cdp?.called('Page.startScreencast'), true);
  assert.equal(cdp?.called('Page.enable'), true);

  cdp?.emit(7, 'Page.screencastFrame', { data: 'AAAA', sessionId: 3 });
  await waitFor(() => port.posts.some((item) => item.type === 'bb.rec.frame'));
  const frame = port.lastPost('bb.rec.frame');
  assert.equal(frame?.data, 'data:image/jpeg;base64,AAAA');
  assert.equal(cdp?.called('Page.screencastFrameAck'), true);

  const stopped = await service.stop({ recording: 'rec-test-1' });
  assert.equal(stopped.faststart, true);
  assert.equal(cdp?.called('Page.stopScreencast'), true);
});

test('video-service：tabCapture 无手势权限时回退调试器截帧（20c 的兜底路径）', async () => {
  const { service, port, cdp } = createHarness({ withCdp: true, tabCaptureError: new Error('Extension has not been invoked for the current page') });
  port.replies.set('bb.rec.start-frames', { ok: true, mime: 'video/mp4', startedAt: 1000, mode: 'frames', encoder: 'avc' });
  const started = await service.start({ tabId: 7 });
  assert.equal(started.mode, 'debugger');
  assert.equal(cdp?.called('Page.startScreencast'), true);
  assert.equal(port.lastPost('bb.rec.start'), null);
});
