/**
 * ISO BMFF（MP4）分片日记：按 Blob 头部流式扫描顶层 box，识别 moov/moof/mdat，
 * 计算"最后一个完整分片"的字节边界，供录制收尾与恢复使用。
 *
 * 只读 16 字节头，不把整段视频读进内存；与 page/CLI 的 mp4-boxes.js 互补：
 * - mp4-boxes.js：一次性 bytes 的容器概览（fragmented/ftyp/moov）；
 * - 本模块：Blob 上的完整分片日记（用于 fMP4 完帧判定与可恢复边界）。
 */

function ascii(bytes, start, end) {
  let text = '';
  for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

/** 流式扫描顶层 box；遇到截断的尾部 box 时停止，并报告 trailingBytes。 */
export async function scanBoxesFromBlob(blob, options = {}) {
  const maxBoxes = Number(options.maxBoxes) > 0 ? Number(options.maxBoxes) : 10000;
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= blob.size && boxes.length < maxBoxes) {
    const head = new Uint8Array(await blob.slice(offset, Math.min(offset + 16, blob.size)).arrayBuffer());
    if (head.length < 8) break;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    const type = ascii(head, 4, 8);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = Number(view.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = blob.size - offset;
    }
    if (!Number.isSafeInteger(size) || size < header || offset + size > blob.size) break;
    boxes.push({ type, size, offset });
    offset += size;
  }
  return { boxes, parsedBytes: offset, trailingBytes: Math.max(0, blob.size - offset) };
}

/**
 * 构建分片日记：
 * - initBytes：第一个 moof 之前的 ftyp/moov 初始化段；
 * - fragments：完整 moof+mdat 对（index/偏移/字节数）；
 * - completeBytes：最后一个完整分片的结束偏移（没有分片时取合法容器前缀）；
 * - completeFrames：没有半个 moof/mdat、也没有截断尾 box。
 */
export async function fragmentJournalFromBlob(blob, options = {}) {
  const scan = await scanBoxesFromBlob(blob, options);
  const types = scan.boxes.map((box) => box.type);
  const hasFtyp = types.includes('ftyp');
  const hasMoov = types.includes('moov');
  const hasMoof = types.includes('moof');
  const fragments = [];
  let initBytes = 0;
  let pending = null;
  for (const box of scan.boxes) {
    if (box.type === 'moof') {
      if (!hasMoov) continue;
      if (!initBytes) initBytes = box.offset;
      if (pending) {
        // 上一个 moof 没有 mdat：保留为不完整分片，不进入 fragments
        pending = null;
      }
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
    totalBytes: blob.size,
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

/** 只取完整分片的容器前缀（不复制整段视频：返回 Blob slice）。 */
export function completeFragmentBlob(blob, journal) {
  const length = Number(journal && journal.completeBytes);
  if (!Number.isFinite(length) || length <= 0 || length >= blob.size) return blob;
  return blob.slice(0, length);
}

/**
 * 完帧重封装（worker 侧调用的纯函数）：按 journal.completeBytes 截到最后一个完整分片，
 * 并只保留完全落在截断范围内的分片日志（保证 video.verify 的逐片 SHA-256 仍然成立）。
 * 返回新的 Blob、过滤后的日志、块数与丢弃字节数；不完整/无需截断时原样返回。
 */
export function completeFragmentPackage(blob, journal, fragments = []) {
  const length = Number(journal && journal.completeBytes);
  if (!Number.isFinite(length) || length <= 0 || length >= blob.size) {
    return { blob, fragments: Array.isArray(fragments) ? fragments : [], trimmedBytes: 0, completeBytes: blob.size, chunkCount: Array.isArray(fragments) ? fragments.length : 0 };
  }
  const kept = [];
  let sum = 0;
  for (const entry of Array.isArray(fragments) ? fragments : []) {
    const bytes = Number(entry && entry.bytes) || 0;
    if (sum + bytes > length) break;
    kept.push(entry);
    sum += bytes;
  }
  const trimmed = blob.slice(0, length);
  return { blob: trimmed, fragments: kept, trimmedBytes: blob.size - trimmed.size, completeBytes: length, chunkCount: kept.length };
}

// ---------------------------------------------------------------------------
// 分片日记完帧/连续性证据（video.verify、video-recovery 消费）。
// 和 filmstrip 上的“完帧重封装”互补：这里只判定“字节层面是否连续、尾部是否被截断”，
// 帧时间戳回退/缺帧由 mp4-integrity 在 trun/tfdt 层判定。
// ---------------------------------------------------------------------------

import { FRAGMENT_JOURNAL_CODES } from './video-codes.js';

export { FRAGMENT_JOURNAL_CODES };

function journalProblem(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

/**
 * 对 fragmentJournalFromBlob 的输出做连续性/完帧判定。
 * @param {object} journal 分片日记
 * @param {{requireComplete?:boolean, requireSync?:boolean}} [options]
 * @returns {{ok:boolean, problems:Array, stats:object, fragmented:boolean}}
 */
export function journalIntegrity(journal, options = {}) {
  const requireComplete = options.requireComplete !== false;
  const problems = [];
  if (!journal || typeof journal !== 'object') {
    return {
      ok: false,
      fragmented: false,
      problems: [journalProblem(FRAGMENT_JOURNAL_CODES.JOURNAL_MISSING, 'error', '缺少分片日记')],
      stats: { fragments: 0, bytes: 0, trailingBytes: 0, completeBytes: 0, initBytes: 0, gaps: 0, overlaps: 0 },
    };
  }
  const totalBytes = Number(journal.totalBytes) || 0;
  const fragmented = journal.fragmented === true;
  if (totalBytes <= 0) {
    problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.EMPTY_CONTAINER, 'error', '录制容器为空'));
  }
  if (!journal.hasFtyp) problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.MISSING_FTYP, 'error', '缺少 ftyp box'));
  if (!journal.hasMoov) problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.MISSING_MOOV, 'error', '缺少 moov box'));

  const fragments = Array.isArray(journal.fragments) ? journal.fragments : [];
  let gaps = 0;
  let overlaps = 0;
  let fragmentsBytes = 0;
  if (fragmented) {
    if (!(Number(journal.initBytes) > 0)) {
      problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.INIT_MISSING, 'error', 'fMP4 缺少 init 前缀（ftyp/moov）'));
    }
    if (!fragments.length) {
      problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.NO_COMPLETE_FRAGMENTS, 'error', '没有任何完整的 moof+mdat 分片'));
    }
    if (journal.openFragment === true) {
      problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.OPEN_FRAGMENT, 'error', '存在未闭合的 moof（缺 mdat），尾部帧不完整'));
    }
    for (let i = 0; i < fragments.length; i += 1) {
      const fragment = fragments[i] || {};
      if (!(Number(fragment.bytes) > 0)) {
        problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.EMPTY_FRAGMENT, 'error', '分片字节数为 0', { index: i }));
      }
      if (!(Number(fragment.mdatBytes) > 0)) {
        problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.MISSING_MDAT, 'error', '分片缺少 mdat', { index: i }));
      }
      fragmentsBytes += Number(fragment.bytes) || 0;
      if (i > 0) {
        const previous = fragments[i - 1] || {};
        const expected = (Number(previous.moofOffset) || 0) + (Number(previous.bytes) || 0);
        const actual = Number(fragment.moofOffset) || 0;
        if (actual < expected) {
          overlaps += 1;
          problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.FRAGMENT_OVERLAP, 'error', '分片字节区间重叠（moof 覆盖了上一分片）', { index: i, expected, actual, overlapBytes: expected - actual }));
        } else if (actual > expected) {
          gaps += 1;
          problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.FRAGMENT_GAP, 'warning', '分片之间字节不连续（中间有其它顶层 box 或空洞）', { index: i, expected, actual, gapBytes: actual - expected }));
        }
      }
    }
    const completeBytes = Number(journal.completeBytes) || 0;
    if (completeBytes > 0 && fragmentsBytes > 0 && completeBytes < (Number(journal.initBytes) || 0)) {
      problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.COMPLETE_BYTES, 'error', 'completeBytes 小于 init 前缀', { completeBytes, initBytes: journal.initBytes }));
    }
  } else if (totalBytes > 0 && journal.hasFtyp && journal.hasMoov) {
    const declared = Number(journal.completeBytes) || 0;
    if (declared > 0 && declared > totalBytes) {
      problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.COMPLETE_BYTES, 'error', 'completeBytes 超过容器总字节', { completeBytes: declared, totalBytes }));
    }
  }
  const trailingBytes = Number(journal.trailingBytes) || 0;
  if (trailingBytes > 0) {
    problems.push(journalProblem(
      FRAGMENT_JOURNAL_CODES.TRAILING_BYTES,
      requireComplete ? 'warning' : 'info',
      '尾部有未成帧字节（截断的 box）',
      { trailingBytes },
    ));
  }
  if (requireComplete && journal.completeFrames !== true) {
    problems.push(journalProblem(FRAGMENT_JOURNAL_CODES.INCOMPLETE_FRAMES, 'warning', '分片日记未标记完帧'));
  }
  return {
    ok: problems.every((item) => item.severity !== 'error'),
    fragmented,
    problems,
    stats: {
      fragments: fragments.length,
      bytes: fragmentsBytes,
      trailingBytes,
      completeBytes: Number(journal.completeBytes) || 0,
      initBytes: Number(journal.initBytes) || 0,
      totalBytes,
      gaps,
      overlaps,
    },
  };
}
