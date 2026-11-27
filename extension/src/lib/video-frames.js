// lib/video-frames.js —— 录制帧级校验：时间戳单调/间隔抖动/关键帧 GOF/校验链/修复计划（纯函数）。
//
// 现状：video-verify.js 校验的是“容器 + 分片 + 完整帧数量”（inspectContainer/verifyFragments），
// 它回答“这条 mp4 能不能播”；但录制写入过程中的**帧序列事实**没有被校验：
//   1) 时间戳倒退（编码器在硬切/重建时会出现）会让播放器 seek 错乱，但分片 hash 是好的；
//   2) 帧间隔抖动（掉帧/卡顿）没有量化，无法区分“正常掉帧”和“录到一半丢帧”；
//   3) 关键帧间隔（GOP）异常放大时 seek 变慢，但完整性校验是绿的；
//   4) 恢复出来的记录没有“帧校验结论”证据字段，recover 只能报 completeness。
//
// 本模块只看帧元数据（不解析 mp4 字节），把上述事实算清楚：
//   normalizeFrame()      —— 帧元数据归一化（pts/dts/duration/keyframe/bytes/checksum）；
//   validateFrameSequence() —— 单调性/重复/间隔/时长覆盖率（problems 带 code+index）；
//   keyframeStats()       —— 关键帧数量与 GOP 长度分布（含最大 GOP 是“seek 慢”的证据）；
//   estimateFps()         —— 由相邻帧间隔估 fps（中位数抗抖动，给出抖动比）；
//   frameChecksumChain()  —— 每帧 checksum 的链式摘要（定位“第几个字节开始不一致”）；
//   classifyFrameProblems()/planFrameRepair() —— 问题分类与修复阶梯（drop/trim/reencode/accept）；
//   summarizeFrames()/describeFrames()/frameReport()。
//
// 帧元数据形状（offscreen/编码器回调给什么就用什么）：
//   { index?, pts?/timestamp?, durationMs?, keyframe?/key?, bytes?/size?, checksum?/hash?, width?, height? }

export const FRAME_VERSION = 1;

export const FRAME_DEFAULTS = Object.freeze({
  // 相邻帧间隔超过该值视为“间隔异常”（60fps 下是 4 帧，30fps 下是 2 帧）。
  maxGapMs: 500,
  // 时间戳允许的倒退容差（ms）：小于它算取整噪声。
  toleranceMs: 1,
  // 单帧时长上限（ms）：超过视为时间戳坏值。
  maxDurationMs: 5000,
  // GOP 超过该值给出“seek 慢”证据（不影响完整性）。
  maxGopFrames: 300,
  // 抖动比（相邻间隔标准差/中位数）超过该值标记抖动。
  maxJitterRatio: 0.5,
  // 帧链最多校验多少帧（避免对 10 分钟录制做全量 O(n) 证据拼接；摘要仍覆盖全部）。
  maxChainFrames: 8192,
});

/** 问题码（不带 E_ 前缀，只作为 evidence/problem.code 使用）。 */
export const FRAME_CODES = Object.freeze({
  TIMESTAMP_REGRESSION: 'frame-timestamp-regression',
  TIMESTAMP_DUPLICATE: 'frame-timestamp-duplicate',
  GAP: 'frame-gap',
  DURATION_ZERO: 'frame-duration-zero',
  DURATION_INVALID: 'frame-duration-invalid',
  BYTES_ZERO: 'frame-bytes-zero',
  CHECKSUM_MISSING: 'frame-checksum-missing',
  CHECKSUM_MISMATCH: 'frame-checksum-mismatch',
  GOP_LONG: 'frame-gop-long',
  NO_KEYFRAME: 'frame-no-keyframe',
  EMPTY: 'frame-empty',
  DIMENSION: 'frame-dimension',
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

function hex32(value) {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** 帧校验链摘要（FNV-1a + djb2，与 video-journal 同一实现思路）。 */
export function frameDigestOf(input) {
  const text = String(input == null ? '' : input);
  let fnv = 2166136261 >>> 0;
  let djb = 5381 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index) & 0xff;
    fnv = Math.imul(fnv ^ code, 16777619) >>> 0;
    djb = ((Math.imul(djb, 33) >>> 0) + code) >>> 0;
  }
  return hex32(fnv) + hex32(djb);
}

/** 归一化帧元数据：字段名兼容多种来源（pts/timestamp/tMs、keyframe/key、bytes/size）。 */
export function normalizeFrame(frame, fallbackIndex = 0) {
  const value = frame && typeof frame === 'object' ? frame : {};
  const pts = value.pts != null
    ? value.pts
    : (value.timestamp != null ? value.timestamp : (value.tMs != null ? value.tMs : value.timeMs));
  return {
    index: Math.max(0, intOr(value.index, fallbackIndex)),
    tMs: Math.max(0, Math.round(numOr(pts, 0))),
    durationMs: Math.max(0, Math.round(numOr(value.durationMs != null ? value.durationMs : value.duration, 0))),
    keyframe: value.keyframe === true || value.key === true || value.sync === true,
    bytes: Math.max(0, intOr(value.bytes != null ? value.bytes : value.size, 0)),
    checksum: String(value.checksum != null ? value.checksum : (value.hash != null ? value.hash : '')).toLowerCase(),
    width: Math.max(0, intOr(value.width, 0)),
    height: Math.max(0, intOr(value.height, 0)),
  };
}

/**
 * 帧序列校验：单调/重复/间隔/时长/字节/维度和。
 * @returns {{
 *   ok: boolean, frames: number, problems: Array<object>, monotonic: boolean,
 *   durationMs: number, coveredMs: number, coverageRatio: number, gaps: number,
 *   duplicateTimestamps: number, regressions: number, firstAt: number, lastAt: number,
 *   digest: string,
 * }}
 */
export function validateFrameSequence(frames, options = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const tolerance = Math.max(0, intOr(options.toleranceMs, FRAME_DEFAULTS.toleranceMs));
  const maxGapMs = Math.max(1, intOr(options.maxGapMs, FRAME_DEFAULTS.maxGapMs));
  const maxDurationMs = Math.max(1, intOr(options.maxDurationMs, FRAME_DEFAULTS.maxDurationMs));
  const problems = [];
  const push = (code, message, extra = {}) => problems.push({ code, message, ...extra });
  if (!list.length) {
    return {
      ok: false, frames: 0, problems: [{ code: FRAME_CODES.EMPTY, message: '没有帧元数据' }],
      monotonic: true, durationMs: 0, coveredMs: 0, coverageRatio: 0, gaps: 0,
      duplicateTimestamps: 0, regressions: 0, firstAt: 0, lastAt: 0, digest: '',
    };
  }
  const normalized = list.map((frame, index) => normalizeFrame(frame, index));
  let previous = null;
  let gaps = 0;
  let regressions = 0;
  let duplicateTimestamps = 0;
  let coveredMs = 0;
  let durationMs = 0;
  const dimensions = new Set();
  for (const frame of normalized) {
    if (previous) {
      if (frame.tMs < previous.tMs - tolerance) {
        regressions += 1;
        push(FRAME_CODES.TIMESTAMP_REGRESSION, '时间戳倒退：' + previous.tMs + '→' + frame.tMs, { index: frame.index });
      } else if (Math.abs(frame.tMs - previous.tMs) <= tolerance) {
        duplicateTimestamps += 1;
        push(FRAME_CODES.TIMESTAMP_DUPLICATE, '时间戳重复：' + frame.tMs, { index: frame.index });
      } else if (frame.tMs - previous.tMs > maxGapMs) {
        gaps += 1;
        push(FRAME_CODES.GAP, '帧间隔 ' + (frame.tMs - previous.tMs) + 'ms 超过 ' + maxGapMs + 'ms', { index: frame.index, gapMs: frame.tMs - previous.tMs });
      }
    }
    if (frame.durationMs === 0) {
      push(FRAME_CODES.DURATION_ZERO, '帧 ' + frame.index + ' 时长为 0（时间戳可能缺 duration）', { index: frame.index });
    } else if (frame.durationMs > maxDurationMs) {
      push(FRAME_CODES.DURATION_INVALID, '帧 ' + frame.index + ' 时长 ' + frame.durationMs + 'ms 超过上限', { index: frame.index });
    }
    if (frame.bytes === 0) push(FRAME_CODES.BYTES_ZERO, '帧 ' + frame.index + ' 字节为 0', { index: frame.index });
    if (!frame.checksum) push(FRAME_CODES.CHECKSUM_MISSING, '帧 ' + frame.index + ' 缺少 checksum', { index: frame.index });
    if (frame.width > 0 && frame.height > 0) dimensions.add(frame.width + 'x' + frame.height);
    coveredMs += frame.durationMs;
    durationMs = Math.max(durationMs, frame.tMs);
    previous = frame;
  }
  if (dimensions.size > 1) {
    push(FRAME_CODES.DIMENSION, '帧尺寸不一致：' + [...dimensions].slice(0, 4).join(', '));
  }
  const span = durationMs > 0 ? durationMs : 0;
  const coverageRatio = span > 0 ? Math.min(1, Math.round((coveredMs / span) * 1000) / 1000) : 0;
  const fatalCodes = new Set([
    FRAME_CODES.TIMESTAMP_REGRESSION,
    FRAME_CODES.DURATION_INVALID,
    FRAME_CODES.DIMENSION,
    FRAME_CODES.EMPTY,
  ]);
  const ok = !problems.some((problem) => fatalCodes.has(problem.code));
  return {
    ok,
    frames: normalized.length,
    problems,
    monotonic: regressions === 0,
    durationMs: span,
    coveredMs,
    coverageRatio,
    gaps,
    duplicateTimestamps,
    regressions,
    firstAt: normalized[0].tMs,
    lastAt: normalized[normalized.length - 1].tMs,
    digest: frameChainDigest(normalized),
  };
}

/** 关键帧统计：数量、GOP 长度分布、最大 GOP、首个关键帧位置。 */
export function keyframeStats(frames, options = {}) {
  const list = (Array.isArray(frames) ? frames : []).map((frame, index) => normalizeFrame(frame, index));
  const maxGopFrames = Math.max(1, intOr(options.maxGopFrames, FRAME_DEFAULTS.maxGopFrames));
  const keyframes = [];
  const gops = [];
  let lastKey = null;
  for (const frame of list) {
    if (frame.keyframe) {
      keyframes.push(frame.index);
      if (lastKey != null) gops.push(frame.index - lastKey);
      lastKey = frame.index;
    }
  }
  if (lastKey != null && list.length - 1 > lastKey) gops.push(list.length - 1 - lastKey);
  const maxGop = gops.length ? Math.max(...gops) : (list.length ? list.length : 0);
  return {
    frames: list.length,
    keyframes: keyframes.length,
    firstKeyframe: keyframes.length ? keyframes[0] : -1,
    gopLengths: gops,
    avgGop: gops.length ? Math.round((gops.reduce((sum, value) => sum + value, 0) / gops.length) * 10) / 10 : 0,
    maxGop,
    longGop: maxGop > maxGopFrames,
    allKeyframes: list.length > 0 && keyframes.length === list.length,
    noKeyframe: keyframes.length === 0 && list.length > 0,
  };
}

/** 由相邻帧间隔估 fps：中位数抗抖动；同时给出抖动比与坏间隔计数。 */
export function estimateFps(frames, options = {}) {
  const list = (Array.isArray(frames) ? frames : []).map((frame, index) => normalizeFrame(frame, index));
  const tolerance = Math.max(0, intOr(options.toleranceMs, FRAME_DEFAULTS.toleranceMs));
  const deltas = [];
  for (let index = 1; index < list.length; index += 1) {
    const delta = list[index].tMs - list[index - 1].tMs;
    if (delta > tolerance) deltas.push(delta);
  }
  if (!deltas.length) {
    return { fps: 0, medianDeltaMs: 0, meanDeltaMs: 0, jitterMs: 0, jitterRatio: 0, samples: 0, stable: true, fpsSource: 'none' };
  }
  const sorted = deltas.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const variance = deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / deltas.length;
  const stdDev = Math.sqrt(variance);
  const jitterRatio = median > 0 ? Math.round((stdDev / median) * 1000) / 1000 : 0;
  const fps = median > 0 ? Math.round((1000 / median) * 1000) / 1000 : 0;
  return {
    fps,
    medianDeltaMs: median,
    meanDeltaMs: Math.round(mean * 10) / 10,
    jitterMs: Math.round(stdDev * 10) / 10,
    jitterRatio,
    samples: deltas.length,
    stable: jitterRatio <= FRAME_DEFAULTS.maxJitterRatio,
    fpsSource: 'median',
  };
}

/** 帧校验链：把每帧 checksum 串起来算链摘要；checksum 缺失过多时 ok=false。 */
export function frameChecksumChain(frames, options = {}) {
  const list = (Array.isArray(frames) ? frames : []).map((frame, index) => normalizeFrame(frame, index));
  const maxFrames = Math.max(1, intOr(options.maxChainFrames, FRAME_DEFAULTS.maxChainFrames));
  const checked = Math.min(list.length, maxFrames);
  let chain = '';
  let missing = 0;
  for (let index = 0; index < checked; index += 1) {
    const frame = list[index];
    if (!frame.checksum) {
      missing += 1;
      chain = frameDigestOf(chain + '|missing|' + frame.index);
      continue;
    }
    chain = frameDigestOf(chain + '|' + frame.index + ':' + frame.checksum);
  }
  return {
    ok: list.length > 0 && missing === 0,
    frames: list.length,
    checked,
    missing,
    // 只验证前 maxChainFrames 帧时，digest 是“前缀链”，不能当作全量摘要。
    partial: checked < list.length,
    chain,
  };
}

/** 帧级链摘要（validateFrameSequence 的 digest 字段用；扁平规范串）。 */
export function frameChainDigest(frames) {
  const list = Array.isArray(frames) ? frames : [];
  const canonical = list.map((frame, index) => {
    const value = normalizeFrame(frame, index);
    return value.index + ':' + value.tMs + ':' + value.durationMs + ':' + (value.keyframe ? 1 : 0) + ':' + value.bytes + ':' + value.checksum;
  }).join(';');
  return frameDigestOf(canonical);
}

/** 问题分类：致命（不可播）/可修（drop/trim）/可接受（GOP 长）。 */
export function classifyFrameProblems(problems, options = {}) {
  const list = Array.isArray(problems) ? problems : [];
  const categories = { fatal: [], repairable: [], acceptable: [] };
  for (const problem of list) {
    const code = String(problem && problem.code || '');
    switch (code) {
      case FRAME_CODES.TIMESTAMP_REGRESSION:
      case FRAME_CODES.DURATION_INVALID:
      case FRAME_CODES.DIMENSION:
      case FRAME_CODES.EMPTY:
        categories.fatal.push(problem);
        break;
      case FRAME_CODES.TIMESTAMP_DUPLICATE:
      case FRAME_CODES.DURATION_ZERO:
      case FRAME_CODES.BYTES_ZERO:
      case FRAME_CODES.CHECKSUM_MISMATCH:
        categories.repairable.push(problem);
        break;
      case FRAME_CODES.GAP:
      case FRAME_CODES.GOP_LONG:
      case FRAME_CODES.CHECKSUM_MISSING:
      case FRAME_CODES.NO_KEYFRAME:
        categories.acceptable.push(problem);
        break;
      default:
        categories.acceptable.push(problem);
        break;
    }
  }
  const maxAcceptable = Math.max(0, intOr(options.maxAcceptable, 0));
  return {
    fatal: categories.fatal.length,
    repairable: categories.repairable.length,
    acceptable: categories.acceptable.length,
    fatalProblems: categories.fatal,
    repairableProblems: categories.repairable,
    acceptableProblems: categories.acceptable,
    // 允许少量可接受问题（掉帧）但可修问题超过阈值时整体判“需要修复”。
    needsRepair: categories.repairable.length > maxAcceptable,
    playable: categories.fatal.length === 0,
    codes: [...new Set(list.map((problem) => String(problem && problem.code || '')))],
  };
}

/**
 * 修复计划：可修问题给具体动作（drop/trim/reencode），致命问题给 abort（不假装修好了）。
 * @returns {{action: string, steps: Array<object>, dropIndexes: number[], trimToMs: number, notes: string[], ok: boolean}}
 */
export function planFrameRepair(frames, options = {}) {
  const validation = validateFrameSequence(frames, options);
  const classification = classifyFrameProblems(validation.problems, options);
  const steps = [];
  const dropIndexes = new Set();
  let trimToMs = 0;
  const notes = [];
  if (validation.frames === 0) {
    return { ok: false, action: 'abort', steps: [{ action: 'abort', reason: 'no-frames' }], dropIndexes: [], trimToMs: 0, notes: ['没有帧可修'], validation, classification };
  }
  if (!classification.playable) {
    // 致命问题：时间戳倒退/维度不一致/resize。只给“截到崩溃点之前”的最小动作，不静默重排。
    const firstFatal = classification.fatalProblems[0];
    steps.push({ action: 'abort', reason: firstFatal.code, index: intOr(firstFatal.index, -1) });
    // 同时给出“保留有效前缀”的备选（调用方可选择 partial 恢复）。
    const fatalIndex = intOr(firstFatal.index, -1);
    if (fatalIndex > 0) {
      trimToMs = intOr(normalizeFrame(frames[fatalIndex - 1], fatalIndex - 1).tMs, 0);
      steps.push({ action: 'trim', toMs: trimToMs, reason: 'keep-prefix' });
      notes.push('致命问题出现在第 ' + fatalIndex + ' 帧：可截到 ' + trimToMs + 'ms 保留有效前缀');
    }
    return { ok: false, action: 'abort', steps, dropIndexes: [], trimToMs, notes, validation, classification };
  }
  for (const problem of classification.repairableProblems) {
    const index = intOr(problem && problem.index, -1);
    if (index < 0) continue;
    if (problem.code === FRAME_CODES.TIMESTAMP_DUPLICATE) {
      dropIndexes.add(index);
      steps.push({ action: 'drop', index, reason: problem.code });
    } else if (problem.code === FRAME_CODES.BYTES_ZERO || problem.code === FRAME_CODES.CHECKSUM_MISMATCH) {
      steps.push({ action: 'reencode', index, reason: problem.code });
    } else if (problem.code === FRAME_CODES.DURATION_ZERO) {
      steps.push({ action: 'rewrite-duration', index, reason: problem.code });
    }
  }
  if (dropIndexes.size) {
    notes.push('丢弃 ' + dropIndexes.size + ' 帧重复时间戳帧（保留首帧）');
  }
  if (validation.gaps > 0) notes.push('接受 ' + validation.gaps + ' 处帧间隔（掉帧，不重编码）');
  const action = steps.length ? (dropIndexes.size ? 'drop' : 'rewrite') : 'accept';
  return {
    ok: true,
    action,
    steps,
    dropIndexes: [...dropIndexes].sort((a, b) => a - b),
    trimToMs,
    notes,
    validation,
    classification,
  };
}

/** 综合报告：一次调用拿到“能不能播 + 帧事实 + 修复计划”。 */
export function frameReport(frames, options = {}) {
  const validation = validateFrameSequence(frames, options);
  const keyframes = keyframeStats(frames, options);
  const fps = estimateFps(frames, options);
  const chain = frameChecksumChain(frames, options);
  const classification = classifyFrameProblems(validation.problems, options);
  const repair = options.planRepair === false ? null : planFrameRepair(frames, options);
  return {
    version: FRAME_VERSION,
    ok: validation.ok,
    validation,
    keyframes,
    fps,
    chain,
    classification,
    repair,
    // 可播放判定：无致命问题 + 有帧 + 至少一个关键帧（否则 seek 不可能）。
    playable: validation.frames > 0 && classification.playable && !keyframes.noKeyframe,
    stuck: validation.frames > 0 && keyframes.noKeyframe,
  };
}

/** 协议 wire（结果字段，只加不改）。 */
export function summarizeFrames(report, options = {}) {
  if (!report || typeof report !== 'object') return null;
  const maxProblems = Math.max(0, Math.min(24, intOr(options.maxProblems, 6)));
  const validation = report.validation || {};
  const problems = Array.isArray(validation.problems) ? validation.problems : [];
  return {
    version: intOr(report.version, FRAME_VERSION),
    ok: report.ok === true,
    playable: report.playable === true,
    frames: intOr(validation.frames, 0),
    duration_ms: intOr(validation.durationMs, 0),
    coverage: Number(validation.coverageRatio) || 0,
    monotonic: validation.monotonic === true,
    regressions: intOr(validation.regressions, 0),
    duplicate_timestamps: intOr(validation.duplicateTimestamps, 0),
    gaps: intOr(validation.gaps, 0),
    digest: String(validation.digest || ''),
    keyframes: intOr(report.keyframes && report.keyframes.keyframes, 0),
    gop: intOr(report.keyframes && report.keyframes.maxGop, 0),
    fps: Number(report.fps && report.fps.fps) || 0,
    jitter: Number(report.fps && report.fps.jitterRatio) || 0,
    chain: String(report.chain && report.chain.chain || ''),
    chain_ok: report.chain ? report.chain.ok === true : null,
    problems: problems.slice(0, maxProblems).map((problem) => ({
      code: String(problem.code || ''),
      index: intOr(problem.index, -1),
      message: String(problem.message || '').slice(0, 160),
    })),
    problem_count: problems.length,
    repair: report.repair ? { action: String(report.repair.action || 'accept'), steps: (report.repair.steps || []).slice(0, 4) } : null,
  };
}

/** 一行日志：'帧校验 300 帧 / 30fps / 单调 / 10 关键帧 / 0 问题'。 */
export function describeFrames(report) {
  const summary = summarizeFrames(report);
  if (!summary) return '帧校验 无';
  const fps = summary.fps > 0 ? summary.fps + 'fps' : 'fps未知';
  return '帧校验 ' + summary.frames + ' 帧 / ' + fps + (summary.monotonic ? ' / 单调' : ' / 时间戳倒退') +
    ' / ' + summary.keyframes + ' 关键帧 / ' + summary.problem_count + ' 问题' +
    (summary.playable ? '' : '（不可播）');
}

/** 从 video-verify 的分片报告里抽取帧元数据（兼容 fragments[].frames / frames 两种形状）。 */
export function framesFromRecord(record) {
  const source = record && typeof record === 'object' ? record : {};
  if (Array.isArray(source.frames) && source.frames.length) return source.frames;
  const fragments = Array.isArray(source.fragments) ? source.fragments : [];
  const frames = [];
  for (const fragment of fragments) {
    const list = Array.isArray(fragment && fragment.frames) ? fragment.frames : [];
    for (const frame of list) {
      frames.push({ ...frame, fragmentIndex: intOr(fragment.index, frames.length) });
    }
  }
  return frames;
}
