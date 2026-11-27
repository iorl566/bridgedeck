// lib/waterfall-attribution.mjs —— 网络瀑布归因层（Node/CLI 侧深化）。
//
// 单源原则不变：分项计时/跨 frame/流式判定的**唯一实现**仍是
// extension/src/lib/network-waterfall.js（浏览器扩展 RPC network.waterfall 直接消费），
// 本模块只在其 `buildWaterfall` 输出上做"归因 + 阈值 + 降级 + 诚实性审计"，
// 不复制任何计时公式（tests/unit/network-runtime-wiring.test.mjs 也对此有守卫）。
//
// 本层解决的问题（全部相对 waterfall 原始 rows 是加法）：
//   1. 归因：每行判定 queueing / TTFB / download 三段谁占主导，并给出机器可读的
//      attribution code（如 server-processing、payload-size、connection-reuse）；
//   2. 慢请求：阈值可配（默认 1000ms），产出慢请求排行与分类型统计；
//   3. 流式诚实性：没有 loadingFinished 的请求只能给"截至 now"的实时时长，
//      auditCompletion() 会显式找出"伪造完成"的输入并报告，而不是把 open 当 done；
//   4. 跨 frame 关联：用父链把子 frame 的请求上卷到父 frame 汇总，孤儿 frame 单独列出；
//   5. 降级：请求数超预算时按"慢请求优先 + 错误优先 + 流式未完成优先 + 最早剩余"选择，
//      明确记录 dropped 与选择策略，供大页面/长采集场景使用。
//
// 消费点：lib/har-import.mjs `importHar`（debug har-import / MCP browser_debug_har_import）
// 会把归因摘要挂到 archive._waterfall；默认 archive 字段不变，只新增该 `_` 字段。

import { buildWaterfall, deriveCdpTimings, timingsForEntry } from './network-waterfall.mjs';

export const WATERFALL_ATTRIBUTION_VERSION = 1;
export const DEFAULT_SLOW_MS = 1000;
export const DEFAULT_FRAME_SLOW_MS = 500;
export const ATTRIBUTION_PHASES = Object.freeze(['queueing', 'ttfb', 'download']);
export const PHASE_TO_MS = Object.freeze({
  queueing: 'queueingMs',
  ttfb: 'ttfbMs',
  download: 'contentDownloadMs',
});

const ATTRIBUTION_CODES = Object.freeze({
  queueing: 'connection-or-queue-wait',
  ttfb: 'server-processing',
  download: 'payload-transfer',
  unknown: 'insufficient-timings',
});

/** 归因码 → 建议（机器可读 code + 人读 hint）。 */
const ATTRIBUTION_HINTS = Object.freeze({
  'connection-or-queue-wait': {
    reason: '大部分时间花在 socket 排队/连接建立之前：常见于并发过高、连接池耗尽或被浏览器节流。',
    hint: '减少同时发起的请求数；检查 preconnect/dns-prefetch；确认是否触发了浏览器同域连接上限。',
  },
  'server-processing': {
    reason: '首字节前的等待时间占主导：请求已发出，服务端/中间层在计算或排队。',
    hint: '检查服务端耗时与 CDN/网关排队；对比同 URL 的 TTFB 分布；必要时加缓存或降级。',
  },
  'payload-transfer': {
    reason: '首字节之后的下载时间占主导：响应体体积大或带宽受限。',
    hint: '压缩/裁剪响应体；开启 gzip/br；检查是否一次性返回了可分页的数据。',
  },
  'insufficient-timings': {
    reason: '没有可用的分项计时（也没有 responseAt），无法归因。',
    hint: '需要兼容目标提供 CDP response.timing 或 responseAt；否则只能给总时长。',
  },
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function textOf(value) {
  return String(value == null ? '' : value);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function sharePercent(value, total) {
  const numerator = positive(value);
  const denominator = positive(total);
  if (!denominator) return 0;
  return Math.min(100, Math.round((numerator / denominator) * 1000) / 10);
}

/**
 * 对单行（waterfall row）做三段归因。
 * 返回 {phase, ms, share, code, contributions:[{phase,ms,share}], ties:boolean}。
 * 分项缺失（都是 0）时返回 phase='unknown'，不假装归因成功。
 */
export function attributePhase(row) {
  const timings = row && row.timings && typeof row.timings === 'object' ? row.timings : {};
  const contributions = ATTRIBUTION_PHASES.map((phase) => {
    const ms = positive(timings[PHASE_TO_MS[phase]] ?? row[PHASE_TO_MS[phase]]);
    return { phase, ms: round(ms) };
  });
  const total = contributions.reduce((sum, item) => sum + item.ms, 0);
  for (const item of contributions) item.share = sharePercent(item.ms, total);
  if (!(total > 0)) {
    return {
      phase: 'unknown',
      ms: 0,
      share: 0,
      code: ATTRIBUTION_CODES.unknown,
      contributions,
      ties: false,
      totalMs: 0,
    };
  }
  const sorted = contributions.slice().sort((a, b) => b.ms - a.ms);
  const winner = sorted[0];
  // 并列时固定优先级 queueing > ttfb > download，保证输出可复现。
  const tieCandidates = sorted.filter((item) => item.ms === winner.ms);
  const ties = tieCandidates.length > 1;
  const chosen = ties
    ? tieCandidates.slice().sort((a, b) => ATTRIBUTION_PHASES.indexOf(a.phase) - ATTRIBUTION_PHASES.indexOf(b.phase))[0]
    : winner;
  return {
    phase: chosen.phase,
    ms: round(chosen.ms),
    share: chosen.share,
    code: ATTRIBUTION_CODES[chosen.phase],
    contributions,
    ties,
    totalMs: round(total),
  };
}

/** 把归因结果转成结构化解释（code + reason + hint），可直接进 JSON 报告。 */
export function explainAttribution(attribution) {
  const code = attribution && attribution.code ? attribution.code : ATTRIBUTION_CODES.unknown;
  const hint = ATTRIBUTION_HINTS[code] || ATTRIBUTION_HINTS[ATTRIBUTION_CODES.unknown];
  return {
    code,
    phase: attribution && attribution.phase ? attribution.phase : 'unknown',
    share: attribution && Number.isFinite(Number(attribution.share)) ? Number(attribution.share) : 0,
    reason: hint.reason,
    hint: hint.hint,
  };
}

/**
 * 选择要保留的条目（降级策略）。纯函数、确定性；用于大页面/长采集时限制 row 数。
 * 优先级：错误 > 慢请求（>= slowMs，按时长降序）> 流式未完成 > 剩余按开始时间。
 * options: {limit, slowMs}
 */
export function selectWaterfallEntries(entries, options = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && finite(entry.startedAt) != null);
  const limit = Math.max(1, Math.floor(finite(options.limit) ?? 200));
  const slowMs = Math.max(1, finite(options.slowMs) ?? DEFAULT_SLOW_MS);
  if (list.length <= limit) {
    return { entries: list.slice().sort((a, b) => finite(a.startedAt) - finite(b.startedAt)), total: list.length, kept: list.length, dropped: 0, strategy: 'none', reasons: {} };
  }
  const sorted = list.slice().sort((a, b) => finite(a.startedAt) - finite(b.startedAt));
  const durationOf = (entry) => positive(entry.durationMs);
  const failed = (entry) => Boolean(entry.error) || (finite(entry.status) != null && Number(entry.status) >= 400);
  const open = (entry) => entry.finished !== true;
  const picked = new Set();
  const reasons = { error: 0, slow: 0, open: 0, rest: 0 };
  for (let index = 0; index < sorted.length && picked.size < limit; index += 1) {
    if (!failed(sorted[index])) continue;
    picked.add(index);
    reasons.error += 1;
  }
  for (const [index, entry] of sorted.entries()) {
    if (picked.size >= limit) break;
    if (picked.has(index)) continue;
    if (durationOf(entry) < slowMs) continue;
    picked.add(index);
    reasons.slow += 1;
  }
  for (const [index, entry] of sorted.entries()) {
    if (picked.size >= limit) break;
    if (picked.has(index)) continue;
    if (!open(entry)) continue;
    picked.add(index);
    reasons.open += 1;
  }
  for (let index = 0; index < sorted.length && picked.size < limit; index += 1) {
    if (picked.has(index)) continue;
    picked.add(index);
    reasons.rest += 1;
  }
  return {
    entries: [...picked].sort((a, b) => a - b).map((index) => sorted[index]),
    total: sorted.length,
    kept: picked.size,
    dropped: sorted.length - picked.size,
    strategy: 'errors-then-slow-then-open-then-earliest',
    reasons,
  };
}

/**
 * 流式诚实性审计：找出"没有 loadingFinished 却声称已完成"的输入，以及
 * "有时长但没有 responseAt/timing"的不可归因输入。
 * 输入是 extension/src/network.js 的原始 entries（不是 rows）。
 */
export function auditCompletion(entries, options = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry === 'object');
  const violations = [];
  const unverifiable = [];
  for (const [index, entry] of list.entries()) {
    const finished = entry.finished === true;
    const streaming = entry.streaming === true;
    const durationMs = finite(entry.durationMs);
    const hasEnd = finite(entry.finishedAt) != null;
    if (!finished && streaming) {
      violations.push({
        index,
        requestId: entry.requestId == null ? null : String(entry.requestId),
        url: textOf(entry.url),
        code: 'streaming-claims-finished',
        message: '输入标记 streaming=true 但没有 loadingFinished；rows 必须保持 finished=false / open=true。',
      });
      continue;
    }
    if (finished && !hasEnd && durationMs == null) {
      violations.push({
        index,
        requestId: entry.requestId == null ? null : String(entry.requestId),
        url: textOf(entry.url),
        code: 'finished-without-evidence',
        message: 'finished=true 但既没有 finishedAt 也没有 durationMs，完成时长不可核验。',
      });
    }
    const hasTiming = entry.timing && typeof entry.timing === 'object';
    const hasResponseAt = finite(entry.responseAt) != null;
    if (!hasTiming && !hasResponseAt && durationMs != null) {
      unverifiable.push({
        index,
        requestId: entry.requestId == null ? null : String(entry.requestId),
        url: textOf(entry.url),
        code: 'no-phase-timings',
        message: '没有 CDP timing/responseAt，三段归因只能是 unknown（不应把总时长硬塞给 TTFB）。',
      });
    }
  }
  return { total: list.length, violations, unverifiable, ok: violations.length === 0 };
}

/**
 * 跨 frame 关联：把 frame 记录整理成父子树，并把子 frame 的请求上卷到祖先 frame。
 * frames 支持 Map / 数组 / 对象三种形态；缺失的 frame 记录会被列为 orphan 而不是丢弃。
 * options: {frames}
 */
export function correlateFrames(rows, options = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object');
  const framesOption = options.frames || null;
  const lookup = (frameId) => {
    if (frameId == null) return null;
    const key = String(frameId);
    if (framesOption instanceof Map) return framesOption.get(key) || framesOption.get(Number(key)) || null;
    if (Array.isArray(framesOption)) return framesOption.find((item) => item && String(item.frameId) === key) || null;
    if (framesOption && typeof framesOption === 'object') return framesOption[key] || null;
    return null;
  };
  const registry = new Map();
  const ensure = (frameId, seed = null) => {
    if (frameId == null) return null;
    const key = String(frameId);
    if (!registry.has(key)) {
      registry.set(key, {
        frameId: key,
        parentFrameId: seed && seed.parentFrameId != null ? String(seed.parentFrameId) : null,
        depth: seed && finite(seed.depth) != null ? Number(seed.depth) : 0,
        path: (seed && seed.path) || key,
        url: (seed && seed.url) || '',
        count: 0,
        bytes: 0,
        durationMs: 0,
        selfCount: 0,
        selfBytes: 0,
        selfDurationMs: 0,
        childFrames: [],
        orphan: false,
      });
    }
    return registry.get(key);
  };
  const orphans = [];
  for (const row of list) {
    const frame = row.frame || null;
    if (!frame || frame.frameId == null) continue;
    const key = String(frame.frameId);
    const record = lookup(key);
    if (!record && framesOption) {
      const orphan = ensure(key, { ...frame, depth: frame.depth });
      orphan.orphan = true;
      orphans.push({ frameId: key, count: 0 });
    } else {
      const node = ensure(key, record || frame);
      if (record && !node.url) node.url = textOf(record.url);
      if (record && record.parentFrameId != null) node.parentFrameId = String(record.parentFrameId);
      if (record && finite(record.depth) != null) node.depth = Number(record.depth);
    }
    const node = ensure(key);
    node.count += 1;
    node.bytes += positive(row.bytes ?? row.transferSize);
    node.durationMs += positive(row.durationMs);
  }
  // 孤儿统计
  for (const orphan of orphans) {
    const node = registry.get(orphan.frameId);
    orphan.count = node ? node.count : 0;
  }
  // 父链上卷：子 frame 的请求同时计入所有祖先（self* 保留"只属于该 frame"的口径）。
  const childrenAdded = new Set();
  for (const node of registry.values()) {
    node.selfCount = node.count;
    node.selfBytes = node.bytes;
    node.selfDurationMs = node.durationMs;
    let cursor = node.parentFrameId == null ? null : registry.get(node.parentFrameId);
    const seen = new Set([node.frameId]);
    while (cursor && !seen.has(cursor.frameId)) {
      seen.add(cursor.frameId);
      cursor.count += node.selfCount;
      cursor.bytes += node.selfBytes;
      cursor.durationMs += node.selfDurationMs;
      cursor = cursor.parentFrameId == null ? null : registry.get(cursor.parentFrameId);
    }
  }
  for (const node of registry.values()) {
    if (node.parentFrameId != null) {
      const parent = registry.get(node.parentFrameId);
      if (parent && !childrenAdded.has(node.frameId)) {
        parent.childFrames.push(node.frameId);
        childrenAdded.add(node.frameId);
      }
    }
  }
  const byFrame = [...registry.values()].map((node) => ({
    ...node,
    bytes: round(node.bytes, 0),
    durationMs: round(node.durationMs),
    selfBytes: round(node.selfBytes, 0),
    selfDurationMs: round(node.selfDurationMs),
    childFrames: node.childFrames.sort(),
  })).sort((a, b) => b.durationMs - a.durationMs || a.frameId.localeCompare(b.frameId));
  let unattributed = 0;
  for (const row of list) {
    if (!row.frame || row.frame.frameId == null) unattributed += 1;
  }
  return {
    frames: byFrame,
    orphans,
    unattributed,
    frameCount: byFrame.length,
    rolledUp: byFrame.filter((node) => node.childFrames.length > 0).length,
  };
}

/**
 * 对"已经是 waterfall rows"的列表做降级选择（与 selectWaterfallEntries 同策略）。
 * 用于 importHar 这类已经有 rows（带 HAR 分项计时）的场景。
 */
export function selectWaterfallRows(rows, options = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object');
  const limit = Math.max(1, Math.floor(finite(options.limit) ?? 200));
  const slowMs = Math.max(1, finite(options.slowMs) ?? DEFAULT_SLOW_MS);
  if (list.length <= limit) {
    return { rows: list.slice(), total: list.length, kept: list.length, dropped: 0, strategy: 'none', reasons: {} };
  }
  const durationOf = (row) => positive(row.durationMs);
  const failed = (row) => Boolean(row.error) || (finite(row.status) != null && Number(row.status) >= 400);
  const open = (row) => row.finished !== true;
  const picked = new Set();
  const reasons = { error: 0, slow: 0, open: 0, rest: 0 };
  for (const [index, row] of list.entries()) {
    if (picked.size >= limit) break;
    if (!failed(row)) continue;
    picked.add(index);
    reasons.error += 1;
  }
  for (const [index, row] of list.entries()) {
    if (picked.size >= limit) break;
    if (picked.has(index) || durationOf(row) < slowMs) continue;
    picked.add(index);
    reasons.slow += 1;
  }
  for (const [index, row] of list.entries()) {
    if (picked.size >= limit) break;
    if (picked.has(index) || !open(row)) continue;
    picked.add(index);
    reasons.open += 1;
  }
  for (let index = 0; index < list.length && picked.size < limit; index += 1) {
    if (picked.has(index)) continue;
    picked.add(index);
    reasons.rest += 1;
  }
  return {
    rows: [...picked].sort((a, b) => a - b).map((index) => list[index]),
    total: list.length,
    kept: picked.size,
    dropped: list.length - picked.size,
    strategy: 'errors-then-slow-then-open-then-earliest',
    reasons,
  };
}

function emptyPhaseTotals() {
  return { queueingMs: 0, ttfbMs: 0, contentDownloadMs: 0 };
}

/**
 * 瀑布归因主入口：输入 waterfall（buildWaterfall 输出）或原始 entries。
 * options:
 *   slowMs        慢请求阈值（默认 1000）
 *   limit         降级保留上限（默认 200；entries 输入时先选再 build，rows 输入时只标注不裁剪）
 *   now           流式请求"截至 now"的基准
 *   frames        跨 frame 关联用的 frame 注册表
 *   auditEntries  可选的原始 entries（用于流式诚实性审计）
 *
 * 返回 {version, rows, slow, phases, streaming, frames, errors, degraded, audit}。
 */
export function attributeWaterfall(input, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const slowMs = Math.max(1, finite(opts.slowMs) ?? DEFAULT_SLOW_MS);
  const limit = Math.max(1, Math.floor(finite(opts.limit) ?? 200));
  const now = finite(opts.now) ?? Date.now();
  const source = input && typeof input === 'object' && Array.isArray(input.rows)
    ? input
    : null;
  let entriesInput = null;
  let waterfall = source;
  let rowsSource = null;
  if (source) {
    // rows 输入也支持降级：超限时按同一优先级挑选（rows 已是构建产物，直接选行）。
    const selection = selectWaterfallRows(source.rows, { limit, slowMs });
    rowsSource = selection.rows;
    entriesInput = selection;
    waterfall = source;
  } else {
    const rawEntries = Array.isArray(input) ? input : [];
    const selection = selectWaterfallEntries(rawEntries, { limit, slowMs });
    entriesInput = selection;
    waterfall = buildWaterfall(selection.entries, { limit: selection.kept, now, frames: opts.frames || null });
  }
  const rows = (rowsSource || (Array.isArray(waterfall.rows) ? waterfall.rows : [])).map((row) => {
    const attribution = attributePhase(row);
    const explanation = explainAttribution(attribution);
    const durationMs = positive(row.durationMs);
    const slow = durationMs >= slowMs;
    return {
      ...row,
      attribution: {
        phase: attribution.phase,
        ms: attribution.ms,
        share: attribution.share,
        code: attribution.code,
        ties: attribution.ties,
        contributions: attribution.contributions,
        reason: explanation.reason,
        hint: explanation.hint,
      },
      slow,
      slowOverMs: slow ? round(durationMs - slowMs) : 0,
      honestDuration: row.finished === true ? true : 'live-until-now',
    };
  });
  const phaseTotals = emptyPhaseTotals();
  const phaseCounts = { queueing: 0, ttfb: 0, download: 0, unknown: 0 };
  const slowRows = [];
  let slowCount = 0;
  let slowBytes = 0;
  for (const row of rows) {
    for (const phase of ATTRIBUTION_PHASES) {
      phaseTotals[PHASE_TO_MS[phase]] = round(positive(phaseTotals[PHASE_TO_MS[phase]]) + positive(row.attribution.contributions.find((item) => item.phase === phase)?.ms));
    }
    phaseCounts[row.attribution.phase] = (phaseCounts[row.attribution.phase] || 0) + 1;
    if (row.slow) {
      slowCount += 1;
      slowBytes += positive(row.bytes);
      slowRows.push({
        id: row.id,
        requestId: row.requestId,
        method: row.method,
        url: row.url,
        status: row.status,
        durationMs: row.durationMs,
        phase: row.attribution.phase,
        share: row.attribution.share,
        code: row.attribution.code,
        frameId: row.frame ? row.frame.frameId : null,
      });
    }
  }
  slowRows.sort((a, b) => b.durationMs - a.durationMs || String(a.url).localeCompare(String(b.url)));
  const phaseTotalMs = round(phaseTotals.queueingMs + phaseTotals.ttfbMs + phaseTotals.contentDownloadMs);
  const dominantPhase = ATTRIBUTION_PHASES
    .map((phase) => ({ phase, ms: phaseTotals[PHASE_TO_MS[phase]] }))
    .sort((a, b) => b.ms - a.ms)[0];
  const streamingRows = rows.filter((row) => row.finished !== true);
  const audit = opts.auditEntries ? auditCompletion(opts.auditEntries, { now }) : auditCompletion([], { now });
  const frames = correlateFrames(rows, { frames: opts.frames || null });
  const degraded = {
    limited: entriesInput ? entriesInput.dropped > 0 : false,
    strategy: entriesInput ? entriesInput.strategy : 'none',
    total: entriesInput ? entriesInput.total : rows.length,
    kept: rows.length,
    dropped: entriesInput ? entriesInput.dropped : 0,
    reasons: entriesInput ? entriesInput.reasons : {},
    notes: [],
  };
  if (degraded.dropped > 0) {
    degraded.notes.push('请求数超过保留上限（' + limit + '），已按错误→慢请求→流式未完成→最早优先裁剪；' + '被裁条目见 dropped 计数。');
  }
  if (phaseTotalMs === 0 && rows.length > 0) {
    degraded.notes.push('没有任何可分项计时：归因全部为 unknown，不把总时长硬塞给 TTFB。');
  }
  return {
    version: WATERFALL_ATTRIBUTION_VERSION,
    rows,
    slow: {
      thresholdMs: slowMs,
      count: slowCount,
      bytes: slowBytes,
      rows: slowRows,
      byType: countBy(slowRows, (row) => row.code),
    },
    phases: {
      totals: phaseTotals,
      totalMs: phaseTotalMs,
      shares: {
        queueing: sharePercent(phaseTotals.queueingMs, phaseTotalMs),
        ttfb: sharePercent(phaseTotals.ttfbMs, phaseTotalMs),
        download: sharePercent(phaseTotals.contentDownloadMs, phaseTotalMs),
      },
      dominant: { phase: dominantPhase.phase, ms: round(dominantPhase.ms), share: sharePercent(dominantPhase.ms, phaseTotalMs) },
      counts: phaseCounts,
    },
    streaming: {
      count: streamingRows.length,
      finished: rows.length - streamingRows.length,
      rows: streamingRows.map((row) => ({
        id: row.id,
        requestId: row.requestId,
        url: row.url,
        durationMs: row.durationMs,
        chunked: row.chunked === true,
        honestDuration: row.honestDuration,
      })),
      honesty: 'open rows keep live-until-now duration; never reported as finished',
    },
    frames,
    errors: {
      count: rows.filter((row) => row.error || (finite(row.status) != null && Number(row.status) >= 400)).length,
      rows: rows.filter((row) => row.error || (finite(row.status) != null && Number(row.status) >= 400))
        .map((row) => ({ id: row.id, requestId: row.requestId, url: row.url, status: row.status, error: row.error || null })),
    },
    audit: {
      total: audit.total,
      ok: audit.ok,
      violations: audit.violations,
      unverifiable: audit.unverifiable.length,
    },
    degraded,
  };
}

function countBy(items, keyOf) {
  const out = {};
  for (const item of items) {
    const key = keyOf(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/** 归因报告的紧凑摘要（写进 archive._waterfall 的形状），控制导入产物体积。 */
export function summarizeWaterfallAttribution(attribution, { topSlow = 10, topFrames = 10 } = {}) {
  const source = attribution && typeof attribution === 'object' ? attribution : {};
  const slow = source.slow && typeof source.slow === 'object' ? source.slow : {};
  const phases = source.phases && typeof source.phases === 'object' ? source.phases : {};
  const streaming = source.streaming && typeof source.streaming === 'object' ? source.streaming : {};
  const frames = source.frames && typeof source.frames === 'object' ? source.frames : {};
  const errors = source.errors && typeof source.errors === 'object' ? source.errors : {};
  const degraded = source.degraded && typeof source.degraded === 'object' ? source.degraded : {};
  return {
    version: WATERFALL_ATTRIBUTION_VERSION,
    requests: Array.isArray(source.rows) ? source.rows.length : 0,
    phases: {
      totals: phases.totals || emptyPhaseTotals(),
      shares: phases.shares || { queueing: 0, ttfb: 0, download: 0 },
      dominant: phases.dominant || { phase: 'unknown', ms: 0, share: 0 },
      counts: phases.counts || {},
    },
    slow: {
      thresholdMs: Number(slow.thresholdMs) || DEFAULT_SLOW_MS,
      count: Number(slow.count) || 0,
      bytes: Number(slow.bytes) || 0,
      top: (Array.isArray(slow.rows) ? slow.rows : []).slice(0, Math.max(1, Math.floor(finite(topSlow) ?? 10))),
      byType: slow.byType || {},
    },
    streaming: {
      count: Number(streaming.count) || 0,
      finished: Number(streaming.finished) || 0,
      honesty: streaming.honesty || 'open rows keep live-until-now duration; never reported as finished',
    },
    frames: {
      count: Number(frames.frameCount) || 0,
      rolledUp: Number(frames.rolledUp) || 0,
      orphans: Array.isArray(frames.orphans) ? frames.orphans.slice(0, Math.max(1, Math.floor(finite(topFrames) ?? 10))) : [],
      top: (Array.isArray(frames.frames) ? frames.frames : []).slice(0, Math.max(1, Math.floor(finite(topFrames) ?? 10))).map((frame) => ({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        depth: frame.depth,
        count: frame.count,
        durationMs: frame.durationMs,
        bytes: frame.bytes,
      })),
      unattributed: Number(frames.unattributed) || 0,
    },
    errors: {
      count: Number(errors.count) || 0,
      top: (Array.isArray(errors.rows) ? errors.rows : []).slice(0, Math.max(1, Math.floor(finite(topSlow) ?? 10))),
    },
    audit: {
      ok: source.audit ? source.audit.ok === true : true,
      violations: source.audit ? (Array.isArray(source.audit.violations) ? source.audit.violations.length : 0) : 0,
      unverifiable: source.audit ? Number(source.audit.unverifiable) || 0 : 0,
    },
    degraded: {
      limited: degraded.limited === true,
      strategy: degraded.strategy || 'none',
      total: Number(degraded.total) || 0,
      kept: Number(degraded.kept) || 0,
      dropped: Number(degraded.dropped) || 0,
      reasons: degraded.reasons || {},
      notes: Array.isArray(degraded.notes) ? degraded.notes.slice(0, 5) : [],
    },
  };
}

/** 便捷：从 HAR/archive 的请求数组直接得到归因摘要。 */
export function attributeRequests(requests, options = {}) {
  const list = Array.isArray(requests) ? requests : [];
  const attribution = attributeWaterfall(list, options);
  return {
    attribution,
    summary: summarizeWaterfallAttribution(attribution, options),
  };
}

export { buildWaterfall, deriveCdpTimings, timingsForEntry };
