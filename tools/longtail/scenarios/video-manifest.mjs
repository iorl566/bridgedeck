// tools/longtail/scenarios/video-manifest.mjs —— 大视频 manifest/分片（≥100 片）恢复与校验预算。
//
// 真实消费链（extension/src/lib/video-manifest.js，只读 import）：
//   createSegmentManifest → appendSegment ×N → validateManifest → sealManifest（SHA-256 双摘要）
//   → manifestRecordFields → planSegmentRecovery（完整/缺片/截断/损坏/未登记/零分片）
//
// 证据：
//   - 规模：分片数 ≥ 100、分片总字节 ≥ 目标；
//   - 校验：从 tmp 读回每个分片重新算 SHA-256，与 manifest 记录逐片一致（记录侧 vs 文件侧对账）；
//   - 恢复：6 种崩溃现场分别断言 recovered/completeness/keptSegments 与错误码；
//   - 失败原因：sealed 后追加必须 E_VIDEO_MANIFEST_SEALED；缺校验和 seal 必须 SEAL_INVALID；
//     OPFS 为空必须 SEGMENT_UNAVAILABLE；
//   - 确定性：同 seed 重建指纹一致、同一 manifest 二次 seal 摘要一致。

import { DEFAULT_SEED, stableHash, sha256Hex, sha256HexSync } from '../lib/prng.mjs';
import { resolveScale, evaluateBudget, FAILURE_CODES } from '../lib/budget.mjs';
import { measureAsync, measureSync, createMemoryTracker, nowMs, roundMs } from '../lib/measure.mjs';
import { createWorkspace } from '../lib/tmpdir.mjs';
import { buildVideoFixture, segmentContent, partRefOf } from '../gen/video.mjs';
import {
  createSegmentManifest,
  appendSegment,
  validateManifest,
  sealManifest,
  planSegmentRecovery,
  manifestRecordFields,
  summarizeManifest,
} from '../../../extension/src/lib/video-manifest.js';

export const SCENARIO = Object.freeze({
  id: 'video-manifest',
  title: '大视频 manifest/分片（≥100 片）恢复与校验预算',
  requires: ['extension/src/lib/video-manifest.js'],
});

export const REAL_MODULE_CALLS = Object.freeze([
  'extension/src/lib/video-manifest.js#createSegmentManifest',
  'extension/src/lib/video-manifest.js#appendSegment',
  'extension/src/lib/video-manifest.js#validateManifest',
  'extension/src/lib/video-manifest.js#sealManifest',
  'extension/src/lib/video-manifest.js#planSegmentRecovery',
  'extension/src/lib/video-manifest.js#manifestRecordFields',
  'extension/src/lib/video-manifest.js#summarizeManifest',
]);

/** 场景预算（可被基线覆盖）。 */
export function budgetFor(scale) {
  const video = scale.video;
  return {
    label: 'video-manifest',
    kind: 'video-manifest',
    timeMs: 20_000,
    timeWarnMs: 10_000,
    memoryMb: 384,
    checks: [
      { name: '分片数达到目标', metric: 'segments', kind: 'min', limit: video.segments, unit: 'segments', reason: '分片数低于百片目标' },
      { name: '分片总字节达到目标', metric: 'totalBytes', kind: 'min', limit: Math.floor(video.segments * video.segmentBytes * 0.85), unit: 'bytes', reason: '分片总字节不足' },
      { name: '逐片校验和一致', metric: 'checksumMatches', kind: 'equal', limit: video.segments, unit: 'segments', reason: '从磁盘重算的校验和与 manifest 不一致' },
      { name: 'manifest 校验 error 数', metric: 'validateErrors', kind: 'equal', limit: 0, unit: 'issues', reason: 'manifest 结构校验出现 error' },
      { name: 'seal 摘要合法', metric: 'digestValid', kind: 'truthy', reason: 'seal 摘要不是合法 sha256' },
      { name: 'seal 双摘要（含分片链）', metric: 'digestCount', kind: 'min', limit: 2, unit: 'digests', reason: '缺少分片链摘要' },
      { name: 'seal durability=verified', metric: 'durabilityVerified', kind: 'truthy', reason: 'seal durability 不是 verified' },
      { name: '完整恢复', metric: 'completeKept', kind: 'equal', limit: video.segments, unit: 'segments', reason: '全部分片可用时没有完整恢复' },
      { name: '缺片恢复前缀', metric: 'partialKept', kind: 'min', limit: 1, unit: 'segments', reason: '缺片时没有恢复可播放前缀' },
      { name: '截断恢复证据', metric: 'truncatedKept', kind: 'min', limit: 1, unit: 'segments', reason: '截断现场保留分片不足' },
      { name: '损坏恢复证据', metric: 'corruptKept', kind: 'min', limit: 1, unit: 'segments', reason: '校验和损坏现场保留分片不足' },
      { name: '恢复现场断言', metric: 'recoveryCasesOk', kind: 'truthy', reason: '某个崩溃现场的恢复结果与预期不符' },
      { name: 'sealed 后拒绝追加', metric: 'sealedAppendRejected', kind: 'truthy', reason: 'seal 后仍允许追加分片' },
      { name: '缺校验和 seal 失败', metric: 'sealInvalidProbeOk', kind: 'truthy', reason: '缺校验和的 manifest 仍 seal 成功' },
      { name: '空 OPFS 不可恢复', metric: 'noPartsProbeOk', kind: 'truthy', reason: '空分片仍被报告为可恢复' },
      { name: '确定性（同 seed 两次一致）', metric: 'deterministic', kind: 'truthy', reason: '视频夹具/seal 摘要不确定' },
      { name: '夹具仅写 tmpdir', metric: 'tmpOnly', kind: 'truthy', reason: '大视频分片写进了仓库' },
      { name: '真实模块消费点', metric: 'evidenceCalls', kind: 'min', limit: 7, unit: 'calls', reason: '真实模块消费证据不足' },
      { name: '预算失败原因可解释', metric: 'budgetProbeOk', kind: 'truthy', reason: '预算超限时没有给出原因码' },
      { name: '落盘耗时', metric: 'writeMs', kind: 'max', limit: 5_000, unit: 'ms', reason: '分片落盘超时' },
      { name: '追加耗时', metric: 'appendMs', kind: 'max', limit: 2_000, unit: 'ms', reason: 'manifest 追加超时' },
      { name: 'seal 耗时', metric: 'sealMs', kind: 'max', limit: 3_000, unit: 'ms', reason: 'manifest seal 超时' },
      { name: '恢复耗时', metric: 'recoveryMs', kind: 'max', limit: 2_000, unit: 'ms', reason: '分片恢复规划超时' },
      { name: 'RSS 上限', metric: 'peakRssMb', kind: 'max', limit: 1_024, unit: 'MB', reason: '绝对内存占用异常' },
    ],
  };
}

function expectedCaseMatch(recovery, expectation) {
  const kept = Number(recovery && recovery.segments) || 0;
  const codes = [...new Set((recovery && recovery.problems ? recovery.problems : []).map((problem) => problem.code))];
  return {
    ok: recovery.recovered === expectation.recovered
      && recovery.completeness === expectation.completeness
      && recovery.state === expectation.state
      && kept === expectation.keptSegments
      && expectation.codes.every((code) => codes.includes(code)),
    kept,
    codes,
  };
}

function buildAvailableParts(parts, recoveryCase, fixture) {
  let available = parts.map((part) => ({ ...part }));
  if (recoveryCase.dropAll) return [];
  if (Array.isArray(recoveryCase.dropIndexes)) {
    available = available.filter((part) => !recoveryCase.dropIndexes.includes(part.index));
  }
  if (recoveryCase.truncate) {
    available = available.map((part) => (part.index === recoveryCase.truncate.index
      ? { ...part, bytes: recoveryCase.truncate.bytes }
      : part));
  }
  if (Array.isArray(recoveryCase.corruptIndexes)) {
    available = available.map((part) => (recoveryCase.corruptIndexes.includes(part.index)
      ? { ...part, checksum: sha256HexSync('longtail-corrupt-' + part.index) }
      : part));
  }
  if (recoveryCase.extraPart) available = available.concat([{ ...recoveryCase.extraPart }]);
  // 未使用的 fixture 参数：保留签名一致，便于未来扩展 case。
  void fixture;
  return available;
}

/**
 * @param {{scale?:string, seed?:string|number, keepTmp?:boolean}} [options]
 */
export async function run(options = {}) {
  const scale = resolveScale(options.scale || 'default');
  const seed = options.seed == null ? DEFAULT_SEED : options.seed;
  const totalStart = nowMs();
  const tracker = createMemoryTracker();
  const workspace = createWorkspace({ label: 'video', seed, keep: options.keepTmp === true });
  const evidence = { realModuleCalls: [...REAL_MODULE_CALLS], fixture: null, manifest: null, recovery: null, probes: null };
  try {
    // 1) 生成夹具 + 把分片内容写进 tmp（真实文件 I/O；仓库不落大文件）。
    const generated = measureSync(() => buildVideoFixture({
      segments: scale.video.segments,
      segmentBytes: scale.video.segmentBytes,
      budgetBytes: scale.video.budgetBytes,
      seed,
      profile: scale.name,
    }), { label: 'generate' });
    if (!generated.ok) throw new Error('video fixture 生成失败：' + generated.error.message);
    const fixture = generated.value;
    const written = measureSync(() => {
      let bytes = 0;
      for (const segment of fixture.segments) {
        const content = segmentContent(segment);
        workspace.writeBytes('parts/part-' + String(segment.index).padStart(5, '0') + '.bin', content);
        bytes += content.length;
      }
      return { bytes };
    }, { label: 'write-parts' });
    tracker.sample();

    // 2) 模拟 OPFS 扫描：列目录 → 逐文件读回 → 重新算 SHA-256。
    const scan = measureSync(() => {
      const files = workspace.listFiles('parts');
      const parts = [];
      let checksumMatches = 0;
      for (const file of files) {
        const index = Number(/part-(\d+)\.bin$/.exec(file.path)[1]);
        // 二进制必须按字节读回，否则 UTF-8 解码会损坏内容、校验和必然对不上。
        const content = workspace.readBytes('parts/' + file.path.slice('parts/'.length));
        const checksum = sha256HexSync(content);
        const segment = fixture.segments.find((item) => item.index === index);
        if (segment && checksum === segment.checksum) checksumMatches += 1;
        parts.push({ index, bytes: content.length, checksum, position: segment ? segment.atMs : null });
      }
      return { files: files.length, parts, checksumMatches };
    }, { label: 'scan-parts' });
    const scanned = scan.value;

    // 3) manifest：创建 → 逐片追加（真实 appendSegment）→ 校验。
    const created = measureSync(() => createSegmentManifest({
      recordingId: fixture.recordingId,
      now: fixture.baseAt,
      startedAt: fixture.baseAt,
      codec: fixture.codec,
      mime: fixture.mime,
      mode: fixture.mode,
      tabId: fixture.tabId,
      url: fixture.url,
      title: fixture.title,
      budget: fixture.budget,
    }), { label: 'create-manifest' });
    const appended = measureSync(() => {
      let manifest = created.value;
      const failures = [];
      for (const segment of fixture.segments) {
        const result = appendSegment(manifest, {
          index: segment.index,
          atMs: segment.atMs,
          lastFrameAt: segment.lastFrameAt,
          bytes: segment.bytes,
          codec: segment.codec,
          checksum: segment.checksum,
        });
        if (!result.ok) {
          failures.push({ index: segment.index, code: result.code });
          break;
        }
        manifest = result.manifest;
      }
      return { manifest, failures };
    }, { label: 'append-segments' });
    const manifest = appended.value.manifest;
    const validation = measureSync(() => validateManifest(manifest, { requireChecksum: true }), { label: 'validate-manifest' });
    const summary = measureSync(() => summarizeManifest(manifest), { label: 'summarize-manifest' });
    tracker.sample();

    // 4) seal（真实 SHA-256 双摘要），并把录制记录字段对齐。
    const sealed = await measureAsync(() => sealManifest(manifest, {
      at: fixture.baseAt + 1_000_000,
      requireChecksum: true,
      digest: sha256Hex,
    }), { label: 'seal-manifest' });
    const sealedManifest = sealed.value.sealed;
    const recordFields = measureSync(() => manifestRecordFields(sealedManifest, null), { label: 'record-fields' });
    tracker.sample();

    // 5) 6 种恢复现场（全部走真实 planSegmentRecovery）。
    const recoveryRun = measureSync(() => fixture.recoveryCases.map((recoveryCase) => {
      const available = buildAvailableParts(scanned.parts, recoveryCase, fixture);
      const recovery = planSegmentRecovery(sealedManifest, available, { recordingId: fixture.recordingId });
      const match = expectedCaseMatch(recovery, recoveryCase.expect);
      return {
        name: recoveryCase.name,
        description: recoveryCase.description,
        expected: recoveryCase.expect,
        recovered: recovery.recovered,
        completeness: recovery.completeness,
        state: recovery.state,
        keptSegments: match.kept,
        codes: match.codes,
        ok: match.ok,
        bytes: recovery.bytes,
        truncatedSegments: (recovery.truncatedSegments || []).length,
      };
    }), { label: 'recovery-cases' });
    const recoveryResults = recoveryRun.value;
    const recoveryCasesOk = recoveryResults.every((result) => result.ok);
    const byName = new Map(recoveryResults.map((result) => [result.name, result]));
    tracker.sample();

    // 6) 失败原因探针：sealed 追加 / 缺校验和 seal / 空 OPFS。
    const sealedAppend = appendSegment(sealedManifest, {
      index: fixture.segments.length,
      atMs: fixture.segments[fixture.segments.length - 1].lastFrameAt + 10,
      bytes: 1024,
      checksum: sha256HexSync('after-seal'),
    });
    const noChecksumManifest = measureSync(() => {
      let current = createSegmentManifest({ recordingId: fixture.recordingId, now: fixture.baseAt, codec: fixture.codec });
      for (const segment of fixture.segments.slice(0, 3)) {
        const result = appendSegment(current, {
          index: segment.index,
          atMs: segment.atMs,
          lastFrameAt: segment.lastFrameAt,
          bytes: segment.bytes,
          codec: segment.codec,
        }, { requireChecksum: false });
        if (result.ok) current = result.manifest;
      }
      return current;
    }, { label: 'no-checksum-manifest' });
    const sealInvalid = await sealManifest(noChecksumManifest.value, { at: fixture.baseAt, requireChecksum: true, digest: sha256Hex });
    const noPartsRecovery = planSegmentRecovery(sealedManifest, []);
    const probeBudget = budgetFor(scale);
    const overBudget = evaluateBudget({
      budget: probeBudget,
      metrics: { timeMs: probeBudget.timeMs + 1, peakHeapUsedMb: probeBudget.memoryMb + 1 },
    });
    const overCodes = (overBudget.failures || []).map((failure) => failure.code);
    const sealedAppendRejected = sealedAppend.ok === false && String(sealedAppend.code).includes('MANIFEST_SEALED');
    const sealInvalidProbeOk = sealInvalid.ok === false && String(sealInvalid.code).includes('SEAL_INVALID');
    const noPartsProbeOk = noPartsRecovery.recovered === false
      && [...new Set((noPartsRecovery.problems || []).map((problem) => problem.code))].includes('E_VIDEO_SEGMENT_UNAVAILABLE');
    const budgetProbeOk = overCodes.includes(FAILURE_CODES.TIME) && overCodes.includes(FAILURE_CODES.MEMORY);

    // 7) 确定性：同 seed 重建指纹一致；同一 manifest 二次 seal 摘要一致。
    const rebuilt = buildVideoFixture({
      segments: scale.video.segments,
      segmentBytes: scale.video.segmentBytes,
      budgetBytes: scale.video.budgetBytes,
      seed,
      profile: scale.name,
    });
    const secondSeal = await sealManifest(manifest, { at: fixture.baseAt + 1_000_000, requireChecksum: true, digest: sha256Hex });
    const digest = String(sealed.value.evidence && sealed.value.evidence.digest ? sealed.value.evidence.digest : '');
    const secondDigest = String(secondSeal.sealed && secondSeal.sealed.seal ? secondSeal.sealed.seal.digest : '');
    const digestValid = /^[0-9a-f]{64}$/.test(digest);
    const deterministic = rebuilt.fingerprint === fixture.fingerprint && digest === secondDigest && digestValid;
    const digestCount = [digest, sealed.value.evidence && sealed.value.evidence.segmentsDigest]
      .filter((item) => typeof item === 'string' && item.length > 0).length;

    const metrics = {
      timeMs: roundMs(nowMs() - totalStart),
      generateMs: generated.stats.median,
      writeMs: written.stats.median,
      scanMs: scan.stats.median,
      createMs: created.stats.median,
      appendMs: appended.stats.median,
      validateMs: validation.stats.median,
      summarizeMs: summary.stats.median,
      sealMs: sealed.stats.median,
      recordFieldsMs: recordFields.stats.median,
      recoveryMs: recoveryRun.stats.median,
      segments: scanned.parts.length,
      totalBytes: written.value.bytes,
      checksumMatches: scanned.checksumMatches,
      manifestSegments: Number(summary.value && summary.value.segments) || 0,
      manifestBytes: Number(summary.value && summary.value.bytes) || 0,
      validateErrors: (validation.value.problems || []).filter((problem) => problem.severity === 'error').length,
      validateWarnings: (validation.value.problems || []).filter((problem) => problem.severity === 'warning').length,
      appendFailures: appended.value.failures.length,
      sealed: Boolean(sealedManifest && sealedManifest.sealed),
      digestValid,
      digestCount,
      durabilityVerified: Boolean(sealed.value.evidence && sealed.value.evidence.durability === 'verified'),
      recordChunkCount: Number(recordFields.value && recordFields.value.chunk_count) || 0,
      recordFragments: Array.isArray(recordFields.value && recordFields.value.fragments) ? recordFields.value.fragments.length : 0,
      completeKept: byName.has('complete') ? byName.get('complete').keptSegments : 0,
      partialKept: byName.has('missing-middle') ? byName.get('missing-middle').keptSegments : 0,
      truncatedKept: byName.has('truncated') ? byName.get('truncated').keptSegments : 0,
      corruptKept: byName.has('checksum-mismatch') ? byName.get('checksum-mismatch').keptSegments : 0,
      unlistedCompleteness: byName.has('unlisted-part') ? byName.get('unlisted-part').completeness : '',
      noPartsCompleteness: byName.has('no-parts') ? byName.get('no-parts').completeness : '',
      recoveryCasesOk,
      sealedAppendRejected,
      sealInvalidProbeOk,
      noPartsProbeOk,
      deterministic,
      tmpOnly: workspace.isTmpOnly(),
      evidenceCalls: evidence.realModuleCalls.length,
      budgetProbeOk,
      peakHeapUsedMb: 0,
      peakRssMb: 0,
    };
    const memory = tracker.finish();
    metrics.peakHeapUsedMb = memory.peakHeapUsedMb;
    metrics.peakRssMb = memory.peakRssMb;
    workspace.assertSafe();
    return {
      id: SCENARIO.id,
      title: SCENARIO.title,
      scale: scale.name,
      seed: String(seed),
      ok: true,
      metrics,
      evidence: {
        ...evidence,
        fixture: {
          kind: 'video',
          fingerprint: fixture.fingerprint,
          recordingId: fixture.recordingId,
          segments: fixture.segments.length,
          files: workspace.listFiles('parts').length,
          bytes: written.value.bytes,
          tmp: workspace.dir,
        },
        manifest: {
          summary: summary.value,
          seal: sealedManifest && sealedManifest.seal ? {
            digest: sealedManifest.seal.digest,
            segmentsDigest: sealedManifest.seal.segmentsDigest || null,
            durability: sealedManifest.seal.durability,
            segments: sealedManifest.seal.segments,
            bytes: sealedManifest.seal.segmentsBytes,
            invariants: sealedManifest.seal.invariants,
          } : null,
          recordFields: {
            chunk_count: recordFields.value.chunk_count,
            segment_bytes: recordFields.value.segment_bytes,
            segment_duration_ms: recordFields.value.segment_duration_ms,
            firstFragment: (recordFields.value.fragments || [])[0] || null,
            lastFragment: (recordFields.value.fragments || [])[recordFields.value.fragments.length - 1] || null,
          },
        },
        recovery: {
          cases: recoveryResults,
          truncatedEvidence: (byName.get('truncated') || {}).codes || [],
          corruptEvidence: (byName.get('checksum-mismatch') || {}).codes || [],
        },
        probes: {
          sealedAppend: { code: sealedAppend.code || null, rejected: sealedAppendRejected },
          sealInvalid: { code: sealInvalid.code || null, ok: sealInvalidProbeOk },
          noParts: { recovered: noPartsRecovery.recovered, codes: (noPartsRecovery.problems || []).map((problem) => problem.code) },
          overBudget: { level: overBudget.level, codes: overCodes },
        },
      },
      keptTmp: workspace.keep,
      tmpDir: workspace.keep ? workspace.dir : null,
    };
  } finally {
    if (!workspace.keep) workspace.cleanup();
  }
}
