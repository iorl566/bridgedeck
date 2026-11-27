/**
 * fMP4 可 seek 增强：为 fragmented MP4 生成并插入 `sidx` 段索引。
 *
 * 不重编码、不重写 moov/stbl：按已有 moof/mdat 片段构造 segment index（每条 1 个 reference），
 * 播放器可据此跳转/估算时长；原始分片字节保持不变。仅支持单视频轨、trun duration 可解析的情况，
 * 解析失败时返回 null（调用方保持原始 fMP4）。
 */

function boxType(view, offset) {
  return String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
}

function scanBoxes(view, start = 0, end = view.byteLength) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = boxType(view, offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < header || offset + size > end) break;
    boxes.push({ type, size, header, offset, data: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

function find(boxes, type, start = 0) {
  for (let i = start; i < boxes.length; i += 1) {
    if (boxes[i].type === type) return boxes[i];
  }
  return null;
}

function readTimescale(view, mvhd) {
  const v = view.getUint8(mvhd.data);
  return v === 1 ? view.getUint32(mvhd.data + 20) : view.getUint32(mvhd.data + 12);
}

function readTrackId(view, tkhd) {
  const v = view.getUint8(tkhd.data);
  return v === 1 ? view.getUint32(tkhd.data + 16) : view.getUint32(tkhd.data + 8);
}

/** 从 init 前缀（ftyp/moov…）解析视频轨 timescale / trackId。 */
export function parseInit(view) {
  const top = scanBoxes(view);
  const moov = find(top, 'moov');
  if (!moov) return null;
  const moovChildren = scanBoxes(view, moov.data, moov.end);
  const mvhd = find(moovChildren, 'mvhd');
  if (!mvhd) return null;
  const movieTimescale = readTimescale(view, mvhd);
  for (const trak of moovChildren) {
    if (trak.type !== 'trak') continue;
    const trakChildren = scanBoxes(view, trak.data, trak.end);
    const tkhd = find(trakChildren, 'tkhd');
    const mdia = find(trakChildren, 'mdia');
    if (!tkhd || !mdia) continue;
    const mdiaChildren = scanBoxes(view, mdia.data, mdia.end);
    const hdlr = find(mdiaChildren, 'hdlr');
    const mdhd = find(mdiaChildren, 'mdhd');
    if (!hdlr || !mdhd) continue;
    const handler = String.fromCharCode(
      view.getUint8(hdlr.data + 8), view.getUint8(hdlr.data + 9),
      view.getUint8(hdlr.data + 10), view.getUint8(hdlr.data + 11),
    );
    if (handler !== 'vide') continue;
    const mdhdVersion = view.getUint8(mdhd.data);
    const timescale = mdhdVersion === 1 ? view.getUint32(mdhd.data + 20) : view.getUint32(mdhd.data + 12);
    return {
      timescale: timescale || movieTimescale,
      trackId: readTrackId(view, tkhd),
      movieTimescale,
      firstMoof: (top.find((box) => box.type === 'moof') || {}).offset ?? null,
      hasSidx: top.some((box) => box.type === 'sidx'),
    };
  }
  return null;
}

function parseMoof(view, moof) {
  const children = scanBoxes(view, moof.data, moof.end);
  let trackId = 0;
  let baseTime = 0;
  let duration = 0;
  let samples = 0;
  let firstSync = null;
  for (const traf of children) {
    if (traf.type !== 'traf') continue;
    const trafChildren = scanBoxes(view, traf.data, traf.end);
    const tfhd = find(trafChildren, 'tfhd');
    const tfdt = find(trafChildren, 'tfdt');
    const trun = find(trafChildren, 'trun');
    if (!tfhd) continue;
    trackId = view.getUint32(tfhd.data + 4);
    if (tfdt) {
      const v = view.getUint8(tfdt.data);
      baseTime = v === 1 ? Number(view.getBigUint64(tfdt.data + 4)) : view.getUint32(tfdt.data + 4);
    }
    if (!trun) continue;
    const flags = view.getUint32(trun.data) & 0x00ffffff;
    const count = view.getUint32(trun.data + 4);
    samples += count;
    let offset = trun.data + 8;
    if (flags & 0x000001) offset += 4; // data_offset
    let firstFlags = null;
    if (flags & 0x000004) { firstFlags = view.getUint32(offset); offset += 4; }
    for (let i = 0; i < count; i += 1) {
      if (flags & 0x000100) { duration += view.getUint32(offset); offset += 4; }
      if (flags & 0x000200) offset += 4; // sample_size
      if (flags & 0x000400) {
        const sf = view.getUint32(offset);
        offset += 4;
        if (i === 0) firstFlags = sf;
      }
      if (flags & 0x000800) offset += 4; // composition offset
    }
    if (firstSync == null && firstFlags != null) firstSync = (firstFlags & 0x00010000) === 0;
  }
  return { trackId, baseTime, duration, samples, sync: firstSync === null ? true : firstSync };
}

/** 扫描 fMP4 顶层，收集每个 moof+mdat 的字节数与解码时长。 */
export function parseFragments(view) {
  const top = scanBoxes(view);
  const fragments = [];
  let pending = null;
  for (const box of top) {
    if (box.type === 'moof') {
      const info = parseMoof(view, box);
      pending = {
        moofOffset: box.offset,
        bytes: box.size,
        duration: info.duration,
        baseTime: info.baseTime,
        samples: info.samples,
        sync: info.sync,
      };
      continue;
    }
    if (box.type === 'mdat' && pending) {
      pending.bytes += box.size;
      fragments.push(pending);
      pending = null;
    }
  }
  return fragments;
}

/** 构造 sidx box（version 0，每个分片 1 条 reference）。 */
export function buildSegmentIndex({ trackId = 1, timescale = 1000, earliest = 0, fragments = [] }) {
  const count = Math.min(fragments.length, 0xffff);
  const size = 32 + count * 12;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  bytes[4] = 0x73; bytes[5] = 0x69; bytes[6] = 0x64; bytes[7] = 0x78; // 'sidx'
  view.setUint32(8, 0); // version 0 + flags
  view.setUint32(12, trackId);
  view.setUint32(16, timescale);
  view.setUint32(20, Math.max(0, Math.min(earliest, 0xffffffff)));
  view.setUint32(24, 0); // first_offset
  view.setUint16(28, 0); // reserved
  view.setUint16(30, count);
  let offset = 32;
  for (let i = 0; i < count; i += 1) {
    const fragment = fragments[i];
    const referenceSize = Math.min(Number(fragment.bytes) || 0, 0x7fffffff);
    view.setUint32(offset, referenceSize); // reference_type=0 (media)
    view.setUint32(offset + 4, Math.max(0, Math.min(Number(fragment.duration) || 0, 0xffffffff)));
    const sap = (1 << 31) | (1 << 28); // starts_with_SAP=1, SAP_type=1, delta=0
    view.setUint32(offset + 8, sap);
    offset += 12;
  }
  return { bytes, count };
}

/** 从 Blob 读取 init 前缀并构造 sidx；失败返回 null。 */
export async function segmentIndexForBlob(blob, options = {}) {
  const maxPrefix = Number(options.maxPrefix) > 0 ? Number(options.maxPrefix) : 1024 * 1024;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 64 * 1024 * 1024;
  if (blob.size > maxBytes) return null;
  const prefixBytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, maxPrefix)).arrayBuffer());
  const prefix = parseInit(new DataView(prefixBytes.buffer));
  if (!prefix || prefix.hasSidx || prefix.firstMoof == null) return null;
  const view = new DataView(await blob.arrayBuffer());
  const fragments = parseFragments(view);
  if (!fragments.length) return null;
  const earliest = fragments[0].baseTime || 0;
  const { bytes } = buildSegmentIndex({
    trackId: prefix.trackId || 1,
    timescale: prefix.timescale || 1000,
    earliest,
    fragments,
  });
  return { sidx: bytes, insertAt: prefix.firstMoof, fragments: fragments.length, timescale: prefix.timescale };
}

/** 把 sidx 插入到首个 moof 之前，返回新的 Blob（不复制整段：Blob slice + parts）。 */
export function insertSegmentIndex(blob, sidx, insertAt) {
  const at = Number(insertAt);
  if (!sidx || !Number.isFinite(at) || at <= 0 || at >= blob.size) return blob;
  return new Blob([blob.slice(0, at), sidx, blob.slice(at)], { type: blob.type || 'video/mp4' });
}

// ---------------------------------------------------------------------------
// sidx 校验（video.verify / mp4-integrity 的“可 seek”证据来源）。
// 只做结构校验：box 大小、version、reference 数量与 payload 是否自洽。
// ---------------------------------------------------------------------------

import { SIDX_PROBLEM_CODES } from './video-codes.js';

export { SIDX_PROBLEM_CODES };

function sidxProblem(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function asDataView(input) {
  if (input instanceof DataView) return input;
  if (input instanceof Uint8Array) return new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new DataView(input);
  return null;
}

/** 沿顶层 box 链找 sidx 的 size/type 头（即使 box 本体被截断也能识别“有但坏了”）。 */
function hasSidxSignature(view) {
  let offset = 0;
  while (offset + 8 <= view.byteLength) {
    let size = view.getUint32(offset);
    const type = boxType(view, offset);
    if (type === 'sidx') return true;
    if (size === 1) {
      if (offset + 16 > view.byteLength) return false;
      size = Number(view.getBigUint64(offset + 8));
    }
    if (!Number.isSafeInteger(size) || size < 8 || offset + size > view.byteLength) return false;
    offset += size;
  }
  return false;
}

/** 导出顶层 box 扫描（供 mp4-integrity 复用，避免重复实现 box 遍历）。 */
export function scanTopBoxes(input) {
  const view = asDataView(input);
  if (!view) return [];
  return scanBoxes(view);
}

/**
 * 解析顶层 sidx box；不存在/截断返回 null。
 * v0：reference 从 32 字节开始；v1：earliest/first_offset 为 64 位，reference 从 40 字节开始。
 */
export function parseSegmentIndex(input) {
  const view = asDataView(input);
  if (!view) return null;
  const sidx = scanBoxes(view).find((box) => box.type === 'sidx');
  if (!sidx) return null;
  const version = view.getUint8(sidx.data);
  // payload 头：version/flags(4) + refID(4) + timescale(4) + earliest + first_offset + reserved(2) + count(2)
  // v0 earliest/first_offset 各 32 位 → 24 字节；v1 各 64 位 → 32 字节。box 总大小还要加 8 字节 size/type。
  const header = version === 1 ? 32 : 24;
  if (sidx.size < 8 + header || sidx.data + header > view.byteLength) return null;
  const trackId = view.getUint32(sidx.data + 4);
  const timescale = view.getUint32(sidx.data + 8);
  const earliest = version === 1 ? Number(view.getBigUint64(sidx.data + 12)) : view.getUint32(sidx.data + 12);
  const firstOffsetOffset = sidx.data + (version === 1 ? 20 : 16);
  const firstOffset = version === 1 ? Number(view.getBigUint64(firstOffsetOffset)) : view.getUint32(firstOffsetOffset);
  const countOffset = sidx.data + header - 2;
  if (countOffset + 2 > view.byteLength) return null;
  const count = view.getUint16(countOffset);
  const references = [];
  let offset = sidx.data + header;
  for (let i = 0; i < count; i += 1) {
    if (offset + 12 > view.byteLength) return null;
    const first = view.getUint32(offset);
    const duration = view.getUint32(offset + 4);
    const sap = view.getUint32(offset + 8);
    references.push({
      type: first >>> 31,
      size: first & 0x7fffffff,
      duration,
      startsWithSap: (sap >>> 31) === 1,
      sapType: (sap >>> 28) & 0x7,
      sapDelta: sap & 0x0fffffff,
    });
    offset += 12;
  }
  return {
    version,
    trackId,
    timescale,
    earliest,
    firstOffset,
    count,
    references,
    headerBytes: header,
    referenceBytes: offset - (sidx.data + header),
    size: sidx.size,
    offset: sidx.offset,
    complete: sidx.data + header + count * 12 <= sidx.end,
  };
}

/**
 * 校验 sidx 结构与自洽：box 大小 = 头 + 12*count、reference 数、非空、媒体引用字节和。
 * @returns {{ok:boolean, problems:Array, info:object|null, mediaBytes:number}}
 */
export function validateSegmentIndex(input, options = {}) {
  const view = asDataView(input);
  if (!view) {
    return { ok: false, problems: [sidxProblem(SIDX_PROBLEM_CODES.SIDX_MISSING, 'error', '没有可解析的字节')], info: null, mediaBytes: 0 };
  }
  const info = parseSegmentIndex(view);
  if (!info) {
    const hasSidxBox = hasSidxSignature(view);
    return {
      ok: false,
      problems: [sidxProblem(
        hasSidxBox ? SIDX_PROBLEM_CODES.SIDX_TRUNCATED : SIDX_PROBLEM_CODES.SIDX_MISSING,
        'error',
        hasSidxBox ? 'sidx box 被截断/字段不足' : '容器里没有 sidx box',
      )],
      info: null,
      mediaBytes: 0,
    };
  }
  const problems = [];
  if (!info.complete || info.size !== 8 + info.headerBytes + info.referenceBytes) {
    problems.push(sidxProblem(SIDX_PROBLEM_CODES.SIDX_SIZE_MISMATCH, 'error', 'sidx 声明的 box 大小与 reference 数不一致', {
      size: info.size,
      expected: 8 + info.headerBytes + info.referenceBytes,
    }));
  }
  if (info.count === 0) {
    problems.push(sidxProblem(SIDX_PROBLEM_CODES.SIDX_EMPTY, 'error', 'sidx 没有 reference（不可 seek）'));
  }
  if (!(info.timescale > 0)) {
    problems.push(sidxProblem(SIDX_PROBLEM_CODES.SIDX_COUNT_MISMATCH, 'warning', 'sidx timescale 为 0', { timescale: info.timescale }));
  }
  let mediaBytes = 0;
  let totalDuration = 0;
  for (const reference of info.references) {
    if (reference.type !== 0) continue; // 只统计媒体引用；层级引用不计入可播放字节
    mediaBytes += reference.size;
    totalDuration += reference.duration;
  }
  const minReferences = Number(options.minReferences) || 0;
  if (minReferences > 0 && info.count < minReferences) {
    problems.push(sidxProblem(SIDX_PROBLEM_CODES.SIDX_COUNT_MISMATCH, 'warning', 'sidx reference 数量少于预期', { count: info.count, minReferences }));
  }
  return { ok: problems.every((item) => item.severity !== 'error'), problems, info, mediaBytes, totalDuration };
}
