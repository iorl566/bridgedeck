/**
 * Wire protocol for the human-in-loop overlay.
 *
 * Messages travel between the background worker and a tab's content script.
 * The background asks a specific tab to enter "help mode" (render the request
 * overlay and hide the control overlay); the content script acknowledges that
 * the request is displayed, then later reports the user's decision. Related
 * tabs receive the same request in compact mode so they can show status without
 * stealing focus.
 *
 * Message kinds:
 * - request: background to content, enter help mode.
 * - ack: content to background, the overlay is visible.
 * - response: content to background, the user chose an outcome (from the tab
 *   that showed the full request).
 * - cancel: background to content, retract a request that is no longer needed.
 * - query: any page to background, ask whether help mode is active.
 * - finish: background to related tabs, tear down the compact status UI.
 *
 * @typedef {object} HelpHighlightRect
 * @property {number} top  Top edge in viewport coordinates.
 * @property {number} left  Left edge in viewport coordinates.
 * @property {number} width  Rectangle width in pixels.
 * @property {number} height  Rectangle height in pixels.
 *
 * @typedef {object} HelpRequestMessage
 * @property {string} type  Always {@link HELP_REQUEST}.
 * @property {string} requestId  Correlates the request with its response.
 * @property {string} prompt  Question shown to the user.
 * @property {string} [title]  Overlay title override; the default is used when absent.
 * @property {'full' | 'compact'} [displayMode]  Full task UI on the subject tab, compact on related tabs.
 * @property {string[]} selectors  CSS selectors to scroll to and flash; may be empty.
 * @property {HelpHighlightRect[]} [rects]  Viewport rectangles for targets with no usable root selector.
 * @property {number} timeoutMs  How long the overlay may stay up before it expires.
 *
 * @typedef {object} HelpAckMessage
 * @property {string} type  Always {@link HELP_ACK}.
 * @property {true} ok  Present only when the overlay was displayed.
 *
 * @typedef {object} HelpResponseMessage
 * @property {string} type  Always {@link HELP_RESPONSE}.
 * @property {'continued' | 'cancelled'} outcome  What the user chose.
 * @property {string} [note]  Optional free-text note from the user.
 *
 * @typedef {object} HelpCancelMessage
 * @property {string} type  Always {@link HELP_CANCEL}.
 * @property {string} requestId  Request to retract.
 *
 * @typedef {object} HelpQueryMessage
 * @property {string} type  Always {@link HELP_QUERY}.
 *
 * @typedef {object} HelpQueryResponse
 * @property {boolean} active  Whether help mode is currently active.
 * @property {Omit<HelpRequestMessage, 'type'>} [request]  The active request, when any.
 *
 * @typedef {object} HelpFinishMessage
 * @property {string} type  Always {@link HELP_FINISH}.
 * @property {string} requestId  Request whose compact UI should close.
 * @property {'continued' | 'cancelled'} outcome  Final outcome, for the closing message.
 * @property {string} [note]  Optional note mirrored from the response.
 */

export const HELP_REQUEST = 'bb-help-request';
export const HELP_RESPONSE = 'bb-help-response';
export const HELP_CANCEL = 'bb-help-cancel';
export const HELP_ACK = 'bb-help-ack';
export const HELP_QUERY = 'bb-help-query';
export const HELP_FINISH = 'bb-help-finish';

/**
 * Validate a help request from an untrusted sender.
 *
 * Every field the content script dereferences is checked here: ids and prompts
 * are strings, the optional title and display mode are type-checked, selectors
 * are a string array, rectangles carry four finite numbers, and the timeout is
 * numeric. Anything else is ignored rather than partially applied.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` is a valid help request.
 */
export function isHelpRequestMessage(msg) {
  if (typeof msg !== 'object' || msg === null) return false;
  return msg.type === HELP_REQUEST
    && typeof msg.requestId === 'string'
    && typeof msg.prompt === 'string'
    && (msg.title === undefined || typeof msg.title === 'string')
    && (msg.displayMode === undefined || msg.displayMode === 'full' || msg.displayMode === 'compact')
    && Array.isArray(msg.selectors) && msg.selectors.every((selector) => typeof selector === 'string')
    && (msg.rects === undefined || (Array.isArray(msg.rects) && msg.rects.every((rect) => typeof rect === 'object' && rect !== null && ['top', 'left', 'width', 'height'].every((key) => Number.isFinite(rect[key])))))
    && typeof msg.timeoutMs === 'number';
}

/**
 * Validate a cancel message.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` cancels a request by id.
 */
export function isHelpCancelMessage(msg) {
  return typeof msg === 'object' && msg !== null && msg.type === HELP_CANCEL && typeof msg.requestId === 'string';
}

/**
 * Validate a user response.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` carries a known outcome and valid note.
 */
export function isHelpResponseMessage(msg) {
  return typeof msg === 'object' && msg !== null && msg.type === HELP_RESPONSE && (msg.outcome === 'continued' || msg.outcome === 'cancelled') && (msg.note === undefined || typeof msg.note === 'string');
}

/**
 * Validate a display acknowledgement.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True only when the acknowledgement is explicitly successful.
 */
export function isHelpAckMessage(msg) {
  return typeof msg === 'object' && msg !== null && msg.type === HELP_ACK && msg.ok === true;
}

/**
 * Validate a help-mode query.
 *
 * The query has no payload, so the type tag alone identifies it.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` asks for help-mode state.
 */
export function isHelpQueryMessage(msg) {
  return typeof msg === 'object' && msg !== null && msg.type === HELP_QUERY;
}

/**
 * Validate a finish message.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` closes a request with a known outcome.
 */
export function isHelpFinishMessage(msg) {
  return typeof msg === 'object' && msg !== null && msg.type === HELP_FINISH && typeof msg.requestId === 'string' && (msg.outcome === 'continued' || msg.outcome === 'cancelled') && (msg.note === undefined || typeof msg.note === 'string');
}
