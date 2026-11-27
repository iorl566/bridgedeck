// packages/protocol/src/types.ts —— 协议目录的结构/联合类型（手工维护，不含数据）。
//
// 数据单源在 lib/method-catalog.mjs；packages/protocol/scripts/gen.mjs 把它投影成
// src/generated.ts。本文件只声明类型，且**不 import 生成物**，因此生成物可以单向
// import 本文件而不产生类型环：generated.ts -> types.ts，其它模块两者都引。
//
// 类型面刻意与 JS 源一一对应：
// - owner：local（daemon 自处理）/ session（需会话 tabId）/ instance（需实例）；
// - effect：control_plane / passive_read / read / transient_input / browser_mutation；
// - 五维状态：owner / effect / partial / unknown / reconcile(strategy + 证据方法)。

/** 方法 owner：决定派发前需要哪种运行上下文。 */
export type MethodOwner = 'local' | 'session' | 'instance';

/** 方法副作用分类（与 lib/protocol.mjs 的 METHOD_EFFECT 同口径）。 */
export type MethodEffect =
  | 'control_plane'
  | 'passive_read'
  | 'read'
  | 'transient_input'
  | 'browser_mutation';

/** 需要回执/意图账本的 effect 子集。 */
export type MutatingEffect = Extract<MethodEffect, 'transient_input' | 'browser_mutation'>;

/** unknown 之后的收敛策略。 */
export type ReconcileStrategy = 'none' | 'observe' | 'status' | 'ledger';

/** 特性门的触发形态：纯参数 / 纯方法 / 方法与参数联合。 */
export type FeatureKind = 'param' | 'method' | 'method+param';

/** 参数级特性门的匹配形态。 */
export type ParamRuleKind = 'true' | 'defined' | 'non-empty-array';

/** 协议版本输入面：'1.9' / 1.9 / null / undefined（旧客户端不带版本）。 */
export type ProtocolVersionInput = string | number | null | undefined;

/** 解析后的协议版本。 */
export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/** 单个方法的收敛状态；method 为收敛证据方法（仅 status 策略使用）。 */
export interface MethodReconcileState<M extends string = string> {
  readonly strategy: ReconcileStrategy;
  readonly method: M | null;
}

/** 五维方法状态之一。 */
export interface MethodState<M extends string = string> {
  readonly owner: MethodOwner;
  readonly effect: MethodEffect;
  readonly partial: boolean;
  readonly unknown: boolean;
  readonly reconcile: MethodReconcileState<M>;
}

/** 目录行 = 方法名 + 五维状态 + 回执/特性门派生位。 */
export interface CatalogRow<M extends string = string> extends MethodState<M> {
  readonly method: M;
  readonly receipt: boolean;
  readonly floor: string | null;
}

/** 目录行的宽松输入形态（供不变量校验处理外部/半成品行）。 */
export interface CatalogRowCandidate {
  readonly method?: string;
  readonly owner?: string;
  readonly effect?: string;
  readonly partial?: boolean;
  readonly unknown?: boolean;
  readonly reconcile?: {
    readonly strategy?: string;
    readonly method?: string | null;
  } | null;
}

/** 特性门元数据：解释该门由什么触发。 */
export interface FeatureMeta {
  readonly label: string;
  readonly kind: FeatureKind;
  readonly params: readonly string[];
  readonly methods: readonly string[];
}

/** 参数级特性门规则。methods 省略表示对所有方法生效。 */
export interface FeatureParamRule {
  readonly feature: string;
  readonly param: string;
  readonly kind: ParamRuleKind;
  readonly methods?: readonly string[];
}

/** 对端缺失的特性（featureShortfall 的返回项）。 */
export interface FeatureShortfall {
  readonly feature: string;
  readonly required: string;
  readonly actual: string;
}

/** 对端实例的最小投影：只需要协议版本字段。 */
export interface ProtocolPeer {
  readonly protocol?: unknown;
}

/** 协议版本比较函数；任一侧无法解析时返回 null（调用方按拒绝处理）。 */
export type ProtocolCompare = (actual: unknown, required: unknown) => number | null;

/** 特性可用性快照项（featureMatrix 的返回值）。 */
export interface FeatureAvailability {
  required: string;
  actual: string;
  available: boolean;
}
