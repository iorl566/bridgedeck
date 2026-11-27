// src/daemon/connector.ts —— 多端口连接编排：按候选端口顺序建立 WS，选第一个可用的。
//
// 为什么需要它：DaemonSocket 只负责“给定端口/URL 的连接生命周期与重连”，不负责
// “daemon 到底在哪个端口”。0.3.0 JS 扩展是 connectLoop 里顺序试 10 个端口；TS 侧把
// 这段编排独立成 DaemonConnector，便于：
// - 单测注入假 socket 工厂，精确断言“先试哪个端口、失败后换谁、全部失败怎么报错”；
// - background 只关心 ensure()/current()/stop()，不需要知道发现策略；
// - 将来的配对/远程 daemonUrl 只需扩展候选来源，不改连接状态机。
//
// 并发：ensure() 用单个 in-flight Promise 合并（多个 bb.rpc 同时到达只发起一轮探测）。
// 失败：抛 DaemonRpcError(E_NO_DAEMON)，data 带 attempts 明细，便于诊断页展示。

import { daemonError } from './errors.ts';

/** 连接编排只需要 DaemonSocket 的一个子集（假 socket 也能满足）。 */
export interface ConnectableSocket {
  readonly url: string;
  readonly state: string;
  start(): void;
  stop(code?: number, reason?: string): void;
  ensureConnected(timeoutMs?: number): Promise<void>;
  isConnected(): boolean;
}

export type SocketFactory = (port: number) => ConnectableSocket;

/** 候选端口来源：函数（设置/存储读取）或直接给数组（测试/固定部署）。 */
export type CandidatePortsProvider =
  | readonly number[]
  | Promise<readonly number[]>
  | (() => Promise<readonly number[]> | readonly number[]);

export interface ConnectorAttempt {
  port: number;
  ok: boolean;
  reason: string;
  at: number;
}

export interface DaemonConnectorOptions {
  socketFactory: SocketFactory;
  candidatePorts: CandidatePortsProvider;  /** 单端口握手等待；默认 2500ms（与 JS 扩展 CONNECT_TIMEOUT_MS 对齐）。 */
  connectTimeoutMs?: number;
  now?: () => number;
  /** 连接成功后的接线（挂事件/命令处理器等）。 */
  onConnected?: (socket: ConnectableSocket, port: number) => void;
  /** 端口失败回调（日志/诊断）。 */
  onAttempt?: (attempt: ConnectorAttempt) => void;
}

export interface ConnectorSnapshot {
  connected: boolean;
  port: number | null;
  url: string;
  attempts: ConnectorAttempt[];
  lastError: string | null;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2_500;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const bag = error as { message?: unknown } | null;
  if (bag && typeof bag.message === 'string') return bag.message;
  return String(error);
}

/**
 * 多端口连接器。
 *
 * ```ts
 * const connector = new DaemonConnector({
 *   socketFactory: (port) => createSocket(port),
 *   candidatePorts: async () => resolvePortCandidates({ settingsPort }),
 * });
 * const socket = await connector.ensure();
 * ```
 */
export class DaemonConnector {
  private readonly factory: SocketFactory;
  private readonly provider: CandidatePortsProvider;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;
  private readonly onConnected: ((socket: ConnectableSocket, port: number) => void) | null;
  private readonly onAttempt: ((attempt: ConnectorAttempt) => void) | null;

  private socket: ConnectableSocket | null = null;
  private port: number | null = null;
  private inFlight: Promise<ConnectableSocket> | null = null;
  private lastError: string | null = null;
  private readonly attemptLog: ConnectorAttempt[] = [];

  constructor(options: DaemonConnectorOptions) {
    if (!options || typeof options.socketFactory !== 'function') {
      throw new TypeError('DaemonConnector 需要 socketFactory');
    }
    if (options.candidatePorts === undefined || options.candidatePorts === null) {
      throw new TypeError('DaemonConnector 需要 candidatePorts');
    }
    this.factory = options.socketFactory;
    this.provider = options.candidatePorts;
    this.connectTimeoutMs = Number(options.connectTimeoutMs) > 0
      ? Math.floor(Number(options.connectTimeoutMs))
      : DEFAULT_CONNECT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.onConnected = options.onConnected ?? null;
    this.onAttempt = options.onAttempt ?? null;
  }

  /** 当前连接（可能为 null 或已断开）。 */
  current(): ConnectableSocket | null {
    return this.socket;
  }

  /** 当前连接端口（未连接时 null）。 */
  currentPort(): number | null {
    return this.socket && this.socket.isConnected() ? this.port : null;
  }

  isConnected(): boolean {
    return Boolean(this.socket && this.socket.isConnected());
  }

  /** 已尝试的端口记录（最近的在最后；环形保留 32 条）。 */
  attempts(): ConnectorAttempt[] {
    return [...this.attemptLog];
  }

  snapshot(): ConnectorSnapshot {
    return {
      connected: this.isConnected(),
      port: this.currentPort(),
      url: this.socket?.url ?? '',
      attempts: this.attempts(),
      lastError: this.lastError,
    };
  }

  /**
   * 确保有一条可用连接：已连接直接返回；否则按候选顺序探测，全部失败抛
   * `E_NO_DAEMON`（data.attempts 带每个端口的原因）。
   */
  ensure(): Promise<ConnectableSocket> {
    if (this.socket && this.socket.isConnected()) return Promise.resolve(this.socket);
    if (this.inFlight) return this.inFlight;
    const running = this.connectCandidates().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  /** 主动断开并清空状态（例如设置切换了端口）。 */
  stop(code = 1000, reason = 'client stop'): void {
    const socket = this.socket;
    this.socket = null;
    this.port = null;
    if (socket) {
      try {
        socket.stop(code, reason);
      } catch {
        // 已关闭/已停止都忽略
      }
    }
  }

  /** 重建连接（跳过当前 socket，重新按候选探测）。 */
  reconnect(): Promise<ConnectableSocket> {
    this.stop(1000, 'manual reconnect');
    this.lastError = null;
    return this.ensure();
  }

  private async connectCandidates(): Promise<ConnectableSocket> {
    // 先试当前 socket 的恢复（DaemonSocket 自己有退避重连，给它一次机会）。
    const existing = this.socket;
    if (existing) {
      try {
        existing.start();
        await existing.ensureConnected(this.connectTimeoutMs);
        if (existing.isConnected()) {
          this.lastError = null;
          return existing;
        }
      } catch (error) {
        this.record(this.port ?? -1, 'reconnect-current', false, messageOf(error));
        this.stop(1000, 'reconnect fallback');
      }
    }

    let ports: number[] = [];
    try {
      ports = [...await resolveProvider(this.provider)];
    } catch (error) {
      // 候选来源不可读（设置/存储故障）：直接给结构化错误，不假装“没有端口”。
      this.lastError = '读取候选端口失败：' + messageOf(error);
      throw daemonError('E_NO_DAEMON', this.lastError, {
        category: 'transport',
        retryable: true,
        data: { attempts: this.attempts(), candidatePorts: [] },
      });
    }

    for (const port of ports) {
      const candidate = this.factory(port);
      try {
        candidate.start();
        await candidate.ensureConnected(this.connectTimeoutMs);
        if (!candidate.isConnected()) throw new Error('连接未进入 connected 状态');
        this.socket = candidate;
        this.port = port;
        this.lastError = null;
        this.record(port, 'connected', true, '');
        this.onConnected?.(candidate, port);
        return candidate;
      } catch (error) {
        const reason = messageOf(error);
        this.record(port, 'connect-failed', false, reason);
        try {
          candidate.stop(1000, 'connect failed');
        } catch {
          // 忽略
        }
      }
    }

    this.lastError = this.attemptLog.length > 0
      ? '按候选端口连不上 daemon（最后错误：' + this.attemptLog[this.attemptLog.length - 1]?.reason + '）'
      : '没有可用的 daemon 端口候选';
    throw daemonError('E_NO_DAEMON', this.lastError, {
      category: 'transport',
      retryable: true,
      data: { attempts: this.attempts(), candidatePorts: ports },
    });
  }

  private record(port: number, phase: string, ok: boolean, reason: string): void {
    const attempt: ConnectorAttempt = { port, ok, reason: ok ? phase : (phase + ': ' + reason), at: this.now() };
    this.attemptLog.push(attempt);
    if (this.attemptLog.length > 32) this.attemptLog.shift();
    this.onAttempt?.(attempt);
  }
}

/** 便捷工厂。 */
export function createDaemonConnector(options: DaemonConnectorOptions): DaemonConnector {
  return new DaemonConnector(options);
}

/** 候选来源归一：数组/数组 Promise/函数都支持。 */
async function resolveProvider(provider: CandidatePortsProvider): Promise<readonly number[]> {
  const value = typeof provider === 'function' ? await provider() : await provider;
  return Array.isArray(value) ? value : [];
}
