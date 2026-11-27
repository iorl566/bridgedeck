// mcp/resource-index.mjs —— resources 列表的索引层（种类判定 / 排序 / 过滤 / 分页 / 分布统计）。
//
// 目标（第十批-B ①：resources 深化）：resources/list 之前直接返回 RESOURCES.list() 的
// 原始数组。资源数量随快照 LRU 增长、客户端也会想知道“有哪些种类的资源、每类多少条、
// 能否只列某一类”，因此本模块提供：
//   1. 稳定的种类判定（skill-main / skill-reference / update-state / protocol-summary /
//      observation / evidence / journal / unknown），从 URI 派生，不信任行里的字段；
//   2. 有序输出：默认保持入参顺序（= 既有行为，逐字节不变），可选 sort=kind|uri|priority；
//   3. 过滤：query 子串（uri/name/title/description）+ kind / mimeType 精确匹配；
//   4. 分页：与 prompts/list 共用 mcp/cursor.mjs 的不透明游标（默认全量返回，
//      只有显式传 limit/cursor 才分页——保持旧客户端输出不变）；
//   5. 索引摘要：total / byKind / byMime / dynamic / static / duplicates，
//      放进 resources/list 的 _meta，客户端一次就知道集合形状。
//
// 纯函数、无 IO：不读盘、不访问 daemon。调用点：mcp/server.mjs 的 resources/list；
// 单测 tests/unit/mcp-resource-index.test.mjs。

import { countBy, filterRows, paginateList } from './cursor.mjs';

/** 资源种类（与 mcp/resources.mjs 的 RESOURCE_KINDS 对应，但这里是 URI 形状派生的独立集合）。 */
export const INDEX_KINDS = Object.freeze({
  SKILL_MAIN: 'skill-main',
  SKILL_REFERENCE: 'skill-reference',
  UPDATE_STATE: 'update-state',
  PROTOCOL_SUMMARY: 'protocol-summary',
  OBSERVATION: 'observation',
  EVIDENCE: 'evidence',
  JOURNAL: 'journal',
  UNKNOWN: 'unknown',
});

/** 动态资源（内容会随工具调用变化，可订阅）。 */
export const DYNAMIC_KINDS = Object.freeze([INDEX_KINDS.OBSERVATION, INDEX_KINDS.EVIDENCE, INDEX_KINDS.JOURNAL]);

/** 静态资源（内容只取决于本地文件/协议，不随会话变化）。 */
export const STATIC_KINDS = Object.freeze([INDEX_KINDS.SKILL_MAIN, INDEX_KINDS.SKILL_REFERENCE, INDEX_KINDS.UPDATE_STATE, INDEX_KINDS.PROTOCOL_SUMMARY]);

/** 排序方式白名单。 */
export const SORT_MODES = Object.freeze(['catalog', 'kind', 'uri', 'priority']);

/** 默认优先级权重（与 resources.mjs 里 annotations.priority 的意图一致）。 */
export const KIND_PRIORITY = Object.freeze({
  [INDEX_KINDS.OBSERVATION]: 0.9,
  [INDEX_KINDS.SKILL_MAIN]: 0.8,
  [INDEX_KINDS.SKILL_REFERENCE]: 0.7,
  [INDEX_KINDS.EVIDENCE]: 0.7,
  [INDEX_KINDS.JOURNAL]: 0.7,
  [INDEX_KINDS.PROTOCOL_SUMMARY]: 0.6,
  [INDEX_KINDS.UPDATE_STATE]: 0.4,
  [INDEX_KINDS.UNKNOWN]: 0.1,
});

/**
 * 从 URI 派生资源种类（只看 scheme + host + 路径形状，不信任行内字段）。
 * 未知形状返回 'unknown'（resources/list 里不应出现；出现即由审计暴露）。
 */
export function resourceKindOf(uri) {
  const text = String(uri || '');
  if (!text.startsWith('bridge://')) return INDEX_KINDS.UNKNOWN;
  const rest = text.slice('bridge://'.length).split('?')[0];
  const [host, ...segments] = rest.split('/');
  if (host === 'skill') {
    if (segments.length === 1 && segments[0] === 'SKILL.md') return INDEX_KINDS.SKILL_MAIN;
    if (segments.length === 2 && segments[0] === 'references' && /\.md$/i.test(segments[1])) return INDEX_KINDS.SKILL_REFERENCE;
    return INDEX_KINDS.UNKNOWN;
  }
  if (host === 'update') return segments[0] === 'state' ? INDEX_KINDS.UPDATE_STATE : INDEX_KINDS.UNKNOWN;
  if (host === 'protocol') return segments[0] === 'summary' ? INDEX_KINDS.PROTOCOL_SUMMARY : INDEX_KINDS.UNKNOWN;
  if (host === 'observation') return segments.length === 1 && segments[0] ? INDEX_KINDS.OBSERVATION : INDEX_KINDS.UNKNOWN;
  if (host === 'debug') {
    if (segments.length === 2 && segments[0] === 'evidence' && segments[1]) return INDEX_KINDS.EVIDENCE;
    if (segments.length === 2 && segments[0] === 'journal' && segments[1]) return INDEX_KINDS.JOURNAL;
    return INDEX_KINDS.UNKNOWN;
  }
  return INDEX_KINDS.UNKNOWN;
}

/** 资源 key（URI 路径最后一段；无路径返回 null）。 */
export function resourceKeyOf(uri) {
  const text = String(uri || '').split('?')[0];
  const segments = text.split('/').filter(Boolean);
  return segments.length > 1 ? segments[segments.length - 1] : null;
}

/** 资源是否动态（内容随工具调用变化）。 */
export function isDynamicResource(uri) {
  return DYNAMIC_KINDS.includes(resourceKindOf(uri));
}

/** 行优先级：行内 annotations.priority 优先，其次按 kind 权重。 */
export function resourcePriorityOf(row) {
  const annotationPriority = row && row.annotations && typeof row.annotations.priority === 'number'
    ? row.annotations.priority
    : null;
  if (annotationPriority != null) return annotationPriority;
  return KIND_PRIORITY[resourceKindOf(row && row.uri)] || 0;
}

/** 给行补充索引字段（kind / dynamic）。只新增字段，不改原有字段。 */
export function decorateResourceRow(row) {
  if (!row || typeof row !== 'object') return row;
  const kind = resourceKindOf(row.uri);
  return Object.freeze({
    ...row,
    kind,
    dynamic: DYNAMIC_KINDS.includes(kind),
  });
}

/**
 * 建立索引。
 * @returns {{ total:number, rows:ReadonlyArray<any>, byUri:ReadonlyMap<string,any>,
 *             duplicates:ReadonlyArray<string>, unknown:ReadonlyArray<string> }}
 */
export function buildResourceIndex(rows) {
  const list = Array.isArray(rows) ? rows.map(decorateResourceRow) : [];
  const byUri = new Map();
  const duplicates = [];
  for (const row of list) {
    const uri = String((row && row.uri) || '');
    if (byUri.has(uri)) duplicates.push(uri);
    else byUri.set(uri, row);
  }
  return Object.freeze({
    total: list.length,
    rows: Object.freeze(list),
    byUri,
    duplicates: Object.freeze(duplicates),
    unknown: Object.freeze(list.filter((row) => resourceKindOf(row.uri) === INDEX_KINDS.UNKNOWN).map((row) => row.uri)),
  });
}

/** 校验排序方式。 */
export function normalizeSort(sort) {
  if (sort === undefined || sort === null || sort === '') return 'catalog';
  const value = String(sort);
  if (!SORT_MODES.includes(value)) {
    const error = new Error('resources 排序方式必须是 ' + SORT_MODES.join('|') + '，实际 ' + JSON.stringify(sort));
    error.code = 'E_BAD_ARG';
    throw error;
  }
  return value;
}

/** 按方式排序；catalog 表示保持入参顺序（既有行为）。 */
export function sortResourceRows(rows, sort = 'catalog') {
  const mode = normalizeSort(sort);
  const list = Array.isArray(rows) ? [...rows] : [];
  if (mode === 'catalog') return list;
  if (mode === 'kind') {
    return list.sort((a, b) => {
      const kindOrder = resourceKindOf(a.uri).localeCompare(resourceKindOf(b.uri));
      return kindOrder || String(a.uri).localeCompare(String(b.uri));
    });
  }
  if (mode === 'uri') return list.sort((a, b) => String(a.uri).localeCompare(String(b.uri)));
  // priority：高优先在前，同优先级按 URI 稳定排序。
  return list.sort((a, b) => {
    const diff = resourcePriorityOf(b) - resourcePriorityOf(a);
    return diff || String(a.uri).localeCompare(String(b.uri));
  });
}

/**
 * 一致的索引摘要（resources/list 的 _meta 用）。
 * @returns {{ total:number, byKind:object, byMime:object, dynamic:number, static:number,
 *             unknown:Array<string>, duplicates:Array<string> }}
 */
export function summarizeResources(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const dynamic = list.filter((row) => isDynamicResource(row && row.uri)).length;
  return Object.freeze({
    total: list.length,
    byKind: countBy(list, (row) => resourceKindOf(row && row.uri)),
    byMime: countBy(list, (row) => (row && row.mimeType) || 'unknown'),
    dynamic,
    static: list.length - dynamic,
    unknown: Object.freeze(list.filter((row) => resourceKindOf(row && row.uri) === INDEX_KINDS.UNKNOWN).map((row) => row.uri)),
    duplicates: Object.freeze(findDuplicates(list)),
  });
}

function findDuplicates(rows) {
  const seen = new Set();
  const duplicates = [];
  for (const row of rows) {
    const uri = String((row && row.uri) || '');
    if (seen.has(uri)) duplicates.push(uri);
    seen.add(uri);
  }
  return duplicates;
}

/**
 * 一次完成“过滤 → 排序 → 分页”的 resources/list 处理。
 * 默认（无 limit/cursor/query/sort）返回全部行且顺序与入参一致 —— 旧客户端输出不变。
 *
 * @param {Array<object>} rows RESOURCES.list() 的行
 * @param {{cursor?:string|null, limit?:number|string|null, query?:string|null,
 *          kind?:string|null, mimeType?:string|null, sort?:string, label?:string,
 *          defaultLimit?:number, maxLimit?:number}} options
 * @returns {{ page:Array<object>, paged:object, summary:object, filtered:number, sort:string }}
 */
export function queryResources(rows, {
  cursor = null,
  limit = null,
  query = null,
  kind = null,
  mimeType = null,
  sort = 'catalog',
  label = 'resources',
  defaultLimit,
  maxLimit,
} = {}) {
  const mode = normalizeSort(sort);
  const hasFilter = Boolean(String(query || '').trim()) || Boolean(kind) || Boolean(mimeType);
  const hasPaging = limit != null || (cursor != null && cursor !== '');
  // 默认路径：既不过滤也不分页 → 原样返回（保持既有 resources/list 输出）。
  if (!hasFilter && !hasPaging && mode === 'catalog') {
    const list = Array.isArray(rows) ? rows : [];
    return Object.freeze({
      page: Object.freeze([...list]),
      paged: Object.freeze({
        total: list.length,
        returned: list.length,
        offset: 0,
        limit: list.length,
        hasMore: false,
        nextCursor: null,
        label,
        defaulted: true,
      }),
      summary: summarizeResources(list),
      filtered: list.length,
      sort: mode,
    });
  }
  // 过滤/分页路径：先补 kind/dynamic 索引字段，kind 过滤才能按 URI 派生值匹配（
  // 不依赖行里是否自带 kind）；默认路径不受影响。
  const decorated = (rows || []).map(decorateResourceRow);
  const filtered = hasFilter ? filterRows(decorated, { query, kind, mimeType }) : decorated;
  const ordered = sortResourceRows(filtered, mode);
  const paged = paginateList(ordered, { cursor, limit, label, defaultLimit, maxLimit });
  return Object.freeze({
    page: paged.page,
    paged,
    summary: summarizeResources(ordered),
    filtered: ordered.length,
    sort: mode,
  });
}

/** 索引能力快照（initialize experimental['browser-bridge/resource-index'] 与测试共用）。 */
export function resourceIndexSnapshot({ templates = 0 } = {}) {
  return Object.freeze({
    kinds: Object.freeze(Object.values(INDEX_KINDS)),
    dynamicKinds: DYNAMIC_KINDS,
    staticKinds: STATIC_KINDS,
    sortModes: SORT_MODES,
    kindPriority: KIND_PRIORITY,
    templates,
    defaultSort: 'catalog',
    uriScheme: 'bridge://',
  });
}
