// ui/lib/columns-model.js —— 列配置模型（纯函数，无 DOM/chrome，可在 Node 单测）。
//
// 表格页的列是用户最常调的东西：谁在前、要不要显示、多宽、排序按哪个字段。
// 如果每个页面各写一份「colSpan/可见性/顺序」状态，就会出现：
// - 刷新后列配置丢失（没持久化）；
// - 隐藏到一列都没有（表格变空白）；
// - 新版本加了列，老用户的保存配置里没有它（新列永远不出现）。
//
// 本模块把列配置收敛成不可变 state：
//   { version, defs:[...], order:[key...], hidden:Set, widths:{key:px}, sort:{key,direction} }
//
// 关键规则：
// - repair 会把“未知 key 丢掉、缺失的新列补到末尾、重复 key 去重”；
// - 至少保留一列可见（hideAll 会拒绝并给出原因）；
// - 持久化字符串带版本前缀 `v1:`，不认识/损坏时回退默认，不让页面白屏。

import { formatLabel } from './labels.js';

/** 列定义归档版本：格式变化时 +1，旧字符串回退默认。 */
export const COLUMNS_VERSION = 1;

/** 宽度夹取范围（太窄读不出内容，太宽会把表格撑出横向滚动）。 */
export const WIDTH_MIN = 64;
export const WIDTH_MAX = 640;
export const WIDTH_DEFAULT = 160;

/** 列类型：影响对齐、排序与格式化。 */
export const COLUMN_TYPES = Object.freeze(['string', 'number', 'timestamp', 'boolean', 'json']);

/**
 * 规范化列定义。
 * @param {Array<{key?:string,id?:string,label?:string,labelKey?:string,type?:string,
 *   width?:number,sortable?:boolean,hideable?:boolean,visible?:boolean,format?:Function,text?:Function}>} defs
 */
export function normalizeColumnDefs(defs) {
  const list = Array.isArray(defs) ? defs : [];
  const seen = new Set();
  const out = [];
  for (const def of list) {
    if (!def || typeof def !== 'object') continue;
    const key = String(def.key !== undefined ? def.key : (def.id !== undefined ? def.id : ''));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: String(def.label !== undefined ? def.label : (def.labelKey || key)),
      labelKey: def.labelKey ? String(def.labelKey) : '',
      type: COLUMN_TYPES.includes(def.type) ? def.type : 'string',
      width: clampWidth(def.width),
      sortable: def.sortable !== false,
      hideable: def.hideable !== false,
      defaultVisible: def.visible !== false,
      format: typeof def.format === 'function' ? def.format : null,
      text: typeof def.text === 'function' ? def.text : null,
    });
  }
  return out;
}

/** 宽度夹取：非数字回退默认，超界夹到边界。 */
export function clampWidth(width) {
  const number = Number(width);
  if (!Number.isFinite(number) || number <= 0) return WIDTH_DEFAULT;
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(number)));
}

/**
 * 初始配置：默认按定义顺序，默认可见列。
 * @param {Array} defs 列定义
 * @param {{hidden?:string[], order?:string[], widths?:object, sort?:{key:string,direction:string}}} [saved]
 */
export function createColumnsState(defs, saved = {}) {
  const normalized = normalizeColumnDefs(defs);
  const state = {
    version: COLUMNS_VERSION,
    defs: normalized,
    order: normalized.map((def) => def.key),
    hidden: new Set(normalized.filter((def) => def.defaultVisible === false).map((def) => def.key)),
    widths: {},
    sort: { key: '', direction: 'asc' },
  };
  return repairColumnsState(state, saved);
}

/**
 * 修复配置：未知 key 丢弃、缺失列补到末尾、去重；saved 里的顺序/隐藏/宽度按白名单应用。
 */
export function repairColumnsState(state, saved = {}) {
  const base = state && typeof state === 'object' ? state : { version: COLUMNS_VERSION, defs: [], order: [], hidden: new Set(), widths: {}, sort: { key: '', direction: 'asc' } };
  const known = new Map((base.defs || []).map((def) => [def.key, def]));
  const savedOrder = Array.isArray(saved.order) ? saved.order : [];
  const order = [];
  const seen = new Set();
  for (const key of savedOrder) {
    const text = String(key);
    if (!known.has(text) || seen.has(text)) continue;
    seen.add(text);
    order.push(text);
  }
  for (const def of base.defs || []) {
    if (seen.has(def.key)) continue;
    seen.add(def.key);
    order.push(def.key);
  }
  const hidden = new Set();
  const allowedHidden = Array.isArray(saved.hidden) ? saved.hidden : [...(base.hidden || [])];
  for (const key of allowedHidden) {
    const text = String(key);
    if (known.has(text)) hidden.add(text);
  }
  const widths = {};
  const savedWidths = saved.widths && typeof saved.widths === 'object' ? saved.widths : (base.widths || {});
  for (const [key, width] of Object.entries(savedWidths)) {
    if (!known.has(key)) continue;
    widths[key] = clampWidth(width);
  }
  // 至少保留一列可见：如果保存的配置把全部列都藏了，强制恢复第一个可隐藏列。
  if (order.length && hidden.size >= order.length) {
    const restore = order.find((key) => known.has(key));
    if (restore) hidden.delete(restore);
  }
  let sort = { key: '', direction: 'asc' };
  const savedSort = saved.sort || base.sort;
  if (savedSort && savedSort.key && known.has(String(savedSort.key))) {
    sort = { key: String(savedSort.key), direction: savedSort.direction === 'desc' ? 'desc' : 'asc' };
  }
  return {
    version: COLUMNS_VERSION,
    defs: order.map((key) => known.get(key)),
    order,
    hidden,
    widths,
    sort,
  };
}

/** 当前可见列（按 order 顺序）。 */
export function visibleColumns(state) {
  if (!state || !Array.isArray(state.order)) return [];
  return state.order
    .filter((key) => !state.hidden.has(key))
    .map((key) => state.defs.find((def) => def.key === key))
    .filter(Boolean);
}

/** 全部列（按 order 顺序），带 visible 标记，供列配置面板渲染。 */
export function orderedColumns(state) {
  if (!state || !Array.isArray(state.order)) return [];
  return state.order.map((key, index) => {
    const def = state.defs.find((item) => item.key === key);
    return {
      key,
      label: def ? def.label : key,
      labelKey: def ? def.labelKey : '',
      type: def ? def.type : 'string',
      sortable: Boolean(def && def.sortable),
      hideable: Boolean(def && def.hideable),
      visible: !state.hidden.has(key),
      width: state.widths[key] || (def ? def.width : WIDTH_DEFAULT),
      index,
      canMoveUp: index > 0,
      canMoveDown: index < state.order.length - 1,
    };
  });
}

/** 切换可见性：返回新 state；隐藏最后一列时拒绝（返回原因）。 */
export function toggleColumn(state, key) {
  const target = String(key);
  if (!state || !state.defs.some((def) => def.key === target)) {
    return { state, changed: false, reason: 'unknown' };
  }
  const hidden = new Set(state.hidden);
  if (hidden.has(target)) {
    hidden.delete(target);
    return { state: { ...state, hidden }, changed: true, reason: 'shown' };
  }
  const visible = state.order.filter((item) => !hidden.has(item));
  if (visible.length <= 1) return { state, changed: false, reason: 'last-visible' };
  const def = state.defs.find((item) => item.key === target);
  if (def && def.hideable === false) return { state, changed: false, reason: 'not-hideable' };
  hidden.add(target);
  return { state: { ...state, hidden }, changed: true, reason: 'hidden' };
}

/** 设置可见性（幂等）。 */
export function setColumnVisible(state, key, visible) {
  const target = String(key);
  const isVisible = state && state.order ? !state.hidden.has(target) : false;
  if (isVisible === Boolean(visible)) return { state, changed: false, reason: 'noop' };
  return toggleColumn(state, target);
}

/** 移动列：delta 为 -1/1；越界或不可移动时返回原 state。 */
export function moveColumn(state, key, delta = -1) {
  const target = String(key);
  if (!state || !Array.isArray(state.order)) return { state, changed: false, reason: 'invalid' };
  const from = state.order.indexOf(target);
  if (from < 0) return { state, changed: false, reason: 'unknown' };
  const step = Math.sign(Number(delta) || 0);
  if (!step) return { state, changed: false, reason: 'noop' };
  const to = from + step;
  if (to < 0 || to >= state.order.length) return { state, changed: false, reason: 'boundary' };
  const order = state.order.slice();
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return { state: { ...state, order }, changed: true, reason: 'moved', from, to };
}

/** 调整列宽（夹取范围）。 */
export function setColumnWidth(state, key, width) {
  const target = String(key);
  if (!state || !state.defs.some((def) => def.key === target)) return { state, changed: false, reason: 'unknown' };
  const next = clampWidth(width);
  const current = state.widths[target] || 0;
  if (current === next) return { state, changed: false, reason: 'noop' };
  return { state: { ...state, widths: { ...state.widths, [target]: next } }, changed: true, reason: 'resized', width: next };
}

/** 宽度步进：`resizeColumn(state,'url',1)` 加一档（按 16px 粒度），结果夹在 [MIN,MAX]。 */
export function resizeColumn(state, key, steps = 1) {
  const target = String(key);
  if (!state || !state.defs.some((def) => def.key === target)) return { state, changed: false, reason: 'unknown' };
  const current = state.widths[target] || (state.defs.find((def) => def.key === target) || {}).width || WIDTH_DEFAULT;
  const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(current + (Number(steps) || 0) * 16)));
  return setColumnWidth(state, target, next);
}

/** 显示全部列。 */
export function showAllColumns(state) {
  if (!state) return { state, changed: false, reason: 'invalid' };
  if (!state.hidden.size) return { state, changed: false, reason: 'noop' };
  return { state: { ...state, hidden: new Set() }, changed: true, reason: 'shown-all' };
}

/** 隐藏全部（保留一列，返回被保留的 key）。 */
export function hideAllColumns(state) {
  if (!state) return { state, changed: false, reason: 'invalid', kept: null };
  const hideable = state.order.filter((key) => {
    const def = state.defs.find((item) => item.key === key);
    return !def || def.hideable !== false;
  });
  if (!hideable.length) return { state, changed: false, reason: 'no-hideable', kept: null };
  const kept = state.order.find((key) => !hideable.includes(key)) || hideable[0];
  const hidden = new Set(state.order.filter((key) => key !== kept));
  return { state: { ...state, hidden }, changed: true, reason: 'hidden-all', kept };
}

/** 恢复默认：顺序/可见性/宽度回到定义默认。 */
export function resetColumns(state) {
  if (!state) return { state, changed: false, reason: 'invalid' };
  const fresh = createColumnsState(state.defs);
  return { state: fresh, changed: true, reason: 'reset' };
}

/** 排序切换（复用 table.js 的口径，但状态在列配置里）。 */
export function nextColumnSort(state, key, { numeric = false } = {}) {
  if (!state) return { state, changed: false, reason: 'invalid' };
  const target = String(key);
  if (!state.defs.some((def) => def.key === target)) return { state, changed: false, reason: 'unknown' };
  const current = state.sort && state.sort.key === target ? state.sort : null;
  const direction = current ? (current.direction === 'asc' ? 'desc' : 'asc') : (numeric ? 'desc' : 'asc');
  return { state: { ...state, sort: { key: target, direction } }, changed: true, reason: 'sorted', sort: { key: target, direction } };
}

/** 序列化：`v1:url|ts|status;h:level;w:url=240`（稳定排序，便于测试与 diff）。 */
export function serializeColumns(state) {
  if (!state || !state.order) return '';
  const order = state.order.join('|');
  const hidden = state.order.filter((key) => state.hidden.has(key)).join('|');
  const widths = Object.keys(state.widths).sort().map((key) => key + '=' + state.widths[key]).join('|');
  const sort = state.sort && state.sort.key ? state.sort.key + ':' + state.sort.direction : '';
  return 'v' + COLUMNS_VERSION + ':' + order + ';h=' + hidden + ';w=' + widths + ';s=' + sort;
}

/** 反序列化：坏数据返回 null（页面回退默认列，不抛错）。 */
export function deserializeColumns(text) {
  const source = String(text === undefined || text === null ? '' : text).trim();
  if (!source) return null;
  const match = /^v(\d+):(.*)$/.exec(source);
  if (!match) return null;
  if (Number(match[1]) !== COLUMNS_VERSION) return null;
  try {
    const [orderPart, hiddenPart = '', widthsPart = '', sortPart = ''] = match[2].split(';');
    const order = orderPart ? orderPart.split('|').filter(Boolean) : [];
    const hidden = hiddenPart.replace(/^h=/, '').split('|').filter(Boolean);
    const widths = {};
    for (const pair of widthsPart.replace(/^w=/, '').split('|').filter(Boolean)) {
      const [key, value] = pair.split('=');
      if (key && Number.isFinite(Number(value))) widths[key] = clampWidth(value);
    }
    const sortText = sortPart.replace(/^s=/, '');
    const [sortKey, sortDirection] = sortText ? sortText.split(':') : ['', 'asc'];
    return {
      order,
      hidden,
      widths,
      sort: { key: sortKey || '', direction: sortDirection === 'desc' ? 'desc' : 'asc' },
    };
  } catch {
    return null;
  }
}

/** 从 storage 恢复：坏值/旧版本 → 默认配置（并报告 recovered 原因）。 */
export function restoreColumns(defs, savedText) {
  const saved = deserializeColumns(savedText);
  if (!saved) return { state: createColumnsState(defs), recovered: false, reason: savedText ? 'invalid' : 'empty' };
  const state = createColumnsState(defs, saved);
  const savedCount = saved.order.length;
  const knownCount = state.order.length;
  return { state, recovered: true, reason: savedCount > knownCount ? 'pruned' : 'ok' };
}

/** 列配置签名：用于“是否有未保存修改”的判断。 */
export function columnsSignature(state) {
  return serializeColumns(state);
}

/**
 * 每个表面的默认列（页面无需再从 table.js 里拿通用列）。
 * labelKey 指向 labels.js。
 */
export const COLUMN_PRESETS = Object.freeze({
  workspace: Object.freeze([
    { key: 'ts', labelKey: 'columns.field.time', type: 'timestamp', width: 160 },
    { key: 'method', labelKey: 'columns.field.method', type: 'string', width: 90 },
    { key: 'status', labelKey: 'columns.field.status', type: 'number', width: 80 },
    { key: 'durationMs', labelKey: 'columns.field.duration', type: 'number', width: 100 },
    { key: 'url', labelKey: 'columns.field.url', type: 'string', width: 320 },
  ]),
  audit: Object.freeze([
    { key: 'ts', labelKey: 'columns.field.time', type: 'timestamp', width: 160 },
    { key: 'method', labelKey: 'columns.field.method', type: 'string', width: 120 },
    { key: 'durationMs', labelKey: 'columns.field.duration', type: 'number', width: 100 },
    { key: 'result', labelKey: 'columns.field.result', type: 'string', width: 90 },
    { key: 'session', labelKey: 'columns.field.session', type: 'string', width: 120 },
    { key: 'tabId', labelKey: 'columns.field.tab', type: 'string', width: 80 },
    { key: 'url', labelKey: 'columns.field.url', type: 'string', width: 280 },
  ]),
  debug: Object.freeze([
    { key: 'ts', labelKey: 'columns.field.time', type: 'timestamp', width: 160 },
    { key: 'method', labelKey: 'columns.field.method', type: 'string', width: 90 },
    { key: 'status', labelKey: 'columns.field.status', type: 'number', width: 80 },
    { key: 'durationMs', labelKey: 'columns.field.duration', type: 'number', width: 100 },
    { key: 'url', labelKey: 'columns.field.url', type: 'string', width: 360 },
  ]),
  ops: Object.freeze([
    { key: 'ts', labelKey: 'columns.field.time', type: 'timestamp', width: 160 },
    { key: 'type', labelKey: 'columns.field.type', type: 'string', width: 110 },
    { key: 'selector', labelKey: 'columns.field.selector', type: 'string', width: 260 },
    { key: 'url', labelKey: 'columns.field.url', type: 'string', width: 260 },
  ]),
  record: Object.freeze([
    { key: 'ts', labelKey: 'columns.field.time', type: 'timestamp', width: 160 },
    { key: 'mime', labelKey: 'columns.field.mime', type: 'string', width: 110 },
    { key: 'bytes', labelKey: 'columns.field.bytes', type: 'number', width: 100 },
    { key: 'durationMs', labelKey: 'columns.field.duration', type: 'number', width: 100 },
  ]),
  longshot: Object.freeze([
    { key: 'ts', labelKey: 'columns.field.time', type: 'timestamp', width: 160 },
    { key: 'tiles', labelKey: 'columns.field.tiles', type: 'number', width: 90 },
    { key: 'width', labelKey: 'columns.field.width', type: 'number', width: 90 },
    { key: 'height', labelKey: 'columns.field.height', type: 'number', width: 90 },
    { key: 'url', labelKey: 'columns.field.url', type: 'string', width: 300 },
  ]),
});

/** 取表面默认列；未知表面回退 workspace。 */
export function presetFor(surface) {
  return COLUMN_PRESETS[surface] || COLUMN_PRESETS.workspace;
}

/** 预设列 + 本地化标签（labelKey 走 labels 目录，缺 key 时回退 key）。 */
export function localizedColumnDefs(defs, lang = 'zh') {
  return normalizeColumnDefs((Array.isArray(defs) ? defs : []).map((def) => ({
    ...def,
    label: def.labelKey ? formatLabel(def.labelKey, {}, lang) : (def.label || def.key),
  })));
}

/** 面板摘要：`3 / 5 列可见`。 */
export function columnsSummary(state, lang = 'zh') {
  const visible = visibleColumns(state).length;
  const total = state && Array.isArray(state.order) ? state.order.length : 0;
  return formatLabel('columns.visible', { count: visible, total }, lang);
}
