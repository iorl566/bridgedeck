// src/capture/store.ts —— 截图 capture 的两份内存状态（坐标用 capture / 分块流式读）。
//
// 为什么需要两份：
// 1) 坐标 capture（`click --capture --image-x/--image-y` 用）：保存“这张图对应哪个 tab、
//    截图时的 scroll、图像/CSS 缩放比”。按图坐标派发动作必须是**单次消费**——同一张图
//    重复点击会在页面变化后打错位置，而且很难从结果里发现（与 JS 扩展语义一致）；
// 2) 分块流（`screenshot --stream` 用）：大截图的 dataUrl 可能几 MB，单条 RPC 返回会撑爆
//    消息缓冲。这里把 base64 存内存（TTL + 上限），只回 captureId，CLI 用 screenshot.read
//    按 offset 分块取，最后 release。
//
// 两者都不落盘、不跨进程，SW 被回收即失效（重新截图即可）。

export interface CaptureRecord {
  id: string;
  tabId: number;
  /** 图像像素 / CSS 像素（devicePixelRatio 或 clientWidth 换算）。 */
  scale: number;
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  at: number;
  url: string;
  refs?: unknown;
}

export interface CaptureStoreOptions {
  ttlMs?: number;
  max?: number;
  now?: () => number;
  random?: () => number;
}

const DEFAULT_CAPTURE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CAPTURE_MAX = 20;

function randomId(prefix: string, random: () => number): string {
  const cryptoBag = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  try {
    if (cryptoBag && typeof cryptoBag.randomUUID === 'function') {
      return prefix + cryptoBag.randomUUID().replace(/-/g, '').slice(0, 16);
    }
  } catch {
    // 忽略
  }
  let suffix = '';
  for (let index = 0; index < 8; index += 1) {
    suffix += Math.floor(Math.max(0, Math.min(0.999999, random())) * 65536).toString(36).slice(0, 3);
  }
  return prefix + Date.now().toString(36) + suffix.slice(0, 8);
}

/** 坐标 capture 仓库（单次消费 + TTL + 上限）。 */
export class CaptureStore {
  private readonly entries = new Map<string, CaptureRecord>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: CaptureStoreOptions = {}) {
    this.ttlMs = Number(options.ttlMs) > 0 ? Math.floor(Number(options.ttlMs)) : DEFAULT_CAPTURE_TTL_MS;
    this.max = Number(options.max) > 0 ? Math.floor(Number(options.max)) : DEFAULT_CAPTURE_MAX;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get size(): number {
    return this.entries.size;
  }

  sweep(at = this.now()): void {
    for (const [id, record] of this.entries) {
      if (at - record.at > this.ttlMs) this.entries.delete(id);
    }
  }

  put(record: Omit<CaptureRecord, 'id' | 'at'> & { id?: string; at?: number }): CaptureRecord {
    this.sweep();
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const entry: CaptureRecord = {
      ...record,
      id: record.id ?? randomId('cap_', this.random),
      at: record.at ?? this.now(),
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** 只读查询（不消费）。 */
  get(id: unknown): CaptureRecord | null {
    this.sweep();
    return this.entries.get(String(id ?? '')) ?? null;
  }

  /** 单次消费：取走并删除（同一张图只允许派发一次坐标动作）。 */
  consume(id: unknown): CaptureRecord | null {
    const key = String(id ?? '');
    const record = this.get(key);
    if (record) this.entries.delete(key);
    return record;
  }

  release(id: unknown): boolean {
    return this.entries.delete(String(id ?? ''));
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface StreamReadResult {
  dataBase64: string;
  offset: number;
  nextOffset: number;
  total: number;
  bytes: number;
  eof: boolean;
  width: number | null;
  height: number | null;
  via: string | null;
}

/** dataURL → 纯 base64（非图片 dataURL 返回 null）。 */
export function dataUrlBase64(dataUrl: unknown): string | null {
  const text = String(dataUrl ?? '');
  const comma = text.indexOf(',');
  if (comma < 0 || !/^data:image\//i.test(text.slice(0, comma))) return null;
  const base64 = text.slice(comma + 1);
  return base64 || null;
}

/** base64 解码后的字节数（不真的解码）。 */
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

export interface StreamStoreOptions {
  ttlMs?: number;
  max?: number;
  chunkChars?: number;
  now?: () => number;
  random?: () => number;
}

const DEFAULT_STREAM_TTL_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_MAX = 4;
export const DEFAULT_STREAM_CHUNK_CHARS = 512 * 1024;

interface StreamEntry {
  base64: string;
  width: number | null;
  height: number | null;
  via: string | null;
  bytes: number;
  at: number;
}

/** 分块读取仓库（screenshot.read / screenshot.release）。 */
export class CaptureStreamStore {
  private readonly entries = new Map<string, StreamEntry>();
  private readonly ttlMs: number;
  private readonly max: number;
  readonly chunkChars: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: StreamStoreOptions = {}) {
    this.ttlMs = Number(options.ttlMs) > 0 ? Math.floor(Number(options.ttlMs)) : DEFAULT_STREAM_TTL_MS;
    this.max = Number(options.max) > 0 ? Math.floor(Number(options.max)) : DEFAULT_STREAM_MAX;
    this.chunkChars = Number(options.chunkChars) > 0 ? Math.floor(Number(options.chunkChars)) : DEFAULT_STREAM_CHUNK_CHARS;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(at = this.now()): void {
    for (const [id, entry] of this.entries) {
      if (at - entry.at > this.ttlMs) this.entries.delete(id);
    }
  }

  put(input: { dataUrl: unknown; width?: number | null; height?: number | null; via?: string | null }): { captureId: string; bytes: number; width: number | null; height: number | null } | null {
    const base64 = dataUrlBase64(input.dataUrl);
    if (!base64) return null;
    this.sweep();
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const id = randomId('cap_', this.random);
    const bytes = base64ByteLength(base64);
    this.entries.set(id, {
      base64,
      width: Number.isInteger(input.width) ? Number(input.width) : null,
      height: Number.isInteger(input.height) ? Number(input.height) : null,
      via: input.via ?? null,
      bytes,
      at: this.now(),
    });
    return { captureId: id, bytes, width: this.entries.get(id)?.width ?? null, height: this.entries.get(id)?.height ?? null };
  }

  read(captureId: unknown, options: { offset?: unknown; length?: unknown } = {}): StreamReadResult | null {
    this.sweep();
    const entry = this.entries.get(String(captureId ?? ''));
    if (!entry) return null;
    const total = entry.base64.length;
    const start = Math.min(Math.max(Math.floor(Number(options.offset) || 0), 0), total);
    const requested = Math.floor(Number(options.length) || this.chunkChars);
    const size = Math.min(Math.max(requested, 1), 4 * 1024 * 1024);
    const end = Math.min(start + size, total);
    return {
      dataBase64: entry.base64.slice(start, end),
      offset: start,
      nextOffset: end,
      total,
      bytes: entry.bytes,
      eof: end >= total,
      width: entry.width,
      height: entry.height,
      via: entry.via,
    };
  }

  release(captureId: unknown): boolean {
    return this.entries.delete(String(captureId ?? ''));
  }
}
