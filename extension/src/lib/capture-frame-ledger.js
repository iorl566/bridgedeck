// lib/capture-frame-ledger.js —— 采集帧台账与帧级对账内核（纯函数；第十一批-E）。
//
// 背景：长截图（tiled-capture/captureFullPage）与视频（video.js/offscreen）两条采集路径
// 都只记“最终产物”，中间帧（段/瓦片/视频分片）一旦丢、重、错位、被后继帧覆盖，调用方
// 只能看到“尺寸/字节数不对”，拿不到“哪一帧、为什么、要不要重绘”的证据。
//
// 本模块把“帧”收敛成统一台账对象，并把帧级对账做成可单测的纯函数：
//   * frameSignature()/frameDigest()  —— 帧身份的确定性签名（几何 + 角色 + 哈希链）；
//   * normalizeFrame()/buildFrameIndex() —— 非法帧剔除、重复帧折叠、乱序检测；
//   * reconcileFrames()               —— 期望帧（计划）↔ 实采帧的逐帧对账：
//                                        missing / extra / duplicate / misaligned /
//                                        reordered / hash-mismatch / 覆盖缺口；
//   * frameCoverage()                 —— 帧区间合并后的覆盖比例与缺口（长截图拼接/视频时间轴共用）；
//   * createFrameLedger()/appendFrame()/diffFrameLedger() —— 运行时增量台账（不可变更新）；
//   * frameReportWire()/describeFrameReport() —— 协议字段与一行日志。
//
// 设计约束：
//   1) 纯计算，不依赖 DOM/Canvas/IDB/chrome.*，Service Worker 与 Node 单测共用；
//   2) 所有导出函数对 null/NaN/字符串输入都给“可解释的降级结果”，不抛异常（除非显式要求）；
//   3) 对账只回答“发生了什么”，重绘策略在 lib/longshot-repaint.js / lib/video-*.js；
//   4) 帧字段只增不改：既有采集路径不引用本模块时行为完全不变（接线方按需读取新字段）。

export const CAPTURE_FRAME_VERSION = 1;

/** 帧类型：长截图段 / 长截图瓦片 / 视频分片 / 视口帧。 */
export const FRAME_KINDS = Object.freeze(['longshot-segment', 'longshot-tile', 'video-fragment', 'viewport']);

/** 帧生命周期状态（台账读出来的判定，不写回采集侧）。 */
export const FRAME_STATES = Object.freeze([
  'planned',
  'captured',
  'verified',
  'suspect',
  'missing',
  'duplicate',
  'superseded',
]);

/** 对账问题码（协议/日志共用；只加不改）。 */
export const FRAME_CODES = Object.freeze({
  INVALID: 'frame.invalid',
  MISSING: 'frame.missing',
  EXTRA: 'frame.extra',
  DUPLICATE: 'frame.duplicate',
  MISALIGNED: 'frame.misaligned',
  REORDERED: 'frame.reordered',
  HASH_MISMATCH: 'frame.hash-mismatch',
  STALE: 'frame.stale',
  OVERSIZE: 'frame.oversize',
  UNDERFLOW: 'frame.underflow',
  COVERAGE: 'frame.coverage',
  EMPTY: 'frame.empty',
  OK: 'frame.ok',
});

const KIND_SET = new Set(FRAME_KINDS);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function clampInt(value, min, max, fallback) {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function intTuple(...values) {
  return values.map((value) => intOr(value, 0));
}

/** FNV-1a 32 位（与 longshot-manifest 的 32 位口径同族；只用于身份签名，不做密码学校验）。 */
export function fnv1a32(text) {
  const input = String(text == null ? '' : text);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** djb2 32 位（与 FNV 组合成 16 hex 摘要，降低单哈希碰撞带来的“假相同”）。 */
export function djb2_32(text) {
  const input = String(text == null ? '' : text);
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return hash >>> 0;
}

function toHex8(value) {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** 文本 → 16 hex 帧摘要。 */
export function digestText(text) {
  const input = String(text == null ? '' : text);
  return toHex8(fnv1a32(input)) + toHex8(djb2_32(input));
}

/** 字节视图：支持 Uint8Array/ArrayBuffer/普通数组/字符串；非法输入返回空视图。 */
export function toByteView(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) {
    const view = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) {
      const value = Number(bytes[index]);
      view[index] = Number.isFinite(value) ? value & 0xff : 0;
    }
    return view;
  }
  if (typeof bytes === 'string') {
    const view = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) view[index] = bytes.charCodeAt(index) & 0xff;
    return view;
  }
  return new Uint8Array(0);
}

/** 字节 → 16 hex 摘要（帧内容哈希；与 longshot-manifest.hashLongshotBytes 口径一致：FNV+djb2）。 */
export function hashFrameBytes(bytes) {
  const view = toByteView(bytes);
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let index = 0; index < view.length; index += 1) {
    const byte = view[index];
    fnv ^= byte;
    fnv = Math.imul(fnv, 0x01000193) >>> 0;
    djb = ((djb << 5) + djb + byte) >>> 0;
  }
  return toHex8(fnv) + toHex8(djb);
}

/** 归一化帧类型：未知类型回落 'viewport'（并保留原值在 raw_kind）。 */
export function normalizeFrameKind(value) {
  const text = String(value == null ? '' : value).trim();
  return KIND_SET.has(text) ? text : 'viewport';
}

/**
 * 帧身份：kind + index + 页面/绘制坐标 + 尺寸 + DPR + 角色。
 * 只包含“同一帧跨次采集应保持一致”的字段，不含 at/hash 这类易变字段。
 */
export function frameIdentity(frame) {
  const source = isPlainObject(frame) ? frame : {};
  // 高度口径：drawHeight（绘制高）优先，其次 height，最后 pageHeight 兜底；
  // pageHeight（页面覆盖高）优先，其次 drawHeight，最后 height 兜底。两条路径互相兜底，
  // 这样 tiled-capture 的段（有 pageHeight/drawHeight）和恢复侧 tile（只有 height）都能对账。
  const height = intOr(source.drawHeight != null ? source.drawHeight : (source.height != null ? source.height : source.pageHeight), 0);
  const pageHeight = intOr(source.pageHeight != null ? source.pageHeight : (source.drawHeight != null ? source.drawHeight : source.height), 0);
  const [pageY, drawY, width, dpr, index] = intTuple(
    source.pageY != null ? source.pageY : source.offsetY,
    source.drawY != null ? source.drawY : (source.offset != null ? source.offset : source.y),
    source.width,
    source.dpr,
    source.index,
  );
  return {
    kind: normalizeFrameKind(source.kind),
    index,
    pageY,
    drawY,
    pageHeight,
    drawHeight: height,
    width,
    height,
    dpr,
    role: typeof source.role === 'string' ? source.role : 'frame',
  };
}

/** 帧签名：身份字段的确定性字符串（用于去重 / 跨次对比）。 */
export function frameSignature(frame) {
  const identity = frameIdentity(frame);
  return [
    identity.kind,
    identity.index,
    identity.role,
    identity.pageY,
    identity.drawY,
    identity.pageHeight,
    identity.drawHeight,
    identity.width,
    identity.height,
    identity.dpr,
  ].join('|');
}

/** 帧签名摘要（16 hex），用于报告瘦身。 */
export function frameSignatureDigest(frame) {
  return digestText(frameSignature(frame));
}

/** 多帧整体摘要：按台账顺序链式哈希，任一轮序变化都会改变结果。 */
export function frameDigest(frames, options = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const seed = typeof options.seed === 'string' ? options.seed : 'capture-frames/1';
  let chain = digestText(seed);
  for (const frame of list) {
    const normalized = normalizeFrame(frame, { now: 0 }).frame;
    const part = normalized ? (normalized.hash || frameSignatureDigest(normalized)) : 'invalid';
    chain = digestText(chain + ':' + part);
  }
  return chain;
}

/**
 * 归一化单帧：合法则返回 {ok:true, frame}，非法返回 {ok:false, reason}。
 * 不修改入参；哈希优先用调用方给的，其次由字节算，最后用签名摘要兜底。
 */
export function normalizeFrame(frame, options = {}) {
  if (!isPlainObject(frame)) return { ok: false, reason: 'not-object', frame: null };
  const index = intOr(frame.index, -1);
  if (index < 0) return { ok: false, reason: 'bad-index', frame: null };
  const width = intOr(frame.width, 0);
  const textHeight = intOr(frame.textHeight, 0);
  const height = intOr(frame.drawHeight != null
    ? frame.drawHeight
    : (frame.height != null ? frame.height : frame.pageHeight), 0);
  if (!(width > 0)) return { ok: false, reason: 'bad-width', frame: null };
  if (!(height > 0) && !(textHeight > 0) && !(frame.bytes > 0) && !frame.blob) {
    return { ok: false, reason: 'bad-height', frame: null };
  }
  const bytes = Math.max(0, intOr(frame.bytes, isPlainObject(frame.blob) ? frame.blob.size : 0));
  const rawHash = typeof frame.hash === 'string' ? frame.hash.trim().toLowerCase() : '';
  const hash = rawHash.length >= 8
    ? rawHash.slice(0, 32)
    : (frame.data != null ? hashFrameBytes(frame.data) : frameSignatureDigest(frame));
  const at = Math.max(0, intOr(frame.at, 0));
  const identity = frameIdentity({ ...frame, height, width });
  return {
    ok: true,
    reason: null,
    frame: {
      ...identity,
      textHeight: Math.max(0, textHeight),
      bytes,
      hash,
      at,
      state: FRAME_STATES.includes(frame.state) ? frame.state : 'captured',
      flags: Array.isArray(frame.flags) ? frame.flags.map((flag) => String(flag)).slice(0, 8) : [],
      meta: isPlainObject(frame.meta) ? { ...frame.meta } : {},
    },
  };
}

/**
 * 帧索引：剔除非法、按 (kind,index) 归并重复、检测是否乱序。
 * 重复帧保留 at 更大的一版（与 longshot-recovery.normalizeRecoveryTiles 同口径）。
 */
export function buildFrameIndex(frames) {
  const list = Array.isArray(frames) ? frames : [];
  const invalid = [];
  const duplicates = [];
  const byKey = new Map();
  let reordered = false;
  let lastKey = -Infinity;
  for (let position = 0; position < list.length; position += 1) {
    const normalized = normalizeFrame(list[position], { now: 0 });
    if (!normalized.ok) {
      invalid.push({ position, reason: normalized.reason });
      continue;
    }
    const frame = normalized.frame;
    // 只在同一 kind 内比较序号，避免视频分片与长截图段混排时误报乱序。
    const order = frame.index;
    if (order < lastKey) reordered = true;
    lastKey = Math.max(lastKey, order);
    const key = frame.kind + '#' + frame.index;
    const previous = byKey.get(key);
    if (previous) {
      duplicates.push({ kind: frame.kind, index: frame.index, previousHash: previous.hash, nextHash: frame.hash });
      if (frame.at >= previous.at) byKey.set(key, frame);
    } else {
      byKey.set(key, frame);
    }
  }
  const ordered = [...byKey.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    return left.index - right.index;
  });
  return {
    list: ordered,
    byKey,
    invalid,
    duplicates,
    reordered,
    signature: frameDigest(ordered),
  };
}

/**
 * 帧几何对比：返回差异字段（容差按“设备像素”对齐，缺省 0 表示严格相等）。
 * dpr 差异用 1e-6 容差，避免 1.5 与 1.5000001 被判成错位。
 */
export function compareFrameGeometry(expected, actual, options = {}) {
  const tolerance = Math.max(0, intOr(options.tolerance, 0));
  const dprTolerance = Number.isFinite(Number(options.dprTolerance)) ? Math.abs(Number(options.dprTolerance)) : 1e-6;
  const left = frameIdentity(expected);
  const right = frameIdentity(actual);
  const diffs = [];
  const compare = (field, delta, limit) => {
    if (Math.abs(delta) > limit) diffs.push({ field, expected: left[field], actual: right[field], delta });
  };
  compare('pageY', right.pageY - left.pageY, tolerance);
  compare('drawY', right.drawY - left.drawY, tolerance);
  if (left.pageHeight > 0 && right.pageHeight > 0) compare('pageHeight', right.pageHeight - left.pageHeight, tolerance);
  if (left.drawHeight > 0 && right.drawHeight > 0) compare('drawHeight', right.drawHeight - left.drawHeight, tolerance);
  compare('width', right.width - left.width, tolerance);
  compare('dpr', right.dpr - left.dpr, dprTolerance);
  return { equal: diffs.length === 0, diffs, expected: left, actual: right };
}

/** 合并帧覆盖区间（按 pageY/pageHeight；长图）或时间区间（按 startMs/durationMs；视频）。 */
export function mergeFrameIntervals(frames, options = {}) {
  const mode = options.mode === 'time' ? 'time' : 'page';
  const tolerance = Math.max(0, intOr(options.tolerance, 0));
  const list = Array.isArray(frames) ? frames : [];
  const intervals = [];
  for (const frame of list) {
    if (!isPlainObject(frame)) continue;
    const start = mode === 'time'
      ? finiteNonNegative(frame.startMs != null ? frame.startMs : frame.tMs)
      : finiteNonNegative(frame.pageY != null ? frame.pageY : frame.drawY);
    const length = mode === 'time'
      ? finiteNonNegative(frame.durationMs != null ? frame.durationMs : frame.duration)
      : finiteNonNegative(frame.pageHeight != null ? frame.pageHeight : frame.drawHeight);
    if (length <= 0) continue;
    intervals.push({ start: Math.round(start), end: Math.round(start + length), index: intOr(frame.index, intervals.length) });
  }
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + tolerance) {
      last.end = Math.max(last.end, interval.end);
      last.frames += 1;
    } else {
      merged.push({ start: interval.start, end: interval.end, frames: 1 });
    }
  }
  const total = merged.reduce((sum, interval) => sum + Math.max(0, interval.end - interval.start), 0);
  return { mode, intervals, merged, intervalsCount: intervals.length, mergedCount: merged.length, total };
}

/**
 * 帧覆盖：给定总长，返回覆盖比例、缺口列表、是否无缝。
 * 长截图传 {totalHeight}；视频时间轴传 {totalMs: true} 并在 frames 上给 startMs/durationMs。
 */
export function frameCoverage(frames, options = {}) {
  const mode = options.mode === 'time' || options.totalMs === true ? 'time' : 'page';
  const total = Math.max(0, intOr(mode === 'time' ? options.totalMs : options.totalHeight, 0));
  const merged = mergeFrameIntervals(frames, { mode, tolerance: options.tolerance });
  const gaps = [];
  let coveredWithin = 0;
  if (total > 0) {
    let cursor = 0;
    for (const interval of merged.merged) {
      const start = Math.max(0, Math.min(total, interval.start));
      const end = Math.max(0, Math.min(total, interval.end));
      if (start > cursor) {
        gaps.push({ start: cursor, end: start, length: start - cursor });
      }
      cursor = Math.max(cursor, end);
      coveredWithin += Math.max(0, end - start);
    }
    if (cursor < total) gaps.push({ start: cursor, end: total, length: total - cursor });
  }
  // 有总长时“覆盖”= 落在 [0,total) 内的合并长度（不能把越界部分算成覆盖）；
  // 没有总长时退回调用的合并长度（用于“有多少帧、总覆盖多大”的估计）。
  const covered = total > 0 ? Math.min(total, coveredWithin) : merged.total;
  const ratio = total > 0 ? covered / total : (merged.merged.length ? 1 : 0);
  return {
    mode,
    total,
    covered,
    ratio: Math.max(0, Math.min(1, Number(ratio.toFixed(6)))),
    gaps,
    gapCount: gaps.length,
    gapLength: gaps.reduce((sum, gap) => sum + gap.length, 0),
    intervals: merged.mergedCount,
    seamless: total > 0 ? gaps.length === 0 : merged.merged.length > 0,
  };
}

function stateCounts(frames) {
  const counts = { planned: 0, captured: 0, verified: 0, suspect: 0, missing: 0, duplicate: 0, superseded: 0 };
  for (const frame of frames) {
    if (frame && Object.prototype.hasOwnProperty.call(counts, frame.state)) counts[frame.state] += 1;
  }
  return counts;
}

/**
 * 帧级对账：期望帧（计划）↔ 实采帧。
 *
 * @param {{
 *   expected?: object[], captured?: object[],
 *   tolerance?: number, dprTolerance?: number,
 *   totalHeight?: number, totalMs?: number, mode?: 'page'|'time',
 *   requireHash?: boolean, now?: number,
 * }} [params]
 * @returns {object} 对账报告（ok/action/counts/missing/extra/duplicates/mismatched/coverage/evidence）
 */
export function reconcileFrames(params = {}) {
  const now = Number.isFinite(Number(params.now)) ? Number(params.now) : 0;
  const mode = params.mode === 'time' ? 'time' : 'page';
  const expectedIndex = buildFrameIndex(params.expected);
  const capturedIndex = buildFrameIndex(params.captured);
  const tolerance = Math.max(0, intOr(params.tolerance, 0));
  const requireHash = params.requireHash === true;
  const expectedList = expectedIndex.list;
  const capturedList = capturedIndex.list;

  const matched = [];
  const missing = [];
  const extra = [];
  const mismatched = [];
  const hashMismatched = [];
  const capturedByKey = capturedIndex.byKey;
  const expectedKeys = new Set();
  for (const expected of expectedList) {
    const key = expected.kind + '#' + expected.index;
    expectedKeys.add(key);
    const actual = capturedByKey.get(key);
    if (!actual) {
      missing.push({ kind: expected.kind, index: expected.index, pageY: expected.pageY, drawY: expected.drawY, pageHeight: expected.pageHeight });
      continue;
    }
    const geometry = compareFrameGeometry(expected, actual, { tolerance, dprTolerance: params.dprTolerance });
    if (!geometry.equal) {
      mismatched.push({
        kind: expected.kind,
        index: expected.index,
        fields: geometry.diffs.map((diff) => diff.field),
        diffs: geometry.diffs,
        expected: geometry.expected,
        actual: geometry.actual,
      });
    }
    if (requireHash && expected.hash && actual.hash && expected.hash !== actual.hash) {
      hashMismatched.push({ kind: expected.kind, index: expected.index, expected: expected.hash, actual: actual.hash });
    }
    matched.push({ kind: expected.kind, index: expected.index, hash: actual.hash, pageY: actual.pageY, verified: geometry.equal && (!requireHash || expected.hash === actual.hash) });
  }
  for (const actual of capturedList) {
    if (!expectedKeys.has(actual.kind + '#' + actual.index)) {
      extra.push({ kind: actual.kind, index: actual.index, pageY: actual.pageY, drawY: actual.drawY, bytes: actual.bytes });
    }
  }

  const coverage = frameCoverage(capturedList, mode === 'time'
    ? { mode: 'time', totalMs: params.totalMs }
    : { totalHeight: params.totalHeight });

  const counts = {
    expected: expectedList.length,
    captured: capturedList.length,
    matched: matched.length,
    missing: missing.length,
    extra: extra.length,
    duplicated: capturedIndex.duplicates.length,
    invalidExpected: expectedIndex.invalid.length,
    invalidCaptured: capturedIndex.invalid.length,
    mismatched: mismatched.length,
    hashMismatched: hashMismatched.length,
    reordered: capturedIndex.reordered === true,
    // 帧生命周期状态计数放在子对象里，避免和 missing/duplicate 这类对账计数撞名。
    states: stateCounts(capturedList),
  };
  const issues = [];
  if (!expectedList.length && !capturedList.length) issues.push(FRAME_CODES.EMPTY);
  if (missing.length) issues.push(FRAME_CODES.MISSING);
  if (extra.length) issues.push(FRAME_CODES.EXTRA);
  if (counts.duplicated) issues.push(FRAME_CODES.DUPLICATE);
  if (mismatched.length) issues.push(FRAME_CODES.MISALIGNED);
  if (hashMismatched.length) issues.push(FRAME_CODES.HASH_MISMATCH);
  if (counts.reordered) issues.push(FRAME_CODES.REORDERED);
  if (coverage.gapCount > 0) issues.push(FRAME_CODES.COVERAGE);
  if (counts.invalidExpected || counts.invalidCaptured) issues.push(FRAME_CODES.INVALID);
  if (!issues.length) issues.push(FRAME_CODES.OK);

  const ok = missing.length === 0 && mismatched.length === 0 && hashMismatched.length === 0 && !counts.reordered && coverage.gapCount === 0;
  const action = !expectedList.length && !capturedList.length
    ? 'nothing'
    : (ok ? 'accept' : (matched.length > 0 ? 'repair-partial' : 'repaint-all'));

  return {
    version: CAPTURE_FRAME_VERSION,
    mode,
    ok,
    action,
    tolerance,
    requireHash,
    counts,
    matched,
    missing,
    extra,
    duplicates: capturedIndex.duplicates,
    mismatched,
    hashMismatched,
    reordered: capturedIndex.reordered === true,
    invalidExpected: expectedIndex.invalid,
    invalidCaptured: capturedIndex.invalid,
    coverage,
    expectedSignature: expectedIndex.signature,
    capturedSignature: capturedIndex.signature,
    issues,
    evidence: {
      now,
      expected: expectedList.length,
      captured: capturedList.length,
      tolerance,
      requireHash,
      issues: issues.slice(),
      coverage: coverage.ratio,
      gaps: coverage.gapCount,
    },
  };
}

/** 对账报告 → 协议字段（列表截断，避免响应膨胀；计数永远完整）。 */
export function frameReportWire(report, options = {}) {
  if (!report || typeof report !== 'object') {
    return { version: CAPTURE_FRAME_VERSION, ok: false, action: 'nothing', counts: {}, issues: [FRAME_CODES.EMPTY] };
  }
  const limit = clampInt(options.maxListed, 0, 64, 8);
  return {
    version: CAPTURE_FRAME_VERSION,
    ok: report.ok === true,
    action: String(report.action || 'nothing'),
    counts: { ...(report.counts || {}) },
    issues: Array.isArray(report.issues) ? report.issues.slice(0, 16) : [],
    missing: Array.isArray(report.missing) ? report.missing.slice(0, limit) : [],
    extra: Array.isArray(report.extra) ? report.extra.slice(0, limit) : [],
    mismatched: Array.isArray(report.mismatched)
      ? report.mismatched.slice(0, limit).map((item) => ({ kind: item.kind, index: item.index, fields: item.fields }))
      : [],
    duplicates: Array.isArray(report.duplicates) ? report.duplicates.slice(0, limit) : [],
    coverage: report.coverage
      ? {
        ratio: report.coverage.ratio,
        covered: report.coverage.covered,
        total: report.coverage.total,
        gaps: report.coverage.gapCount,
        gapLength: report.coverage.gapLength,
        seamless: report.coverage.seamless,
      }
      : null,
    digest: report.capturedSignature || null,
    text: describeFrameReport(report),
  };
}

/** 一行日志：'帧对账 ok：32/32 匹配 覆盖 100%（无缝）'。 */
export function describeFrameReport(report) {
  if (!report || typeof report !== 'object') return '帧对账 无报告';
  const counts = report.counts || {};
  const coverage = report.coverage ? Math.round(report.coverage.ratio * 1000) / 10 : 0;
  const head = '帧对账 ' + (report.ok ? 'ok' : '异常');
  return head + '：' + (counts.matched || 0) + '/' + (counts.expected || 0) + ' 匹配' +
    ' 丢 ' + (counts.missing || 0) + ' 多 ' + (counts.extra || 0) +
    ' 重 ' + (counts.duplicated || 0) + ' 错位 ' + (counts.mismatched || 0) +
    ' 覆盖 ' + coverage + '%' +
    (report.coverage && report.coverage.gapCount ? '（缺口 ' + report.coverage.gapCount + '）' : '（无缝）');
}

/** 帧状态归类：用于把“实采帧 + 期望帧 + 对账结论”合并成台账视图。 */
export function classifyFrameState(frame, report) {
  if (!isPlainObject(frame)) return 'missing';
  if (!report || typeof report !== 'object') return frame.state || 'captured';
  const index = intOr(frame.index, -1);
  const kind = normalizeFrameKind(frame.kind);
  const inList = (list) => Array.isArray(list) && list.some((item) => item && intOr(item.index, -2) === index && normalizeFrameKind(item.kind) === kind);
  if (inList(report.missing)) return 'missing';
  if (inList(report.extra)) return 'superseded';
  if (inList(report.mismatched)) return 'suspect';
  if (inList(report.hashMismatched)) return 'suspect';
  if (Array.isArray(report.duplicates) && report.duplicates.some((item) => item && intOr(item.index, -2) === index)) return 'duplicate';
  if (Array.isArray(report.matched) && report.matched.some((item) => item && intOr(item.index, -2) === index && normalizeFrameKind(item.kind) === kind)) {
    return 'verified';
  }
  return 'captured';
}

/**
 * 建立运行时帧台账（纯数据）。frames 只保存归一化帧 + 追加顺序，便于 SW 重启后回放。
 */
export function createFrameLedger(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const captureId = String(options.captureId || '');
  return {
    version: CAPTURE_FRAME_VERSION,
    captureId,
    kind: normalizeFrameKind(options.kind || 'longshot-segment'),
    createdAt: now,
    updatedAt: now,
    frames: [],
    nextIndex: Math.max(0, intOr(options.nextIndex, 0)),
    totals: { bytes: 0, frames: 0, duplicates: 0, rejected: 0 },
    lastSignature: '',
  };
}

/**
 * 追加一帧：返回新台账（不改入参）。同一 (kind,index) 重复写入记为 duplicate 并保留 at 更大的一版。
 * @returns {{ledger: object, accepted: boolean, duplicate: boolean, frame: object|null, reason: string|null}}
 */
export function appendFrame(ledger, frame, options = {}) {
  const base = isPlainObject(ledger) && Array.isArray(ledger.frames) ? ledger : createFrameLedger(options);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const normalized = normalizeFrame(frame, { now });
  if (!normalized.ok) {
    return {
      ledger: {
        ...base,
        updatedAt: now,
        totals: { ...base.totals, rejected: (base.totals.rejected || 0) + 1 },
      },
      accepted: false,
      duplicate: false,
      frame: null,
      reason: normalized.reason,
    };
  }
  const target = normalized.frame;
  const frames = [];
  let accepted = true;
  let duplicate = false;
  let replaced = 0;
  for (const existing of base.frames) {
    if (existing && existing.kind === target.kind && existing.index === target.index) {
      duplicate = true;
      accepted = false;
      replaced += 1;
      if (target.at >= existing.at) {
        frames.push(target);
        continue;
      }
    }
    frames.push(existing);
  }
  if (!duplicate) frames.push(target);
  const totals = {
    bytes: frames.reduce((sum, item) => sum + Math.max(0, intOr(item && item.bytes, 0)), 0),
    frames: frames.length,
    duplicates: (base.totals.duplicates || 0) + (duplicate ? (accepted ? 0 : 1) : 0),
    rejected: base.totals.rejected || 0,
  };
  totals.duplicates = Math.max(totals.duplicates, 0) + 0;
  const next = {
    ...base,
    updatedAt: now,
    frames,
    nextIndex: Math.max(base.nextIndex || 0, target.index + 1),
    totals,
    lastSignature: frameSignature(target),
  };
  if (duplicate && replaced) totals.replaced = (base.totals.replaced || 0) + replaced;
  return { ledger: next, accepted, duplicate, frame: target, reason: duplicate ? 'duplicate-index' : null };
}

/** 台账摘要（协议/日志用）。 */
export function frameLedgerSummary(ledger) {
  if (!isPlainObject(ledger)) {
    return { version: CAPTURE_FRAME_VERSION, frames: 0, bytes: 0, duplicates: 0, rejected: 0, coverage: null, signature: '' };
  }
  const frames = Array.isArray(ledger.frames) ? ledger.frames : [];
  const coverage = frameCoverage(frames, { totalHeight: ledger.totalHeight, mode: ledger.mode === 'time' ? 'time' : 'page' });
  return {
    version: CAPTURE_FRAME_VERSION,
    captureId: ledger.captureId || '',
    kind: ledger.kind || 'longshot-segment',
    frames: frames.length,
    bytes: Number(ledger.totals && ledger.totals.bytes) || 0,
    duplicates: Number(ledger.totals && ledger.totals.duplicates) || 0,
    rejected: Number(ledger.totals && ledger.totals.rejected) || 0,
    states: stateCounts(frames),
    coverage: {
      ratio: coverage.ratio,
      gaps: coverage.gapCount,
      gapLength: coverage.gapLength,
      seamless: coverage.seamless,
    },
    signature: frameDigest(frames),
  };
}

/** 台账摘要 → 协议字段（保持稳定键集）。 */
export function frameLedgerWire(ledger) {
  const summary = frameLedgerSummary(ledger);
  return {
    version: summary.version,
    capture_id: summary.captureId || '',
    kind: summary.kind || 'longshot-segment',
    frames: summary.frames,
    bytes: summary.bytes,
    duplicates: summary.duplicates,
    rejected: summary.rejected,
    states: summary.states || { planned: 0, captured: 0, verified: 0, suspect: 0, missing: 0, duplicate: 0, superseded: 0 },
    coverage: summary.coverage || { ratio: 0, gaps: 0, gapLength: 0, seamless: false },
    signature: summary.signature || '',
  };
}

/** 两次台账差异：新增/移除/替换的帧序号（SW 重启后对比用）。 */
export function diffFrameLedger(previous, current) {
  const left = isPlainObject(previous) && Array.isArray(previous.frames) ? previous.frames : [];
  const right = isPlainObject(current) && Array.isArray(current.frames) ? current.frames : [];
  const leftByKey = new Map(left.map((frame) => [frame.kind + '#' + frame.index, frame]));
  const rightByKey = new Map(right.map((frame) => [frame.kind + '#' + frame.index, frame]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, frame] of rightByKey) {
    if (!leftByKey.has(key)) {
      added.push({ kind: frame.kind, index: frame.index });
      continue;
    }
    const before = leftByKey.get(key);
    if (before.hash !== frame.hash || frameSignature(before) !== frameSignature(frame)) {
      changed.push({ kind: frame.kind, index: frame.index, previousHash: before.hash, nextHash: frame.hash });
    }
  }
  for (const [key, frame] of leftByKey) {
    if (!rightByKey.has(key)) removed.push({ kind: frame.kind, index: frame.index });
  }
  return {
    added,
    removed,
    changed,
    ok: added.length === 0 && removed.length === 0 && changed.length === 0,
    previousSignature: frameDigest(left),
    nextSignature: frameDigest(right),
  };
}

/** 从既有采集产物（tiled-capture 的 segments[] / video 的 fragments[]）反建期望帧。 */
export function expectedFramesFromPlan(items, options = {}) {
  const kind = normalizeFrameKind(options.kind || 'longshot-segment');
  const list = Array.isArray(items) ? items : [];
  const frames = [];
  for (let position = 0; position < list.length; position += 1) {
    const item = isPlainObject(list[position]) ? list[position] : null;
    if (!item) continue;
    const index = intOr(item.index, position);
    const pageY = intOr(item.pageY != null ? item.pageY : (item.offsetY != null ? item.offsetY : (item.pageY)), 0);
    const drawY = intOr(item.drawY != null ? item.drawY : (item.offset != null ? item.offset : item.y), pageY);
    const pageHeight = intOr(item.pageHeight != null ? item.pageHeight : (item.height != null ? item.height : item.drawHeight), 0);
    const drawHeight = intOr(item.drawHeight != null ? item.drawHeight : (item.height != null ? item.height : item.pageHeight), pageHeight);
    frames.push({
      kind,
      index,
      role: typeof item.role === 'string' ? item.role : (index === 0 ? 'first' : 'middle'),
      pageY,
      drawY,
      pageHeight,
      drawHeight,
      width: Math.max(1, intOr(item.width, 1)),
      dpr: Math.max(1, Number(item.dpr) || 1),
      state: 'planned',
      at: 0,
    });
  }
  return frames;
}

/** 帧键：kind#index（跨路径通用的稳定主键）。 */
export function frameKey(frame) {
  const identity = frameIdentity(frame);
  return identity.kind + '#' + identity.index;
}

/** 按 kind 分组（顺序保持：先出现的 kind 在前）。 */
export function groupFramesByKind(frames) {
  const groups = new Map();
  for (const frame of Array.isArray(frames) ? frames : []) {
    if (!isPlainObject(frame)) continue;
    const kind = normalizeFrameKind(frame.kind);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(frame);
  }
  return groups;
}

/**
 * 帧直方图：分 kind / role / state 计数 + 字节/面积合计。
 * 只统计合法帧；非法帧落到 invalid 计数里（不抛）。
 */
export function frameHistogram(frames) {
  const byKind = {};
  const byRole = {};
  const byState = {};
  let bytes = 0;
  let pixels = 0;
  let invalid = 0;
  for (const frame of Array.isArray(frames) ? frames : []) {
    const normalized = normalizeFrame(frame, { now: 0 });
    if (!normalized.ok) {
      invalid += 1;
      continue;
    }
    const item = normalized.frame;
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
    byRole[item.role] = (byRole[item.role] || 0) + 1;
    byState[item.state] = (byState[item.state] || 0) + 1;
    bytes += item.bytes;
    pixels += Math.max(0, item.width * Math.max(item.height, item.pageHeight));
  }
  return { frames: Math.max(0, (Array.isArray(frames) ? frames.length : 0) - invalid), invalid, byKind, byRole, byState, bytes, pixels };
}

/** 帧窗口：按 kind 过滤后按 index 升序，再按 [fromIndex, toIndex] 截取（便于协议只回传局部）。 */
export function selectFrameWindow(frames, options = {}) {
  const kind = options.kind ? normalizeFrameKind(options.kind) : null;
  const fromIndex = Number.isFinite(Number(options.fromIndex)) ? Math.round(Number(options.fromIndex)) : null;
  const toIndex = Number.isFinite(Number(options.toIndex)) ? Math.round(Number(options.toIndex)) : null;
  const limit = Math.max(0, intOr(options.max, 0));
  const list = (Array.isArray(frames) ? frames : [])
    .filter((frame) => isPlainObject(frame))
    .map((frame, position) => ({ frame, position }))
    .filter((item) => !kind || normalizeFrameKind(item.frame.kind) === kind)
    .filter((item) => {
      const index = intOr(item.frame.index, -1);
      if (fromIndex != null && index < fromIndex) return false;
      if (toIndex != null && index > toIndex) return false;
      return true;
    })
    .sort((left, right) => intOr(left.frame.index, 0) - intOr(right.frame.index, 0));
  const bounded = limit > 0 ? list.slice(0, limit) : list;
  return {
    total: list.length,
    returned: bounded.length,
    truncated: bounded.length < list.length,
    indexes: bounded.map((item) => intOr(item.frame.index, 0)),
    frames: bounded.map((item) => item.frame),
  };
}

/**
 * 两次帧集合对比（只比身份与 hash，不含 at）：用于“同一 capture 的两次采集/恢复”对比。
 * 与 diffFrameLedger 不同：入参就是帧数组，不要求台账结构。
 */
export function compareFrameSets(previous, current) {
  const index = buildFrameIndex(previous);
  const next = buildFrameIndex(current);
  const previousKeys = new Set(index.list.map((frame) => frameKey(frame)));
  const nextKeys = new Set(next.list.map((frame) => frameKey(frame)));
  const added = next.list.filter((frame) => !previousKeys.has(frameKey(frame))).map((frame) => ({ kind: frame.kind, index: frame.index }));
  const removed = index.list.filter((frame) => !nextKeys.has(frameKey(frame))).map((frame) => ({ kind: frame.kind, index: frame.index }));
  const changed = [];
  for (const frame of next.list) {
    const before = index.byKey.get(frameKey(frame));
    if (!before) continue;
    if (before.hash !== frame.hash || frameSignature(before) !== frameSignature(frame)) {
      changed.push({ kind: frame.kind, index: frame.index, previousHash: before.hash, nextHash: frame.hash });
    }
  }
  const common = next.list.length - added.length;
  return {
    added,
    removed,
    changed,
    common,
    ok: added.length === 0 && removed.length === 0 && changed.length === 0,
    previousSignature: index.signature,
    nextSignature: next.signature,
    changedRatio: next.list.length ? Number((changed.length / next.list.length).toFixed(6)) : 0,
  };
}

/** 最大覆盖缺口：返回最长缺口与缺口总数（用于日志/告警阈值判断）。 */
export function worstCoverageGap(frames, options = {}) {
  const coverage = frameCoverage(frames, options);
  let largest = null;
  for (const gap of coverage.gaps) {
    if (!largest || gap.length > largest.length) largest = gap;
  }
  return {
    ...coverage,
    largest,
    largestLength: largest ? largest.length : 0,
    worstRatio: coverage.total > 0 ? Number(((largest ? largest.length : 0) / coverage.total).toFixed(6)) : 0,
  };
}

/** 从帧数组一步建台账（等价 createFrameLedger + 连续 appendFrame；重复帧按较新保留）。 */
export function frameLedgerFromFrames(frames, options = {}) {
  let ledger = createFrameLedger(options);
  let accepted = 0;
  let duplicates = 0;
  let rejected = 0;
  for (const frame of Array.isArray(frames) ? frames : []) {
    const result = appendFrame(ledger, frame, { now: options.now });
    ledger = result.ledger;
    if (result.accepted) accepted += 1;
    else if (result.duplicate) duplicates += 1;
    else rejected += 1;
  }
  return { ledger, accepted, duplicates, rejected, summary: frameLedgerSummary(ledger) };
}

/** 覆盖摘要 → 协议字段（与 longshotFrameWire 的 coverage 同形状，便于拼接复用）。 */
export function coverageWire(coverage) {
  if (!isPlainObject(coverage)) return { ratio: 0, covered: 0, total: 0, gaps: 0, gapLength: 0, seamless: false };
  return {
    ratio: Number(coverage.ratio) || 0,
    covered: Math.max(0, intOr(coverage.covered, 0)),
    total: Math.max(0, intOr(coverage.total, 0)),
    gaps: Math.max(0, intOr(coverage.gapCount, 0)),
    gapLength: Math.max(0, intOr(coverage.gapLength, 0)),
    seamless: coverage.seamless === true,
  };
}

/** 覆盖改善度：两次覆盖报告对比（正数表示变好）。 */
export function coverageDelta(previous, current) {
  const before = isPlainObject(previous) ? previous : {};
  const after = isPlainObject(current) ? current : {};
  const beforeRatio = Number(before.ratio) || 0;
  const afterRatio = Number(after.ratio) || 0;
  return {
    beforeRatio,
    afterRatio,
    delta: Number((afterRatio - beforeRatio).toFixed(6)),
    beforeGaps: Math.max(0, intOr(before.gapCount, 0)),
    afterGaps: Math.max(0, intOr(after.gapCount, 0)),
    improved: afterRatio > beforeRatio || (Math.max(0, intOr(after.gapCount, 0)) < Math.max(0, intOr(before.gapCount, 0))),
  };
}
