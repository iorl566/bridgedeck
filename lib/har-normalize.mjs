// lib/har-normalize.mjs —— HAR 1.2 规范化 / 校验 / 无 requestId 关联。
//
// 目标：HAR 往返（import → normalize → replay → export）时字段不丢失：
//   * 资源类型：_resourceType（CDP 风格）+ resourceType（HAR 分析用）；
//   * 体积：_transferSize / response.bodySize / content.size 三处口径统一；
//   * 计时：HAR timings 与 CDP 分项（queueing/TTFB/content-download）互相可换算；
//   * WebSocket：_webSocketMessages（Chrome DevTools 兼容）按连接/方向保留时间戳、opcode、
//     payload 截断标记（_truncated/_originalLength），不把截断像素当成完整帧；
//   * 关联：HAR 没有 requestId 时，用 method + url + 时间邻域把 WebSocket 帧/同 URL 请求
//     关联起来，输出可复现的 correlation 证据（matchedBy）。
//
// 本模块是纯函数（不联网、不读文件），供 lib/har.mjs（导出）、lib/har-import.mjs（导入）、
// lib/har-replay.mjs（重放计划）共同消费。

export const HAR_VERSION = '1.2';
export const DEFAULT_TIME_WINDOW_MS = 1500;
export const MAX_WS_MESSAGES = 2000;
export const DEFAULT_WS_PAYLOAD_LIMIT = 4096;

const CDP_TYPES = new Set([
  'Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch',
  'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'SignedExchange', 'Ping', 'CSPViolationReport',
  'Preflight', 'Other',
]);

const RESOURCE_TYPE_BY_CDP = new Map([
  ['document', 'Document'],
  ['stylesheet', 'Stylesheet'],
  ['image', 'Image'],
  ['media', 'Media'],
  ['font', 'Font'],
  ['script', 'Script'],
  ['xhr', 'XHR'],
  ['fetch', 'Fetch'],
  ['websocket', 'WebSocket'],
  ['manifest', 'Manifest'],
  ['eventsource', 'EventSource'],
  ['texttrack', 'TextTrack'],
  ['ping', 'Ping'],
  ['other', 'Other'],
]);

const MIME_TYPE = [
  [/^text\/html|application\/xhtml/i, 'Document'],
  [/^text\/css/i, 'Stylesheet'],
  [/^text\/javascript|application\/javascript|application\/ecmascript/i, 'Script'],
  [/^image\//i, 'Image'],
  [/^font\/|application\/font/i, 'Font'],
  [/^audio\/|^video\//i, 'Media'],
  [/json|xml/i, 'XHR'],
  [/^text\/event-stream/i, 'EventSource'],
  [/manifest\+json/i, 'Manifest'],
];

const EXTENSION_TYPE = [
  [/\.(css)(\?|#|$)/i, 'Stylesheet'],
  [/\.(m?js|jsx|ts|tsx)(\?|#|$)/i, 'Script'],
  [/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i, 'Image'],
  [/\.(woff2?|ttf|otf|eot)(\?|#|$)/i, 'Font'],
  [/\.(mp4|webm|m3u8|mp3|wav|ogg|m4a)(\?|#|$)/i, 'Media'],
  [/\.(html?|xhtml)(\?|#|$)/i, 'Document'],
  [/\.(json|xml)(\?|#|$)/i, 'XHR'],
  [/\.webmanifest(\?|#|$)/i, 'Manifest'],
];

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** ISO 时间或秒/毫秒时间戳 → epoch 毫秒（无法解析返回 null）。 */
export function parseTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value >= 1e12) return value; // 已是毫秒
    if (value >= 1e9) return Math.round(value * 1000); // 秒
    return value; // 小数值当作毫秒（测试/相对时间）
  }
  const text = String(value);
  if (/^-?\d+(\.\d+)?$/.test(text)) return parseTime(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** epoch 毫秒 → ISO；非法时间回退到 fallback。 */
export function isoTime(value, fallback = null) {
  const ms = finite(value) ?? parseTime(value);
  if (ms == null) return fallback == null ? null : new Date(fallback).toISOString();
  return new Date(ms).toISOString();
}

/** 头信息支持对象/数组两种形态，统一成 HAR 的 [{name,value}]。 */
export function toHeadersArray(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    const out = [];
    for (const item of headers) {
      if (!item || typeof item !== 'object') continue;
      const name = String(item.name == null ? item.key == null ? '' : item.key : item.name).trim();
      if (!name) continue;
      out.push({ name, value: String(item.value == null ? '' : item.value) });
    }
    return out;
  }
  if (typeof headers !== 'object') return [];
  return Object.entries(headers).map(([name, value]) => ({
    name: String(name),
    value: Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value),
  }));
}

/** [{name,value}] → 对象（同名头合并为逗号分隔，和 HTTP 语义一致）。 */
export function headersToObject(headers) {
  const out = {};
  for (const header of toHeadersArray(headers)) {
    out[header.name] = out[header.name] === undefined ? header.value : out[header.name] + ', ' + header.value;
  }
  return out;
}

/** 从 URL 提取 queryString（解析失败返回空数组，不抛异常）。 */
export function queryStringOf(url) {
  try {
    return [...new URL(String(url)).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/** 推断资源类型：优先显式 _resourceType，其次 MIME，最后 URL 扩展名。 */
export function inferResourceType(entry = {}) {
  const explicit = entry._resourceType || entry.resourceType;
  if (explicit) {
    const text = String(explicit);
    const lower = text.toLowerCase();
    if (RESOURCE_TYPE_BY_CDP.has(lower)) return RESOURCE_TYPE_BY_CDP.get(lower);
    if (CDP_TYPES.has(text)) return text;
  }
  const mime = String(
    (entry.response && entry.response.content && entry.response.content.mimeType)
      || (entry.response && entry.response.mimeType)
      || entry.responseMimeType
      || '',
  );
  for (const [pattern, type] of MIME_TYPE) {
    if (pattern.test(mime)) return type;
  }
  const url = String((entry.request && entry.request.url) || entry.url || '');
  for (const [pattern, type] of EXTENSION_TYPE) {
    if (pattern.test(url)) return type;
  }
  if (/^wss?:/i.test(url)) return 'WebSocket';
  const method = String((entry.request && entry.request.method) || entry.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'XHR';
  return 'Other';
}

/** HAR 规范化资源类型 → CDP 风格名字（debug-analysis 的 kind 分类依赖大小写）。 */
export function toCdpType(resourceType) {
  const lower = String(resourceType || 'other').toLowerCase();
  return RESOURCE_TYPE_BY_CDP.get(lower) || 'Other';
}

/**
 * HAR timings 规范化。HAR 约定 -1 表示"不适用"，0 表示"实际耗时 0"；
 * 我们把分项补齐并把总时长与分项之和做一次一致性对账（totalMs 优先用 time）。
 * 输入可以是 HAR timings（blocked/dns/...），也可以是 CDP response.timing 的派生结果。
 */
export function normalizeTimings(input = {}, { time = null, startedAt = null, finishedAt = null } = {}) {
  const timings = input && typeof input === 'object' ? input : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(timings, key) && Number.isFinite(Number(timings[key]));
  const out = {
    blocked: has('blocked') ? Number(timings.blocked) : -1,
    dns: has('dns') ? Number(timings.dns) : -1,
    connect: has('connect') ? Number(timings.connect) : -1,
    ssl: has('ssl') ? Number(timings.ssl) : -1,
    send: has('send') ? Number(timings.send) : -1,
    wait: has('wait') ? Number(timings.wait) : -1,
    receive: has('receive') ? Number(timings.receive) : -1,
  };
  // 分项派生：queueing（等待 socket/队列） = blocked；TTFB = 请求发出到首字节；
  // contentDownload = 首字节到响应结束。没有分项时退化为 time 全算在 wait 上。
  const totalHint = finite(time) ?? finite(timings.totalMs);
  let queueing = finite(timings._queueingMs);
  let ttfb = finite(timings._ttfbMs);
  let contentDownload = finite(timings._contentDownloadMs);
  if (queueing == null) queueing = out.blocked >= 0 ? out.blocked : 0;
  if (ttfb == null) {
    if (out.send >= 0 && out.wait >= 0) ttfb = out.send + out.wait;
    else ttfb = totalHint == null ? 0 : totalHint;
  }
  if (contentDownload == null) {
    contentDownload = out.receive >= 0 ? out.receive : Math.max(0, (totalHint ?? 0) - queueing - ttfb);
  }
  let totalMs = totalHint;
  if (totalMs == null) totalMs = Math.max(0, queueing + ttfb + contentDownload);
  if (!has('wait')) out.wait = round(Math.min(totalMs, Math.max(0, ttfb)));
  if (!has('send')) out.send = 0;
  if (!has('receive')) out.receive = round(Math.max(0, contentDownload));
  const breakdownSum = Math.max(0, queueing) + Math.max(0, ttfb) + Math.max(0, contentDownload);
  out.totalMs = round(totalMs);
  out._queueingMs = round(Math.max(0, queueing));
  out._ttfbMs = round(Math.max(0, ttfb));
  out._contentDownloadMs = round(Math.max(0, contentDownload));
  out._breakdownSumMs = round(breakdownSum);
  out._reconciled = Math.abs(breakdownSum - totalMs) <= 1;
  if (startedAt != null) {
    out._responseStartAt = startedAt + out._queueingMs + out._ttfbMs;
    if (finishedAt != null) out._downloadEndAt = finishedAt;
  }
  return out;
}

/** WS 帧 payload 截断：保留前缀 + 原始长度，避免把截断后的帧当成完整 payload。 */
export function truncatePayload(payload, limit = DEFAULT_WS_PAYLOAD_LIMIT) {
  const text = String(payload == null ? '' : payload);
  const bytes = Buffer.byteLength(text, 'utf8');
  const max = Math.max(0, Number(limit) || 0);
  if (bytes <= max) return { data: text, truncated: false, bytes };
  // 按 UTF-8 字节截断，避免切坏多字节字符。
  let cut = 0;
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > max) break;
    used += size;
    cut += character.length;
  }
  return { data: text.slice(0, cut), truncated: true, bytes, stored: used };
}

/**
 * 把扩展侧或 HAR 侧的 WS 帧统一成 HAR `_webSocketMessages`：
 *   [{ type: 'send'|'receive'|'error', time, opcode, data, _truncated, _originalLength }]
 * 时间优先用帧自带 at（epoch ms），没有则用 now + 序号占位并标 `_timeSynthetic`。
 */
export function normalizeWebSocketMessages(messages, { maxPayload = DEFAULT_WS_PAYLOAD_LIMIT, now = Date.now() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (!item || typeof item !== 'object') continue;
    const rawType = String(item.type || item.direction || '').toLowerCase();
    const type = rawType === 'sent' || rawType === 'send' ? 'send'
      : rawType === 'received' || rawType === 'receive' ? 'receive'
        : rawType === 'error' ? 'error' : 'receive';
    const at = finite(item.time) ?? parseTime(item.time) ?? finite(item.at) ?? now + index;
    const payload = item.data !== undefined ? item.data : item.payload;
    const clipped = truncatePayload(payload, maxPayload);
    out.push({
      type,
      time: isoTime(at, now + index),
      opcode: item.opcode == null ? null : Number(item.opcode),
      data: clipped.data,
      _bytes: clipped.bytes,
      _truncated: item._truncated === true || clipped.truncated === true,
      _originalLength: clipped.bytes,
      ...(item.error ? { _error: String(item.error) } : {}),
    });
  }
  if (out.length > MAX_WS_MESSAGES) out.splice(0, out.length - MAX_WS_MESSAGES);
  return out;
}

function normalizePostData(postData) {
  if (!postData) return null;
  if (typeof postData === 'string') {
    return postData ? { mimeType: 'application/x-www-form-urlencoded', text: postData } : null;
  }
  if (typeof postData !== 'object') return null;
  const text = typeof postData.text === 'string' ? postData.text : '';
  const params = Array.isArray(postData.params)
    ? postData.params.map((item) => ({ name: String(item && item.name || ''), value: String(item && item.value == null ? '' : item.value) }))
    : null;
  return {
    mimeType: String(postData.mimeType || postData.mime || 'application/octet-stream'),
    ...(text ? { text } : {}),
    ...(params ? { params } : {}),
  };
}

function normalizeContent(content = {}, { bodyText, base64 } = {}) {
  const source = content && typeof content === 'object' ? content : {};
  const size = finite(source.size);
  const text = typeof bodyText === 'string' ? bodyText : (typeof source.text === 'string' ? source.text : '');
  const encoding = source.encoding === 'base64' || base64 === true ? 'base64' : null;
  return {
    size: size == null ? 0 : size,
    mimeType: String(source.mimeType || source.mime || ''),
    ...(text ? { text } : {}),
    ...(encoding ? { encoding } : {}),
    ...(finite(source.compression) != null ? { compression: finite(source.compression) } : {}),
  };
}

/**
 * 规范化单条 HAR entry。幂等：对 normalizeHarEntry 的输出再调用一次会得到相同结构。
 * 入参也接受 buildHar 的 detail 包装（{entry, requestHeaders, ...}），方便导出与导入共用。
 */
export function normalizeHarEntry(raw, index = 0, { maxPayload = DEFAULT_WS_PAYLOAD_LIMIT, now = Date.now() } = {}) {
  const detail = raw && typeof raw === 'object' ? raw : {};
  const entry = detail.entry && typeof detail.entry === 'object' ? detail.entry : detail;
  const request = entry.request && typeof entry.request === 'object' ? entry.request : {};
  const response = entry.response && typeof entry.response === 'object' ? entry.response : {};
  const startedAt = parseTime(entry.startedAt)
    ?? parseTime(entry._startedAt)
    ?? parseTime(entry.startedDateTime)
    ?? null;
  const durationMs = finite(entry.durationMs) ?? finite(entry.time) ?? finite(entry.timings && entry.timings.totalMs);
  const finishedAt = finite(entry.finishedAt) ?? (startedAt != null && durationMs != null ? startedAt + durationMs : null);

  const requestHeaders = toHeadersArray(
    detail.requestHeaders !== undefined ? detail.requestHeaders
      : request.headers !== undefined ? request.headers
        : entry.requestHeaders,
  );
  const responseHeaders = toHeadersArray(
    detail.responseHeaders !== undefined ? detail.responseHeaders
      : response.headers !== undefined ? response.headers
        : entry.responseHeaders,
  );
  const postData = normalizePostData(
    detail.postData !== undefined ? detail.postData
      : request.postData !== undefined ? request.postData
        : entry.postData,
  );
  const bodyText = detail.responseBody !== undefined ? detail.responseBody
    : response.content && typeof response.content.text === 'string' ? response.content.text
      : entry.responseBody;
  const bodyBase64 = detail.responseBase64 === true || (response.content && response.content.encoding === 'base64');

  const timingsSource = detail.timings && typeof detail.timings === 'object'
    ? detail.timings
    : entry.timings && typeof entry.timings === 'object' ? entry.timings : {};
  const timings = normalizeTimings(timingsSource, { time: durationMs, startedAt, finishedAt });

  const transferSize = finite(entry._transferSize)
    ?? finite(response._transferSize)
    ?? finite(entry.transferSize)
    ?? finite(entry.responseBytes)
    ?? finite(response.bodySize)
    ?? 0;
  const bodySize = finite(response.bodySize) ?? finite(entry.responseBytes) ?? transferSize;
  const requestBytes = finite(request.bodySize) ?? finite(entry.requestBytes) ?? (postData && postData.text ? Buffer.byteLength(postData.text, 'utf8') : 0);
  const resourceType = inferResourceType({ ...entry, request, response, _resourceType: entry._resourceType || entry.resourceType });
  const frame = detail.frame && typeof detail.frame === 'object' ? detail.frame
    : entry.frame && typeof entry.frame === 'object' ? entry.frame : null;
  const frameId = entry._frameId ?? entry.frameId ?? (frame ? frame.frameId : null);

  const wsSource = detail.webSocketMessages !== undefined ? detail.webSocketMessages
    : detail.webSocket && Array.isArray(detail.webSocket.frames) ? detail.webSocket.frames
      : Array.isArray(entry._webSocketMessages) ? entry._webSocketMessages
        : Array.isArray(entry.webSocketMessages) ? entry.webSocketMessages : [];
  const webSocketMessages = normalizeWebSocketMessages(wsSource, { maxPayload, now });
  const webSocket = detail.webSocket && typeof detail.webSocket === 'object' ? detail.webSocket
    : entry._webSocketConnection && typeof entry._webSocketConnection === 'object' ? entry._webSocketConnection
      : null;

  return {
    startedDateTime: isoTime(startedAt, now),
    time: round(durationMs == null ? 0 : durationMs),
    request: {
      method: String(request.method || entry.method || 'GET').toUpperCase(),
      url: String(request.url || entry.url || ''),
      httpVersion: String(request.httpVersion || 'HTTP/1.1'),
      cookies: Array.isArray(request.cookies) ? request.cookies.map((item) => ({ ...item })) : [],
      headers: requestHeaders,
      queryString: queryStringOf(request.url || entry.url || ''),
      headersSize: finite(request.headersSize) ?? -1,
      bodySize: requestBytes,
      ...(postData ? { postData } : {}),
    },
    response: {
      status: entry.status == null && response.status == null ? 0 : Number(entry.status != null ? entry.status : response.status) || 0,
      statusText: String(response.statusText || ''),
      httpVersion: String(response.httpVersion || 'HTTP/1.1'),
      cookies: Array.isArray(response.cookies) ? response.cookies.map((item) => ({ ...item })) : [],
      headers: responseHeaders,
      content: normalizeContent(response.content, { bodyText, base64: bodyBase64 }),
      redirectURL: String(response.redirectURL || ''),
      headersSize: finite(response.headersSize) ?? -1,
      bodySize,
      _transferSize: transferSize,
    },
    cache: entry.cache && typeof entry.cache === 'object' ? { ...entry.cache } : {},
    timings,
    _resourceType: resourceType,
    _requestId: entry._requestId || entry.requestId || detail.requestId || null,
    _frameId: frameId == null ? null : String(frameId),
    _framePath: entry._framePath || (frame && frame.path) || null,
    _fromCache: entry._fromCache === true || entry.fromCache === true || entry.fromDiskCache === true || entry.fromServiceWorker === true,
    _error: entry._error || entry.error || null,
    _serverIPAddress: entry._serverIPAddress || entry.serverIPAddress || null,
    _protocol: entry._protocol || entry.protocol || null,
    _startedAt: startedAt,
    _finishedAt: finishedAt,
    _durationMs: timings.totalMs,
    _transferSize: transferSize,
    _requestBytes: requestBytes,
    _webSocketMessages: webSocketMessages,
    ...(webSocket ? {
      _webSocketConnection: {
        id: webSocket.id == null ? null : Number(webSocket.id),
        url: String(webSocket.url || ''),
        closed: webSocket.closed === true,
        error: webSocket.error || null,
        frameCount: Number(webSocket.frameCount) || webSocketMessages.length,
        truncated: webSocket.truncated === true,
      },
    } : {}),
    ...(entry._correlation ? { _correlation: { ...entry._correlation } } : {}),
  };
}

/** 规范化整份 HAR；返回的仍是 HAR 1.2 结构（多出 `_` 前缀的扩展字段）。 */
export function normalizeHar(har, { maxPayload = DEFAULT_WS_PAYLOAD_LIMIT, now = Date.now() } = {}) {
  const log = har && typeof har === 'object' && har.log && typeof har.log === 'object' ? har.log : {};
  const entries = Array.isArray(log.entries) ? log.entries : Array.isArray(har) ? har : [];
  const pages = Array.isArray(log.pages) ? log.pages : [];
  const normalized = entries.map((entry, index) => normalizeHarEntry(entry, index, { maxPayload, now }));
  const normalizedPages = pages.map((page, index) => ({
    id: String((page && page.id) || 'page_' + (index + 1)),
    title: String((page && page.title) || ''),
    startedDateTime: isoTime(page && page.startedDateTime, now),
    pageTimings: page && page.pageTimings && typeof page.pageTimings === 'object' ? { ...page.pageTimings } : {},
  }));
  return {
    log: {
      version: HAR_VERSION,
      creator: {
        name: String((log.creator && log.creator.name) || 'BridgeDeck'),
        version: String((log.creator && log.creator.version) || '0.3.1'),
      },
      pages: normalizedPages,
      entries: normalized,
      _normalized: true,
    },
  };
}

/** 结构校验：返回 {ok, issues:[{path, code, message}]}，不抛异常。 */
export function validateHar(har) {
  const issues = [];
  const add = (path, code, message) => issues.push({ path, code, message });
  const log = har && har.log;
  if (!log || typeof log !== 'object') {
    add('log', 'missing-log', '缺少 log 对象');
    return { ok: false, issues };
  }
  if (String(log.version) !== HAR_VERSION) add('log.version', 'bad-version', 'version 必须是 1.2，实际 ' + String(log.version));
  if (!Array.isArray(log.entries)) {
    add('log.entries', 'bad-entries', 'entries 必须是数组');
    return { ok: false, issues };
  }
  log.entries.forEach((entry, index) => {
    const path = 'log.entries[' + index + ']';
    if (!entry || typeof entry !== 'object') {
      add(path, 'bad-entry', 'entry 不是对象');
      return;
    }
    if (!Number.isFinite(Date.parse(String(entry.startedDateTime)))) add(path + '.startedDateTime', 'bad-time', 'startedDateTime 无法解析');
    if (!entry.request || typeof entry.request !== 'object') add(path + '.request', 'missing-request', '缺少 request');
    else {
      if (!entry.request.url) add(path + '.request.url', 'missing-url', '缺少 request.url');
      if (!entry.request.method) add(path + '.request.method', 'missing-method', '缺少 request.method');
    }
    if (!entry.response || typeof entry.response !== 'object') add(path + '.response', 'missing-response', '缺少 response');
    else if (entry.response.status != null) {
      const status = Number(entry.response.status);
      if (!Number.isInteger(status) || status < 0 || status > 999) add(path + '.response.status', 'bad-status', 'status 必须是 0..999 的整数');
    }
    if (entry.timings && typeof entry.timings === 'object') {
      for (const key of ['blocked', 'dns', 'connect', 'send', 'wait', 'receive']) {
        const value = entry.timings[key];
        if (value == null) continue;
        if (!Number.isFinite(Number(value)) || Number(value) < -1) add(path + '.timings.' + key, 'bad-timing', 'timing 必须 >= -1');
      }
    }
    if (entry._webSocketMessages !== undefined && !Array.isArray(entry._webSocketMessages)) {
      add(path + '._webSocketMessages', 'bad-ws', '_webSocketMessages 必须是数组');
    }
  });
  return { ok: issues.length === 0, issues };
}

function urlMatchKey(entry) {
  return String(entry.method || entry.request && entry.request.method || 'GET').toUpperCase()
    + ' ' + String(entry.url || entry.request && entry.request.url || '');
}

/**
 * 把 WebSocket 帧挂到对应的 HAR/档案请求上。优先用 requestId，其次用
 * method(GET) + url + 时间邻域（默认 ±1500ms）关联——这就是 HAR 不带 requestId 时的兜底。
 * sockets 输入兼容扩展侧 {id, requestId, url, createdAt, frames} 与 HAR `_webSocketConnection`。
 */
export function attachWebSocketMessages(entries, sockets = [], { timeWindowMs = DEFAULT_TIME_WINDOW_MS } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const socketsList = Array.isArray(sockets) ? sockets.filter((socket) => socket && typeof socket === 'object') : [];
  const byRequestId = new Map();
  for (const socket of socketsList) {
    if (socket.requestId) byRequestId.set(String(socket.requestId), socket);
  }
  const matchedSockets = new Set();
  let matched = 0;
  let byRequestIdCount = 0;
  let byUrlCount = 0;
  const updated = list.map((entry) => {
    const requestId = entry._requestId || entry.requestId || null;
    const url = String(entry.request && entry.request.url || entry.url || '');
    const startedAt = parseTime(entry._startedAt ?? entry.startedAt ?? entry.startedDateTime);
    let socket = requestId ? byRequestId.get(String(requestId)) : null;
    let matchedBy = socket ? 'request-id' : null;
    if (!socket && url) {
      socket = socketsList.find((candidate) => {
        if (matchedSockets.has(candidate)) return false;
        if (String(candidate.url || '') !== url) return false;
        const createdAt = parseTime(candidate.createdAt);
        if (startedAt == null || createdAt == null) return true;
        return Math.abs(createdAt - startedAt) <= timeWindowMs;
      }) || null;
      matchedBy = socket ? 'method-url-time' : null;
    }
    if (!socket) return entry;
    matchedSockets.add(socket);
    matched += 1;
    if (matchedBy === 'request-id') byRequestIdCount += 1;
    else byUrlCount += 1;
    const frames = Array.isArray(socket.frames) ? socket.frames : [];
    const webSocketMessages = normalizeWebSocketMessages(frames);
    return {
      ...entry,
      _webSocketMessages: webSocketMessages,
      _webSocketConnection: {
        id: socket.id == null ? null : Number(socket.id),
        url: String(socket.url || ''),
        closed: socket.closed === true,
        error: socket.error || null,
        frameCount: frames.length,
        truncated: socket.truncated === true,
      },
      _correlation: { matchedBy, socketId: socket.id == null ? null : socket.id, url },
    };
  });
  return {
    entries: updated,
    matched,
    unmatched: socketsList.length - matchedSockets.size,
    byRequestId: byRequestIdCount,
    byUrlTime: byUrlCount,
  };
}

/**
 * 无 requestId 关联：同一 method+url 的请求按时间聚成组（组内保留顺序与时间差），
 * 用于把 HAR 里拆开的请求/重定向/WS 握手串回同一逻辑操作。返回 attachment 证据。
 */
export function correlateHarEntries(entries, { timeWindowMs = DEFAULT_TIME_WINDOW_MS } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const sorted = list.map((entry, position) => ({
    entry,
    position,
    key: urlMatchKey(entry),
    startedAt: parseTime(entry._startedAt ?? entry.startedAt ?? entry.startedDateTime),
  })).sort((a, b) => {
    if (a.startedAt == null && b.startedAt == null) return a.position - b.position;
    if (a.startedAt == null) return 1;
    if (b.startedAt == null) return -1;
    return a.startedAt - b.startedAt || a.position - b.position;
  });
  const groups = new Map(); // key -> [{id, key, items:[item]}]
  let groupSeq = 0;
  const assignments = new Map();
  for (const item of sorted) {
    const bucket = groups.get(item.key) || [];
    const previous = bucket.length ? bucket[bucket.length - 1].items[bucket[bucket.length - 1].items.length - 1] : null;
    const withinWindow = previous
      && item.startedAt != null
      && previous.startedAt != null
      && item.startedAt - previous.startedAt >= 0
      && item.startedAt - previous.startedAt <= Math.max(0, Number(timeWindowMs) || 0);
    let group;
    if (withinWindow) {
      group = bucket[bucket.length - 1];
    } else {
      groupSeq += 1;
      group = { id: 'grp-' + groupSeq, key: item.key, items: [] };
      bucket.push(group);
      groups.set(item.key, bucket);
    }
    const previousInGroup = group.items.length ? group.items[group.items.length - 1] : null;
    group.items.push(item);
    assignments.set(item.position, {
      id: group.id,
      key: item.key,
      indexInGroup: group.items.length - 1,
      matchedBy: item.entry._requestId || (item.entry.request && item.entry.request._requestId) ? 'request-id' : 'method-url-time',
      neighbors: group.items.length - 1,
      deltaMs: item.startedAt != null && previousInGroup && previousInGroup.startedAt != null
        ? item.startedAt - previousInGroup.startedAt
        : null,
    });
  }
  const out = list.map((entry, position) => {
    const info = assignments.get(position);
    if (!info) return entry;
    return {
      ...entry,
      _correlation: { ...(entry._correlation || {}), ...info },
    };
  });
  const groupList = [];
  for (const bucket of groups.values()) {
    for (const group of bucket) {
      groupList.push({
        id: group.id,
        key: group.key,
        count: group.items.length,
        positions: group.items.map((item) => item.position),
      });
    }
  }
  return {
    entries: out,
    groups: groupList,
    correlated: groupList.filter((group) => group.count > 1).length,
    requests: out.length,
  };
}

/** HAR 的响应体积总和（用于 summary.bytes）。 */
export function harByteTotal(har) {
  const entries = har && har.log && Array.isArray(har.log.entries) ? har.log.entries : [];
  let total = 0;
  for (const entry of entries) total += finite(entry._transferSize) ?? finite(entry.response && entry.response._transferSize) ?? 0;
  return total;
}
