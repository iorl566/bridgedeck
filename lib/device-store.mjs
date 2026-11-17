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
          instanceId: typeof item.instanceId === 'string' ? item.instanceId.slice(0, 80) : '',
          scope: item.scope === 'read' ? 'read' : 'control',
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
      instanceId: typeof info.instanceId === 'string' ? info.instanceId.slice(0, 80) : (existing ? existing.instanceId : ''),
      scope: info.scope === 'read' ? 'read' : (info.scope === 'control' ? 'control' : (existing ? existing.scope : 'control')),
      createdAt: existing ? existing.createdAt : now(),
      lastSeenAt: now(),
    };
    records.set(id, record);
    save();
    return publicView(record);
  }

  function verify(token) {
    return Boolean(findRecord(token));
  }

  function scopeForToken(token) {
    const record = findRecord(token);
    return record ? record.scope : null;
  }

  function secretForKeyId(keyId) {
    if (!keyId) return null;
    for (const record of records.values()) {
      if (record.tokenHash.slice(0, 32) === String(keyId)) return record.token;
    }
    return null;
  }

  function rotate(deviceId, info = {}) {
    const record = records.get(String(deviceId || ''));
    if (!record) return null;
    const oldTokenHash = record.tokenHash;
    const token = crypto.randomBytes(16).toString('hex');
    record.token = token;
    record.tokenHash = tokenHash(token);
    if (info.scope === 'read' || info.scope === 'control') record.scope = info.scope;
    record.lastSeenAt = now();
    save();
    return { deviceId: record.deviceId, token, oldTokenHash, scope: record.scope };
  }

  function touch(token, info = {}) {
    const record = findRecord(token);
    if (!record) return null;
    if (typeof info.instanceId === 'string') record.instanceId = info.instanceId.slice(0, 80);
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
      instanceId: record.instanceId,
      scope: record.scope,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
    };
  }

  function list() {
    return [...records.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(publicView);
  }

  function revoke(idOrKeyId) {
    const key = String(idOrKeyId || '');
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
    secretForKeyId,
    list,
    revoke,
    get size() { return records.size; },
  };
}
