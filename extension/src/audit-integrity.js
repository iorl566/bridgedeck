// src/audit-integrity.js —— 审计证据完整性校验（纯函数，不读 chrome.storage）。
//
// 审计条目的价值在于“能证明发生过什么”。缺字段时**如实标注**并给出缺什么，
// 绝不补造 ok / durationMs / sessionId / url，也不把“没记录”解释成“成功”。
//
// 校验分三层：
//   1) 条目级：必填字段（ts/method）、命令 id、结果/耗时/会话/URL 证据覆盖，
//      以及条目结构损坏；
//   2) 序列级：seq 重复/断层（环形缓冲淘汰会造成断层，标 warn 而不是 error）、
//      时间戳非法/未来时间、commandId 重复；
//   3) 快照级：重算快照 digest 与存储值比对（verifyAuditSnapshot），不一致即 error；
//   4) 关联级：有 journal 事件时统计“能关联 / 关联不上”，关联不上只算 info。
//
// 输出 { verified, ok, checks, issues, counts, coverage, text }，可直接进诊断/审计页。

import { AUDIT_JOURNAL_VERSION, auditDigest, buildAuditSnapshot, normalizeAuditEntry, stableStringify } from './audit-journal.js';

export const AUDIT_INTEGRITY_VERSION = 1;

export const AUDIT_SEVERITY = Object.freeze({ error: 'error', warn: 'warn', info: 'info' });

export const AUDIT_INTEGRITY_CHECKS = Object.freeze([
  'structure',
  'required-fields',
  'sequence',
  'timestamps',
  'command-ids',
  'outcome-evidence',
  'session-evidence',
  'url-evidence',
  'capacity',
  'journal-link',
  'snapshot-digest',
]);

const REQUIRED_FIELDS = Object.freeze(['ts', 'method']);
const EVIDENCE_FIELDS = Object.freeze(['ts', 'method', 'commandId', 'ok', 'durationMs', 'sessionId', 'tabId', 'url', 'seq']);

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sampleOf(list, max) {
  return list.slice(0, max);
}

function check(name, severity, count, detail, samples = []) {
  return {
    name,
    severity,
    status: count === 0 ? 'ok' : severity,
    count,
    detail,
    ...(samples.length ? { samples: sampleOf(samples, 5) } : {}),
  };
}

/**
 * 校验一组审计条目。
 * @param {object[]} entries
 * @param {{journal?:object|object[]|null, now?:number, capacity?:number, snapshot?:object|null, limit?:number}} [options]
 */
export function verifyAuditEntries(entries, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Math.round(Number(options.now)) : Date.now();
  const capacity = limitOf(options.capacity, 500, 5000);
  const max = limitOf(options.limit, 500, 5000);
  const raw = Array.isArray(entries) ? entries.slice(0, max) : [];
  const normalized = raw.map((entry, index) => ({ raw: entry, entry: normalizeAuditEntry(entry, { index }), index }));

  const issues = [];
  const pushIssue = (code, severity, record, detail, missing = null) => {
    issues.push({
      code,
      severity,
      index: record ? record.index : null,
      commandId: record && record.entry ? record.entry.commandId : null,
      method: record && record.entry ? record.entry.method : null,
      ...(detail ? { detail: String(detail).slice(0, 240) } : {}),
      ...(missing ? { missing } : {}),
    });
  };

  // 1) 结构损坏：非对象条目（数组里出现字符串/数字说明存储被污染）。
  const corrupt = normalized.filter((record) => !isPlainObject(record.raw));
  for (const record of corrupt) pushIssue('corrupt-entry', 'error', record, typeof record.raw);

  // 2) 必填字段。
  const missingRequired = { ts: [], method: [] };
  for (const record of normalized) {
    if (!isPlainObject(record.raw)) continue;
    for (const field of REQUIRED_FIELDS) {
      if (record.entry[field] === null || record.entry[field] === undefined) {
        missingRequired[field].push(record);
        pushIssue('required-field-missing', 'error', record, field, [field]);
      }
    }
  }

  // 3) seq 重复 / 断层。
  const seqRecords = normalized.filter((record) => Number.isInteger(record.entry.seq) && record.entry.seq >= 0);
  const seqSeen = new Map();
  const seqDuplicates = [];
  for (const record of seqRecords) {
    const seq = record.entry.seq;
    if (seqSeen.has(seq)) {
      seqDuplicates.push({ seq, records: [seqSeen.get(seq), record] });
      pushIssue('sequence-duplicate', 'error', record, 'seq=' + seq);
    } else {
      seqSeen.set(seq, record);
    }
  }
  const seqGaps = [];
  if (seqRecords.length >= 2) {
    const values = [...new Set(seqRecords.map((record) => record.entry.seq))].sort((a, b) => a - b);
    for (let index = 1; index < values.length; index += 1) {
      const delta = values[index] - values[index - 1];
      if (delta > 1) seqGaps.push({ after: values[index - 1], before: values[index], missing: delta - 1 });
    }
  }
  const seqCoverage = normalized.length ? seqRecords.length / normalized.length : 0;
  if (normalized.length && seqCoverage < 1) {
    pushIssue('sequence-missing', 'warn', null, Math.round((1 - seqCoverage) * 100) + '% entries without seq', ['seq']);
  }
  for (const gap of seqGaps.slice(0, 20)) {
    issues.push({ code: 'sequence-gap', severity: 'warn', index: null, commandId: null, method: null, detail: 'seq ' + gap.after + '→' + gap.before + ' 缺 ' + gap.missing, missing: [] });
  }

  // 4) 时间戳：非法/未来。
  const futureTimestamps = normalized.filter((record) => record.entry.ts !== null && record.entry.ts > now + 60_000);
  for (const record of futureTimestamps) pushIssue('timestamp-future', 'warn', record, 'ts=' + record.entry.ts + ' now=' + now);
  const duplicateTimestamps = new Map();
  for (const record of normalized) {
    if (record.entry.ts === null) continue;
    const key = record.entry.ts + '\u0000' + (record.entry.method || '');
    duplicateTimestamps.set(key, (duplicateTimestamps.get(key) || 0) + 1);
  }

  // 5) commandId 重复/缺失。
  const commandIds = new Map();
  let missingCommandIds = 0;
  for (const record of normalized) {
    if (!isPlainObject(record.raw)) continue;
    const commandId = record.entry.commandId;
    if (!commandId) { missingCommandIds += 1; continue; }
    const list = commandIds.get(commandId) || [];
    list.push(record);
    commandIds.set(commandId, list);
  }
  const duplicateCommandIds = [...commandIds.entries()].filter(([, list]) => list.length > 1);
  for (const [commandId, list] of duplicateCommandIds.slice(0, 20)) {
    pushIssue('command-id-duplicate', 'warn', list[1], commandId);
  }
  if (missingCommandIds) pushIssue('command-id-missing', 'warn', null, missingCommandIds + ' entries without commandId', ['commandId']);

  // 6) 证据覆盖（ok / durationMs / session / tab / url）。
  const coverage = {};
  for (const field of EVIDENCE_FIELDS) coverage[field] = 0;
  let outcomeMissing = 0;
  let durationMissing = 0;
  let sessionMissing = 0;
  let urlMissing = 0;
  for (const record of normalized) {
    if (!isPlainObject(record.raw)) continue;
    const entry = record.entry;
    for (const field of EVIDENCE_FIELDS) {
      if (field === 'seq') { if (Number.isInteger(entry.seq)) coverage.seq += 1; continue; }
      if (entry[field] !== null && entry[field] !== undefined && entry[field] !== '') coverage[field] += 1;
    }
    if (entry.ok === null) { outcomeMissing += 1; pushIssue('outcome-missing', 'warn', record, null, ['ok']); }
    if (entry.durationMs === null) { durationMissing += 1; pushIssue('duration-missing', 'info', record, null, ['durationMs']); }
    if (!entry.sessionId && entry.tabId === null) { sessionMissing += 1; pushIssue('session-missing', 'warn', record, null, ['sessionId', 'tabId']); }
    if (!entry.url) urlMissing += 1;
  }
  if (urlMissing) pushIssue('url-missing', 'info', null, urlMissing + ' entries without url', ['url']);

  // 7) 环形缓冲容量：满了意味着最早条目可能已被淘汰（快照不再代表全量）。
  const capacityHit = normalized.length >= capacity;

  // 8) journal 关联覆盖（只统计，不判失败）。
  let journalLinked = null;
  let journalUnlinked = null;
  if (options.journal) {
    const events = Array.isArray(options.journal) ? options.journal : (Array.isArray(options.journal.events) ? options.journal.events : []);
    const eventTimes = events.map((event) => numberOrNull(event && (event.at != null ? event.at : event.ts))).filter((value) => value !== null).sort((a, b) => a - b);
    if (eventTimes.length) {
      journalLinked = 0;
      journalUnlinked = 0;
      for (const record of normalized) {
        const at = record.entry.ts;
        if (at === null) { journalUnlinked += 1; continue; }
        let best = Infinity;
        for (const eventAt of eventTimes) best = Math.min(best, Math.abs(eventAt - at));
        if (best <= 2000) journalLinked += 1;
        else journalUnlinked += 1;
      }
    }
  }

  // 9) 快照 digest 校验。
  let snapshotCheck = null;
  if (options.snapshot && typeof options.snapshot === 'object') {
    snapshotCheck = verifyAuditSnapshot(options.snapshot);
    if (snapshotCheck.ok === false) {
      issues.push({ code: 'snapshot-digest-mismatch', severity: 'error', index: null, commandId: null, method: null, detail: 'stored digest != recomputed digest', missing: [] });
    }
  }

  const checks = [
    check('structure', 'error', corrupt.length, '非对象条目：' + corrupt.length, corrupt.map((record) => String(record.raw).slice(0, 60))),
    check('required-fields', 'error', missingRequired.ts.length + missingRequired.method.length, 'ts 缺 ' + missingRequired.ts.length + '，method 缺 ' + missingRequired.method.length),
    check('sequence', 'warn', seqDuplicates.length + seqGaps.length + (seqCoverage < 1 && normalized.length ? 1 : 0), 'seq 重复 ' + seqDuplicates.length + '，断层 ' + seqGaps.length + '，缺 seq ' + (normalized.length - seqRecords.length)),
    check('timestamps', 'warn', futureTimestamps.length, '未来时间戳 ' + futureTimestamps.length + '，重复 (ts,method) ' + [...duplicateTimestamps.values()].filter((count) => count > 1).length),
    check('command-ids', 'warn', duplicateCommandIds.length + (missingCommandIds ? 1 : 0), '重复 ' + duplicateCommandIds.length + '，缺失 ' + missingCommandIds),
    check('outcome-evidence', 'warn', outcomeMissing, '缺 ok（结果不可验证）' + outcomeMissing),
    check('session-evidence', 'warn', sessionMissing, '缺 sessionId/tabId ' + sessionMissing),
    check('url-evidence', 'info', urlMissing, '缺 url ' + urlMissing),
    check('capacity', 'warn', capacityHit ? 1 : 0, '容量 ' + capacity + '，当前 ' + normalized.length),
    check('journal-link', 'info', journalUnlinked === null ? 0 : journalUnlinked, journalLinked === null ? '未提供 journal' : '关联 ' + journalLinked + ' / 未关联 ' + journalUnlinked),
    check('snapshot-digest', 'error', snapshotCheck && snapshotCheck.ok === false ? 1 : 0, snapshotCheck ? (snapshotCheck.ok ? 'digest 一致' : 'digest 不一致') : '未提供快照'),
  ];
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warn').length;
  const infos = issues.filter((issue) => issue.severity === 'info').length;
  return {
    version: AUDIT_INTEGRITY_VERSION,
    journalVersion: AUDIT_JOURNAL_VERSION,
    verified: errors === 0,
    ok: errors === 0,
    checks,
    issues: issues.slice(0, 200),
    counts: { entries: normalized.length, errors, warnings, infos, checks: checks.length },
    coverage: {
      fields: coverage,
      ratios: Object.fromEntries(Object.entries(coverage).map(([field, count]) => [field, normalized.length ? Math.round((count / normalized.length) * 1000) / 1000 : 0])),
      journal: journalLinked === null ? null : { linked: journalLinked, unlinked: journalUnlinked },
    },
    snapshot: snapshotCheck ? { ok: snapshotCheck.ok, id: options.snapshot.id || null, expected: snapshotCheck.expected || null, actual: snapshotCheck.actual || null } : null,
    text: renderAuditIntegrityText({ checks, counts: { entries: normalized.length, errors, warnings, infos } }),
  };
}

/** 只校验快照自身的 digest（重算 entries 的 digest 与存储值比对）。 */
export function verifyAuditSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { version: AUDIT_INTEGRITY_VERSION, ok: false, reason: 'snapshot-missing', expected: null, actual: null };
  }
  if (!Array.isArray(snapshot.entries)) {
    return { version: AUDIT_INTEGRITY_VERSION, ok: false, reason: 'snapshot-entries-missing', expected: snapshot.digest || null, actual: null };
  }
  const rebuilt = buildAuditSnapshot(snapshot.entries, { createdAt: snapshot.createdAt, label: snapshot.label, limit: snapshot.entries.length });
  const expected = snapshot.digest || null;
  return {
    version: AUDIT_INTEGRITY_VERSION,
    ok: expected !== null && expected === rebuilt.digest,
    reason: expected === null ? 'digest-missing' : expected === rebuilt.digest ? null : 'digest-mismatch',
    expected,
    actual: rebuilt.digest,
    // 快照内容本身也回带（供 diff 复核），但不写入 storage。
    snapshot: rebuilt,
    digestInput: buildDigestInput(rebuilt),
  };
}

function buildDigestInput(snapshot) {
  return {
    sessions: (snapshot.sessions || []).map((session) => [session.sessionId, session.tabId, session.entries]),
    commands: (snapshot.entries || []).map((entry) => [entry.ts, entry.method, entry.commandId, entry.ok]),
  };
}

/** 多行文本（审计页/CLI 诊断直接打印）。 */
export function renderAuditIntegrityText(report) {
  if (!report || typeof report !== 'object') return '';
  const counts = report.counts || {};
  const lines = [
    'audit integrity entries=' + (counts.entries || 0) + ' errors=' + (counts.errors || 0) + ' warnings=' + (counts.warnings || 0) + ' infos=' + (counts.infos || 0),
  ];
  for (const item of Array.isArray(report.checks) ? report.checks : []) {
    if (item.status === 'ok') continue;
    lines.push('- [' + item.severity + '] ' + item.name + ': ' + item.detail);
  }
  if (lines.length === 1) lines.push('all checks ok');
  return lines.join('\n');
}

/** 审计条目数量 + 覆盖率的极简摘要（observe/诊断可复用）。 */
export function summarizeAuditIntegrity(report) {
  if (!report || typeof report !== 'object') return null;
  return {
    version: report.version || AUDIT_INTEGRITY_VERSION,
    verified: report.verified === true,
    counts: { ...(report.counts || {}) },
    coverage: report.coverage && report.coverage.ratios ? { ...report.coverage.ratios } : null,
  };
}

export function auditIntegrityVersion() {
  return AUDIT_INTEGRITY_VERSION;
}

// 供测试/诊断复核稳定序列化：digest 的可重复性依赖它。
export { stableStringify, auditDigest };
