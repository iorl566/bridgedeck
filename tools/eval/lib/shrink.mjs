/**
 * tools/eval/lib/shrink.mjs -- deterministic shrinking primitives.
 *
 * Shrinking is what turns "the property failed on this 30-line document" into
 * "the property failed on these 2 lines". The design here is deliberately
 * simple and fully deterministic:
 *
 *   - every shrinker maps a value to a FINITE, ordered list of strictly
 *     smaller candidates;
 *   - `greedyShrink` repeatedly takes the first candidate that still fails and
 *     restarts, so the result is a 1-minimal counterexample: no single shrink
 *     candidate of the result still fails (verified by `measureMinimality`);
 *   - candidate order is by total size then stable serialization, never by
 *     hash-map iteration order, so two runs always shrink identically;
 *   - the shrinker never grows a value; if a candidate's size is larger than
 *     the current value it is skipped by the driver.
 *
 * The report always carries the ORIGINAL generated value and the MINIMAL
 * counterexample, so a bug can be reproduced from either one.
 */

const MAX_ARRAY_ELEMENT_SHRINKS = 8;
const MAX_CANDIDATES_PER_STEP = 96;

/** Stable JSON with object keys sorted recursively (used for dedupe + reports). */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
  return out;
}

/** JSON-safe clone of a generated value (objects only, no cycles expected). */
export function cloneValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Total structural size of a value. Used to decide whether a shrink candidate
 * is actually smaller. Numbers contribute their absolute value, strings their
 * code-unit length, containers their length plus children.
 */
export function totalSize(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.abs(value) : 1e9;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return Array.from(value).length;
  if (Array.isArray(value)) {
    let total = value.length;
    for (const item of value) total += totalSize(item);
    return total;
  }
  if (typeof value === 'object') {
    let total = Object.keys(value).length;
    for (const key of Object.keys(value)) total += totalSize(value[key]);
    return total;
  }
  return 1;
}

/** Comparator: negative when `left` is structurally smaller than `right`. */
export function compareSize(left, right) {
  return totalSize(left) - totalSize(right);
}

function candidateKey(value) {
  return stableStringify(value);
}

/**
 * Deduplicate candidate values, drop the current value, and sort by size.
 * Deterministic tie-break: stable serialization.
 */
export function orderCandidates(candidates, current, { maxCandidates = MAX_CANDIDATES_PER_STEP } = {}) {
  const currentKey = candidateKey(current);
  const seen = new Set([currentKey]);
  const out = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (candidate === undefined) continue;
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  out.sort((left, right) => {
    const sizeDelta = totalSize(left) - totalSize(right);
    if (sizeDelta) return sizeDelta;
    return candidateKey(left) < candidateKey(right) ? -1 : candidateKey(left) > candidateKey(right) ? 1 : 0;
  });
  const limit = Math.max(0, Math.trunc(Number(maxCandidates) || MAX_CANDIDATES_PER_STEP));
  return out.slice(0, limit);
}

function clampIntegerCandidate(value, min, max) {
  if (!Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  if (integer < min || integer > max) return null;
  return integer;
}

const pushUniqueRaw = (out, seen, value) => {
  if (value === undefined || value === null) return;
  const key = typeof value + ':' + String(value);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(value);
};

/** Shrink an integer / float toward 0 (and toward its declared minimum). */
export function shrinkNumber(value, { min = -1_000_000, max = 1_000_000, integer = Number.isInteger(value) } = {}) {
  const total = Number(value);
  const lo = Number.isFinite(Number(min)) ? Number(min) : -1_000_000;
  const hi = Number.isFinite(Number(max)) ? Number(max) : 1_000_000;
  const raw = [];
  const seen = new Set();
  if (integer) {
    const push = (candidate) => {
      const clamped = clampIntegerCandidate(candidate, Math.ceil(lo), Math.floor(hi));
      if (clamped === null || clamped === Math.trunc(total)) return;
      // Never emit a candidate that grows the value: a shrinker that can grow
      // makes greedy shrinking non-terminating or non-monotone.
      if (total !== 0 && Math.abs(clamped) >= Math.abs(total)) return;
      pushUniqueRaw(raw, seen, clamped);
    };
    push(0);
    push(Math.ceil(lo));
    // Unit steps toward zero first: predicates like "odd" or "negative" then
    // shrink to the smallest witness (1 / -1) instead of stalling at the draw.
    if (total !== 0) push(total > 0 ? 1 : -1);
    push(Math.trunc(total / 2));
    if (total !== 0) push(total > 0 ? total - 1 : total + 1);
    push(Math.trunc((total + Math.ceil(lo)) / 2));
  } else {
    const push = (candidate) => {
      const rounded = Math.round(candidate * 1000) / 1000;
      if (!Number.isFinite(rounded) || rounded < lo || rounded > hi || rounded === total) return;
      if (total !== 0 && Math.abs(rounded) >= Math.abs(total)) return;
      pushUniqueRaw(raw, seen, rounded);
    };
    push(0);
    push(lo);
    push(total / 2);
    if (total !== 0) push(total - (total >= 0 ? 0.001 : -0.001));
  }
  return orderCandidates(raw, total);
}

/** Shrink a string by deleting characters / halves. Unicode code points are kept intact. */
export function shrinkString(value, { maxCandidates = 64 } = {}) {
  const text = String(value);
  const chars = Array.from(text);
  if (!chars.length) return [];
  const raw = [];
  const seen = new Set();
  const push = (candidate) => pushUniqueRaw(raw, seen, candidate);
  push('');
  const half = Math.floor(chars.length / 2);
  push(chars.slice(0, half).join(''));
  push(chars.slice(half).join(''));
  push(chars.slice(1).join(''));
  push(chars.slice(0, -1).join(''));
  const removalLimit = Math.min(chars.length, Math.max(0, maxCandidates - 5));
  for (let index = chars.length - 1; index >= chars.length - removalLimit && index >= 0; index -= 1) {
    push(chars.slice(0, index).join('') + chars.slice(index + 1).join(''));
  }
  return orderCandidates(raw, text, { maxCandidates });
}

/**
 * Shrink an array.
 * @param {unknown[]} value
 * @param {(value: unknown) => unknown[]} [shrinkElement]
 * @param {{minLength?: number, maxCandidates?: number}} [options]
 */
export function shrinkArray(value, shrinkElement, { minLength = 0, maxCandidates = MAX_CANDIDATES_PER_STEP } = {}) {
  const list = Array.isArray(value) ? value : [];
  const floor = Math.max(0, Math.trunc(Number(minLength) || 0));
  if (list.length <= floor) {
    // At the lower bound we can still shrink elements in place.
    const rawElements = [];
    const limit = Math.min(list.length, MAX_ARRAY_ELEMENT_SHRINKS);
    for (let index = 0; index < limit; index += 1) {
      if (typeof shrinkElement !== 'function') continue;
      for (const candidate of shrinkElement(list[index]) || []) {
        const next = list.slice();
        next[index] = candidate;
        rawElements.push(next);
      }
    }
    return orderCandidates(rawElements, list, { maxCandidates });
  }
  const raw = [];
  const seen = new Set();
  const push = (candidate) => {
    if (!Array.isArray(candidate) || candidate.length < floor) return;
    pushUniqueRaw(raw, seen, candidate);
  };
  push([]);
  const half = Math.floor(list.length / 2);
  push(list.slice(0, half));
  push(list.slice(half));
  push(list.slice(0, -1));
  push(list.slice(1));
  const removalLimit = Math.min(list.length, 24);
  for (let index = list.length - 1; index >= list.length - removalLimit && index >= 0; index -= 1) {
    push(list.slice(0, index).concat(list.slice(index + 1)));
  }
  if (typeof shrinkElement === 'function') {
    const elementLimit = Math.min(list.length, MAX_ARRAY_ELEMENT_SHRINKS);
    for (let index = 0; index < elementLimit; index += 1) {
      const shrinks = shrinkElement(list[index]);
      let used = 0;
      for (const candidate of shrinks || []) {
        if (used >= 4) break;
        const next = list.slice();
        next[index] = candidate;
        push(next);
        used += 1;
      }
    }
  }
  return orderCandidates(raw, list, { maxCandidates });
}

/** Shrink a tuple by shrinking one component at a time. */
export function shrinkTuple(values, shrinkers, { maxCandidates = MAX_CANDIDATES_PER_STEP } = {}) {
  const list = Array.isArray(values) ? values : [];
  const raw = [];
  for (let index = 0; index < list.length; index += 1) {
    const shrinker = shrinkers[index];
    if (typeof shrinker !== 'function') continue;
    for (const candidate of shrinker(list[index]) || []) {
      const next = list.slice();
      next[index] = candidate;
      raw.push(next);
    }
  }
  return orderCandidates(raw, list, { maxCandidates });
}

/** Shrink a record by shrinking one field at a time (field order = spec order). */
export function shrinkRecord(value, shrinkers, { maxCandidates = MAX_CANDIDATES_PER_STEP } = {}) {
  const current = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const raw = [];
  for (const key of Object.keys(shrinkers || {})) {
    const shrinker = shrinkers[key];
    if (typeof shrinker !== 'function') continue;
    if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
    for (const candidate of shrinker(current[key]) || []) {
      raw.push({ ...current, [key]: candidate });
    }
  }
  return orderCandidates(raw, current, { maxCandidates });
}

/** Union of several shrinkers (used by oneOf / frequency). */
export function unionShrinks(value, shrinkers, { maxCandidates = MAX_CANDIDATES_PER_STEP } = {}) {
  const raw = [];
  for (const shrinker of shrinkers || []) {
    if (typeof shrinker !== 'function') continue;
    for (const candidate of shrinker(value) || []) raw.push(candidate);
  }
  return orderCandidates(raw, value, { maxCandidates });
}

/**
 * Greedy deterministic shrink driver.
 *
 * @param {{
 *   value: unknown,
 *   fails: (candidate: unknown) => boolean | Promise<boolean>,
 *   shrink: (value: unknown) => unknown[],
 *   maxSteps?: number,
 *   maxCandidates?: number,
 *   keepGrowing?: boolean,
 * }} options
 * @returns {Promise<{minimal: unknown, steps: Array<{from: unknown, to: unknown}>, tested: number, accepted: number}>}
 */
export async function greedyShrink({ value, fails, shrink, maxSteps = 256, maxCandidates = MAX_CANDIDATES_PER_STEP, keepGrowing = false }) {
  if (typeof fails !== 'function') throw new TypeError('greedyShrink 需要 fails(candidate) 函数');
  if (typeof shrink !== 'function') throw new TypeError('greedyShrink 需要 shrink(value) 函数');
  let current = value;
  const steps = [];
  let tested = 0;
  const stepLimit = Math.max(0, Math.trunc(Number(maxSteps) || 0));
  for (let step = 0; step < stepLimit; step += 1) {
    let candidates;
    try {
      candidates = orderCandidates(shrink(current) || [], current, { maxCandidates });
    } catch {
      break;
    }
    let next = null;
    for (const candidate of candidates) {
      tested += 1;
      if (!keepGrowing && totalSize(candidate) > totalSize(current)) continue;
      let failed = false;
      try {
        failed = (await fails(candidate)) === true;
      } catch {
        // A checker that throws for a candidate is still a failure signal; the
        // property runner wraps assertions so this is the expected path.
        failed = true;
      }
      if (failed) {
        next = candidate;
        break;
      }
    }
    if (next === null) break;
    steps.push({ from: cloneValue(current), to: cloneValue(next) });
    current = next;
  }
  return { minimal: current, steps, tested, accepted: steps.length };
}

/**
 * Verify 1-minimality: no single shrink candidate of `value` fails and is
 * strictly smaller. Returns the offending candidate when minimality is broken.
 */
export async function measureMinimality({ value, fails, shrink, maxCandidates = MAX_CANDIDATES_PER_STEP }) {
  const candidates = orderCandidates(shrink(value) || [], value, { maxCandidates });
  const tested = [];
  for (const candidate of candidates) {
    if (totalSize(candidate) >= totalSize(value)) continue;
    let failed = false;
    try {
      failed = (await fails(candidate)) === true;
    } catch {
      failed = true;
    }
    tested.push({ candidate, failed });
    if (failed) return { minimal: false, candidate, tested: tested.length };
  }
  return { minimal: true, candidate: null, tested: tested.length };
}

/** Size summary used in reports / failure rows. */
export function sizeSummary(value) {
  return {
    size: totalSize(value),
    json: stableStringify(value),
  };
}
