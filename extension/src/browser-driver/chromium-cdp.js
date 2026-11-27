// CDP-backed BrowserDriver implementation. Wraps the debugger API so each tool
// implementation can think in terms of typed `send()` calls and a single
// attach-once-per-tab cache.
//
// Lifecycle notes:
// * Attaching twice to the same tab fails with "Another debugger is already
//   attached"; attachments are tracked in `attachedTabs` to coalesce. The
//   protocol version pinned here ("1.3") is the stable revision drivers target.
// * Closing a tab implicitly detaches; higher-level code calls `detach()`
//   explicitly when a session stops so the "agent controlling" infobar is
//   visible only while it is actually needed.
// * A background service worker can be evicted mid-call. The wrapper
//   propagates debugger failures as thrown Errors so callers can decide
//   whether to retry or surface a normalized failure.
// * Native dialogs (alert / confirm / prompt / beforeunload) block the protocol
//   until dismissed. `Page.javascriptDialogOpening` retains pending state until
//   an explicit agent decision, and the actual closing event is recorded for
//   tool results.

import { BackgroundExecution } from './background-execution.js';
import { CdpReadGate, CdpReadTimeoutError, READ_TIMEOUT_MS } from './command-deadline.js';
import { cleanupWait } from './cdp-timing.js';
import { CdpFrameMethods } from './cdp-frames.js';
import { CdpDialogMethods } from './cdp-dialogs.js';
import { CdpConsoleMethods } from './cdp-console.js';
import { CdpNetworkMethods } from './cdp-network.js';
import { CdpEmulationMethods } from './cdp-emulation.js';
import { CdpSessionMethods } from './cdp-sessions.js';
export const CDP_PROTOCOL_VERSION = '1.3';


/**
 * Debuggee handle used for debugger commands: a tab, optionally scoped to
 * one flattened child session.
 * @typedef {object} CdpDebuggee
 * @property {number} tabId
 * @property {string} [sessionId]
 */

/**
 * A command target inside frame discovery: the tab itself, or one flattened
 * child session addressing a frame that runs out of process.
 * @typedef {object} CdpTarget
 * @property {number} tabId
 * @property {string} [sessionId] Flattened child session; omitted for the tab's root target.
 */

/**
 * Guards checked at native dispatch, after any asynchronous connection setup.
 * @typedef {object} CdpDispatchGuard
 * @property {AbortSignal} [signal]
 * @property {string} [attachmentId] Only use this live attachment; never reconnect a cleanup command.
 * @property {() => void} [onDispatch] Called immediately before native send, never for a cancelled or stale command.
 */

/**
 * CDP `Emulation.setDeviceMetricsOverride` payload.
 * @typedef {object} DeviceMetricsOverride
 * @property {number} width
 * @property {number} height
 * @property {number} deviceScaleFactor `0` asks the browser to use the display's native factor.
 * @property {boolean} mobile
 */

/**
 * CDP `Emulation.setUserAgentOverride` payload.
 * @typedef {object} UserAgentOverride
 * @property {string} userAgent
 * @property {string} [acceptLanguage]
 * @property {Record<string, unknown>} [userAgentMetadata] Already camelCase CDP metadata.
 */

/**
 * Minimal slice of the debugger API the rest of the driver depends on.
 * Stays an explicit object so tests can inject a fake without monkey-patching
 * the real extension global.
 * @typedef {object} CdpDebuggerApi
 * @property {(target: CdpDebuggee, requiredVersion: string) => Promise<void>} attach
 * @property {(target: CdpDebuggee) => Promise<void>} detach
 * @property {(target: CdpDebuggee, method: string, commandParams?: object) => Promise<unknown>} sendCommand
 * @property {{ addListener(fn: Function): void, removeListener(fn: Function): void }} onEvent
 * @property {{ addListener(fn: Function): void, removeListener(fn: Function): void }} onDetach
 */

/**
 * Production-backed debugger API. `onEvent` / `onDetach` are getters so the
 * module still loads where the extension API object is absent — the property
 * access only happens when a real caller wires the driver in.
 */
export const chromeDebuggerApi = {
  attach: (target, version) => chrome.debugger.attach(target, version),
  detach: (target) => chrome.debugger.detach(target),
  sendCommand: (target, method, params) => chrome.debugger.sendCommand(target, method, params),
  get onEvent() { return chrome.debugger.onEvent; },
  get onDetach() { return chrome.debugger.onDetach; },
};

/**
 * Constructor options. Observation alone is not enough authority: dialog
 * decisions and document invalidation are separate hooks.
 * @typedef {object} ChromiumCdpOptions
 * @property {(tabId: number) => boolean | Promise<boolean>} [canControlDialog] CDP observation alone does not authorize dismissing user dialogs.
 * @property {(tabId: number) => void} [onDocumentChanged] Invalidate tab references when the root document or the debugger attachment changes.
 * @property {(tabId: number, reason: string) => void} [onDetach] Notified when the browser releases the debugger.
 */

/** Per-tab monotonic sequence returned by `dialogCursor`. @typedef {number} DialogCursor */

/**
 * One of the native dialog kinds, normalized by the parser.
 * @typedef {'alert' | 'confirm' | 'prompt' | 'beforeunload'} JavaScriptDialogType
 */

/**
 * Dialog retained while the agent still has to decide.
 * @typedef {object} PendingJavaScriptDialog
 * @property {string} id
 * @property {number} tab_id
 * @property {JavaScriptDialogType} type
 * @property {string} message Bounded preview of the native message.
 * @property {string} [url]
 * @property {string} [default_prompt] Bounded preview of the native default text.
 * @property {number} sequence Per-tab monotonic order.
 * @property {number} decision_deadline Epoch milliseconds after which the dialog is rejected.
 */

/**
 * Closed dialog recorded for tool results.
 * @typedef {object} JavaScriptDialogInfo
 * @property {number} tab_id
 * @property {JavaScriptDialogType} type
 * @property {string} message
 * @property {string} [url]
 * @property {string} [default_prompt]
 * @property {boolean} [has_browser_handler] The page registered its own handler.
 * @property {'accepted' | 'dismissed'} handled
 * @property {number} sequence
 */

/**
 * Value kept in `pendingDialogEntries` for one tab.
 * @typedef {object} PendingDialogEntry
 * @property {PendingJavaScriptDialog} dialog
 * @property {CdpDebuggee} source Debuggee the opening event arrived on.
 * @property {string | undefined} attachmentId Attachment that observed the dialog.
 * @property {string} [defaultPrompt] Full native default text, kept privately for prompt submission.
 * @property {boolean} [hasBrowserHandler]
 * @property {boolean} resolving A decision is already talking to the browser.
 * @property {ReturnType<typeof setTimeout>} timer Deadline fallback.
 * @property {Set<(result: JavaScriptDialogInfo | Error) => void>} closed Waiters for the closing event.
 */

/**
 * Listener for `onDialogChanged`; `dialog` is null once the dialog closes.
 * @typedef {(tabId: number, dialog: PendingJavaScriptDialog | null, reason?: 'decision_timeout') => void} DialogChangedListener
 */

/** @typedef {'console' | 'exception' | 'log'} ConsoleEntryKind */

/**
 * One captured console line, replayable through `consoleEntriesSince`.
 * @typedef {object} ConsoleEntry
 * @property {number} sequence Per-tab monotonic order, also the read cursor.
 * @property {ConsoleEntryKind} kind
 * @property {string} level Level reported by the runtime or log domain.
 * @property {string} text Argument preview, bounded by the field length.
 * @property {string} [url] Source of the top stack frame.
 * @property {number} [line]
 * @property {number} [column]
 * @property {number} [timestamp]
 * @property {ConsoleStackFrame[]} [stack_trace] Bounded stack, omitted unless the read asks for it.
 * @property {boolean} truncated A field or the stack was shortened.
 */

/**
 * One frame of a captured console stack.
 * @typedef {object} ConsoleStackFrame
 * @property {string} [function_name]
 * @property {string} [url]
 * @property {number} [line]
 * @property {number} [column]
 */

/**
 * Agent-facing console read result.
 * @typedef {object} ConsoleResult
 * @property {number} tab_id
 * @property {ConsoleEntry[]} entries
 * @property {number} next_since Cursor to pass as `since` on the next read.
 * @property {boolean} truncated Older entries were dropped or a field was shortened.
 */

/** @typedef {Omit<ConsoleEntry, 'sequence'>} ParsedConsoleEntry */

/** @typedef {'response' | 'failure'} NetworkEntryKind */

/**
 * One captured request outcome.
 * @typedef {object} NetworkEntry
 * @property {number} sequence Per-tab monotonic order, also the read cursor.
 * @property {NetworkEntryKind} kind
 * @property {string} [method]
 * @property {string} [url]
 * @property {number} [status]
 * @property {string} [status_text]
 * @property {string} [mime_type]
 * @property {string} [resource_type]
 * @property {string} [error_text] Present on failures.
 * @property {number} [timestamp]
 * @property {boolean} truncated
 */

/**
 * Agent-facing network read result.
 * @typedef {object} NetworkResult
 * @property {number} tab_id
 * @property {NetworkEntry[]} entries
 * @property {number} next_since Cursor to pass as `since` on the next read.
 * @property {boolean} truncated
 */

/**
 * Bounded request metadata remembered from `Network.requestWillBeSent`.
 * @typedef {object} NetworkRequestMeta
 * @property {string} url
 * @property {string} [method]
 * @property {string} [resourceType]
 * @property {boolean} truncated
 */
/** @typedef {Omit<NetworkEntry, 'sequence'>} ParsedNetworkEntry */
/**
 * One node of `Page.getFrameTree`.
 * @typedef {object} CdpFrameTreeNode
 * @property {CdpFrame} frame
 * @property {CdpFrameTreeNode[]} [childFrames]
 */
/**
 * Frame identity and location as reported by the protocol.
 * @typedef {object} CdpFrame
 * @property {string} id
 * @property {string} [parentId] Absent on the root frame.
 * @property {string} [url]
 * @property {string} [loaderId]
 */
/**
 * A frame tree read from one target.
 * @typedef {object} CdpFrameTreeSource
 * @property {CdpTarget} target Target that owns the subtree.
 * @property {CdpFrameTreeNode} tree
 */
/**
 * Frame entry inside a graph; `target` is the target its commands must use.
 * @typedef {object} CdpFrameRecord
 * @property {string} frameId
 * @property {string} [parentFrameId]
 * @property {string} [url]
 * @property {CdpTarget} target
 * @property {number} [ownerBackendNodeId]
 */
/**
 * Flattened frame graph returned by `getFrameGraph`.
 * @typedef {object} CdpFrameGraph
 * @property {string} rootFrameId
 * @property {CdpFrameRecord[]} frames
 * @property {Array<{ frameId: string, target: CdpTarget }>} [unavailableFrames] Subtrees whose renderer did not answer.
 */
/**
 * Per-tab frame discovery cache.
 * @typedef {object} FrameDiscoveryState
 * @property {string} [rootFrameId] Root learned from tree reads and navigation events.
 * @property {Set<string>} sessions Flattened child sessions currently attached.
 * @property {Set<Promise<void>>} pending In-flight child initialization tasks.
 * @property {number} generation Bumped whenever session membership changes.
 * @property {Map<string, Promise<void>>} enabled Auto-attach promise per target key.
 * @property {Map<string, string>} frameIds Child session to frame identity.
 */
/**
 * Opaque identity of one acquisition of a tab, compared by reference.
 * @typedef {object} SessionClaim
 * @property {string} sessionId
 * @property {number} tabId
 */
/**
 * Optional precondition for `releaseSessionTab`: release only while the claim
 * still matches, so a newer acquisition survives the cleanup.
 * @typedef {object} ReleaseSessionGuard
 * @property {SessionClaim} ifClaim
 */
/** Lifecycle core of the CDP-backed BrowserDriver. Observation domains are added separately. */
export class ChromiumCdp {
  /**
   * @param {CdpDebuggerApi} [api] Debugger surface; defaults to the extension global.
   * @param {ChromiumCdpOptions} [options] Observation and control hooks.
   */
  constructor(api = chromeDebuggerApi, options = {}) {
    this.api = api;
    this.options = options;
    this.syncGeneration = 0;
    this.readGate = new CdpReadGate();
    this.attachedTabs = new Set();
    this.attachmentVersions = new Map();
    this.attachmentIds = new Map();
    this.attachInFlight = new Map();
    this.detachInFlight = new Map();
    this.handlers = new Set();
    this.tabOwners = new Map();
    this.claimAttempts = new Map();
    this.consoleBuffers = new Map();
    this.consoleSequences = new Map();
    this.consoleDomainsEnabledTabs = new Map();
    this.networkBuffers = new Map();
    this.networkSequences = new Map();
    this.networkDomainsEnabledTabs = new Set();
    this.networkRequestMeta = new Map();
    this.pendingDialogEntries = new Map();
    this.dialogBuffers = new Map();
    this.dialogSequences = new Map();
    this.dialogGenerations = new Map();
    this.dialogListeners = new Set();
    this.frameDiscovery = new Map();
    this.detachSubscription = null;
    this.dialogSubscription = null;
    this.consoleSubscription = null;
    this.networkSubscription = null;
    this.frameTargetSubscription = null;
    this.backgroundExecution = new BackgroundExecution(
      (tabId) => this.attachmentIds.get(tabId),
      (tabId, enabled) => this.api.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled }),
    );
    // One listener per observation domain instead of one unified dispatcher.
    this.bindAutoDetach();
    this.bindDialogHandler();
    this.bindConsoleHandler();
    this.bindNetworkHandler();
    this.bindFrameTargetHandler();
  }
  /**
   * Track debugger releases; the browser detaches on tab close or eviction.
   * @returns {void}
   */
  bindAutoDetach() {
    if (this.detachSubscription) return;
    const listener = (source, reason) => {
      const tabId = source.tabId;
      if (typeof tabId !== 'number') return;
      this.options.onDocumentChanged?.(tabId);
      this.attachedTabs.delete(tabId);
      this.attachmentIds.delete(tabId);
      this.attachmentVersions.set(tabId, (this.attachmentVersions.get(tabId) ?? 0) + 1);
      this.backgroundExecution.invalidate(tabId);
      if (reason === 'target_closed') {
        this.claimAttempts.delete(tabId);
        this.tabOwners.delete(tabId);
        this.backgroundExecution.forget(tabId);
      }
      this.clearDialogState(tabId);
      this.clearConsoleState(tabId);
      this.clearNetworkState(tabId);
      this.clearFrameState(tabId);
      this.options.onDetach?.(tabId, reason);
    };
    this.api.onDetach.addListener(listener);
    this.detachSubscription = { dispose: () => this.api.onDetach.removeListener(listener) };
  }
  /**
   * Track root-document and flattened child-session events.
   * @returns {void}
   */
  bindFrameTargetHandler() {
    if (this.frameTargetSubscription) return;
    const listener = (source, method, params) => this.onFrameTargetEvent(source, method, params);
    this.api.onEvent.addListener(listener);
    this.frameTargetSubscription = { dispose: () => this.api.onEvent.removeListener(listener) };
  }
  /**
   * Identity of this actual debugger attachment, independent of frame topology.
   * @param {number} tabId
   * @returns {string | undefined}
   */
  getAttachmentId(tabId) { return this.attachmentIds.get(tabId); }
  /**
   * True once `ensureAttached` succeeded and before the next detach.
   * @param {number} tabId
   * @returns {boolean}
   */
  isAttached(tabId) { return this.attachedTabs.has(tabId); }
  /**
   * Attach to `tabId` if this driver has not already, then reconcile the
   * focus/visibility override with the sessions that still own the tab.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async ensureAttached(tabId) {
    await this.ensureRawAttached(tabId);
    await this.backgroundExecution.synchronize(tabId);
  }
  /**
   * Attach without touching background execution. Concurrent callers share
   * one in-flight attach; a release during setup fences it and rolls the
   * native attachment back.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async ensureRawAttached(tabId) {
    const detaching = this.detachInFlight.get(tabId);
    if (detaching) await detaching;
    if (this.attachedTabs.has(tabId)) return;
    const existing = this.attachInFlight.get(tabId);
    if (existing) {
      await existing;
      return;
    }
    const version = this.attachmentVersions.get(tabId) ?? 0;
    const check = () => {
      if ((this.attachmentVersions.get(tabId) ?? 0) !== version) throw new Error('Debugger attachment was released during setup');
    };
    const attach = (async () => {
      await this.api.attach({ tabId }, CDP_PROTOCOL_VERSION);
      try {
        check();
        await this.enablePageDomain(tabId);
        check();
        await this.enableNetworkDomainBestEffort(tabId);
        check();
        this.attachedTabs.add(tabId);
        this.attachmentIds.set(tabId, crypto.randomUUID());
        await this.enableFrameDiscovery({ tabId }).catch((err) => {
          console.debug('[bb cdp] frame discovery unavailable', { tabId, err });
        });
        check();
      } catch (error) {
        // A domain enable failed after the raw attach succeeded (for example
        // Page.enable rejects for a privileged page). `attachedTabs` does not
        // hold the tab yet, so without rolling back the debugger would stay
        // attached and every later attempt would fail with "Another debugger
        // is already attached". Detach directly so the next attempt starts
        // from a clean slate.
        if ((this.attachmentVersions.get(tabId) ?? 0) !== version) {
          this.attachedTabs.delete(tabId);
          this.attachmentIds.delete(tabId);
          this.backgroundExecution.invalidate(tabId);
        }
        await this.api.detach({ tabId }).catch((detachErr) => {
          console.debug('[bb cdp] rollback detach failed', { tabId, detachErr });
        });
        throw error;
      }
    })().catch((error) => { throw normalizeError(error); })
      .finally(() => { if (this.attachInFlight.get(tabId) === attach) this.attachInFlight.delete(tabId); });
    this.attachInFlight.set(tabId, attach);
    await attach;
  }
  /**
   * Enable page lifecycle events so navigation and dialog events arrive.
   * @param {number} tabId
   * @returns {Promise<unknown>}
   */
  enablePageDomain(tabId) {
    return this.command({ tabId }, 'Page.enable', {});
  }
  /**
   * Enable network capture where the page allows it; a refusal is logged and
   * never blocks the attach.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async enableNetworkDomainBestEffort(tabId) {
    try {
      await this.enableNetworkDomain(tabId);
    } catch (err) {
      console.debug('[bb cdp] network domain enable failed', { tabId, err });
    }
  }
  /**
   * Send a CDP command and decode the result as the caller's type. Attaches
   * the tab first; throws on any debugger error, normalized to an `Error`.
   * @template T
   * @param {number} tabId
   * @param {string} method Protocol method name.
   * @param {object} [params] Protocol payload.
   * @param {AbortSignal} [signal] Checked before and after attaching.
   * @returns {Promise<T>}
   */
  async send(tabId, method, params, signal) {
    signal?.throwIfAborted();
    await this.ensureAttached(tabId);
    signal?.throwIfAborted();
    try {
      return await this.command({ tabId }, method, params ?? {});
    } catch (error) {
      throw normalizeError(error);
    }
  }
  /**
   * Low-level command path shared by every read. Applies the read gate, learns
   * the root frame from `Page.getFrameTree`, and never reconnects on its own.
   * @param {CdpDebuggee} target
   * @param {string} method
   * @param {object} params
   * @param {number} [readTimeoutMs] Deadline for renderer-backed reads.
   * @param {() => void} [beforeDispatch] Guard run immediately before native send.
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>}
   */
  async command(target, method, params, readTimeoutMs, beforeDispatch, signal) {
    const { tabId } = target;
    // Page.enable does not replay navigation for an already loaded tab. Learn
    // its root from every tree-read path, including guarded passive reads.
    const rootState = method === 'Page.getFrameTree' && !target.sessionId && typeof tabId === 'number'
      ? this.frameDiscoveryState(tabId)
      : undefined;
    const rootBefore = rootState?.rootFrameId;
    const version = typeof tabId === 'number' ? (this.attachmentVersions.get(tabId) ?? 0) : 0;
    const result = await this.readGate.run(target, method, () => {
      beforeDispatch?.();
      return this.api.sendCommand(target, method, params);
    }, readTimeoutMs, signal);
    // A delayed reply must not overwrite a newer attachment or root event.
    if (rootState
      && typeof tabId === 'number'
      && this.frameDiscovery.get(tabId) === rootState
      && (this.attachmentVersions.get(tabId) ?? 0) === version
      && rootState.rootFrameId === rootBefore) {
      const frame = result?.frameTree?.frame;
      if (typeof frame?.id === 'string' && frame.id && !frame.parentId) rootState.rootFrameId = frame.id;
    }
    return result;
  }
  /**
   * Send a command to one frame-discovery target after attaching its tab.
   * @template T
   * @param {CdpTarget} target
   * @param {string} method
   * @param {object} [params]
   * @param {number} [readTimeoutMs]
   * @returns {Promise<T>}
   */
  async sendToTarget(target, method, params = {}, readTimeoutMs) {
    await this.ensureAttached(target.tabId);
    try {
      return await this.command(target, method, params, readTimeoutMs);
    } catch (error) {
      throw normalizeError(error);
    }
  }
  /**
   * Send only while `guard` still describes the live attachment. The guard
   * runs after any asynchronous attach and immediately before native send, so
   * a cancelled or stale command never reaches the browser.
   * @template T
   * @param {CdpTarget} target
   * @param {string} method
   * @param {object} [params]
   * @param {CdpDispatchGuard} guard
   * @returns {Promise<T>}
   */
  async sendGuarded(target, method, params, guard) {
    guard.signal?.throwIfAborted();
    if (guard.attachmentId === undefined) await this.ensureAttached(target.tabId);
    try {
      return await this.command(target, method, params ?? {}, undefined, () => {
        guard.signal?.throwIfAborted();
        if (guard.attachmentId !== undefined && this.getAttachmentId(target.tabId) !== guard.attachmentId) {
          throw new Error('Debugger attachment changed before dispatch');
        }
        guard.onDispatch?.();
      }, guard.signal);
    } catch (error) {
      throw normalizeError(error);
    }
  }
  /**
   * Detach if attached; never throws.
   * @param {number} tabId
   * @param {string} [expectedAttachmentId] Skip when the live attachment no longer matches.
   * @returns {Promise<void>}
   */
  async detach(tabId, expectedAttachmentId) {
    if (expectedAttachmentId !== undefined && this.getAttachmentId(tabId) !== expectedAttachmentId) return;
    this.attachmentVersions.set(tabId, (this.attachmentVersions.get(tabId) ?? 0) + 1);
    const existing = this.detachInFlight.get(tabId);
    if (existing) {
      await cleanupWait(existing);
      return;
    }
    // Leave pending raw attachments fenced until they settle. Their version
    // check rolls them back before another acquisition may attach to this tab.
    if (!this.attachedTabs.has(tabId)) return;
    this.attachedTabs.delete(tabId);
    this.attachmentIds.delete(tabId);
    this.options.onDocumentChanged?.(tabId);
    this.backgroundExecution.invalidate(tabId);
    this.clearDialogState(tabId);
    this.clearConsoleState(tabId);
    this.clearNetworkState(tabId);
    this.clearFrameState(tabId);
    const pending = (async () => {
      try {
        await this.api.detach({ tabId });
      } catch (err) {
        // The tab may already be gone: the browser detaches on close.
        console.debug('[bb cdp] detach failed (tab likely already closed)', err);
      }
    })().finally(() => this.detachInFlight.delete(tabId));
    this.detachInFlight.set(tabId, pending);
    await cleanupWait(pending);
  }
  /**
   * Best-effort detach of every cached tab. Used when a session stops.
   * @returns {Promise<void>}
   */
  async detachAll() {
    const tabs = [...this.attachedTabs];
    for (const tabId of new Set([...tabs, ...this.attachInFlight.keys()])) {
      this.attachmentVersions.set(tabId, (this.attachmentVersions.get(tabId) ?? 0) + 1);
    }
    this.claimAttempts.clear();
    this.tabOwners.clear();
    this.backgroundExecution.clear();
    this.attachedTabs.clear();
    this.attachmentIds.clear();
    for (const tabId of tabs) this.options.onDocumentChanged?.(tabId);
    for (const tabId of this.pendingDialogEntries.keys()) this.clearDialogState(tabId);
    this.dialogBuffers.clear();
    this.dialogSequences.clear();
    this.consoleBuffers.clear();
    this.consoleSequences.clear();
    this.consoleDomainsEnabledTabs.clear();
    this.networkBuffers.clear();
    this.networkSequences.clear();
    this.networkDomainsEnabledTabs.clear();
    this.networkRequestMeta.clear();
    this.frameDiscovery.clear();
    this.readGate.clear();
    await Promise.all(tabs.map(async (tabId) => {
      try { await this.api.detach({ tabId }); } catch { /* tab already gone */ }
    }));
  }
  /**
   * Subscribe to every CDP event seen by this driver. The handler is a
   * listener on the debugger surface itself, so domain listeners cannot
   * deliver the same event to it more than once.
   * @param {(source: CdpDebuggee, method: string, params: object) => void} handler
   * @returns {{ dispose: () => void }}
   */
  onEvent(handler) {
    this.handlers.add(handler);
    this.api.onEvent.addListener(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
        this.api.onEvent.removeListener(handler);
      },
    };
  }
  /**
   * Take the persistent focus/visibility override for this session. Only
   * explicit automation control may retain it; a release during setup rolls
   * back the claim.
   * @param {string} sessionId
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async acquireBackgroundExecution(sessionId, tabId) {
    const attempts = this.claimAttempts.get(tabId) ?? new Map();
    const attempt = {};
    attempts.set(sessionId, attempt);
    this.claimAttempts.set(tabId, attempts);
    const retained = this.backgroundExecution.has(sessionId, tabId);
    this.trackSessionTab(sessionId, tabId);
    this.backgroundExecution.retain(sessionId, tabId);
    try {
      await this.ensureAttached(tabId);
      if (!this.backgroundExecution.has(sessionId, tabId)) throw new Error('Background execution was released during setup');
    } catch (error) {
      if (!retained && this.claimAttempts.get(tabId)?.get(sessionId) === attempt) {
        this.claimAttempts.get(tabId)?.delete(sessionId);
        this.backgroundExecution.release(sessionId, tabId);
        await cleanupWait(this.backgroundExecution.synchronize(tabId)).catch(() => {});
      }
      throw error;
    }
  }
  /**
   * True when this session owns the persistent focus/visibility override for the tab.
   * @param {string} sessionId
   * @param {number} tabId
   * @returns {boolean}
   */
  ownsBackgroundExecution(sessionId, tabId) {
    return this.backgroundExecution.has(sessionId, tabId);
  }
  /**
   * Shared tabs retain debugger ownership but relinquish persistent focus emulation.
   * @param {string} sessionId
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async releaseBackgroundExecution(sessionId, tabId) {
    this.backgroundExecution.release(sessionId, tabId);
    await this.backgroundExecution.synchronize(tabId);
  }
  /**
   * Resend this session's override when the browser lost it without clearing
   * the applied-state cache.
   * @param {string} sessionId
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async restoreBackgroundExecution(sessionId, tabId) {
    if (!this.backgroundExecution.has(sessionId, tabId)) throw new Error('Background execution is not owned by this session');
    await this.ensureRawAttached(tabId);
    await this.backgroundExecution.reapply(tabId);
    if (!this.backgroundExecution.has(sessionId, tabId)) throw new Error('Background execution was released during restore');
  }
  /** Remove internal debugger listeners and drop buffered observation state. */
  dispose() {
    for (const handler of this.handlers) this.api.onEvent.removeListener(handler);
    this.handlers.clear();
    this.detachSubscription?.dispose();
    this.detachSubscription = null;
    this.dialogSubscription?.dispose();
    this.dialogSubscription = null;
    this.consoleSubscription?.dispose();
    this.consoleSubscription = null;
    this.networkSubscription?.dispose();
    this.networkSubscription = null;
    this.frameTargetSubscription?.dispose();
    this.frameTargetSubscription = null;
    for (const tabId of this.pendingDialogEntries.keys()) this.clearDialogState(tabId);
    this.dialogListeners.clear();
    this.consoleBuffers.clear();
    this.consoleSequences.clear();
    this.consoleDomainsEnabledTabs.clear();
    this.networkBuffers.clear();
    this.networkSequences.clear();
    this.networkDomainsEnabledTabs.clear();
    this.networkRequestMeta.clear();
    this.frameDiscovery.clear();
    this.readGate.clear();
  }
}

// 类方法不可枚举，不能直接用 Object.assign；逐个复制描述符。
function applyMixin(target, source) {
  for (const name of Object.getOwnPropertyNames(source)) {
    if (name === 'constructor') continue;
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name));
  }
}
applyMixin(ChromiumCdp.prototype, CdpFrameMethods.prototype);
applyMixin(ChromiumCdp.prototype, CdpDialogMethods.prototype);
applyMixin(ChromiumCdp.prototype, CdpConsoleMethods.prototype);
applyMixin(ChromiumCdp.prototype, CdpNetworkMethods.prototype);
applyMixin(ChromiumCdp.prototype, CdpEmulationMethods.prototype);
applyMixin(ChromiumCdp.prototype, CdpSessionMethods.prototype);

/**
 * Normalize anything a debugger call can throw into an `Error`.
 * @param {unknown} error
 * @returns {Error}
 */
function normalizeError(error) {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  if (error && typeof error === 'object' && 'message' in error) return new Error(String(error.message));
  return new Error('unknown chrome.debugger error');
}