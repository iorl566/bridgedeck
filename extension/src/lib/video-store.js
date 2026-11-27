// extension/src/lib/video-store.js —— 视频 IDB 访问（从 video.js 拆出）。
const DB_NAME = 'bb-videos';
const STORE = 'videos';
const CHUNK_STORE = 'chunks';

export function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败'));
  });
}

export async function listRecords() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('读取录制失败'));
    });
  } finally {
    db.close();
  }
}

export async function readRecord(id) {
  const records = await listRecords();
  return records.find((item) => item.id === id) || null;
}

export async function deleteRecord(id) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('删除录制失败'));
    });
  } finally {
    db.close();
  }
}

/** 写入/覆盖整条录制记录（恢复审计回写、seal 证据回写使用）。 */
export async function saveRecord(record) {
  if (!record || !record.id) throw new Error('保存录制需要 id');
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('保存录制失败'));
    });
    return record;
  } finally {
    db.close();
  }
}

/** 按 id 合并补丁（只覆盖传入字段）；记录不存在返回 null，不新建。 */
export async function patchRecord(id, patch) {
  if (!patch || typeof patch !== 'object') return null;
  const existing = await readRecord(id);
  if (!existing) return null;
  const next = { ...existing, ...patch, id: existing.id };
  await saveRecord(next);
  return next;
}
