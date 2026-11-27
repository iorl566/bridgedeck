// lib/longshot-shard-recover.js —— 长截图分片恢复强化：完整性扫描 → 残片打捞 → 恢复决策（纯函数）。
//
// 第十批-D 的 longshot-shard 只做“把 manifest.segments 分成 shard 视图”，longshot-recovery
// 只回答“tile 列表能否拼回画布”。真崩溃现场更麻烦：
//   * IndexedDB 里可能留下“写了一半”的分片（hash 不匹配、bytes 明显小于 manifest 记录）；
//   * 分片序号可能重复（同一 index 新旧两版并存）、缺口在尾部/中间；
//   * manifest 已封版但磁盘分片不齐（用户清过站点数据），或 manifest 未封版但分片已齐；
//   * 恢复侧不知道该“用现有残片先拼一版”，还是“直接重启采集”。
//
// 本模块把恢复流程拆成三步纯函数：
//   scanShardIntegrity()  —— 逐片判定：ok / hash-mismatch / torn / duplicate / missing / extra / stale；
//   salvageShardIndex()   —— 从残片里挑出“可继续用”的连续前缀与可用集合（不猜缺失内容）；
//   planShardRecovery()   —— 汇总决策：complete / recover-partial / rebuild / restart + 重取清单；
//   shardRecoveryWire()/describeShardRecovery() —— 协议字段与一行日志。
//
// 约束：不读 IDB/chrome.*，只吃 manifest + tiles；hash 比较只做十六进制字符串规范化。

export const SHARD_RECOVERY_VERSION = 1;

export const SHARD_ACTIONS = Object.freeze(['complete', 'recover-partial', 'rebuild', 'restart', 'nothing']);

export const SHARD_CODES = Object.freeze({
  MISSING: 'longshot.shard.missing',
  HASH_MISMATCH: 'longshot.shard.hash-mismatch',
  TORN: 'longshot.shard.torn',
  DUPLICATE: 'longshot.shard.duplicate',
  EXTRA: 'longshot.shard.extra',
  STALE: 'longshot.shard.stale',
  SEALED_MISMATCH: 'longshot.shard.sealed-mismatch',
  INVALID: 'longshot.shard.invalid',
  OK: 'longshot.shard.ok',
});

export const SHARD_SEVERITY = Object.freeze({
  'longshot.shard.missing': 'error',
  'longshot.shard.hash-mismatch': 'error',
  'longshot.shard.torn': 'error',
  'longshot.shard.duplicate': 'warn',
  'longshot.shard.extra': 'info',
  'longshot.shard.stale': 'warn',
  'longshot.shard.sealed-mismatch': 'warn',
  'longshot.shard.invalid': 'error',
  'longshot.shard.ok': 'info',
});

export const SHARD_DEFAULTS = Object.freeze({
  // 分片字节小于 manifest 记录的 60% 视为“写了一半”（torn write）。
  tornRatio: 0.6,
  // hash 缺失时最多容忍多少片（0 表示缺 hash 的片不可用）。
  maxHashless: 0,
  // 分片新鲜期：与 longshot-manifest 的 TTL 同量级，超过则标 stale（仍可用于打捞）。
  staleMs: 30 * 60 * 1000,
  // 恢复时最多打捞多少片（防止超长残片列表撑爆响应）。
  maxSalvage: 4096,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clampInt(value, min, max, fallback) {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function normalizeHash(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return /^[0-9a-f]{8,64}$/.test(text) ? text : '';
}

function segmentIndexMap(manifest) {
  const map = new Map();
  if (!isPlainObject(manifest)) return map;
  for (const segment of Array.isArray(manifest.segments) ? manifest.segments : []) {
    if (!isPlainObject(segment)) continue;
    const index = intOr(segment.index, -1);
    if (index >= 0 && !map.has(index)) map.set(index, segment);
  }
  return map;
}

function tileIndexMap(tiles) {
  const map = new Map();
  const duplicates = new Map();
  if (!Array.isArray(tiles)) return { map, duplicates };
  for (const tile of tiles) {
    if (!isPlainObject(tile)) continue;
    const index = intOr(tile.index, -1);
    if (index < 0) continue;
    if (map.has(index)) {
      duplicates.set(index, (duplicates.get(index) || 0) + 1);
      // 保留 at 更大的一版（新写入优先）。
      const previous = map.get(index);
      if (Number(tile.at || 0) >= Number(previous.at || 0)) map.set(index, tile);
      continue;
    }
    map.set(index, tile);
  }
  return { map, duplicates };
}

function normalizeTile(tile) {
  if (!isPlainObject(tile)) return null;
  const index = intOr(tile.index, -1);
  if (index < 0) return null;
  return {
    index,
    bytes: Math.max(0, intOr(tile.bytes, tile.blob && Number(tile.blob.size) ? Number(tile.blob.size) : 0)),
    hash: normalizeHash(tile.hash),
    width: Math.max(0, intOr(tile.width, 0)),
    height: Math.max(0, intOr(tile.height, 0)),
    drawY: Math.max(0, intOr(tile.drawY != null ? tile.drawY : tile.y, 0)),
    at: Math.max(0, intOr(tile.at, 0)),
    hasBlob: Boolean(tile.blob),
    raw: tile,
  };
}

/**
 * 逐片完整性扫描：manifest（期望）↔ tiles（磁盘）。
 * 返回 findings（有序、可解释）+ 可用/不可用分片索引列表。不抛异常。
 */
export function scanShardIntegrity(manifest, tiles, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const defaults = { ...SHARD_DEFAULTS, ...(isPlainObject(options) ? options : {}) };
  const tornRatio = Math.max(0, Math.min(1, Number(defaults.tornRatio) || SHARD_DEFAULTS.tornRatio));
  const expected = segmentIndexMap(manifest);
  const scanned = tileIndexMap(tiles);
  const findings = [];
  const usable = [];
  const unusable = [];
  // 期望总数只来自 manifest（total 或 segments 的最大 index），不能把磁盘上多出来的旧段算进去。
  const expectedCount = Math.max(
    0,
    intOr(manifest && manifest.total, 0),
    expected.size ? Math.max(...expected.keys()) + 1 : 0,
  );
  const total = expectedCount;
  for (let index = 0; index < total; index += 1) {
    const expectedSegment = expected.get(index) || null;
    const tile = scanned.map.get(index) || null;
    const tileInfo = tile ? normalizeTile(tile) : null;
    if (!tileInfo) {
      findings.push({ code: SHARD_CODES.MISSING, severity: SHARD_SEVERITY[SHARD_CODES.MISSING], index, detail: 'manifest 有这一段，但磁盘没有分片' });
      unusable.push(index);
      continue;
    }
    if (!tileInfo.hasBlob && tileInfo.bytes <= 0) {
      findings.push({ code: SHARD_CODES.INVALID, severity: SHARD_SEVERITY[SHARD_CODES.INVALID], index, detail: '分片既没有 blob 也没有字节数' });
      unusable.push(index);
      continue;
    }
    if (scanned.duplicates.get(index)) {
      findings.push({
        code: SHARD_CODES.DUPLICATE,
        severity: SHARD_SEVERITY[SHARD_CODES.DUPLICATE],
        index,
        count: scanned.duplicates.get(index) + 1,
        detail: '同一 index 存了多份分片（已取较新一版）',
      });
    }
    if (expectedSegment) {
      const expectedBytes = finiteNonNegative(expectedSegment.bytes);
      if (expectedBytes > 0 && tileInfo.bytes > 0 && tileInfo.bytes < expectedBytes * tornRatio) {
        findings.push({
          code: SHARD_CODES.TORN,
          severity: SHARD_SEVERITY[SHARD_CODES.TORN],
          index,
          expectedBytes,
          actualBytes: tileInfo.bytes,
          detail: '分片字节数明显少于 manifest 记录，疑似写了一半',
        });
        unusable.push(index);
        continue;
      }
      const expectedHash = normalizeHash(expectedSegment.hash);
      if (expectedHash) {
        if (!tileInfo.hash) {
          findings.push({ code: SHARD_CODES.INVALID, severity: SHARD_SEVERITY[SHARD_CODES.INVALID], index, detail: 'manifest 记录过 hash，但分片没有 hash，无法校验' });
          unusable.push(index);
          continue;
        }
        if (tileInfo.hash !== expectedHash) {
          findings.push({
            code: SHARD_CODES.HASH_MISMATCH,
            severity: SHARD_SEVERITY[SHARD_CODES.HASH_MISMATCH],
            index,
            expectedHash,
            actualHash: tileInfo.hash,
            detail: '分片内容 hash 与 manifest 不一致',
          });
          unusable.push(index);
          continue;
        }
      }
      const expectedWidth = finiteNonNegative(expectedSegment.width);
      const expectedHeight = finiteNonNegative(expectedSegment.height);
      if ((expectedWidth > 0 && tileInfo.width > 0 && tileInfo.width !== expectedWidth) ||
        (expectedHeight > 0 && tileInfo.height > 0 && tileInfo.height !== expectedHeight)) {
        findings.push({
          code: SHARD_CODES.HASH_MISMATCH,
          severity: SHARD_SEVERITY[SHARD_CODES.HASH_MISMATCH],
          index,
          detail: '分片尺寸与 manifest 记录不一致',
        });
        unusable.push(index);
        continue;
      }
    }
    // 新鲜度：分片写入时间早于 30 分钟且 manifest 已更新过 → stale（可用但提示）。
    const updatedAt = Number(manifest && (manifest.updatedAt ? Date.parse(manifest.updatedAt) : 0)) || 0;
    if (tileInfo.at > 0 && updatedAt > 0 && updatedAt - tileInfo.at > Math.max(1, Number(defaults.staleMs) || SHARD_DEFAULTS.staleMs)) {
      findings.push({ code: SHARD_CODES.STALE, severity: SHARD_SEVERITY[SHARD_CODES.STALE], index, detail: '分片比 manifest 旧，可能是上一轮采集的残留' });
    }
    usable.push(index);
  }
  // 磁盘多出来的分片（manifest 没记）：不阻止恢复，但进 extra 证据。
  for (const [index, tile] of scanned.map) {
    if (index < total) continue;
    const tileInfo = normalizeTile(tile);
    findings.push({
      code: SHARD_CODES.EXTRA,
      severity: SHARD_SEVERITY[SHARD_CODES.EXTRA],
      index,
      bytes: tileInfo ? tileInfo.bytes : 0,
      detail: '磁盘有分段，但 manifest 没有记录（多出来的旧段）',
    });
  }
  const sealed = Boolean(manifest && manifest.sealed === true);
  if (sealed && (findings.some((finding) => finding.code !== SHARD_CODES.STALE && finding.code !== SHARD_CODES.EXTRA && finding.code !== SHARD_CODES.DUPLICATE))) {
    findings.push({ code: SHARD_CODES.SEALED_MISMATCH, severity: SHARD_SEVERITY[SHARD_CODES.SEALED_MISMATCH], index: -1, detail: 'manifest 已封版，但磁盘分片不完整' });
  }
  const counts = { total, usable: usable.length, missing: total - usable.length, findings: findings.length };
  const codes = [...new Set(findings.map((finding) => finding.code))];
  const errors = findings.filter((finding) => finding.severity === 'error' || finding.severity === 'fatal').length;
  return {
    version: SHARD_RECOVERY_VERSION,
    ok: errors === 0,
    total,
    usable: usable.slice(0, Math.max(1, intOr(defaults.maxSalvage, SHARD_DEFAULTS.maxSalvage))),
    unusable,
    findings,
    codes: codes.length ? codes : [SHARD_CODES.OK],
    counts,
    sealed,
    severity: errors > 0 ? 'error' : (findings.length ? 'warn' : 'none'),
    evidence: {
      now,
      total,
      usable: usable.length,
      unusable: unusable.length,
      findings: findings.length,
      sealed,
      codes: codes.length ? codes : [SHARD_CODES.OK],
    },
  };
}

/**
 * 残片打捞：从“可用分片集合”里找最长连续前缀与可用集合。
 * prefix 的语义：从 index 0 开始连续可用的片数（恢复可先拼到 prefix 处）。
 */
export function salvageShardIndex(scan, options = {}) {
  const source = isPlainObject(scan) ? scan : {};
  const total = Math.max(0, intOr(source.total, 0));
  const usable = Array.isArray(source.usable) ? source.usable.map((value) => intOr(value, -1)).filter((value) => value >= 0) : [];
  const usableSet = new Set(usable);
  let prefix = 0;
  while (usableSet.has(prefix)) prefix += 1;
  const missing = [];
  for (let index = 0; index < total; index += 1) {
    if (!usableSet.has(index)) missing.push(index);
  }
  const usableBytes = Array.isArray(options.tiles)
    ? options.tiles.reduce((sum, tile) => (isPlainObject(tile) && usableSet.has(intOr(tile.index, -1)) ? sum + Math.max(0, intOr(tile.bytes, 0)) : sum), 0)
    : Math.max(0, intOr(source.usableBytes, 0));
  return {
    version: SHARD_RECOVERY_VERSION,
    total,
    usable,
    missing,
    prefix,
    complete: missing.length === 0 && total > 0,
    usableCount: usable.length,
    usableBytes,
    coverage: total > 0 ? Number((usable.length / total).toFixed(6)) : 0,
    cursor: missing.length ? missing[0] : total,
    evidence: {
      total,
      usable: usable.length,
      missing: missing.length,
      prefix,
      coverage: total > 0 ? Number((usable.length / total).toFixed(6)) : 0,
    },
  };
}

/**
 * 恢复决策：根据扫描/打捞结果给出动作与重取清单。
 *
 * @param {{manifest?: object|null, tiles?: object[], now?: number, maxListed?: number}} [options]
 * @returns {object} plan（action/scan/salvage/refetch/coverage/evidence/wire 由 shardRecoveryWire 生成）
 */
export function planShardRecovery(input = {}) {
  const options = isPlainObject(input) ? input : {};
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const manifest = isPlainObject(options.manifest) ? options.manifest : null;
  const tiles = Array.isArray(options.tiles) ? options.tiles : [];
  const scan = scanShardIntegrity(manifest, tiles, { ...options, now });
  const salvage = salvageShardIndex(scan, { tiles });
  const expected = segmentIndexMap(manifest);
  const refetch = salvage.missing.map((index) => {
    const segment = expected.get(index) || null;
    return {
      index,
      offset: intOr(segment && segment.offset, 0),
      width: Math.max(0, intOr(segment && segment.width, 0)),
      height: Math.max(0, intOr(segment && segment.height, 0)),
      reason: scan.findings.some((finding) => finding.index === index && finding.code === SHARD_CODES.HASH_MISMATCH)
        ? 'hash-mismatch'
        : (scan.findings.some((finding) => finding.index === index && finding.code === SHARD_CODES.TORN) ? 'torn' : 'missing'),
    };
  });
  const sealed = Boolean(manifest && manifest.sealed === true);
  let action = 'nothing';
  if (!manifest && !tiles.length) action = 'nothing';
  else if (salvage.complete) action = 'complete';
  else if (salvage.usableCount > 0) action = sealed ? 'rebuild' : 'recover-partial';
  else action = 'restart';
  const reasons = [];
  if (action === 'complete') reasons.push('分片完整');
  if (action === 'recover-partial') reasons.push('可用残片不足，先恢复可用部分');
  if (action === 'rebuild') reasons.push('manifest 已封版但分片不齐，需要重建输出');
  if (action === 'restart') reasons.push('没有可用分片，需要重启采集');
  if (scan.findings.some((finding) => finding.code === SHARD_CODES.TORN)) reasons.push('检测到半写分片');
  if (scan.findings.some((finding) => finding.code === SHARD_CODES.SEALED_MISMATCH)) reasons.push('封版状态与磁盘不一致');
  const maxListed = clampInt(options.maxListed, 1, 64, 16);
  return {
    version: SHARD_RECOVERY_VERSION,
    action,
    ok: action === 'complete' || action === 'recover-partial' || action === 'rebuild',
    now,
    captureId: manifest ? String(manifest.captureId || '') : '',
    sealed,
    total: scan.total,
    scan,
    salvage,
    refetch,
    coverage: salvage.coverage,
    prefix: salvage.prefix,
    cursor: salvage.cursor,
    reasons,
    listed: {
      findings: scan.findings.slice(0, maxListed),
      missing: salvage.missing.slice(0, maxListed),
      refetch: refetch.slice(0, maxListed),
    },
    evidence: {
      now,
      action,
      total: scan.total,
      usable: salvage.usableCount,
      missing: salvage.missing.length,
      refetch: refetch.length,
      prefix: salvage.prefix,
      coverage: salvage.coverage,
      sealed,
      reasons: reasons.slice(0, 4),
    },
  };
}

/** 恢复决策 → 协议字段（列表截断；键集稳定）。 */
export function shardRecoveryWire(plan, options = {}) {
  if (!isPlainObject(plan)) {
    return { version: SHARD_RECOVERY_VERSION, action: 'nothing', ok: false, total: 0, usable: 0 };
  }
  const limit = clampInt(options.maxListed, 0, 32, 6);
  return {
    version: SHARD_RECOVERY_VERSION,
    action: String(plan.action || 'nothing'),
    ok: plan.ok === true,
    captureId: plan.captureId || '',
    sealed: plan.sealed === true,
    total: plan.total || 0,
    usable: plan.salvage ? plan.salvage.usableCount : 0,
    missing: plan.salvage ? plan.salvage.missing.length : 0,
    refetch: Array.isArray(plan.refetch) ? plan.refetch.length : 0,
    prefix: plan.prefix || 0,
    cursor: plan.cursor || 0,
    coverage: plan.coverage || 0,
    reasons: Array.isArray(plan.reasons) ? plan.reasons.slice(0, 4) : [],
    findings: ((plan.scan && Array.isArray(plan.scan.findings)) ? plan.scan.findings : []).slice(0, limit).map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      index: finding.index,
    })),
    refetchPreview: (Array.isArray(plan.refetch) ? plan.refetch : []).slice(0, limit),
    text: describeShardRecovery(plan),
  };
}

/** 一行日志：'分片恢复 recover-partial：可用 3/5 片（覆盖 60%），重取 2 片，前缀 2'。 */
export function describeShardRecovery(plan) {
  if (!isPlainObject(plan)) return '分片恢复 无';
  const salvage = plan.salvage || {};
  return '分片恢复 ' + String(plan.action || 'nothing') +
    '：可用 ' + (salvage.usableCount || 0) + '/' + (plan.total || 0) + ' 片' +
    '（覆盖 ' + Math.round((plan.coverage || 0) * 100) + '%）' +
    '，重取 ' + (Array.isArray(plan.refetch) ? plan.refetch.length : 0) + ' 片' +
    '，前缀 ' + (plan.prefix || 0) +
    (plan.reasons && plan.reasons.length ? '（' + plan.reasons.join('；') + '）' : '');
}
