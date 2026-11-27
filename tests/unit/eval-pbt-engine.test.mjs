import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CASES,
  PROPERTY_SCHEMA,
  caseSeedOf,
  defineProperty,
  evaluateValue,
  generateCase,
  makeContext,
  replayCase,
  runProperty,
  summarizePropertyResult,
  verifyDeterminism,
} from '../../tools/eval/lib/property.mjs';
import { array, constant, integer, record, string } from '../../tools/eval/lib/gen.mjs';
import { EvalAssertionError, assertEqual } from '../../tools/eval/lib/assert.mjs';
import { stableStringify } from '../../tools/eval/lib/shrink.mjs';

const CONSUME = { file: 'tools/eval/lib/property.mjs', symbol: 'runProperty' };

function probeProperty(overrides = {}) {
  return defineProperty({
    id: 'eval-kernel/probe',
    title: 'probe',
    area: 'eval-kernel',
    gen: integer({ min: 0, max: 100 }),
    consumes: [CONSUME],
    check: () => true,
    ...overrides,
  });
}

test('defineProperty：校验 id/生成器/check 并冻结', () => {
  const property = probeProperty();
  assert.equal(property.schema, PROPERTY_SCHEMA);
  assert.equal(property.id, 'eval-kernel/probe');
  assert.equal(property.area, 'eval-kernel');
  assert.equal(Object.isFrozen(property), true);
  assert.equal(Object.isFrozen(property.consumes), true);
  assert.equal(Object.isFrozen(property.consumes[0]), true);
  assert.equal(property.generator.kind, 'integer');
  assert.throws(() => defineProperty({ id: 'bad', gen: integer(), check: () => true }), /property id/);
  assert.throws(() => defineProperty({ id: 'a/b', check: () => true }), /gen/);
  assert.throws(() => defineProperty({ id: 'a/b', gen: integer() }), /check/);
  assert.throws(() => defineProperty(null), TypeError);
});

test('generateCase / caseSeedOf / makeContext：纯函数且 ctx 确定性', () => {
  const property = probeProperty({ gen: record({ n: integer({ min: -5, max: 5 }), s: string({ maxLength: 3, alphabet: 'ab' }) }) });
  assert.equal(caseSeedOf(7, property.id, 2), caseSeedOf(7, property.id, 2));
  const first = generateCase(property, 7, 2);
  const second = generateCase(property, 7, 2);
  assert.deepEqual(first.value, second.value);
  assert.equal(first.caseSeed, second.caseSeed);
  const context = makeContext({ property, seed: 7, caseIndex: 2, caseSeed: first.caseSeed, value: first.value });
  assert.equal(context.propertyId, property.id);
  assert.equal(context.area, 'eval-kernel');
  assert.equal(context.caseSeed, first.caseSeed);
  assert.equal(typeof context.rng.nextUint32(), 'number');
  assert.equal(context.size, context.size);
  assert.notEqual(context.makeRng('x').nextUint32(), undefined);
});

test('evaluateValue：true/undefined 通过，false/{ok:false}/throw 失败并归一化', async () => {
  const property = probeProperty();
  const context = makeContext({ property, seed: 1, caseIndex: 0, caseSeed: 1, value: 1 });
  assert.deepEqual(await evaluateValue(property, 1, context), { ok: true, error: null });
  const falseProperty = probeProperty({ check: () => false });
  assert.equal((await evaluateValue(falseProperty, 1, context)).error.code, 'E_EVAL_CHECK_FALSE');
  const objectProperty = probeProperty({ check: () => ({ ok: false, reason: 'nope', evidence: { n: 1 } }) });
  const objectOutcome = await evaluateValue(objectProperty, 1, context);
  assert.equal(objectOutcome.ok, false);
  assert.equal(objectOutcome.error.message, 'nope');
  const throwing = probeProperty({ check: () => { throw new EvalAssertionError('bad', { expected: 1, actual: 2 }); } });
  const thrown = await evaluateValue(throwing, 1, context);
  assert.equal(thrown.error.name, 'EvalAssertionError');
  assert.equal(thrown.error.expected, 1);
  assert.equal(thrown.error.actual, 2);
  const asyncProperty = probeProperty({ check: async () => true });
  assert.equal((await evaluateValue(asyncProperty, 1, context)).ok, true);
});

test('runProperty：全部通过时 status=passed 且无失败行', async () => {
  const property = probeProperty();
  const result = await runProperty(property, { seed: 11, cases: 20 });
  assert.equal(result.status, 'passed');
  assert.equal(result.schema, PROPERTY_SCHEMA);
  assert.equal(result.checksRun, 20);
  assert.equal(result.failed, 0);
  assert.equal(result.failureCount, 0);
  assert.deepEqual(result.failures, []);
  assert.equal(result.seed, 11);
  assert.equal(result.cases, 20);
  assert.equal(JSON.stringify(result).includes('undefined'), false);
});

test('runProperty：失败收缩到 1-minimal 反例，反例可从 caseSeed 重放', async () => {
  const property = defineProperty({
    id: 'eval-kernel/shrink-probe',
    title: 'shrink probe',
    area: 'eval-kernel',
    gen: array(integer({ min: 0, max: 50 }), { maxLength: 6 }),
    consumes: [CONSUME],
    check: (value) => {
      if (Array.isArray(value) && value.length >= 2 && value.some((item) => item >= 10)) {
        throw new EvalAssertionError('发现大值', { expected: '<10', actual: value });
      }
      return true;
    },
  });
  const result = await runProperty(property, { seed: 3, cases: 20, maxFailures: 2 });
  assert.equal(result.status, 'failed');
  const failure = result.failures[0];
  assert(failure, '缺少失败行');
  assert.equal(failure.kind, 'case');
  assert.equal(failure.minimalVerified, true);
  assert.ok(failure.shrinks >= 0);
  assert.ok(failure.candidatesTested > 0);
  assert.ok(Array.isArray(failure.minimal));
  assert.equal(failure.minimal.length, 2);
  assert.ok(failure.minimal.includes(10));
  assert.equal(failure.replay.seed, 3);
  assert.equal(failure.replay.caseIndex, failure.caseIndex);
  const replay = await replayCase(property, { seed: 3, caseIndex: failure.caseIndex });
  assert.equal(replay.ok, true);
  assert.equal(replay.failed, true);
  assert.deepEqual(replay.value, failure.original);
  assert.equal(replay.caseSeed, failure.caseSeed);
});

test('runProperty：固定 examples 先跑、失败样例可单独复现', async () => {
  const property = defineProperty({
    id: 'eval-kernel/example-probe',
    title: 'example probe',
    area: 'eval-kernel',
    gen: integer({ min: 0, max: 1 }),
    consumes: [CONSUME],
    check: (value) => {
      if (value === 42 || value === 43) throw new Error('样例失败：' + value);
      return true;
    },
    examples: [{ label: 'regression-42', value: 42 }, { label: 'ok-1', value: 1 }],
  });
  const result = await runProperty(property, { seed: 5, cases: 2 });
  assert.equal(result.examples, 2);
  const exampleFailure = result.failures.find((failure) => failure.kind === 'example');
  assert(exampleFailure, '样例失败没有记录');
  assert.equal(exampleFailure.example, 'regression-42');
  assert.equal(exampleFailure.caseIndex, -1);
  assert.equal(exampleFailure.minimalVerified, true);
  const replay = await replayCase(property, { seed: 5, example: 'regression-42' });
  assert.equal(replay.ok, true);
  assert.equal(replay.failed, true);
  assert.equal(replay.value, 42);
  const missing = await replayCase(property, { seed: 5, example: 'nope' });
  assert.equal(missing.ok, false);
});

test('runProperty：maxFailures 截断保留行但 failureCount 完整', async () => {
  const property = defineProperty({
    id: 'eval-kernel/many-failures',
    title: 'many failures',
    area: 'eval-kernel',
    gen: integer({ min: 0, max: 100 }),
    consumes: [CONSUME],
    check: () => { throw new Error('always'); },
  });
  const result = await runProperty(property, { seed: 1, cases: 10, maxFailures: 2, shrink: false });
  assert.equal(result.failureCount, 10);
  assert.equal(result.failures.length, 2);
  assert.equal(result.failed, 10);
  assert.equal(result.passed, 0);
});

test('runProperty：shrink=false 时不做收缩但保留原始值', async () => {
  const property = defineProperty({
    id: 'eval-kernel/no-shrink',
    title: 'no shrink',
    area: 'eval-kernel',
    gen: array(integer({ min: 0, max: 9 }), { maxLength: 5 }),
    consumes: [CONSUME],
    check: () => false,
  });
  const result = await runProperty(property, { seed: 2, cases: 3, shrink: false });
  assert.equal(result.shrink.enabled, false);
  for (const failure of result.failures) {
    assert.equal(failure.minimal, null);
    assert.equal(failure.shrinks, 0);
    assert.equal(failure.minimalVerified, null);
  }
});

test('runProperty：生成器抛错归类为 generator 失败并停止后续用例', async () => {
  const property = defineProperty({
    id: 'eval-kernel/broken-gen',
    title: 'broken gen',
    area: 'eval-kernel',
    gen: { kind: 'broken', name: 'broken', rng: () => { throw new Error('gen boom'); }, shrink: () => [], contains: () => true },
    consumes: [CONSUME],
    check: () => true,
  });
  const result = await runProperty(property, { seed: 1, cases: 5 });
  assert.equal(result.status, 'failed');
  assert.equal(result.failures[0].kind, 'generator');
  assert.match(result.failures[0].error.message, /gen boom/);
  assert.equal(result.checksRun, 0);
});

test('verifyDeterminism：对生成器纯度给出可定位的 mismatch', () => {
  const stable = probeProperty({ gen: record({ n: integer({ min: 0, max: 9 }) }) });
  assert.deepEqual(verifyDeterminism(stable, { seed: 4, cases: 8 }), { ok: true, mismatches: [] });
  let calls = 0;
  const impure = probeProperty({
    gen: {
      kind: 'impure',
      name: 'impure',
      rng: () => { calls += 1; return calls; },
      shrink: () => [],
      contains: () => true,
    },
  });
  const result = verifyDeterminism(impure, { seed: 4, cases: 4 });
  assert.equal(result.ok, false);
  assert.ok(result.mismatches.length > 0);
  assert.equal(result.mismatches[0].caseIndex, 0);
});

test('runProperty：两次运行结果逐字节一致（无时间/随机字段）', async () => {
  const property = defineProperty({
    id: 'eval-kernel/deterministic-failure',
    title: 'deterministic failure',
    area: 'eval-kernel',
    gen: record({ n: integer({ min: 0, max: 20 }), s: string({ maxLength: 3, alphabet: 'ab' }) }),
    consumes: [CONSUME],
    check: (value) => {
      if (value.n > 0) throw new EvalAssertionError('n>0', { actual: value });
      return true;
    },
  });
  const first = await runProperty(property, { seed: 9, cases: 12, maxFailures: 1 });
  const second = await runProperty(property, { seed: 9, cases: 12, maxFailures: 1 });
  assert.equal(stableStringify(first), stableStringify(second), '两次运行结果不一致');
  assert.equal(JSON.stringify(first).includes('duration'), false);
  assert.equal(JSON.stringify(first).includes('timestamp'), false);
  assert.equal(summarizePropertyResult(first).includes(first.id), true);
  assert.equal(DEFAULT_CASES, 100);
});
