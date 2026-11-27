// lib/vom-query.js —— 关系图查询：按 kind / role / name 过滤 + 分页 + 摘要（纯函数）。
//
// 关系图（lib/vom-relations.js）可能包含上千条边，Agent 真正需要的是“第 2 页、只看 labels、
// 角色是 button、名字含 提交 的 10 条，以及一句摘要”。本模块提供稳定、可单测的查询契约：
//   - 过滤：kind/type、source、confidence 区间、from/to、direction、self、crossFrame、role、name；
//   - 分页：offset/limit（默认 25，最大 200），返回 page.nextOffset/hasMore；
//   - 摘要：byType/bySource/byRole、置信度分桶、帧跨度、平均置信度。
// 角色/名字优先从关系记录上的 fromRole/toRole/fromName/toName 解析；没有时用传入的节点池补。

export const VOM_QUERY_VERSION = 1;

export const QUERY_DEFAULTS = Object.freeze({ limit: 25, maxLimit: 200, maxOffset: 10000 });

function listOf(value) {
  if (value == null) return [];
  const array = Array.isArray(value) ? value : [value];
  return array
    .map((item) => String(item == null ? '' : item).trim().toLowerCase())
    .filter(Boolean);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function relationArrayOf(graph) {
  if (Array.isArray(graph)) return graph;
  if (graph && Array.isArray(graph.relations)) return graph.relations;
  return [];
}

/** 节点 id → frame 标识：`frame:3` / `f3:@e7` / 普通 id（null）。 */
function frameOfNodeId(id) {
  const text = String(id == null ? '' : id);
  const frameNode = /^frame:(\d+)$/.exec(text);
  if (frameNode) return Number(frameNode[1]);
  const prefixed = /^f(\d+):/.exec(text);
  if (prefixed) return Number(prefixed[1]);
  return null;
}

/** 归一化查询参数（大小写不敏感；未知键忽略，不抛错）。 */
export function normalizeRelationQuery(query = {}) {
  const source = query && typeof query === 'object' ? query : {};
  const limit = clamp(source.limit == null ? QUERY_DEFAULTS.limit : source.limit, 1, QUERY_DEFAULTS.maxLimit);
  const offset = clamp(source.offset == null ? 0 : source.offset, 0, QUERY_DEFAULTS.maxOffset);
  const sort = ['insertion', 'confidence', 'type', 'name', 'source'].includes(String(source.sort))
    ? String(source.sort)
    : 'insertion';
  const minConfidence = numberOrNull(source.minConfidence);
  const maxConfidence = numberOrNull(source.maxConfidence);
  return {
    types: source.kind != null ? listOf(source.kind) : listOf(source.types != null ? source.types : source.type),
    sources: listOf(source.sources != null ? source.sources : source.source),
    roles: listOf(source.role != null ? source.role : source.roles),
    names: listOf(source.name != null ? source.name : source.names),
    minConfidence: minConfidence == null ? null : Math.min(1, Math.max(0, minConfidence)),
    maxConfidence: maxConfidence == null ? null : Math.min(1, Math.max(0, maxConfidence)),
    from: source.from == null ? null : String(source.from),
    to: source.to == null ? null : String(source.to),
    direction: ['both', 'out', 'in'].includes(String(source.direction)) ? String(source.direction) : 'both',
    self: source.self === true ? true : (source.self === false ? false : null),
    crossFrame: source.crossFrame === true,
    sort,
    offset,
    limit,
  };
}

function nodeIndex(nodes) {
  const map = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || node.id == null) continue;
    map.set(String(node.id), {
      role: String(node.role == null ? '' : node.role).toLowerCase(),
      name: String(node.name == null ? '' : node.name),
    });
  }
  return map;
}

function roleOf(index, id, fallback) {
  const direct = String(fallback == null ? '' : fallback).toLowerCase();
  if (direct) return direct;
  const node = index.get(String(id));
  return node ? node.role : '';
}

function nameOf(index, id, fallback) {
  const direct = String(fallback == null ? '' : fallback);
  if (direct) return direct;
  const node = index.get(String(id));
  return node ? node.name : '';
}

function matchesAny(value, filters) {
  if (!filters.length) return true;
  const text = String(value == null ? '' : value).toLowerCase();
  return filters.some((filter) => text.includes(filter));
}

/** 关系项的公开视图（只暴露查询/展示需要的字段）。 */
function queryItem(relation, index) {
  const fromRole = roleOf(index, relation.from, relation.fromRole);
  const toRole = roleOf(index, relation.to, relation.toRole);
  const fromName = nameOf(index, relation.from, relation.fromName);
  const toName = nameOf(index, relation.to, relation.toName);
  return {
    type: String(relation.type || ''),
    from: String(relation.from == null ? '' : relation.from),
    to: String(relation.to == null ? '' : relation.to),
    confidence: Number(relation.confidence) || 0,
    source: relation.source ? String(relation.source) : null,
    sources: Array.isArray(relation.sources) ? relation.sources.slice() : (relation.source ? [relation.source] : []),
    fromRole: fromRole || null,
    toRole: toRole || null,
    fromName: fromName || null,
    toName: toName || null,
    ...(relation.self === true ? { self: true } : {}),
    ...(relation.text ? { text: String(relation.text) } : {}),
    ...(relation.frame === true ? { frame: true } : {}),
    ...(Number.isFinite(Number(relation.depth)) ? { depth: Number(relation.depth) } : {}),
    ...(relation.chain ? { chain: relation.chain.slice() } : {}),
  };
}

function matchesQuery(item, query) {
  if (query.types.length && !query.types.includes(item.type.toLowerCase())) return false;
  if (query.sources.length) {
    const sources = item.sources.map((source) => String(source).toLowerCase());
    if (!query.sources.some((source) => sources.includes(source))) return false;
  }
  if (query.roles.length) {
    const roles = [item.fromRole, item.toRole].filter(Boolean);
    if (!query.roles.some((role) => roles.includes(role))) return false;
  }
  if (query.names.length) {
    const haystack = [item.fromName, item.toName, item.text].filter(Boolean).join('\u0000').toLowerCase();
    if (!query.names.some((name) => haystack.includes(name))) return false;
  }
  if (query.minConfidence != null && item.confidence < query.minConfidence) return false;
  if (query.maxConfidence != null && item.confidence > query.maxConfidence) return false;
  if (query.from != null && item.from !== query.from) return false;
  if (query.to != null && item.to !== query.to) return false;
  if (query.direction === 'out' && item.from !== query.from && query.from != null) return false;
  if (query.self != null && (item.self === true) !== query.self) return false;
  if (query.crossFrame) {
    const left = frameOfNodeId(item.from);
    const right = frameOfNodeId(item.to);
    const cross = (left != null && right != null && left !== right)
      || (left != null) !== (right != null)
      || item.frame === true;
    if (!cross) return false;
  }
  return true;
}

function sortItems(items, sort) {
  if (sort === 'insertion') return items;
  const list = items.slice();
  if (sort === 'confidence') list.sort((a, b) => b.confidence - a.confidence || a.type.localeCompare(b.type));
  else if (sort === 'type') list.sort((a, b) => a.type.localeCompare(b.type) || b.confidence - a.confidence);
  else if (sort === 'name') {
    list.sort((a, b) => String(a.toName || a.fromName || '').localeCompare(String(b.toName || b.fromName || '')));
  } else if (sort === 'source') {
    list.sort((a, b) => String(a.source || '').localeCompare(String(b.source || '')) || b.confidence - a.confidence);
  }
  return list;
}

function summaryOf(items, page) {
  const byType = {};
  const bySource = {};
  const byRole = {};
  const buckets = { high: 0, medium: 0, low: 0 };
  let confidenceSum = 0;
  let self = 0;
  let crossFrame = 0;
  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    for (const source of item.sources) bySource[source] = (bySource[source] || 0) + 1;
    for (const role of [item.fromRole, item.toRole]) if (role) byRole[role] = (byRole[role] || 0) + 1;
    confidenceSum += item.confidence;
    if (item.confidence >= 0.85) buckets.high += 1;
    else if (item.confidence >= 0.7) buckets.medium += 1;
    else buckets.low += 1;
    if (item.self === true) self += 1;
    const left = frameOfNodeId(item.from);
    const right = frameOfNodeId(item.to);
    if ((left != null && right != null && left !== right) || (left != null) !== (right != null) || item.frame === true) crossFrame += 1;
  }
  const sortedByType = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  return {
    total: items.length,
    returned: page.returned,
    byType,
    bySource,
    byRole,
    confidenceBuckets: buckets,
    averageConfidence: items.length ? Math.round((confidenceSum / items.length) * 1000) / 1000 : 0,
    self,
    crossFrame,
    kinds: sortedByType.map(([type]) => type),
  };
}

/**
 * @param {object|Array} relationGraph 关系图（{relations} 或关系数组）
 * @param {object} [query] 过滤/分页参数
 * @param {Array<{id:string,role?:string,name?:string}>} [nodes] 端点节点池（角色/名字来源）
 * @returns {{version:number, query:object, items:object[], page:object, summary:object}}
 */
export function queryVomRelations(relationGraph, query = {}, nodes = []) {
  const relations = relationArrayOf(relationGraph);
  const pool = Array.isArray(nodes) && nodes.length
    ? nodes
    : (relationGraph && Array.isArray(relationGraph.nodes) ? relationGraph.nodes : []);
  const index = nodeIndex(pool);
  const normalized = normalizeRelationQuery(query);
  const mapped = relations.map((relation) => queryItem(relation, index));
  const matched = mapped.filter((item) => matchesQuery(item, normalized));
  const sorted = sortItems(matched, normalized.sort);
  const total = sorted.length;
  const offset = Math.min(normalized.offset, total);
  const items = sorted.slice(offset, offset + normalized.limit);
  const page = {
    offset,
    limit: normalized.limit,
    total,
    returned: items.length,
    hasMore: offset + items.length < total,
    nextOffset: offset + items.length < total ? offset + items.length : null,
  };
  return {
    version: VOM_QUERY_VERSION,
    query: normalized,
    items,
    page,
    summary: summaryOf(matched, page),
  };
}

/** 查询结果的一行摘要（observe 输出/诊断用）。 */
export function summarizeRelationQuery(result) {
  if (!result || !result.page || !result.summary) return 'query: n/a';
  const summary = result.summary;
  const kinds = Object.entries(summary.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([type, count]) => type + '=' + count)
    .join(' ');
  const parts = [
    'relations ' + (result.page.offset + 1) + '-' + (result.page.offset + result.page.returned) + '/' + summary.total,
    'limit=' + result.page.limit,
    'avg-confidence=' + summary.averageConfidence,
  ];
  if (kinds) parts.push('types[' + kinds + ']');
  if (summary.self) parts.push('self=' + summary.self);
  if (summary.crossFrame) parts.push('cross-frame=' + summary.crossFrame);
  if (result.page.hasMore) parts.push('next=' + result.page.nextOffset);
  return parts.join(' ');
}
