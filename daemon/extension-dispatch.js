// daemon/extension-dispatch.js —— 扩展方法统一派发。

export function createExtensionDispatch({ prepareRoute, routePolicy, requireFeatures, verifyDecision, submitApi, saveSessions, sendInstanceEvent, sessionState = null }) {
async function dispatchExtension(method, params, timeoutMs) {
    const route = await prepareRoute(method, params);
    await routePolicy.enforceSessionPolicy(route, method, route.params);
    requireFeatures(route.instance, method, route.params);
    verifyDecision(route, method);
    const result = await submitApi.submitRouted(route, method, params, timeoutMs);
    // handback 是人工把控制权交回：daemon 必须同步解除暂停，否则下一条命令仍被 E_SESSION_PAUSED 拒绝。
    if (method === 'cooperate.handback' && route.session && route.session.paused === true) {
      route.session.paused = false;
      route.session.pausedBy = null;
      route.session.pausedAt = null;
      // handback 是人类把控制权交回：生命周期状态机同步 paused → ready。
      if (sessionState) { try { sessionState.resume(route.session.sessionId, { reason: 'cooperate-handback' }); } catch { /* 忽略 */ } }
      saveSessions();
      sendInstanceEvent(route.instance, 'takeover.state', {
        tabId: route.session.tabId,
        sessionId: route.session.sessionId,
        paused: false,
        pausedBy: null,
        borrowed: route.session.borrowed === true,
        controller: route.session.controller ?? null,
        project: route.session.controller?.project ?? null,
      });
    }
    return result;
  }
  
  
  return { dispatchExtension };
}
