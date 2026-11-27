// lib/longshot-stitch.js —— 拼接布局的覆盖分析（缺口/重叠/尾部未覆盖）与渲染计划（纯函数）。
//
// 现状：src/longshot-render.js 的 layoutCanvas() 只做“把每帧裁剪进画布 + 算总高”，
// planStitch() 再做“按 drawY 或顺序累加”。它们保证“画得出来”，但不保证“画得对”：
//   1) 中间少一帧（相机/滚动失败、tile 落盘失败）时，画布高度按已拍内容收缩，用户看到一张
//      变短的图却不知道底部被截断了（没有任何证据）；
//   2) 滚动重叠（overlap>0）时相邻帧有重复像素，但没有任何“哪几帧重叠了多少”的记录，
//      final exposure 帧更可能整块覆盖上一帧；
//   3) `drawY` 被夹到画布内（Math.min(drawY, limit - bitmapHeight)）后，帧与帧的相对位置可能
//      被悄悄改变，接缝错位却没有证据。
//
// 本模块把“拼完之后到底覆盖了哪些像素行、哪里缺、哪里重、尾部差多少”算清楚：
//   analyzePlacements() —— 逐帧布局的覆盖分析（gaps/overlaps/覆盖比/尾部/hash 签名）；
//   stitchCoverage()    —— 直接从 frames 算（不必先 layout）；
//   planRenderLayout()  —— 覆盖分析 + 修正后的 placements（drawY 抖动 > snapTolerance 时给出提示）；
//   describeStitch()    —— 一行日志；
//   stitchWire()        —— 协议字段（只加字段，旧字段不动）。
//
// 坐标约定：placements 是设备像素、画布内坐标；totalHeight 是目标画布高度。

export const STITCH_DEFAULTS = Object.freeze({
  // 允许的 drawY 抖动（设备像素）：超过就认为布局被 clamp 改过。
  snapTolerance: 1,
  // 覆盖率低于该值视为“明显缺帧”（用于 degraded 标记）。
  minCoverageRatio: 0.98,
  // 协议里最多列出几段缺口/重叠。
  maxListed: 8,
});

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function clampInt(value, min, max, fallback) {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

/** 归一化 placements：只保留 {drawY, height}，并按 drawY 稳定排序（index 保持原序号）。 */
export function normalizePlacements(frames) {
  const list = Array.isArray(frames) ? frames : [];
  const placements = [];
  for (let index = 0; index < list.length; index += 1) {
    const frame = list[index] && typeof list[index] === 'object' ? list[index] : {};
    const drawY = Math.max(0, intOr(frame.drawY, 0));
    const height = Math.max(1, intOr(frame.bitmapHeight != null ? frame.bitmapHeight : frame.height, 1));
    placements.push({ index, drawY, height, requestedY: intOr(frame.requestedY != null ? frame.requestedY : frame.drawY, drawY) });
  }
  return placements;
}

/**
 * 覆盖分析：把 placements 排序后算缺口/重叠/覆盖比。
 * @returns {{
 *   ok: boolean, totalHeight: number, width: number, covered: number, coverageRatio: number,
 *   gaps: Array<{from: number, to: number}>, overlaps: Array<{from: number, to: number, by: number, frames: number[]}>,
 *   tail: number, head: number, clamped: number, frames: number, seamless: boolean,
 *   degraded: boolean, signature: string,
 * }}
 */
export function analyzePlacements(frames, options = {}) {
  const raw = normalizePlacements(frames);
  const width = Math.max(1, intOr(options.width, 1));
  const explicitTotal = options.totalHeight != null ? Math.max(0, intOr(options.totalHeight, 0)) : 0;
  const ordered = raw.slice().sort((a, b) => a.drawY - b.drawY || a.index - b.index);
  let capturedBottom = 0;
  let covered = 0;
  const gaps = [];
  const overlaps = [];
  let cursor = 0;
  let clamped = 0;
  const tolerance = Math.max(0, intOr(options.snapTolerance, STITCH_DEFAULTS.snapTolerance));
  for (const placement of ordered) {
    const top = placement.drawY;
    const bottom = top + placement.height;
    if (placement.requestedY !== placement.drawY && Math.abs(placement.requestedY - placement.drawY) > tolerance) {
      clamped += 1;
    }
    if (top > cursor) {
      gaps.push({ from: cursor, to: top });
    } else if (top < cursor) {
      const from = top;
      const to = Math.min(cursor, bottom);
      const by = to - from;
      if (by > 0) {
        const previous = overlaps.find((item) => item.to === cursor || Math.abs(item.from - from) <= tolerance);
        if (previous) {
          previous.by += by;
          previous.frames.push(placement.index);
        } else {
          overlaps.push({ from, to, by, frames: [placement.index] });
        }
      }
    }
    covered += Math.max(0, bottom - Math.max(top, cursor));
    cursor = Math.max(cursor, bottom);
    capturedBottom = Math.max(capturedBottom, bottom);
  }
  const totalHeight = explicitTotal > 0 ? explicitTotal : Math.max(1, capturedBottom);
  // 尾部未覆盖也记成一段缺口：调用方可以直接把 gaps 转成补拍区间。
  if (capturedBottom < totalHeight) gaps.push({ from: capturedBottom, to: totalHeight });
  const clampedCovered = Math.min(covered, totalHeight);
  const coverageRatio = totalHeight > 0 ? Math.min(1, Math.round((clampedCovered / totalHeight) * 1000) / 1000) : 0;
  const head = ordered.length ? Math.max(0, ordered[0].drawY) : 0;
  const tail = Math.max(0, totalHeight - Math.min(capturedBottom, totalHeight));
  const seamless = gaps.length === 0 && clamped === 0 && tail === 0;
  const degraded = coverageRatio < STITCH_DEFAULTS.minCoverageRatio || clamped > 0;
  return {
    ok: ordered.length > 0,
    totalHeight,
    width,
    covered: clampedCovered,
    coverageRatio,
    gaps,
    overlaps,
    tail,
    head,
    clamped,
    frames: ordered.length,
    seamless,
    degraded,
    // 覆盖签名：帧边界 + 画布高度，不含图片内容，用于日志去重与 frameSignature 互补。
    signature: 'stitch:' + totalHeight + ':' + ordered.map((placement) => placement.drawY + '+' + placement.height).join(','),
  };
}

/** 直接从 frames 算覆盖（layout 之前即可用，tiled-capture 落盘前自检用）。 */
export function stitchCoverage(frames, options = {}) {
  return analyzePlacements(frames, options);
}

/**
 * 渲染布局：覆盖分析 + 修正 placements（同 layoutCanvas 的 clamp 语义，但保留 requestedY 证据）。
 * @returns {{ok: boolean, width: number, height: number, placements: Array<object>, coverage: object}}
 */
export function planRenderLayout(frames, options = {}) {
  const width = Math.max(1, intOr(options.width, 1));
  const limit = Math.max(1, intOr(options.totalHeight, 1));
  const list = Array.isArray(frames) ? frames : [];
  const placements = list.map((frame, index) => {
    const bitmapHeight = Math.max(1, intOr(frame && frame.bitmapHeight, 1));
    const requestedY = Math.max(0, intOr(frame && frame.drawY, 0));
    const drawY = Math.max(0, Math.min(requestedY, Math.max(0, limit - bitmapHeight)));
    return { index, drawY, bitmapHeight, requestedY, wasClamped: drawY !== requestedY };
  });
  const coverage = analyzePlacements(placements.map((placement) => ({
    drawY: placement.drawY,
    bitmapHeight: placement.bitmapHeight,
    requestedY: placement.requestedY,
  })), { width, totalHeight: limit });
  return {
    ok: coverage.ok,
    width,
    height: coverage.totalHeight,
    placements,
    coverage,
  };
}

/** 协议 wire：只带计数与头几段证据，避免把 placements 全塞进结果。 */
export function stitchWire(analysis, options = {}) {
  if (!analysis || typeof analysis !== 'object') {
    return { ok: false, frames: 0, coverage_ratio: 0, gaps: 0, overlaps: 0, tail: 0 };
  }
  const maxListed = clampInt(options.maxListed, 0, 32, STITCH_DEFAULTS.maxListed);
  return {
    ok: analysis.ok === true,
    frames: intOr(analysis.frames, 0),
    width: intOr(analysis.width, 1),
    height: intOr(analysis.totalHeight, 0),
    covered: intOr(analysis.covered, 0),
    coverage_ratio: Number(analysis.coverageRatio) || 0,
    gaps: (Array.isArray(analysis.gaps) ? analysis.gaps : []).length,
    gap_list: (Array.isArray(analysis.gaps) ? analysis.gaps : []).slice(0, maxListed),
    overlaps: (Array.isArray(analysis.overlaps) ? analysis.overlaps : []).length,
    overlap_list: (Array.isArray(analysis.overlaps) ? analysis.overlaps : []).slice(0, maxListed),
    tail: intOr(analysis.tail, 0),
    head: intOr(analysis.head, 0),
    clamped: intOr(analysis.clamped, 0),
    seamless: analysis.seamless === true,
    degraded: analysis.degraded === true,
    signature: String(analysis.signature || 'stitch:none'),
  };
}

/** 一行日志：'拼接 12 帧 22500px 覆盖 100%（无缝）'。 */
export function describeStitch(analysis) {
  if (!analysis || typeof analysis !== 'object') return '拼接 无布局';
  if (!analysis.ok) return '拼接 空（0 帧）';
  const percent = Math.round((Number(analysis.coverageRatio) || 0) * 1000) / 10;
  const parts = ['拼接 ' + intOr(analysis.frames, 0) + ' 帧 ' + intOr(analysis.totalHeight, 0) + 'px 覆盖 ' + percent + '%'];
  if (analysis.gaps && analysis.gaps.length) parts.push('缺 ' + analysis.gaps.length + ' 段');
  if (analysis.overlaps && analysis.overlaps.length) parts.push('叠 ' + analysis.overlaps.length + ' 段');
  if (analysis.tail > 0) parts.push('尾部差 ' + analysis.tail + 'px');
  if (analysis.clamped > 0) parts.push('夹取 ' + analysis.clamped + ' 帧');
  return parts.join('，') + (analysis.seamless ? '（无缝）' : '');
}

/** 缺口 → 需要补拍的页面区间（extend/rewrite 恢复用）。 */
export function gapsToCaptureRanges(gaps, options = {}) {
  const minHeight = Math.max(1, intOr(options.minHeight, 1));
  return (Array.isArray(gaps) ? gaps : [])
    .map((gap) => ({ pageY: Math.max(0, intOr(gap && gap.from, 0)), pageHeight: Math.max(0, intOr(gap && gap.to, 0) - intOr(gap && gap.from, 0)) }))
    .filter((range) => range.pageHeight >= minHeight);
}

/** 重叠是否“可安全接受”：by ≤ tolerance 的重叠是半行取整，不算错位。 */
export function acceptableOverlaps(analysis, options = {}) {
  const tolerance = Math.max(0, intOr(options.snapTolerance, STITCH_DEFAULTS.snapTolerance));
  const overlaps = analysis && Array.isArray(analysis.overlaps) ? analysis.overlaps : [];
  return overlaps.filter((overlap) => intOr(overlap && overlap.by, 0) <= tolerance);
}
