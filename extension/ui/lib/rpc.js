// ui/lib/rpc.js —— 扩展页面到后台/daemon 的 RPC 封装（传输层可注入，Node 可单测）。
//
// 背景：页面里 `chrome.runtime.sendMessage` 在三种情况下不可靠 ——
// 1) service worker 正在重启，sendMessage 会 reject（"Could not establish connection"）；
// 2) 后台处理较慢，页面拿不到超时反馈，用户以为按钮坏了；
// 3) 后台返回 `{ok:false,error:'E_XXX'}`，页面各处自己判断，错误码展示不一致。
//
// 这里统一：超时、有限重试（只重试「连接类」瞬时错误）、错误归一化、可选取消，
// 并把 `bb.daemon.call`（daemon 侧方法）包成 `daemon(method, params)`。
//
// 重要：真正的传输函数由页面传入（`createRpc((msg) => chrome.runtime.sendMessage(msg))`），
// 所以本模块在 Node 里可以直接用假传输单测。

import { describeError } from '../error-hints.js';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 1;

/** 瞬时错误：连接未建立 / 后台正在重启 / 端口关闭（可安全重试一次）。 */
const TRANSIENT_PATTERN = /Could not establish connection|message port closed|Extension context invalidated|Receiving end does not exist|The message port closed/i;

/** 判断错误是否值得重试。 */
export function isTransientError(error) {
  const text = error && error.message ? String(error.message) : String(error === undefined || error === null ? '' : error);
  return TRANSIENT_PATTERN.test(text);
}

/** 把任意回复归一化成 {ok, result, error, code, raw}。 */
export function normalizeReply(reply, { type = '' } = {}) {
  if (reply === undefined || reply === null) {
    return { ok: false, error: 'E_EMPTY_REPLY', message: '空回复', code: 'E_EMPTY_REPLY', type, raw: reply };
  }
  if (typeof reply !== 'object') {
    return { ok: true, result: reply, error: null, code: null, type, raw: reply };
  }
  if (reply.ok === false) {
    const error = reply.error !== undefined && reply.error !== null ? reply.error : (reply.message || 'E_UNKNOWN');
    return { ok: false, error, message: String(reply.message || error), code: errorCodeOf(reply), type, raw: reply };
  }
  // 兼容 `{ ok: true, result }` 与直接返回数据两种后台风格。
  const result = Object.prototype.hasOwnProperty.call(reply, 'result') ? reply.result : reply;
  return { ok: true, result, error: null, code: null, type, raw: reply };
}

/** 取错误码：优先 reply.code / error.code，其次 "E_XXX" 形式字符串，否则 null。 */
export function errorCodeOf(reply) {
  if (!reply || typeof reply !== 'object') return null;
  if (typeof reply.code === 'string' && reply.code) return reply.code;
  const error = reply.error;
  if (error && typeof error === 'object' && typeof error.code === 'string') return error.code;
  if (typeof error === 'string') {
    const match = /^(E_[A-Z0-9_]+)/.exec(error.trim());
    if (match) return match[1];
  }
  return null;
}

/** 本地化错误文本（统一走 12 语言 error-hints）。 */
export function localizeError(error, lang = 'zh') {
  const value = error && typeof error === 'object' && 'error' in error ? error.error : error;
  return describeError(value, lang).text;
}

function raceTimeout(promise, timeoutMs, onTimeout) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      const error = new Error('E_TIMEOUT');
      if (typeof onTimeout === 'function') return onTimeout(error, resolve);
      resolve({ __timeout: true, error });
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 创建 RPC 客户端。
 * @param {(message:object)=>Promise<any>} transport 实际发消息的函数（必须是函数）
 * @param {{timeoutMs?:number, retries?:number, sleep?:(ms:number)=>Promise<void>}} [options]
 */
export function createRpc(transport, options = {}) {
  if (typeof transport !== 'function') throw new TypeError('createRpc: transport 必须是函数');
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const retries = Math.max(0, Number.isFinite(Number(options.retries)) ? Number(options.retries) : DEFAULT_RETRIES);
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const calls = [];

  async function attempt(message) {
    const startedAt = Date.now();
    let lastError = null;
    for (let round = 0; round <= retries; round += 1) {
      try {
        const reply = await raceTimeout(Promise.resolve().then(() => transport(message)), timeoutMs);
        if (reply && reply.__timeout) {
          return { ok: false, error: 'E_TIMEOUT', message: 'RPC 超时', code: 'E_TIMEOUT', type: message && message.type, timeout: true, elapsedMs: Date.now() - startedAt };
        }
        return normalizeReply(reply, { type: message && message.type });
      } catch (error) {
        lastError = error;
        const transient = isTransientError(error);
        if (!transient || round === retries) break;
        await sleep(Math.min(500, 60 * (round + 1)));
      }
    }
    const text = String((lastError && lastError.message) || lastError || 'E_UNKNOWN');
    return {
      ok: false,
      error: /E_TIMEOUT/.test(text) ? 'E_TIMEOUT' : text,
      message: text,
      code: /E_TIMEOUT/.test(text) ? 'E_TIMEOUT' : null,
      type: message && message.type,
      transient: isTransientError(lastError),
      elapsedMs: Date.now() - startedAt,
    };
  }

  return {
    /** 发一条后台消息（type 形如 'bb.debug.history'）。 */
    async send(type, payload) {
      const message = { ...(payload && typeof payload === 'object' ? payload : {}), type };
      const startedAt = Date.now();
      const result = await attempt(message);
      calls.push({ type, ok: result.ok, elapsedMs: Date.now() - startedAt, error: result.error || null });
      if (calls.length > 50) calls.shift();
      return result;
    },
    /** daemon 方法调用（通过后台的 bb.daemon.call 转发）。 */
    async daemon(method, params = {}, daemonOptions = {}) {
      const type = 'bb.daemon.call';
      const startedAt = Date.now();
      const result = await attempt({ type, method, params, timeoutMs: daemonOptions.timeoutMs });
      calls.push({ type, method, ok: result.ok, elapsedMs: Date.now() - startedAt, error: result.error || null });
      if (calls.length > 50) calls.shift();
      if (!result.ok) return result;
      // 后台把 daemon 返回包在 result 里；daemon 自己也可能返回 {ok:false}。
      return normalizeReply(result.result, { type });
    },
    /** 最近调用记录（页面调试/状态栏用）。 */
    get calls() { return calls.slice(); },
    latest() { return calls.length ? calls[calls.length - 1] : null; },
    timeoutMs,
    retries,
  };
}

/** 页面常用：`const rpc = createRpc((message) => chrome.runtime.sendMessage(message))`。 */
export function browserTransport(chromeApi) {
  const api = chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
  return (message) => {
    if (!api || !api.runtime || typeof api.runtime.sendMessage !== 'function') {
      return Promise.reject(new Error('chrome.runtime.sendMessage 不可用'));
    }
    return api.runtime.sendMessage(message);
  };
}

/**
 * 带加载状态的调用（页面里 `withStatus` 包一层简化错误提示）。
 * @returns {Promise<{ok:boolean, result?:any, error?:string}>}
 */
export async function callWithStatus(rpc, type, payload, hooks = {}) {
  if (hooks.onStart) { try { hooks.onStart(); } catch { /* 忽略 */ } }
  const result = await rpc.send(type, payload);
  if (hooks.onFinish) { try { hooks.onFinish(result); } catch { /* 忽略 */ } }
  if (!result.ok && hooks.onError) {
    try { hooks.onError(result, localizeError(result, hooks.lang || 'zh')); } catch { /* 忽略 */ }
  }
  return result;
}
