// cli/lib/daemon-views.mjs —— `bridge daemon ledger|transfer|queue|doctor` 的人类输出渲染（纯函数）。
//
// 所有函数只做"daemon 返回结构 → 字符串行"的映射，不发 RPC、不读文件：
// 这样 CLI 命令层保持"取数 → 渲染"两段式，渲染逻辑可以单测（tests/unit/daemon-cli-views.test.mjs）。
import { formatBytes, formatTime, renderTable, truncateText } from './format.mjs';

/** 毫秒时长（人类可读，<=5s 用 ms，避免 0.4s 这类噪声）。 */
export function formatDurationMs(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return Math.round(value) + 'ms';
  if (value < 60_000) return (value / 1000).toFixed(1) + 's';
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return minutes + 'm' + (seconds ? seconds + 's' : '');
}

function stateLabel(entry) {
  const lock = entry && entry.replayBlocked ? ' [blocked]' : '';
  return String((entry && entry.state) || '?') + lock;
}

/** `bridge daemon ledger`：pending + 最近记录 + 持久化/恢复摘要。 */
export function renderLedgerStatus(result = {}) {
  const lines = [];
  const pending = Array.isArray(result.pending) ? result.pending : [];
  const wal = result.wal && typeof result.wal === 'object' ? result.wal : null;
  const durability = result.durability && typeof result.durability === 'object' ? result.durability : null;
  const recovery = result.recovery && typeof result.recovery === 'object' ? result.recovery : null;
  lines.push('账本：待确认 ' + pending.length + ' 条，stale 阈值 ' + (result.staleMs == null ? '?' : result.staleMs + 'ms'));
  if (!pending.length) {
    lines.push('  （没有待确认的变异操作）');
  } else {
    lines.push(renderTable(
      ['id', 'method', 'tab', 'session', 'state', 'since'],
      pending.map((entry) => [
        entry.id || '-',
        entry.method || '-',
        entry.tabId == null ? '-' : String(entry.tabId),
        entry.sessionId || '-',
        stateLabel(entry),
        entry.at || '-',
      ]),
    ));
    const blocked = pending.filter((entry) => entry && entry.replayBlocked === true).length;
    if (blocked) lines.push('  其中 ' + blocked + ' 条 replayBlocked：确认页面状态后 bridge daemon ledger reconcile <tabId> --outcome confirmed|not-applied');
  }
  const recent = Array.isArray(result.recent) ? result.recent.slice(0, 8) : [];
  if (recent.length) {
    lines.push('');
    lines.push('最近记录：');
    for (const entry of recent) {
      lines.push('  ' + (entry.id || '-') + '  ' + (entry.method || '-') + '  ' + (entry.state || '?') + (entry.outcome ? ' → ' + entry.outcome : '') + '  ' + (entry.at || ''));
    }
  }
  if (wal) {
    lines.push('');
    lines.push('WAL：解析 ' + (wal.parsed ?? 0) + '/' + (wal.lines ?? 0) + ' 行，损坏 ' + (wal.corrupted ?? 0)
      + (wal.tornTail ? '，尾部撕裂' : '') + (wal.duplicates ? '，重复 ' + wal.duplicates : '') + (wal.outOfOrder ? '，乱序 ' + wal.outOfOrder : ''));
  }
  if (durability) {
    lines.push('持久化：fsync ' + (durability.fsync === true ? 'on' : 'off') + '，appends ' + (durability.appends ?? 0)
      + (durability.degraded ? '，降级：' + (durability.lastError ? (durability.lastError.code || '') : '') : ''));
  }
  if (recovery) {
    lines.push('启动恢复：' + (recovery.ok === false ? '降级（' + (recovery.error || '?') + '）' : 'pending→unknown ' + (recovery.recovered ?? 0)
      + '，replayBlocked ' + (recovery.replayBlocked ?? 0)) + (recovery.reason ? '（' + recovery.reason + '）' : ''));
  }
  const snapshot = result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : null;
  if (snapshot) lines.push('快照 digest：' + (snapshot.digest || '-') + '，pending ' + ((snapshot.counts && snapshot.counts.pending) ?? 0));
  const persisted = result.persisted && typeof result.persisted === 'object' ? result.persisted : null;
  if (persisted) {
    lines.push(persisted.ok
      ? '对账快照已写入：' + persisted.path + '（' + formatBytes(persisted.bytes) + '，digest ' + (persisted.digest || '-') + '）'
      : '对账快照写入失败：' + (persisted.error || '?') + ' ' + (persisted.message || ''));
  }
  const restore = result.restore && typeof result.restore === 'object' ? result.restore : null;
  if (restore) lines.push(...renderLedgerRestore(restore));
  return lines.join('\n');
}

/** 快照/恢复对账证据（`bridge daemon ledger snapshot` 与 `restore` 共用）。 */
export function renderLedgerRestore(restore = {}) {
  const lines = [];
  if (!restore.exists) {
    lines.push('恢复对账：没有历史快照（daemon 正常停止或 bridge daemon ledger snapshot 后生成）');
    return lines;
  }
  if (restore.ok === false) {
    lines.push('恢复对账：快照不可用（' + (restore.error || 'invalid') + '）' + (restore.validation && restore.validation.errors ? '：' + restore.validation.errors.slice(0, 3).join('；') : ''));
    return lines;
  }
  const drift = restore.drift || null;
  const counts = drift && drift.counts ? drift.counts : null;
  lines.push('恢复对账：快照 ' + (restore.snapshotAt || '?') + '（' + formatDurationMs(restore.ageMs || 0) + ' 前，digest ' + (restore.digestOk ? 'ok' : 'mismatch') + '）');
  lines.push('  当前：pending ' + ((restore.current && restore.current.pending) ?? 0)
    + '，unknown ' + ((restore.current && restore.current.unknown) ?? 0)
    + '，replayBlocked ' + ((restore.current && restore.current.replayBlocked) ?? 0));
  if (counts) {
    lines.push('  漂移：快照后已结算 ' + counts.resolvedSince + ' 条，新增未知 ' + counts.becameUnknown + ' 条，仍阻断 ' + counts.stillBlocked + ' 条');
    if (counts.becameUnknown > 0) lines.push('  警告：新增未知意图不会被自动解锁，需显式 bridge daemon ledger reconcile');
  } else if (restore.blocked) {
    lines.push('  仍阻断 ' + restore.blocked + ' 条');
  }
  ['resolvedSince', 'becameUnknown', 'stillBlocked'].forEach((key) => {
    const list = (drift && Array.isArray(drift[key])) ? drift[key].slice(0, 5) : [];
    if (!list.length) return;
    const label = { resolvedSince: '已结算', becameUnknown: '新增未知', stillBlocked: '仍阻断' }[key];
    lines.push('  ' + label + '：' + list.map((item) => (item.method || '?') + '@tab' + (item.tabId == null ? '-' : item.tabId)).join(', ')
      + (drift[key].length > list.length ? ' …' : ''));
  });
  return lines;
}

/** `bridge daemon ledger snapshot`：结构摘要 + 按 tab 索引。 */
export function renderLedgerSnapshot(result = {}) {
  const snapshot = result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : null;
  if (!snapshot) return renderLedgerStatus(result);
  const counts = snapshot.counts || {};
  const lines = [];
  lines.push('账本快照 schema=' + snapshot.schema + ' at=' + snapshot.at + ' digest=' + (snapshot.digest || '-'));
  lines.push('  pending ' + (counts.pending ?? 0) + '（unknown ' + (counts.pendingUnknown ?? 0) + '，stale ' + (counts.pendingStale ?? 0)
    + '，active ' + (counts.pendingActive ?? 0) + '），replayBlocked ' + (counts.replayBlocked ?? 0)
    + '，tabs ' + (counts.tabs ?? 0) + '，总条目 ' + (counts.total ?? 0));
  if (snapshot.pendingTruncated) lines.push('  （pending 列表已截断，省略 ' + (snapshot.pendingTruncatedCount ?? 0) + ' 条）');
  const tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
  if (tabs.length) {
    lines.push('');
    lines.push(renderTable(
      ['tab', 'pending', 'unknown', 'stale', 'active', 'blocked', 'oldest'],
      tabs.slice(0, 20).map((tab) => [
        tab.tabId == null ? '-' : String(tab.tabId),
        tab.pending,
        tab.unknown,
        tab.stale,
        tab.active,
        tab.replayBlocked,
        formatDurationMs(tab.oldestAgeMs),
      ]),
    ));
  }
  if (result.persisted) {
    lines.push('');
    lines.push(result.persisted.ok
      ? '对账快照已写入：' + result.persisted.path + '（' + formatBytes(result.persisted.bytes) + '）'
      : '对账快照写入失败：' + (result.persisted.error || '?') + ' ' + (result.persisted.message || ''));
  }
  if (result.restore) {
    lines.push('');
    lines.push(...renderLedgerRestore(result.restore));
  }
  return lines.join('\n');
}

/** `bridge daemon ledger reconcile`：批量和解报告。 */
export function renderLedgerReconcile(report = {}) {
  if (!report || report.ok === false) {
    return '和解失败：' + ((report && (report.message || report.error)) || 'unknown');
  }
  const requested = report.requested || {};
  const lines = [];
  lines.push('批量和解：' + (requested.all ? '全部 tab' : 'tab ' + (requested.tabId == null ? '?' : requested.tabId))
    + '，结论 ' + (requested.outcome || 'reconciled') + (requested.explicit ? '（显式）' : '')
    + (requested.by ? '，by ' + requested.by : ''));
  if (report.dryRun) {
    lines.push('  dry-run：可和解 ' + (report.wouldResolve ?? 0) + ' 条，跳过 ' + (report.skipped ?? 0) + ' 条');
  } else {
    lines.push('  候选 ' + (report.candidates ?? 0) + ' 条：已和解 ' + (report.resolved ?? 0) + ' 条，跳过 ' + (report.skipped ?? 0) + ' 条');
  }
  const protectedList = Array.isArray(report.protected) ? report.protected : [];
  if (protectedList.length) {
    lines.push('  受保护（崩溃恢复的非幂等动作，需 confirmed|not-applied）：' + protectedList.length + ' 条');
    for (const item of protectedList.slice(0, 8)) {
      lines.push('    ' + (item.id || '-') + '  ' + (item.method || '-') + '  tab=' + (item.tabId == null ? '-' : item.tabId) + '  ' + (item.reason || ''));
    }
  }
  const activeList = Array.isArray(report.active) ? report.active : [];
  if (activeList.length) lines.push('  仍在执行（active，不能和解）：' + activeList.length + ' 条');
  const perTab = Array.isArray(report.perTab) ? report.perTab : [];
  if (perTab.length > 1) {
    lines.push('  按 tab：' + perTab.map((item) => 'tab' + item.tabId + '=' + item.resolved).join(', '));
  }
  if (report.remaining) {
    lines.push('  剩余 pending ' + (report.remaining.pending ?? 0) + '（eligible ' + (report.remaining.eligible ?? 0)
      + '，protected ' + (report.remaining.protected ?? 0) + '，active ' + (report.remaining.active ?? 0) + '）');
  }
  return lines.join('\n');
}

/** `bridge daemon transfer`：配额用量 + 传输表。 */
export function renderTransferStatus(view = {}) {
  const lines = [];
  const quota = view.quota || {};
  const counts = view.counts || {};
  const bytes = view.bytes || {};
  const counters = view.counters || {};
  lines.push('传输配额：并发 ' + (counts.active ?? 0) + '/' + (quota.maxConcurrent ?? '?')
    + '（' + (quota.slotsPercent ?? 0) + '%），字节 ' + formatBytes(bytes.reserved || 0) + '/' + formatBytes(quota.maxTotalBytes || 0)
    + '（' + (quota.usagePercent ?? 0) + '%）');
  lines.push('  单会话上限 ' + (quota.maxPerSession ?? '?') + ' 个 / ' + formatBytes(quota.maxSessionBytes || 0)
    + '，空闲回收 ' + formatDurationMs(quota.idleTtlMs || 0) + '，已完成保留 ' + formatDurationMs(quota.finishedTtlMs || 0));
  lines.push('  总计 ' + (counts.total ?? 0) + '（upload ' + (counts.uploads ?? 0) + '，download ' + (counts.downloads ?? 0)
    + '，finished ' + (counts.finished ?? 0) + '），已收 ' + formatBytes(bytes.received || 0)
    + (counters.quotaRejected ? '，配额拒绝 ' + counters.quotaRejected : '')
    + (counters.checksumFailed ? '，校验失败 ' + counters.checksumFailed : '')
    + (counters.sweepRemoved ? '，清理 ' + counters.sweepRemoved : ''));
  const sessions = Array.isArray(view.sessions) ? view.sessions : [];
  if (sessions.length) {
    lines.push('');
    lines.push('按会话：');
    lines.push(renderTable(
      ['session', 'active', 'reserved', 'received'],
      sessions.slice(0, 10).map((item) => [item.sessionId, item.active, formatBytes(item.reservedBytes || 0), formatBytes(item.receivedBytes || 0)]),
    ));
  }
  const transfers = Array.isArray(view.transfers) ? view.transfers : [];
  lines.push('');
  if (!transfers.length) {
    lines.push('（没有进行中/暂存的传输）');
    return lines.join('\n');
  }
  lines.push(renderTable(
    ['transferId', 'session', 'name', 'direction', 'progress', 'bytes', 'idle', 'state'],
    transfers.map((item) => [
      item.transferId,
      item.sessionId || '-',
      truncateText(item.name || '-', 24),
      item.direction,
      item.percent + '%',
      formatBytes(item.received) + '/' + formatBytes(item.byteSize),
      formatDurationMs(item.idleMs || 0),
      item.finished ? (item.verified ? 'finished/verified' : 'finished') : 'active',
    ]),
  ));
  if (view.truncated) lines.push('（列表已截断，用 --limit 调整）');
  return lines.join('\n');
}

/** `bridge daemon queue`：总量 + 每会话等待/拒绝 + tab 公平性。 */
export function renderQueueStatus(view = {}) {
  const lines = [];
  const totals = view.totals || {};
  const inflight = view.inflight || {};
  const limits = view.limits || {};
  const fairness = view.fairness || {};
  lines.push('命令队列：容量 ' + (view.capacity ?? '?') + '，上限 全局执行 ' + (limits.maxInflight ?? '?')
    + ' / 会话执行 ' + (limits.maxInflightPerSession ?? '?') + ' / 会话排队 ' + (limits.maxPendingPerSession ?? '?'));
  lines.push('  排队 ' + (totals.pending ?? 0) + '，执行中 ' + (inflight.current ?? 0) + '/' + (inflight.limit ?? '?')
    + '（峰值 ' + (inflight.peak ?? 0) + '），累计 ' + (totals.dispatch ?? 0)
    + '（完成 ' + (totals.completed ?? 0) + '，失败 ' + (totals.failed ?? 0) + '，拒绝 ' + (totals.rejected ?? 0) + '）');
  lines.push('  公平性：' + (fairness.strategy || '?') + '，Jain ' + (fairness.jainIndex == null ? '-' : fairness.jainIndex)
    + '，最长连续 ' + (fairness.maxConsecutive ?? 0) + '，最长排队 ' + formatDurationMs(fairness.longestQueuedMs || 0));
  const rejects = view.rejects || {};
  const byReason = rejects.byReason || {};
  if (rejects.total) {
    lines.push('  拒绝原因：' + Object.entries(byReason).map(([reason, count]) => reason + '=' + count).join(', '));
  }
  const sessions = Array.isArray(view.sessions) ? view.sessions : [];
  lines.push('');
  if (!sessions.length) {
    lines.push('（还没有命令进入队列）');
  } else {
    lines.push(renderTable(
      ['session', 'pending', 'inflight', 'wait p50/p95', 'tabWait p95', 'completed', 'share', 'rejected'],
      sessions.map((item) => [
        item.sessionId,
        item.pending,
        item.inflight,
        item.wait.p50Ms + '/' + item.wait.p95Ms + 'ms',
        (item.tabWait ? item.tabWait.p95Ms : 0) + 'ms',
        item.completed,
        (item.completedSharePercent ?? 0) + '%',
        item.rejected,
      ]),
    ));
  }
  const tabs = Array.isArray(fairness.tabs) ? fairness.tabs : [];
  if (tabs.length) {
    lines.push('');
    lines.push('tab 调度：');
    lines.push(renderTable(
      ['tab', 'holder', 'queued', 'served', 'maxSeq', 'longestWait', 'fairness'],
      tabs.slice(0, 10).map((tab) => [
        tab.tabKey,
        tab.holder || '-',
        tab.queued,
        tab.served,
        tab.maxConsecutive,
        formatDurationMs(tab.longestQueuedMs || 0),
        tab.fairness == null ? '-' : tab.fairness,
      ]),
    ));
  }
  const lastRejects = sessions.filter((item) => item.lastReject).slice(0, 5);
  if (lastRejects.length) {
    lines.push('');
    lines.push('最近拒绝：');
    for (const item of lastRejects) {
      lines.push('  ' + item.sessionId + '  ' + item.lastReject.code + '  ' + item.lastReject.reason
        + (item.lastReject.method ? '  ' + item.lastReject.method : '') + '  ' + formatTime(item.lastReject.at));
    }
  }
  return lines.join('\n');
}

const DOCTOR_LABEL = { ok: '[ok]  ', warn: '[warn]', fail: '[fail]' };

/** `bridge daemon doctor`：daemon 侧结构化自检。 */
export function renderDoctorReport(report = {}) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const lines = [];
  const summary = report.summary || {};
  lines.push('daemon 自检：' + (report.status || '?') + '（检查 ' + (summary.total ?? checks.length)
    + ' 项，ok ' + (summary.ok ?? 0) + '，warn ' + (summary.warn ?? 0) + '，fail ' + (summary.fail ?? 0) + '）  @' + (report.at || ''));
  for (const check of checks) {
    lines.push((DOCTOR_LABEL[check.status] || '[?]   ') + ' ' + String(check.id || check.area || '?').padEnd(20) + ' ' + (check.detail || ''));
  }
  return lines.join('\n');
}

/** doctor 报告 → CLI 退出码（fail=1，其余 0；与 `bridge doctor` 的 hardOk 口径一致）。 */
export function doctorExitCode(report) {
  return report && report.status === 'fail' ? 1 : 0;
}

/** 从 daemon doctor 报告里挑出某个 area 的检查项（CLI doctor 做摘要用）。 */
export function doctorAreaSummary(report, area) {
  const checks = Array.isArray(report && report.checks) ? report.checks.filter((check) => check && check.area === area) : [];
  const status = checks.some((check) => check.status === 'fail') ? 'fail' : checks.some((check) => check.status === 'warn') ? 'warn' : 'ok';
  return { status, checks, detail: checks.map((check) => check.detail).join('；') };
}
