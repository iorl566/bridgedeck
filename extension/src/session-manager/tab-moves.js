/**
 * One explicitly issued tab move.
 * @typedef {object} ExpectedTabMove
 * @property {number} tabId Moved tab.
 * @property {number} fromWindowId Origin window.
 * @property {number} toWindowId Destination window.
 *
 * @typedef {ExpectedTabMove & { detached: boolean, resolve?: (expected: boolean) => void }} MoveOperation
 *   A move whose single detach/attach pair has not settled yet.
 */

/**
 * Match one browser detach/attach pair to one explicitly issued tab move.
 *
 * The tracker never treats user gestures as expected. Only an operation the
 * extension is currently awaiting can authorize a window change, so a drag the
 * user starts later still ends the session.
 */
export class ExpectedTabMoves {
  constructor() {
    this.operations = new Map();
    this.detached = new Map();
  }

  /**
   * @template T
   * @param {ExpectedTabMove} move Move being issued.
   * @param {() => Promise<T>} action Browser move call.
   * @returns {Promise<T>} Result of `action`.
   */
  async run(move, action) {
    // Reordering in the same window does not generate detach/attach events.
    if (move.fromWindowId === move.toWindowId) return action();
    const operation = { ...move, detached: false };
    const operations = this.operations.get(move.tabId) ?? new Set();
    operations.add(operation);
    this.operations.set(move.tabId, operations);
    try {
      return await action();
    } catch (error) {
      this.finish(operation, false);
      throw error;
    }
  }

  /**
   * @param {number} tabId Detached tab.
   * @param {number} oldWindowId Window the browser detached it from.
   * @returns {boolean | Promise<boolean>} False when no move owns this detach; otherwise the match result.
   */
  onDetached(tabId, oldWindowId) {
    const candidates = [...(this.operations.get(tabId) ?? [])].filter((operation) => !operation.detached && operation.fromWindowId === oldWindowId);
    // Concurrent moves with the same origin cannot be attributed safely.
    const operation = candidates.length === 1 ? candidates[0] : undefined;
    if (!operation) {
      // An unrelated move makes any unused snapshot for this tab stale.
      for (const candidate of this.operations.get(tabId) ?? []) {
        if (!candidate.detached) this.finish(candidate, false);
      }
    }
    const queue = this.detached.get(tabId) ?? [];
    queue.push(operation);
    this.detached.set(tabId, queue);
    if (!operation) return false;
    operation.detached = true;
    return new Promise((resolve) => { operation.resolve = resolve; });
  }

  /**
   * @param {number} tabId Attached tab.
   * @param {number} newWindowId Window the browser attached it to.
   */
  onAttached(tabId, newWindowId) {
    const queue = this.detached.get(tabId);
    if (!queue) return;
    const operation = queue.shift();
    if (!queue.length) this.detached.delete(tabId);
    if (operation) this.finish(operation, operation.toWindowId === newWindowId);
  }

  /** @param {number} tabId Closed or forgotten tab. */
  forget(tabId) {
    for (const operation of this.operations.get(tabId) ?? []) this.finish(operation, false);
    this.detached.delete(tabId);
  }

  /** Forget every tracked move without waiting for its events.
   *
   * Used when listeners are disposed: pending waiters resolve as unexpected so
   * teardown never hangs on an event that will no longer be delivered.
   */
  clear() {
    for (const tabId of this.operations.keys()) this.forget(tabId);
    this.detached.clear();
  }

  finish(operation, expected) {
    const operations = this.operations.get(operation.tabId);
    operations?.delete(operation);
    if (!operations?.size) this.operations.delete(operation.tabId);
    operation.resolve?.(expected);
    operation.resolve = undefined;
  }
}

/** Process-wide move tracker shared by the session event handlers. */
export const expectedTabMoves = new ExpectedTabMoves();
