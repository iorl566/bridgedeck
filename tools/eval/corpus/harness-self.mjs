/**
 * tools/eval/corpus/harness-self.mjs -- invariants of the property-testing
 * kernel itself (PRNG, generators, shrinker, report, source locator, clock).
 *
 * These are not product tests; they are the calibration corpus that makes the
 * other five areas trustworthy. If the kernel drifts (non-deterministic seed
 * derivation, a shrinker that grows values, a digest that depends on key
 * order), this area fails first.
 */

import { defineProperty } from '../lib/property.mjs';
import { ALPHABETS, array, integer, natural, oneOf, record, string, constant } from '../lib/gen.mjs';
import { greedyShrink, measureMinimality, stableStringify, totalSize } from '../lib/shrink.mjs';
import { EvalAssertionError, assert, assertDeepEqual, assertEqual } from '../lib/assert.mjs';
import { createRng, caseSeed, normalizeSeed, drawUint32, fnv1a32 } from '../lib/prng.mjs';
import { buildReport, verifyDigest, verifyReport } from '../lib/report.mjs';
import { findSymbolLine, listExports, locateSymbol } from '../lib/source.mjs';
import { createManualClock, captureCode } from '../lib/harness.mjs';
import { suchThat } from '../lib/gen.mjs';

const SEED = { file: 'tools/eval/lib/prng.mjs', symbol: 'createRng' };
const CASE_SEED = { file: 'tools/eval/lib/prng.mjs', symbol: 'caseSeed' };
const SHRINK = { file: 'tools/eval/lib/shrink.mjs', symbol: 'greedyShrink' };
const REPORT = { file: 'tools/eval/lib/report.mjs', symbol: 'buildReport' };
const SOURCE = { file: 'tools/eval/lib/source.mjs', symbol: 'locateSymbol' };
const CLOCK = { file: 'tools/eval/lib/harness.mjs', symbol: 'createManualClock' };

const seedGen = oneOf([
  integer({ min: 0, max: 0xffffffff }),
  string({ minLength: 1, maxLength: 10, alphabet: ALPHABETS.alnum }),
]);

const compositeGen = oneOf([
  integer({ min: -1000, max: 1000 }),
  string({ minLength: 0, maxLength: 8, alphabet: ALPHABETS.ascii }),
  array(integer({ min: 0, max: 9 }), { maxLength: 5 }),
  record({ flag: oneOf([constant(true), constant(false)]), label: string({ maxLength: 4, alphabet: 'ab1' }) }),
]);

const distinctSeeds = suchThat(record({ first: seedGen, second: seedGen }), (value) => normalizeSeed(value.first) !== normalizeSeed(value.second));

const unicodeGen = string({ minLength: 0, maxLength: 7, alphabet: 'aZ09é漢😀 ' });

export const area = {
  area: 'eval-kernel',
  title: 'eval 内核自校验：PRNG / 生成器 / 收缩 / 报告 / 源码定位',
  properties: [
    defineProperty({
      id: 'eval-kernel/prng-stream-replay',
      title: '同一 seed 的 PRNG 流可完全复现，snapshot 一致',
      area: 'eval-kernel',
      gen: seedGen,
      consumes: [SEED],
      check: (seed) => {
        const first = createRng(seed);
        const second = createRng(seed);
        const left = [];
        const right = [];
        for (let index = 0; index < 12; index += 1) {
          left.push(first.nextUint32());
          right.push(second.nextUint32());
        }
        assertDeepEqual(left, right, '同 seed 的 uint32 流不一致');
        assertDeepEqual(first.snapshot(), second.snapshot(), '同 seed 的 snapshot 不一致');
        assertEqual(first.seed, second.seed, '同 seed 归一化结果不一致');
        assert(left.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff), 'PRNG 输出越界');
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/prng-distinct-seeds',
      title: '不同 seed 的 PRNG 流彼此独立',
      area: 'eval-kernel',
      gen: distinctSeeds,
      consumes: [SEED],
      check: ({ first, second }) => {
        const left = drawUint32(first, 4);
        const right = drawUint32(second, 4);
        assert(stableStringify(left) !== stableStringify(right), '不同 seed 生成了完全相同的流', { expected: 'distinct', actual: { first, second } });
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/prng-seed-normalization',
      title: 'seed 归一化：数字 / hex / 十进制 / 文本都稳定映射到 uint32',
      area: 'eval-kernel',
      gen: record({ number: integer({ min: 0, max: 0xffffffff }), text: string({ minLength: 1, maxLength: 8, alphabet: ALPHABETS.alnum }) }),
      consumes: [SEED, CASE_SEED],
      check: ({ number, text }) => {
        const hex = '0x' + number.toString(16);
        assertEqual(normalizeSeed(hex), number, 'hex 与十进制 seed 归一化不一致');
        assertEqual(normalizeSeed(String(number)), number, '十进制字符串 seed 归一化不一致');
        assertEqual(normalizeSeed(text), normalizeSeed(text), '文本 seed 归一化不稳定');
        const normalized = normalizeSeed(text);
        assert(Number.isInteger(normalized) && normalized >= 0 && normalized <= 0xffffffff, '文本 seed 归一化越界', { actual: normalized });
        assertEqual(caseSeed(1, 'a/b', 0), caseSeed(1, 'a/b', 0), 'caseSeed 不幂等');
        assert(caseSeed(1, 'a/b', 0) !== caseSeed(1, 'a/b', 1), '相邻 caseIndex 的 caseSeed 相同');
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/gen-pure-and-domain',
      title: '生成器对同一 case seed 是纯函数，生成值落在 contains 域内',
      area: 'eval-kernel',
      gen: compositeGen,
      consumes: [SEED],
      check: (value) => {
        const seed = fnv1a32(stableStringify(value));
        const left = compositeGen.rng(createRng(seed));
        const right = compositeGen.rng(createRng(seed));
        assertDeepEqual(left, right, '同一 seed 生成结果不同', { actual: { left, right } });
        assert(compositeGen.contains(value), '生成值不在 contains 域内', { actual: value });
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/gen-shrink-domain',
      title: '生成器的所有 shrink 候选仍在域内、严格更小',
      area: 'eval-kernel',
      gen: suchThat(
        record({ text: string({ maxLength: 6, alphabet: 'ab01' }), list: array(integer({ min: 0, max: 50 }), { maxLength: 4 }) }),
        (value) => value.text.length > 0 || value.list.length > 0,
      ),
      consumes: [SHRINK],
      check: (value) => {
        const candidates = record({ text: string({ maxLength: 6, alphabet: 'ab01' }), list: array(integer({ min: 0, max: 50 }), { maxLength: 4 }) }).shrink(value);
        assert(candidates.length > 0, '非空记录没有任何 shrink 候选', { actual: value });
        for (const candidate of candidates) {
          assert(totalSize(candidate) < totalSize(value), 'shrink 候选没有变小', { expected: '<' + totalSize(value), actual: totalSize(candidate) });
        }
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/shrink-greedy-is-minimal',
      title: 'greedyShrink 产出 1-minimal 反例（长度阈值样例）',
      area: 'eval-kernel',
      gen: array(integer({ min: 0, max: 100 }), { minLength: 2, maxLength: 6 }),
      consumes: [SHRINK],
      check: async (value) => {
        const predicate = (candidate) => Array.isArray(candidate) && candidate.length >= 2;
        const shrinker = (candidate) => array(integer({ min: 0, max: 100 }), { minLength: 0, maxLength: 6 }).shrink(candidate);
        const shrunk = await greedyShrink({ value, fails: (candidate) => predicate(candidate), shrink: shrinker });
        assert(predicate(shrunk.minimal), '收缩后不再满足失败条件', { actual: shrunk.minimal });
        assertEqual(shrunk.minimal.length, 2, 'minimal 长度不是 2', { actual: shrunk.minimal });
        assert(shrunk.minimal.every((item) => item === 0), 'minimal 元素没有收缩到 0', { actual: shrunk.minimal });
        const minimality = await measureMinimality({ value: shrunk.minimal, fails: (candidate) => predicate(candidate), shrink: shrinker });
        assert(minimality.minimal, 'minimal 不满足 1-minimal', { actual: minimality.candidate });
        assert(totalSize(shrunk.minimal) <= totalSize(value), '收缩后反而变大');
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/shrink-unicode-well-formed',
      title: '字符串收缩保持 Unicode 标量完整（不产生孤立代理项）',
      area: 'eval-kernel',
      gen: unicodeGen,
      consumes: [SHRINK],
      check: (value) => {
        const candidates = unicodeGen.shrink(value);
        for (const candidate of candidates) {
          const points = Array.from(candidate).map((char) => char.codePointAt(0));
          assertEqual(String.fromCodePoint(...points), candidate, '收缩候选不是合法 Unicode 标量序列', { actual: candidate });
          assert(totalSize(candidate) < totalSize(value), 'Unicode 收缩候选没有变小');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/report-digest-stable',
      title: '报告 digest 稳定且可校验，结构检查通过',
      area: 'eval-kernel',
      gen: integer({ min: 0, max: 0xffffff }),
      consumes: [REPORT],
      check: (seed) => {
        const consume = { file: 'tools/eval/lib/prng.mjs', symbol: 'createRng', line: 1, location: 'tools/eval/lib/prng.mjs:1', text: 'export function createRng(seed)' };
        const result = {
          id: 'eval-kernel/probe',
          area: 'eval-kernel',
          title: 'probe',
          status: 'passed',
          source: 'tools/eval/corpus/harness-self.mjs:1',
          generator: { kind: 'integer', name: 'integer' },
          checksRun: 1,
          examples: 0,
          failureCount: 0,
          tags: [],
          failures: [],
          consumes: [consume],
        };
        const input = {
          seed,
          cases: 1,
          results: [result],
          areas: [
            { area: 'eval-kernel', title: 'kernel', source: 'tools/eval/corpus/harness-self.mjs', properties: 1 },
            ...['vom-geometry', 'observe-diff', 'session-queue', 'intent-ledger', 'protocol-state'].map((name) => ({ area: name, title: name, source: 'x', properties: 0 })),
          ],
          determinism: { verified: true, mismatches: [] },
        };
        const first = buildReport(input);
        const second = buildReport(input);
        assertEqual(first.digest, second.digest, '同输入报告 digest 不稳定');
        assert(verifyDigest(first).ok, '报告 digest 校验失败', { actual: first.digest });
        const issues = verifyReport(first);
        assertEqual(issues.length, 0, '报告结构检查失败', { actual: issues });
        assertEqual(stableStringify(first), stableStringify(second), '同输入报告序列化不一致');
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/report-stable-stringify',
      title: 'stableStringify 递归排序对象键（报告可复现的基础）',
      area: 'eval-kernel',
      gen: record({ a: integer({ min: 0, max: 9 }), b: string({ maxLength: 3, alphabet: 'xy' }), c: array(integer({ min: 0, max: 9 }), { maxLength: 3 }) }),
      consumes: [REPORT],
      check: (value) => {
        const reordered = { c: value.c, b: value.b, a: value.a };
        assertEqual(stableStringify(value), stableStringify(reordered), '对象键顺序影响了稳定序列化');
        assertEqual(stableStringify([value, reordered]), stableStringify([value, reordered]), '数组序列化不稳定');
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/source-symbol-locator',
      title: '源码定位器返回真实 file:line，且优先命中导出声明',
      area: 'eval-kernel',
      gen: oneOf([
        constant({ file: 'tools/eval/lib/prng.mjs', symbol: 'createRng' }),
        constant({ file: 'tools/eval/lib/shrink.mjs', symbol: 'greedyShrink' }),
        constant({ file: 'tools/eval/lib/report.mjs', symbol: 'verifyReport' }),
        constant({ file: 'lib/session-queue.mjs', symbol: 'createSessionQueue' }),
        constant({ file: 'lib/observation-delta.mjs', symbol: 'diffObservation' }),
      ]),
      consumes: [SOURCE],
      check: ({ file, symbol }) => {
        const located = locateSymbol(file, symbol);
        assertEqual(located.file, file, '定位器返回的文件不符');
        assert(located.line >= 1, '定位器返回非法行号', { actual: located.line });
        assert(located.text.includes(symbol), '定位行不含符号名', { actual: located.text });
        assertEqual(located.location, file + ':' + located.line, 'location 格式不符');
        const match = findSymbolLine(`const ${symbol} = 1;\nexport function ${symbol}() {}\n`, symbol);
        assert(match && match.strength === 0, 'findSymbolLine 没有优先命中 export function', { actual: match });
        const exports = listExports('tools/eval/lib/prng.mjs');
        const entry = exports.find((item) => item.name === 'createRng');
        assert(entry && entry.line === locateSymbol('tools/eval/lib/prng.mjs', 'createRng').line, 'listExports 与 locateSymbol 行号不一致');
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/manual-clock-deterministic',
      title: '手动时钟可推进且不读取真实时间',
      area: 'eval-kernel',
      gen: record({ start: integer({ min: 0, max: 1000000 }), steps: array(natural({ max: 1000 }), { minLength: 1, maxLength: 4 }) }),
      consumes: [CLOCK],
      check: ({ start, steps }) => {
        const clock = createManualClock(start);
        let expected = start;
        assertEqual(clock.now(), start, '初始时间不符');
        for (const step of steps) {
          expected += step;
          assertEqual(clock.advance(step), expected, 'advance 返回不符');
          assertEqual(clock.now(), expected, 'now 不随 advance 变化');
        }
        assertEqual(clock.advances(), steps.length, 'advances 计数不符');
        assertEqual(clock.iso(), new Date(expected).toISOString(), 'iso 与手动时间不一致');
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/assertion-error-deterministic',
      title: '断言错误消息与证据是确定性的（不含随机/时间）',
      area: 'eval-kernel',
      gen: record({ left: integer({ min: -9, max: 9 }), right: integer({ min: -9, max: 9 }) }),
      consumes: [SOURCE],
      check: ({ left, right }) => {
        const first = captureCode(() => assertEqual(left, right, '期望相等'));
        const second = captureCode(() => assertEqual(left, right, '期望相等'));
        assertEqual(first.code, second.code, '断言错误码不稳定');
        assertEqual(first.message, second.message, '断言错误消息不稳定');
        const error = (() => {
          try {
            assertEqual(left, right, '期望相等');
            return null;
          } catch (thrown) {
            return thrown;
          }
        })();
        if (left === right) {
          assertEqual(error, null, '相等值不应抛错');
          return true;
        }
        assert(error instanceof EvalAssertionError, '抛出的不是 EvalAssertionError');
        assert(Number.isFinite(error.actual) && Number.isFinite(error.expected), '断言证据不是数字');
        assertEqual(stableStringify(error.actual), stableStringify(left), '断言 actual 证据不符');
        return true;
      },
    }),
    defineProperty({
      id: 'eval-kernel/report-runtime-aggregation',
      title: 'runtime 消费表按 file/line 聚合，重复符号合并计数',
      area: 'eval-kernel',
      gen: integer({ min: 1, max: 100 }),
      consumes: [REPORT],
      check: (checks) => {
        const consume = { file: 'lib/session-queue.mjs', symbol: 'createSessionQueue', line: 15, location: 'lib/session-queue.mjs:15', text: 'export function createSessionQueue' };
        const base = {
          title: 't', status: 'passed', source: 's', generator: { kind: 'k', name: 'n' },
          examples: 0, failures: [], tags: [], consumes: [consume],
        };
        const body = buildReport({
          seed: 1,
          cases: 1,
          results: [
            { ...base, id: 'a/x', area: 'a', checksRun: checks, failureCount: 0 },
            { ...base, id: 'a/y', area: 'a', checksRun: checks, failureCount: 0 },
          ],
          areas: [{ area: 'a', title: 'a', source: 's', properties: 2 }],
          determinism: { verified: true, mismatches: [] },
        });
        const row = body.runtime.find((item) => item.symbol === 'createSessionQueue');
        assert(row, 'runtime 表缺少消费点');
        assertEqual(row.propertyCount, 2, 'runtime 聚合的 property 数不符');
        assertEqual(row.checks, checks * 2, 'runtime 聚合的 checks 数不符');
        return true;
      },
    }),
  ],
};

export default area;
