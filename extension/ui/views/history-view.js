// ui/views/history-view.js —— 记录列表（历史/审计/录制/视频）的纯视图模型。
//
// 一个视图负责：过滤 → 排序 → 分页 → 行模型 → 描述树 + 分页控件 + aria 摘要。
// 页面（debug/audit/ops/record/longshot）只需要提供「记录 → 展示字段」的取值函数，
// 其余行为（空态、选中高亮、键盘行号、分页禁用态）一致。
//
// 无 DOM：全部返回 lib/render.js 的描述对象，可在 Node 单测。

import { formatLabel } from '../lib/labels.js';
import { formatTimestamp, formatDuration, formatBytes, truncateMiddle, formatValue } from '../lib/format.js';
import { buildTableModel, nextSort, ariaSort } from '../lib/table.js';
import { buildPagingModel } from '../lib/paging.js';
import { h, listRow, button, stateBlock, sortHeader } from '../lib/render.js';

/** 每类记录的展示适配器。页面可覆盖 label/meta/badges/actions。 */
export const HISTORY_KINDS = Object.freeze({
  debug: {
    label: (item) => String(item.title || item.url || '调试记录'),
    meta: (item) => formatTimestamp(item.startedAt)
      + (item.requests !== undefined ? ' · ' + String(item.requests) + ' req' : '')
      + (item.console !== undefined ? ' / ' + String(item.console) + ' log' : ''),
    status: (item) => (item.endedAt ? 'done' : 'open'),
  },
  ops: {
    label: (item) => String(item.title || item.url || '录制'),
    meta: (item) => formatTimestamp(item.startedAt) + (Array.isArray(item.events) ? ' · ' + item.events.length + ' ev' : ''),
    status: (item) => (Array.isArray(item.events) && item.events.length ? 'done' : 'empty'),
  },
  audit: {
    label: (item) => String(item.method || 'call') + (item.tabId !== undefined ? ' · tab ' + item.tabId : ''),
    meta: (item) => formatTimestamp(item.ts) + (item.sessionId ? ' · ' + String(item.sessionId).slice(0, 10) : ''),
    status: (item) => (item.ok === false ? 'fail' : 'ok'),
  },
  video: {
    label: (item) => String(item.title || item.url || '录制'),
    meta: (item) => formatTimestamp(item.startedAt) + (item.bytes !== undefined ? ' · ' + formatBytes(item.bytes) : ''),
    status: (item) => (String(item.mime || '').includes('mp4') ? 'mp4' : 'webm'),
  },
  longshot: {
    label: (item) => String(item.id || 'longshot'),
    meta: (item) => (item.width && item.height ? item.width + '×' + item.height : '') + (item.tiles ? ' · ' + item.tiles + ' tiles' : ''),
    status: () => 'tile',
  },
});

function adapterFor(kind) {
  return HISTORY_KINDS[kind] || HISTORY_KINDS.debug;
}

function statusTone(status) {
  switch (status) {
    case 'fail': return 'danger';
    case 'open': case 'empty': return 'muted';
    case 'done': case 'ok': return 'ok';
    default: return 'muted';
  }
}

/** 记录默认列：时间 / 概况 / 状态（行内还有操作按钮）。 */
export function defaultColumns(kind, lang = 'zh') {
  const adapter = adapterFor(kind);
  return [
    { key: 'ts', label: 'time', numeric: true, sortable: true, format: (value) => formatTimestamp(value) },
    { key: 'label', label: 'summary', sortable: true, text: (row) => adapter.label(row), format: (value) => truncateMiddle(String(value === undefined || value === null ? '' : value), 100) },
    { key: 'meta', label: 'detail', sortable: false, text: (row) => adapter.meta(row) },
  ];
}

/**
 * 构建记录列表视图。
 * @param {{items:Array, kind?:string, lang?:string, page?:number, pageSize?:number, query?:string,
 *   sort?:{key:string,direction:string}, selected?:Iterable<string>, rowKey?:(item:any)=>string,
 *   actions?:(item:any, index:number)=>Array<object>, onRowClick?:(index:number, event:object)=>void,
 *   onSort?:(key:string)=>void, onPage?:(page:number)=>void, emptyText?:string}} input
 */
export function buildHistoryView(input = {}) {
  const kind = input.kind || 'debug';
  const lang = input.lang || 'zh';
  const adapter = adapterFor(kind);
  const columns = defaultColumns(kind, lang);
  const items = Array.isArray(input.items) ? input.items : [];
  const keyOf = typeof input.rowKey === 'function'
    ? input.rowKey
    : (item) => String(item && (item.id ?? item.key ?? item.ts ?? item.startedAt));
  const model = buildTableModel(items.map((item, index) => {
    const key = keyOf(item);
    return {
      ...(item && typeof item === 'object' ? item : { value: item }),
      __key: key,
      __index: index,
      ts: item && (item.ts ?? item.startedAt ?? item.endedAt) !== undefined ? (item.ts ?? item.startedAt ?? item.endedAt) : null,
      label: adapter.label(item || {}),
      meta: adapter.meta(item || {}),
      status: adapter.status(item || {}),
    };
  }), {
    columns,
    query: input.query,
    sort: input.sort,
    page: input.page,
    pageSize: input.pageSize || 20,
  });
  const paging = buildPagingModel({ page: model.page, total: model.filtered, pageSize: model.pageSize });
  const selected = new Set(Array.from(input.selected || [], (value) => String(value)));
  const rows = model.rows.map((row, offset) => {
    const index = (model.page - 1) * model.pageSize + offset;
    const key = String(row.__key);
    const actions = typeof input.actions === 'function' ? input.actions(row, index) : [];
    const isSelected = selected.has(key);
    const rowNode = listRow({
      index,
      total: model.filtered,
      label: adapter.label(row) + ' · ' + adapter.meta(row),
      selected: isSelected,
      children: [
        h('span', { class: 'grow truncate' }, adapter.label(row)),
        h('span', { class: 'muted' }, adapter.meta(row)),
        h('span', { class: 'status-pill ' + statusTone(row.status) }, String(row.status)),
        ...(Array.isArray(actions) ? actions : []),
      ],
    });
    if (typeof input.onRowClick === 'function') {
      rowNode.on = {
        click: (event) => input.onRowClick(index, event),
        keydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            input.onRowClick(index, event);
          }
        },
      };
    }
    return rowNode;
  });
  const body = model.filtered === 0
    ? stateBlock({
      kind: items.length ? 'empty' : input.emptyKind || 'empty',
      message: items.length
        ? formatLabel('list.filterNone', {}, lang)
        : (input.emptyText || formatLabel('state.empty', {}, lang)),
    })
    : h('div', {
      class: 'list',
      role: 'list',
      'aria-label': formatLabel('a11y.list', { count: model.filtered }, lang),
      'aria-rowcount': String(model.filtered),
    }, rows);
  const toolbar = h('div', { class: 'toolbar' }, [
    ...columns.filter((column) => column.sortable).map((column) => sortHeader({
      label: formatLabel('list.sort' + columnLabelSuffix(column.key), {}, lang) || column.label,
      sortDirection: ariaSort(column, model.sort),
      on: typeof input.onSort === 'function' ? { click: () => input.onSort(column.key) } : null,
    })),
  ]);
  const controls = buildPagingControls({ paging, lang, onPage: input.onPage });
  return { model, paging, rows, body, toolbar, controls, columns };
}

function columnLabelSuffix(key) {
  switch (key) {
    case 'ts': return 'Time';
    case 'durationMs': return 'Duration';
    case 'status': return 'Status';
    default: return '';
  }
}

/** 分页控件描述（禁用态 + 范围文本 + aria）。 */
export function buildPagingControls({ paging, lang = 'zh', onPage } = {}) {
  const model = paging || buildPagingModel({ page: 1, total: 0 });
  const pageButton = (label, key, page, disabled) => {
    const node = button({
      label,
      disabled,
      on: !disabled && typeof onPage === 'function' ? { click: () => onPage(page) } : null,
      attrs: { 'data-page-action': key },
    });
    return node;
  };
  return h('div', { class: 'pager toolbar', role: 'group', 'aria-label': formatLabel('paging.summary', {
    page: model.page,
    pages: model.pages,
    total: model.total,
  }, lang) }, [
    pageButton(formatLabel('paging.previous', {}, lang), 'prev', Math.max(1, model.page - 1), !model.hasPrev),
    h('span', { class: 'muted', 'aria-hidden': 'true' }, model.range),
    pageButton(formatLabel('paging.next', {}, lang), 'next', Math.min(Math.max(1, model.pages), model.page + 1), !model.hasNext),
  ]);
}

/** 记录详情（键值对 + JSON 预览按钮）。 */
export function buildDetailPanel({ item, kind = 'debug', lang = 'zh', fields = [], onCopy, onExport } = {}) {
  if (!item) return stateBlock({ kind: 'empty', message: formatLabel('state.empty', {}, lang) });
  const pairs = Array.isArray(fields) && fields.length ? fields : defaultDetailFields(item, kind);
  const children = pairs.map(([key, value]) => h('div', { class: 'kv' }, [
    h('span', { class: 'muted' }, key),
    h('span', { class: 'mono grow truncate' }, formatValue(value, 120)),
  ]));
  const actions = [];
  if (onCopy) actions.push(button({ label: formatLabel('state.retry', {}, lang) === 'Retry' ? 'Copy' : '复制', on: { click: onCopy } }));
  if (onExport) actions.push(button({ label: 'Export', on: { click: onExport } }));
  return h('div', { class: 'detail-panel', role: 'group' }, [
    h('div', { class: 'kv-list' }, children),
    actions.length ? h('div', { class: 'toolbar' }, actions) : null,
  ].filter(Boolean));
}

function defaultDetailFields(item, kind) {
  const value = item && typeof item === 'object' ? item : {};
  const fields = [];
  if (kind === 'debug') {
    fields.push(['url', value.url], ['title', value.title], ['startedAt', formatTimestamp(value.startedAt)], ['endedAt', formatTimestamp(value.endedAt)]);
    fields.push(['requests', (value.requests && value.requests.length) || value.requests || 0], ['console', (value.console && value.console.length) || value.console || 0]);
    const durations = (Array.isArray(value.requests) ? value.requests : []).map((entry) => entry.durationMs).filter((entry) => Number.isFinite(entry));
    if (durations.length) fields.push(['maxRequest', formatDuration(Math.max(...durations))]);
  } else if (kind === 'ops') {
    fields.push(['url', value.url], ['title', value.title], ['startedAt', formatTimestamp(value.startedAt)], ['events', Array.isArray(value.events) ? value.events.length : 0]);
  } else if (kind === 'audit') {
    fields.push(['method', value.method], ['ts', formatTimestamp(value.ts)], ['ok', value.ok], ['code', value.code], ['durationMs', formatDuration(value.durationMs)], ['tabId', value.tabId], ['sessionId', value.sessionId], ['url', value.url]);
  } else if (kind === 'video') {
    fields.push(['mime', value.mime], ['bytes', formatBytes(value.bytes)], ['startedAt', formatTimestamp(value.startedAt)], ['title', value.title || value.url]);
  } else if (kind === 'longshot') {
    fields.push(['id', value.id], ['size', (value.width || '?') + '×' + (value.height || '?')], ['tiles', value.tiles], ['createdAt', formatTimestamp(value.createdAt)]);
  }
  return fields;
}

/** 顶部统计条：共 N 条 / 已选 M 条（页面顺手播报）。 */
export function buildHistorySummary({ model, selected, lang = 'zh' } = {}) {
  const total = model ? model.filtered : 0;
  const picked = selected instanceof Set ? selected.size : Array.from(selected || []).length;
  const parts = [formatLabel('paging.total', { total }, lang)];
  if (picked > 0) parts.push(formatLabel('list.selected', { count: picked }, lang));
  return h('span', { class: 'muted', role: 'status', 'aria-live': 'polite' }, parts.join(' · '));
}
