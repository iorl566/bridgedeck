import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendSegment,
  createSegmentManifest,
  sealManifest,
  segmentChainDigestInput,
  sealInvariants,
} from '../../extension/src/lib/video-manifest.js';
import {
  SEAL_CHECK_CODES,
  SEAL_MAX_VERSION,
  SEAL_STATUSES,
  canonicalSeal,
  computeSealDigests,
  inspectRecordSeal,
  normalizeSealEnvelope,
  reconcileSeal,
  sealDigestInputs,
  sealRecordPatch,
  segmentChainFromFragments,
  summarizeSealCheck,
  verifyRecordSeal,
  verifySeal,
} from '../../extension/src/lib/video-seal.js';

const digest = async (text) => createHash('sha256').update(String(text)).digest('hex');
const sha = (text) => createHash('sha256').update(text).digest('hex');

function segment(index, overrides = {}) {
  return {
    index,
    atMs: index * 1000,
    bytes: 1000 + index,
    codec: 'avc',
    lastFrameAt: index * 1000 + 900,
    checksum: sha('segment-' + index),
    ...overrides,
  };
}

function manifestWith(count) {
  let manifest = createSegmentManifest({ recordingId: 'rec-seal', codec: 'avc', startedAt: 100, now: 100, budget: { maxSegmentBytes: 4096 } });
  for (let index = 0; index < count; index += 1) {
    const appended = appendSegment(manifest, segment(index));
    assert.equal(appended.ok, true);
    manifest = appended.manifest;
  }
  return manifest;
}

async function sealedWith(count = 3, at = 5000) {
  const manifest = manifestWith(count);
  const result = await sealManifest(manifest, { at, digest });
  assert.equal(result.ok, true);
  return result.sealed;
}

/** 模拟 opfs-encoded-store.sealPatch 写回 IDB 的记录（只带摘要字段 + fragments）。 */
function recordOf(sealed, overrides = {}) {
  const seal = sealed.seal;
  return {
    id: sealed.recordingId || 'rec-seal',
    codec: sealed.codec,
    mime: sealed.mime,
    sealed: true,
    sealedAt: sealed.sealedAt,
    completeness: 'complete',
    stop_reason: 'user',
    bytes: sealed.totalBytes + 1024,
    chunk_count: sealed.segments.length,
    fragments: sealed.segments.map((item) => ({ index: item.index, at: item.atMs, bytes: item.bytes, sha256: item.checksum })),
    seal: {
      digest: seal.digest,
      at: seal.at,
      segments: seal.segments,
      bytes: seal.segmentsBytes,
      durability: seal.durability,
      ...(seal.segmentsDigest ? { segmentsDigest: seal.segmentsDigest } : {}),
    },
    ...overrides,
  };
}

test('sealManifest v2 信封：链摘要/不变量快照可独立重算', async () => {
  const sealed = await sealedWith(3);
  assert.equal(sealed.seal.version, 2);
  assert.equal(sealed.seal.algorithm, 'sha256');
  assert.equal(sealed.seal.segments, 3);
  assert.equal(sealed.seal.segmentsBytes, 3003);
  assert.equal(sealed.seal.durability, 'verified');
  assert.match(sealed.seal.digest, /^[0-9a-f]{64}$/);
  assert.equal(sealed.seal.segmentsDigest, await digest(segmentChainDigestInput(sealed)));
  assert.deepEqual(sealed.seal.invariants, sealInvariants(sealed));
  assert.equal(sealed.seal.invariants.segments, 3);
  assert.equal(sealed.seal.invariants.bytes, 3003);
  // 规范输入与 sealedAt/createdAt 无关，因此同一 manifest 的摘要稳定
  assert.equal(sealed.seal.digest, await digest(sealDigestInputs(sealed).manifest));
});

test('normalizeSealEnvelope：缺失/坏摘要/版本/算法逐项给证据', () => {
  const missing = normalizeSealEnvelope(null);
  assert.equal(missing.present, false);
  assert.deepEqual(missing.problems, []);

  const invalid = normalizeSealEnvelope({ version: 2, algorithm: 'sha256', digest: 'not-a-hash', segments: 1 });
  assert.equal(invalid.present, true);
  assert.equal(invalid.digest, '');
  assert.equal(invalid.problems.some((item) => item.code === SEAL_CHECK_CODES.DIGEST_INVALID && item.severity === 'error'), true);

  const unsupported = normalizeSealEnvelope({ version: SEAL_MAX_VERSION + 7, algorithm: 'sha256', digest: sha('x') });
  assert.equal(unsupported.problems.some((item) => item.code === SEAL_CHECK_CODES.VERSION_UNSUPPORTED && item.severity === 'error'), true);

  const legacy = normalizeSealEnvelope({ version: 1, algorithm: 'sha256', digest: sha('x') });
  assert.equal(legacy.problems.some((item) => item.code === SEAL_CHECK_CODES.LEGACY && item.severity === 'warning'), true);

  const badAlgorithm = normalizeSealEnvelope({ version: 2, algorithm: 'md5', digest: sha('x') });
  assert.equal(badAlgorithm.problems.some((item) => item.code === SEAL_CHECK_CODES.ALGORITHM_UNSUPPORTED), true);

  const badChain = normalizeSealEnvelope({ version: 2, algorithm: 'sha256', digest: sha('x'), segmentsDigest: 'zz' });
  assert.equal(badChain.problems.some((item) => item.code === SEAL_CHECK_CODES.DIGEST_INVALID && item.scope === 'segments_chain'), true);
  assert.equal(canonicalSeal(null), 'null');
});

test('verifySeal：完整信封重算摘要 + 链摘要，状态 sealed', async () => {
  const sealed = await sealedWith(3);
  const result = await verifySeal(sealed, { now: 6000, digest });
  assert.equal(result.status, 'sealed');
  assert.equal(result.ok, true);
  assert.equal(result.sealed, true);
  assert.equal(result.checks.digest.verified, true);
  assert.equal(result.checks.segments.chain.verified, true);
  assert.equal(result.checks.durability.consistent, true);
  assert.equal(result.checks.envelope.version, 2);
  assert.equal(result.checks.stats.segments, 3);
  assert.equal(result.summary.status, 'sealed');
  assert.equal(result.summary.digest_verified, true);
  assert.equal(result.summary.segments_digest_verified, true);
  assert.equal(result.summary.segments, 3);
  assert.deepEqual(result.evidence, []);
});

test('verifySeal：分片被改动 → stats/摘要/链摘要同时报错，状态 tampered', async () => {
  const sealed = await sealedWith(3);
  const tampered = structuredClone(sealed);
  tampered.segments[1].bytes = 999_999;
  const result = await verifySeal(tampered, { now: 6000, digest });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'tampered');
  const codes = new Set(result.problems.map((item) => item.code));
  assert.equal(codes.has(SEAL_CHECK_CODES.DIGEST_MISMATCH), true);
  assert.equal(codes.has(SEAL_CHECK_CODES.SEGMENTS_DIGEST_MISMATCH), true);
  assert.equal(codes.has(SEAL_CHECK_CODES.STATS_MISMATCH), true);
  assert.equal(codes.has(SEAL_CHECK_CODES.SEGMENTS_COUNT_MISMATCH), false);
  assert.equal(result.checks.digest.verified, false);
});

test('verifySeal：durability=verified 但缺校验和 → DURABILITY_INCONSISTENT', async () => {
  const sealed = await sealedWith(3);
  const broken = structuredClone(sealed);
  broken.segments[2].checksum = '';
  const result = await verifySeal(broken, { now: 6000, digest: async () => sha('fake') });
  assert.equal(result.ok, false);
  assert.equal(result.problems.some((item) => item.code === SEAL_CHECK_CODES.DURABILITY_INCONSISTENT && item.severity === 'error'), true);
  // durability 声称 verified 时缺校验和属于 error
  assert.equal(result.checks.durability.consistent, false);
});

test('verifySeal：未封存/缺失/摘要不可用/跳过摘要/过期/未来时间', async () => {
  const unsealed = manifestWith(2);
  const unsealedResult = await verifySeal(unsealed, { now: 1000, digest });
  assert.equal(unsealedResult.status, 'unsealed');
  assert.equal(unsealedResult.sealed, false);
  assert.equal(unsealedResult.ok, true);

  const missing = await verifySeal(null);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].code, SEAL_CHECK_CODES.MISSING);

  const sealed = await sealedWith(2, 5000);
  const unavailable = await verifySeal(sealed, { now: 6000, digest: async () => { throw new Error('subtle down'); } });
  assert.equal(unavailable.ok, true, '摘要不可用只是 warning，不判 tampered');
  assert.equal(unavailable.checks.digest.verified, false);
  assert.equal(unavailable.problems.some((item) => item.code === SEAL_CHECK_CODES.DIGEST_UNAVAILABLE), true);

  const skipped = await verifySeal(sealed, { now: 6000, digest: false });
  assert.equal(skipped.checks.digest.skipped, true);
  assert.equal(skipped.ok, true);

  const stale = await verifySeal(sealed, { now: 5000 + 10_000, digest, maxAgeMs: 1000 });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.checks.timing.stale, true);
  assert.equal(stale.summary.stale, true);
  assert.equal(stale.ok, true, '过期只是 warning，清理由 prune 负责');

  const futureSealed = await sealedWith(2, 600_000);
  const future = await verifySeal(futureSealed, { now: 1000, digest });
  assert.equal(future.checks.timing.fromFuture, true);
  assert.equal(future.problems.some((item) => item.code === SEAL_CHECK_CODES.FROM_FUTURE), true);
});

test('verifySeal：缺 seal 信封/统计字段不一致/旧版本兼容', async () => {
  const sealed = await sealedWith(2);
  const noEnvelope = structuredClone(sealed);
  delete noEnvelope.seal;
  const noEnvelopeResult = await verifySeal(noEnvelope, { now: 6000, digest });
  assert.equal(noEnvelopeResult.status, 'tampered');
  assert.equal(noEnvelopeResult.problems.some((item) => item.code === SEAL_CHECK_CODES.ENVELOPE_MISSING), true);

  const badTotal = structuredClone(sealed);
  badTotal.totalBytes = 12345;
  const badTotalResult = await verifySeal(badTotal, { now: 6000, digest });
  assert.equal(badTotalResult.problems.some((item) => item.code === SEAL_CHECK_CODES.STATS_MISMATCH), true);

  const legacy = structuredClone(sealed);
  legacy.seal = { version: 1, algorithm: 'sha256', at: legacy.sealedAt, digest: legacy.seal.digest, segments: 2, segmentsBytes: legacy.seal.segmentsBytes, codec: 'avc', durability: 'verified' };
  const legacyResult = await verifySeal(legacy, { now: 6000, digest });
  assert.equal(legacyResult.ok, true);
  assert.equal(legacyResult.checks.envelope.legacy, true);
  assert.equal(legacyResult.problems.some((item) => item.code === SEAL_CHECK_CODES.LEGACY), true);
  assert.equal(SEAL_STATUSES.includes(legacyResult.status), true);
});

test('computeSealDigests / sealDigestInputs：确定性且可从 fragments 重算链摘要', async () => {
  const sealed = await sealedWith(4);
  const first = await computeSealDigests(sealed, { digest });
  const second = await computeSealDigests(structuredClone(sealed), { digest });
  assert.equal(first.ok, true);
  assert.equal(first.manifestDigest, second.manifestDigest);
  assert.equal(first.segmentsDigest, second.segmentsDigest);
  assert.equal(first.manifestDigest, sealed.seal.digest);

  const chain = segmentChainFromFragments(sealed.segments.map((item) => ({ index: item.index, bytes: item.bytes, sha256: item.checksum })));
  assert.equal(chain.ok, true);
  assert.equal(chain.segments.length, 4);
  const inputs = sealDigestInputs({ recordingId: sealed.recordingId, codec: sealed.codec, segments: chain.segments });
  assert.equal(inputs.segments, segmentChainDigestInput(sealed));

  const broken = segmentChainFromFragments([{ index: 0, bytes: 0, sha256: '' }]);
  assert.equal(broken.ok, false);
  assert.equal(broken.problems.length, 2);
});

test('inspectRecordSeal：记录侧一致性（未封存/正常/分片数不符/字节不符/缺信封）', async () => {
  const unsealed = inspectRecordSeal({ id: 'r', bytes: 10, completeness: 'partial' });
  assert.equal(unsealed.ok, true);
  assert.equal(unsealed.status, 'unsealed');

  const sealed = await sealedWith(3);
  const record = recordOf(sealed);
  const checked = inspectRecordSeal(record, { now: 6000 });
  assert.equal(checked.ok, true);
  assert.equal(checked.status, 'sealed');
  assert.equal(checked.summary.segments, 3);
  assert.equal(checked.summary.bytes, 3003);
  assert.equal(checked.summary.durability, 'verified');

  const badCount = recordOf(sealed, { chunk_count: 5 });
  const badCountCheck = inspectRecordSeal(badCount, { now: 6000 });
  assert.equal(badCountCheck.ok, false);
  assert.equal(badCountCheck.problems.some((item) => item.code === SEAL_CHECK_CODES.SEGMENTS_COUNT_MISMATCH), true);

  const badBytes = recordOf(sealed, { segment_manifest: { segments: 3, bytes: 777 } });
  const badBytesCheck = inspectRecordSeal(badBytes, { now: 6000 });
  assert.equal(badBytesCheck.problems.some((item) => item.code === SEAL_CHECK_CODES.STATS_MISMATCH), true);

  const missingEnvelope = { id: 'r', sealed: true, seal: null };
  const missingCheck = inspectRecordSeal(missingEnvelope, { now: 6000 });
  assert.equal(missingCheck.sealed, false, '没有 seal 字段不能宣称已封存');
  assert.equal(missingCheck.ok, false);
  assert.equal(missingCheck.status, 'tampered');
  assert.equal(missingCheck.problems[0].code, SEAL_CHECK_CODES.ENVELOPE_MISSING);
});

test('verifyRecordSeal：记录 + OPFS manifest 双侧对账；fragments 被改会命中链摘要', async () => {
  const sealed = await sealedWith(3);
  const record = recordOf(sealed);
  const both = await verifyRecordSeal(record, { now: 6000, digest, manifest: sealed });
  assert.equal(both.ok, true);
  assert.equal(both.source, 'record+manifest');
  assert.equal(both.checks.reconcile.same, true);
  assert.equal(both.summary.digest_verified, true);
  assert.equal(both.summary.segments_digest_verified, true);

  // 记录侧 fragements 与 seal 不一致（内容被改）
  const tamperedRecord = recordOf(sealed);
  tamperedRecord.fragments[0].sha256 = sha('evil');
  const tampered = await verifyRecordSeal(tamperedRecord, { now: 6000, digest });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.problems.some((item) => item.code === SEAL_CHECK_CODES.SEGMENTS_DIGEST_MISMATCH), true);
  assert.equal(tampered.summary.segments_digest_verified, undefined);

  // 记录侧与 manifest 侧摘要不一致
  const mismatchRecord = recordOf(sealed, { seal: { ...recordOf(sealed).seal, digest: sha('other') } });
  const mismatch = await verifyRecordSeal(mismatchRecord, { now: 6000, digest, manifest: sealed });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.problems.some((item) => item.code === SEAL_CHECK_CODES.RECONCILE_MISMATCH), true);
});

test('verifyRecordSeal：记录侧没有 seal（IDB 兜底路径）时 manifest 封存只作附加证据', async () => {
  const sealed = await sealedWith(2);
  const record = recordOf(sealed);
  record.sealed = false;
  record.seal = undefined;
  record.completeness = 'partial';
  const result = await verifyRecordSeal(record, { now: 6000, digest, manifest: sealed });
  assert.equal(result.sealed, false);
  assert.equal(result.status, 'unsealed', '记录未封存就不能因为 manifest 侧封存而判 tampered');
  assert.equal(result.checks.reconcile.skipped, true);
  assert.equal(result.problems.some((item) => item.code === SEAL_CHECK_CODES.RECONCILE_MISMATCH), false);
  assert.equal(result.checks.manifest_status, 'sealed');
});

test('reconcileSeal：同源/摘要冲突/单侧缺失', async () => {  const sealed = await sealedWith(2);
  const recordSeal = recordOf(sealed).seal;
  const same = reconcileSeal(recordSeal, sealed.seal);
  assert.equal(same.ok, true);
  assert.equal(same.same, true);
  assert.deepEqual(same.differences, []);

  const conflicting = reconcileSeal({ ...recordSeal, digest: sha('nope') }, sealed.seal);
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.differences.some((item) => item.field === 'digest'), true);
  assert.equal(conflicting.problems[0].code, SEAL_CHECK_CODES.RECONCILE_MISMATCH);

  const oneSide = reconcileSeal(null, sealed.seal);
  assert.equal(oneSide.same, false);
  assert.equal(oneSide.differences[0].field, 'present');
});

test('summarizeSealCheck / sealRecordPatch：紧凑输出且只新增字段', async () => {
  const sealed = await sealedWith(2);
  const record = recordOf(sealed);
  const checked = await verifyRecordSeal(record, { now: 6000, digest });
  const summary = summarizeSealCheck(checked);
  assert.equal(summary.ok, true);
  assert.equal(summary.status, 'sealed');
  assert.equal(summary.source, 'record');
  assert.equal(summary.errors, 0);
  assert.equal(typeof summary.digest_verified, 'boolean');

  const patch = sealRecordPatch(checked);
  assert.equal(patch.seal_verified, true);
  assert.equal(patch.seal_check.status, 'sealed');
  assert.equal(Array.isArray(patch.seal_evidence), true);
  assert.equal('seal' in patch, false, '不回写/覆盖既有 seal 字段');
  assert.deepEqual(sealRecordPatch(null), {});
});
