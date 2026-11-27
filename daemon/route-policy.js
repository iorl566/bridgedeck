// daemon/route-policy.js —— 会话 scope/域名/最小间隔策略。

export function createRoutePolicy({ BridgeError, isMutating, domainAllowed, sleep }) {
async function enforceSessionPolicy(route, method, params = route.params) {
    if (!route || !route.session) return;
    if (route.session.scope === 'read' && isMutating(method)) {
      throw new BridgeError('E_READ_ONLY', '会话是只读 scope，拒绝执行变更动作：' + method);
    }
    let targetUrl = '';
    if ((method === 'navigate' || method === 'tab.new' || method === 'download') && params && params.url) targetUrl = String(params.url);
    if (method === 'step' && params && params.action && typeof params.action === 'object') {
      const inner = params.action;
      const innerMethod = String(inner.method || inner.action || '');
      if (['navigate', 'tab.new', 'download'].includes(innerMethod) && inner.params && inner.params.url) targetUrl = String(inner.params.url);
    }
    if (targetUrl) {
      const decision = domainAllowed(route.session.allowDomains, route.session.denyDomains, targetUrl);
      if (!decision.allowed) throw new BridgeError('E_FORBIDDEN', '会话域名策略拒绝：' + decision.reason + '（' + targetUrl + '）');
    }
    if (isMutating(method) && route.session.minIntervalMs > 0) {
      const now = Date.now();
      const scheduled = Math.max(now, (Number(route.session.lastActionAt) || 0) + route.session.minIntervalMs);
      route.session.lastActionAt = scheduled;
      if (scheduled > now) await sleep(scheduled - now);
    }
  }
  
  
  return { enforceSessionPolicy };
}
