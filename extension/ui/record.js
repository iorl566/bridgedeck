// ui/record.js —— 视频录制页（录制动能在 offscreen，文件存在同一 IndexedDB）
import { back, fillTabSelect, preferredTabFromQuery, selectedTabId } from './tab-picker.js';

const DB_NAME = 'bb-videos';
const STORE = 'videos';
const $ = (id) => document.getElementById(id);
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

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
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

// ?selftest=1：真实录 1.5 秒、停止、读回文件，结果写进标题
if (new URLSearchParams(location.search).get('selftest') === '1') {
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
}
