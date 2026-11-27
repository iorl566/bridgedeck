// src/video/verify.ts —— 录制校验：逐片 SHA-256 + 容器/分片日记/可 seek 证据。
//
// 兼容目标（只读）：extension/src/lib/video-verify.js。收敛后的判定口径：
// - verified：分片日记非空且逐片 SHA-256 全部匹配（字节按日记顺序连续切片）；
// - container：真实容器分析（mp4/webm/unknown），不按 mime 硬编；
// - problems：只有 severity='error' 的问题会否决 ok（warning/info 只作为证据）。

import { sha256Hex } from './hash.ts';
import {
  analyzeContainer,
  fragmentJournal,
  journalSummary,
  type FragmentJournal,
} from './mp4.ts';
import type { ContainerAnalysis, JournalSummary, VideoRecord } from './types.ts';

export interface VerifyProblem {
  code: string;
  severity: 'error' | 'warning' | 'info';
  scope: string;
  message: string;
  [key: string]: unknown;
}

export interface VerifyReport {
  ok: boolean;
  recordingId: string;
  chunks: number;
  verified: boolean;
  bytes: number;
  mismatches: Array<{ index: number; reason: string }>;
  hash: { coveredBytes: number; complete: boolean };
  container: ContainerAnalysis;
  journal: JournalSummary | null;
  journal_fragmented: boolean | null;
  journal_integrity: { ok: boolean; problems: VerifyProblem[]; stats: Record<string, number> } | null;
  seek: { seekable: boolean; faststart: boolean; hasSidx: boolean; missing: string[]; format: string };
  problems: VerifyProblem[];
}

function journalProblems(journal: FragmentJournal, requireComplete: boolean): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  if (!journal.hasFtyp) problems.push({ code: 'MISSING_FTYP', severity: 'error', scope: 'journal', message: '缺少 ftyp box' });
  if (!journal.hasMoov) problems.push({ code: 'MISSING_MOOV', severity: 'error', scope: 'journal', message: '缺少 moov box' });
  if (journal.fragmented) {
    if (!(journal.initBytes > 0)) problems.push({ code: 'INIT_MISSING', severity: 'error', scope: 'journal', message: 'fMP4 缺少 init 前缀（ftyp/moov）' });
    if (!journal.fragments.length) problems.push({ code: 'NO_COMPLETE_FRAGMENTS', severity: 'error', scope: 'journal', message: '没有任何完整的 moof+mdat 分片' });
    if (journal.openFragment) problems.push({ code: 'OPEN_FRAGMENT', severity: 'error', scope: 'journal', message: '存在未闭合的 moof（缺 mdat）' });
  }
  if (journal.totalBytes <= 0) problems.push({ code: 'EMPTY_CONTAINER', severity: 'error', scope: 'journal', message: '录制容器为空' });
  if (journal.trailingBytes > 0) {
    problems.push({
      code: 'TRAILING_BYTES',
      severity: requireComplete ? 'warning' : 'info',
      scope: 'journal',
      message: '尾部有未成帧字节（截断的 box）',
      trailingBytes: journal.trailingBytes,
    });
  }
  if (requireComplete && journal.completeFrames !== true) {
    problems.push({ code: 'INCOMPLETE_FRAMES', severity: 'warning', scope: 'journal', message: '分片日记未标记完帧' });
  }
  return problems;
}

/** 按分片日记逐片校验 SHA-256（覆盖字节必须等于 blob 大小）。 */
export async function verifyFragments(
  blob: Blob,
  fragments: VideoRecord['fragments'],
): Promise<{ mismatches: Array<{ index: number; reason: string }>; coveredBytes: number; complete: boolean }> {
  const mismatches: Array<{ index: number; reason: string }> = [];
  let offset = 0;
  const list = Array.isArray(fragments) ? fragments : [];
  for (const fragment of list) {
    const bytes = Number(fragment?.bytes) || 0;
    const slice = blob.slice(offset, offset + bytes);
    offset += bytes;
    if (!fragment || !fragment.sha256) {
      mismatches.push({ index: Number(fragment?.index) || 0, reason: 'missing-hash' });
      continue;
    }
    const digest = await sha256Hex(await slice.arrayBuffer());
    if (digest !== fragment.sha256) mismatches.push({ index: Number(fragment.index) || 0, reason: 'mismatch' });
  }
  return { mismatches, coveredBytes: offset, complete: offset === blob.size };
}

const MAX_ANALYZE_BYTES = 64 * 1024 * 1024;

/** 完整校验：分片哈希 + 容器 + 分片日记 + 可 seek；不读超过 maxAnalyzeBytes 的容器。 */
export async function verifyRecording(
  record: VideoRecord,
  options: { maxAnalyzeBytes?: number; requireComplete?: boolean } = {},
): Promise<VerifyReport> {
  const blob = record.blob;
  if (!blob || typeof blob.slice !== 'function') {
    throw new Error('录制缺少数据');
  }
  const maxBytes = Number(options.maxAnalyzeBytes) > 0 ? Number(options.maxAnalyzeBytes) : MAX_ANALYZE_BYTES;
  const problems: VerifyProblem[] = [];
  const fragments = Array.isArray(record.fragments) ? record.fragments : [];
  const hash = fragments.length
    ? await verifyFragments(blob, fragments)
    : { mismatches: [], coveredBytes: 0, complete: blob.size === 0 };
  for (const mismatch of hash.mismatches) {
    problems.push({
      code: mismatch.reason === 'mismatch' ? 'FRAGMENT_HASH_MISMATCH' : 'FRAGMENT_HASH_MISSING',
      severity: 'error',
      scope: 'fragments',
      index: mismatch.index,
      message: mismatch.reason === 'mismatch' ? '分片 SHA-256 不匹配' : '分片缺少 SHA-256',
    });
  }

  // 容器/日记分析上限内读全量；超限时只读前缀并把结果标成 unknown 前缀（不伪造）。
  const analyzeBytes = blob.size <= maxBytes ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(await blob.slice(0, maxBytes).arrayBuffer());
  const container = blob.size <= maxBytes
    ? analyzeContainer(analyzeBytes, record.mime)
    : { ...analyzeContainer(analyzeBytes, record.mime), truncated: true };
  let journal: FragmentJournal | null = null;
  let journalReport: VerifyReport['journal_integrity'] = null;
  if (container.format === 'mp4' && blob.size <= maxBytes) {
    journal = fragmentJournal(analyzeBytes);
    const list = journalProblems(journal, options.requireComplete !== false);
    for (const problem of list) problems.push(problem);
    journalReport = {
      ok: list.every((item) => item.severity !== 'error'),
      problems: list,
      stats: {
        fragments: journal.fragments.length,
        bytes: journal.fragments.reduce((sum, item) => sum + item.bytes, 0),
        trailingBytes: journal.trailingBytes,
        completeBytes: journal.completeBytes,
        initBytes: journal.initBytes,
        totalBytes: journal.totalBytes,
      },
    };
  }
  const hasSidx = container.hasSidx;
  const seek = {
    seekable: container.format === 'mp4' && container.hasMoov && (!container.fragmented || hasSidx),
    faststart: container.faststart === true,
    hasSidx,
    missing: [] as string[],
    format: container.format,
  };
  if (container.format !== 'mp4') seek.missing.push('mp4');
  else if (!container.hasMoov) seek.missing.push('moov');
  else if (container.fragmented && !hasSidx) seek.missing.push('sidx');
  if (!seek.faststart && seek.missing.length === 0) seek.missing.push('faststart');

  return {
    ok: hash.mismatches.length === 0 && problems.every((item) => item.severity !== 'error'),
    recordingId: String(record.id || ''),
    chunks: fragments.length,
    verified: fragments.length > 0 && hash.mismatches.length === 0,
    bytes: blob.size,
    mismatches: hash.mismatches,
    hash: { coveredBytes: hash.coveredBytes, complete: hash.complete },
    container,
    journal: journalSummary(journal),
    journal_fragmented: journal ? journal.fragmented : null,
    journal_integrity: journalReport,
    seek,
    problems,
  };
}
