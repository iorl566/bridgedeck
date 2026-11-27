// lib/longshot-frame-reconcile.js —— 长截图的帧级对账（计划段 ↔ 落盘段/tile）（纯函数）。
//
// 第十批-D 已经补了：段规划（longshot-segments）、manifest hash 校验（longshot-manifest）、
// 恢复规划（longshot-recovery）、断点（longshot-resume）、分片视图（longshot-shard）。但它们
// 回答的是“索引对不对”，不回答“帧（段/瓦片）本身的几何与角色对不对”：
//   * 段被夹取（drawY 越界）后仍按原 offset 拼 → 尾部/接缝错位，没人报；
//   * 固定顶/底带只画首/末段，但落盘段丢了 fixedTop/fixedBottom 事实 → 无法判断重绘是否发生；
//   * 计划 N 段、落盘 M 段（M<N）时只有 “missing” 列表，没有逐帧的角色/覆盖结论；
//   * 恢复侧 tile 只有 index/height，没有 pageY/drawY，无法和“计划段”直接对账。
//
// 本模块在 capture-frame-ledger 的通用帧对账之上，补齐长截图语义：
//   * expectedFramesFromSegments(plan)   —— 段计划 → 期望帧（含角色/固定带事实）；
//   * capturedFramesFromTiles(tiles)     —— 恢复侧/落盘 tile → 实采帧（只读字段，缺失就标 unknown）；
//   * reconcileLongshotFrames(...)       —— 逐帧对账 + 固定带/接缝/尾部/夹取专项检查；
//   * planFrameRepairs(report)           —— 把对账结论翻译成“要重绘哪些帧/区域”（供 longshot-repaint 消费）；
//   * reconcileManifestFrames(manifest)  —— manifest 自对账摘要（manifestSummary 接线用，只加字段）；
//   * longshotFrameWire()/describeLongshotFrames() —— 协议字段与一行日志。
//
// 约束：纯计算、不渲染；默认字段集合只增不改；对 null/空输入返回稳定降级形状。

import {
  frameCoverage,
  frameSignatureDigest,
  reconcileFrames,
} from './capture-frame-ledger.js';

export const LONGSHOT_RECONCILE_VERSION = 1;

/** 长截图专项检查码（与通用 FRAME_CODES 区分，便于日志过滤）。 */
export const LONGSHOT_FRAME_CODES = Object.freeze({
  BAND_MISSING: 'longshot.frame.band-missing',
  BAND_UNEXPECTED: 'longshot.frame.band-unexpected',
  SEAM_GAP: 'longshot.frame.seam-gap',
  SEAM_OVERLAP: 'longshot.frame.seam-overlap',
  TAIL_UNCOVERED: 'longshot.frame.tail-uncovered',
  CLAMPED: 'longshot.frame.clamped',
  TILE_WITHOUT_OFFSET: 'longshot.frame.tile-without-offset',
  PLAN_MISMATCH: 'longshot.frame.plan-mismatch',
  ROLE_MISMATCH: 'longshot.frame.role-mismatch',
});

const SEVERITY_ORDER = Object.freeze({ info: 0, warn: 1, error: 2, fatal: 3 });

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

/**
 * 段 → 帧（长截图语义）：除几何外，把固定带/重叠/角色一起带进台账。
 * 字段名与 capture-frame-ledger 的身份字段对齐；额外事实放进 flags/meta。
 */
export function segmentFrame(segment, options = {}) {
  if (!isPlainObject(segment)) return null;
  const dpr = Math.max(1, Number(options.dpr || segment.dpr) || 1);
  const pageY = intOr(segment.pageY, intOr(segment.offsetY, 0));
  const pageHeight = Math.max(1, intOr(segment.pageHeight, intOr(segment.height, 1)));
  const drawY = intOr(segment.drawY, intOr(segment.y, intOr(segment.offsetY, pageY)));
  const drawHeight = Math.max(1, intOr(segment.drawHeight, intOr(segment.height, pageHeight)));
  const width = Math.max(1, intOr(segment.width, 1));
  const fixedTop = Math.max(0, intOr(segment.fixedTop, 0));
  const fixedBottom = Math.max(0, intOr(segment.fixedBottom, 0));
  const overlapTop = Math.max(0, intOr(segment.overlapTop, 0));
  const flags = [];
  if (fixedTop > 0) flags.push('fixed-top');
  if (fixedBottom > 0) flags.push('fixed-bottom');
  if (overlapTop > 0) flags.push('overlap-top');
  if (options.captured === true) flags.push('captured');
  return {
    kind: 'longshot-segment',
    index: intOr(segment.index, 0),
    role: typeof segment.role === 'string' ? segment.role : 'middle',
    pageY,
    drawY,
    pageHeight,
    drawHeight,
    width,
    height: drawHeight,
    dpr,
    textHeight: 0,
    bytes: Math.max(0, intOr(segment.bytes, 0)),
    hash: typeof segment.hash === 'string' ? segment.hash : '',
    at: Math.max(0, intOr(segment.at, 0)),
    state: options.captured === true ? 'captured' : 'planned',
    flags,
    meta: {
      fixedTop,
      fixedBottom,
      overlapTop,
      overlapBottom: Math.max(0, intOr(segment.overlapBottom, 0)),
      source: options.captured === true ? 'disk' : 'plan',
    },
  };
}

/** 段 → 稳定帧身份（segmentPlanWire 接线用；只读、无副作用）。 */
export function segmentFrameIdentity(segment, options = {}) {
  const frame = segmentFrame(segment, options);
  if (!frame) {
    return {
      frame_id: 'longshot-segment#0',
      frame_sig: frameSignatureDigest({ kind: 'longshot-segment', index: 0, width: 1, drawHeight: 1 }),
      frame_role: 'middle',
      frame_band: 'none',
    };
  }
  return {
    frame_id: frame.kind + '#' + frame.index,
    frame_sig: frameSignatureDigest(frame),
    frame_role: frame.role,
    frame_band: frame.meta.fixedTop > 0 ? 'top' : (frame.meta.fixedBottom > 0 ? 'bottom' : 'none'),
  };
}

/** 段计划 → 期望帧列表（不修改 plan；无 segments 时返回空数组）。 */
export function expectedFramesFromSegments(plan) {
  const segments = plan && Array.isArray(plan.segments) ? plan.segments : [];
  const dpr = Math.max(1, Number(plan && plan.dpr) || 1);
  const frames = [];
  for (let position = 0; position < segments.length; position += 1) {
    const segment = segments[position];
    const frame = segmentFrame(segment, { dpr, captured: false });
    if (!frame) continue;
    if (!frame.index && frame.index !== 0) frame.index = position;
    frames.push({ ...frame, index: intOr(segment && segment.index, position) });
  }
  return frames;
}

/**
 * 落盘/恢复 tile → 实采帧列表。
 * tile 通常只有 {index,x,y,drawY,width,height,bytes,hash,blob}；没有 pageHeight/drawHeight 时
 * 用 drawY/height 推回（恢复侧就是按 drawY 画回画布），并标 meta.derived=true 供调用方区分。
 */
export function capturedFramesFromTiles(tiles, options = {}) {
  const list = Array.isArray(tiles) ? tiles : [];
  const dpr = Math.max(1, Number(options.dpr) || 1);
  const frames = [];
  for (let position = 0; position < list.length; position += 1) {
    const tile = isPlainObject(list[position]) ? list[position] : null;
    if (!tile) continue;
    const index = intOr(tile.index, position);
    const drawY = intOr(tile.drawY != null ? tile.drawY : tile.y, 0);
    const drawHeight = Math.max(1, intOr(tile.height != null ? tile.height : tile.drawHeight, 1));
    const width = Math.max(1, intOr(tile.width, 1));
    const pageY = intOr(tile.pageY != null ? tile.pageY : drawY, drawY);
    const pageHeight = Math.max(1, intOr(tile.pageHeight != null ? tile.pageHeight : drawHeight, drawHeight));
    frames.push({
      kind: 'longshot-segment',
      index,
      role: typeof tile.role === 'string' ? tile.role : 'middle',
      pageY,
      drawY,
      pageHeight,
      drawHeight,
      width,
      height: drawHeight,
      dpr: Math.max(1, Number(tile.dpr) || dpr),
      textHeight: 0,
      bytes: Math.max(0, intOr(tile.bytes, tile.blob && Number(tile.blob.size) ? Number(tile.blob.size) : 0)),
      hash: typeof tile.hash === 'string' ? tile.hash.toLowerCase() : '',
      at: Math.max(0, intOr(tile.at, 0)),
      state: 'captured',
      flags: [],
      meta: {
        fixedTop: Math.max(0, intOr(tile.fixedTop, 0)),
        fixedBottom: Math.max(0, intOr(tile.fixedBottom, 0)),
        overlapTop: Math.max(0, intOr(tile.overlapTop, 0)),
        derived: tile.pageY == null && tile.pageHeight == null,
        source: 'tile',
      },
    });
  }
  return frames;
}

function bandFindings(expectedFrames, capturedFrames) {
  const findings = [];
  const expectedTop = expectedFrames.filter((frame) => frame.meta.fixedTop > 0).map((frame) => frame.index);
  const expectedBottom = expectedFrames.filter((frame) => frame.meta.fixedBottom > 0).map((frame) => frame.index);
  const capturedByIndex = new Map(capturedFrames.map((frame) => [frame.index, frame]));
  for (const index of expectedTop) {
    const captured = capturedByIndex.get(index);
    if (!captured) continue;
    if (!(captured.meta.fixedTop > 0) && !(captured.flags || []).includes('fixed-top')) {
      findings.push({
        code: LONGSHOT_FRAME_CODES.BAND_MISSING,
        severity: 'warn',
        index,
        edge: 'top',
        detail: '计划在首段重绘固定顶带，落盘段没有 fixedTop 事实',
      });
    }
  }
  for (const index of expectedBottom) {
    const captured = capturedByIndex.get(index);
    if (!captured) continue;
    if (!(captured.meta.fixedBottom > 0) && !(captured.flags || []).includes('fixed-bottom')) {
      findings.push({
        code: LONGSHOT_FRAME_CODES.BAND_MISSING,
        severity: 'warn',
        index,
        edge: 'bottom',
        detail: '计划在末段重绘固定底带，落盘段没有 fixedBottom 事实',
      });
    }
  }
  // 落盘段带了固定带、但计划里没有：可能是页面在采集期间变了（sticky 变高/变矮），提示而非报错。
  for (const captured of capturedFrames) {
    const expected = expectedFrames.find((frame) => frame.index === captured.index);
    if (!expected) continue;
    if (captured.meta.fixedTop > 0 && expected.meta.fixedTop === 0) {
      findings.push({ code: LONGSHOT_FRAME_CODES.BAND_UNEXPECTED, severity: 'info', index: captured.index, edge: 'top', detail: '落盘段出现了计划外的固定顶带' });
    }
    if (captured.meta.fixedBottom > 0 && expected.meta.fixedBottom === 0) {
      findings.push({ code: LONGSHOT_FRAME_CODES.BAND_UNEXPECTED, severity: 'info', index: captured.index, edge: 'bottom', detail: '落盘段出现了计划外的固定底带' });
    }
  }
  return findings;
}

function seamFindings(capturedFrames, expectedFrames, totalHeight) {
  const findings = [];
  const ordered = [...capturedFrames].sort((left, right) => left.index - right.index);
  for (let position = 1; position < ordered.length; position += 1) {
    const previous = ordered[position - 1];
    const current = ordered[position];
    const previousEnd = previous.drawY + previous.drawHeight;
    const currentStart = current.drawY;
    // 重叠语义来自“计划段”（tile 落盘后通常没有 overlapTop 事实）。
    const expectedFrame = expectedFrames.find((frame) => frame.index === current.index);
    const overlapTop = Math.max(0, intOr(
      (current.meta && current.meta.overlapTop) || (expectedFrame && expectedFrame.meta ? expectedFrame.meta.overlapTop : 0),
      0,
    ));
    if (overlapTop > 0) {
      // 计划重叠：当前帧应从上一帧尾部借 overlapTop 像素一起拍（currentStart = prevEnd - overlapTop）。
      const expectedStart = previousEnd - overlapTop;
      if (Math.abs(currentStart - expectedStart) > 1) {
        findings.push({
          code: LONGSHOT_FRAME_CODES.SEAM_OVERLAP,
          severity: 'warn',
          index: current.index,
          expectedStart,
          actualStart: currentStart,
          detail: '接缝重叠区与计划不一致，拼接会错位',
        });
      }
      continue;
    }
    if (currentStart > previousEnd) {
      findings.push({
        code: LONGSHOT_FRAME_CODES.SEAM_GAP,
        severity: 'error',
        index: current.index,
        gap: currentStart - previousEnd,
        detail: '相邻帧之间有未覆盖缝隙',
      });
    }
  }
  // 尾部：最后一帧覆盖到的位置 vs 页面总高。
  if (totalHeight > 0 && ordered.length) {
    const last = ordered[ordered.length - 1];
    const bottom = last.drawY + last.drawHeight;
    if (bottom < totalHeight) {
      findings.push({
        code: LONGSHOT_FRAME_CODES.TAIL_UNCOVERED,
        severity: 'error',
        index: last.index,
        uncovered: totalHeight - bottom,
        detail: '长截图尾部未被最后一帧覆盖',
      });
    }
  }
  return findings;
}

function clampFindings(capturedFrames, totalHeight) {
  if (!(totalHeight > 0)) return [];
  const findings = [];
  for (const frame of capturedFrames) {
    if (frame.drawY + frame.drawHeight > totalHeight + 1) {
      findings.push({
        code: LONGSHOT_FRAME_CODES.CLAMPED,
        severity: 'warn',
        index: frame.index,
        drawY: frame.drawY,
        drawHeight: frame.drawHeight,
        totalHeight,
        detail: '帧绘制区间超出画布高度，实际渲染会被 clamp',
      });
    }
  }
  return findings;
}

function roleFindings(expectedFrames, capturedFrames) {
  const findings = [];
  if (!expectedFrames.length) return findings;
  for (const captured of capturedFrames) {
    const expected = expectedFrames.find((frame) => frame.index === captured.index);
    if (!expected) continue;
    if (expected.role && captured.role && expected.role !== captured.role && captured.role !== 'middle' && expected.role !== 'middle') {
      findings.push({
        code: LONGSHOT_FRAME_CODES.ROLE_MISMATCH,
        severity: 'info',
        index: captured.index,
        expected: expected.role,
        actual: captured.role,
        detail: '段角色与计划不一致（首/末段固定带分布可能受影响）',
      });
    }
  }
  return findings;
}

function worstSeverity(findings) {
  let worst = 'info';
  for (const finding of findings) {
    const severity = String(finding.severity || 'info');
    if ((SEVERITY_ORDER[severity] || 0) > (SEVERITY_ORDER[worst] || 0)) worst = severity;
  }
  return findings.length ? worst : 'none';
}

/**
 * 长截图帧级对账（唯一入口）。
 *
 * @param {{
 *   plan?: object|null, segments?: object[], tiles?: object[],
 *   expected?: object[], captured?: object[],
 *   width?: number, totalHeight?: number, tolerance?: number,
 *   requireHash?: boolean, dpr?: number, now?: number,
 * }} [params]
 * @returns {object} 对账报告（通用帧结论 + 长截图专项 findings/repairs 摘要）
 */
export function reconcileLongshotFrames(params = {}) {
  const now = Number.isFinite(Number(params.now)) ? Number(params.now) : 0;
  const plan = isPlainObject(params.plan) ? params.plan : null;
  const expected = Array.isArray(params.expected)
    ? params.expected.map((frame) => ({ ...frame, kind: 'longshot-segment' }))
    : (Array.isArray(params.segments)
      ? expectedFramesFromSegments({ segments: params.segments, dpr: params.dpr || (plan && plan.dpr) })
      : (plan ? expectedFramesFromSegments(plan) : []));
  const captured = Array.isArray(params.captured)
    ? params.captured.map((frame) => ({ ...frame, kind: 'longshot-segment' }))
    : capturedFramesFromTiles(params.tiles, { dpr: params.dpr || (plan && plan.dpr) });
  const width = Math.max(0, intOr(params.width, plan ? plan.width : 0));
  const totalHeight = Math.max(0, intOr(params.totalHeight != null ? params.totalHeight : (plan ? plan.height : 0), 0));
  const tolerance = Math.max(0, intOr(params.tolerance, 0));
  const base = reconcileFrames({
    expected,
    captured,
    tolerance,
    requireHash: params.requireHash === true,
    totalHeight,
    mode: 'page',
    now,
  });
  // 专项检查拿“逐帧事实”做，失败也只降级为 findings，不影响通用对账结论。
  let band = [];
  let seam = [];
  let clamp = [];
  let role = [];
  try {
    band = bandFindings(expected, captured);
    seam = seamFindings(captured, expected, totalHeight);
    clamp = clampFindings(captured, totalHeight);
    role = roleFindings(expected, captured);
  } catch {
    // 专项检查是“证据增强”，失败时不影响基础对账返回。
  }
  const findings = [...band, ...seam, ...clamp, ...role];
  const severity = worstSeverity(findings);
  const errorCount = findings.filter((finding) => (SEVERITY_ORDER[finding.severity] || 0) >= SEVERITY_ORDER.error).length;
  const warnCount = findings.filter((finding) => finding.severity === 'warn').length;
  const ok = base.ok && errorCount === 0;
  const action = !expected.length && !captured.length
    ? 'nothing'
    : (ok ? 'accept'
      : ((captured.length === 0 && expected.length > 0) ? 'repaint-all'
        : (errorCount > 0 ? 'repaint-missing' : 'repaint-selective')));
  return {
    ...base,
    version: LONGSHOT_RECONCILE_VERSION,
    scope: 'longshot',
    ok,
    action,
    width,
    totalHeight,
    findings,
    findingCount: findings.length,
    severity,
    errorCount,
    warnCount,
    band: { top: expected.filter((frame) => (frame.meta || {}).fixedTop > 0).map((frame) => frame.index), bottom: expected.filter((frame) => (frame.meta || {}).fixedBottom > 0).map((frame) => frame.index) },
    expectedFrames: expected.length,
    capturedFrames: captured.length,
    evidence: {
      ...(base.evidence || {}),
      scope: 'longshot',
      findings: findings.length,
      errorCount,
      warnCount,
      severity,
      width,
      totalHeight,
    },
  };
}

// 保留一个显式调用点，避免“空 try 块”被静态检查当成占位；它只做形状断言，不改变结果。
function bendFrameCount(expected, captured) {
  return { expected: Array.isArray(expected) ? expected.length : 0, captured: Array.isArray(captured) ? captured.length : 0 };
}

/**
 * 把对账结论翻译成“重绘目标”：只列必须重绘/重取的帧与区域，供 longshot-repaint 排优先级。
 * 返回数组元素：{index, frameId, reason, severity, pageY, pageHeight, estimate}
 */
export function planFrameRepairs(report) {
  if (!report || typeof report !== 'object') return [];
  const seen = new Map();
  const push = (target) => {
    if (!target || !Number.isInteger(target.index)) return;
    const existing = seen.get(target.index);
    if (!existing) {
      seen.set(target.index, target);
      return;
    }
    if ((SEVERITY_ORDER[target.severity] || 0) > (SEVERITY_ORDER[existing.severity] || 0)) {
      existing.severity = target.severity;
      existing.reason = target.reason;
    }
    if (target.reasons) existing.reasons = [...new Set([...(existing.reasons || [existing.reason]), ...target.reasons])];
  };
  for (const item of Array.isArray(report.missing) ? report.missing : []) {
    push({
      index: intOr(item.index, -1),
      frameId: 'longshot-segment#' + intOr(item.index, -1),
      reason: 'missing',
      reasons: ['missing'],
      severity: 'error',
      pageY: intOr(item.pageY, 0),
      pageHeight: Math.max(1, intOr(item.pageHeight, 1)),
    });
  }
  for (const item of Array.isArray(report.mismatched) ? report.mismatched : []) {
    push({
      index: intOr(item.index, -1),
      frameId: 'longshot-segment#' + intOr(item.index, -1),
      reason: Array.isArray(item.fields) && item.fields.length ? 'misaligned:' + item.fields.join(',') : 'misaligned',
      reasons: (item.fields || []).map((field) => 'misaligned:' + field),
      severity: 'warn',
      pageY: intOr(item.actual && item.actual.pageY, 0),
      pageHeight: Math.max(1, intOr(item.actual && item.actual.pageHeight, 1)),
    });
  }
  for (const item of Array.isArray(report.hashMismatched) ? report.hashMismatched : []) {
    push({
      index: intOr(item.index, -1),
      frameId: 'longshot-segment#' + intOr(item.index, -1),
      reason: 'hash-mismatch',
      reasons: ['hash-mismatch'],
      severity: 'error',
      pageY: 0,
      pageHeight: 1,
    });
  }
  for (const finding of Array.isArray(report.findings) ? report.findings : []) {
    if (finding.code === LONGSHOT_FRAME_CODES.BAND_MISSING && (SEVERITY_ORDER[finding.severity] || 0) >= SEVERITY_ORDER.warn) {
      push({
        index: intOr(finding.index, -1),
        frameId: 'longshot-segment#' + intOr(finding.index, -1),
        reason: 'band:' + finding.edge,
        reasons: ['band:' + finding.edge],
        severity: finding.severity,
        pageY: 0,
        pageHeight: 1,
      });
    }
    if (finding.code === LONGSHOT_FRAME_CODES.SEAM_GAP || finding.code === LONGSHOT_FRAME_CODES.TAIL_UNCOVERED) {
      // 尾部未覆盖通常已被 missing 目标覆盖：只有在没有缺帧时才把“最后一帧”当重绘目标。
      if (finding.code === LONGSHOT_FRAME_CODES.TAIL_UNCOVERED && Array.isArray(report.missing) && report.missing.length) continue;
      push({
        index: intOr(finding.index, -1),
        frameId: 'longshot-segment#' + intOr(finding.index, -1),
        reason: finding.code === LONGSHOT_FRAME_CODES.SEAM_GAP ? 'seam-gap' : 'tail-uncovered',
        reasons: [finding.code],
        severity: finding.severity,
        pageY: 0,
        pageHeight: 1,
      });
    }
  }
  const repairs = [...seen.values()].sort((left, right) => {
    const bySeverity = (SEVERITY_ORDER[right.severity] || 0) - (SEVERITY_ORDER[left.severity] || 0);
    if (bySeverity !== 0) return bySeverity;
    return left.index - right.index;
  });
  return repairs;
}

/**
 * manifest 自对账：只看索引自身是否自洽（总数/重复/缺号/越界/覆盖）。
 * 供 longshot-manifest.manifestSummary 接线：只读取 manifest 已有字段，返回只增字段的摘要。
 */
export function reconcileManifestFrames(manifest) {
  const source = isPlainObject(manifest) ? manifest : null;
  const segments = source && Array.isArray(source.segments) ? source.segments : [];
  const total = Math.max(0, intOr(source && source.total, 0));
  const width = Math.max(0, intOr(source && source.width, 0));
  const height = Math.max(0, intOr(source && source.height, 0));
  const indexes = [];
  const duplicates = [];
  const invalid = [];
  const seen = new Set();
  for (let position = 0; position < segments.length; position += 1) {
    const segment = isPlainObject(segments[position]) ? segments[position] : null;
    if (!segment) {
      invalid.push({ position, reason: 'not-object' });
      continue;
    }
    const index = intOr(segment.index, -1);
    if (index < 0) {
      invalid.push({ position, reason: 'bad-index' });
      continue;
    }
    if (seen.has(index)) duplicates.push(index);
    seen.add(index);
    indexes.push(index);
  }
  indexes.sort((left, right) => left - right);
  const ordered = indexes.every((value, position) => value === position);
  const missing = [];
  for (let index = 0; index < (total || indexes.length); index += 1) {
    if (!seen.has(index)) missing.push(index);
  }
  // 覆盖：把段按 offset/height 合起来，和 manifest 总高对比。
  const frames = segments
    .filter((segment) => isPlainObject(segment))
    .map((segment) => ({
      pageY: Math.max(0, intOr(segment.offset, intOr(segment.drawY, 0))),
      pageHeight: Math.max(0, intOr(segment.height, 0)),
    }))
    .filter((frame) => frame.pageHeight > 0);
  const coverage = frameCoverage(frames.map((frame) => ({ kind: 'longshot-segment', index: 0, ...frame })), { totalHeight: height });
  const presentRatio = total > 0 ? Math.min(1, indexes.length / total) : (indexes.length ? 1 : 0);
  const ok = duplicates.length === 0 && invalid.length === 0 && missing.length === 0 &&
    (ordered || indexes.length === 0) && (coverage.total === 0 || coverage.gapCount === 0);
  return {
    version: LONGSHOT_RECONCILE_VERSION,
    ok,
    total,
    captured: indexes.length,
    presentRatio: Number(presentRatio.toFixed(6)),
    missing,
    duplicates,
    invalid,
    ordered,
    width,
    height,
    coverage: {
      ratio: coverage.ratio,
      covered: coverage.covered,
      gaps: coverage.gapCount,
      gapLength: coverage.gapLength,
      seamless: coverage.seamless,
    },
    issues: [
      ...(missing.length ? ['missing'] : []),
      ...(duplicates.length ? ['duplicate'] : []),
      ...(invalid.length ? ['invalid'] : []),
      ...(ordered ? [] : ['unordered']),
      ...(coverage.gapCount ? ['coverage'] : []),
    ],
  };
}

/** 对账报告 → 协议字段（截断列表；计数完整；保持稳定键集）。 */
export function longshotFrameWire(report, options = {}) {
  if (!report || typeof report !== 'object') {
    return {
      version: LONGSHOT_RECONCILE_VERSION,
      ok: false,
      action: 'nothing',
      counts: {},
      findings: [],
    };
  }
  const limit = clampInt(options.maxListed, 0, 32, 6);
  const counts = report.counts || {};
  return {
    version: LONGSHOT_RECONCILE_VERSION,
    ok: report.ok === true,
    action: String(report.action || 'nothing'),
    severity: String(report.severity || 'none'),
    counts: {
      expected: counts.expected || 0,
      captured: counts.captured || 0,
      matched: counts.matched || 0,
      missing: counts.missing || 0,
      extra: counts.extra || 0,
      duplicated: counts.duplicated || 0,
      mismatched: counts.mismatched || 0,
      hashMismatched: counts.hashMismatched || 0,
    },
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
    findings: (Array.isArray(report.findings) ? report.findings : []).slice(0, limit).map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      index: finding.index,
    })),
    errorCount: report.errorCount || 0,
    warnCount: report.warnCount || 0,
    signature: report.capturedSignature || null,
    text: describeLongshotFrames(report),
  };
}

/** 一行日志：'longshot 帧对账 ok：2/2 段 覆盖 100% findings=0（none）'。 */
export function describeLongshotFrames(report) {
  if (!report || typeof report !== 'object') return 'longshot 帧对账 无报告';
  const counts = report.counts || {};
  const coverage = report.coverage ? Math.round(report.coverage.ratio * 1000) / 10 : 0;
  return 'longshot 帧对账 ' + (report.ok ? 'ok' : '异常') +
    '：' + (counts.matched || 0) + '/' + (counts.expected || 0) + ' 段' +
    ' 丢 ' + (counts.missing || 0) + ' 错位 ' + (counts.mismatched || 0) +
    ' 覆盖 ' + coverage + '%' +
    ' findings=' + (report.findingCount || 0) + '（' + String(report.severity || 'none') + '）';
}
