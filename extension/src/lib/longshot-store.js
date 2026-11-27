// src/lib/longshot-store.js —— 长截图分片/分块持久化（IndexedDB），避免所有帧只留内存。
//
// v3：新增 manifests（分片索引 manifest，等价兼容目标 index.json）。tiled-capture 每落一段就写
// 一次 manifest，longshot-recover 读 manifest + tiles 做断点恢复；清理时按 TTL 回收过期
// capture 的 frames/tiles/manifest，避免配额累积。
import { pruneLongshotManifests as pruneManifestList } from './longshot-manifest.js';

const DB_NAME = 'bb-longshots';
const STORE = 'frames';
const TILE_STORE = 'tiles';
const MANIFEST_STORE = 'manifests';
const VERSION = 3;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('captureId', 'captureId', { unique: false });
      }
      if (!db.objectStoreNames.contains(TILE_STORE)) {
        const tiles = db.createObjectStore(TILE_STORE, { keyPath: 'key' });
        tiles.createIndex('captureId', 'captureId', { unique: false });
      }
      if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
        db.createObjectStore(MANIFEST_STORE, { keyPath: 'captureId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开长截图 IndexedDB 失败'));
  });
}

export async function saveLongshot(captureId, frames) {
  const list = Array.isArray(frames) ? frames : [];
  if (!captureId || !list.length) return 0;
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (let index = 0; index < list.length; index += 1) {
        const frame = list[index] || {};
        const record = {
          key: captureId + ':' + index,
          captureId,
          index,
          dataUrl: String(frame.dataUrl || ''),
          width: frame.width || 0,
          height: frame.height || 0,
        };
        if (Number.isFinite(Number(frame.drawY))) record.drawY = Number(frame.drawY);
        store.put(record);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('写入长截图失败'));
    });
    return list.length;
  } finally {
    db.close();
  }
}

/** 读取某次截图的拼接帧（按 index 排序）。 */
export async function listLongshot(captureId) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const index = tx.objectStore(STORE).index('captureId');
      const request = index.getAll(IDBKeyRange.only(String(captureId)));
      request.onsuccess = () => resolve((request.result || []).sort((a, b) => a.index - b.index));
      request.onerror = () => reject(request.error || new Error('读取长截图失败'));
    });
  } finally {
    db.close();
  }
}

/** 落盘单个 tile（PNG Blob + 位置 + 可选 hash），用于超大页恢复/诊断，不与内存 canvas 抢生命周期。 */
export async function saveLongshotTile(captureId, tile = {}) {
  if (!captureId || !tile || !tile.blob) return 0;
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TILE_STORE, 'readwrite');
      tx.objectStore(TILE_STORE).put({
        key: captureId + ':' + String(tile.index == null ? 0 : tile.index).padStart(6, '0'),
        captureId,
        index: Number(tile.index) || 0,
        x: Number(tile.x) || 0,
        y: Number(tile.y) || 0,
        width: Number(tile.width) || 0,
        height: Number(tile.height) || 0,
        drawY: Number(tile.drawY) || 0,
        bytes: tile.blob.size || 0,
        hash: String(tile.hash || '').toLowerCase(),
        at: Number(tile.at) || Date.now(),
        blob: tile.blob,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('写入长截图分块失败'));
    });
    return 1;
  } finally {
    db.close();
  }
}

/** 读取某次截图的全部分片（按 index 排序；恢复/校验时一次读完，避免逐条打开事务）。 */
export async function listLongshotTiles(captureId) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TILE_STORE, 'readonly');
      const index = tx.objectStore(TILE_STORE).index('captureId');
      const request = index.getAll(IDBKeyRange.only(String(captureId)));
      request.onsuccess = () => resolve((request.result || []).sort((a, b) => a.index - b.index));
      request.onerror = () => reject(request.error || new Error('读取长截图分块失败'));
    });
  } finally {
    db.close();
  }
}

async function deleteFrom(db, storeName, captureId) {
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const index = tx.objectStore(storeName).index('captureId');
    const request = index.openKeyCursor(IDBKeyRange.only(String(captureId)));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { tx.objectStore(storeName).delete(cursor.primaryKey); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('删除长截图失败'));
  });
}

export async function deleteLongshot(captureId) {
  const db = await openDb();
  try {
    await deleteFrom(db, STORE, captureId);
    await deleteFrom(db, TILE_STORE, captureId);
  } finally {
    db.close();
  }
  await deleteLongshotManifest(captureId);
}

/** 写/覆盖一次长截图的 manifest（captureId 为主键）。 */
export async function saveLongshotManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.captureId) return 0;
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(MANIFEST_STORE, 'readwrite');
      tx.objectStore(MANIFEST_STORE).put(manifest);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('写入长截图索引失败'));
    });
    return 1;
  } finally {
    db.close();
  }
}

export async function getLongshotManifest(captureId) {
  if (!captureId) return null;
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(MANIFEST_STORE, 'readonly');
      const request = tx.objectStore(MANIFEST_STORE).get(String(captureId));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('读取长截图索引失败'));
    });
  } finally {
    db.close();
  }
}

export async function listLongshotManifests() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(MANIFEST_STORE, 'readonly');
      const request = tx.objectStore(MANIFEST_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('列出长截图索引失败'));
    });
  } finally {
    db.close();
  }
}

export async function deleteLongshotManifest(captureId) {
  if (!captureId) return false;
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(MANIFEST_STORE, 'readwrite');
      tx.objectStore(MANIFEST_STORE).delete(String(captureId));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('删除长截图索引失败'));
    });
  } finally {
    db.close();
  }
}

/**
 * 过期清理：按 TTL/数量上限挑出应删的 manifest，并连同该 capture 的帧与分片一起回收。
 * 在途 capture 用 keep 显式保留，避免并发截图互相清理。
 * @returns {Promise<{removed: number, pruned: Array<{captureId: string, reason: string}>, kept: number}>}
 */
export async function cleanupLongshotManifests(options = {}) {
  const manifests = await listLongshotManifests();
  const result = pruneManifestList(manifests, options);
  const db = await openDb();
  try {
    for (const item of result.pruned) {
      await deleteFrom(db, STORE, item.captureId);
      await deleteFrom(db, TILE_STORE, item.captureId);
      await deleteFrom(db, MANIFEST_STORE, item.captureId);
    }
  } finally {
    db.close();
  }
  return { removed: result.removedCount, pruned: result.pruned, kept: result.kept.length };
}

/** 只保留 validIds 对应的分片；manifest 过期/被清理后回收 IndexedDB，避免配额累积。 */
export async function pruneLongshots(validIds) {
  const keep = new Set((Array.isArray(validIds) ? validIds : []).map((id) => String(id)));
  const db = await openDb();
  try {
    let removed = 0;
    for (const storeName of [STORE, TILE_STORE]) {
      removed += await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.openCursor();
        let count = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const captureId = cursor.value && cursor.value.captureId;
          if (!captureId || !keep.has(String(captureId))) { cursor.delete(); count += 1; }
          cursor.continue();
        };
        tx.oncomplete = () => resolve(count);
        tx.onerror = () => reject(tx.error || new Error('清理长截图失败'));
      });
    }
    return removed;
  } finally {
    db.close();
  }
}
