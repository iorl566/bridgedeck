// tests/unit/quality-canonical.test.mjs —— 规范化/指纹/PRNG/幂等 token 的单测。
//
// 这些是质量门禁的地基：如果 canonicalJson/fingerprint 本身不稳定，
// 后面所有"重复 N 次指纹一致"的检查都会失去意义。因此这里的 golden 向量
// 是刻意写死的（跨 Node 版本不改），PRNG 也验证固定序列。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalJson,
  deepEqual,
  fingerprint,
  firstDifference,
  multisetFingerprint,
  rotateKeys,
  semanticFingerprint,
  stableSortBy,
  stripVolatile,
} from '../../tools/quality/lib/canonical.mjs';
import {
  createFixedClock,
  createRng,
  deriveSeed,
  floatSequence,
  hashSeed,
  uintSequence,
} from '../../tools/quality/lib/prng.mjs';
import {
  createIdempotentStore,
  normalizeOperation,
  operationToken,
  tokenFixture,
  writeSemanticDigest,
} from '../../tools/quality/lib/writes.mjs';

test('canonicalJson：对象键顺序不影响结果，数组顺序保留', () => {
  const left = { b: 2, a: 1, nested: { z: true, y: [1, 2] } };
  const right = rotateKeys(left, 1);
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
  assert.equal(canonicalJson({ a: undefined, b: 1 }), canonicalJson({ b: 1 }));
  assert.equal(canonicalJson({ a: [undefined] }), '{"a":[{"$bq":"undefined"}]}');
});

test('canonicalJson：特殊数值/日期/大整数/循环引用都有稳定标记', () => {
  assert.equal(canonicalJson({ n: NaN }), '{"n":{"$bq":"NaN"}}');
  assert.equal(canonicalJson({ n: Infinity }), '{"n":{"$bq":"Infinity"}}');
  assert.equal(canonicalJson({ n: -Infinity }), '{"n":{"$bq":"-Infinity"}}');
  assert.equal(canonicalJson({ n: -0 }), '{"n":0}');
  assert.equal(canonicalJson({ n: 10n }), '{"n":{"$bq":"bigint","value":"10"}}');
  assert.equal(canonicalJson({ d: new Date(0) }), '{"d":{"$bq":"date","value":"1970-01-01T00:00:00.000Z"}}');
  const cycle = { name: 'x' };
  cycle.self = cycle;
  const text = canonicalJson(cycle);
  assert.match(text, /\{"\$bq":"circular"/);
});

test('fingerprint：16 hex、同输入稳定、不同输入不同', () => {
  const first = fingerprint({ a: 1, b: [2, 3] });
  const second = fingerprint({ b: [2, 3], a: 1 });
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(first, second);
  assert.notEqual(first, fingerprint({ a: 1, b: [2, 4] }));
  assert.equal(fingerprint(undefined), fingerprint(undefined));
});

test('multisetFingerprint：与元素顺序无关，但重复元素计数', () => {
  const base = multisetFingerprint(['b', 'a', 'c']);
  assert.equal(base, multisetFingerprint(['c', 'a', 'b']));
  assert.notEqual(base, multisetFingerprint(['a', 'b', 'c', 'c']));
  assert.equal(multisetFingerprint([{ id: 1 }, { id: 2 }], (item) => item.id), multisetFingerprint([{ id: 2 }, { id: 1 }], (item) => item.id));
});

test('stableSortBy：稳定排序且不依赖 locale', () => {
  const items = [{ key: 'b' }, { key: 'a' }, { key: 'b' }, { key: 'a' }];
  const sorted = stableSortBy(items, (item) => item.key);
  assert.deepEqual(sorted.map((item) => item.key), ['a', 'a', 'b', 'b']);
  assert.deepEqual(sorted[1], items[3]);
  assert.deepEqual(sorted[3], items[2]);
});

test('stripVolatile/semanticFingerprint：忽略时间/进程/路径字段', () => {
  const left = { at: '2020-01-01T00:00:00.000Z', createdAt: 1, pid: 11, value: 7, dir: '/tmp/a', ok: true, durationMs: 3 };
  const right = { at: '2026-11-26T00:00:00.000Z', createdAt: 2, pid: 99, value: 7, dir: '/tmp/b', ok: true, durationMs: 40 };
  assert.equal(semanticFingerprint(left), semanticFingerprint(right));
  assert.notEqual(semanticFingerprint(left), semanticFingerprint({ ...left, value: 8 }));
  const stripped = stripVolatile(left, { extra: [/^value$/] });
  assert.equal(stripped.value, undefined);
  assert.equal(stripped.ok, true);
});

test('deepEqual/firstDifference：报出首处差异路径', () => {
  assert.equal(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
  const diff = firstDifference({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } });
  assert.equal(diff.path, '$.b.c');
  assert.equal(diff.left, 2);
  assert.equal(diff.right, 3);
  assert.equal(firstDifference([1, 2], [1, 2, 3]).kind, 'length');
});

test('PRNG golden 向量（跨进程/跨版本稳定）', () => {
  assert.equal(hashSeed('quality'), 2617783151);
  assert.deepEqual(uintSequence('quality', 5), [2732388095, 3747692222, 3999718981, 2153969362, 161736782]);
  assert.deepEqual(floatSequence('quality', 3), [0.04596571438014507, 0.7410275868605822, 0.3784656038042158]);
  assert.deepEqual(uintSequence(0, 3), [2686781580, 665160406, 1226781833]);
  const rng = createRng('quality');
  assert.deepEqual(rng.shuffle([1, 2, 3, 4, 5]), [4, 5, 2, 3, 1]);
  assert.equal(rng.hex(8), 'a2dceeff');
  assert.equal(rng.string(6), 'm89zvj');
});

test('PRNG：同 seed 同序列，不同 seed 不同序列，shuffle 保持元素集合', () => {
  assert.deepEqual(uintSequence('a', 8), uintSequence('a', 8));
  assert.notDeepEqual(uintSequence('a', 8), uintSequence('b', 8));
  assert.equal(deriveSeed('base', 'label'), deriveSeed('base', 'label'));
  assert.notEqual(deriveSeed('base', 'label'), deriveSeed('base', 'other'));
  const shuffled = createRng(7).shuffle([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(shuffled.slice().sort((x, y) => x - y), [1, 2, 3, 4, 5, 6]);
});

test('createFixedClock：手动推进、不读真实时间', () => {
  const clock = createFixedClock(1700000000000);
  assert.equal(clock.now(), 1700000000000);
  assert.equal(clock.iso(), '2023-11-14T22:13:20.000Z');
  clock.advance(1500);
  assert.equal(clock.now(), 1700000001500);
  clock.advance(-10);
  assert.equal(clock.now(), 1700000001500);
});

test('operationToken：参数键顺序不影响、语义变化改变 token、golden 稳定', () => {
  const base = { method: 'click', target: '@e1', params: { selector: '#submit', label: 'submit' } };
  const rotated = { method: 'click', target: '@e1', params: { label: 'submit', selector: '#submit' } };
  assert.equal(operationToken(base), operationToken(rotated));
  assert.equal(operationToken(base), 'wt_e8d335cc8a232923');
  assert.notEqual(operationToken(base), operationToken({ ...base, params: { selector: '#other' } }));
  assert.notEqual(operationToken(base), operationToken({ ...base, method: 'fill' }));
  assert.deepEqual(normalizeOperation(base).params, { label: 'submit', selector: '#submit' });
  assert.match(operationToken(base), /^wt_[0-9a-f]{16}$/);
});

test('tokenFixture：结构自洽且 digest 稳定', () => {
  const fixture = tokenFixture('quality');
  assert.equal(fixture.schema, 'bb.quality-write-token/1');
  assert.equal(fixture.seed, 'quality');
  assert.equal(fixture.tokens.length, 2);
  assert.equal(fixture.tokens[0][0], 'wt_e8d335cc8a232923');
  assert.equal(fixture.digest, '302e7453fa017e16');
  assert.equal(fixture.digest, tokenFixture('quality').digest);
  assert.notEqual(fixture.digest, tokenFixture('other').digest);
});

test('createIdempotentStore：同 token 只写一次、失败不提交、可重试', async () => {
  const store = createIdempotentStore();
  const operation = { method: 'click', target: '@e1', params: { selector: '#submit' } };
  let executions = 0;
  const first = await store.apply(operation, async () => {
    executions += 1;
    return { effect: 'clicked' };
  });
  const second = await store.apply(operation, async () => {
    executions += 1;
    return { effect: 'duplicate' };
  });
  assert.equal(first.executed, true);
  assert.equal(second.duplicate, true);
  assert.equal(executions, 1);
  assert.equal(store.writes, 1);
  assert.equal(second.result.effect, 'clicked');
  await assert.rejects(
    store.apply({ method: 'fill', target: '@e2', params: {} }, async () => {
      throw Object.assign(new Error('write failed'), { code: 'E_LEDGER_WAL_IO' });
    }),
    (error) => error.code === 'E_LEDGER_WAL_IO',
  );
  assert.equal(store.failures, 1);
  const failed = store.peek({ method: 'fill', target: '@e2', params: {} });
  assert.equal(failed.status, 'failed');
  assert.equal(writeSemanticDigest({ b: 1, at: 2 }), writeSemanticDigest({ b: 1, at: 99 }));
});
