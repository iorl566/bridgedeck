/**
 * Wire protocol for user-action recording, sent between the background
 * service worker and a tab's content script.
 *
 * The background arms recording with `start`, receives one `step` message per
 * captured action, and ends with `stop` or `cancel`; `finish` closes a
 * recording on a page that is being torn down. `query` asks whether a recording
 * is active, which lets a freshly mounted content script recover after a
 * navigation without waiting for a push.
 *
 * Steps are numbered per producer. A producer is one content-script document,
 * so a reload starts a new producer at sequence 1 while earlier steps from the
 * old document remain accepted under their own producer id. Sequence numbers
 * let the background detect drops and duplicates even though messages from
 * different frames can arrive out of order.
 *
 * @typedef {object} RecordStartAck
 * @property {true} ok  Present only when recording was armed.
 *
 * @typedef {{ ok: true, sequence: number } | { ok: false, expectedSequence: number, error: string }} RecordStepAck
 * Acknowledgement of one step: accepted steps echo their sequence, rejected
 * steps report the sequence the background expected next plus a reason.
 *
 * @typedef {{ ok: true } | { ok: false, error: string }} RecordStopAck
 * Acknowledgement of a stop or cancel request.
 *
 * @typedef {object} RecordQueryMessage
 * @property {string} type  Always {@link RECORD_QUERY}.
 *
 * @typedef {object} RecordQueryResponse
 * @property {boolean} active  Whether a recording is running.
 * @property {string} [requestId]  Recording request id, when active.
 * @property {number} [startedAtMs]  Epoch milliseconds of the recording start.
 *
 * @typedef {object} RecordStartMessage
 * @property {string} type  Always {@link RECORD_START}.
 * @property {string} requestId  Recording identifier.
 * @property {number} [startedAtMs]
 *   Epoch milliseconds when the whole recording began, not when this tab was
 *   armed; the overlay timer spans navigations instead of restarting per page.
 *
 * @typedef {object} RecordStepPayload
 * @property {'click' | 'hover' | 'fill' | 'press' | 'select' | 'navigate'} op
 *   Recorded operation kind.
 * @property {object} [target]  Structured target descriptor for replay.
 * @property {string} [value]  Inserted text, already redacted when needed.
 * @property {string} [key]  Key name for a press.
 * @property {Array<'alt' | 'ctrl' | 'meta' | 'shift'>} [modifiers]  Held modifiers.
 * @property {string[]} [values]  Selected values for a multi-select.
 * @property {string[]} [labels]  Selected option labels, for display.
 * @property {string} [url]  Navigation destination.
 * @property {boolean} [redacted]  Whether the value was withheld on purpose.
 * @property {'enter' | 'suggestion' | 'blur'} [commit]  How a fill was committed.
 * @property {string} [page_url]  Page URL when the step was captured.
 * @property {{ rect: { x: number, y: number, w: number, h: number }, tag: string }} [geometry]
 *   Event-target bounds in the source frame's viewport coordinates.
 * @property {boolean} [expects_navigation]  Capture-only hint that a navigation should follow.
 * @property {boolean} [navigation_caused_by_action]  Whether an observed URL change was caused by the action.
 * @property {string} [transitionType]  Raw navigation transition type, for cause mapping.
 * @property {string[]} [transitionQualifiers]  Raw navigation qualifiers.
 *
 * @typedef {object} RecordStepMessage
 * @property {string} type  Always {@link RECORD_STEP}.
 * @property {string} requestId  Recording this step belongs to.
 * @property {string} producerId  Stable for the lifetime of one content-script document.
 * @property {number} sequence  Positive safe integer, monotonic within the producer.
 * @property {RecordStepPayload} step  Captured action.
 *
 * @typedef {object} RecordStopMessage
 * @property {string} type  Always {@link RECORD_STOP}.
 * @property {string} requestId  Recording to stop.
 *
 * @typedef {object} RecordCancelMessage
 * @property {string} type  Always {@link RECORD_CANCEL}.
 * @property {string} requestId  Recording to discard.
 *
 * @typedef {object} RecordFinishMessage
 * @property {string} type  Always {@link RECORD_FINISH}.
 * @property {string} requestId  Recording to finish on a closing page.
 */

export const RECORD_START = 'bb-record-start';
export const RECORD_STEP = 'bb-record-step';
export const RECORD_STOP = 'bb-record-stop';
export const RECORD_CANCEL = 'bb-record-cancel';
export const RECORD_FINISH = 'bb-record-finish';
export const RECORD_QUERY = 'bb-record-query';

/**
 * Validate a start message.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` starts the named recording.
 */
export function isRecordStartMessage(msg) {
  return typeof msg === 'object' && msg !== null && msg.type === RECORD_START && typeof msg.requestId === 'string';
}
/**
 * Validate a stop message.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` stops the named recording.
 */
export function isRecordStopMessage(msg) {
  return typeof msg === 'object' && msg !== null && msg.type === RECORD_STOP && typeof msg.requestId === 'string';
}
/**
 * Validate a cancel message.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` cancels the named recording.
 */
export function isRecordCancelMessage(msg) {
  return typeof msg === 'object' && msg !== null && msg.type === RECORD_CANCEL && typeof msg.requestId === 'string';
}
/**
 * Validate a finish message.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` finishes the named recording.
 */
export function isRecordFinishMessage(msg) {
  return typeof msg === 'object' && msg !== null && msg.type === RECORD_FINISH && typeof msg.requestId === 'string';
}
/**
 * Validate a query message.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` asks for recording state.
 */
export function isRecordQueryMessage(msg) {
  return typeof msg === 'object' && msg !== null && msg.type === RECORD_QUERY;
}
/**
 * Validate a recorded step.
 *
 * Identity fields are checked first: a step without a request id, a non-empty
 * producer id, and a positive safe-integer sequence cannot be acknowledged.
 * Only then is the payload's operation tag inspected, which keeps a malformed
 * envelope from reaching the recorder.
 *
 * @param {unknown} msg  Candidate message.
 * @returns {boolean} True when `msg` is a structurally valid step.
 */
export function isRecordStepMessage(msg) {
  if (typeof msg !== 'object' || msg === null) return false;
  if (
    msg.type !== RECORD_STEP ||
    typeof msg.requestId !== 'string' ||
    typeof msg.producerId !== 'string' ||
    msg.producerId.length === 0 ||
    typeof msg.sequence !== 'number' ||
    !Number.isSafeInteger(msg.sequence) ||
    msg.sequence < 1
  ) return false;
  const step = msg.step;
  return typeof step === 'object' && step !== null && typeof step.op === 'string';
}
/**
 * Whether a step acknowledgement matches the acknowledged sequence.
 *
 * A reply with `ok: true` for a different sequence belongs to a previous step
 * and must not be treated as acceptance of this one.
 *
 * @param {unknown} value  Raw acknowledgement.
 * @param {number} sequence  Sequence that was sent.
 * @returns {boolean} True when the reply accepts exactly this sequence.
 */
export function isAcceptedRecordStepAck(value, sequence) {
  return typeof value === 'object' && value !== null && value.ok === true && value.sequence === sequence;
}
