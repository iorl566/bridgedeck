import { waitForDocumentSettled } from './document-settle.js';

/**
 * Schedule post-action observations and settle redirects.
 *
 * @typedef {object} PendingSettle
 * @property {AbortController} abort
 * @property {{ target: object, frameId?: string }} scope
 *
 * @typedef {object} PendingRedirect
 * @property {string} url
 * @property {AbortController} abort
 *
 * @typedef {object} SettleControllerDeps
 * @property {(cdp: object, scope: object, options: object, deps: object) => Promise<string>} [waitForSettle]
 */

const CAPTURE_RETRY_DELAY_MS = 250;

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) { return typeof error === 'object' && error !== null && error.name === 'AbortError'; }

/**
 * @param {object[]} drafts
 * @returns {void}
 */
export function inferMissingPostStates(drafts) {
  for (let index = 0; index < drafts.length - 1; index += 1) {
    const draft = drafts[index];
    const next = drafts[index + 1];
    if (draft && next && !draft.postStateId && next.preStateId) draft.postStateId = next.preStateId;
  }
}

/** Owns the ordered queue of settle and capture tasks for one tab. */
export class SettleController {
  /**
   * @param {{ session: object, cdp: object, tabsApi: object, tabId: number, deps?: SettleControllerDeps }} input
   */
  constructor(input) {
    this.session = input.session;
    this.cdp = input.cdp;
    this.tabsApi = input.tabsApi;
    this.tabId = input.tabId;
    this.rootScope = { target: { tabId: input.tabId } };
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.pendingRedirect = null;
    this.redirectQueue = Promise.resolve();
    this.deps = input.deps ?? {};
    this.waitForSettle = this.deps.waitForSettle ?? waitForDocumentSettled;
  }

  /** @returns {boolean} */
  get hasPending() { return this.pending.size > 0 || this.pendingRedirect !== null; }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async captureWithRetry(signal) {
    try {
      return await this.session.capture(this.cdp, this.tabsApi, this.tabId, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      await delay(CAPTURE_RETRY_DELAY_MS, signal);
      return this.session.capture(this.cdp, this.tabsApi, this.tabId, signal);
    }
  }

  /**
   * @param {object[]} drafts
   * @param {number} draftIndex
   * @param {{ target: object, frameId?: string }} [scope]
   * @returns {void}
   */
  schedule(drafts, draftIndex, scope = this.rootScope) {
    if (scope.target.tabId !== this.tabId) throw new Error(`settle scope tab ${scope.target.tabId} does not belong to tab ${this.tabId}`);
    const landing = drafts[draftIndex]?.preStateId;
    for (const [index, pending] of this.pending) {
      if (index >= draftIndex) continue;
      pending.abort.abort();
      this.pending.delete(index);
      if (landing && drafts[index] && !drafts[index].postStateId) drafts[index].postStateId = landing;
    }
    this.pending.get(draftIndex)?.abort.abort();
    const pending = { abort: new AbortController(), scope };
    this.pending.set(draftIndex, pending);
    const task = async () => {
      if (pending.abort.signal.aborted) return;
      try {
        const outcome = await this.waitForSettle(this.cdp, pending.scope, { signal: pending.abort.signal }, this.deps);
        if (outcome === 'cancelled') return;
        const observation = await this.captureWithRetry(pending.abort.signal);
        if (!pending.abort.signal.aborted && drafts[draftIndex]) drafts[draftIndex].postStateId = observation.stateId;
      } catch (error) {
        if (!isAbortError(error)) { /* observation failure is best-effort */ }
      } finally {
        if (this.pending.get(draftIndex) === pending) this.pending.delete(draftIndex);
      }
    };
    this.queue = this.queue.then(task, task).catch(() => {});
  }

  /** @returns {void} */
  cancel() {
    for (const pending of this.pending.values()) pending.abort.abort();
    this.pending.clear();
    this.clearRedirect();
  }

  /** @returns {Promise<void>} */
  async flush() {
    for (let round = 0; round < 10; round += 1) {
      const current = this.queue;
      await current;
      if (current === this.queue) return;
    }
  }

  /**
   * @param {object[]} drafts
   * @returns {Promise<void>}
   */
  async settleTrailing(drafts) {
    const trailing = [];
    for (let index = drafts.length - 1; index >= 0; index -= 1) {
      const draft = drafts[index];
      if (!draft || draft.postStateId) break;
      trailing.push(draft);
    }
    if (trailing.length === 0) return;
    try {
      const observation = await this.captureWithRetry();
      for (const draft of trailing) draft.postStateId = observation.stateId;
    } catch { /* final observation is best-effort */ }
  }

  /** @returns {void} */
  clearRedirect() {
    this.pendingRedirect?.abort.abort();
    this.pendingRedirect = null;
  }

  /**
   * @param {object[]} drafts
   * @param {string} url
   * @returns {void}
   */
  scheduleRedirect(drafts, url) {
    this.pendingRedirect?.abort.abort();
    const pending = { url, abort: new AbortController() };
    this.pendingRedirect = pending;
    const task = () => this.settleRedirect(drafts, pending);
    this.redirectQueue = this.redirectQueue.then(task, task).catch(() => {});
  }

  /**
   * @param {object[]} drafts
   * @param {PendingRedirect} pending
   * @returns {Promise<void>}
   */
  async settleRedirect(drafts, pending) {
    const outcome = await this.waitForSettle(this.cdp, this.rootScope, { signal: pending.abort.signal }, this.deps);
    if (outcome === 'cancelled' || this.pendingRedirect !== pending) return;
    let finalUrl = pending.url;
    try { finalUrl = (await this.tabsApi.get(this.tabId)).url || finalUrl; } catch { /* keep event URL */ }
    if (this.pendingRedirect !== pending) return;
    this.pendingRedirect = null;
    if (!finalUrl || finalUrl === 'about:blank' || this.session.cursor.lastSettled?.url === finalUrl) return;
    const last = drafts[drafts.length - 1];
    if (last?.op === 'navigate' && last.url === finalUrl) {
      if (!last.postStateId) this.schedule(drafts, drafts.length - 1);
      await this.flush();
      return;
    }
    const draft = { op: 'navigate', url: finalUrl, pageUrl: finalUrl, cause: 'browser', transitionQualifiers: ['server_redirect'], preStateId: this.session.cursor.lastSettled?.stateId };
    drafts.push(draft);
    const draftIndex = drafts.length - 1;
    if (draft.preStateId) this.session.registry.markStep(draft.preStateId, draftIndex + 1);
    this.schedule(drafts, draftIndex);
    await this.flush();
  }

  /** @returns {Promise<void>} */
  async flushRedirects() {
    for (let round = 0; round < 10; round += 1) {
      const current = this.redirectQueue;
      await current;
      if (current === this.redirectQueue) return;
    }
  }
}
