/**
 * Owns overlay state by rendering scope. Pure state; UI rendering is separate.
 *
 * User-tab overlays survive Agent session teardown; Agent-tab overlays are
 * cleared whenever a tab is returned.
 *
 * @typedef {object} OverlayState
 * @property {import('./BorrowConfirmationOverlay.js').BorrowRequestData[]} borrowRequests Pending borrow confirmations, oldest first.
 * @property {import('./HelpRequestOverlay.js').HelpRequestData | null} activeHelp Help request currently owning the tab chrome.
 * @property {import('./RecordOverlay.js').RecordRequestData | null} activeRecord Recording currently owning the tab chrome.
 * @property {boolean} controlVisible Derived by {@link OverlayController#snapshot} from session and mode.
 * @property {boolean} interrupting Whether an interrupt request is in flight.
 * @property {string | null} activeSessionId Session whose chrome is active, or null.
 * @property {import('../lib/controller-info.js').ControllerInfo} [controller] Controlling agent metadata for the active session.
 * @property {import('../lib/overlay-bridge.js').OverlayMode} controlMode
 * @property {number} automationBypassCount Reference count of granted automation bypasses.
 * @property {boolean} suppressControlAfterRecord
 * After record Finish/Stop clears `activeRecord`, the session is still alive
 * until teardown. Suppress the control mask for that gap so it does not flash
 * between the recording pill and teardown.
 * @property {boolean} controlHintsHidden
 * User preference (storage, toggled from the popup): hide the control hints —
 * status card, glow, and fallback input blocker. Not session state; survives
 * overlay resets.
 */

export class OverlayController {
  constructor() {
    this.state = {
      borrowRequests: [],
      activeHelp: null,
      activeRecord: null,
      interrupting: false,
      activeSessionId: null,
      controlMode: 'hidden',
      automationBypassCount: 0,
      suppressControlAfterRecord: false,
      controlHintsHidden: false,
    };
  }

  /**
   * Detached view of the current state with `controlVisible` derived and the
   * request list copied, so callers never mutate the controller.
   *
   * @returns {OverlayState}
   */
  snapshot() {
    return { ...this.state, controlVisible: this.isControlVisible(), borrowRequests: [...this.state.borrowRequests] };
  }

  /** @returns {boolean} True only while a session is active in control mode. */
  isControlVisible() {
    return this.state.activeSessionId !== null && this.state.controlMode === 'control';
  }

  /**
   * Add a borrow request, replacing any request with the same id.
   *
   * @param {import('./BorrowConfirmationOverlay.js').BorrowRequestData} request
   */
  addBorrowRequest(request) {
    this.state.borrowRequests = [...this.state.borrowRequests.filter((item) => item.id !== request.id), request];
  }

  /** @param {string} requestId */
  removeBorrowRequest(requestId) {
    this.state.borrowRequests = this.state.borrowRequests.filter((item) => item.id !== requestId);
  }

  /** @param {string} sessionId Start controlling this session and drop stale controller metadata. */
  activateAgentSession(sessionId) {
    this.state.controller = undefined;
    this.state.activeSessionId = sessionId;
    this.state.interrupting = false;
    this.state.controlMode = 'control';
  }

  /**
   * Apply a background control-mode update.
   *
   * Controller metadata is kept only while a session and a visible mode are
   * both present; a hidden or session-less update clears the session and
   * returns to `hidden`.
   *
   * @param {string | null} sessionId
   * @param {import('../lib/overlay-bridge.js').OverlayMode} mode
   * @param {import('../lib/controller-info.js').ControllerInfo} [controller]
   */
  applyAgentControlMode(sessionId, mode, controller) {
    this.state.controller = sessionId && mode !== 'hidden' ? controller : undefined;
    if (mode === 'control' && sessionId) {
      this.state.activeSessionId = sessionId;
      this.state.interrupting = false;
      this.state.controlMode = 'control';
      return;
    }
    if ((mode === 'interrupting' || mode === 'paused') && sessionId) {
      this.state.activeSessionId = sessionId;
      this.state.interrupting = mode === 'interrupting';
      this.state.controlMode = mode;
      return;
    }
    this.state.activeSessionId = null;
    this.state.interrupting = false;
    this.state.controlMode = 'hidden';
  }

  /** @param {boolean} interrupting No-op until a session is active. */
  setInterrupting(interrupting) {
    if (!this.state.activeSessionId) return;
    this.state.interrupting = interrupting;
  }

  /**
   * Show a help request and return the one it replaced.
   *
   * @param {import('./HelpRequestOverlay.js').HelpRequestData} request
   * @returns {import('./HelpRequestOverlay.js').HelpRequestData | null}
   */
  setAgentHelpRequest(request) {
    const previous = this.state.activeHelp;
    this.state.activeHelp = request;
    return previous;
  }

  /** @param {string} [requestId] Omit to clear whatever help request is active. */
  clearAgentHelpRequest(requestId) {
    if (!this.state.activeHelp) return;
    if (requestId && this.state.activeHelp.id !== requestId) return;
    this.state.activeHelp = null;
  }

  /**
   * Show a recording request and return the one it replaced. Showing a request
   * also lifts any post-record control suppression.
   *
   * @param {import('./RecordOverlay.js').RecordRequestData} request
   * @returns {import('./RecordOverlay.js').RecordRequestData | null}
   */
  setAgentRecordRequest(request) {
    const previous = this.state.activeRecord;
    this.state.activeRecord = request;
    this.state.suppressControlAfterRecord = false;
    return previous;
  }

  /**
   * Clear the active recording and suppress the control mask until session
   * teardown, so it does not flash between the recording pill and teardown.
   * Stacked automation-bypass references are dropped with it.
   *
   * @param {string} [requestId] Omit to clear whatever recording is active.
   */
  clearAgentRecordRequest(requestId) {
    if (!this.state.activeRecord) return;
    if (requestId && this.state.activeRecord.id !== requestId) return;
    this.state.activeRecord = null;
    this.state.suppressControlAfterRecord = true;
    this.state.automationBypassCount = 0;
  }

  /** @param {boolean} enabled Increment on true, decrement (floored at zero) on false. */
  setAutomationBypass(enabled) {
    if (enabled) this.state.automationBypassCount += 1;
    else this.state.automationBypassCount = Math.max(0, this.state.automationBypassCount - 1);
  }

  /** @param {boolean} hidden User preference, not session state. */
  setControlHintsHidden(hidden) {
    this.state.controlHintsHidden = hidden;
  }

  /**
   * Clear Agent-tab overlays when its tab is returned.
   *
   * @param {string} sessionId Session being torn down.
   * @returns {import('./HelpRequestOverlay.js').HelpRequestData | null} The help
   * request that was showing, or null when the update belongs to another session.
   */
  resetAgentOverlays(sessionId) {
    if (this.state.activeSessionId && this.state.activeSessionId !== sessionId) return null;
    const previousHelp = this.state.activeHelp;
    this.state = {
      ...this.state,
      activeHelp: null,
      activeRecord: null,
      interrupting: false,
      activeSessionId: null,
      controller: undefined,
      controlMode: 'hidden',
      automationBypassCount: 0,
      suppressControlAfterRecord: false,
    };
    return previousHelp;
  }
}

/**
 * Control mask must hide while help/record overlays own the chrome. It also
 * stays hidden while the user hides control hints or while a finished
 * recording waits for session teardown.
 *
 * @param {OverlayState} state
 * @returns {boolean}
 */
export function shouldShowAgentControlOverlay(state) {
  return state.controlVisible
    && !state.controlHintsHidden
    && !state.suppressControlAfterRecord
    && state.activeHelp === null
    && state.activeRecord === null;
}
