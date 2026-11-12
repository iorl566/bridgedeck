/**
 * Stored screenshot record.
 * @typedef {object} SavedScreenshot
 * @property {string} id Capture identity.
 * @property {string} title Document title.
 * @property {number} createdAt Creation time in milliseconds.
 * @property {number} width Pixel width.
 * @property {number} height Pixel height.
 * @property {Blob} blob Encoded image.
 *
 * @typedef {object} ScreenshotStorage
 * @property {(id: string) => Promise<SavedScreenshot | undefined>} readScreenshot Read one record.
 * @property {(value: SavedScreenshot) => Promise<void>} writeScreenshot Persist one record.
 */

const defaultStorage = createScreenshotStorage();

/**
 * @param {string} id Capture identity.
 * @returns {Promise<SavedScreenshot | undefined>}
 */
export function readScreenshot(id) {
  return defaultStorage.readScreenshot(id);
}

/**
 * @param {string} title Document title.
 * @param {number} createdAt Creation time in milliseconds.
 * @returns {string} Download file name.
 */
export function screenshotFilename(title, createdAt) {
  const name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Screenshot';
  return `${name}-${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}.png`;
}

/**
 * @param {{ factory?: IDBFactory }} [options] IndexedDB override; omit to use the page default.
 * @returns {ScreenshotStorage}
 */
export function createScreenshotStorage({ factory = globalThis.indexedDB } = {}) {
  const memory = new Map();
  async function openDatabase() {
    if (!factory) return null;
    return new Promise((resolve, reject) => {
      const request = factory.open('bb-long-screenshots', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('screenshots', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function readScreenshot(id) {
    if (!factory) return memory.get(id);
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('screenshots').objectStore('screenshots').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }
  async function writeScreenshot(value) {
    if (!factory) { memory.set(value.id, value); return; }
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('screenshots', 'readwrite');
        tx.objectStore('screenshots').put(value);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  return { readScreenshot, writeScreenshot };
}
