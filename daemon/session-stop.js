// daemon/session-stop.js —— session.stop：清理标签/借用/控制权。

export function createSessionStop({ resolveSession, aliases, tabReservations, tabControls, tabControl, sessionState, sessions, instances, sendCommand, sendInstanceEvent, saveSessions, sessionPublicView, log, logError, BridgeError, sessionQueue, lease = null, releaseTransfersForSession }) {
  const stopSession = async function stopSession(params, timeoutMs) {

    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    aliases.clear(session.sessionId);
    tabReservations.release(session.tabId, session.sessionId);
    // 释放 tab 所有权租约：持有者离开时自动晋升下一个共享参与者（证据进 lease history）。
    if (lease) { try { lease.release(session.tabId, session.sessionId, { reason: 'session-stop' }); } catch (error) {
      log('session ' + session.sessionId + ' 释放 tab 租约失败（忽略）：' + ((error && error.message) || error));
    } }
    // 共享控制：先把本会话从 tab 控制记录里摘掉（顺带剔除已进入 stopping 的会话），
    // 再判定控制权/主会话身份要不要转交。必须在 requestStop 之前做，否则本会话
    // 已被标成 stopping，会被 sync 剔除而丢掉晋升信号。
    tabControls.syncTabControl(session.tabId);
    const controlOutcome = tabControl.unregister(session.tabId, session.sessionId);
    if (sessionState.requestStop(session.sessionId) === false) {
      return { ok: true, alreadyStopping: true, borrowed: session.borrowed === true };
    }
    sessionQueue.drop(session.sessionId);
    const instance = instances.get(session.instanceId);
    const closeTimeout = Math.min(Number(timeoutMs) > 0 ? Number(timeoutMs) : 15_000, 15_000);
    const shared = session.shared === true;
    const successorId = controlOutcome && controlOutcome.promotedTo && sessions.has(controlOutcome.promotedTo) && !shared
      ? controlOutcome.promotedTo
      : null;
    let handedOff = null;
    if (successorId) {
      const successor = sessions.get(successorId);
      successor.shared = false;
      successor.ownerSession = null;
      successor.controlMode = (controlOutcome.control && controlOutcome.control.mode) || successor.controlMode || 'open';
      for (const other of sessions.values()) {
        if (Number(other.tabId) === Number(session.tabId) && other.ownerSession === session.sessionId) {
          other.ownerSession = successorId;
        }
      }
      tabReservations.release(session.tabId, session.sessionId);
      tabReservations.reserve(session.tabId, successorId);
      handedOff = { sessionId: successorId, tabId: session.tabId };
      log(`session ${session.sessionId} 停止：共享 tab ${session.tabId} 的控制权/主会话转交 ${successorId}`);
    }
    if (instance && !shared && !successorId) {
      // 独立清理动作并行下发，避免 3-4 个 RTT 串行叠加到 session stop 上。
      const cleanup = [
        sendCommand(instance, 'dialog.disarm', { tabId: session.tabId }, 3000).catch(() => {}),
        sendCommand(instance, 'debugger.detach', { tabId: session.tabId }, 5000).catch((error) => {
          log(`session ${session.sessionId} 释放 debugger 失败（忽略）：${error && error.message}`);
        }),
      ];
      // 关闭标签页时控制提示会随页面消失，不必再单独下发；保留窗口/借用标签才需要。
      if (params.keep === true || session.borrowed === true) {
        cleanup.push(sendCommand(instance, 'control-hint', { tabId: session.tabId, enabled: false }, 3000).catch(() => {}));
      }
      // 关闭标签页时清理动作无需等待：标签页马上消失，dialog/debugger 的清理随页面一起结束。
      // 保留窗口或归还借用标签才需要确认清理完成。
      const closingTab = session.borrowed !== true && params.keep !== true;    if (closingTab) {
        for (const pending of cleanup) pending.catch(() => {});
      } else {
        await Promise.allSettled(cleanup);
      }
      if (session.borrowed === true) {
        // 借用的用户标签页：只清标记，不移动、不关闭。
        try {
          await sendCommand(instance, 'tab.return', { tabId: session.tabId }, Math.min(closeTimeout, 10_000));
        } catch (err) {
          logError(`session ${session.sessionId} 归还 tab 失败：${err.code || ''} ${err.message}`);
        }
      } else if (params.keep !== true) {
        try {
          await sendCommand(instance, 'tab.close', { tabId: session.tabId }, closeTimeout);
        } catch (err) {
          logError(`session ${session.sessionId} 关闭 tab 失败：${err.code || ''} ${err.message}`);
        }
        // 每个 session 独占一个 Agent 窗口：关闭标签页后窗口通常随之消失；这里只做兜底，
        // 不等待结果，避免会话结束被窗口关闭流程拖慢。
        if (Number.isInteger(session.windowId) && session.windowId > 0) {
          sendCommand(instance, 'window.close', { windowId: session.windowId }, Math.min(closeTimeout, 5000)).catch(() => {});
        }
      }
    }
    if (instance && !shared && !successorId) sendInstanceEvent(instance, 'takeover.hide', { tabId: session.tabId });
    if (instance && successorId) {
      const successor = sessions.get(successorId);
      sendInstanceEvent(instance, 'takeover.state', {
        tabId: session.tabId,
        sessionId: successorId,
        paused: successor.paused === true,
        pausedBy: successor.pausedBy || null,
        borrowed: successor.borrowed === true,
        controller: successor.controller ?? null,
        project: successor.controller?.project ?? null,
      });
    }
    releaseTransfersForSession(session.sessionId);
    sessions.delete(session.sessionId);
    sessionState.finish(session.sessionId);
    if (successorId) saveSessions({ immediate: true });
    log(`session ${session.sessionId} 已停止${session.borrowed ? '（归还借用标签页）' : params.keep === true ? '（保留窗口）' : ''}${handedOff ? '（tab 转交 ' + handedOff.sessionId + '）' : ''}`);
    return { ok: true, borrowed: session.borrowed === true, handedOff };
  
  };
  return { stopSession };
}
