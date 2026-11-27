// lib/longshot-shard.js —— 长截图分段 manifest 的“分片（shard）分层”与 index.json 等价物（纯函数）。
//
// 现状：lib/longshot-manifest.js 已经把整次 capture 的 segments 记成一份 manifest，但大页面
// （40 段以上、几百 MB）有两个现实问题：
//   1) 单个 manifest 记录越写越大，每次 appendSegment 都要整份重写（IndexedDB put 整块）；
//      真正需要“分片落盘 + 分片校验”的兼容目标是磁盘上多个 index 分片 + 根索引；
//   2) 恢复时没必要把所有段的 hash 都读出来校验：按 shard 校验能只重取坏掉的那一片，
//      并且能给出“哪一片决定了整张图不可恢复”的证据。
//
// 本模块在既有 manifest 之上做**派生**（不改 manifest 结构、不新增 object store）：
//   planShards()       —— 把 manifest.segments 按“段数上限/字节上限”切成 shard，每片带链式 digest；
//   shardDigest()      —— 单片的确定性摘要（复用 longshot-manifest 的 FNV/djb2 双 32 位 hash）；
//   validateShards()   —— 分片结构/覆盖/摘要自检（缺片、重叠、越界、摘要不符）；
//   mergeShards()      —— 把分片还原成有序 segments（恢复路径用）；
//   locateShard()      —— 段序号 → 分片（stale 重写时只重写一片）；
//   missingShardSegments() —— 期望序号 vs 已有片段的缺口；
//   shardIndexWire()   —— index.json 等价物（根索引 + 分片索引），可序列化；
//   parseShardIndex()  —— 反解 + 校验；
//   pruneShaderPlan()  —— 按数量/字节保留最新分片（清理用）；
//   describeShards()/shardSignature()。
//
// 约定：shard 是 manifest 的**只读视图**，任何函数都不修改传入的 manifest/segments。

import { hashLongshotBytes, LONGSHOT_MANIFEST_VERSION } from './longshot-manifest.js';

export const SHARD_VERSION = 1;

export const SHARD_DEFAULTS = Object.freeze({
  // 每片最多段数：16 段 × 512px tile 已经是很大的索引块，再大不利于局部重取。
  maxSegmentsPerShard: 16,
  // 每片字节上限（默认 32MB，和 video 分片预算同一量级）。
  maxBytesPerShard: 32 * 1024 * 1024,
  // 分片数量上限（超过就不切了，避免索引比数据还大）。
  maxShards: 64,
  // 单片字节上限下限，防止调用方传 0 导致每段一片。
  minBytesPerShard: 64 * 1024,
});

const SHARD_STATES = Object.freeze(['partial', 'sealed', 'stale']);

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function clampInt(value, min, max, fallback) {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function normalizeHash(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/** manifest.segment → 分片内条目（字段与 manifest 段一致，顺序由 index 决定）。 */
export function normalizeShardSegment(segment, fallbackIndex = 0) {
  const value = segment && typeof segment === 'object' ? segment : {};
  return {
    index: Math.max(0, intOr(value.index, fallbackIndex)),
    offset: Math.max(0, intOr(value.offset != null ? value.offset : (value.drawY != null ? value.drawY : value.y), 0)),
    bytes: Math.max(0, intOr(value.bytes, 0)),
    hash: normalizeHash(value.hash),
    width: Math.max(0, intOr(value.width, 0)),
    height: Math.max(0, intOr(value.height, 0)),
  };
}

function canonicalEntry(entry) {
  return [
    intOr(entry.index, 0),
    intOr(entry.offset, 0),
    intOr(entry.bytes, 0),
    normalizeHash(entry.hash),
    intOr(entry.width, 0),
    intOr(entry.height, 0),
  ].join(':');
}

/** 单片摘要：条目规范化字符串的 FNV/djb2 双 hash（与分片字节 hash 同一实现，便于日志互认）。 */
export function shardDigest(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '';
  return hashLongshotBytes(list.map(canonicalEntry).join(';'));
}

/**
 * 把 manifest 的 segments 切成 shard。
 * 规则：段必须按 index 升序；累计段数或累计字节超上限就收口；单片至少 1 段；
 * 未齐（manifest.total > 已有段数）的 capture 仍然切分，但 shard.complete=false。
 * @returns {{
 *   ok: boolean, version: number, captureId: string, dpr: number, width: number, height: number,
 *   total: number, sealed: boolean, shards: Array<object>, totalBytes: number,
 *   coveredSegments: number, missing: number[], notes: string[],
 * }}
 */
export function planShards(manifest, options = {}) {
  const source = manifest && typeof manifest === 'object' ? manifest : null;
  const maxSegments = clampInt(options.maxSegmentsPerShard, 1, 4096, SHARD_DEFAULTS.maxSegmentsPerShard);
  const maxBytes = Math.max(SHARD_DEFAULTS.minBytesPerShard, intOr(options.maxBytesPerShard, SHARD_DEFAULTS.maxBytesPerShard));
  const maxShards = clampInt(options.maxShards, 1, 4096, SHARD_DEFAULTS.maxShards);
  const notes = [];
  if (!source) {
    return {
      ok: false, version: SHARD_VERSION, captureId: '', dpr: 1, width: 0, height: 0,
      total: 0, sealed: false, shards: [], totalBytes: 0, coveredSegments: 0, missing: [], notes: ['manifest 缺失'],
    };
  }
  const rawSegments = Array.isArray(source.segments) ? source.segments : [];
  const segments = rawSegments
    .map((segment, index) => normalizeShardSegment(segment, index))
    .sort((a, b) => a.index - b.index);
  const total = Math.max(0, intOr(source.total, segments.length));
  const shards = [];
  let cursor = 0;
  while (cursor < segments.length && shards.length < maxShards) {
    const bucket = [];
    let bytes = 0;
    while (cursor < segments.length && bucket.length < maxSegments) {
      const candidate = segments[cursor];
      // 字节上限：已经至少 1 段才允许因字节收口，避免超大片永远是单片。
      if (bucket.length > 0 && bytes + candidate.bytes > maxBytes) break;
      bucket.push(candidate);
      bytes += candidate.bytes;
      cursor += 1;
      if (bytes >= maxBytes) break;
    }
    if (!bucket.length) break;
    const from = bucket[0].index;
    const to = bucket[bucket.length - 1].index;
    // 连续性：分片内部序号必须连续，否则说明 manifest 本身缺段，证据写进 shard.contiguous。
    let contiguous = true;
    for (let index = 1; index < bucket.length; index += 1) {
      if (bucket[index].index !== bucket[index - 1].index + 1) {
        contiguous = false;
        break;
      }
    }
    shards.push({
      index: shards.length,
      from,
      to,
      segmentCount: bucket.length,
      bytes,
      digest: shardDigest(bucket),
      state: source.sealed === true ? 'sealed' : 'partial',
      // 片内序号连续、且与上一片首尾相接（首片必须从 0 开始）才算完整；
      // manifest 缺段造成的空洞在这里暴露，而不是等到恢复拼图时才失败。
      complete: contiguous && (shards.length === 0 ? from === 0 : from === shards[shards.length - 1].to + 1),
      contiguous,
      segments: bucket,
    });
  }
  if (cursor < segments.length && shards.length >= maxShards) {
    notes.push('分片数达到上限 ' + maxShards + '，剩余 ' + (segments.length - cursor) + ' 段未入索引');
  }
  const covered = new Set();
  for (const segment of segments) covered.add(segment.index);
  const missing = [];
  for (let index = 0; index < total; index += 1) if (!covered.has(index)) missing.push(index);
  const totalBytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  // “入索引的段数”与“manifest 里的段数”分开记账：分片数上限截断时两者会不等。
  const indexedSegments = shards.reduce((sum, shard) => sum + shard.segmentCount, 0);
  if (shards.length > 1) notes.push(segments.length + ' 段切成 ' + shards.length + ' 片（每片 ≤' + maxSegments + ' 段 / ≤' + maxBytes + ' 字节）');
  if (missing.length) notes.push('缺 ' + missing.length + ' 段：' + missing.slice(0, 8).join(',') + (missing.length > 8 ? '…' : ''));
  return {
    ok: true,
    version: SHARD_VERSION,
    captureId: String(source.captureId || ''),
    manifestVersion: intOr(source.version, LONGSHOT_MANIFEST_VERSION),
    dpr: Number(source.dpr) > 0 ? Number(source.dpr) : 1,
    width: Math.max(0, intOr(source.width, 0)),
    height: Math.max(0, intOr(source.height, 0)),
    total,
    declaredTotal: total,
    sealed: source.sealed === true,
    shards,
    totalBytes,
    coveredSegments: indexedSegments,
    manifestSegments: segments.length,
    missing,
    notes,
  };
}

/**
 * 分片自检：结构/覆盖/摘要/边界。
 * @returns {{ok: boolean, errors: Array<{code: string, message: string, shard?: number}>, sha: string}}
 */
export function validateShards(shards, manifest, options = {}) {
  const list = Array.isArray(shards) ? shards : [];
  const errors = [];
  const push = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  if (!Array.isArray(shards)) {
    return { ok: false, errors: [{ code: 'not-array', message: '分片不是数组' }], sha: '' };
  }
  if (list.length > SHARD_DEFAULTS.maxShards * 4) {
    push('too-many', '分片数 ' + list.length + ' 异常（超过上限 4 倍）');
  }
  const covered = new Set();
  let previousTo = -1;
  let expectedBytes = 0;
  for (let index = 0; index < list.length; index += 1) {
    const shard = list[index];
    if (!shard || typeof shard !== 'object') {
      push('bad-shard', '分片不是对象', { shard: index });
      continue;
    }
    const from = intOr(shard.from, -1);
    const to = intOr(shard.to, -1);
    const segments = Array.isArray(shard.segments) ? shard.segments : [];
    if (from < 0 || to < from) push('bad-range', '分片 ' + index + ' 范围非法：' + from + '..' + to, { shard: index });
    if (to < previousTo) push('order', '分片 ' + index + ' 与上一片重叠/乱序', { shard: index });
    if (from !== previousTo + 1 && previousTo >= 0) {
      push('gap', '分片 ' + index + ' 与上一片之间缺段（' + (previousTo + 1) + '..' + (from - 1) + '）', { shard: index });
    }
    if (segments.length !== intOr(shard.segmentCount, segments.length)) {
      push('count', '分片 ' + index + ' segmentCount 与实际段数不一致', { shard: index });
    }
    for (const raw of segments) {
      const segment = normalizeShardSegment(raw, 0);
      if (covered.has(segment.index)) push('dup-segment', '段 ' + segment.index + ' 出现在多个分片', { shard: index });
      covered.add(segment.index);
    }
    const digest = shardDigest(segments);
    if (shard.digest && shard.digest !== digest) {
      push('digest', '分片 ' + index + ' 摘要不符（' + shard.digest + '≠' + digest + '）', { shard: index });
    }
    expectedBytes += intOr(shard.bytes, 0);
    if (shard.state && !SHARD_STATES.includes(shard.state)) {
      push('state', '分片 ' + index + ' 状态未知：' + shard.state, { shard: index });
    }
    previousTo = Math.max(previousTo, to);
  }
  const total = manifest ? Math.max(0, intOr(manifest.total, 0)) : (options.total != null ? Math.max(0, intOr(options.total, 0)) : covered.size);
  const missing = [];
  for (let index = 0; index < total; index += 1) if (!covered.has(index)) missing.push(index);
  if (missing.length && manifest && manifest.sealed === true) {
    push('missing', '已封版 manifest 但分片缺段：' + missing.slice(0, 8).join(','), { missing });
  }
  return {
    ok: errors.length === 0,
    errors,
    missing,
    covered: covered.size,
    bytes: expectedBytes,
    sha: hashLongshotBytes(list.map((shard) => String(shard && shard.digest || '')).join('|')),
  };
}

/** 还原：把分片按 index 合并成有序 segments（重复段以先出现者为准，并给出重复证据）。 */
export function mergeShards(shards) {
  const list = Array.isArray(shards) ? shards : [];
  const byIndex = new Map();
  const duplicates = [];
  for (const shard of list) {
    for (const raw of Array.isArray(shard && shard.segments) ? shard.segments : []) {
      const segment = normalizeShardSegment(raw, 0);
      if (byIndex.has(segment.index)) {
        duplicates.push(segment.index);
        continue;
      }
      byIndex.set(segment.index, segment);
    }
  }
  const segments = [...byIndex.values()].sort((a, b) => a.index - b.index);
  const bytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  return { ok: segments.length > 0, segments, bytes, duplicates, count: segments.length };
}

/** 段序号 → 分片（stale 重写只需要知道该动哪一片，不用重算全局）。 */
export function locateShard(shards, segmentIndex) {
  const target = intOr(segmentIndex, -1);
  for (const shard of Array.isArray(shards) ? shards : []) {
    if (!shard) continue;
    const from = intOr(shard.from, -1);
    const to = intOr(shard.to, -1);
    if (target >= from && target <= to) return { shard, index: intOr(shard.index, 0), offset: target - from };
  }
  return null;
}

/** 期望序号集合 vs 已有分片覆盖的缺口（恢复/重取用）。 */
export function missingShardSegments(shards, total) {
  const limit = Math.max(0, intOr(total, 0));
  const covered = new Set();
  for (const shard of Array.isArray(shards) ? shards : []) {
    for (const raw of Array.isArray(shard && shard.segments) ? shard.segments : []) {
      const segment = normalizeShardSegment(raw, 0);
      covered.add(segment.index);
    }
  }
  const missing = [];
  for (let index = 0; index < limit; index += 1) if (!covered.has(index)) missing.push(index);
  return missing;
}

/**
 * index.json 等价物：根索引 + 分片索引。
 * 与 0.3.0 的磁盘 index.json 一样只放“能重建整图所必需的信息”，不放 dataURL。
 */
export function shardIndexWire(shardPlan, options = {}) {
  const plan = shardPlan && typeof shardPlan === 'object' ? shardPlan : {};
  const maxShards = clampInt(options.maxShards, 1, 256, 64);
  const shards = (Array.isArray(plan.shards) ? plan.shards : []).slice(0, maxShards).map((shard) => ({
    index: intOr(shard.index, 0),
    from: intOr(shard.from, 0),
    to: intOr(shard.to, 0),
    segments: intOr(shard.segmentCount, 0),
    bytes: intOr(shard.bytes, 0),
    digest: String(shard.digest || ''),
    state: shard.state || (plan.sealed ? 'sealed' : 'partial'),
    offset: intOr(shard.offset, (Array.isArray(shard.segments) && shard.segments[0] && shard.segments[0].offset) || 0),
  }));
  return {
    version: SHARD_VERSION,
    manifestVersion: intOr(plan.manifestVersion, LONGSHOT_MANIFEST_VERSION),
    captureId: String(plan.captureId || ''),
    dpr: Number(plan.dpr) > 0 ? Number(plan.dpr) : 1,
    width: Math.max(0, intOr(plan.width, 0)),
    height: Math.max(0, intOr(plan.height, 0)),
    total: Math.max(0, intOr(plan.total, 0)),
    sealed: plan.sealed === true,
    shardCount: shards.length,
    totalBytes: Math.max(0, intOr(plan.totalBytes, 0)),
    covered: Math.max(0, intOr(plan.coveredSegments, 0)),
    missing: (Array.isArray(plan.missing) ? plan.missing : []).slice(0, 32),
    indexSha: hashLongshotBytes(shards.map((shard) => shard.digest).join('|')),
    shards,
  };
}

/** 反解 shardIndexWire()：结构校验 + 摘要校验。 */
export function parseShardIndex(raw, options = {}) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { ok: false, index: null, errors: [{ code: 'json', message: 'index.json 不是合法 JSON：' + ((error && error.message) || error) }] };
    }
  }
  const errors = [];
  if (!value || typeof value !== 'object') {
    return { ok: false, index: null, errors: [{ code: 'not-object', message: 'index.json 不是对象' }] };
  }
  if (intOr(value.version, -1) !== SHARD_VERSION) {
    errors.push({ code: 'version', message: '分片索引版本应为 ' + SHARD_VERSION + '，实际 ' + value.version });
  }
  if (!Array.isArray(value.shards)) errors.push({ code: 'shards', message: '分片索引缺少 shards 数组' });
  const shards = Array.isArray(value.shards) ? value.shards : [];
  if (value.shardCount != null && intOr(value.shardCount, -1) !== shards.length) {
    errors.push({ code: 'shard-count', message: 'shardCount 与 shards 长度不一致' });
  }
  const expected = hashLongshotBytes(shards.map((shard) => String(shard && shard.digest || '')).join('|'));
  if (value.indexSha && value.indexSha !== expected) {
    errors.push({ code: 'index-sha', message: '分片索引摘要不符' });
  }
  if (options.requireSealed === true && value.sealed !== true) {
    errors.push({ code: 'unsealed', message: '分片索引未封版' });
  }
  return {
    ok: errors.length === 0,
    index: errors.length === 0 ? { ...value, shards } : null,
    errors,
    expectedSha: expected,
  };
}

/** 清理：按“最大分片数/最大字节”保留尾部（最新）分片，返回保留/丢弃证据。 */
export function pruneShaderPlan(shardPlan, options = {}) {
  const plan = shardPlan && typeof shardPlan === 'object' ? shardPlan : {};
  const maxShards = clampInt(options.maxShards, 1, 4096, SHARD_DEFAULTS.maxShards);
  const maxBytes = Math.max(1, intOr(options.maxBytes, SHARD_DEFAULTS.maxBytesPerShard * SHARD_DEFAULTS.maxShards));
  const shards = Array.isArray(plan.shards) ? plan.shards : [];
  const kept = [];
  const pruned = [];
  let bytes = 0;
  for (let index = shards.length - 1; index >= 0; index -= 1) {
    const shard = shards[index];
    const shardBytes = intOr(shard && shard.bytes, 0);
    if (kept.length >= maxShards || bytes + shardBytes > maxBytes) {
      pruned.push({ index: intOr(shard && shard.index, index), reason: bytes + shardBytes > maxBytes ? 'max-bytes' : 'max-shards' });
      continue;
    }
    kept.unshift(shard);
    bytes += shardBytes;
  }
  return {
    ok: true,
    shards: kept,
    pruned: pruned.reverse(),
    bytes,
    total: intOr(plan.total, 0),
    coveredSegments: kept.reduce((sum, shard) => sum + intOr(shard && shard.segmentCount, 0), 0),
  };
}

/** 一行日志：'分片 3 片 / 40 段 / 120MB / sealed'。 */
export function describeShards(shardPlan) {
  if (!shardPlan || !Array.isArray(shardPlan.shards) || !shardPlan.shards.length) return '分片索引 空';
  const mb = shardPlan.totalBytes > 0 ? (shardPlan.totalBytes / (1024 * 1024)).toFixed(1) + 'MB' : '0MB';
  return '分片 ' + shardPlan.shards.length + ' 片 / ' + intOr(shardPlan.coveredSegments, 0) + ' 段 / ' + mb +
    (shardPlan.sealed ? ' / sealed' : ' / partial') +
    (shardPlan.missing && shardPlan.missing.length ? ' / 缺 ' + shardPlan.missing.length : '');
}

/** 稳定签名：分片边界 + 摘要，不含时间。 */
export function shardSignature(shardPlan) {
  const shards = shardPlan && Array.isArray(shardPlan.shards) ? shardPlan.shards : [];
  if (!shards.length) return 'shards:none';
  return 'shards:' + shards.length + ':' + shards.map((shard) => shard.from + '-' + shard.to + '#' + String(shard.digest || '').slice(0, 8)).join(',');
}

export const SHARD_STATE_LIST = SHARD_STATES;
