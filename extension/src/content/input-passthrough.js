import { INPUT_PASSTHROUGH, INPUT_PASSTHROUGH_ATTR, INPUT_PASSTHROUGH_TTL_MS } from '../lib/input-passthrough-bridge.js';

/**
 * Click-only input passthrough.
 *
 * Whitelisted leases temporarily let the page receive pointer hits while an
 * overlay host stays visible. Each lease has a fixed TTL, so a lost `end`
 * cannot leave the page unreachable.
 *
 * @typedef {object} InputPassthroughLease
 * @property {number} expiresAt Epoch ms when the lease expires.
 * @property {ReturnType<typeof setTimeout>} timer Safety timeout that releases the lease.
 *
 * @typedef {object} InputPassthroughController
 * @property {number} pendingCount Active leases; read-only.
 * @property {(message: import('../lib/input-passthrough-bridge.js').InputPassthroughMessage, sendResponse: (ack: import('../lib/input-passthrough-bridge.js').InputPassthroughAck) => void) => false} handleMessage
 * Begin or end one lease and sync the host attribute.
 * @property {() => void} reset Drop every lease, for teardown.
 * @property {(host: Element | null) => void} onHostMounted Re-apply the attribute when the host is rebuilt.
 */

/**
 * @param {() => (Element | null)} getHost Resolves the overlay host to toggle.
 * @param {{ now?: () => number }} [deps]
 * @returns {InputPassthroughController}
 */
export function createInputPassthroughController(getHost, deps = {}) {
  const now = deps.now ?? Date.now;
  const pending = new Map();
  /** @param {string} id */
  const release = (id) => {
    const lease = pending.get(id);
    if (lease) clearTimeout(lease.timer);
    pending.delete(id);
  };
  /** Drop expired leases before syncing, then mirror the active count onto the host. */
  const apply = (host) => {
    // A suspended page can resume/remount before overdue timers run.
    for (const [id, lease] of pending) if (lease.expiresAt <= now()) release(id);
    host?.toggleAttribute(INPUT_PASSTHROUGH_ATTR, pending.size > 0);
  };

  return {
    get pendingCount() {
      return pending.size;
    },
    handleMessage(message, sendResponse) {
      if (message.phase === 'begin') {
        // A repeated begin keeps the original TTL rather than extending it.
        if (!pending.has(message.id)) {
          pending.set(message.id, {
            expiresAt: now() + INPUT_PASSTHROUGH_TTL_MS,
            timer: setTimeout(() => {
              release(message.id);
              apply(getHost());
            }, INPUT_PASSTHROUGH_TTL_MS),
          });
        }
      } else {
        release(message.id);
      }
      apply(getHost());
      // Hit testing uses current styles; unlike screenshots it needs no compositor frame.
      sendResponse({ type: INPUT_PASSTHROUGH, ok: true });
      return false;
    },
    reset() {
      for (const id of pending.keys()) release(id);
      apply(getHost());
    },
    onHostMounted: apply,
  };
}
