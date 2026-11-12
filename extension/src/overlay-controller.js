// src/overlay-controller.js —— 浮层注册/互斥/捕获锁（无 DOM 依赖）。
export function createOverlayController({ now = Date.now } = {}) {
  const overlays = new Map();
  const captures = new Map();

  function tabState(tabId) {
    const id = Number(tabId);
    if (!overlays.has(id)) overlays.set(id, new Map());
    return overlays.get(id);
  }

  function open(tabId, kind, { priority = 0, exclusive = false } = {}) {
    const id = Number(tabId);
    const state = tabState(id);
    const existing = state.get(String(kind));
    if (existing) return { ok: true, duplicate: true, token: existing.token, version: existing.version };
    if (exclusive) {
      for (const [otherKind, entry] of [...state.entries()]) {
        if (entry.priority <= priority) state.delete(otherKind);
      }
    }
    const version = (state.version || 0) + 1;
    state.version = version;
    const token = String(kind) + ':' + version;
    state.set(String(kind), { token, version, priority, exclusive, since: now() });
    return { ok: true, duplicate: false, token, version };
  }

  function close(tabId, kind, token) {
    const state = overlays.get(Number(tabId));
    if (!state) return false;
    const entry = state.get(String(kind));
    if (!entry) return false;
    if (token && entry.token !== token) return false;
    state.delete(String(kind));
    state.version = (state.version || 0) + 1;
    return true;
  }

  function snapshot(tabId) {
    const id = Number(tabId);
    const state = overlays.get(id);
    return {
      capturing: (captures.get(id) || 0) > 0,
      overlays: state ? [...state.entries()].map(([kind, entry]) => ({ kind, ...entry })) : [],
    };
  }

  function beginCapture(tabId) {
    const id = Number(tabId);
    captures.set(id, (captures.get(id) || 0) + 1);
  }

  function endCapture(tabId) {
    const id = Number(tabId);
    const next = Math.max(0, (captures.get(id) || 0) - 1);
    if (next === 0) captures.delete(id);
    else captures.set(id, next);
  }

  function isCapturing(tabId) {
    return (captures.get(Number(tabId)) || 0) > 0;
  }

  return { open, close, snapshot, beginCapture, endCapture, isCapturing };
}
