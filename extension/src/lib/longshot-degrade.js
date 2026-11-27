// lib/longshot-degrade.js —— 长截图预算降级阶梯（纯函数）。
//
// 现状：lib/longshot-budget.js 的 estimateLongshotBudget() 已经会做“总像素超预算 → 下探 DPR、
// 段数超上限 → 增大段高、总高超上限 → 截断”三件事，但它是一次性估算，且只在 DPR/段高/截断
// 三个维度上动。真实运行时超预算时还可以更便宜地降：关掉段间重叠、减小 tile、放弃固定带重绘、
// 减少帧数——这些都不丢内容，只是牺牲接缝质量/证据完整度。反过来，如果 DPR 已经到下限仍然
// 装不下，就必须明确“截断/放弃”，而不是悄悄拍一张超预算的图把 SW 打挂。
//
// 本模块在 estimateLongshotBudget 之上做**可解释的降级阶梯**：
//   planLongshotDegrade()    —— 按代价从低到高逐级尝试，每级记录“改了什么/省了多少/还剩多少”；
//   applyLongshotDegrade()   —— 把阶梯结果落到一份可执行的参数对象上（不修改入参）；
//   restoreLongshotParams()  —— 从降级参数还原原始请求（日志/重试要能解释“原本想拍什么”）；
//   degradeLevelOf()         —— 当前已降到第几级（字符串，便于日志去重）；
//   longshotDegradeWire()/describeLongshotDegrade()。
//
// 阶梯顺序（省内容保真度从小到大）：
//   1. overlap 归零      —— 只影响接缝冗余，不影响覆盖；
//   2. tile 缩小          —— 单 tile 字节下降，但 tile 数上升；
//   3. 固定带不重绘      —— 少拍 1–2 个 tile，牺牲页眉/页脚完整；
//   4. 减少帧数上限      —— 直接截断（truncated 语义，必须如实标记）；
//   5. DPR 下探          —— 像素总量直接下降（可连续下探多档）；
//   6. 段高增大          —— 段数下降（索引/画布压力下降）。
//
// 判定口径：用“无上限估算”（unbounded estimate）判断是否真的超预算，再按预算口径估算报告
// 实际会被截断到多少——两者分开，才不会因为 estimateLongshotBudget 自己先截断而看不到超限。

import {
  LONGSHOT_BUDGET_DEFAULTS,
  estimateLongshotBudget,
  normalizeDpr,
  resolveLongshotBudget,
} from './longshot-budget.js';

export const LONG_SHOT_DEGRADE_VERSION = 1;

export const LONG_SHOT_DEGRADE_ACTIONS = Object.freeze(['continue', 'degrade', 'truncate', 'abort']);

/** 阶梯定义：step 名字会被写进 wire，测试与文档按它对齐。 */
export const LONG_SHOT_DEGRADE_LADDER = Object.freeze([
  Object.freeze({ step: 'overlap', label: '取消段间重叠', cost: 1 }),
  Object.freeze({ step: 'tileSize', label: '缩小 tile 尺寸', cost: 2 }),
  Object.freeze({ step: 'bands', label: '放弃固定带重绘', cost: 3 }),
  Object.freeze({ step: 'frames', label: '减少帧数上限（可能截断）', cost: 4 }),
  Object.freeze({ step: 'dpr', label: '下探 DPR', cost: 5 }),
  Object.freeze({ step: 'segmentHeight', label: '增大段高', cost: 6 }),
]);

const TILE_STEPS = Object.freeze([512, 384, 256, 192, 128]);
const DPR_STEPS = Object.freeze([3, 2.625, 2.5, 2, 1.75, 1.5, 1.25, 1]);
// estimateLongshotBudget 的预算值会被 positiveInt 收敛，Infinity 会回落默认值；这里用足够大的有限值。
const UNLIMITED = Object.freeze({
  maxTotalPixels: 1e12,
  maxTotalDeviceHeight: 1e12,
  maxDeviceDimension: 1e12,
  maxSegments: 1e6,
  maxSegmentPixels: 1e12,
});

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function numOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInt(value, fallback) {
  const number = intOr(value, fallback);
  return number > 0 ? number : fallback;
}

/** 把 resolveLongshotBudget() 的结果摊平成 estimateLongshotBudget 的入参（再加无上限覆盖）。 */
function budgetParams(budget, overrides = null) {
  const source = overrides || budget;
  return {
    maxTotalPixels: source.maxTotalPixels,
    maxTotalDeviceHeight: source.maxTotalDeviceHeight,
    maxDeviceDimension: source.maxDeviceDimension,
    maxSegments: source.maxSegments,
    maxSegmentHeight: source.maxSegmentHeight,
    minSegmentHeight: source.minSegmentHeight,
    maxSegmentPixels: source.maxSegmentPixels,
    bytesPerPixel: source.bytesPerPixel,
    minDpr: budget.minDpr,
    maxDpr: budget.maxDpr,
  };
}

function measure(params, budget, unlimited = false) {
  return estimateLongshotBudget({
    scrollWidth: params.scrollWidth,
    scrollHeight: params.scrollHeight,
    dpr: params.dpr,
    overlap: params.overlap,
    tileSize: params.tileSize,
    maxSegmentHeight: params.maxSegmentHeight,
    ...budgetParams(budget, unlimited ? UNLIMITED : null),
  });
}

function snapshot(estimate) {
  return {
    dpr: estimate.dpr,
    deviceWidth: estimate.deviceWidth,
    deviceHeight: estimate.deviceHeight,
    requestedDeviceHeight: estimate.requestedDeviceHeight,
    totalPixels: estimate.totalPixels,
    megabytes: Math.round((estimate.memoryBytes / (1024 * 1024)) * 100) / 100,
    segments: estimate.totalSegments,
    segmentHeight: estimate.segmentHeight,
    truncated: estimate.truncated === true,
    degraded: estimate.degraded === true,
    reason: estimate.reason || null,
  };
}

/** 超预算原因（用“无上限估算”判断真实请求几何，不看 estimate 自己截断后的值）。 */
function overflowReasons(raw, budget, params) {
  const reasons = [];
  if (raw.totalPixels > budget.maxTotalPixels) reasons.push('pixels');
  if (raw.requestedDeviceHeight > budget.maxTotalDeviceHeight) reasons.push('device-height');
  const requestedWidth = Math.ceil(Math.max(1, params.scrollWidth) * numOr(params.dpr, 1));
  if (requestedWidth > budget.maxDeviceDimension) reasons.push('device-width');
  if (raw.totalSegments > budget.maxSegments && params.maxSegmentHeight < budget.maxSegmentHeight) reasons.push('segments');
  return reasons;
}

/**
 * 降级规划。
 * @param {{
 *   scrollWidth?: number, scrollHeight?: number, dpr?: number, overlap?: number,
 *   tileSize?: number, maxSegmentHeight?: number, maxTiles?: number, keepBands?: boolean,
 *   budget?: object,
 * }} params
 * @returns {{
 *   ok: boolean, version: number, action: string, level: string, steps: Array<object>,
 *   before: object, after: object, params: object, reasons: string[], notes: string[],
 *   budget: object, truncated: boolean,
 * }}
 */
export function planLongshotDegrade(params = {}) {
  const budget = resolveLongshotBudget(params.budget && typeof params.budget === 'object' ? params.budget : params);
  const initial = {
    scrollWidth: Math.max(1, intOr(params.scrollWidth != null ? params.scrollWidth : params.width, 1)),
    scrollHeight: Math.max(1, intOr(params.scrollHeight != null ? params.scrollHeight : params.height, 1)),
    dpr: normalizeDpr(params.dpr, { min: budget.minDpr, max: budget.maxDpr }),
    overlap: Math.max(0, intOr(params.overlap, 0)),
    tileSize: positiveInt(params.tileSize, 512),
    maxSegmentHeight: positiveInt(params.maxSegmentHeight, budget.maxSegmentHeight || LONGSHOT_BUDGET_DEFAULTS.maxSegmentHeight),
    maxTiles: Math.max(1, intOr(params.maxTiles, 0)) || 1,
    keepBands: params.keepBands !== false,
  };
  const steps = [];
  const reasons = [];
  const notes = [];
  const current = { ...initial };
  const firstRaw = params.rawEstimate && typeof params.rawEstimate === 'object' ? params.rawEstimate : measure(initial, budget, true);
  const before = snapshot(firstRaw);
  const beforeReasons = overflowReasons(firstRaw, budget, current);
  if (!beforeReasons.length) {
    // 请求几何本身就在预算内：不降级（estimate 自带截断时如实标 truncate）。
    const official = measure(initial, budget);
    const truncated = official.truncated === true;
    if (truncated) reasons.push('估算按预算上限截断（' + (official.reason || 'device-height') + '），无需降级');
    return {
      ok: true,
      version: LONG_SHOT_DEGRADE_VERSION,
      action: truncated ? 'truncate' : 'continue',
      level: truncated ? 'truncate' : 'none',
      steps,
      before,
      after: snapshot(official),
      params: current,
      reasons,
      notes: truncated ? ['截断来自预算上限而非降级阶梯'] : [],
      budget,
      truncated,
    };
  }
  reasons.push('初始请求超预算（' + beforeReasons.join('+') + '）：' + before.megabytes + 'MB / ' + before.segments + ' 段');

  let raw = firstRaw;
  let overflow = beforeReasons;
  const seen = new Set();
  // 非 DPR 的步骤各只做一次（再做也没有新收益）；DPR 允许连续下探多档。
  const onceSteps = new Set(['overlap', 'tileSize', 'bands', 'frames', 'segmentHeight']);
  for (let pass = 0; pass < 6 && overflow.length; pass += 1) {
    for (const entry of LONG_SHOT_DEGRADE_LADDER) {
      if (!overflow.length) break;
      if (onceSteps.has(entry.step) && seen.has(entry.step)) continue;
      const applied = applyStep(entry.step, current);
      if (!applied) continue;
      seen.add(entry.step);
      const nextRaw = measure(current, budget, true);
      steps.push({
        step: entry.step,
        from: applied.from,
        to: applied.to,
        before: snapshot(raw),
        after: snapshot(nextRaw),
        savedPixels: Math.max(0, raw.totalPixels - nextRaw.totalPixels),
        savedSegments: Math.max(0, raw.totalSegments - nextRaw.totalSegments),
      });
      reasons.push(applied.message);
      raw = nextRaw;
      overflow = overflowReasons(raw, budget, current);
    }
  }

  const official = measure(current, budget);
  const after = snapshot(official);
  const deviceWidthOverflow = overflow.includes('device-width');
  const finishedEarly = overflow.length === 0;
  const action = finishedEarly ? 'degrade' : (deviceWidthOverflow ? 'abort' : 'truncate');
  if (finishedEarly) {
    notes.push('降级阶梯：' + steps.map((step) => step.step).join('→') + '（' + before.megabytes + 'MB → ' + after.megabytes + 'MB）');
  } else if (deviceWidthOverflow) {
    reasons.push('设备像素宽超过上限 ' + budget.maxDeviceDimension + '，降级无法解决（需要换更大预算或分段截宽）');
  } else {
    reasons.push('降级到最低可用档仍超预算（' + overflow.join('+') + '），按预算上限截断输出');
    reasons.push(after.segments + ' 段 / ' + after.megabytes + 'MB（截断后）');
  }
  if (after.reason) notes.push('estimate 原因：' + after.reason);
  return {
    ok: action !== 'abort',
    version: LONG_SHOT_DEGRADE_VERSION,
    action,
    level: steps.length ? steps[steps.length - 1].step : 'none',
    steps,
    before,
    after,
    params: current,
    reasons,
    notes,
    budget,
    truncated: action === 'truncate' || after.truncated === true,
  };
}

/** 单步应用（返回 null 表示当前参数下该步不适用/已到极限）。 */
function applyStep(step, current) {
  switch (step) {
    case 'overlap': {
      if (!(current.overlap > 0)) return null;
      const from = current.overlap;
      current.overlap = 0;
      return { from, to: 0, message: '取消段间重叠（' + from + '→0）' };
    }
    case 'tileSize': {
      const index = TILE_STEPS.indexOf(current.tileSize);
      if (index < 0 || index >= TILE_STEPS.length - 1) return null;
      const from = current.tileSize;
      current.tileSize = TILE_STEPS[index + 1];
      return { from, to: current.tileSize, message: 'tile ' + from + '→' + current.tileSize };
    }
    case 'bands': {
      if (!current.keepBands) return null;
      current.keepBands = false;
      return { from: true, to: false, message: '放弃固定带重绘（页眉/页脚可能不完整）' };
    }
    case 'frames': {
      if (!(current.maxTiles > 1)) return null;
      const from = current.maxTiles;
      current.maxTiles = Math.max(1, Math.floor(from / 2));
      return { from, to: current.maxTiles, message: '帧数上限 ' + from + '→' + current.maxTiles + '（底部可能截断）' };
    }
    case 'dpr': {
      const lower = DPR_STEPS.filter((value) => value < current.dpr && value >= 1);
      if (!lower.length) return null;
      const from = current.dpr;
      current.dpr = lower[0];
      return { from, to: current.dpr, message: 'DPR ' + from + '→' + current.dpr };
    }
    case 'segmentHeight': {
      const target = Math.max(current.maxSegmentHeight, LONGSHOT_BUDGET_DEFAULTS.maxSegmentHeight);
      if (target === current.maxSegmentHeight) return null;
      const from = current.maxSegmentHeight;
      current.maxSegmentHeight = target;
      return { from, to: target, message: '段高 ' + from + '→' + target };
    }
    default:
      return null;
  }
}

/** 把降级结果落到参数对象（只加/改被降的字段，不修改入参）。 */
export function applyLongshotDegrade(params, plan) {
  const base = params && typeof params === 'object' ? { ...params } : {};
  const stepPlan = plan && typeof plan === 'object' ? plan : null;
  if (!stepPlan || !Array.isArray(stepPlan.steps) || !stepPlan.steps.length) return base;
  for (const step of stepPlan.steps) {
    if (!step || typeof step !== 'object') continue;
    switch (step.step) {
      case 'overlap':
        base.overlap = 0;
        break;
      case 'tileSize':
        base.tileSize = intOr(step.to, base.tileSize);
        break;
      case 'bands':
        base.keepBands = false;
        break;
      case 'frames':
        base.maxTiles = intOr(step.to, base.maxTiles);
        base.truncated = true;
        break;
      case 'dpr':
        base.dpr = numOr(step.to, base.dpr);
        break;
      case 'segmentHeight':
        base.maxSegmentHeight = intOr(step.to, base.maxSegmentHeight);
        break;
      default:
        break;
    }
  }
  base.degradedLevel = stepPlan.level || 'none';
  base.degradedAction = stepPlan.action || 'continue';
  return base;
}

/** 从“被降级的参数”还原原始请求：把阶梯反向走一遍（用于日志/重试解释）。 */
export function restoreLongshotParams(plan) {
  const stepPlan = plan && typeof plan === 'object' ? plan : null;
  if (!stepPlan || !Array.isArray(stepPlan.steps) || !stepPlan.steps.length) return {};
  const restored = {};
  for (const step of stepPlan.steps.slice().reverse()) {
    if (!step || typeof step !== 'object') continue;
    switch (step.step) {
      case 'overlap':
        restored.overlap = intOr(step.from, 0);
        break;
      case 'tileSize':
        restored.tileSize = intOr(step.from, 512);
        break;
      case 'bands':
        restored.keepBands = step.from !== false;
        break;
      case 'frames':
        restored.maxTiles = intOr(step.from, 0);
        break;
      case 'dpr':
        restored.dpr = numOr(step.from, 1);
        break;
      case 'segmentHeight':
        restored.maxSegmentHeight = intOr(step.from, 0);
        break;
      default:
        break;
    }
  }
  return restored;
}

/** 当前降级级别（没有降级 → 'none'；截断/放弃优先于阶梯级别）。 */
export function degradeLevelOf(plan) {
  if (!plan || typeof plan !== 'object') return 'none';
  if (plan.action === 'abort') return 'abort';
  if (plan.action === 'continue') return 'none';
  if (plan.action === 'truncate') return 'truncate';
  return String(plan.level || 'none');
}

/** 协议 wire（结果字段只加不改：budget_report 仍是 longshot-budget 的口径）。 */
export function longshotDegradeWire(plan, options = {}) {
  if (!plan || typeof plan !== 'object') {
    return { version: LONG_SHOT_DEGRADE_VERSION, action: 'continue', level: 'none', steps: [], truncated: false };
  }
  const maxSteps = Math.max(0, Math.min(12, intOr(options.maxSteps, 8)));
  return {
    version: LONG_SHOT_DEGRADE_VERSION,
    action: String(plan.action || 'continue'),
    level: degradeLevelOf(plan),
    steps: (Array.isArray(plan.steps) ? plan.steps : []).slice(-maxSteps).map((step) => ({
      step: String(step && step.step || ''),
      from: step && step.from,
      to: step && step.to,
      megabytes_before: step && step.before ? step.before.megabytes : null,
      megabytes_after: step && step.after ? step.after.megabytes : null,
      saved_pixels: intOr(step && step.savedPixels, 0),
    })),
    truncated: plan.truncated === true,
    before: plan.before || null,
    after: plan.after || null,
    reasons: (Array.isArray(plan.reasons) ? plan.reasons : []).slice(-4),
  };
}

/** 一行日志：'长截图预算降级 degrade：overlap→tileSize→dpr（120.5MB → 40.2MB，动作 degrade）'。 */
export function describeLongshotDegrade(plan) {
  if (!plan || typeof plan !== 'object') return '长截图预算 无降级规划';
  const action = String(plan.action || 'continue');
  if (action === 'continue') return '长截图预算 未超限（' + (plan.before ? plan.before.megabytes : 0) + 'MB）';
  const steps = Array.isArray(plan.steps) ? plan.steps.map((step) => step && step.step).filter(Boolean).join('→') : '';
  const from = plan.before ? plan.before.megabytes : 0;
  const to = plan.after ? plan.after.megabytes : 0;
  return '长截图预算降级 ' + action + '：' + (steps || '无') + '（' + from + 'MB → ' + to + 'MB' +
    (plan.truncated ? '，已截断' : '') + '）';
}
