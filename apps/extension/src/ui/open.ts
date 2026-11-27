// src/ui/open.ts —— `ui.open`：把扩展子页面当普通标签页打开。
//
// 语义（与 daemon/CLI 的 `bridge ui --page <name> [--query k=v]` 对齐）：
// - 页面清单来自 `catalog.ts`；未知页名明确 `E_BAD_ARG`（不做"随便拼路径"的兜底）；
// - 用 `chrome.tabs.create({ url, active })` 打开扩展页（不是 window.open，避免弹窗被拦）；
// - `query` 既能接受字符串 `selftest=1`，也能接受对象 `{selftest:'1'}`；
// - 返回 `{ok, tabId, url, page, title, available, requires}`，CLI 只打印 tabId/url。
//
// 注意：扩展页面**没有内容脚本**（content script 的 matches 只覆盖 http/https 等），
// 因此页面自身的功能必须走 `bb.ui` 运行时消息（见 messages.ts），不能依赖页面上的
// content-script 桥。

import { findUiPage, normalizeUiPageName, type UiPageDefinition } from './catalog.ts';
import { agentOwnedTabs, type AgentOwnedTabRegistry } from '../runtime/tab-ownership.ts';

export interface UiTabLike {
  id?: number | null;
  windowId?: number | null;
  url?: string | null;
  title?: string | null;
  active?: boolean | null;
}

export interface UiTabsApi {
  tabs: {
    create(props: Record<string, unknown>): Promise<UiTabLike>;
    get(tabId: number): Promise<UiTabLike>;
    update(tabId: number, props: Record<string, unknown>): Promise<unknown>;
    query(queryInfo: Record<string, unknown>): Promise<UiTabLike[]>;
  };
}

export interface UiPageServiceOptions {
  api: UiTabsApi;
  /** `browser.runtime.getURL`（Node 单测注入纯函数）。 */
  resolveUrl: (path: string) => string;
  /** 打开后是否激活（默认 true：设置/长截图页需要在前台）。 */
  activateByDefault?: boolean;
  /** Agent 自建 tab 归属表（默认进程内单例；follow/rebind 借用判定用）。 */
  agentTabs?: AgentOwnedTabRegistry;
  now?: () => number;
}

export interface UiOpenResult {
  ok: true;
  tabId: number | null;
  url: string;
  page: string;
  title: string;
  available: boolean;
  requires: string[];
  windowId: number | null;
  openedAt: number;
}

export class UiPageError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'UiPageError';
    this.code = code;
    this.data = data;
  }

  toPayload(): { code: string; message: string; data?: unknown } {
    return this.data === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, data: this.data };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** query 归一：字符串原样去 `?`；对象按 k=v 编码；非法项忽略。 */
export function normalizeUiQuery(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw.replace(/^\?/, '').trim();
  if (!isRecord(raw)) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

/** 页面 URL = runtime.getURL(path) + 可选 query。 */
export function buildUiPageUrl(page: UiPageDefinition, query: unknown, resolveUrl: (path: string) => string): string {
  const base = resolveUrl(page.path);
  const search = normalizeUiQuery(query);
  if (!search) return base;
  return base + (base.includes('?') ? '&' : '?') + search;
}

/**
 * 子页面打开服务。
 *
 * ```ts
 * const service = new UiPageService({ api: browser, resolveUrl: (p) => browser.runtime.getURL(p) });
 * const opened = await service.open({ page: 'longshot', query: { tab: 12 } });
 * ```
 */
export class UiPageService {
  private readonly api: UiTabsApi;
  private readonly resolveUrl: (path: string) => string;
  private readonly activateByDefault: boolean;
  private readonly agentTabs: AgentOwnedTabRegistry;
  private readonly now: () => number;

  constructor(options: UiPageServiceOptions) {
    if (!options || !options.api || !options.api.tabs) throw new TypeError('UiPageService 需要 tabs API');
    if (typeof options.resolveUrl !== 'function') throw new TypeError('UiPageService 需要 resolveUrl（runtime.getURL）');
    this.api = options.api;
    this.resolveUrl = options.resolveUrl;
    this.activateByDefault = options.activateByDefault !== false;
    this.agentTabs = options.agentTabs ?? agentOwnedTabs;
    this.now = options.now ?? Date.now;
  }

  /** 打开一个子页面；未知页名抛 UiPageError(E_BAD_ARG)。 */
  async open(rawParams: unknown): Promise<UiOpenResult> {
    const params = isRecord(rawParams) ? rawParams : {};
    const requested = params.page === undefined || params.page === null || params.page === ''
      ? 'popup'
      : params.page;
    const page = findUiPage(requested);
    if (!page) {
      throw new UiPageError('E_BAD_ARG', '未知的扩展页面：' + String(requested), {
        page: String(requested ?? ''),
        available: normalizeUiPageName(requested) || null,
      });
    }
    const url = buildUiPageUrl(page, params.query, this.resolveUrl);
    const active = params.active === false ? false : this.activateByDefault;
    let created: UiTabLike;
    try {
      created = await this.api.tabs.create({ url, active });
    } catch (error) {
      throw new UiPageError('E_NAV_FAIL', '打开扩展页面失败：' + (error instanceof Error ? error.message : String(error)), {
        page: page.name,
        url,
      });
    }
    let tab: UiTabLike = created;
    const tabId = Number.isInteger(Number(created?.id)) ? Number(created.id) : null;
    // 扩展 UI 页是 Agent 的控制面（不是用户标签页）：登记归属后，`session start/rebind
    // --tab <uiTab>` 不会被“Agent 窗口标签页不可借用”误挡（follow/rebind 语义）。
    if (tabId !== null) this.agentTabs.mark(tabId, 'extension-ui');
    if (tabId !== null) {
      // 少数浏览器在 create 回包里不给 title；补读一次（页面 title 由页面脚本设置）。
      try {
        tab = { ...created, ...(await this.api.tabs.get(tabId)) };
      } catch {
        tab = created;
      }
    }
    return {
      ok: true,
      tabId,
      url: String(tab?.url ?? created?.url ?? url),
      page: page.name,
      title: String(tab?.title ?? page.title),
      available: page.available,
      requires: [...page.requires],
      windowId: Number.isInteger(Number(tab?.windowId)) ? Number(tab.windowId) : null,
      openedAt: this.now(),
    };
  }

  /** 列出目标标签页（子页面的目标选择器用；排除扩展页与浏览器内部页）。 */
  async targetTabs(): Promise<Array<{ tabId: number; url: string; title: string; windowId: number | null; active: boolean }>> {
    const selfPrefix = this.resolveUrl('');
    let tabs: UiTabLike[] = [];
    try {
      tabs = await this.api.tabs.query({});
    } catch {
      return [];
    }
    const result: Array<{ tabId: number; url: string; title: string; windowId: number | null; active: boolean }> = [];
    for (const tab of tabs) {
      const id = Number(tab.id);
      const url = String(tab.url ?? '');
      if (!Number.isInteger(id) || id <= 0) continue;
      if (!url) continue;
      if (selfPrefix && url.startsWith(selfPrefix)) continue;
      if (/^(chrome|edge|about|devtools|view-source|brave):/i.test(url)) continue;
      result.push({
        tabId: id,
        url,
        title: String(tab.title ?? ''),
        windowId: Number.isInteger(Number(tab.windowId)) ? Number(tab.windowId) : null,
        active: tab.active === true,
      });
    }
    // 最近活跃的在前：优先当前活动标签页，其次按 id 倒序（一般新的 id 更大）。
    result.sort((a, b) => (Number(b.active) - Number(a.active)) || (b.tabId - a.tabId));
    return result;
  }
}
