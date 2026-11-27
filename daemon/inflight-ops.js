// daemon/inflight-ops.js —— 进行中的扩展命令列表/取消。
//
// 第十批 F 增补（只加不改）：
// - 可选注入 commandBoundary（daemon/command-boundary.js）：取消回包附带"取消边界"证据
//   （该方法的幂等性、取消后是否仍需人工 resolve）。既有返回字段 id/forwarded/accepted 不变；
//   inflightList 仍只返回原有字段（不新增默认字段，保持扩展页/CLI 既有解析）。
// - 取消仍然只是"转发"：不替账本结算，也不因为非幂等就拒绝取消。

export function createInflightOps({ inflight, instances, sendCommand, BridgeError, boundary = null }) {
function inflightList() {
    return [...inflight.values()].map((entry) => ({
      id: entry.id,
      instanceId: entry.instanceId,
      method: entry.method,
      tabId: entry.tabId,
      startedAt: entry.startedAt,
      elapsedMs: Date.now() - entry.startedAt,
    }));
  }
  
  async function cancelInflight(params) {
    const id = String(params && params.id ? params.id : '');
    if (!id) throw new BridgeError('E_BAD_ARG', 'command.cancel 需要命令 id');
    const entry = inflight.get(id);
    if (!entry) throw new BridgeError('E_NOT_FOUND', '没有进行中的命令 ' + id);
    if (entry.method === 'cancel') throw new BridgeError('E_BAD_ARG', '不能取消 cancel 命令');
    const instance = instances.get(entry.instanceId);
    if (!instance) throw new BridgeError('E_NO_BROWSER', '命令所属浏览器已断开');
    const result = await sendCommand(instance, 'cancel', { rpc_id: id }, 3000);
    const response = { id, forwarded: true, accepted: Boolean(result && result.cancelled === true) };
    // 新增证据只在注入 boundary 时出现；默认配置（旧调用点/单测）返回体逐字段不变。
    if (boundary && typeof boundary.cancelEvidence === 'function') {
      try {
        response.boundary = boundary.cancelEvidence({
          id,
          method: entry.method,
          startedAt: entry.startedAt,
          result,
          now: Date.now(),
        });
      } catch { /* 证据失败不影响取消结果 */ }
    }
    return response;
  }
  
  
  
  return { inflightList, cancelInflight };
}
