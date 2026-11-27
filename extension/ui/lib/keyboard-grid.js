// ui/lib/keyboard-grid.js —— 网格/列表键盘导航（纯模型，无 DOM，可在 Node 单测）。
//
// lib/keyboard.js 把“按键 → 意图”收敛好了，但“意图 → 二维光标”还需要一层：
// 数据表要支持左右跨列、上下跨行、Home/End、PgUp/PgDn、类型前置（typeahead）、
// 多选（Shift 范围 / Ctrl 切换 / Ctrl+A 全选）。
//
// 本模块输出「光标 + 选中集合 + roving tabindex + aria-activedescendant」所需的纯状态，
// 页面只负责把状态映射到 DOM（tabIndex/focus/aria-selected），所以逻辑可 Node 单测。

import { moveIndex, intentToIndex, typeaheadMatch } from './keyboard.js';
import { formatLabel } from './labels.js';

/** 网格默认每页行数（PgUp/PgDn 用）。 */
export const DEFAULT_PAGE_ROWS = 10;

/**
 * 夹取光标到合法范围（空网格返回 {-1,-1}）。
 * @returns {{row:number, col:number}}
 */
export function clampCursor(cursor, rows, cols) {
  const rowCount = Math.max(0, Math.floor(Number(rows) || 0));
  const colCount = Math.max(0, Math.floor(Number(cols) || 0));
  if (!rowCount || !colCount) return { row: -1, col: -1 };
  const row = Math.min(rowCount - 1, Math.max(0, Math.floor(Number(cursor && cursor.row) || 0)));
  const col = Math.min(colCount - 1, Math.max(0, Math.floor(Number(cursor && cursor.col) || 0)));
  return { row, col };
}

/**
 * 意图 → 新光标。
 * @param {{row:number, col:number}} cursor
 * @param {string} intent 来自 lib/keyboard.js resolveEvent 的 intent
 * @param {{rows:number, cols:number, pageRows?:number, wrapRows?:boolean, wrapCols?:boolean}} dims
 */
export function applyGridIntent(cursor, intent, dims = {}) {
  const rows = Math.max(0, Math.floor(Number(dims.rows) || 0));
  const cols = Math.max(0, Math.floor(Number(dims.cols) || 0));
  const current = clampCursor(cursor, rows, cols);
  if (rows === 0 || cols === 0) return current;
  const pageRows = Math.max(1, Math.floor(Number(dims.pageRows) || DEFAULT_PAGE_ROWS));
  const wrapRows = dims.wrapRows === true;
  const wrapCols = dims.wrapCols === true;
  const move = (rowDelta, colDelta) => {
    let row = current.row + rowDelta;
    let col = current.col + colDelta;
    if (colDelta !== 0) {
      if (wrapCols) col = ((col % cols) + cols) % cols;
      else col = Math.min(cols - 1, Math.max(0, col));
    }
    if (rowDelta !== 0) {
      if (wrapRows) row = ((row % rows) + rows) % rows;
      else row = Math.min(rows - 1, Math.max(0, row));
    }
    return { row, col };
  };
  switch (intent) {
    case 'up': return move(-1, 0);
    case 'down': return move(1, 0);
    case 'left': return move(0, -1);
    case 'right': return move(0, 1);
    case 'home': return dims.homeToColumnStart === false ? { row: 0, col: current.col } : { row: current.row, col: 0 };
    case 'end': return { row: current.row, col: cols - 1 };
    case 'page-up': return { row: Math.max(0, current.row - pageRows), col: current.col };
    case 'page-down': return { row: Math.min(rows - 1, current.row + pageRows), col: current.col };
    case 'first': return { row: 0, col: 0 };
    case 'last': return { row: rows - 1, col: cols - 1 };
    case 'next': return { row: moveIndex(current.row, 1, rows, { wrap: wrapRows }), col: current.col };
    case 'prev': return { row: moveIndex(current.row, -1, rows, { wrap: wrapRows }), col: current.col };
    default: return current;
  }
}

/**
 * 列表（单列）意图 → 行号：Home/End 是“列表首尾”（不是网格的行内首尾）。
 */
export function applyListIntent(index, intent, { total = 0, pageSize = DEFAULT_PAGE_ROWS, wrap = false } = {}) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  if (!count) return -1;
  const current = Math.min(count - 1, Math.max(0, Math.floor(Number(index) || 0)));
  switch (intent) {
    case 'home': case 'first': return 0;
    case 'end': case 'last': return count - 1;
    case 'page-up': return Math.max(0, current - Math.max(1, Math.floor(Number(pageSize) || DEFAULT_PAGE_ROWS)));
    case 'page-down': return Math.min(count - 1, current + Math.max(1, Math.floor(Number(pageSize) || DEFAULT_PAGE_ROWS)));
    default:
      return applyGridIntent({ row: current, col: 0 }, intent, { rows: count, cols: 1, pageRows: pageSize, wrapRows: wrap }).row;
  }
}

/** roving tabindex：只有当前光标所在行是 0，其余 -1（无光标时首行为 0）。 */
export function rovingTabIndex(rowCount, activeRow) {
  const count = Math.max(0, Math.floor(Number(rowCount) || 0));
  const active = count === 0 ? -1 : Math.min(count - 1, Math.max(0, Number(activeRow) >= 0 ? Math.floor(Number(activeRow)) : 0));
  return Array.from({ length: count }, (_value, index) => (index === active ? 0 : -1));
}

/** 行/单元格的稳定 id（aria-activedescendant / aria-describedby 用）。 */
export function cellId(prefix, row, col) {
  const base = String(prefix || 'bb-grid');
  if (col === undefined || col === null) return base + '-r' + Math.max(0, Math.floor(Number(row) || 0));
  return base + '-r' + Math.max(0, Math.floor(Number(row) || 0)) + '-c' + Math.max(0, Math.floor(Number(col) || 0));
}

/** 网格容器的 aria 属性。 */
export function gridAria({ rows = 0, cols = 0, label = '', multiselectable = true } = {}) {
  const attrs = {
    role: 'grid',
    'aria-rowcount': String(Math.max(0, Math.floor(Number(rows) || 0))),
    'aria-colcount': String(Math.max(0, Math.floor(Number(cols) || 0))),
  };
  if (label) attrs['aria-label'] = String(label);
  if (multiselectable) attrs['aria-multiselectable'] = 'true';
  return attrs;
}

/** 行容器 aria 属性（index 0 基）。 */
export function gridRowAria({ index = 0, count = 0, label = '', selected = false } = {}) {
  const attrs = {
    role: 'row',
    'aria-rowindex': String(Math.max(1, Math.floor(Number(index) || 0) + 1)),
    'aria-selected': selected ? 'true' : 'false',
  };
  if (count) attrs['aria-setsize'] = String(Math.max(0, Math.floor(Number(count) || 0)));
  if (label) attrs['aria-label'] = String(label);
  return attrs;
}

/**
 * 选择集合：不可变 Set + 范围/切换/全选/反选。
 * @param {{keys?:string[], limit?:number}} [options]
 */
export function createGridSelection(options = {}) {
  let keys = new Set(Array.isArray(options.keys) ? options.keys.map(String) : []);
  const limit = Math.max(1, Math.floor(Number(options.limit) || 1000));
  let anchor = null;
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) {
      try { listener({ keys: [...keys], size: keys.size, anchor }); } catch { /* 忽略 */ }
    }
  };
  const commit = (next) => {
    keys = next;
    emit();
  };
  return {
    get size() { return keys.size; },
    get keys() { return [...keys]; },
    get anchor() { return anchor; },
    has(key) { return keys.has(String(key)); },
    /** 单选（清空其它）。 */
    select(key) {
      anchor = String(key);
      commit(new Set([String(key)]));
    },
    /** 切换（Ctrl 点击 / Space）。 */
    toggle(key) {
      const target = String(key);
      const next = new Set(keys);
      if (next.has(target)) next.delete(target);
      else if (next.size < limit) next.add(target);
      anchor = target;
      commit(next);
    },
    /** Shift 范围选择：由 anchor 到 key（含两端）在 ordered 里的区间。 */
    selectRange(key, ordered = []) {
      const list = (Array.isArray(ordered) ? ordered : []).map(String);
      const target = String(key);
      const from = anchor === null ? target : String(anchor);
      const start = list.indexOf(from);
      const end = list.indexOf(target);
      if (start < 0 || end < 0) {
        anchor = target;
        commit(new Set([target]));
        return;
      }
      const [low, high] = start <= end ? [start, end] : [end, start];
      const next = new Set(keys);
      for (const item of list.slice(low, high + 1)) {
        if (next.size >= limit) break;
        next.add(item);
      }
      commit(next);
    },
    /** 全选（受 limit 约束）。 */
    selectAll(ordered = []) {
      const list = (Array.isArray(ordered) ? ordered : []).map(String).slice(0, limit);
      commit(new Set(list));
    },
    /** 清空。 */
    clear() {
      if (!keys.size) return;
      commit(new Set());
      anchor = null;
    },
    /** 只保留仍然存在的 key（数据刷新后调用，避免选中已删除行）。 */
    prune(ordered = []) {
      const allowed = new Set((Array.isArray(ordered) ? ordered : []).map(String));
      const next = new Set([...keys].filter((key) => allowed.has(key)));
      if (next.size !== keys.size) commit(next);
    },
    /** 订阅变化。 */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 摘要文本（aria 播报用）。 */
    summary(lang = 'zh') {
      return formatLabel('list.selected', { count: keys.size }, lang);
    },
  };
}

/**
 * 类型前置（typeahead）缓冲：短时间内的连续字符合成查询，
 * 超时或匹配失败后重置。`advance` 返回查询串与是否命中。
 */
export function createTypeahead({ timeoutMs = 700, now = () => Date.now() } = {}) {
  let buffer = '';
  let at = 0;
  return {
    /** 追加一个字符；返回查询串。 */
    push(char) {
      const stamp = now();
      const text = String(char === undefined || char === null ? '' : char);
      if (stamp - at > timeoutMs) buffer = '';
      at = stamp;
      buffer += text;
      return buffer;
    },
    /** 在候选里查找；找到返回下标，找不到 -1（并清空缓冲）。 */
    match(labels) {
      const index = typeaheadMatch(labels, buffer);
      if (index < 0) buffer = '';
      return index;
    },
    get query() { return buffer; },
    reset() { buffer = ''; at = 0; },
  };
}

/**
 * 键盘帮助分组（页面 footer / aria-describedby 用）。
 * @param {string[]} intents
 */
export function shortcutGroups(intents = ['up', 'down', 'home', 'end', 'activate', 'select', 'select-all', 'close', 'open-filter']) {
  const groups = [];
  const map = {
    'up': { keys: '↑ / k', label: 'help.moveUp' },
    'down': { keys: '↓ / j', label: 'help.moveDown' },
    'left': { keys: '←', label: 'help.moveLeft' },
    'right': { keys: '→', label: 'help.moveRight' },
    'home': { keys: 'Home / g', label: 'help.first' },
    'end': { keys: 'End / G', label: 'help.last' },
    'page-up': { keys: 'PgUp', label: 'help.pageUp' },
    'page-down': { keys: 'PgDn', label: 'help.pageDown' },
    'activate': { keys: 'Enter', label: 'help.open' },
    'select': { keys: 'Space', label: 'help.select' },
    'select-all': { keys: 'Ctrl+A', label: 'help.selectAll' },
    'close': { keys: 'Esc', label: 'help.close' },
    'open-filter': { keys: '/', label: 'help.filter' },
    'next': { keys: 'n', label: 'help.nextDiff' },
    'prev': { keys: 'p', label: 'help.prevDiff' },
  };
  for (const intent of Array.isArray(intents) ? intents : []) {
    const item = map[intent];
    if (!item) continue;
    groups.push({ intent, keys: item.keys, labelKey: item.label });
  }
  return groups;
}

/** 数据刷新后光标修复：行数变少时夹回，保持列不变。 */
export function reconcileCursor(cursor, rows, cols) {
  return clampCursor(cursor, rows, cols);
}

/** 选中行摘要（`3 行已选：a, b, c`）。 */
export function selectionText(keys, { limit = 3, lang = 'zh' } = {}) {
  const list = (Array.isArray(keys) ? keys : []).map(String);
  if (!list.length) return '';
  const head = list.slice(0, limit).join(', ');
  const more = list.length > limit ? ' +' + (list.length - limit) : '';
  return formatLabel('list.selected', { count: list.length }, lang) + ': ' + head + more;
}
