/**
 * tools/eval/lib/gen.mjs -- deterministic generators for property tests.
 *
 * A generator is a frozen object:
 *   { kind, name, rng(rng) -> value, shrink(value) -> candidates[], contains(value) -> boolean }
 *
 * `rng` draws only from the supplied deterministic stream, so generation is a
 * pure function of (generator, seed). `contains` describes the generator's
 * domain and is used to filter shrink candidates that drifted out of range
 * (for example deleting an element below `minLength`).
 *
 * Composite generators (array / record / oneOf / map / dict) shrink their
 * components with the same composable primitives from `shrink.mjs`, which is
 * what makes minimal counterexamples reachable for nested documents.
 */

import { createRng, normalizeSeed } from './prng.mjs';
import {
  orderCandidates,
  shrinkArray,
  shrinkNumber,
  shrinkRecord,
  shrinkString,
  shrinkTuple,
  stableStringify,
  totalSize,
  unionShrinks,
} from './shrink.mjs';

/** Character pools that cover normal text, refs and parser-hostile bytes. */
export const ALPHABETS = Object.freeze({
  letters: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  alnum: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  whitespace: ' \t',
  ascii: 'abcdefghijklmnopqrstuvwxyz0123456789 -_./:@[]"\'',
  edge: '[]@#:;"\'\\\t 01',
  cjk: '观察节点点击表单协议状态',
  unicode: 'abc观察é漢字',
});

const FALLBACK_CONTAINS = () => true;

function assertGen(gen, label) {
  if (!gen || typeof gen !== 'object' || typeof gen.rng !== 'function') {
    throw new TypeError(label + ' 需要生成器对象');
  }
  return gen;
}

/** Build a frozen generator with an automatic contains-filtered shrinker. */
function makeGen({ kind, name, rng, shrink, contains = FALLBACK_CONTAINS, meta = null }) {
  if (typeof rng !== 'function') throw new TypeError('生成器 ' + name + ' 缺少 rng()');
  const domain = typeof contains === 'function' ? contains : FALLBACK_CONTAINS;
  const rawShrink = typeof shrink === 'function' ? shrink : () => [];
  const shrinker = (value) => {
    if (!domain(value)) return [];
    const cap = totalSize(value);
    const candidates = rawShrink(value);
    return orderCandidates(
      (Array.isArray(candidates) ? candidates : []).filter((candidate) => domain(candidate) && totalSize(candidate) < cap),
      value,
    );
  };
  return Object.freeze({ kind, name, rng, shrink: shrinker, contains: domain, meta });
}

/** Extract the JSON-safe description of a generator for reports. */
export function describeGen(gen) {
  const value = assertGen(gen, 'describeGen');
  return { kind: value.kind, name: value.name };
}

/** Always produces the same value (shrink candidates: none, unless a shrinker is supplied). */
export function constant(value, { shrink } = {}) {
  const key = stableStringify(value);
  return makeGen({
    kind: 'constant',
    name: 'constant(' + key.slice(0, 48) + ')',
    rng: () => value,
    shrink: typeof shrink === 'function' ? shrink : () => [],
    contains: (candidate) => stableStringify(candidate) === key,
  });
}

/** Boolean with an optional probability of `true`. */
export function boolean({ trueWeight = 0.5 } = {}) {
  return makeGen({
    kind: 'boolean',
    name: 'boolean(' + trueWeight + ')',
    rng: (rng) => rng.bool(trueWeight),
    shrink: (value) => (value === true ? [false] : []),
    contains: (value) => typeof value === 'boolean',
  });
}

/** Integer in [min, max]. */
export function integer({ min = -64, max = 64 } = {}) {
  const lo = Math.ceil(Number(min));
  const hi = Math.floor(Number(max));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
    throw new RangeError('integer({min,max}) 区间非法：' + min + '..' + max);
  }
  return makeGen({
    kind: 'integer',
    name: 'integer(' + lo + '..' + hi + ')',
    rng: (rng) => rng.int(lo, hi),
    shrink: (value) => shrinkNumber(value, { min: lo, max: hi, integer: true }),
    contains: (value) => Number.isInteger(value) && value >= lo && value <= hi,
  });
}

/** Non-negative integer in [min, max]. */
export function natural({ min = 0, max = 64 } = {}) {
  return integer({ min: Math.max(0, min), max });
}

/** Float in [min, max] rounded to `precision` decimals. */
export function float({ min = 0, max = 1, precision = 3 } = {}) {
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
    throw new RangeError('float({min,max}) 区间非法：' + min + '..' + max);
  }
  const decimals = Math.max(0, Math.min(9, Math.trunc(precision)));
  const scale = 10 ** decimals;
  return makeGen({
    kind: 'float',
    name: 'float(' + lo + '..' + hi + ',' + decimals + ')',
    rng: (rng) => rng.float(lo, hi, decimals),
    shrink: (value) => shrinkNumber(value, { min: lo, max: hi, integer: false }),
    contains: (value) => typeof value === 'number' && Number.isFinite(value)
      && value >= lo && value <= hi && Math.abs(value * scale - Math.round(value * scale)) < 1e-9,
  });
}

/** One character from an alphabet. */
export function character({ alphabet = ALPHABETS.ascii } = {}) {
  const pool = Array.from(String(alphabet));
  if (!pool.length) throw new RangeError('character({alphabet}) 不能为空');
  const allowed = new Set(pool);
  return makeGen({
    kind: 'character',
    name: 'character(' + pool.join('').slice(0, 16) + ')',
    rng: (rng) => rng.pick(pool),
    shrink: () => [],
    contains: (value) => typeof value === 'string' && Array.from(value).length === 1 && allowed.has(value),
  });
}

/** String of code points from an alphabet. */
export function string({ minLength = 0, maxLength = 12, alphabet = ALPHABETS.ascii } = {}) {
  const floor = Math.max(0, Math.trunc(Number(minLength) || 0));
  const ceiling = Math.max(floor, Math.trunc(Number(maxLength) || 0));
  const pool = Array.from(String(alphabet));
  if (!pool.length) throw new RangeError('string({alphabet}) 不能为空');
  const allowed = new Set(pool);
  const charGen = character({ alphabet });
  return makeGen({
    kind: 'string',
    name: 'string(' + floor + '..' + ceiling + ')',
    rng: (rng) => {
      const length = rng.int(floor, ceiling);
      let out = '';
      for (let index = 0; index < length; index += 1) out += rng.pick(pool);
      return out;
    },
    shrink: (value) => shrinkString(value).filter((candidate) => {
      const chars = Array.from(candidate);
      return chars.length >= floor && chars.length <= ceiling;
    }),
    contains: (value) => {
      if (typeof value !== 'string') return false;
      const chars = Array.from(value);
      if (chars.length < floor || chars.length > ceiling) return false;
      for (const item of chars) if (!allowed.has(item)) return false;
      return true;
    },
    meta: { charGen: describeGen(charGen) },
  });
}

/**
 * Array of values produced by `element`.
 * @param {object} element generator
 * @param {{minLength?: number, maxLength?: number}} [options]
 */
export function array(element, { minLength = 0, maxLength = 6 } = {}) {
  const child = assertGen(element, 'array(element)');
  const floor = Math.max(0, Math.trunc(Number(minLength) || 0));
  const ceiling = Math.max(floor, Math.trunc(Number(maxLength) || 0));
  return makeGen({
    kind: 'array',
    name: 'array(' + child.name + ',' + floor + '..' + ceiling + ')',
    rng: (rng) => {
      const length = rng.int(floor, ceiling);
      const out = [];
      for (let index = 0; index < length; index += 1) out.push(child.rng(rng));
      return out;
    },
    shrink: (value) => shrinkArray(value, child.shrink, { minLength: floor }),
    contains: (value) => {
      if (!Array.isArray(value)) return false;
      if (value.length < floor || value.length > ceiling) return false;
      return value.every((item) => child.contains(item));
    },
  });
}

/** Fixed-length tuple of generators. */
export function tuple(...generators) {
  const gens = generators.flat();
  for (const gen of gens) assertGen(gen, 'tuple(...)');
  return makeGen({
    kind: 'tuple',
    name: 'tuple(' + gens.map((gen) => gen.name).join(',') + ')',
    rng: (rng) => gens.map((gen) => gen.rng(rng)),
    shrink: (value) => shrinkTuple(value, gens.map((gen) => (item) => gen.shrink(item))),
    contains: (value) => Array.isArray(value)
      && value.length === gens.length
      && gens.every((gen, index) => gen.contains(value[index])),
  });
}

/** Record with fixed field generators (JSON object). */
export function record(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('record(spec) 需要对象');
  }
  const keys = Object.keys(spec);
  for (const key of keys) assertGen(spec[key], 'record(spec.' + key + ')');
  const shrinkers = Object.fromEntries(keys.map((key) => [key, (value) => spec[key].shrink(value)]));
  return makeGen({
    kind: 'record',
    name: 'record(' + keys.join(',') + ')',
    rng: (rng) => {
      const out = {};
      for (const key of keys) out[key] = spec[key].rng(rng);
      return out;
    },
    shrink: (value) => shrinkRecord(value, shrinkers),
    contains: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key) && spec[key].contains(value[key])),
  });
}

/**
 * Pick one of several generators (uniform). Alternatives may be generators or
 * `{gen, weight}` objects.
 */
export function oneOf(alternatives) {
  const entries = (Array.isArray(alternatives) ? alternatives : []).map((entry) => {
    if (entry && typeof entry === 'object' && typeof entry.rng === 'function') return { gen: entry, weight: 1 };
    if (entry && entry.gen) return { gen: assertGen(entry.gen, 'oneOf(entry.gen)'), weight: Math.max(0, Number(entry.weight) || 0) };
    throw new TypeError('oneOf 的候选必须是生成器或 {gen,weight}');
  });
  if (!entries.length) throw new RangeError('oneOf 需要至少一个候选');
  const gens = entries.map((entry) => entry.gen);
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0) || entries.length;
  return makeGen({
    kind: 'oneOf',
    name: 'oneOf(' + gens.map((gen) => gen.name).join('|') + ')',
    rng: (rng) => {
      if (entries.every((entry) => entry.weight === 1)) return gens[rng.below(gens.length)].rng(rng);
      return rng.pickWith(entries.map((entry) => ({ value: entry.gen, weight: entry.weight || 1 }))).rng(rng);
    },
    shrink: (value) => unionShrinks(value, gens.map((gen) => gen.shrink)),
    contains: (value) => gens.some((gen) => gen.contains(value)),
    meta: { totalWeight: total },
  });
}

/** Weighted `oneOf` given `[[weight, gen], ...]` pairs. */
export function frequency(pairs) {
  const list = (Array.isArray(pairs) ? pairs : []).map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('frequency 需要 [weight, gen] 对');
    return { weight: Math.max(0, Number(pair[0]) || 0), gen: assertGen(pair[1], 'frequency(gen)') };
  });
  return oneOf(list);
}

/** Map a base generator through a pure projection. */
export function map(base, project, { unproject = null, contains = null } = {}) {
  const child = assertGen(base, 'map(base)');
  if (typeof project !== 'function') throw new TypeError('map(base, project) 需要 project 函数');
  return makeGen({
    kind: 'map',
    name: 'map(' + child.name + ')',
    rng: (rng) => project(child.rng(rng)),
    shrink: (value) => {
      if (typeof unproject !== 'function') return [];
      const source = unproject(value);
      if (!child.contains(source)) return [];
      return child.shrink(source).map((item) => project(item));
    },
    contains: typeof contains === 'function' ? contains : FALLBACK_CONTAINS,
  });
}

/**
 * Rejection-filter a generator with a predicate. Attempts are bounded so an
 * unsatisfiable predicate fails loudly instead of hanging.
 */
export function suchThat(base, predicate, { maxAttempts = 50 } = {}) {
  const child = assertGen(base, 'suchThat(base)');
  if (typeof predicate !== 'function') throw new TypeError('suchThat(base, predicate) 需要 predicate 函数');
  return makeGen({
    kind: 'suchThat',
    name: 'suchThat(' + child.name + ')',
    rng: (rng) => {
      for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
        const value = child.rng(rng);
        if (predicate(value)) return value;
      }
      throw new Error('suchThat 在 ' + maxAttempts + ' 次尝试内没有生成满足谓词的值');
    },
    shrink: (value) => child.shrink(value).filter((candidate) => predicate(candidate)),
    contains: (value) => child.contains(value) && predicate(value),
  });
}

/** `null` or a value from `base` (50/50). */
export function nullable(base, { nullWeight = 0.5 } = {}) {
  const child = assertGen(base, 'nullable(base)');
  return makeGen({
    kind: 'nullable',
    name: 'nullable(' + child.name + ')',
    rng: (rng) => (rng.bool(nullWeight) ? null : child.rng(rng)),
    shrink: (value) => (value === null ? [] : child.shrink(value)),
    contains: (value) => value === null || child.contains(value),
  });
}

/** `undefined` is not JSON-safe; this produces `null` or the base value. */
export function optional(base) {
  return nullable(base, { nullWeight: 0.4 });
}

/** Object with generated unique keys and generated values. */
export function dict(key, value, { minKeys = 0, maxKeys = 4 } = {}) {
  const keyGen = assertGen(key, 'dict(key)');
  const valueGen = assertGen(value, 'dict(value)');
  const floor = Math.max(0, Math.trunc(Number(minKeys) || 0));
  const ceiling = Math.max(floor, Math.trunc(Number(maxKeys) || 0));
  return makeGen({
    kind: 'dict',
    name: 'dict(' + keyGen.name + '=>' + valueGen.name + ',' + floor + '..' + ceiling + ')',
    rng: (rng) => {
      const size = rng.int(floor, ceiling);
      const out = {};
      let guard = 0;
      while (Object.keys(out).length < size && guard < size * 10 + 10) {
        guard += 1;
        const keyValue = keyGen.rng(rng);
        const keyText = typeof keyValue === 'string' ? keyValue : String(keyValue);
        if (Object.prototype.hasOwnProperty.call(out, keyText)) continue;
        out[keyText] = valueGen.rng(rng);
      }
      return out;
    },
    shrink: (current) => {
      const entries = Object.keys(current || {}).map((item) => [item, current[item]]);
      return shrinkArray(entries, (pair) => valueGen.shrink(pair[1]).map((next) => [pair[0], next]), { minLength: floor })
        .map((items) => Object.fromEntries(items));
    },
    contains: (current) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
      const keys = Object.keys(current);
      if (keys.length < floor || keys.length > ceiling) return false;
      return keys.every((item) => keyGen.contains(item) && valueGen.contains(current[item]));
    },
  });
}

/** Recoverable recursive generator (bounded depth) for nested documents. */
export function recursive(leaf, combine, { depth = 3 } = {}) {
  const leafGen = assertGen(leaf, 'recursive(leaf)');
  const maxDepth = Math.max(1, Math.trunc(Number(depth) || 1));
  const build = (level) => {
    if (level <= 0) return leafGen;
    return oneOf([leafGen, combine(build(level - 1))]);
  };
  return build(maxDepth);
}

/** Generate one value from `gen` using `rng`. */
export function generate(gen, rng) {
  return assertGen(gen, 'generate(gen)').rng(rng);
}

/** Shrink one value using `gen` (already ordered + domain-filtered). */
export function shrinkValue(gen, value) {
  return assertGen(gen, 'shrinkValue(gen)').shrink(value);
}

/** Generate `count` samples from a seed (for golden vectors and docs). */
export function sample(gen, { seed = 0, count = 5 } = {}) {
  const rng = createRng(normalizeSeed(seed));
  const out = [];
  for (let index = 0; index < Math.max(0, Math.trunc(Number(count) || 0)); index += 1) {
    out.push(gen.rng(rng));
  }
  return out;
}

/** Size of a generated value (re-exported so corpus code imports one module). */
export { totalSize as sizeOf };
