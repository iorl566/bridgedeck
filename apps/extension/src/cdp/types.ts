// src/cdp/types.ts —— chrome.debugger / CDP 通道的公共契约（M-C 第六批）。
//
// 这个目录是 TS 扩展里**唯一**允许触碰 chrome.debugger 的地方：
// - 只做通道封装（attach/detach/send/子 session/超时/错误归一/降级），不做业务；
// - 业务侧（frames / 未来的 debug 域）通过 `FrameCdpLike` / `CdpClient` 的窄接口使用；
// - 所有类型不引用 DOM 全局，也不在模块加载期读 `chrome`（单测可在 Node 里 import）。
//
// 版本口径：chrome.debugger.attach 的协议版本用 '1.3'（与 JS 兼容目标
// extension/src/debugger.js 一致；Playwright/Puppeteer 也用 1.3）。

/** chrome.debugger 的 target：tab 级（有 tabId 无 sessionId）或 flatten 子 session。 */
export interface CdpTarget {
  tabId: number;
  sessionId?: string;
}

/** 事件来源：root target（只有 tabId）或子 target（带 sessionId）。 */
export interface CdpEventSource {
  tabId?: number;
  sessionId?: string;
}

export type CdpEventHandler = (params: Record<string, unknown>, source: CdpEventSource) => void;
export type CdpDetachListener = (reason: string) => void;

/** chrome.events.Event 的最小形状（只声明用得到的两个方法）。 */
export interface CdpListenerApi<L> {
  addListener(listener: L): void;
  removeListener?(listener: L): void;
}

/**
 * chrome.debugger 命名空间的最小形状。
 *
 * 不直接使用 @types/chrome（本工作区未安装），也不在类型层面依赖 WXT：
 * 这样 background / 单测可以注入自己的实现（测试用假的 chrome.debugger）。
 */
export interface ChromeDebuggerApi {
  attach(target: CdpTarget, requiredVersion: string): Promise<void>;
  detach(target: CdpTarget): Promise<void>;
  sendCommand(target: CdpTarget, method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent?: CdpListenerApi<(source: CdpEventSource, method: string, params: Record<string, unknown>) => void>;
  onDetach?: CdpListenerApi<(source: CdpEventSource, reason: string) => void>;
}

/** 归一后的 CDP 错误码（不是 RPC 错误码；frames 层负责降级/包装）。 */
export type CdpErrorCode =
  | 'E_CDP_UNAVAILABLE'
  | 'E_CDP_ATTACH'
  | 'E_CDP_BUSY'
  | 'E_CDP_FORBIDDEN'
  | 'E_CDP_DETACHED'
  | 'E_CDP_TIMEOUT'
  | 'E_CDP_NO_TAB'
  | 'E_CDP_COMMAND';

/** 一条已建立的子 target session（Target.attachedToTarget 的归并结果）。 */
export interface CdpTargetSession {
  sessionId: string;
  targetId: string;
  /** 'iframe'（本通道只自动附加 iframe/OOPIF）。 */
  type: string;
  url: string;
  /** 父 session：根 target 的子 session 为 null；嵌套 OOPIF 指向父 session。 */
  parentSessionId: string | null;
  attachedAt: number;
}

export interface CdpSendOptions {
  /** 单条命令超时（默认 5000ms；0 表示不额外加超时）。 */
  timeoutMs?: number;
  /** 子 session（flatten）；省略即 root target。 */
  sessionId?: string;
}

export interface CdpAttachOptions {
  timeoutMs?: number;
}

export interface CdpAutoAttachOptions {
  /** 根 setAutoAttach 命令超时。 */
  timeoutMs?: number;
}

export interface CdpWaitSessionsOptions {
  /** 连续多少个 settle 窗口没有新 session 视为稳定（默认 250ms）。 */
  settleMs?: number;
  /** 整体等待上限（默认 3000ms）。 */
  timeoutMs?: number;
}

export interface CdpStatus {
  available: boolean;
  attached: boolean;
  sessions: number;
  features: string[];
}
