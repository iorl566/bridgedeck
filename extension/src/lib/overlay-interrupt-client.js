import { OVERLAY_MSG_INTERRUPT } from './overlay-bridge.js';

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * @typedef {object} SendInterruptOptions
 * @property {number} [timeoutMs]  Soft deadline in milliseconds; defaults to 2000.
 */

/**
 * @typedef {object} OverlayInterruptResponse
 * @property {boolean} ok  True only when the background explicitly acknowledged.
 */

/**
 * Round-trip an overlay interrupt message to the background worker.
 *
 * Only an explicit ok reply counts as success; timeout, throw and undefined
 * reply all collapse to a failed result so the caller can take the same
 * retract-and-retry path regardless of cause. The short soft timeout keeps the
 * mask from staying on screen while an unreachable peer is contacted; the
 * cancellation itself is fire-and-forget once sent, so a slow acknowledgement
 * does not invalidate it.
 *
 * @param {(msg: { kind: string, sessionId: string }) => Promise<unknown>} sendMessage
 *   Sends the interrupt request and resolves with the background's reply.
 * @param {string} sessionId  Session whose active operation should be interrupted.
 * @param {SendInterruptOptions} [options]  Timeout override.
 * @returns {Promise<OverlayInterruptResponse>} Acknowledgement, never rejects.
 */
export async function sendInterrupt(sendMessage, sessionId, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const req = { kind: OVERLAY_MSG_INTERRUPT, sessionId };
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
  const send = (async () => {
    try {
      const reply = await sendMessage(req);
      return reply?.ok === true ? { ok: true } : { ok: false };
    } catch {
      return { ok: false };
    }
  })();
  const result = await Promise.race([send, timeout]);
  if (timer !== null) clearTimeout(timer);
  return result;
}
