// src/lib/network-waterfall.js —— 网络瀑布（扩展侧）：分项计时 / 跨 frame / 流式（chunked）。
//
// 输入是 src/network.js 采集的原始 entry（CDP Network 事件产物）：
//   startedAt(epoch ms)、responseAt、finishedAt、durationMs、responseBytes、timing(CDP
//   response.timing，秒，相对 requestTime)、chunks[]（Network.dataReceived）、frameId、
//   finished、streaming、error……
//
// 输出 rows 每行固定字段（旧消费点兼容）：
//   id/method/url/status/type/startOffsetMs/durationMs/endOffsetMs/bytes/error
// 追加精度字段：
//   queueingMs（socket/队列等待）、ttfbMs（请求到首字节）、contentDownloadMs（首字节到结束）、
//   dnsMs/connectMs/sendMs/waitMs/receiveMs、frame {frameId,depth,path,url}、
//   chunked/chunkCount/chunksBytes、finished/streaming/open、transferSize。
// 关键约束：没收到 loadingFinished 的请求（SSE/WS 升级/长轮询）不伪造成 done：
//   finished=false、streaming=true、open=true，并且 duration 用"截至 now"的实时值。
//
// 消费点：extension/src/network.js networkWaterfall → RPC network.waterfall
// （CLI `network waterfall` / MCP browser_network_waterfall）。

const DEFAULT_LIMIT = 200;
const MAX_CHUNKS = 500;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function positive(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** 从 CDP response.timing（秒，相对 requestTime）派生 HAR 风格分项毫秒。 */
export function deriveCdpTimings(entry = {}, { now = Date.now() } = {}) {
  const timing = entry.timing && typeof entry.timing === 'object' ? entry.timing : null;
  const durationMs = finite(entry.durationMs);
  const startedAt = finite(entry.startedAt);
  const responseAt = finite(entry.responseAt);
  const finishedAt = finite(entry.finishedAt);
  const finished = entry.finished === true;
  let queueingMs = 0;
  let dnsMs = -1;
  let connectMs = -1;
  let sslMs = -1;
  let sendMs = -1;
  let waitMs = -1;
  let receiveMs = -1;
  let ttfbMs = null;
  if (timing) {
    const ms = (value) => (finite(value) != null && Number(value) >= 0 ? Number(value) : -1);
    const dnsStart = ms(timing.dnsStart);
    const dnsEnd = ms(timing.dnsEnd);
    const connectStart = ms(timing.connectStart);
    const connectEnd = ms(timing.connectEnd);
    const sslStart = ms(timing.sslStart);
    const sslEnd = ms(timing.sslEnd);
    const sendStart = ms(timing.sendStart);
    const sendEnd = ms(timing.sendEnd);
    const headersEnd = ms(timing.receiveHeadersEnd);
    // blocked/queueing = DNS 或连接开始前的等待；都不可用时退化为 0。
    const blockedUntil = dnsStart >= 0 ? dnsStart : connectStart >= 0 ? connectStart : sendStart >= 0 ? sendStart : 0;
    queueingMs = round(positive(blockedUntil));
    if (dnsStart >= 0 && dnsEnd >= 0) dnsMs = round(Math.max(0, dnsEnd - dnsStart));
    if (connectStart >= 0 && connectEnd >= 0) connectMs = round(Math.max(0, connectEnd - connectStart));
    if (sslStart >= 0 && sslEnd >= 0) sslMs = round(Math.max(0, sslEnd - sslStart));
    if (sendStart >= 0 && sendEnd >= 0) sendMs = round(Math.max(0, sendEnd - sendStart));
    if (sendEnd >= 0 && headersEnd >= 0) waitMs = round(Math.max(0, headersEnd - sendEnd));
    if (headersEnd >= 0) ttfbMs = round(headersEnd);
    else if (sendMs >= 0 && waitMs >= 0) ttfbMs = round(sendMs + waitMs);
  }
  if (ttfbMs == null) {
    if (responseAt != null && startedAt != null) ttfbMs = round(Math.max(0, responseAt - startedAt));
    else if (durationMs != null) ttfbMs = round(Math.max(0, durationMs));
    else ttfbMs = 0;
  }
  let totalMs = durationMs;
  if (totalMs == null) {
    if (startedAt != null) totalMs = round(Math.max(0, (finished ? (finishedAt || now) : now) - startedAt));
    else totalMs = 0;
  }
  if (receiveMs < 0) {
    if (responseAt != null) {
      const end = finished ? (finishedAt || now) : now;
      receiveMs = round(Math.max(0, end - responseAt));
    } else {
      receiveMs = round(Math.max(0, totalMs - queueingMs - ttfbMs));
    }
  }
  const contentDownloadMs = round(receiveMs);
  const breakdownSum = round(queueingMs + ttfbMs + contentDownloadMs);
  return {
    queueingMs,
    blockedMs: queueingMs,
    dnsMs,
    connectMs,
    sslMs,
    sendMs,
    waitMs,
    receiveMs,
    ttfbMs,
    contentDownloadMs,
    totalMs: round(totalMs),
    breakdownSumMs: breakdownSum,
    reconciled: Math.abs(breakdownSum - totalMs) <= 2,
    derivedFrom: timing ? 'cdp-timing' : (responseAt != null ? 'response-at' : 'duration'),
    open: finished !== true,
  };
}

function frameOf(entry, frames) {
  const frameId = entry.frameId == null ? null : String(entry.frameId);
  if (!frameId) return null;
  let record = null;
  if (frames instanceof Map) record = frames.get(frameId) || frames.get(Number(frameId)) || null;
  else if (Array.isArray(frames)) record = frames.find((item) => item && String(item.frameId) === frameId) || null;
  else if (frames && typeof frames === 'object') record = frames[frameId] || null;
  const depth = record && Number.isFinite(Number(record.depth)) ? Number(record.depth) : (entry.frameDepth == null ? 0 : Number(entry.frameDepth));
  const path = (record && record.path) || entry.framePath || frameId;
  const url = (record && record.url) || entry.frameUrl || entry.documentURL || '';
  return { frameId, parentFrameId: record && record.parentFrameId != null ? String(record.parentFrameId) : null, depth, path, url };
}

function chunkSummary(entry) {
  const chunks = Array.isArray(entry.chunks) ? entry.chunks : [];
  const chunkCount = chunks.length > MAX_CHUNKS ? MAX_CHUNKS : chunks.length;
  let bytes = 0;
  let lastAt = null;
  for (const chunk of chunks.slice(-chunkCount)) {
    bytes += positive(chunk && chunk.encodedDataLength, positive(chunk && chunk.dataLength, 0));
    const at = finite(chunk && chunk.at);
    if (at != null && (lastAt == null || at > lastAt)) lastAt = at;
  }
  return {
    chunked: entry.chunked === true || chunks.length > 1,
    chunkCount,
    chunksBytes: bytes,
    lastChunkAt: lastAt,
    chunksTruncated: chunks.length > MAX_CHUNKS,
  };
}

/**
 * 把请求列表转成相对时间轴 + 分项统计的瀑布。
 * options: limit、frames（frameId→frame 记录，Map/数组/对象均可）、now、filter
 */
export function buildWaterfall(entries, options = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && Number.isFinite(Number(entry.startedAt)))
    .sort((a, b) => Number(a.startedAt) - Number(b.startedAt));
  const limit = Math.max(1, Number(options.limit) || DEFAULT_LIMIT);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const frames = options.frames || null;
  const filter = options.filter && typeof options.filter === 'object' ? options.filter : null;
  const selected = (filter ? list.filter((entry) => {
    if (filter.frameId != null && String(entry.frameId) !== String(filter.frameId)) return false;
    if (filter.type && String(entry.type || '').toLowerCase() !== String(filter.type).toLowerCase()) return false;
    if (filter.urlContains && !String(entry.url || '').includes(String(filter.urlContains))) return false;
    return true;
  }) : list).slice(-limit);
  if (!selected.length) {
    return {
      rows: [],
      summary: {
        count: 0,
        wallMs: 0,
        slowest: null,
        byType: {},
        errors: 0,
        streaming: 0,
        unfinished: 0,
        transferBytes: 0,
        phaseTotals: { queueingMs: 0, ttfbMs: 0, contentDownloadMs: 0, dnsMs: 0, connectMs: 0, sendMs: 0, waitMs: 0 },
        byFrame: [],
        frames: [],
      },
    };
  }
  const base = Number(selected[0].startedAt);
  const rows = selected.map((entry) => {
    const startedAt = Number(entry.startedAt);
    const finished = entry.finished === true;
    const timings = deriveCdpTimings(entry, { now });
    const knownDuration = finite(entry.durationMs);
    const liveDuration = knownDuration != null
      ? Math.max(0, knownDuration)
      : Math.max(0, (finished ? (Number(entry.finishedAt) || now) : now) - startedAt);
    const durationMs = Math.round(liveDuration);
    const chunkInfo = chunkSummary(entry);
    const frame = frameOf(entry, frames);
    const startOffsetMs = Math.max(0, startedAt - base);
    const streaming = entry.streaming === true || (!finished && Number(entry.status) > 0);
    return {
      id: entry.id,
      requestId: entry.requestId || null,
      method: String(entry.method || ''),
      url: String(entry.url || ''),
      status: entry.status == null ? null : Number(entry.status),
      type: String(entry.type || ''),
      startOffsetMs,
      durationMs,
      endOffsetMs: startOffsetMs + durationMs,
      bytes: Number(entry.responseBytes) || chunkInfo.chunksBytes,
      transferSize: Number(entry.transferSize) || Number(entry.responseBytes) || chunkInfo.chunksBytes,
      error: entry.error || null,
      resourceType: String(entry.resourceType || entry.type || ''),
      frame,
      finished,
      streaming,
      open: !finished,
      chunked: chunkInfo.chunked,
      chunkCount: chunkInfo.chunkCount,
      chunksBytes: chunkInfo.chunksBytes,
      lastChunkAt: chunkInfo.lastChunkAt,
      timings,
      queueingMs: timings.queueingMs,
      ttfbMs: timings.ttfbMs,
      contentDownloadMs: timings.contentDownloadMs,
    };
  });
  const byType = {};
  const byFrameMap = new Map();
  const phaseTotals = { queueingMs: 0, ttfbMs: 0, contentDownloadMs: 0, dnsMs: 0, connectMs: 0, sendMs: 0, waitMs: 0 };
  let transferBytes = 0;
  let streaming = 0;
  let unfinished = 0;
  let chunked = 0;
  let errors = 0;
  for (const row of rows) {
    byType[row.type || '(unknown)'] = (byType[row.type || '(unknown)'] || 0) + 1;
    if (row.error || (row.status != null && row.status >= 400)) errors += 1;
    if (row.streaming) streaming += 1;
    if (!row.finished) unfinished += 1;
    if (row.chunked) chunked += 1;
    transferBytes += Number(row.transferSize) || 0;
    phaseTotals.queueingMs = round(phaseTotals.queueingMs + row.timings.queueingMs);
    phaseTotals.ttfbMs = round(phaseTotals.ttfbMs + row.timings.ttfbMs);
    phaseTotals.contentDownloadMs = round(phaseTotals.contentDownloadMs + row.timings.contentDownloadMs);
    for (const key of ['dnsMs', 'connectMs', 'sendMs', 'waitMs']) {
      if (row.timings[key] >= 0) phaseTotals[key] = round(phaseTotals[key] + row.timings[key]);
    }
    if (row.frame) {
      const key = row.frame.frameId;
      if (!byFrameMap.has(key)) byFrameMap.set(key, { frameId: key, depth: row.frame.depth, path: row.frame.path, url: row.frame.url, count: 0, bytes: 0, durationMs: 0 });
      const record = byFrameMap.get(key);
      record.count += 1;
      record.bytes += Number(row.bytes) || 0;
      record.durationMs = round(record.durationMs + row.durationMs);
    }
  }
  const byFrame = [...byFrameMap.values()].sort((a, b) => b.durationMs - a.durationMs);
  const slowest = rows.reduce((best, row) => (!best || row.durationMs > best.durationMs ? row : best), null);
  const wallMs = Math.max(...rows.map((row) => row.endOffsetMs));
  const framesList = byFrame.map((frame) => ({ frameId: frame.frameId, depth: frame.depth, path: frame.path, url: frame.url }));
  return {
    rows,
    summary: {
      count: rows.length,
      wallMs,
      slowest: slowest ? { id: slowest.id, url: slowest.url, durationMs: slowest.durationMs } : null,
      byType,
      errors,
      streaming,
      unfinished,
      chunked,
      transferBytes,
      phaseTotals,
      byFrame,
      frames: framesList,
    },
  };
}

/** 便于调用方（network.detail / HAR 导出）复用同一套计时口径。 */
export function timingsForEntry(entry, { now = Date.now() } = {}) {
  return deriveCdpTimings(entry, { now });
}
