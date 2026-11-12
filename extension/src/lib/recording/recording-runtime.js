import { waitForDocumentSettled } from './document-settle.js';
import { RecordingObservationSession } from './observation-session.js';
import { inferMissingPostStates, SettleController } from './settle-controller.js';
import { RecordingStateRegistry } from './state-registry.js';
import { buildTraceV3 } from './trace-builder-v3.js';

/**
 * Per-tab recording runtime that owns observation sessions and settle queues.
 *
 * @typedef {object} PendingCapture
 * @property {AbortController} abort
 * @property {Promise<object>} promise
 *
 * @typedef {object} TabRecordingContext
 * @property {object} session
 * @property {object} settle
 * @property {PendingCapture | null} pendingCapture
 * @property {Promise<void>} frameRefresh
 * @property {AbortController | null} frameRefreshAbort
 *
 * @typedef {object} RecordingRuntimeDeps
 * @property {(input: object) => object} [createSession]
 * @property {(input: object) => object} [createSettle]
 * @property {object} [sessionDeps]
 * @property {object} [settleDeps]
 * @property {(cdp: object, scope: object, options: object, deps: object) => Promise<string>} [waitForSettle]
 */

export class RecordingObservationRuntime {
  /**
   * @param {{ cdp: object, tabsApi: object, maxTokens?: number, redactValues?: boolean, deps?: RecordingRuntimeDeps, isTabAllowed?: (tabId: number) => boolean }} input
   */
  constructor(input) {
    this.cdp = input.cdp;
    this.tabsApi = input.tabsApi;
    this.registry = new RecordingStateRegistry();
    this.annotations = [];
    this.contexts = new Map();
    this.maxTokens = input.maxTokens;
    this.redactValues = input.redactValues ?? false;
    this.cancelled = false;
    this.deps = input.deps ?? {};
    this.isTabAllowed = input.isTabAllowed;
  }

  /**
   * @param {number} tabId
   * @returns {TabRecordingContext}
   */
  context(tabId) {
    const existing = this.contexts.get(tabId);
    if (existing) return existing;
    const session = this.deps.createSession
      ? this.deps.createSession({ registry: this.registry, annotations: this.annotations, maxTokens: this.maxTokens, redactValues: this.redactValues })
      : new RecordingObservationSession({ registry: this.registry, annotations: this.annotations, maxTokens: this.maxTokens, redactValues: this.redactValues, deps: this.deps.sessionDeps });
    const settle = this.deps.createSettle
      ? this.deps.createSettle({ session, cdp: this.cdp, tabsApi: this.tabsApi, tabId })
      : new SettleController({ session, cdp: this.cdp, tabsApi: this.tabsApi, tabId, deps: this.deps.settleDeps });
    const context = { session, settle, pendingCapture: null, frameRefresh: Promise.resolve(), frameRefreshAbort: null };
    this.contexts.set(tabId, context);
    return context;
  }

  /**
   * @param {number} tabId
   * @returns {void}
   */
  check(tabId) {
    if (this.cancelled || (this.isTabAllowed && !this.isTabAllowed(tabId))) throw new Error('Recording capture is no longer authorized');
  }

  /**
   * @param {number} tabId
   * @returns {Promise<object>}
   */
  async capture(tabId) {
    const context = this.context(tabId);
    if (context.pendingCapture) return context.pendingCapture.promise;
    const abort = new AbortController();
    let pending;
    const promise = context.session.capture(this.cdp, this.tabsApi, tabId, abort.signal);
    pending = { abort, promise: promise.finally(() => { if (context.pendingCapture === pending) context.pendingCapture = null; }) };
    context.pendingCapture = pending;
    return pending.promise;
  }

  /**
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async captureInitial(tabId) {
    const context = this.context(tabId);
    if (context.session.cursor.lastSettled) return;
    await this.capture(tabId);
  }

  /**
   * Refresh the observation after a late child document becomes usable.
   *
   * @param {number} tabId
   * @param {string} producerId
   * @returns {Promise<void>}
   */
  async refreshDocument(tabId, producerId) {
    const context = this.context(tabId);
    context.frameRefreshAbort?.abort();
    const abort = new AbortController();
    context.frameRefreshAbort = abort;
    const previous = context.frameRefresh;
    const refresh = (async () => {
      await previous;
      if (abort.signal.aborted) return;
      if (context.pendingCapture) await Promise.allSettled([context.pendingCapture.promise]);
      if (abort.signal.aborted) return;
      await this.capture(tabId);
      if (abort.signal.aborted) return;
      const scope = context.session.cursor.lastSettled?.index.documentScope(producerId);
      if (scope) await (this.deps.waitForSettle ?? waitForDocumentSettled)(this.cdp, scope, { signal: abort.signal }, this.deps.settleDeps);
      if (abort.signal.aborted) return;
      await this.capture(tabId);
    })();
    const tracked = refresh.catch(() => {});
    context.frameRefresh = tracked;
    try { await refresh; } finally { if (context.frameRefresh === tracked) context.frameRefreshAbort = null; }
  }

  /**
   * @param {number} fromTabId
   * @param {number} toTabId
   * @returns {Promise<{ preStateId?: string, postStateId?: string, targetUrl?: string }>}
   */
  async captureTabTransition(fromTabId, toTabId) {
    const from = this.context(fromTabId);
    await this.flushContext(from);
    if (!from.session.cursor.lastSettled) {
      try { await this.captureInitial(fromTabId); } catch { /* keep forward transition */ }
    }
    const to = this.context(toTabId);
    let target = to.session.cursor.lastSettled;
    try { target = await this.capture(toTabId); } catch { /* reuse settled */ }
    const source = from.session.cursor.lastSettled;
    return { ...(source ? { preStateId: source.stateId } : {}), ...(target ? { postStateId: target.stateId, targetUrl: target.url } : {}) };
  }

  /**
   * @param {object} draft
   * @param {number} draftId
   * @returns {void}
   */
  bindTabTransition(draft, draftId) {
    if (draft.preStateId) this.registry.markStep(draft.preStateId, draftId);
  }

  /**
   * @param {number} tabId
   * @param {object[]} drafts
   * @param {number} draftIndex
   * @param {string} [producerId]
   * @returns {Promise<void>}
   */
  async processDraft(tabId, drafts, draftIndex, producerId) {
    const draft = drafts[draftIndex];
    if (!draft) return;
    const context = this.context(tabId);
    if (!context.session.cursor.lastSettled) {
      try { await this.captureInitial(tabId); } catch { /* settle can provide state */ }
    }
    const scope = producerId ? context.session.cursor.lastSettled?.index.documentScope(producerId) : undefined;
    if (producerId && ['click', 'hover', 'fill', 'press', 'select'].includes(draft.op)) {
      draft.targetHint = { ...(draft.targetHint ?? {}), frameId: scope?.frameId ?? null, geometrySpace: 'local' };
    }
    context.session.bindDraft(draft, draftIndex + 1, context.settle.hasPending);
    context.settle.schedule(drafts, draftIndex, scope);
  }

  /**
   * @param {number} tabId
   * @param {object[]} drafts
   * @param {number} draftIndex
   * @param {object} [scope]
   * @returns {void}
   */
  scheduleSettle(tabId, drafts, draftIndex, scope) { this.context(tabId).settle.schedule(drafts, draftIndex, scope); }
  /**
   * @param {number} tabId
   * @returns {void}
   */
  clearRedirect(tabId) { this.contexts.get(tabId)?.settle.clearRedirect(); }
  /**
   * @param {number} tabId
   * @param {object[]} drafts
   * @param {string} url
   * @returns {void}
   */
  scheduleRedirect(tabId, drafts, url) { this.context(tabId).settle.scheduleRedirect(drafts, url); }

  /**
   * @param {TabRecordingContext} context
   * @returns {Promise<void>}
   */
  async flushContext(context) {
    await context.frameRefresh;
    if (context.pendingCapture) await Promise.allSettled([context.pendingCapture.promise]);
    await context.settle.flushRedirects();
    await context.settle.flush();
  }

  /**
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async flushRedirects(tabId) { await this.contexts.get(tabId)?.settle.flushRedirects(); }
  /** @returns {Promise<void>} */
  async flush() { for (const context of this.contexts.values()) await this.flushContext(context); }

  /**
   * @param {number} tabId
   * @param {object[]} drafts
   * @returns {Promise<void>}
   */
  async settleTrailing(tabId, drafts) {
    const context = this.context(tabId);
    if (context.pendingCapture) await Promise.allSettled([context.pendingCapture.promise]);
    if (!context.session.cursor.lastSettled) {
      try { await this.captureInitial(tabId); } catch { /* no observation available */ }
    }
    await context.settle.settleTrailing(drafts);
    inferMissingPostStates(drafts);
  }

  /** @returns {void} */
  cancel() {
    this.cancelled = true;
    for (const context of this.contexts.values()) {
      context.frameRefreshAbort?.abort();
      context.pendingCapture?.abort.abort();
      context.settle.cancel();
    }
  }

  /**
   * @param {{ drafts: object[], startedAt: string, purpose?: string, startUrl?: string, stoppedBy: string, bskVersion: string, includeTabSwitches?: boolean }} input
   * @returns {object}
   */
  buildTrace(input) {
    return buildTraceV3({
      registry: this.registry,
      drafts: input.drafts,
      annotations: this.annotations,
      startedAt: input.startedAt,
      purpose: input.purpose,
      startUrl: input.startUrl,
      stoppedBy: input.stoppedBy,
      bskVersion: input.bskVersion,
      redactValues: this.redactValues,
      includeTabSwitches: input.includeTabSwitches,
    });
  }
}
