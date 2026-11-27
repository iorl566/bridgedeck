// lib/video-persist.js —— 视频原生持久化编排：分片日记 + 帧校验 + 录制预算 → 记录字段/恢复计划。
//
// 现状：video.js 已经把 state machine、seal、recovery、restore 分别接好了，但“录制过程中的
// 持久化”缺少一层编排：谁在什么时候把“第几片写完了/多少字节/hash/帧时间戳”落盘，崩溃后
// 用哪些事实重建，预算在哪一步闸门生效，帧校验结论写进哪个字段——散落在 video.js 的
// stopVideo/verifyVideo/recoverVideo 分支里，顺序不一致就会出现“记录 sealed 但没有日记证据”
// 或者“日记能恢复但记录没标 recovered”的裂缝。
//
// 本模块把这三块拼成一个**会话对象**（纯函数 + 可序列化），video.js 只负责调用与落盘：
//   createPersistenceSession()  —— 开会话（绑定 budget/degradeLevel/journal）；
//   persistPart()               —— 落一片：日记追加（幂等）+ 帧累积 + 预算评估 + 轮转建议；
//   sealPersistence()           —— 收尾：帧报告 + 日记密封 + 最终预算 → 记录字段；
//   analyzePersistence()        —— 只看会话：状态/日记/帧/预算/密封结论；
//   planPersistenceRecovery()   —— 恢复：日记重放 + 帧修复计划 + 声明 recovered/sealed；
//   persistenceRecordFields()   —— 落盘 patch（只加字段）；
//   persistenceFromRecord()     —— 从 record 反建会话（SW 重启后继续）；
//   summarizePersistence()/describePersistence()。
//
// 设计约束：
//   * 不新增 object store / 不改 video-store 版本：日记条目随 record patch 落盘（journal_parts）；
//   * 不伪造：帧校验不可播时明确 playable=false，恢复计划给 abort/trim 而不是假装修复；
//   * 预算沿用 video-budget 的语义（evaluateBudget/normalizeBudget/shouldRotateSegment）。

import {
  JOURNAL_DEFAULTS,
  appendEntry,
  createJournal,
  describeJournal,
  journalChainDigest,
  journalFromRecord,
  journalRecordFields,
  replayJournal,
  resumeJournal,
  sealJournal,
  summarizeJournal,
  validateJournal,
} from './video-journal.js';
import {
  FRAME_DEFAULTS,
  describeFrames,
  frameReport,
  framesFromRecord,
  normalizeFrame,
  planFrameRepair,
  summarizeFrames,
} from './video-frames.js';
import {
  VIDEO_BUDGET_DEFAULTS,
  evaluateBudget,
  normalizeBudget,
  shouldRotateSegment,
  summarizeBudgetEvaluation,
} from './video-budget.js';

export const PERSIST_VERSION = 1;

export const PERSIST_STATES = Object.freeze(['recording', 'sealing', 'sealed', 'recovered', 'degraded', 'failed']);

export const PERSIST_ACTIONS = Object.freeze(['continue', 'seal', 'resume', 'rebuild', 'restart', 'skip']);

export const PERSIST_CODES = Object.freeze({
  PART_DUPLICATE: 'persist-part-duplicate',
  PART_REJECTED: 'persist-part-rejected',
  PART_ORPHAN: 'persist-part-orphan',
  BUDGET_STOP: 'persist-budget-stop',
  SEGMENT_ROTATE: 'persist-segment-rotate',
  FRAMES_NOT_PLAYABLE: 'persist-frames-not-playable',
  FRAMES_STUCK: 'persist-frames-stuck',
  SEAL_FAILED: 'persist-seal-failed',
  RECOVERY_PARTIAL: 'persist-recovery-partial',
  RECOVERY_SEALED: 'persist-recovery-sealed',
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

function timeOf(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isoAt(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return new Date(number).toISOString();
  const date = typeof value === 'string' ? new Date(value) : null;
  if (date && Number.isFinite(date.getTime())) return date.toISOString();
  return new Date(fallback).toISOString();
}

/** 建会话：journal 由 video-journal 建，预算由 video-budget 归一。 */
export function createPersistenceSession(params = {}) {
  const recordingId = String(params.recordingId || '');
  if (!recordingId) throw new Error('持久化会话需要 recordingId');
  const now = Number.isFinite(Number(params.now)) ? Number(params.now) : Date.now();
  const budgetInput = params.budget && typeof params.budget === 'object' ? params.budget : {};
  const normalized = normalizeBudget(budgetInput, { base: VIDEO_BUDGET_DEFAULTS });
  const journal = createJournal({
    recordingId,
    now,
    mime: params.mime,
    mode: params.mode,
    budget: normalized.budget,
    degradeLevel: params.degradeLevel,
  });
  return {
    version: PERSIST_VERSION,
    recordingId,
    state: 'recording',
    mime: String(params.mime || ''),
    mode: String(params.mode || ''),
    startedAt: isoAt(params.startedAt != null ? params.startedAt : now, now),
    startedAtMs: timeOf(params.startedAt, now),
    journal,
    segments: [],
    frames: [],
    totalBytes: 0,
    budget: normalized.budget,
    budgetProblems: normalized.problems || [],
    lastEvaluation: null,
    rotateSuggestion: null,
    framesOverride: false,
    seal: null,
    recovery: null,
    evidence: [],
    updatedAt: isoAt(now, now),
  };
}

function addEvidence(session, code, detail) {
  const evidence = Array.isArray(session.evidence) ? session.evidence.slice() : [];
  evidence.push({ code, ...(detail || {}), at: Date.now() });
  return evidence.slice(-16);
}

/**
 * 落一片：日记追加 + 帧累积 + 预算评估 + 轮转建议。
 * @param {object} session
 * @param {{index?: number, bytes?: number, hash?: string, tMs?: number, durationMs?: number,
 *          frames?: Array<object>, keyframe?: boolean, key?: string, at?: number}} part
 * @returns {{session: object, ok: boolean, duplicate: boolean, code: string|null, budget: object|null, rotate: boolean, evidence: Array<object>}}
 */
export function persistPart(session, part, options = {}) {
  if (!session || typeof session !== 'object') throw new Error('persistPart 需要 session');
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  if (session.state === 'sealed' || session.state === 'failed') {
    return {
      session,
      ok: false,
      duplicate: false,
      code: PERSIST_CODES.PART_REJECTED,
      budget: null,
      rotate: false,
      evidence: addEvidence(session, PERSIST_CODES.PART_REJECTED, { reason: 'state-' + session.state }),
    };
  }
  const index = Math.max(0, intOr(part && part.index, session.segments.length));
  const bytes = Math.max(0, intOr(part && part.bytes, 0));
  const entry = {
    sequence: Array.isArray(session.journal && session.journal.entries) ? session.journal.entries.length : 0,
    index,
    bytes,
    hash: String(part && part.hash || ''),
    key: part && part.key,
    tMs: intOr(part && part.tMs, 0),
    durationMs: intOr(part && part.durationMs, 0),
    frames: Array.isArray(part && part.frames) ? part.frames.length : intOr(part && part.frames, 0),
    keyframe: Boolean(part && part.keyframe),
    at: now,
  };
  const appended = appendEntry(session.journal, entry, { now });
  if (!appended.accepted) {
    const code = appended.duplicate ? PERSIST_CODES.PART_DUPLICATE : PERSIST_CODES.PART_REJECTED;
    return {
      session: { ...session, evidence: addEvidence(session, code, { index, detail: appended.code }) },
      ok: false,
      duplicate: appended.duplicate === true,
      code,
      budget: null,
      rotate: false,
      evidence: addEvidence(session, code, { index }),
    };
  }
  // 帧累积：part.frames 优先；否则用单片元数据造一帧（保证帧校验至少有单调性事实）。
  let frames = Array.isArray(session.frames) ? session.frames.slice() : [];
  const providedFrames = Array.isArray(part && part.frames) ? part.frames : null;
  if (providedFrames && providedFrames.length) {
    for (const frame of providedFrames) frames.push(normalizeFrame(frame, frames.length));
  } else {
    frames.push(normalizeFrame({
      index: frames.length,
      pts: entry.tMs,
      durationMs: entry.durationMs,
      keyframe: entry.keyframe,
      bytes,
      checksum: entry.hash,
    }, frames.length));
  }
  const segments = (Array.isArray(session.segments) ? session.segments : []).concat([{
    index,
    bytes,
    hash: entry.hash,
    tMs: entry.tMs,
    frames: providedFrames ? providedFrames.length : 1,
  }]);
  const totalBytes = intOr(session.totalBytes, 0) + bytes;
  const elapsedMs = Math.max(0, now - (session.startedAtMs || now));
  const evaluation = evaluateBudget({ elapsedMs, totalBytes, segmentBytes: bytes }, session.budget);
  const rotate = shouldRotateSegment(bytes, session.budget);
  let evidence = Array.isArray(session.evidence) ? session.evidence.slice() : [];
  if (rotate.rotate) evidence = addEvidence({ ...session, evidence }, PERSIST_CODES.SEGMENT_ROTATE, { index, segmentBytes: bytes, limit: rotate.limit });
  if (evaluation && evaluation.action && evaluation.action !== 'continue') {
    evidence = addEvidence({ ...session, evidence }, PERSIST_CODES.BUDGET_STOP, {
      action: evaluation.action,
      budget_code: evaluation.code,
      totalBytes,
    });
  }
  const degraded = evaluation && evaluation.action && evaluation.action !== 'continue';
  return {
    session: {
      ...session,
      journal: appended.journal,
      segments,
      frames,
      totalBytes,
      state: degraded ? 'degraded' : session.state,
      lastEvaluation: evaluation,
      rotateSuggestion: rotate,
      budgetProblems: (session.budgetProblems || []).slice(0, 8),
      evidence,
      updatedAt: isoAt(now, now),
    },
    ok: true,
    duplicate: false,
    code: null,
    budget: evaluation,
    rotate: rotate.rotate === true,
    degraded,
    evidence,
  };
}

/**
 * 收尾：帧报告 + 日记密封 + 最终预算 → 记录字段。
 * @returns {{session: object, ok: boolean, journal: object, frames: object|null, errors: Array<object>, fields: object}}
 */
export function sealPersistence(session, options = {}) {
  if (!session || typeof session !== 'object') throw new Error('sealPersistence 需要 session');
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const report = frameReport(session.frames, options.frameOptions || {});
  const totalBytes = intOr(options.totalBytes, session.totalBytes);
  const sealed = sealJournal(session.journal, { now, totalBytes, requireEntries: session.segments.length > 0 });
  const elapsedMs = Math.max(0, now - (session.startedAtMs || now));
  const evaluation = evaluateBudget({ elapsedMs, totalBytes }, session.budget);
  let evidence = Array.isArray(session.evidence) ? session.evidence.slice() : [];
  if (!sealed.ok) evidence = addEvidence({ ...session, evidence }, PERSIST_CODES.SEAL_FAILED, { errors: sealed.errors.slice(0, 3) });
  if (!report.playable) evidence = addEvidence({ ...session, evidence }, PERSIST_CODES.FRAMES_NOT_PLAYABLE, { problem: report.classification.codes.slice(0, 3) });
  if (report.stuck) evidence = addEvidence({ ...session, evidence }, PERSIST_CODES.FRAMES_STUCK, { keyframes: report.keyframes.keyframes });
  const state = sealed.ok
    ? (report.playable ? 'sealed' : 'degraded')
    : 'failed';
  const nextSession = {
    ...session,
    state,
    journal: sealed.journal,
    totalBytes,
    lastEvaluation: evaluation,
    seal: {
      ok: sealed.ok,
      at: isoAt(now, now),
      digest: sealed.journal.seal ? sealed.journal.seal.digest : '',
      entries: sealed.journal.seal ? sealed.journal.seal.entries : 0,
      frames: report.validation.frames,
      playable: report.playable,
      state,
      errors: sealed.errors.slice(0, 6),
    },
    recovery: report.playable ? null : { action: 'abort', reason: PERSIST_CODES.FRAMES_NOT_PLAYABLE },
    evidence,
    updatedAt: isoAt(now, now),
  };
  return {
    session: nextSession,
    ok: sealed.ok && report.playable,
    journal: sealed.journal,
    frames: report,
    errors: sealed.errors.slice(),
    fields: persistenceRecordFields(nextSession),
  };
}

/** 只看会话的完整分析（verify/status 用）。 */
export function analyzePersistence(session, options = {}) {
  if (!session || typeof session !== 'object') {
    return { ok: false, state: 'missing', journal: null, frames: null, budget: null, reasons: ['会话不存在'] };
  }
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const journalSummary = summarizeJournal(session.journal);
  // 没有帧元数据的录制（tabCapture 直出 mp4）不做帧校验，frames 记为 null 而不是“不可播”。
  const hasFrames = Array.isArray(session.frames) && session.frames.length > 0;
  const report = options.frames === false || !hasFrames ? null : frameReport(session.frames, options.frameOptions || {});
  const elapsedMs = Math.max(0, now - (session.startedAtMs || now));
  const evaluation = evaluateBudget({ elapsedMs, totalBytes: session.totalBytes }, session.budget);
  const reasons = [];
  if (journalSummary && !journalSummary.valid) reasons.push('日记校验失败：' + (journalSummary.gaps.length ? '缺 ' + journalSummary.gaps.length + ' 片' : '结构错误'));
  if (report && !report.playable) reasons.push('帧校验不可播：' + (report.classification.codes[0] || 'unknown'));
  if (evaluation && evaluation.action && evaluation.action !== 'continue') reasons.push('预算状态：' + evaluation.action);
  return {
    ok: session.state !== 'failed',
    state: String(session.state || 'recording'),
    journal: journalSummary,
    frames: report,
    framesSummary: report ? summarizeFrames(report) : null,
    budget: evaluation ? summarizeBudgetEvaluation(evaluation) : null,
    totalBytes: intOr(session.totalBytes, 0),
    segments: Array.isArray(session.segments) ? session.segments.length : 0,
    evidence: (Array.isArray(session.evidence) ? session.evidence : []).slice(-8),
    reasons,
  };
}

/**
 * 恢复计划：日记重放 + 帧修复 + 声明 recovered/sealed。
 * @returns {{
 *   ok: boolean, action: string, state: string, journal: object, replay: object,
 *   frames: object|null, repair: object|null, reasons: string[], missing: number[],
 *   recordPatch: object,
 * }}
 */
export function planPersistenceRecovery(session, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const source = session && typeof session === 'object' ? session : null;
  if (!source) {
    const seeded = options.record ? persistenceFromRecord(options.record, { now }) : null;
    if (!seeded) {
      return { ok: false, action: 'skip', state: 'missing', journal: null, replay: null, frames: null, repair: null, reasons: ['没有会话也没有记录'], missing: [], recordPatch: {} };
    }
    return planPersistenceRecovery(seeded, options);
  }
  const replay = replayJournal({
    journal: source.journal,
    available: options.available || (Array.isArray(source.segments) ? source.segments.map((segment) => segment.index) : []),
    now,
    maxAgeMs: options.maxAgeMs,
    manifest: options.manifest,
  });
  const hasFrames = Array.isArray(source.frames) && source.frames.length > 0;
  const report = frameReport(source.frames, options.frameOptions || {});
  const repair = report.repair || planFrameRepair(source.frames, options.frameOptions || {});
  // 从 record 反建的会话没有帧元数据（不落盘帧明细）：此时只能采信记录里的 persist_frames_playable，
  // 不能因为“没帧可校验”就把可播录制标成 degraded。
  const playable = hasFrames
    ? report.playable
    : (source.framesPlayable === false ? false : true);
  const reasons = replay.reasons.slice();
  let action = replay.action;
  let state = 'recovered';
  if (action === 'sealed') {
    state = 'sealed';
  } else if (action === 'restart') {
    state = 'failed';
  } else if (action === 'rebuild' || action === 'resume') {
    state = playable ? 'recovered' : 'degraded';
    if (!playable) reasons.push('帧校验不可播：按 degraded 恢复（只保留可播前缀）');
  }
  const recordPatch = {
    persist_version: PERSIST_VERSION,
    persist_state: state,
    persist_action: action,
    persist_journal_entries: replay.entries,
    persist_journal_bytes: replay.bytes,
    persist_journal_missing: replay.missing.slice(0, 16),
    persist_frames: hasFrames ? report.validation.frames : intOr(source.framesRecorded, 0),
    persist_frames_playable: hasFrames
      ? report.playable
      : (source.framesPlayable === false ? false : (source.framesPlayable === true ? true : null)),
    persist_frames_digest: hasFrames ? report.validation.digest : String(source.framesDigest || ''),
    persist_frames_problems: hasFrames
      ? report.classification.codes.slice(0, 6)
      : (Array.isArray(source.framesProblems) ? source.framesProblems.slice(0, 6) : []),
    persist_repair: hasFrames && repair
      ? { action: repair.action, drop: repair.dropIndexes.slice(0, 16), trim_to_ms: repair.trimToMs }
      : null,
    persist_evidence: reasons.slice(-4),
  };
  return {
    ok: action !== 'restart',
    action,
    state,
    journal: summarizeJournal(source.journal),
    replay,
    frames: hasFrames ? summarizeFrames(report) : null,
    repair: hasFrames && repair
      ? { action: repair.action, steps: repair.steps, dropIndexes: repair.dropIndexes, trimToMs: repair.trimToMs, notes: repair.notes }
      : null,
    reasons,
    missing: replay.missing,
    recordPatch,
  };
}

/** 落盘字段：日记条目 + 帧摘要 + 会话状态（video.js 用 patchRecord 写回）。 */
export function persistenceRecordFields(session) {
  if (!session || typeof session !== 'object') return {};
  const journalFields = journalRecordFields(session.journal, { maxEntries: 256 });
  const report = frameReport(session.frames, { planRepair: false });
  const framesSummary = summarizeFrames(report);
  const seal = session.seal && typeof session.seal === 'object' ? session.seal : null;
  return {
    ...journalFields,
    persist_version: PERSIST_VERSION,
    persist_state: String(session.state || 'recording'),
    persist_segments: Array.isArray(session.segments) ? session.segments.length : 0,
    persist_bytes: intOr(session.totalBytes, 0),
    persist_frames: framesSummary ? framesSummary.frames : 0,
    persist_frames_playable: framesSummary ? framesSummary.playable === true : null,
    persist_frames_digest: framesSummary ? framesSummary.digest : '',
    persist_frames_fps: framesSummary ? framesSummary.fps : 0,
    persist_chain: journalChainDigest(session.journal),
    ...(seal ? {
      persist_seal_ok: seal.ok === true,
      persist_seal_digest: String(seal.digest || ''),
      persist_seal_frames: intOr(seal.frames, 0),
      persist_seal_playable: seal.playable === true,
    } : {}),
  };
}

/** 从 record 反建会话（SW 重启/恢复路径）。 */
export function persistenceFromRecord(record, options = {}) {
  const source = record && typeof record === 'object' ? record : null;
  if (!source) return null;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const journal = journalFromRecord(source, { now });
  if (!journal) return null;
  const frames = framesFromRecord(source);
  const segments = (Array.isArray(journal.entries) ? journal.entries : []).map((entry) => ({
    index: intOr(entry.index, 0),
    bytes: intOr(entry.bytes, 0),
    hash: entry.hash || '',
    tMs: intOr(entry.tMs, 0),
    frames: intOr(entry.frames, 0),
  }));
  const state = String(source.persist_state || (source.journal_state === 'sealed' ? 'sealed' : 'recording'));
  return {
    version: PERSIST_VERSION,
    recordingId: String(source.recordingId || source.id || journal.recordingId || ''),
    state: PERSIST_STATES.includes(state) ? state : 'recording',
    mime: String(source.mime || journal.mime || ''),
    mode: String(source.mode || journal.mode || ''),
    startedAt: isoAt(timeOf(source.startedAt, now), now),
    startedAtMs: timeOf(source.startedAt, now),
    journal: source.journal_state === 'sealed' ? { ...journal, state: 'sealed' } : journal,
    segments,
    frames,
    totalBytes: intOr(source.persist_bytes, intOr(journal.totalBytes, 0)),
    budget: normalizeBudget(source.budget || {}, { base: VIDEO_BUDGET_DEFAULTS }).budget,
    budgetProblems: [],
    lastEvaluation: null,
    rotateSuggestion: null,
    framesOverride: frames.length > 0,
    // 记录里只有帧摘要（帧明细不落盘）：从 record 反建时用它替代帧校验。
    framesRecorded: intOr(source.persist_frames, 0),
    framesPlayable: source.persist_frames_playable === true ? true : (source.persist_frames_playable === false ? false : null),
    framesDigest: String(source.persist_frames_digest || ''),
    framesProblems: Array.isArray(source.persist_frames_problems) ? source.persist_frames_problems.slice(0, 6) : [],
    seal: source.persist_seal_ok != null ? {
      ok: source.persist_seal_ok === true,
      at: source.sealed_at || null,
      digest: String(source.persist_seal_digest || ''),
      entries: intOr(source.persist_journal_entries, 0),
      frames: intOr(source.persist_seal_frames, 0),
      playable: source.persist_seal_playable === true,
      state,
      errors: [],
    } : null,
    recovery: null,
    evidence: [{ code: 'persist-restored-from-record', at: Date.now() }],
    updatedAt: isoAt(now, now),
    recoveredFrom: 'record',
  };
}

/** 把恢复出来的条目并回会话（幂等）。 */
export function restorePersistenceParts(session, parts, options = {}) {
  if (!session || typeof session !== 'object') return { session, accepted: [], duplicates: [], changed: false };
  const resumed = resumeJournal(session.journal, parts, options);
  if (!resumed.changed) {
    return { session, accepted: [], duplicates: resumed.duplicates, changed: false };
  }
  const segments = (Array.isArray(session.segments) ? session.segments.slice() : []);
  for (const entry of resumed.journal.entries) {
    if (!segments.some((segment) => intOr(segment.index, -1) === intOr(entry.index, -2))) {
      segments.push({ index: intOr(entry.index, 0), bytes: intOr(entry.bytes, 0), hash: entry.hash || '', tMs: intOr(entry.tMs, 0), frames: intOr(entry.frames, 0) });
    }
  }
  return {
    session: {
      ...session,
      journal: resumed.journal,
      segments: segments.sort((a, b) => a.index - b.index),
      totalBytes: intOr(resumed.journal.totalBytes, session.totalBytes),
      state: session.state === 'failed' ? 'recovered' : session.state,
      updatedAt: isoAt(options.now, Date.now()),
    },
    accepted: resumed.accepted,
    duplicates: resumed.duplicates,
    changed: true,
  };
}

/** 协议 wire。 */
export function summarizePersistence(session, options = {}) {
  if (!session || typeof session !== 'object') return null;
  const analysis = analyzePersistence(session, { frames: options.frames !== false, now: options.now });
  return {
    version: PERSIST_VERSION,
    state: analysis.state,
    segments: analysis.segments,
    bytes: analysis.totalBytes,
    journal: analysis.journal,
    frames: analysis.framesSummary,
    budget: analysis.budget,
    seal: session.seal ? {
      ok: session.seal.ok === true,
      digest: String(session.seal.digest || ''),
      playable: session.seal.playable === true,
      frames: intOr(session.seal.frames, 0),
    } : null,
    evidence: analysis.evidence,
    reasons: analysis.reasons,
  };
}

/** 一行日志：'持久化 sealed 12 片 / 24.5MB / 帧可播 / 日记 chain=abc…'。 */
export function describePersistence(session) {
  if (!session || typeof session !== 'object') return '录制持久化 无';
  const mb = (intOr(session.totalBytes, 0) / (1024 * 1024)).toFixed(1);
  const journalText = describeJournal(session.journal);
  const framesText = Array.isArray(session.frames) && session.frames.length
    ? describeFrames(frameReport(session.frames, { planRepair: false }))
    : '帧 无';
  return '录制持久化 ' + String(session.state || 'recording') + ' ' +
    (Array.isArray(session.segments) ? session.segments.length : 0) + ' 片 / ' + mb + 'MB；' +
    journalText + '；' + framesText;
}

/** 会话是否已到“必须停”的预算点（运行时轮询用）。 */
export function persistenceStopReason(session) {
  if (!session || typeof session !== 'object') return null;
  const evaluation = session.lastEvaluation;
  if (evaluation && evaluation.action && evaluation.action !== 'continue' && evaluation.stop_reason) {
    return { reason: evaluation.stop_reason, code: evaluation.code || null, action: evaluation.action };
  }
  return null;
}

/** 诊断：把“日记/帧/预算”三块的自检合成一条结论（verifyVideo 用）。 */
export function persistenceDiagnostics(session) {
  const journalValidation = validateJournal(session && session.journal, { requireEntries: false, requireSealed: false, allowGaps: true });
  const hasFrames = Boolean(session && Array.isArray(session.frames) && session.frames.length);
  const report = frameReport(hasFrames ? session.frames : [], { planRepair: false });
  // 从 record 反建的会话没有帧明细：采信记录里的持久化摘要，而不是把“没帧可校验”判成不可播。
  const framesPlayable = hasFrames
    ? report.playable
    : (session && session.framesPlayable === false ? false : (session && session.framesPlayable === true ? true : null));
  return {
    version: PERSIST_VERSION,
    journalOk: journalValidation.ok,
    journalErrors: journalValidation.errors.slice(0, 6),
    journalGaps: journalValidation.gaps.slice(0, 16),
    framesOk: hasFrames ? report.ok : null,
    framesPlayable,
    frameProblems: hasFrames
      ? (report.validation.problems || []).slice(0, 6)
      : (session && Array.isArray(session.framesProblems) ? session.framesProblems.slice(0, 6) : []),
    budgetAction: session && session.lastEvaluation ? session.lastEvaluation.action : null,
    // 只有“日记结构好 + 帧没有明确不可播 + 预算没被判定必须停”才算完整。
    healthy: journalValidation.ok && framesPlayable !== false && !(session && session.lastEvaluation && session.lastEvaluation.action === 'stop'),
  };
}

export const PERSIST_STATE_LIST = PERSIST_STATES;
export const JOURNAL_LIMITS = JOURNAL_DEFAULTS;
export const FRAME_LIMITS = FRAME_DEFAULTS;
