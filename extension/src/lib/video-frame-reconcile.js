// lib/video-frame-reconcile.js —— 视频录制的时间轴帧级对账（纯函数；第十一批-E）。
//
// 背景：视频录制（video.js + offscreen MediaRecorder + OPFS 分片）只记“分片字节/时长”，
// 崩溃或掉帧后调用方看到的是“duration 变短/分片数变少”，拿不到“丢在哪个时间段、时间戳是否
// 单调、能否用最近关键帧补”的证据。本模块把视频帧看成带 PTS 的区间，做纯函数对账：
//   * expectedTimeline()          —— 按 fps/时长生成期望帧时间轴（startMs/durationMs）；
//   * normalizeVideoFrame()       —— 规整 tMs/pts/durationMs/keyframe/bytes/hash；
//   * reconcileVideoFrames()      —— 对账：丢帧/重叠/乱序/PTS 非单调/尾部未覆盖/时长偏差；
//   * planVideoFrameRepair()      —— 结论 → 修复建议：accept / pad（补静帧）/ reencode（关键帧重编）/ restart；
//   * videoFrameWire()/describeVideoFrames() —— 协议字段与一行日志。
//
// 与 longshot 的帧台账共用 capture-frame-ledger 的摘要/覆盖工具，但时间轴语义独立：
//   - 时间单位毫秒；durationMs 缺省按 1000/fps 推；
//   - “丢帧”只在 duration 内定义：最后不足一帧的尾巴按 50% 容差处理；
//   - 修复只给计划，不触发 MediaRecorder/WebCodecs（运行时在 lib/video-segment-compress 里执行）。

import { digestText, frameCoverage } from './capture-frame-ledger.js';

export const VIDEO_FRAME_VERSION = 1;

export const VIDEO_FRAME_CODES = Object.freeze({
  EMPTY: 'video.frames.empty',
  DROPPED: 'video.frames.dropped',
  OVERLAP: 'video.frames.overlap',
  REORDERED: 'video.frames.reordered',
  NON_MONOTONIC: 'video.frames.non-monotonic',
  TAIL_UNCOVERED: 'video.frames.tail-uncovered',
  DURATION_SHORT: 'video.frames.duration-short',
  DURATION_LONG: 'video.frames.duration-long',
  INVALID: 'video.frames.invalid',
  DUPLICATE_PTS: 'video.frames.duplicate-pts',
  KEYFRAME_GAP: 'video.frames.keyframe-gap',
  OK: 'video.frames.ok',
});

export const VIDEO_FRAME_DEFAULTS = Object.freeze({
  fps: 30,
  // 单帧时长容差：默认 1.5 帧（MediaRecorder 的帧时长本来就有抖动）。
  toleranceFrames: 1.5,
  // 时间轴尾部容差：最后不足 1 帧的尾巴不算丢帧。
  tailToleranceFrames: 1,
  // 关键帧最大间隔（ms）：超过则提示关键帧稀疏，重编/恢复更贵。
  maxKeyframeGapMs: 4000,
  // 丢帧比例告警阈值。
  droppedWarnRatio: 0.02,
  droppedErrorRatio: 0.1,
  // 单次对账最多列出的丢帧区间。
  maxGaps: 32,
});

const SEVERITY_RANK = Object.freeze({ info: 0, warn: 1, error: 2, fatal: 3 });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeFps(value) {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) return VIDEO_FRAME_DEFAULTS.fps;
  return Math.max(0.1, Math.min(240, fps));
}

/** 视频帧的确定性签名：时间区间 + 关键帧 + 内容 hash。 */
export function videoFrameSignature(frame) {
  const normalized = normalizeVideoFrame(frame);
  if (!normalized.ok) return 'video-frame:invalid';
  return [
    normalized.frame.index,
    normalized.frame.startMs,
    normalized.frame.durationMs,
    normalized.frame.keyframe ? 'k' : '-',
    normalized.frame.hash || '',
  ].join('|');
}

/** 视频帧摘要（16 hex），视频时间轴整体摘要用。 */
export function videoFrameDigest(frames, options = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const seed = typeof options.seed === 'string' ? options.seed : 'video-frames/1';
  let chain = digestText(seed);
  for (const frame of list) chain = digestText(chain + ':' + videoFrameSignature(frame));
  return chain;
}

/** 规整单个视频帧：{tMs|pts|startMs, durationMs|duration, keyframe, bytes, hash, index}。 */
export function normalizeVideoFrame(frame, options = {}) {
  if (!isPlainObject(frame)) return { ok: false, reason: 'not-object', frame: null };
  const fps = normalizeFps(options.fps);
  const index = intOr(frame.index, -1);
  if (index < 0) return { ok: false, reason: 'bad-index', frame: null };
  const startMs = Math.max(0, finiteOr(frame.startMs != null ? frame.startMs : (frame.tMs != null ? frame.tMs : frame.pts), 0));
  // 时长 0/缺省都按“一帧”补齐（MediaRecorder 的 fragment 可能不带 duration）。
  const rawDuration = frame.durationMs != null ? frame.durationMs : frame.duration;
  const durationMs = finiteNonNegative(rawDuration) > 0 ? Math.max(0, Number(rawDuration)) : (1000 / fps);
  if (!(durationMs > 0)) return { ok: false, reason: 'bad-duration', frame: null };
  const bytes = Math.max(0, intOr(frame.bytes, frame.size));
  const hash = typeof frame.hash === 'string' ? frame.hash : (typeof frame.sha256 === 'string' ? frame.sha256 : '');
  return {
    ok: true,
    reason: null,
    frame: {
      kind: 'video-fragment',
      index,
      startMs: Math.round(startMs),
      durationMs: Math.round(durationMs),
      endMs: Math.round(startMs + durationMs),
      keyframe: frame.keyframe === true,
      bytes,
      hash: hash.slice(0, 64).toLowerCase(),
      state: typeof frame.state === 'string' ? frame.state : 'captured',
      fpsHint: fps,
    },
  };
}

/** 按 fps/时长生成期望时间轴（不含内容 hash；用于对账“应有哪些帧”）。 */
export function expectedTimeline(options = {}) {
  const fps = normalizeFps(options.fps);
  const durationMs = Math.max(0, finiteOr(options.durationMs, 0));
  const startMs = Math.max(0, finiteOr(options.startMs, 0));
  if (!(durationMs > 0)) return [];
  const frameMs = 1000 / fps;
  const count = Math.max(1, Math.ceil(durationMs / frameMs));
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.round(startMs + index * frameMs);
    const remaining = Math.max(0, Math.round(startMs + durationMs) - start);
    if (remaining <= 0) break;
    frames.push({
      kind: 'video-fragment',
      index,
      startMs: start,
      durationMs: Math.max(1, Math.min(Math.round(frameMs), remaining)),
      endMs: start + Math.max(1, Math.min(Math.round(frameMs), remaining)),
      keyframe: false,
    });
  }
  return frames;
}

function normalizeList(frames, options) {
  const list = Array.isArray(frames) ? frames : [];
  const invalid = [];
  const normalized = [];
  for (let position = 0; position < list.length; position += 1) {
    const result = normalizeVideoFrame(list[position], options);
    if (!result.ok) {
      invalid.push({ position, reason: result.reason });
      continue;
    }
    normalized.push(result.frame);
  }
  return { normalized, invalid };
}

function worstSeverity(findings) {
  let worst = 'none';
  for (const finding of findings) {
    const severity = String(finding.severity || 'info');
    if ((SEVERITY_RANK[severity] || 0) > (SEVERITY_RANK[worst] || 0)) worst = severity;
  }
  return findings.length ? worst : 'none';
}

function timelineChecks(frames, options) {
  const fps = normalizeFps(options.fps);
  const frameMs = 1000 / fps;
  const tolerance = Math.max(0, finiteOr(options.toleranceMs, frameMs * VIDEO_FRAME_DEFAULTS.toleranceFrames));
  const findings = [];
  // 先用“输入顺序”检测 PTS 回归/乱序（排序后就看不出来了）。
  let inputNonMonotonic = 0;
  for (let position = 1; position < frames.length; position += 1) {
    if (frames[position].startMs < frames[position - 1].startMs) inputNonMonotonic += 1;
  }
  const ordered = [...frames].sort((left, right) => left.startMs - right.startMs || left.index - right.index);
  let outOfOrder = false;
  for (let position = 1; position < ordered.length; position += 1) {
    if (ordered[position].index < ordered[position - 1].index) outOfOrder = true;
  }
  if (outOfOrder) {
    findings.push({ code: VIDEO_FRAME_CODES.REORDERED, severity: 'warn', detail: '分片到达顺序与序号不一致（已按 PTS 重排）' });
  }
  let nonMonotonic = inputNonMonotonic;
  if (nonMonotonic) {
    findings.push({ code: VIDEO_FRAME_CODES.NON_MONOTONIC, severity: 'error', count: nonMonotonic, detail: 'PTS 非单调（按输入顺序检测）' });
  }
  const duplicates = [];
  const seenStart = new Map();
  for (const frame of ordered) {
    if (seenStart.has(frame.startMs)) duplicates.push(frame.index);
    seenStart.set(frame.startMs, frame);
  }
  if (duplicates.length) {
    findings.push({ code: VIDEO_FRAME_CODES.DUPLICATE_PTS, severity: 'warn', count: duplicates.length, detail: '存在重复 PTS 的帧' });
  }
  // 覆盖与丢帧区间（时间轴模式）。
  const gaps = [];
  let cursor = 0;
  for (const frame of ordered) {
    if (frame.startMs > cursor + tolerance) {
      gaps.push({ start: cursor, end: frame.startMs, length: frame.startMs - cursor, afterIndex: frame.index - 1 });
    }
    cursor = Math.max(cursor, frame.endMs);
  }
  const durationMs = Math.max(0, finiteOr(options.durationMs, ordered.length ? ordered[ordered.length - 1].endMs : 0));
  if (durationMs > 0 && cursor < durationMs - frameMs * VIDEO_FRAME_DEFAULTS.tailToleranceFrames) {
    gaps.push({ start: cursor, end: durationMs, length: durationMs - cursor, afterIndex: ordered.length ? ordered[ordered.length - 1].index : -1 });
  }
  const droppedMs = gaps.reduce((sum, gap) => sum + gap.length, 0);
  const expectedFrames = durationMs > 0 ? Math.max(1, Math.ceil(durationMs / frameMs)) : 0;
  const droppedRatio = expectedFrames > 0 ? Math.min(1, droppedMs / durationMs) : 0;
  if (gaps.length) {
    findings.push({
      code: VIDEO_FRAME_CODES.DROPPED,
      severity: droppedRatio >= VIDEO_FRAME_DEFAULTS.droppedErrorRatio ? 'error' : (droppedRatio >= VIDEO_FRAME_DEFAULTS.droppedWarnRatio ? 'warn' : 'info'),
      gaps: gaps.slice(0, VIDEO_FRAME_DEFAULTS.maxGaps),
      droppedMs,
      droppedRatio: Number(droppedRatio.toFixed(6)),
      detail: '时间轴存在未覆盖区间（丢帧/录制暂停）',
    });
  }
  if (durationMs > 0 && droppedMs > 0) {
    const lastEnd = ordered.length ? ordered[ordered.length - 1].endMs : 0;
    if (lastEnd < durationMs && gaps.some((gap) => gap.afterIndex === (ordered.length ? ordered[ordered.length - 1].index : -1))) {
      findings.push({ code: VIDEO_FRAME_CODES.TAIL_UNCOVERED, severity: 'warn', uncoveredMs: durationMs - lastEnd, detail: '录制时间轴尾部没有帧覆盖' });
    }
  }
  // 关键帧间隔：稀疏关键帧 → 重编/恢复代价高（info 级提示）。
  const keyframes = ordered.filter((frame) => frame.keyframe);
  let maxKeyframeGapMs = 0;
  for (let position = 1; position < keyframes.length; position += 1) {
    maxKeyframeGapMs = Math.max(maxKeyframeGapMs, keyframes[position].startMs - keyframes[position - 1].startMs);
  }
  if (keyframes.length === 0 && ordered.length > 0) {
    findings.push({ code: VIDEO_FRAME_CODES.KEYFRAME_GAP, severity: 'warn', detail: '时间轴里没有任何关键帧标记' });
  } else if (maxKeyframeGapMs > VIDEO_FRAME_DEFAULTS.maxKeyframeGapMs) {
    findings.push({ code: VIDEO_FRAME_CODES.KEYFRAME_GAP, severity: 'info', maxKeyframeGapMs, detail: '关键帧间隔偏大，重编成本更高' });
  }
  return {
    findings,
    gaps: gaps.slice(0, VIDEO_FRAME_DEFAULTS.maxGaps),
    gapCount: gaps.length,
    droppedMs,
    droppedRatio: Number(droppedRatio.toFixed(6)),
    duplicates,
    nonMonotonic,
    reordered: outOfOrder,
    durationMs,
    expectedFrames,
    maxKeyframeGapMs,
  };
}

/**
 * 视频时间轴帧级对账（唯一入口）。
 *
 * @param {{
 *   frames?: object[], fragments?: object[], expected?: object[],
 *   durationMs?: number, fps?: number, startMs?: number,
 *   toleranceMs?: number, now?: number,
 * }} [params]
 * @returns {object} report（ok/action/counts/gaps/findings/coverage/evidence）
 */
export function reconcileVideoFrames(params = {}) {
  const now = Number.isFinite(Number(params.now)) ? Number(params.now) : 0;
  const fps = normalizeFps(params.fps);
  const frameMs = 1000 / fps;
  const source = Array.isArray(params.frames) ? params.frames : (Array.isArray(params.fragments) ? params.fragments : []);
  const { normalized, invalid } = normalizeList(source, { fps });
  const durationMs = Math.max(0, finiteOr(params.durationMs, normalized.length ? Math.max(...normalized.map((frame) => frame.endMs)) : 0));
  const expected = Array.isArray(params.expected) && params.expected.length
    ? normalizeList(params.expected, { fps }).normalized
    : expectedTimeline({ fps, durationMs, startMs: params.startMs });
  const checks = timelineChecks(normalized, {
    fps,
    durationMs,
    toleranceMs: params.toleranceMs != null ? params.toleranceMs : frameMs * VIDEO_FRAME_DEFAULTS.toleranceFrames,
  });
  const coverage = frameCoverage(normalized.map((frame) => ({ startMs: frame.startMs, durationMs: frame.durationMs, index: frame.index })), {
    mode: 'time',
    totalMs: durationMs,
    // 帧时长抖动是常态：小于半帧的缝在覆盖口径里视为已覆盖（与丢帧判定同一容差）。
    tolerance: frameMs * 0.5,
  });
  const findings = [...checks.findings];
  if (!normalized.length) findings.push({ code: VIDEO_FRAME_CODES.EMPTY, severity: 'info', detail: '没有视频帧记录' });
  if (invalid.length) findings.push({ code: VIDEO_FRAME_CODES.INVALID, severity: 'warn', count: invalid.length, detail: '存在非法帧记录' });
  if (durationMs > 0) {
    const expectedDuration = expected.length ? expected[expected.length - 1].endMs : durationMs;
    const delta = durationMs - expectedDuration;
    if (Math.abs(delta) > Math.max(frameMs * 2, durationMs * 0.05)) {
      findings.push({
        code: delta < 0 ? VIDEO_FRAME_CODES.DURATION_SHORT : VIDEO_FRAME_CODES.DURATION_LONG,
        severity: 'info',
        deltaMs: Math.round(delta),
        detail: '帧覆盖时长与声明时长不一致',
      });
    }
  }
  const severity = worstSeverity(findings);
  const ok = !findings.some((finding) => (SEVERITY_RANK[finding.severity] || 0) >= SEVERITY_RANK.error);
  const action = !normalized.length
    ? 'accept'
    : (ok ? 'accept' : (coverage.ratio >= 0.5 ? 'pad' : 'reencode'));
  const counts = {
    frames: normalized.length,
    expected: expected.length,
    invalid: invalid.length,
    gaps: checks.gapCount,
    droppedMs: checks.droppedMs,
    droppedRatio: checks.droppedRatio,
    duplicates: checks.duplicates.length,
    nonMonotonic: checks.nonMonotonic,
    keyframes: normalized.filter((frame) => frame.keyframe).length,
    maxKeyframeGapMs: checks.maxKeyframeGapMs,
  };
  const issues = [
    ...(normalized.length ? [] : [VIDEO_FRAME_CODES.EMPTY]),
    ...findings.map((finding) => finding.code),
  ];
  return {
    version: VIDEO_FRAME_VERSION,
    ok,
    action,
    fps,
    frameMs: Number(frameMs.toFixed(3)),
    durationMs,
    counts,
    gaps: checks.gaps,
    findings,
    findingsCount: findings.length,
    severity,
    coverage: {
      ratio: coverage.ratio,
      covered: coverage.covered,
      total: coverage.total,
      gapCount: coverage.gapCount,
      gapLength: coverage.gapLength,
      seamless: coverage.seamless,
    },
    duplicates: checks.duplicates,
    invalid,
    expectedCount: expected.length,
    digest: videoFrameDigest(normalized),
    issues,
    evidence: {
      now,
      fps,
      durationMs,
      frames: normalized.length,
      gaps: checks.gapCount,
      droppedMs: checks.droppedMs,
      droppedRatio: checks.droppedRatio,
      severity,
    },
  };
}

/**
 * 修复建议：
 *   accept   —— 无 error，直接收；
 *   pad      —— 有丢帧但可用帧占多数：在缺口处补静帧/重复上一帧（不重编）；
 *   reencode —— 丢帧严重或时间轴错乱：按关键帧重编（成本高）；
 *   restart  —— 全空/完全不可用：重录。
 * 返回的 ranges 是“要补/要重编”的时间区间，供 video-segment-compress 预算。
 */
export function planVideoFrameRepair(report) {
  if (!isPlainObject(report)) return { version: VIDEO_FRAME_VERSION, action: 'restart', ranges: [], reasons: ['no-report'] };
  const gaps = Array.isArray(report.gaps) ? report.gaps : [];
  const ranges = gaps.map((gap) => ({
    startMs: Math.max(0, intOr(gap.start, 0)),
    endMs: Math.max(0, intOr(gap.end, 0)),
    durationMs: Math.max(0, intOr(gap.length, Math.max(0, intOr(gap.end, 0) - intOr(gap.start, 0)))),
    strategy: report.action === 'reencode' ? 'reencode' : 'pad',
  }));
  const reasons = [];
  if (report.action === 'accept') reasons.push('时间轴完整');
  if (report.action === 'pad') reasons.push('少量丢帧，补静帧成本低于重编');
  if (report.action === 'reencode') reasons.push('丢帧过多或时间轴错乱，需要按关键帧重编');
  if (report.action === 'restart') reasons.push('没有可用帧，建议重录');
  for (const finding of Array.isArray(report.findings) ? report.findings : []) {
    if (finding.code === VIDEO_FRAME_CODES.NON_MONOTONIC) reasons.push('PTS 非单调');
    if (finding.code === VIDEO_FRAME_CODES.KEYFRAME_GAP) reasons.push('关键帧稀疏');
  }
  return {
    version: VIDEO_FRAME_VERSION,
    action: String(report.action || 'restart'),
    ranges,
    rangeCount: ranges.length,
    coveredMs: ranges.reduce((sum, range) => sum + range.durationMs, 0),
    reasons: [...new Set(reasons)].slice(0, 4),
    evidence: {
      action: report.action || 'restart',
      ranges: ranges.length,
      coveredMs: ranges.reduce((sum, range) => sum + range.durationMs, 0),
      droppedRatio: report.counts ? report.counts.droppedRatio : 0,
    },
  };
}

/** 对账报告 → 协议字段（截断列表；键集稳定）。 */
export function videoFrameWire(report, options = {}) {
  if (!isPlainObject(report)) {
    return { version: VIDEO_FRAME_VERSION, ok: false, action: 'restart', counts: {}, gaps: [] };
  }
  const limit = clampInt(options.maxListed, 0, 32, 6);
  return {
    version: VIDEO_FRAME_VERSION,
    ok: report.ok === true,
    action: String(report.action || 'accept'),
    severity: String(report.severity || 'none'),
    fps: report.fps,
    durationMs: report.durationMs || 0,
    counts: { ...(report.counts || {}) },
    coverage: report.coverage || null,
    gaps: (Array.isArray(report.gaps) ? report.gaps : []).slice(0, limit),
    findings: (Array.isArray(report.findings) ? report.findings : []).slice(0, limit).map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      index: finding.index,
      detail: finding.detail,
    })),
    digest: report.digest || null,
    text: describeVideoFrames(report),
  };
}

/** 一行日志：'视频帧对账 accept：120 帧/4.0s 覆盖 100% 丢帧 0'。 */
export function describeVideoFrames(report) {
  if (!isPlainObject(report)) return '视频帧对账 无';
  const counts = report.counts || {};
  const seconds = (Math.max(0, Number(report.durationMs) || 0) / 1000).toFixed(1);
  return '视频帧对账 ' + (report.ok ? 'ok' : '异常') +
    '：' + (counts.frames || 0) + ' 帧/' + seconds + 's' +
    ' 覆盖 ' + Math.round((report.coverage ? report.coverage.ratio : 0) * 100) + '%' +
    ' 丢帧 ' + (counts.gaps || 0) + ' 段/' + (counts.droppedMs || 0) + 'ms' +
    '（' + String(report.severity || 'none') + '）';
}
