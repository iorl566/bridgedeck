/**
 * Content-script side of the capture-suppress bridge: hides the overlay
 * shadow host while the background captures a screenshot.
 *
 * `begin` sets the hidden attribute on the host and only acks after two
 * animation frames, so the compositor has produced a frame without the
 * overlay. `end` is reference-counted so overlapping captures do not unhide
 * the host early.
 */
/** Hidden attribute mirrored onto the overlay host while a capture runs. */
export const CAPTURE_HIDDEN_ATTR = 'data-bb-capture-hidden';
/** Message type of the capture-suppress bridge. */
export const CAPTURE_SUPPRESS = 'bb/capture-suppress';

/**
 * Content-side capture suppression.
 *
 * `pendingCount` is the number of in-flight `begin` phases. `handleMessage`
 * returns true when the ack is asynchronous, which keeps the message channel
 * open until the frames have been produced.
 *
 * @typedef {object} CaptureSuppressController
 * @property {number} pendingCount In-flight `begin` phases; read-only.
 * @property {(message: import('../lib/capture-suppress-bridge.js').CaptureSuppressMessage, sendResponse: (ack: import('../lib/capture-suppress-bridge.js').CaptureSuppressAck) => void) => boolean} handleMessage
 * Handle one bridge message; true when the ack is asynchronous.
 * @property {(host: Element) => void} onHostMounted Re-apply the hidden attribute when the host is rebuilt.
 */

const FRAME_FALLBACK_MS = 500;

/**
 * Resolve after one animation frame, with a timeout fallback for hidden tabs
 * where animation frames never fire. The attribute is already set when this is
 * called, so the fallback only bounds the wait.
 *
 * @returns {Promise<void>}
 */
function nextFrame() {
  return new Promise((resolve) => {
    const raf = requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      cancelAnimationFrame(raf);
      resolve();
    }, FRAME_FALLBACK_MS);
  });
}

/**
 * @param {() => (Element | null)} getHost Resolves the overlay host to hide.
 * @param {{ nextFrame?: () => Promise<void> }} [deps]
 * @returns {CaptureSuppressController}
 */
export function createCaptureSuppressController(getHost, deps = {}) {
  let pending = 0;
  /** @type {() => Promise<void>} Frame waiter, injectable for tests. */
  const frame = deps.nextFrame ?? nextFrame;
  /** @type {import('../lib/capture-suppress-bridge.js').CaptureSuppressAck} Reused success ack. */
  const ack = { type: CAPTURE_SUPPRESS, ok: true };

  /**
   * Mirror the hidden attribute onto the current host.
   *
   * @param {Element | null} host
   * @param {boolean} hidden
   * @returns {void}
   */
  function setHidden(host, hidden) {
    if (!host) return;
    if (hidden) host.setAttribute(CAPTURE_HIDDEN_ATTR, '');
    else host.removeAttribute(CAPTURE_HIDDEN_ATTR);
  }

  return {
    get pendingCount() {
      return pending;
    },
    handleMessage(message, sendResponse) {
      if (message.phase === 'begin') {
        pending += 1;
        setHidden(getHost(), true);
        void (async () => {
          await frame();
          await frame();
          sendResponse(ack);
        })();
        return true;
      }
      pending = Math.max(0, pending - 1);
      if (pending === 0) setHidden(getHost(), false);
      sendResponse(ack);
      return false;
    },
    onHostMounted(host) {
      setHidden(host, pending > 0);
    },
  };
}
