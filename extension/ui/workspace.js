// ui/workspace.js —— 数据工作台页面（第十一批 F 的新页面）。
//
// 真实能力（全部落在本页，不引入框架/构建步骤）：
// 1. 导入：文件/粘贴 → 自动识别 JSON / NDJSON / CSV → 校验（逐行错误）→ 合并（追加/替换/按 key）
//    → 写入本页数据并持久化到 chrome.storage.local；
// 2. 导出：JSON / CSV / NDJSON，脱敏 URL query 与敏感头，超限截断并分片提示；
// 3. 过滤：查询串语法（status:>=400、method:GET、!、~、引号、裸词）+ 常用过滤 + chips；
// 4. 列配置：显示/隐藏、排序、宽度、持久化；
// 5. 对比：多条记录逐字段矩阵 + 两条记录的逐行差异（hunk 导航、只看差异）；
// 6. 键盘/aria：网格方向键、Home/End、PgUp/PgDn、Space 选择、Ctrl+A 全选、aria-live 播报、空态细分。
//
// 旧页面（debug/audit/ops/record/longshot）只通过 lib/page-tools.js 增加导出/导入校验，
// 本页是这些能力的“完整形态”。页面模块本身保持防御式：被 Node 桩环境加载也不抛错。

import { $ } from './common.js';
import { getLang } from './i18n.js';
import { labeler } from './lib/labels.js';
import { createRpc, browserTransport } from './lib/rpc.js';
import { mount, setHidden, setText } from './lib/dom.js';
import { h, button, when } from './lib/render.js';
import { createAnnouncer, describeTransfer, describeColumns, describeSort, bindAnnouncerToNode } from './lib/aria-live.js';
import { buildIoToolbar } from './views/io-toolbar.js';
import { buildFilterBar } from './views/filter-bar.js';
import { buildColumnsPanel, buildColumnsNotice } from './views/columns-panel.js';
import { buildImportReport, buildMergeChooser } from './views/import-report.js';
import { buildExportPreview } from './views/export-preview.js';
import { buildFieldCompareMatrix, buildRunPicker } from './views/compare-matrix.js';
import { buildDiffPanel, buildDiffRowsView, buildHunksSummary } from './views/diff-toolbar.js';
import { buildEmptyStateView } from './views/empty-state-view.js';
import {
  createColumnsState, toggleColumn, moveColumn, resizeColumn, resetColumns,
  showAllColumns, restoreColumns, serializeColumns, localizedColumnDefs, presetFor,
  nextColumnSort, visibleColumns, columnsSummary, orderedColumns,
} from './lib/columns-model.js';
import {
  filterRows, fieldsForSurface, savedFiltersFor,
} from './lib/filter-model.js';
import {
  applyGridIntent, createGridSelection, rovingTabIndex, cellId, shortcutGroups,
} from './lib/keyboard-grid.js';
import { resolveEvent } from './lib/keyboard.js';
import {
  buildExportPayload, buildDownloadDescriptor, splitExport, summarizeExport,
} from './lib/io-export.js';
import { parseImport, validateImport, mergeImported, IMPORT_LIMITS, migrateImportPayload } from './lib/io-import.js';
import { diffLines } from './lib/diff.js';
import { createDiffNavigator } from './lib/diff-nav.js';
import { formatValue } from './lib/format.js';

const lang = getLang();
const t = labeler(lang);
const rpc = createRpc(browserTransport(chrome));
const announcer = createAnnouncer();
const selection = createGridSelection({ limit: 5000 });
const PAGE_SIZE = 100;
const STORAGE_KEY = 'bb.workspace.v1';

/** 页面状态（唯一可变源；渲染函数只读它）。 */
const state = {
  tab: 'data',
  rows: [],
  meta: { source: '', fileName: '', loadedAt: 0 },
  columns: createColumnsState(localizedColumnDefs(presetFor('workspace'), lang)),
  query: '',
  sort: { key: '', direction: 'asc' },
  page: 1,
  cursor: { row: -1, col: 0 },
  importOpen: false,
  importText: '',
  mergeMode: 'append',
  importResult: null,
  columnsOpen: false,
  compareOpen: false,
  compareIds: [],
  status: '',
  loading: false,
  exportPreview: null,
};

let filterBarModel = null;
let filterResult = { rows: [], matched: 0, rejected: 0, total: 0, errors: [] };
let diffNavigator = null;

/* ---------------- 基础工具 ---------------- */

function note(text, isError) {
  state.status = text || '';
  const node = $('wsStatus');
  if (node) {
    node.textContent = state.status;
    node.className = 'io-status ' + (isError ? 'err' : 'muted');
  }
  announce(state.status, isError);
}

function announce(text, assertive) {
  if (!text) return;
  if (assertive) announcer.alert(text);
  else announcer.announce(text);
}

function doc() {
  return typeof document !== 'undefined' ? document : null;
}

function queryOne(selector) {
  const documentRef = doc();
  if (!documentRef || typeof documentRef.querySelector !== 'function') return null;
  try { return documentRef.querySelector(selector); } catch { return null; }
}

/** 挂载描述到容器（容器不存在时静默跳过）。 */
function show(containerId, descriptor) {
  const documentRef = doc();
  const container = documentRef ? documentRef.getElementById(containerId) : null;
  if (!container) return null;
  return mount(container, descriptor, documentRef).node;
}

/** 防抖：持久化/重渲染用。 */
function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
}

/** 行 key：优先稳定字段，其次序号（序号变化会丢选择，但比 key 混乱好）。 */
function rowKey(row, index) {
  if (row && typeof row === 'object') {
    if (row.id !== undefined && row.id !== null) return String(row.id);
    if (row.key !== undefined && row.key !== null) return String(row.key);
    if (row.url !== undefined && row.url !== null) return String(row.url);
  }
  return 'row-' + index;
}

/* ---------------- 持久化 ---------------- */

async function saveState() {
  try {
    const storage = chrome && chrome.storage && chrome.storage.local;
    if (!storage || typeof storage.set !== 'function') return;
    await storage.set({
      [STORAGE_KEY]: {
        schema: 2,
        rows: state.rows.slice(0, IMPORT_LIMITS.maxRows),
        columns: serializeColumns(state.columns),
        query: state.query,
        meta: state.meta,
      },
    });
  } catch { /* 存储失败不阻塞页面 */ }
}

async function restoreState() {
  try {
    const storage = chrome && chrome.storage && chrome.storage.local;
    if (!storage || typeof storage.get !== 'function') return;
    const stored = await storage.get(STORAGE_KEY);
    const value = stored ? stored[STORAGE_KEY] : null;
    if (!value || typeof value !== 'object') return;
    const migrated = migrateImportPayload(value);
    const payload = migrated.payload && typeof migrated.payload === 'object' ? migrated.payload : {};
    state.rows = Array.isArray(payload.rows) ? payload.rows : [];
    state.meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : state.meta;
    state.query = typeof payload.query === 'string' ? payload.query : '';
    const restored = restoreColumns(state.columns.defs, payload.columns);
    state.columns = restored.state;
  } catch { /* 存储损坏时保持默认 */ }
}

/* ---------------- 渲染：外壳 / 标签页 ---------------- */

function renderShell() {
  setText($('wsTitle'), t('io.title'));
  setText($('wsSubtitle'), t('io.subtitle'));
  setText($('wsFootnote'), t('compare.matrixHint'));
  setText($('wsCompareHint'), t('compare.matrixHint'));
  setText($('wsTableHint'), t('filter.help'));
  renderTabs();
}

function renderTabs() {
  const tabs = [
    { key: 'data', label: t('io.tabData') },
    { key: 'compare', label: t('io.tabCompare') },
  ];
  const nodes = tabs.map((tab) => {
    const node = h('button', {
      type: 'button',
      class: 'ws-tab',
      role: 'tab',
      id: 'wsTab-' + tab.key,
      'aria-selected': state.tab === tab.key ? 'true' : 'false',
      'aria-controls': tab.key === 'data' ? 'wsDataPanel' : 'wsComparePanel',
      'data-tab': tab.key,
      tabindex: state.tab === tab.key ? '0' : '-1',
    }, tab.label);
    node.on = { click: () => switchTab(tab.key) };
    return node;
  });
  const holder = $('wsTabs');
  if (holder) holder.setAttribute('aria-label', t('io.tabs'));
  show('wsTabs', h('div', { class: 'ws-tablist' }, nodes));
}

function switchTab(tab) {
  if (tab !== 'data' && tab !== 'compare') return;
  state.tab = tab;
  setHidden($('wsDataPanel'), tab !== 'data');
  setHidden($('wsComparePanel'), tab !== 'compare');
  renderTabs();
  if (tab === 'compare') renderCompare();
  else renderTable();
  const focusNode = queryOne('#wsTabs [data-tab="' + tab + '"]');
  if (focusNode && typeof focusNode.focus === 'function') { try { focusNode.focus(); } catch { /* 忽略 */ } }
}

/* ---------------- 渲染：IO 工具栏 ---------------- */

function renderIoToolbar() {
  const built = buildIoToolbar({
    surface: 'workspace',
    lang,
    format: 'json',
    rows: state.rows.length,
    selected: selection.size,
    sources: ['audit', 'debug', 'ops'],
    onFormat: () => {},
    onExport: (format) => { exportData(format); },
    onCopy: (format) => { copyData(format); },
    onImport: () => { toggleImport(true); },
    onClear: () => { clearData(); },
    onLoad: (source) => { loadSource(source); },
  });
  show('wsIoBar', built.tree);
}

/* ---------------- 渲染：导入面板 ---------------- */

function buildTextarea() {
  const textarea = h('textarea', {
    class: 'ws-import-text',
    'aria-label': t('io.paste'),
    placeholder: t('io.importHint'),
    id: 'wsImportText',
    spellcheck: 'false',
  }, state.importText);
  textarea.on = { input: (event) => { state.importText = String(event && event.target ? event.target.value : ''); } };
  return textarea;
}

function renderImportPanel() {
  const panel = $('wsImportPanel');
  if (!panel) return;
  setHidden(panel, !state.importOpen);
  if (!state.importOpen) return;
  const fileInput = h('input', {
    type: 'file',
    id: 'wsImportFile',
    accept: '.json,.csv,.ndjson,.jsonl,.txt,application/json,text/csv',
    'aria-label': t('io.chooseFile'),
  });
  fileInput.on = {
    change: (event) => {
      const input = event && event.target;
      const file = input && input.files && input.files[0];
      if (!file) return;
      readFileText(file).then((text) => {
        state.importText = text;
        state.meta.fileName = file.name || '';
        renderImportPanel();
        validateImportText();
      }).catch(() => note(t('import.noFile'), true));
    },
  };
  const checkButton = button({ label: t('io.preview'), tone: 'primary', attrs: { 'data-import-check': '1' } });
  checkButton.on = { click: () => validateImportText() };
  const applyButton = button({ label: t('io.import'), attrs: { 'data-import-apply': '1' }, disabled: !state.importResult || !state.importResult.parsed.ok });
  applyButton.on = { click: () => applyImport() };
  const closeButton = button({ label: t('help.close'), attrs: { 'data-import-close': '1' } });
  closeButton.on = { click: () => toggleImport(false) };

  show('wsImportPanel', h('div', { class: 'ws-import-body' }, [
    h('div', { class: 'toolbar' }, [
      h('h3', { class: 'panel-title' }, t('io.import')),
      h('span', { class: 'grow' }),
      closeButton,
    ]),
    h('p', { class: 'muted' }, t('io.importHint')),
    fileInput,
    buildTextarea(),
    h('div', { class: 'import-actions' }, [checkButton, applyButton]),
    buildMergeChooser(state.mergeMode, lang, (mode) => { state.mergeMode = mode; renderImportPanel(); }).tree,
  ]));
}

async function readFileText(file) {
  if (!file || typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsText(file);
  });
}

function toggleImport(open) {
  state.importOpen = open === undefined ? !state.importOpen : Boolean(open);
  renderImportPanel();
}

function validateImportText() {
  const source = String(state.importText || '');
  if (!source.trim()) {
    note(t('import.pasteFirst'), true);
    return null;
  }
  const parsed = parseImport(source, { fileName: state.meta.fileName });
  const fields = visibleColumns(state.columns).map((column) => ({
    key: column.key,
    type: column.type === 'timestamp' ? 'string' : column.type,
    label: column.label,
  }));
  const validation = parsed.objects && parsed.objects.length
    ? validateImport(parsed.objects, { fields }, {})
    : { ok: parsed.ok, valid: 0, invalid: 0, duplicates: 0, errors: parsed.errors, warnings: [] };
  const merge = mergeImported(state.rows, parsed.objects || [], { strategy: state.mergeMode, keyOf: (row) => rowKey(row, 0) });
  state.importResult = { parsed, validation, merge };
  renderImportReport();
  renderImportPanel();
  note(parsed.ok ? t('import.valid', { valid: validation.valid, total: parsed.objects ? parsed.objects.length : 0 }) : t('import.failed', { reason: parsed.errors[0] ? parsed.errors[0].message : t('io.noRows') }), !parsed.ok);
  return state.importResult;
}

function renderImportReport() {
  const host = $('wsImportReportHost');
  if (!host) return;
  if (!state.importResult) { setHidden(host, true); return; }
  setHidden(host, false);
  const built = buildImportReport({
    parsed: state.importResult.parsed,
    validation: state.importResult.validation,
    merge: state.importResult.merge,
    lang,
    keyField: '',
  });
  mount(host, built.tree, doc());
}

function applyImport() {
  if (!state.importResult) return;
  const merge = state.importResult.merge;
  if (!merge || !Array.isArray(merge.rows)) return;
  state.rows = merge.rows;
  state.meta = {
    source: 'import',
    fileName: state.meta.fileName,
    loadedAt: Date.now(),
  };
  selection.clear();
  state.page = 1;
  persistLater();
  renderAll();
  note(t('import.done', { count: merge.stats.result, invalid: state.importResult.validation.invalid }));
  announce(t('import.mergeStats', merge.stats));
}

/* ---------------- 渲染：过滤 ---------------- */

function renderFilter() {
  const fields = fieldsForSurface('workspace');
  const built = buildFilterBar({
    surface: 'workspace',
    lang,
    query: state.query,
    result: filterResult,
    fields,
    savedFilters: savedFiltersFor('workspace', { fields, lang }),
    onInput: (value) => {
      state.query = String(value || '');
      state.page = 1;
      renderTable();
      updateFilterSummary();
      persistLater();
    },
    onClear: () => {
      state.query = '';
      state.page = 1;
      renderFilter();
      renderTable();
      persistLater();
    },
    onRemove: (chip) => {
      if (!chip) return;
      state.query = chip.removeQuery;
      state.page = 1;
      renderFilter();
      renderTable();
      persistLater();
    },
    onApplySaved: (query) => {
      state.query = query;
      state.page = 1;
      renderFilter();
      renderTable();
      persistLater();
    },
  });
  filterBarModel = built.model;
  show('wsFilterHost', built.tree);
}

/** 只更新过滤摘要（输入时避免整棵工具栏重建导致丢焦点）。 */
function updateFilterSummary() {
  const node = queryOne('[data-filter-summary]');
  if (node) {
    setText(node, filterBarModel ? filterBarModel.summary : '');
    node.className = 'filter-summary' + (filterResult.matched === 0 && filterResult.total > 0 ? ' err' : '');
  }
}

/* ---------------- 渲染：列配置 ---------------- */

function renderColumnsPanel() {
  const host = $('wsColumnsHost');
  if (!host) return;
  setHidden(host, !state.columnsOpen);
  if (!state.columnsOpen) return;
  const built = buildColumnsPanel({
    state: state.columns,
    lang,
    onToggle: (key) => {
      const result = toggleColumn(state.columns, key);
      if (!result.changed) { const notice = buildColumnsNotice(result.reason, lang); if (notice) show('wsColumnsHost', h('div', {}, [built.tree, notice])); return; }
      state.columns = result.state;
      persistLater();
      renderColumnsPanel();
      renderTable();
      announce(describeColumns(visibleColumns(state.columns).length, state.columns.order.length, lang));
    },
    onMove: (key, delta) => { const result = moveColumn(state.columns, key, delta); if (result.changed) { state.columns = result.state; persistLater(); renderColumnsPanel(); renderTable(); } },
    onResize: (key, steps) => { const result = resizeColumn(state.columns, key, steps); if (result.changed) { state.columns = result.state; persistLater(); renderColumnsPanel(); renderTable(); } },
    onReset: () => { state.columns = resetColumns(state.columns).state; persistLater(); renderColumnsPanel(); renderTable(); note(t('columns.reset')); },
    onShowAll: () => { state.columns = showAllColumns(state.columns).state; persistLater(); renderColumnsPanel(); renderTable(); },
    onClose: () => { state.columnsOpen = false; renderColumnsPanel(); },
  });
  mount(host, built.tree, doc());
}

/* ---------------- 渲染：数据表 ---------------- */

function computeFiltered() {
  const fields = fieldsForSurface('workspace');
  return filterRows(state.rows, state.query, { surface: 'workspace', fields });
}

function sortedRows(rows) {
  const cols = visibleColumns(state.columns);
  const sort = state.sort;
  if (!sort || !sort.key) return rows.slice();
  const column = cols.find((item) => item.key === sort.key);
  if (!column) return rows.slice();
  const direction = sort.direction === 'desc' ? -1 : 1;
  const valueOf = (row) => {
    const value = row ? row[column.key] : undefined;
    if (column.type === 'number') {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
    return value === undefined || value === null ? null : String(value).toLowerCase();
  };
  return rows.map((row, index) => ({ row, index, value: valueOf(row) }))
    .sort((left, right) => {
      if (left.value === null && right.value === null) return left.index - right.index;
      if (left.value === null) return 1;
      if (right.value === null) return -1;
      if (left.value < right.value) return -1 * direction;
      if (left.value > right.value) return 1 * direction;
      return left.index - right.index;
    })
    .map((item) => item.row);
}

function tableModel() {
  filterResult = computeFiltered();
  const sorted = sortedRows(filterResult.rows);
  const pages = sorted.length === 0 ? 0 : Math.ceil(sorted.length / PAGE_SIZE);
  const page = pages === 0 ? 1 : Math.min(pages, Math.max(1, state.page));
  state.page = page;
  const start = (page - 1) * PAGE_SIZE;
  return {
    all: filterResult.rows,
    rows: sorted.slice(start, start + PAGE_SIZE),
    filtered: sorted.length,
    total: state.rows.length,
    page,
    pages,
    start,
    columns: visibleColumns(state.columns),
  };
}

function cellNode(column, row) {
  const value = row ? row[column.key] : undefined;
  const text = value === undefined || value === null ? '' : formatValue(value, column.type === 'json' ? 200 : 160);
  const width = state.columns.widths[column.key] || column.width || 160;
  return h('span', {
    class: 'ws-cell',
    role: 'gridcell',
    'data-col': column.key,
    style: { flex: '1 1 ' + width + 'px', maxWidth: Math.max(96, width * 1.6) + 'px' },
    title: text,
  }, text);
}

function renderTable() {
  const model = tableModel();
  const table = $('wsTable');
  if (table) {
    table.setAttribute('aria-label', t('a11y.list', { count: model.filtered }));
    table.setAttribute('aria-rowcount', String(model.filtered));
    table.setAttribute('aria-colcount', String(model.columns.length + 1));
  }
  const headCells = model.columns.map((column) => {
    const sorted = state.sort && state.sort.key === column.key;
    const ariaSort = sorted ? (state.sort.direction === 'desc' ? 'descending' : 'ascending') : 'none';
    const headButton = h('button', {
      type: 'button',
      class: 'ws-sort-btn',
      'data-sort-col': column.key,
      'aria-label': t('a11y.sortable', { column: column.label }) + (sorted ? ' · ' + (state.sort.direction === 'desc' ? t('list.sortDesc') : t('list.sortAsc')) : ''),
    }, column.label + (sorted ? (state.sort.direction === 'desc' ? ' ▼' : ' ▲') : ''));
    headButton.on = { click: () => sortByColumn(column) };
    return h('span', {
      class: 'ws-cell head',
      role: 'columnheader',
      'aria-sort': ariaSort,
      'data-col': column.key,
      style: { flex: '1 1 ' + (state.columns.widths[column.key] || column.width || 160) + 'px' },
    }, [headButton]);
  });
  const head = h('div', { class: 'ws-table-head', role: 'row' }, [
    h('span', { class: 'ws-cell check head', role: 'columnheader' }, ''),
    ...headCells,
  ]);
  const roving = rovingTabIndex(model.rows.length, Math.max(0, state.cursor.row - model.start));
  const rowNodes = model.rows.map((row, index) => {
    const absolute = model.start + index;
    const key = rowKey(row, absolute);
    const selected = selection.has(key);
    const rowNode = h('div', {
      class: 'ws-table-row',
      role: 'row',
      'aria-rowindex': String(absolute + 1),
      'aria-selected': selected ? 'true' : 'false',
      id: cellId('wsrow', absolute),
      tabindex: String(roving[index] === 0 ? 0 : -1),
      'data-row': String(absolute),
      'data-key': key,
    }, [
      h('span', { class: 'ws-cell check', role: 'gridcell' }, ''),
      ...model.columns.map((column) => cellNode(column, row)),
    ]);
    rowNode.on = { click: () => { state.cursor = { row: absolute, col: 0 }; selectRow(key, absolute); renderTable(); } };
    return rowNode;
  });
  const pager = h('div', { class: 'ws-pager' }, [
    h('span', {}, t('paging.range', { from: model.filtered ? model.start + 1 : 0, to: model.start + model.rows.length, total: model.filtered })),
    h('span', { class: 'grow' }),
    h('span', {}, t('paging.page', { page: model.page, pages: model.pages })),
  ]);
  show('wsTable', h('div', { class: 'ws-table-body' }, [head, ...rowNodes, pager]));
  renderEmptyState(model);
  if (state.columnsOpen) renderColumnsPanel();
}

function sortByColumn(column) {
  const result = nextColumnSort(state.columns, column.key, { numeric: column.type === 'number' });
  if (!result.changed) return;
  state.columns = result.state;
  state.sort = result.sort;
  state.page = 1;
  persistLater();
  renderTable();
  announce(describeSort(column.label, result.sort.direction, lang));
}

function selectRow(key, index) {
  selection.toggle(String(key));
  state.cursor = { row: index, col: 0 };
  announce(selection.summary(lang));
}

/* ---------------- 渲染：空态 ---------------- */

function renderEmptyState(model) {
  const host = $('wsEmpty');
  if (host) host.classList.add('bd-empty');
  if (!host) return;
  if (model.filtered > 0) {
    setHidden(host, true);
    mount(host, h('span', {}, ''), doc());
    return;
  }
  setHidden(host, false);
  const reason = state.rows.length === 0 ? 'first-run' : 'no-match';
  const built = buildEmptyStateView({
    surface: 'workspace',
    lang,
    reason,
    total: state.rows.length,
    matched: 0,
    query: state.query,
    onAction: (actionKey) => {
      if (actionKey === 'import') toggleImport(true);
      else if (actionKey === 'load') loadSource('audit');
      else if (actionKey === 'clear-filter') { state.query = ''; renderFilter(); renderTable(); }
      else if (actionKey === 'refresh') renderAll();
    },
  });
  mount(host, built.tree, doc());
}

/* ---------------- 导出 / 复制 / 清空 ---------------- */

function selectedRows() {
  if (!selection.size) return [];
  const keys = new Set(selection.keys);
  return state.rows.filter((row, index) => keys.has(rowKey(row, index)));
}

function exportData(format) {
  const rows = selection.size ? selectedRows() : state.rows;
  if (!rows.length) { note(t('io.noRows'), true); return null; }
  const columns = visibleColumns(state.columns).map((column) => ({
    key: column.key,
    label: column.label,
    type: column.type,
    text: column.text || undefined,
  }));
  const payload = buildExportPayload({
    surface: 'workspace',
    format,
    rows,
    columns,
    redact: true,
    keepQuery: false,
    stamp: Date.now(),
  });
  const descriptor = buildDownloadDescriptor(payload);
  const ok = downloadDescriptor(descriptor);
  if (ok) note(describeTransfer('export', summarizeExport(payload), lang));
  else note(t('export.failed', { reason: t('io.download') }), true);
  const parts = splitExport(payload.text, { maxBytes: 4 * 1024 * 1024 });
  if (parts.length > 1) announce(t('io.split', { count: parts.length }));
  state.exportPreview = payload;
  renderExportPreview(payload, columns);
  return payload;
}

function renderExportPreview(payload, columns) {
  const built = buildExportPreview({ payload, columns, lang });
  show('wsImportReportHost', h('div', {}, [built.tree]));
  const host = $('wsImportReportHost');
  if (host) setHidden(host, false);
}

function copyData() {
  const rows = selection.size ? selectedRows() : state.rows;
  if (!rows.length) { note(t('io.noRows'), true); return; }
  const payload = buildExportPayload({ surface: 'workspace', format: 'json', rows, columns: visibleColumns(state.columns), redact: true });
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
  if (clipboard && typeof clipboard.writeText === 'function') {
    clipboard.writeText(payload.text).then(() => note(t('io.copied'))).catch(() => note(t('export.failed', { reason: t('io.copy') }), true));
  } else {
    note(t('export.failed', { reason: t('io.copy') }), true);
  }
}

function downloadDescriptor(descriptor) {
  const documentRef = doc();
  if (!documentRef || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  try {
    const blob = new Blob([descriptor.text], { type: descriptor.mime });
    const href = URL.createObjectURL(blob);
    const anchor = documentRef.createElement('a');
    anchor.href = href;
    anchor.download = descriptor.name;
    anchor.rel = 'noopener';
    try { (documentRef.body || documentRef.documentElement).appendChild(anchor); } catch { /* 忽略 */ }
    anchor.click();
    try { anchor.remove(); } catch { /* 忽略 */ }
    const timer = setTimeout(() => { try { URL.revokeObjectURL(href); } catch { /* 忽略 */ } }, 4000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  } catch {
    return false;
  }
}

function clearData() {
  state.rows = [];
  state.meta = { source: '', fileName: '', loadedAt: 0 };
  state.importResult = null;
  state.compareIds = [];
  selection.clear();
  state.page = 1;
  persistLater();
  renderAll();
  note(t('io.clearData'));
}

/* ---------------- 载入记录（真实 RPC） ---------------- */

const LOAD_TYPES = Object.freeze({
  audit: { type: 'bb.audit.list', payload: { since: 0, limit: 500 }, pick: (result) => result.entries || result.history },
  debug: { type: 'bb.debug.history', payload: {}, pick: (result) => result.history || result.entries },
  ops: { type: 'bb.ops.list', payload: {}, pick: (result) => result.recordings },
});

async function loadSource(sourceKey) {
  const definition = LOAD_TYPES[sourceKey];
  if (!definition) return;
  state.loading = true;
  note(t('io.rows', { count: state.rows.length }));
  try {
    const reply = await rpc.send(definition.type, definition.payload);
    if (!reply || reply.ok === false) throw new Error(reply && (reply.message || reply.error) || 'E_UNKNOWN');
    const result = reply.result && typeof reply.result === 'object' ? reply.result : reply;
    const rows = definition.pick(result);
    if (!Array.isArray(rows)) throw new Error('E_EMPTY_REPLY');
    state.rows = rows.map((row) => (row && typeof row === 'object' ? row : { value: row }));
    state.meta = { source: sourceKey, fileName: '', loadedAt: Date.now() };
    state.page = 1;
    selection.clear();
    persistLater();
    renderAll();
    note(t('io.loaded', { count: state.rows.length }));
  } catch (error) {
    note(t('import.failed', { reason: String((error && error.message) || error) }), true);
  } finally {
    state.loading = false;
  }
}

/* ---------------- 对比 ---------------- */

function compareChoices() {
  return state.rows.slice(0, 60).map((row, index) => ({
    id: String(index),
    label: String(row && (row.id !== undefined ? row.id : (row.url || row.method || row.name || row.id || 'row-' + index))),
  }));
}

function renderCompare() {
  const choices = compareChoices();
  const selected = state.compareIds.map((id) => Number(id)).filter((index) => Number.isInteger(index) && index >= 0 && index < state.rows.length);
  const runs = selected.map((index, position) => ({
    id: String(index),
    label: '#' + (index + 1) + (position === 0 ? ' (' + t('compare.baseline') + ')' : ''),
    data: state.rows[index],
    rows: Array.isArray(state.rows[index] && state.rows[index].entries) ? state.rows[index].entries : null,
  }));
  const picker = buildRunPicker({
    runs: runs.map((run) => ({ id: run.id, label: run.label })),
    choices,
    lang,
    onPick: (id) => {
      if (id === '') return;
      if (state.compareIds.length >= 6) return;
      state.compareIds = [...state.compareIds, id];
      renderCompare();
    },
    onRemove: (id) => {
      state.compareIds = state.compareIds.filter((item) => item !== id);
      renderCompare();
    },
  });
  show('wsCompareRuns', h('div', { class: 'toolbar' }, [
    h('h3', { class: 'panel-title' }, t('compare.matrix')),
    h('span', { class: 'grow' }),
    picker,
  ]));

  if (!runs.length) {
    show('wsCompareBody', h('p', { class: 'muted', role: 'status' }, t('compare.needOne')));
    show('wsDiffHost', h('span', {}, ''));
    show('wsDiffRows', h('span', {}, ''));
    return;
  }
  const matrix = buildFieldCompareMatrix({ runs, lang, baselineIndex: 0 });
  show('wsCompareBody', matrix.tree);
  renderDiffForRuns(runs);
}

function renderDiffForRuns(runs) {
  const host = $('wsDiffHost');
  const rowsHost = $('wsDiffRows');
  if (!host || !rowsHost) return;
  if (runs.length < 2) {
    mount(host, h('p', { class: 'muted' }, t('compare.needOne')), doc());
    mount(rowsHost, h('span', {}, ''), doc());
    diffNavigator = null;
    return;
  }
  const left = safeJson(runs[0].data);
  const right = safeJson(runs[1].data);
  diffNavigator = createDiffNavigator(diffLines(left, right), { onlyChanges: false, context: 3 });
  const render = () => {
    const snapshot = diffNavigator.snapshot();
    const built = buildDiffPanel({
      snapshot,
      lang,
      onNext: () => { diffNavigator.next(); render(); },
      onPrev: () => { diffNavigator.prev(); render(); },
      onToggleOnlyChanges: (value) => { diffNavigator.setOnlyChanges(value); render(); },
      onChangeContext: (value) => { diffNavigator.setContext(Number(value)); render(); },
    });
    mount(host, h('div', {}, [buildHunksSummary(snapshot, lang), built.tree]), doc());
    const rows = diffViewRows(snapshot);
    mount(rowsHost, rows, doc());
  };
  render();
}

/** 用 views/diff-toolbar 的 buildDiffRowsView 渲染行（复用同一份描述）。 */
function diffViewRows(snapshot) {
  const built = buildDiffRowsView({ snapshot, lang, onFold: () => {} });
  return built.tree;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/* ---------------- 键盘 / aria ---------------- */

function focusFilter() {
  const input = queryOne('#wsFilterHost [data-filter-input]');
  if (input && typeof input.focus === 'function') { try { input.focus(); } catch { /* 忽略 */ } }
}

function handleKeydown(event) {
  const intent = resolveEvent(event, { target: event && event.target });
  if (intent.intent === 'select-all') {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const model = tableModel();
    selection.selectAll(model.rows.map((row, index) => rowKey(row, model.start + index)));
    announce(selection.summary(lang));
    renderTable();
    return;
  }
  if (!intent.handled) return;
  if (intent.intent === 'open-filter') {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    focusFilter();
    return;
  }
  if (intent.intent === 'close') {
    if (state.importOpen) { toggleImport(false); if (event && event.preventDefault) event.preventDefault(); return; }
    if (state.columnsOpen) { state.columnsOpen = false; renderColumnsPanel(); if (event && event.preventDefault) event.preventDefault(); return; }
    return;
  }
  if (state.tab === 'compare') {
    if (diffNavigator && (intent.intent === 'next' || intent.intent === 'down')) { diffNavigator.next(); renderDiffForRuns(diffRuns()); if (event && event.preventDefault) event.preventDefault(); }
    if (diffNavigator && (intent.intent === 'prev' || intent.intent === 'up')) { diffNavigator.prev(); renderDiffForRuns(diffRuns()); if (event && event.preventDefault) event.preventDefault(); }
    return;
  }
  if (['up', 'down', 'left', 'right', 'home', 'end', 'page-up', 'page-down'].includes(intent.intent)) {
    const model = tableModel();
    if (!model.rows.length) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const relative = state.cursor.row < 0 ? 0 : state.cursor.row - model.start;
    const next = applyGridIntent({ row: Math.max(0, relative), col: state.cursor.col }, intent.intent, {
      rows: model.rows.length,
      cols: model.columns.length + 1,
      pageRows: 10,
    });
    const absolute = model.start + next.row;
    state.cursor = { row: absolute, col: next.col };
    const rowNode = queryOne('#wsTable [data-row="' + absolute + '"]');
    if (rowNode && typeof rowNode.focus === 'function') { try { rowNode.focus(); } catch { /* 忽略 */ } }
    if (intent.intent === 'down' || intent.intent === 'up') announce(selection.summary(lang));
  } else if (intent.intent === 'select') {
    const model = tableModel();
    const row = model.rows[Math.max(0, state.cursor.row - model.start)];
    if (row) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      selection.toggle(rowKey(row, model.start + Math.max(0, state.cursor.row - model.start)));
      renderTable();
      announce(selection.summary(lang));
    }
  }
}

function diffRuns() {
  return state.compareIds.map((id) => Number(id)).filter((index) => Number.isInteger(index) && index < state.rows.length).map((index, position) => ({
    id: String(index),
    label: '#' + (index + 1) + (position === 0 ? ' (' + t('compare.baseline') + ')' : ''),
    data: state.rows[index],
  }));
}

/* ---------------- 协调 ---------------- */

const persistLater = debounce(() => { void saveState(); }, 350);

function renderAll() {
  renderShell();
  renderIoToolbar();
  renderFilter();
  renderColumnsPanel();
  renderTable();
  if (state.tab === 'compare') renderCompare();
}

let announcerBinding = null;

function bindAnnouncements() {
  const node = $('wsAnnounce');
  if (node) announcerBinding = bindAnnouncerToNode(announcer, node, { doc: doc() });
}

async function boot() {
  try {
    renderShell();
    bindAnnouncements();
    await restoreState();
    renderAll();
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', (event) => handleKeydown(event));
    }
    const tableHint = $('wsTableHint');
    if (tableHint) tableHint.textContent = shortcutGroups(['up', 'down', 'home', 'end', 'select', 'select-all', 'open-filter']).map((group) => group.keys).join(' · ');
    const reason = t('io.needData');
    if (!state.rows.length) note(reason);
    setText($('wsCompareHint'), t('compare.matrixHint'));
  } catch (error) {
    note(String((error && error.message) || error), true);
  }
}

void boot();

/* 测试/调试钩子：只读快照（不暴露可变引用）。 */
export function workspaceSnapshot() {
  return {
    rows: state.rows.length,
    columns: state.columns.order.slice(),
    query: state.query,
    tab: state.tab,
    page: state.page,
    compare: state.compareIds.slice(),
    filter: { matched: filterResult.matched, total: filterResult.total },
    columnsSummary: columnsSummary(state.columns, lang),
    ordered: orderedColumns(state.columns).map((column) => column.key),
    shortcuts: shortcutGroups().length,
    status: state.status,
  };
}
