// lib/device-store.mjs —— 远程设备凭据持久化。
//
// 远程扩展第一次用配对码连接成功后，daemon 记住 token，重启后仍可重连；
// 撤销后立即失效。token 明文只写 0600 文件（与 local-trust.json 同级别），
// 对外 list() 只返回 deviceId/hash 前缀，不返回 token。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function deviceIdForToken(token) {
  return tokenHash(token).slice(0, 12);
}

export function createDeviceStore(filePath, { now = Date.now } = {}) {
  let records = new Map(); // deviceId -> { deviceId, token, tokenHash, label, browser, instanceId, scope, createdAt, lastSeenAt }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const item of Array.isArray(raw && raw.devices) ? raw.devices : []) {
        if (!item || typeof item.token !== 'string' || !item.token) continue;
        const id = String(item.deviceId || deviceIdForToken(item.token));
        records.set(id, {
          deviceId: id,
          token: item.token,
          tokenHash: tokenHash(item.token),
          label: typeof item.label === 'string' ? item.label.slice(0, 80) : '',
          browser: typeof item.browser === 'string' ? item.browser.slice(0, 40) : '',
          browserId: typeof item.browserId === 'string' ? item.browserId.slice(0, 64) : '',
          instanceId: typeof item.instanceId === 'string' ? item.instanceId.slice(0, 80) : '',
          scope: item.scope === 'read' ? 'read' : 'control',
          status: item.status === 'pending' ? 'pending' : 'active',
          commitTxn: typeof item.commitTxn === 'string' ? item.commitTxn : '',
          pendingUntil: Number(item.pendingUntil) || 0,
          rotationToken: typeof item.rotationToken === 'string' ? item.rotationToken : '',
          rotationTokenHash: typeof item.rotationTokenHash === 'string' ? item.rotationTokenHash : '',
          rotationTxn: typeof item.rotationTxn === 'string' ? item.rotationTxn : '',
          rotationUntil: Number(item.rotationUntil) || 0,
          createdAt: Number(item.createdAt) || now(),
          lastSeenAt: Number(item.lastSeenAt) || Number(item.createdAt) || now(),
        });
      }
    } catch {
      records = new Map();
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temp = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
      fs.writeFileSync(temp, JSON.stringify({ version: 1, devices: [...records.values()] }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, filePath);
      try { fs.chmodSync(filePath, 0o600); } catch { /* Windows 忽略 */ }
    } catch {
      // 凭据落盘失败不阻断当前连接；下次连接会重新配对。
    }
  }

  function findRecord(token) {
    if (!token) return null;
    const hash = tokenHash(token);
    for (const record of records.values()) {
      if (record.tokenHash === hash) return record;
    }
    return null;
  }

  function remember(token, info = {}) {
    if (!token) return null;
    const hash = tokenHash(token);
    const existing = findRecord(token);
    const id = existing ? existing.deviceId : deviceIdForToken(token);
    const record = {
      deviceId: id,
      token: String(token),
      tokenHash: hash,
      label: typeof info.label === 'string' ? info.label.slice(0, 80) : (existing ? existing.label : ''),
      browser: typeof info.browser === 'string' ? info.browser.slice(0, 40) : (existing ? existing.browser : ''),
      browserId: typeof info.browserId === 'string' ? info.browserId.slice(0, 64) : (existing ? existing.browserId : ''),
      instanceId: typeof info.instanceId === 'string' ? info.instanceId.slice(0, 80) : (existing ? existing.instanceId : ''),
      scope: info.scope === 'read' ? 'read' : (info.scope === 'control' ? 'control' : (existing ? existing.scope : 'control')),
      status: info.status === 'pending' ? 'pending' : (existing ? existing.status : 'active'),
      commitTxn: typeof info.commitTxn === 'string' ? info.commitTxn : (existing ? existing.commitTxn : ''),
      pendingUntil: Number.isFinite(Number(info.pendingUntil)) && Number(info.pendingUntil) > 0 ? Number(info.pendingUntil) : (existing ? existing.pendingUntil : 0),
      createdAt: existing ? existing.createdAt : now(),
      lastSeenAt: now(),
    };
    records.set(id, record);
    save();
    return publicView(record);
  }

  function sweepPending(at = now()) {
    let changed = false;
    for (const [id, record] of records) {
      if (record.status === 'pending' && record.pendingUntil > 0 && record.pendingUntil < at) {
        records.delete(id);
        changed = true;
        continue;
      }
      if (record.rotationToken && record.rotationUntil > 0 && record.rotationUntil < at) {
        record.rotationToken = '';
        record.rotationTokenHash = '';
        record.rotationTxn = '';
        record.rotationUntil = 0;
        changed = true;
      }
    }
    if (changed) save();
  }

  function verify(token) {
    sweepPending();
    return Boolean(findRecord(token));
  }

  function scopeForToken(token) {
    const record = findRecord(token);
    return record ? record.scope : null;
  }

  function recordForToken(token) {
    sweepPending();
    return findRecord(token) || findRotationRecord(token);
  }

  function findRotationRecord(token) {
    if (!token) return null;
    for (const record of records.values()) {
      if (record.rotationToken && record.rotationToken === String(token) && record.rotationUntil > now()) return record;
    }
    return null;
  }

  /** 分阶段 rotation：新 token 先 pending，扩展 commit 后才替换旧 token。 */
  function beginRotation(deviceId) {
    const record = records.get(String(deviceId || ''));
    if (!record) return null;
    const token = crypto.randomBytes(16).toString('hex');
    const txn = crypto.randomBytes(8).toString('hex');
    record.rotationToken = token;
    record.rotationTokenHash = tokenHash(token);
    record.rotationTxn = txn;
    record.rotationUntil = now() + 10 * 60 * 1000;
    save();
    return { deviceId: record.deviceId, token, txn, expiresAt: record.rotationUntil, oldTokenHash: record.tokenHash, scope: record.scope };
  }

  function commitRotation(token, txn) {
    const record = findRotationRecord(token);
    if (!record) return { ok: false, code: 'E_NOT_FOUND' };
    if (!record.rotationTxn || String(txn || '') !== record.rotationTxn) return { ok: false, code: 'E_AUTH_PROOF' };
    record.token = record.rotationToken;
    record.tokenHash = record.rotationTokenHash;
    record.rotationToken = '';
    record.rotationTokenHash = '';
    record.rotationTxn = '';
    record.rotationUntil = 0;
    record.status = 'active';
    record.lastSeenAt = now();
    save();
    return { ok: true, deviceId: record.deviceId };
  }

  function rotationForKeyId(keyId) {
    if (!keyId) return null;
    for (const record of records.values()) {
      if (record.rotationTokenHash && record.rotationTokenHash.slice(0, 32) === String(keyId)) {
        return { ...publicView(record), token: record.rotationToken, txn: record.rotationTxn, title: 'rotation' };
      }
    }
    return null;
  }

  function secretForKeyId(keyId) {
    if (!keyId) return null;
    for (const record of records.values()) {
      if (record.tokenHash.slice(0, 32) === String(keyId)) return record.token;
    }
    return null;
  }

  /** 分阶段激活：先标记 pending（可断点恢复），扩展确认 commit 后才变 active。 */
  function beginActivation(token, info = {}) {
    const record = findRecord(token);
    if (!record) return null;
    record.status = 'pending';
    record.commitTxn = String(info.commitTxn || '');
    record.pendingUntil = Number(info.pendingUntil) > 0 ? Number(info.pendingUntil) : now() + 10 * 60 * 1000;
    if (info.browserId) record.browserId = String(info.browserId).slice(0, 64);
    save();
    return publicView(record);
  }

  /** 扩展用设备 token 对 txn 签名后确认激活；失败返回 { ok:false, code }。 */
  function commit(token, txn) {
    const record = findRecord(token);
    if (!record) return { ok: false, code: 'E_NOT_FOUND' };
    if (record.status !== 'pending') return { ok: true, alreadyActive: true };
    if (!record.commitTxn || String(txn || '') !== record.commitTxn) return { ok: false, code: 'E_AUTH_PROOF' };
    record.status = 'active';
    record.commitTxn = '';
    record.pendingUntil = 0;
    save();
    return { ok: true, alreadyActive: false };
  }

  function rotate(deviceId, info = {}) {
    const record = records.get(String(deviceId || ''));
    if (!record) return null;
    const oldTokenHash = record.tokenHash;
    const token = crypto.randomBytes(16).toString('hex');
    record.token = token;
    record.tokenHash = tokenHash(token);
    if (info.scope === 'read' || info.scope === 'control') record.scope = info.scope;
    // 手动轮换/续期立即生效，不进入 pending 状态。
    record.status = 'active';
    record.commitTxn = '';
    record.pendingUntil = 0;
    record.lastSeenAt = now();
    save();
    return { deviceId: record.deviceId, token, oldTokenHash, scope: record.scope };
  }

  function touch(token, info = {}) {
    const record = findRecord(token);
    if (!record) return null;
    if (typeof info.instanceId === 'string') record.instanceId = info.instanceId.slice(0, 80);
    if (typeof info.browserId === 'string' && info.browserId) record.browserId = info.browserId.slice(0, 64);
    if (typeof info.label === 'string' && info.label) record.label = info.label.slice(0, 80);
    record.lastSeenAt = now();
    save();
    return publicView(record);
  }

  function publicView(record) {
    if (!record) return null;
    return {
      deviceId: record.deviceId,
      label: record.label,
      browser: record.browser,
      browserId: record.browserId,
      instanceId: record.instanceId,
      scope: record.scope,
      status: record.status || 'active',
      rotationPending: Boolean(record.rotationToken),
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
    };
  }

  function list() {
    return [...records.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(publicView);
  }

  function revoke(idOrKeyId) {    const key = String(idOrKeyId || '');
    if (!key) return { revoked: false, deviceId: null };
    for (const [id, record] of records) {
      if (id === key || record.tokenHash === key || record.tokenHash.slice(0, 32) === key) {
        records.delete(id);
        save();
        return { revoked: true, deviceId: id, tokenHash: record.tokenHash };
      }
    }
    return { revoked: false, deviceId: null };
  }

  load();
  return {
    remember,
    verify,
    scopeForToken,
    touch,
    rotate,
    recordForToken,
    secretForKeyId,
    beginActivation,
    commit,
    beginRotation,
    commitRotation,
    rotationForKeyId,
    sweepPending,
    list,
    revoke,
    get size() { return records.size; },
  };
}
