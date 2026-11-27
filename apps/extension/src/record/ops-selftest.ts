// src/record/ops-selftest.ts —— ops 页自测（`?selftest=1`）的纯逻辑（可单测）。
//
// 目的：让 ops 页的 E2E 自测走**真实链路**：
//   选择目标标签页 → record.start → 在目标页面真实点一下（页面录制器采到事件）
//   → record.stop（落库）→ record.list（读持久化）→ 标题写 `<recordings>:<events>`。
//
// 页面里不做任何计数伪造：这里的数字全部来自 record.list 的持久化结果；
// chrome.* 由页面以 deps 注入，单测用 fake 驱动同一份逻辑。

export interface OpsSelftestTab {
  tabId: number;
  url?: string;
  title?: string;
  active?: boolean;
}

export interface OpsSelftestRecording {
  id?: string;
  events?: unknown;
  eventCount?: number;
}

export interface OpsSelftestDeps {
  /** 目标标签页列表（页面侧来自 bb.ui 的 tabs；扩展页已被排除）。 */
  tabs(): Promise<OpsSelftestTab[]>;
  start(params: Record<string, unknown>): Promise<{ tabId?: number; startedAt?: number }>;
  stop(params: Record<string, unknown>): Promise<{ recording?: { id?: string; events?: unknown } }>;
  list(params?: Record<string, unknown>): Promise<{ recordings?: OpsSelftestRecording[] }>;
  /** 在目标页面真实触发一次点击（chrome.scripting.executeScript；失败返回 false）。 */
  clickPage?(tabId: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface OpsSelftestResult {
  tabId: number;
  recordings: number;
  events: number;
}

function eventCountOf(recording: OpsSelftestRecording | undefined): number {
  if (!recording) return 0;
  const events = recording.events;
  if (Array.isArray(events)) return events.length;
  const numeric = Number(events);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  const fallback = Number(recording.eventCount);
  return Number.isFinite(fallback) && fallback >= 0 ? Math.floor(fallback) : 0;
}

/** 选择自测目标：优先 http(s) 页面，其次任意非扩展页 tab。 */
export function pickOpsSelftestTab(tabs: OpsSelftestTab[]): OpsSelftestTab | null {
  const list = (Array.isArray(tabs) ? tabs : []).filter((tab) => Number.isInteger(Number(tab.tabId)) && Number(tab.tabId) > 0);
  const web = list.find((tab) => /^https?:/i.test(String(tab.url ?? '')));
  return web ?? list[0] ?? null;
}

/**
 * 跑一次真实录制自测；失败抛 Error（页面把它写成 `SELFTEST:fail:...`）。
 * 事件数取 latest recording 的事件计数（数组或摘要数字都认）。
 */
export async function runOpsSelftest(deps: OpsSelftestDeps): Promise<OpsSelftestResult> {
  const tabs = await deps.tabs();
  const target = pickOpsSelftestTab(tabs);
  if (!target) throw new Error('没有可录制的目标标签页');
  const tabId = Number(target.tabId);
  const started = await deps.start({ tabId, includeAgent: true, screenshots: false });
  const activeTab = Number.isInteger(Number(started.tabId)) ? Number(started.tabId) : tabId;
  if (deps.clickPage) {
    // 两次点击：第一次触发真实页面动作；若页面没有 #submit-btn，录制器仍会记录一次
    // body 点击（页面侧注入函数自带兜底）。失败不抛错 —— 由事件计数如实反映。
    await deps.clickPage(activeTab).catch(() => false);
    await deps.sleep(350);
    await deps.clickPage(activeTab).catch(() => false);
  }
  await deps.sleep(800);
  await deps.stop({ tabId: activeTab });
  const listed = await deps.list({ includeEvents: false });
  const recordings = Array.isArray(listed.recordings) ? listed.recordings : [];
  const events = eventCountOf(recordings[0]);
  return { tabId: activeTab, recordings: recordings.length, events };
}
