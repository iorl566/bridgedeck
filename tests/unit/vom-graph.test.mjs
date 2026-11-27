import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVomGraph, fallbackNodeId, VOM_GRAPH_DEFAULT_LIMITS } from '../../extension/src/lib/vom-graph.js';
import { buildVomPayload } from '../../extension/src/lib/vom-payload.js';

function rawGraph() {
  return {
    nodes: [
      { key: 'n1', ref: null, tag: 'html', domId: null, role: null, parentKey: null },
      { key: 'n2', ref: null, tag: 'body', domId: null, role: null, parentKey: 'n1' },
      { key: 'n3', ref: '@e5', tag: 'button', domId: 'submit-btn', role: null, parentKey: 'n2' },
      { key: 'n4', ref: null, tag: 'label', domId: null, role: null, parentKey: 'n2' },
    ],
    edges: [
      { type: 'child', from: 'n1', to: 'n2' },
      { type: 'child', from: 'n2', to: 'n3' },
      { type: 'child', from: 'n2', to: 'n4' },
      { type: 'label', from: 'n4', to: 'n3' },
      { type: 'label', from: 'n4', to: 'n3' },
      { type: 'controls', from: 'n3', to: 'n-missing' },
    ],
    truncated: false,
  };
}

const observedNodes = [
  { graphKey: 'n3', ref: '@e5', stableRef: 's-abc', tag: 'button', role: 'button', name: '提交', bounds: { x: 1 } },
];

test('containment：祖先链换成 id，roots/edges/info 一致', () => {
  const built = buildVomGraph({ graph: rawGraph(), nodes: observedNodes });
  assert.equal(built.available, true);
  const { payload, info } = built;
  const ids = payload.nodes.map((node) => node.id);
  assert.deepEqual(ids, ['vom:n1', 'vom:n2', '@e5', 'vom:n4']);
  assert.deepEqual(payload.roots, ['vom:n1']);
  const childEdges = payload.edges.filter((edge) => edge.type === 'child');
  assert.equal(childEdges.length, 3);
  for (const edge of childEdges) {
    assert.ok(ids.includes(edge.from) && ids.includes(edge.to), '端点必须是图内 id：' + JSON.stringify(edge));
  }
  const record = info.get(observedNodes[0]);
  assert.equal(record.id, '@e5');
  assert.equal(record.parentId, 'vom:n2');
  assert.deepEqual(record.ancestorIds, ['vom:n2', 'vom:n1']);
  const byId = new Map(payload.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get('@e5').observed, true);
  assert.equal(byId.get('@e5').stableRef, 's-abc');
});

test('ownership：label 边保留并去重，未知端点丢弃', () => {
  const built = buildVomGraph({ graph: rawGraph(), nodes: observedNodes });
  const labelEdges = built.payload.edges.filter((edge) => edge.type === 'label');
  assert.equal(labelEdges.length, 1);
  assert.deepEqual(labelEdges[0], { type: 'label', from: 'vom:n4', to: '@e5' });
  assert.equal(built.payload.edges.some((edge) => edge.to === 'n-missing'), false);
  assert.equal(built.payload.counts.byType.child, 3);
  assert.equal(built.payload.counts.byType.label, 1);
});

test('id 规则：ref > stableRef > vom:<key>，重名追加 key 保证唯一', () => {
  const graph = rawGraph();
  graph.nodes.push({ key: 'n5', ref: null, tag: 'button', domId: null, role: null, parentKey: 'n2' });
  const nodes = [
    { graphKey: 'n3', ref: '@e5' },
    { graphKey: 'n5', stableRef: 's-abc' },
    { graphKey: 'n4', stableRef: 's-abc' },
  ];
  const built = buildVomGraph({ graph, nodes });
  const ids = built.payload.nodes.map((node) => node.id);
  assert.ok(ids.includes('@e5'));
  assert.ok(ids.includes('s-abc'));
  assert.ok(ids.includes('s-abc~n5'), 'stableRef 撞名时要可区分：' + JSON.stringify(ids));
  assert.equal(new Set(ids).size, ids.length);
});

test('观测节点没有 id 线索时用 vom:<key>', () => {
  const built = buildVomGraph({ graph: rawGraph(), nodes: [{ graphKey: 'n5' }] });
  const ids = built.payload.nodes.map((node) => node.id);
  assert.ok(ids.includes('vom:n1'));
  assert.equal(built.info.size, 0, 'n5 不在图里，info 不应包含它');
});

test('上限：节点/边截断标记', () => {
  const built = buildVomGraph({ graph: rawGraph(), nodes: observedNodes, limits: { nodes: 2, edges: 1 } });
  assert.equal(built.payload.nodes.length, 2);
  assert.equal(built.payload.truncated, true);
  assert.ok(built.payload.edges.length <= 1);
  assert.ok(VOM_GRAPH_DEFAULT_LIMITS.nodes >= 100);
});

test('没有页面图 → available:false，调用方保留旧行为', () => {
  const built = buildVomGraph({ graph: null, nodes: observedNodes });
  assert.equal(built.available, false);
  assert.deepEqual(built.payload.nodes, []);
  assert.equal(built.payload.available, false);
  assert.equal(built.info.size, 0);
});

test('fallbackNodeId：ref > stableRef > vom:i<index>', () => {
  assert.equal(fallbackNodeId({ ref: '@e2' }, 0), '@e2');
  assert.equal(fallbackNodeId({ stableRef: 's-1' }, 1), 's-1');
  assert.equal(fallbackNodeId({}, 3), 'vom:i3');
});

test('vom payload 接入图：nodes[].id/ancestorIds 与 edges 兼容字段', () => {
  const payload = buildVomPayload({
    nodes: observedNodes,
    layers: [],
    visual: [],
    issues: [],
    documentId: 'https://example.com/',
    revision: 7,
    facts: { nodes: 10 },
    graph: rawGraph(),
  });
  assert.equal(payload.version, 1);
  assert.equal(payload.revision, 7);
  assert.ok(payload.graph && payload.graph.available === true, '缺少 graph：' + JSON.stringify(payload.graph));
  const node = payload.nodes[0];
  assert.equal(node.id, '@e5');
  assert.equal(node.parentId, 'vom:n2');
  assert.deepEqual(node.ancestorIds, ['vom:n2', 'vom:n1']);
  assert.ok(payload.edges.some((edge) => edge.type === 'child' && edge.child === '@e5' && edge.parent === 'vom:n2'), '缺少兼容 child/parent 字段：' + JSON.stringify(payload.edges));
  assert.deepEqual(payload.stages.map((stage) => stage.stage), ['facts', 'identity', 'relations', 'layout', 'paint', 'interact']);
});

test('vom payload 无图时回退旧 ancestors 边（向后兼容）', () => {
  const payload = buildVomPayload({
    nodes: [{ ref: '@e2', tag: 'button', ancestors: [{ tag: 'div', id: 'wrap', ref: null }] }],
    graph: null,
  });
  assert.equal(payload.graph, null);
  assert.equal(payload.nodes[0].id, '@e2');
  assert.deepEqual(payload.nodes[0].ancestorIds, []);
  assert.deepEqual(payload.edges, [{ type: 'child', from: 'div#wrap', to: '@e2', child: '@e2', parent: 'div#wrap' }]);
});
