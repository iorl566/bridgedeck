import { isAgentControlledTab } from './manager.js';
import { watchPopupFocus } from './popup-focus.js';
import { beginTabCreation } from './tab-creation.js';

const INPUT_WINDOW_MS = 100;
const CANDIDATE_BUDGET_MS = 500;

/** Browser source relationships are not proof of creation by an agent.
 * Only observe a short interval starting at actual click/key dispatch. Same-window
 * targets may be controlled, but are never added to the destructive cleanup set.
 * Cross-window or late targets retain the explicit borrow flow.
 *
 * The observation interval opens on the first dispatched input and is extended
 * only by further dispatches, never by elapsed time from the request start. A
 * target qualifies only when its opener is the same task tab, it lands in the
 * task window, and no other session has claimed it. Claimed tabs are recorded
 * as observed, which grants control without authorizing cleanup: stopping the
 * task releases them but preserves their window.
 *
 * @template T
 * @param {import('./manager.js').SessionManager} manager Session registry.
 * @param {{ session_id?: string, tab_id?: number }} params Request selector.
 * @param {(inputSent: (tabId: number) => void) => Promise<T>} run Task work receiving the input barrier.
 * @param {(tabId: number, windowId: number) => void} [onClaimed] Called for each claimed popup tab.
 * @param {AbortSignal} [signal] Cancels observation and focus recovery.
 * @param {object} [api] Browser tab/window/navigation event surface.
 * @returns {Promise<T>} Result of `run`.
 */
export async function withTaskPopups(manager, params, run, onClaimed, signal, api = globalThis.chrome) {
  const task = params.session_id ? manager.get(params.session_id) : null;
  const targets = api?.webNavigation?.onCreatedNavigationTarget;
  if (!task || !targets || signal?.aborted) return run(() => {});
  const focus = watchPopupFocus(task.agentWindowId, api.windows);
  let observedPopup = false;
  let finishCreation;
  let active = true;
  let listening = false;
  let observationEnded = Promise.resolve();
  let finishObservation = () => {};
  let timer;
  const invalid = new Set();
  const candidates = new Map();
  const live = () => active && !signal?.aborted && manager.get(task.sessionId) === task && !manager.isWindowCloseExpected(task);
  const validSource = async (id) => {
    if (!live() || invalid.has(id) || (task.remote && !isAgentControlledTab(task, id))) return false;
    try {
      const tab = await api.tabs.get(id);
      return live() && !invalid.has(id) && tab.windowId === task.agentWindowId && (!task.remote || isAgentControlledTab(task, id));
    } catch { return false; }
  };
  const created = ({ sourceTabId, sourceFrameId, tabId }) => {
    const parent = candidates.get(sourceTabId);
    if (!live() || !listening || sourceFrameId !== 0 || !parent || candidates.has(tabId)) return;
    const work = Promise.resolve().then(async () => {
      if (!(await parent) || !(await validSource(sourceTabId))) return false;
      const tab = await api.tabs.get(tabId);
      if (!(await validSource(sourceTabId)) || invalid.has(tabId) || tab.windowId !== task.agentWindowId || manager.findBorrowingSession(tabId, task.sessionId) || manager.findControllingSession(tabId)) return false;
      // Non-destructive authority: stop releases this tab and preserves its window.
      (task.observedTabs ??= new Set()).add(tabId);
      observedPopup = true;
      onClaimed?.(tabId, tab.windowId);
      return true;
    }).catch((error) => {
      console.warn('[bb] popup observation failed', error);
      return false;
    });
    candidates.set(tabId, work);
  };
  const stopListening = () => {
    listening = false;
    clearTimeout(timer);
    targets.removeListener(created);
    finishObservation();
  };
  const invalidate = (id) => invalid.add(id);
  const abort = () => {
    active = false;
    stopListening();
    api.tabs.onRemoved?.removeListener(invalidate);
    api.tabs.onDetached?.removeListener(invalidate);
  };
  const inputSent = (tabId) => {
    if (!live()) return;
    if (params.tab_id !== undefined && tabId !== params.tab_id) return;
    focus.arm();
    finishCreation ??= beginTabCreation(task);
    candidates.set(tabId, Promise.resolve(true));
    if (!listening) {
      observationEnded = new Promise((resolve) => { finishObservation = resolve; });
      targets.addListener(created);
    }
    listening = true;
    clearTimeout(timer);
    timer = setTimeout(stopListening, INPUT_WINDOW_MS);
  };
  api.tabs.onRemoved?.addListener(invalidate);
  api.tabs.onDetached?.addListener(invalidate);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await run(inputSent);
  } finally {
    // Browser may deliver navigation-target events after the input response.
    await observationEnded;
    stopListening();
    await settleOrExpire(Promise.all(candidates.values()), signal);
    await focus.finish(() => observedPopup && live());
    active = false;
    signal?.removeEventListener('abort', abort);
    api.tabs.onRemoved?.removeListener(invalidate);
    api.tabs.onDetached?.removeListener(invalidate);
    finishCreation?.();
  }
}

/**
 * Wait for candidate checks, but never longer than the observation budget.
 *
 * An abort releases the wait immediately, since a cancelled task must not
 * delay teardown.
 *
 * @param {Promise<unknown>} work Pending candidate checks.
 * @param {AbortSignal} [signal] Cancellation for the surrounding task.
 * @returns {Promise<void>} Resolves on settlement, budget expiry or abort.
 */
async function settleOrExpire(work, signal) {
  if (signal?.aborted) return;
  let abort = () => {};
  let timer;
  try {
    await Promise.race([
      work,
      new Promise((resolve) => {
        abort = resolve;
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(resolve, CANDIDATE_BUDGET_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
