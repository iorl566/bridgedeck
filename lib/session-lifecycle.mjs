// lib/session-lifecycle.mjs —— 会话记录创建与生命周期字段更新。
export function createSessionRecord({
  sessionId,
  instanceId,
  tabId,
  windowId = 0,
  url = '',
  title = '',
  borrowed = false,
  incognito = false,
  restored = false,
  startedAt = Date.now(),
} = {}) {
  return {
    sessionId,
    instanceId,
    tabId,
    windowId,
    url,
    title,
    borrowed: borrowed === true,
    incognito: incognito === true,
    restored: restored === true,
    observation: null,
    paused: false,
    connected: true,
    disconnectedAt: 0,
    startedAt,
  };
}

export function setSessionPaused(session, paused) {
  if (!session) return false;
  session.paused = paused === true;
  return session.paused;
}

export function markSessionDisconnected(session, now = Date.now()) {
  if (!session) return;
  session.connected = false;
  session.disconnectedAt = now;
}

export function markSessionRestored(session) {
  if (!session) return;
  session.connected = true;
  session.disconnectedAt = 0;
  session.restored = true;
}

export function rebindSessionRecord(session, { instanceId, tabId, windowId = 0, url = '', title = '' } = {}) {
  if (!session) return null;
  if (instanceId !== undefined) session.instanceId = instanceId;
  if (tabId !== undefined) session.tabId = tabId;
  session.windowId = windowId;
  session.url = url;
  session.title = title;
  session.borrowed = true;
  session.observation = null;
  session.disconnectedAt = 0;
  return session;
}
