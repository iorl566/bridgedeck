// src/runtime/commands.ts —— 实例/标签页/导航/设置类命令处理器（非页面动作面）。
//
// 这些命令不是本批的四个核心动作，但 session.start → navigate → status 这条链路
// 全靠它们：daemon 的 session.start 先发 `window.newAgent`，navigate 发 `navigate`，
// session.stop 发 `tab.close`/`window.close`，`bridge settings` 发 `settings.get`。
// 不实现它们，E2E 的第 2/3/4 项（浏览器连上 / session start / navigate）就无从谈起。
//
// 设计：全部依赖注入（BrowserApiLike + 时钟），因此不需要真实浏览器即可单测；
// 生产入口 background 把 WXT 的 browser 对象传进来。
// 明确标注“未迁移”的命令（dialog.*/control-hint/tab.borrow/tab.return）返回
// E_NOT_IMPLEMENTED 并说明原因（无 chrome.debugger / 无浮层 UI），不静默成功。

import { RpcMethodError } from '../rpc/registry.ts';
import { SettingsStore, daemonSettingsView, humanOnlyKeysIn } from './settings.ts';
import type { TabActivityRegistry, TabPolicyStore } from './tab-state.ts';
import {
  agentOwnedTabs,
  decideAgentWindowBorrow,
  isOpenedFromAgentWindow,
  type AgentOwnedTabRegistry,
} from './tab-ownership.ts';
import type { CommandHandler, RegisteredCommand } from './router.ts';

// ---------------------------------------------------------------------------
// 浏览器 API 的最小形状（真实 browser 对象结构兼容；测试用假实现）
// ---------------------------------------------------------------------------

export interface BrowserTabLike {
  id?: number | null;
  windowId?: number | null;
  url?: string | null;
  pendingUrl?: string | null;
  title?: string | null;
  active?: boolean | null;
  status?: string | null;
  incognito?: boolean | null;
  groupId?: number | null;
  /** 打开该 tab 的页面 tab（chrome.tabs.Tab.openerTabId；页面 target=_blank 时存在）。 */
  openerTabId?: number | null;
  /** 窗口内序号（rebind 回包字段用）。 */
  index?: number | null;
}

export interface BrowserWindowLike {
  id?: number | null;
  focused?: boolean | null;
  incognito?: boolean | null;
  type?: string | null;
  tabs?: BrowserTabLike[] | null;
}

export interface BrowserTabGroupLike {
  id?: number | null;
  title?: string | null;
  color?: string | null;
  collapsed?: boolean | null;
}

export type TabUpdatedListener = (tabId: number, info: { status?: string; url?: string }, tab?: BrowserTabLike) => void;
export type TabCreatedListener = (tab: BrowserTabLike) => void;
export type TabRemovedListener = (tabId: number) => void;

export interface TabsLike {
  get(tabId: number): Promise<BrowserTabLike>;
  query(queryInfo: Record<string, unknown>): Promise<BrowserTabLike[]>;
  update(tabId: number, props: Record<string, unknown>): Promise<BrowserTabLike>;
  create(props: Record<string, unknown>): Promise<BrowserTabLike>;
  remove(tabId: number): Promise<void>;
  reload(tabId: number, props?: Record<string, unknown>): Promise<void>;
  move?(tabId: number, props: Record<string, unknown>): Promise<BrowserTabLike>;
  /** tab group（chrome.tabs.group(options)；不支持时可缺省，tab.new --group 会明确报错）。 */
  group?(options: Record<string, unknown>): Promise<number>;
  ungroup?(tabIds: number[]): Promise<void>;
  onUpdated: {
    addListener(listener: TabUpdatedListener): void;
    removeListener(listener: TabUpdatedListener): void;
  };
  /** 页面在 Agent 窗口里开新 tab 时登记归属（follow/rebind 语义；可选事件）。 */
  onCreated?: {
    addListener(listener: TabCreatedListener): void;
    removeListener(listener: TabCreatedListener): void;
  };
  /** tab 关闭时清理归属登记（可选事件）。 */
  onRemoved?: {
    addListener(listener: TabRemovedListener): void;
    removeListener(listener: TabRemovedListener): void;
  };
}

/** tabGroups API（可选；用于把 groupId 解析成组标题）。 */
export interface TabGroupsLike {
  get(groupId: number): Promise<BrowserTabGroupLike>;
  update(groupId: number, props: Record<string, unknown>): Promise<BrowserTabGroupLike>;
}

export interface WindowsLike {
  getAll(info: Record<string, unknown>): Promise<BrowserWindowLike[]>;
  create(props: Record<string, unknown>): Promise<BrowserWindowLike>;
  get(windowId: number): Promise<BrowserWindowLike>;
  update(windowId: number, props: Record<string, unknown>): Promise<BrowserWindowLike>;
  remove(windowId: number): Promise<void>;
}

export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(key: string): Promise<void>;
}

export interface BrowserApiLike {
  tabs: TabsLike;
  windows: WindowsLike;
  tabGroups?: TabGroupsLike;
  storage: {
    local: StorageAreaLike;
    session?: StorageAreaLike;
  };
}

export interface RuntimeCommandsDeps {
  api: BrowserApiLike;
  /** 设置存储；缺省用 api.storage.local。 */
  settings?: SettingsStore;
  /** per-tab 策略（navigate allowedOrigins / tab.new keepOpen）。 */
  policies?: TabPolicyStore;
  /** 运行时创建的 tab 登记表（tab cleanup 候选集）。 */
  activity?: TabActivityRegistry;
  /** Agent 自建 tab 归属表（页面在 Agent 窗口开的新 tab / 扩展 UI 页；默认进程内单例）。 */
  ownedTabs?: AgentOwnedTabRegistry;
  now?: () => number;
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** navigate/reload 等待加载完成的超时；默认 20s（daemon 命令预算 60s 内）。 */
  loadTimeoutMs?: number;
  /** noFocus 时等新窗口 OS 创建完成后再补一次焦点还原的延迟；默认 250ms。 */
  focusRestoreDelayMs?: number;
}

// ---------------------------------------------------------------------------
// 页面 URL 策略（从 JS lib/page-policy.js 移植）
// ---------------------------------------------------------------------------

const RESTRICTED_PROTOCOLS: ReadonlySet<string> = new Set([
  'chrome:', 'edge:', 'devtools:', 'chrome-extension:', 'moz-extension:',
  'ms-browser-extension:', 'view-source:', 'javascript:',
]);

/**
 * 返回受限原因；空字符串表示允许。
 * 先剥离浏览器会忽略的 C0/换行，再按 URL 规范化后的 protocol 判定。
 */
export function restrictedUrlReason(url: unknown): string {
  const raw = String(url ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!raw) return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '无法解析的 URL';
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'about:') return parsed.pathname.toLowerCase() === 'blank' ? '' : 'about: 内部页面';
  if (RESTRICTED_PROTOCOLS.has(protocol)) return '浏览器内部或扩展页面';
  return '';
}

// ---------------------------------------------------------------------------
// Agent 窗口注册表（session 级窗口归属，用于 tab.list scope 与 window.close 清理）
// ---------------------------------------------------------------------------

const AGENT_WINDOWS_KEY = 'bb.agentWindows';

export class AgentWindowRegistry {
  private readonly storage: StorageAreaLike | null;
  private readonly ids = new Set<number>();
  private loaded = false;

  constructor(storage: StorageAreaLike | null | undefined) {
    this.storage = storage ?? null;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    try {
      const stored = await this.storage.get(AGENT_WINDOWS_KEY);
      const list = stored?.[AGENT_WINDOWS_KEY];
      if (Array.isArray(list)) {
        for (const item of list) {
          const id = Number(item);
          if (Number.isInteger(id) && id > 0) this.ids.add(id);
        }
      }
    } catch {
      // session storage 不可用时退化为进程内记忆
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      void this.storage.set({ [AGENT_WINDOWS_KEY]: [...this.ids] }).catch(() => undefined);
    } catch {
      // 忽略持久化失败
    }
  }

  async add(windowId: number): Promise<void> {
    await this.load();
    if (!Number.isInteger(windowId) || windowId <= 0) return;
    this.ids.add(windowId);
    this.persist();
  }

  async remove(windowId: number): Promise<void> {
    await this.load();
    if (this.ids.delete(Number(windowId))) this.persist();
  }

  async list(): Promise<number[]> {
    await this.load();
    return [...this.ids];
  }

  async has(windowId: number): Promise<boolean> {
    await this.load();
    return this.ids.has(Number(windowId));
  }
}

// ---------------------------------------------------------------------------
// 参数小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireInteger(params: Record<string, unknown>, key: string, min = 1): number {
  const value = Number(params[key]);
  if (!Number.isInteger(value) || value < min) {
    throw new RpcMethodError('E_BAD_ARG', key + ' 必须是 ≥' + String(min) + ' 的整数', { [key]: params[key] ?? null });
  }
  return value;
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new RpcMethodError('E_BAD_ARG', key + ' 必须是布尔值', { [key]: value });
  return value;
}

function tabShape(tab: BrowserTabLike): Record<string, unknown> {
  return {
    tabId: typeof tab?.id === 'number' ? tab.id : null,
    windowId: typeof tab?.windowId === 'number' ? tab.windowId : null,
    url: String(tab?.url ?? tab?.pendingUrl ?? ''),
    title: String(tab?.title ?? ''),
    active: tab?.active === true,
    status: tab?.status ?? null,
  };
}

// ---------------------------------------------------------------------------
// 处理器工厂
// ---------------------------------------------------------------------------

/**
 * 创建实例/标签页/导航/设置命令处理器。
 *
 * 返回的每一项都带 `serialized` 标记：navigate 与 tab/window 动作默认按 tabId 串行，
 * 读类（tab.list、window.list、settings.get）不排队。
 */
export function createRuntimeCommands(deps: RuntimeCommandsDeps): RegisteredCommand[] {
  const api = deps.api;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const loadTimeoutMs = Number(deps.loadTimeoutMs) > 0 ? Math.floor(Number(deps.loadTimeoutMs)) : 20_000;
  const focusRestoreDelayMs = Number(deps.focusRestoreDelayMs) > 0 ? Math.floor(Number(deps.focusRestoreDelayMs)) : 250;
  const settings = deps.settings ?? new SettingsStore(api.storage.local);
  const agentWindows = new AgentWindowRegistry(api.storage.session ?? api.storage.local);
  const policies = deps.policies ?? null;
  const activity = deps.activity ?? null;
  const ownedTabs = deps.ownedTabs ?? agentOwnedTabs;

  /** 把 tab 记录登记为“本运行时创建”（tab cleanup 只清这些）。 */
  function noteTab(tabId: number | null | undefined): void {
    if (activity && Number.isInteger(Number(tabId))) activity.record(Number(tabId));
  }

  /** tab 的 opener 是否落在 Agent 窗口内（页面打开的 target=_blank / window.open）。 */
  async function openerInAgentWindow(tab: BrowserTabLike, agentWindowIds: ReadonlySet<number>): Promise<boolean> {
    const openerId = Number(tab?.openerTabId);
    if (!Number.isInteger(openerId) || openerId <= 0) return false;
    if (openerId === Number(tab?.id)) return false;
    try {
      const opener = await api.tabs.get(openerId);
      return isOpenedFromAgentWindow(opener, agentWindowIds);
    } catch {
      return false;
    }
  }

  /** onCreated：页面在 Agent 窗口里开的新 tab 立即登记归属（JS pageGuard controlled 的 TS 等价）。 */
  try {
    api.tabs.onCreated?.addListener((tab) => {
      void (async () => {
        const id = Number(tab?.id);
        const openerId = Number(tab?.openerTabId);
        if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(openerId) || openerId <= 0) return;
        const agentIds = new Set(await agentWindows.list());
        if (!agentIds.has(Number(tab?.windowId))) return;
        try {
          const opener = await api.tabs.get(openerId);
          if (isOpenedFromAgentWindow(opener, agentIds)) ownedTabs.mark(id, 'page-opened');
        } catch {
          // opener 已关闭：不登记，tab.borrow 时按 agent-window 拒绝
        }
      })();
    });
  } catch {
    // 事件不可用（测试 fake / 旧浏览器）：tab.borrow 仍有 openerTabId 复核兜底
  }
  try {
    api.tabs.onRemoved?.addListener((tabId) => ownedTabs.drop(tabId));
  } catch {
    // 同上
  }

  /** 可注入的等待（测试里用同步 timer 立即 resolve）。 */
  function delayMs(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        setTimer(() => resolve(), ms);
      } catch {
        resolve();
      }
    });
  }

  /** 等 tab 加载完成；超时返回 null（与 JS navigate 一致：不把慢页面变失败）。 */
  function waitForLoad(tabId: number): Promise<BrowserTabLike | null> {
    return new Promise<BrowserTabLike | null>((resolve) => {
      let settled = false;
      let timer: unknown = null;
      const finish = (tab: BrowserTabLike | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimer(timer);
        try {
          api.tabs.onUpdated.removeListener(onUpdated);
        } catch {
          // 监听器可能已被移除
        }
        resolve(tab);
      };
      const onUpdated: TabUpdatedListener = (id, info, tab) => {
        if (id !== tabId) return;
        if (info?.status === 'complete') finish(tab ?? { id: tabId });
      };
      try {
        api.tabs.onUpdated.addListener(onUpdated);
      } catch {
        // 不支持事件时直接返回当前状态
        void api.tabs.get(tabId).then(finish, () => finish(null));
        return;
      }
      timer = setTimer(() => finish(null), loadTimeoutMs);
      void api.tabs.get(tabId).then((tab) => {
        if (tab && tab.status === 'complete') finish(tab);
      }, () => finish(null));
    });
  }

  function requireTab(params: Record<string, unknown>): number {
    return requireInteger(params, 'tabId', 1);
  }

  /** 当前前台窗口 id；取不到返回 null（浏览器刚启动时可能还没有 focused 窗口）。 */
  async function findFocusedWindowId(): Promise<number | null> {
    try {
      const windows = await api.windows.getAll({});
      const focused = (Array.isArray(windows) ? windows : []).find((win) => win?.focused === true);
      return focused && typeof focused.id === 'number' ? focused.id : null;
    } catch {
      return null;
    }
  }

  const commands: RegisteredCommand[] = [];

  function add(method: string, handler: CommandHandler, options: { serialized?: boolean; description?: string; timeoutMs?: number } = {}): void {
    commands.push({
      method,
      handler,
      serialized: options.serialized ?? true,
      timeoutMs: Number(options.timeoutMs) > 0 ? Math.floor(Number(options.timeoutMs)) : null,
      description: options.description ?? '',
    });
  }

  function notImplemented(method: string, reason: string): CommandHandler {
    return () => {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', 'TS 运行时尚未迁移 ' + method + '：' + reason, { method });
    };
  }

  // -- 窗口 -----------------------------------------------------------------

  async function newAgentWindow(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // 焦点策略与 JS 扩展 lib/focus-policy.js 一致：默认不抢焦点，只有显式 focus:true 才置前。
    // noFocus 是历史参数（现在默认就是后台），保留接受但不改变默认值。
    const focusRequested = optionalBoolean(params, 'focus') === true;
    const incognito = optionalBoolean(params, 'incognito') === true;
    const focused = focusRequested;
    // 浏览器刚启动时 windows.create({focused:false}) 仍可能被抢焦点（实测 Edge 158
    // 在启动后 ~1s 内创建窗口会把新窗口标成 focused）。noFocus 的语义是“不要打断用户”，
    // 所以创建后把焦点还给原来的前台窗口。
    const previousFocused = focusRequested ? null : await findFocusedWindowId();
    let created: BrowserWindowLike;
    try {
      created = await api.windows.create({ url: 'about:blank', type: 'normal', ...(incognito ? { incognito: true } : {}), focused });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (incognito && /incognito|inprivate/i.test(message)) {
        throw new RpcMethodError('E_INCOGNITO_UNAVAILABLE', '浏览器拒绝创建无痕窗口：' + message);
      }
      throw new RpcMethodError('E_BROWSER', '创建 Agent 窗口失败：' + message);
    }
    const windowId = typeof created?.id === 'number' ? created.id : null;
    if (windowId === null) {
      // 无痕窗口拿不到 id 的常见原因是扩展没有 InPrivate 权限（Chrome 会静默返回空窗对象）。
      if (incognito) {
        throw new RpcMethodError(
          'E_INCOGNITO_UNAVAILABLE',
          '扩展未获准在无痕/InPrivate 模式运行：请在扩展详情页打开「允许在 InPrivate 模式中运行」后重试',
        );
      }
      throw new RpcMethodError('E_INTERNAL', '浏览器没有返回 Agent 窗口 id');
    }
    if (previousFocused !== null && previousFocused !== windowId) {
      const restore = async (): Promise<void> => {
        try {
          await api.windows.update(previousFocused, { focused: true });
        } catch {
          // 原窗口已关闭：保持浏览器当前焦点即可
        }
      };
      // 立刻还一次，再等新窗口的 OS 窗口创建完成（Edge 会在那之后重新抢焦点）补一次。
      await restore();
      await delayMs(focusRestoreDelayMs);
      await restore();
    }
    await agentWindows.add(windowId);
    let tab = Array.isArray(created.tabs) && created.tabs[0] ? created.tabs[0] : null;
    if (!tab) {
      const tabs = await api.tabs.query({ windowId });
      tab = tabs[0] ?? null;
    }
    if (!tab || typeof tab.id !== 'number') throw new RpcMethodError('E_INTERNAL', 'Agent 窗口里没有标签页');
    noteTab(tab.id);
    return {
      ok: true,
      tabId: tab.id,
      windowId,
      url: String(tab.url ?? 'about:blank'),
      title: String(tab.title ?? ''),
      incognito: created.incognito === true || incognito,
    };
  }

  add('window.newAgent', (context) => newAgentWindow(context.params), {
    description: '新建独立 Agent 窗口（默认不抢焦点）',
    timeoutMs: 15_000,
  });

  add('window.ensureAgent', async (context) => {
    const windows = await agentWindows.list();
    const wanted = windows[windows.length - 1];
    if (Number.isInteger(wanted)) {
      try {
        const win = await api.windows.get(wanted as number);
        if (win && win.type === 'normal') {
          const tabs = await api.tabs.query({ windowId: wanted });
          if (tabs.length > 0) {
            const active = tabs.find((tab) => tab.active === true) ?? tabs[0];
            return {
              tabId: typeof active?.id === 'number' ? active.id : null,
              windowId: wanted,
              url: String(active?.url ?? ''),
              title: String(active?.title ?? ''),
            };
          }
        }
      } catch {
        await agentWindows.remove(wanted as number);
      }
    }
    return newAgentWindow(context.params);
  }, { description: '复用或新建 Agent 窗口', timeoutMs: 15_000 });

  add('window.list', async () => {
    const windows = await api.windows.getAll({ populate: true });
    return {
      windows: (Array.isArray(windows) ? windows : []).map((win) => ({
        windowId: typeof win?.id === 'number' ? win.id : null,
        focused: win?.focused === true,
        incognito: win?.incognito === true,
        type: win?.type ?? 'normal',
        tabs: (Array.isArray(win?.tabs) ? win.tabs : []).map((tab) => ({
          tabId: typeof tab?.id === 'number' ? tab.id : null,
          active: tab?.active === true,
          url: String(tab?.url ?? ''),
          title: String(tab?.title ?? ''),
        })),
      })),
    };
  }, { serialized: false, description: '列出全部窗口与标签页' });

  add('window.focus', async (context) => {
    const windowId = requireInteger(context.params, 'windowId', 1);
    try {
      await api.windows.update(windowId, { focused: true });
    } catch (error) {
      throw new RpcMethodError('E_NO_WINDOW', '聚焦 window ' + String(windowId) + ' 失败：' + (error instanceof Error ? error.message : String(error)));
    }
    return { ok: true, windowId };
  }, { description: '聚焦窗口' });

  add('window.close', async (context) => {
    const windowId = requireInteger(context.params, 'windowId', 1);
    try {
      await api.windows.remove(windowId);
    } catch (error) {
      throw new RpcMethodError('E_NO_WINDOW', '关闭 window ' + String(windowId) + ' 失败：' + (error instanceof Error ? error.message : String(error)));
    }
    await agentWindows.remove(windowId);
    return { ok: true, windowId };
  }, { description: '关闭窗口（会话结束时清理 Agent 窗口）' });

  // -- 标签页 ---------------------------------------------------------------

  add('tab.list', async (context) => {
    const scope = context.params.scope === 'user' ? 'user' : (context.params.scope === 'all' ? 'all' : 'agent');
    const agentIds = new Set(await agentWindows.list());
    const tabs = await api.tabs.query({});
    const filtered = (Array.isArray(tabs) ? tabs : []).filter((tab) => {
      const isAgent = agentIds.has(Number(tab.windowId));
      if (scope === 'all') return true;
      return scope === 'agent' ? isAgent : !isAgent;
    });
    const groupTitles = new Map<number, string>();
    const groups = api.tabGroups;
    if (groups) {
      for (const tab of filtered) {
        const groupId = Number(tab.groupId);
        if (!Number.isInteger(groupId) || groupId < 0 || groupTitles.has(groupId)) continue;
        try {
          const group = await groups.get(groupId);
          groupTitles.set(groupId, String(group?.title ?? ''));
        } catch {
          groupTitles.set(groupId, '');
        }
      }
    }
    const rows = [];
    for (const tab of filtered) {
      const policy = policies && Number.isInteger(Number(tab.id)) ? await policies.get(Number(tab.id)) : null;
      const groupId = Number.isInteger(Number(tab.groupId)) && Number(tab.groupId) >= 0 ? Number(tab.groupId) : null;
      rows.push({
        ...tabShape(tab),
        owned: agentIds.has(Number(tab.windowId)) ? 'agent' : 'user',
        groupId,
        group: groupId === null ? null : (groupTitles.get(groupId) ?? ''),
        keepOpen: policy?.keepOpen === true,
        readOnly: policy?.readOnly === true,
      });
    }
    return { tabs: rows };
  }, { serialized: false, description: '列出标签页（scope=agent|user|all），带 tab group/keepOpen/readOnly' });

  add('tab.new', async (context) => {
    const url = typeof context.params.url === 'string' && context.params.url.trim() ? String(context.params.url).trim() : 'about:blank';
    const blocked = restrictedUrlReason(url);
    if (blocked) throw new RpcMethodError('E_FORBIDDEN', '新建标签页目标受限（' + blocked + '）');
    // 焦点策略与 lib/focus-policy.js 一致：默认不抢焦点，只有显式 focus:true 才激活新标签页。
    const focusRequested = context.params.focus === true;
    void optionalBoolean(context.params, 'noFocus');
    const windowId = Number.isInteger(Number(context.params.windowId)) ? Number(context.params.windowId) : null;
    // --window：真的开一个浏览器窗口（与 JS 扩展 tabs.js 的 tabNew 同口径）。
    // daemon 会按会话预先把 params.windowId 填成会话窗口；这个分支必须忽略它，
    // 否则“新窗口”会退化成同窗口建 tab（E2E 20d5 的 window-switch 就没了）。
    const newWindow = context.params.newWindow === true;
    let tab: BrowserTabLike;
    if (newWindow) {
      // 默认后台开窗（不打断用户），行为对齐 window.newAgent 的焦点还原。
      const previousFocused = focusRequested ? null : await findFocusedWindowId();
      let created: BrowserWindowLike;
      try {
        created = await api.windows.create({ url, type: 'normal', focused: focusRequested });
      } catch (error) {
        throw new RpcMethodError('E_BROWSER', '新建窗口失败：' + (error instanceof Error ? error.message : String(error)));
      }
      const createdWindowId = typeof created?.id === 'number' ? created.id : null;
      const createdTab = Array.isArray(created?.tabs) && created.tabs[0] ? created.tabs[0] : null;
      if (!createdTab || typeof createdTab.id !== 'number') {
        throw new RpcMethodError('E_BROWSER', '新建窗口后没有标签页');
      }
      // chrome 偶尔不把 windowId 回填进 tab 对象：用窗口 id 兜底，后续 group/返回体才完整。
      tab = typeof createdTab.windowId === 'number' || createdWindowId === null
        ? createdTab
        : { ...createdTab, windowId: createdWindowId };
      if (previousFocused !== null && previousFocused !== createdWindowId) {
        const restore = async (): Promise<void> => {
          try {
            await api.windows.update(previousFocused, { focused: true });
          } catch {
            // 原窗口已关闭：保持浏览器当前焦点即可
          }
        };
        await restore();
        await delayMs(focusRestoreDelayMs);
        await restore();
      }
    } else {
      try {
        const props: Record<string, unknown> = { url, active: focusRequested };
        if (windowId !== null) props.windowId = windowId;
        tab = await api.tabs.create(props);
      } catch (error) {
        throw new RpcMethodError('E_BROWSER', '新建标签页失败：' + (error instanceof Error ? error.message : String(error)));
      }
    }
    const createdId = typeof tab?.id === 'number' ? tab.id : null;
    noteTab(createdId);
    // --group <name>：把新 tab 放进命名标签组（tabGroups 权限已在 manifest 里）。
    let groupId: number | null = null;
    const groupName = typeof context.params.group === 'string' && context.params.group.trim() ? context.params.group.trim() : '';
    if (groupName) {
      if (!createdId) throw new RpcMethodError('E_INTERNAL', '新建 tab 没有 id，无法加入标签组');
      if (typeof api.tabs.group !== 'function') {
        throw new RpcMethodError('E_NOT_IMPLEMENTED', '当前浏览器不支持 tabs.group（无法创建命名标签组）');
      }
      try {
        groupId = await api.tabs.group({
          tabIds: [createdId],
          ...(typeof tab.windowId === 'number' ? { createProperties: { windowId: tab.windowId } } : {}),
        });
        if (api.tabGroups && groupId !== null) {
          await api.tabGroups.update(groupId, { title: groupName });
        }
      } catch (error) {
        throw new RpcMethodError('E_BROWSER', '创建标签组失败：' + (error instanceof Error ? error.message : String(error)));
      }
    }
    // --keep-open / --alias：per-tab 策略与 alias 在创建时一并落库。
    if (policies && createdId) {
      if (context.params.keepOpen === true) await policies.patch(createdId, { keepOpen: true });
    }
    return {
      tabId: createdId,
      windowId: typeof tab?.windowId === 'number' ? tab.windowId : null,
      ...(newWindow ? { newWindow: true } : {}),
      ...(groupId !== null ? { groupId } : {}),
      ...(context.params.keepOpen === true ? { keepOpen: true } : {}),
    };
  }, { description: '新建标签页（默认不激活；--window 开新窗口；支持 --group 命名标签组 / --keep-open）' });

  add('tab.close', async (context) => {
    const tabId = requireTab(context.params);
    try {
      await api.tabs.remove(tabId);
    } catch (error) {
      throw new RpcMethodError('E_NO_TAB', '关闭 tab ' + String(tabId) + ' 失败：' + (error instanceof Error ? error.message : String(error)));
    }
    if (activity) activity.drop(tabId);
    ownedTabs.drop(tabId);
    return { ok: true, tabId };
  }, { serialized: false, description: '关闭标签页' });

  add('tab.select', async (context) => {
    const tabId = requireTab(context.params);
    let tab: BrowserTabLike;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      throw new RpcMethodError('E_NO_TAB', 'tabId ' + String(tabId) + ' 不存在或已关闭');
    }
    try {
      await api.tabs.update(tabId, { active: true });
      if (typeof tab.windowId === 'number') await api.windows.update(tab.windowId, { focused: true });
    } catch (error) {
      throw new RpcMethodError('E_BROWSER', '切换 tab ' + String(tabId) + ' 失败：' + (error instanceof Error ? error.message : String(error)));
    }
    return { ok: true, tabId };
  }, { description: '激活标签页并聚焦其窗口' });

  add('tab.move', async (context) => {
    const tabId = requireTab(context.params);
    const windowId = requireInteger(context.params, 'windowId', 1);
    if (typeof api.tabs.move !== 'function') {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', '当前浏览器不支持 tabs.move');
    }
    try {
      await api.tabs.move(tabId, { windowId, index: Number.isInteger(Number(context.params.index)) ? Number(context.params.index) : -1 });
    } catch (error) {
      throw new RpcMethodError('E_BROWSER', '移动 tab ' + String(tabId) + ' 失败：' + (error instanceof Error ? error.message : String(error)));
    }
    return { ok: true, tabId, windowId };
  }, { description: '跨窗口移动标签页' });

  add('tab.borrow', async (context) => {
    const tabId = Number(context.params.tabId);
    const agentOwnedBorrow = (tab: BrowserTabLike, ownership: string): Record<string, unknown> => ({
      tabId,
      windowId: Number(tab.windowId),
      originalWindowId: Number(tab.windowId),
      originalIndex: Number.isInteger(Number(tab.index)) ? Number(tab.index) : null,
      url: String(tab.url ?? ''),
      title: String(tab.title ?? ''),
      owned: 'agent',
      borrowed: false,
      ownership,
      note: 'Agent 自己打开的标签页（follow/rebind 语义）：直接改绑，不走借用流程',
    });
    if (Number.isInteger(tabId) && tabId > 0) {
      let tab: BrowserTabLike | null = null;
      try {
        tab = await api.tabs.get(tabId);
      } catch {
        tab = null;
      }
      if (tab) {
        const agentIds = new Set(await agentWindows.list());
        const inAgentWindow = agentIds.has(Number(tab.windowId));
        const ownedReason = ownedTabs.get(tabId)?.reason ?? null;
        // 1) 有归属证据（ui.open 的扩展 UI 页 / 页面在 Agent 窗口开的新 tab）：直接改绑。
        //    与 tab 所在窗口无关：扩展 UI 页本身就是 Agent 的控制面，不是用户标签页。
        if (ownedReason) {
          return agentOwnedBorrow(tab, ownedReason === 'extension-ui' ? 'agent-owned' : 'page-opened');
        }
        // 2) Agent 窗口 + opener 在 Agent 窗口内：页面自建 tab 的第一手证据（SW 重启后仍可判）。
        if (inAgentWindow) {
          const openerOwned = await openerInAgentWindow(tab, agentIds);
          if (decideAgentWindowBorrow({ inAgentWindow: true, ownedReason: null, openerInAgentWindow: openerOwned }).allowed) {
            ownedTabs.mark(tabId, 'page-opened');
            return agentOwnedBorrow(tab, 'opener-in-agent-window');
          }
          // 无归属证据的 Agent 窗口 tab（会话自己的 tab / 别的会话的 tab）：保持拒绝。
          throw new RpcMethodError('E_FORBIDDEN', 'Agent 窗口里的标签页不需要借用，也不允许走借用流程', {
            tabId,
            windowId: Number(tab.windowId),
            reason: 'agent-window',
          });
        }
      }
    }
    // 非 Agent 窗口（用户标签页）仍然走“借用未迁移”的明确拒绝，不静默成功。
    throw new RpcMethodError('E_NOT_IMPLEMENTED', 'TS 运行时尚未迁移借用用户标签页（需要 debugger/CDP 挂载与确认 UI）', {
      method: 'tab.borrow',
    });
  }, { description: '借用标签页（借用用户 tab 未迁移；Agent 自建 tab 直接改绑，其它 Agent 窗口 tab 明确拒绝）' });
  add('tab.return', notImplemented('tab.return', '借用归还需要浮层与所有权状态机，本批未迁移'), { description: '归还借用标签页（未迁移）' });

  // -- 导航 -----------------------------------------------------------------

  add('navigate', async (context) => {
    const tabId = requireTab(context.params);
    const raw = context.params.url;
    if (typeof raw !== 'string' || !raw.trim()) throw new RpcMethodError('E_BAD_ARG', 'navigate 需要非空 url');
    const url = raw.trim();
    const blocked = restrictedUrlReason(url);
    if (blocked) throw new RpcMethodError('E_FORBIDDEN', '目标页面受限（' + blocked + '）：BridgeDeck 不导航到浏览器内部或扩展页面');
    // per-tab allowedOrigins：策略里列了源时，navigate 目标必须在列表内。
    if (policies) await policies.checkNavigation(tabId, url);
    let tab: BrowserTabLike;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      throw new RpcMethodError('E_NO_TAB', 'tabId ' + String(tabId) + ' 不存在或已关闭');
    }
    try {
      if (String(tab.url ?? '') === url) await api.tabs.reload(tabId);
      else await api.tabs.update(tabId, { url });
    } catch (error) {
      throw new RpcMethodError('E_NAV_FAIL', '导航到 ' + url + ' 失败：' + (error instanceof Error ? error.message : String(error)));
    }
    await waitForLoad(tabId);
    let current: BrowserTabLike = { id: tabId };
    try {
      current = await api.tabs.get(tabId);
    } catch {
      // 导航后 tab 可能正在重建，按目标 URL 返回
    }
    return { url: String(current?.url ?? current?.pendingUrl ?? url), title: String(current?.title ?? '') };
  }, { description: '导航到 URL 并等待加载完成', timeoutMs: 60_000 });

  add('reload', async (context) => {
    const tabId = requireTab(context.params);
    try {
      await api.tabs.get(tabId);
      await api.tabs.reload(tabId);
    } catch (error) {
      throw new RpcMethodError('E_NAV_FAIL', 'reload 失败：' + (error instanceof Error ? error.message : String(error)));
    }
    await waitForLoad(tabId);
    return { ok: true, tabId };
  }, { description: '重新加载标签页', timeoutMs: 30_000 });

  // -- 设置 -----------------------------------------------------------------

  add('settings.get', async () => daemonSettingsView(await settings.read()), {
    serialized: false,
    description: '读取扩展设置（daemon/CLI 视图）',
  });

  add('settings.set', async (context) => {
    const patch = isRecord(context.params.patch) ? context.params.patch : {};
    const forbidden = humanOnlyKeysIn(patch);
    if (forbidden.length > 0) {
      throw new RpcMethodError(
        'E_FORBIDDEN',
        forbidden.join(',') + ' 是人工开关：只能由用户在扩展设置页修改，Agent/CLI 不可改',
        { keys: forbidden },
      );
    }
    const result = await settings.write(patch);
    return {
      settings: daemonSettingsView(result.settings).settings,
      applied: result.applied,
      ignored: result.ignored,
    };
  }, { serialized: false, description: '局部更新扩展设置（人工开关拒绝）' });

  // -- 明确未迁移的控制面 ----------------------------------------------------

  // 说明：dialog.* 已由第四批的 DialogService（background 注册）接管，这里不再登记
  // “未迁移”占位，避免同方法重复注册（CommandRouter 会直接报错）。
  add('control-hint', notImplemented('control-hint', '接管浮层 UI（React 组件）尚未迁移到 TS 栈'), { serialized: false, description: '控制提示浮层（未迁移）' });
  add('debugger.detach', async () => ({ ok: true, detached: false, reason: 'TS 运行时未挂 chrome.debugger' }), {
    serialized: false,
    description: '释放 debugger（TS 运行时无 attach，直接 no-op）',
  });

  // 说明：commands 数组只在工厂内构造一次；`now` 目前未直接使用（超时由 router 计时），
  // 保留注入是为了将来 pending 命令的 startedAt 证据。
  void now;

  return commands;
}
