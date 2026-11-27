// daemon/session-admin.js —— session.pause / session.stop_all。
import { setSessionPaused } from '../lib/session-lifecycle.mjs';

export function createSessionAdmin({ resolveSession, instances, sendInstanceEvent, log, BridgeError, sessions, sessionStop, sessionState = null }) {
async function pauseSession(params, timeoutMs) {
    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    const wantPause = params.paused === true;
    // 自动恢复只允许作用于 auto 暂停；手动暂停必须由人确认（E_PAUSED_MANUAL）。
    if (!wantPause && params.auto === true && session.pausedBy !== 'auto') {
      throw new BridgeError('E_PAUSED_MANUAL', '会话是人工暂停的，auto 恢复被拒绝；请显式 resume 或交回控制');
    }
    session.paused = setSessionPaused(session, wantPause);
    session.pausedBy = session.paused ? (params.reason === 'auto' ? 'auto' : 'manual') : null;
    session.pausedAt = session.paused ? Date.now() : null;
    // 生命周期状态机与暂停状态保持同步：ready ⇄ paused（非法迁移只记日志，不阻断暂停本身）。
    if (sessionState) {
      try {
        if (session.paused) sessionState.pause(session.sessionId, { reason: params.reason || 'manual', by: session.pausedBy });
        else sessionState.resume(session.sessionId, { reason: 'resume' });
      } catch (error) {
        log('session ' + session.sessionId + ' 生命周期暂停同步失败（忽略）：' + ((error && error.message) || error));
      }
    }
    const instance = instances.get(session.instanceId);
    if (instance) sendInstanceEvent(instance, 'takeover.state', { tabId: session.tabId, sessionId: session.sessionId, paused: session.paused, pausedBy: session.pausedBy, borrowed: session.borrowed === true, controller: session.controller ?? null, project: session.controller?.project ?? null });
    log('session ' + session.sessionId + ' paused=' + session.paused + (session.pausedBy ? ' by=' + session.pausedBy : ''));
    return { sessionId: session.sessionId, paused: session.paused, pausedBy: session.pausedBy };
  }
  
  // ---------------------------------------------------------------------------
  // 共享 tab 的控制权：status / claim / release / handoff / mode
  // ---------------------------------------------------------------------------
  
  /** session.control_status：该 tab 的控制权、租约与主会话快照。 */
  /** session.stop_all：停止所有会话；单个失败不影响其它会话。 */
  
async function stopAllSessions(params = {}, timeoutMs) {
    const ids = [...sessions.keys()];
    const stopped = [];
    const failed = [];
    for (const sessionId of ids) {
      try {
        await sessionStop.stopSession({ session: sessionId, keep: params.keep === true }, timeoutMs);
        stopped.push(sessionId);
      } catch (error) {
        failed.push({ sessionId, code: error && error.code ? error.code : 'E_INTERNAL' });
      }
    }
    return { ok: true, stopped, failed, count: stopped.length };
  }
  
  
  return { pauseSession, stopAllSessions };
}
