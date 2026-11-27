// daemon/session-views.js —— 会话列表与 run log 视图。
import { SessionRunLog } from '../lib/run-log.mjs';

export function createSessionViews({ sessions, instances, tabControl, sessionState, sessionPublicView, isSessionExpired, resolveSession, sessionLeases = null }) {
function sessionList() {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (isSessionExpired(session, { connected: instances.has(session.instanceId), now })) {
        sessions.delete(sessionId);
        tabControl.unregister(session.tabId, sessionId);
        if (sessionLeases) { try { sessionLeases.release(session.tabId, sessionId, { reason: 'cleanup' }); } catch { /* 忽略 */ } }
      }
    }
    return [...sessions.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((session) => {
        const control = tabControl.status(session.tabId);
        const lease = sessionLeases ? sessionLeases.status(session.tabId) : null;
        return sessionPublicView(session, {
          connected: instances.has(session.instanceId),
          phase: sessionState.phase(session.sessionId),
          now,
          lease,
          control: control ? {
            mode: control.mode,
            epoch: control.epoch,
            holder: control.holder,
            primary: control.primary,
            shared: control.shared,
            sessionCount: control.sessionCount,
            leaseRemainingMs: control.leaseRemainingMs,
          } : null,
        });
      });
  }
  
  
function runLogView(params = {}) {
    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    if (!session.runLog) session.runLog = new SessionRunLog();
    return { sessionId: session.sessionId, ...session.runLog.snapshot({ limit: params.limit }) };
  }
  
  
  return { sessionList, runLogView };
}
