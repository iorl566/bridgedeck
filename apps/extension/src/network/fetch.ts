// src/network/fetch.ts —— CDP Fetch 域：规则真正拦截请求（M-C 第六批 wave 2）。
//
// 解决什么：DNR 只能 block/redirect；`fulfill`（伪造响应）与 `modify`（请求改写）
// 必须走 CDP Fetch 的 `Fetch.requestPaused` → fulfillRequest/continueRequest/failRequest。
//
// 设计边界：
// - 通道复用 `src/cdp/**`（注入 `CdpChannel`；acquire 完成 attach，不重复造）；
// - 本模块只做匹配与派发，不持有规则列表：规则来源由 `resolveRules` 回调提供
//   （RuleService 提供），命中计数通过 `onHit` 回写，避免两份规则状态；
// - 出错一律「继续请求」兜底：拦截失败不能让页面卡死；
// - `probe()` 是 20w 的诊断面：只统计 requestPaused 是否派发及 URL，然后继续请求。

import type { CdpChannel } from '../debug/cdp-channel.ts';
import { base64EncodeUtf8, headerArray, wildcardRegExp } from '../debug/cdp-channel.ts';

export type FetchRuleAction = 'fulfill' | 'block' | 'modify' | 'abort';

/** 命中拦截所需的最小规则形状（RuleRecord 的结构子集）。 */
export interface FetchRuleSpec {
  id: number | string;
  action: FetchRuleAction | string;
  urlPattern: string;
  enabled?: boolean;
  status?: number;
  headers?: Record<string, unknown> | null;
  body?: string | null;
  /** modify：改写后的 URL（http/https）。 */
  url?: string | null;
  /** modify：改写后的方法。 */
  method?: string | null;
  priority?: number;
}

export interface FetchRuleMatch {
  rule: FetchRuleSpec;
  matcher: RegExp;
}

export interface FetchControllerOptions {
  client: CdpChannel;
  /** 当前规则快照（RuleService 注入；返回空数组即无规则）。 */
  resolveRules?: (tabId: number) => FetchRuleSpec[];
  /** 命中回写（hits/诊断）。 */
  onHit?: (tabId: number, ruleId: number | string) => void;
  /** 命中或改写失败时的诊断回调。 */
  onError?: (tabId: number, error: string) => void;
  now?: () => number;
  /** 请求 URL 诊断缓存上限（probe 用）。 */
  maxUrls?: number;
  /** 事件/命令的超时（默认沿用 CdpClient 默认值）。 */
  timeoutMs?: number;
}

export interface FetchTabStats {
  tabId: number;
  enabled: boolean;
  paused: number;
  matched: number;
  fulfilled: number;
  blocked: number;
  modified: number;
  continued: number;
  errors: number;
  urls: string[];
  lastError: string | null;
}

/** 默认的 Fetch 拦截图案：所有请求、请求阶段（与 JS 兼容目标一致）。 */
export const DEFAULT_FETCH_PATTERNS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  Object.freeze({ urlPattern: '*', requestStage: 'Request' }),
]);

const MAX_URLS_DEFAULT = 20;

interface FetchTabState {
  tabId: number;
  feature: string;
  offEvent: (() => void) | null;
  stats: FetchTabStats;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

/** 该 action 是否需要 Fetch 域介入（block 有 DNR 时也可由 DNR 处理）。 */
export function actionNeedsFetch(action: unknown): boolean {
  return action === 'fulfill' || action === 'modify';
}

/**
 * Fetch 域控制器（一个实例管所有 tab）。
 *
 * ```ts
 * const fetch = new FetchController({ client, resolveRules: () => ruleService.rulesForFetch() });
 * await fetch.sync(tabId);           // 有 fulfill/modify 规则 → enable；没有 → disable
 * const probe = await fetch.probe(tabId, { ms: 1500 });
 * await fetch.dispose();
 * ```
 */
export class FetchController {
  private readonly client: CdpChannel;
  private readonly resolveRules: (tabId: number) => FetchRuleSpec[];
  private readonly onHit: ((tabId: number, ruleId: number | string) => void) | null;
  private readonly onError: ((tabId: number, error: string) => void) | null;
  private readonly now: () => number;
  private readonly maxUrls: number;
  private readonly timeoutMs: number | undefined;
  private readonly states = new Map<number, FetchTabState>();
  private matcherCache = new WeakMap<FetchRuleSpec, { pattern: string; matcher: RegExp }>();
  private disposed = false;

  constructor(options: FetchControllerOptions) {
    if (!options || !options.client) throw new TypeError('FetchController 需要 CdpChannel');
    this.client = options.client;
    this.resolveRules = options.resolveRules ?? (() => []);
    this.onHit = options.onHit ?? null;
    this.onError = options.onError ?? null;
    this.now = options.now ?? Date.now;
    this.maxUrls = Number.isFinite(Number(options.maxUrls)) && Number(options.maxUrls) > 0
      ? Math.floor(Number(options.maxUrls))
      : MAX_URLS_DEFAULT;
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : undefined;
  }

  available(): boolean {
    return !this.disposed;
  }

  isEnabled(tabId: number): boolean {
    return this.states.has(Number(tabId));
  }

  enabledTabs(): number[] {
    return [...this.states.keys()];
  }

  /** 命中的规则（enabled、URL 匹配、priority 高者优先；同优先级取先登记的）。 */
  match(tabId: number, url: string): FetchRuleMatch | null {
    const rules = this.resolveRules(Number(tabId));
    let best: FetchRuleMatch | null = null;
    let bestPriority = -Infinity;
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      if (!actionNeedsFetch(rule.action) && rule.action !== 'block' && rule.action !== 'abort') continue;
      const matcher = this.matcherOf(rule);
      if (!matcher.test(url)) continue;
      const priority = Number.isFinite(Number(rule.priority)) ? Number(rule.priority) : 1;
      if (!best || priority > bestPriority) {
        best = { rule, matcher };
        bestPriority = priority;
      }
    }
    return best;
  }

  private matcherOf(rule: FetchRuleSpec): RegExp {
    const cached = this.matcherCache.get(rule);
    if (cached && cached.pattern === rule.urlPattern) return cached.matcher;
    const matcher = wildcardRegExp(rule.urlPattern);
    this.matcherCache.set(rule, { pattern: rule.urlPattern, matcher });
    return matcher;
  }

  /** 是否需要为当前规则启用 Fetch（只针对 fulfill/modify）。 */
  needsFetch(tabId: number): boolean {
    const rules = this.resolveRules(Number(tabId));
    return rules.some((rule) => rule.enabled !== false && actionNeedsFetch(rule.action));
  }

  /** 按当前规则同步：需要 → enable；不再需要 → disable。返回是否处于启用态。 */
  async sync(tabId: number, options: { feature?: string } = {}): Promise<boolean> {
    const id = Number(tabId);
    if (!this.needsFetch(id)) {
      await this.disable(id);
      return false;
    }
    await this.enable(id, options);
    return true;
  }

  /** 启用 Fetch（幂等）。事件监听与命令一次完成。 */
  async enable(tabId: number, options: { feature?: string } = {}): Promise<void> {
    this.assertUsable();
    const id = Number(tabId);
    if (this.states.has(id)) return;
    const feature = String(options.feature || 'fetch-rules');
    const state: FetchTabState = {
      tabId: id,
      feature,
      offEvent: null,
      stats: {
        tabId: id,
        enabled: false,
        paused: 0,
        matched: 0,
        fulfilled: 0,
        blocked: 0,
        modified: 0,
        continued: 0,
        errors: 0,
        urls: [],
        lastError: null,
      },
    };
    await this.client.acquire(id, feature);
    state.offEvent = this.client.onEvent(id, 'Fetch.requestPaused', (params) => {
      void this.handlePaused(id, params);
    });
    try {
      await this.client.send(id, 'Fetch.enable', { patterns: DEFAULT_FETCH_PATTERNS.map((item) => ({ ...item })) }, this.sendOptions());
    } catch (error) {
      const off = state.offEvent;
      state.offEvent = null;
      try {
        off?.();
      } catch {
        // 忽略退订失败
      }
      this.client.release(id, feature);
      throw error;
    }
    state.stats.enabled = true;
    this.states.set(id, state);
  }

  /** 关闭 Fetch（幂等；保留统计到 statsOf 便于诊断）。 */
  async disable(tabId: number): Promise<boolean> {
    const id = Number(tabId);
    const state = this.states.get(id);
    if (!state) return false;
    this.states.delete(id);
    state.stats.enabled = false;
    try {
      state.offEvent?.();
    } catch {
      // 忽略
    }
    state.offEvent = null;
    await this.client.send(id, 'Fetch.disable', {}, this.sendOptions()).catch(() => undefined);
    this.client.release(id, state.feature);
    return true;
  }

  /** tab 关闭/会话回收：尽力关闭，不抛错。 */
  async forgetTab(tabId: number): Promise<void> {
    await this.disable(tabId).catch(() => false);
    this.states.delete(Number(tabId));
  }

  /** 释放所有 tab（teardown）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(this.enabledTabs().map((id) => this.disable(id).catch(() => false)));
    this.states.clear();
  }

  /** 统计快照（diagnostics / debug.coverage 用）。 */
  statsOf(tabId: number): FetchTabStats {
    const state = this.states.get(Number(tabId));
    if (state) return { ...state.stats, urls: [...state.stats.urls] };
    return {
      tabId: Number(tabId),
      enabled: false,
      paused: 0,
      matched: 0,
      fulfilled: 0,
      blocked: 0,
      modified: 0,
      continued: 0,
      errors: 0,
      urls: [],
      lastError: null,
    };
  }

  /**
   * 诊断：窗口期内 Fetch.requestPaused 派发次数与 URL（20w）。
   * 若 Fetch 已由规则启用，直接读现有统计增量；否则临时启用并自行继续请求。
   */
  async probe(tabId: number, options: { ms?: number } = {}): Promise<Record<string, unknown>> {
    this.assertUsable();
    const id = Number(tabId);
    const windowMs = Math.min(Math.max(Number(options.ms) || 1500, 200), 10_000);
    const existing = this.states.get(id);
    if (existing) {
      const before = existing.stats.paused;
      const beforeUrls = new Set(existing.stats.urls);
      await this.sleep(windowMs);
      const after = this.states.get(id)?.stats;
      const urls = (after?.urls ?? []).filter((url) => !beforeUrls.has(url));
      return {
        ok: true,
        paused: (after?.paused ?? before) - before,
        urls: [...new Set(urls)],
        windowMs,
        reused: true,
        error: after?.lastError ?? null,
      };
    }
    let paused = 0;
    const urls: string[] = [];
    let enableError: string | null = null;
    let offEvent: (() => void) | null = null;
    await this.client.acquire(id, 'fetch-probe');
    try {
      offEvent = this.client.onEvent(id, 'Fetch.requestPaused', (params) => {
        paused += 1;
        const request = params['request'] && typeof params['request'] === 'object'
          ? params['request'] as Record<string, unknown>
          : {};
        const url = String(request['url'] ?? '');
        if (url && urls.length < this.maxUrls && !urls.includes(url)) urls.push(url);
        const requestId = String(params['requestId'] ?? '');
        if (requestId) {
          void this.client.send(id, 'Fetch.continueRequest', { requestId }, this.sendOptions()).catch(() => undefined);
        }
      });
      await this.client.send(id, 'Fetch.enable', { patterns: DEFAULT_FETCH_PATTERNS.map((item) => ({ ...item })) }, this.sendOptions());
      await this.sleep(windowMs);
    } catch (error) {
      enableError = errorText(error);
    } finally {
      try {
        offEvent?.();
      } catch {
        // 忽略
      }
      await this.client.send(id, 'Fetch.disable', {}, this.sendOptions()).catch(() => undefined);
      this.client.release(id, 'fetch-probe');
    }
    return { ok: enableError === null, paused, urls, windowMs, reused: false, error: enableError };
  }

  // ------------------------------------------------------------------ 内部

  private async handlePaused(tabId: number, params: Record<string, unknown>): Promise<void> {
    const state = this.states.get(tabId);
    if (!state) return;
    const request = params['request'] && typeof params['request'] === 'object'
      ? params['request'] as Record<string, unknown>
      : {};
    const url = String(request['url'] ?? '');
    const requestId = String(params['requestId'] ?? '');
    if (!requestId) return;
    state.stats.paused += 1;
    if (url && state.stats.urls.length < this.maxUrls && !state.stats.urls.includes(url)) state.stats.urls.push(url);
    let match: FetchRuleMatch | null = null;
    try {
      match = this.match(tabId, url);
    } catch (error) {
      this.recordError(tabId, error);
    }
    if (!match) {
      await this.continueRequest(tabId, requestId);
      return;
    }
    state.stats.matched += 1;
    try {
      this.onHit?.(tabId, match.rule.id);
    } catch {
      // 计数回调异常不影响拦截
    }
    const action = String(match.rule.action);
    try {
      if (action === 'fulfill') {
        await this.client.send(tabId, 'Fetch.fulfillRequest', {
          requestId,
          responseCode: Number.isFinite(Number(match.rule.status)) && Number(match.rule.status) > 0
            ? Math.floor(Number(match.rule.status))
            : 200,
          responseHeaders: headerArray(match.rule.headers),
          body: base64EncodeUtf8(match.rule.body ?? ''),
        }, this.sendOptions());
        state.stats.fulfilled += 1;
        return;
      }
      if (action === 'block' || action === 'abort') {
        // 与 DNR block 的页面可观测结果一致：请求失败（fetch reject → 页面 error 分支）。
        await this.client.send(tabId, 'Fetch.failRequest', { requestId, errorReason: 'Aborted' }, this.sendOptions());
        state.stats.blocked += 1;
        return;
      }
      // modify：改写 URL/方法/头/正文，然后放行到真实网络。
      const overrides: Record<string, unknown> = { requestId };
      const targetUrl = typeof match.rule.url === 'string' ? match.rule.url : '';
      if (targetUrl) overrides['url'] = targetUrl;
      const targetMethod = typeof match.rule.method === 'string' ? match.rule.method.toUpperCase() : '';
      if (targetMethod) overrides['method'] = targetMethod;
      const headers = headerArray(match.rule.headers);
      if (headers.length) overrides['headers'] = headers;
      if (typeof match.rule.body === 'string') overrides['postData'] = base64EncodeUtf8(match.rule.body);
      await this.client.send(tabId, 'Fetch.continueRequest', overrides, this.sendOptions());
      state.stats.modified += 1;
    } catch (error) {
      this.recordError(tabId, error);
      // 兜底：任何拦截失败都不能让请求一直挂着。
      await this.continueRequest(tabId, requestId);
    }
  }

  private async continueRequest(tabId: number, requestId: string): Promise<void> {
    try {
      await this.client.send(tabId, 'Fetch.continueRequest', { requestId }, this.sendOptions());
      const state = this.states.get(tabId);
      if (state) state.stats.continued += 1;
    } catch (error) {
      this.recordError(tabId, error);
    }
  }

  private recordError(tabId: number, error: unknown): void {
    const message = errorText(error);
    const state = this.states.get(tabId);
    if (state) {
      state.stats.errors += 1;
      state.stats.lastError = message;
    }
    try {
      this.onError?.(tabId, message);
    } catch {
      // 诊断回调异常不影响主流程
    }
  }

  private sendOptions(): { timeoutMs?: number } | undefined {
    return this.timeoutMs === undefined ? undefined : { timeoutMs: this.timeoutMs };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('FetchController 已释放');
  }
}

/** 便捷工厂。 */
export function createFetchController(options: FetchControllerOptions): FetchController {
  return new FetchController(options);
}
