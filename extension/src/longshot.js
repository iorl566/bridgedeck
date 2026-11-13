// src/longshot.js —— 长截图分片规划与去重（纯函数，便于单测）。
export function planCaptureTiles({ scrollHeight, viewportHeight, maxTiles = 8, overlap = 0 } = {}) {
  const height = Math.max(0, Number(scrollHeight) || 0);
  const view = Math.max(1, Number(viewportHeight) || 1);
  const step = Math.max(1, view - Math.max(0, Number(overlap) || 0));
  const limit = Math.max(1, Number(maxTiles) || 1);
  const positions = [];
  for (let y = 0; y < height && positions.length < limit; y += step) positions.push(y);
  if (!positions.length) positions.push(0);
  return positions;
}

export function frameSignature(metrics) {
  const input = metrics && typeof metrics === 'object' ? metrics : {};
  return [
    Number(input.scrollHeight) || 0,
    Number(input.innerHeight) || 0,
    Number(input.bodyLength) || 0,
  ].join(':');
}

export function sameFrame(previous, current) {
  if (!previous || !current) return false;
  return frameSignature(previous) === frameSignature(current);
}

export function pruneCaptures(captures, { now = Date.now(), ttlMs = 600000, max = 20 } = {}) {
  for (const [key, capture] of captures) {
    if (!capture || now - Number(capture.at || 0) > ttlMs) captures.delete(key);
  }
  if (captures.size > max) {
    const ordered = [...captures.entries()].sort((a, b) => Number(a[1].at || 0) - Number(b[1].at || 0));
    while (captures.size > max && ordered.length) captures.delete(ordered.shift()[0]);
  }
  return captures;
}
