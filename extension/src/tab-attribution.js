// src/tab-attribution.js —— 本扩展自己创建/移动的 tab/window 归属。
const TTL_MS = 15000;
const selfCreated = new Map();

export function markSelfCreated(tabId) {
  if (!Number.isInteger(tabId)) return;
  const now = Date.now();
  selfCreated.set(tabId, now);
  for (const entry of selfCreated) {
    if (now - entry[1] > 15000) selfCreated.delete(entry[0]);
  }
}

export function consumeSelfCreated(tabId) {
  const ts = selfCreated.get(tabId);
  if (ts == null) return false;
  selfCreated.delete(tabId);
  return Date.now() - ts < 15000;
}

/**
 * 扩展自己新建的窗口（Agent Window）：页面守卫必须放行。
 *
 * 只靠 tabId 标记会输给 onCreated 的时序：窗口刚建好、tab 还没标上时，
 * 页面守卫可能已经按「外部标签页」把它移回用户窗口，结果 Agent 反而跑在用户页面里。
 * 窗口维度在建窗返回时同步登记，覆盖这个竞态。
 */
const selfCreatedWindows = new Map();

export function markSelfCreatedWindow(windowId) {
  if (!Number.isInteger(windowId)) return;
  const now = Date.now();
  selfCreatedWindows.set(windowId, now);
  for (const entry of selfCreatedWindows) {
    if (now - entry[1] > 15000) selfCreatedWindows.delete(entry[0]);
  }
}

export function isSelfCreatedWindow(windowId) {
  if (!Number.isInteger(windowId)) return false;
  const ts = selfCreatedWindows.get(windowId);
  if (ts == null) return false;
  if (Date.now() - ts > 15000) { selfCreatedWindows.delete(windowId); return false; }
  return true;
}

/** 借用确认与人工协助的等待者：requestId -> { resolve, timer } */
