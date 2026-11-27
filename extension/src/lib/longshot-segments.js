// lib/longshot-segments.js —— 多段固定顶/底带 + 分数 DPR 的分段拼接策略（纯函数）。
//
// 兼容目标的长截图是“磁盘 512px 分片 + 多段固定带 + index.json”，0.3.0 的分段路径
// （tiled-capture.captureSegments）只按 MAX_TILED_HEIGHT 切段：没有重叠区语义、段边界与
// CSS/设备像素换算散落在循环里、固定顶/底带只在“不分段”路径重绘。超大页一旦分段，
// 固定页眉/页脚就丢了，段与段之间也没有可配置的重叠来盖住接缝。
//
// 本模块把“怎么切段、每段画什么、固定带画在哪一段”收敛成纯函数：
//   * planFixedBands()          —— 从 page-metrics 事实算设备像素固定带高度（超页高 1/3 视为整页元素丢弃）；
//   * planLongshotSegments()    —— 段边界 + 重叠区 + 固定带重绘分布，每段输出
//                                  {index, y, height, dpr, fixedTop, fixedBottom, …}；
//   * tileRectsForSegment()     —— 段内 tile 的 CSS/设备/本地坐标换算（分数 DPR 下 CDP clip 用 CSS 坐标）；
//   * validateSegmentPlan()     —— 段边界连续性/覆盖完整性自检（运行时与单测共用）；
//   * locateSegment()/segmentsOverlapping() —— 页面 y → 段定位（stale 重写、恢复时定位用）。
//
// 坐标约定：
//   页面设备像素 pageY ∈ [0, deviceHeight)；每段覆盖 [pageY, pageY + pageHeight)。
//   为盖住接缝，第 i>0 段从上一段尾部借用 overlapTop 个设备像素一起拍，
//   因此绘制起点 drawY = pageY - overlapTop、绘制高度 drawHeight = pageHeight + overlapTop。
//   对外 wire 的 y/height/offsetY 都是“绘制”语义（可直接按 offsetY 拼回整页），
//   pageY/pageHeight 保留页面语义，便于定位与恢复。

import { normalizeDpr } from './longshot-budget.js';
import { bandSignature, normalizeBands } from './longshot-bands.js';
import { isFractionalDpr, quantizeDpr } from './longshot-dpr.js';
// 第十一批-E：段 wire 附带“帧身份”（帧级对账/重绘用），只加字段，不改既有键与语义。
import { segmentFrameIdentity } from './longshot-frame-reconcile.js';

export const SEGMENT_DEFAULTS = Object.freeze({
  maxSegmentHeight: 40000,
  minSegmentHeight: 256,
  overlap: 0,
  // 固定带高度超过页面 CSS 高度 1/3 时视为“整页容器”而不是固定带，避免把整页当页眉重绘。
  maxBandRatio: 1 / 3,
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

/** CSS 像素 → 设备像素（四舍五入；固定带/元素盒子用这个口径）。 */
export function toDevicePx(cssPx, dpr) {
  const scale = normalizeDpr(dpr);
  const value = Number(cssPx);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.round(value * scale));
}

/** CSS 尺寸 → 画布尺寸（向上取整且至少 1px；整页/段画布用这个口径）。 */
export function canvasDevicePx(cssPx, dpr) {
  const scale = normalizeDpr(dpr);
  const value = Number(cssPx);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.ceil(value * scale));
}

/** 设备像素 → CSS 像素（CDP clip 需要） 。 */
export function toCssPx(devicePx, dpr) {
  const scale = normalizeDpr(dpr);
  const value = Number(devicePx);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / scale;
}

/**
 * 从 page-metrics 事实计算固定顶/底带（设备像素）。
 * 与 0.3.0 tiled-capture 的口径逐字保持一致：
 *   topDev = fixedTopHeight > 0 && fixedTopHeight < (deviceHeight/dpr)/3 ? round(fixedTopHeight*dpr) : 0
 * 只是把这段公式从运行时里提出来，供“分段/不分段”两条路径共用。
 */
export function planFixedBands(options = {}) {
  const metrics = options.metrics && typeof options.metrics === 'object' ? options.metrics : null;
  const dpr = normalizeDpr(options.dpr);
  const deviceHeight = Math.max(0, intOr(options.deviceHeight, 0));
  const maxRatio = Number.isFinite(Number(options.maxBandRatio)) && Number(options.maxBandRatio) > 0
    ? Number(options.maxBandRatio)
    : SEGMENT_DEFAULTS.maxBandRatio;
  if (!metrics) {
    return {
      measured: false, dpr, fixedTop: 0, fixedBottom: 0, topCss: 0, bottomCss: 0, cssHeight: 0, bands: [],
      // 第十批-D：多段固定带证据（无 metrics 时为空，字段形状保持稳定）。
      bandPlan: null, bandCount: 0, bandKinds: [], bandDropped: [], bandSignature: 'bands:none', bandDerived: false,
    };
  }
  const cssHeight = deviceHeight > 0 ? deviceHeight / dpr : 0;
  const topCss = Math.max(0, intOr(metrics.fixedTopHeight, 0));
  const bottomCss = Math.max(0, intOr(metrics.fixedBottomHeight, 0));
  const limit = cssHeight > 0 ? cssHeight * maxRatio : Infinity;
  const fixedTop = topCss > 0 && topCss < limit ? toDevicePx(topCss, dpr) : 0;
  const fixedBottom = bottomCss > 0 && bottomCss < limit ? toDevicePx(bottomCss, dpr) : 0;
  const bands = Array.isArray(metrics.fixedBands)
    ? metrics.fixedBands.filter((band) => band && typeof band === 'object').slice(0, 8).map((band) => ({
      edge: band.edge === 'bottom' ? 'bottom' : 'top',
      height: Math.max(0, intOr(band.height, 0)),
      top: intOr(band.top, 0),
      bottom: intOr(band.bottom, 0),
    }))
    : [];
  // 第十批-D：把 page-metrics 的富事实（多带/sticky/整页容器）归一化，作为“只加字段”的证据。
  // 默认仍按既有 scalar 口径（fixedTop/fixedBottom），只有显式 bandLayout:true 才改用富带求和，
  // 保证既有 212 E2E 的默认输出逐字节不变。
  const rich = normalizeBands(metrics, {
    dpr,
    deviceHeight,
    viewportHeight: intOr(metrics.innerHeight, 0),
    maxBandRatio: maxRatio,
  });
  const derive = options.bandLayout === true;
  const richTop = rich.bands.filter((band) => band.edge === 'top').reduce((sum, band) => sum + band.height, 0);
  const richBottom = rich.bands.filter((band) => band.edge === 'bottom').reduce((sum, band) => sum + band.height, 0);
  return {
    measured: true,
    dpr,
    cssHeight,
    topCss,
    bottomCss,
    fixedTop: derive ? richTop : fixedTop,
    fixedBottom: derive ? richBottom : fixedBottom,
    bands,
    bandPlan: rich,
    bandCount: rich.bands.length,
    bandKinds: [...new Set(rich.bands.map((band) => band.kind))],
    bandDropped: rich.dropped,
    bandSignature: bandSignature(rich.bands),
    bandDerived: derive,
    ...(derive ? { bandTopDev: richTop, bandBottomDev: richBottom } : {}),
  };
}

/**
 * 把总高拆成段高数组：每段 ≤ maxSegmentHeight，且最后一段不会小于 minSegmentHeight
 * （40001px 这种“最后只剩 1px”会重排成两段均分，避免 1px 段）。
 */
export function splitSegmentHeights(totalHeight, options = {}) {
  const total = Math.max(1, intOr(totalHeight, 1));
  const maxHeight = clampInt(options.maxSegmentHeight, 1, 1 << 30, SEGMENT_DEFAULTS.maxSegmentHeight);
  const minHeight = Math.max(1, Math.min(maxHeight, clampInt(options.minSegmentHeight, 1, maxHeight, SEGMENT_DEFAULTS.minSegmentHeight)));
  const count = Math.max(1, Math.ceil(total / maxHeight));
  if (count === 1) return [total];
  let heights = [];
  let remaining = total;
  while (remaining > 0) {
    const height = Math.min(maxHeight, remaining);
    heights.push(height);
    remaining -= height;
  }
  if (heights.length > 1 && heights[heights.length - 1] < minHeight) {
    // 均分：ceil(total/count) 保证每段 ≤ maxHeight，最后一段取余数。
    const even = Math.ceil(total / heights.length);
    heights = heights.map((height, index) => (index === heights.length - 1 ? total - even * (heights.length - 1) : even));
  }
  return heights;
}

/**
 * 规划多段截图：段边界、重叠区、固定带重绘分布与分数 DPR 换算。
 *
 * @param {{
 *   deviceWidth: number, deviceHeight: number, dpr?: number,
 *   fixedTop?: number, fixedBottom?: number, overlap?: number,
 *   maxSegmentHeight?: number, minSegmentHeight?: number,
 * }} params
 * @returns {{
 *   ok: true, dpr: number, fractional: boolean, width: number, height: number,
 *   fixedTop: number, fixedBottom: number, overlap: number,
 *   totalSegments: number, segments: Array<object>, notes: string[],
 * }}
 */
export function planLongshotSegments(params = {}) {
  const dpr = normalizeDpr(params.dpr);
  const width = Math.max(1, intOr(params.deviceWidth, 1));
  const pageHeight = Math.max(1, intOr(params.deviceHeight, 1));
  const maxSegmentHeight = clampInt(params.maxSegmentHeight, 1, pageHeight, SEGMENT_DEFAULTS.maxSegmentHeight);
  const minSegmentHeight = Math.max(1, Math.min(maxSegmentHeight, clampInt(params.minSegmentHeight, 1, maxSegmentHeight, SEGMENT_DEFAULTS.minSegmentHeight)));
  const heights = splitSegmentHeights(pageHeight, { maxSegmentHeight, minSegmentHeight });
  const requestedOverlap = Math.max(0, intOr(params.overlap, SEGMENT_DEFAULTS.overlap));
  const fixedTopRaw = Math.max(0, intOr(params.fixedTop, 0));
  const fixedBottomRaw = Math.max(0, intOr(params.fixedBottom, 0));
  const notes = [];

  const segments = [];
  let pageY = 0;
  for (let index = 0; index < heights.length; index += 1) {
    const pageHeightOfSegment = heights[index];
    const first = index === 0;
    const last = index === heights.length - 1;
    // 重叠区不能跨过页面顶部；也不能超过上一段高度（否则会重复画同一块很多次）。
    const overlapTop = first ? 0 : Math.min(requestedOverlap, pageY, heights[index - 1] - 1);
    const fixedTop = first ? Math.min(fixedTopRaw, pageHeightOfSegment) : 0;
    const fixedBottom = last ? Math.min(fixedBottomRaw, pageHeightOfSegment) : 0;
    const drawY = pageY - overlapTop;
    const drawHeight = pageHeightOfSegment + overlapTop;
    segments.push({
      index,
      role: heights.length === 1 ? 'single' : (first ? 'first' : (last ? 'last' : 'middle')),
      y: drawY,
      height: drawHeight,
      pageY,
      pageHeight: pageHeightOfSegment,
      drawY,
      drawHeight,
      offsetY: drawY,
      cssY: pageY / dpr,
      cssHeight: pageHeightOfSegment / dpr,
      captureCssY: drawY / dpr,
      captureCssHeight: drawHeight / dpr,
      width,
      dpr,
      fractionalDpr: Math.abs(dpr - Math.round(dpr)) > 1e-9,
      fixedTop,
      fixedBottom,
      bands: { top: fixedTop > 0, bottom: fixedBottom > 0 },
      overlapTop,
      overlapBottom: last ? 0 : Math.min(requestedOverlap, pageHeightOfSegment - 1),
    });
    pageY += pageHeightOfSegment;
  }
  if (requestedOverlap > 0) notes.push('段间重叠 ' + requestedOverlap + ' 设备像素（仅用于绘制，页面覆盖不重复）');
  if (segments.length > 1) notes.push('固定顶带只在首段重绘、固定底带只在末段重绘');
  if (Math.abs(dpr - Math.round(dpr)) > 1e-9) notes.push('分数 DPR=' + dpr + '：段边界按设备像素推进、CDP clip 用 CSS 坐标');

  return {
    ok: true,
    dpr,
    fractional: Math.abs(dpr - Math.round(dpr)) > 1e-9,
    width,
    height: pageHeight,
    fixedTop: Math.min(fixedTopRaw, heights[0]),
    fixedBottom: Math.min(fixedBottomRaw, heights[heights.length - 1]),
    overlap: requestedOverlap,
    maxSegmentHeight,
    minSegmentHeight,
    totalSegments: segments.length,
    segments,
    notes,
    // 第十批-D：分数 DPR 的档位证据（只加字段；段规划仍按设备像素推进）。
    dprProfile: quantizeDpr(dpr),
    fractionalDpr: isFractionalDpr(dpr),
  };
}

/** 段内 tile 矩形：本地坐标（画布内） + 设备坐标（页面）+ CSS 坐标（CDP clip）。 */
export function tileRectsForSegment(segment, tileSize = 512) {
  if (!segment || typeof segment !== 'object') return [];
  const size = clampInt(tileSize, 1, 1 << 20, 512);
  const width = Math.max(1, intOr(segment.width, 1));
  const drawY = Math.max(0, intOr(segment.drawY, 0));
  const drawHeight = Math.max(1, intOr(segment.drawHeight, 1));
  const dpr = normalizeDpr(segment.dpr);
  const rects = [];
  for (let localY = 0; localY < drawHeight; localY += size) {
    const tileHeight = Math.min(size, drawHeight - localY);
    const deviceY = drawY + localY;
    for (let localX = 0; localX < width; localX += size) {
      const tileWidth = Math.min(size, width - localX);
      rects.push({
        index: rects.length,
        x: localX,
        y: localY,
        width: tileWidth,
        height: tileHeight,
        deviceX: localX,
        deviceY,
        cssX: localX / dpr,
        cssY: deviceY / dpr,
        cssWidth: tileWidth / dpr,
        cssHeight: tileHeight / dpr,
      });
    }
  }
  return rects;
}

/** 固定带在段画布内的绘制矩形（本地坐标）；没有该带时返回 null。 */
export function bandRedrawRect(segment, edge) {
  if (!segment || typeof segment !== 'object') return null;
  const width = Math.max(1, intOr(segment.width, 1));
  const drawHeight = Math.max(1, intOr(segment.drawHeight, 1));
  if (edge === 'top') {
    const height = Math.max(0, Math.min(intOr(segment.fixedTop, 0), drawHeight));
    return height > 0 ? { x: 0, y: 0, width, height } : null;
  }
  if (edge === 'bottom') {
    const height = Math.max(0, Math.min(intOr(segment.fixedBottom, 0), drawHeight));
    return height > 0 ? { x: 0, y: drawHeight - height, width, height } : null;
  }
  return null;
}

/** 页面设备像素 y 落在哪一段：返回 {index, segment, localY}（localY 相对绘制起点）。 */
export function locateSegment(plan, pageY) {
  const segments = plan && Array.isArray(plan.segments) ? plan.segments : [];
  const target = Math.max(0, intOr(pageY, 0));
  for (const segment of segments) {
    if (target >= segment.pageY && target < segment.pageY + segment.pageHeight) {
      return { index: segment.index, segment, localY: target - segment.drawY };
    }
  }
  return null;
}

/** 给定页面设备像素区间，返回所有与之相交的段（stale 重写/恢复时定位用）。 */
export function segmentsOverlapping(plan, range = {}) {
  const segments = plan && Array.isArray(plan.segments) ? plan.segments : [];
  const start = Math.max(0, intOr(range.pageY, 0));
  const height = Math.max(0, intOr(range.pageHeight, 0));
  const end = start + height;
  return segments.filter((segment) => {
    const segmentEnd = segment.pageY + segment.pageHeight;
    if (height === 0) return start >= segment.pageY && start < segmentEnd;
    return start < segmentEnd && end > segment.pageY;
  });
}

/**
 * 段规划自检：边界连续、覆盖完整、固定带只在首/末段、重叠不越界。
 * @returns {{ok: boolean, errors: Array<{code: string, message: string, index?: number}>, covered: number, height: number}}
 */
export function validateSegmentPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') {
    return { ok: false, errors: [{ code: 'not-plan', message: '段规划不是对象' }], covered: 0, height: 0 };
  }
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  const height = Math.max(0, intOr(plan.height, 0));
  if (!segments.length) errors.push({ code: 'no-segments', message: '段规划为空' });
  if (!(height > 0)) errors.push({ code: 'bad-height', message: '页面高度必须为正' });
  let covered = 0;
  let expectedPageY = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || typeof segment !== 'object') {
      errors.push({ code: 'bad-segment', message: '段不是对象', index });
      continue;
    }
    if (segment.index !== index) errors.push({ code: 'bad-index', message: '段序号不连续', index });
    if (!(segment.pageHeight > 0)) errors.push({ code: 'bad-page-height', message: '段页面高度必须为正', index });
    if (segment.pageY !== expectedPageY) {
      errors.push({ code: 'gap', message: '段页面起点不连续：期望 ' + expectedPageY + ' 实际 ' + segment.pageY, index });
    }
    const overlapTop = Math.max(0, intOr(segment.overlapTop, 0));
    if (overlapTop > segment.pageY) {
      errors.push({ code: 'bad-overlap', message: '重叠区越过页面顶部', index });
    }
    if (segment.dpr !== plan.dpr) errors.push({ code: 'bad-dpr', message: '段 DPR 与规划不一致', index });
    if (index > 0 && intOr(segment.fixedTop, 0) > 0) errors.push({ code: 'band-top', message: '固定顶带只允许在首段', index });
    if (index < segments.length - 1 && intOr(segment.fixedBottom, 0) > 0) errors.push({ code: 'band-bottom', message: '固定底带只允许在末段', index });
    if (intOr(segment.fixedTop, 0) > segment.pageHeight) errors.push({ code: 'band-top-height', message: '固定顶带高于段高', index });
    if (intOr(segment.fixedBottom, 0) > segment.pageHeight) errors.push({ code: 'band-bottom-height', message: '固定底带高于段高', index });
    expectedPageY += Math.max(0, intOr(segment.pageHeight, 0));
    covered += Math.max(0, intOr(segment.pageHeight, 0));
  }
  if (segments.length && covered !== height) {
    errors.push({ code: 'coverage', message: '段覆盖 ' + covered + ' 与页面高度 ' + height + ' 不一致' });
  }
  return { ok: errors.length === 0, errors, covered, height };
}

/** 收敛成协议/日志用的段描述（tiled-capture 会再合并 dataUrl/bytes/hash）。 */
export function segmentPlanWire(segment) {
  if (!segment || typeof segment !== 'object') return null;
  const identity = segmentFrameIdentity(segment);
  return {
    index: intOr(segment.index, 0),
    y: intOr(segment.drawY, 0),
    height: intOr(segment.drawHeight, 1),
    dpr: normalizeDpr(segment.dpr),
    fixedTop: intOr(segment.fixedTop, 0),
    fixedBottom: intOr(segment.fixedBottom, 0),
    offsetY: intOr(segment.drawY, 0),
    pageY: intOr(segment.pageY, 0),
    pageHeight: intOr(segment.pageHeight, 1),
    width: intOr(segment.width, 1),
    overlapTop: intOr(segment.overlapTop, 0),
    role: typeof segment.role === 'string' ? segment.role : 'single',
    // 第十一批-E：帧身份（只加字段；tiled-capture 的 segments[] 结果因此带上帧级对账的锚点）。
    frame_id: identity.frame_id,
    frame_sig: identity.frame_sig,
    frame_role: identity.frame_role,
    frame_band: identity.frame_band,
  };
}

/** 一行日志：'2 段 (40000+5000, dpr=1.5, 顶 84/底 120)'。 */
export function describeSegmentPlan(plan) {
  if (!plan || !Array.isArray(plan.segments) || !plan.segments.length) return '无分段';
  const heights = plan.segments.map((segment) => segment.pageHeight).join('+');
  return plan.totalSegments + ' 段 (' + heights + ', dpr=' + plan.dpr +
    ', 顶 ' + plan.fixedTop + '/底 ' + plan.fixedBottom +
    (plan.overlap > 0 ? ', 重叠 ' + plan.overlap : '') + ')';
}
