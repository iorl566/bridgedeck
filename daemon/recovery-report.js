// daemon/recovery-report.js —— 崩溃恢复与账本 reconcile 的端到端证据层。
//
// 定位：daemon 启动时已经做了三件事（见 daemon/session-recovery.js）：
//   1) recoverLedgerOnStartup：上次进程遗留的 pending → unknown，非幂等动作 replayBlocked；
//   2) planPersistedSessionRecovery：sessions.json 行分类为 restore/expired/invalid/duplicate；
//   3) rebuildLeases：按最老会话为 holder 重建 tab 租约。
//
// 但"恢复之后到底怎么处理"需要一条可解释、可审计、且**不自动下手**的链路。本模块负责：
//   - classifyPendingEntry / classifyRecoveryEntries：把每条未知意图分成
//     "人工必须二选一（confirmed|not-applied）" / "可批量 reconcile" / "仍在执行" / 已结算；
//   - buildRecoveryReport：把账本、会话计划、租约对账、冲突合成一份恢复报告（status/CLI 可读），
//     明确写出 autoResolved=0 与"恢复只产证据，绝不自动 resolve"；
//   - planManualResolve / applyManualResolve：人工 resolve 的计划/执行两段式。
//       * 计划阶段逐条给出 eligible/protected/active/missing 与原因（不写账本）；
//       * 执行阶段只对 eligible 调 ledger.resolve，protected 永远保持阻断，
//         且旧结论（abandoned/reconciled）不能解锁崩溃恢复的非幂等动作。
//   - createRecoveryReporter：把上面能力接到 daemon.runtime（ledger.status recovery 参数、
//     ledger.resolve 批量人工语义、status 恢复视图）。
//
// 语义边界（与 lib/intent-ledger 保持一致，不另造一套）：
//   * 非幂等动作（NON_IDEMPOTENT_METHODS）在崩溃恢复后状态未知 → 只接受 confirmed / not-applied；
//   * 其它未知/过期意图仍可用旧结论 reconcile，但本模块**不会自动调用**；
//   * 已 resolved 的记录重复 resolve 时由账本返回 duplicate 证据（本层透传）。

import {
  LEDGER_RESOLVE_OUTCOMES,
  isExplicitResolveOutcome,
  isNonIdempotentAction,
  normalizeResolveOutcome,
} from '../lib/intent-ledger.mjs';

/** 恢复报告结构版本。 */
export const RECOVERY_REPORT_SCHEMA = 1;
export const RECOVERY_REPORT_KIND = 'bridge/recovery-report';

/** 人工 resolve 策略（只读常量；报告里原样回显，便于审计"没有自动 resolve"）。 */
export const RECOVERY_MANUAL_POLICY = Object.freeze({
  autoResolve: false,
  explicitOutcomes: Object.freeze(['confirmed', 'not-applied']),
  legacyOutcomes: Object.freeze(['abandoned', 'reconciled']),
  requireExplicitForRecoveredNonIdempotent: true,
  allowResolveActive: false,
  allowResolveMissing: false,
  note: '崩溃恢复不自动 resolve；非幂等未知动作必须人工确认 confirmed 或 not-applied',
});

/** 单条意图的恢复分类。 */
export const RECOVERY_ENTRY_CLASSES = Object.freeze([
  'manual-required',   // 需要人工下结论（非幂等 UNKNOWN / 未知或过期）
  'reconcile-eligible', // 可用旧结论 reconcile（非幂等之外）
  'still-active',      // 仍在执行，不能 resolve
  'settled',           // 已结算（不在 pending 里由调用方过滤）
]);

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function toTabId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function ageOf(entry, now) {
  const at = Number.isFinite(Date.parse(entry && entry.at)) ? Date.parse(entry.at) : 0;
  return at > 0 ? Math.max(0, Number(now) - at) : 0;
}

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

/** 归一化 resolve 结论；未知结论返回 null（调用方给 E_BAD_ARG）。 */
export function normalizeRecoveryOutcome(outcome) {
  return normalizeResolveOutcome(outcome);
}

/** 该结论是否显式二选一（confirmed / not-applied / applied / none）。 */
export function isExplicitRecoveryOutcome(outcome) {
  return isExplicitResolveOutcome(outcome) === true;
}

/**
 * 单条 pending 意图的恢复分类与处置建议。
 * @param {object} entry intent ledger 的 pending 条目
 * @param {{now?: number}} options
 */
export function classifyPendingEntry(entry, { now = Date.now() } = {}) {
  if (!entry || typeof entry !== 'object') {
    return {
      id: null,
      class: 'settled',
      state: null,
      method: null,
      tabId: null,
      sessionId: null,
      manualRequired: false,
      autoResolvable: false,
      reason: 'not-an-entry',
      allowedOutcomes: [],
      requiredOutcomes: [],
      recommendation: 'ignore',
    };
  }
  const at = Number(now) || Date.now();
  const state = text(entry.state);
  const recovered = entry.recovered === true;
  const nonIdempotent = entry.nonIdempotent === true || isNonIdempotentAction(entry.method);
  const replayBlocked = entry.replayBlocked === true;
  const manualRequired = (recovered && nonIdempotent) || state === 'unknown' || state === 'stale' || replayBlocked;
  const explicitOnly = recovered && nonIdempotent;
  const recommendation = state === 'active'
    ? 'wait-for-completion'
    : explicitOnly
      ? 'ask-human-confirmed-or-not-applied'
      : manualRequired
        ? 'manual-resolve-or-reconcile'
        : 'none';
  return {
    id: text(entry.id) || null,
    class: state === 'active' ? 'still-active' : manualRequired ? (explicitOnly ? 'manual-required' : 'reconcile-eligible') : 'settled',
    state: state || null,
    method: text(entry.method) || null,
    tabId: toTabId(entry.tabId),
    sessionId: entry.sessionId === undefined || entry.sessionId === null ? null : text(entry.sessionId),
    at: text(entry.at) || null,
    ageMs: ageOf(entry, at),
    recovered,
    nonIdempotent,
    replayBlocked,
    manualRequired,
    autoResolvable: false,
    explicitOnly,
    requiredOutcomes: explicitOnly ? ['confirmed', 'not-applied'] : manualRequired ? ['confirmed', 'not-applied', 'abandoned', 'reconciled'] : [],
    allowedOutcomes: explicitOnly ? ['confirmed', 'not-applied'] : manualRequired ? LEDGER_RESOLVE_OUTCOMES.slice() : [],
    recommendation,
    evidence: {
      staleAt: entry.staleAt || null,
      resolvedAt: entry.resolvedAt || null,
      outcome: entry.outcome || null,
      keys: Array.isArray(entry.keys) ? entry.keys.length : 0,
      hasTarget: Boolean(entry.target),
    },
  };
}

/**
 * 批量分类 pending 意图，并按 tab/method 聚合。
 * @param {object[]} entries
 * @param {{now?: number, maxEntries?: number}} options
 */
export function classifyRecoveryEntries(entries, { now = Date.now(), maxEntries = 100 } = {}) {
  const at = Number(now) || Date.now();
  const list = Array.isArray(entries) ? entries : [];
  const classified = list.slice(0, Math.max(1, Number(maxEntries) || 100)).map((entry) => classifyPendingEntry(entry, { now: at }));
  const counts = {
    total: list.length,
    manualRequired: classified.filter((item) => item.manualRequired && item.class !== 'still-active').length,
    explicitOnly: classified.filter((item) => item.explicitOnly).length,
    reconcileEligible: classified.filter((item) => item.class === 'reconcile-eligible').length,
    stillActive: classified.filter((item) => item.class === 'still-active').length,
    settled: classified.filter((item) => item.class === 'settled').length,
    replayBlocked: classified.filter((item) => item.replayBlocked).length,
    recovered: classified.filter((item) => item.recovered).length,
    listed: classified.length,
    truncated: list.length > classified.length,
  };
  const byTabMap = new Map();
  const byMethodMap = new Map();
  for (const item of classified) {
    const tabKey = item.tabId === null ? 'none' : String(item.tabId);
    let tab = byTabMap.get(tabKey);
    if (!tab) {
      tab = { tabId: item.tabId, entries: 0, manualRequired: 0, explicitOnly: 0, replayBlocked: 0, methods: new Set(), oldestAgeMs: 0 };
      byTabMap.set(tabKey, tab);
    }
    tab.entries += 1;
    if (item.manualRequired && item.class !== 'still-active') tab.manualRequired += 1;
    if (item.explicitOnly) tab.explicitOnly += 1;
    if (item.replayBlocked) tab.replayBlocked += 1;
    if (item.method) tab.methods.add(item.method);
    tab.oldestAgeMs = Math.max(tab.oldestAgeMs, item.ageMs);
    const methodKey = item.method || 'unknown';
    let method = byMethodMap.get(methodKey);
    if (!method) {
      method = { method: methodKey, entries: 0, manualRequired: 0, explicitOnly: 0 };
      byMethodMap.set(methodKey, method);
    }
    method.entries += 1;
    if (item.manualRequired && item.class !== 'still-active') method.manualRequired += 1;
    if (item.explicitOnly) method.explicitOnly += 1;
  }
  const byTab = [...byTabMap.values()]
    .map((tab) => ({ ...tab, methods: [...tab.methods].sort() }))
    .sort((a, b) => b.entries - a.entries || b.oldestAgeMs - a.oldestAgeMs);
  const byMethod = [...byMethodMap.values()].sort((a, b) => b.entries - a.entries || a.method.localeCompare(b.method));
  return { at, entries: classified, counts, byTab, byMethod };
}

function recommendFor({ counts, sessionPlan, conflicts }) {
  const recommendations = [];
  if (counts.explicitOnly > 0) {
    recommendations.push({
      code: 'resolve-explicit',
      severity: 'high',
      message: counts.explicitOnly + ' 条崩溃恢复的非幂等意图结果未知，必须人工确认 confirmed|not-applied 后才能重放',
    });
  }
  if (counts.manualRequired > counts.explicitOnly) {
    recommendations.push({
      code: 'resolve-remaining',
      severity: 'warn',
      message: (counts.manualRequired - counts.explicitOnly) + ' 条未知/过期意图仍待处理（可用批量 reconcile 或逐条 resolve）',
    });
  }
  if (counts.stillActive > 0) {
    recommendations.push({
      code: 'wait-active',
      severity: 'info',
      message: counts.stillActive + ' 条意图仍在执行中，等其结算，不要提前 resolve',
    });
  }
  if (sessionPlan && (sessionPlan.invalid > 0 || sessionPlan.duplicates > 0)) {
    recommendations.push({
      code: 'inspect-sessions-file',
      severity: 'warn',
      message: '持久化会话有 ' + (sessionPlan.invalid || 0) + ' 条损坏/缺字段、' + (sessionPlan.duplicates || 0) + ' 条重复，已跳过恢复',
    });
  }
  if (sessionPlan && sessionPlan.expired > 0) {
    recommendations.push({
      code: 'expired-sessions',
      severity: 'info',
      message: sessionPlan.expired + ' 条会话超过恢复 TTL，未恢复（属预期回收）',
    });
  }
  if (conflicts && conflicts.high > 0) {
    recommendations.push({
      code: 'lease-conflicts',
      severity: 'high',
      message: conflicts.high + ' 条高优先级租约所有权冲突，需检查 tab 归属后再操作',
    });
  }
  if (!recommendations.length) {
    recommendations.push({ code: 'clean', severity: 'info', message: '恢复状态干净：没有未决意图、没有租约冲突' });
  }
  return recommendations;
}

/**
 * 构造端到端恢复报告。
 * @param {{ledgerStatus?: object, recovery?: object|null, sessionPlan?: object|null, sessionReport?: object|null,
 *          leaseReport?: object|null, conflicts?: object[]|null, now?: number, maxEntries?: number}} input
 */
export function buildRecoveryReport({
  ledgerStatus = {},
  recovery = null,
  sessionPlan = null,
  sessionReport = null,
  leaseReport = null,
  conflicts = null,
  now = Date.now(),
  maxEntries = 100,
} = {}) {
  const at = Number(now) || Date.now();
  const pending = Array.isArray(ledgerStatus.pending) ? ledgerStatus.pending : [];
  const classified = classifyRecoveryEntries(pending, { now: at, maxEntries });
  const conflictList = Array.isArray(conflicts)
    ? conflicts
    : (Array.isArray(leaseReport && leaseReport.conflicts) ? leaseReport.conflicts : []);
  const conflictCounts = { total: conflictList.length, high: 0, warn: 0, info: 0 };
  for (const conflict of conflictList) {
    if (conflict && conflict.severity === 'high') conflictCounts.high += 1;
    else if (conflict && conflict.severity === 'warn') conflictCounts.warn += 1;
    else conflictCounts.info += 1;
  }
  const planStats = sessionPlan && sessionPlan.stats ? sessionPlan.stats : (sessionReport && sessionReport.plan ? sessionReport.plan : null);
  const summaries = {
    ledger: {
      pending: pending.length,
      unknown: pending.filter((entry) => entry && entry.state === 'unknown').length,
      stale: pending.filter((entry) => entry && entry.state === 'stale').length,
      active: pending.filter((entry) => entry && entry.state === 'active').length,
      replayBlocked: pending.filter((entry) => entry && entry.replayBlocked === true).length,
      staleMs: Number.isFinite(Number(ledgerStatus.staleMs)) ? Number(ledgerStatus.staleMs) : null,
      wal: ledgerStatus.wal || null,
      durability: ledgerStatus.durability || null,
    },
    sessions: {
      plan: planStats || null,
      recovery: recovery || null,
    },
    leases: leaseReport ? {
      totals: leaseReport.totals || null,
      orphans: Array.isArray(leaseReport.orphans) ? leaseReport.orphans.length : 0,
      reclaim: leaseReport.reclaim && leaseReport.reclaim.stats ? leaseReport.reclaim.stats : null,
      conflicts: conflictCounts,
    } : null,
  };
  const report = {
    schema: RECOVERY_REPORT_SCHEMA,
    kind: RECOVERY_REPORT_KIND,
    at,
    generatedAt: new Date(at).toISOString(),
    summary: {
      autoResolved: 0,
      manualRequired: classified.counts.manualRequired,
      explicitOnly: classified.counts.explicitOnly,
      reconcileEligible: classified.counts.reconcileEligible,
      stillActive: classified.counts.stillActive,
      replayBlocked: classified.counts.replayBlocked,
      recovered: classified.counts.recovered,
      leaseConflicts: conflictCounts,
      policy: 'never-auto-resolve',
    },
    ledger: summaries.ledger,
    sessions: summaries.sessions,
    leases: summaries.leases,
    manualResolve: {
      policy: RECOVERY_MANUAL_POLICY,
      required: classified.entries.filter((item) => item.explicitOnly),
      candidates: classified.entries.filter((item) => item.class === 'reconcile-eligible'),
      stillActive: classified.entries.filter((item) => item.class === 'still-active'),
      blocked: classified.counts.manualRequired,
    },
    tabs: classified.byTab,
    methods: classified.byMethod,
    entries: classified.entries,
    entriesTruncated: classified.counts.truncated,
    recommendations: recommendFor({ counts: classified.counts, sessionPlan: planStats, conflicts: conflictCounts }),
    invariants: [
      { code: 'never-auto-resolve', ok: true, detail: '恢复只产证据；autoResolved 恒为 0' },
      { code: 'explicit-outcome-for-non-idempotent', ok: classified.counts.explicitOnly === classified.entries.filter((item) => item.explicitOnly).length, detail: '非幂等恢复意图只接受 confirmed|not-applied' },
      { code: 'active-not-resolved', ok: true, detail: 'active 意图不进入可 resolve 列表' },
    ],
  };
  // 处置清单在报告之后计算（只读派生），所有步骤 auto=false。
  report.checklist = buildRecoveryChecklist(report);
  return report;
}

/**
 * 人工 resolve 计划（不写账本）。逐条给出 eligible/protected/active/missing 与原因。
 * @param {{status?: object, targets?: string[], outcome?: string, by?: string|null, now?: number, maxEntries?: number}} input
 */
export function planManualResolve({
  status = {},
  targets = [],
  outcome = 'confirmed',
  by = null,
  now = Date.now(),
  maxEntries = 100,
} = {}) {
  const at = Number(now) || Date.now();
  const normalized = normalizeResolveOutcome(outcome);
  if (!normalized) {
    return {
      ok: false,
      error: 'E_BAD_ARG',
      message: '未知的 resolve 结论：' + text(outcome) + '（允许：' + LEDGER_RESOLVE_OUTCOMES.join('|') + '）',
      allowedOutcomes: LEDGER_RESOLVE_OUTCOMES.slice(),
      at,
    };
  }
  const ids = (Array.isArray(targets) ? targets : [targets]).map((item) => text(item).trim()).filter(Boolean);
  if (!ids.length) {
    return { ok: false, error: 'E_BAD_ARG', message: '人工 resolve 需要至少一个账本 id', at };
  }
  const uniqueIds = [...new Set(ids)];
  const pending = Array.isArray(status.pending) ? status.pending : [];
  const index = new Map();
  for (const entry of pending) {
    const id = text(entry && entry.id);
    if (id) index.set(id, entry);
  }
  const classifiedTargets = uniqueIds.map((id) => {
    const entry = index.get(id);
    if (!entry) {
      return {
        id,
        status: 'missing',
        resolvable: false,
        reason: 'not-pending',
        message: '账本没有该 id 的 pending 记录（可能已结算或从未存在）',
      };
    }
    const classification = classifyPendingEntry(entry, { now: at });
    if (classification.state === 'active') {
      return { id, status: 'active', resolvable: false, reason: 'still-active', classification, message: '意图仍在执行中，不能 resolve' };
    }
    if (classification.explicitOnly && normalized.explicit !== true) {
      return {
        id,
        status: 'protected',
        resolvable: false,
        reason: 'explicit-outcome-required',
        classification,
        requiredOutcomes: ['confirmed', 'not-applied'],
        message: '崩溃恢复的非幂等意图（' + classification.method + '）只接受 confirmed|not-applied，收到 "' + normalized.outcome + '"',
      };
    }
    if (classification.replayBlocked && normalized.explicit !== true && classification.nonIdempotent) {
      return {
        id,
        status: 'protected',
        resolvable: false,
        reason: 'explicit-outcome-required',
        classification,
        requiredOutcomes: ['confirmed', 'not-applied'],
        message: 'replayBlocked 的非幂等意图必须显式 confirmed|not-applied',
      };
    }
    return { id, status: 'eligible', resolvable: true, reason: 'eligible', classification };
  });
  const counts = {
    requested: uniqueIds.length,
    eligible: classifiedTargets.filter((item) => item.status === 'eligible').length,
    protected: classifiedTargets.filter((item) => item.status === 'protected').length,
    active: classifiedTargets.filter((item) => item.status === 'active').length,
    missing: classifiedTargets.filter((item) => item.status === 'missing').length,
  };
  return {
    ok: true,
    at,
    generatedAt: new Date(at).toISOString(),
    outcome: normalized.outcome,
    effect: normalized.effect,
    explicit: normalized.explicit === true,
    by: by || null,
    targets: classifiedTargets,
    counts,
    policy: {
      autoResolve: false,
      explicitRequired: counts.protected > 0,
      allowResolveActive: false,
      allowResolveMissing: false,
    },
  };
}

/**
 * 执行人工 resolve 计划：只处理 eligible，protected/active/missing 永远不动。
 * @param {{ledger: object, plan: object, by?: string|null, now?: number}} input
 */
export function applyManualResolve({ ledger, plan, by = null, now = Date.now() } = {}) {
  const at = Number(now) || Date.now();
  if (!ledger || typeof ledger.resolve !== 'function') {
    return { ok: false, error: 'E_INTERNAL', message: '账本不可用', at };
  }
  if (!plan || plan.ok !== true) return { ...plan, at };
  const resolved = [];
  const failed = [];
  for (const target of plan.targets) {
    if (target.status !== 'eligible') continue;
    try {
      const entry = ledger.resolve(target.id, plan.outcome, { by: by || plan.by || 'rpc-manual' });
      resolved.push({
        id: target.id,
        ok: true,
        state: entry && entry.state ? entry.state : 'resolved',
        outcome: entry && entry.outcome ? entry.outcome : plan.outcome,
        duplicate: Boolean(entry && (entry.duplicate === true || entry.duplicateResolve === true)),
        method: target.classification ? target.classification.method : null,
        tabId: target.classification ? target.classification.tabId : null,
      });
    } catch (error) {
      failed.push({
        id: target.id,
        ok: false,
        code: (error && error.code) || 'E_INTERNAL',
        message: text(error && error.message),
      });
    }
  }
  return {
    ok: failed.length === 0,
    at,
    generatedAt: new Date(at).toISOString(),
    outcome: plan.outcome,
    by: by || plan.by || 'rpc-manual',
    resolved,
    failed,
    protected: plan.targets.filter((item) => item.status === 'protected').map((item) => ({ id: item.id, reason: item.reason, requiredOutcomes: item.requiredOutcomes })),
    active: plan.targets.filter((item) => item.status === 'active').map((item) => item.id),
    missing: plan.targets.filter((item) => item.status === 'missing').map((item) => item.id),
    counts: {
      ...plan.counts,
      resolved: resolved.length,
      failed: failed.length,
      skipped: plan.counts.requested - resolved.length - failed.length,
    },
    autoResolved: 0,
    note: '人工 resolve：只处理 eligible；protected/active/missing 保持原状（不会被自动解锁）',
  };
}

/** 单条分类的人话解释（CLI/日志）。 */
export function describeManualResolution(classification) {
  if (!classification || typeof classification !== 'object') return '未知恢复条目';
  const head = (classification.id || '(无 id)') + '（' + (classification.method || '未知方法') + '）';
  if (classification.class === 'still-active') return head + '：仍在执行，等待结算';
  if (classification.explicitOnly) {
    return head + '：崩溃恢复的非幂等意图，结果未知；需人工确认 confirmed 或 not-applied';
  }
  if (classification.manualRequired) {
    return head + '：状态 ' + (classification.state || 'unknown') + '（' + round1(classification.ageMs / 1000) + 's），可 resolve 或批量 reconcile';
  }
  return head + '：无需处理';
}

/**
 * 恢复处置清单（有序、可审计）：把恢复报告转成"人应该按什么顺序做什么"。
 * 关键语义：每一项 auto=false —— 崩溃恢复**没有**自动执行的步骤；清单只是排序建议。
 * @param {object} report buildRecoveryReport() 的结果
 */
export function buildRecoveryChecklist(report) {
  if (!report || typeof report !== 'object') {
    return {
      at: Date.now(),
      items: [],
      counts: { manual: 0, reconcile: 0, wait: 0, inspect: 0 },
      canAutoResolve: false,
      note: '没有恢复报告',
    };
  }
  const at = Number(report.at) || Date.now();
  const items = [];
  const push = (item) => items.push({ auto: false, ...item });
  const required = report.manualResolve && Array.isArray(report.manualResolve.required) ? report.manualResolve.required : [];
  for (const entry of required) {
    push({
      step: 'resolve-manual',
      order: 10,
      severity: 'high',
      id: entry.id,
      method: entry.method,
      tabId: entry.tabId,
      requiredOutcomes: entry.requiredOutcomes || ['confirmed', 'not-applied'],
      action: '人工确认页面状态后 resolve confirmed 或 not-applied（不得用 abandoned/reconciled 解锁）',
    });
  }
  const candidates = report.manualResolve && Array.isArray(report.manualResolve.candidates) ? report.manualResolve.candidates : [];
  for (const entry of candidates) {
    push({
      step: 'reconcile-or-resolve',
      order: 20,
      severity: 'warn',
      id: entry.id,
      method: entry.method,
      tabId: entry.tabId,
      action: '非恢复的非幂等未知意图：可逐条 resolve 或按 tab reconcile',
    });
  }
  const stillActive = report.manualResolve && Array.isArray(report.manualResolve.stillActive) ? report.manualResolve.stillActive : [];
  for (const entry of stillActive) {
    push({
      step: 'wait-active',
      order: 30,
      severity: 'info',
      id: entry.id,
      method: entry.method,
      tabId: entry.tabId,
      action: '仍在执行，等其结算；不要提前 resolve',
    });
  }
  const plan = report.sessions && report.sessions.plan ? report.sessions.plan : null;
  if (plan && (plan.invalid > 0 || plan.duplicates > 0)) {
    push({
      step: 'inspect-sessions-file',
      order: 40,
      severity: 'warn',
      invalid: plan.invalid || 0,
      duplicates: plan.duplicates || 0,
      action: '检查 sessions.json：坏行/重复行已被跳过，确认是否有重要会话丢失',
    });
  }
  const conflicts = report.summary && report.summary.leaseConflicts ? report.summary.leaseConflicts : { high: 0 };
  if (conflicts.high > 0) {
    push({
      step: 'inspect-lease-conflicts',
      order: 50,
      severity: 'high',
      highConflicts: conflicts.high,
      action: '处理高优先级租约所有权冲突（status views=leases）后再派发命令',
    });
  }
  if (!items.length) {
    push({ step: 'clean', order: 99, severity: 'info', action: '恢复状态干净，无需人工动作' });
  }
  items.sort((a, b) => a.order - b.order);
  return {
    at,
    generatedAt: new Date(at).toISOString(),
    items,
    counts: {
      manual: required.length,
      reconcile: candidates.length,
      wait: stillActive.length,
      inspect: items.filter((item) => item.step === 'inspect-sessions-file' || item.step === 'inspect-lease-conflicts').length,
    },
    canAutoResolve: false,
    note: '清单只给排序建议，所有步骤均需显式执行；daemon 不会自动 resolve/回收',
  };
}

/** 恢复报告的轻量摘要（status.recovery 附加字段用）。 */
export function summarizeRecoveryReport(report) {  if (!report || typeof report !== 'object') return null;
  return {
    at: report.at,
    generatedAt: report.generatedAt,
    autoResolved: report.summary ? report.summary.autoResolved : 0,
    manualRequired: report.summary ? report.summary.manualRequired : 0,
    explicitOnly: report.summary ? report.summary.explicitOnly : 0,
    stillActive: report.summary ? report.summary.stillActive : 0,
    replayBlocked: report.summary ? report.summary.replayBlocked : 0,
    leaseConflicts: report.summary ? report.summary.leaseConflicts : { total: 0, high: 0, warn: 0, info: 0 },
    recommendations: Array.isArray(report.recommendations) ? report.recommendations.length : 0,
    manualResolve: report.manualResolve ? {
      required: report.manualResolve.required.length,
      candidates: report.manualResolve.candidates.length,
      stillActive: report.manualResolve.stillActive.length,
      policy: report.manualResolve.policy,
    } : null,
  };
}

/**
 * daemon 侧恢复报告器：把账本状态、会话恢复计划、租约报告合成可查询的报告，
 * 并暴露"计划/执行"两段式的人工 resolve。
 *
 * @param {{ledger: object, recovery?: object|null, recoverySnapshot?: Function|null,
 *          leaseOps?: object|null, sessions?: Map<string, object>, now?: Function,
 *          log?: Function, maxEntries?: number}} options
 */
export function createRecoveryReporter({
  ledger,
  recovery = null,
  recoverySnapshot = null,
  leaseOps = null,
  sessions = new Map(),
  now = () => Date.now(),
  log = () => {},
  maxEntries = 100,
} = {}) {
  if (!ledger || typeof ledger.status !== 'function') throw new TypeError('createRecoveryReporter 需要 intent ledger');
  const max = Number.isInteger(Number(maxEntries)) && Number(maxEntries) > 0 ? Number(maxEntries) : 100;
  let lastReport = null;
  let lastManual = null;
  let planCache = null;

  function clock() {
    return typeof now === 'function' ? Number(now()) || Date.now() : Date.now();
  }

  function collectLedgerStatus({ limit = Math.max(20, max) } = {}) {
    try {
      return ledger.status({ limit });
    } catch (error) {
      log('恢复报告：读取账本状态失败（降级）：' + text(error && error.message));
      return { pending: [], recent: [], staleMs: null, wal: null, durability: null, recovery: null };
    }
  }

  function sessionPlanSnapshot() {
    if (typeof recoverySnapshot === 'function') {
      try {
        const snapshot = recoverySnapshot();
        if (snapshot && snapshot.sessions && snapshot.sessions.plan) return snapshot.sessions.plan;
      } catch { /* 忽略 */ }
    }
    if (recovery && typeof recovery === 'object' && recovery.sessions && recovery.sessions.plan) return recovery.sessions.plan;
    return null;
  }

  function leaseReportSnapshot({ limit = 20 } = {}) {
    if (!leaseOps || typeof leaseOps.report !== 'function') return null;
    try {
      return leaseOps.report({ limit, includeEvidence: false });
    } catch (error) {
      log('恢复报告：读取租约报告失败（降级）：' + text(error && error.message));
      return null;
    }
  }

  function report({ limit = 20, status = null } = {}) {
    const at = clock();
    const ledgerStatus = status || collectLedgerStatus();
    const sessionPlan = sessionPlanSnapshot();
    const leaseReport = leaseReportSnapshot({ limit });
    lastReport = buildRecoveryReport({
      ledgerStatus,
      recovery: recovery && typeof recovery === 'object' ? (recovery.summary ? recovery.summary() : null) : null,
      sessionPlan,
      sessionReport: recovery && typeof recovery === 'object' && typeof recovery.snapshot === 'function'
        ? (() => { try { return recovery.snapshot(); } catch { return null; } })()
        : null,
      leaseReport,
      conflicts: leaseReport ? leaseReport.conflicts : null,
      now: at,
      maxEntries: max,
    });
    return lastReport;
  }

  function plan(params = {}) {
    const status = params.status || collectLedgerStatus();
    planCache = planManualResolve({
      status,
      targets: params.ids || params.targets || [],
      outcome: params.outcome,
      by: params.by || null,
      now: clock(),
      maxEntries: max,
    });
    return planCache;
  }

  /**
   * 人工 resolve（崩溃恢复语义）：
   * - dryRun=true 只返回计划；
   * - 否则执行计划里 eligible 的条目，protected 保持阻断；
   * - 结果带 autoResolved=0 证据。
   */
  function manualResolve(params = {}) {
    const dryRun = params.dryRun === true;
    const planned = params.plan || plan(params);
    if (planned.ok !== true) return planned;
    if (dryRun) return { ...planned, dryRun: true };
    const applied = applyManualResolve({
      ledger,
      plan: planned,
      by: params.by || 'rpc-manual',
      now: clock(),
    });
    lastManual = { ...applied, dryRun: false };
    if (applied.resolved.length) {
      log('人工 resolve：' + applied.resolved.length + ' 条已结算（protected ' + applied.protected.length + ' 条仍阻断）');
    }
    return lastManual;
  }

  function summary() {
    const status = collectLedgerStatus({ limit: 1 });
    const pending = Array.isArray(status.pending) ? status.pending : [];
    const classified = classifyRecoveryEntries(pending, { now: clock(), maxEntries: max });
    return {
      at: new Date(clock()).toISOString(),
      pending: pending.length,
      manualRequired: classified.counts.manualRequired,
      explicitOnly: classified.counts.explicitOnly,
      stillActive: classified.counts.stillActive,
      replayBlocked: classified.counts.replayBlocked,
      policy: RECOVERY_MANUAL_POLICY,
      lastManual: lastManual ? {
        at: lastManual.at,
        outcome: lastManual.outcome,
        resolved: lastManual.resolved ? lastManual.resolved.length : 0,
        failed: lastManual.failed ? lastManual.failed.length : 0,
        protected: lastManual.protected ? lastManual.protected.length : 0,
      } : null,
      hasReport: Boolean(lastReport),
    };
  }

  return {
    get lastReport() { return lastReport; },
    get lastManual() { return lastManual; },
    collectLedgerStatus,
    report,
    plan,
    manualResolve,
    summary,
    reset() {
      lastReport = null;
      lastManual = null;
      planCache = null;
      return summary();
    },
  };
}
