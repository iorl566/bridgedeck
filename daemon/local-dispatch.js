// daemon/local-dispatch.js —— 本地/控制面方法分发（从 dispatchInner 拆出）。
//
// 第十一批 G 追加：批处理会话（batch.plan/start/status/list/cancel/quota）与
// 跨会话租约裁决（lease.report/lease.arbitrate）。这些方法全部是 daemon 本地方法
// （不需要浏览器实例），真实入口在 daemon/server.mjs 的 localDispatch 装配处；
// 本文件只做 method → 函数的薄路由，保持与既有 case 同构。

export function createLocalDispatch(ctx) {
  const { buildStatus, browserList, startSession, prepareStartRequest, claimStartRequest, cancelStartRequest, startRequestStatus, stopSession, stopAllSessions, runLogView, sessionList, rebindSession, pauseSession, controlStatus, claimControl, releaseControl, handoffControl, setControlMode, viewCache, listAudit, getOperation, inflightList, cancelInflight, localTrustApi, pairingApi, dispatchExtension, broadcastSettingsSet, transferBegin, transferChunk, transferFinish, transferRead, transferRelease, batchPlan, batchStart, batchStatus, batchList, batchCancel, quotaSnapshot, leaseReport, leaseArbitrate, genericCancel, genericLedgerRequest, compatPing, compatHandshake, BridgeError } = ctx;
  return async function tryLocalDispatch(method, params, timeoutMs) {
    switch (method) {
    case 'status':
      return buildStatus(params);
    case 'browsers':
      return { browsers: browserList() };
    case 'session.start':
      return startSession(params, timeoutMs);
    case 'session.start_tracked':
      return startSession({ ...params, requestId: params.requestId ?? params.request_id }, timeoutMs);
    case 'session.request_prepare':
      return prepareStartRequest(params);
    case 'session.request_claim':
      return claimStartRequest(params);
    case 'session.request_cancel':
      return cancelStartRequest(params);
    case 'session.request_status':
      return startRequestStatus(params);
    case 'session.stop':
      return stopSession(params, timeoutMs);
    case 'session.stop_all':
      return stopAllSessions(params, timeoutMs);
    case 'session.run_log':
      return runLogView(params);
    case 'session.list':
      return { sessions: sessionList() };
    case 'session.rebind':
      return rebindSession(params, timeoutMs);
    case 'session.pause':
      return pauseSession(params, timeoutMs);
    case 'session.resume':
      return pauseSession({ ...params, paused: false }, timeoutMs);
    case 'session.control_status':
      return controlStatus(params);
    case 'session.claim_control':
      return claimControl(params);
    case 'session.release_control':
      return releaseControl(params);
    case 'session.handoff':
      return handoffControl(params);
    case 'session.control_mode':
      return setControlMode(params);
    case 'view':
      return viewCache(params);
    case 'audit.list':
      return listAudit(params);
    case 'operations.list':
      return listAudit(params);
    case 'operations.get':
      return getOperation(params.id);
    case 'inflight.list':
      return { commands: inflightList() };
    case 'command.cancel':
      return cancelInflight(params);
    // ---- 兼容目标 0.5.0 对齐：通用取消 + 通用账本入口（daemon 本地）----
    case 'cancel':
      return genericCancel(params);
    case 'ledger.request':
      return genericLedgerRequest(params);
    case 'system.ping':
      return compatPing(params);
    case 'system.handshake':
      return compatHandshake(params);
    case 'local.pair':
      return localTrustApi.localPairCreate(params);
    case 'local.trust':
      return localTrustApi.localTrustSet(params);
    case 'pair.create':
      return pairingApi.pairCreate(params);
    case 'pair.list':
      return pairingApi.pairList();
    case 'pair.redeem':
      return pairingApi.pairRedeem(params);
    case 'pair.revoke':
      return pairingApi.pairRevoke(params);
    case 'pair.renew':
      return pairingApi.pairRenew(params);
    case 'pair.rotate':
      return pairingApi.pairRotate();
    case 'settings.get':
      return dispatchExtension('settings.get', params, timeoutMs);
    case 'settings.set':
      return broadcastSettingsSet(params, timeoutMs);
    case 'transfer.begin':
      return transferBegin(params);
    case 'transfer.chunk':
      return transferChunk(params);
    case 'transfer.finish':
      return transferFinish(params);
    case 'transfer.read':
      return transferRead(params);
    case 'transfer.release':
      return transferRelease(params);
    // ---- 第十一批 G：批处理会话（配额 + 编排 + 状态）----
    case 'batch.plan':
      return batchPlan(params);
    case 'batch.start':
      return batchStart(params, timeoutMs);
    case 'batch.status': {
      const value = batchStatus(params);
      if (!value) throw new BridgeError('E_NOT_FOUND', '没有这个批次：' + String((params && params.batchId) || ''));
      return value;
    }
    case 'batch.list':
      return batchList(params);
    case 'batch.cancel':
      return batchCancel(params);
    case 'batch.quota':
      return quotaSnapshot(params);
    // ---- 第十一批 G：跨会话租约冲突裁决（默认 dry-run，apply 才写）----
    case 'lease.report':
      return leaseReport(params);
    case 'lease.arbitrate':
      return leaseArbitrate(params);
      default:
        return { handled: false };
    }
  };
}
