/**
 * tools/eval/corpus/observe-diff.mjs -- invariants for observation text diffs.
 *
 * Runtime under test: lib/observation-delta.mjs
 *   - `diffObservation(previous, next)` classifies a change as
 *     same | text | structural-text | structural and emits a patch;
 *   - `applyObservationPatch(previous, patch)` replays text / structural-text
 *     patches locally; structural changes must NOT fabricate a patch.
 *
 * The generators produce observation-like line documents (role + label + ref)
 * and localized edits (replace / insert / delete). The key property is the
 * apply-roundtrip: for every non-structural classification, applying the
 * emitted patch to the previous text must reconstruct the next text exactly.
 */

import { defineProperty } from '../lib/property.mjs';
import { array, constant, integer, map, oneOf, record, string, suchThat } from '../lib/gen.mjs';
import { assert, assertDeepEqual, assertEqual, assertJsonSafe } from '../lib/assert.mjs';
import { applyObservationPatch, diffObservation, observationLines } from '../../../lib/observation-delta.mjs';

const REMOTE = { file: 'lib/observation-delta.mjs', symbol: 'diffObservation' };
const APPLY = { file: 'lib/observation-delta.mjs', symbol: 'applyObservationPatch' };
const LINES = { file: 'lib/observation-delta.mjs', symbol: 'observationLines' };

const labelGen = string({ minLength: 0, maxLength: 6, alphabet: 'abc XYZ01' });
const roleGen = oneOf([constant('button'), constant('textbox'), constant('link'), constant('heading'), constant('checkbox')]);

function lineOf(role, label, ref) {
  return '- ' + role + ' "' + label + '"' + (ref ? ' [ref=' + ref + ']' : '');
}

const refGen = map(integer({ min: 1, max: 9 }), (number) => '@e' + number);
const lineGen = map(record({ role: roleGen, label: labelGen, ref: oneOf([constant(null), refGen]) }), (value) => lineOf(value.role, value.label, value.ref));
const docGen = array(lineGen, { minLength: 0, maxLength: 6 });

function textOf(lines) {
  return Array.isArray(lines) ? lines.join('\n') : '';
}

const pairGen = record({ before: docGen, after: docGen });

const sameLengthPairGen = record({
  base: array(record({ role: roleGen, label: labelGen, ref: refGen }), { minLength: 1, maxLength: 4 }),
  newLabels: array(labelGen, { minLength: 1, maxLength: 4 }),
});

function sameLengthPair(value) {
  const before = value.base.map((item) => lineOf(item.role, item.label, item.ref));
  const after = value.base.map((item, index) => lineOf(item.role, value.newLabels[index] === undefined ? item.label : value.newLabels[index], item.ref));
  return { before, after };
}

const refChangedPairGen = record({
  base: array(record({ role: roleGen, label: labelGen, ref: refGen }), { minLength: 1, maxLength: 4 }),
  newRefs: array(refGen, { minLength: 1, maxLength: 4 }),
});

function refChangedPair(value) {
  const before = value.base.map((item) => lineOf(item.role, item.label, item.ref));
  const after = value.base.map((item, index) => lineOf(item.role, item.label, value.newRefs[index] === undefined ? item.ref : value.newRefs[index]));
  return { before, after };
}

const editGen = suchThat(record({
  base: array(lineGen, { minLength: 1, maxLength: 5 }),
  position: integer({ min: 0, max: 4 }),
  insert: array(lineGen, { minLength: 1, maxLength: 3 }),
  replaceCount: integer({ min: 1, max: 2 }),
}), (value) => value.base.length > 0);

function applyEdit(value) {
  const position = Math.min(value.position, value.base.length);
  const before = value.base.slice();
  const after = before.slice(0, position).concat(value.insert, before.slice(position + value.replaceCount));
  return { before, after };
}

const appendGen = record({
  base: array(lineGen, { minLength: 0, maxLength: 4 }),
  appended: array(lineGen, { minLength: 1, maxLength: 3 }),
});

const deleteGen = record({
  base: array(lineGen, { minLength: 1, maxLength: 5 }),
  position: integer({ min: 0, max: 4 }),
  count: integer({ min: 1, max: 3 }),
});

export const area = {
  area: 'observe-diff',
  title: '观察文本增量 diff / patch 的不变量（分类、最小、可回放）',
  properties: [
    defineProperty({
      id: 'observe-diff/same-text',
      title: '同一文本 diff 为 same，零 patch 零 changes',
      area: 'observe-diff',
      gen: docGen,
      consumes: [REMOTE],
      check: (lines) => {
        const text = textOf(lines);
        const result = diffObservation(text, text);
        assertEqual(result.kind, 'same', '相同文本没有被判为 same');
        assertDeepEqual(result.patch, [], 'same 情况 patch 不为空');
        assertEqual(result.changes, 0, 'same 情况 changes 不为 0');
        assertJsonSafe(result, 'diff 结果不是 JSON 安全值');
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/apply-roundtrip',
      title: '非 structural 分类的 patch 应用后精确重建 next 文本',
      area: 'observe-diff',
      gen: pairGen,
      consumes: [REMOTE, APPLY],
      check: ({ before, after }) => {
        const previous = textOf(before);
        const next = textOf(after);
        const result = diffObservation(previous, next);
        if (result.kind === 'structural') {
          assertDeepEqual(result.patch, [], 'structural 分类不应伪造 patch');
          assertEqual(result.changes, 0, 'structural 分类 changes 应为 0');
          return true;
        }
        const applied = applyObservationPatch(previous, result.patch);
        assertEqual(applied, next, '应用 patch 没有重建 next 文本', { actual: { kind: result.kind, patch: result.patch } });
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/changes-consistency',
      title: 'kind 与 patch/changes 的组合关系自洽',
      area: 'observe-diff',
      gen: pairGen,
      consumes: [REMOTE],
      check: ({ before, after }) => {
        const result = diffObservation(textOf(before), textOf(after));
        switch (result.kind) {
          case 'same':
            assertEqual(result.changes, 0, 'same changes != 0');
            assertEqual(result.patch.length, 0, 'same patch 非空');
            break;
          case 'text':
            assert(result.changes > 0, 'text changes 应为正数');
            assertEqual(result.changes, result.patch.length, 'text changes != patch 数');
            for (const entry of result.patch) {
              assertEqual(typeof entry.value, 'string', 'text patch 项缺少字符串 value');
              assert(Number.isInteger(entry.line) && entry.line >= 0, 'text patch 行号非法');
            }
            break;
          case 'structural-text':
            assert(Array.isArray(result.ops), 'structural-text 缺少 ops');
            assertDeepEqual(result.patch, result.ops, 'structural-text patch 与 ops 不一致');
            assert(result.changes > 0, 'structural-text changes 应为正数');
            const opKinds = result.ops.map((op) => op.op);
            assert(opKinds.every((kind) => kind === 'remove' || kind === 'insert'), 'structural-text 出现未知 op', { actual: opKinds });
            assert(opKinds.length <= 2, 'structural-text op 数量超过 2');
            if (opKinds.length === 2) assertDeepEqual(opKinds, ['remove', 'insert'], 'remove/insert op 顺序不稳定');
            const removeTotal = result.ops.filter((op) => op.op === 'remove').reduce((sum, op) => sum + op.count, 0);
            const insertTotal = result.ops.filter((op) => op.op === 'insert').reduce((sum, op) => sum + op.lines.length, 0);
            assertEqual(result.changes, removeTotal + insertTotal, 'structural-text changes 与删除+插入行数不符');
            break;
          case 'structural':
            assertEqual(result.changes, 0, 'structural changes != 0');
            assertDeepEqual(result.patch, [], 'structural patch 非空');
            assert(typeof result.reason === 'string' && result.reason.length > 0, 'structural 缺少 reason');
            break;
          default:
            assert(false, '未知 diff kind：' + String(result.kind), { actual: result.kind });
        }
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/patch-index-bounds',
      title: 'text/structural-text patch 的行号与计数落在原文范围内',
      area: 'observe-diff',
      gen: pairGen,
      consumes: [REMOTE, APPLY],
      check: ({ before, after }) => {
        const previous = textOf(before);
        const next = textOf(after);
        const result = diffObservation(previous, next);
        const beforeLines = observationLines(previous);
        const afterLines = observationLines(next);
        if (result.kind === 'text') {
          for (const entry of result.patch) {
            assert(entry.line >= 0 && entry.line < afterLines.length, 'text patch 行号越界', { actual: entry.line });
          }
        }
        if (result.kind === 'structural-text') {
          for (const op of result.ops) {
            if (op.op === 'remove') {
              assert(Number.isInteger(op.count) && op.count > 0, 'remove op count 非法');
              assert(op.line >= 0 && op.line + op.count <= beforeLines.length, 'remove op 范围越界', { actual: op });
            } else if (op.op === 'insert') {
              assert(Array.isArray(op.lines) && op.lines.length > 0, 'insert op lines 为空');
              assert(op.lines.every((line) => typeof line === 'string'), 'insert op lines 含非字符串');
              assert(op.line >= 0 && op.line <= beforeLines.length, 'insert op 行号越界', { actual: op });
            } else {
              assert(false, 'structural-text 出现未知 op：' + String(op.op), { actual: op.op });
            }
          }
        }
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/text-prefix-suffix-stable',
      title: 'text 分类只改中间一行段，前后缀逐行不变',
      area: 'observe-diff',
      gen: suchThat(sameLengthPairGen, (value) => value.base.length > 0 && value.newLabels.length > 0),
      consumes: [REMOTE, APPLY],
      check: (value) => {
        const { before, after } = sameLengthPair(value);
        const result = diffObservation(textOf(before), textOf(after));
        if (result.kind === 'same') {
          assertDeepEqual(before, after, 'same 分类但文本不同');
          return true;
        }
        assertEqual(result.kind, 'text', '同长度同 ref 的标签变化应判为 text', { actual: result.kind });
        const start = result.patch[0].line;
        const count = result.patch.length;
        assertDeepEqual(before.slice(0, start), after.slice(0, start), 'text 前缀被改动');
        assertDeepEqual(before.slice(start + count), after.slice(start + count), 'text 后缀被改动');
        for (const entry of result.patch) {
          assertEqual(after[entry.line], entry.value, 'patch value 与 next 行不符');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/localized-single-line',
      title: '单行标签修改生成单条 text patch（line == 修改行）',
      area: 'observe-diff',
      gen: suchThat(record({
        base: array(record({ role: roleGen, label: labelGen, ref: refGen }), { minLength: 1, maxLength: 5 }),
        index: integer({ min: 0, max: 4 }),
        label: labelGen,
      }), (value) => value.index < value.base.length && value.label !== value.base[value.index].label),
      consumes: [REMOTE, APPLY],
      check: ({ base, index, label }) => {
        const before = base.map((item) => lineOf(item.role, item.label, item.ref));
        const after = before.slice();
        after[index] = lineOf(base[index].role, label, base[index].ref);
        const result = diffObservation(textOf(before), textOf(after));
        assertEqual(result.kind, 'text', '单行标签修改没有判为 text');
        assertEqual(result.patch.length, 1, '单行修改 patch 长度不为 1', { actual: result.patch });
        assertEqual(result.patch[0].line, index, 'patch 行号不是修改行');
        assertEqual(result.changes, 1, '单行修改 changes 不为 1');
        assertEqual(applyObservationPatch(textOf(before), result.patch), textOf(after), '单行 patch 无法回放');
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/ref-change-structural',
      title: 'ref 序列变化必须判为 structural(refs)，不允许本地拼 patch',
      area: 'observe-diff',
      gen: suchThat(refChangedPairGen, (value) => {
        const { before, after } = refChangedPair(value);
        return before.some((line, index) => line !== after[index]);
      }),
      consumes: [REMOTE],
      check: (value) => {
        const { before, after } = refChangedPair(value);
        const result = diffObservation(textOf(before), textOf(after));
        assertEqual(result.kind, 'structural', 'ref 变化没有判为 structural');
        assertEqual(result.reason, 'refs', 'structural 原因不是 refs');
        assertDeepEqual(result.patch, [], 'structural(refs) 不应带 patch');
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/append-insert-op',
      title: '尾部追加生成单个 insert op，且回放正确',
      area: 'observe-diff',
      gen: appendGen,
      consumes: [REMOTE, APPLY],
      check: ({ base, appended }) => {
        const before = textOf(base);
        const after = textOf(base.concat(appended));
        const result = diffObservation(before, after);
        assertEqual(result.kind, 'structural-text', '尾部追加没有判为 structural-text', { actual: result.kind });
        assertEqual(result.ops.length, 1, '尾部追加 op 数量不为 1', { actual: result.ops });
        const op = result.ops[0];
        assertEqual(op.op, 'insert', '尾部追加第一个 op 不是 insert');
        assertEqual(op.line, base.length, '插入行号不是原文末尾');
        assertDeepEqual(op.lines, appended, '插入内容与追加内容不一致');
        assertEqual(result.changes, appended.length, 'changes 不等于追加行数');
        assertEqual(applyObservationPatch(before, result.patch), after, '追加 patch 无法回放');
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/delete-remove-op',
      title: '中间删除生成单个 remove op，count 与回放正确',
      area: 'observe-diff',
      gen: deleteGen,
      consumes: [REMOTE, APPLY],
      check: ({ base, position, count }) => {
        const start = Math.min(position, Math.max(0, base.length - 1));
        const removed = Math.min(count, base.length - start);
        const before = textOf(base);
        const after = textOf(base.slice(0, start).concat(base.slice(start + removed)));
        const result = diffObservation(before, after);
        assertEqual(result.kind, 'structural-text', '中间删除没有判为 structural-text', { actual: result.kind });
        assertEqual(result.ops.length, 1, '中间删除 op 数量不为 1', { actual: result.ops });
        const op = result.ops[0];
        assertEqual(op.op, 'remove', '删除 op 不是 remove');
        assertEqual(op.line, start, 'remove 行号不是删除起点');
        assertEqual(op.count, removed, 'remove count 不符');
        assertEqual(result.changes, removed, 'changes 不等于删除行数');
        assertEqual(applyObservationPatch(before, result.patch), after, '删除 patch 无法回放');
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/edit-localized-roundtrip',
      title: '随机局部替换/插入编辑：diff 可回放且改动量有界',
      area: 'observe-diff',
      gen: editGen,
      consumes: [REMOTE, APPLY],
      check: (value) => {
        const { before, after } = applyEdit(value);
        const result = diffObservation(textOf(before), textOf(after));
        if (result.kind === 'structural') {
          // A ref shuffle in the edited range legitimately falls back to a full refetch.
          assert(result.reason === 'refs', '局部编辑产生非 refs 的 structural', { actual: result.reason });
          return true;
        }
        assert(result.kind === 'text' || result.kind === 'structural-text', '局部编辑产生了意外分类', { actual: result.kind });
        assertEqual(applyObservationPatch(textOf(before), result.patch), textOf(after), '局部编辑 patch 无法回放');
        assert(result.changes <= before.length + after.length, '局部编辑改动量异常放大');
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/deterministic',
      title: '同输入 diff 结果稳定，observationLines 与 split 语义一致',
      area: 'observe-diff',
      gen: pairGen,
      consumes: [REMOTE, LINES],
      check: ({ before, after }) => {
        const previous = textOf(before);
        const next = textOf(after);
        const first = diffObservation(previous, next);
        const second = diffObservation(previous, next);
        assertDeepEqual(first, second, 'diff 结果不确定');
        assertDeepEqual(observationLines(previous), previous ? previous.split('\n') : [], 'observationLines 与 split 不一致');
        assertDeepEqual(observationLines(''), [], '空串应返回空数组');
        assertDeepEqual(observationLines(42), [], '非字符串应返回空数组');
        assertDeepEqual(observationLines(null), [], 'null 应返回空数组');
        assertEqual(observationLines(before.join('\n')).join('\n'), before.join('\n'), 'lines join 不可往返');
        return true;
      },
    }),
    defineProperty({
      id: 'observe-diff/apply-empty-and-invalid',
      title: '空/非法 patch 是恒等操作（不破坏原文）',
      area: 'observe-diff',
      gen: docGen,
      consumes: [APPLY],
      check: (lines) => {
        const text = textOf(lines);
        assertEqual(applyObservationPatch(text, []), text, '空 patch 改变了文本');
        assertEqual(applyObservationPatch(text, null), text, 'null patch 改变了文本');
        assertEqual(applyObservationPatch(text, 'not-an-array'), text, '非数组 patch 改变了文本');
        const invalid = [null, { line: -1 }, { line: 9999, value: 'x' }, { line: 1.5, value: 'x' }, {}, { line: 0, op: 'insert', lines: [] }, { line: 0, op: 'remove', count: 0 }];
        assertEqual(applyObservationPatch(text, invalid), text, '非法 patch 改变了文本');
        return true;
      },
    }),
  ],
};

export default area;
