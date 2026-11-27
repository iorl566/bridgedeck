// sdk/index.d.ts —— BrowserBridge Node SDK 类型声明
export interface DaemonInfo {
  pid?: number;
  port: number;
  token: string;
  version?: string;
  tls?: boolean;
  /** daemon/扩展上报的协议版本（用于 SDK 能力门禁）。 */
  protocol?: string;
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
  | 'E_COOPERATION_STALE'
  | 'E_CONTROL_CONTEXT_INVALID'
  | 'E_UNSUPPORTED_FEATURE'
  | 'E_DEPENDS_FAILED'
  | 'E_EXPECT_FAILED'
  | 'E_OBSERVATION_CHANGED'
  | 'E_TARGET_DETACHED'
  | 'E_TOKEN_BAD_ARG'
  | 'E_TOKEN_UNKNOWN'
  | 'E_TOKEN_EXPIRED'
  | 'E_TOKEN_USED'
  | 'E_TOKEN_GRANTEE'
  | 'E_TOKEN_CAPACITY'
  | 'E_CAPTURE_BAD_TAB'
  | 'E_CAPTURE_LIMIT'
  | 'E_SESSION_STATE'
  | 'E_SESSION_TRANSITION'
  | 'E_LEDGER_IO'
  | 'E_LEDGER_WAL_IO'
  | 'E_LEDGER_FSYNC'
  | 'E_LEDGER_RECOVER'
  | 'E_LEDGER_CONFLICT'
  | 'E_LEDGER_RESOLVE_REQUIRED'
  | 'E_TAB_LEASE_HELD'
  | 'E_TAB_LEASE_NOT_HELD'
  | 'E_SNAPSHOT_DISABLED'
  | 'E_SNAPSHOT_WRITE'
  | 'E_SNAPSHOT_CORRUPT'
  | 'E_UNSUPPORTED'
  | 'E_ARG_MISSING'
  | 'E_ARG_TYPE'
  | 'E_ARG_ENUM'
  | 'E_ARG_CONFLICT'
  | 'E_ARG_REQUIRES'
  | 'E_ARG_RANGE'
  | 'E_ARG_UNEXPECTED'
  | 'E_ARG_USAGE'
  | 'E_UNKNOWN_FLAG'
  | 'E_BAD_SUBCOMMAND'
  | 'E_HUMAN_GATE'
  | 'E_EVAL_CORPUS'
  | 'E_EVAL_RUNNER'
  | 'E_EVAL_DOM'
  | 'E_EVAL_DOM_ARGS'
  | 'E_EVAL_DOM_BAD_FACTS'
  | 'E_EVAL_DOM_BAD_JSON'
  | 'E_EVAL_DOM_FIXTURE'
  | 'E_EVAL_DOM_NO_BROWSER'
  | 'E_EVAL_DOM_NO_FACTS'
  | 'E_EVAL_DOM_NO_MARKER'
  | 'E_EVAL_DOM_SPAWN'
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
  | 'E_PROTOCOL_AUDIT'
  | 'E_AUTH'
  | 'E_AUTH_BUSY'
  | 'E_AUTH_CHALLENGE'
  | 'E_AUTH_EXPIRED'
  | 'E_AUTH_FAILED'
  | 'E_AUTH_PROOF'
  | 'E_AUTH_STATE'
  | 'E_PAIR_INVALID'
  | 'E_PAIR_REQUIRED'
  | 'E_PAIR_REJECTED'
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
  | 'E_CONTROL_NOT_HELD'
  | 'E_CONTROL_BUSY'
  | 'E_CONTROL_STALE'
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
  | 'E_RECIPE_DRAFT_EMPTY'
  | 'E_RECIPE_LOCKED'
  | 'E_FORBIDDEN'
  | 'E_READ_ONLY'
  | 'E_EXEC_FAILED'
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

// ---------------------------------------------------------------------------
// W4-A：MCP 67 工具语义（Node SDK）
// ---------------------------------------------------------------------------

/** 工具分级：read 只读；mutate 常规可恢复变更；destructive 需要人工审批。 */
export type ToolTier = 'read' | 'mutate' | 'destructive';

/** MCP tool annotations（与 tools/list 输出一致）。 */
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolProperty {
  type: string | string[] | null;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: { type: string | null };
}

/** 分页标记：partial=true 时必须检查 cursor/truncated 再决定是否续读。 */
export interface ToolPagination {
  partial: boolean;
  methods: string[];
  cursorParam: string | null;
  resultFields: string[];
  resumeHint: string;
}

/** 单工具 SDK 目录。 */
export interface ToolSpec {
  name: ToolName;
  title: string;
  description: string;
  methods: string[];
  tier: ToolTier;
  approvalRequired: boolean;
  timeoutMs: number;
  idempotent: boolean;
  openWorld: boolean;
  annotations: ToolAnnotations;
  featureGates: string[];
  minProtocol: string | null;
  required: string[];
  properties: Record<string, ToolProperty>;
  pagination: ToolPagination;
  contract: {
    localParams: string[];
    unexposed: Record<string, { params: string[]; reason: string }>;
    actions: { arg: string; actions: string[] } | null;
    localOnly: boolean;
  };
}

export interface ToolArgumentIssue {
  code: string;
  path: string;
  message: string;
}

export interface ToolValidationResult {
  ok: boolean;
  errors: ToolArgumentIssue[];
}

export interface ToolCallOptions {
  /** destructive 工具需要显式审批；只对本次调用生效。 */
  approval?: boolean;
  /** 覆盖工具策略里的 timeoutMs。 */
  timeoutMs?: number;
}

export interface ToolCallDetailedResult {
  tool: ToolName;
  tier: ToolTier;
  methods: string[];
  elapsedMs: number;
  result: unknown;
}

export interface ToolCallRuntime {
  home: string;
  listTools(): ToolSpec[];
  describe(name: string): ToolSpec | null;
  validate(name: string, args?: Record<string, unknown>): ToolValidationResult;
  callTool<T = unknown>(name: string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<T>;
  callToolDetailed<T = unknown>(name: string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallDetailedResult & { result: T }>;
  close(): Promise<{ ok: boolean; stopped: boolean; code?: string }>;
  sessionId(): string | null;
}

export class ToolCallError extends Error {
  code: string;
  tool: string | null;
  details?: unknown;
  constructor(code: string, message: string, options?: { tool?: string; details?: unknown });
}

export function createToolRuntime(options: {
  bridge: Pick<BrowserBridge, 'rpc'>;
  home?: string;
  env?: Record<string, string | undefined>;
  state?: { sessionId?: string | null };
}): ToolCallRuntime;

/** 92 个 MCP 工具名（与 mcp/tools-*.mjs 注册顺序一致）。 */
export type ToolName =
  | 'browser_brief'
  | 'browser_update_state'
  | 'browser_session_start'
  | 'browser_session_stop'
  | 'browser_audit'
  | 'browser_settings'
  | 'browser_pair'
  | 'browser_install_skill'
  | 'browser_recipe'
  | 'browser_update'
  | 'browser_record_start'
  | 'browser_record_stop'
  | 'browser_record_list'
  | 'browser_status'
  | 'browser_plan'
  | 'browser_observe'
  | 'browser_navigate'
  | 'browser_click'
  | 'browser_click_backend'
  | 'browser_fill'
  | 'browser_read'
  | 'browser_extract'
  | 'browser_evaluate'
  | 'browser_screenshot'
  | 'browser_pdf'
  | 'browser_upload'
  | 'browser_download'
  | 'browser_longshot_recover'
  | 'browser_tabs'
  | 'browser_tab_new'
  | 'browser_tab_close'
  | 'browser_tab_select'
  | 'browser_tab_move'
  | 'browser_refs_negotiate'
  | 'browser_trace_start'
  | 'browser_trace_stop'
  | 'browser_trace_summary'
  | 'browser_debug_start'
  | 'browser_debug_stop'
  | 'browser_debug_analyze'
  | 'browser_debug_evidence'
  | 'browser_debug_journal'
  | 'browser_debug_query'
  | 'browser_debug_archive'
  | 'browser_debug_archives'
  | 'browser_debug_har'
  | 'browser_debug_har_import'
  | 'browser_network_waterfall'
  | 'browser_network_replay_har'
  | 'browser_network_list'
  | 'browser_rule_list'
  | 'browser_rule_add'
  | 'browser_rule_clear'
  | 'browser_rule_set'
  | 'browser_video_start'
  | 'browser_video_stop'
  | 'browser_video_recover'
  | 'browser_video_status'
  | 'browser_video_list'
  | 'browser_video_trim'
  | 'browser_video_info'
  | 'browser_video_split'
  | 'browser_video_merge'
  | 'browser_window'
  | 'browser_wait_for'
  | 'browser_cooperate_sync'
  | 'browser_dialog'
  // M6-P0①：兼容目标 MCP 直接动作入口（press/hover/select/drag/scroll_to/wheel/focus/blur、
  // back/forward/reload/console、session.request_*、tab borrow/return）。
  | 'browser_press'
  | 'browser_hover'
  | 'browser_select'
  | 'browser_drag'
  | 'browser_scroll_to'
  | 'browser_wheel'
  | 'browser_focus'
  | 'browser_blur'
  | 'browser_reload'
  | 'browser_back'
  | 'browser_forward'
  | 'browser_console'
  | 'browser_session_request_prepare'
  | 'browser_session_request_status'
  | 'browser_session_request_claim'
  | 'browser_session_request_cancel'
  | 'browser_tab_borrow'
  | 'browser_tab_return'
  // M6-P0②：剩余 MCP 动作（inspect html / assist emulate+request_help+operation.* /
  // session browsers+list），与 mcp/tools-m6b.mjs 注册顺序一致。
  | 'browser_inspect_html'
  | 'browser_assist_emulate'
  | 'browser_assist_request_help'
  | 'browser_assist_operation_await'
  | 'browser_assist_operation_cancel'
  | 'browser_session_browsers'
  | 'browser_session_list';

export const TOOL_NAMES: ReadonlyArray<ToolName>;
export function listToolSpecs(): ToolSpec[];
export function toolSpec(name: string): ToolSpec | null;
export function toolTierSummary(): { total: number; byTier: Record<ToolTier, number>; approvals: string[]; paginated: string[] };
export function validateToolInput(name: string, args?: Record<string, unknown>): ToolValidationResult;
export function validateToolArgs(name: string, args?: Record<string, unknown>): ToolValidationResult;

/** 协议能力门禁结果。 */
export interface ProtocolGateResult {
  ok: boolean;
  features: string[];
  missing: Array<{ feature: string; required: string }>;
  code: string | null;
}

export function methodProtocolGate(method: string, params?: Record<string, unknown>, peerVersion?: string): ProtocolGateResult;
export function toolProtocolGate(name: string, input: { methods?: string[]; featureGates?: string[]; params?: Record<string, unknown> }, peerVersion?: string): ProtocolGateResult;
export function protocolSupports(feature: string, version?: string): boolean;
export function isProtocolUnsupportedCode(code: string): boolean;

/** SDK ↔ 协议契约快照（错误码 / feature floor / 方法状态机 / 工具分档分页）。 */
export interface SdkContract {
  protocol: { current: string; baseline: string };
  errors: { codes: string[]; details: Readonly<Record<string, string>>; recovery: Readonly<Record<string, { retry: string; hint: string }>>; unsupportedCode: string };
  features: { names: string[]; floors: Readonly<Record<string, string>>; meta: Readonly<Record<string, unknown>> };
  methods: {
    total: number;
    names: string[];
    effects: Readonly<Record<string, string>>;
    feature: Readonly<Record<string, string>>;
    floors: Readonly<Record<string, string>>;
    partial: string[];
    unknown: string[];
    reconcile: Readonly<Record<string, string>>;
    states: Readonly<Record<string, unknown>>;
  };
  tools: { names: ToolName[]; tiers: { total: number; byTier: Record<ToolTier, number>; approvals: string[]; paginated: string[] }; pagination: Record<string, ToolPagination> };
  catalog: ReadonlyArray<Record<string, unknown>>;
}

export const SDK_CONTRACT: SdkContract;
export const TOOL_PAGINATION: Record<ToolName, ToolPagination>;


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
  /** 在会话上下文里调用任意 MCP 工具（自动补 session）。 */
  callTool<T = unknown>(name: ToolName | string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<T>;
}

export class BrowserBridge {
  info: { port: number; token: string; tls: boolean };
  home: string;
  timeoutMs: number;
  /** daemon 上报的协议版本（没有则为 null，表示按当前协议乐观处理）。 */
  protocol: string | null;
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
  /** MCP 工具运行时（惰性创建）。 */
  readonly toolRuntime: ToolCallRuntime;
  listTools(): ToolSpec[];
  toolSpec(name: string): ToolSpec | null;
  validateToolArgs(name: string, args?: Record<string, unknown>): ToolValidationResult;
  toolTierSummary(): { total: number; byTier: Record<ToolTier, number>; approvals: string[]; paginated: string[] };
  callTool<T = unknown>(name: ToolName | string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<T>;
  callToolDetailed<T = unknown>(name: ToolName | string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallDetailedResult & { result: T }>;
  closeTools(): Promise<{ ok: boolean; stopped: boolean; code?: string }>;
  toolProtocolGate(name: string, peerVersion?: string | null): ProtocolGateResult;
}

export function connect(options?: ConnectOptions): Promise<BrowserBridge>;
export function defaultHome(): string;
export function daemonInfoPath(home?: string): string;
export function readDaemonInfo(home?: string): DaemonInfo | null;
export function startDaemon(options?: { home?: string; timeoutMs?: number }): Promise<DaemonInfo>;
export function targetParams(target: string | TargetOptions): { ref?: string; selector?: string };
export function writeDataUrl(outputPath: string, dataUrl: string): string;

// ---------------------------------------------------------------------------
// 第十一批-C：MCP 客户端（spawn mcp/server.mjs）的传输生命周期 / 重连 / 订阅对账类型。
// ---------------------------------------------------------------------------

export interface ReconnectPolicy {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  healthCheck: boolean;
  resubscribe: boolean;
  handshakeTimeoutMs: number;
  /** 只对幂等工具自动重放（默认 true；非幂等工具需要显式关闭）。 */
  retryIdempotentOnly: boolean;
}

export interface ReconnectAttemptError {
  attempt: number;
  code: string;
  message: string;
}

export interface ReconnectResult {
  connected: boolean;
  attempts: number;
  elapsedMs: number;
  errors: ReadonlyArray<ReconnectAttemptError>;
  result: unknown;
  reason: string;
}

export interface ReconnectTrackerSnapshot {
  state: 'connected' | 'disconnected' | 'reconnecting' | 'failed';
  attempts: number;
  totalAttempts: number;
  connects: number;
  failures: number;
  maxAttempts: number;
  lastConnectedAt: string | null;
  lastFailure: { code: string | null; message: string } | null;
  events: ReadonlyArray<Record<string, unknown>>;
}

export interface McpTransportSnapshot {
  alive: boolean;
  closed: boolean;
  exited: boolean;
  pid: number | null;
  startedAt: string | null;
  uptimeMs: number;
  requests: number;
  responses: number;
  notifications: number;
  pending: number;
  exitInfo: { code: number | null; signal: string | null; at: string } | null;
  stderr: string;
}

export interface McpClientTransportSnapshot {
  connected: boolean;
  closed: boolean;
  protocolVersion: string | null;
  serverInfo: { name: string; version: string } | null;
  reconnect: {
    policy: ReconnectPolicy;
    tracker: ReconnectTrackerSnapshot;
    lastResult: ReconnectResult | null;
  };
  transport: McpTransportSnapshot | null;
  subscriptions: string[];
  handlers: number;
}

export interface SyncSubscriptionsResult {
  toSubscribe: string[];
  toUnsubscribe: string[];
  unchanged: string[];
  subscribed: string[];
  unsubscribed: string[];
  errors: ReadonlyArray<{ uri: string; code: string }>;
}

export interface McpClientOptions {
  home?: string;
  node?: string;
  timeoutMs?: number;
  transport?: unknown;
  env?: Record<string, string | undefined>;
  /** 重连时新建传输的工厂（测试可注入 fake）；默认新建 McpTransport。 */
  transportFactory?: (options: Record<string, unknown>) => unknown;
  /** 重连策略：false/省略=关闭；true=默认参数；对象=细粒度配置。 */
  reconnect?: boolean | Partial<ReconnectPolicy> | null;
  /** 可注入的 sleep（测试用，避免真实等待）。 */
  sleep?: (ms: number) => Promise<void>;
}

export class McpRpcError extends Error {
  code: string;
  method: string | null;
  rpcCode: number | null;
  data: unknown;
  requestId: number | null;
}

export class McpTransport {
  constructor(options?: { command?: string[]; cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number });
  readonly alive: boolean;
  start(): this;
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number; onStart?: (id: number) => void }): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
  cancel(requestId: number, reason?: string): boolean;
  addNotificationHandler(handler: (message: Record<string, unknown>) => void): (message: Record<string, unknown>) => void;
  removeNotificationHandler(handler: (message: Record<string, unknown>) => void): boolean;
  restart(): this;
  snapshot(): McpTransportSnapshot;
  close(): void;
}

export class McpClient {
  constructor(options?: McpClientOptions);
  readonly transport: McpTransport;
  connect(): Promise<this>;
  ensureConnected(): Promise<this>;
  close(): void;
  transportSnapshot(): McpClientTransportSnapshot;
  syncResourceSubscriptions(desired: Iterable<string>, options?: { ignoreErrors?: boolean }): Promise<SyncSubscriptionsResult>;
  resourceSubscriptions(): string[];
  subscribeResource(uri: string): Promise<Record<string, unknown>>;
  unsubscribeResource(uri: string): Promise<Record<string, unknown>>;
  callTool<T = unknown>(name: string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<T>;
  callToolDetailed<T = unknown>(name: string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<{ payload: T; meta: Record<string, unknown>; elapsedMs: number; progress: unknown; requestId: number | null }>;
  callToolPaged(name: string, args?: Record<string, unknown>, options?: ToolCallOptions & { maxPages?: number }): Promise<{ pages: unknown[]; payloads: unknown[]; stoppedReason: string; calls: number }>;
  cancelRequest(requestId: number, reason?: string): boolean;
}

export function createMcpClient(options?: McpClientOptions): Promise<McpClient>;
export function withMcpClient<T>(options: McpClientOptions, fn: (client: McpClient) => Promise<T> | T): Promise<T>;

export function resolveReconnectPolicy(option?: boolean | Partial<ReconnectPolicy> | null): ReconnectPolicy;
export function isReconnectableError(error: unknown): { reconnectable: boolean; reason: string; code: string };
export function backoffDelayMs(attempt: number, policy?: Partial<ReconnectPolicy>, options?: { code?: string }): number;
export class ReconnectTracker {
  constructor(options?: { policy?: ReconnectPolicy; now?: () => number });
  recordConnected(): this;
  recordDisconnect(error?: unknown): this;
  recordFailed(error?: unknown): this;
  beginAttempt(error?: unknown): { attempt: number; maxAttempts: number; delayMs: number };
  canRetry(): boolean;
  snapshot(): ReconnectTrackerSnapshot;
}
export function runReconnect(connectFn: (context: { attempt: number; maxAttempts: number; error: Error | null }) => Promise<unknown>, options?: { policy?: ReconnectPolicy; tracker?: ReconnectTracker; error?: Error | null; sleep?: (ms: number) => Promise<void>; onEvent?: (event: Record<string, unknown>) => void }): Promise<ReconnectResult>;
export function reconnectSnapshot(): Record<string, unknown>;