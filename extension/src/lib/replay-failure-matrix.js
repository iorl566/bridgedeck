// extension/src/lib/replay-failure-matrix.js —— 回放失败注入矩阵与恢复建议（纯函数，零 chrome）。
//
// 回放的真实失败不是“报错了”四个字：超时可能是请求已发出（不能盲重试）、404 是路由/录制
// 失效（重试无用）、连接失败可能是浏览器/daemon 掉了、重定向可能改变了副作用落点。
// 本模块用一张**确定性矩阵**把这类失败按“能不能重试 / 要不要先对账 / 是否必须人工”分类，
// 并给出有序恢复建议，供命令包装层附加到失败解释上。
//
//   1) FAILURE_INJECTIONS：超时/404/500/429/连接失败/DNS/连接重置/重定向（含循环、跨源）/
//      CORS/取消/正文截断/文档失效/帧脱离/人工超时/预算耗尽 —— 每个都带 stage、触发形态、
//      期望语义与恢复动作；
//   2) classifyReplayFailure：任意错误/HTTP 响应 → 矩阵码 + category + retriable +
//      safeToRetry + sideEffectPossible + needsHuman + 重试计划；
//   3) recoveryPlanFor：有序恢复动作（先对账副作用、再退避重试、再导航/刷新/人工），
//      动作有稳定码与文案；
//   4) runFailureMatrix：对一份真实计划跑整张矩阵（默认全本地注入，不产生网络），
//      输出每格分类/恢复与整体摘要，用于“回放失败语义”自检。
//
// 不变量：
//   - 默认不产生任何真实副作用：默认 execute 只是按 cell 抛出/返回本地对象；
//   - 确定性：无时钟/随机数；退避延迟是纯函数（由 cell/attempt 算出）；
//   - 有界：单元格/动作/文本都有上限。
//
// 运行时消费者：extension/src/replay.js（replayFailureMatrixCommand / 失败包装层的
// recovery 字段）与 replay-explain 的失败目录配合使用。

import { stableHash } from '../record-steps.js';
import { classifyReplayError, explainFailure } from './replay-explain.js';
import { stableStringify } from './replay-plan.js';

/** 矩阵版本。 */
export const REPLAY_FAILURE_MATRIX_VERSION = 2;

/** 注入矩阵上限。 */
export const MATRIX_LIMITS = Object.freeze({
  maxCells: 32,
  maxActions: 6,
  maxAttempts: 5,
  baseRetryDelayMs: 250,
  maxRetryDelayMs: 8000,
  maxText: 300,
  maxSuggestions: 6,
});

/** 矩阵结果码。 */
export const MATRIX_CODES = Object.freeze({
  OK: 'MATRIX_OK',
  TIMEOUT: 'MATRIX_TIMEOUT',
  HTTP_NOT_FOUND: 'MATRIX_HTTP_404',
  HTTP_RETRYABLE: 'MATRIX_HTTP_RETRYABLE',
  HTTP_CLIENT_ERROR: 'MATRIX_HTTP_CLIENT_ERROR',
  RATE_LIMITED: 'MATRIX_RATE_LIMITED',
  CONNECTION_FAILED: 'MATRIX_CONNECTION_FAILED',
  DNS_FAILURE: 'MATRIX_DNS_FAILURE',
  CONNECTION_RESET: 'MATRIX_CONNECTION_RESET',
  REDIRECTED: 'MATRIX_REDIRECTED',
  REDIRECT_LOOP: 'MATRIX_REDIRECT_LOOP',
  REDIRECT_CROSS_ORIGIN: 'MATRIX_REDIRECT_CROSS_ORIGIN',
  CORS_BLOCKED: 'MATRIX_CORS_BLOCKED',
  CANCELLED: 'MATRIX_CANCELLED',
  BODY_TRUNCATED: 'MATRIX_BODY_TRUNCATED',
  STALE_DOCUMENT: 'MATRIX_STALE_DOCUMENT',
  FRAME_DETACHED: 'MATRIX_FRAME_DETACHED',
  HUMAN_TIMEOUT: 'MATRIX_HUMAN_TIMEOUT',
  BUDGET_EXCEEDED: 'MATRIX_BUDGET_EXCEEDED',
  UNKNOWN: 'MATRIX_UNKNOWN',
});

/** 恢复动作目录：码 → 稳定中文标签。 */
export const RECOVERY_ACTIONS = Object.freeze({
  'verify-side-effects': '先只读对账服务端/页面状态，确认上一次请求是否已生效',
  'retry-with-backoff': '按退避计划重试（幂等或已对账的前提下）',
  'extend-timeout': '延长单步超时或缩小请求体后重试',
  'honor-retry-after': '尊重服务端 Retry-After，稍后再试',
  'navigate-recorded-url': '先导航回录制 URL（plan.boundaries 的 navigate），再重放',
  'verify-route': '核对当前路由/页面与录制是否同一文档',
  're-record': '重新录制该段（录制已失效，不再强行重放）',
  'check-server-health': '检查服务端健康/依赖，确认不是持续 5xx',
  'check-browser-daemon': '检查浏览器连接与 bridge daemon 状态（status）',
  'verify-host-dns': '核对主机名/端口与 DNS 解析（hosts/代理）',
  'follow-recorded-redirect': '按录制记录跟随重定向，不要用当前落地页重放',
  'verify-final-url': '校验最终 URL 与录制一致（重定向改变了落点）',
  'inspect-redirect-chain': '检查重定向链（cookie/登录态/路由规则）',
  'fix-auth-cookies': '重新登录/补 cookie 后再回放',
  'run-same-origin': '改在同源上下文执行，或显式接受 CORS 限制',
  'verify-cors': '核对目标源 CORS/凭据配置',
  'rebind-targets': '按目标还原计划重新绑定元素',
  'refresh-frame': '刷新页面并重新枚举帧树，再切回录制帧',
  'request-human-help': '请求人工协助（human-gate/验证码/登录）',
  'split-program': '把程序拆小后分段回放',
  'raise-budget': '提高回放预算（确认安全后）',
  'compare-digest': '用观测指纹/摘要对比，避免比对被截断的正文',
  'accept-observation': '接受该观测差异（仅当已确认语义等价）',
  stop: '停止回放，等待人工判断',
});

/** 注入类型（稳定顺序，报告用）。 */
export const INJECTION_KINDS = Object.freeze([
  'timeout',
  'http-404',
  'http-500',
  'http-429',
  'connection-refused',
  'dns-failure',
  'connection-reset',
  'redirect',
  'redirect-loop',
  'redirect-cross-origin',
  'cors-blocked',
  'abort',
  'body-truncated',
  'stale-document',
  'frame-detached',
  'human-timeout',
  'budget-exceeded',
]);

/**
 * 失败注入矩阵：每个 cell 是一次真实失败形态的“确定性描述”。
 * trigger.stage：before（执行前）/ execute（执行时抛错）/ response（拿到失败响应）/ observation（观测异常）。
 */
export const FAILURE_INJECTIONS = Object.freeze([
  Object.freeze({
    id: 'timeout',
    kind: 'timeout',
    label: '请求超时',
    stage: 'execute',
    trigger: Object.freeze({ errorCode: 'E_TIMEOUT', errorMessage: 'network replay 超时（15000ms）', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.TIMEOUT, category: 'network', retriable: true, safeToRetry: false, sideEffectPossible: true, needsHuman: false, retryAfterMs: 250, maxAttempts: 2 }),
    recovery: Object.freeze(['verify-side-effects', 'retry-with-backoff', 'extend-timeout']),
  }),
  Object.freeze({
    id: 'http-404',
    kind: 'http-404',
    label: '目标不存在（404）',
    stage: 'response',
    trigger: Object.freeze({ errorCode: '', errorMessage: 'HTTP 404 Not Found', httpStatus: 404 }),
    expectations: Object.freeze({ code: MATRIX_CODES.HTTP_NOT_FOUND, category: 'network', retriable: false, safeToRetry: false, sideEffectPossible: false, needsHuman: false, retryAfterMs: 0, maxAttempts: 0 }),
    recovery: Object.freeze(['navigate-recorded-url', 'verify-route', 're-record']),
  }),
  Object.freeze({
    id: 'http-500',
    kind: 'http-500',
    label: '服务端错误（500）',
    stage: 'response',
    trigger: Object.freeze({ errorCode: '', errorMessage: 'HTTP 500 Internal Server Error', httpStatus: 500 }),
    expectations: Object.freeze({ code: MATRIX_CODES.HTTP_RETRYABLE, category: 'network', retriable: true, safeToRetry: false, sideEffectPossible: true, needsHuman: false, retryAfterMs: 500, maxAttempts: 3 }),
    recovery: Object.freeze(['verify-side-effects', 'retry-with-backoff', 'check-server-health']),
  }),
  Object.freeze({
    id: 'http-429',
    kind: 'http-429',
    label: '限流（429）',
    stage: 'response',
    trigger: Object.freeze({ errorCode: '', errorMessage: 'HTTP 429 Too Many Requests', httpStatus: 429 }),
    expectations: Object.freeze({ code: MATRIX_CODES.RATE_LIMITED, category: 'network', retriable: true, safeToRetry: false, sideEffectPossible: true, needsHuman: false, retryAfterMs: 2000, maxAttempts: 3 }),
    recovery: Object.freeze(['honor-retry-after', 'verify-side-effects', 'retry-with-backoff']),
  }),
  Object.freeze({
    id: 'connection-refused',
    kind: 'connection-refused',
    label: '连接被拒绝',
    stage: 'execute',
    trigger: Object.freeze({ errorCode: 'E_JS_ERROR', errorMessage: 'fetch 失败：net::ERR_CONNECTION_REFUSED', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.CONNECTION_FAILED, category: 'network', retriable: true, safeToRetry: true, sideEffectPossible: false, needsHuman: false, retryAfterMs: 750, maxAttempts: 2 }),
    recovery: Object.freeze(['check-browser-daemon', 'retry-with-backoff']),
  }),
  Object.freeze({
    id: 'dns-failure',
    kind: 'dns-failure',
    label: '域名解析失败',
    stage: 'execute',
    trigger: Object.freeze({ errorCode: 'E_JS_ERROR', errorMessage: 'fetch 失败：net::ERR_NAME_NOT_RESOLVED', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.DNS_FAILURE, category: 'network', retriable: false, safeToRetry: false, sideEffectPossible: false, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 }),
    recovery: Object.freeze(['verify-host-dns', 'navigate-recorded-url', 'request-human-help']),
  }),
  Object.freeze({
    id: 'connection-reset',
    kind: 'connection-reset',
    label: '连接被重置',
    stage: 'execute',
    trigger: Object.freeze({ errorCode: 'E_JS_ERROR', errorMessage: 'fetch 失败：net::ERR_CONNECTION_RESET', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.CONNECTION_RESET, category: 'network', retriable: true, safeToRetry: false, sideEffectPossible: true, needsHuman: false, retryAfterMs: 500, maxAttempts: 2 }),
    recovery: Object.freeze(['verify-side-effects', 'retry-with-backoff']),
  }),
  Object.freeze({
    id: 'redirect',
    kind: 'redirect',
    label: '响应发生重定向',
    stage: 'observation',
    trigger: Object.freeze({ errorCode: 'NETWORK_REPLAY_REDIRECTED', errorMessage: '最终 URL 与请求 URL 不同（重定向已跟随）', httpStatus: 302 }),
    expectations: Object.freeze({ code: MATRIX_CODES.REDIRECTED, category: 'network', retriable: false, safeToRetry: false, sideEffectPossible: true, needsHuman: false, retryAfterMs: 0, maxAttempts: 0 }),
    recovery: Object.freeze(['follow-recorded-redirect', 'verify-final-url', 'verify-side-effects']),
  }),
  Object.freeze({
    id: 'redirect-loop',
    kind: 'redirect-loop',
    label: '重定向循环',
    stage: 'execute',
    trigger: Object.freeze({ errorCode: 'E_JS_ERROR', errorMessage: 'fetch 失败：net::ERR_TOO_MANY_REDIRECTS', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.REDIRECT_LOOP, category: 'network', retriable: false, safeToRetry: false, sideEffectPossible: true, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 }),
    recovery: Object.freeze(['inspect-redirect-chain', 'fix-auth-cookies', 'request-human-help']),
  }),
  Object.freeze({
    id: 'redirect-cross-origin',
    kind: 'redirect-cross-origin',
    label: '跨源重定向（凭据可能丢失）',
    stage: 'observation',
    trigger: Object.freeze({ errorCode: 'NETWORK_REPLAY_CROSS_ORIGIN', errorMessage: '重定向到不同源的地址', httpStatus: 307 }),
    expectations: Object.freeze({ code: MATRIX_CODES.REDIRECT_CROSS_ORIGIN, category: 'network', retriable: false, safeToRetry: false, sideEffectPossible: true, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 }),
    recovery: Object.freeze(['verify-final-url', 'run-same-origin', 'request-human-help']),
  }),
  Object.freeze({
    id: 'cors-blocked',
    kind: 'cors-blocked',
    label: 'CORS 阻断',
    stage: 'execute',
    trigger: Object.freeze({ errorCode: 'E_JS_ERROR', errorMessage: 'fetch 失败：TypeError: Failed to fetch（CORS）', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.CORS_BLOCKED, category: 'network', retriable: false, safeToRetry: false, sideEffectPossible: false, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 }),
    recovery: Object.freeze(['run-same-origin', 'verify-cors', 'request-human-help']),
  }),
  Object.freeze({
    id: 'abort',
    kind: 'abort',
    label: '回放被取消',
    stage: 'execute',
    trigger: Object.freeze({ errorCode: 'E_CANCELLED', errorMessage: '回放已取消', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.CANCELLED, category: 'runtime', retriable: false, safeToRetry: false, sideEffectPossible: true, needsHuman: false, retryAfterMs: 0, maxAttempts: 0 }),
    recovery: Object.freeze(['verify-side-effects', 'stop']),
  }),
  Object.freeze({
    id: 'body-truncated',
    kind: 'body-truncated',
    label: '响应正文被截断',
    stage: 'observation',
    trigger: Object.freeze({ errorCode: 'OBSERVATION_TRUNCATED', errorMessage: '响应正文超过观测上限，比对可能不完整', httpStatus: 200 }),
    expectations: Object.freeze({ code: MATRIX_CODES.BODY_TRUNCATED, category: 'diff', retriable: false, safeToRetry: false, sideEffectPossible: false, needsHuman: false, retryAfterMs: 0, maxAttempts: 0 }),
    recovery: Object.freeze(['compare-digest', 'accept-observation']),
  }),
  Object.freeze({
    id: 'stale-document',
    kind: 'stale-document',
    label: '文档身份已变化',
    stage: 'before',
    trigger: Object.freeze({ errorCode: 'BOUNDARY_STALE_DOCUMENT', errorMessage: '执行前 documentId 已与录制不一致', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.STALE_DOCUMENT, category: 'boundary', retriable: true, safeToRetry: true, sideEffectPossible: false, needsHuman: false, retryAfterMs: 400, maxAttempts: 1 }),
    recovery: Object.freeze(['navigate-recorded-url', 'rebind-targets', 'retry-with-backoff']),
  }),
  Object.freeze({
    id: 'frame-detached',
    kind: 'frame-detached',
    label: '目标帧已脱离',
    stage: 'execute',
    trigger: Object.freeze({ errorCode: 'E_TARGET_DETACHED', errorMessage: '目标节点所在 frame 已脱离', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.FRAME_DETACHED, category: 'boundary', retriable: true, safeToRetry: true, sideEffectPossible: false, needsHuman: false, retryAfterMs: 350, maxAttempts: 1 }),
    recovery: Object.freeze(['refresh-frame', 'rebind-targets', 'retry-with-backoff']),
  }),
  Object.freeze({
    id: 'human-timeout',
    kind: 'human-timeout',
    label: '人工介入超时',
    stage: 'before',
    trigger: Object.freeze({ errorCode: 'REPLAY_HUMAN_REQUIRED', errorMessage: 'human-gate 等待超时', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.HUMAN_TIMEOUT, category: 'human', retriable: false, safeToRetry: false, sideEffectPossible: false, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 }),
    recovery: Object.freeze(['request-human-help', 'stop']),
  }),
  Object.freeze({
    id: 'budget-exceeded',
    kind: 'budget-exceeded',
    label: '回放预算耗尽',
    stage: 'before',
    trigger: Object.freeze({ errorCode: 'PLAN_RETRY_BUDGET', errorMessage: '总重试次数/等待时长超过回放预算', httpStatus: null }),
    expectations: Object.freeze({ code: MATRIX_CODES.BUDGET_EXCEEDED, category: 'plan', retriable: false, safeToRetry: false, sideEffectPossible: false, needsHuman: false, retryAfterMs: 0, maxAttempts: 0 }),
    recovery: Object.freeze(['split-program', 'raise-budget', 'stop']),
  }),
]);

const CELL_BY_ID = new Map(FAILURE_INJECTIONS.map((cell) => [cell.id, cell]));
const CELL_BY_KIND = new Map(FAILURE_INJECTIONS.map((cell) => [cell.kind, cell]));

/** 按 id 取注入格（找不到返回 null）。 */
export function getInjection(id) {
  return CELL_BY_ID.get(String(id || '')) || null;
}

/** 按 id/kind 选注入格（未知值忽略；无参数返回全部）。 */
export function selectInjections(selection) {
  const list = Array.isArray(selection) ? selection : (selection === undefined || selection === null ? null : [selection]);
  if (!list) return FAILURE_INJECTIONS.slice();
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const key = typeof item === 'string' ? item : (item && (item.id || item.kind));
    const cell = CELL_BY_ID.get(String(key || '')) || CELL_BY_KIND.get(String(key || ''));
    if (!cell || seen.has(cell.id)) continue;
    seen.add(cell.id);
    out.push(cell);
  }
  return out.slice(0, MATRIX_LIMITS.maxCells);
}

// ---------------------------------------------------------------------------
// 注入构造
// ---------------------------------------------------------------------------

/**
 * 构造注入错误对象（不抛；由调用方 throw）。
 * @param {object} cell
 * @returns {Error}
 */
export function injectedError(cell) {
  const source = cell && cell.trigger ? cell : (CELL_BY_KIND.get(String(cell || '')) || null);
  const error = new Error(source ? source.trigger.errorMessage : '注入的未知回放失败');
  error.name = 'ReplayInjectedError';
  error.code = source ? source.trigger.errorCode : 'E_INTERNAL';
  if (source) error.injectionId = source.id;
  if (!source) error.data = { injected: true };
  return error;
}

/** 构造注入的失败响应（本地对象；不发请求）。 */
export function injectedResponse(cell) {
  const source = cell && cell.trigger ? cell : (CELL_BY_KIND.get(String(cell || '')) || null);
  const status = source && Number.isFinite(Number(source.trigger.httpStatus)) ? Number(source.trigger.httpStatus) : 200;
  const injection = source ? source.id : 'unknown';
  const baseUrl = 'https://a.test/api';
  const redirected = source && source.kind === 'redirect';
  const body = source && source.kind === 'body-truncated'
    ? 'x'.repeat(300)
    : '{"injected":"' + injection + '"}';
  return {
    status,
    statusText: 'Injected ' + injection,
    headers: { 'content-type': 'application/json', 'x-injected': injection },
    body,
    durationMs: 0,
    url: redirected ? 'https://b.test/landing' : baseUrl,
  };
}

// ---------------------------------------------------------------------------
// 失败分类
// ---------------------------------------------------------------------------

/** 从错误/响应里推断 HTTP 状态。 */
function httpStatusOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (Number.isFinite(Number(value.httpStatus))) return Number(value.httpStatus);
  if (Number.isFinite(Number(value.status))) return Number(value.status);
  if (value.error && Number.isFinite(Number(value.error.httpStatus))) return Number(value.error.httpStatus);
  return null;
}

/** 从错误/响应里找注入 cell（code / injectionId / 文案匹配）。 */
function cellOfFailure(value, context) {
  if (context && context.cell) {
    return typeof context.cell === 'string' ? getInjection(context.cell) : context.cell;
  }
  if (!value || typeof value !== 'object') return null;
  const direct = String(value.injectionId || value.injection || '') || String((value.error && value.error.injectionId) || '');
  if (direct && getInjection(direct)) return getInjection(direct);
  const code = String(value.code || value.errorCode || (value.error && value.error.code) || '');
  for (const cell of FAILURE_INJECTIONS) {
    if (cell.trigger.errorCode && cell.trigger.errorCode === code) return cell;
  }
  const message = String(value.message || (value.error && value.error.message) || value.errorText || '');
  for (const cell of FAILURE_INJECTIONS) {
    if (cell.trigger.httpStatus && Number(cell.trigger.httpStatus) === httpStatusOf(value)) return cell;
    if (message && cell.trigger.errorMessage && (message === cell.trigger.errorMessage || message.includes(cell.trigger.errorMessage))) return cell;
  }
  return null;
}

/** 方法是否 mutating（决定“安全重试”）。 */
function methodIsMutating(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

/** 消息启发式 → 矩阵码（无 cell 时兜底）。 */
function classifyByMessage(message, status) {
  const text = String(message || '');
  if (/too many redirects|ERR_TOO_MANY_REDIRECTS|重定向循环/i.test(text)) return MATRIX_CODES.REDIRECT_LOOP;
  if (/ERR_CONNECTION_REFUSED|connection refused|连接被拒绝/i.test(text)) return MATRIX_CODES.CONNECTION_FAILED;
  if (/ERR_NAME_NOT_RESOLVED|DNS|域名解析/i.test(text)) return MATRIX_CODES.DNS_FAILURE;
  if (/ERR_CONNECTION_RESET|ECONNRESET|连接重置/i.test(text)) return MATRIX_CODES.CONNECTION_RESET;
  if (/CORS|Failed to fetch/i.test(text)) return MATRIX_CODES.CORS_BLOCKED;
  if (/timeout|timed out|超时/i.test(text)) return MATRIX_CODES.TIMEOUT;
  if (/abort|cancel|取消/i.test(text)) return MATRIX_CODES.CANCELLED;
  if (status !== null) {
    if (status === 404) return MATRIX_CODES.HTTP_NOT_FOUND;
    if (status === 429) return MATRIX_CODES.RATE_LIMITED;
    if (status >= 500 && status <= 599) return MATRIX_CODES.HTTP_RETRYABLE;
    if (status >= 400 && status <= 499) return MATRIX_CODES.HTTP_CLIENT_ERROR;
    if (status >= 300 && status <= 399) return MATRIX_CODES.REDIRECTED;
  }
  return MATRIX_CODES.UNKNOWN;
}

/** 分类码 → 默认语义（无注入格时用）。 */
const CODE_DEFAULTS = Object.freeze({
  [MATRIX_CODES.TIMEOUT]: { category: 'network', retriable: true, sideEffectPossible: true, needsHuman: false, retryAfterMs: 250, maxAttempts: 2 },
  [MATRIX_CODES.HTTP_NOT_FOUND]: { category: 'network', retriable: false, sideEffectPossible: false, needsHuman: false, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.HTTP_RETRYABLE]: { category: 'network', retriable: true, sideEffectPossible: true, needsHuman: false, retryAfterMs: 500, maxAttempts: 3 },
  [MATRIX_CODES.HTTP_CLIENT_ERROR]: { category: 'network', retriable: false, sideEffectPossible: false, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.RATE_LIMITED]: { category: 'network', retriable: true, sideEffectPossible: true, needsHuman: false, retryAfterMs: 2000, maxAttempts: 3 },
  [MATRIX_CODES.CONNECTION_FAILED]: { category: 'network', retriable: true, sideEffectPossible: false, needsHuman: false, retryAfterMs: 750, maxAttempts: 2 },
  [MATRIX_CODES.DNS_FAILURE]: { category: 'network', retriable: false, sideEffectPossible: false, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.CONNECTION_RESET]: { category: 'network', retriable: true, sideEffectPossible: true, needsHuman: false, retryAfterMs: 500, maxAttempts: 2 },
  [MATRIX_CODES.REDIRECTED]: { category: 'network', retriable: false, sideEffectPossible: true, needsHuman: false, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.REDIRECT_LOOP]: { category: 'network', retriable: false, sideEffectPossible: true, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.REDIRECT_CROSS_ORIGIN]: { category: 'network', retriable: false, sideEffectPossible: true, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.CORS_BLOCKED]: { category: 'network', retriable: false, sideEffectPossible: false, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.CANCELLED]: { category: 'runtime', retriable: false, sideEffectPossible: true, needsHuman: false, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.BODY_TRUNCATED]: { category: 'diff', retriable: false, sideEffectPossible: false, needsHuman: false, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.STALE_DOCUMENT]: { category: 'boundary', retriable: true, sideEffectPossible: false, needsHuman: false, retryAfterMs: 400, maxAttempts: 1 },
  [MATRIX_CODES.FRAME_DETACHED]: { category: 'boundary', retriable: true, sideEffectPossible: false, needsHuman: false, retryAfterMs: 350, maxAttempts: 1 },
  [MATRIX_CODES.HUMAN_TIMEOUT]: { category: 'human', retriable: false, sideEffectPossible: false, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.BUDGET_EXCEEDED]: { category: 'plan', retriable: false, sideEffectPossible: false, needsHuman: false, retryAfterMs: 0, maxAttempts: 0 },
  [MATRIX_CODES.UNKNOWN]: { category: 'internal', retriable: false, sideEffectPossible: true, needsHuman: true, retryAfterMs: 0, maxAttempts: 0 },
});

/** 矩阵码 → 第一轮失败目录码（只映射语义确实一致的；其余靠矩阵自带文案解释）。 */
const MATRIX_CATALOG_CODES = Object.freeze({
  [MATRIX_CODES.TIMEOUT]: 'REPLAY_TIMEOUT',
  [MATRIX_CODES.CANCELLED]: 'REPLAY_CANCELLED',
  [MATRIX_CODES.STALE_DOCUMENT]: 'BOUNDARY_STALE_DOCUMENT',
  [MATRIX_CODES.FRAME_DETACHED]: 'BOUNDARY_FRAME_UNAVAILABLE',
  [MATRIX_CODES.HUMAN_TIMEOUT]: 'PLAN_HUMAN_REQUIRED',
  [MATRIX_CODES.BUDGET_EXCEEDED]: 'PLAN_RETRY_BUDGET',
  [MATRIX_CODES.REDIRECT_CROSS_ORIGIN]: 'NETWORK_REPLAY_CROSS_ORIGIN',
  [MATRIX_CODES.CORS_BLOCKED]: 'NETWORK_REPLAY_CROSS_ORIGIN',
});

/** 矩阵码 → 默认恢复动作（无 cell 时用）。 */
const CODE_RECOVERY = Object.freeze({
  [MATRIX_CODES.TIMEOUT]: ['verify-side-effects', 'retry-with-backoff', 'extend-timeout'],
  [MATRIX_CODES.HTTP_NOT_FOUND]: ['navigate-recorded-url', 'verify-route', 're-record'],
  [MATRIX_CODES.HTTP_RETRYABLE]: ['verify-side-effects', 'retry-with-backoff', 'check-server-health'],
  [MATRIX_CODES.HTTP_CLIENT_ERROR]: ['request-human-help', 'stop'],
  [MATRIX_CODES.RATE_LIMITED]: ['honor-retry-after', 'verify-side-effects', 'retry-with-backoff'],
  [MATRIX_CODES.CONNECTION_FAILED]: ['check-browser-daemon', 'retry-with-backoff'],
  [MATRIX_CODES.DNS_FAILURE]: ['verify-host-dns', 'navigate-recorded-url', 'request-human-help'],
  [MATRIX_CODES.CONNECTION_RESET]: ['verify-side-effects', 'retry-with-backoff'],
  [MATRIX_CODES.REDIRECTED]: ['follow-recorded-redirect', 'verify-final-url', 'verify-side-effects'],
  [MATRIX_CODES.REDIRECT_LOOP]: ['inspect-redirect-chain', 'fix-auth-cookies', 'request-human-help'],
  [MATRIX_CODES.REDIRECT_CROSS_ORIGIN]: ['verify-final-url', 'run-same-origin', 'request-human-help'],
  [MATRIX_CODES.CORS_BLOCKED]: ['run-same-origin', 'verify-cors', 'request-human-help'],
  [MATRIX_CODES.CANCELLED]: ['verify-side-effects', 'stop'],
  [MATRIX_CODES.BODY_TRUNCATED]: ['compare-digest', 'accept-observation'],
  [MATRIX_CODES.STALE_DOCUMENT]: ['navigate-recorded-url', 'rebind-targets', 'retry-with-backoff'],
  [MATRIX_CODES.FRAME_DETACHED]: ['refresh-frame', 'rebind-targets', 'retry-with-backoff'],
  [MATRIX_CODES.HUMAN_TIMEOUT]: ['request-human-help', 'stop'],
  [MATRIX_CODES.BUDGET_EXCEEDED]: ['split-program', 'raise-budget', 'stop'],
  [MATRIX_CODES.UNKNOWN]: ['verify-side-effects', 'request-human-help', 'stop'],
});

/** 可重试码的安全上限（防止矩阵输出“无限重试”建议）。 */
function attemptsFor(code, defaults, cell) {
  if (cell && cell.expectations) return Math.min(MATRIX_LIMITS.maxAttempts, Math.max(0, Number(cell.expectations.maxAttempts) || 0));
  return Math.min(MATRIX_LIMITS.maxAttempts, Math.max(0, Number(defaults.maxAttempts) || 0));
}

/**
 * 分类一次回放失败（错误对象 / HTTP 响应 / 注入格）。
 * @param {unknown} value 抛出的错误或失败响应
 * @param {{cell?:string|object, method?:string, stage?:string, plan?:object}} [context]
 * @returns {object}
 */
export function classifyReplayFailure(value, context = {}) {
  const source = value && typeof value === 'object' ? value : { message: String(value || '') };
  const cell = cellOfFailure(source, context);
  const status = httpStatusOf(source);
  const method = String(context.method || (context.plan && context.plan.network && context.plan.network.method) || 'GET').toUpperCase();
  const mutating = methodIsMutating(method);
  const message = String(source.message || (source.error && source.error.message) || source.errorText || '');
  const code = cell ? cell.expectations.code : classifyByMessage(message, status);
  const defaults = CODE_DEFAULTS[code] || CODE_DEFAULTS[MATRIX_CODES.UNKNOWN];
  const base = cell ? cell.expectations : defaults;
  const retriable = base.retriable === true;
  const needsHuman = base.needsHuman === true || (defaults.needsHuman === true && !cell);
  // 只读请求没有副作用风险；写请求在“请求可能已发出”的失败形态下必须先对账。
  const sideEffectPossible = mutating
    && (base.sideEffectPossible === true || retriable || code === MATRIX_CODES.REDIRECTED);
  // 读请求可安全重试；写请求只有 cell 明确声明“无副作用且可重试”时才允许。
  const safeToRetry = retriable && (!mutating || (base.safeToRetry === true && base.sideEffectPossible !== true));
  const retryAfterMs = Math.min(MATRIX_LIMITS.maxRetryDelayMs, Math.max(0, Number(base.retryAfterMs) || 0));
  const maxAttempts = attemptsFor(code, defaults, cell);
  const catalogCode = MATRIX_CATALOG_CODES[code] || '';
  const explanation = catalogCode
    ? explainFailure({ code: catalogCode, error: source.error ? source.error : { code: String(source.code || ''), message } })
    : null;
  const classification = {
    version: REPLAY_FAILURE_MATRIX_VERSION,
    code,
    injection: cell ? cell.id : null,
    kind: cell ? cell.kind : 'unknown',
    label: cell ? cell.label : '未归类失败',
    category: String((cell && cell.expectations.category) || defaults.category || 'internal'),
    stage: String(context.stage || (cell && cell.stage) || 'execute'),
    httpStatus: status,
    retriable,
    safeToRetry,
    needsHuman,
    sideEffectPossible,
    retry: {
      allowed: safeToRetry,
      maxAttempts,
      retryAfterMs,
      reason: safeToRetry
        ? (mutating ? '写请求已确认可重试（对账后）' : '读请求可安全重试')
        : (retriable ? '重试前必须先对账副作用（写请求）' : '该失败重试无意义'),
    },
    catalog: explanation
      ? { code: explanation.code, category: explanation.category, title: explanation.title, hint: explanation.hint, retriable: explanation.retriable }
      : null,
    message: message.slice(0, MATRIX_LIMITS.maxText),
    explanation,
  };
  classification.signature = stableHash([
    classification.code,
    classification.injection || '',
    classification.stage,
    String(classification.retriable),
    String(classification.safeToRetry),
    String(classification.sideEffectPossible),
    String(classification.needsHuman),
    String(maxAttempts) + 'x' + String(retryAfterMs),
    String(status === null ? '' : status),
    method,
  ].join('|'));
  return classification;
}

// ---------------------------------------------------------------------------
// 重试计划 / 恢复建议
// ---------------------------------------------------------------------------

/**
 * 确定性退避计划：delay(attempt) = retryAfterMs * 2^(attempt-1)，封顶 maxRetryDelayMs。
 * @param {object} classification
 * @param {{maxAttempts?:number, baseDelayMs?:number}} [options]
 */
export function retrySchedule(classification, options = {}) {
  const source = classification && typeof classification === 'object' ? classification : {};
  if (source.safeToRetry !== true) return [];
  const maxAttempts = Math.min(
    MATRIX_LIMITS.maxAttempts,
    Math.max(0, Number(options.maxAttempts !== undefined ? options.maxAttempts : source.retry && source.retry.maxAttempts) || 0),
  );
  const base = Math.max(1, Number(options.baseDelayMs !== undefined ? options.baseDelayMs : (source.retry && source.retry.retryAfterMs)) || MATRIX_LIMITS.baseRetryDelayMs);
  const out = [];
  let atMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const delayMs = Math.min(MATRIX_LIMITS.maxRetryDelayMs, base * Math.pow(2, attempt - 1));
    atMs += delayMs;
    out.push({ attempt, delayMs, atMs });
  }
  return out;
}

/**
 * 恢复计划：把分类转成有序动作（副作用对账永远排在最前）。
 * @param {object} classification classifyReplayFailure 输出
 * @param {{cell?:object}} [context]
 * @returns {object}
 */
export function recoveryPlanFor(classification, context = {}) {
  const source = classification && typeof classification === 'object' ? classification : classifyReplayFailure(null, context);
  const cell = source.injection ? getInjection(source.injection) : null;
  const actionCodes = (cell && cell.recovery) || CODE_RECOVERY[source.code] || CODE_RECOVERY[MATRIX_CODES.UNKNOWN];
  const schedule = retrySchedule(source);
  const actions = [];
  const seen = new Set();
  const push = (code, extra = {}) => {
    const text = String(code || '');
    if (!text || seen.has(text) || !RECOVERY_ACTIONS[text]) return;
    if (actions.length >= MATRIX_LIMITS.maxActions) return;
    seen.add(text);
    actions.push({
      order: actions.length + 1,
      action: text,
      label: RECOVERY_ACTIONS[text],
      ...extra,
    });
  };
  // 副作用风险优先：先对账，后重试。
  if (source.sideEffectPossible === true) push('verify-side-effects', { priority: 'first' });
  for (const code of actionCodes) {
    if (code === 'retry-with-backoff' && schedule.length) {
      push(code, { retry: { attempts: schedule.length, delays: schedule.map((item) => item.delayMs) } });
      continue;
    }
    push(code);
  }
  if (source.needsHuman === true && !seen.has('request-human-help')) push('request-human-help');
  if (!actions.length) push('stop');
  const stopRecommended = !source.retriable || source.needsHuman === true || actions.some((item) => item.action === 'stop');
  const primary = actions[0] || null;
  const plan = {
    version: REPLAY_FAILURE_MATRIX_VERSION,
    ok: actions.length > 0,
    code: source.code,
    category: source.category,
    primary,
    actions,
    retry: schedule.length
      ? { attempts: schedule.length, delays: schedule.map((item) => item.delayMs), atMs: schedule.map((item) => item.atMs) }
      : null,
    stopRecommended,
    needsHuman: source.needsHuman === true,
    sideEffectPossible: source.sideEffectPossible === true,
    text: '',
  };
  plan.text = actions.map((item) => (item.order === 1 ? '' : '  ') + (item.order) + '. ' + item.label).join('\n');
  plan.signature = stableHash([source.signature || '', actions.map((item) => item.action).join('>'), stopRecommended ? 'stop' : 'go'].join('|'));
  return plan;
}

// ---------------------------------------------------------------------------
// 矩阵运行
// ---------------------------------------------------------------------------

/**
 * 默认执行器：按 cell 的 stage 本地注入（不发网络、不碰 chrome）。
 * before/execute → 抛 injectedError；response/observation → 返回本地响应对象。
 */
export function defaultInjectionExecutor(cell) {
  const source = cell && cell.trigger ? cell : getInjection(cell) || FAILURE_INJECTIONS[0];
  if (source.stage === 'before' || source.stage === 'execute') throw injectedError(source);
  return injectedResponse(source);
}

/**
 * 跑整张失败注入矩阵。
 * @param {object} plan 回放计划（提供 network.method/token 等；可为 null）
 * @param {{execute?:Function, injections?:Array<string|object>, method?:string,
 *          maxCells?:number, includeUntargeted?:boolean}} [options]
 * @returns {object}
 */
export function runFailureMatrix(plan, options = {}) {
  const cells = selectInjections(options.injections).slice(0, Math.max(1, Math.min(MATRIX_LIMITS.maxCells, Number(options.maxCells) || MATRIX_LIMITS.maxCells)));
  const method = String(options.method || (plan && plan.network && plan.network.method) || 'GET').toUpperCase();
  const execute = typeof options.execute === 'function' ? options.execute : (cell) => defaultInjectionExecutor(cell);
  const results = [];
  for (const cell of cells) {
    let value = null;
    let thrown = null;
    try {
      value = execute(cell, { plan, method });
    } catch (error) {
      thrown = error;
    }
    const failureInput = thrown || value;
    const classification = classifyReplayFailure(failureInput, { cell, method, stage: cell.stage, plan });
    const recovery = recoveryPlanFor(classification, { cell });
    const explained = Boolean(classification.code && classification.label && recovery.actions.length > 0);
    results.push({
      id: cell.id,
      kind: cell.kind,
      label: cell.label,
      stage: cell.stage,
      outcome: thrown ? 'threw' : 'response',
      thrown: Boolean(thrown),
      classification: {
        code: classification.code,
        category: classification.category,
        retriable: classification.retriable,
        safeToRetry: classification.safeToRetry,
        needsHuman: classification.needsHuman,
        sideEffectPossible: classification.sideEffectPossible,
        httpStatus: classification.httpStatus,
        retry: classification.retry,
        catalogCode: classification.catalog ? classification.catalog.code : '',
        message: classification.message,
        signature: classification.signature,
      },
      recovery: {
        ok: recovery.ok,
        primary: recovery.primary ? recovery.primary.action : '',
        actions: recovery.actions.map((item) => item.action),
        retry: recovery.retry,
        stopRecommended: recovery.stopRecommended,
        signature: recovery.signature,
      },
      explained,
    });
  }
  const byKind = {};
  const byCategory = {};
  const byCode = {};
  for (const item of results) {
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
    byCategory[item.classification.category] = (byCategory[item.classification.category] || 0) + 1;
    byCode[item.classification.code] = (byCode[item.classification.code] || 0) + 1;
  }
  const explained = results.filter((item) => item.explained).length;
  const matrix = {
    version: REPLAY_FAILURE_MATRIX_VERSION,
    ok: explained === results.length,
    method,
    deterministic: true,
    networkUsed: options.execute ? 'injected-execute' : 'local-injection',
    total: results.length,
    explained,
    unexplained: results.length - explained,
    byKind,
    byCategory,
    byCode,
    retriable: results.filter((item) => item.classification.retriable).length,
    needsHuman: results.filter((item) => item.classification.needsHuman).length,
    sideEffectRisk: results.filter((item) => item.classification.sideEffectPossible).length,
    cells: results,
    advice: matrixRecoveryAdvice({ cells: results }),
    digest: '',
  };
  matrix.digest = matrixDigest(results);
  return matrix;
}

/** 矩阵指纹：只包含每格分类码/语义/恢复动作（确定性）。 */
export function matrixDigest(cellsIn) {
  const cells = Array.isArray(cellsIn) ? cellsIn : [];
  return stableHash(cells.map((item) => [
    String(item && item.id || ''),
    String(item && item.classification && item.classification.code || ''),
    String(item && item.classification && item.classification.retriable),
    String(item && item.classification && item.classification.safeToRetry),
    String(item && item.classification && item.classification.needsHuman),
    (item && item.recovery && item.recovery.actions ? item.recovery.actions : []).join('>'),
  ].join('|')).join('>'));
}

/** 汇总恢复建议：按动作聚合出现次数（稳定排序），给出“先做什么”。 */
export function matrixRecoveryAdvice(matrix) {
  const cells = matrix && Array.isArray(matrix.cells) ? matrix.cells : [];
  const counts = new Map();
  for (const item of cells) {
    for (const action of (item.recovery && item.recovery.actions) || []) counts.set(action, (counts.get(action) || 0) + 1);
  }
  const actions = [...counts.entries()]
    .map(([action, count]) => ({ action, label: RECOVERY_ACTIONS[action] || action, count }))
    .sort((left, right) => right.count - left.count || left.action.localeCompare(right.action));
  return {
    actions: actions.slice(0, MATRIX_LIMITS.maxActions),
    firstAction: actions.length ? actions[0].action : '',
    stopRecommended: cells.some((item) => item.recovery && item.recovery.stopRecommended),
    needsHuman: cells.some((item) => item.classification && item.classification.needsHuman),
    sideEffectRisk: cells.some((item) => item.classification && item.classification.sideEffectPossible),
  };
}

// ---------------------------------------------------------------------------
// 摘要 / 文本
// ---------------------------------------------------------------------------

/** 矩阵摘要（RPC 字段：有界、稳定）。 */
export function summarizeFailureMatrix(matrix) {
  if (!matrix || typeof matrix !== 'object') return null;
  return {
    version: REPLAY_FAILURE_MATRIX_VERSION,
    ok: matrix.ok === true,
    method: String(matrix.method || ''),
    total: Number(matrix.total) || 0,
    explained: Number(matrix.explained) || 0,
    unexplained: Number(matrix.unexplained) || 0,
    byCategory: matrix.byCategory || {},
    byCode: matrix.byCode || {},
    retriable: Number(matrix.retriable) || 0,
    needsHuman: Number(matrix.needsHuman) || 0,
    sideEffectRisk: Number(matrix.sideEffectRisk) || 0,
    cells: (matrix.cells || []).slice(0, 8).map((item) => ({
      id: String(item.id || ''),
      kind: String(item.kind || ''),
      code: String(item.classification && item.classification.code || ''),
      category: String(item.classification && item.classification.category || ''),
      retriable: item.classification && item.classification.retriable === true,
      safeToRetry: item.classification && item.classification.safeToRetry === true,
      needsHuman: item.classification && item.classification.needsHuman === true,
      actions: (item.recovery && item.recovery.actions ? item.recovery.actions : []).slice(0, 4),
    })),
    advice: matrix.advice || null,
    digest: String(matrix.digest || ''),
  };
}

/** 文本矩阵（日志/CLI 展示；有界）。 */
export function formatFailureMatrix(matrix, options = {}) {
  const summary = summarizeFailureMatrix(matrix);
  if (!summary) return '失败注入矩阵：无结果';
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : 30;
  const lines = [];
  lines.push('失败注入矩阵 ' + (summary.ok ? '全部可解释' : '存在未解释格')
    + '：' + summary.explained + '/' + summary.total + ' 格（method ' + summary.method + '）');
  for (const cell of summary.cells) {
    lines.push('- ' + cell.id + ' → ' + cell.code + ' [' + cell.category + ']'
      + (cell.retriable ? ' 可重试' + (cell.safeToRetry ? '(安全)' : '(需先对账)') : ' 不可重试')
      + (cell.needsHuman ? ' 需人工' : '')
      + ' 建议：' + (cell.actions.slice(0, 2).join(' → ') || 'stop'));
  }
  if (summary.advice && summary.advice.firstAction) {
    lines.push('首行动作：' + summary.advice.firstAction + '（' + (RECOVERY_ACTIONS[summary.advice.firstAction] || '') + '）');
  }
  if (summary.sideEffectRisk > 0) lines.push('⚠ ' + summary.sideEffectRisk + ' 格可能已产生副作用：重试前先对账');
  return lines.slice(0, maxLines).join('\n');
}

/** 单格恢复文本（失败报告里附一段话）。 */
export function formatRecoveryPlan(plan, options = {}) {
  if (!plan || typeof plan !== 'object') return '恢复建议：无';
  const maxActions = Number.isInteger(options.maxActions) ? options.maxActions : MATRIX_LIMITS.maxActions;
  const lines = ['恢复建议（' + String(plan.code || '') + '）'];
  for (const action of (plan.actions || []).slice(0, maxActions)) {
    lines.push('  ' + action.order + '. ' + action.label);
  }
  if (plan.retry && plan.retry.attempts) {
    lines.push('  重试：' + plan.retry.attempts + ' 次，退避 ' + plan.retry.delays.join('/') + ' ms');
  }
  if (plan.stopRecommended) lines.push('  建议先停下等人工判断');
  return lines.join('\n');
}

/** 把分类/恢复附加到一次失败解释上（只加字段，不改原解释）。 */
export function attachMatrixRecovery(explanation, matrixResult) {
  if (!explanation || typeof explanation !== 'object') return explanation;
  if (!matrixResult || typeof matrixResult !== 'object') return explanation;
  explanation.failureMatrix = {
    version: REPLAY_FAILURE_MATRIX_VERSION,
    code: String(matrixResult.code || ''),
    category: String(matrixResult.category || ''),
    retriable: matrixResult.retriable === true,
    safeToRetry: matrixResult.safeToRetry === true,
    needsHuman: matrixResult.needsHuman === true,
    sideEffectPossible: matrixResult.sideEffectPossible === true,
    recovery: matrixResult.recovery || null,
    signature: String(matrixResult.signature || ''),
  };
  return explanation;
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/** 矩阵自检：cell 唯一、码唯一、恢复动作都在目录里（测试/门禁用）。 */
export function verifyFailureMatrixCatalog() {
  const issues = [];
  const ids = new Set();
  const kinds = new Set();
  for (const cell of FAILURE_INJECTIONS) {
    if (ids.has(cell.id)) issues.push({ code: 'MATRIX_DUPLICATE_ID', id: cell.id });
    ids.add(cell.id);
    if (kinds.has(cell.kind)) issues.push({ code: 'MATRIX_DUPLICATE_KIND', kind: cell.kind });
    kinds.add(cell.kind);
    if (!cell.recovery.length) issues.push({ code: 'MATRIX_EMPTY_RECOVERY', id: cell.id });
    for (const action of cell.recovery) {
      if (!RECOVERY_ACTIONS[action]) issues.push({ code: 'MATRIX_UNKNOWN_ACTION', id: cell.id, action });
    }
    if (cell.stage !== 'before' && cell.stage !== 'execute' && cell.stage !== 'response' && cell.stage !== 'observation') {
      issues.push({ code: 'MATRIX_BAD_STAGE', id: cell.id, stage: cell.stage });
    }
    if (!Number.isInteger(cell.expectations.maxAttempts) || cell.expectations.maxAttempts < 0 || cell.expectations.maxAttempts > MATRIX_LIMITS.maxAttempts) {
      issues.push({ code: 'MATRIX_BAD_ATTEMPTS', id: cell.id, attempts: cell.expectations.maxAttempts });
    }
  }
  for (const kind of INJECTION_KINDS) {
    if (!kinds.has(kind)) issues.push({ code: 'MATRIX_MISSING_KIND', kind });
  }
  return { ok: issues.length === 0, issues, cells: FAILURE_INJECTIONS.length, kinds: INJECTION_KINDS.length };
}

/** 分类/恢复指纹（跨次比较用）。 */
export function failureMatrixPlanDigest(matrix) {
  if (!matrix || typeof matrix !== 'object') return '';
  if (matrix.digest) return String(matrix.digest);
  return matrixDigest(matrix.cells || []);
}

// 显式引用：保证导出的分类器与第一轮 explain 的分类器在同一套“未知异常”语义上，
// 二者不会因为文案规则漂移给出互相矛盾的 category。
export const MATRIX_UNKNOWN_ERROR_CLASSIFIER = Object.freeze({
  classify: (error) => classifyReplayError(error, {}),
  version: REPLAY_FAILURE_MATRIX_VERSION,
});

/** 稳定序列化（测试/日志用）。 */
export function serializeFailureMatrix(matrix) {
  return stableStringify(summarizeFailureMatrix(matrix));
}
