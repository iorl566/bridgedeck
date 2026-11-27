// src/audit.js —— 任务审计（扩展侧）：记录 daemon 下发的每次命令，默认关闭。
//
// 持久层保持 v1 兼容：chrome.storage.local 的 'bb.audit.events' 仍是条目数组（最多 500 条），
// 默认返回字段仍是 { entries, total }。本文件只负责把纯函数模块接进真实路径：
//   - recordAudit：调用点 extension/src/bridge.js:145-146（auditEnabled 时每条命令一次），
//     补单调 seq 与证据标注（normalizeAuditEntry），缺 ok/durationMs 就保持缺失；
//   - listAudit：调用点 extension/src/bridge.js:321（'bb.audit.list'）
//     ← extension/ui/audit.js:45 / :86、extension/ui/panels/audit-panel.js:25；
//     新增可选能力：offset 分页、integrity 证据完整性、snapshot 快照、
//     baseline 差异、timeline 时间线、journal 与 debug journal 关联。
//   - debug journal 关联读取的是 extension/src/debug-events.js 的同一份持久 journal
//     （lib/debug-journal-persist.js，debug.gaps/debug.history 也消费它），只读、不写入。
import {
  buildAuditSnapshot,
  buildAuditTimeline,
  correlateAuditWithJournal,
  describeAuditDiff,
  describeAuditTimeline,
  diffAuditSnapshots,
  normalizeAuditEntry,
  summarizeAuditSnapshot,
} from './audit-journal.js';
import { summarizeAuditIntegrity, verifyAuditEntries } from './audit-integrity.js';
import { debugJournalStore, hydrateDebugEvents } from './debug-events.js';

const KEY = 'bb.audit.events';
const MAX_EVENTS = 500;

/** 读 debug journal（同一份持久日志；不可用时返回 null，不伪造关联）。 */
async function readJournal(options = {}) {
  try {
    // service worker 重启后 journal 可能只在 storage 里：先恢复再快照（只读路径）。
    await hydrateDebugEvents().catch(() => {});
    const snapshot = debugJournalStore().snapshot({
      limit: Math.min(Math.max(Number(options.journalLimit) || 200, 1), 500),
      order: 'asc',
    });
    if (!snapshot || !Array.isArray(snapshot.events)) return null;
    return {
      version: snapshot.version,
      seq: snapshot.seq,
      events: snapshot.events,
      sessions: Array.isArray(snapshot.sessions) ? snapshot.sessions : [],
      byType: snapshot.byType && typeof snapshot.byType === 'object' ? { ...snapshot.byType } : {},
      count: Number(snapshot.count) || snapshot.events.length,
      timeRange: snapshot.timeRange || null,
    };
  } catch {
    return null;
  }
}

function asSnapshotInput(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
}

export async function recordAudit(entry) {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const list = Array.isArray(stored && stored[KEY]) ? stored[KEY] : [];
    // seq 单调递增：storage 里最大的 seq + 1；老条目没有 seq 时按位置补算，保证可排序。
    let nextSeq = 0;
    for (const item of list) nextSeq = Math.max(nextSeq, Number(item && item.seq) || 0);
    const normalized = normalizeAuditEntry(entry, { seq: nextSeq + 1 });
    if (!Number.isInteger(normalized.seq)) normalized.seq = nextSeq + 1;
    list.unshift(normalized);
    if (list.length > MAX_EVENTS) list.length = MAX_EVENTS;
    await chrome.storage.local.set({ [KEY]: list });
  } catch {
    // 存储失败不影响命令执行
  }
}

export async function listAudit(params = {}) {
  const stored = await chrome.storage.local.get(KEY);
  const all = Array.isArray(stored && stored[KEY]) ? stored[KEY] : [];
  const since = Number(params.since) || 0;
  const limit = Math.max(1, Math.min(500, Number(params.limit) || 100));
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const scoped = all.filter((item) => !since || Number(item.ts) >= since);
  const entries = scoped.slice(offset, offset + limit);
  // 默认字段保持不变（{ entries, total }）；以下全部是新增可选字段。
  const result = { entries, total: all.length };

  const journal = params.journal === true || params.timeline === true || params.integrity === true
    ? (params.journal === true || params.timeline === true ? await readJournal(params) : null)
    : null;

  if (params.integrity !== false) {
    const report = verifyAuditEntries(scoped, {
      now: Date.now(),
      capacity: MAX_EVENTS,
      journal,
      limit: MAX_EVENTS,
    });
    result.integrity = summarizeAuditIntegrity(report);
    result.integrityChecks = report.checks;
    if (params.integrityText === true) result.integrityText = report.text;
    if (report.issues.length) result.integrityIssues = report.issues.slice(0, 40);
  }

  if (params.snapshot === true || (params.snapshot && typeof params.snapshot === 'object')) {
    const options = params.snapshot && typeof params.snapshot === 'object' ? params.snapshot : {};
    const snapshot = buildAuditSnapshot(scoped, { label: options.label || params.label || null, limit: MAX_EVENTS });
    result.snapshot = snapshot;
    result.snapshotSummary = summarizeAuditSnapshot(snapshot);
    if (params.baseline !== undefined) {
      const previous = asSnapshotInput(params.baseline);
      const diff = diffAuditSnapshots(previous, snapshot);
      result.diff = diff;
      result.diffText = describeAuditDiff(diff);
    }
  } else if (params.baseline !== undefined) {
    // 只给 baseline 时，返回“相对基线的新增/变化”，不额外回带完整快照。
    const previous = asSnapshotInput(params.baseline);
    const current = buildAuditSnapshot(scoped, { limit: MAX_EVENTS });
    const diff = diffAuditSnapshots(previous, current);
    result.diff = diff;
    result.diffText = describeAuditDiff(diff);
  }

  if (params.timeline === true) {
    const timeline = buildAuditTimeline(scoped, { journal, limit: params.timelineLimit || 400 });
    result.timeline = timeline;
    result.timelineText = describeAuditTimeline(timeline);
  }
  if (params.journal === true) {
    const correlation = correlateAuditWithJournal(scoped, journal, { windowMs: params.journalWindowMs });
    result.journal = journal
      ? {
        available: true,
        version: journal.version,
        seq: journal.seq,
        count: journal.count,
        sessions: journal.sessions.length,
        byType: journal.byType,
        timeRange: journal.timeRange,
      }
      : { available: false, reason: 'journal-unavailable' };
    result.journalCorrelation = {
      version: correlation.version,
      linked: correlation.linked,
      unlinked: correlation.unlinked,
      total: correlation.total,
      windowMs: correlation.windowMs,
      journal: correlation.journal,
      byMethod: correlation.byMethod,
      links: correlation.links.slice(0, 40),
    };
  }
  return result;
}

export async function clearAudit() {
  await chrome.storage.local.set({ [KEY]: [] });
  return { ok: true };
}
