// lib/longshot-repaint.js —— 长截图帧级重绘计划（纯函数；消费 longshot-frame-reconcile 的对账结论）。
//
// 对账（lib/longshot-frame-reconcile.js）只回答“哪一帧丢了/错位/缺固定带”，本模块回答
// “怎么补、按什么顺序补、补几轮、超预算怎么办”：
//   * 重绘目标排序：error 优先（缺帧/接缝/尾部）→ warn（错位/固定带）→ info；
//   * 分批：同一批最多 N 帧（避免一次重拍整页），并按页面坐标升序（从上往下补，减少滚动抖动）；
//   * 预算：像素/字节/时间上限，超限时只补高优先级批次，剩余标 deferred（可下一轮继续）；
//   * 重试：每帧最多 attempts 次；重绘后仍失败 → 标记 unresolved，交由调用方决定是否整页重拍；
//   * 结果合并：repaint results → applied/failed/unresolved 三组，供 manifest/状态机写证据。
//
// 约束：纯计算，不触发实际截图；运行时（longshot-recover / longshot-render）调用本模块拿计划，
// 执行仍走既有 CDP/Canvas 路径。默认（无对账结论）返回 action:'skip'，不改变既有行为。

import { frameSignatureDigest } from './capture-frame-ledger.js';

export const LONGSHOT_REPAINT_VERSION = 1;

/** 重绘动作（只加不改）。 */
export const REPAINT_ACTIONS = Object.freeze(['skip', 'repaint', 'repaint-partial', 'defer', 'abort']);

/** 重绘原因（与 longshot-frame-reconcile 的 repairs.reason 对齐，允许自由字符串）。 */
export const REPAINT_REASONS = Object.freeze([
  'missing',
  'hash-mismatch',
  'misaligned',
  'band:top',
  'band:bottom',
  'seam-gap',
  'tail-uncovered',
  'stale',
  'unknown',
]);

export const REPAINT_CODES = Object.freeze({
  NONE: 'longshot.repaint.none',
  PLANNED: 'longshot.repaint.planned',
  BUDGET: 'longshot.repaint.budget',
  DEFERRED: 'longshot.repaint.deferred',
  ABORT: 'longshot.repaint.abort',
  RETRY_LIMIT: 'longshot.repaint.retry-limit',
  UNRESOLVED: 'longshot.repaint.unresolved',
  APPLIED: 'longshot.repaint.applied',
  FAILED: 'longshot.repaint.failed',
});

export const REPAINT_DEFAULTS = Object.freeze({
  // 一次重绘最多补几帧（每帧一次 CDP capture + 一次 canvas 绘制）。
  maxFramesPerPass: 4,
  // 最多几轮（本轮 target 补完还失败的不再无限重试）。
  maxPasses: 3,
  // 每帧最多尝试次数。
  attemptsPerFrame: 2,
  // 预算：总像素 / 总字节 / 墙钟毫秒（0 表示不限制）。
  maxPixels: 64 * 1024 * 1024,
  maxBytes: 96 * 1024 * 1024,
  maxDurationMs: 0,
  // 单帧绘制成本估算（像素 → 毫秒的经验系数，仅用于预算估计，不用于真实计时）。
  costPerMegapixelMs: 18,
  // 单帧 PNG 体积估算（每像素字节，仅预算用）。
  bytesPerPixel: 0.35,
});

const SEVERITY_RANK = Object.freeze({ fatal: 3, error: 2, warn: 1, info: 0, none: -1 });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function clampInt(value, min, max, fallback) {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeReason(reason) {
  const text = String(reason == null ? '' : reason).trim();
  if (!text) return 'unknown';
  if (text.startsWith('misaligned:')) return 'misaligned';
  return REPAINT_REASONS.includes(text) ? text : text.slice(0, 48);
}

function severityRank(value) {
  return SEVERITY_RANK[String(value || 'info')] != null ? SEVERITY_RANK[String(value || 'info')] : 1;
}

/** 单个重绘目标归一化：非法目标返回 null（不抛）；缺 pageY/pageHeight 用 0/1 兜底。 */
export function normalizeRepairTarget(target, position = 0) {
  if (!isPlainObject(target)) return null;
  const index = intOr(target.index, -1);
  if (index < 0) return null;
  const reasons = Array.isArray(target.reasons) && target.reasons.length
    ? target.reasons.map(normalizeReason)
    : [normalizeReason(target.reason)];
  const pageY = Math.max(0, intOr(target.pageY, 0));
  const pageHeight = Math.max(1, intOr(target.pageHeight, 1));
  const severity = ['fatal', 'error', 'warn', 'info'].includes(target.severity) ? target.severity : 'warn';
  return {
    index,
    frameId: typeof target.frameId === 'string' && target.frameId ? target.frameId : 'longshot-segment#' + index,
    reason: reasons[0],
    reasons: [...new Set(reasons)],
    severity,
    pageY,
    pageHeight,
    position: intOr(target.position, position),
    attempts: 0,
    state: 'pending',
  };
}

/**
 * 目标优先级：先按 severity（error 高于 warn），同 severity 内“缺帧/接缝/尾部”高于“错位”，
 * 最后按页面坐标升序（从上往下补，减少滚动抖动）。
 */
export function repairPriority(target, options = {}) {
  const normalized = normalizeRepairTarget(target);
  if (!normalized) return -1;
  const reasonWeight = (reason) => {
    if (reason === 'missing' || reason === 'seam-gap' || reason === 'tail-uncovered') return 30;
    if (reason === 'hash-mismatch') return 25;
    if (reason.startsWith('band:')) return 20;
    if (reason === 'stale') return 15;
    if (reason === 'misaligned') return 10;
    return 5;
  };
  const topReason = Math.max(...normalized.reasons.map(reasonWeight));
  const severity = severityRank(normalized.severity) * 100;
  // 页面越靠上越先补（-pageY/1e6 很小，只在同 severity+reason 内排序生效）。
  const order = -normalized.pageY / 1e6;
  const boost = Number(options.boost) || 0;
  return severity + topReason + order + boost;
}

/** 成本估算：像素 = 帧面积 × dpr²；时间/字节用可配置经验系数（只用于预算，不是实测）。 */
export function estimateRepaintCost(targets, options = {}) {
  const list = (Array.isArray(targets) ? targets : []).map((target, position) => normalizeRepairTarget(target, position)).filter(Boolean);
  const dpr = Math.max(0.1, finiteOr(options.dpr, 1));
  const width = Math.max(1, intOr(options.width, 0));
  const scale = width > 0 ? width : 1;
  const bytesPerPixel = Math.max(0, finiteOr(options.bytesPerPixel, REPAINT_DEFAULTS.bytesPerPixel));
  const costPerMegapixelMs = Math.max(0, finiteOr(options.costPerMegapixelMs, REPAINT_DEFAULTS.costPerMegapixelMs));
  let pixels = 0;
  const perTarget = [];
  for (const target of list) {
    const w = Math.max(1, intOr(target.width, scale));
    const framePixels = Math.round(w * target.pageHeight * dpr * dpr);
    pixels += framePixels;
    perTarget.push({
      index: target.index,
      pageY: target.pageY,
      pageHeight: target.pageHeight,
      pixels: framePixels,
      estimateBytes: Math.round(framePixels * bytesPerPixel),
      estimateMs: Math.round((framePixels / (1024 * 1024)) * costPerMegapixelMs),
    });
  }
  return {
    frames: list.length,
    pixels,
    estimateBytes: Math.round(pixels * bytesPerPixel),
    estimateMs: Math.round((pixels / (1024 * 1024)) * costPerMegapixelMs),
    perTarget,
  };
}

function budgetOf(input) {
  const source = isPlainObject(input) ? input : {};
  return {
    maxFramesPerPass: clampInt(source.maxFramesPerPass, 1, 64, REPAINT_DEFAULTS.maxFramesPerPass),
    maxPasses: clampInt(source.maxPasses, 1, 16, REPAINT_DEFAULTS.maxPasses),
    attemptsPerFrame: clampInt(source.attemptsPerFrame, 1, 8, REPAINT_DEFAULTS.attemptsPerFrame),
    maxPixels: Math.max(0, finiteOr(source.maxPixels, REPAINT_DEFAULTS.maxPixels)),
    maxBytes: Math.max(0, finiteOr(source.maxBytes, REPAINT_DEFAULTS.maxBytes)),
    maxDurationMs: Math.max(0, finiteOr(source.maxDurationMs, REPAINT_DEFAULTS.maxDurationMs)),
    costPerMegapixelMs: Math.max(0, finiteOr(source.costPerMegapixelMs, REPAINT_DEFAULTS.costPerMegapixelMs)),
    bytesPerPixel: Math.max(0, finiteOr(source.bytesPerPixel, REPAINT_DEFAULTS.bytesPerPixel)),
  };
}

function extractTargets(input) {
  if (Array.isArray(input)) return input;
  if (!isPlainObject(input)) return [];
  if (Array.isArray(input.repairs)) return input.repairs;
  if (Array.isArray(input.targets)) return input.targets;
  return [];
}

/**
 * 规划一次帧级重绘。
 *
 * @param {object|object[]} input 对账报告（含 repairs）或 repairs 数组
 * @param {{
 *   dpr?: number, width?: number,
 *   maxFramesPerPass?: number, maxPasses?: number, attemptsPerFrame?: number,
 *   maxPixels?: number, maxBytes?: number, maxDurationMs?: number,
 *   now?: number, force?: boolean,
 * }} [options]
 * @returns {object} plan（action/batches/deferred/budget/evidence/text 由 describeRepaint 生成）
 */
export function planLongshotRepaint(input, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : 0;
  const budget = budgetOf(options);
  const targets = extractTargets(input)
    .map((target, position) => normalizeRepairTarget(target, position))
    .filter(Boolean)
    .map((target) => ({ ...target, priority: repairPriority(target) }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index);

  const cost = estimateRepaintCost(targets, {
    dpr: options.dpr,
    width: options.width,
    bytesPerPixel: budget.bytesPerPixel,
    costPerMegapixelMs: budget.costPerMegapixelMs,
  });
  const selected = [];
  const deferred = [];
  let pixels = 0;
  let bytes = 0;
  let ms = 0;
  for (const target of targets) {
    const perFrame = cost.perTarget.find((item) => item.index === target.index) || { pixels: 0, estimateBytes: 0, estimateMs: 0 };
    const nextPixels = pixels + perFrame.pixels;
    const nextBytes = bytes + perFrame.estimateBytes;
    const nextMs = ms + perFrame.estimateMs;
    const exceedsPixels = budget.maxPixels > 0 && nextPixels > budget.maxPixels;
    const exceedsBytes = budget.maxBytes > 0 && nextBytes > budget.maxBytes;
    const exceedsTime = budget.maxDurationMs > 0 && nextMs > budget.maxDurationMs;
    if (!options.force && (exceedsPixels || exceedsBytes || exceedsTime)) {
      deferred.push({
        ...target,
        state: 'deferred',
        deferredReason: exceedsPixels ? 'pixels' : (exceedsBytes ? 'bytes' : 'duration'),
      });
      continue;
    }
    pixels = nextPixels;
    bytes = nextBytes;
    ms = nextMs;
    selected.push({
      ...target,
      state: 'pending',
      estimate: { pixels: perFrame.pixels, bytes: perFrame.estimateBytes, ms: perFrame.estimateMs },
    });
  }

  // 分批：每批最多 maxFramesPerPass 帧；批内按页面坐标升序（从上往下补）。
  const batches = [];
  for (let offset = 0; offset < selected.length; offset += budget.maxFramesPerPass) {
    const batch = selected.slice(offset, offset + budget.maxFramesPerPass)
      .sort((left, right) => left.pageY - right.pageY)
      .map((target) => ({ ...target, state: 'scheduled' }));
    batches.push({
      pass: batches.length + 1,
      frames: batch.map((target) => target.index),
      pageRange: [batch[0] ? batch[0].pageY : 0, batch.length ? batch[batch.length - 1].pageY + batch[batch.length - 1].pageHeight : 0],
      targets: batch,
      pixels: batch.reduce((sum, target) => sum + (target.estimate ? target.estimate.pixels : 0), 0),
    });
  }

  const issues = [];
  if (!targets.length) issues.push(REPAINT_CODES.NONE);
  if (selected.length) issues.push(REPAINT_CODES.PLANNED);
  if (deferred.length) issues.push(REPAINT_CODES.DEFERRED);
  const action = !targets.length
    ? 'skip'
    : (deferred.length > 0 ? 'repaint-partial' : 'repaint');
  const digest = frameSignatureDigest({
    kind: 'longshot-segment',
    index: selected.length ? selected[0].index : 0,
    pageY: selected.length ? selected[0].pageY : 0,
    pageHeight: selected.reduce((sum, target) => sum + target.pageHeight, 0),
    width: Math.max(1, intOr(options.width, 1)),
    drawHeight: selected.reduce((sum, target) => sum + target.pageHeight, 0),
    dpr: Math.round(Math.max(0.1, finiteOr(options.dpr, 1)) * 1000) / 1000,
    role: 'repaint',
  });
  return {
    version: LONGSHOT_REPAINT_VERSION,
    action,
    ok: targets.length === 0 || selected.length > 0,
    now,
    budget,
    targets: selected,
    deferred,
    batches,
    counts: {
      requested: targets.length,
      scheduled: selected.length,
      deferred: deferred.length,
      batches: batches.length,
    },
    cost: { pixels, bytes, ms },
    estimate: cost,
    issues,
    digest,
    evidence: {
      now,
      action,
      requested: targets.length,
      scheduled: selected.length,
      deferred: deferred.length,
      batches: batches.length,
      pixels,
      bytes,
      ms,
      budget,
    },
  };
}

/**
 * 合并一次重绘执行结果：results 形如 [{index, ok, hash?, bytes?, error?}]。
 * 返回 applied / failed / unresolved / attempts（每帧次数）+ 剩余可重试目标。
 */
export function mergeRepaintResults(plan, results, options = {}) {
  const source = isPlainObject(plan) ? plan : null;
  const scheduled = [];
  if (source) {
    for (const batch of Array.isArray(source.batches) ? source.batches : []) {
      for (const target of Array.isArray(batch.targets) ? batch.targets : []) {
        scheduled.push({ ...target, state: target.state || 'scheduled' });
      }
    }
  }
  const attemptsPerFrame = clampInt(options.attemptsPerFrame, 1, 8, (source && source.budget && source.budget.attemptsPerFrame) || REPAINT_DEFAULTS.attemptsPerFrame);
  const resultByIndex = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    if (!isPlainObject(result)) continue;
    const index = intOr(result.index, -1);
    if (index >= 0) resultByIndex.set(index, result);
  }
  const applied = [];
  const failed = [];
  const unresolved = [];
  const attempts = {};
  for (const target of scheduled) {
    const attemptsSoFar = intOr(attempts[target.index], 0) + 1;
    attempts[target.index] = attemptsSoFar;
    const result = resultByIndex.get(target.index);
    if (result && result.ok === true) {
      applied.push({
        index: target.index,
        frameId: target.frameId,
        hash: typeof result.hash === 'string' ? result.hash : '',
        bytes: Math.max(0, intOr(result.bytes, 0)),
      });
      continue;
    }
    const record = {
      index: target.index,
      frameId: target.frameId,
      reason: target.reason,
      attempts: attemptsSoFar,
      error: result ? String(result.error || result.reason || 'repaint-failed') : 'no-result',
      retry: attemptsSoFar < attemptsPerFrame,
    };
    if (record.retry) failed.push(record);
    else unresolved.push({ ...record, code: REPAINT_CODES.RETRY_LIMIT });
  }
  const remaining = (Array.isArray(source && source.deferred) ? source.deferred : []).map((target) => ({
    index: target.index,
    frameId: target.frameId,
    reason: target.reason,
    deferredReason: target.deferredReason || 'budget',
  }));
  const ok = unresolved.length === 0 && failed.length === 0;
  return {
    version: LONGSHOT_REPAINT_VERSION,
    ok,
    applied,
    failed,
    unresolved,
    attempts,
    deferred: remaining,
    counts: {
      scheduled: scheduled.length,
      applied: applied.length,
      failed: failed.length,
      unresolved: unresolved.length,
      deferred: remaining.length,
    },
    issues: [
      ...(applied.length ? [REPAINT_CODES.APPLIED] : []),
      ...(failed.length ? [REPAINT_CODES.FAILED] : []),
      ...(unresolved.length ? [REPAINT_CODES.UNRESOLVED] : []),
      ...(remaining.length ? [REPAINT_CODES.DEFERRED] : []),
    ],
    nextPass: !ok && (failed.length > 0 || remaining.length > 0),
    evidence: {
      scheduled: scheduled.length,
      applied: applied.length,
      failed: failed.length,
      unresolved: unresolved.length,
      deferred: remaining.length,
    },
  };
}

/** 是否该放弃重绘（轮次/撤稿阈值）：调用方在每轮开始前调用。 */
export function shouldAbortRepaint(attempt, plan, options = {}) {
  const maxPasses = clampInt(options.maxPasses, 1, 16, (plan && plan.budget && plan.budget.maxPasses) || REPAINT_DEFAULTS.maxPasses);
  const pass = Math.max(0, intOr(attempt, 0));
  if (pass >= maxPasses) {
    return {
      abort: true,
      reason: 'max-passes',
      code: REPAINT_CODES.ABORT,
      attempt: pass,
      maxPasses,
      detail: '重绘轮次超过上限，剩余帧交给整页重拍',
    };
  }
  const counts = plan && plan.counts ? plan.counts : {};
  if ((counts.scheduled || 0) === 0 && (counts.deferred || 0) === 0) {
    return { abort: true, reason: 'nothing-to-repaint', code: REPAINT_CODES.NONE, attempt: pass, maxPasses, detail: '没有需要重绘的帧' };
  }
  return { abort: false, reason: null, code: null, attempt: pass, maxPasses, detail: '继续重绘' };
}

/** 重绘计划 → 协议字段（不携带 targets 全量，避免响应膨胀）。 */
export function repaintWire(plan, options = {}) {
  if (!isPlainObject(plan)) {
    return { version: LONGSHOT_REPAINT_VERSION, action: 'skip', counts: {}, batches: [] };
  }
  const limit = clampInt(options.maxListed, 0, 32, 8);
  return {
    version: LONGSHOT_REPAINT_VERSION,
    action: String(plan.action || 'skip'),
    ok: plan.ok === true,
    counts: { ...(plan.counts || {}) },
    cost: plan.cost ? { pixels: plan.cost.pixels, bytes: plan.cost.bytes, ms: plan.cost.ms } : null,
    batches: (Array.isArray(plan.batches) ? plan.batches : []).slice(0, limit).map((batch) => ({
      pass: batch.pass,
      frames: (batch.frames || []).slice(0, limit),
      pageRange: batch.pageRange,
    })),
    deferred: (Array.isArray(plan.deferred) ? plan.deferred : []).slice(0, limit).map((target) => ({
      index: target.index,
      reason: target.reason,
      deferredReason: target.deferredReason,
    })),
    issues: Array.isArray(plan.issues) ? plan.issues.slice(0, 8) : [],
    digest: plan.digest || null,
    text: describeRepaint(plan),
  };
}

/** 一行日志：'重绘计划 repaint：3 帧分 1 批（2280px 区段）'。 */
export function describeRepaint(plan) {
  if (!isPlainObject(plan)) return '重绘计划 无';
  const counts = plan.counts || {};
  if (plan.action === 'skip') return '重绘计划 skip：没有需要重绘的帧';
  const batches = Array.isArray(plan.batches) ? plan.batches.length : 0;
  const deferred = counts.deferred || 0;
  return '重绘计划 ' + String(plan.action) + '：' + (counts.scheduled || 0) + ' 帧分 ' + batches + ' 批' +
    (deferred ? '，' + deferred + ' 帧延后（预算）' : '') +
    (plan.cost ? '，约 ' + Math.round((plan.cost.pixels || 0) / 1024) + 'K 像素' : '');
}

/** 从计划里取前 N 批（执行侧按批拉取；不修改计划）。 */
export function selectRepaintBatches(plan, options = {}) {
  const limit = clampInt(options.maxBatches, 0, 32, 1);
  const batches = isPlainObject(plan) && Array.isArray(plan.batches) ? plan.batches : [];
  return {
    total: batches.length,
    returned: Math.min(limit, batches.length),
    truncated: batches.length > limit,
    batches: batches.slice(0, limit).map((batch) => ({
      pass: batch.pass,
      frames: Array.isArray(batch.frames) ? batch.frames.slice() : [],
      targets: Array.isArray(batch.targets) ? batch.targets.map((target) => ({ ...target })) : [],
      pageRange: batch.pageRange,
      pixels: batch.pixels || 0,
    })),
  };
}

/** 重绘进度：合并执行结果后算剩余帧/百分比，供状态机写证据。 */
export function repaintProgress(plan, merged) {
  const counts = isPlainObject(plan) && plan.counts ? plan.counts : (isPlainObject(merged) && merged.counts ? merged.counts : {});
  const scheduled = Math.max(0, intOr(counts.scheduled, 0));
  const appliedCount = isPlainObject(merged) && Array.isArray(merged.applied) ? merged.applied.length : 0;
  const unresolvedCount = isPlainObject(merged) && Array.isArray(merged.unresolved) ? merged.unresolved.length : 0;
  const deferred = Math.max(0, intOr(counts.deferred, 0));
  const remaining = Math.max(0, scheduled - appliedCount - unresolvedCount) + deferred;
  const total = scheduled + deferred;
  return {
    version: LONGSHOT_REPAINT_VERSION,
    scheduled,
    applied: appliedCount,
    unresolved: unresolvedCount,
    deferred,
    remaining,
    total,
    percent: total > 0 ? Number(((appliedCount / total) * 100).toFixed(1)) : 100,
    done: remaining === 0,
    text: '重绘进度 ' + appliedCount + '/' + total + (remaining ? '（剩 ' + remaining + '）' : '（完成）'),
  };
}

/** 批次一行日志：'第 2 批 3 帧 y=100..400'。 */
export function describeRepaintBatch(batch) {
  if (!isPlainObject(batch)) return '重绘批次 无';
  const frames = Array.isArray(batch.frames) ? batch.frames.length : 0;
  const pageRange = Array.isArray(batch.pageRange) ? batch.pageRange : [0, 0];
  return '第 ' + intOr(batch.pass, 0) + ' 批 ' + frames + ' 帧 y=' + intOr(pageRange[0], 0) + '..' + intOr(pageRange[1], 0);
}

/** 合并多份重绘计划（例如“帧对账修复 + 恢复侧补拍”）：按 index 去重、保留更高 severity。 */
export function mergeRepaintPlans(plans, options = {}) {
  const list = Array.isArray(plans) ? plans.filter((plan) => isPlainObject(plan)) : [];
  const byIndex = new Map();
  for (const plan of list) {
    for (const batch of Array.isArray(plan.batches) ? plan.batches : []) {
      for (const target of Array.isArray(batch.targets) ? batch.targets : []) {
        const normalized = normalizeRepairTarget(target, byIndex.size);
        if (!normalized) continue;
        const previous = byIndex.get(normalized.index);
        if (!previous) {
          byIndex.set(normalized.index, normalized);
          continue;
        }
        if (severityRank(normalized.severity) > severityRank(previous.severity)) {
          byIndex.set(normalized.index, normalized);
          continue;
        }
        previous.reasons = [...new Set([...(previous.reasons || []), ...(normalized.reasons || [])])];
      }
    }
    for (const target of Array.isArray(plan.deferred) ? plan.deferred : []) {
      const normalized = normalizeRepairTarget(target, byIndex.size);
      if (normalized && !byIndex.has(normalized.index)) {
        byIndex.set(normalized.index, { ...normalized, state: 'deferred', deferredReason: target.deferredReason || 'budget' });
      }
    }
  }
  const targets = [...byIndex.values()];
  return planLongshotRepaint({ repairs: targets }, options);
}
