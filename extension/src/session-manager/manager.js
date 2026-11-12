import { AGENT_WINDOW_HOME } from './agent-window.js';
import { RefStore } from './ref-store.js';

/**
 * Extension-side session registry.
 *
 * The daemon keeps its own registry of sessions; this module is the mirror that
 * holds, per session, the Agent Window identity, the ref store, and every tab
 * the session may operate. Tool implementations resolve a `session_id` here to
 * answer "which window, which tab, which ref".
 *
 * Ownership is explicit. A tab is controllable only once the session has
 * created it, borrowed it, or observed it as a task popup, which keeps tabs the
 * user opens through browser UI outside every tool's default target set.
 *
 * @typedef {object} SessionContext
 * @property {object} [controller] Caller identity negotiated at session start.
 * @property {boolean} [incognito] Private sessions cannot borrow user tabs.
 * @property {boolean} [remote] Remote sessions retain dedicated windows and explicit ownership.
 * @property {string} sessionId Stable session identity.
 * @property {number} agentWindowId Browser window owned by the session.
 * @property {object} refStore Published refs for the session.
 * @property {'strict' | 'target'} [controlPolicy] Negotiated control policy.
 * @property {Map<number, BorrowedTab>} borrowedTabs Committed user-tab borrows.
 * @property {Set<number>} agentCreatedTabs Tabs the agent explicitly created, including the home tab.
 * @property {Set<number>} [observedTabs] Same-window popups that are controllable but preserved on stop.
 * @property {Set<number>} [pendingRoutingTabs] Unclassified arrivals excluded from default targets.
 * @property {number} createdAtMs Creation time from the injected clock.
 *
 * @typedef {object} BorrowedTab
 * @property {number} tabId Borrowed tab.
 * @property {number} originalWindowId Window the tab came from.
 * @property {number} originalIndex Position in the original window.
 * @property {number} [leftNeighborTabId] Left neighbor at borrow time.
 * @property {number} [rightNeighborTabId] Right neighbor at borrow time.
 * @property {number[]} [leftNeighborTabIds] Ordered left neighbors, closest first.
 * @property {number[]} [rightNeighborTabIds] Ordered right neighbors, closest first.
 * @property {number} [originalGroupId] Group identity when the tab was grouped.
 * @property {{ title?: string, color?: string, collapsed?: boolean }} [originalGroup] Group snapshot for recreation.
 * @property {boolean} [originalPinned] Whether the tab was pinned before borrowing.
 *
 * @typedef {object} BorrowReservation
 * @property {() => void} release Cancel the reservation without committing.
 * @property {(entry: BorrowedTab) => void} commit Publish the borrow for this tab.
 *
 * @typedef {object} BorrowConflict
 * @property {string} borrowedBy Session that already owns or holds the tab.
 *
 * @typedef {object} SessionManagerOptions
 * @property {() => boolean} [remote] Whether new sessions are remote.
 * @property {object} [agentWindow] Window API for creating and closing Agent Windows.
 * @property {() => number} [now] Clock used for creation timestamps.
 *
 * @typedef {object} SessionStartOptions
 * @property {object} [controller] Caller identity for the new session.
 * @property {boolean} [incognito] Use a private Agent Window.
 * @property {{ width: number, height: number }} [size] Optional outer window size.
 * @property {boolean} [focused] Open the window in front instead of in the background.
 * @property {AbortSignal} [signal] Cancels the transactional startup sequence.
 * @property {'strict' | 'target'} [controlPolicy] Negotiated control policy.
 */

/**
 * True when a tab is owned, borrowed or observed by the session.
 *
 * Tab creation alone does not grant control: only the three explicit sets
 * tracked on the context do, so a tab the user opens next to a task stays
 * outside tool targeting until the agent claims it.
 *
 * @param {SessionContext} ctx Session context.
 * @param {number} tabId Tab to test.
 * @returns {boolean} Whether the session may operate the tab by default.
 */
export function isAgentControlledTab(ctx, tabId) {
  return ctx.agentCreatedTabs.has(tabId) || ctx.borrowedTabs.has(tabId) || (ctx.observedTabs?.has(tabId) ?? false);
}

/**
 * Failure that carries both the startup error and the failed window cleanup.
 *
 * The original startup failure stays reachable so the daemon can report the
 * real cause, while the window handle stays visible for a retried stop.
 */
export class SessionStartCleanupError extends Error {
  /**
   * @param {number} windowId Agent Window that could not be removed.
   * @param {unknown} startupError Original session start failure.
   * @param {unknown} cleanupError Window removal failure.
   */
  constructor(windowId, startupError, cleanupError) {
    const startupMessage = startupError instanceof Error ? startupError.message : String(startupError);
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    super(`session_start failed (${startupMessage}) and cleanup of Agent Window ${windowId} failed: ${cleanupMessage}`);
    this.name = 'SessionStartCleanupError';
    this.windowId = windowId;
    this.startupError = startupError;
    this.cleanupError = cleanupError;
  }
}

/**
 * Registry and lifecycle owner for Agent Window sessions.
 *
 * A context is registered only after its window and home tab exist, so a
 * failed startup never leaves a half-visible session behind. Removal is
 * synchronous on release and asynchronous on stop, which lets browser event
 * handlers drop ownership immediately while a normal stop waits for the window
 * to close.
 */
export class SessionManager {
  /** @param {SessionManagerOptions} [options] Injected window API and clock. */
  constructor(options = {}) {
    this.remote = options.remote ?? (() => false);
    this.agentWindow = options.agentWindow;
    this.now = options.now ?? Date.now;
    this.sessions = new Map();
    this.windowIndex = new Map();
    this.borrowReservations = new Map();
    this.expectedWindowClosures = new WeakSet();
  }

  /**
   * @param {string} sessionId Session identity.
   * @returns {boolean} Whether the session is registered.
   */
  has(sessionId) { return this.sessions.has(sessionId); }
  /**
   * @param {string} sessionId Session identity.
   * @returns {SessionContext | null} Registered context, or null when unknown.
   */
  get(sessionId) { return this.sessions.get(sessionId) ?? null; }
  /**
   * Whether the pending window removal belongs to a normal stop.
   *
   * Event handlers use this to distinguish a browser event caused by our own
   * teardown from a user closing the window, so a stop is not reported twice.
   *
   * @param {SessionContext} ctx Session whose window is closing.
   * @returns {boolean} True while a committed close is in progress.
   */
  isWindowCloseExpected(ctx) { return this.expectedWindowClosures.has(ctx); }

  /**
   * Mark the committed window-removal stage of a stop.
   *
   * The flag is scoped to one close call and cleared in `finally`: a failed
   * removal must not hide a later user-initiated close of the same window.
   *
   * @template T
   * @param {SessionContext} ctx Session whose window is closing.
   * @param {() => Promise<T>} close Window removal call.
   * @returns {Promise<T>} Result of `close`.
   */
  async withExpectedWindowClose(ctx, close) {
    this.expectedWindowClosures.add(ctx);
    try {
      return await close();
    } finally {
      this.expectedWindowClosures.delete(ctx);
    }
  }

  /**
   * @param {number} windowId Agent Window identity.
   * @returns {SessionContext | null} Owning session, or null for a foreign window.
   */
  findByWindowId(windowId) {
    const id = this.windowIndex.get(windowId);
    return id ? (this.sessions.get(id) ?? null) : null;
  }
  /** @returns {SessionContext[]} Live session contexts in registration order. */
  list() { return Array.from(this.sessions.values()); }

  /** Forget every ref published for a tab whose document is gone.
   * @param {number} tabId Invalidated tab.
   */
  invalidateTabRefs(tabId) {
    for (const ctx of this.sessions.values()) ctx.refStore.invalidateTab(tabId);
  }

  /**
   * Forget a tab the browser has removed, including an uncommitted borrow.
   *
   * A whole-window closure keeps committed borrows until the window-removed
   * handler reports which user tabs could not be returned; deleting them earlier
   * would lose the evidence needed for that report.
   *
   * @param {number} tabId Closed tab.
   * @param {{ isWindowClosing?: boolean }} [options] Keep borrow snapshots while a window closes.
   */
  forgetClosedTab(tabId, { isWindowClosing = false } = {}) {
    this.borrowReservations.delete(tabId);
    this.invalidateTabRefs(tabId);
    for (const ctx of this.sessions.values()) {
      ctx.agentCreatedTabs.delete(tabId);
      ctx.observedTabs?.delete(tabId);
      if (!isWindowClosing) ctx.borrowedTabs.delete(tabId);
    }
  }

  /**
   * All kinds of committed control, not just borrowed tabs.
   * @param {number} tabId Tab to look up.
   * @returns {string | null} Session currently controlling the tab.
   */
  findControllingSession(tabId) {
    return this.list().find((ctx) => isAgentControlledTab(ctx, tabId))?.sessionId ?? null;
  }

  /**
   * Observation does not follow a page the user moved out of the window.
   * @param {number} tabId Observed tab.
   * @returns {string[]} Sessions that released it.
   */
  releaseObservedTab(tabId) {
    const released = [];
    for (const ctx of this.sessions.values()) {
      if (ctx.observedTabs?.delete(tabId)) {
        ctx.refStore.invalidateTab(tabId);
        released.push(ctx.sessionId);
      }
    }
    return released;
  }

  /**
   * Whether a tab is borrowed, or being borrowed, by another session.
   *
   * Used before a borrow to refuse a second owner for the same tab, and while
   * closing a tab to tell a user page apart from another session's borrow,
   * which must never be operated directly.
   *
   * @param {number} tabId Tab to test.
   * @param {string | null} currentSessionId Session allowed to own the tab.
   * @returns {string | null} Other session that borrowed or reserved the tab.
   */
  findBorrowingSession(tabId, currentSessionId) {
    for (const ctx of this.sessions.values()) {
      if (ctx.sessionId === currentSessionId) continue;
      if (ctx.borrowedTabs.has(tabId)) return ctx.sessionId;
    }
    const reservedBy = this.borrowReservations.get(tabId);
    if (reservedBy && reservedBy !== currentSessionId) return reservedBy;
    return null;
  }

  /**
   * Reserve a tab before the borrow handler performs any awaited browser work.
   *
   * The reservation closes the cross-session race between the "is anyone
   * borrowing this tab?" check and the eventual borrow write after the browser
   * has moved the tab. A conflict is reported as data rather than thrown so the
   * caller can answer with its normal transport error frame.
   *
   * @param {number} tabId Tab to reserve.
   * @param {string} sessionId Requesting session.
   * @returns {BorrowConflict | BorrowReservation} Conflict report or reservation handle.
   */
  tryReserveBorrow(tabId, sessionId) {
    const borrowedBy = this.findBorrowingSession(tabId, null);
    if (borrowedBy) return { borrowedBy };
    this.borrowReservations.set(tabId, sessionId);
    let released = false;
    return {
      release: () => {
        if (!released && this.borrowReservations.get(tabId) === sessionId) this.borrowReservations.delete(tabId);
        released = true;
      },
      commit: (entry) => {
        if (released) throw new Error('borrow reservation released');
        const ctx = this.sessions.get(sessionId);
        if (!ctx) throw new Error('session not found');
        ctx.borrowedTabs.set(tabId, entry);
        this.borrowReservations.delete(tabId);
        released = true;
      },
    };
  }

  /**
   * Spin up a session: open an Agent Window with a blank home tab and register
   * the context.
   *
   * Startup is transactional. A failure after the window exists removes it
   * before the original error is rethrown, and a removal that also fails keeps
   * a pending context so a retried stop can still close that exact window. The
   * home tab is claimed by identity at creation time, before any initialization
   * can fail, so events arriving first are never mistaken for user actions.
   *
   * @param {string} sessionId Unique session identity.
   * @param {SessionStartOptions} [opts] Window creation hints.
   * @returns {Promise<SessionContext>} Registered context.
   * @throws {Error} When the session exists, startup is aborted, the window API
   *   is unavailable, or window creation fails.
   * @throws {SessionStartCleanupError} When startup failed and the created
   *   window could not be removed.
   */
  async start(sessionId, opts = {}) {
    if (opts.signal?.aborted) throw Object.assign(new Error('session_start aborted'), { name: 'AbortError' });
    if (this.sessions.has(sessionId)) throw new Error('session already exists');
    if (!this.agentWindow) throw new Error('agent window API is unavailable');
    const created = await this.agentWindow.create(AGENT_WINDOW_HOME, { size: opts.size, focused: opts.focused ?? false, incognito: opts.incognito ?? false });
    let homeTabId;
    try {
      homeTabId = await this.agentWindow.ensureActiveTab(created.windowId, AGENT_WINDOW_HOME, new Set(created.initialTabIds));
    } catch (error) {
      try { await this.agentWindow.remove(created.windowId); } catch (cleanupError) { throw new SessionStartCleanupError(created.windowId, error, cleanupError); }
      throw error;
    }
    const ctx = {
      controller: opts.controller,
      incognito: created.incognito ?? opts.incognito ?? undefined,
      remote: this.remote(),
      sessionId,
      agentWindowId: created.windowId,
      refStore: new RefStore(),
      controlPolicy: opts.controlPolicy,
      borrowedTabs: new Map(),
      agentCreatedTabs: new Set([homeTabId]),
      observedTabs: new Set(),
      pendingRoutingTabs: new Set(),
      createdAtMs: this.now(),
    };
    this.sessions.set(sessionId, ctx);
    this.windowIndex.set(created.windowId, sessionId);
    return ctx;
  }

  /**
   * Tear down a session: close its Agent Window and drop the context.
   *
   * `dropOnly` skips closing the window, which is the path used when the user
   * already closed it: the context is dropped without ever acting on a window
   * that may have been re-purposed in the meantime.
   *
   * @param {string} sessionId Session to stop.
   * @param {{ dropOnly?: boolean }} [options] Keep the window when `dropOnly` is set.
   * @returns {Promise<SessionContext | null>} Removed context, or null when unknown.
   */
  async stop(sessionId, options = {}) {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return null;
    this.sessions.delete(sessionId);
    this.windowIndex.delete(ctx.agentWindowId);
    if (!options.dropOnly && this.agentWindow) {
      await this.withExpectedWindowClose(ctx, () => this.agentWindow.remove(ctx.agentWindowId));
    }
    return ctx;
  }

  /**
   * End ownership synchronously without moving or closing any browser page.
   *
   * Pending borrow reservations owned by the session are dropped too, so a
   * borrow that was still awaiting browser work cannot commit into a context
   * that no longer exists.
   *
   * @param {string} sessionId Session to release.
   * @returns {SessionContext | null} Removed context without closing its window.
   */
  release(sessionId) {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return null;
    this.sessions.delete(sessionId);
    this.windowIndex.delete(ctx.agentWindowId);
    for (const [tabId, owner] of this.borrowReservations) {
      if (owner === sessionId) this.borrowReservations.delete(tabId);
    }
    return ctx;
  }

  /**
   * Best-effort cleanup of every live session, as on emergency brake or worker
   * shutdown.
   *
   * Sessions are removed one at a time from a snapshot of the registry, so a
   * failure in one stop leaves the remaining ids still queued for cleanup.
   *
   * @param {{ dropOnly?: boolean }} [options] Keep each Agent Window open when `dropOnly` is set.
   * @returns {Promise<string[]>} Sessions that were stopped.
   */
  async stopAll(options = {}) {
    const ids = [];
    for (const sessionId of [...this.sessions.keys()]) {
      if (options.dropOnly) this.release(sessionId);
      else await this.stop(sessionId);
      ids.push(sessionId);
    }
    return ids;
  }
}
