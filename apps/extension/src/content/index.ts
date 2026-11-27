// src/content/index.ts —— 内容脚本公共入口（协议 + 页面侧会话 + DOM 动作实现）。
export * from './protocol.ts';
export * from './dom.ts';
export {
  browserDomEnvironment,
  ContentSession,
  failureOf,
  newDocumentId,
} from './session.ts';
export type {
  ClickParams,
  ContentSessionOptions,
  EvaluateParams,
  FillParams,
  ObserveParams,
  PageTargetParams,
  ReadParams,
  SelectParams,
} from './session.ts';
export { installContentBridge } from './entry.ts';
export type { ContentBridgeMarker, InstallContentBridgeOptions } from './entry.ts';
