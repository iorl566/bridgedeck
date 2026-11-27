/** 决定哪些 Agent tab 可以按空闲时间关闭；纯函数，供 dry-run 与真实清理共用。 */
export function planIdleClose(tabs, { idleMs = 600000, now = Date.now(), keepOpen = new Set() } = {}) {
  const list = Array.isArray(tabs) ? tabs.filter((tab) => tab && Number.isInteger(tab.tabId)) : [];
  const idle = Math.max(0, Number(idleMs) || 0);
  const cutoff = now - idle;
  const byWindow = new Map();
  for (const tab of list) if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
  for (const tab of list) byWindow.get(tab.windowId).push(tab);
  const close = [];
  const keep = [];
  for (const tab of list) {
    const reason = (() => {
      if (tab.owned !== 'agent') return 'user-tab';
      if (keepOpen.has(tab.tabId) || tab.keepOpen === true) return 'keep-open';
      if (tab.active === true) return 'active';
      const siblings = byWindow.get(tab.windowId) || [];
      if (siblings.length <= 1) return 'last-in-window';
      if (Number(tab.lastAccessed) > cutoff) return 'recent';
      return '';
    })();
    if (reason) keep.push({ tabId: tab.tabId, reason });
    else close.push(tab.tabId);
  }
  return { close, keep };
}
