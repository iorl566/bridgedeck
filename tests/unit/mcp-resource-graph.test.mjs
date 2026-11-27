// tests/unit/mcp-resource-graph.test.mjs —— MCP resource 关系图谱（节点/边/子图/差量/审计）。
//
// 覆盖：URI 解析、虚拟节点（session/template）、五类边、relatedUris/subgraph/shortestPath/
// 连通分量/会话索引、摘要、差量（added/removed/changed/identity）、审计（未知 URI/重复行/
// 悬空边/自环/缺边）、strict 包装、buildGraphWithDiff 与能力快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_KINDS,
  GRAPH_TEMPLATES,
  LATEST_ALIASES,
  ResourceGraphError,
  SKILL_MAIN_URI,
  auditResourceGraph,
  assertResourceGraph,
  buildGraphWithDiff,
  buildResourceGraph,
  connectedComponents,
  diffResourceGraphs,
  graphFingerprint,
  graphNodeIdOf,
  neighbors,
  nodeOf,
  parseResourceUri,
  relatedUris,
  resourceGraphSnapshot,
  sessionIndex,
  shortestPath,
  subgraph,
  summarizeGraph,
} from '../../mcp/resource-graph.mjs';

const ROWS = [
  { uri: 'bridge://skill/SKILL.md', name: 'skill', mimeType: 'text/markdown', annotations: { priority: 0.8 } },
  { uri: 'bridge://skill/references/environment.md', name: 'ref-env', mimeType: 'text/markdown', annotations: { priority: 0.7 } },
  { uri: 'bridge://update/state', name: 'update', mimeType: 'application/json' },
  { uri: 'bridge://protocol/summary', name: 'summary', mimeType: 'application/json' },
  { uri: 'bridge://observation/latest', name: 'observation-latest', mimeType: 'application/json' },
  { uri: 'bridge://observation/s1', name: 'observation-s1', mimeType: 'application/json' },
  { uri: 'bridge://debug/evidence/s1', name: 'evidence-s1', mimeType: 'application/json' },
  { uri: 'bridge://debug/journal/s1', name: 'journal-s1', mimeType: 'application/json' },
];

function graphOf(rows = ROWS) {
  return buildResourceGraph(rows);
}

function craftedGraph({ nodes = [], edges = [], duplicates = [], unknown = [], templates = GRAPH_TEMPLATES } = {}) {
  const map = new Map(nodes.map((node) => [node.id, node]));
  return {
    nodes: map,
    edges,
    templates,
    sessions: Object.freeze([]),
    duplicates: Object.freeze(duplicates),
    unknown: Object.freeze(unknown),
    fingerprint: graphFingerprint(map, edges),
  };
}

test('parseResourceUri：技能/更新/协议/观察/证据/journal 的形状与模板派生', () => {
  const skill = parseResourceUri('bridge://skill/SKILL.md');
  assert.equal(skill.kind, 'skill-main');
  assert.equal(skill.template, null);
  const ref = parseResourceUri('bridge://skill/references/environment.md?limit=10');
  assert.equal(ref.kind, 'skill-reference');
  assert.equal(ref.reference, 'environment.md');
  assert.equal(ref.template, 'bridge://skill/references/{name}');
  assert.equal(ref.query, 'limit=10');

  const latest = parseResourceUri('bridge://observation/latest');
  assert.equal(latest.alias, true);
  assert.equal(latest.session, null);
  assert.equal(latest.key, 'latest');

  const observation = parseResourceUri('bridge://observation/s1');
  assert.equal(observation.kind, 'observation');
  assert.equal(observation.session, 's1');
  assert.equal(observation.template, 'bridge://observation/{session}');
  assert.equal(observation.dynamic, true);

  const evidence = parseResourceUri('bridge://debug/evidence/s1');
  assert.equal(evidence.session, 's1');
  assert.equal(evidence.template, 'bridge://debug/evidence/{session}');
  const journal = parseResourceUri('bridge://debug/journal/s1');
  assert.equal(journal.session, 's1');
  assert.equal(journal.alias, false);

  const unknown = parseResourceUri('bridge://nope/thing');
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.dynamic, false);

  assert.equal(graphNodeIdOf('bridge://observation/s1?limit=8&cursor=0'), 'bridge://observation/s1');
});

test('buildResourceGraph：资源节点 + session/template 虚拟节点与五类边', () => {
  const graph = graphOf();
  // 资源节点 8 + session:s1 + 4 个模板虚拟节点 = 13
  assert.equal(graph.nodes.size, 13);
  assert.equal(graph.sessions.length, 1);
  assert.equal(graph.templates.length, GRAPH_TEMPLATES.length);
  assert.equal(graph.duplicates.length, 0);
  assert.equal(graph.unknown.length, 0);
  const node = nodeOf(graph, 'bridge://observation/s1');
  assert.equal(node.kind, 'observation');
  assert.equal(node.session, 's1');
  assert.equal(nodeOf(graph, 'session:s1').kind, GRAPH_NODE_KINDS.SESSION);
  assert.equal(nodeOf(graph, 'template:bridge://observation/{session}').kind, GRAPH_NODE_KINDS.TEMPLATE);
  const edgeTypes = new Set(graph.edges.map((edge) => edge.type));
  for (const type of Object.values(GRAPH_EDGE_TYPES)) assert.ok(edgeTypes.has(type), '缺少边类型：' + type);
  // latest 影子边指向同类会话实例；技能参考挂到主文档。
  assert.ok(graph.edges.some((edge) => edge.from === LATEST_ALIASES.observation
    && edge.to === 'bridge://observation/s1' && edge.type === GRAPH_EDGE_TYPES.LATEST_SHADOW));
  assert.ok(graph.edges.some((edge) => edge.from === 'bridge://skill/references/environment.md'
    && edge.to === SKILL_MAIN_URI && edge.type === GRAPH_EDGE_TYPES.SKILL_PARENT));
  // 同一对边不会重复。
  const keys = new Set(graph.edges.map((edge) => edge.from + '|' + edge.type + '|' + edge.to));
  assert.equal(keys.size, graph.edges.length);
});

test('buildResourceGraph：忽略坏行、重复行与查询串、空输入', () => {
  const graph = buildResourceGraph([
    { uri: 'bridge://observation/s1' },
    { uri: 'bridge://observation/s1?limit=5' },
    null,
    { uri: 42 },
    { uri: '   ' },
  ]);
  assert.equal(graph.nodes.has('bridge://observation/s1'), true);
  assert.equal(graph.duplicates.length, 1);
  assert.equal(graph.duplicates[0], 'bridge://observation/s1');
  assert.equal(graph.unknown.length, 0);
  assert.equal(graph.sessions[0], 's1');

  const empty = buildResourceGraph([]);
  assert.equal(empty.nodes.size, GRAPH_TEMPLATES.length, '空行集合仍保留模板声明节点');
  assert.equal(empty.edges.length, 0);
  assert.equal(typeof empty.fingerprint, 'string');
});

test('neighbors / relatedUris：方向、类型过滤与深度', () => {
  const graph = graphOf();
  const out = neighbors(graph, 'bridge://observation/s1', { direction: 'out' });
  assert.ok(out.some((entry) => entry.edge.type === GRAPH_EDGE_TYPES.SESSION_SCOPE && entry.node.id === 'session:s1'));
  assert.ok(out.some((entry) => entry.edge.type === GRAPH_EDGE_TYPES.SESSION_SIBLING));
  const incoming = neighbors(graph, 'bridge://observation/s1', { direction: 'in', type: GRAPH_EDGE_TYPES.LATEST_SHADOW });
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].node.id, LATEST_ALIASES.observation);
  assert.equal(neighbors(graph, 'bridge://observation/s1', { type: 'not-a-type' }).length, 0);
  assert.deepEqual(neighbors(graph, 'bridge://missing', {}), []);

  const related = relatedUris(graph, 'bridge://observation/s1', { depth: 2 });
  const uris = related.map((item) => item.uri);
  assert.ok(uris.includes('bridge://debug/journal/s1'), '同会话 journal 应相关');
  assert.ok(uris.includes('bridge://debug/evidence/s1'), '同会话 evidence 应相关');
  assert.ok(uris.includes(LATEST_ALIASES.observation), 'latest 别名应相关');
  assert.ok(!uris.includes('bridge://observation/s1'), '不包含自身');
  assert.ok(related.every((item) => item.distance >= 1 && item.kind && item.edge));
  assert.deepEqual(relatedUris(graph, 'bridge://observation/s1', { types: ['skill-parent'] }).map((item) => item.kind), []);
});

test('subgraph / shortestPath / connectedComponents / sessionIndex', () => {
  const graph = graphOf();
  const sub = subgraph(graph, 'session:s1', { depth: 1 });
  assert.equal(sub.root, 'session:s1');
  assert.ok(sub.nodes.length >= 4, '根 + 三类资源');
  assert.ok(sub.edges.every((edge) => sub.nodes.some((node) => node.id === edge.from) && sub.nodes.some((node) => node.id === edge.to)));

  const path = shortestPath(graph, 'bridge://observation/s1', 'bridge://debug/journal/s1');
  assert.ok(path.length >= 2);
  assert.equal(path[0], 'bridge://observation/s1');
  assert.equal(path[path.length - 1], 'bridge://debug/journal/s1');
  assert.deepEqual(shortestPath(graph, 'bridge://skill/SKILL.md', 'session:s1'), []);
  assert.deepEqual(shortestPath(graph, 'bridge://missing', 'session:s1'), []);

  const components = connectedComponents(graph);
  assert.ok(components.length >= 2);
  assert.ok(components.some((ids) => ids.includes('session:s1') && ids.includes(LATEST_ALIASES.observation)));
  assert.ok(components.some((ids) => ids.includes(SKILL_MAIN_URI)));

  const sessions = sessionIndex(graph);
  assert.equal(sessions.get('s1').observation, 'bridge://observation/s1');
  assert.equal(sessions.get('s1').evidence, 'bridge://debug/evidence/s1');
  assert.equal(sessions.get('s1').journal, 'bridge://debug/journal/s1');
  assert.deepEqual([...sessions.get('s1').aliases], ['observation']);
  assert.throws(() => subgraph(graph, 'bridge://missing'), (error) => error instanceof ResourceGraphError && error.code === 'E_NOT_FOUND');
});

test('summarizeGraph：节点/边/会话/连通分量/孤儿/指纹', () => {
  const graph = graphOf();
  const summary = summarizeGraph(graph);
  assert.equal(summary.nodes, graph.nodes.size);
  assert.equal(summary.edges, graph.edges.length);
  assert.equal(summary.sessions, 1);
  assert.equal(summary.templates, GRAPH_TEMPLATES.length);
  assert.equal(summary.virtualNodes, 5);
  assert.equal(summary.dynamic, 4);
  assert.equal(summary.staticNodes, summary.nodes - summary.virtualNodes - summary.dynamic);
  assert.ok(summary.components >= 2);
  assert.equal(typeof summary.fingerprint, 'string');
  assert.equal(summary.unknown.length, 0);
  assert.deepEqual(summary.byKind.template, GRAPH_TEMPLATES.length);
  assert.equal(summary.byEdge[GRAPH_EDGE_TYPES.LATEST_SHADOW], 1);
  // 静态单节点（update/state、protocol/summary）没有边 → 孤儿；资源图不假装它们有关系。
  assert.ok(summary.orphans.includes('bridge://update/state'));
  assert.ok(summary.orphans.includes('bridge://protocol/summary'));

  const emptySummary = summarizeGraph(null);
  assert.equal(emptySummary.nodes, 0);
  assert.equal(emptySummary.fingerprint, null);
});

test('diffResourceGraphs：added/removed/changed/edges 与指纹', () => {
  const before = graphOf();
  const after = graphOf([...ROWS, { uri: 'bridge://observation/s2', name: 'observation-s2', mimeType: 'application/json' }]);
  const diff = diffResourceGraphs(before, after);
  assert.equal(diff.unchanged, false);
  assert.ok(diff.nodesAdded.includes('bridge://observation/s2'));
  assert.ok(diff.nodesAdded.includes('session:s2'));
  assert.ok(diff.edgesAdded >= 3);
  assert.equal(diff.nodesRemoved.length, 0);
  assert.equal(diff.fingerprintChanged, true);

  const identity = diffResourceGraphs(after, after);
  assert.equal(identity.unchanged, true);
  assert.equal(identity.nodesAdded.length, 0);
  assert.equal(identity.edgesAdded, 0);
  assert.equal(identity.fingerprintChanged, false);

  const first = diffResourceGraphs(null, after);
  assert.equal(first.before, null);
  assert.equal(first.nodesAdded.length, after.nodes.size);
  assert.equal(first.edgesAdded, after.edges.length);

  // 资源消失（LRU 淘汰）→ removed 与 latest 影子边消失。
  const removed = diffResourceGraphs(after, before);
  assert.ok(removed.nodesRemoved.includes('bridge://observation/s2'));
  assert.ok(removed.edgesRemoved >= 3);

  // kind/alias 变化进 nodesChanged。
  const changedRows = ROWS.map((row) => (row.uri === 'bridge://observation/s1' ? { ...row, mimeType: 'text/plain' } : row));
  const changed = diffResourceGraphs(before, graphOf(changedRows));
  assert.equal(changed.nodesChanged.length, 1);
  assert.equal(changed.nodesChanged[0].id, 'bridge://observation/s1');
  assert.equal(changed.nodesChanged[0].changes.mimeType.from, 'application/json');
  assert.equal(diffResourceGraphs(null, null).nodesAdded.length, 0);
});

test('auditResourceGraph：合法图通过；未知 URI/重复/悬空边/自环/未知边类型被抓出', () => {
  const good = graphOf();
  const report = auditResourceGraph(good);
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.stats.nodes, good.nodes.size);
  assert.equal(report.stats.fingerprint, good.fingerprint);
  assert.doesNotThrow(() => assertResourceGraph(good));

  const node = (id, kind, extra = {}) => ({ id, kind, virtual: false, uri: id, name: null, title: null, mimeType: null, dynamic: false, alias: false, session: null, template: null, reference: null, priority: null, ...extra });
  const unknownKind = craftedGraph({ nodes: [node('bridge://weird/thing', 'unknown')] });
  const unknownReport = auditResourceGraph(unknownKind);
  assert.equal(unknownReport.ok, false);
  assert.ok(unknownReport.errors.some((error) => error.code === 'graph-node-kind'));
  assert.throws(() => assertResourceGraph(unknownKind), /resource graph 审计失败/);

  const duplicate = craftedGraph({ nodes: [node('bridge://observation/s1', 'observation', { session: 's1', template: 'bridge://observation/{session}', dynamic: true })], duplicates: ['bridge://observation/s1'] });
  assert.ok(auditResourceGraph(duplicate).errors.some((error) => error.code === 'graph-duplicates'));

  const dangling = craftedGraph({
    nodes: [node('bridge://observation/s1', 'observation', { session: 's1', template: 'bridge://observation/{session}', dynamic: true })],
    edges: [{ from: 'bridge://observation/s1', to: 'bridge://missing', type: 'template-instance', weight: 1 }],
  });
  const danglingReport = auditResourceGraph(dangling);
  assert.ok(danglingReport.errors.some((error) => error.code === 'graph-dangling'));

  const selfLoop = craftedGraph({
    nodes: [node('bridge://observation/s1', 'observation', { session: 's1', template: 'bridge://observation/{session}', dynamic: true })],
    edges: [{ from: 'bridge://observation/s1', to: 'bridge://observation/s1', type: 'template-instance', weight: 1 }],
  });
  assert.ok(auditResourceGraph(selfLoop).errors.some((error) => error.code === 'graph-self-loop'));

  const unknownEdge = craftedGraph({
    nodes: [node('bridge://observation/s1', 'observation', { session: 's1', template: 'bridge://observation/{session}', dynamic: true }), node('session:s1', 'session', { virtual: true, session: 's1' })],
    edges: [{ from: 'bridge://observation/s1', to: 'session:s1', type: 'made-up', weight: 1 }],
  });
  const unknownEdgeReport = auditResourceGraph(unknownEdge);
  assert.ok(unknownEdgeReport.errors.some((error) => error.code === 'graph-edge-type'));
  // 会话实例缺 template-instance/session-scope 边也要报。
  assert.ok(unknownEdgeReport.errors.some((error) => error.code === 'graph-edge-missing'));
  assert.ok(auditResourceGraph(null).errors.some((error) => error.code === 'graph-missing'));
});

test('buildGraphWithDiff：第一次全量 added，第二次 unchanged，能力快照自洽', () => {
  const rows = ROWS;
  const first = buildGraphWithDiff(null, rows);
  assert.equal(first.diff.before, null);
  assert.ok(first.diff.nodesAdded.length > 0);
  assert.equal(first.summary.nodes, first.graph.nodes.size);
  const second = buildGraphWithDiff(first.graph, rows);
  assert.equal(second.diff.unchanged, true);
  const third = buildGraphWithDiff(second.graph, [...rows, { uri: 'bridge://observation/s9' }]);
  assert.ok(third.diff.nodesAdded.includes('bridge://observation/s9'));

  const snapshot = resourceGraphSnapshot();
  assert.equal(snapshot.supported, true);
  assert.deepEqual([...snapshot.edgeTypes], Object.values(GRAPH_EDGE_TYPES));
  assert.equal(snapshot.latestAliases.observation, LATEST_ALIASES.observation);
  assert.equal(snapshot.diff.fields.includes('graph'), true);
  assert.equal(snapshot.diff.fields.includes('graphDiff'), true);
  assert.ok(snapshot.templates.length >= 4);
});
