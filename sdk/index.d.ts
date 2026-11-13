// sdk/index.d.ts —— BrowserBridge Node SDK 类型声明
export interface DaemonInfo {
  pid?: number;
  port: number;
  token: string;
  version?: string;
  tls?: boolean;
}

export interface ConnectOptions {
  /** 状态目录；默认 BB_HOME 或 ~/.browser-bridge */
  home?: string;
  /** 单次 RPC 默认超时（ms） */
  timeoutMs?: number;
  /** daemon 未运行时是否自动拉起，默认 true */
  autoStart?: boolean;
  /** 自动拉起等待上限（ms） */
  startTimeoutMs?: number;
}

export interface NewPageOptions {
  url?: string;
  browser?: string;
  tab?: number;
  noFocus?: boolean;
  incognito?: boolean;
  controller?: unknown;
  timeoutMs?: number;
}

export interface TargetOptions {
  ref?: string;
  selector?: string;
  [key: string]: unknown;
}

export interface ActionOptions {
  trusted?: boolean;
  force?: boolean;
  timeoutMs?: number;
  waitTimeoutMs?: number;
  settleMs?: number;
  [key: string]: unknown;
}

export interface ObserveOptions {
  maxTokens?: number;
  maxDepth?: number;
  cursor?: string;
  vom?: boolean;
  ax?: boolean;
  frames?: boolean;
  delta?: boolean;
  [key: string]: unknown;
}

export interface Observation {
  url?: string;
  title?: string;
  observation?: string;
  refs?: number;
  [key: string]: unknown;
}

export interface ScreenshotOptions {
  /** 写文件的路径；不传则只返回 dataUrl */
  path?: string;
  fullPage?: boolean;
  scope?: 'viewport' | 'document' | 'follow' | 'current';
  annotate?: boolean;
  [key: string]: unknown;
}

export class BridgeRpcError extends Error {
  code: string;
  data?: unknown;
  method: string | null;
  effectState: string | null;
  constructor(code: string, message: string, options?: { data?: unknown; method?: string });
}

export class Page {
  readonly bridge: BrowserBridge;
  readonly id: string;
  readonly tabId: number | null;
  readonly windowId: number | null;
  readonly instanceId: string | null;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  goto(url: string, options?: ActionOptions): Promise<{ url: string; title?: string }>;
  reload(options?: ActionOptions): Promise<unknown>;
  back(options?: ActionOptions): Promise<unknown>;
  forward(options?: ActionOptions): Promise<unknown>;
  click(target: string | TargetOptions, options?: ActionOptions): Promise<unknown>;
  hover(target: string | TargetOptions, options?: ActionOptions): Promise<unknown>;
  fill(target: string | TargetOptions, value: string, options?: ActionOptions): Promise<unknown>;
  press(key: string, options?: ActionOptions & { target?: string | TargetOptions }): Promise<unknown>;
  select(target: string | TargetOptions, value: string, options?: ActionOptions): Promise<unknown>;
  focus(target: string | TargetOptions): Promise<unknown>;
  scrollTo(target: string | TargetOptions): Promise<unknown>;
  read(target?: string | TargetOptions): Promise<unknown>;
  evaluate<T = unknown>(expression: string): Promise<{ value?: T }>;
  observe(options?: ObserveOptions): Promise<Observation>;
  snapshot(): Promise<unknown>;
  waitForElement(target: string | TargetOptions, options?: { state?: string; timeoutMs?: number }): Promise<unknown>;
  waitForNavigation(options?: { waitUntil?: string; timeoutMs?: number }): Promise<unknown>;
  waitMs(ms: number): Promise<unknown>;
  screenshot(options?: ScreenshotOptions): Promise<{ dataUrl?: string; width?: number; height?: number }>;
  pause(reason?: string): Promise<{ paused: boolean; pausedBy: string | null }>;
  resume(): Promise<{ paused: boolean; pausedBy: string | null }>;
  close(options?: { keep?: boolean }): Promise<{ ok: boolean }>;
}

export class BrowserBridge {
  info: { port: number; token: string; tls: boolean };
  home: string;
  timeoutMs: number;
  constructor(info: DaemonInfo, options?: { home?: string; timeoutMs?: number });
  static connect(options?: ConnectOptions): Promise<BrowserBridge>;
  rpc<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
  status(): Promise<unknown>;
  sessions(): Promise<Array<Record<string, unknown>>>;
  browsers(): Promise<Array<Record<string, unknown>>>;
  newPage(options?: NewPageOptions): Promise<Page>;
  page(sessionId: string): Promise<Page>;
  pages(): Promise<Page[]>;
  stopDaemon(): Promise<void>;
}

export function connect(options?: ConnectOptions): Promise<BrowserBridge>;
export function defaultHome(): string;
export function daemonInfoPath(home?: string): string;
export function readDaemonInfo(home?: string): DaemonInfo | null;
export function startDaemon(options?: { home?: string; timeoutMs?: number }): Promise<DaemonInfo>;
export function targetParams(target: string | TargetOptions): { ref?: string; selector?: string };
export function writeDataUrl(outputPath: string, dataUrl: string): string;
