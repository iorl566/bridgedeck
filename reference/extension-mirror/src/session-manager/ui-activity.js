import { isAgentControlledTab } from './manager.js';

/**
 * Task-scoped UI failure carrying a transport error code.
 * @typedef {object} UiErrorResult
 * @property {string} code Transport error code.
 * @property {string} message Human-readable failure.
 * @property {{ reason?: string }} [data] Optional machine-readable reason.
 *
 * @typedef {object} UiActivity
 * @property {number} stopping Incremented while a whole-session stop runs.
 * @property {Map<number, number>} returning Per-tab counters for tabs being returned.
 * @property {Set<UiOperation>} operations UI operations still allowed to finish.
 * @property {Map<Promise<unknown>, number>} mutations Issued browser mutations by tab.
 * @property {WeakSet<Promise<unknown>>} graced Mutations already given their grace period.
 */

/** Task-scoped UI failure that maps onto a transport error reply. */
export class UiTaskError extends Error {
  /**
   * @param {string} code Transport error code.
   * @param {string} message Human-readable failure.
   * @param {string} [reason] Machine-readable reason.
   */
  constructor(code, message, reason) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

/**
 * @param {unknown} error Failure raised by UI work.
 * @returns {UiErrorResult} Transport-shaped error reply.
 */
export function uiError(error) {
  if (error instanceof UiTaskError) return { code: error.code, message: error.message, data: { reason: error.reason } };
  return { code: 'cdp_failed', message: error instanceof Error ? error.message : String(error) };
}

/** Per-task activity records; a released task's record is collected with it. */
const activities = new WeakMap();

/** Lazily create the activity record used by capture and teardown.
 * @param {import('./manager.js').SessionContext} task Session owning the record.
 * @returns {UiActivity} Mutable activity record for the task.
 */
function activity(task) {
  let state = activities.get(task);
  if (!state) {
    state = { stopping: 0, returning: new Map(), operations: new Set(), mutations: new Map(), graced: new WeakSet() };
    activities.set(task, state);
  }
  return state;
}

/**
 * @typedef {object} UiOperation
 * @property {AbortSignal} signal
 * @property {number} [tabId]
 * @property {() => void} check
 * @property {() => void} abort
 * @property {<T>(tabId: number, run: () => Promise<T>) => Promise<T>} mutate
 */

/** A budget for the whole UI request, including target lookup and image encoding.
 *
 * The operation is registered before any browser work starts, so a teardown
 * that begins meanwhile can abort it.
 *
 * @template T
 * @param {import('./manager.js').SessionManager} manager Session registry.
 * @param {string} sessionId Session running the UI request.
 * @param {(op: UiOperation, task: import('./manager.js').SessionContext) => Promise<T>} run Reply work.
 * @returns {Promise<T>} Result of `run`.
 */
export function runTaskUi(manager, sessionId, run) {
  const task = manager.get(sessionId);
  if (!task?.remote) return Promise.reject(new UiTaskError('not_found', 'Task unavailable', 'task_unavailable'));
  const state = activity(task);
  const controller = new AbortController();
  const op = {
    signal: controller.signal,
    check() {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (manager.get(sessionId) !== task) throw new UiTaskError('not_found', 'Task ended during capture', 'task_unavailable');
      if (state.stopping || (op.tabId !== undefined && state.returning.has(op.tabId))) throw new UiTaskError('cancelled', 'Task is stopping or tab is returning', 'task_stopping');
    },
    abort() {
      controller.abort(new UiTaskError('cancelled', 'Task is stopping or tab is returning', 'task_stopping'));
    },
    mutate(tabId, action) {
      op.check();
      const pending = Promise.resolve().then(() => { op.check(); return action(); });
      state.mutations.set(pending, tabId);
      void pending.then(() => state.mutations.delete(pending), () => state.mutations.delete(pending));
      return pending;
    },
  };
  try { op.check(); } catch (error) { return Promise.reject(error); }
  state.operations.add(op);
  let aborted;
  const stop = new Promise((_, reject) => {
    aborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', aborted, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new UiTaskError('timeout', 'Preview or focus timed out after 3000ms', 'ui_deadline')), 3000);
  const work = Promise.resolve().then(() => { op.check(); return run(op, task); });
  return Promise.race([work, stop]).finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', aborted);
    state.operations.delete(op);
  });
}

/** Used at the actual return boundary, including automatic return and rollback.
 * Never wait for unbounded image/CDP work. Late work is invalidated first.
 *
 * A tab return only aborts operations that target that tab; a whole-session
 * stop aborts every operation. Issued browser mutations get one bounded grace
 * period and are then considered graced, so a later teardown for the same tab
 * does not wait on the same work twice.
 *
 * @template T
 * @param {import('./manager.js').SessionContext} task Session being torn down.
 * @param {number} [tabId] Tab returning to the user; omitted for a whole-session stop.
 * @param {() => Promise<T>} run Cleanup work.
 * @returns {Promise<T | UiErrorResult>} Cleanup result, or a UI error reply.
 */
export async function withUiTeardown(task, tabId, run) {
  if (!task.remote) return run();
  const state = activity(task);
  if (tabId === undefined) state.stopping += 1;
  else state.returning.set(tabId, (state.returning.get(tabId) ?? 0) + 1);
  for (const op of state.operations) {
    if (tabId === undefined || op.tabId === undefined || op.tabId === tabId) op.abort();
  }
  let timer;
  try {
    const pending = [...state.mutations]
      .filter(([p, id]) => !state.graced.has(p) && (tabId === undefined || id === tabId))
      .map(([p]) => p);
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => { timer = setTimeout(resolve, 1000); })]);
    for (const p of pending) state.graced.add(p);
    clearTimeout(timer);
    return await run();
  } catch (error) {
    if (error instanceof UiTaskError) return uiError(error);
    throw error;
  } finally {
    clearTimeout(timer);
    if (tabId === undefined) state.stopping -= 1;
    else {
      const remaining = (state.returning.get(tabId) ?? 1) - 1;
      if (remaining) state.returning.set(tabId, remaining);
      else state.returning.delete(tabId);
    }
  }
}

/**
 * Resolve a tab only while the task still owns it and still points at it.
 *
 * Ownership is rechecked after the lookup because the browser may have
 * returned a tab while a user move or a session stop was completing, and an
 * operation must not act on a page the task no longer owns.
 *
 * @param {import('./manager.js').SessionContext} task Session that must still own the tab.
 * @param {UiOperation} op Current UI operation.
 * @param {number} tabId Tab being targeted.
 * @param {object} [tabs] Browser tab query surface.
 * @returns {Promise<object>} Resolved tab, after ownership and window checks.
 */
export async function checkedUiTab(task, op, tabId, tabs = globalThis.chrome?.tabs) {
  op.tabId = tabId;
  op.check();
  if (!isAgentControlledTab(task, tabId)) throw new UiTaskError('not_found', 'Task ended during capture', 'target_unavailable');
  let tab;
  try {
    tab = await tabs.get(tabId);
  } catch (error) {
    op.check();
    throw new UiTaskError('cdp_failed', error instanceof Error ? error.message : 'Task tab lookup failed', 'ui_lookup_failed');
  }
  op.check();
  if (tab.id !== tabId || tab.windowId !== task.agentWindowId || !isAgentControlledTab(task, tabId)) throw new UiTaskError('not_found', 'Task ended during capture', 'target_unavailable');
  return tab;
}
