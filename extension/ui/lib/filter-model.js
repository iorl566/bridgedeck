// ui/lib/filter-model.js —— 页面过滤模型（纯函数，无 DOM/chrome，可在 Node 单测）。
//
// 页面过滤经历过三版：
// 1. `row.textContent.includes(needle)` —— 能搜文本，但没法只筛 4xx、只看慢请求；
// 2. 一个字段一个下拉框 —— 字段一多，工具栏就挤成两行；
// 3. 本模块的「查询串 + 芯片」：输入 `status:>=400 method:GET url:"/api/" 文本`，
//    解析成 token，芯片可单独删除，已保存的过滤（错误/慢/API）一键套用。
//
// 语法（对用户可见，所以保持小、可解释）：
//   field:value        相等（字符串大小写不敏感；枚举同样）
//   field:>=number     数值比较（> >= < <=）
//   field:=value       严格相等（区分大小写）
//   field:~text        包含（子串）
//   field:^text        前缀；field:$text 后缀
//   field:!value       不等于
//   -field:value / !field:value  整条取反
//   "带 空格 的值"     引号内允许空格（引号可出现在 field: 后）
//   裸词                对所有文本列做包含匹配（多词 AND）
//
// 出错不抛异常：返回 errors（未知字段 / 非法数值），页面照常渲染“未命中”状态。

import { formatLabel } from './labels.js';

/** 支持的比较操作（顺序即 UI 下拉顺序）。 */
export const FILTER_OPERATORS = Object.freeze([
  'contains', 'equals', 'not-equals', 'starts', 'ends', 'gt', 'gte', 'lt', 'lte', 'exists',
]);

/** 操作符前缀 → 语义。解析时按“最长前缀优先”，`>=` 必须先于 `>`。 */
const OPERATOR_PREFIXES = Object.freeze([
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['!=', 'not-equals'],
  ['=', 'equals'],
  ['~', 'contains'],
  ['^', 'starts'],
  ['$', 'ends'],
  ['>', 'gt'],
  ['<', 'lt'],
  ['!', 'not-equals'],
]);

/** 各表面的字段目录。label 是 labels.js 的 key；value 允许自定义取值函数。 */
export const FILTER_FIELDS = Object.freeze({
  debug: [
    { key: 'method', label: 'filter.field.method', type: 'string' },
    { key: 'status', label: 'filter.field.status', type: 'number' },
    { key: 'url', label: 'filter.field.url', type: 'string' },
    { key: 'durationMs', label: 'filter.field.duration', type: 'number' },
    { key: 'level', label: 'filter.field.level', type: 'string' },
    { key: 'text', label: 'filter.field.text', type: 'string' },
  ],
  audit: [
    { key: 'method', label: 'filter.field.method', type: 'string' },
    { key: 'result', label: 'filter.field.result', type: 'string' },
    { key: 'session', label: 'filter.field.session', type: 'string' },
    { key: 'tabId', label: 'filter.field.tab', type: 'string' },
    { key: 'durationMs', label: 'filter.field.duration', type: 'number' },
    { key: 'url', label: 'filter.field.url', type: 'string' },
  ],
  ops: [
    { key: 'type', label: 'filter.field.type', type: 'string' },
    { key: 'selector', label: 'filter.field.selector', type: 'string' },
    { key: 'url', label: 'filter.field.url', type: 'string' },
    { key: 'step', label: 'filter.field.step', type: 'number' },
  ],
  record: [
    { key: 'mime', label: 'filter.field.mime', type: 'string' },
    { key: 'bytes', label: 'filter.field.bytes', type: 'number' },
    { key: 'durationMs', label: 'filter.field.duration', type: 'number' },
  ],
  longshot: [
    { key: 'tiles', label: 'filter.field.tiles', type: 'number' },
    { key: 'width', label: 'filter.field.width', type: 'number' },
    { key: 'height', label: 'filter.field.height', type: 'number' },
    { key: 'url', label: 'filter.field.url', type: 'string' },
  ],
  workspace: [
    { key: 'method', label: 'filter.field.method', type: 'string' },
    { key: 'status', label: 'filter.field.status', type: 'number' },
    { key: 'url', label: 'filter.field.url', type: 'string' },
    { key: 'durationMs', label: 'filter.field.duration', type: 'number' },
    { key: 'level', label: 'filter.field.level', type: 'string' },
    { key: 'type', label: 'filter.field.type', type: 'string' },
    { key: 'text', label: 'filter.field.text', type: 'string' },
  ],
});

/** 取字段目录；未知表面回退 workspace（页面不会因为拼错表面名而无法过滤）。 */
export function fieldsForSurface(surface) {
  return FILTER_FIELDS[surface] || FILTER_FIELDS.workspace;
}

/**
 * 查询串切词：尊重双引号（支持 `url:"foo bar"` 与 `"裸 词组"`），保留引号出现的位置。
 * @returns {Array<{text:string, quoted:boolean}>}
 */
export function tokenizeQuery(query) {
  const source = String(query === undefined || query === null ? '' : query);
  const tokens = [];
  let current = '';
  let quoted = false;
  let hasQuoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '\\' && source[index + 1] === '"') { current += '"'; index += 1; continue; }
      if (char === '"') { quoted = false; continue; }
      current += char;
      continue;
    }
    if (char === '"') { quoted = true; hasQuoted = true; continue; }
    if (char === '\\' && source[index + 1] === '"') { current += '"'; index += 1; continue; }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push({ text: current, quoted: hasQuoted });
        current = '';
        hasQuoted = false;
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push({ text: current, quoted: hasQuoted });
  return tokens;
}

/**
 * 解析查询串。
 * @returns {{tokens:Array<{field:string|null, op:string, value:string, negated:boolean, raw:string}>,
 *   freeText:Array<string>, errors:Array<{code:string, field:string|null, raw:string}>}}
 */
export function parseFilterQuery(query) {
  const rawTokens = tokenizeQuery(query);
  const tokens = [];
  const freeText = [];
  const errors = [];
  for (const item of rawTokens) {
    let text = item.text;
    let negated = false;
    if (text.startsWith('-') && text.length > 1) { negated = true; text = text.slice(1); }
    else if (text.startsWith('!') && text.length > 1 && !text.includes(':') && !item.quoted) { negated = true; text = text.slice(1); }
    const colon = text.indexOf(':');
    if (colon <= 0) {
      // 没有字段：裸词对文本列做包含；带引号的词组允许空格。
      if (text) freeText.push(text);
      continue;
    }
    const field = text.slice(0, colon).trim();
    let rest = text.slice(colon + 1);
    if (!field || !rest) {
      errors.push({ code: 'E_FILTER_EMPTY_VALUE', field: field || null, raw: item.text });
      continue;
    }
    let innerNegated = false;
    if (rest.startsWith('!') && rest.length > 1) { innerNegated = true; rest = rest.slice(1); }
    let op = 'equals';
    for (const [prefix, name] of OPERATOR_PREFIXES) {
      if (rest.startsWith(prefix) && rest.length > prefix.length) {
        op = name;
        rest = rest.slice(prefix.length);
        break;
      }
    }
    if (innerNegated) {
      // `field:!x` 与 `field:!=x` 都表示不等于；两种写法归一到 not-equals。
      op = op === 'not-equals' ? 'not-equals' : 'not-equals';
    }
    // 去掉值两侧的引号（`url:"a b"` 解析后 rest 是 `"a b"`）。
    if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    if (!rest && op !== 'exists') {
      errors.push({ code: 'E_FILTER_EMPTY_VALUE', field, raw: item.text });
      continue;
    }
    tokens.push({ field, op, value: rest, negated, raw: item.text });
  }
  return { tokens, freeText, errors };
}

function fieldDef(fields, key) {
  const list = Array.isArray(fields) ? fields : [];
  return list.find((field) => String(field.key).toLowerCase() === String(key).toLowerCase()) || null;
}

/** 取字段值：支持 value(row) 自定义取值。 */
export function fieldValue(field, row) {
  if (!field || !row || typeof row !== 'object') return undefined;
  if (typeof field.value === 'function') {
    try { return field.value(row); } catch { return undefined; }
  }
  return row[field.key];
}

function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** 单 token 匹配一行；类型不符时按“不匹配”处理（不抛错）。 */
export function matchToken(row, token, field) {
  const value = fieldValue(field, row);
  const op = token.op;
  if (op === 'exists') {
    const exists = value !== undefined && value !== null && String(value) !== '';
    return token.negated ? !exists : exists;
  }
  if (value === undefined || value === null) {
    // 空值只对 `!=`/not-equals 有意义：`status:!=200` 应该包含没有 status 的行吗？
    // 约定：不包含（缺失值永远不匹配任何比较，避免“未知=错误”的错觉）。
    return false;
  }
  let result;
  const numeric = field && field.type === 'number';
  switch (op) {
    case 'contains': result = String(value).toLowerCase().includes(String(token.value).toLowerCase()); break;
    case 'equals': {
      if (numeric) result = asNumber(value) === asNumber(token.value);
      else result = String(value).toLowerCase() === String(token.value).toLowerCase();
      break;
    }
    case 'not-equals': {
      if (numeric) result = asNumber(value) !== asNumber(token.value);
      else result = String(value).toLowerCase() !== String(token.value).toLowerCase();
      break;
    }
    case 'starts': result = String(value).toLowerCase().startsWith(String(token.value).toLowerCase()); break;
    case 'ends': result = String(value).toLowerCase().endsWith(String(token.value).toLowerCase()); break;
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const left = asNumber(value);
      const right = asNumber(token.value);
      if (left === null || right === null) result = false;
      else if (op === 'gt') result = left > right;
      else if (op === 'gte') result = left >= right;
      else if (op === 'lt') result = left < right;
      else result = left <= right;
      break;
    }
    default: result = false;
  }
  return token.negated ? !result : result;
}

/**
 * 编译过滤器。
 * @param {{query?:string, fields?:Array, textOf?:(row:any)=>string}} options
 * @returns {{predicate:(row:any)=>boolean, tokens:Array, freeText:Array,
 *   errors:Array, unknownFields:Array<string>, compiled:Array}}
 */
export function compileFilter(options = {}) {
  const fields = Array.isArray(options.fields) ? options.fields : fieldsForSurface(options.surface);
  const parsed = parseFilterQuery(options.query || '');
  const errors = parsed.errors.slice();
  const unknownFields = [];
  const compiled = [];
  for (const token of parsed.tokens) {
    const field = fieldDef(fields, token.field);
    if (!field) {
      unknownFields.push(token.field);
      errors.push({ code: 'E_FILTER_UNKNOWN_FIELD', field: token.field, raw: token.raw });
      // 未知字段：整条 token 不参与匹配（用户看得到 chips 与错误提示）。
      continue;
    }
    if (field.type === 'number' && ['gt', 'gte', 'lt', 'lte', 'equals', 'not-equals'].includes(token.op)) {
      if (asNumber(token.value) === null) {
        errors.push({ code: 'E_FILTER_BAD_NUMBER', field: token.field, raw: token.raw });
        continue;
      }
    }
    compiled.push({ token, field });
  }
  const textOf = typeof options.textOf === 'function'
    ? options.textOf
    : (row) => textOfRow(row, fields);
  const freeText = parsed.freeText.map((text) => text.toLowerCase());
  const predicate = (row) => {
    for (const item of compiled) {
      if (!matchToken(row, item.token, item.field)) return false;
    }
    if (freeText.length) {
      const text = String(textOf(row) || '').toLowerCase();
      for (const needle of freeText) if (!text.includes(needle)) return false;
    }
    return true;
  };
  return { predicate, tokens: parsed.tokens, freeText: parsed.freeText, errors, unknownFields, compiled };
}

/** 行文本：所有字段值拼起来（裸词搜索用）。 */
export function textOfRow(row, fields = fieldsForSurface('workspace')) {
  if (!row || typeof row !== 'object') return String(row === undefined || row === null ? '' : row);
  const parts = [];
  for (const field of fields) {
    const value = fieldValue(field, row);
    if (value === undefined || value === null) continue;
    parts.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  if (!parts.length) {
    for (const value of Object.values(row)) {
      if (value === undefined || value === null) continue;
      parts.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  return parts.join(' ');
}

/**
 * 应用过滤：返回新数组，不修改入参。
 * @returns {{rows:Array, matched:number, rejected:number, total:number, errors:Array,
 *   unknownFields:Array, tokens:Array, empty:boolean, matching:boolean}}
 */
export function filterRows(rows, query, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const compiled = compileFilter({ ...options, query });
  if (!String(query || '').trim()) {
    return { rows: list.slice(), matched: list.length, rejected: 0, total: list.length, errors: compiled.errors, unknownFields: compiled.unknownFields, tokens: compiled.tokens, empty: list.length === 0, matching: list.length > 0 };
  }
  const kept = [];
  for (const row of list) {
    try {
      if (compiled.predicate(row)) kept.push(row);
    } catch {
      // 一行数据异常不应该让整个过滤崩掉。
    }
  }
  return {
    rows: kept,
    matched: kept.length,
    rejected: list.length - kept.length,
    total: list.length,
    errors: compiled.errors,
    unknownFields: compiled.unknownFields,
    tokens: compiled.tokens,
    empty: list.length === 0,
    matching: kept.length > 0,
  };
}

/** 行 → chips。`query`/`raw` 字段用于“删除这个芯片后查询串变成什么”。 */
export function activeChips(query, options = {}) {
  const fields = Array.isArray(options.fields) ? options.fields : fieldsForSurface(options.surface);
  const lang = options.lang || 'zh';
  const compiled = compileFilter({ ...options, query });
  const chips = [];
  const used = new Set();
  for (const token of compiled.tokens) {
    const field = fieldDef(fields, token.field);
    const label = field ? formatLabel(field.label, {}, lang) : String(token.field);
    const rendered = label + ' ' + operatorLabel(token.op, lang) + ' ' + token.value;
    const key = token.field + ':' + token.op + ':' + token.value + ':' + (token.negated ? '1' : '0');
    if (used.has(key)) continue;
    used.add(key);
    chips.push({
      key,
      field: token.field,
      op: token.op,
      value: token.value,
      negated: token.negated,
      label: token.negated ? '− ' + rendered : rendered,
      // 删除芯片：从查询串里移掉对应原文（保留其余 token 的顺序与引号）。
      removeQuery: removeRawToken(query, token.raw),
    });
  }
  for (const text of compiled.freeText) {
    chips.push({
      key: 'text:' + text,
      field: null,
      op: 'contains',
      value: text,
      negated: false,
      label: text,
      removeQuery: removeRawToken(query, text),
    });
  }
  return chips;
}

/** 操作符的本地化短名（芯片/提示用）。 */
export function operatorLabel(op, lang = 'zh') {
  const map = {
    'contains': 'filter.op.contains',
    'equals': 'filter.op.equals',
    'not-equals': 'filter.op.notEquals',
    'starts': 'filter.op.starts',
    'ends': 'filter.op.ends',
    'gt': 'filter.op.gt',
    'gte': 'filter.op.gte',
    'lt': 'filter.op.lt',
    'lte': 'filter.op.lte',
    'exists': 'filter.op.exists',
  };
  return formatLabel(map[op] || map.equals, {}, lang);
}

/** 从查询串里移除一个原始 token（按整词匹配，避免误删子串）。 */
export function removeRawToken(query, raw) {
  const source = String(query === undefined || query === null ? '' : query);
  if (!raw) return source;
  const target = String(raw);
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('(^|\\s)' + escaped + '(?=\\s|$)');
  const next = source.replace(pattern, '$1').replace(/\s{2,}/g, ' ').trim();
  return next;
}

/** 追加一个 token；带空格的值自动加引号。 */
export function appendRawToken(query, raw) {
  const source = String(query === undefined || query === null ? '' : query).trim();
  let token = String(raw || '').trim();
  if (!token) return source;
  if (/\s/.test(token) && !/^".*"$/.test(token)) token = '"' + token + '"';
  return source ? source + ' ' + token : token;
}

/** 字段补全：输入 `st` → status / …（页面输入框用）。 */
export function suggestFields(prefix, options = {}) {
  const fields = Array.isArray(options.fields) ? options.fields : fieldsForSurface(options.surface);
  const needle = String(prefix || '').trim().toLowerCase();
  const available = fields.filter((field) => !needle || String(field.key).toLowerCase().includes(needle));
  return available.map((field) => ({
    field: field.key,
    type: field.type,
    label: formatLabel(field.label, {}, options.lang || 'zh'),
  }));
}

/** 值补全：某列出现过的值（去重、按出现次数降序）。 */
export function suggestValues(rows, fieldKey, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Math.max(1, Math.floor(Number(options.limit) || 12));
  const counts = new Map();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const value = row[fieldKey];
    if (value === undefined || value === null || value === '') continue;
    const text = String(value);
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

/** 分面计数：某列各值的行数（过滤面板显示 “GET (12)”）。 */
export function facetCounts(rows, fieldKey) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const value = row[fieldKey];
    const key = value === undefined || value === null || value === '' ? '' : String(value);
    if (key === '') continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

/** 保存的过滤（按表面），页面用下拉框一键套用。 */
export const SAVED_FILTERS = Object.freeze({
  debug: Object.freeze([
    { key: 'errors', query: 'status:>=400', label: 'filter.errorsOnly' },
    { key: 'slow', query: 'durationMs:>1000', label: 'filter.slow' },
    { key: 'api', query: 'url:/api/', label: 'filter.api' },
  ]),
  audit: Object.freeze([
    { key: 'errors', query: 'result:!ok', label: 'filter.errorsOnly' },
    { key: 'slow', query: 'durationMs:>1000', label: 'filter.slow' },
  ]),
  ops: Object.freeze([
    { key: 'click', query: 'type:click', label: 'filter.click' },
    { key: 'input', query: 'type:input', label: 'filter.input' },
  ]),
  record: Object.freeze([
    { key: 'mp4', query: 'mime:mp4', label: 'filter.mp4' },
  ]),
  longshot: Object.freeze([]),
  workspace: Object.freeze([
    { key: 'errors', query: 'status:>=400', label: 'filter.errorsOnly' },
    { key: 'slow', query: 'durationMs:>1000', label: 'filter.slow' },
    { key: 'api', query: 'url:/api/', label: 'filter.api' },
  ]),
});

/** 取某个表面的保存过滤（未知表面返回空数组）。 */
export function savedFiltersFor(surface, { fields, lang = 'zh' } = {}) {
  const list = SAVED_FILTERS[surface] || [];
  return list.map((item) => ({ ...item, text: formatLabel(item.label, {}, lang), query: item.query, available: !fields || Boolean(fieldDef(fields, item.query.split(':')[0].replace(/^[-!]/, ''))) }));
}

/** 过滤结果摘要（aria-live 播报用）。 */
export function filterSummary(result, lang = 'zh') {
  const source = result && typeof result === 'object' ? result : {};
  if (!String(source.query || '').trim() && !source.matched) {
    return formatLabel('filter.matched', { matched: 0, total: Number(source.total) || 0 }, lang);
  }
  if (source.matched === 0) return formatLabel('filter.none', { total: Number(source.total) || 0 }, lang);
  return formatLabel('filter.matched', { matched: Number(source.matched) || 0, total: Number(source.total) || 0 }, lang);
}

/** 是否有“过滤后为空”的情况（区别于“本来就没有数据”）。 */
export function isFilteredEmpty(result, totalRows) {
  const total = Number.isFinite(Number(totalRows)) ? Number(totalRows) : Number(result && result.total) || 0;
  return total > 0 && Number(result && result.matched) === 0;
}

/** 查询串规范化（压缩空白、去首尾），用于 URL 持久化前的稳定化。 */
export function normalizeFilterQuery(query) {
  return String(query === undefined || query === null ? '' : query).replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** URL 持久化：`filter` 参数编解码（与 view-state 的 query 字段并存，不冲突）。 */
export function encodeFilterQuery(query) {
  return encodeURIComponent(normalizeFilterQuery(query));
}

export function decodeFilterQuery(value) {
  const text = String(value === undefined || value === null ? '' : value);
  try {
    return normalizeFilterQuery(decodeURIComponent(text));
  } catch {
    return normalizeFilterQuery(text);
  }
}
