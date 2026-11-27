// daemon/session-recovery.js —— 启动恢复：持久化会话计划、账本 reconcile、租约重建。
//
// 职责边界：
// - 纯函数 planPersistedSessionRecovery()：把 sessions.json 的原始行分类为
//   restore / expired / invalid，并给出原因证据（坏行不再静默丢弃）；
// - recoverLedgerOnStartup()：调用 intent-ledger 的 recover()，把上次进程遗留的
//   pending 账本升级为 unknown（非幂等动作 replayBlocked），并汇总给日志/status；
// - createSessionRecovery()：把上面的恢复结果 + 生命周期状态机 + tab 租约整理成
//   一份可查询的 recovery 快照，挂在 daemon status/health 上，回答“重启后恢复了什么、
//   哪些会话过期、哪些 tab 租约被重建、哪些意图仍未知”。
//
// 本模块不直接读写文件：调用方（daemon/server.mjs）负责读 sessions.json 并创建会话记录。
//
// 第十批 F 增补（只加不改）：
// - 恢复报告与人工 resolve 语义由 daemon/recovery-report.js 提供，本模块统一再导出，
//   调用方（daemon/CLI 诊断/单测）只需要 import 这一处；
// - createSessionRecovery 增加 recordLeaseReconcile()/recordRecoveryReport()/recoveryReport()，
//   把启动时的租约对账与恢复报告摘要挂到 status.recovery（新增字段，默认载荷其余字段不变）；
// - snapshot() 新增 leaseReconcile / report 两个只读子树，回答"重启后租约如何对账、还有多少
//   条未知意图必须人工确认"。

import { summarizeRecoveryReport } from './recovery-report.js';

export {
  RECOVERY_ENTRY_CLASSES,
  RECOVERY_MANUAL_POLICY,
  RECOVERY_REPORT_KIND,
  RECOVERY_REPORT_SCHEMA,
  applyManualResolve,
  buildRecoveryChecklist,
  buildRecoveryReport,
  classifyPendingEntry,
  classifyRecoveryEntries,
  createRecoveryReporter,
  describeManualResolution,
  isExplicitRecoveryOutcome,
  normalizeRecoveryOutcome,
  planManualResolve,
  summarizeRecoveryReport,
} from './recovery-report.js';

export const SESSION_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;

function toInt(value) {
  return Number.isInteger(value) ? value : null;
}

function describeRow(row) {
  if (!row || typeof row !== 'object') return { sessionId: null, tabId: null, startedAt: 0 };
  return {
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    tabId: toInt(row.tabId),
    startedAt: Number(row.startedAt) || 0,
  };
}

/**
 * 把持久化会话行分类。
 * @param {Array<object>} rows sessions.json 的 sessions 数组（可能被截断/手改）
 * @param {{now?: number, ttlMs?: number}} options
 * @returns {{restore: object[], expired: object[], invalid: object[], duplicates: object[], stats: object}}
 */
export function planPersistedSessionRecovery(rows, { now = Date.now(), ttlMs = SESSION_RECOVERY_TTL_MS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const restore = [];
  const expired = [];
  const invalid = [];
  const duplicates = [];
  const seen = new Set();
  const limit = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : SESSION_RECOVERY_TTL_MS;
  for (let index = 0; index < list.length; index += 1) {
    const row = list[index];
    const summary = describeRow(row);
    if (!summary.sessionId) {
      invalid.push({ index, reason: 'missing-session-id', row: row === undefined ? null : row });
      continue;
    }
    if (summary.tabId === null) {
      invalid.push({ index, reason: 'bad-tab-id', sessionId: summary.sessionId, tabId: row && row.tabId });
      continue;
    }
    if (seen.has(summary.sessionId)) {
      duplicates.push({ index, reason: 'duplicate-session-id', sessionId: summary.sessionId });
      continue;
    }
    seen.add(summary.sessionId);
    if (!summary.startedAt) {
      invalid.push({ index, reason: 'missing-startedAt', sessionId: summary.sessionId });
      continue;
    }
    const ageMs = Math.max(0, now - summary.startedAt);
    if (ageMs >= limit) {
      expired.push({ index, sessionId: summary.sessionId, tabId: summary.tabId, startedAt: summary.startedAt, ageMs, ttlMs: limit, reason: 'ttl-expired' });
      continue;
    }
    restore.push({
      index,
      sessionId: summary.sessionId,
      tabId: summary.tabId,
      startedAt: summary.startedAt,
      ageMs,
      restored: true,
      record: row,
    });
  }
  return {
    restore,
    expired,
    invalid,
    duplicates,
    stats: {
      total: list.length,
      restore: restore.length,
      expired: expired.length,
      invalid: invalid.length,
      duplicates: duplicates.length,
      ttlMs: limit,
      at: now,
    },
  };
}

/**
 * 启动时账本恢复。任何异常都降级为 {error}，不能让 daemon 起不来。
 * @param {import('../lib/intent-ledger.mjs').IntentLedger} ledger
 */
export function recoverLedgerOnStartup(ledger, { legacyState = 'unknown', reason = 'daemon-restart' } = {}) {
  if (!ledger || typeof ledger.recover !== 'function') {
    return { ok: false, error: 'ledger-unavailable', recovered: 0, unknown: 0, replayBlocked: 0, at: new Date().toISOString() };
  }
  try {
    const summary = ledger.recover({ legacyState, reason });
    return {
      ok: true,
      at: summary.at,
      reason: summary.reason,
      recovered: summary.recovered || 0,
      unknown: summary.unknown || 0,
      stale: summary.stale || 0,
      replayBlocked: summary.replayBlocked || 0,
      entries: summary.entries || [],
      wal: summary.wal || null,
      durability: summary.durability || null,
    };
  } catch (error) {
    return {
      ok: false,
      error: (error && error.code) || 'E_LEDGER_RECOVER',
      message: String((error && error.message) || error),
      recovered: 0,
      unknown: 0,
      replayBlocked: 0,
      at: new Date().toISOString(),
    };
  }
}

/**
 * 恢复结果聚合视图。
 * @param {{sessions: Map<string, object>, sessionState: ReturnType<typeof import('../lib/session-state.mjs').createSessionState>, sessionLeases?: object, ledger?: object, log?: Function, now?: () => number}} ctx
 */
export function createSessionRecovery({ sessions, sessionState, sessionLeases = null, ledger = null, log = () => {}, now = () => Date.now() }) {
  const startedAt = now();
  let ledgerSummary = null;
  let sessionPlan = null;
  let leaseReconcilePlan = null;
  let recoveryReportSummary = null;
  let recoveryReportAt = 0;

  function recordLedger(summary) {
    ledgerSummary = summary || null;
    if (!summary) return ledgerSummary;
    if (summary.ok === false) {
      log('账本恢复降级：' + (summary.message || summary.error));
    } else if (summary.recovered > 0) {
      log(
        '账本恢复：' + summary.recovered + ' 条 pending → unknown（replayBlocked ' + summary.replayBlocked + '）',
      );
    }
    return ledgerSummary;
  }

  function recordSessionPlan(plan) {
    sessionPlan = plan || null;
    if (plan && plan.expired.length) log('恢复会话：' + plan.expired.length + ' 条已过期，未恢复');
    if (plan && plan.invalid.length) log('恢复会话：' + plan.invalid.length + ' 条损坏/缺字段，未恢复');
    if (plan && plan.duplicates.length) log('恢复会话：' + plan.duplicates.length + ' 条重复 sessionId，已忽略');
    return sessionPlan;
  }

  /**
   * 用持久化行重建 tab 租约：最老的会话成为 holder，其余 join（共享 tab 的原有语义）。
   * 返回每个 tab 的租约状态；不抛错（租约冲突只记日志）。
   */
  function rebuildLeases(plan) {
    if (!sessionLeases || !plan) return [];
    const rows = [...plan.restore].sort((a, b) => a.startedAt - b.startedAt);
    const acquired = [];
    for (const row of rows) {
      try {
        const holders = acquired.filter((item) => item.tabId === row.tabId);
        let result;
        if (holders.length) result = sessionLeases.join(row.tabId, row.sessionId, { reason: 'daemon-restore' });
        else result = sessionLeases.acquire(row.tabId, row.sessionId, { reason: 'daemon-restore' });
        if (result && result.ok === false) {
          log('恢复租约失败：tab ' + row.tabId + ' ' + (result.conflict ? JSON.stringify(result.conflict.history || []) : result.code));
          continue;
        }
        acquired.push({ tabId: row.tabId, sessionId: row.sessionId, holder: result.lease ? result.lease.holder : null });
      } catch (error) {
        log('恢复租约异常：tab ' + row.tabId + ' ' + ((error && error.message) || error));
      }
    }
    return acquired;
  }

  /** 会话步骤：markSessionRestored + 状态机 recover + 租约重建。 */
  function applySessionPlan(plan) {
    if (!plan) return { sessions: 0, leases: [] };
    for (const row of plan.restore) {
      try { sessionState.recover(row.sessionId); } catch (error) {
        log('会话 ' + row.sessionId + ' 恢复状态失败（忽略）：' + ((error && error.message) || error));
      }
    }
    return { sessions: plan.restore.length, leases: rebuildLeases(plan) };
  }

  /**
   * 记录启动租约对账计划（daemon 启动时由 lease-ops.reconcile() 产出）。
   * 只保存证据；不在这里应用/释放任何租约。
   */
  function recordLeaseReconcile(plan) {
    leaseReconcilePlan = plan || null;
    if (plan && plan.stats) {
      if (plan.stats.adopt > 0) log('租约对账：' + plan.stats.adopt + ' 个会话需要补登租约（未自动抢 holder）');
      if (plan.stats.releaseOrphans > 0) log('租约对账：' + plan.stats.releaseOrphans + ' 个 tab 存在可回收的残租');
      if (plan.stats.conflicts > 0) log('租约对账：' + plan.stats.conflicts + ' 条所有权冲突');
    }
    return leaseReconcilePlan;
  }

  /**
   * 记录恢复报告摘要（daemon/recovery-report.js 的 buildRecoveryReport 结果）。
   * 只保存摘要，避免 status 每次请求都重算整份报告。
   */
  function recordRecoveryReport(report) {
    recoveryReportSummary = report ? summarizeRecoveryReport(report) : null;
    recoveryReportAt = now();
    return recoveryReportSummary;
  }

  /** 启动恢复的完整证据（租约对账计划 + 报告摘要），供 status/CLI 诊断读取。 */
  function recoveryReport() {
    return {
      at: recoveryReportAt || now(),
      ledger: ledgerSummary,
      sessionPlan: sessionPlan ? sessionPlan.stats : null,
      leaseReconcile: leaseReconcilePlan ? {
        at: leaseReconcilePlan.at,
        stats: leaseReconcilePlan.stats,
        adopt: leaseReconcilePlan.adopt || [],
        releaseOrphans: leaseReconcilePlan.releaseOrphans || [],
        conflicts: leaseReconcilePlan.conflicts || [],
      } : null,
      report: recoveryReportSummary,
    };
  }

  function snapshot() {
    const active = typeof sessionState.list === 'function' ? sessionState.list() : [];
    return {
      at: now(),
      startedAt,
      uptimeMs: now() - startedAt,
      sessions: {
        live: typeof sessions === 'object' && sessions && typeof sessions.size === 'number' ? sessions.size : active.length,
        plan: sessionPlan ? sessionPlan.stats : null,
        phases: active.map((item) => ({ sessionId: item.sessionId, phase: item.phase, canonical: item.canonical })),
      },
      ledger: ledgerSummary,
      leases: sessionLeases ? sessionLeases.snapshot() : [],
      // 第十批 F 增补：只读证据子树（默认 status 其余字段不变）。
      leaseReconcile: leaseReconcilePlan ? {
        at: leaseReconcilePlan.at,
        stats: leaseReconcilePlan.stats,
        adopt: (leaseReconcilePlan.adopt || []).slice(0, 20),
        releaseOrphans: (leaseReconcilePlan.releaseOrphans || []).slice(0, 20),
      } : null,
      report: recoveryReportSummary,
    };
  }

  return {
    recordLedger,
    recordSessionPlan,
    recordLeaseReconcile,
    recordRecoveryReport,
    recoveryReport,
    applySessionPlan,
    rebuildLeases,
    snapshot,
  };
}
