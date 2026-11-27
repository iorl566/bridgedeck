// daemon/control-ops.js —— session 控制权 status/claim/release/handoff/mode。

export function createControlOps({ resolveSession, tabControls, tabControl, BridgeError, log }) {
function controlStatus(params = {}) {
    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    const control = tabControls.syncTabControl(session.tabId);
    const fallback = {
      tabId: session.tabId,
      mode: session.controlMode || 'open',
      epoch: 0,
      primary: session.sessionId,
      holder: session.sessionId,
      shared: false,
      sessionCount: 1,
      sessions: [session.sessionId],
      leaseMs: 0,
      leaseRemainingMs: 0,
      holderIsPrimary: true,
      lastTransition: null,
      history: [],
    };
    const view = control || fallback;
    return {
      sessionId: session.sessionId,
      tabId: session.tabId,
      control: view,
      mode: view.mode,
      epoch: view.epoch,
      primary: view.primary,
      holder: view.holder,
      shared: view.shared,
      sessionCount: view.sessionCount,
      sessions: view.sessions,
      leaseRemainingMs: view.leaseRemainingMs,
      holdsControl: view.holder === session.sessionId,
    };
  }
  
  /** session.claim_control：认领或续租控制权（holder 空 → 成功；被他人持有 → E_CONTROL_BUSY；主会话可收回）。 */
  function claimControl(params = {}) {
    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    tabControls.syncTabControl(session.tabId);
    const decision = tabControl.claim(session.tabId, session.sessionId, {
      leaseMs: params.leaseMs,
      expectEpoch: params.expectEpoch,
    });
    return tabControls.controlResult(decision, session, {
      action: 'claim',
      renewed: decision.renewed === true,
      acquired: decision.acquired === true,
      preempted: decision.preempted || null,
    });
  }
  
  /** session.release_control：持有者主动放弃控制权（holder 变空，租约清空）。 */
  function releaseControl(params = {}) {
    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    tabControls.syncTabControl(session.tabId);
    const decision = tabControl.release(session.tabId, session.sessionId, { expectEpoch: params.expectEpoch });
    return tabControls.controlResult(decision, session, { action: 'release' });
  }
  
  /** session.handoff：把控制权显式转交给同一 tab 上的另一个会话。 */
  function handoffControl(params = {}) {
    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    tabControls.syncTabControl(session.tabId);
    const target = resolveSession(params.to);
    const decision = tabControl.handoff(session.tabId, session.sessionId, target.sessionId, {
      leaseMs: params.leaseMs,
      expectEpoch: params.expectEpoch,
    });
    return tabControls.controlResult(decision, session, { action: 'handoff', from: session.sessionId, to: target.sessionId });
  }
  
  /** session.control_mode：open（共享写，默认）| exclusive（同一时刻单写者）。 */
  function setControlMode(params = {}) {
    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    const mode = tabControls.normalizeControlMode(params.mode);
    if (!mode) throw new BridgeError('E_BAD_ARG', 'session.control_mode 需要 --mode open|exclusive');
    tabControls.syncTabControl(session.tabId);
    const decision = tabControl.setMode(session.tabId, mode, session.sessionId);
    const result = tabControls.controlResult(decision, session, { action: 'mode', mode });
    tabControls.persistControlMode(session.tabId, mode);
    log(`tab ${session.tabId} 共享控制模式 → ${mode}（by ${session.sessionId}）`);
    return result;
  }
  
  return { controlStatus, claimControl, releaseControl, handoffControl, setControlMode };
}
