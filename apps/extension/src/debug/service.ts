// src/debug/service.ts —— debug 只读域（M-C 第四批）：console 采集、请求快照、操作时间线、
// capabilities/pin 与 rules 只读列表。
//
// 边界（与 JS 扩展 extension/src/debug.js 的差别）：
// - 没有 CDP Network/Console 域：请求快照来自 PerformanceResourceTiming（NetworkService 的
//   只读面），console 来自页面主世界的 console 钩子（chrome.scripting MAIN）；
// - 没有请求/响应头与正文（bodies 请求会明确标注 unavailable:'no-debugger'）；
// - rules 是**只读列表**：DNR 规则的读取来自 chrome.declarativeNetRequest.getSessionRules /
//   getDynamicRules；fulfill/modify 需要 Fetch 域（CDP），本批不迁移；
// - 操作时间线（operations）由 daemon 记录；这里维护一份扩展侧的“命令窗口”用于把资源计时
//   条目归因到 commandId（时间窗近似，字段注明 commandIdSource:'time-window'）。

import { RpcMethodError } from '../rpc/registry.ts';
import type { ContentReply, ContentRequest } from '../content/protocol.ts';
import type { NetworkService } from '../network/service.ts';
import type { ScriptingApi } from '../scripting/evaluate.ts';
import type { CdpChannel } from './cdp-channel.ts';
import { DebugCdpRecorder } from './recorder.ts';

export interface DebugContentTransport {
  request(
    tabId: number,
    request: ContentRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal; frameId?: number },
  ): Promise<ContentReply>;
}

export interface DnrRulesApi {
  getSessionRules?(): Promise<Array<Record<string, unknown>>>;
  getDynamicRules?(): Promise<Array<Record<string, unknown>>>;
}

export interface DebugServiceOptions {
  content: DebugContentTransport;
  network?: NetworkService | null;
  scripting?: ScriptingApi | null;
  rules?: DnrRulesApi | null;
  timeline?: OperationTimeline | null;
  /** CDP 通道（M-C 第六批 wave 2）：注入后 debug 域优先走 Network/Runtime/Page 真实面。 */
  cdp?: { client: CdpChannel } | null;
  /** 资源条目 → commandId 的时间窗归因（CDP 没有 x-bridge-command 头时的近似）。 */
  commandResolver?: ((startedAt: number) => string | null) | null;
  now?: () => number;
  setTimer?: (handler: () => void, ms: number) => unknown;
}

export interface DebugConsoleEntry {
  id: number;
  level: string;
  text: string;
  at: number;
}

export interface DebugSession {
  id: string;
  name: string;
  tabId: number;
  startedAt: number;
  stoppedAt: number | null;
  bodies: boolean;
  requests: number;
  console: number;
  /** 采集模式：cdp-network（真实 Network/Runtime/Page）或 page-hooks+resource-timing（降级）。 */
  mode?: string;
}

/** 命令窗口时间线：给网络条目做时间窗归因（不是 CDP 的 requestId/commandId）。 */
export class OperationTimeline {
  private readonly windows: Array<{ id: string; method: string; startedAt: number; finishedAt: number; ok: boolean }> = [];
  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
  }

  record(input: { id: string; method: string; startedAt: number; finishedAt: number; ok: boolean }): void {
    if (!input.id) return;
    this.windows.push({ ...input });
    while (this.windows.length > this.limit) this.windows.shift();
  }

  /** 资源开始时间落在哪条命令窗口里（取最近的窗口；没有则 null）。 */
  commandFor(startedAt: number): string | null {
    let best: { id: string; distance: number } | null = null;
    for (const window of this.windows) {
      const from = window.startedAt - 25;
      const to = window.finishedAt + 25;
      if (startedAt < from || startedAt > to) continue;
      const distance = Math.abs(startedAt - window.finishedAt);
      if (!best || distance < best.distance) best = { id: window.id, distance };
    }
    return best ? best.id : null;
  }

  entries(limit = 100): Array<{ id: string; method: string; startedAt: number; finishedAt: number; durationMs: number; ok: boolean }> {
    return this.windows.slice(-Math.max(1, Math.min(500, limit))).map((window) => ({
      ...window,
      durationMs: Math.max(0, window.finishedAt - window.startedAt),
    }));
  }

  size(): number {
    return this.windows.length;
  }
}

/** 主世界 console 钩子（自包含；注入页面主世界后所有 evaluate/页面脚本的 console 都会进缓冲）。 */
function mainWorldInstallConsoleHooks(): { ok: boolean; installed: boolean } {
  const win = window as unknown as Record<string, unknown>;
  if (win.__bbConsoleHooksInstalled === true) return { ok: true, installed: false };
  const buffer = { seq: 0, entries: [] as Array<{ id: number; level: string; text: string; at: number }> };
  win.__bbConsoleBuffer = buffer;
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const level of levels) {
    const original = (console as unknown as Record<string, (...args: unknown[]) => void>)[level];
    const wrapped = function wrappedConsole(...args: unknown[]): void {
      try {
        const text = args.map((arg) => {
          if (typeof arg === 'string') return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }).join(' ').slice(0, 2000);
        buffer.seq += 1;
        buffer.entries.push({ id: buffer.seq, level, text, at: Date.now() });
        if (buffer.entries.length > 500) buffer.entries.shift();
      } catch {
        // 记录失败不影响页面自身的 console 输出
      }
      if (typeof original === 'function') original.apply(console, args);
    };
    try {
      (console as unknown as Record<string, unknown>)[level] = wrapped;
    } catch {
      // 少数站点冻结 console：保留原样
    }
  }
  win.__bbConsoleHooksInstalled = true;
  return { ok: true, installed: true };
}

function mainWorldReadConsole(args: { since: number; limit: number }): { ok: boolean; entries: Array<{ id: number; level: string; text: string; at: number }>; next: number | null; total: number } {
  const win = window as unknown as Record<string, unknown>;
  const buffer = win.__bbConsoleBuffer as { seq: number; entries: Array<{ id: number; level: string; text: string; at: number }> } | undefined;
  if (!buffer || !Array.isArray(buffer.entries)) return { ok: true, entries: [], next: null, total: 0 };
  const since = Number(args?.since) || 0;
  const limit = Math.max(1, Math.min(500, Number(args?.limit) || 100));
  const all = buffer.entries.filter((entry) => entry.id > since);
  const page = all.slice(0, limit);
  const next = all.length > page.length ? (page[page.length - 1]?.id ?? null) : null;
  return { ok: true, entries: page, next, total: all.length };
}

function mainWorldClearConsole(): { ok: boolean } {
  const win = window as unknown as Record<string, unknown>;
  const buffer = win.__bbConsoleBuffer as { seq: number; entries: unknown[] } | undefined;
  if (buffer) buffer.entries.length = 0;
  return { ok: true };
}

export const CONSOLE_HOOK_SOURCE = mainWorldInstallConsoleHooks.toString();

export const DEBUG_LIMITATIONS: readonly string[] = Object.freeze([
  'no-debugger: 没有 CDP Network/Console/Fetch 域；请求来自 PerformanceResourceTiming，console 来自页面主世界 console 钩子',
  'no-bodies: 请求/响应头与正文不可得（bodies=true 会带 unavailable:"no-debugger"）',
  'rules-readonly: 规则列表来自 DNR getSessionRules/getDynamicRules；fulfill/modify 需要 Fetch 域（未迁移）',
  'command-id: 资源条目到 commandId 的归因是时间窗近似（commandIdSource:"time-window"）',
]);

/** CDP 采集模式下的限制（真实 Network/Runtime 面可用；仍如实标注缺口）。 */
export const CDP_DEBUG_LIMITATIONS: readonly string[] = Object.freeze([
  'cdp-attach: 需要 chrome.debugger 权限；DevTools 同时打开时会争用调试会话',
  'bodies-on-demand: 响应正文在 debug.request 时按 requestId 取（debug start --bodies 决定是否请求）',
  'subresource-bodies: 已从缓冲区淘汰的大响应/重定向链可能取不到正文（unavailable:"not-available"）',
]);

let sessionSeq = 0;

/** debug 只读域服务。 */
export class DebugService {
  private readonly content: DebugContentTransport;
  private readonly network: NetworkService | null;
  private readonly scripting: ScriptingApi | null;
  private readonly rules: DnrRulesApi | null;
  readonly timeline: OperationTimeline;
  private readonly now: () => number;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly pinned = new Set<string>();
  private readonly history: DebugSession[] = [];
  private active: DebugSession | null = null;
  private consoleCursor = 0;
  private readonly cdpClient: CdpChannel | null;
  private readonly commandResolver: ((startedAt: number) => string | null) | null;
  private cdpRecorder: DebugCdpRecorder | null = null;
  /** 最近一次 CDP 采集启动失败的原因（debug.start 回包里如实带出）。 */
  private cdpFallbackReason: string | null = null;
  /** 最近一次已停止的采集（只读面在 stop 之后仍可读最近快照；active 明确为 false）。 */
  private lastStopped: DebugSession | null = null;

  constructor(options: DebugServiceOptions) {
    if (!options || typeof options.content?.request !== 'function') {
      throw new TypeError('DebugService 需要 content transport');
    }
    this.content = options.content;
    this.network = options.network ?? null;
    this.scripting = options.scripting ?? null;
    this.rules = options.rules ?? null;
    this.timeline = options.timeline ?? new OperationTimeline();
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.cdpClient = options.cdp?.client ?? null;
    this.commandResolver = options.commandResolver ?? null;
  }

  /** 惰性创建 CDP 采集器（没有注入通道时返回 null，走降级路径）。 */
  private recorder(): DebugCdpRecorder | null {
    if (!this.cdpClient) return null;
    if (!this.cdpRecorder) {
      this.cdpRecorder = new DebugCdpRecorder({
        client: this.cdpClient,
        now: this.now,
        commandResolver: this.commandResolver,
      });
    }
    return this.cdpRecorder;
  }

  private isCdpSession(): boolean {
    return Boolean(this.active && this.active.mode === 'cdp-network');
  }

  /**
   * 解析「要读哪个 tab 的调试只读面」：
   * 优先 active 会话，其次显式 tabId，最后最近一次已停止的采集（用于 stop 之后的只读查询）。
   */
  private resolveDebugTabId(params: Record<string, unknown>): number | null {
    const explicit = Number(params.tabId);
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
    if (this.active) return this.active.tabId;
    if (this.lastStopped) return this.lastStopped.tabId;
    return null;
  }

  /** 该 tab 是否有「最近一次已停止」的采集快照可读。 */
  private stoppedSessionOf(tabId: number): DebugSession | null {
    return this.lastStopped && this.lastStopped.tabId === Number(tabId) ? this.lastStopped : null;
  }

  /** 记录停止的会话：保留最后快照引用，供 stop 后的只读面（CLI 20b3 场景）读取。 */
  private rememberStopped(session: DebugSession): void {
    session.stoppedAt = session.stoppedAt ?? this.now();
    this.lastStopped = session;
  }

  private async runMainWorld<T>(tabId: number, func: (...args: never[]) => unknown, args: unknown[] = []): Promise<T> {
    if (!this.scripting || typeof this.scripting.scripting.executeScript !== 'function') {
      throw new RpcMethodError('E_EVAL_UNAVAILABLE', '当前运行时没有 chrome.scripting，无法注入 console 钩子', { tabId });
    }
    try {
      const results = await this.scripting.scripting.executeScript<T>({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: func as unknown as (...args: never[]) => unknown,
        args,
      });
      const first = Array.isArray(results) ? results[0] : null;
      if (!first) throw new RpcMethodError('E_EVAL_FAILED', '主世界注入没有返回结果（页面可能正在导航）', { tabId });
      if (first.error && first.error.message) throw new RpcMethodError('E_EVAL_FAILED', '主世界注入失败：' + first.error.message, { tabId });
      return first.result as T;
    } catch (error) {
      if (error instanceof RpcMethodError) throw error;
      throw new RpcMethodError('E_EVAL_FAILED', '主世界注入失败：' + (error instanceof Error ? error.message : String(error)), { tabId });
    }
  }

  private requireTabId(params: Record<string, unknown>): number {
    const tabId = Number(params.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw new RpcMethodError('E_BAD_ARG', 'debug 命令需要正整数 tabId（由 daemon 按会话注入）', { tabId: params.tabId ?? null });
    }
    return tabId;
  }

  /** debug.start：开始采集。优先 CDP Network/Runtime/Page；不可用时降级到页面钩子 + 资源计时。 */
  async start(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const tabId = this.requireTabId(params);
    if (this.active) {
      return {
        ok: true,
        capturing: true,
        name: this.active.name,
        startedAt: this.active.startedAt,
        mode: this.active.mode ?? 'page-hooks+resource-timing',
        note: '已有进行中的调试采集；不重复开启',
      };
    }
    const name = typeof params.name === 'string' && params.name ? params.name : '';
    const bodies = params.bodies === true;
    // 新一轮采集开始即取代旧快照：stop 后的只读面只应读“最近一次”采集。
    this.lastStopped = null;
    const recorder = this.recorder();
    if (recorder) {
      try {
        const started = await recorder.start(tabId, { bodies, name });
        sessionSeq += 1;
        const session: DebugSession = {
          id: String(started['id'] ?? 'cdp_' + String(sessionSeq)),
          name,
          tabId,
          startedAt: Number(started['startedAt']) > 0 ? Number(started['startedAt']) : this.now(),
          stoppedAt: null,
          bodies,
          requests: 0,
          console: 0,
          mode: 'cdp-network',
        };
        this.consoleCursor = 0;
        // CDP 采集之外的只读面也保持基线：network.* / debug.operations 仍按资源计时工作。
        try {
          await this.network?.start({ tabId, bodies });
        } catch {
          // 网络只读面失败不阻塞 CDP 采集
        }
        this.active = session;
        return {
          ok: true,
          capturing: true,
          id: session.id,
          name: session.name,
          startedAt: session.startedAt,
          bodies: true,
          bodiesRequested: bodies,
          mode: 'cdp-network',
          url: String(started['url'] ?? ''),
          consoleHook: true,
          journal: recorder.journal(tabId),
          limitations: [...CDP_DEBUG_LIMITATIONS],
        };
      } catch (error) {
        // 降级：没有 debugger 权限/DevTools 争用/被策略禁止 → 保持第四批只读面，并如实记录原因。
        this.cdpFallbackReason = error instanceof Error ? error.message : String(error);
      }
    }
    sessionSeq += 1;
    const session: DebugSession = {
      id: 'dbg_' + Math.floor(this.now()).toString(36) + '_' + String(sessionSeq),
      name,
      tabId,
      startedAt: this.now(),
      stoppedAt: null,
      bodies,
      requests: 0,
      console: 0,
      mode: 'page-hooks+resource-timing',
    };
    let hook: { ok: boolean; installed?: boolean } = { ok: false };
    try {
      hook = await this.runMainWorld<{ ok: boolean; installed: boolean }>(tabId, mainWorldInstallConsoleHooks);
    } catch (error) {
      // 页面注入失败不阻塞采集（网络时间线仍可用），但要给出结构化证据。
      hook = { ok: false, installed: false };
      void error;
    }
    this.consoleCursor = 0;
    try {
      await this.network?.start({ tabId, bodies: session.bodies });
    } catch {
      // 网络只读面失败不阻塞 console 采集
    }
    this.active = session;
    return {
      ok: true,
      capturing: true,
      id: session.id,
      name: session.name,
      startedAt: session.startedAt,
      bodies: false,
      bodiesRequested: session.bodies,
      mode: 'page-hooks+resource-timing',
      consoleHook: hook.ok,
      ...(this.cdpFallbackReason ? { cdpFallback: this.cdpFallbackReason } : {}),
      limitations: [...DEBUG_LIMITATIONS],
    };
  }

  private async snapshotRequests(tabId: number): Promise<Array<Record<string, unknown>>> {
    if (this.isCdpSession()) {
      const recorder = this.recorder();
      return recorder ? (recorder.requests(tabId) as unknown as Array<Record<string, unknown>>) : [];
    }
    if (!this.network || !this.active) return [];
    try {
      const listed = await this.network.list({ tabId, since: this.active.startedAt, limit: 500 });
      const entries = Array.isArray(listed.entries) ? listed.entries as Array<Record<string, unknown>> : [];
      return entries.map((entry) => ({
        id: entry.id,
        requestId: null,
        method: null,
        url: entry.url,
        status: entry.status,
        durationMs: entry.durationMs,
        type: entry.type,
        startedAt: entry.startedAt,
        commandId: entry.commandId ?? null,
        commandIdSource: 'time-window',
        responseBytes: entry.responseBytes,
        timings: entry.timings,
      }));
    } catch {
      return [];
    }
  }

  private async snapshotConsole(tabId: number): Promise<DebugConsoleEntry[]> {
    if (this.isCdpSession()) {
      const recorder = this.recorder();
      return recorder ? recorder.console(tabId) : [];
    }
    try {
      const outcome = await this.runMainWorld<{ entries?: DebugConsoleEntry[] }>(tabId, mainWorldReadConsole, [{ since: 0, limit: 500 }]);
      return Array.isArray(outcome?.entries) ? outcome.entries : [];
    } catch {
      return [];
    }
  }

  /** debug.current：当前采集快照（requests/console/context/websockets/journal）。 */
  async current(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const session = this.active;
    if (!session) {
      // stop 之后的只读查询：返回「最近一次已停止采集」的快照（active:false，不谎报在采集中）。
      const tabId = this.resolveDebugTabId(params);
      const stopped = tabId === null ? null : this.stoppedSessionOf(tabId);
      if (tabId !== null && stopped) return this.stoppedSnapshot(stopped, tabId);
      throw new RpcMethodError('E_NOT_ACTIVE', '当前没有进行中的调试采集（先 bridge debug start）', {
        active: false,
        history: this.history.slice(-5).map((item) => item.name),
      });
    }
    const tabId = Number(params.tabId) > 0 ? Number(params.tabId) : session.tabId;
    const timelineOps = this.timeline.entries(100);
    if (this.isCdpSession()) {
      const recorder = this.recorder();
      const requests = recorder ? recorder.requests(tabId) : [];
      const consoleEntries = recorder ? recorder.console(tabId) : [];
      const context = recorder ? recorder.context(tabId) : { url: '', title: '', frameId: null, frames: 0 };
      const websockets = recorder ? recorder.websockets(tabId) : { total: 0, sockets: [] };
      return {
        ok: true,
        active: true,
        id: session.id,
        name: session.name,
        startedAt: session.startedAt,
        bodies: session.bodies,
        mode: 'cdp-network',
        url: String(context.url ?? ''),
        context,
        requests,
        console: consoleEntries,
        websockets,
        journal: recorder ? recorder.journal(tabId) : [],
        operations: timelineOps,
        limitations: [...CDP_DEBUG_LIMITATIONS],
      };
    }
    const requests = await this.snapshotRequests(tabId);
    const consoleEntries = await this.snapshotConsole(tabId);
    const context = await this.pageContext(tabId);
    return {
      ok: true,
      active: true,
      id: session.id,
      name: session.name,
      startedAt: session.startedAt,
      bodies: false,
      mode: 'page-hooks+resource-timing',
      url: String(context?.url ?? ''),
      context,
      requests,
      console: consoleEntries,
      websockets: { total: 0, sockets: [] },
      journal: [],
      operations: timelineOps,
      limitations: [...DEBUG_LIMITATIONS],
    };
  }

  /** 已停止采集的快照（只读；不存在则空集合，不抛 E_NOT_ACTIVE）。 */
  private stoppedSnapshot(session: DebugSession, tabId: number): Record<string, unknown> {
    const recorder = this.recorder();
    const hasCdpSnapshot = Boolean(recorder && recorder.hasSnapshot(tabId));
    const context = hasCdpSnapshot && recorder ? recorder.context(tabId) : { url: '', title: '', frameId: null, frames: 0 };
    return {
      ok: true,
      active: false,
      stopped: true,
      id: session.id,
      name: session.name,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      bodies: session.bodies,
      mode: session.mode ?? 'page-hooks+resource-timing',
      url: String(context.url ?? ''),
      context,
      requests: hasCdpSnapshot && recorder ? recorder.requests(tabId) : [],
      console: hasCdpSnapshot && recorder ? recorder.console(tabId) : [],
      websockets: hasCdpSnapshot && recorder ? recorder.websockets(tabId) : { total: 0, sockets: [] },
      journal: recorder ? recorder.journal(tabId) : [],
      operations: this.timeline.entries(100),
      note: '采集已停止：返回最近一次采集快照（只读；重新 start 才开始新一轮采集）',
      limitations: session.mode === 'cdp-network' ? [...CDP_DEBUG_LIMITATIONS] : [...DEBUG_LIMITATIONS],
    };
  }

  private async pageContext(tabId: number): Promise<Record<string, unknown> | null> {
    try {
      const request: ContentRequest = {
        type: 'bb.content',
        requestId: 'debug-context-' + String(tabId) + '-' + String(this.now()),
        op: 'network-entries',
        params: {},
      };
      const reply = await this.content.request(tabId, request, { timeoutMs: 8_000 });
      if (!reply || reply.ok !== true) return null;
      const result = reply.result as { url?: string } | null;
      return { url: String(result?.url ?? '') };
    } catch {
      return null;
    }
  }

  /** debug.stop：结束采集并落历史。CDP 会话走真实 Network/Runtime 统计（保留最后快照可查）。 */
  async stop(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const session = this.active;
    if (!session) return { ok: true, requests: 0, console: 0, durationMs: 0, active: false };
    const tabId = Number(params.tabId) > 0 ? Number(params.tabId) : session.tabId;
    if (this.isCdpSession()) {
      const recorder = this.recorder();
      // 先取快照再 stop：stop 会移除 live 状态（请求/console 表随之清空）。
      const requests = recorder ? recorder.requests(tabId) : [];
      const consoleEntries = recorder ? recorder.console(tabId) : [];
      const stopped = recorder ? await recorder.stop(tabId).catch(() => null) : null;
      const stoppedAt = this.now();
      session.stoppedAt = stoppedAt;
      session.requests = requests.length;
      session.console = consoleEntries.length;
      this.history.push(session);
      while (this.history.length > 10) this.history.shift();
      this.active = null;
      this.rememberStopped(session);
      try {
        await this.network?.stop({ tabId });
      } catch {
        // 忽略停止失败：采集状态已清空
      }
      return {
        ok: true,
        active: false,
        id: session.id,
        name: session.name,
        requests: requests.length,
        console: consoleEntries.length,
        websockets: Number(stopped?.['websockets'] ?? 0),
        durationMs: Math.max(0, stoppedAt - session.startedAt),
        startedAt: session.startedAt,
        stoppedAt,
        bodies: session.bodies,
        mode: 'cdp-network',
        journalEvents: recorder ? recorder.journal(tabId).length : 0,
        limitations: [...CDP_DEBUG_LIMITATIONS],
      };
    }
    const requests = await this.snapshotRequests(tabId);
    const consoleEntries = await this.snapshotConsole(tabId);
    const startedAt = session.startedAt;
    session.stoppedAt = this.now();
    session.requests = requests.length;
    session.console = consoleEntries.length;
    this.history.push(session);
    while (this.history.length > 10) this.history.shift();
    this.active = null;
    this.rememberStopped(session);
    try {
      await this.network?.stop({ tabId });
    } catch {
      // 忽略停止失败：采集状态已清空
    }
    return {
      ok: true,
      active: false,
      id: session.id,
      name: session.name,
      requests: requests.length,
      console: consoleEntries.length,
      durationMs: Math.max(0, (session.stoppedAt ?? this.now()) - startedAt),
      startedAt,
      stoppedAt: session.stoppedAt,
      bodies: false,
      limitations: [...DEBUG_LIMITATIONS],
    };
  }

  /** debug.history：最近的采集记录。 */
  historyList(): Record<string, unknown> {
    return {
      ok: true,
      history: [...this.history].slice(-10).map((session) => ({
        id: session.id,
        name: session.name,
        requests: session.requests,
        console: session.console,
        startedAt: session.startedAt,
        stoppedAt: session.stoppedAt,
      })),
    };
  }

  /** debug.capabilities：本运行时真正可用的动作/部件（CDP 通道可用时不谎报缺口）。 */
  capabilities(): Record<string, unknown> {
    const cdp = Boolean(this.cdpClient);
    return {
      ok: true,
      actions: cdp
        ? ['pin', 'unpin', 'list', 'requests', 'request', 'console', 'performance', 'aggregate', 'history', 'export', 'journal', 'rules', 'pages', 'websocket']
        : ['pin', 'unpin', 'list', 'requests', 'console', 'performance', 'aggregate', 'history', 'export', 'journal', 'rules'],
      parts: cdp ? ['metadata', 'timing', 'headers', 'body', 'websocket', 'journal'] : ['metadata', 'timing'],
      unavailableParts: cdp ? [] : ['headers', 'response', 'request', 'body'],
      pinning: { supported: true, pinned: [...this.pinned] },
      rules: cdp
        ? { readonly: false, fulfill: true, modify: true }
        : { readonly: true, fulfill: false, modify: false },
      mode: cdp ? 'cdp-network' : 'page-hooks+resource-timing',
      ...(this.cdpFallbackReason ? { cdpFallback: this.cdpFallbackReason } : {}),
      limitations: cdp ? [...CDP_DEBUG_LIMITATIONS] : [...DEBUG_LIMITATIONS],
    };
  }

  /** debug.pin / unpin：钉住一条 id（只影响展示/覆盖统计）。 */
  pin(rawParams: unknown): Record<string, unknown> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const id = String(params.id ?? '');
    if (!id) throw new RpcMethodError('E_BAD_ARG', 'debug pin 需要 id');
    if (params.pinned === false) this.pinned.delete(id);
    else this.pinned.add(id);
    return { ok: true, id, pinned: this.pinned.has(id), pinnedList: [...this.pinned] };
  }

  pinnedList(): Record<string, unknown> {
    return { ok: true, pinned: [...this.pinned] };
  }

  /** console：按游标分页读取页面 console（limit/cursor）。 */
  async console(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const session = this.active;
    const tabId = this.resolveDebugTabId(params) ?? 0;
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw new RpcMethodError('E_BAD_ARG', 'console 需要正整数 tabId（或先 debug start）', { tabId: params.tabId ?? null });
    }
    const limit = Math.max(1, Math.min(200, Number(params.limit) > 0 ? Math.floor(Number(params.limit)) : 100));
    // CLI `console --cursor N` 实际发送 params.since=N（page.mjs），两种字段都接受。
    const cursorRaw = params.cursor !== undefined ? params.cursor : params.since;
    const cursor = Number(cursorRaw);
    const since = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
    const recorder = this.recorder();
    const stopped = !session ? this.stoppedSessionOf(tabId) : null;
    // CDP 会话或「最近一次已停止的 CDP 采集」都能读 console（stop 后不抛 E_NOT_ACTIVE）。
    if (recorder && (this.isCdpSession() || (stopped && stopped.mode === 'cdp-network'))) {
      const all = recorder.console(tabId);
      const filtered = all.filter((entry) => entry.id > since);
      const page = filtered.slice(0, limit);
      const nextCursor = filtered.length > page.length ? (page[page.length - 1]?.id ?? null) : null;
      return {
        ok: true,
        entries: page,
        nextCursor,
        cursor: since,
        total: page.length,
        active: Boolean(session),
        mode: 'cdp-network',
        ...(stopped ? { stopped: true, note: '采集已停止：读取最近一次采集的 console 快照' } : {}),
        limitations: [...CDP_DEBUG_LIMITATIONS],
      };
    }
    if (!session && stopped) {
      return {
        ok: true,
        entries: [],
        nextCursor: null,
        cursor: since,
        total: 0,
        active: false,
        mode: 'page-hooks+resource-timing',
        stopped: true,
        note: '采集已停止：没有可读的 console 快照',
        limitations: [...DEBUG_LIMITATIONS],
      };
    }
    const outcome = await this.runMainWorld<{ entries?: DebugConsoleEntry[]; next?: number | null }>(tabId, mainWorldReadConsole, [{ since, limit }]);
    const entries = Array.isArray(outcome?.entries) ? outcome.entries : [];
    return {
      ok: true,
      entries,
      nextCursor: typeof outcome?.next === 'number' ? outcome.next : null,
      cursor: since,
      total: entries.length,
      limitations: [...DEBUG_LIMITATIONS],
    };
  }

  /** debug.requests：当前采集里的请求列表（可被 CLI 过滤；stop 后读最近快照）。 */
  async requests(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const session = this.active;
    const recorder = this.recorder();
    const tabId = this.resolveDebugTabId(params);
    const stopped = !session && tabId !== null ? this.stoppedSessionOf(tabId) : null;
    if (tabId === null || (!session && !stopped)) {
      throw new RpcMethodError('E_NOT_ACTIVE', '当前没有进行中的调试采集（先 bridge debug start）', { active: false });
    }
    let entries: Array<Record<string, unknown>>;
    if (recorder && (this.isCdpSession() || (stopped && stopped.mode === 'cdp-network'))) {
      entries = recorder.requests(tabId) as unknown as Array<Record<string, unknown>>;
    } else if (session) {
      entries = await this.snapshotRequests(tabId);
    } else {
      entries = [];
    }
    return {
      ok: true,
      entries,
      active: Boolean(session),
      total: entries.length,
      mode: session?.mode ?? stopped?.mode ?? 'page-hooks+resource-timing',
      ...(stopped ? { stopped: true, note: '采集已停止：返回最近一次采集的请求快照' } : {}),
      limitations: (this.isCdpSession() || (stopped && stopped.mode === 'cdp-network'))
        ? [...CDP_DEBUG_LIMITATIONS]
        : [...DEBUG_LIMITATIONS],
    };
  }

  /** debug.request：单条请求详情（CDP 会话或最近快照下含头/正文/计时）。 */
  async request(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw new RpcMethodError('E_BAD_ARG', 'debug request 需要正整数 id');
    const session = this.active;
    const tabId = this.resolveDebugTabId(params) ?? 0;
    const stopped = !session && tabId > 0 ? this.stoppedSessionOf(tabId) : null;
    const recorder = this.recorder();
    if (recorder && (this.isCdpSession() || (stopped && stopped.mode === 'cdp-network'))) {
      try {
        return await recorder.requestDetail(tabId, id, {
          bodies: params.bodies === true || Boolean(session?.bodies ?? stopped?.bodies),
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'E_NOT_FOUND') {
          throw new RpcMethodError('E_NOT_FOUND', '请求不存在：' + String(id), { id });
        }
        // 其它失败（例如 tab 已关）：降级到旧路径，保持行为可预期。
      }
    }
    const requests = session ? await this.snapshotRequests(tabId) : [];
    const entry = requests.find((item) => Number(item.id) === id);
    if (!entry) throw new RpcMethodError('E_NOT_FOUND', '请求不存在：' + String(id), { id });
    return {
      ok: true,
      entry,
      requestHeaders: null,
      responseHeaders: null,
      requestBody: null,
      responseBody: null,
      requestBodyUnavailable: 'no-debugger',
      responseBodyUnavailable: 'no-debugger',
      timing: entry.timings,
      mode: 'page-hooks+resource-timing',
      limitations: [...DEBUG_LIMITATIONS],
    };
  }

  /** debug.performance：页面性能指标。CDP 会话（或注入通道）下用 Runtime/PerformanceObserver 实测。 */
  async performance(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const tabId = Number(params.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new RpcMethodError('E_BAD_ARG', 'debug performance 需要正整数 tabId');
    const recorder = this.recorder();
    if (recorder) {
      const measured = await recorder.performance(tabId).catch(() => null);
      // 只有真正测到页面指标才走 CDP 结果；attach/evaluate 失败时继续走资源计时降级面。
      if (measured && measured['ok'] === true && measured['degraded'] === undefined) {
        return { ...measured, limitations: [...CDP_DEBUG_LIMITATIONS] };
      }
    }
    const request: ContentRequest = {
      type: 'bb.content',
      requestId: 'debug-perf-' + String(tabId) + '-' + String(this.now()),
      op: 'network-entries',
      params: {},
    };
    let resources: Array<Record<string, unknown>> = [];
    let url = '';
    try {
      const reply = await this.content.request(tabId, request, { timeoutMs: 8_000 });
      if (reply && reply.ok === true) {
        const result = reply.result as { entries?: Array<Record<string, unknown>>; url?: string } | null;
        resources = Array.isArray(result?.entries) ? result.entries : [];
        url = String(result?.url ?? '');
      }
    } catch {
      resources = [];
    }
    const transfer = resources.reduce((sum, item) => sum + (Number(item.transferSize) || 0), 0);
    return {
      ok: true,
      metrics: {
        url,
        resources: { count: resources.length, transferBytes: transfer },
        ttfb: null,
        domContentLoaded: null,
        load: null,
        paints: [],
        lcp: null,
        cls: null,
        longTasks: { count: 0, maxMs: 0 },
      },
      mode: 'resource-timing',
      limitations: ['paint/lcp/cls/longtask 需要 PerformanceObserver 注入（本批只读资源计时）', ...DEBUG_LIMITATIONS],
    };
  }

  /** debug.rules：只读规则列表（DNR session + dynamic）。 */
  async rulesList(): Promise<Record<string, unknown>> {
    if (!this.rules) {
      return {
        ok: true,
        rules: [],
        readonly: true,
        source: 'none',
        note: '当前运行时没有 chrome.declarativeNetRequest：规则列表为空（不是伪造的空规则）',
        limitations: [...DEBUG_LIMITATIONS],
      };
    }
    const session = typeof this.rules.getSessionRules === 'function' ? await this.rules.getSessionRules().catch(() => []) : [];
    const dynamic = typeof this.rules.getDynamicRules === 'function' ? await this.rules.getDynamicRules().catch(() => []) : [];
    const normalize = (rule: Record<string, unknown>, source: string): Record<string, unknown> => ({
      id: rule.id ?? null,
      priority: rule.priority ?? 1,
      action: rule.action && typeof rule.action === 'object' ? ((rule.action as Record<string, unknown>).type ?? 'unknown') : 'unknown',
      urlPattern: rule.condition && typeof rule.condition === 'object'
        ? ((rule.condition as Record<string, unknown>).urlFilter ?? '')
        : '',
      status: 'active',
      hits: 0,
      source,
    });
    const rules = [
      ...(Array.isArray(session) ? session.map((rule) => normalize(rule, 'session')) : []),
      ...(Array.isArray(dynamic) ? dynamic.map((rule) => normalize(rule, 'dynamic')) : []),
    ];
    return {
      ok: true,
      rules,
      readonly: true,
      source: 'declarativeNetRequest',
      note: '规则列表只读：本运行时未迁移 Fetch 域的 fulfill/modify',
      limitations: [...DEBUG_LIMITATIONS],
    };
  }

  /** debug.coverage：覆盖统计与明确缺口（CDP 会话下缺口按真实能力收敛）。 */
  async coverage(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const session = this.active;
    const tabId = Number(params.tabId) > 0 ? Number(params.tabId) : (session?.tabId ?? 0);
    const requests = session ? await this.snapshotRequests(tabId) : [];
    const consoleEntries = session ? await this.snapshotConsole(tabId) : [];
    if (session && this.isCdpSession()) {
      const recorder = this.recorder();
      const websockets = recorder ? recorder.websockets(tabId) : { total: 0, sockets: [] };
      const journal = recorder ? recorder.journal(tabId) : [];
      const gaps: Array<Record<string, unknown>> = [];
      if (!session.bodies) gaps.push({ kind: 'response-body', reason: 'bodies-not-requested' });
      if (websockets.total === 0) gaps.push({ kind: 'websocket-frames', reason: 'no-websocket-observed' });
      if (journal.length === 0) gaps.push({ kind: 'journal', reason: 'no-events' });
      return {
        ok: true,
        active: true,
        requests: { total: requests.length, pinned: this.pinned.size },
        console: { total: consoleEntries.length },
        websockets: { total: websockets.total },
        pinned: this.pinned.size,
        complete: gaps.length === 0,
        gaps,
        mode: 'cdp-network',
        limitations: [...CDP_DEBUG_LIMITATIONS],
      };
    }
    const gaps = [
      { kind: 'response-body', reason: 'bodies-not-captured' },
      { kind: 'request-headers', reason: 'no-debugger' },
      { kind: 'request-bodies', reason: 'no-debugger' },
      { kind: 'websocket-frames', reason: 'no-debugger' },
      { kind: 'fetch-fulfill', reason: 'no-debugger' },
    ];
    return {
      ok: true,
      active: Boolean(session),
      requests: { total: requests.length, pinned: 0 },
      console: { total: consoleEntries.length },
      pinned: this.pinned.size,
      complete: false,
      gaps,
      mode: 'page-hooks+resource-timing',
      limitations: [...DEBUG_LIMITATIONS],
    };
  }

  clearTab(tabId: number): void {
    if (this.active && this.active.tabId === Number(tabId)) {
      this.active.stoppedAt = this.now();
      this.history.push(this.active);
      this.active = null;
    }
    const recorder = this.cdpRecorder;
    if (recorder) void recorder.forgetTab(Number(tabId)).catch(() => undefined);
  }
}

export { mainWorldInstallConsoleHooks, mainWorldReadConsole, mainWorldClearConsole };
export function __unusedTimer(value: unknown): void {
  void value;
}
