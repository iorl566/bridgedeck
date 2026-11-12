// src/video.js —— 视频录制（tabCapture → offscreen MediaRecorder，优先 MP4；必要时调试器截帧）
import { acquire, onEvent, release, send as cdpSend } from './debugger.js';
import { log } from './log.js';

const DB_NAME = 'bb-videos';
const STORE = 'videos';
const CHUNK_STORE = 'chunks';
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_DURATION_MS = 10 * 60 * 1000;

let active = null; // { id, tabId, url, title, startedAt, mime, mode, timer }
const pendingStops = new Map(); // id -> resolve
let screencast = null;

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败'));
  });
}

async function listRecords() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('读取录制失败'));
    });
  } finally {
    db.close();
  }
}

async function readRecord(id) {
  const records = await listRecords();
  return records.find((item) => item.id === id) || null;
}

async function deleteRecord(id) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('删除录制失败'));
    });
  } finally {
    db.close();
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '录制标签页视频',
  });
}

function requireTabId(params) {
  const tabId = Number(params && params.tabId);
  if (!Number.isInteger(tabId)) throw new Error('需要 tabId');
  return tabId;
}

function bitrateOf(quality) {
  return quality === 'high' ? 8000000 : 4000000;
}

/** 兜底录制：chrome.debugger 的 Page.startScreencast → offscreen canvas → MediaRecorder。 */
async function startViaDebugger(tabId, tab, recordingId, quality, durationMs) {
  const dbg = await acquire(tabId, 'record');
  try {
    await cdpSend(tabId, 'Page.enable').catch(() => {});
    const started = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'bb.rec.start-frames',
      recordingId,
      durationMs,
      tabId,
      url: String(tab.url || ''),
      title: tab.title || '',
      fps: 10,
      width: 1280,
      height: 800,
      bitrate: bitrateOf(quality),
    });
    if (!started || started.ok === false) throw new Error((started && started.error) || '截帧录制启动失败');
    const unsubscribe = onEvent(dbg, 'Page.screencastFrame', (event) => {
      if (!event || !event.data) return;
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'bb.rec.frame',
        data: 'data:image/jpeg;base64,' + event.data,
      }).catch(() => {});
      cdpSend(tabId, 'Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdpSend(tabId, 'Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    screencast = { tabId, unsubscribe };
    return { ok: true, mime: started.mime, startedAt: started.startedAt, mode: 'debugger' };
  } catch (error) {
    await release(tabId, 'record').catch(() => {});
    throw error;
  }
}

async function stopScreencast() {
  if (!screencast) return;
  const { tabId, unsubscribe } = screencast;
  screencast = null;
  try {
    await cdpSend(tabId, 'Page.stopScreencast');
  } catch {
    // 忽略
  }
  try {
    unsubscribe();
  } catch {
    // 忽略
  }
  await release(tabId, 'record').catch(() => {});
}

const VIDEO_TTL_MS = 24 * 60 * 60 * 1000;

async function pruneExpired(ttlOverride) {
  let ttl = Number(ttlOverride);
  if (!Number.isFinite(ttl) || ttl < 0) {
    ttl = VIDEO_TTL_MS;
    try {
      const stored = await chrome.storage.local.get('bb.video.ttlMs');
      const custom = Number(stored && stored['bb.video.ttlMs']);
      if (Number.isFinite(custom) && custom >= 0) ttl = custom;
    } catch {
      // 用默认
    }
  }
  const records = await listRecords();
  const now = Date.now();
  let removed = 0;
  for (const record of records) {
    const at = Number(record.endedAt) || Number(record.startedAt) || 0;
    if (at > 0 && now - at > ttl) {
      await deleteRecord(record.id);
      removed += 1;
    }
  }
  return removed;
}

export async function videoPrune(params = {}) {
  const removed = await pruneExpired(params.ttlMs);
  const records = await listRecords();
  if (removed) log('已清理过期录制 ' + removed + ' 条');
  return { ok: true, removed, remaining: records.length };
}

export async function startVideo(params = {}) {
  if (active) throw new Error('已有录制进行中（' + active.id + '）');
  // 上一段截帧录制可能没停干净，先收尾
  await stopScreencast().catch(() => {});
  const tabId = requireTabId(params);
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('标签页不存在或已关闭');
  }
  const url = String(tab.url || '');
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url)) {
    throw new Error('受限页面不能录制');
  }
  const recordingId = uuid();
  const durationMs = Math.min(Math.max(Number(params.durationMs) || 0, 0), MAX_DURATION_MS);
  await ensureOffscreen();

  let result = null;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    result = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'bb.rec.start',
      streamId,
      recordingId,
      tabId,
      url,
      title: tab.title || '',
      bitrate: bitrateOf(params.quality),
      durationMs,
    });
    if (result && result.ok !== false) result.mode = 'tabCapture';
  } catch (error) {
    const message = String((error && error.message) || error);
    if (!/activeTab|not been invoked|cannot be captured|cannot capture|not allowed/i.test(message)) {
      throw new Error(message);
    }
    log('tabCapture 不可用（' + message + '），改用调试器截帧录制');
    result = await startViaDebugger(tabId, tab, recordingId, params.quality, durationMs);
  }

  if (!result || result.ok === false) {
    throw new Error((result && result.error) || '录制启动失败');
  }
  active = {
    id: recordingId,
    tabId,
    url,
    title: tab.title || '',
    startedAt: result.startedAt || Date.now(),
    mime: result.mime || '',
    mode: result.mode || null,
    deadline: durationMs > 0 ? (result.startedAt || Date.now()) + durationMs : 0,
    timer: null,
  };
  try {
    await chrome.storage.local.set({ 'bb.video.active': { id: recordingId, tabId, startedAt: active.startedAt, url, title: active.title } });
  } catch {
    // 状态记录失败不影响录制
  }
  // 到时自动停止由 offscreen 文档负责（SW 可能被回收，定时器不可靠）
  log('视频录制开始 id=' + recordingId + ' tab=' + tabId + ' mime=' + active.mime + ' mode=' + active.mode);
  return {
    ok: true,
    recordingId,
    tabId,
    mime: active.mime,
    startedAt: active.startedAt,
    mode: active.mode,
    durationMs,
  };
}

export async function stopVideo(recordingId) {
  if (!active) return { ok: false, error: '当前没有录制' };
  if (recordingId && recordingId !== active.id) {
    return { ok: false, error: 'recording 不存在：' + recordingId };
  }
  const current = active;
  const id = current.id;
  const timer = setTimeout(() => {
    const resolve = pendingStops.get(id);
    if (!resolve) return;
    pendingStops.delete(id);
    resolve({ ok: false, timeout: true });
  }, 15000);
  const done = await new Promise((resolve) => {
    pendingStops.set(id, (payload) => resolve(payload));
    Promise.resolve()
      .then(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'bb.rec.stop' }))
      .catch((error) => resolve({ ok: false, error: String((error && error.message) || error) }));
  }).finally(() => clearTimeout(timer));
  if (active && active.id === id) {
    if (active.timer) clearTimeout(active.timer);
    active = null;
    chrome.storage.local.remove('bb.video.active').catch(() => {});
  }
  await stopScreencast().catch(() => {});
  if (done && done.ok === false && done.timeout) return { ok: false, error: '等待录制文件超时' };
  if (done && done.ok === false) return { ok: false, error: done.error || '停止失败' };
  return {
    ok: true,
    recordingId: id,
    bytes: done && done.bytes ? done.bytes : 0,
    mime: (done && done.mime) || current.mime,
    durationMs: Date.now() - current.startedAt,
    state: 'ready',
  };
}

/** 把录制字节交给 CLI（base64）。 */
export async function fetchVideo(params = {}) {
  await pruneExpired();
  const id = String(params.recording || '');
  const record = await readRecord(id);
  if (!record) throw new Error('找不到录制：' + id);
  if (Number(record.bytes) > MAX_BYTES) {
    throw new Error('录制过大（' + record.bytes + ' 字节），上限 ' + MAX_BYTES);
  }
  const buffer = new Uint8Array(await record.blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
  }
  return { ok: true, recordingId: id, mime: record.mime, bytes: record.bytes, base64: btoa(binary) };
}

export async function recoverVideo() {
  await ensureOffscreen().catch(() => {});
  const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'bb.rec.recover' }).catch(() => null);
  if (!result || result.ok === false) throw new Error((result && result.error) || '没有可恢复的录制分片');
  chrome.storage.local.remove('bb.video.active').catch(() => {});
  return { ok: true, ...(result.record || {}) };
}

export async function listVideos() {
  await pruneExpired();
  const records = await listRecords();
  return {
    ok: true,
    recordings: records
      .map((item) => ({
        id: item.id,
        tabId: item.tabId,
        url: item.url,
        title: item.title,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        mime: item.mime,
        bytes: item.bytes,
      }))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)),
  };
}

export async function discardVideo(params = {}) {
  const id = String(params.recording || '');
  await deleteRecord(id);
  return { ok: true, recordingId: id };
}

export async function videoState() {
  if (active) {
    return {
      ok: true,
      active: true,
      recordingId: active.id,
      tabId: active.tabId,
      startedAt: active.startedAt,
      mime: active.mime,
      mode: active.mode,
      url: active.url,
      title: active.title,
    };
  }
  try {
    const stored = await chrome.storage.local.get('bb.video.active');
    const stale = stored && stored['bb.video.active'];
    if (stale && stale.id) {
      let live = null;
      try {
        live = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'bb.rec.status' });
      } catch {
        live = null;
      }
      if (live && live.active) {
        const meta = live.meta || {};
        active = {
          id: stale.id,
          tabId: meta.tabId != null ? meta.tabId : stale.tabId,
          url: meta.url || stale.url || '',
          title: meta.title || stale.title || '',
          startedAt: meta.startedAt || stale.startedAt || Date.now(),
          mime: meta.mime || stale.mime || '',
          mode: 'recovered',
          timer: null,
          deadline: 0,
        };
        return {
          ok: true, active: true, recovered: true,
          recordingId: active.id, tabId: active.tabId, startedAt: active.startedAt,
          mime: active.mime, mode: active.mode, url: active.url, title: active.title,
        };
      }
      return { ok: true, active: false, interrupted: true, recordingId: stale.id, tabId: stale.tabId, startedAt: stale.startedAt, url: stale.url || '', title: stale.title || '' };
    }
  } catch {
    // 忽略存储读取失败
  }
  return { ok: true, active: false };
}

export function handleRecDone(message) {
  if (!message) return;
  if (!message.id && message.tabId != null) {
    if (active && active.tabId === message.tabId) {
      if (active.timer) clearTimeout(active.timer);
      active = null;
      chrome.storage.local.remove('bb.video.active').catch(() => {});
    }
    return;
  }
  if (!message.id) return;
  const resolve = pendingStops.get(message.id);
  if (resolve) {
    pendingStops.delete(message.id);
    resolve({ ok: true, bytes: message.bytes, mime: message.mime });
  }
  if (active && active.id === message.id) {
    const mode = active.mode;
    if (active.timer) clearTimeout(active.timer);
    active = null;
    chrome.storage.local.remove('bb.video.active').catch(() => {});
    if (mode === 'debugger') stopScreencast().catch(() => {});
  }
}

/** video.status：过了时长就先把录制停掉，返回 active 或 ready。 */
async function readTrace() {
  try {
    const stored = await chrome.storage.local.get('bb.video.trace');
    return Array.isArray(stored && stored['bb.video.trace']) ? stored['bb.video.trace'].slice(-10) : [];
  } catch {
    return [];
  }
}

export async function videoStatus(params = {}) {
  await pruneExpired();
  if (active && active.deadline && Date.now() >= active.deadline) {
    await stopVideo(active.id).catch(() => {});
  }
  if (active) {
    return {
      ok: true,
      active: true,
      state: 'recording',
      recordingId: active.id,
      tabId: active.tabId,
      startedAt: active.startedAt,
      deadlineMs: active.deadline || 0,
      mime: active.mime,
      mode: active.mode,
      url: active.url,
      title: active.title,
    };
  }
  const records = await listRecords();
  const id = params.recording ? String(params.recording) : '';
  const record = id ? records.find((item) => item.id === id) : records[0];
  if (!record) return { ok: true, active: false, state: 'none', trace: await readTrace() };
  return {
    ok: true,
    active: false,
    state: 'ready',
    trace: await readTrace(),
    recordingId: record.id,
    tabId: record.tabId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    mime: record.mime,
    bytes: record.bytes,
    url: record.url,
    title: record.title,
  };
}
