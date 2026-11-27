// daemon/lease-arbitration.js —— 多会话 tab 所有权冲突的**跨会话裁决**层。
//
// 定位：daemon/lease-registry.js 负责"发现冲突"（lease-holder-missing /
// session-not-participant / duplicate-participant ...），lease-ops.js 负责"执行单步操作"
// （acquire/join/transfer/release）。本模块夹在两者之间，回答：
//     "同一个 tab 上多个会话吵起来了，到底谁留下、谁让位、让到哪里去？"
//
// 设计原则：
// 1) **纯判定层**：arbitrateLeaseConflicts() 只吃快照（租约/会话/phase/冲突）出裁决计划，
//    不调用任何写方法；applyArbitrationPlan() 才按计划执行，且默认 dry-run。
//    这样单测可以精确覆盖"谁赢、为什么、失败怎么办"，也保证 daemon 的默认行为不变
//    （没有任何请求时不会自动抢租约）。
// 2) **保守优先**：没有存活候选时只释放残租，不做"猜测性转移"；状态不一致
//    （holder 不在参与者里 / 参与者重复 / tab 归属错乱）一律 report-only（repair），
//    绝不自动改结构。
// 3) **确定性**：同分候选按 sessionId 字典序兜底，保证同样的输入永远产生同样的裁决；
//    策略（fifo/lru/priority/holder）只影响排序，不影响"可不可以动手"。
// 4) **裁决可解释**：每条 verdict 带 candidates（含 score/reasons）、winner、losers、
//    steps（op + 参数 + 原因）与 confidence，CLI 可以直接渲染成表。
//
// 冲突码 → 动作映射（与 lease-registry 的输出一一对应）：
//   lease-holder-missing      → promote（有存活候选）/ release（无候选）
//   lease-holder-stopping     → release（等 session.stop 完成；deferred=true）
//   lease-participant-missing → prune（摘掉失联参与者）
//   session-without-lease     → adopt（无租约时由最强会话 acquire）
//   session-not-participant   → attach（登记为共享参与者，不抢 holder）
//   lease-holder-not-participant / duplicate-participant / lease-tab-mismatch → repair（只报告）
//   control-without-session   → drop-control（有 dropControl 能力时）

/** 裁决计划结构版本（新增字段只加不改）。 */
export const ARBITRATION_SCHEMA = 1;
export const ARBITRATION_KIND = 'bridge/lease-arbitration';
export const ARBITRATION_PLAN_KIND = 'bridge/lease-arbitration-plan';

/** 候选排序策略。 */
export const ARBITRATION_STRATEGIES = Object.freeze(['fifo', 'lru', 'priority', 'holder']);

/** 裁决动作取值。 */
export const ARBITRATION_ACTIONS = Object.freeze([
  'promote', 'release', 'attach', 'adopt', 'prune', 'repair', 'dedupe', 'drop-control', 'none',
]);

/** 冲突严重度排序。 */
export const ARBITRATION_SEVERITIES = Object.freeze(['high', 'warn', 'info']);

/**
 * 默认裁决策略：
 * - strategy：候选排序（fifo=最早创建的会话优先；lru=最近活跃优先；priority=显式优先级；
 *   holder=存活 holder 优先，其余 fifo）；
 * - preempt：允许抢占"存活但已过期"的 holder（默认 false，与 lease-registry 的保守口径一致）；
 * - allowForce：允许 force release（默认 false；true 时走 by=lease-arbiter 的显式授权）；
 * - reviveWindowMs：holder 失联多久内仍视为"可能回来"，仅用于报告标注，不影响执行；
 * - limit：一次最多裁决多少个 tab；
 * - includeClean：是否把"无冲突"的 tab 也列进 verdicts（默认 false）。
 */
export const ARBITRATION_DEFAULTS = Object.freeze({
  strategy: 'fifo',
  preempt: false,
  allowForce: false,
  reviveWindowMs: 30_000,
  limit: 20,
  includeClean: false,
  by: 'lease-arbiter',
});
export const CONFLICT_ACTION_MAP = Object.freeze({
  'lease-holder-missing': Object.freeze({ action: 'promote', severity: 'high', reportOnly: false }),
  'lease-holder-stopping': Object.freeze({ action: 'release', severity: 'warn', reportOnly: false, deferred: true }),
  'lease-holder-not-participant': Object.freeze({ action: 'repair', severity: 'high', reportOnly: true }),
  'lease-participant-missing': Object.freeze({ action: 'prune', severity: 'warn', reportOnly: false }),
  'duplicate-participant': Object.freeze({ action: 'dedupe', severity: 'warn', reportOnly: true }),
  'session-without-lease': Object.freeze({ action: 'adopt', severity: 'info', reportOnly: false }),
  'session-not-participant': Object.freeze({ action: 'attach', severity: 'high', reportOnly: false }),
  'lease-tab-mismatch': Object.freeze({ action: 'repair', severity: 'high', reportOnly: true }),
  'control-without-session': Object.freeze({ action: 'drop-control', severity: 'info', reportOnly: false }),
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function severityRank(severity) {
  const index = ARBITRATION_SEVERITIES.indexOf(toText(severity));
  return index < 0 ? ARBITRATION_SEVERITIES.length : index;
}

function maxSeverity(list) {
  let best = null;
  for (const severity of list) {
    if (best === null || severityRank(severity) < severityRank(best)) best = severity;
  }
  return best || 'info';
}

/** 归一化裁决策略：非法值夹取/回退（绝不因为运维参数写错而拒绝裁决）。 */
export function normalizeArbitrationPolicy(input = {}, { base = ARBITRATION_DEFAULTS } = {}) {
  const source = isObject(input) ? input : {};
  const fallback = isObject(base) ? base : ARBITRATION_DEFAULTS;
  const clamped = [];
  let strategy = toText(source.strategy === undefined ? fallback.strategy : source.strategy).trim().toLowerCase();
  if (!ARBITRATION_STRATEGIES.includes(strategy)) {
    clamped.push({ key: 'strategy', from: source.strategy, to: fallback.strategy, reason: 'unknown-strategy' });
    strategy = fallback.strategy;
  }
  const bool = (key) => {
    const raw = source[key] === undefined ? fallback[key] : source[key];
    if (typeof raw === 'boolean') return raw;
    clamped.push({ key, from: raw, to: Boolean(fallback[key]), reason: 'not-boolean' });
    return fallback[key] === true;
  };
  const limitRaw = Number(source.limit === undefined ? fallback.limit : source.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : fallback.limit;
  if (Number.isInteger(limitRaw) && limitRaw !== limit) clamped.push({ key: 'limit', from: source.limit, to: limit, reason: 'clamped' });
  if (!Number.isInteger(limitRaw)) clamped.push({ key: 'limit', from: source.limit, to: fallback.limit, reason: 'not-positive-integer' });
  const reviveRaw = Number(source.reviveWindowMs === undefined ? fallback.reviveWindowMs : source.reviveWindowMs);
  const reviveWindowMs = Number.isFinite(reviveRaw) && reviveRaw >= 0 ? Math.min(Math.floor(reviveRaw), 3_600_000) : fallback.reviveWindowMs;
  const policy = {
    strategy,
    preempt: bool('preempt'),
    allowForce: bool('allowForce'),
    reviveWindowMs,
    limit,
    includeClean: bool('includeClean'),
    by: toText(source.by === undefined ? fallback.by : source.by).slice(0, 80) || fallback.by,
  };
  return { policy: Object.freeze(policy), clamped };
}

/** 会话活跃时间：优先最近 Agent 活动，其次人类输入，最后启动时间。 */
function lastActivityOf(session) {
  return Math.max(
    toInt(session && session.lastAgentActivity, 0),
    toInt(session && session.lastHumanInputAt, 0),
    toInt(session && session.startedAt, 0),
  );
}

/** 会话显式优先级：session.priority 或 session.meta.priority（-10..10）。 */
function priorityOf(session) {
  const raw = session && (session.priority !== undefined ? session.priority : (session.meta && session.meta.priority));
  const number = Number(raw);
  return Number.isFinite(number) ? Math.max(-10, Math.min(10, Math.floor(number))) : 0;
}

/**
 * 构造候选会话（租约参与者 ∪ 登记在 tab 上的会话），并标注存活/角色。
 * 死会话保留在候选列表（带 alive=false），供证据展示，但不会被选为 winner。
 */
export function collectCandidates({ lease = null, sessions = [], phases = null, isAlive = () => true } = {}) {
  const phaseOf = (sessionId) => {
    if (!phases) return null;
    if (typeof phases === 'function') {
      try { return phases(sessionId) || null; } catch { return null; }
    }
    if (phases instanceof Map) return phases.get(sessionId) || null;
    return isObject(phases) ? phases[sessionId] || null : null;
  };
  const aliveCheck = typeof isAlive === 'function' ? isAlive : () => true;
  const byId = new Map();
  const push = (sessionId, extra = {}) => {
    const id = toText(sessionId).trim();
    if (!id) return;
    const existing = byId.get(id);
    if (existing) {
      existing.isHolder = existing.isHolder || extra.holder === true;
      existing.isParticipant = existing.isParticipant || extra.participant === true;
      existing.roles = [...new Set([...existing.roles, ...(extra.roles || [])])];
      if (!existing.attachedAt && extra.attachedAt) existing.attachedAt = toInt(extra.attachedAt, 0);
      return;
    }
    byId.set(id, {
      sessionId: id,
      isHolder: extra.holder === true,
      isParticipant: extra.participant === true,
      attachedAt: toInt(extra.attachedAt, 0),
      roles: [...new Set(extra.roles || [])],
      startedAt: 0,
      lastActivityAt: 0,
      priority: 0,
      phase: null,
      alive: false,
      connected: true,
      record: null,
    });
  };
  const participants = lease && Array.isArray(lease.participants) ? lease.participants : [];
  for (const participant of participants) {
    push(participant && participant.sessionId, {
      holder: lease && lease.holder === (participant && participant.sessionId),
      participant: true,
      attachedAt: toInt(participant && participant.attachedAt, 0),
      roles: [lease && lease.holder === (participant && participant.sessionId) ? 'holder' : 'participant'],
    });
  }
  if (lease && lease.holder) push(lease.holder, { holder: true, attachedAt: toInt(lease.acquiredAt, 0), roles: ['holder'] });
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const id = toText(session && session.sessionId).trim();
    if (!id) continue;
    push(id, {
      participant: false,
      roles: ['session'],
      attachedAt: toInt(session && session.startedAt, 0),
    });
  }
  const phase = (sessionId) => {
    const session = [...(Array.isArray(sessions) ? sessions : [])].find((item) => toText(item && item.sessionId) === sessionId) || null;
    return phaseOf(sessionId) || (session && session.phase) || null;
  };
  const list = [];
  for (const candidate of byId.values()) {
    const session = (Array.isArray(sessions) ? sessions : []).find((item) => toText(item && item.sessionId) === candidate.sessionId) || null;
    candidate.record = session;
    candidate.startedAt = toInt(session && session.startedAt, candidate.attachedAt);
    candidate.lastActivityAt = lastActivityOf(session);
    candidate.priority = priorityOf(session);
    candidate.phase = phase(candidate.sessionId);
    candidate.stopped = candidate.phase === 'stopping' || candidate.phase === 'stopped';
    candidate.alive = candidate.stopped ? false : (aliveCheck(candidate.sessionId) === true);
    candidate.connected = session ? session.connected !== false : true;
    list.push(candidate);
  }
  list.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return list;
}

/**
 * 按策略给候选排序（只排存活候选；已停止/失联的不参与 winner 竞争）。
 * @param {object[]} candidates collectCandidates() 的输出
 * @param {object} [policy] 已归一化的策略（允许传原始对象，内部会归一化）
 */
export function rankCandidates(candidates = [], policy = ARBITRATION_DEFAULTS) {
  const normalized = isObject(policy) && ARBITRATION_STRATEGIES.includes(policy.strategy) && 'limit' in policy
    ? policy
    : normalizeArbitrationPolicy(policy).policy;
  const strategy = normalized.strategy;
  const alive = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate && candidate.alive === true);
  const scored = alive.map((candidate) => {
    const reasons = [];
    let score;
    switch (strategy) {
    case 'lru':
      score = candidate.lastActivityAt;
      reasons.push('lastActivity=' + candidate.lastActivityAt);
      if (candidate.isHolder) { score += 1_000; reasons.push('holder-bonus'); }
      break;
    case 'priority':
      score = candidate.priority * 1_000_000 + (2_000_000_000 - candidate.startedAt);
      reasons.push('priority=' + candidate.priority, 'startedAt=' + candidate.startedAt);
      if (candidate.isHolder) reasons.push('holder');
      break;
    case 'holder':
      score = (candidate.isHolder ? 2_000_000_000 : 0) + (2_000_000_000 - candidate.startedAt);
      reasons.push(candidate.isHolder ? 'holder-first' : 'fifo', 'startedAt=' + candidate.startedAt);
      break;
    case 'fifo':
    default:
      score = 2_000_000_000 - candidate.startedAt;
      reasons.push('startedAt=' + candidate.startedAt);
      if (candidate.isHolder) { score += 1; reasons.push('holder-tiebreak'); }
      break;
    }
    return { ...candidate, score, reasons };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return scored.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/** 取冲突码对应的动作元数据（未登记的码按 report-only 处理）。 */
export function actionForConflictCode(code) {
  const key = toText(code);
  return CONFLICT_ACTION_MAP[key] || { action: 'none', severity: 'info', reportOnly: true, unregistered: true };
}

/** 证据辅助：把任意数组按 tabId 建索引（跳过非法 tab）。 */
function groupByTab(list) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const tabId = item && item.tabId;
    const id = Number(tabId);
    if (!Number.isInteger(id) || id < 0) continue;
    let bucket = map.get(id);
    if (!bucket) {
      bucket = [];
      map.set(id, bucket);
    }
    bucket.push(item);
  }
  return map;
}

/**
 * 裁决单个 tab。输入均为快照/纯数据，返回可序列化 verdict。
 *
 * verdict 里的 steps 是**建议步骤**：
 * - op=transfer/acquire/join/release/prune/drop-control 的步骤可以被 applyArbitrationPlan 执行；
 * - reportOnly 的 verdict 没有可执行步骤（steps 为空），只提示人工处理。
 */
export function buildTabVerdict({
  tabId,
  lease = null,
  sessions = [],
  phases = null,
  conflicts = [],
  policy = ARBITRATION_DEFAULTS,
  now = Date.now(),
  isAlive = () => true,
} = {}) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id < 0) return null;
  const normalized = isObject(policy) && 'strategy' in policy && 'limit' in policy
    ? policy
    : normalizeArbitrationPolicy(policy).policy;
  const at = toInt(now, Date.now());
  const conflictList = (Array.isArray(conflicts) ? conflicts : [])
    .filter((item) => item && Number(item.evidence && item.evidence.tabId) === id)
    .map((item) => ({ code: toText(item.code), severity: toText(item.severity) || actionForConflictCode(item.code).severity, message: toText(item.message), evidence: isObject(item.evidence) ? item.evidence : {} }));
  const codes = [...new Set(conflictList.map((item) => item.code))];
  const candidates = collectCandidates({ lease, sessions, phases, isAlive });
  const ranked = rankCandidates(candidates, normalized);
  const winner = ranked.length ? ranked[0] : null;
  const holder = lease && lease.holder ? toText(lease.holder) : null;
  const holderCandidate = holder ? candidates.find((candidate) => candidate.sessionId === holder) || null : null;
  const holderAlive = holder ? Boolean(holderCandidate && holderCandidate.alive === true) : null;
  const steps = [];
  const losers = [];
  const notes = [];
  let action = 'none';
  let reportOnly = false;
  let deferred = false;
  let confidence = 1;

  const pushStep = (op, args, reason, extra = {}) => {
    steps.push({ index: steps.length, op, args, reason, ...extra });
  };
  const conflict = (code) => conflictList.find((item) => item.code === code) || null;
  const registered = candidates.filter((candidate) => candidate.roles.includes('session'));

  // ---- 1) holder 失联：晋升存活候选，或释放残租 ----
  if (codes.includes('lease-holder-missing')) {
    if (winner) {
      action = 'promote';
      confidence = 0.9;
      pushStep('transfer', { tabId: id, from: holder, to: winner.sessionId }, 'holder-missing');
      for (const candidate of ranked.slice(1)) {
        losers.push({ sessionId: candidate.sessionId, disposition: 'participant', reason: 'candidate-lost' });
      }
      notes.push('将 tab ' + id + ' 的独占所有权从失联 holder ' + (holder || '(空)') + ' 转给存活会话 ' + winner.sessionId);
    } else {
      action = 'release';
      confidence = 0.8;
      pushStep('release', {
        tabId: id,
        sessionId: holder,
        reason: 'holder-missing',
        force: normalized.allowForce === true,
        by: normalized.by,
      }, 'holder-missing-no-candidate');
      notes.push('tab ' + id + ' 的 holder ' + (holder || '(空)') + ' 已失联且没有存活候选，释放为自由 tab');
    }
    // holder 失联时，失联参与者一并清理（复用 prune 逻辑）。
    for (const participant of lease && Array.isArray(lease.participants) ? lease.participants : []) {
      const sid = toText(participant && participant.sessionId);
      if (!sid || sid === holder) continue;
      const candidate = candidates.find((item) => item.sessionId === sid);
      if (candidate && candidate.alive === false) {
        pushStep('prune', { tabId: id, sessionId: sid, reason: 'participant-missing' }, 'holder-missing-cleanup');
        losers.push({ sessionId: sid, disposition: 'release', reason: 'participant-missing' });
      }
    }
  } else if (codes.includes('lease-holder-stopping')) {
    // ---- 2) holder 正在停止：等 stop 完成即可，不抢 ----
    action = 'release';
    reportOnly = false;
    deferred = true;
    confidence = 0.95;
    pushStep('release', { tabId: id, sessionId: holder, reason: 'holder-stopping' }, 'session-stopping');
    notes.push('holder ' + (holder || '(空)') + ' 正在 stopping：随后续 session.stop 一起释放，不抢先转移');
  }

  // ---- 3) 会话在 tab 上没有租约：adopt 最强会话（仅当当前没有 holder）----
  if (codes.includes('session-without-lease')) {
    // 冲突证据里点名了哪些会话没有租约；没有点名时才退回"tab 上全部登记会话"。
    const named = conflictList
      .filter((item) => item.code === 'session-without-lease')
      .map((item) => toText(item.evidence && item.evidence.sessionId))
      .filter(Boolean);
    const targetIds = named.length ? [...new Set(named)] : registered.map((candidate) => candidate.sessionId);
    const orphans = targetIds
      .map((sessionId) => candidates.find((candidate) => candidate.sessionId === sessionId))
      .filter((candidate) => candidate && candidate.alive === true);
    if (!holder && orphans.length) {
      const best = rankCandidates(orphans, normalized)[0] || orphans[0];
      if (action === 'none') action = 'adopt';
      confidence = Math.min(confidence, 0.85);
      pushStep('acquire', { tabId: id, sessionId: best.sessionId, reason: 'session-without-lease' }, 'adopt-best-session');
      for (const loser of orphans) {
        if (loser.sessionId === best.sessionId) continue;
        pushStep('join', { tabId: id, sessionId: loser.sessionId, reason: 'session-without-lease-share' }, 'adopt-loser-join');
        losers.push({ sessionId: loser.sessionId, disposition: 'participant', reason: 'adopt-loser' });
      }
      notes.push('tab ' + id + ' 没有租约：存活会话 ' + best.sessionId + ' 取得所有权，其余登记为共享参与者');
    } else if (holder && orphans.length) {
      if (action === 'none') action = 'attach';
      confidence = Math.min(confidence, 0.9);
      for (const orphan of orphans) {
        if (orphan.sessionId === holder) continue;
        pushStep('join', { tabId: id, sessionId: orphan.sessionId, reason: 'session-without-lease-attach' }, 'attach-to-holder');
        losers.push({ sessionId: orphan.sessionId, disposition: 'participant', reason: 'attach-to-holder' });
      }
      notes.push('tab ' + id + ' 已有 holder ' + holder + '：无租约会话登记为共享参与者');
    }
  }

  // ---- 4) 会话不是参与者：登记为共享参与者（不抢 holder）----
  const notParticipant = conflict('session-not-participant');
  if (notParticipant) {
    const sessionId = toText(notParticipant.evidence && notParticipant.evidence.sessionId);
    const candidate = candidates.find((item) => item.sessionId === sessionId);
    if (candidate && candidate.alive === true) {
      if (action === 'none') action = 'attach';
      confidence = Math.min(confidence, 0.85);
      pushStep('join', { tabId: id, sessionId, reason: 'session-not-participant' }, 'register-participant');
      losers.push({ sessionId, disposition: 'participant', reason: 'not-registered' });
      notes.push('会话 ' + sessionId + ' 在 tab ' + id + ' 上但未登记：补登为共享参与者（holder=' + (holder || '-') + '）');
    } else {
      reportOnly = true;
      if (action === 'none') action = 'repair';
      notes.push('冲突涉及会话 ' + (sessionId || '?') + ' 已失联/停止：建议随 stop 清理，不自动改租约');
    }
  }

  // ---- 5) 失联参与者：摘除 ----
  if (codes.includes('lease-participant-missing')) {
    const seen = new Set(steps.filter((step) => step.op === 'prune').map((step) => step.args.sessionId));
    for (const participant of lease && Array.isArray(lease.participants) ? lease.participants : []) {
      const sid = toText(participant && participant.sessionId);
      if (!sid || sid === holder || seen.has(sid)) continue;
      const candidate = candidates.find((item) => item.sessionId === sid);
      if (candidate && candidate.alive === false) {
        if (action === 'none') action = 'prune';
        confidence = Math.min(confidence, 0.9);
        pushStep('prune', { tabId: id, sessionId: sid, reason: 'participant-missing' }, 'detach-dead-participant');
        losers.push({ sessionId: sid, disposition: 'release', reason: 'participant-missing' });
        seen.add(sid);
      }
    }
    if (steps.filter((step) => step.op === 'prune').length === 0) {
      reportOnly = true;
      if (action === 'none') action = 'prune';
      notes.push('冲突码 lease-participant-missing 没有可执行的摘除目标（可能已被清理）');
    }
  }

  // ---- 6) 只报告类冲突：repair（绝不自动改结构）----
  for (const code of ['lease-holder-not-participant', 'duplicate-participant', 'lease-tab-mismatch']) {
    if (!codes.includes(code)) continue;
    reportOnly = true;
    if (action === 'none') action = 'repair';
    confidence = Math.min(confidence, 0.5);
    notes.push('冲突 ' + code + ' 属于结构不一致：只报告，需人工确认后修复');
  }

  // ---- 7) 控制记录没有会话：可选清理（由 daemon 注入 dropControl 能力）----
  if (codes.includes('control-without-session')) {
    if (action === 'none') action = 'drop-control';
    confidence = Math.min(confidence, 0.8);
    pushStep('drop-control', { tabId: id }, 'control-without-session');
    notes.push('tab ' + id + ' 的控制记录没有会话：清理控制记录（不触碰租约）');
  }

  // ---- 8) preempt：存活但 TTL 已过期的 holder（显式策略才抢占）----
  if (normalized.preempt === true && holder && holderAlive === true && lease && Number(lease.remainingMs) === 0 && winner && winner.sessionId !== holder) {
    action = 'promote';
    confidence = Math.min(confidence, 0.6);
    pushStep('transfer', { tabId: id, from: holder, to: winner.sessionId, preempt: true }, 'preempt-expired-holder');
    notes.push('策略 preempt：将过期 holder ' + holder + ' 的 tab 转给 ' + winner.sessionId);
  }

  if (!conflictList.length) {
    return {
      tabId: id,
      action: 'none',
      severity: 'info',
      conflictCodes: [],
      reason: 'no-conflict',
      confidence: 1,
      reportOnly: false,
      deferred: false,
      winner: winner ? { sessionId: winner.sessionId, rank: winner.rank, score: winner.score, reasons: winner.reasons } : null,
      losers: [],
      candidates: ranked.map(publicCandidate),
      steps: [],
      notes: notes,
      conflicts: [],
      lease: publicLease(lease),
      at,
    };
  }
  if (!steps.length) reportOnly = true;
  const severity = maxSeverity(conflictList.map((item) => item.severity));
  const verdict = {
    tabId: id,
    action: action === 'none' ? (reportOnly ? 'repair' : 'none') : action,
    severity,
    conflictCodes: codes,
    reason: buildVerdictReason({ action, codes, reportOnly, deferred, holder, winner, notes, steps }),
    confidence: Math.max(0.1, Math.min(1, Math.round(confidence * 100) / 100)),
    reportOnly,
    deferred,
    winner: winner ? { sessionId: winner.sessionId, rank: winner.rank, score: winner.score, reasons: winner.reasons } : null,
    losers,
    candidates: ranked.map(publicCandidate),
    steps,
    notes,
    conflicts: conflictList.map((item) => ({ code: item.code, severity: item.severity, message: item.message })),
    lease: publicLease(lease),
    at,
  };
  return verdict;
}

function publicCandidate(candidate) {
  return {
    sessionId: candidate.sessionId,
    rank: candidate.rank,
    score: candidate.score,
    alive: candidate.alive === true,
    isHolder: candidate.isHolder === true,
    isParticipant: candidate.isParticipant === true,
    phase: candidate.phase || null,
    startedAt: candidate.startedAt,
    lastActivityAt: candidate.lastActivityAt,
    priority: candidate.priority,
    roles: candidate.roles,
    reasons: candidate.reasons,
  };
}

function publicLease(lease) {
  if (!isObject(lease)) return null;
  return {
    holder: lease.holder || null,
    epoch: toInt(lease.epoch, 0),
    ttlMs: toInt(lease.ttlMs, 0),
    remainingMs: toInt(lease.remainingMs, 0),
    expiresAt: toInt(lease.expiresAt, 0),
    participantCount: Array.isArray(lease.participants) ? lease.participants.length : toInt(lease.participantCount, 0),
    reason: lease.reason || null,
  };
}

function buildVerdictReason({ action, codes, reportOnly, deferred, holder, winner, notes, steps = [] }) {
  if (reportOnly) return '只报告（结构不一致/无安全自动动作）：' + codes.join(',');
  if (action === 'promote' && winner) return '把 tab 所有权判给 ' + winner.sessionId + '（依据 ' + codes.join(',') + '）';
  if (action === 'release') return '释放 tab 所有权（依据 ' + codes.join(',') + '）' + (deferred ? '，等待 stop 完成' : '');
  if (action === 'adopt' && winner) return '由 ' + winner.sessionId + ' 认领无主 tab（依据 ' + codes.join(',') + '）';
  if (action === 'attach') {
    const target = steps.find((step) => step.op === 'join');
    const sessionId = target && target.args ? toText(target.args.sessionId) : '';
    return '把冲突会话' + (sessionId ? ' ' + sessionId : '') + ' 登记为共享参与者（依据 ' + codes.join(',') + '）';
  }
  if (action === 'prune') return '摘除失联参与者（依据 ' + codes.join(',') + '）';
  if (action === 'drop-control') return '清理无会话的控制记录（依据 ' + codes.join(',') + '）';
  if (notes.length) return notes[0];
  return '无需动作';
}

/**
 * 生成完整裁决计划（纯函数）。
 *
 * @param {{leases?: object[], sessions?: object[]|Map, phases?: any, controls?: object[],
 *          conflicts?: object[]|null, now?: number, isAlive?: Function, policy?: object,
 *          tabId?: number|null, limit?: number}} input
 */
export function arbitrateLeaseConflicts({
  leases = [],
  sessions = [],
  phases = null,
  controls = [],
  conflicts: providedConflicts = null,
  now = Date.now(),
  isAlive = () => true,
  policy = ARBITRATION_DEFAULTS,
  tabId = null,
  limit = null,
} = {}) {
  const at = toInt(now, Date.now());
  const normalized = normalizeArbitrationPolicy({ ...(isObject(policy) ? policy : {}), ...(limit === null || limit === undefined ? {} : { limit }) });
  const policyOut = normalized.policy;
  const sessionSource = sessions instanceof Map ? [...sessions.values()] : (Array.isArray(sessions) ? sessions : []);
  const leaseList = Array.isArray(leases) ? leases : [];
  const conflictList = Array.isArray(providedConflicts) ? providedConflicts : [];
  const leasesByTab = groupByTab(leaseList);
  const conflictsByTab = new Map();
  for (const item of conflictList) {
    const id = Number(item && item.evidence && item.evidence.tabId);
    if (!Number.isInteger(id) || id < 0) continue;
    let bucket = conflictsByTab.get(id);
    if (!bucket) {
      bucket = [];
      conflictsByTab.set(id, bucket);
    }
    bucket.push(item);
  }
  const sessionsByTab = new Map();
  for (const session of sessionSource) {
    const id = Number(session && session.tabId);
    if (!Number.isInteger(id) || id < 0) continue;
    let bucket = sessionsByTab.get(id);
    if (!bucket) {
      bucket = [];
      sessionsByTab.set(id, bucket);
    }
    bucket.push(session);
  }
  const onlyTab = tabId === null || tabId === undefined ? null : Number(tabId);
  if (onlyTab !== null && (!Number.isInteger(onlyTab) || onlyTab < 0)) {
    return {
      schema: ARBITRATION_SCHEMA,
      kind: ARBITRATION_KIND,
      mode: 'plan',
      at,
      generatedAt: new Date(at).toISOString(),
      policy: policyOut,
      policyClamped: normalized.clamped,
      tabId: null,
      verdicts: [],
      steps: [],
      summary: emptyArbitrationSummary(),
      error: { code: 'E_BAD_ARG', message: 'tabId 需要非负整数' },
    };
  }
  const tabIds = new Set([...leasesByTab.keys(), ...sessionsByTab.keys(), ...conflictsByTab.keys()]);
  if (onlyTab !== null) {
    tabIds.clear();
    tabIds.add(onlyTab);
  }
  const verdicts = [];
  for (const id of [...tabIds].sort((a, b) => a - b)) {
    const verdict = buildTabVerdict({
      tabId: id,
      lease: (leasesByTab.get(id) || [])[0] || null,
      sessions: sessionsByTab.get(id) || [],
      phases,
      conflicts: conflictsByTab.get(id) || [],
      policy: policyOut,
      now: at,
      isAlive,
    });
    if (!verdict) continue;
    const hasConflicts = verdict.conflicts.length > 0;
    if (!hasConflicts && policyOut.includeClean !== true) continue;
    verdicts.push(verdict);
  }
  const max = policyOut.limit;
  const truncated = verdicts.length > max;
  const kept = verdicts.slice(0, max);
  const steps = [];
  for (const verdict of kept) {
    for (const step of verdict.steps) {
      steps.push({ ...step, index: steps.length, tabId: verdict.tabId, verdictAction: verdict.action });
    }
  }
  const summary = {
    tabs: tabIds.size,
    leases: leaseList.length,
    sessions: sessionSource.length,
    conflicts: conflictList.length,
    verdicts: kept.length,
    cleanTabs: verdicts.filter((verdict) => verdict.conflicts.length === 0).length,
    actionable: kept.filter((verdict) => verdict.reportOnly !== true && verdict.steps.length > 0).length,
    reportOnly: kept.filter((verdict) => verdict.reportOnly === true).length,
    deferred: kept.filter((verdict) => verdict.deferred === true).length,
    steps: steps.length,
    highSeverity: kept.filter((verdict) => verdict.severity === 'high').length,
    warnSeverity: kept.filter((verdict) => verdict.severity === 'warn').length,
    infoSeverity: kept.filter((verdict) => verdict.severity === 'info').length,
    byAction: countBy(kept.map((verdict) => verdict.action)),
    byCode: countBy(kept.flatMap((verdict) => verdict.conflictCodes)),
    winners: kept.filter((verdict) => verdict.winner).map((verdict) => verdict.winner.sessionId),
  };
  return {
    schema: ARBITRATION_SCHEMA,
    kind: ARBITRATION_KIND,
    mode: 'plan',
    at,
    generatedAt: new Date(at).toISOString(),
    policy: policyOut,
    policyClamped: normalized.clamped,
    tabId: onlyTab,
    verdicts: kept,
    steps,
    summary,
    truncated,
    controls: Array.isArray(controls) ? controls.length : 0,
  };
}

function countBy(values) {
  const out = {};
  for (const value of values) {
    const key = toText(value) || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function emptyArbitrationSummary() {
  return {
    tabs: 0,
    leases: 0,
    sessions: 0,
    conflicts: 0,
    verdicts: 0,
    cleanTabs: 0,
    actionable: 0,
    reportOnly: 0,
    deferred: 0,
    steps: 0,
    highSeverity: 0,
    warnSeverity: 0,
    infoSeverity: 0,
    byAction: {},
    byCode: {},
    winners: [],
  };
}

/**
 * 执行裁决计划里的步骤。默认**不执行**（dryRun=true），只有显式 apply 才调用 ops。
 *
 * ops 接口（全部可选；缺失的 op 记为 unsupported，不会崩）：
 *   transfer(tabId, from, to, { reason }) -> result
 *   release(tabId, sessionId, { reason, force, by }) -> result
 *   acquire(tabId, sessionId, { reason }) -> result
 *   join(tabId, sessionId, { reason }) -> result
 *   dropControl(tabId) -> result
 *
 * @returns {{dryRun: boolean, at: number, applied: object[], skipped: object[], failed: object[],
 *            summary: {steps: number, ok: number, failed: number, skipped: number, unsupported: number}}}
 */
export function applyArbitrationPlan(plan = {}, ops = {}, { now = Date.now(), dryRun = false, log = () => {} } = {}) {
  const at = toInt(now, Date.now());
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const result = {
    dryRun: dryRun === true,
    at,
    applied: [],
    skipped: [],
    failed: [],
    summary: { steps: steps.length, ok: 0, failed: 0, skipped: 0, unsupported: 0 },
  };
  if (dryRun === true) {
    return result;
  }
  const call = (name, args) => {
    const fn = ops && typeof ops[name] === 'function' ? ops[name] : null;
    if (!fn) return { unsupported: true };
    try {
      return { result: fn(...args) };
    } catch (error) {
      return { error };
    }
  };
  for (const step of steps) {
    const args = step.args || {};
    const op = toText(step.op);
    let outcome;
    switch (op) {
    case 'transfer':
      outcome = call('transfer', [args.tabId, args.from, args.to, { reason: step.reason }]);
      break;
    case 'release':
      outcome = call('release', [args.tabId, args.sessionId, { reason: args.reason || step.reason, force: args.force === true, by: args.by || null }]);
      break;
    case 'acquire':
      outcome = call('acquire', [args.tabId, args.sessionId, { reason: args.reason || step.reason }]);
      break;
    case 'join':
      outcome = call('join', [args.tabId, args.sessionId, { reason: args.reason || step.reason }]);
      break;
    case 'prune':
      outcome = call('release', [args.tabId, args.sessionId, { reason: 'participant-missing', force: false, by: null }]);
      break;
    case 'drop-control':
      outcome = call('dropControl', [args.tabId]);
      break;
    default:
      outcome = { unsupported: true };
      break;
    }
    if (outcome.unsupported) {
      result.summary.unsupported += 1;
      result.skipped.push({ index: step.index, op, tabId: step.tabId, reason: 'unsupported-op' });
      continue;
    }
    if (outcome.error) {
      result.summary.failed += 1;
      result.failed.push({ index: step.index, op, tabId: step.tabId, reason: step.reason, code: (outcome.error && outcome.error.code) || 'E_INTERNAL', message: toText(outcome.error && outcome.error.message) });
      try { log('租约裁决步骤失败：' + op + ' tab=' + step.tabId + ' ' + toText(outcome.error && outcome.error.message)); } catch { /* 忽略 */ }
      continue;
    }
    const value = outcome.result;
    const ok = value && value.ok === false ? false : !(value === false);
    if (!ok) {
      result.summary.failed += 1;
      result.failed.push({ index: step.index, op, tabId: step.tabId, reason: step.reason, code: (value && value.code) || 'E_INTERNAL', message: toText(value && value.message) });
      continue;
    }
    result.summary.ok += 1;
    result.applied.push({ index: step.index, op, tabId: step.tabId, reason: step.reason, result: isObject(value) ? toPlainResult(value) : value });
  }
  return result;
}

function toPlainResult(value) {
  if (!isObject(value)) return value;
  const skipKeys = new Set(['lease']);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (skipKeys.has(key)) {
      out[key] = item ? { holder: item.holder || null, epoch: item.epoch || 0 } : null;
      continue;
    }
    if (typeof item === 'function') continue;
    if (item === undefined) continue;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out[key] = toPlainResult(item);
      continue;
    }
    out[key] = item;
  }
  return out;
}

/**
 * 构造运行期裁决器：从 leaseOps 取快照、按需执行，并在应用后重新裁决出 residual。
 * 默认 dry-run；只有 `apply:true` 且 `dryRun:false` 才会调用 leaseOps 的写方法。
 */
export function createLeaseArbiter({
  leaseOps,
  sessions,
  phases = null,
  controls = () => [],
  now = () => Date.now(),
  log = () => {},
  policy: basePolicy = ARBITRATION_DEFAULTS,
  dropControl = null,
} = {}) {
  if (!leaseOps || typeof leaseOps.snapshot !== 'function') throw new TypeError('createLeaseArbiter 需要 leaseOps');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const logger = typeof log === 'function' ? log : () => {};
  const sessionMap = sessions instanceof Map ? sessions : new Map();
  const controlsFn = typeof controls === 'function' ? controls : () => (Array.isArray(controls) ? controls : []);
  const base = normalizeArbitrationPolicy(basePolicy).policy;
  const counters = { arbitrations: 0, appliedPlans: 0, stepsApplied: 0, stepsFailed: 0 };
  let lastPlanAt = 0;
  let lastApplyAt = 0;

  function isAlive(sessionId) {
    const id = toText(sessionId);
    if (!id) return false;
    return sessionMap.has(id) || id.startsWith('start:');
  }

  function collect() {
    const leases = leaseOps.snapshot();
    // 冲突优先来自 leaseOps 的所有权矩阵（与 status views=leases 同一份证据）；
    // 裁剪部署没有 ownershipMatrix 时退化为"无冲突"（仍可做 includeClean 报告）。
    let conflicts = [];
    if (typeof leaseOps.ownershipMatrix === 'function') {
      try {
        const matrix = leaseOps.ownershipMatrix();
        conflicts = Array.isArray(matrix && matrix.conflicts) ? matrix.conflicts : [];
      } catch (error) {
        logger('租约裁决：读取所有权矩阵失败（按无冲突处理）：' + toText(error && error.message));
      }
    }
    return {
      leases,
      sessions: [...sessionMap.values()],
      phases,
      controls: controlsFn(),
      conflicts,
      now: clock(),
    };
  }

  /** 只读报告（status 增量视图 / `bridge daemon lease report`）。 */
  function report({ limit = base.limit, strategy = base.strategy, includeClean = base.includeClean } = {}) {
    const snapshotNow = collect();
    const plan = arbitrateLeaseConflicts({
      ...snapshotNow,
      policy: { ...base, strategy, limit, includeClean },
      isAlive,
    });
    lastPlanAt = plan.at;
    return plan;
  }

  /**
   * 裁决（默认 dry-run）。
   * @param {{apply?: boolean, dryRun?: boolean, policy?: object|string, strategy?: string,
   *          tabId?: number|null, limit?: number, includeClean?: boolean, force?: boolean}} params
   */
  function arbitrate(params = {}) {
    const source = isObject(params) ? params : {};
    const policyInput = {
      ...base,
      ...(typeof source.policy === 'string' ? { strategy: source.policy } : (isObject(source.policy) ? source.policy : {})),
      ...(source.strategy === undefined ? {} : { strategy: source.strategy }),
      ...(source.limit === undefined ? {} : { limit: source.limit }),
      ...(source.includeClean === undefined ? {} : { includeClean: source.includeClean }),
      ...(source.preempt === undefined ? {} : { preempt: source.preempt }),
      ...(source.force === true ? { allowForce: true } : {}),
    };
    const normalized = normalizeArbitrationPolicy(policyInput);
    const snapshotNow = collect();
    const plan = arbitrateLeaseConflicts({
      ...snapshotNow,
      policy: normalized.policy,
      tabId: source.tabId === undefined ? null : source.tabId,
      limit: normalized.policy.limit,
      isAlive,
    });
    counters.arbitrations += 1;
    lastPlanAt = plan.at;
    const apply = source.apply === true && source.dryRun !== true;
    if (!apply) return { ...plan, applied: null, residual: null, appliedAt: 0 };
    const applied = applyArbitrationPlan(plan, {
      transfer: (tabId, from, to, options) => leaseOps.transfer(tabId, from, to, options),
      release: (tabId, sessionId, options) => leaseOps.release(tabId, sessionId, options),
      acquire: (tabId, sessionId, options) => leaseOps.acquire(tabId, sessionId, options),
      join: (tabId, sessionId, options) => leaseOps.join(tabId, sessionId, options),
      dropControl: typeof dropControl === 'function' ? (tabId) => dropControl(tabId) : null,
    }, { now: clock(), dryRun: false, log: logger });
    counters.appliedPlans += 1;
    counters.stepsApplied += applied.summary.ok;
    counters.stepsFailed += applied.summary.failed;
    lastApplyAt = applied.at;
    const after = collect();
    const residual = arbitrateLeaseConflicts({
      ...after,
      policy: { ...normalized.policy, limit: normalized.policy.limit },
      tabId: source.tabId === undefined ? null : source.tabId,
      isAlive,
    });
    return {
      ...plan,
      applied,
      residual: {
        at: residual.at,
        summary: residual.summary,
        verdicts: residual.verdicts,
        residualConflicts: residual.summary.conflicts,
        resolved: Math.max(0, plan.summary.conflicts - residual.summary.conflicts),
      },
      appliedAt: applied.at,
      policy: normalized.policy,
    };
  }

  function stats() {
    return {
      policy: { ...base },
      counters: { ...counters },
      lastPlanAt,
      lastApplyAt,
      knownSessions: sessionMap.size,
    };
  }

  function reset() {
    for (const key of Object.keys(counters)) counters[key] = 0;
    lastPlanAt = 0;
    lastApplyAt = 0;
    return stats();
  }

  return { report, arbitrate, stats, reset, isAlive };
}

/** 人类可读摘要（CLI/日志），纯函数。 */
export function describeArbitrationPlan(plan = {}) {
  const summary = plan.summary || {};
  const actions = Object.entries(summary.byAction || {}).map(([key, count]) => key + '=' + count).join(',') || '无';
  return '租约裁决：' + (summary.verdicts || 0) + ' 个 tab（高 ' + (summary.highSeverity || 0)
    + '，警告 ' + (summary.warnSeverity || 0) + '），可执行 ' + (summary.actionable || 0)
    + '，仅报告 ' + (summary.reportOnly || 0) + '，动作 ' + actions;
}
