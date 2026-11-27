// src/lib/transaction-ledger.js —— 动作事务状态机 + effect/cleanup 双轴账本。
//
// 两个层次：
//   1) createEffectLedger / committedEffect：旧的轻量 effect 状态（pointer/file 动作返回值用），
//      保持向后兼容，不改变既有字段；
//   2) createActionTransaction：显式四态事务（begin → dispatched → committed/unknown，
//      cleanup 独立一轴），并接入 action-journal 做**派发前预写**：
//        - 派发前 begin 已 fsync/落盘；
//        - 提交/未知/清理各自落一条终态记录；
//        - UNKNOWN 之后 canReplay() 恒 false，必须显式 resolve 才能解除；
//        - 每个动作把 txId/journalId 返回给调用方，可关联到账本记录。
//
// 源码里的 phase 只有 pointer / file / key 三类：pointer（鼠标）、file（上传下载）、
// key（键盘）。file 的派发点在 files.js / file-transfer.js（不在本任务写域），
// 本模块提供 createFileTransaction 供其接线，并用单测锁四态语义。

/** 派发前就能证明“页面没被改”的错误码：只落 abort，不冻结标签页。 */
export const NO_EFFECT_CODES = new Set([
  'E_BAD_ARG',
  'E_INVALID_PARAMS',
  'E_NOT_FOUND',
  'E_STALE_REF',
  'E_TARGET_NOT_FILLABLE',
  'E_TARGET_MISMATCH',
  'E_TARGET_DETACHED',
  'E_NOT_ACTIONABLE',
  'E_OCCLUDED',
  'E_OPTION_NOT_FOUND',
  'E_OPTION_AMBIGUOUS',
  'E_NOT_SELECT',
  'E_FORBIDDEN',
  'E_READ_ONLY',
  'E_NO_TAB',
  'E_INPUT_BUSY',
  'E_CURSOR_STALE',
  'E_OBSERVATION_CHANGED',
  'E_OBSERVATION_STALE',
  'E_CONTEXT_STALE',
  'E_CONTEXT_REQUIRED',
  'E_EXPECT_FAILED',
  'E_DEPENDS_FAILED',
]);

/** 这些错误表示“已经派发但结果不可知”，必须按 UNKNOWN 处理。 */
export const UNKNOWN_CODES = new Set([
  'E_TIMEOUT',
  'E_DAEMON_TIMEOUT',
  'E_EXTENSION_GONE',
  'E_DISCONNECTED',
  'E_CANCELLED',
  'E_DEBUGGER_BUSY',
]);

const UNKNOWN_MESSAGE_HINT = /timeout|timed out|ECONNRESET|socket|disconnected|断开|已按下|结果未知/i;

/**
 * 判断失败属于“确定没生效”还是“结果未知”。
 * 只要 error.data.effect_state/dispatched 给出证据，优先采信动作层自己的判断。
 */
export function classifyTransactionFailure(error) {
  if (!error) return 'unknown';
  const data = error.data && typeof error.data === 'object' ? error.data : {};
  if (data.effect_state === 'unknown' || data.effectState === 'unknown' || error.effectState === 'unknown') return 'unknown';
  if (data.effect_state === 'none' || data.effectState === 'none') return 'none';
  if (data.dispatched === false || error.dispatched === false) return 'none';
  const code = String(error.code || '');
  if (NO_EFFECT_CODES.has(code)) return 'none';
  if (UNKNOWN_CODES.has(code)) return 'unknown';
  if (UNKNOWN_MESSAGE_HINT.test(String(error.message || ''))) return 'unknown';
  // 没有派发证据的普通错误按“未生效”处理：把正常校验失败冻结成 UNKNOWN 会误伤整个标签页。
  return 'none';
}

/** 旧的轻量 effect 账本：保持原 API 与字段。 */
export function createEffectLedger(phase = 'pointer') {
  let effectState = 'none';
  let cleanupState = 'ok';
  let dispatched = false;
  return {
    dispatched() {
      dispatched = true;
      if (effectState === 'none') effectState = 'unknown';
    },
    commit() {
      effectState = 'committed';
      cleanupState = 'ok';
    },
    unknown() {
      effectState = 'unknown';
      cleanupState = 'failed';
    },
    cleanupFailed() {
      cleanupState = 'failed';
    },
    snapshot() {
      return { phase, effectState, cleanupState, dispatched };
    },
  };
}

/** 成功动作的 effect 字段（既有调用方：fill/pointer/files/file-transfer）。 */
export function committedEffect(phase = 'pointer', extra = null) {
  const base = { effectState: 'committed', cleanupState: 'ok', phase };
  if (!extra || typeof extra !== 'object') return base;
  return { ...base, ...extra };
}

let transactionSeq = 0;
let transactionPrefix = 'atx';

/** 测试用：把事务 id 变成可预测序列。 */
export function setTransactionIdFactory({ prefix = 'atx', start = 0 } = {}) {
  transactionPrefix = String(prefix || 'atx');
  transactionSeq = Number.isInteger(start) ? start : 0;
}

function nextTransactionId() {
  transactionSeq += 1;
  return transactionPrefix + '_' + transactionSeq.toString(36).padStart(3, '0');
}

/**
 * 创建动作事务。
 * @param {object} options
 * @param {'pointer'|'file'|'key'} [options.phase]
 * @param {object|null} [options.journal]  createActionJournal() 的实例；null 时仅内存态
 * @param {string} [options.method]        动作方法名（fill/click/download…）
 * @param {number|null} [options.tabId]
 * @param {object|null} [options.params]    原始参数（journal 只取键名与目标摘要）
 * @param {object|null} [options.rowAnchor] 行锚点事实（journal 落摘要）
 */
export function createActionTransaction(options = {}) {
  const phase = options.phase === 'file' ? 'file' : options.phase === 'key' ? 'key' : 'pointer';
  const journal = options.journal || null;
  const method = String(options.method || '');
  const tabId = Number.isInteger(Number(options.tabId)) ? Number(options.tabId) : null;
  const params = options.params && typeof options.params === 'object' ? options.params : null;
  const rowAnchor = options.rowAnchor && typeof options.rowAnchor === 'object' ? options.rowAnchor : (params && params.rowAnchor) || null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const id = typeof options.idFactory === 'function' ? String(options.idFactory({ method, phase, tabId })) : nextTransactionId();
  let state = 'idle';
  let effectState = 'none';
  let cleanupState = 'pending';
  let dispatched = false;
  let journalId = null;
  let beganAt = null;
  let finishedAt = null;
  let resolvedAt = null;
  let resolveOutcome = null;
  let lastError = null;
  let lastEvidence = null;
  let journalLatencyMs = null;

  function stamp() {
    return {
      id,
      phase,
      state,
      effectState,
      cleanupState,
      dispatched,
      journalId,
      beganAt,
      finishedAt,
    };
  }

  function assertMutable(target) {
    if (state === 'committed' || state === 'unknown' || state === 'resolved' || state === 'aborted') {
      return { ok: false, code: 'E_BAD_ARG', message: '事务已终态（' + state + '），不能再改成 ' + target, transaction: stamp() };
    }
    return null;
  }

  /** 动作派发前的预写（WAL）：await 完成才允许派发。 */
  async function begin(extra = {}) {
    if (state !== 'idle') return { ok: false, code: 'E_BAD_ARG', message: '事务已 begin：' + state, transaction: stamp() };
    const startedAt = now();
    beganAt = new Date(startedAt).toISOString();
    if (journal) {
      const written = await journal.begin({
        method,
        tabId,
        phase,
        txId: id,
        params: { ...(params || {}), ...(extra.params || {}) },
        target: extra.target || null,
        rowAnchor: extra.rowAnchor || rowAnchor,
      });
      journalId = written && written.id ? written.id : null;
      journalLatencyMs = written && Number.isFinite(written.latencyMs) ? written.latencyMs : null;
      if (written && written.recovered && written.recovered.length) {
        lastEvidence = { recoveredUnknown: written.recovered };
      }
    }
    state = 'begun';
    effectState = 'none';
    cleanupState = 'pending';
    return { ok: true, transaction: stamp(), journalId, journalLatencyMs };
  }

  /** 标记“已开始向页面派发输入/请求”：之后失败一律按 UNKNOWN 处理。 */
  function markDispatched(evidence = null) {
    if (state === 'idle') {
      // 没走 begin 的调用点（旧路径）：仍然记录已派发，保证 unknown 语义正确。
      state = 'begun';
      beganAt = beganAt || new Date(now()).toISOString();
    }
    if (state !== 'begun') return stamp();
    dispatched = true;
    state = 'dispatched';
    effectState = 'unknown';
    if (evidence) lastEvidence = evidence;
    return stamp();
  }

  async function commit(details = {}) {
    if (state === 'committed') return { ok: true, transaction: stamp(), already: true };
    const blocked = assertMutable('committed');
    if (blocked) return blocked;
    state = 'committed';
    effectState = 'committed';
    cleanupState = details.cleanupState === 'failed' ? 'failed' : 'ok';
    finishedAt = new Date(now()).toISOString();
    if (journal && journalId) await journal.commit(journalId, { details: details.details || null, evidence: details.evidence || lastEvidence || null });
    return { ok: true, transaction: stamp() };
  }

  async function abort(reason = 'no-effect', evidence = null) {
    if (state === 'aborted') return { ok: true, transaction: stamp(), already: true };
    const blocked = assertMutable('aborted');
    if (blocked) return blocked;
    state = 'aborted';
    effectState = 'none';
    cleanupState = 'ok';
    finishedAt = new Date(now()).toISOString();
    lastEvidence = evidence || lastEvidence;
    if (journal && journalId) await journal.abort(journalId, reason, evidence || lastEvidence || null);
    return { ok: true, transaction: stamp() };
  }

  async function markUnknown(evidence = null, reason = 'effect-unknown') {
    if (state === 'unknown') return { ok: true, transaction: stamp(), already: true };
    state = 'unknown';
    effectState = 'unknown';
    cleanupState = 'failed';
    dispatched = true;
    finishedAt = new Date(now()).toISOString();
    lastEvidence = evidence || lastEvidence;
    if (journal && journalId) await journal.unknown(journalId, evidence || lastEvidence || null, reason);
    return { ok: true, transaction: stamp() };
  }

  async function cleanupFailed(evidence = null) {
    cleanupState = 'failed';
    lastEvidence = evidence || lastEvidence;
    if (journal && journalId) await journal.cleanup(journalId, false, evidence || lastEvidence || null);
    return { ok: true, transaction: stamp() };
  }

  async function cleanupOk(evidence = null) {
    cleanupState = 'ok';
    if (journal && journalId) await journal.cleanup(journalId, true, evidence || null);
    return { ok: true, transaction: stamp() };
  }

  /**
   * 显式 resolve：只允许把 UNKNOWN 改成 resolved（confirmed / not-applied）。
   * UNKNOWN 永远不会自动变回 committed —— 这是“未知态不得自动重放”的落点。
   */
  async function resolve(resolution = {}) {
    if (state !== 'unknown') {
      return { ok: false, code: 'E_BAD_ARG', message: '只有 UNKNOWN 事务可以 resolve（当前 ' + state + '）', transaction: stamp() };
    }
    const outcome = String(resolution.outcome || 'confirmed');
    if (!['confirmed', 'not-applied'].includes(outcome)) {
      return { ok: false, code: 'E_BAD_ARG', message: 'resolve outcome 只能是 confirmed / not-applied', transaction: stamp() };
    }
    state = 'resolved';
    resolveOutcome = outcome;
    resolvedAt = new Date(now()).toISOString();
    if (outcome === 'not-applied') {
      effectState = 'none';
      cleanupState = 'ok';
    }
    if (journal && journalId) {
      await journal.resolve(journalId, {
        outcome,
        by: resolution.by || 'agent',
        note: resolution.note || null,
        evidence: resolution.evidence || null,
      });
    }
    return { ok: true, outcome, transaction: stamp() };
  }

  /** 失败收口：根据证据把事务标成 abort（未生效）或 UNKNOWN（结果未知）。 */
  async function fail(error, evidence = null) {
    lastError = error || null;
    const data = error && error.data && typeof error.data === 'object' ? error.data : null;
    let classification = classifyTransactionFailure(error);
    // 已经派发过、错误本身又没有“未生效”证据时，必须按 UNKNOWN 收口（例如释放输入失败）。
    const explicitNone = Boolean(data && (data.effect_state === 'none' || data.dispatched === false))
      || Boolean(error && (error.dispatched === false || error.effect_state === 'none'));
    if (classification === 'none' && dispatched === true && !explicitNone) classification = 'unknown';
    if (classification === 'unknown') {
      await markUnknown(evidence || (data && data.evidence ? data.evidence : null), (error && error.code) || 'unknown');
      if (error && typeof error === 'object' && !Array.isArray(error)) {
        error.data = {
          ...(data || {}),
          effect_state: data && data.effect_state ? data.effect_state : 'unknown',
          cleanup_state: 'failed',
          phase,
          tx_id: id,
          ...(journalId ? { journal_id: journalId } : {}),
          replay: false,
          next: 'observe-then-resolve',
        };
      }
      return { ok: true, classification, transaction: stamp() };
    }
    await abort((error && error.code) || 'no-effect', evidence || null);
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      // 只补缺失字段，不覆盖动作层已经给出的精确 effect_state。
      error.data = {
        ...(data || {}),
        ...(data && data.effect_state ? {} : { effect_state: 'none' }),
        ...(data && data.dispatched !== undefined ? {} : { dispatched: false }),
        phase,
        tx_id: id,
        ...(journalId ? { journal_id: journalId } : {}),
        replay: true,
      };
    }
    return { ok: true, classification, transaction: stamp() };
  }

  /**
   * 允许“安全重试”的条件：
   *   - begun 且未派发：还没碰页面；
   *   - aborted：已有证据证明页面没被改（可换新事务重试）。
   * UNKNOWN / committed / resolved 一律 false —— 未知态绝不自动重放。
   */
  function canReplay() {
    if (state === 'aborted') return true;
    return state === 'begun' && dispatched === false;
  }

  function assertReplayable() {
    if (canReplay()) return;
    const error = new Error(
      '事务 ' + id + ' 处于 ' + state + '（effectState=' + effectState + '），不允许自动重放；' +
      '请先 observe 核对页面，再显式 resolve（outcome=confirmed|not-applied）',
    );
    error.code = 'E_INTERNAL';
    error.data = { cause: 'effect_unknown', effectState, cleanupState, phase, tx_id: id, replay: false };
    throw error;
  }

  /** 结果字段：和 committedEffect 同形，额外带事务/账本 id 与是否可重放。 */
  function fields() {
    return {
      effectState,
      cleanupState,
      phase,
      tx_id: id,
      ...(journalId ? { journal_id: journalId } : {}),
      replayable: canReplay(),
    };
  }

  /** 完整快照（含账本关联与 resolve 结果），供日志/回执/测试断言。 */
  function snapshot() {
    return {
      ...stamp(),
      journalLatencyMs,
      canReplay: canReplay(),
      resolveOutcome,
      resolvedAt,
      lastEvidence,
      errorCode: lastError && lastError.code ? lastError.code : null,
    };
  }

  return {
    id,
    phase,
    method,
    tabId,
    begin,
    markDispatched,
    dispatched: markDispatched,
    commit,
    abort,
    unknown: markUnknown,
    markUnknown,
    cleanupFailed,
    cleanupOk,
    resolve,
    fail,
    canReplay,
    assertReplayable,
    fields,
    snapshot,
    get state() {
      return state;
    },
    get effectState() {
      return effectState;
    },
    get cleanupState() {
      return cleanupState;
    },
    get journalId() {
      return journalId;
    },
  };
}

/**
 * file 事务（上传/下载）：四态语义与 pointer 相同，phase 固定 file。
 * 供 files.js / tools/file-transfer.js 接线；未接线的调用点仍可继续用 committedEffect('file')。
 */
export function createFileTransaction(options = {}) {
  return createActionTransaction({ ...options, phase: 'file' });
}

/** 把事务快照摊平成对外字段（结果里带 action_tx 时用）。 */
export function transactionFields(transaction) {
  if (!transaction || typeof transaction.snapshot !== 'function') return {};
  const snapshot = transaction.snapshot();
  return {
    tx_id: snapshot.id,
    tx_state: snapshot.state,
    ...(snapshot.journalId ? { journal_id: snapshot.journalId } : {}),
    ...(snapshot.cleanupState ? { cleanup_state: snapshot.cleanupState } : {}),
  };
}
