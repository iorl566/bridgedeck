// src/input-lease.js —— 原生输入租约：同一 tab 同时只允许一个动作派发鼠标/键盘。
//
// 我们的命令分发已经按 tab 串行，但 plan/step、下载点击、截图坐标点击等多条路径
// 都可能在边界上交叉；租约提供显式的「谁在输入」事实、TTL 与 orphan 清理。
import { bridgeError } from './errors.js';

function makeToken() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch { /* 忽略 */ }
  return 'lease-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

/**
 * @param {{ now?: () => number, defaultTtlMs?: number }} [options]
 */
export function createInputLeaseRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const defaultTtlMs = Number.isFinite(options.defaultTtlMs) && options.defaultTtlMs > 0 ? options.defaultTtlMs : 15000;
  const leases = new Map(); // tabId -> { token, owner, createdAt, expiresAt }

  function active(entry, at) {
    return Boolean(entry && entry.expiresAt > at);
  }

  function sweep() {
    const at = now();
    let removed = 0;
    for (const [tabId, entry] of [...leases]) {
      if (!active(entry, at)) {
        leases.delete(tabId);
        removed += 1;
      }
    }
    return removed;
  }

  function acquire(tabId, owner, ttlMs) {
    if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '输入租约需要 tabId');
    const at = now();
    const existing = leases.get(tabId);
    if (active(existing, at)) {
      throw bridgeError('E_INPUT_BUSY', '该标签页正在执行另一个输入动作：' + existing.owner, {
        tabId,
        owner: existing.owner,
        expiresInMs: Math.max(0, existing.expiresAt - at),
      });
    }
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : defaultTtlMs;
    const entry = {
      token: makeToken(),
      owner: String(owner || 'input'),
      createdAt: at,
      expiresAt: at + ttl,
    };
    leases.set(tabId, entry);
    return { ...entry, tabId };
  }

  function renew(tabId, token, ttlMs) {
    const existing = leases.get(tabId);
    if (!existing || existing.token !== token) return null;
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : defaultTtlMs;
    existing.expiresAt = now() + ttl;
    return { ...existing, tabId };
  }

  function release(tabId, token) {
    const existing = leases.get(tabId);
    if (!existing) return false;
    if (token !== undefined && token !== null && existing.token !== token) return false;
    leases.delete(tabId);
    return true;
  }

  function releaseOwner(owner) {
    let removed = 0;
    for (const [tabId, entry] of [...leases]) {
      if (entry.owner === owner) {
        leases.delete(tabId);
        removed += 1;
      }
    }
    return removed;
  }

  function clearTab(tabId) {
    return leases.delete(tabId);
  }

  function snapshot() {
    const at = now();
    return [...leases].map(([tabId, entry]) => ({
      tabId,
      owner: entry.owner,
      expiresInMs: Math.max(0, entry.expiresAt - at),
      active: active(entry, at),
    }));
  }

  return { acquire, renew, release, releaseOwner, clearTab, sweep, snapshot };
}

/** 扩展进程内共享的租约表。 */
export const inputLeases = createInputLeaseRegistry();

export function acquireInputLease(tabId, owner, ttlMs) {
  return inputLeases.acquire(tabId, owner, ttlMs);
}

export function releaseInputLease(tabId, token) {
  return inputLeases.release(tabId, token);
}

export function clearInputLeases(tabId) {
  return inputLeases.clearTab(tabId);
}
