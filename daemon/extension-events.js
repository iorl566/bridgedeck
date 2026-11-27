// daemon/extension-events.js —— 扩展事件（设置/人工输入/接管/tab 关闭）。

export function createExtensionEventHandler(ctx) {
  const { normalizeSettings, log, humanEventSeen, sessions, sendInstanceEvent, stopSession, aliases, releaseTransfersForSession, sessionState, sessionQueue, tabQueue, saveSessions, sessionLeases = null } = ctx;
return function handleExtensionEvent(instance, msg) {
  if (msg.event === 'settings' && msg.params && typeof msg.params === 'object') {
    const params = msg.params;
    instance.label = typeof params.label === 'string' ? params.label.trim().slice(0, 40) : '';
    instance.settings = normalizeSettings(params);
    log(`实例 ${instance.instanceId} 设置已更新 label="${instance.label}" borrowConfirm=${instance.settings.borrowConfirm} allowHelp=${instance.settings.allowHelp}`);
    return;
  }
  if ((msg.event === 'human.input' || msg.event === 'human.blur') && msg.params && Number.isInteger(msg.params.tabId)) {
    const tabId = msg.params.tabId;
    const now = Date.now();
    if (now - (humanEventSeen.get(tabId) || 0) < 200) return;
    humanEventSeen.set(tabId, now);
    for (const [sessionId, session] of sessions) {
      if (session.instanceId !== instance.instanceId || session.tabId !== tabId) continue;
      session.lastHumanInputAt = now;
      if (msg.event === 'human.input' && session.paused !== true) {
        session.paused = true;
        session.pausedBy = 'auto';
        session.pausedAt = now;
        // 生命周期状态机同步：ready → paused（人类接管），供 session.list.evidence 查询。
        try { sessionState.pause(sessionId, { reason: 'human-input-auto', by: 'auto' }); } catch { /* 忽略 */ }
        sendInstanceEvent(instance, 'takeover.state', { tabId, sessionId, paused: true, pausedBy: 'auto', borrowed: session.borrowed === true, controller: session.controller ?? null, project: session.controller?.project ?? null });
        log('session ' + sessionId + ' 人类输入 → 自动暂停');
      }
      break;
    }
    return;
  }
  if (msg.event === 'takeover.pause' && msg.params && Number.isInteger(msg.params.tabId)) {
    const tabId = msg.params.tabId;
    for (const [sessionId, session] of sessions) {
      if (session.instanceId === instance.instanceId && session.tabId === tabId) {
        session.paused = msg.params.paused === true;
        try {
          if (session.paused) sessionState.pause(sessionId, { reason: 'takeover-pause', by: 'human' });
          else sessionState.resume(sessionId, { reason: 'takeover-resume' });
        } catch { /* 忽略 */ }
        log('接管浮层切换暂停 session=' + sessionId + ' paused=' + session.paused);
        sendInstanceEvent(instance, 'takeover.state', { tabId, sessionId, paused: session.paused, borrowed: session.borrowed === true });
        break;
      }
    }
    return;
  }
  if (msg.event === 'takeover.stop' && msg.params && Number.isInteger(msg.params.tabId)) {
    const tabId = msg.params.tabId;
    for (const [sessionId, session] of sessions) {
      if (session.instanceId === instance.instanceId && session.tabId === tabId) {
        log('用户从接管浮层收回控制 session=' + sessionId + ' tab=' + tabId);
        stopSession({ sessionId }, 5000).catch((error) => log('收回控制失败：' + ((error && error.message) || error)));
        break;
      }
    }
    return;
  }
  if (msg.event === 'tab-removed' && msg.params && typeof msg.params.tabId === 'number') {
    const tabId = msg.params.tabId;
    for (const [sessionId, session] of sessions) {
      if (session.instanceId === instance.instanceId && session.tabId === tabId) {
        sessions.delete(sessionId);
        aliases.clear(sessionId);
        releaseTransfersForSession(sessionId);
        if (sessionLeases) { try { sessionLeases.release(tabId, sessionId, { reason: 'tab-removed' }); } catch { /* 忽略 */ } }
        sessionState.finish(sessionId);
        sessionQueue.drop(sessionId);
        tabQueue.drop('tab:' + tabId);
        sessionQueue.drop(sessionId);
        saveSessions();
        log(`tab ${tabId} 已关闭，移除 session ${sessionId}`);
      }
    }
    return;
  }
  log(`忽略扩展事件 event=${msg.event}`);
}
}
