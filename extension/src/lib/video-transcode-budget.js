// lib/video-transcode-budget.js —— 视频转码（重编码）的成本模型与预算决策（纯函数；第十一批-E）。
//
// 背景：录制产物要么直接封装（不转码），要么为了“可播/更小/修丢帧”重编码。0.3.0 只有
// “bitrate 降级”这一条（lib/video-budget.downgradeBitrate），没有回答：
//   * 这次重编码要花多少 CPU/多久（像素 × 帧数 × 编码器系数）；
//   * 预算内应该选哪一档（分辨率缩放 × 码率 × 编码器）；
//   * 重编后体积是否会超存储配额（与 capture-storage-budget 联动）；
//   * 什么情况下应该拒绝转码、直接保留原始分片。
//
// 本模块把“转码预算”收敛成纯函数：
//   estimateTranscodeCost()   —— 像素/帧数/预计耗时/预计字节（经验系数，可注入）；
//   chooseQualityLadder()     —— 按预算挑档位（原分辨率 → 0.75 → 0.5，或降码率/换编码器）；
//   planVideoTranscode()      —— 决策：skip / transcode / downgrade / reject + 证据；
//   transcodeBudgetWire()/describeTranscode() —— 协议字段与一行日志。
//
// 说明：不做真实编码，不依赖 WebCodecs；运行时（video.seal/verify/recover 的修复路径）读取
// plan 决定“要不要重编、按哪档重编”，真编码仍走既有 MediaRecorder/WebCodecs 路径。

export const TRANSCODE_BUDGET_VERSION = 1;

export const TRANSCODE_ACTIONS = Object.freeze(['skip', 'transcode', 'downgrade', 'reject']);

export const TRANSCODE_CODES = Object.freeze({
  SKIP: 'video.transcode.skip',
  PLAN: 'video.transcode.plan',
  DOWNGRADE: 'video.transcode.downgrade',
  REJECT: 'video.transcode.reject',
  BUDGET: 'video.transcode.budget',
  CODEC: 'video.transcode.codec',
});

export const TRANSCODE_CODECS = Object.freeze(['h264', 'vp9', 'av1']);

export const TRANSCODE_DEFAULTS = Object.freeze({
  // 单次转码允许的最大编码像素（总像素 = 宽×高×帧数）。
  maxTotalPixels: 1200 * 1024 * 1024,
  // 单次转码允许的最大耗时（ms，0 表示不限）；默认 90 秒。
  maxDurationMs: 90 * 1000,
  // 经验系数：每百万像素的编码耗时（ms，h264 软件编码量级）。
  msPerMegapixel: 45,
  // 编码器系数（相对 h264）。
  codecFactors: Object.freeze({ h264: 1, vp9: 1.6, av1: 2.4 }),
  // 目标码率下限/默认值（bps）。
  minBitrate: 500_000,
  defaultBitrate: 4_000_000,
  // 质量档：分辨率缩放与码率系数。
  ladder: Object.freeze([
    { name: 'source', scale: 1, bitrateFactor: 1, codec: 'h264' },
    { name: 'high', scale: 0.75, bitrateFactor: 0.7, codec: 'h264' },
    { name: 'medium', scale: 0.5, bitrateFactor: 0.45, codec: 'h264' },
    { name: 'low', scale: 0.35, bitrateFactor: 0.28, codec: 'h264' },
  ]),
  // 允许的最低缩放（再低就不值得转码了）。
  minScale: 0.25,
  // 预计字节 = 码率 × 时长 / 8 × 容器开销系数。
  containerOverhead: 1.03,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInt(value, min, max, fallback) {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeCodec(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (text === 'avc' || text === 'h264' || text === 'avc1') return 'h264';
  if (text === 'vp9' || text === 'vp09') return 'vp9';
  if (text === 'av1' || text === 'av01') return 'av1';
  return 'h264';
}

function codecFactor(codec) {
  const normalized = normalizeCodec(codec);
  return Number(TRANSCODE_DEFAULTS.codecFactors[normalized]) || 1;
}

/**
 * 估算一次转码成本。
 * @param {{width:number,height:number,fps?:number,durationMs:number,codec?:string,
 *          scale?:number,bitrate?:number,msPerMegapixel?:number,containerOverhead?:number}} params
 */
export function estimateTranscodeCost(params = {}) {
  const width = Math.max(1, intOr(params.width, 1));
  const height = Math.max(1, intOr(params.height, 1));
  const fps = Math.max(0.1, Number(params.fps) || 30);
  const durationMs = Math.max(0, finiteNonNegative(params.durationMs));
  const codec = normalizeCodec(params.codec);
  const scale = Math.max(0.05, Math.min(4, finiteOr(params.scale, 1)));
  const frameCount = Math.max(0, Math.round((durationMs / 1000) * fps));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const pixels = frameCount * outWidth * outHeight;
  const megapixels = pixels / (1024 * 1024);
  const msPerMegapixel = Math.max(0, finiteOr(params.msPerMegapixel, TRANSCODE_DEFAULTS.msPerMegapixel));
  const estimateMs = Math.round(megapixels * msPerMegapixel * codecFactor(codec));
  const bitrate = Math.max(0, intOr(params.bitrate, TRANSCODE_DEFAULTS.defaultBitrate));
  const overhead = Math.max(1, Number(params.containerOverhead) || TRANSCODE_DEFAULTS.containerOverhead);
  const estimateBytes = Math.round((bitrate / 8) * (durationMs / 1000) * overhead);
  return {
    codec,
    width: outWidth,
    height: outHeight,
    scale: Number(scale.toFixed(3)),
    fps: Number(fps.toFixed(3)),
    frameCount,
    seconds: Number((durationMs / 1000).toFixed(3)),
    pixels,
    megapixels: Number(megapixels.toFixed(3)),
    estimateMs,
    bitrate,
    estimateBytes,
    speedRatio: durationMs > 0 ? Number((durationMs / Math.max(1, estimateMs)).toFixed(3)) : 0,
  };
}

/** 质量档位列表（可被调用方覆盖 scale/bitrateFactor/codec；非法项被丢弃）。 */
export function resolveLadder(options = {}) {
  const source = Array.isArray(options.ladder) && options.ladder.length ? options.ladder : TRANSCODE_DEFAULTS.ladder;
  const ladder = [];
  for (const rung of source) {
    if (!isPlainObject(rung)) continue;
    const scale = Number(rung.scale);
    const bitrateFactor = Number(rung.bitrateFactor);
    if (!(scale > 0) || !(bitrateFactor > 0)) continue;
    ladder.push({
      name: String(rung.name || ('rung' + ladder.length)),
      scale: Math.max(TRANSCODE_DEFAULTS.minScale, Math.min(4, scale)),
      bitrateFactor: Math.max(0.01, Math.min(4, bitrateFactor)),
      codec: normalizeCodec(rung.codec),
    });
  }
  if (!ladder.length) {
    for (const rung of TRANSCODE_DEFAULTS.ladder) {
      ladder.push({ name: rung.name, scale: rung.scale, bitrateFactor: rung.bitrateFactor, codec: rung.codec });
    }
  }
  ladder.sort((left, right) => right.scale - left.scale);
  return ladder;
}

/**
 * 选质量档：在预算内选“最接近原始质量”的一档；一档都放不下时返回 null（调用方 reject）。
 * @returns {{rung: object|null, cost: object, fitting: object[], attempts: number}}
 */
export function chooseQualityLadder(params = {}) {
  const budget = {
    maxTotalPixels: Math.max(0, intOr(params.maxTotalPixels, TRANSCODE_DEFAULTS.maxTotalPixels)),
    maxDurationMs: Math.max(0, finiteOr(params.maxDurationMs, TRANSCODE_DEFAULTS.maxDurationMs)),
  };
  const ladder = resolveLadder(params);
  const baseBitrate = Math.max(0, intOr(params.bitrate, TRANSCODE_DEFAULTS.defaultBitrate));
  const fitting = [];
  let attempts = 0;
  for (const rung of ladder) {
    attempts += 1;
    const cost = estimateTranscodeCost({
      ...params,
      codec: rung.codec,
      scale: rung.scale,
      bitrate: Math.round(Math.max(TRANSCODE_DEFAULTS.minBitrate, baseBitrate * rung.bitrateFactor)),
    });
    const fitsPixels = budget.maxTotalPixels <= 0 || cost.pixels <= budget.maxTotalPixels;
    const fitsTime = budget.maxDurationMs <= 0 || cost.estimateMs <= budget.maxDurationMs;
    if (fitsPixels && fitsTime) fitting.push({ rung, cost });
  }
  return {
    rung: fitting.length ? fitting[0].rung : null,
    cost: fitting.length ? fitting[0].cost : null,
    fitting,
    attempts,
    budget,
  };
}

/**
 * 转码预算决策。
 *
 * @param {{
 *   width?: number, height?: number, fps?: number, durationMs?: number,
 *   sourceBytes?: number, sourceBitrate?: number, needTranscode?: boolean,
 *   reason?: string, budget?: object, ladder?: object[],
 *   maxTotalPixels?: number, maxDurationMs?: number, now?: number,
 * }} [options]
 */
export function planVideoTranscode(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const width = Math.max(1, intOr(options.width, 1));
  const height = Math.max(1, intOr(options.height, 1));
  const fps = Math.max(0.1, Number(options.fps) || 30);
  const durationMs = Math.max(0, finiteNonNegative(options.durationMs));
  const sourceBytes = Math.max(0, intOr(options.sourceBytes, options.bytes));
  const sourceBitrate = Math.max(0, intOr(options.sourceBitrate, 0));
  const need = options.needTranscode !== false;
  const baseBitrate = sourceBitrate > 0
    ? sourceBitrate
    : (durationMs > 0 && sourceBytes > 0 ? Math.round((sourceBytes * 8) / (durationMs / 1000)) : TRANSCODE_DEFAULTS.defaultBitrate);
  const picked = chooseQualityLadder({
    width,
    height,
    fps,
    durationMs,
    bitrate: baseBitrate,
    maxTotalPixels: options.maxTotalPixels,
    maxDurationMs: options.maxDurationMs,
    ladder: options.ladder,
    msPerMegapixel: options.msPerMegapixel,
    containerOverhead: options.containerOverhead,
  });
  if (!need) {
    return {
      version: TRANSCODE_BUDGET_VERSION,
      ok: true,
      action: 'skip',
      code: TRANSCODE_CODES.SKIP,
      reason: String(options.reason || 'no-transcode-needed'),
      now,
      source: { width, height, fps, durationMs, bytes: sourceBytes, bitrate: baseBitrate },
      chosen: null,
      cost: null,
      budget: picked.budget,
      attempts: 0,
      evidence: { now, action: 'skip', reason: String(options.reason || 'no-transcode-needed'), sourceBytes },
    };
  }
  if (!picked.rung) {
    return {
      version: TRANSCODE_BUDGET_VERSION,
      ok: false,
      action: 'reject',
      code: TRANSCODE_CODES.REJECT,
      reason: 'budget-exceeded',
      detail: '即使最低档位也超出转码预算',
      now,
      source: { width, height, fps, durationMs, bytes: sourceBytes, bitrate: baseBitrate },
      chosen: null,
      cost: null,
      budget: picked.budget,
      attempts: picked.attempts,
      evidence: { now, action: 'reject', reason: 'budget-exceeded', attempts: picked.attempts, sourceBytes },
    };
  }
  const downscaled = picked.rung.scale < 0.999;
  const action = downscaled ? 'downgrade' : 'transcode';
  const savings = sourceBytes > 0 ? Math.max(0, sourceBytes - picked.cost.estimateBytes) : 0;
  return {
    version: TRANSCODE_BUDGET_VERSION,
    ok: true,
    action,
    code: downscaled ? TRANSCODE_CODES.DOWNGRADE : TRANSCODE_CODES.PLAN,
    reason: String(options.reason || (downscaled ? 'quality-downgrade' : 'planned')),
    now,
    source: { width, height, fps, durationMs, bytes: sourceBytes, bitrate: baseBitrate },
    chosen: {
      name: picked.rung.name,
      scale: picked.rung.scale,
      codec: picked.rung.codec,
      width: picked.cost.width,
      height: picked.cost.height,
      bitrate: picked.cost.bitrate,
    },
    cost: {
      pixels: picked.cost.pixels,
      megapixels: picked.cost.megapixels,
      frameCount: picked.cost.frameCount,
      estimateMs: picked.cost.estimateMs,
      estimateBytes: picked.cost.estimateBytes,
      speedRatio: picked.cost.speedRatio,
    },
    savings: {
      bytes: savings,
      ratio: sourceBytes > 0 ? Number((savings / sourceBytes).toFixed(6)) : 0,
    },
    fitting: picked.fitting.slice(0, 8).map((item) => ({
      name: item.rung.name,
      scale: item.rung.scale,
      pixels: item.cost.pixels,
      estimateMs: item.cost.estimateMs,
      estimateBytes: item.cost.estimateBytes,
    })),
    budget: picked.budget,
    attempts: picked.attempts,
    evidence: {
      now,
      action,
      reason: String(options.reason || 'planned'),
      chosen: picked.rung.name,
      scale: picked.rung.scale,
      codec: picked.rung.codec,
      estimateMs: picked.cost.estimateMs,
      estimateBytes: picked.cost.estimateBytes,
      sourceBytes,
      savingsBytes: savings,
    },
  };
}

/** 编码器回退顺序：h264 最稳（浏览器支持最好），vp9/av1 更省体积但更慢。 */
export function codecFallbackOrder(preferred) {
  const first = normalizeCodec(preferred);
  return [first, ...TRANSCODE_CODECS.filter((codec) => codec !== first)];
}

/** 编码器选择：预算内第一个可用的编码器（预算不足返回 null）。 */
export function pickCodecWithinBudget(params = {}) {
  const order = codecFallbackOrder(params.prefer);
  for (const codec of order) {
    const cost = estimateTranscodeCost({ ...params, codec });
    const fitsPixels = !(params.maxTotalPixels > 0) || cost.pixels <= params.maxTotalPixels;
    const fitsTime = !(params.maxDurationMs > 0) || cost.estimateMs <= params.maxDurationMs;
    if (fitsPixels && fitsTime) return { codec, cost, fits: true, attempts: order.indexOf(codec) + 1 };
  }
  return { codec: null, cost: null, fits: false, attempts: order.length };
}

/** 转码计划 → 协议字段（键集稳定；fitting 截断）。 */
export function transcodeBudgetWire(plan, options = {}) {
  if (!isPlainObject(plan)) {
    return { version: TRANSCODE_BUDGET_VERSION, action: 'skip', ok: false, chosen: null };
  }
  const limit = clampInt(options.maxListed, 0, 16, 4);
  return {
    version: TRANSCODE_BUDGET_VERSION,
    action: String(plan.action || 'skip'),
    ok: plan.ok === true,
    code: plan.code || null,
    reason: plan.reason || '',
    source: plan.source || null,
    chosen: plan.chosen || null,
    cost: plan.cost || null,
    savings: plan.savings || { bytes: 0, ratio: 0 },
    fitting: (Array.isArray(plan.fitting) ? plan.fitting : []).slice(0, limit),
    attempts: plan.attempts || 0,
    text: describeTranscode(plan),
  };
}

/** 一行日志：'视频转码 downgrade：800x600→600x450（h264, 预计 1.8s/1.1MB，省 55%）'。 */
export function describeTranscode(plan) {
  if (!isPlainObject(plan)) return '视频转码 无';
  if (plan.action === 'skip') return '视频转码 skip：' + String(plan.reason || '无需转码');
  if (plan.action === 'reject') return '视频转码 reject：' + String(plan.detail || plan.reason || '预算不足');
  const chosen = plan.chosen || {};
  const cost = plan.cost || {};
  const source = plan.source || {};
  const seconds = cost.estimateMs ? (cost.estimateMs / 1000).toFixed(1) : '?';
  const toMb = (bytes) => (Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(1);
  return '视频转码 ' + String(plan.action) + '：' + (source.width || 0) + 'x' + (source.height || 0) +
    '→' + (chosen.width || 0) + 'x' + (chosen.height || 0) +
    '（' + String(chosen.codec || 'h264') + '，预计 ' + seconds + 's/' + toMb(cost.estimateBytes) + 'MB' +
    (plan.savings && plan.savings.ratio > 0 ? '，省 ' + Math.round(plan.savings.ratio * 100) + '%' : '') + '）';
}
