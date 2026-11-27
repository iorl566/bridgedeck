export const SCREENSHOT_CHUNK_BYTES = 256 * 1024;
const EXPORT_IDLE_MS = 10 * 60_000;

/**
 * One export owned by a session.
 * @typedef {object} ScreenshotExportEntry
 * @property {string} sessionId Owning session.
 * @property {Blob} file Stored image.
 * @property {number} touched Last read time in milliseconds.
 */

/**
 * @typedef {object} ScreenshotReadParams
 * @property {string} capture_id Export identity.
 * @property {string} session_id Requesting session.
 * @property {number} offset Byte offset to read from.
 *
 * @typedef {object} ScreenshotReleaseParams
 * @property {string} capture_id Export identity.
 * @property {string} session_id Requesting session.
 *
 * @typedef {{ data_base64: string, next_offset: number, eof: boolean } | { code: 'not_found' | 'invalid_params', message: string }} ScreenshotReadResult
 */

/** Private Agent exports. Popup previews never enter this store. Files stay on
 * disk; only one bounded slice is materialized for each transport response. */
export class ScreenshotExports {
  /**
   * @param {(sessionId: string) => boolean} hasSession Live-session check.
   * @param {{ removeTiledScreenshot?: (id: string) => Promise<void>, removeOrphans?: () => Promise<void>, now?: () => number }} [deps] Storage hooks and clock.
   */
  constructor(hasSession, deps = {}) {
    this.hasSession = hasSession;
    this.removeTiledScreenshot = deps.removeTiledScreenshot ?? (async () => {});
    this.removeOrphans = deps.removeOrphans ?? (async () => {});
    this.now = deps.now ?? Date.now;
    this.entries = new Map();
    this.pendingDeletes = new Set();
    this.ready = undefined;
    this.timer = undefined;
    this.closed = false;
  }

  /** @returns {Promise<void>} Resolves after orphan cleanup and the sweep timer start. */
  prepare() {
    if (this.closed) return Promise.reject(new Error('Screenshot exports closed'));
    this.ready ??= this.removeOrphans().then(() => {
      if (this.closed) throw new Error('Screenshot exports closed');
      this.timer = setInterval(() => void this.sweep(), 60_000);
    }).catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  /**
   * @param {string} sessionId Owning session.
   * @param {string} id Export identity.
   * @param {Blob} file Stored image.
   */
  put(sessionId, id, file) {
    if (this.closed || !this.hasSession(sessionId)) throw new Error('Screenshot session ended');
    this.entries.set(id, { sessionId, file, touched: this.now() });
  }

  /**
   * @param {ScreenshotReadParams} params Byte range request.
   * @returns {Promise<ScreenshotReadResult>}
   */
  async read(params) {
    const entry = this.get(params);
    if (!entry) return { code: 'not_found', message: 'Screenshot export expired or not owned by this session' };
    if (!Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > entry.file.size) return { code: 'invalid_params', message: 'Invalid screenshot byte offset' };
    entry.touched = this.now();
    const next = Math.min(entry.file.size, params.offset + SCREENSHOT_CHUNK_BYTES);
    const bytes = new Uint8Array(await entry.file.slice(params.offset, next).arrayBuffer());
    const parts = [];
    for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    return { data_base64: btoa(parts.join('')), next_offset: next, eof: next === entry.file.size };
  }

  /**
   * @param {ScreenshotReleaseParams} params Release request.
   * @returns {Promise<{ released: boolean }>}
   */
  async release(params) {
    if (!this.get(params)) return { released: false };
    await this.discard(params.capture_id);
    return { released: true };
  }

  /**
   * @param {ScreenshotReleaseParams} params Session and export identity.
   * @returns {ScreenshotExportEntry | undefined} Entry while it is live and owned.
   */
  get(params) {
    const entry = this.entries.get(params.capture_id);
    return entry && entry.sessionId === params.session_id && this.hasSession(params.session_id) && this.now() - entry.touched < EXPORT_IDLE_MS ? entry : undefined;
  }

  /** Revoke reads immediately; retry failed disk cleanup without retaining the Blob.
   * @param {string} id Export identity.
   * @returns {Promise<void>}
   */
  async discard(id) {
    this.entries.delete(id);
    this.pendingDeletes.add(id);
    try {
      await this.removeTiledScreenshot(id);
      this.pendingDeletes.delete(id);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') this.pendingDeletes.delete(id);
    }
  }

  /**
   * @param {string} sessionId Ended session.
   * @returns {Promise<void>}
   */
  async releaseSession(sessionId) {
    for (const [id, entry] of this.entries) if (entry.sessionId === sessionId) await this.discard(id);
  }

  /** Delete retained failures and every export older than the idle window.
   * @returns {Promise<void>}
   */
  async sweep() {
    for (const id of this.pendingDeletes) await this.discard(id);
    for (const [id, entry] of this.entries) {
      if (!this.hasSession(entry.sessionId) || this.now() - entry.touched >= EXPORT_IDLE_MS) await this.discard(id);
    }
  }

  /** Stop the sweep timer and delete every remaining export.
   * @returns {Promise<void>}
   */
  async dispose() {
    this.closed = true;
    clearInterval(this.timer);
    for (const id of new Set([...this.entries.keys(), ...this.pendingDeletes])) await this.discard(id);
  }
}
