// src/human-state.js —— 最近一次人工操作快照（来自 content 脚本，按 tab 聚合）。
const states = new Map(); // tabId -> { at, frameId, ...snapshot }

export function setHumanState(tabId, state) {
  if (!Number.isInteger(tabId)) return null;
  const next = { ...state, at: Number(state && state.at) || Date.now(), tabId };
  states.set(tabId, next);
  return next;
}

export function getHumanState(tabId) {
  return states.get(Number(tabId)) || null;
}

export function clearHumanState(tabId) {
  states.delete(Number(tabId));
}
