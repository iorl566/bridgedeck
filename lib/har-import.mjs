// lib/har-import.mjs —— HAR 1.2 导入：规范化 → 关联 → 与 debug archive 兼容的请求快照。
//
// 流程：
//   1. （多来源时）mergeHarSources 合并去重/时间归一/冲突裁决；单份输入行为不变；
//   2. normalizeHar 统一字段（资源类型/体积/计时/WS 帧）；
//   3. attachWebSocketMessages：有 requestId 用 requestId，没有就按 method+url+时间邻域
//      把 WebSocket 帧挂到 GET 握手请求上（"无 requestId 关联"）；
//   4. correlateHarEntries：同 method+url 的时间邻域分组，输出 correlation 证据；
//   5. 转成 archive.requests（保留 requestId/frameId/timings/transferSize/WS 帧/来源），
//      供离线 query/analyze/correlation 直接复用；
//   6. （W9-C 加法）深度校验 / 多来源合并报告 / 往返一致性 / 瀑布归因摘要：
//      archive._har.validation、archive._har.roundTrip、archive._merge、archive._waterfall。
//      `archive.requests` 等既有字段一个不改，只新增 `_` 前缀扩展字段。
//
// 消费点：cli/commands/debug.mjs `debug har-import`、mcp browser_debug_har_import。
import { exportHarFromArchive } from './har.mjs';
import { normalizeHar, correlateHarEntries, attachWebSocketMessages, toHeadersArray, headersToObject, toCdpType, harByteTotal, parseTime } from './har-normalize.mjs';
import {
  DEFAULT_ROUND_TRIP_LIMIT,
  compareHarRoundTrip,
  explainHarIssues,
  mergeHarSources,
  summarizeHarMergeReport,
  validateHarDeep,
} from './har-merge.mjs';
import {
  attributeWaterfall,
  summarizeWaterfallAttribution,
} from './waterfall-attribution.mjs';

function socketOf(entry) {
  if (!entry._webSocketConnection) return null;
  return {
    id: entry._webSocketConnection.id,
    url: entry._webSocketConnection.url,
    closed: entry._webSocketConnection.closed === true,
    error: entry._webSocketConnection.error || null,
    frameCount: entry._webSocketConnection.frameCount,
    truncated: entry._webSocketConnection.truncated === true,
    // HAR 的 _webSocketMessages 已带时间/opcode/截断标记，这里保持原样。
    frames: Array.isArray(entry._webSocketMessages) ? entry._webSocketMessages : [],
    messages: Array.isArray(entry._webSocketMessages) ? entry._webSocketMessages : [],
  };
}

/** 判断入参是否是"多份 HAR"（每份都是 HAR 文档或 entries 包装），而不是一堆 entry。 */
export function isHarSourceList(input) {
  if (!Array.isArray(input) || input.length === 0) return false;
  return input.every((item) => item && typeof item === 'object' && !Array.isArray(item)
    && ((item.log && typeof item.log === 'object') || Array.isArray(item.entries)));
}

/** 把 archive request 映射成归因层需要的 waterfall row（分项计时来自 HAR timings）。 */
function waterfallRowsOf(requests, { slowMs = 1000 } = {}) {
  const base = requests.reduce((min, request) => {
    const startedAt = Number(request.startedAt);
    if (!Number.isFinite(startedAt)) return min;
    return min == null || startedAt < min ? startedAt : min;
  }, null);
  return requests.map((request) => {
    const startedAt = Number(request.startedAt);
    const durationMs = Number(request.durationMs);
    const timings = request.timings && typeof request.timings === 'object' ? request.timings : {};
    const frameId = request.frameId == null ? null : String(request.frameId);
    const finished = Number.isFinite(Number(request.finishedAt));
    return {
      id: request.id,
      requestId: request.requestId || null,
      method: String(request.method || ''),
      url: String(request.url || ''),
      status: request.status == null ? null : Number(request.status),
      type: String(request.type || ''),
      startOffsetMs: Number.isFinite(startedAt) && base != null ? Math.max(0, startedAt - base) : 0,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      endOffsetMs: 0,
      bytes: Number(request.responseBytes) || Number(request.transferSize) || 0,
      transferSize: Number(request.transferSize) || 0,
      error: request.error || null,
      resourceType: String(request.resourceType || ''),
      frame: frameId ? { frameId, parentFrameId: null, depth: 0, path: request.framePath || frameId, url: '' } : null,
      finished,
      streaming: !finished && Number(request.status) > 0,
      open: !finished,
      chunked: false,
      chunkCount: 0,
      chunksBytes: 0,
      lastChunkAt: null,
      timings: {
        queueingMs: Number(timings._queueingMs) || 0,
        ttfbMs: Number(timings._ttfbMs) || 0,
        contentDownloadMs: Number(timings._contentDownloadMs) || 0,
        totalMs: Number.isFinite(Number(timings.totalMs)) ? Number(timings.totalMs) : (Number.isFinite(durationMs) ? durationMs : 0),
        dnsMs: Number(timings.dns) >= 0 ? Number(timings.dns) : -1,
        connectMs: Number(timings.connect) >= 0 ? Number(timings.connect) : -1,
        sendMs: Number(timings.send) >= 0 ? Number(timings.send) : -1,
        waitMs: Number(timings.wait) >= 0 ? Number(timings.wait) : -1,
        receiveMs: Number(timings.receive) >= 0 ? Number(timings.receive) : -1,
        open: !finished,
        reconciled: timings._reconciled !== false,
      },
      queueingMs: Number(timings._queueingMs) || 0,
      ttfbMs: Number(timings._ttfbMs) || 0,
      contentDownloadMs: Number(timings._contentDownloadMs) || 0,
      _slowThresholdMs: slowMs,
    };
  }).map((row) => ({ ...row, endOffsetMs: row.startOffsetMs + row.durationMs }));
}

/**
 * HAR → archive。
 * options:
 *   id/session/now            归档标识
 *   sockets                   额外 WebSocket 连接（扩展侧 debug.current 的 sockets），
 *                             用于把 HAR 之外捕获到的帧也关联进来
 *   timeWindowMs              无 requestId 时的时间邻域（默认 1500ms）
 *   merge                     多份来源合并选项 {align, policy, labels}
 *   slowMs                    瀑布归因慢请求阈值（默认 1000ms）
 *   waterfallLimit            归因层保留上限（默认 200）
 *   verifyRoundTrip           是否做 export→import 往返自检（默认 true，entries > limit 时跳过）
 *   roundTripLimit            往返自检的 entry 上限（默认 200）
 *   入参也可以是多份 HAR 数组：自动走 mergeHarSources，合并报告进 archive._merge。
 */
export function importHar(har, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const multiSource = isHarSourceList(har);
  let mergeReport = null;
  let normalizedSource = har;
  if (multiSource) {
    const merged = mergeHarSources(har, {
      now,
      ...(opts.merge && typeof opts.merge === 'object' ? opts.merge : {}),
    });
    mergeReport = merged.report;
    normalizedSource = merged.har;
  }
  const combined = normalizeHarWithCorrelation(normalizedSource, { now, sockets: opts.sockets, timeWindowMs: opts.timeWindowMs });
  const correlatedEntries = combined.har.log.entries;
  const correlation = combined.correlation;
  const wsAttachment = combined.websockets;

  const requests = correlatedEntries.map((entry, index) => {
    const request = entry.request || {};
    const response = entry.response || {};
    const socket = socketOf(entry);
    const requestHeaders = headersToObject(request.headers);
    const responseHeaders = headersToObject(response.headers);
    const status = entry.response && entry.response.status != null ? Number(entry.response.status) : null;
    const startedAt = parseTime(entry._startedAt) ?? parseTime(entry.startedDateTime);
    const durationMs = entry.timings && Number.isFinite(Number(entry.timings.totalMs))
      ? Math.round(Number(entry.timings.totalMs))
      : (Number.isFinite(Number(entry.time)) ? Math.round(Number(entry.time)) : null);
    const requestId = entry._requestId || null;
    return {
      id: index + 1,
      requestId: requestId || 'har-' + (index + 2),
      generatedRequestId: !requestId,
      method: String(request.method || '').toUpperCase(),
      url: String(request.url || ''),
      status: Number.isFinite(status) && status > 0 ? status : null,
      type: toCdpType(entry._resourceType),
      resourceType: String(entry._resourceType || ''),
      mime: String((response.content && response.content.mimeType) || ''),
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      finishedAt: Number.isFinite(Number(entry._finishedAt)) ? Number(entry._finishedAt) : null,
      commandId: null,
      error: entry._error ? String(entry._error) : null,
      requestBytes: Number(request.bodySize) || 0,
      responseBytes: Number(response.bodySize) || 0,
      transferSize: Number(entry._transferSize) || 0,
      requestHeaders,
      responseHeaders,
      postData: request.postData && typeof request.postData.text === 'string' ? request.postData.text : null,
      responseBody: response.content && typeof response.content.text === 'string' ? response.content.text : null,
      responseBase64: (response.content && response.content.encoding === 'base64') || false,
      timings: entry.timings ? { ...entry.timings } : null,
      frameId: entry._frameId || null,
      framePath: entry._framePath || null,
      fromCache: entry._fromCache === true,
      serverIPAddress: entry._serverIPAddress || null,
      protocol: entry._protocol || null,
      webSocket: socket,
      webSocketMessages: socket ? socket.frames : [],
      correlation: entry._correlation ? { ...entry._correlation } : null,
      source: 'har',
    };
  });

  const socketCount = requests.filter((request) => request.webSocket).length;
  const frameCount = requests.reduce((sum, request) => sum + (Array.isArray(request.webSocketMessages) ? request.webSocketMessages.length : 0), 0);
  const pages = combined.har.log.pages || [];
  const page = pages[0] || null;

  // 深度校验（结构化、不抛异常）：既有 `_har` 字段保持，追加 validation/explain。
  const validation = validateHarDeep({ log: { ...combined.har.log, entries: correlatedEntries } }, {
    maxIssues: opts.maxValidationIssues,
  });
  // 瀑布归因（复用 HAR timings，不复制计时公式）：只放紧凑摘要，避免 archive 变大。
  const slowMs = Math.max(1, Number(opts.slowMs) || 1000);
  const waterfallLimit = Math.max(1, Number(opts.waterfallLimit) || Math.min(Math.max(200, requests.length), 5000));
  const attribution = attributeWaterfall(
    { rows: waterfallRowsOf(requests, { slowMs }) },
    { slowMs, limit: waterfallLimit, now },
  );
  const waterfallSummary = summarizeWaterfallAttribution(attribution, { topSlow: 10, topFrames: 10 });

  const archive = {
    version: 1,
    id: String(opts.id || 'har-' + now),
    session: String(opts.session || ''),
    createdAt: new Date(now).toISOString(),
    source: 'har',
    page: {
      url: String((page && page.title) || ''),
      title: String((page && page.title) || ''),
    },
    requests,
    console: [],
    performance: null,
    summary: {
      requests: requests.length,
      console: 0,
      commands: 0,
      bytes: harByteTotal({ log: { entries: correlatedEntries } }),
      webSockets: socketCount,
      webSocketFrames: frameCount,
      correlatedGroups: correlation.correlated,
      generatedRequestIds: requests.filter((request) => request.generatedRequestId).length,
      wsMatchedBy: wsAttachment,
      // W9-C 加法字段：慢请求/流式/校验计数（旧字段语义不变）。
      slowRequests: waterfallSummary.slow.count,
      streamingRequests: waterfallSummary.streaming.count,
      validationErrors: validation.counts.errors,
      validationWarnings: validation.counts.warnings,
    },
    _har: {
      normalized: true,
      pages: pages.length,
      creator: combined.har.log.creator,
      correlationGroups: correlation.groups,
      validation: {
        ok: validation.ok,
        counts: validation.counts,
        truncated: validation.truncated,
        explain: explainHarIssues(validation, { limit: 20 }),
      },
    },
    _waterfall: waterfallSummary,
  };
  if (mergeReport) {
    archive._merge = {
      ...summarizeHarMergeReport(mergeReport),
      align: mergeReport.align,
      policy: mergeReport.policy,
      timeWindowMs: mergeReport.timeWindowMs,
      failures: mergeReport.failures,
      conflicts: mergeReport.conflicts.slice(0, 50),
      time: mergeReport.time,
      sources: mergeReport.sources.map((source) => ({
        index: source.index,
        label: source.label,
        ok: source.ok,
        entries: source.entries || 0,
        pages: source.pages || 0,
        offsetMs: source.offsetMs || 0,
        failure: source.failure || null,
      })),
    };
  }
  // 往返自检（export → import → export）：只在体量可控时做，超限显式记录 skipped。
  const roundTripLimit = Math.max(1, Number(opts.roundTripLimit) || DEFAULT_ROUND_TRIP_LIMIT);
  if (opts.verifyRoundTrip === false) {
    archive._har.roundTrip = { identical: null, skipped: true, reason: 'disabled' };
  } else if (requests.length > roundTripLimit) {
    archive._har.roundTrip = { identical: null, skipped: true, reason: 'entries-over-limit', limit: roundTripLimit, entries: requests.length };
  } else {
    try {
      const reExported = exportHarFromArchive(archive, { includeBodies: true });
      const comparison = compareHarRoundTrip(
        { log: { ...combined.har.log, entries: correlatedEntries } },
        reExported,
        { now },
      );
      archive._har.roundTrip = {
        identical: comparison.identical,
        compared: comparison.compared,
        differences: comparison.differences.slice(0, 20),
        omitted: comparison.omitted,
      };
    } catch (error) {
      archive._har.roundTrip = { identical: false, skipped: true, reason: 'error', error: String((error && error.message) || error) };
    }
  }
  return archive;
}

/** 供调用方复用：只做 HAR 规范化 + WS 关联 + 时间邻域分组，不生成 archive。 */
export function normalizeHarWithCorrelation(har, { now = Date.now(), sockets = [], timeWindowMs } = {}) {
  const normalized = normalizeHar(har, { now });
  const externalSockets = (Array.isArray(sockets) ? sockets : []).filter((socket) => socket && Array.isArray(socket.frames));
  let entries = normalized.log.entries;
  let websockets = { matched: 0, unmatched: 0, byRequestId: 0, byUrlTime: 0 };
  if (externalSockets.length) {
    const attached = attachWebSocketMessages(entries, externalSockets, {
      ...(timeWindowMs == null ? {} : { timeWindowMs }),
    });
    entries = attached.entries;
    websockets = {
      matched: attached.matched,
      unmatched: attached.unmatched,
      byRequestId: attached.byRequestId,
      byUrlTime: attached.byUrlTime,
    };
  }
  const correlation = correlateHarEntries(entries, {
    ...(timeWindowMs == null ? {} : { timeWindowMs }),
  });
  return {
    har: { log: { ...normalized.log, entries: correlation.entries } },
    correlation,
    websockets,
  };
}

export { toHeadersArray };
