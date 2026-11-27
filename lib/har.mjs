// lib/har.mjs —— HAR 1.2 导出：把调试网络明细（已脱敏）转成标准 HAR，便于外部工具分析。
//
// 保真字段（往返 import→export 不丢）：
//   * entry._resourceType / entry.request._transferSize / response._transferSize
//   * entry._requestId / _frameId / _framePath / _fromCache / _serverIPAddress / _protocol / _error
//   * entry._webSocketMessages（Chrome DevTools 兼容）+ _webSocketConnection
//   * entry._correlation（无 requestId 时 method+url+时间邻域的关联证据）
// 计时使用 normalizeTimings：有分项时保留 queueing/TTFB/content-download，否则回退 time→wait。
// 导出即自检（W9-C 加法）：buildHar 会把 HAR 1.2 结构校验结果写进 `log._validation`
// （错误/警告/信息 + 可读 explain），标准字段不变；options.validate=false 可关闭。
//
// 消费点：cli/commands/debug.mjs `debug har`（buildHar）、`debug har-import`（importHar 反向往返）。
import {
  HAR_VERSION,
  DEFAULT_WS_PAYLOAD_LIMIT,
  normalizeHarEntry,
  normalizeHar,
  isoTime,
  toHeadersArray,
} from './har-normalize.mjs';
import { validateHarDeep, explainHarIssues } from './har-merge.mjs';

function startedAtOf(entry) {
  const value = Number(entry && entry.startedAt);
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

/**
 * 从调试明细构建 HAR 1.2。
 * details 元素兼容 `debug.request` 结果：{entry, requestHeaders, responseHeaders, postData,
 * responseBody, responseBase64, timings, chunks, frame, webSocket, webSocketMessages}。
 */
export function buildHar(details, options = {}) {
  const {
    pageUrl = '',
    pageTitle = '',
    creatorName = 'BridgeDeck',
    creatorVersion = '0.3.1',
    includeBodies = true,
    maxWebSocketPayload = DEFAULT_WS_PAYLOAD_LIMIT,
  } = options && typeof options === 'object' ? options : {};
  const list = Array.isArray(details) ? details : [];
  const entries = [];
  let firstAt = null;
  for (let index = 0; index < list.length; index += 1) {
    const detail = list[index] && typeof list[index] === 'object' ? list[index] : {};
    const entry = detail.entry && typeof detail.entry === 'object' ? detail.entry : detail;
    const startedAt = startedAtOf(entry);
    if (firstAt == null || startedAt < firstAt) firstAt = startedAt;
    const postDataSource = detail.postData !== undefined ? detail.postData
      : entry.postData && typeof entry.postData === 'object' ? entry.postData : null;
    const postData = typeof postDataSource === 'string'
      ? (postDataSource ? { mimeType: String(entry.mime || 'application/octet-stream'), text: postDataSource } : null)
      : postDataSource;
    const responseBody = includeBodies && typeof detail.responseBody === 'string' ? detail.responseBody : '';
    const responseBytes = Number(entry.transferSize ?? entry.responseBytes) || 0;
    // 有分项计时时以分项合计为准（HAR 的 time 必须与 timings 自洽）。
    const timingTotal = detail.timings && Number.isFinite(Number(detail.timings.totalMs))
      ? Number(detail.timings.totalMs) : null;
    const raw = {
      index,
      startedAt,
      startedDateTime: isoTime(startedAt),
      durationMs: timingTotal != null
        ? timingTotal
        : (Number(entry.durationMs) > 0 ? Number(entry.durationMs) : (entry.durationMs === 0 ? 0 : null)),
      finishedAt: Number.isFinite(Number(entry.finishedAt)) ? Number(entry.finishedAt) : undefined,
      _resourceType: entry.resourceType || entry.type || undefined,
      _requestId: entry.requestId,
      _frameId: entry.frameId ?? (detail.frame && detail.frame.frameId),
      _framePath: entry.framePath || (detail.frame && detail.frame.path) || null,
      _fromCache: entry.fromCache === true,
      _error: entry.error || null,
      _serverIPAddress: entry.serverIPAddress || null,
      _protocol: entry.protocol || null,
      _transferSize: entry.transferSize ?? responseBytes,
      request: {
        method: String(entry.method || 'GET'),
        url: String(entry.url || ''),
        httpVersion: String(entry.protocol === 'h2' ? 'HTTP/2' : 'HTTP/1.1'),
        headers: toHeadersArray(detail.requestHeaders),
        bodySize: postData && typeof postData.text === 'string'
          ? Buffer.byteLength(postData.text, 'utf8')
          : Number(entry.requestBytes) || 0,
        ...(postData && typeof postData.text === 'string'
          ? { postData: { mimeType: String(postData.mimeType || entry.mime || 'application/octet-stream'), text: postData.text } }
          : {}),
      },
      response: {
        status: entry.status == null ? 0 : Number(entry.status) || 0,
        statusText: String(entry.statusText || ''),
        httpVersion: String(entry.protocol === 'h2' ? 'HTTP/2' : 'HTTP/1.1'),
        headers: toHeadersArray(detail.responseHeaders),
        content: {
          size: Number(entry.responseBodySize ?? entry.responseBytes) || responseBody.length,
          mimeType: String(entry.mime || ''),
          ...(responseBody ? { text: responseBody } : {}),
          ...(detail.responseBase64 === true ? { encoding: 'base64' } : {}),
        },
        redirectURL: String(entry.redirectURL || ''),
        bodySize: responseBytes,
        _transferSize: responseBytes,
      },
      cache: entry.fromCache === true ? { beforeRequest: null, afterRequest: null } : {},
      timings: detail.timings && typeof detail.timings === 'object' ? detail.timings : undefined,
      frame: detail.frame && typeof detail.frame === 'object' ? detail.frame : undefined,
      webSocket: detail.webSocket && typeof detail.webSocket === 'object' ? detail.webSocket : undefined,
      webSocketMessages: Array.isArray(detail.webSocketMessages) ? detail.webSocketMessages
        : detail.webSocket && Array.isArray(detail.webSocket.frames) ? detail.webSocket.frames : undefined,
      chunks: detail.chunks && typeof detail.chunks === 'object' ? detail.chunks : undefined,
    };
    const normalized = normalizeHarEntry(raw, index, { maxPayload: maxWebSocketPayload });
    if (raw.chunks) {
      normalized._chunks = {
        count: Number(raw.chunks.count) || 0,
        bytes: Number(raw.chunks.bytes) || 0,
        streaming: raw.chunks.streaming === true,
        finished: raw.chunks.finished === true,
        truncated: raw.chunks.truncated === true,
        chunked: raw.chunks.chunked === true,
      };
    }
    if (entry.fromCache === true) normalized.response._fromCache = true;
    entries.push(normalized);
  }
  const har = {
    log: {
      version: HAR_VERSION,
      creator: { name: creatorName, version: creatorVersion },
      ...(firstAt != null ? {
        pages: [{
          startedDateTime: isoTime(firstAt),
          id: 'page_1',
          title: String(pageTitle || pageUrl || ''),
          pageTimings: {},
        }],
      } : {}),
      entries,
    },
  };
  // 导出即自检（加法字段）：HAR 1.2 结构问题与 BridgeDeck 扩展字段问题都写进
  // `log._validation`，`log.entries` 等标准字段保持不变。
  // 消费点：cli/commands/debug.mjs `debug har`、MCP browser_debug_har。
  if (options && options.validate === false) return har;
  const validation = validateHarDeep(har, { maxIssues: options && options.maxValidationIssues });
  har.log._validation = {
    ok: validation.ok,
    counts: validation.counts,
    issues: validation.issues,
    truncated: validation.truncated,
    explain: explainHarIssues(validation, { limit: 10 }),
  };
  return har;
}

/** 从档案（debug archive）或 HAR 归一后导出：保留关联/WS 帧，主要供离线再导出使用。 */
export function exportHarFromArchive(archive, options = {}) {
  const source = archive && typeof archive === 'object' ? archive : {};
  const requests = Array.isArray(source.requests) ? source.requests : [];
  const details = requests.map((request) => ({
    entry: {
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      status: request.status,
      mime: request.mime || request.mimeType,
      type: request.type,
      resourceType: request.resourceType,
      startedAt: request.startedAt,
      durationMs: request.durationMs,
      finishedAt: request.finishedAt,
      requestBytes: request.requestBytes,
      responseBytes: request.responseBytes,
      transferSize: request.transferSize,
      frameId: request.frameId,
      framePath: request.framePath,
      fromCache: request.fromCache,
      error: request.error,
      serverIPAddress: request.serverIPAddress,
      protocol: request.protocol,
    },
    requestHeaders: request.requestHeaders,
    responseHeaders: request.responseHeaders,
    postData: request.postData,
    responseBody: request.responseBody,
    responseBase64: request.responseBase64 === true,
    timings: request.timings,
    frame: request.frame,
    webSocket: request.webSocket,
    webSocketMessages: request.webSocketMessages,
  }));
  return buildHar(details, {
    pageUrl: String((source.page && source.page.url) || ''),
    pageTitle: String((source.page && source.page.title) || ''),
    ...options,
  });
}

/** 归一一份 HAR（供调用方做结构比较 / 再导出）。 */
export { normalizeHar, normalizeHarEntry };
