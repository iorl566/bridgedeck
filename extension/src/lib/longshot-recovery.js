// lib/longshot-recovery.js —— 崩溃恢复的分片规划/校验（纯函数；复用 longshot-recover 的语义）。
//
// longshot-recover 原本的语义：把 IndexedDB tile 按 index 排序、按 (x, drawY) 画回一张画布，
// 用“index 是否等于排序位置”判断 gaps。这条语义必须保留（0.3.0 的 E2E 依赖它），但缺三样东西：
//   * 没有 manifest 时无法知道“本来该有几段”，只能报告缺口位置，无法给出下一步（重取哪一段）；
//   * 有 manifest 时没有把“磁盘分片 ↔ 索引 hash”对上，恢复可能悄悄用错图；
//   * 恢复结束没有显式状态语义（长期只有 result.complete 一个布尔）。
//
// 本模块在“不重造渲染”的前提下补齐规划层：
//   normalizeRecoveryTiles()      —— 排序/去重/丢弃非法 tile（保留旧排序语义）；
//   planLongshotRecovery()        —— 生成 rebuild 计划（present/missing/gaps/宽高/action）；
//   applyRecoveryVerification()   —— 用 manifest hash 校验已落盘分片，产出 refetch 列表；
//   buildRecoveryResult()         —— 组装与旧 longshot.recover 兼容的结果 + recovered/sealed/manifest 证据。
//
// 渲染（OffscreenCanvas/createImageBitmap）仍留在 longshot-recover.js；这里只做可单测的纯逻辑。

import { manifestSummary, missingSegmentIndexes, verifyLongshotSegment } from './longshot-manifest.js';
// 第十一批-E：恢复结果只加字段地接四块证据（帧级对账 / 重绘 / 分片恢复强化 / 存储压缩预算）。
import { reconcileLongshotFrames, longshotFrameWire, planFrameRepairs } from './longshot-frame-reconcile.js';
import { planLongshotRepaint, repaintWire } from './longshot-repaint.js';
import { planShardRecovery, shardRecoveryWire } from './longshot-shard-recover.js';
import { planLongshotCompression, compressionWire } from './longshot-compress.js';

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

/**
 * 规整 tile 列表：丢弃非法记录、按 index 去重（保留后写入/更大 at 的版本）、按 index 排序。
 * @returns {{tiles: object[], invalid: Array<object>, duplicates: number[], reordered: boolean}}
 */
export function normalizeRecoveryTiles(tiles) {
  const list = Array.isArray(tiles) ? tiles : [];
  const invalid = [];
  const duplicates = [];
  const byIndex = new Map();
  let reordered = false;
  let lastIndex = -Infinity;
  for (let position = 0; position < list.length; position += 1) {
    const raw = list[position];
    const tile = raw && typeof raw === 'object' ? raw : null;
    if (!tile) {
      invalid.push({ position, reason: 'not-object' });
      continue;
    }
    const index = Number(tile.index);
    if (!Number.isInteger(index) || index < 0) {
      invalid.push({ position, index: tile.index, reason: 'bad-index' });
      continue;
    }
    const width = Number(tile.width);
    const height = Number(tile.height);
    if (!(width > 0) || !(height > 0)) {
      invalid.push({ position, index, reason: 'bad-size' });
      continue;
    }
    const bytes = Math.max(0, intOr(tile.bytes, tile.blob && Number(tile.blob.size) ? Number(tile.blob.size) : 0));
    if (!tile.blob && bytes <= 0) {
      invalid.push({ position, index, reason: 'no-bytes' });
      continue;
    }
    const normalized = {
      index,
      x: Math.max(0, intOr(tile.x, 0)),
      y: Math.max(0, intOr(tile.y, 0)),
      drawY: Math.max(0, intOr(tile.drawY != null ? tile.drawY : tile.y, 0)),
      width: Math.round(width),
      height: Math.round(height),
      bytes,
      hash: String(tile.hash == null ? '' : tile.hash).toLowerCase(),
      at: Math.max(0, intOr(tile.at, 0)),
      blob: tile.blob || null,
    };
    if (index < lastIndex) reordered = true;
    lastIndex = Math.max(lastIndex, index);
    const previous = byIndex.get(index);
    if (previous) {
      duplicates.push(index);
      if (normalized.at >= previous.at) byIndex.set(index, normalized);
    } else {
      byIndex.set(index, normalized);
    }
  }
  const ordered = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return { tiles: ordered, invalid, duplicates, reordered };
}

/** 旧语义：tile 的 index 必须等于排序后的位置，否则把该位置记为 gap。 */
function legacyGaps(indexes) {
  const gaps = [];
  for (let position = 0; position < indexes.length; position += 1) {
    if (indexes[position] !== position) gaps.push(position);
  }
  return gaps;
}

/**
 * 规划一次崩溃恢复（只读：不渲染、不写 IDB）。
 *
 * @param {{manifest?: object|null, tiles?: object[], now?: number}} [options]
 * @returns {object} plan；没有任何可恢复 tile 时返回 {ok:false, code:'E_NOT_FOUND'}。
 */
export function planLongshotRecovery(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const manifest = options.manifest && typeof options.manifest === 'object' && !Array.isArray(options.manifest)
    ? options.manifest
    : null;
  const normalized = normalizeRecoveryTiles(options.tiles);
  const ordered = normalized.tiles;
  if (!ordered.length) {
    return {
      ok: false,
      code: 'E_NOT_FOUND',
      error: '没有可恢复的长截图分块',
      captureId: manifest ? manifest.captureId || null : null,
      manifest,
      tiles: 0,
      invalid: normalized.invalid,
      duplicates: normalized.duplicates,
      gaps: [],
      present: [],
      missing: [],
      segments: [],
      complete: false,
      sealed: false,
      recovered: false,
      action: 'nothing',
      width: 0,
      height: 0,
    };
  }
  const present = ordered.map((tile) => tile.index);
  const gaps = legacyGaps(present);
  const sealed = manifest ? manifest.sealed === true : false;
  const missing = manifest ? missingSegmentIndexes(manifest) : gaps.slice();
  const width = Math.max(...ordered.map((tile) => Number(tile.x || 0) + Number(tile.width || 0)));
  const height = Math.max(...ordered.map((tile) => Number(tile.drawY || 0) + Number(tile.height || 0)));
  const complete = gaps.length === 0 && (manifest ? missing.length === 0 : true);
  const action = sealed ? 'already-sealed' : (complete ? 'rebuild' : 'rebuild-partial');
  const segments = ordered.map((tile) => ({
    index: tile.index,
    offset: tile.drawY,
    x: tile.x,
    y: tile.y,
    width: tile.width,
    height: tile.height,
    bytes: tile.bytes,
    hash: tile.hash,
    verified: null,
    refetchReason: null,
  }));
  const nextIndex = missing.length ? missing[0] : (gaps.length ? gaps[0] : ordered[ordered.length - 1].index + 1);
  return {
    ok: true,
    captureId: manifest ? manifest.captureId || null : null,
    manifest,
    manifestSummary: manifest ? manifestSummary(manifest) : null,
    tiles: ordered.length,
    present,
    missing,
    gaps,
    duplicates: normalized.duplicates,
    invalid: normalized.invalid,
    reordered: normalized.reordered,
    width: Math.max(1, width),
    height: Math.max(1, height),
    sealed,
    complete,
    recovered: !sealed,
    action,
    hashVerified: null,
    refetch: [],
    checked: 0,
    nextIndex,
    segments,
    evidence: {
      now,
      tiles: ordered.length,
      manifest: Boolean(manifest),
      manifestSealed: sealed,
      gaps: gaps.length,
      missing: missing.length,
      duplicates: normalized.duplicates.length,
      invalid: normalized.invalid.length,
    },
  };
}

/**
 * 用 manifest 的 hash 校验已恢复的分片；不一致的分片进入 refetch 列表（调用方决定重取/降级）。
 * @returns {{plan: object, verification: {checked: number, hashVerified: boolean|null, mismatched: Array<object>, refetch: Array<object>, reason: string|null}}}
 */
export function applyRecoveryVerification(plan, options = {}) {
  if (!plan || plan.ok !== true) {
    return {
      plan,
      verification: { checked: 0, hashVerified: null, mismatched: [], refetch: [], reason: 'no-plan' },
    };
  }
  const manifest = options.manifest && typeof options.manifest === 'object' ? options.manifest : plan.manifest;
  const tiles = Array.isArray(options.tiles) ? options.tiles : null;
  if (!manifest || !Array.isArray(manifest.segments) || !manifest.segments.length) {
    return {
      plan,
      verification: { checked: 0, hashVerified: null, mismatched: [], refetch: [], reason: 'no-manifest' },
    };
  }
  const tileByIndex = new Map();
  for (const tile of tiles || []) {
    if (!tile || typeof tile !== 'object') continue;
    const index = intOr(tile.index, -1);
    if (index >= 0) tileByIndex.set(index, tile);
  }
  const expectedByIndex = new Map();
  for (const segment of manifest.segments) {
    const index = intOr(segment && segment.index, -1);
    if (index >= 0) expectedByIndex.set(index, segment);
  }
  const mismatched = [];
  const refetch = [];
  const segments = plan.segments.map((segment) => {
    const expected = expectedByIndex.get(segment.index);
    if (!expected) {
      return { ...segment, verified: null, refetchReason: 'not-in-manifest' };
    }
    const actual = tileByIndex.get(segment.index) || { index: segment.index, bytes: segment.bytes, hash: segment.hash };
    const check = verifyLongshotSegment(expected, actual);
    if (check.ok) {
      return { ...segment, verified: check.verified === true, refetchReason: null };
    }
    mismatched.push({ index: segment.index, reason: check.reason, expected: check.expected, actual: check.actual });
    refetch.push({
      index: segment.index,
      offset: intOr(expected.offset, segment.offset),
      width: intOr(expected.width, segment.width),
      height: intOr(expected.height, segment.height),
      reason: check.reason,
    });
    return { ...segment, verified: false, refetchReason: check.reason };
  });
  // manifest 记录过、但磁盘分片已不存在的段：也进 refetch（否则恢复会少画一段却不报）。
  const presentIndexes = new Set(plan.segments.map((segment) => segment.index));
  for (const [index, expected] of expectedByIndex) {
    if (presentIndexes.has(index)) continue;
    refetch.push({
      index,
      offset: intOr(expected.offset, 0),
      width: intOr(expected.width, plan.width),
      height: intOr(expected.height, 0),
      reason: 'missing',
    });
  }
  // missing 段本来就没有 tile：也进 refetch，方便调用方一次性补齐。
  for (const index of plan.missing) {
    if (refetch.some((item) => item.index === index)) continue;
    const expected = expectedByIndex.get(index);
    refetch.push({
      index,
      offset: expected ? intOr(expected.offset, 0) : 0,
      width: expected ? intOr(expected.width, plan.width) : plan.width,
      height: expected ? intOr(expected.height, 0) : 0,
      reason: 'missing',
    });
  }
  refetch.sort((a, b) => a.index - b.index);
  const checked = segments.filter((segment) => segment.verified !== null).length;
  const hashVerified = checked > 0 && mismatched.length === 0;
  const complete = plan.complete && mismatched.length === 0;
  const updated = {
    ...plan,
    segments,
    checked,
    hashVerified,
    refetch,
    complete,
    action: plan.sealed ? 'already-sealed' : (complete ? 'rebuild' : 'rebuild-partial'),
    evidence: { ...plan.evidence, checked, mismatched: mismatched.length, refetch: refetch.length, hashVerified },
  };
  return {
    plan: updated,
    verification: { checked, hashVerified, mismatched, refetch, reason: hashVerified ? null : 'mismatch' },
  };
}

/**
 * 组装 longshot.recover 的结果：保留 0.3.0 的字段（ok/longshotId/width/height/tiles/gaps/
 * complete/bytes/dataUrl），新增 recovered/sealed/manifest/recovery 证据。
 * 第十一批-E：recovery 里再加 frames / repaint / shard_recovery / storage 四块（只加字段）。
 */
export function buildRecoveryResult(options = {}) {
  const plan = options.plan && typeof options.plan === 'object' ? options.plan : null;
  const captureId = String(options.captureId || (plan && plan.captureId) || '');
  const complete = Boolean(plan && plan.complete && plan.hashVerified !== false);
  // 只读派生证据：任何一个子分析失败都给 null，不影响既有恢复结果。
  const derived = recoveryDerivedEvidence(plan, options);
  return {
    ok: true,
    longshotId: captureId,
    width: Math.max(1, intOr(options.width, plan ? plan.width : 1)),
    height: Math.max(1, intOr(options.height, plan ? plan.height : 1)),
    tiles: plan ? plan.tiles : 0,
    gaps: Array.isArray(options.gaps) ? options.gaps : (plan ? plan.gaps : []),
    complete,
    recovered: plan ? plan.recovered === true : false,
    sealed: plan ? plan.sealed === true : false,
    manifest: plan && plan.manifest ? manifestSummary(plan.manifest) : null,
    recovery: plan
      ? {
        action: plan.action,
        present: plan.present || [],
        missing: plan.missing || [],
        duplicates: plan.duplicates || [],
        invalid: plan.invalid || [],
        checked: plan.checked || 0,
        hashVerified: plan.hashVerified,
        refetch: plan.refetch || [],
        nextIndex: plan.nextIndex,
        frames: derived.frames,
        repaint: derived.repaint,
        shard_recovery: derived.shard,
        storage: derived.storage,
      }
      : null,
    bytes: Math.max(0, intOr(options.bytes, 0)),
    dataUrl: typeof options.dataUrl === 'string' ? options.dataUrl : '',
  };
}

/** 恢复结果的派生证据（纯函数；失败只返回 null 字段，不抛）。 */
function recoveryDerivedEvidence(plan, options) {
  const result = { frames: null, repaint: null, shard: null, storage: null };
  try {
    const segments = plan && Array.isArray(plan.segments) ? plan.segments : [];
    const tiles = segments.map((segment) => ({
      index: segment.index,
      drawY: segment.offset,
      pageY: segment.offset,
      height: segment.height,
      drawHeight: segment.height,
      width: segment.width,
      bytes: segment.bytes,
      hash: segment.hash,
    }));
    const manifest = plan && plan.manifest && Array.isArray(plan.manifest.segments) ? plan.manifest : null;
    const expected = manifest
      ? manifest.segments.map((segment) => ({
        index: segment.index,
        pageY: segment.offset,
        pageHeight: segment.height,
        drawY: segment.offset,
        drawHeight: segment.height,
        width: segment.width,
        bytes: segment.bytes,
        hash: segment.hash,
        role: 'middle',
      }))
      : null;
    // manifest 只记了已落盘的段：缺号段（plan.missing）也要进“期望帧”，否则帧对账发现不了缺口。
    if (expected) {
      for (const index of Array.isArray(plan.missing) ? plan.missing : []) {
        if (expected.some((frame) => frame.index === index)) continue;
        expected.push({
          index,
          pageY: 0,
          pageHeight: 1,
          drawY: 0,
          drawHeight: 1,
          width: plan.width,
          bytes: 0,
          hash: '',
          role: 'middle',
        });
      }
    }
    const report = reconcileLongshotFrames({
      expected: expected || undefined,
      tiles,
      width: plan ? plan.width : 0,
      totalHeight: plan ? plan.height : 0,
      dpr: manifest && Number(manifest.dpr) > 0 ? Number(manifest.dpr) : 1,
    });
    result.frames = longshotFrameWire(report);
    const repairs = planFrameRepairs(report);
    const repaint = planLongshotRepaint({ repairs }, {
      width: plan ? plan.width : 0,
      dpr: manifest && Number(manifest.dpr) > 0 ? Number(manifest.dpr) : 1,
    });
    result.repaint = repaintWire(repaint);
    const shardPlan = planShardRecovery({ manifest, tiles, now: options.now });
    result.shard = shardRecoveryWire(shardPlan);
    const compression = planLongshotCompression(segments.map((segment) => ({
      index: segment.index,
      width: segment.width,
      height: segment.height,
      bytes: segment.bytes,
      hash: segment.hash,
      pageY: segment.offset,
    })), { dpr: manifest && manifest.dpr });
    result.storage = compressionWire(compression);
  } catch {
    // 证据增强失败：保持四块为 null，恢复结果本身不受影响。
  }
  return result;
}

/** 一行日志：'恢复 longshot abc：12 块 / gaps=0 / sealed=false / hash=ok'。 */
export function describeRecovery(plan) {
  if (!plan) return '无恢复计划';
  if (plan.ok !== true) return '不可恢复：' + (plan.error || plan.code || 'unknown');
  return '恢复 ' + (plan.captureId || '?') + '：' + plan.tiles + ' 块 / gaps=' + plan.gaps.length +
    ' / sealed=' + plan.sealed + ' / ' + plan.action +
    (plan.hashVerified === true ? ' / hash=ok' : (plan.hashVerified === false ? ' / hash=mismatch' : ' / hash=未校验'));
}
