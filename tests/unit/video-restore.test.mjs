import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendSegment, createSegmentManifest } from '../../extension/src/lib/video-manifest.js';
import {
  assembleRangePlan,
  decidePartRefetch,
  DEFAULT_KEEP_RECOVERABLE_MS,
  DEFAULT_SEALED_TTL_MS,
  DEFAULT_STALE_TTL_MS,
  normalizeRestorePart,
  planPartialReassembly,
  reconcileAssembled,
  RESTORE_NEXT_ACTIONS,
  RESTORE_STRATEGIES,
  restoreRecordFields,
  stalePartsPlan,
  summarizeRestore,
  summarizeStaleCleanup,
  VIDEO_RESTORE_CODES,
} from '../../extension/src/lib/video-restore.js';

const sha = (text) => createHash('sha256').update(text).digest('hex');

function manifestWith(count, overrides = {}) {
  let manifest = createSegmentManifest({ recordingId: 'rec-restore', codec: 'avc', startedAt: 100, now: 100 });
  for (let index = 0; index < count; index += 1) {
    const appended = appendSegment(manifest, {
      index,
      atMs: index * 1000,
      bytes: 1000,
      lastFrameAt: index * 1000 + 900,
      checksum: sha('s' + index),
    });
    assert.equal(appended.ok, true);
    manifest = appended.manifest;
  }
  return { ...manifest, ...overrides };
}

function partsFor(count, overrides = {}) {
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    parts.push({ index, bytes: 1000, checksum: sha('s' + index), position: index * 1000, ...overrides });
  }
  return parts;
}

test('normalizeRestorePart：容忍 sequence/size/blob 形状，非法返回 null', () => {
  assert.deepEqual(normalizeRestorePart({ index: 2, bytes: 10, checksum: sha('x').toUpperCase(), position: 20 }), {
    index: 2,
    bytes: 10,
    position: 20,
    checksum: sha('x'),
  });
  const fromSequence = normalizeRestorePart({ sequence: 3, size: 8 });
  assert.equal(fromSequence.index, 3);
  assert.equal(fromSequence.bytes, 8);
  const fromBlob = normalizeRestorePart({ index: 1, blob: { size: 5 } });
  assert.equal(fromBlob.bytes, 5);
  assert.equal(normalizeRestorePart(null), null);
  assert.equal(normalizeRestorePart({ index: -1 }), null);
  assert.equal(normalizeRestorePart({ index: 1.5 }), null);
});

test('decidePartRefetch：坏片重取/预算耗尽/不可重取', () => {
  const retry = decidePartRefetch({ index: 2, expectedBytes: 100, expectedChecksum: sha('a'), actualChecksum: sha('b'), reason: 'checksum_mismatch', attempts: 0, maxAttempts: 2 });
  assert.equal(retry.action, 'refetch');
  assert.equal(retry.code, VIDEO_RESTORE_CODES.REFETCH);
  assert.equal(retry.evidence.attempt, 1);

  const exhausted = decidePartRefetch({ index: 2, reason: 'checksum_mismatch', attempts: 2, maxAttempts: 2 });
  assert.equal(exhausted.action, 'deny');
  assert.equal(exhausted.code, VIDEO_RESTORE_CODES.REFETCH_EXHAUSTED);

  const noRefetch = decidePartRefetch({ index: 2, reason: 'missing', canRefetch: false });
  assert.equal(noRefetch.action, 'deny');
  assert.equal(noRefetch.code, VIDEO_RESTORE_CODES.DENIED);

  const missingRetry = decidePartRefetch({ index: 1, expectedBytes: 1000, reason: 'missing' });
  assert.equal(missingRetry.action, 'refetch');

  const reuse = decidePartRefetch({ index: 0, reason: '', attempts: 5, maxAttempts: 1 });
  assert.equal(reuse.action, 'reuse');
});

test('planPartialReassembly：全部分片可重组 → complete + 连续 ranges', () => {
  const manifest = manifestWith(4);
  const plan = planPartialReassembly(manifest, partsFor(4));
  assert.equal(plan.strategy, 'complete');
  assert.equal(plan.nextAction, 'reassemble');
  assert.equal(plan.completeness, 'complete');
  assert.equal(plan.segments, 4);
  assert.equal(plan.totalSegments, 4);
  assert.equal(plan.assembledBytes, 4000);
  assert.equal(plan.droppedBytes, 0);
  assert.deepEqual(plan.refetch, []);
  assert.equal(RESTORE_STRATEGIES.includes(plan.strategy), true);
  assert.equal(RESTORE_NEXT_ACTIONS.includes(plan.nextAction), true);
  assert.deepEqual(plan.ranges.map((item) => [item.index, item.start, item.end]), [[0, 0, 1000], [1, 1000, 2000], [2, 2000, 3000], [3, 3000, 4000]]);
  assert.equal(summarizeRestore(plan).strategy, 'complete');
});

test('planPartialReassembly：缺片 → 前缀 + 重取证据；重取预算耗尽 → denied', () => {
  const manifest = manifestWith(4);
  const missing = partsFor(4).filter((part) => part.index !== 2);
  const plan = planPartialReassembly(manifest, missing);
  assert.equal(plan.strategy, 'prefix');
  assert.equal(plan.segments, 2);
  assert.equal(plan.assembledBytes, 2000);
  assert.equal(plan.refetch.length, 1);
  assert.equal(plan.refetch[0].index, 2);
  assert.equal(plan.refetch[0].reason, 'missing');
  assert.equal(plan.droppedBytes, 2000);

  const exhausted = planPartialReassembly(manifest, missing, { attempts: { 2: 2 } });
  assert.equal(exhausted.denied.length, 1);
  assert.equal(exhausted.denied[0].index, 2);
  assert.equal(exhausted.refetch.length, 0);

  const noRefetch = planPartialReassembly(manifest, missing, { refetch: false });
  assert.equal(noRefetch.denied.length, 1);

  const firstMissing = planPartialReassembly(manifest, partsFor(4).filter((part) => part.index !== 0));
  assert.equal(firstMissing.strategy, 'none');
  assert.equal(firstMissing.nextAction, 'refetch');
  assert.equal(firstMissing.ok, false);
});

test('planPartialReassembly：校验和不匹配 → 重取/拒绝，前缀仍可播', () => {
  const manifest = manifestWith(3);
  const bad = partsFor(3).map((part) => (part.index === 1 ? { ...part, checksum: sha('evil') } : part));
  const plan = planPartialReassembly(manifest, bad, { maxAttempts: 3, refetch: [1] });
  assert.equal(plan.strategy, 'prefix');
  assert.equal(plan.segments, 1);
  assert.equal(plan.refetch.length, 1);
  assert.equal(plan.refetch[0].expectedChecksum, sha('s1'));
  assert.equal(plan.problems.some((item) => item.code === VIDEO_RESTORE_CODES.DENIED), false);

  const denied = planPartialReassembly(manifest, bad, { refetch: false });
  assert.equal(denied.denied.length, 1);
  assert.equal(denied.denied[0].reason, 'checksum_mismatch');
});

test('planPartialReassembly：截断分片 → 可 salvage，也可只保留前缀', () => {
  const manifest = manifestWith(4);
  const truncated = partsFor(4).map((part) => (part.index === 2 ? { ...part, bytes: 400 } : part));
  const salvage = planPartialReassembly(manifest, truncated, { refetch: false, salvageTruncated: true });
  assert.equal(salvage.strategy, 'salvaged');
  assert.equal(salvage.segments, 3);
  assert.equal(salvage.assembledBytes, 2400);
  assert.equal(salvage.ranges[2].truncated, true);
  assert.equal(salvage.droppedBytes, 1600);
  assert.equal(salvage.problems.some((item) => item.code === VIDEO_RESTORE_CODES.TRUNCATED), true);

  const prefixOnly = planPartialReassembly(manifest, truncated, { refetch: false });
  assert.equal(prefixOnly.strategy, 'prefix');
  assert.equal(prefixOnly.segments, 2);
  assert.equal(prefixOnly.assembledBytes, 2000);
});

test('planPartialReassembly：重复分片取最匹配的一份；未登记分片只记 warning', () => {
  const manifest = manifestWith(2);
  const duplicated = [
    { index: 0, bytes: 1000, checksum: '' },
    { index: 0, bytes: 1000, checksum: sha('s0') },
    { index: 1, bytes: 1000, checksum: sha('s1') },
    { index: 9, bytes: 777, checksum: sha('unlisted') },
  ];
  const plan = planPartialReassembly(manifest, duplicated);
  assert.equal(plan.strategy, 'complete');
  assert.equal(plan.problems.some((item) => item.code === VIDEO_RESTORE_CODES.DUPLICATE_PART), true);
  assert.equal(plan.problems.some((item) => item.code === VIDEO_RESTORE_CODES.UNLISTED_PART), true);
  assert.equal(plan.assembledBytes, 2000);
});

test('planPartialReassembly：已封存跳过；manifest 缺失等价于不可重组', () => {
  const manifest = manifestWith(2, { sealed: true });
  const skipped = planPartialReassembly(manifest, partsFor(2));
  assert.equal(skipped.strategy, 'sealed');
  assert.equal(skipped.nextAction, 'skip');
  assert.equal(skipped.sealed, true);
  assert.equal(skipped.problems.some((item) => item.code === VIDEO_RESTORE_CODES.SEALED_SKIP), true);

  const forced = planPartialReassembly(manifest, partsFor(2), { force: true });
  assert.equal(forced.strategy, 'complete');

  const noManifest = planPartialReassembly(null, partsFor(2));
  assert.equal(noManifest.strategy, 'none');
  assert.equal(noManifest.nextAction, 'fail');
  assert.equal(noManifest.sealed, false);
});

test('assembleRangePlan：连续 range 校验/空洞报错', () => {
  const manifest = manifestWith(3);
  const plan = planPartialReassembly(manifest, partsFor(3));
  const assembly = assembleRangePlan(plan);
  assert.equal(assembly.ok, true);
  assert.equal(assembly.totalBytes, 3000);
  assert.deepEqual(assembly.gaps, []);
  assert.equal(assembly.evidence[0].code, VIDEO_RESTORE_CODES.ASSEMBLED_OK);

  const holey = assembleRangePlan({ ranges: [{ index: 0, start: 0, bytes: 1000 }, { index: 2, start: 2000, bytes: 1000 }], assembledBytes: 2000 });
  assert.equal(holey.ok, false);
  assert.equal(holey.gaps.length, 1);
  assert.equal(holey.gaps[0].expected, 1000);
});

test('reconcileAssembled：match/mismatch/skip/摘要校验', () => {
  const manifest = manifestWith(3);
  const plan = planPartialReassembly(manifest, partsFor(3));
  const match = reconcileAssembled(plan, { bytes: 3000, sha256: sha('blob') });
  assert.equal(match.ok, true);
  assert.equal(match.status, 'match');
  assert.equal(match.deltaBytes, 0);

  const mismatch = reconcileAssembled(plan, { bytes: 2500 });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(mismatch.deltaBytes, -500);
  assert.equal(mismatch.problems.some((item) => item.code === VIDEO_RESTORE_CODES.ASSEMBLED_MISMATCH), true);

  const unverified = reconcileAssembled(plan, { bytes: 3000 });
  assert.equal(unverified.ok, true);
  assert.equal(unverified.problems[0].code, VIDEO_RESTORE_CODES.ASSEMBLED_UNVERIFIED);

  const checksumMismatch = reconcileAssembled({ ...plan, assembledChecksum: sha('a') }, { bytes: 3000, checksum: sha('b') });
  assert.equal(checksumMismatch.ok, false);

  const sealed = reconcileAssembled(planPartialReassembly(manifestWith(2, { sealed: true }), partsFor(2)), { bytes: 0 });
  assert.equal(sealed.status, 'skipped');
  assert.equal(sealed.ok, true);
});

test('stalePartsPlan：不可恢复/已封存/可恢复宽限/过期/未知年龄/空目录', () => {
  const now = 10_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const candidates = [
    { recordingId: 'unrecoverable-old', manifest: { recordingId: 'unrecoverable-old', updatedAt: now - 2 * day }, parts: [{ index: 0, bytes: 100 }], plan: { recovered: false } },
    { recordingId: 'unrecoverable-recent', manifest: { recordingId: 'unrecoverable-recent', updatedAt: now - 1000 }, parts: [{ index: 0, bytes: 100 }], plan: { recovered: false } },
    { recordingId: 'sealed-old', manifest: { recordingId: 'sealed-old', updatedAt: now - day, sealed: true }, parts: [{ index: 0, bytes: 200 }], plan: { recovered: false } },
    { recordingId: 'sealed-recent', manifest: { recordingId: 'sealed-recent', updatedAt: now - 1000, sealed: true }, parts: [{ index: 0, bytes: 200 }], plan: { recovered: false } },
    { recordingId: 'recoverable-grace', manifest: { recordingId: 'recoverable-grace', updatedAt: now - 2 * day }, parts: [{ index: 0, bytes: 300 }], plan: { recovered: true } },
    { recordingId: 'recoverable-expired', manifest: { recordingId: 'recoverable-expired', updatedAt: now - (30 * day) }, parts: [{ index: 0, bytes: 400 }], plan: { recovered: true } },
    { recordingId: 'unknown-age', manifest: { recordingId: 'unknown-age' }, parts: [{ index: 0, bytes: 50 }], plan: { recovered: false } },
    { recordingId: 'empty', manifest: { recordingId: 'empty', updatedAt: 1 }, parts: [], plan: null },
    { recordingId: 'no-manifest', parts: [{ index: 0, bytes: 10 }], plan: null },
    { recordingId: '', manifest: {}, parts: [], plan: null },
  ];
  const result = stalePartsPlan(candidates, { now });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, candidates.length);
  const removed = new Map(result.remove.map((item) => [item.recordingId, item.reason]));
  const kept = new Map(result.keep.map((item) => [item.recordingId, item.reason]));
  assert.deepEqual([...removed.keys()].sort(), ['empty', 'no-manifest', 'recoverable-expired', 'sealed-old', 'unrecoverable-old']);
  assert.equal(removed.get('unrecoverable-old'), 'unrecoverable');
  assert.equal(removed.get('sealed-old'), 'sealed');
  assert.equal(removed.get('recoverable-expired'), 'expired');
  assert.equal(removed.get('no-manifest'), 'no_manifest');
  assert.equal(removed.get('empty'), 'empty');
  assert.equal(kept.get('recoverable-grace'), 'recoverable_grace');
  assert.equal(kept.get('sealed-recent'), 'sealed_recent');
  assert.equal(kept.get('unknown-age'), 'unknown_age');
  assert.equal(result.removedParts, 1 + 1 + 1 + 1 + 0);
  assert.equal(result.removedBytes, 100 + 200 + 400 + 10);
  assert.equal(result.counts.recoverable, 2);
  assert.equal(result.counts.sealed, 2);
  assert.equal(result.evidence.some((item) => item.code === VIDEO_RESTORE_CODES.STALE_UNRECOVERABLE), true);
  const summary = summarizeStaleCleanup(result);
  assert.equal(summary.remove, 5);
  assert.equal(summary.keep, 4);
  assert.ok(summary.reasons.includes('sealed'));

  // 自定义 TTL 生效
  const shortTtl = stalePartsPlan(candidates, { now, ttlMs: 500, sealedTtlMs: 500, keepRecoverableMs: 1000 });
  assert.equal(shortTtl.remove.length >= result.remove.length, true);
  assert.equal(DEFAULT_STALE_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(DEFAULT_SEALED_TTL_MS, 6 * 60 * 60 * 1000);
  assert.equal(DEFAULT_KEEP_RECOVERABLE_MS, 72 * 60 * 60 * 1000);
  assert.equal(stalePartsPlan(null).scanned, 0);
});

test('restoreRecordFields / summarizeRestore：只新增 restore 字段，封存跳过不写', () => {
  const manifest = manifestWith(3);
  const plan = planPartialReassembly(manifest, partsFor(3));
  const fields = restoreRecordFields(plan, { ok: true, status: 'match', expectedBytes: 3000, actualBytes: 3000 });
  assert.equal(fields.restore.strategy, 'complete');
  assert.equal(fields.restore.reconcile.ok, true);
  assert.equal(Array.isArray(fields.restore.evidence), true);
  assert.equal('seal' in fields, false);
  assert.deepEqual(restoreRecordFields(planPartialReassembly(manifestWith(2, { sealed: true }), partsFor(2))), {});
  assert.deepEqual(restoreRecordFields(null), {});
  assert.equal(summarizeRestore(null), null);
});
