// lib/tab-control.mjs —— 共享 tab 的控制权 / 租约 / handoff 状态机。
//
// 同一标签页被多个 session 共享时（`session start --tab <id> --share`），只靠
// tab 级命令队列只能保证“命令串行”，不能回答“现在谁说了算”。这里补三件事：
//
// 1) 控制权持有者（holder）与控制代（epoch）：每次持有者变化 epoch + 1，
//    调用方可用 expectEpoch 做 CAS，避免基于过期控制权做转移/释放。
// 2) 租约（lease）：持有者的控制权有 TTL，写动作会续租；到期后 holder 变空，
//    控制权回到“空闲”，任意共享会话可以认领。
// 3) 转移语义：claim（认领/续租）、release（主动放弃）、handoff（显式转交）。
//
// 两种模式（按 tab）：
// - open（默认）：任何会话都能写；租约只记录“当前写者”，不拦动作（向后兼容，
//   对应 0.3.0 的“共享写”语义）。
// - exclusive：同一时刻只有一个会话能写；其他会话的变更动作返回
//   E_CONTROL_NOT_HELD。holder 为空时由第一次写动作自动认领（先到先得）。
//
// 本模块不依赖 daemon / 扩展 / 会话存储：只接收 tabId、sessionId、动作是否变异，
// 返回结构化判定结果，便于单测与复用。

export const CONTROL_MODES = ['open', 'exclusive'];
export const DEFAULT_CONTROL_LEASE_MS = 60_000;
export const MIN_CONTROL_LEASE_MS = 1_000;
export const MAX_CONTROL_LEASE_MS = 600_000;

function normalizeLeaseMs(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.max(Math.round(num), MIN_CONTROL_LEASE_MS), MAX_CONTROL_LEASE_MS);
}

function normalizeMode(value, fallback = '') {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return CONTROL_MODES.includes(text) ? text : fallback;
}

function idsOf(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (item === undefined || item === null) continue;
    const id = String(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export class TabControl {
  constructor({ now = () => Date.now(), defaultLeaseMs = DEFAULT_CONTROL_LEASE_MS, historyLimit = 20 } = {}) {
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.defaultLeaseMs = normalizeLeaseMs(defaultLeaseMs, DEFAULT_CONTROL_LEASE_MS);
    this.historyLimit = Math.max(1, Math.min(Number(historyLimit) || 20, 200));
    this.tabs = new Map();
  }

  // —— 内部：记录与失效 ——

  record(entry, reason, from, to) {
    const transition = { at: this.now(), reason, from: from === undefined ? null : from, to: to === undefined ? null : to, epoch: entry.epoch };
    entry.lastTransition = transition;
    entry.history.push(transition);
    const overflow = entry.history.length - this.historyLimit;
    if (overflow > 0) entry.history.splice(0, overflow);
    return transition;
  }

  /** 租约过期 → holder 变空，epoch + 1（幂等：只有真的过期才变）。 */
  settle(entry) {
    if (!entry) return null;
    if (entry.holder && entry.leaseExpiresAt > 0 && this.now() >= entry.leaseExpiresAt) {
      const from = entry.holder;
      entry.holder = null;
      entry.leaseExpiresAt = 0;
      entry.epoch += 1;
      this.record(entry, 'expire', from, null);
    }
    return entry;
  }

  grant(entry, sessionId, { reason = 'claim', leaseMs } = {}) {
    const from = entry.holder;
    entry.holder = String(sessionId);
    entry.leaseMs = normalizeLeaseMs(leaseMs, entry.leaseMs || this.defaultLeaseMs);
    entry.leaseExpiresAt = this.now() + entry.leaseMs;
    entry.epoch += 1;
    this.record(entry, reason, from, entry.holder);
    return entry;
  }

  renew(entry, { leaseMs } = {}) {
    entry.leaseMs = normalizeLeaseMs(leaseMs, entry.leaseMs || this.defaultLeaseMs);
    entry.leaseExpiresAt = this.now() + entry.leaseMs;
    return entry;
  }

  ensure(tabId, sessionId, { mode } = {}) {
    const id = Number(tabId);
    const existing = this.tabs.get(id);
    if (existing) return existing;
    const at = this.now();
    const entry = {
      tabId: id,
      sessions: new Set(),
      primary: null,
      holder: null,
      epoch: 0,
      mode: normalizeMode(mode, 'open'),
      leaseMs: this.defaultLeaseMs,
      leaseExpiresAt: 0,
      since: at,
      lastTransition: null,
      history: [],
    };
    this.tabs.set(id, entry);
    if (sessionId !== undefined && sessionId !== null) {
      const sid = String(sessionId);
      entry.sessions.add(sid);
      entry.primary = sid;
      entry.holder = sid;
      entry.leaseExpiresAt = at + entry.leaseMs;
      this.record(entry, 'create', null, sid);
    }
    return entry;
  }

  /** 对外快照（含派生的 shared / remaining）：调用前先 settle。 */
  view(entry) {
    if (!entry) return null;
    const now = this.now();
    const sessions = [...entry.sessions];
    return {
      tabId: entry.tabId,
      mode: entry.mode,
      epoch: entry.epoch,
      primary: entry.primary,
      holder: entry.holder,
      shared: sessions.length > 1,
      sessionCount: sessions.length,
      sessions,
      leaseMs: entry.leaseMs,
      leaseExpiresAt: entry.leaseExpiresAt || 0,
      leaseRemainingMs: entry.holder && entry.leaseExpiresAt > 0 ? Math.max(0, entry.leaseExpiresAt - now) : 0,
      holderIsPrimary: Boolean(entry.holder && entry.holder === entry.primary),
      since: entry.since,
      lastTransition: entry.lastTransition,
      history: entry.history.slice(-5),
    };
  }

  status(tabId) {
    const entry = this.tabs.get(Number(tabId));
    if (!entry) return null;
    this.settle(entry);
    return this.view(entry);
  }

  snapshot() {
    return [...this.tabs.keys()].sort((a, b) => a - b).map((tabId) => this.status(tabId)).filter(Boolean);
  }

  /** 用“当前会话集合”对齐登记表：新增补齐、消失剔除、主会话/holder 失效时重选。 */
  sync(tabId, sessionIds, { mode, primary } = {}) {
    const id = Number(tabId);
    const ids = idsOf(sessionIds);
    const existing = this.tabs.get(id);
    if (!ids.length) {
      if (existing) this.tabs.delete(id);
      return null;
    }
    const entry = existing || this.ensure(id, ids[0], { mode });
    const wanted = new Set(ids);
    let changed = false;
    for (const sid of [...entry.sessions]) {
      if (!wanted.has(sid)) {
        entry.sessions.delete(sid);
        changed = true;
      }
    }
    for (const sid of ids) {
      if (!entry.sessions.has(sid)) {
        entry.sessions.add(sid);
        changed = true;
      }
    }
    // 显式 primary 提示优先（daemon 的“非共享会话”就是主会话）；否则最老的会话。
    const wantedPrimary = primary !== undefined && primary !== null && wanted.has(String(primary)) ? String(primary) : null;
    if (wantedPrimary && entry.primary !== wantedPrimary) {
      const from = entry.primary;
      entry.primary = wantedPrimary;
      this.record(entry, 'primary', from, wantedPrimary);
      if (entry.holder === from) {
        entry.holder = wantedPrimary;
        entry.leaseExpiresAt = this.now() + (entry.leaseMs || this.defaultLeaseMs);
        entry.epoch += 1;
        this.record(entry, 'rebind', from, wantedPrimary);
      }
      changed = true;
    }
    if (!entry.primary || !wanted.has(entry.primary)) {
      entry.primary = ids[0];
      changed = true;
    }
    if (entry.holder && !wanted.has(entry.holder)) {
      const from = entry.holder;
      entry.holder = entry.primary;
      entry.leaseExpiresAt = this.now() + (entry.leaseMs || this.defaultLeaseMs);
      entry.epoch += 1;
      this.record(entry, 'rebind', from, entry.holder);
      changed = true;
    }
    if (mode !== undefined) {
      const next = normalizeMode(mode, '');
      if (next && next !== entry.mode) {
        entry.mode = next;
        this.record(entry, 'mode', null, next);
        changed = true;
      }
    }
    this.settle(entry);
    if (changed && !entry.sessions.size) {
      this.tabs.delete(id);
      return null;
    }
    return this.view(entry);
  }

  attach(tabId, sessionId, { mode } = {}) {
    const sid = String(sessionId);
    const entry = this.ensure(tabId, sid, { mode });
    if (!entry.sessions.has(sid)) {
      entry.sessions.add(sid);
      this.record(entry, 'attach', null, sid);
    }
    this.settle(entry);
    return { ok: true, control: this.view(entry) };
  }

  /**
   * 摘掉一个会话；返回主会话/控制权的继任者，供 daemon 决定“关不关 tab”。
   * - promotedTo：原主会话离开时接手“主会话”身份的会话（剩下最老的）。
   * - closed：整个 tab 的控制记录已清空（没有其他共享会话）。
   */
  unregister(tabId, sessionId) {
    const id = Number(tabId);
    const sid = String(sessionId);
    const entry = this.tabs.get(id);
    if (!entry) return { tabId: id, removed: false, promotedTo: null, closed: false, control: null };
    this.settle(entry);
    const removed = entry.sessions.delete(sid);
    if (!entry.sessions.size) {
      this.tabs.delete(id);
      return { tabId: id, removed, promotedTo: null, closed: true, control: null };
    }
    let promotedTo = null;
    if (entry.primary === sid) {
      promotedTo = [...entry.sessions][0];
      entry.primary = promotedTo;
      this.record(entry, 'promote', sid, promotedTo);
    }
    if (entry.holder === sid) {
      const from = entry.holder;
      entry.holder = entry.primary;
      entry.leaseMs = entry.leaseMs || this.defaultLeaseMs;
      entry.leaseExpiresAt = this.now() + entry.leaseMs;
      entry.epoch += 1;
      this.record(entry, 'handoff', from, entry.holder);
    }
    return { tabId: id, removed, promotedTo, closed: false, control: this.view(entry) };
  }

  setMode(tabId, mode, sessionId) {
    const next = normalizeMode(mode, '');
    if (!next) {
      return { ok: false, code: 'E_BAD_ARG', message: '控制权模式只支持 open|exclusive，收到 "' + String(mode) + '"', data: { mode: mode === undefined ? null : String(mode) } };
    }
    const entry = this.tabs.get(Number(tabId)) || (sessionId !== undefined ? this.ensure(tabId, sessionId) : null);
    if (!entry) {
      return { ok: false, code: 'E_NO_SESSION', message: '标签页 ' + tabId + ' 没有可管理的控制权记录', data: { tabId: Number(tabId) } };
    }
    this.settle(entry);
    if (entry.mode === next) return { ok: true, unchanged: true, control: this.view(entry) };
    entry.mode = next;
    this.record(entry, 'mode', null, next);
    return { ok: true, unchanged: false, control: this.view(entry) };
  }

  checkEpoch(entry, expectEpoch) {
    if (expectEpoch === undefined || expectEpoch === null) return null;
    const wanted = Number(expectEpoch);
    if (!Number.isInteger(wanted)) {
      return { ok: false, code: 'E_BAD_ARG', message: 'expectEpoch 需要整数，收到 "' + String(expectEpoch) + '"', data: { expectEpoch: String(expectEpoch) } };
    }
    if (wanted === entry.epoch) return null;
    return {
      ok: false,
      code: 'E_CONTROL_STALE',
      message: '控制权已换代（当前 epoch ' + entry.epoch + '，期望 ' + wanted + '）：重新读取 session control 后重试',
      data: { tabId: entry.tabId, epoch: entry.epoch, expectEpoch: wanted, holder: entry.holder, mode: entry.mode },
    };
  }

  notHeld(entry, sessionId, action) {
    return {
      ok: false,
      code: 'E_CONTROL_NOT_HELD',
      message: '会话 ' + sessionId + ' 不持有标签页 ' + entry.tabId + ' 的控制权（当前持有者 ' + (entry.holder || '无') + '）；' + action + ' 被拒绝',
      data: {
        tabId: entry.tabId,
        holder: entry.holder,
        epoch: entry.epoch,
        mode: entry.mode,
        leaseRemainingMs: entry.holder && entry.leaseExpiresAt > 0 ? Math.max(0, entry.leaseExpiresAt - this.now()) : 0,
        hint: 'bridge session handoff ' + (entry.holder || '<holder>') + ' --to ' + sessionId,
      },
    };
  }

  /** 显式认领：holder 为空才成功；已是自己则续租；被他人持有 → E_CONTROL_BUSY。 */
  claim(tabId, sessionId, { leaseMs, expectEpoch } = {}) {
    const sid = String(sessionId);
    const entry = this.ensure(tabId, sid);
    this.settle(entry);
    const stale = this.checkEpoch(entry, expectEpoch);
    if (stale) return stale;
    if (!entry.sessions.has(sid)) {
      entry.sessions.add(sid);
      this.record(entry, 'attach', null, sid);
    }
    if (entry.holder === sid) {
      this.renew(entry, { leaseMs });
      return { ok: true, renewed: true, acquired: false, control: this.view(entry) };
    }
    // 主会话是该 tab 的“家”，可以无条件收回被借出的控制权；共享会话不行。
    if (entry.primary === sid) {
      const from = entry.holder;
      this.grant(entry, sid, { reason: 'preempt', leaseMs });
      return { ok: true, renewed: false, acquired: true, preempted: from, control: this.view(entry) };
    }
    if (entry.holder) {
      const remaining = Math.max(0, entry.leaseExpiresAt - this.now());
      return {
        ok: false,
        code: 'E_CONTROL_BUSY',
        message: '标签页 ' + entry.tabId + ' 的控制权由会话 ' + entry.holder + ' 持有（epoch ' + entry.epoch + '，租约剩余 ' + remaining + 'ms）：先请对方 handoff，或等租约到期后重试',
        data: {
          tabId: entry.tabId,
          holder: entry.holder,
          epoch: entry.epoch,
          mode: entry.mode,
          leaseRemainingMs: remaining,
          hint: 'bridge session handoff ' + entry.holder + ' --to ' + sid,
        },
        control: this.view(entry),
      };
    }
    this.grant(entry, sid, { reason: 'claim', leaseMs });
    return { ok: true, renewed: false, acquired: true, control: this.view(entry) };
  }

  /** 主动放弃：必须是当前持有者；释放后 holder 为空，任意共享会话可再认领。 */
  release(tabId, sessionId, { expectEpoch } = {}) {
    const sid = String(sessionId);
    const entry = this.tabs.get(Number(tabId));
    if (!entry) {
      return { ok: false, code: 'E_NO_SESSION', message: '标签页 ' + tabId + ' 没有共享控制记录；先用 session start --tab <id> --share 建立共享会话', data: { tabId: Number(tabId) } };
    }
    this.settle(entry);
    const stale = this.checkEpoch(entry, expectEpoch);
    if (stale) return stale;
    if (entry.holder !== sid) return this.notHeld(entry, sid, 'release-control');
    entry.holder = null;
    entry.leaseExpiresAt = 0;
    entry.epoch += 1;
    this.record(entry, 'release', sid, null);
    return { ok: true, released: true, control: this.view(entry) };
  }

  /** 显式转交：只有当前持有者能发起，目标必须已在该 tab 上。 */
  handoff(tabId, fromSessionId, toSessionId, { leaseMs, expectEpoch } = {}) {
    const from = String(fromSessionId);
    const to = String(toSessionId === undefined || toSessionId === null ? '' : toSessionId);
    const entry = this.tabs.get(Number(tabId));
    if (!entry) {
      return { ok: false, code: 'E_NO_SESSION', message: '标签页 ' + tabId + ' 没有共享控制记录；先用 session start --tab <id> --share 建立共享会话', data: { tabId: Number(tabId) } };
    }
    this.settle(entry);
    const stale = this.checkEpoch(entry, expectEpoch);
    if (stale) return stale;
    if (!to) return { ok: false, code: 'E_BAD_ARG', message: 'handoff 需要目标会话（--to <targetSessionId>）', data: { tabId: entry.tabId } };
    if (to === from) return { ok: false, code: 'E_BAD_ARG', message: 'handoff 的源会话与目标会话相同：' + from, data: { tabId: entry.tabId, from, to } };
    if (!entry.sessions.has(to)) {
      return {
        ok: false,
        code: 'E_BAD_ARG',
        message: '目标会话 ' + to + ' 不在标签页 ' + entry.tabId + ' 上；先让它 session start --tab ' + entry.tabId + ' --share',
        data: { tabId: entry.tabId, from, to, sessions: [...entry.sessions] },
      };
    }
    if (entry.holder !== from) return this.notHeld(entry, from, 'handoff');
    this.grant(entry, to, { reason: 'handoff', leaseMs });
    return { ok: true, from, to, control: this.view(entry) };
  }

  /**
   * 派发闸门：变更动作前判定“能不能写”。
   * - tab 未登记 → ok（单会话 tab 不参与仲裁）
   * - 只读动作 → 永远放行（不续租）
   * - holder 是自己 → 续租
   * - exclusive 且 holder 是别人 → E_CONTROL_NOT_HELD
   * - holder 为空 → 认领（exclusive 是“先到先得”，open 是“记录当前写者”）
   */
  check(tabId, sessionId, { mutating = false, leaseMs, expectEpoch, method = '' } = {}) {
    const entry = this.tabs.get(Number(tabId));
    if (!entry) return { ok: true, control: null };
    this.settle(entry);
    const sid = String(sessionId);
    const stale = this.checkEpoch(entry, expectEpoch);
    if (stale) return stale;
    if (!entry.sessions.has(sid)) {
      entry.sessions.add(sid);
      this.record(entry, 'attach', null, sid);
    }
    if (!mutating) return { ok: true, control: this.view(entry), readOnly: true };
    if (entry.mode === 'exclusive' && entry.holder && entry.holder !== sid) {
      const remaining = Math.max(0, entry.leaseExpiresAt - this.now());
      return {
        ok: false,
        code: 'E_CONTROL_NOT_HELD',
        message: '共享标签页 ' + entry.tabId + ' 处于 exclusive 模式，控制权由会话 ' + entry.holder + ' 持有（epoch ' + entry.epoch + '，租约剩余 ' + remaining + 'ms）：' + method + ' 被拒绝',
        data: {
          tabId: entry.tabId,
          method,
          holder: entry.holder,
          epoch: entry.epoch,
          mode: entry.mode,
          leaseRemainingMs: remaining,
          hint: '等租约到期，或让持有者执行 bridge session handoff ' + entry.holder + ' --to ' + sid,
        },
      };
    }
    if (entry.holder === sid) {
      this.renew(entry, { leaseMs });
      return { ok: true, control: this.view(entry), renewed: true };
    }
    this.grant(entry, sid, { reason: entry.mode === 'exclusive' ? 'acquire' : 'implicit', leaseMs });
    return { ok: true, control: this.view(entry), acquired: true };
  }

  /** 仅续租：用于 daemon 在派发成功后刷新租约（不改 holder）。 */
  touch(tabId, sessionId, { leaseMs } = {}) {
    const entry = this.tabs.get(Number(tabId));
    if (!entry) return null;
    this.settle(entry);
    if (entry.holder !== String(sessionId)) return this.view(entry);
    this.renew(entry, { leaseMs });
    return this.view(entry);
  }

  forget(tabId) {
    return this.tabs.delete(Number(tabId));
  }

  clear() {
    this.tabs.clear();
  }
}
