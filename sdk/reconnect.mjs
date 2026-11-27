// sdk/reconnect.mjs —— Node SDK 的传输重连策略（状态机 / 退避 / 重连编排）。
//
// 目标（第十一批-C ⑤：Node client 传输/重连）：
//   sdk/mcp-client.mjs 之前只支持“一次性连接”：server 子进程退出、连接被半开管道拖死、
//   机器休眠后 ws/pipe 断开，调用方只能自己重新 new 一个 client 并手动重放握手/订阅。
//   本模块把重连拆成可测试的三层：
//     1. 策略：resolveReconnectPolicy() 归一化开关/次数/退避上限（默认关闭，避免悄悄重放副作用）；
//     2. 状态机：ReconnectTracker 记录 connected/disconnected/reconnecting/failed 与计数，
//        给 client.transportSnapshot() 提供结构化证据；
//     3. 编排：runReconnect(connectFn) 按退避序列尝试重建连接，失败有界并返回完整尝试记录。
//
// 设计约束：
//   1. 默认不重连（enabled=false）：工具调用可能有副作用，自动重放必须是显式选择；
//   2. 客户端侧纯逻辑：本模块不 spawn 进程、不读盘；真实重连由 McpClient 注入 connectFn；
//   3. 抖动确定性：抖动只用 attempt + 错误码派生（与 mcp/error-map.mjs 的 retryDelayMs 同思路），
//      便于测试断言，不引入 Math.random；
//   4. 只对“连接类”错误重连：E_DISCONNECTED / E_DAEMON / E_TIMEOUT（传输已被 kill）等；
//      参数/审批/业务错误绝不触发重连。
//
// 调用点：sdk/mcp-client.mjs（McpClient 的 reconnect 选项 / ensureConnected / callToolDetailed）、
// sdk/index.mjs 导出；单测 tests/unit/sdk-reconnect.test.mjs。

import { RETRY_POLICY } from '../mcp/error-map.mjs';

/** 重连默认策略。 */
export const RECONNECT_DEFAULTS = Object.freeze({
  enabled: false,
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 4_000,
  jitter: true,
  /** 重连成功后是否自动 ping 做健康检查。 */
  healthCheck: true,
  /** 重连后是否自动恢复本客户端登记的资源订阅（best-effort）。 */
  resubscribe: true,
  handshakeTimeoutMs: 12_000,
  /** 默认只对幂等工具自动重放（非幂等工具需显式 opt-in）。 */
  retryIdempotentOnly: true,
});

/** 会触发重连的错误码（传输/连接类；业务错误不在内）。 */
export const RECONNECTABLE_CODES = Object.freeze([
  'E_DISCONNECTED',
  'E_DAEMON',
  'E_CONNECT',
  'E_RPC',
  'E_TIMEOUT',
  'E_WS_CLOSED',
  'E_WS_ERROR',
]);

/** 重连状态。 */
export const RECONNECT_STATES = Object.freeze({
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
});

/** 重连事件原因码。 */
export const RECONNECT_REASONS = Object.freeze({
  NONE: 'none',
  DISCONNECT: 'disconnect',
  NOT_CONNECTED: 'not-connected',
  HEALTH_FAILED: 'health-check-failed',
  ATTEMPTS_EXHAUSTED: 'attempts-exhausted',
  DISABLED: 'disabled',
  CLOSED: 'client-closed',
  NON_IDEMPOTENT: 'non-idempotent-tool',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/**
 * 归一化重连配置。
 * 接受布尔（true = 默认参数开启）或对象；非法字段回落到默认值。
 * @param {boolean|object|null} option
 * @returns {{enabled:boolean, maxAttempts:number, baseDelayMs:number, maxDelayMs:number,
 *             jitter:boolean, healthCheck:boolean, resubscribe:boolean,
 *             handshakeTimeoutMs:number, retryIdempotentOnly:boolean}}
 */
export function resolveReconnectPolicy(option = null) {
  if (option == null || option === false) {
    return Object.freeze({ ...RECONNECT_DEFAULTS, enabled: false });
  }
  if (option === true) return Object.freeze({ ...RECONNECT_DEFAULTS, enabled: true });
  const bag = isPlainObject(option) ? option : {};
  const enabled = bag.enabled == null ? true : Boolean(bag.enabled);
  const maxAttempts = Math.min(positiveInt(bag.maxAttempts, RECONNECT_DEFAULTS.maxAttempts), 16);
  return Object.freeze({
    enabled,
    maxAttempts,
    baseDelayMs: Math.min(positiveInt(bag.baseDelayMs, RECONNECT_DEFAULTS.baseDelayMs), 60_000),
    maxDelayMs: Math.min(positiveInt(bag.maxDelayMs, RECONNECT_DEFAULTS.maxDelayMs), 120_000),
    jitter: bag.jitter == null ? RECONNECT_DEFAULTS.jitter : Boolean(bag.jitter),
    healthCheck: bag.healthCheck == null ? RECONNECT_DEFAULTS.healthCheck : Boolean(bag.healthCheck),
    resubscribe: bag.resubscribe == null ? RECONNECT_DEFAULTS.resubscribe : Boolean(bag.resubscribe),
    handshakeTimeoutMs: Math.min(positiveInt(bag.handshakeTimeoutMs, RECONNECT_DEFAULTS.handshakeTimeoutMs), 120_000),
    retryIdempotentOnly: bag.retryIdempotentOnly == null ? RECONNECT_DEFAULTS.retryIdempotentOnly : Boolean(bag.retryIdempotentOnly),
  });
}

/** 判断错误是否值得重连（码 + 可选 method 过滤）。 */
export function isReconnectableError(error) {
  const code = String((error && error.code) || '');
  if (!code) return Object.freeze({ reconnectable: false, reason: 'no-code', code });
  if (!RECONNECTABLE_CODES.includes(code)) {
    return Object.freeze({ reconnectable: false, reason: 'non-reconnectable-code', code });
  }
  return Object.freeze({ reconnectable: true, reason: 'connection-error', code });
}

/**
 * 第 attempt 次重连前的退避时间（确定性抖动；attempt 从 0 开始）。
 * @param {number} attempt
 * @param {object} [policy]
 * @param {{code?:string}} [options]
 */
export function backoffDelayMs(attempt, policy = RECONNECT_DEFAULTS, { code = '' } = {}) {
  const resolved = isPlainObject(policy) ? { ...RECONNECT_DEFAULTS, ...policy } : RECONNECT_DEFAULTS;
  const index = Math.max(0, Number(attempt) || 0);
  const raw = Math.min(resolved.maxDelayMs, resolved.baseDelayMs * (2 ** index));
  if (!resolved.jitter) return Math.max(0, Math.round(raw));
  let seed = 0;
  const text = String(code) + ':' + index + ':reconnect';
  for (let cursor = 0; cursor < text.length; cursor += 1) seed = (seed * 31 + text.charCodeAt(cursor)) >>> 0;
  const factor = 0.8 + ((seed % 400) / 1000); // 0.8 .. 1.199
  return Math.max(0, Math.round(Math.min(resolved.maxDelayMs, raw * factor)));
}

/**
 * 重连状态机（纯内存；不负责真正的 connect）。
 */
export class ReconnectTracker {
  constructor({ policy = RECONNECT_DEFAULTS, now = () => Date.now() } = {}) {
    this.policy = isPlainObject(policy) ? { ...policy } : { ...RECONNECT_DEFAULTS };
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.state = RECONNECT_STATES.DISCONNECTED;
    this.attempts = 0;
    this.totalAttempts = 0;
    this.connects = 0;
    this.failures = 0;
    this.events = [];
    this.startedAt = this.now();
    this.lastConnectedAt = null;
    this.lastFailure = null;
  }

  _push(type, detail = {}) {
    this.events.push(Object.freeze({ type, at: new Date(this.now()).toISOString(), ...detail }));
    if (this.events.length > 64) this.events.splice(0, this.events.length - 64);
    return this;
  }

  recordConnected() {
    this.state = RECONNECT_STATES.CONNECTED;
    this.connects += 1;
    this.attempts = 0;
    this.lastConnectedAt = this.now();
    this._push('connected');
    return this;
  }

  recordDisconnect(error = null) {
    this.state = RECONNECT_STATES.DISCONNECTED;
    this.lastFailure = error ? { code: (error && error.code) || null, message: String((error && error.message) || error) } : null;
    this._push('disconnect', { code: (error && error.code) || null });
    return this;
  }

  /** 是否还能再试一次（次数 + 开关）。 */
  canRetry() {
    if (!this.policy.enabled) {
      this._push('retry-denied', { reason: RECONNECT_REASONS.DISABLED });
      return false;
    }
    if (this.attempts >= this.policy.maxAttempts) {
      this._push('retry-denied', { reason: RECONNECT_REASONS.ATTEMPTS_EXHAUSTED });
      return false;
    }
    return true;
  }

  beginAttempt(error = null) {
    this.attempts += 1;
    this.totalAttempts += 1;
    this.state = RECONNECT_STATES.RECONNECTING;
    const delayMs = backoffDelayMs(this.attempts - 1, this.policy, { code: (error && error.code) || '' });
    this._push('attempt', { attempt: this.attempts, delayMs, code: (error && error.code) || null });
    return Object.freeze({ attempt: this.attempts, maxAttempts: this.policy.maxAttempts, delayMs });
  }

  recordFailed(error = null) {
    this.failures += 1;
    this.lastFailure = error ? { code: (error && error.code) || null, message: String((error && error.message) || error) } : { code: null, message: 'unknown' };
    this.state = this.attempts >= this.policy.maxAttempts ? RECONNECT_STATES.FAILED : RECONNECT_STATES.DISCONNECTED;
    this._push('attempt-failed', { attempt: this.attempts, code: (error && error.code) || null });
    return this;
  }

  snapshot() {
    return Object.freeze({
      state: this.state,
      attempts: this.attempts,
      totalAttempts: this.totalAttempts,
      connects: this.connects,
      failures: this.failures,
      maxAttempts: this.policy.maxAttempts,
      lastConnectedAt: this.lastConnectedAt == null ? null : new Date(this.lastConnectedAt).toISOString(),
      lastFailure: this.lastFailure,
      events: Object.freeze([...this.events]),
    });
  }
}

/**
 * 重连编排：按退避序列尝试 connectFn，直到成功或耗尽次数。
 * connectFn 负责“清理旧传输 + 新建传输 + 握手 + 恢复订阅”，每轮只调用一次。
 *
 * @param {(context:{attempt:number, maxAttempts:number, error:Error|null}) => Promise<any>} connectFn
 * @param {{policy?:object, tracker?:ReconnectTracker, error?:Error|null,
 *          sleep?:(ms:number)=>Promise<void>, onEvent?:(event:object)=>void}} [options]
 * @returns {Promise<{connected:boolean, attempts:number, elapsedMs:number,
 *                    errors:ReadonlyArray<{attempt:number, code:string, message:string}>, result:any,
 *                    reason:string}>}
 */
export async function runReconnect(connectFn, { policy = RECONNECT_DEFAULTS, tracker = null, error = null, sleep = null, onEvent = null } = {}) {
  if (typeof connectFn !== 'function') throw new Error('runReconnect 需要 connectFn');
  const resolved = isPlainObject(policy) ? { ...RECONNECT_DEFAULTS, ...policy } : { ...RECONNECT_DEFAULTS };
  const state = tracker || new ReconnectTracker({ policy: resolved });
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startedAt = Date.now();
  const errors = [];
  const emit = (event) => { if (typeof onEvent === 'function') { try { onEvent(event); } catch { /* 事件回调失败不影响重连 */ } } };
  if (!resolved.enabled) {
    return Object.freeze({ connected: false, attempts: 0, elapsedMs: 0, errors: Object.freeze([]), result: null, reason: RECONNECT_REASONS.DISABLED });
  }
  let lastError = error || null;
  while (state.canRetry()) {
    const info = state.beginAttempt(lastError);
    emit({ phase: 'attempt', ...info });
    if (info.delayMs > 0) await wait(info.delayMs);
    try {
      const result = await connectFn({ attempt: info.attempt, maxAttempts: info.maxAttempts, error: lastError });
      state.recordConnected();
      emit({ phase: 'connected', attempt: info.attempt });
      return Object.freeze({
        connected: true,
        attempts: info.attempt,
        elapsedMs: Date.now() - startedAt,
        errors: Object.freeze(errors),
        result,
        reason: RECONNECT_REASONS.NONE,
      });
    } catch (attemptError) {
      lastError = attemptError;
      state.recordFailed(attemptError);
      errors.push(Object.freeze({
        attempt: info.attempt,
        code: String((attemptError && attemptError.code) || 'E_DISCONNECTED'),
        message: String((attemptError && attemptError.message) || attemptError),
      }));
      emit({ phase: 'attempt-failed', attempt: info.attempt, code: String((attemptError && attemptError.code) || 'E_DISCONNECTED') });
    }
  }
  return Object.freeze({
    connected: false,
    attempts: state.attempts,
    elapsedMs: Date.now() - startedAt,
    errors: Object.freeze(errors),
    result: null,
    reason: RECONNECT_REASONS.ATTEMPTS_EXHAUSTED,
  });
}

/** 能力快照（sdk/index.mjs 导出 / 测试用）。 */
export function reconnectSnapshot() {
  return Object.freeze({
    supported: true,
    defaults: RECONNECT_DEFAULTS,
    reconnectableCodes: RECONNECTABLE_CODES,
    states: RECONNECT_STATES,
    reasons: RECONNECT_REASONS,
    retryPolicy: RETRY_POLICY,
    methods: Object.freeze(['ensureConnected', 'transportSnapshot', 'syncResourceSubscriptions']),
    note: '默认关闭；enabled=true 时只在连接类错误上重建传输，非幂等工具默认不自动重放',
  });
}
