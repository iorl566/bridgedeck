/**
 * Race a command against a timeout and abort signal.
 *
 * @param {Promise<any>} promise
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function bounded(promise, timeoutMs, signal) {
  let timer;
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(signal?.reason ?? new Error('Screencast request cancelled'));
        timer = setTimeout(() => reject(new Error('Screencast command timed out')), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/**
 * One CDP stream and one ACK per frame, shared by video and render keepalive.
 *
 * Invariants:
 * * one stream per tab and attachment;
 * * one ACK for every delivered frame;
 * * one configure pass per request set;
 * * release is idempotent;
 * * a stale attachment never ACKs.
 *
 * Operations are serialized per tab so a late enable cannot outlive the
 * request set that asked for it. Consumers share the same stream and the
 * largest requested size wins; cleanup stops the stream once no consumer
 * remains or the attachment changed.
 *
 * Cleanup paths:
 * * no consumers stops the stream;
 * * a changed attachment disposes the old subscription;
 * * release waits for the serialized configure;
 * * failed configure restores the previous state;
 */
export class ScreencastCoordinator {
  /**
   * @param {object} cdp Driver exposing getAttachmentId, onEvent and send.
   */
  constructor(cdp) {
    this.cdp = cdp;
    this.entries = new Map();
    this.operations = new Map();
  }

  /**
   * Queue one operation behind the tab's previous operation.
   *
   * @param {number} tabId
   * @param {() => Promise<any>} operation
   * @returns {Promise<any>}
   */
  serialize(tabId, operation) {
    const result = (this.operations.get(tabId) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => {}, () => {}).finally(() => {
      if (this.operations.get(tabId) === settled) this.operations.delete(tabId);
    });
    this.operations.set(tabId, settled);
    return result;
  }

  /**
   * Join the stream for one tab, configuring it for `request`.
   *
   * The returned release removes this request and reconfigures the stream
   * when it was the last consumer. A changed debugger attachment tears down
   * the old subscription before a new stream is created.
   *
   * @param {number} tabId
   * @param {object} request Stream consumer with frame and max size.
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ release: () => Promise<void> }>}
   */
  acquire(tabId, request, signal) {
    return this.serialize(tabId, async () => {
      signal?.throwIfAborted();
      const attachment = this.cdp.getAttachmentId?.(tabId);
      if (!attachment || !this.cdp.onEvent) throw new Error('Screencast debugger connection is unavailable');
      let entry = this.entries.get(tabId);
      if (entry && entry.attachment !== attachment) {
        entry.subscription.dispose();
        this.entries.delete(tabId);
        entry = undefined;
      }
      if (!entry) {
        const created = {
          attachment,
          requests: new Set(),
          configuration: '',
          subscription: this.cdp.onEvent((source, method, params) => {
            if (source.tabId !== tabId || source.sessionId || method !== 'Page.screencastFrame' || this.cdp.getAttachmentId?.(tabId) !== attachment || this.entries.get(tabId) !== created) return;
            const frame = params;
            if (!Number.isInteger(frame.sessionId)) return;
            try {
              if (typeof frame.data === 'string' && frame.metadata) {
                for (const consumer of created.requests) {
                  try { consumer.frame?.(frame); } catch { /* one consumer cannot suppress another ACK */ }
                }
              }
            } finally {
              if (this.cdp.getAttachmentId?.(tabId) === attachment) void this.cdp.send(tabId, 'Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
            }
          }),
        };
        entry = created;
        this.entries.set(tabId, entry);
      }
      entry.requests.add(request);
      try {
        await this.configure(tabId, entry, signal);
      } catch (error) {
        entry.requests.delete(request);
        entry.configuration = '';
        await this.configure(tabId, entry).catch(() => {});
        throw error;
      }
      const owned = entry;
      let released = false;
      return {
        release: () => this.serialize(tabId, async () => {
          if (released) return;
          released = true;
          owned.requests.delete(request);
          if (this.entries.get(tabId) === owned) await this.configure(tabId, owned);
        }),
      };
    });
  }

  /**
   * Start, resize, or stop the stream to match the current request set.
   *
   * The largest surviving request defines the config. Stopping is bounded so
   * a dead attachment cannot block cleanup.
   *
   * @param {number} tabId
   * @param {object} entry
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async configure(tabId, entry, signal) {
    if (!entry.requests.size || this.cdp.getAttachmentId?.(tabId) !== entry.attachment) {
      this.entries.delete(tabId);
      entry.subscription.dispose();
      if (this.cdp.getAttachmentId?.(tabId) === entry.attachment) await bounded(this.cdp.send(tabId, 'Page.stopScreencast'), 1000);
      return;
    }
    const largest = [...entry.requests].sort((a, b) => b.maxWidth * b.maxHeight - a.maxWidth * a.maxHeight)[0];
    const { frame: _frame, ...config } = largest;
    const key = JSON.stringify(config);
    if (key === entry.configuration) return;
    if (entry.configuration) await bounded(this.cdp.send(tabId, 'Page.stopScreencast'), 1000, signal);
    await bounded(this.cdp.send(tabId, 'Page.startScreencast', config), 10000, signal);
    if (this.cdp.getAttachmentId?.(tabId) !== entry.attachment) throw new Error('Screencast connection changed');
    entry.configuration = key;
  }
}

const coordinators = new WeakMap();
export function screencasts(cdp) {
  let coordinator = coordinators.get(cdp);
  if (!coordinator) {
    coordinator = new ScreencastCoordinator(cdp);
    coordinators.set(cdp, coordinator);
  }
  return coordinator;
}

/** Request wrappers must reuse the driver's stream and cleanup ownership. */
export function shareScreencasts(owner, wrapper) {
  coordinators.set(wrapper, screencasts(owner));
}
