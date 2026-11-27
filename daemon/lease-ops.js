// daemon/lease-ops.js —— daemon 侧多会话 tab 所有权租约的运行时服务。
//
// 分层：
//   lib/session-lease.mjs    租约本体（互斥/续租/handoff 的内存状态机）
//   daemon/lease-registry.js 纯判定（状态分类/冲突不变量/回收与续租计划/报告结构）
//   daemon/lease-ops.js      本文件：把上面两层接到 daemon 生命周期上
//
// 本模块负责：
//   1) 统一入口：acquire/join/renew/transfer/release/touch 都经过这里，成功与失败都写入
//      有界证据环（谁、哪个 tab、什么原因、结果、冲突摘要），供 status/日志/恢复报告消费；
//   2) 续租：touch() 在命令派发前核对租期，剩余不足一半时原地续租；renewDue() 按窗口批量续租；
//   3) 过期/崩溃残租回收：sweep() 先出计划再执行，只回收"持有者已失联"或显式允许的租约；
//      存活持有者的过期租约默认只提示（请续租），绝不因为 TTL 到点把活会话踢掉；
//   4) 会话↔租约对账：noteSessionStarted / noteSessionRebound / noteSessionStopped 记录生命周期，
//      reconcile() 只出计划（apply=true 时才补登），不自动抢别的会话的 holder；
//   5) 报告：report() 返回所有权矩阵 + 冲突 + 回收计划 + 续租候选 + 计数器 + 证据尾。
//
// 兼容性：默认不启动定时器（由 daemon 显式 startSweeper()）；所有方法对缺失/坏输入容错，
// 不改变既有 session.* 的返回载荷（租约证据只进 daemon 内部视图/日志）。

import {
  LEASE_EXPIRING_WINDOW_MS,
  LEASE_RENEW_WINDOW_MS,
  buildLeaseReport,
  buildOwnershipMatrix,
  buildTabOwnershipRow,
  classifyLeaseStatus,
  describeLeaseConflict,
  detectOwnershipConflicts,
  diffOwnershipMatrices,
  isStartToken,
  normalizeLeaseReason,
  normalizeSessionId,
  normalizeTabId,
  planExpiryReclaim,
  planLeaseReconcile,
  planRenewals,
  summarizeConflicts,
  summarizeLeaseStatus,
} from './lease-registry.js';

/** 默认定时回收间隔（与 transfer sweeper 同量级，不制造额外磁盘/CPU 压力）。 */
export const LEASE_OPS_DEFAULT_SWEEP_MS = 5_000;

/** 证据环默认容量（每条事件 < 300 字节，500 条约 150KB 内存上限）。 */
export const LEASE_OPS_EVIDENCE_LIMIT = 500;

/** 回收动作使用的操作者标识（force 路径必须显式 by）。 */
export const LEASE_SWEEPER_ACTOR = 'lease-sweeper';

/** 默认续租 TTL 下限/上限（与 lib 的 clamp 保持一致，避免把默认配置写坏）。 */
export const LEASE_OPS_TTL_MIN = 1_000;
export const LEASE_OPS_TTL_MAX = 600_000;

/** 事件类型（报告/断言用；不是协议错误码）。 */
export const LEASE_EVENT_TYPES = Object.freeze([
  'acquire', 'renew', 'touch', 'join', 'transfer', 'release', 'takeover',
  'conflict', 'reap', 'adopt', 'recover', 'sweep', 'error', 'reset',
]);

function createCounters() {
  const counters = { acquire: 0, renew: 0, touch: 0, join: 0, transfer: 0, release: 0, takeover: 0, conflict: 0, reap: 0, adopt: 0, recover: 0, sweep: 0, error: 0 };
  for (const type of LEASE_EVENT_TYPES) {
    if (!Object.prototype.hasOwnProperty.call(counters, type)) counters[type] = 0;
  }
  return counters;
}

function clampTtl(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.max(Math.round(number), LEASE_OPS_TTL_MIN), LEASE_OPS_TTL_MAX);
}

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 运行时租约服务。
 *
 * @param {{
 *   leases: object,                        // lib/session-lease createSessionLeases() 实例（必需）
 *   sessions?: Map<string, object>,        // daemon 会话表（活会话判定/所有权视图）
 *   sessionState?: object,                 // sessionState.phase(id) 提供生命周期证据
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   defaultTtlMs?: number,
 *   isAlive?: (sessionId: string) => boolean,
 *   evidenceLimit?: number,
 *   sweepIntervalMs?: number,
 *   recordTouches?: boolean,               // 是否逐条记录 touch（默认抽样，避免证据环被刷爆）
 *   touchSampleEvery?: number,
 *   onEvent?: (event: object) => void,
 * }} options
 */
export function createLeaseOps({
  leases,
  sessions = new Map(),
  sessionState = null,
  log = () => {},
  now = () => Date.now(),
  defaultTtlMs = 60_000,
  isAlive = null,
  evidenceLimit = LEASE_OPS_EVIDENCE_LIMIT,
  sweepIntervalMs = LEASE_OPS_DEFAULT_SWEEP_MS,
  recordTouches = false,
  touchSampleEvery = 20,
  onEvent = null,
} = {}) {
  if (!leases || typeof leases.acquire !== 'function' || typeof leases.status !== 'function') {
    throw new TypeError('createLeaseOps 需要 session lease 实例（lib/session-lease.mjs）');
  }
  const ttlMs = clampTtl(defaultTtlMs, 60_000);
  const limit = Number.isInteger(Number(evidenceLimit)) && Number(evidenceLimit) > 0
    ? Number(evidenceLimit)
    : LEASE_OPS_EVIDENCE_LIMIT;
  const intervalMs = Number.isInteger(Number(sweepIntervalMs)) && Number(sweepIntervalMs) >= 250
    ? Number(sweepIntervalMs)
    : LEASE_OPS_DEFAULT_SWEEP_MS;
  const sampleEvery = Number.isInteger(Number(touchSampleEvery)) && Number(touchSampleEvery) > 0
    ? Number(touchSampleEvery)
    : 20;
  const counters = createCounters();
  const events = [];
  let seq = 0;
  let sweeper = null;
  let sweeperState = { running: false, intervalMs, startedAt: 0, ticks: 0, actions: 0, lastRunAt: 0, lastError: null };
  let lastSweep = null;
  let lastReconcile = null;
  let lastMatrix = null;
  let touchCount = 0;

  function clock() {
    return typeof now === 'function' ? Number(now()) || Date.now() : Date.now();
  }

  function phaseOf(sessionId) {
    if (!sessionState) return null;
    const id = text(sessionId);
    if (!id) return null;
    try {
      if (typeof sessionState.phase === 'function') return sessionState.phase(id) || null;
      if (typeof sessionState.canonicalPhase === 'function') return sessionState.canonicalPhase(id) || null;
    } catch { /* 状态机异常不影响租约 */ }
    return null;
  }

  function defaultIsAlive(sessionId) {
    const id = text(sessionId);
    if (!id) return false;
    if (isStartToken(id)) return true;
    if (sessions instanceof Map && sessions.has(id)) {
      const phase = phaseOf(id);
      return phase !== 'stopped';
    }
    if (typeof isAlive === 'function') {
      try { return isAlive(id) === true; } catch { return false; }
    }
    return false;
  }

  function sessionRecords() {
    if (!(sessions instanceof Map)) return [];
    return [...sessions.values()].map((session) => ({
      sessionId: session && session.sessionId,
      tabId: session && session.tabId,
      startedAt: Number(session && session.startedAt) || 0,
      shared: session && session.shared === true,
      borrowed: session && session.borrowed === true,
    }));
  }

  function phasesMap() {
    const map = {};
    for (const session of sessionRecords()) {
      const id = normalizeSessionId(session.sessionId);
      if (id) map[id] = phaseOf(id);
    }
    return map;
  }

  function record(type, detail = {}) {
    seq += 1;
    const event = {
      seq,
      at: clock(),
      type,
      ...detail,
    };
    events.push(event);
    const overflow = events.length - limit;
    if (overflow > 0) events.splice(0, overflow);
    if (Object.prototype.hasOwnProperty.call(counters, type)) counters[type] += 1;
    if (typeof onEvent === 'function') {
      try { onEvent(event); } catch { /* 观察者异常不影响租约操作 */ }
    }
    return event;
  }

  function failure(code, message, extra = {}) {
    return { ok: false, code, message, ...extra };
  }

  /** 所有权视图行（单 tab）。 */
  function ownershipOf(tabId) {
    const id = normalizeTabId(tabId);
    if (id === null) return null;
    const status = leases.status(id);
    const records = sessionRecords().filter((item) => Number(item.tabId) === id);
    const conflicts = detectOwnershipConflicts({
      leases: leases.snapshot ? leases.snapshot() : [],
      sessions: records,
      phases: phasesMap(),
      now: clock(),
      isAlive: defaultIsAlive,
    });
    return buildTabOwnershipRow({
      tabId: id,
      lease: status,
      tabSessions: records,
      phases: phasesMap(),
      now: clock(),
      isAlive: defaultIsAlive,
      conflicts,
    });
  }

  /** 获取独占租约（冲突返回结构化证据，不抛错）。 */
  function acquire(tabId, sessionId, { reason = 'tab-claim', ttlMs: ttlOverride = null, meta = {} } = {}) {
    const id = normalizeTabId(tabId);
    const sid = normalizeSessionId(sessionId);
    if (id === null || !sid) return failure('E_BAD_ARG', 'acquire 需要整数 tabId 与非空 sessionId');
    const why = normalizeLeaseReason(reason, 'tab-claim');
    let result;
    try {
      result = leases.acquire(id, sid, { ttlMs: ttlOverride == null ? ttlMs : clampTtl(ttlOverride, ttlMs), reason: why, meta });
    } catch (error) {
      record('error', { tabId: id, sessionId: sid, reason: why, op: 'acquire', code: (error && error.code) || 'E_INTERNAL', message: text(error && error.message) });
      return failure('E_INTERNAL', 'acquire 异常：' + text(error && error.message), { tabId: id, sessionId: sid });
    }
    if (result && result.ok === false) {
      record('conflict', {
        tabId: id,
        sessionId: sid,
        reason: why,
        op: 'acquire',
        holder: result.conflict ? result.conflict.holder : null,
        epoch: result.conflict ? result.conflict.epoch : 0,
        remainingMs: result.conflict ? result.conflict.remainingMs : 0,
      });
      return result;
    }
    const type = result.takeover ? 'takeover' : result.renewed ? 'renew' : 'acquire';
    record(type, {
      tabId: id,
      sessionId: sid,
      reason: why,
      epoch: result.lease ? result.lease.epoch : 0,
      remainingMs: result.lease ? result.lease.leaseRemainingMs : 0,
      meta,
    });
    return result;
  }

  /** 共享登记（不抢 holder）。 */
  function join(tabId, sessionId, { reason = 'share-attach', ttlMs: ttlOverride = null, meta = {} } = {}) {
    const id = normalizeTabId(tabId);
    const sid = normalizeSessionId(sessionId);
    if (id === null || !sid) return failure('E_BAD_ARG', 'join 需要整数 tabId 与非空 sessionId');
    const why = normalizeLeaseReason(reason, 'share-attach');
    let result;
    try {
      result = leases.join(id, sid, { ttlMs: ttlOverride == null ? ttlMs : clampTtl(ttlOverride, ttlMs), reason: why, meta });
    } catch (error) {
      record('error', { tabId: id, sessionId: sid, reason: why, op: 'join', code: (error && error.code) || 'E_INTERNAL', message: text(error && error.message) });
      return failure('E_INTERNAL', 'join 异常：' + text(error && error.message), { tabId: id, sessionId: sid });
    }
    if (result && result.ok === false) {
      record('conflict', { tabId: id, sessionId: sid, reason: why, op: 'join', holder: result.conflict ? result.conflict.holder : null });
      return result;
    }
    record('join', {
      tabId: id,
      sessionId: sid,
      reason: why,
      holder: result.holder || (result.lease ? result.lease.holder : null),
      joined: result.joined === true,
      epoch: result.lease ? result.lease.epoch : 0,
    });
    return result;
  }

  /** 续租（仅 holder；非 holder 返回 E_TAB_LEASE_NOT_HELD 证据）。 */
  function renew(tabId, sessionId, { reason = 'renew', ttlMs: ttlOverride = null } = {}) {
    const id = normalizeTabId(tabId);
    const sid = normalizeSessionId(sessionId);
    if (id === null || !sid) return failure('E_BAD_ARG', 'renew 需要整数 tabId 与非空 sessionId');
    const why = normalizeLeaseReason(reason, 'renew');
    let result;
    try {
      result = leases.renew(id, sid, { ttlMs: ttlOverride == null ? ttlMs : clampTtl(ttlOverride, ttlMs), reason: why });
    } catch (error) {
      record('error', { tabId: id, sessionId: sid, reason: why, op: 'renew', code: (error && error.code) || 'E_INTERNAL', message: text(error && error.message) });
      return failure('E_INTERNAL', 'renew 异常：' + text(error && error.message), { tabId: id, sessionId: sid });
    }
    if (result && result.ok === false) {
      record('conflict', {
        tabId: id,
        sessionId: sid,
        reason: why,
        op: 'renew',
        holder: result.conflict ? result.conflict.holder : null,
        code: result.code || 'E_TAB_LEASE_NOT_HELD',
      });
      return result;
    }
    record('renew', { tabId: id, sessionId: sid, reason: why, remainingMs: result.lease ? result.lease.leaseRemainingMs : 0 });
    return result;
  }

  /**
   * 命令派发前的租约 touch：
   * - 剩余租期充足（> ttl/2）→ 只返回 fresh 证据，不续租、不写事件（避免事件环被刷爆）；
   * - 剩余不足一半或已过期 → 原地续租（不换代、不写 handoff）；
   * - 非 holder（共享参与者/已释放）→ 返回 E_TAB_LEASE_NOT_HELD 证据，调用方忽略即可。
   * 本方法绝不抛错，也绝不改变 holder。
   */
  function touch(tabId, sessionId, { reason = 'command', ttlMs: ttlOverride = null } = {}) {
    const id = normalizeTabId(tabId);
    const sid = normalizeSessionId(sessionId);
    if (id === null || !sid) return failure('E_BAD_ARG', 'touch 需要整数 tabId 与非空 sessionId');
    touchCount += 1;
    let status;
    try { status = leases.status(id); } catch { status = null; }
    if (!status || !status.holder) {
      return { ok: false, code: 'E_TAB_LEASE_NOT_HELD', silent: true, tabId: id, sessionId: sid, reason: 'no-holder' };
    }
    if (status.holder !== sid) {
      return { ok: false, code: 'E_TAB_LEASE_NOT_HELD', silent: true, tabId: id, sessionId: sid, holder: status.holder, reason: 'not-holder' };
    }
    const summary = summarizeLeaseStatus(status, { now: clock() });
    const effectiveTtl = summary.ttlMs > 0 ? summary.ttlMs : ttlMs;
    const half = Math.max(1, Math.floor(effectiveTtl / 2));
    if (summary.remainingMs > half) {
      return { ok: true, renewed: false, skipped: 'fresh', tabId: id, sessionId: sid, remainingMs: summary.remainingMs };
    }
    const result = renew(id, sid, { reason, ttlMs: ttlOverride == null ? effectiveTtl : ttlOverride });
    if (result.ok === false) return { ...result, silent: true };
    if (recordTouches === true || touchCount % sampleEvery === 1) {
      record('touch', {
        tabId: id,
        sessionId: sid,
        reason: normalizeLeaseReason(reason, 'command'),
        remainingBeforeMs: summary.remainingMs,
        remainingMs: result.lease ? result.lease.leaseRemainingMs : summary.remainingMs,
      });
    }
    return { ok: true, renewed: true, tabId: id, sessionId: sid, remainingMs: result.lease ? result.lease.leaseRemainingMs : 0 };
  }

  /** 转让：holder 显式转交（非 holder/无租约返回 false，失败也留证据）。 */
  function transfer(tabId, fromSessionId, toSessionId, { reason = 'transfer', ttlMs: ttlOverride = null } = {}) {
    const id = normalizeTabId(tabId);
    const from = normalizeSessionId(fromSessionId);
    const to = normalizeSessionId(toSessionId);
    if (id === null || !from || !to) return false;
    const why = normalizeLeaseReason(reason, 'transfer');
    let ok = false;
    try {
      ok = leases.transfer(id, from, to, { reason: why, ttlMs: ttlOverride == null ? undefined : clampTtl(ttlOverride, ttlMs) }) === true;
    } catch (error) {
      record('error', { tabId: id, sessionId: from, reason: why, op: 'transfer', code: (error && error.code) || 'E_INTERNAL', message: text(error && error.message) });
      return false;
    }
    if (ok) record('transfer', { tabId: id, from, to, reason: why });
    else record('conflict', { tabId: id, sessionId: from, reason: why, op: 'transfer', holder: leases.ownerOf(id) });
    return ok;
  }

  /**
   * 释放：
   * - holder → 晋升参与者或删除租约；
   * - 参与者 → 只摘自己；
   * - force=true 必须显式 by（否则 E_BAD_ARG），并记录强制证据。
   */
  function release(tabId, sessionId, { reason = 'release', force = false, by = null } = {}) {
    const id = normalizeTabId(tabId);
    const sid = normalizeSessionId(sessionId);
    if (id === null || !sid) return failure('E_BAD_ARG', 'release 需要整数 tabId 与非空 sessionId');
    if (force === true && !text(by)) return failure('E_BAD_ARG', 'force release 需要显式 by（谁授权回收）', { tabId: id, sessionId: sid });
    const why = normalizeLeaseReason(reason, 'release');
    let result;
    try {
      result = leases.release(id, sid, { reason: why, force: force === true, by: by || null });
    } catch (error) {
      record('error', { tabId: id, sessionId: sid, reason: why, op: 'release', code: (error && error.code) || 'E_INTERNAL', message: text(error && error.message) });
      return failure('E_INTERNAL', 'release 异常：' + text(error && error.message), { tabId: id, sessionId: sid });
    }
    if (result && result.ok === false) {
      record('conflict', {
        tabId: id,
        sessionId: sid,
        reason: why,
        op: 'release',
        holder: result.conflict ? result.conflict.holder : null,
        code: result.code || 'E_TAB_LEASE_NOT_HELD',
      });
      return result;
    }
    record('release', {
      tabId: id,
      sessionId: sid,
      reason: why,
      forced: result && result.forced === true,
      released: result && result.released === true,
      removed: result && result.removed === true,
      promotedTo: result ? result.promotedTo || null : null,
    });
    return result;
  }

  /** 冲突证据（不抛错）：空闲 clear=true；占用时带 holder/剩余/历史/人话解释。 */
  function conflict(tabId, sessionId, { reason = 'acquire' } = {}) {
    const id = normalizeTabId(tabId);
    const sid = normalizeSessionId(sessionId);
    if (id === null) return { tabId: null, clear: true, at: clock(), reason: 'bad-tab' };
    let result;
    try {
      result = leases.conflict(id, sid, { reason: normalizeLeaseReason(reason, 'acquire') });
    } catch (error) {
      return { tabId: id, clear: true, at: clock(), error: (error && error.code) || 'E_INTERNAL', message: text(error && error.message) };
    }
    if (result.clear === true) return result;
    record('conflict', {
      tabId: id,
      sessionId: sid,
      reason: normalizeLeaseReason(reason, 'acquire'),
      op: 'conflict',
      holder: result.holder,
      epoch: result.epoch,
      remainingMs: result.remainingMs,
    });
    return { ...result, explanation: describeLeaseConflict(result) };
  }

  /** 单 tab 租约状态。 */
  function status(tabId) {
    const id = normalizeTabId(tabId);
    if (id === null) return null;
    try { return leases.status(id); } catch { return null; }
  }

  /** 规范化租约快照（所有 tab，按 tabId 升序）。 */
  function snapshot() {
    const list = (() => {
      try { return leases.snapshot ? leases.snapshot() : []; } catch { return []; }
    })();
    return list.map((item) => summarizeLeaseStatus(item, { now: clock() })).filter(Boolean);
  }

  /**
   * 回收过期/崩溃残租：先出计划，再按计划执行。
   * @param {{dryRun?: boolean, reclaimAliveExpired?: boolean, now?: number}} options
   */
  function sweep({ dryRun = false, reclaimAliveExpired = false, now: atOverride = null } = {}) {
    const at = atOverride === null || atOverride === undefined ? clock() : Number(atOverride) || clock();
    const plan = planExpiryReclaim({
      leases: snapshot(),
      sessions: sessionRecords(),
      phases: phasesMap(),
      now: at,
      isAlive: defaultIsAlive,
      reclaimAliveExpired: reclaimAliveExpired === true,
    });
    const applied = { released: 0, promoted: 0, detached: 0, cleared: 0, errors: 0, details: [] };
    if (dryRun !== true) {
      for (const item of plan.reclaim) {
        for (const action of item.actions) {
          let result;
          try {
            if (action.action === 'detach-participant') {
              result = leases.release(item.tabId, action.sessionId, { reason: 'cleanup' });
              if (result && result.ok === true && result.removed === true) applied.detached += 1;
              else if (result && result.ok === false) applied.errors += 1;
            } else if (action.action === 'release-holder') {
              result = leases.release(item.tabId, action.sessionId, { reason: 'expire' });
              if (result && result.ok === true) {
                applied.released += 1;
                if (result.promotedTo) applied.promoted += 1;
              } else {
                applied.errors += 1;
              }
            } else if (action.action === 'force-clear') {
              result = leases.release(item.tabId, action.by || LEASE_SWEEPER_ACTOR, { reason: 'cleanup', force: true, by: action.by || LEASE_SWEEPER_ACTOR });
              if (result && result.ok === true) applied.cleared += 1;
              else applied.errors += 1;
            }
          } catch (error) {
            applied.errors += 1;
            record('error', { tabId: item.tabId, reason: 'sweep', op: action.action, code: (error && error.code) || 'E_INTERNAL', message: text(error && error.message) });
          }
          applied.details.push({
            tabId: item.tabId,
            action: action.action,
            sessionId: action.sessionId || null,
            reason: action.reason || null,
            ok: Boolean(result && result.ok === true),
            promotedTo: result ? result.promotedTo || null : null,
          });
        }
        record('reap', {
          tabId: item.tabId,
          holder: item.holder,
          reason: item.reason,
          actions: item.actions.length,
          promotedTo: applied.details.filter((detail) => detail.tabId === item.tabId).find((detail) => detail.promotedTo)?.promotedTo || null,
        });
        log('租约回收：tab ' + item.tabId + ' holder=' + (item.holder || '(空)') + ' 原因=' + item.reason);
      }
    }
    lastSweep = {
      at,
      dryRun: dryRun === true,
      plan,
      applied,
      remaining: snapshot().length,
    };
    record('sweep', {
      dryRun: dryRun === true,
      reclaim: plan.reclaim.length,
      skipped: plan.skipped.length,
      applied: dryRun === true ? 0 : applied.released + applied.detached + applied.cleared,
    });
    return lastSweep;
  }

  /**
   * 批量续租到期候选（renewDue）：默认直接续租（存活 holder），dryRun 只出计划。
   * 用于长时间任务/低频率 touch 场景，避免 TTL 到点后租约进入 expired 状态。
   */
  function renewDue({ withinMs = LEASE_RENEW_WINDOW_MS, dryRun = false } = {}) {
    const plan = planRenewals({
      leases: snapshot(),
      sessions: sessionRecords(),
      phases: phasesMap(),
      now: clock(),
      withinMs,
      isAlive: defaultIsAlive,
    });
    const applied = { renewed: 0, failed: 0, details: [] };
    if (dryRun !== true) {
      for (const item of plan.due) {
        const result = renew(item.tabId, item.holder, { reason: 'renew' });
        if (result.ok === true) {
          applied.renewed += 1;
          applied.details.push({ tabId: item.tabId, holder: item.holder, ok: true, remainingMs: result.lease ? result.lease.leaseRemainingMs : 0 });
        } else {
          applied.failed += 1;
          applied.details.push({ tabId: item.tabId, holder: item.holder, ok: false, code: result.code || 'E_INTERNAL' });
        }
      }
    }
    return { at: clock(), withinMs: plan.withinMs, dryRun: dryRun === true, due: plan.due, skipped: plan.skipped, applied };
  }

  /**
   * 会话↔租约对账。默认只出计划（dryRun 语义）；
   * apply=true 时补登缺失关系（acquire 只在无 holder 时执行，其余一律 join，绝不抢活 holder）。
   */
  function reconcile({ apply = false } = {}) {
    const plan = planLeaseReconcile({
      leases: snapshot(),
      sessions: sessionRecords(),
      phases: phasesMap(),
      now: clock(),
      isAlive: defaultIsAlive,
    });
    const applied = { adopted: 0, joined: 0, skipped: 0, errors: 0, details: [] };
    if (apply === true) {
      for (const item of plan.adopt) {
        let result;
        if (item.action === 'join') {
          result = join(item.tabId, item.sessionId, { reason: 'daemon-restore' });
          if (result.ok === true) applied.joined += 1; else applied.errors += 1;
        } else if (leases.ownerOf(item.tabId)) {
          result = join(item.tabId, item.sessionId, { reason: 'daemon-restore' });
          if (result.ok === true) applied.joined += 1; else applied.errors += 1;
        } else {
          result = acquire(item.tabId, item.sessionId, { reason: 'daemon-restore' });
          if (result.ok === true) applied.adopted += 1; else applied.errors += 1;
        }
        applied.details.push({ tabId: item.tabId, sessionId: item.sessionId, action: item.action, ok: Boolean(result && result.ok === true) });
      }
    }
    lastReconcile = { at: clock(), apply: apply === true, plan, applied };
    record('recover', { apply: apply === true, adopt: plan.adopt.length, conflicts: plan.conflicts.length, applied: applied.adopted + applied.joined });
    return lastReconcile;
  }

  /** 会话启动登记（daemon 在 session.start 成功后调用；失败只记证据，不改变会话结果）。 */
  function noteSessionStarted(started) {
    const sessionId = normalizeSessionId(started && started.sessionId);
    const tabId = normalizeTabId(started && started.tabId);
    if (!sessionId || tabId === null) return { ok: false, code: 'E_BAD_ARG', reason: 'missing-session' };
    let result;
    if (started && started.shared === true) {
      result = join(tabId, sessionId, { reason: 'share-attach' });
    } else {
      result = acquire(tabId, sessionId, { reason: 'session-start' });
      if (result.ok === false) {
        // 已有 holder（例如恢复后的旧会话）：补登为共享参与者，不抢所有权。
        const joined = join(tabId, sessionId, { reason: 'session-start-attach' });
        if (joined.ok === true) result = { ...joined, adopted: true, takeoverSkipped: true };
      }
    }
    record('adopt', { tabId, sessionId, ok: result.ok === true, shared: started && started.shared === true });
    return result;
  }

  /** 会话重绑登记（旧 tab 释放、新 tab 获取/加入）。 */
  function noteSessionRebound({ sessionId, fromTabId = null, toTabId = null } = {}) {
    const sid = normalizeSessionId(sessionId);
    const from = normalizeTabId(fromTabId);
    const to = normalizeTabId(toTabId);
    if (!sid) return { ok: false, code: 'E_BAD_ARG', reason: 'missing-session' };
    const out = { ok: true, sessionId: sid, fromTabId: from, toTabId: to, released: false, acquired: false, joined: false };
    if (from !== null && from !== to) {
      const released = release(from, sid, { reason: 'rebind' });
      out.released = released.ok === true;
    }
    if (to !== null) {
      if (leases.ownerOf(to)) {
        const joinedResult = join(to, sid, { reason: 'rebind' });
        out.joined = joinedResult.ok === true;
      } else {
        const acquired = acquire(to, sid, { reason: 'rebind' });
        out.acquired = acquired.ok === true;
      }
    }
    record('adopt', { tabId: to, sessionId: sid, op: 'rebind', released: out.released, acquired: out.acquired, joined: out.joined });
    return out;
  }

  /** 会话停止登记（释放；幂等：已晋升/已释放的会话再调不报错，只留 no-lease 证据）。 */
  function noteSessionStopped({ sessionId, tabId = null } = {}) {
    const sid = normalizeSessionId(sessionId);
    if (!sid) return { ok: false, code: 'E_BAD_ARG', reason: 'missing-session' };
    const id = normalizeTabId(tabId);
    if (id === null) return { ok: true, released: false, reason: 'no-tab' };
    const result = release(id, sid, { reason: 'session-stop' });
    // 会话已停止过（租约已不存在 / 已被晋升给别人）：stop 本身不应该因为租约幂等性失败。
    const benign = result.ok === true || result.code === 'E_TAB_LEASE_NOT_HELD';
    return {
      ok: benign,
      released: result.released === true,
      promotedTo: result.promotedTo || null,
      reason: stopReason(result),
      result,
    };
  }

  function stopReason(result) {
    if (!result) return 'no-lease';
    if (result.reason) return result.reason;
    if (result.code === 'E_TAB_LEASE_NOT_HELD') return 'not-held';
    return result.ok === true ? 'released' : 'error';
  }

  /** 记录启动恢复的对账证据（daemon 启动时调用；只写证据，不写租约）。 */
  function recordRecovery(plan) {
    record('recover', {
      op: 'startup',
      adopt: plan && plan.adopt ? plan.adopt.length : 0,
      conflicts: plan && plan.conflicts ? plan.conflicts.length : 0,
      releaseOrphans: plan && plan.releaseOrphans ? plan.releaseOrphans.length : 0,
    });
    return plan;
  }

  /** 有界证据环读取（可按 tab/type 过滤）。 */
  function evidence({ limit: max = 20, tabId = null, type = null } = {}) {
    const id = tabId === null || tabId === undefined ? null : normalizeTabId(tabId);
    const wantedType = type === null || type === undefined ? null : text(type);
    const filtered = events.filter((event) => {
      if (id !== null && Number(event.tabId) !== id) return false;
      if (wantedType && event.type !== wantedType) return false;
      return true;
    });
    const size = Number.isInteger(Number(max)) && Number(max) > 0 ? Number(max) : 20;
    return filtered.slice(-size);
  }

  /** 所有权矩阵（所有 tab）。 */
  function ownershipMatrix({ expiringWithinMs = LEASE_EXPIRING_WINDOW_MS } = {}) {
    return buildOwnershipMatrix({
      leases: snapshot(),
      sessions: sessionRecords(),
      phases: phasesMap(),
      now: clock(),
      isAlive: defaultIsAlive,
      expiringWithinMs,
    });
  }

  /**
   * 完整租约报告（status 视图 / recovery 报告 / CLI 诊断共用）。
   * 报告的 reclaim 是 dryRun 计划；不会真的释放租约。
   */
  function report({ limit = 20, expiringWithinMs = LEASE_EXPIRING_WINDOW_MS, includeEvidence = true } = {}) {
    const at = clock();
    const snapshotNow = snapshot();
    const matrix = buildOwnershipMatrix({
      leases: snapshotNow,
      sessions: sessionRecords(),
      phases: phasesMap(),
      now: at,
      isAlive: defaultIsAlive,
      expiringWithinMs,
    });
    const reclaim = planExpiryReclaim({
      leases: snapshotNow,
      sessions: sessionRecords(),
      phases: phasesMap(),
      now: at,
      isAlive: defaultIsAlive,
    });
    const renewals = planRenewals({
      leases: snapshotNow,
      sessions: sessionRecords(),
      phases: phasesMap(),
      now: at,
      isAlive: defaultIsAlive,
    });
    const reconcilePlan = planLeaseReconcile({
      leases: snapshotNow,
      sessions: sessionRecords(),
      phases: phasesMap(),
      now: at,
      isAlive: defaultIsAlive,
    });
    const max = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
    // 与上一次报告的所有权差异：回答"自上次读取以来谁拿到/丢了 tab 所有权"（只读证据）。
    const changes = diffOwnershipMatrices(lastMatrix, matrix, { now: at });
    lastMatrix = matrix;
    return buildLeaseReport({
      matrix,
      reclaim,
      renewals,
      reconcile: reconcilePlan,
      changes,
      counters: { ...counters, touchTotal: touchCount, evidenceSize: events.length },
      sweeper: {
        running: sweeperState.running,
        intervalMs: sweeperState.intervalMs,
        ticks: sweeperState.ticks,
        actions: sweeperState.actions,
        lastRunAt: sweeperState.lastRunAt,
        lastError: sweeperState.lastError,
        lastSweepAt: lastSweep ? lastSweep.at : 0,
      },
      evidence: includeEvidence === true ? evidence({ limit: Math.max(5, max) }) : [],
      limit: max,
      now: at,
    });
  }

  /** 启动定时回收（daemon 显式调用；重复调用幂等）。 */
  function startSweeper({ intervalMs: override = null } = {}) {
    if (sweeper) return { ...sweeperState };
    const effective = Number.isInteger(Number(override)) && Number(override) >= 250 ? Number(override) : intervalMs;
    sweeper = setInterval(() => {
      sweeperState.ticks += 1;
      try {
        const result = sweep();
        sweeperState.lastRunAt = clock();
        sweeperState.actions += result.applied.released + result.applied.detached + result.applied.cleared;
      } catch (error) {
        sweeperState.lastError = { at: clock(), code: (error && error.code) || 'E_INTERNAL', message: text(error && error.message) };
        try { log('租约自动回收失败：' + text(error && error.message)); } catch { /* 忽略 */ }
      }
    }, effective);
    if (sweeper.unref) sweeper.unref();
    sweeperState = { ...sweeperState, running: true, intervalMs: effective, startedAt: clock() };
    return { ...sweeperState };
  }

  /** 停止定时回收。 */
  function stopSweeper() {
    if (sweeper) {
      try { clearInterval(sweeper); } catch { /* 忽略 */ }
      sweeper = null;
    }
    sweeperState = { ...sweeperState, running: false, stoppedAt: clock() };
    return { ...sweeperState };
  }

  /** 定时器与统计快照。 */
  function stats() {
    return {
      ttlMs,
      counters: { ...counters, touchTotal: touchCount },
      evidenceSize: events.length,
      sweeper: { ...sweeperState },
      lastSweepAt: lastSweep ? lastSweep.at : 0,
      lastReconcileAt: lastReconcile ? lastReconcile.at : 0,
    };
  }

  /** 清空证据与计数（测试/daemon 停止用；不动租约本体）。 */
  function reset() {
    events.length = 0;
    for (const key of Object.keys(counters)) counters[key] = 0;
    touchCount = 0;
    seq = 0;
    lastSweep = null;
    lastReconcile = null;
    lastMatrix = null;
    return stats();
  }

  return {
    get ttlMs() { return ttlMs; },
    acquire,
    join,
    renew,
    touch,
    transfer,
    release,
    conflict,
    status,
    snapshot,
    ownershipOf,
    ownershipMatrix,
    sweep,
    renewDue,
    reconcile,
    noteSessionStarted,
    noteSessionRebound,
    noteSessionStopped,
    recordRecovery,
    evidence,
    report,
    describeConflict: describeLeaseConflict,
    classifyStatus: (tabId) => {
      const id = normalizeTabId(tabId);
      if (id === null) return null;
      const summary = status(id);
      return summary ? classifyLeaseStatus(summarizeLeaseStatus(summary, { now: clock() }), { now: clock(), isAlive: defaultIsAlive }) : null;
    },
    summarizeConflicts: () => summarizeConflicts(ownershipMatrix().conflicts),
    startSweeper,
    stopSweeper,
    stats,
    reset,
  };
}
