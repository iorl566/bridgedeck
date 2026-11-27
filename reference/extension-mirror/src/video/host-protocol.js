/**
 * Wire contract between the extension host and the offscreen encoder.
 *
 * Data shapes referenced below (`StoredVideo`, `VideoStopReason`) are declared
 * in ./types.js; the bare names in these contracts refer to those declarations.
 *
 * @typedef {'navigation' | 'interactive' | 'clean'} VideoSuspension
 *
 * @typedef {(
 *   { action: 'start', recording: StoredVideo, image: string }
 *   | { action: 'frame', recording_id: string, image: string, elapsed_ms: number }
 *   | { action: 'suspend', recording_id: string, mode: VideoSuspension, label: string }
 *   | { action: 'stop', recording_id: string, reason: VideoStopReason }
 *   | { action: 'recover', recording_id: string, reason?: VideoStopReason }
 *   | { action: 'download_url', recording_id: string }
 *   | { action: 'revoke_url', url: string }
 *   | { action: 'idle' }
 * )} VideoHostCommand
 *
 * @typedef {object} VideoHostReply
 * @property {string} id Correlates one reply with its request.
 * @property {unknown} [result] Command-specific payload on success.
 * @property {{ code: string, message: string, data?: object }} [error] Serialized failure.
 *
 * @typedef {object} VideoHost
 * @property {(command: VideoHostCommand) => Promise<unknown>} request
 *   Send one command and resolve with its result.
 * @property {() => Promise<void>} closeWhenIdle
 *   Release the offscreen document once no command or download URL is pending.
 */

/**
 * Build the request envelope posted to the encoder worker.
 *
 * @param {string} id Correlates the eventual reply.
 * @param {VideoHostCommand} command
 * @returns {{ id: string, command: VideoHostCommand }}
 */
export function hostRequest(id, command) {
  return { id, command };
}

/**
 * Validate and unwrap an encoder reply, normalizing failures to one shape.
 *
 * @param {unknown} reply
 * @returns {{ id: string, result?: unknown,
 *   error?: { code: string, message: string, data?: object } }}
 */
export function parseHostReply(reply) {
  if (!reply || typeof reply !== 'object' || typeof reply.id !== 'string') throw new Error('Invalid video host reply');
  if (reply.error) return { id: reply.id, error: { code: reply.error.code ?? 'cdp_failed', message: reply.error.message ?? String(reply.error), ...(reply.error.data ? { data: reply.error.data } : {}) } };
  return { id: reply.id, result: reply.result };
}

/**
 * Report whether a command can be retried after the port disconnected.
 *
 * @param {string} action Host command action name.
 * @returns {boolean} True for cleanup and recovery commands only.
 */
export function isIdempotentHostAction(action) {
  return ['stop', 'recover', 'idle', 'revoke_url'].includes(action);
}
