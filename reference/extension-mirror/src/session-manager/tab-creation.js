/**
 * Track tab creation that the browser may report before its API reply returns.
 *
 * A creation is registered synchronously before the browser call so an early
 * tab event can wait for the claim instead of treating a future tab as a user
 * action. The pending set is keyed by session context, which keeps concurrent
 * tasks independent and lets a released task stop being waited on.
 */
const pending = new WeakMap();

/** Browser can emit tab events before returning the ids we are about to claim.
 *
 * @param {import('./manager.js').SessionContext} task Session whose tab creation is starting.
 * @returns {() => void} Idempotent release for this operation.
 */
export function beginTabCreation(task) {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const operations = pending.get(task) ?? new Set();
  pending.set(task, operations);
  operations.add(done);
  return () => {
    operations.delete(done);
    finish();
  };
}

/**
 * Wait until no tab creation is pending for a session.
 *
 * Resolves immediately for a session with no in-flight creation, and waits for
 * every operation registered at call time. New operations registered after the
 * wait starts are intentionally not awaited, so a completing creation cannot
 * be blocked by the next one that starts.
 *
 * @param {import('./manager.js').SessionContext} task Session whose tab events must settle.
 * @returns {Promise<void>} Resolves when no creation is pending for the task.
 */
export async function waitForTabCreation(task) {
  const operations = pending.get(task);
  while (operations?.size) await Promise.all(operations);
}
