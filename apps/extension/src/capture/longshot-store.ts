// src/capture/longshot-store.ts —— 长截图分片/索引的持久化（IndexedDB，带内存兜底）。
//
// 为什么需要落盘：
// - `longshot.recover` 是**跨进程**语义：CLI/MCP 可能在截图完成后几秒才来恢复，此时
//   service worker 可能已被 MV3 回收，内存里的 dataUrl 就没了；
// - 超大页分段输出时，只要前面几段已经落盘，即使后面一段失败也还能"断点恢复"出部分图；
// - 写入时记录 hash/bytes/dpr/offset，读回时可以校验字节完整性（篡改/截断可发现）。
//
// 实现约束：
// - 不引入依赖：IndexedDB 是浏览器内建；Node 单测注入 `MemoryLongshotBackend`；
// - 单条记录只存 dataUrl（PNG base64），不额外编码，避免"落盘格式"再引一层编解码；
// - 失败一律降级为"未持久化"（返回 false / 空数组），绝不因为磁盘问题让截图命令失败。

export interface LongshotSegmentRecord {
  longshotId: string;
  index: number;
  /** 段/分片在整页画布上的绘制起点（设备像素）。 */
  drawY: number;
  /** 页面坐标（设备像素；可选，用于定位）。 */
  pageY?: number;
  width: number;
  height: number;
  dataUrl: string;
  bytes: number;
  hash: string;
  createdAt: number;
}

export interface LongshotManifestSegment {
  index: number;
  drawY: number;
  pageY: number;
  pageHeight: number;
  width: number;
  height: number;
  bytes: number;
  hash: string;
}

export interface LongshotManifest {
  version: 1;
  id: string;
  tabId: number | null;
  url: string;
  width: number;
  height: number;
  dpr: number;
  totalSegments: number;
  segments: LongshotManifestSegment[];
  sealed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LongshotBackend {
  putSegment(record: LongshotSegmentRecord): Promise<boolean>;
  listSegments(longshotId: string): Promise<LongshotSegmentRecord[]>;
  putManifest(manifest: LongshotManifest): Promise<boolean>;
  listManifests(): Promise<LongshotManifest[]>;
  deleteLongshot(longshotId: string): Promise<number>;
}

/** dataUrl 的 FNV-1a 哈希（32 位十六进制）：只做完整性提示，不做密码学用途。 */
export function hashDataUrl(dataUrl: unknown): string {
  const text = String(dataUrl ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** dataUrl 的近似字节数（base64 解码后长度）。 */
export function dataUrlBytes(dataUrl: unknown): number {
  const text = String(dataUrl ?? '');
  const comma = text.indexOf(',');
  if (comma < 0) return Math.ceil((text.length * 3) / 4);
  const base64 = text.slice(comma + 1);
  return Math.ceil((base64.length * 3) / 4);
}

/** 内存后端：单测/无 IndexedDB 环境（隐私模式、受限 SW）使用。 */
export class MemoryLongshotBackend implements LongshotBackend {
  private readonly segments = new Map<string, LongshotSegmentRecord[]>();
  private readonly manifests = new Map<string, LongshotManifest>();

  async putSegment(record: LongshotSegmentRecord): Promise<boolean> {
    if (!record || typeof record.longshotId !== 'string' || !record.longshotId) return false;
    const list = this.segments.get(record.longshotId) ?? [];
    const next = list.filter((item) => item.index !== record.index);
    next.push({ ...record });
    next.sort((a, b) => a.index - b.index);
    this.segments.set(record.longshotId, next);
    return true;
  }

  async listSegments(longshotId: string): Promise<LongshotSegmentRecord[]> {
    const list = this.segments.get(String(longshotId ?? '')) ?? [];
    return list.map((item) => ({ ...item }));
  }

  async putManifest(manifest: LongshotManifest): Promise<boolean> {
    if (!manifest || typeof manifest.id !== 'string' || !manifest.id) return false;
    this.manifests.set(manifest.id, { ...manifest, segments: manifest.segments.map((item) => ({ ...item })) });
    return true;
  }

  async listManifests(): Promise<LongshotManifest[]> {
    return [...this.manifests.values()].map((item) => ({ ...item, segments: item.segments.map((segment) => ({ ...segment })) }));
  }

  async deleteLongshot(longshotId: string): Promise<number> {
    const id = String(longshotId ?? '');
    const existed = this.segments.delete(id);
    this.manifests.delete(id);
    return existed ? 1 : 0;
  }
}

const DB_NAME = 'bb-longshot';
const DB_VERSION = 1;
const IMAGE_STORE = 'images';
const MANIFEST_STORE = 'manifests';

interface IdbLikeRequest<T> {
  result: T;
  error: unknown;
  onsuccess: ((this: unknown, event: unknown) => void) | null;
  onerror: ((this: unknown, event: unknown) => void) | null;
}

interface IdbLikeTransaction {
  objectStore(name: string): {
    put(value: unknown, key?: unknown): IdbLikeRequest<unknown>;
    getAll(): IdbLikeRequest<unknown[]>;
    getAllKeys(): IdbLikeRequest<unknown[]>;
    delete(key: unknown): IdbLikeRequest<unknown>;
    index?(name: string): { getAll(query: unknown): IdbLikeRequest<unknown[]> };
  };
  oncomplete: ((this: unknown, event: unknown) => void) | null;
  onerror: ((this: unknown, event: unknown) => void) | null;
}

interface IdbLikeDatabase {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: Record<string, unknown>): unknown;
  transaction(names: string | string[], mode: string): IdbLikeTransaction;
  close(): void;
}

interface IdbLikeOpenRequest {
  result: IdbLikeDatabase;
  onupgradeneeded: ((this: unknown, event: unknown) => void) | null;
  onsuccess: ((this: unknown, event: unknown) => void) | null;
  onerror: ((this: unknown, event: unknown) => void) | null;
}

interface IdbLikeFactory {
  open(name: string, version: number): IdbLikeOpenRequest;
}

function idbFactory(): IdbLikeFactory | null {
  const candidate = (globalThis as { indexedDB?: unknown }).indexedDB;
  if (!candidate || typeof (candidate as IdbLikeFactory).open !== 'function') return null;
  return candidate as IdbLikeFactory;
}

function requestResult<T>(request: IdbLikeRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(transaction: IdbLikeTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('IndexedDB 事务失败'));
  });
}

/** IndexedDB 后端（SW 重启后仍可恢复；不可用时由调用方回退内存后端）。 */
export class IndexedDbLongshotBackend implements LongshotBackend {
  private dbPromise: Promise<IdbLikeDatabase> | null = null;

  private async db(): Promise<IdbLikeDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const factory = idbFactory();
    if (!factory) throw new Error('当前运行时没有 indexedDB');
    this.dbPromise = new Promise<IdbLikeDatabase>((resolve, reject) => {
      const open = factory.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(IMAGE_STORE)) db.createObjectStore(IMAGE_STORE);
        if (!db.objectStoreNames.contains(MANIFEST_STORE)) db.createObjectStore(MANIFEST_STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error('IndexedDB 打开失败'));
    });
    return this.dbPromise;
  }

  async putSegment(record: LongshotSegmentRecord): Promise<boolean> {
    try {
      const db = await this.db();
      const transaction = db.transaction(IMAGE_STORE, 'readwrite');
      const key = String(record.longshotId) + ':' + String(record.index).padStart(6, '0');
      transaction.objectStore(IMAGE_STORE).put(record, key);
      await transactionDone(transaction);
      return true;
    } catch {
      return false;
    }
  }

  async listSegments(longshotId: string): Promise<LongshotSegmentRecord[]> {
    try {
      const db = await this.db();
      const transaction = db.transaction(IMAGE_STORE, 'readonly');
      const all = await requestResult(transaction.objectStore(IMAGE_STORE).getAll());
      const id = String(longshotId ?? '');
      const records = (all as LongshotSegmentRecord[]).filter((item) => String(item?.longshotId ?? '') === id);
      records.sort((a, b) => Number(a.index) - Number(b.index));
      return records;
    } catch {
      return [];
    }
  }

  async putManifest(manifest: LongshotManifest): Promise<boolean> {
    try {
      const db = await this.db();
      const transaction = db.transaction(MANIFEST_STORE, 'readwrite');
      transaction.objectStore(MANIFEST_STORE).put(manifest, String(manifest.id));
      await transactionDone(transaction);
      return true;
    } catch {
      return false;
    }
  }

  async listManifests(): Promise<LongshotManifest[]> {
    try {
      const db = await this.db();
      const transaction = db.transaction(MANIFEST_STORE, 'readonly');
      const all = await requestResult(transaction.objectStore(MANIFEST_STORE).getAll());
      return (all as LongshotManifest[]).filter((item) => Boolean(item) && typeof item.id === 'string');
    } catch {
      return [];
    }
  }

  async deleteLongshot(longshotId: string): Promise<number> {
    try {
      const db = await this.db();
      const segments = await this.listSegments(longshotId);
      const transaction = db.transaction(IMAGE_STORE, 'readwrite');
      const store = transaction.objectStore(IMAGE_STORE);
      for (const segment of segments) {
        store.delete(String(longshotId) + ':' + String(segment.index).padStart(6, '0'));
      }
      await transactionDone(transaction).catch(() => undefined);
      const manifestTransaction = db.transaction(MANIFEST_STORE, 'readwrite');
      manifestTransaction.objectStore(MANIFEST_STORE).delete(String(longshotId));
      await transactionDone(manifestTransaction).catch(() => undefined);
      return segments.length;
    } catch {
      return 0;
    }
  }
}

/** 有 IndexedDB 用 IndexedDB，否则退回内存（并如实标注 backend）。 */
export function createBrowserLongshotBackend(): { backend: LongshotBackend; kind: 'indexeddb' | 'memory' } {
  if (idbFactory()) return { backend: new IndexedDbLongshotBackend(), kind: 'indexeddb' };
  return { backend: new MemoryLongshotBackend(), kind: 'memory' };
}

export interface LongshotStoreOptions {
  backend?: LongshotBackend;
  now?: () => number;
  /** 保留的 manifest 数量上限（超出删最旧，防止长期会话无限增长）。 */
  maxManifests?: number;
  /** 分片 TTL（毫秒）；0 表示不过期。 */
  ttlMs?: number;
}

/**
 * 长截图索引/分片仓库：对上层只暴露"存分片 + 存 manifest + 列/清"四类语义。
 * 所有失败都降级（返回 false/空），不把磁盘问题变成截图失败。
 */
export class LongshotStore {
  readonly backend: LongshotBackend;
  private readonly now: () => number;
  private readonly maxManifests: number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, LongshotManifest>();
  private memoryFallback: MemoryLongshotBackend | null = null;
  private persistEnabled = true;

  constructor(options: LongshotStoreOptions = {}) {
    const created = options.backend ? null : createBrowserLongshotBackend();
    this.backend = options.backend ?? created?.backend ?? new MemoryLongshotBackend();
    this.now = options.now ?? Date.now;
    this.maxManifests = Number(options.maxManifests) > 0 ? Math.floor(Number(options.maxManifests)) : 24;
    this.ttlMs = Number(options.ttlMs) > 0 ? Math.floor(Number(options.ttlMs)) : 0;
  }

  /** 当前后端种类（诊断用）。 */
  backendKind(): 'injected' | 'indexeddb' | 'memory' {
    if (this.backend instanceof MemoryLongshotBackend) return 'memory';
    if (this.backend instanceof IndexedDbLongshotBackend) return 'indexeddb';
    return 'injected';
  }

  /** 首次写入失败后整体降级到内存后端（避免每段都重试一次失败事务）。 */
  private async degrade(): Promise<void> {
    if (!this.persistEnabled) return;
    this.persistEnabled = false;
    this.memoryFallback = new MemoryLongshotBackend();
  }

  private active(): LongshotBackend {
    return this.memoryFallback ?? this.backend;
  }

  /** 写一个分片；返回是否真正落盘。 */
  async putSegment(input: {
    longshotId: string;
    index: number;
    drawY: number;
    pageY?: number;
    width: number;
    height: number;
    dataUrl: string;
  }): Promise<LongshotSegmentRecord | null> {
    const record: LongshotSegmentRecord = {
      longshotId: String(input.longshotId ?? ''),
      index: Math.max(0, Math.round(Number(input.index) || 0)),
      drawY: Math.max(0, Math.round(Number(input.drawY) || 0)),
      pageY: Math.max(0, Math.round(Number(input.pageY) || 0)),
      width: Math.max(1, Math.round(Number(input.width) || 1)),
      height: Math.max(1, Math.round(Number(input.height) || 1)),
      dataUrl: String(input.dataUrl ?? ''),
      bytes: dataUrlBytes(input.dataUrl),
      hash: hashDataUrl(input.dataUrl),
      createdAt: this.now(),
    };
    if (!record.longshotId || !record.dataUrl) return null;
    let stored = false;
    try {
      stored = await this.active().putSegment(record);
    } catch {
      stored = false;
    }
    if (!stored && this.persistEnabled) {
      await this.degrade();
      try {
        stored = await this.active().putSegment(record);
      } catch {
        stored = false;
      }
    }
    return stored ? record : null;
  }

  async listSegments(longshotId: string): Promise<LongshotSegmentRecord[]> {
    try {
      return await this.active().listSegments(longshotId);
    } catch {
      return [];
    }
  }

  /** 写/覆盖 manifest（内存缓存总是先更新，落盘失败只影响跨进程恢复）。 */
  async putManifest(manifest: LongshotManifest): Promise<boolean> {
    this.cache.set(manifest.id, manifest);
    let stored = false;
    try {
      stored = await this.active().putManifest(manifest);
    } catch {
      stored = false;
    }
    if (!stored && this.persistEnabled) {
      await this.degrade();
      try {
        stored = await this.active().putManifest(manifest);
      } catch {
        stored = false;
      }
    }
    return stored;
  }

  /** 最近的 manifest（新的在前）；合并内存缓存与后端结果。 */
  async listManifests(): Promise<LongshotManifest[]> {
    const merged = new Map<string, LongshotManifest>();
    for (const item of this.cache.values()) merged.set(item.id, item);
    try {
      const stored = await this.active().listManifests();
      for (const item of stored) if (!merged.has(item.id)) merged.set(item.id, item);
    } catch {
      // 后端不可用：只用内存缓存
    }
    const now = this.now();
    const fresh = [...merged.values()]
      .filter((item) => (this.ttlMs > 0 ? now - Number(item.createdAt || 0) <= this.ttlMs : true))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    return fresh.slice(0, this.maxManifests);
  }

  /** 最近一张（`longshot.recover` 不带 id 时用）。 */
  async latest(): Promise<LongshotManifest | null> {
    const list = await this.listManifests();
    return list[0] ?? null;
  }

  async delete(longshotId: string): Promise<number> {
    this.cache.delete(String(longshotId ?? ''));
    try {
      return await this.active().deleteLongshot(longshotId);
    } catch {
      return 0;
    }
  }

  /** 清理过期/超量 manifest 与其分片；返回删除条数。 */
  async prune(): Promise<number> {
    try {
      const list = await this.listManifests();
      const keep = new Set(list.slice(0, this.maxManifests).map((item) => item.id));
      const allManifests = await this.active().listManifests();
      let removed = 0;
      for (const manifest of allManifests) {
        if (keep.has(manifest.id)) continue;
        await this.delete(manifest.id);
        removed += 1;
      }
      return removed;
    } catch {
      return 0;
    }
  }
}

/** 构造 manifest 的便捷函数（长截图采集与恢复共用同一形状）。 */
export function buildLongshotManifest(input: {
  id: string;
  tabId?: number | null;
  url?: string;
  width: number;
  height: number;
  dpr: number;
  totalSegments: number;
  segments?: LongshotManifestSegment[];
  now?: number;
}): LongshotManifest {
  const now = Number(input.now) > 0 ? Number(input.now) : Date.now();
  return {
    version: 1,
    id: String(input.id ?? ''),
    tabId: Number.isInteger(Number(input.tabId)) ? Number(input.tabId) : null,
    url: String(input.url ?? ''),
    width: Math.max(1, Math.round(Number(input.width) || 1)),
    height: Math.max(1, Math.round(Number(input.height) || 1)),
    dpr: Number(input.dpr) > 0 ? Number(input.dpr) : 1,
    totalSegments: Math.max(1, Math.round(Number(input.totalSegments) || 1)),
    segments: (input.segments ?? []).map((segment) => ({ ...segment })),
    sealed: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** 追加一段并保持按 index 排序（返回新对象，状态机/恢复都以它为准）。 */
export function appendLongshotSegment(manifest: LongshotManifest, segment: LongshotManifestSegment, now?: number): LongshotManifest {
  const segments = manifest.segments.filter((item) => item.index !== segment.index);
  segments.push({ ...segment });
  segments.sort((a, b) => a.index - b.index);
  return {
    ...manifest,
    segments,
    updatedAt: Number(now) > 0 ? Number(now) : manifest.updatedAt,
  };
}

/** 封版：段数达到计划段数才算 sealed（缺段一律不 sealed，恢复时标 recovered）。 */
export function sealLongshotManifest(manifest: LongshotManifest, now?: number): LongshotManifest {
  const sealed = manifest.segments.length >= manifest.totalSegments && manifest.totalSegments > 0;
  return {
    ...manifest,
    sealed,
    updatedAt: Number(now) > 0 ? Number(now) : manifest.updatedAt,
  };
}

/** 对外摘要（结果里的 manifest 字段；不含 dataUrl）。 */
export function manifestSummary(manifest: LongshotManifest | null | undefined): Record<string, unknown> | null {
  if (!manifest) return null;
  return {
    id: manifest.id,
    width: manifest.width,
    height: manifest.height,
    dpr: manifest.dpr,
    total: manifest.totalSegments,
    segments: manifest.segments.length,
    sealed: manifest.sealed,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    offsets: manifest.segments.map((segment) => ({
      index: segment.index,
      offset: segment.drawY,
      height: segment.height,
      bytes: segment.bytes,
      hash: segment.hash,
    })),
  };
}
