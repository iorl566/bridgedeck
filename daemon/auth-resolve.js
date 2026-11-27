// daemon/auth-resolve.js —— token/scope/keyId 解析（从 server 拆出）。

export function createAuthResolve({ pairing, deviceStore, getLocalTrust, authKeyId }) {
  let localTrust;
  const refresh = () => { localTrust = getLocalTrust(); };

function scopeForRemoteToken(token) {
    if (!token) return 'control';
    const pairedScope = pairing.scopeForToken(token);
    if (pairedScope) return pairedScope;
    const record = deviceStore.recordForToken(token);
    return (record && record.scope === 'read') ? 'read' : 'control';
  }
  
  function isPairTokenValid(token) {
    if (!token) return false;
    if (pairing.validToken(token)) return true;
    // rotation pending token 也可用于连接（等待 commit）。
    return deviceStore.verify(token) || Boolean(deviceStore.recordForToken(token));
  }
  
  /** 根据客户端发来的 keyId 找回密钥；不把明文 token 放进 hello。 */
  function findAuthSecret(keyId) {
    if (!keyId) return null;
    if (localTrust.token && authKeyId(localTrust.token) === keyId) {
      return { token: localTrust.token, local: true, remote: false, browserId: localTrust.browserId || '' };
    }
    if (localTrust.rotationToken && localTrust.rotationUntil > Date.now() && authKeyId(localTrust.rotationToken) === keyId) {
      return { token: localTrust.rotationToken, local: true, remote: false, rotation: true, browserId: localTrust.browserId || '' };
    }
    const paired = pairing.findByKeyId(keyId);
    if (paired) {
      return { token: paired.token, local: false, remote: true, scope: paired.scope === 'read' ? 'read' : 'control' };
    }
    const deviceToken = deviceStore.secretForKeyId(keyId);
    if (deviceToken) {
      const record = deviceStore.recordForToken(deviceToken);
      return { token: deviceToken, local: false, remote: true, scope: deviceStore.scopeForToken(deviceToken) || 'control', browserId: (record && record.browserId) || '' };
    }
    const rotation = deviceStore.rotationForKeyId(keyId);
    if (rotation) {
      return { token: rotation.token, local: false, remote: true, rotation: true, scope: rotation.scope === 'read' ? 'read' : 'control', browserId: rotation.browserId || '' };
    }
    return null;
  }
  return {
    scopeForRemoteToken: (token) => { refresh(); return scopeForRemoteToken(token); },
    isPairTokenValid: (token) => { refresh(); return isPairTokenValid(token); },
    findAuthSecret: (keyId) => { refresh(); return findAuthSecret(keyId); },
  };
}
