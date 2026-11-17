// src/target-marker-client.js —— 在页面里显示/移除 Agent 目标标记。
import { installTargetMarker } from './target-marker.js';
import { OVERLAY_THEME } from './overlay-theme.js';

export async function showTargetMarker(tabId, x, y, ttlMs = 2000) {
  if (!Number.isInteger(tabId) || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: installTargetMarker,
      args: [Number(x), Number(y), Number(ttlMs) || 2000, OVERLAY_THEME],
    });
    return true;
  } catch {
    return false;
  }
}

export async function hideTargetMarker(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => { const node = document.getElementById('__bb_agent_target'); if (node) node.remove(); },
    });
  } catch {
    // 页面可能已关闭
  }
}
