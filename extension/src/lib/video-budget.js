// extension/src/lib/video-budget.js —— 视频录制的时长/体积/分段/并发预算与超限策略。
//
// 预算约束（默认值与 video.js 的既有 10 分钟 / 256MB 上限一致，只是显式化、可注入、可报告）：
//   maxDurationMs   最大时长        超限 → stop（stop_reason='duration'）
//   maxTotalBytes   整段体积上限    超限 → stop（stop_reason='size'）
//   maxSegmentBytes 单段体积上限    超限 → pause-segment（收口当前分片并起新分片，不丢帧）
//   maxConcurrent   并发录制数      超限 → reject（调用方拒绝 start，给结构化证据）
//   bitrateFloor    降码率下限      靠近体积上限 → downgrade-bitrate（按 downgradeRatio 下调）
//
// 本模块只做纯计算：video.js 在 start/status/fetch 时消费；encoded-writer 在写分片时把
// 预算读数写进 manifest，收尾 seal 时作为 durability/预算证据。

import { BUDGET_CODES } from './video-codes.js';

export { BUDGET_CODES };

export const VIDEO_BUDGET_VERSION = 1;

export const VIDEO_BUDGET_DEFAULTS = Object.freeze({
  maxDurationMs: 10 * 60 * 1000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxSegmentBytes: 64 * 1024 * 1024,
  maxConcurrent: 1,
  bitrateFloor: 1_000_000,
  downgradeRatio: 0.6,
  warnRatio: 0.9,
  minDurationMs: 1000,
});

export const BUDGET_ACTIONS = Object.freeze(['continue', 'pause-segment', 'downgrade-bitrate', 'stop', 'reject']);

const NUMERIC_FIELDS = Object.freeze([
  'maxDurationMs',
  'maxTotalBytes',
  'maxSegmentBytes',
  'maxConcurrent',
  'bitrateFloor',
  'downgradeRatio',
  'warnRatio',
  'minDurationMs',
]);

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

/**
 * 归一化预算：非法值回退默认并给出 problem（不抛异常）；未知键按需告警。
 * @returns {{budget: object, problems: Array, normalized: boolean}}
 */
export function normalizeBudget(input = {}, options = {}) {
  const base = { ...VIDEO_BUDGET_DEFAULTS, ...(options.base && typeof options.base === 'object' ? options.base : {}) };
  const problems = [];
  const budget = {};
  if (input != null && typeof input !== 'object') {
    problems.push({ code: BUDGET_CODES.INVALID, field: 'input', detail: '预算必须是对象', value: String(input) });
  }
  const source = input && typeof input === 'object' ? input : {};

  for (const field of NUMERIC_FIELDS) {
    const fallback = finitePositive(base[field]) || VIDEO_BUDGET_DEFAULTS[field];
    if (!(field in source)) {
      budget[field] = fallback;
      continue;
    }
    const raw = Number(source[field]);
    if (!Number.isFinite(raw) || raw <= 0) {
      budget[field] = field === 'maxDurationMs' || field === 'minDurationMs' ? fallback : fallback;
      problems.push({
        code: BUDGET_CODES.INVALID,
        field,
        detail: '必须是正数；已回退默认值',
        value: source[field] == null ? null : String(source[field]),
        fallback,
      });
      continue;
    }
    budget[field] = raw;
  }

  budget.maxDurationMs = Math.round(clampNumber(budget.maxDurationMs, VIDEO_BUDGET_DEFAULTS.minDurationMs, 24 * 60 * 60 * 1000));
  budget.maxTotalBytes = Math.round(clampNumber(budget.maxTotalBytes, 1024 * 1024, 2 * 1024 * 1024 * 1024));
  budget.maxSegmentBytes = Math.round(clampNumber(budget.maxSegmentBytes, 64 * 1024, budget.maxTotalBytes));
  budget.maxConcurrent = Math.round(clampNumber(budget.maxConcurrent, 1, 8));
  budget.bitrateFloor = Math.round(clampNumber(budget.bitrateFloor, 100_000, 50_000_000));
  budget.downgradeRatio = clampNumber(budget.downgradeRatio, 0.1, 0.9);
  budget.warnRatio = clampNumber(budget.warnRatio, budget.downgradeRatio + 0.05, 1);
  budget.minDurationMs = Math.round(clampNumber(budget.minDurationMs, 100, budget.maxDurationMs));

  if (options.strict === true) {
    for (const key of Object.keys(source)) {
      if (!NUMERIC_FIELDS.includes(key)) {
        problems.push({ code: BUDGET_CODES.INVALID, field: key, detail: '未知预算字段（已忽略）' });
      }
    }
  }
  return { budget, problems, normalized: problems.length === 0 };
}

/** 请求时长按预算裁剪：0 表示不限（沿用既有 offscreen 行为），超限裁剪并给证据。 */
export function clampDuration(requestedMs, budget = VIDEO_BUDGET_DEFAULTS) {
  const requested = Number(requestedMs);
  const max = finitePositive(budget.maxDurationMs) || VIDEO_BUDGET_DEFAULTS.maxDurationMs;
  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: true, durationMs: 0, requestedMs: 0, maxDurationMs: max, clamped: false, evidence: [] };
  }
  const durationMs = Math.min(Math.round(requested), Math.round(max));
  return {
    ok: true,
    durationMs,
    requestedMs: Math.round(requested),
    maxDurationMs: Math.round(max),
    clamped: durationMs !== Math.round(requested),
    evidence: durationMs !== Math.round(requested)
      ? [{ code: BUDGET_CODES.DURATION, detail: '请求时长超过预算，已裁剪', requestedMs: Math.round(requested), maxDurationMs: Math.round(max) }]
      : [],
  };
}

/** 按码率与已用时长预估整段体积（用于“接近上限就降码率”）。 */
export function projectedBytesFor(usage = {}, budget = VIDEO_BUDGET_DEFAULTS) {
  const totalBytes = Math.max(0, Number(usage.totalBytes) || 0);
  const elapsedMs = Math.max(0, Number(usage.elapsedMs) || 0);
  const bitrate = finitePositive(usage.bitrate);
  const maxDurationMs = finitePositive(budget.maxDurationMs) || 0;
  if (!bitrate || !maxDurationMs) return totalBytes;
  const remainingMs = Math.max(0, maxDurationMs - elapsedMs);
  const bytesPerMs = bitrate / 8 / 1000;
  return Math.round(totalBytes + bytesPerMs * remainingMs);
}

/** 按比例下调码率（不低于 floor，按 1kbps 对齐），返回实际目标值。 */
export function downgradeBitrate(bitrate, budget = VIDEO_BUDGET_DEFAULTS) {
  const current = finitePositive(bitrate);
  const floor = finitePositive(budget.bitrateFloor) || VIDEO_BUDGET_DEFAULTS.bitrateFloor;
  const ratio = Number(budget.downgradeRatio) > 0 ? Number(budget.downgradeRatio) : VIDEO_BUDGET_DEFAULTS.downgradeRatio;
  if (!current) return 0;
  const next = Math.round((current * ratio) / 1000) * 1000;
  return Math.max(floor, Math.min(current, next));
}

function usageValue(usage, key) {
  const number = Number(usage && usage[key]);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * 评估一次预算：
 * @param {{activeCount?:number, elapsedMs?:number, totalBytes?:number, bytes?:number, segmentBytes?:number,
 *          bitrate?:number, maxDurationMs?:number}} usage
 * @returns {{ok:boolean, action:string, code:string|null, stop_reason:string|null,
 *            exceeded:Array, warnings:Array, evidence:object, downgradedBitrate:number, projectedBytes:number}}
 */
export function evaluateBudget(usage = {}, budget = VIDEO_BUDGET_DEFAULTS) {
  const effective = { ...VIDEO_BUDGET_DEFAULTS, ...(budget && typeof budget === 'object' ? budget : {}) };
  const activeCount = usageValue(usage, 'activeCount');
  const elapsedMs = usageValue(usage, 'elapsedMs');
  const totalBytes = Math.max(usageValue(usage, 'totalBytes'), usageValue(usage, 'bytes'));
  const segmentBytes = usageValue(usage, 'segmentBytes');
  const bitrate = usageValue(usage, 'bitrate');
  const maxDurationMs = finitePositive(usage.maxDurationMs) || finitePositive(effective.maxDurationMs) || 0;
  const maxTotalBytes = finitePositive(effective.maxTotalBytes) || VIDEO_BUDGET_DEFAULTS.maxTotalBytes;
  const maxSegmentBytes = finitePositive(effective.maxSegmentBytes) || VIDEO_BUDGET_DEFAULTS.maxSegmentBytes;
  const maxConcurrent = finitePositive(effective.maxConcurrent) || VIDEO_BUDGET_DEFAULTS.maxConcurrent;
  const warnRatio = Number(effective.warnRatio) > 0 ? Number(effective.warnRatio) : VIDEO_BUDGET_DEFAULTS.warnRatio;
  const projectedBytes = Math.max(
    Math.round(Number(usage.projectedBytes) || 0),
    projectedBytesFor({ totalBytes, elapsedMs, bitrate }, { ...effective, maxDurationMs }),
  );

  const result = (action, code, extra = {}) => ({
    ok: action === 'continue',
    action,
    code,
    stop_reason: null,
    exceeded: [],
    warnings: [],
    projectedBytes,
    downgradedBitrate: 0,
    evidence: {
      action,
      usage: { activeCount, elapsedMs, totalBytes, segmentBytes, bitrate },
      budget: {
        maxDurationMs,
        maxTotalBytes,
        maxSegmentBytes,
        maxConcurrent,
        warnRatio,
      },
      projectedBytes,
      at: Number(usage.at) || 0,
    },
    ...extra,
  });

  // 1) 并发：拒绝启动（不是停止）。
  if (activeCount > maxConcurrent) {
    return result('reject', BUDGET_CODES.CONCURRENT, {
      exceeded: [{ code: BUDGET_CODES.CONCURRENT, activeCount, maxConcurrent }],
      evidence: {
        action: 'reject',
        reason: 'concurrent_limit',
        activeCount,
        maxConcurrent,
        projectedBytes,
        at: Number(usage.at) || 0,
      },
    });
  }

  // 2) 硬上限：时长与整段体积 → 停止并说明原因。
  if (maxDurationMs > 0 && elapsedMs >= maxDurationMs) {
    return result('stop', BUDGET_CODES.DURATION, {
      stop_reason: 'duration',
      exceeded: [{ code: BUDGET_CODES.DURATION, elapsedMs, maxDurationMs }],
      evidence: {
        action: 'stop',
        reason: 'duration_limit',
        elapsedMs,
        maxDurationMs,
        projectedBytes,
        at: Number(usage.at) || 0,
      },
    });
  }
  if (totalBytes >= maxTotalBytes) {
    return result('stop', BUDGET_CODES.SIZE, {
      stop_reason: 'size',
      exceeded: [{ code: BUDGET_CODES.SIZE, totalBytes, maxTotalBytes }],
      evidence: {
        action: 'stop',
        reason: 'size_limit',
        totalBytes,
        maxTotalBytes,
        projectedBytes,
        at: Number(usage.at) || 0,
      },
    });
  }

  // 3) 单段体积超限：暂停分段（收口当前分片、起新分片），录制继续。
  if (segmentBytes >= maxSegmentBytes) {
    return result('pause-segment', BUDGET_CODES.SEGMENT, {
      exceeded: [{ code: BUDGET_CODES.SEGMENT, segmentBytes, maxSegmentBytes }],
      evidence: {
        action: 'pause-segment',
        reason: 'segment_limit',
        segmentBytes,
        maxSegmentBytes,
        projectedBytes,
        at: Number(usage.at) || 0,
      },
    });
  }

  // 4) 预估将超过整段上限：先降码率（不打断录制）。
  if (projectedBytes >= maxTotalBytes * warnRatio && bitrate > finitePositive(effective.bitrateFloor)) {
    const downgradedBitrate = downgradeBitrate(bitrate, effective);
    if (downgradedBitrate > 0 && downgradedBitrate < bitrate) {
      return result('downgrade-bitrate', BUDGET_CODES.BITRATE, {
        downgradedBitrate,
        warnings: [{ code: BUDGET_CODES.BITRATE, bitrate, downgradedBitrate, projectedBytes, maxTotalBytes }],
        evidence: {
          action: 'downgrade-bitrate',
          reason: 'projected_size_limit',
          bitrate,
          downgradedBitrate,
          projectedBytes,
          maxTotalBytes,
          warnRatio,
          at: Number(usage.at) || 0,
        },
      });
    }
  }

  // 5) 继续，但把接近阈值的情况作为 warnings 报告（便于上层观测）。
  const warnings = [];
  if (maxDurationMs > 0 && elapsedMs >= maxDurationMs * warnRatio) {
    warnings.push({ code: BUDGET_CODES.DURATION, elapsedMs, maxDurationMs, ratio: elapsedMs / maxDurationMs });
  }
  if (totalBytes > 0 && totalBytes >= maxTotalBytes * warnRatio) {
    warnings.push({ code: BUDGET_CODES.SIZE, totalBytes, maxTotalBytes, ratio: totalBytes / maxTotalBytes });
  }
  if (segmentBytes > 0 && segmentBytes >= maxSegmentBytes * warnRatio) {
    warnings.push({ code: BUDGET_CODES.SEGMENT, segmentBytes, maxSegmentBytes, ratio: segmentBytes / maxSegmentBytes });
  }
  return result('continue', null, { warnings });
}

/** 对外的紧凑预算报告（不放整张表，避免响应膨胀）。 */
export function budgetReport(budget = VIDEO_BUDGET_DEFAULTS) {
  const effective = { ...VIDEO_BUDGET_DEFAULTS, ...(budget && typeof budget === 'object' ? budget : {}) };
  return {
    version: VIDEO_BUDGET_VERSION,
    maxDurationMs: finitePositive(effective.maxDurationMs),
    maxTotalBytes: finitePositive(effective.maxTotalBytes),
    maxSegmentBytes: finitePositive(effective.maxSegmentBytes),
    maxConcurrent: finitePositive(effective.maxConcurrent),
    bitrateFloor: finitePositive(effective.bitrateFloor),
    downgradeRatio: Number(effective.downgradeRatio) || VIDEO_BUDGET_DEFAULTS.downgradeRatio,
    warnRatio: Number(effective.warnRatio) || VIDEO_BUDGET_DEFAULTS.warnRatio,
  };
}

/** 供 encoded-writer 在分片落盘时复用：该段是否已到轮换阈值。 */
export function shouldRotateSegment(segmentBytes, budget = VIDEO_BUDGET_DEFAULTS) {
  const limit = finitePositive(budget.maxSegmentBytes) || VIDEO_BUDGET_DEFAULTS.maxSegmentBytes;
  return { rotate: Number(segmentBytes) >= limit, segmentBytes: Math.max(0, Number(segmentBytes) || 0), limit };
}

/** 把 evaluateBudget 的结果压成一行摘要（日志/证据用）。 */
export function summarizeBudgetEvaluation(evaluation) {
  if (!evaluation) return null;
  return {
    action: evaluation.action,
    code: evaluation.code || null,
    stop_reason: evaluation.stop_reason || null,
    projectedBytes: evaluation.projectedBytes || 0,
    ...(evaluation.downgradedBitrate ? { downgradedBitrate: evaluation.downgradedBitrate } : {}),
    exceeded: Array.isArray(evaluation.exceeded) ? evaluation.exceeded.length : 0,
    warnings: Array.isArray(evaluation.warnings) ? evaluation.warnings.length : 0,
  };
}
