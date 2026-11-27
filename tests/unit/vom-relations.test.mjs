// 语义关系图 v3：contains/labels/controls/owns/describes + confidence/source + 组上下文。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELATION_CONFIDENCE,
  RELATION_TYPES,
  VOM_RELATIONS_VERSION,
  buildVomRelationGraph,
  filterRelationsByConfidence,
  relationsForNode,
} from '../../extension/src/lib/vom-relations.js';
import { buildVomSemanticGraph } from '../../extension/src/lib/vom-semantic.js';

function graphFixture() {
  return {
    nodes: [
      { id: '@e1', domId: 'btn', tag: 'button', role: 'button' },
      { id: '@e2', domId: 'dlg', tag: 'div', role: 'dialog' },
      { id: '@e3', domId: 'lbl', tag: 'label', role: null },
      { id: '@e4', domId: 'panel', tag: 'div', role: 'menu' },
      { id: '@e5', domId: 'owner', tag: 'div', role: null },
      { id: '@e6', domId: 'form1', tag: 'form', role: 'form' },
    ],
    edges: [
      { type: 'controls', from: '@e1', to: '@e4' },
      { type: 'label', from: '@e3', to: '@e1' },
      { type: 'describedby', from: '@e3', to: '@e1' },
      { type: 'owns', from: '@e5', to: '@e1' },
      { type: 'form', from: '@e6', to: '@e1' },
      { type: 'child', from: '@e6', to: '@e1' },
      { type: 'frame', from: '@e1', to: '@e2' },
    ],
  };
}

test('关系图 v3：页面图边映射成带 confidence/source 的关系', () => {
  assert.equal(VOM_RELATIONS_VERSION, 3);
  assert.deepEqual(RELATION_TYPES, ['contains', 'labels', 'controls', 'owns', 'describes']);
  const graph = buildVomRelationGraph({ graph: graphFixture() });
  assert.equal(graph.version, 3);
  const byType = (type) => graph.relations.filter((relation) => relation.type === type);
  assert.equal(byType('controls').length, 1);
  assert.equal(byType('controls')[0].from, '@e1');
  assert.equal(byType('controls')[0].to, '@e4');
  assert.equal(byType('controls')[0].source, 'aria-controls');
  assert.equal(byType('controls')[0].confidence, RELATION_CONFIDENCE['aria-controls']);
  assert.equal(byType('labels').length, 1);
  assert.equal(byType('labels')[0].source, 'label-for');
  assert.equal(byType('describes').length, 1);
  assert.equal(byType('describes')[0].confidence, 0.9);
  assert.equal(byType('owns').length, 2, 'owns 边 + form 边都应进入 owns');
  assert.equal(byType('contains').length, 1);
  assert.equal(byType('contains')[0].source, 'dom-parent');
  assert.equal(byType('contains')[0].confidence, 0.65);
  // frame 边不进入关系图。
  assert.equal(graph.relations.some((relation) => relation.type === 'frame'), false);
  assert.equal(graph.stats.relations, graph.relations.length);
  assert.equal(graph.stats.byType.controls, 1);
  assert.ok(graph.stats.averageConfidence > 0);
  assert.equal(graph.stats.lowConfidence, 1);
});

test('entry 自身 ARIA 关系解析 DOM id → 节点 id，并与图边合并来源', () => {
  const entries = [
    { id: '@e1', node: { id: 'btn', role: 'button' }, relations: { controls: ['panel'], labelledBy: ['lbl'], describedBy: ['lbl'], form: ['form1'] } },
  ];
  const graph = buildVomRelationGraph({ entries, graph: graphFixture() });
  const controls = graph.relations.find((relation) => relation.type === 'controls');
  assert.equal(controls.from, '@e1');
  assert.equal(controls.to, '@e4');
  assert.equal(controls.confidence, 0.95);
  const labels = graph.relations.filter((relation) => relation.type === 'labels');
  assert.equal(labels.length, 1, 'label 边与 aria-labelledby 应合并成一条关系');
  assert.deepEqual(labels[0].sources, ['label-for', 'aria-labelledby']);
  assert.equal(labels[0].confidence, 0.95);
  assert.equal(labels[0].source, 'aria-labelledby');
  const describes = graph.relations.find((relation) => relation.type === 'describes');
  assert.equal(describes.source, 'aria-describedby');
  const owns = graph.relations.filter((relation) => relation.type === 'owns');
  assert.ok(owns.some((relation) => relation.from === '@e6' && relation.source === 'form-anchor'));
});

test('语义组 contains 边与 group/context 扩展', () => {
  const entries = [
    { id: 'n1', node: { ancestors: [{ tag: 'main', id: 'main1' }], vomScore: 1 } },
    { id: 'n2', node: { ancestors: [{ tag: 'main', id: 'main1' }, { tag: 'form', id: 'f1' }], vomScore: 10 } },
  ];
  const semantic = buildVomSemanticGraph(entries);
  assert.equal(semantic.nodes.length, 2);
  const relationGraph = buildVomRelationGraph({ entries, semantic });
  const contains = relationGraph.relations.filter((relation) => relation.type === 'contains');
  assert.equal(contains.length, 1);
  assert.equal(contains[0].source, 'semantic-group');
  assert.equal(contains[0].fromKind, 'section');
  assert.equal(contains[0].toKind, 'form');
  assert.equal(relationGraph.contexts.length >= 1, true);
  const formGroup = relationGraph.groups.find((group) => group.kind === 'form');
  assert.ok(formGroup, '缺少 form 组');
  assert.ok(formGroup.context.parent, 'form 组应有父组上下文');
  assert.equal(formGroup.context.parentKind, 'section');
  assert.equal(formGroup.context.depth, 1);
  assert.deepEqual(formGroup.context.chain, [formGroup.context.parent]);
  assert.ok(relationGraph.stats.contextGroups >= 1);
  assert.equal(relationGraph.groups.find((group) => group.kind === 'section').context.depth, 0);
});

test('relationsForNode：入/出方向与来源', () => {
  const graph = buildVomRelationGraph({ graph: graphFixture() });
  const forLabel = relationsForNode(graph, '@e3');
  assert.ok(forLabel.length >= 2);
  assert.ok(forLabel.every((relation) => relation.direction === 'out'));
  const forButton = relationsForNode(graph, '@e1');
  assert.ok(forButton.some((relation) => relation.type === 'labels' && relation.direction === 'in'));
  assert.ok(forButton.some((relation) => relation.type === 'controls' && relation.direction === 'out'));
  assert.deepEqual(relationsForNode(graph, '@missing'), []);
  assert.deepEqual(relationsForNode(null, '@e1'), []);
});

test('filterRelationsByConfidence 只保留高置信关系且不修改原图', () => {
  const graph = buildVomRelationGraph({ graph: graphFixture() });
  const before = graph.relations.length;
  const filtered = filterRelationsByConfidence(graph, 0.8);
  assert.ok(filtered.relations.length < before);
  assert.ok(filtered.relations.every((relation) => relation.confidence >= 0.8));
  assert.equal(graph.relations.length, before, '原图被修改');
  assert.equal(filtered.stats.filteredBelow, 0.8);
  assert.equal(filterRelationsByConfidence(null, 0.5), null);
});

test('空输入安全：版本/统计/数组结构稳定', () => {
  const graph = buildVomRelationGraph();
  assert.equal(graph.version, 3);
  assert.deepEqual(graph.relations, []);
  assert.deepEqual(graph.groups, []);
  assert.deepEqual(graph.contexts, []);
  assert.equal(graph.stats.relations, 0);
  assert.equal(graph.stats.averageConfidence, 0);
  assert.equal(graph.stats.truncated, false);
  // 未知节点端点被丢弃（不会产生悬挂边）。
  const stray = buildVomRelationGraph({ graph: { nodes: [{ id: '@a' }], edges: [{ type: 'controls', from: '@a', to: '@zzz' }] } });
  assert.deepEqual(stray.relations, []);
});
