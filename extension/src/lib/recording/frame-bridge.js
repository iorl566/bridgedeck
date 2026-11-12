/**
 * Frame port protocol for distributed recording.
 *
 * @typedef {object} RecordFrameQueryMessage
 * @property {string} type
 *
 * @typedef {object} RecordFrameQueryResponse
 * @property {boolean} active
 * @property {string} [requestId]
 * @property {number} [startedAtMs]
 *
 * @typedef {object} RecordFrameStartMessage
 * @property {string} type
 * @property {string} requestId
 * @property {number} startedAtMs
 *
 * @typedef {{ type: 'ready', requestId: string, producerId: string }
 *   | { type: 'ready_ack', requestId: string, producerId: string }
 *   | { type: 'stop', requestId: string, commandId: string }
 *   | { type: 'cancel', requestId: string }
 *   | { type: 'stopped', requestId: string, commandId: string, ok: boolean, error?: string }} RecordFramePortMessage
 */

export const RECORD_FRAME_PORT = 'bb-record-frame';
export const RECORD_FRAME_QUERY = 'bb-record-frame-query';
export const RECORD_FRAME_START = 'bb-record-frame-start';

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRecordFrameQueryMessage(value) {
  return typeof value === 'object' && value !== null && value.type === RECORD_FRAME_QUERY;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRecordFrameStartMessage(value) {
  if (typeof value !== 'object' || value === null) return false;
  return value.type === RECORD_FRAME_START && typeof value.requestId === 'string' && typeof value.startedAtMs === 'number';
}
