import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVomSemanticGraph, filterSemanticGroups } from '../../extension/src/lib/vom-semantic.js';

test('buildVomSemanticGraph 生成 form 组成员边', () => {
  const entries = [
    { id: 'n1', node: { ancestors: [{ tag: 'form', id: 'f1' }] } },
    { id: 'n2', node: { ancestors: [{ tag: 'form', id: 'f1' }] } },
  ];
  const graph = buildVomSemanticGraph(entries);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].groupKind, 'form');
  assert.equal(graph.nodes[0].members, 2);
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.every((edge) => edge.type === 'member' && edge.from === graph.nodes[0].id));
});

test('buildVomSemanticGraph 空输入', () => {
  const graph = buildVomSemanticGraph([]);
  assert.equal(graph.stats.groups, 0);
  assert.deepEqual(graph.edges, []);
});

test('filterSemanticGroups 按组得分保留 top N', () => {
  const entries = [
    { id: 'a', node: { ancestors: [{ tag: 'form', id: 'f1' }], vomScore: 30 } },
    { id: 'b', node: { ancestors: [{ tag: 'form', id: 'f1' }], vomScore: 20 } },
    { id: 'c', node: { ancestors: [{ tag: 'nav', id: 'n1' }], vomScore: 5 } },
    { id: 'free', node: { vomScore: 1 } },
  ];
  const graph = buildVomSemanticGraph(entries);
  const result = filterSemanticGroups(entries, graph, { maxGroups: 1 });
  assert.ok(result);
  assert.ok(result.ids.has('a') && result.ids.has('b') && result.ids.has('free'));
  assert.ok(!result.ids.has('c'));
});

test('语义图识别 dialog/table/list', () => {
  const entries = [
    { id: 'd1', node: { ancestors: [{ role: 'dialog', id: 'dlg' }, { role: 'form', id: 'f1' }], vomScore: 10 } },
    { id: 't1', node: { ancestors: [{ role: 'table', id: 'tbl' }], vomScore: 10 } },
    { id: 'l1', node: { ancestors: [{ role: 'list', id: 'list' }], vomScore: 10 } },
  ];
  const graph = buildVomSemanticGraph(entries);
  assert.equal(graph.version, 2);
  assert.equal(graph.stats.byKind.dialog, 1);
  assert.equal(graph.stats.byKind.table, 1);
  assert.equal(graph.stats.byKind.list, 1);
  const dialog = graph.nodes.find((node) => node.groupKind === 'dialog');
  assert.equal(dialog.score, 10);
  assert.equal(dialog.averageScore, 10);
});

test('dialog 组权重高于 table', () => {
  const entries = [
    { id: 'd', node: { ancestors: [{ role: 'dialog', id: 'dlg' }], vomScore: 50 } },
    { id: 't', node: { ancestors: [{ role: 'table', id: 'tbl' }], vomScore: 60 } },
  ];
  const graph = buildVomSemanticGraph(entries);
  const result = filterSemanticGroups(entries, graph, { maxGroups: 1 });
  assert.ok(result.ids.has('d'));
  assert.ok(!result.ids.has('t'));
});

test('section 组 contains form 组', () => {
  const entries = [
    { id: 's', node: { ancestors: [{ tag: 'main' }], vomScore: 1 } },
    { id: 'f', node: { ancestors: [{ tag: 'main' }, { tag: 'form' }], vomScore: 1 } },
  ];
  const graph = buildVomSemanticGraph(entries);
  const contains = graph.edges.filter((edge) => edge.type === 'contains');
  assert.ok(contains.length >= 1, '缺少 contains 边');
  assert.ok(contains.some((edge) => edge.fromKind === 'section' && edge.toKind === 'form'));
  assert.ok(graph.stats.contains >= 1);
});

test('includeContext 自动带上父组', () => {
  const entries = [
    { id: 's', node: { ancestors: [{ tag: 'main' }], vomScore: 1 } },
    { id: 'f', node: { ancestors: [{ tag: 'main' }, { tag: 'form' }], vomScore: 10 } },
  ];
  const graph = buildVomSemanticGraph(entries);
  const plain = filterSemanticGroups(entries, graph, { maxGroups: 1 });
  assert.ok(plain.ids.has('f'));
  assert.ok(!plain.ids.has('s'));
  const withContext = filterSemanticGroups(entries, graph, { maxGroups: 1, includeContext: true });
  assert.ok(withContext.ids.has('f') && withContext.ids.has('s'));
  assert.ok(withContext.contextGroups >= 1);
});
