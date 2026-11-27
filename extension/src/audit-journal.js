// src/audit-journal.js —— 扩展侧任务审计的日志模型：归一化 / 快照 / 差异 / 时间线 / 关联。
//
// src/audit.js 的持久层（chrome.storage.local 的 bb.audit.events）保持原样：
// 这里只做**纯函数**加工，保证默认输出（entries/total）不变，同时让 `bb.audit.list`
// 这条路径（bridge.js → ui/audit.js）能按需拿到：
//   - normalizeAuditEntry：命令条目补齐 seq/证据字段，缺什么标什么（ok/durationMs 没记就是没有）；
//   - buildAuditSnapshot / diffAuditSnapshots：跨命令、跨会话的快照与差异（新增/消失/变更）；
//   - buildAuditTimeline：审计命令 + debug journal 事件（同一个 chrome.storage 会话日志）
//     合成一条时间线，并显式标注间隔；
//   - correlateAuditWithJournal：按 tab/session + 时间窗做关联，输出 links 与未关联数。
//
// 纯函数：不读 chrome.storage、不读 DOM；journal 事件由调用方传入。

export const AUDIT_JOURNAL_VERSION = 1;

export const AUDIT_LIMITS = Object.freeze({
  entries: 500,
  sessions: 64,
  methods: 64,
  timeline: 400,
  gaps: 40,
  correlationWindowMs: 2000,
  links: 240,
});

const SELF_EVIDENCE_FIELDS = Object.freeze(['ok', 'durationMs', 'sessionId', 'tabId', 'url', 'code']);

function limitOf(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === '' ? null : text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 稳定序列化（键排序），用于快照 digest；不依赖 JSON.stringify 的插入顺序。 */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(String(value));
}

export function auditDigest(value) {
  return 'ad-' + fnv1a(stableStringify(value)).toString(36).padStart(7, '0').slice(-7);
}

/**
 * 命令条目归一化：保留原字段，补齐诊断字段；缺证据的字段返回 null + evidence.missing。
 * @param {object} entry
 * @param {{seq?:number, index?:number}} [options]
 */
export function normalizeAuditEntry(entry, options = {}) {
  const source = isPlainObject(entry) ? entry : { value: entry };
  const tsRaw = numberOrNull(source.ts);
  const ts = tsRaw !== null && tsRaw > 0 ? Math.round(tsRaw) : null;
  const seqRaw = numberOrNull(source.seq);
  const seq = Number.isInteger(seqRaw) && seqRaw >= 0
    ? seqRaw
    : (Number.isInteger(options.seq) && options.seq >= 0 ? options.seq : null);
  const method = stringOrNull(source.method);
  const commandId = stringOrNull(source.commandId);
  const sessionId = stringOrNull(source.sessionId);
  const tabIdRaw = numberOrNull(source.tabId);
  const tabId = Number.isInteger(tabIdRaw) ? tabIdRaw : null;
  const ok = source.ok === true ? true : source.ok === false ? false : null;
  const durationMs = numberOrNull(source.durationMs);
  const url = stringOrNull(source.url);
  const evidence = {};
  for (const field of SELF_EVIDENCE_FIELDS) {
    evidence[field] = field === 'ok' ? ok !== null : field === 'durationMs' ? durationMs !== null : source[field] !== undefined && source[field] !== null;
  }
  return {
    ...source,
    version: AUDIT_JOURNAL_VERSION,
    ...(seq !== null ? { seq } : {}),
    ts,
    method,
    commandId,
    sessionId,
    tabId,
    ok,
    ...(durationMs !== null ? { durationMs } : {}),
    ...(url !== null ? { url } : {}),
    evidence: {
      ...(isPlainObject(source.evidence) ? source.evidence : {}),
      present: evidence,
      missing: Object.keys(evidence).filter((field) => evidence[field] !== true),
    },
  };
}

function normalizedList(entries, options = {}) {
  const max = limitOf(options.limit, AUDIT_LIMITS.entries, 5000);
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry !== null && entry !== undefined)
    .slice(0, max)
    .map((entry, index) => normalizeAuditEntry(entry, { index }));
}

function methodCounts(entries) {
  const methods = {};
  for (const entry of entries) {
    if (!entry.method) continue;
    methods[entry.method] = (methods[entry.method] || 0) + 1;
  }
  return methods;
}

function sessionsOf(entries, limit) {
  const map = new Map();
  for (const entry of entries) {
    const key = entry.sessionId || (entry.tabId != null ? 'tab-' + entry.tabId : 'unscoped');
    const session = map.get(key) || { sessionId: entry.sessionId || null, tabId: entry.tabId, entries: 0, ok: 0, failed: 0, firstTs: null, lastTs: null, methods: {} };
    session.entries += 1;
    if (entry.ok === true) session.ok += 1;
    else if (entry.ok === false) session.failed += 1;
    if (entry.ts != null) {
      if (session.firstTs === null || entry.ts < session.firstTs) session.firstTs = entry.ts;
      if (session.lastTs === null || entry.ts > session.lastTs) session.lastTs = entry.ts;
    }
    if (entry.method) session.methods[entry.method] = (session.methods[entry.method] || 0) + 1;
    map.set(key, session);
  }
  return Array.from(map.values())
    .sort((a, b) => (Number(b.lastTs) || 0) - (Number(a.lastTs) || 0) || String(a.sessionId || a.tabId).localeCompare(String(b.sessionId || b.tabId)))
    .slice(0, limit);
}

/**
 * 审计快照：跨命令/跨会话的可比较视图（只含元数据，不含页面内容）。
 * @param {object[]} entries
 * @param {{createdAt?:number, label?:string, limit?:number}} [options]
 */
export function buildAuditSnapshot(entries, options = {}) {
  const list = normalizedList(entries, options);
  const ordered = list.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  const sessions = sessionsOf(list, AUDIT_LIMITS.sessions);
  const seqs = list.map((entry) => entry.seq).filter((seq) => Number.isInteger(seq));
  const times = list.map((entry) => entry.ts).filter((ts) => Number.isFinite(ts));
  const createdAt = Number.isFinite(Number(options.createdAt)) ? Math.round(Number(options.createdAt)) : Date.now();
  const digest = auditDigest({
    total: list.length,
    sessions: sessions.map((session) => [session.sessionId, session.tabId, session.entries]),
    commands: list.map((entry) => [entry.ts, entry.method, entry.commandId, entry.ok]).slice(0, 500),
  });
  return {
    version: AUDIT_JOURNAL_VERSION,
    kind: 'audit-snapshot',
    id: digest,
    label: options.label ? String(options.label).slice(0, 80) : null,
    createdAt,
    total: list.length,
    entries: ordered,
    sessions,
    methods: methodCounts(list),
    seqRange: seqs.length ? { from: Math.min(...seqs), to: Math.max(...seqs) } : null,
    timeRange: times.length ? { from: Math.min(...times), to: Math.max(...times) } : null,
    counts: {
      entries: list.length,
      sessions: sessions.length,
      ok: list.filter((entry) => entry.ok === true).length,
      failed: list.filter((entry) => entry.ok === false).length,
      unknown: list.filter((entry) => entry.ok === null).length,
    },
    digest,
  };
}

function entryKey(entry) {
  return [entry.commandId || '', entry.method || '', entry.ts || '', entry.tabId == null ? '' : entry.tabId].join('\u0000');
}

/**
 * 两个快照的差异：新增 / 消失 / 变更（同 commandId 但 ok/url/method 变化）。
 * @param {object|object[]} previous buildAuditSnapshot() 结果或裸 entries
 * @param {object|object[]} next
 */
export function diffAuditSnapshots(previous, next, options = {}) {
  const prevEntries = Array.isArray(previous) ? normalizedList(previous, options) : (previous && Array.isArray(previous.entries) ? normalizedList(previous.entries, options) : null);
  const nextEntries = Array.isArray(next) ? normalizedList(next, options) : (next && Array.isArray(next.entries) ? normalizedList(next.entries, options) : null);
  if (!prevEntries || !nextEntries) {
    return {
      version: AUDIT_JOURNAL_VERSION,
      kind: 'incomparable',
      reason: !prevEntries ? 'previous-missing' : 'next-missing',
      added: [],
      removed: [],
      changed: [],
      unchanged: 0,
      sessions: { added: [], removed: [] },
      summary: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    };
  }
  const prevByKey = new Map(prevEntries.map((entry) => [entryKey(entry), entry]));
  const nextByKey = new Map(nextEntries.map((entry) => [entryKey(entry), entry]));
  const added = [];
  const changed = [];
  let unchanged = 0;
  for (const [key, entry] of nextByKey) {
    const before = prevByKey.get(key);
    if (!before) { added.push(entry); continue; }
    const fields = [];
    if (before.ok !== entry.ok) fields.push('ok');
    if ((before.method || '') !== (entry.method || '')) fields.push('method');
    if ((before.url || '') !== (entry.url || '')) fields.push('url');
    if ((before.tabId || null) !== (entry.tabId || null)) fields.push('tabId');
    if ((before.sessionId || null) !== (entry.sessionId || null)) fields.push('sessionId');
    if (fields.length) changed.push({ key, fields, before, after: entry });
    else unchanged += 1;
  }
  const removed = [];
  for (const [key, entry] of prevByKey) {
    if (!nextByKey.has(key)) removed.push(entry);
  }
  const prevSessions = new Set((Array.isArray(previous && previous.sessions) ? previous.sessions : sessionsOf(prevEntries, AUDIT_LIMITS.sessions))
    .map((session) => session.sessionId || 'tab-' + session.tabId));
  const nextSessions = new Set((Array.isArray(next && next.sessions) ? next.sessions : sessionsOf(nextEntries, AUDIT_LIMITS.sessions))
    .map((session) => session.sessionId || 'tab-' + session.tabId));
  const sessionsAdded = [...nextSessions].filter((session) => !prevSessions.has(session));
  const sessionsRemoved = [...prevSessions].filter((session) => !nextSessions.has(session));
  const summary = {
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    unchanged,
    sessionsAdded: sessionsAdded.length,
    sessionsRemoved: sessionsRemoved.length,
  };
  return {
    version: AUDIT_JOURNAL_VERSION,
    kind: summary.added + summary.removed + summary.changed === 0 ? 'none' : 'snapshot',
    added: added.slice(0, 100),
    removed: removed.slice(0, 100),
    changed: changed.slice(0, 100),
    unchanged,
    sessions: { added: sessionsAdded, removed: sessionsRemoved },
    summary,
    text: 'audit diff added=' + summary.added + ' removed=' + summary.removed + ' changed=' + summary.changed + ' unchanged=' + summary.unchanged,
  };
}

function journalEventsOf(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter((event) => event && typeof event === 'object');
  if (Array.isArray(input.events)) return input.events.filter((event) => event && typeof event === 'object');
  return [];
}

function journalSessionTabId(sessionId) {
  const match = /^tab:(-?\d+)$/.exec(String(sessionId || ''));
  if (match) return Number(match[1]);
  const dash = /^tab-(-?\d+)$/.exec(String(sessionId || ''));
  return dash ? Number(dash[1]) : null;
}

/**
 * 审计命令 + debug journal 事件 → 统一时间线（升序），并标出时间空洞。
 * @param {object[]} entries
 * @param {{journal?:object|object[]|null, limit?:number, gapMs?:number, now?:number}} [options]
 */
export function buildAuditTimeline(entries, options = {}) {
  const list = normalizedList(entries, options);
  const max = limitOf(options.limit, AUDIT_LIMITS.timeline, 2000);
  const gapMs = Math.max(0, Number(options.gapMs) || 1000);
  const events = [];
  for (const entry of list) {
    if (entry.ts == null) continue;
    events.push({
      kind: 'command',
      at: entry.ts,
      seq: entry.seq,
      commandId: entry.commandId,
      method: entry.method,
      ok: entry.ok,
      sessionId: entry.sessionId,
      tabId: entry.tabId,
      url: entry.url,
    });
  }
  for (const event of journalEventsOf(options.journal)) {
    const at = numberOrNull(event.at != null ? event.at : event.ts);
    if (at === null) continue;
    events.push({
      kind: 'journal',
      at,
      seq: Number.isInteger(Number(event.seq)) ? Number(event.seq) : null,
      type: event.type ? String(event.type) : null,
      sessionId: event.sessionId ? String(event.sessionId) : null,
      tabId: journalSessionTabId(event.sessionId),
    });
  }
  events.sort((a, b) => a.at - b.at || String(a.kind).localeCompare(String(b.kind)));
  const gaps = [];
  for (let index = 1; index < events.length && gaps.length < AUDIT_LIMITS.gaps; index += 1) {
    const delta = events[index].at - events[index - 1].at;
    if (delta >= gapMs) gaps.push({ after: events[index - 1].at, before: events[index].at, ms: delta });
  }
  const counts = { command: 0, journal: 0 };
  for (const event of events) counts[event.kind] = (counts[event.kind] || 0) + 1;
  return {
    version: AUDIT_JOURNAL_VERSION,
    events: events.slice(0, max),
    total: events.length,
    counts,
    gaps,
    range: events.length ? { from: events[0].at, to: events[events.length - 1].at } : null,
    truncated: events.length > max,
  };
}

/**
 * 审计命令 ↔ journal 事件关联：同一 tab 会话、时间窗内的一组事件。
 * @param {object[]} entries
 * @param {object|object[]|null} journal
 * @param {{windowMs?:number, limit?:number}} [options]
 */
export function correlateAuditWithJournal(entries, journal, options = {}) {
  const list = normalizedList(entries, options);
  const events = journalEventsOf(journal).map((event) => ({
    seq: Number.isInteger(Number(event.seq)) ? Number(event.seq) : null,
    type: event.type ? String(event.type) : null,
    at: numberOrNull(event.at != null ? event.at : event.ts),
    sessionId: event.sessionId ? String(event.sessionId) : null,
    tabId: journalSessionTabId(event.sessionId),
  })).filter((event) => event.at !== null);
  const windowMs = Math.max(0, Number(options.windowMs) || AUDIT_LIMITS.correlationWindowMs);
  const maxLinks = limitOf(options.limit, AUDIT_LIMITS.links, 1000);
  const links = [];
  let unlinked = 0;
  for (const entry of list) {
    if (entry.ts == null) { unlinked += 1; continue; }
    const tabCandidates = events.filter((event) => (
      (entry.tabId != null && event.tabId === entry.tabId)
      || (entry.sessionId && event.sessionId === entry.sessionId)
    ) && Math.abs(event.at - entry.ts) <= windowMs);
    if (!tabCandidates.length) { unlinked += 1; continue; }
    if (links.length >= maxLinks) continue;
    const closest = tabCandidates.slice().sort((a, b) => Math.abs(a.at - entry.ts) - Math.abs(b.at - entry.ts))[0];
    links.push({
      commandId: entry.commandId,
      method: entry.method,
      at: entry.ts,
      tabId: entry.tabId,
      sessionId: entry.sessionId,
      journal: closest,
      deltaMs: closest ? Math.round(closest.at - entry.ts) : null,
      candidates: tabCandidates.length,
    });
  }
  const byMethod = {};
  for (const link of links) {
    if (!link.method) continue;
    byMethod[link.method] = (byMethod[link.method] || 0) + 1;
  }
  return {
    version: AUDIT_JOURNAL_VERSION,
    links,
    unlinked,
    total: list.length,
    linked: links.length,
    byMethod,
    windowMs,
    journal: { events: events.length, sessions: new Set(events.map((event) => event.sessionId).filter(Boolean)).size },
  };
}

/** 快照的一行摘要（审计页/诊断用）。 */
export function summarizeAuditSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    version: snapshot.version || AUDIT_JOURNAL_VERSION,
    id: snapshot.id || null,
    label: snapshot.label || null,
    createdAt: Number(snapshot.createdAt) || null,
    total: Number(snapshot.total) || 0,
    sessions: Number(snapshot.counts && snapshot.counts.sessions) || 0,
    ok: Number(snapshot.counts && snapshot.counts.ok) || 0,
    failed: Number(snapshot.counts && snapshot.counts.failed) || 0,
    unknown: Number(snapshot.counts && snapshot.counts.unknown) || 0,
    seqRange: snapshot.seqRange || null,
    timeRange: snapshot.timeRange || null,
    digest: snapshot.digest || null,
  };
}

/** 差异的一行摘要（audit list --diff / 诊断）。 */
export function describeAuditDiff(diff) {
  if (!diff || typeof diff !== 'object') return '';
  const summary = diff.summary || {};
  const parts = ['audit diff added=' + (Number(summary.added) || 0) + ' removed=' + (Number(summary.removed) || 0) + ' changed=' + (Number(summary.changed) || 0)];
  if (Number(summary.sessionsAdded) > 0) parts.push('sessions+=' + Number(summary.sessionsAdded));
  if (Number(summary.sessionsRemoved) > 0) parts.push('sessions-=' + Number(summary.sessionsRemoved));
  if (diff.kind === 'none') parts.push('none');
  if (diff.kind === 'incomparable') parts.push('incomparable:' + (diff.reason || 'unknown'));
  return parts.join(' ');
}

/** 时间线的一行摘要。 */
export function describeAuditTimeline(timeline) {
  if (!timeline || typeof timeline !== 'object') return '';
  const counts = timeline.counts || {};
  const range = timeline.range || {};
  const parts = ['timeline events=' + (Number(timeline.total) || 0) + ' command=' + (Number(counts.command) || 0) + ' journal=' + (Number(counts.journal) || 0)];
  if (range.from != null && range.to != null) parts.push('span=' + Math.max(0, Number(range.to) - Number(range.from)) + 'ms');
  if (Array.isArray(timeline.gaps) && timeline.gaps.length) parts.push('gaps=' + timeline.gaps.length);
  if (timeline.truncated) parts.push('truncated');
  return parts.join(' ');
}

export function auditJournalVersion() {
  return AUDIT_JOURNAL_VERSION;
}
