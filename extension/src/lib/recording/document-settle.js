/**
 * Wait until the recorded document stops mutating.
 *
 * @typedef {object} DocumentSettleScope
 * @property {object} target
 * @property {string} [frameId]
 *
 * @typedef {'quiet' | 'timeout' | 'cancelled'} SettleOutcome
 *
 * @typedef {object} DocumentSettleOptions
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} DocumentSettleDeps
 * @property {(target: object, method: string, params: object) => Promise<any>} send
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 * @property {() => number} [now]
 */

const SETTLE_MIN_MS = 150;
const SETTLE_QUIET_MS = 250;
const SETTLE_MAX_MS = 2_000;
const SETTLE_POLL_MS = 60;
const SETTLE_WORLD_NAME = '__bb_record_settle__';

const QUIET_PROBE = `(() => {
  const scope = window;
  let probe = scope.__bbRecordQuiet;
  if (!probe) {
    probe = { changedAt: Date.now() };
    const observer = new MutationObserver(() => { probe.changedAt = Date.now(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    scope.__bbRecordQuiet = probe;
  }
  return { idleMs: Date.now() - probe.changedAt, readyState: document.readyState };
})()`;

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * @param {(target: object, method: string, params: object) => Promise<any>} send
 * @param {DocumentSettleScope} scope
 * @returns {Promise<number | undefined>}
 */
async function executionContextForScope(send, scope) {
  if (!scope.frameId) return undefined;
  const result = await send(scope.target, 'Page.createIsolatedWorld', { frameId: scope.frameId, worldName: SETTLE_WORLD_NAME, grantUniversalAccess: false });
  return result.executionContextId;
}

/**
 * @param {(target: object, method: string, params: object) => Promise<any>} send
 * @param {DocumentSettleScope} scope
 * @param {{ executionContextId?: number }} context
 * @returns {Promise<{ idleMs: number, readyState: string } | null>}
 */
async function readQuietProbe(send, scope, context) {
  try {
    if (scope.frameId && context.executionContextId === undefined) {
      context.executionContextId = await executionContextForScope(send, scope);
      if (context.executionContextId === undefined) return null;
    }
    const reply = await send(scope.target, 'Runtime.evaluate', {
      expression: QUIET_PROBE,
      returnByValue: true,
      ...(context.executionContextId !== undefined ? { contextId: context.executionContextId } : {}),
    });
    const value = reply.result?.value;
    if (!value || typeof value !== 'object') return null;
    if (typeof value.idleMs !== 'number' || typeof value.readyState !== 'string') return null;
    return { idleMs: value.idleMs, readyState: value.readyState };
  } catch {
    context.executionContextId = undefined;
    return null;
  }
}

/**
 * @param {object} cdp
 * @param {DocumentSettleScope} scope
 * @param {DocumentSettleOptions} [options]
 * @param {DocumentSettleDeps} deps
 * @returns {Promise<SettleOutcome>}
 */
export async function waitForDocumentSettled(cdp, scope, options = {}, deps = {}) {
  const send = deps.send;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const floor = startedAt + SETTLE_MIN_MS;
  const deadline = startedAt + SETTLE_MAX_MS;
  const context = {};
  for (;;) {
    if (options.signal?.aborted) return 'cancelled';
    await sleep(SETTLE_POLL_MS, options.signal);
    if (options.signal?.aborted) return 'cancelled';
    const probe = await readQuietProbe(send, scope, context);
    const current = now();
    if (current < floor) continue;
    if (current >= deadline) return 'timeout';
    if (!probe || probe.readyState === 'loading') continue;
    if (probe.idleMs >= SETTLE_QUIET_MS) return 'quiet';
  }
}
