// src/network/service.ts —— 网络只读面（M-C 第三批）。
//
// 关键取舍：**不接 chrome.debugger**，因此没有 Network 域的 requestWillBeSent /
// responseReceived / getResponseBody。能拿到的只有 PerformanceResourceTiming：
//   URL、发起类型、开始时间、耗时、HTTP 状态（Chrome/Edge 109+ 的 responseStatus）、
//   传输/解码字节、各阶段计时。
// 拿不到（字段一律 null 并在 limitations 里写清楚，不编造）：
//   HTTP 方法、请求/响应头、请求体/响应体、WebSocket 帧、CDP 的 requestId/commandId。
//
// 这样做的好处是零权限、零 attach：不与 JS 扩展争 debugger，也不会因为挂调试器触发反爬。
// 采集语义是“时间线过滤”：start 记录起始时间，list 只返回起始时间之后的资源条目。

import { RpcMethodError } from '../rpc/registry.ts';
import { assertProtocolCompatible, type ProtocolPeer } from '../protocol.ts';
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import type { ScriptingApi } from '../scripting/evaluate.ts';
import { buildNetworkWaterfall } from './waterfall.ts';
import type { WaterfallEntryLike } from './waterfall.ts';
import type {
  ContentNetworkEntriesResult,
  ContentNetworkEntry,
  ContentReply,
  ContentRequest,
} from '../content/protocol.ts';

export interface NetworkContentTransport {
  request(tabId: number, request: ContentRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ContentReply>;
}

export interface NetworkCaptureState {
  tabId: number;
  startedAt: number;
  bodies: boolean;
  /** 开始时的已见条目数（PerformanceResourceTiming 是累计时间线）。 */
  baselineSeen: number;
  lastSeen: number;
  active: boolean;
  mode: 'resource-timing';
}

export interface NetworkServiceOptions {
  content: NetworkContentTransport;
  peer?: ProtocolPeer;
  now?: () => number;
  defaultTimeoutMs?: number;
  /** 资源计时的 commandId 时间窗归因（没有 CDP requestId 的近似；返回 null 表示无归属）。 */
  commandResolver?: ((startedAt: number) => string | null) | null;
  /** MAIN world 执行器：network.replay 在页面上下文里重放请求（可选）。 */
  scripting?: ScriptingApi | null;
}

export interface NetworkPublicEntry {
  id: number;
  requestId: null;
  method: null;
  url: string;
  status: number | null;
  durationMs: number;
  type: string;
  resourceType: string;
  mime: string;
  protocol: null;
  startedAt: number;
  requestBytes: 0;
  responseBytes: number;
  transferSize: number;
  error: null;
  fromCache: boolean;
  pageUrl: string;
  commandId: string | null;
  frameId: string;
  frame: null;
  finished: boolean;
  streaming: boolean;
  chunked: boolean;
  chunkCount: 0;
  timings: ContentNetworkEntry['timings'];
}

const LIMITATIONS: readonly string[] = Object.freeze([
  'no-debugger: 请求方法/请求头/响应头/请求体/响应体不可得（需要 chrome.debugger，本运行时明确不接）',
  'timeline: 资源计时只包含浏览器写入 performance timeline 的条目（跨源可能被 Timing-Allow-Origin 限制）',
  'no-command-id: 没有 CDP 的 requestId/commandId，无法把请求精确归因到某条命令',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

/** network.replay 的主世界结果（自包含函数的返回形状）。 */
interface MainWorldReplayResult {
  ok?: boolean;
  status?: number;
  statusText?: string;
  durationMs?: number;
  body?: string;
  truncated?: boolean;
  headers?: Record<string, string> | null;
  error?: string;
}

interface MainWorldReplayInput {
  url: string;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
}

/**
 * 主世界重放体。**必须自包含**：chrome.scripting 会序列化这个函数（闭包不跟随）。
 * 用 credentials:'include' 保持与控制台 fetch 一致的 cookie 语义。
 */
function mainWorldReplay(input: MainWorldReplayInput): Promise<MainWorldReplayResult> {
  const started = performance.now();
  const init: RequestInit = { method: input.method || 'GET', credentials: 'include' };
  if (input.headers) init.headers = input.headers;
  if (typeof input.body === 'string') init.body = input.body;
  return fetch(input.url, init)
    .then(async (response) => {
      const text = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        durationMs: Math.round(performance.now() - started),
        body: text.slice(0, 200_000),
        truncated: text.length > 200_000,
        headers,
      };
    })
    .catch((error: unknown) => ({
      ok: false,
      durationMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    }));
}

/**
 * 网络只读服务。
 *
 * ```ts
 * const network = new NetworkService({ content });
 * await network.start({ tabId: 7 });
 * const list = await network.list({ tabId: 7, filter: { urlContains: '/api/ping' } });
 * ```
 */
export class NetworkService {
  private readonly content: NetworkContentTransport;
  private readonly now: () => number;
  private readonly defaultTimeoutMs: number;
  private peerValue: ProtocolPeer;
  private readonly captures = new Map<number, NetworkCaptureState>();
  private readonly commandResolver: ((startedAt: number) => string | null) | null;
  private readonly scripting: ScriptingApi | null;

  constructor(options: NetworkServiceOptions) {
    if (!options || typeof options.content?.request !== 'function') {
      throw new TypeError('NetworkService 需要一个 content transport（request 方法）');
    }
    this.content = options.content;
    this.now = options.now ?? Date.now;
    this.defaultTimeoutMs = Number(options.defaultTimeoutMs) > 0 ? Math.floor(Number(options.defaultTimeoutMs)) : 15_000;
    this.peerValue = options.peer ?? { protocol: PROTOCOL_VERSION };
    this.commandResolver = options.commandResolver ?? null;
    this.scripting = options.scripting ?? null;
  }

  setPeer(peer: ProtocolPeer | null | undefined): void {
    this.peerValue = peer ?? {};
  }

  /** 当前活跃采集（诊断用）。 */
  activeCaptures(): NetworkCaptureState[] {
    return [...this.captures.values()].filter((state) => state.active);
  }

  private async entriesOf(tabId: number): Promise<ContentNetworkEntriesResult> {
    const request: ContentRequest = { type: 'bb.content', requestId: 'net-entries-' + String(tabId), op: 'network-entries', params: {} };
    let reply: ContentReply;
    try {
      reply = await this.content.request(tabId, request, { timeoutMs: this.defaultTimeoutMs });
    } catch (error) {
      throw new RpcMethodError('E_CONTENT_ERROR', '读取页面资源计时失败：' + errorMessageOf(error), { tabId });
    }
    if (!reply || reply.ok !== true) {
      const failure = reply ?? { ok: false, code: 'E_CONTENT_ERROR', message: '内容脚本没有回包' };
      throw new RpcMethodError(
        (failure as { code?: string }).code ?? 'E_CONTENT_ERROR',
        (failure as { message?: string }).message ?? '读取资源计时失败',
        (failure as { data?: unknown }).data,
      );
    }
    return reply.result as ContentNetworkEntriesResult;
  }

  private requireTabId(params: Record<string, unknown>): number {
    const tabId = positiveInt(params.tabId);
    if (tabId === null) throw new RpcMethodError('E_BAD_ARG', 'network 命令需要正整数 tabId（由 daemon 按会话注入）', { tabId: params.tabId ?? null });
    return tabId;
  }

  /** network.start：记录时间线基线（不挂调试器）。 */
  async start(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = this.requireTabId(params);
    assertProtocolCompatible(this.peerValue, 'network.start', params);
    const timeline = await this.entriesOf(tabId);
    const state: NetworkCaptureState = {
      tabId,
      startedAt: this.now(),
      bodies: params.bodies === true,
      baselineSeen: timeline.entries.length,
      lastSeen: timeline.entries.length,
      active: true,
      mode: 'resource-timing',
    };
    this.captures.set(tabId, state);
    return {
      ok: true,
      captureId: String(tabId) + '-' + String(state.startedAt),
      active: true,
      mode: 'resource-timing',
      // bodies 需要 debugger；如实回复 false，而不是假装能取正文。
      bodies: false,
      bodiesRequested: state.bodies,
      baseline: timeline.entries.length,
      limitations: [...LIMITATIONS],
    };
  }

  /** network.stop：结束采集并返回条目数。 */
  async stop(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = this.requireTabId(params);
    const state = this.captures.get(tabId);
    if (!state) return { ok: true, entries: 0, active: false, mode: 'resource-timing' };
    const timeline = await this.entriesOf(tabId).catch(() => null);
    state.active = false;
    state.lastSeen = timeline ? timeline.entries.length : state.lastSeen;
    const count = timeline ? Math.max(0, timeline.entries.length - state.baselineSeen) : 0;
    return { ok: true, entries: count, active: false, mode: 'resource-timing' };
  }

  /** network.list：按捕获起始 + filter 过滤时间线条目。 */
  async list(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = this.requireTabId(params);
    assertProtocolCompatible(this.peerValue, 'network.list', params);
    const state = this.captures.get(tabId) ?? null;
    const timeline = await this.entriesOf(tabId);
    const since = Number(params.since);
    const effectiveSince = Number.isFinite(since) && since > 0 ? since : (state ? state.startedAt : 0);
    const limitRaw = Number(params.limit);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200, 1), 500);
    const filter = isRecord(params.filter) ? params.filter : {};
    const filtered = timeline.entries.filter((entry) => {
      if (effectiveSince > 0 && entry.startedAt < effectiveSince) return false;
      if (typeof filter.urlContains === 'string' && filter.urlContains && !entry.url.includes(filter.urlContains)) return false;
      if (filter.method !== undefined && filter.method !== null) {
        // 资源计时没有 HTTP 方法：请求方法过滤时如实返回空集（不猜成 GET）。
        return false;
      }
      if (filter.status !== undefined && filter.status !== null && Number(entry.status) !== Number(filter.status)) return false;
      if (typeof filter.type === 'string' && filter.type && entry.initiatorType.toLowerCase() !== filter.type.toLowerCase()) return false;
      if (filter.frameId !== undefined && filter.frameId !== null && Number(filter.frameId) !== 0) return false;
      if (filter.finished === true && entry.finished !== true) return false;
      if (filter.streaming === true) return false;
      return true;
    });
    if (state) state.lastSeen = timeline.entries.length;
    const entries = filtered.slice(-limit).map((entry) => this.publicEntry(entry, timeline.url, timeline.timeOrigin));
    return {
      ok: true,
      entries,
      active: state ? state.active : false,
      bodies: false,
      total: Math.max(0, timeline.entries.length - (state ? state.baselineSeen : 0)),
      mode: 'resource-timing',
      limitations: [...LIMITATIONS],
    };
  }

  /** network.detail：单条条目的阶段计时 + 明确的能力缺口。 */
  async detail(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = this.requireTabId(params);
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw new RpcMethodError('E_BAD_ARG', 'network.detail 需要正整数 id', { id: params.id ?? null });
    const timeline = await this.entriesOf(tabId);
    const entry = timeline.entries.find((item) => item.id === id);
    if (!entry) throw new RpcMethodError('E_NOT_FOUND', '找不到网络记录 id=' + String(id) + '（先 network list）', { id });
    const state = this.captures.get(tabId) ?? null;
    return {
      ok: true,
      entry: this.publicEntry(entry, timeline.url, timeline.timeOrigin),
      requestHeaders: null,
      responseHeaders: null,
      requestBody: null,
      responseBody: null,
      requestBodyUnavailable: 'no-debugger',
      responseBodyUnavailable: 'no-debugger',
      timings: entry.timings,
      frame: null,
      transferSize: entry.transferSize,
      protocol: null,
      fromCache: entry.fromCache,
      serverIPAddress: null,
      chunks: { count: 0, dataLength: entry.decodedBodySize, encodedDataLength: entry.transferSize, chunked: false, streaming: false, finished: entry.finished, truncated: false },
      bodies: state ? state.bodies : false,
      mode: 'resource-timing',
      limitations: [...LIMITATIONS],
    };
  }

  /**
   * network.waterfall：相对时间轴 / 慢请求 / 分类 / 错误统计。
   * 数据来自当前采集（没有采集时返回空 rows，不抛错——CLI/MCP 都按 rows 判空）。
   */
  async waterfall(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = this.requireTabId(params);
    assertProtocolCompatible(this.peerValue, 'network.waterfall', params);
    const state = this.captures.get(tabId);
    const timeline = await this.entriesOf(tabId).catch(() => null);
    const since = state ? state.startedAt : 0;
    const base = (timeline?.entries ?? [])
      .filter((entry) => !since || entry.startedAt >= since)
      .map((entry) => this.publicEntry(entry, timeline?.url ?? '', timeline?.timeOrigin ?? 0));
    const filter = isRecord(params['filter']) ? params['filter'] : {};
    const built = buildNetworkWaterfall(base as unknown as WaterfallEntryLike[], {
      limit: Number(params['limit']) || 500,
      slowMs: Number(params['slowMs']) || Number(filter['minDuration']) || 1_000,
      urlContains: typeof filter['urlContains'] === 'string' ? filter['urlContains'] : '',
      status: filter['status'] === undefined ? null : Number(filter['status']),
    });
    return {
      ok: true,
      ...built,
      active: state ? state.active : false,
      mode: 'resource-timing',
      limitations: [...LIMITATIONS],
    };
  }

  /**
   * network.replay：在页面主世界重放一个请求（network start 采到的 id，或显式 request 对象）。
   * 需要注入的 chrome.scripting（MAIN world），否则明确 E_NOT_IMPLEMENTED。
   */
  async replay(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = this.requireTabId(params);
    const direct = isRecord(params['request']) ? params['request'] : null;
    let entry: NetworkPublicEntry | null = null;
    if (!direct) {
      const id = Number(params['id']);
      if (!Number.isInteger(id) || id <= 0) throw new RpcMethodError('E_BAD_ARG', 'network.replay 需要正整数 id 或 request 对象', { id: params['id'] ?? null });
      const state = this.captures.get(tabId);
      const timeline = await this.entriesOf(tabId);
      const since = state ? state.startedAt : 0;
      const found = timeline.entries.find((item) => item.id === id && (!since || item.startedAt >= since));
      if (!found) throw new RpcMethodError('E_NOT_FOUND', '找不到网络记录 id=' + String(id) + '（先 network start）', { id });
      entry = this.publicEntry(found, timeline.url, timeline.timeOrigin);
    }
    const overrides = isRecord(params['overrides']) ? params['overrides'] : {};
    const request = {
      url: String(overrides['url'] ?? (direct ? direct['url'] : entry?.url) ?? ''),
      method: String(overrides['method'] ?? (direct ? direct['method'] : (entry?.method ?? 'GET')) ?? 'GET').toUpperCase(),
      headers: isRecord(overrides['headers'])
        ? overrides['headers'] as Record<string, string>
        : (direct && isRecord(direct['headers']) ? direct['headers'] as Record<string, string> : null),
      body: typeof overrides['body'] === 'string'
        ? String(overrides['body'])
        : (direct && typeof direct['body'] === 'string' ? String(direct['body']) : null),
    };
    if (!request.url) throw new RpcMethodError('E_BAD_ARG', 'network.replay 需要 url');
    if (!this.scripting || typeof this.scripting.scripting.executeScript !== 'function') {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', '当前运行时没有 chrome.scripting，无法在页面上下文重放请求', {
        method: 'network.replay',
        limitation: 'needs chrome.scripting MAIN world',
      });
    }
    const startedAt = this.now();
    const results = await this.scripting.scripting.executeScript<MainWorldReplayResult>({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: mainWorldReplay,
      args: [request] as never[],
    });
    const first = Array.isArray(results) ? results[0] : null;
    if (!first) throw new RpcMethodError('E_REPLAY_FAILED', '主世界重放没有返回结果（页面可能正在导航）', { tabId });
    if (first.error && first.error.message) throw new RpcMethodError('E_REPLAY_FAILED', '主世界重放失败：' + first.error.message, { tabId });
    const result = (first.result ?? {}) as MainWorldReplayResult;
    if (result.ok !== true) {
      throw new RpcMethodError('E_REPLAY_FAILED', '重放请求失败：' + String(result.error || 'unknown'), {
        tabId,
        url: request.url,
        method: request.method,
      });
    }
    return {
      ok: true,
      id: Number(params['id']) || (entry ? Number(entry.id) : 0),
      url: request.url,
      method: request.method,
      status: Number(result.status) || 0,
      statusText: String(result.statusText ?? ''),
      durationMs: Number(result.durationMs) || Math.max(0, this.now() - startedAt),
      body: String(result.body ?? ''),
      truncated: result.truncated === true,
      responseHeaders: result.headers ?? null,
      mode: 'page-fetch-replay',
    };
  }

  /** tab 关闭/会话结束时的清理。 */
  forgetTab(tabId: number): void {
    this.captures.delete(Number(tabId));
  }

  clear(): void {
    this.captures.clear();
  }

  private publicEntry(entry: ContentNetworkEntry, pageUrl: string, timeOrigin: number): NetworkPublicEntry {
    void timeOrigin;
    return {
      id: entry.id,
      requestId: null,
      method: null,
      url: entry.url,
      status: entry.status,
      durationMs: entry.durationMs,
      type: entry.initiatorType,
      resourceType: entry.initiatorType,
      mime: '',
      protocol: null,
      startedAt: entry.startedAt,
      requestBytes: 0,
      responseBytes: entry.transferSize,
      transferSize: entry.transferSize,
      error: null,
      fromCache: entry.fromCache,
      pageUrl,
      commandId: this.commandResolver ? this.commandResolver(entry.startedAt) : null,
      frameId: '0',
      frame: null,
      finished: entry.finished,
      streaming: !entry.finished,
      chunked: false,
      chunkCount: 0,
      timings: entry.timings,
    };
  }
}
