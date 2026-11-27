// packages/protocol/src/gate.ts —— 派发前协议闸门（纯函数 + 结构化异常）。
//
// 与 lib/protocol-features.mjs 的 protocolGate / assertProtocolCompatible /
// compatibilityMatrix 逐字段等价（差分测试对拍）。设计取舍：
// - 闸门本身是纯函数：测试不需要 daemon/浏览器就能构造 1.8 客户端负例；
// - assertProtocolCompatible 只是“拒绝就抛结构化错误”的薄封装，message 与 JS
//   逐字符一致，便于 CLI/MCP 直接把 message 展示给用户；
// - 决策对象一律冻结，调用方不能事后偷偷把 reject 改成 pass。

import { FEATURE_FLOORS, PROTOCOL_BASELINE, PROTOCOL_CURRENT } from './generated.ts';
import type { FeatureName } from './generated.ts';
import {
  COMPAT_PROBE_VERSIONS,
  FEATURE_NAMES_IN_ORDER,
  FEATURE_RECOVERY,
  featureMetaOf,
  featureShortfall,
  featuresForCall,
  floorForFeature,
  methodFeature,
  requiredFloorFor,
} from './features.ts';
import { PROTOCOL_UNSUPPORTED, LEGACY_CAPABILITY_UNSUPPORTED, PROTOCOL_UNSUPPORTED_ALIASES, ProtocolError } from './errors.ts';
import type { ProtocolErrorCode, ProtocolErrorData } from './errors.ts';
import type {
  FeatureShortfall,
  ProtocolCompare,
  ProtocolPeer,
} from './types.ts';
import { compareProtocol } from './version.ts';

/** 闸门通过。 */
export interface ProtocolPass {
  readonly ok: true;
  readonly code: null;
  readonly method: string;
  readonly features: readonly FeatureName[];
  readonly missing: readonly FeatureShortfall[];
  readonly floor: string | null;
}

/** 闸门拒绝。 */
export interface ProtocolReject {
  readonly ok: false;
  readonly code: ProtocolErrorCode;
  readonly method: string;
  readonly features: readonly FeatureName[];
  readonly missing: readonly FeatureShortfall[];
  readonly floor: string | null;
  readonly message: string;
  readonly data: ProtocolErrorData;
}

export type ProtocolDecision = ProtocolPass | ProtocolReject;

/**
 * 派发前兼容闸门（纯函数）。
 * 通过：{ok:true, code:null, method, features, missing:[], floor}
 * 拒绝：{ok:false, code:'E_PROTOCOL_UNSUPPORTED', method, features, missing, floor, message, data}
 */
export function protocolGate(
  peer: ProtocolPeer | null | undefined,
  method: unknown,
  params: Readonly<Record<string, unknown>> | null | undefined = {},
  compare: ProtocolCompare = compareProtocol,
): ProtocolDecision {
  const features = featuresForCall(method, params);
  const missing = featureShortfall(peer, features, compare);
  const feature = methodFeature(method);
  const floor = requiredFloorFor(features, compare)
    || (feature ? FEATURE_FLOORS[feature] : null);
  const methodName = String(method || '');

  if (!missing.length) {
    const pass: ProtocolPass = Object.freeze({
      ok: true,
      code: null,
      method: methodName,
      features,
      missing: Object.freeze([]) as readonly FeatureShortfall[],
      floor,
    });
    return pass;
  }

  const actual = peer && peer.protocol ? String(peer.protocol) : 'unknown';
  const detail = missing
    .map((item) => item.feature + '（需要 ' + item.required + '，当前 ' + item.actual + '）')
    .join('、');
  const first = missing[0];
  if (!first) {
    // 不可达：走到这里说明 missing 的判定与长度自相矛盾，宁可抛也不静默放行。
    throw new Error('protocolGate: missing 为空却进入拒绝分支');
  }
  const data: ProtocolErrorData = Object.freeze({
    code: PROTOCOL_UNSUPPORTED,
    method: methodName,
    feature: first.feature,
    features,
    missing,
    required: floor,
    actual,
    // 兼容别名：旧调用方按 E_UNSUPPORTED_CAPABILITY 分支时仍能识别（见 LEGACY_CAPABILITY_UNSUPPORTED）。
    legacyCode: LEGACY_CAPABILITY_UNSUPPORTED,
    aliasCodes: PROTOCOL_UNSUPPORTED_ALIASES,
  });
  const reject: ProtocolReject = Object.freeze({
    ok: false,
    code: PROTOCOL_UNSUPPORTED,
    method: methodName,
    features,
    missing,
    floor,
    message: '浏览器扩展协议版本过低，缺少特性：' + detail + '。' + FEATURE_RECOVERY,
    data,
  });
  return reject;
}

/** 闸门类型收窄：拒绝即抛错。 */
export function assertProtocolCompatible(
  peer: ProtocolPeer | null | undefined,
  method: unknown,
  params: Readonly<Record<string, unknown>> | null | undefined = {},
  compare: ProtocolCompare = compareProtocol,
): ProtocolPass {
  const decision = protocolGate(peer, method, params, compare);
  if (decision.ok) return decision;
  throw new ProtocolError(decision.message, decision.data);
}

/** 兼容矩阵中的单个特性行。 */
export interface CompatibilityFeatureRow {
  readonly feature: string;
  readonly label: string;
  readonly floor: string | null;
  readonly allowed: Record<string, boolean>;
}

/** 1.8 / 1.9 客户端 × 全量特性门的允许/拒绝矩阵。 */
export interface CompatibilityMatrix {
  readonly versions: string[];
  readonly baseline: string;
  readonly current: string;
  readonly features: CompatibilityFeatureRow[];
  readonly matrix: Record<string, Record<string, boolean>>;
  readonly counts: Record<string, { readonly allowed: number; readonly denied: number }>;
  readonly ok: boolean;
}

/**
 * 兼容矩阵（纯数据，供测试与文档/诊断复用）。
 * ok 的口径：baseline 客户端必须一个特性门都不允许（否则闸门漏放），
 * current 客户端必须全部允许（否则闸门误杀）。
 */
export function compatibilityMatrix(
  compare: ProtocolCompare = compareProtocol,
  versions: readonly string[] = COMPAT_PROBE_VERSIONS,
): CompatibilityMatrix {
  const probes = [...versions].map((version) => String(version));
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const version of probes) matrix[version] = {};
  const features: CompatibilityFeatureRow[] = FEATURE_NAMES_IN_ORDER.map((feature) => {
    const floor = floorForFeature(feature);
    const meta = featureMetaOf(feature);
    const allowed: Record<string, boolean> = {};
    for (const version of probes) {
      const order = typeof compare === 'function' ? compare(version, floor) : null;
      allowed[version] = order !== null && order >= 0;
      const bucket = matrix[version];
      if (bucket) bucket[feature] = allowed[version] === true;
    }
    return {
      feature,
      label: (meta && meta.label) || feature,
      floor,
      allowed,
    };
  });
  const counts: Record<string, { allowed: number; denied: number }> = {};
  let ok = true;
  for (const version of probes) {
    const bucket = matrix[version] ?? {};
    const values = Object.values(bucket);
    const allowed = values.filter(Boolean).length;
    counts[version] = { allowed, denied: values.length - allowed };
    if (version === PROTOCOL_BASELINE && allowed !== 0) ok = false;
    if (version === PROTOCOL_CURRENT && allowed !== values.length) ok = false;
  }
  return {
    versions: probes,
    baseline: PROTOCOL_BASELINE,
    current: PROTOCOL_CURRENT,
    features,
    matrix,
    counts,
    ok,
  };
}
