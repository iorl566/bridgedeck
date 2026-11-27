// daemon/local-trust.js —— 本机配对/严格模式/验证码（从 server 拆出）。

export function createLocalTrustApi({ getLocalTrust, saveLocalTrust, createPairCode, wsUrlFor, LOCAL_PAIR_TTL_MS, instances, dropInstance, pairCodeMatches, log, crypto }) {
function localPairCreate(params = {}) {
    const token = crypto.randomBytes(16).toString('hex');
    const code = createPairCode();
    getLocalTrust().token = token;
    getLocalTrust().pendingUntil = Date.now() + LOCAL_PAIR_TTL_MS;
    getLocalTrust().pendingCode = code;
    if (params.replace) getLocalTrust().pairedAt = 0;
    saveLocalTrust();
    const link = wsUrlFor('') + '#' + token;
    log('本机配对链接已生成（5 分钟内有效）');
    return { ok: true, link, token, code, expiresAt: getLocalTrust().pendingUntil, strict: getLocalTrust().strict !== true };
  }
  function localTrustSet(params = {}) {
    getLocalTrust().strict = params.strict === true;
    saveLocalTrust();
    if (getLocalTrust().strict) {
      for (const instance of [...instances.values()]) {
        if (instance.localVerified !== true) {
          try { instance.conn.close(4003, 'local trust required'); } catch { /* 忽略 */ }
          dropInstance(instance, '本机严格模式：未配对连接被拒绝');
        }
      }
    }
    log('本机信任模式 strict=' + getLocalTrust().strict);
    return { ok: true, strict: getLocalTrust().strict };
  }
  function localPairVerified(token) {
    if (!token || !getLocalTrust().token) return false;
    // rotation 过期：丢弃 pending rotation，旧 token 继续有效。
    if (getLocalTrust().rotationToken && getLocalTrust().rotationUntil > 0 && getLocalTrust().rotationUntil < Date.now()) {
      getLocalTrust().rotationToken = '';
      getLocalTrust().rotationTxn = '';
      getLocalTrust().rotationUntil = 0;
      saveLocalTrust();
    }
    const matchesActive = token === getLocalTrust().token;
    const matchesRotation = Boolean(getLocalTrust().rotationToken) && token === getLocalTrust().rotationToken && getLocalTrust().rotationUntil > Date.now();
    if (!matchesActive && !matchesRotation) return false;
    // pending 的首次激活超过 10 分钟未 commit：token 作废（必须重新配对）。
    if (getLocalTrust().commitTxn && getLocalTrust().commitUntil > 0 && getLocalTrust().commitUntil < Date.now()) {
      getLocalTrust().commitTxn = '';
      getLocalTrust().commitUntil = 0;
      getLocalTrust().token = '';
      getLocalTrust().pendingUntil = 0;
      saveLocalTrust();
      return false;
    }
    // 配对成功后长期有效；从未使用过的链接 5 分钟后过期。
    if (getLocalTrust().pairedAt > 0) return true;
    return getLocalTrust().pendingUntil === 0 || getLocalTrust().pendingUntil > Date.now();
  }
  
  /** 新配对链接必须同时带 6 位确认码，防止只拿到链接就完成配对。 */
  function localPairCodeRequired() {
    return getLocalTrust().pendingUntil > Date.now() && Boolean(getLocalTrust().pendingCode);
  }
  function localPairCodeValid(message) {
    return !localPairCodeRequired() || pairCodeMatches(getLocalTrust().pendingCode, message && message.pairCode);
  }
  return { localPairCreate, localTrustSet, localPairVerified, localPairCodeRequired, localPairCodeValid };
}
