// ui/ops.js —— 操作录制页
import { back, fillTabSelect, preferredTabFromQuery, selectedTabId } from './tab-picker.js';

import { $ } from './common.js';
import { getLang } from './i18n.js';
import { installPageTools } from './lib/page-tools.js';
import { announce } from './a11y-dialog.js';
import { labeler } from './lib/labels.js';
import { createRpc } from './lib/rpc.js';
import { mount, setHidden, setText } from './lib/dom.js';
import { h, button } from './lib/render.js';
import { createStateMachine, stateModel } from './lib/states.js';
import { buildHistoryView } from './views/history-view.js';
import { buildSequenceCompareView, buildComparePicker } from './views/compare-view.js';
import { buildSequenceView } from './views/timeline-view.js';
import { createRovingModel } from './lib/focus.js';
import { resolveEvent } from './lib/keyboard.js';
import { formatTimestamp, truncateMiddle } from './lib/format.js';
let recordings = [];
let activeTabId = null;
let pollTimer = null;

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

async function refreshActive() {
  const result = await send({ type: 'bb.ops.active' });
  const list = (result && (result.active || (result.result && result.result.active))) || [];
  const current = list.find((item) => item.tabId === activeTabId);
  if (current) {
    $('status').textContent = '录制中 · ' + current.events + ' 条 · 已 ' + Math.round((Date.now() - current.startedAt) / 1000) + 's';
    $('status').className = 'status-pill on';
  } else if (activeTabId != null) {
    $('status').textContent = '未开始';
    $('status').className = 'muted';
  }
}

function renderList() {
  const list = $('list');
  list.textContent = '';
  $('empty').hidden = recordings.length > 0;
  for (const recording of recordings) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const title = document.createElement('span');
    title.className = 'grow truncate';
    title.textContent = (recording.title || recording.url || '录制') + ' · ' + recording.events.length + ' 条';
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = formatTime(recording.startedAt);
    const view = document.createElement('button');
    view.className = 'btn';
    view.textContent = '查看';
    view.addEventListener('click', () => showJson(recording));
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn';
    exportBtn.textContent = '导出';
    exportBtn.addEventListener('click', () => download(recording));
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      await send({ type: 'bb.ops.delete', id: recording.id });
      await loadList();
    });
    row.append(title, meta, view, exportBtn, del);
    list.appendChild(row);
  }
}

function showJson(recording) {
  $('jsonPanel').hidden = false;
  $('json').textContent = JSON.stringify({
    url: recording.url,
    title: recording.title,
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
    events: recording.events,
  }, null, 2);
  $('copyJson').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('json').textContent);
      note('已复制 JSON');
    } catch {
      note('复制失败', true);
    }
  };
}

function download(recording) {
  const blob = new Blob([JSON.stringify(recording, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ops-' + formatTime(recording.startedAt).replace(/[: ]/g, '-') + '.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadList() {
  const result = await send({ type: 'bb.ops.list' });
  recordings = (result && (result.recordings || (result.result && result.result.recordings))) || [];
  renderList();
}

$('back').addEventListener('click', () => back());
$('refresh').addEventListener('click', () => loadList());
$('closeJson').addEventListener('click', () => { $('jsonPanel').hidden = true; });

$('start').addEventListener('click', async () => {
  const tabId = selectedTabId($('tabSelect'));
  if (!tabId) return note('先选一个目标标签页', true);
  const result = await send({ type: 'bb.ops.start', tabId });
  if (!result || !result.ok) return note((result && result.error) || '开始录制失败', true);
  activeTabId = tabId;
  $('start').disabled = true;
  $('stop').disabled = false;
  note('已开始录制：在页面上正常操作即可');
  if (!pollTimer) pollTimer = setInterval(refreshActive, 1000);
});

$('stop').addEventListener('click', async () => {
  const tabId = activeTabId != null ? activeTabId : selectedTabId($('tabSelect'));
  const result = await send({ type: 'bb.ops.stop', tabId });
  if (!result || !result.ok) return note((result && result.error) || '停止录制失败', true);
  activeTabId = null;
  $('start').disabled = false;
  $('stop').disabled = true;
  $('status').textContent = '已停止';
  $('status').className = 'muted';
  note('已保存录制（' + (result.recording ? result.recording.events : 0) + ' 条事件）');
  await loadList();
});

fillTabSelect($('tabSelect'), preferredTabFromQuery());
loadList();

// ?selftest=1：真实开始/停止一次录制，结果写进标题
if (new URLSearchParams(location.search).get('selftest') === '1') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      const started = await send({ type: 'bb.ops.start', tabId });
      if (!started || !started.ok) throw new Error((started && started.error) || 'start failed');
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: () => {
            const button = document.getElementById('submit-btn');
            if (button) button.click();
          },
        });
      } catch {
        // 页面没有该按钮时忽略，只验证录制开关
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      const stopped = await send({ type: 'bb.ops.stop', tabId });
      if (!stopped || !stopped.ok) throw new Error((stopped && stopped.error) || 'stop failed');
      const count = await chrome.runtime.sendMessage({ type: 'bb.ops.list' });
      const recordings = (count && (count.recordings || (count.result && count.result.recordings))) || [];
      const latest = recordings[0];
      const events = latest && Array.isArray(latest.events) ? latest.events.length : 0;
      document.title = 'SELFTEST:ok:ops:' + recordings.length + ':' + events;
    } catch (error) {
      document.title = 'SELFTEST:fail:' + ((error && error.message) || error);
    }
  })();
}

// ---------------------------------------------------------------------------
// 深度交互（第十批 E）：过滤 / 分页 / 事件时间线 / 两次录制对比 / 键盘 / aria。
// 不改动既有 SELFTEST 契约与录制开关行为。
// ---------------------------------------------------------------------------
const t = labeler(getLang());
const rpc = createRpc((message) => chrome.runtime.sendMessage(message));
const opsState = createStateMachine();
const opsRoving = createRovingModel({ total: 0, wrap: true });
let opsFilter = '';
let opsSort = { key: 'ts', direction: 'desc' };
let opsTimelineIndex = 0;
let compareLeftId = '';
let compareRightId = '';

function opsStatusNode(kind, error, retry) {
  const model = stateModel(kind, { lang: getLang(), error });
  return h('div', { class: 'state-block ' + kind, role: 'status', 'aria-live': 'polite' }, [
    model.text,
    kind === 'error' && retry ? button({ label: model.retryText || t('state.retry'), on: { click: retry } }) : '',
  ]);
}

function ensureOpsTools() {
  const tools = $('opsTools');
  if (!tools || tools.dataset.ready) return;
  tools.dataset.ready = '1';
  const search = document.createElement('input');
  search.type = 'search';
  search.id = 'opsFilter';
  search.setAttribute('aria-label', t('list.filterHint'));
  search.placeholder = t('list.filterHint');
  search.addEventListener('input', () => { opsFilter = search.value; applyOpsView(); });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { search.value = ''; opsFilter = ''; applyOpsView(); }
  });
  const timeline = document.createElement('button');
  timeline.type = 'button';
  timeline.className = 'btn';
  timeline.id = 'opsTimelineToggle';
  timeline.textContent = t('timeline.title');
  timeline.setAttribute('aria-pressed', 'false');
  timeline.addEventListener('click', () => {
    const node = $('opsTimeline');
    if (!node) return;
    const willShow = node.hidden;
    node.hidden = !willShow;
    timeline.setAttribute('aria-pressed', willShow ? 'true' : 'false');
    if (willShow) renderOpsTimeline();
  });
  const compare = document.createElement('button');
  compare.type = 'button';
  compare.className = 'btn';
  compare.textContent = t('ops.compare');
  compare.addEventListener('click', () => { openOpsCompare(); });
  tools.append(search, timeline, compare);
}

function opsRecordings() {
  const records = Array.isArray(recordings) ? recordings : [];
  return records.map((record) => ({
    ...record,
    ts: Number(record.startedAt) || 0,
    label: String(record.title || record.url || '录制'),
    detail: formatTimestamp(record.startedAt) + (Array.isArray(record.events) ? ' · ' + t('ops.events', { count: record.events.length }) : ''),
  }));
}

function applyOpsView() {
  const list = $('list');
  if (!list) return;
  const records = opsRecordings();
  const model = buildHistoryView({
    items: records,
    kind: 'ops',
    lang: getLang(),
    query: opsFilter,
    sort: opsSort,
    page: 1,
    pageSize: Math.max(1, records.length || 1),
  });
  const node = $('opsTimeline');
  if (!records.length) {
    opsRoving.setTotal(0);
    opsState.set('empty');
    const empty = $('empty');
    if (empty) {
      empty.hidden = false;
      mount(empty, opsStatusNode('empty'));
    }
    if (node) node.hidden = true;
    return;
  }
  opsState.set(model.model.matching ? 'ready' : 'empty');
  $('empty').hidden = model.model.matching;
  list.textContent = '';
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', t('a11y.list', { count: model.model.filtered }));
  if (!model.model.matching) {
    mount(list, opsStatusNode('empty'));
    opsRoving.setTotal(0);
    return;
  }
  opsRoving.setTotal(model.model.rows.length);
  model.model.rows.forEach((record, index) => {
    const rowNode = document.createElement('div');
    rowNode.className = 'list-row';
    rowNode.setAttribute('role', 'listitem');
    rowNode.setAttribute('aria-label', String(record.label) + ' · ' + String(record.detail));
    const title = document.createElement('span');
    title.className = 'grow truncate';
    title.textContent = (record.title || record.url || '录制') + ' · ' + (Array.isArray(record.events) ? record.events.length : 0) + ' 条';
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = formatTimestamp(record.startedAt);
    const view = document.createElement('button');
    view.className = 'btn';
    view.textContent = '查看';
    view.setAttribute('aria-label', '查看');
    view.addEventListener('click', () => showJson(record));
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn';
    exportBtn.textContent = '导出';
    exportBtn.setAttribute('aria-label', '导出');
    exportBtn.addEventListener('click', () => download(record));
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '删除';
    del.setAttribute('aria-label', '删除');
    del.addEventListener('click', async () => {
      await rpc.send('bb.ops.delete', { id: record.id });
      await loadList();
      applyOpsView();
    });
    rowNode.append(title, meta, view, exportBtn, del);
    rowNode.tabIndex = opsRoving.tabIndexAt(index);
    rowNode.addEventListener('click', (event) => {
      if (event.target && event.target.closest && event.target.closest('button')) return;
      opsTimelineIndex = index;
      opsRoving.moveTo(index);
      if ($('opsTimeline') && !$('opsTimeline').hidden) renderOpsTimeline();
    });
    rowNode.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showJson(record);
      }
    });
    list.appendChild(rowNode);
  });
  opsRoving.moveTo(0);
  const pager = $('opsPager');
  if (pager) {
    setText(pager, t('paging.total', { total: model.model.filtered }) + (opsFilter ? ' · ' + t('list.filter') : ''));
    pager.setAttribute('role', 'status');
    pager.setAttribute('aria-live', 'polite');
  }
  if (node && !node.hidden) renderOpsTimeline();
  ensureOpsComparePicker();
}

function renderOpsTimeline() {
  const node = $('opsTimeline');
  if (!node) return;
  const record = opsRecordings()[opsTimelineIndex] || opsRecordings()[0];
  if (!record) { node.hidden = true; return; }
  const events = Array.isArray(record.events) ? record.events : [];
  const items = events.map((event, index) => ({
    label: String(event && (event.type || event.kind || 'event')) + ' ' + truncateMiddle(String(event && (event.selector || event.target || event.url || event.text) || ''), 60),
    at: Number(event && event.ts) || undefined,
    index,
  }));
  const view = buildSequenceView({
    items,
    width: Math.max(240, node.clientWidth || 480),
    lang: getLang(),
    onStep: (index) => {
      const event = events[index];
      mount(node, h('pre', { class: 'mono', style: { 'max-block-size': '220px', 'overflow-y': 'auto', 'white-space': 'pre-wrap', 'font-size': '12px' } }, JSON.stringify(event, null, 2)));
    },
  });
  mount(node, view.tree);
  if (!node.querySelector('.tl-sequence')) {
    const label = document.createElement('div');
    label.className = 'kbd-hint';
    label.textContent = t('ops.events', { count: events.length }) + ' · ' + formatTimestamp(record.startedAt);
    node.appendChild(label);
  }
  node.hidden = false;
}

function ensureOpsComparePicker() {
  const panel = $('opsComparePanel');
  const records = opsRecordings();
  if (!panel) return;
  if (records.length < 2) { panel.hidden = true; return; }
  const signature = records.map((record) => record.id).join(',') + '|' + getLang();
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  if (!compareLeftId || !records.some((record) => String(record.id) === compareLeftId)) compareLeftId = String(records[0].id);
  if (!compareRightId || !records.some((record) => String(record.id) === compareRightId) || compareRightId === compareLeftId) {
    compareRightId = String((records.find((record) => String(record.id) !== compareLeftId) || records[0]).id);
  }
  mount(panel, buildComparePicker({
    records: records.map((record) => ({ id: String(record.id), label: truncateMiddle(record.label + ' · ' + formatTimestamp(record.startedAt), 60) })),
    base: compareLeftId,
    other: compareRightId,
    lang: getLang(),
    onBase: (value) => { compareLeftId = value; },
    onOther: (value) => { compareRightId = value; },
    onCompare: () => { renderOpsCompare(); },
  }));
  panel.hidden = false;
}

function openOpsCompare() {
  const panel = $('opsComparePanel');
  if (!panel) return;
  ensureOpsComparePicker();
  panel.hidden = false;
  const records = opsRecordings();
  const left = records.find((record) => String(record.id) === compareLeftId);
  const right = records.find((record) => String(record.id) === compareRightId);
  if (left && right) renderOpsCompare();
}

function renderOpsCompare() {
  const panel = $('opsComparePanel');
  if (!panel) return;
  const records = opsRecordings();
  const left = records.find((record) => String(record.id) === compareLeftId);
  const right = records.find((record) => String(record.id) === compareRightId);
  if (!left || !right || left.id === right.id) {
    panel.hidden = false;
    mount(panel, h('p', { class: 'muted' }, t('compare.needTwo')));
    return;
  }
  const view = buildSequenceCompareView({
    leftEvents: Array.isArray(left.events) ? left.events : [],
    rightEvents: Array.isArray(right.events) ? right.events : [],
    lang: getLang(),
    title: t('ops.compare'),
  });
  mount(panel, view.tree);
  announce(view.stats.identical ? t('compare.identical') : t('compare.summary', { added: view.stats.added, removed: view.stats.removed, changed: 0 }));
}

function bootOpsEnhancements() {
  ensureOpsTools();
  applyOpsView();
  document.addEventListener('keydown', (event) => {
    const intent = resolveEvent(event, { target: event.target });
    if (!intent.handled) return;
    if (intent.intent === 'open-filter') {
      event.preventDefault();
      $('opsFilter') && $('opsFilter').focus();
    } else if (intent.intent === 'close') {
      const panel = $('jsonPanel');
      if (panel && !panel.hidden) { event.preventDefault(); panel.hidden = true; }
    }
  });
  const originalShowJson = showJson;
  const list = $('list');
  if (list) {
    list.addEventListener('keydown', (event) => {
      const intent = resolveEvent(event, { target: event.target });
      if (!intent.handled) return;
      const rows = [...list.children].filter((child) => child.classList && child.classList.contains('list-row'));
      if (!rows.length) return;
      if (intent.intent === 'up' || intent.intent === 'down' || intent.intent === 'home' || intent.intent === 'end') {
        event.preventDefault();
        const index = intent.intent === 'home' ? 0 : intent.intent === 'end' ? rows.length - 1 : opsRoving.activeIndex + (intent.intent === 'up' ? -1 : 1);
        opsRoving.moveTo(Math.max(0, Math.min(rows.length - 1, index)));
        rows.forEach((rowNode, rowIndex) => { rowNode.tabIndex = opsRoving.tabIndexAt(rowIndex); });
        const target = rows[opsRoving.activeIndex];
        if (target) target.focus({ preventScroll: false });
      } else if (intent.intent === 'activate') {
        event.preventDefault();
        const record = opsRecordings()[opsRoving.activeIndex];
        if (record) originalShowJson(record);
      }
    });
  }
}

const originalLoadList = loadList;
loadList = async function loadListEnhanced() {
  try {
    await originalLoadList();
    opsState.set(Array.isArray(recordings) && recordings.length ? 'ready' : 'empty');
  } catch (error) {
    opsState.fail(error);
    const empty = $('empty');
    if (empty) {
      empty.hidden = false;
      mount(empty, opsStatusNode('error', error, () => { void loadList(); }));
    }
  }
  applyOpsView();
};

fillTabSelect($('tabSelect'), preferredTabFromQuery()).then(() => {
  bootOpsEnhancements();
  void loadList();
});

// 第十一批 F：页面导出 / 导入校验工具（只增强；不改上面的 SELFTEST 契约与列表渲染）。
installPageTools({
  surface: 'ops',
  toolsId: 'opsTools',
  listId: 'list',
  lang: () => getLang(),
  rows: () => opsRecordings(),
});
