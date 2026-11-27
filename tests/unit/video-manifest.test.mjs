import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  VIDEO_MANIFEST_VERSION,
  VIDEO_SEGMENT_CODES,
  appendSegment,
  createSegmentManifest,
  manifestRecordFields,
  normalizeManifest,
  normalizeSegment,
  planSegmentRecovery,
  sealDigestInput,
  sealManifest,
  stableStringify,
  summarizeManifest,
  validateManifest,
} from '../../extension/src/lib/video-manifest.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function segment(index, overrides = {}) {
  return {
    index,
    atMs: index * 1000,
    bytes: 1000 + index,
    codec: 'avc',
    lastFrameAt: index * 1000 + 900,
    checksum: createHash('sha256').update('segment-' + index).digest('hex'),
    ...overrides,
  };
}

function manifestWith(count, overrides = {}) {
  const manifest = createSegmentManifest({ recordingId: 'rec-1', codec: 'avc', startedAt: 100, now: 100, budget: { maxSegmentBytes: 2048 } });
  let next = manifest;
  for (let i = 0; i < count; i += 1) {
    const appended = appendSegment(next, segment(i, overrides.segment && overrides.segment(i) ? overrides.segment(i) : {}));
    assert.equal(appended.ok, true);
    next = appended.manifest;
  }
  return next;
}

test('stableStringify：键排序且确定性', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify(undefined), 'null');
  assert.equal(stableStringify('x'), '"x"');
  assert.equal(stableStringify(Number.NaN), 'null');
});

test('createSegmentManifest / normalizeSegment：默认骨架与校验和归一', () => {
  const manifest = createSegmentManifest({ recordingId: 'r-1', codec: 'vp9', startedAt: 50, now: 100, budget: { maxDurationMs: 1000, maxSegmentBytes: 2048, maxTotalBytes: 4096 } });
  assert.equal(manifest.version, VIDEO_MANIFEST_VERSION);
  assert.equal(manifest.recordingId, 'r-1');
  assert.equal(manifest.state, 'recording');
  assert.equal(manifest.sealed, false);
  assert.deepEqual(manifest.budget, { maxDurationMs: 1000, maxSegmentBytes: 2048, maxTotalBytes: 4096 });
  assert.deepEqual(manifest.segments, []);

  const normalized = normalizeSegment({ index: 0, atMs: 5, bytes: 10, codec: 'avc', lastFrameAt: 8, checksum: DIGEST_A.toUpperCase() });
  assert.equal(normalized.checksum, DIGEST_A);
  assert.equal(normalized.lastFrameAt, 8);
  const invalid = normalizeSegment({ index: 1.5, atMs: -1, bytes: 'x', checksum: 'zz' });
  assert.equal(invalid.index, -1);
  assert.equal(invalid.atMs, 0);
  assert.equal(invalid.bytes, 0);
  assert.equal(invalid.checksum, '');
});

test('appendSegment：序号连续追加，统计字段随分片更新', () => {
  const manifest = manifestWith(3);
  assert.equal(manifest.segments.length, 3);
  assert.deepEqual(manifest.stats, {
    segments: 3,
    bytes: 1000 + 1001 + 1002,
    durationMs: 2900 - 0,
    firstAtMs: 0,
    lastAtMs: 2000,
    lastFrameAt: 2900,
  });
  assert.equal(manifest.updatedAt > 0, true);
});

test('appendSegment：非法追加被拒绝并给 code/evidence', () => {
  const manifest = manifestWith(2);
  const gap = appendSegment(manifest, segment(5));
  assert.equal(gap.ok, false);
  assert.equal(gap.code, VIDEO_SEGMENT_CODES.SEGMENT_INDEX_GAP);
  assert.equal(gap.problems[0].severity, 'error');

  const duplicate = appendSegment(manifest, segment(0, { atMs: 5000, lastFrameAt: 5000 }));
  assert.equal(duplicate.code, VIDEO_SEGMENT_CODES.SEGMENT_INDEX_DUPLICATE);

  const zero = appendSegment(manifest, segment(2, { bytes: 0 }));
  assert.equal(zero.code, VIDEO_SEGMENT_CODES.SEGMENT_BYTES_ZERO);

  const time = appendSegment(manifest, segment(2, { atMs: 500, lastFrameAt: 500 }));
  assert.equal(time.code, VIDEO_SEGMENT_CODES.SEGMENT_TIME_REGRESSION);

  const frame = appendSegment(manifest, segment(2, { atMs: 5000, lastFrameAt: 100 }));
  assert.equal(frame.code, VIDEO_SEGMENT_CODES.FRAME_TIME_REGRESSION);

  const codec = appendSegment(manifest, segment(2, { codec: 'vp9' }));
  assert.equal(codec.code, VIDEO_SEGMENT_CODES.SEGMENT_CODEC_MISMATCH);

  const sealed = appendSegment({ ...manifest, sealed: true }, segment(2));
  assert.equal(sealed.code, VIDEO_SEGMENT_CODES.MANIFEST_SEALED);

  const missing = appendSegment(null, segment(0));
  assert.equal(missing.code, VIDEO_SEGMENT_CODES.MANIFEST_MISSING);

  const missingChecksum = appendSegment(manifest, segment(2, { checksum: '' }), { requireChecksum: true });
  assert.equal(missingChecksum.code, VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_MISSING);
});

test('validateManifest：连续性/字节/时间戳/总字节/校验和分类', () => {
  const ok = validateManifest(manifestWith(3));
  assert.equal(ok.ok, true);
  assert.equal(ok.problems.some((item) => item.severity === 'error'), false);
  assert.equal(ok.stats.segments, 3);
  assert.equal(ok.stats.bytes, 3003);

  const broken = validateManifest({
    ...manifestWith(2),
    segments: [
      segment(0),
      segment(2, { atMs: 100, lastFrameAt: 100, checksum: '' }),
      { index: 2, atMs: 50, bytes: 0, codec: 'vp9', lastFrameAt: 2900, checksum: 'nope' },
    ],
  });
  assert.equal(broken.ok, false);
  const codes = broken.problems.map((item) => item.code);
  assert.equal(codes.includes(VIDEO_SEGMENT_CODES.SEGMENT_INDEX_GAP), true);
  assert.equal(codes.includes(VIDEO_SEGMENT_CODES.SEGMENT_TIME_REGRESSION), true);
  assert.equal(codes.includes(VIDEO_SEGMENT_CODES.SEGMENT_BYTES_ZERO), true);
  assert.equal(codes.includes(VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_INVALID), true);
  assert.equal(codes.includes(VIDEO_SEGMENT_CODES.SEGMENT_CODEC_MISMATCH), true);
  assert.equal(codes.includes(VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_MISSING), true);

  const totalMismatch = validateManifest({ ...manifestWith(2), totalBytes: 999999 });
  assert.equal(totalMismatch.ok, false);
  assert.equal(totalMismatch.problems.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_TOTAL_MISMATCH), true);

  const budgetWarn = validateManifest(manifestWith(3, { segment: (i) => (i === 2 ? { bytes: 5000 } : {}) }));
  assert.equal(budgetWarn.ok, true);
  assert.equal(budgetWarn.problems.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_BYTES_LIMIT && item.severity === 'warning'), true);

  const missing = validateManifest(null);
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].code, VIDEO_SEGMENT_CODES.MANIFEST_MISSING);
});

test('sealManifest：连续性通过后落 sealed manifest，摘要确定且不随 sealedAt 变化', async () => {
  const manifest = manifestWith(3);
  const first = await sealManifest(manifest, { at: 111, digest: async () => DIGEST_A });
  assert.equal(first.ok, true);
  assert.equal(first.sealed.sealed, true);
  assert.equal(first.sealed.state, 'sealed');
  assert.equal(first.sealed.sealedAt, 111);
  assert.equal(first.sealed.totalBytes, 3003);
  assert.equal(first.sealed.totalDurationMs, 2900);
  assert.equal(first.sealed.seal.digest, DIGEST_A);
  assert.equal(first.sealed.seal.algorithm, 'sha256');
  assert.equal(first.sealed.seal.segments, 3);
  assert.equal(first.sealed.seal.durability, 'verified');
  assert.equal(first.evidence.code, VIDEO_SEGMENT_CODES.MANIFEST_SEALED);

  const second = await sealManifest({ ...manifest, createdAt: 999 }, { at: 222, digest: async () => DIGEST_A });
  assert.equal(sealDigestInput(manifest), sealDigestInput({ ...manifest, createdAt: 999 }));

  const invalid = await sealManifest({ ...manifest, segments: [segment(0), segment(2, { atMs: 0, lastFrameAt: 0 })] }, { digest: async () => DIGEST_A });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, VIDEO_SEGMENT_CODES.SEAL_INVALID);
  assert.equal(invalid.problems.some((item) => item.severity === 'error'), true);

  const digestFailed = await sealManifest(manifest, { digest: async () => { throw new Error('subtle down'); } });
  assert.equal(digestFailed.ok, false);
  assert.equal(digestFailed.code, VIDEO_SEGMENT_CODES.SEAL_DIGEST_FAILED);

  const badDigest = await sealManifest(manifest, { digest: async () => 'not-a-hash' });
  assert.equal(badDigest.ok, false);
  assert.equal(badDigest.evidence.reason, 'invalid_digest');

  const warningSeal = await sealManifest(manifestWith(2, { segment: (i) => (i === 1 ? { checksum: '' } : {}) }), { digest: async () => DIGEST_B });
  assert.equal(warningSeal.ok, true);
  assert.equal(warningSeal.sealed.seal.durability, 'unverified');
});

test('planSegmentRecovery：完整/缺片/截断/校验和不匹配/未登记分类', () => {
  const manifest = manifestWith(4);
  const full = manifest.segments.map((item) => ({ index: item.index, bytes: item.bytes }));
  const complete = planSegmentRecovery(manifest, full);
  assert.equal(complete.ok, true);
  assert.equal(complete.recovered, true);
  assert.equal(complete.completeness, 'complete');
  assert.equal(complete.bytes, 4006);
  assert.equal(complete.keptSegments.length, 4);
  assert.equal(complete.evidence.some((item) => item.code === VIDEO_SEGMENT_CODES.RECOVERY_PLANNED), true);

  assert.equal(planSegmentRecovery(null, full).reason, 'manifest_missing');
  assert.equal(planSegmentRecovery(manifest, []).reason, 'no_parts');
  assert.equal(planSegmentRecovery(manifest, full.slice(1)).reason, 'first_segment_missing');

  const missingMiddle = planSegmentRecovery(manifest, [full[0], full[1], full[3]]);
  assert.equal(missingMiddle.recovered, true);
  assert.equal(missingMiddle.completeness, 'partial');
  assert.equal(missingMiddle.keptSegments.length, 2);
  assert.equal(missingMiddle.droppedSegments.length, 2);
  assert.equal(missingMiddle.evidence.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_MISSING), true);

  const truncatedLast = planSegmentRecovery(manifest, [full[0], full[1], full[2], { index: 3, bytes: 10 }]);
  assert.equal(truncatedLast.recovered, true);
  assert.equal(truncatedLast.completeness, 'partial');
  assert.equal(truncatedLast.truncatedSegments.length, 1);
  assert.equal(truncatedLast.truncatedSegments[0].droppedBytes, 1003 - 10);
  assert.equal(truncatedLast.bytes, 1000 + 1001 + 1002 + 10);

  const corrupt = planSegmentRecovery(manifest, [
    { index: 0, bytes: full[0].bytes, checksum: DIGEST_B },
    full[1],
    full[2],
    full[3],
  ]);
  assert.equal(corrupt.recovered, false);
  assert.equal(corrupt.reason, 'unrecoverable');
  assert.equal(corrupt.evidence.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_MISMATCH), true);

  const unlisted = planSegmentRecovery(manifest, full.concat([{ index: 9, bytes: 5 }]));
  assert.equal(unlisted.evidence.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_UNLISTED), true);
  assert.equal(unlisted.ok, true);

  const zeroPart = planSegmentRecovery(manifest, [full[0], { index: 1, bytes: 0 }, full[2], full[3]]);
  assert.equal(zeroPart.recovered, true);
  assert.equal(zeroPart.completeness, 'partial');
});

test('manifestRecordFields / summarizeManifest / normalizeManifest', () => {
  const manifest = manifestWith(2);
  const fields = manifestRecordFields(manifest);
  assert.equal(fields.chunk_count, 2);
  assert.equal(fields.fragments.length, 2);
  assert.equal(fields.fragments.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)), true);
  assert.equal(fields.fragments[1].bytes, 1001);

  const summary = summarizeManifest(manifest);
  assert.equal(summary.segments, 2);
  assert.equal(summary.bytes, 2001);
  assert.equal(summary.sealed, false);
  assert.equal(summarizeManifest(null), null);

  const legacy = normalizeManifest({ version: 1, recordingId: 'old', createdAt: 10, tabId: 3, url: 'u', title: 't', mime: 'video/mp4' });
  assert.equal(legacy.version, VIDEO_MANIFEST_VERSION);
  assert.equal(legacy.recordingId, 'old');
  assert.equal(legacy.tabId, 3);
  assert.deepEqual(legacy.segments, []);
  assert.equal(normalizeManifest(null), null);
  const v2 = normalizeManifest(manifest);
  assert.equal(v2, manifest);
});
