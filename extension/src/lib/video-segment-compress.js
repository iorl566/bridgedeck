// lib/video-segment-compress.js —— 视频分片/分片日记的存储压缩与预算（纯函数；第十一批-E）。
//
// 背景：视频落库 = OPFS 分段（每段一个 blob）+ chrome.storage 的分片日记（persist_parts）。
// 0.3.0 没有分片级压缩/预算：段一律原样存、日记全量 JSON，长录制写满配额后“最后几段丢失”，
// 且恢复侧只能看到 segments 计数，不知道“哪些段值得保留/去重/重编”。
//
// 本模块把分片级存储策略收敛成纯函数：
//   estimateSegmentBytes()     —— 按时长 × 码率 + 容器开销估段体积；
//   planSegmentCompression()   —— 段预算：超单段上限的段进 reencode 候选，重复 hash 去重；
//   compressJournalEntries()   —— 分片日记瘦身（只保留恢复必需字段，去掉 frames 明细）；
//   mergeVideoEvidence()       —— 把“帧时间轴对账 + 转码预算 + 封装预算 + 存储配额”合成一份证据；
//   segmentCompressionWire()/describeSegmentCompression() —— 协议字段与一行日志。
//
// 约束：纯计算，不触发 blob 读写；真实执行由 video.js / offscreen 侧按 plan 进行。

import { planStorageBudget, storageBudgetWire } from './capture-storage-budget.js';

export const SEGMENT_COMPRESS_VERSION = 1;

export const SEGMENT_ACTIONS = Object.freeze(['keep', 'dedupe', 'reencode', 'evict', 'reject']);

export const SEGMENT_CODES = Object.freeze({
  OK: 'video.segment.ok',
  DEDUPE: 'video.segment.dedupe',
  REENCODE: 'video.segment.reencode',
  EVICT: 'video.segment.evict',
  REJECT: 'video.segment.reject',
  JOURNAL: 'video.segment.journal',
});

export const SEGMENT_DEFAULTS = Object.freeze({
  // 单段体积上限：与 video-budget.maxSegmentBytes 默认一致（64MB）。
  maxSegmentBytes: 64 * 1024 * 1024,
  // 目标段体积：8MB（便于崩溃恢复与配额淘汰）。
  targetSegmentBytes: 8 * 1024 * 1024,
  // 容器开销系数（分片头 + 索引）。
  containerOverhead: 1.02,
  // 日记里每条分片的固定开销估算（JSON 字段 + 标点）。
  journalEntryBytes: 220,
  // 日记瘦身后每片保留的键。
  journalKeepKeys: Object.freeze(['index', 'bytes', 'hash', 'tMs', 'durationMs', 'keyframe']),
  // 去重时忽略的帧明细字段。
  journalDropKeys: Object.freeze(['frames', 'frameReport', 'debug', 'raw']),
  // 单次规划最多写多少条的段预算上限。
  maxSegments: 4096,
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

/** 按时长/码率估算段体积；缺码率时按 targetSegmentBytes 兜底。 */
export function estimateSegmentBytes(params = {}) {
  const durationMs = Math.max(0, finiteNonNegative(params.durationMs));
  const bitrate = Math.max(0, intOr(params.bitrate, 0));
  const overhead = Math.max(1, Number(params.containerOverhead) || SEGMENT_DEFAULTS.containerOverhead);
  if (bitrate > 0 && durationMs > 0) {
    return Math.round((bitrate / 8) * (durationMs / 1000) * overhead);
  }
  const fallback = Math.max(0, intOr(params.bytes, 0));
  return fallback;
}

function normalizeSegment(segment, position = 0) {
  if (!isPlainObject(segment)) return null;
  const index = intOr(segment.index, position);
  if (index < 0) return null;
  const durationMs = Math.max(0, finiteNonNegative(segment.durationMs != null ? segment.durationMs : segment.duration));
  const bytes = Math.max(0, intOr(segment.bytes, finiteNonNegative(segment.size)));
  return {
    index,
    bytes,
    durationMs,
    hash: typeof segment.hash === 'string' ? segment.hash.toLowerCase() : (typeof segment.sha256 === 'string' ? segment.sha256.toLowerCase() : ''),
    keyframe: segment.keyframe === true,
    tMs: Math.max(0, intOr(segment.tMs, 0)),
    state: typeof segment.state === 'string' ? segment.state : 'sealed',
  };
}

/** 去重：同 hash 的段只保留一份（保留 bytes 更大/时间更早的一版作为主段）。 */
export function dedupeSegments(segments) {
  const list = (Array.isArray(segments) ? segments : []).map((segment, position) => normalizeSegment(segment, position)).filter(Boolean);
  const byHash = new Map();
  const unique = [];
  const duplicates = [];
  let savedBytes = 0;
  for (const segment of list) {
    if (!segment.hash) {
      unique.push(segment);
      continue;
    }
    if (byHash.has(segment.hash)) {
      duplicates.push({ index: segment.index, hash: segment.hash, duplicateOf: byHash.get(segment.hash).index, bytes: segment.bytes });
      savedBytes += segment.bytes;
      continue;
    }
    byHash.set(segment.hash, segment);
    unique.push(segment);
  }
  return {
    unique,
    duplicates,
    savedBytes,
    ratio: list.length ? Number((duplicates.length / list.length).toFixed(4)) : 0,
  };
}

/**
 * 段预算规划：去重 → 超单段上限的段进 reencode 候选 → 配额决策（与 capture-storage-budget 联动）。
 *
 * @param {{
 *   segments?: object[], usedBytes?: number, quotaBytes?: number, kind?: string,
 *   maxSegmentBytes?: number, targetSegmentBytes?: number, now?: number,
 * }} [options]
 */
export function planSegmentCompression(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const maxSegmentBytes = Math.max(0, intOr(options.maxSegmentBytes, SEGMENT_DEFAULTS.maxSegmentBytes));
  const targetSegmentBytes = clampInt(options.targetSegmentBytes, 1024, Math.max(1024, maxSegmentBytes || SEGMENT_DEFAULTS.maxSegmentBytes), SEGMENT_DEFAULTS.targetSegmentBytes);
  const list = (Array.isArray(options.segments) ? options.segments : [])
    .map((segment, position) => normalizeSegment(segment, position))
    .filter(Boolean)
    .slice(0, Math.max(1, intOr(options.maxSegments, SEGMENT_DEFAULTS.maxSegments)));
  const deduped = dedupeSegments(list);
  const totalBytes = deduped.unique.reduce((sum, segment) => sum + segment.bytes, 0);
  const reencode = [];
  const keep = [];
  for (const segment of deduped.unique) {
    if (maxSegmentBytes > 0 && segment.bytes > maxSegmentBytes) {
      reencode.push({
        index: segment.index,
        bytes: segment.bytes,
        targetBytes: Math.min(maxSegmentBytes, targetSegmentBytes),
        reason: 'segment-too-large',
      });
      continue;
    }
    if (targetSegmentBytes > 0 && segment.bytes > targetSegmentBytes * 1.5) {
      reencode.push({
        index: segment.index,
        bytes: segment.bytes,
        targetBytes: targetSegmentBytes,
        reason: 'segment-above-target',
      });
      continue;
    }
    keep.push({ index: segment.index, bytes: segment.bytes, durationMs: segment.durationMs, keyframe: segment.keyframe });
  }
  const storage = planStorageBudget({
    captures: options.captures,
    usedBytes: options.usedBytes,
    incomingBytes: totalBytes,
    quotaBytes: options.quotaBytes,
    kind: 'video',
    maxCaptureRatio: options.maxCaptureRatio,
    now,
  });
  let action = 'keep';
  const issues = [];
  if (deduped.duplicates.length) {
    action = 'dedupe';
    issues.push(SEGMENT_CODES.DEDUPE);
  }
  if (reencode.length) {
    action = 'reencode';
    issues.push(SEGMENT_CODES.REENCODE);
  }
  if (storage.action === 'evict') {
    action = 'evict';
    issues.push(SEGMENT_CODES.EVICT);
  }
  if (storage.action === 'reject') {
    action = 'reject';
    issues.push(SEGMENT_CODES.REJECT);
  }
  if (!issues.length) issues.push(SEGMENT_CODES.OK);
  const ok = action !== 'reject';
  return {
    version: SEGMENT_COMPRESS_VERSION,
    ok,
    action,
    now,
    segments: list.length,
    uniqueSegments: deduped.unique.length,
    keep,
    reencode,
    duplicates: deduped.duplicates,
    totalBytes,
    originalBytes: totalBytes + deduped.savedBytes,
    dedupeSavedBytes: deduped.savedBytes,
    projectedBytes: totalBytes,
    ratios: { dedupe: deduped.ratio },
    maxSegmentBytes,
    targetSegmentBytes,
    storage,
    storageWire: storageBudgetWire(storage),
    issues,
    evidence: {
      now,
      action,
      segments: list.length,
      uniqueSegments: deduped.unique.length,
      totalBytes,
      reencode: reencode.length,
      duplicates: deduped.duplicates.length,
      storageAction: storage.action,
    },
  };
}

/** 分片日记瘦身：每片只保留 journalKeepKeys，去掉 frames 明细；返回瘦身后的 entries 与字节估算。 */
export function compressJournalEntries(entries, options = {}) {
  const keepKeys = Array.isArray(options.keepKeys) && options.keepKeys.length ? options.keepKeys : SEGMENT_DEFAULTS.journalKeepKeys;
  const list = Array.isArray(entries) ? entries : [];
  const compacted = [];
  let removedBytes = 0;
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    const compact = {};
    for (const key of keepKeys) {
      if (entry[key] !== undefined) compact[key] = entry[key];
    }
    // 帧明细（frames）不保留，但把帧数与可播结论留成计数，避免丢信息。
    const frames = Array.isArray(entry.frames) ? entry.frames : [];
    if (frames.length) {
      compact.frames = frames.length;
      compact.frames_playable = frames.every((frame) => isPlainObject(frame) && Number(frame.durationMs) >= 0 && Number(frame.bytes) >= 0);
    }
    const before = safeJsonBytes(entry);
    const after = safeJsonBytes(compact);
    removedBytes += Math.max(0, before - after);
    compacted.push(compact);
  }
  return {
    entries: compacted,
    count: compacted.length,
    removedBytes,
    estimatedBytes: compacted.reduce((sum, entry) => sum + safeJsonBytes(entry), 0),
    ratio: list.length && removedBytes > 0 ? Number((removedBytes / (removedBytes + compacted.reduce((sum, entry) => sum + safeJsonBytes(entry), 0))).toFixed(4)) : 0,
  };
}

function safeJsonBytes(value) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return 0;
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
    return text.length;
  } catch {
    return 0;
  }
}

/**
 * 合成一份“视频存储证据”：把帧时间轴对账、转码预算、封装预算、段/配额决策合并。
 * 任一子分析缺省就跳过（不伪造字段）；子分析抛错也不影响其它部分（返回 partial 标记）。
 * @returns {object} evidence（键集稳定：frames/transcode/mux/storage/journal/partial）
 */
export function mergeVideoEvidence(parts = {}) {
  const source = isPlainObject(parts) ? parts : {};
  const evidence = {
    version: SEGMENT_COMPRESS_VERSION,
    frames: null,
    transcode: null,
    mux: null,
    storage: null,
    journal: null,
    partial: false,
  };
  const guard = (name, build) => {
    try {
      const value = build();
      evidence[name] = value == null ? null : value;
      return value;
    } catch {
      evidence.partial = true;
      evidence[name] = null;
      return null;
    }
  };
  guard('frames', () => (source.frames && typeof source.frames === 'object'
    ? {
      action: source.frames.action || 'accept',
      ok: source.frames.ok === true,
      counts: source.frames.counts || null,
      coverage: source.frames.coverage || null,
      severity: source.frames.severity || 'none',
    }
    : null));
  guard('transcode', () => (source.transcode && typeof source.transcode === 'object'
    ? {
      action: source.transcode.action || 'skip',
      chosen: source.transcode.chosen || null,
      cost: source.transcode.cost || null,
      savings: source.transcode.savings || null,
    }
    : null));
  guard('mux', () => (source.mux && typeof source.mux === 'object'
    ? {
      action: source.mux.action || 'ok',
      fragmentCount: source.mux.fragmentCount || 0,
      overheadBytes: source.mux.overhead ? source.mux.overhead.bytes : 0,
      keyframeMs: source.mux.keyframeMs || 0,
    }
    : null));
  guard('storage', () => (source.storage && typeof source.storage === 'object'
    ? {
      action: source.storage.action || 'keep',
      totalBytes: source.storage.totalBytes || 0,
      dedupeSavedBytes: source.storage.dedupeSavedBytes || 0,
      reencode: Array.isArray(source.storage.reencode) ? source.storage.reencode.length : 0,
      storage: source.storage.storageWire || null,
    }
    : null));
  guard('journal', () => (source.journal && typeof source.journal === 'object'
    ? {
      count: source.journal.count || 0,
      removedBytes: source.journal.removedBytes || 0,
      estimatedBytes: source.journal.estimatedBytes || 0,
      ratio: source.journal.ratio || 0,
    }
    : null));
  const subActions = [evidence.frames, evidence.transcode, evidence.mux, evidence.storage].filter(Boolean);
  evidence.ok = subActions.every((item) => item.ok !== false);
  evidence.actions = subActions.map((item) => String(item.action || ''));
  evidence.evidence = {
    partial: evidence.partial,
    frames: evidence.frames ? evidence.frames.action : null,
    transcode: evidence.transcode ? evidence.transcode.action : null,
    mux: evidence.mux ? evidence.mux.action : null,
    storage: evidence.storage ? evidence.storage.action : null,
    journal: evidence.journal ? evidence.journal.count : null,
  };
  return evidence;
}

/** 段压缩计划 → 协议字段（列表截断；键集稳定）。 */
export function segmentCompressionWire(plan, options = {}) {
  if (!isPlainObject(plan)) {
    return { version: SEGMENT_COMPRESS_VERSION, action: 'keep', ok: false, segments: 0 };
  }
  const limit = clampInt(options.maxListed, 0, 32, 6);
  return {
    version: SEGMENT_COMPRESS_VERSION,
    action: String(plan.action || 'keep'),
    ok: plan.ok === true,
    segments: plan.segments || 0,
    uniqueSegments: plan.uniqueSegments || 0,
    totalBytes: plan.totalBytes || 0,
    dedupeSavedBytes: plan.dedupeSavedBytes || 0,
    projectedBytes: plan.projectedBytes || 0,
    reencode: (Array.isArray(plan.reencode) ? plan.reencode : []).slice(0, limit),
    duplicates: (Array.isArray(plan.duplicates) ? plan.duplicates : []).slice(0, limit),
    storage: plan.storageWire || null,
    issues: Array.isArray(plan.issues) ? plan.issues.slice(0, 8) : [],
    text: describeSegmentCompression(plan),
  };
}

/** 一行日志：'视频分片压缩 keep：5 段/12.0MB（去重省 0，重编 0，存储 ok）'。 */
export function describeSegmentCompression(plan) {
  if (!isPlainObject(plan)) return '视频分片压缩 无';
  const toMb = (bytes) => (Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(1);
  return '视频分片压缩 ' + String(plan.action || 'keep') +
    '：' + (plan.segments || 0) + ' 段/' + toMb(plan.totalBytes) + 'MB' +
    '（去重省 ' + toMb(plan.dedupeSavedBytes) + '，重编 ' + (plan.reencode ? plan.reencode.length : 0) +
    '，存储 ' + String(plan.storage ? plan.storage.action : 'unknown') + '）';
}
