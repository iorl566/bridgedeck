// lib/transport-frame.mjs —— WebSocket 文本帧解码与大小上限。
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function frameBytes(raw) {
  return Buffer.byteLength(typeof raw === 'string' ? raw : String(raw), 'utf8');
}

export function decodeTextFrame(raw, { maxBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  const bytes = frameBytes(raw);
  if (bytes > Math.max(1, Number(maxBytes) || DEFAULT_MAX_FRAME_BYTES)) {
    return { ok: false, code: 'E_TOO_LARGE', bytes };
  }
  try {
    return { ok: true, value: JSON.parse(String(raw)), bytes };
  } catch {
    return { ok: false, code: 'E_BAD_JSON', bytes };
  }
}
