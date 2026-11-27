// lib/longshot-compress.js —— 长截图分片/索引的存储压缩与体积预算（纯函数）。
//
// 背景：长截图落盘 = 每段一张 PNG（IndexedDB）+ manifest（JSON）+ 可选 dataURL（storage.session）。
// 0.3.0 没有“体积预算”概念：段一律 PNG、manifest 全量 JSON，超大页一次能写几十 MB，
// 写满配额后分片半途失败，恢复侧只剩半张图。第十一批-E 把压缩/预算收敛成纯函数：
//   * estimatePngBytes()/estimateEncodedBytes() —— 按像素/熵/格式/质量估算体积（不真编码）；
//   * chooseFrameEncoding()                    —— 在字节预算内选 PNG/WebP/JPEG 与质量档；
//   * dedupeFrames()                           —— 相同 hash 的帧只存一份（段落重复/白屏页常见）；
//   * planLongshotCompression()                —— 全部帧 → 编码方案 + 预算结论 + 压缩后体积；
//   * compactManifest()                        —— manifest 瘦身（保留恢复所需字段，只加 bytes 证据）；
//   * planCompressionStorage()                 —— 压缩结论 + capture-storage-budget 的配额决策。
//
// 说明：本模块不调用 canvas.convertToBlob，也不改变既有落盘格式；运行时只在“显式需要预算证据”
// 时读取 plan，默认路径（PNG 落盘）行为不变。

import { planStorageBudget, storageBudgetWire } from './capture-storage-budget.js';

export const LONGSHOT_COMPRESS_VERSION = 1;

/** 支持的目标格式（只加不改；运行时仍以 PNG 为主）。 */
export const COMPRESS_FORMATS = Object.freeze(['png', 'webp', 'jpeg']);

/** 预算结论动作（只加不改）。 */
export const COMPRESS_ACTIONS = Object.freeze(['fits', 'shrink', 'degrade', 'reject', 'dedupe']);

export const COMPRESS_CODES = Object.freeze({
  OK: 'longshot.compress.ok',
  DEDUPE: 'longshot.compress.dedupe',
  SHRINK: 'longshot.compress.shrink',
  DEGRADE: 'longshot.compress.degrade',
  REJECT: 'longshot.compress.reject',
  ESTIMATE: 'longshot.compress.estimate',
});

export const COMPRESS_DEFAULTS = Object.freeze({
  // 目标段体积（单段）：8MB（与 512px 分片 + 40000px 高的典型 PNG 量级对齐）。
  maxFrameBytes: 8 * 1024 * 1024,
  // 整次采集的段总量上限：64MB。
  maxTotalBytes: 64 * 1024 * 1024,
  // PNG/WebP/JPEG 的经验每像素字节（Z 轴：熵 0..1 之间线性插值）。
  pngBytesPerPixel: Object.freeze([0.02, 0.55]),
  webpBytesPerPixel: Object.freeze([0.01, 0.32]),
  jpegBytesPerPixel: Object.freeze([0.008, 0.22]),
  // 质量档（WebP/JPEG 用；PNG 忽略）。
  qualitySteps: Object.freeze([0.92, 0.82, 0.72, 0.6]),
  // manifest 瘦身：每条段记录保留的键（其余键丢弃）。
  manifestSegmentKeys: Object.freeze(['index', 'offset', 'bytes', 'hash', 'width', 'height']),
  // 估算时给 JSON 留的固定开销（version/captureId/时间戳等）。
  manifestFixedBytes: 256,
});

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

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function formatOf(value) {
  const text = String(value == null ? '' : value).toLowerCase();
  if (text === 'webp') return 'webp';
  if (text === 'jpg' || text === 'jpeg') return 'jpeg';
  return 'png';
}

function bytesPerPixelFor(format, quality, entropy) {
  const normalized = formatOf(format);
  const table = normalized === 'webp' ? COMPRESS_DEFAULTS.webpBytesPerPixel
    : (normalized === 'jpeg' ? COMPRESS_DEFAULTS.jpegBytesPerPixel : COMPRESS_DEFAULTS.pngBytesPerPixel);
  const [low, high] = table;
  const entropyRatio = clamp01(entropy, 0.35);
  let perPixel = low + (high - low) * entropyRatio;
  // 质量档只影响有损格式：0.92 → 1.0x，0.6 → 1.35x（质量越低体积越小）。
  if (normalized !== 'png') {
    const qualityRatio = clamp01(quality, 0.82);
    perPixel *= 0.7 + (qualityRatio - 0.6) * 0.75;
  }
  return Math.max(1 / 1024, perPixel);
}

/** PNG 体积估算：像素 × 每像素字节（熵越高越接近上限），加 64B 头部开销。 */
export function estimatePngBytes(params = {}) {
  const options = isPlainObject(params) ? params : {};
  const w = Math.max(1, intOr(options.width, 1));
  const h = Math.max(1, intOr(options.height, 1));
  const scale = Math.max(0.1, Number(options.dpr) || 1);
  const pixels = Math.round(w * h * scale * scale);
  const perPixel = bytesPerPixelFor('png', 1, options.entropy);
  return Math.max(128, Math.round(pixels * perPixel) + 64);
}

/**
 * 通用编码体积估算：format/quality/entropy 决定每像素字节。
 * @returns {{format: string, quality: number, pixels: number, bytes: number, bytesPerPixel: number}}
 */
export function estimateEncodedBytes(params = {}) {
  const options = isPlainObject(params) ? params : {};
  const w = Math.max(1, intOr(options.width, 1));
  const h = Math.max(1, intOr(options.height, 1));
  const scale = Math.max(0.1, Number(options.dpr) || 1);
  const pixels = Math.round(w * h * scale * scale);
  const normalizedFormat = formatOf(options.format);
  const normalizedQuality = clamp01(options.quality, 0.82);
  const perPixel = bytesPerPixelFor(normalizedFormat, normalizedQuality, options.entropy);
  return {
    format: normalizedFormat,
    quality: Number(normalizedQuality.toFixed(3)),
    pixels,
    bytes: Math.max(128, Math.round(pixels * perPixel) + 64),
    bytesPerPixel: Number(perPixel.toFixed(6)),
  };
}

/**
 * 在“单帧字节上限”内选编码：优先调用方偏好格式，其次 PNG → WebP → JPEG 逐档降质量。
 * 无法满足时返回 fits:false + 最小可达体积（调用方决定拆段还是接受超限）。
 */
export function chooseFrameEncoding(options = {}) {
  const width = Math.max(1, intOr(options.width, 1));
  const height = Math.max(1, intOr(options.height, 1));
  const dpr = Math.max(0.1, Number(options.dpr) || 1);
  const entropy = clamp01(options.entropy, 0.35);
  const limit = Math.max(0, intOr(options.maxBytes, COMPRESS_DEFAULTS.maxFrameBytes));
  const prefer = formatOf(options.prefer || 'png');
  const order = [prefer, ...COMPRESS_FORMATS.filter((format) => format !== prefer)];
  const candidates = [];
  for (const format of order) {
    const qualities = format === 'png' ? [1] : COMPRESS_DEFAULTS.qualitySteps;
    for (const quality of qualities) {
      const estimate = estimateEncodedBytes({ width, height, format, quality, entropy, dpr });
      candidates.push(estimate);
      if (estimate.bytes <= limit) {
        return {
          ...estimate,
          limit,
          fits: true,
          degraded: format !== prefer || (format !== 'png' && quality !== COMPRESS_DEFAULTS.qualitySteps[0]),
          attempts: candidates.length,
          candidates,
        };
      }
    }
  }
  const smallest = candidates.reduce((best, item) => (item.bytes < best.bytes ? item : best), candidates[0]);
  return {
    ...(smallest || estimateEncodedBytes({ width, height, format: prefer, entropy, dpr })),
    limit,
    fits: false,
    degraded: true,
    attempts: candidates.length,
    candidates,
  };
}

/**
 * 相同 hash 的帧去重：保留第一条（或 keep 指定的），其余进 duplicates 并累计可省体积。
 * 帧没有 hash 时不参与去重（不伪造结论）。
 */
export function dedupeFrames(frames, options = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const seen = new Map();
  const unique = [];
  const duplicates = [];
  let savedBytes = 0;
  for (let position = 0; position < list.length; position += 1) {
    const frame = isPlainObject(list[position]) ? list[position] : null;
    if (!frame) continue;
    const hash = typeof frame.hash === 'string' ? frame.hash : '';
    const bytes = Math.max(0, intOr(frame.bytes, 0));
    if (!hash) {
      unique.push({ ...frame, position, duplicateOf: null });
      continue;
    }
    if (seen.has(hash)) {
      const first = seen.get(hash);
      duplicates.push({ hash, index: intOr(frame.index, position), duplicateOf: first.index, bytes });
      savedBytes += bytes;
      continue;
    }
    const record = { ...frame, position, duplicateOf: null };
    seen.set(hash, record);
    unique.push(record);
  }
  return { unique, duplicates, savedBytes, ratio: list.length ? Number((duplicates.length / list.length).toFixed(4)) : 0 };
}

function budgetOf(input) {
  const source = isPlainObject(input) ? input : {};
  return {
    maxFrameBytes: Math.max(0, intOr(source.maxFrameBytes, COMPRESS_DEFAULTS.maxFrameBytes)),
    maxTotalBytes: Math.max(0, intOr(source.maxTotalBytes, COMPRESS_DEFAULTS.maxTotalBytes)),
    prefer: formatOf(source.prefer || 'png'),
    entropy: clamp01(source.entropy, 0.35),
    dpr: Math.max(0.1, Number(source.dpr) || 1),
  };
}

function normalizeCompressFrame(frame, position = 0) {
  if (!isPlainObject(frame)) return null;
  const width = Math.max(1, intOr(frame.width, 0));
  const height = Math.max(1, intOr(frame.height != null ? frame.height : (frame.drawHeight != null ? frame.drawHeight : frame.pageHeight), 0));
  if (!(width > 0) || !(height > 0)) return null;
  return {
    index: intOr(frame.index, position),
    width,
    height,
    bytes: Math.max(0, intOr(frame.bytes, 0)),
    hash: typeof frame.hash === 'string' ? frame.hash : '',
    pageY: Math.max(0, intOr(frame.pageY, 0)),
    drawY: Math.max(0, intOr(frame.drawY, frame.pageY)),
    role: typeof frame.role === 'string' ? frame.role : 'middle',
  };
}

/**
 * 压缩计划：去重 → 逐帧编码选择 → 总量/单帧预算 → 结论。
 * 只做规划，不编码；结果里的 perFrame 已含 estimateBytes 与 format。
 */
export function planLongshotCompression(frames, options = {}) {
  const budget = budgetOf(options);
  const normalized = (Array.isArray(frames) ? frames : [])
    .map((frame, position) => normalizeCompressFrame(frame, position))
    .filter(Boolean);
  const deduped = dedupeFrames(normalized);
  const perFrame = [];
  let totalBytes = 0;
  let degradedFrames = 0;
  let rejectedFrames = 0;
  for (const frame of deduped.unique) {
    const choice = chooseFrameEncoding({
      width: frame.width,
      height: frame.height,
      dpr: budget.dpr,
      entropy: budget.entropy,
      prefer: budget.prefer,
      maxBytes: budget.maxFrameBytes,
    });
    const record = {
      index: frame.index,
      width: frame.width,
      height: frame.height,
      pageY: frame.pageY,
      drawY: frame.drawY,
      role: frame.role,
      hash: frame.hash,
      originalBytes: frame.bytes,
      format: choice.format,
      quality: choice.quality,
      estimateBytes: choice.bytes,
      fits: choice.fits,
      degraded: choice.degraded,
      savedBytes: Math.max(0, frame.bytes - choice.bytes),
    };
    if (!choice.fits) rejectedFrames += 1;
    else if (choice.degraded) degradedFrames += 1;
    totalBytes += choice.bytes;
    perFrame.push(record);
  }
  const overTotal = budget.maxTotalBytes > 0 && totalBytes > budget.maxTotalBytes;
  let action = 'fits';
  if (!normalized.length) action = 'fits';
  else if (deduped.duplicates.length) action = 'dedupe';
  if (overTotal || rejectedFrames > 0) action = 'shrink';
  if (overTotal && budget.prefer !== 'jpeg') action = 'degrade';
  if (overTotal && totalBytes > budget.maxTotalBytes * 1.5) action = 'reject';
  const originalBytes = normalized.reduce((sum, frame) => sum + frame.bytes, 0);
  const issues = [];
  if (!normalized.length) issues.push(COMPRESS_CODES.OK);
  if (deduped.duplicates.length) issues.push(COMPRESS_CODES.DEDUPE);
  if ((action === 'fits' || action === 'dedupe') && !issues.includes(COMPRESS_CODES.OK)) issues.push(COMPRESS_CODES.OK);
  if (action === 'shrink') issues.push(COMPRESS_CODES.SHRINK);
  if (action === 'degrade') issues.push(COMPRESS_CODES.DEGRADE);
  if (action === 'reject') issues.push(COMPRESS_CODES.REJECT);
  return {
    version: LONGSHOT_COMPRESS_VERSION,
    action,
    ok: action !== 'reject',
    budget,
    frames: normalized.length,
    uniqueFrames: deduped.unique.length,
    perFrame,
    duplicates: deduped.duplicates,
    dedupeSavedBytes: deduped.savedBytes,
    originalBytes,
    totalBytes,
    savedBytes: Math.max(0, originalBytes - totalBytes),
    degradedFrames,
    rejectedFrames,
    ratios: {
      dedupe: deduped.ratio,
      compression: originalBytes > 0 ? Number((totalBytes / originalBytes).toFixed(6)) : 1,
    },
    issues,
    evidence: {
      action,
      frames: normalized.length,
      uniqueFrames: deduped.unique.length,
      originalBytes,
      totalBytes,
      dedupeSavedBytes: deduped.savedBytes,
      degradedFrames,
      rejectedFrames,
      maxFrameBytes: budget.maxFrameBytes,
      maxTotalBytes: budget.maxTotalBytes,
    },
  };
}

/**
 * manifest 瘦身：只保留恢复必需字段（index/offset/bytes/hash/width/height），
 * 并给出“瘦身后字节”估算（用 JSON.stringify 长度，确定性可断言）。
 */
export function compactManifest(manifest, options = {}) {
  if (!isPlainObject(manifest)) {
    return { manifest: null, bytes: 0, savedBytes: 0, segments: 0, compacted: false };
  }
  const keys = Array.isArray(options.segmentKeys) ? options.segmentKeys : COMPRESS_DEFAULTS.manifestSegmentKeys;
  const segments = (Array.isArray(manifest.segments) ? manifest.segments : []).map((segment) => {
    const compact = {};
    if (isPlainObject(segment)) {
      for (const key of keys) {
        if (segment[key] !== undefined) compact[key] = segment[key];
      }
    }
    return compact;
  });
  const compacted = {
    version: manifest.version,
    captureId: manifest.captureId,
    dpr: manifest.dpr,
    width: manifest.width,
    height: manifest.height,
    total: manifest.total,
    sealed: manifest.sealed === true,
    segments,
  };
  const originalBytes = safeJsonBytes(manifest);
  const bytes = safeJsonBytes(compacted);
  return {
    manifest: compacted,
    bytes,
    originalBytes,
    savedBytes: Math.max(0, originalBytes - bytes),
    segments: segments.length,
    compacted: bytes < originalBytes,
    ratio: originalBytes > 0 ? Number((bytes / originalBytes).toFixed(6)) : 1,
  };
}

function safeJsonBytes(value) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return 0;
    // JSON 里非 ASCII 字符按 UTF-16 计长更接近实际字符串长度；这里用 UTF-8 字节数口径。
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
    return text.length;
  } catch {
    return 0;
  }
}

/** manifest 字节估算（不序列化大字段也能给量级；用于预算前置判断）。 */
export function estimateManifestBytes(segments, options = {}) {
  const count = Math.max(0, intOr(segments, Array.isArray(segments) ? segments.length : 0));
  const fixed = Math.max(0, intOr(options.fixedBytes, COMPRESS_DEFAULTS.manifestFixedBytes));
  // 每条段 ~ 110B（index/offset/bytes/hash/width/height + JSON 标点）。
  const perSegment = Math.max(16, intOr(options.perSegmentBytes, 110));
  return fixed + count * perSegment;
}

/** 压缩计划 + 配额决策（把“要写多少”喂给 capture-storage-budget）。 */
export function planCompressionStorage(plan, options = {}) {
  const source = isPlainObject(plan) ? plan : {};
  const incomingBytes = Math.max(0, intOr(options.incomingBytes, intOr(source.totalBytes, 0)));
  const storage = planStorageBudget({
    captures: options.captures,
    usedBytes: options.usedBytes,
    incomingBytes,
    kind: 'longshot',
    quotaBytes: options.quotaBytes,
    warnRatio: options.warnRatio,
    criticalRatio: options.criticalRatio,
    reserveBytes: options.reserveBytes,
    maxCaptureRatio: options.maxCaptureRatio,
    now: options.now,
  });
  return {
    version: LONGSHOT_COMPRESS_VERSION,
    action: source.action || 'fits',
    incomingBytes,
    compressedBytes: Math.max(0, intOr(source.totalBytes, 0)),
    storage,
    storageWire: storageBudgetWire(storage),
    ok: storage.ok === true && source.action !== 'reject',
    evidence: {
      action: source.action || 'fits',
      incomingBytes,
      compressedBytes: Math.max(0, intOr(source.totalBytes, 0)),
      storageAction: storage.action,
      storageCode: storage.code,
    },
  };
}

/** 压缩计划 → 协议字段（perFrame 截断；计数完整）。 */
export function compressionWire(plan, options = {}) {
  if (!isPlainObject(plan)) {
    return { version: LONGSHOT_COMPRESS_VERSION, action: 'fits', totalBytes: 0, frames: 0 };
  }
  const limit = clampInt(options.maxListed, 0, 32, 6);
  return {
    version: LONGSHOT_COMPRESS_VERSION,
    action: String(plan.action || 'fits'),
    ok: plan.ok === true,
    frames: plan.frames || 0,
    uniqueFrames: plan.uniqueFrames || 0,
    originalBytes: plan.originalBytes || 0,
    totalBytes: plan.totalBytes || 0,
    savedBytes: plan.savedBytes || 0,
    dedupeSavedBytes: plan.dedupeSavedBytes || 0,
    degradedFrames: plan.degradedFrames || 0,
    rejectedFrames: plan.rejectedFrames || 0,
    ratios: plan.ratios || { dedupe: 0, compression: 1 },
    framesPreview: (Array.isArray(plan.perFrame) ? plan.perFrame : []).slice(0, limit).map((frame) => ({
      index: frame.index,
      format: frame.format,
      quality: frame.quality,
      estimateBytes: frame.estimateBytes,
      degraded: frame.degraded,
    })),
    duplicates: (Array.isArray(plan.duplicates) ? plan.duplicates : []).slice(0, limit),
    issues: Array.isArray(plan.issues) ? plan.issues.slice(0, 8) : [],
    text: describeCompression(plan),
  };
}

/** 一行日志：'长截图压缩 dedupe：12 帧→10 帧，去重省 1.2MB，估算 8.4MB'。 */
export function describeCompression(plan) {
  if (!isPlainObject(plan)) return '长截图压缩 无';
  const toMb = (bytes) => (Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(1);
  return '长截图压缩 ' + String(plan.action || 'fits') +
    '：' + (plan.frames || 0) + ' 帧→' + (plan.uniqueFrames || 0) + ' 帧' +
    '，去重省 ' + toMb(plan.dedupeSavedBytes) + 'MB' +
    '，估算 ' + toMb(plan.totalBytes) + 'MB' +
    (plan.degradedFrames ? '，降档 ' + plan.degradedFrames + ' 帧' : '') +
    (plan.rejectedFrames ? '，超限 ' + plan.rejectedFrames + ' 帧' : '');
}
