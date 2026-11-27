/**
 * Application-level heartbeat sent while the post-handshake link is live.
 *
 * A tiny event every 20 seconds does double duty: it resets the worker idle
 * timer that would otherwise evict the background page, and it gives the peer a
 * liveness signal so a silently dead browser can be reaped. The heartbeat runs
 * only after the handshake has landed, because the peer rejects any first frame
 * that is not the handshake; callers wire {@link HeartbeatOptions.onActiveChange}
 * to the connection controller, which only reports active for connected states.
 *
 * @typedef {object} HeartbeatTimers
 * @property {(cb: () => void, ms: number) => number} setInterval  Start a repeating timer.
 * @property {(handle: number) => void} clearInterval  Stop a timer started above.
 *
 * @typedef {object} HeartbeatOptions
 * @property {(frame: { event: string, payload?: unknown }) => void} send
 *   Send one frame over the live transport; may throw if the socket raced a close.
 * @property {(cb: (active: boolean) => void) => () => void} onActiveChange
 *   Subscribe to link liveness. Must invoke the callback immediately with the
 *   current value, again on every transition, and return an unsubscribe function.
 * @property {number} [intervalMs]  Beat interval override, mainly for tests.
 * @property {HeartbeatTimers} [timers]  Timer implementation override for tests.
 *
 * @typedef {object} HeartbeatHandle
 * @property {() => void} dispose  Stop beating and detach the liveness listener.
 * @property {() => void} beatForTest  Emit one heartbeat frame immediately.
 */

export const HEARTBEAT_EVENT = 'system.heartbeat';
/** 20s: comfortably inside the worker idle window. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Build the production timer binding.
 *
 * @returns {HeartbeatTimers} Timers backed by the global timer functions.
 */
function defaultTimers() {
  return {
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

/**
 * Start a heartbeat that beats while the link is active and pauses entirely
 * while it is not.
 *
 * The subscription fires immediately, so an already-connected link starts
 * beating without waiting for the next transition. Repeated `true`
 * notifications are idempotent: a second timer is never created. Send failures
 * are swallowed so the interval keeps ticking — a close notification clears the
 * timer anyway, and the transport's reconnect path owns recovery.
 *
 * @param {HeartbeatOptions} options  Send callback, liveness source and test seams.
 * @returns {HeartbeatHandle} Handle that stops the heartbeat when disposed.
 */
export function startHeartbeat(options) {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const timers = options.timers ?? defaultTimers();
  let timer = null;

  const beat = () => {
    try {
      options.send({ event: HEARTBEAT_EVENT, payload: {} });
    } catch { /* socket raced a close; reconnect handles it */ }
  };

  const stop = () => {
    if (timer !== null) {
      timers.clearInterval(timer);
      timer = null;
    }
  };

  const start = () => {
    if (timer !== null) return;
    timer = timers.setInterval(beat, intervalMs);
  };

  const unsubscribe = options.onActiveChange((active) => {
    if (active) start();
    else stop();
  });

  return {
    dispose: () => {
      unsubscribe();
      stop();
    },
    beatForTest: beat,
  };
}
