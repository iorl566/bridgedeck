// packages/protocol/src/errors.ts —— 结构化协议错误。
//
// JS 侧 assertProtocolCompatible 抛的是带 code/data 的普通 Error（lib/protocol-features.mjs）。
// TS 侧把它升级成有类型断言的 ProtocolError：message 与 JS 逐字符一致，code 固定
// E_PROTOCOL_UNSUPPORTED，data 是可直接交给 daemon/MCP 错误序列化的纯数据。
//
// 调用方两种用法：
//   try { assertProtocolCompatible(peer, 'video.start') } catch (error) {
//     if (isProtocolError(error)) report(error.code, error.data);
//   }
// 或直接对 gate 的返回做分支，不依赖异常。

import type { FeatureShortfall } from './types.ts';

/** 旧客户端被 feature gate 拒绝时的错误码（与 lib/error-codes.mjs 登记一致）。 */
export const PROTOCOL_UNSUPPORTED = 'E_PROTOCOL_UNSUPPORTED';

/**
 * 历史错误码兼容别名（与 lib/protocol-features.mjs 的 LEGACY_CAPABILITY_UNSUPPORTED 一致）。
 *
 * 0.3.0 早期版本把“扩展缺特性”报成 E_UNSUPPORTED_CAPABILITY；W4 起协议特性门改用更精确的
 * E_PROTOCOL_UNSUPPORTED，但拒绝数据里保留 legacyCode/aliasCodes，旧调用方仍能识别旧码。
 */
export const LEGACY_CAPABILITY_UNSUPPORTED = 'E_UNSUPPORTED_CAPABILITY';

/** 特性门拒绝时可识别的错误码：首个是主码，其余是兼容别名（顺序稳定）。 */
export const PROTOCOL_UNSUPPORTED_ALIASES: readonly string[] = Object.freeze([
  PROTOCOL_UNSUPPORTED,
  LEGACY_CAPABILITY_UNSUPPORTED,
]);

/** 错误码联合类型（协议闸门主码 + 历史兼容别名）。 */
export type ProtocolErrorCode = typeof PROTOCOL_UNSUPPORTED | typeof LEGACY_CAPABILITY_UNSUPPORTED;

/** 错误码是否属于特性门拒绝（主码或兼容别名）。 */
export function isProtocolUnsupportedCode(code: unknown): boolean {
  return PROTOCOL_UNSUPPORTED_ALIASES.includes(String(code || ''));
}

/** 协议闸门拒绝时随错误下发的数据（纯 JSON，可用于 MCP/daemon 序列化）。 */
export interface ProtocolErrorData {
  readonly code: ProtocolErrorCode;
  readonly method: string;
  /** 第一个缺失特性；多特性缺失时看 features/missing。 */
  readonly feature: string;
  readonly features: readonly string[];
  readonly missing: readonly FeatureShortfall[];
  /** 需要的最高协议 floor。 */
  readonly required: string | null;
  /** 对端实际协议版本，未知为 'unknown'。 */
  readonly actual: string;
  /**
   * 历史兼容错误码（旧调用方按 E_UNSUPPORTED_CAPABILITY 分支时仍能识别）。
   *
   * 可选字段：gate.ts 在拒绝时一定会填，但 daemon 载荷/旧对端可能不带，调用点不能假设
   * 它必存在（`data.legacyCode ?? LEGACY_CAPABILITY_UNSUPPORTED` 是安全读法）。
   */
  readonly legacyCode?: string;
  /** 可识别的错误码别名（顺序稳定：主码在前）。可选，原因同 legacyCode。 */
  readonly aliasCodes?: readonly string[];
}

/**
 * 结构化协议错误。name 固定 'ProtocolError'，但 message/code/data 与 JS 侧
 * 普通 Error 的 message/code/data 完全一致（差分测试逐字段对拍）。
 */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly data: ProtocolErrorData;

  constructor(message: string, data: ProtocolErrorData) {
    super(message);
    // 保持 name 可辨识；instanceof Error 仍然成立。
    this.name = 'ProtocolError';
    this.code = data.code;
    this.data = data;
  }
}

/** 类型守卫：是否为结构化协议错误。 */
export function isProtocolError(value: unknown): value is ProtocolError {
  return value instanceof ProtocolError
    || (typeof value === 'object'
      && value !== null
      && (value as { name?: unknown }).name === 'ProtocolError'
      && isProtocolUnsupportedCode((value as { code?: unknown }).code));
}

/** 类型守卫：是否为协议不兼容拒绝（不要求是 TS 类实例，兼容 JS 侧丢过来的 Error）。 */
export function isProtocolUnsupportedError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return isProtocolUnsupportedCode((value as { code?: unknown }).code);
}

/**
 * 从任意异常里提取协议错误数据；不匹配返回 null。
 * 兼容 JS 侧普通 Error（只有 code/data 两个附加字段）。
 */
export function protocolErrorDataOf(value: unknown): ProtocolErrorData | null {
  if (!value || typeof value !== 'object') return null;
  const error = value as { code?: unknown; data?: unknown };
  if (!isProtocolUnsupportedCode(error.code)) return null;
  const data = error.data;
  if (!data || typeof data !== 'object') return null;
  return data as ProtocolErrorData;
}
