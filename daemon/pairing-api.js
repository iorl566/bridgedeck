// daemon/pairing-api.js —— 配对命令薄封装（从 server 拆出）。

export function createPairingApi({ pairing, BIND_ADDRESS, getLocalTrust, saveLocalTrust, wsUrlFor, crypto, log }) {
function prunePairings() {
    return pairing.prune();
  }
  
  function pairCreate(params = {}) {
    return pairing.create(params);
  }
  
  function pairList() {
    return pairing.list({ bind: BIND_ADDRESS, strict: getLocalTrust().strict === true });
  }
  
  function pairRedeem(params = {}) {
    return pairing.redeem(params);
  }
  
  function pairRenew(params = {}) {
    return pairing.renew(params);
  }
  
  function pairRevoke(params = {}) {
    return pairing.revoke(params);
  }
  
  /** 分阶段 rotation：本机旋转先 pending，扩展用新 token 连接并 commit 后才替换旧 token。 */
  function pairRotate() {
    const token = crypto.randomBytes(24).toString('hex');
    const txn = crypto.randomBytes(8).toString('hex');
    getLocalTrust().rotationToken = token;
    getLocalTrust().rotationTxn = txn;
    getLocalTrust().rotationUntil = Date.now() + 10 * 60 * 1000;
    saveLocalTrust();
    log('本机 rotation 已开始（pending，旧 token commit 前仍有效）');
    return {
      ok: true,
      rotated: true,
      pending: true,
      token,
      txn,
      expiresAt: getLocalTrust().rotationUntil,
      link: wsUrlFor('') + '#' + token,
    };
  }
  return { prunePairings, pairCreate, pairList, pairRedeem, pairRenew, pairRevoke, pairRotate };
}
