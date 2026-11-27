// mcp/resource-graph.mjs —— MCP resources 的关系图谱层（节点 / 边 / 子图 / 差量 / 硬审计）。
//
// 目标（第十一批-C ①：resource graph 与订阅 diff）：
//   resources/list 只能给“一行一个 URI”的平铺集合。真实使用时客户端真正想知道的是关系：
//   “这个会话的观察/证据/journal 是同一组”、“latest 是哪一个会话的别名”、“技能参考属于
//   哪份主文档”、“我刚收到 updated 通知，还应该读哪些相关资源”。本模块把这些关系显式化成
//   一张有向图：
//     - 资源节点：URI → kind/动态/静态/session/别名/模板引用（由 URI 形状派生，不信任行内字段）；
//     - 虚拟节点：session:{id}（会话聚合点）与 template:{uriTemplate}（模板声明点）；
//     - 边：template-instance / session-scope / session-sibling / latest-shadow / skill-parent。
//
// 设计约束：
//   1. 纯函数、无 IO：输入就是 resources/list 的行（RESOURCES.list() 的返回），不读盘、不访问 daemon；
//   2. 默认顺序稳定：节点按输入行顺序 + 虚拟节点按发现顺序；边按去重后的插入顺序；
//   3. 有界：节点数 = 行数 + session 数 + 模板数（快照 LRU 本身有界，图天然有界）；
//   4. 差量可解释：diff 给 added/removed/changed 的完整 id 列表与计数，客户端不必自己比 JSON；
//   5. 审计不猜：未知 URI 形状、悬空边、模板缺失都进 errors，由 server 启动期/单测断言。
//
// 调用点（真实消费）：
//   - mcp/server.mjs：initialize 的 experimental['browser-bridge/resource-graph'] 能力声明；
//   - resources/list 的 _meta['browser-bridge/resources'].graph / .graphDiff（与上一次 list 的差量）；
//   - resources/subscribe / unsubscribe 的回执 _meta.related（图谱邻居，告诉客户端“还该订阅什么”）；
//   - 单测 tests/unit/mcp-resource-graph.test.mjs。
//
// 与 mcp/resource-index.mjs 的分工：resource-index 负责“平铺列表的过滤/排序/分布”，本模块
// 负责“行与行之间的关系”；kind 判定复用同一份规则（INDEX_KINDS），避免两处漂移。

import { createHash } from 'node:crypto';
import { INDEX_KINDS, resourceKindOf } from './resource-index.mjs';

/** 图谱节点种类：资源种类 + 两个虚拟种类。 */
export const GRAPH_NODE_KINDS = Object.freeze({
  ...INDEX_KINDS,
  SESSION: 'session',
  TEMPLATE: 'template',
});

/** 虚拟节点种类（不对应 resources/list 里的行）。 */
export const VIRTUAL_NODE_KINDS = Object.freeze([GRAPH_NODE_KINDS.SESSION, GRAPH_NODE_KINDS.TEMPLATE]);

/** 图谱边类型（有方向；语义见下）。 */
export const GRAPH_EDGE_TYPES = Object.freeze({
  /** 实例 → 模板声明（bridge://observation/s1 → bridge://observation/{session}）。 */
  TEMPLATE_INSTANCE: 'template-instance',
  /** 会话级资源 → session 虚拟节点（聚合点）。 */
  SESSION_SCOPE: 'session-scope',
  /** 同一会话的不同种类资源之间（observation ↔ evidence ↔ journal）。 */
  SESSION_SIBLING: 'session-sibling',
  /** latest 别名 → 各会话实例（bridge://observation/latest → bridge://observation/s1）。 */
  LATEST_SHADOW: 'latest-shadow',
  /** 技能参考 → 技能主文档（bridge://skill/references/x.md → bridge://skill/SKILL.md）。 */
  SKILL_PARENT: 'skill-parent',
});

/** 模板 → URI 形状（与 mcp/resources.mjs templates() 一致；只用于图谱，不复制可读内容）。 */
export const GRAPH_TEMPLATES = Object.freeze([
  Object.freeze({ uriTemplate: 'bridge://skill/references/{name}', variable: 'name', kind: INDEX_KINDS.SKILL_REFERENCE }),
  Object.freeze({ uriTemplate: 'bridge://observation/{session}', variable: 'session', kind: INDEX_KINDS.OBSERVATION }),
  Object.freeze({ uriTemplate: 'bridge://debug/evidence/{session}', variable: 'session', kind: INDEX_KINDS.EVIDENCE }),
  Object.freeze({ uriTemplate: 'bridge://debug/journal/{session}', variable: 'session', kind: INDEX_KINDS.JOURNAL }),
]);

/** 会话级动态资源种类（会挂到 session 节点上）。 */
export const SESSION_SCOPED_KINDS = Object.freeze([INDEX_KINDS.OBSERVATION, INDEX_KINDS.EVIDENCE, INDEX_KINDS.JOURNAL]);

/** latest 别名 URI（每个会话级种类一个）。 */
export const LATEST_ALIASES = Object.freeze({
  [INDEX_KINDS.OBSERVATION]: 'bridge://observation/latest',
  [INDEX_KINDS.EVIDENCE]: 'bridge://debug/evidence/latest',
  [INDEX_KINDS.JOURNAL]: 'bridge://debug/journal/latest',
});

/** 技能主文档 URI（参考文档的父节点）。 */
export const SKILL_MAIN_URI = 'bridge://skill/SKILL.md';

/** 图算法默认上限（防止恶意超大输入把 BFS 拖死）。 */
export const GRAPH_LIMITS = Object.freeze({
  maxDepth: 4,
  maxNeighbors: 512,
  maxPathNodes: 4096,
});

/** 图谱错误（server 不该在正常路径触发；供审计/测试断言）。 */
export class ResourceGraphError extends Error {
  constructor(code, message) {
    super(String(message));
    this.name = 'ResourceGraphError';
    this.code = code;
  }
}

function splitUri(uri) {
  const text = String(uri || '');
  const [baseUri, query = ''] = text.split('?');
  const rest = baseUri.startsWith('bridge://') ? baseUri.slice('bridge://'.length) : '';
  const segments = rest.split('/').filter(Boolean);
  return { baseUri, query, segments, host: segments[0] || '' };
}

/**
 * 解析资源 URI 的结构（不读内容）：host / segments / kind / session / alias / 模板 / 引用名。
 * 未知/非法形状返回 kind=unknown，不抛错（由审计暴露），避免 graph 构建被单条坏 URI 拖死。
 *
 * @param {string} uri
 * @returns {{
 *   uri:string, baseUri:string, query:string, host:string, segments:ReadonlyArray<string>,
 *   kind:string, key:(string|null), session:(string|null), alias:boolean,
 *   template:(string|null), reference:(string|null), dynamic:boolean,
 * }}
 */
export function parseResourceUri(uri) {
  const { baseUri, query, segments, host } = splitUri(uri);
  const kind = resourceKindOf(baseUri);
  const dynamic = SESSION_SCOPED_KINDS.includes(kind);
  let session = null;
  let alias = false;
  let template = null;
  let reference = null;
  let key = segments.length > 1 ? segments[segments.length - 1] : null;

  if (kind === INDEX_KINDS.OBSERVATION) {
    key = segments[1] || null;
    if (key === 'latest') {
      alias = true;
    } else if (key) {
      session = key;
      template = GRAPH_TEMPLATES.find((item) => item.kind === kind).uriTemplate;
    }
  } else if (kind === INDEX_KINDS.EVIDENCE || kind === INDEX_KINDS.JOURNAL) {
    key = segments[2] || null;
    if (key === 'latest') {
      alias = true;
    } else if (key) {
      session = key;
      template = GRAPH_TEMPLATES.find((item) => item.kind === kind).uriTemplate;
    }
  } else if (kind === INDEX_KINDS.SKILL_REFERENCE) {
    reference = segments[2] || null;
    key = reference;
    template = GRAPH_TEMPLATES.find((item) => item.kind === kind).uriTemplate;
  }

  return Object.freeze({
    uri: String(uri),
    baseUri,
    query,
    host,
    segments: Object.freeze([...segments]),
    kind,
    key,
    session,
    alias,
    template,
    reference,
    dynamic,
  });
}

/** 资源行的节点 id（= 去查询串后的 baseUri，保证 ?limit=&cursor= 不产生重复节点）。 */
export function graphNodeIdOf(uri) {
  return splitUri(uri).baseUri;
}

function templateNodeId(uriTemplate) {
  return 'template:' + uriTemplate;
}

function sessionNodeId(session) {
  return 'session:' + session;
}

function nodeOfRow(row) {
  const parsed = parseResourceUri(row && row.uri);
  return Object.freeze({
    id: parsed.baseUri,
    kind: parsed.kind,
    virtual: false,
    uri: parsed.baseUri,
    name: row && row.name ? String(row.name) : null,
    title: row && row.title ? String(row.title) : null,
    mimeType: row && row.mimeType ? String(row.mimeType) : null,
    dynamic: parsed.dynamic,
    alias: parsed.alias,
    session: parsed.session,
    template: parsed.template,
    reference: parsed.reference,
    priority: row && row.annotations && typeof row.annotations.priority === 'number' ? row.annotations.priority : null,
  });
}

function virtualNode(id, kind, extra = {}) {
  return Object.freeze({ id, kind, virtual: true, uri: null, name: null, title: null, mimeType: null, dynamic: false, alias: false, session: null, template: null, reference: null, priority: null, ...extra });
}

/** 节点字符串 id 列表排序（稳定）。 */
function sortedIds(iterable) {
  return [...iterable].sort();
}

/**
 * 由 resources/list 的行构建关系图。
 *
 * 建图规则（顺序稳定、可解释）：
 *   1. 每个非空行 → 一个资源节点（id=baseUri；undefined/null 行忽略）；
 *   2. 每种被引用的模板 → 一个 template 虚拟节点；每个会话 → 一个 session 虚拟节点；
 *   3. 模板实例边、会话归属边、会话兄弟边、latest 影子边、技能父子边按规则补齐；
 *   4. 同一对节点同一类型只保留一条边（去重），重复行也会被发现（duplicates）。
 *
 * @param {Array<object>} rows RESOURCES.list() 的行
 * @param {{templates?:Array<object>|null}} [options]
 * @returns {{
 *   nodes: Map<string, object>, edges: ReadonlyArray<object>,
 *   templates: ReadonlyArray<object>, sessions: ReadonlyArray<string>,
 *   duplicates: ReadonlyArray<string>, unknown: ReadonlyArray<string>,
 *   fingerprint: string,
 * }}
 */
export function buildResourceGraph(rows, { templates = GRAPH_TEMPLATES } = {}) {
  const declaredTemplates = Array.isArray(templates) && templates.length ? templates : GRAPH_TEMPLATES;
  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const duplicates = [];
  const seenRow = new Set();

  const addEdge = (from, to, type, weight = 1) => {
    if (!nodes.has(from) || !nodes.has(to)) return false;
    const key = from + '\u0000' + to + '\u0000' + type;
    if (edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    edges.push(Object.freeze({ from, to, type, weight }));
    return true;
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || typeof row.uri !== 'string' || !row.uri.trim()) continue;
    const node = nodeOfRow(row);
    if (nodes.has(node.id)) {
      duplicates.push(node.id);
      continue;
    }
    nodes.set(node.id, node);
  }

  // 模板虚拟节点：只给“真正被实例引用”的模板建节点（templates 参数里声明的模板也保留声明节点）。
  const templateSet = new Map();
  for (const template of declaredTemplates) {
    if (!template || typeof template.uriTemplate !== 'string') continue;
    templateSet.set(template.uriTemplate, template);
    const id = templateNodeId(template.uriTemplate);
    if (!nodes.has(id)) nodes.set(id, virtualNode(id, GRAPH_NODE_KINDS.TEMPLATE, { template: template.uriTemplate, title: template.uriTemplate }));
  }

  // 会话虚拟节点 + 实例边。
  for (const node of [...nodes.values()]) {
    if (node.virtual) continue;
    if (node.template && !node.alias) {
      addEdge(node.id, templateNodeId(node.template), GRAPH_EDGE_TYPES.TEMPLATE_INSTANCE, 1);
    }
    if (node.session) {
      const sid = sessionNodeId(node.session);
      if (!nodes.has(sid)) nodes.set(sid, virtualNode(sid, GRAPH_NODE_KINDS.SESSION, { session: node.session, title: '会话 ' + node.session }));
      addEdge(node.id, sid, GRAPH_EDGE_TYPES.SESSION_SCOPE, 1);
    }
  }

  // 同一会话的兄弟边（observation/evidence/journal 两两互连，供“还应读哪些”提示）。
  const bySession = new Map();
  for (const node of nodes.values()) {
    if (node.session && SESSION_SCOPED_KINDS.includes(node.kind)) {
      if (!bySession.has(node.session)) bySession.set(node.session, []);
      bySession.get(node.session).push(node);
    }
  }
  for (const list of bySession.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        addEdge(list[i].id, list[j].id, GRAPH_EDGE_TYPES.SESSION_SIBLING, 2);
        addEdge(list[j].id, list[i].id, GRAPH_EDGE_TYPES.SESSION_SIBLING, 2);
      }
    }
  }

  // latest 别名 → 同类会话实例（影子关系）。
  for (const [kind, aliasUri] of Object.entries(LATEST_ALIASES)) {
    const aliasId = aliasUri;
    if (!nodes.has(aliasId)) continue;
    for (const node of nodes.values()) {
      if (node.virtual || node.alias) continue;
      if (node.kind === kind && node.session) addEdge(aliasId, node.id, GRAPH_EDGE_TYPES.LATEST_SHADOW, 1);
    }
  }

  // 技能参考 → 主文档（主文档不在行集合里时跳过：图不伪造不存在的节点）。
  const skillMain = nodes.get(SKILL_MAIN_URI);
  if (skillMain) {
    for (const node of nodes.values()) {
      if (node.kind === INDEX_KINDS.SKILL_REFERENCE) addEdge(node.id, SKILL_MAIN_URI, GRAPH_EDGE_TYPES.SKILL_PARENT, 1);
    }
  }

  const unknown = [...nodes.values()]
    .filter((node) => !node.virtual && node.kind === INDEX_KINDS.UNKNOWN)
    .map((node) => node.id);
  const sessions = [...nodes.values()].filter((node) => node.kind === GRAPH_NODE_KINDS.SESSION).map((node) => node.session).sort();
  const frozenEdges = Object.freeze(edges);
  const graph = {
    nodes,
    edges: frozenEdges,
    templates: Object.freeze([...templateSet.values()]),
    sessions: Object.freeze(sessions),
    duplicates: Object.freeze(duplicates),
    unknown: Object.freeze(unknown),
    fingerprint: graphFingerprint(nodes, frozenEdges),
  };
  return graph;
}

/**
 * 图的稳定指纹（sha256，输入是排序后的节点 id + 排序后的边三元组）。
 * 用途：resources/list 的 _meta 里给客户端一个“集合是否变了”的廉价比较值，也用于差量测试。
 */
export function graphFingerprint(nodes, edges) {
  const nodeIds = nodes instanceof Map ? sortedIds(nodes.keys()) : sortedIds((nodes || []).map((node) => node && node.id).filter(Boolean));
  const edgeTriples = (Array.isArray(edges) ? edges : [])
    .map((edge) => String(edge.from) + '|' + String(edge.type) + '|' + String(edge.to))
    .sort();
  const hash = createHash('sha256');
  hash.update('nodes\n' + nodeIds.join('\n'));
  hash.update('\nedges\n' + edgeTriples.join('\n'));
  return hash.digest('hex');
}

function graphFromInput(graph) {
  if (!graph || typeof graph !== 'object') return null;
  if (!(graph.nodes instanceof Map)) return null;
  return graph;
}

/** 取节点；不存在返回 null。 */
export function nodeOf(graph, id) {
  const target = graphFromInput(graph);
  if (!target) return null;
  return target.nodes.get(String(id)) || null;
}

/** 某个节点的直接邻居（可限定边类型/方向）。 */
export function neighbors(graph, id, { type = null, direction = 'both', limit = GRAPH_LIMITS.maxNeighbors } = {}) {
  const target = graphFromInput(graph);
  const node = target ? target.nodes.get(String(id)) : null;
  if (!node) return Object.freeze([]);
  const types = type == null ? null : (Array.isArray(type) ? new Set(type) : new Set([String(type)]));
  const out = [];
  for (const edge of target.edges) {
    if (types && !types.has(edge.type)) continue;
    let otherId = null;
    if ((direction === 'both' || direction === 'out') && edge.from === node.id) otherId = edge.to;
    else if ((direction === 'both' || direction === 'in') && edge.to === node.id) otherId = edge.from;
    if (!otherId) continue;
    const other = target.nodes.get(otherId);
    if (!other) continue;
    out.push(Object.freeze({ node: other, edge, direction: edge.from === node.id ? 'out' : 'in' }));
    if (out.length >= limit) break;
  }
  return Object.freeze(out);
}

/** 邻居 URI 列表（只返回资源节点，不含虚拟节点；用于订阅建议）。 */
export function relatedUris(graph, uri, { depth = 1, types = null, limit = 32 } = {}) {
  const start = graphNodeIdOf(uri);
  const target = graphFromInput(graph);
  if (!target || !target.nodes.has(start)) return Object.freeze([]);
  const maxDepth = Math.max(1, Math.min(Number(depth) || 1, GRAPH_LIMITS.maxDepth));
  const seen = new Set([start]);
  const found = [];
  let frontier = [start];
  for (let level = 0; level < maxDepth; level += 1) {
    const next = [];
    for (const id of frontier) {
      for (const entry of neighbors(target, id, { type: types })) {
        const other = entry.node;
        if (seen.has(other.id)) continue;
        seen.add(other.id);
        if (!other.virtual && other.uri) found.push(Object.freeze({ uri: other.uri, kind: other.kind, distance: level + 1, edge: entry.edge.type }));
        next.push(other.id);
        if (found.length >= limit) return Object.freeze(found);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return Object.freeze(found);
}

/** 以某节点为根的有界子图（BFS，含根）。 */
export function subgraph(graph, id, { depth = 1 } = {}) {
  const target = graphFromInput(graph);
  const start = target ? target.nodes.get(String(id)) : null;
  if (!start) throw new ResourceGraphError('E_NOT_FOUND', '图谱里没有节点：' + id);
  const maxDepth = Math.max(0, Math.min(Number(depth) || 0, GRAPH_LIMITS.maxDepth));
  const ids = new Set([start.id]);
  let frontier = [start.id];
  for (let level = 0; level < maxDepth; level += 1) {
    const next = [];
    for (const current of frontier) {
      for (const entry of neighbors(target, current)) {
        if (ids.has(entry.node.id)) continue;
        ids.add(entry.node.id);
        next.push(entry.node.id);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  const edges = target.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  return Object.freeze({
    root: start.id,
    depth: maxDepth,
    nodes: Object.freeze([...ids].sort().map((nodeId) => target.nodes.get(nodeId))),
    edges: Object.freeze(edges),
  });
}

/** 两节点间的无权最短路径（BFS）；不可达返回 []。 */
export function shortestPath(graph, from, to) {
  const target = graphFromInput(graph);
  if (!target) return Object.freeze([]);
  const source = target.nodes.get(String(from));
  const goal = target.nodes.get(String(to));
  if (!source || !goal) return Object.freeze([]);
  if (source.id === goal.id) return Object.freeze([source.id]);
  const visited = new Set([source.id]);
  const parent = new Map();
  const queue = [source.id];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of neighbors(target, current)) {
      const next = entry.node.id;
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);
      if (next === goal.id) {
        const path = [goal.id];
        let cursor = goal.id;
        while (parent.has(cursor)) { cursor = parent.get(cursor); path.unshift(cursor); }
        return Object.freeze(path);
      }
      if (visited.size > GRAPH_LIMITS.maxPathNodes) return Object.freeze([]);
      queue.push(next);
    }
  }
  return Object.freeze([]);
}

/** 连通分量（连通集合，边无向看待；虚拟节点也属于分量）。 */
export function connectedComponents(graph) {
  const target = graphFromInput(graph);
  if (!target) return Object.freeze([]);
  const parent = new Map();
  const find = (x) => {
    let cursor = x;
    while (parent.has(cursor) && parent.get(cursor) !== cursor) cursor = parent.get(cursor);
    return cursor;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const id of target.nodes.keys()) parent.set(id, id);
  for (const edge of target.edges) union(edge.from, edge.to);
  const groups = new Map();
  for (const id of target.nodes.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return Object.freeze([...groups.values()]
    .map((ids) => Object.freeze(sortedIds(ids)))
    .sort((a, b) => b.length - a.length || String(a[0]).localeCompare(String(b[0]))));
}

/** 会话索引：session → { observation, evidence, journal, aliases }。 */
export function sessionIndex(graph) {
  const target = graphFromInput(graph);
  const index = new Map();
  if (!target) return index;
  for (const node of target.nodes.values()) {
    if (!node.session || !SESSION_SCOPED_KINDS.includes(node.kind)) continue;
    if (!index.has(node.session)) index.set(node.session, Object.freeze({ observation: null, evidence: null, journal: null, aliases: [] }));
    const current = index.get(node.session);
    const patch = {};
    patch[node.kind] = node.uri;
    index.set(node.session, Object.freeze({
      ...current,
      ...patch,
      aliases: current.aliases,
    }));
  }
  for (const [kind, aliasUri] of Object.entries(LATEST_ALIASES)) {
    if (!target.nodes.has(aliasUri)) continue;
    for (const entry of neighbors(target, aliasUri, { type: GRAPH_EDGE_TYPES.LATEST_SHADOW })) {
      const session = entry.node.session;
      if (!session || !index.has(session)) continue;
      const current = index.get(session);
      index.set(session, Object.freeze({ ...current, aliases: Object.freeze([...current.aliases, kind]) }));
    }
  }
  return index;
}

/**
 * 图谱摘要（resources/list 的 _meta.graph 用）。
 * @returns {{ nodes:number, edges:number, sessions:number, templates:number,
 *             byKind:object, byEdge:object, dynamic:number, staticNodes:number,
 *             virtualNodes:number, components:number, orphans:Array<string>,
 *             unknown:Array<string>, duplicates:Array<string>, fingerprint:string }}
 */
export function summarizeGraph(graph) {
  const target = graphFromInput(graph);
  if (!target) {
    return Object.freeze({ nodes: 0, edges: 0, sessions: 0, templates: 0, byKind: {}, byEdge: {}, dynamic: 0, staticNodes: 0, virtualNodes: 0, components: 0, orphans: [], unknown: [], duplicates: [], fingerprint: null });
  }
  const byKind = {};
  const byEdge = {};
  let dynamic = 0;
  let virtualNodes = 0;
  for (const node of target.nodes.values()) {
    byKind[node.kind] = (byKind[node.kind] || 0) + 1;
    if (node.virtual) virtualNodes += 1;
    else if (node.dynamic) dynamic += 1;
  }
  for (const edge of target.edges) byEdge[edge.type] = (byEdge[edge.type] || 0) + 1;
  const degree = new Map();
  for (const edge of target.edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  const orphans = [...target.nodes.values()]
    .filter((node) => !node.virtual && !(degree.get(node.id) > 0))
    .map((node) => node.id)
    .sort();
  return Object.freeze({
    nodes: target.nodes.size,
    edges: target.edges.length,
    sessions: target.sessions.length,
    templates: target.templates.length,
    byKind: Object.freeze(byKind),
    byEdge: Object.freeze(byEdge),
    dynamic,
    staticNodes: target.nodes.size - virtualNodes - dynamic,
    virtualNodes,
    components: connectedComponents(target).length,
    orphans: Object.freeze(orphans),
    unknown: target.unknown,
    duplicates: target.duplicates,
    fingerprint: target.fingerprint,
  });
}

/**
 * 两张图的差量（resources/list 的 _meta.graphDiff 用）。
 * 差量同时给“节点级”与“边级”，并把 changed 的字段差异列出来（kind/template/session 变化）。
 * @returns {{ nodesAdded:ReadonlyArray<string>, nodesRemoved:ReadonlyArray<string>,
 *             nodesChanged:ReadonlyArray<{id:string, changes:object}>,
 *             edgesAdded:number, edgesRemoved:number, unchanged:boolean,
 *             before:object|null, after:object, fingerprintChanged:boolean }}
 */
export function diffResourceGraphs(before, after) {
  const next = graphFromInput(after);
  const prev = graphFromInput(before);
  const summary = {
    nodesAdded: [],
    nodesRemoved: [],
    nodesChanged: [],
    edgesAdded: 0,
    edgesRemoved: 0,
    unchanged: false,
    before: prev ? prev.fingerprint : null,
    after: next ? next.fingerprint : null,
    fingerprintChanged: !prev || !next || prev.fingerprint !== next.fingerprint,
  };
  if (!next) return Object.freeze({ ...summary, nodesAdded: Object.freeze([]), nodesRemoved: Object.freeze([]), nodesChanged: Object.freeze([]) });
  if (!prev) {
    return Object.freeze({
      ...summary,
      nodesAdded: Object.freeze(sortedIds(next.nodes.keys())),
      nodesRemoved: Object.freeze([]),
      nodesChanged: Object.freeze([]),
      edgesAdded: next.edges.length,
      edgesRemoved: 0,
      unchanged: next.nodes.size === 0 && next.edges.length === 0,
    });
  }
  for (const id of sortedIds(next.nodes.keys())) {
    if (!prev.nodes.has(id)) summary.nodesAdded.push(id);
    else {
      const oldNode = prev.nodes.get(id);
      const newNode = next.nodes.get(id);
      const changes = {};
      for (const field of ['kind', 'dynamic', 'alias', 'session', 'template', 'mimeType', 'priority']) {
        if (oldNode[field] !== newNode[field]) changes[field] = { from: oldNode[field], to: newNode[field] };
      }
      if (Object.keys(changes).length) summary.nodesChanged.push({ id, changes });
    }
  }
  for (const id of sortedIds(prev.nodes.keys())) if (!next.nodes.has(id)) summary.nodesRemoved.push(id);
  const prevEdges = new Set(prev.edges.map((edge) => edge.from + '\u0000' + edge.type + '\u0000' + edge.to));
  const nextEdges = new Set(next.edges.map((edge) => edge.from + '\u0000' + edge.type + '\u0000' + edge.to));
  for (const key of nextEdges) if (!prevEdges.has(key)) summary.edgesAdded += 1;
  for (const key of prevEdges) if (!nextEdges.has(key)) summary.edgesRemoved += 1;
  summary.unchanged = summary.nodesAdded.length === 0 && summary.nodesRemoved.length === 0
    && summary.nodesChanged.length === 0 && summary.edgesAdded === 0 && summary.edgesRemoved === 0;
  return Object.freeze({
    ...summary,
    nodesAdded: Object.freeze(summary.nodesAdded),
    nodesRemoved: Object.freeze(summary.nodesRemoved),
    nodesChanged: Object.freeze(summary.nodesChanged.map((item) => Object.freeze({ id: item.id, changes: Object.freeze(item.changes) }))),
  });
}

/**
 * 图谱一致性审计（server 可用 assertResourceGraph 做硬门禁；单测也用它）。
 * 规则：
 *   - 每个资源节点 id 以 bridge:// 开头且 kind 不为 unknown（未知形状必须暴露）；
 *   - 每条边的两个端点都存在，类型在已知集合内，不允许自环；
 *   - 会话级实例必须同时有 template-instance 与 session-scope 边；
 *   - latest 别名不得带 session；技能参考必须有 reference；
 *   - duplicates/unknown 必须为空（重复 URI 会让客户端对不上）。
 * @returns {{ ok:boolean, errors:Array<{code:string,target:string,message:string}>, stats:object }}
 */
export function auditResourceGraph(graph) {
  const errors = [];
  const push = (code, target, message) => errors.push(Object.freeze({ code, target: String(target || '<graph>'), message }));
  const target = graphFromInput(graph);
  if (!target) {
    push('graph-missing', '<graph>', '没有可审计的图谱（nodes 不是 Map）');
    return Object.freeze({ ok: false, errors: Object.freeze(errors), stats: Object.freeze({}) });
  }
  if (!target.nodes.size) push('graph-empty', '<graph>', '图谱没有节点');
  const edgeTypes = new Set(Object.values(GRAPH_EDGE_TYPES));
  const outTypes = new Map();
  for (const edge of target.edges) {
    if (!target.nodes.has(edge.from)) push('graph-dangling', edge.from, '边的起点不存在：' + edge.type + ' → ' + edge.to);
    if (!target.nodes.has(edge.to)) push('graph-dangling', edge.to, '边的终点不存在：' + edge.from + ' → ' + edge.type);
    if (edge.from === edge.to) push('graph-self-loop', edge.from, '不允许自环：' + edge.type);
    if (!edgeTypes.has(edge.type)) push('graph-edge-type', edge.from, '未知边类型：' + edge.type);
    if (!outTypes.has(edge.from)) outTypes.set(edge.from, new Set());
    outTypes.get(edge.from).add(edge.type);
  }
  for (const node of target.nodes.values()) {
    if (node.virtual) {
      if (node.kind === GRAPH_NODE_KINDS.SESSION && !node.session) push('graph-virtual', node.id, 'session 虚拟节点缺 session 字段');
      if (node.kind === GRAPH_NODE_KINDS.TEMPLATE && !node.template) push('graph-virtual', node.id, 'template 虚拟节点缺 template 字段');
      continue;
    }
    if (!String(node.id).startsWith('bridge://')) push('graph-node-uri', node.id, '资源节点 id 必须是 bridge:// URI');
    if (node.kind === INDEX_KINDS.UNKNOWN) push('graph-node-kind', node.id, '无法从 URI 派生资源种类');
    if (node.alias && node.session) push('graph-node-alias', node.id, 'latest 别名不能带 session');
    if (node.kind === INDEX_KINDS.SKILL_REFERENCE && !node.reference) push('graph-node-reference', node.id, '技能参考节点缺 reference 名');
    if (SESSION_SCOPED_KINDS.includes(node.kind) && node.session) {
      const out = outTypes.get(node.id) || new Set();
      if (!out.has(GRAPH_EDGE_TYPES.TEMPLATE_INSTANCE)) push('graph-edge-missing', node.id, '会话级实例缺 template-instance 边');
      if (!out.has(GRAPH_EDGE_TYPES.SESSION_SCOPE)) push('graph-edge-missing', node.id, '会话级实例缺 session-scope 边');
    }
  }
  if (target.duplicates.length) push('graph-duplicates', target.duplicates.join(','), '存在重复 URI 节点');
  if (target.unknown.length) push('graph-unknown', target.unknown.join(','), '存在未知种类的资源节点');
  const summary = summarizeGraph(target);
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    stats: Object.freeze({
      nodes: summary.nodes,
      edges: summary.edges,
      sessions: summary.sessions,
      templates: summary.templates,
      components: summary.components,
      byEdge: summary.byEdge,
      fingerprint: summary.fingerprint,
    }),
  });
}

/** strict 包装：图谱漂移（未知 URI/悬空边/重复行）时启动即失败。 */
export function assertResourceGraph(graph) {
  const report = auditResourceGraph(graph);
  if (!report.ok) {
    throw new Error('MCP resource graph 审计失败：\n' + report.errors.map((error) => error.code + ' ' + error.target + ' ' + error.message).join('\n'));
  }
  return report;
}

/**
 * 一次完成“建图 + 与上一张图做差”：server 的 resources/list 每次调用走这条路径，
 * 既拿到当前图谱摘要，又拿到“自上次 list 以来变了什么”。
 * @param {object|null} previousGraph
 * @param {Array<object>} rows
 * @param {{templates?:Array<object>}} [options]
 */
export function buildGraphWithDiff(previousGraph, rows, options = {}) {
  const graph = buildResourceGraph(rows, options);
  const diff = diffResourceGraphs(previousGraph, graph);
  return Object.freeze({ graph, diff, summary: summarizeGraph(graph) });
}

/** 图谱能力快照（initialize experimental['browser-bridge/resource-graph']）。 */
export function resourceGraphSnapshot({ templates = GRAPH_TEMPLATES } = {}) {
  const declared = Array.isArray(templates) && templates.length ? templates : GRAPH_TEMPLATES;
  return Object.freeze({
    supported: true,
    nodeKinds: Object.freeze(Object.values(GRAPH_NODE_KINDS)),
    virtualKinds: VIRTUAL_NODE_KINDS,
    edgeTypes: Object.freeze(Object.values(GRAPH_EDGE_TYPES)),
    templates: Object.freeze(declared.map((template) => template.uriTemplate)),
    latestAliases: LATEST_ALIASES,
    limits: GRAPH_LIMITS,
    diff: Object.freeze({
      metaKey: 'browser-bridge/resources',
      fields: Object.freeze(['graph', 'graphDiff']),
      diffFields: Object.freeze(['nodesAdded', 'nodesRemoved', 'nodesChanged', 'edgesAdded', 'edgesRemoved', 'fingerprintChanged']),
    }),
    related: Object.freeze({
      method: 'resources/subscribe',
      metaField: 'browser-bridge/subscription',
      field: 'related',
      note: '订阅回执会带图谱邻居 URI（同会话兄弟 / latest 别名 / 技能父文档），客户端可决定是否一并订阅',
    }),
  });
}
