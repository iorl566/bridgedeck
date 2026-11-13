// src/longshot-schedule.js —— 长截图 tile 调度（纯函数）。
export function nextGrowthTiles(positions, { scrollHeight, step, maxTiles = 8 } = {}) {
  const current = Array.isArray(positions) ? positions.slice() : [];
  const height = Math.max(0, Number(scrollHeight) || 0);
  const stride = Math.max(1, Number(step) || 1);
  const limit = Math.max(1, Number(maxTiles) || 1);
  let last = current.length ? current[current.length - 1] : 0;
  while (current.length < limit && last + stride < height) {
    last += stride;
    current.push(last);
  }
  return current;
}

export function tileForScroll(scrollY, step, index) {
  const y = Number(scrollY);
  if (Number.isFinite(y) && y >= 0) return y;
  return Math.max(0, Number(index) || 0) * Math.max(1, Number(step) || 1);
}
