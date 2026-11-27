// daemon/run-log-record.js —— 记录会话可回放步骤。

export function recordRunLog(route, method, result) {
  // 会话 run log：记录可回放的步骤（目标描述，不含输入值），供 session.run_log / recipe draft。
    if (route.session && route.session.runLog && result && typeof result === 'object') {
      const receipt = result.receipt && typeof result.receipt === 'object' ? result.receipt : null;
      const runParams = route.params || {};
      const paramTarget = (runParams.ref || runParams.selector || runParams.text)
        ? {
          ...(runParams.ref ? { ref: runParams.ref } : {}),
          ...(runParams.selector ? { selector: runParams.selector } : {}),
          ...(runParams.text ? { text: runParams.text } : {}),
        }
        : null;
      route.session.runLog.record({
        method,
        tabId: route.session.tabId,
        frameId: Number.isInteger(runParams.frameId) ? runParams.frameId : 0,
        url: typeof result.url === 'string' ? result.url : null,
        target: (receipt && receipt.target) || paramTarget,
        revision: receipt && Number.isInteger(receipt.revision) ? receipt.revision : (typeof result.revision === 'number' ? result.revision : null),
        effectState: receipt && receipt.effectState ? receipt.effectState : 'committed',
        ok: true,
      });
    }
  
}
