// lib/video-timeline.mjs —— 视频帧时间轴（纯函数，便于单测）。
export class VideoTimeline {
  constructor(fps, limitMs) {
    this.fps = Math.max(1, Number(fps) || 30);
    this.limitMs = Math.max(0, Number(limitMs) || 0);
    this.end = 0;
    this.lastKey = -Infinity;
  }

  advance(elapsedMs, final = false) {
    const next = Math.min(this.limitMs || Infinity, Math.max(0, Number(elapsedMs) || 0));
    if (!Number.isFinite(next) || next <= this.end) return null;
    if (!final && next - this.end < 1000 / this.fps) return null;
    const start = this.end;
    this.end = next;
    const keyFrame = start - this.lastKey >= 1000;
    if (keyFrame) this.lastKey = start;
    return {
      timestamp: Math.round(start * 1000),
      duration: Math.max(1, Math.round((next - start) * 1000)),
      keyFrame,
    };
  }

  get durationMs() {
    return this.end;
  }
}

export function videoDimensions(width, height, maximum) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('页面返回了无效的视频尺寸');
  }
  const limit = Math.max(2, Number(maximum) || 2);
  const scale = Math.min(1, limit / Math.max(width, height));
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2),
  };
}

export class FrameClock {
  constructor() {
    this.origin = undefined;
    this.last = 0;
  }

  elapsed(timestamp, monotonicElapsed) {
    const source = timestamp === undefined ? NaN : timestamp * 1000;
    if (this.origin === undefined && Number.isFinite(source)) this.origin = source - monotonicElapsed;
    const candidate = this.origin === undefined ? NaN : source - this.origin;
    const elapsed = Number.isFinite(candidate) && Math.abs(candidate - monotonicElapsed) < 1000
      ? candidate : monotonicElapsed;
    this.last = Math.max(this.last, elapsed, 0);
    return this.last;
  }
}
