/**
 * tools/eval/lib/assert.mjs -- assertion helpers whose failure messages are
 * deterministic and directly usable as counterexample evidence.
 *
 * All helpers throw `EvalAssertionError` with:
 *   - code:     'E_EVAL_ASSERT' (or a caller-supplied code)
 *   - message:  deterministic text (no timestamps, no absolute paths)
 *   - expected / actual: JSON-safe values
 *   - evidence: optional extra structure (ids, counts, source locations)
 *
 * Property checks should throw these; the runner treats any thrown error as a
 * failure and shrinks against it.
 */

import { stableStringify, totalSize } from './shrink.mjs';

export const ASSERTION_CODE = 'E_EVAL_ASSERT';

/** Deep clone / JSON-safe projection used by evidence payloads. */
export function evidenceOf(value) {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  } catch {
    return { unserializable: true, type: typeof value };
  }
}

export class EvalAssertionError extends Error {
  constructor(message, { expected = null, actual = null, evidence = null, code = ASSERTION_CODE } = {}) {
    super(String(message));
    this.name = 'EvalAssertionError';
    this.code = code;
    this.expected = evidenceOf(expected);
    this.actual = evidenceOf(actual);
    this.evidence = evidenceOf(evidence);
  }
}

/** Unconditional failure. */
export function fail(message, options = {}) {
  throw new EvalAssertionError(message, options);
}

/** Truthiness assertion (strict: only `true` passes; use assertTruthy for truthy). */
export function assert(condition, message, options = {}) {
  if (!condition) fail(message, options);
  return condition;
}

/** Truthy assertion (allows non-boolean predicates). */
export function assertTruthy(value, message, options = {}) {
  if (!value) fail(message, { ...options, actual: value });
  return value;
}

/** Object.is equality. */
export function assertEqual(actual, expected, message, options = {}) {
  if (!Object.is(actual, expected)) {
    fail(message, { ...options, expected, actual });
  }
  return actual;
}

/** NaN-aware number equality. */
export function assertNumber(actual, expected, message, options = {}) {
  const bothNaN = Number.isNaN(actual) && Number.isNaN(expected);
  if (!bothNaN && actual !== expected) fail(message, { ...options, expected, actual });
  return actual;
}

/** Deep structural equality with stable JSON ordering. */
export function assertDeepEqual(actual, expected, message, options = {}) {
  if (stableStringify(actual) !== stableStringify(expected)) {
    fail(message, { ...options, expected, actual });
  }
  return actual;
}

export function assertNotEqual(actual, forbidden, message, options = {}) {
  if (Object.is(actual, forbidden)) fail(message, { ...options, expected: '!==' + stableStringify(forbidden), actual });
  return actual;
}

export function assertMatch(text, pattern, message, options = {}) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
  if (!re.test(String(text))) fail(message, { ...options, expected: String(re), actual: text });
  return text;
}

export function assertIncludes(list, value, message, options = {}) {
  if (!Array.isArray(list) || !list.includes(value)) {
    fail(message, { ...options, expected: 'contains ' + stableStringify(value), actual: list });
  }
  return value;
}

/** Alias with list-first argument order, matching the corpus call sites. */
export function assertIn(list, value, message, options = {}) {
  return assertIncludes(list, value, message, options);
}

export function assertSubset(subset, superset, message, options = {}) {
  const allowed = new Set(Array.isArray(superset) ? superset : []);
  const extra = (Array.isArray(subset) ? subset : []).filter((item) => !allowed.has(item));
  if (extra.length) fail(message, { ...options, expected: 'subset', actual: extra });
  return subset;
}

/** Finite number in [min, max]. */
export function assertBetween(value, min, max, message, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(message, { ...options, expected: '[' + min + ', ' + max + ']', actual: value });
  }
  return value;
}

/** All array items unique by stable serialization. */
export function assertUnique(list, message, options = {}) {
  const items = Array.isArray(list) ? list : [];
  const seen = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const key = stableStringify(items[index]);
    if (seen.has(key)) {
      fail(message, { ...options, expected: 'unique items', actual: { duplicate: items[index], first: seen.get(key), index } });
    }
    seen.set(key, index);
  }
  return items;
}

/** Comparator result must be <= 0 for every adjacent pair (sorted non-decreasing). */
export function assertOrdered(list, compare, message, options = {}) {
  const items = Array.isArray(list) ? list : [];
  for (let index = 1; index < items.length; index += 1) {
    const order = compare(items[index - 1], items[index]);
    if (!(order <= 0)) {
      fail(message, { ...options, expected: 'non-decreasing', actual: { index, left: items[index - 1], right: items[index], order } });
    }
  }
  return items;
}

/** Two disjoint id sets whose union is the input (gate partition invariant). */
export function assertPartition(kept, dropped, input, message, options = {}) {
  const keptIds = new Set((kept || []).map((item) => (item && item.id !== undefined ? item.id : item)));
  const droppedIds = new Set((dropped || []).map((item) => (item && item.id !== undefined ? item.id : item)));
  const inputIds = new Set((input || []).map((item) => (item && item.id !== undefined ? item.id : item)));
  for (const id of keptIds) {
    if (!inputIds.has(id)) fail(message + '：保留项不在输入里', { ...options, actual: id });
  }
  for (const id of droppedIds) {
    if (!inputIds.has(id)) fail(message + '：丢弃项不在输入里', { ...options, actual: id });
    if (keptIds.has(id)) fail(message + '：同一项既保留又丢弃', { ...options, actual: id });
  }
  if (keptIds.size + droppedIds.size !== inputIds.size) {
    fail(message + '：保留 + 丢弃 != 输入', {
      ...options,
      expected: inputIds.size,
      actual: { kept: keptIds.size, dropped: droppedIds.size },
    });
  }
  return { kept: keptIds.size, dropped: droppedIds.size };
}

/** Value round-trips through JSON unchanged (report-safe). */
export function assertJsonSafe(value, message, options = {}) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    fail(message, { ...options, expected: 'JSON.stringify ok', actual: String(error && error.message) });
  }
  if (text === undefined) fail(message, { ...options, expected: 'JSON value', actual: typeof value });
  const roundTrip = JSON.parse(text);
  if (stableStringify(roundTrip) !== stableStringify(value)) {
    fail(message + '：JSON 往返不一致', { ...options, actual: value });
  }
  return value;
}

/** Assert that `fn` throws and that the error matches `code` (when provided). */
export function assertThrows(fn, code, message, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('assertThrows(fn) 需要函数');
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!thrown) fail(message || '期望抛错但没有抛', { ...options, expected: code || 'throw', actual: 'no error' });
  if (code !== undefined && code !== null && thrown.code !== code) {
    fail(message || '抛出的错误码不符', { ...options, expected: code, actual: thrown.code || 'E_' + thrown.name });
  }
  return thrown;
}

/** Non-throwing check used inside property predicates. */
export function isDeepEqual(actual, expected) {
  return stableStringify(actual) === stableStringify(expected);
}

/** Size of a value as reported in failure rows. */
export function valueSize(value) {
  return totalSize(value);
}

/** Build a failure row from a plain condition; returns boolean for compact checks. */
export function invariant(condition, label, evidence) {
  if (!condition) throw new EvalAssertionError(label, { evidence });
  return true;
}

/** Collect the first `limit` differences between two arrays of strings (reports). */
export function firstDiff(left, right, limit = 3) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max && out.length < limit; index += 1) {
    if (stableStringify(a[index]) !== stableStringify(b[index])) {
      out.push({ index, left: a[index] === undefined ? null : a[index], right: b[index] === undefined ? null : b[index] });
    }
  }
  return out;
}
