// src/tools/frames.js —— iframe ref 别名映射。
const frameAliasMaps = new Map();

export function clearFrameAliases(tabId) {
  frameAliasMaps.delete(tabId);
}

export function resolveFrameAlias(tabId, ref) {
  const map = frameAliasMaps.get(tabId);
  return (map && map.get(ref)) || null;
}

export function setFrameAliases(tabId, map) {
  frameAliasMaps.set(tabId, map);
}
