// src/background-execution.js —— 后台标签页执行 + 前台化/恢复策略。
//
// 会话标签页由 debugger.armTab 启用 Emulation.setFocusEmulationEnabled：
// 页面认为自己可见/聚焦，CDP 原生输入可以在后台 Agent Window 直接派发，不需要切 tab。
// 只有未启用焦点仿真的标签页（借用 tab、预挂失败）才回退到切换 active tab 的旧路径。

import { isTabArmed } from './debugger.js';

export async function withForegroundTab(tabId, fn) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || !chrome.tabs || typeof chrome.tabs.update !== 'function') return fn();
  // 会话 CDP 已启用焦点仿真：后台直接派发，零窗口 API 调用。
  if (isTabArmed(id)) return fn();
  // 标签页已在自己的窗口里激活时不需要动别的窗口：CDP 输入不依赖 OS 焦点，
  // 后台 Agent Window 里的 active tab 直接执行即可，省掉两次 tabs 查询和激活/恢复。
  try {
    const tab = await chrome.tabs.get(id);
    if (tab && tab.active === true) return fn();
  } catch {
    // 读不到按原逻辑处理
  }
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
