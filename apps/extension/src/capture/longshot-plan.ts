// src/capture/longshot-plan.ts —— 长截图规划（纯函数，无浏览器依赖，可精确单测）。
//
// 为什么需要单独的规划层：
// - TS 运行时没有 chrome.debugger，整页长截图只能靠 `captureVisibleTab` 滚动分段拍再拼接；
//   与 CDP 的 `Page.captureScreenshot({captureBeyondViewport:true})` 不同，滚动采集会遇到
//   固定顶/底栏（每次滚动都贴在视口里，拼到画布中间会变成重复的横条）、页面在采集期间
//   继续增长（stale）、单画布高度上限（>40000px 的分段输出）三类几何问题；
// - 这三类问题的答案都只取决于页面度量与预算参数，因此独立成纯函数：运行时只负责
//   滚动/抓帧/落盘，几何与降级策略在这里断言，单测可用任意假页面度量驱动。
//
// 坐标约定（与 JS 基线实现保持一致，便于对拍）：
// - `deviceHeight`/`deviceWidth` 是**设备像素**（画布像素）；`dpr` 是小数也可能（1.25/1.5/2）；
// - `segment.pageY`/`pageHeight` 是页面设备像素区间；`drawY`/`drawHeight` 是"绘制"语义
//   （第 i>0 段从上一段尾部借 overlapTop 个设备像素一起拍，因此 drawY = pageY - overlapTop）；
// - 固定顶带只画在首段、固定底带只画在末段（中间段重复画会得到贯穿整页的假页眉）。

/** 单张画布的设备像素高度上限（超过即分段输出）。 */
export const MAX_SINGLE_CANVAS_HEIGHT = 40_000;

/** 分段输出的默认段高（留出内存余量：40k×1.28k RGBA ≈ 200MB）。 */
export const DEFAULT_SEGMENT_HEIGHT = 20_000;

/** 固定带占页面高度的比例上限：超过视为"整页容器"而不是固定带。 */
export const MAX_BAND_RATIO = 1 / 3;

/** 默认重叠像素（设备像素）。 */
export const DEFAULT_OVERLAP = 0;

export interface LongshotBandFact {
  edge: 'top' | 'bottom';
  height: number;
  top: number;
  bottom: number;
}

/** 页面度量（内容脚本 `metrics` 事实的子集；缺字段按 0 处理）。 */
export interface LongshotMetrics {
  scrollX?: number;
  scrollY?: number;
  innerWidth?: number;
  innerHeight?: number;
  scrollWidth?: number;
  scrollHeight?: number;
  devicePixelRatio?: number;
  /** 固定顶栏高度（CSS 像素）。 */
  fixedTopHeight?: number;
  /** 固定页脚高度（CSS 像素）。 */
  fixedBottomHeight?: number;
  /** 固定带明细（最多 8 条）。 */
  fixedBands?: LongshotBandFact[];
  /** 文档 revision（DOM 变更计数；stale 判定用）。 */
  revision?: number;
}

export interface FixedBandPlan {
  measured: boolean;
  dpr: number;
  cssHeight: number;
  topCss: number;
  bottomCss: number;
  /** 固定顶栏设备像素高度（0 表示没有/被丢弃）。 */
  fixedTop: number;
  /** 固定页脚设备像素高度。 */
  fixedBottom: number;
  bands: LongshotBandFact[];
}

export interface SegmentPlanInput {
  deviceWidth: number;
  deviceHeight: number;
  dpr?: number;
  fixedTop?: number;
  fixedBottom?: number;
  overlap?: number;
  maxSegmentHeight?: number;
  minSegmentHeight?: number;
}

export interface SegmentPlanEntry {
  index: number;
  role: 'single' | 'first' | 'middle' | 'last';
  /** 绘制起点（设备像素，页面坐标）。 */
  drawY: number;
  /** 绘制高度（设备像素，含重叠区）。 */
  drawHeight: number;
  /** 页面坐标（不含重叠区）。 */
  pageY: number;
  pageHeight: number;
  /** wire 语义：可直接按 offsetY 拼回整页。 */
  offsetY: number;
  /** 该段内固定顶/底带高度（设备像素；只有首/末段非 0）。 */
  fixedTop: number;
  fixedBottom: number;
  /** 段内 CSS 坐标区间（滚动规划用）。 */
  cssY: number;
  cssHeight: number;
  width: number;
  dpr: number;
  fractionalDpr: boolean;
  overlapTop: number;
}

export interface SegmentPlan {
  ok: true;
  dpr: number;
  fractional: boolean;
  width: number;
  height: number;
  fixedTop: number;
  fixedBottom: number;
  overlap: number;
  maxSegmentHeight: number;
  minSegmentHeight: number;
  totalSegments: number;
  segments: SegmentPlanEntry[];
  notes: string[];
  /** 是否因为超过单画布上限而分段。 */
  segmented: boolean;
}

export interface SegmentWire {
  index: number;
  y: number;
  height: number;
  dpr: number;
  fixedTop: number;
  fixedBottom: number;
  offsetY: number;
  pageY: number;
  pageHeight: number;
  width: number;
  overlapTop: number;
  role: string;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function intOr(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

/** DPR 归一：非法/≤0 一律 1（0.3.0 JS 同口径）。 */
export function normalizeDpr(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  // 浏览器报的 DPR 可能是 1.2500000000000002 这种；保留 4 位避免比较噪声。
  return Math.round(number * 10_000) / 10_000;
}

/** CSS 像素 → 设备像素（四舍五入；固定带/元素盒子口径）。 */
export function toDevicePx(cssPx: unknown, dpr: unknown): number {
  const scale = normalizeDpr(dpr);
  const value = Number(cssPx);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.round(value * scale));
}

/** CSS 尺寸 → 画布尺寸（向上取整且至少 1px；整页/段画布口径）。 */
export function canvasDevicePx(cssPx: unknown, dpr: unknown): number {
  const scale = normalizeDpr(dpr);
  const value = Number(cssPx);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.ceil(value * scale));
}

/** 设备像素 → CSS 像素（滚动规划/裁剪口径）。 */
export function toCssPx(devicePx: unknown, dpr: unknown): number {
  const scale = normalizeDpr(dpr);
  const value = Number(devicePx);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / scale;
}

/**
 * 从页面度量算固定顶/底带（设备像素）。
 *
 * 规则（与 JS 基线实现逐条一致）：
 * - 高度必须 >0 且小于页面 CSS 高度的 1/3（否则那是整页容器，不是固定带）；
 * - 明细最多保留 8 条；明细缺失时只有高度（`fixedBands` 数量按明细条数报）。
 */
export function planFixedBands(
  metrics: LongshotMetrics | null | undefined,
  options: { dpr?: unknown; deviceHeight?: unknown; maxBandRatio?: unknown } = {},
): FixedBandPlan {
  const dpr = normalizeDpr(options.dpr ?? metrics?.devicePixelRatio);
  const deviceHeight = Math.max(0, intOr(options.deviceHeight, 0));
  const ratioInput = Number(options.maxBandRatio);
  const maxRatio = Number.isFinite(ratioInput) && ratioInput > 0 ? ratioInput : MAX_BAND_RATIO;
  if (!metrics) {
    return { measured: false, dpr, cssHeight: 0, topCss: 0, bottomCss: 0, fixedTop: 0, fixedBottom: 0, bands: [] };
  }
  const cssHeight = deviceHeight > 0 ? deviceHeight / dpr : Math.max(0, finiteNumber(metrics.scrollHeight, 0));
  const topCss = Math.max(0, intOr(metrics.fixedTopHeight, 0));
  const bottomCss = Math.max(0, intOr(metrics.fixedBottomHeight, 0));
  const limit = cssHeight > 0 ? cssHeight * maxRatio : Infinity;
  const fixedTop = topCss > 0 && topCss < limit ? toDevicePx(topCss, dpr) : 0;
  const fixedBottom = bottomCss > 0 && bottomCss < limit ? toDevicePx(bottomCss, dpr) : 0;
  const bands: LongshotBandFact[] = Array.isArray(metrics.fixedBands)
    ? metrics.fixedBands
      .filter((band) => Boolean(band) && typeof band === 'object')
      .slice(0, 8)
      .map((band) => ({
        edge: band.edge === 'bottom' ? 'bottom' as const : 'top' as const,
        height: Math.max(0, intOr(band.height, 0)),
        top: intOr(band.top, 0),
        bottom: intOr(band.bottom, 0),
      }))
    : [];
  return { measured: true, dpr, cssHeight, topCss, bottomCss, fixedTop, fixedBottom, bands };
}

/**
 * 把总高拆成段高数组：每段 ≤ maxSegmentHeight，且末段不小于 minSegmentHeight。
 * 40001px 这种"最后只剩 1px"的输入会重排成均分两段，避免生成 1px 段。
 */
export function splitSegmentHeights(totalHeight: unknown, options: { maxSegmentHeight?: unknown; minSegmentHeight?: unknown } = {}): number[] {
  const total = Math.max(1, intOr(totalHeight, 1));
  const maxHeight = clampInt(options.maxSegmentHeight, 1, 1 << 30, MAX_SINGLE_CANVAS_HEIGHT);
  const minHeight = Math.max(1, Math.min(maxHeight, clampInt(options.minSegmentHeight, 1, maxHeight, 256)));
  const count = Math.max(1, Math.ceil(total / maxHeight));
  if (count === 1) return [total];
  const heights: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    const height = Math.min(maxHeight, remaining);
    heights.push(height);
    remaining -= height;
  }
  const lastIndex = heights.length - 1;
  if (heights.length > 1 && heights[lastIndex] !== undefined && heights[lastIndex] < minHeight) {
    const even = Math.ceil(total / heights.length);
    return heights.map((_height, index) => (index === lastIndex ? total - even * lastIndex : even));
  }
  return heights;
}

/** 规划整页/分段截图：段边界、重叠区、固定带分布与分数 DPR 换算。 */
export function planLongshotSegments(params: SegmentPlanInput): SegmentPlan {
  const dpr = normalizeDpr(params.dpr);
  const width = Math.max(1, intOr(params.deviceWidth, 1));
  const pageHeight = Math.max(1, intOr(params.deviceHeight, 1));
  const requestedMax = clampInt(params.maxSegmentHeight, 1, Math.max(pageHeight, 1), MAX_SINGLE_CANVAS_HEIGHT);
  const minSegmentHeight = Math.max(1, Math.min(requestedMax, clampInt(params.minSegmentHeight, 1, requestedMax, 256)));
  const heights = splitSegmentHeights(pageHeight, { maxSegmentHeight: requestedMax, minSegmentHeight });
  const requestedOverlap = Math.max(0, intOr(params.overlap, DEFAULT_OVERLAP));
  const fixedTopRaw = Math.max(0, intOr(params.fixedTop, 0));
  const fixedBottomRaw = Math.max(0, intOr(params.fixedBottom, 0));
  const fractional = Math.abs(dpr - Math.round(dpr)) > 1e-9;
  const notes: string[] = [];
  const segments: SegmentPlanEntry[] = [];
  let pageY = 0;
  for (let index = 0; index < heights.length; index += 1) {
    const pageHeightOfSegment = heights[index] ?? 1;
    const first = index === 0;
    const last = index === heights.length - 1;
    // 重叠区不能跨过页面顶部；也不能吃掉上一段的全部高度。
    const previousHeight = index > 0 ? (heights[index - 1] ?? 1) : 0;
    const overlapTop = first ? 0 : Math.min(requestedOverlap, pageY, previousHeight - 1);
    const fixedTop = first ? Math.min(fixedTopRaw, pageHeightOfSegment) : 0;
    const fixedBottom = last ? Math.min(fixedBottomRaw, pageHeightOfSegment) : 0;
    const drawY = pageY - overlapTop;
    const drawHeight = pageHeightOfSegment + overlapTop;
    segments.push({
      index,
      role: heights.length === 1 ? 'single' : (first ? 'first' : (last ? 'last' : 'middle')),
      drawY,
      drawHeight,
      pageY,
      pageHeight: pageHeightOfSegment,
      offsetY: drawY,
      fixedTop,
      fixedBottom,
      cssY: pageY / dpr,
      cssHeight: pageHeightOfSegment / dpr,
      width,
      dpr,
      fractionalDpr: fractional,
      overlapTop,
    });
    pageY += pageHeightOfSegment;
  }
  if (requestedOverlap > 0) notes.push('段间重叠 ' + String(requestedOverlap) + ' 设备像素（仅用于绘制，页面覆盖不重复）');
  if (segments.length > 1) notes.push('固定顶带只在首段重绘、固定底带只在末段重绘');
  if (fractional) notes.push('分数 DPR=' + String(dpr) + '：段边界按设备像素推进、滚动位置用 CSS 坐标');
  return {
    ok: true,
    dpr,
    fractional,
    width,
    height: pageHeight,
    fixedTop: Math.min(fixedTopRaw, heights[0] ?? 1),
    fixedBottom: Math.min(fixedBottomRaw, heights[heights.length - 1] ?? 1),
    overlap: requestedOverlap,
    maxSegmentHeight: requestedMax,
    minSegmentHeight,
    totalSegments: segments.length,
    segments,
    notes,
    segmented: segments.length > 1,
  };
}

export interface ScrollFrame {
  /** 滚动到的页面 CSS 坐标（captureVisibleTab 前先滚到这里）。 */
  scrollX: number;
  scrollY: number;
  /** 该帧在画布上的设备像素落点（页面坐标 × dpr）。 */
  drawX: number;
  drawY: number;
}

/** 横向列位置：页面比视口宽时按视口宽推进（宽页截图，E2E 31d 场景）。 */
export function planColumnScrolls(
  metrics: { innerWidth?: unknown; scrollWidth?: unknown },
  options: { tolerance?: unknown } = {},
): number[] {
  const innerWidth = Math.max(1, intOr(metrics.innerWidth, 1));
  const scrollWidth = Math.max(innerWidth, intOr(metrics.scrollWidth, innerWidth));
  const tolerance = Number(options.tolerance) > 0 ? Number(options.tolerance) : 1.15;
  if (scrollWidth <= innerWidth * tolerance) return [0];
  const maxScrollX = Math.max(0, scrollWidth - innerWidth);
  const step = Math.max(1, innerWidth);
  const columns: number[] = [];
  for (let x = 0; x < scrollWidth; x += step) {
    columns.push(Math.min(x, maxScrollX));
    if (columns.length > 256) break;
  }
  if (!columns.length) columns.push(0);
  return columns;
}

/**
 * 段内滚动帧规划：把页面 CSS 区间切成"滚动到 (x,y) 就拍一帧"的清单。
 *
 * 与 CDP 分块不同，滚动帧的 drawY 是 **scrollY × dpr**（视口左上角在页面上的位置），
 * 因此同一帧永远贴在自己的滚动位置上，不需要按段起点反推；横向同理用 drawX。
 */
export function planSegmentFrames(
  segment: SegmentPlanEntry,
  metrics: { innerHeight?: unknown; scrollHeight?: unknown; scrollWidth?: unknown; innerWidth?: unknown },
  options: { overlap?: unknown; maxFrames?: unknown; columns?: readonly number[] } = {},
): ScrollFrame[] {
  const dpr = normalizeDpr(segment.dpr);
  const innerHeight = Math.max(1, intOr(metrics.innerHeight, 1));
  const scrollHeight = Math.max(innerHeight, intOr(metrics.scrollHeight, innerHeight));
  const overlap = Math.max(0, Math.min(intOr(options.overlap, DEFAULT_OVERLAP), innerHeight - 1));
  const step = Math.max(1, innerHeight - overlap);
  const maxScrollY = Math.max(0, scrollHeight - innerHeight);
  const limit = Math.max(1, intOr(options.maxFrames, 512));
  const columns = Array.isArray(options.columns) && options.columns.length
    ? options.columns.map((x) => Math.max(0, Math.round(Number(x) || 0)))
    : planColumnScrolls(metrics);
  const startCss = Math.max(0, Math.floor(segment.cssY));
  const endCss = Math.max(startCss + 1, Math.ceil(segment.cssY + segment.cssHeight));
  const rows: number[] = [];
  for (let cssY = startCss; cssY < endCss; cssY += step) {
    const scrollY = Math.min(cssY, maxScrollY);
    rows.push(scrollY);
    if (scrollY >= maxScrollY) break;
  }
  const lastRow = rows[rows.length - 1];
  if (lastRow !== undefined && lastRow + innerHeight < endCss) rows.push(maxScrollY);
  if (!rows.length) rows.push(0);
  const frames: ScrollFrame[] = [];
  for (const scrollY of rows) {
    for (const scrollX of columns) {
      if (frames.length >= limit) return frames;
      frames.push({
        scrollX,
        scrollY,
        drawX: Math.round(scrollX * dpr),
        drawY: Math.round(scrollY * dpr),
      });
    }
  }
  return frames;
}

/** 固定带在段画布内的绘制矩形（本地坐标 + 源图裁剪行）；没有该带返回 null。 */
export function bandRedrawRect(
  segment: { width: number; drawHeight: number; fixedTop?: number; fixedBottom?: number },
  edge: 'top' | 'bottom',
): { x: number; y: number; width: number; height: number; edge: 'top' | 'bottom' } | null {
  const width = Math.max(1, intOr(segment.width, 1));
  const drawHeight = Math.max(1, intOr(segment.drawHeight, 1));
  if (edge === 'top') {
    const height = Math.max(0, Math.min(intOr(segment.fixedTop, 0), drawHeight));
    return height > 0 ? { x: 0, y: 0, width, height, edge } : null;
  }
  const height = Math.max(0, Math.min(intOr(segment.fixedBottom, 0), drawHeight));
  return height > 0 ? { x: 0, y: drawHeight - height, width, height, edge } : null;
}

/**
 * 段规划自检：边界连续、覆盖完整、固定带只在首/末段、重叠不越界。
 * 运行时（分段前）与单测共用；失败只记录证据，不阻断截图。
 */
export function validateSegmentPlan(plan: SegmentPlan | null | undefined): {
  ok: boolean;
  errors: Array<{ code: string; message: string; index?: number }>;
  covered: number;
  height: number;
} {
  const errors: Array<{ code: string; message: string; index?: number }> = [];
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
      errors.push({ code: 'gap', message: '段页面起点不连续：期望 ' + String(expectedPageY) + ' 实际 ' + String(segment.pageY), index });
    }
    if (Math.max(0, segment.overlapTop) > segment.pageY) errors.push({ code: 'bad-overlap', message: '重叠区越过页面顶部', index });
    if (segment.dpr !== plan.dpr) errors.push({ code: 'bad-dpr', message: '段 DPR 与规划不一致', index });
    if (index > 0 && intOr(segment.fixedTop, 0) > 0) errors.push({ code: 'band-top', message: '固定顶带只允许在首段', index });
    if (index < segments.length - 1 && intOr(segment.fixedBottom, 0) > 0) errors.push({ code: 'band-bottom', message: '固定底带只允许在末段', index });
    if (intOr(segment.fixedTop, 0) > segment.pageHeight) errors.push({ code: 'band-top-height', message: '固定顶带高于段高', index });
    if (intOr(segment.fixedBottom, 0) > segment.pageHeight) errors.push({ code: 'band-bottom-height', message: '固定底带高于段高', index });
    expectedPageY += Math.max(0, intOr(segment.pageHeight, 0));
    covered += Math.max(0, intOr(segment.pageHeight, 0));
  }
  if (segments.length && covered !== height) {
    errors.push({ code: 'coverage', message: '段覆盖 ' + String(covered) + ' 与页面高度 ' + String(height) + ' 不一致' });
  }
  return { ok: errors.length === 0, errors, covered, height };
}

/** 收敛成协议/日志用的段描述。 */
export function segmentPlanWire(segment: SegmentPlanEntry): SegmentWire {
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
    role: segment.role,
  };
}

/** 一行日志：'2 段 (40000+5000, dpr=1.5, 顶 84/底 120)'。 */
export function describeSegmentPlan(plan: SegmentPlan | null | undefined): string {
  if (!plan || !Array.isArray(plan.segments) || !plan.segments.length) return '无分段';
  const heights = plan.segments.map((segment) => segment.pageHeight).join('+');
  return String(plan.totalSegments) + ' 段 (' + heights + ', dpr=' + String(plan.dpr) +
    ', 顶 ' + String(plan.fixedTop) + '/底 ' + String(plan.fixedBottom) +
    (plan.overlap > 0 ? ', 重叠 ' + String(plan.overlap) : '') + ')';
}

// ---------------------------------------------------------------------------
// stale 判定与恢复策略
// ---------------------------------------------------------------------------

export interface StaleChange {
  field: string;
  before: number;
  after: number;
}

export interface StaleReport {
  stale: boolean;
  changed: StaleChange[];
}

/** 长截图期间页面是否"过期"：关键布局指标变化超过容差即视为 stale。 */
export function staleMetrics(
  before: LongshotMetrics | null | undefined,
  after: LongshotMetrics | null | undefined,
  options: { tolerance?: unknown } = {},
): StaleReport {
  const toleranceInput = Number(options.tolerance);
  const tolerance = Number.isFinite(toleranceInput) ? Math.max(0, toleranceInput) : 1;
  if (!before || !after) return { stale: false, changed: [] };
  const fields = ['scrollHeight', 'scrollWidth', 'innerWidth', 'innerHeight', 'revision'] as const;
  const changed: StaleChange[] = [];
  for (const field of fields) {
    const a = Number(before[field]);
    const b = Number(after[field]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(b - a) > tolerance) changed.push({ field, before: a, after: b });
  }
  return { stale: changed.length > 0, changed };
}

export type StaleRecoveryAction = 'accept' | 'extend' | 'rewrite' | 'retry';

export interface StaleRecoveryPlan {
  action: StaleRecoveryAction;
  width?: number;
  height?: number;
  y0?: number;
}

/** stale 后的恢复策略：底部增长只补拍新增帧；尺寸不变但 DOM 变了则整页重拍。 */
export function planStaleRecovery(
  before: LongshotMetrics | null | undefined,
  after: LongshotMetrics | null | undefined,
  options: { scale?: unknown; device?: { width?: number; height?: number } } = {},
): StaleRecoveryPlan {
  const scale = Number(options.scale) > 0 ? Number(options.scale) : 1;
  const device = options.device ?? {};
  const oldWidth = Number(device.width) > 0 ? Number(device.width) : Math.ceil(finiteNumber(before?.scrollWidth, 0) * scale);
  const oldHeight = Number(device.height) > 0 ? Number(device.height) : Math.ceil(finiteNumber(before?.scrollHeight, 0) * scale);
  const nextWidth = Math.ceil(finiteNumber(after?.scrollWidth, 0) * scale);
  const nextHeight = Math.ceil(finiteNumber(after?.scrollHeight, 0) * scale);
  if (!after || nextWidth <= 0 || nextHeight <= 0) return { action: 'accept' };
  if (nextWidth === oldWidth && nextHeight === oldHeight) {
    const beforeRevision = Number(before?.revision);
    const afterRevision = Number(after?.revision);
    if (Number.isFinite(beforeRevision) && Number.isFinite(afterRevision) && beforeRevision !== afterRevision) {
      return { action: 'rewrite', width: nextWidth, height: nextHeight };
    }
    return { action: 'accept' };
  }
  if (nextWidth === oldWidth && nextHeight > oldHeight) {
    return { action: 'extend', width: nextWidth, height: nextHeight, y0: oldHeight };
  }
  return { action: 'retry', width: nextWidth, height: nextHeight };
}

// ---------------------------------------------------------------------------
// 恢复拼接
// ---------------------------------------------------------------------------

export interface StitchFrameInput {
  drawY?: number;
  height: number;
}

export interface StitchPlacement {
  index: number;
  drawY: number;
  bitmapHeight: number;
}

export interface StitchLayout {
  width: number;
  height: number;
  placements: StitchPlacement[];
}

/**
 * 已持久化分片的拼接计划：有 drawY 时按页面坐标放；缺 drawY 的旧分片按顺序累加。
 * 与 JS 基线的 `planStitch` 等价（长截图恢复页与 `longshot.recover` 共用）。
 */
export function planStitch(frames: readonly StitchFrameInput[] | null | undefined, options: { width?: unknown } = {}): StitchLayout {
  const list = Array.isArray(frames) ? frames : [];
  const explicit = list.map((frame) => (Number.isFinite(Number(frame?.drawY)) ? Math.max(0, Math.round(Number(frame.drawY))) : null));
  const useDrawY = list.length > 0 && explicit.every((value) => value !== null);
  const width = Math.max(1, intOr(options.width, 1));
  let cursor = 0;
  const placements: StitchPlacement[] = list.map((frame, index) => {
    const height = Math.max(1, Math.round(Number(frame?.height) || 1));
    const drawY = useDrawY ? (explicit[index] ?? cursor) : cursor;
    cursor += height;
    return { index, drawY, bitmapHeight: height };
  });
  let capturedBottom = 0;
  for (const placement of placements) capturedBottom = Math.max(capturedBottom, placement.drawY + placement.bitmapHeight);
  return {
    width,
    height: Math.max(1, Math.min(Math.max(1, cursor), capturedBottom || cursor)),
    placements,
  };
}

/**
 * 采集预算：单段像素上限 / 总像素上限 / 建议降级。
 * 长截图最贵的不是帧数而是画布像素；超过上限时如实降级（截断/分段）并给证据。
 */
export interface LongshotBudget {
  deviceWidth: number;
  deviceHeight: number;
  dpr: number;
  segmented: boolean;
  truncated: boolean;
  degraded: boolean;
  maxSegmentHeight: number;
  estimatedSegments: number;
  pixels: number;
  reason: string;
}

export function estimateLongshotBudget(options: {
  scrollWidth?: unknown;
  scrollHeight?: unknown;
  dpr?: unknown;
  maxDeviceDimension?: unknown;
  maxSegmentHeight?: unknown;
  maxTotalPixels?: unknown;
}): LongshotBudget {
  const dpr = normalizeDpr(options.dpr);
  const maxDimension = Math.max(1, intOr(options.maxDeviceDimension, MAX_SINGLE_CANVAS_HEIGHT));
  const maxSegmentHeight = Math.max(1, intOr(options.maxSegmentHeight, DEFAULT_SEGMENT_HEIGHT));
  const maxTotalPixels = Math.max(1, intOr(options.maxTotalPixels, 268_000_000));
  const rawWidth = Math.max(1, canvasDevicePx(options.scrollWidth, dpr));
  const rawHeight = Math.max(1, canvasDevicePx(options.scrollHeight, dpr));
  const deviceWidth = Math.min(rawWidth, maxDimension);
  // 总像素预算（画布内存 ≈ pixels × 4 字节）：宽度定了之后高度上限可以精确算出。
  const pixelHeightCap = Math.max(1, Math.floor(maxTotalPixels / Math.max(1, deviceWidth)));
  const deviceHeight = Math.min(rawHeight, pixelHeightCap);
  const segmented = deviceHeight > maxSegmentHeight;
  const estimatedSegments = segmented ? Math.max(2, Math.ceil(deviceHeight / maxSegmentHeight)) : 1;
  const pixels = deviceWidth * deviceHeight;
  const bands: string[] = [];
  if (deviceWidth < rawWidth) bands.push('宽度截断 ' + String(rawWidth) + '→' + String(deviceWidth));
  if (deviceHeight < rawHeight) bands.push('高度截断 ' + String(rawHeight) + '→' + String(deviceHeight));
  if (dpr !== 1) bands.push('dpr=' + String(dpr));
  return {
    deviceWidth,
    deviceHeight,
    dpr,
    segmented,
    truncated: deviceHeight < rawHeight || deviceWidth < rawWidth,
    degraded: bands.length > 0,
    maxSegmentHeight,
    estimatedSegments,
    pixels,
    reason: bands.join('；') || '在单画布预算内',
  };
}
