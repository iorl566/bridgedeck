// packages/protocol/src/features.ts —— 特性门：方法/参数 → 需要的最小协议版本。
//
// 与 lib/protocol-features.mjs 的 featuresForCall / featureShortfall /
// requiredFloorFor / featureMatrix 逐字段等价（差分测试对拍），特性表本身全部来自
// 生成物（lib/method-catalog.mjs 的单一源），本文件只实现“怎么判定”。
//
// 为什么需要这一层：1.8 客户端仍能连上 1.9 daemon（同 major minor 偏斜），但新参数
// 会被旧扩展静默忽略，表现成“调用成功、实际没生效”。所以必须在派发前判定并明确
// 拒绝，而不是放行后假装成功。

import {
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_METHODS,
  FEATURE_NAMES,
  FEATURE_PARAM_RULES,
  METHOD_FEATURE,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from './generated.ts';
import type { FeatureName } from './generated.ts';
import { PROTOCOL_UNSUPPORTED } from './errors.ts';
import { compareProtocol } from './version.ts';
import type {
  FeatureAvailability,
  FeatureMeta,
  FeatureParamRule,
  FeatureShortfall,
  ProtocolCompare,
  ProtocolPeer,
} from './types.ts';

/** 特性 → 对端扩展至少需要的协议版本（目录别名的稳定导出名）。 */
export const FEATURE_MIN_PROTOCOL = FEATURE_FLOORS;

/** 特性门名称（目录顺序）。 */
export const FEATURE_NAMES_IN_ORDER = FEATURE_NAMES;

/** 兼容矩阵默认探测的协议版本：1.8 旧客户端 / 1.9 当前客户端。 */
export const COMPAT_PROBE_VERSIONS: readonly string[] = Object.freeze([
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
]);

/**
 * 旧客户端被 feature gate 拒绝时的恢复建议（与 JS 侧 FEATURE_RECOVERY 逐字符一致）。
 * 放在这里而不是 gate.ts，是因为它属于“特性门”的语义而不是“决策”的语义。
 */
export const FEATURE_RECOVERY = '升级浏览器扩展后重试（当前协议 ' + PROTOCOL_CURRENT + '）；旧扩展会静默忽略这些参数，'
  + '所以 daemon 会在派发前用 ' + PROTOCOL_UNSUPPORTED + ' 明确拒绝。';

// 规则对象的身份就是 key：FEATURE_PARAM_RULES 是单一实例数组，运行期不会重建。
const RULE_METHODS: ReadonlyMap<FeatureParamRule, ReadonlySet<string> | null> = new Map(
  FEATURE_PARAM_RULES.map((rule: FeatureParamRule) => [
    rule,
    rule.methods ? new Set(rule.methods) : null,
  ]),
);

const METHOD_FEATURE_LOOKUP: Readonly<Record<string, FeatureName | undefined>> =
  METHOD_FEATURE as Readonly<Record<string, FeatureName | undefined>>;

const FEATURE_FLOOR_LOOKUP: Readonly<Record<string, string | undefined>> =
  FEATURE_FLOORS as Readonly<Record<string, string | undefined>>;

/** 方法名归一：与 JS 侧 `String(method || '')` 同义（0/false/'' 都归 empty）。 */
function methodNameOf(value: unknown): string {
  return String(value || '');
}

/** 是否为已知特性门名。 */
export function isFeatureName(value: unknown): value is FeatureName {
  return typeof value === 'string' && Object.hasOwn(FEATURE_FLOOR_LOOKUP, value);
}

/** 特性的协议 floor；未知特性返回 null。 */
export function floorForFeature(feature: unknown): string | null {
  if (typeof feature !== 'string') return null;
  if (!Object.hasOwn(FEATURE_FLOOR_LOOKUP, feature)) return null;
  return FEATURE_FLOOR_LOOKUP[feature] ?? null;
}

/** 特性元数据；未知特性返回 null。 */
export function featureMetaOf(feature: unknown): FeatureMeta | null {
  if (!isFeatureName(feature)) return null;
  const meta = (FEATURE_META as Readonly<Record<string, FeatureMeta | undefined>>)[feature];
  return meta ?? null;
}

/** 特性门反向方法表；未知特性返回空数组。 */
export function methodsGatedBy(feature: unknown): readonly string[] {
  if (!isFeatureName(feature)) return [];
  const methods = (FEATURE_METHODS as Readonly<Record<string, readonly string[] | undefined>>)[feature];
  return methods ? [...methods] : [];
}

/** 方法级特性门（未知方法返回 null；原型链上的键不当作特性）。 */
export function methodFeature(method: unknown): FeatureName | null {
  const name = methodNameOf(method);
  if (!Object.hasOwn(METHOD_FEATURE_LOOKUP, name)) return null;
  return METHOD_FEATURE_LOOKUP[name] ?? null;
}

/** 参数规则是否命中：先看方法作用域，再看参数形态。 */
function ruleMatches(
  rule: FeatureParamRule,
  method: string,
  params: Readonly<Record<string, unknown>>,
): boolean {
  const scoped = RULE_METHODS.get(rule);
  if (scoped && !scoped.has(method)) return false;
  const value = params[rule.param];
  if (rule.kind === 'true') return value === true;
  if (rule.kind === 'defined') return value !== undefined;
  if (rule.kind === 'non-empty-array') return Array.isArray(value) && value.length > 0;
  return false;
}

/**
 * 根据方法 + 参数推导这次调用依赖哪些新特性。
 * 顺序稳定：方法级门在前，参数级规则按目录表顺序；同一特性只出现一次。
 */
export function featuresForCall(
  method: unknown,
  params: Readonly<Record<string, unknown>> | null | undefined = {},
): FeatureName[] {
  const features = new Set<FeatureName>();
  const gated = methodFeature(method);
  if (gated) features.add(gated);
  const bag: Readonly<Record<string, unknown>> =
    params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const name = methodNameOf(method);
  for (const rule of FEATURE_PARAM_RULES) {
    if (!floorForFeature(rule.feature)) continue;
    if (ruleMatches(rule, name, bag)) features.add(rule.feature as FeatureName);
  }
  return [...features];
}

/**
 * 对端协议缺口：返回缺失特性及两边版本。
 * compare 省略时使用 compareProtocol；传 null 时按“无法比较 = 缺失”处理。
 */
export function featureShortfall(
  peer: ProtocolPeer | null | undefined,
  features: readonly string[],
  compare: ProtocolCompare = compareProtocol,
): FeatureShortfall[] {
  const protocol = peer && peer.protocol ? String(peer.protocol) : '';
  const missing: FeatureShortfall[] = [];
  for (const feature of features) {
    const required = floorForFeature(feature);
    if (!required) continue;
    const order = typeof compare === 'function' ? compare(protocol, required) : null;
    if (order === null || order < 0) {
      missing.push({ feature, required, actual: protocol || 'unknown' });
    }
  }
  return missing;
}

/** 一组特性里最高的最低版本（错误信息里的“需要升级到”）。 */
export function requiredFloorFor(
  features: readonly string[],
  compare: ProtocolCompare = compareProtocol,
): string | null {
  let required: string | null = null;
  for (const feature of features) {
    const floor = floorForFeature(feature);
    if (!floor) continue;
    if (required === null) {
      required = floor;
      continue;
    }
    const order = typeof compare === 'function' ? compare(floor, required) : null;
    if ((order ?? 0) > 0) required = floor;
  }
  return required;
}

/** 每个特性的可用性快照；供 status/doctor 在派发前展示，不靠猜。 */
export function featureMatrix(
  peer: ProtocolPeer | null | undefined,
  compare: ProtocolCompare = compareProtocol,
): Record<string, FeatureAvailability> {
  const protocol = peer && peer.protocol ? String(peer.protocol) : '';
  const out: Record<string, FeatureAvailability> = {};
  for (const feature of FEATURE_NAMES) {
    const required = floorForFeature(feature);
    if (!required) continue;
    const order = typeof compare === 'function' ? compare(protocol, required) : null;
    out[feature] = {
      required,
      actual: protocol || 'unknown',
      available: order !== null && order >= 0,
    };
  }
  return out;
}

/**
 * 已通过特性门的方法名（方法级门反向表，按目录顺序）。
 * 供文档/诊断与“哪些方法对旧客户端不可见”的统计使用。
 */
export function gatedMethodNames(): string[] {
  return Object.keys(METHOD_FEATURE);
}
