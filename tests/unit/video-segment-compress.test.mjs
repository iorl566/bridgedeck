// tests/unit/video-segment-compress.test.mjs
// 第十一批-E：视频分片/分片日记的存储压缩与预算（lib/video-segment-compress.js）。
// 覆盖：段体积估算、去重、段预算（超限重编/配额决策/租户联动）、日记瘦身、
//       证据合并（frames/transcode/mux/storage/journal/partial）、wire/describe。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEGMENT_ACTIONS,
  SEGMENT_CODES,
  SEGMENT_COMPRESS_VERSION,
  SEGMENT_DEFAULTS,
  compressJournalEntries,
  dedupeSegments,
  describeSegmentCompression,
  estimateSegmentBytes,
  mergeVideoEvidence,
  planSegmentCompression,
  segmentCompressionWire,
} from '../../extension/src/lib/video-segment-compress.js';

const MB = 1024 * 1024;

test('常量：版本/动作/默认值形状稳定', () => {
  assert.equal(SEGMENT_COMPRESS_VERSION, 1);
  assert.deepEqual([...SEGMENT_ACTIONS], ['keep', 'dedupe', 'reencode', 'evict', 'reject']);
  assert.ok(SEGMENT_DEFAULTS.maxSegmentBytes > SEGMENT_DEFAULTS.targetSegmentBytes);
  assert.ok(SEGMENT_DEFAULTS.journalKeepKeys.includes('hash'));
  assert.match(SEGMENT_CODES.REENCODE, /^video\.segment\./);
});

test('estimateSegmentBytes：时长×码率+容器开销；缺码率回落 bytes', () => {
  const estimated = estimateSegmentBytes({ durationMs: 1000, bitrate: 8_000_000 });
  assert.equal(estimated, 8_000_000 / 8 * 1.02);
  const fallback = estimateSegmentBytes({ bytes: 12345 });
  assert.equal(fallback, 12345);
  assert.equal(estimateSegmentBytes({}), 0);
});

test('dedupeSegments：同 hash 只留一份、保留首次位置、统计节省', () => {
  const deduped = dedupeSegments([
    { index: 0, bytes: 100, hash: 'AA' },
    { index: 1, bytes: 100, hash: 'aa' },
    { index: 2, bytes: 200, hash: 'bb' },
    { index: 3, bytes: 50 },
  ]);
  assert.equal(deduped.unique.length, 3);
  assert.deepEqual(deduped.duplicates.map((item) => item.index), [1]);
  assert.equal(deduped.savedBytes, 100);
  assert.equal(deduped.ratio, 0.25);
  assert.deepEqual(dedupeSegments(null).unique, []);
});

test('planSegmentCompression：常规段 → keep；重复 → dedupe', () => {
  const keep = planSegmentCompression({
    segments: [
      { index: 0, bytes: 5 * MB, durationMs: 2000, hash: 'aa' },
      { index: 1, bytes: 5 * MB, durationMs: 2000, hash: 'bb' },
    ],
  });
  assert.equal(keep.action, 'keep');
  assert.equal(keep.uniqueSegments, 2);
  assert.equal(keep.reencode.length, 0);
  assert.ok(keep.issues.includes(SEGMENT_CODES.OK));
  assert.equal(keep.storage.action, 'accept');

  const dedupe = planSegmentCompression({
    segments: [
      { index: 0, bytes: 5 * MB, durationMs: 2000, hash: 'aa' },
      { index: 1, bytes: 5 * MB, durationMs: 2000, hash: 'aa' },
    ],
  });
  assert.equal(dedupe.action, 'dedupe');
  assert.equal(dedupe.dedupeSavedBytes, 5 * MB);
  assert.equal(dedupe.projectedBytes, 5 * MB);
  assert.ok(dedupe.issues.includes(SEGMENT_CODES.DEDUPE));
  assert.equal(dedupe.ratios.dedupe, 0.5);
});

test('planSegmentCompression：超单段上限/超目标 → reencode 候选', () => {
  const plan = planSegmentCompression({
    segments: [
      { index: 0, bytes: 90 * MB, durationMs: 10_000, hash: 'aa' },
      { index: 1, bytes: 20 * MB, durationMs: 5000, hash: 'bb' },
      { index: 2, bytes: 4 * MB, durationMs: 2000, hash: 'cc' },
    ],
    maxSegmentBytes: 64 * MB,
    targetSegmentBytes: 8 * MB,
  });
  assert.equal(plan.action, 'reencode');
  assert.deepEqual(plan.reencode.map((item) => item.reason), ['segment-too-large', 'segment-above-target']);
  assert.deepEqual(plan.reencode.map((item) => item.index), [0, 1]);
  assert.equal(plan.reencode[0].targetBytes, 8 * MB);
  assert.equal(plan.keep.length, 1);
});

test('planSegmentCompression：配额不足 → evict / 超份额 → reject', () => {
  const reject = planSegmentCompression({
    segments: [{ index: 0, bytes: 400 * MB, durationMs: 60_000, hash: 'aa' }],
    maxSegmentBytes: 512 * MB,
    targetSegmentBytes: 512 * MB,
    quotaBytes: 512 * MB,
    usedBytes: 0,
    maxCaptureRatio: 0.5,
  });
  assert.equal(reject.action, 'reject');
  assert.equal(reject.ok, false);
  const day = 24 * 60 * 60 * 1000;
  const now = 20 * day;
  const evict = planSegmentCompression({
    segments: [{ index: 0, bytes: 10 * MB, durationMs: 2000, hash: 'aa' }],
    usedBytes: 500 * MB,
    quotaBytes: 512 * MB,
    now,
    captures: [
      { id: 'old', kind: 'video', bytes: 20 * MB, sealed: true, at: now - 3 * day },
      { id: 'keep', kind: 'video', bytes: 20 * MB, sealed: true, at: now - 2 * day },
    ],
  });
  assert.equal(evict.action, 'evict');
  assert.ok(evict.storageWire);
  assert.ok(evict.issues.includes(SEGMENT_CODES.EVICT));
});

test('compressJournalEntries：去掉帧明细、保留计数与可播结论、统计节省', () => {
  const result = compressJournalEntries([
    {
      index: 0,
      bytes: 1000,
      hash: 'aa',
      tMs: 0,
      durationMs: 100,
      frames: [{ pts: 0, durationMs: 100, bytes: 100 }, { pts: 33, durationMs: 33, bytes: 50 }],
      debug: { heavy: 'x'.repeat(200) },
    },
    { index: 1, bytes: 1000, hash: 'bb', tMs: 100, durationMs: 100 },
  ]);
  assert.equal(result.count, 2);
  assert.equal(result.entries[0].frames, 2);
  assert.equal(result.entries[0].frames_playable, true);
  assert.equal(result.entries[0].debug, undefined);
  assert.ok(result.removedBytes > 0);
  assert.ok(result.estimatedBytes > 0);
  assert.deepEqual(compressJournalEntries(null).entries, []);
  const custom = compressJournalEntries([{ index: 0, bytes: 1, hash: 'h', extra: 1 }], { keepKeys: ['index', 'hash'] });
  assert.deepEqual(custom.entries[0], { index: 0, hash: 'h' });
});

test('mergeVideoEvidence：四块证据合成、缺失跳过、异常不影响其它块', () => {
  const evidence = mergeVideoEvidence({
    frames: { action: 'pad', ok: true, counts: { frames: 10 }, coverage: { ratio: 0.9 }, severity: 'warn' },
    transcode: { action: 'skip', chosen: null, cost: null },
    mux: { action: 'ok', fragmentCount: 2, overhead: { bytes: 2000 }, keyframeMs: 2000 },
    storage: {
      action: 'dedupe',
      totalBytes: 1000,
      dedupeSavedBytes: 100,
      reencode: [],
      storageWire: { action: 'accept' },
    },
    journal: { count: 2, removedBytes: 50, estimatedBytes: 100, ratio: 0.3 },
  });
  assert.equal(evidence.version, SEGMENT_COMPRESS_VERSION);
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.actions, ['pad', 'skip', 'ok', 'dedupe']);
  assert.equal(evidence.frames.action, 'pad');
  assert.equal(evidence.transcode.action, 'skip');
  assert.equal(evidence.mux.overheadBytes, 2000);
  assert.equal(evidence.storage.storage.action, 'accept');
  assert.equal(evidence.journal.count, 2);
  assert.equal(evidence.partial, false);
  const partial = mergeVideoEvidence({ frames: { ok: false, action: 'reencode' }, transcode: null });
  assert.equal(partial.ok, false);
  assert.equal(partial.transcode, null);
  assert.equal(mergeVideoEvidence(null).partial, false);
});

test('segmentCompressionWire/describeSegmentCompression：截断列表、文本可读', () => {
  const plan = planSegmentCompression({
    segments: [
      { index: 0, bytes: 5 * MB, durationMs: 2000, hash: 'aa' },
      { index: 1, bytes: 5 * MB, durationMs: 2000, hash: 'aa' },
      { index: 2, bytes: 80 * MB, durationMs: 5000, hash: 'bb' },
    ],
  });
  const wire = segmentCompressionWire(plan, { maxListed: 1 });
  assert.equal(wire.version, SEGMENT_COMPRESS_VERSION);
  assert.equal(wire.segments, 3);
  assert.equal(wire.reencode.length, 1);
  assert.equal(wire.duplicates.length, 1);
  assert.ok(wire.storage);
  assert.match(wire.text, /视频分片压缩/);
  assert.match(describeSegmentCompression(plan), /段/);
  assert.equal(segmentCompressionWire(null).action, 'keep');
  assert.match(describeSegmentCompression(null), /无/);
});
