// daemon/auth-commit.js —— 分阶段 commit（从 server 拆出）。

export function createAuthCommit({ deviceStore, getLocalTrust, saveLocalTrust, commitProofFor, log }) {
  return function handleAuthCommit(instance, conn, msg) {
    const localTrust = getLocalTrust();
  const txn = String(msg.txn || '').slice(0, 64);
  const token = instance.pairToken || '';
  const proof = String(msg.proof || '');
  if (!txn || !token || !proof || proof !== commitProofFor(token, txn)) {
    try { conn.sendJson({ type: 'commit-error', code: 'E_AUTH_PROOF', message: 'commit 证明无效' }); } catch { /* 忽略 */ }
    log('auth-commit 被拒绝：证明无效');
    return;
  }
  if (instance.remote) {
    // rotation：新 token 的 commit 会把设备 token 切换为新值并清空 rotation 状态。
    const rotated = deviceStore.commitRotation(token, txn);
    if (rotated.ok) {
      try { conn.sendJson({ type: 'commit-ack', txn }); } catch { /* 忽略 */ }
      log('设备 rotation commit 完成（remote）');
      return;
    }
    if (rotated.code === 'E_AUTH_PROOF') {
      try { conn.sendJson({ type: 'commit-error', code: rotated.code, message: 'rotation 证明无效' }); } catch { /* 忽略 */ }
      return;
    }
    const result = deviceStore.commit(token, txn);
    if (!result.ok) {
      try { conn.sendJson({ type: 'commit-error', code: result.code || 'E_AUTH_PROOF', message: 'commit 失败' }); } catch { /* 忽略 */ }
      return;
    }
    try { conn.sendJson({ type: 'commit-ack', txn }); } catch { /* 忽略 */ }
    log('设备激活 commit 完成（remote）');
    return;
  }
  if (localTrust.rotationToken && token === localTrust.rotationToken && localTrust.rotationTxn === txn) {
    localTrust.token = localTrust.rotationToken;
    localTrust.rotationToken = '';
    localTrust.rotationTxn = '';
    localTrust.rotationUntil = 0;
    localTrust.pairedAt = Date.now();
    saveLocalTrust();
    try { conn.sendJson({ type: 'commit-ack', txn }); } catch { /* 忽略 */ }
    log('本机 rotation commit 完成');
    return;
  }
  if (localTrust.commitTxn && localTrust.commitTxn === txn) {
    localTrust.commitTxn = '';
    localTrust.commitUntil = 0;
    saveLocalTrust();
  }
  try { conn.sendJson({ type: 'commit-ack', txn }); } catch { /* 忽略 */ }
  log('本机激活 commit 完成');
  };
}
