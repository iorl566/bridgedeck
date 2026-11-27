// daemon/http-handler.js —— /health、/preview、/rpc 路由。

export function createHttpHandler({ health, previewHandler, rpcHandler, sendJson, logError }) {
function handleHttpRequest(req, res) {
    let pathname = '/';
    let requestUrl = null;
    try {
      requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      pathname = requestUrl.pathname;
    } catch { /* 保持默认 */ }
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, health.healthPayload());
      return;
    }
    if (requestUrl && pathname.startsWith('/preview')) {
      previewHandler.handlePreviewRequest(req, res, pathname, requestUrl).catch((err) => {
        try { sendJson(res, 500, { ok: false, error: { code: 'E_INTERNAL', message: (err && err.message) || 'preview error' } }); } catch { /* 忽略 */ }
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/rpc') {
      rpcHandler(req, res).catch((err) => {
        logError(`处理 /rpc 异常：${err && err.stack ? err.stack : err}`);
        try { sendJson(res, 500, { ok: false, error: { code: 'E_INTERNAL', message: 'internal error' } }); } catch { /* 忽略 */ }
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: 'E_NOT_FOUND', message: `no route: ${req.method} ${pathname}` } });
  }
  
  
  return handleHttpRequest;
}
