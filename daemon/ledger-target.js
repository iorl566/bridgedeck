// daemon/ledger-target.js —— 账本目标与扩展路由判定。

export function createLedgerTarget({ resolveSession, EXT_METHODS }) {
function ledgerTarget(params) {
    const sessionId = params && (params.session !== undefined ? params.session : params.sessionId);
    if (sessionId === undefined || sessionId === null || sessionId === '') return { tabId: null, sessionId: null };
    try {
      const session = resolveSession(sessionId);
      return { tabId: session.tabId ?? null, sessionId: session.sessionId };
    } catch {
      return { tabId: null, sessionId: String(sessionId) };
    }
  }
  
  /**
   * 账本目标直接取自已解析的 route：sessionId/tabId 不再二次 resolveSession。
   * 直接按 tabId 操作的实例方法没有 session，用命令参数里的 tabId。
   */
  function ledgerTargetFromRoute(route) {
    const session = route && route.session ? route.session : null;
    const explicitTabId = route && route.params && Number.isInteger(route.params.tabId) ? route.params.tabId : null;
    const tabId = explicitTabId !== null ? explicitTabId : (session && Number.isInteger(session.tabId) ? session.tabId : null);
    return { tabId, sessionId: session ? session.sessionId : null };
  }
  
  /** 需要先 prepareRoute 才能确定账本目标的方法（扩展方法 + 唯一走 routeExtension 的本地方法）。 */
  function isExtensionRouted(method) {
    return EXT_METHODS.has(method) || method === 'settings.get';
  }
  
  
  return { ledgerTarget, ledgerTargetFromRoute, isExtensionRouted };
}
