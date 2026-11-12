/**
 * Click-only hit-test suppression; independent of screenshot visibility and
 * hover bypass.
 *
 * While a click lease is active the page overlay stops intercepting pointer
 * events for one click, so the browser hit-tests the real page. The lease is
 * scoped by an id: if an acknowledgement is lost, cleanup can only release the
 * click it was created for and never an unrelated, newer lease. The content
 * side also expires a lease after {@link INPUT_PASSTHROUGH_TTL_MS} so a missed
 * `end` cannot leave the page permanently click-through.
 *
 * @typedef {object} InputPassthroughMessage
 * @property {string} type  Always {@link INPUT_PASSTHROUGH}.
 * @property {'begin' | 'end'} phase  Acquire or release one click lease.
 * @property {string} id  Identifies one click; must be non-empty.
 *
 * @typedef {object} InputPassthroughAck
 * @property {string} type  Echoes {@link INPUT_PASSTHROUGH}.
 * @property {true} ok  Present only when the content script applied the change.
 *
 * @typedef {(tabId: number, message: InputPassthroughMessage) => Promise<unknown>} InputPassthroughSendToTab
 * Delivers one lease message; rejects when the tab has no receiver.
 */
export const INPUT_PASSTHROUGH = 'bb/input-passthrough';
export const INPUT_PASSTHROUGH_ATTR = 'data-bb-input-passthrough';
/** Bound orphaned click leases even if the background never sends end. */
export const INPUT_PASSTHROUGH_TTL_MS = 5_000;

/**
 * Narrow an untrusted message to the passthrough wire shape.
 *
 * A non-empty string id is required in addition to the type and phase, so a
 * malformed message can never release every active lease.
 *
 * @param {unknown} message  Candidate message.
 * @returns {boolean} True when `message` is a valid lease message.
 */
export function isInputPassthroughMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return message.type === INPUT_PASSTHROUGH && (message.phase === 'begin' || message.phase === 'end') && typeof message.id === 'string' && message.id.length > 0;
}

/**
 * Deliver one lease message to a tab.
 *
 * @param {number} tabId  Target tab.
 * @param {InputPassthroughMessage} message  Lease message to deliver.
 * @param {object} [tabs]  Tabs API override for tests.
 * @returns {Promise<unknown>} The content script's acknowledgement.
 */
export function sendInputPassthrough(tabId, message, tabs = globalThis.chrome?.tabs) {
  return tabs.sendMessage(tabId, message);
}
