// lib/video-mux-budget.js —— 视频封装（mux/fMP4 分片）预算与对齐（纯函数；第十一批-E）。
//
// 背景：录制产物最终要封装成可播放文件（MP4/WebM）。0.3.0 的封装只做“把分片拼起来”，
// 没有回答：
//   * 分片时长/keyframe 间隔怎么定，才能在崩溃时“最多丢一个分片”；
//   * 每片容器开销（moof/mdat/mfra 头）累计多少，是否超封装预算；
//   * 总时长与声明时长不一致时，是“补尾部空片”还是“重封”；
//   * 封装预算（最大分片数/最大开销/最大字节）超限时，应该缩分片还是降分片数。
//
// 本模块把封装规划收敛成纯函数（与 fmp4-sidx/mp4-fragments 的字节层实现互补）：
//   planVideoMux()          —— 时长/fps/目标分片 → 分片数、关键帧对齐、容器开销、预算结论；
//   alignKeyframeInterval() —— 把关键帧间隔对齐到分片边界（避免“分片跨关键帧”导致恢复困难）；
//   estimateMuxOverhead()   —— 每片固定开销 × 分片数（+ 索引开销）；
//   muxBudgetWire()/describeMux() —— 协议字段与一行日志。
//
// 约束：纯计算，不写字节；真实封装仍走 lib/mp4-fragments.js / lib/fmp4-sidx.js。

export const MUX_BUDGET_VERSION = 1;

export const MUX_ACTIONS = Object.freeze(['ok', 'shrink-fragments', 'reduce-fragments', 'reject']);

export const MUX_CODES = Object.freeze({
  OK: 'video.mux.ok',
  OVERHEAD: 'video.mux.overhead',
  ALIGN: 'video.mux.align',
  SHRINK: 'video.mux.shrink',
  REJECT: 'video.mux.reject',
  DURATION: 'video.mux.duration',
});

export const MUX_DEFAULTS = Object.freeze({
  // 目标分片时长：2 秒（崩溃最多丢 2s，且 fMP4 头开销可接受）。
  fragmentMs: 2000,
  // 关键帧间隔默认与分片对齐（1 个分片至少 1 个关键帧）。
  keyframeMs: 2000,
  maxFragmentMs: 10000,
  minFragmentMs: 250,
  // 每片容器固定开销估算（moof + mdat 头 + 索引条目）：约 900B。
  fragmentOverheadBytes: 900,
  // fMP4 顶级索引开销：约 1.5KB。
  indexOverheadBytes: 1536,
  // 预算：最多分片数、最大总开销、最大封装字节（0 表示不限）。
  maxFragments: 600,
  maxOverheadBytes: 2 * 1024 * 1024,
  maxTotalBytes: 0,
  // 时长容差：声明时长与分片时间轴差超过该值就补尾部空片。
  durationToleranceMs: 500,
  container: 'mp4',
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

function normalizeContainer(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (text === 'webm') return 'webm';
  if (text === 'mp4' || text === 'fmp4' || text === 'm4a') return 'mp4';
  return MUX_DEFAULTS.container;
}

/** 关键帧间隔对齐：把 keyframeMs 规整到 fragmentMs 的整数倍（至少 1 个片段一个关键帧）。 */
export function alignKeyframeInterval(fragmentMs, keyframeMs, options = {}) {
  const fragment = clampInt(fragmentMs, MUX_DEFAULTS.minFragmentMs, MUX_DEFAULTS.maxFragmentMs, MUX_DEFAULTS.fragmentMs);
  const requested = Math.max(0, intOr(keyframeMs, fragment));
  if (requested <= 0) {
    return { keyframeMs: fragment, aligned: true, fragmentsPerKeyframe: 1, requestedMs: requested, adjusted: false };
  }
  const fragmentsPerKeyframe = Math.max(1, Math.round(requested / fragment));
  const alignedKeyframeMs = fragment * fragmentsPerKeyframe;
  return {
    keyframeMs: alignedKeyframeMs,
    aligned: alignedKeyframeMs === requested,
    fragmentsPerKeyframe,
    requestedMs: requested,
    adjusted: alignedKeyframeMs !== requested,
  };
}

/** 估算容器开销：分片数 × 每片开销 + 索引开销（+ 可选每片百分比开销）。 */
export function estimateMuxOverhead(fragmentCount, options = {}) {
  const count = Math.max(0, intOr(fragmentCount, 0));
  const perFragment = Math.max(0, intOr(options.fragmentOverheadBytes, MUX_DEFAULTS.fragmentOverheadBytes));
  const index = Math.max(0, intOr(options.indexOverheadBytes, MUX_DEFAULTS.indexOverheadBytes));
  const payloadBytes = Math.max(0, intOr(options.payloadBytes, 0));
  const ratio = Math.max(0, Math.min(0.5, finiteOr(options.overheadRatio, 0)));
  const fromPayload = Math.round(payloadBytes * ratio);
  const bytes = count * perFragment + index + fromPayload;
  return {
    fragmentCount: count,
    perFragmentBytes: perFragment,
    indexBytes: index,
    fromPayloadBytes: fromPayload,
    bytes,
    perFragmentAverage: count > 0 ? Math.round(bytes / count) : index,
  };
}

/**
 * 封装规划：时长/fps/目标分片 → 分片列表（时间区间）+ 开销 + 预算结论。
 *
 * @param {{
 *   durationMs?: number, fps?: number, fragmentMs?: number, keyframeMs?: number,
 *   payloadBytes?: number, maxFragments?: number, maxOverheadBytes?: number,
 *   maxTotalBytes?: number, container?: string, now?: number,
 * }} [options]
 */
export function planVideoMux(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const durationMs = Math.max(0, finiteNonNegative(options.durationMs));
  const fps = Math.max(0.1, Number(options.fps) || 30);
  const fragmentMs = clampInt(options.fragmentMs, MUX_DEFAULTS.minFragmentMs, MUX_DEFAULTS.maxFragmentMs, MUX_DEFAULTS.fragmentMs);
  const alignment = alignKeyframeInterval(fragmentMs, options.keyframeMs != null ? options.keyframeMs : MUX_DEFAULTS.keyframeMs);
  const keyframeMs = alignment.keyframeMs;
  const maxFragments = Math.max(0, intOr(options.maxFragments, MUX_DEFAULTS.maxFragments));
  const maxOverheadBytes = Math.max(0, intOr(options.maxOverheadBytes, MUX_DEFAULTS.maxOverheadBytes));
  const maxTotalBytes = Math.max(0, intOr(options.maxTotalBytes, MUX_DEFAULTS.maxTotalBytes));
  const toleranceMs = Math.max(0, intOr(options.durationToleranceMs, MUX_DEFAULTS.durationToleranceMs));
  const payloadBytes = Math.max(0, intOr(options.payloadBytes, 0));
  const container = normalizeContainer(options.container);

  const fragments = [];
  let cursor = 0;
  let guard = 0;
  while (cursor < durationMs && guard < 100000) {
    guard += 1;
    const remaining = durationMs - cursor;
    const length = Math.min(fragmentMs, Math.max(0, remaining));
    if (length <= 0) break;
    fragments.push({
      index: fragments.length,
      startMs: cursor,
      durationMs: length,
      endMs: cursor + length,
      keyframe: cursor % Math.max(1, keyframeMs) === 0,
      isLast: false,
    });
    cursor += length;
  }
  if (fragments.length) fragments[fragments.length - 1].isLast = true;
  const frameCount = Math.max(0, Math.round((durationMs / 1000) * fps));
  const expectedFrameMs = fps > 0 ? 1000 / fps : 0;

  // 时长容差：最后一个分片不足 toleranceMs 时，要么合并进前一片，要么补尾部空片。
  const durationNote = [];
  if (fragments.length > 1) {
    const last = fragments[fragments.length - 1];
    if (last.durationMs < toleranceMs && last.durationMs < expectedFrameMs * 2) {
      durationNote.push({ code: MUX_CODES.DURATION, action: 'merge-tail', droppedMs: last.durationMs });
      fragments.pop();
      if (fragments.length) fragments[fragments.length - 1].isLast = true;
    }
  }
  const overhead = estimateMuxOverhead(fragments.length, {
    fragmentOverheadBytes: options.fragmentOverheadBytes,
    indexOverheadBytes: options.indexOverheadBytes,
    payloadBytes,
    overheadRatio: options.overheadRatio,
  });
  const totalBytes = payloadBytes > 0 ? payloadBytes + overhead.bytes : overhead.bytes;

  // 预算结论：超开销 → 加大分片（减少片数）；超片数 → 加大分片；仍不行 → reject。
  let action = 'ok';
  let code = MUX_CODES.OK;
  let detail = '封装预算内';
  if (maxOverheadBytes > 0 && overhead.bytes > maxOverheadBytes) {
    action = 'shrink-fragments';
    code = MUX_CODES.SHRINK;
    detail = '容器开销超预算，建议加大分片时长';
  }
  if (maxFragments > 0 && fragments.length > maxFragments) {
    action = 'reduce-fragments';
    code = MUX_CODES.SHRINK;
    detail = '分片数超预算，建议加大分片时长';
  }
  if (maxTotalBytes > 0 && totalBytes > maxTotalBytes) {
    action = 'reject';
    code = MUX_CODES.REJECT;
    detail = '封装总字节超预算';
  }
  const suggestedFragmentMs = action === 'ok'
    ? fragmentMs
    : Math.min(MUX_DEFAULTS.maxFragmentMs, Math.max(fragmentMs, fragmentMs * Math.ceil(Math.max(1, fragments.length / Math.max(1, maxFragments || fragments.length)))));
  const issues = [code];
  if (alignment.adjusted) issues.push(MUX_CODES.ALIGN);
  if (durationNote.length) issues.push(MUX_CODES.DURATION);

  return {
    version: MUX_BUDGET_VERSION,
    ok: action !== 'reject',
    action,
    code,
    detail,
    now,
    container,
    durationMs,
    fps: Number(fps.toFixed(3)),
    fragmentMs,
    keyframeMs,
    alignment,
    frames: frameCount,
    fragments,
    fragmentCount: fragments.length,
    overhead,
    payloadBytes,
    totalBytes,
    budget: { maxFragments, maxOverheadBytes, maxTotalBytes },
    suggestedFragmentMs,
    durationNotes: durationNote,
    issues,
    evidence: {
      now,
      container,
      action,
      durationMs,
      fragmentMs,
      keyframeMs,
      fragments: fragments.length,
      overheadBytes: overhead.bytes,
      totalBytes,
      suggestedFragmentMs,
    },
  };
}

/** 校验封装计划是否自洽（时间轴连续/首尾标记/keyframe 对齐）。 */
export function validateMuxPlan(plan) {
  const errors = [];
  if (!isPlainObject(plan)) {
    return { ok: false, errors: [{ code: 'not-plan', message: '封装计划不是对象' }], fragments: 0, coveredMs: 0 };
  }
  const fragments = Array.isArray(plan.fragments) ? plan.fragments : [];
  if (!fragments.length) errors.push({ code: 'no-fragments', message: '封装计划没有分片' });
  let cursor = 0;
  let coveredMs = 0;
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    if (!isPlainObject(fragment)) {
      errors.push({ code: 'bad-fragment', message: '分片不是对象', index });
      continue;
    }
    if (fragment.index !== index) errors.push({ code: 'bad-index', message: '分片序号不连续', index });
    if (fragment.startMs !== cursor) errors.push({ code: 'gap', message: '分片起点不连续', index });
    if (!(fragment.durationMs > 0)) errors.push({ code: 'bad-duration', message: '分片时长必须为正', index });
    if (index < fragments.length - 1 && fragment.isLast === true) errors.push({ code: 'early-last', message: '过早标记最后一片', index });
    cursor = fragment.endMs;
    coveredMs += Math.max(0, fragment.durationMs);
  }
  if (fragments.length && fragments[fragments.length - 1].isLast !== true) {
    errors.push({ code: 'missing-last', message: '最后一片没有标记 isLast' });
  }
  const durationMs = Math.max(0, intOr(plan.durationMs, 0));
  if (durationMs > 0 && coveredMs < durationMs && Math.abs(coveredMs - durationMs) > MUX_DEFAULTS.durationToleranceMs) {
    errors.push({ code: 'coverage', message: '分片覆盖时长与声明时长不一致' });
  }
  return { ok: errors.length === 0, errors, fragments: fragments.length, coveredMs };
}

/** 分片列表 → 恢复侧可用的分片索引（index/startMs/durationMs/keyframe/bytes 估算）。 */
export function muxFragmentIndex(plan) {
  if (!isPlainObject(plan)) return [];
  const fragments = Array.isArray(plan.fragments) ? plan.fragments : [];
  const overheadPer = plan.overhead ? plan.overhead.perFragmentBytes : MUX_DEFAULTS.fragmentOverheadBytes;
  const payload = Math.max(0, intOr(plan.payloadBytes, 0));
  const totalDuration = fragments.reduce((sum, fragment) => sum + Math.max(0, fragment.durationMs), 0);
  return fragments.map((fragment) => {
    const share = totalDuration > 0 ? fragment.durationMs / totalDuration : 0;
    return {
      index: fragment.index,
      startMs: fragment.startMs,
      durationMs: fragment.durationMs,
      endMs: fragment.endMs,
      keyframe: fragment.keyframe === true,
      estimateBytes: Math.round(payload * share) + overheadPer,
      last: fragment.isLast === true,
    };
  });
}

/** 封装计划 → 协议字段（分片列表截断；计数完整）。 */
export function muxBudgetWire(plan, options = {}) {
  if (!isPlainObject(plan)) {
    return { version: MUX_BUDGET_VERSION, action: 'ok', ok: false, fragments: 0 };
  }
  const limit = clampInt(options.maxListed, 0, 32, 8);
  return {
    version: MUX_BUDGET_VERSION,
    ok: plan.ok === true,
    action: String(plan.action || 'ok'),
    code: plan.code || MUX_CODES.OK,
    detail: String(plan.detail || ''),
    container: plan.container || 'mp4',
    durationMs: plan.durationMs || 0,
    fragmentMs: plan.fragmentMs || 0,
    keyframeMs: plan.keyframeMs || 0,
    fragmentCount: plan.fragmentCount || 0,
    overheadBytes: plan.overhead ? plan.overhead.bytes : 0,
    totalBytes: plan.totalBytes || 0,
    fragments: (Array.isArray(plan.fragments) ? plan.fragments : []).slice(0, limit).map((fragment) => ({
      index: fragment.index,
      startMs: fragment.startMs,
      durationMs: fragment.durationMs,
      keyframe: fragment.keyframe === true,
    })),
    alignment: plan.alignment || null,
    suggestedFragmentMs: plan.suggestedFragmentMs || 0,
    issues: Array.isArray(plan.issues) ? plan.issues.slice(0, 8) : [],
    text: describeMux(plan),
  };
}

/** 一行日志：'封装计划 ok：5 片×2000ms（keyframe 2000ms，开销 6.0KB）'。 */
export function describeMux(plan) {
  if (!isPlainObject(plan)) return '封装计划 无';
  const overheadKb = ((plan.overhead ? plan.overhead.bytes : 0) / 1024).toFixed(1);
  return '封装计划 ' + String(plan.action || 'ok') + '：' + (plan.fragmentCount || 0) + ' 片×' +
    (plan.fragmentMs || 0) + 'ms（keyframe ' + (plan.keyframeMs || 0) + 'ms，开销 ' + overheadKb + 'KB' +
    (plan.suggestedFragmentMs && plan.suggestedFragmentMs !== plan.fragmentMs ? '，建议分片 ' + plan.suggestedFragmentMs + 'ms' : '') + '）';
}
