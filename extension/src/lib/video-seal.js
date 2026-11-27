// extension/src/lib/video-seal.js —— manifest seal 的封存字段校验 / 摘要重算 / 两侧对账。
//
// 现有链路（video-manifest.sealManifest → opfs-encoded-store.sealEncodedManifestDetailed）
// 负责“封存”：连续性校验通过后写 sealed manifest，并把 seal 摘要回写 IDB 记录（记录侧只剩
// digest/at/segments/bytes/durability 这几个字段，分片描述在 OPFS manifest 里）。
//
// 本模块补的是“封存之后还能不能证明它没被动过”，全部是纯逻辑 + 可注入摘要：
//
//   1) 信封结构：seal.version / algorithm / digest 格式 / invariants 快照是否齐全；
//   2) 规范摘要重算：用 sealDigestInput(manifest) 重算 SHA-256，与 seal.digest 逐字节比较
//      —— 不一致即 TAMPERED（分片描述/codec/mime/mode 任意一项被改动都会变）；
//   3) 分片链摘要：v2 信封额外记录 segmentChainDigestInput 的摘要（只覆盖 index/bytes/checksum，
//      不含时间戳），因此录制记录里的 fragments 也能独立重算，用于“记录侧 ↔ manifest 侧”对账；
//   4) 不变量对账：seal.invariants / seal.segments / seal.segmentsBytes 与当前 manifest 统计逐项比较；
//   5) durability 自洽：seal 声称 verified 但分片缺校验和 → DURABILITY_INCONSISTENT（error）；
//   6) 时间：sealedAt 来自未来（超过时钟容差）或超过 maxAgeMs → 结构化 warning/stale。
//
// 运行时消费点：
//   - video.verify（video.js verifyVideo）：完整校验（若能在 SW 侧读到 OPFS manifest）；
//   - video.fetch / 保存（video.js fetchVideo）：保存前把 seal 校验结果作为附加证据返回；
//   - video.list（video.js listVideos）：逐条做零成本的记录侧一致性检查（不重算摘要）；
//   - video.status（video.js videoStatus）：最近一条录制同样带记录侧检查。
// 所有消费都只新增字段，不改变既有字段与既有 ok 语义。

import {
  VIDEO_SEAL_ENVELOPE_VERSION,
  sealDigestInput,
  segmentChainDigestInput,
  sealInvariants,
  stableStringify,
  summarizeManifest,
  validateManifest,
} from './video-manifest.js';
import { SEAL_CHECK_CODES } from './video-codes.js';

export { SEAL_CHECK_CODES };

/** seal 信封版本范围：1 = 仅规范摘要；2 = 规范摘要 + 分片链摘要 + 不变量快照。 */
export const SEAL_MIN_VERSION = 1;
export const SEAL_MAX_VERSION = VIDEO_SEAL_ENVELOPE_VERSION;
export const SEAL_STATUSES = Object.freeze(['missing', 'unsealed', 'sealed', 'tampered', 'stale', 'unsupported']);
/** 默认不因“旧”而告警（TTL 由 video.prune 负责）；调用方需要时可显式传 maxAgeMs。 */
export const SEAL_DEFAULT_MAX_AGE_MS = 0;
/** 允许的时钟偏差：sealedAt 比 now 大超过该值视为来自未来。 */
export const SEAL_CLOCK_SKEW_MS = 5 * 60 * 1000;

const CHECKSUM_RE = /^[0-9a-f]{64}$/;
const ALGORITHM = 'sha256';

function problem(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function normalizeChecksum(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return CHECKSUM_RE.test(text) ? text : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function defaultDigest(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('crypto.subtle 不可用');
  const bytes = new TextEncoder().encode(String(text));
  const hash = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 归一化 seal 信封。不认识/缺失的字段落到安全值，结构问题以 problem 形式返回（不抛异常）。
 * @returns {{present:boolean, version:number, algorithm:string, digest:string, at:number,
 *   segments:number, segmentsBytes:number, codec:string, durability:string, warnings:number,
 *   segmentsDigest:string, invariants:object|null, problems:Array, raw:object|null}}
 */
export function normalizeSealEnvelope(seal) {
  const problems = [];
  if (!isPlainObject(seal)) {
    return {
      present: false,
      version: 0,
      algorithm: '',
      digest: '',
      at: 0,
      segments: 0,
      segmentsBytes: 0,
      codec: '',
      durability: '',
      warnings: 0,
      segmentsDigest: '',
      invariants: null,
      problems,
      raw: null,
    };
  }
  const version = Number(seal.version);
  const algorithm = String(seal.algorithm || '');
  const rawDigest = String(seal.digest || '');
  const digest = normalizeChecksum(rawDigest);
  if (rawDigest !== '' && !digest) {
    problems.push(problem(SEAL_CHECK_CODES.DIGEST_INVALID, 'error', 'seal 摘要格式非法（应为 64 位小写 hex）', { digest: rawDigest.slice(0, 80) }));
  }
  const envelopeVersion = Number.isSafeInteger(version) && version > 0 ? version : 0;
  if (envelopeVersion === 0) {
    problems.push(problem(SEAL_CHECK_CODES.VERSION_UNSUPPORTED, 'warning', 'seal 信封缺少版本号（按 v1 兼容处理）', {}));
  } else if (envelopeVersion > SEAL_MAX_VERSION) {
    problems.push(problem(SEAL_CHECK_CODES.VERSION_UNSUPPORTED, 'error', 'seal 信封版本高于当前实现，无法完整校验', { version: envelopeVersion, max: SEAL_MAX_VERSION }));
  } else if (envelopeVersion < SEAL_MIN_VERSION) {
    problems.push(problem(SEAL_CHECK_CODES.VERSION_UNSUPPORTED, 'error', 'seal 信封版本低于最小支持版本', { version: envelopeVersion, min: SEAL_MIN_VERSION }));
  } else if (envelopeVersion < VIDEO_SEAL_ENVELOPE_VERSION) {
    problems.push(problem(SEAL_CHECK_CODES.LEGACY, 'warning', '旧版 seal 信封（无分片链摘要/不变量快照）', { version: envelopeVersion }));
  }
  const rawAlgorithm = String(seal.algorithm || ALGORITHM).toLowerCase();
  if (rawAlgorithm !== ALGORITHM) {
    problems.push(problem(SEAL_CHECK_CODES.ALGORITHM_UNSUPPORTED, 'error', 'seal 摘要算法不受支持', { algorithm: algorithm || rawAlgorithm }));
  }
  const rawSegmentsDigest = String(seal.segmentsDigest || '');
  const segmentsDigest = normalizeChecksum(rawSegmentsDigest);
  if (rawSegmentsDigest && !segmentsDigest) {
    problems.push(problem(SEAL_CHECK_CODES.DIGEST_INVALID, 'error', '分片链摘要格式非法', { scope: 'segments_chain', segmentsDigest: rawSegmentsDigest.slice(0, 80) }));
  }
  return {
    present: true,
    version: envelopeVersion,
    algorithm: rawAlgorithm,
    digest,
    at: finiteNonNegative(seal.at),
    segments: finiteNonNegative(seal.segments),
    segmentsBytes: finiteNonNegative(seal.segmentsBytes != null ? seal.segmentsBytes : seal.bytes),
    codec: String(seal.codec || ''),
    durability: String(seal.durability || 'unknown'),
    warnings: finiteNonNegative(seal.warnings),
    segmentsDigest,
    invariants: isPlainObject(seal.invariants) ? seal.invariants : null,
    problems,
    raw: seal,
  };
}

/** 摘要输入快照（测试/诊断用：同一 manifest 的两个输入必须确定）。 */
export function sealDigestInputs(manifest) {
  return {
    manifest: sealDigestInput(manifest),
    segments: segmentChainDigestInput(manifest),
  };
}

/**
 * 重算两个规范摘要。
 * @returns {{ok:boolean, manifestDigest:string, segmentsDigest:string, problems:Array}}
 */
export async function computeSealDigests(manifest, options = {}) {
  const digestFn = typeof options.digest === 'function' ? options.digest : defaultDigest;
  const problems = [];
  let manifestDigest = '';
  let segmentsDigest = '';
  try {
    const value = String(await digestFn(sealDigestInput(manifest)) || '').toLowerCase();
    if (CHECKSUM_RE.test(value)) manifestDigest = value;
    else problems.push(problem(SEAL_CHECK_CODES.DIGEST_INVALID, 'error', '重算的 manifest 摘要格式非法', { digest: value }));
  } catch (error) {
    problems.push(problem(SEAL_CHECK_CODES.DIGEST_UNAVAILABLE, 'warning', 'manifest 摘要重算失败（摘要不可用，无法证明未篡改）', { error: String((error && error.message) || error) }));
  }
  const rawSegments = Array.isArray(manifest && manifest.segments) ? manifest.segments : [];
  const completeChecksums = rawSegments.length > 0 && rawSegments.every((segment) => normalizeChecksum(segment && (segment.checksum != null ? segment.checksum : segment.sha256)));
  if (completeChecksums) {
    try {
      const value = String(await digestFn(segmentChainDigestInput(manifest)) || '').toLowerCase();
      if (CHECKSUM_RE.test(value)) segmentsDigest = value;
      else problems.push(problem(SEAL_CHECK_CODES.DIGEST_INVALID, 'error', '重算的分片链摘要格式非法', { scope: 'segments_chain', digest: value }));
    } catch (error) {
      problems.push(problem(SEAL_CHECK_CODES.DIGEST_UNAVAILABLE, 'warning', '分片链摘要重算失败', { scope: 'segments_chain', error: String((error && error.message) || error) }));
    }
  }
  return { ok: problems.every((item) => item.severity !== 'error'), manifestDigest, segmentsDigest, problems };
}

function invariantProblems(expected, actual) {
  const problems = [];
  const fields = ['segments', 'bytes', 'durationMs', 'lastFrameAt'];
  for (const field of fields) {
    const want = finiteNonNegative(expected && expected[field]);
    const got = finiteNonNegative(actual && actual[field]);
    if (want !== got) {
      problems.push(problem(SEAL_CHECK_CODES.STATS_MISMATCH, 'error', 'seal 不变量与当前 manifest 统计不一致', { field, expected: want, actual: got }));
    }
  }
  for (const field of ['codec', 'mime']) {
    const want = String((expected && expected[field]) || '');
    const got = String((actual && actual[field]) || '');
    if (want && got && want !== got) {
      problems.push(problem(SEAL_CHECK_CODES.CODEC_MISMATCH, 'error', 'seal 不变量与当前 manifest 的 ' + field + ' 不一致', { field, expected: want, actual: got }));
    }
  }
  return problems;
}

/**
 * 完整校验一份 manifest 的 seal 状态。
 * 约定：`ok` 只表示“没有 error 级问题”，不等于“已封存”；`status` 才是封存状态：
 *   missing / unsealed / sealed / tampered / stale / unsupported。
 *
 * @param {object} manifest 完整 v2 manifest（含 segments）
 * @param {{digest?:Function|false, now?:number, maxAgeMs?:number, requireDigest?:boolean,
 *          allowLegacy?:boolean, clockSkewMs?:number}} options
 */
export async function verifySeal(manifest, options = {}) {
  const now = finiteNonNegative(options.now) || Date.now();
  const problems = [];
  if (!isPlainObject(manifest)) {
    problems.push(problem(SEAL_CHECK_CODES.MISSING, 'error', 'manifest 不存在，无法校验 seal'));
    return finishSealResult({ ok: false, status: 'missing', sealed: false, problems, checks: null, manifest: null }, options);
  }
  const sealedFlag = manifest.sealed === true;
  const normalized = normalizeSealEnvelope(manifest.seal);
  for (const item of normalized.problems) problems.push(item);
  const validation = validateManifest(manifest, { requireChecksum: normalized.durability === 'verified' });
  const currentInvariants = sealInvariants(manifest, validation);
  const checks = {
    envelope: {
      present: normalized.present,
      version: normalized.version,
      algorithm: normalized.algorithm,
      legacy: normalized.version > 0 && normalized.version < VIDEO_SEAL_ENVELOPE_VERSION,
      has_segments_digest: Boolean(normalized.segmentsDigest),
      has_invariants: Boolean(normalized.invariants),
    },
    stats: { ...currentInvariants, validation_ok: validation.ok },
    digest: { expected: normalized.digest, computed: '', verified: false, skipped: false },
    segments: { count: currentInvariants.segments, chain: { expected: normalized.segmentsDigest, computed: '', verified: false } },
    durability: { claimed: normalized.durability || 'unknown', consistent: null },
    timing: { sealedAt: normalized.at, now, ageMs: normalized.at ? Math.max(0, now - normalized.at) : 0, stale: false, fromFuture: false },
    manifest: summarizeManifest(manifest),
  };

  if (!sealedFlag) {
    // 未封存：不是错误，但把导致 seal 失败的连续性错误带上，供上层决定是否重 seal。
    for (const item of validation.problems) {
      if (item.severity === 'error') problems.push({ ...item, scope: 'manifest', phase: 'unsealed' });
    }
    return finishSealResult({ ok: !problems.some((item) => item.severity === 'error'), status: 'unsealed', sealed: false, problems, checks, manifest }, options);
  }

  if (!normalized.present) {
    problems.push(problem(SEAL_CHECK_CODES.ENVELOPE_MISSING, 'error', 'manifest 标记已封存但缺少 seal 信封（证据链断裂）', {}));
  }

  // 1) 分片描述与统计自洽。
  for (const item of validation.problems) {
    problems.push({ ...item, scope: 'manifest', phase: 'sealed' });
  }
  if (normalized.segments > 0 && normalized.segments !== currentInvariants.segments) {
    problems.push(problem(SEAL_CHECK_CODES.SEGMENTS_COUNT_MISMATCH, 'error', 'seal 记录的分片数与 manifest 实际分片数不一致', { expected: normalized.segments, actual: currentInvariants.segments }));
  }
  if (normalized.segmentsBytes > 0 && normalized.segmentsBytes !== currentInvariants.bytes) {
    problems.push(problem(SEAL_CHECK_CODES.STATS_MISMATCH, 'error', 'seal 记录的分片总字节与 manifest 实际总字节不一致', { expected: normalized.segmentsBytes, actual: currentInvariants.bytes }));
  }
  if (finiteNonNegative(manifest.totalBytes) > 0 && finiteNonNegative(manifest.totalBytes) !== currentInvariants.bytes) {
    problems.push(problem(SEAL_CHECK_CODES.STATS_MISMATCH, 'error', 'manifest.totalBytes 与分片之和不一致', { expected: currentInvariants.bytes, actual: finiteNonNegative(manifest.totalBytes) }));
  }
  if (finiteNonNegative(manifest.totalDurationMs) > 0 && finiteNonNegative(manifest.totalDurationMs) !== currentInvariants.durationMs) {
    problems.push(problem(SEAL_CHECK_CODES.STATS_MISMATCH, 'error', 'manifest.totalDurationMs 与分片时长不一致', { expected: currentInvariants.durationMs, actual: finiteNonNegative(manifest.totalDurationMs) }));
  }
  if (normalized.codec && currentInvariants.codec && normalized.codec !== currentInvariants.codec) {
    problems.push(problem(SEAL_CHECK_CODES.CODEC_MISMATCH, 'error', 'seal 记录 codec 与 manifest codec 不一致', { expected: normalized.codec, actual: currentInvariants.codec }));
  }
  if (normalized.invariants) {
    for (const item of invariantProblems(normalized.invariants, currentInvariants)) problems.push(item);
  }

  // 2) durability 自洽：声称 verified 就必须每个分片都有合法校验和。
  const missingChecksums = validation.segments.filter((segment) => !segment.checksum).length;
  checks.durability.consistent = normalized.durability === 'verified' ? missingChecksums === 0 : true;
  if (normalized.durability === 'verified' && missingChecksums > 0) {
    problems.push(problem(SEAL_CHECK_CODES.DURABILITY_INCONSISTENT, 'error', 'seal 声称 durability=verified，但有分片缺少校验和', { missing: missingChecksums, segments: currentInvariants.segments }));
  }
  if (normalized.durability && normalized.durability !== 'verified' && normalized.durability !== 'unverified') {
    problems.push(problem(SEAL_CHECK_CODES.DURABILITY_INCONSISTENT, 'warning', 'seal 的 durability 取值未知', { durability: normalized.durability }));
  }

  // 3) 时间：来自未来 / 过期。
  const skew = finiteNonNegative(options.clockSkewMs) || SEAL_CLOCK_SKEW_MS;
  if (normalized.at > now + skew) {
    checks.timing.fromFuture = true;
    problems.push(problem(SEAL_CHECK_CODES.FROM_FUTURE, 'warning', 'seal 时间戳来自未来（时钟偏差或记录被改写）', { sealedAt: normalized.at, now }));
  }
  const maxAgeMs = finiteNonNegative(options.maxAgeMs != null ? options.maxAgeMs : SEAL_DEFAULT_MAX_AGE_MS);
  if (maxAgeMs > 0 && normalized.at > 0 && now - normalized.at > maxAgeMs) {
    checks.timing.stale = true;
    problems.push(problem(SEAL_CHECK_CODES.STALE, 'warning', 'seal 超过保留时限（仅提示，过期清理由 video.prune 负责）', { sealedAt: normalized.at, ageMs: checks.timing.ageMs, maxAgeMs }));
  }

  // 4) 摘要重算：只有真的算出来才能证明“未篡改”。
  const digestEnabled = options.digest !== false;
  if (digestEnabled && normalized.digest) {
    const digests = await computeSealDigests(manifest, options);
    for (const item of digests.problems) problems.push(item);
    checks.digest.computed = digests.manifestDigest;
    if (digests.manifestDigest) {
      checks.digest.verified = digests.manifestDigest === normalized.digest;
      if (!checks.digest.verified) {
        problems.push(problem(SEAL_CHECK_CODES.DIGEST_MISMATCH, 'error', 'seal 规范摘要与重算结果不一致（manifest 内容被改动）', {
          expected: normalized.digest,
          computed: digests.manifestDigest,
        }));
      }
    }
    checks.segments.chain.computed = digests.segmentsDigest;
    if (normalized.segmentsDigest && digests.segmentsDigest) {
      checks.segments.chain.verified = normalized.segmentsDigest === digests.segmentsDigest;
      if (!checks.segments.chain.verified) {
        problems.push(problem(SEAL_CHECK_CODES.SEGMENTS_DIGEST_MISMATCH, 'error', '分片链摘要与重算结果不一致（分片校验和被改动）', {
          expected: normalized.segmentsDigest,
          computed: digests.segmentsDigest,
        }));
      }
    } else if (normalized.segmentsDigest && !digests.segmentsDigest && errorsPresent(problems)) {
      problems.push(problem(SEAL_CHECK_CODES.SEGMENT_CHAIN_INVALID, 'warning', 'seal 带分片链摘要但当前 manifest 无法重算（分片校验和缺失）', {}));
    }
  } else {
    checks.digest.skipped = true;
  }

  // 5) 结论：tampered 优先，其次 unsupported / stale / sealed。
  const status = decideSealStatus(problems, checks);
  return finishSealResult({ ok: problems.every((item) => item.severity !== 'error'), status, sealed: sealedFlag, problems, checks, manifest }, options);
}

function errorsPresent(problems) {
  return problems.some((item) => item.severity === 'error');
}

function decideSealStatus(problems, checks) {
  const errorCodes = new Set(problems.filter((item) => item.severity === 'error').map((item) => item.code));
  if (errorCodes.size) {
    if (errorCodes.has(SEAL_CHECK_CODES.VERSION_UNSUPPORTED) && errorCodes.size === 1) return 'unsupported';
    return 'tampered';
  }
  if (checks && checks.timing && checks.timing.stale) return 'stale';
  return 'sealed';
}

function finishSealResult(result, options) {
  const evidence = result.problems.map((item) => ({
    code: item.code,
    severity: item.severity,
    message: item.message,
    ...(item.field ? { field: item.field } : {}),
    ...(item.scope ? { scope: item.scope } : {}),
  }));
  return {
    ...result,
    evidence,
    summary: summarizeSealCheck(result),
    at: finiteNonNegative(options && options.now) || Date.now(),
  };
}

/** 记录侧碎片 → 分片链输入（只依赖 index/bytes/sha256，所以无需 OPFS manifest 也能重算链摘要）。 */
export function segmentChainFromFragments(fragments) {
  const list = Array.isArray(fragments) ? fragments : [];
  const segments = [];
  const problems = [];
  for (let index = 0; index < list.length; index += 1) {
    const fragment = list[index] && typeof list[index] === 'object' ? list[index] : {};
    const bytes = finiteNonNegative(fragment.bytes);
    const checksum = normalizeChecksum(fragment.sha256 != null ? fragment.sha256 : fragment.checksum);
    if (bytes <= 0) {
      problems.push(problem(SEAL_CHECK_CODES.SEGMENT_CHAIN_INVALID, 'error', '记录里的分片字节数为 0，无法重算分片链', { index }));
    }
    if (!checksum) {
      problems.push(problem(SEAL_CHECK_CODES.SEGMENT_CHAIN_INVALID, 'warning', '记录里的分片缺少 SHA-256，分片链不完整', { index }));
    }
    segments.push({ index: Number.isSafeInteger(Number(fragment.index)) ? Number(fragment.index) : index, bytes, checksum });
  }
  return { ok: !problems.some((item) => item.severity === 'error'), segments, problems };
}

/**
 * 记录侧 seal 一致性检查（同步、零摘要开销）：列表/状态这种高频路径用它。
 * 依据：record.seal（digest/at/segments/bytes/durability）+ record.fragments/chunk_count + segment_manifest。
 */
export function inspectRecordSeal(record, options = {}) {
  const now = finiteNonNegative(options.now) || Date.now();
  const problems = [];
  if (!record || typeof record !== 'object') {
    problems.push(problem(SEAL_CHECK_CODES.MISSING, 'error', '缺少录制记录'));
    return { ok: false, status: 'missing', sealed: false, source: 'record', problems, evidence: [], summary: summarizeSealCheck({ status: 'missing', ok: false, problems }), checks: null };
  }
  const hasSeal = record.sealed === true || isPlainObject(record.seal);
  if (record.sealed === true && !isPlainObject(record.seal)) {
    problems.push(problem(SEAL_CHECK_CODES.ENVELOPE_MISSING, 'error', '记录标记 sealed 但缺少 seal 字段（证据链断裂）'));
    return {
      ok: false,
      status: 'tampered',
      sealed: false,
      source: 'record',
      completeness: record.completeness || null,
      problems,
      evidence: problems.map((item) => ({ code: item.code, severity: item.severity, message: item.message })),
      summary: summarizeSealCheck({ status: 'tampered', ok: false, sealed: false, problems }),
      checks: null,
    };
  }
  if (!hasSeal) {
    const completeness = String(record.completeness || '');
    return {
      ok: !problems.some((item) => item.severity === 'error'),
      status: 'unsealed',
      sealed: false,
      source: 'record',
      completeness: completeness || null,
      problems,
      evidence: problems.map((item) => ({ code: item.code, severity: item.severity, message: item.message })),
      summary: summarizeSealCheck({ status: 'unsealed', ok: true, problems, record }),
      checks: null,
    };
  }
  const normalized = normalizeSealEnvelope(record.seal);
  for (const item of normalized.problems) problems.push({ ...item, scope: 'record_seal' });
  const chunks = Number.isInteger(record.chunk_count) && record.chunk_count > 0
    ? record.chunk_count
    : (Array.isArray(record.fragments) ? record.fragments.length : 0);
  const fragmentBytes = Array.isArray(record.fragments)
    ? record.fragments.reduce((sum, fragment) => sum + finiteNonNegative(fragment && fragment.bytes), 0)
    : 0;
  const chain = segmentChainFromFragments(record.fragments);
  for (const item of chain.problems) problems.push({ ...item, scope: 'record_fragments' });
  const checks = {
    envelope: { present: normalized.present, version: normalized.version, algorithm: normalized.algorithm, legacy: normalized.version > 0 && normalized.version < VIDEO_SEAL_ENVELOPE_VERSION },
    segments: {
      seal: normalized.segments,
      record: chunks,
      fragments: Array.isArray(record.fragments) ? record.fragments.length : 0,
      bytes: fragmentBytes,
      chain: { expected: normalized.segmentsDigest, computed: '', verified: false, skipped: !normalized.segmentsDigest },
    },
    durability: { claimed: normalized.durability || 'unknown', records_with_hash: chain.segments.filter((segment) => Boolean(segment.checksum)).length },
    timing: { sealedAt: normalized.at, now, ageMs: normalized.at ? Math.max(0, now - normalized.at) : 0 },
    manifest_summary: isPlainObject(record.segment_manifest) ? record.segment_manifest : null,
    completeness: record.completeness || null,
  };
  if (normalized.segments > 0 && chunks > 0 && normalized.segments !== chunks) {
    problems.push(problem(SEAL_CHECK_CODES.SEGMENTS_COUNT_MISMATCH, 'error', '记录 seal 的分片数与 chunk_count/fragments 不一致', { expected: normalized.segments, actual: chunks }));
  }
  if (Array.isArray(record.fragments) && record.fragments.length && normalized.segments > 0 && record.fragments.length !== normalized.segments) {
    problems.push(problem(SEAL_CHECK_CODES.SEGMENTS_COUNT_MISMATCH, 'warning', '记录 fragments 条数与 seal 分片数不一致（可能被裁剪/持久化降级）', { expected: normalized.segments, actual: record.fragments.length }));
  }
  const manifestSummary = isPlainObject(record.segment_manifest) ? record.segment_manifest : null;
  if (manifestSummary) {
    if (normalized.segments > 0 && finiteNonNegative(manifestSummary.segments) > 0 && normalized.segments !== finiteNonNegative(manifestSummary.segments)) {
      problems.push(problem(SEAL_CHECK_CODES.SEGMENTS_COUNT_MISMATCH, 'error', 'seal 分片数与 segment_manifest 摘要不一致', { expected: normalized.segments, actual: finiteNonNegative(manifestSummary.segments), scope: 'segment_manifest' }));
    }
    if (normalized.segmentsBytes > 0 && finiteNonNegative(manifestSummary.bytes) > 0 && normalized.segmentsBytes !== finiteNonNegative(manifestSummary.bytes)) {
      problems.push(problem(SEAL_CHECK_CODES.STATS_MISMATCH, 'error', 'seal 字节数与 segment_manifest 摘要不一致', { expected: normalized.segmentsBytes, actual: finiteNonNegative(manifestSummary.bytes), scope: 'segment_manifest' }));
    }
    if (manifestSummary.seal && manifestSummary.seal.digest && normalized.digest && manifestSummary.seal.digest !== normalized.digest) {
      problems.push(problem(SEAL_CHECK_CODES.DIGEST_MISMATCH, 'error', '记录 seal 摘要与 segment_manifest 内摘要不一致', { expected: normalized.digest, actual: String(manifestSummary.seal.digest), scope: 'segment_manifest' }));
    }
  }
  if (chain.ok && !normalized.segmentsDigest && normalized.digest) {
    // 旧信封没有链摘要：只记录“可重算但没有可比对的期望值”，不算问题。
    checks.segments.chain.skipped = true;
  }
  const skew = finiteNonNegative(options.clockSkewMs) || SEAL_CLOCK_SKEW_MS;
  if (normalized.at > now + skew) {
    problems.push(problem(SEAL_CHECK_CODES.FROM_FUTURE, 'warning', '记录 seal 时间戳来自未来', { sealedAt: normalized.at, now }));
  }
  const status = decideSealStatus(problems, checks);
  const result = {
    ok: problems.every((item) => item.severity !== 'error'),
    status,
    sealed: true,
    source: 'record',
    completeness: record.completeness || null,
    problems,
    checks,
  };
  return {
    ...result,
    evidence: problems.map((item) => ({ code: item.code, severity: item.severity, message: item.message, ...(item.scope ? { scope: item.scope } : {}), ...(item.field ? { field: item.field } : {}) })),
    summary: summarizeSealCheck({ ...result, checks: { record: checks } }),
  };
}

/**
 * 记录 + （可选）OPFS manifest 双侧校验：
 *   - 有 manifest：完整 verifySeal + reconcileSeal 记录侧摘要；
 *   - 无 manifest：记录侧一致性 + 用 fragments 重算分片链摘要（若 seal 带 segmentsDigest 则逐字节比较）。
 */
export async function verifyRecordSeal(record, options = {}) {
  const base = inspectRecordSeal(record, options);
  const problems = base.problems.slice();
  let full = null;
  let reconcile = null;
  const manifest = isPlainObject(options.manifest) ? options.manifest : null;
  if (manifest) {
    full = await verifySeal(manifest, options);
    for (const item of full.problems) problems.push({ ...item, scope: item.scope || 'manifest' });
    if (base.sealed) {
      reconcile = reconcileSeal(record && record.seal, manifest.seal);
      for (const item of reconcile.problems) problems.push(item);
    } else {
      // 记录侧本身没有 seal（例如纯 IDB 落库路径）：manifest 侧封存只作为附加证据，不做对账。
      reconcile = { ok: true, same: false, skipped: true, differences: [], problems: [] };
    }
  } else if (base.sealed && Array.isArray(record && record.fragments) && record.fragments.length && options.digest !== false) {
    const chain = segmentChainFromFragments(record.fragments);
    const computed = await computeSealDigests({ recordingId: String(record.id || ''), codec: String(record.codec || ''), segments: chain.segments }, options);
    const expected = base.checks && base.checks.segments ? String(base.checks.segments.chain.expected || '') : '';
    const chainCheck = base.checks ? base.checks.segments.chain : null;
    if (chainCheck && computed.segmentsDigest) {
      chainCheck.computed = computed.segmentsDigest;
      chainCheck.skipped = false;
      if (expected) {
        chainCheck.verified = expected === computed.segmentsDigest;
        if (!chainCheck.verified) {
          problems.push(problem(SEAL_CHECK_CODES.SEGMENTS_DIGEST_MISMATCH, 'error', '记录 fragments 重算的分片链摘要与 seal 不一致（记录被改动）', { expected, computed: computed.segmentsDigest, scope: 'record_fragments' }));
        }
      }
    }
    for (const item of computed.problems) problems.push(item);
  }
  const status = base.sealed ? decideSealStatus(problems, base.checks) : 'unsealed';
  const merged = {
    ok: problems.every((item) => item.severity !== 'error'),
    status,
    sealed: base.sealed,
    source: manifest ? 'record+manifest' : 'record',
    problems,
    checks: {
      record: base.checks,
      ...(full ? { manifest: full.checks, manifest_status: full.status } : {}),
      ...(reconcile ? { reconcile: { same: reconcile.same, differences: reconcile.differences, skipped: reconcile.skipped === true } } : {}),
    },
    completeness: base.completeness || (record && record.completeness) || null,
    manifest: full ? full.summary : null,
    chain: base.checks && base.checks.segments ? base.checks.segments.chain : null,
  };
  return {
    ...merged,
    evidence: problems.map((item) => ({ code: item.code, severity: item.severity, message: item.message, ...(item.scope ? { scope: item.scope } : {}) })),
    summary: summarizeSealCheck(merged),
  };
}

/** 两侧 seal 对账（记录侧只有摘要字段，OPFS 侧有完整信封）。 */
export function reconcileSeal(recordSeal, manifestSeal) {
  const left = normalizeSealEnvelope(recordSeal);
  const right = normalizeSealEnvelope(manifestSeal);
  const differences = [];
  if (!left.present || !right.present) {
    if (left.present !== right.present) {
      differences.push({ field: 'present', record: left.present, manifest: right.present });
    }
  } else {
    const fields = [
      ['digest', left.digest, right.digest],
      ['segments', left.segments, right.segments],
      ['segmentsBytes', left.segmentsBytes, right.segmentsBytes],
      ['codec', left.codec, right.codec],
      ['durability', left.durability, right.durability],
    ];
    for (const [field, want, got] of fields) {
      // 记录侧这些字段可能缺省为 0/''（旧记录），缺省不算冲突。
      if (want === got) continue;
      if ((field === 'segments' || field === 'segmentsBytes') && (!want || !got)) continue;
      if (field !== 'digest' && (!want || !got)) continue;
      differences.push({ field, record: want, manifest: got });
    }
  }
  const digestOnly = differences.filter((item) => item.field === 'digest' || item.field === 'segments' || item.field === 'segmentsBytes');
  const problems = digestOnly.length
    ? [problem(SEAL_CHECK_CODES.RECONCILE_MISMATCH, 'error', '记录侧与 manifest 侧 seal 关键字段不一致', { fields: digestOnly.map((item) => item.field) })]
    : [];
  return {
    ok: problems.length === 0,
    same: differences.length === 0,
    differences,
    problems,
    evidence: problems.map((item) => ({ code: item.code, severity: item.severity, message: item.message, fields: item.fields })),
  };
}

/** 对外紧凑摘要（video.verify / video.fetch / video.list 附加字段用）。 */
export function summarizeSealCheck(result) {
  if (!result || typeof result !== 'object') return null;
  const problems = Array.isArray(result.problems) ? result.problems : [];
  const checks = result.checks && typeof result.checks === 'object' ? result.checks : {};
  const recordChecks = checks.record && typeof checks.record === 'object' ? checks.record : null;
  const manifestChecks = checks.manifest && typeof checks.manifest === 'object' ? checks.manifest : null;
  const chain = (manifestChecks && manifestChecks.segments ? manifestChecks.segments.chain : null)
    || result.chain
    || (recordChecks && recordChecks.segments ? recordChecks.segments.chain : null)
    || (checks.segments ? checks.segments.chain : null);
  const manifestStats = (manifestChecks && manifestChecks.stats) || (checks.stats && typeof checks.stats === 'object' ? checks.stats : null);
  const recordSegments = recordChecks && recordChecks.segments ? recordChecks.segments : null;
  const segments = manifestStats ? finiteNonNegative(manifestStats.segments) : finiteNonNegative(recordSegments && recordSegments.record);
  const bytes = manifestStats ? finiteNonNegative(manifestStats.bytes) : finiteNonNegative(recordSegments && recordSegments.bytes);
  const durability = String(
    (manifestChecks && manifestChecks.durability && manifestChecks.durability.claimed)
    || (checks.durability && checks.durability.claimed)
    || (recordChecks && recordChecks.durability && recordChecks.durability.claimed)
    || '',
  );
  const digestVerified = Boolean(
    (manifestChecks && manifestChecks.digest && manifestChecks.digest.verified)
    || (checks.digest && checks.digest.verified),
  );
  const legacy = Boolean(
    (manifestChecks && manifestChecks.envelope && manifestChecks.envelope.legacy)
    || (checks.envelope && checks.envelope.legacy)
    || (recordChecks && recordChecks.envelope && recordChecks.envelope.legacy),
  );
  return {
    ok: result.ok === true,
    status: String(result.status || 'unknown'),
    sealed: result.sealed === true,
    source: String(result.source || 'manifest'),
    errors: problems.filter((item) => item.severity === 'error').length,
    warnings: problems.filter((item) => item.severity !== 'error').length,
    ...(result.status === 'sealed' || result.status === 'stale'
      ? {
        digest_verified: digestVerified,
        ...(segments > 0 ? { segments } : {}),
        ...(bytes > 0 ? { bytes } : {}),
        ...(durability ? { durability } : {}),
        legacy,
      }
      : {}),
    ...(chain && chain.verified ? { segments_digest_verified: true } : {}),
    ...(checks.timing && checks.timing.stale ? { stale: true } : {}),
    ...(recordChecks && recordChecks.completeness ? { completeness: String(recordChecks.completeness) } : {}),
  };
}

/**
 * 写回记录的 seal 校验字段（video.verify / video.recover 用）。
 * 只新增 `seal_check` / `seal_verified` / `seal_evidence`，不动既有 seal 字段。
 */
export function sealRecordPatch(result) {
  const summary = summarizeSealCheck(result);
  if (!summary) return {};
  const problems = Array.isArray(result && result.problems) ? result.problems : [];
  return {
    seal_check: summary,
    seal_verified: result.ok === true && result.status !== 'unsealed' && result.status !== 'missing',
    seal_evidence: problems.slice(-8).map((item) => ({ code: item.code, severity: item.severity, ...(item.field ? { field: item.field } : {}), ...(item.scope ? { scope: item.scope } : {}) })),
  };
}

/** 稳定字符串导出：调用方/测试需要比较两个信封的规范形态时用。 */
export function canonicalSeal(seal) {
  return stableStringify(normalizeSealEnvelope(seal).raw || null);
}
