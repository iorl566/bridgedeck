/**
 * Ordered versions for overlay state and reset messages.
 *
 * Overlay state travels asynchronously to the page, so the page needs a total
 * order over the messages it receives. A version is a pair: `epoch` names one
 * worker instance and `generation` counts messages within that instance. A page
 * that kept the previous instance's counter must treat an epoch change as newer
 * instead of comparing generations, which would make a restarted worker look
 * stale.
 *
 * @typedef {object} OverlayVersion
 * @property {string} epoch  Unique per worker instance (a random UUID by default).
 * @property {number} generation  Monotonically increasing within `epoch`.
 */

/**
 * Create a version source for one worker instance, so a restarted worker's
 * counter is distinguishable from the old one.
 *
 * Each call returns a new, order-increasing version. The source is independent
 * of any other source, so tests can create isolated sequences without touching
 * the module singleton.
 *
 * @param {string} [epoch]  Instance name; defaults to a fresh random UUID.
 * @returns {() => OverlayVersion} Allocator returning strictly increasing versions.
 */
export function createOverlayVersionSource(epoch = crypto.randomUUID()) {
  let generation = 0;
  return () => {
    generation += 1;
    return { epoch, generation };
  };
}

/** Singleton version source for this worker instance. */
const next = createOverlayVersionSource();
export const nextOverlayVersion = next;
