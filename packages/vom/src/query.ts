// packages/vom/src/query.ts —— 关系图查询：按 kind / role / name 过滤 + 分页 + 摘要（纯函数）。
//
// 源：extension/src/lib/vom-query.js（行为逐字段等价的基线，差分测试对拍）。
//
// 关系图（src/relations.ts）可能包含上千条边，Agent 真正需要的是“第 2 页、只看 labels、
// 角色是 button、名字含 提交 的 10 条，以及一句摘要”。本模块提供稳定、可单测的查询契约：
//   - 过滤：kind/type、source、confidence 区间、from/to、direction、self、crossFrame、role、name；
//   - 分页：offset/limit（默认 25，最大 200），返回 page.nextOffset/hasMore；
//   - 摘要：byType/bySource/byRole、置信度分桶、帧跨度、平均置信度。
// 角色/名字优先从关系记录上的 fromRole/toRole/fromName/toName 解析；没有时用传入的节点池补。
//
// 语义细节（与 JS 基线逐条一致，避免“看起来一样”的偏差）：
// - 过滤值一律小写比较，未知键忽略、不抛错；
// - direction='in' 不额外过滤（基线行为，保留兼容）；
// - 摘要统计的是全部命中项，page.returned 只反映当前页。

import type {
  NormalizedRelationQuery,
  QueryRelationItem,
  RelationQueryBuckets,
  RelationQueryDefaults,
  RelationQueryDirection,
  RelationQueryPage,
  RelationQuerySort,
  RelationQuerySummary,
  RelationQuerySummarySource,
  VomQueryNodeFacts,
  VomRelationQueryFact,
  VomRelationQueryGraph,
  VomRelationQueryResult,
} from './query-types.ts';

/** 关系查询契约版本。 */
export const VOM_QUERY_VERSION = 1;

/** 分页默认值与上限。 */
export const QUERY_DEFAULTS: RelationQueryDefaults = Object.freeze({
  limit: 25,
  maxLimit: 200,
  maxOffset: 10000,
});

/** 单值/数组归一成去空白小写字符串列表（跳过空项）。 */
function listOf(value: unknown): string[] {
  if (value == null) return [];
  const array: readonly unknown[] = Array.isArray(value) ? value : [value];
  return array
    .map((item) => String(item == null ? '' : item).trim().toLowerCase())
    .filter(Boolean);
}

/** 有限数字或 null（NaN/Infinity/非数字 → null）。 */
function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 整数夹取：非有限回落到 min，向下取整后夹到 [min,max]。 */
function clamp(value: unknown, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/** 关系图归一：数组直接用，{relations} 取字段，其余视为空。 */
function relationArrayOf(graph: VomRelationQueryGraph | null | undefined): readonly VomRelationQueryFact[] {
  if (Array.isArray(graph)) return graph as readonly VomRelationQueryFact[];
  if (graph && typeof graph === 'object') {
    const relations = (graph as { readonly relations?: unknown }).relations;
    if (Array.isArray(relations)) return relations as readonly VomRelationQueryFact[];
  }
  return [];
}

/** 节点 id → frame 标识：`frame:3` / `f3:@e7` / 普通 id（null）。 */
function frameOfNodeId(id: unknown): number | null {
  const text = String(id == null ? '' : id);
  const frameNode = /^frame:(\d+)$/.exec(text);
  if (frameNode) return Number(frameNode[1]);
  const prefixed = /^f(\d+):/.exec(text);
  if (prefixed) return Number(prefixed[1]);
  return null;
}

/** 归一化查询参数（大小写不敏感；未知键忽略，不抛错）。 */
export function normalizeRelationQuery(query: unknown = {}): NormalizedRelationQuery {
  const source: Readonly<Record<string, unknown>> =
    query && typeof query === 'object' ? (query as Readonly<Record<string, unknown>>) : {};
  const limit = clamp(source.limit == null ? QUERY_DEFAULTS.limit : source.limit, 1, QUERY_DEFAULTS.maxLimit);
  const offset = clamp(source.offset == null ? 0 : source.offset, 0, QUERY_DEFAULTS.maxOffset);
  const sortText = String(source.sort);
  const sort: RelationQuerySort = (['insertion', 'confidence', 'type', 'name', 'source'] as const).includes(
    sortText as RelationQuerySort,
  )
    ? (sortText as RelationQuerySort)
    : 'insertion';
  const minConfidence = numberOrNull(source.minConfidence);
  const maxConfidence = numberOrNull(source.maxConfidence);
  const directionText = String(source.direction);
  const direction: RelationQueryDirection = (['both', 'out', 'in'] as const).includes(
    directionText as RelationQueryDirection,
  )
    ? (directionText as RelationQueryDirection)
    : 'both';
  return {
    types: source.kind != null ? listOf(source.kind) : listOf(source.types != null ? source.types : source.type),
    sources: listOf(source.sources != null ? source.sources : source.source),
    roles: listOf(source.role != null ? source.role : source.roles),
    names: listOf(source.name != null ? source.name : source.names),
    minConfidence: minConfidence == null ? null : Math.min(1, Math.max(0, minConfidence)),
    maxConfidence: maxConfidence == null ? null : Math.min(1, Math.max(0, maxConfidence)),
    from: source.from == null ? null : String(source.from),
    to: source.to == null ? null : String(source.to),
    direction,
    self: source.self === true ? true : (source.self === false ? false : null),
    crossFrame: source.crossFrame === true,
    sort,
    offset,
    limit,
  };
}

/** 节点池索引：id → {role, name}。 */
function nodeIndex(nodes: unknown): Map<string, { role: string; name: string }> {
  const map = new Map<string, { role: string; name: string }>();
  for (const node of Array.isArray(nodes) ? (nodes as readonly VomQueryNodeFacts[]) : []) {
    if (!node || node.id == null) continue;
    map.set(String(node.id), {
      role: String(node.role == null ? '' : node.role).toLowerCase(),
      name: String(node.name == null ? '' : node.name),
    });
  }
  return map;
}

/** 角色解析：关系记录上的 fromRole/toRole 优先，其次节点池。 */
function roleOf(index: Map<string, { role: string; name: string }>, id: unknown, fallback: unknown): string {
  const direct = String(fallback == null ? '' : fallback).toLowerCase();
  if (direct) return direct;
  const node = index.get(String(id));
  return node ? node.role : '';
}

/** 名字解析：关系记录上的 fromName/toName 优先，其次节点池。 */
function nameOf(index: Map<string, { role: string; name: string }>, id: unknown, fallback: unknown): string {
  const direct = String(fallback == null ? '' : fallback);
  if (direct) return direct;
  const node = index.get(String(id));
  return node ? node.name : '';
}

/** 关系项的公开视图（只暴露查询/展示需要的字段）。 */
function queryItem(
  relation: VomRelationQueryFact,
  index: Map<string, { role: string; name: string }>,
): QueryRelationItem {
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
    sources: Array.isArray(relation.sources) ? relation.sources.slice() as string[] : (relation.source ? [relation.source as string] : []),
    fromRole: fromRole || null,
    toRole: toRole || null,
    fromName: fromName || null,
    toName: toName || null,
    ...(relation.self === true ? { self: true as const } : {}),
    ...(relation.text ? { text: String(relation.text) } : {}),
    ...(relation.frame === true ? { frame: true as const } : {}),
    ...(Number.isFinite(Number(relation.depth)) ? { depth: Number(relation.depth) } : {}),
    ...(relation.chain ? { chain: (relation.chain as readonly unknown[]).slice() as string[] } : {}),
  };
}

/** 关系项是否命中归一化查询。 */
function matchesQuery(item: QueryRelationItem, query: NormalizedRelationQuery): boolean {
  if (query.types.length && !query.types.includes(item.type.toLowerCase())) return false;
  if (query.sources.length) {
    const sources = item.sources.map((source) => String(source).toLowerCase());
    if (!query.sources.some((source) => sources.includes(source))) return false;
  }
  if (query.roles.length) {
    const roles = [item.fromRole, item.toRole].filter(Boolean) as string[];
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

/** 排序：insertion 保持原顺序，其余按稳定键（同键再按置信度/类型）。 */
function sortItems(items: QueryRelationItem[], sort: RelationQuerySort): QueryRelationItem[] {
  if (sort === 'insertion') return items;
  const list = items.slice();
  if (sort === 'confidence') {
    list.sort((a, b) => b.confidence - a.confidence || a.type.localeCompare(b.type));
  } else if (sort === 'type') {
    list.sort((a, b) => a.type.localeCompare(b.type) || b.confidence - a.confidence);
  } else if (sort === 'name') {
    list.sort((a, b) => String(a.toName || a.fromName || '').localeCompare(String(b.toName || b.fromName || '')));
  } else if (sort === 'source') {
    list.sort((a, b) => String(a.source || '').localeCompare(String(b.source || '')) || b.confidence - a.confidence);
  }
  return list;
}

/** 查询摘要：针对全部命中项（不只是当前页）。 */
function summaryOf(items: readonly QueryRelationItem[], page: RelationQueryPage): RelationQuerySummary {
  const byType: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  const buckets: RelationQueryBuckets = { high: 0, medium: 0, low: 0 };
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
 * 查询关系图：过滤 → 排序 → 分页 → 摘要。
 * @param relationGraph 关系图（{relations} 或关系数组）
 * @param query 过滤/分页参数
 * @param nodes 端点节点池（角色/名字来源）
 */
export function queryVomRelations(
  relationGraph: VomRelationQueryGraph | null | undefined,
  query: unknown = {},
  nodes: unknown = [],
): VomRelationQueryResult {
  const relations = relationArrayOf(relationGraph);
  const pool = Array.isArray(nodes) && nodes.length
    ? nodes
    : (relationGraph && !Array.isArray(relationGraph) && Array.isArray((relationGraph as { readonly nodes?: unknown }).nodes)
      ? (relationGraph as { readonly nodes: readonly VomQueryNodeFacts[] }).nodes
      : []);
  const index = nodeIndex(pool);
  const normalized = normalizeRelationQuery(query);
  const mapped = relations.map((relation) => queryItem(relation, index));
  const matched = mapped.filter((item) => matchesQuery(item, normalized));
  const sorted = sortItems(matched, normalized.sort);
  const total = sorted.length;
  const offset = Math.min(normalized.offset, total);
  const items = sorted.slice(offset, offset + normalized.limit);
  const page: RelationQueryPage = {
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
export function summarizeRelationQuery(result: RelationQuerySummarySource | null | undefined): string {
  if (!result || !result.page || !result.summary) return 'query: n/a';
  const page = result.page;
  const summary = result.summary;
  const byType = summary.byType || {};
  const kinds = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([type, count]) => type + '=' + count)
    .join(' ');
  const offset = Number(page.offset) || 0;
  const returned = Number(page.returned) || 0;
  const parts = [
    'relations ' + (offset + 1) + '-' + (offset + returned) + '/' + String(summary.total),
    'limit=' + String(page.limit),
    'avg-confidence=' + String(summary.averageConfidence),
  ];
  if (kinds) parts.push('types[' + kinds + ']');
  if (summary.self) parts.push('self=' + String(summary.self));
  if (summary.crossFrame) parts.push('cross-frame=' + String(summary.crossFrame));
  if (page.hasMore) parts.push('next=' + String(page.nextOffset));
  return parts.join(' ');
}
