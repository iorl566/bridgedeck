// src/protocol.ts —— 扩展 TS 栈对 `packages/protocol` 的唯一适配入口。
//
// 为什么要有这一层：
// - `packages/protocol` 是协议单源（165 方法 / feature floor / 五维状态），本工作树
//   尚未把它注册成 npm 依赖（本轮硬约束：不新增依赖、不 npm install），所以只能以
//   相对路径直接引用其源码；集中到本文件后，将来改成 workspace 依赖只需改这里。
// - 扩展侧只需要“读协议 + 过闸门”，不需要生成器；把导出面收窄可以避免误用内部实现。
//
// 注意：本文件 import 的 `.ts` 后缀是 Node 24 type-stripping 与 WXT/Vite 都能解析的
// 形式；type-only 导出一律用 `export type`，满足 verbatimModuleSyntax。

export {
  CATALOG_SIGNATURE,
  METHOD_COUNT,
  METHOD_NAMES,
  METHOD_CATALOG,
  METHOD_EFFECT_TABLE,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../../packages/protocol/src/generated.ts';
export type { MethodName } from '../../../packages/protocol/src/generated.ts';

export {
  assertProtocolCompatible,
  protocolGate,
  compatibilityMatrix,
} from '../../../packages/protocol/src/gate.ts';
export type {
  ProtocolDecision,
  ProtocolPass,
  ProtocolReject,
} from '../../../packages/protocol/src/gate.ts';

export {
  PROTOCOL_UNSUPPORTED,
  LEGACY_CAPABILITY_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED_ALIASES,
  ProtocolError,
  isProtocolError,
  isProtocolUnsupportedCode,
  isProtocolUnsupportedError,
  protocolErrorDataOf,
} from '../../../packages/protocol/src/errors.ts';
export type { ProtocolErrorCode, ProtocolErrorData } from '../../../packages/protocol/src/errors.ts';

export {
  COMPAT_PROBE_VERSIONS,
  FEATURE_NAMES_IN_ORDER,
  FEATURE_RECOVERY,
  featureMatrix,
  featureMetaOf,
  featureShortfall,
  featuresForCall,
  floorForFeature,
  methodFeature,
  requiredFloorFor,
} from '../../../packages/protocol/src/features.ts';

export {
  compareProtocol,
  formatProtocol,
  parseProtocol,
  protocolAtLeast,
  protocolLabel,
} from '../../../packages/protocol/src/version.ts';

export {
  catalogRow,
  floorOf,
  isMutatingInCatalog,
  methodState,
  normalizeMethodName,
  ownerOf,
} from '../../../packages/protocol/src/state.ts';

export type {
  CatalogRow,
  FeatureShortfall,
  MethodEffect,
  MethodOwner,
  MethodState,
  ProtocolCompare,
  ProtocolPeer,
} from '../../../packages/protocol/src/types.ts';
