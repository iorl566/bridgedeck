// daemon/rpc.js —— POST /rpc 入口（从 server 拆出）。
//
// 通用取消（兼容目标 `cancel { rpc_id }`）：请求体里的 rpc_id / rpcId / id 会作为调用方
// 视角的 rpc id 进入 request-context，daemon→扩展 的 in-flight 条目会记住它，
// 于是另一个 `cancel { rpc_id }` 请求能精确找到并转发取消。
import { runWithRpcId } from './request-context.js';

export function createRpcHandler(ctx) {
  const { tokenMatches, readBody, sendJson, LOCAL_METHODS, EXT_METHODS, DEFAULT_TIMEOUT_MS, applySessionScope, dispatch, audit, logError } = ctx;
return async function handleRpcRequest(req, res) {
  if (!tokenMatches(req.headers['x-bridge-token'])) {
    sendJson(res, 401, { ok: false, error: { code: 'E_AUTH', message: 'invalid token' } });
    return;
  }
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: { code: 'E_BAD_REQUEST', message: err.message } });
    return;
  }
  let message;
  try {
    message = JSON.parse(raw || '{}');
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'E_BAD_JSON', message: 'request body is not valid JSON' } });
    return;
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const timeoutMs = Number(message.timeoutMs) > 0 ? Number(message.timeoutMs) : DEFAULT_TIMEOUT_MS;
  // 调用方 rpc id：兼容目标 用 rpc_id；兼容 JSON-RPC 习惯的 rpcId/id。
  const rpcId = message.rpc_id !== undefined ? message.rpc_id
    : (message.rpcId !== undefined ? message.rpcId : message.id);

  if (!LOCAL_METHODS.has(method) && !EXT_METHODS.has(method)) {
    // 方法不存在按 PROTOCOL §2 返回 404。
    sendJson(res, 404, { ok: false, error: { code: 'E_UNKNOWN_METHOD', message: `unknown method: ${method}` } });
    return;
  }

  const startedAtMs = Date.now();
  try {
    applySessionScope(params);
    const result = await runWithRpcId(rpcId, () => dispatch(method, params, timeoutMs));
    audit(method, params, result, null, Date.now() - startedAtMs);
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    audit(method, params, null, err, Date.now() - startedAtMs);
    const code = err && err.code ? err.code : 'E_INTERNAL';
    const text = err && err.message ? err.message : String(err);
    if (code !== 'E_TIMEOUT' && code !== 'E_NO_SESSION' && code !== 'E_NO_BROWSER' && code !== 'E_BAD_ARG') {
      logError(`rpc ${method} 失败 ${code}: ${text}`);
    }
    const payload = { code, message: text };
    if (err && err.data !== undefined) payload.data = err.data;
    sendJson(res, 200, { ok: false, error: payload });
  }
}
}
