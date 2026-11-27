// extension/src/lib/video-degrade.js —— 预算降级计划：把“超限”翻译成可解释、可审计的阶梯动作。
//
// video-budget.evaluateBudget 只回答“当前这一刻该做什么”（continue / downgrade-bitrate /
// pause-segment / stop / reject）。真实运行时还需要回答“为什么、还能撑多久、下一档是什么、
// 已经降过几次”，并且要把这条证据挂到 start/status/fetch 的返回里。本模块负责这部分：
//
//   阶梯（severity 由低到高）：
//     continue
//       └─ downgrade-bitrate     预估整段体积将超上限 → 按 downgradeRatio 逐档降码率（有下限 bitrateFloor）
//       └─ rotate-segment       当前分片接近 maxSegmentBytes → 收口分片、起新分片（不打断录制）
//       └─ cap-duration         依据实测吞吐（bytes/ms）反推剩余体积允许的时长，给出更紧的自动停止点
//       └─ stop                 时长/体积硬上限已到 → 停止（stop_reason='duration'|'size'）
//       └─ reject               并发超限 → 拒绝启动（不停止现有录制）
//
// 每个 step 都是结构化证据：{ level, action, code, reason, detail }；`effective` 给出降级后的
// 有效预算（只收紧、不放松）。所有函数是纯计算，不依赖 chrome/OPFS，可注入 now()。
//
// 运行时消费点：
//   - video.start（video.js startVideo）：启动前算一次 plan，把 `budget_plan` 附在返回值；
//     并发拒绝时把 plan 证据并进 error.evidence（错误码/消息不变）；
//   - video.status（video.js videoStatus）：轮询时按已录时长 + 实测码率重算，附 `budget_degradation`；
//   - video.save（video.js fetchVideo）：体积超限抛错前给出同一套阶梯证据。

import {
  VIDEO_BUDGET_DEFAULTS,
  downgradeBitrate,
  evaluateBudget,
  projectedBytesFor,
} from './video-budget.js';
import { VIDEO_DEGRADE_CODES } from './video-codes.js';

export { VIDEO_DEGRADE_CODES };

export const VIDEO_DEGRADE_VERSION = 1;

/** 阶梯动作（由轻到重）；plan.action 取本次命中的最重动作。 */
export const DEGRADE_ACTIONS = Object.freeze([
  'continue',
  'downgrade-bitrate',
  'rotate-segment',
  'cap-duration',
  'stop',
  'reject',
]);

const ACTION_LEVEL = Object.freeze({
  continue: 0,
  'downgrade-bitrate': 1,
  'rotate-segment': 2,
  'cap-duration': 3,
  stop: 4,
  reject: 5,
});

const DEFAULT_MAX_BITRATE_STEPS = 2;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function ratioOf(value, limit) {
  const numerator = finiteNonNegative(value);
  const denominator = finitePositive(limit);
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function step(action, code, reason, detail = {}) {
  return { level: ACTION_LEVEL[action] || 0, action, code, reason, detail };
}

function compactStep(item) {
  return {
    action: item.action,
    code: item.code,
    reason: item.reason,
    level: item.level,
    ...(item.detail && Object.keys(item.detail).length ? { detail: item.detail } : {}),
  };
}

function effectiveBudgetOf(budget) {
  return { ...VIDEO_BUDGET_DEFAULTS, ...(budget && typeof budget === 'object' ? budget : {}) };
}

/** 各维度剩余量与比例（status/导出报告直接展示，也用于“还能撑多久”）。 */
export function headroomOf(usage = {}, budget = {}) {
  const effective = effectiveBudgetOf(budget);
  const elapsedMs = Math.max(0, Number(usage.elapsedMs) || 0);
  const totalBytes = Math.max(0, Number(usage.totalBytes != null ? usage.totalBytes : usage.bytes) || 0);
  const segmentBytes = Math.max(0, Number(usage.segmentBytes) || 0);
  const maxDurationMs = finitePositive(usage.maxDurationMs) || finitePositive(effective.maxDurationMs);
  const maxTotalBytes = finitePositive(effective.maxTotalBytes) || VIDEO_BUDGET_DEFAULTS.maxTotalBytes;
  const maxSegmentBytes = finitePositive(effective.maxSegmentBytes) || VIDEO_BUDGET_DEFAULTS.maxSegmentBytes;
  return {
    elapsedMs,
    totalBytes,
    segmentBytes,
    maxDurationMs,
    maxTotalBytes,
    maxSegmentBytes,
    durationRatio: ratioOf(elapsedMs, maxDurationMs),
    sizeRatio: ratioOf(totalBytes, maxTotalBytes),
    segmentRatio: ratioOf(segmentBytes, maxSegmentBytes),
    remainingMs: Math.max(0, maxDurationMs - elapsedMs),
    remainingBytes: Math.max(0, maxTotalBytes - totalBytes),
    maxConcurrent: finitePositive(effective.maxConcurrent) || VIDEO_BUDGET_DEFAULTS.maxConcurrent,
    warnRatio: Number(effective.warnRatio) > 0 ? Number(effective.warnRatio) : VIDEO_BUDGET_DEFAULTS.warnRatio,
  };
}

/** 实测吞吐（字节/毫秒）；样本不足返回 0，避免拿 3ms 的数据外推整段。 */
export function estimateThroughput(usage = {}) {
  const elapsedMs = Math.max(0, Number(usage.elapsedMs) || 0);
  const totalBytes = Math.max(0, Number(usage.totalBytes != null ? usage.totalBytes : usage.bytes) || 0);
  const bitrate = finitePositive(usage.bitrate);
  if (elapsedMs >= 500 && totalBytes > 0) {
    return { bytesPerMs: totalBytes / elapsedMs, basis: 'observed', samples: 1, elapsedMs, totalBytes };
  }
  if (bitrate > 0) {
    return { bytesPerMs: bitrate / 8 / 1000, basis: 'bitrate', samples: 0, elapsedMs, totalBytes };
  }
  return { bytesPerMs: 0, basis: 'unknown', samples: 0, elapsedMs, totalBytes };
}

/**
 * 规划一次预算降级。
 * @param {object} usage { activeCount, elapsedMs, totalBytes|bytes, segmentBytes, bitrate, maxDurationMs, projectedBytes, at }
 * @param {object} budget normalizeBudget() 生成的预算
 * @param {{now?:number, maxBitrateSteps?:number, evaluation?:object, minTailMs?:number}} options
 */
export function planBudgetDegradation(usage = {}, budget = {}, options = {}) {
  const effective = effectiveBudgetOf(budget);
  const headroom = headroomOf(usage, effective);
  const throughput = estimateThroughput(usage);
  const evaluation = options.evaluation && typeof options.evaluation === 'object'
    ? options.evaluation
    : evaluateBudget(usage, effective);
  const projected = Math.max(
    finiteNonNegative(usage.projectedBytes),
    finiteNonNegative(evaluation.projectedBytes),
    finiteNonNegative(projectedBytesFor({ totalBytes: headroom.totalBytes, elapsedMs: headroom.elapsedMs, bitrate: finitePositive(usage.bitrate) }, effective)),
  );
  const steps = [];
  const bitrateFloor = finitePositive(effective.bitrateFloor) || VIDEO_BUDGET_DEFAULTS.bitrateFloor;
  const maxBitrateSteps = Math.max(1, Math.min(4, Math.round(Number(options.maxBitrateSteps) || DEFAULT_MAX_BITRATE_STEPS)));
  let targetBitrate = finitePositive(usage.bitrate);
  let projectedAfter = projected;

  // 1) 并发：拒绝启动，不动现有录制。
  if (evaluation.action === 'reject' || finiteNonNegative(usage.activeCount) > headroom.maxConcurrent) {
    steps.push(step('reject', VIDEO_DEGRADE_CODES.CONCURRENCY, 'concurrent_limit', {
      activeCount: finiteNonNegative(usage.activeCount),
      maxConcurrent: headroom.maxConcurrent,
    }));
  }

  // 2) 硬上限：体积/时长已到。
  if (headroom.totalBytes >= headroom.maxTotalBytes) {
    steps.push(step('stop', VIDEO_DEGRADE_CODES.SIZE_STOP, 'size_limit', {
      totalBytes: headroom.totalBytes,
      maxTotalBytes: headroom.maxTotalBytes,
    }));
  }
  if (headroom.maxDurationMs > 0 && headroom.elapsedMs >= headroom.maxDurationMs) {
    steps.push(step('stop', VIDEO_DEGRADE_CODES.DURATION_STOP, 'duration_limit', {
      elapsedMs: headroom.elapsedMs,
      maxDurationMs: headroom.maxDurationMs,
    }));
  }

  // 3) 时长收紧：按实测吞吐反推“剩余字节还能录多久”，比预算上限更紧就收紧自动停止点。
  let cappedDurationMs = headroom.maxDurationMs;
  let capMs = 0;
  if (throughput.bytesPerMs > 0 && headroom.remainingBytes > 0) {
    const byBytesMs = Math.floor(headroom.remainingBytes / throughput.bytesPerMs);
    const minTailMs = Math.max(0, Math.round(Number(options.minTailMs) || 0));
    if (byBytesMs + minTailMs < headroom.remainingMs) {
      capMs = Math.max(0, byBytesMs);
      cappedDurationMs = Math.min(headroom.maxDurationMs, headroom.elapsedMs + capMs);
      steps.push(step('cap-duration', VIDEO_DEGRADE_CODES.DURATION_CAP, 'projected_size_limit', {
        elapsedMs: headroom.elapsedMs,
        maxDurationMs: headroom.maxDurationMs,
        capMs,
        cappedDurationMs,
        basis: throughput.basis,
        bytesPerMs: Math.round(throughput.bytesPerMs * 1000) / 1000,
        remainingBytes: headroom.remainingBytes,
      }));
    }
  }

  // 4) 分片轮换：单段接近上限就收口（不丢帧）。
  if (headroom.segmentBytes >= headroom.maxSegmentBytes * headroom.warnRatio) {
    steps.push(step('rotate-segment', VIDEO_DEGRADE_CODES.SEGMENT_ROTATE, 'segment_limit', {
      segmentBytes: headroom.segmentBytes,
      maxSegmentBytes: headroom.maxSegmentBytes,
      rotateRatio: ratioOf(headroom.segmentBytes, headroom.maxSegmentBytes),
    }));
  }

  // 5) 码率逐档下调：每次按 downgradeRatio 降，最低到 bitrateFloor，最多 maxBitrateSteps 档。
  if (targetBitrate > bitrateFloor) {
    const limit = headroom.maxTotalBytes;
    let current = targetBitrate;
    let currentProjected = projected;
    for (let index = 0; index < maxBitrateSteps; index += 1) {
      if (currentProjected < limit * headroom.warnRatio) break;
      const next = downgradeBitrate(current, effective);
      if (!next || next >= current) break;
      const nextProjected = finiteNonNegative(projectedBytesFor({
        totalBytes: headroom.totalBytes,
        elapsedMs: headroom.elapsedMs,
        bitrate: next,
      }, effective));
      steps.push(step('downgrade-bitrate', VIDEO_DEGRADE_CODES.BITRATE_STEP, 'projected_size_limit', {
        from: Math.round(current),
        to: Math.round(next),
        floor: bitrateFloor,
        step: index + 1,
        projectedBytes: currentProjected,
        projectedAfter: nextProjected,
      }));
      current = next;
      currentProjected = nextProjected;
      if (next <= bitrateFloor) {
        steps.push(step('downgrade-bitrate', VIDEO_DEGRADE_CODES.BITRATE_FLOOR, 'bitrate_floor', {
          from: Math.round(current),
          floor: bitrateFloor,
          step: index + 1,
        }));
        break;
      }
    }
    targetBitrate = current;
    projectedAfter = currentProjected;
  }

  // 6) 计算本次最重动作与有效预算（只收紧）。
  let action = 'continue';
  for (const item of steps) {
    if (ACTION_LEVEL[item.action] > ACTION_LEVEL[action]) action = item.action;
  }
  const stopStep = steps.find((item) => item.action === 'stop') || null;
  const stopReason = stopStep ? (stopStep.reason === 'size_limit' ? 'size' : 'duration') : null;
  const effectivePlan = {
    maxDurationMs: cappedDurationMs,
    maxTotalBytes: headroom.maxTotalBytes,
    maxSegmentBytes: headroom.maxSegmentBytes,
    maxConcurrent: headroom.maxConcurrent,
    rotateAtBytes: headroom.maxSegmentBytes,
    bitrate: targetBitrate,
    bitrateFloor,
  };
  const ok = action !== 'reject' && action !== 'stop';
  const plan = {
    version: VIDEO_DEGRADE_VERSION,
    ok,
    action,
    level: ACTION_LEVEL[action],
    action_chain: steps.map((item) => item.action),
    stop_reason: stopReason,
    steps: steps.map(compactStep),
    effective: effectivePlan,
    evaluation: {
      action: evaluation.action,
      code: evaluation.code || null,
      stop_reason: evaluation.stop_reason || null,
      exceeded: Array.isArray(evaluation.exceeded) ? evaluation.exceeded : [],
      warnings: Array.isArray(evaluation.warnings) ? evaluation.warnings : [],
    },
    profile: {
      action,
      level: ACTION_LEVEL[action],
      steps: steps.length,
      ...(stopReason ? { stop_reason: stopReason } : {}),
      ...(targetBitrate && targetBitrate !== finitePositive(usage.bitrate) ? { bitrate: Math.round(targetBitrate) } : {}),
      ...(capMs > 0 ? { cap_ms: capMs } : {}),
    },
    headroom,
    projectedBytes: projected,
    projectedAfterBytes: projectedAfter,
    throughput: { bytesPerMs: Math.round(throughput.bytesPerMs * 1000) / 1000, basis: throughput.basis },
    at: finiteNonNegative(options.now != null ? options.now : usage.at) || 0,
    evidence: {
      action,
      level: ACTION_LEVEL[action],
      reason: steps.length ? steps[steps.length - 1].reason : 'within_budget',
      steps: steps.map(compactStep),
      usage: {
        activeCount: finiteNonNegative(usage.activeCount),
        elapsedMs: headroom.elapsedMs,
        totalBytes: headroom.totalBytes,
        segmentBytes: headroom.segmentBytes,
        bitrate: finitePositive(usage.bitrate),
      },
      budget: {
        maxDurationMs: headroom.maxDurationMs,
        maxTotalBytes: headroom.maxTotalBytes,
        maxSegmentBytes: headroom.maxSegmentBytes,
        maxConcurrent: headroom.maxConcurrent,
        warnRatio: headroom.warnRatio,
        bitrateFloor,
      },
      projectedBytes: projected,
      projectedAfterBytes: projectedAfter,
      headroom,
      at: finiteNonNegative(options.now != null ? options.now : usage.at) || 0,
    },
  };
  return plan;
}

/**
 * 把降级计划应用到预算（只收紧、不放松，保证多次轮询不会把预算越改越大）。
 * 返回新预算对象 + 变更清单，便于把“预算被降过”写进证据。
 */
export function applyDegradation(budget = {}, plan = null) {
  const current = effectiveBudgetOf(budget);
  const next = { ...current };
  const changes = [];
  if (plan && plan.effective) {
    const capped = finitePositive(plan.effective.maxDurationMs);
    const minDuration = finitePositive(current.minDurationMs) || VIDEO_BUDGET_DEFAULTS.minDurationMs;
    if (capped > 0 && capped < current.maxDurationMs && capped >= minDuration) {
      changes.push({ field: 'maxDurationMs', from: Math.round(current.maxDurationMs), to: Math.round(capped) });
      next.maxDurationMs = Math.round(capped);
    }
    const bitrate = finitePositive(plan.effective.bitrate);
    if (bitrate > 0) {
      next.targetBitrate = Math.round(bitrate);
      if (bitrate < finitePositive(current.targetBitrate || 0) || !current.targetBitrate) {
        if (finitePositive(current.targetBitrate)) changes.push({ field: 'targetBitrate', from: Math.round(current.targetBitrate), to: Math.round(bitrate) });
      }
    }
  }
  return {
    ok: true,
    budget: next,
    changes,
    unchanged: changes.length === 0,
    evidence: { code: VIDEO_DEGRADE_CODES.APPLIED, changes, steps: plan && Array.isArray(plan.steps) ? plan.steps.length : 0 },
  };
}

function summarizeStepForHistory(item) {
  return {
    action: item.action,
    code: item.code,
    reason: item.reason,
    ...(item.detail && item.detail.to != null ? { to: item.detail.to } : {}),
    ...(item.detail && item.detail.capMs != null ? { cap_ms: item.detail.capMs } : {}),
  };
}

/**
 * 轮询路径的降级历史：同一动作+原因只保留最新一条，最多 keep 条（默认 8），
 * 让 video.status 的返回能看出“降过几次/为什么降”，又不随轮询无限膨胀。
 */
export function mergeDegradationHistory(history, plan, options = {}) {
  const keep = Math.max(1, Math.min(32, Math.round(Number(options.keep) || 8)));
  const previous = Array.isArray(history) ? history.filter((item) => item && typeof item === 'object') : [];
  const next = previous.slice(-keep);
  let added = 0;
  let deduped = 0;
  if (plan && Array.isArray(plan.steps)) {
    for (const item of plan.steps) {
      const entry = summarizeStepForHistory(item);
      if (entry.action === 'continue') continue;
      const existing = next.findIndex((candidate) => candidate.action === entry.action && candidate.code === entry.code);
      if (existing >= 0) {
        next[existing] = entry;
        deduped += 1;
        continue;
      }
      next.push(entry);
      added += 1;
    }
  }
  while (next.length > keep) next.shift();
  return { ok: true, history: next, added, deduped, total: next.length };
}

/** 记录补丁字段：只有真的发生降级时才写（避免给正常录制塞无意义字段）。 */
export function degradationRecordFields(plan) {
  if (!plan || plan.action === 'continue') return {};
  return {
    budget_degradation: {
      action: plan.action,
      level: plan.level,
      steps: Array.isArray(plan.steps) ? plan.steps.length : 0,
      chains: Array.isArray(plan.action_chain) ? plan.action_chain.slice(0, 8) : [],
      ...(plan.stop_reason ? { stop_reason: plan.stop_reason } : {}),
      ...(plan.profile && plan.profile.cap_ms ? { cap_ms: plan.profile.cap_ms } : {}),
      ...(plan.profile && plan.profile.bitrate ? { bitrate: plan.profile.bitrate } : {}),
      headroom: plan.headroom,
    },
    budget_plan: summarizeDegradation(plan),
  };
}

/** 对外紧凑摘要（start/status/fetch 返回附加字段用）。 */
export function summarizeDegradation(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const headroom = plan.headroom && typeof plan.headroom === 'object' ? plan.headroom : {};
  return {
    ok: plan.ok === true,
    action: String(plan.action || 'continue'),
    level: Number(plan.level) || 0,
    stop_reason: plan.stop_reason || null,
    steps: steps.length,
    actions: [...new Set(steps.map((item) => item.action))],
    projectedBytes: finiteNonNegative(plan.projectedBytes),
    ...(finiteNonNegative(plan.projectedAfterBytes) !== finiteNonNegative(plan.projectedBytes)
      ? { projectedAfterBytes: finiteNonNegative(plan.projectedAfterBytes) }
      : {}),
    ...(plan.effective && finiteNonNegative(plan.effective.maxDurationMs) !== finiteNonNegative(headroom.maxDurationMs)
      ? { cap_ms: Math.max(0, finiteNonNegative(plan.effective.maxDurationMs) - finiteNonNegative(headroom.elapsedMs)) }
      : {}),
    ...(plan.effective && finitePositive(plan.effective.bitrate) > 0 ? { bitrate: Math.round(finitePositive(plan.effective.bitrate)) } : {}),
    headroom: {
      duration: Number(headroom.durationRatio) || 0,
      size: Number(headroom.sizeRatio) || 0,
      segment: Number(headroom.segmentRatio) || 0,
    },
  };
}

/** 人读解释（日志/`bridge video status` 文本增强时用；不参与 wire 契约）。 */
export function explainDegradation(plan) {
  if (!plan || typeof plan !== 'object') return [];
  const headroom = plan.headroom || {};
  const percent = (ratio) => Math.round((Number(ratio) || 0) * 100) + '%';
  const lines = [
    '预算：时长 ' + percent(headroom.durationRatio) + '，体积 ' + percent(headroom.sizeRatio) + '，分片 ' + percent(headroom.segmentRatio),
  ];
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) {
    lines.push('动作：continue（未触发降级）');
    return lines;
  }
  for (const item of steps) {
    const detail = item.detail || {};
    if (item.action === 'downgrade-bitrate') {
      lines.push('降码率：' + detail.from + ' → ' + detail.to + '（第 ' + detail.step + ' 档，下限 ' + detail.floor + '）');
    } else if (item.action === 'rotate-segment') {
      lines.push('轮换分片：当前 ' + detail.segmentBytes + ' / 上限 ' + detail.maxSegmentBytes);
    } else if (item.action === 'cap-duration') {
      lines.push('收紧时长：按实测吞吐还能录 ' + Math.round(detail.capMs / 1000) + 's（' + detail.basis + '）');
    } else if (item.action === 'stop') {
      lines.push('停止录制：' + item.reason);
    } else if (item.action === 'reject') {
      lines.push('拒绝启动：并发 ' + detail.activeCount + ' / ' + detail.maxConcurrent);
    }
  }
  return lines;
}

/** 把当前预算序列化成日志一行（调试用，避免打印整张表）。 */
export function budgetLogLine(budget = {}) {
  const effective = effectiveBudgetOf(budget);
  return 'budget[dur=' + effective.maxDurationMs + 'ms,total=' + effective.maxTotalBytes + 'B,seg=' + effective.maxSegmentBytes + 'B,conc=' + effective.maxConcurrent + ']';
}
