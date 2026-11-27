// src/lib/debug-coverage.js —— 调试抓取覆盖率与缺口报告。
//
// 目标不是「采样到了多少」，而是**诚实说明这次采集缺了什么、为什么缺**。调用方
// （debug.coverage / debug.stop / 归档索引）拿到的必须是显式的 { coverage, gaps[] }：
//
//   - coverage：每个阶段（session/network/console/frames/websockets/trace/screenshots/
//     journal）是否订阅、是否观测到、条数与截断情况，以及综合覆盖率分数；
//   - gaps[]：缺口条目。reason 使用固定词表，category 归一到四类根因：
//       not-subscribed（未订阅）/ limit（超限截断）/ dropped（被环形缓冲丢弃）/
//               failed（失败）/ incomplete（未完成，如请求仍 pending）/ unsupported；
//     count 能数清就给数字（例如被 buffer 挤掉 37 条），数不清给 null 并在 detail 说明。
//
// 模块是纯函数（clock 可注入），不依赖 chrome/DOM，单测直接构造输入。
export const COVERAGE_VERSION = 1;

export const COVERAGE_PHASES = Object.freeze([
  'session', 'network', 'console', 'frames', 'websockets', 'trace', 'screenshots', 'journal',
]);

export const GAP_CATEGORIES = Object.freeze({
  NOT_SUBSCRIBED: 'not-subscribed',
  LIMIT: 'limit',
  DROPPED: 'dropped',
  FAILED: 'failed',
  INCOMPLETE: 'incomplete',
  UNSUPPORTED: 'unsupported',
});

/** reason 词表 → 根因分类。未登记的一律 unsupported（显式，不静默变成 complete）。 */
export const GAP_REASON_CATEGORIES = Object.freeze({
  'not-subscribed': GAP_CATEGORIES.NOT_SUBSCRIBED,
  'bodies-not-enabled': GAP_CATEGORIES.NOT_SUBSCRIBED,
  'console-not-hooked': GAP_CATEGORIES.NOT_SUBSCRIBED,
  'frames-not-observed': GAP_CATEGORIES.NOT_SUBSCRIBED,
  'tracing-not-started': GAP_CATEGORIES.NOT_SUBSCRIBED,
  'screenshots-not-observed': GAP_CATEGORIES.NOT_SUBSCRIBED,
  'websockets-not-observed': GAP_CATEGORIES.NOT_SUBSCRIBED,
  'journal-not-attached': GAP_CATEGORIES.NOT_SUBSCRIBED,
  limit: GAP_CATEGORIES.LIMIT,
  'buffer-limit': GAP_CATEGORIES.LIMIT,
  'max-requests': GAP_CATEGORIES.LIMIT,
  'max-console': GAP_CATEGORIES.LIMIT,
  'max-bytes': GAP_CATEGORIES.LIMIT,
  truncated: GAP_CATEGORIES.LIMIT,
  dropped: GAP_CATEGORIES.DROPPED,
  evicted: GAP_CATEGORIES.DROPPED,
  'buffer-overflow': GAP_CATEGORIES.DROPPED,
  'ring-limit': GAP_CATEGORIES.DROPPED,
  failed: GAP_CATEGORIES.FAILED,
  'request-failed': GAP_CATEGORIES.FAILED,
  'collect-failed': GAP_CATEGORIES.FAILED,
  pending: GAP_CATEGORIES.INCOMPLETE,
  'still-open': GAP_CATEGORIES.INCOMPLETE,
  'no-data': GAP_CATEGORIES.INCOMPLETE,
  incomplete: GAP_CATEGORIES.INCOMPLETE,
  unsupported: GAP_CATEGORIES.UNSUPPORTED,
});

export function classifyGapReason(reason) {
  const key = String(reason == null ? '' : reason);
  return GAP_REASON_CATEGORIES[key] || GAP_CATEGORIES.UNSUPPORTED;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ratio(part, total) {
  const denominator = Number(total);
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.max(0, Math.min(1, Number(part) / denominator));
}

function average(values) {
  const list = values.filter((value) => Number.isFinite(value));
  if (!list.length) return null;
  return Math.round((list.reduce((sum, value) => sum + value, 0) / list.length) * 1000) / 1000;
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

/** 把 trace 入参（数组 / {traceEvents} / Trace v3 steps）归一成 trace event 数。 */
export function countTraceEvents(trace) {
  if (trace == null) return { subscribed: false, count: 0 };
  if (Array.isArray(trace)) return { subscribed: true, count: trace.length };
  if (Array.isArray(trace.traceEvents)) return { subscribed: true, count: trace.traceEvents.length };
  if (Array.isArray(trace.events)) return { subscribed: true, count: trace.events.length };
  return { subscribed: true, count: 0 };
}

/** 归一 websockets 入参（{sockets,total} 或数组）。 */
export function normalizeWebSockets(websockets) {
  if (websockets == null) return { subscribed: false, sockets: [], total: 0 };
  if (Array.isArray(websockets)) return { subscribed: true, sockets: websockets, total: websockets.length };
  if (typeof websockets === 'object') {
    const sockets = Array.isArray(websockets.sockets) ? websockets.sockets : [];
    return { subscribed: true, sockets, total: toCount(websockets.total) || sockets.length };
  }
  return { subscribed: false, sockets: [], total: 0 };
}

/** 归一 journal 入参（store.snapshot() 或事件数组）。 */
export function normalizeJournal(journal) {
  if (journal == null) return { available: false, events: [], evictions: { total: 0, counts: {}, sessions: {}, recent: [] } };
  if (Array.isArray(journal)) {
    return { available: true, events: journal, evictions: { total: 0, counts: {}, sessions: {}, recent: [] }, seq: null, bytes: null };
  }
  const events = Array.isArray(journal.events) ? journal.events : [];
  const evictions = isPlainObject(journal.evictions)
    ? {
      total: toCount(journal.evictions.total),
      counts: isPlainObject(journal.evictions.counts) ? { ...journal.evictions.counts } : {},
      sessions: isPlainObject(journal.evictions.sessions) ? { ...journal.evictions.sessions } : {},
      recent: Array.isArray(journal.evictions.recent) ? journal.evictions.recent.slice(-20) : [],
    }
    : { total: 0, counts: {}, sessions: {}, recent: [] };
  return {
    available: true,
    events,
    evictions,
    seq: Number.isFinite(Number(journal.seq)) ? Number(journal.seq) : null,
    bytes: Number.isFinite(Number(journal.bytes)) ? Number(journal.bytes) : null,
  };
}

/** 构造一条 gap（内部统一入口，保证 category 一定存在）。 */
function makeGap({ kind, phase, reason, count = null, detail = null }) {
  const gap = {
    kind: String(kind),
    phase: String(phase),
    reason: String(reason),
    category: classifyGapReason(reason),
    count: count == null ? null : toCount(count),
  };
  if (detail && typeof detail === 'object') gap.detail = detail;
  return gap;
}

function requestCounts(requests) {
  let finished = 0;
  let pending = 0;
  let failed = 0;
  let httpErrors = 0;
  let bytes = 0;
  for (const request of requests) {
    if (!request || typeof request !== 'object') continue;
    const status = request.status == null ? null : Number(request.status);
    bytes += toCount(request.responseBytes);
    if (status == null) pending += 1;
    else finished += 1;
    if (status === 0 || request.error) failed += 1;
    if (Number.isFinite(status) && status >= 400) httpErrors += 1;
  }
  return { finished, pending, failed, httpErrors, bytes };
}

function phaseEntry({ observed, subscribed, count, total = null, truncated = false, detail = null }) {
  const entry = {
    observed: observed === true,
    subscribed: subscribed === true,
    count: toCount(count),
    total: total == null ? null : toCount(total),
    truncated: truncated === true,
    ratio: total == null ? (observed ? 1 : (subscribed ? 0 : null)) : ratio(count, total),
  };
  if (detail && typeof detail === 'object') entry.detail = detail;
  return entry;
}

/**
 * 构建覆盖率与缺口报告。
 *
 * @param {{
 *   session?: object,            // { id, tabId, active, bodies, startedAt, endedAt }
 *   requests?: object[],         // network 列表（requestId/method/url/status/…）
 *   requestsTotal?: number,      // 采集侧总数（可能大于本次取回的条数）
 *   console?: object[],          // console 条目
 *   consoleTotal?: number,
 *   consoleError?: string|null,  // console 采集失败原因
 *   frames?: object[]|null,      // webNavigation.getAllFrames 结果；null = 未订阅
 *   frameTotal?: number,
 *   websockets?: object|object[]|null,
 *   trace?: object|object[]|null,
 *   screenshots?: object[]|null,
 *   journal?: object|object[]|null,
 *   limits?: { requests?: number, console?: number },
 *   now?: number,
 * }} [input]
 */
export function buildDebugCoverage(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const now = Number.isFinite(Number(source.now)) ? Number(source.now) : Date.now();
  const session = isPlainObject(source.session) ? source.session : {};
  const requests = (Array.isArray(source.requests) ? source.requests : []).filter((item) => item && typeof item === 'object');
  const consoleEntries = (Array.isArray(source.console) ? source.console : []).filter((item) => item && typeof item === 'object');
  const requestsTotal = Math.max(toCount(source.requestsTotal), requests.length);
  const consoleTotal = Math.max(toCount(source.consoleTotal), consoleEntries.length);
  const journal = normalizeJournal(source.journal);
  const websockets = normalizeWebSockets(source.websockets);
  const trace = countTraceEvents(source.trace);
  const screenshots = Array.isArray(source.screenshots) ? source.screenshots.filter((item) => item && typeof item === 'object') : null;
  const frames = Array.isArray(source.frames) ? source.frames.filter((item) => item && typeof item === 'object') : null;
  const bodies = session.bodies === true || source.bodies === true;
  const active = source.active === true || (session.active !== false && Boolean(session.id || session.tabId != null || session.startedAt));
  const startedAt = Number.isFinite(Number(session.startedAt)) ? Number(session.startedAt) : null;
  const endedAt = Number.isFinite(Number(session.endedAt)) ? Number(session.endedAt) : null;
  const counts = requestCounts(requests);
  const journalByType = {};
  for (const event of journal.events) {
    const type = String((event && event.type) || 'event');
    journalByType[type] = (journalByType[type] || 0) + 1;
  }

  const phases = {
    session: phaseEntry({
      observed: Boolean(session.id || session.tabId != null || startedAt),
      subscribed: true,
      count: session.id || session.tabId != null || startedAt ? 1 : 0,
      total: 1,
      detail: { active, bodies },
    }),
    network: phaseEntry({
      observed: requests.length > 0,
      subscribed: active,
      count: requests.length,
      total: requestsTotal,
      truncated: requestsTotal > requests.length,
      detail: { finished: counts.finished, pending: counts.pending, failed: counts.failed, httpErrors: counts.httpErrors },
    }),
    console: phaseEntry({
      observed: consoleEntries.length > 0,
      subscribed: active,
      count: consoleEntries.length,
      total: consoleTotal,
      truncated: consoleTotal > consoleEntries.length,
      detail: source.consoleError ? { error: String(source.consoleError) } : undefined,
    }),
    frames: phaseEntry({
      observed: frames != null && frames.length > 0,
      subscribed: frames != null,
      count: frames ? frames.length : 0,
      total: frames == null ? null : Math.max(toCount(source.frameTotal), frames.length),
      detail: frames == null ? { reason: 'frames-not-observed' } : undefined,
    }),
    websockets: phaseEntry({
      observed: websockets.sockets.length > 0,
      subscribed: websockets.subscribed,
      count: websockets.sockets.length,
      total: websockets.subscribed ? websockets.total : null,
    }),
    trace: phaseEntry({
      observed: trace.count > 0,
      subscribed: trace.subscribed,
      count: trace.count,
      total: trace.subscribed ? trace.count : null,
    }),
    screenshots: phaseEntry({
      observed: screenshots != null && screenshots.length > 0,
      subscribed: screenshots != null,
      count: screenshots ? screenshots.length : 0,
      total: screenshots == null ? null : screenshots.length,
    }),
    journal: phaseEntry({
      observed: journal.events.length > 0,
      subscribed: journal.available,
      count: journal.events.length,
      total: journal.available ? journal.events.length + journal.evictions.total : null,
      truncated: journal.evictions.total > 0,
      detail: { byType: journalByType, evictions: journal.evictions.total, seq: journal.seq, bytes: journal.bytes },
    }),
  };

  const gaps = [];
  if (!active) {
    gaps.push(makeGap({ kind: 'session-inactive', phase: 'session', reason: 'not-subscribed', detail: { hint: '先 debug.start 再采集' } }));
  }
  // ---- network ----
  if (requestsTotal > requests.length) {
    gaps.push(makeGap({
      kind: 'network-buffer',
      phase: 'network',
      reason: 'limit',
      count: requestsTotal - requests.length,
      detail: { kept: requests.length, total: requestsTotal, limit: source.limits && source.limits.requests != null ? toCount(source.limits.requests) : null },
    }));
  }
  if (counts.pending > 0) {
    gaps.push(makeGap({ kind: 'request-pending', phase: 'network', reason: 'incomplete', count: counts.pending, detail: { hint: '请求在采集窗口结束前未收到响应' } }));
  }
  if (counts.failed > 0) {
    gaps.push(makeGap({ kind: 'request-failed', phase: 'network', reason: 'failed', count: counts.failed, detail: { hint: 'status=0 或带 error 的请求没有可用响应体' } }));
  }
  if (active && requests.length > 0 && !bodies) {
    gaps.push(makeGap({ kind: 'response-body', phase: 'network', reason: 'bodies-not-enabled', count: requests.length, detail: { hint: 'debug.start bodies=false，只采集元数据' } }));
  }
  if (active && requestsTotal === 0) {
    gaps.push(makeGap({ kind: 'network-empty', phase: 'network', reason: 'no-data', detail: { hint: '采集窗口内没有任何网络请求' } }));
  }
  // ---- console ----
  if (consoleTotal > consoleEntries.length) {
    gaps.push(makeGap({ kind: 'console-buffer', phase: 'console', reason: 'limit', count: consoleTotal - consoleEntries.length, detail: { kept: consoleEntries.length, total: consoleTotal } }));
  }
  if (source.consoleError) {
    gaps.push(makeGap({ kind: 'console-collect', phase: 'console', reason: 'collect-failed', detail: { error: String(source.consoleError) } }));
  }
  // ---- frames / websockets / trace / screenshots ----
  if (frames == null) {
    gaps.push(makeGap({ kind: 'frames-subscription', phase: 'frames', reason: 'frames-not-observed', detail: { hint: '未提供 webNavigation 帧列表，跨帧缺口无法判断' } }));
  } else if (frames.length === 0) {
    gaps.push(makeGap({ kind: 'frames-empty', phase: 'frames', reason: 'no-data' }));
  } else {
    const erroredFrames = frames.filter((frame) => frame && frame.errorOccurred === true);
    if (erroredFrames.length) {
      gaps.push(makeGap({
        kind: 'frames-error',
        phase: 'frames',
        reason: 'failed',
        count: erroredFrames.length,
        detail: { frameIds: erroredFrames.slice(0, 10).map((frame) => frame.frameId) },
      }));
    }
  }
  if (!websockets.subscribed) {
    gaps.push(makeGap({ kind: 'websockets-subscription', phase: 'websockets', reason: 'websockets-not-observed' }));
  }
  if (!trace.subscribed) {
    gaps.push(makeGap({ kind: 'trace-subscription', phase: 'trace', reason: 'tracing-not-started', detail: { hint: '未传 trace，requestId ↔ trace 事件关联为空' } }));
  } else if (trace.count === 0) {
    gaps.push(makeGap({ kind: 'trace-empty', phase: 'trace', reason: 'no-data' }));
  }
  if (screenshots == null) {
    gaps.push(makeGap({ kind: 'screenshots-subscription', phase: 'screenshots', reason: 'screenshots-not-observed', detail: { hint: '未传截图时间线，截图↔请求关联为空' } }));
  }
  // ---- journal ----
  if (!journal.available) {
    gaps.push(makeGap({ kind: 'journal-subscription', phase: 'journal', reason: 'journal-not-attached' }));
  } else if (journal.evictions.total > 0) {
    gaps.push(makeGap({
      kind: 'journal-eviction',
      phase: 'journal',
      reason: 'evicted',
      count: journal.evictions.total,
      detail: {
        byReason: journal.evictions.counts,
        recent: journal.evictions.recent.slice(-8),
      },
    }));
  }

  const phaseScores = COVERAGE_PHASES.map((phase) => phases[phase] && phases[phase].ratio).filter((value) => Number.isFinite(value));
  const subscribedPhases = COVERAGE_PHASES.filter((phase) => phases[phase].subscribed);
  const observedPhases = COVERAGE_PHASES.filter((phase) => phases[phase].observed);
  const requestRatio = requestsTotal > 0 ? ratio(counts.finished, requestsTotal) : null;
  const consoleRatio = consoleTotal > 0 ? ratio(consoleEntries.length, consoleTotal) : null;
  const journalRatio = journal.available
    ? ratio(journal.events.length, journal.events.length + journal.evictions.total)
    : null;
  const score = !active
    ? { phase: null, request: null, console: null, journal: null, overall: null }
    : {
      phase: average(phaseScores),
      request: requestRatio,
      console: consoleRatio,
      journal: journalRatio,
      overall: average([average(phaseScores), requestRatio, consoleRatio, journalRatio]),
    };

  const coverage = {
    version: COVERAGE_VERSION,
    phases,
    counts: {
      requests: { observed: requests.length, total: requestsTotal, ...counts },
      console: { observed: consoleEntries.length, total: consoleTotal },
      frames: { observed: frames ? frames.length : 0, subscribed: frames != null, errors: frames ? frames.filter((frame) => frame && frame.errorOccurred === true).length : 0 },
      websockets: { observed: websockets.sockets.length, total: websockets.total },
      trace: { observed: trace.count, subscribed: trace.subscribed },
      screenshots: { observed: screenshots ? screenshots.length : 0, subscribed: screenshots != null },
      journal: { observed: journal.events.length, evicted: journal.evictions.total, byType: journalByType },
      session: { active, bodies, startedAt, endedAt, durationMs: startedAt == null ? null : Math.max(0, (endedAt || now) - startedAt) },
    },
    score,
    subscribedPhases,
    observedPhases,
    complete: gaps.length === 0,
  };

  return {
    version: COVERAGE_VERSION,
    generatedAt: new Date(now).toISOString(),
    session: {
      id: session.id == null ? null : String(session.id),
      tabId: session.tabId == null ? null : Number(session.tabId),
      active,
      bodies,
      startedAt,
      endedAt,
      durationMs: startedAt == null ? null : Math.max(0, (endedAt || now) - startedAt),
    },
    coverage,
    gaps,
    complete: gaps.length === 0,
  };
}

/** 按 category 聚合 gaps（debug.history 元数据 / 报告用）。 */
export function gapCountsByCategory(gaps) {
  const counts = {};
  for (const gap of Array.isArray(gaps) ? gaps : []) {
    if (!gap) continue;
    const category = gap.category || classifyGapReason(gap.reason);
    counts[category] = (counts[category] || 0) + 1;
  }
  return counts;
}

/** 报告压缩摘要（写 history 索引 / 日志时用，避免存整份 coverage）。 */
export function summarizeCoverage(report) {
  const source = isPlainObject(report) ? report : {};
  const coverage = isPlainObject(source.coverage) ? source.coverage : source;
  const gaps = Array.isArray(source.gaps) ? source.gaps : [];
  return {
    version: COVERAGE_VERSION,
    complete: gaps.length === 0,
    score: isPlainObject(coverage.score) ? coverage.score : null,
    gaps: gaps.length,
    categories: gapCountsByCategory(gaps),
    phases: COVERAGE_PHASES.reduce((out, phase) => {
      const entry = coverage.phases && coverage.phases[phase];
      if (entry) out[phase] = { subscribed: entry.subscribed === true, observed: entry.observed === true, count: entry.count };
      return out;
    }, {}),
  };
}

/** 便捷判定：报告里是否存在某个根因分类的缺口。 */
export function hasGapCategory(report, category) {
  const source = isPlainObject(report) ? report : {};
  const wanted = String(category);
  return (Array.isArray(source.gaps) ? source.gaps : []).some((gap) => gap && (gap.category || classifyGapReason(gap.reason)) === wanted);
}
