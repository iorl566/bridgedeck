// ui/lib/table.js —— 纯表格视图模型：列定义 + 排序 + 过滤 + 行模型（无 DOM）。
//
// 页面（audit/debug/ops）列表的共同结构是「多列 + 排序 + 过滤 + 搜索」；把它们抽成
// 数据模型，页面只负责把行模型渲染成 DOM。这样排序稳定性、空单元格、过滤匹配口径
// 都能在 Node 里单测。
//
// 契约：
// - 不修改入参（sort/filter 都返回新数组）。
// - 排序稳定：相等时按原始顺序（用 index 兜底），翻页不会“跳来跳去”。
// - filter 支持字符串（对所有列做 includes）或函数；query 大小写不敏感。

import { toFiniteNumber, truncateMiddle, formatValue } from './format.js';

function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return formatValue(value, 200);
}

/**
 * 列定义规范化。
 * @param {Array<{key:string, label?:string, sortable?:boolean, numeric?:boolean, width?:number,
 *   align?:'start'|'center'|'end', format?:(value:any,row:any)=>string, text?:(row:any)=>string}>} columns
 */
export function normalizeColumns(columns) {
  const list = Array.isArray(columns) ? columns : [];
  return list
    .filter((column) => column && (column.key !== undefined || column.id !== undefined))
    .map((column, index) => {
      const key = String(column.key !== undefined ? column.key : column.id);
      return {
        key,
        label: column.label === undefined ? key : String(column.label),
        sortable: column.sortable !== false,
        numeric: column.numeric === true,
        width: column.width === undefined ? null : Number(column.width),
        align: column.align === 'center' || column.align === 'end' ? column.align : 'start',
        format: typeof column.format === 'function' ? column.format : null,
        text: typeof column.text === 'function' ? column.text : null,
        index,
      };
    });
}

/** 默认列（记录列表里最常用的一组）。 */
export const DEFAULT_COLUMNS = Object.freeze([
  { key: 'ts', label: 'time', numeric: true },
  { key: 'method', label: 'method' },
  { key: 'status', label: 'status', numeric: true },
  { key: 'durationMs', label: 'duration', numeric: true },
  { key: 'url', label: 'url' },
]);

/** 单元格文本：优先列的 format，其次 text，其次原始值。 */
export function cellText(column, row) {
  if (!column) return '';
  try {
    if (column.format) return String(column.format(row && row[column.key], row));
    if (column.text) return String(column.text(row));
  } catch {
    return '?';
  }
  return asText(row && row[column.key]);
}

/** 一行的可访问名称：列文本用分隔符拼起来（读屏按行读）。 */
export function rowLabel(columns, row, { separator = ' · ' } = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const parts = cols.map((column) => cellText(column, row)).filter((text) => text !== '');
  return parts.join(separator);
}

/** 可排序值：数字列转数字，字符串列小写；缺失值统一为 null（排最后）。 */
export function sortValue(column, row) {
  const raw = row && row[column.key];
  if (column.numeric) {
    const number = toFiniteNumber(raw);
    return number === null ? null : number;
  }
  const text = asText(raw).toLowerCase();
  return text === '' ? null : text;
}

/**
 * 稳定排序：null 永远排最后（无论升序降序），其余按 direction 比较。
 * @param {Array<object>} rows
 * @param {{key:string, direction?:'asc'|'desc', numeric?:boolean, columns?:Array}} sort
 */
export function sortRows(rows, sort) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!sort || !sort.key) return list;
  const columns = Array.isArray(sort.columns) ? sort.columns : null;
  const column = columns ? columns.find((item) => item.key === sort.key) || { key: sort.key, numeric: sort.numeric === true } : { key: sort.key, numeric: sort.numeric === true };
  const direction = sort.direction === 'desc' ? -1 : 1;
  const decorated = list.map((row, index) => ({ row, index, value: sortValue(column, row) }));
  decorated.sort((a, b) => {
    if (a.value === null && b.value === null) return a.index - b.index;
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    if (a.value < b.value) return -1 * direction;
    if (a.value > b.value) return 1 * direction;
    return a.index - b.index;
  });
  return decorated.map((item) => item.row);
}

/** 过滤：query 为空返回原数组拷贝；字符串对 rowLabel 做 includes。 */
export function filterRows(rows, query, { columns, predicate } = {}) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const needle = asText(query).trim().toLowerCase();
  if (!needle) return list;
  if (typeof predicate === 'function') return list.filter((row) => Boolean(predicate(row, needle)));
  const cols = Array.isArray(columns) && columns.length ? columns : DEFAULT_COLUMNS;
  return list.filter((row) => rowLabel(cols, row, { separator: ' ' }).toLowerCase().includes(needle));
}

/**
 * 过滤 + 排序 + 分页一条龙，返回可直接渲染的视图模型。
 * @returns {{rows:Array, total:number, filtered:number, page:number, pages:number,
 *   sort:{key:string,direction:string}, columns:Array, empty:boolean, matching:boolean}}
 */
export function buildTableModel(rows, options = {}) {
  const columns = normalizeColumns(options.columns || DEFAULT_COLUMNS);
  const all = Array.isArray(rows) ? rows : [];
  const filtered = filterRows(all, options.query, { columns, predicate: options.predicate });
  const sorted = sortRows(filtered, options.sort ? { ...options.sort, columns } : null);
  const pageSize = Math.max(1, Math.floor(Number(options.pageSize) || 20));
  const totalPages = sorted.length === 0 ? 0 : Math.ceil(sorted.length / pageSize);
  const page = totalPages === 0 ? 1 : Math.min(totalPages, Math.max(1, Math.floor(Number(options.page) || 1)));
  const start = (page - 1) * pageSize;
  return {
    rows: sorted.slice(start, start + pageSize),
    all: sorted,
    total: all.length,
    filtered: sorted.length,
    page,
    pageSize,
    pages: totalPages,
    sort: { key: options.sort && options.sort.key ? String(options.sort.key) : '', direction: options.sort && options.sort.direction === 'desc' ? 'desc' : 'asc' },
    columns,
    empty: all.length === 0,
    matching: sorted.length > 0,
    query: asText(options.query),
  };
}

/** 点击表头：同列切换方向，新列默认升序（numeric 列默认降序更符合直觉）。 */
export function nextSort(current, key, { numeric = false } = {}) {
  const activeKey = current && current.key ? String(current.key) : '';
  const activeDirection = current && current.direction === 'desc' ? 'desc' : 'asc';
  if (activeKey === String(key)) return { key: String(key), direction: activeDirection === 'asc' ? 'desc' : 'asc' };
  return { key: String(key), direction: numeric ? 'desc' : 'asc' };
}

/** 排序 aria-sort 值（给 <th> 用）。 */
export function ariaSort(column, current) {
  if (!column || !column.sortable) return null;
  if (!current || current.key !== column.key) return 'none';
  return current.direction === 'desc' ? 'descending' : 'ascending';
}

/** 行模型：给每行补 key/index/选中态/aria 标签，渲染层不再拼字符串。 */
export function buildRowModels(rows, { columns, selected = new Set(), rowKey, startIndex = 0 } = {}) {
  const cols = Array.isArray(columns) && columns.length ? columns : DEFAULT_COLUMNS;
  const keyOf = typeof rowKey === 'function' ? rowKey : (row, index) => (row && (row.id ?? row.key)) ?? index;
  const picked = selected instanceof Set ? selected : new Set(selected || []);
  return (Array.isArray(rows) ? rows : []).map((row, offset) => {
    const index = startIndex + offset;
    const key = String(keyOf(row, index));
    return {
      key,
      index,
      row,
      selected: picked.has(key),
      label: rowLabel(cols, row),
      cells: cols.map((column) => ({
        key: column.key,
        text: truncateMiddle(cellText(column, row), 200),
        numeric: column.numeric,
        align: column.align,
      })),
    };
  });
}
