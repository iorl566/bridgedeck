import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHABETS,
  array,
  boolean,
  character,
  constant,
  describeGen,
  dict,
  float,
  frequency,
  generate,
  integer,
  map,
  natural,
  nullable,
  oneOf,
  optional,
  record,
  recursive,
  sample,
  shrinkValue,
  sizeOf,
  string,
  suchThat,
  tuple,
} from '../../tools/eval/lib/gen.mjs';
import { createRng } from '../../tools/eval/lib/prng.mjs';
import { stableStringify, totalSize } from '../../tools/eval/lib/shrink.mjs';

const rngFor = (label) => createRng('gen-test:' + label);

test('生成器：同 seed 纯函数，不同 seed 通常不同', () => {
  const gen = record({ n: integer({ min: -50, max: 50 }), s: string({ maxLength: 6 }), xs: array(integer({ min: 0, max: 9 }), { maxLength: 3 }) });
  const left = gen.rng(rngFor('a'));
  const right = gen.rng(rngFor('a'));
  assert.deepEqual(left, right);
  assert.equal(gen.contains(left), true);
  const values = sample(gen, { seed: 42, count: 6 });
  assert.equal(values.length, 6);
  assert.deepEqual(sample(gen, { seed: 42, count: 6 }), values);
});

test('生成器：所有 shrink 候选严格更小且仍在域内', () => {
  const gen = record({
    n: integer({ min: -20, max: 20 }),
    s: string({ maxLength: 5, alphabet: 'ab01' }),
    xs: array(integer({ min: 0, max: 30 }), { maxLength: 3 }),
  });
  for (let index = 0; index < 40; index += 1) {
    const value = gen.rng(createRng('shrink-domain-' + index));
    const cap = totalSize(value);
    for (const candidate of gen.shrink(value)) {
      assert.ok(gen.contains(candidate), '候选不在域内：' + stableStringify(candidate));
      assert.ok(totalSize(candidate) < cap, '候选没有变小：' + stableStringify(candidate));
    }
  }
});

test('生成器：integer / natural / float 区间与域约束', () => {
  const intGen = integer({ min: -3, max: 3 });
  for (let index = 0; index < 50; index += 1) {
    const value = intGen.rng(createRng('int-' + index));
    assert.ok(Number.isInteger(value) && value >= -3 && value <= 3);
    assert.equal(intGen.contains(value), true);
    assert.equal(intGen.contains(4), false);
    assert.equal(intGen.contains(1.5), false);
  }
  assert.equal(natural({ max: 5 }).contains(-1), false);
  const floatGen = float({ min: 0, max: 1, precision: 2 });
  for (let index = 0; index < 50; index += 1) {
    const value = floatGen.rng(createRng('float-' + index));
    assert.ok(value >= 0 && value <= 1);
    assert.equal(Number(value.toFixed(2)), value);
  }
  assert.throws(() => integer({ min: 5, max: 1 }), RangeError);
  assert.throws(() => float({ min: 2, max: 1 }), RangeError);
});

test('生成器：string / character 字母表与长度约束', () => {
  const gen = string({ minLength: 2, maxLength: 4, alphabet: 'abc' });
  for (let index = 0; index < 40; index += 1) {
    const value = gen.rng(createRng('str-' + index));
    assert.ok(value.length >= 2 && value.length <= 4);
    assert.match(value, /^[abc]+$/);
    assert.equal(gen.contains(value), true);
  }
  assert.equal(gen.contains('abcd'), false);
  assert.equal(gen.contains('a'), false);
  assert.equal(gen.contains('aB'), false);
  assert.equal(character({ alphabet: 'xy' }).contains('x'), true);
  assert.equal(character({ alphabet: 'xy' }).contains('z'), false);
  assert.throws(() => string({ alphabet: '' }), RangeError);
  assert.equal(string({ minLength: 3, maxLength: 1 }).rng(createRng(1)).length >= 3, true);
});

test('生成器：array / tuple / record 组合与 shrink', () => {
  const arr = array(integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 3 });
  for (let index = 0; index < 20; index += 1) {
    const value = arr.rng(createRng('arr-' + index));
    assert.ok(Array.isArray(value) && value.length >= 1 && value.length <= 3);
    assert.equal(arr.contains(value), true);
    for (const candidate of arr.shrink(value)) assert.ok(arr.contains(candidate));
  }
  const tup = tuple(integer({ min: 0, max: 9 }), boolean());
  const tupleValue = tup.rng(createRng(3));
  assert.equal(tupleValue.length, 2);
  assert.deepEqual(tupleValue, tup.rng(createRng(3)));
  assert.equal(tup.contains([1, true]), true);
  assert.equal(tup.contains([1]), false);
  const rec = record({ a: integer({ min: 0, max: 3 }), b: string({ maxLength: 2, alphabet: 'z' }) });
  assert.equal(rec.contains({ a: 1, b: 'zz' }), true);
  assert.equal(rec.contains({ a: 4, b: 'z' }), false);
  assert.equal(rec.contains({ a: 1 }), false);
  assert.ok(rec.shrink({ a: 3, b: 'zz' }).length > 0);
});

test('生成器：oneOf / frequency / constant / nullable / optional', () => {
  const choice = oneOf([constant('a'), constant('b'), constant('c')]);
  const seen = new Set();
  for (let index = 0; index < 60; index += 1) seen.add(choice.rng(createRng('oneof-' + index)));
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
  assert.equal(choice.contains('b'), true);
  assert.equal(choice.contains('d'), false);
  assert.deepEqual(choice.shrink('b'), []);
  const weighted = frequency([[1, constant('rare')], [3, constant('common')]]);
  const counts = { rare: 0, common: 0 };
  for (let index = 0; index < 200; index += 1) counts[weighted.rng(createRng('freq-' + index))] += 1;
  assert.equal(counts.rare + counts.common, 200);
  assert.ok(counts.common > counts.rare, 'weighted 频率没有生效');
  assert.equal(oneOf([nullable(integer({ min: 0, max: 1 }))]).contains(null), true);
  assert.equal(optional(integer({ min: 0, max: 0 })).contains(0), true);
  assert.throws(() => oneOf([]), RangeError);
  assert.throws(() => constant(undefined).rng(createRng(1)), TypeError);
});

test('生成器：map / suchThat / dict / recursive', () => {
  const mapped = map(integer({ min: 0, max: 5 }), (value) => 'v' + value, {
    unproject: (value) => Number(String(value).slice(1)),
  });
  const mappedValue = mapped.rng(createRng('map'));
  assert.match(mappedValue, /^v\d$/);
  assert.equal(mapped.contains(mappedValue), true);
  for (const candidate of mapped.shrink(mappedValue)) assert.match(candidate, /^v\d$/);
  const even = suchThat(integer({ min: 0, max: 100 }), (value) => value % 2 === 0);
  for (let index = 0; index < 20; index += 1) assert.equal(even.rng(createRng('even-' + index)) % 2, 0);
  assert.equal(even.contains(4), true);
  assert.equal(even.contains(3), false);
  assert.throws(() => suchThat(integer({ min: 0, max: 0 }), () => false, { maxAttempts: 3 }).rng(createRng(1)), /suchThat/);
  const dictionary = dict(string({ minLength: 1, maxLength: 1, alphabet: 'ab' }), integer({ min: 0, max: 2 }), { minKeys: 1, maxKeys: 2 });
  const dictValue = dictionary.rng(createRng('dict'));
  assert.ok(Object.keys(dictValue).length >= 1 && Object.keys(dictValue).length <= 2);
  assert.equal(dictionary.contains(dictValue), true);
  assert.equal(dictionary.contains({}), false);
  const recursiveGen = recursive(constant('leaf'), (inner) => record({ child: inner }), { depth: 2 });
  const node = recursiveGen.rng(createRng('rec'));
  assert.ok(node !== undefined);
  assert.equal(sizeOf(node) >= 0, true);
});

test('生成器：describeGen / generate / shrinkValue 与非法定义', () => {
  const gen = integer({ min: 0, max: 3 });
  assert.deepEqual(describeGen(gen), { kind: 'integer', name: 'integer(0..3)' });
  const seed = 9;
  assert.equal(generate(gen, createRng(seed)), gen.rng(createRng(seed)));
  assert.deepEqual(shrinkValue(gen, 3), gen.shrink(3));
  assert.throws(() => describeGen(null), TypeError);
  assert.throws(() => array(null), TypeError);
  assert.throws(() => tuple([null]), TypeError);
  assert.throws(() => record(null), TypeError);
  assert.throws(() => record({ x: null }), TypeError);
  assert.throws(() => map(gen, null), TypeError);
  assert.throws(() => suchThat(gen, null), TypeError);
  assert.ok(ALPHABETS.ascii.includes('a'));
  assert.ok(ALPHABETS.cjk.length > 0);
});
