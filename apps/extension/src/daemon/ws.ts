// src/daemon/ws.ts —— 扩展 ↔ daemon 的 WebSocket 接入（PROTOCOL.md §3）。
//
// 与 0.3.0 JS 的 BridgeSocket 对齐的是**语义**，不是实现：
// - 连上后立刻发 hello（protocol/extVersion/browser/capabilities），等 hello-ack 才算连上；
// - daemon 每 15s 发 ping，客户端必须回 pong；客户端另有“长时间没有任何帧”的心跳看门狗，
//   超时主动断开并按退避重连（防止半开连接一直挂着）；
// - 断线后指数退避 + 抖动重连，成功后重置尝试计数；主动 stop() 不再重连；
// - 扩展发起只读调用走 { type:'call', id, method, params } → { type:'call-res', ... }；
// - 事件（tab-removed/help-resolved…）按名字分发，命令（cmd）交给注入的 handler。
//
// 所有外部依赖都可注入：WebSocket 构造器、时钟（setTimeout/now）、随机源。因此单测可以
// 用假时钟精确验证退避序列/心跳/超时，不需要真实等待；真实 daemon 冒烟则用默认实现。

import { EXTENSION_CAPABILITIES, EXTENSION_PROTOCOL_VERSION } from './types.ts';
import {
  daemonError,
  DaemonRpcError,
  mapDaemonError,
  transportError,
} from './errors.ts';
import type { DaemonErrorPayload } from './types.ts';
import type { DaemonCallOptions, DaemonRpcTransport } from './types.ts';
import { daemonWsUrl } from './types.ts';

export type DaemonSocketState =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'reconnecting'
  | 'rejected'
  | 'closed';

/** 可注入的 WebSocket 最小接口（DOM WebSocket 与测试假实现都能满足）。 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** 默认 WebSocket 工厂：MV3 service worker 与 Node 24 都有全局 WebSocket。 */
export const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const ctor = (globalThis as { WebSocket?: new (target: string) => unknown }).WebSocket;
  if (typeof ctor !== 'function') throw new Error('当前运行环境没有 WebSocket 全局构造器');
  return new ctor(url) as unknown as WebSocketLike;
};

/** 可注入时钟；返回值只是句柄，交由 clearTimeout 消费。 */
export interface DaemonSocketClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** 真实时钟（默认实现）。 */
export const realSocketClock: DaemonSocketClock = {
  setTimeout(handler, ms) {
    return setTimeout(handler, ms);
  },
  clearTimeout(handle) {
    if (handle !== null && handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// 帧类型与解析
// ---------------------------------------------------------------------------

/** handshake 成功：daemon 分配的实例 id、daemon 版本、协议版本、能力面。 */
export interface DaemonHelloAck {
  type: 'hello-ack';
  instanceId: string | null;
  daemonVersion: string | null;
  protocol: string | null;
  capabilities: readonly string[];
  localAuth: Record<string, unknown> | null;
  deviceToken: string | null;
  commitTxn: string | null;
}

export interface DaemonPingFrame {
  type: 'ping';
}

export interface DaemonPongFrame {
  type: 'pong';
}

/** daemon → 扩展的单向事件。 */
export interface DaemonEventFrame {
  type: 'event';
  event: string;
  params: Record<string, unknown>;
}

/** daemon → 扩展的命令（本批只做分发，不实现页面动作）。 */
export interface DaemonCommandFrame {
  type: 'cmd';
  id: string;
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number | null;
}

/** 扩展只读调用（type:'call'）的响应。 */
export interface DaemonCallResultFrame {
  type: 'call-res';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: DaemonErrorPayload;
}

export interface DaemonAuthChallengeFrame {
  type: 'auth-challenge';
  challenge: string;
  alg: string | null;
}

export interface DaemonHelloErrorFrame {
  type: 'hello-error';
  code: string;
  message: string;
}

export interface DaemonCommitFrame {
  type: 'commit-ack' | 'commit-error';
  txn: string | null;
  code: string | null;
  message: string | null;
}

export type DaemonFrame =
  | DaemonHelloAck
  | DaemonHelloErrorFrame
  | DaemonPingFrame
  | DaemonPongFrame
  | DaemonEventFrame
  | DaemonCommandFrame
  | DaemonCallResultFrame
  | DaemonAuthChallengeFrame
  | DaemonCommitFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeId(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeParams(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeErrorPayload(value: unknown): DaemonErrorPayload | null {
  if (!isRecord(value) || typeof value.code !== 'string' || !value.code) return null;
  return {
    code: value.code,
    message: typeof value.message === 'string' && value.message ? value.message : value.code,
    ...(value.data !== undefined ? { data: value.data } : {}),
  };
}

/** 运行时校验一帧；未知/畸形帧返回 null（调用方忽略，不抛异常拖垮连接）。 */
export function parseDaemonFrame(raw: unknown): DaemonFrame | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'hello-ack':
      return {
        type: 'hello-ack',
        instanceId: stringOrNull(raw.instanceId),
        daemonVersion: stringOrNull(raw.daemonVersion),
        protocol: stringOrNull(raw.protocol),
        capabilities: stringArrayOf(raw.capabilities),
        localAuth: isRecord(raw.localAuth) ? raw.localAuth : null,
        deviceToken: stringOrNull(raw.deviceToken),
        commitTxn: stringOrNull(raw.commitTxn),
      };
    case 'hello-error':
      return {
        type: 'hello-error',
        code: typeof raw.code === 'string' && raw.code ? raw.code : 'E_WS_REJECTED',
        message: typeof raw.message === 'string' && raw.message ? raw.message : 'daemon 拒绝连接',
      };
    case 'ping':
      return { type: 'ping' };
    case 'pong':
      return { type: 'pong' };
    case 'event': {
      const event = stringOrNull(raw.event);
      if (!event) return null;
      return { type: 'event', event, params: normalizeParams(raw.params) };
    }
    case 'cmd': {
      const id = normalizeId(raw.id);
      const method = stringOrNull(raw.method);
      if (!id || !method) return null;
      const timeoutMs = Number(raw.timeoutMs);
      return {
        type: 'cmd',
        id,
        method,
        params: normalizeParams(raw.params),
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : null,
      };
    }
    case 'call-res': {
      const id = normalizeId(raw.id);
      if (!id || typeof raw.ok !== 'boolean') return null;
      const error = normalizeErrorPayload(raw.error);
      return {
        type: 'call-res',
        id,
        ok: raw.ok,
        result: raw.result,
        ...(error ? { error } : {}),
      };
    }
    case 'auth-challenge': {
      const challenge = stringOrNull(raw.challenge);
      if (!challenge) return null;
      return { type: 'auth-challenge', challenge, alg: stringOrNull(raw.alg) };
    }
    case 'commit-ack':
      return { type: 'commit-ack', txn: stringOrNull(raw.txn), code: null, message: null };
    case 'commit-error':
      return {
        type: 'commit-error',
        txn: stringOrNull(raw.txn),
        code: stringOrNull(raw.code),
        message: stringOrNull(raw.message),
      };
    default:
      return null;
  }
}

/** 文本帧 → 帧对象；非 JSON/非文本返回 null。 */
export function parseDaemonFrameText(data: unknown): DaemonFrame | null {
  if (typeof data !== 'string' || !data) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  return parseDaemonFrame(raw);
}

// ---------------------------------------------------------------------------
// 配置与快照
// ---------------------------------------------------------------------------

export interface DaemonReconnectPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  /** 0–1：每轮延迟上下浮动 ±jitter。 */
  jitter: number;
  /** 0 = 不限次数。 */
  maxAttempts: number;
}

export interface DaemonSocketOptions {
  port?: number;
  host?: string;
  secure?: boolean;
  /** 完整 ws(s) 地址（远程配对场景）；给了就不再按 host/port 拼。 */
  url?: string;
  extVersion?: string;
  browser?: string;
  browserVersion?: string;
  userAgent?: string;
  label?: string;
  /** 重连时提示 daemon 复用实例（daemon 以自己生成的为准）。 */
  instanceId?: string;
  capabilities?: readonly string[];
  /** 追加到 hello 首帧的字段（例如将来的 pairToken/browserId）。 */
  hello?: Readonly<Record<string, unknown>>;
  webSocketFactory?: WebSocketFactory;
  clock?: DaemonSocketClock;
  random?: () => number;
  handshakeTimeoutMs?: number;
  /** 心跳看门狗检查间隔。 */
  heartbeatIntervalMs?: number;
  /** 超过该时长没有任何帧 → 判定半开连接并重连。 */
  heartbeatTimeoutMs?: number;
  callTimeoutMs?: number;
  reconnect?: Partial<DaemonReconnectPolicy>;
}

export interface DaemonSocketSnapshot {
  state: DaemonSocketState;
  stateReason: string | null;
  url: string;
  extVersion: string;
  instanceId: string | null;
  daemonVersion: string | null;
  daemonProtocol: string | null;
  capabilities: readonly string[];
  connectedAt: number | null;
  lastFrameAt: number | null;
  reconnectAttempts: number;
  pendingCalls: number;
  pingsReceived: number;
  lastError: DaemonErrorPayload | null;
  lastClose: { code: number | null; reason: string | null } | null;
}

interface PendingCall {
  id: string;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: unknown;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
}

interface ConnectionWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: unknown;
}

const DEFAULT_RECONNECT: DaemonReconnectPolicy = Object.freeze({
  initialDelayMs: 500,
  maxDelayMs: 15_000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: 0,
});

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 4_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;

function normalizePositive(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

/**
 * daemon WebSocket 客户端。
 *
 * 生命周期：start() → connecting → handshaking → connected；断线自动 reconnecting，
 * stop() 后进入 closed，hello-error/认证要求进入 rejected（不再自动重连，等人工处理）。
 */
export class DaemonSocket implements DaemonRpcTransport {
  readonly url: string;
  readonly extVersion: string;
  readonly browser: string;
  readonly browserVersion: string;
  readonly userAgent: string;
  readonly label: string;
  readonly capabilities: readonly string[];

  private readonly host: string | undefined;
  private readonly secure: boolean;
  private readonly requestedUrl: string | null;
  private readonly factory: WebSocketFactory;
  private readonly clock: DaemonSocketClock;
  private readonly random: () => number;
  private readonly handshakeTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly reconnectPolicy: DaemonReconnectPolicy;
  private readonly helloExtras: Readonly<Record<string, unknown>>;
  private lastInstanceId: string | null;

  private stateValue: DaemonSocketState = 'idle';
  private lastStateReason: string | null = null;
  private started = false;
  private stopped = false;
  private socket: WebSocketLike | null = null;
  private helloAck: DaemonHelloAck | null = null;
  private reconnectAttemptsCount = 0;
  private callSeq = 0;
  private pingsReceived = 0;
  private commitAcks = 0;
  private commitErrors = 0;
  private connectedAtMs: number | null = null;
  private lastFrameAtMs: number | null = null;
  private lastErrorValue: DaemonRpcError | null = null;
  private lastCloseInfo: { code: number | null; reason: string | null } | null = null;

  private reconnectTimer: unknown = null;
  private handshakeTimer: unknown = null;
  private heartbeatTimer: unknown = null;

  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly daemonEventHandlers = new Map<string, Set<(frame: DaemonEventFrame) => void>>();
  private readonly anyEventHandlers = new Set<(frame: DaemonEventFrame) => void>();
  private readonly stateHandlers = new Set<(snapshot: DaemonSocketSnapshot) => void>();
  private readonly waiters: ConnectionWaiter[] = [];
  private commandHandler: ((frame: DaemonCommandFrame) => void) | null = null;

  constructor(options: DaemonSocketOptions = {}) {
    this.extVersion = options.extVersion ? String(options.extVersion) : '';
    this.browser = options.browser ? String(options.browser) : 'chromium';
    this.browserVersion = options.browserVersion ? String(options.browserVersion) : '';
    this.userAgent = options.userAgent ? String(options.userAgent) : '';
    this.label = options.label ? String(options.label) : '';
    this.capabilities = Object.freeze([...(options.capabilities ?? EXTENSION_CAPABILITIES)]);
    this.host = options.host;
    this.secure = options.secure === true;
    this.requestedUrl = options.url ? String(options.url) : null;
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.clock = options.clock ?? realSocketClock;
    this.random = options.random ?? Math.random;
    this.handshakeTimeoutMs = normalizePositive(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.heartbeatIntervalMs = normalizePositive(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimeoutMs = normalizePositive(options.heartbeatTimeoutMs, DEFAULT_HEARTBEAT_TIMEOUT_MS);
    this.callTimeoutMs = normalizePositive(options.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
    this.helloExtras = Object.freeze({ ...(options.hello ?? {}) });
    this.lastInstanceId = options.instanceId ? String(options.instanceId) : null;
    const reconnect = options.reconnect ?? {};
    this.reconnectPolicy = Object.freeze({
      initialDelayMs: normalizePositive(reconnect.initialDelayMs, DEFAULT_RECONNECT.initialDelayMs),
      maxDelayMs: normalizePositive(reconnect.maxDelayMs, DEFAULT_RECONNECT.maxDelayMs),
      factor: Number.isFinite(Number(reconnect.factor)) && Number(reconnect.factor) >= 1
        ? Number(reconnect.factor)
        : DEFAULT_RECONNECT.factor,
      jitter: Math.min(1, Math.max(0, Number(reconnect.jitter ?? DEFAULT_RECONNECT.jitter) || 0)),
      maxAttempts: Math.max(0, Math.floor(Number(reconnect.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts) || 0)),
    });
    this.url = daemonWsUrl({
      url: this.requestedUrl,
      host: this.host,
      port: options.port,
      secure: this.secure,
      extVersion: this.extVersion || '0.0.0',
    });
  }

  // -------------------------------------------------------------------------
  // 只读状态
  // -------------------------------------------------------------------------

  get state(): DaemonSocketState {
    return this.stateValue;
  }

  get lastError(): DaemonRpcError | null {
    return this.lastErrorValue;
  }

  get instanceId(): string | null {
    return this.helloAck?.instanceId ?? null;
  }

  get daemonVersion(): string | null {
    return this.helloAck?.daemonVersion ?? null;
  }

  get daemonProtocol(): string | null {
    return this.helloAck?.protocol ?? null;
  }

  isConnected(): boolean {
    return this.stateValue === 'connected' && this.socket !== null;
  }

  snapshot(): DaemonSocketSnapshot {
    return {
      state: this.stateValue,
      stateReason: this.lastStateReason,
      url: this.url,
      extVersion: this.extVersion,
      instanceId: this.helloAck?.instanceId ?? null,
      daemonVersion: this.helloAck?.daemonVersion ?? null,
      daemonProtocol: this.helloAck?.protocol ?? null,
      capabilities: this.capabilities,
      connectedAt: this.connectedAtMs,
      lastFrameAt: this.lastFrameAtMs,
      reconnectAttempts: this.reconnectAttemptsCount,
      pendingCalls: this.pendingCalls.size,
      pingsReceived: this.pingsReceived,
      lastError: this.lastErrorValue ? this.lastErrorValue.toPayload() : null,
      lastClose: this.lastCloseInfo,
    };
  }

  /** 握手次数等诊断统计。 */
  stats(): { pingsReceived: number; commitAcks: number; commitErrors: number; reconnectAttempts: number } {
    return {
      pingsReceived: this.pingsReceived,
      commitAcks: this.commitAcks,
      commitErrors: this.commitErrors,
      reconnectAttempts: this.reconnectAttemptsCount,
    };
  }

  // -------------------------------------------------------------------------
  // 订阅
  // -------------------------------------------------------------------------

  /** 订阅具名 daemon 事件；返回取消订阅函数。 */
  onDaemonEvent(event: string, handler: (frame: DaemonEventFrame) => void): () => void {
    const name = String(event || '');
    if (!name) throw new TypeError('onDaemonEvent: 事件名不能为空');
    let bucket = this.daemonEventHandlers.get(name);
    if (!bucket) {
      bucket = new Set();
      this.daemonEventHandlers.set(name, bucket);
    }
    bucket.add(handler);
    return () => {
      const current = this.daemonEventHandlers.get(name);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.daemonEventHandlers.delete(name);
    };
  }

  /** 订阅所有 daemon 事件（事件总线/审计用）。 */
  onAnyDaemonEvent(handler: (frame: DaemonEventFrame) => void): () => void {
    this.anyEventHandlers.add(handler);
    return () => this.anyEventHandlers.delete(handler);
  }

  /** 订阅连接状态变化；立即回调一次当前快照，便于 UI 首帧有一致状态。 */
  onStateChange(handler: (snapshot: DaemonSocketSnapshot) => void): () => void {
    this.stateHandlers.add(handler);
    handler(this.snapshot());
    return () => this.stateHandlers.delete(handler);
  }

  /** 注入 cmd 处理器（本批只分发，不实现页面动作）。 */
  setCommandHandler(handler: ((frame: DaemonCommandFrame) => void) | null): void {
    this.commandHandler = handler;
  }

  // -------------------------------------------------------------------------
  // 连接生命周期
  // -------------------------------------------------------------------------

  /** 开始连接；已连接/正在连接时幂等。 */
  start(): void {
    if (!this.stopped && this.started) return;
    this.stopped = false;
    this.started = true;
    this.reconnectAttemptsCount = 0;
    this.open();
  }

  /** 主动断开：不再重连，未完成调用与等待者以 E_SOCKET_CLOSED 拒绝。 */
  stop(code = 1000, reason = 'client stop'): void {
    this.started = false;
    this.stopped = true;
    this.reconnectTimer = this.clearTimer(this.reconnectTimer);
    this.handshakeTimer = this.clearTimer(this.handshakeTimer);
    this.heartbeatTimer = this.clearTimer(this.heartbeatTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(code, reason);
      } catch {
        // 关闭竞态/已关闭都可以忽略
      }
    }
    this.helloAck = null;
    this.connectedAtMs = null;
    const closedError = transportError('E_SOCKET_CLOSED', 'daemon 连接已停止', { retryable: true });
    this.failPending(closedError);
    this.rejectWaiters(closedError);
    this.setState('closed', 'client stop');
  }

  /** 立即重连（跳过当前退避等待）。 */
  connectNow(): void {
    const socket = this.socket;
    this.socket = null;
    this.started = false;
    this.stopped = true;
    this.reconnectTimer = this.clearTimer(this.reconnectTimer);
    this.handshakeTimer = this.clearTimer(this.handshakeTimer);
    this.heartbeatTimer = this.clearTimer(this.heartbeatTimer);
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, 'manual reconnect');
      } catch {
        // 忽略
      }
    }
    const closedError = transportError('E_SOCKET_CLOSED', 'daemon 连接被手动重建', { retryable: true });
    this.failPending(closedError);
    this.rejectWaiters(closedError);
    this.helloAck = null;
    this.connectedAtMs = null;
    this.lastFrameAtMs = null;
    this.start();
  }

  /** 等待连接可用；已连接立即 resolve，超时/拒绝则 reject。 */
  ensureConnected(timeoutMs = 5_000): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: ConnectionWaiter = { resolve, reject, timer: null };
      waiter.timer = this.clock.setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(transportError('E_TIMEOUT', `等待 daemon WS 连接超时（${timeoutMs}ms）`));
      }, normalizePositive(timeoutMs, 5_000));
      this.waiters.push(waiter);
      this.start();
    });
  }

  // -------------------------------------------------------------------------
  // 调用与回包
  // -------------------------------------------------------------------------

  /**
   * 扩展发起的只读调用（daemon 端只放行 WS_CALL_METHODS）。
   * @throws DaemonRpcError E_NO_DAEMON（未连接）/E_TIMEOUT/E_CANCELLED/daemon 业务错误
   */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: DaemonCallOptions = {},
  ): Promise<T> {
    const name = typeof method === 'string' ? method.trim() : '';
    if (!name) {
      return Promise.reject(daemonError('E_CLIENT_BAD_METHOD', '方法名必须是非空字符串', { category: 'client' }));
    }
    if (!this.isConnected()) {
      return Promise.reject(
        transportError('E_NO_DAEMON', `daemon WS 未连接（state=${this.stateValue}），无法调用 ${name}`, {
          retryable: true,
        }),
      );
    }
    const payload = params === undefined || params === null ? {} : params;
    if (!isRecord(payload)) {
      return Promise.reject(daemonError('E_CLIENT_BAD_REQUEST', 'params 必须是对象', { category: 'client' }));
    }
    const id = `ws-${++this.callSeq}`;
    const timeoutMs = normalizePositive(options.timeoutMs, this.callTimeoutMs);

    return new Promise<T>((resolve, reject) => {
      const entry: PendingCall = {
        id,
        method: name,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: null,
        signal: options.signal ?? null,
        onAbort: null,
      };
      const settle = (error: unknown, value?: unknown): void => {
        this.finishPending(entry);
        if (error) reject(error);
        else resolve(value as T);
      };
      entry.timer = this.clock.setTimeout(() => {
        settle(transportError('E_TIMEOUT', `WS 调用 ${name} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      if (options.signal) {
        if (options.signal.aborted) {
          settle(transportError('E_CANCELLED', 'WS 调用已取消'));
          return;
        }
        entry.onAbort = () => settle(transportError('E_CANCELLED', 'WS 调用已取消'));
        options.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pendingCalls.set(id, entry);
      const sent = this.sendJson({ type: 'call', id, method: name, params: payload });
      if (!sent) {
        settle(transportError('E_NO_DAEMON', `WS 发送失败：${name}`, { retryable: true }));
      }
    });
  }

  /** 回包：成功。 */
  sendCommandResult(id: string, result: unknown): boolean {
    return this.sendJson({ type: 'res', id, ok: true, result });
  }

  /** 回包：失败（结构化 code/data 原样回给 daemon）。 */
  sendCommandError(id: string, error: DaemonErrorPayload): boolean {
    if (!error || typeof error.code !== 'string' || !error.code) {
      return this.sendJson({ type: 'res', id, ok: false, error: { code: 'E_INTERNAL', message: '未提供错误码' } });
    }
    return this.sendJson({ type: 'res', id, ok: false, error });
  }

  /** 主动上报事件（tab-removed/help-resolved…）。 */
  sendEvent(event: string, params: Record<string, unknown> = {}): boolean {
    const name = typeof event === 'string' ? event.trim() : '';
    if (!name) return false;
    return this.sendJson({ type: 'event', event: name, params });
  }

  /** 发送任意 JSON 帧；未连接或序列化失败返回 false。 */
  sendJson(payload: unknown): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || !this.isConnected()) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 内部：打开连接与帧处理
  // -------------------------------------------------------------------------

  private open(): void {
    if (!this.started || this.stopped || this.socket) return;
    this.setState('connecting');
    let socket: WebSocketLike;
    try {
      socket = this.factory(this.url);
    } catch (error) {
      this.dropConnection(
        transportError('E_NO_DAEMON', `创建 WebSocket 失败：${error instanceof Error ? error.message : String(error)}`, {
          reason: error,
        }),
        true,
      );
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.onOpen(socket);
    socket.onmessage = (event) => this.onMessage(socket, event);
    socket.onclose = (event) => this.onClose(socket, event);
    socket.onerror = (event) => this.onSocketError(socket, event);
  }

  private onOpen(socket: WebSocketLike): void {
    if (socket !== this.socket) return;
    this.setState('handshaking');
    this.handshakeTimer = this.clock.setTimeout(() => {
      if (socket !== this.socket) return;
      this.dropConnection(
        transportError('E_HANDSHAKE_TIMEOUT', `daemon 未在 ${this.handshakeTimeoutMs}ms 内回 hello-ack`, {
          retryable: true,
        }),
        true,
      );
    }, this.handshakeTimeoutMs);
    if (!this.sendHello()) {
      this.dropConnection(transportError('E_NO_DAEMON', '发送 hello 失败'), true);
    }
  }

  private sendHello(): boolean {
    const hello: Record<string, unknown> = {
      type: 'hello',
      role: 'extension',
      protocol: EXTENSION_PROTOCOL_VERSION,
      extVersion: this.extVersion,
      browser: this.browser,
      browserVersion: this.browserVersion,
      userAgent: this.userAgent,
      capabilities: [...this.capabilities],
      ...this.helloExtras,
    };
    if (this.label) hello.label = this.label;
    if (this.lastInstanceId) hello.instanceId = this.lastInstanceId;
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(hello));
      return true;
    } catch {
      return false;
    }
  }

  private onMessage(socket: WebSocketLike, event: { data: unknown }): void {
    if (socket !== this.socket) return;
    const frame = parseDaemonFrameText(event?.data);
    if (!frame) return;
    this.lastFrameAtMs = this.clock.now();
    switch (frame.type) {
      case 'hello-ack':
        this.onHelloAck(frame);
        return;
      case 'hello-error':
        this.onHelloError(frame);
        return;
      case 'auth-challenge':
        this.onAuthChallenge(frame);
        return;
      case 'ping':
        this.pingsReceived += 1;
        this.sendJson({ type: 'pong' });
        return;
      case 'pong':
        return;
      case 'call-res':
        this.settleCall(frame);
        return;
      case 'event':
        this.dispatchDaemonEvent(frame);
        return;
      case 'cmd':
        this.handleCommand(frame);
        return;
      case 'commit-ack':
        this.commitAcks += 1;
        return;
      case 'commit-error':
        this.commitErrors += 1;
        this.lastErrorValue = daemonError(
          'E_AUTH_FAILED',
          frame.message || '配对 commit 失败',
          { category: 'auth', ...(frame.code ? { retryable: false } : {}) },
        );
        return;
      default:
        return;
    }
  }

  private onHelloAck(frame: DaemonHelloAck): void {
    this.handshakeTimer = this.clearTimer(this.handshakeTimer);
    this.helloAck = frame;
    if (frame.instanceId) this.lastInstanceId = frame.instanceId;
    this.reconnectAttemptsCount = 0;
    this.connectedAtMs = this.clock.now();
    this.lastFrameAtMs = this.connectedAtMs;
    this.lastErrorValue = null;
    this.setState('connected');
    this.startHeartbeat();
    const waiters = [...this.waiters];
    this.waiters.length = 0;
    for (const waiter of waiters) {
      this.clock.clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private onHelloError(frame: DaemonHelloErrorFrame): void {
    const error = daemonError(frame.code, frame.message, { category: 'auth', retryable: false });
    this.rejectConnection(error);
  }

  private onAuthChallenge(frame: DaemonAuthChallengeFrame): void {
    // 本批不实现配对 HMAC（见报告 D）：明确拒绝而不是静默挂起。
    const error = daemonError(
      'E_WS_REJECTED',
      `daemon 要求认证握手（challenge=${frame.challenge.slice(0, 8)}…），TS 运行时尚未实现配对证明`,
      { category: 'auth', retryable: false },
    );
    this.rejectConnection(error);
  }

  /** 握手被 daemon 拒绝：不自动重连，等人处理（重新配对/升级）。 */
  private rejectConnection(error: DaemonRpcError): void {
    this.started = false;
    this.stopped = true;
    this.handshakeTimer = this.clearTimer(this.handshakeTimer);
    this.heartbeatTimer = this.clearTimer(this.heartbeatTimer);
    this.reconnectTimer = this.clearTimer(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(4003, error.code);
      } catch {
        // 忽略
      }
    }
    this.helloAck = null;
    this.connectedAtMs = null;
    this.lastErrorValue = error;
    this.failPending(error);
    this.rejectWaiters(error);
    this.setState('rejected', error.code);
  }

  private onSocketError(socket: WebSocketLike, event: unknown): void {
    if (socket !== this.socket) return;
    const message = isRecord(event) && typeof event.message === 'string' ? event.message : 'WebSocket 错误';
    if (this.stateValue === 'connected') {
      // 连接期错误通常紧跟 close；这里只记录，避免重复调度重连。
      this.lastErrorValue = transportError('E_SOCKET_CLOSED', message, { reason: event });
      return;
    }
    this.dropConnection(transportError('E_SOCKET_CLOSED', message, { reason: event }), true);
  }

  private onClose(socket: WebSocketLike, event: { code?: number; reason?: string }): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.lastCloseInfo = {
      code: typeof event?.code === 'number' ? event.code : null,
      reason: typeof event?.reason === 'string' ? event.reason : null,
    };
    this.handshakeTimer = this.clearTimer(this.handshakeTimer);
    this.heartbeatTimer = this.clearTimer(this.heartbeatTimer);
    const error = transportError(
      'E_SOCKET_CLOSED',
      `daemon 连接已断开（code=${this.lastCloseInfo.code ?? '?'}${this.lastCloseInfo.reason ? ', ' + this.lastCloseInfo.reason : ''}）`,
      { retryable: true },
    );
    this.helloAck = null;
    this.connectedAtMs = null;
    this.failPending(error);
    this.rejectWaiters(error);
    if (!this.started || this.stopped) {
      this.setState(this.stateValue === 'rejected' ? 'rejected' : 'closed', error.code);
      return;
    }
    this.lastErrorValue = error;
    this.scheduleReconnect(error);
  }

  private dropConnection(error: DaemonRpcError, allowReconnect: boolean): void {
    this.handshakeTimer = this.clearTimer(this.handshakeTimer);
    this.heartbeatTimer = this.clearTimer(this.heartbeatTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, error.code);
      } catch {
        // 忽略
      }
    }
    this.helloAck = null;
    this.connectedAtMs = null;
    this.lastErrorValue = error;
    this.failPending(error);
    this.rejectWaiters(error);
    if (!this.started || this.stopped || !allowReconnect) {
      this.setState(this.stateValue === 'rejected' ? 'rejected' : 'closed', error.code);
      return;
    }
    this.scheduleReconnect(error);
  }

  private scheduleReconnect(cause: DaemonRpcError | null): void {
    if (!this.started || this.stopped) return;
    if (this.reconnectTimer !== null) return;
    this.reconnectAttemptsCount += 1;
    if (this.reconnectPolicy.maxAttempts > 0 && this.reconnectAttemptsCount > this.reconnectPolicy.maxAttempts) {
      this.setState('closed', 'max-reconnect-attempts');
      return;
    }
    const delay = this.reconnectDelay(this.reconnectAttemptsCount);
    this.setState('reconnecting', cause?.code ?? 'reconnecting');
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.started || this.stopped) return;
      this.open();
    }, delay);
  }

  private reconnectDelay(attempt: number): number {
    const exponential = this.reconnectPolicy.initialDelayMs * this.reconnectPolicy.factor ** (attempt - 1);
    const capped = Math.min(this.reconnectPolicy.maxDelayMs, exponential);
    const spread = 1 + this.reconnectPolicy.jitter * (this.random() * 2 - 1);
    return Math.max(1, Math.round(capped * spread));
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = this.clearTimer(this.heartbeatTimer);
    const tick = (): void => {
      this.heartbeatTimer = null;
      if (this.stateValue !== 'connected') return;
      const now = this.clock.now();
      const last = this.lastFrameAtMs ?? now;
      const silentMs = now - last;
      if (silentMs >= this.heartbeatTimeoutMs) {
        this.dropConnection(
          transportError('E_HEARTBEAT_TIMEOUT', `daemon ${silentMs}ms 内没有任何帧（心跳看门狗）`, {
            retryable: true,
          }),
          true,
        );
        return;
      }
      this.heartbeatTimer = this.clock.setTimeout(tick, this.heartbeatIntervalMs);
    };
    this.heartbeatTimer = this.clock.setTimeout(tick, this.heartbeatIntervalMs);
  }

  private settleCall(frame: DaemonCallResultFrame): void {
    const entry = this.pendingCalls.get(frame.id);
    if (!entry) return; // daemon 丢弃迟到回包；这里同样忽略未知 id
    this.finishPending(entry);
    if (frame.ok) {
      entry.resolve(frame.result);
      return;
    }
    const payload = frame.error ?? { code: 'E_INTERNAL', message: `daemon 返回失败：${entry.method}` };
    entry.reject(mapDaemonError(payload));
  }

  private finishPending(entry: PendingCall): void {
    this.pendingCalls.delete(entry.id);
    if (entry.timer !== null && entry.timer !== undefined) {
      this.clock.clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      entry.onAbort = null;
    }
  }

  private failPending(error: DaemonRpcError): void {
    const entries = [...this.pendingCalls.values()];
    for (const entry of entries) {
      this.finishPending(entry);
      entry.reject(error);
    }
  }

  private rejectWaiters(error: unknown): void {
    const waiters = [...this.waiters];
    this.waiters.length = 0;
    for (const waiter of waiters) {
      this.clock.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private dispatchDaemonEvent(frame: DaemonEventFrame): void {
    const named = this.daemonEventHandlers.get(frame.event);
    if (named) {
      for (const handler of [...named]) {
        try {
          handler(frame);
        } catch {
          // 单个订阅者异常不影响其它订阅者/连接
        }
      }
    }
    for (const handler of [...this.anyEventHandlers]) {
      try {
        handler(frame);
      } catch {
        // 同上
      }
    }
  }

  private handleCommand(frame: DaemonCommandFrame): void {
    const handler = this.commandHandler;
    if (!handler) {
      // 没有处理器时立即回 E_UNKNOWN_METHOD，避免 daemon 等到超时。
      this.sendCommandError(frame.id, {
        code: 'E_UNKNOWN_METHOD',
        message: `扩展尚未注册命令处理器：${frame.method}`,
      });
      return;
    }
    try {
      handler(frame);
    } catch (error) {
      this.sendCommandError(frame.id, {
        code: 'E_INTERNAL',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private setState(next: DaemonSocketState, reason?: string): void {
    if (this.stateValue === next) return;
    this.stateValue = next;
    this.lastStateReason = reason ?? null;
    const snapshot = this.snapshot();
    for (const handler of [...this.stateHandlers]) {
      try {
        handler(snapshot);
      } catch {
        // 订阅者异常不影响连接状态机
      }
    }
  }

  private clearTimer(handle: unknown): null {
    if (handle !== null && handle !== undefined) this.clock.clearTimeout(handle);
    return null;
  }
}
