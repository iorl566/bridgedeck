// src/capture-persist.js —— 长截图分片落盘 + 可恢复 manifest（崩溃/关页后仍可恢复）。
import { log } from './log.js';
import { buildCaptureManifest, upsertCaptureManifest } from './lib/capture-manifest.js';
import { pruneLongshots, saveLongshot } from './lib/longshot-store.js';

const MANIFEST_KEY = 'bb.capture.manifests';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MANIFESTS = 8;
const MAX_BYTES = 32 * 1024 * 1024;

function captureId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch { /* 忽略 */ }
  return 'cap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function normalizeFrames(frames) {
  return (Array.isArray(frames) ? frames : [])
    .filter((frame) => frame && typeof frame.dataUrl === 'string' && frame.dataUrl.length > 0)
    .map((frame) => {
      const record = {
        dataUrl: frame.dataUrl,
        width: Math.max(0, Math.round(Number(frame.width) || 0)),
        height: Math.max(0, Math.round(Number(frame.height) || 0)),
      };
      if (Number.isFinite(Number(frame.drawY))) record.drawY = Math.max(0, Math.round(Number(frame.drawY)));
      return record;
    });
}

/**
 * 持久化一次长截图。任何失败都只记日志并返回 {ok:false}，不影响截图本身。
 * @returns {Promise<{ok:boolean, id?:string, tiles?:number, reason?:string}>}
 */
export async function persistLongshotCapture({ id, url = '', width = 0, height = 0, frames = [] } = {}) {
  const chunks = normalizeFrames(frames);
  if (!chunks.length) return { ok: false, reason: 'no-frames' };
  const bytes = chunks.reduce((sum, frame) => sum + frame.dataUrl.length, 0);
  if (bytes > MAX_BYTES) {
    log('长截图过大，跳过本地分片持久化：' + bytes + 'B');
    return { ok: false, reason: 'too-large' };
  }
  const capture = id ? String(id) : captureId();
  try {
    const saved = await saveLongshot(capture, chunks);
    const stored = await chrome.storage.local.get(MANIFEST_KEY);
    const list = Array.isArray(stored && stored[MANIFEST_KEY]) ? stored[MANIFEST_KEY] : [];
    const entry = buildCaptureManifest({
      id: capture,
      kind: 'longshot',
      width,
      height,
      tiles: saved,
      url,
      now: Date.now(),
    });
    const manifests = upsertCaptureManifest(list, entry, { ttlMs: TTL_MS, max: MAX_MANIFESTS });
    await chrome.storage.local.set({ [MANIFEST_KEY]: manifests });
    const valid = manifests.filter((item) => item && item.kind === 'longshot' && item.id).map((item) => item.id);
    await pruneLongshots(valid).catch((error) => log('清理长截图分片失败：' + ((error && error.message) || error)));
    log('长截图分片已落盘 id=' + capture + ' tiles=' + saved + ' manifests=' + manifests.length);
    return { ok: true, id: capture, tiles: saved };
  } catch (error) {
    log('长截图分片持久化失败：' + ((error && error.message) || error));
    return { ok: false, reason: 'persist-failed' };
  }
}
