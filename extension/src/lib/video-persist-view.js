// lib/video-persist-view.js —— 录制持久化的“结果视图”层（纯函数，video.js 的结果字段都从这里来）。
//
// 背景：video.js 是 0.3.0 的录制编排入口，职责已经很多（tabCapture/offscreen/debugger/降级/
// 恢复）。第十批-D 要把“分片日记 + 帧校验 + 预算”的证据接进 start/stop/verify/recover/status，
// 如果直接把视图拼装写在 video.js 里，会同时踩两件事：
//   1) extension/src 有 1100 行/文件的复杂度预算（architecture-guards.test.mjs）；
//   2) 视图逻辑（字段取舍、截断、record 缺字段时的回退）无法在 Node 单测里覆盖。
//
// 所以这里把“纯视图”集中起来，video.js 只保留 IO（chrome.storage / IndexedDB / offscreen）：
//   persistenceBrief()          —— 一次会话的精简证据（start/status 用）；
//   persistSummaryOf()          —— 落盘记录里的 persist_* 摘要（list/status 回读用）；
//   persistRecordFragments()    —— 把 offscreen 的 fragments 反建成日记条目（幂等）；
//   sealPersistenceFromFragments() —— stop 收尾：反建→密封→记录字段（一次调用）；
//   persistenceVerifyView()     —— verify 的持久化诊断视图（含 record 缺字段回退）；
//   persistenceRecoveryView()   —— recover 的恢复结论视图（含 record_patch）。

import { frameReport } from './video-frames.js';
import { summarizeJournal } from './video-journal.js';
import {
  analyzePersistence,
  persistenceDiagnostics,
  persistPart,
  planPersistenceRecovery,
  persistenceFromRecord,
  sealPersistence,
} from './video-persist.js';
// 第十一批-E：视图层只加字段地接四块证据（帧时间轴 / 转码 / 封装 / 分片存储压缩）。
import { reconcileVideoFrames, videoFrameWire, planVideoFrameRepair } from './video-frame-reconcile.js';
import { planVideoTranscode, transcodeBudgetWire } from './video-transcode-budget.js';
import { planVideoMux, muxBudgetWire } from './video-mux-budget.js';
import {
  planSegmentCompression,
  segmentCompressionWire,
  compressJournalEntries,
  mergeVideoEvidence,
} from './video-segment-compress.js';

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

/** 从帧/分片时间戳估 fps（中位帧间隔；帧不足 2 条时回落 30）。 */
function estimateFps(frames, segments) {
  const starts = [];
  for (const frame of Array.isArray(frames) ? frames : []) {
    const value = Number(frame && (frame.pts != null ? frame.pts : (frame.tMs != null ? frame.tMs : frame.startMs)));
    if (Number.isFinite(value)) starts.push(value);
  }
  if (starts.length < 2) {
    for (const segment of Array.isArray(segments) ? segments : []) {
      const value = Number(segment && segment.tMs);
      if (Number.isFinite(value)) starts.push(value);
    }
  }
  starts.sort((left, right) => left - right);
  const deltas = [];
  for (let index = 1; index < starts.length; index += 1) {
    const delta = starts[index] - starts[index - 1];
    if (delta > 0) deltas.push(delta);
  }
  if (!deltas.length) return 30;
  deltas.sort((left, right) => left - right);
  const median = deltas[Math.floor(deltas.length / 2)] || 0;
  if (!(median > 0)) return 30;
  return Math.max(0.1, Math.min(240, 1000 / median));
}

/** 会话时长：优先帧尾，其次分片尾，最后 options.durationMs。 */
function durationOfSession(session, frames, segments, options) {
  const fromOption = Number(options.durationMs);
  if (Number.isFinite(fromOption) && fromOption > 0) return Math.round(fromOption);
  let duration = 0;
  for (const frame of frames) {
    const start = Number(frame && (frame.pts != null ? frame.pts : (frame.tMs != null ? frame.tMs : frame.startMs)));
    const span = Number(frame && (frame.durationMs != null ? frame.durationMs : frame.duration));
    if (Number.isFinite(start) && Number.isFinite(span)) duration = Math.max(duration, start + span);
  }
  for (const segment of segments) {
    const start = Number(segment && segment.tMs);
    const span = Number(segment && segment.durationMs);
    if (Number.isFinite(start) && Number.isFinite(span)) duration = Math.max(duration, start + span);
  }
  return Math.max(0, Math.round(duration));
}

/**
 * 第十一批-E：视频持久化会话的派生证据（帧时间轴 / 转码 / 封装 / 存储 / 日记瘦身）。
 * 纯读取 session 已有字段；任一块失败只置 null，不抛。
 */
function videoEvidenceOf(session, options = {}) {
  const frames = Array.isArray(session && session.frames) ? session.frames : [];
  const segments = Array.isArray(session && session.segments) ? session.segments : [];
  const durationMs = durationOfSession(session, frames, segments, options);
  const fps = Number(options.fps) > 0 ? Number(options.fps) : estimateFps(frames, segments);
  const width = Math.max(0, intOr(options.width, session && session.width));
  const height = Math.max(0, intOr(options.height, session && session.height));
  const result = { frameReport: null, frameRepair: null, mux: null, storage: null, journal: null, transcode: null };
  const guard = (key, build) => {
    try {
      result[key] = build();
    } catch {
      result[key] = null;
    }
  };
  guard('frameReport', () => reconcileVideoFrames({ frames, durationMs, fps }));
  guard('frameRepair', () => (result.frameReport ? planVideoFrameRepair(result.frameReport) : null));
  guard('mux', () => planVideoMux({
    durationMs,
    fps,
    payloadBytes: Number(session && session.totalBytes) || 0,
    ...(options.mux && typeof options.mux === 'object' ? options.mux : {}),
  }));
  guard('storage', () => planSegmentCompression({
    segments,
    usedBytes: Number(session && session.totalBytes) || 0,
    ...(options.storage && typeof options.storage === 'object' ? options.storage : {}),
  }));
  guard('journal', () => compressJournalEntries(
    session && session.journal && Array.isArray(session.journal.entries) ? session.journal.entries : [],
  ));
  guard('transcode', () => (width > 0 && height > 0 && durationMs > 0
    ? planVideoTranscode({
      width,
      height,
      fps,
      durationMs,
      sourceBytes: Number(session && session.totalBytes) || 0,
      needTranscode: options.needTranscode === true,
      ...(options.transcode && typeof options.transcode === 'object' ? options.transcode : {}),
    })
    : null));
  return result;
}

/** 派生证据 → 精简 wire（start/stop/status 与 verify 共用；列表截到 2 条）。 */
function videoEvidenceWire(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const wire = {
    frames: evidence.frameReport ? videoFrameWire(evidence.frameReport, { maxListed: 2 }) : null,
    mux: evidence.mux ? muxBudgetWire(evidence.mux, { maxListed: 2 }) : null,
    storage: evidence.storage ? segmentCompressionWire(evidence.storage, { maxListed: 2 }) : null,
    repair: evidence.frameRepair || null,
    journal: evidence.journal
      ? { count: evidence.journal.count, removedBytes: evidence.journal.removedBytes, estimatedBytes: evidence.journal.estimatedBytes }
      : null,
  };
  if (evidence.transcode) wire.transcode = transcodeBudgetWire(evidence.transcode, { maxListed: 2 });
  return wire;
}

/**
 * 一次持久化会话的精简证据（只读 session 已有字段，不触发 IO）。
 * 录制中的 status、start 的返回值、stop 的收尾都用它。
 */
export function persistenceBrief(session) {
  if (!session || typeof session !== 'object') return null;
  const frames = Array.isArray(session.frames) ? session.frames : [];
  const report = frames.length ? frameReport(frames, { planRepair: false }) : null;
  const journal = summarizeJournal(session.journal, { maxListed: 4 });
  // 第十一批-E：帧时间轴/封装/存储证据（只加字段；老会话没有 segments 时给稳定降级值）。
  const evidence = videoEvidenceOf(session, {});
  const evidenceWire = videoEvidenceWire(evidence);
  return {
    state: String(session.state || 'recording'),
    segments: Array.isArray(session.segments) ? session.segments.length : 0,
    bytes: Number(session.totalBytes) || 0,
    journal_state: journal ? journal.state : null,
    journal_entries: journal ? journal.entries : 0,
    journal_chain: journal ? String(journal.chain || '').slice(0, 16) : '',
    journal_valid: journal ? journal.valid === true : null,
    frames: frames.length,
    frames_playable: report ? report.playable === true : null,
    frames_fps: report ? report.fps.fps : 0,
    seal_ok: session.seal ? session.seal.ok === true : null,
    seal_digest: session.seal ? String(session.seal.digest || '').slice(0, 16) : null,
    // 第十一批-E 新增：帧级对账 / 封装预算 / 分片存储预算 / 重编计划（没有数据时为 null）。
    frame_axis: evidenceWire ? evidenceWire.frames : null,
    mux_budget: evidenceWire ? evidenceWire.mux : null,
    segment_budget: evidenceWire ? evidenceWire.storage : null,
    video_evidence: evidenceWire,
  };
}

/** 落盘记录里的持久化摘要（list/status 回读；老记录没有 persist_* 时返回 null）。 */
export function persistSummaryOf(item) {
  if (!item || typeof item !== 'object' || !item.persist_state) return null;
  return {
    state: String(item.persist_state),
    segments: Number(item.persist_segments) || 0,
    bytes: Number(item.persist_bytes) || 0,
    journal_entries: Number(item.persist_journal_entries) || 0,
    journal_valid: Array.isArray(item.persist_journal_missing) ? item.persist_journal_missing.length === 0 : null,
    frames: Number(item.persist_frames) || 0,
    frames_playable: item.persist_frames_playable === true ? true : (item.persist_frames_playable === false ? false : null),
    frames_digest: String(item.persist_frames_digest || ''),
    seal_ok: item.persist_seal_ok === true ? true : (item.persist_seal_ok === false ? false : null),
  };
}

/**
 * 把 offscreen 落库的 fragments 反建成日记条目（幂等：同 index 只记一次）。
 * 这是“崩溃前只有 blob 记录、没有 per-part 回调”时的原生持久化兜底。
 */
export function persistRecordFragments(session, fragments, now) {
  if (!session || typeof session !== 'object') return { session, accepted: 0 };
  let current = session;
  let accepted = 0;
  for (const fragment of Array.isArray(fragments) ? fragments : []) {
    const result = persistPart(current, {
      index: Number(fragment && fragment.index) || 0,
      bytes: Number(fragment && fragment.bytes) || 0,
      hash: String((fragment && (fragment.sha256 || fragment.hash)) || ''),
      tMs: Number(fragment && (fragment.tMs != null ? fragment.tMs : fragment.startMs)) || 0,
      durationMs: Number(fragment && fragment.durationMs) || 0,
      frames: fragment && fragment.frames,
      keyframe: Boolean(fragment && fragment.keyframe),
    }, { now });
    current = result.session;
    if (result.ok) accepted += 1;
  }
  return { session: current, accepted };
}

/**
 * stop 收尾：fragments → 日记 → 密封 → 记录字段。返回纯数据，调用方负责 patchRecord。
 * @returns {{session: object, summary: object|null, fields: object, accepted: number}}
 */
export function sealPersistenceFromFragments(session, fragments, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const rebuilt = persistRecordFragments(session, fragments, now);
  const sealed = sealPersistence(rebuilt.session, {
    now,
    totalBytes: intOr(options.totalBytes, rebuilt.session.totalBytes),
  });
  return {
    session: sealed.session,
    summary: persistenceBrief(sealed.session),
    fields: sealed.fields,
    accepted: rebuilt.accepted,
    ok: sealed.ok === true,
  };
}

/**
 * verify 的持久化视图：从 record 反建会话后给诊断结论。
 * record 没有 journal_parts / persist_* 时返回 {ok:false, state:'unknown', error} 而不是伪造。
 */
export function persistenceVerifyView(record, options = {}) {
  const source = record && typeof record === 'object' ? record : null;
  if (!source) return null;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  try {
    const session = persistenceFromRecord({ ...source, recordingId: source.recordingId || source.id || '' }, { now });
    if (!session) return null;
    // 第十一批-E：verify 视图只加字段地带“帧时间轴/转码/封装/存储”证据（record 缺尺寸时转码为 null）。
    const evidence = videoEvidenceOf(session, {
      durationMs: options.durationMs != null ? options.durationMs : source.durationMs,
      fps: options.fps != null ? options.fps : source.fps,
      width: options.width || source.width,
      height: options.height || source.height,
      needTranscode: options.needTranscode === true,
    });
    const wire = videoEvidenceWire(evidence);
    return {
      ...analyzePersistence(session, { now, frames: options.frames !== false }),
      diagnostics: persistenceDiagnostics(session),
      frame_axis: wire ? wire.frames : null,
      repair: evidence.frameRepair || null,
      transcode_budget: wire ? wire.transcode || null : null,
      mux_budget: wire ? wire.mux : null,
      segment_budget: wire ? wire.storage : null,
      journal_compact: wire ? wire.journal : null,
      video_evidence: mergeVideoEvidence({
        frames: evidence.frameReport,
        transcode: evidence.transcode,
        mux: evidence.mux,
        storage: evidence.storage,
        journal: evidence.journal,
      }),
    };
  } catch (error) {
    return { ok: false, state: 'unknown', error: String((error && error.message) || error) };
  }
}

/**
 * recover 的持久化视图：规划恢复 + 组装结果字段（含写回记录的 persist_* patch）。
 * @returns {{session: object, view: object, recordPatch: object, accepted: Array<number>}}
 */
export function persistenceRecoveryView(session, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const planned = planPersistenceRecovery(session, {
    now,
    available: options.available,
    manifest: options.manifest,
    maxAgeMs: options.maxAgeMs,
    frameOptions: options.frameOptions,
  });
  const analysis = session && typeof session === 'object'
    ? analyzePersistence(session, { now, frames: options.frames !== false })
    : null;
  const view = {
    ...(analysis || {}),
    recovery_action: planned.action,
    recovery_state: planned.state,
    recovery_missing: (Array.isArray(planned.missing) ? planned.missing : []).slice(0, 16),
    record_patch: planned.recordPatch,
  };
  if (planned.repair) view.repair = planned.repair;
  if (planned.reasons && planned.reasons.length) view.reasons = planned.reasons.slice(-4);
  return {
    session,
    view,
    recordPatch: planned.recordPatch || {},
    accepted: planned.accepted || [],
  };
}
