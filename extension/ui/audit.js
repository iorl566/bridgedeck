// ui/audit.js —— 任务审计（扩展侧记录，默认关闭）
import { $ } from './common.js';
import { getLang, translate } from './i18n.js';
import { installPageTools } from './lib/page-tools.js';
import { describeError } from './error-hints.js';
import { dialogText, openDialog } from './a11y-dialog.js';
import { announce } from './a11y-dialog.js';
import { labeler } from './lib/labels.js';
import { createRpc } from './lib/rpc.js';
import { mount, setHidden, setText } from './lib/dom.js';
import { h, button } from './lib/render.js';
import { createStateMachine, stateModel } from './lib/states.js';
import { buildTableModel } from './lib/table.js';
import { buildPagingModel } from './lib/paging.js';
import { createRovingModel } from './lib/focus.js';
import { createVirtualModel } from './lib/virtual-list.js';
import { createSelection } from './lib/selection.js';
import { resolveEvent } from './lib/keyboard.js';
import { decodeViewState, encodeViewState } from './lib/view-state.js';
import { formatDuration, formatTimestamp, formatValue, truncateMiddle } from './lib/format.js';
import { buildTimelineView } from './views/timeline-view.js';
import { createButton, createEmptyState } from './components/index.js';

function note(text, isError) {
  const node = $('note');
  node.textContent = text || '';
  node.className = 'note' + (isError ? ' err' : '');
}

/** 错误统一走 12 语言提示；保留错误码便于诊断。 */
function noteError(error) {
  note(describeError(error, getLang()).text, true);
}

function formatTime(ts) {
  const date = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function row(entry) {
  const node = document.createElement('div');
  node.className = 'list-row';
  const status = document.createElement('span');
  status.className = 'status-pill';
  status.textContent = '调用';
  const main = document.createElement('span');
  main.className = 'grow truncate mono';
  main.textContent = entry.method + (entry.tabId != null ? '  tab ' + entry.tabId : '');
  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent = formatTime(entry.ts) + (entry.sessionId ? ' · ' + entry.sessionId : '');
  node.append(status, main, meta);
  return node;
}

// ---------------------------------------------------------------------------
// 深度交互（第十批 E）：服务端分页 + 过滤/排序 + 时间线 + 虚拟列表 + 键盘 + aria。
// 既有 SELFTEST 契约与清空/刷新行为保持不变。
// ---------------------------------------------------------------------------
const t = labeler(getLang());
const rpc = createRpc((message) => chrome.runtime.sendMessage(message));
const auditState = createStateMachine();
const auditRoving = createRovingModel({ total: 0, wrap: true });
const auditVirtual = createVirtualModel({ rowHeight: 34 });
const auditSelection = createSelection({ limit: 200 });
const PAGE_SIZE = 50;
const ROW_HEIGHT = 34;
let auditPage = 1;
let auditTotal = 0;
let auditEntries = [];
let auditViewEntries = [];
let auditIntegrity = null;
let auditQuery = '';
let auditSort = { key: 'ts', direction: 'desc' };
let auditTimelineOn = false;
let scrollHandlerBound = false;

function showState(kind, error, retry) {
  const model = stateModel(kind, { lang: getLang(), error });
  const empty = $('empty');
  if (!empty) return;
  if (kind === 'ready' || kind === 'idle') {
    empty.hidden = true;
    return;
  }
  empty.hidden = false;
  const action = kind === 'error' && retry
    ? createButton({ doc: document, label: model.retryText || t('state.retry'), variant: 'primary', size: 'sm', onClick: retry })
    : null;
  mount(empty, createEmptyState({ doc: document, title: model.text, action, className: kind }));
}

function ensureTools() {
  const tools = $('auditTools');
  if (!tools || tools.dataset.ready) return;
  tools.dataset.ready = '1';
  const search = document.createElement('input');
  search.type = 'search';
  search.id = 'auditFilter';
  search.setAttribute('aria-label', t('list.filterHint'));
  search.placeholder = t('list.filterHint');
  search.addEventListener('input', () => {
    auditQuery = search.value;
    auditPage = 1;
    auditState.set('loading');
    applyView();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { search.value = ''; auditQuery = ''; applyView(); }
  });
  const sortSelect = document.createElement('select');
  sortSelect.className = 'inline-input';
  sortSelect.setAttribute('aria-label', t('list.sort'));
  for (const [value, label] of [['ts', t('list.sortTime')], ['durationMs', t('list.sortDuration')], ['status', t('list.sortStatus')]]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    sortSelect.appendChild(option);
  }
  sortSelect.value = auditSort.key;
  sortSelect.addEventListener('change', () => {
    auditSort = { key: sortSelect.value, direction: auditSort.direction };
    applyView();
  });
  const direction = document.createElement('button');
  direction.type = 'button';
  direction.className = 'btn';
  direction.id = 'auditDirection';
  direction.textContent = auditSort.direction === 'asc' ? t('list.sortAsc') : t('list.sortDesc');
  direction.setAttribute('aria-label', t('list.sort') + ' ' + (auditSort.direction === 'asc' ? t('list.sortAsc') : t('list.sortDesc')));
  direction.addEventListener('click', () => {
    auditSort = { key: auditSort.key, direction: auditSort.direction === 'asc' ? 'desc' : 'asc' };
    direction.textContent = auditSort.direction === 'asc' ? t('list.sortAsc') : t('list.sortDesc');
    applyView();
  });
  const timeline = document.createElement('button');
  timeline.type = 'button';
  timeline.className = 'btn';
  timeline.id = 'auditTimelineToggle';
  timeline.textContent = t('timeline.title');
  timeline.setAttribute('aria-pressed', 'false');
  timeline.addEventListener('click', () => {
    auditTimelineOn = !auditTimelineOn;
    timeline.setAttribute('aria-pressed', auditTimelineOn ? 'true' : 'false');
    renderTimeline();
  });
  const selectAll = document.createElement('button');
  selectAll.type = 'button';
  selectAll.className = 'btn';
  selectAll.textContent = t('audit.selectNone');
  selectAll.setAttribute('aria-label', t('audit.selectNone'));
  selectAll.addEventListener('click', () => {
    auditSelection.clear();
    refreshSelectionStyles();
    setText($('auditDetail'), '');
    $('auditDetail').hidden = true;
  });
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn';
  copy.textContent = t('audit.copySelected');
  copy.setAttribute('aria-label', t('audit.copySelected'));
  copy.addEventListener('click', () => { void copySelected(); });
  tools.append(search, sortSelect, direction, timeline, selectAll, copy);
}

function filteredSorted() {
  return buildTableModel(auditEntries.map((entry) => ({ ...entry, ts: Number(entry.ts) || 0, durationMs: Number(entry.durationMs) || 0 })), {
    columns: [
      { key: 'ts', numeric: true, sortable: true },
      { key: 'method', sortable: true },
      { key: 'durationMs', numeric: true, sortable: true },
      { key: 'url', sortable: true },
    ],
    query: auditQuery,
    sort: auditSort,
    page: 1,
    pageSize: Math.max(1, auditEntries.length || 1),
    predicate: (entry, needle) => (String(entry.method || '') + ' ' + String(entry.url || '') + ' ' + String(entry.status || '') + ' ' + String(entry.sessionId || '')).toLowerCase().includes(needle),
  });
}

function auditRowNode(entry, index, total) {
  const key = entryKey(entry, index);
  const node = document.createElement('div');
  node.className = 'list-row virtual-row';
  node.setAttribute('role', 'listitem');
  node.setAttribute('data-ts', String(entry.ts || ''));
  node.setAttribute('data-key', key);
  node.setAttribute('aria-selected', auditSelection.isSelected(key) ? 'true' : 'false');
  node.setAttribute('aria-label', [
    entry.method || 'call',
    entry.ok === false ? String(entry.code || 'fail') : t('state.ready'),
    entry.durationMs != null ? formatDuration(entry.durationMs) : '',
    String(entry.url || ''),
    formatTime(entry.ts),
  ].filter(Boolean).join(' · '));
  const status = document.createElement('span');
  status.className = 'status-pill ' + (entry.ok === false ? 'danger' : 'ok');
  status.textContent = entry.ok === false ? String(entry.code || 'fail') : 'OK';
  const main = document.createElement('span');
  main.className = 'grow truncate mono';
  main.textContent = String(entry.method || 'call') + (entry.tabId != null ? '  tab ' + entry.tabId : '') + (entry.durationMs != null ? '  ' + formatDuration(entry.durationMs) : '');
  const url = document.createElement('span');
  url.className = 'muted mono truncate';
  url.textContent = truncateMiddle(String(entry.url || ''), 60);
  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent = formatTime(entry.ts);
  node.append(status, main, url, meta);
  node.tabIndex = auditRoving.tabIndexAt(index);
  node.addEventListener('click', (event) => {
    const key = entryKey(entry, index);
    if (event && event.shiftKey) auditSelection.shiftClick(key);
    else if (event && (event.ctrlKey || event.metaKey)) auditSelection.click(key);
    else auditSelection.setAnchor(key);
    refreshSelectionStyles();
    selectEntry(entry, index);
  });
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectEntry(entry, index);
    } else if ((event.key === 's' || event.key === 'S') && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const key = entryKey(entry, index);
      if (auditSelection.isSelected(key)) auditSelection.remove(key);
      else auditSelection.click(key);
      refreshSelectionStyles();
    }
  });
  return node;
}

function refreshSelectionStyles() {
  const container = $('list');
  if (!container) return;
  for (const rowNode of container.querySelectorAll('[role="listitem"][data-key]')) {
    const on = auditSelection.isSelected(rowNode.getAttribute('data-key'));
    rowNode.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  const summary = $('auditSummary');
  if (summary) {
    const count = auditSelection.size;
    if (count > 0) setText(summary, t('list.selected', { count }));
    else renderSummary();
  }
}

async function copySelected() {
  const ordered = auditSelection.ordered();
  const picked = auditViewEntries.filter((entry, index) => auditSelection.isSelected(entryKey(entry, index)));
  if (!picked.length) { note(t('compare.needTwo'), true); return; }
  try {
    await navigator.clipboard.writeText(JSON.stringify(picked, null, 2));
    note('JSON ✓ · ' + ordered.length);
  } catch {
    note(t('state.error'), true);
  }
}

function entryKey(entry, index) {
  const base = entry && (entry.id ?? entry.seq ?? entry.ts);
  return String(base === undefined || base === null ? index : base);
}

function renderVirtualList() {
  const container = $('list');
  if (!container) return;
  container.setAttribute('role', 'list');
  container.setAttribute('aria-label', t('a11y.list', { count: auditViewEntries.length }));
  container.classList.add('list-box');
  container.style.setProperty('max-block-size', '380px');
  container.style.setProperty('overflow-y', 'auto');
  auditRoving.setTotal(auditViewEntries.length);
  auditVirtual.setTotal(auditViewEntries.length);
  auditVirtual.setViewport(container.clientHeight || 380);
  auditVirtual.setScroll(container.scrollTop || 0);
  const window = auditVirtual.window();
  container.textContent = '';
  const spacer = document.createElement('div');
  spacer.className = 'list-spacer';
  spacer.style.setProperty('block-size', String(auditVirtual.totalHeight()) + 'px');
  spacer.style.setProperty('position', 'relative');
  for (let index = window.start; index < window.end; index += 1) {
    const node = auditRowNode(auditViewEntries[index], index, auditViewEntries.length);
    node.style.setProperty('position', 'absolute');
    node.style.setProperty('inset-block-start', String(auditVirtual.offsetOf(index)) + 'px');
    node.style.setProperty('inset-inline', '0');
    spacer.appendChild(node);
  }
  container.appendChild(spacer);
  if (!scrollHandlerBound) {
    scrollHandlerBound = true;
    container.addEventListener('scroll', () => { renderVirtualList(); }, { passive: true });
  }
}

function renderPager() {
  const node = $('auditPager');
  if (!node) return;
  const paging = buildPagingModel({ page: auditPage, total: auditTotal, pageSize: PAGE_SIZE });
  const make = (label, target, disabled) => button({
    label,
    disabled,
    on: disabled ? null : { click: () => { auditPage = target; void load(target); } },
  });
  mount(node, h('div', { class: 'toolbar', role: 'group', 'aria-label': t('paging.summary', { page: paging.page, pages: Math.max(1, paging.pages), total: paging.total }) }, [
    make(t('paging.previous'), Math.max(1, paging.page - 1), !paging.hasPrev),
    h('span', { class: 'muted' }, paging.range),
    make(t('paging.next'), Math.min(Math.max(1, paging.pages), paging.page + 1), !paging.hasNext),
  ]));
}

function renderSummary() {
  const node = $('auditSummary');
  if (!node) return;
  const parts = [t('paging.total', { total: auditTotal }), auditQuery ? t('list.filter') + ' ' + auditViewEntries.length : ''];
  if (auditIntegrity && Number.isFinite(Number(auditIntegrity.score))) parts.push(t('audit.integrity') + ' ' + Number(auditIntegrity.score));
  if (auditIntegrity && Number(auditIntegrity.issues) > 0) parts.push(t('audit.integrity') + ' · ' + Number(auditIntegrity.issues));
  setText(node, parts.filter(Boolean).join(' · '));
}

function renderTimeline() {
  const node = $('auditTimeline');
  if (!node) return;
  if (!auditTimelineOn) { node.hidden = true; return; }
  const spans = auditViewEntries.map((entry, index) => ({
    id: String(index),
    label: String(entry.method || 'call') + ' ' + truncateMiddle(String(entry.url || ''), 60),
    start: Number(entry.ts) || index,
    end: (Number(entry.ts) || index) + Math.max(1, Number(entry.durationMs) || 0),
  }));
  const view = buildTimelineView({ spans, width: Math.max(240, node.clientWidth || 480), lang: getLang(), title: t('audit.timeline') });
  mount(node, view.tree);
  node.hidden = view.empty;
}

function applyView() {
  const model = filteredSorted();
  auditViewEntries = model.rows;
  const visibleKeys = auditViewEntries.map((entry, index) => entryKey(entry, index));
  auditSelection.prune(visibleKeys);
  auditSelection.setOrder(visibleKeys);
  renderVirtualList();
  renderPager();
  renderSummary();
  renderTimeline();
  showState(model.matching ? 'ready' : 'empty', null, () => void load(auditPage));
  if (!model.matching && auditEntries.length) {
    const empty = $('empty');
    if (empty) {
      empty.hidden = false;
      mount(empty, h('div', { class: 'state-block empty', role: 'status', 'aria-live': 'polite' }, t('list.filterNone')));
    }
  }
  auditState.set(model.matching ? 'ready' : 'empty');
}

function selectEntry(entry, index) {
  auditRoving.moveTo(index);
  const node = $('auditDetail');
  if (!node) return;
  node.hidden = false;
  const rows = [
    ['method', entry.method],
    ['time', formatTimestamp(entry.ts)],
    ['ok', entry.ok === false ? false : true],
    ['code', entry.code],
    ['durationMs', formatDuration(entry.durationMs)],
    ['tabId', entry.tabId],
    ['sessionId', entry.sessionId],
    ['url', entry.url],
    ['detail', formatValue(entry.detail, 120)],
  ];
  mount(node, h('div', { class: 'detail-panel', role: 'group', 'aria-label': String(entry.method || '') }, [
    h('div', { class: 'kv-list' }, rows.map(([key, value]) => h('div', { class: 'kv' }, [
      h('span', { class: 'muted' }, key),
      h('span', { class: 'mono grow truncate' }, String(value === undefined || value === null || value === '' ? '—' : value)),
    ]))),
    h('div', { class: 'toolbar' }, [
      button({
        label: 'JSON',
        on: {
          click: async () => {
            try {
              await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
              note('JSON ✓');
            } catch {
              note(t('state.error'), true);
            }
          },
        },
      }),
      button({ label: t('close'), on: { click: () => { node.hidden = true; } } }),
    ]),
  ]));
  announce(t('a11y.announced', { label: String(entry.method || 'call') }));
}

async function load(page = auditPage) {
  auditPage = Math.max(1, Math.floor(Number(page) || 1));
  const list = $('list');
  if (list) list.setAttribute('aria-busy', 'true');
  auditState.loading();
  showState('loading');
  const since = Date.now() - Number($('range').value);
  const result = await rpc.send('bb.audit.list', {
    since,
    limit: PAGE_SIZE,
    offset: (auditPage - 1) * PAGE_SIZE,
    integrity: true,
  });
  if (list) list.removeAttribute('aria-busy');
  if (!result.ok) {
    auditState.fail(result.error);
    showState('error', result.error, () => void load(auditPage));
    noteError(result.error);
    return;
  }
  const payload = result.result || {};
  auditEntries = Array.isArray(payload.entries) ? payload.entries : [];
  auditTotal = Number(payload.total) || auditEntries.length;
  auditIntegrity = payload.integrity || null;
  if (!auditTotal && !auditEntries.length) {
    auditViewEntries = [];
    renderVirtualList();
    renderPager();
    renderSummary();
    renderTimeline();
    const empty = $('empty');
    if (empty) {
      empty.hidden = false;
      mount(empty, h('div', { class: 'state-block empty', role: 'status', 'aria-live': 'polite' }, '还没有任务记录。后续通过 BridgeDeck 执行的操作会显示在这里。'));
    }
    auditState.empty();
    encodeStateToUrl();
    return;
  }
  // 保留原有「共 N 条，显示最近 M 条」的摘要文案（动态文案 catalog 的锚点）。
  $('empty').textContent = '共 ' + (payload.total || auditEntries.length) + ' 条，显示最近 ' + auditEntries.length + ' 条';
  applyView();
  encodeStateToUrl();
}

function encodeStateToUrl() {
  try {
    const query = encodeViewState('list', { query: auditQuery, sort: auditSort.key, direction: auditSort.direction, page: auditPage });
    history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
  } catch { /* 忽略 */ }
}

$('back').addEventListener('click', () => { if (history.length > 1) history.back(); else window.close(); });
$('openFolder').addEventListener('click', async () => {
  const labels = dialogText(getLang());
  const dialog = openDialog({
    title: labels.clearAuditTitle,
    body: labels.clearAuditBody,
    confirmLabel: labels.clearAuditConfirm,
    lang: getLang(),
    tone: 'danger',
  });
  const outcome = await dialog.result;
  if (!outcome.confirmed) return;
  const result = await rpc.send('bb.audit.clear', {});
  if (!result || result.ok === false) return noteError(result && result.error);
  note(translate('已清空本机任务审计记录'));
  await load(1);
});
$('refresh').addEventListener('click', () => { void load(auditPage); });
$('range').addEventListener('change', () => { auditPage = 1; void load(1); });

// 键盘可达：/ 聚焦过滤，PgUp/PgDn 翻页，Esc 关闭详情。
document.addEventListener('keydown', (event) => {
  const intent = resolveEvent(event, { target: event.target });
  if (!intent.handled) return;
  if (intent.intent === 'open-filter') {
    event.preventDefault();
    $('auditFilter') && $('auditFilter').focus();
  } else if (intent.intent === 'page-up' || intent.intent === 'page-down') {
    event.preventDefault();
    const pages = Math.max(1, Math.ceil(auditTotal / PAGE_SIZE));
    auditPage = Math.min(pages, Math.max(1, auditPage + (intent.intent === 'page-down' ? 1 : -1)));
    void load(auditPage);
  } else if (intent.intent === 'up' || intent.intent === 'down' || intent.intent === 'home' || intent.intent === 'end') {
    if (!auditViewEntries.length) return;
    event.preventDefault();
    const current = auditRoving.activeIndex;
    let next = intent.intent === 'home' ? 0 : intent.intent === 'end' ? auditViewEntries.length - 1 : current + (intent.intent === 'up' ? -1 : 1);
    next = Math.max(0, Math.min(auditViewEntries.length - 1, next));
    auditRoving.moveTo(next);
    const container = $('list');
    const rows = container ? [...container.querySelectorAll('[role="row"], .list-row')] : [];
    for (const rowNode of rows) rowNode.tabIndex = -1;
    const target = rows[next];
    if (target) { target.tabIndex = 0; target.focus({ preventScroll: false }); }
  } else if (intent.intent === 'close') {
    const detail = $('auditDetail');
    if (detail && !detail.hidden) { event.preventDefault(); detail.hidden = true; }
  }
});

const initialAuditState = decodeViewState('list', location.search);
if (initialAuditState.query) auditQuery = initialAuditState.query;
if (initialAuditState.sort) auditSort = { key: initialAuditState.sort, direction: initialAuditState.direction };
if (Number(initialAuditState.page) > 1) auditPage = Number(initialAuditState.page);

ensureTools();
load(auditPage);

// ?selftest=1：读一次审计列表，结果写进标题
if (new URLSearchParams(location.search).get('selftest') === '1') {
  (async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'bb.audit.list', since: 0, limit: 10 });
      if (!result || result.ok === false) throw new Error((result && result.error) || 'audit failed');
      document.title = 'SELFTEST:ok:audit:' + ((result.entries || []).length);
    } catch (error) {
      document.title = 'SELFTEST:fail:' + ((error && error.message) || error);
    }
  })();
}

// 第十一批 F：页面导出 / 导入校验工具（只增强；不改上面的 SELFTEST 契约与列表渲染）。
installPageTools({
  surface: 'audit',
  toolsId: 'auditTools',
  listId: 'list',
  lang: () => getLang(),
  rows: () => auditViewEntries,
});
