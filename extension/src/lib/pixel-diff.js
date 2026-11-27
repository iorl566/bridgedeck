/** YIQ 感知像素差（pixelmatch 同量纲），纯函数；输入为 RGBA 字节数组。 */
export function diffRgba(previous, next, width, height, options = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
  if (!previous || !next || previous.length !== next.length || previous.length !== w * h * 4) return null;
  const threshold = Math.min(Math.max(Number(options.threshold) || 0.1, 0), 1);
  const maxDelta = 35215 * threshold * threshold;
  let changed = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const dr = previous[i] - next[i];
      const dg = previous[i + 1] - next[i + 1];
      const db = previous[i + 2] - next[i + 2];
      const da = previous[i + 3] - next[i + 3];
      const yy = 0.29889531 * dr + 0.58662247 * dg + 0.11448223 * db;
      const ii = 0.59597799 * dr - 0.2741761 * dg - 0.32180189 * db;
      const qq = 0.21147017 * dr - 0.52261711 * dg + 0.31114694 * db;
      const delta = 0.5053 * yy * yy + 0.299 * ii * ii + 0.1957 * qq * qq + da * da;
      if (delta <= maxDelta) continue;
      changed += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const total = w * h;
  return {
    changed,
    total,
    ratio: total ? Math.round((changed / total) * 10000) / 10000 : 0,
    threshold,
    bbox: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}
