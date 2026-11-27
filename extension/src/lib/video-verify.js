// 视频分片校验：按分片 slice 读取，避免把整段视频读进内存。
// 在既有逐片 SHA-256 校验之上，叠加容器/分片日记/帧级完整性/可 seek 分类证据，
// 供 video.verify 与崩溃恢复审计（video-recovery）共用。
import { analyzeMp4 } from './mp4-boxes.js';
import { fragmentJournalFromBlob, journalIntegrity } from './mp4-fragments.js';
import { analyzeMp4Integrity, classifySeekReadiness, summarizeIntegrity } from './mp4-integrity.js';
import { validateManifest, summarizeManifest } from './video-manifest.js';
import { VIDEO_VERIFY_CODES } from './video-codes.js';

const DEFAULT_MAX_ANALYZE_BYTES = 64 * 1024 * 1024;

function hex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyFragments(blob, fragments, options = {}) {
  const cryptoImpl = options.cryptoImpl || globalThis.crypto;
  const list = Array.isArray(fragments) ? fragments : [];
  const mismatches = [];
  let offset = 0;
  for (const fragment of list) {
    const bytes = Number(fragment && fragment.bytes) || 0;
    const slice = blob.slice(offset, offset + bytes);
    offset += bytes;
    if (!fragment || !fragment.sha256) {
      mismatches.push({ index: fragment && fragment.index, reason: 'missing-hash' });
      continue;
    }
    const digest = hex(await cryptoImpl.subtle.digest('SHA-256', await slice.arrayBuffer()));
    if (digest !== fragment.sha256) mismatches.push({ index: fragment.index, reason: 'mismatch' });
  }
  return { mismatches, coveredBytes: offset, complete: offset === blob.size };
}

/** 只读前缀用于容器识别（fMP4 顶层 box 在开头；避免为 analyzeMp4 读整段视频）。 */
export async function readContainerPrefix(blob, bytes = 1024 * 1024) {
  const size = Math.max(1, Number(bytes) || 0);
  return new Uint8Array(await blob.slice(0, Math.min(blob.size, size)).arrayBuffer());
}

/** 容器识别：非 mp4/mime 未知时回退 webm 标记（与既有 video.verify 行为一致）。 */
export async function inspectContainer(record) {
  const mime = String((record && record.mime) || '');
  const blob = record && record.blob;
  if (!blob || typeof blob.slice !== 'function') return { format: 'unknown' };
  const isMp4 = !mime || /mp4/i.test(mime);
  return isMp4 ? analyzeMp4(await readContainerPrefix(blob)) : { format: 'webm' };
}

/**
 * 完整录制校验报告：
 * - fragment_hashes：逐片 SHA-256 与覆盖字节（既有 video.verify 语义）；
 * - container：MP4 容器概览（格式/fragmented/moov/moof/sidx）；
 * - journal：分片日记 + 连续性/完帧问题；
 * - frames：帧级完整性（缺帧、时间戳回退、字节不连续）与可 seek 分类；
 * - manifest：opfs seal 摘要（若录制时已 seal）；
 * - problems：以上各层的合并问题清单（带 scope）。
 */
export async function verifyRecording(record, options = {}) {
  if (!record || typeof record !== 'object') throw new Error('缺少录制记录');
  const blob = record.blob;
  if (!blob || typeof blob.slice !== 'function') throw new Error('录制缺少数据');
  const id = String(record.id || options.recordingId || '');
  const fragments = Array.isArray(record.fragments) ? record.fragments : [];
  const maxAnalyzeBytes = Number(options.maxAnalyzeBytes) > 0 ? Number(options.maxAnalyzeBytes) : DEFAULT_MAX_ANALYZE_BYTES;
  const problems = [];

  const hash = fragments.length
    ? await verifyFragments(blob, fragments, options)
    : { mismatches: [], coveredBytes: 0, complete: blob.size === 0 };
  for (const mismatch of hash.mismatches) {
    problems.push({
      code: mismatch.reason === 'mismatch' ? VIDEO_VERIFY_CODES.FRAGMENT_HASH_MISMATCH : VIDEO_VERIFY_CODES.FRAGMENT_HASH_MISSING,
      severity: 'error',
      scope: 'fragments',
      index: mismatch.index,
      message: mismatch.reason === 'mismatch' ? '分片 SHA-256 不匹配' : '分片缺少 SHA-256',
    });
  }

  const container = await inspectContainer(record);
  const isMp4 = container.format === 'mp4';
  let journal = null;
  let journalReport = null;
  let integrity = null;
  let seek = isMp4 ? classifySeekReadiness(container) : { seekable: false, faststart: false, hasSidx: false, missing: ['mp4'], format: container.format };
  if (isMp4) {
    journal = await fragmentJournalFromBlob(blob).catch(() => null);
    journalReport = journal ? journalIntegrity(journal, { requireComplete: options.requireComplete !== false }) : null;
    if (journalReport) {
      for (const item of journalReport.problems) problems.push({ ...item, scope: 'journal' });
    }
    if (blob.size <= maxAnalyzeBytes) {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        integrity = analyzeMp4Integrity(bytes, {
          journal,
          toleranceMs: options.toleranceMs,
          toleranceTicks: options.toleranceTicks,
          strictFrames: options.strictFrames === true,
          expectedFrames: options.expectedFrames != null ? Number(options.expectedFrames) : record.frames,
          requireComplete: options.requireComplete !== false,
        });
        seek = classifySeekReadiness(integrity.container || container);
        for (const item of integrity.problems) problems.push({ ...item, scope: item.scope || 'frames' });
      } catch (error) {
        integrity = {
          ok: null,
          skipped: true,
          reason: 'analyze_failed',
          error: String((error && error.message) || error),
          problems: [{ code: VIDEO_VERIFY_CODES.FRAME_ANALYSIS_FAILED, severity: 'warning', message: '帧级完整性分析失败' }],
        };
      }
    } else {
      integrity = {
        ok: null,
        skipped: true,
        reason: 'size_limit',
        maxAnalyzeBytes,
        problems: [{ code: VIDEO_VERIFY_CODES.FRAME_ANALYSIS_SKIPPED, severity: 'info', message: '录制超过帧级分析上限，跳过时间戳/缺帧检查' }],
      };
    }
  }

  let manifest = null;
  if (options.manifest && typeof options.manifest === 'object') {
    const validation = validateManifest(options.manifest);
    manifest = { ...summarizeManifest(options.manifest), validation: { ok: validation.ok, problems: validation.problems } };
    for (const item of validation.problems) problems.push({ ...item, scope: 'manifest' });
  } else if (record.segment_manifest && typeof record.segment_manifest === 'object') {
    manifest = { ...record.segment_manifest };
  }

  return {
    recordingId: id,
    chunks: fragments.length,
    verified: fragments.length > 0 && hash.mismatches.length === 0,
    bytes: blob.size,
    mismatches: hash.mismatches,
    hash: { coveredBytes: hash.coveredBytes, complete: hash.complete },
    container,
    journal: journalReport ? journalReport.stats : null,
    journal_fragmented: journalReport ? journalReport.fragmented : null,
    journal_integrity: journalReport ? { ok: journalReport.ok, problems: journalReport.problems, stats: journalReport.stats } : null,
    integrity: integrity ? summarizeIntegrity(integrity) : null,
    frames: integrity && !integrity.skipped ? integrity.stats : null,
    seek,
    manifest,
    problems,
    ok: hash.mismatches.length === 0 && problems.every((item) => item.severity !== 'error'),
  };
}
