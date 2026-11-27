// src/daemon/client.ts —— 类型化 daemon HTTP 客户端（POST /rpc + GET /health）。
//
// 职责：
// - 拼请求信封 { method, params, timeoutMs }，带 `x-bridge-token` 与 JSON 头；
// - 客户端超时（AbortController）与调用方取消（外部 AbortSignal）分开映射成 E_TIMEOUT /
//   E_CANCELLED，不让 fetch 的 AbortError 泄漏到上层；
// - 把 daemon 的 { ok:false, error } 映射成 DaemonRpcError（协议拒绝映射成 ProtocolError，
//   见 errors.ts），HTTP 401/404/5xx 与畸形响应同样是结构化错误；
// - 可选传输级重试（只对连接失败/5xx，且只读场景由调用方开启），JSON 业务错误不重试；
// - fetch 可注入：单测用 node:http 的 stub daemon 跑真实 HTTP，不 mock 协议细节。
//
// 说明：扩展自身拿不到 daemon.json 里的 /rpc token（PROTOCOL.md §1 明确只给 CLI），所以
// 本客户端主要服务两类调用方：测试/诊断进程（可读 token）与将来配置了 token 的远程 daemon；
// 扩展 background 的只读转发走 §25.3 的 WS 通道（见 ws.ts）。两条传输共用同一错误映射。

import {
  daemonError,
  DaemonRpcError,
  isDaemonRpcError,
  mapDaemonError,
  transportError,
} from './errors.ts';
import { isProtocolError, type ProtocolError } from '../protocol.ts';
import {
  daemonHttpBaseUrl,
  normalizeDaemonPort,
  type DaemonAuditList,
  type DaemonBrowserList,
  type DaemonCallOptions,
  type DaemonHealth,
  type DaemonRpcRequest,
  type DaemonRpcTransport,
  type DaemonSessionList,
  type DaemonStatus,
} from './types.ts';

/** 注入的 fetch：只需要支持字符串 URL + RequestInit，返回标准 Response。 */
export type DaemonFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 传输级重试策略。attempts 含首次调用；attempts=1 表示不重试。 */
export interface DaemonHttpRetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0–1 的抖动比例：delay * (1 ± jitter)。 */
  jitter: number;
}

export interface DaemonHttpClientOptions {
  /** 完整基地址（可含路径前缀/反向代理）；与 host/port 二选一。 */
  baseUrl?: string;
  host?: string;
  port?: number;
  /** /rpc token（daemon.json.token）。 */
  token?: string;
  fetchImpl?: DaemonFetch;
  defaultTimeoutMs?: number;
  retry?: Partial<DaemonHttpRetryPolicy>;
  /** 额外请求头（例如调试追踪 id）。 */
  headers?: Readonly<Record<string, string>>;
  /** 测试注入：等待重试间隔。 */
  sleep?: (ms: number) => Promise<void>;
  /** 测试注入：抖动随机源，默认 Math.random。 */
  random?: () => number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY: DaemonHttpRetryPolicy = Object.freeze({
  attempts: 1,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  jitter: 0.2,
});

/** 已超时 / 已取消的取消信号：记录两种中止来源，映射不同错误码。 */
interface LinkedAbort {
  signal: AbortSignal;
  timedOut(): boolean;
  cancelled(): boolean;
  dispose(): void;
}

function linkAbort(external: AbortSignal | undefined, timeoutMs: number): LinkedAbort {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onExternalAbort = () => {
    cancelled = true;
    controller.abort(external?.reason);
  };

  if (external) {
    if (external.aborted) {
      cancelled = true;
      controller.abort(external.reason);
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('daemon call timeout'));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelled: () => cancelled,
    dispose: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 规范化方法名：非空字符串；否则抛客户端错误（不浪费一次网络往返）。 */
function normalizeMethodName(method: unknown): string {
  if (typeof method !== 'string' || method.trim().length === 0) {
    throw daemonError('E_CLIENT_BAD_METHOD', '方法名必须是非空字符串', { category: 'client' });
  }
  return method.trim();
}

function normalizeParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (!isRecord(params)) {
    throw daemonError('E_CLIENT_BAD_REQUEST', 'params 必须是对象', { category: 'client' });
  }
  return params;
}

function normalizeTimeoutMs(value: unknown, fallback: number): number {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fallback;
  return Math.floor(timeoutMs);
}

/**
 * daemon /rpc 客户端。
 *
 * ```ts
 * const client = new DaemonHttpClient({ port: 52900, token: '...' });
 * const status = await client.call<DaemonStatus>('status');
 * const health = await client.health(); // GET /health，无需 token
 * ```
 */
export class DaemonHttpClient implements DaemonRpcTransport {
  readonly baseUrl: string;
  readonly token: string;
  readonly defaultTimeoutMs: number;
  private readonly fetchImpl: DaemonFetch;
  private readonly retry: DaemonHttpRetryPolicy;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: DaemonHttpClientOptions = {}) {
    this.baseUrl = daemonHttpBaseUrl({
      baseUrl: options.baseUrl,
      host: options.host,
      port: normalizeDaemonPort(options.port),
    });
    this.token = typeof options.token === 'string' ? options.token.trim() : '';
    this.defaultTimeoutMs = normalizeTimeoutMs(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.extraHeaders = Object.freeze({ ...(options.headers ?? {}) });
    this.sleepImpl = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.retry = Object.freeze({
      attempts: Math.max(1, Math.floor(Number(options.retry?.attempts ?? DEFAULT_RETRY.attempts)) || 1),
      baseDelayMs: Math.max(1, Number(options.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs) || DEFAULT_RETRY.baseDelayMs),
      maxDelayMs: Math.max(1, Number(options.retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs) || DEFAULT_RETRY.maxDelayMs),
      jitter: Math.min(1, Math.max(0, Number(options.retry?.jitter ?? DEFAULT_RETRY.jitter) || 0)),
    });
  }

  /** POST /rpc 的完整 URL。 */
  get rpcUrl(): string {
    return this.baseUrl + '/rpc';
  }

  /** 本次客户端会发送的请求头（不含 token 值，避免日志泄漏）。 */
  describe(): { baseUrl: string; rpcUrl: string; tokenPresent: boolean; attempts: number } {
    return {
      baseUrl: this.baseUrl,
      rpcUrl: this.rpcUrl,
      tokenPresent: this.token.length > 0,
      attempts: this.retry.attempts,
    };
  }

  /** 构造请求体（导出行为便于测试断言，不发起网络）。 */
  buildRequest(method: string, params?: Record<string, unknown>, timeoutMs?: number): DaemonRpcRequest {
    const request: DaemonRpcRequest = {
      method: normalizeMethodName(method),
      params: normalizeParams(params),
    };
    const effective = normalizeTimeoutMs(timeoutMs, 0);
    if (effective > 0) request.timeoutMs = effective;
    return request;
  }

  /**
   * 调用一个 /rpc 方法。
   * @throws ProtocolError 协议闸门拒绝
   * @throws DaemonRpcError 其它 daemon/传输错误（带 code/category/retryable/httpStatus）
   */
  async call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: DaemonCallOptions = {},
  ): Promise<T> {
    const name = normalizeMethodName(method);
    const body = normalizeParams(params);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, this.defaultTimeoutMs);
    const attempts = this.retry.attempts;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const linked = linkAbort(options.signal, timeoutMs);
      try {
        const result = await this.requestOnce<T>(name, body, timeoutMs, linked);
        return result;
      } catch (error) {
        lastError = error;
        const mapped = this.mapFailure(error, linked, timeoutMs);
        // 已取消/已超时不再重试：重试也只会拿同一个已中止的信号。
        const retryAllowed = attempt < attempts
          && !linked.cancelled()
          && !linked.timedOut()
          && (isDaemonRpcError(mapped)
            ? mapped.retryable && (mapped.category === 'transport')
            : false);
        if (!retryAllowed) throw mapped;
      } finally {
        linked.dispose();
      }
      await this.sleepImpl(this.retryDelay(attempt));
    }
    // 理论上不可达（attempts>=1 时循环内必然 return/throw）；兜底不吞掉原始错误。
    throw lastError instanceof Error ? lastError : daemonError('E_INTERNAL', '调用未执行');
  }

  /** call 的别名，贴近 /rpc 命名。 */
  rpc<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: DaemonCallOptions = {},
  ): Promise<T> {
    return this.call<T>(method, params, options);
  }

  // ---------------------------------------------------------------------
  // 只读便捷方法（白名单方法；供 popup/诊断页直接调用）
  // ---------------------------------------------------------------------

  status(options: DaemonCallOptions = {}): Promise<DaemonStatus> {
    return this.call<DaemonStatus>('status', {}, options);
  }

  sessionList(options: DaemonCallOptions = {}): Promise<DaemonSessionList> {
    return this.call<DaemonSessionList>('session.list', {}, options);
  }

  browsers(options: DaemonCallOptions = {}): Promise<DaemonBrowserList> {
    return this.call<DaemonBrowserList>('browsers', {}, options);
  }

  auditList(params: Record<string, unknown> = {}, options: DaemonCallOptions = {}): Promise<DaemonAuditList> {
    return this.call<DaemonAuditList>('audit.list', params, options);
  }

  operationsList(params: Record<string, unknown> = {}, options: DaemonCallOptions = {}): Promise<unknown> {
    return this.call('operations.list', params, options);
  }

  /**
   * GET /health（无需 token）。用于“daemon 是否在跑”的轻量探测，
   * 不经过 /rpc，因此 daemon 未启动时也只会拿到 E_NO_DAEMON。
   */
  async health(options: DaemonCallOptions = {}): Promise<DaemonHealth> {
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, this.defaultTimeoutMs);
    const linked = linkAbort(options.signal, timeoutMs);
    try {
      const response = await this.fetchImpl(this.baseUrl + '/health', {
        method: 'GET',
        headers: { accept: 'application/json', ...this.extraHeaders },
        signal: linked.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text.trim() ? JSON.parse(text) : null;
      } catch {
        throw transportError('E_BAD_RESPONSE', `GET /health 返回的不是 JSON（HTTP ${response.status}）`, {
          httpStatus: response.status,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        throw new DaemonRpcError(
          { code: 'E_DAEMON_HTTP', message: `GET /health HTTP ${response.status}` },
          { httpStatus: response.status },
        );
      }
      if (!isRecord(payload) || payload.ok !== true || typeof payload.service !== 'string') {
        throw transportError('E_BAD_RESPONSE', 'GET /health 响应缺少 ok/service 字段', {
          httpStatus: response.status,
        });
      }
      return {
        ok: payload.ok,
        service: payload.service,
        protocol: typeof payload.protocol === 'string' ? payload.protocol : '',
        version: typeof payload.version === 'string' ? payload.version : '',
        pid: typeof payload.pid === 'number' ? payload.pid : 0,
        uptimeMs: typeof payload.uptimeMs === 'number' ? payload.uptimeMs : 0,
        port: typeof payload.port === 'number' ? payload.port : 0,
        tls: payload.tls === true,
        bind: typeof payload.bind === 'string' ? payload.bind : '',
        publicUrl: typeof payload.publicUrl === 'string' ? payload.publicUrl : null,
        browsers: typeof payload.browsers === 'number' ? payload.browsers : 0,
        sessions: typeof payload.sessions === 'number' ? payload.sessions : 0,
      };
    } catch (error) {
      throw this.mapFailure(error, linked, timeoutMs);
    } finally {
      linked.dispose();
    }
  }

  // ---------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------

  private async requestOnce<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    linked: LinkedAbort,
  ): Promise<T> {
    const payload: DaemonRpcRequest = { method, params, timeoutMs };
    const body = JSON.stringify(payload);
    let response: Response;
    try {
      response = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: this.requestHeaders(),
        body,
        signal: linked.signal,
      });
    } catch (error) {
      // 这里只抛原始异常；call() 用 linked 的来源映射成 E_NO_DAEMON/E_TIMEOUT/E_CANCELLED。
      throw error;
    }
    return this.decodeRpcResponse<T>(response);
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...this.extraHeaders,
    };
    if (this.token) headers['x-bridge-token'] = this.token;
    return headers;
  }

  private async decodeRpcResponse<T>(response: Response): Promise<T> {
    const status = response.status;
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      throw transportError('E_BAD_RESPONSE', '读取 daemon 响应失败：' + messageOf(error), {
        httpStatus: status,
        reason: error,
      });
    }
    let payload: unknown = null;
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw transportError('E_BAD_RESPONSE', `daemon 响应不是 JSON（HTTP ${status}）`, {
          httpStatus: status,
        });
      }
    }

    if (status === 401) {
      throw this.errorFromPayload(payload, status, 'E_AUTH', 'daemon 拒绝 /rpc token');
    }
    if (status === 404) {
      throw this.errorFromPayload(payload, status, 'E_UNKNOWN_METHOD', 'daemon 不认识该方法');
    }
    if (status < 200 || status >= 300) {
      throw this.errorFromPayload(payload, status, 'E_DAEMON_HTTP', `daemon HTTP ${status}`);
    }
    if (!isRecord(payload)) {
      throw transportError('E_BAD_RESPONSE', 'daemon 响应不是 JSON-RPC 信封', { httpStatus: status });
    }
    if (payload.ok === true) {
      return payload.result as T;
    }
    if (payload.ok === false) {
      const error = payload.error;
      if (!isRecord(error) || typeof error.code !== 'string') {
        throw transportError('E_BAD_RESPONSE', 'daemon 失败响应缺少 error.code', { httpStatus: status });
      }
      throw mapDaemonError(
        {
          code: error.code,
          message: typeof error.message === 'string' && error.message ? error.message : error.code,
          ...(error.data !== undefined ? { data: error.data } : {}),
        },
        { httpStatus: status },
      );
    }
    throw transportError('E_BAD_RESPONSE', 'daemon 响应信封缺少 ok 字段', { httpStatus: status });
  }

  private errorFromPayload(
    payload: unknown,
    status: number,
    fallbackCode: string,
    fallbackMessage: string,
  ): DaemonRpcError | ProtocolError {
    if (isRecord(payload)) {
      const error = payload.error;
      if (isRecord(error) && typeof error.code === 'string') {
        return mapDaemonError(
          {
            code: error.code,
            message: typeof error.message === 'string' ? error.message : fallbackMessage,
            ...(error.data !== undefined ? { data: error.data } : {}),
          },
          { httpStatus: status },
        );
      }
    }
    return mapDaemonError({ code: fallbackCode, message: fallbackMessage }, { httpStatus: status });
  }

  private mapFailure(
    error: unknown,
    linked: LinkedAbort,
    timeoutMs: number,
  ): DaemonRpcError | ProtocolError {
    if (linked.cancelled()) {
      return transportError('E_CANCELLED', 'daemon 调用已取消', { reason: error });
    }
    if (linked.timedOut()) {
      return transportError('E_TIMEOUT', `daemon 调用超时（${timeoutMs}ms）`, { reason: error });
    }
    if (isDaemonRpcError(error)) return error;
    if (isProtocolError(error)) return error;
    return transportError('E_NO_DAEMON', `连不上 daemon（${this.baseUrl}）：${messageOf(error)}`, {
      reason: error,
    });
  }

  private retryDelay(attempt: number): number {
    const exponential = this.retry.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(this.retry.maxDelayMs, exponential);
    const spread = 1 + this.retry.jitter * (this.random() * 2 - 1);
    return Math.max(1, Math.round(capped * spread));
  }
}

/** 便捷工厂：只给端口/token 的常见场景。 */
export function createDaemonHttpClient(options: DaemonHttpClientOptions = {}): DaemonHttpClient {
  return new DaemonHttpClient(options);
}
