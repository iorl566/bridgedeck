// mcp/error-map.mjs —— 工具/资源/提示词错误的“恢复映射”层（分类 / 重试建议 / 结构化 envelope）。
//
// 目标（第十批-B ①：错误恢复映射）：tools/call 之前把错误压成一行文本
// `E_XXX: message\n下一步（retry）：hint`，客户端只能靠字符串猜。现在除了保持这行文本
// 逐字节不变（旧客户端不受影响），额外在 _meta 里给结构化恢复信息：
//   - category ：validation / session / transport / cancellation / timeout / resource /
//                approval / protocol / internal（按错误码前缀 + 显式表派生）；
//   - retry    ：yes / no / after-fix / after-action（与 lib/error-codes.mjs 的 recovery 对齐）；
//   - terminal ：该错误是否意味着“这个会话/连接不要再试”（E_SESSION_STOPPED、E_DAEMON...）；
//   - jsonRpcCode：同一条错误在 resources/prompts 路径上应回的 JSON-RPC code（来自 wire.mjs）；
//   - retryPlan：客户端可据此做指数退避重试（attempt / delayMs / maxAttempts / retryable）。
//
// 约束：
//   1. 不新增错误码（错误码清单是 lib/error-codes.mjs 的单一来源，这里只分类）；
//   2. 未知码 → category=unknown、retry=no、terminal=false（不猜、不吞）；
//   3. 纯函数、无 IO；server 启动期跑 auditErrorMap() 保证规则表自洽。
//
// 调用点：mcp/server.mjs 的 tools/call 错误分支（errorEnvelope）、resources/prompts 错误
// 分支（recoveryInline）、initialize experimental['browser-bridge/error-map']；
// 单测 tests/unit/mcp-error-map.test.mjs。

import { recoveryHint } from '../lib/error-codes.mjs';
import { jsonRpcCodeFor } from './wire.mjs';

/** 错误大类。 */
export const ERROR_CATEGORIES = Object.freeze({
  VALIDATION: 'validation',
  SESSION: 'session',
  TRANSPORT: 'transport',
  CANCELLATION: 'cancellation',
  TIMEOUT: 'timeout',
  RESOURCE: 'resource',
  APPROVAL: 'approval',
  PROTOCOL: 'protocol',
  LEDGER: 'ledger',
  INTERNAL: 'internal',
  UNKNOWN: 'unknown',
});

/**
 * 分类规则（顺序匹配，第一条命中即用）。
 * 用前缀表达“族”，个别码用精确表覆盖（例如 E_HUMAN_GATE 属于 approval 而不是 validation）。
 */
export const CATEGORY_RULES = Object.freeze([
  Object.freeze({ pattern: /^E_(ARG|TOKEN|EVAL_DOM_ARGS|UNKNOWN_FLAG|BAD_SUBCOMMAND)/, category: ERROR_CATEGORIES.VALIDATION }),
  Object.freeze({ pattern: /^E_HUMAN_GATE$/, category: ERROR_CATEGORIES.APPROVAL }),
  Object.freeze({ pattern: /^E_CANCEL|^E_REQUEST_CANCELLED$|^E_INPUT_BUSY$/, category: ERROR_CATEGORIES.CANCELLATION }),
  Object.freeze({ pattern: /TIMEOUT|^E_DEADLINE|^E_START_PENDING$|^E_START_NOT_READY$/, category: ERROR_CATEGORIES.TIMEOUT }),
  Object.freeze({ pattern: /^E_DAEMON|^E_CONNECT|^E_DISCONNECTED|^E_WS_|^E_RPC$|^E_ENV$/, category: ERROR_CATEGORIES.TRANSPORT }),
  Object.freeze({ pattern: /^E_SESSION|^E_NO_SESSION|^E_QUEUE_FULL|^E_RATE_LIMITED|^E_TAB_LEASE|^E_NO_TAB$|^E_NO_BROWSER$|^E_BROWSER_AMBIGUOUS$/, category: ERROR_CATEGORIES.SESSION }),
  Object.freeze({ pattern: /^E_LEDGER/, category: ERROR_CATEGORIES.LEDGER }),
  Object.freeze({ pattern: /^E_(NOT_FOUND|STALE_REF|CURSOR_STALE|OBSERVATION_STALE|OBSERVATION_CHANGED|TARGET_DETACHED|SNAPSHOT_CORRUPT|SNAPSHOT_DISABLED|SNAPSHOT_WRITE|CAPTURE_)/, category: ERROR_CATEGORIES.RESOURCE }),
  Object.freeze({ pattern: /^E_(PROTOCOL|UNSUPPORTED|UNKNOWN_METHOD|DEPENDS_FAILED|EXPECT_FAILED|CONTEXT_|COOPERATION_|OPTION_)/, category: ERROR_CATEGORIES.PROTOCOL }),
  Object.freeze({ pattern: /^E_(INTERNAL|UNEXPECTED|CONFIG|STATE)/, category: ERROR_CATEGORIES.INTERNAL }),
]);

/** 明确不可重试（重试只会再撞同一堵墙）的错误族。 */
export const NON_RETRYABLE_CODES = Object.freeze([
  'E_DAEMON',
  'E_DISCONNECTED',
  'E_ENV',
  'E_NO_SESSION',
  'E_SESSION_STOPPED',
  'E_HUMAN_GATE',
  'E_UNSUPPORTED_CAPABILITY',
  'E_UNKNOWN_METHOD',
  'E_PROTOCOL_UNSUPPORTED',
  'E_CANCELLED',
  'E_REQUEST_CANCELLED',
  'E_SNAPSHOT_DISABLED',
  'E_ARG_MISSING',
  'E_ARG_TYPE',
  'E_ARG_ENUM',
  'E_ARG_UNEXPECTED',
  'E_TARGET_DETACHED',
]);

/** 终端错误：会话/连接已不可继续，客户端应重建会话而不是重试同一请求。 */
export const TERMINAL_CODES = Object.freeze([
  'E_DAEMON',
  'E_DISCONNECTED',
  'E_ENV',
  'E_SESSION_STOPPED',
  'E_NO_SESSION',
]);

/** 重试策略默认值（客户端可覆盖；这里给“建议”而不是强制）。 */
export const RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  jitter: true,
  // lib/error-codes.mjs 的 recovery.retry 只有三种取值：no / after-action / transient。
  // 自动重试只对 transient（会话忙、队列满、限流…）有意义；after-action 表示“先做某个动作
  // 再重试”（例如 E_STALE_REF 要重新 observe），不能盲目重放，归入 needs-action。
  retryableRetryModes: Object.freeze(['yes', 'transient']),
  actionRetryModes: Object.freeze(['after-action', 'after-fix']),
});

/**
 * 错误码分类。
 * @param {string} code E_XXX
 * @returns {{ code:string, category:string, retry:string, hint:string, terminal:boolean,
 *             nonRetryable:boolean, jsonRpcCode:number, knownFamily:boolean }}
 */
export function classifyErrorCode(code) {
  const value = String(code || '').trim() || 'E_INTERNAL';
  const rule = CATEGORY_RULES.find((candidate) => candidate.pattern.test(value));
  const category = rule ? rule.category : (value === 'E_INTERNAL' ? ERROR_CATEGORIES.INTERNAL : ERROR_CATEGORIES.UNKNOWN);
  const advice = recoveryHint(value);
  const retry = advice && typeof advice.retry === 'string' && advice.retry ? advice.retry : 'no';
  const terminal = TERMINAL_CODES.includes(value);
  const nonRetryable = NON_RETRYABLE_CODES.includes(value);
  return Object.freeze({
    code: value,
    category,
    retry,
    hint: (advice && advice.hint) || '',
    terminal,
    nonRetryable,
    jsonRpcCode: jsonRpcCodeFor(value),
    knownFamily: Boolean(rule) || value === 'E_INTERNAL',
  });
}

/** 是否值得自动重试（基于码 + 已尝试次数）：只有 transient 类错误会盲目重试。 */
export function isRetryable(code, { attempt = 1, maxAttempts = RETRY_POLICY.maxAttempts } = {}) {
  if (attempt >= maxAttempts) return false;
  const classification = classifyErrorCode(code);
  if (classification.nonRetryable || classification.terminal) return false;
  return RETRY_POLICY.retryableRetryModes.includes(classification.retry);
}

/** 该错误是否属于“先做动作再重试”（needs-action），用于给客户端更准确的下一步。 */
export function needsActionBeforeRetry(code) {
  const classification = classifyErrorCode(code);
  return RETRY_POLICY.actionRetryModes.includes(classification.retry);
}

/** 指数退避 + 可选确定性抖动（抖动只用 attempt/code 派生，不引入随机源，便于测试）。 */
export function retryDelayMs(attempt, { code = '', baseDelayMs = RETRY_POLICY.baseDelayMs, maxDelayMs = RETRY_POLICY.maxDelayMs, jitter = RETRY_POLICY.jitter } = {}) {
  const index = Math.max(0, Number(attempt) || 0);
  const raw = Math.min(maxDelayMs, baseDelayMs * (2 ** index));
  if (!jitter) return raw;
  let seed = 0;
  const text = String(code) + ':' + index;
  for (let cursor = 0; cursor < text.length; cursor += 1) seed = (seed * 31 + text.charCodeAt(cursor)) >>> 0;
  const factor = 0.85 + ((seed % 300) / 1000); // 0.85 .. 1.149
  return Math.max(0, Math.round(Math.min(maxDelayMs, raw * factor)));
}

/**
 * 重试计划（客户端可直接照做；server 只“建议”，不自动重试工具调用）。
 * @returns {{ retryable:boolean, attempt:number, maxAttempts:number, delayMs:number,
 *             reason:string, category:string }}
 */
export function retryPlan(code, { attempt = 1, maxAttempts = RETRY_POLICY.maxAttempts } = {}) {
  const classification = classifyErrorCode(code);
  const retryable = isRetryable(code, { attempt, maxAttempts });
  let reason;
  if (!retryable && attempt >= maxAttempts) reason = 'attempts-exhausted';
  else if (!retryable && classification.nonRetryable) reason = 'non-retryable-code';
  else if (!retryable && needsActionBeforeRetry(code)) reason = 'needs-action';
  else if (!retryable) reason = 'recovery-mode-' + classification.retry;
  else reason = 'retryable-' + classification.retry;
  return Object.freeze({
    retryable,
    attempt: Math.max(1, Number(attempt) || 1),
    maxAttempts,
    delayMs: retryable ? retryDelayMs(attempt - 1, { code }) : 0,
    reason,
    needsAction: !retryable && needsActionBeforeRetry(code),
    category: classification.category,
  });
}

/**
 * 把异常映射成 tools/call 的错误文本（与历史格式逐字节一致）与结构化记录。
 * 历史格式：`<code>: <message>` + （有 hint 时）`\n下一步（<retry>）：<hint>`。
 *
 * @returns {{ text:string, code:string, classification:object, retry:object, record:object }}
 */
export function errorEnvelope(error, { tool = null, tier = null, elapsedMs = null, attempt = 1 } = {}) {
  const code = String((error && error.code) || 'E_INTERNAL');
  const message = String((error && error.message) || error || 'unknown error');
  const classification = classifyErrorCode(code);
  const retry = retryPlan(code, { attempt });
  const advice = recoveryHint(code);
  const text = code + ': ' + message + (advice && advice.hint ? '\n下一步（' + advice.retry + '）：' + advice.hint : '');
  const record = Object.freeze({
    code,
    category: classification.category,
    retry: classification.retry,
    hint: classification.hint,
    terminal: classification.terminal,
    nonRetryable: classification.nonRetryable,
    jsonRpcCode: classification.jsonRpcCode,
    ...(tool ? { tool } : {}),
    ...(tier ? { tier } : {}),
    ...(elapsedMs != null ? { elapsedMs } : {}),
    attempt: retry.attempt,
    retryable: retry.retryable,
    retryDelayMs: retry.delayMs,
    retryReason: retry.reason,
  });
  return Object.freeze({ text, code, classification, retry, record });
}

/** resources/prompts 错误路径的内联 recovery（`-32602 code: message（hint）` 风格）。 */
export function recoveryInline(error, { hint = 'no' } = {}) {
  const classification = classifyErrorCode((error && error.code) || 'E_INTERNAL');
  const message = String((error && error.message) || error || 'unknown error');
  return Object.freeze({
    code: classification.code,
    message,
    rpcCode: classification.jsonRpcCode,
    text: classification.code + ': ' + message + (classification.hint ? '（' + classification.hint + '）' : ''),
    hint,
  });
}

/**
 * 错误映射自检（server 启动期断言）：规则表非空、分类覆盖核心族、不可重试集合有据。
 * @returns {{ ok:boolean, errors:Array<{code:string,message:string}>, rules:number, nonRetryable:number }}
 */
export function auditErrorMap() {
  const errors = [];
  if (!CATEGORY_RULES.length) errors.push({ code: 'error-map-empty', message: '分类规则表为空' });
  const samples = [
    ['E_ARG_MISSING', ERROR_CATEGORIES.VALIDATION],
    ['E_HUMAN_GATE', ERROR_CATEGORIES.APPROVAL],
    ['E_CANCELLED', ERROR_CATEGORIES.CANCELLATION],
    ['E_DAEMON', ERROR_CATEGORIES.TRANSPORT],
    ['E_SESSION_STOPPED', ERROR_CATEGORIES.SESSION],
    ['E_NOT_FOUND', ERROR_CATEGORIES.RESOURCE],
    ['E_PROTOCOL_UNSUPPORTED', ERROR_CATEGORIES.PROTOCOL],
    ['E_LEDGER_IO', ERROR_CATEGORIES.LEDGER],
    ['E_TIMEOUT', ERROR_CATEGORIES.TIMEOUT],
  ];
  for (const [code, expected] of samples) {
    const actual = classifyErrorCode(code).category;
    if (actual !== expected) errors.push({ code: 'error-map-category', message: code + ' 期望 ' + expected + '，实际 ' + actual });
  }
  for (const code of NON_RETRYABLE_CODES) {
    if (classifyErrorCode(code).retry === 'yes') {
      errors.push({ code: 'error-map-retry', message: code + ' 标为不可重试但 recovery 建议 yes' });
    }
  }
  for (const code of TERMINAL_CODES) {
    if (!NON_RETRYABLE_CODES.includes(code)) {
      errors.push({ code: 'error-map-terminal', message: code + ' 是终端错误但不在 NON_RETRYABLE_CODES' });
    }
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors.map((error) => Object.freeze(error))),
    rules: CATEGORY_RULES.length,
    nonRetryable: NON_RETRYABLE_CODES.length,
  });
}

/** strict 包装：规则表自相矛盾时启动即失败。 */
export function assertErrorMap() {
  const report = auditErrorMap();
  if (!report.ok) {
    throw new Error('MCP 错误映射审计失败：\n' + report.errors.map((error) => error.code + ' ' + error.message).join('\n'));
  }
  return report;
}

/** 错误映射能力快照（initialize experimental['browser-bridge/error-map']）。 */
export function errorMapSnapshot() {
  return Object.freeze({
    categories: Object.freeze(Object.values(ERROR_CATEGORIES)),
    rules: CATEGORY_RULES.length,
    retryPolicy: RETRY_POLICY,
    nonRetryable: NON_RETRYABLE_CODES,
    terminal: TERMINAL_CODES,
    metaKey: 'browser-bridge/error',
    recoverySource: 'lib/error-codes.mjs',
  });
}
