// src/daemon/errors.ts —— daemon 错误码 → 类型化错误（含协议错误映射）。
//
// 三层错误要分清：
// 1. 传输层：连不上 / 超时 / 被取消 / 响应不是 JSON —— 客户端自己产生（E_NO_DAEMON、
//    E_TIMEOUT、E_CANCELLED、E_BAD_RESPONSE、E_DAEMON_HTTP）；
// 2. 业务层：daemon 返回 { ok:false, error:{ code, message, data? } } —— 原样保留 code/data；
// 3. 协议层：daemon 明确拒绝新特性时 code=E_PROTOCOL_UNSUPPORTED 且 data 是协议闸门的
//    结构化证据；这一种映射成 packages/protocol 的 ProtocolError，让调用方可以直接用
//    isProtocolError / protocolErrorDataOf 做分支（与 daemon/CLI 的 JS 侧语义一致）。
//
// 除协议错误外一律是 DaemonRpcError：它带 category / retryable / httpStatus，便于 UI 与
// 重试逻辑做判断，而不是靠字符串匹配。

import {
  LEGACY_CAPABILITY_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED_ALIASES,
  ProtocolError,
  protocolErrorDataOf,
} from '../protocol.ts';
import type { FeatureShortfall, ProtocolErrorData } from '../protocol.ts';
import type { DaemonErrorPayload } from './types.ts';

/** 错误分类：决定 UI 提示与是否自动重试。 */
export type DaemonErrorCategory =
  | 'auth'
  | 'transport'
  | 'protocol'
  | 'daemon'
  | 'client'
  | 'unknown';

/** 错误码元数据。retryable 只描述“换个时刻再试可能成功”，不代表业务上该重试。 */
export interface DaemonErrorMeta {
  category: DaemonErrorCategory;
  retryable: boolean;
  description: string;
}

/**
 * 错误码表。daemon 的完整错误码在 docs/PROTOCOL.md §5.3 / lib/error-codes.mjs；
 * 这里只登记扩展侧需要区分行为的码，未登记的码按 daemon/unknown 处理（不误报）。
 */
export const DAEMON_ERROR_META: Readonly<Record<string, DaemonErrorMeta>> = Object.freeze({
  // 传输/客户端
  E_NO_DAEMON: { category: 'transport', retryable: true, description: '连不上本地 daemon' },
  E_TIMEOUT: { category: 'transport', retryable: false, description: '调用超时' },
  E_CANCELLED: { category: 'transport', retryable: false, description: '调用被取消' },
  E_BAD_RESPONSE: { category: 'transport', retryable: false, description: 'daemon 响应不是合法 JSON-RPC 信封' },
  E_DAEMON_HTTP: { category: 'transport', retryable: true, description: 'daemon 返回非 2xx HTTP 状态' },
  E_CLIENT_BAD_METHOD: { category: 'client', retryable: false, description: '方法名非法' },
  E_CLIENT_BAD_REQUEST: { category: 'client', retryable: false, description: '请求信封非法' },
  // 鉴权
  E_AUTH: { category: 'auth', retryable: false, description: '/rpc token 无效' },
  E_PAIR_REQUIRED: { category: 'auth', retryable: false, description: '需要配对后才能连接' },
  E_PAIR_REJECTED: { category: 'auth', retryable: false, description: '配对 token 已绑定其它浏览器' },
  E_AUTH_FAILED: { category: 'auth', retryable: false, description: '认证挑战响应失败' },
  // 协议
  E_PROTOCOL_UNSUPPORTED: { category: 'protocol', retryable: false, description: '对端协议版本缺少所需特性' },
  // 业务
  E_UNKNOWN_METHOD: { category: 'daemon', retryable: false, description: 'daemon 不认识该方法' },
  E_BAD_JSON: { category: 'daemon', retryable: false, description: '请求体不是合法 JSON' },
  E_BAD_REQUEST: { category: 'daemon', retryable: false, description: '请求不合法' },
  E_BAD_ARG: { category: 'daemon', retryable: false, description: '参数不合法' },
  E_INTERNAL: { category: 'daemon', retryable: false, description: 'daemon 内部错误' },
  E_NOT_FOUND: { category: 'daemon', retryable: false, description: '目标不存在' },
  E_STALE_REF: { category: 'daemon', retryable: false, description: 'ref 指向的元素已不在文档里（需重新 observe）' },
  E_OBSERVATION_STALE: { category: 'daemon', retryable: false, description: '观测结果已过期（需重新 observe）' },
  E_NOT_IMPLEMENTED: { category: 'daemon', retryable: false, description: 'TS 运行时尚未迁移该能力' },
  E_NOT_ACTIONABLE: { category: 'daemon', retryable: false, description: '目标不可操作（被遮挡/禁用/尺寸为 0）' },
  E_NO_SESSION: { category: 'daemon', retryable: false, description: '没有可用会话' },
  E_NO_BROWSER: { category: 'daemon', retryable: true, description: '没有浏览器实例连接 daemon' },
  E_QUEUE_FULL: { category: 'daemon', retryable: true, description: '会话动作队列已满' },
  'E_METHOD_NOT_ALLOWED': { category: 'client', retryable: false, description: '方法不在只读白名单内' },
  E_HEARTBEAT_TIMEOUT: { category: 'transport', retryable: true, description: 'WebSocket 心跳超时' },
  E_HANDSHAKE_TIMEOUT: { category: 'transport', retryable: true, description: 'WebSocket 握手超时' },
  E_SOCKET_CLOSED: { category: 'transport', retryable: true, description: 'WebSocket 已关闭' },
  E_WS_REJECTED: { category: 'auth', retryable: false, description: 'daemon 拒绝 WebSocket 握手' },
});

/** 未知错误码的兜底元数据。 */
export const UNKNOWN_DAEMON_ERROR_META: DaemonErrorMeta = Object.freeze({
  category: 'unknown',
  retryable: false,
  description: '未登记的错误码',
});

/** 错误码 → 元数据；未知码不猜测可重试性。 */
export function daemonErrorMeta(code: unknown): DaemonErrorMeta {
  if (typeof code === 'string' && Object.hasOwn(DAEMON_ERROR_META, code)) {
    return DAEMON_ERROR_META[code] ?? UNKNOWN_DAEMON_ERROR_META;
  }
  return UNKNOWN_DAEMON_ERROR_META;
}

/** 该错误码是否值得换个时刻重试（仅传输类）。 */
export function isRetryableDaemonCode(code: unknown): boolean {
  return daemonErrorMeta(code).retryable;
}

export interface DaemonRpcErrorOptions {
  category?: DaemonErrorCategory;
  retryable?: boolean;
  httpStatus?: number | null;
  /** 原始异常，便于日志/诊断（不参与 JSON 序列化）。 */
  reason?: unknown;
}

/** daemon 业务/传输错误的统一类型（协议错误另行映射成 ProtocolError）。 */
export class DaemonRpcError extends Error {
  readonly code: string;
  readonly data: unknown;
  readonly category: DaemonErrorCategory;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly reason: unknown;

  constructor(payload: DaemonErrorPayload, options: DaemonRpcErrorOptions = {}) {
    super(payload.message || payload.code || 'daemon 调用失败');
    this.name = 'DaemonRpcError';
    this.code = payload.code || 'E_INTERNAL';
    this.data = payload.data;
    const meta = daemonErrorMeta(this.code);
    this.category = options.category ?? meta.category;
    this.retryable = options.retryable ?? meta.retryable;
    this.httpStatus = options.httpStatus ?? null;
    this.reason = options.reason;
  }

  /** 结构化载荷：可直接作为 MCP/消息回包的 error 字段。 */
  toPayload(): DaemonErrorPayload {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }

  toJSON(): DaemonErrorPayload {
    return this.toPayload();
  }
}

/** 类型守卫：兼容跨 realm 的形态（name+code 判定，不强制 instanceof）。 */
export function isDaemonRpcError(value: unknown): value is DaemonRpcError {
  if (value instanceof DaemonRpcError) return true;
  return Boolean(value)
    && typeof value === 'object'
    && (value as { name?: unknown }).name === 'DaemonRpcError'
    && typeof (value as { code?: unknown }).code === 'string';
}

/** 便捷构造：业务错误。 */
export function daemonError(
  code: string,
  message: string,
  options: DaemonRpcErrorOptions & { data?: unknown } = {},
): DaemonRpcError {
  return new DaemonRpcError(
    options.data === undefined ? { code, message } : { code, message, data: options.data },
    options,
  );
}

/** 便捷构造：传输失败。 */
export function transportError(
  code: string,
  message: string,
  options: DaemonRpcErrorOptions = {},
): DaemonRpcError {
  return new DaemonRpcError({ code, message }, { category: 'transport', ...options });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把 daemon 下发的 E_PROTOCOL_UNSUPPORTED data 还原成 ProtocolErrorData。
 * 字段不完整时返回 null（调用方回退到普通 DaemonRpcError，不伪造协议证据）。
 */
export function toProtocolErrorData(data: unknown): ProtocolErrorData | null {
  if (!isRecord(data)) return null;
  const method = data.method;
  const actual = data.actual;
  const required = data.required;
  const rawFeatures = data.features;
  const rawMissing = data.missing;
  if (typeof method !== 'string' || typeof actual !== 'string') return null;
  if (required !== null && typeof required !== 'string') return null;
  if (!Array.isArray(rawFeatures) || !rawFeatures.every((item) => typeof item === 'string')) return null;
  if (!Array.isArray(rawMissing)) return null;
  const missing: FeatureShortfall[] = [];
  for (const item of rawMissing) {
    if (!isRecord(item)) return null;
    if (typeof item.feature !== 'string' || typeof item.required !== 'string' || typeof item.actual !== 'string') {
      return null;
    }
    missing.push({ feature: item.feature, required: item.required, actual: item.actual });
  }
  const firstMissing = missing[0];
  const feature = typeof data.feature === 'string' ? data.feature : (firstMissing ? firstMissing.feature : '');
  return {
    code: PROTOCOL_UNSUPPORTED,
    method,
    feature,
    features: rawFeatures as string[],
    missing,
    required: required as string | null,
    actual,
    // 协议 1.9 起拒绝数据带历史兼容码，旧调用方按 E_UNSUPPORTED_CAPABILITY 分支仍可识别。
    legacyCode: LEGACY_CAPABILITY_UNSUPPORTED,
    aliasCodes: PROTOCOL_UNSUPPORTED_ALIASES,
  };
}

/** 若 daemon 载荷是协议拒绝，返回 ProtocolError；否则 null。 */
export function protocolErrorFromDaemon(payload: DaemonErrorPayload): ProtocolError | null {
  if (payload.code !== PROTOCOL_UNSUPPORTED) return null;
  const data = toProtocolErrorData(payload.data);
  if (!data) return null;
  return new ProtocolError(payload.message, data);
}

/**
 * 错误映射总入口：协议拒绝 → ProtocolError；其余 → DaemonRpcError。
 * 供 HTTP 客户端与 WS call 共用，保证两条传输的错误语义一致。
 */
export function mapDaemonError(
  payload: DaemonErrorPayload,
  options: DaemonRpcErrorOptions = {},
): DaemonRpcError | ProtocolError {
  const protocolError = protocolErrorFromDaemon(payload);
  if (protocolError) return protocolError;
  return new DaemonRpcError(payload, options);
}

/**
 * 任意异常 → 结构化错误载荷。用于消息回包、日志与测试断言；
 * 对 ProtocolError 保留 code/data，让上层能看到 missing/required 证据。
 */
export function errorPayloadOf(error: unknown): DaemonErrorPayload {
  if (error instanceof ProtocolError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  const protocolData = protocolErrorDataOf(error);
  if (protocolData) {
    return {
      code: PROTOCOL_UNSUPPORTED,
      message: error instanceof Error ? error.message : String(error),
      data: protocolData,
    };
  }
  if (isDaemonRpcError(error)) return error.toPayload();
  if (error instanceof Error) return { code: 'E_INTERNAL', message: error.message };
  return { code: 'E_INTERNAL', message: String(error) };
}

/** 从任意异常里取错误码（日志/回归断言用）。 */
export function errorCodeOf(error: unknown): string {
  if (error instanceof ProtocolError) return error.code;
  const data = protocolErrorDataOf(error);
  if (data) return data.code;
  if (isDaemonRpcError(error)) return error.code;
  return 'E_INTERNAL';
}

/** 判断异常是否为“可重试的传输错误”。 */
export function isRetryableError(error: unknown): boolean {
  if (isDaemonRpcError(error)) return error.retryable;
  if (error instanceof TypeError) return true; // fetch 在连接被拒时抛 TypeError
  return false;
}
