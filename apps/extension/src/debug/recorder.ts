// src/debug/recorder.ts —— CDP 调试采集器（M-C 第六批 wave 2）：Network/Runtime/Page/Performance 域。
//
// 解决什么：第四批的 DebugService 只能用 PerformanceResourceTiming + 页面 console 钩子，
// 拿不到 HTTP 方法/头/正文、WebSocket 帧、真实 console 栈与 trace 级别的性能指标。
// 本模块用 CDP（复用 `CdpChannel`：attach/超时/重挂/子 session 都在 src/cdp/**）补齐：
//   Network.requestWillBeSent / responseReceived / dataReceived / loadingFinished / loadingFailed
//   Network.webSocketCreated / FrameSent / FrameReceived / Closed / FrameError
//   Runtime.consoleAPICalled / exceptionThrown
//   Page.frameNavigated / Page.getFrameTree（页面上下文）
//   Network.getResponseBody / getRequestPostData（bodies）
//   Runtime.evaluate + PerformanceObserver(buffered)（perf 指标：TTFB/load/paints/LCP/CLS/长任务）
//
// 与「MAIN-world 钩子近似」的关系：bodies/头/WebSocket 是双源里 CDP 独有的部分；
// 页面 console 钩子仍是降级路径（没有 debugger 权限时），两条路径不混用（session.mode 标注）。

import type { CdpChannel } from './cdp-channel.ts';
import { base64DecodeUtf8, finiteNumber } from './cdp-channel.ts';

export interface DebugCdpRecorderOptions {
  client: CdpChannel;
  now?: () => number;
  /** 资源条目 → commandId 的时间窗归因（没有 x-bridge-command 头时的近似）。 */
  commandResolver?: ((startedAt: number) => string | null) | null;
  maxEntries?: number;
  maxConsole?: number;
  maxWsFrames?: number;
  /** 单条命令超时（默认沿用 CdpClient）。 */
  timeoutMs?: number;
}

export interface DebugCdpRequest {
  id: number;
  requestId: string;
  method: string;
  url: string;
  status: number | null;
  statusText: string;
  type: string;
  resourceType: string;
  mime: string;
  protocol: string | null;
  startedAt: number;
  responseAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  requestBytes: number;
  responseBytes: number;
  transferSize: number;
  finished: boolean;
  error: string | null;
  fromCache: boolean;
  pageUrl: string;
  frameId: string | null;
  commandId: string | null;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  postData: string | null;
  serverIPAddress: string | null;
  webSocketId: number | null;
}

export interface DebugCdpConsoleEntry {
  id: number;
  level: string;
  text: string;
  at: number;
  type: string;
}

export interface DebugCdpWsFrame {
  direction: 'sent' | 'received' | 'error';
  opcode: number | null;
  payload: string;
  at: number;
  error?: string;
}

export interface DebugCdpSocket {
  id: number;
  requestId: string;
  url: string;
  createdAt: number;
  closed: boolean;
  error: string | null;
  frames: DebugCdpWsFrame[];
}

export interface DebugCdpJournalEvent {
  at: number;
  type: string;
  id?: string;
  name?: string;
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface DebugCdpPageContext {
  url: string;
  title: string;
  frameId: string | null;
  frames: number;
}

interface DebugCdpState {
  tabId: number;
  name: string;
  id: string;
  bodies: boolean;
  startedAt: number;
  live: boolean;
  entries: DebugCdpRequest[];
  byRequestId: Map<string, DebugCdpRequest>;
  consoleEntries: DebugCdpConsoleEntry[];
  sockets: Map<number, DebugCdpSocket>;
  socketByRequestId: Map<string, number>;
  journal: DebugCdpJournalEvent[];
  context: DebugCdpPageContext;
  offs: Array<() => void>;
  seq: number;
  consoleSeq: number;
  socketSeq: number;
}

const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_CONSOLE = 500;
const DEFAULT_MAX_WS_FRAMES = 500;

/** 页面性能采集表达式（Runtime.evaluate）：导航/绘制/资源 + buffered observer 的 LCP/CLS/长任务。 */
const PERF_EXPRESSION = String.raw`(new Promise((resolve) => {
  const out = {
    url: location.href,
    ttfb: null, domContentLoaded: null, load: null,
    paints: [], lcp: null, cls: 0,
    longTasks: { count: 0, maxMs: 0 },
    resources: { count: 0, transferBytes: 0 },
  };
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      out.ttfb = Number.isFinite(nav.responseStart) ? nav.responseStart : null;
      out.domContentLoaded = Number.isFinite(nav.domContentLoadedEventEnd) ? nav.domContentLoadedEventEnd : null;
      out.load = Number.isFinite(nav.loadEventEnd) && nav.loadEventEnd > 0 ? nav.loadEventEnd : null;
    }
    out.paints = performance.getEntriesByType('paint').map((entry) => ({ name: entry.name, startTime: entry.startTime }));
    const resources = performance.getEntriesByType('resource');
    out.resources.count = resources.length;
    out.resources.transferBytes = resources.reduce((sum, entry) => sum + (Number(entry.transferSize) || 0), 0);
  } catch (error) {}
  const observers = [];
  const watch = (type, each) => {
    try {
      const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) each(entry); });
      observer.observe({ type, buffered: true });
      observers.push(observer);
    } catch (error) {}
  };
  watch('largest-contentful-paint', (entry) => { out.lcp = Number.isFinite(entry.startTime) ? entry.startTime : out.lcp; });
  watch('layout-shift', (entry) => { if (entry.hadRecentInput !== true) out.cls = (out.cls || 0) + (Number(entry.value) || 0); });
  watch('longtask', (entry) => {
    out.longTasks.count += 1;
    out.longTasks.maxMs = Math.max(out.longTasks.maxMs, Number(entry.duration) || 0);
  });
  setTimeout(() => {
    for (const observer of observers) { try { observer.disconnect(); } catch (error) {} }
    resolve(out);
  }, 90);
}))()`;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function levelOf(type: unknown): string {
  const raw = String(type ?? 'log');
  if (raw === 'warning') return 'warn';
  if (raw === 'verbose') return 'debug';
  if (raw === 'assert') return 'assert';
  return raw || 'log';
}

function consoleArgText(arg: unknown): string {
  const value = asRecord(arg);
  const type = String(value['type'] ?? '');
  if (type === 'string') return String(value['value'] ?? '');
  if (type === 'number' || type === 'boolean') return String(value['value'] ?? '');
  if (type === 'undefined') return 'undefined';
  if (type === 'bigint') return String(value['unserializableValue'] ?? value['description'] ?? '');
  const description = value['description'];
  if (typeof description === 'string' && description) return description;
  if (value['value'] !== undefined) {
    try {
      return JSON.stringify(value['value']);
    } catch {
      return String(value['value']);
    }
  }
  return type ? '[' + type + ']' : '';
}

function headerRecordOf(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) record[name] = String(raw);
  return record;
}

function headerArrayOf(value: Record<string, string> | null): Array<{ name: string; value: string }> | null {
  if (!value) return null;
  return Object.entries(value).map(([name, headerValue]) => ({ name, value: headerValue }));
}

/**
 * CDP 调试采集器（一个实例管所有 tab 的采集状态）。
 *
 * 只做「采集 + 快照」；RPC 语义、降级与历史记录由 DebugService 负责。
 */
export class DebugCdpRecorder {
  private readonly client: CdpChannel;
  private readonly now: () => number;
  private readonly commandResolver: ((startedAt: number) => string | null) | null;
  private readonly maxEntries: number;
  private readonly maxConsole: number;
  private readonly maxWsFrames: number;
  private readonly timeoutMs: number | undefined;
  private readonly states = new Map<number, DebugCdpState>();
  private readonly journals = new Map<number, DebugCdpJournalEvent[]>();
  private disposed = false;

  constructor(options: DebugCdpRecorderOptions) {
    if (!options || !options.client) throw new TypeError('DebugCdpRecorder 需要 CdpChannel');
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.commandResolver = options.commandResolver ?? null;
    this.maxEntries = this.positive(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxConsole = this.positive(options.maxConsole, DEFAULT_MAX_CONSOLE);
    this.maxWsFrames = this.positive(options.maxWsFrames, DEFAULT_MAX_WS_FRAMES);
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : undefined;
  }

  private positive(value: unknown, fallback: number): number {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
  }

  available(): boolean {
    return !this.disposed;
  }

  isRecording(tabId: number): boolean {
    return this.states.has(Number(tabId));
  }

  recordingTabs(): number[] {
    return [...this.states.keys()];
  }

  /** 该 tab 的 journal 快照（含已停止会话的最后一份，直到下一次 start/cleanup）。 */
  journal(tabId: number): DebugCdpJournalEvent[] {
    return [...(this.journals.get(Number(tabId)) ?? [])];
  }

  private pushJournal(tabId: number, event: DebugCdpJournalEvent): void {
    let list = this.journals.get(tabId);
    if (!list) {
      list = [];
      this.journals.set(tabId, list);
    }
    list.push(event);
    if (list.length > 1_000) list.splice(0, list.length - 1_000);
  }

  /**
   * 开始采集：acquire feature → 事件监听 → 域 enable（Network/Page/Runtime/Performance）。
   * 失败时回滚监听与 feature 租约（不留下半开的采集）。
   */
  async start(tabId: number, options: { bodies?: boolean; name?: string } = {}): Promise<Record<string, unknown>> {
    this.assertUsable();
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('DebugCdpRecorder.start 需要正整数 tabId');
    if (this.states.has(id)) await this.stop(id).catch(() => undefined);
    this.lastSnapshots.delete(id);
    const state: DebugCdpState = {
      tabId: id,
      name: String(options.name ?? ''),
      id: 'cdp_' + String(this.now()) + '_' + String(id),
      bodies: options.bodies === true,
      startedAt: this.now(),
      live: true,
      entries: [],
      byRequestId: new Map(),
      consoleEntries: [],
      sockets: new Map(),
      socketByRequestId: new Map(),
      journal: [],
      context: { url: '', title: '', frameId: null, frames: 0 },
      offs: [],
      seq: 0,
      consoleSeq: 0,
      socketSeq: 0,
    };
    await this.client.acquire(id, 'debug');
    try {
      this.installListeners(state);
      await this.client.send(id, 'Network.enable', {
        maxTotalBufferSize: 10 * 1024 * 1024,
        maxResourceBufferSize: 2 * 1024 * 1024,
      }, this.sendOptions());
      await this.client.send(id, 'Page.enable', {}, this.sendOptions()).catch(() => undefined);
      await this.client.send(id, 'Runtime.enable', {}, this.sendOptions()).catch(() => undefined);
      await this.client.send(id, 'Performance.enable', {}, this.sendOptions()).catch(() => undefined);
      await this.readContext(state).catch(() => undefined);
    } catch (error) {
      for (const off of state.offs) {
        try {
          off();
        } catch {
          // 忽略
        }
      }
      state.offs = [];
      await this.client.send(id, 'Network.disable', {}, this.sendOptions()).catch(() => undefined);
      this.client.release(id, 'debug');
      throw error;
    }
    this.states.set(id, state);
    this.journals.set(id, state.journal);
    this.pushJournal(id, { at: state.startedAt, type: 'start', id: state.id, name: state.name, ok: true });
    return {
      ok: true,
      id: state.id,
      name: state.name,
      tabId: id,
      startedAt: state.startedAt,
      bodies: state.bodies,
      mode: 'cdp-network',
      url: state.context.url,
    };
  }

  /** 结束采集：Network/Performance disable → 退订 → release；保留快照与 journal。 */
  async stop(tabId: number): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    const state = this.states.get(id);
    if (!state) return { ok: true, active: false, requests: 0, console: 0, websockets: 0, durationMs: 0 };
    state.live = false;
    this.states.delete(id);
    this.lastSnapshots.set(id, state);
    for (const off of state.offs) {
      try {
        off();
      } catch {
        // 忽略
      }
    }
    state.offs = [];
    await this.client.send(id, 'Network.disable', {}, this.sendOptions()).catch(() => undefined);
    await this.client.send(id, 'Performance.disable', {}, this.sendOptions()).catch(() => undefined);
    this.client.release(id, 'debug');
    const stoppedAt = this.now();
    this.pushJournal(id, { at: stoppedAt, type: 'stop', id: state.id, name: state.name, ok: true });
    return {
      ok: true,
      active: false,
      id: state.id,
      name: state.name,
      requests: state.entries.length,
      console: state.consoleEntries.length,
      websockets: state.sockets.size,
      durationMs: Math.max(0, stoppedAt - state.startedAt),
      startedAt: state.startedAt,
      stoppedAt,
      mode: 'cdp-network',
    };
  }

  /** 记录一条业务事件（rule/replay 等）到 journal。 */
  record(tabId: number, type: string, payload: Record<string, unknown> = {}): void {
    this.pushJournal(Number(tabId), { at: this.now(), type: String(type || 'event'), ...payload });
  }

  /**
   * 采集状态（live 优先，停止后回落到最后一次快照）。
   * 为什么保留停止后的快照：CLI `debug requests/request/console` 在 stop 之后仍可能读最近一次采集，
   * 与 JS 实现的「读只读面不要求 active」一致；这里不谎报 active，由调用方标注 active:false。
   */
  private snapshotState(tabId: number): DebugCdpState | null {
    const id = Number(tabId);
    return this.states.get(id) ?? this.lastSnapshots.get(id) ?? null;
  }

  /** 是否有可读快照（live 或最近一次已停止的采集）。 */
  hasSnapshot(tabId: number): boolean {
    return this.snapshotState(tabId) !== null;
  }

  /** 当前采集的请求快照（只读拷贝；停止后返回最后一次快照）。 */
  requests(tabId: number): DebugCdpRequest[] {
    const state = this.snapshotState(tabId);
    return state ? state.entries.map((entry) => ({ ...entry })) : [];
  }

  /** 当前采集的 console 快照（停止后返回最后一次快照）。 */
  console(tabId: number): DebugCdpConsoleEntry[] {
    const state = this.snapshotState(tabId);
    return state ? state.consoleEntries.map((entry) => ({ ...entry })) : [];
  }

  /** 页面上下文（URL/标题/frame 数；停止后返回最后一次快照）。 */
  context(tabId: number): DebugCdpPageContext {
    const state = this.snapshotState(tabId);
    return state ? { ...state.context } : { url: '', title: '', frameId: null, frames: 0 };
  }

  /** WebSocket 列表（每个 socket 带最近 N 帧；停止后返回最后一次快照）。 */
  websockets(tabId: number): { total: number; sockets: Array<DebugCdpSocket & { frameCount: number }> } {
    const state = this.snapshotState(tabId);
    if (!state) return { total: 0, sockets: [] };
    const sockets = [...state.sockets.values()].map((socket) => ({
      ...socket,
      frames: socket.frames.slice(-this.maxWsFrames),
      frameCount: socket.frames.length,
    }));
    return { total: sockets.length, sockets };
  }

  /** 单条请求详情（bodies 打开时取响应正文/请求体）。 */
  async requestDetail(tabId: number, rawId: unknown, options: { bodies?: boolean } = {}): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    const state = this.snapshotState(id);
    const requestId = Number(rawId);
    const entry = state?.entries.find((item) => item.id === requestId) ?? null;
    if (!state || !entry) {
      throw Object.assign(new Error('请求不存在：' + String(rawId)), { code: 'E_NOT_FOUND' });
    }
    const wantsBodies = options.bodies === true || state.bodies;
    let responseBody: string | null = null;
    let responseBase64 = false;
    let requestBody: string | null = entry.postData;
    let responseUnavailable: string | null = null;
    let requestUnavailable: string | null = entry.postData === null ? 'not-captured' : null;
    if (wantsBodies && entry.requestId) {
      try {
        const body = await this.client.send<Record<string, unknown>>(id, 'Network.getResponseBody', { requestId: entry.requestId }, this.sendOptions());
        const raw = String(body['body'] ?? '');
        if (body['base64Encoded'] === true) {
          responseBody = base64DecodeUtf8(raw);
          responseBase64 = false;
        } else {
          responseBody = raw;
        }
        responseUnavailable = null;
      } catch (error) {
        responseUnavailable = /not found|No resource/i.test(errorText(error)) ? 'not-available' : 'error';
      }
      if (requestBody === null) {
        try {
          const post = await this.client.send<Record<string, unknown>>(id, 'Network.getRequestPostData', { requestId: entry.requestId }, this.sendOptions());
          requestBody = String(post['postData'] ?? '');
          requestUnavailable = null;
        } catch {
          requestUnavailable = 'none';
        }
      }
    }
    return {
      ok: true,
      entry: { ...entry },
      requestHeaders: headerArrayOf(entry.requestHeaders),
      responseHeaders: headerArrayOf(entry.responseHeaders),
      requestBody,
      responseBody,
      requestBodyUnavailable: requestUnavailable,
      responseBodyUnavailable: responseUnavailable,
      responseBase64,
      timings: {
        queueingMs: 0,
        ttfbMs: entry.responseAt === null ? null : Math.max(0, entry.responseAt - entry.startedAt),
        contentDownloadMs: entry.finishedAt === null || entry.responseAt === null ? null : Math.max(0, entry.finishedAt - entry.responseAt),
        totalMs: entry.durationMs,
      },
      mode: 'cdp-network',
    };
  }

  /** 页面性能指标（PerformanceObserver buffered；不依赖采集是否在进行）。 */
  async performance(tabId: number, options: { feature?: string } = {}): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    const state = this.states.get(id);
    const feature = String(options.feature || 'debug-performance');
    let released = false;
    if (!state) {
      await this.client.acquire(id, feature);
      released = true;
      await this.client.send(id, 'Runtime.enable', {}, this.sendOptions()).catch(() => undefined);
    }
    try {
      const evaluated = await this.client.send<Record<string, unknown>>(id, 'Runtime.evaluate', {
        expression: PERF_EXPRESSION,
        awaitPromise: true,
        returnByValue: true,
      }, this.sendOptions());
      const value = asRecord(asRecord(evaluated)['result']);
      const metrics = asRecord(value['value']);
      const longTasks = asRecord(metrics['longTasks']);
      const resources = asRecord(metrics['resources']);
      const requests = state ? state.entries : [];
      const fallbackCount = requests.filter((entry) => entry.type && entry.type !== 'Document').length;
      return {
        ok: true,
        metrics: {
          url: String(metrics['url'] ?? (state ? state.context.url : '')),
          resources: {
            count: Math.max(finiteNumber(resources['count'], 0), fallbackCount),
            transferBytes: finiteNumber(resources['transferBytes'], requests.reduce((sum, entry) => sum + entry.responseBytes, 0)),
          },
          ttfb: metrics['ttfb'] === null || metrics['ttfb'] === undefined ? null : finiteNumber(metrics['ttfb'], 0),
          domContentLoaded: metrics['domContentLoaded'] === null || metrics['domContentLoaded'] === undefined ? null : finiteNumber(metrics['domContentLoaded'], 0),
          load: metrics['load'] === null || metrics['load'] === undefined ? null : finiteNumber(metrics['load'], 0),
          paints: Array.isArray(metrics['paints']) ? metrics['paints'] : [],
          lcp: metrics['lcp'] === null || metrics['lcp'] === undefined ? null : finiteNumber(metrics['lcp'], 0),
          cls: finiteNumber(metrics['cls'], 0),
          longTasks: {
            count: finiteNumber(longTasks['count'], 0),
            maxMs: finiteNumber(longTasks['maxMs'], 0),
          },
          requests: requests.length,
        },
        mode: 'cdp-performance',
      };
    } catch (error) {
      // 页面正在导航等：给出结构化降级而不是抛错（性能面不该阻塞调用方）。
      return {
        ok: true,
        metrics: {
          url: state ? state.context.url : '',
          resources: { count: state ? state.entries.length : 0, transferBytes: 0 },
          ttfb: null,
          domContentLoaded: null,
          load: null,
          paints: [],
          lcp: null,
          cls: 0,
          longTasks: { count: 0, maxMs: 0 },
          requests: state ? state.entries.length : 0,
        },
        degraded: 'evaluate-failed',
        error: errorText(error),
        mode: 'cdp-performance',
      };
    } finally {
      if (released) this.client.release(id, feature);
    }
  }

  /** tab 关闭/会话回收：停采 + 丢弃 journal。 */
  async forgetTab(tabId: number): Promise<void> {
    const id = Number(tabId);
    await this.stop(id).catch(() => undefined);
    this.journals.delete(id);
  }

  /** 释放全部资源（background 卸载/测试结束）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(this.recordingTabs().map((id) => this.stop(id).catch(() => undefined)));
    this.states.clear();
    this.journals.clear();
  }

  // ------------------------------------------------------------------ 内部

  private readonly lastSnapshots = new Map<number, DebugCdpState>();

  private installListeners(state: DebugCdpState): void {
    const tabId = state.tabId;
    const off = (method: string, handler: (params: Record<string, unknown>, source: { tabId?: number; sessionId?: string }) => void): void => {
      state.offs.push(this.client.onEvent(tabId, method, handler));
    };
    off('Network.requestWillBeSent', (params) => this.onRequestWillBeSent(state, params));
    off('Network.responseReceived', (params) => this.onResponseReceived(state, params));
    off('Network.dataReceived', (params) => this.onDataReceived(state, params));
    off('Network.loadingFinished', (params) => this.onLoadingFinished(state, params));
    off('Network.loadingFailed', (params) => this.onLoadingFailed(state, params));
    off('Network.webSocketCreated', (params) => this.onWebSocketCreated(state, params));
    off('Network.webSocketFrameSent', (params) => this.onWebSocketFrame(state, params, 'sent'));
    off('Network.webSocketFrameReceived', (params) => this.onWebSocketFrame(state, params, 'received'));
    off('Network.webSocketFrameError', (params) => this.onWebSocketFrame(state, params, 'error'));
    off('Network.webSocketClosed', (params) => this.onWebSocketClosed(state, params));
    off('Runtime.consoleAPICalled', (params) => this.onConsoleApiCalled(state, params));
    off('Runtime.exceptionThrown', (params) => this.onExceptionThrown(state, params));
    off('Page.frameNavigated', (params) => this.onFrameNavigated(state, params));
  }

  private onRequestWillBeSent(state: DebugCdpState, params: Record<string, unknown>): void {
    if (params['type'] === 'Preflight') return;
    const request = asRecord(params['request']);
    const url = String(request['url'] ?? '');
    if (!url) return;
    const headers = headerRecordOf(request['headers']);
    const tagged = headers
      ? Object.keys(headers).find((key) => key.toLowerCase() === 'x-bridge-command')
      : undefined;
    const wallTime = Number(params['wallTime']);
    const startedAt = Number.isFinite(wallTime) && wallTime > 0 ? Math.round(wallTime * 1000) : this.now();
    state.seq += 1;
    const entry: DebugCdpRequest = {
      id: state.seq,
      requestId: String(params['requestId'] ?? ''),
      method: String(request['method'] ?? 'GET').toUpperCase(),
      url,
      status: null,
      statusText: '',
      type: String(params['type'] ?? ''),
      resourceType: String(params['type'] ?? ''),
      mime: '',
      protocol: null,
      startedAt,
      responseAt: null,
      finishedAt: null,
      durationMs: null,
      requestBytes: finiteNumber(request['headersSize'], 0),
      responseBytes: 0,
      transferSize: 0,
      finished: false,
      error: null,
      fromCache: false,
      pageUrl: String(params['documentURL'] ?? ''),
      frameId: params['frameId'] === undefined ? null : String(params['frameId']),
      commandId: tagged && headers ? (headers[tagged] || null) : (this.commandResolver ? this.commandResolver(startedAt) : null),
      requestHeaders: headers,
      responseHeaders: null,
      postData: typeof request['postData'] === 'string' ? String(request['postData']) : null,
      serverIPAddress: null,
      webSocketId: null,
    };
    if (entry.pageUrl && (!state.context.url || entry.type === 'Document')) {
      state.context.url = entry.pageUrl;
    }
    state.byRequestId.set(entry.requestId, entry);
    state.entries.push(entry);
    if (state.entries.length > this.maxEntries) {
      const removed = state.entries.splice(0, state.entries.length - this.maxEntries);
      for (const item of removed) state.byRequestId.delete(item.requestId);
    }
  }

  private onResponseReceived(state: DebugCdpState, params: Record<string, unknown>): void {
    const entry = state.byRequestId.get(String(params['requestId'] ?? ''));
    if (!entry) return;
    const response = asRecord(params['response']);
    const status = Number(response['status']);
    entry.status = Number.isFinite(status) && status > 0 ? status : null;
    entry.statusText = String(response['statusText'] ?? '');
    entry.mime = String(response['mimeType'] ?? '');
    entry.protocol = response['protocol'] === undefined ? null : String(response['protocol']);
    entry.responseHeaders = headerRecordOf(response['headers']);
    entry.fromCache = response['fromDiskCache'] === true || response['fromServiceWorker'] === true;
    entry.serverIPAddress = response['remoteIPAddress'] === undefined ? null : String(response['remoteIPAddress']);
    entry.responseBytes = finiteNumber(response['encodedDataLength'], entry.responseBytes);
    entry.transferSize = entry.responseBytes;
    entry.responseAt = this.now();
    const timing = asRecord(response['timing']);
    if (timing['receiveHeadersEnd'] !== undefined) entry.responseAt = entry.startedAt + Math.round(finiteNumber(timing['receiveHeadersEnd'], 0));
  }

  private onDataReceived(state: DebugCdpState, params: Record<string, unknown>): void {
    const entry = state.byRequestId.get(String(params['requestId'] ?? ''));
    if (!entry) return;
    entry.responseBytes += finiteNumber(params['encodedDataLength'], 0);
    entry.transferSize = entry.responseBytes;
  }

  private onLoadingFinished(state: DebugCdpState, params: Record<string, unknown>): void {
    const entry = state.byRequestId.get(String(params['requestId'] ?? ''));
    if (!entry) return;
    entry.finished = true;
    entry.finishedAt = this.now();
    entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
    const encoded = finiteNumber(params['encodedDataLength'], 0);
    if (encoded > 0) {
      entry.responseBytes = encoded;
      entry.transferSize = encoded;
    }
  }

  private onLoadingFailed(state: DebugCdpState, params: Record<string, unknown>): void {
    const entry = state.byRequestId.get(String(params['requestId'] ?? ''));
    if (!entry) return;
    entry.error = String(params['errorText'] ?? 'failed');
    entry.finished = true;
    entry.finishedAt = this.now();
    entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
  }

  private onWebSocketCreated(state: DebugCdpState, params: Record<string, unknown>): void {
    const requestId = String(params['requestId'] ?? '');
    if (!requestId) return;
    state.socketSeq += 1;
    const socket: DebugCdpSocket = {
      id: state.socketSeq,
      requestId,
      url: String(params['url'] ?? ''),
      createdAt: this.now(),
      closed: false,
      error: null,
      frames: [],
    };
    state.sockets.set(socket.id, socket);
    state.socketByRequestId.set(requestId, socket.id);
    const entry = state.byRequestId.get(requestId);
    if (entry) entry.webSocketId = socket.id;
  }

  private socketOf(state: DebugCdpState, params: Record<string, unknown>): DebugCdpSocket | null {
    const requestId = String(params['requestId'] ?? '');
    const id = state.socketByRequestId.get(requestId);
    if (id === undefined) return null;
    return state.sockets.get(id) ?? null;
  }

  private onWebSocketFrame(state: DebugCdpState, params: Record<string, unknown>, direction: 'sent' | 'received' | 'error'): void {
    const socket = this.socketOf(state, params);
    if (!socket) return;
    const response = asRecord(params['response']);
    const at = this.now();
    socket.frames.push({
      direction,
      opcode: response['opcode'] === undefined ? null : Number(response['opcode']),
      payload: String(response['payloadData'] ?? ''),
      at,
      ...(params['errorMessage'] ? { error: String(params['errorMessage']) } : {}),
    });
    if (socket.frames.length > this.maxWsFrames) socket.frames.splice(0, socket.frames.length - this.maxWsFrames);
    if (direction === 'error') {
      socket.error = String(params['errorMessage'] ?? 'websocket error');
      socket.closed = true;
    }
  }

  private onWebSocketClosed(state: DebugCdpState, params: Record<string, unknown>): void {
    const socket = this.socketOf(state, params);
    if (socket) socket.closed = true;
  }

  private onConsoleApiCalled(state: DebugCdpState, params: Record<string, unknown>): void {
    const args = Array.isArray(params['args']) ? params['args'] : [];
    const timestamp = Number(params['timestamp']);
    const at = Number.isFinite(timestamp) && timestamp > 0 ? Math.round(timestamp) : this.now();
    const text = args.map((arg) => consoleArgText(arg)).join(' ').slice(0, 4_000);
    state.consoleSeq += 1;
    state.consoleEntries.push({ id: state.consoleSeq, level: levelOf(params['type']), text, at, type: String(params['type'] ?? 'log') });
    if (state.consoleEntries.length > this.maxConsole) {
      state.consoleEntries.splice(0, state.consoleEntries.length - this.maxConsole);
    }
  }

  private onExceptionThrown(state: DebugCdpState, params: Record<string, unknown>): void {
    const details = asRecord(params['exceptionDetails']);
    const exception = asRecord(details['exception']);
    const text = String(details['text'] ?? '') + (exception['description'] ? ' ' + String(exception['description']) : '');
    const timestamp = Number(params['timestamp']);
    const at = Number.isFinite(timestamp) && timestamp > 0 ? Math.round(timestamp) : this.now();
    state.consoleSeq += 1;
    state.consoleEntries.push({
      id: state.consoleSeq,
      level: 'error',
      text: text.trim().slice(0, 4_000),
      at,
      type: 'exception',
    });
    if (state.consoleEntries.length > this.maxConsole) {
      state.consoleEntries.splice(0, state.consoleEntries.length - this.maxConsole);
    }
  }

  private onFrameNavigated(state: DebugCdpState, params: Record<string, unknown>): void {
    const frame = asRecord(params['frame']);
    const parentId = frame['parentId'];
    if (!frame['url']) return;
    state.context.frames += parentId === undefined ? 0 : 1;
    if (parentId !== undefined) return;
    state.context.url = String(frame['url'] ?? '');
    state.context.frameId = String(frame['id'] ?? '');
    const name = String(frame['name'] ?? '');
    if (name) state.context.title = name;
  }

  private async readContext(state: DebugCdpState): Promise<void> {
    const tree = await this.client.send<Record<string, unknown>>(state.tabId, 'Page.getFrameTree', {}, this.sendOptions());
    const root = asRecord(asRecord(tree)['frameTree']);
    const frame = asRecord(root['frame']);
    if (frame['url']) state.context.url = String(frame['url']);
    if (frame['id']) state.context.frameId = String(frame['id']);
    let count = 0;
    const walk = (node: Record<string, unknown>): void => {
      count += 1;
      for (const child of Array.isArray(node['childFrames']) ? node['childFrames'] : []) walk(asRecord(child));
    };
    walk(root);
    state.context.frames = count;
    try {
      const evaluated = await this.client.send<Record<string, unknown>>(state.tabId, 'Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title })',
        returnByValue: true,
      }, this.sendOptions());
      const value = asRecord(asRecord(asRecord(evaluated)['result'])['value']);
      if (value['url']) state.context.url = String(value['url']);
      if (value['title']) state.context.title = String(value['title']);
    } catch {
      // 页面导航中/被 CSP 拦截时保留 frame tree 的 URL
    }
  }

  private sendOptions(): { timeoutMs?: number } | undefined {
    return this.timeoutMs === undefined ? undefined : { timeoutMs: this.timeoutMs };
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('DebugCdpRecorder 已释放');
  }
}

/** 便捷工厂。 */
export function createDebugCdpRecorder(options: DebugCdpRecorderOptions): DebugCdpRecorder {
  return new DebugCdpRecorder(options);
}
