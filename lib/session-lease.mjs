// lib/session-lease.mjs —— 多会话 tab 所有权租约（互斥 + 释放 + 冲突证据）。
//
// 背景：tab-reservations 只解决"两个 session.start --tab 同时通过空闲检查"的竞态，
// tab-control 只解决"共享 tab 上谁持有控制权"。两者都不回答“这个 tab 当前归哪个
// 会话所有、租约何时到期、为什么被拒”。兼容目标把 tab 所有权做成显式互斥租约；本模块
// 用同一套语义补齐：
//
// 1) 互斥：同一 tab 同时只能有一个 holder（独占租约）。他人 acquire 失败时返回
//    E_TAB_LEASE_HELD，data.conflict 带 holder / 何时取得 / 为什么 / 剩余租期 / epoch；
// 2) 租约：TTL（默认 60s，可续租）；到期后 holder 变空，参与者按接入顺序晋升；
// 3) 释放：holder 主动 release 时晋升下一个参与者；非 holder 参与者 release 只摘掉
//    自己，不影响 holder；force 需要显式 by，且会留下 evidence；
// 4) 多会话：共享 tab 用 join() 登记参与者（不抢 holder）；
// 5) 历史：每次 acquire/renew/release/expire/takeover/transfer 都进 events，冲突时
//    一并返回最近 5 条，供 CLI/日志解释。
//
// 纯内存、可注入 now/isSessionAlive，便于单测与 daemon 复用。

export const DEFAULT_LEASE_TTL_MS = 60_000;
export const MIN_LEASE_TTL_MS = 1_000;
export const MAX_LEASE_TTL_MS = 600_000;
export const LEASE_REASONS = Object.freeze([
  'session-start', 'tab-claim', 'rebind', 'share-attach', 'renew', 'release', 'expire',
  'takeover', 'handoff', 'transfer', 'session-stop', 'cleanup',
]);

function normalizeTtl(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.max(Math.round(num), MIN_LEASE_TTL_MS), MAX_LEASE_TTL_MS);
}

function toId(value) {
  if (value === undefined || value === null) return null;
  const id = String(value);
  return id || null;
}

function cloneEvent(event) {
  return event ? { ...event } : null;
}

export class SessionLeaseConflict extends Error {
  constructor(conflict) {
    const holder = conflict && conflict.holder ? conflict.holder : '(未知)';
    super(
      `标签页 ${conflict.tabId} 的所有权租约由会话 ${holder} 持有` +
      `（epoch ${conflict.epoch}，${conflict.reason || 'acquire'}，剩余 ${conflict.remainingMs}ms）：` +
      `会话 ${conflict.requestedBy} 的 ${conflict.requestedReason || 'acquire'} 被拒绝`,
    );
    this.name = 'SessionLeaseConflict';
    this.code = 'E_TAB_LEASE_HELD';
    this.data = { conflict };
  }
}

export class SessionLeaseNotHeld extends Error {
  constructor(conflict) {
    const holder = conflict && conflict.holder ? conflict.holder : '(空)';
    super(
      `会话 ${conflict.requestedBy} 不持有标签页 ${conflict.tabId} 的所有权租约` +
      `（当前 holder ${holder}）：release 被拒绝`,
    );
    this.name = 'SessionLeaseNotHeld';
    this.code = 'E_TAB_LEASE_NOT_HELD';
    this.data = { conflict };
  }
}

/**
 * @param {{now?: () => number, defaultTtlMs?: number, isSessionAlive?: (sessionId: string) => boolean, historyLimit?: number}} options
 */
export function createSessionLeases({
  now = () => Date.now(),
  defaultTtlMs = DEFAULT_LEASE_TTL_MS,
  isSessionAlive = () => true,
  historyLimit = 50,
} = {}) {
  const tabs = new Map();
  let seq = 0;

  function clock() {
    return typeof now === 'function' ? now() : Date.now();
  }

  function pushEvent(entry, type, detail = {}) {
    seq += 1;
    const event = {
      seq,
      at: clock(),
      type,
      tabId: entry.tabId,
      holder: entry.holder,
      epoch: entry.epoch,
      ...detail,
    };
    entry.events.push(event);
    const overflow = entry.events.length - Math.max(10, historyLimit);
    if (overflow > 0) entry.events.splice(0, overflow);
    entry.lastEvent = event;
    return event;
  }

  function participantsOf(entry) {
    return [...entry.participants.entries()]
      .map(([sessionId, meta]) => ({ sessionId, ...meta }))
      .sort((a, b) => (a.attachedAt || 0) - (b.attachedAt || 0));
  }

  function promote(entry, reason) {
    const candidates = participantsOf(entry).filter((item) => item.sessionId !== entry.holder);
    // 优先存活会话；都失联则按接入顺序取第一个（仍然给租约，由调用方清理）。
    const next = candidates.find((item) => item.sessionId !== entry.holder && isSessionAlive(item.sessionId)) || candidates[0];
    if (!next) {
      entry.holder = null;
      entry.leaseExpiresAt = 0;
      return null;
    }
    const from = entry.holder;
    entry.holder = next.sessionId;
    entry.leaseExpiresAt = clock() + entry.ttlMs;
    entry.epoch += 1;
    entry.reason = reason;
    pushEvent(entry, 'handoff', { from, to: next.sessionId, reason });
    return next.sessionId;
  }

  /** 结算过期：holder 租约到期 → 晋升参与者或清空。幂等。 */
  function settle(tabId) {
    const entry = tabs.get(Number(tabId));
    if (!entry) return null;
    if (!entry.holder) return view(entry);
    if (entry.leaseExpiresAt > 0 && clock() >= entry.leaseExpiresAt) {
      const from = entry.holder;
      const promotedTo = promote(entry, 'expire');
      if (!promotedTo) {
        entry.epoch += 1;
        entry.leaseExpiresAt = 0;
        entry.reason = 'expire';
        pushEvent(entry, 'expire', { from, to: null, reason: 'expire' });
      } else {
        pushEvent(entry, 'expire', { from, to: promotedTo, reason: 'expire' });
      }
    }
    return view(entry);
  }

  function conflictOf(entry, { requestedBy, requestedReason, reason }) {
    const remainingMs = entry.holder && entry.leaseExpiresAt > 0
      ? Math.max(0, entry.leaseExpiresAt - clock())
      : 0;
    return {
      tabId: entry.tabId,
      holder: entry.holder,
      holderSince: entry.holderSince,
      acquiredAt: entry.acquiredAt,
      expiresAt: entry.leaseExpiresAt,
      remainingMs,
      epoch: entry.epoch,
      reason: entry.reason,
      mode: entry.mode,
      requestedBy: requestedBy || entry.holder,
      requestedReason: requestedReason || reason || 'acquire',
      participants: participantsOf(entry).map((item) => ({ sessionId: item.sessionId, attachedAt: item.attachedAt })),
      history: entry.events.slice(-5).map(cloneEvent),
      at: clock(),
    };
  }

  function view(entry) {
    if (!entry) return null;
    const participants = participantsOf(entry);
    return {
      tabId: entry.tabId,
      holder: entry.holder,
      holderSince: entry.holderSince,
      acquiredAt: entry.acquiredAt,
      expiresAt: entry.leaseExpiresAt,
      leaseRemainingMs: entry.holder && entry.leaseExpiresAt > 0 ? Math.max(0, entry.leaseExpiresAt - clock()) : 0,
      ttlMs: entry.ttlMs,
      epoch: entry.epoch,
      mode: entry.mode,
      reason: entry.reason,
      shared: participants.length > 1,
      participantCount: participants.length,
      participants: participants.map((item) => ({ sessionId: item.sessionId, attachedAt: item.attachedAt, role: item.sessionId === entry.holder ? 'holder' : 'participant' })),
      since: entry.since,
      lastEvent: cloneEvent(entry.lastEvent),
      history: entry.events.slice(-5).map(cloneEvent),
    };
  }

  function attachParticipant(entry, sessionId, reason) {
    if (entry.participants.has(sessionId)) return false;
    entry.participants.set(sessionId, { attachedAt: clock(), reason });
    pushEvent(entry, 'attach', { to: sessionId, reason });
    return true;
  }

  function ensure(tabId) {
    const id = Number(tabId);
    if (!Number.isInteger(id)) {
      const error = new Error(`tabId 需要整数：${tabId}`);
      error.code = 'E_BAD_ARG';
      throw error;
    }
    let entry = tabs.get(id);
    if (!entry) {
      const at = clock();
      entry = {
        tabId: id,
        holder: null,
        holderSince: 0,
        acquiredAt: 0,
        leaseExpiresAt: 0,
        ttlMs: normalizeTtl(defaultTtlMs, DEFAULT_LEASE_TTL_MS),
        epoch: 0,
        mode: 'exclusive',
        reason: 'create',
        participants: new Map(),
        since: at,
        events: [],
        lastEvent: null,
      };
      tabs.set(id, entry);
    }
    return entry;
  }

  /**
   * 获取独占租约。
   * - 空闲：holder = sessionId，epoch + 1；
   * - 自己持有：续租（renewed）；
   * - 他人持有：如果持有人会话已失联（isSessionAlive=false）→ takeover，evidence 记录；
   *   否则返回 {ok:false, code:'E_TAB_LEASE_HELD', conflict}。
   */
  function acquire(tabId, sessionId, { ttlMs, reason = 'acquire', meta = {} } = {}) {
    const sid = toId(sessionId);
    if (!sid) {
      const error = new Error('acquire 需要 sessionId');
      error.code = 'E_BAD_ARG';
      throw error;
    }
    const entry = ensure(tabId);
    settle(entry.tabId);
    if (entry.holder && entry.holder !== sid && !isSessionAlive(entry.holder)) {
      const from = entry.holder;
      entry.holder = sid;
      entry.holderSince = clock();
      entry.acquiredAt = clock();
      entry.leaseExpiresAt = clock() + normalizeTtl(ttlMs, entry.ttlMs);
      entry.epoch += 1;
      entry.reason = reason;
      attachParticipant(entry, sid, reason);
      entry.participants.delete(from);
      pushEvent(entry, 'takeover', { from, to: sid, reason: String(reason || 'takeover'), evidence: meta });
      return { ok: true, acquired: true, renewed: false, takeover: true, lease: view(entry) };
    }
    if (entry.holder === sid) {
      entry.ttlMs = normalizeTtl(ttlMs, entry.ttlMs);
      entry.leaseExpiresAt = clock() + entry.ttlMs;
      entry.reason = reason;
      entry.participants.set(sid, entry.participants.get(sid) || { attachedAt: clock(), reason });
      pushEvent(entry, 'renew', { to: sid, reason: String(reason || 'renew'), meta });
      return { ok: true, acquired: false, renewed: true, lease: view(entry) };
    }
    if (entry.holder && entry.holder !== sid) {
      return {
        ok: false,
        code: 'E_TAB_LEASE_HELD',
        conflict: conflictOf(entry, { requestedBy: sid, requestedReason: reason, reason }),
        lease: view(entry),
      };
    }
    entry.holder = sid;
    entry.holderSince = clock();
    entry.acquiredAt = clock();
    entry.ttlMs = normalizeTtl(ttlMs, entry.ttlMs);
    entry.leaseExpiresAt = clock() + entry.ttlMs;
    entry.epoch += 1;
    entry.reason = reason;
    attachParticipant(entry, sid, reason);
    pushEvent(entry, 'acquire', { to: sid, reason: String(reason || 'acquire'), meta });
    return { ok: true, acquired: true, renewed: false, lease: view(entry) };
  }

  /**
   * 共享登记：把会话挂到已有 tab 租约上（--share）。不抢 holder：
   * - 已有 holder（存活）→ 只加参与者；
   * - 没有 holder → 自己成为 holder（与 acquire 一致）。
   */
  function join(tabId, sessionId, { ttlMs, reason = 'share-attach', meta = {} } = {}) {
    const sid = toId(sessionId);
    if (!sid) {
      const error = new Error('join 需要 sessionId');
      error.code = 'E_BAD_ARG';
      throw error;
    }
    const entry = ensure(tabId);
    settle(entry.tabId);
    if (!entry.holder) {
      const result = acquire(tabId, sid, { ttlMs, reason, meta });
      return { ...result, shared: false, joined: false };
    }
    const attached = attachParticipant(entry, sid, reason);
    if (entry.holder !== sid) {
      // 共享 tab 的租约时长不因参与者加入而改变；只记录证据。
      pushEvent(entry, 'join', { to: sid, holder: entry.holder, reason: String(reason || 'share-attach'), meta, attached });
    }
    return { ok: true, joined: attached, shared: true, holder: entry.holder, lease: view(entry) };
  }

  function renew(tabId, sessionId, { ttlMs, reason = 'renew' } = {}) {
    const sid = toId(sessionId);
    const entry = tabs.get(Number(tabId));
    if (!entry) return { ok: false, code: 'E_TAB_LEASE_NOT_HELD', conflict: { tabId: Number(tabId), holder: null, requestedBy: sid, reason: 'no-lease' } };
    settle(entry.tabId);
    if (entry.holder !== sid) {
      return { ok: false, code: 'E_TAB_LEASE_NOT_HELD', conflict: conflictOf(entry, { requestedBy: sid, requestedReason: reason }) };
    }
    entry.ttlMs = normalizeTtl(ttlMs, entry.ttlMs);
    entry.leaseExpiresAt = clock() + entry.ttlMs;
    entry.reason = reason;
    pushEvent(entry, 'renew', { to: sid, reason: String(reason || 'renew') });
    return { ok: true, renewed: true, lease: view(entry) };
  }

  function transfer(tabId, fromSessionId, toSessionId, { reason = 'transfer', ttlMs } = {}) {
    const from = toId(fromSessionId);
    const to = toId(toSessionId);
    const entry = tabs.get(Number(tabId));
    if (!entry) return false;
    settle(entry.tabId);
    if (!from || !to || entry.holder !== from) return false;
    entry.holder = to;
    entry.holderSince = clock();
    entry.acquiredAt = clock();
    entry.ttlMs = normalizeTtl(ttlMs, entry.ttlMs);
    entry.leaseExpiresAt = clock() + entry.ttlMs;
    entry.epoch += 1;
    entry.reason = reason;
    entry.participants.delete(from);
    attachParticipant(entry, to, reason);
    pushEvent(entry, 'transfer', { from, to, reason });
    return true;
  }

  /**
   * 释放：
   * - holder 释放 → 晋升参与者（handoff），没有参与者则删除租约；
   * - 非 holder 参与者释放 → 只摘自己（多会话清理）；
   * - 非参与者释放 → E_TAB_LEASE_NOT_HELD；
   * - force=true 需要显式 by，记录强制证据。
   */
  function release(tabId, sessionId, { reason = 'release', force = false, by = null } = {}) {
    const sid = toId(sessionId);
    const id = Number(tabId);
    const entry = tabs.get(id);
    if (!entry) return { ok: true, released: false, removed: false, reason: 'no-lease' };
    settle(entry.tabId);
    const isParticipant = entry.participants.has(sid);
    if (entry.holder !== sid) {
      if (isParticipant) {
        entry.participants.delete(sid);
        pushEvent(entry, 'detach', { from: sid, reason });
        return { ok: true, released: false, removed: true, holder: entry.holder, lease: view(entry) };
      }
      if (force && by) {
        const from = entry.holder;
        pushEvent(entry, 'force-release', { from, to: null, reason, by });
        entry.holder = null;
        entry.participants.delete(from);
        entry.leaseExpiresAt = 0;
        entry.epoch += 1;
        if (!entry.participants.size) tabs.delete(id);
        return { ok: true, released: true, removed: true, forced: true, evidence: { from, by, reason, at: clock() } };
      }
      return {
        ok: false,
        code: 'E_TAB_LEASE_NOT_HELD',
        conflict: conflictOf(entry, { requestedBy: sid, requestedReason: reason, reason }),
      };
    }
    const from = entry.holder;
    entry.participants.delete(sid);
    const promotedTo = promote(entry, 'release');
    if (!promotedTo) {
      entry.holder = null;
      entry.leaseExpiresAt = 0;
      tabs.delete(id);
      return { ok: true, released: true, promotedTo: null, lease: null, evidence: { from, at: clock() } };
    }
    // promote() 已经完成换代（epoch+1）与 handoff 证据；这里只补 release 事件。
    pushEvent(entry, 'release', { from, to: promotedTo, reason });
    return { ok: true, released: true, promotedTo, lease: view(entry) };
  }

  function status(tabId) {
    const entry = tabs.get(Number(tabId));
    if (!entry) return null;
    return settle(entry.tabId);
  }

  /** 冲突证据（不抛错）：谁持有 / 何时 / 为何 / 剩余租期。 */
  function conflict(tabId, sessionId, { reason = 'acquire' } = {}) {
    const entry = tabs.get(Number(tabId));
    if (!entry) return { tabId: Number(tabId), holder: null, clear: true, at: clock() };
    settle(entry.tabId);
    if (!entry.holder || entry.holder === toId(sessionId)) {
      return { tabId: Number(tabId), holder: entry.holder, clear: true, at: clock() };
    }
    return { tabId: Number(tabId), clear: false, ...conflictOf(entry, { requestedBy: toId(sessionId), requestedReason: reason }) };
  }

  function history(tabId, { limit = 20 } = {}) {
    const entry = tabs.get(Number(tabId));
    if (!entry) return [];
    return entry.events.slice(-Math.max(1, Number(limit) || 20)).map(cloneEvent);
  }

  function snapshot() {
    return [...tabs.keys()].sort((a, b) => a - b).map((tabId) => status(tabId)).filter(Boolean);
  }

  function ownerOf(tabId) {
    const entry = tabs.get(Number(tabId));
    if (!entry) return null;
    settle(entry.tabId);
    return entry.holder;
  }

  function participants(tabId) {
    const entry = tabs.get(Number(tabId));
    if (!entry) return [];
    return participantsOf(entry);
  }

  function clear() {
    tabs.clear();
  }

  return {
    acquire,
    join,
    renew,
    transfer,
    release,
    settle: (tabId) => settle(tabId),
    settleAll: () => snapshot(),
    status,
    conflict,
    history,
    snapshot,
    ownerOf,
    participants,
    clear,
  };
}
