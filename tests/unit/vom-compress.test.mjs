// 语义压缩：按 context/groups 折叠同类条目 + 关系折叠 + compression 报告。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPRESSION_LIMITS,
  VOM_COMPRESSION_VERSION,
  compressVomByRelations,
  summarizeVomCompression,
} from '../../extension/src/lib/vom-compress.js';
import { estimateVomTokens } from '../../extension/src/lib/vom-weights.js';

function fixtureNodes() {
  return [
    { id: 'a1', role: 'option', name: '选项 A', vomScore: 9 },
    { id: 'a2', role: 'option', name: '选项 B', vomScore: 5 },
    { id: 'a3', role: 'option', name: '选项 C', vomScore: 1 },
    { id: 'b1', role: 'button', name: '提交', vomScore: 8 },
    { id: 'b2', role: 'paragraph', name: '说明文字', vomScore: 2 },
  ];
}

function fixtureContext() {
  return {
    groups: [
      {
        id: 'ctx:form:list',
        kind: 'form',
        groupKind: 'listbox-owner',
        name: '角色下拉',
        memberIds: ['a1', 'a2', 'a3'],
        tokens: 120,
      },
    ],
  };
}

function fixtureRelations() {
  return [
    { type: 'owns', from: 'g1', to: 'a1', confidence: 0.8, source: 'composite-owner', sources: ['composite-owner'] },
    { type: 'owns', from: 'g1', to: 'a2', confidence: 0.8, source: 'composite-owner', sources: ['composite-owner'] },
    { type: 'owns', from: 'g1', to: 'a3', confidence: 0.8, source: 'composite-owner', sources: ['composite-owner'] },
    { type: 'owns', from: 'g1', to: 'a4', confidence: 0.8, source: 'composite-owner', sources: ['composite-owner'] },
    { type: 'labels', from: 'lbl', to: 'b1', confidence: 0.9, source: 'label-for', sources: ['label-for'] },
  ];
}

test('压缩版本/上限常量：默认值可读且为正整数', () => {
  assert.equal(VOM_COMPRESSION_VERSION, 1);
  assert.ok(Number.isInteger(COMPRESSION_LIMITS.folds) && COMPRESSION_LIMITS.folds > 0);
  assert.ok(Number.isInteger(COMPRESSION_LIMITS.sampleNames) && COMPRESSION_LIMITS.sampleNames > 0);
  assert.ok(COMPRESSION_LIMITS.relationFoldMin >= 2);
});

test('组折叠：同组成员的计数/样例/角色直方图 + token 节省', () => {
  const result = compressVomByRelations({
    nodes: fixtureNodes(),
    context: fixtureContext(),
    relations: fixtureRelations(),
  });
  assert.equal(result.version, 1);
  assert.equal(result.folded.length, 1);
  const fold = result.folded[0];
  assert.equal(fold.id, 'fold:ctx:form:list');
  assert.equal(fold.kind, 'fold');
  assert.equal(fold.role, 'group');
  assert.equal(fold.count, 3);
  assert.equal(fold.name, '角色下拉 ×3');
  assert.deepEqual(fold.sampleNames, ['选项 A', '选项 B', '选项 C']);
  assert.deepEqual(fold.memberIds, ['a1', 'a2', 'a3']);
  assert.deepEqual(fold.roles, { option: 3 });
  assert.ok(fold.tokensBefore > fold.tokens, '折叠后 token 应小于折叠前');
  assert.equal(fold.tokensSaved, fold.tokensBefore - fold.tokens);
  assert.ok(fold.tokensSaved > 0);
  assert.ok(fold.ratio > 0 && fold.ratio < 1);
  // summary 计费口径与全仓一致：只按 name+role。
  assert.equal(fold.tokens, estimateVomTokens({ name: fold.name, role: 'group' }));
  // 未分组节点保留，成员节点不再重复出现。
  assert.deepEqual(result.nodes.map((node) => node.id).sort(), ['b1', 'b2']);
});

test('compression 报告：before/after/saved 与 byKind、关系折叠', () => {
  const result = compressVomByRelations({
    nodes: fixtureNodes(),
    context: fixtureContext(),
    relations: fixtureRelations(),
  });
  assert.equal(result.report.before.nodes, 5);
  assert.equal(result.report.after.nodes, 3, '2 个未折叠节点 + 1 条 summary');
  assert.equal(result.report.saved.nodes, 2);
  assert.ok(result.report.saved.tokens > 0);
  assert.ok(result.report.saved.ratio > 0);
  assert.equal(result.report.folds, 1);
  assert.equal(result.report.foldedMembers, 3);
  assert.deepEqual(result.report.byKind, { form: 1 });
  assert.equal(result.report.relations, 5);
  assert.equal(result.relationFolds.length, 1, '同一 (type,from) 下 4 条 owns 应折叠成一条');
  const relationFold = result.relationFolds[0];
  assert.equal(relationFold.type, 'owns');
  assert.equal(relationFold.from, 'g1');
  assert.equal(relationFold.count, 4);
  assert.equal(relationFold.targets.length, 4);
  assert.deepEqual(relationFold.sources, ['composite-owner']);
  assert.equal(relationFold.averageConfidence, 0.8);
  assert.equal(result.report.relationFolds, 1);
  assert.equal(result.report.foldedRelations, 4);
});

test('relationFolds 关闭时只做组折叠', () => {
  const result = compressVomByRelations({
    nodes: fixtureNodes(),
    context: fixtureContext(),
    relations: fixtureRelations(),
  }, { includeRelationFolds: false });
  assert.deepEqual(result.relationFolds, []);
  assert.equal(result.report.relationFolds, 0);
  assert.equal(result.report.foldedRelations, 0);
  assert.equal(result.folded.length, 1);
});

test('没有 context 时用 payload.groups（sections/rows/forms）兜底', () => {
  const result = compressVomByRelations({
    nodes: fixtureNodes(),
    groups: {
      sections: [{ id: 'main|main|m1|', anchor: { id: 'm1', role: 'main' }, nodeIds: ['a1', 'a2'], tokens: 40 }],
      rows: [],
      forms: [],
    },
  }, { includeRelationFolds: false });
  assert.equal(result.folded.length, 1);
  assert.equal(result.folded[0].count, 2);
  assert.equal(result.folded[0].name, '#m1 ×2');
  assert.deepEqual(result.folded[0].sampleNames, ['选项 A', '选项 B']);
  assert.deepEqual(result.folded[0].roles, { option: 2 });
});

test('没有 context/groups 时用 semantic 成员兜底', () => {
  const result = compressVomByRelations({
    nodes: fixtureNodes(),
    semantic: { nodes: [{ id: 'g:form:f1', groupKind: 'form', memberIds: ['b1', 'b2'], tokens: 20 }] },
  }, { includeRelationFolds: false });
  assert.equal(result.folded.length, 1);
  assert.equal(result.folded[0].groupKind, 'form');
  assert.equal(result.folded[0].count, 2);
});

test('单成员组/空输入不折叠，报告保持 0 节省', () => {
  const empty = compressVomByRelations();
  assert.deepEqual(empty.folded, []);
  assert.deepEqual(empty.nodes, []);
  assert.equal(empty.report.before.nodes, 0);
  assert.equal(empty.report.after.nodes, 0);
  assert.equal(empty.report.saved.ratio, 0);
  const single = compressVomByRelations({
    nodes: [{ id: 'only', role: 'button', name: 'OK' }],
    context: { groups: [{ id: 'g', kind: 'form', memberIds: ['only'] }] },
  }, { includeRelationFolds: false });
  assert.deepEqual(single.folded, []);
  assert.equal(single.report.saved.tokens, 0);
});

test('maxFolds 上限与多个组折叠的确定性', () => {
  const nodes = [
    { id: 'a1', role: 'option', name: 'A' },
    { id: 'a2', role: 'option', name: 'B' },
    { id: 'c1', role: 'tab', name: 'Tab 1' },
    { id: 'c2', role: 'tab', name: 'Tab 2' },
    { id: 'd1', role: 'link', name: '链接 1' },
    { id: 'd2', role: 'link', name: '链接 2' },
  ];
  const context = {
    groups: [
      { id: 'g1', kind: 'table', groupKind: 'table', memberIds: ['a1', 'a2'] },
      { id: 'g2', kind: 'form', groupKind: 'tablist', memberIds: ['c1', 'c2'] },
      { id: 'g3', kind: 'landmark', groupKind: 'navigation', memberIds: ['d1', 'd2'] },
    ],
  };
  const all = compressVomByRelations({ nodes, context }, { maxFolds: 10, includeRelationFolds: false });
  assert.equal(all.folded.length, 3);
  assert.deepEqual(all.folded.map((fold) => fold.groupKind), ['table', 'tablist', 'navigation']);
  const limited = compressVomByRelations({ nodes, context }, { maxFolds: 1, includeRelationFolds: false });
  assert.equal(limited.folded.length, 1);
  assert.equal(limited.report.folds, 1);
  assert.equal(limited.report.saved.nodes, 1);
});

test('summarizeVomCompression：一行摘要含前后节点/token 与折叠数', () => {
  const result = compressVomByRelations({ nodes: fixtureNodes(), context: fixtureContext(), relations: fixtureRelations() });
  const text = summarizeVomCompression(result);
  assert.match(text, /nodes 5→3/);
  assert.match(text, /tokens \d+→\d+/);
  assert.match(text, /saved=\d+/);
  assert.match(text, /folds=1/);
  assert.match(text, /relation-folds=1/);
  assert.equal(summarizeVomCompression(null), 'compression: n/a');
});
