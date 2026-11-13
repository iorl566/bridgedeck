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
import { parseConsoleApiCalled, parseExceptionThrown, parseLogEntry } from './console-parsers.js';
export { parseConsoleApiCalled, parseExceptionThrown, parseLogEntry };
import { parseDialogOpeningParams, truncateDialogField } from './dialog-parser.js';
import { buildFrameGraph, omitFrameSubtrees } from './frame-graph.js';

export const CDP_PROTOCOL_VERSION = '1.3';

const FRAME_DISCOVERY_TIMEOUT_MS = 1_000;
const FRAME_DISCOVERY_QUIET_MS = 20;
const MAX_DIALOG_BUFFER = 32;
const MAX_CONSOLE_BUFFER = 200;
const MAX_NETWORK_BUFFER = 200;
const MAX_NETWORK_FIELD_LENGTH = 4096;
const MAX_NETWORK_REQUEST_META = 1024;
const DIALOG_DECISION_TIMEOUT_MS = 60_000;
const DIALOG_CLOSE_CONFIRM_MS = 2_000;
const CLEANUP_WAIT_MS = 1_000;

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
   * Track native dialog opening/closing for a tab.
   * @returns {void}
   */
  bindDialogHandler() {
    if (this.dialogSubscription) return;
    const listener = (source, method, params) => {
      const tabId = source.tabId;
      if (typeof tabId !== 'number') return;
      if (method === 'Page.javascriptDialogOpening') this.onDialogOpened(source, params);
      else if (method === 'Page.javascriptDialogClosed') this.onDialogClosed(tabId, params);
    };
    this.api.onEvent.addListener(listener);
    this.dialogSubscription = { dispose: () => this.api.onEvent.removeListener(listener) };
  }
  /**
   * Track console, exception and log entries for a tab.
   * @returns {void}
   */
  bindConsoleHandler() {
    if (this.consoleSubscription) return;
    const listener = (source, method, params) => {
      const tabId = source.tabId;
      if (typeof tabId !== 'number') return;
      switch (method) {
        case 'Runtime.consoleAPICalled':
          this.appendConsole(tabId, parseConsoleApiCalled(params));
          break;
        case 'Runtime.exceptionThrown':
          this.appendConsole(tabId, parseExceptionThrown(params));
          break;
        case 'Log.entryAdded':
          this.appendConsole(tabId, parseLogEntry(params));
          break;
      }
    };
    this.api.onEvent.addListener(listener);
    this.consoleSubscription = { dispose: () => this.api.onEvent.removeListener(listener) };
  }
  /**
   * Track the network request lifecycle for a tab.
   * @returns {void}
   */
  bindNetworkHandler() {
    if (this.networkSubscription) return;
    const listener = (source, method, params) => {
      const tabId = source.tabId;
      if (typeof tabId !== 'number') return;
      switch (method) {
        case 'Network.requestWillBeSent':
          this.rememberNetworkRequest(tabId, params);
          break;
        case 'Network.responseReceived':
          this.appendNetwork(tabId, parseNetworkResponse(this.getNetworkRequest(tabId, params), params));
          break;
        case 'Network.loadingFailed':
          this.appendNetwork(tabId, parseNetworkFailure(this.getNetworkRequest(tabId, params, true), params));
          break;
        case 'Network.loadingFinished':
          this.getNetworkRequest(tabId, params, true);
          break;
      }
    };
    this.api.onEvent.addListener(listener);
    this.networkSubscription = { dispose: () => this.api.onEvent.removeListener(listener) };
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
   * Enable console capture for this tab on first use. Attach leaves the
   * runtime domain off: while it is on, every console call builds argument
   * previews, which anti-debugging pages time to detect a debugger.
   * @param {number} tabId
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async ensureConsoleCapture(tabId, signal) {
    signal?.throwIfAborted();
    if (!this.attachedTabs.has(tabId)) await this.ensureAttached(tabId);
    signal?.throwIfAborted();
    await this.enableConsoleDomains(tabId, signal);
  }
  /**
   * Enable the runtime and log domains on the current attachment. The runtime
   * domain is required, the log domain stays best effort, and the tab is
   * marked enabled only when both settle on the same attachment.
   * @param {number} tabId
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async enableConsoleDomains(tabId, signal) {
    const attachmentId = this.getAttachmentId(tabId);
    if (attachmentId === undefined) throw new Error('debugger detached');
    const check = () => {
      signal?.throwIfAborted();
      if (this.getAttachmentId(tabId) !== attachmentId) throw new Error('Debugger attachment changed during console capture');
    };
    check();
    if (this.consoleDomainsEnabledTabs.get(tabId) === attachmentId) return;
    // The runtime domain carries page console calls and exceptions, so its
    // failure is the caller's error. The log domain only adds
    // browser-generated entries and stays best effort. Any failure leaves the
    // tab unmarked so the next read retries.
    await this.command({ tabId }, 'Runtime.enable', {}, READ_TIMEOUT_MS, check, signal);
    check();
    let logEnabled = true;
    try {
      await this.command({ tabId }, 'Log.enable', {}, READ_TIMEOUT_MS, check, signal);
    } catch (err) {
      check();
      if (err instanceof CdpReadTimeoutError) throw err;
      logEnabled = false;
      console.debug('[bb cdp] console domain enable failed', { tabId, method: 'Log.enable', err });
    }
    check();
    // Enabling the runtime domain replays stored console messages as events,
    // which are not ordered with its command reply. One more renderer round
    // trip lets them reach the buffer before the first read.
    await this.command(
      { tabId },
      'Runtime.evaluate',
      { expression: '0', returnByValue: true, silent: true },
      READ_TIMEOUT_MS,
      check,
      signal,
    );
    check();
    if (logEnabled) this.consoleDomainsEnabledTabs.set(tabId, attachmentId);
  }
  /**
   * Console entries observed on `tabId`, bounded for agent context safety.
   * @param {number} tabId
   * @param {number} [since] Cursor from the previous read; omit for the newest entries.
   * @param {number} limit Maximum entries to return.
   * @param {number} maxTextChars Budget for each text field.
   * @param {boolean} includeStack Include the captured stack trace when present.
   * @returns {ConsoleResult}
   */
  consoleEntriesSince(tabId, since, limit, maxTextChars, includeStack) {
    const buffer = this.consoleBuffers.get(tabId) ?? [];
    const { entries, nextSince, truncated } = readBufferedEntries(buffer, this.consoleSequences.get(tabId) ?? 0, since, limit, (entry) => projectConsoleEntry(entry, maxTextChars, includeStack));
    return { tab_id: tabId, entries, next_since: nextSince, truncated };
  }
  /**
   * Append one parsed event to the bounded per-tab console buffer.
   * @param {number} tabId
   * @param {ParsedConsoleEntry | null} entry Ignored when null.
   */
  appendConsole(tabId, entry) {
    if (!entry) return;
    const sequence = (this.consoleSequences.get(tabId) ?? 0) + 1;
    this.consoleSequences.set(tabId, sequence);
    appendBounded(this.consoleBuffers, tabId, { ...entry, sequence }, MAX_CONSOLE_BUFFER);
  }
  /**
   * Drop buffered console entries and the enabled-domain mark for a tab.
   * @param {number} tabId
   */
  clearConsoleState(tabId) {
    this.consoleBuffers.delete(tabId);
    this.consoleSequences.delete(tabId);
    this.consoleDomainsEnabledTabs.delete(tabId);
  }
  /**
   * Ensure the network capture domains are enabled for this tab.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async ensureNetworkCapture(tabId) {
    if (!this.attachedTabs.has(tabId)) await this.ensureAttached(tabId);
    await this.enableNetworkDomain(tabId);
  }
  /**
   * Enable network events once per tab on the current attachment.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async enableNetworkDomain(tabId) {
    if (this.networkDomainsEnabledTabs.has(tabId)) return;
    await this.command({ tabId }, 'Network.enable', {});
    this.networkDomainsEnabledTabs.add(tabId);
  }
  /**
   * Network entries observed on `tabId`, bounded for agent context safety.
   * @param {number} tabId
   * @param {number} [since] Cursor from the previous read; omit for the newest entries.
   * @param {number} limit Maximum entries to return.
   * @param {number} maxTextChars Budget for each text field.
   * @returns {NetworkResult}
   */
  networkEntriesSince(tabId, since, limit, maxTextChars) {
    const buffer = this.networkBuffers.get(tabId) ?? [];
    const { entries, nextSince, truncated } = readBufferedEntries(buffer, this.networkSequences.get(tabId) ?? 0, since, limit, (entry) => projectNetworkEntry(entry, maxTextChars));
    return { tab_id: tabId, entries, next_since: nextSince, truncated };
  }
  /**
   * Append one parsed outcome to the bounded per-tab network buffer.
   * @param {number} tabId
   * @param {ParsedNetworkEntry | null} entry Ignored when null.
   */
  appendNetwork(tabId, entry) {
    if (!entry) return;
    const sequence = (this.networkSequences.get(tabId) ?? 0) + 1;
    this.networkSequences.set(tabId, sequence);
    appendBounded(this.networkBuffers, tabId, { ...entry, sequence }, MAX_NETWORK_BUFFER);
  }
  /**
   * Remember request metadata so responses and failures can be attributed.
   * @param {number} tabId
   * @param {object} params Raw `Network.requestWillBeSent` payload.
   */
  rememberNetworkRequest(tabId, params) {
    const raw = params ?? {};
    const id = typeof raw.requestId === 'string' ? raw.requestId : undefined;
    const request = raw.request ?? {};
    if (!id || typeof request.url !== 'string') return;
    const url = truncateText(request.url, MAX_NETWORK_FIELD_LENGTH);
    const method = truncateOptional(request.method, MAX_NETWORK_FIELD_LENGTH);
    const resourceType = truncateOptional(raw.type, MAX_NETWORK_FIELD_LENGTH);
    const meta = this.networkRequestMeta.get(tabId) ?? new Map();
    meta.delete(id);
    meta.set(id, { url: url.text, method: method?.text, resourceType: resourceType?.text, truncated: url.truncated || (method?.truncated ?? false) || (resourceType?.truncated ?? false) });
    while (meta.size > MAX_NETWORK_REQUEST_META) {
      const oldest = meta.keys().next().value;
      if (oldest === undefined) break;
      meta.delete(oldest);
    }
    this.networkRequestMeta.set(tabId, meta);
  }
  /**
   * Keep metadata through response headers; consume it only when loading ends.
   * @param {number} tabId
   * @param {object} params Raw `Network.responseReceived` or `Network.loadingFailed` payload.
   * @param {boolean} [finished] Drop the entry once loading is over.
   * @returns {NetworkRequestMeta | undefined}
   */
  getNetworkRequest(tabId, params, finished = false) {
    const id = typeof (params ?? {}).requestId === 'string' ? params.requestId : undefined;
    if (!id) return undefined;
    const meta = this.networkRequestMeta.get(tabId);
    const info = meta?.get(id);
    if (finished) meta?.delete(id);
    if (meta?.size === 0) this.networkRequestMeta.delete(tabId);
    return info;
  }
  /**
   * Drop buffered network entries, request metadata and the enabled-domain
   * mark for a tab.
   * @param {number} tabId
   */
  clearNetworkState(tabId) {
    this.networkBuffers.delete(tabId);
    this.networkSequences.delete(tabId);
    this.networkDomainsEnabledTabs.delete(tabId);
    this.networkRequestMeta.delete(tabId);
  }
  /**
   * Return a cursor marking the current dialog sequence for `tabId`.
   * @param {number} tabId
   * @returns {DialogCursor}
   */
  dialogCursor(tabId) { return this.dialogSequences.get(tabId) ?? 0; }
  /**
   * Dialogs observed on `tabId` with sequence strictly greater than `cursor`.
   * @param {number} tabId
   * @param {DialogCursor} cursor
   * @returns {JavaScriptDialogInfo[]}
   */
  dialogsSince(tabId, cursor) { return (this.dialogBuffers.get(tabId) ?? []).filter((dialog) => dialog.sequence > cursor); }
  /**
   * Dialogs still waiting for a decision, optionally limited to one tab.
   * @param {number} [tabId]
   * @returns {PendingJavaScriptDialog[]}
   */
  pendingDialogs(tabId) {
    return [...this.pendingDialogEntries.values()]
      .filter((entry) => tabId === undefined || entry.dialog.tab_id === tabId)
      .map((entry) => ({ ...entry.dialog }));
  }
  /**
   * Subscribe to dialog state changes.
   * @param {DialogChangedListener} handler
   * @returns {{ dispose: () => void }}
   */
  onDialogChanged(handler) {
    this.dialogListeners.add(handler);
    return { dispose: () => this.dialogListeners.delete(handler) };
  }
  /**
   * Notify listeners; `dialog` is null when a pending dialog goes away.
   * @param {number} tabId
   * @param {PendingJavaScriptDialog | null} dialog
   * @param {'decision_timeout'} [reason]
   */
  emitDialogChanged(tabId, dialog, reason) {
    for (const handler of this.dialogListeners) handler(tabId, dialog, reason);
  }
  /**
   * A native modal blocks command processing until it is dismissed. The
   * opening event only records state when the tab is still agent controlled
   * on the same attachment; a refusal leaves the modal for the user.
   * @param {CdpDebuggee} source
   * @param {object} params Raw `Page.javascriptDialogOpening` payload.
   */
  onDialogOpened(source, params) {
    const tabId = source.tabId;
    if (typeof tabId !== 'number') return;
    const generation = (this.dialogGenerations.get(tabId) ?? 0) + 1;
    this.dialogGenerations.set(tabId, generation);
    void this.onJavaScriptDialogOpening(source, params, generation);
  }
  /**
   * Record a freshly opened dialog for this attachment and generation. A
   * dialog that arrives after the attachment was released is ignored, and the
   * scope check may still refuse to retain it.
   * @param {CdpDebuggee} source
   * @param {object} params Raw `Page.javascriptDialogOpening` payload.
   * @param {number} generation Dialog generation at the time of the event.
   * @returns {Promise<void>}
   */
  async onJavaScriptDialogOpening(source, params, generation) {
    const tabId = source.tabId;
    if (typeof tabId !== 'number') return;
    const attachmentId = this.getAttachmentId(tabId);
    // A dialog that arrives after an attachment was released is stale: the tab
    // is no longer under agent control and its decision must not reconnect.
    // An event observed before any attachment is still recorded so a modal
    // that appeared early does not vanish from the transcript.
    if (!attachmentId && (this.attachmentVersions.get(tabId) ?? 0) > 0) return;
    const parsed = parseDialogOpeningParams(params);
    try {
      if (this.options.canControlDialog && !(await this.options.canControlDialog(tabId))) return;
      if (this.getAttachmentId(tabId) !== attachmentId || this.dialogGenerations.get(tabId) !== generation) return;
      const sequence = (this.dialogSequences.get(tabId) ?? 0) + 1;
      this.dialogSequences.set(tabId, sequence);
      const dialog = {
        id: crypto.randomUUID(),
        tab_id: tabId,
        type: parsed.type,
        message: parsed.message,
        url: parsed.url,
        default_prompt: parsed.defaultPrompt === undefined ? undefined : truncateDialogField(parsed.defaultPrompt),
        sequence,
        decision_deadline: Date.now() + DIALOG_DECISION_TIMEOUT_MS,
      };
      const timer = setTimeout(() => {
        // A bounded fallback rejects; never confirms on behalf of an absent agent.
        if (this.pendingDialogEntries.get(tabId)?.dialog.id !== dialog.id) return;
        this.emitDialogChanged(tabId, dialog, 'decision_timeout');
        void this.resolveDialog(dialog.id, false).catch(() => {});
      }, DIALOG_DECISION_TIMEOUT_MS);
      timer?.unref?.();
      this.pendingDialogEntries.set(tabId, {
        dialog,
        source,
        attachmentId,
        defaultPrompt: parsed.defaultPrompt,
        hasBrowserHandler: parsed.hasBrowserHandler,
        resolving: false,
        timer,
        closed: new Set(),
      });
      this.emitDialogChanged(tabId, dialog);
    } catch (error) {
      console.debug('[bb cdp] dialog state unavailable', error);
    }
  }
  /**
   * Record the browser's own closing event; it wins over a decision still in flight.
   * @param {number} tabId
   * @param {object} params Raw `Page.javascriptDialogClosed` payload.
   */
  onDialogClosed(tabId, params) {
    this.dialogGenerations.set(tabId, (this.dialogGenerations.get(tabId) ?? 0) + 1);
    const pending = this.pendingDialogEntries.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDialogEntries.delete(tabId);
    const { dialog } = pending;
    const info = {
      tab_id: tabId,
      type: dialog.type,
      message: dialog.message,
      url: dialog.url,
      default_prompt: dialog.default_prompt,
      has_browser_handler: pending.hasBrowserHandler,
      handled: params?.result ? 'accepted' : 'dismissed',
      sequence: dialog.sequence,
    };
    appendBounded(this.dialogBuffers, tabId, info, MAX_DIALOG_BUFFER);
    for (const close of pending.closed) close(info);
    pending.closed.clear();
    this.emitDialogChanged(tabId, null);
  }
  /**
   * Accept or dismiss one pending dialog and wait for the browser's own
   * closing event. The decision never reopens a released attachment, and a
   * timeout rejects instead of confirming on the agent's behalf.
   * @param {string} dialogId
   * @param {boolean} accept
   * @param {string} [promptText] Only valid when accepting a prompt.
   * @param {Pick<CdpDispatchGuard, 'signal' | 'onDispatch'>} [guard]
   * @returns {Promise<JavaScriptDialogInfo>}
   */
  async resolveDialog(dialogId, accept, promptText, guard = {}) {
    const entry = [...this.pendingDialogEntries.values()].find((item) => item.dialog.id === dialogId);
    if (!entry) throw new Error('Dialog is no longer pending');
    if (entry.resolving) throw new Error('Dialog decision is already in progress');
    if (promptText !== undefined && (!accept || entry.dialog.type !== 'prompt')) throw new Error('text is only valid when accepting a prompt');
    guard.signal?.throwIfAborted();
    if (this.options.canControlDialog && !(await this.options.canControlDialog(entry.dialog.tab_id))) throw new Error('Tab is no longer agent controlled');
    // Scope checks can await tab metadata; repeat identity checks at native dispatch.
    if (this.pendingDialogEntries.get(entry.dialog.tab_id) !== entry) throw new Error('Dialog is no longer pending');
    if (entry.resolving) throw new Error('Dialog decision is already in progress');
    entry.resolving = true;
    let timeout;
    let closeListener;
    const closed = new Promise((resolve, reject) => {
      closeListener = (result) => (result instanceof Error ? reject(result) : resolve(result));
      entry.closed.add(closeListener);
      timeout = setTimeout(() => reject(new Error('Browser did not confirm dialog closure')), DIALOG_CLOSE_CONFIRM_MS);
      timeout?.unref?.();
    });
    // Attach a rejection handler immediately, including when native dispatch fails first.
    void closed.catch(() => {});
    try {
      await this.sendGuarded(
        { ...entry.source, tabId: entry.dialog.tab_id },
        'Page.handleJavaScriptDialog',
        {
          accept,
          // Omitting the prompt text would submit an empty string, so keep the
          // full native default privately instead of reusing the bounded preview.
          ...(accept && entry.dialog.type === 'prompt' ? { promptText: promptText ?? entry.defaultPrompt ?? '' } : {}),
        },
        {
          signal: guard.signal,
          attachmentId: entry.attachmentId,
          onDispatch: () => {
            if (this.pendingDialogEntries.get(entry.dialog.tab_id) !== entry) throw new Error('Dialog changed before native dispatch');
            guard.onDispatch?.();
          },
        },
      );
      return await closed;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (closeListener) entry.closed.delete(closeListener);
      entry.resolving = false;
    }
  }
  /**
   * Forget a tab's pending dialog state, rejecting waiters because the native
   * outcome is now unknown.
   * @param {number} tabId
   */
  clearDialogState(tabId) {
    const pending = this.pendingDialogEntries.get(tabId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingDialogEntries.delete(tabId);
      for (const close of pending.closed) close(new Error('Debugger attachment changed; dialog outcome is unknown'));
      pending.closed.clear();
      this.emitDialogChanged(tabId, null);
    }
    this.dialogGenerations.set(tabId, (this.dialogGenerations.get(tabId) ?? 0) + 1);
    this.dialogBuffers.delete(tabId);
    this.dialogSequences.delete(tabId);
  }
  /**
   * `Emulation.setDeviceMetricsOverride` — pin the tab's viewport metrics.
   * @param {number} tabId
   * @param {DeviceMetricsOverride} metrics
   * @returns {Promise<void>}
   */
  setDeviceMetricsOverride(tabId, metrics) {
    return this.send(tabId, 'Emulation.setDeviceMetricsOverride', { ...metrics });
  }
  /**
   * `Emulation.clearDeviceMetricsOverride` — restore native viewport metrics.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  clearDeviceMetricsOverride(tabId) {
    return this.send(tabId, 'Emulation.clearDeviceMetricsOverride', {});
  }
  /**
   * `Emulation.setUserAgentOverride` — an empty `userAgent` restores the real one.
   * @param {number} tabId
   * @param {UserAgentOverride} override
   * @returns {Promise<void>}
   */
  setUserAgentOverride(tabId, override) {
    return this.send(tabId, 'Emulation.setUserAgentOverride', { ...override });
  }
  /**
   * `Emulation.setTouchEmulationEnabled`.
   * @param {number} tabId
   * @param {boolean} enabled
   * @param {number} [maxTouchPoints]
   * @returns {Promise<void>}
   */
  setTouchEmulationEnabled(tabId, enabled, maxTouchPoints) {
    return this.send(tabId, 'Emulation.setTouchEmulationEnabled', {
      enabled,
      ...(maxTouchPoints !== undefined ? { maxTouchPoints } : {}),
    });
  }
  /**
   * Return the per-tab frame discovery cache, creating it on first use.
   * @param {number} tabId
   * @returns {FrameDiscoveryState}
   */
  frameDiscoveryState(tabId) {
    let state = this.frameDiscovery.get(tabId);
    if (!state) {
      state = { sessions: new Set(), pending: new Set(), generation: 0, enabled: new Map(), frameIds: new Map() };
      this.frameDiscovery.set(tabId, state);
    }
    return state;
  }
  /**
   * Enable flattened target auto-attach for one target. The promise is shared
   * per target key so concurrent discovery does not resend the command, and a
   * failed attempt is forgotten so the next read retries.
   * @param {CdpTarget} target
   * @returns {Promise<void>}
   */
  enableFrameDiscovery(target) {
    const state = this.frameDiscoveryState(target.tabId);
    const key = target.sessionId ?? 'root';
    const existing = state.enabled.get(key);
    if (existing) return existing;
    let issued = false;
    const work = this.readGate.run(target, 'Target.setAutoAttach', () => {
      issued = true;
      return this.api.sendCommand(target, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'iframe', exclude: false }],
      }).then(() => {
        if (state.enabled.get(key) === work) state.enabled.set(key, Promise.resolve());
      }, (error) => {
        if (state.enabled.get(key) === work) state.enabled.delete(key);
        throw error;
      });
    }).then(() => {}).catch((error) => {
      if ((!issued || !(error instanceof CdpReadTimeoutError)) && state.enabled.get(key) === work) state.enabled.delete(key);
      throw error;
    });
    state.enabled.set(key, work);
    return work;
  }
  /**
   * Track root-document changes and flattened child sessions from CDP events.
   * A detached child session also releases its read gate.
   * @param {CdpDebuggee} source
   * @param {string} method
   * @param {object} params
   */
  onFrameTargetEvent(source, method, params) {
    const tabId = source.tabId;
    if (typeof tabId !== 'number') return;
    const raw = params ?? {};
    const frame = raw.frame;
    if (!source.sessionId && frame?.id && !frame.parentId && ['Page.frameNavigated', 'Page.documentOpened'].includes(method)) {
      this.frameDiscoveryState(tabId).rootFrameId = frame.id;
    }
    const rootRouteChanged = method === 'Page.navigatedWithinDocument'
      && raw.frameId === this.frameDiscovery.get(tabId)?.rootFrameId;
    if (!source.sessionId && (rootRouteChanged || method === 'DOM.documentUpdated'
      || (['Page.frameNavigated', 'Page.documentOpened'].includes(method) && frame && !frame.parentId))) {
      this.options.onDocumentChanged?.(tabId);
    }
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
    if (!sessionId) return;
    if (method === 'Target.detachedFromTarget') {
      const state = this.frameDiscovery.get(tabId);
      state?.enabled.delete(sessionId);
      state?.frameIds.delete(sessionId);
      this.readGate.reset(tabId, sessionId);
      if (state?.sessions.delete(sessionId)) state.generation += 1;
      return;
    }
    if (method !== 'Target.attachedToTarget') return;
    const targetInfo = raw.targetInfo;
    if (targetInfo?.type && targetInfo.type !== 'iframe') return;
    const state = this.frameDiscoveryState(tabId);
    if (targetInfo?.type === 'iframe' && typeof targetInfo.targetId === 'string') state.frameIds.set(sessionId, targetInfo.targetId);
    if (state.sessions.has(sessionId)) return;
    state.sessions.add(sessionId);
    state.generation += 1;
    const task = this.initializeFrameTarget({ tabId, sessionId });
    state.pending.add(task);
    void task.finally(() => { state.pending.delete(task); });
  }
  /**
   * Configure a freshly attached child session. A timed-out setup keeps both
   * the session and its pending configuration instead of resending or losing it.
   * @param {CdpTarget} target Child target with a session id.
   * @returns {Promise<void>}
   */
  async initializeFrameTarget(target) {
    try {
      await this.enableFrameDiscovery(target);
    } catch (error) {
      if (error instanceof CdpReadTimeoutError) {
        // The command is still in flight and the browser keeps the child
        // session attached. Keep both the session and the pending
        // configuration until it settles instead of resending or losing it.
        console.debug('[bb cdp] child frame discovery timed out', { target });
        return;
      }
      const state = this.frameDiscovery.get(target.tabId);
      if (state?.sessions.delete(target.sessionId)) state.generation += 1;
      console.debug('[bb cdp] child frame target initialization failed', { target, err: error });
    }
  }
  /**
   * Retry setup for child sessions that are still attached without a finished
   * auto-attach promise.
   * @param {number} tabId
   */
  retryChildFrameDiscovery(tabId) {
    const state = this.frameDiscovery.get(tabId);
    if (!state) return;
    for (const sessionId of state.sessions) {
      if (state.enabled.has(sessionId)) continue;
      const task = this.initializeFrameTarget({ tabId, sessionId });
      state.pending.add(task);
      void task.finally(() => { state.pending.delete(task); });
    }
  }
  /**
   * Wait for child frame setup to quiesce, never past the discovery deadline.
   * Attach events may follow their command reply, so a short quiet window is
   * required before the tree is considered stable.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async drainFrameAttachTasks(tabId) {
    const deadline = Date.now() + FRAME_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = this.frameDiscovery.get(tabId);
      const generation = state?.generation ?? 0;
      if (state?.pending.size && !(await settleBeforeDeadline([...state.pending], deadline))) break;
      // Target auto-attach may enqueue the next attached event after its
      // command promise settles. Wait for a short quiet window, then finish
      // only if neither the state object nor its generation changed.
      const quietTime = Math.min(FRAME_DISCOVERY_QUIET_MS, deadline - Date.now());
      if (quietTime <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, quietTime));
      const current = this.frameDiscovery.get(tabId);
      if (current === state && (current?.generation ?? 0) === generation && !current?.pending.size) return;
    }
    console.debug('[bb cdp] frame discovery did not reach quiescence before timeout', { tabId });
  }
  /**
   * Drop everything frame discovery and read gating keep for a tab.
   * @param {number} tabId
   */
  clearFrameState(tabId) {
    this.frameDiscovery.delete(tabId);
    this.readGate.reset(tabId);
  }
  /**
   * Flatten the tab's frame topology, attaching child targets first. Subtrees
   * whose renderer does not answer are reported as unavailable instead of
   * guessed, and the whole read fails if the attachment changes underneath it.
   * @param {number} tabId
   * @param {AbortSignal} [signal]
   * @returns {Promise<CdpFrameGraph>}
   */
  async getFrameGraph(tabId, signal) {
    signal?.throwIfAborted();
    await this.ensureAttached(tabId);
    const attachmentId = this.getAttachmentId(tabId);
    const check = () => {
      signal?.throwIfAborted();
      if (attachmentId === undefined || this.getAttachmentId(tabId) !== attachmentId) {
        const error = new Error('Debugger attachment changed during frame discovery');
        error.name = 'CdpAttachmentChangedError';
        throw error;
      }
    };
    const read = async (target, method, params, timeoutMs) => {
      check();
      try {
        const result = await this.command(target, method, params, timeoutMs, check);
        check();
        return result;
      } catch (error) {
        check();
        throw error;
      }
    };
    check();
    await this.enableFrameDiscovery({ tabId }).catch((error) => { if (error instanceof CdpReadTimeoutError) throw error; });
    check();
    this.retryChildFrameDiscovery(tabId);
    await this.drainFrameAttachTasks(tabId);
    check();
    const sources = [];
    const unavailable = new Map();
    const isolateChildTimeout = (error, target) => {
      check();
      if (!(error instanceof CdpReadTimeoutError)) return;
      const frameId = target.sessionId && this.frameDiscovery.get(tabId)?.frameIds.get(target.sessionId);
      if (!frameId || frameId === sources[0]?.tree.frame.id || error.sessionId !== target.sessionId) throw error;
      unavailable.set(frameId, target);
    };
    const root = await read({ tabId }, 'Page.getFrameTree', {}, READ_TIMEOUT_MS);
    if (root.frameTree) sources.push({ target: { tabId }, tree: root.frameTree });
    const sessions = [...(this.frameDiscovery.get(tabId)?.sessions ?? [])];
    const childTrees = await Promise.all(sessions.map(async (sessionId) => {
      const target = { tabId, sessionId };
      try {
        const reply = await read(target, 'Page.getFrameTree', {}, READ_TIMEOUT_MS);
        if (reply.frameTree) this.frameDiscovery.get(tabId)?.frameIds.set(sessionId, reply.frameTree.frame.id);
        return reply.frameTree ? { target, tree: reply.frameTree } : null;
      } catch (error) {
        isolateChildTimeout(error, target);
        return null;
      }
    }));
    for (const source of childTrees) if (source) sources.push(source);
    const discovered = buildFrameGraph(sources);
    if (!discovered) throw new Error('Page.getFrameTree returned no root frame');
    const graph = omitFrameSubtrees(discovered, unavailable);
    const frameById = new Map(graph.frames.map((frame) => [frame.frameId, frame]));
    await Promise.all(graph.frames.map(async (frame) => {
      if (!frame.parentFrameId) return;
      const parent = frameById.get(frame.parentFrameId);
      if (!parent) return;
      try {
        const owner = await read(parent.target, 'DOM.getFrameOwner', { frameId: frame.frameId });
        if (owner.backendNodeId !== undefined) frame.ownerBackendNodeId = owner.backendNodeId;
      } catch (error) {
        isolateChildTimeout(error, parent.target);
      }
    }));
    check();
    return omitFrameSubtrees(discovered, unavailable);
  }
  /**
   * Remember that `sessionId` used CDP on `tabId` so stop can detach it.
   * @param {string} sessionId
   * @param {number} tabId
   */
  trackSessionTab(sessionId, tabId) {
    const owners = this.tabOwners.get(tabId) ?? new Set();
    owners.add(sessionId);
    this.tabOwners.set(tabId, owners);
    // Local extension: a tracked session also gets a stable claim so a caller
    // can guard a release with `{ ifClaim }` without an explicit acquisition.
    // An existing claim always wins; acquisitions keep their own identity.
    const claims = this.claimAttempts.get(tabId) ?? new Map();
    if (!claims.has(sessionId)) claims.set(sessionId, { sessionId, tabId });
    this.claimAttempts.set(tabId, claims);
  }
  /**
   * Identity of the latest acquisition, including repeated use on one attachment.
   * @param {string} sessionId
   * @param {number} tabId
   * @returns {SessionClaim | undefined}
   */
  getSessionClaimId(sessionId, tabId) {
    return this.claimAttempts.get(tabId)?.get(sessionId);
  }
  /**
   * Release one session's claim, preserving attachments still used by another.
   * @param {string} sessionId
   * @param {number} tabId
   * @param {ReleaseSessionGuard} [guard] Release only while the claim still matches.
   * @returns {Promise<void>}
   */
  async releaseSessionTab(sessionId, tabId, guard) {
    if (guard && this.getSessionClaimId(sessionId, tabId) !== guard.ifClaim) return;
    this.claimAttempts.get(tabId)?.delete(sessionId);
    this.backgroundExecution.release(sessionId, tabId);
    const owners = this.tabOwners.get(tabId);
    owners?.delete(sessionId);
    if (owners?.size === 0) this.tabOwners.delete(tabId);
    // Remove the old claim before yielding: a new acquisition must survive
    // this cleanup, including when it reuses the same session id.
    const attaching = this.attachInFlight.get(tabId);
    if (attaching && !(await cleanupWait(attaching.catch(() => {})))) {
      if (!this.tabOwners.has(tabId)) await this.detach(tabId);
      return;
    }
    try {
      if (!(await cleanupWait(this.backgroundExecution.synchronize(tabId)))) {
        throw new Error('Background execution cleanup timed out');
      }
    } catch (error) {
      // A failed disable must not leave a returned user page emulated just
      // because a passive reader still owns the debugger. Readers can reattach.
      await this.detach(tabId);
      throw error;
    } finally {
      if (!this.tabOwners.has(tabId)) await this.detach(tabId);
    }
  }
  /**
   * Debug body reads must never resurrect a detached or returned tab.
   * @template T
   * @param {CdpDebuggee} target
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<T>}
   */
  async sendAttached(target, method, params) {
    if (!this.attachedTabs.has(target.tabId)) throw new Error('debugger detached');
    return this.api.sendCommand(target, method, params);
  }
  /**
   * Detach tabs only when no other live session has claimed them.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async detachSession(sessionId) {
    const owned = new Set([...this.tabOwners.keys(), ...this.claimAttempts.keys()]);
    await Promise.all([...owned].map((tabId) => this.releaseSessionTab(sessionId, tabId)));
  }
  /**
   * Clean up ownership and fence any in-flight attachment when a tab closes.
   * @param {number} tabId
   */
  forgetClosedTab(tabId) {
    this.claimAttempts.delete(tabId);
    this.tabOwners.delete(tabId);
    this.backgroundExecution.forget(tabId);
    void this.detach(tabId);
  }
  /**
   * Reconcile debugger attachments with the current set of live sessions.
   * @param {ReadonlySet<string>} liveSessionIds
   * @returns {Promise<void>}
   */
  async syncSessions(liveSessionIds) {
    const generation = ++this.syncGeneration;
    const releases = [];
    const seen = new Set();
    const queueRelease = (sessionId, tabId) => {
      const key = `${sessionId}:${tabId}`;
      if (seen.has(key)) return;
      seen.add(key);
      releases.push(this.releaseSessionTab(sessionId, tabId));
    };
    for (const [tabId, owners] of this.tabOwners) {
      for (const sessionId of owners) {
        if (!liveSessionIds.has(sessionId)) queueRelease(sessionId, tabId);
      }
    }
    for (const [tabId, claims] of this.claimAttempts) {
      for (const sessionId of claims.keys()) {
        if (!liveSessionIds.has(sessionId)) queueRelease(sessionId, tabId);
      }
    }
    await Promise.all(releases);
    if (generation !== this.syncGeneration) return;
    const unowned = [];
    for (const tabId of new Set([...this.attachedTabs, ...this.attachInFlight.keys()])) {
      if (!this.tabOwners.get(tabId)?.size && !this.claimAttempts.get(tabId)?.size) {
        unowned.push(this.detach(tabId));
      }
    }
    await Promise.all(unowned);
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
/**
 * Push one entry into a per-tab buffer, dropping the oldest past the cap.
 * @param {Map<number, Array<object>>} buffers
 * @param {number} tabId
 * @param {object} entry
 * @param {number} maxEntries
 */
function appendBounded(buffers, tabId, entry, maxEntries) {
  const buffer = buffers.get(tabId) ?? [];
  buffer.push(entry);
  while (buffer.length > maxEntries) buffer.shift();
  buffers.set(tabId, buffer);
}
/** Wait for every task, but never past `deadline`. Returns false when time ran out. */
async function settleBeforeDeadline(promises, deadline) {
  if (promises.length === 0) return true;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  let timer;
  const timedOut = await Promise.race([
    Promise.allSettled(promises).then(() => false),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), remaining);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return !timedOut;
}
/** Caller-side cleanup budget; the underlying promise remains fenced and its
 * late completion is still observed. A deadline is not native cancellation. */
async function cleanupWait(work) {
  let timer;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), CLEANUP_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/**
 * Select and project buffered entries for one read. Without a cursor the
 * newest entries are returned; with one the read advances from that sequence.
 * `truncated` reports dropped buffered entries, a clipped page, or a shortened
 * projection.
 * @param {Array<{ sequence: number, truncated?: boolean }>} buffer Oldest first.
 * @param {number} currentSequence Latest sequence assigned to this buffer.
 * @param {number} [since]
 * @param {number} limit
 * @param {(entry: any) => any} project
 * @returns {{ entries: any[], nextSince: number, truncated: boolean }}
 */
function readBufferedEntries(buffer, currentSequence, since, limit, project) {
  const hasCursor = typeof since === 'number';
  const candidates = hasCursor ? buffer.filter((entry) => entry.sequence > since) : buffer;
  const limited = hasCursor ? candidates.slice(0, limit) : candidates.slice(-limit);
  const entries = limited.map(project);
  const oldestSequence = buffer[0]?.sequence ?? currentSequence + 1;
  const droppedEntries = currentSequence > buffer.length && (!hasCursor || (since ?? 0) < oldestSequence - 1);
  return {
    entries,
    nextSince: entries.at(-1)?.sequence ?? currentSequence,
    truncated: droppedEntries || candidates.length > limited.length || entries.some((entry) => entry.truncated),
  };
}
/**
 * Bound one string and report whether it was shortened.
 * @param {string} value
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
function truncateText(value, maxChars) {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}
/**
 * Project a stored console entry for the agent, omitting the stack unless it
 * was requested.
 * @param {ConsoleEntry} entry
 * @param {number} maxTextChars
 * @param {boolean} includeStack
 * @returns {ConsoleEntry}
 */
function projectConsoleEntry(entry, maxTextChars, includeStack) {
  const projected = truncateText(entry.text, maxTextChars);
  return {
    sequence: entry.sequence,
    kind: entry.kind,
    level: entry.level,
    text: projected.text,
    url: entry.url,
    line: entry.line,
    column: entry.column,
    timestamp: entry.timestamp,
    ...(includeStack && entry.stack_trace && entry.stack_trace.length > 0 ? { stack_trace: entry.stack_trace } : {}),
    truncated: entry.truncated || projected.truncated,
  };
}
/**
 * Bound an optional string, preserving `undefined`.
 * @param {string | undefined} value
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean } | undefined}
 */
function truncateOptional(value, maxChars) {
  return value === undefined ? undefined : truncateText(value, maxChars);
}
/**
 * Build one network entry, bounding every optional text field.
 * @param {ParsedNetworkEntry} input
 * @returns {NetworkEntry}
 */
function makeNetworkEntry(input) {
  const projectedMethod = truncateOptional(input.method, MAX_NETWORK_FIELD_LENGTH);
  const projectedUrl = truncateOptional(input.url, MAX_NETWORK_FIELD_LENGTH);
  const projectedStatusText = truncateOptional(input.status_text, MAX_NETWORK_FIELD_LENGTH);
  const projectedMimeType = truncateOptional(input.mime_type, MAX_NETWORK_FIELD_LENGTH);
  const projectedResourceType = truncateOptional(input.resource_type, MAX_NETWORK_FIELD_LENGTH);
  const projectedError = input.error_text !== undefined ? truncateText(input.error_text, MAX_NETWORK_FIELD_LENGTH) : undefined;
  return {
    kind: input.kind,
    method: projectedMethod?.text,
    url: projectedUrl?.text,
    status: input.status,
    status_text: projectedStatusText?.text,
    mime_type: projectedMimeType?.text,
    resource_type: projectedResourceType?.text,
    error_text: projectedError?.text,
    timestamp: input.timestamp,
    truncated: input.truncated === true || (projectedMethod?.truncated ?? false) || (projectedUrl?.truncated ?? false) || (projectedStatusText?.truncated ?? false) || (projectedMimeType?.truncated ?? false) || (projectedResourceType?.truncated ?? false) || (projectedError?.truncated ?? false),
  };
}
/**
 * Turn a `Network.responseReceived` payload into a stored entry, attributing
 * it with the metadata remembered for the same request id.
 * @param {NetworkRequestMeta | undefined} info
 * @param {object} params
 * @returns {ParsedNetworkEntry | null} Null when no URL is known.
 */
function parseNetworkResponse(info, params) {
  const raw = params ?? {};
  const response = raw.response ?? {};
  const url = typeof response.url === 'string' ? response.url : info?.url;
  if (!url) return null;
  return makeNetworkEntry({
    kind: 'response',
    method: info?.method,
    url,
    status: typeof response.status === 'number' ? response.status : undefined,
    status_text: typeof response.statusText === 'string' ? response.statusText : undefined,
    mime_type: typeof response.mimeType === 'string' ? response.mimeType : undefined,
    resource_type: typeof raw.type === 'string' ? raw.type : info?.resourceType,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
    truncated: info?.truncated === true,
  });
}
/**
 * Turn a `Network.loadingFailed` payload into a stored entry.
 * @param {NetworkRequestMeta | undefined} info
 * @param {object} params
 * @returns {ParsedNetworkEntry}
 */
function parseNetworkFailure(info, params) {
  const raw = params ?? {};
  return makeNetworkEntry({
    kind: 'failure',
    method: info?.method,
    url: info?.url,
    error_text: typeof raw.errorText === 'string' ? raw.errorText : undefined,
    resource_type: typeof raw.type === 'string' ? raw.type : info?.resourceType,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
    truncated: info?.truncated === true,
  });
}
/**
 * Project a stored network entry against the read's text budget.
 * @param {NetworkEntry} entry
 * @param {number} maxTextChars
 * @returns {NetworkEntry}
 */
function projectNetworkEntry(entry, maxTextChars) {
  const projectedUrl = truncateOptional(entry.url, maxTextChars);
  const projectedError = entry.error_text !== undefined ? truncateText(entry.error_text, maxTextChars) : undefined;
  return {
    sequence: entry.sequence,
    kind: entry.kind,
    method: entry.method,
    url: projectedUrl?.text,
    status: entry.status,
    status_text: entry.status_text,
    mime_type: entry.mime_type,
    resource_type: entry.resource_type,
    error_text: projectedError?.text,
    timestamp: entry.timestamp,
    truncated: entry.truncated || (projectedUrl?.truncated ?? false) || (projectedError?.truncated ?? false),
  };
}
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