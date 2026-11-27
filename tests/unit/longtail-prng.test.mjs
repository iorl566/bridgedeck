// tests/unit/longtail-prng.test.mjs —— 长尾生成器的确定性随机/哈希/稳定文本化。
//
// 这些断言是"夹具可复现"的地基：seed 相同 → 逐次调用序列相同；stableStringify 对键序不敏感；
// 指纹跨进程稳定（不依赖 V8 内部实现、不依赖 Math.random/Date.now）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SEED,
  LONGTAIL_PRNG_VERSION,
  UINT32_MAX,
  createRng,
  deriveSeed,
  fillerText,
  fingerprintOf,
  hash32,
  hash32Join,
  isSha256Hex,
  jsonSha256,
  mix32,
  normalizeSeed,
  rngFor,
  sha256Hex,
  sha256HexSync,
  stableHash,
  stableStringify,
  utf8Bytes,
} from '../../tools/longtail/lib/prng.mjs';

test('版本与默认 seed 固定', () => {
  assert.equal(LONGTAIL_PRNG_VERSION, 1);
  assert.equal(typeof DEFAULT_SEED, 'number');
  assert.equal(DEFAULT_SEED >>> 0, DEFAULT_SEED);
});

test('hash32 与 FNV-1a 公开测试向量一致', () => {
  assert.equal(hash32(''), 2166136261); // 0x811c9dc5
  assert.equal(hash32('a'), 3826002220); // 0xe40c292c
  assert.equal(hash32('foobar'), 3214735720); // 0xbf9cf968
  assert.equal(hash32(0), hash32('0'));
});

test('normalizeSeed 接受数字/字符串/大整数', () => {
  assert.equal(normalizeSeed(-1), 0xffffffff);
  assert.equal(normalizeSeed(4294967297), 1);
  assert.equal(normalizeSeed('abc'), hash32('abc'));
  assert.equal(normalizeSeed(null), DEFAULT_SEED);
  assert.equal(normalizeSeed(10n ** 12n), Number((10n ** 12n) & 0xffffffffn));
});

test('mix32 输出 uint32 且确定', () => {
  assert.equal(mix32(0), 0);
  assert.equal(mix32(1), 1753845952);
  for (const value of [2, 3, 100, -1, 0x7fffffff]) {
    const first = mix32(value);
    assert.equal(first, mix32(value));
    assert.ok(first >= 0 && first <= UINT32_MAX);
  }
});

test('hash32Join 位置敏感（(a,b) ≠ (b,a)）', () => {
  assert.notEqual(hash32Join('a', 'b'), hash32Join('b', 'a'));
  assert.equal(hash32Join('a', 'b'), hash32Join('a', 'b'));
});

test('createRng：同 seed 逐次调用完全相同', () => {
  const left = createRng(42);
  const right = createRng(42);
  for (let index = 0; index < 200; index += 1) {
    assert.equal(left.nextU32(), right.nextU32());
  }
  assert.equal(left.draws(), 200);
  assert.equal(right.draws(), 200);
});

test('createRng：不同 seed/初值状态产生不同序列', () => {
  const a = createRng(1);
  const b = createRng(2);
  const sequenceA = Array.from({ length: 16 }, () => a.nextU32());
  const sequenceB = Array.from({ length: 16 }, () => b.nextU32());
  assert.notDeepEqual(sequenceA, sequenceB);
  assert.equal(a.seed, mix32(1));
});

test('createRng：nextFloat 落在 [0,1)，int 落在闭区间', () => {
  const rng = createRng('floats');
  for (let index = 0; index < 500; index += 1) {
    const value = rng.nextFloat();
    assert.ok(value >= 0 && value < 1, 'float 越界：' + value);
  }
  const seen = new Set();
  for (let index = 0; index < 2000; index += 1) {
    const value = rng.int(3, 7);
    assert.ok(Number.isInteger(value));
    assert.ok(value >= 3 && value <= 7, 'int 越界：' + value);
    seen.add(value);
  }
  assert.deepEqual([...seen].sort((x, y) => x - y), [3, 4, 5, 6, 7]);
});

test('createRng：int 退化区间（min=max / max<min）不抛异常', () => {
  const rng = createRng(7);
  assert.equal(rng.int(5, 5), 5);
  assert.equal(rng.int(9, 3), 9);
  assert.equal(rng.index(0), -1);
  assert.equal(rng.index(1), 0);
});

test('createRng：chance/bool 确定且边界行为正确', () => {
  const rng = createRng('chance');
  assert.equal(rng.chance(0), false);
  assert.equal(rng.chance(1), true);
  const a = createRng(9);
  const b = createRng(9);
  for (let index = 0; index < 50; index += 1) assert.equal(a.bool(), b.bool());
});

test('createRng：pick/shuffle/sample 的确定性与完整性', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];
  const rngA = createRng(11);
  const rngB = createRng(11);
  assert.equal(rngA.pick(list), rngB.pick(list));
  assert.equal(rngA.pick([]), undefined);
  assert.equal(rngA.pickWeighted([], () => 1), undefined);
  const shuffledA = rngA.shuffle(list);
  const shuffledB = rngB.shuffle(list);
  assert.deepEqual(shuffledA, shuffledB);
  assert.deepEqual([...shuffledA].sort(), [...list].sort());
  assert.deepEqual(list, ['a', 'b', 'c', 'd', 'e'], 'shuffle 不能修改入参');
  const sampled = createRng(12).sample(list, 3);
  assert.equal(sampled.length, 3);
  assert.equal(new Set(sampled).size, 3);
  assert.equal(createRng(12).sample(list, 99).length, list.length);
});

test('createRng：pickWeighted 偏向高权重项', () => {
  const rng = createRng('weights');
  const counts = { heavy: 0, light: 0 };
  for (let index = 0; index < 4000; index += 1) {
    const picked = rng.pickWeighted(['heavy', 'light'], (item) => (item === 'heavy' ? 9 : 1));
    counts[picked] += 1;
  }
  assert.ok(counts.heavy > counts.light * 3, '高权重项应显著更常被选中：' + JSON.stringify(counts));
  assert.equal(createRng(3).pickWeighted(['x', 'y'], () => 0), createRng(3).pick(['x', 'y']));
});

test('createRng：hex/uuid 格式与 fork 可复现', () => {
  const rng = createRng(123);
  assert.match(rng.hex(12), /^[0-9a-f]{12}$/);
  assert.match(rng.uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const a = createRng(5);
  const b = createRng(5);
  const forkA = a.fork('sub');
  const forkB = b.fork('sub');
  assert.equal(forkA.nextU32(), forkB.nextU32());
  assert.equal(forkA.seed, forkB.seed);
  assert.equal(createRng(5).fork('left').seed, createRng(5).fork('left').seed);
});

test('deriveSeed/rngFor：标签顺序与内容都参与，且稳定', () => {
  const seed = deriveSeed(77, 'page', 12);
  assert.equal(seed, deriveSeed(77, 'page', 12));
  assert.notEqual(seed, deriveSeed(77, 12, 'page'));
  assert.notEqual(seed, deriveSeed(78, 'page', 12));
  const left = rngFor(77, 'har', 'source', 2);
  const right = rngFor(77, 'har', 'source', 2);
  assert.equal(left.nextU32(), right.nextU32());
});

test('stableStringify：键序无关、undefined 丢弃、NaN→null', () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(stableStringify({ a: Number.NaN, b: Infinity }), '{"a":null,"b":null}');
  assert.equal(stableStringify([1, undefined, 3]), '[1,null,3]');
  assert.equal(stableStringify({ nested: { z: 1, a: [2, 3] } }), '{"nested":{"a":[2,3],"z":1}}');
  assert.equal(stableStringify({ fn: () => 1, ok: true }), '{"ok":true}');
});

test('fingerprintOf/stableHash：16 位十六进制且对键序不敏感', () => {
  const left = fingerprintOf({ a: 1, b: [2, 3] });
  const right = fingerprintOf({ b: [2, 3], a: 1 });
  assert.equal(left, right);
  assert.match(left, /^[0-9a-f]{16}$/);
  assert.equal(stableHash({ x: 1 }), fingerprintOf({ x: 1 }));
  assert.notEqual(stableHash({ x: 1 }), stableHash({ x: 2 }));
});

test('fillerText：确定、长度精确、UTF-8 字节数可算', () => {
  const left = fillerText(createRng(1), 200);
  const right = fillerText(createRng(1), 200);
  assert.equal(left, right);
  assert.equal(left.length, 200);
  assert.equal(fillerText(createRng(1), 0), '');
  assert.ok(utf8Bytes('中文ab') > 4);
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes(null), 0);
});

test('sha256Hex：与已知摘要一致，异步/同步/Uint8Array 同值', async () => {
  const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(await sha256Hex('abc'), expected);
  assert.equal(sha256HexSync('abc'), expected);
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), expected);
  assert.equal(isSha256Hex(expected), true);
  assert.equal(isSha256Hex(expected.toUpperCase()), false);
  assert.equal(isSha256Hex('abc'), false);
});

test('jsonSha256：稳定文本化后再摘要（键序无关）', async () => {
  const left = await jsonSha256({ a: 1, b: 2 });
  const right = await jsonSha256({ b: 2, a: 1 });
  assert.equal(left, right);
  assert.match(left, /^[0-9a-f]{64}$/);
});
