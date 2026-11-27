// src/runtime/tab-ownership.ts —— Agent 自建标签页归属（follow / rebind 语义）。
//
// 背景（M-C 第六批 35e）：页面在 Agent 窗口里打开新标签页（target=_blank /
// window.open）后，CLI 的 `click --follow` 会调 daemon `session.rebind`；daemon 对
// 新 tab 发 `tab.borrow`。借用策略只保护**用户标签页**：Agent 自己窗口里的标签页
// 不需要走借用流程。JS 0.3.0 的做法是：
//   - 页面在 Agent 窗口里打开的新 tab → pageGuard 标记为“自建 + controlled”，
//     之后 tab.borrow 看到 controlled 就不再按“外部 tab”拒绝；
//   - 普通 `tab borrow <agent-window-tab>`（例如当前会话自己的 tab）仍然拒绝。
//
// TS 侧没有 chrome.tabs.onCreated 的 background 接线位置（写域限制），因此这里用
// **归属登记表 + opener 复核**两条独立证据实现同一语义：
//   - `tabs.onCreated` 里发现“opener 在 Agent 窗口内”的 tab → 登记为 page-opened；
//   - `tab.borrow` 时再按 openerTabId 复核一次（SW 重启丢了内存登记也能判定）；
//   - `ui.open` 打开的扩展 UI 页同样登记为 extension-ui（它本来就是 Agent 的控制面，
//     不是用户标签页），这样 `session start/rebind --tab <uiTab>` 不再被借用流程挡住。
//
// 安全边界：没有归属证据的 Agent 窗口 tab（会话自己的 tab、别的会话的 tab）仍然
// 返回 E_FORBIDDEN(agent-window)；这里只补“这个 tab 是 Agent 自己开的”判定，
// 不关闭借用策略。

/** 归属证据：页面在 Agent 窗口里打开（JS pageGuard controlled），或扩展 UI 页。 */
export type AgentTabOwnershipReason = 'page-opened' | 'extension-ui';

export interface AgentTabOwnershipEntry {
  tabId: number;
  reason: AgentTabOwnershipReason;
  ownedAt: number;
}

/**
 * Agent 自建 tab 归属表（per service worker 实例；SW 重启后靠 opener 复核兜底）。
 */
export class AgentOwnedTabRegistry {
  private readonly owned = new Map<number, AgentTabOwnershipEntry>();
  private readonly now: () => number;
  private readonly limit: number;

  constructor(options: { now?: () => number; limit?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.limit = Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 64;
  }

  mark(tabId: unknown, reason: AgentTabOwnershipReason): AgentTabOwnershipEntry | null {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const entry: AgentTabOwnershipEntry = { tabId: id, reason, ownedAt: this.now() };
    this.owned.delete(id);
    this.owned.set(id, entry);
    while (this.owned.size > this.limit) {
      const oldest = this.owned.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.owned.delete(oldest);
    }
    return entry;
  }

  get(tabId: unknown): AgentTabOwnershipEntry | null {
    return this.owned.get(Number(tabId)) ?? null;
  }

  has(tabId: unknown): boolean {
    return this.owned.has(Number(tabId));
  }

  drop(tabId: unknown): boolean {
    return this.owned.delete(Number(tabId));
  }

  clear(): void {
    this.owned.clear();
  }

  list(): AgentTabOwnershipEntry[] {
    return [...this.owned.values()];
  }
}

/** 生产（service worker）共享单例：ui.open 登记，runtime commands 消费。 */
export const agentOwnedTabs = new AgentOwnedTabRegistry();

/** opener 是否是 Agent 窗口里的 tab（页面在 Agent 窗口里打开新标签页的判据）。 */
export function isOpenedFromAgentWindow(
  opener: { windowId?: number | null } | null | undefined,
  agentWindowIds: Iterable<number>,
): boolean {
  if (!opener) return false;
  const windowId = Number(opener.windowId);
  if (!Number.isInteger(windowId) || windowId <= 0) return false;
  for (const id of agentWindowIds) {
    if (Number(id) === windowId) return true;
  }
  return false;
}

export interface AgentWindowBorrowInput {
  /** tab 是否位于 Agent 窗口。 */
  inAgentWindow: boolean;
  /** 归属表里的登记（null = 没有登记）。 */
  ownedReason: AgentTabOwnershipReason | null;
  /** openerTabId 复核结论（opener 在 Agent 窗口内）。 */
  openerInAgentWindow: boolean;
}

export type AgentWindowBorrowReason =
  | 'not-agent-window'
  | 'agent-owned'
  | 'page-opened'
  | 'opener-in-agent-window'
  | 'agent-window';

/**
 * Agent 窗口 tab 的借用判定（纯函数，便于单测）：
 * - 不在 Agent 窗口 → 交给原借用路径（本运行时对用户 tab 仍是 E_NOT_IMPLEMENTED）；
 * - Agent 窗口 + 有归属证据（extension-ui / 登记过）→ 允许（rebind/follow 语义）；
 * - Agent 窗口 + opener 在 Agent 窗口内（页面打开的新 tab）→ 允许；
 * - 其余 Agent 窗口 tab → 拒绝，reason=agent-window（保持 26/20q 的安全断言）。
 */
export function decideAgentWindowBorrow(input: AgentWindowBorrowInput): {
  allowed: boolean;
  reason: AgentWindowBorrowReason;
} {
  if (!input.inAgentWindow) return { allowed: true, reason: 'not-agent-window' };
  if (input.ownedReason === 'extension-ui') return { allowed: true, reason: 'agent-owned' };
  if (input.ownedReason === 'page-opened') return { allowed: true, reason: 'page-opened' };
  if (input.openerInAgentWindow) return { allowed: true, reason: 'opener-in-agent-window' };
  return { allowed: false, reason: 'agent-window' };
}
