// lib/longshot-budget.js —— 长截图的像素/内存/并发预算（纯函数；service worker 与 Node 单测共用）。
//
// 背景：分块长截图同时吃三份内存：OffscreenCanvas 画布（RGBA）、每个 PNG Blob、以及
// IndexedDB 里的分片副本。0.3.0 之前只有 MAX_TILED_HEIGHT=40000 这一条硬上限：
//   * 超宽页面（例如 40000px 宽 × 40000px 高）仍会申请 1.6G 像素的段画布，直接失败；
//   * 超高页面被静默截断到 160000 设备像素，调用方拿不到“内容为什么少了”的证据。
//
// 本模块把预算收敛成纯函数，让 tiled-capture 在真正申请画布之前就能：
//   1) 按“单段像素上限”切段（段高 = min(maxSegmentHeight, maxSegmentPixels / 段宽)）；
//   2) 按“总像素上限”降级 DPR（分数 DPR 档位 3 → 2.5 → 2 → 1.75 → 1.5 → 1.25 → 1），
//      而不是直接把画面砍掉；
//   3) 仍超限时显式截断并把原因写进 {budget, used, degraded, reason} 证据；
//   4) 给出并发上限与有界并发执行器（同一 CDP session 默认串行，见 chooseTileConcurrency）。
//
// 设计约束：不依赖 DOM/Canvas/IDB，纯数值规划；可在 Node 里逐条断言边界。

export const LONGSHOT_BUDGET_DEFAULTS = Object.freeze({
  // 单段画布像素上限；64M px ≈ 256MB RGBA，低于 Chrome 单画布面积上限（约 268M px）。
  maxSegmentPixels: 64 * 1024 * 1024,
  // 整张长截图累计像素上限（按 RGBA 估算约 1.6GB）。
  maxTotalPixels: 400 * 1024 * 1024,
  // 并发上限：同一 debugger session 的 Page.captureScreenshot 会被浏览器串行化，
  // 所以默认请求并发是 1；预算只负责给出“允许的上限”，由调用方决定是否提高。
  maxConcurrent: 2,
  maxSegments: 16,
  maxSegmentHeight: 40000,
  minSegmentHeight: 256,
  maxDeviceDimension: 40000,
  // 与 0.3.0 的“总高 4 × 40000 设备像素”截断行为对齐；区别是现在会标记 degraded。
  maxTotalDeviceHeight: 160000,
  minDpr: 1,
  maxDpr: 3,
  bytesPerPixel: 4,
});

// DPR 降级档位：命中常见分数 DPR（Windows 125%/150%/175%，macOS 2x/3x）。
const DPR_STEPS = Object.freeze([3, 2.5, 2, 1.75, 1.5, 1.25, 1]);

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.round(number));
}

/** 把 DPR 规整到 [min, max] 并保留最多 3 位小数（1.5 仍是 1.5，不会变成 1.4999999）。 */
export function normalizeDpr(input, options = {}) {
  const min = Number.isFinite(Number(options.min)) && Number(options.min) > 0
    ? Number(options.min)
    : LONGSHOT_BUDGET_DEFAULTS.minDpr;
  const max = Number.isFinite(Number(options.max)) && Number(options.max) > 0
    ? Number(options.max)
    : LONGSHOT_BUDGET_DEFAULTS.maxDpr;
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return min;
  return Math.round(Math.min(max, Math.max(min, value)) * 1000) / 1000;
}

/** 合并调用方覆盖项与默认预算；非法值回落默认，避免 0/NaN 变成“无上限”。 */
export function resolveLongshotBudget(options = {}) {
  const defaults = LONGSHOT_BUDGET_DEFAULTS;
  return {
    maxSegmentPixels: positiveInt(options.maxSegmentPixels, defaults.maxSegmentPixels),
    maxTotalPixels: positiveInt(options.maxTotalPixels, defaults.maxTotalPixels),
    maxConcurrent: positiveInt(options.maxConcurrent, defaults.maxConcurrent),
    maxSegments: positiveInt(options.maxSegments, defaults.maxSegments),
    maxSegmentHeight: positiveInt(options.maxSegmentHeight, defaults.maxSegmentHeight),
    minSegmentHeight: Math.min(
      positiveInt(options.maxSegmentHeight, defaults.maxSegmentHeight),
      positiveInt(options.minSegmentHeight, defaults.minSegmentHeight),
    ),
    maxDeviceDimension: positiveInt(options.maxDeviceDimension, defaults.maxDeviceDimension),
    maxTotalDeviceHeight: positiveInt(options.maxTotalDeviceHeight, defaults.maxTotalDeviceHeight),
    minDpr: Number.isFinite(Number(options.minDpr)) && Number(options.minDpr) > 0
      ? Math.max(0.1, Number(options.minDpr))
      : defaults.minDpr,
    maxDpr: Number.isFinite(Number(options.maxDpr)) && Number(options.maxDpr) >= 1
      ? Number(options.maxDpr)
      : defaults.maxDpr,
    bytesPerPixel: positiveInt(options.bytesPerPixel, defaults.bytesPerPixel),
  };
}

/** 在给定 DPR 下计算画布几何；纯几何，不含任何“是否超预算”的判断。 */
function shapeAt(cssWidth, cssHeight, dpr, budget) {
  const requestedWidth = Math.max(1, Math.ceil(cssWidth * dpr));
  const deviceWidth = Math.min(requestedWidth, budget.maxDeviceDimension);
  const requestedHeight = Math.max(1, Math.ceil(cssHeight * dpr));
  const deviceHeight = requestedHeight;
  // 段高同时受“单段像素”和“单段最大高度”约束；段宽越大，段越矮。
  const pixelLimitedHeight = Math.floor(budget.maxSegmentPixels / Math.max(1, deviceWidth));
  const segmentHeight = Math.max(
    budget.minSegmentHeight,
    Math.min(budget.maxSegmentHeight, pixelLimitedHeight > 0 ? pixelLimitedHeight : budget.maxSegmentHeight),
  );
  const totalSegments = Math.max(1, Math.ceil(deviceHeight / segmentHeight));
  const totalPixels = deviceWidth * deviceHeight;
  return {
    requestedWidth,
    requestedHeight,
    deviceWidth,
    deviceHeight,
    segmentHeight,
    totalSegments,
    totalPixels,
    memoryBytes: totalPixels * budget.bytesPerPixel,
  };
}

/**
 * 规划一次长截图的像素预算。
 *
 * @param {{
 *   scrollWidth?: number, width?: number,
 *   scrollHeight?: number, height?: number,
 *   dpr?: number,
 *   maxSegmentPixels?: number, maxTotalPixels?: number, maxConcurrent?: number,
 *   maxSegments?: number, maxSegmentHeight?: number, minSegmentHeight?: number,
 *   maxDeviceDimension?: number, maxTotalDeviceHeight?: number,
 *   minDpr?: number, maxDpr?: number, bytesPerPixel?: number,
 *   concurrency?: number,
 * }} [params]
 * @returns {{
 *   ok: true, requestedDpr: number, dpr: number, fractional: boolean,
 *   cssWidth: number, cssHeight: number, deviceWidth: number, deviceHeight: number,
 *   totalPixels: number, memoryBytes: number, segmentHeight: number, totalSegments: number,
 *   truncated: boolean, degraded: boolean, reason: string|null, notes: string[],
 *   concurrency: number, concurrencyEvidence: object, budget: object,
 * }}
 */
export function estimateLongshotBudget(params = {}) {
  const budget = resolveLongshotBudget(params);
  const cssWidth = Math.max(1, Math.round(Number(params.scrollWidth) || Number(params.width) || 1));
  const cssHeight = Math.max(1, Math.round(Number(params.scrollHeight) || Number(params.height) || 1));
  const requestedDpr = normalizeDpr(params.dpr, { min: budget.minDpr, max: budget.maxDpr });
  const notes = [];
  let reason = null;
  let dpr = requestedDpr;
  let shape = shapeAt(cssWidth, cssHeight, dpr, budget);

  if (shape.requestedWidth > budget.maxDeviceDimension) {
    notes.push('设备像素宽 ' + shape.requestedWidth + ' 超过上限 ' + budget.maxDeviceDimension + '，按上限裁剪');
    reason = reason || 'device-width';
  }

  // 总像素超预算、或总高超过设备像素上限时，按 DPR 档位下探；只有命中可行档位才真正降级。
  if (shape.totalPixels > budget.maxTotalPixels || shape.requestedHeight > budget.maxTotalDeviceHeight) {
    const candidates = [requestedDpr]
      .concat(DPR_STEPS.filter((step) => step < requestedDpr))
      .filter((value, index, list) => list.indexOf(value) === index);
    for (const candidate of candidates) {
      const candidateShape = shapeAt(cssWidth, cssHeight, candidate, budget);
      const heightFits = candidateShape.requestedHeight <= budget.maxTotalDeviceHeight;
      const pixelsFit = candidateShape.totalPixels <= budget.maxTotalPixels;
      if (!heightFits || !pixelsFit) continue;
      if (candidate !== requestedDpr) {
        notes.push('总像素/总高超出预算，DPR 从 ' + requestedDpr + ' 降级到 ' + candidate);
        reason = reason || 'memory-budget';
      }
      dpr = candidate;
      shape = candidateShape;
      break;
    }
  }

  let deviceHeight = shape.deviceHeight;
  let truncated = false;
  if (deviceHeight > budget.maxTotalDeviceHeight) {
    deviceHeight = budget.maxTotalDeviceHeight;
    truncated = true;
    notes.push('总高 ' + shape.deviceHeight + ' 超过设备像素上限 ' + budget.maxTotalDeviceHeight + '，按上限截断');
    reason = reason || 'device-height';
  }
  if (shape.deviceWidth * deviceHeight > budget.maxTotalPixels) {
    const clipped = Math.max(1, Math.floor(budget.maxTotalPixels / shape.deviceWidth));
    deviceHeight = Math.min(deviceHeight, clipped);
    truncated = true;
    notes.push('总像素超过预算 ' + budget.maxTotalPixels + '，截断到 ' + deviceHeight + ' 设备像素高');
    reason = reason || 'memory-budget';
  }

  let segmentHeight = shape.segmentHeight;
  let totalSegments = Math.max(1, Math.ceil(deviceHeight / segmentHeight));
  if (totalSegments > budget.maxSegments) {
    const before = totalSegments;
    const grown = Math.min(
      budget.maxSegmentHeight,
      Math.max(shape.segmentHeight, Math.ceil(deviceHeight / budget.maxSegments)),
    );
    segmentHeight = Math.max(1, grown);
    totalSegments = Math.max(1, Math.ceil(deviceHeight / segmentHeight));
    notes.push('段数 ' + before + ' 超过上限 ' + budget.maxSegments + '，段高增大到 ' + segmentHeight);
    reason = reason || 'segment-count';
    if (totalSegments > budget.maxSegments) {
      deviceHeight = segmentHeight * budget.maxSegments;
      totalSegments = budget.maxSegments;
      truncated = true;
      notes.push('段数仍超上限，截断到 ' + deviceHeight + ' 设备像素高');
    }
  }

  const totalPixels = shape.deviceWidth * deviceHeight;
  const concurrencyEvidence = chooseTileConcurrency({
    requested: params.concurrency,
    budget,
    tiles: totalSegments,
  });
  return {
    ok: true,
    requestedDpr,
    dpr,
    fractional: Math.abs(dpr - Math.round(dpr)) > 1e-9,
    cssWidth,
    cssHeight,
    deviceWidth: shape.deviceWidth,
    deviceHeight,
    requestedDeviceHeight: shape.requestedHeight,
    totalPixels,
    memoryBytes: totalPixels * budget.bytesPerPixel,
    segmentHeight,
    totalSegments,
    truncated,
    degraded: reason !== null,
    reason,
    notes,
    concurrency: concurrencyEvidence.concurrency,
    concurrencyEvidence,
    budget,
  };
}

/**
 * 并发上限收敛：请求值 → 预算上限 → 实际任务数三重取小。
 * 注意同一 debugger session 的截图命令默认串行，调用方不显式提高 requested 时就是 1。
 */
export function chooseTileConcurrency(options = {}) {
  const budget = options.budget && typeof options.budget === 'object'
    ? options.budget
    : LONGSHOT_BUDGET_DEFAULTS;
  const max = positiveInt(budget.maxConcurrent, LONGSHOT_BUDGET_DEFAULTS.maxConcurrent);
  const wanted = positiveInt(options.requested, 1);
  let concurrency = Math.min(wanted, max);
  let reason = null;
  if (concurrency < wanted) reason = 'budget';
  const tileCount = Number(options.tiles);
  if (Number.isFinite(tileCount) && tileCount > 0) {
    concurrency = Math.min(concurrency, Math.max(1, Math.ceil(tileCount)));
  }
  return { concurrency, wanted, max, reason };
}

/**
 * 有界并发执行器：最多 limit 个 worker 同时跑，结果按入参顺序返回；
 * 任一任务失败后不再调度新任务（先完成的保留，最终抛出第一个错误）。
 */
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (typeof worker !== 'function') throw new TypeError('mapWithConcurrency 需要 worker 函数');
  if (!list.length) return [];
  const size = Math.max(1, Math.min(positiveInt(limit, 1), list.length));
  const results = new Array(list.length);
  let cursor = 0;
  let failure = null;
  const run = async () => {
    while (failure === null) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
      } catch (error) {
        if (failure === null) failure = error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: size }, () => run()));
  if (failure !== null) throw failure;
  return results;
}

/** 按 tile 尺寸估算一次截图要发多少条 CDP 命令（用于日志/预算解释）。 */
export function estimateTileCount(options = {}) {
  const size = positiveInt(options.tileSize, 512);
  const width = positiveInt(options.deviceWidth, 1);
  const height = positiveInt(options.deviceHeight, 1);
  const cols = Math.max(1, Math.ceil(width / size));
  const rows = Math.max(1, Math.ceil(height / size));
  return { cols, rows, tiles: cols * rows };
}

/** 输出给协议调用方的预算证据：{budget, used, degraded, reason, truncated}。 */
export function budgetReport(estimate) {
  const value = estimate && typeof estimate === 'object' ? estimate : {};
  const budget = value.budget && typeof value.budget === 'object' ? value.budget : LONGSHOT_BUDGET_DEFAULTS;
  return {
    budget: {
      maxSegmentPixels: budget.maxSegmentPixels,
      maxTotalPixels: budget.maxTotalPixels,
      maxConcurrent: budget.maxConcurrent,
      maxSegments: budget.maxSegments,
      maxSegmentHeight: budget.maxSegmentHeight,
      maxTotalDeviceHeight: budget.maxTotalDeviceHeight,
    },
    used: {
      dpr: value.dpr,
      deviceWidth: value.deviceWidth,
      deviceHeight: value.deviceHeight,
      totalPixels: value.totalPixels,
      memoryBytes: value.memoryBytes,
      segmentHeight: value.segmentHeight,
      segments: value.totalSegments,
      concurrency: value.concurrency,
    },
    degraded: value.degraded === true,
    reason: value.degraded === true ? (value.reason || 'unspecified') : null,
    truncated: value.truncated === true,
  };
}

/** 一行日志：'2 段 × 40000px, dpr=1.5, 84.0Mpx, 降级 memory-budget'。 */
export function describeBudget(estimate) {
  if (!estimate || estimate.ok !== true) return '预算不可用';
  const mp = estimate.totalPixels > 0 ? (estimate.totalPixels / 1e6).toFixed(1) : '0';
  let text = estimate.totalSegments + ' 段 × ' + estimate.segmentHeight + 'px, dpr=' + estimate.dpr +
    ', ' + estimate.deviceWidth + 'x' + estimate.deviceHeight + ', ' + mp + 'Mpx';
  if (estimate.degraded) text += ', 降级 ' + estimate.reason;
  if (estimate.truncated) text += ', 已截断';
  return text;
}
