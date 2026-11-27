// daemon/transfer-ops.js —— transfer.* 本地 RPC 与下载结果 staging。
//
// 只做"会话解析 + 转发"：配额/续传/校验/清理逻辑全部在 daemon/transfer.mjs；
// 这里额外暴露 snapshot()/sweep()，供 daemon status views=transfers 与 CLI `bridge daemon transfer` 使用。
import { createTransferStore } from './transfer.mjs';

export function createTransferOps({ dir, log, BridgeError, resolveSession, policy = null, now = () => Date.now() }) {
  const store = createTransferStore({ dir, log, BridgeError, policy, now });

  function releaseTransfersForSession(sessionId) {
    return store.releaseForSession(sessionId);
  }

  function transferBegin(params = {}) {
    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    return store.begin({ sessionId: session.sessionId, name: params.name, byteSize: params.byteSize });
  }

  function transferChunk(params = {}) {
    return store.chunk(params);
  }

  function transferFinish(params = {}) {
    return store.finish(params);
  }

  function transferRead(params = {}) {
    return store.read(params);
  }

  function transferRelease(params = {}) {
    return store.release(params);
  }

  function injectTransferPaths(params = {}) {
    return store.injectPaths(params);
  }

  function stageDownloadResult(result, sessionId) {
    return store.stageDownload(result, sessionId);
  }

  /** transfer 域诊断快照（公共视图；不含 staging 路径）。 */
  function transferSnapshot(params = {}) {
    const limit = Number(params.limit);
    return store.snapshot({ limit: Number.isInteger(limit) && limit > 0 ? limit : 20 });
  }

  /** 失败清理：空闲未完成 / 过期已完成 staging。返回被回收的条目与字节数。 */
  function transferSweep() {
    return store.sweep();
  }

  return {
    releaseTransfersForSession,
    transferBegin,
    transferChunk,
    transferFinish,
    transferRead,
    transferRelease,
    injectTransferPaths,
    stageDownloadResult,
    transferSnapshot,
    transferSweep,
    get transferPolicy() { return store.policy; },
    get transferCounters() { return store.counters; },
    get transferSize() { return store.size; },
  };
}
