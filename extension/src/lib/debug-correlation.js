// src/lib/debug-correlation.js —— requestId ↔ trace 事件 ↔ 截图/时间线 关联与查询。
//
// 调试采集中网络、trace、截图、journal 是四条独立管线：network.js 产出请求
// （requestId/url/status/耗时），tracing.js 产出 CDP traceEvents（args.data.requestId /
// args.data.url），长截图 manifest 产出带时间戳的截图，debug-events 产出动作事件。
// 本模块把它们合成「一个请求一条 link」，并提供：
//
//   - buildDebugCorrelation：按 requestId 优先、URL 兜底关联 trace；按时间窗关联截图
//     （有显式 requestId 时优先）；按时间窗/commandId 关联 journal 事件；输出统一 timeline；
//   - aggregateByRequestId：同一请求可能同时出现在 network 与 HAR（requestId 缺失时按
//     method+URL+秒级时间归并），合并成一个 record 并保留 sources；
//   - queryRequests：url/method/status/时间窗过滤 + 分页（offset/limit 或 page），
//     返回 total / hasMore / nextOffset（debug.history.detail 与离线导出复用）；
//   - summarizeCorrelation：压缩摘要（落 history 索引，避免把整份 trace 写进 storage）。
//
// 纯函数：clock/window 可注入，不依赖 chrome/DOM。
export const CORRELATION_VERSION = 1;
export const DEFAULT_LINK_WINDOW_MS = 5000;
export const DEFAULT_SCREENSHOT_WINDOW_MS = 2500;
export const MAX_TRACE_EVENTS_PER_LINK = 20;
export const MAX_SCREENSHOTS_PER_LINK = 3;
export const MAX_JOURNAL_EVENTS_PER_LINK = 8;
export const DEFAULT_JOURNAL_WINDOW_MS = 2000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstFinite(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function toAbsoluteTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function urlKey(raw) {
  const value = String(raw == null ? '' : raw);
  try {
    const parsed = new URL(value);
    return parsed.origin + parsed.pathname;
  } catch {
    return value.split('?')[0].split('#')[0];
  }
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

/**
 * 归一一条请求记录。兼容三种来源：
 *   - network.js publicEntry：{ id, requestId, method, url, status, startedAt, durationMs }
 *   - HAR 1.2 entry：{ startedDateTime, time, request: { method, url }, response: { status } }
 *   - 归档/导出的扁平记录（同上字段名）。
 */
export function normalizeRequestRecord(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const harRequest = isPlainObject(raw.request) ? raw.request : null;
  const harResponse = isPlainObject(raw.response) ? raw.response : null;
  const isHar = Boolean(harRequest);
  const method = String((harRequest && harRequest.method) || raw.method || 'GET').toUpperCase();
  const url = String((harRequest && harRequest.url) || raw.url || '');
  if (!url) return null;
  const startedAt = firstFinite(
    raw.startedAt,
    toAbsoluteTime(raw.startedDateTime),
    toAbsoluteTime(raw.started),
    toAbsoluteTime(raw.at),
  );
  const durationMs = firstFinite(raw.durationMs, raw.time, raw.duration);
  const status = firstFinite(
    raw.status,
    harResponse && harResponse.status,
    raw.statusCode,
  );
  let requestId;
  let generatedRequestId = false;
  if (raw.requestId != null) requestId = String(raw.requestId);
  else if (raw.request_id != null) requestId = String(raw.request_id);
  else if (!isHar && raw.id != null) requestId = 'req-' + String(raw.id);
  else {
    requestId = 'har-' + (index + 1);
    generatedRequestId = true;
  }
  return {
    requestId,
    generatedRequestId,
    id: raw.id == null ? index + 1 : raw.id,
    method,
    url,
    status: status == null ? null : Math.floor(status),
    type: String(raw.type || (isHar ? 'har' : '')),
    startedAt,
    durationMs: durationMs == null ? null : Math.max(0, Math.round(durationMs)),
    endAt: startedAt == null ? null : startedAt + Math.max(0, Math.round(durationMs || 0)),
    commandId: raw.commandId == null ? null : String(raw.commandId),
    error: raw.error ? String(raw.error) : null,
    pageUrl: String(raw.pageUrl || ''),
    requestBytes: Math.max(toCount(raw.requestBytes), toCount(harRequest && harRequest.bodySize)),
    responseBytes: Math.max(toCount(raw.responseBytes), toCount(harResponse && harResponse.bodySize)),
    source: String(raw.source || (isHar ? 'har' : 'network')),
  };
}

/** HAR.log.entries → 可关联请求记录。 */
export function parseHarEntriesForCorrelation(har) {
  const entries = Array.isArray(har && har.log && har.log.entries)
    ? har.log.entries
    : (Array.isArray(har) ? har : []);
  return entries.map((entry, index) => normalizeRequestRecord(entry, index)).filter(Boolean);
}

function traceData(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (isPlainObject(raw.args) && isPlainObject(raw.args.data)) return raw.args.data;
  if (isPlainObject(raw.args)) return raw.args;
  if (isPlainObject(raw.data)) return raw.data;
  return {};
}

/**
 * 归一一条 CDP trace 事件。ts 单位是 µs，这里换算成相对毫秒（tsMs）；
 * 若给了 traceOrigin（trace 开始的绝对 wall time，ms），同时给出绝对时间 at。
 */
export function normalizeTraceEvent(raw, { traceOrigin = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const data = traceData(raw);
  if (!data) return null;
  const requestId = data.requestId != null ? data.requestId : (raw.requestId != null ? raw.requestId : null);
  const url = data.url
    || (isPlainObject(data.request) && data.request.url)
    || data.documentURL
    || raw.url
    || '';
  const ts = firstFinite(raw.ts, raw.timestamp);
  const tsMs = ts == null ? firstFinite(raw.at, raw.tsMs) : ts / 1000;
  const dur = firstFinite(raw.dur, raw.duration);
  const durMs = dur == null ? null : dur / 1000;
  const origin = firstFinite(traceOrigin);
  const absolute = raw.at != null && Number.isFinite(Number(raw.at)) ? Number(raw.at) : null;
  const at = absolute != null ? absolute : (origin != null && tsMs != null ? origin + tsMs : null);
  return {
    name: String(raw.name || raw.type || 'trace'),
    cat: String(raw.cat || raw.category || ''),
    ts: tsMs,
    durMs,
    at,
    requestId: requestId == null ? null : String(requestId),
    url: String(url || ''),
    phase: raw.ph == null ? null : String(raw.ph),
    thread: raw.tid == null ? null : String(raw.tid),
    process: raw.pid == null ? null : String(raw.pid),
    args: isPlainObject(data) ? {
      ...(data.method ? { method: String(data.method) } : {}),
      ...(data.statusCode != null ? { statusCode: Number(data.statusCode) } : {}),
      ...(data.encodedDataLength != null ? { encodedDataLength: Number(data.encodedDataLength) } : {}),
    } : undefined,
  };
}

/** 归一截图时间线条目。 */
export function normalizeScreenshot(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const at = firstFinite(raw.at, raw.ts, toAbsoluteTime(raw.createdAt), toAbsoluteTime(raw.takenAt));
  if (at == null) return null;
  return {
    id: raw.id == null ? 'shot-' + (index + 1) : String(raw.id),
    at,
    kind: String(raw.kind || raw.type || 'screenshot'),
    url: String(raw.url || ''),
    width: toCount(raw.width),
    height: toCount(raw.height),
    label: raw.label == null ? '' : String(raw.label),
    requestId: raw.requestId == null ? null : String(raw.requestId),
  };
}

function linkKey(record) {
  if (record.requestId && !record.generatedRequestId) return 'id:' + record.requestId;
  const second = record.startedAt == null ? 'na' : String(Math.floor(record.startedAt / 1000));
  return 'url:' + record.method + ' ' + urlKey(record.url) + ' ' + second;
}

function sourcesOf(record) {
  if (Array.isArray(record.sources) && record.sources.length) return record.sources.filter(Boolean);
  return [record.source || 'network'];
}

function mergeInto(target, record) {
  const merged = { ...target };
  for (const field of ['status', 'startedAt', 'durationMs', 'endAt', 'commandId', 'error', 'type', 'pageUrl']) {
    if (merged[field] == null && record[field] != null) merged[field] = record[field];
  }
  merged.requestBytes = Math.max(toCount(merged.requestBytes), toCount(record.requestBytes));
  merged.responseBytes = Math.max(toCount(merged.responseBytes), toCount(record.responseBytes));
  merged.id = merged.id == null ? record.id : merged.id;
  merged.sources = [...new Set([...sourcesOf(merged), ...sourcesOf(record)])];
  return merged;
}

/**
 * 合并同一请求的重复记录（network + HAR 等），保留 sources 与更完整的字段。
 * 无 requestId 的 HAR 记录按 method + URL（忽略 query）+ 2s 时间邻域合并到网络记录上，
 * 这样 requestId ↔ trace 关联不会被 HAR 复制一份。
 */
export function mergeRequestRecords(records) {
  const groups = new Map();
  const urlGroups = new Map();
  for (const record of (Array.isArray(records) ? records : [])) {
    if (!record) continue;
    if (record.generatedRequestId) {
      const key = record.method + ' ' + urlKey(record.url);
      const candidates = (urlGroups.get(key) || []).filter((item) => {
        if (item.startedAt == null || record.startedAt == null) return true;
        return Math.abs(item.startedAt - record.startedAt) <= 2000;
      });
      const match = candidates[0];
      if (match) {
        const groupKey = linkKey(match);
        groups.set(groupKey, mergeInto(groups.get(groupKey) || { ...match, sources: sourcesOf(match) }, record));
        continue;
      }
      const ownKey = 'har:' + record.requestId;
      groups.set(ownKey, { ...record, sources: sourcesOf(record) });
      // 单独的 HAR 记录也登记到 urlGroups，后续同 URL 的 HAR 可以合并到它上面。
      const ownUrlKey = record.method + ' ' + urlKey(record.url);
      if (!urlGroups.has(ownUrlKey)) urlGroups.set(ownUrlKey, []);
      urlGroups.get(ownUrlKey).push(record);
      continue;
    }
    const key = linkKey(record);
    const current = groups.get(key);
    groups.set(key, current ? mergeInto(current, record) : { ...record, sources: sourcesOf(record) });
    const urlGroupKey = record.method + ' ' + urlKey(record.url);
    if (!urlGroups.has(urlGroupKey)) urlGroups.set(urlGroupKey, []);
    urlGroups.get(urlGroupKey).push(record);
  }
  return [...groups.values()];
}

function collectTraceBuckets(traceEvents, { traceOrigin = null } = {}) {
  const byRequestId = new Map();
  const byUrl = new Map();
  const byUrlKey = new Map();
  const events = [];
  let aligned = traceOrigin != null;
  for (const raw of Array.isArray(traceEvents) ? traceEvents : []) {
    const event = normalizeTraceEvent(raw, { traceOrigin });
    if (!event) continue;
    events.push(event);
    if (event.at != null) aligned = true;
    if (event.requestId) {
      if (!byRequestId.has(event.requestId)) byRequestId.set(event.requestId, []);
      byRequestId.get(event.requestId).push(event);
    }
    if (event.url) {
      if (!byUrl.has(event.url)) byUrl.set(event.url, []);
      byUrl.get(event.url).push(event);
      const key = urlKey(event.url);
      if (!byUrlKey.has(key)) byUrlKey.set(key, []);
      byUrlKey.get(key).push(event);
    }
  }
  return { events, byRequestId, byUrl, byUrlKey, aligned };
}

function summarizeTraceEvents(events) {
  const names = new Map();
  let totalDurationMs = 0;
  for (const event of events) {
    names.set(event.name, (names.get(event.name) || 0) + 1);
    if (Number.isFinite(event.durMs)) totalDurationMs += event.durMs;
  }
  const longest = events
    .filter((event) => Number.isFinite(event.durMs))
    .sort((left, right) => right.durMs - left.durMs)
    .slice(0, 5)
    .map((event) => ({ name: event.name, cat: event.cat, durMs: Math.round(event.durMs * 100) / 100, ts: event.ts }));
  return {
    count: events.length,
    totalDurationMs: Math.round(totalDurationMs * 100) / 100,
    topNames: [...names.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count })),
    longest,
  };
}

function pickScreenshots(screenshots, request, { windowMs, used }) {
  const picked = [];
  if (request.startedAt == null) return picked;
  const start = request.startedAt - windowMs;
  const end = (request.endAt == null ? request.startedAt : request.endAt) + windowMs;
  const candidates = [];
  for (const shot of screenshots) {
    if (!shot) continue;
    let hit = false;
    if (request.requestId && shot.requestId && shot.requestId === request.requestId) hit = true;
    else if (shot.at >= start && shot.at <= end) hit = true;
    if (!hit) continue;
    const deltaMs = shot.at - request.startedAt;
    candidates.push({ ...shot, deltaMs });
  }
  candidates.sort((left, right) => Math.abs(left.deltaMs) - Math.abs(right.deltaMs));
  for (const candidate of candidates.slice(0, MAX_SCREENSHOTS_PER_LINK)) {
    const key = candidate.id;
    picked.push({
      id: key,
      at: candidate.at,
      deltaMs: candidate.deltaMs,
      kind: candidate.kind,
      width: candidate.width,
      height: candidate.height,
      label: candidate.label,
      nearest: Math.abs(candidate.deltaMs) === Math.abs(candidates[0].deltaMs),
    });
    used.add(key);
  }
  return picked;
}

function pickJournalEvents(journalEvents, request, { windowMs }) {
  if (request.startedAt == null) return [];
  // 动作事件比截图稀疏，用更紧的窗口，避免把几秒前的无关动作算进请求。
  const effective = Math.min(windowMs, DEFAULT_JOURNAL_WINDOW_MS);
  const start = request.startedAt - effective;
  const end = (request.endAt == null ? request.startedAt : request.endAt) + effective;
  const picked = [];
  for (const event of journalEvents) {
    if (!event || !Number.isFinite(Number(event.at))) continue;
    const at = Number(event.at);
    const direct = (event.requestId != null && request.requestId && String(event.requestId) === request.requestId)
      || (event.id != null && request.id != null && String(event.id) === String(request.id));
    if (!direct && (at < start || at > end)) continue;
    picked.push({
      seq: Number.isFinite(Number(event.seq)) ? Number(event.seq) : null,
      type: String(event.type || 'event'),
      at,
      deltaMs: at - request.startedAt,
      direct: Boolean(direct),
    });
    if (picked.length >= MAX_JOURNAL_EVENTS_PER_LINK) break;
  }
  return picked;
}

/**
 * 构建关联报告。
 * @param {{
 *   session?: object,
 *   requests?: object[],
 *   har?: object,
 *   trace?: object[]|{traceEvents: object[]},
 *   traceOrigin?: number|null,
 *   screenshots?: object[],
 *   journal?: object[]|{events: object[]},
 *   windowMs?: number,
 *   screenshotWindowMs?: number,
 *   now?: number,
 *   limit?: number,
 * }} [input]
 */
export function buildDebugCorrelation(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const now = Number.isFinite(Number(source.now)) ? Number(source.now) : Date.now();
  const windowMs = Number.isFinite(Number(source.windowMs)) && Number(source.windowMs) >= 0
    ? Number(source.windowMs)
    : DEFAULT_LINK_WINDOW_MS;
  const screenshotWindowMs = Number.isFinite(Number(source.screenshotWindowMs)) && Number(source.screenshotWindowMs) >= 0
    ? Number(source.screenshotWindowMs)
    : DEFAULT_SCREENSHOT_WINDOW_MS;

  const networkRecords = (Array.isArray(source.requests) ? source.requests : [])
    .map((raw, index) => normalizeRequestRecord(raw, index))
    .filter(Boolean);
  const harRecords = source.har ? parseHarEntriesForCorrelation(source.har) : [];
  const records = mergeRequestRecords([...networkRecords, ...harRecords]);

  const traceInput = Array.isArray(source.trace)
    ? source.trace
    : (Array.isArray(source.trace && source.trace.traceEvents) ? source.trace.traceEvents : []);
  const traceOrigin = firstFinite(source.traceOrigin, source.trace && source.trace.startedAt);
  const traceBuckets = collectTraceBuckets(traceInput, { traceOrigin });

  const screenshots = (Array.isArray(source.screenshots) ? source.screenshots : [])
    .map((raw, index) => normalizeScreenshot(raw, index))
    .filter(Boolean)
    .sort((left, right) => left.at - right.at);
  const journalEvents = Array.isArray(source.journal && source.journal.events)
    ? source.journal.events
    : (Array.isArray(source.journal) ? source.journal : []);

  const linkedTraceSeqs = new Set();
  const usedScreenshots = new Set();
  const links = [];
  const unlinked = [];
  for (const record of records) {
    const byId = record.requestId ? (traceBuckets.byRequestId.get(record.requestId) || []) : [];
    let traceEvents = byId;
    let matchKind = byId.length ? 'requestId' : null;
    if (!traceEvents.length && record.url) {
      const exact = traceBuckets.byUrl.get(record.url) || [];
      if (exact.length) {
        traceEvents = exact;
        matchKind = 'url';
      } else {
        const keyed = traceBuckets.byUrlKey.get(urlKey(record.url)) || [];
        if (keyed.length) {
          traceEvents = keyed;
          matchKind = 'url-key';
        }
      }
    }
    traceEvents = traceEvents.slice()
      .sort((left, right) => (left.ts == null ? 0 : left.ts) - (right.ts == null ? 0 : right.ts))
      .slice(0, MAX_TRACE_EVENTS_PER_LINK);
    for (const event of traceEvents) {
      if (event.requestId) linkedTraceSeqs.add(event.requestId);
      else if (event.at != null) linkedTraceSeqs.add('at:' + event.at + ':' + event.name);
    }
    const shots = pickScreenshots(screenshots, record, { windowMs: screenshotWindowMs, used: usedScreenshots });
    const journal = pickJournalEvents(journalEvents, record, { windowMs });
    const link = {
      ...record,
      trace: {
        matchedBy: matchKind,
        ...summarizeTraceEvents(traceEvents),
        events: traceEvents.map((event) => ({
          name: event.name,
          cat: event.cat,
          ts: event.ts,
          at: event.at,
          durMs: event.durMs,
          requestId: event.requestId,
          url: event.url,
        })),
      },
      screenshots: shots,
      journal,
      correlated: {
        trace: traceEvents.length > 0,
        screenshots: shots.length > 0,
        journal: journal.length > 0,
        any: traceEvents.length > 0 || shots.length > 0 || journal.length > 0,
      },
    };
    if (!link.correlated.any) {
      unlinked.push({
        requestId: record.requestId,
        id: record.id,
        method: record.method,
        url: record.url,
        reason: traceBuckets.aligned ? 'no-trace-screenshot-journal' : 'no-trace-screenshot-journal-or-time-unaligned',
      });
    }
    links.push(link);
  }

  const orphanTraceEvents = traceBuckets.events.filter((event) => {
    if (event.requestId) return !linkedTraceSeqs.has(event.requestId);
    if (event.at != null) return !linkedTraceSeqs.has('at:' + event.at + ':' + event.name);
    return true;
  }).slice(0, 50);

  const byRequestId = {};
  for (const link of links) {
    byRequestId[link.requestId] = {
      requestId: link.requestId,
      id: link.id,
      method: link.method,
      url: link.url,
      status: link.status,
      traceEvents: link.trace.count,
      screenshots: link.screenshots.length,
      journalEvents: link.journal.length,
      correlated: link.correlated,
    };
  }

  const timeline = buildTimeline(links, { limit: Number(source.limit) || 500, includeTrace: true });
  const byMethod = {};
  const byStatus = {};
  for (const link of links) {
    byMethod[link.method] = (byMethod[link.method] || 0) + 1;
    const statusKey = link.status == null ? 'pending' : String(link.status);
    byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;
  }
  const slowest = links
    .filter((link) => Number.isFinite(link.durationMs))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 5)
    .map((link) => ({ requestId: link.requestId, url: link.url, durationMs: link.durationMs }));

  return {
    version: CORRELATION_VERSION,
    generatedAt: new Date(now).toISOString(),
    session: isPlainObject(source.session) ? {
      id: source.session.id == null ? null : String(source.session.id),
      tabId: source.session.tabId == null ? null : Number(source.session.tabId),
    } : null,
    timeAligned: traceBuckets.aligned,
    windowMs,
    screenshotWindowMs,
    links,
    byRequestId,
    unlinked,
    orphanTraceEvents,
    timeline,
    summary: {
      requests: links.length,
      linked: links.filter((link) => link.correlated.any).length,
      unlinked: unlinked.length,
      traceEvents: traceBuckets.events.length,
      linkedTraceEvents: traceBuckets.events.filter((event) => (event.requestId ? linkedTraceSeqs.has(event.requestId) : false)).length,
      orphanTraceEvents: orphanTraceEvents.length,
      screenshots: screenshots.length,
      linkedScreenshots: usedScreenshots.size,
      journalEvents: journalEvents.length,
      linkedJournalEvents: links.reduce((sum, link) => sum + link.journal.length, 0),
      timeAligned: traceBuckets.aligned,
      byMethod,
      byStatus,
      slowest,
    },
  };
}

/**
 * 请求查询：url/method/status/时间窗过滤 + 分页。
 * 入参可以是 normalizeRequestRecord 结果，也可以是 links（自动取 request 字段）。
 */
export function queryRequests(records, filters = {}) {
  const source = isPlainObject(filters) ? filters : {};
  const items = Array.isArray(records) ? records.filter(Boolean) : [];
  const urlFilter = source.url;
  const method = source.method == null ? '' : String(source.method).toUpperCase();
  const statusFilter = source.status;
  const requestId = source.requestId == null ? '' : String(source.requestId);
  const commandId = source.commandId == null ? '' : String(source.commandId);
  const windowSource = isPlainObject(source.timeWindow) ? source.timeWindow : {};
  const since = firstFinite(source.since, windowSource.from, source.from);
  const until = firstFinite(source.until, windowSource.to, source.to);
  const types = source.type == null ? null : new Set((Array.isArray(source.type) ? source.type : [source.type]).map(String));
  const statusRange = isPlainObject(statusFilter) ? statusFilter : null;
  const statusList = Array.isArray(statusFilter) ? statusFilter.map(Number) : null;

  const matched = items.filter((item) => {
    const record = isPlainObject(item.request) ? { ...item.request, ...item } : item;
    const recordUrl = String(record.url || '');
    if (urlFilter instanceof RegExp) {
      if (!urlFilter.test(recordUrl)) return false;
    } else if (urlFilter != null && String(urlFilter) !== '' && !recordUrl.includes(String(urlFilter))) {
      return false;
    }
    if (method && String(record.method || '').toUpperCase() !== method) return false;
    if (requestId && String(record.requestId || '') !== requestId) return false;
    if (commandId && String(record.commandId || '') !== commandId) return false;
    if (types && !types.has(String(record.type || ''))) return false;
    if (since != null && !(Number(record.startedAt) >= since)) return false;
    if (until != null && !(Number(record.startedAt) <= until)) return false;
    if (statusFilter != null && statusFilter !== '') {
      const status = record.status == null ? null : Number(record.status);
      if (statusFilter === 'pending') {
        if (status != null) return false;
      } else if (statusFilter === 'error') {
        if (!(status === 0 || record.error)) return false;
      } else if (statusList) {
        if (status == null || !statusList.includes(status)) return false;
      } else if (statusRange) {
        const min = firstFinite(statusRange.min, statusRange.statusMin);
        const max = firstFinite(statusRange.max, statusRange.statusMax);
        if (min != null && (status == null || status < min)) return false;
        if (max != null && (status == null || status > max)) return false;
      } else if (status == null || status !== Number(statusFilter)) {
        return false;
      }
    }
    if (source.statusMin != null && (record.status == null || Number(record.status) < Number(source.statusMin))) return false;
    if (source.statusMax != null && (record.status == null || Number(record.status) > Number(source.statusMax))) return false;
    return true;
  });

  const order = String(source.order || 'asc') === 'desc' ? 'desc' : 'asc';
  const sortKey = String(source.sort || 'startedAt');
  const sorted = matched.slice().sort((left, right) => {
    const leftRecord = isPlainObject(left.request) ? left.request : left;
    const rightRecord = isPlainObject(right.request) ? right.request : right;
    let leftValue;
    let rightValue;
    if (sortKey === 'duration') {
      leftValue = Number(leftRecord.durationMs) || 0;
      rightValue = Number(rightRecord.durationMs) || 0;
    } else if (sortKey === 'status') {
      leftValue = Number(leftRecord.status == null ? -1 : leftRecord.status);
      rightValue = Number(rightRecord.status == null ? -1 : rightRecord.status);
    } else {
      leftValue = firstFinite(leftRecord.startedAt) || 0;
      rightValue = firstFinite(rightRecord.startedAt) || 0;
    }
    if (leftValue === rightValue) return String(leftRecord.requestId || '').localeCompare(String(rightRecord.requestId || ''));
    return order === 'desc' ? rightValue - leftValue : leftValue - rightValue;
  });

  const limitRaw = Number(source.limit);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50, 1), 500);
  const pageRaw = Number(source.page);
  const offset = Number.isFinite(pageRaw) && pageRaw > 0
    ? Math.floor((pageRaw - 1) * limit)
    : Math.max(0, Number.isFinite(Number(source.offset)) ? Math.floor(Number(source.offset)) : 0);
  const page = sorted.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    total: sorted.length,
    offset,
    limit,
    returned: page.length,
    hasMore: nextOffset < sorted.length,
    nextOffset: nextOffset < sorted.length ? nextOffset : null,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : null,
    items: page,
  };
}

/** 按 requestId 聚合（同一请求多来源合并），输出可直接渲染的数组。 */
export function aggregateByRequestId(records) {
  const merged = mergeRequestRecords(records);
  const grouped = new Map();
  for (const record of merged) {
    const key = record.requestId;
    if (!grouped.has(key)) grouped.set(key, { ...record, sources: [...(record.sources || [])] });
    else {
      const current = grouped.get(key);
      current.sources = [...new Set([...current.sources, ...(record.sources || [])])];
      current.traceEvents = Math.max(current.traceEvents || 0, record.traceEvents || 0);
    }
  }
  return [...grouped.values()].sort((left, right) => (firstFinite(left.startedAt) || 0) - (firstFinite(right.startedAt) || 0));
}

/** 从 link 列表生成按时间排序的统一时间线。 */
export function buildTimeline(links, { limit = 500, includeTrace = true } = {}) {
  const rows = [];
  for (const link of Array.isArray(links) ? links : []) {
    if (!link) continue;
    if (Number.isFinite(Number(link.startedAt))) {
      rows.push({
        at: Number(link.startedAt),
        kind: 'request',
        requestId: link.requestId,
        label: (link.method || 'GET') + ' ' + (link.url || ''),
        status: link.status == null ? null : link.status,
        durationMs: link.durationMs == null ? null : link.durationMs,
      });
    }
    if (includeTrace) {
      for (const event of Array.isArray(link.trace && link.trace.events) ? link.trace.events : []) {
        if (!Number.isFinite(Number(event.at))) continue;
        rows.push({
          at: Number(event.at),
          kind: 'trace',
          requestId: link.requestId,
          label: event.name,
          durationMs: event.durMs == null ? null : event.durMs,
        });
      }
    }
    for (const shot of Array.isArray(link.screenshots) ? link.screenshots : []) {
      rows.push({
        at: shot.at,
        kind: 'screenshot',
        requestId: link.requestId,
        label: shot.label || shot.kind,
        deltaMs: shot.deltaMs,
      });
    }
    for (const event of Array.isArray(link.journal) ? link.journal : []) {
      rows.push({ at: event.at, kind: 'journal', requestId: link.requestId, label: event.type, seq: event.seq });
    }
  }
  rows.sort((left, right) => left.at - right.at || String(left.kind).localeCompare(String(right.kind)));
  const capped = rows.slice(0, Math.min(Math.max(1, Number(limit) || 500), 5000));
  return capped;
}

/** 关联报告压缩摘要（history 索引/日志用）。 */
export function summarizeCorrelation(correlation) {
  const source = isPlainObject(correlation) ? correlation : {};
  const summary = isPlainObject(source.summary) ? source.summary : {};
  return {
    version: CORRELATION_VERSION,
    timeAligned: source.timeAligned === true,
    requests: toCount(summary.requests),
    linked: toCount(summary.linked),
    unlinked: toCount(summary.unlinked),
    traceEvents: toCount(summary.traceEvents),
    orphanTraceEvents: toCount(summary.orphanTraceEvents),
    screenshots: toCount(summary.screenshots),
    linkedScreenshots: toCount(summary.linkedScreenshots),
    journalEvents: toCount(summary.journalEvents),
    byMethod: isPlainObject(summary.byMethod) ? { ...summary.byMethod } : {},
    byStatus: isPlainObject(summary.byStatus) ? { ...summary.byStatus } : {},
    slowest: Array.isArray(summary.slowest) ? summary.slowest.slice(0, 3) : [],
  };
}

/** 按 requestId/url/id 找一条 link（debug.request 的关联详情用）。 */
export function findLink(correlation, { requestId = null, id = null, urlContains = '' } = {}) {
  const links = Array.isArray(correlation && correlation.links) ? correlation.links : [];
  if (requestId != null) {
    const hit = links.find((link) => link.requestId === String(requestId));
    if (hit) return hit;
  }
  if (id != null) {
    const hit = links.find((link) => String(link.id) === String(id));
    if (hit) return hit;
  }
  if (urlContains) {
    const needle = String(urlContains);
    return links.find((link) => String(link.url || '').includes(needle)) || null;
  }
  return null;
}
