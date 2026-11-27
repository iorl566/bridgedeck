// daemon/command-boundary.js —— 命令超时/取消/幂等的边界矩阵（daemon 运行时证据层）。
//
// 为什么需要单独一层：
// 0.3.0 的超时/取消/重试语义分散在三个地方——CLI 的参数默认值、daemon 的 DEFAULT_TIMEOUT_MS、
// lib/intent-ledger 的非幂等清单。三处各自演化容易漂移：例如某个动作已经被判为非幂等，
// 但超时后的语义仍按"可重试"处理；或本地控制面方法被当成可取消的扩展命令。
//
// 本模块把"方法的边界属性"集中成可查询矩阵（全部从单一目录/既有运行时清单派生，
// **不手写第二份方法名清单**）：
//   - idempotency：read-only / retry-safe / non-idempotent / unknown；
//   - timeout：按 effect 归类（read/input/mutation/control/transfer）给默认值与上下限；
//   - cancel：能否转发取消、取消后是否仍需人工 resolve；
//   - outcome：超时/断连/失败后 effect_state 的保守判定与是否 replayBlocked。
//
// 默认行为不变：本模块不改变任何命令的默认超时或取消路径；daemon 只在 status 增量视图
// 与 inflight 取消回包里附带证据（新增字段只加不改），并把 classifyOutcome 的结论用于
// 日志/恢复报告，不替账本做结算。

import { METHOD_NAMES, CATALOG_BY_METHOD, FILE_TRANSFER_METHODS, methodStateOf } from '../lib/method-catalog.mjs';
import { isMutating, methodScope, SESSION_QUEUE_BYPASS } from '../lib/methods.mjs';
import { NON_IDEMPOTENT_METHODS, hasNoEffect, isUnknownOutcome } from '../lib/intent-ledger.mjs';

/** 矩阵报告结构版本。 */
export const BOUNDARY_SCHEMA = 1;
export const BOUNDARY_KIND = 'bridge/command-boundary';

/** 幂等性分类。 */
export const IDEMPOTENCY_CLASSES = Object.freeze(['read-only', 'retry-safe', 'non-idempotent', 'unknown']);

/** 超时类别：默认值/上下限都只是"建议边界"，请求值在 [min,max] 内原样使用。 */
export const TIMEOUT_CLASSES = Object.freeze({
  read: Object.freeze({ defaultMs: 15_000, minMs: 1_000, maxMs: 60_000, description: '只读/诊断' }),
  input: Object.freeze({ defaultMs: 15_000, minMs: 1_000, maxMs: 60_000, description: '瞬时输入' }),
  mutation: Object.freeze({ defaultMs: 60_000, minMs: 1_000, maxMs: 180_000, description: '浏览器变异' }),
  control: Object.freeze({ defaultMs: 30_000, minMs: 1_000, maxMs: 120_000, description: '控制面/会话' }),
  transfer: Object.freeze({ defaultMs: 120_000, minMs: 5_000, maxMs: 600_000, description: '文件传输' }),
  unknown: Object.freeze({ defaultMs: 60_000, minMs: 1_000, maxMs: 120_000, description: '未知方法' }),
});

/** effect → 超时类别（不出现方法名字面量；来自单一目录的 effect 取值）。 */
export const EFFECT_TIMEOUT_CLASS = Object.freeze({
  passive_read: 'read',
  read: 'read',
  transient_input: 'input',
  browser_mutation: 'mutation',
  control_plane: 'control',
});

/** 取消语义的原因码（证据码，不是协议错误码）。 */
export const CANCEL_REASONS = Object.freeze([
  'local-control-plane',   // 本地控制面命令没有扩展 inflight，不能走 cancel 通道
  'discard-result',        // 只读命令：取消只是丢弃结果
  'forward-only',          // 已转发给扩展，结果仍可能 UNKNOWN
  'requires-resolve',      // 非幂等：取消后必须人工确认 confirmed|not-applied
  'unknown-method',        // 目录里没有，保守拒绝
]);

/** 结果判定可用的 effect_state 取值。 */
export const OUTCOME_EFFECT_STATES = Object.freeze(['done', 'none', 'failed', 'unknown']);

const EFFECT_SET = new Set(Object.keys(EFFECT_TIMEOUT_CLASS));
const NON_IDEMPOTENT = NON_IDEMPOTENT_METHODS instanceof Set ? NON_IDEMPOTENT_METHODS : new Set();
const TRANSFER_METHODS = new Set(FILE_TRANSFER_METHODS);
const BYPASS = SESSION_QUEUE_BYPASS instanceof Set ? SESSION_QUEUE_BYPASS : new Set();

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function clampTimeout(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(Math.max(Math.round(number), min), max);
}

function isKnownMethod(method) {
  return Object.prototype.hasOwnProperty.call(CATALOG_BY_METHOD, text(method));
}

/**
 * 方法目录行 → 逻辑分类（纯函数，未知方法返回保守默认值）。
 * @param {string} method
 */
export function profileMethod(method) {
  const name = text(method);
  const known = isKnownMethod(name);
  const row = known ? CATALOG_BY_METHOD[name] : null;
  const effect = row ? row.effect : null;
  const owner = row ? row.owner : methodScope(name);
  const mutating = isMutating(name);
  const nonIdempotent = NON_IDEMPOTENT.has(name);
  const idempotency = !known
    ? 'unknown'
    : effect === 'passive_read' || effect === 'read'
      ? 'read-only'
      : nonIdempotent
        ? 'non-idempotent'
        : mutating
          ? 'retry-safe'
          : 'read-only';
  const timeoutClass = TRANSFER_METHODS.has(name)
    ? 'transfer'
    : (effect && EFFECT_TIMEOUT_CLASS[effect]) || 'unknown';
  const timeout = TIMEOUT_CLASSES[timeoutClass] || TIMEOUT_CLASSES.unknown;
  const state = known && typeof methodStateOf === 'function' ? methodStateOf(name) : null;
  const reconcile = state && state.reconcile ? state.reconcile : { strategy: 'none', method: null };
  return {
    method: name,
    known,
    owner: owner || null,
    effect: effect || null,
    mutating: mutating === true,
    nonIdempotent,
    idempotency,
    timeoutClass,
    timeout: {
      class: timeoutClass,
      defaultMs: timeout.defaultMs,
      minMs: timeout.minMs,
      maxMs: timeout.maxMs,
    },
    cancel: cancelPolicyFor({ name, known, owner, idempotency, nonIdempotent }),
    queue: {
      bypass: BYPASS.has(name),
      serial: methodScope(name) !== null,
    },
    reconcile: reconcile ? { strategy: reconcile.strategy, method: reconcile.method } : { strategy: 'none', method: null },
  };
}

function cancelPolicyFor({ known, owner, idempotency, nonIdempotent }) {
  if (!known) {
    return { allowed: false, reason: 'unknown-method', requiresResolve: false, forward: false };
  }
  if (owner === 'local') {
    return { allowed: false, reason: 'local-control-plane', requiresResolve: false, forward: false };
  }
  if (idempotency === 'read-only') {
    return { allowed: true, reason: 'discard-result', requiresResolve: false, forward: true };
  }
  return {
    allowed: true,
    reason: nonIdempotent ? 'requires-resolve' : 'forward-only',
    requiresResolve: nonIdempotent === true,
    forward: true,
  };
}

/**
 * 计算一次请求的有效超时：
 * - requested<=0/缺失 → 该类别的默认值；
 * - 在 [min,max] 内原样使用；
 * - 超上限截断并标记 capped（不静默改变调用方语义，证据里说明）。
 * @param {{method: string, requestedMs?: number, defaultTimeoutMs?: number}} input
 */
export function timeoutFor({ method, requestedMs = null, defaultTimeoutMs = null } = {}) {
  const profile = profileMethod(method);
  const requested = Number(requestedMs);
  const fallback = Number.isInteger(Number(defaultTimeoutMs)) && Number(defaultTimeoutMs) > 0
    ? Number(defaultTimeoutMs)
    : profile.timeout.defaultMs;
  if (!Number.isFinite(requested) || requested <= 0) {
    return {
      method: profile.method,
      class: profile.timeout.class,
      ms: fallback,
      requestedMs: null,
      capped: false,
      clamped: false,
      reason: 'default',
      minMs: profile.timeout.minMs,
      maxMs: profile.timeout.maxMs,
    };
  }
  const rounded = Math.round(requested);
  const clamped = clampTimeout(rounded, profile.timeout.minMs, profile.timeout.maxMs);
  return {
    method: profile.method,
    class: profile.timeout.class,
    ms: clamped,
    requestedMs: rounded,
    capped: rounded > profile.timeout.maxMs,
    clamped: rounded < profile.timeout.minMs,
    reason: rounded > profile.timeout.maxMs ? 'capped-max' : rounded < profile.timeout.minMs ? 'raised-min' : 'requested',
    minMs: profile.timeout.minMs,
    maxMs: profile.timeout.maxMs,
  };
}

/**
 * 取消决策：是否允许把 cancel 转发给扩展（不改变 inflight-ops 现有行为，只给证据）。
 * @param {{method: string, stage?: string}} input
 */
export function canCancel({ method, stage = 'inflight' } = {}) {
  const profile = profileMethod(method);
  return {
    method: profile.method,
    stage: text(stage) || 'inflight',
    allowed: profile.cancel.allowed,
    reason: profile.cancel.reason,
    requiresResolve: profile.cancel.requiresResolve,
    forward: profile.cancel.forward,
    idempotency: profile.idempotency,
  };
}

/**
 * 结果判定：成功/失败/超时/断连后的 effect_state 与是否禁止重放。
 * 与 lib/intent-ledger 的保守语义一致：无法证明未生效的变异一律 unknown。
 * @param {{method: string, error?: Error|null, result?: any}} input
 */
export function classifyOutcome({ method, error = null, result = undefined } = {}) {
  const profile = profileMethod(method);
  if (!error) {
    return {
      method: profile.method,
      settled: true,
      effectState: 'done',
      retrySafe: false,
      replayBlocked: false,
      requiresResolve: false,
      reason: 'success',
      idempotency: profile.idempotency,
    };
  }
  const noEffect = hasNoEffect(error) === true;
  const unknown = !noEffect && isUnknownOutcome(error) === true;
  const effectState = noEffect ? 'none' : unknown ? 'unknown' : 'failed';
  const replayBlocked = unknown && profile.nonIdempotent;
  const retrySafe = effectState === 'none'
    ? profile.idempotency === 'read-only' || profile.idempotency === 'retry-safe' || profile.idempotency === 'non-idempotent' && noEffect
    : effectState === 'failed'
      ? profile.idempotency === 'read-only' || profile.idempotency === 'retry-safe'
      : false;
  return {
    method: profile.method,
    settled: effectState !== 'unknown',
    effectState,
    retrySafe: retrySafe === true,
    replayBlocked,
    requiresResolve: replayBlocked === true,
    reason: noEffect ? 'no-effect' : unknown ? 'unknown-outcome' : 'failed',
    idempotency: profile.idempotency,
    code: (error && error.code) || null,
  };
}

/** 取消回包的证据字段（inflight-ops 直接嵌入返回体；只加不改）。 */
export function cancelEvidence({ id = null, method = null, startedAt = null, now = Date.now(), result = null } = {}) {
  const decision = canCancel({ method: method || '' });
  const elapsedMs = Number.isFinite(Number(startedAt)) && startedAt > 0 ? Math.max(0, Number(now) - Number(startedAt)) : null;
  return {
    id: id == null ? null : String(id),
    method: method || null,
    elapsedMs,
    allowed: decision.allowed,
    reason: decision.reason,
    requiresResolve: decision.requiresResolve,
    idempotency: decision.idempotency,
    forwarded: true,
    accepted: Boolean(result && result.cancelled === true),
    effectState: decision.requiresResolve ? 'unknown' : 'unknown',
  };
}

/** 纯函数：构造全量边界矩阵（默认 165 个目录方法）。 */
export function buildBoundaryMatrix({ methods = METHOD_NAMES, now = Date.now() } = {}) {
  const entries = (Array.isArray(methods) ? methods : []).map((method) => profileMethod(method));
  const counts = {
    total: entries.length,
    known: entries.filter((item) => item.known).length,
    byIdempotency: {},
    byTimeoutClass: {},
    byEffect: {},
    cancelAllowed: entries.filter((item) => item.cancel.allowed).length,
    cancelBlocked: entries.filter((item) => !item.cancel.allowed).length,
    requiresResolve: entries.filter((item) => item.cancel.requiresResolve).length,
    bypass: entries.filter((item) => item.queue.bypass).length,
  };
  for (const item of entries) {
    counts.byIdempotency[item.idempotency] = (counts.byIdempotency[item.idempotency] || 0) + 1;
    counts.byTimeoutClass[item.timeout.class] = (counts.byTimeoutClass[item.timeout.class] || 0) + 1;
    const effect = item.effect || 'unknown';
    counts.byEffect[effect] = (counts.byEffect[effect] || 0) + 1;
  }
  return {
    schema: BOUNDARY_SCHEMA,
    kind: BOUNDARY_KIND,
    at: Number(now) || Date.now(),
    generatedAt: new Date(Number(now) || Date.now()).toISOString(),
    counts,
    entries,
    invariants: validateBoundaryMatrix(entries),
  };
}

/**
 * 矩阵不变量（回归护栏）：
 * 1) 目录方法都必须能分类（known=true）；
 * 2) non-idempotent 必须是变异方法（否则账本/幂等两套语义漂移）；
 * 3) 本地控制面方法不应被当成可取消的扩展 inflight；
 * 4) 每个超时类别的默认值必须落在 [min,max] 内。
 */
export function validateBoundaryMatrix(entries) {
  const issues = [];
  for (const item of Array.isArray(entries) ? entries : []) {
    if (!item || typeof item !== 'object') {
      issues.push({ code: 'bad-entry', method: item && item.method ? item.method : null, message: '矩阵条目不是对象' });
      continue;
    }
    if (!item.known) {
      issues.push({ code: 'unknown-method', method: item.method, message: '方法不在单一目录里' });
      continue;
    }
    if (item.idempotency === 'non-idempotent' && item.mutating !== true) {
      issues.push({ code: 'non-idempotent-not-mutating', method: item.method, message: '非幂等清单与目录 effect 不一致' });
    }
    if (item.cancel.allowed && item.owner === 'local') {
      issues.push({ code: 'local-cancelable', method: item.method, message: '本地控制面方法不应可取消' });
    }
    if (!item.queue.serial && item.owner === 'session') {
      issues.push({ code: 'session-not-serial', method: item.method, message: '会话方法未进入串行队列' });
    }
    if (item.timeout.defaultMs < item.timeout.minMs || item.timeout.defaultMs > item.timeout.maxMs) {
      issues.push({ code: 'bad-timeout-bounds', method: item.method, message: '超时默认值不在上下限内' });
    }
  }
  return issues;
}

/** 矩阵摘要（status 视图/CLI 诊断用；不含逐方法明细）。 */
export function summarizeBoundaryMatrix(matrix, { limit = 20 } = {}) {
  const max = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
  const byClass = {};
  for (const [name, config] of Object.entries(TIMEOUT_CLASSES)) {
    byClass[name] = { defaultMs: config.defaultMs, minMs: config.minMs, maxMs: config.maxMs, description: config.description };
  }
  const samples = {};
  for (const item of matrix.entries) {
    if (!samples[item.idempotency]) samples[item.idempotency] = [];
    if (samples[item.idempotency].length < max) samples[item.idempotency].push(item.method);
  }
  return {
    schema: matrix.schema,
    kind: matrix.kind,
    at: matrix.at,
    generatedAt: matrix.generatedAt,
    counts: matrix.counts,
    timeoutClasses: byClass,
    idempotencyClasses: IDEMPOTENCY_CLASSES.slice(),
    cancelReasons: CANCEL_REASONS.slice(),
    samples,
    invariants: matrix.invariants.slice(0, max),
    invariantOk: matrix.invariants.length === 0,
  };
}

/** 单方法的人话说明（日志/CLI 排查）。 */
export function describeMethodBoundary(method) {
  const profile = profileMethod(method);
  const retry = profile.idempotency === 'read-only'
    ? '可安全重试/取消（丢弃结果）'
    : profile.idempotency === 'non-idempotent'
      ? '不可自动重放；超时/断连后必须人工确认 confirmed|not-applied'
      : '可重试但需注意副作用';
  return profile.method
    + '（owner=' + (profile.owner || '未知')
    + '，effect=' + (profile.effect || '未知')
    + '，幂等性=' + profile.idempotency
    + '，超时类别=' + profile.timeout.class + ' ' + profile.timeout.defaultMs + 'ms'
    + '）→ ' + retry
    + (profile.cancel.allowed ? '；cancel 可转发' : '；cancel 不可用（' + profile.cancel.reason + '）');
}

/**
 * 运行时边界服务：在纯函数之上加计数器/最近决策环，供 status/inflight/恢复报告消费。
 * @param {{now?: Function, defaultTimeoutMs?: number, decisionLimit?: number}} options
 */
export function createCommandBoundary({ now = () => Date.now(), defaultTimeoutMs = 60_000, decisionLimit = 200 } = {}) {
  const limit = Number.isInteger(Number(decisionLimit)) && Number(decisionLimit) > 0 ? Number(decisionLimit) : 200;
  const counters = {
    classifications: 0,
    timeouts: 0,
    cappedTimeouts: 0,
    cancels: 0,
    cancelBlocked: 0,
    outcomes: 0,
    unknownOutcomes: 0,
    replayBlocked: 0,
  };
  const decisions = [];
  let matrixCache = null;

  function clock() {
    return typeof now === 'function' ? Number(now()) || Date.now() : Date.now();
  }

  function remember(kind, detail) {
    decisions.push({ seq: decisions.length + 1, at: clock(), kind, ...detail });
    const overflow = decisions.length - limit;
    if (overflow > 0) decisions.splice(0, overflow);
  }

  function classify(method) {
    counters.classifications += 1;
    const profile = profileMethod(method);
    remember('classify', { method: profile.method, idempotency: profile.idempotency });
    return profile;
  }

  function timeout(params = {}) {
    counters.timeouts += 1;
    const result = timeoutFor({ ...params, defaultTimeoutMs });
    if (result.capped) counters.cappedTimeouts += 1;
    remember('timeout', { method: result.method, class: result.class, ms: result.ms, capped: result.capped });
    return result;
  }

  function cancel(params = {}) {
    counters.cancels += 1;
    const decision = canCancel(params);
    if (!decision.allowed) counters.cancelBlocked += 1;
    remember('cancel', { method: decision.method, allowed: decision.allowed, reason: decision.reason });
    return decision;
  }

  function cancelEvidenceFor(params = {}) {
    const evidence = cancelEvidence({ ...params, now: clock() });
    if (evidence.requiresResolve) counters.replayBlocked += 0;
    return evidence;
  }

  function outcome(params = {}) {
    counters.outcomes += 1;
    const result = classifyOutcome(params);
    if (result.effectState === 'unknown') counters.unknownOutcomes += 1;
    if (result.replayBlocked) counters.replayBlocked += 1;
    remember('outcome', { method: result.method, effectState: result.effectState, retrySafe: result.retrySafe });
    return result;
  }

  function matrix({ methods = METHOD_NAMES, refresh = false } = {}) {
    if (matrixCache && refresh !== true && methods === METHOD_NAMES) return matrixCache;
    const built = buildBoundaryMatrix({ methods, now: clock() });
    if (methods === METHOD_NAMES) matrixCache = built;
    return built;
  }

  function summary({ limit: max = 20 } = {}) {
    return {
      ...summarizeBoundaryMatrix(matrix(), { limit: max }),
      runtime: {
        counters: { ...counters },
        decisions: decisions.slice(-Math.max(1, Number(max) || 20)),
        decisionsTotal: decisions.length,
      },
    };
  }

  function describe(method) {
    return describeMethodBoundary(method);
  }

  function stats() {
    return { counters: { ...counters }, decisions: decisions.length, matrixSize: matrixCache ? matrixCache.entries.length : 0 };
  }

  function reset() {
    for (const key of Object.keys(counters)) counters[key] = 0;
    decisions.length = 0;
    matrixCache = null;
    return stats();
  }

  return { classify, timeout, cancel, cancelEvidence: cancelEvidenceFor, outcome, matrix, summary, describe, stats, reset };
}
