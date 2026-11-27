/**
 * tools/eval/lib/prng.mjs -- deterministic pseudo-random kernel for the
 * property-testing runner.
 *
 * Contract:
 *   - every value is derived from an explicit 32-bit seed; no wall clock, no
 *     `Math.random`, no ambient entropy;
 *   - the same seed always produces the same stream on every supported Node
 *     version (only 32-bit integer arithmetic + `Math.imul` is used);
 *   - sub-streams (`fork`) are derived from (seed, draw counter, label) so a
 *     generator can branch without depending on iteration order of unrelated
 *     values;
 *   - seeds may be written as decimal, `0x...` hex, or arbitrary text (hashed
 *     with FNV-1a), which keeps CLI usage friendly without weakening
 *     reproducibility.
 *
 * The generator is mulberry32: a small, well-known 32-bit state PRNG. It is
 * NOT suitable for cryptography and is only used to drive test inputs.
 */

export const PRNG_ALGORITHM = 'mulberry32';

/** Default corpus seed. Pinned so `--check` is reproducible without arguments. */
export const DEFAULT_SEED = 0x0b12d6e5;

const UINT32_RANGE = 0x100000000;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** True when `value` is an integer in the uint32 range. */
export function isUint32(value) {
  return Number.isInteger(value) && value >= 0 && value < UINT32_RANGE;
}

/** FNV-1a 32-bit hash of a string (UTF-16 code units, matching the seed parser). */
export function fnv1a32(text, basis = FNV_OFFSET_BASIS) {
  const input = String(text);
  let hash = basis >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    if (input.charCodeAt(index) > 0xff) {
      // Fold the high byte of non-Latin-1 code units so CJK seeds stay distinct.
      hash ^= (input.charCodeAt(index) >>> 8) & 0xff;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
  }
  return hash >>> 0;
}

/**
 * Normalize a seed from CLI / JSON / tests into a uint32.
 * Accepts numbers (including negatives / bigints), decimal and hex strings,
 * and arbitrary labels (hashed). Empty input maps to DEFAULT_SEED.
 */
export function normalizeSeed(input) {
  if (input === undefined || input === null || input === '') return DEFAULT_SEED;
  if (typeof input === 'bigint') return Number(BigInt.asUintN(32, input));
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError('seed 必须是有限数字或字符串：' + String(input));
    return Math.trunc(input) >>> 0;
  }
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return DEFAULT_SEED;
    if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text.slice(2), 16) >>> 0;
    if (/^[0-9]+$/.test(text)) {
      const parsed = Number(text);
      if (!Number.isSafeInteger(parsed)) throw new TypeError('seed 超出安全整数范围：' + text);
      return parsed >>> 0;
    }
    return fnv1a32(text);
  }
  throw new TypeError('不支持的 seed 类型：' + typeof input);
}

/** Hash an arbitrary JSON-ish value into a uint32 (stable across key order via sort). */
export function hashValue(value) {
  if (value === undefined || value === null) return 0x9e3779b9;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fnv1a32(String(value));
    return (Math.trunc(value) ^ Math.trunc((value - Math.trunc(value)) * 0x10000)) >>> 0;
  }
  if (typeof value === 'boolean') return value ? 0x7f4a7c15 : 0x165667b1;
  if (typeof value === 'string') return fnv1a32(value);
  if (typeof value === 'bigint') return Number(BigInt.asUintN(32, value));
  if (Array.isArray(value)) {
    let hash = 0x27d4eb2f;
    for (const item of value) hash = mix32(hash, hashValue(item));
    return hash;
  }
  if (typeof value === 'object') {
    let hash = 0x165667b1;
    for (const key of Object.keys(value).sort()) {
      hash = mix32(hash, fnv1a32(key), hashValue(value[key]));
    }
    return hash;
  }
  return fnv1a32(String(value));
}

/**
 * Fold any number of parts into one uint32. Commutative only when the caller
 * feeds a stable order; the fold itself is order-sensitive (a,b) != (b,a).
 */
export function mix32(...parts) {
  let hash = 0x243f6a88;
  for (const part of parts) {
    const piece = typeof part === 'number' && isUint32(part) ? part : hashValue(part);
    hash = Math.imul(hash ^ piece, 0x85ebca6b) >>> 0;
    hash = ((hash << 13) | (hash >>> 19)) >>> 0;
    hash = (hash + 0xc2b2ae35) >>> 0;
    hash ^= hash >>> 16;
  }
  return hash >>> 0;
}

/** Derive a sub-seed from a base seed plus any labels. */
export function deriveSeed(seed, ...labels) {
  return mix32(normalizeSeed(seed), ...labels);
}

/** Derive the seed of one property case: stable in (seed, propertyId, caseIndex). */
export function caseSeed(seed, propertyId, caseIndex) {
  return mix32(normalizeSeed(seed), fnv1a32(String(propertyId)), Math.trunc(caseIndex) >>> 0);
}

/**
 * Create a deterministic RNG stream.
 * @param {number|string} seed
 * @returns {{
 *   readonly seed: number,
 *   nextUint32: () => number,
 *   nextUint8: () => number,
 *   nextFloat: () => number,
 *   bool: (probability?: number) => boolean,
 *   below: (bound: number) => number,
 *   int: (min: number, max: number) => number,
 *   float: (min: number, max: number, precision?: number) => number,
 *   pick: <T>(items: readonly T[]) => T,
 *   pickWith: <T>(items: readonly {value: T, weight: number}[]) => T,
 *   shuffle: <T>(items: readonly T[]) => T[],
 *   sample: <T>(items: readonly T[], count: number) => T[],
 *   string: (length: number, alphabet: string) => string,
 *   hex: (length: number) => string,
 *   fork: (label: string) => object,
 *   draws: () => number,
 *   snapshot: () => {algorithm: string, seed: number, state: number, draws: number},
 * }}
 */
export function createRng(seed) {
  const initial = normalizeSeed(seed);
  let state = initial | 0;
  let drawCount = 0;

  function nextUint32() {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    drawCount += 1;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Unbiased-enough bounded draw using rejection (deterministic, no floats). */
  function below(bound) {
    const size = Math.trunc(bound);
    if (!Number.isFinite(size) || size <= 0) {
      throw new RangeError('below(bound) 需要正整数，收到：' + String(bound));
    }
    if (size === 1) return 0;
    if (size > UINT32_RANGE) throw new RangeError('below(bound) 超出 uint32 范围：' + size);
    const threshold = UINT32_RANGE - (UINT32_RANGE % size);
    for (;;) {
      const draw = nextUint32();
      if (draw < threshold) return draw % size;
    }
  }

  function nextFloat() {
    return nextUint32() / UINT32_RANGE;
  }

  function bool(probability = 0.5) {
    const p = Number(probability);
    if (!Number.isFinite(p) || p <= 0) return false;
    if (p >= 1) return true;
    return nextFloat() < p;
  }

  function int(min, max) {
    const lo = Math.ceil(Number(min));
    const hi = Math.floor(Number(max));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new RangeError('int(min,max) 需要有限数字');
    if (lo > hi) throw new RangeError('int(min,max) 空区间：' + lo + ' > ' + hi);
    return lo + below(hi - lo + 1);
  }

  function float(min, max, precision = 3) {
    const lo = Number(min);
    const hi = Number(max);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new RangeError('float(min,max) 需要有限数字');
    if (lo > hi) throw new RangeError('float(min,max) 空区间：' + lo + ' > ' + hi);
    const decimals = Math.max(0, Math.min(9, Math.trunc(precision)));
    const scale = 10 ** decimals;
    const raw = lo + nextFloat() * (hi - lo);
    const rounded = Math.round(raw * scale) / scale;
    return Math.min(hi, Math.max(lo, rounded));
  }

  function pick(items) {
    if (!Array.isArray(items)) throw new TypeError('pick(items) 需要数组');
    if (!items.length) throw new RangeError('pick(items) 空数组');
    return items[below(items.length)];
  }

  function pickWith(weighted) {
    if (!Array.isArray(weighted) || !weighted.length) {
      throw new RangeError('pickWith(weighted) 需要非空数组');
    }
    let total = 0;
    for (const entry of weighted) {
      const weight = Number(entry && entry.weight);
      if (!Number.isFinite(weight) || weight < 0) throw new RangeError('pickWith 权重必须是非负有限数');
      total += weight;
    }
    if (!(total > 0)) throw new RangeError('pickWith 权重总和必须 > 0');
    let cursor = nextFloat() * total;
    let last = weighted[weighted.length - 1];
    for (const entry of weighted) {
      cursor -= Number(entry.weight);
      if (cursor <= 0) return entry.value;
      last = entry;
    }
    return last.value;
  }

  function shuffle(items) {
    if (!Array.isArray(items)) throw new TypeError('shuffle(items) 需要数组');
    const copy = items.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = below(index + 1);
      const temp = copy[index];
      copy[index] = copy[swapIndex];
      copy[swapIndex] = temp;
    }
    return copy;
  }

  function sample(items, count) {
    if (!Array.isArray(items)) throw new TypeError('sample(items,count) 需要数组');
    const wanted = Math.max(0, Math.min(Math.trunc(Number(count) || 0), items.length));
    return shuffle(items).slice(0, wanted);
  }

  function string(length, alphabet) {
    const size = Math.max(0, Math.trunc(Number(length) || 0));
    const chars = String(alphabet === undefined || alphabet === null ? 'abcdefghijklmnopqrstuvwxyz' : alphabet);
    if (!chars.length) throw new RangeError('string() alphabet 不能为空');
    const pool = Array.from(chars);
    let out = '';
    for (let index = 0; index < size; index += 1) out += pool[below(pool.length)];
    return out;
  }

  function hex(length) {
    return string(length, '0123456789abcdef');
  }

  function fork(label) {
    return createRng(mix32(initial, drawCount, fnv1a32(String(label))));
  }

  const rng = {
    seed: initial,
    nextUint32,
    nextUint8: () => nextUint32() & 0xff,
    nextFloat,
    bool,
    below,
    int,
    float,
    pick,
    pickWith,
    shuffle,
    sample,
    string,
    hex,
    fork,
    draws: () => drawCount,
    snapshot: () => ({ algorithm: PRNG_ALGORITHM, seed: initial, state: state >>> 0, draws: drawCount }),
  };
  return Object.freeze(rng);
}

/** Convenience: draw `count` uint32 values from a seed (used by tests/vectors). */
export function drawUint32(seed, count) {
  const rng = createRng(seed);
  const out = [];
  for (let index = 0; index < Math.max(0, Math.trunc(Number(count) || 0)); index += 1) out.push(rng.nextUint32());
  return out;
}

/** Create `count` independent streams derived from one seed. */
export function spawnRngs(seed, count, label = 'spawn') {
  const base = normalizeSeed(seed);
  const out = [];
  for (let index = 0; index < Math.max(0, Math.trunc(Number(count) || 0)); index += 1) {
    out.push(createRng(mix32(base, index, fnv1a32(label))));
  }
  return out;
}
