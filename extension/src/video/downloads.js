import { videoFilename } from './types.js';

export const DOWNLOAD_PREFIX = 'bb-video-download-';

/**
 * One persisted download job, keyed by the browser download id.
 *
 * `VideoManager` is declared in ./manager.js and `VideoHost` in
 * ./host-protocol.js; the bare names below refer to those declarations.
 *
 * @typedef {object} VideoDownloadJob
 * @property {string} recording Recording whose artifact is being saved.
 * @property {string} url Temporary object URL that must be revoked.
 *
 * @typedef {object} VideoDownloadsDeps
 * @property {object} [downloads] Download API with `search` and `download`.
 * @property {object} [storage] Session storage API with `get`, `set` and `remove`.
 * @property {(handler: (delta: { id: number }) => void) => void} [onChanged]
 *   Subscribe to download state changes.
 */

/**
 * Persist the download ID across service-worker suspension. Mark saved only
 * after the browser reports a completed file, including when the preview is closed.
 */
export class VideoDownloads {
  /**
   * @param {VideoManager} video Recording manager used to read and mark recordings.
   * @param {VideoHost} host Encoder host that issues and revokes download URLs.
   * @param {VideoDownloadsDeps} [deps]
   */
  constructor(video, host, deps = {}) {
    this.video = video;
    this.host = host;
    this.downloads = deps.downloads ?? globalThis.chrome?.downloads;
    this.storage = deps.storage ?? globalThis.chrome?.storage?.session;
    this.onChanged = deps.onChanged ?? ((handler) => globalThis.chrome?.downloads?.onChanged?.addListener?.(handler));
    this.settling = new Map();
  }

  /**
   * Subscribe to download state changes and settle jobs persisted earlier.
   *
   * @returns {void}
   */
  attach() {
    this.onChanged?.((delta) => { void this.settle(delta.id).catch(() => {}); });
    void this.storage?.get(null).then(async (values) => {
      for (const key of Object.keys(values)) {
        if (key.startsWith(DOWNLOAD_PREFIX)) await this.settle(Number(key.slice(DOWNLOAD_PREFIX.length)));
      }
    }).catch(() => {});
  }

  /**
   * Queue one settlement for a download id; overlapping calls share the queue.
   *
   * @param {number} id Browser download id.
   * @returns {Promise<void>}
   */
  settle(id) {
    const pending = (this.settling.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.settleOnce(id)).finally(() => {
      if (this.settling.get(id) === pending) this.settling.delete(id);
    });
    this.settling.set(id, pending);
    return pending;
  }

  /**
   * Mark the recording saved and release its URL once the file is no longer
   * in progress.
   *
   * @param {number} id Browser download id.
   * @returns {Promise<void>}
   */
  async settleOnce(id) {
    const key = `${DOWNLOAD_PREFIX}${id}`;
    const job = (await this.storage.get(key))[key];
    if (!job) return;
    const [download] = await this.downloads.search({ id });
    if (download?.state === 'in_progress') return;
    if (download?.state === 'complete') await this.video.exported(job.recording).catch(() => {});
    await this.host.request({ action: 'revoke_url', url: job.url });
    await this.storage.remove(key);
  }

  /**
   * Save a ready recording to a user-selected file.
   *
   * @param {string} recordingId
   * @returns {Promise<{ download_id: number }>}
   */
  async save(recordingId) {
    const value = await this.video.get(recordingId);
    if (value.state !== 'ready') throw new Error('Video is not ready to save');
    const url = await this.host.request({ action: 'download_url', recording_id: recordingId });
    try {
      const id = await this.downloads.download({ url, filename: videoFilename(value), saveAs: true });
      await this.storage.set({ [`${DOWNLOAD_PREFIX}${id}`]: { recording: recordingId, url } });
      await this.settle(id);
      return { download_id: id };
    } catch (error) {
      await this.host.request({ action: 'revoke_url', url }).catch(() => {});
      throw error;
    }
  }
}
