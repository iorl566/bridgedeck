// daemon/lease-registry.js —— 多会话 tab 所有权租约的纯逻辑层。
//
// 背景：lib/session-lease.mjs 负责"租约本体"（互斥 holder + TTL + 参与者的内存状态机），
// 但 daemon 真正回答运维/Agent 的问题需要一层证据逻辑：
//   1) 这个 tab 现在归谁、为什么、还剩多久（owner + TTL bucket）；
//   2) 会话集合与租约集合是否一致（持有者已消失 / 会话在 tab 上却没有租约 / 参与者已死）；
//   3) 哪些租约可以安全回收（崩溃残留、TLL 过期且持有者已不存活）——**只出计划不执行**；
//   4) 哪些租约快到期需要续租（避免长时间任务中途丢所有权）；
//   5) 恢复后按"会话→租约"对账（adopt/join/冲突），以及可读报告数据结构。
//
// 本模块是**纯函数**集合：不读写 daemon 状态、不调 lease 的写方法，只接收快照
// （leases.snapshot() / sessions 的值 / sessionState 的 phase 表）并返回结构化证据。
// 真正执行回收/续租/对账的是 daemon/lease-ops.js；这样单测可以精确覆盖判定逻辑，
// 也保证"计划"与"执行"的副作用边界清晰（不自动 resolve、不自动抢租约）。
//
// 术语：
// - holder：独占持有者（同一 tab 同时只有一个）；
// - participant：共享参与者（--share 会话），按接入顺序参与 handoff；
// - orphan：holder 不在当前会话集合里（典型是崩溃前遗留、或已 stop 但没释放）；
// - reclaimable：可以回收（holder 失联，或显式允许回收"存活但 TTL 已过期"的持有者）。

import { LEASE_REASONS } from '../lib/session-lease.mjs';

/** 所有权报告结构版本（新增字段只加不改）。 */
export const LEASE_OWNERSHIP_SCHEMA = 1;
export const LEASE_OWNERSHIP_KIND = 'bridge/tab-ownership';

/** 租约状态分类（运维视图与冲突不变量共用）。 */
export const LEASE_STATE_KINDS = Object.freeze([
  'free',        // 没有 holder（可能只剩参与者或根本不存在）
  'held',        // 单持有者
  'shared',      // 多参与者（holder + 共享会话）
  'expiring',    // 持有者存活，但剩余租期进入告警窗口
  'expired',     // 持有者存活，但 TTL 已过（等下一次 touch 续租）
  'orphan',      // 持有者已不在会话集合里（可回收）
  'recovering',  // 持有者处于启动/恢复阶段（preparing/starting/recovering）
]);

/** 冲突严重度。 */
export const LEASE_CONFLICT_SEVERITIES = Object.freeze(['high', 'warn', 'info']);

/** 默认"即将过期"告警窗口：与默认 TTL 60s 配合，剩余 <= 10s 时提示续租。 */
export const LEASE_EXPIRING_WINDOW_MS = 10_000;

/** 默认"需要主动续租"窗口：剩余 <= 15s 的存活持有者进入续租候选。 */
export const LEASE_RENEW_WINDOW_MS = 15_000;

/** 单条租约默认最多返回的历史事件数。 */
export const LEASE_HISTORY_PREVIEW = 5;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

/** tabId 规范化为非负整数；非法返回 null（绝不抛错，供视图层容错）。 */
export function normalizeTabId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/** sessionId 规范化：非空字符串，否则 null。 */
export function normalizeSessionId(value) {
  const text = toText(value).trim();
  return text || null;
}

/** 启动占位令牌（session.start --tab 的临时 holder）不能被误判为失联会话。 */
export function isStartToken(sessionId) {
  return toText(sessionId).startsWith('start:');
}

/**
 * 是否合法的租约原因。未知原因不拒绝执行（lib 允许任意字符串），只用于报告归类。
 */
export function isValidLeaseReason(reason) {
  return LEASE_REASONS.includes(toText(reason));
}

/** 归一化原因：空/非法退回 fallback，供证据字段稳定分组。 */
export function normalizeLeaseReason(reason, fallback = 'renew') {
  const text = toText(reason).trim();
  if (!text) return fallback;
  return text.slice(0, 80);
}

/** 剩余租期分桶（报告/视图用；0 表示无租约或已过期）。 */
export function ttlBucketOf(remainingMs, ttlMs) {
  const remaining = Math.max(0, Number(remainingMs) || 0);
  const ttl = Math.max(0, Number(ttlMs) || 0);
  if (remaining <= 0) return 'expired';
  if (ttl > 0 && remaining >= ttl * 0.75) return 'fresh';
  if (ttl > 0 && remaining >= ttl * 0.5) return 'aging';
  return 'expiring';
}

/** 单条租约快照的规范化视图：字段只加不改，缺失值一律给 null/0。 */
export function summarizeLeaseStatus(status, { now = Date.now(), historyLimit = LEASE_HISTORY_PREVIEW } = {}) {
  if (!isObject(status)) return null;
  const tabId = normalizeTabId(status.tabId);
  if (tabId === null) return null;
  const holder = normalizeSessionId(status.holder);
  const expiresAt = Number(status.expiresAt) || 0;
  const remainingMs = holder && expiresAt > 0 ? Math.max(0, expiresAt - Number(now)) : 0;
  const ttlMs = Number(status.ttlMs) || 0;
  const history = Array.isArray(status.history) ? status.history.slice(-Math.max(1, Number(historyLimit) || 1)) : [];
  const participants = Array.isArray(status.participants)
    ? status.participants.map((item) => ({
      sessionId: normalizeSessionId(item && item.sessionId),
      attachedAt: Number(item && item.attachedAt) || 0,
      role: item && item.role === 'holder' ? 'holder' : 'participant',
    })).filter((item) => item.sessionId)
    : [];
  return {
    tabId,
    holder,
    acquiredAt: Number(status.acquiredAt) || 0,
    holderSince: Number(status.holderSince) || 0,
    expiresAt,
    remainingMs,
    ttlMs,
    ttlBucket: holder ? ttlBucketOf(remainingMs, ttlMs) : 'expired',
    epoch: Number(status.epoch) || 0,
    mode: status.mode || 'exclusive',
    reason: status.reason || null,
    shared: status.shared === true || participants.length > 1,
    participantCount: Number(status.participantCount) || participants.length,
    participants,
    since: Number(status.since) || 0,
    lastEvent: isObject(status.lastEvent) ? { ...status.lastEvent } : null,
    history,
  };
}

/**
 * 判定单条租约状态。
 * @param {object} lease 租约快照（summarizeLeaseStatus 的输入或输出）
 * @param {{now?: number, isAlive?: (sessionId: string) => boolean, expiringWithinMs?: number}} options
 */
export function classifyLeaseStatus(lease, { now = Date.now(), isAlive = () => true, expiringWithinMs = LEASE_EXPIRING_WINDOW_MS } = {}) {
  const summary = isObject(lease) && ('remainingMs' in lease || 'ttlBucket' in lease)
    ? lease
    : summarizeLeaseStatus(lease, { now });
  if (!summary) return { kind: 'free', tabId: null, holder: null, holderAlive: null, reclaimable: false, reason: 'no-lease', remainingMs: 0 };
  const aliveCheck = typeof isAlive === 'function' ? isAlive : () => true;
  const holder = summary.holder;
  if (!holder) {
    return { kind: 'free', tabId: summary.tabId, holder: null, holderAlive: null, reclaimable: false, reason: 'no-holder', remainingMs: 0 };
  }
  const holderAlive = isStartToken(holder) || aliveCheck(holder) === true;
  const remainingMs = Math.max(0, Number(summary.remainingMs) || 0);
  if (!holderAlive) {
    return {
      kind: 'orphan',
      tabId: summary.tabId,
      holder,
      holderAlive: false,
      reclaimable: true,
      reason: 'holder-missing',
      remainingMs,
    };
  }
  const expiringMs = Number.isFinite(Number(expiringWithinMs)) ? Number(expiringWithinMs) : LEASE_EXPIRING_WINDOW_MS;
  const expired = Number(summary.expiresAt) > 0 && Number(now) >= Number(summary.expiresAt);
  if (expired) {
    return { kind: 'expired', tabId: summary.tabId, holder, holderAlive: true, reclaimable: false, reason: 'ttl-expired-alive', remainingMs: 0 };
  }
  if (remainingMs > 0 && remainingMs <= expiringMs) {
    return { kind: 'expiring', tabId: summary.tabId, holder, holderAlive: true, reclaimable: false, reason: 'expiring', remainingMs };
  }
  if (summary.participantCount > 1) {
    return { kind: 'shared', tabId: summary.tabId, holder, holderAlive: true, reclaimable: false, reason: 'shared', remainingMs };
  }
  return { kind: 'held', tabId: summary.tabId, holder, holderAlive: true, reclaimable: false, reason: 'held', remainingMs };
}

/** sessions（Map 或数组）→ sessionId 索引。 */
export function indexSessionsById(sessions) {
  const index = new Map();
  const source = sessions instanceof Map
    ? [...sessions.values()]
    : (Array.isArray(sessions) ? sessions : []);
  for (const session of source) {
    const sessionId = normalizeSessionId(session && session.sessionId);
    if (sessionId) index.set(sessionId, session);
  }
  return index;
}

/** 会话按 tab 聚合（只收集 tabId 合法的会话）。 */
export function collectTabSessions(sessions) {
  const byTab = new Map();
  const source = sessions instanceof Map
    ? [...sessions.values()]
    : (Array.isArray(sessions) ? sessions : []);
  for (const session of source) {
    const sessionId = normalizeSessionId(session && session.sessionId);
    const tabId = normalizeTabId(session && session.tabId);
    if (!sessionId || tabId === null) continue;
    let list = byTab.get(tabId);
    if (!list) {
      list = [];
      byTab.set(tabId, list);
    }
    list.push(session);
  }
  for (const list of byTab.values()) list.sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0));
  return byTab;
}

function phaseOf(phases, sessionId) {
  if (!phases) return null;
  if (phases instanceof Map) return phases.get(String(sessionId)) || null;
  if (typeof phases === 'function') {
    try { return phases(String(sessionId)) || null; } catch { return null; }
  }
  if (isObject(phases)) return phases[String(sessionId)] || null;
  return null;
}

function conflictSeverityRank(severity) {
  if (severity === 'high') return 0;
  if (severity === 'warn') return 1;
  return 2;
}

/**
 * 所有权冲突不变量检查（只报告，不修改任何租约）。
 *
 * 输出冲突码（daemon 内部证据码，不是协议错误码，不扩大错误码清单）：
 * - lease-holder-missing：holder 不在会话集合里且会话失联；
 * - lease-holder-stopping：holder 会话已进入 stopping（应随 stop 释放）；
 * - lease-participant-missing：共享参与者已失联（可清理）；
 * - lease-holder-not-participant：holder 不在 participants 里（状态不一致）；
 * - session-without-lease：会话登记在 tab 上但没有租约（重启/漏登记）；
 * - session-not-participant：会话在 tab 上但不在该 tab 的租约参与者里；
 * - lease-tab-mismatch：租约的 tabId 与会话登记 tab 不一致（同一 tabId 不会发生，防御脏输入）；
 * - duplicate-participant：同一参与者重复登记。
 *
 * @param {{leases?: object[], sessions?: object[]|Map, phases?: Map|object|Function, controls?: object[],
 *          now?: number, isAlive?: (sessionId: string) => boolean}} input
 */
export function detectOwnershipConflicts({
  leases = [],
  sessions = [],
  phases = null,
  controls = [],
  now = Date.now(),
  isAlive = () => true,
} = {}) {
  const at = Number(now) || Date.now();
  const conflicts = [];
  const push = (code, severity, message, evidence = {}) => {
    conflicts.push({ code, severity, message, at, evidence });
  };
  const aliveCheck = typeof isAlive === 'function' ? isAlive : () => true;
  const sessionIndex = indexSessionsById(sessions);
  const byTab = collectTabSessions(sessions);
  const leaseByTab = new Map();
  for (const raw of Array.isArray(leases) ? leases : []) {
    const tabId = normalizeTabId(raw && raw.tabId);
    if (tabId === null) continue;
    const summary = summarizeLeaseStatus(raw, { now: at });
    if (!summary) continue;
    leaseByTab.set(tabId, summary);
  }
  const isKnownSession = (sessionId) => sessionIndex.has(String(sessionId)) || isStartToken(sessionId) || aliveCheck(String(sessionId)) === true;

  for (const [tabId, lease] of leaseByTab) {
    const holder = lease.holder;
    if (holder) {
      if (!isKnownSession(holder)) {
        push('lease-holder-missing', 'high',
          'tab ' + tabId + ' 的租约由已失联会话 ' + holder + ' 持有（epoch ' + lease.epoch + '）',
          { tabId, holder, epoch: lease.epoch, expiresAt: lease.expiresAt, participants: lease.participants });
      }
      if (phaseOf(phases, holder) === 'stopping') {
        push('lease-holder-stopping', 'warn',
          'tab ' + tabId + ' 的租约持有者 ' + holder + ' 已进入 stopping，应随 session.stop 释放',
          { tabId, holder, phase: 'stopping' });
      }
      const participantIds = (lease.participants || []).map((item) => item.sessionId);
      if (participantIds.length && !participantIds.includes(holder)) {
        push('lease-holder-not-participant', 'high',
          'tab ' + tabId + ' 的 holder ' + holder + ' 不在参与者列表（状态不一致）',
          { tabId, holder, participants: participantIds });
      }
    }
    const seen = new Set();
    for (const participant of lease.participants || []) {
      const sid = participant.sessionId;
      if (!sid) continue;
      if (seen.has(sid)) {
        push('duplicate-participant', 'warn', 'tab ' + tabId + ' 的参与者 ' + sid + ' 重复登记', { tabId, sessionId: sid });
      }
      seen.add(sid);
      if (sid !== holder && !isKnownSession(sid)) {
        push('lease-participant-missing', 'warn',
          'tab ' + tabId + ' 的共享参与者 ' + sid + ' 已失联（可清理）',
          { tabId, sessionId: sid, holder });
      }
    }
  }

  for (const [tabId, list] of byTab) {
    const lease = leaseByTab.get(tabId);
    for (const session of list) {
      const sessionId = String(session.sessionId);
      const phase = phaseOf(phases, sessionId);
      if (phase === 'stopping' || phase === 'stopped') continue;
      if (!lease) {
        push('session-without-lease', 'info',
          '会话 ' + sessionId + ' 登记在 tab ' + tabId + ' 上，但没有所有权租约',
          { tabId, sessionId, phase: phase || null, startedAt: Number(session.startedAt) || 0 });
        continue;
      }
      const participantIds = (lease.participants || []).map((item) => item.sessionId);
      if (!participantIds.includes(sessionId) && lease.holder !== sessionId) {
        push('session-not-participant', 'high',
          '会话 ' + sessionId + ' 在 tab ' + tabId + ' 上，但不属于该 tab 的租约参与者',
          { tabId, sessionId, holder: lease.holder, participants: participantIds });
      }
    }
  }

  // 控制记录里的 tab 若没有会话/租约，清点成 info（重启后 tabControl 可能残留）。
  for (const control of Array.isArray(controls) ? controls : []) {
    const tabId = normalizeTabId(control && control.tabId);
    if (tabId === null) continue;
    if (!leaseByTab.has(tabId) && !byTab.has(tabId)) {
      push('control-without-session', 'info', 'tab ' + tabId + ' 仍有控制记录但没有会话/租约', { tabId });
    }
  }

  conflicts.sort((a, b) => {
    const rank = conflictSeverityRank(a.severity) - conflictSeverityRank(b.severity);
    if (rank !== 0) return rank;
    const tabDelta = Number(a.evidence.tabId || 0) - Number(b.evidence.tabId || 0);
    return tabDelta !== 0 ? tabDelta : String(a.code).localeCompare(String(b.code));
  });
  return conflicts;
}

/**
 * 单个 tab 的所有权行：租约 + 登记会话 + 控制记录 + 冲突摘要。
 * @param {{tabId: number, lease?: object|null, tabSessions?: object[], phases?: Map|object|Function,
 *          control?: object|null, now?: number, isAlive?: Function, conflicts?: object[]}} input
 */
export function buildTabOwnershipRow({
  tabId,
  lease = null,
  tabSessions = [],
  phases = null,
  control = null,
  now = Date.now(),
  isAlive = () => true,
  conflicts = null,
} = {}) {
  const id = normalizeTabId(tabId);
  if (id === null) return null;
  const at = Number(now) || Date.now();
  const summary = lease ? summarizeLeaseStatus(lease, { now: at }) : null;
  const classification = lease
    ? classifyLeaseStatus(summary, { now: at, isAlive })
    : { kind: 'free', tabId: id, holder: null, holderAlive: null, reclaimable: false, reason: 'no-lease', remainingMs: 0 };
  const sessions = (Array.isArray(tabSessions) ? tabSessions : []).map((session) => ({
    sessionId: normalizeSessionId(session && session.sessionId),
    startedAt: Number(session && session.startedAt) || 0,
    shared: session && session.shared === true,
    borrowed: session && session.borrowed === true,
    connected: session && session.connected !== false,
    phase: phaseOf(phases, session && session.sessionId) || null,
    role: summary && summary.holder === normalizeSessionId(session && session.sessionId) ? 'holder' : 'participant',
  })).filter((item) => item.sessionId);
  const holderSession = summary && summary.holder
    ? sessions.find((item) => item.sessionId === summary.holder) || null
    : null;
  const related = Array.isArray(conflicts)
    ? conflicts.filter((item) => Number(item && item.evidence && item.evidence.tabId) === id)
    : [];
  return {
    tabId: id,
    state: classification.kind,
    stateReason: classification.reason,
    holder: summary ? summary.holder : null,
    holderAlive: classification.holderAlive,
    holderPhase: holderSession ? holderSession.phase : null,
    epoch: summary ? summary.epoch : 0,
    mode: summary ? summary.mode : null,
    shared: summary ? summary.shared : false,
    participantCount: summary ? summary.participantCount : 0,
    participants: summary ? summary.participants : [],
    ttlMs: summary ? summary.ttlMs : 0,
    remainingMs: classification.remainingMs,
    expiresAt: summary ? summary.expiresAt : 0,
    acquiredAt: summary ? summary.acquiredAt : 0,
    reason: summary ? summary.reason : null,
    ttlBucket: summary ? summary.ttlBucket : 'expired',
    reclaimable: classification.reclaimable === true,
    sessions,
    sessionCount: sessions.length,
    control: isObject(control) ? {
      mode: control.mode || null,
      epoch: Number(control.epoch) || 0,
      holder: control.holder || null,
      primary: control.primary || null,
      shared: control.shared === true,
      sessionCount: Number(control.sessionCount) || sessions.length,
      leaseRemainingMs: Number(control.leaseRemainingMs) || 0,
    } : null,
    conflicts: related.map((item) => ({ code: item.code, severity: item.severity, message: item.message })),
    conflictCount: related.length,
    history: summary ? summary.history : [],
  };
}

/**
 * 所有权矩阵：所有 tab 一行，附 totals / orphans / conflicts。
 * @param {{leases?: object[], sessions?: object[]|Map, phases?: Map|object|Function, controls?: object[],
 *          now?: number, isAlive?: Function, expiringWithinMs?: number}} input
 */
export function buildOwnershipMatrix({
  leases = [],
  sessions = [],
  phases = null,
  controls = [],
  now = Date.now(),
  isAlive = () => true,
  expiringWithinMs = LEASE_EXPIRING_WINDOW_MS,
} = {}) {
  const at = Number(now) || Date.now();
  const summaryList = [];
  for (const raw of Array.isArray(leases) ? leases : []) {
    const summary = summarizeLeaseStatus(raw, { now: at });
    if (summary) summaryList.push(summary);
  }
  const sessionSource = sessions instanceof Map ? [...sessions.values()] : (Array.isArray(sessions) ? sessions : []);
  const byTab = collectTabSessions(sessionSource);
  const controlByTab = new Map();
  for (const control of Array.isArray(controls) ? controls : []) {
    const tabId = normalizeTabId(control && control.tabId);
    if (tabId !== null && !controlByTab.has(tabId)) controlByTab.set(tabId, control);
  }
  const conflicts = detectOwnershipConflicts({ leases: summaryList, sessions: sessionSource, phases, controls, now: at, isAlive });
  const leaseByTab = new Map(summaryList.map((item) => [item.tabId, item]));
  const tabIds = [...new Set([...leaseByTab.keys(), ...byTab.keys(), ...controlByTab.keys()])].sort((a, b) => a - b);
  const rows = tabIds.map((tabId) => buildTabOwnershipRow({
    tabId,
    lease: leaseByTab.get(tabId) || null,
    tabSessions: byTab.get(tabId) || [],
    phases,
    control: controlByTab.get(tabId) || null,
    now: at,
    isAlive,
    conflicts,
  })).filter(Boolean);
  const totals = {
    tabs: rows.length,
    leasedTabs: rows.filter((row) => row.holder).length,
    freeTabs: rows.filter((row) => !row.holder).length,
    sharedTabs: rows.filter((row) => row.shared).length,
    expiringTabs: rows.filter((row) => row.ttlBucket === 'expiring').length,
    orphanTabs: rows.filter((row) => row.state === 'orphan').length,
    reclaimableTabs: rows.filter((row) => row.reclaimable).length,
    sessions: rows.reduce((sum, row) => sum + row.sessionCount, 0),
    participants: rows.reduce((sum, row) => sum + row.participantCount, 0),
    conflicts: conflicts.length,
    highConflicts: conflicts.filter((item) => item.severity === 'high').length,
    warnConflicts: conflicts.filter((item) => item.severity === 'warn').length,
    infoConflicts: conflicts.filter((item) => item.severity === 'info').length,
  };
  return {
    schema: LEASE_OWNERSHIP_SCHEMA,
    kind: LEASE_OWNERSHIP_KIND,
    at,
    generatedAt: new Date(at).toISOString(),
    expiringWithinMs: Number(expiringWithinMs) || LEASE_EXPIRING_WINDOW_MS,
    rows,
    conflicts,
    orphans: rows.filter((row) => row.state === 'orphan').map((row) => ({
      tabId: row.tabId, holder: row.holder, epoch: row.epoch, expiresAt: row.expiresAt,
    })),
    totals,
  };
}

/**
 * 过期/崩溃残租回收计划（纯计划，不执行）。
 *
 * 回收策略（保守优先）：
 * - holder 已失联 → 回收：先摘掉已失联参与者，再释放 holder（lib 会把 holder 晋升给存活参与者，
 *   没有存活参与者时删除租约）；若 holder 为 null 且参与者全失联，则强制清空条目。
 * - holder 存活但 TTL 已过 → 默认**不回收**（下一步是 touch 续租，而不是把活会话踢掉）；
 *   只有显式 reclaimAliveExpired=true 才回收（运维手动模式）。
 * - holder 存活且未过期 → 跳过，记 remainingMs 证据。
 *
 * @param {{leases?: object[], sessions?: object[]|Map, phases?: Map|object|Function,
 *          now?: number, isAlive?: Function, reclaimAliveExpired?: boolean}} input
 */
export function planExpiryReclaim({
  leases = [],
  sessions = [],
  phases = null,
  now = Date.now(),
  isAlive = () => true,
  reclaimAliveExpired = false,
} = {}) {
  const at = Number(now) || Date.now();
  const aliveCheck = typeof isAlive === 'function' ? isAlive : () => true;
  const sessionIndex = indexSessionsById(sessions);
  const reclaim = [];
  const skipped = [];
  for (const raw of Array.isArray(leases) ? leases : []) {
    const lease = summarizeLeaseStatus(raw, { now: at });
    if (!lease) continue;
    const holder = lease.holder;
    const alive = holder
      ? (sessionIndex.has(holder) || isStartToken(holder) || aliveCheck(holder) === true)
      : false;
    const expired = Number(lease.expiresAt) > 0 && at >= Number(lease.expiresAt);
    const deadParticipants = (lease.participants || [])
      .map((item) => item.sessionId)
      .filter((sid) => sid && sid !== holder && !sessionIndex.has(sid) && !isStartToken(sid) && aliveCheck(sid) !== true);
    if (!holder) {
      if (deadParticipants.length) {
        reclaim.push({
          tabId: lease.tabId,
          holder: null,
          holderAlive: false,
          expired,
          reason: 'no-holder-dead-participants',
          actions: [
            ...deadParticipants.map((sessionId) => ({ action: 'detach-participant', sessionId, reason: 'participant-missing' })),
            { action: 'force-clear', by: 'lease-sweeper', reason: 'empty-lease' },
          ],
          evidence: { tabId: lease.tabId, holder: null, participants: lease.participants, expired },
        });
      }
      continue;
    }
    if (!alive) {
      const actions = deadParticipants.map((sessionId) => ({ action: 'detach-participant', sessionId, reason: 'participant-missing' }));
      actions.push({
        action: 'release-holder',
        sessionId: holder,
        reason: expired ? 'ttl-expired-orphan' : 'holder-missing',
        promoteExpected: (lease.participants || [])
          .map((item) => item.sessionId)
          .find((sid) => sid && sid !== holder && (sessionIndex.has(sid) || isStartToken(sid) || aliveCheck(sid) === true)) || null,
      });
      reclaim.push({
        tabId: lease.tabId,
        holder,
        holderAlive: false,
        expired,
        reason: expired ? 'ttl-expired-orphan' : 'holder-missing',
        actions,
        evidence: {
          tabId: lease.tabId,
          holder,
          epoch: lease.epoch,
          expiresAt: lease.expiresAt,
          remainingMs: lease.remainingMs,
          participants: lease.participants,
        },
      });
      continue;
    }
    if (expired && reclaimAliveExpired === true) {
      reclaim.push({
        tabId: lease.tabId,
        holder,
        holderAlive: true,
        expired: true,
        reason: 'ttl-expired-alive-forced',
        actions: [{ action: 'release-holder', sessionId: holder, reason: 'operator-reclaim', promoteExpected: null }],
        evidence: { tabId: lease.tabId, holder, epoch: lease.epoch, expiresAt: lease.expiresAt, remainingMs: 0 },
      });
      continue;
    }
    skipped.push({
      tabId: lease.tabId,
      holder,
      holderAlive: true,
      expired,
      reason: expired ? 'holder-alive-expired' : 'not-expired',
      remainingMs: lease.remainingMs,
      ttlMs: lease.ttlMs,
    });
  }
  reclaim.sort((a, b) => a.tabId - b.tabId);
  skipped.sort((a, b) => a.tabId - b.tabId);
  return {
    at,
    generatedAt: new Date(at).toISOString(),
    reclaimAliveExpired: reclaimAliveExpired === true,
    reclaim,
    skipped,
    stats: {
      scanned: Array.isArray(leases) ? leases.length : 0,
      reclaim: reclaim.length,
      skipped: skipped.length,
      actions: reclaim.reduce((sum, item) => sum + item.actions.length, 0),
      expiredOrphans: reclaim.filter((item) => item.expired && !item.holderAlive).length,
      missingHolders: reclaim.filter((item) => !item.holderAlive).length,
    },
  };
}

/**
 * 续租候选计划（纯计划）：存活 holder 且剩余租期 <= withinMs。
 * 长时间任务在途时 daemon 按此计划 touch 续租，避免任务中途丢 tab 所有权。
 */
export function planRenewals({
  leases = [],
  sessions = [],
  phases = null,
  now = Date.now(),
  withinMs = LEASE_RENEW_WINDOW_MS,
  isAlive = () => true,
} = {}) {
  const at = Number(now) || Date.now();
  const windowMs = Math.max(0, Number(withinMs) || 0);
  const sessionIndex = indexSessionsById(sessions);
  const aliveCheck = typeof isAlive === 'function' ? isAlive : () => true;
  const due = [];
  const skipped = [];
  for (const raw of Array.isArray(leases) ? leases : []) {
    const lease = summarizeLeaseStatus(raw, { now: at });
    if (!lease || !lease.holder) continue;
    const holder = lease.holder;
    if (!sessionIndex.has(holder) && !isStartToken(holder) && aliveCheck(holder) !== true) {
      skipped.push({ tabId: lease.tabId, holder, reason: 'holder-missing' });
      continue;
    }
    if (Number(lease.expiresAt) > 0 && at >= Number(lease.expiresAt)) {
      due.push({ tabId: lease.tabId, holder, reason: 'expired', remainingMs: 0, ttlMs: lease.ttlMs, expired: true });
      continue;
    }
    if (lease.remainingMs <= windowMs) {
      due.push({ tabId: lease.tabId, holder, reason: 'due', remainingMs: lease.remainingMs, ttlMs: lease.ttlMs, expired: false });
    } else {
      skipped.push({ tabId: lease.tabId, holder, reason: 'fresh', remainingMs: lease.remainingMs });
    }
  }
  due.sort((a, b) => a.remainingMs - b.remainingMs || a.tabId - b.tabId);
  return {
    at,
    withinMs: windowMs,
    due,
    skipped,
    stats: { scanned: Array.isArray(leases) ? leases.length : 0, due: due.length, skipped: skipped.length },
  };
}

/**
 * "会话↔租约"对账计划（崩溃恢复/运行期自愈共用）：
 * - adopt：会话登记在 tab 上但没有任何租约（重启恢复漏建）→ 建议 acquire（无 holder 时）或 join；
 * - join：租约存在但会话不在参与者里 → 建议 join 登记（不抢 holder）；
 * - releaseOrphans：来自 planExpiryReclaim 的回收计划；
 * - conflicts：所有权冲突不变量。
 *
 * 注意：本函数只出计划，是否应用由调用方显式决定（daemon 启动时只记录证据，不自动抢租约）。
 */
export function planLeaseReconcile({
  leases = [],
  sessions = [],
  phases = null,
  controls = [],
  now = Date.now(),
  isAlive = () => true,
} = {}) {
  const at = Number(now) || Date.now();
  const summaryList = [];
  for (const raw of Array.isArray(leases) ? leases : []) {
    const summary = summarizeLeaseStatus(raw, { now: at });
    if (summary) summaryList.push(summary);
  }
  const sessionSource = sessions instanceof Map ? [...sessions.values()] : (Array.isArray(sessions) ? sessions : []);
  const byTab = collectTabSessions(sessionSource);
  const leaseByTab = new Map(summaryList.map((item) => [item.tabId, item]));
  const adopt = [];
  for (const [tabId, list] of byTab) {
    const lease = leaseByTab.get(tabId);
    for (const session of list) {
      const sessionId = normalizeSessionId(session.sessionId);
      if (!sessionId) continue;
      const phase = phaseOf(phases, sessionId);
      if (phase === 'stopping' || phase === 'stopped') continue;
      if (!lease) {
        adopt.push({
          tabId,
          sessionId,
          action: 'acquire',
          reason: 'session-without-lease',
          startedAt: Number(session.startedAt) || 0,
        });
        continue;
      }
      const participantIds = (lease.participants || []).map((item) => item.sessionId);
      if (!participantIds.includes(sessionId) && lease.holder !== sessionId) {
        adopt.push({
          tabId,
          sessionId,
          action: 'join',
          reason: 'session-not-participant',
          holder: lease.holder,
          startedAt: Number(session.startedAt) || 0,
        });
      }
    }
  }
  adopt.sort((a, b) => a.tabId - b.tabId || a.startedAt - b.startedAt);
  const reclaim = planExpiryReclaim({ leases: summaryList, sessions: sessionSource, phases, now: at, isAlive });
  const matrix = buildOwnershipMatrix({ leases: summaryList, sessions: sessionSource, phases, controls, now: at, isAlive });
  return {
    at,
    generatedAt: new Date(at).toISOString(),
    adopt,
    releaseOrphans: reclaim.reclaim,
    renewals: planRenewals({ leases: summaryList, sessions: sessionSource, phases, now: at, isAlive }),
    conflicts: matrix.conflicts,
    stats: {
      sessions: sessionSource.length,
      leases: summaryList.length,
      adopt: adopt.length,
      releaseOrphans: reclaim.reclaim.length,
      conflicts: matrix.conflicts.length,
    },
  };
}

/**
 * 汇总一份可序列化的租约报告（status 视图 / 恢复报告共用）。
 * 所有子报告都是"只读证据"：reclaim 只是计划（dryRun 语义），不会真的释放。
 */
export function buildLeaseReport({
  matrix = null,
  reclaim = null,
  renewals = null,
  reconcile = null,
  changes = null,
  counters = null,
  sweeper = null,
  evidence = null,
  limit = 20,
  now = Date.now(),
} = {}) {
  const at = Number(now) || Date.now();
  const max = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
  const own = matrix || buildOwnershipMatrix({ now: at });
  return {
    schema: LEASE_OWNERSHIP_SCHEMA,
    kind: LEASE_OWNERSHIP_KIND,
    at,
    generatedAt: new Date(at).toISOString(),
    totals: own.totals,
    tabs: own.rows.slice(0, max),
    tabsTruncated: own.rows.length > max,
    tabsTotal: own.rows.length,
    conflicts: own.conflicts.slice(0, max),
    conflictsTruncated: own.conflicts.length > max,
    orphans: own.orphans.slice(0, max),
    reclaim: reclaim ? {
      dryRun: true,
      generatedAt: reclaim.generatedAt,
      stats: reclaim.stats,
      items: reclaim.reclaim.slice(0, max),
      skipped: reclaim.skipped.slice(0, max),
      skippedTruncated: reclaim.skipped.length > max,
    } : null,
    renewals: renewals ? {
      withinMs: renewals.withinMs,
      stats: renewals.stats,
      due: renewals.due.slice(0, max),
    } : null,
    reconcile: reconcile ? {
      generatedAt: reconcile.generatedAt,
      stats: reconcile.stats,
      adopt: reconcile.adopt.slice(0, max),
      adoptTruncated: reconcile.adopt.length > max,
    } : null,
    changes: changes || null,
    counters: counters || null,
    sweeper: sweeper || null,
    evidence: Array.isArray(evidence) ? evidence.slice(0, Math.max(1, max * 2)) : [],
  };
}

/** 冲突的证据化人话解释（CLI/日志复用）。 */
export function describeLeaseConflict(conflict) {
  if (!isObject(conflict)) return '租约冲突：无证据';
  const holder = conflict.holder || '(空)';
  const participants = Array.isArray(conflict.participants) ? conflict.participants : [];
  const participantText = participants.length
    ? '；参与者 ' + participants.map((item) => (isObject(item) ? item.sessionId : item)).join(', ')
    : '';
  const remaining = Number(conflict.remainingMs) || 0;
  return 'tab ' + (conflict.tabId === undefined ? '?' : conflict.tabId)
    + ' 的租约由会话 ' + holder + ' 持有'
    + '（epoch ' + (Number(conflict.epoch) || 0) + '，原因 ' + (conflict.reason || 'acquire')
    + '，剩余 ' + round1(remaining / 1000) + 's）'
    + '；请求者 ' + (conflict.requestedBy || '?')
    + ' 因 ' + (conflict.requestedReason || 'acquire') + ' 被拒绝'
    + participantText;
}

/** 租约状态的一句话解释。 */
export function describeLeaseState(row) {
  if (!isObject(row)) return '未知 tab';
  const lease = row.holder
    ? 'holder=' + row.holder + '（' + row.state + '，剩余 ' + round1((Number(row.remainingMs) || 0) / 1000) + 's）'
    : '无 holder（' + row.state + '）';
  return 'tab ' + row.tabId + '：' + lease
    + '；会话 ' + (Number(row.sessionCount) || 0) + '，参与者 ' + (Number(row.participantCount) || 0);
}

/**
 * 单 tab 所有权变化（两次报告之间）。
 * 用于 daemon 在 status/evidence 里回答"自上次报告以来，谁拿到了/丢了 tab 所有权"。
 * @param {object|null} previous 上一次的 buildTabOwnershipRow 行
 * @param {object|null} current 本次的行
 */
export function ownershipChangeOf(previous, current) {
  const before = isObject(previous) ? previous : null;
  const after = isObject(current) ? current : null;
  if (!before && !after) return null;
  const tabId = after ? after.tabId : before.tabId;
  if (!before && after) {
    return {
      type: 'added',
      tabId,
      holder: after.holder,
      epoch: after.epoch,
      sessionCount: after.sessionCount,
      at: Number(after.acquiredAt) || 0,
    };
  }
  if (before && !after) {
    return {
      type: 'removed',
      tabId,
      holder: before.holder,
      epoch: before.epoch,
      sessionCount: before.sessionCount,
    };
  }
  if (before.holder !== after.holder) {
    return {
      type: 'holder-changed',
      tabId,
      from: before.holder,
      to: after.holder,
      fromEpoch: before.epoch,
      toEpoch: after.epoch,
      sessionCount: after.sessionCount,
    };
  }
  if (before.sessionCount !== after.sessionCount || before.participantCount !== after.participantCount) {
    return {
      type: 'sessions-changed',
      tabId,
      holder: after.holder,
      fromSessions: before.sessionCount,
      toSessions: after.sessionCount,
      fromParticipants: before.participantCount,
      toParticipants: after.participantCount,
    };
  }
  return null;
}

/**
 * 两份所有权矩阵的差异（报告/日志/CLI 轮询用）。
 * @param {object|null} previous buildOwnershipMatrix() 结果
 * @param {object|null} current buildOwnershipMatrix() 结果
 * @param {{now?: number}} options
 */
export function diffOwnershipMatrices(previous, current, { now = Date.now() } = {}) {
  const previousRows = new Map();
  for (const row of (previous && Array.isArray(previous.rows)) ? previous.rows : []) {
    const tabId = normalizeTabId(row && row.tabId);
    if (tabId !== null) previousRows.set(tabId, row);
  }
  const currentRows = new Map();
  for (const row of (current && Array.isArray(current.rows)) ? current.rows : []) {
    const tabId = normalizeTabId(row && row.tabId);
    if (tabId !== null) currentRows.set(tabId, row);
  }
  const changes = [];
  const tabIds = [...new Set([...previousRows.keys(), ...currentRows.keys()])].sort((a, b) => a - b);
  for (const tabId of tabIds) {
    const change = ownershipChangeOf(previousRows.get(tabId) || null, currentRows.get(tabId) || null);
    if (change) changes.push(change);
  }
  const counts = { added: 0, removed: 0, holderChanged: 0, sessionsChanged: 0 };
  for (const change of changes) {
    if (change.type === 'added') counts.added += 1;
    else if (change.type === 'removed') counts.removed += 1;
    else if (change.type === 'holder-changed') counts.holderChanged += 1;
    else if (change.type === 'sessions-changed') counts.sessionsChanged += 1;
  }
  return {
    at: Number(now) || Date.now(),
    generatedAt: new Date(Number(now) || Date.now()).toISOString(),
    firstReport: !previous,
    changes,
    counts,
    changed: changes.length > 0,
    unchanged: changes.length === 0,
  };
}

/** 把冲突列表压成按严重度/tab 的计数（视图层摘要用）。 */
export function summarizeConflicts(conflicts) {  const summary = { total: 0, high: 0, warn: 0, info: 0, byCode: {} };
  for (const conflict of Array.isArray(conflicts) ? conflicts : []) {
    summary.total += 1;
    const severity = conflict && conflict.severity;
    if (severity === 'high') summary.high += 1;
    else if (severity === 'warn') summary.warn += 1;
    else summary.info += 1;
    const code = String((conflict && conflict.code) || 'unknown');
    summary.byCode[code] = (summary.byCode[code] || 0) + 1;
  }
  return summary;
}
