// src/frame-graph.js —— 每个 tab 的 frame 树缓存（frameId/parent/url），按导航失效。
//
// chrome.scripting(allFrames) 每个命令都重新枚举 frame；这里缓存元数据，
// observe-frames 等命令用它补 parentFrameId，并在 onCommitted/onRemoved 时失效。

const TTL_MS = 15_000;
const cache = new Map(); // tabId -> { frames, at }

export function invalidateFrameGraph(tabId) {
  if (tabId == null) return;
  cache.delete(Number(tabId));
}

export function clearFrameGraph() {
  cache.clear();
}

export async function refreshFrameGraph(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return [];
  if (!chrome.webNavigation || typeof chrome.webNavigation.getAllFrames !== 'function') return [];
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: id });
    const list = (Array.isArray(frames) ? frames : []).map((frame) => ({
      frameId: Number(frame.frameId),
      parentFrameId: Number(frame.parentFrameId),
      url: String(frame.url || ''),
      errorOccurred: frame.errorOccurred === true,
    }));
    cache.set(id, { frames: list, at: Date.now() });
    return list;
  } catch {
    cache.set(id, { frames: [], at: Date.now() });
    return [];
  }
}

export async function ensureFrameGraph(tabId, { maxAgeMs = TTL_MS } = {}) {
  const id = Number(tabId);
  const entry = cache.get(id);
  if (entry && Date.now() - entry.at <= maxAgeMs) return entry.frames;
  return refreshFrameGraph(id);
}

export function getFrameGraph(tabId) {
  const entry = cache.get(Number(tabId));
  return entry ? entry.frames : [];
}

export function installFrameGraphInvalidation() {
  if (!chrome.webNavigation) return () => {};
  const invalidate = (details) => {
    if (details && Number.isInteger(details.tabId)) invalidateFrameGraph(details.tabId);
  };
  try { chrome.webNavigation.onCommitted.addListener(invalidate); } catch { /* 忽略 */ }
  try { chrome.webNavigation.onCreatedNavigationTarget.addListener(invalidate); } catch { /* 忽略 */ }
  try { chrome.tabs.onRemoved.addListener((tabId) => invalidateFrameGraph(tabId)); } catch { /* 忽略 */ }
  try { chrome.tabs.onUpdated.addListener((tabId, info) => { if (info && (info.status === 'loading' || info.url)) invalidateFrameGraph(tabId); }); } catch { /* 忽略 */ }
  return () => {
    try { chrome.webNavigation.onCommitted.removeListener(invalidate); } catch { /* 忽略 */ }
    try { chrome.webNavigation.onCreatedNavigationTarget.removeListener(invalidate); } catch { /* 忽略 */ }
  };
}
