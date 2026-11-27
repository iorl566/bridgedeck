// src/lib/record-exec-replay.js —— 回放前置的最后一公里：可恢复的回放会话 + 实跑对账。
//
// lib/record-exec-plan.js 的 dry-run 已经给出“计划会发生什么”，record-program.preflightReplay
// 给出“能不能开始”。真实回放还需要三件事，本模块补齐：
//
//   1) 回放会话（beginReplay / ack / checkpoint / restoreSession / resumeReplay）：
//      - 把 plan/preflight 的结果变成游标可推进的会话；每个批次一次 ack，游标只前进不后退；
//      - 幂等 token 继承 preflightReplay 的 token，knownTokens 命中时直接拒绝重复回放；
//      - checkpoint 只保存游标 + 已 ack 的计数 + 轨迹 digest（可 JSON 化、可跨进程恢复），
//        恢复时用 digest 校验 checkpoint 没被改过；
//      - cancelReplay 在会话内标记取消（scope 内 abort/skip/continue 语义与执行器一致），
//        剩余批次记成 skipped 并封进证据。
//
//   2) 实跑对账（finishReplay / reconcileReplay）：
//      - 逐批次比较“计划状态 vs 实跑 ack 状态”；drift（多跑/少跑/状态不同/重试次数不同）
//        单独列出，不把“回放完成”误报成“与计划一致”；
//      - 计划里没有出现的 ack（index 越界/重复）算 protocol drift；
//      - 输出 ok/status/evidence，供 CLI/诊断/录制导出使用。
//
//   3) 证据（replayEvidence / verifyReplayEvidence）：
//      - 会话结束后封存为哈希链证书（与 record-exec-trace 的轨迹 digest 关联），
//        事后能回答“这次回放是不是按那份计划跑的、有没有被取消、对不上几处”。
//
// 约定：
//   - 纯内存 + 可注入时钟，不碰 chrome/DOM，不真的执行动作（ack 由调用方在真正执行后上报）；
//   - 结构化返回、不抛异常；幂等 token 是“防止同一程序重复回放”的软保护，不是安全凭据；
//   - 不 import 本模块反向依赖：record-exec-plan / record-program 都不 import 它（无环）。

import { preflightReplay, programFingerprint } from '../record-program.js';
import { stableHash } from '../record-steps.js';
import {
  BATCH_KINDS,
  buildStepGraph,
  planStepBatches,
  summarizeStepGraph,
} from './record-step-graph.js';
import {
  TRACE_STATUSES,
  diffTraces,
  sealTrace,
  summarizeTrace,
  verifyTrace,
} from './record-exec-trace.js';
import { EXEC_CODES, EXEC_STATUS } from './record-exec-plan.js';

export const REPLAY_SESSION_VERSION = 1;

export const REPLAY_STATUS = Object.freeze({
  READY: 'ready',
  RUNNING: 'running',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  ABORTED: 'aborted',
  FAILED: 'failed',
  STALE: 'stale',
});

export const REPLAY_CODES = Object.freeze({
  REPLAY_EMPTY: 'EXEC_EMPTY',
  REPLAY_BLOCKED: 'EXEC_REPLAY_BLOCKED',
  REPLAY_DUPLICATE: 'EXEC_REPLAY_DUPLICATE',
  REPLAY_DONE: 'REPLAY_SESSION_DONE',
  REPLAY_CANCELLED: 'EXEC_CANCELLED',
  REPLAY_BAD_ARG: 'REPLAY_SESSION_BAD_ARG',
  REPLAY_ACK_UNKNOWN: 'REPLAY_ACK_UNKNOWN_BATCH',
  REPLAY_ACK_DUPLICATE: 'REPLAY_ACK_DUPLICATE',
  REPLAY_ACK_ORDER: 'REPLAY_ACK_OUT_OF_ORDER',
  REPLAY_CHECKPOINT: 'REPLAY_CHECKPOINT_MISMATCH',
  REPLAY_DRIFT: 'REPLAY_DRIFT',
  REPLAY_EVIDENCE: 'REPLAY_EVIDENCE_MISMATCH',
});

export const REPLAY_LIMITS = Object.freeze({
  maxBatches: 4000,
  maxAcks: 8000,
  maxDrift: 64,
  maxCheckpoints: 16,
  maxSessions: 32,
});

/** 进程内会话序号：仅用于生成可读且不冲突的 sessionId（不参与安全判定）。 */
let sessionSequence = 0;

const ACK_STATUSES = Object.freeze([
  TRACE_STATUSES.OK,
  TRACE_STATUSES.SKIPPED,
  TRACE_STATUSES.BLOCKED,
  TRACE_STATUSES.CANCELLED,
  TRACE_STATUSES.RETRY,
  TRACE_STATUSES.FAILED,
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function clip(text, limit) {
  return String(text == null ? '' : text).slice(0, limit);
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/** 计划批次 → 稳定的回放步骤描述（不包含参数值；参数在 ack 时按 index 定位）。 */
function planBatches(stepsOrProgram, options = {}) {
  const steps = isPlainObject(stepsOrProgram) && Array.isArray(stepsOrProgram.nodes) ? stepsOrProgram.nodes : stepsOrProgram;
  const graph = buildStepGraph(steps, isPlainObject(options.graph) ? options.graph : {});
  const batches = planStepBatches(graph);
  return {
    graph,
    batches: batches.slice(0, REPLAY_LIMITS.maxBatches).map((batch, index) => ({
      seq: index + 1,
      kind: batch.kind,
      ...(batch.index != null ? { index: batch.index } : {}),
      ...(batch.ref ? { ref: batch.ref } : {}),
      ...(batch.node ? { ref: batch.node.ref, nodeIndex: batch.node.index, method: batch.node.method, humanGate: batch.node.humanGate === true } : {}),
      ...(batch.groupId ? { groupId: batch.groupId, forkIndex: batch.forkIndex, joinIndex: batch.joinIndex, waitFor: batch.waitFor, arms: batch.arms.map((arm) => arm.steps.map((stepValue) => stepValue.ref)) } : {}),
      ...(batch.options ? { branchOptions: batch.options.map((option) => ({ label: option.label, to: option.to })) } : {}),
      expected: 'ok',
    })),
  };
}

function plannedStepIndexes(batch) {
  if (!batch) return [];
  if (batch.kind === BATCH_KINDS.PARALLEL) {
    const indexes = [];
    for (const arm of (batch.arms || [])) for (const ref of arm) indexes.push(ref);
    return indexes;
  }
  if (batch.nodeIndex != null) return [batch.nodeIndex];
  if (batch.index != null) return [batch.index];
  return [];
}

function sessionDigest(session) {
  return 'rs' + stableHash(JSON.stringify({
    v: REPLAY_SESSION_VERSION,
    sessionId: session.sessionId,
    fingerprint: session.fingerprint,
    token: session.token,
    cursor: session.cursor,
    acks: session.acks.map((ack) => [ack.seq, ack.status, ack.attempts]),
    cancelled: session.cancelled === true,
    status: session.status,
  }));
}

function makeSession(plan, options) {
  sessionSequence = (sessionSequence + 1) % 0xffffff;
  const base = {
    version: REPLAY_SESSION_VERSION,
    sessionId: 'replay-' + sessionSequence.toString(36) + '-' + stableHash(String(options.tag || '') + '|' + nowOf(options)),
    status: REPLAY_STATUS.READY,
    startedAt: nowOf(options),
    finishedAt: 0,
    fingerprint: options.fingerprint || '',
    token: options.token || '',
    cursor: 0,
    total: plan.batches.length,
    plan: plan.batches,
    graph: summarizeStepGraph(plan.graph),
    acks: [],
    counts: { ok: 0, skipped: 0, blocked: 0, cancelled: 0, retry: 0, failed: 0 },
    retries: 0,
    cancelled: false,
    cancel: null,
    checkpoints: [],
    drift: [],
    lastAckAt: 0,
  };
  return base;
}

function nowOf(options) {
  return typeof options.now === 'function' ? options.now() : num(options.at) || Date.now();
}

/**
 * 创建回放会话：先做回放前置（preflight v2 语义中的线性部分），再生成可 ack 的批次计划。
 * @param {Array|object} stepsOrProgram
 * @param {{knownTokens?:string[], allowDuplicate?:boolean, tag?:string, now?:()=>number,
 *          allowNonIdempotent?:boolean, requireHumanValues?:boolean, graph?:object}} [options]
 */
export function beginReplay(stepsOrProgram, options = {}) {
  const source = isPlainObject(options) ? options : {};
  const plan = planBatches(stepsOrProgram, source);
  const preflight = preflightReplay(
    isPlainObject(stepsOrProgram) && Array.isArray(stepsOrProgram.nodes) ? stepsOrProgram : stepsOrProgram,
    {
      ...source,
      allowNonIdempotent: source.allowNonIdempotent === true,
      requireHumanValues: source.requireHumanValues,
    },
  );
  const token = preflight.token || ('rp-' + stableHash(JSON.stringify(plan.batches.map((batch) => [batch.kind, batch.ref || batch.index]))));
  const session = makeSession(plan, { ...source, token, fingerprint: preflight.fingerprint });
  if (!plan.batches.length) {
    session.status = REPLAY_STATUS.ABORTED;
    session.blocked = { code: REPLAY_CODES.REPLAY_EMPTY, message: '没有可回放的批次' };
    return { ok: false, code: REPLAY_CODES.REPLAY_EMPTY, status: session.status, session, preflight };
  }
  if (!preflight.ok) {
    session.status = REPLAY_STATUS.ABORTED;
    session.blocked = {
      code: REPLAY_CODES.REPLAY_BLOCKED,
      blockers: (preflight.blockers || []).slice(0, 16),
      duplicate: preflight.duplicate === true,
    };
    return {
      ok: false,
      code: preflight.duplicate === true ? REPLAY_CODES.REPLAY_DUPLICATE : REPLAY_CODES.REPLAY_BLOCKED,
      status: session.status,
      duplicate: preflight.duplicate === true,
      session,
      preflight,
    };
  }
  session.status = REPLAY_STATUS.RUNNING;
  return {
    ok: true,
    code: null,
    token,
    session,
    preflight: {
      token: preflight.token,
      fingerprint: preflight.fingerprint,
      blockers: (preflight.blockers || []).length,
      warnings: (preflight.warnings || []).length,
      requiresHuman: (preflight.requiresHuman || []).length,
    },
  };
}

/**
 * 上报一个批次的真实执行结果（真正执行后由调用方 ack）。
 * @param {object} session
 * @param {{seq?:number, index?:number, status?:string, attempts?:number, durationMs?:number,
 *          note?:string, at?:number}} ack
 */
export function ackBatch(session, ack = {}) {
  if (!session || !Array.isArray(session.acks)) {
    return { ok: false, code: REPLAY_CODES.REPLAY_BAD_ARG, error: 'session 缺失或结构不对' };
  }
  if (session.status === REPLAY_STATUS.CANCELLED) {
    return { ok: false, code: REPLAY_CODES.REPLAY_CANCELLED, status: session.status, cursor: session.cursor };
  }
  if (session.status !== REPLAY_STATUS.RUNNING) {
    return { ok: false, code: REPLAY_CODES.REPLAY_DONE, status: session.status, cursor: session.cursor };
  }
  const seq = integer(ack.seq, session.cursor + 1);
  if (seq < 1 || seq > session.plan.length) {
    return { ok: false, code: REPLAY_CODES.REPLAY_ACK_UNKNOWN, seq, total: session.plan.length, cursor: session.cursor };
  }
  if (seq <= session.cursor) {
    return { ok: false, code: REPLAY_CODES.REPLAY_ACK_DUPLICATE, seq, cursor: session.cursor };
  }
  if (seq !== session.cursor + 1) {
    return { ok: false, code: REPLAY_CODES.REPLAY_ACK_ORDER, seq, expected: session.cursor + 1, cursor: session.cursor };
  }
  const status = ACK_STATUSES.includes(ack.status) ? ack.status : TRACE_STATUSES.OK;
  const attempts = Math.max(1, integer(ack.attempts, 1));
  const entry = {
    seq,
    status,
    attempts,
    durationMs: nonNegative(ack.durationMs),
    at: num(ack.at) || nowOf({ now: Date.now }),
    note: clip(ack.note || '', 120),
  };
  session.acks.push(entry);
  session.cursor = seq;
  session.counts[status] = (session.counts[status] || 0) + 1;
  if (attempts > 1) session.retries += attempts - 1;
  session.lastAckAt = entry.at;
  if (session.acks.length > REPLAY_LIMITS.maxAcks) session.acks.splice(0, session.acks.length - REPLAY_LIMITS.maxAcks);
  if (session.cursor >= session.total) {
    session.status = REPLAY_STATUS.COMPLETED;
    session.finishedAt = entry.at;
  }
  session.digest = sessionDigest(session);
  return {
    ok: true,
    seq,
    status,
    cursor: session.cursor,
    total: session.total,
    remaining: Math.max(0, session.total - session.cursor),
    sessionStatus: session.status,
    digest: session.digest,
  };
}

/**
 * 保存 checkpoint（游标 + 计数 + digest）：可 JSON 化，跨进程恢复时校验 digest。
 */
export function checkpointReplay(session, options = {}) {
  if (!session || !Array.isArray(session.acks)) {
    return { ok: false, code: REPLAY_CODES.REPLAY_BAD_ARG, error: 'session 缺失' };
  }
  const digest = sessionDigest(session);
  const checkpoint = {
    version: REPLAY_SESSION_VERSION,
    sessionId: session.sessionId,
    fingerprint: session.fingerprint,
    token: session.token,
    status: session.status,
    cursor: session.cursor,
    total: session.total,
    counts: { ...session.counts },
    retries: session.retries,
    digest,
    at: num(options.at) || Date.now(),
    acks: session.acks.slice(-REPLAY_LIMITS.maxAcks),
  };
  session.checkpoints.push(checkpoint);
  if (session.checkpoints.length > REPLAY_LIMITS.maxCheckpoints) session.checkpoints.shift();
  return { ok: true, checkpoint, digest };
}

/**
 * 从 checkpoint 恢复会话：重算 digest，确认 checkpoint 未被改动后才恢复。
 */
export function restoreSession(checkpoint, options = {}) {
  if (!checkpoint || typeof checkpoint !== 'object' || !Array.isArray(checkpoint.acks)) {
    return { ok: false, code: REPLAY_CODES.REPLAY_BAD_ARG, error: 'checkpoint 缺失或结构不对' };
  }
  const restoredStatus = [REPLAY_STATUS.RUNNING, REPLAY_STATUS.COMPLETED, REPLAY_STATUS.CANCELLED, REPLAY_STATUS.ABORTED].includes(checkpoint.status)
    ? checkpoint.status
    : (checkpoint.cursor >= checkpoint.total ? REPLAY_STATUS.COMPLETED : REPLAY_STATUS.RUNNING);
  const session = {
    version: REPLAY_SESSION_VERSION,
    sessionId: String(checkpoint.sessionId || ''),
    status: restoredStatus,
    startedAt: num(options.at) || Date.now(),
    finishedAt: 0,
    fingerprint: String(checkpoint.fingerprint || ''),
    token: String(checkpoint.token || ''),
    cursor: integer(checkpoint.cursor, 0),
    total: integer(checkpoint.total, 0),
    plan: Array.isArray(options.plan) ? options.plan : [],
    graph: options.graph || null,
    acks: checkpoint.acks.map((ack) => ({ ...ack })),
    counts: isPlainObject(checkpoint.counts) ? { ...checkpoint.counts } : {},
    retries: nonNegative(checkpoint.retries),
    cancelled: false,
    cancel: null,
    checkpoints: [],
    drift: [],
    lastAckAt: 0,
    restored: true,
  };
  const digest = sessionDigest(session);
  if (checkpoint.digest && digest !== checkpoint.digest) {
    return { ok: false, code: REPLAY_CODES.REPLAY_CHECKPOINT, error: 'checkpoint digest 不匹配（被改动）', expected: checkpoint.digest, actual: digest, session };
  }
  const planAck = planBatchesRestore(session, options);
  if (!planAck.ok) return { ...planAck, session };
  session.digest = digest;
  return { ok: true, session, digest, cursor: session.cursor, total: session.total };
}

function planBatchesRestore(session, options) {
  if (Array.isArray(options.plan)) {
    session.plan = options.plan.slice(0, REPLAY_LIMITS.maxBatches);
    return { ok: true };
  }
  if (options.stepsOrProgram !== undefined) {
    const plan = planBatches(options.stepsOrProgram, options);
    session.plan = plan.batches;
    session.graph = summarizeStepGraph(plan.graph);
    return { ok: true };
  }
  return { ok: true, missingPlan: true };
}

/** 取消回放会话：scope 语义与 record-exec-plan 的取消域一致（abort/skip/continue）。 */
export function cancelReplay(session, reason = 'cancelled', options = {}) {
  if (!session || !Array.isArray(session.acks)) {
    return { ok: false, code: REPLAY_CODES.REPLAY_BAD_ARG, error: 'session 缺失' };
  }
  if (session.status === REPLAY_STATUS.COMPLETED || session.status === REPLAY_STATUS.CANCELLED) {
    return { ok: false, code: REPLAY_CODES.REPLAY_DONE, status: session.status };
  }
  const mode = ['abort', 'skip', 'continue'].includes(options.mode) ? options.mode : 'abort';
  session.cancelled = true;
  session.cancel = { reason: clip(reason, 120), mode, scope: clip(options.scope || '', 48), at: num(options.at) || Date.now(), cursor: session.cursor };
  if (mode === 'continue') {
    return { ok: true, mode, status: session.status, cursor: session.cursor, cancelled: true };
  }
  session.status = REPLAY_STATUS.CANCELLED;
  session.finishedAt = session.cancel.at;
  session.digest = sessionDigest(session);
  return {
    ok: true,
    mode,
    status: session.status,
    cursor: session.cursor,
    remaining: Math.max(0, session.total - session.cursor),
    skipped: session.plan.slice(session.cursor).map((batch) => ({ seq: batch.seq, kind: batch.kind, ref: batch.ref || null })),
    cancel: session.cancel,
    digest: session.digest,
  };
}

/**
 * 结束并和计划对账：逐批次比较实际 ack 与计划 expected，输出 drift 清单。
 * @param {object} session
 * @param {{actualTrace?:object|Array, at?:number}} [options]
 */
export function finishReplay(session, options = {}) {
  if (!session || !Array.isArray(session.acks)) {
    return { ok: false, code: REPLAY_CODES.REPLAY_BAD_ARG, error: 'session 缺失' };
  }
  const at = num(options.at) || Date.now();
  session.status = session.status === REPLAY_STATUS.CANCELLED ? REPLAY_STATUS.CANCELLED : (session.cursor >= session.total ? REPLAY_STATUS.COMPLETED : REPLAY_STATUS.ABORTED);
  session.finishedAt = at;
  const drift = [];
  for (const batch of session.plan.slice(0, REPLAY_LIMITS.maxBatches)) {
    const ack = session.acks.find((item) => item.seq === batch.seq);
    if (!ack) {
      drift.push({ code: 'missing-ack', seq: batch.seq, kind: batch.kind, plannedIndex: batch.index == null ? null : batch.index });
      continue;
    }
    if (ack.status !== batch.expected) {
      drift.push({ code: 'status-drift', seq: batch.seq, kind: batch.kind, expected: batch.expected, actual: ack.status });
    }
    if (ack.attempts > 1) drift.push({ code: 'retry-drift', seq: batch.seq, attempts: ack.attempts });
  }
  for (const ack of session.acks) {
    if (!session.plan.some((batch) => batch.seq === ack.seq)) drift.push({ code: 'unplanned-ack', seq: ack.seq, status: ack.status });
  }
  if (session.cancelled) drift.push({ code: 'cancelled', reason: session.cancel ? session.cancel.reason : '', cursor: session.cursor });
  const bounded = drift.slice(0, REPLAY_LIMITS.maxDrift);
  session.drift = bounded;
  session.digest = sessionDigest(session);
  const actualTrace = options.actualTrace || null;
  const traceDiff = actualTrace
    ? diffTraces(
      session.acks.map((ack) => ({ index: ack.seq - 1, ref: 'batch-' + ack.seq, status: ack.status, phase: 'serial', attempts: ack.attempts })),
      traceEntriesOf(actualTrace),
    )
    : null;
  const ok = session.status === REPLAY_STATUS.COMPLETED && bounded.length === 0;
  return {
    ok,
    status: session.status,
    code: ok ? null : REPLAY_CODES.REPLAY_DRIFT,
    cursor: session.cursor,
    total: session.total,
    counts: { ...session.counts },
    retries: session.retries,
    drift: bounded,
    traceDiff,
    evidence: replayEvidence(session, { at, traceDiff }),
    sessionDigest: session.digest,
  };
}

function traceEntriesOf(actualTrace) {
  if (Array.isArray(actualTrace)) return actualTrace;
  if (actualTrace && Array.isArray(actualTrace.entries)) return actualTrace.entries;
  return [];
}

/**
 * 回放证据证书：游标/计数/drift/轨迹 digest 一次性封存（哈希链式 digest）。
 */
export function replayEvidence(session, options = {}) {
  if (!session || typeof session !== 'object') return null;
  const at = num(options.at) || session.finishedAt || Date.now();
  const body = {
    version: REPLAY_SESSION_VERSION,
    kind: 'replay.session',
    sessionId: String(session.sessionId || ''),
    fingerprint: String(session.fingerprint || ''),
    token: String(session.token || ''),
    status: String(session.status || ''),
    cursor: integer(session.cursor, 0),
    total: integer(session.total, 0),
    counts: session.counts || null,
    retries: nonNegative(session.retries),
    cancelled: session.cancelled === true,
    cancel: session.cancel || null,
    drift: Array.isArray(session.drift) ? session.drift.slice(0, REPLAY_LIMITS.maxDrift) : [],
    at,
    traceDigest: options.traceDiff ? stableHash(JSON.stringify(options.traceDiff.stats || {})) : '',
    sessionDigest: sessionDigest(session),
  };
  return { ...body, digest: 'rv' + stableHash(JSON.stringify(body)) };
}

/** 校验回放证据证书。 */
export function verifyReplayEvidence(certificate) {
  if (!certificate || typeof certificate !== 'object') {
    return { ok: false, code: REPLAY_CODES.REPLAY_BAD_ARG, error: '回放证据缺失' };
  }
  const body = { ...certificate };
  delete body.digest;
  const expected = 'rv' + stableHash(JSON.stringify(body));
  return {
    ok: expected === certificate.digest,
    code: expected === certificate.digest ? null : REPLAY_CODES.REPLAY_EVIDENCE,
    expected,
    actual: certificate.digest || null,
    sessionId: certificate.sessionId || null,
    drift: Array.isArray(certificate.drift) ? certificate.drift.length : 0,
  };
}

/**
 * 便捷入口：begin → 按顺序 ack → finish（同步模拟；真实回放由调用方逐批 ack）。
 * @param {Array|object} stepsOrProgram
 * @param {Array<string>} statuses 与批次一一对应的实际状态
 */
export function replaySequence(stepsOrProgram, statuses = [], options = {}) {
  const begun = beginReplay(stepsOrProgram, options);
  if (!begun.ok) return { ...begun, acks: 0 };
  let acks = 0;
  const limit = Math.min(begun.session.total, Array.isArray(statuses) ? statuses.length : 0);
  for (let seq = 0; seq < limit; seq += 1) {
    const acked = ackBatch(begun.session, { seq: seq + 1, status: statuses[seq], at: num(options.at) + seq });
    if (acked.ok) acks += 1;
  }
  const finished = finishReplay(begun.session, { at: num(options.at) + limit });
  return { ...finished, session: begun.session, acks, token: begun.token };
}

/** 紧凑摘要（挂到诊断/导出）。 */
export function summarizeReplaySession(session) {
  if (!session || typeof session !== 'object') return null;
  const planCount = Array.isArray(session.plan) ? session.plan.length : 0;
  return {
    version: REPLAY_SESSION_VERSION,
    sessionId: clip(session.sessionId || '', 48),
    status: clip(session.status || '', 16),
    fingerprint: clip(session.fingerprint || '', 24),
    token: clip(session.token || '', 16),
    cursor: integer(session.cursor, 0),
    total: integer(session.total, planCount),
    counts: session.counts || { ok: 0 },
    retries: nonNegative(session.retries),
    cancelled: session.cancelled === true,
    drift: Array.isArray(session.drift) ? session.drift.slice(0, 4).map((item) => ({ code: item.code, seq: item.seq })) : [],
    digest: clip(session.digest || '', 16),
    batches: planCount,
  };
}

/** 一行摘要文本。 */
export function describeReplaySession(session) {
  if (!session || typeof session !== 'object') return 'replay: 无会话';
  const parts = ['replay=' + (session.status || '?'), 'cursor=' + integer(session.cursor, 0) + '/' + integer(session.total, 0)];
  const counts = isPlainObject(session.counts) ? session.counts : {};
  const ok = nonNegative(counts.ok);
  if (ok > 0) parts.push('ok=' + ok);
  if (nonNegative(counts.failed) > 0) parts.push('failed=' + counts.failed);
  if (nonNegative(counts.blocked) > 0) parts.push('blocked=' + counts.blocked);
  if (session.cancelled) parts.push('cancelled');
  if (Array.isArray(session.drift) && session.drift.length) parts.push('drift=' + session.drift.length);
  if (session.token) parts.push('token=' + clip(session.token, 12));
  if (session.digest) parts.push('digest=' + clip(session.digest, 12));
  return parts.join(' ');
}

/** 文本会话（CLI/日志；有上限）。 */
export function formatReplaySession(session, options = {}) {
  const maxLines = Math.max(1, integer(options.maxLines, 24));
  if (!session || typeof session !== 'object') return ['replay: 无会话'];
  const lines = [describeReplaySession(session)];
  for (const batch of (Array.isArray(session.plan) ? session.plan : []).slice(0, Math.max(0, maxLines - 1))) {
    const ack = (Array.isArray(session.acks) ? session.acks : []).find((item) => item.seq === batch.seq);
    lines.push('  #' + batch.seq + ' ' + batch.kind + ' ' + (batch.ref || (batch.nodeIndex == null ? '' : 'index:' + batch.nodeIndex)) + ' → ' + (ack ? ack.status : 'pending'));
  }
  return lines.slice(0, maxLines);
}

/** 会话计数（createReplaySessions 工厂用）。 */
export function sessionStats(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const counts = { total: list.length, running: 0, completed: 0, cancelled: 0, aborted: 0 };
  let acks = 0;
  let drift = 0;
  for (const session of list) {
    if (!session) continue;
    if (session.status === REPLAY_STATUS.RUNNING) counts.running += 1;
    else if (session.status === REPLAY_STATUS.COMPLETED) counts.completed += 1;
    else if (session.status === REPLAY_STATUS.CANCELLED) counts.cancelled += 1;
    else counts.aborted += 1;
    acks += Array.isArray(session.acks) ? session.acks.length : 0;
    drift += Array.isArray(session.drift) ? session.drift.length : 0;
  }
  return { ...counts, acks, drift };
}

/**
 * 会话管理工厂（可选；后台若需要跨 tab 记住活跃回放会话可复用）。
 */
export function createReplaySessions(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sessions = new Map();
  const counters = { begun: 0, completed: 0, cancelled: 0, restored: 0, drift: 0, dupes: 0 };
  const knownTokens = new Set(Array.isArray(options.knownTokens) ? options.knownTokens.map(String) : []);

  function begin(stepsOrProgram, beginOptions = {}) {
    const begun = beginReplay(stepsOrProgram, { ...beginOptions, now, knownTokens: beginOptions.knownTokens || [...knownTokens] });
    if (begun.code === REPLAY_CODES.REPLAY_DUPLICATE) counters.dupes += 1;
    if (begun.ok) {
      counters.begun += 1;
      sessions.set(begun.session.sessionId, begun.session);
      knownTokens.add(begun.token);
      while (sessions.size > REPLAY_LIMITS.maxSessions) {
        const oldest = sessions.keys().next().value;
        sessions.delete(oldest);
      }
    }
    return begun;
  }

  function ack(sessionId, ackValue = {}) {
    const session = sessions.get(String(sessionId));
    if (!session) return { ok: false, code: REPLAY_CODES.REPLAY_BAD_ARG, error: '没有该回放会话', sessionId: String(sessionId) };
    return ackBatch(session, ackValue);
  }

  function cancel(sessionId, reason, cancelOptions) {
    const session = sessions.get(String(sessionId));
    if (!session) return { ok: false, code: REPLAY_CODES.REPLAY_BAD_ARG, error: '没有该回放会话' };
    const result = cancelReplay(session, reason, cancelOptions);
    if (result.ok) counters.cancelled += 1;
    return result;
  }

  function finish(sessionId, finishOptions = {}) {
    const session = sessions.get(String(sessionId));
    if (!session) return { ok: false, code: REPLAY_CODES.REPLAY_BAD_ARG, error: '没有该回放会话' };
    const result = finishReplay(session, finishOptions);
    if (result.status === REPLAY_STATUS.COMPLETED) counters.completed += 1;
    counters.drift += result.drift.length;
    return result;
  }

  function restore(checkpoint, restoreOptions = {}) {
    const result = restoreSession(checkpoint, restoreOptions);
    if (result.ok) {
      counters.restored += 1;
      sessions.set(result.session.sessionId, result.session);
    }
    return result;
  }

  function snapshot(sessionId) {
    const session = sessions.get(String(sessionId));
    return session ? summarizeReplaySession(session) : null;
  }

  /** 只读：按 sessionId 取原始会话（恢复/对账测试与诊断用）。 */
  function get(sessionId) {
    return sessions.get(String(sessionId)) || null;
  }

  function list() {
    return [...sessions.values()].map(summarizeReplaySession);
  }

  function reset() {
    const cleared = sessions.size;
    sessions.clear();
    return { ok: true, cleared };
  }

  return {
    begin,
    ack,
    cancel,
    finish,
    restore,
    snapshot,
    get,
    list,
    stats() { return { ...counters, sessions: sessions.size, knownTokens: knownTokens.size }; },
    reset,
    counters() { return { ...counters, sessions: sessions.size }; },
  };
}

/** 只读：把计划批次拼成回放键（幂等重放对账用）。 */
export function replayPlanKey(stepsOrProgram, options = {}) {
  const plan = planBatches(stepsOrProgram, options);
  const fingerprint = isPlainObject(stepsOrProgram) && Array.isArray(stepsOrProgram.nodes)
    ? programFingerprint(stepsOrProgram)
    : programFingerprint(stepsOrProgram);
  return 'rk1-' + stableHash(JSON.stringify({ fingerprint, batches: plan.batches.map((batch) => [batch.kind, batch.ref || batch.nodeIndex || batch.index]) }));
}

/** 只读：生成一份空计划的封存轨迹（测试/CLI dry 空会话用）。 */
export function sealEmptyReplayTrace() {
  return sealTrace([], { session: 'empty' });
}

/** 只读：把回放会话的 ack 轨迹封成可校验证书（与执行器轨迹同一哈希链实现）。 */
export function sealReplayTrace(session) {
  if (!session || !Array.isArray(session.acks)) return sealEmptyReplayTrace();
  return sealTrace(session.acks.map((ack) => ({
    index: ack.seq - 1,
    ref: 'batch-' + ack.seq,
    kind: 'replay',
    method: 'ack',
    phase: 'serial',
    status: ack.status,
    attempts: ack.attempts,
    at: ack.at,
    note: ack.note,
  })), { sessionId: session.sessionId, token: session.token });
}

/** 只读：校验回放 ack 轨迹。 */
export function verifyReplayTrace(sealed) {
  return verifyTrace(sealed);
}

/** 只读：回放会话轨迹摘要。 */
export function summarizeReplayTrace(session) {
  const sealed = sealReplayTrace(session);
  return { ...summarizeTrace(sealed.entries), sealed };
}

/** 常量导出：EXEC_STATUS/EXEC_CODES 复用执行器语义，避免回放侧再定义一套。 */
export { EXEC_CODES, EXEC_STATUS };
