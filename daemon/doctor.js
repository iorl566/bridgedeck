// daemon/doctor.js —— daemon 侧结构化自检（ledger / transfer / queue / recovery / storage）。
//
// 与 CLI `bridge doctor` 的分工：
//   - CLI doctor 查环境（node/BB_HOME/日志/安装/TLS/配对）；
//   - 本模块查 daemon 运行时内部状态，回答"现在账本有没有未知意图、传输配额是否吃紧、
//     队列有没有堆积/饿死、启动恢复有没有异常"。
//
// 输出是结构化的 {schema, at, ok, status, checks:[{id, area, status, detail, data}]}：
//   - status: 'ok' | 'warn' | 'fail'；
//   - 任何检查项异常都不抛出，降级为 fail + message（doctor 本身不能把 daemon 弄挂）；
//   - 数据源全部来自 daemon 内存快照（无额外 IO，除了 storage 的 statfs/access 探测）。

import fs from 'node:fs';

export const DAEMON_DOCTOR_SCHEMA = 1;
export const DAEMON_DOCTOR_AREAS = Object.freeze(['ledger', 'transfer', 'queue', 'recovery', 'storage', 'runtime']);

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

/** 状态聚合：fail > warn > ok。空数组视为 ok。 */
export function aggregateDoctorStatus(checks) {
  const list = Array.isArray(checks) ? checks : [];
  if (list.some((check) => check && check.status === 'fail')) return 'fail';
  if (list.some((check) => check && check.status === 'warn')) return 'warn';
  return 'ok';
}

/** 检查项计分（doctor 输出/CLI 汇总用）。 */
export function summarizeDoctorChecks(checks) {
  const summary = { total: 0, ok: 0, warn: 0, fail: 0, skipped: 0, areas: {} };
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!check || typeof check !== 'object') continue;
    summary.total += 1;
    if (check.status === 'fail') summary.fail += 1;
    else if (check.status === 'warn') summary.warn += 1;
    else summary.ok += 1;
    if (check.skipped === true) summary.skipped += 1;
    const area = check.area || 'other';
    if (!summary.areas[area]) summary.areas[area] = { ok: 0, warn: 0, fail: 0 };
    summary.areas[area][check.status === 'fail' ? 'fail' : check.status === 'warn' ? 'warn' : 'ok'] += 1;
  }
  return summary;
}

/**
 * 构造 daemon 自检器。所有数据源可选：缺失时对应检查项标记为 skipped（不阻塞 doctor）。
 * @param {{ledgerReport?: object|null, transferOps?: object|null, commandQueue?: object|null,
 *          sessionRecovery?: object|null, ledger?: object|null, version?: string|null, protocol?: string|null,
 *          startedAt?: number|null, homeDir?: string|null, now?: Function, fsImpl?: object, statfs?: Function}} options
 */
export function createDaemonDoctor({
  ledgerReport = null,
  transferOps = null,
  commandQueue = null,
  sessionRecovery = null,
  ledger = null,
  version = null,
  protocol = null,
  startedAt = null,
  homeDir = null,
  now = () => Date.now(),
  fsImpl = fs,
  statfs = null,
} = {}) {
  function makeCheck(area, id, status, detail, data = null, extra = null) {
    return { id, area, status, detail, data, ...(extra || {}) };
  }

  function skipped(area, id, detail) {
    return makeCheck(area, id, 'ok', detail, { available: false }, { skipped: true });
  }

  function ledgerDurabilityCheck() {
    if (!ledgerReport || typeof ledgerReport.readStatus !== 'function') return skipped('ledger', 'ledger.durability', '账本未接入');
    const { status } = ledgerReport.readStatus({ limit: 1 });
    const durability = status.durability && typeof status.durability === 'object' ? status.durability : {};
    const wal = status.wal && typeof status.wal === 'object' ? status.wal : {};
    const problems = [];
    if (durability.degraded === true) problems.push('持久化已降级：' + (durability.lastError ? (durability.lastError.code + ' ' + durability.lastError.message) : '未知原因'));
    if (Number(wal.corrupted) > 0) problems.push('WAL 损坏行 ' + wal.corrupted);
    if (wal.tornTail === true) problems.push('WAL 尾部撕裂（进程可能在写入中崩溃）');
    if (Number(wal.outOfOrder) > 0) problems.push('WAL 乱序 ' + wal.outOfOrder);
    if (Number(wal.duplicates) > 0) problems.push('WAL 重复帧 ' + wal.duplicates);
    if (durability.fsync === false) problems.push('fsync 关闭（BB_LEDGER_FSYNC=0），掉电可能丢最后几条意图');
    const statusValue = durability.degraded === true || Number(wal.corrupted) > 0 || wal.tornTail === true ? 'fail' : problems.length ? 'warn' : 'ok';
    const detail = problems.length ? problems.join('；') : 'WAL 健康（appends ' + (durability.appends || 0) + '，fsync ' + (durability.fsync === true ? 'on' : 'off') + '）';
    return makeCheck('ledger', 'ledger.durability', statusValue, detail, { wal, durability });
  }

  function ledgerPendingCheck() {
    if (!ledgerReport || typeof ledgerReport.readStatus !== 'function') return skipped('ledger', 'ledger.pending', '账本未接入');
    const { status } = ledgerReport.readStatus({ limit: 1 });
    const pending = Array.isArray(status.pending) ? status.pending : [];
    const unknown = pending.filter((entry) => entry && entry.state === 'unknown');
    const stale = pending.filter((entry) => entry && entry.state === 'stale');
    const blocked = pending.filter((entry) => entry && entry.replayBlocked === true);
    const tabs = [...new Set(pending.filter((entry) => entry && Number.isInteger(entry.tabId)).map((entry) => entry.tabId))];
    if (!pending.length) return makeCheck('ledger', 'ledger.pending', 'ok', '没有待确认的变异意图', { pending: 0 });
    const detail = '待确认 ' + pending.length + ' 条（unknown ' + unknown.length + '、stale ' + stale.length + '、replayBlocked ' + blocked.length + '）；受影响 tab：' + (tabs.length ? tabs.join(',') : '无');
    return makeCheck('ledger', 'ledger.pending', 'warn', detail, {
      pending: pending.length,
      unknown: unknown.map((entry) => entry.id).slice(0, 10),
      stale: stale.map((entry) => entry.id).slice(0, 10),
      replayBlocked: blocked.length,
      tabs,
      hint: '确认页面状态后 bridge daemon ledger reconcile <tabId> --outcome confirmed|not-applied',
    });
  }

  function ledgerSnapshotCheck() {
    if (!ledgerReport || typeof ledgerReport.restore !== 'function') return skipped('ledger', 'ledger.snapshot', '账本未接入');
    const restored = ledgerReport.restoreEvidence || ledgerReport.restore();
    if (!restored.exists) {
      return makeCheck('ledger', 'ledger.snapshot', 'ok', '还没有对账快照（daemon 正常停止/显式 snapshot 后生成）', { exists: false, path: restored.path || null });
    }
    if (restored.ok === false) {
      return makeCheck('ledger', 'ledger.snapshot', 'warn', '对账快照不可用：' + (restored.error || 'invalid') + (restored.validation && restored.validation.errors ? '（' + restored.validation.errors.slice(0, 3).join('；') + '）' : ''), restored);
    }
    const drift = restored.drift && restored.drift.counts ? restored.drift.counts : { resolvedSince: 0, becameUnknown: 0, stillBlocked: 0 };
    const statusValue = drift.becameUnknown > 0 ? 'warn' : 'ok';
    const detail = statusValue === 'ok'
      ? '快照 ' + (restored.snapshotAt || '?') + ' 对齐（仍阻断 ' + (restored.blocked || 0) + ' 条，digest ' + (restored.digestOk ? 'ok' : 'mismatch') + '）'
      : '快照后新增未知意图 ' + drift.becameUnknown + ' 条（仍阻断 ' + (restored.blocked || 0) + ' 条）';
    return makeCheck('ledger', 'ledger.snapshot', statusValue, detail, restored);
  }

  function transferQuotaCheck() {
    if (!transferOps || typeof transferOps.transferSnapshot !== 'function') return skipped('transfer', 'transfer.quota', 'transfer 未接入');
    const snapshot = transferOps.transferSnapshot({ limit: 1 });
    const quota = snapshot.quota || {};
    const usagePercent = Number(quota.usagePercent) || 0;
    const slotsPercent = Number(quota.slotsPercent) || 0;
    const rejected = (snapshot.counters && snapshot.counters.quotaRejected) || 0;
    const worst = Math.max(usagePercent, slotsPercent);
    const statusValue = worst >= 100 ? 'fail' : worst >= 80 || rejected > 0 ? 'warn' : 'ok';
    const detail = '并发 ' + (snapshot.counts ? snapshot.counts.active : 0) + '/' + (quota.maxConcurrent || '?')
      + '（' + slotsPercent + '%），字节 ' + (snapshot.bytes ? snapshot.bytes.reserved : 0) + '/' + (quota.maxTotalBytes || '?')
      + '（' + usagePercent + '%）' + (rejected ? '，已拒绝 ' + rejected + ' 次' : '');
    return makeCheck('transfer', 'transfer.quota', statusValue, detail, { quota, counts: snapshot.counts, bytes: snapshot.bytes, rejected });
  }

  function transferStuckCheck() {
    if (!transferOps || typeof transferOps.transferSnapshot !== 'function') return skipped('transfer', 'transfer.stuck', 'transfer 未接入');
    const snapshot = transferOps.transferSnapshot({ limit: 200 });
    const idleTtl = Number(snapshot.quota && snapshot.quota.idleTtlMs) || 0;
    const unfinished = (snapshot.transfers || []).filter((item) => item.finished !== true);
    const threshold = idleTtl > 0 ? idleTtl / 2 : 5 * 60 * 1000;
    const stuck = unfinished.filter((item) => Number(item.idleMs) >= threshold);
    const counters = snapshot.counters || {};
    if (!stuck.length) {
      return makeCheck('transfer', 'transfer.stuck', 'ok', '进行中 ' + unfinished.length + ' 个，无长期空闲传输（清理 ' + (counters.sweepRemoved || 0) + ' 次）', { unfinished: unfinished.length, stuck: 0, counters });
    }
    return makeCheck('transfer', 'transfer.stuck', 'warn', stuck.length + ' 个传输空闲超过 ' + Math.round(threshold / 1000) + 's（可能客户端已断开，sweep 会回收）', {
      stuck: stuck.map((item) => ({ transferId: item.transferId, idleMs: item.idleMs, sessionId: item.sessionId })),
      counters,
    });
  }

  function queueSaturationCheck() {
    if (!commandQueue || typeof commandQueue.diagnostics !== 'function') return skipped('queue', 'queue.saturation', '队列未接入');
    const diagnostics = commandQueue.diagnostics({ limitSessions: 1, tabLimit: 1 });
    const totals = diagnostics.totals || {};
    const inflight = diagnostics.inflight || {};
    const inflightPercent = inflight.limit > 0 ? round1((inflight.current / inflight.limit) * 100) : 0;
    const statusValue = totals.rejected > 0 || inflightPercent >= 90 ? 'warn' : 'ok';
    const detail = '排队 ' + (totals.pending || 0) + '，执行中 ' + (inflight.current || 0) + '/' + (inflight.limit || '?')
      + '（峰值 ' + (totals.peakInflight || 0) + '），累计拒绝 ' + (totals.rejected || 0)
      + (diagnostics.rejects && diagnostics.rejects.byReason && Object.keys(diagnostics.rejects.byReason).length
        ? '（' + Object.entries(diagnostics.rejects.byReason).map(([reason, count]) => reason + '=' + count).join(',') + '）'
        : '');
    return makeCheck('queue', 'queue.saturation', statusValue, detail, { totals, inflight, rejects: diagnostics.rejects });
  }

  function queueFairnessCheck() {
    if (!commandQueue || typeof commandQueue.diagnostics !== 'function') return skipped('queue', 'queue.fairness', '队列未接入');
    const diagnostics = commandQueue.diagnostics({ limitSessions: 1, tabLimit: 20 });
    const fairness = diagnostics.fairness || {};
    const longest = Number(fairness.longestQueuedMs) || 0;
    const maxConsecutive = Number(fairness.maxConsecutive) || 0;
    const statusValue = maxConsecutive > 8 || longest > 15000 ? 'warn' : 'ok';
    const detail = '策略 ' + (fairness.strategy || '?') + '，Jain ' + (fairness.jainIndex == null ? '-' : fairness.jainIndex)
      + '，最长连续 ' + maxConsecutive + '，最长排队 ' + Math.round(longest) + 'ms，饥饿 tab ' + (fairness.starvingTabs || 0);
    return makeCheck('queue', 'queue.fairness', statusValue, detail, { fairness });
  }

  function recoveryCheck() {
    if (!sessionRecovery || typeof sessionRecovery.snapshot !== 'function') return skipped('recovery', 'recovery.sessions', '恢复聚合未接入');
    const snapshot = sessionRecovery.snapshot();
    const plan = snapshot.sessions && snapshot.sessions.plan ? snapshot.sessions.plan : null;
    const ledgerRecovery = snapshot.ledger || null;
    const problems = [];
    if (plan && plan.invalid > 0) problems.push('持久化会话坏行 ' + plan.invalid);
    if (plan && plan.expired > 0) problems.push('过期会话 ' + plan.expired);
    if (plan && plan.duplicates > 0) problems.push('重复会话 ' + plan.duplicates);
    if (ledgerRecovery && ledgerRecovery.ok === false) problems.push('账本恢复降级：' + (ledgerRecovery.error || 'unknown'));
    const statusValue = ledgerRecovery && ledgerRecovery.ok === false ? 'fail' : problems.length ? 'warn' : 'ok';
    const detail = problems.length
      ? problems.join('；')
      : '启动恢复：会话 ' + (plan ? plan.restore : 0) + '，账本 pending→unknown ' + ((ledgerRecovery && ledgerRecovery.recovered) || 0) + '，租约 ' + ((snapshot.leases || []).length);
    return makeCheck('recovery', 'recovery.sessions', statusValue, detail, { plan, ledger: ledgerRecovery, leases: (snapshot.leases || []).length });
  }

  function storageCheck() {
    if (!homeDir) return skipped('storage', 'storage.home', '未提供 BB_HOME');
    const checks = [];
    try {
      fsImpl.accessSync(homeDir, fsImpl.constants.W_OK);
      checks.push({ ok: true });
    } catch (error) {
      return makeCheck('storage', 'storage.home', 'fail', BB_HOME_LABEL(homeDir) + ' 不可写：' + ((error && error.message) || error), { home: homeDir });
    }
    let freeBytes = null;
    try {
      const statfsImpl = typeof statfs === 'function' ? statfs : (typeof fsImpl.statfsSync === 'function' ? fsImpl.statfsSync : null);
      if (statfsImpl) {
        const stat = statfsImpl(homeDir);
        freeBytes = Number(stat.bavail) * Number(stat.bsize);
      }
    } catch { /* statfs 在部分平台不可用：跳过磁盘检查 */ }
    const statusValue = freeBytes != null && freeBytes < 50 * 1024 * 1024 ? 'warn' : 'ok';
    const detail = freeBytes == null ? 'BB_HOME 可写（磁盘可用空间未知）' : 'BB_HOME 可写，可用 ' + formatBytes(freeBytes);
    return makeCheck('storage', 'storage.home', statusValue, detail, { home: homeDir, freeBytes });
  }

  function runtimeCheck() {
    if (!startedAt) return skipped('runtime', 'runtime.daemon', '未提供启动时间');
    const uptimeMs = Math.max(0, now() - startedAt);
    const memory = typeof process.memoryUsage === 'function' ? process.memoryUsage() : null;
    const detail = 'v' + (version || '?') + '（protocol ' + (protocol || '?') + '），运行 ' + formatDuration(uptimeMs)
      + (memory ? '，rss ' + formatBytes(memory.rss) : '');
    return makeCheck('runtime', 'runtime.daemon', 'ok', detail, { version, protocol, uptimeMs, memory });
  }

  function run({ include = null } = {}) {
    const selected = Array.isArray(include) && include.length ? new Set(include) : null;
    const want = (area) => !selected || selected.has(area);
    const checks = [];
    const collect = (area, fn) => {
      if (!want(area)) return;
      try {
        checks.push(fn());
      } catch (error) {
        checks.push(makeCheck(area, area + '.error', 'fail', '自检异常：' + ((error && error.message) || error), { message: String((error && error.message) || error) }));
      }
    };
    collect('ledger', ledgerDurabilityCheck);
    collect('ledger', ledgerPendingCheck);
    collect('ledger', ledgerSnapshotCheck);
    collect('transfer', transferQuotaCheck);
    collect('transfer', transferStuckCheck);
    collect('queue', queueSaturationCheck);
    collect('queue', queueFairnessCheck);
    collect('recovery', recoveryCheck);
    collect('storage', storageCheck);
    collect('runtime', runtimeCheck);
    const status = aggregateDoctorStatus(checks);
    return {
      schema: DAEMON_DOCTOR_SCHEMA,
      at: new Date(now()).toISOString(),
      ok: status !== 'fail',
      status,
      checks,
      summary: summarizeDoctorChecks(checks),
    };
  }

  return { run };
}

function BB_HOME_LABEL(homeDir) {
  return 'BB_HOME(' + homeDir + ')';
}

function formatBytes(value) {
  const number = Number(value) || 0;
  if (number < 1024) return number + ' B';
  if (number < 1024 * 1024) return round1(number / 1024) + ' KB';
  if (number < 1024 * 1024 * 1024) return round1(number / 1024 / 1024) + ' MB';
  return round1(number / 1024 / 1024 / 1024) + ' GB';
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  if (total < 60) return total + 's';
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return minutes + 'm' + (seconds ? seconds + 's' : '');
  const hours = Math.floor(minutes / 60);
  return hours + 'h' + (minutes % 60) + 'm';
}
