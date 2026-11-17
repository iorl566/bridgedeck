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

// error-codes:begin
/** 协议错误码；未知码在传输层归一为 E_INTERNAL。 */
export type BridgeErrorCode =
  | 'E_BAD_ARG'
  | 'E_NOT_FOUND'
  | 'E_NOT_ACTIONABLE'
  | 'E_STALE_REF'
  | 'E_OPTION_NOT_FOUND'
  | 'E_OPTION_AMBIGUOUS'
  | 'E_UNKNOWN_METHOD'
  | 'E_NO_SESSION'
  | 'E_SESSION_BUSY'
  | 'E_SESSION_PAUSED'
  | 'E_SESSION_STOPPED'
  | 'E_QUEUE_FULL'
  | 'E_RATE_LIMITED'
  | 'E_CANCELLED'
  | 'E_REQUEST_CANCELLED'
  | 'E_INPUT_BUSY'
  | 'E_NO_TAB'
  | 'E_NO_BROWSER'
  | 'E_BROWSER_AMBIGUOUS'
  | 'E_START_PENDING'
  | 'E_START_NOT_READY'
  | 'E_OBSERVATION_STALE'
  | 'E_CURSOR_STALE'
  | 'E_CONTEXT_REQUIRED'
  | 'E_CONTEXT_STALE'
  | 'E_DEPENDS_FAILED'
  | 'E_EXPECT_FAILED'
  | 'E_OBSERVATION_CHANGED'
  | 'E_OCCLUDED'
  | 'E_OBSCURED'
  | 'E_TARGET_MISMATCH'
  | 'E_CAPTURE_STALE'
  | 'E_BAD_MODE'
  | 'E_DIALOG_PENDING'
  | 'E_EXISTS'
  | 'E_CACHE_EMPTY'
  | 'E_TOO_LARGE'
  | 'E_RESULT_TOO_LARGE'
  | 'E_JS_ERROR'
  | 'E_NAV_FAIL'
  | 'E_TIMEOUT'
  | 'E_DEBUGGER_BUSY'
  | 'E_UNSUPPORTED_CAPABILITY'
  | 'E_UNSUPPORTED_REMOTE'
  | 'E_PROTOCOL_UNSUPPORTED'
  | 'E_AUTH'
  | 'E_AUTH_BUSY'
  | 'E_AUTH_CHALLENGE'
  | 'E_AUTH_EXPIRED'
  | 'E_AUTH_FAILED'
  | 'E_AUTH_PROOF'
  | 'E_AUTH_STATE'
  | 'E_PAIR_INVALID'
  | 'E_PAIR_REQUIRED'
  | 'E_PAUSED_MANUAL'
  | 'E_LEDGER_PENDING'
  | 'E_DAEMON'
  | 'E_NO_DAEMON'
  | 'E_DAEMON_TIMEOUT'
  | 'E_DISCONNECTED'
  | 'E_EXTENSION_GONE'
  | 'E_LISTEN'
  | 'E_SPAWN'
  | 'E_ENV'
  | 'E_CONFIG_INVALID'
  | 'E_BAD_JSON'
  | 'E_BAD_REQUEST'
  | 'E_INVALID_PARAMS'
  | 'E_DIRECT_RPC_DISABLED'
  | 'E_RPC'
  | 'E_OUTPUT'
  | 'E_TARGET_NOT_FILLABLE'
  | 'E_NOT_SELECT'
  | 'E_BROWSER'
  | 'E_SCREENSHOT'
  | 'E_PREVIEW_META'
  | 'E_CLICK'
  | 'E_KEY'
  | 'E_FOCUS'
  | 'E_PAGE_ERROR'
  | 'E_OBSERVE_FAILED'
  | 'E_FOLLOW_FAILED'
  | 'E_RELEASE_INVALID'
  | 'E_UPDATE'
  | 'E_MCP_CONFLICT'
  | 'E_APP_SSO_FAILED'
  | 'E_TRANSFER_NOT_FOUND'
  | 'E_TRANSFER_STATE'
  | 'E_BORROW_DENIED'
  | 'E_BORROW_CONFLICT'
  | 'E_BORROW_TIMEOUT'
  | 'E_HELP_DISABLED'
  | 'E_NO_DOWNLOAD'
  | 'E_DOWNLOAD_FAILED'
  | 'E_NO_FILE_CHOOSER'
  | 'E_TRANSFER_OFFSET'
  | 'E_TRANSFER_LIMIT'
  | 'E_TRANSFER_INCOMPLETE'
  | 'E_INCOGNITO_UNAVAILABLE'
  | 'E_RECIPE_NOT_APPROVED'
  | 'E_RECIPE_CHANGED'
  | 'E_RECIPE_EXPIRED'
  | 'E_RECIPE_LOCKED'
  | 'E_FORBIDDEN'
  | 'E_INTERNAL';
// error-codes:end

export declare const ERROR_CODES: Readonly<Record<BridgeErrorCode, string>>;
export declare function normalizeErrorCode(code: string): BridgeErrorCode;

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
  clickBackend(backendNodeId: number, options?: ActionOptions): Promise<unknown>;
  hover(target: string | TargetOptions, options?: ActionOptions): Promise<unknown>;
  fill(target: string | TargetOptions, value: string, options?: ActionOptions): Promise<unknown>;
  press(key: string, options?: ActionOptions & { target?: string | TargetOptions }): Promise<unknown>;
  select(target: string | TargetOptions, value: string, options?: ActionOptions): Promise<unknown>;
  focus(target: string | TargetOptions): Promise<unknown>;
  scrollTo(target: string | TargetOptions): Promise<unknown>;
  read(target?: string | TargetOptions): Promise<unknown>;
  evaluate<T = unknown>(expression: string, options?: { unverified?: boolean }): Promise<{ value?: T; verified?: boolean }>;
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
