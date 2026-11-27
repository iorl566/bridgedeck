// lib/longshot-dpr.js —— 分数 DPR（1.25/1.5/1.75/2.625…）下的段边界量化与 CDP clip 换算（纯函数）。
//
// 现状：lib/longshot-segments.js 在设备像素上切段（splitSegmentHeights），分数 DPR 只做了
// “段内坐标 / dpr 得 CSS”这一步换算。真实 Chromium 在 dpr=1.25/1.5 时有三个坑：
//   1) `Emulation.setDeviceMetricsOverride` 的 clip 是 CSS 浮点坐标，CDP 内部再乘 dpr 取整，
//      多次乘法 + 四舍五入会在段边界累积误差，长页面拼出来可能出现 1px 缝或 1px 重影；
//   2) 设备像素高度 = ceil(cssHeight * dpr) 与“段设备高度之和”不一定相等，最后一段要么缺
//      一行、要么超出画布；
//   3) dpr 也可能在截图过程中被页面改掉（`window.devicePixelRatio` 在缩放/拖到另一个显示器
//      后会变），跨段 DPR 不一致时同一张画布上的像素密度不均匀，接缝可见。
//
// 本模块把“CSS ↔ 设备像素”的量化收敛成可验证的纯函数：
//   normalizeDprForPlan()  —— 量化到 Chromium 实际支持的 DPR 档位（1/1.25/1.5/1.75/2/2.5/2.625/3）；
//   alignFloor/alignCeil/alignRound() —— 单项量化；
//   planDeviceSegments()   —— 以“累计设备边界”推进的段规划，保证段与段首尾相接（无缝隙无重叠）；
//   planFractionalCanvas() —— 分数 DPR 画布尺寸（向上取整、可用 area 上限裁剪）；
//   compensateClip()       —— CDP clip 的 floor/ceil 补偿（返回 width/height/scale，可直接喂 clip）；
//   dprErrorTable()        —— 每段边界的理想值 vs 实际值误差（测试与日志用）；
//   detectDprDrift()       —— 跨帧 DPR 漂移检测；
//   dprPlanWire()/describeDprPlan()/dprSignature()。
//
// 坐标约定：css* 是页面 CSS 像素（CDP clip 口径），device* 是位图/画布像素（drawImage 口径）。
// planDeviceSegments() 的每个段都满足 deviceY[i] + deviceHeight[i] === deviceY[i+1]。

import { normalizeDpr } from './longshot-budget.js';

/** Chromium/Blink 实际会出现的 DPR 档位（含 PDF/缩放下常见的 2.625，Edge 在 175% 缩放时报告它）。 */
export const DPR_PROFILES = Object.freeze([
  Object.freeze({ dpr: 1, name: '1x', zoom: 100 }),
  Object.freeze({ dpr: 1.25, name: '1.25x', zoom: 125 }),
  Object.freeze({ dpr: 1.5, name: '1.5x', zoom: 150 }),
  Object.freeze({ dpr: 1.75, name: '1.75x', zoom: 175 }),
  Object.freeze({ dpr: 2, name: '2x', zoom: 200 }),
  Object.freeze({ dpr: 2.5, name: '2.5x', zoom: 250 }),
  Object.freeze({ dpr: 2.625, name: '2.625x', zoom: 262.5 }),
  Object.freeze({ dpr: 3, name: '3x', zoom: 300 }),
]);

export const DPR_DEFAULTS = Object.freeze({
  // 画布面积上限（Chromium OffscreenCanvas 在部分版本上 268M 像素会失败；取保守的 2^28/4）。
  maxCanvasPixels: 268435456,
  maxSegmentCssHeight: 40000,
  minSegmentCssHeight: 1,
});

function numOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

/** 小数位去噪：1.5000000001 → 1.5，避免签名抖动。 */
function roundDpr(value) {
  return Math.round(numOr(value, 1) * 1e6) / 1e6;
}

/** DPR 是否分数（例如 1.5/2.625）；整数 DPR 下无需补偿。 */
export function isFractionalDpr(value) {
  const dpr = normalizeDpr(value);
  return Math.abs(dpr - Math.round(dpr)) > 1e-9;
}

/** 量化到最接近的 Chromium 档位；超出 1–3 的按 normalizeDpr 收敛。 */
export function quantizeDpr(value) {
  const dpr = normalizeDpr(value);
  let best = DPR_PROFILES[0];
  let bestDelta = Infinity;
  for (const profile of DPR_PROFILES) {
    const delta = Math.abs(profile.dpr - dpr);
    if (delta < bestDelta) {
      best = profile;
      bestDelta = delta;
    }
  }
  return { ...best, actual: roundDpr(dpr), exact: bestDelta < 1e-9, delta: roundDpr(bestDelta) };
}

/** 与 longshot-segments 的 normalizeDprForPlan 等价入口（便于调用方只 import 一个模块）。 */
export function normalizeDprForPlan(value) {
  return Math.round(normalizeDpr(value) * 1000) / 1000;
}

/** CSS → 设备像素，向下取整（clip 起点：不能把不属于本段的像素算进来）。 */
export function alignFloor(cssPx, dpr) {
  const scale = normalizeDpr(dpr);
  const value = Number(cssPx);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.floor(value * scale + 1e-9));
}

/** CSS → 设备像素，向上取整（clip 尺寸：不能漏掉半行）。 */
export function alignCeil(cssPx, dpr) {
  const scale = normalizeDpr(dpr);
  const value = Number(cssPx);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.ceil(value * scale - 1e-9));
}

/** CSS → 设备像素，四舍五入（固定带/元素盒子口径，与 longshot-segments.toDevicePx 一致）。 */
export function alignRound(cssPx, dpr) {
  const scale = normalizeDpr(dpr);
  const value = Number(cssPx);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.round(value * scale));
}

/**
 * 以“累计设备边界”推进的段规划：CSS 段边界 → 设备边界，保证首尾相接。
 *
 * 关键点：第 i 段的设备起点不是 round(cssY_i * dpr)，而是上一段的设备终点；
 * 段设备高度 = round(cssEnd_i * dpr) - deviceY_i。这样无论 dpr 是 1.5 还是 2.625，
 * 段与段之间都不会出现缝隙（累积误差被吸收进每段高度，而不是丢掉一行）。
 *
 * @returns {{
 *   ok: boolean, dpr: number, fractional: boolean, cssHeight: number, deviceHeight: number,
 *   segments: Array<object>, notes: string[], totalDeviceHeight: number,
 * }}
 */
export function planDeviceSegments(params = {}) {
  const dpr = normalizeDprForPlan(params.dpr);
  const cssHeight = Math.max(0, numOr(params.cssHeight, 0));
  const deviceHeight = params.deviceHeight != null
    ? Math.max(0, intOr(params.deviceHeight, 0))
    : (cssHeight > 0 ? Math.ceil(cssHeight * dpr - 1e-9) : 0);
  const maxCss = Math.max(1, numOr(params.maxSegmentCssHeight, DPR_DEFAULTS.maxSegmentCssHeight));
  const minCss = Math.max(1e-6, Math.min(maxCss, numOr(params.minSegmentCssHeight, DPR_DEFAULTS.minSegmentCssHeight)));
  const widthCss = Math.max(0, numOr(params.cssWidth, 0));
  const deviceWidth = params.deviceWidth != null
    ? Math.max(0, intOr(params.deviceWidth, 0))
    : (widthCss > 0 ? Math.ceil(widthCss * dpr - 1e-9) : 0);
  const notes = [];
  if (!(cssHeight > 0) && !(deviceHeight > 0)) {
    return { ok: false, dpr, fractional: isFractionalDpr(dpr), cssHeight: 0, deviceHeight: 0, segments: [], notes: ['页面高度缺失'], totalDeviceHeight: 0, deviceWidth, widthCss };
  }
  const effectiveCssHeight = cssHeight > 0 ? cssHeight : deviceHeight / dpr;
  // 先算 CSS 段高（浮点），最后一段过短时从上一段匀过来（避免 1px 段）。
  const count = Math.max(1, Math.ceil(effectiveCssHeight / maxCss - 1e-9));
  const cssHeights = [];
  let remaining = effectiveCssHeight;
  for (let index = 0; index < count; index += 1) {
    const height = Math.min(maxCss, remaining);
    cssHeights.push(roundDpr(height));
    remaining = roundDpr(remaining - height);
  }
  if (cssHeights.length > 1 && cssHeights[cssHeights.length - 1] < minCss) {
    const last = cssHeights[cssHeights.length - 1];
    const borrow = Math.min(minCss - last, Math.max(0, cssHeights[cssHeights.length - 2] - minCss));
    if (borrow > 0) {
      cssHeights[cssHeights.length - 2] = roundDpr(cssHeights[cssHeights.length - 2] - borrow);
      cssHeights[cssHeights.length - 1] = roundDpr(last + borrow);
    }
  }
  const segments = [];
  let cssCursor = 0;
  let deviceCursor = 0;
  const targetDeviceHeight = deviceHeight > 0 ? deviceHeight : Math.ceil(effectiveCssHeight * dpr - 1e-9);
  for (let index = 0; index < cssHeights.length; index += 1) {
    const cssY = roundDpr(cssCursor);
    const cssEnd = roundDpr(Math.min(effectiveCssHeight, cssY + cssHeights[index]));
    const deviceY = deviceCursor;
    // 段设备终点 = 累计 CSS 终点的取整；段设备高度由两次取整之差得出，误差不累积。
    const deviceEnd = cssEnd >= effectiveCssHeight - 1e-9 ? targetDeviceHeight : Math.round(cssEnd * dpr);
    const deviceHeightOfSegment = Math.max(1, deviceEnd - deviceY);
    segments.push({
      index,
      role: cssHeights.length === 1 ? 'single' : (index === 0 ? 'first' : (index === cssHeights.length - 1 ? 'last' : 'middle')),
      cssY,
      cssHeight: roundDpr(cssEnd - cssY),
      cssEnd,
      deviceY,
      deviceHeight: deviceHeightOfSegment,
      deviceEnd: deviceY + deviceHeightOfSegment,
      // CDP clip 用 CSS 小数坐标（不取整），让浏览器内部乘 dpr 时不丢精度。
      clip: {
        x: 0,
        y: cssY,
        width: roundDpr(widthCss > 0 ? widthCss : deviceWidth / dpr),
        height: roundDpr(cssEnd - cssY),
      },
      dpr,
      fractionalDpr: isFractionalDpr(dpr),
    });
    cssCursor = cssEnd;
    deviceCursor = deviceY + deviceHeightOfSegment;
    if (cssCursor >= effectiveCssHeight - 1e-9) break;
  }
  // 收尾：设备像素总和必须等于目标高度；差 1 行时把差额补到最后一段（而不是留白/越界）。
  const totalDeviceHeight = segments.reduce((sum, segment) => sum + segment.deviceHeight, 0);
  const target = deviceHeight > 0 ? deviceHeight : Math.ceil(effectiveCssHeight * dpr - 1e-9);
  if (segments.length && totalDeviceHeight !== target) {
    const last = segments[segments.length - 1];
    const delta = target - totalDeviceHeight;
    if (delta > 0 || last.deviceHeight + delta >= 1) {
      last.deviceHeight += delta;
      last.deviceEnd = last.deviceY + last.deviceHeight;
      notes.push('设备高度对齐 ' + totalDeviceHeight + '→' + target + '（补到最后一段）');
    }
  }
  if (segments.length > 1) notes.push(count + ' 段以累计设备边界推进（无缝隙无重叠）');
  if (isFractionalDpr(dpr)) notes.push('分数 DPR=' + dpr + '：clip 保留 CSS 小数，设备边界吸收取整误差');
  return {
    ok: true,
    dpr,
    fractional: isFractionalDpr(dpr),
    cssHeight: roundDpr(effectiveCssHeight),
    deviceHeight: target,
    deviceWidth,
    widthCss: roundDpr(widthCss > 0 ? widthCss : deviceWidth / dpr),
    totalDeviceHeight: segments.reduce((sum, segment) => sum + segment.deviceHeight, 0),
    segments,
    notes,
  };
}

/** 画布尺寸：分数 DPR 向上取整，超过面积上限时按比例裁剪并给出证据。 */
export function planFractionalCanvas(params = {}) {
  const dpr = normalizeDprForPlan(params.dpr);
  const cssWidth = Math.max(0, numOr(params.cssWidth, 0));
  const cssHeight = Math.max(0, numOr(params.cssHeight, 0));
  const maxPixels = Math.max(1, numOr(params.maxCanvasPixels, DPR_DEFAULTS.maxCanvasPixels));
  const width = params.deviceWidth != null ? Math.max(1, intOr(params.deviceWidth, 1)) : Math.max(1, Math.ceil(cssWidth * dpr - 1e-9));
  let height = params.deviceHeight != null ? Math.max(1, intOr(params.deviceHeight, 1)) : Math.max(1, Math.ceil(cssHeight * dpr - 1e-9));
  const pixels = width * height;
  let clamped = false;
  if (pixels > maxPixels) {
    // 宽度是 CDP clip 的固有宽度（不能裁掉内容），所以按“上限像素 / 宽”裁高度。
    height = Math.max(1, Math.floor(maxPixels / width));
    clamped = true;
  }
  return {
    width,
    height,
    pixels: width * height,
    dpr,
    fractional: isFractionalDpr(dpr),
    clamped,
    requestedPixels: pixels,
    maxPixels,
    // 画布高度对应的 CSS 高度（反算，便于日志说明“截到哪一行”）。
    cssHeightCovered: roundDpr(height / dpr),
  };
}

/**
 * CDP clip 的分数 DPR 补偿：clip 用 CSS 坐标时，起点向下、尺寸向上，保证覆盖完整。
 * @returns {{x: number, y: number, width: number, height: number, scale: number, device: object, resampled: boolean}}
 */
export function compensateClip(rect, dpr, options = {}) {
  const scale = normalizeDprForPlan(dpr);
  const source = rect && typeof rect === 'object' ? rect : {};
  const rawX = Math.max(0, numOr(source.x != null ? source.x : source.cssX, 0));
  const rawY = Math.max(0, numOr(source.y != null ? source.y : source.cssY, 0));
  const rawWidth = Math.max(0, numOr(source.width != null ? source.width : source.cssWidth, 0));
  const rawHeight = Math.max(0, numOr(source.height != null ? source.height : source.cssHeight, 0));
  const mode = options.mode === 'round' ? 'round' : (options.mode === 'floor' ? 'floor' : 'ceil');
  // 起点用 floor（不能多吃不属于本段的像素），尺寸用 ceil（不能漏半行）。
  const x = Math.floor(rawX * scale + 1e-9) / scale;
  const y = Math.floor(rawY * scale + 1e-9) / scale;
  const deviceX = Math.floor(rawX * scale + 1e-9);
  const deviceY = Math.floor(rawY * scale + 1e-9);
  const deviceRight = mode === 'floor'
    ? Math.floor((rawX + rawWidth) * scale + 1e-9)
    : (mode === 'round' ? Math.round((rawX + rawWidth) * scale) : Math.ceil((rawX + rawWidth) * scale - 1e-9));
  const deviceBottom = mode === 'floor'
    ? Math.floor((rawY + rawHeight) * scale + 1e-9)
    : (mode === 'round' ? Math.round((rawY + rawHeight) * scale) : Math.ceil((rawY + rawHeight) * scale - 1e-9));
  const deviceWidth = Math.max(1, deviceRight - deviceX);
  const deviceHeight = Math.max(1, deviceBottom - deviceY);
  const width = deviceWidth / scale;
  const height = deviceHeight / scale;
  return {
    x: roundDpr(x),
    y: roundDpr(y),
    width: roundDpr(width),
    height: roundDpr(height),
    scale,
    device: { x: deviceX, y: deviceY, width: deviceWidth, height: deviceHeight },
    // 尺寸被向上取整后，位图和 clip 的比例不再是整数比，需要 shrink 采样（canvas 自动处理）。
    resampled: Math.abs(width * scale - deviceWidth) > 1e-9 || Math.abs(height * scale - deviceHeight) > 1e-9,
    fractionalDpr: isFractionalDpr(scale),
  };
}

/** 每段边界的理想值 vs 实际值误差表（设备像素）；用于证明“累积误差被吸收”。 */
export function dprErrorTable(plan) {
  const segments = plan && Array.isArray(plan.segments) ? plan.segments : [];
  const dpr = normalizeDprForPlan(plan && plan.dpr);
  const rows = [];
  let maxAbs = 0;
  for (const segment of segments) {
    const idealY = (Number(segment.cssY) || 0) * dpr;
    const idealHeight = (Number(segment.cssHeight) || 0) * dpr;
    const deltaY = Math.round(((Number(segment.deviceY) || 0) - idealY) * 1000) / 1000;
    const deltaHeight = Math.round(((Number(segment.deviceHeight) || 0) - idealHeight) * 1000) / 1000;
    maxAbs = Math.max(maxAbs, Math.abs(deltaY), Math.abs(deltaHeight));
    rows.push({
      index: intOr(segment.index, rows.length),
      deviceY: intOr(segment.deviceY, 0),
      idealY: Math.round(idealY * 1000) / 1000,
      deltaY,
      deviceHeight: intOr(segment.deviceHeight, 0),
      idealHeight: Math.round(idealHeight * 1000) / 1000,
      deltaHeight,
    });
  }
  return { dpr, rows, maxAbs, bounded: maxAbs < 1 };
}

/** 跨帧 DPR 漂移检测：dpr 变化意味着像素密度不一致，接缝会可见。 */
export function detectDprDrift(samples, options = {}) {
  const list = Array.isArray(samples) ? samples : [];
  const tolerance = Math.max(0, numOr(options.tolerance, 1e-6));
  const values = [];
  for (const sample of list) {
    const value = sample && typeof sample === 'object' ? Number(sample.dpr) : Number(sample);
    if (Number.isFinite(value) && value > 0) values.push(Math.round(value * 1000) / 1000);
  }
  if (values.length < 2) return { stable: true, values, changes: [], dominant: values[0] || 0 };
  const changes = [];
  for (let index = 1; index < values.length; index += 1) {
    if (Math.abs(values[index] - values[index - 1]) > tolerance) {
      changes.push({ index, from: values[index - 1], to: values[index], delta: Math.round((values[index] - values[index - 1]) * 1000) / 1000 });
    }
  }
  // 众数作为主导 DPR（多数帧一致时以多数为准，而不是最后一帧）。
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let dominant = values[0];
  let best = 0;
  for (const [value, count] of counts) {
    if (count > best) {
      best = count;
      dominant = value;
    }
  }
  return { stable: changes.length === 0, values, changes, dominant, agreement: best / values.length };
}

/** 协议 wire。 */
export function dprPlanWire(plan, options = {}) {
  if (!plan || typeof plan !== 'object') {
    return { ok: false, dpr: 1, fractional: false, segments: 0, deviceHeight: 0 };
  }
  const maxSegments = Math.max(0, Math.min(64, intOr(options.maxSegments, 8)));
  const segments = (Array.isArray(plan.segments) ? plan.segments : []).slice(0, maxSegments).map((segment) => ({
    index: intOr(segment.index, 0),
    cssY: roundDpr(numOr(segment.cssY, 0)),
    cssHeight: roundDpr(numOr(segment.cssHeight, 0)),
    deviceY: intOr(segment.deviceY, 0),
    deviceHeight: intOr(segment.deviceHeight, 0),
  }));
  return {
    ok: plan.ok !== false,
    dpr: normalizeDprForPlan(plan.dpr),
    fractional: plan.fractional === true || isFractionalDpr(plan.dpr),
    deviceHeight: intOr(plan.deviceHeight, 0),
    totalDeviceHeight: intOr(plan.totalDeviceHeight, 0),
    segments,
    note: `${segments.length} 段 / ${intOr(plan.deviceHeight, 0)}px`,
  };
}

/** 一行日志：'DPR 1.5（分数）30 段 22500px，设备边界无缝隙'。 */
export function describeDprPlan(plan) {
  if (!plan || !Array.isArray(plan.segments) || !plan.segments.length) return 'DPR 规划 空';
  const fractional = plan.fractional === true || isFractionalDpr(plan.dpr);
  return 'DPR ' + normalizeDprForPlan(plan.dpr) + (fractional ? '（分数）' : '') +
    ' ' + plan.segments.length + ' 段 ' + intOr(plan.deviceHeight, 0) + 'px' +
    (plan.totalDeviceHeight === plan.deviceHeight ? '，设备边界无缝隙' : '，设备高度 ' + plan.totalDeviceHeight);
}

/** 稳定签名：dpr + 段边界，不含时间。 */
export function dprSignature(plan) {
  const segments = plan && Array.isArray(plan.segments) ? plan.segments : [];
  if (!segments.length) return 'dpr:none';
  return 'dpr:' + normalizeDprForPlan(plan.dpr) + ':' +
    segments.map((segment) => intOr(segment.deviceY, 0) + '+' + intOr(segment.deviceHeight, 0)).join(',');
}

/** 段内 tile 的 CSS clip 列表（与 longshot-segments.tileRectsForSegment 对齐但走补偿口径）。 */
export function tileClipsForSegment(segment, tileSize = 512) {
  if (!segment || typeof segment !== 'object') return [];
  const size = Math.max(1, intOr(tileSize, 512));
  const deviceWidth = Math.max(1, intOr(segment.deviceWidth != null ? segment.deviceWidth : segment.width, 1));
  const cssY = numOr(segment.clip && segment.clip.y, numOr(segment.cssY, 0));
  const cssWidth = numOr(segment.clip && segment.clip.width, numOr(segment.widthCss, deviceWidth / normalizeDpr(segment.dpr)));
  const cssHeight = numOr(segment.clip && segment.clip.height, numOr(segment.cssHeight, 0));
  const dpr = normalizeDprForPlan(segment.dpr);
  const clips = [];
  for (let localY = 0; localY < cssHeight - 1e-9; localY += size / dpr) {
    const height = Math.min(size / dpr, cssHeight - localY);
    clips.push(compensateClip({ x: 0, y: cssY + localY, width: cssWidth, height }, dpr));
  }
  return clips;
}
