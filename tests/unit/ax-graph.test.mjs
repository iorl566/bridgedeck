import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAxIntoGraph, AX_GRAPH_LIMITS } from '../../extension/src/lib/ax-graph.js';

function payload() {
  return {
    available: true,
    nodes: [
      { id: 'vom:n1', ref: null, stableRef: null, tag: 'body', role: null, domId: null, parentId: null, observed: false, ancestorIds: [] },
      { id: '@e1', ref: '@e1', stableRef: 's-1', tag: 'button', role: 'button', domId: 'btn', parentId: 'vom:n1', observed: true, ancestorIds: ['vom:n1'] },
    ],
    edges: [{ type: 'child', from: 'vom:n1', to: '@e1' }],
    roots: ['vom:n1'],
    counts: { nodes: 2, edges: 1, byType: { child: 1 } },
    truncated: false,
  };
}

function fixtures() {
  const observed = { ref: '@e1', ax: { nodeId: '20', parentId: '10', backendNodeId: 5 } };
  const axNodes = [
    { nodeId: '10', parentId: null, role: 'RootWebArea', name: 'root' },
    { nodeId: '20', parentId: '10', role: 'button', name: '提交' },
    { nodeId: '30', parentId: '20', role: 'StaticText', name: '提交' },
  ];
  const info = new Map([[observed, { id: '@e1', parentId: 'vom:n1', ancestorIds: ['vom:n1'] }]]);
  return { observed, axNodes, info };
}

test('AX 父子边并入图：观察节点用图内 id，中间节点补 ax 上下文节点', () => {
  const { observed, axNodes, info } = fixtures();
  const merged = mergeAxIntoGraph(payload(), { axNodes, nodes: [observed], info });
  const graph = merged.graph;
  assert.equal(graph.counts.byType.ax, 2);
  assert.equal(graph.counts.byType.child, 1);
  assert.equal(graph.counts.edges, 3);
  assert.equal(merged.addedNodes, 2);
  assert.equal(merged.addedEdges, 2);
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from) && ids.has(edge.to), '端点必须在图内：' + JSON.stringify(edge));
  }
  assert.ok(graph.edges.some((edge) => edge.type === 'ax' && edge.from === 'ax:10' && edge.to === '@e1'), '缺少 root→button 的 AX 边：' + JSON.stringify(graph.edges));
  assert.ok(graph.edges.some((edge) => edge.type === 'ax' && edge.from === '@e1' && edge.to === 'ax:30'), '缺少 button→text 的 AX 边');
  const root = graph.nodes.find((node) => node.id === 'ax:10');
  assert.equal(root.ax, true);
  assert.equal(root.role, 'RootWebArea');
  assert.equal(root.observed, false);
  assert.equal(root.parentId, null);
  const text = graph.nodes.find((node) => node.id === 'ax:30');
  assert.equal(text.parentId, '@e1', 'AX 上下文节点应补 parentId');
});

test('AX 边去重：重复节点/重复父子只留一条', () => {
  const { axNodes, info } = fixtures();
  const merged = mergeAxIntoGraph(payload(), {
    axNodes: axNodes.concat(axNodes, [{ nodeId: '20', parentId: '10', role: 'button' }]),
    nodes: [],
    info,
  });
  const axEdges = merged.graph.edges.filter((edge) => edge.type === 'ax');
  assert.equal(axEdges.length, 2);
  assert.equal(new Set(axEdges.map((edge) => edge.from + '>' + edge.to)).size, 2);
});

test('上限：边数与上下文节点数受限并标 truncated', () => {
  const { observed, axNodes, info } = fixtures();
  const merged = mergeAxIntoGraph(payload(), { axNodes, nodes: [observed], info, limits: { edges: 1, nodes: 5 } });
  assert.equal(merged.addedEdges, 1);
  assert.ok(merged.addedNodes <= 2);
  assert.equal(merged.dropped > 0, true);
  assert.equal(merged.graph.truncated, true);
  assert.ok(AX_GRAPH_LIMITS.edges >= 100);
});

test('没有 AX 树 / 图不可用：原样返回，不产生副作用', () => {
  const base = payload();
  const snapshot = JSON.stringify(base);
  const none = mergeAxIntoGraph(base, { axNodes: [], nodes: [] });
  assert.equal(none.graph, base);
  assert.equal(JSON.stringify(base), snapshot, '不应修改入参');
  const unavailable = { available: false, nodes: [], edges: [], counts: { nodes: 0, edges: 0, byType: {} } };
  const result = mergeAxIntoGraph(unavailable, { axNodes: fixtures().axNodes, nodes: [] });
  assert.equal(result.graph, unavailable);
  assert.equal(result.addedEdges, 0);
});

test('observedByAx 映射：只有 info 里能解析的 nodeId 才复用图内 id', () => {
  const { axNodes } = fixtures();
  const observed = { ref: '@e1', ax: { nodeId: '20' } };
  const merged = mergeAxIntoGraph(payload(), { axNodes, nodes: [observed], info: new Map() });
  assert.ok(merged.graph.edges.every((edge) => edge.to !== '@e1' || edge.from !== 'ax:10'), '没有映射时不应伪造 @e1 端点');
  assert.ok(merged.graph.nodes.some((node) => node.id === 'ax:20'), '没有映射时 nodeId 20 应成为上下文节点');
});
