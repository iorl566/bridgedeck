// dsh-plugin/lib/fake-adapter.mjs —— 可脚本化假 daemon（与 lib/daemon-rpc.mjs 同形）。
//
// 目的：没有 daemon、没有浏览器时，插件工具也能被完整单测。接口与 daemonRpc 一致：
//   call(method, params, { timeoutMs }) -> Promise<result>，失败抛 DaemonRpcError。
//
// 脚本能力：
//   - 按 method 注册 handler：函数 / { result } / { error } / { delayMs }；
//   - 记录完整调用序列（method/params/options/结果/错误/耗时），可 reset()；
//   - 未注册方法默认抛 E_UNKNOWN_METHOD；script.unavailable=true 时全部抛 E_DAEMON；
//   - delayMs 超过本次 timeoutMs 时按真实超时抛 E_TIMEOUT（不会睡满 delay）。
//
// 本文件不联网、不 spawn、不读 daemon.json；生产路径不会自动加载它。
import { DaemonRpcError } from './daemon-rpc.mjs';

const DEFAULT_TIMEOUT_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function normalizeError(error, method) {
  if (typeof error === 'string' && error) return { code: error, message: error, data: undefined };
  if (error && typeof error === 'object' && typeof error.code === 'string' && error.code) {
    return { code: error.code, message: String(error.message || error.code), data: clone(error.data) };
  }
  throw new TypeError('fake adapter：方法 ' + method + ' 的 error 需要 { code, message }');
}

function normalizeHandler(handler, method) {
  if (typeof handler === 'function') {
    return { run: handler, delayMs: 0 };
  }
  if (!handler || typeof handler !== 'object' || Array.isArray(handler)) {
    throw new TypeError('fake adapter：方法 ' + method + ' 的 handler 需要函数或对象');
  }
  const hasResult = Object.prototype.hasOwnProperty.call(handler, 'result');
  const error = handler.error === undefined ? null : normalizeError(handler.error, method);
  if (!hasResult && !error) {
    throw new TypeError('fake adapter：方法 ' + method + ' 的 handler 需要 result 或 error');
  }
  return {
    result: clone(handler.result),
    error,
    delayMs: Math.max(0, Number(handler.delayMs) || 0),
  };
}

export class FakeDaemonAdapter {
  /**
   * @param {{ handlers?: Record<string, unknown>, responses?: Record<string, unknown>, unavailable?: boolean,
   *           defaultDelayMs?: number, defaultTimeoutMs?: number }} [script]
   *   handlers / responses 二选一（同义）；unavailable 模拟 daemon 未运行。
   * @param {{ clock?: () => number }} [options]
   */
  constructor(script = {}, options = {}) {
    const source = script || {};
    this.calls = [];
    this.script = {
      handlers: {},
      unavailable: source.unavailable === true,
      defaultDelayMs: Math.max(0, Number(source.defaultDelayMs) || 0),
      defaultTimeoutMs: Number.isFinite(Number(source.defaultTimeoutMs)) && Number(source.defaultTimeoutMs) > 0
        ? Number(source.defaultTimeoutMs)
        : DEFAULT_TIMEOUT_MS,
    };
    this.clock = options && typeof options.clock === 'function' ? options.clock : () => Date.now();
    // 绑定后可直接传给 buildToolSpecs(run, { rpc: adapter.call })。
    this.call = this.call.bind(this);
    const handlers = source.handlers || source.responses || {};
    for (const [method, handler] of Object.entries(handlers)) this.register(method, handler);
  }

  /** 注册/覆盖一个方法。 */
  register(method, handler) {
    this.script.handlers[String(method)] = normalizeHandler(handler, method);
    return this;
  }

  /** 批量注册。 */
  registerAll(map) {
    for (const [method, handler] of Object.entries(map || {})) this.register(method, handler);
    return this;
  }

  unregister(method) {
    delete this.script.handlers[String(method)];
    return this;
  }

  has(method) {
    return Object.prototype.hasOwnProperty.call(this.script.handlers, String(method));
  }

  methods() {
    return Object.keys(this.script.handlers).sort();
  }

  reset() {
    this.calls.length = 0;
    return this;
  }

  callsFor(method) {
    return this.calls.filter((entry) => entry.method === String(method));
  }

  lastCall() {
    return this.calls.length ? this.calls[this.calls.length - 1] : null;
  }

  /** 可序列化的调用记录，便于失败时复现。 */
  toJSON() {
    return {
      count: this.calls.length,
      methods: this.methods(),
      calls: this.calls.map((entry) => ({
        index: entry.index,
        method: entry.method,
        params: clone(entry.params),
        options: clone(entry.options),
        status: entry.status,
        ...(entry.code ? { code: entry.code } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        durationMs: entry.durationMs,
      })),
    };
  }

  /** 与 daemonRpc(method, params, options) 同形。 */
  async call(method, params = {}, options = {}) {
    const name = String(method || '');
    const callOptions = options && typeof options === 'object' ? options : {};
    const requested = Number(callOptions.timeoutMs);
    const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : this.script.defaultTimeoutMs;
    const record = {
      index: this.calls.length + 1,
      method: name,
      params: clone(params || {}),
      options: clone(callOptions),
      timeoutMs,
      at: this.clock(),
      status: 'pending',
      durationMs: 0,
    };
    this.calls.push(record);
    const startedAt = Date.now();
    try {
      if (this.script.unavailable) {
        throw new DaemonRpcError('E_DAEMON', 'fake adapter：daemon 未运行（脚本化不可用）');
      }
      const handler = this.script.handlers[name];
      if (!handler) {
        throw new DaemonRpcError('E_UNKNOWN_METHOD', 'fake adapter：未注册方法 ' + name);
      }
      const delayMs = handler.delayMs > 0 ? handler.delayMs : this.script.defaultDelayMs;
      if (delayMs > 0) {
        if (delayMs > timeoutMs) {
          await sleep(timeoutMs);
          throw new DaemonRpcError('E_TIMEOUT', 'fake adapter：' + name + ' 超过 ' + timeoutMs + 'ms 未返回');
        }
        await sleep(delayMs);
      }
      if (handler.error) {
        throw new DaemonRpcError(handler.error.code, handler.error.message, clone(handler.error.data));
      }
      const result = typeof handler.run === 'function'
        ? await handler.run(clone(params || {}), { method: name, adapter: this, timeoutMs })
        : clone(handler.result === undefined ? {} : handler.result);
      record.status = 'ok';
      record.ok = true;
      record.result = clone(result);
      return result;
    } catch (error) {
      record.status = 'error';
      record.ok = false;
      record.code = (error && error.code) || 'E_FAKE';
      record.error = { code: record.code, message: String((error && error.message) || error) };
      throw error;
    } finally {
      record.durationMs = Date.now() - startedAt;
    }
  }
}

/** 便捷工厂：createFakeAdapter({ handlers: { observe: { result: {...} } } })。 */
export function createFakeAdapter(script = {}, options = {}) {
  return new FakeDaemonAdapter(script, options);
}
