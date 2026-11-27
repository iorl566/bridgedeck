// audit 证据完整性：必填字段 / 序列 / 时间戳 / commandId / 证据覆盖 / 快照 digest / journal 关联。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_INTEGRITY_VERSION,
  renderAuditIntegrityText,
  summarizeAuditIntegrity,
  verifyAuditEntries,
  verifyAuditSnapshot,
} from '../../extension/src/audit-integrity.js';
import { buildAuditSnapshot } from '../../extension/src/audit-journal.js';

const now = 1_700_000_000_000;

function healthy(overrides = {}) {
  return {
    ts: now - 1000,
    seq: 1,
    commandId: 'c1',
    method: 'observe',
    tabId: 5,
    sessionId: 's1',
    ok: true,
    durationMs: 12,
    url: 'https://example.test/',
    ...overrides,
  };
}

function checkByName(report, name) {
  return report.checks.find((item) => item.name === name);
}

test('健康条目：verified=true，所有 check 通过，覆盖率 100%', () => {
  const report = verifyAuditEntries([healthy(), healthy({ seq: 2, commandId: 'c2', method: 'click', ts: now - 500 })], { now });
  assert.equal(report.version, AUDIT_INTEGRITY_VERSION);
  assert.equal(report.ok, true);
  assert.equal(report.verified, true);
  assert.equal(report.counts.entries, 2);
  assert.equal(report.counts.errors, 0);
  for (const check of report.checks) assert.equal(check.status, 'ok', check.name + ': ' + check.detail);
  assert.equal(report.coverage.ratios.ts, 1);
  assert.equal(report.coverage.ratios.ok, 1);
  assert.equal(report.coverage.ratios.commandId, 1);
  assert.match(report.text, /audit integrity entries=2/);
  assert.match(report.text, /all checks ok/);
  const summary = summarizeAuditIntegrity(report);
  assert.equal(summary.verified, true);
  assert.equal(summary.counts.entries, 2);
});

test('必填字段/结构损坏：error 级 issue，verified=false 且不补造', () => {
  const report = verifyAuditEntries([
    { ts: null, method: null, commandId: 'c1' },
    'corrupt-entry',
    healthy({ seq: 2, commandId: 'c2' }),
  ], { now });
  assert.equal(report.verified, false);
  assert.ok(report.counts.errors >= 3);
  const required = checkByName(report, 'required-fields');
  assert.equal(required.status, 'error');
  assert.ok(required.count >= 2);
  const structure = checkByName(report, 'structure');
  assert.equal(structure.status, 'error');
  const issues = report.issues.filter((issue) => issue.code === 'required-field-missing');
  assert.ok(issues.some((issue) => issue.missing.includes('ts')));
  assert.ok(issues.some((issue) => issue.missing.includes('method')));
  assert.ok(report.issues.some((issue) => issue.code === 'corrupt-entry'));
  assert.match(renderAuditIntegrityText(report), /\[error\] required-fields/);
});

test('序列：重复 seq 是 error，断层是 warn，缺失 seq 有覆盖率标注', () => {
  const duplicate = verifyAuditEntries([
    healthy({ seq: 1, commandId: 'c1' }),
    healthy({ seq: 1, commandId: 'c2', ts: now - 500 }),
  ], { now });
  assert.equal(duplicate.verified, false);
  assert.ok(duplicate.issues.some((issue) => issue.code === 'sequence-duplicate'));
  const gap = verifyAuditEntries([
    healthy({ seq: 1, commandId: 'c1' }),
    healthy({ seq: 4, commandId: 'c2', ts: now - 500 }),
  ], { now });
  assert.equal(gap.verified, true, '断层只是 warn');
  assert.ok(gap.issues.some((issue) => issue.code === 'sequence-gap'));
  const missingSeq = verifyAuditEntries([{ ...healthy(), seq: undefined, commandId: 'c9' }], { now });
  assert.ok(missingSeq.issues.some((issue) => issue.code === 'sequence-missing'));
  assert.ok(missingSeq.coverage.ratios.seq < 1);
});

test('时间戳/commandId/证据覆盖：未来时间、重复 commandId、缺 ok/会话', () => {
  const report = verifyAuditEntries([
    healthy({ ts: now + 120_000, seq: 1, commandId: 'dup', ok: null, sessionId: null, tabId: null, durationMs: null }),
    healthy({ ts: now - 3000, seq: 2, commandId: 'dup', ok: null, sessionId: null, tabId: null }),
  ], { now });
  assert.equal(report.verified, true, '未来时间/缺证据只算 warn');
  assert.ok(report.issues.some((issue) => issue.code === 'timestamp-future'));
  assert.ok(report.issues.some((issue) => issue.code === 'command-id-duplicate'));
  assert.ok(report.issues.some((issue) => issue.code === 'outcome-missing'));
  assert.ok(report.issues.some((issue) => issue.code === 'session-missing'));
  assert.ok(report.issues.some((issue) => issue.code === 'duration-missing'));
  const outcome = checkByName(report, 'outcome-evidence');
  assert.equal(outcome.severity, 'warn');
  assert.ok(outcome.count >= 2);
  assert.equal(report.coverage.fields.ok, 0);
  assert.equal(report.coverage.ratios.ok, 0);
});

test('快照 digest：一致 ok，篡改后 mismatch error', () => {
  const entries = [healthy(), healthy({ seq: 2, commandId: 'c2', ts: now - 500, method: 'click' })];
  const snapshot = buildAuditSnapshot(entries, { createdAt: now });
  const good = verifyAuditSnapshot(snapshot);
  assert.equal(good.ok, true);
  assert.equal(good.reason, null);
  assert.equal(good.expected, snapshot.digest);
  const tampered = JSON.parse(JSON.stringify(snapshot));
  tampered.entries[0].ok = false;
  const bad = verifyAuditSnapshot(tampered);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'digest-mismatch');
  const report = verifyAuditEntries(entries, { now, snapshot: tampered });
  assert.equal(report.verified, false);
  assert.ok(report.issues.some((issue) => issue.code === 'snapshot-digest-mismatch'));
  const missing = verifyAuditEntries(entries, { now, snapshot: {} });
  assert.ok(missing.snapshot && missing.snapshot.ok === false);
});

test('journal 关联覆盖：linked/unlinked 只做覆盖统计', () => {
  const journal = { events: [{ seq: 1, sessionId: 'tab-5', at: now - 1000, type: 'start' }, { seq: 2, sessionId: 'tab-5', at: now - 60_000, type: 'stop' }] };
  const report = verifyAuditEntries([
    healthy({ ts: now - 1000, seq: 1, commandId: 'c1' }),
    healthy({ ts: now - 200_000, seq: 2, commandId: 'c2', method: 'click' }),
  ], { now, journal });
  assert.ok(report.coverage.journal);
  assert.equal(report.coverage.journal.linked, 1);
  assert.equal(report.coverage.journal.unlinked, 1);
  assert.equal(checkByName(report, 'journal-link').severity, 'info');
  assert.equal(report.verified, true, '关联不上不是完整性失败');
});

test('容量与空输入：capacity warning、空数组 verified=true', () => {
  const report = verifyAuditEntries([healthy()], { now, capacity: 1 });
  assert.equal(checkByName(report, 'capacity').status, 'warn');
  assert.equal(report.verified, true, '环形缓冲满只提示可能丢失最早记录');
  const empty = verifyAuditEntries([], { now });
  assert.equal(empty.verified, true);
  assert.equal(empty.counts.entries, 0);
  assert.match(renderAuditIntegrityText(empty), /all checks ok/);
});
