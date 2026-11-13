// src/video-encoder.js —— 录制格式与参数归一化（纯函数）。
export const VIDEO_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
];

export function pickVideoMime(supported, { preferred = '', candidates = VIDEO_MIME_CANDIDATES } = {}) {
  const list = preferred ? [preferred].concat(candidates) : candidates.slice();
  for (const mime of list) {
    try {
      if (supported(mime)) return mime;
    } catch {
      // 继续尝试下一个
    }
  }
  return '';
}

export function normalizeVideoOptions({ width, height, fps, bitrate } = {}, { maxWidth = 1280, maxHeight = 800, maxFps = 30 } = {}) {
  const w = Number(width) > 0 ? Math.round(Number(width)) : maxWidth;
  const h = Number(height) > 0 ? Math.round(Number(height)) : maxHeight;
  const scale = Math.min(1, maxWidth / Math.max(1, w), maxHeight / Math.max(1, h));
  return {
    width: Math.max(2, Math.floor((w * scale) / 2) * 2),
    height: Math.max(2, Math.floor((h * scale) / 2) * 2),
    fps: Math.min(Math.max(Number(fps) > 0 ? Number(fps) : 10, 2), maxFps),
    bitrate: Math.max(100000, Number(bitrate) > 0 ? Number(bitrate) : 4000000),
  };
}
