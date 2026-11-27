// audit journal：条目归一化 / 快照 / 差异 / 时间线 / journal 关联（纯函数层）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_JOURNAL_VERSION,
  auditDigest,
  buildAuditSnapshot,
  buildAuditTimeline,
  correlateAuditWithJournal,
  describeAuditDiff,
  describeAuditTimeline,
  diffAuditSnapshots,
  normalizeAuditEntry,
  stableStringify,
  summarizeAuditSnapshot,
} from '../../extension/src/audit-journal.js';

const entry = (overrides = {}) => ({
  ts: 1000,
  commandId: 'c1',
  method: 'observe',
  tabId: 5,
  sessionId: 's1',
  url: 'https://example.test/',
  ...overrides,
});

test('normalizeAuditEntry：保留原字段、补 seq/证据，缺 ok/durationMs 就保持缺失', () => {
  const normalized = normalizeAuditEntry(entry());
  assert.equal(normalized.version, AUDIT_JOURNAL_VERSION);
  assert.equal(normalized.ts, 1000);
  assert.equal(normalized.method, 'observe');
  assert.equal(normalized.ok, null);
  assert.ok(normalized.evidence.missing.includes('ok'));
  assert.ok(normalized.evidence.missing.includes('durationMs'));
  const withOutcome = normalizeAuditEntry(entry({ ok: false, durationMs: 12, code: 'E_FAIL' }), { seq: 7 });
  assert.equal(withOutcome.ok, false);
  assert.equal(withOutcome.durationMs, 12);
  assert.equal(withOutcome.seq, 7);
  assert.ok(!withOutcome.evidence.missing.includes('ok'));
  // 非法输入不抛异常
  const broken = normalizeAuditEntry('oops');
  assert.equal(broken.ts, null);
  assert.equal(broken.method, null);
});

test('stableStringify / auditDigest：键序无关、可重复', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(auditDigest({ a: 1, b: 2 }), auditDigest({ b: 2, a: 1 }));
  assert.notEqual(auditDigest({ a: 1 }), auditDigest({ a: 2 }));
  assert.match(auditDigest({ a: 1 }), /^ad-/);
});

test('buildAuditSnapshot：跨会话分组、时间/seq 范围、digest 可复算', () => {
  const entries = [
    entry({ ts: 1000, commandId: 'c1', seq: 1 }),
    entry({ ts: 2000, commandId: 'c2', sessionId: 's2', tabId: 6, seq: 2, ok: true }),
    entry({ ts: 1500, commandId: 'c3', sessionId: null, tabId: null, seq: 3 }),
  ];
  const snapshot = buildAuditSnapshot(entries, { createdAt: 9, label: 'baseline' });
  assert.equal(snapshot.kind, 'audit-snapshot');
  assert.equal(snapshot.label, 'baseline');
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.counts.sessions, 3);
  assert.equal(snapshot.counts.ok, 1);
  assert.equal(snapshot.counts.unknown, 2);
  assert.deepEqual(snapshot.seqRange, { from: 1, to: 3 });
  assert.deepEqual(snapshot.timeRange, { from: 1000, to: 2000 });
  assert.equal(snapshot.entries[0].ts, 1000, '快照内条目按 ts 升序');
  assert.match(snapshot.digest, /^ad-/);
  const again = buildAuditSnapshot(entries, { createdAt: 10 });
  assert.equal(again.digest, snapshot.digest, 'digest 不依赖 createdAt');
  const summary = summarizeAuditSnapshot(snapshot);
  assert.equal(summary.total, 3);
  assert.equal(summary.sessions, 3);
  assert.equal(summary.digest, snapshot.digest);
});

test('diffAuditSnapshots：新增/消失/变更/会话增删', () => {
  const before = buildAuditSnapshot([
    entry({ ts: 1000, commandId: 'c1', seq: 1, ok: true }),
    entry({ ts: 2000, commandId: 'c2', sessionId: 's2', tabId: 6, seq: 2 }),
  ]);
  const after = buildAuditSnapshot([
    entry({ ts: 1000, commandId: 'c1', seq: 1, ok: false }),
    entry({ ts: 3000, commandId: 'c3', seq: 3, sessionId: 's3', tabId: 7 }),
  ]);
  const diff = diffAuditSnapshots(before, after);
  assert.equal(diff.kind, 'snapshot');
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.changed, 1);
  assert.equal(diff.changed[0].fields.includes('ok'), true);
  assert.deepEqual(diff.sessions.added, ['s3']);
  assert.deepEqual(diff.sessions.removed, ['s2']);
  assert.match(describeAuditDiff(diff), /audit diff added=1 removed=1 changed=1/);
  const same = diffAuditSnapshots(before, before);
  assert.equal(same.kind, 'none');
  assert.equal(same.summary.unchanged, 2);
  const incomparable = diffAuditSnapshots(null, after);
  assert.equal(incomparable.kind, 'incomparable');
  assert.equal(incomparable.reason, 'previous-missing');
  // 裸 entries 也接受
  const raw = diffAuditSnapshots([entry({ ts: 1000, commandId: 'c1', ok: true })], [entry({ ts: 1000, commandId: 'c1', ok: true })]);
  assert.equal(raw.kind, 'none');
});

test('buildAuditTimeline：命令 + journal 合并升序，标出时间空洞', () => {
  const journal = {
    events: [
      { seq: 1, sessionId: 'tab-5', at: 1200, type: 'start' },
      { seq: 2, sessionId: 'tab-5', at: 4000, type: 'stop' },
    ],
  };
  const timeline = buildAuditTimeline([
    entry({ ts: 1000, commandId: 'c1' }),
    entry({ ts: 3000, commandId: 'c2' }),
  ], { journal, gapMs: 500 });
  assert.equal(timeline.total, 4);
  assert.equal(timeline.counts.command, 2);
  assert.equal(timeline.counts.journal, 2);
  assert.deepEqual(timeline.events.map((event) => event.at), [1000, 1200, 3000, 4000]);
  assert.ok(timeline.gaps.length >= 1);
  assert.deepEqual(timeline.range, { from: 1000, to: 4000 });
  assert.match(describeAuditTimeline(timeline), /timeline events=4/);
  const limited = buildAuditTimeline([entry({ ts: 1000 })], { journal, limit: 1 });
  assert.equal(limited.events.length, 1);
  assert.equal(limited.truncated, true);
});

test('correlateAuditWithJournal：同 tab/会话 + 时间窗关联，未关联如实计数', () => {
  const journal = {
    events: [
      { seq: 1, sessionId: 'tab-5', at: 1100, type: 'start' },
      { seq: 2, sessionId: 'tab-6', at: 1150, type: 'start' },
    ],
  };
  const correlation = correlateAuditWithJournal([
    entry({ ts: 1000, commandId: 'c1', tabId: 5 }),
    entry({ ts: 1000, commandId: 'c2', tabId: 5, sessionId: 's1' }),
    entry({ ts: 9000, commandId: 'c3', tabId: 5 }),
  ], journal, { windowMs: 500 });
  assert.equal(correlation.total, 3);
  assert.equal(correlation.linked, 2);
  assert.equal(correlation.unlinked, 1);
  assert.equal(correlation.links[0].journal.sessionId, 'tab-5');
  assert.equal(correlation.links[0].deltaMs, 100);
  assert.equal(correlation.byMethod.observe, 2);
  assert.equal(correlation.windowMs, 500);
});
