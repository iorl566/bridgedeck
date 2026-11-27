// mcp/cursor.mjs —— MCP 列表方法的游标分页原语（resources/list、prompts/list、
// resources/templates/list 共用同一套编码/校验/过滤语义）。
//
// 目标（第十批-B ①：resources/prompts 分页）：MCP 列表方法（resources/list、prompts/list、
// resources/templates/list）都声明支持 `cursor` 参数，服务端返回 `nextCursor`。此前
// BridgeDeck 的列表是小集合，一次全量返回；现在资源行集合会随会话快照增长（LRU 32/16/16），
// 且客户端可能接多个 server 实例，需要：
//   1. 明确的单页上限（默认 50、最大 200）：不把几百行一次塞进上下文；
//   2. 不透明游标（`bb1.<label>.<offset-base36>`）：客户端不能拿它做偏移注入；
//      标签不符（把 resources/list 的游标喂给 prompts/list）→ E_BAD_ARG，而不是错位一页；
//   3. 显式 `hasMore` / `nextCursor` / `total`：调用方不需要猜“还有没有下一页”；
//   4. 越界/畸形/超长游标一律 E_BAD_ARG（server 映射 -32602），不静默从头开始；
//   5. 过滤（query/kind/tag/mimeType）先做后分页，过滤后的 total 反映真实集合大小。
//
// 纯函数、无 IO、无状态：同一输入永远得到同一游标与同一页。调用点：mcp/server.mjs 的
// resources/list、prompts/list、resources/templates/list；单测 tests/unit/mcp-cursor.test.mjs。

/** 游标格式前缀（改格式即 bump 版本，旧游标会按 E_BAD_ARG 拒绝而不是错位）。 */
export const CURSOR_VERSION = 'bb1';

/** 列表分页上限（单页条数，不是字符数）。 */
export const CURSOR_LIMITS = Object.freeze({
  defaultLimit: 50,
  maxLimit: 200,
  maxCursorLength: 512,
});

/** 带 code 的游标错误（server 统一映射 -32602）。 */
export class CursorError extends Error {
  constructor(code, message) {
    super(String(message));
    this.name = 'CursorError';
    this.code = code;
  }
}

const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** 校验分页标签（resources / prompts / templates 等）。 */
export function assertCursorLabel(label) {
  const value = String(label || '');
  if (!LABEL_PATTERN.test(value)) throw new CursorError('E_BAD_ARG', '分页标签非法：' + JSON.stringify(label));
  return value;
}

/**
 * 归一化单页条数。
 * - 缺省/null → defaultLimit；
 * - 非整数/小于 1/大于 maxLimit → CursorError(E_BAD_ARG)（显式报错，不夹紧）。
 */
export function normalizeLimit(value, { defaultLimit = CURSOR_LIMITS.defaultLimit, maxLimit = CURSOR_LIMITS.maxLimit } = {}) {
  if (value === undefined || value === null || value === '') return defaultLimit;
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new CursorError('E_BAD_ARG', '分页 limit 必须是 ≥1 的整数，实际 ' + JSON.stringify(value));
  }
  if (numeric > maxLimit) {
    throw new CursorError('E_BAD_ARG', '分页 limit 最大 ' + maxLimit + '，实际 ' + numeric);
  }
  return numeric;
}

/** 编码游标：不透明字符串，内含标签（防跨方法误用）与偏移。 */
export function encodeCursor(offset, { label = 'list' } = {}) {
  const tag = assertCursorLabel(label);
  const position = Number(offset);
  if (!Number.isInteger(position) || position < 0) throw new CursorError('E_BAD_ARG', '游标偏移必须是非负整数');
  return CURSOR_VERSION + '.' + tag + '.' + position.toString(36);
}

/**
 * 解码游标。
 * @returns {{ offset:number, label:string }}
 * @throws CursorError(E_BAD_ARG) 格式非法/版本不符/标签不符/偏移非数字
 */
export function decodeCursor(cursor, { label = 'list' } = {}) {
  const tag = assertCursorLabel(label);
  if (typeof cursor !== 'string' || !cursor) throw new CursorError('E_BAD_ARG', 'cursor 必须是非空字符串');
  if (cursor.length > CURSOR_LIMITS.maxCursorLength) throw new CursorError('E_BAD_ARG', 'cursor 超长（>' + CURSOR_LIMITS.maxCursorLength + '）');
  const parts = cursor.split('.');
  if (parts.length !== 3) throw new CursorError('E_BAD_ARG', 'cursor 格式非法（应为 ' + CURSOR_VERSION + '.' + tag + '.<offset>）');
  const [version, cursorLabel, rawOffset] = parts;
  if (version !== CURSOR_VERSION) throw new CursorError('E_BAD_ARG', 'cursor 版本不匹配（服务端 ' + CURSOR_VERSION + '）');
  if (cursorLabel !== tag) throw new CursorError('E_BAD_ARG', 'cursor 属于 ' + cursorLabel + ' 列表，不能用于 ' + tag);
  if (!/^[0-9a-z]+$/.test(rawOffset)) throw new CursorError('E_BAD_ARG', 'cursor 偏移非法：' + JSON.stringify(rawOffset));
  const offset = parseInt(rawOffset, 36);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CursorError('E_BAD_ARG', 'cursor 偏移非法：' + JSON.stringify(rawOffset));
  return { offset, label: cursorLabel };
}

/**
 * 对一批行做游标分页。
 * 分页语义：
 *   - 无 cursor：从 0 开始；
 *   - offset 超过 total：返回空页且 hasMore=false（不报错——客户端可能在上次取页后
 *     集合缩小，这是正常竞态；报错会让客户端无从恢复）；
 *   - nextCursor 只有在 hasMore 时才给出。
 * @returns {{ page:Array<any>, total:number, returned:number, offset:number, limit:number,
 *            hasMore:boolean, nextCursor:(string|null), cursor:(string|null), label:string }}
 */
export function paginateList(items, { cursor = null, limit = null, label = 'list', defaultLimit = CURSOR_LIMITS.defaultLimit, maxLimit = CURSOR_LIMITS.maxLimit } = {}) {
  const tag = assertCursorLabel(label);
  if (!Array.isArray(items)) throw new CursorError('E_BAD_ARG', 'paginateList 需要数组');
  const size = normalizeLimit(limit, { defaultLimit, maxLimit });
  const offset = cursor == null || cursor === '' ? 0 : decodeCursor(cursor, { label: tag }).offset;
  const total = items.length;
  const page = offset >= total ? [] : items.slice(offset, offset + size);
  const nextOffset = offset + page.length;
  const hasMore = page.length > 0 && nextOffset < total;
  return Object.freeze({
    page: Object.freeze([...page]),
    total,
    returned: page.length,
    offset,
    limit: size,
    hasMore,
    nextCursor: hasMore ? encodeCursor(nextOffset, { label: tag }) : null,
    cursor: cursor == null || cursor === '' ? null : String(cursor),
    label: tag,
  });
}

/** 取行里的可读数值字段（用于排序/统计，缺失返回 null）。 */
function rowFieldValue(row, field) {
  if (!row || typeof row !== 'object') return null;
  const path = String(field || '').split('.').filter(Boolean);
  let current = row;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return null;
    current = current[key];
  }
  return current === undefined ? null : current;
}

/** 大小写不敏感的子串匹配；query 为空视为匹配。 */
export function matchQuery(row, query, fields = ['uri', 'name', 'title', 'description']) {
  const needle = String(query == null ? '' : query).trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => {
    const value = rowFieldValue(row, field);
    if (value == null) return false;
    return String(value).toLowerCase().includes(needle);
  });
}

/**
 * 过滤行集合。
 * options.query   —— 子串（默认查 uri/name/title/description）；
 * options.fields  —— 自定义查询字段；
 * options.kind    —— 精确匹配（resources 的 kind / 模板类型等）；
 * options.mimeType—— 精确匹配 mimeType（忽略大小写）。
 */
export function filterRows(rows, { query = null, fields = null, kind = null, mimeType = null } = {}) {
  if (!Array.isArray(rows)) throw new CursorError('E_BAD_ARG', 'filterRows 需要数组');
  const searchFields = Array.isArray(fields) && fields.length ? fields : ['uri', 'name', 'title', 'description'];
  const kindFilter = kind == null || kind === '' ? null : String(kind);
  const mimeFilter = mimeType == null || mimeType === '' ? null : String(mimeType).toLowerCase();
  return rows.filter((row) => {
    if (kindFilter) {
      const rowKind = rowFieldValue(row, 'kind') || rowFieldValue(row, 'type');
      if (String(rowKind === null ? '' : rowKind) !== kindFilter) return false;
    }
    if (mimeFilter) {
      const rowMime = String(rowFieldValue(row, 'mimeType') || '').toLowerCase();
      if (rowMime !== mimeFilter) return false;
    }
    return matchQuery(row, query, searchFields);
  });
}

/** 按 keyFn 计数（保持首次出现顺序；用于 kind/mime 分布统计）。 */
export function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = String(keyFn(item));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.freeze(Object.fromEntries(counts));
}

/**
 * 把列表结果包成 MCP 列表应答。
 * base 里放方法自己的行数组字段（resources / prompts / resourceTemplates），
 * 分页元信息放 _meta，`nextCursor` 按 MCP 规范放在结果顶层（有下一页时才有）。
 */
export function listResponse(base, paged, { metaKey = null, meta = {} } = {}) {
  const payload = { ...base };
  if (paged.nextCursor) payload.nextCursor = paged.nextCursor;
  const paging = Object.freeze({
    total: paged.total,
    returned: paged.returned,
    offset: paged.offset,
    limit: paged.limit,
    hasMore: paged.hasMore,
    nextCursor: paged.nextCursor,
    cursorParam: 'cursor',
    limitParam: 'limit',
    defaultLimit: CURSOR_LIMITS.defaultLimit,
    maxLimit: CURSOR_LIMITS.maxLimit,
  });
  payload._meta = {
    ...(meta && typeof meta === 'object' ? meta : {}),
    ...(metaKey ? { [metaKey]: { ...(meta[metaKey] || {}), pagination: paging } } : { 'browser-bridge/pagination': paging }),
  };
  return payload;
}

/** 分页能力快照（initialize experimental['browser-bridge/list-pagination'] 与测试共用）。 */
export function cursorSnapshot() {
  return Object.freeze({
    supported: true,
    version: CURSOR_VERSION,
    cursorParam: 'cursor',
    limitParam: 'limit',
    defaultLimit: CURSOR_LIMITS.defaultLimit,
    maxLimit: CURSOR_LIMITS.maxLimit,
    maxCursorLength: CURSOR_LIMITS.maxCursorLength,
    methods: Object.freeze(['resources/list', 'resources/templates/list', 'prompts/list']),
    opaque: true,
    labelScoped: true,
  });
}
