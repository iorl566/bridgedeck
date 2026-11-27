// lib/longshot-bands.js —— 多段固定带（页眉/页脚/sticky）的跨段规划、漂移检测与冲突裁剪（纯函数）。
//
// 现状：lib/longshot-segments.js 只把“固定顶/底带高度”塞进首/末段的 fixedTop/fixedBottom，
// 运行时 tiled-capture 再按这两个数字重绘。真实页面里有三类情况它没有覆盖：
//   1) 一个页面可能有多个固定带（页眉 + 底栏 + sticky 工具条），首/末两个槽位装不下；
//   2) 固定带在 stale 重拍后会漂移（图片加载完成、banner 伸缩、滚动后收缩），按旧高度重绘
//      会把带内容画到错误行上（接缝处出现半截页眉）；
//   3) 分段重叠区（overlapTop 从上一段借来的像素）与固定带重叠时，重绘固定带会把接缝
//      像素盖掉，导致接缝处出现“页眉压住正文”的重影。
//
// 本模块把这三件事收敛成纯函数，输入是 content script 的 page-metrics 事实
// （fixedBands/fixedTopHeight/fixedBottomHeight）与 longshot-segments 的段规划，输出是
// “每段该重绘哪些带、哪些冲突要裁、带是否稳定”的证据：
//   normalizeBands()    —— 归一化固定带（CSS → 设备像素、分类、超页高 1/3 的整页元素丢弃）；
//   classifyBand()      —— 单个带的分类（fixed-top/fixed-bottom/sticky-*/whole-page/none）；
//   planBandRedraws()   —— 每段重绘清单（首段顶带、末段底带、sticky 每段），含段内本地矩形；
//   bandConflicts()     —— 与段高/重叠区/重复边冲突的裁剪证据（不抛异常，只给证据）；
//   bandStability()     —— 跨帧/跨段带高度与位置漂移检测（给出建议高度）；
//   resolveBandPlan()   —— 组合入口（运行时与单测共用）；
//   bandPlanWire()/describeBandPlan()/bandSignature() —— 协议字段、日志行、稳定性签名。
//
// 约定：所有对外数字都是“设备像素”，CSS 值只在 cssHeight/cssTop/cssBottom 上保留，
// 便于和 CDP clip（CSS 口径）互算；坐标都是段画布内本地坐标（原点在段左上角）。

import { normalizeDpr } from './longshot-budget.js';

export const BAND_DEFAULTS = Object.freeze({
  // 与 longshot-segments.SEGMENT_DEFAULTS.maxBandRatio 保持一致：超过页高 1/3 的是整页容器。
  maxBandRatio: 1 / 3,
  // page-metrics.fixedBands 的结构上限（正常页面不会超过 8 条固定带）。
  maxBands: 8,
  // 漂移容差（设备像素）：高度变化超过该值即认为带不稳定。
  driftTolerance: 2,
  // sticky 带只在段内可见高度足够时才逐段重绘（避免把整页容器当 sticky）。
  stickyMinVisible: 8,
});

const EDGES = Object.freeze(['top', 'bottom']);
const KINDS = Object.freeze([
  'fixed-top',
  'fixed-bottom',
  'sticky-top',
  'sticky-bottom',
  'whole-page',
  'none',
]);

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function clampInt(value, min, max, fallback) {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function cssToDevice(cssPx, dpr) {
  const value = Number(cssPx);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.round(value * normalizeDpr(dpr)));
}

/** 单条固定带的归一化：edge 只认 top/bottom，position 只认 fixed/sticky。 */
export function normalizeBand(band, fallbackIndex = 0, options = {}) {
  const value = band && typeof band === 'object' ? band : {};
  const dpr = normalizeDpr(options.dpr);
  const edge = EDGES.includes(value.edge) ? value.edge : (intOr(value.top, 0) <= 0 && intOr(value.bottom, -1) > 0 ? 'bottom' : 'top');
  const position = value.position === 'sticky' || value.sticky === true ? 'sticky' : 'fixed';
  const cssHeight = Math.max(0, intOr(value.height != null ? value.height : value.cssHeight, 0));
  const height = cssToDevice(cssHeight, dpr);
  const top = intOr(value.top, edge === 'top' ? 0 : 0);
  const bottom = intOr(value.bottom, 0);
  return {
    index: Math.max(0, intOr(value.index, fallbackIndex)),
    edge,
    position,
    cssHeight,
    height,
    top,
    bottom,
    selector: String(value.selector || ''),
    // 兼容目标给固定带带过 id/role 证据；没有就留空串，wire 里保持一致形状。
    role: String(value.role || ''),
    kind: 'none',
  };
}

/**
 * 带分类：整页容器不是固定带；sticky 与 fixed 分开（sticky 每段都要重绘）。
 * 判定依据是“相对页高的比例”与 position 事实，不做 DOM 查询（纯函数）。
 */
export function classifyBand(band, context = {}) {
  const height = Math.max(0, intOr(band && band.height, 0));
  if (!(height > 0)) return 'none';
  const edge = band && band.edge === 'bottom' ? 'bottom' : 'top';
  const sticky = Boolean(band && band.position === 'sticky');
  const deviceHeight = Math.max(0, intOr(context.deviceHeight, 0));
  const maxRatio = Number(context.maxBandRatio) > 0 && Number.isFinite(Number(context.maxBandRatio))
    ? Number(context.maxBandRatio)
    : BAND_DEFAULTS.maxBandRatio;
  if (deviceHeight > 0 && height >= deviceHeight * maxRatio) return 'whole-page';
  // 带高接近整个视口高度时同样是整页容器（没有视口事实时退化成页高比例判断）。
  const viewportHeight = Math.max(0, intOr(context.viewportHeight, 0));
  if (viewportHeight > 0 && height >= viewportHeight * 0.8) return 'whole-page';
  if (sticky) return edge === 'bottom' ? 'sticky-bottom' : 'sticky-top';
  return edge === 'bottom' ? 'fixed-bottom' : 'fixed-top';
}

/**
 * 归一化 page-metrics 里的固定带事实。
 * @returns {{
 *   measured: boolean, dpr: number, cssHeight: number, deviceHeight: number,
 *   bands: Array<object>, dropped: Array<object>, topDev: number, bottomDev: number, notes: string[],
 * }}
 */
export function normalizeBands(metrics, options = {}) {
  const dpr = normalizeDpr(options.dpr != null ? options.dpr : (metrics && metrics.dpr));
  const deviceHeight = Math.max(0, intOr(options.deviceHeight, 0));
  const viewportHeight = Math.max(0, intOr(options.viewportHeight, 0));
  const maxBands = clampInt(options.maxBands, 1, 64, BAND_DEFAULTS.maxBands);
  const notes = [];
  if (!metrics || typeof metrics !== 'object') {
    return { measured: false, dpr, cssHeight: 0, deviceHeight, bands: [], dropped: [], topDev: 0, bottomDev: 0, notes };
  }
  const cssHeight = deviceHeight > 0 ? deviceHeight / dpr : Math.max(0, intOr(metrics.scrollHeight, 0));
  const raw = Array.isArray(metrics.fixedBands) ? metrics.fixedBands : [];
  const dropped = [];
  const bands = [];
  for (let index = 0; index < raw.length && bands.length < maxBands; index += 1) {
    const band = normalizeBand(raw[index], index, { dpr });
    band.kind = classifyBand(band, { deviceHeight, viewportHeight, maxBandRatio: options.maxBandRatio });
    if (band.kind === 'none') {
      dropped.push({ index, reason: 'no-height', height: band.height });
      continue;
    }
    if (band.kind === 'whole-page') {
      dropped.push({ index, reason: 'whole-page', height: band.height });
      continue;
    }
    bands.push(band);
  }
  if (raw.length > maxBands) {
    dropped.push({ index: maxBands, reason: 'max-bands', height: 0, count: raw.length - maxBands });
  }
  // 兼容旧路径：没有 fixedBands 数组时退化为 fixedTopHeight/fixedBottomHeight 两条隐含带。
  if (!bands.length && (intOr(metrics.fixedTopHeight, 0) > 0 || intOr(metrics.fixedBottomHeight, 0) > 0)) {
    const topCss = Math.max(0, intOr(metrics.fixedTopHeight, 0));
    const bottomCss = Math.max(0, intOr(metrics.fixedBottomHeight, 0));
    if (topCss > 0) {
      const band = normalizeBand({ edge: 'top', height: topCss, position: 'fixed', index: 0 }, 0, { dpr });
      band.kind = classifyBand(band, { deviceHeight, viewportHeight, maxBandRatio: options.maxBandRatio });
      if (band.kind !== 'none' && band.kind !== 'whole-page') bands.push(band);
      else dropped.push({ index: 0, reason: band.kind === 'whole-page' ? 'whole-page' : 'no-height', height: band.height });
    }
    if (bottomCss > 0) {
      const band = normalizeBand({ edge: 'bottom', height: bottomCss, position: 'fixed', index: bands.length }, bands.length, { dpr });
      band.kind = classifyBand(band, { deviceHeight, viewportHeight, maxBandRatio: options.maxBandRatio });
      if (band.kind !== 'none' && band.kind !== 'whole-page') bands.push(band);
      else dropped.push({ index: bands.length, reason: band.kind === 'whole-page' ? 'whole-page' : 'no-height', height: band.height });
    }
    notes.push('fixedBands 缺失，按 fixedTopHeight/fixedBottomHeight 退化规划');
  }
  const top = bands.filter((band) => band.edge === 'top');
  const bottom = bands.filter((band) => band.edge === 'bottom');
  const topDev = top.reduce((sum, band) => sum + band.height, 0);
  const bottomDev = bottom.reduce((sum, band) => sum + band.height, 0);
  if (top.length > 1) notes.push('顶边有 ' + top.length + ' 条固定带，合计 ' + topDev + ' 设备像素');
  if (bottom.length > 1) notes.push('底边有 ' + bottom.length + ' 条固定带，合计 ' + bottomDev + ' 设备像素');
  if (dropped.length) notes.push('丢弃 ' + dropped.length + ' 条非固定带元素（整页容器/无高度）');
  return { measured: true, dpr, cssHeight, deviceHeight, bands, dropped, topDev, bottomDev, notes };
}

/**
 * 每段重绘清单：顶带只首段（sticky 每段）、底带只末段（sticky 每段），全部裁到段高内。
 * @returns {{ok: boolean, perSegment: Array<object>, total: number, notes: string[]}}
 */
export function planBandRedraws(plan, bands, options = {}) {
  const segments = plan && Array.isArray(plan.segments) ? plan.segments : [];
  const list = Array.isArray(bands) ? bands : [];
  const notes = [];
  if (!segments.length || !list.length) {
    return { ok: segments.length > 0, perSegment: segments.map((segment) => ({ index: intOr(segment.index, 0), redraws: [] })), total: 0, notes };
  }
  const minVisible = clampInt(options.stickyMinVisible, 1, 1 << 20, BAND_DEFAULTS.stickyMinVisible);
  const perSegment = [];
  let total = 0;
  for (const segment of segments) {
    const index = intOr(segment.index, perSegment.length);
    const first = index === 0;
    const last = index === segments.length - 1;
    const drawHeight = Math.max(1, intOr(segment.drawHeight, intOr(segment.height, 1)));
    const width = Math.max(1, intOr(segment.width, 1));
    const redraws = [];
    for (const band of list) {
      const sticky = band.position === 'sticky';
      if (band.edge === 'top' && !first && !sticky) continue;
      if (band.edge === 'bottom' && !last && !sticky) continue;
      const height = Math.min(Math.max(0, intOr(band.height, 0)), drawHeight);
      if (!(height > 0)) continue;
      if (sticky && height < minVisible) continue;
      const y = band.edge === 'bottom' ? drawHeight - height : 0;
      // sticky 带在中间段可能出现“同一行被上下两个带重绘”，这里按边分离记录，不合并。
      redraws.push({
        bandIndex: intOr(band.index, 0),
        edge: band.edge,
        kind: band.kind,
        sticky,
        height,
        rect: { x: 0, y, width, height },
        coversOverlap: Boolean(segment.overlapTop) && band.edge === 'top' && height <= intOr(segment.overlapTop, 0),
      });
    }
    // 同边多带按“上到下”排序（顶边）或“下到上”（底边），重绘顺序要稳定，否则日志不可复现。
    redraws.sort((a, b) => (a.edge === 'bottom' ? b.rect.y - a.rect.y : a.rect.y - b.rect.y) || a.bandIndex - b.bandIndex);
    total += redraws.length;
    perSegment.push({ index, redraws });
  }
  if (total === 0) notes.push('本次分段没有需要重绘的固定带');
  else notes.push('共 ' + total + ' 处固定带重绘（sticky 逐段、fixed 首/末段）');
  return { ok: true, perSegment, total, notes };
}

/**
 * 冲突裁剪：段高装不下、与重叠区冲突、同边重复、带为整页容器。
 * 返回的 conflicts 只是证据（运行时自行决定裁剪），不会修改入参。
 */
export function bandConflicts(plan, bands) {
  const segments = plan && Array.isArray(plan.segments) ? plan.segments : [];
  const list = Array.isArray(bands) ? bands : [];
  const conflicts = [];
  if (!segments.length || !list.length) return { ok: true, conflicts, trimmed: [] };
  const seenEdges = new Set();
  for (const band of list) {
    const key = band.edge + ':' + (band.position || 'fixed');
    if (seenEdges.has(key) && band.position !== 'sticky') {
      conflicts.push({ bandIndex: intOr(band.index, 0), edge: band.edge, reason: 'duplicate-edge', height: intOr(band.height, 0) });
    }
    seenEdges.add(key);
  }
  for (const segment of segments) {
    const index = intOr(segment.index, 0);
    const drawHeight = Math.max(0, intOr(segment.drawHeight, intOr(segment.height, 0)));
    if (!(drawHeight > 0)) continue;
    let topUsed = 0;
    let bottomUsed = 0;
    for (const band of list) {
      const height = Math.max(0, intOr(band.height, 0));
      if (!(height > 0)) continue;
      if (band.edge === 'top' && index !== 0 && band.position !== 'sticky') continue;
      if (band.edge === 'bottom' && index !== segments.length - 1 && band.position !== 'sticky') continue;
      if (height > drawHeight) {
        conflicts.push({ index, bandIndex: intOr(band.index, 0), edge: band.edge, reason: 'exceeds-segment', height, drawHeight });
        continue;
      }
      if (band.edge === 'top') {
        if (topUsed + height > drawHeight) {
          conflicts.push({ index, bandIndex: intOr(band.index, 0), edge: 'top', reason: 'sum-exceeds-segment', height, used: topUsed });
          continue;
        }
        if (index > 0 && intOr(segment.overlapTop, 0) > 0 && height <= intOr(segment.overlapTop, 0)) {
          conflicts.push({
            index,
            bandIndex: intOr(band.index, 0),
            edge: 'top',
            reason: 'overlap-cover',
            height,
            overlapTop: intOr(segment.overlapTop, 0),
          });
        }
        topUsed += height;
      } else {
        if (bottomUsed + height > drawHeight) {
          conflicts.push({ index, bandIndex: intOr(band.index, 0), edge: 'bottom', reason: 'sum-exceeds-segment', height, used: bottomUsed });
          continue;
        }
        bottomUsed += height;
      }
    }
  }
  const trimmed = conflicts
    .filter((item) => item.reason === 'exceeds-segment' || item.reason === 'sum-exceeds-segment')
    .map((item) => ({ index: item.index, edge: item.edge, bandIndex: item.bandIndex, height: item.height }));
  return { ok: conflicts.length === 0, conflicts, trimmed };
}

/**
 * 固定带稳定性：跨帧/跨段采样同一批带，高度或位置漂移超过容差即不稳定。
 * samples 支持三种形状：page-metrics（fixedBands/fixedTopHeight…）数组、
 * normalizeBands() 结果数组、或直接是 band 数组。
 * @returns {{stable: boolean, samples: number, drifts: Array<object>, suggested: object, signature: string}}
 */
export function bandStability(samples, options = {}) {
  const list = Array.isArray(samples) ? samples : [];
  const tolerance = Math.max(0, intOr(options.driftTolerance, BAND_DEFAULTS.driftTolerance));
  const dpr = normalizeDpr(options.dpr);
  const normalized = [];
  for (const sample of list) {
    if (!sample || typeof sample !== 'object') continue;
    if (Array.isArray(sample.bands)) {
      normalized.push(sample);
      continue;
    }
    // page-metrics（含 fixedBands 富事实或只用 fixedTopHeight/fixedBottomHeight 的旧事实）统一走 normalizeBands。
    normalized.push(normalizeBands(sample, {
      dpr,
      deviceHeight: options.deviceHeight,
      viewportHeight: options.viewportHeight != null ? options.viewportHeight : sample.innerHeight,
    }));
  }
  if (!normalized.length) {
    return { stable: true, samples: 0, drifts: [], suggested: { top: 0, bottom: 0, count: 0 }, signature: 'bands:none' };
  }
  const series = new Map();
  for (const sample of normalized) {
    for (const band of sample.bands) {
      const key = band.edge + ':' + (band.position || 'fixed') + ':' + (band.selector || band.index);
      if (!series.has(key)) series.set(key, []);
      series.get(key).push({ height: band.height, top: band.top, bottom: band.bottom, edge: band.edge, position: band.position, selector: band.selector });
    }
  }
  const drifts = [];
  for (const [key, values] of series) {
    const heights = values.map((value) => value.height);
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    if (max - min > tolerance) {
      drifts.push({ key, field: 'height', values: heights, delta: max - min });
    }
    const tops = values.map((value) => value.top);
    const topMin = Math.min(...tops);
    const topMax = Math.max(...tops);
    if (topMax - topMin > tolerance) {
      drifts.push({ key, field: 'top', values: tops, delta: topMax - topMin });
    }
    const bottoms = values.map((value) => value.bottom);
    const bottomMin = Math.min(...bottoms);
    const bottomMax = Math.max(...bottoms);
    if (bottomMax - bottomMin > tolerance) {
      drifts.push({ key, field: 'bottom', values: bottoms, delta: bottomMax - bottomMin });
    }
  }
  // 建议值取最后一帧（最新事实），而不是中位数：页面把页眉收起来后应该按收起后的高度重绘。
  const latest = normalized[normalized.length - 1];
  const suggested = {
    top: latest.bands.filter((band) => band.edge === 'top').reduce((sum, band) => sum + band.height, 0),
    bottom: latest.bands.filter((band) => band.edge === 'bottom').reduce((sum, band) => sum + band.height, 0),
    count: latest.bands.length,
  };
  return {
    stable: drifts.length === 0,
    samples: normalized.length,
    drifts,
    suggested,
    signature: bandSignature(suggested),
  };
}

/** 稳定签名：只含边/高度/位置/选择器，不含时间，便于日志去重。 */
export function bandSignature(source) {
  if (!source || typeof source !== 'object') return 'bands:none';
  const bands = Array.isArray(source.bands) ? source.bands : (Array.isArray(source) ? source : null);
  if (bands) {
    if (!bands.length) return 'bands:none';
    return bands
      .map((band) => [band.edge, band.position || 'fixed', intOr(band.height, 0), String(band.selector || '')].join('/'))
      .sort()
      .join('|');
  }
  const top = intOr(source.top, 0);
  const bottom = intOr(source.bottom, 0);
  const count = intOr(source.count, 0);
  return 'bands:' + top + 'x' + bottom + 'x' + count;
}

/**
 * 组合入口：metrics + 段规划 → 带规划（归一化 + 分类 + 每段重绘 + 冲突裁剪）。
 * 任何输入都不抛异常（运行时遇到脏 metrics 不能把整次截图打挂）。
 * @returns {object}
 */
export function resolveBandPlan(params = {}) {
  const metrics = params.metrics && typeof params.metrics === 'object' ? params.metrics : null;
  const plan = params.plan && typeof params.plan === 'object' ? params.plan : null;
  const normalized = normalizeBands(metrics, {
    dpr: params.dpr != null ? params.dpr : (plan && plan.dpr),
    deviceHeight: params.deviceHeight != null ? params.deviceHeight : (plan && plan.height),
    viewportHeight: params.viewportHeight != null ? params.viewportHeight : metrics && metrics.innerHeight,
    maxBands: params.maxBands,
    maxBandRatio: params.maxBandRatio,
  });
  const redraws = plan
    ? planBandRedraws(plan, normalized.bands, { stickyMinVisible: params.stickyMinVisible })
    : { ok: true, perSegment: [], total: 0, notes: [] };
  const conflicts = plan ? bandConflicts(plan, normalized.bands) : { ok: true, conflicts: [], trimmed: [] };
  const stability = params.samples ? bandStability(params.samples, { dpr: normalized.dpr, deviceHeight: normalized.deviceHeight }) : null;
  const notes = normalized.notes.concat(redraws.notes || []);
  if (!conflicts.ok) notes.push('固定带冲突 ' + conflicts.conflicts.length + ' 处（' + conflicts.conflicts[0].reason + '…）');
  if (stability && !stability.stable) notes.push('固定带不稳定：' + stability.drifts.length + ' 项漂移');
  return {
    ok: true,
    measured: normalized.measured,
    dpr: normalized.dpr,
    bands: normalized.bands,
    dropped: normalized.dropped,
    topDev: normalized.topDev,
    bottomDev: normalized.bottomDev,
    redraws,
    conflicts: conflicts.conflicts,
    trimmed: conflicts.trimmed,
    stability,
    notes,
    signature: bandSignature(normalized.bands),
  };
}

/** 按段 + 边取出重绘矩形（运行时重绘循环用；没有该带返回 null）。 */
export function bandRedrawRectFor(bandPlan, segmentIndex, edge) {
  const perSegment = bandPlan && bandPlan.redraws && Array.isArray(bandPlan.redraws.perSegment)
    ? bandPlan.redraws.perSegment
    : [];
  const target = perSegment.find((entry) => intOr(entry.index, -1) === intOr(segmentIndex, -2));
  if (!target) return null;
  const redraw = (Array.isArray(target.redraws) ? target.redraws : []).find((item) => item.edge === edge);
  if (!redraw || !redraw.rect) return null;
  return { x: intOr(redraw.rect.x, 0), y: intOr(redraw.rect.y, 0), width: intOr(redraw.rect.width, 0), height: intOr(redraw.rect.height, 0) };
}

/** 协议/日志 wire：只保留可序列化字段（不带 segment 内部结构）。 */
export function bandPlanWire(bandPlan, options = {}) {
  if (!bandPlan || typeof bandPlan !== 'object') return { measured: false, bands: [], redraws: 0, conflicts: 0 };
  const maxBands = Math.max(1, Math.min(16, intOr(options.maxBands, 8)));
  const maxRedraws = Math.max(0, intOr(options.maxRedraws, 8));
  const bands = (Array.isArray(bandPlan.bands) ? bandPlan.bands : []).slice(0, maxBands).map((band) => ({
    edge: band.edge,
    position: band.position,
    kind: band.kind,
    height: intOr(band.height, 0),
    cssHeight: intOr(band.cssHeight, 0),
    selector: String(band.selector || '').slice(0, 200),
  }));
  const perSegment = bandPlan.redraws && Array.isArray(bandPlan.redraws.perSegment)
    ? bandPlan.redraws.perSegment.map((entry) => ({
      index: intOr(entry.index, 0),
      redraws: (Array.isArray(entry.redraws) ? entry.redraws : []).slice(0, maxRedraws).map((redraw) => ({
        edge: redraw.edge,
        sticky: Boolean(redraw.sticky),
        height: intOr(redraw.height, 0),
        y: intOr(redraw.rect && redraw.rect.y, 0),
      })),
    }))
    : [];
  return {
    measured: bandPlan.measured === true,
    dpr: normalizeDpr(bandPlan.dpr),
    bands,
    top: intOr(bandPlan.topDev, 0),
    bottom: intOr(bandPlan.bottomDev, 0),
    redraws: intOr(bandPlan.redraws && bandPlan.redraws.total, 0),
    perSegment,
    conflicts: (Array.isArray(bandPlan.conflicts) ? bandPlan.conflicts : []).length,
    trimmed: (Array.isArray(bandPlan.trimmed) ? bandPlan.trimmed : []).slice(0, 8),
    stable: bandPlan.stability ? bandPlan.stability.stable === true : null,
    signature: String(bandPlan.signature || 'bands:none'),
    notes: (Array.isArray(bandPlan.notes) ? bandPlan.notes : []).slice(-4),
  };
}

/** 一行日志：'固定带 顶 84/底 120（2 条, 3 处重绘, 稳定）'。 */
export function describeBandPlan(bandPlan) {
  if (!bandPlan || !Array.isArray(bandPlan.bands) || !bandPlan.bands.length) return '固定带 无';
  const count = bandPlan.bands.length;
  const redraws = bandPlan.redraws ? intOr(bandPlan.redraws.total, 0) : 0;
  const stable = bandPlan.stability ? (bandPlan.stability.stable ? '稳定' : '不稳定') : '未采样';
  const kinds = [...new Set(bandPlan.bands.map((band) => band.kind))].join('/');
  return '固定带 顶 ' + bandPlan.topDev + '/底 ' + bandPlan.bottomDev +
    '（' + count + ' 条 ' + kinds + ', ' + redraws + ' 处重绘, ' + stable + '）';
}

/** 冲突原因的中文说明（日志/错误证据共用）。 */
export function describeBandConflict(conflict) {
  if (!conflict || typeof conflict !== 'object') return '未知固定带冲突';
  const edge = conflict.edge === 'bottom' ? '底带' : '顶带';
  const where = conflict.index != null ? '第 ' + conflict.index + ' 段' : '';
  switch (conflict.reason) {
    case 'exceeds-segment':
      return where + edge + '（' + conflict.height + 'px）高于段高 ' + conflict.drawHeight;
    case 'sum-exceeds-segment':
      return where + edge + '累加超过段高（已用 ' + conflict.used + '，再加 ' + conflict.height + '）';
    case 'overlap-cover':
      return where + edge + '落在重叠区（' + conflict.overlapTop + 'px）内，重绘会盖住接缝';
    case 'duplicate-edge':
      return edge + '重复登记（同一边出现两条 fixed 带）';
    default:
      return where + edge + '冲突：' + String(conflict.reason || 'unknown');
  }
}

/** 只保留参与重绘的带（wire 精简：sticky 每段、fixed 首末）。 */
export function redrawableBands(bandPlan) {
  if (!bandPlan || !Array.isArray(bandPlan.bands)) return [];
  return bandPlan.bands.filter((band) => band.kind !== 'none' && band.kind !== 'whole-page' && band.height > 0);
}

/** 每段重绘集合的扁平列表（运行时按顺序执行重绘用）：[{segment, redraw}]。 */
export function flattenBandRedraws(bandPlan) {
  const perSegment = bandPlan && bandPlan.redraws && Array.isArray(bandPlan.redraws.perSegment)
    ? bandPlan.redraws.perSegment
    : [];
  const flat = [];
  for (const entry of perSegment) {
    for (const redraw of Array.isArray(entry.redraws) ? entry.redraws : []) {
      flat.push({ segment: intOr(entry.index, 0), redraw });
    }
  }
  return flat;
}

export const BAND_KINDS = KINDS;
