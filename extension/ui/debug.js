// ui/debug.js —— 网站调试页
import { back, fillTabSelect, preferredTabFromQuery, selectedTabId } from './tab-picker.js';

import { $ } from './common.js';
import { getLang } from './i18n.js';
import { installPageTools } from './lib/page-tools.js';
import { announce } from './a11y-dialog.js';
import { labeler } from './lib/labels.js';
import { createRpc } from './lib/rpc.js';
import { mount, setHidden, setText } from './lib/dom.js';
import { h, button, text } from './lib/render.js';
import { createStateMachine, stateModel } from './lib/states.js';
import { buildTableModel } from './lib/table.js';
import { createRovingModel } from './lib/focus.js';
import { resolveEvent } from './lib/keyboard.js';
import { decodeViewState, encodeViewState, applyViewStateToHref, encodeSort, decodeSort } from './lib/view-state.js';
import { formatDuration, formatTimestamp, formatHttpStatus, formatValue, truncateMiddle } from './lib/format.js';
import { buildTimelineView } from './views/timeline-view.js';
import { buildCaptureCompareView, buildComparePicker } from './views/compare-view.js';

// ---- 首屏信息收敛：把“性能指标 / 请求规则”折叠进 <details>，空态用 bd-empty 卡片 ----
function foldAdvancedPanels() {
  const FOLD_TITLES = ['性能指标', '请求规则'];
  for (const section of [...document.querySelectorAll('section.panel')]) {
    const heading = section.querySelector('h2');
    if (!heading) continue;
    const title = (heading.textContent || '').trim().split(/\s/)[0];
    if (!FOLD_TITLES.some((item) => title.startsWith(item))) continue;
    const details = document.createElement('details');
    details.className = 'panel bd-fold';
    details.open = false;
    const summary = document.createElement('summary');
    summary.className = 'panel-head';
    summary.appendChild(heading);
    details.appendChild(summary);
    while (section.firstChild) details.appendChild(section.firstChild);
    section.replaceWith(details);
  }
  for (const id of ['perfEmpty', 'rulesEmpty', 'reqEmpty', 'conEmpty', 'historyEmpty', 'opsEmpty']) {
    const node = document.getElementById(id);
    if (node) node.classList.add('bd-empty');
  }
}
foldAdvancedPanels();


let activeTabId = null;
let pollTimer = null;
let lastLive = null;
let detailRecord = null;

function note(text, isError) {
  const node = $('note');
  node.textContent = text || '';
  node.className = 'note' + (isError ? ' err' : '');
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({ ok: false, error: String((error && error.message) || error) }));
}

function formatTime(ts) {
  const date = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function row(cells, className) {
  const node = document.createElement('div');
  node.className = 'list-row ' + (className || '');
  for (const cell of cells) {
    const span = document.createElement('span');
    if (cell.grow) span.className = 'grow truncate';
    if (cell.mono) span.className = (span.className ? span.className + ' ' : '') + 'mono';
    if (cell.cls) span.className = (span.className ? span.className + ' ' : '') + cell.cls;
    span.textContent = cell.text;
    node.appendChild(span);
  }
  return node;
}

async function replayRequest(id) {
  const tabId = activeTabId != null ? activeTabId : selectedTabId($('tabSelect'));
  if (!tabId) return note('先选一个目标标签页', true);
  const reply = await send({ type: 'bb.debug.replay', tabId, id });
  if (!reply || !reply.ok) return note((reply && (reply.error || reply.message)) || '重放失败', true);
  note('重放完成：HTTP ' + (reply.status != null ? reply.status : '?') + ' ' + (reply.url || ''));
}

function renderLive(data) {
  lastLive = data;
  $('livePanel').hidden = false;
  $('reqCount').textContent = '(' + data.requests.length + ')';
  $('reqEmpty').hidden = data.requests.length > 0;
  const requests = $('requests');
  requests.textContent = '';
  for (const entry of data.requests.slice(-50).reverse()) {
    const line = row([
      { text: entry.method || '', mono: true },
      { text: String(entry.status || '') , cls: entry.error ? 'muted' : '' },
      { text: entry.durationMs != null ? entry.durationMs + 'ms' : '', cls: 'muted' },
      { text: entry.url || '', grow: true, mono: true },
    ]);
    if (entry.id != null) {
      const replay = document.createElement('button');
      replay.className = 'btn';
      replay.textContent = '重放';
      replay.addEventListener('click', () => replayRequest(entry.id));
      line.appendChild(replay);
    }
    requests.appendChild(line);
  }

  $('conCount').textContent = '(' + data.console.length + ')';
  $('conEmpty').hidden = data.console.length > 0;
  const conList = $('consoleList');
  conList.textContent = '';
  for (const entry of data.console.slice(-50)) {
    conList.appendChild(row([
      { text: entry.level || 'log', cls: entry.level === 'error' ? 'mono' : 'muted' },
      { text: String(entry.text || '').slice(0, 300), grow: true, mono: true },
    ]));
  }

  const context = data.context || {};
  $('context').textContent = '';
  for (const [key, value] of Object.entries(context)) {
    const span = document.createElement('span');
    span.textContent = key + ': ' + value;
    $('context').appendChild(span);
  }
}

async function refreshLive() {
  if (activeTabId == null) return;
  const result = await send({ type: 'bb.debug.current', tabId: activeTabId });
  if (!result || !result.ok) return;
  renderLive(result.result || result);
  $('status').textContent = '收集中 · ' + ((result.result && result.result.requests) || result.requests || []).length + ' 请求';
  $('status').className = 'status-pill on';
}

function renderHistory(list) {
  const node = $('history');
  node.textContent = '';
  $('historyEmpty').hidden = list.length > 0;
  for (const item of list) {
    const line = document.createElement('div');
    line.className = 'list-row';
    const title = document.createElement('span');
    title.className = 'grow truncate';
    title.textContent = (item.title || item.url || '调试记录') + ' · ' + item.requests + ' 请求 / ' + item.console + ' 条输出';
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = formatTime(item.startedAt);
    const view = document.createElement('button');
    view.className = 'btn';
    view.textContent = '查看';
    view.addEventListener('click', () => showDetail(item.id));
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      await send({ type: 'bb.debug.delete', id: item.id });
      await loadHistory();
    });
    line.append(title, meta, view, del);
    node.appendChild(line);
  }
}

async function loadOperations() {
  // 真实 RPC：operations.list 是 daemon 方法，必须经后台的 bb.daemon.call 转发；
  // 之前的 'bb.call' 在后台没有处理分支（静默返回空），这里修正为真实链路。
  const reply = await rpc.daemon('operations.list', { limit: 30 });
  const list = (reply && reply.ok && Array.isArray(reply.result && reply.result.entries) ? reply.result.entries : []) || [];
  const node = $('operations');
  if (!node) return;
  node.textContent = '';
  $('opsEmpty').hidden = list.length > 0;
  for (const item of list) {
    const line = row([
      { text: formatTime(item.ts), cls: 'muted' },
      { text: item.method || '', mono: true },
      { text: item.ok === false ? (item.code || 'fail') : (item.durationMs != null ? item.durationMs + 'ms' : 'ok'), cls: item.ok === false ? 'mono' : 'muted' },
      { text: item.url || '', grow: true, mono: true },
    ]);
    node.appendChild(line);
  }
  operationsState.set(list.length ? 'ready' : 'empty');
  operationsCache = list;
}

function currentRuleTab() {
  return activeTabId != null ? activeTabId : selectedTabId($('tabSelect'));
}

async function loadRules() {
  const tabId = currentRuleTab();
  const node = $('rules');
  if (!node) return;
  if (!tabId) {
    node.textContent = '';
    $('rulesEmpty').textContent = '先选一个目标标签页';
    $('rulesEmpty').hidden = false;
    return;
  }
  const reply = await send({ type: 'bb.debug.rule_list', tabId });
  const rules = (reply && reply.ok && (reply.rules || (reply.result && reply.result.rules))) || [];
  node.textContent = '';
  $('rulesEmpty').textContent = '当前标签页没有规则';
  $('rulesEmpty').hidden = rules.length > 0;
  for (const item of rules) {
    node.appendChild(row([
      { text: '#' + item.id, cls: 'muted' },
      { text: item.action || '', mono: true },
      { text: item.urlPattern || '', grow: true, mono: true },
      { text: 'hits=' + (item.hits || 0), cls: 'muted' },
    ]));
  }
}

async function addRule() {
  const tabId = currentRuleTab();
  if (!tabId) return note('先选一个目标标签页', true);
  const pattern = String($('rulePattern').value || '').trim();
  if (!pattern) return note('先填 URL pattern', true);
  const action = String($('ruleAction').value || 'fulfill');
  const rule = { urlPattern: pattern, action };
  if (action === 'fulfill') {
    rule.status = Number($('ruleStatus').value) || 200;
    rule.body = String($('ruleText').value || '');
  }
  const reply = await send({ type: 'bb.debug.rule_add', tabId, rule });
  if (!reply || !reply.ok) return note((reply && (reply.error || reply.message)) || '添加规则失败', true);
  note('已添加规则');
  await loadRules();
}

async function clearRules() {
  const tabId = currentRuleTab();
  if (!tabId) return note('先选一个目标标签页', true);
  const reply = await send({ type: 'bb.debug.rule_clear', tabId });
  if (!reply || !reply.ok) return note((reply && (reply.error || reply.message)) || '清空规则失败', true);
  note('已清空规则');
  await loadRules();
}

async function loadPerf() {
  const tabId = currentRuleTab();
  const node = $('perf');
  if (!node) return;
  if (!tabId) {
    $('perfEmpty').hidden = false;
    return;
  }
  const reply = await send({ type: 'bb.debug.performance', tabId });
  if (!reply || !reply.ok) return;
  const metrics = reply.metrics || (reply.result && reply.result.metrics) || {};
  node.textContent = '';
  const entries = Object.entries(metrics);
  $('perfEmpty').hidden = entries.length > 0;
  $('perfEmpty').textContent = entries.length ? '' : '没有性能数据';
  for (const [key, value] of entries) {
    const span = document.createElement('span');
    span.textContent = key + ': ' + (value == null ? '—' : value);
    node.appendChild(span);
  }
}

async function loadHistory() {
  const result = await send({ type: 'bb.debug.history' });
  const list = (result && (result.history || (result.result && result.result.history))) || [];
  historyCache = list;
  renderHistory(list);
}

async function showDetail(id) {
  const result = await send({ type: 'bb.debug.history.detail', id });
  if (!result || !result.ok) return note((result && result.error) || '读取失败', true);
  detailRecord = result.record || (result.result && result.result.record);
  $('detailPanel').hidden = false;
  $('detailMeta').textContent = '';
  for (const [key, value] of Object.entries({
    url: detailRecord.url,
    title: detailRecord.title,
    startedAt: formatTime(detailRecord.startedAt),
    endedAt: formatTime(detailRecord.endedAt),
  })) {
    const span = document.createElement('span');
    span.textContent = key + ': ' + (value || '');
    $('detailMeta').appendChild(span);
  }
  const body = $('detailBody');
  body.textContent = '';
  for (const entry of (detailRecord.requests || []).slice(0, 100)) {
    body.appendChild(row([
      { text: (entry.method || '') + ' ' + (entry.status || ''), mono: true },
      { text: (entry.durationMs != null ? entry.durationMs + 'ms' : ''), cls: 'muted' },
      { text: entry.url || '', grow: true, mono: true },
    ]));
  }
  for (const entry of (detailRecord.console || []).slice(0, 100)) {
    body.appendChild(row([
      { text: entry.level || 'log', cls: entry.level === 'error' ? 'mono' : 'muted' },
      { text: String(entry.text || '').slice(0, 300), grow: true, mono: true },
    ]));
  }
}

function downloadJson(data, name) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('back').addEventListener('click', () => back());
$('refresh').addEventListener('click', () => loadHistory());
$('refreshOps').addEventListener('click', () => loadOperations());
$('refreshRules').addEventListener('click', () => loadRules());
$('refreshPerf').addEventListener('click', () => loadPerf());
$('addRule').addEventListener('click', () => addRule());
$('clearRules').addEventListener('click', () => clearRules());
$('closeDetail').addEventListener('click', () => { $('detailPanel').hidden = true; });
$('exportLive').addEventListener('click', () => {
  if (!lastLive) return;
  downloadJson(lastLive, 'debug-live.json');
});
$('exportDetail').addEventListener('click', () => {
  if (!detailRecord) return;
  downloadJson(detailRecord, 'debug-' + detailRecord.id.slice(0, 8) + '.json');
});

$('start').addEventListener('click', async () => {
  const tabId = selectedTabId($('tabSelect'));
  if (!tabId) return note('先选一个目标标签页', true);
  const result = await send({ type: 'bb.debug.start', tabId });
  if (!result || !result.ok) return note((result && result.error) || '开始采集失败', true);
  activeTabId = tabId;
  $('start').disabled = true;
  $('stop').disabled = false;
  note('已开始采集：正常操作页面，采集会持续记录');
  if (!pollTimer) pollTimer = setInterval(refreshLive, 2000);
  await refreshLive();
});

$('stop').addEventListener('click', async () => {
  const tabId = activeTabId != null ? activeTabId : selectedTabId($('tabSelect'));
  const result = await send({ type: 'bb.debug.stop', tabId });
  if (!result || !result.ok) return note((result && result.error) || '停止采集失败', true);
  activeTabId = null;
  $('start').disabled = false;
  $('stop').disabled = true;
  $('status').textContent = '已停止';
  $('status').className = 'muted';
  note('已保存：' + result.requests + ' 请求 / ' + result.console + ' 条输出');
  await loadHistory();
});

fillTabSelect($('tabSelect'), preferredTabFromQuery()).then(() => {
  loadHistory();
  loadOperations();
  loadRules();
  loadPerf();
});

// ?selftest=1：真实采集一次，结果写进标题
if (new URLSearchParams(location.search).get('selftest') === '1') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      const started = await send({ type: 'bb.debug.start', tabId });
      if (!started || !started.ok) throw new Error((started && started.error) || 'start failed');
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: () => {
            const button = document.getElementById('ping-btn');
            if (button) button.click();
          },
        });
      } catch {
        // 页面没有该按钮时忽略
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const stopped = await send({ type: 'bb.debug.stop', tabId });
      if (!stopped || !stopped.ok) throw new Error((stopped && stopped.error) || 'stop failed');
      document.title = 'SELFTEST:ok:debug:' + stopped.requests + ':' + stopped.console;
    } catch (error) {
      document.title = 'SELFTEST:fail:' + ((error && error.message) || error);
    }
  })();
}

// ?selftest=replay：采集 /api/ping 后重放一条请求
if (new URLSearchParams(location.search).get('selftest') === 'replay') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      if (!tabId) throw new Error('no tab selected');
      const started = await send({ type: 'bb.debug.start', tabId });
      if (!started || !started.ok) throw new Error((started && started.error) || 'start failed');
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: () => {
            const button = document.getElementById('ping-btn');
            if (button) button.click();
          },
        });
      } catch {
        // 页面没有该按钮时忽略
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const current = await send({ type: 'bb.debug.current', tabId });
      const requests = (current && current.requests) || (current && current.result && current.result.requests) || [];
      const target = requests.find((item) => String(item.url || '').includes('/api/ping')) || requests[0];
      if (!target || target.id == null) throw new Error('no request to replay');
      const replayed = await send({ type: 'bb.debug.replay', tabId, id: target.id });
      if (!replayed || !replayed.ok) {
        throw new Error('replay failed ' + JSON.stringify({
          error: replayed && replayed.error,
          id: target.id,
          url: target.url,
          method: target.method,
          currentOk: current && current.ok,
        }).slice(0, 300));
      }
      await send({ type: 'bb.debug.stop', tabId });
      document.title = 'SELFTEST:ok:replay:' + (replayed.status != null ? replayed.status : '?');
    } catch (error) {
      document.title = 'SELFTEST:fail:replay:' + ((error && error.message) || error);
    }
  })();
}
// ?selftest=perf：读取性能指标并写进标题
if (new URLSearchParams(location.search).get('selftest') === 'perf') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      if (!tabId) throw new Error('no tab selected');
      const reply = await send({ type: 'bb.debug.performance', tabId });
      if (!reply || !reply.ok) throw new Error((reply && (reply.error || reply.message)) || 'performance failed');
      const metrics = reply.metrics || (reply.result && reply.result.metrics) || {};
      document.title = 'SELFTEST:ok:perf:' + Object.keys(metrics).length;
    } catch (error) {
      document.title = 'SELFTEST:fail:perf:' + ((error && error.message) || error);
    }
  })();
}
// ?selftest=rules：规则添加 → 列出 → 清空，结果写进标题
if (new URLSearchParams(location.search).get('selftest') === 'rules') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      if (!tabId) throw new Error('no tab selected');
      const added = await send({
        type: 'bb.debug.rule_add',
        tabId,
        rule: { urlPattern: '*/__selftest_rule__*', action: 'block' },
      });
      if (!added || !added.ok) throw new Error((added && (added.error || added.message)) || 'rule_add failed');
      const listed = await send({ type: 'bb.debug.rule_list', tabId });
      const rules = (listed && (listed.rules || (listed.result && listed.result.rules))) || [];
      const cleared = await send({ type: 'bb.debug.rule_clear', tabId });
      if (!cleared || !cleared.ok) throw new Error((cleared && (cleared.error || cleared.message)) || 'rule_clear failed');
      document.title = 'SELFTEST:ok:rules:' + rules.length;
    } catch (error) {
      document.title = 'SELFTEST:fail:rules:' + ((error && error.message) || error);
    }
  })();
}

// ---------------------------------------------------------------------------
// 页面深度交互（第十批 E）：真实 RPC / 加载-错误-空态 / 键盘可达 / aria。
// 说明：以下代码只增强，不改动上面的 SELFTEST 契约与既有渲染行为。
// ---------------------------------------------------------------------------
const t = labeler(getLang());
const rpc = createRpc((message) => chrome.runtime.sendMessage(message));
const historyState = createStateMachine();
const detailState = createStateMachine();
const operationsState = createStateMachine();
const perfState = createStateMachine();
const rulesState = createStateMachine();
const historyRoving = createRovingModel({ total: 0, wrap: true });
let historyCache = [];
let operationsCache = [];
let historyFilter = '';
let historySort = { key: 'startedAt', direction: 'desc' };
let detailFilter = 'all';
let detailSpansCache = [];
let compareBaseId = '';
let compareOtherId = '';
const initialView = decodeViewState('list', location.search);
if (initialView.query) historyFilter = initialView.query;
if (initialView.sort) historySort = decodeSort(encodeSort({ key: initialView.sort, direction: initialView.direction }));

function persistViewState() {
  try {
    history.replaceState(null, '', applyViewStateToHref('list', location.href, {
      query: historyFilter,
      sort: encodeSort(historySort).split(':')[0] || '',
      direction: historySort.direction,
    }));
  } catch { /* file:// 或受限上下文忽略 */ }
}

function ariaList(node, label) {
  if (!node) return;
  node.setAttribute('role', 'list');
  node.setAttribute('aria-label', label);
  node.setAttribute('aria-live', 'polite');
}

function statusPill(text, tone) {
  return h('span', { class: 'status-pill ' + (tone || '') }, String(text));
}

function rowFromCells(cells) {
  const line = h('div', { class: 'list-row', role: 'listitem' });
  for (const cell of cells) line.children.push(h('span', { class: (cell.grow ? 'grow truncate ' : '') + (cell.mono ? 'mono ' : '') + (cell.cls || '') }, String(cell.text === undefined || cell.text === null ? '' : cell.text)));
  return line;
}

function describeState(kind, error) {
  const model = stateModel(kind, { lang: getLang(), error, detail: undefined });
  return model;
}

function stateNode(kind, { error, retryLabel, onRetry, emptyText } = {}) {
  const model = describeState(kind, error);
  const message = kind === 'empty' && emptyText ? emptyText : model.text;
  const node = h('div', { class: 'state-block ' + kind, role: 'status', 'aria-live': 'polite' }, message || '');
  if (kind === 'error' && typeof onRetry === 'function') {
    node.children.push(button({ label: retryLabel || model.retryText || t('state.retry'), on: { click: onRetry } }));
  }
  return node;
}

/* ---------- 历史记录：过滤 / 排序 / 键盘可达 / aria ---------- */
function ensureHistoryTools() {
  const panel = $('history') && $('history').closest('section');
  if (!panel || $('historyTools')) return;
  const tools = document.createElement('div');
  tools.id = 'historyTools';
  tools.className = 'filters';
  const search = document.createElement('input');
  search.type = 'search';
  search.id = 'historyFilter';
  search.value = historyFilter;
  search.setAttribute('aria-label', t('list.filterHint'));
  search.placeholder = t('list.filterHint');
  search.addEventListener('input', () => {
    historyFilter = search.value;
    persistViewState();
    applyHistoryView();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { search.value = ''; historyFilter = ''; applyHistoryView(); }
  });
  const sortSelect = document.createElement('select');
  sortSelect.id = 'historySort';
  sortSelect.className = 'inline-input';
  sortSelect.setAttribute('aria-label', t('list.sort'));
  for (const [value, label] of [['startedAt', t('list.sortTime')], ['requests', t('list.sort') + ' · ' + t('list.rows', { count: '#' })], ['durationMs', t('list.sortDuration')]]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    sortSelect.appendChild(option);
  }
  sortSelect.value = historySort.key;
  sortSelect.addEventListener('change', () => {
    historySort = { key: sortSelect.value, direction: historySort.direction };
    applyHistoryView();
  });
  tools.append(search, sortSelect);
  panel.insertBefore(tools, panel.querySelector('#history'));
}

function historyRowLabel(record) {
  return t('record.counts', { requests: record.requests || 0, console: record.console || 0 }) + ' · ' + formatTimestamp(record.startedAt);
}

function applyHistoryView() {
  const node = $('history');
  if (!node) return;
  const records = historyCache.slice();
  if (!records.length) {
    node.textContent = '';
    historyRoving.setTotal(0);
    return;
  }
  const model = buildTableModel(records.map((record) => ({
    ...record,
    ts: Number(record.startedAt) || 0,
    durationMs: Math.max(0, Number(record.endedAt || 0) - Number(record.startedAt || 0)),
    requests: Number(record.requests) || 0,
    label: String(record.title || record.url || '调试记录'),
    detail: historyRowLabel(record),
  })), {
    columns: [
      { key: 'ts', numeric: true, sortable: true, text: (row) => row.label },
      { key: 'requests', numeric: true, sortable: true, text: (row) => row.label },
      { key: 'durationMs', numeric: true, sortable: true, text: (row) => row.detail },
    ],
    query: historyFilter,
    sort: { key: historySort.key === 'startedAt' ? 'ts' : historySort.key, direction: historySort.direction },
    page: 1,
    pageSize: Math.max(1, records.length),
    predicate: (row, needle) => (String(row.label) + ' ' + String(row.url || '') + ' ' + String(row.detail)).toLowerCase().includes(needle),
  });
  node.textContent = '';
  $('historyEmpty').hidden = true;
  if (!model.matching) {
    mount(node, stateNode('empty', { emptyText: t('list.filterNone') }));
    historyRoving.setTotal(0);
    return;
  }
  for (const record of model.rows) {
    const line = document.createElement('div');
    line.className = 'list-row';
    line.setAttribute('role', 'listitem');
    line.setAttribute('data-id', String(record.id));
    line.setAttribute('aria-label', historyRowLabel(record));
    const title = document.createElement('span');
    title.className = 'grow truncate';
    title.textContent = (record.title || record.url || '调试记录') + ' · ' + record.requests + ' 请求 / ' + record.console + ' 条输出';
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = formatTime(record.startedAt) + ' · ' + formatDuration(Number(record.endedAt || 0) - Number(record.startedAt || 0));
    const view = document.createElement('button');
    view.className = 'btn';
    view.textContent = '查看';
    view.setAttribute('aria-label', '查看');
    view.addEventListener('click', () => showDetail(record.id));
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '删除';
    del.setAttribute('aria-label', '删除');
    del.addEventListener('click', async () => {
      await rpc.send('bb.debug.delete', { id: record.id });
      await loadHistory();
    });
    line.append(title, meta, view, del);
    node.appendChild(line);
  }
  historyRoving.setTotal(model.rows.length);
  historyRoving.moveTo(0);
  syncHistoryTabindex();
  if (!$('historySummary')) {
    const badge = document.createElement('div');
    badge.id = 'historySummary';
    badge.className = 'kv-inline muted';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    if (node.parentElement) node.parentElement.insertBefore(badge, node);
  }
  setText($('historySummary'), t('paging.total', { total: model.matching ? model.filtered : 0 }) + (historyFilter.trim() ? ' · ' + t('list.filter') + ' ' + model.filtered + '/' + model.total : ''));
}

function syncHistoryTabindex() {
  const node = $('history');
  if (!node) return;
  [...node.children].forEach((child, index) => {
    if (!child.classList || !child.classList.contains('list-row')) return;
    child.tabIndex = historyRoving.tabIndexAt(index);
  });
}

function focusHistoryRow(index) {
  const node = $('history');
  if (!node) return;
  const rows = [...node.children].filter((child) => child.classList && child.classList.contains('list-row'));
  const target = rows[Math.max(0, Math.min(rows.length - 1, index))];
  if (target) target.focus({ preventScroll: false });
}

function bindHistoryKeyboard() {
  const node = $('history');
  if (!node) return;
  node.addEventListener('keydown', (event) => {
    const intent = resolveEvent(event, { target: event.target });
    if (!intent.handled) return;
    if (intent.intent === 'up' || intent.intent === 'down' || intent.intent === 'home' || intent.intent === 'end') {
      event.preventDefault();
      const next = intentToIndexFor(intent.intent, historyRoving.activeIndex, historyRoving.total);
      historyRoving.moveTo(next);
      syncHistoryTabindex();
      focusHistoryRow(next);
      return;
    }
    if (intent.intent === 'activate') {
      event.preventDefault();
      const active = historyRoving.activeIndex;
      const record = historyCache[active];
      if (record) showDetail(record.id);
    }
  });
}

function intentToIndexFor(intent, index, total) {
  if (!total) return 0;
  if (intent === 'home') return 0;
  if (intent === 'end') return total - 1;
  return Math.max(0, Math.min(total - 1, index + (intent === 'up' ? -1 : 1)));
}

function ensureHistoryListAria() {
  ariaList($('history'), t('a11y.list', { count: historyCache.length }));
  ariaList($('requests'), t('a11y.list', { count: lastLive ? (lastLive.requests || []).length : 0 }));
  ariaList($('consoleList'), t('a11y.list', { count: lastLive ? (lastLive.console || []).length : 0 }));
  ariaList($('operations'), t('a11y.list', { count: operationsCache.length }));
  ariaList($('rules'), t('a11y.list', { count: 0 }));
  if ($('note')) {
    $('note').setAttribute('role', 'status');
    $('note').setAttribute('aria-live', 'polite');
  }
}

/* ---------- 详情：时间线 + 过滤 ---------- */
function buildDetailTools() {
  const metas = $('detailMeta');
  if (!metas || $('detailTools')) return;
  const tools = document.createElement('div');
  tools.id = 'detailTools';
  tools.className = 'filters';
  for (const [value, label] of [['all', t('state.ready')], ['error', 'HTTP ≥ 400'], ['slow', '> 300ms']]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'btn' + (value === 'all' ? ' primary' : '');
    chip.textContent = label;
    chip.setAttribute('data-detail-filter', value);
    chip.addEventListener('click', () => {
      detailFilter = value;
      for (const sibling of tools.querySelectorAll('[data-detail-filter]')) sibling.classList.toggle('primary', sibling.getAttribute('data-detail-filter') === value);
      renderDetailBody();
    });
    tools.appendChild(chip);
  }
  metas.parentElement.insertBefore(tools, metas.nextSibling);
  const timeline = document.createElement('div');
  timeline.id = 'detailTimeline';
  $('detailBody').parentElement.insertBefore(timeline, $('detailBody'));
}

function spansFromRequests(requests) {
  let cursor = 0;
  const list = [];
  for (let index = 0; index < requests.length; index += 1) {
    const entry = requests[index] || {};
    const duration = Math.max(0, Number(entry.durationMs) || 0);
    const start = Number(entry.start ?? entry.ts);
    const begin = Number.isFinite(start) ? start : cursor;
    const end = begin + duration;
    cursor = end;
    list.push({
      id: String(index),
      label: (entry.method || '') + ' ' + truncateMiddle(entry.url || '', 80),
      start: begin,
      end,
    });
  }
  return list;
}

function renderDetailTimeline() {
  const node = $('detailTimeline');
  if (!node || !detailRecord) return;
  if (detailFilter === 'error') {
    node.hidden = true;
    return;
  }
  const spans = detailSpansCache;
  const width = Math.max(220, Number(node.clientWidth) || Number($('detailBody') && $('detailBody').clientWidth) || 480);
  const view = buildTimelineView({ spans, width, lang: getLang(), title: t('timeline.title') });
  mount(node, view.tree);
  node.hidden = view.empty;
}

function renderDetailBody() {
  const body = $('detailBody');
  if (!body || !detailRecord) return;
  const requests = Array.isArray(detailRecord.requests) ? detailRecord.requests : [];
  const consoleLines = Array.isArray(detailRecord.console) ? detailRecord.console : [];
  const needle = detailFilter === 'error' ? 400 : detailFilter === 'slow' ? 300 : 0;
  const visible = needle
    ? requests.filter((entry) => detailFilter === 'error' ? Number(entry.status) >= needle || entry.error === true : Number(entry.durationMs) >= needle)
    : requests;
  const rows = visible.slice(0, 100).map((entry) => rowFromCells([
    { text: formatHttpStatus(entry.status), mono: true, cls: Number(entry.status) >= 400 ? 'muted' : '' },
    { text: entry.method || '', mono: true },
    { text: entry.durationMs != null ? formatDuration(entry.durationMs) : '', cls: 'muted' },
    { text: entry.url || '', grow: true, mono: true },
  ]));
  const consoleRows = consoleLines.slice(0, 100).map((entry) => rowFromCells([
    { text: entry.level || 'log', cls: entry.level === 'error' ? 'mono' : 'muted' },
    { text: String(entry.text || '').slice(0, 300), grow: true, mono: true },
  ]));
  body.textContent = '';
  body.setAttribute('role', 'list');
  body.setAttribute('aria-label', t('a11y.list', { count: rows.length }));
  for (const rowNode of rows) body.appendChild(rowNode);
  const hasRows = rows.length > 0;
  $('detailTools') && $('detailTools').setAttribute('data-has-rows', hasRows ? '1' : '0');
  renderDetailTimeline();
}

/* ---------- 对比：两份历史记录 ---------- */
function ensureComparePicker() {
  const head = $('compareHeading');
  const body = $('compareBody');
  if (!head || !body) return;
  setText(head, t('compare.title'));
  const close = $('closeCompare');
  if (close && !close.dataset.wired) {
    close.dataset.wired = '1';
    close.textContent = t('close');
    close.setAttribute('aria-label', t('close'));
    close.addEventListener('click', () => setHidden($('comparePanel'), true));
  }
  const records = historyCache.map((record) => ({ id: String(record.id), label: truncateMiddle((record.title || record.url || '调试记录') + ' · ' + formatTime(record.startedAt), 64) }));
  const signature = records.map((record) => record.id).join(',') + '|' + getLang();
  const holder = $('comparePicker');
  if (holder && holder.dataset.signature === signature) return;
  if (holder) holder.remove();
  if (compareBaseId && !records.some((record) => record.id === compareBaseId)) compareBaseId = '';
  if (compareOtherId && !records.some((record) => record.id === compareOtherId)) compareOtherId = '';
  if (!compareBaseId && records.length) compareBaseId = records[0].id;
  if (!compareOtherId && records.length > 1) compareOtherId = records[1].id;
  const picker = buildComparePicker({
    records,
    base: compareBaseId,
    other: compareOtherId,
    lang: getLang(),
    disabled: records.length < 2,
    onBase: (value) => { compareBaseId = value; },
    onOther: (value) => { compareOtherId = value; },
    onCompare: () => { void runCompare(); },
  });
  const wrapper = document.createElement('div');
  wrapper.id = 'comparePicker';
  wrapper.dataset.signature = signature;
  mount(wrapper, picker);
  if (body.parentElement) body.parentElement.insertBefore(wrapper, body);
  else body.appendChild(wrapper);
}

async function runCompare() {
  const body = $('compareBody');
  const noteNode = $('compareNote');
  if (!body) return;
  if (!compareBaseId || !compareOtherId || compareBaseId === compareOtherId) {
    mount(body, stateNode('empty', { emptyText: t('compare.needTwo') }));
    return;
  }
  setText(noteNode, t('state.loading'));
  const base = await rpc.send('bb.debug.history.detail', { id: compareBaseId });
  const other = await rpc.send('bb.debug.history.detail', { id: compareOtherId });
  if (!base.ok || !other.ok) {
    mount(body, stateNode('error', { error: (base && base.error) || (other && other.error), onRetry: () => { void runCompare(); } }));
    setText(noteNode, '');
    return;
  }
  const baseRecord = base.result && (base.result.record || base.result);
  const otherRecord = other.result && (other.result.record || other.result);
  const view = buildCaptureCompareView({ base: baseRecord, other: otherRecord, lang: getLang() });
  mount(body, view.tree);
  setText(noteNode, t('compare.offline'));
  announce(view.summary.identical ? t('compare.identical') : t('compare.summary', { added: view.summary.added, removed: view.summary.removed, changed: view.summary.changed }));
}

function openComparePanel() {
  if (!$('comparePanel')) return;
  setHidden($('comparePanel'), false);
  ensureComparePicker();
  $('comparePanel').scrollIntoView({ block: 'nearest' });
}

/* ---------- 操作时间线（daemon operations.list） ---------- */
function ensureOperationsTools() {
  const target = $('operations');
  if (!target || $('opsTimeline')) return;
  const timeline = document.createElement('div');
  timeline.id = 'opsTimeline';
  timeline.hidden = true;
  target.parentElement.insertBefore(timeline, target.nextSibling);
}

function renderOperationsTimeline() {
  const node = $('opsTimeline');
  if (!node) return;
  const spans = operationsCache.map((item, index) => ({
    id: String(index),
    label: (item.method || '') + ' ' + truncateMiddle(item.url || '', 60),
    start: Number(item.ts) || index,
    end: (Number(item.ts) || index) + Math.max(1, Number(item.durationMs) || 0),
  }));
  const view = buildTimelineView({ spans, width: Math.max(240, node.clientWidth || 480), lang: getLang() });
  mount(node, view.tree);
  node.hidden = view.empty;
}

/* ---------- 启动增强（不动既有 SELFTEST） ---------- */
function bootEnhancements() {
  ensureHistoryTools();
  ensureHistoryListAria();
  bindHistoryKeyboard();
  ensureOperationsTools();
  ensureComparePicker();
  ensureOperationsTools();
  const liveTools = $('liveTools');
  if (liveTools && !liveTools.dataset.ready) {
    liveTools.dataset.ready = '1';
    const timelineToggle = document.createElement('button');
    timelineToggle.type = 'button';
    timelineToggle.className = 'btn';
    timelineToggle.textContent = t('timeline.waterfall');
    timelineToggle.addEventListener('click', () => {
      const node = $('requestsTimeline');
      if (!node) return;
      if (!node.hidden) { node.hidden = true; return; }
      const requests = lastLive && Array.isArray(lastLive.requests) ? lastLive.requests : [];
      const view = buildTimelineView({ spans: spansFromRequests(requests), width: Math.max(240, node.clientWidth || 480), lang: getLang() });
      mount(node, view.tree);
      node.hidden = view.empty;
    });
    const compare = document.createElement('button');
    compare.type = 'button';
    compare.className = 'btn';
    compare.textContent = t('compare.title');
    compare.addEventListener('click', () => { openComparePanel(); });
    liveTools.append(timelineToggle, compare);
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.setAttribute('aria-label', t('list.filterHint'));
    filter.placeholder = t('list.filterHint');
    filter.addEventListener('input', () => {
      const needle = filter.value.trim().toLowerCase();
      const rows = $('requests') ? [...$('requests').children] : [];
      for (const node of rows) node.hidden = needle !== '' && !String(node.textContent || '').toLowerCase().includes(needle);
    });
    liveTools.insertBefore(filter, liveTools.firstChild);
  }
  if ($('requests')) setHidden($('requestsTimeline'), true);
  document.addEventListener('keydown', (event) => {
    const intent = resolveEvent(event, { target: event.target });
    if (!intent.handled) return;
    if (intent.intent === 'open-filter') {
      event.preventDefault();
      const input = $('historyFilter');
      if (input) input.focus();
    } else if (intent.intent === 'close') {
      if ($('comparePanel') && !$('comparePanel').hidden) { event.preventDefault(); setHidden($('comparePanel'), true); }
      else if ($('detailPanel') && !$('detailPanel').hidden) { event.preventDefault(); setHidden($('detailPanel'), true); }
    }
  });
  const retryLoad = () => { void loadHistory(); void loadOperations(); };
  ensureHistoryTools();
  if ($('historyEmpty')) $('historyEmpty').addEventListener('click', retryLoad);
}

const originalLoadOperations = loadOperations;
loadOperations = async function loadOperationsEnhanced() {
  await originalLoadOperations();
  ensureOperationsTools();
  renderOperationsTimeline();
};

const originalLoadHistory = loadHistory;
loadHistory = async function loadHistoryEnhanced() {
  try {
    historyState.loading();
    await originalLoadHistory();
    historyState.set(historyCache.length ? 'ready' : 'empty');
  } catch (error) {
    historyState.fail(error);
    if ($('historyEmpty')) {
      $('historyEmpty').hidden = false;
      $('historyEmpty').textContent = t('state.error');
    }
  }
  applyHistoryView();
  ensureComparePicker();
};

fillTabSelect($('tabSelect'), preferredTabFromQuery()).then(() => {
  bootEnhancements();
  void loadOperations();
});

// 第十一批 F：页面导出 / 导入校验工具（只增强；不改上面的 SELFTEST 契约与列表渲染）。
installPageTools({
  surface: 'debug',
  toolsId: 'liveTools',
  listId: 'requests',
  lang: () => getLang(),
  rows: () => (lastLive && Array.isArray(lastLive.requests) ? lastLive.requests : []),
});
