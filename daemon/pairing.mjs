// daemon/pairing.mjs —— 远程配对码/设备的生命周期（pair create/list/redeem/renew/revoke）。
//
// 状态（pairings / 失败计数）封装在本模块；deviceStore、instances、log、BridgeError 由 server 注入。
// 本机配对（local trust / daemon rotate）仍留在 server，因为它和 hello 鉴权状态耦合更紧。
import crypto from 'node:crypto';
import { normalizeEndpoint, pairProof, randomNonce } from '../lib/pair-proof.mjs';

export const PAIR_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export function createPairingModule({
  deviceStore,
  getInstances,
  dropInstance,
  log = () => {},
  BridgeError,
  wsUrlFor,
  authKeyId,
  pairTtlMs = 10 * 60 * 1000,
} = {}) {
  const pairings = new Map(); // code -> { code, token, serverNonce, url, expiresAt, label, scope, createdAt }
  let pairAttempts = 0;

  function prune() {
    const now = Date.now();
    for (const [code, item] of pairings) {
      if (item.expiresAt <= now) pairings.delete(code);
    }
  }

  function create(params = {}) {
    prune();
    if (params.replace === true) pairings.clear();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    do {
      code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
    } while (pairings.has(code));
    const ttl = Math.min(Math.max(Number(params.ttlMs) || pairTtlMs, 60_000), PAIR_MAX_TTL_MS);
    const item = {
      code,
      token: crypto.randomBytes(16).toString('hex'),
      serverNonce: randomNonce(),
      url: wsUrlFor(params.host ? String(params.host) : ''),
      expiresAt: Date.now() + ttl,
      label: typeof params.label === 'string' ? params.label.slice(0, 40) : '',
      scope: params.scope === 'read' ? 'read' : 'control',
      createdAt: Date.now(),
    };
    pairings.set(code, item);
    log('pair 创建 code=' + code + ' ttl=' + ttl + 'ms');
    return { ...item, link: item.url + '#' + item.token };
  }

  function list({ bind = '', strict = false } = {}) {
    prune();
    return {
      devices: [...getInstances()]
        .filter((instance) => instance.remote === true)
        .map((instance) => ({ instanceId: instance.instanceId, browser: instance.browser, browserVersion: instance.browserVersion, connectedAt: instance.connectedAt, localAuth: 'remote-paired', scope: instance.scope || 'control' })),
      pairings: [...pairings.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((item) => ({ code: item.code, url: item.url, label: item.label, scope: item.scope, expiresAt: item.expiresAt })),
      bind,
      strict: strict === true,
      knownDevices: deviceStore.list(),
    };
  }

  function redeem(params = {}) {
    prune();
    const code = String(params.code || '').trim().toUpperCase();
    const item = pairings.get(code);
    if (!item) {
      pairAttempts += 1;
      if (pairAttempts >= 5) {
        pairings.clear();
        pairAttempts = 0;
        log('pair redeem 失败次数过多：已清空所有 pending 配对码');
      }
      throw new BridgeError('E_PAIR_INVALID', '配对码无效或已过期');
    }
    pairAttempts = 0;
    const endpoint = normalizeEndpoint(item.url);
    const requestedEndpoint = params.endpoint ? normalizeEndpoint(params.endpoint) : '';
    if (requestedEndpoint && requestedEndpoint !== endpoint) {
      throw new BridgeError('E_PAIR_INVALID', '配对码与 endpoint 不匹配');
    }
    const clientNonce = params.clientNonce ? String(params.clientNonce).slice(0, 128) : randomNonce();
    const proof = pairProof(item.token, { endpoint, role: item.scope, clientNonce, serverNonce: item.serverNonce });
    return {
      ok: true,
      code: item.code,
      url: item.url,
      token: item.token,
      scope: item.scope,
      expiresAt: item.expiresAt,
      endpoint,
      clientNonce,
      serverNonce: item.serverNonce,
      proof,
    };
  }

  function renew(params = {}) {
    const deviceId = String(params.deviceId || '').trim();
    const rotation = deviceStore.beginRotation(deviceId);
    if (!rotation) throw new BridgeError('E_PAIR_INVALID', '设备不存在：' + deviceId);
    const url = wsUrlFor('');
    // 分阶段 rotation：旧 token 在 commit 前仍有效；扩展用新 token 连接并 auth-commit 后才切换。
    return {
      ok: true,
      deviceId: rotation.deviceId,
      token: rotation.token,
      txn: rotation.txn,
      expiresAt: rotation.expiresAt,
      url,
      link: url + '#' + rotation.token,
      scope: rotation.scope,
      pending: true,
    };
  }

  function revoke(params = {}) {
    const raw = String(params.deviceId || params.code || '').trim();
    const code = raw.toUpperCase();
    const item = pairings.get(code);
    const existed = pairings.delete(code);
    const known = deviceStore.revoke(raw) || { revoked: false, deviceId: null };
    if (!known.revoked && item) deviceStore.revoke(authKeyId(item.token));
    const revokedTokenHash = item ? authKeyId(item.token) : known.tokenHash;
    let kicked = 0;
    for (const instance of [...getInstances()]) {
      const matchesPair = item && instance.pairToken && instance.pairToken === item.token;
      const matchesDevice = revokedTokenHash && instance.pairToken && authKeyId(instance.pairToken) === revokedTokenHash.slice(0, 32);
      if (matchesPair || matchesDevice) {
        kicked += 1;
        try { instance.conn.close(4003, 'pair revoked'); } catch { /* 忽略 */ }
        dropInstance(instance, '配对已撤销');
      }
    }
    return { ok: true, revoked: existed || known.revoked, code: item ? code : '', deviceId: known.deviceId || null, kicked };
  }

  function findByToken(token) {
    if (!token) return null;
    prune();
    for (const item of pairings.values()) {
      if (item.token === token && item.expiresAt > Date.now()) return item;
    }
    return null;
  }

  function findByKeyId(keyId) {
    if (!keyId) return null;
    prune();
    for (const item of pairings.values()) {
      if (item.expiresAt > Date.now() && authKeyId(item.token) === keyId) return item;
    }
    return null;
  }

  function consume(code) {
    return pairings.delete(String(code || '').toUpperCase());
  }

  function scopeForToken(token) {
    const item = findByToken(token);
    return item ? (item.scope === 'read' ? 'read' : 'control') : null;
  }

  function validToken(token) {
    return Boolean(findByToken(token));
  }

  return {
    create,
    list,
    redeem,
    renew,
    revoke,
    prune,
    findByToken,
    findByKeyId,
    consume,
    scopeForToken,
    validToken,
    get size() { return pairings.size; },
  };
}
