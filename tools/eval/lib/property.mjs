/**
 * tools/eval/lib/property.mjs -- the property-testing engine.
 *
 * A property is a pure predicate over generated values:
 *
 *   defineProperty({
 *     id: 'diff/apply-roundtrip',
 *     area: 'observe-diff',
 *     gen: record({ before: lines, after: lines }),
 *     consumes: [{ file: 'lib/observation-delta.mjs', symbol: 'diffObservation' }],
 *     check: (value) => { ... throw on violation ... return true; },
 *   })
 *
 * Engine guarantees:
 *   - every case value is a pure function of (corpus seed, property id, case
 *     index); checks get a per-value deterministic rng derived from the value;
 *   - failures are shrunk with the generator's own shrinker to a 1-minimal
 *     counterexample, and minimality is re-verified before it is reported;
 *   - error payloads contain only deterministic fields (name/code/message/
 *     expected/actual/evidence) -- never stacks, timings, or absolute paths;
 *   - `replayCounterexample` regenerates a reported case from its seed and
 *     asserts it still fails, which is what makes a reported bug actionable.
 */

import { createRng, caseSeed as deriveCaseSeed, hashValue, normalizeSeed, DEFAULT_SEED } from './prng.mjs';
import {
  cloneValue,
  greedyShrink,
  measureMinimality,
  stableStringify,
  totalSize,
} from './shrink.mjs';
import { describeGen } from './gen.mjs';
import { EvalAssertionError } from './assert.mjs';

/** Schema tag for serialized property results. */
export const PROPERTY_SCHEMA = 'bridge-eval-property/1';
/** Default number of random cases per property. */
export const DEFAULT_CASES = 100;
/** Default cap on retained failure rows (counts still cover every failure). */
export const DEFAULT_MAX_FAILURES = 3;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

function normalizeCaseCount(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(100_000, Math.trunc(number)));
}

/**
 * Freeze and validate a property definition.
 * @param {{
 *   id: string,
 *   title: string,
 *   area: string,
 *   gen: object,
 *   check: (value: unknown, context: object) => unknown,
 *   consumes?: Array<{file:string, symbol:string, note?:string}>,
 *   examples?: Array<{label?: string, value: unknown}>,
 *   tags?: string[],
 *   source?: string,
 * }} spec
 */
export function defineProperty(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('defineProperty 需要对象');
  const id = String(spec.id || '');
  if (!ID_PATTERN.test(id)) {
    throw new TypeError('property id 必须形如 "area/name"（小写）：' + JSON.stringify(id));
  }
  if (typeof spec.gen !== 'object' || typeof spec.gen.rng !== 'function') {
    throw new TypeError('property ' + id + ' 缺少 gen 生成器');
  }
  if (typeof spec.check !== 'function') {
    throw new TypeError('property ' + id + ' 缺少 check 函数');
  }
  const examples = (Array.isArray(spec.examples) ? spec.examples : []).map((entry, index) => {
    if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')) {
      return Object.freeze({ label: entry.label ? String(entry.label) : 'example-' + index, value: cloneValue(entry.value) });
    }
    return Object.freeze({ label: 'example-' + index, value: cloneValue(entry) });
  });
  return Object.freeze({
    schema: PROPERTY_SCHEMA,
    id,
    title: String(spec.title || id),
    area: String(spec.area || id.split('/')[0]),
    gen: spec.gen,
    check: spec.check,
    consumes: Object.freeze((Array.isArray(spec.consumes) ? spec.consumes : []).map((item) => Object.freeze({
      file: String(item.file || ''),
      symbol: String(item.symbol || ''),
      note: item.note ? String(item.note) : null,
    }))),
    examples: Object.freeze(examples),
    tags: Object.freeze((Array.isArray(spec.tags) ? spec.tags : []).map(String)),
    source: spec.source ? String(spec.source) : null,
    generator: Object.freeze(describeGen(spec.gen)),
  });
}

/** Deterministic seed for one case (does not depend on any ambient state). */
export function caseSeedOf(seed, propertyId, caseIndex) {
  return deriveCaseSeed(normalizeSeed(seed), propertyId, caseIndex);
}

/**
 * Generate the value for one case.
 * @returns {{value: unknown, caseSeed: number}}
 */
export function generateCase(property, seed, caseIndex) {
  const caseSeed = caseSeedOf(seed, property.id, caseIndex);
  const rng = createRng(caseSeed);
  return { value: property.gen.rng(rng), caseSeed };
}

/** Build the deterministic context handed to `check`. */
export function makeContext({ property, seed, caseIndex, caseSeed, value, example = null }) {
  const valueSeed = caseSeed ^ hashValue(value);
  return Object.freeze({
    propertyId: property.id,
    area: property.area,
    seed: normalizeSeed(seed),
    caseSeed,
    caseIndex,
    example,
    rng: createRng(valueSeed),
    makeRng: (label = '') => createRng(valueSeed ^ hashValue(String(label))),
    size: totalSize(value),
  });
}

function normalizeError(error) {
  if (error instanceof EvalAssertionError) {
    return {
      name: error.name,
      code: error.code,
      message: String(error.message),
      expected: error.expected,
      actual: error.actual,
      evidence: error.evidence,
    };
  }
  if (error && typeof error === 'object') {
    return {
      name: error.name ? String(error.name) : 'Error',
      code: error.code ? String(error.code) : null,
      message: String(error.message || error),
    };
  }
  return { name: 'Error', code: null, message: String(error) };
}

function normalizeOutcome(outcome) {
  if (outcome === false) {
    return {
      ok: false,
      error: { name: 'EvalCheckReturnedFalse', code: 'E_EVAL_CHECK_FALSE', message: 'check 返回 false' },
    };
  }
  if (outcome && typeof outcome === 'object' && outcome.ok === false) {
    return {
      ok: false,
      error: {
        name: 'EvalCheckReportedFalse',
        code: outcome.code ? String(outcome.code) : 'E_EVAL_CHECK_FALSE',
        message: String(outcome.message || outcome.reason || 'check 返回 {ok:false}'),
        evidence: outcome.evidence === undefined ? null : outcome.evidence,
      },
    };
  }
  return { ok: true, error: null };
}

/** Run one generated value through the property check. */
export async function evaluateValue(property, value, context) {
  try {
    const outcome = await property.check(value, context);
    return normalizeOutcome(outcome);
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

async function runOne(property, value, { seed, caseIndex, caseSeed, example }) {
  const context = makeContext({ property, seed, caseIndex, caseSeed, value, example });
  const outcome = await evaluateValue(property, value, context);
  return { value, outcome, context };
}

function failureFailsFn(property, { seed, caseIndex, caseSeed, example }) {
  return async (candidate) => {
    const context = makeContext({ property, seed, caseIndex, caseSeed, value: candidate, example });
    const outcome = await evaluateValue(property, candidate, context);
    return outcome.ok !== true;
  };
}

/**
 * Run one property over deterministic cases.
 *
 * @param {object} property result of defineProperty
 * @param {{
 *   seed?: number|string,
 *   cases?: number,
 *   shrink?: boolean,
 *   maxShrinks?: number,
 *   maxCandidates?: number,
 *   maxFailures?: number,
 * }} [options]
 * @returns {Promise<object>} serializable property result
 */
export async function runProperty(property, options = {}) {
  const seed = normalizeSeed(options.seed === undefined ? DEFAULT_SEED : options.seed);
  const cases = normalizeCaseCount(options.cases, DEFAULT_CASES);
  const shrinkEnabled = options.shrink !== false;
  const maxShrinks = Math.max(0, Math.trunc(Number(options.maxShrinks) || 256));
  const maxCandidates = Math.max(1, Math.trunc(Number(options.maxCandidates) || 96));
  const maxFailures = Math.max(1, Math.trunc(Number(options.maxFailures) || DEFAULT_MAX_FAILURES));

  const failures = [];
  let failureCount = 0;
  let checksRun = 0;
  let examplesRun = 0;
  let generatorError = null;

  const recordFailure = async (entry) => {
    failureCount += 1;
    if (failures.length >= maxFailures) return;
    const row = {
      kind: entry.kind,
      caseIndex: entry.caseIndex,
      caseSeed: entry.caseSeed,
      example: entry.example || null,
      error: entry.error,
      original: cloneValue(entry.value),
      originalSize: totalSize(entry.value),
      minimal: null,
      minimalSize: null,
      minimalized: false,
      minimalVerified: null,
      shrinks: 0,
      shrinkSteps: [],
      candidatesTested: 0,
      replay: { seed, caseSeed: entry.caseSeed, caseIndex: entry.caseIndex, example: entry.example || null },
    };
    if (shrinkEnabled) {
      try {
        const failed = failureFailsFn(property, entry);
        const shrunk = await greedyShrink({
          value: entry.value,
          fails: failed,
          shrink: (candidate) => property.gen.shrink(candidate),
          maxSteps: maxShrinks,
          maxCandidates,
        });
        row.minimal = cloneValue(shrunk.minimal);
        row.minimalSize = totalSize(shrunk.minimal);
        row.minimalized = shrunk.steps.length > 0;
        row.shrinks = shrunk.steps.length;
        row.shrinkSteps = shrunk.steps.slice(0, 8);
        row.candidatesTested = shrunk.tested;
        if (stableStringify(shrunk.minimal) !== stableStringify(entry.value)) {
          const minimalContext = makeContext({
            property, seed, caseIndex: entry.caseIndex, caseSeed: entry.caseSeed, value: shrunk.minimal, example: entry.example,
          });
          const minimalOutcome = await evaluateValue(property, shrunk.minimal, minimalContext);
          if (minimalOutcome.error) row.error = minimalOutcome.error;
          row.originalError = entry.error;
        }
        const minimality = await measureMinimality({
          value: shrunk.minimal,
          fails: failed,
          shrink: (candidate) => property.gen.shrink(candidate),
          maxCandidates,
        });
        row.minimalVerified = minimality.minimal === true;
        if (!minimality.minimal) row.minimalityWitness = minimality.candidate ? cloneValue(minimality.candidate) : null;
      } catch (error) {
        row.shrinkError = normalizeError(error);
      }
    }
    failures.push(row);
  };

  // Fixed regression examples first: they do not consume the random stream.
  for (let index = 0; index < property.examples.length; index += 1) {
    const example = property.examples[index];
    const exampleIndex = -1 - index;
    const caseSeed = deriveCaseSeed(seed, property.id, 0x80000000 + index);
    checksRun += 1;
    examplesRun += 1;
    const run = await runOne(property, example.value, { seed, caseIndex: exampleIndex, caseSeed, example: example.label });
    if (!run.outcome.ok) {
      await recordFailure({
        kind: 'example',
        caseIndex: exampleIndex,
        caseSeed,
        example: example.label,
        value: example.value,
        error: run.outcome.error,
      });
    }
  }

  for (let caseIndex = 0; caseIndex < cases; caseIndex += 1) {
    let generated;
    try {
      generated = generateCase(property, seed, caseIndex);
    } catch (error) {
      generatorError = normalizeError(error);
      failureCount += 1;
      if (failures.length < maxFailures) {
        failures.push({
          kind: 'generator',
          caseIndex,
          caseSeed: caseSeedOf(seed, property.id, caseIndex),
          example: null,
          error: generatorError,
          original: null,
          originalSize: 0,
          minimal: null,
          minimalSize: null,
          shrinks: 0,
          candidatesTested: 0,
          replay: null,
        });
      }
      break;
    }
    checksRun += 1;
    const run = await runOne(property, generated.value, { seed, caseIndex, caseSeed: generated.caseSeed, example: null });
    if (!run.outcome.ok) {
      await recordFailure({
        kind: 'case',
        caseIndex,
        caseSeed: generated.caseSeed,
        example: null,
        value: generated.value,
        error: run.outcome.error,
      });
    }
  }

  const passed = checksRun - failureCount;
  return Object.freeze({
    schema: PROPERTY_SCHEMA,
    id: property.id,
    title: property.title,
    area: property.area,
    tags: property.tags,
    generator: property.generator,
    source: property.source,
    consumes: property.consumes,
    seed,
    cases,
    examples: examplesRun,
    checksRun,
    passed: Math.max(0, passed),
    failed: failureCount,
    failureCount,
    status: failureCount > 0 || generatorError ? 'failed' : 'passed',
    failures: Object.freeze(failures),
    shrink: Object.freeze({
      enabled: shrinkEnabled,
      maxSteps: maxShrinks,
      maxCandidates,
    }),
  });
}

/**
 * Regenerate one reported case and confirm it still fails.
 * This is the reproducibility contract behind every reported counterexample.
 */
export async function replayCase(property, { seed = DEFAULT_SEED, caseIndex = 0, example = null } = {}) {
  if (example !== null && example !== undefined) {
    const index = property.examples.findIndex((item) => item.label === String(example));
    if (index < 0) return { ok: false, reason: 'example-not-found', example: String(example) };
    const entry = property.examples[index];
    const caseSeedValue = deriveCaseSeed(normalizeSeed(seed), property.id, 0x80000000 + index);
    const run = await runOne(property, entry.value, { seed, caseIndex: -1 - index, caseSeed: caseSeedValue, example: entry.label });
    return {
      ok: true,
      value: cloneValue(entry.value),
      failed: run.outcome.ok !== true,
      error: run.outcome.error,
      caseSeed: caseSeedValue,
      example: entry.label,
    };
  }
  const caseSeedValue = caseSeedOf(seed, property.id, caseIndex);
  const rng = createRng(caseSeedValue);
  const value = property.gen.rng(rng);
  const run = await runOne(property, value, { seed, caseIndex, caseSeed: caseSeedValue, example: null });
  return {
    ok: true,
    value: cloneValue(value),
    failed: run.outcome.ok !== true,
    error: run.outcome.error,
    caseSeed: caseSeedValue,
    example: null,
  };
}

/**
 * Verify the generator is a pure function of its case seed: generate every
 * case twice with independent streams and compare the serialized values.
 */
export function verifyDeterminism(property, { seed = DEFAULT_SEED, cases = 16 } = {}) {
  const count = normalizeCaseCount(cases, 16);
  const mismatches = [];
  for (let caseIndex = 0; caseIndex < count; caseIndex += 1) {
    const first = generateCase(property, seed, caseIndex);
    const second = generateCase(property, seed, caseIndex);
    if (stableStringify(first.value) !== stableStringify(second.value)) {
      mismatches.push({
        caseIndex,
        first: cloneValue(first.value),
        second: cloneValue(second.value),
      });
      if (mismatches.length >= 3) break;
    }
  }
  for (const example of property.examples) {
    if (stableStringify(example.value) !== stableStringify(cloneValue(example.value))) {
      mismatches.push({ caseIndex: -1, label: example.label, first: example.value, second: cloneValue(example.value) });
      break;
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Compact one-line summary for the console. */
export function summarizePropertyResult(result) {
  const failure = result.failed ? ' FAIL' : ' ok';
  return '[eval] ' + (failure + ' ') + result.id + ' (' + result.checksRun + ' checks, ' + result.failureCount + ' failed)';
}
