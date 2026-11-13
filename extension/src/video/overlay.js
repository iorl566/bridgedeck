/**
 * Callback that sends one overlay handshake action to the background.
 *
 * @typedef {(action: 'query' | 'interactive' | 'clean') =>
 *   Promise<{ recording_id: string | null }>} VideoOverlaySend
 *
 * @typedef {object} VideoOverlayMessage
 * @property {string} type Overlay message discriminator.
 * @property {string | null} recording_id Recording that owns the page, if any.
 */

// Kept independent of capture-suppress: short screenshots use a reference count;
// video owns an idempotent lease that survives a content script remount.
export const VIDEO_OVERLAY = 'bb/video-overlay';
export const VIDEO_OVERLAY_QUERY_TIMEOUT_MS = 3000;
const DISCOVERY_DELAYS_MS = [0, 250, 1000];

/**
 * Idempotent overlay lease for one content document. `known` becomes true once
 * discovery answers; `id` is the recording that currently owns the page, or
 * null when no recording is active.
 */
export class VideoOverlayGate {
  /**
   * @param {VideoOverlaySend} send
   * @param {() => void} render Repaint the local overlay state.
   * @param {() => Promise<void>} painted Resolves after the page painted the
   *   requested state.
   */
  constructor(send, render, painted) {
    this.send = send;
    this.render = render;
    this.painted = painted;
    this.id = null;
    this.known = false;
    this.interactive = false;
    this.allowed = false;
    this.generation = 0;
    this.pending = false;
    this.disposed = false;
    this.discovery = undefined;
  }

  /**
   * Start discovery for a new or restored document.
   *
   * @returns {Promise<void>} Resolves once discovery finished or was cancelled.
   */
  initialize() {
    if (this.disposed) return Promise.resolve();
    if (this.discovery) return this.discovery.promise;
    const generation = ++this.generation;
    // A new or restored document must not assume that capture is inactive.
    this.known = false;
    this.render();
    const controller = new AbortController();
    const promise = this.discover(generation, controller.signal).finally(() => {
      if (this.discovery?.controller === controller) this.discovery = undefined;
    });
    this.discovery = { controller, promise };
    return promise;
  }

  /** A later foreground transition or overlay request can restart an exhausted
   * discovery, without polling healthy pages or duplicating in-flight queries.
   *
   * @returns {boolean}
   */
  needsDiscovery() {
    return !this.disposed && !this.known && !this.discovery;
  }

  /**
   * Query the background with bounded retries and install the answer.
   *
   * @param {number} generation Discovery generation this run belongs to.
   * @param {AbortSignal} signal Cancels pending delays and replies.
   * @returns {Promise<void>}
   */
  async discover(generation, signal) {
    for (const [attempt, delay] of DISCOVERY_DELAYS_MS.entries()) {
      try {
        if (delay) await discoveryDelay(delay, signal);
        if (signal.aborted) return;
        const response = await discoveryReply(this.send('query'), signal);
        if (generation === this.generation) await this.set(response.recording_id);
        return;
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return;
        if (attempt === DISCOVERY_DELAYS_MS.length - 1) throw error;
      }
    }
  }

  /**
   * Abort the in-flight discovery run, if any.
   *
   * @returns {void}
   */
  cancelDiscovery() {
    this.discovery?.controller.abort();
    this.discovery = undefined;
  }

  /**
   * Permanently stop this lease and invalidate any in-flight work.
   *
   * @returns {void}
   */
  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.cancelDiscovery();
  }

  /**
   * Install the recording that owns this page and repaint.
   *
   * @param {string | null} id Recording id, or null when no recording is active.
   * @returns {Promise<void>}
   */
  async set(id) {
    if (this.disposed) return;
    this.cancelDiscovery();
    this.id = id;
    this.known = true;
    this.allowed = false;
    this.pending = false;
    this.generation += 1;
    this.render();
    await this.painted();
  }

  /**
   * Whether the inactive-page overlay may be painted right now.
   *
   * @returns {boolean}
   */
  canRenderControl() {
    return this.known && this.id === null;
  }

  /**
   * Whether an interactive overlay frame is currently safe to show.
   *
   * @param {boolean} visible Whether the interactive state was requested.
   * @returns {boolean}
   */
  canRenderInteractive(visible) {
    if (!this.known) return false;
    if (!this.id) return true;
    if (visible !== this.interactive || (visible && !this.allowed && !this.pending)) {
      this.interactive = visible;
      const generation = ++this.generation;
      if (visible) {
        this.pending = true;
        // The background closes frame intake and paints a neutral slate before
        // acknowledging. A failed handshake must never expose an overlay frame.
        void this.send('interactive').then(() => {
          if (generation !== this.generation) return;
          this.pending = false;
          this.allowed = true;
          this.render();
        }).catch(() => {
          if (generation === this.generation) this.pending = false;
        });
      } else {
        this.allowed = false;
        this.pending = false;
        void this.painted().then(() => {
          if (generation === this.generation) return this.send('clean');
        }).catch(() => {});
      }
    }
    return !visible || this.allowed;
  }

  /**
   * Release an interactive overlay after the page painted the clean state.
   *
   * @returns {Promise<void>}
   */
  async clean() {
    if (this.disposed || !this.id || this.interactive) return;
    await this.painted();
    if (!this.disposed && !this.interactive) await this.send('clean');
  }
}

/**
 * Wait for one retry delay, returning early when the signal aborts.
 *
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function discoveryDelay(ms, signal) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/**
 * Bound one discovery reply by a timeout and the surrounding abort signal.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
async function discoveryReply(promise, signal) {
  let timer;
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(new Error('Video overlay discovery cancelled'));
        timer = setTimeout(() => reject(new Error('Video overlay discovery timed out')), VIDEO_OVERLAY_QUERY_TIMEOUT_MS);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
