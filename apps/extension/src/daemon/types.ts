// src/daemon/types.ts —— daemon 接入层的公共类型与端点/URL 构造。
//
// HTTP /rpc（PROTOCOL.md §2）与 WebSocket /ws（§3）共享这里的请求/响应形状：
// - 请求：{ method, params?, timeoutMs? }，timeoutMs 由 daemon 透传给扩展命令；
// - 成功：{ ok: true, result }
// - 失败：{ ok: false, error: { code, message, data? } }
//
// 端点构造集中在这里，是因为端口可能来自设置（daemonPort）、测试（随机端口）或将来
// 的远程配对；同一个端口要同时拼 http:// 与 ws:// 两种 URL，分散写容易出现路径/查询
// 参数漂移。

import { DEFAULT_DAEMON_PORT, PROTOCOL_VERSION } from '../../shared/constants.ts';

/** daemon 结构化错误载荷（与 /rpc error、WS call-res error 同形）。 */
export interface DaemonErrorPayload {
  code: string;
  message: string;
  /** daemon 可选下发的结构化数据（例如 E_PROTOCOL_UNSUPPORTED 的 missing/required）。 */
  data?: unknown;
}

/** 一次 daemon 调用的请求体。 */
export interface DaemonRpcRequest {
  method: string;
  params?: Record<string, unknown>;
  /** 给 daemon 的命令超时（毫秒）；daemon 默认 60000。 */
  timeoutMs?: number;
}

/** /rpc 成功响应。 */
export interface DaemonRpcSuccess<T = unknown> {
  ok: true;
  result: T;
}

/** /rpc 失败响应（HTTP 状态码可能仍是 200，业务成败看 ok）。 */
export interface DaemonRpcFailure {
  ok: false;
  error: DaemonErrorPayload;
}

export type DaemonRpcResponse<T = unknown> = DaemonRpcSuccess<T> | DaemonRpcFailure;

/** 单次调用的可选项：取消信号与超时覆盖。 */
export interface DaemonCallOptions {
  /** 调用方取消；中止后 Promise 以 E_CANCELLED 拒绝。 */
  signal?: AbortSignal;
  /** 本次调用的客户端超时（毫秒），覆盖客户端默认值。 */
  timeoutMs?: number;
}

/**
 * daemon 调用的最小传输接口。
 * DaemonHttpClient（/rpc）与 DaemonSocket（/ws call）都实现它，所以 feature gate、
 * 只读白名单、错误映射这些上层逻辑只写一份，也便于测试注入假传输。
 */
export interface DaemonRpcTransport {
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: DaemonCallOptions,
  ): Promise<T>;
}

/** GET /health 的响应（PROTOCOL.md §2）。 */
export interface DaemonHealth {
  ok: boolean;
  service: string;
  protocol: string;
  version: string;
  pid: number;
  uptimeMs: number;
  port: number;
  tls: boolean;
  bind: string;
  publicUrl: string | null;
  browsers: number;
  sessions: number;
}

/** `status` 本地方法的结果里我们稳定依赖的字段。 */
export interface DaemonStatus {
  service: string;
  version: string;
  protocol: string;
  pid: number;
  port: number;
  uptimeMs: number;
  browsers: unknown[];
  sessions: unknown[];
  inflight: unknown[];
  queues: Record<string, unknown>;
  auth: Record<string, unknown>;
  compatibility: Record<string, unknown>;
}

/** `session.list` 结果。 */
export interface DaemonSessionList {
  sessions: unknown[];
}

/** `browsers` 结果。 */
export interface DaemonBrowserList {
  browsers: unknown[];
}

/** `audit.list` 结果。 */
export interface DaemonAuditList {
  dir: string;
  total: number;
  entries: unknown[];
}

/** 端口合法性：1–65535 的整数。 */
export function normalizeDaemonPort(value: unknown, fallback: number = DEFAULT_DAEMON_PORT): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return fallback;
  return port;
}

/** 主机名：只接受非空字符串，去掉空白；默认回环地址。 */
export function normalizeDaemonHost(value: unknown, fallback = '127.0.0.1'): string {
  if (typeof value !== 'string') return fallback;
  const host = value.trim();
  return host ? host : fallback;
}

/** 主机名出现在 URL 里时需要方括号包裹的 IPv6 形式。 */
function hostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) return '[' + host + ']';
  return host;
}

/**
 * HTTP 基地址。`baseUrl` 优先（允许带 https、路径前缀），否则由 host/port 拼出。
 * 统一去掉尾部斜杠，后续 request 用 `new URL('/rpc', base)` 保证路径绝对。
 */
export function daemonHttpBaseUrl(options: {
  baseUrl?: string | null;
  host?: string;
  port?: number;
  secure?: boolean;
} = {}): string {
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl.trim() : '';
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError('daemonHttpBaseUrl: baseUrl 必须使用 http: 或 https:');
    }
    // 保留 baseUrl 里的路径前缀（反向代理场景），只去掉尾部斜杠。
    return url.toString().replace(/\/+$/, '');
  }
  const host = normalizeDaemonHost(options.host);
  const port = normalizeDaemonPort(options.port);
  const scheme = options.secure === true ? 'https' : 'http';
  return `${scheme}://${hostForUrl(host)}:${port}`;
}

/**
 * WebSocket 地址（PROTOCOL.md §3）：
 *   ws://host:port/ws?role=extension&v=<extVersion>
 * 查询参数必须带 role，daemon 对非 extension 的 role 直接 1008 关闭。
 */
export function daemonWsUrl(options: {
  host?: string;
  port?: number;
  secure?: boolean;
  extVersion: string;
  role?: string;
  /** 远程配对地址（含 token 或自定义路径）直接使用。 */
  url?: string | null;
}): string {
  const rawUrl = typeof options.url === 'string' ? options.url.trim() : '';
  if (rawUrl) {
    const url = new URL(rawUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new TypeError('daemonWsUrl: url 必须使用 ws: 或 wss:');
    }
    if (!url.searchParams.has('role')) url.searchParams.set('role', options.role || 'extension');
    if (!url.searchParams.has('v')) url.searchParams.set('v', options.extVersion);
    return url.toString();
  }
  const host = normalizeDaemonHost(options.host);
  const port = normalizeDaemonPort(options.port);
  const scheme = options.secure === true ? 'wss' : 'ws';
  const url = new URL(`${scheme}://${hostForUrl(host)}:${port}/ws`);
  url.searchParams.set('role', options.role || 'extension');
  url.searchParams.set('v', options.extVersion);
  return url.toString();
}

/** 从 ws/http URL 里取端口（数字），取不到回退默认端口。 */
export function daemonPortFromUrl(rawUrl: string, fallback: number = DEFAULT_DAEMON_PORT): number {
  try {
    const url = new URL(rawUrl);
    if (url.port) return normalizeDaemonPort(url.port, fallback);
    return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
  } catch {
    return fallback;
  }
}

/** 扩展 hello 上报的协议版本（单源：shared/constants.ts）。 */
export const EXTENSION_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** hello 首帧里声明的扩展能力面（与 0.3.0 JS 扩展保持同一集合）。 */
export const EXTENSION_CAPABILITIES: readonly string[] = Object.freeze([
  'observe',
  'frames',
  'dialog',
  'screenshot',
  'network',
  'rules',
  'video',
  'recording',
  'pairing',
  'auth-challenge',
  'unverified',
  'dom-read',
]);
