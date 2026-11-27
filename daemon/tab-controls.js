// daemon/tab-controls.js —— tab 归属/借用/控制模式辅助。

export function createTabControls({ sessions, tabReservations, tabControl, sessionState, CONTROL_MODES, BridgeError, saveSessions, lease = null }) {
function tabOwnerSession(tabId, exceptSessionId) {
    for (const [sessionId, session] of sessions) {
      if (sessionId !== exceptSessionId && Number(session.tabId) === Number(tabId)) return sessionId;
    }
    return null;
  }
  
  function claimTab(tabId, owner) {
    const active = tabOwnerSession(tabId, owner);
    if (active) throw new BridgeError('E_BORROW_CONFLICT', '该标签页已被其他会话占用', { tabId, owner: active });
    // 多会话 tab 所有权：先拿互斥租约（冲突时 data.conflict 给出谁持有/何时/为何/剩余租期），
    // 再占 reservation（防止两个 session.start --tab 都通过空闲检查）。reservation 失败要回滚租约。
    let claimedLease = null;
    if (lease) {
      const result = lease.acquire(tabId, owner, { reason: 'tab-claim' });
      if (!result.ok) {
        const evidence = result.data ? { ...result.data } : {};
        if (result.conflict && !evidence.conflict) evidence.conflict = result.conflict;
        throw new BridgeError(result.code || 'E_TAB_LEASE_HELD', result.message || '标签页所有权租约冲突', {
          ...evidence,
          lease: result.lease || null,
        });
      }
      claimedLease = result.lease;
    }
    const claim = tabReservations.reserve(tabId, owner);
    if (!claim.ok) {
      if (lease && claimedLease) {
        try { lease.release(tabId, owner, { reason: 'tab-claim-rollback' }); } catch { /* 忽略 */ }
      }
      throw new BridgeError('E_BORROW_CONFLICT', '该标签页已有借用确认进行中', { tabId, owner: claim.owner });
    }
    return claim;
  }
  
  /** tab 所有权租约快照（status/session.list 用来解释冲突）。 */
  function tabLeaseStatus(tabId) {
    if (!lease) return null;
    try { return lease.status(tabId); } catch { return null; }
  }
  
  /** 一个 tab 上仍存活的会话（按 startedAt 升序：最老的天然是主会话）。 */
  function tabSessionIds(tabId, { exceptSessionId = null } = {}) {
    const wanted = Number(tabId);
    return [...sessions.values()]
      .filter((session) => Number(session.tabId) === wanted
        && session.sessionId !== exceptSessionId
        && sessionState.phase(session.sessionId) !== 'stopping')
      .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0))
      .map((session) => session.sessionId);
  }
  
  /** 用 daemon 的会话集合对齐 tab 控制记录（重启恢复/漏登记都能自愈）。 */
  function syncTabControl(tabId, { mode } = {}) {
    const ids = tabSessionIds(tabId);
    if (!ids.length) return null;
    const owner = ids.map((id) => sessions.get(id)).find((session) => session && session.shared !== true);
    const primary = owner ? owner.sessionId : ids[0];
    let controlMode = mode;
    if (controlMode === undefined) {
      controlMode = (owner && owner.controlMode) || (sessions.get(primary) || {}).controlMode || 'open';
    }
    return tabControl.sync(tabId, ids, { mode: controlMode, primary });
  }
  
  /** 控制权模式参数：空 → undefined；非法 → E_BAD_ARG。 */
  function normalizeControlMode(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const text = String(value).trim();
    if (!CONTROL_MODES.includes(text)) throw new BridgeError('E_BAD_ARG', '控制权模式只支持 open|exclusive，收到 "' + text + '"');
    return text;
  }
  
  /** 控制权判定结果 → RPC 返回体（失败抛 BridgeError，数据带上 holder/epoch）。 */
  function controlResult(decision, session, extra = {}) {
    if (!decision || decision.ok !== true) {
      throw new BridgeError(decision.code || 'E_INTERNAL', decision.message || '控制权操作失败', decision.data || {});
    }
    const control = decision.control || null;
    return {
      sessionId: session.sessionId,
      tabId: session.tabId,
      ...extra,
      ...(control ? {
        control,
        holder: control.holder,
        primary: control.primary,
        epoch: control.epoch,
        mode: control.mode,
        shared: control.shared,
        leaseRemainingMs: control.leaseRemainingMs,
        holdsControl: control.holder === session.sessionId,
      } : {}),
    };
  }
  
  /** 把控制权模式写回该 tab 上所有会话记录（重启后仍生效）。 */
  function persistControlMode(tabId, mode) {
    for (const session of sessions.values()) {
      if (Number(session.tabId) === Number(tabId)) session.controlMode = mode;
    }
    saveSessions();
  }
  return { tabOwnerSession, claimTab, tabSessionIds, syncTabControl, normalizeControlMode, controlResult, persistControlMode, tabLeaseStatus };
}
