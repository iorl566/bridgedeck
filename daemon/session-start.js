// daemon/session-start.js —— session.start：新建/共享/借用标签页。
import { SessionRunLog } from '../lib/run-log.mjs';

export function createSessionStart({ log, isControllerInfo, BridgeError, normalizeStartToken, startJournal, sessions, instances, tabControls, findInstanceForTab, crypto, tabReservations, getBorrowConfirm, sendCommand, pickInstance, newSessionId, sessionState, createSessionRecord, normalizeDomains, saveSessions, tabControl, sendInstanceEvent, lease = null }) {
async function startSession(params, timeoutMs) {  const traceStart = Date.now();
    const traceStep = (label) => {
      if (process.env.BB_DAEMON_TRACE === '1') log(`session.start ${label} +${Date.now() - traceStart}ms`);
    };
    const controller = params.controller;
    if (controller !== undefined && !isControllerInfo(controller)) {
      throw new BridgeError('E_BAD_ARG', 'session.start 的 controller 需要 name（1-80 字符），可选 project（1-120 字符）与 #rrggbb 颜色');
    }
    const callerScope = params.scope === undefined || params.scope === null ? '' : String(params.scope).trim().slice(0, 80);
    if (params.scope !== undefined && params.scope !== null && !callerScope) {
      throw new BridgeError('E_BAD_ARG', 'session.start 的 scope 不能为空字符串');
    }
    // 可恢复启动：token 幂等。同一个 requestId 重试返回既有会话；进行中的同一 token 拒绝并给出状态。
    let requestToken = null;
    if (params.requestId !== undefined && params.requestId !== null) {
      try {
        requestToken = normalizeStartToken(String(params.requestId));
      } catch (error) {
        throw new BridgeError('E_BAD_ARG', String((error && error.message) || error));
      }
      const existing = startJournal.get(requestToken);
      if (existing) {
        if (existing.state === 'cancelled') {
          throw new BridgeError('E_REQUEST_CANCELLED', '该 requestId 已被取消，请重新生成', { requestId: requestToken, state: existing.state });
        }
        if ((existing.state === 'ready' || existing.state === 'claimed') && existing.result && sessions.has(existing.result.sessionId)) {
          return { ...existing.result, reused: true };
        }
        if (existing.state === 'starting' && Date.now() - Number(existing.at || 0) < 120000) {
          throw new BridgeError('E_START_PENDING', '同一 requestId 的启动仍在进行中；稍后用同一 requestId 重试即可取回会话', {
            requestId: requestToken,
            startedAt: existing.at || null,
          });
        }
      }
      startJournal.begin(requestToken, { browser: params.browser ?? null, noFocus: params.noFocus === true });
    }
    let claim = null;
    let leaseTabId = null;
    let sessionId = null;
    try {
    let instance;
    let tabId = null;
    let windowId = 0;
    let url = '';
    let title = '';
    let borrowed = false;
    let shared = false;
    let ownerSession = null;
  
    if (params.share === true) {
      if (params.tab === undefined || params.tab === null) throw new BridgeError('E_BAD_ARG', 'session.start --share 需要 --tab <tabId>');
      const wanted = Number(params.tab);
      if (!Number.isInteger(wanted)) throw new BridgeError('E_BAD_ARG', 'session.start 的 tab 需要整数 tabId');
      const owner = tabControls.tabOwnerSession(wanted);
      const ownerRecord = owner ? sessions.get(owner) : null;
      if (!owner || !ownerRecord) throw new BridgeError('E_NO_SESSION', '共享 tab 需要该标签页已有会话；先由主会话 session.start');
      instance = instances.get(ownerRecord.instanceId);
      if (!instance) throw new BridgeError('E_NO_BROWSER', '共享 tab 所属浏览器已断开');
      tabId = wanted;
      windowId = ownerRecord.windowId;
      url = ownerRecord.url || '';
      title = ownerRecord.title || '';
      shared = true;
      ownerSession = owner;
    } else if (params.tab !== undefined && params.tab !== null) {
      const wanted = Number(params.tab);
      if (!Number.isInteger(wanted)) throw new BridgeError('E_BAD_ARG', 'session.start 的 tab 需要整数 tabId');
      instance = await findInstanceForTab(wanted);
      if (!instance) throw new BridgeError('E_NO_TAB', `tabId ${wanted} 不属于任何已连接的浏览器`);
      const ownerToken = 'start:' + crypto.randomUUID();
      claim = { tabId: wanted, owner: ownerToken };
      tabControls.claimTab(wanted, ownerToken);
      const borrowParams = { tabId: wanted };
      const borrowConfirm = getBorrowConfirm();
      if (typeof borrowConfirm === 'boolean') borrowParams.borrowConfirm = borrowConfirm;
      let info;
      try {
        info = await sendCommand(instance, 'tab.borrow', borrowParams, timeoutMs);
      } catch (error) {
        tabReservations.release(wanted, ownerToken);
        claim = null;
        throw error;
      }
      tabId = wanted;
      borrowed = true;
      windowId = info && Number.isInteger(info.windowId) ? info.windowId : 0;
      url = info && typeof info.url === 'string' ? info.url : '';
      title = info && typeof info.title === 'string' ? info.title : '';
    } else {
      instance = pickInstance(params.browser);
      const result = await sendCommand(instance, 'window.newAgent', { focus: params.focus === true, noFocus: params.noFocus === true, incognito: params.incognito === true }, timeoutMs);
      traceStep('window.newAgent');
      tabId = result && typeof result.tabId === 'number' ? result.tabId : null;
      if (tabId === null) throw new BridgeError('E_INTERNAL', 'window.ensureAgent 未返回 tabId');
      windowId = result && typeof result.windowId === 'number' ? result.windowId : 0;
      url = result && typeof result.url === 'string' ? result.url : '';
      title = result && typeof result.title === 'string' ? result.title : '';
    }
  
    sessionId = newSessionId();
    // 生命周期：preparing（开窗/借用 tab）→ starting（登记会话）→ ready（activate）。
    sessionState.prepare(sessionId, { reason: 'session-start' });
    // 新开 Agent 窗口拿到的 tab 也要登记所有权租约；--tab 借用分支已在 claimTab 里拿到租约。
    if (lease && !shared && !borrowed) {
      const acquired = lease.acquire(tabId, sessionId, { reason: 'session-start' });
      if (!acquired.ok) {
        throw new BridgeError(acquired.code || 'E_TAB_LEASE_HELD', acquired.message || '标签页所有权租约冲突', {
          ...(acquired.data || {}),
          tabId,
        });
      }
      leaseTabId = tabId;
    }
    sessionState.begin(sessionId);
    const sessionRecord = createSessionRecord({
      sessionId,
      instanceId: instance.instanceId,
      tabId,
      windowId,
      url,
      title,
      borrowed,
      shared,
      ownerSession,
      incognito: params.incognito === true,
      controller,
      scope: callerScope,
      allowDomains: normalizeDomains(params.allowDomains),
      denyDomains: normalizeDomains(params.denyDomains),
      minIntervalMs: Math.max(0, Math.min(Number(params.minIntervalMs) || 0, 5000)),
      controlMode: params.controlMode,
    });
    sessions.set(sessionId, sessionRecord);
    sessionRecord.runLog = new SessionRunLog();
    saveSessions({ immediate: true });
    if (claim) {
      tabReservations.transfer(claim.tabId, claim.owner, sessionId);
      if (lease) lease.transfer(claim.tabId, claim.owner, sessionId, { reason: 'session-start' });
      claim = null;
    } else if (shared && lease) {
      // 共享会话只作为参与者登记，不抢主会话的 holder。
      try { lease.join(tabId, sessionId, { reason: 'share-attach' }); } catch (error) {
        log('session ' + sessionId + ' 共享租约登记失败（忽略）：' + ((error && error.message) || error));
      }
    }
    // 共享 tab 的控制记录：主会话登记为 primary，共享会话 attach 到同一 tab；
    // 显式 --control 覆盖该 tab 的模式（open|exclusive）。
    let controlView = null;
    try {
      const wantedMode = tabControls.normalizeControlMode(params.controlMode);
      tabControl.attach(tabId, sessionId, { mode: wantedMode });
      if (wantedMode) tabControl.setMode(tabId, wantedMode, sessionId);
      controlView = tabControls.syncTabControl(tabId, { mode: wantedMode });
      if (controlView) {
        sessionRecord.controlMode = controlView.mode;
        if (wantedMode) tabControls.persistControlMode(tabId, controlView.mode);
        else saveSessions();
      }
    } catch (error) {
      log('session ' + sessionId + ' 登记共享控制失败（忽略）：' + ((error && error.message) || error));
    }
    log(`session ${sessionId} 创建 instance=${instance.instanceId} tab=${tabId}${shared ? '（共享）' : borrowed ? '（借用）' : ''}`);
    if (!shared) {
      // 自动挂载对话框拦截（queue 策略）：动作触发原生弹窗时先回 dialog_pending，由调用方决策。
      // 同一 tab 的命令按队列串行，因此这里不等待 arm 完成也不会让后续动作抢在拦截器之前。
      sendCommand(instance, 'dialog.arm', { tabId, policy: { queue: true } }, 5000)
        .then(() => traceStep('dialog.arm'))
        .catch((error) => {
          log('session ' + sessionId + ' 对话框拦截挂载失败（忽略）：' + ((error && error.message) || error));
        });
      // 接管浮层状态（新 UI 取代旧控制提示条）
      sendInstanceEvent(instance, 'takeover.state', { tabId, sessionId, paused: false, borrowed, controller: controller ?? null, project: controller?.project ?? null });
      try {
        // 控制提示是可见性 UI；不阻塞会话返回，注入失败也不影响控制权。
        sendCommand(instance, 'control-hint', { tabId, enabled: true }, 5000).catch(() => {});
        traceStep('control-hint');
      } catch (error) {
        log('session ' + sessionId + ' 控制提示注入失败（忽略）：' + ((error && error.message) || error));
      }
    }
    sessionState.activate(sessionId);
    traceStep('done');
    const started = { sessionId, tabId, windowId, instanceId: instance.instanceId, borrowed, shared, ownerSession };
    if (controlView) {
      started.control = {
        mode: controlView.mode,
        epoch: controlView.epoch,
        holder: controlView.holder,
        primary: controlView.primary,
        shared: controlView.shared,
        sessionCount: controlView.sessionCount,
      };
    }
    if (requestToken) startJournal.ready(requestToken, started);
    return started;
    } catch (error) {
      if (claim) {
        tabReservations.release(claim.tabId, claim.owner);
        if (lease) { try { lease.release(claim.tabId, claim.owner, { reason: 'start-failed' }); } catch { /* 忽略 */ } }
      }
      if (lease && leaseTabId != null) {
        try { lease.release(leaseTabId, sessionId, { reason: 'start-failed' }); } catch { /* 忽略 */ }
      }
      if (sessionId) {
        if (sessions.has(sessionId)) {
          const failedSession = sessions.get(sessionId);
          if (lease && failedSession) { try { lease.release(failedSession.tabId, sessionId, { reason: 'start-failed' }); } catch { /* 忽略 */ } }
          sessions.delete(sessionId);
        }
        try { sessionState.fail(sessionId, error); } catch { /* 忽略 */ }
      }
      if (requestToken) startJournal.fail(requestToken, (error && error.message) || error);
      throw error;
    }
  }
  
  /** session.rebind：把会话切到另一个标签页（可顺带归还旧的借用 tab）。 */
  // ---------------------------------------------------------------------------
  // 文件传输 staging（transfer.*）
  // 页面/CLI 只拿 opaque transferId；真实路径只在 daemon 内部与 daemon->扩展 出现。
  // ---------------------------------------------------------------------------
  
  /** 变异操作的账本目标：优先 tabId，其次用 session 解析出 tab。 */
  
  return { startSession };
}
