// src/video/store.ts —— 录制存储（IndexedDB 优先，纯内存兜底并如实标注 backend）。
//
// 为什么不用 chrome.storage.local 存视频：MV3 的 storage 有 10MB 配额且以 JSON 为主，
// 视频必须走 IndexedDB（Blob 可直接结构化克隆落库）。这里把「记录」与「崩溃恢复分片」
// 分成两个 object store，与 extension/src/lib/offscreen-store.js 的 bb-videos/v2 布局兼容：
// - videos: keyPath 'id'（完整记录 + Blob）
// - chunks: keyPath 'key'（recordingId:index 的恢复分片日记）
//
// 单测不依赖真实 IndexedDB：createMemoryVideoStore 提供同契约的内存实现；
// createVideoStore 在 indexedDB 不可用时自动降级，并把 backend='memory' 写进记录（不假装持久化）。

import type { PublicVideoRecord, StorageBackend, VideoRecord } from './types.ts';
import { VIDEO_CODES, videoError } from './types.ts';

export interface StoredChunk {
  key: string;
  recordingId: string;
  index: number;
  at: number;
  meta: Record<string, unknown>;
  blob: Blob;
}

export interface VideoStore {
  readonly backend: StorageBackend;
  listRecords(): Promise<VideoRecord[]>;
  getRecord(id: string): Promise<VideoRecord | null>;
  putRecord(record: VideoRecord): Promise<void>;
  deleteRecord(id: string): Promise<void>;
  listChunks(recordingId?: string): Promise<StoredChunk[]>;
  putChunks(chunks: StoredChunk[]): Promise<void>;
  clearChunks(recordingId?: string): Promise<void>;
}

export const VIDEO_DB_NAME = 'bb-videos';
export const VIDEO_DB_VERSION = 2;
export const VIDEO_RECORD_STORE = 'videos';
export const VIDEO_CHUNK_STORE = 'chunks';

/** 公开面：去掉 blob（RPC 只能 JSON 化），其余字段原样保留供 CLI 读取。 */
export function toPublicRecord(record: VideoRecord): PublicVideoRecord {
  const { blob: _blob, ...rest } = record;
  return rest as PublicVideoRecord;
}

export function chunkKey(recordingId: string, index: number): string {
  return recordingId + ':' + String(index).padStart(6, '0');
}

/** 纯内存实现：单测 / 运行环境没有 IndexedDB 时的兜底（backend='memory'）。 */
export function createMemoryVideoStore(): VideoStore {
  const records = new Map<string, VideoRecord>();
  const chunks = new Map<string, StoredChunk>();
  return {
    backend: 'memory',
    async listRecords() { return [...records.values()].map((record) => ({ ...record })); },
    async getRecord(id) {
      const found = records.get(String(id));
      return found ? { ...found } : null;
    },
    async putRecord(record) { records.set(record.id, { ...record }); },
    async deleteRecord(id) { records.delete(String(id)); },
    async listChunks(recordingId) {
      const list = [...chunks.values()];
      const filtered = recordingId ? list.filter((item) => item.recordingId === recordingId) : list;
      return filtered.map((item) => ({ ...item })).sort((a, b) => a.index - b.index);
    },
    async putChunks(items) { for (const item of items) chunks.set(item.key, { ...item }); },
    async clearChunks(recordingId) {
      if (!recordingId) { chunks.clear(); return; }
      for (const key of [...chunks.keys()]) {
        if (chunks.get(key)?.recordingId === recordingId) chunks.delete(key);
      }
    },
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

interface OpenDbResult {
  db: IDBDatabase;
  version: number;
}

/** 打开（并按需升级）bb-videos；升级逻辑与 JS 0.3.0 的离屏存储互不冲突。 */
export function openVideoDb(factory: IDBFactory): Promise<OpenDbResult> {
  return new Promise<OpenDbResult>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(VIDEO_DB_NAME, VIDEO_DB_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VIDEO_RECORD_STORE)) db.createObjectStore(VIDEO_RECORD_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(VIDEO_CHUNK_STORE)) {
        const store = db.createObjectStore(VIDEO_CHUNK_STORE, { keyPath: 'key' });
        store.createIndex('recordingId', 'recordingId', { unique: false });
      }
    };
    request.onsuccess = () => resolve({ db: request.result, version: request.result.version });
    request.onerror = () => reject(request.error ?? new Error('打开录制库失败'));
    request.onblocked = () => reject(new Error('录制库被其它页面占用，无法升级'));
  });
}

/** IndexedDB 实现：所有读都返回结构化克隆，blob 不主动读进内存。 */
export function createIndexedDbVideoStore(factory: IDBFactory): VideoStore {
  let opening: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (!opening) {
      opening = openVideoDb(factory).then((result) => result.db);
    }
    return opening;
  };
  return {
    backend: 'indexeddb',
    async listRecords() {
      const database = await db();
      const tx = database.transaction(VIDEO_RECORD_STORE, 'readonly');
      const rows = await requestToPromise(tx.objectStore(VIDEO_RECORD_STORE).getAll() as IDBRequest<VideoRecord[]>);
      await transactionDone(tx);
      return Array.isArray(rows) ? rows : [];
    },
    async getRecord(id) {
      const database = await db();
      const tx = database.transaction(VIDEO_RECORD_STORE, 'readonly');
      const row = await requestToPromise(tx.objectStore(VIDEO_RECORD_STORE).get(String(id)) as IDBRequest<VideoRecord | undefined>);
      await transactionDone(tx);
      return row ?? null;
    },
    async putRecord(record) {
      const database = await db();
      const tx = database.transaction(VIDEO_RECORD_STORE, 'readwrite');
      tx.objectStore(VIDEO_RECORD_STORE).put(record);
      await transactionDone(tx);
    },
    async deleteRecord(id) {
      const database = await db();
      const tx = database.transaction(VIDEO_RECORD_STORE, 'readwrite');
      tx.objectStore(VIDEO_RECORD_STORE).delete(String(id));
      await transactionDone(tx);
    },
    async listChunks(recordingId) {
      const database = await db();
      const tx = database.transaction(VIDEO_CHUNK_STORE, 'readonly');
      const store = tx.objectStore(VIDEO_CHUNK_STORE);
      const request = recordingId
        ? store.index('recordingId').getAll(String(recordingId))
        : store.getAll();
      const rows = await requestToPromise(request as IDBRequest<StoredChunk[]>);
      await transactionDone(tx);
      return (Array.isArray(rows) ? rows : []).sort((a, b) => a.index - b.index);
    },
    async putChunks(items) {
      if (!items.length) return;
      const database = await db();
      const tx = database.transaction(VIDEO_CHUNK_STORE, 'readwrite');
      const store = tx.objectStore(VIDEO_CHUNK_STORE);
      for (const item of items) store.put(item);
      await transactionDone(tx);
    },
    async clearChunks(recordingId) {
      const database = await db();
      const tx = database.transaction(VIDEO_CHUNK_STORE, 'readwrite');
      const store = tx.objectStore(VIDEO_CHUNK_STORE);
      if (!recordingId) {
        store.clear();
      } else {
        const keys = await requestToPromise(store.index('recordingId').getAllKeys(String(recordingId)) as IDBRequest<IDBValidKey[]>);
        for (const key of keys) store.delete(key);
      }
      await transactionDone(tx);
    },
  };
}

/** 解析运行环境的 indexedDB（页面/SW/离屏文档都有；Node 单测没有）。 */
export function resolveIndexedDb(scope: unknown = globalThis): IDBFactory | null {
  const bag = scope && typeof scope === 'object' ? scope as { indexedDB?: IDBFactory } : null;
  const factory = bag?.indexedDB;
  if (factory && typeof factory.open === 'function') return factory;
  return null;
}

export interface CreateVideoStoreOptions {
  indexedDb?: IDBFactory | null;
  /** 显式注入的 store（单测用）；给出时不再探测 indexedDB。 */
  store?: VideoStore;
}

/**
 * 选存储后端：显式 store > IndexedDB > 内存。
 * 返回的 backend 字段用于记录里的 storage_backend（如实标注，不把内存兜底说成持久化）。
 */
export function createVideoStore(options: CreateVideoStoreOptions = {}): VideoStore {
  if (options.store) return options.store;
  const factory = options.indexedDb ?? resolveIndexedDb();
  if (!factory) return createMemoryVideoStore();
  try {
    return createIndexedDbVideoStore(factory);
  } catch {
    return createMemoryVideoStore();
  }
}

/** 把任意 store 异常归一成带 code 的视频错误（调用方保留原 message 作为细节）。 */
export function storeError(error: unknown, action: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return videoError(VIDEO_CODES.STORE, '录制存储' + action + '失败：' + message);
}
