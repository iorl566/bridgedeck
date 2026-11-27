// src/background-execution.js —— 后台标签页执行 + 前台化/恢复策略。
//
// 会话标签页由 debugger.armTab 启用 Emulation.setFocusEmulationEnabled：
// 页面认为自己可见/聚焦，CDP 原生输入可以在后台 Agent Window 直接派发，不需要切 tab。
// 默认**不切换 active tab、不聚焦窗口**；只有显式 focus（CLI `--focus`）才走旧的前台化路径。

import { isTabArmed } from './debugger.js';
import { focusRequested } from './lib/focus-policy.js';

export async function withForegroundTab(tabId, fn, options = {}) {
  const id = Number(tabId);
  // 默认：不碰任何窗口/标签页激活状态，直接执行。
  if (!focusRequested(options) && options.foreground !== true) return fn();
  if (!Number.isInteger(id) || !chrome.tabs || typeof chrome.tabs.update !== 'function') return fn();
  // 会话 CDP 已启用焦点仿真：后台直接派发，零窗口 API 调用。
  if (isTabArmed(id)) return fn();
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
