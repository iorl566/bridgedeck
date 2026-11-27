// src/cdp/client.ts —— chrome.debugger 通道：attach/detach、命令 send、子 session、超时、错误归一、并发去重、teardown。
//
// 设计对照（只读参考）：extension/src/debugger.js
// * 每个 tab 只 attach 一次；并发 attach 复用同一个进行中的 promise（避免
//   "Another debugger is already attached"）；
// * 命令带超时；"debugger is not attached" 视为本地状态陈旧 → 丢掉状态、重挂、重试一次；
// * 空闲软分离：release 后 idleDetachMs（默认 75s）内没有新活动才 detach，
//   长任务用 feature 租约持有期间不分离（与 JS 的 users/feature 账本同义）；
// * 子 session（OOPIF）：Target.setAutoAttach(flatten) + 递归对子 session 再开 autoAttach，
//   Target.detachedFromTarget / onDetach 时清理；
// * teardown：detachAll/dispose 清理计时器、事件监听与 session 表。
//
// 本模块不做业务判断，也不读页面；frames / 未来 debug 域在它之上组合。

import type {
  CdpAttachOptions,
  CdpAutoAttachOptions,
  CdpDetachListener,
  CdpEventHandler,
  CdpEventSource,
  CdpSendOptions,
  CdpStatus,
  CdpTargetSession,
  CdpWaitSessionsOptions,
  ChromeDebuggerApi,
} from './types.ts';
import { CdpError, normalizeCdpError } from './errors.ts';
import { resolveDebuggerApi } from './api.ts';

const ATTACH_VERSION = '1.3';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ATTACH_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_DETACH_MS = 75_000;

/** 自动附加 OOPIF 的参数（与 extension/src/frame-cdp.js 的 AUTO_ATTACH 同形）。 */
export const AUTO_ATTACH_PARAMS: Record<string, unknown> = Object.freeze({
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'iframe', exclude: false }],
});

/** 关闭自动附加（只关开关，不主动 detach 子 target）。 */
export const AUTO_DETACH_PARAMS: Record<string, unknown> = Object.freeze({
  autoAttach: false,
  waitForDebuggerOnStart: false,
  flatten: true,
});

export interface CdpClientOptions {
  /** 显式注入 chrome.debugger（测试用假实现）；省略/undefined = 从 globalThis 惰性解析；null = 禁用。 */
  api?: ChromeDebuggerApi | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 普通命令默认超时（默认 5000ms）。 */
  defaultTimeoutMs?: number;
  /** attach 默认超时（默认 5000ms）。 */
  attachTimeoutMs?: number;
  /** 空闲软分离窗口（默认 75000ms；0/负数 = 不自动分离）。 */
  idleDetachMs?: number;
}

interface CdpTabState {
  tabId: number;
  attachedAt: number;
  lastActivity: number;
  /** feature 租约：持有期间不进入空闲分离。 */
  features: Set<string>;
  sessions: Map<string, CdpTargetSession>;
  /** 是否已对 root 打开 Target.setAutoAttach。 */
  autoAttach: boolean;
}

type TimerHandle = ReturnType<typeof setTimeout>;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 单扩展进程内的 CDP 通道管理器（一个实例管所有 tab）。
 *
 * @example
 * const cdp = new CdpClient();
 * await cdp.acquire(tabId, 'frame-owner');
 * const tree = await cdp.send(tabId, 'Page.getFrameTree', {});
 * await cdp.release(tabId, 'frame-owner');
 */
export class CdpClient {
  private readonly explicitApi: ChromeDebuggerApi | null | undefined;
  private apiValue: ChromeDebuggerApi | null = null;
  private apiResolved = false;
  private readonly states = new Map<number, CdpTabState>();
  private readonly attachInFlight = new Map<number, Promise<CdpTabState>>();
  private readonly idleTimers = new Map<number, TimerHandle>();
  private readonly handlers = new Map<number, Map<string, Set<CdpEventHandler>>>();
  private readonly detachListeners = new Map<number, Set<CdpDetachListener>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultTimeoutMs: number;
  private readonly attachTimeoutMs: number;
  private readonly idleDetachMs: number;
  private listenerApi: ChromeDebuggerApi | null = null;
  private disposed = false;
  private readonly onEventBound = (source: CdpEventSource, method: string, params: Record<string, unknown>): void => {
    this.handleEvent(source, method, params);
  };
  private readonly onDetachBound = (source: CdpEventSource, reason: string): void => {
    this.handleDetach(source, reason);
  };

  constructor(options: CdpClientOptions = {}) {
    this.explicitApi = options.api;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));
    this.defaultTimeoutMs = clamp(options.defaultTimeoutMs, 0, 120_000, DEFAULT_TIMEOUT_MS);
    this.attachTimeoutMs = clamp(options.attachTimeoutMs, 0, 120_000, DEFAULT_ATTACH_TIMEOUT_MS);
    this.idleDetachMs = Number.isFinite(Number(options.idleDetachMs))
      ? Math.max(0, Number(options.idleDetachMs))
      : DEFAULT_IDLE_DETACH_MS;
  }

  /** 解析后的 chrome.debugger（null = 当前运行时不可用）。首次调用才读全局。 */
  api(): ChromeDebuggerApi | null {
    if (!this.apiResolved) {
      this.apiResolved = true;
      this.apiValue = this.explicitApi !== undefined ? this.explicitApi : resolveDebuggerApi();
      if (this.apiValue) this.bindListeners(this.apiValue);
    }
    return this.apiValue;
  }

  /** chrome.debugger 是否可用（不 attach，不改变状态）。 */
  available(): boolean {
    return !this.disposed && this.api() !== null;
  }

  isAttached(tabId: number): boolean {
    return this.states.has(Number(tabId));
  }

  attachedCount(): number {
    return this.states.size;
  }

  activeFeatures(tabId: number): string[] {
    const state = this.states.get(Number(tabId));
    return state ? [...state.features] : [];
  }

  sessions(tabId: number): CdpTargetSession[] {
    const state = this.states.get(Number(tabId));
    return state ? [...state.sessions.values()] : [];
  }

  status(tabId: number): CdpStatus {
    const state = this.states.get(Number(tabId));
    return {
      available: this.available(),
      attached: Boolean(state),
      sessions: state ? state.sessions.size : 0,
      features: state ? [...state.features] : [],
    };
  }

  /**
   * 挂载 debugger。并发调用复用同一个进行中的 promise（不会触发 busy）；
   * 已挂载时直接返回现有状态。
   */
  async attach(tabId: number, options: CdpAttachOptions = {}): Promise<CdpTabState> {
    this.assertUsable();
    const id = Number(tabId);
    if (!Number.isInteger(id) || id < 0) {
      throw new CdpError('E_CDP_ATTACH', 'attach 需要非负整数 tabId：' + String(tabId), {
        method: 'chrome.debugger.attach',
        tabId: Number.isInteger(id) ? id : null,
        phase: 'attach',
      });
    }
    const existing = this.states.get(id);
    if (existing) return existing;
    const pending = this.attachInFlight.get(id);
    if (pending) return pending;
    const task = this.doAttach(id, options);
    this.attachInFlight.set(id, task);
    try {
      return await task;
    } finally {
      if (this.attachInFlight.get(id) === task) this.attachInFlight.delete(id);
    }
  }

  /** attach + 持有 feature 租约（长任务期间不进入空闲分离）。 */
  async acquire(tabId: number, feature: string): Promise<void> {
    const state = await this.attach(tabId);
    const name = String(feature || 'anonymous');
    state.features.add(name);
    this.touch(tabId);
  }

  /** 释放 feature 租约；不立即 detach，交给空闲软分离窗口。 */
  release(tabId: number, feature: string): void {
    const id = Number(tabId);
    const state = this.states.get(id);
    if (!state) return;
    state.features.delete(String(feature || 'anonymous'));
    this.touch(id);
  }

  /** 发送 CDP 命令（root target 或子 session）。本地状态陈旧时自动重挂并重试一次。 */
  async send<T = unknown>(
    tabId: number,
    method: string,
    params: Record<string, unknown> = {},
    options: CdpSendOptions = {},
  ): Promise<T> {
    this.assertUsable();
    try {
      return await this.rawSend<T>(tabId, method, params, options);
    } catch (error) {
      const normalized = normalizeCdpError(error, {
        tabId: Number(tabId),
        method,
        phase: 'send',
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      });
      if (normalized.code !== 'E_CDP_DETACHED') throw normalized;
      // 浏览器侧已分离（DevTools 接管 / 渲染进程重建 / service worker 状态丢失）：
      // 丢掉陈旧状态，重新 attach 后重试一次（与 JS debugger.js 的 send 同口径）。
      this.forgetState(Number(tabId));
      await this.attach(Number(tabId));
      return await this.rawSend<T>(tabId, method, params, options);
    }
  }

  /** 向子 session 发送命令（sessionId 为空时退化为 root send）。 */
  sendToSession<T = unknown>(
    tabId: number,
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
    options: Omit<CdpSendOptions, 'sessionId'> = {},
  ): Promise<T> {
    if (!sessionId) return this.send<T>(tabId, method, params, options);
    return this.send<T>(tabId, method, params, { ...options, sessionId });
  }

  /**
   * 打开 Target.setAutoAttach（flatten, iframe）并递归附加子 session。
   * 只发开关命令；session 事件由 onEvent 内部账本收集，可用 waitForSessions 等稳定。
   */
  async ensureAutoAttach(tabId: number, options: CdpAutoAttachOptions = {}): Promise<void> {
    const id = Number(tabId);
    const state = await this.attach(id);
    state.autoAttach = true;
    try {
      await this.send(id, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS, {
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      });
    } catch (error) {
      state.autoAttach = false;
      throw normalizeCdpError(error, { tabId: id, method: 'Target.setAutoAttach', phase: 'send' });
    }
  }

  /**
   * 等子 session 数量稳定（连续 settleMs 没有新 session 或到 timeoutMs）。
   * 返回稳定后的 session 列表拷贝。
   */
  async waitForSessions(tabId: number, options: CdpWaitSessionsOptions = {}): Promise<CdpTargetSession[]> {
    const id = Number(tabId);
    const settleMs = clamp(options.settleMs, 0, 5_000, 250);
    const timeoutMs = clamp(options.timeoutMs, settleMs, 30_000, 3_000);
    const started = this.now();
    let lastCount = -1;
    let guard = 0;
    while (guard < 100) {
      guard += 1;
      const count = this.states.get(id)?.sessions.size ?? 0;
      if (count === lastCount) break;
      lastCount = count;
      if (this.now() - started >= timeoutMs) break;
      await this.sleep(settleMs);
    }
    return this.sessions(id);
  }

  /** 关闭自动附加（root + 所有子 session）。不主动 detach 子 target。 */
  async disableAutoAttach(tabId: number, options: { timeoutMs?: number } = {}): Promise<void> {
    const id = Number(tabId);
    const state = this.states.get(id);
    if (!state) return;
    state.autoAttach = false;
    const timeoutMs = options.timeoutMs ?? 2_000;
    const sessionIds = [...state.sessions.keys()];
    for (const sessionId of sessionIds) {
      await this.send(id, 'Target.setAutoAttach', AUTO_DETACH_PARAMS, { timeoutMs, sessionId }).catch(() => {});
    }
    await this.send(id, 'Target.setAutoAttach', AUTO_DETACH_PARAMS, { timeoutMs }).catch(() => {});
    state.sessions.clear();
  }

  /** 注册 CDP 事件处理器；返回退订函数。事件按 tab 维度保存，跨重挂保留。 */
  onEvent(tabId: number, method: string, handler: CdpEventHandler): () => void {
    const id = Number(tabId);
    let map = this.handlers.get(id);
    if (!map) {
      map = new Map();
      this.handlers.set(id, map);
    }
    let set = map.get(method);
    if (!set) {
      set = new Set();
      map.set(method, set);
    }
    set.add(handler);
    return () => {
      const current = this.handlers.get(id)?.get(method);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.get(id)?.delete(method);
    };
  }

  /** 监听外部分离（DevTools 接管 / 浏览器回收）；返回退订函数。 */
  onDetach(tabId: number, listener: CdpDetachListener): () => void {
    const id = Number(tabId);
    let set = this.detachListeners.get(id);
    if (!set) {
      set = new Set();
      this.detachListeners.set(id, set);
    }
    set.add(listener);
    return () => {
      this.detachListeners.get(id)?.delete(listener);
    };
  }

  /** 显式分离（幂等）。返回是否真的执行了 detach。 */
  async detach(tabId: number): Promise<boolean> {
    const id = Number(tabId);
    const attaching = this.attachInFlight.get(id);
    if (attaching) await attaching.catch(() => {});
    this.clearIdleTimer(id);
    const state = this.states.get(id);
    if (!state) {
      this.states.delete(id);
      return false;
    }
    state.autoAttach = false;
    const api = this.api();
    if (api) {
      try {
        await this.withTimeout(api.detach({ tabId: id }), 2_000, 'chrome.debugger.detach');
      } catch (error) {
        // 页面可能已关闭 / 已被外部 detach：不阻塞清理，错误留作诊断。
        const normalized = normalizeCdpError(error, { tabId: id, method: 'chrome.debugger.detach', phase: 'detach' });
        if (normalized.code !== 'E_CDP_NO_TAB' && normalized.code !== 'E_CDP_DETACHED') {
          // 不抛出：清理必须继续（与 JS debugger.js 的 detach 一致）。
        }
      }
    }
    this.states.delete(id);
    return true;
  }

  /** 分离所有 tab（teardown 用）。 */
  async detachAll(): Promise<void> {
    const ids = [...this.states.keys()];
    await Promise.all(ids.map((id) => this.detach(id).catch(() => false)));
  }

  /** 清理某个 tab 的所有本地状态（tab 关闭时由集成方调用）。 */
  async forgetTab(tabId: number): Promise<void> {
    const id = Number(tabId);
    await this.detach(id);
    this.handlers.delete(id);
    this.detachListeners.delete(id);
    this.clearIdleTimer(id);
  }

  /** 释放本实例持有的全部资源（background 卸载/测试结束时调用）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.detachAll();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.states.clear();
    this.handlers.clear();
    this.detachListeners.clear();
    const api = this.listenerApi;
    if (api) {
      try {
        api.onEvent?.removeListener?.(this.onEventBound);
        api.onDetach?.removeListener?.(this.onDetachBound);
      } catch {
        // 浏览器回收中：忽略
      }
    }
    this.listenerApi = null;
  }

  // ------------------------------------------------------------------ 内部

  private bindListeners(api: ChromeDebuggerApi): void {
    this.listenerApi = api;
    try {
      api.onEvent?.addListener(this.onEventBound);
    } catch {
      // 事件不可用不致命（命令面仍可工作）。
    }
    try {
      api.onDetach?.addListener(this.onDetachBound);
    } catch {
      // 同上
    }
  }

  private async doAttach(tabId: number, options: CdpAttachOptions): Promise<CdpTabState> {
    const api = this.requiredApi();
    try {
      await this.withTimeout(
        api.attach({ tabId }, ATTACH_VERSION),
        options.timeoutMs ?? this.attachTimeoutMs,
        'chrome.debugger.attach',
      );
    } catch (error) {
      throw normalizeCdpError(error, { tabId, method: 'chrome.debugger.attach', phase: 'attach' });
    }
    if (this.disposed) {
      // 挂载过程中被 dispose：立刻回收，避免泄漏一个会话。
      try {
        await api.detach({ tabId });
      } catch {
        // 忽略
      }
      throw new CdpError('E_CDP_UNAVAILABLE', 'CDP 客户端已释放', { tabId, phase: 'attach' });
    }
    const state: CdpTabState = {
      tabId,
      attachedAt: this.now(),
      lastActivity: this.now(),
      features: new Set(),
      sessions: new Map(),
      autoAttach: false,
    };
    this.states.set(tabId, state);
    this.touch(tabId);
    return state;
  }

  private async rawSend<T>(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    options: CdpSendOptions,
  ): Promise<T> {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id < 0) {
      throw new CdpError('E_CDP_COMMAND', 'CDP 命令需要非负整数 tabId：' + String(tabId), { method });
    }
    if (!this.states.has(id)) await this.attach(id);
    const api = this.requiredApi();
    const target = options.sessionId ? { tabId: id, sessionId: options.sessionId } : { tabId: id };
    this.touch(id);
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(api.sendCommand(target, method, params));
    } catch (error) {
      // sendCommand 同步抛错（个别 polyfill 实现）也要归一。
      pending = Promise.reject(error);
    }
    try {
      return await this.withTimeout(pending, options.timeoutMs ?? this.defaultTimeoutMs, method) as T;
    } catch (error) {
      throw normalizeCdpError(error, {
        tabId: id,
        method,
        phase: 'send',
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      });
    }
  }

  private requiredApi(): ChromeDebuggerApi {
    const api = this.api();
    if (!api) {
      throw new CdpError('E_CDP_UNAVAILABLE', '当前运行时没有 chrome.debugger（MV3 权限缺失或浏览器不支持）', {
        phase: 'attach',
      });
    }
    return api;
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new CdpError('E_CDP_UNAVAILABLE', 'CDP 客户端已释放', {});
    }
    if (!this.api()) {
      throw new CdpError('E_CDP_UNAVAILABLE', '当前运行时没有 chrome.debugger（MV3 权限缺失或浏览器不支持）', {});
    }
  }

  private touch(tabId: number): void {
    const id = Number(tabId);
    const state = this.states.get(id);
    if (!state) return;
    state.lastActivity = this.now();
    this.scheduleIdleDetach(id);
  }

  private scheduleIdleDetach(tabId: number): void {
    if (this.idleDetachMs <= 0) return;
    const id = Number(tabId);
    this.clearIdleTimer(id);
    if (!this.states.has(id)) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(id);
      void this.idleDetachIfIdle(id);
    }, this.idleDetachMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.idleTimers.set(id, timer);
  }

  private async idleDetachIfIdle(tabId: number): Promise<void> {
    const state = this.states.get(tabId);
    if (!state) return;
    if (state.features.size > 0) {
      this.scheduleIdleDetach(tabId);
      return;
    }
    if (this.now() - state.lastActivity < this.idleDetachMs) {
      this.scheduleIdleDetach(tabId);
      return;
    }
    await this.detach(tabId).catch(() => false);
  }

  private clearIdleTimer(tabId: number): void {
    const timer = this.idleTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(tabId);
  }

  /** 丢掉本地状态（不调用 chrome.debugger.detach：浏览器侧已分离）。 */
  private forgetState(tabId: number): void {
    this.clearIdleTimer(tabId);
    this.states.delete(tabId);
  }

  private handleEvent(source: CdpEventSource, method: string, params: Record<string, unknown>): void {
    const tabId = Number(source?.tabId);
    if (Number.isInteger(tabId)) {
      const state = this.states.get(tabId);
      if (state) {
        if (method === 'Target.attachedToTarget') this.registerChildSession(state, source, params);
        else if (method === 'Target.detachedFromTarget') this.unregisterChildSession(state, params);
      }
      const set = this.handlers.get(tabId)?.get(method);
      if (set) {
        for (const handler of [...set]) {
          try {
            handler(params, source);
          } catch {
            // 事件处理器异常不影响 CDP 会话
          }
        }
      }
    }
  }

  private registerChildSession(state: CdpTabState, source: CdpEventSource, params: Record<string, unknown>): void {
    const sessionId = typeof params['sessionId'] === 'string' ? String(params['sessionId']) : '';
    if (!sessionId || state.sessions.has(sessionId)) return;
    const info = isRecord(params['targetInfo']) ? params['targetInfo'] : {};
    const type = String(info['type'] ?? '');
    // 只关心 iframe/OOPIF（filter 已限制，这里再兜一层）。
    if (type && type !== 'iframe') return;
    state.sessions.set(sessionId, {
      sessionId,
      targetId: String(info['targetId'] ?? ''),
      type,
      url: String(info['url'] ?? ''),
      parentSessionId: source?.sessionId ? String(source.sessionId) : null,
      attachedAt: this.now(),
    });
    if (state.autoAttach) {
      // 递归开启，保证嵌套 OOPIF 也被发现（JS frame-cdp.js 同做法）。
      void this.send(state.tabId, 'Target.setAutoAttach', AUTO_ATTACH_PARAMS, {
        sessionId,
        timeoutMs: this.defaultTimeoutMs,
      }).catch(() => {});
    }
  }

  private unregisterChildSession(state: CdpTabState, params: Record<string, unknown>): void {
    const sessionId = typeof params['sessionId'] === 'string' ? String(params['sessionId']) : '';
    if (!sessionId) return;
    state.sessions.delete(sessionId);
    for (const [childId, child] of [...state.sessions]) {
      if (child.parentSessionId === sessionId) state.sessions.delete(childId);
    }
  }

  private handleDetach(source: CdpEventSource, reason: string): void {
    const tabId = Number(source?.tabId);
    if (!Number.isInteger(tabId)) return;
    this.clearIdleTimer(tabId);
    // session 表随 state 一起丢弃，重挂后由 ensureAutoAttach 重建。
    this.states.delete(tabId);
    const listeners = this.detachListeners.get(tabId);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener(String(reason ?? ''));
        } catch {
          // 监听器异常不影响清理
        }
      }
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, method: string): Promise<T> {
    const ms = Number(timeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new CdpError('E_CDP_TIMEOUT', 'CDP 命令超时（' + method + '，' + String(ms) + 'ms）', {
          method,
          data: { timeoutMs: ms },
        }));
      }, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

/** 便捷工厂。 */
export function createCdpClient(options: CdpClientOptions = {}): CdpClient {
  return new CdpClient(options);
}
