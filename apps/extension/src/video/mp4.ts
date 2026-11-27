// src/video/mp4.ts —— ISO BMFF / WebM 容器分析 + fMP4 分片日记 + 完帧裁切（纯字节函数）。
//
// 兼容目标（只读）：extension/src/lib/mp4-boxes.js + extension/src/lib/mp4-fragments.js。
// 这里做 TS 化收敛：
// - 顶层 box 扫描只读头部，不做解码；fMP4 用 moof+mdat 成对判定完整分片；
// - faststart 只有在「moov 真实位于 mdat 之前」时才为 true（绝不由 mime/配置推断）；
// - 完帧裁切只截字节、不重编码，保证 video.verify 的逐片 SHA-256 仍然成立。

import type { ContainerAnalysis, FragmentEntry, JournalSummary } from './types.ts';

const MAX_SCAN_BOXES = 10000;

export interface Mp4Box {
  type: string;
  size: number;
  offset: number;
}

export interface BoxScan {
  boxes: Mp4Box[];
  parsedBytes: number;
  trailingBytes: number;
}

export interface FragmentBox {
  index: number;
  moofOffset: number;
  moofBytes: number;
  mdatOffset: number | null;
  mdatBytes: number;
  bytes: number;
}

export interface FragmentJournal {
  totalBytes: number;
  parsedBytes: number;
  trailingBytes: number;
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMoof: boolean;
  fragmented: boolean;
  initBytes: number;
  fragments: FragmentBox[];
  completeBytes: number;
  completeFrames: boolean;
  openFragment: boolean;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = '';
  const limit = Math.min(end, bytes.length);
  for (let i = start; i < limit; i += 1) text += String.fromCharCode(bytes[i] ?? 0);
  return text;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset);
}

function readUint64(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const high = view.getUint32(offset);
  const low = view.getUint32(offset + 4);
  return high * 4294967296 + low;
}

/** 流式语义的顶层 box 扫描：遇到截断尾部 box 停止，并报告 trailingBytes。 */
export function scanTopLevelBoxes(bytes: Uint8Array, options: { maxBoxes?: number } = {}): BoxScan {
  const maxBoxes = Number(options.maxBoxes) > 0 ? Number(options.maxBoxes) : MAX_SCAN_BOXES;
  const boxes: Mp4Box[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length && boxes.length < maxBoxes) {
    let size = readUint32(bytes, offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      size = readUint64(bytes, offset + 8);
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (!Number.isSafeInteger(size) || size < header || offset + size > bytes.length) break;
    boxes.push({ type, size, offset });
    offset += size;
  }
  return { boxes, parsedBytes: offset, trailingBytes: Math.max(0, bytes.length - offset) };
}

/** WebM/Matroska 魔数（EBML：1A 45 DF A3）。 */
export function looksLikeWebm(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

/** MP4 魔数：ftyp 位于偏移 4..8（size 字段之后）。 */
export function looksLikeMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && ascii(bytes, 4, 8) === 'ftyp';
}

/** 容器概览；mimeHint 只在字节魔数无法判定时用于兜底（仍会给出 unknown 而不是伪造 mp4）。 */
export function analyzeContainer(bytes: Uint8Array, mimeHint = ''): ContainerAnalysis {
  const scan = scanTopLevelBoxes(bytes);
  const types = scan.boxes.map((box) => box.type);
  const hasFtyp = types.includes('ftyp');
  const hasMoov = types.includes('moov');
  const hasMoof = types.includes('moof');
  const hasSidx = types.includes('sidx');
  const moov = scan.boxes.find((box) => box.type === 'moov') ?? null;
  const mdat = scan.boxes.find((box) => box.type === 'mdat') ?? null;
  const moof = scan.boxes.find((box) => box.type === 'moof') ?? null;
  let format: ContainerAnalysis['format'] = 'unknown';
  if (looksLikeMp4(bytes) || hasFtyp) format = 'mp4';
  else if (looksLikeWebm(bytes)) format = 'webm';
  else if (/webm/i.test(mimeHint)) format = 'webm';
  return {
    format,
    fragmented: hasMoof,
    boxes: types.slice(0, 40),
    hasFtyp,
    hasMoov,
    hasMoof,
    hasSidx,
    moovOffset: moov ? moov.offset : null,
    mdatOffset: mdat ? mdat.offset : null,
    firstMoofOffset: moof ? moof.offset : null,
    faststart: Boolean(moov && (mdat === null || moov.offset < mdat.offset)),
    parsedBytes: scan.parsedBytes,
    truncated: scan.trailingBytes > 0,
  };
}

/** 分片日记：init 前缀（首个 moof 之前）+ 完整 moof+mdat 对 + 完帧边界。 */
export function fragmentJournal(bytes: Uint8Array): FragmentJournal {
  const scan = scanTopLevelBoxes(bytes);
  const types = scan.boxes.map((box) => box.type);
  const hasFtyp = types.includes('ftyp');
  const hasMoov = types.includes('moov');
  const hasMoof = types.includes('moof');
  const fragments: FragmentBox[] = [];
  let initBytes = 0;
  let pending: FragmentBox | null = null;
  for (const box of scan.boxes) {
    if (box.type === 'moof') {
      if (!hasMoov) continue;
      if (!initBytes) initBytes = box.offset;
      if (pending) pending = null;
      pending = {
        index: fragments.length,
        moofOffset: box.offset,
        moofBytes: box.size,
        mdatOffset: null,
        mdatBytes: 0,
        bytes: box.size,
      };
      continue;
    }
    if (box.type === 'mdat' && pending) {
      pending.mdatOffset = box.offset;
      pending.mdatBytes = box.size;
      pending.bytes = box.offset + box.size - pending.moofOffset;
      fragments.push(pending);
      pending = null;
    }
  }
  const last = fragments[fragments.length - 1];
  const completeBytes = last
    ? last.moofOffset + last.bytes
    : (hasMoof ? initBytes : (hasFtyp && hasMoov ? scan.parsedBytes : 0));
  return {
    totalBytes: bytes.length,
    parsedBytes: scan.parsedBytes,
    trailingBytes: scan.trailingBytes,
    hasFtyp,
    hasMoov,
    hasMoof,
    fragmented: hasMoof,
    initBytes,
    fragments,
    completeBytes,
    completeFrames: pending === null && scan.trailingBytes === 0 && (!hasMoof || fragments.length > 0),
    openFragment: pending !== null,
  };
}

/** 分片日记 → 公开摘要（字段与 extension/src/lib/video-meta.js journalSummary 一致）。 */
export function journalSummary(journal: FragmentJournal | null | undefined): JournalSummary | null {
  if (!journal) return null;
  return {
    fragmented: journal.fragmented === true,
    init_bytes: journal.initBytes,
    fragments: journal.fragments.length,
    complete_bytes: journal.completeBytes,
    trailing_bytes: journal.trailingBytes,
    complete_frames: journal.completeFrames === true,
    open_fragment: journal.openFragment === true,
  };
}

/** 只取完整分片前缀（不重编码）；没有需要裁的字节时原样返回。 */
export function completeFragmentBytes(bytes: Uint8Array, journal: FragmentJournal | null | undefined): Uint8Array {
  const length = Number(journal?.completeBytes);
  if (!Number.isFinite(length) || length <= 0 || length >= bytes.length) return bytes;
  return bytes.slice(0, length);
}

export interface FragmentPackage {
  bytes: Uint8Array;
  fragments: FragmentEntry[];
  trimmedBytes: number;
  completeBytes: number;
  chunkCount: number;
}

/**
 * 完帧重封装（纯函数）：按 journal.completeBytes 截到最后一个完整分片，
 * 只保留完全落在截断范围内的分片日志（保证 video.verify 逐片 SHA-256 仍成立）。
 */
export function completeFragmentPackage(
  bytes: Uint8Array,
  journal: FragmentJournal | null | undefined,
  fragments: FragmentEntry[] = [],
): FragmentPackage {
  const length = Number(journal?.completeBytes);
  const list = Array.isArray(fragments) ? fragments : [];
  if (!Number.isFinite(length) || length <= 0 || length >= bytes.length) {
    return {
      bytes,
      fragments: list,
      trimmedBytes: 0,
      completeBytes: bytes.length,
      chunkCount: list.length,
    };
  }
  const kept: FragmentEntry[] = [];
  let sum = 0;
  for (const entry of list) {
    const size = Number(entry?.bytes) || 0;
    if (sum + size > length) break;
    kept.push(entry);
    sum += size;
  }
  const trimmed = bytes.slice(0, length);
  return {
    bytes: trimmed,
    fragments: kept,
    trimmedBytes: bytes.length - trimmed.length,
    completeBytes: length,
    chunkCount: kept.length,
  };
}

/** 兼容目标的 MediaRecorder 格式优先级：MP4(avc1) → MP4 → VP9 → WebM。 */
export const VIDEO_MIME_CANDIDATES: readonly string[] = Object.freeze([
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
]);

/** 在浏览器实际支持的候选里挑第一个；都不支持返回空串（不在没有支持时硬写 mp4）。 */
export function pickVideoMime(
  supported: (mime: string) => boolean,
  preferred = '',
  candidates: readonly string[] = VIDEO_MIME_CANDIDATES,
): string {
  const list = preferred ? [preferred, ...candidates] : [...candidates];
  for (const mime of list) {
    try {
      if (supported(mime)) return mime;
    } catch {
      // 继续试下一个
    }
  }
  return '';
}

/** mime → 容器名（页面 selftest 标题里的 mp4|webm 段）。 */
export function containerOfMime(mime: string): 'mp4' | 'webm' {
  return /mp4/i.test(String(mime)) ? 'mp4' : 'webm';
}

/** 尺寸归一到偶数（AVC 要求宽高为偶数）。 */
export function evenDimension(value: number, fallback: number): number {
  const number = Number(value);
  const base = Number.isFinite(number) && number >= 2 ? Math.round(number) : fallback;
  return Math.max(2, base - (base % 2));
}
