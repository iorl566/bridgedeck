import { isVideoId, VIDEO_BUDGET_BYTES, VIDEO_MAX_BYTES } from './types.js';

const DATABASE = 'bb-videos';
const DIRECTORY = 'videos';

/**
 * Storage options for video artifacts. Recording metadata lives in an object
 * store, media files in the origin-private file system.
 *
 * `StoredVideo` is declared in ./types.js; the bare name below refers to that
 * declaration.
 *
 * @typedef {object} VideoArtifactOptions
 * @property {IDBFactory} [factory] Object-store factory; when absent, records
 *   stay in memory for the lifetime of this instance.
 * @property {StorageManager} [storage] Origin-private file-system API.
 * @property {() => number} [now] Epoch-millisecond clock used for expiry.
 */

/**
 * Open the recordings database, creating its object store on first use.
 *
 * @param {IDBFactory} factory
 * @returns {Promise<IDBDatabase>}
 */
async function database(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('recordings', { keyPath: 'recording_id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run one object-store request and resolve with its result after commit.
 *
 * @template T
 * @param {IDBFactory} factory
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} run
 * @returns {Promise<T>}
 */
async function transaction(factory, mode, run) {
  const db = await database(factory);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('recordings', mode);
      const request = run(tx.objectStore('recordings'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Video storage transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/**
 * Resolve the per-recording media directory.
 *
 * @param {string} id Recording id.
 * @param {boolean} [create=false] Create the directory hierarchy when absent.
 * @param {StorageManager} [storage] Origin-private file-system API.
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function videoDirectory(id, create = false, storage = globalThis.navigator?.storage) {
  if (!isVideoId(id)) throw new Error('Invalid recording ID');
  if (!storage?.getDirectory) throw new Error('video storage unavailable');
  const root = await storage.getDirectory();
  const videos = await root.getDirectoryHandle(DIRECTORY, { create });
  return videos.getDirectoryHandle(id, { create });
}

/**
 * Bounded storage for video metadata and media files. Metadata uses the object
 * store when a factory is supplied and stays in memory otherwise; media files
 * always use the origin-private file system.
 */
export class VideoArtifactStore {
  /**
   * @param {VideoArtifactOptions} [options]
   */
  constructor({ factory = globalThis.indexedDB, storage = globalThis.navigator?.storage, now = Date.now } = {}) {
    this.factory = factory;
    this.storage = storage;
    this.now = now;
    this.values = new Map();
  }

  /**
   * @returns {Promise<StoredVideo[]>} All retained recordings.
   */
  async list() {
    if (!this.factory) return [...this.values.values()];
    return transaction(this.factory, 'readonly', (store) => store.getAll());
  }

  /**
   * @param {string} id
   * @returns {Promise<StoredVideo | undefined>}
   */
  async get(id) {
    if (!isVideoId(id)) return undefined;
    if (!this.factory) return this.values.get(id);
    return transaction(this.factory, 'readonly', (store) => store.get(id));
  }

  /**
   * Store or replace one recording record.
   *
   * @param {StoredVideo} value
   * @returns {Promise<void>}
   */
  async put(value) {
    if (!this.factory) {
      this.values.set(value.recording_id, structuredClone(value));
      return;
    }
    await transaction(this.factory, 'readwrite', (store) => store.put(value));
  }

  /**
   * Read the finished media file for one recording.
   *
   * @param {string} id
   * @returns {Promise<File>}
   */
  async file(id) {
    return videoDirectory(id, false, this.storage).then(async (directory) => (await directory.getFileHandle('video.mp4')).getFile());
  }

  /**
   * Delete one recording's media directory and metadata record.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    if (!isVideoId(id)) throw new Error('Invalid recording ID');
    if (this.factory) {
      try {
        const root = await this.storage.getDirectory();
        const videos = await root.getDirectoryHandle(DIRECTORY);
        await videos.removeEntry(id, { recursive: true });
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
      }
      await transaction(this.factory, 'readwrite', (store) => store.delete(id));
    } else this.values.delete(id);
  }

  /**
   * Drop expired recordings, keeping the recording that is still active.
   *
   * @param {string} [activeId] Recording to keep regardless of expiry.
   * @returns {Promise<void>}
   */
  async prepare(activeId) {
    for (const recording of await this.list()) {
      if (recording.recording_id !== activeId && recording.expires_at <= this.now()) await this.remove(recording.recording_id);
    }
  }

  /**
   * Check that a new recording and its remux fit in the retained budget and
   * in the remaining origin quota, without evicting unexpired recordings.
   *
   * @returns {Promise<void>}
   */
  async reserve() {
    await this.prepare();
    const values = await this.list();
    let used = 0;
    if (this.factory) {
      for (const value of values) {
        for (const filename of ['video.mp4', 'fragments.mp4']) {
          try {
            const directory = await videoDirectory(value.recording_id, false, this.storage);
            used += (await (await directory.getFileHandle(filename)).getFile()).size;
          } catch (error) {
            if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
          }
        }
      }
    }
    if (used + VIDEO_MAX_BYTES * 2 > VIDEO_BUDGET_BYTES) throw new Error('Video storage is full; save and delete an earlier recording');
    if (this.storage?.estimate) {
      const estimate = await this.storage.estimate();
      if ((estimate.quota ?? Infinity) - (estimate.usage ?? 0) < VIDEO_MAX_BYTES * 2) throw new Error('Not enough browser storage for a video; free space and try again');
    }
  }
}
