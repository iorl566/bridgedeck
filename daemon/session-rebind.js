// daemon/session-rebind.js —— session.rebind：切 tab / 归还旧借用。

export function createSessionRebind({ resolveSession, tabControls, instances, sendCommand, tabReservations, rebindSessionRecord, tabControl, saveSessions, sendInstanceEvent, log, sessionPublicView, sessionState, BridgeError, findInstanceForTab, lease = null }) {
  const rebindSession = async function rebindSession(params, timeoutMs) {

    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    const wanted = Number(params.tab);
    if (!Number.isInteger(wanted)) throw new BridgeError('E_BAD_ARG', 'session.rebind 需要 --tab <tabId>');
    const target = await findInstanceForTab(wanted);
    if (!target) throw new BridgeError('E_NO_TAB', `tabId ${wanted} 不属于任何已连接的浏览器`);
    if (wanted !== Number(session.tabId)) tabControls.claimTab(wanted, session.sessionId);
  
    const previous = instances.get(session.instanceId);
    const oldTabId = session.tabId;
  
    const info = await sendCommand(target, 'tab.borrow', { tabId: wanted }, timeoutMs).catch((error) => {
      // 借用失败：回滚刚拿到的 reservation/租约，不能让新 tab 挂着本会话的 holder。
      if (wanted !== Number(session.tabId)) {
        tabReservations.release(wanted, session.sessionId);
        if (lease) { try { lease.release(wanted, session.sessionId, { reason: 'rebind-failed' }); } catch { /* 忽略 */ } }
      }
      throw error;
    });
    if (previous && oldTabId && oldTabId !== wanted) {
      try { await sendCommand(previous, 'dialog.disarm', { tabId: oldTabId }, 3000); } catch { /* 忽略 */ }
      try { await sendCommand(previous, 'control-hint', { tabId: oldTabId, enabled: false }, 3000); } catch { /* 忽略 */ }
      try { await sendCommand(previous, 'debugger.detach', { tabId: oldTabId }, 5000); } catch { /* 忽略 */ }
      if (params.releaseOld === true && session.borrowed === true) {
        try { await sendCommand(previous, 'tab.return', { tabId: oldTabId }, 3000); } catch { /* 忽略 */ }
      }
    }
  
    if (wanted !== Number(oldTabId)) {
      tabReservations.release(oldTabId, session.sessionId);
      // 旧 tab 的所有权租约随会话迁走；新 tab 的租约已在 claimTab 里拿到。
      if (lease) { try { lease.release(oldTabId, session.sessionId, { reason: 'rebind' }); } catch { /* 忽略 */ } }
      tabReservations.reserve(wanted, session.sessionId);
    }
    rebindSessionRecord(session, {
      instanceId: target.instanceId,
      tabId: wanted,
      windowId: info && Number.isInteger(info.windowId) ? info.windowId : 0,
      url: info && typeof info.url === 'string' ? info.url : '',
      title: info && typeof info.title === 'string' ? info.title : '',
    });
    // 控制记录跟着会话走：从旧 tab 摘掉，在新 tab 登记为主会话。
    if (Number(oldTabId) !== wanted) {
      tabControl.unregister(oldTabId, session.sessionId);
      tabControl.attach(wanted, session.sessionId);
      session.controlMode = (tabControl.status(wanted) || {}).mode || session.controlMode;
    }
    saveSessions();
  
    try { await sendCommand(target, 'dialog.arm', { tabId: wanted, policy: { queue: true } }, 5000); } catch (error) {
      log('session ' + session.sessionId + ' 重绑后对话框拦截失败（忽略）：' + ((error && error.message) || error));
    }
    try { await sendCommand(target, 'control-hint', { tabId: wanted, enabled: true }, 5000); } catch { /* 忽略 */ }
    if (previous && oldTabId && oldTabId !== wanted) sendInstanceEvent(previous, 'takeover.hide', { tabId: oldTabId });
    sendInstanceEvent(target, 'takeover.state', { tabId: wanted, sessionId: session.sessionId, paused: session.paused === true, borrowed: true });
    log(`session ${session.sessionId} 重绑到 tab=${wanted} instance=${target.instanceId}`);
    return sessionPublicView(session, {
      connected: instances.has(session.instanceId),
      phase: sessionState.phase(session.sessionId),
    });
  };
  return { rebindSession };
}
