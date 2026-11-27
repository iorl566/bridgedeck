// extension/src/lib/mp4-integrity.js —— MP4/fMP4 完帧与可 seek 深度校验。
//
// 与 mp4-boxes.js（容器概览）、mp4-fragments.js（分片日记）互补，本模块产出“帧级证据”：
//   - 缺帧：trun 采样本数为 0 / tfdt 起点比上一分片终点晚出一个以上帧时长；
//   - 时间戳回退：下一分片 tfdt baseTime < 上一分片 baseTime；
//   - 字节不连续：分片 moof+mdat 区间重叠（error）或中间空洞（warning，已知顶层 box 不算）；
//   - sidx/faststart 缺失：classifySeekReadiness 分类“是否可 seek、缺哪个索引”。
//
// video.js 的 video.verify 会用 record.blob 走一遍；video-recovery 在恢复审计里复用同一报告。
import { analyzeMp4 } from './mp4-boxes.js';
import {
  parseInit,
  parseFragments,
  scanTopBoxes,
  validateSegmentIndex,
} from './fmp4-sidx.js';
import { journalIntegrity } from './mp4-fragments.js';

import { MP4_INTEGRITY_CODES } from './video-codes.js';

export { MP4_INTEGRITY_CODES };

function problem(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && input.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  return new Uint8Array(0);
}

/**
 * 判断容器是否可 seek 以及缺哪个索引。
 * @param {object} container analyzeMp4 的输出
 */
export function classifySeekReadiness(container) {
  if (!container || typeof container !== 'object') {
    return { seekable: false, faststart: false, hasSidx: false, moovFirst: false, missing: ['container'], format: 'unknown' };
  }
  const hasMoov = container.hasMoov === true;
  const fragmented = container.fragmented === true || container.hasMoof === true;
  const hasSidx = container.hasSidx === true;
  const faststart = container.faststart === true;
  const missing = [];
  if (!hasMoov) missing.push('moov');
  if (fragmented && !hasSidx) missing.push('sidx');
  if (fragmented && !faststart && !hasSidx) missing.push('faststart');
  if (!fragmented && hasMoov && !faststart) missing.push('faststart');
  const seekable = hasMoov && (fragmented ? (hasSidx && faststart !== false) : true);
  return {
    seekable,
    faststart,
    hasSidx,
    moovFirst: faststart,
    fragmented,
    missing,
    format: String(container.format || 'mp4'),
  };
}

/** 两个 moof 之间若只是已知顶层 box，就不算“字节不连续”。 */
function classifyGap(view, expected, actual) {
  const boxes = scanTopBoxes(view);
  let cursor = expected;
  const types = [];
  for (const box of boxes) {
    if (box.offset < cursor) continue;
    if (box.offset !== cursor) break;
    if (box.offset + box.size > actual) break;
    types.push(box.type);
    cursor += box.size;
  }
  return { known: cursor === actual && types.length > 0, types, cursor };
}

/**
 * fMP4/MP4 深度完整性分析。
 * @param {Uint8Array|ArrayBuffer|DataView} input 完整文件字节（大文件由调用方限流）
 * @param {{journal?:object, toleranceMs?:number, toleranceTicks?:number, strictFrames?:boolean, expectedFrames?:number}} options
 */
export function analyzeMp4Integrity(input, options = {}) {
  const bytes = toBytes(input);
  const problems = [];
  const journal = options.journal && typeof options.journal === 'object' ? options.journal : null;
  if (!bytes.byteLength) {
    return {
      ok: false,
      fragmented: false,
      container: null,
      init: null,
      seek: { seekable: false, faststart: false, hasSidx: false, missing: ['container'] },
      stats: { fragments: 0, samples: 0, durationMs: 0, bytes: 0, byteGaps: 0, overlaps: 0, frameGaps: 0 },
      problems: [problem(MP4_INTEGRITY_CODES.EMPTY_CONTAINER, 'error', '视频容器为空')],
      journal: null,
    };
  }
  const container = analyzeMp4(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let journalReport = null;
  if (journal) {
    journalReport = journalIntegrity(journal, { requireComplete: options.requireComplete !== false });
    for (const item of journalReport.problems) problems.push({ ...item, scope: 'journal' });
  }
  if (!container.hasFtyp) problems.push(problem(MP4_INTEGRITY_CODES.MISSING_FTYP, 'error', '缺少 ftyp box'));
  if (!container.hasMoov) problems.push(problem(MP4_INTEGRITY_CODES.MISSING_MOOV, 'error', '缺少 moov box'));
  const seek = classifySeekReadiness(container);
  if (container.fragmented && !container.hasSidx) {
    problems.push(problem(MP4_INTEGRITY_CODES.SIDX_MISSING, 'warning', 'fMP4 缺少 sidx（不可精确 seek）', { missing: seek.missing }));
  }

  let init = null;
  let fragments = [];
  const stats = {
    fragments: 0,
    samples: 0,
    durationTicks: 0,
    durationMs: 0,
    timescale: 0,
    bytes: bytes.byteLength,
    firstBaseTime: 0,
    lastBaseTime: 0,
    byteGaps: 0,
    overlaps: 0,
    frameGaps: 0,
    missingFrameTicks: 0,
  };

  if (container.fragmented) {
    init = parseInit(view);
    if (!init) {
      problems.push(problem(MP4_INTEGRITY_CODES.INIT_UNPARSABLE, 'error', 'moov/track 初始化段无法解析'));
    }
    fragments = parseFragments(view);
    stats.fragments = fragments.length;
    stats.timescale = (init && init.timescale) || 0;
    if (!fragments.length) {
      problems.push(problem(MP4_INTEGRITY_CODES.NO_FRAGMENTS, 'error', '没有完整的 moof+mdat 分片'));
    }
    const toleranceTicks = (() => {
      const explicit = Number(options.toleranceTicks);
      if (Number.isFinite(explicit) && explicit >= 0) return explicit;
      const ms = Number(options.toleranceMs);
      if (Number.isFinite(ms) && ms >= 0) return Math.ceil((ms / 1000) * (stats.timescale || 1000));
      return Math.ceil((2 / 1000) * (stats.timescale || 1000)); // 默认容忍 2ms 取整误差
    })();
    let previous = null;
    for (let i = 0; i < fragments.length; i += 1) {
      const fragment = fragments[i];
      stats.samples += Number(fragment.samples) || 0;
      if (!(Number(fragment.bytes) > 0)) {
        problems.push(problem(MP4_INTEGRITY_CODES.EMPTY_FRAGMENT, 'error', '分片字节数为 0', { index: i }));
      }
      if (!(Number(fragment.samples) > 0)) {
        problems.push(problem(MP4_INTEGRITY_CODES.EMPTY_FRAGMENT, 'error', '分片没有任何样本（缺帧）', { index: i }));
      } else if (!(Number(fragment.duration) > 0)) {
        problems.push(problem(MP4_INTEGRITY_CODES.ZERO_DURATION_FRAGMENT, 'warning', '分片样本时长之和为 0（trun 缺 duration）', { index: i, samples: fragment.samples }));
      }
      if (i === 0 && fragment.sync === false) {
        problems.push(problem(MP4_INTEGRITY_CODES.FIRST_FRAGMENT_NOT_SYNC, 'warning', '首个分片不是同步样本（前段无法解码）', { index: i }));
      }
      if (previous) {
        const previousEnd = (Number(previous.baseTime) || 0) + (Number(previous.duration) || 0);
        const baseTime = Number(fragment.baseTime) || 0;
        if (baseTime < (Number(previous.baseTime) || 0)) {
          problems.push(problem(MP4_INTEGRITY_CODES.TIMESTAMP_REGRESSION, 'error', '分片时间戳回退', {
            index: i,
            baseTime,
            previous: previous.baseTime,
          }));
        } else if ((Number(previous.duration) || 0) > 0 && (Number(fragment.duration) || 0) > 0 && baseTime > previousEnd + toleranceTicks) {
          const missingFrameTicks = baseTime - previousEnd;
          stats.frameGaps += 1;
          stats.missingFrameTicks += missingFrameTicks;
          problems.push(problem(
            MP4_INTEGRITY_CODES.FRAME_GAP,
            options.strictFrames === true ? 'error' : 'warning',
            '分片之间时间戳不连续（缺帧）',
            {
              index: i,
              expectedBaseTime: previousEnd,
              baseTime,
              missingFrameTicks,
              missingMs: stats.timescale > 0 ? (missingFrameTicks / stats.timescale) * 1000 : null,
            },
          ));
        } else if ((Number(fragment.duration) || 0) > 0 && baseTime + (Number(fragment.duration) || 0) <= (Number(previous.baseTime) || 0)) {
          problems.push(problem(MP4_INTEGRITY_CODES.FRAME_OVERLAP, 'error', '分片时间区间完全重叠', {
            index: i,
            baseTime,
            duration: fragment.duration,
            previous: previous.baseTime,
          }));
        }
        if (!journal) {
          const expectedOffset = (Number(previous.moofOffset) || 0) + (Number(previous.bytes) || 0);
          const actualOffset = Number(fragment.moofOffset) || 0;
          if (actualOffset < expectedOffset) {
            stats.overlaps += 1;
            problems.push(problem(MP4_INTEGRITY_CODES.BYTE_OVERLAP, 'error', '分片字节区间重叠', { index: i, expected: expectedOffset, actual: actualOffset }));
          } else if (actualOffset > expectedOffset) {
            const gap = classifyGap(view, expectedOffset, actualOffset);
            if (!gap.known) {
              stats.byteGaps += 1;
              problems.push(problem(MP4_INTEGRITY_CODES.BYTE_GAP, 'warning', '分片之间字节不连续', { index: i, expected: expectedOffset, actual: actualOffset, gapBytes: actualOffset - expectedOffset }));
            }
          }
        }
      }
      previous = fragment;
    }
    if (previous) {
      stats.firstBaseTime = Number(fragments[0].baseTime) || 0;
      stats.lastBaseTime = Number(previous.baseTime) || 0;
      stats.durationTicks = Math.max(0, (Number(previous.baseTime) || 0) + (Number(previous.duration) || 0) - stats.firstBaseTime);
      stats.durationMs = stats.timescale > 0 ? (stats.durationTicks / stats.timescale) * 1000 : 0;
    }
    if (!(stats.samples > 0) && fragments.length > 0) {
      problems.push(problem(MP4_INTEGRITY_CODES.NO_VIDEO_SAMPLES, 'error', '所有分片都没有视频样本'));
    }
    // 显式期望帧数（调用方可传入录制期间累计的帧数/样本数），用于“缺帧”定量证据。
    const expectedFrames = Number(options.expectedFrames);
    if (Number.isFinite(expectedFrames) && expectedFrames > stats.samples) {
      problems.push(problem(MP4_INTEGRITY_CODES.MISSING_FRAMES, options.strictFrames === true ? 'error' : 'warning', '实际样本数少于期望帧数', {
        expected: Math.round(expectedFrames),
        actual: stats.samples,
        missing: Math.round(expectedFrames - stats.samples),
      }));
    }
    // sidx 结构校验（存在时）：只读 bytes 内的 sidx。
    if (container.hasSidx && init && init.hasSidx) {
      const sidxReport = validateSegmentIndex(bytes);
      if (!sidxReport.ok) {
        for (const item of sidxReport.problems) problems.push({ ...item, scope: 'sidx' });
      }
    }
  } else {
    if (!container.hasMdat) problems.push(problem(MP4_INTEGRITY_CODES.MISSING_MDAT, 'warning', '没有 mdat（无媒体数据）'));
    if (!container.faststart) problems.push(problem(MP4_INTEGRITY_CODES.FASTSTART_MISSING, 'warning', 'moov 不在 mdat 之前（非 faststart，首帧前需下载完整文件头）'));
    stats.durationMs = 0;
  }

  if (journal && Number(journal.trailingBytes) > 0) {
    problems.push(problem(MP4_INTEGRITY_CODES.TRUNCATED, 'warning', '容器尾部有未成帧字节', { trailingBytes: Number(journal.trailingBytes) || 0 }));
  }

  return {
    ok: problems.every((item) => item.severity !== 'error'),
    fragmented: container.fragmented,
    container,
    init,
    seek,
    stats,
    problems,
    journal: journalReport
      ? { ok: journalReport.ok, fragmented: journalReport.fragmented, stats: journalReport.stats, problems: journalReport.problems }
      : null,
  };
}

/** 报告摘要（video.verify 返回用；保留 problems 明细但不回传 container boxDetails）。 */
export function summarizeIntegrity(report) {
  if (!report || typeof report !== 'object') return null;
  return {
    ok: report.ok === true,
    fragmented: report.fragmented === true,
    ...(report.skipped === true ? { skipped: true, reason: report.reason || null, ...(report.error ? { error: report.error } : {}), ...(report.maxAnalyzeBytes ? { maxAnalyzeBytes: report.maxAnalyzeBytes } : {}) } : {}),
    seekable: Boolean(report.seek && report.seek.seekable),
    faststart: Boolean(report.seek && report.seek.faststart),
    hasSidx: Boolean(report.seek && report.seek.hasSidx),
    missing: Array.isArray(report.seek && report.seek.missing) ? report.seek.missing : [],
    stats: report.stats || null,
    problems: Array.isArray(report.problems)
      ? report.problems.map((item) => ({ code: item.code, severity: item.severity, message: item.message, ...(item.index != null ? { index: item.index } : {}), ...(item.scope ? { scope: item.scope } : {}) }))
      : [],
    errors: Array.isArray(report.problems) ? report.problems.filter((item) => item.severity === 'error').length : 0,
    warnings: Array.isArray(report.problems) ? report.problems.filter((item) => item.severity === 'warning').length : 0,
  };
}
