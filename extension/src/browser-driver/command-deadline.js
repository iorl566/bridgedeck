const RENDERER_READS = new Set([
  'DOMSnapshot.enable', 'DOMSnapshot.captureSnapshot', 'Accessibility.enable', 'Accessibility.disable',
  'Accessibility.getFullAXTree', 'Page.getLayoutMetrics', 'Page.getFrameTree', 'DOM.getFrameOwner',
]);
const READ_COMMANDS = new Set([...RENDERER_READS, 'Target.setAutoAttach']);
/**
 * Default deadline for renderer-backed reads that observation issues on the
 * caller's behalf. The deadline ends the caller's wait only; it cannot cancel a
 * command the browser already dispatched.
 */
export const READ_TIMEOUT_MS = 10_000;
/** Longer deadline for one-shot capture reads that legitimately traverse a page. */
export const CAPTURE_READ_TIMEOUT_MS = 20_000;
/** Best-effort cleanup deadline; a completed capture must not stay open for it. */
export const ACCESSIBILITY_CLEANUP_TIMEOUT_MS = 1_000;
const SLOW_COMMAND_MS = 2_000;
/** Compatibility reason reported for every bounded read, including reads refused
 * behind a pending command; `phase` distinguishes the two cases. */
export const RENDERER_READ_TIMEOUT = 'renderer_read_timeout';
const RECOVERY = 'Do not retry reads on this tab while the earlier command is pending. Navigation alone does not clear the read gate; it reopens when the command settles or its debugger session detaches. Use another tab or report the unavailable read.';

/**
 * Whether a method is answered by the renderer rather than the browser process.
 *
 * Renderer methods are the ones that hang with an unresponsive page, so callers
 * use this to choose the error wording and the process classification.
 *
 * @param {string} method Browser protocol method name.
 * @returns {boolean} True for renderer-backed reads.
 */
export function isRendererRead(method) { return RENDERER_READS.has(method); }

const GUARDED_READS = new Set([
  ...READ_COMMANDS, 'Page.getFrameTree', 'Page.createIsolatedWorld', 'DOM.getDocument', 'DOM.querySelector',
  'DOM.describeNode', 'DOM.resolveNode', 'DOM.getBoxModel', 'DOM.getContentQuads',
  'Runtime.enable', 'Log.enable', 'Runtime.evaluate', 'Runtime.callFunctionOn',
]);

/**
 * Error raised when a bounded browser read exceeds its deadline or is refused
 * behind an earlier read that is still pending. `phase` separates a real
 * deadline from a read that was never dispatched because the tab is gated.
 */
export class CdpReadTimeoutError extends Error {
  constructor(method, tabId, timeout, sessionId, phase = 'deadline') {
    super(`Browser read ${method} timed out after ${timeout}ms (tab ${tabId}); the ${isRendererRead(method) || method.startsWith('Runtime.') || method === 'Log.enable' ? 'renderer' : 'browser'} is not answering. ${RECOVERY}`);
    this.name = 'CdpReadTimeoutError';
    this.method = method;
    this.tabId = tabId;
    this.sessionId = sessionId;
    this.phase = phase;
  }

  /**
   * Build the error used when a read must not be queued behind a pending one.
   *
   * @param {string} method Browser protocol method name.
   * @param {number | undefined} tabId Tab the read belongs to.
   * @param {string} [sessionId] Session of the read that is still pending.
   * @returns {CdpReadTimeoutError} Error with `phase` set to `blocked`.
   */
  static stillPending(method, tabId, sessionId) {
    const error = new CdpReadTimeoutError(method, tabId, 0, sessionId, 'blocked');
    error.message = `Browser read ${method} refused: an earlier read on tab ${tabId} is still pending in Chrome. ${RECOVERY}`;
    return error;
  }
}

/**
 * @param {unknown} error Value thrown by a read.
 * @returns {{ data?: { reason: string, phase?: string, method?: string, process?: string } }}
 *   Error details for a read timeout, or an empty object for any other error.
 */
export function readTimeoutDetails(error) {
  return error instanceof Error && error.name === 'CdpReadTimeoutError'
    ? { data: {
        reason: RENDERER_READ_TIMEOUT,
        ...(error instanceof CdpReadTimeoutError ? {
          phase: error.phase,
          method: error.method,
          ...(error.phase === 'deadline' ? { process: error.method === 'Target.setAutoAttach' ? 'browser' : 'renderer' } : {}),
        } : {}),
      } }
    : {};
}

/**
 * Per-tab gate that keeps a timed-out read from being retried into the same
 * unresponsive target. A timed-out read blocks later guarded reads on its tab
 * and session until the original command settles or that session detaches.
 *
 * The gate is per tab and per session, never global: another tab must stay
 * usable while this one is stuck. Refused reads use the `blocked` phase, so
 * callers can distinguish "never dispatched" from "deadline expired".
 *
 * `run` owns both the deadline and the block; `reset` is called when a native
 * command settles; `clear` drops all tab state on driver disposal.
 *
 * Deadline behavior:
 * * A deadline rejects the caller's wait without cancelling the command.
 * * An abort rejects with the abort reason.
 * * A blocked read is refused before dispatch.
 * * A settle clears only the matching session block.
 * * Root and child sessions use separate keys.
 * * A blocked tab stays usable through another tab.
 * * A detach clears the session that disappeared.
 * * Disposal clears every tab.
 */
export class CdpReadGate {
  /** Create an empty gate; tabs are added lazily by `run`. */
  constructor() { this.tabs = new Map(); }

  /**
   * Run one read under the gate and an optional deadline.
   *
   * Refuses guarded methods when an earlier read on the tab is still pending,
   * clears the block once the original command settles, and rejects with the
   * abort reason without cancelling the native command.
   *
   * @param {import('./chromium-cdp.js').CdpTarget} target Target the read uses.
   * @param {string} method Browser protocol method name.
   * @param {() => Promise<any>} run Starts the native command.
   * @param {number} [timeoutMs] Deadline in milliseconds.
   * @param {AbortSignal} [signal] Cancels the caller's wait, not the command.
   * @returns {Promise<any>} Command result, or a timeout/abort rejection.
   */
  run(target, method, run, timeoutMs, signal) {
    signal?.throwIfAborted();
    let sessions = this.tabs.get(target.tabId);
    if (!sessions) this.tabs.set(target.tabId, (sessions = new Map()));
    const key = target.sessionId ?? 'root';
    let blocked = sessions.get(key);
    if (!blocked) sessions.set(key, (blocked = new Set()));
    const error = sessions.get('root')?.values().next().value ?? blocked.values().next().value;
    if (error && GUARDED_READS.has(method)) return Promise.reject(CdpReadTimeoutError.stillPending(method, target.tabId, error.sessionId));
    let pending = true;
    let blocker;
    const blockUntilSettled = (error) => {
      if (!pending || blocker) return;
      blocker = error;
      blocked.add(error);
    };
    const work = runCdpCommand(target, method, run, timeoutMs, {
      timedOut: blockUntilSettled,
      settled: () => {
        pending = false;
        if (blocker) blocked.delete(blocker);
      },
    });
    if (!signal) return work;
    return waitForAbort(work, signal, () => blockUntilSettled(CdpReadTimeoutError.stillPending(method, target.tabId, target.sessionId)));
  }

  /**
   * @param {number} tabId Tab whose gate is released.
   * @param {string} [sessionId] Session to release; omit to release the tab.
   * @returns {void}
   */
  /**
   * Clear the block for one session once its native command settled.
   *
   * @param {number} tabId
   * @param {string} [sessionId] Root session when omitted.
   */
  reset(tabId, sessionId) {
    if (sessionId) this.tabs.get(tabId)?.delete(sessionId);
    else this.tabs.delete(tabId);
  }
  /** @returns {void} Removes every recorded gate. */
  /** Drop every tab/session block on driver disposal. */
  clear() { this.tabs.clear(); }
}

async function waitForAbort(work, signal, onAbort) {
  let abort;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        abort = () => {
          onAbort?.();
          reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/**
 * Dispatch one command with a deadline and slow-command logging.
 *
 * The deadline classifies the read and rejects the caller's promise; it does not
 * cancel the native command. A late reply is still observed and logged as a slow
 * command, and `lifecycle.settled` runs for every outcome so the gate can reopen.
 *
 * @param {import('./chromium-cdp.js').CdpTarget} target Target to read from.
 * @param {string} method Browser protocol method name.
 * @param {() => Promise<any>} run Starts the native command.
 * @param {number} [timeoutMs] Deadline in milliseconds.
 * @param {{ timedOut: (error: CdpReadTimeoutError) => void, settled: () => void }} [lifecycle]
 *   Gate callbacks for a deadline and for the command settling.
 * @returns {Promise<any>} Command result, or a timeout rejection.
 */
export async function runCdpCommand(target, method, run, timeoutMs = method === 'Accessibility.disable'
  ? ACCESSIBILITY_CLEANUP_TIMEOUT_MS
  : method === 'DOMSnapshot.captureSnapshot' || method === 'Accessibility.getFullAXTree'
    ? CAPTURE_READ_TIMEOUT_MS
    : method !== 'Page.getFrameTree' && READ_COMMANDS.has(method)
      ? READ_TIMEOUT_MS
      : undefined, lifecycle) {
  const started = Date.now();
  let timedOut = false;
  const details = () => ({ tabId: target.tabId, frameSessionId: target.sessionId, method, elapsedMs: Date.now() - started });
  const settled = (outcome) => {
    lifecycle?.settled();
    if (Date.now() - started < SLOW_COMMAND_MS) return;
    const log = timedOut ? console.warn : console.debug;
    log('[bb cdp] slow command settled', { ...details(), outcome, late: timedOut });
  };
  let pending;
  try {
    pending = run().then((value) => { settled('returned'); return value; }, (error) => { settled('failed'); throw error; });
  } catch (error) {
    settled('failed');
    throw error;
  }
  if (timeoutMs === undefined) return pending;
  let deadline;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        deadline = setTimeout(() => {
          timedOut = true;
          console.warn('[bb cdp] read timed out', details());
          const error = new CdpReadTimeoutError(method, target.tabId, timeoutMs, target.sessionId);
          lifecycle?.timedOut(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
