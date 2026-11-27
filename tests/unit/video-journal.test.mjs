import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNAL_ACTION_LIST,
  JOURNAL_CODES,
  JOURNAL_DEFAULTS,
  JOURNAL_STATE_LIST,
  JOURNAL_VERSION,
  appendEntry,
  createJournal,
  describeJournal,
  journalChainDigest,
  journalDigestOf,
  journalEntryCanonical,
  journalFromRecord,
  journalPartKey,
  journalPartKeys,
  journalRecordFields,
  mergeJournals,
  normalizeJournalEntry,
  replayJournal,
  resumeJournal,
  sealJournal,
  summarizeJournal,
  validateJournal,
} from '../../extension/src/lib/video-journal.js';

const NOW = 1_700_000_000_000;

function entriesOf(count, { bytes = 1024, start = 0 } = {}) {
  return Array.from({ length: count }, (_, offset) => ({
    sequence: start + offset,
    index: offset,
    bytes,
    hash: ('hash' + offset).padEnd(16, '0'),
    tMs: offset * 2000,
    durationMs: 2000,
    frames: 30,
  }));
}

function journalWith(count, options = {}) {
  let journal = createJournal({ recordingId: 'rec-1', now: NOW, mime: 'video/mp4', budget: { maxTotalBytes: 1e9 } });
  for (const entry of entriesOf(count, options)) {
    journal = appendEntry(journal, entry, { now: NOW }).journal;
  }
  return journal;
}

test('createJournal：结构/初始状态/必需入参', () => {
  const journal = createJournal({ recordingId: 'r1', now: NOW, mime: 'video/mp4', mode: 'tabCapture' });
  assert.equal(journal.version, JOURNAL_VERSION);
  assert.equal(journal.state, 'open');
  assert.equal(journal.recordingId, 'r1');
  assert.deepEqual(journal.entries, []);
  assert.equal(journal.totalBytes, 0);
  assert.equal(journal.nextSequence, 0);
  assert.equal(journal.createdAt, new Date(NOW).toISOString());
  assert.throws(() => createJournal({}), /recordingId/);
  assert.deepEqual(JOURNAL_STATE_LIST, ['open', 'sealing', 'sealed', 'recovered', 'failed']);
});

test('journalPartKey / journalEntryCanonical / journalDigestOf：稳定键与规范串', () => {
  assert.equal(journalPartKey(7), 'part-000007');
  assert.equal(journalPartKey(-1), 'part-000000');
  const canonical = journalEntryCanonical({ sequence: 0, index: 0, bytes: 10, hash: 'AB', tMs: 0, durationMs: 100, frames: 3, key: 'part-000000' });
  assert.equal(canonical, '0|0|10|ab|0|100|3|part-000000');
  assert.equal(journalDigestOf('x'), journalDigestOf('x'));
  assert.equal(journalDigestOf('x').length, 16);
  assert.notEqual(journalDigestOf('x'), journalDigestOf('y'));
  assert.equal(journalDigestOf(null), journalDigestOf(''));
});

test('appendEntry：追加更新链摘要/序号/字节', () => {
  const journal = journalWith(3);
  assert.equal(journal.entries.length, 3);
  assert.equal(journal.nextSequence, 3);
  assert.equal(journal.totalBytes, 3072);
  assert.deepEqual(journal.indexes, [0, 1, 2]);
  assert.equal(journal.chain.length, 16);
  assert.equal(journal.chain, journalChainDigest(journal));
  assert.equal(journal.updatedAt, new Date(NOW).toISOString());
});

test('appendEntry：幂等（同 sequence 重复 → duplicate，不重复计数）', () => {
  const journal = journalWith(2);
  const result = appendEntry(journal, { sequence: 1, index: 1, bytes: 999, hash: 'x' }, { now: NOW });
  assert.equal(result.duplicate, true);
  assert.equal(result.accepted, false);
  assert.equal(result.code, JOURNAL_CODES.ENTRY_DUPLICATE);
  assert.equal(result.journal, journal);
  assert.equal(result.entry.sequence, 1);
});

test('appendEntry：序号倒退/超量/字节溢出/已封版都拒绝并给码', () => {
  const journal = journalWith(3);
  // 先造一个带空洞的日记（sequence 0、3），再追加 2 → 不是重复但小于最大序号 → 倒退
  let sparse = createJournal({ recordingId: 'r', now: NOW });
  sparse = appendEntry(sparse, { sequence: 0, index: 0, bytes: 10, hash: 'h0' }, { now: NOW }).journal;
  sparse = appendEntry(sparse, { sequence: 3, index: 3, bytes: 10, hash: 'h3' }, { now: NOW }).journal;
  const backwards = appendEntry(sparse, { sequence: 2, index: 2, bytes: 10, hash: 'h2' }, { now: NOW });
  assert.equal(backwards.code, JOURNAL_CODES.ENTRY_SEQUENCE_BACKWARDS);
  const overflow = appendEntry(journal, { sequence: 3, index: 9, bytes: 1024, hash: 'h9' }, { now: NOW, maxEntries: 3 });
  assert.equal(overflow.code, JOURNAL_CODES.ENTRIES_OVERFLOW);
  const bytes = appendEntry(journal, { sequence: 3, index: 9, bytes: 1024, hash: 'h9' }, { now: NOW, maxBytes: 1000 });
  assert.equal(bytes.code, JOURNAL_CODES.BYTES_OVERFLOW);
  const sealed = sealJournal(journal, { now: NOW + 1000, totalBytes: journal.totalBytes }).journal;
  const afterSeal = appendEntry(sealed, { sequence: 3, index: 9, bytes: 10, hash: 'h9' }, { now: NOW + 2000 });
  assert.equal(afterSeal.code, JOURNAL_CODES.ENTRY_AFTER_SEAL);
});

test('normalizeJournalEntry：缺字段收敛，key 由 index 派生', () => {
  const entry = normalizeJournalEntry({ index: 4, bytes: 10 }, 0);
  assert.equal(entry.index, 4);
  assert.equal(entry.key, 'part-000004');
  assert.equal(entry.sequence, 0);
  assert.equal(entry.hash, '');
  assert.equal(normalizeJournalEntry(null, 3).sequence, 3);
});

test('validateJournal：合法/缺口/重复/序号倒退/空', () => {
  const journal = journalWith(3);
  const ok = validateJournal(journal);
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 3);
  assert.equal(ok.bytes, 3072);
  assert.deepEqual(ok.gaps, []);
  assert.equal(validateJournal(null).ok, false);
  const gapped = { ...journal, entries: [journal.entries[0], journal.entries[2]] };
  const gap = validateJournal(gapped);
  assert.equal(gap.ok, false);
  assert.deepEqual(gap.gaps, [1]);
  assert.ok(gap.errors.some((error) => error.code === JOURNAL_CODES.ENTRY_GAP));
  const dup = { ...journal, entries: [journal.entries[0], journal.entries[0]] };
  assert.ok(validateJournal(dup).errors.some((error) => error.code === JOURNAL_CODES.ENTRY_DUPLICATE));
  const empty = validateJournal({ ...journal, entries: [], totalBytes: 0 });
  assert.ok(empty.errors.some((error) => error.code === 'empty'));
});

test('validateJournal：totalBytes 与条目合计不一致会被抓', () => {
  const journal = journalWith(2);
  const tampered = { ...journal, totalBytes: 1 };
  assert.ok(validateJournal(tampered).errors.some((error) => error.code === 'bytes-total'));
});

test('sealJournal：密封成功写 chain/digest/sealedAt', () => {
  const journal = journalWith(4);
  const sealed = sealJournal(journal, { now: NOW + 10_000, totalBytes: journal.totalBytes });
  assert.equal(sealed.ok, true);
  assert.deepEqual(sealed.errors, []);
  assert.equal(sealed.journal.state, 'sealed');
  assert.equal(sealed.journal.sealedAt, new Date(NOW + 10_000).toISOString());
  assert.equal(sealed.journal.seal.entries, 4);
  assert.equal(sealed.journal.seal.bytes, journal.totalBytes);
  assert.equal(sealed.journal.seal.digest.length, 16);
  assert.equal(validateJournal(sealed.journal).ok, true);
});

test('sealJournal：空日记/链损坏/字节不符/时钟乱序 → ok=false', () => {
  const empty = createJournal({ recordingId: 'r', now: NOW });
  const sealedEmpty = sealJournal(empty, { now: NOW + 1000 });
  assert.equal(sealedEmpty.ok, false);
  assert.ok(sealedEmpty.errors.some((error) => error.code === JOURNAL_CODES.SEAL_INCOMPLETE));
  const journal = journalWith(2);
  const broken = sealJournal({ ...journal, chain: 'deadbeefdeadbeef' }, { now: NOW + 1000 });
  assert.ok(broken.errors.some((error) => error.code === JOURNAL_CODES.CHAIN_BROKEN));
  const bytes = sealJournal(journal, { now: NOW + 1000, totalBytes: 1 });
  assert.ok(bytes.errors.some((error) => error.code === JOURNAL_CODES.SEAL_INCOMPLETE));
  const time = sealJournal(journal, { now: NOW - 60_000, totalBytes: journal.totalBytes });
  assert.ok(time.errors.some((error) => error.code === JOURNAL_CODES.SEAL_TIME));
});

test('replayJournal：完整日记 → resume；已密封 → sealed', () => {
  const journal = journalWith(3);
  const replay = replayJournal({ journal, available: [0, 1, 2], now: NOW + 1000 });
  assert.equal(replay.action, 'resume');
  assert.equal(replay.ok, true);
  assert.equal(replay.sealed, false);
  assert.deepEqual(replay.missing, []);
  assert.deepEqual(replay.recovered, [0, 1, 2]);
  const sealed = sealJournal(journal, { now: NOW + 1000, totalBytes: journal.totalBytes }).journal;
  const sealedReplay = replayJournal({ journal: sealed, available: [0, 1, 2], now: NOW + 2000 });
  assert.equal(sealedReplay.action, 'sealed');
  assert.equal(sealedReplay.sealed, true);
});

test('replayJournal：缺片 → rebuild；首片缺失 → restart；孤儿片证据', () => {
  const journal = journalWith(4);
  const partial = replayJournal({ journal, available: [0, 2, 3], now: NOW + 1000 });
  assert.equal(partial.action, 'rebuild');
  assert.deepEqual(partial.missing, [1]);
  assert.equal(partial.ok, true);
  const firstMissing = replayJournal({ journal, available: [1, 2, 3], now: NOW + 1000 });
  assert.equal(firstMissing.action, 'restart');
  assert.equal(firstMissing.ok, false);
  assert.ok(firstMissing.reasons.some((reason) => reason.includes('init')));
  const orphan = replayJournal({ journal, available: [0, 1, 2, 3, 9], now: NOW + 1000 });
  assert.deepEqual(orphan.orphan, [9]);
  assert.ok(orphan.reasons.some((reason) => reason.includes('残留')));
});

test('replayJournal：过期 → restart；无日记 → rebuild/skip；空日记 → continue', () => {
  const journal = journalWith(2);
  const expired = replayJournal({ journal, available: [0, 1], now: NOW + JOURNAL_DEFAULTS.maxAgeMs + 1000 });
  assert.equal(expired.action, 'restart');
  assert.equal(expired.state, 'stale');
  assert.equal(replayJournal({ available: [], now: NOW }).action, 'skip');
  assert.equal(replayJournal({ manifest: { segments: [1, 2] }, now: NOW }).action, 'rebuild');
  const empty = createJournal({ recordingId: 'r', now: NOW });
  assert.equal(replayJournal({ journal: empty, available: [], now: NOW + 10 }).action, 'continue');
});

test('resumeJournal：幂等吸收恢复条目', () => {
  const journal = journalWith(2);
  const entries = [
    { sequence: 2, index: 2, bytes: 1024, hash: 'h2' },
    { sequence: 1, index: 1, bytes: 1024, hash: 'h1' },
    { sequence: 1, index: 1, bytes: 1024, hash: 'h1' },
  ];
  const resumed = resumeJournal(journal, entries, { now: NOW + 1000 });
  assert.deepEqual(resumed.accepted, [2]);
  assert.deepEqual(resumed.duplicates, [1, 1]);
  assert.equal(resumed.changed, true);
  assert.equal(resumed.journal.entries.length, 3);
  assert.equal(resumeJournal(null, []).changed, false);
});

test('journalRecordFields / journalFromRecord：落盘字段往返', () => {
  const journal = journalWith(3);
  const fields = journalRecordFields(journal);
  assert.equal(fields.journal_version, JOURNAL_VERSION);
  assert.equal(fields.journal_state, 'open');
  assert.equal(fields.journal_entries, 3);
  assert.equal(fields.journal_bytes, journal.totalBytes);
  assert.equal(fields.journal_chain, journal.chain);
  assert.equal(fields.journal_parts.length, 3);
  assert.deepEqual(Object.keys(fields.journal_parts[0]).sort(), ['bytes', 'frames', 'hash', 'index', 'key', 'seq', 't']);
  const rebuilt = journalFromRecord({ id: 'rec-1', mime: 'video/mp4', journal_state: 'sealed', journal_parts: fields.journal_parts }, { now: NOW });
  assert.equal(rebuilt.recordingId, 'rec-1');
  assert.equal(rebuilt.entries.length, 3);
  assert.equal(rebuilt.state, 'recovered');
  assert.equal(rebuilt.recoveredFrom, 'record');
  assert.equal(journalFromRecord({}, {}), null);
});

test('mergeJournals：取较长者并给丢弃证据', () => {
  const persisted = journalWith(2);
  // 内存日记更短但序号不同（例如 SW 重启后重新起了一段）：合并时丢掉的条目要进证据。
  let memory = createJournal({ recordingId: 'rec-1', now: NOW });
  memory = appendEntry(memory, { sequence: 10, index: 10, bytes: 10, hash: 'h10' }, { now: NOW }).journal;
  const merged = mergeJournals(persisted, memory);
  assert.equal(merged.source, 'persisted');
  assert.equal(merged.journal.entries.length, 2);
  assert.equal(merged.merged, true);
  assert.deepEqual(merged.dropped, [10]);
  assert.equal(mergeJournals(null, memory).source, 'memory');
  assert.equal(mergeJournals(persisted, null).source, 'persisted');
});

test('summarizeJournal / describeJournal / journalPartKeys：日志与摘要', () => {
  const journal = journalWith(4);
  const summary = summarizeJournal(journal);
  assert.equal(summary.entries, 4);
  assert.equal(summary.valid, true);
  assert.equal(summary.sealed, false);
  assert.equal(summary.digest.length, 16);
  assert.equal(summary.indexes.length, 4);
  assert.match(describeJournal(journal), /录制日记 open 4 片/);
  assert.equal(summarizeJournal(null), null);
  assert.match(describeJournal(null), /录制日记 无/);
  assert.deepEqual(journalPartKeys(journal), ['part-000000', 'part-000001', 'part-000002', 'part-000003']);
  assert.deepEqual(JOURNAL_ACTION_LIST.slice(0, 3), ['continue', 'resume', 'rebuild']);
});
