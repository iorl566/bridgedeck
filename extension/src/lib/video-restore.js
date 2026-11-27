// extension/src/lib/video-restore.js —— 崩溃恢复的“策略层”：partial 重组、坏片重取、过期清理、重组后对账。
//
// 分工（不重复实现已有逻辑）：
//   - video-manifest.planSegmentRecovery：给定 manifest + 已落盘分片，算“可播放前缀”，
//     并把缺片/截断/校验和不匹配逐条记成 problem；
//   - opfs-encoded-store：真正的 OPFS 读写与 Blob 组装（offscreen 侧执行）；
//   - 本模块：在恢复计划之上做**策略决策**，回答运行时真正需要的问题：
//       1) 这一条坏片是“重取一次”还是“直接拒绝/丢弃”？重取预算还剩几次？
//       2) 前后分片怎么拼（按 offset 的有序 range 列表），能否形成连续可播放前缀；
//       3) 恢复出的字节数与计划是否一致（对账，防止 offscreen 组装/截断出错）；
//       4) 长期残留的 OPFS 分片目录哪些该清、哪些还要留着等恢复（过期清理策略）。
//
// 运行时消费点：
//   - video.recover（video.js recoverVideo）：扫描候选后为每条候选算 restore plan
//     （重取/拒绝/range 证据），恢复成功后再用 reconcileAssembled 对账；
//   - video.prune（video.js videoPrune）：用 stalePartsPlan 清理过期/不可恢复的残留分片目录。

import { planSegmentRecovery, summarizeManifest } from './video-manifest.js';
import { VIDEO_RESTORE_CODES } from './video-codes.js';
// 第十一批-E：恢复摘要只加字段地带“封装预算 / 分片存储预算”证据。
import { planVideoMux, muxBudgetWire } from './video-mux-budget.js';
import { planSegmentCompression, segmentCompressionWire } from './video-segment-compress.js';

export { VIDEO_RESTORE_CODES };

export const VIDEO_RESTORE_VERSION = 1;
export const RESTORE_STRATEGIES = Object.freeze(['complete', 'prefix', 'salvaged', 'sealed', 'none']);
export const RESTORE_NEXT_ACTIONS = Object.freeze(['reassemble', 'refetch', 'skip', 'fail']);

export const DEFAULT_MAX_REFETCH_ATTEMPTS = 2;
export const DEFAULT_STALE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SEALED_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_KEEP_RECOVERABLE_MS = 72 * 60 * 60 * 1000;

const CHECKSUM_RE = /^[0-9a-f]{64}$/;

function problem(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function checksumOf(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return CHECKSUM_RE.test(text) ? text : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dedupe(problems) {
  const seen = new Set();
  const out = [];
  for (const item of problems) {
    if (!item || typeof item !== 'object') continue;
    const key = [item.code, item.severity, item.index == null ? '' : item.index, item.scope || ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 归一化 OPFS 分片描述（容忍 blob/size/sequence 等历史形状）。 */
export function normalizeRestorePart(part) {
  if (!part || typeof part !== 'object') return null;
  const index = Number(part.index != null ? part.index : part.sequence);
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const sizeSource = part.bytes != null ? part.bytes : (part.size != null ? part.size : (part.blob && part.blob.size));
  const bytes = finiteNonNegative(sizeSource);
  return {
    index,
    bytes,
    position: Number.isFinite(Number(part.position)) ? Number(part.position) : null,
    checksum: checksumOf(part.checksum != null ? part.checksum : part.sha256),
  };
}

/**
 * 单片重取决策。
 * @param {{index:number, expectedBytes?:number, expectedChecksum?:string, actualBytes?:number,
 *          actualChecksum?:string, reason?:string, attempts?:number, canRefetch?:boolean,
 *          maxAttempts?:number, policy?:'strict'|'lenient'}} input
 */
export function decidePartRefetch(input = {}) {
  const index = Number(input.index);
  const attempts = finiteNonNegative(input.attempts);
  const maxAttempts = Math.max(0, Math.round(Number(input.maxAttempts != null ? input.maxAttempts : DEFAULT_MAX_REFETCH_ATTEMPTS)));
  const canRefetch = input.canRefetch !== false;
  const expectedBytes = finiteNonNegative(input.expectedBytes);
  const actualBytes = finiteNonNegative(input.actualBytes);
  const expectedChecksum = checksumOf(input.expectedChecksum);
  const actualChecksum = checksumOf(input.actualChecksum);
  const reason = String(input.reason || '');
  const decision = {
    index,
    reason,
    attempts,
    maxAttempts,
    expectedBytes,
    actualBytes,
    expectedChecksum,
    actualChecksum,
    action: 'reuse',
    code: null,
    evidence: null,
  };
  if (reason === 'checksum_mismatch') {
    if (canRefetch && attempts < maxAttempts) {
      return {
        ...decision,
        action: 'refetch',
        code: VIDEO_RESTORE_CODES.REFETCH,
        evidence: { code: VIDEO_RESTORE_CODES.REFETCH, index, attempt: attempts + 1, maxAttempts, expectedChecksum, actualChecksum },
      };
    }
    return {
      ...decision,
      action: 'deny',
      code: VIDEO_RESTORE_CODES.REFETCH_EXHAUSTED,
      evidence: { code: VIDEO_RESTORE_CODES.REFETCH_EXHAUSTED, index, attempts, maxAttempts, canRefetch },
    };
  }
  if (reason === 'missing' || reason === 'truncated') {
    if (canRefetch && attempts < maxAttempts) {
      return {
        ...decision,
        action: 'refetch',
        code: VIDEO_RESTORE_CODES.REFETCH,
        evidence: { code: VIDEO_RESTORE_CODES.REFETCH, index, attempt: attempts + 1, maxAttempts, expectedBytes, actualBytes },
      };
    }
    return {
      ...decision,
      action: 'deny',
      code: VIDEO_RESTORE_CODES.DENIED,
      evidence: { code: VIDEO_RESTORE_CODES.DENIED, index, reason, attempts, maxAttempts, canRefetch },
    };
  }
  return decision;
}

function attemptsOf(options, index) {
  const map = options && options.attempts && typeof options.attempts === 'object' ? options.attempts : null;
  if (!map) return 0;
  return finiteNonNegative(map[index] != null ? map[index] : map[String(index)]);
}

function canRefetchIndex(options, index) {
  if (options.refetch === false) return false;
  if (Array.isArray(options.refetch)) return options.refetch.map(Number).includes(Number(index));
  return options.refetch !== false;
}

/**
 * 为一条恢复候选规划 partial 重组策略。
 *
 * @param {object} manifest 完整 v2 manifest
 * @param {Array} parts OPFS 已落盘分片（index/bytes/checksum/position）
 * @param {{recordingId?:string, now?:number, refetch?:boolean|number[], maxAttempts?:number,
 *          attempts?:object, checksumPolicy?:'strict'|'lenient', salvageTruncated?:boolean,
 *          skipSealed?:boolean, force?:boolean}} options
 */
export function planPartialReassembly(manifest, parts, options = {}) {
  const normalizedParts = (Array.isArray(parts) ? parts : []).map(normalizeRestorePart).filter(Boolean);
  const attempts = {};
  for (const part of normalizedParts) attempts[part.index] = attemptsOf(options, part.index);
  const recordingId = String(options.recordingId || (manifest && manifest.recordingId) || '');
  const base = planSegmentRecovery(manifest, normalizedParts, { recordingId });
  const problems = base.problems.slice();
  const keep = [];
  const refetch = [];
  const denied = [];
  const ranges = [];
  let assembledBytes = 0;
  let droppedBytes = 0;

  if (isPlainObject(manifest) && manifest.sealed === true && options.skipSealed !== false && options.force !== true) {
    problems.push(problem(VIDEO_RESTORE_CODES.SEALED_SKIP, 'info', 'manifest 已封存，跳过重组（数据已落库）', { recordingId }));
    return finishRestorePlan({
      recordingId,
      manifest,
      strategy: 'sealed',
      nextAction: 'skip',
      keep,
      refetch,
      denied,
      ranges,
      assembledBytes: 0,
      droppedBytes: 0,
      base,
      problems,
    }, options);
  }

  // 重复序号：同一 index 出现多次时选“校验和/字节数与 manifest 匹配优先”的那份。
  const byIndex = new Map();
  for (const part of normalizedParts) {
    const list = byIndex.get(part.index) || [];
    list.push(part);
    byIndex.set(part.index, list);
  }
  const duplicated = [...byIndex.entries()].filter(([, list]) => list.length > 1).map(([index, list]) => ({ index, count: list.length }));
  for (const item of duplicated) {
    problems.push(problem(VIDEO_RESTORE_CODES.DUPLICATE_PART, 'warning', '同一分片序号出现多份（取最匹配的一份）', { index: item.index, count: item.count }));
  }

  const segments = Array.isArray(manifest && manifest.segments) ? manifest.segments : [];
  let stopped = false;
  for (let position = 0; position < segments.length; position += 1) {
    const segment = segments[position] || {};
    const index = Number.isSafeInteger(Number(segment.index)) ? Number(segment.index) : position;
    const expectedBytes = finiteNonNegative(segment.bytes);
    const expectedChecksum = checksumOf(segment.checksum);
    const candidates = byIndex.get(index) || [];
    if (stopped) {
      droppedBytes += expectedBytes;
      continue;
    }
    if (!candidates.length) {
      pushedRefetch(refetch, denied, problems, { index, expectedBytes, expectedChecksum, actualBytes: 0, reason: 'missing' }, options);
      droppedBytes += expectedBytes;
      stopped = true;
      continue;
    }
    const part = pickBestPart(candidates, expectedBytes, expectedChecksum);
    const actualBytes = part.bytes;
    const actualChecksum = part.checksum;
    if (actualBytes <= 0) {
      pushedRefetch(refetch, denied, problems, { index, expectedBytes, expectedChecksum, actualBytes, checksum: actualChecksum, reason: 'truncated' }, options);
      droppedBytes += expectedBytes;
      stopped = true;
      continue;
    }
    if (expectedChecksum && actualChecksum && expectedChecksum !== actualChecksum) {
      const decision = pushedRefetch(refetch, denied, problems, { index, expectedBytes, expectedChecksum, actualBytes, actualChecksum, reason: 'checksum_mismatch' }, options);
      droppedBytes += expectedBytes;
      if (decision.action !== 'refetch' && String(options.checksumPolicy || 'strict') === 'lenient' && keep.length > 0) {
        // lenient：坏片之后的内容不可信，但前缀仍可播放 → 保留前缀、终止扫描。
        problems.push(problem(VIDEO_RESTORE_CODES.PREFIX, 'warning', '校验和不匹配且不允许重取，仅保留其前的前缀', { index, kept: keep.length }));
      }
      stopped = true;
      continue;
    }
    if (actualBytes < expectedBytes) {
      const decision = pushedRefetch(refetch, denied, problems, { index, expectedBytes, expectedChecksum, actualBytes, actualChecksum, reason: 'truncated' }, options);
      problems.push(problem(VIDEO_RESTORE_CODES.TRUNCATED, 'warning', '分片被截断', { index, expected: expectedBytes, actual: actualBytes, action: decision.action }));
      if (options.salvageTruncated === true && decision.action !== 'refetch') {
        keep.push({ index, bytes: actualBytes, truncated: true });
        assembledBytes += actualBytes;
        droppedBytes += expectedBytes - actualBytes;
        stopped = true;
        continue;
      }
      droppedBytes += expectedBytes;
      stopped = true;
      continue;
    }
    if (actualBytes > expectedBytes) {
      problems.push(problem(VIDEO_RESTORE_CODES.TRUNCATED, 'info', '分片实际字节大于 manifest 记录（按 manifest 裁剪）', { index, expected: expectedBytes, actual: actualBytes }));
    }
    keep.push({ index, bytes: expectedBytes, truncated: false });
    assembledBytes += expectedBytes;
  }

  const unlisted = normalizedParts.filter((part) => !segments.some((segment, position) => {
    const index = Number.isSafeInteger(Number(segment && segment.index)) ? Number(segment.index) : position;
    return index === part.index;
  }));
  if (unlisted.length) {
    problems.push(problem(VIDEO_RESTORE_CODES.UNLISTED_PART, 'warning', '存在 manifest 未登记的分片（已忽略）', {
      count: unlisted.length,
      indexes: unlisted.slice(0, 8).map((part) => part.index),
    }));
  }

  let offset = 0;
  for (const item of keep) {
    ranges.push({ index: item.index, start: offset, end: offset + item.bytes, bytes: item.bytes, ...(item.truncated ? { truncated: true } : {}) });
    offset += item.bytes;
  }

  const totalSegments = segments.length;
  const complete = totalSegments > 0 && keep.length === totalSegments && refetch.length === 0 && denied.length === 0;
  const strategy = complete ? 'complete' : (keep.length > 0 ? (keep.some((item) => item.truncated) ? 'salvaged' : 'prefix') : 'none');
  const nextAction = keep.length > 0 ? 'reassemble' : (refetch.length > 0 ? 'refetch' : 'fail');
  if (keep.length > 0) {
    problems.push(problem(VIDEO_RESTORE_CODES.PREFIX, complete ? 'info' : 'warning', complete ? '全部分片可重组' : '可重组可播放前缀', {
      segments: keep.length,
      totalSegments,
      bytes: assembledBytes,
    }));
  } else {
    problems.push(problem(VIDEO_RESTORE_CODES.IMPOSSIBLE, 'error', '没有可重组的分片前缀', { refetch: refetch.length, denied: denied.length }));
  }

  return finishRestorePlan({
    recordingId,
    manifest,
    strategy,
    nextAction,
    keep,
    refetch,
    denied,
    ranges,
    assembledBytes,
    droppedBytes,
    base,
    problems,
    complete,
  }, options);
}

function pickBestPart(candidates, expectedBytes, expectedChecksum) {
  if (candidates.length === 1) return candidates[0];
  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    let score = 0;
    if (expectedChecksum && candidate.checksum === expectedChecksum) score += 4;
    if (expectedBytes > 0 && candidate.bytes === expectedBytes) score += 2;
    if (candidate.checksum) score += 1;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function pushedRefetch(refetch, denied, problems, input, options) {
  const decision = decidePartRefetch({
    ...input,
    attempts: attemptsOf(options, input.index),
    maxAttempts: options.maxAttempts,
    canRefetch: canRefetchIndex(options, input.index),
  });
  if (decision.action === 'refetch') {
    refetch.push({
      index: decision.index,
      attempt: decision.attempts + 1,
      maxAttempts: decision.maxAttempts,
      expectedBytes: decision.expectedBytes,
      expectedChecksum: decision.expectedChecksum,
      reason: decision.reason,
    });
    problems.push(decision.evidence);
  } else if (decision.action === 'deny') {
    denied.push({
      index: decision.index,
      attempts: decision.attempts,
      maxAttempts: decision.maxAttempts,
      expectedBytes: decision.expectedBytes,
      reason: decision.reason,
      code: decision.code,
    });
    problems.push(decision.evidence);
  }
  return decision;
}

function finishRestorePlan(input, options) {
  const problems = dedupe(input.problems);
  const plan = {
    version: VIDEO_RESTORE_VERSION,
    ok: input.strategy !== 'none',
    recordingId: input.recordingId,
    strategy: input.strategy,
    nextAction: input.nextAction,
    sealed: Boolean(input.manifest && input.manifest.sealed === true),
    completeness: input.strategy === 'complete' ? 'complete' : (input.strategy === 'sealed' ? 'sealed' : (input.strategy === 'none' ? 'failed' : 'partial')),
    segments: input.keep.length,
    totalSegments: Array.isArray(input.manifest && input.manifest.segments) ? input.manifest.segments.length : 0,
    assembledBytes: finiteNonNegative(input.assembledBytes),
    droppedBytes: finiteNonNegative(input.droppedBytes),
    keep: input.keep.slice(0, 64),
    ranges: input.ranges.slice(0, 64),
    refetch: input.refetch.slice(0, 16),
    denied: input.denied.slice(0, 16),
    problems,
    evidence: problems.map((item) => ({
      code: item.code,
      severity: item.severity,
      message: item.message,
      ...(item.index != null ? { index: item.index } : {}),
    })),
    base: input.base
      ? {
        recovered: input.base.recovered === true,
        completeness: input.base.completeness,
        bytes: finiteNonNegative(input.base.bytes),
        reason: input.base.reason,
      }
      : null,
    manifest: isPlainObject(input.manifest) ? summarizeManifest(input.manifest) : null,
    at: finiteNonNegative(options && options.now) || 0,
  };
  return { ...plan, summary: summarizeRestore(plan) };
}

/**
 * 有序 range → 组装计划：校验 offset 连续（中间不能有洞），给出总字节数。
 * offscreen 组装 Blob 或测试里模拟组装都用它。
 */
export function assembleRangePlan(plan) {
  const ranges = Array.isArray(plan && plan.ranges) ? plan.ranges : [];
  const gaps = [];
  let expected = 0;
  const ordered = [];
  for (const range of ranges) {
    const start = finiteNonNegative(range.start);
    const bytes = finiteNonNegative(range.bytes);
    if (start !== expected) gaps.push({ index: range.index, start, expected });
    ordered.push({ index: Number(range.index) || 0, start, end: start + bytes, bytes });
    expected = start + bytes;
  }
  const totalBytes = finiteNonNegative(plan && plan.assembledBytes) || expected;
  return {
    ok: gaps.length === 0,
    ranges: ordered,
    totalBytes,
    gaps,
    segments: ordered.length,
    evidence: gaps.length
      ? [{ code: VIDEO_RESTORE_CODES.ASSEMBLED_MISMATCH, severity: 'error', message: 'range 不连续', gaps }]
      : [{ code: VIDEO_RESTORE_CODES.ASSEMBLED_OK, severity: 'info', message: 'range 连续', bytes: totalBytes }],
  };
}

/**
 * 重组结果对账（恢复后立刻做）：字节数必须等于计划，提供 checksum 时再比一次。
 * @param {object} plan planPartialReassembly 的结果
 * @param {{bytes?:number, checksum?:string, sha256?:string, parts?:Array}} assembled
 */
export function reconcileAssembled(plan, assembled = {}) {
  const expectedBytes = finiteNonNegative(plan && plan.assembledBytes);
  const actualBytes = finiteNonNegative(assembled.bytes);
  const problems = [];
  if (plan && plan.strategy === 'sealed') {
    return {
      ok: true,
      status: 'skipped',
      expectedBytes,
      actualBytes,
      deltaBytes: 0,
      problems,
      evidence: [{ code: VIDEO_RESTORE_CODES.ASSEMBLED_UNVERIFIED, severity: 'info', message: 'manifest 已封存，无需重组对账' }],
    };
  }
  if (expectedBytes !== actualBytes) {
    problems.push(problem(VIDEO_RESTORE_CODES.ASSEMBLED_MISMATCH, 'error', '重组字节数与计划不一致', { expected: expectedBytes, actual: actualBytes, delta: actualBytes - expectedBytes }));
  }
  const checksum = checksumOf(assembled.checksum != null ? assembled.checksum : assembled.sha256);
  const expectedChecksum = checksumOf(plan && plan.assembledChecksum);
  if (checksum && expectedChecksum && checksum !== expectedChecksum) {
    problems.push(problem(VIDEO_RESTORE_CODES.ASSEMBLED_MISMATCH, 'error', '重组内容摘要与计划不一致', { expected: expectedChecksum, actual: checksum }));
  }
  if (!checksum) {
    problems.push(problem(VIDEO_RESTORE_CODES.ASSEMBLED_UNVERIFIED, 'info', '未提供重组内容摘要，只对账字节数'));
  }
  const ok = problems.every((item) => item.severity !== 'error');
  return {
    ok,
    status: ok ? 'match' : 'mismatch',
    expectedBytes,
    actualBytes,
    deltaBytes: actualBytes - expectedBytes,
    segments: Array.isArray(plan && plan.keep) ? plan.keep.length : 0,
    problems,
    evidence: problems.map((item) => ({ code: item.code, severity: item.severity, message: item.message })),
  };
}

/**
 * 过期/残留分片清理计划（video.prune 用；真正的删除由调用方执行并逐条核对）。
 * @param {Array} candidates scanEncodedRecordings() 的形状：{recordingId, manifest, summary, parts, plan}
 * @param {{now?:number, ttlMs?:number, sealedTtlMs?:number, keepRecoverableMs?:number, maxParts?:number}} options
 */
export function stalePartsPlan(candidates, options = {}) {
  const now = finiteNonNegative(options.now) || Date.now();
  const ttlMs = Math.max(0, Math.round(Number(options.ttlMs != null ? options.ttlMs : DEFAULT_STALE_TTL_MS)));
  const sealedTtlMs = Math.max(0, Math.round(Number(options.sealedTtlMs != null ? options.sealedTtlMs : DEFAULT_SEALED_TTL_MS)));
  const keepRecoverableMs = Math.max(ttlMs, Math.round(Number(options.keepRecoverableMs != null ? options.keepRecoverableMs : DEFAULT_KEEP_RECOVERABLE_MS)));
  const remove = [];
  const keep = [];
  const evidence = [];
  const list = Array.isArray(candidates) ? candidates : [];
  for (const candidate of list) {
    if (!candidate || typeof candidate !== 'object') continue;
    const recordingId = String(candidate.recordingId || '');
    if (!recordingId) continue;
    const manifest = isPlainObject(candidate.manifest) ? candidate.manifest : null;
    const sealed = Boolean(manifest && manifest.sealed === true);
    const lastActivityMs = lastActivityOf(candidate);
    const ageMs = lastActivityMs > 0 ? Math.max(0, now - lastActivityMs) : -1;
    const parts = Array.isArray(candidate.parts) ? candidate.parts : [];
    const bytes = parts.reduce((sum, part) => sum + finiteNonNegative(part && part.bytes), 0);
    const recoverable = Boolean(candidate.plan && candidate.plan.recovered === true);
    const entry = { recordingId, sealed, recoverable, ageMs, parts: parts.length, bytes, lastActivityMs };
    const decide = (decision, reason, code, message) => {
      const item = { ...entry, decision, reason };
      if (decision === 'remove') remove.push(item);
      else keep.push(item);
      evidence.push({ code, severity: decision === 'remove' ? 'warning' : 'info', message, recordingId, ageMs, parts: entry.parts, bytes });
    };
    if (!manifest) {
      decide('remove', 'no_manifest', VIDEO_RESTORE_CODES.STALE_UNRECOVERABLE, '没有 manifest 的残留分片，无法恢复', {});
      continue;
    }
    if (!parts.length) {
      decide('remove', 'empty', VIDEO_RESTORE_CODES.STALE_UNRECOVERABLE, '没有分片的空目录', {});
      continue;
    }
    if (ageMs < 0) {
      decide('keep', 'unknown_age', VIDEO_RESTORE_CODES.STALE_GRACE, '缺少最后活动时间，保守保留', {});
      continue;
    }
    if (sealed) {
      if (ageMs > sealedTtlMs) decide('remove', 'sealed', VIDEO_RESTORE_CODES.STALE_SEALED, '已封存且超过残留时限（数据已落库）', {});
      else decide('keep', 'sealed_recent', VIDEO_RESTORE_CODES.STALE_GRACE, '已封存但仍在残留时限内', {});
      continue;
    }
    if (!recoverable) {
      if (ageMs > ttlMs) decide('remove', 'unrecoverable', VIDEO_RESTORE_CODES.STALE_UNRECOVERABLE, '未封存且不可恢复，超过 TTL', {});
      else decide('keep', 'unrecoverable_recent', VIDEO_RESTORE_CODES.STALE_GRACE, '不可恢复但未超过 TTL，保留待查', {});
      continue;
    }
    if (ageMs > keepRecoverableMs) decide('remove', 'expired', VIDEO_RESTORE_CODES.STALE_EXPIRED, '可恢复但超过最长保留期，清理', {});
    else if (ageMs > ttlMs) decide('keep', 'recoverable_grace', VIDEO_RESTORE_CODES.STALE_GRACE, '可恢复且超过 TTL 但仍在宽限期，保留等 recover', {});
    else decide('keep', 'recoverable_recent', VIDEO_RESTORE_CODES.STALE_GRACE, '可恢复且未过期', {});
  }
  const removedBytes = remove.reduce((sum, item) => sum + item.bytes, 0);
  return {
    ok: true,
    now,
    policy: { ttlMs, sealedTtlMs, keepRecoverableMs },
    scanned: list.length,
    remove,
    keep,
    removedParts: remove.reduce((sum, item) => sum + item.parts, 0),
    removedBytes,
    keptBytes: keep.reduce((sum, item) => sum + item.bytes, 0),
    evidence: evidence.slice(0, 32),
    counts: {
      remove: remove.length,
      keep: keep.length,
      sealed: list.filter((item) => item && item.manifest && item.manifest.sealed === true).length,
      recoverable: list.filter((item) => item && item.plan && item.plan.recovered === true).length,
    },
  };
}

function lastActivityOf(candidate) {
  const manifest = isPlainObject(candidate.manifest) ? candidate.manifest : {};
  const summary = isPlainObject(candidate.summary) ? candidate.summary : {};
  const values = [manifest.updatedAt, manifest.sealedAt, manifest.createdAt, summary.lastAtMs, summary.createdAt]
    .map((value) => finiteNonNegative(value))
    .filter((value) => value > 0);
  if (!values.length) return 0;
  return Math.max(...values);
}

/** 对外紧凑摘要（video.recover 返回的 restore 字段用）。 */
export function summarizeRestore(plan) {
  if (!plan || typeof plan !== 'object') return null;
  // 第十一批-E：只加派生的封装/存储预算（子分析失败只给 null，不影响既有字段）。
  let mux = null;
  let storage = null;
  try {
    const durationMs = plan.manifest && Number(plan.manifest.durationMs) > 0 ? Number(plan.manifest.durationMs) : 0;
    const assembledBytes = finiteNonNegative(plan.assembledBytes);
    mux = muxBudgetWire(planVideoMux({ durationMs, payloadBytes: assembledBytes }));
    storage = segmentCompressionWire(planSegmentCompression({
      segments: (Array.isArray(plan.keep) ? plan.keep : []).map((item) => ({
        index: item.index,
        bytes: item.bytes,
        durationMs: 0,
      })),
      usedBytes: assembledBytes,
    }));
  } catch {
    mux = null;
    storage = null;
  }
  return {
    strategy: String(plan.strategy || 'none'),
    nextAction: String(plan.nextAction || 'fail'),
    completeness: String(plan.completeness || 'failed'),
    segments: finiteNonNegative(plan.segments),
    totalSegments: finiteNonNegative(plan.totalSegments),
    assembledBytes: finiteNonNegative(plan.assembledBytes),
    droppedBytes: finiteNonNegative(plan.droppedBytes),
    refetch: Array.isArray(plan.refetch) ? plan.refetch.length : 0,
    denied: Array.isArray(plan.denied) ? plan.denied.length : 0,
    sealed: plan.sealed === true,
    issues: Array.isArray(plan.problems) ? plan.problems.length : 0,
    mux_budget: mux,
    segment_budget: storage,
  };
}

/** 清理计划摘要（video.prune 返回的 cleanup 字段用）。 */
export function summarizeStaleCleanup(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    scanned: finiteNonNegative(result.scanned),
    remove: Array.isArray(result.remove) ? result.remove.length : 0,
    keep: Array.isArray(result.keep) ? result.keep.length : 0,
    removedParts: finiteNonNegative(result.removedParts),
    removedBytes: finiteNonNegative(result.removedBytes),
    keptBytes: finiteNonNegative(result.keptBytes),
    ...(Array.isArray(result.remove) && result.remove.length
      ? { reasons: [...new Set(result.remove.map((item) => item.reason))] }
      : {}),
  };
}

/** 记录补丁字段（video.recover 二次审计后用；只新增 restore_* 字段）。 */
export function restoreRecordFields(plan, reconcile = null) {
  if (!plan || plan.strategy === 'sealed') return {};
  const summary = summarizeRestore(plan);
  return {
    restore: {
      ...summary,
      ...(reconcile
        ? { reconcile: { ok: reconcile.ok === true, status: reconcile.status, expectedBytes: reconcile.expectedBytes, actualBytes: reconcile.actualBytes } }
        : {}),
      evidence: Array.isArray(plan.evidence) ? plan.evidence.slice(-8) : [],
    },
  };
}
