import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAGMENT_JOURNAL_CODES,
  fragmentJournalFromBlob,
  journalIntegrity,
} from '../../extension/src/lib/mp4-fragments.js';

function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function blobOf(...parts) {
  return new Blob(parts, { type: 'video/mp4' });
}

function sampleBlob({ tail = null } = {}) {
  const init = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov')]);
  const first = Buffer.concat([box('moof'), box('mdat', Buffer.alloc(16))]);
  const second = Buffer.concat([box('moof'), box('mdat', Buffer.alloc(24))]);
  return blobOf(init, first, second, ...(tail ? [tail] : []));
}

test('journalIntegrity：健康 fMP4 分片日记 → ok 且连续', async () => {
  const journal = await fragmentJournalFromBlob(sampleBlob());
  const report = journalIntegrity(journal);
  assert.equal(report.ok, true);
  assert.equal(report.fragmented, true);
  assert.equal(report.stats.fragments, 2);
  assert.equal(report.stats.gaps, 0);
  assert.equal(report.stats.overlaps, 0);
  assert.equal(report.problems.some((item) => item.severity === 'error'), false);
});

test('journalIntegrity：尾部截断/未成帧 → trailing/complete_frames 证据', async () => {
  const journal = await fragmentJournalFromBlob(sampleBlob({ tail: Buffer.from([0, 0, 0, 1]) }));
  assert.equal(journal.completeFrames, false);
  assert.equal(journal.trailingBytes, 4);
  const report = journalIntegrity(journal);
  assert.equal(report.ok, true); // 截断尾部是 warning，不阻断恢复
  assert.equal(report.stats.trailingBytes, 4);
  assert.equal(report.problems.some((item) => item.code === FRAGMENT_JOURNAL_CODES.TRAILING_BYTES), true);
  assert.equal(report.problems.some((item) => item.code === FRAGMENT_JOURNAL_CODES.INCOMPLETE_FRAMES), true);
});

test('journalIntegrity：open fragment（moof 无 mdat）是 error', async () => {
  const init = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov')]);
  const journal = await fragmentJournalFromBlob(blobOf(init, box('moof')));
  const report = journalIntegrity(journal);
  assert.equal(journal.openFragment, true);
  assert.equal(report.ok, false);
  assert.equal(report.problems.some((item) => item.code === FRAGMENT_JOURNAL_CODES.OPEN_FRAGMENT && item.severity === 'error'), true);
});

test('journalIntegrity：缺 ftyp/moov/init、空容器分类', () => {
  const noInit = journalIntegrity({
    totalBytes: 100,
    fragmented: true,
    hasFtyp: false,
    hasMoov: false,
    initBytes: 0,
    fragments: [{ moofOffset: 0, bytes: 20, mdatBytes: 12 }],
    completeBytes: 20,
    trailingBytes: 0,
    completeFrames: true,
  });
  assert.equal(noInit.ok, false);
  const codes = noInit.problems.map((item) => item.code);
  assert.equal(codes.includes(FRAGMENT_JOURNAL_CODES.MISSING_FTYP), true);
  assert.equal(codes.includes(FRAGMENT_JOURNAL_CODES.MISSING_MOOV), true);
  assert.equal(codes.includes(FRAGMENT_JOURNAL_CODES.INIT_MISSING), true);

  const empty = journalIntegrity({ totalBytes: 0, fragmented: true, hasFtyp: false, hasMoov: false, initBytes: 0, fragments: [], completeBytes: 0, trailingBytes: 0, completeFrames: false });
  assert.equal(empty.problems.some((item) => item.code === FRAGMENT_JOURNAL_CODES.EMPTY_CONTAINER), true);
  assert.equal(empty.problems.some((item) => item.code === FRAGMENT_JOURNAL_CODES.NO_COMPLETE_FRAGMENTS), true);

  const missing = journalIntegrity(null);
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].code, FRAGMENT_JOURNAL_CODES.JOURNAL_MISSING);
});

test('journalIntegrity：分片之间字节不连续（gap）是 warning，重叠（overlap）是 error', () => {
  const base = {
    totalBytes: 400,
    fragmented: true,
    hasFtyp: true,
    hasMoov: true,
    initBytes: 20,
    completeBytes: 400,
    trailingBytes: 0,
    completeFrames: true,
  };
  const gap = journalIntegrity({
    ...base,
    fragments: [
      { moofOffset: 20, bytes: 100, mdatBytes: 60 },
      { moofOffset: 200, bytes: 100, mdatBytes: 60 },
    ],
  });
  assert.equal(gap.ok, true);
  assert.equal(gap.stats.gaps, 1);
  const gapProblem = gap.problems.find((item) => item.code === FRAGMENT_JOURNAL_CODES.FRAGMENT_GAP);
  assert.equal(gapProblem.severity, 'warning');
  assert.equal(gapProblem.gapBytes, 80);

  const overlap = journalIntegrity({
    ...base,
    fragments: [
      { moofOffset: 20, bytes: 100, mdatBytes: 60 },
      { moofOffset: 100, bytes: 100, mdatBytes: 60 },
    ],
  });
  assert.equal(overlap.ok, false);
  assert.equal(overlap.stats.overlaps, 1);
  assert.equal(overlap.problems.some((item) => item.code === FRAGMENT_JOURNAL_CODES.FRAGMENT_OVERLAP && item.severity === 'error'), true);

  const missingMdat = journalIntegrity({
    ...base,
    fragments: [{ moofOffset: 20, bytes: 80, mdatBytes: 0 }],
  });
  assert.equal(missingMdat.ok, false);
  assert.equal(missingMdat.problems.some((item) => item.code === FRAGMENT_JOURNAL_CODES.MISSING_MDAT), true);

  const emptyFragment = journalIntegrity({
    ...base,
    fragments: [{ moofOffset: 20, bytes: 0, mdatBytes: 0 }],
  });
  assert.equal(emptyFragment.ok, false);
  assert.equal(emptyFragment.problems.some((item) => item.code === FRAGMENT_JOURNAL_CODES.EMPTY_FRAGMENT), true);
});

test('journalIntegrity：普通 MP4（无 moof）按完整容器判定', async () => {
  const blob = blobOf(box('ftyp', Buffer.from('isom')), box('moov'), box('mdat', Buffer.alloc(8)));
  const journal = await fragmentJournalFromBlob(blob);
  const report = journalIntegrity(journal);
  assert.equal(report.ok, true);
  assert.equal(report.fragmented, false);
  assert.equal(report.stats.fragments, 0);
  assert.equal(report.problems.length, 0);
});
