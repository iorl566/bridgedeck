// extension/src/lib/video-manifest.js —— 分段录制 manifest（分片序号/时间戳/字节/codec/durability 校验和）
// 与 manifest seal（连续性校验后落 sealed manifest，可作崩溃恢复凭证）。
//
// 分片描述：{ index, atMs, bytes, codec, lastFrameAt, checksum }
//   index       分片序号，从 0 连续递增（对应 OPFS 分块 sequence）；
//   atMs        分片落盘时刻（相对录制开始，毫秒；单调不减）；
//   bytes       分片字节数（>0）；
//   codec       编码（如 'avc'/'vp9'；同一 manifest 内必须一致）；
//   lastFrameAt 分片内最后一帧时间戳（毫秒；单调不减）；
//   checksum    分片内容 SHA-256（64 位小写 hex），manifest seal 的 durability 依据。
//
// 所有函数都是纯函数/可注入 digest：opfs-encoded-store 持久化，encoded-writer 逐段追加，
// video-recovery 在崩溃后按 manifest 规划可播放前缀，video.js 在收尾/校验时读取证据。

import { VIDEO_SEGMENT_CODES } from './video-codes.js';

export { VIDEO_SEGMENT_CODES };

export const VIDEO_MANIFEST_VERSION = 2;
export const VIDEO_MANIFEST_MIN_VERSION = 1;
// seal 信封版本：1 = 只有规范摘要；2 = 规范摘要 + 分片链摘要 + 不变量快照（可被任一方独立对账）。
export const VIDEO_SEAL_ENVELOPE_VERSION = 2;

const CHECKSUM_RE = /^[0-9a-f]{64}$/;

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

/** 确定性 JSON（对象键排序），用于 manifest seal 摘要与去重比较。 */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(String(value));
}

/** 归一化单个分片描述；非法字段落到安全值并在校验阶段报 problem。 */
export function normalizeSegment(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const index = Number(source.index);
  const atMs = finiteNonNegative(source.atMs != null ? source.atMs : options.atMs);
  const lastFrameAt = source.lastFrameAt != null ? finiteNonNegative(source.lastFrameAt) : atMs;
  return {
    index: Number.isSafeInteger(index) ? index : -1,
    atMs,
    bytes: finiteNonNegative(source.bytes),
    codec: String(source.codec || options.codec || ''),
    lastFrameAt,
    checksum: normalizeChecksum(source.checksum != null ? source.checksum : source.sha256),
  };
}

function budgetFields(budget) {
  const source = budget && typeof budget === 'object' ? budget : {};
  return {
    maxDurationMs: finiteNonNegative(source.maxDurationMs),
    maxSegmentBytes: finiteNonNegative(source.maxSegmentBytes),
    maxTotalBytes: finiteNonNegative(source.maxTotalBytes),
  };
}

/** 创建空的 v2 manifest（录制开始时由 opfs-encoded-store / encoded-writer 调用）。 */
export function createSegmentManifest(input = {}) {
  const createdAt = finiteNonNegative(input.now != null ? input.now : input.createdAt) || Date.now();
  return {
    version: VIDEO_MANIFEST_VERSION,
    recordingId: String(input.recordingId || ''),
    createdAt,
    startedAt: finiteNonNegative(input.startedAt) || createdAt,
    updatedAt: createdAt,
    codec: String(input.codec || 'avc'),
    mime: String(input.mime || 'video/mp4'),
    mode: String(input.mode || ''),
    state: 'recording',
    sealed: false,
    tabId: input.tabId == null ? null : Number(input.tabId),
    url: String(input.url || ''),
    title: String(input.title || ''),
    budget: budgetFields(input.budget),
    segments: [],
    stats: { segments: 0, bytes: 0, durationMs: 0, firstAtMs: 0, lastAtMs: 0, lastFrameAt: 0 },
  };
}

function computeStats(segments) {
  const list = Array.isArray(segments) ? segments : [];
  let bytes = 0;
  for (const segment of list) bytes += finiteNonNegative(segment && segment.bytes);
  const first = list[0] || null;
  const last = list[list.length - 1] || null;
  return {
    segments: list.length,
    bytes,
    durationMs: last && first ? Math.max(0, last.lastFrameAt - first.atMs) : (last ? last.lastFrameAt : 0),
    firstAtMs: first ? first.atMs : 0,
    lastAtMs: last ? last.atMs : 0,
    lastFrameAt: last ? last.lastFrameAt : 0,
  };
}

function badAppend(manifest, code, detail, message) {
  return {
    ok: false,
    code,
    manifest,
    segment: detail && detail.segment ? detail.segment : null,
    problems: [problem(code, 'error', message, detail || {})],
    evidence: { code, ...(detail || {}) },
  };
}

/**
 * 追加一个分片。结构性错误（序号不连续/时间回退/字节为 0/码率不一致）拒绝，
 * 单段超预算只记 warning（轮换策略由 video-budget 决定）。
 * @returns {{ok:boolean, manifest:object, segment?:object, code?:string, problems?:Array, evidence?:object}}
 */
export function appendSegment(manifest, entry, options = {}) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, code: VIDEO_SEGMENT_CODES.MANIFEST_MISSING, manifest: null, problems: [problem(VIDEO_SEGMENT_CODES.MANIFEST_MISSING, 'error', 'manifest 不存在')], evidence: { code: VIDEO_SEGMENT_CODES.MANIFEST_MISSING } };
  }
  if (manifest.sealed === true) {
    return badAppend(manifest, VIDEO_SEGMENT_CODES.MANIFEST_SEALED, {}, 'manifest 已 seal，禁止追加分片');
  }
  const segments = Array.isArray(manifest.segments) ? manifest.segments : [];
  const expected = segments.length;
  const segment = normalizeSegment(entry, { codec: manifest.codec, atMs: options.atMs });
  if (segment.index < 0) segment.index = expected;
  if (segment.index < expected) {
    return badAppend(manifest, VIDEO_SEGMENT_CODES.SEGMENT_INDEX_DUPLICATE, { expected, segment }, '分片序号重复');
  }
  if (segment.index > expected) {
    return badAppend(manifest, VIDEO_SEGMENT_CODES.SEGMENT_INDEX_GAP, { expected, actual: segment.index, segment }, '分片序号不连续');
  }
  if (segment.bytes <= 0) {
    return badAppend(manifest, VIDEO_SEGMENT_CODES.SEGMENT_BYTES_ZERO, { segment }, '分片字节数必须大于 0');
  }
  const problems = [];
  if (options.requireChecksum === true && !segment.checksum) {
    return badAppend(manifest, VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_MISSING, { segment }, '分片缺少 durability 校验和');
  }
  if (!segment.checksum && options.requireChecksum !== false) {
    problems.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_MISSING, 'warning', '分片缺少校验和（seal 时会标 warning）', { index: segment.index }));
  }
  const manifestCodec = String(manifest.codec || '');
  if (manifestCodec && segment.codec && segment.codec !== manifestCodec) {
    return badAppend(manifest, VIDEO_SEGMENT_CODES.SEGMENT_CODEC_MISMATCH, { segment, codec: manifestCodec }, '分片 codec 与 manifest 不一致');
  }
  if (!segment.codec) segment.codec = manifestCodec || '';
  const previous = segments[segments.length - 1] || null;
  if (previous) {
    if (segment.atMs < Number(previous.atMs)) {
      return badAppend(manifest, VIDEO_SEGMENT_CODES.SEGMENT_TIME_REGRESSION, { segment, previous: previous.atMs }, '分片落盘时间回退');
    }
    if (segment.lastFrameAt < Number(previous.lastFrameAt)) {
      return badAppend(manifest, VIDEO_SEGMENT_CODES.FRAME_TIME_REGRESSION, { segment, previous: previous.lastFrameAt }, '分片最后一帧时间戳回退');
    }
  }
  const maxSegmentBytes = finiteNonNegative(options.maxSegmentBytes || (manifest.budget && manifest.budget.maxSegmentBytes));
  if (maxSegmentBytes > 0 && segment.bytes > maxSegmentBytes) {
    problems.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_BYTES_LIMIT, 'warning', '单段字节超过预算', {
      index: segment.index,
      bytes: segment.bytes,
      maxSegmentBytes,
    }));
  }
  const nextSegments = segments.concat([segment]);
  const next = {
    ...manifest,
    version: VIDEO_MANIFEST_VERSION,
    updatedAt: finiteNonNegative(options.now) || Date.now(),
    segments: nextSegments,
    stats: computeStats(nextSegments),
  };
  return { ok: true, manifest: next, segment, problems };
}

/**
 * 校验 manifest 的连续性：序号、字节、时间戳单调、codec 一致、总字节一致、校验和格式。
 * 只有 severity==='error' 的 problem 会让 ok=false；warning 供报告与 seal 证据使用。
 */
export function validateManifest(manifest, options = {}) {
  const problems = [];
  const requireChecksum = options.requireChecksum === true;
  if (!manifest || typeof manifest !== 'object') {
    return {
      ok: false,
      problems: [problem(VIDEO_SEGMENT_CODES.MANIFEST_MISSING, 'error', 'manifest 不存在')],
      stats: computeStats([]),
      segments: [],
      codec: '',
    };
  }
  const version = Number(manifest.version) || 0;
  if (version < VIDEO_MANIFEST_MIN_VERSION || version > VIDEO_MANIFEST_VERSION) {
    problems.push(problem(VIDEO_SEGMENT_CODES.MANIFEST_VERSION, 'error', 'manifest 版本不受支持', { version }));
  } else if (version < VIDEO_MANIFEST_VERSION) {
    problems.push(problem(VIDEO_SEGMENT_CODES.MANIFEST_VERSION, 'warning', '旧版 manifest（无分片描述）', { version }));
  }
  const rawSegments = Array.isArray(manifest.segments) ? manifest.segments : [];
  const manifestCodec = String(manifest.codec || '');
  const segments = [];
  let previous = null;
  let totalBytes = 0;
  for (let i = 0; i < rawSegments.length; i += 1) {
    const raw = rawSegments[i] && typeof rawSegments[i] === 'object' ? rawSegments[i] : {};
    const rawChecksum = raw.checksum != null ? raw.checksum : raw.sha256;
    const segment = normalizeSegment(raw, { codec: manifestCodec });
    if (segment.index !== i) {
      problems.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_INDEX_GAP, 'error', '分片序号缺失/重复', { expected: i, actual: segment.index }));
    }
    if (segment.bytes <= 0) {
      problems.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_BYTES_ZERO, 'error', '分片字节数为 0', { index: segment.index }));
    }
    if (rawChecksum != null && String(rawChecksum).trim() !== '' && !CHECKSUM_RE.test(String(rawChecksum).trim().toLowerCase())) {
      problems.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_INVALID, 'error', '分片校验和格式非法', { index: segment.index, checksum: String(rawChecksum) }));
    } else if (!segment.checksum) {
      problems.push(problem(
        VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_MISSING,
        requireChecksum ? 'error' : 'warning',
        '分片缺少 durability 校验和',
        { index: segment.index },
      ));
    }
    if (manifestCodec && segment.codec && segment.codec !== manifestCodec) {
      problems.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_CODEC_MISMATCH, 'error', '分片 codec 与 manifest 不一致', { index: segment.index, codec: segment.codec, expected: manifestCodec }));
    }
    if (previous) {
      if (segment.atMs < previous.atMs) {
        problems.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_TIME_REGRESSION, 'error', '分片落盘时间回退', { index: segment.index, atMs: segment.atMs, previous: previous.atMs }));
      }
      if (segment.lastFrameAt < previous.lastFrameAt) {
        problems.push(problem(VIDEO_SEGMENT_CODES.FRAME_TIME_REGRESSION, 'error', '分片最后一帧时间戳回退', { index: segment.index, lastFrameAt: segment.lastFrameAt, previous: previous.lastFrameAt }));
      }
    }
    const budgetLimit = finiteNonNegative(manifest.budget && manifest.budget.maxSegmentBytes);
    if (budgetLimit > 0 && segment.bytes > budgetLimit) {
      problems.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_BYTES_LIMIT, 'warning', '单段字节超过预算', { index: segment.index, bytes: segment.bytes, maxSegmentBytes: budgetLimit }));
    }
    totalBytes += segment.bytes;
    previous = segment;
    segments.push(segment);
  }
  const declared = finiteNonNegative(manifest.totalBytes);
  if (declared > 0 && declared !== totalBytes) {
    problems.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_TOTAL_MISMATCH, 'error', 'manifest 总字节与分片之和不一致', { declared, totalBytes }));
  }
  if (manifest.sealed === true && (version < VIDEO_MANIFEST_VERSION || !manifest.seal)) {
    problems.push(problem(VIDEO_SEGMENT_CODES.MANIFEST_SEALED, 'warning', 'sealed 标记缺少 seal 摘要', { version }));
  }
  const stats = computeStats(segments);
  return {
    ok: problems.every((item) => item.severity !== 'error'),
    problems,
    stats,
    segments,
    codec: manifestCodec,
    totalBytes,
  };
}

/** seal 摘要输入：只覆盖决定可播放性的规范字段（与 sealedAt/统计缓存无关）。 */
export function sealDigestInput(manifest) {
  const source = manifest && typeof manifest === 'object' ? manifest : {};
  const segments = (Array.isArray(source.segments) ? source.segments : []).map((segment) => normalizeSegment(segment));
  return stableStringify({
    version: VIDEO_MANIFEST_VERSION,
    recordingId: String(source.recordingId || ''),
    codec: String(source.codec || ''),
    mime: String(source.mime || ''),
    mode: String(source.mode || ''),
    segments,
  });
}

async function defaultDigest(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('crypto.subtle 不可用');
  const bytes = new TextEncoder().encode(String(text));
  const hash = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * seal 链摘要输入：只用分片序号/字节/校验和（不含时间戳），所以录制记录里的
 * `fragments`（index/bytes/sha256）也能独立重算出同一个摘要，用于“记录侧 vs OPFS manifest 侧”对账。
 */
export function segmentChainDigestInput(manifest) {
  const source = manifest && typeof manifest === 'object' ? manifest : {};
  const segments = (Array.isArray(source.segments) ? source.segments : [])
    .map((segment) => normalizeSegment(segment))
    .map((segment) => [segment.index, segment.bytes, segment.checksum]);
  return stableStringify({
    version: VIDEO_SEAL_ENVELOPE_VERSION,
    recordingId: String(source.recordingId || ''),
    codec: String(source.codec || ''),
    segments,
  });
}

/** 封存不变量：seal 信封中的统计快照，任何一方都能拿当前 manifest 重算并逐项对账。 */
export function sealInvariants(manifest, validation = null) {
  const source = manifest && typeof manifest === 'object' ? manifest : {};
  const stats = validation && validation.stats
    ? validation.stats
    : computeStats((Array.isArray(source.segments) ? source.segments : []).map((segment) => normalizeSegment(segment)));
  return {
    segments: finiteNonNegative(stats.segments),
    bytes: finiteNonNegative(stats.bytes),
    durationMs: finiteNonNegative(stats.durationMs),
    firstAtMs: finiteNonNegative(stats.firstAtMs),
    lastAtMs: finiteNonNegative(stats.lastAtMs),
    lastFrameAt: finiteNonNegative(stats.lastFrameAt),
    codec: String(source.codec || ''),
    mime: String(source.mime || ''),
  };
}

/**
 * seal：先做连续性校验（序号/字节/时间戳单调/codec/总字节），通过后写 sealed manifest。
 * @returns {{ok:boolean, sealed?:object, problems?:Array, code?:string, evidence?:object}}
 */
export async function sealManifest(manifest, options = {}) {
  const digestFn = typeof options.digest === 'function' ? options.digest : defaultDigest;
  const validation = validateManifest(manifest, { requireChecksum: options.requireChecksum === true });
  if (!validation.ok) {
    return {
      ok: false,
      code: VIDEO_SEGMENT_CODES.SEAL_INVALID,
      problems: validation.problems,
      evidence: {
        code: VIDEO_SEGMENT_CODES.SEAL_INVALID,
        errors: validation.problems.filter((item) => item.severity === 'error').length,
        warnings: validation.problems.filter((item) => item.severity === 'warning').length,
        segments: validation.stats.segments,
      },
    };
  }
  let digest = '';
  try {
    digest = String(await digestFn(sealDigestInput(manifest)) || '').toLowerCase();
  } catch (error) {
    return {
      ok: false,
      code: VIDEO_SEGMENT_CODES.SEAL_DIGEST_FAILED,
      problems: validation.problems,
      evidence: { code: VIDEO_SEGMENT_CODES.SEAL_DIGEST_FAILED, error: String((error && error.message) || error) },
    };
  }
  if (!CHECKSUM_RE.test(digest)) {
    return {
      ok: false,
      code: VIDEO_SEGMENT_CODES.SEAL_DIGEST_FAILED,
      problems: validation.problems,
      evidence: { code: VIDEO_SEGMENT_CODES.SEAL_DIGEST_FAILED, reason: 'invalid_digest', digest },
    };
  }
  // v2 分片链摘要：分片校验和齐全时额外算一遍（失败降级为警告，不影响主摘要成立）。
  const chainProblems = [];
  let segmentsDigest = '';
  const checksummed = validation.segments.length > 0 && validation.segments.every((segment) => Boolean(segment.checksum));
  if (checksummed) {
    try {
      const chain = String(await digestFn(segmentChainDigestInput(manifest)) || '').toLowerCase();
      if (CHECKSUM_RE.test(chain)) segmentsDigest = chain;
      else chainProblems.push(problem(VIDEO_SEGMENT_CODES.SEAL_DIGEST_FAILED, 'warning', '分片链摘要格式非法（已省略）', { scope: 'segments_chain' }));
    } catch (error) {
      chainProblems.push(problem(VIDEO_SEGMENT_CODES.SEAL_DIGEST_FAILED, 'warning', '分片链摘要计算失败（已省略）', { scope: 'segments_chain', error: String((error && error.message) || error) }));
    }
  }
  const at = finiteNonNegative(options.at != null ? options.at : options.now) || Date.now();
  const invariants = sealInvariants(manifest, validation);
  const sealed = {
    ...manifest,
    version: VIDEO_MANIFEST_VERSION,
    state: 'sealed',
    sealed: true,
    sealedAt: at,
    updatedAt: at,
    totalBytes: validation.stats.bytes,
    totalDurationMs: validation.stats.durationMs,
    stats: validation.stats,
    segments: validation.segments,
    ...(options.meta && typeof options.meta === 'object' ? options.meta : {}),
    seal: {
      version: VIDEO_SEAL_ENVELOPE_VERSION,
      algorithm: 'sha256',
      at,
      digest,
      ...(segmentsDigest ? { segmentsDigest, segmentsAlgorithm: 'sha256' } : {}),
      invariants,
      segments: validation.stats.segments,
      segmentsBytes: validation.stats.bytes,
      codec: validation.codec,
      durability: validation.problems.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_MISSING) ? 'unverified' : 'verified',
      warnings: validation.problems.filter((item) => item.severity === 'warning').length,
    },
  };
  const problems = validation.problems.concat(chainProblems);
  return {
    ok: true,
    sealed,
    problems,
    evidence: {
      code: VIDEO_SEGMENT_CODES.MANIFEST_SEALED,
      digest,
      ...(segmentsDigest ? { segmentsDigest } : {}),
      at,
      segments: validation.stats.segments,
      bytes: validation.stats.bytes,
      durationMs: validation.stats.durationMs,
      durability: sealed.seal.durability,
      invariants,
    },
  };
}

function normalizeParts(availableParts) {
  const parts = [];
  for (const item of Array.isArray(availableParts) ? availableParts : []) {
    if (!item || typeof item !== 'object') continue;
    const index = Number(item.index);
    if (!Number.isSafeInteger(index) || index < 0) continue;
    const bytes = finiteNonNegative(item.bytes != null ? item.bytes : item.size);
    parts.push({
      index,
      bytes,
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : null,
      checksum: normalizeChecksum(item.checksum != null ? item.checksum : item.sha256),
    });
  }
  return parts.sort((a, b) => a.index - b.index);
}

/**
 * 崩溃恢复规划：按 manifest 与已落盘分片（OPFS 扫描结果）计算可播放前缀。
 * 缺失/截断/校验和不匹配都产出结构化证据；可播放前缀存在即 recovered。
 * @param {object} manifest
 * @param {Array<{index:number,bytes:number,checksum?:string,position?:number}>} availableParts
 */
export function planSegmentRecovery(manifest, availableParts, options = {}) {
  const evidence = [];
  const parts = normalizeParts(availableParts);
  if (!manifest || typeof manifest !== 'object') {
    evidence.push(problem(VIDEO_SEGMENT_CODES.MANIFEST_MISSING, 'error', '缺少 manifest，无法按分片序号恢复', {}));
    return {
      ok: false,
      recovered: false,
      completeness: 'failed',
      state: 'failed',
      bytes: 0,
      keptSegments: [],
      droppedSegments: [],
      truncatedSegments: [],
      problems: evidence,
      evidence: evidence.map((item) => ({ ...item, severity: item.severity })),
      reason: 'manifest_missing',
      parts,
    };
  }
  const rawSegments = Array.isArray(manifest.segments) ? manifest.segments : [];
  const segments = rawSegments.map((segment) => normalizeSegment(segment, { codec: manifest.codec }));
  if (!segments.length) {
    evidence.push(problem(VIDEO_SEGMENT_CODES.MANIFEST_MISSING, 'error', 'manifest 没有分片描述', {}));
    return {
      ok: false,
      recovered: false,
      completeness: 'failed',
      state: 'failed',
      bytes: 0,
      keptSegments: [],
      droppedSegments: [],
      truncatedSegments: [],
      problems: evidence,
      evidence: evidence.map((item) => ({ ...item, severity: item.severity })),
      reason: 'no_segments',
      parts,
    };
  }
  const byIndex = new Map();
  for (const part of parts) byIndex.set(part.index, part);
  if (!parts.length) {
    evidence.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_UNAVAILABLE, 'error', '没有任何分片可读（OPFS 为空）', {}));
    return {
      ok: false,
      recovered: false,
      completeness: 'failed',
      state: 'failed',
      bytes: 0,
      keptSegments: [],
      droppedSegments: segments,
      truncatedSegments: [],
      problems: evidence,
      evidence: evidence.map((item) => ({ ...item, severity: item.severity })),
      reason: 'no_parts',
      parts,
    };
  }
  if (!byIndex.has(segments[0].index)) {
    evidence.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_FIRST_MISSING, 'error', '首个分片缺失，无法重建可播放文件', { index: segments[0].index }));
    return {
      ok: false,
      recovered: false,
      completeness: 'failed',
      state: 'failed',
      bytes: 0,
      keptSegments: [],
      droppedSegments: segments,
      truncatedSegments: [],
      problems: evidence,
      evidence: evidence.map((item) => ({ ...item, severity: item.severity })),
      reason: 'first_segment_missing',
      parts,
    };
  }
  const kept = [];
  const dropped = [];
  const truncated = [];
  let bytes = 0;
  let offset = 0;
  let stopped = false;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (stopped) {
      dropped.push(segment);
      continue;
    }
    const part = byIndex.get(segment.index);
    if (!part) {
      evidence.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_MISSING, 'error', '分片缺失，丢弃其后所有分片', { index: segment.index, afterIndex: i > 0 ? segments[i - 1].index : null }));
      dropped.push(segment);
      stopped = true;
      continue;
    }
    if (part.bytes <= 0) {
      evidence.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_TRUNCATED, 'error', '分片长度为 0（写入中断）', { index: segment.index, expected: segment.bytes, actual: 0 }));
      dropped.push(segment);
      stopped = true;
      continue;
    }
    if (part.bytes > segment.bytes) {
      evidence.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_TOTAL_MISMATCH, 'warning', '分片实际字节大于 manifest 记录（按 manifest 记录裁剪）', { index: segment.index, expected: segment.bytes, actual: part.bytes }));
    }
    if (part.checksum && segment.checksum && part.checksum !== segment.checksum) {
      evidence.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_MISMATCH, 'error', '分片校验和不匹配（内容损坏）', { index: segment.index }));
      dropped.push(segment);
      stopped = true;
      continue;
    }
    if (part.bytes < segment.bytes) {
      evidence.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_TRUNCATED, 'error', '分片被截断，保留已写入部分并终止恢复', {
        index: segment.index,
        expected: segment.bytes,
        actual: part.bytes,
        droppedBytes: segment.bytes - part.bytes,
      }));
      truncated.push({ index: segment.index, expected: segment.bytes, actual: part.bytes, droppedBytes: segment.bytes - part.bytes });
      kept.push({ ...segment, bytes: part.bytes, truncated: true });
      bytes += part.bytes;
      offset += part.bytes;
      stopped = true;
      continue;
    }
    kept.push(segment);
    bytes += segment.bytes;
    offset += segment.bytes;
  }
  const unlisted = parts.filter((part) => !segments.some((segment) => segment.index === part.index));
  if (unlisted.length) {
    evidence.push(problem(VIDEO_SEGMENT_CODES.SEGMENT_UNLISTED, 'warning', '存在 manifest 未登记的分片（已忽略）', { count: unlisted.length, indexes: unlisted.slice(0, 8).map((item) => item.index) }));
  }
  const hasErrors = evidence.some((item) => item.severity === 'error');
  const complete = !hasErrors && !truncated.length && kept.length === segments.length;
  const recovered = kept.length > 0;
  const stat = computeStats(kept);
  const result = {
    ok: recovered,
    recovered,
    completeness: complete ? 'complete' : (recovered ? 'partial' : 'failed'),
    state: recovered ? 'recovered' : 'failed',
    bytes,
    segments: kept.length,
    durationMs: stat.durationMs,
    lastFrameAt: stat.lastFrameAt,
    keptSegments: kept,
    droppedSegments: dropped,
    truncatedSegments: truncated,
    problems: evidence,
    evidence: evidence.map((item) => ({ ...item, severity: item.severity })),
    reason: complete ? 'complete' : (recovered ? 'partial' : 'unrecoverable'),
    parts,
    ...(options.recordingId ? { recordingId: String(options.recordingId) } : {}),
  };
  if (recovered) {
    result.evidence.push({
      code: VIDEO_SEGMENT_CODES.RECOVERY_PLANNED,
      severity: complete ? 'info' : 'warning',
      message: '可重建可播放前缀',
      bytes,
      segments: kept.length,
      dropped: dropped.length,
      truncated: truncated.length,
    });
  } else {
    result.evidence.push({ code: VIDEO_SEGMENT_CODES.RECOVERY_IMPOSSIBLE, severity: 'error', message: '没有可用分片前缀' });
  }
  return result;
}

/** 把 manifest（或恢复计划保留分片）映射成录制记录字段，复用现有 fragments/chunk_count 语义。 */
export function manifestRecordFields(manifest, recovery = null) {
  const segments = recovery && Array.isArray(recovery.keptSegments)
    ? recovery.keptSegments
    : (manifest && Array.isArray(manifest.segments) ? manifest.segments : []).map((segment) => normalizeSegment(segment));
  const source = manifest && typeof manifest === 'object' ? manifest : {};
  const stats = computeStats(segments);
  return {
    chunk_count: segments.length,
    fragments: segments.map((segment) => ({
      index: segment.index,
      at: segment.atMs,
      bytes: segment.bytes,
      sha256: segment.checksum || '',
    })),
    ...(source.codec ? { codec: String(source.codec) } : {}),
    ...(source.mime ? { mime: String(source.mime) } : {}),
    ...(stats.bytes ? { segment_bytes: stats.bytes } : {}),
    ...(stats.durationMs ? { segment_duration_ms: stats.durationMs } : {}),
    ...(source.sealed === true ? {
      sealed: true,
      ...(source.sealedAt ? { sealedAt: finiteNonNegative(source.sealedAt) } : {}),
      seal: source.seal && typeof source.seal === 'object'
        ? {
          digest: String(source.seal.digest || ''),
          at: finiteNonNegative(source.seal.at),
          segments: finiteNonNegative(source.seal.segments),
          durability: String(source.seal.durability || 'unknown'),
          ...(source.seal.version !== undefined ? { version: Number(source.seal.version) || 0 } : {}),
          ...(source.seal.segmentsDigest ? { segmentsDigest: String(source.seal.segmentsDigest) } : {}),
          ...(source.seal.segmentsBytes !== undefined ? { bytes: finiteNonNegative(source.seal.segmentsBytes) } : {}),
          ...(source.seal.invariants && typeof source.seal.invariants === 'object' ? { invariants: sealInvariants(source) } : {}),
        }
        : null,
    } : {}),
  };
}

/** 对外紧凑摘要（不含 segments 数组细节）。 */
export function summarizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const segments = Array.isArray(manifest.segments) ? manifest.segments : [];
  const stats = manifest.stats && typeof manifest.stats === 'object' ? manifest.stats : computeStats(segments.map((segment) => normalizeSegment(segment)));
  return {
    version: Number(manifest.version) || 0,
    recordingId: String(manifest.recordingId || ''),
    codec: String(manifest.codec || ''),
    state: String(manifest.state || ''),
    sealed: manifest.sealed === true,
    segments: finiteNonNegative(stats.segments),
    bytes: finiteNonNegative(stats.bytes),
    durationMs: finiteNonNegative(stats.durationMs),
    firstAtMs: finiteNonNegative(stats.firstAtMs),
    lastAtMs: finiteNonNegative(stats.lastAtMs),
    lastFrameAt: finiteNonNegative(stats.lastFrameAt),
    ...(manifest.seal && typeof manifest.seal === 'object'
      ? {
        seal: {
          digest: String(manifest.seal.digest || ''),
          at: finiteNonNegative(manifest.seal.at),
          durability: String(manifest.seal.durability || 'unknown'),
          ...(manifest.seal.version !== undefined ? { version: Number(manifest.seal.version) || 0 } : {}),
          ...(manifest.seal.segmentsDigest ? { segmentsDigest: String(manifest.seal.segmentsDigest) } : {}),
        },
      }
      : {}),
  };
}

/** 兼容旧版（version 1 / 仅有 meta 的）manifest：补出 v2 骨架，保留原有字段。 */
export function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (Number(manifest.version) >= VIDEO_MANIFEST_VERSION && Array.isArray(manifest.segments)) return manifest;
  const base = createSegmentManifest({
    recordingId: manifest.recordingId,
    now: manifest.createdAt,
    startedAt: manifest.startedAt,
    codec: manifest.codec,
    mime: manifest.mime,
    mode: manifest.mode,
    tabId: manifest.tabId,
    url: manifest.url,
    title: manifest.title,
    budget: manifest.budget,
  });
  return {
    ...base,
    ...manifest,
    version: VIDEO_MANIFEST_VERSION,
    segments: Array.isArray(manifest.segments) ? manifest.segments.map((segment) => normalizeSegment(segment, { codec: manifest.codec })) : [],
  };
}
