// lib/capture-stream.js —— 大截图的扩展侧暂存与分块读取（纯逻辑，便于单测）。
//
// 背景：full-page 截图的 dataUrl 可能有数 MB，单次 RPC 直接返回会撑大消息/内存。
// 这里让扩展把 base64 暂存在内存（TTL + 上限），只返回 captureId + bytes；
// CLI 用 screenshot.read 按 offset 分块取、拼回文件，最后 screenshot.release。
//
// 分块单位是 **base64 字符**（不是解码后的字节）：CLI 按顺序拼 base64 再解码，
// 不会在块边界破坏 padding（只有最后一块可能含 '='）。

export const CAPTURE_TTL_MS = 5 * 60 * 1000;
export const CAPTURE_MAX = 4;
export const CAPTURE_CHUNK_CHARS = 512 * 1024;

function randomId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return 'cap_' + globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  } catch { /* 忽略 */ }
  return 'cap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function dataUrlBase64(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  if (comma < 0 || !/^data:image\//i.test(text.slice(0, comma))) return null;
  const base64 = text.slice(comma + 1);
  return base64 || null;
}

function base64ByteLength(base64) {
  const text = String(base64 || '');
  const padding = text.endsWith('==') ? 2 : (text.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor(text.length * 3 / 4) - padding);
}

export function createCaptureStore({ ttlMs = CAPTURE_TTL_MS, maxCaptures = CAPTURE_MAX, now = () => Date.now() } = {}) {
  const entries = new Map();

  function sweep(at = now()) {
    for (const [id, entry] of entries) {
      if (at - entry.at > ttlMs) entries.delete(id);
    }
  }

  return {
    put({ dataUrl, width = null, height = null, via = null } = {}) {
      const base64 = dataUrlBase64(dataUrl);
      if (!base64) return null;
      const at = now();
      sweep(at);
      while (entries.size >= maxCaptures) entries.delete(entries.keys().next().value);
      const id = randomId();
      entries.set(id, { base64, width, height, via, at, bytes: base64ByteLength(base64) });
      return { captureId: id, bytes: entries.get(id).bytes, width, height };
    },

    read(id, { offset = 0, length = CAPTURE_CHUNK_CHARS } = {}) {
      sweep();
      const entry = entries.get(String(id || ''));
      if (!entry) return null;
      const total = entry.base64.length;
      const start = Math.min(Math.max(Math.floor(Number(offset) || 0), 0), total);
      const size = Math.min(Math.max(Math.floor(Number(length) || CAPTURE_CHUNK_CHARS), 1), 4 * 1024 * 1024);
      const end = Math.min(start + size, total);
      return {
        dataBase64: entry.base64.slice(start, end),
        offset: start,
        nextOffset: end,
        total,
        bytes: entry.bytes,
        eof: end >= total,
        width: entry.width,
        height: entry.height,
        via: entry.via,
      };
    },

    release(id) {
      return entries.delete(String(id || ''));
    },

    size() {
      return entries.size;
    },

    sweep,
  };
}
