// ui/lib/timeline.js —— 纯时间线/瀑布图模型（无 DOM/chrome，可在 Node 单测）。
//
// 页面用途：
// - debug 页：请求瀑布图（每个请求一条 span，按 start/duration 定位，重叠分轨道）；
// - audit 页：任务时间线（按时间桶聚合，轨道 = 方法分组）；
// - ops 页：事件序列（等宽步骤）；
// - record 页：录制文件的时间分布。
//
// 设计：
// - 全部以「毫秒时间戳」为输入，输出「像素坐标」由 layoutSpans 用 scale 完成；
// - 轨道分配用贪心区间划分（区间图着色，轨道数 = 最大重叠数）；
// - 刻度用 1/2/5 × 10^n 的 nice step，避免出现 3.7 秒一格这种刻度；
// - 域（domain）支持 zoom/pan，clamp 到数据范围外一点点，防止拖丢。
import { toFiniteNumber, formatDuration, formatTimestamp } from './format.js';

/** 把一条记录转成 span；缺 start 时用 ts，缺 end 时用 start + duration。 */
export function toSpan(entry, options = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const start = toFiniteNumber(options.start !== undefined ? options.start : (entry.start ?? entry.ts ?? entry.startedAt ?? entry.time ?? entry.at));
  if (start === null) return null;
  const duration = toFiniteNumber(options.duration !== undefined ? options.duration : (entry.durationMs ?? entry.duration ?? entry.ms));
  const explicitEnd = toFiniteNumber(options.end !== undefined ? options.end : (entry.end ?? entry.endedAt));
  const end = explicitEnd !== null ? explicitEnd : start + (duration === null ? 0 : Math.max(0, duration));
  const label = options.label !== undefined ? String(options.label) : String(entry.label || entry.name || entry.url || entry.method || entry.type || '');
  return {
    id: String(options.id !== undefined ? options.id : (entry.id ?? entry.key ?? label)),
    label,
    start,
    end: Math.max(start, end),
    duration: Math.max(0, end - start),
    lane: null,
    meta: entry,
  };
}

/** 批量转换并过滤非法项；保持输入顺序。 */
export function buildSpans(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const spans = [];
  for (let index = 0; index < list.length; index += 1) {
    const span = toSpan(list[index], {
      ...options,
      id: options.idOf ? options.idOf(list[index], index) : (list[index] && (list[index].id ?? list[index].key)) ?? index,
      label: options.labelOf ? options.labelOf(list[index], index) : undefined,
    });
    if (span) spans.push(span);
  }
  return spans;
}

/** 数据时间域：{min, max, span}；空数据返回 {min:0,max:0,span:0}。 */
export function computeDomain(spans) {
  const list = Array.isArray(spans) ? spans : [];
  if (!list.length) return { min: 0, max: 0, span: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const span of list) {
    if (toFiniteNumber(span.start) === null) continue;
    min = Math.min(min, span.start);
    max = Math.max(max, span.end);
  }
  if (min === Infinity || max === -Infinity) return { min: 0, max: 0, span: 0 };
  return { min, max, span: Math.max(0, max - min) };
}

/** 域扩展：两端各留 padding 比例的空白（默认 2%），零宽域扩展为 1ms。 */
export function padDomain(domain, ratio = 0.02) {
  const min = toFiniteNumber(domain && domain.min) ?? 0;
  const max = toFiniteNumber(domain && domain.max) ?? min;
  const span = Math.max(0, max - min);
  const pad = Math.max(0, span * Math.max(0, toFiniteNumber(ratio) ?? 0.02));
  if (span === 0) return { min: min - 1, max: min + 1, span: 2 };
  return { min: min - pad, max: max + pad, span: (max + pad) - (min - pad) };
}

/** 轨道分配（贪心）：按 start 排序，放进第一个 end ≤ start 的轨道。 */
export function assignLanes(spans) {
  const list = Array.isArray(spans) ? spans : [];
  const sorted = list
    .map((span, index) => ({ span, index }))
    .sort((a, b) => (a.span.start - b.span.start) || (a.span.end - b.span.end) || (a.index - b.index));
  const laneEnds = [];
  const out = sorted.map(({ span }) => {
    let lane = laneEnds.findIndex((end) => end <= span.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(span.end);
    } else {
      laneEnds[lane] = span.end;
    }
    return { ...span, lane };
  });
  return { spans: out, lanes: laneEnds.length };
}

/** 刻度步长：1/2/5 × 10^n，取 ≥ raw 的最小候选。 */
export function niceStep(raw) {
  const value = Math.max(1e-9, toFiniteNumber(raw) || 1);
  const exponent = Math.floor(Math.log10(value));
  const base = Math.pow(10, exponent);
  const normalized = value / base;
  let nice;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

/**
 * 刻度：返回 [{value, label}]，最多 count+1 个。
 * label 用 formatDuration 口径（ms/s），与页面其它时长一致。
 */
export function buildTicks(domain, { count = 5, format } = {}) {
  const min = toFiniteNumber(domain && domain.min) ?? 0;
  const max = toFiniteNumber(domain && domain.max) ?? min;
  const span = max - min;
  const wanted = Math.max(1, Math.floor(Number(count) || 5));
  if (!(span > 0)) return [];
  const step = niceStep(span / wanted);
  const first = Math.ceil(min / step) * step;
  const ticks = [];
  for (let value = first; value <= max + step * 1e-9 && ticks.length <= wanted + 1; value += step) {
    ticks.push({
      value,
      offset: value - min,
      label: typeof format === 'function' ? String(format(value, value - min)) : formatDuration(value - min),
    });
  }
  return ticks;
}

/**
 * 把 span 布局成像素坐标。
 * @param {{domain:{min:number,max:number}, width:number, laneHeight?:number, gap?:number, minWidth?:number}} options
 */
export function layoutSpans(spans, options = {}) {
  const list = Array.isArray(spans) ? spans : [];
  const domain = options.domain && toFiniteNumber(options.domain.max) !== null ? options.domain : computeDomain(list);
  const width = Math.max(1, toFiniteNumber(options.width) || 600);
  const laneHeight = Math.max(8, toFiniteNumber(options.laneHeight) || 18);
  const gap = Math.max(0, toFiniteNumber(options.gap) || 2);
  const minWidth = Math.max(1, toFiniteNumber(options.minWidth) || 3);
  const span = Math.max(1e-6, domain.max - domain.min);
  const scale = width / span;
  const placements = list.map((item) => {
    const offset = Math.max(0, item.start - domain.min);
    const rawWidth = (item.end - item.start) * scale;
    return {
      ...item,
      x: Math.min(width - 1, Math.max(0, offset * scale)),
      width: Math.max(minWidth, Math.min(width, rawWidth)),
      y: (item.lane || 0) * (laneHeight + gap),
      height: laneHeight,
    };
  });
  const lanes = placements.reduce((max, item) => Math.max(max, (item.lane || 0) + 1), 0);
  return {
    placements,
    lanes,
    laneHeight,
    gap,
    totalHeight: lanes * (laneHeight + gap),
    width,
    domain,
    scale,
  };
}

/** 缩放域：factor < 1 放大（看更窄区间），center 为 0–1 的相对位置。 */
export function zoomDomain(domain, factor, { center = 0.5, dataDomain } = {}) {
  const min = toFiniteNumber(domain && domain.min) ?? 0;
  const max = toFiniteNumber(domain && domain.max) ?? min;
  const span = Math.max(1e-6, max - min);
  const ratio = Math.max(0.01, Math.min(100, toFiniteNumber(factor) || 1));
  const nextSpan = Math.max(1, span * ratio);
  const at = min + span * Math.max(0, Math.min(1, toFiniteNumber(center) ?? 0.5));
  let nextMin = at - nextSpan * 0.5;
  let nextMax = at + nextSpan * 0.5;
  if (dataDomain) {
    const low = toFiniteNumber(dataDomain.min) ?? nextMin;
    const high = toFiniteNumber(dataDomain.max) ?? nextMax;
    const lowSpan = Math.max(1, high - low);
    nextMin = Math.max(low - lowSpan, nextMin);
    nextMax = Math.min(high + lowSpan, nextMax);
  }
  return { min: nextMin, max: nextMax, span: nextMax - nextMin };
}

/** 平移域：ratio 为域宽的倍数（正数向后/右）。 */
export function panDomain(domain, ratio, { dataDomain } = {}) {
  const min = toFiniteNumber(domain && domain.min) ?? 0;
  const max = toFiniteNumber(domain && domain.max) ?? min;
  const span = Math.max(1e-6, max - min);
  const delta = span * (toFiniteNumber(ratio) || 0);
  let nextMin = min + delta;
  let nextMax = max + delta;
  if (dataDomain) {
    const low = toFiniteNumber(dataDomain.min) ?? nextMin;
    const high = toFiniteNumber(dataDomain.max) ?? nextMax;
    const lowSpan = Math.max(1, high - low);
    if (nextMin < low - lowSpan) { nextMin = low - lowSpan; nextMax = nextMin + span; }
    if (nextMax > high + lowSpan) { nextMax = high + lowSpan; nextMin = nextMax - span; }
  }
  return { min: nextMin, max: nextMax, span: nextMax - nextMin };
}

/** 时间线总览文本：段数 + 跨度（中文/英文由 labels 决定，这里只给结构化数值）。 */
export function timelineSummary(spans) {
  const domain = computeDomain(spans);
  const list = Array.isArray(spans) ? spans : [];
  const durations = list.map((span) => span.duration).filter((value) => Number.isFinite(value));
  const totalDuration = durations.reduce((total, value) => total + value, 0);
  return {
    count: list.length,
    min: domain.min,
    max: domain.max,
    span: domain.span,
    totalDuration,
    lanes: assignLanes(list).lanes,
  };
}

/**
 * 等宽序列布局（ops 事件步骤）：每步等宽，返回 x/width 与步骤序号。
 */
export function sequenceLayout(count, { width = 600, gap = 2, start = 0 } = {}) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const available = Math.max(1, toFiniteNumber(width) || 600);
  const space = Math.max(0, toFiniteNumber(gap) || 2);
  if (total === 0) return [];
  const each = Math.max(1, (available - space * (total - 1)) / total);
  const out = [];
  for (let index = 0; index < total; index += 1) {
    out.push({
      index: index + start,
      x: index * (each + space),
      width: each,
    });
  }
  return out;
}

/**
 * 页面直接渲染的完整时间线模型。
 * @param {{spans:Array, width?:number, height?:number, zoom?:number, pan?:number, view?:'waterfall'|'sequence', dataDomain?:object}} input
 */
export function buildTimelineModel(input = {}) {
  const spans = Array.isArray(input.spans) ? input.spans : [];
  const baseDomain = input.dataDomain && toFiniteNumber(input.dataDomain.max) !== null
    ? input.dataDomain
    : computeDomain(spans);
  const zoom = Math.max(0.01, toFiniteNumber(input.zoom) ?? 1);
  const pan = toFiniteNumber(input.pan) ?? 0;
  let domain = padDomain(baseDomain, 0.02);
  if (zoom !== 1) domain = zoomDomain(domain, 1 / zoom, { center: 0.5, dataDomain: baseDomain });
  if (pan !== 0) domain = panDomain(domain, pan, { dataDomain: baseDomain });
  const lane = assignLanes(spans);
  const layout = layoutSpans(lane.spans, {
    domain,
    width: input.width,
    laneHeight: input.laneHeight,
  });
  const ticks = buildTicks(domain, { count: input.tickCount || 5 });
  const view = input.view === 'sequence' ? 'sequence' : 'waterfall';
  const sequence = view === 'sequence'
    ? sequenceLayout(spans.length, { width: input.width })
    : [];
  return {
    view,
    empty: spans.length === 0,
    spans: layout.placements,
    lanes: lane.lanes,
    domain,
    dataDomain: baseDomain,
    ticks,
    width: layout.width,
    totalHeight: layout.totalHeight,
    laneHeight: layout.laneHeight,
    gap: layout.gap,
    scale: layout.scale,
    sequence,
    zoom,
    pan,
    summary: timelineSummary(spans),
  };
}

/** 离 span 最近的索引（键盘 ←/→ 在时间线上跳转）；空返回 -1。 */
export function nearestSpanIndex(spans, time) {
  const list = Array.isArray(spans) ? spans : [];
  if (!list.length) return -1;
  const target = toFiniteNumber(time) ?? 0;
  let best = 0;
  let bestCost = Infinity;
  for (let index = 0; index < list.length; index += 1) {
    const span = list[index];
    const cost = target < span.start ? span.start - target : target > span.end ? target - span.end : 0;
    if (cost < bestCost) { bestCost = cost; best = index; }
  }
  return best;
}

/** span 的可访问名称参数（页面用 labels.timeline.bar 拼）。 */
export function spanAriaParts(span) {
  return {
    label: span && span.label ? String(span.label) : '',
    start: span ? formatTimestamp(span.start) : '?',
    duration: span ? formatDuration(span.duration) : '?',
  };
}
