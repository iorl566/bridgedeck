import { isControllerInfo } from './controller-info.js';

/**
 * Wire protocol between the content-script control overlay and the background
 * service worker.
 *
 * Requests from the content script:
 * - `who_am_i`: which session owns this tab (tab id or window id as a hint).
 * - `ready`: the overlay mounted and wants its authoritative state; the
 *   background normally pushes state proactively on tab creation and control
 *   changes, so this is only a fallback.
 * - `interrupt`: cancel every in-flight and queued tool call for the session
 *   while keeping the tab, the debugging attachment and the conversation.
 * - `set_minimized`: collapse or expand the overlay for the session.
 *
 * Messages from the background additionally carry a version so the page can
 * order them, and `controller`/`cooperation` display data that is validated
 * before use.
 *
 * @typedef {object} OverlayWhoAmIRequest
 * @property {string} kind  Always {@link OVERLAY_MSG_WHO_AM_I}.
 * @property {number} [tabId]  Tab to resolve, when the sender knows it.
 * @property {number} [windowId]  Window hint used when the tab id is unavailable.
 *
 * @typedef {object} OverlayWhoAmIResponse
 * @property {string | null} sessionId  Owning session, or null in an unowned tab.
 *
 * @typedef {'control' | 'interrupting' | 'paused' | 'hidden'} OverlayMode
 * `control`: full control UI and click blocker; `interrupting`: cancellation in
 * progress; `paused`: session paused; `hidden`: no overlay and no blocker.
 *
 * @typedef {object} OverlayVersion
 * @property {string} epoch  Identifies one background worker instance.
 * @property {number} generation  Increases with every message in that instance.
 *
 * @typedef {OverlayVersion & {
 *   type: string,
 *   sessionId: string | null,
 *   mode: OverlayMode,
 *   controller?: object,
 *   cooperation?: object,
 *   minimized?: boolean,
 * }} OverlayAgentStateMessage
 * Authoritative overlay state: identity, mode, optional validated labels, and
 * optional cooperation/minimized flags the page applies verbatim.
 *
 * @typedef {object} OverlayInterruptRequest
 * @property {string} kind  Always {@link OVERLAY_MSG_INTERRUPT}.
 * @property {string} sessionId  Session whose calls should be cancelled.
 *
 * @typedef {object} OverlayInterruptResponse
 * @property {boolean} ok  True only when the background explicitly accepted the request.
 *
 * @typedef {object} OverlaySetMinimizedRequest
 * @property {string} kind  Always {@link OVERLAY_MSG_SET_MINIMIZED}.
 * @property {string} sessionId  Session whose overlay is affected.
 * @property {boolean} minimized  Requested collapsed state.
 *
 * @typedef {object} OverlayAutomationBypassMessage
 * @property {string} type  Always {@link OVERLAY_AUTOMATION_BYPASS}.
 * @property {boolean} enabled  Whether the click blocker should step aside.
 *
 * @typedef {OverlayVersion & { type: string, sessionId: string }} OverlayAgentOverlayResetMessage
 * Tells the page to drop overlays that belong only inside an agent tab.
 *
 * @typedef {object} OverlayReadyRequest
 * @property {'overlay.ready'} kind  Always {@link OVERLAY_MSG_READY}.
 *
 * @typedef {OverlayWhoAmIRequest | OverlayReadyRequest | OverlayInterruptRequest
 *   | OverlaySetMinimizedRequest} OverlayMessage
 * Every request the background accepts from an overlay.
 */

/** Wire protocol between the content-script overlay and the background worker. */
export const OVERLAY_MSG_WHO_AM_I = 'overlay.who_am_i';
export const OVERLAY_MSG_READY = 'overlay.ready';
export const OVERLAY_MSG_INTERRUPT = 'overlay.interrupt';
export const OVERLAY_MSG_SET_MINIMIZED = 'overlay.set_minimized';

/**
 * Shadow host element name and marker attribute for the overlay UI. Capture
 * adapters use them to skip the overlay host and its shadow subtree, so both
 * are part of the cross-module contract rather than an implementation detail.
 */
export const OVERLAY_HOST_NAME = 'bridge-deck-overlay';
export const OVERLAY_HOST_MARKER_ATTR = 'data-bb-overlay';
/** CSS selector matching either the host name or the marker attribute. */
export const OVERLAY_HOST_SELECTOR = `${OVERLAY_HOST_NAME}, [${OVERLAY_HOST_MARKER_ATTR}]`;

/**
 * Whether a tag name denotes the overlay host.
 *
 * @param {string} tagName  Element tag name, compared case-insensitively.
 * @returns {boolean} True when the element is the overlay host.
 */
export function isOverlayHostElementName(tagName) {
  return tagName.toLowerCase() === OVERLAY_HOST_NAME;
}

/**
 * Whether an attribute name marks the overlay host.
 *
 * @param {string} attrName  Attribute name, compared case-insensitively.
 * @returns {boolean} True when the attribute is the overlay marker.
 */
export function isOverlayHostMarkerAttribute(attrName) {
  return attrName.toLowerCase() === OVERLAY_HOST_MARKER_ATTR;
}

/**
 * Whether a node is part of the overlay host, by tag name or marker attribute.
 *
 * Attribute names are optional because some capture paths only know the tag;
 * passing none simply checks the name.
 *
 * @param {string} tagName  Element tag name.
 * @param {Iterable<string>} [attributeNames]  Attribute names on the node.
 * @returns {boolean} True when the node belongs to the overlay host.
 */
export function isOverlayHostNode(tagName, attributeNames) {
  if (isOverlayHostElementName(tagName)) return true;
  if (!attributeNames) return false;
  for (const name of attributeNames) if (isOverlayHostMarkerAttribute(name)) return true;
  return false;
}

/** Page-world `document.querySelector(...)` expression for the overlay host. */
export const OVERLAY_HOST_LOOKUP_EXPR = `document.querySelector(${JSON.stringify(OVERLAY_HOST_SELECTOR)})`;
/** Background to content: complete authoritative overlay state. */
export const OVERLAY_AGENT_STATE = 'bh-agent-overlay-state';
/** Background to content: temporarily disable the overlay click blocker. */
export const OVERLAY_AUTOMATION_BYPASS = 'bh-automation-bypass';
/** Background to content: clear overlays that belong only inside an agent tab. */
export const OVERLAY_AGENT_OVERLAY_RESET = 'bh-agent-overlay-reset';

/**
 * Narrow an untrusted value to an overlay version pair.
 *
 * @param {{ epoch?: unknown, generation?: unknown }} candidate  Candidate object.
 * @returns {boolean} True when `epoch` is a string and `generation` a number.
 */
function isOverlayVersion(candidate) {
  return typeof candidate.epoch === 'string' && typeof candidate.generation === 'number';
}

/**
 * Validate an overlay reset message.
 *
 * @param {unknown} message  Candidate message.
 * @returns {boolean} True when `message` resets a named session at a valid version.
 */
export function isOverlayAgentOverlayResetMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return message.type === OVERLAY_AGENT_OVERLAY_RESET && typeof message.sessionId === 'string' && isOverlayVersion(message);
}

/**
 * Admit overlay state/reset messages in send order; drop stale ones.
 *
 * Messages are totally ordered by version, not by arrival time. A message from
 * the current epoch is admitted when its generation is not older than the last
 * one admitted. A message from a new epoch is newer by definition (a worker
 * never outlives its successor) and retires the previous epoch, so a late
 * message from the old instance stays dropped forever. This is what keeps a
 * late `control` state from pinning a full-page click blocker after a newer
 * `hidden` state already arrived.
 *
 * @property {OverlayVersion | null} last  Most recent admitted version.
 * @property {Set<string>} retiredEpochs  Epochs that must not be admitted again.
 */
export class OverlayVersionGate {
  constructor() {
    this.last = null;
    this.retiredEpochs = new Set();
  }

  /**
   * Whether the message with this version is current; records it when it is.
   *
   * Re-admitting the same generation is allowed, so a re-sent state still
   * applies. Any older generation from the same epoch, or any message from a
   * retired epoch, is rejected without changing the recorded version.
   *
   * @param {OverlayVersion} version  Version carried by the message.
   * @returns {boolean} True when the message should be applied.
   */
  admit(version) {
    const last = this.last;
    if (last && version.epoch === last.epoch) {
      if (version.generation < last.generation) return false;
    } else if (this.retiredEpochs.has(version.epoch)) {
      return false;
    } else if (last) {
      this.retiredEpochs.add(last.epoch);
    }
    this.last = { epoch: version.epoch, generation: version.generation };
    return true;
  }
}

/**
 * Validate an authoritative overlay state message.
 *
 * Identity and mode must be well-formed, the version must be valid, and the
 * optional controller label and minimized flag must pass their own validators.
 * An invalid optional field rejects the whole message rather than rendering a
 * partially trusted state.
 *
 * @param {unknown} message  Candidate message.
 * @returns {boolean} True when `message` is a valid overlay state.
 */
export function isOverlayAgentStateMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return message.type === OVERLAY_AGENT_STATE
    && (message.controller === undefined || isControllerInfo(message.controller))
    && (message.minimized === undefined || typeof message.minimized === 'boolean')
    && (typeof message.sessionId === 'string' || message.sessionId === null)
    && ['control', 'interrupting', 'paused', 'hidden'].includes(message.mode)
    && isOverlayVersion(message);
}
