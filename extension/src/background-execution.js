// src/background-execution.js —— 后台标签页执行 + 前台化/恢复策略。
//
// 可信输入需要目标 tab 处于前台；命令结束后若用户没有切换 tab，则恢复原来的
// active tab，避免一次点击把用户的浏览界面永久顶到前面。

export async function withForegroundTab(tabId, fn) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || !chrome.tabs || typeof chrome.tabs.update !== 'function') return fn();
  let previous = null;
  try {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    previous = active && active[0] && Number.isInteger(active[0].id) ? active[0].id : null;
    if (previous !== id) await chrome.tabs.update(id, { active: true });
  } catch {
    // 标签页可能已关闭；继续执行，让动作自己报错
  }
  try {
    return await fn();
  } finally {
    if (previous != null && previous !== id) {
      try {
        const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (active && active[0] && active[0].id === id) {
          await chrome.tabs.update(previous, { active: true });
        }
      } catch {
        // 用户已切换/关闭标签页，不强行恢复
      }
    }
  }
}
