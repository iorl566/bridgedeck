// offscreen.js —— 用 tabCapture 的 streamId 录 MP4（离屏文档里跑 MediaRecorder）
import { pickVideoMime, normalizeVideoOptions } from './src/video-encoder.js';
const DB_NAME = 'bb-videos';
const DB_VERSION = 2;
const STORE = 'videos';
const CHUNK_STORE = 'chunks';

let recorder = null;
let stream = null;
let chunks = [];
let meta = null;
let mode = null;
let canvas = null;
let context2d = null;
let stopTimer = null;
let chunkIndex = 0;

async function trace(stage, extra) {
  try {
    const stored = await chrome.storage.local.get('bb.video.trace');
    const list = Array.isArray(stored && stored['bb.video.trace']) ? stored['bb.video.trace'] : [];
    list.push(Object.assign({ stage, at: Date.now() }, extra || {}));
    await chrome.storage.local.set({ 'bb.video.trace': list.slice(-30) });
  } catch {
    // trace 失败不影响录制
  }
}

function pickMime(preferred) {
  return pickVideoMime((mime) => MediaRecorder.isTypeSupported(mime), { preferred });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败'));
  });
}

async function saveVideo(record) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存视频失败'));
  });
  db.close();
}

async function storeChunk(blob, recordMeta) {
  const id = String((recordMeta && recordMeta.recordingId) || '');
  if (!id || !blob || !blob.size) return;
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readwrite');
      tx.objectStore(CHUNK_STORE).put({
        key: id + ':' + String(chunkIndex).padStart(6, '0'),
        recordingId: id,
        index: chunkIndex,
        at: Date.now(),
        meta: recordMeta,
        blob,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('保存录制分片失败'));
    });
    chunkIndex += 1;
  } finally {
    db.close();
  }
}

async function clearChunks() {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readwrite');
      tx.objectStore(CHUNK_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('清理录制分片失败'));
    });
  } finally {
    db.close();
  }
}

async function readChunks() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readonly');
      const request = tx.objectStore(CHUNK_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('读取录制分片失败'));
    });
  } finally {
    db.close();
  }
}

function onData(data) {
  if (!data || !data.size) return;
  chunks.push(data);
  storeChunk(data, meta).catch(() => {});
}

function scheduleAutoStop(durationMs) {
  const limit = Number(durationMs) > 0 ? Math.min(Number(durationMs), 10 * 60 * 1000) : 0;
  if (!limit) return;
  stopTimer = setTimeout(() => {
    stopTimer = null;
    try {
      if (recorder && recorder.state === 'recording') recorder.stop();
    } catch {
      // 忽略
    }
  }, limit);
}

async function recoverChunks() {
  const items = await readChunks();
  if (!items.length) return { ok: false, error: '没有可恢复的录制分片' };
  const groups = new Map();
  for (const item of items) {
    const id = String(item.recordingId || '');
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  const [id, list] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  list.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  const first = list[0];
  const recordMeta = first.meta || { recordingId: id, tabId: 0, url: '', title: '', startedAt: first.at || Date.now(), mime: 'video/mp4' };
  const mime = recordMeta.mime || 'video/mp4';
  const blob = new Blob(list.map((item) => item.blob), { type: mime });
  const record = {
    id,
    tabId: recordMeta.tabId,
    url: recordMeta.url || '',
    title: recordMeta.title || '',
    startedAt: recordMeta.startedAt || Date.now(),
    endedAt: Date.now(),
    mime,
    bytes: blob.size,
    blob,
    recovered: true,
  };
  await saveVideo(record);
  await clearChunks();
  return { ok: true, record: { id, tabId: record.tabId, startedAt: record.startedAt, endedAt: record.endedAt, mime, bytes: blob.size } };
}

async function startFrames(message) {
  if (recorder && recorder.state === 'recording') return { ok: false, error: '已经在录制中' };
  const mime = pickMime(message.mimeType);
  if (!mime) return { ok: false, error: '浏览器不支持可用的录制格式' };
  const options = normalizeVideoOptions({ width: message.width, height: message.height, fps: message.fps, bitrate: message.bitrate });
  const width = options.width;
  const height = options.height;
  const fps = options.fps;
  // 注意：OffscreenCanvas 没有 captureStream；离屏文档里有 DOM，用普通 canvas。
  canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  context2d = canvas.getContext('2d');
  context2d.fillStyle = '#000000';
  context2d.fillRect(0, 0, width, height);
  stream = canvas.captureStream(fps);
  chunks = [];
  chunkIndex = 0;
  await clearChunks().catch(() => {});
  mode = 'frames';
  meta = {
    recordingId: message.recordingId || '',
    tabId: message.tabId,
    url: message.url || '',
    title: message.title || '',
    startedAt: Date.now(),
    mime,
  };
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: options.bitrate });
  recorder.ondataavailable = (event) => onData(event.data);
  recorder.onstop = () => finishRecording(meta, mime);
  recorder.start(1000);
  scheduleAutoStop(message.durationMs);
  trace('started-frames', { mime, tabId: message.tabId, durationMs: message.durationMs });
  return { ok: true, mime, startedAt: meta.startedAt, mode: 'frames' };
}

async function drawFrame(dataUrl) {
  if (mode !== 'frames' || !context2d || !canvas) return;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    context2d.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
  } catch {
    // 坏帧直接丢弃
  }
}

async function finishRecording(recordMeta, mime) {
  trace('onstop', { bytesPending: chunks.reduce((sum, chunk) => sum + chunk.size, 0) });
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  try {
    const blob = new Blob(chunks, { type: mime });
    const id = recordMeta.recordingId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const record = {
      id,
      tabId: recordMeta.tabId,
      url: recordMeta.url,
      title: recordMeta.title,
      startedAt: recordMeta.startedAt,
      endedAt: Date.now(),
      mime,
      bytes: blob.size,
      blob,
    };
    await saveVideo(record);
    trace('saved', { id, bytes: blob.size });
    chrome.runtime.sendMessage({ type: 'bb.rec.done', id, bytes: blob.size, mime, tabId: recordMeta.tabId }).catch(() => {});
  } catch (error) {
    trace('save-failed', { error: String((error && error.message) || error) });
    chrome.runtime.sendMessage({ type: 'bb.rec.error', error: String((error && error.message) || error) }).catch(() => {});
  } finally {
    await clearChunks().catch(() => {});
    chunkIndex = 0;
    chunks = [];
    meta = null;
    mode = null;
    canvas = null;
    context2d = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* 忽略 */ }
      }
    }
    stream = null;
    recorder = null;
  }
}

async function startRecording(message) {
  if (recorder && recorder.state === 'recording') return { ok: false, error: '已经在录制中' };
  const mime = pickMime(message.mimeType);
  if (!mime) return { ok: false, error: '浏览器不支持可用的录制格式' };
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: message.streamId,
      },
    },
  });
  chunks = [];
  chunkIndex = 0;
  await clearChunks().catch(() => {});
  meta = {
    recordingId: message.recordingId || '',
    tabId: message.tabId,
    url: message.url || '',
    title: message.title || '',
    startedAt: Date.now(),
    mime,
  };
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4000000 });
  mode = 'stream';
  recorder.ondataavailable = (event) => onData(event.data);
  const recordMeta = meta;
  recorder.onstop = () => finishRecording(recordMeta, mime);
  recorder.start(1000);
  scheduleAutoStop(message.durationMs);
  trace('started-stream', { mime, tabId: message.tabId, durationMs: message.durationMs });
  return { ok: true, mime, startedAt: meta.startedAt, mode: 'stream' };
}

async function stopRecording() {
  if (!recorder) return { ok: false, error: '当前没有录制' };
  if (recorder.state === 'recording') recorder.stop();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;
  if (message.type === 'bb.rec.start') {
    startRecording(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }
  if (message.type === 'bb.rec.start-frames') {
    startFrames(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }
  if (message.type === 'bb.rec.frame') {
    drawFrame(message.data).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'bb.rec.recover') {
    recoverChunks()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }
  if (message.type === 'bb.rec.status') {
    sendResponse({
      ok: true,
      active: Boolean(recorder && recorder.state === 'recording'),
      state: recorder ? recorder.state : 'idle',
      meta: meta || null,
    });
    return false;
  }
  if (message.type === 'bb.rec.stop') {
    stopRecording()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }
  return false;
});
