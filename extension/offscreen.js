// offscreen.js —— 用 tabCapture 的 streamId 录 MP4（离屏文档里跑 MediaRecorder）
import { pickVideoMime, normalizeVideoOptions } from './src/video-encoder.js';
import { fragmentJournalFromBlob, completeFragmentPackage } from './src/lib/mp4-fragments.js';
import { analyzeRecording } from './src/lib/video-analysis.js';
import { CanvasSource, Output, Mp4OutputFormat, StreamTarget } from './vendor/mediabunny/mediabunny.min.mjs';
import { openDb, saveVideo, clearChunks, readChunks, CHUNK_STORE } from './src/lib/offscreen-store.js';
import { sha256Hex, base64OfBytes, journalSummary, chunksHavePosition } from './src/lib/video-meta.js';
import { createOffscreenRecovery } from './src/lib/offscreen-recovery.js';
import { readEncodedChunks, assembleEncodedBlob } from './src/lib/encoded-blob.js';
import { createEncodedWriter } from './src/lib/encoded-writer.js';

const encodedWriter = createEncodedWriter({ openDb, CHUNK_STORE, writeEncodedPart, getEncodedMeta: () => encodedMeta });

const recovery = createOffscreenRecovery({
  readChunks, saveVideo, clearChunks, analyzeRecording, sha256Hex, journalSummary, assembleEncodedParts, assembleEncodedBlob, listEncodedManifests, clearEncodedParts, getStorageState: () => storageState,
});
import { writeEncodedPart, listEncodedParts, clearEncodedParts, writeEncodedManifest, listEncodedManifests, assembleEncodedParts, verifyEncodedParts, sealEncodedManifest } from './src/lib/opfs-encoded-store.js';
let recorder = null;
let stream = null;
let chunks = [];
let chunkWrites = Promise.resolve();
let encoderSession = null;
let encodedBlob = null;
let fragmentLog = [];
const fragmentHashes = new Map();
let meta = null;
let mode = null;
let canvas = null;
let context2d = null;
let stopTimer = null;

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









/** 扫描分片日记（并可让 worker 做完整分片重封装）：优先 worker，失败则主线程兜底。 */






function onData(data) {
  if (!data || !data.size) return;
  const entry = { index: encodedWriter.currentChunkIndex(), at: Date.now(), bytes: data.size, sha256: '' };
  fragmentLog.push(entry);
  const hashPromise = sha256Hex(data).then((hash) => { entry.sha256 = hash; }).catch(() => {});
  fragmentHashes.set(entry.index, hashPromise);
  // 分片直接进 IndexedDB；只有落盘失败时才留在内存兜底，避免长时间录制内存线性增长。
  chunkWrites = chunkWrites.then(() => encodedWriter.storeChunk(data, meta)).catch(() => { chunks.push({ index: entry.index, blob: data }); });
}

function scheduleAutoStop(durationMs) {
  const limit = Number(durationMs) > 0 ? Math.min(Number(durationMs), 10 * 60 * 1000) : 0;
  if (!limit) return;
  stopTimer = setTimeout(() => {
    stopTimer = null;
    if (meta && !meta.stopReason) meta.stopReason = 'duration';
    if (encoderSession) {
      stopRecording().catch(() => {});
      return;
    }
    try {
      if (recorder && recorder.state === 'recording') recorder.stop();
    } catch {
      // 忽略
    }
  }, limit);
}





let storageState = null;
let encodedMeta = null;
async function probeStorage() {
  storageState = { persisted: false, quota: null, usage: null };
  try {
    const persisted = await navigator.storage.persist().catch(() => false);
    const estimate = await navigator.storage.estimate().catch(() => null);
    storageState = {
      persisted: persisted === true,
      quota: estimate && Number.isFinite(Number(estimate.quota)) ? Number(estimate.quota) : null,
      usage: estimate && Number.isFinite(Number(estimate.usage)) ? Number(estimate.usage) : null,
    };
  } catch {
    // 存储能力探测失败不阻断录制
  }
  return storageState;
}

async function startFrames(message) {
  if ((recorder && recorder.state === 'recording') || encoderSession) return { ok: false, error: '已经在录制中' };
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
  chunks = [];
  chunkWrites = Promise.resolve();
  encodedWriter.reset();
  fragmentLog = [];
  fragmentHashes.clear();
  await clearChunks().catch(() => {});
  await clearEncodedParts(message.recordingId).catch(() => {});
  await probeStorage();
  encodedMeta = { recordingId: message.recordingId, tabId: message.tabId, url: message.url || '', title: message.title || '', startedAt: Date.now(), mime: 'video/mp4' };
  await writeEncodedManifest(message.recordingId, { ...encodedMeta, mode: 'frames' }).catch(() => {});
  mode = 'frames';
  if (message.encoder === 'avc') {
    try {
      
      const target = new StreamTarget(new WritableStream({
        write: (chunk) => encodedWriter.storeEncodedChunk(message.recordingId, chunk.position, chunk.data),
      }), { chunkSize: 1024 * 1024 });
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
      const source = new CanvasSource(canvas, { codec: 'avc', bitrate: options.bitrate });
      output.addVideoTrack(source);
      await output.start();
      encoderSession = {
        output, source, target,
        recordingId: message.recordingId || '',
        fps: Math.max(1, Number(fps) || 10),
        frames: 0,
        queue: Promise.resolve(),
      };
      meta = {
        recordingId: message.recordingId || '',
        tabId: message.tabId,
        url: message.url || '',
        title: message.title || '',
        startedAt: Date.now(),
        mime: 'video/mp4',
      };
      scheduleAutoStop(message.durationMs);
      trace('started-encoder', { tabId: message.tabId, durationMs: message.durationMs });
      return { ok: true, mime: 'video/mp4', startedAt: meta.startedAt, mode: 'frames', encoder: 'avc' };
    } catch (error) {
      encoderSession = null;
      return { ok: false, error: 'VideoEncoder 不可用：' + String((error && error.message) || error) };
    }
  }
  stream = canvas.captureStream(fps);
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
    if (encoderSession) {
      const session = encoderSession;
      const timestamp = session.frames / session.fps;
      session.frames += 1;
      session.queue = session.queue
        .then(() => session.source.add(timestamp, 1 / session.fps))
        .catch(() => {});
    }
  } catch {
    // 坏帧直接丢弃
  }
}

async function finishRecording(recordMeta, mime) {
  trace('onstop', { bytesPending: fragmentLog.reduce((sum, item) => sum + Number(item.bytes || 0), 0) });
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  try {
    if (encodedBlob) {
      const blob = encodedBlob;
      encodedBlob = null;
      const sha256 = await sha256Hex(blob);
      const durability = await verifyEncodedParts(recordMeta.recordingId).catch(() => ({ ok: false, reason: 'verify_failed' }));
      const id = recordMeta.recordingId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
      const record = {
        id,
        tabId: recordMeta.tabId,
        url: recordMeta.url,
        title: recordMeta.title,
        startedAt: recordMeta.startedAt,
        endedAt: Date.now(),
        mime: 'video/mp4',
        bytes: blob.size,
        completeness: durability.ok ? 'complete' : 'partial',
        stop_reason: recordMeta.stopReason || 'user',
        chunk_count: 1,
        fragments: [{ index: 0, bytes: blob.size, sha256 }],
        finish_via: 'encoder',
        durability: durability.ok ? 'verified' : 'unverified',
        durability_parts: durability.parts || 0,
        ...(durability.ok ? {} : { durability_reason: durability.reason || 'unknown' }),
        durability_policy: 'browser-readback',
        fsync_supported: false,
        storage_persisted: storageState ? storageState.persisted : false,
        storage_quota: storageState ? storageState.quota : null,
        complete_frames: true,
        faststart: true,
        blob,
      };
      await saveVideo(record);
      await sealEncodedManifest(id, { endedAt: record.endedAt, bytes: record.bytes }).catch(() => {});
      await clearEncodedParts(id).catch(() => {});
      trace('saved-encoder', { id, bytes: blob.size });
      chrome.runtime.sendMessage({ type: 'bb.rec.done', id, bytes: blob.size, mime: 'video/mp4', tabId: recordMeta.tabId }).catch(() => {});
      return;
    }
    await Promise.allSettled([...fragmentHashes.values()]);
    await chunkWrites.catch(() => {});
    const stored = await readChunks().catch(() => []);
    const records = [
      ...(Array.isArray(stored) ? stored : []).map((item) => ({ index: Number(item.index), blob: item.blob })),
      ...chunks,
    ].filter((item) => item && item.blob && item.blob.size).sort((a, b) => a.index - b.index);
    const parts = records.map((item) => item.blob);
    const rawBlob = new Blob(parts, { type: mime });
    const analyzed = await analyzeRecording(rawBlob, fragmentLog.slice(), true).catch(() => ({ journal: null, packaged: null }));
    const journal = analyzed.journal;
    // 完帧重封装：worker 算出 completeBytes 并裁好；不可用时主线程兜底。
    const packaged = analyzed.packaged || completeFragmentPackage(rawBlob, journal, fragmentLog.slice());
    const blob = packaged.blob;
    const id = recordMeta.recordingId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const chunkCount = packaged.chunkCount;
    const completeness = chunkCount > 0 && blob.size > 0 ? 'complete' : 'partial';
    const record = {
      id,
      tabId: recordMeta.tabId,
      url: recordMeta.url,
      title: recordMeta.title,
      startedAt: recordMeta.startedAt,
      endedAt: Date.now(),
      mime,
      bytes: blob.size,
      ...(packaged.trimmedBytes > 0 ? { raw_bytes: rawBlob.size, trimmed_bytes: packaged.trimmedBytes } : {}),
      completeness,
      stop_reason: recordMeta.stopReason || 'user',
      chunk_count: chunkCount,
      fragments: packaged.fragments,
      ...(journal ? { complete_frames: journal.completeFrames === true, journal: journalSummary(journal) } : {}),
      ...(analyzed.via ? { finish_via: analyzed.via } : {}),
      ...(analyzed.sidx ? {
        sidx_bytes: analyzed.sidx.sidx.byteLength,
        sidx_insert_at: analyzed.sidx.insertAt,
        sidx_base64: base64OfBytes(analyzed.sidx.sidx),
        indexed: true,
      } : {}),
      ...(analyzed.faststart ? {
        faststart: true,
        faststart_blob: analyzed.faststart.blob,
        faststart_bytes: analyzed.faststart.bytes,
        faststart_packets: analyzed.faststart.packets,
      } : {}),
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
    await clearEncodedParts(recordMeta.recordingId).catch(() => {});
    encodedWriter.reset();
    chunkWrites = Promise.resolve();
    chunks = [];
    fragmentLog = [];
    fragmentHashes.clear();
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
  chunkWrites = Promise.resolve();
  encodedWriter.reset();
  fragmentLog = [];
  fragmentHashes.clear();
  await clearChunks().catch(() => {});
  await clearEncodedParts(message.recordingId).catch(() => {});
  await probeStorage();
  encodedMeta = { recordingId: message.recordingId, tabId: message.tabId, url: message.url || '', title: message.title || '', startedAt: Date.now(), mime: 'video/mp4' };
  await writeEncodedManifest(message.recordingId, { ...encodedMeta, mode: 'stream' }).catch(() => {});
  if (message.encoder === 'avc' && typeof MediaStreamTrackProcessor === 'function') {
    try {
      const track = stream.getVideoTracks()[0];
      const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
      const width = Math.max(2, Number(settings.width) || 1280);
      const height = Math.max(2, Number(settings.height) || 800);
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      context2d = canvas.getContext('2d');
      
      const target = new StreamTarget(new WritableStream({
        write: (chunk) => encodedWriter.storeEncodedChunk(message.recordingId, chunk.position, chunk.data),
      }), { chunkSize: 1024 * 1024 });
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
      const source = new CanvasSource(canvas, { codec: 'avc', bitrate: 4000000 });
      output.addVideoTrack(source);
      await output.start();
      const processor = new MediaStreamTrackProcessor({ track });
      const reader = processor.readable.getReader();
      const session = {
        output, source, target, reader,
        recordingId: message.recordingId || '',
        fps: 30,
        frames: 0,
        queue: Promise.resolve(),
        running: true,
      };
      encoderSession = session;
      meta = {
        recordingId: message.recordingId || '',
        tabId: message.tabId,
        url: message.url || '',
        title: message.title || '',
        startedAt: Date.now(),
        mime: 'video/mp4',
      };
      mode = 'stream';
      (async () => {
        while (session.running) {
          const { value: frame, done } = await reader.read();
          if (done) break;
          try {
            context2d.drawImage(frame, 0, 0, width, height);
          } finally {
            frame.close();
          }
          const timestamp = session.frames / session.fps;
          session.frames += 1;
          await session.source.add(timestamp, 1 / session.fps).catch(() => {});
        }
      })().catch(() => {});
      scheduleAutoStop(message.durationMs);
      trace('started-stream-encoder', { tabId: message.tabId, width, height });
      return { ok: true, mime: 'video/mp4', startedAt: meta.startedAt, mode: 'stream', encoder: 'avc' };
    } catch {
      // TrackProcessor/VideoEncoder 不可用：回退 MediaRecorder。
      encoderSession = null;
      canvas = null;
      context2d = null;
    }
  }
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
  if (!recorder && !encoderSession) return { ok: false, error: '当前没有录制' };
  if (meta && !meta.stopReason) meta.stopReason = 'user';
  if (encoderSession) {
    await finalizeEncoder();
    await finishRecording(meta, 'video/mp4');
    return { ok: true };
  }
  if (recorder.state === 'recording') recorder.stop();
  return { ok: true };
}

async function finalizeEncoder() {
  const session = encoderSession;
  if (!session) return;
  encoderSession = null;
  session.running = false;
  if (session.reader) await session.reader.cancel().catch(() => {});
  await session.queue.catch(() => {});
  await session.output.finalize();
  encodedBlob = await assembleEncodedBlob(session.recordingId).catch(() => null);
  if (!encodedBlob) encodedBlob = new Blob([], { type: 'video/mp4' });
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
    recovery.recoverChunks()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }
  if (message.type === 'bb.rec.status') {
    sendResponse({
      ok: true,
      active: Boolean((recorder && recorder.state === 'recording') || encoderSession),
      state: encoderSession ? 'recording' : (recorder ? recorder.state : 'idle'),
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
