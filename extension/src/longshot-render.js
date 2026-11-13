// src/longshot-render.js —— 拼接画布布局（纯函数，便于单测）。
export function layoutCanvas(frames, { width, totalHeight } = {}) {
  const limit = Math.max(1, Math.round(Number(totalHeight) || 1));
  const w = Math.max(1, Math.round(Number(width) || 1));
  const source = Array.isArray(frames) ? frames : [];
  const placements = source.map((frame, index) => {
    const bitmapHeight = Math.max(1, Math.round(Number(frame && frame.bitmapHeight) || 1));
    const drawY = Math.max(0, Math.min(Math.round(Number(frame && frame.drawY) || 0), Math.max(0, limit - bitmapHeight)));
    return { index, drawY, bitmapHeight };
  });
  let capturedBottom = 0;
  for (const placement of placements) capturedBottom = Math.max(capturedBottom, placement.drawY + placement.bitmapHeight);
  return {
    width: w,
    height: Math.max(1, Math.min(limit, capturedBottom || limit)),
    placements,
  };
}
