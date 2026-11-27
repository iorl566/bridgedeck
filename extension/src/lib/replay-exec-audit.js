// extension/src/lib/replay-exec-audit.js —— 回放执行结果记账层（第二轮，从 replay-executor.js 拆出）。
//
// 单步结果归一、expect 判决、错误分类、执行条目语义键与有界摘要；被
// replay-executor.js 的 runReplayPlan / recordExecutionOutcomes / compareExecutions 复用。
// 纯函数，零时钟/随机。

import { validateStepOutcome } from './replay-diff.js';
import { classifyReplayError, redactMessage } from './replay-explain.js';
import { EXECUTOR_CATALOG_CODES, EXECUTOR_CODES, EXECUTOR_LIMITS, isObject, finiteNumber, nonNegativeInt, shortText, utf8Bytes, urlFacts } from './replay-exec-semantics.js';

// ---------------------------------------------------------------------------
// 单步结果归一 / expect 判决
// ---------------------------------------------------------------------------

/** 从任意 step 执行返回值里抽取语义事实（不保留正文，避免把大对象带进轨迹）。 */
export function normalizeStepOutcomeValue(step, value) {
  const result = isObject(value) ? value : { value };
  const status = finiteNumber(result.status);
  const statusClass = status === null ? null : Math.floor(status / 100) * 100;
  const requestUrl = urlFacts(step && step.params && step.params.url);
  const finalUrl = urlFacts(result.url);
  const redirected = requestUrl.key && finalUrl.key ? requestUrl.key !== finalUrl.key : null;
  const body = typeof result.body === 'string' ? result.body : '';
  const headerCount = isObject(result.headers) ? Object.keys(result.headers).length : 0;
  return {
    ok: result.ok !== false,
    status,
    statusClass,
    statusText: shortText(result.statusText, 60),
    urlOrigin: finalUrl.origin,
    urlKey: finalUrl.key,
    redirected,
    bodyBytes: body ? utf8Bytes(body) : null,
    bodyKind: body ? 'text' : 'empty',
    headerCount,
    durationMs: finiteNumber(result.durationMs),
    valueKind: result.value === undefined ? 'undefined' : (Array.isArray(result.value) ? 'array' : typeof result.value),
    changed: result.changed === true,
    // 供 validateStepOutcome 使用的“可比较事实”（正文不落盘，只在内存里参与比较）。
    facts: {
      ok: result.ok !== false,
      url: finalUrl.valid ? String(result.url || '') : String(result.url || ''),
      finalUrl: String(result.url || ''),
      status,
      headers: isObject(result.headers) ? result.headers : {},
      text: body,
      value: result.value,
      changed: result.changed === true,
      ...(isObject(result.facts) ? result.facts : {}),
    },
  };
}

/** 安全构造“目录码 → 执行错误码”的逆映射（用于 explain）。 */
function catalogCodeOfExecution(code) {
  return EXECUTOR_CATALOG_CODES[code] || '';
}

/** 把执行错误收敛成 {code, catalogCode, category, retriable, message}。 */
export function classifyExecutionError(error, context = {}) {
  const source = error && typeof error === 'object' ? error : { message: String(error || '') };
  const message = String(source.message || source.reason || error || '');
  const originalCode = String(source.code || source.name || '');
  let code = '';
  let retriable = false;
  if (/timeout|timed out|超时/i.test(message) || /TIMEOUT/i.test(originalCode)) {
    code = EXECUTOR_CODES.TIMEOUT;
    retriable = true;
  } else if (/abort|cancel|取消|interrupted/i.test(message) || /CANCEL|ABORT/i.test(originalCode)) {
    code = EXECUTOR_CODES.CANCELLED;
  } else {
    const classified = classifyReplayError(source, { context });
    code = EXECUTOR_CODES.STEP_FAILED;
    retriable = /timeout|network|reset|502|503|504|429|E_JS_ERROR/i.test(originalCode + ' ' + message);
    return {
      code,
      catalogCode: classified.code,
      category: classified.category,
      retriable,
      message: redactMessage(message, EXECUTOR_LIMITS.maxText),
      originalCode: originalCode.slice(0, 80),
    };
  }
  const catalogCode = catalogCodeOfExecution(code);
  return {
    code,
    catalogCode,
    category: code === EXECUTOR_CODES.TIMEOUT ? 'runtime' : code === EXECUTOR_CODES.CANCELLED ? 'runtime' : 'internal',
    retriable,
    message: redactMessage(message, EXECUTOR_LIMITS.maxText),
    originalCode: originalCode.slice(0, 80),
  };
}

/** 单步 expect 判决（复用 replay-diff 的 validateStepOutcome；无 expect 返回 null）。 */
function verdictOfStep(step, outcome, config) {
  if (!step || !isObject(step.expect) || !Object.keys(step.expect).length) return null;
  if (config.validateExpectations === false) return null;
  const verdict = validateStepOutcome(step, outcome.facts, { tolerance: config.tolerance });
  return {
    ok: verdict.ok === true,
    severity: verdict.severity,
    code: verdict.code,
    checks: verdict.checks.length,
    failed: verdict.summary.failed,
    warnings: verdict.summary.warnings,
    unsupported: verdict.unsupported.slice(0, 8),
    differences: verdict.differences.slice(0, 8),
  };
}

// ---------------------------------------------------------------------------
// 单步条目 / 轨迹
// ---------------------------------------------------------------------------

/** 一条执行条目的语义键（用于跨次比较；不含耗时/文案）。 */
function entrySemanticKey(entry) {
  const item = isObject(entry) ? entry : {};
  const result = isObject(item.result) ? item.result : {};
  const verdict = isObject(item.verdict) ? item.verdict : null;
  const boundary = isObject(item.boundary) ? item.boundary : null;
  return [
    nonNegativeInt(item.index),
    String(item.kind || ''),
    String(item.method || ''),
    String(item.status || ''),
    String(item.code || ''),
    nonNegativeInt(item.attempts),
    result.ok === false ? 'fail' : 'ok',
    result.status === null || result.status === undefined ? '-' : String(result.status),
    result.redirected === true ? 'redir' : '',
    result.bodyBytes === null || result.bodyBytes === undefined ? '-' : String(result.bodyBytes),
    verdict ? (verdict.ok ? 'vok' : 'vfail') : '-',
    boundary ? String(boundary.action || '') + ':' + (boundary.ok ? 'ok' : 'blocked') : '',
  ].join('|');
}

/** 单条执行条目的有界证据（RPC/日志用）。 */
function summarizeEntry(entry) {
  if (!isObject(entry)) return null;
  return {
    index: nonNegativeInt(entry.index),
    ref: shortText(entry.ref, 80),
    kind: shortText(entry.kind, 20),
    method: shortText(entry.method, 60),
    status: String(entry.status || ''),
    code: String(entry.code || ''),
    attempts: nonNegativeInt(entry.attempts),
    result: entry.result
      ? {
        ok: entry.result.ok !== false,
        status: entry.result.status === undefined ? null : entry.result.status,
        redirected: entry.result.redirected === true,
        bodyBytes: entry.result.bodyBytes === undefined ? null : entry.result.bodyBytes,
      }
      : null,
    verdict: entry.verdict ? { ok: entry.verdict.ok === true, code: String(entry.verdict.code || ''), failed: nonNegativeInt(entry.verdict.failed) } : null,
    boundary: entry.boundary
      ? { action: String(entry.boundary.action || ''), ok: entry.boundary.ok === true, code: String(entry.boundary.code || '') }
      : null,
    error: entry.error ? { code: String(entry.error.catalogCode || ''), message: shortText(entry.error.message, 160) } : null,
    virtualStartMs: nonNegativeInt(entry.virtualStartMs),
    virtualEndMs: nonNegativeInt(entry.virtualEndMs),
    durationMs: entry.durationMs === null || entry.durationMs === undefined ? null : nonNegativeInt(entry.durationMs),
  };
}

function makeEntry(step, index, extra = {}) {
  return {
    index: nonNegativeInt(index),
    ref: shortText(step && step.ref, 80),
    kind: shortText(step && step.kind, 20),
    method: shortText(step && step.method, 60),
    status: 'planned',
    code: EXECUTOR_CODES.PLANNED,
    attempt: 0,
    attempts: 0,
    result: null,
    verdict: null,
    boundary: null,
    error: null,
    virtualStartMs: 0,
    virtualEndMs: 0,
    durationMs: null,
    ...extra,
  };
}

/** 从边界还原计划里取第 index 步的动作（没有则 null）。 */
function boundaryPlanAt(plan, index) {
  const boundaries = isObject(plan && plan.boundaries) ? plan.boundaries : null;
  const plans = boundaries && Array.isArray(boundaries.plans) ? boundaries.plans : null;
  if (!plans) return null;
  const item = plans[index];
  return isObject(item) ? item : null;
}

/** 需要外部还原器的边界动作。 */
const RESTORE_ACTIONS = new Set(['navigate', 'frame-switch', 'tab-switch']);

// 执行器内部记账 API（由 replay-executor.js 消费）。
export { verdictOfStep, entrySemanticKey, summarizeEntry, makeEntry, boundaryPlanAt, RESTORE_ACTIONS, catalogCodeOfExecution };
