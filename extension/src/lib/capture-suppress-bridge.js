/**
 * Wire protocol and background-side helper for temporarily excluding the
 * in-page overlay. Screenshots use it to avoid capturing the overlay; native
 * input uses it so the browser hit-tests the page underneath.
 *
 * The background wraps every bounded operation in
 * {@link withExtensionOverlayHidden}, which sends `begin` (the content script
 * hides its overlay host and only acknowledges once an overlay-free frame has
 * been produced) and always follows up with `end`, even when the operation
 * throws. Tabs without the content script (internal pages, the extension
 * gallery, ...) host no overlay, so a failed `begin` falls through to working
 * with the page directly.
 *
 * Message shape: `{ type: CAPTURE_SUPPRESS, phase: 'begin' | 'end' }`.
 */
export const CAPTURE_SUPPRESS = 'bb/capture-suppress';

/**
 * Narrow an untrusted message to the capture-suppression wire shape.
 *
 * Only the `type` and `phase` fields are checked; extra fields are ignored so
 * a newer sender can add metadata without breaking older receivers.
 *
 * @param {unknown} msg
 * @returns {boolean} True when `msg` is a begin/end capture-suppression message.
 */
export function isCaptureSuppressMessage(msg) {
  if (typeof msg !== 'object' || msg === null) return false;
  return msg.type === CAPTURE_SUPPRESS && (msg.phase === 'begin' || msg.phase === 'end');
}

/**
 * @typedef {'begin' | 'end'} CaptureSuppressPhase
 * `begin` hides the overlay and resolves after an overlay-free frame; `end`
 * restores it and resolves once the overlay is visible again.
 *
 * @typedef {object} CaptureSuppressMessage
 * @property {string} type  Always {@link CAPTURE_SUPPRESS}.
 * @property {CaptureSuppressPhase} phase  Which edge of the suppression window.
 *
 * @typedef {object} CaptureSuppressAck
 * @property {string} type  Echoes {@link CAPTURE_SUPPRESS}.
 * @property {true} ok  Present only on success, so a rejected send surfaces as an error.
 *
 * @typedef {(tabId: number, message: CaptureSuppressMessage) => Promise<unknown>} CaptureSuppressSendToTab
 * Sends one message to a tab; resolves with the content script's acknowledgement
 * and rejects when the tab has no receiver or the receiver throws.
 */

/** Production sender backed by the tabs messaging API. */
/** @type {CaptureSuppressSendToTab} */
const defaultSendToTab = (tabId, message) => globalThis.chrome.tabs.sendMessage(tabId, message);

/**
 * Run an operation with the target tab's overlay hidden.
 *
 * `begin` runs first and any failure (most commonly: no content script in that
 * tab) is swallowed, which simply skips suppression — there is no overlay to
 * hide. The operation's own failure is never masked: `end` is attempted in a
 * `finally` block and a failed restore is swallowed as well, so the overlay is
 * always asked to reappear while the original result or error propagates.
 *
 * @template T
 * @param {number} tabId  Tab whose overlay should be hidden.
 * @param {() => Promise<T>} fn  Bounded operation to run while hidden.
 * @param {CaptureSuppressSendToTab} [sendToTab]  Sender override for tests.
 * @returns {Promise<T>} Whatever `fn` resolves with; rejects when `fn` rejects.
 */
export async function withExtensionOverlayHidden(tabId, fn, sendToTab = defaultSendToTab) {
  let began = false;
  try {
    await sendToTab(tabId, { type: CAPTURE_SUPPRESS, phase: 'begin' });
    began = true;
  } catch {
    // No content script in the target tab: no overlay can leak into the capture.
  }
  try {
    return await fn();
  } finally {
    if (began) await sendToTab(tabId, { type: CAPTURE_SUPPRESS, phase: 'end' }).catch(() => {});
  }
}
