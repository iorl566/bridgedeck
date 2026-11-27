import test from 'node:test';
import assert from 'node:assert/strict';
import { readFixture } from '../eval/helpers.mjs';
import {
  compareSize,
  greedyShrink,
  measureMinimality,
  orderCandidates,
  shrinkArray,
  shrinkNumber,
  shrinkRecord,
  shrinkString,
  shrinkTuple,
  sizeSummary,
  stableStringify,
  totalSize,
  unionShrinks,
} from '../../tools/eval/lib/shrink.mjs';
import { array, integer, record, string } from '../../tools/eval/lib/gen.mjs';

test('收缩黄金向量：数字/字符串/数组/记录与夹具一致', () => {
  const fixture = readFixture('shrink-cases.json');
  assert.equal(fixture.schema, 'eval-shrink-vectors/1');
  const intGen = integer({ min: 0, max: 50 });
  const recordGen = record({ text: string({ maxLength: 4, alphabet: 'ab' }), list: array(integer({ min: 0, max: 9 }), { maxLength: 3 }) });
  for (const entry of fixture.cases) {
    let actual;
    if (entry.kind === 'number') actual = shrinkNumber(entry.input, fixture.integerShrinkArgs);
    else if (entry.kind === 'string') actual = shrinkString(entry.input);
    else if (entry.kind === 'array') actual = shrinkArray(entry.input, intGen.shrink, { minLength: 0 });
    else if (entry.kind === 'record') actual = recordGen.shrink(entry.input);
    else throw new Error('未知夹具 kind：' + entry.kind);
    assert.deepEqual(actual, entry.candidates, entry.kind + ' 收缩候选不符：' + stableStringify(entry.input));
  }
});

test('收缩候选：严格更小、去重、排序稳定', () => {
  for (const value of [10, -10, 0, 1, 999]) {
    const candidates = shrinkNumber(value, { min: -1000, max: 1000 });
    const keys = candidates.map((candidate) => stableStringify(candidate));
    assert.equal(new Set(keys).size, keys.length, '候选出现重复');
    assert.ok(!keys.includes(stableStringify(value)), '候选包含原值');
    for (const candidate of candidates) assert.ok(Math.abs(candidate) < Math.abs(value) || value === 0, '候选没有变小');
    const ordered = candidates.slice().sort((left, right) => totalSize(left) - totalSize(right) || (stableStringify(left) < stableStringify(right) ? -1 : 1));
    assert.deepEqual(candidates, ordered, '候选没有按大小/稳定序列化排序');
  }
  assert.deepEqual(shrinkNumber(0, { min: 0, max: 10 }), []);
  assert.deepEqual(shrinkNumber(1, { min: 0, max: 1 }), [0]);
  assert.deepEqual(shrinkString(''), []);
});

test('Unicode 收缩：候选保持合法标量序列且不增长', () => {
  for (const value of ['观察节点', '😀a😀', 'aé漢字', 'ab', '😀']) {
    const candidates = shrinkString(value);
    for (const candidate of candidates) {
      const points = Array.from(candidate).map((char) => char.codePointAt(0));
      assert.equal(String.fromCodePoint(...points), candidate, '候选不是合法 Unicode 标量序列');
      assert.ok(totalSize(candidate) < totalSize(value), '候选没有变小');
    }
  }
});

test('数组收缩：minLength 下界与元素收缩', () => {
  const intGen = integer({ min: 0, max: 9 });
  const candidates = shrinkArray([3, 7], intGen.shrink, { minLength: 2 });
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    assert.ok(candidate.length >= 2, '候选低于 minLength');
    assert.ok(totalSize(candidate) < totalSize([3, 7]));
  }
  assert.ok(candidates.some((candidate) => candidate.length === 2 && candidate.includes(0)), '没有元素收缩到 0 的候选');
  const deletions = shrinkArray([1, 2, 3], intGen.shrink, { minLength: 0 });
  assert.ok(deletions.some((candidate) => candidate.length === 0), '缺少清空候选');
  assert.ok(deletions.some((candidate) => candidate.length === 2), '缺少删除候选');
});

test('元组/记录/并集收缩：逐字段进行且域内', () => {
  const intGen = integer({ min: 0, max: 9 });
  const tupleCandidates = shrinkTuple([5, 9], [(value) => intGen.shrink(value), (value) => intGen.shrink(value)]);
  assert.ok(tupleCandidates.length > 0);
  for (const candidate of tupleCandidates) assert.equal(candidate.length, 2);
  const recordGen = record({ a: intGen, b: string({ maxLength: 3, alphabet: 'ab' }) });
  const recordCandidates = shrinkRecord({ a: 9, b: 'ab' }, {
    a: (value) => intGen.shrink(value),
    b: (value) => string({ maxLength: 3, alphabet: 'ab' }).shrink(value),
  });
  assert.ok(recordCandidates.length > 0);
  for (const candidate of recordCandidates) assert.equal(recordGen.contains(candidate), true);
  const union = unionShrinks(4, [(value) => shrinkNumber(value, { min: 0, max: 10 }), (value) => [0]]);
  assert.ok(union.some((candidate) => candidate === 0));
});

test('greedyShrink：收敛到 1-minimal 且步数/候选计数确定', async () => {
  const gen = array(integer({ min: 0, max: 100 }), { maxLength: 6 });
  const fails = (value) => Array.isArray(value) && value.length >= 2;
  const shrinker = (value) => gen.shrink(value);
  const first = await greedyShrink({ value: [90, 80, 70], fails, shrink: shrinker });
  const second = await greedyShrink({ value: [90, 80, 70], fails, shrink: shrinker });
  assert.deepEqual(first.minimal, second.minimal);
  assert.equal(first.tested, second.tested);
  assert.deepEqual(first.minimal, [0, 0]);
  assert.ok(first.steps.length > 0, '收缩没有产生步骤');
  assert.ok(first.tested > 0, '收缩没有测试候选');
  const minimality = await measureMinimality({ value: first.minimal, fails, shrink: shrinker });
  assert.equal(minimality.minimal, true);
  assert.equal(minimality.candidate, null);
});

test('greedyShrink：候选检查抛错视为失败，maxSteps 限制生效', async () => {
  const shrink = (value) => (value > 0 ? [value - 1] : []);
  const thrown = await greedyShrink({
    value: 5,
    fails: (candidate) => {
      if (candidate === 3) throw new Error('boom');
      return candidate > 0;
    },
    shrink,
  });
  assert.ok(thrown.minimal >= 1);
  const limited = await greedyShrink({ value: 100, fails: () => true, shrink, maxSteps: 3 });
  assert.equal(limited.accepted, 3);
  assert.equal(limited.minimal, 97);
  await assert.rejects(() => greedyShrink({ value: 1, fails: null, shrink }), TypeError);
  await assert.rejects(() => greedyShrink({ value: 1, fails: () => true, shrink: null }), TypeError);
});

test('orderCandidates / sizeSummary / compareSize 的确定性', () => {
  const ordered = orderCandidates([3, 1, 2, 1, 4], 2);
  assert.deepEqual(ordered, [1, 3, 4]);
  assert.deepEqual(orderCandidates([3, 1, 2], 2), orderCandidates([3, 1, 2], 2));
  assert.deepEqual(orderCandidates([{ b: 1 }, { a: 1 }], null), [{ a: 1 }, { b: 1 }]);
  assert.equal(compareSize(1, 2) < 0, true);
  assert.equal(compareSize('a', 'ab') < 0, true);
  assert.deepEqual(sizeSummary([1, 2]), { size: 5, json: '[1,2]' });
  assert.equal(totalSize(null), 0);
  assert.equal(totalSize(undefined), 0);
  assert.equal(totalSize(true), 1);
  assert.equal(totalSize({ a: 1 }), 2);
});
