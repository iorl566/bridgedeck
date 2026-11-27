import test from 'node:test';
import assert from 'node:assert/strict';
import { readFixture } from '../eval/helpers.mjs';
import {
  DEFAULT_SEED,
  PRNG_ALGORITHM,
  caseSeed,
  createRng,
  deriveSeed,
  drawUint32,
  fnv1a32,
  hashValue,
  mix32,
  normalizeSeed,
  spawnRngs,
} from '../../tools/eval/lib/prng.mjs';

test('PRNG：黄金向量可复现（uint32/int/bool/shuffle/snapshot）', () => {
  const vectors = readFixture('prng-vectors.json');
  assert.equal(vectors.algorithm, PRNG_ALGORITHM);
  assert.equal(vectors.schema, 'eval-prng-vectors/1');
  for (const entry of vectors.cases) {
    assert.equal(normalizeSeed(entry.input), entry.normalized, 'normalized 不符：' + String(entry.input));
    assert.deepEqual(drawUint32(entry.input, 8), entry.uint32, 'uint32 流不符：' + String(entry.input));
    const ints = [];
    const rng = createRng(entry.input);
    for (let index = 0; index < 8; index += 1) ints.push(rng.int(-3, 7));
    assert.deepEqual(ints, entry.ints, 'int 流不符');
    const bools = [];
    const boolRng = createRng(entry.input);
    for (let index = 0; index < 8; index += 1) bools.push(boolRng.bool(0.25));
    assert.deepEqual(bools, entry.bools, 'bool 流不符');
    assert.deepEqual(createRng(entry.input).shuffle([0, 1, 2, 3, 4, 5]), entry.shuffled, 'shuffle 不符');
    assert.deepEqual(createRng(entry.input).snapshot(), entry.snapshot, 'snapshot 不符');
  }
});

test('PRNG：seed 归一化覆盖数字/hex/十进制/文本', () => {
  assert.equal(normalizeSeed(undefined), DEFAULT_SEED);
  assert.equal(normalizeSeed(''), DEFAULT_SEED);
  assert.equal(normalizeSeed(0), 0);
  assert.equal(normalizeSeed('0'), 0);
  assert.equal(normalizeSeed(255), 255);
  assert.equal(normalizeSeed('255'), 255);
  assert.equal(normalizeSeed('0xff'), 255);
  assert.equal(normalizeSeed('0xFF'), 255);
  assert.equal(normalizeSeed(-1), 0xffffffff);
  assert.equal(normalizeSeed(1n << 32n), 0);
  assert.equal(typeof normalizeSeed('bridge'), 'number');
  assert.equal(normalizeSeed('bridge'), normalizeSeed('bridge'));
  assert.notEqual(normalizeSeed('bridge'), normalizeSeed('bridge2'));
  // CJK seeds remain distinct (high byte is folded into the hash).
  assert.notEqual(normalizeSeed('浏览器'), normalizeSeed('浏览器2'));
  assert.throws(() => normalizeSeed(Number.NaN), /seed/);
  assert.throws(() => normalizeSeed(Number.POSITIVE_INFINITY), /seed/);
  assert.throws(() => normalizeSeed({}), /seed/);
});

test('PRNG：hashValue 与对象键顺序无关，mix32/deriveSeed 确定', () => {
  const left = { a: 1, b: [true, 'x'], c: null };
  const right = { c: null, b: [true, 'x'], a: 1 };
  assert.equal(hashValue(left), hashValue(right), 'hashValue 依赖对象键顺序');
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), fnv1a32('a'));
  assert.notEqual(fnv1a32('a'), fnv1a32('b'));
  assert.equal(mix32(1, 2, 3), mix32(1, 2, 3));
  assert.equal(deriveSeed('bridge', 'x', 1), deriveSeed('bridge', 'x', 1));
  assert.notEqual(deriveSeed('bridge', 'x', 1), deriveSeed('bridge', 'x', 2));
  // Hash vectors are pinned in the same fixture as the PRNG vectors.
  const vectors = readFixture('prng-vectors.json');
  for (const entry of vectors.hashes) {
    assert.equal(fnv1a32(entry.text), entry.fnv1a32, 'fnv1a32 黄金向量不符');
    assert.equal(mix32(entry.fnv1a32, 1, 'x'), entry.mixed, 'mix32 黄金向量不符');
  }
});

test('PRNG：caseSeed 稳定且随 (id, index) 变化', () => {
  const vectors = readFixture('prng-vectors.json');
  for (const entry of vectors.caseSeeds) {
    assert.equal(caseSeed(entry.seed, entry.propertyId, entry.caseIndex), entry.caseSeed, 'caseSeed 黄金向量不符');
    assert.equal(caseSeed(entry.seed, entry.propertyId, entry.caseIndex), caseSeed(entry.seed, entry.propertyId, entry.caseIndex));
  }
  assert.notEqual(caseSeed(1, 'a/b', 0), caseSeed(1, 'a/b', 1));
  assert.notEqual(caseSeed(1, 'a/b', 0), caseSeed(1, 'c/d', 0));
});

test('PRNG：有界取样落在区间内、单值区间稳定', () => {
  const rng = createRng('bounds');
  for (let index = 0; index < 500; index += 1) {
    const value = rng.int(-5, 5);
    assert.ok(value >= -5 && value <= 5, 'int 越界：' + value);
    assert.ok(Number.isInteger(value), 'int 不是整数');
    const float = rng.float(0.5, 1.5, 2);
    assert.ok(float >= 0.5 && float <= 1.5, 'float 越界');
    assert.equal(Number(float.toFixed(2)), float, 'float 精度不符');
  }
  assert.equal(createRng(1).int(3, 3), 3);
  assert.equal(createRng(1).below(1), 0);
  assert.equal(createRng(1).bool(0), false);
  assert.equal(createRng(1).bool(1), true);
});

test('PRNG：非法输入显式抛错而不是静默回退', () => {
  const rng = createRng(1);
  assert.throws(() => rng.int(5, 1), RangeError);
  assert.throws(() => rng.int(Number.NaN, 1), RangeError);
  assert.throws(() => rng.below(0), RangeError);
  assert.throws(() => rng.pick([]), RangeError);
  assert.throws(() => rng.pick('nope'), TypeError);
  assert.throws(() => rng.shuffle(null), TypeError);
  assert.throws(() => rng.sample(null, 1), TypeError);
  assert.throws(() => rng.string(3, ''), RangeError);
});

test('PRNG：fork 子流与父流/彼此独立', () => {
  const parent = createRng('fork');
  const left = parent.fork('left');
  const right = parent.fork('right');
  assert.notEqual(left.seed, right.seed);
  assert.deepEqual(drawUint32(left.seed, 4), drawUint32(left.seed, 4));
  assert.notDeepEqual(drawUint32(left.seed, 4), drawUint32(right.seed, 4));
  const streams = spawnRngs('spawn', 4);
  assert.equal(streams.length, 4);
  assert.equal(new Set(streams.map((stream) => stream.seed)).size, 4);
  assert.equal(typeof parent.draws(), 'number');
});

test('PRNG：drawUint32 / string / hex / sample 确定性', () => {
  assert.deepEqual(drawUint32(7, 0), []);
  assert.deepEqual(drawUint32(7, 3), drawUint32(7, 3));
  assert.equal(createRng(7).string(8, 'ab').length, 8);
  assert.match(createRng(7).hex(8), /^[0-9a-f]{8}$/);
  const samples = createRng(7).sample([1, 2, 3, 4, 5], 3);
  assert.equal(samples.length, 3);
  assert.equal(new Set(samples).size, 3);
  assert.deepEqual(createRng(7).sample([1, 2, 3], 10), createRng(7).sample([1, 2, 3], 10));
  assert.equal(createRng(7).sample([1, 2, 3], 10).length, 3);
});
