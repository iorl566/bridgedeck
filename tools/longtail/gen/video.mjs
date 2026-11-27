// tools/longtail/gen/video.mjs —— 大视频 manifest / 分片夹具生成器（确定性、≥100 分片）。
//
// 生成的是 `extension/src/lib/video-manifest.js` 的真实输入：
//   - segments：{index, atMs, lastFrameAt, bytes, codec, checksum}
//   - budget：{maxDurationMs, maxSegmentBytes, maxTotalBytes}
//   - recoveryCases：完整/缺片/截断/校验和损坏/未登记分片/零分片 六种恢复现场
//
// 场景随后用真实模块消费：
//   - createSegmentManifest / appendSegment（逐片落盘）
//   - validateManifest（结构/序号/时间/校验和校验）
//   - sealManifest（真实 SHA-256 双摘要：manifest 摘要 + 分片链摘要）
//   - planSegmentRecovery / manifestRecordFields（崩溃恢复 + 录制记录对账）
//
// 分片内容由 segmentContent() 确定性生成（同一 index/bytes/seed → 同一字节流），
// 所以 checksum 可以独立重算：场景会从 tmp 实际读回文件再算一遍，验证"记录侧 vs 文件侧"一致。

import { DEFAULT_SEED, rngFor, stableHash, sha256HexSync } from '../lib/prng.mjs';

export const VIDEO_FIXTURE_VERSION = 1;

/** 固定录制开始时间（不读时钟）。 */
export const VIDEO_BASE_AT = Date.parse('2026-03-01T00:00:00.000Z');

/** 默认每片时长（ms）。 */
export const SEGMENT_DURATION_MS = 500;

/**
 * 确定性的分片内容。
 * @param {{index:number, bytes:number}} segment
 * @returns {Buffer}
 */
export function segmentContent(segment) {
  const index = Math.max(0, Math.floor(Number(segment && segment.index) || 0));
  const size = Math.max(1, Math.floor(Number(segment && segment.bytes) || 1));
  const buffer = Buffer.alloc(size, (index * 37 + 11) & 0xff);
  const header = Buffer.from('LTSEG|' + String(index).padStart(6, '0') + '|' + size + '|', 'utf8');
  header.copy(buffer, 0, 0, Math.min(header.length, size));
  // 每 512 字节写一个确定性标记，避免分片退化成纯常量（仍然完全确定）。
  for (let offset = 64; offset + 4 <= size; offset += 512) {
    buffer.writeUInt32LE((Math.imul(index + 1, 2654435761) >>> 0), offset);
  }
  return buffer;
}

/**
 * 生成大视频 manifest 夹具。
 * @param {{segments?:number, segmentBytes?:number, budgetBytes?:number, seed?:string|number,
 *          profile?:string, baseAt?:number, durationPerSegmentMs?:number}} [options]
 */
export function buildVideoFixture(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const segmentCount = Math.max(1, Math.floor(Number(opts.segments) || 120));
  const segmentBytes = Math.max(1024, Math.floor(Number(opts.segmentBytes) || 48_000));
  const budgetBytes = Math.max(segmentBytes, Math.floor(Number(opts.budgetBytes) || 12_000_000));
  const seed = opts.seed == null ? DEFAULT_SEED : opts.seed;
  const profile = String(opts.profile || 'default');
  const baseAt = Number.isFinite(Number(opts.baseAt)) ? Number(opts.baseAt) : VIDEO_BASE_AT;
  const durationPerSegmentMs = Math.max(100, Math.floor(Number(opts.durationPerSegmentMs) || SEGMENT_DURATION_MS));

  const rng = rngFor(seed, 'video', segmentCount, segmentBytes);
  const segments = [];
  // 分片字节抖动限制在 ±15%（且不超过 4096B），保证小 segmentBytes 时也恒为正数。
  const jitter = Math.max(1, Math.min(4096, Math.floor(segmentBytes * 0.15)));
  let bytesTotal = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    // atMs 严格递增（jitter 上限 20ms << 每片 500ms），lastFrameAt 不越过下一片起点。
    const atMs = index * durationPerSegmentMs + rng.int(0, 20);
    const lastFrameAt = atMs + rng.int(80, durationPerSegmentMs - 80);
    const bytes = segmentBytes + rng.int(-jitter, jitter);
    const segment = { index, atMs, lastFrameAt, bytes, codec: 'avc' };
    segment.checksum = sha256HexSync(segmentContent(segment));
    bytesTotal += bytes;
    segments.push(segment);
  }

  const stats = {
    segments: segments.length,
    bytes: bytesTotal,
    durationMs: segments.length ? segments[segments.length - 1].lastFrameAt - segments[0].atMs : 0,
    segmentBytesAvg: Math.round(bytesTotal / segments.length),
    maxSegmentBytes: segments.reduce((max, segment) => Math.max(max, segment.bytes), 0),
  };
  const fingerprint = stableHash({
    version: VIDEO_FIXTURE_VERSION,
    seed: String(seed),
    profile,
    segments: segments.map((segment) => [segment.index, segment.atMs, segment.lastFrameAt, segment.bytes, segment.checksum.slice(0, 12)]),
  });

  return {
    version: VIDEO_FIXTURE_VERSION,
    kind: 'video',
    seed: String(seed),
    profile,
    recordingId: 'rec-' + deriveRecordingId(seed, segmentCount),
    codec: 'avc',
    mime: 'video/mp4',
    mode: 'tab-capture',
    tabId: 7,
    url: 'https://longtail.test/record?seed=' + String(seed),
    title: '长尾视频录制 ' + segmentCount + ' 片',
    baseAt,
    budget: {
      maxDurationMs: durationPerSegmentMs * (segmentCount + 10),
      maxSegmentBytes: segmentBytes * 2,
      maxTotalBytes: budgetBytes,
    },
    segments,
    stats,
    recoveryCases: buildRecoveryCases(segments, segmentBytes),
    fingerprint,
  };
}

function deriveRecordingId(seed, segmentCount) {
  return stableHash({ seed: String(seed), segmentCount }).slice(0, 12);
}

/**
 * 恢复现场定义：每个 case 描述"OPFS 里实际能读到什么"。
 * 场景按 case 构造 availableParts 后调用真实 planSegmentRecovery，并断言完整性/错误码。
 * 错误码形如 E_VIDEO_SEGMENT_*（`lib/video-codes.js` 的真实 code 值）。
 */
export function buildRecoveryCases(segments, segmentBytes) {
  const count = Array.isArray(segments) ? segments.length : 0;
  const middle = Math.max(1, Math.floor(count / 3));
  const corruptAt = Math.max(1, Math.floor(count / 2));
  const truncateAt = Math.max(1, Math.floor(count * 0.75));
  return [
    {
      name: 'complete',
      description: '所有分片都在且校验和一致',
      dropIndexes: [],
      expect: { recovered: true, completeness: 'complete', state: 'recovered', keptSegments: count, codes: [] },
    },
    {
      name: 'missing-middle',
      description: '中间丢了一片：只能恢复前缀（partial）',
      dropIndexes: [middle],
      expect: { recovered: true, completeness: 'partial', state: 'recovered', keptSegments: middle, codes: ['E_VIDEO_SEGMENT_MISSING'] },
    },
    {
      name: 'truncated',
      description: '末尾前一片被截断：保留已写入字节并终止（partial）',
      truncate: { index: truncateAt, bytes: Math.max(1, Math.floor(segmentBytes / 3)) },
      expect: { recovered: true, completeness: 'partial', state: 'recovered', keptSegments: truncateAt + 1, codes: ['E_VIDEO_SEGMENT_TRUNCATED'] },
    },
    {
      name: 'checksum-mismatch',
      description: '内容损坏（校验和不符）：丢弃该片及其后所有分片（partial）',
      corruptIndexes: [corruptAt],
      expect: { recovered: true, completeness: 'partial', state: 'recovered', keptSegments: corruptAt, codes: ['E_VIDEO_SEGMENT_CHECKSUM_MISMATCH'] },
    },
    {
      name: 'unlisted-part',
      description: 'OPFS 里有多余分片：忽略并给 warning，完整性不受影响',
      extraPart: { index: count + 5, bytes: 1024, checksum: sha256HexSync('unlisted-part') },
      expect: { recovered: true, completeness: 'complete', state: 'recovered', keptSegments: count, codes: ['E_VIDEO_SEGMENT_UNLISTED'] },
    },
    {
      name: 'no-parts',
      description: 'OPFS 为空：完全不可恢复（failed）',
      dropAll: true,
      expect: { recovered: false, completeness: 'failed', state: 'failed', keptSegments: 0, codes: ['E_VIDEO_SEGMENT_UNAVAILABLE'] },
    },
  ];
}

/** 分片字节→恢复 case 用的 availableParts 形状。 */
export function partRefOf(segment) {
  return { index: segment.index, bytes: segment.bytes, checksum: segment.checksum, position: segment.atMs };
}
