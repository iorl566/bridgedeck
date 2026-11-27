// packages/vom/test/compress-diff.test.ts —— 语义压缩（组折叠/关系折叠）JS ↔ TS 差分测试。
//
// 覆盖边界：空/非对象输入、context.groups / 旧 groups / semantic.nodes 三种分组来源与优先级、
// 重叠组只折一次、成员数不足不折、maxFolds/sampleNames/minMembers 上限、关系折叠的
// minCount/targets/sources 口径、includeRelationFolds=false、CJK/emoji token 计费、以及
// report 的 before/after/saved/ratio 自洽。
//
// tokens（estimateTextTokens/estimateVomTokens）也在这里对拍：压缩计费与预算裁剪共用同一口径。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPRESSION_LIMITS,
  VOM_COMPRESSION_VERSION,
  compressVomByRelations,
  estimateTextTokens,
  estimateVomTokens,
  summarizeVomCompression,
  VOM_TOKEN_SAFETY_FACTOR,
} from '../src/index.ts';
import type { VomCompressInput, VomCompressOptions } from '../src/index.ts';

const js: any = await import('../../../extension/src/lib/vom-compress.js');
const jsWeights: any = await import('../../../extension/src/lib/vom-weights.js');

function asInput(value: unknown): VomCompressInput {
  return value as VomCompressInput;
}

function asOptions(value: unknown): VomCompressOptions {
  return value as VomCompressOptions;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function node(id: unknown, name: unknown, role: unknown): Record<string, unknown> {
  return { id, name, role };
}

const NODES: readonly Record<string, unknown>[] = [
  node('@n1', '姓名', 'textbox'),
  node('@n2', '年龄', 'textbox'),
  node('@n3', '邮箱', 'textbox'),
  node('@n4', '提交', 'button'),
  node('@n5', '', 'generic'),
  node('@n6', '北京', 'option'),
  node('@n7', '上海', 'option'),
  node('@n8', '广州', 'option'),
  node('@n9', '深圳', 'option'),
  node('@n10', 'emojis 😀🚀', 'link'),
  node('@n11', null, null),
  node('@n12', 'long name ' + 'x'.repeat(120), 'heading'),
];

const CASES: readonly { label: string; input: unknown }[] = [
  { label: '空输入', input: {} },
  { label: 'undefined', input: undefined },
  { label: '非对象输入', input: 'nope' },
  { label: 'non-array nodes', input: { nodes: { a: 1 }, context: null, groups: null, semantic: null } },
  {
    label: 'context.groups 折叠',
    input: {
      nodes: NODES,
      context: {
        groups: [
          { id: 'ctx:form:f1', kind: 'form', groupKind: 'form', name: '登录表单', role: 'form', memberIds: ['@n1', '@n2', '@n3'], tokens: 90 },
          { id: 'ctx:table:t1', kind: 'table', groupKind: 'table', name: '用户表', role: 'table', memberIds: ['@n1', '@n4', '@n8'], tokens: 60 },
          { id: 'ctx:landmark:l1', kind: 'landmark', groupKind: 'navigation', memberIds: ['@n4', '@n10'], tokens: 30 },
          { id: 'ctx:form:f2', kind: 'form', groupKind: 'form', memberIds: ['@n6'], tokens: 10 },
          { id: 'ctx:form:f3', groupKind: 'form', memberIds: ['@n11', '@n12', '@missing'], tokens: 12 },
          { id: 'ctx:form:f4', kind: 'form', memberIds: '@n1' },
          null,
        ],
      },
    },
  },
  {
    label: '重叠组：先折叠的组赢，后续组只计算剩余成员',
    input: {
      nodes: NODES.slice(0, 6),
      context: {
        groups: [
          { id: 'g1', kind: 'table', memberIds: ['@n1', '@n2', '@n3'], tokens: 10 },
          { id: 'g2', kind: 'form', memberIds: ['@n1', '@n2', '@n4', '@n5'], tokens: 20 },
          { id: 'g3', kind: 'landmark', memberIds: ['@n4', '@n5', '@n6'], tokens: 30 },
        ],
      },
    },
  },
  {
    label: '旧 groups（sections/rows/forms）来源',
    input: {
      nodes: NODES.slice(0, 8),
      groups: {
        sections: [
          { id: 's1', anchor: { id: 'main', role: 'main' }, nodeIds: ['@n1', '@n2', '@n3'], tokens: 33 },
          { id: 's2', nodeIds: ['@n4', '@n5'] },
        ],
        rows: [{ id: 'r1', anchor: { role: 'row' }, nodeIds: ['@n6', '@n7'] }],
        forms: [{ id: 'fm1', anchor: { id: 'login' }, nodeIds: ['@n8'] }],
      },
    },
  },
  {
    label: 'semantic.nodes 兜底来源',
    input: {
      nodes: NODES.slice(0, 8),
      semantic: {
        nodes: [
          { id: 'g1', groupKind: 'section', memberIds: ['@n1', '@n2', '@n3'], tokens: 44 },
          { id: 'g2', groupKind: 'table', memberIds: ['@n4', '@n5', '@n6'], tokens: 55 },
          { id: 'g3', memberIds: ['@n7'] },
        ],
      },
    },
  },
  {
    label: '关系折叠（minCount / targets / sources）',
    input: {
      nodes: NODES.slice(0, 4),
      relations: [
        { type: 'controls', from: '@a', to: '@x1', confidence: 0.95, source: 'aria-controls' },
        { type: 'controls', from: '@a', to: '@x2', confidence: 0.9, source: 'aria-controls' },
        { type: 'controls', from: '@a', to: '@x3', confidence: 0.95, source: 'aria-controls' },
        { type: 'controls', from: '@a', to: '@x4', confidence: 0.85, source: 'aria-controls' },
        { type: 'controls', from: '@a', to: '@x5', confidence: 0.9, source: 'aria-controls' },
        { type: 'labels', from: '@b', to: '@y1', confidence: 0.9, source: 'aria-labelledby', sources: ['aria-labelledby', 'html-for'] },
        { type: 'labels', from: '@b', to: '@y2', confidence: 0.9, source: 'aria-labelledby' },
        { type: 'labels', from: '@b', to: '@y3', confidence: 0.9, source: 'aria-labelledby' },
        { type: 'owns', from: '@c', to: '@z1', confidence: 0.8, source: 'aria-owns' },
        { type: 'owns', from: '@c', to: '@z2', source: 'aria-owns' },
        { type: 'owns', from: '@c', to: '@z3', source: 'aria-owns' },
        { type: '', from: '@c', to: '@z3' },
        { from: '@c', to: '@z3' },
        { type: 'owns', to: '@z3' },
        null,
      ],
    },
  },
  {
    label: '关系折叠：{relations} 包装 + 默认 minCount 不折叠',
    input: {
      nodes: NODES.slice(0, 3),
      relationFolds: 'not-an-array',
      relations: {
        relations: [
          { type: 'labels', from: '@q', to: '@t1', confidence: 0.5 },
          { type: 'labels', from: '@q', to: '@t2', confidence: 0.5 },
        ],
      },
    },
  },
  {
    label: 'CJK/emoji 长文本与缺失 role/name',
    input: {
      nodes: [node('@c1', '中文名字😀🚀 mixed text', 'textbox'), node('@c2', '  ', ' '), node('@c3', null, undefined)],
      context: {
        groups: [
          { id: 'cjk', kind: 'form', name: '中文表单', memberIds: ['@c1', '@c2', '@c3'], tokens: 1 },
        ],
      },
    },
  },
  {
    label: 'context.groups 为空时回落到旧 groups',
    input: {
      nodes: NODES.slice(0, 6),
      context: { groups: [] },
      groups: { sections: [{ id: 's', anchor: { id: 'main', role: 'main' }, nodeIds: ['@n1', '@n2', '@n3'], tokens: 7 }] },
    },
  },
  {
    label: '重复节点 id / 非字符串 name',
    input: {
      nodes: [node('@dup', 'A', 'textbox'), node('@dup', 'B', 'textbox'), node('@n3', 42, 'button')],
      context: { groups: [{ id: 'g', kind: 'form', memberIds: ['@dup', '@n3'], tokens: 3 }] },
    },
  },
  {
    label: '异常分组事实：非字符串 id / kind 非字符串',
    input: {
      nodes: NODES.slice(0, 5),
      context: {
        groups: [
          { id: 42, kind: 7, groupKind: 8, name: 9, role: 10, memberIds: ['@n1', '@n2'], tokens: 'abc' },
          { id: 'g2', kind: 'form', groupKind: 'form', memberIds: ['@n3', '@n4'], tokens: 0 },
        ],
      },
    },
  },
];

/** 覆盖默认与自定义上限/开关。 */
const OPTIONS: readonly { label: string; options: unknown }[] = [
  { label: '默认', options: {} },
  { label: 'sampleNames=1', options: { sampleNames: 1 } },
  { label: 'minMembers=3', options: { minMembers: 3 } },
  { label: 'maxFolds=1', options: { maxFolds: 1 } },
  { label: '关闭关系折叠', options: { includeRelationFolds: false } },
  { label: 'relationFoldMin=2 + relationTos=2 + relationFolds=1', options: { relationFoldMin: 2, relationTos: 2, relationFolds: 1 } },
  { label: '非法选项值', options: { maxFolds: -1, sampleNames: 'x', minMembers: 0, relationFoldMin: null } },
];

function buildPair(value: unknown, options: unknown): { ts: any; jsResult: any } {
  const inputValue = value === undefined ? {} : value;
  const optionValue = options === undefined ? {} : options;
  return {
    ts: compressVomByRelations(asInput(inputValue), asOptions(optionValue)),
    jsResult: js.compressVomByRelations(inputValue, optionValue),
  };
}

test('compressVomByRelations：全部用例 × 选项矩阵逐字段相等', () => {
  for (const { label, input } of CASES) {
    for (const { label: optionLabel, options } of OPTIONS) {
      const { ts, jsResult } = buildPair(input, options);
      assert.deepEqual(clone(ts), clone(jsResult), label + ' / ' + optionLabel + ' 的压缩结果不一致');
    }
  }
});

test('estimateTextTokens / estimateVomTokens：CJK/emoji/空白矩阵逐项相等', () => {
  const TEXTS: readonly unknown[] = [
    '', ' ', '   ', 'hello', 'hello world', '中文', '中文 English 混排', '😀', '😀🚀', '中😀',
    'アカサタナ', '한국어', 'ｆｕｌｌｗｉｄｔｈ', 'ｆｕｌｌ', 'a'.repeat(100), '中'.repeat(100),
    'line\nbreak\ttab', 'x'.repeat(3) + '中'.repeat(3) + '😀', null, undefined, 0, false, 42,
  ];
  for (const text of TEXTS) {
    assert.equal(estimateTextTokens(text), jsWeights.estimateTextTokens(text), 'text=' + JSON.stringify(text) + ' 的 token 估算不一致');
  }
  const NODES_MATRIX: readonly unknown[] = [
    null, undefined, {}, { name: '提交' }, { role: 'button' }, { name: 'Submit', role: 'button' },
    { name: '', role: '' }, { name: 42, role: null }, { name: '中文', role: 'textbox' },
  ];
  for (const item of NODES_MATRIX) {
    assert.equal(
      estimateVomTokens(item as never),
      jsWeights.estimateVomTokens(item),
      'node=' + JSON.stringify(item) + ' 的节点 token 估算不一致',
    );
  }
  assert.equal(VOM_TOKEN_SAFETY_FACTOR, jsWeights.VOM_TOKEN_SAFETY_FACTOR);
  // 硬断言：CJK 一字约 1 token、其它 4 字 1 token，乘 1.1 后向上取整。
  assert.equal(estimateTextTokens('中'), Math.ceil(1 * 1.1));
  assert.equal(estimateTextTokens('abcd'), Math.ceil((4 / 4) * 1.1));
  assert.equal(estimateTextTokens('😀'), Math.ceil(2 * 1.1));
  assert.equal(estimateTextTokens('abcdefg '), Math.ceil((7 / 4) * 1.1));
  assert.equal(estimateVomTokens({ name: '', role: '' }), 8);
  assert.equal(estimateVomTokens({ name: '中', role: '' }), 8 + Math.ceil(1 * 1.1));
});

test('关键语义硬断言（不依赖 JS 对照）', () => {
  const input = CASES.find((item) => item.label === 'context.groups 折叠')?.input;
  const result = compressVomByRelations(asInput(input));
  assert.equal(result.version, VOM_COMPRESSION_VERSION);
  assert.equal(result.report.before.nodes, NODES.length);
  assert.equal(result.report.after.nodes, result.nodes.length + result.folded.length);
  assert.equal(result.report.folds, result.folded.length);
  assert.equal(result.report.foldedMembers, result.folded.reduce((sum, fold) => sum + fold.count, 0));
  assert.equal(result.report.foldedTokens, result.folded.reduce((sum, fold) => sum + fold.tokensSaved, 0));
  assert.equal(result.report.saved.nodes, result.folded.reduce((sum, fold) => sum + (fold.count - 1), 0));
  assert.ok(result.report.after.tokens <= result.report.before.tokens);

  // table 组先折叠（KIND_ORDER table=0）：成员 @n1/@n4/@n8 全部折入 table，
  // 同名成员在后续 form 组里不再计入，因此表单只剩 @n2/@n3 两名成员。
  const tableFold = result.folded.find((fold) => fold.id === 'fold:ctx:table:t1');
  assert.ok(tableFold, '缺少用户表折叠');
  assert.equal(tableFold?.kind, 'fold');
  assert.equal(tableFold?.role, 'group');
  assert.equal(tableFold?.name, '用户表 ×3');
  assert.deepEqual(clone(tableFold?.sampleNames), ['姓名', '提交', '广州']);
  assert.deepEqual(clone(tableFold?.roles), { textbox: 1, button: 1, option: 1 });
  assert.deepEqual(clone(tableFold?.memberIds), ['@n1', '@n4', '@n8']);
  assert.equal(tableFold?.tokensBefore, estimateVomTokens({ name: '姓名', role: 'textbox' })
    + estimateVomTokens({ name: '提交', role: 'button' })
    + estimateVomTokens({ name: '广州', role: 'option' }));
  assert.equal(tableFold?.tokens, estimateVomTokens({ name: '用户表 ×3', role: 'group' }));
  assert.equal(tableFold?.tokensSaved, Math.max(0, (tableFold?.tokensBefore ?? 0) - (tableFold?.tokens ?? 0)));
  assert.equal(tableFold?.ratio, Math.round(((tableFold?.tokens ?? 0) / (tableFold?.tokensBefore ?? 1)) * 1000) / 1000);

  const formFold = result.folded.find((fold) => fold.id === 'fold:ctx:form:f1');
  assert.equal(formFold?.name, '登录表单 ×2');
  assert.deepEqual(clone(formFold?.memberIds), ['@n2', '@n3']);
  assert.deepEqual(clone(result.report.byKind), { table: 1, form: 2 });

  // 重叠组：已被折叠的成员不再计入后续组（@n1/@n2 已在 g1，g2 只剩 @n4/@n5）。
  const overlap = compressVomByRelations(asInput(CASES.find((item) => item.label === '重叠组：先折叠的组赢，后续组只计算剩余成员')?.input));
  assert.deepEqual(clone(overlap.folded.map((fold) => fold.memberIds)), [['@n1', '@n2', '@n3'], ['@n4', '@n5']]);
  assert.deepEqual(clone(overlap.report.byKind), { table: 1, form: 1 });

  // 单成员组不折叠；空输入返回空报告。
  assert.equal(compressVomByRelations(asInput({ nodes: NODES.slice(0, 2), context: { groups: [{ id: 'g', kind: 'form', memberIds: ['@n1'] }] } })).folded.length, 0);
  assert.deepEqual(clone(compressVomByRelations()), {
    version: 1,
    nodes: [],
    folded: [],
    relationFolds: [],
    report: {
      before: { nodes: 0, tokens: 0 },
      after: { nodes: 0, tokens: 0 },
      saved: { nodes: 0, tokens: 0, ratio: 0 },
      folds: 0,
      foldedMembers: 0,
      foldedTokens: 0,
      byKind: {},
      relations: 0,
      relationFolds: 0,
      foldedRelations: 0,
    },
  });
});

test('关系折叠：count/targets/sources/averageConfidence 与排序逐字段相等', () => {
  const input = CASES.find((item) => item.label === '关系折叠（minCount / targets / sources）')?.input;
  const options = { relationFoldMin: 2, relationTos: 4, relationFolds: 10 };
  const ts = compressVomByRelations(asInput(input), options);
  const jsResult = js.compressVomByRelations(input, options);
  assert.deepEqual(clone(ts.relationFolds), clone(jsResult.relationFolds));
  assert.deepEqual(clone(ts.report), clone(jsResult.report));
  const controls = ts.relationFolds.find((fold) => fold.type === 'controls');
  assert.equal(controls?.count, 5);
  assert.equal(controls?.targets.length, 4, 'targets 上限 4');
  assert.deepEqual(clone(controls?.targets), ['@x1', '@x2', '@x3', '@x4']);
  assert.equal(controls?.averageConfidence, Math.round(((0.95 + 0.9 + 0.95 + 0.85 + 0.9) / 5) * 1000) / 1000);
  assert.deepEqual(clone(controls?.sources), ['aria-controls']);
  const labels = ts.relationFolds.find((fold) => fold.type === 'labels');
  assert.ok((labels?.sources ?? []).includes('html-for'), 'sources 应合并显式给出的第二个来源');
  // count 降序。
  const counts = ts.relationFolds.map((fold) => fold.count);
  assert.deepEqual(clone(counts), clone(counts.slice().sort((a, b) => b - a)));
  assert.equal(ts.relationFolds.length <= 10, true);
  assert.equal(ts.report.relations, 15, 'relations 计数是关系数组原始长度（含被折叠跳过项）');
});

test('选项开关生效：minMembers / sampleNames / maxFolds / includeRelationFolds', () => {
  const overlapped = CASES.find((item) => item.label === '重叠组：先折叠的组赢，后续组只计算剩余成员')?.input;
  // minMembers=3：g1（3 成员）与 g3（3 成员）折叠，g2 剩余 2 成员不折叠。
  const larger = compressVomByRelations(asInput(overlapped), { minMembers: 3 });
  assert.deepEqual(clone(larger.folded.map((fold) => fold.id)), ['fold:g1', 'fold:g3']);
  assert.equal(compressVomByRelations(asInput(overlapped), { maxFolds: 1 }).folded.length, 1);
  const samples = compressVomByRelations(asInput(CASES.find((item) => item.label === 'context.groups 折叠')?.input), { sampleNames: 1 });
  for (const fold of samples.folded) assert.ok(fold.sampleNames.length <= 1, 'sampleNames 上限 1 未生效');

  const relInput = CASES.find((item) => item.label === '关系折叠（minCount / targets / sources）')?.input;
  const noFolds = compressVomByRelations(asInput(relInput), { includeRelationFolds: false });
  assert.deepEqual(clone(noFolds.relationFolds), []);
  assert.equal(noFolds.report.relationFolds, 0);
  assert.equal(noFolds.report.foldedRelations, 0);
  // 默认 minCount = 3：两跳的 labels 组不折叠（{relations} 包装用例里只有 2 条）。
  const wrapped = CASES.find((item) => item.label === '关系折叠：{relations} 包装 + 默认 minCount 不折叠')?.input;
  assert.equal(compressVomByRelations(asInput(wrapped)).relationFolds.length, 0);
  assert.equal(compressVomByRelations(asInput(wrapped), { relationFoldMin: 2 }).relationFolds.length, 1);
});

test('summarizeVomCompression：结果/报告/异常输入逐字符相等', () => {
  const input = CASES.find((item) => item.label === 'context.groups 折叠')?.input;
  const result = compressVomByRelations(asInput(input));
  const inputs: readonly unknown[] = [
    result,
    result.report,
    null,
    undefined,
    {},
    { report: null },
    { before: { nodes: 1 }, after: { nodes: 1 }, saved: { tokens: 0, ratio: 0 }, folds: 0, foldedMembers: 0, relationFolds: 0 },
    'nope',
    42,
  ];
  for (const item of inputs) {
    assert.equal(summarizeVomCompression(item), js.summarizeVomCompression(item), 'summary 输入 ' + JSON.stringify(item) + ' 不一致');
  }
  assert.match(summarizeVomCompression(result), /^nodes \d+→\d+ tokens \d+→\d+ saved=\d+ \(\d+%\) folds=\d+ members=\d+ relation-folds=\d+$/);
});

test('输出不变量：折叠 id 唯一、成员不重复、统计自洽', () => {
  for (const { label, input } of CASES) {
    const result = compressVomByRelations(asInput(input === undefined ? {} : input));
    const foldIds = result.folded.map((fold) => fold.id);
    assert.equal(new Set(foldIds).size, foldIds.length, label + ' 折叠 id 重复');
    const seen = new Set<string>();
    for (const fold of result.folded) {
      assert.equal(fold.count, fold.memberIds.length, label + ' count 与 memberIds 不符');
      assert.ok(fold.sampleNames.length <= COMPRESSION_LIMITS.sampleNames, label + ' 样例名超过默认上限');
      assert.ok(fold.count >= 2, label + ' 折叠组必须 ≥ 2 成员');
      assert.ok(fold.tokensSaved >= 0, label + ' tokensSaved 不能为负');
      assert.ok(fold.ratio >= 0, label + ' ratio 不能为负');
      for (const memberId of fold.memberIds) {
        assert.ok(!seen.has(memberId), label + ' 成员被重复折叠：' + memberId);
        seen.add(memberId);
      }
    }
    const keptIds = new Set(result.nodes.map((item) => String(item.id)));
    for (const memberId of seen) assert.ok(!keptIds.has(memberId), label + ' 已折叠成员仍在 nodes 里：' + memberId);
    assert.equal(result.report.saved.ratio >= 0, true);
    assert.ok(result.report.saved.tokens <= result.report.before.tokens, label + ' saved.tokens 超过 before');
  }
});

test('根输入 null：JS 与 TS 都按同一契约抛错', () => {
  assert.throws(() => js.compressVomByRelations(null));
  assert.throws(() => compressVomByRelations(null as unknown as VomCompressInput));
  assert.throws(() => js.compressVomByRelations({}, null));
  assert.throws(() => compressVomByRelations({}, null as unknown as VomCompressOptions));
});
