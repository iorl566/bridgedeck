/**
 * tools/eval/lib/harness.mjs -- deterministic fixtures shared by the invariant
 * corpus: manual clocks, deferred promises, queue drivers and ledger readers.
 *
 * Everything here is intentionally synchronous / microtask-only. No timers, no
 * wall clock, no I/O: a property that needs "time" advances an injected clock,
 * and a property that needs concurrency uses manually-resolved promises. That
 * is what keeps shrinking sound (a counterexample can be replayed in-process)
 * and the whole gate independent of machine speed.
 */

import { stableStringify } from './shrink.mjs';
import { IntentLedger, createMemoryLedgerStorage } from '../../../lib/intent-ledger.mjs';

/** Yield to the microtask queue enough turns for chained promises to settle. */
export async function flushMicrotasks(turns = 8) {
  const count = Math.max(1, Math.trunc(Number(turns) || 1));
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

/** A promise whose resolution is controlled by the test (deterministic). */
export function createDeferred(label = 'deferred') {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return Object.freeze({
    label,
    promise,
    resolve: (value) => resolve(value),
    reject: (error) => reject(error),
  });
}

/**
 * Manual clock: `now()` is what product code sees, `advance(ms)` moves it.
 * @param {number} [start]
 */
export function createManualClock(start = 1700000000000) {
  let current = Number(start);
  let advances = 0;
  const clock = {
    now: () => current,
    advance: (ms = 1) => {
      const delta = Number(ms);
      if (!Number.isFinite(delta)) throw new TypeError('clock.advance 需要有限数字');
      current += delta;
      advances += 1;
      return current;
    },
    set: (value) => {
      current = Number(value);
      return current;
    },
    value: () => current,
    advances: () => advances,
    iso: () => new Date(current).toISOString(),
  };
  return Object.freeze(clock);
}

/** JSON clone that keeps `undefined` out of reports. */
export function jsonClone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

/** Stable key for a value (sorted object keys). */
export function stableKey(value) {
  return stableStringify(value);
}

/** Run a synchronous factory, capturing `{ok, code, value}` instead of throwing. */
export function captureCode(fn) {
  try {
    return { ok: true, code: null, value: fn() };
  } catch (error) {
    return { ok: false, code: error && error.code ? String(error.code) : null, value: null, message: String((error && error.message) || error) };
  }
}

/** Extract `[id, ...]` arrays from a list of objects. */
export function idsOf(items, key = 'id') {
  return (Array.isArray(items) ? items : []).map((item) => (item && item[key] !== undefined ? item[key] : item));
}

/** Set difference helper for report strings. */
export function difference(left, right) {
  const other = new Set(right || []);
  return (left || []).filter((item) => !other.has(item));
}

/**
 * Session queue driver: capacity + per-session ordered tasks whose completion
 * is controlled by the property. `submit()` never blocks; `plan` describes what
 * each task does once released.
 */
export function createQueueHarness(createSessionQueue, { capacity = 4 } = {}) {
  const queue = createSessionQueue({ capacity });
  const tasks = [];
  const order = [];
  let sequence = 0;

  function submit(sessionId, { tag = null, succeed = true, value = null, hold = true } = {}) {
    sequence += 1;
    const token = {
      index: sequence - 1,
      sessionId: String(sessionId),
      tag,
      succeed,
      value,
      deferred: createDeferred('task-' + sequence),
      released: false,
      settled: false,
      started: false,
    };
    tasks.push(token);
    const promise = queue.enqueue(sessionId, async () => {
      token.started = true;
      order.push(token.tag === null ? token.index : token.tag);
      if (hold) await token.deferred.promise;
      token.settled = true;
      if (!token.succeed) throw new Error('task-failed:' + (token.tag === null ? token.index : token.tag));
      return token.value === null ? token.index : token.value;
    });
    // Avoid unhandled rejections when a caller intentionally tests failures.
    const guarded = promise.then(
      (result) => ({ ok: true, result, index: token.index }),
      (error) => ({ ok: false, error: error && error.code ? String(error.code) : 'E_TASK', message: String((error && error.message) || error), index: token.index }),
    );
    token.promise = guarded;
    return token;
  }

  async function release(token) {
    if (!token.released) {
      token.released = true;
      token.deferred.resolve(token.value);
    }
    await flushMicrotasks();
    return token.promise;
  }

  async function releaseAll() {
    for (const token of tasks) if (!token.settled && !token.released) token.deferred.resolve(token.value);
    await flushMicrotasks(24);
  }

  async function settle() {
    await releaseAll();
    const settled = [];
    for (const token of tasks) settled.push(await token.promise);
    return settled;
  }

  return Object.freeze({
    queue,
    capacity: queue.capacity,
    tasks,
    order,
    submit,
    release,
    releaseAll,
    settle,
    snapshot: () => queue.snapshot(),
    drop: (sessionId) => queue.drop(sessionId),
  });
}

/**
 * Intent ledger harness with an injected clock and in-memory WAL storage.
 * Always calls `flush()` before assertions so pending snapshot writes are
 * settled synchronously (the ledger debounces settlements with a 25ms timer).
 */
export function createLedgerHarness({ start = 1700000000000, staleMs = 15_000, maxEntries = 300 } = {}) {
  const clock = createManualClock(start);
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({
    storage,
    staleMs,
    maxEntries,
    now: clock.now,
    fsync: false,
  });
  return Object.freeze({
    ledger,
    storage,
    clock,
    flush: () => ledger.flush(),
    walText: () => storage.readWalRaw(),
    walFrames: () => parseWalFrames(storage.readWalRaw()),
    snapshotEntries: () => {
      const raw = storage.snapshotText();
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.entries) ? parsed.entries : [];
      } catch {
        return [];
      }
    },
    begin: (method, params = {}, target = {}) => ledger.begin(method, params, target),
    finish: (entry, outcome) => ledger.finish(entry, outcome),
    flushStats: () => ledger.stats(),
  });
}

/** Parse the raw WAL text into `{line, frame, error}` records (test-side view). */
export function parseWalFrames(rawText) {
  const text = String(rawText || '');
  const out = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      out.push({ line: index + 1, frame: JSON.parse(line), error: null });
    } catch (error) {
      out.push({ line: index + 1, frame: null, error: String((error && error.message) || error) });
    }
  }
  return out;
}

/**
 * Extract a ledger entry by id from whichever collection is passed.
 * Returns a deterministic JSON-safe projection (random ids are kept out of
 * assertion targets, so properties never depend on them).
 */
export function ledgerEntryProjection(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    state: entry.state,
    method: entry.method,
    tabId: entry.tabId === undefined ? null : entry.tabId,
    sessionId: entry.sessionId === undefined ? null : entry.sessionId,
    keys: Array.isArray(entry.keys) ? entry.keys.slice() : [],
    target: entry.target === undefined ? null : entry.target,
    nonIdempotent: entry.nonIdempotent === true,
    replayBlocked: entry.replayBlocked === true,
    recovered: entry.recovered === true,
    outcome: entry.outcome === undefined ? null : entry.outcome,
  };
}

/** Deterministically release every pending promise of a harness (defensive). */
export async function settleAll(harness) {
  if (harness && typeof harness.releaseAll === 'function') await harness.releaseAll();
}
