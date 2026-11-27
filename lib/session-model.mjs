// lib/session-model.mjs —— 会话记录对外视图与过期判断。
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function sessionPublicView(session, { connected = false, phase = '', now = Date.now(), lease = null } = {}) {
  const input = session && typeof session === 'object' ? session : {};
  return {
    sessionId: input.sessionId,
    instanceId: input.instanceId,
    tabId: input.tabId,
    windowId: input.windowId,
    url: input.url || '',
    title: input.title || '',
    borrowed: input.borrowed === true,
    shared: input.shared === true,
    ownerSession: input.ownerSession ? String(input.ownerSession) : null,
    incognito: input.incognito === true,
    controller: input.controller && typeof input.controller === 'object' ? input.controller : null,
    scope: input.scope ? String(input.scope) : '',
    allowDomains: Array.isArray(input.allowDomains) ? input.allowDomains : [],
    denyDomains: Array.isArray(input.denyDomains) ? input.denyDomains : [],
    minIntervalMs: Number(input.minIntervalMs) || 0,
    controlMode: input.controlMode === 'exclusive' ? 'exclusive' : 'open',
    control: input.control && typeof input.control === 'object' ? input.control : null,
    connected: connected === true,
    restored: input.restored === true,
    phase: phase || (connected ? 'active' : 'disconnected'),
    // tab 所有权租约快照（holder/participants/冲突证据）；无租约时为 null。
    lease: lease && typeof lease === 'object' ? lease : null,
    startedAt: Number(input.startedAt) || 0,
    ageMs: Math.max(0, now - (Number(input.startedAt) || now)),
  };
}

export function isSessionExpired(session, { connected = false, now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  if (connected) return false;
  const disconnectedAt = Number(session && session.disconnectedAt) || 0;
  return disconnectedAt > 0 && now - disconnectedAt > ttlMs;
}

export function summarizeSessions(sessions, { now = Date.now(), isConnected = () => false, phaseOf = () => '' } = {}) {
  return (Array.isArray(sessions) ? sessions : [])
    .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0))
    .map((session) => sessionPublicView(session, {
      connected: isConnected(session),
      phase: phaseOf(session),
      now,
    }));
}
