// src/lib/passthrough-token.js —— 一次性 passthrough 令牌（TTL + 单次消费 + grantee 绑定）。
//
// 用途：Agent 临时“穿过”协作输入锁时，后台签发一个短租约令牌；消费方必须带
// 正确 grantee，且只能消费一次。令牌过期/已用/越权都返回结构化错误码，不抛异常。
// 存储有上限：超过上限按最早签发顺序驱逐（fail closed：被驱逐的令牌只会变成
// E_TOKEN_UNKNOWN，不会放行越权消费）。now 可注入以便单测时间旅行。
export const TOKEN_ERROR = {
  EXPIRED: 'E_TOKEN_EXPIRED',
  USED: 'E_TOKEN_USED',
  GRANTEE: 'E_TOKEN_GRANTEE',
  UNKNOWN: 'E_TOKEN_UNKNOWN',
  CAPACITY: 'E_TOKEN_CAPACITY',
  BAD_ARG: 'E_TOKEN_BAD_ARG',
};

const DEFAULT_TTL_MS = 30000;
const DEFAULT_CAP = 64;
const MASK_KEEP = 6;

let tokenSequence = 0;

function defaultTokenId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch { /* 无 crypto：退回随机串 */ }
  tokenSequence = (tokenSequence + 1) % 0xffffff;
  return 'pt-' + Date.now().toString(36) + '-' + tokenSequence.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeGrantee(grantee) {
  return typeof grantee === 'string' ? grantee.trim() : '';
}

function maskToken(token) {
  const text = String(token || '');
  return text.length <= MASK_KEEP * 2 ? text : text.slice(0, MASK_KEEP) + '…' + text.slice(-MASK_KEEP);
}

function fail(code, message, extra = {}) {
  return { ok: false, code, error: message, ...extra };
}

/**
 * 创建一个有界的 passthrough 令牌存储。
 * @param {{now?: () => number, ttlMs?: number, cap?: number, idFactory?: () => string}} [options]
 */
export function createPassthroughTokens(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const defaultTtlMs = positive(options.ttlMs, DEFAULT_TTL_MS);
  const defaultCap = Math.max(1, Math.floor(positive(options.cap, DEFAULT_CAP)));
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : defaultTokenId;
  const records = new Map(); // token -> { token, grantee, at, expiresAt, used, usedAt }
  const stats = { minted: 0, consumed: 0, expired: 0, evicted: 0, revoked: 0 };

  /** 清理过期记录；返回清理条数。 */
  function prune(at = now()) {
    let removed = 0;
    for (const [token, record] of records) {
      if (record.expiresAt <= at) {
        records.delete(token);
        removed += 1;
      }
    }
    if (removed) stats.expired += removed;
    return removed;
  }

  /** 签发一次性令牌；有界存储超出上限时驱逐最早签发的那条。 */
  function mint(mintOptions = {}) {
    const grantee = normalizeGrantee(mintOptions.grantee);
    if (!grantee) return fail(TOKEN_ERROR.BAD_ARG, 'mint 需要非空 grantee');
    const ttlMs = positive(mintOptions.ttlMs, defaultTtlMs);
    const cap = Math.max(1, Math.floor(positive(mintOptions.cap, defaultCap)));
    const at = now();
    prune(at);
    let evicted = 0;
    while (records.size >= cap) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
      evicted += 1;
    }
    stats.evicted += evicted;
    let token = String(idFactory());
    while (records.has(token)) token = String(idFactory());
    const record = { token, grantee, at, expiresAt: at + ttlMs, used: false, usedAt: 0 };
    records.set(token, record);
    stats.minted += 1;
    return { ok: true, token, grantee, at, ttlMs, expiresAt: record.expiresAt, evicted };
  }

  /** 单次消费：成功即标记已用；失败返回结构化错误码。 */
  function consume(token, grantee) {
    const id = typeof token === 'string' ? token : '';
    if (!id) return fail(TOKEN_ERROR.BAD_ARG, 'consume 需要 token');
    const at = now();
    const record = records.get(id);
    if (!record) return fail(TOKEN_ERROR.UNKNOWN, 'token 不存在或已被清理', { token: maskToken(id) });
    if (record.expiresAt <= at) {
      records.delete(id);
      stats.expired += 1;
      return fail(TOKEN_ERROR.EXPIRED, 'token 已过期', { token: maskToken(id), expiresAt: record.expiresAt });
    }
    if (record.used) return fail(TOKEN_ERROR.USED, 'token 已被消费', { token: maskToken(id), usedAt: record.usedAt });
    if (record.grantee !== normalizeGrantee(grantee)) {
      return fail(TOKEN_ERROR.GRANTEE, 'grantee 不匹配', { token: maskToken(id) });
    }
    record.used = true;
    record.usedAt = at;
    stats.consumed += 1;
    return { ok: true, token: id, grantee: record.grantee, at, usedAt: at, expiresAt: record.expiresAt };
  }

  /** 只读校验：不标记已用，不改存储（过期判定也不删除记录）。 */
  function verify(token, grantee) {
    const id = typeof token === 'string' ? token : '';
    if (!id) return fail(TOKEN_ERROR.BAD_ARG, 'verify 需要 token');
    const record = records.get(id);
    if (!record) return fail(TOKEN_ERROR.UNKNOWN, 'token 不存在或已被清理', { token: maskToken(id) });
    const at = now();
    if (record.expiresAt <= at) {
      return fail(TOKEN_ERROR.EXPIRED, 'token 已过期', { token: maskToken(id), expiresAt: record.expiresAt, remainingMs: 0 });
    }
    if (record.used) return fail(TOKEN_ERROR.USED, 'token 已被消费', { token: maskToken(id), usedAt: record.usedAt });
    const expected = grantee == null ? null : normalizeGrantee(grantee);
    if (expected != null && record.grantee !== expected) {
      return fail(TOKEN_ERROR.GRANTEE, 'grantee 不匹配', { token: maskToken(id) });
    }
    return { ok: true, token: id, grantee: record.grantee, used: false, expiresAt: record.expiresAt, remainingMs: Math.max(0, record.expiresAt - at) };
  }

  /** 撤销单个令牌（内容脚本拒绝/调用方放弃时用）。 */
  function revoke(token) {
    const id = typeof token === 'string' ? token : '';
    if (!id) return { ok: false, code: TOKEN_ERROR.BAD_ARG, revoked: false };
    const removed = records.delete(id);
    if (removed) stats.revoked += 1;
    return { ok: true, revoked: removed };
  }

  /** 撤销某个 grantee 名下的全部令牌（tab 清理/录制结束时用）。 */
  function clearGrantee(grantee) {
    const target = normalizeGrantee(grantee);
    let revoked = 0;
    for (const [token, record] of records) {
      if (record.grantee !== target) continue;
      records.delete(token);
      revoked += 1;
    }
    stats.revoked += revoked;
    return { ok: true, revoked };
  }

  function clear() {
    const cleared = records.size;
    records.clear();
    return { ok: true, cleared };
  }

  /** 只读摘要（token 打码，避免租约凭据进日志/诊断）。 */
  function list(grantee) {
    const target = grantee == null ? null : normalizeGrantee(grantee);
    return [...records.values()]
      .filter((record) => target == null || record.grantee === target)
      .map((record) => ({ token: maskToken(record.token), grantee: record.grantee, expiresAt: record.expiresAt, used: record.used, usedAt: record.usedAt }));
  }

  function counter() {
    return { ...stats, live: records.size };
  }

  return { mint, consume, verify, revoke, clearGrantee, clear, list, prune, counter };
}

/** 后台共享单例：cooperation.js 的 passthrough 租约都从这里签发。 */
export const passthroughTokens = createPassthroughTokens();
