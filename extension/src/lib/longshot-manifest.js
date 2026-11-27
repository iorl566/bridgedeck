// lib/longshot-manifest.js —— 长截图分片索引 manifest（index.json 等价物，纯函数）。
//
// 0.3.0 的恢复能力只有 IndexedDB tile 列表（longshot-store.listLongshotTiles）：
// 没有“这次截图本来该有多少段/每段偏移与 hash/是否 sealed”的权威索引，于是：
//   * 崩溃后无法判断分片是“拍完了”还是“拍到一半”，只能把现有 tile 硬拼；
//   * 分片内容被覆盖/写坏时没有 hash 可比对，恢复出静默的错图；
//   * 过期分片没有清理依据（只能靠 capture-manifest 的 TTL 间接猜）。
//
// 本模块定义与兼容目标 index.json 等价的 manifest 结构，并给出纯函数：
//   buildLongshotManifest()        —— 建索引 {version,total,dpr,segments[],sealed,createdAt}；
//   appendSegment()/sealManifest() —— 追加/替换分片、封版（不可变返回新对象）；
//   validateManifest()             —— 结构/连续性/hash 形状自检（sealed 必须完整）；
//   resumeLongshotManifest()       —— 断点恢复计划：reuse / refetch(missing|hash-mismatch|bytes-mismatch) / expired；
//   pruneLongshotManifests()       —— TTL + 数量上限清理（可保留在途 capture）；
//   hashLongshotBytes()            —— 分片字节 hash（FNV-1a + djb2 双 32 位 → 16 hex，无依赖）。
//
// hash 只用于“同一份字节是否被改写/覆盖”的完整性判断，不是密码学签名；16 hex 足够区分
// 同一次 capture 内的分片。运行时在 tiled-capture 落盘分片后算、longshot-recover 读回时校验。
//
// 第十一批-E：manifestSummary 只加两个派生字段（不改 manifest 结构、不改既有键）：
//   * frames  —— 索引自对账（缺号/重复/乱序/覆盖），来自 lib/longshot-frame-reconcile；
//   * storage —— 按段字节做的压缩/预算估算，来自 lib/longshot-compress。

import { reconcileManifestFrames } from './longshot-frame-reconcile.js';
import { planLongshotCompression, compressionWire } from './longshot-compress.js';

export const LONGSHOT_MANIFEST_VERSION = 1;
export const LONGSHOT_MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;
export const LONGSHOT_MANIFEST_MAX = 32;
const HASH_PATTERN = /^[0-9a-f]{8,32}$/;

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function hex32(value) {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * 分片字节 hash：FNV-1a（32 位）与 djb2（32 位）拼接成 16 hex。
 * 支持 Uint8Array / ArrayBuffer / ArrayBufferView / 字符串（UTF-8）。
 */
export function hashLongshotBytes(input) {
  let bytes;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (input && typeof input.byteLength === 'number') {
    try {
      bytes = new Uint8Array(input);
    } catch {
      return '';
    }
  } else {
    return '';
  }
  let fnv = 2166136261 >>> 0;
  let djb = 5381 >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    fnv = Math.imul(fnv ^ byte, 16777619) >>> 0;
    djb = ((Math.imul(djb, 33) >>> 0) + byte) >>> 0;
  }
  return hex32(fnv) + hex32(djb);
}

function normalizeHash(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function normalizeSegment(segment, fallbackIndex) {
  const value = segment && typeof segment === 'object' ? segment : {};
  const index = Math.max(0, intOr(value.index, fallbackIndex));
  return {
    index,
    offset: Math.max(0, intOr(value.offset != null ? value.offset : (value.drawY != null ? value.drawY : value.y), 0)),
    bytes: Math.max(0, intOr(value.bytes, 0)),
    hash: normalizeHash(value.hash),
    width: Math.max(0, intOr(value.width, 0)),
    height: Math.max(0, intOr(value.height, 0)),
  };
}

function normalizeSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  return list.map((segment, index) => normalizeSegment(segment, index)).sort((a, b) => a.index - b.index);
}

/** ISO 时间字符串；非法时间回落 now。 */
function isoAt(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return new Date(number).toISOString();
  const date = typeof value === 'string' ? new Date(value) : null;
  if (date && Number.isFinite(date.getTime())) return date.toISOString();
  return new Date(fallback).toISOString();
}

/**
 * 建 manifest。total 是“这次截图计划拍几段”（可大于当前已拍段数，unsealed 状态表示拍到一半）。
 * @returns {object} manifest
 */
export function buildLongshotManifest(params = {}) {
  const captureId = String(params.captureId || params.longshotId || '');
  if (!captureId) throw new Error('长截图 manifest 需要 captureId');
  const now = Number.isFinite(Number(params.now)) ? Number(params.now) : Date.now();
  const segments = Array.isArray(params.segments) ? params.segments : [];
  const maxIndex = segments.reduce((max, segment) => Math.max(max, intOr(segment && segment.index, 0)), -1);
  const total = Math.max(0, intOr(params.total, Math.max(segments.length, maxIndex + 1)));
  const createdAt = isoAt(params.createdAt, now);
  return {
    version: LONGSHOT_MANIFEST_VERSION,
    captureId,
    tabId: Number.isInteger(Number(params.tabId)) ? Number(params.tabId) : null,
    url: String(params.url || '').slice(0, 2048),
    dpr: Number(params.dpr) > 0 ? Math.round(Number(params.dpr) * 1000) / 1000 : 1,
    width: Math.max(0, intOr(params.width, 0)),
    height: Math.max(0, intOr(params.height, 0)),
    total,
    sealed: params.sealed === true,
    sealedAt: params.sealed === true ? isoAt(params.sealedAt, now) : null,
    createdAt,
    updatedAt: createdAt,
    segments: normalizeSegments(segments),
  };
}

/** 追加或替换一段（按 index 覆盖，用于 stale 重写/refetch）；返回新对象，不修改入参。 */
export function appendSegment(manifest, segment, options = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('appendSegment 需要 manifest');
  const next = normalizeSegment(segment, manifest.segments && manifest.segments.length ? manifest.segments.length : 0);
  const total = Math.max(intOr(manifest.total, 0), next.index + 1, (manifest.segments || []).length);
  const segments = (Array.isArray(manifest.segments) ? manifest.segments : [])
    .map((item) => normalizeSegment(item, 0))
    .filter((item) => item.index !== next.index)
    .concat([next])
    .sort((a, b) => a.index - b.index);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return {
    ...manifest,
    total,
    sealed: manifest.sealed === true,
    updatedAt: isoAt(now, now),
    segments,
  };
}

/** 封版：要求所有段齐全（indexes 0..total-1）且 hash 已记录；返回新对象。 */
export function sealManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('sealManifest 需要 manifest');
  const candidate = { ...manifest, sealed: true };
  const validation = validateManifest(candidate, { requireSealed: true });
  if (!validation.ok) {
    const first = validation.errors[0] || { code: 'invalid', message: 'manifest 无效' };
    throw new Error('长截图 manifest 不能封版：' + first.code + ' ' + first.message);
  }
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return {
    ...candidate,
    sealed: true,
    sealedAt: isoAt(options.sealedAt, now),
    updatedAt: isoAt(now, now),
    hashVerified: options.hashVerified !== false,
  };
}

/** 结构/连续性自检。sealed 的 manifest 必须段齐、序号 0..total-1、hash 齐全。 */
export function validateManifest(manifest, options = {}) {
  const errors = [];
  const warnings = [];
  const push = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: [{ code: 'not-object', message: 'manifest 不是对象' }], warnings };
  }
  if (manifest.version !== LONGSHOT_MANIFEST_VERSION) {
    push('version', 'manifest 版本应为 ' + LONGSHOT_MANIFEST_VERSION + '，实际 ' + manifest.version);
  }
  if (!manifest.captureId || typeof manifest.captureId !== 'string') push('captureId', 'manifest 缺少 captureId');
  const dpr = Number(manifest.dpr);
  if (!Number.isFinite(dpr) || dpr < 1 || dpr > 3) push('dpr', 'manifest dpr 必须在 1–3，实际 ' + manifest.dpr);
  if (!(Number(manifest.width) > 0)) push('width', 'manifest width 必须为正');
  if (!(Number(manifest.height) > 0)) push('height', 'manifest height 必须为正');
  const total = intOr(manifest.total, -1);
  if (total < 0) push('total', 'manifest total 必须为非负整数');
  if (manifest.sealed !== true && manifest.sealed !== false) push('sealed', 'manifest sealed 必须是布尔');
  const createdAtMs = Date.parse(manifest.createdAt);
  if (!Number.isFinite(createdAtMs)) push('createdAt', 'manifest createdAt 不是合法时间');
  const segments = Array.isArray(manifest.segments) ? manifest.segments : null;
  if (!segments) {
    push('segments', 'manifest segments 必须是数组');
    return { ok: errors.length === 0, errors, warnings };
  }
  if (segments.length > total) push('segments-total', '分片数 ' + segments.length + ' 超过 total ' + total);
  const seen = new Set();
  let previous = null;
  for (const raw of segments) {
    const segment = raw && typeof raw === 'object' ? raw : null;
    if (!segment) {
      push('segment', '分片不是对象');
      continue;
    }
    const index = intOr(segment.index, -1);
    if (index < 0) push('segment-index', '分片 index 必须为非负整数', { index });
    if (seen.has(index)) push('segment-duplicate', '分片 index 重复：' + index, { index });
    seen.add(index);
    if (index >= total) push('segment-overflow', '分片 index ' + index + ' 超过 total ' + total, { index });
    if (previous !== null && segment.offset < previous.offset) {
      push('segment-order', '分片 offset 必须随 index 递增', { index });
    }
    if (previous !== null && intOr(segment.offset, 0) !== previous.offset + previous.height) {
      warnings.push({ code: 'overlap', message: '分片 offset/height 不连续（允许重叠区）', index });
    }
    if (!(Number(segment.offset) >= 0)) push('segment-offset', '分片 offset 必须为非负整数', { index });
    if (!(Number(segment.width) > 0)) push('segment-width', '分片 width 必须为正', { index });
    if (!(Number(segment.height) > 0)) push('segment-height', '分片 height 必须为正', { index });
    if (!(Number(segment.bytes) >= 0)) push('segment-bytes', '分片 bytes 必须为非负整数', { index });
    const hash = normalizeHash(segment.hash);
    if (!hash) {
      if (manifest.sealed === true) push('segment-hash', 'sealed manifest 的每个分片都必须有 hash', { index });
      else warnings.push({ code: 'hash-missing', message: '分片还没有 hash（未封版）', index });
    } else if (!HASH_PATTERN.test(hash)) {
      push('segment-hash', '分片 hash 形状不合法：' + hash, { index });
    }
    previous = { offset: intOr(segment.offset, 0), height: Math.max(0, intOr(segment.height, 0)) };
  }
  if (manifest.sealed === true) {
    if (total > 0 && segments.length !== total) {
      push('sealed-incomplete', 'sealed manifest 分片数 ' + segments.length + ' 不等于 total ' + total);
    }
    if (total > 0) {
      for (let index = 0; index < total; index += 1) {
        if (!seen.has(index)) push('sealed-missing', 'sealed manifest 缺少分片 ' + index, { index });
      }
    }
  }
  if (options.requireSealed === true && manifest.sealed !== true) push('not-sealed', 'manifest 还没有封版');
  return { ok: errors.length === 0, errors, warnings };
}

/** 计划中的 total 段里还缺哪些序号（0..total-1）。 */
export function missingSegmentIndexes(manifest) {
  const total = Math.max(0, intOr(manifest && manifest.total, 0));
  const present = new Set(
    (manifest && Array.isArray(manifest.segments) ? manifest.segments : []).map((segment) => intOr(segment.index, -1)),
  );
  const missing = [];
  for (let index = 0; index < total; index += 1) {
    if (!present.has(index)) missing.push(index);
  }
  return missing;
}

/**
 * 校验一个已落盘分片与 manifest 记录是否一致。
 * @returns {{ok: boolean, verified: boolean, reason: string|null, expected: object, actual: object}}
 */
export function verifyLongshotSegment(expected, actual) {
  const wanted = expected && typeof expected === 'object' ? expected : {};
  const got = actual && typeof actual === 'object' ? actual : null;
  const expectedHash = normalizeHash(wanted.hash);
  if (!got) {
    return {
      ok: false,
      verified: false,
      reason: 'missing',
      expected: { index: intOr(wanted.index, -1), bytes: intOr(wanted.bytes, 0), hash: expectedHash },
      actual: null,
    };
  }
  const actualHash = normalizeHash(got.hash);
  const expectedBytes = intOr(wanted.bytes, 0);
  const actualBytes = intOr(got.bytes, 0);
  if (intOr(got.index, -1) !== intOr(wanted.index, -1)) {
    return { ok: false, verified: false, reason: 'index-mismatch', expected: { index: intOr(wanted.index, -1) }, actual: { index: intOr(got.index, -1) } };
  }
  if (!expectedHash) {
    return {
      ok: true,
      verified: false,
      reason: 'hash-unrecorded',
      expected: { index: intOr(wanted.index, -1), bytes: expectedBytes, hash: '' },
      actual: { index: intOr(got.index, -1), bytes: actualBytes, hash: actualHash },
    };
  }
  if (expectedBytes > 0 && actualBytes > 0 && expectedBytes !== actualBytes) {
    return {
      ok: false,
      verified: false,
      reason: 'bytes-mismatch',
      expected: { index: intOr(wanted.index, -1), bytes: expectedBytes, hash: expectedHash },
      actual: { index: intOr(got.index, -1), bytes: actualBytes, hash: actualHash },
    };
  }
  if (actualHash !== expectedHash) {
    return {
      ok: false,
      verified: false,
      reason: 'hash-mismatch',
      expected: { index: intOr(wanted.index, -1), bytes: expectedBytes, hash: expectedHash },
      actual: { index: intOr(got.index, -1), bytes: actualBytes, hash: actualHash },
    };
  }
  return {
    ok: true,
    verified: true,
    reason: null,
    expected: { index: intOr(wanted.index, -1), bytes: expectedBytes, hash: expectedHash },
    actual: { index: intOr(got.index, -1), bytes: actualBytes, hash: actualHash },
  };
}

/**
 * 断点恢复计划：把 manifest（该拍多少段/hash）与磁盘上实际存在的分片记录对比。
 *
 * @param {object|null} manifest
 * @param {{available?: Array<{index:number,bytes?:number,hash?:string}>, now?: number, ttlMs?: number}} [options]
 * @returns {object} 恢复计划；manifest 为 null 时返回 {ok:false, reason:'no-manifest'}
 */
export function resumeLongshotManifest(manifest, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const ttlMs = Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0
    ? Number(options.ttlMs)
    : LONGSHOT_MANIFEST_TTL_MS;
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reason: 'no-manifest', captureId: null, resumable: false, action: 'none', reuse: [], refetch: [], missing: [] };
  }
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'invalid-manifest',
      captureId: manifest.captureId || null,
      resumable: false,
      action: 'none',
      reuse: [],
      refetch: [],
      missing: [],
      errors: validation.errors,
    };
  }
  const createdAtMs = Date.parse(manifest.createdAt);
  const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, now - createdAtMs) : 0;
  const expired = ageMs > ttlMs && manifest.sealed !== true;
  const available = new Map();
  for (const item of Array.isArray(options.available) ? options.available : []) {
    if (!item || typeof item !== 'object') continue;
    const index = intOr(item.index, -1);
    if (index >= 0) available.set(index, item);
  }
  const reuse = [];
  const refetch = [];
  const orphan = [];
  for (const segment of manifest.segments) {
    const record = available.get(segment.index);
    if (!record) {
      refetch.push({ ...normalizeSegment(segment, segment.index), reason: 'missing' });
      continue;
    }
    const check = verifyLongshotSegment(segment, record);
    if (check.ok) {
      reuse.push({ ...normalizeSegment(segment, segment.index), verified: check.verified });
    } else {
      refetch.push({ ...normalizeSegment(segment, segment.index), reason: check.reason, expected: check.expected, actual: check.actual });
    }
  }
  const missing = missingSegmentIndexes(manifest);
  for (const index of missing) {
    refetch.push({ index, offset: 0, bytes: 0, hash: '', width: manifest.width, height: 0, reason: 'missing' });
  }
  refetch.sort((a, b) => a.index - b.index);
  for (const index of available.keys()) {
    if (!manifest.segments.some((segment) => segment.index === index)) orphan.push(index);
  }
  const sealed = manifest.sealed === true;
  const action = sealed ? 'sealed' : (expired ? 'expired' : (missing.length || refetch.length ? 'refetch' : 'reuse'));
  return {
    ok: true,
    captureId: manifest.captureId,
    version: manifest.version,
    sealed,
    dpr: manifest.dpr,
    width: manifest.width,
    height: manifest.height,
    total: manifest.total,
    captured: manifest.segments.length,
    missing,
    expired,
    ageMs,
    action,
    resumable: !sealed && !expired && refetch.length === 0 && missing.length === 0,
    complete: sealed || (missing.length === 0 && refetch.length === 0),
    nextIndex: missing.length ? missing[0] : (refetch.length ? refetch[0].index : manifest.total),
    reuse,
    refetch,
    orphan: orphan.sort((a, b) => a - b),
    evidence: { now, ttlMs, checked: manifest.segments.length, available: available.size },
  };
}

/**
 * 清理过期/超量的 manifest。
 * @returns {{kept: object[], pruned: Array<{captureId: string, reason: string, ageMs: number}>, removedCount: number}}
 */
export function pruneLongshotManifests(list, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const ttlMs = Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0
    ? Number(options.ttlMs)
    : LONGSHOT_MANIFEST_TTL_MS;
  const sealedTtlMs = Number.isFinite(Number(options.sealedTtlMs)) && Number(options.sealedTtlMs) > 0
    ? Number(options.sealedTtlMs)
    : ttlMs;
  const max = Number.isFinite(Number(options.max)) && Number(options.max) > 0
    ? Math.max(1, Math.round(Number(options.max)))
    : LONGSHOT_MANIFEST_MAX;
  const keep = new Set((Array.isArray(options.keep) ? options.keep : []).map((id) => String(id)));
  const kept = [];
  const pruned = [];
  for (const manifest of Array.isArray(list) ? list : []) {
    if (!manifest || typeof manifest !== 'object' || !manifest.captureId) continue;
    const captureId = String(manifest.captureId);
    if (keep.has(captureId)) {
      kept.push(manifest);
      continue;
    }
    const createdAtMs = Date.parse(manifest.createdAt);
    const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, now - createdAtMs) : ttlMs + 1;
    const limit = manifest.sealed === true ? sealedTtlMs : ttlMs;
    if (ageMs > limit) {
      pruned.push({ captureId, reason: manifest.sealed === true ? 'expired-sealed' : 'expired-unsealed', ageMs });
      continue;
    }
    kept.push(manifest);
  }
  kept.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  const overflow = kept.length > max ? kept.slice(max) : [];
  for (const manifest of overflow) {
    pruned.push({ captureId: String(manifest.captureId), reason: 'max', ageMs: Math.max(0, now - (Date.parse(manifest.createdAt) || now)) });
  }
  const keptFinal = kept.slice(0, max);
  return { kept: keptFinal, pruned, removedCount: pruned.length };
}

/** 解析（对象或 JSON 字符串）并校验 manifest。 */
export function parseLongshotManifest(input) {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      return { ok: false, manifest: null, errors: [{ code: 'json', message: 'manifest 不是合法 JSON：' + (error && error.message) }], warnings: [] };
    }
  }
  const validation = validateManifest(value);
  return { ok: validation.ok, manifest: validation.ok ? value : null, errors: validation.errors, warnings: validation.warnings };
}

/** 协议/日志用的紧凑摘要（不含大字段；manifest 本身只存 hash/尺寸）。 */
export function manifestSummary(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const segments = Array.isArray(manifest.segments) ? manifest.segments : [];
  // 第十一批-E：只读派生证据（任一子分析失败也不影响既有摘要字段）。
  let frames = null;
  let storage = null;
  try {
    frames = reconcileManifestFrames(manifest);
  } catch {
    frames = null;
  }
  try {
    const compression = planLongshotCompression(segments.map((segment) => ({
      index: segment && segment.index,
      width: segment && segment.width,
      height: segment && segment.height,
      bytes: segment && segment.bytes,
      hash: segment && segment.hash,
      pageY: segment && segment.offset,
    })), { dpr: manifest.dpr });
    storage = compressionWire(compression);
  } catch {
    storage = null;
  }
  return {
    version: manifest.version,
    captureId: manifest.captureId,
    tabId: manifest.tabId == null ? null : Number(manifest.tabId),
    dpr: manifest.dpr,
    width: manifest.width,
    height: manifest.height,
    total: manifest.total,
    captured: segments.length,
    sealed: manifest.sealed === true,
    bytes: segments.reduce((sum, segment) => sum + Math.max(0, intOr(segment && segment.bytes, 0)), 0),
    hashCount: segments.filter((segment) => normalizeHash(segment && segment.hash)).length,
    createdAt: manifest.createdAt,
    sealedAt: manifest.sealedAt || null,
    updatedAt: manifest.updatedAt || manifest.createdAt,
    frames,
    storage,
  };
}

/** 一行日志：'longshot abc: 2/2 段 sealed dpr=1.5 1241x45000 1.2MB'。 */
export function describeManifest(manifest) {
  const summary = manifestSummary(manifest);
  if (!summary) return '无 manifest';
  return 'longshot ' + summary.captureId + ': ' + summary.captured + '/' + summary.total + ' 段' +
    (summary.sealed ? ' sealed' : ' unsealed') +
    ' dpr=' + summary.dpr + ' ' + summary.width + 'x' + summary.height +
    ' ' + (summary.bytes / 1024).toFixed(1) + 'KB';
}
