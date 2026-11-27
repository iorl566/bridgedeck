// ui/record.js —— 视频录制页（录制动能在 offscreen，文件存在同一 IndexedDB）
import { back, fillTabSelect, preferredTabFromQuery, selectedTabId } from './tab-picker.js';

const DB_NAME = 'bb-videos';
const STORE = 'videos';
import { $, formatBytes } from './common.js';
import { getLang } from './i18n.js';
import { installPageTools } from './lib/page-tools.js';
import { announce } from './a11y-dialog.js';
import { labeler } from './lib/labels.js';
import { mount } from './lib/dom.js';
import { h, button } from './lib/render.js';
import { createStateMachine, stateModel } from './lib/states.js';
import { buildHistoryView } from './views/history-view.js';
import { buildTimelineView } from './views/timeline-view.js';
import { createRovingModel } from './lib/focus.js';
import { resolveEvent } from './lib/keyboard.js';
import { formatTimestamp } from './lib/format.js';
let activeTabId = null;
let tickTimer = null;
let startedAt = 0;
let previewUrl = null;

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

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败'));
  });
}

async function listVideos() {
  const db = await openDb();
  const records = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error('读取失败'));
  });
  db.close();
  return records.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

async function deleteVideo(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('删除失败'));
  });
  db.close();
}

function renderList(records) {
  const list = $('list');
  list.textContent = '';
  $('empty').hidden = records.length > 0;
  for (const record of records) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const title = document.createElement('span');
    title.className = 'grow truncate';
    title.textContent = (record.title || record.url || '录制') + ' · ' + (String(record.mime).includes('mp4') ? 'MP4' : 'WebM') + ' · ' + formatBytes(record.bytes);
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = formatTime(record.startedAt);
    const view = document.createElement('button');
    view.className = 'btn';
    view.textContent = '预览';
    view.addEventListener('click', () => preview(record));
    const download = document.createElement('button');
    download.className = 'btn';
    download.textContent = '下载';
    download.addEventListener('click', () => downloadVideo(record));
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      await deleteVideo(record.id);
      await refreshList();
    });
    row.append(title, meta, view, download, del);
    list.appendChild(row);
  }
}

function preview(record) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(record.blob);
  $('preview').src = previewUrl;
  $('previewTitle').textContent = record.title || record.url || '';
  $('previewWrap').hidden = false;
}

function downloadVideo(record) {
  const url = URL.createObjectURL(record.blob);
  const anchor = document.createElement('a');
  const ext = String(record.mime).includes('mp4') ? 'mp4' : 'webm';
  anchor.href = url;
  anchor.download = 'browser-bridge-' + formatTime(record.startedAt).replace(/[: ]/g, '-') + '.' + ext;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function refreshList() {
  try {
    renderList(await listVideos());
  } catch (error) {
    note('读取录制文件失败：' + ((error && error.message) || error), true);
  }
}

function tick() {
  if (!startedAt) return;
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  $('status').textContent = '录制中 · ' + String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  $('status').className = 'status-pill on';
}

async function syncState() {
  const result = await send({ type: 'bb.rec.state' });
  const state = (result && result.result) || result || {};
  if (state.active) {
    activeTabId = state.tabId;
    startedAt = state.startedAt || Date.now();
    $('start').disabled = true;
    $('stop').disabled = false;
    tick();
    if (!tickTimer) tickTimer = setInterval(tick, 1000);
  } else {
    if (activeTabId != null) {
      activeTabId = null;
      startedAt = 0;
    }
    $('start').disabled = false;
    $('stop').disabled = true;
    $('status').textContent = '未开始';
    $('status').className = 'muted';
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }
}

$('back').addEventListener('click', () => back());
$('refresh').addEventListener('click', () => refreshList());
$('closePreview').addEventListener('click', () => {
  $('previewWrap').hidden = true;
  $('preview').removeAttribute('src');
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
});

$('start').addEventListener('click', async () => {
  const tabId = selectedTabId($('tabSelect'));
  if (!tabId) return note('先选一个目标标签页', true);
  const result = await send({ type: 'bb.rec.start', tabId });
  if (!result || !result.ok) return note((result && result.error) || '开始录制失败', true);
  note('开始录制（' + (String(result.mime).includes('mp4') ? 'MP4' : 'WebM') + '）');
  await syncState();
});

$('stop').addEventListener('click', async () => {
  const result = await send({ type: 'bb.rec.stop' });
  if (!result || !result.ok) return note((result && result.error) || '停止录制失败', true);
  note('录制已停止，正在写入文件…');
  setTimeout(() => { refreshList(); syncState(); }, 1200);
});

fillTabSelect($('tabSelect'), preferredTabFromQuery());
syncState();
refreshList();

// ?selftest=1：真实录 1.5 秒、停止、读回文件；
// ?selftest=crash：模拟 offscreen 文档异常消失（录制中断测试，E2E 用）
const selftest = new URLSearchParams(location.search).get('selftest');
if (selftest === '1') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      const started = await send({ type: 'bb.rec.start', tabId });
      if (!started || !started.ok) throw new Error((started && started.error) || 'start failed');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const stopped = await send({ type: 'bb.rec.stop' });
      if (!stopped || !stopped.ok) throw new Error((stopped && stopped.error) || 'stop failed');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const records = await listVideos();
      const latest = records[0];
      document.title = latest
        ? 'SELFTEST:ok:video:' + records.length + ':' + (String(latest.mime).includes('mp4') ? 'mp4' : 'webm') + ':' + latest.bytes
        : 'SELFTEST:fail:no-video-file';
    } catch (error) {
      document.title = 'SELFTEST:fail:' + ((error && error.message) || error);
    }
  })();
} else if (selftest === 'seed') {
  // 恢复演练：用真实 MediaRecorder 生成一小段视频，按两个分片写入分片库，
  // 再由 `video recover` 扫描分片、按序拼回文件（E2E 用）。
  (async () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      let frame = 0;
      const draw = setInterval(() => {
        ctx.fillStyle = 'hsl(' + ((frame * 37) % 360) + ',70%,50%)';
        ctx.fillRect(0, 0, 64, 64);
        frame += 1;
      }, 100);
      const stream = canvas.captureStream(10);
      const mime = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mime) throw new Error('没有可用的视频编码');
      const parts = [];
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 200000 });
      recorder.ondataavailable = (event) => { if (event.data && event.data.size) parts.push(event.data); };
      recorder.start(200);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await new Promise((resolve) => { recorder.onstop = () => resolve(); recorder.stop(); });
      clearInterval(draw);
      for (const track of stream.getTracks()) { try { track.stop(); } catch { /* 忽略 */ } }
      const blob = new Blob(parts, { type: mime });
      if (!blob.size) throw new Error('没有录到任何分片');
      const id = 'recover-drill-' + Date.now().toString(36);
      const half = Math.max(1, Math.floor(blob.size / 2));
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('bb-videos', 2);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('videos')) database.createObjectStore('videos', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('chunks')) database.createObjectStore('chunks', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('打开分片库失败'));
      });
      const meta = { recordingId: id, tabId: 0, url: 'e2e://recover', title: 'recover drill', startedAt: Date.now(), mime };
      const chunks = [
        { blob: blob.slice(0, half), index: 0 },
        { blob: blob.slice(half), index: 1 },
      ];
      await new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readwrite');
        const store = tx.objectStore('chunks');
        store.clear();
        for (const chunk of chunks) {
          store.put({
            key: id + ':' + String(chunk.index).padStart(6, '0'),
            recordingId: id,
            index: chunk.index,
            at: Date.now(),
            meta,
            blob: chunk.blob,
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('写分片失败'));
      });
      db.close();
      document.title = 'SELFTEST:ok:seed:' + id + ':' + blob.size + ':' + (mime.includes('mp4') ? 'mp4' : 'webm');
    } catch (error) {
      document.title = 'SELFTEST:fail:seed:' + ((error && error.message) || error);
    }
  })();
}

// ---------------------------------------------------------------------------
// 深度交互（第十批 E）：过滤 / 分页 / 录制分布时间线 / 详情 / 键盘 / aria。
// 不改动既有 SELFTEST 契约与录制开关行为。
// ---------------------------------------------------------------------------
const t = labeler(getLang());
const videoState = createStateMachine();
const videoRoving = createRovingModel({ total: 0, wrap: true });
let videoRecords = [];
let videoFilter = '';
let videoSort = { key: 'ts', direction: 'desc' };
let videoTimelineIndex = 0;

function videoStatusNode(kind, error, retry) {
  const model = stateModel(kind, { lang: getLang(), error });
  return h('div', { class: 'state-block ' + kind, role: 'status', 'aria-live': 'polite' }, [
    model.text,
    kind === 'error' && retry ? button({ label: model.retryText || t('state.retry'), on: { click: retry } }) : '',
  ]);
}

function ensureRecordTools() {
  const tools = $('recordTools');
  if (!tools || tools.dataset.ready) return;
  tools.dataset.ready = '1';
  const search = document.createElement('input');
  search.type = 'search';
  search.id = 'recordFilter';
  search.setAttribute('aria-label', t('list.filterHint'));
  search.placeholder = t('list.filterHint');
  search.addEventListener('input', () => { videoFilter = search.value; applyRecordView(); });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { search.value = ''; videoFilter = ''; applyRecordView(); }
  });
  const timeline = document.createElement('button');
  timeline.type = 'button';
  timeline.className = 'btn';
  timeline.textContent = t('timeline.title');
  timeline.addEventListener('click', () => {
    const node = $('recordTimeline');
    if (!node) return;
    node.hidden = !node.hidden;
    if (!node.hidden) renderRecordTimeline();
  });
  tools.append(search, timeline);
}

function applyRecordView() {
  const records = Array.isArray(videoRecords) ? videoRecords : [];
  if (!records.length) {
    videoRoving.setTotal(0);
    videoState.set('empty');
    return;
  }
  const model = buildHistoryView({
    items: records.map((record) => ({
      ...record,
      ts: Number(record.startedAt) || 0,
      label: String(record.title || record.url || '录制'),
      detail: formatBytes(record.bytes) + (record.mime ? ' · ' + record.mime : ''),
    })),
    kind: 'video',
    lang: getLang(),
    query: videoFilter,
    sort: videoSort,
    page: 1,
    pageSize: Math.max(1, records.length),
  });
  const list = $('list');
  if (!list) return;
  list.textContent = '';
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', t('a11y.list', { count: model.model.filtered }));
  $('empty').hidden = model.model.matching;
  if (!model.model.matching) {
    mount(list, videoStatusNode('empty'));
    videoRoving.setTotal(0);
    return;
  }
  videoRoving.setTotal(model.model.rows.length);
  model.model.rows.forEach((record, index) => {
    const rowNode = document.createElement('div');
    rowNode.className = 'list-row';
    rowNode.setAttribute('role', 'listitem');
    rowNode.setAttribute('aria-label', String(record.label) + ' · ' + String(record.detail));
    const title = document.createElement('span');
    title.className = 'grow truncate';
    title.textContent = (record.title || record.url || '录制') + ' · ' + (String(record.mime).includes('mp4') ? 'MP4' : 'WebM') + ' · ' + formatBytes(record.bytes);
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = formatTimestamp(record.startedAt);
    const view = document.createElement('button');
    view.className = 'btn';
    view.textContent = '预览';
    view.setAttribute('aria-label', '预览');
    view.addEventListener('click', () => preview(record));
    const download = document.createElement('button');
    download.className = 'btn';
    download.textContent = '下载';
    download.setAttribute('aria-label', '下载');
    download.addEventListener('click', () => downloadVideo(record));
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '删除';
    del.setAttribute('aria-label', '删除');
    del.addEventListener('click', async () => {
      await deleteVideo(record.id);
      await refreshList();
    });
    rowNode.append(title, meta, view, download, del);
    rowNode.tabIndex = videoRoving.tabIndexAt(index);
    rowNode.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); preview(record); }
    });
    rowNode.addEventListener('click', (event) => {
      if (event.target && event.target.closest && event.target.closest('button')) return;
      videoRoving.moveTo(index);
      selectVideo(record);
    });
    list.appendChild(rowNode);
  });
  videoRoving.moveTo(0);
  const pager = $('recordPager');
  if (pager) {
    setText(pager, t('paging.total', { total: model.model.filtered }) + (videoFilter ? ' · ' + t('list.filter') : ''));
    pager.setAttribute('role', 'status');
    pager.setAttribute('aria-live', 'polite');
  }
  if ($('recordTimeline') && !$('recordTimeline').hidden) renderRecordTimeline();
}

function selectVideo(record) {
  const node = $('recordDetail');
  if (!node) return;
  node.hidden = false;
  mount(node, h('div', { class: 'detail-panel', role: 'group', 'aria-label': String(record.title || '') }, [
    h('div', { class: 'kv-list' }, [
      h('div', { class: 'kv' }, [h('span', { class: 'muted' }, 'mime'), h('span', { class: 'mono' }, String(record.mime || ''))]),
      h('div', { class: 'kv' }, [h('span', { class: 'muted' }, 'bytes'), h('span', { class: 'mono' }, formatBytes(record.bytes))]),
      h('div', { class: 'kv' }, [h('span', { class: 'muted' }, 'startedAt'), h('span', { class: 'mono' }, formatTimestamp(record.startedAt))]),
      h('div', { class: 'kv' }, [h('span', { class: 'muted' }, 'title'), h('span', { class: 'truncate' }, String(record.title || record.url || ''))]),
    ]),
    h('div', { class: 'toolbar' }, [
      button({ label: t('close'), on: { click: () => { node.hidden = true; } } }),
    ]),
  ]));
  announce(t('a11y.announced', { label: String(record.title || record.url || '') }));
}

function renderRecordTimeline() {
  const node = $('recordTimeline');
  if (!node) return;
  const records = Array.isArray(videoRecords) ? videoRecords : [];
  const spans = records.map((record, index) => ({
    id: String(index),
    label: String(record.title || record.url || '录制'),
    start: Number(record.startedAt) || index,
    end: (Number(record.startedAt) || index) + Math.max(1, Number(record.durationMs) || 1000),
  }));
  const view = buildTimelineView({ spans, width: Math.max(240, node.clientWidth || 480), lang: getLang(), title: t('timeline.title') });
  mount(node, view.tree);
  node.hidden = view.empty;
}

function bootRecordEnhancements() {
  ensureRecordTools();
  applyRecordView();
  document.addEventListener('keydown', (event) => {
    const intent = resolveEvent(event, { target: event.target });
    if (!intent.handled) return;
    if (intent.intent === 'open-filter') {
      event.preventDefault();
      $('recordFilter') && $('recordFilter').focus();
    } else if (intent.intent === 'close') {
      if ($('previewWrap') && !$('previewWrap').hidden) { event.preventDefault(); $('closePreview').click(); }
    }
  });
}

const originalRefreshList = refreshList;
refreshList = async function refreshListEnhanced() {
  try {
    await originalRefreshList();
    videoRecords = await listVideos();
    videoState.set(videoRecords.length ? 'ready' : 'empty');
  } catch (error) {
    videoState.fail(error);
    const empty = $('empty');
    if (empty) {
      empty.hidden = false;
      mount(empty, videoStatusNode('error', error, () => { void refreshList(); }));
    }
  }
  applyRecordView();
};

syncState().then(() => { bootRecordEnhancements(); void refreshList(); });

// 第十一批 F：页面导出 / 导入校验工具（只增强；不改上面的 SELFTEST 契约与列表渲染）。
installPageTools({
  surface: 'record',
  toolsId: 'recordTools',
  listId: 'list',
  lang: () => getLang(),
  rows: () => videoRecords,
});
