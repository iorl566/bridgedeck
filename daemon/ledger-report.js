// daemon/ledger-report.js —— 会话账本（intent ledger）的快照 / 恢复对账 / 批量 reconcile 报告。
//
// 0.3.0 的账本本体（lib/intent-ledger.mjs，C 路所有）已经负责：
// WAL + snapshot 持久化、recover() 把上次进程遗留的 pending 升级为 unknown、
// 非幂等动作 UNKNOWN 后禁止自动重放（must resolve confirmed|not-applied）。
//
// 本模块只做 daemon 侧的"可读证据层"，不改账本语义：
//   1) snapshot()：把 ledger.status()/stats() 整理成带 schema/摘要/按 tab 索引的结构，
//      供 `bridge daemon ledger snapshot`、doctor、排障归档使用；
//   2) persistSnapshot()/readPersistedSnapshot()：daemon 自己的对账快照
//      （BB_HOME/ledger-snapshot.json，原子写 + fsync），重启后用来回答
//      "上次停止时哪些意图还是 unknown、这次恢复后有没有漂移"；
//   3) restore()：读取对账快照并与当前账本比较，输出 drift 报告；
//      **绝不自动 resolve**——恢复后的未知意图仍保持 replayBlocked；
//   4) reconcile()：按 tab（或全部）批量和解，返回结构化报告：
//      candidates / eligible / protected（recovered 非幂等需显式结论）/ active / resolved / skipped。
//
// 错误码复用已登记清单：快照读写/校验失败统一 E_LEDGER_IO（data.reason 区分
// missing/invalid-json/digest-mismatch/write-failed/no-path），不新增错误码。
//
// 与 lib 的分工边界：本模块不写 WAL、不改 entries；唯一的写操作是 daemon 自己的
// 对账快照文件（不是账本本体），以及调用 ledger.reconcile()（语义由 lib 定义）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isExplicitResolveOutcome, isNonIdempotentAction, normalizeResolveOutcome } from '../lib/intent-ledger.mjs';

export const LEDGER_SNAPSHOT_SCHEMA = 1;
export const LEDGER_SNAPSHOT_KIND = 'bridge/ledger-snapshot';
export const DEFAULT_SNAPSHOT_MAX_PENDING = 100;
export const SNAPSHOT_FILE_NAME = 'ledger-snapshot.json';

function iso(ms) {
  return new Date(ms).toISOString();
}

/** 稳定序列化：键排序后 JSON.stringify，保证 digest 可复现。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

export function ledgerSnapshotDigest(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const core = {
    schema: snapshot.schema,
    kind: snapshot.kind,
    at: snapshot.at,
    counts: snapshot.counts,
    tabs: snapshot.tabs,
    pending: snapshot.pending,
  };
  return crypto.createHash('sha256').update(canonicalJson(core)).digest('hex').slice(0, 16);
}

function entrySummary(entry, { now = Date.now() } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const at = Number.isFinite(Date.parse(entry.at)) ? Date.parse(entry.at) : 0;
  return {
    id: typeof entry.id === 'string' ? entry.id : null,
    method: typeof entry.method === 'string' ? entry.method : null,
    state: typeof entry.state === 'string' ? entry.state : null,
    tabId: Number.isInteger(entry.tabId) ? entry.tabId : null,
    sessionId: entry.sessionId == null ? null : String(entry.sessionId),
    at: typeof entry.at === 'string' ? entry.at : null,
    ageMs: at > 0 ? Math.max(0, Number(now) - at) : 0,
    recovered: entry.recovered === true,
    nonIdempotent: entry.nonIdempotent === true || isNonIdempotentAction(entry.method),
    replayBlocked: entry.replayBlocked === true,
    staleAt: entry.staleAt || null,
    resolvedAt: entry.resolvedAt || null,
    outcome: entry.outcome || null,
  };
}

/** 按 tab 聚合 pending：每个 tab 的 unknown/stale/active 数量、涉及方法与阻断计数。 */
export function indexLedgerTabs(pending, { now = Date.now() } = {}) {
  const table = new Map();
  for (const entry of Array.isArray(pending) ? pending : []) {
    const summary = entrySummary(entry, { now });
    if (!summary) continue;
    const key = summary.tabId == null ? 'none' : String(summary.tabId);
    let row = table.get(key);
    if (!row) {
      row = {
        tabId: summary.tabId,
        pending: 0,
        unknown: 0,
        stale: 0,
        active: 0,
        replayBlocked: 0,
        recovered: 0,
        sessions: new Set(),
        methods: new Set(),
        oldestAgeMs: 0,
        entries: [],
      };
      table.set(key, row);
    }
    row.pending += 1;
    if (summary.state === 'unknown') row.unknown += 1;
    else if (summary.state === 'stale') row.stale += 1;
    else if (summary.state === 'active') row.active += 1;
    if (summary.replayBlocked) row.replayBlocked += 1;
    if (summary.recovered) row.recovered += 1;
    if (summary.sessionId) row.sessions.add(summary.sessionId);
    if (summary.method) row.methods.add(summary.method);
    row.oldestAgeMs = Math.max(row.oldestAgeMs, summary.ageMs);
    row.entries.push(summary);
  }
  return [...table.values()]
    .map((row) => ({
      tabId: row.tabId,
      pending: row.pending,
      unknown: row.unknown,
      stale: row.stale,
      active: row.active,
      replayBlocked: row.replayBlocked,
      recovered: row.recovered,
      sessions: [...row.sessions].sort(),
      methods: [...row.methods].sort(),
      oldestAgeMs: row.oldestAgeMs,
      entries: row.entries.sort((a, b) => b.ageMs - a.ageMs),
    }))
    .sort((a, b) => b.pending - a.pending || b.oldestAgeMs - a.oldestAgeMs);
}

function countStates(entries) {
  const counts = { total: 0, active: 0, stale: 0, unknown: 0, resolved: 0, done: 0, failed: 0, replayBlocked: 0, recovered: 0 };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    counts.total += 1;
    const state = String(entry.state || '');
    if (Object.prototype.hasOwnProperty.call(counts, state)) counts[state] += 1;
    if (entry.replayBlocked === true) counts.replayBlocked += 1;
    if (entry.recovered === true) counts.recovered += 1;
  }
  return counts;
}

/**
 * 构造账本快照。输入直接用 ledger.status()/stats() 的结果，避免二次遍历账本。
 * @param {{status?: object, stats?: object, recovery?: object, now?: number, maxPending?: number}} input
 */
export function buildLedgerSnapshot({ status = {}, stats = {}, recovery = null, now = Date.now(), maxPending = DEFAULT_SNAPSHOT_MAX_PENDING } = {}) {
  const pendingRaw = Array.isArray(status.pending) ? status.pending : [];
  const recentRaw = Array.isArray(status.recent) ? status.recent : [];
  const max = Number.isInteger(maxPending) && maxPending > 0 ? maxPending : DEFAULT_SNAPSHOT_MAX_PENDING;
  const pending = pendingRaw.slice(0, max).map((entry) => entrySummary(entry, { now })).filter(Boolean);
  const tabs = indexLedgerTabs(pendingRaw, { now });
  const counts = {
    ...countStates(Array.isArray(stats.entriesAll) ? stats.entriesAll : []),
    pending: pendingRaw.length,
    pendingUnknown: pendingRaw.filter((entry) => entry && entry.state === 'unknown').length,
    pendingStale: pendingRaw.filter((entry) => entry && entry.state === 'stale').length,
    pendingActive: pendingRaw.filter((entry) => entry && entry.state === 'active').length,
    replayBlocked: pendingRaw.filter((entry) => entry && entry.replayBlocked === true).length,
    tabs: tabs.length,
  };
  if (!counts.total) counts.total = pendingRaw.length;
  const snapshot = {
    schema: LEDGER_SNAPSHOT_SCHEMA,
    kind: LEDGER_SNAPSHOT_KIND,
    at: iso(now),
    generatedAtMs: now,
    staleMs: Number.isFinite(Number(status.staleMs)) ? Number(status.staleMs) : null,
    counts,
    tabs,
    pending,
    pendingTruncated: pendingRaw.length > max,
    pendingTruncatedCount: Math.max(0, pendingRaw.length - max),
    recent: recentRaw.slice(0, Math.min(20, max)).map((entry) => entrySummary(entry, { now })).filter(Boolean),
    wal: status.wal && typeof status.wal === 'object' ? { ...status.wal } : (stats.wal || null),
    durability: status.durability && typeof status.durability === 'object' ? { ...status.durability } : (stats.durability || null),
    recovery: recovery || status.recovery || null,
  };
  snapshot.digest = ledgerSnapshotDigest(snapshot);
  return snapshot;
}

/** 结构校验：CLI 读本地快照文件、daemon 启动恢复共用。 */
export function validateLedgerSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, errors: ['snapshot 不是对象'], digestOk: false };
  }
  if (snapshot.schema !== LEDGER_SNAPSHOT_SCHEMA) errors.push('schema 不是 ' + LEDGER_SNAPSHOT_SCHEMA);
  if (snapshot.kind !== LEDGER_SNAPSHOT_KIND) errors.push('kind 不是 ' + LEDGER_SNAPSHOT_KIND);
  if (typeof snapshot.at !== 'string' || !Number.isFinite(Date.parse(snapshot.at))) errors.push('at 不是 ISO 时间');
  if (!snapshot.counts || typeof snapshot.counts !== 'object') errors.push('counts 缺失');
  if (!Array.isArray(snapshot.pending)) errors.push('pending 不是数组');
  if (!Array.isArray(snapshot.tabs)) errors.push('tabs 不是数组');
  const expected = ledgerSnapshotDigest(snapshot);
  const digestOk = Boolean(snapshot.digest && expected && snapshot.digest === expected);
  if (!digestOk) errors.push('digest 不一致（快照被改写或损坏）');
  return { ok: errors.length === 0, errors, digestOk, expectedDigest: expected };
}

function pendingIndex(snapshot) {
  const map = new Map();
  for (const entry of Array.isArray(snapshot && snapshot.pending) ? snapshot.pending : []) {
    if (entry && typeof entry.id === 'string') map.set(entry.id, entry);
  }
  return map;
}

/**
 * 快照对账：比较"上次快照里的 pending"与"当前账本的 pending"。
 * 语义要点：becameUnknown（快照时未知、现在仍未知）不会被"恢复"成 resolved；
 * 恢复只能靠显式 resolve，这里只产证据。
 */
export function compareLedgerSnapshots(previous, current) {
  const before = pendingIndex(previous);
  const after = pendingIndex(current);
  const resolvedSince = [];
  const stillBlocked = [];
  const becameUnknown = [];
  for (const [id, entry] of before) {
    if (!after.has(id)) {
      resolvedSince.push({ id, tabId: entry.tabId, method: entry.method, state: entry.state });
      continue;
    }
    const now = after.get(id);
    if (now.state === 'unknown' || now.state === 'stale' || now.replayBlocked === true) {
      stillBlocked.push({ id, tabId: now.tabId, method: now.method, state: now.state, recovered: now.recovered === true });
    }
  }
  for (const [id, entry] of after) {
    if (!before.has(id)) {
      // 快照之后新出现的未知意图（重启期间/新故障）：必须继续阻断。
      becameUnknown.push({ id, tabId: entry.tabId, method: entry.method, state: entry.state });
    }
  }
  const drift = resolvedSince.length > 0 || becameUnknown.length > 0;
  return {
    ok: true,
    drift,
    stable: !drift,
    resolvedSince,
    becameUnknown,
    stillBlocked,
    counts: {
      previousPending: before.size,
      currentPending: after.size,
      resolvedSince: resolvedSince.length,
      stillBlocked: stillBlocked.length,
      becameUnknown: becameUnknown.length,
    },
  };
}

/**
 * 批量和解计划：把某 tab（或全部）的 pending 分成 eligible / protected / active。
 * @param {{status: object, tabId?: number|null, outcome?: string, now?: number}} input
 */
export function planLedgerReconcile({ status = {}, tabId = null, outcome = 'reconciled', now = Date.now() } = {}) {
  const normalized = normalizeResolveOutcome(outcome);
  const explicit = Boolean(normalized && normalized.explicit);
  const pending = Array.isArray(status.pending) ? status.pending : [];
  const scoped = tabId === null || tabId === undefined
    ? pending
    : pending.filter((entry) => entry && entry.tabId === Number(tabId));
  const eligible = [];
  const protectedEntries = [];
  const active = [];
  for (const entry of scoped) {
    const summary = entrySummary(entry, { now });
    if (!summary) continue;
    if (summary.state === 'active') {
      active.push({ ...summary, reason: 'still-active' });
      continue;
    }
    // 崩溃恢复的非幂等动作：只有显式 confirmed|not-applied 才能解锁（与 lib 语义一致）。
    if (summary.recovered === true && summary.nonIdempotent === true && !explicit) {
      protectedEntries.push({ ...summary, reason: 'explicit-outcome-required' });
      continue;
    }
    eligible.push(summary);
  }
  const tabIds = tabId === null || tabId === undefined
    ? [...new Set(scoped.filter((entry) => entry && Number.isInteger(entry.tabId)).map((entry) => entry.tabId))].sort((a, b) => a - b)
    : [Number(tabId)];
  return {
    at: iso(now),
    tabId: tabId === null || tabId === undefined ? null : Number(tabId),
    tabIds,
    outcome: normalized ? normalized.outcome : String(outcome || 'reconciled'),
    explicit,
    candidates: scoped.length,
    eligible,
    protected: protectedEntries,
    active,
    skipped: protectedEntries.length + active.length,
  };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = JSON.stringify(value, null, 2);
  const temp = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(temp, 'w');
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* 某些文件系统不支持，忽略 */ }
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
  }
  try {
    fs.renameSync(temp, filePath);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
  return { path: filePath, bytes: Buffer.byteLength(text), at: new Date().toISOString() };
}

/**
 * daemon 侧账本报告器。
 * @param {{ledger: object, dir?: string|null, recovery?: object|null, log?: Function, now?: Function,
 *          maxPending?: number, snapshotPath?: string|null}} options
 */
export function createLedgerReport({
  ledger,
  dir = null,
  recovery = null,
  log = () => {},
  now = () => Date.now(),
  maxPending = DEFAULT_SNAPSHOT_MAX_PENDING,
  snapshotPath = null,
} = {}) {
  if (!ledger || typeof ledger.status !== 'function') throw new Error('createLedgerReport 需要 intent ledger');
  const filePath = snapshotPath || (dir ? path.join(dir, SNAPSHOT_FILE_NAME) : null);
  let lastPersisted = null;
  let restoreEvidence = null;

  function readStatus({ limit = 20 } = {}) {
    const status = ledger.status({ limit });
    let stats = {};
    try { stats = typeof ledger.stats === 'function' ? ledger.stats() : {}; } catch { stats = {}; }
    return { status, stats };
  }

  function snapshot({ status = null, stats = null, maxPending: max = maxPending } = {}) {
    const base = status ? { status, stats: stats || {} } : readStatus({ limit: max });
    return buildLedgerSnapshot({ ...base, recovery, now: now(), maxPending: max });
  }

  function persistSnapshot({ status = null, maxPending: max = maxPending } = {}) {
    if (!filePath) {
      return { ok: false, error: 'E_LEDGER_IO', reason: 'no-path', message: '未配置对账快照路径' };
    }
    try {
      const value = snapshot({ status, maxPending: max });
      const written = atomicWriteJson(filePath, value);
      // 新快照写入后旧的恢复证据失效：下次 summary()/doctor 重新做一次对账。
      restoreEvidence = null;
      lastPersisted = { ...written, digest: value.digest, counts: value.counts, snapshotAt: value.at };
      log('账本对账快照已写入 ' + filePath + '（pending ' + value.counts.pending + '）');
      return { ok: true, ...lastPersisted };
    } catch (error) {
      log('账本对账快照写入失败：' + ((error && error.message) || error));
      return { ok: false, error: 'E_LEDGER_IO', reason: 'write-failed', message: String((error && error.message) || error) };
    }
  }

  function readPersistedSnapshot() {
    if (!filePath) return { ok: false, exists: false, error: 'E_LEDGER_IO', reason: 'no-path', path: null };
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      const missing = error && error.code === 'ENOENT';
      return {
        ok: false,
        exists: !missing,
        error: 'E_LEDGER_IO',
        reason: missing ? 'missing' : 'read-failed',
        path: filePath,
        message: String((error && error.message) || error),
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        ok: false, exists: true, error: 'E_LEDGER_IO', reason: 'invalid-json', path: filePath,
        message: 'JSON 解析失败：' + String((error && error.message) || error), errors: ['invalid-json'],
      };
    }
    const validation = validateLedgerSnapshot(parsed);
    const stat = (() => { try { return fs.statSync(filePath); } catch { return null; } })();
    return {
      ok: validation.ok,
      exists: true,
      path: filePath,
      snapshot: parsed,
      validation,
      reason: validation.ok ? null : validation.digestOk ? 'invalid-schema' : 'digest-mismatch',
      bytes: stat ? stat.size : Buffer.byteLength(text),
      mtimeMs: stat ? Math.round(stat.mtimeMs) : null,
      ageMs: stat ? Math.max(0, now() - Math.round(stat.mtimeMs)) : null,
    };
  }

  /**
   * 启动/按需恢复对账：读取上次快照并与当前账本比较。
   * 只产证据，绝不自动 resolve（unknown 条目保持 replayBlocked）。
   */
  function restore({ status = null } = {}) {
    const read = readPersistedSnapshot();
    const current = snapshot({ status });
    if (!read.exists) {
      const evidence = {
        ok: true, exists: false, at: iso(now()), path: read.path,
        restored: 0, snapshot: null,
        current: { pending: current.counts.pending, unknown: current.counts.pendingUnknown, replayBlocked: current.counts.replayBlocked },
        drift: null, blocked: current.counts.replayBlocked,
      };
      restoreEvidence = evidence;
      return evidence;
    }
    if (!read.ok) {
      const evidence = {
        ok: false, exists: true, at: iso(now()), path: read.path,
        error: read.error || 'E_LEDGER_IO', reason: read.reason || 'invalid',
        validation: read.validation || null,
        message: read.message || null,
        current: { pending: current.counts.pending, unknown: current.counts.pendingUnknown, replayBlocked: current.counts.replayBlocked },
        drift: null, blocked: current.counts.replayBlocked,
      };
      restoreEvidence = evidence;
      log('账本对账快照不可用（' + (evidence.reason || 'invalid') + '）：' + (evidence.message || ''));
      return evidence;
    }
    const comparison = compareLedgerSnapshots(read.snapshot, current);
    const evidence = {
      ok: true,
      exists: true,
      at: iso(now()),
      path: read.path,
      ageMs: read.ageMs,
      snapshotAt: read.snapshot.at,
      digestOk: read.validation.digestOk,
      snapshotCounts: read.snapshot.counts || null,
      current: {
        pending: current.counts.pending,
        unknown: current.counts.pendingUnknown,
        stale: current.counts.pendingStale,
        replayBlocked: current.counts.replayBlocked,
      },
      drift: comparison,
      // 恢复语义证据：仍被阻断的未知意图数量（不会被"恢复"成已解决）。
      blocked: comparison.stillBlocked.length,
      restored: comparison.stillBlocked.length,
    };
    restoreEvidence = evidence;
    if (comparison.drift) {
      log('账本对账：快照后已结算 ' + comparison.counts.resolvedSince + ' 条，新增未知 ' + comparison.counts.becameUnknown + ' 条（仍阻断 ' + evidence.blocked + '）');
    }
    return evidence;
  }

  function compareToPersisted({ status = null } = {}) {
    return restore({ status });
  }

  /**
   * 按 tab（或全部）批量 reconcile：先出计划，再调用 ledger.reconcile()，最后回读剩余 pending。
   * @param {{tabId?: number|null, all?: boolean, outcome?: string, by?: string|null, dryRun?: boolean}} params
   */
  function reconcile({ tabId = null, all = false, outcome = 'reconciled', by = null, dryRun = false } = {}) {
    if (!all && (tabId === null || tabId === undefined)) {
      return {
        ok: false,
        error: 'E_BAD_ARG',
        message: 'ledger reconcile 需要 tabId 或 all=true',
        at: iso(now()),
      };
    }
    const before = readStatus({ limit: Math.max(20, maxPending) });
    const plan = planLedgerReconcile({
      status: before.status,
      tabId: all ? null : Number(tabId),
      outcome,
      now: now(),
    });
    const report = {
      ok: true,
      at: plan.at,
      requested: { tabId: plan.tabId, all: all === true, outcome: plan.outcome, explicit: plan.explicit, by: by || null, dryRun: dryRun === true },
      tabIds: plan.tabIds,
      candidates: plan.candidates,
      eligible: plan.eligible.length,
      protected: plan.protected,
      active: plan.active,
      resolved: 0,
      skipped: plan.skipped,
      perTab: [],
    };
    if (dryRun === true) {
      report.dryRun = true;
      report.wouldResolve = plan.eligible.length;
      return report;
    }
    for (const id of plan.tabIds) {
      let count = 0;
      try {
        count = ledger.reconcile(id, plan.outcome);
      } catch (error) {
        report.perTab.push({ tabId: id, resolved: 0, error: (error && error.code) || 'E_LEDGER_IO', message: String((error && error.message) || error) });
        continue;
      }
      report.resolved += count;
      report.perTab.push({ tabId: id, resolved: count });
    }
    const after = readStatus({ limit: Math.max(20, maxPending) });
    const remaining = planLedgerReconcile({ status: after.status, tabId: all ? null : Number(tabId), outcome, now: now() });
    report.remaining = { pending: Array.isArray(after.status.pending) ? after.status.pending.length : 0, eligible: remaining.eligible.length, protected: remaining.protected.length, active: remaining.active.length };
    report.after = { counts: { pending: remaining.candidates, replayBlocked: after.status.pending.filter((entry) => entry && entry.replayBlocked === true).length } };
    return report;
  }

  /** 供 status views/doctor 的精简摘要（不含单条明细）。 */
  function summary() {
    const { status } = readStatus({ limit: 1 });
    const pending = Array.isArray(status.pending) ? status.pending : [];
    let restored = restoreEvidence;
    if (!restored) restored = restore({ status });
    return {
      at: iso(now()),
      staleMs: status.staleMs,
      pending: pending.length,
      unknown: pending.filter((entry) => entry && entry.state === 'unknown').length,
      stale: pending.filter((entry) => entry && entry.state === 'stale').length,
      active: pending.filter((entry) => entry && entry.state === 'active').length,
      replayBlocked: pending.filter((entry) => entry && entry.replayBlocked === true).length,
      tabs: indexLedgerTabs(pending, { now: now() }).length,
      wal: status.wal || null,
      durability: status.durability || null,
      recovery: status.recovery || recovery || null,
      snapshot: {
        path: filePath,
        lastPersisted,
        restore: restored
          ? {
              ok: restored.ok,
              exists: restored.exists,
              at: restored.at,
              blocked: restored.blocked,
              drift: restored.drift ? { drift: restored.drift.drift, counts: restored.drift.counts } : null,
            }
          : null,
      },
    };
  }

  return {
    get snapshotPath() { return filePath; },
    get restoreEvidence() { return restoreEvidence; },
    readStatus,
    snapshot,
    persistSnapshot,
    readPersistedSnapshot,
    restore,
    compareToPersisted,
    reconcile,
    summary,
  };
}
