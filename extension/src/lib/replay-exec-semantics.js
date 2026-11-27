// extension/src/lib/replay-exec-semantics.js —— 回放执行器的纯模型层（第二轮，从 replay-executor.js 拆出）。
//
// 只回答“执行前的确定性语义”：结果码/上限、选项与 providers 归一、副作用画像、
// 以及可复用的基础工具。零 chrome、零时钟、零随机；被 replay-exec-envelope.js、
// replay-exec-audit.js 与 replay-executor.js 单向依赖。

import { stableHash } from '../record-steps.js';
import { stableStringify } from './replay-plan.js';

export const REPLAY_EXECUTOR_VERSION = 2;

/** 执行结果码（机器可读；与 replay-explain 目录码分开，解释层再映射）。 */
export const EXECUTOR_CODES = Object.freeze({
  OK: 'REPLAY_EXEC_OK',
  PLANNED: 'REPLAY_EXEC_PLANNED',
  BLOCKED: 'REPLAY_EXEC_BLOCKED',
  NO_EXECUTOR: 'REPLAY_EXEC_NO_EXECUTOR',
  NO_BOUNDARY_EXECUTOR: 'REPLAY_EXEC_NO_BOUNDARY_EXECUTOR',
  BOUNDARY_BLOCKED: 'REPLAY_EXEC_BOUNDARY_BLOCKED',
  STEP_FAILED: 'REPLAY_EXEC_STEP_FAILED',
  RETRY_EXHAUSTED: 'REPLAY_EXEC_RETRY_EXHAUSTED',
  TIMEOUT: 'REPLAY_EXEC_TIMEOUT',
  CANCELLED: 'REPLAY_EXEC_CANCELLED',
  BUDGET: 'REPLAY_EXEC_BUDGET',
  STEP_SKIPPED: 'REPLAY_EXEC_STEP_SKIPPED',
  RESULT_MISSING: 'REPLAY_EXEC_RESULT_MISSING',
  NON_DETERMINISTIC: 'REPLAY_EXEC_NON_DETERMINISTIC',
  SIDE_EFFECT_UNKNOWN: 'REPLAY_EXEC_SIDE_EFFECT_UNKNOWN',
  TRUNCATED: 'REPLAY_EXEC_TRUNCATED',
});

/** 单步状态（entry.status）。 */
export const EXEC_STATUS = Object.freeze(['planned', 'passed', 'failed', 'skipped', 'blocked']);

/** 执行器的硬上限：任何输入都不能把执行轨迹撑爆。 */
export const EXECUTOR_LIMITS = Object.freeze({
  maxSteps: 4000,
  maxEntries: 4000,
  maxRetries: 5,
  maxRetryDelayMs: 5000,
  defaultStepTimeoutMs: 15000,
  maxTotalVirtualMs: 900000,
  maxEvidence: 24,
  maxText: 300,
  maxTraceBytes: 524288,
});

/** 请求方法：会改变服务端状态的方法（用于副作用语义）。 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 安全方法：无请求体、可安全重放。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 执行器结果码 → 失败目录码（解释层消费；未知返回空串走分类启发式）。 */
export const EXECUTOR_CATALOG_CODES = Object.freeze({
  [EXECUTOR_CODES.TIMEOUT]: 'REPLAY_TIMEOUT',
  [EXECUTOR_CODES.CANCELLED]: 'REPLAY_CANCELLED',
  [EXECUTOR_CODES.BLOCKED]: 'PLAN_BLOCKED',
  [EXECUTOR_CODES.BOUNDARY_BLOCKED]: 'BOUNDARY_DOCUMENT_CHANGED',
  [EXECUTOR_CODES.NO_EXECUTOR]: 'PLAN_VALIDATION',
  [EXECUTOR_CODES.NO_BOUNDARY_EXECUTOR]: 'BOUNDARY_NAVIGATION_REQUIRED',
  [EXECUTOR_CODES.RETRY_EXHAUSTED]: 'REPLAY_TIMEOUT',
  [EXECUTOR_CODES.STEP_FAILED]: '',
  [EXECUTOR_CODES.STEP_SKIPPED]: '',
  [EXECUTOR_CODES.RESULT_MISSING]: 'REPLAY_NOT_ATTEMPTED',
  [EXECUTOR_CODES.BUDGET]: 'PLAN_RETRY_BUDGET',
  [EXECUTOR_CODES.SIDE_EFFECT_UNKNOWN]: 'PLAN_SIDE_EFFECT',
});

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInt(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, nonNegativeInt(value, min)));
}

function shortText(value, max = EXECUTOR_LIMITS.maxText) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** UTF-8 字节数（TextEncoder 优先；无则手算，保证 SW 与 Node 同结果）。 */
function utf8Bytes(text) {
  const value = String(text === null || text === undefined ? '' : text);
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}

/** URL → {origin, key}（去 hash）；失败返回空。 */
function urlFacts(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { origin: '', key: '', valid: false };
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { origin: '', key: text, valid: false };
    }
    return {
      origin: parsed.origin,
      key: parsed.origin + parsed.pathname + parsed.search,
      valid: true,
    };
  } catch {
    return { origin: '', key: text, valid: false };
  }
}

/** 只取 plan.steps 的稳定数组（避免各处重复判空）。 */
function stepsOf(plan) {
  return plan && Array.isArray(plan.steps) ? plan.steps : [];
}

// ---------------------------------------------------------------------------
// 执行选项归一
// ---------------------------------------------------------------------------

/**
 * 归一化执行选项：上限/重试/容差/取消/虚拟时钟策略。
 * 不认识的值一律回落到安全默认（不抛异常）。
 * @param {object} [options]
 * @returns {object}
 */
export function normalizeExecutionOptions(options = {}) {
  const source = isObject(options) ? options : {};
  const limits = isObject(source.limits) ? source.limits : {};
  const limitOf = (key, max) => {
    const raw = limits[key] !== undefined ? limits[key] : source[key];
    if (raw === undefined) return max;
    return clampInt(raw, key === 'maxRetries' || key === 'maxRetryDelayMs' ? 0 : 1, max);
  };
  return {
    version: REPLAY_EXECUTOR_VERSION,
    limits: {
      maxSteps: limitOf('maxSteps', EXECUTOR_LIMITS.maxSteps),
      maxRetries: limitOf('maxRetries', EXECUTOR_LIMITS.maxRetries),
      maxRetryDelayMs: limitOf('maxRetryDelayMs', EXECUTOR_LIMITS.maxRetryDelayMs),
      maxTotalVirtualMs: limitOf('maxTotalVirtualMs', EXECUTOR_LIMITS.maxTotalVirtualMs),
    },
    tolerance: source.tolerance,
    validateExpectations: source.validateExpectations !== false,
    stopOnFailure: source.stopOnFailure !== false,
    measureDurations: source.measureDurations === true,
    ignoreBlockers: source.ignoreBlockers === true,
    dryRun: source.dryRun === true,
    // 虚拟时间基准：调用方不给 now 时固定为 0（保证轨迹完全确定）。
    virtualClock: true,
    maxEvidence: clampInt(source.maxEvidence, 1, EXECUTOR_LIMITS.maxEvidence),
  };
}

/** 归一化 providers：未知键忽略；非函数的安全降级。 */
export function normalizeExecutionProviders(providers = {}) {
  const source = isObject(providers) ? providers : {};
  const functionOrNull = (value) => (typeof value === 'function' ? value : null);
  return {
    execute: functionOrNull(source.execute),
    restoreBoundary: functionOrNull(source.restoreBoundary),
    sampleIdentity: functionOrNull(source.sampleIdentity),
    sleep: functionOrNull(source.sleep),
    now: functionOrNull(source.now),
    isCancelled: functionOrNull(source.isCancelled),
  };
}

// ---------------------------------------------------------------------------
// 副作用语义
// ---------------------------------------------------------------------------

/** 单步的副作用画像：确定性地回答“这一步会不会改东西”。 */
function stepEffectOf(step, network) {
  const kind = String(step && (step.kind || step.type) || '');
  const method = String(step && step.method || '').toUpperCase();
  const networkMethod = String(
    (step && step.params && step.params.method)
    || (network && network.method)
    || (method === 'NETWORK.REPLAY' ? 'GET' : ''),
  ).toUpperCase();
  if (kind === 'network' || step.sourceKind === 'network.replay' || method === 'NETWORK.REPLAY') {
    const mutating = MUTATING_METHODS.has(networkMethod);
    return {
      kind: 'network',
      effect: mutating ? 'network-write' : 'network-read',
      method: networkMethod || 'GET',
      mutating,
      idempotent: !mutating,
      compensatable: false,
      potentiallySent: true,
    };
  }
  if (kind === 'branch' || method === 'NAVIGATE') {
    return {
      kind: 'navigation',
      effect: 'document-change',
      method: method || 'navigate',
      mutating: true,
      idempotent: true,
      compensatable: false,
      potentiallySent: false,
    };
  }
  if (kind === 'human') {
    return {
      kind: 'human',
      effect: 'human-gate',
      method: 'human-gate',
      mutating: false,
      idempotent: true,
      compensatable: true,
      potentiallySent: false,
    };
  }
  if (kind === 'observe' || kind === 'wait') {
    return {
      kind,
      effect: 'read',
      method: method || kind,
      mutating: false,
      idempotent: true,
      compensatable: true,
      potentiallySent: false,
    };
  }
  const idempotent = step && step.idempotent === true;
  const risk = String(step && step.risk || 'read_only');
  const mutating = !idempotent && (risk === 'browser_mutation' || risk === 'server_mutation' || kind === 'action');
  return {
    kind: kind || 'action',
    effect: mutating ? 'browser-mutation' : 'read',
    method: method || kind || 'action',
    mutating,
    idempotent,
    compensatable: !mutating,
    potentiallySent: false,
  };
}

/**
 * 副作用语义：整条计划的读写画像（确定性、有界）。
 * 同一份计划两次必得同一 `digest` 与逐字段相同对象。
 * @param {object} plan buildReplayPlan / planNetworkReplay 结果
 * @returns {object}
 */
export function sideEffectSemantics(plan) {
  const steps = stepsOf(plan);
  const network = isObject(plan && plan.network) ? plan.network : null;
  const effects = [];
  const counts = {
    steps: steps.length,
    mutating: 0,
    readOnly: 0,
    navigations: 0,
    humanGates: 0,
    networkSteps: 0,
    observes: 0,
    actions: 0,
    waits: 0,
  };
  for (const step of steps) {
    if (!pieceIsObject(step)) continue;
    const effect = stepEffectOf(step, network);
    counts[effect.mutating ? 'mutating' : 'readOnly'] += 1;
    if (effect.kind === 'network') counts.networkSteps += 1;
    else if (effect.kind === 'navigation') counts.navigations += 1;
    else if (effect.kind === 'human') counts.humanGates += 1;
    else if (effect.kind === 'observe') counts.observes += 1;
    else if (effect.kind === 'wait') counts.waits += 1;
    else counts.actions += 1;
    if (effects.length < EXECUTOR_LIMITS.maxEvidence) {
      effects.push({
        index: Number.isInteger(step.index) ? step.index : effects.length,
        kind: effect.kind,
        effect: effect.effect,
        method: effect.method,
        mutating: effect.mutating,
        idempotent: effect.idempotent,
        potentiallySent: effect.potentiallySent,
      });
    }
  }
  const mutating = counts.mutating > 0 || counts.navigations > 0;
  const profile = {
    version: REPLAY_EXECUTOR_VERSION,
    source: String(plan && plan.source || ''),
    network: network
      ? {
        method: String(network.method || ''),
        sideEffect: network.sideEffect === true,
        crossOrigin: network.crossOrigin === true,
        hasRecordedEntry: network.hasRecordedEntry === true,
        urlResolved: network.urlResolved === true,
      }
      : null,
    mutating,
    risk: mutating ? 'browser_mutation' : 'read_only',
    safeMethod: network ? SAFE_METHODS.has(String(network.method || '').toUpperCase()) : counts.networkSteps === 0,
    counts,
    effects,
  };
  profile.digest = stableHash(stableStringify({
    version: profile.version,
    source: profile.source,
    network: profile.network,
    mutating: profile.mutating,
    risk: profile.risk,
    safeMethod: profile.safeMethod,
    counts: profile.counts,
    effects: profile.effects,
  }));
  return profile;
}

function pieceIsObject(value) {
  return Boolean(value) && typeof value === 'object';
}

/** 副作用的紧凑摘要（挂在 RPC 输出字段上）。 */
export function summarizeSideEffects(semantics) {
  const profile = isObject(semantics) ? semantics : {};
  const counts = isObject(profile.counts) ? profile.counts : {};
  return {
    version: REPLAY_EXECUTOR_VERSION,
    mutating: profile.mutating === true,
    risk: String(profile.risk || 'read_only'),
    mutations: nonNegativeInt(counts.mutating),
    reads: nonNegativeInt(counts.readOnly),
    navigations: nonNegativeInt(counts.navigations),
    humanGates: nonNegativeInt(counts.humanGates),
    networkRequests: nonNegativeInt(counts.networkSteps),
    safeMethod: profile.safeMethod !== false,
    method: profile.network ? shortText(profile.network.method, 20) : '',
    crossOrigin: profile.network ? profile.network.crossOrigin === true : false,
    digest: String(profile.digest || ''),
  };
}

// 内部工具：供 envelope / audit / executor 复用（不属于 RPC 公开字段）。
export { isObject, finiteNumber, nonNegativeInt, clampInt, shortText, utf8Bytes, urlFacts, stepsOf, pieceIsObject, stepEffectOf };
