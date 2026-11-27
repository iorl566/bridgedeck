// src/network.js —— 网络采集：debugger Network 域统一取元数据/正文。
//
// W3-A 深度：
//   * 分项计时：response.timing（queueing/dns/connect/send/wait）+ dataReceived 分片，
//     由 lib/network-waterfall.js 派生 queueing/TTFB/content-download；
//   * 跨 frame 归属：Page.getFrameTree 打底 + Page.frameAttached/frameNavigated/frameDetached
//     增量维护 frameId→{parentFrameId,depth,path,url}，请求带 frameId 归属；
//   * 流式/chunked：dataReceived 记录分片并标 chunked/streaming；没有 loadingFinished 的请求
//     finished=false，瀑布里不会伪造 done；
//   * WebSocket 帧索引：lib/network-ws-index.js 按连接/方向/时间索引，payload 超限带截断标记，
//     支持分页查询（networkWebSockets）；
//   * 详情/HAR：networkDetail 输出 timings/chunks/frame/webSocket（HAR 导出保真字段来源）。
import { bridgeError } from './errors.js';
import { log } from './log.js';
import { acquire, onEvent, release, send } from './debugger.js';
import { execPage } from './inject.js';
import { recordDebugEvent } from './debug-events.js';
import { buildWaterfall, timingsForEntry } from './lib/network-waterfall.js';
import { createWebSocketIndex, DEFAULT_PAYLOAD_LIMIT } from './lib/network-ws-index.js';
import { redactBody, redactHeaders, redactUrl } from './redact.js';
import { currentCommand } from './command-context.js';

const MAX_ENTRIES = 500;
const MAX_BODY = 1024 * 1024;
const MAX_CHUNKS = 500;
const MAX_WS_FRAMES_PER_SOCKET = 2000;
const captures = new Map(); // tabId -> state

function requireTabId(params) {
  if (!params || !Number.isInteger(params.tabId)) {
    throw bridgeError('E_BAD_ARG', '缺少 tabId（由 daemon 注入）');
  }
  return params.tabId;
}

function pushEntry(state, entry) {
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) state.entries.shift();
}

function headerBytes(headers) {
  if (!headers || typeof headers !== 'object') return 0;
  let total = 0;
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (Array.isArray(value)) {
      for (const item of value) total += String(item).length;
    } else {
      total += String(value).length;
    }
  }
  return total;
}

function clip(text) {
  const value = String(text == null ? '' : text);
  if (value.length <= MAX_BODY) return { body: value, truncated: false };
  return { body: value.slice(0, MAX_BODY), truncated: true };
}

function frameView(state, frameId) {
  if (frameId == null) return null;
  const record = state.frames.get(String(frameId));
  if (!record) return { frameId: String(frameId), depth: 0, path: String(frameId), url: '', detached: false };
  return {
    frameId: record.frameId,
    parentFrameId: record.parentFrameId,
    depth: record.depth,
    path: record.path,
    url: record.url,
    detached: record.detached === true,
  };
}

function upsertFrame(state, frame) {
  if (!frame || frame.id == null) return;
  const frameId = String(frame.id);
  const existing = state.frames.get(frameId);
  const record = {
    frameId,
    parentFrameId: frame.parentId == null ? (existing ? existing.parentFrameId : null) : String(frame.parentId),
    url: frame.url || (existing ? existing.url : ''),
    loaderId: frame.loaderId || (existing ? existing.loaderId : null),
    detached: false,
    depth: 0,
    path: '',
  };
  // 深度/路径依赖 parent，先写入再统一重算。
  state.frames.set(frameId, record);
  recomputeFramePaths(state);
}

function recomputeFramePaths(state) {
  for (const record of state.frames.values()) {
    const chain = [];
    const seen = new Set();
    let cursor = record;
    while (cursor && !seen.has(cursor.frameId)) {
      seen.add(cursor.frameId);
      chain.unshift(cursor.frameId);
      cursor = cursor.parentFrameId == null ? null : state.frames.get(String(cursor.parentFrameId));
    }
    record.depth = chain.length - 1;
    record.path = chain.join('/');
  }
}

function seedFrameTree(state, node) {
  if (!node || typeof node !== 'object') return;
  if (node.frame) upsertFrame(state, node.frame);
  for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) seedFrameTree(state, child);
}

function publicEntry(state, entry) {
  const frame = entry.frameId == null ? null : frameView(state, entry.frameId);
  const timings = timingsForEntry(entry);
  return {
    id: entry.id,
    requestId: entry.requestId || null,
    method: entry.method,
    url: redactUrl(entry.url),
    status: entry.status,
    type: entry.type || '',
    resourceType: entry.type || '',
    mime: entry.mime || '',
    protocol: entry.protocol || null,
    startedAt: entry.startedAt,
    durationMs: entry.durationMs,
    requestBytes: entry.requestBytes || 0,
    responseBytes: entry.responseBytes || 0,
    transferSize: entry.transferSize || entry.responseBytes || 0,
    error: entry.error || null,
    fromCache: entry.fromCache === true,
    pageUrl: entry.pageUrl || '',
    commandId: entry.commandId || null,
    frameId: entry.frameId == null ? null : String(entry.frameId),
    frame,
    finished: entry.finished === true,
    streaming: entry.streaming === true,
    chunked: entry.chunked === true,
    chunkCount: Array.isArray(entry.chunks) ? entry.chunks.length : 0,
    timings: {
      queueingMs: timings.queueingMs,
      ttfbMs: timings.ttfbMs,
      contentDownloadMs: timings.contentDownloadMs,
      totalMs: timings.totalMs,
    },
  };
}

function pushWebSocketFrame(state, socket, direction, event) {
  if (!socket || !event) return;
  const response = event.response || {};
  const payload = response.payloadData == null ? '' : String(response.payloadData);
  state.wsIndex.addFrame(socket.id, {
    direction,
    opcode: response.opcode == null ? null : Number(response.opcode),
    payload,
    at: Date.now(),
    ...(event.errorMessage ? { error: String(event.errorMessage) } : {}),
  });
}

function installDebuggerNetwork(state) {
  const dbg = state.dbg;
  state.unsubs = [
    onEvent(dbg, 'Network.requestWillBeSent', (event) => {
      if (!event || !event.request) return;
      if (event.type === 'Preflight') return;
      state.seq += 1;
      const headers = event.request.headers && typeof event.request.headers === 'object' ? event.request.headers : {};
      const taggedKey = Object.keys(headers).find((key) => key.toLowerCase() === 'x-bridge-command');
      const startedAt = event.wallTime ? Math.round(event.wallTime * 1000) : Date.now();
      const entry = {
        id: state.seq,
        requestId: event.requestId,
        method: event.request.method,
        url: event.request.url,
        type: event.type,
        startedAt,
        status: null,
        durationMs: null,
        pageUrl: event.documentURL || '',
        frameId: event.frameId == null ? null : String(event.frameId),
        loaderId: event.loaderId || null,
        commandId: taggedKey ? String(headers[taggedKey] || '') || null : currentCommand(state.tabId) || null,
        requestHeaders: headers,
        requestBytes: Number(event.request.headersSize) || headerBytes(headers),
        ...(event.request.postData ? { postData: event.request.postData } : {}),
        ...(event.redirectResponse ? {
          redirectStatus: Number(event.redirectResponse.status) || null,
          redirectUrl: String(event.redirectResponse.url || ''),
        } : {}),
      };
      state.byRequestId.set(event.requestId, entry);
      pushEntry(state, entry);
    }),
    onEvent(dbg, 'Network.responseReceived', (event) => {
      const entry = state.byRequestId.get(event.requestId);
      if (!entry) return;
      const response = event.response || {};
      entry.status = response.status != null ? response.status : null;
      entry.statusText = response.statusText || '';
      entry.mime = response.mimeType || '';
      entry.protocol = response.protocol || null;
      entry.responseHeaders = response.headers && typeof response.headers === 'object' ? response.headers : null;
      entry.fromCache = response.fromDiskCache === true || response.fromServiceWorker === true;
      entry.serverIPAddress = response.remoteIPAddress || null;
      entry.responseAt = Date.now();
      entry.responseBytes = Number(response.encodedDataLength) || 0;
      entry.responseBodySize = Number(response.encodedDataLength) || 0;
      entry.timing = response.timing && typeof response.timing === 'object' ? response.timing : null;
      entry.requestTime = Number.isFinite(Number(response.requestTime)) ? Number(response.requestTime) : null;
      if (response.securityDetails) entry.securityState = String(response.securityDetails.protocol || '');
    }),
    onEvent(dbg, 'Network.dataReceived', (event) => {
      const entry = state.byRequestId.get(event.requestId);
      if (!entry) return;
      const chunk = {
        at: Date.now(),
        timestamp: Number.isFinite(Number(event.timestamp)) ? Number(event.timestamp) : null,
        dataLength: Number(event.dataLength) || 0,
        encodedDataLength: Number(event.encodedDataLength) || 0,
      };
      if (!Array.isArray(entry.chunks)) entry.chunks = [];
      entry.chunks.push(chunk);
      if (entry.chunks.length > MAX_CHUNKS) entry.chunks.shift();
      entry.chunked = (entry.chunked === true) || entry.chunks.length > 1;
      entry.dataLength = (Number(entry.dataLength) || 0) + chunk.dataLength;
      entry.encodedDataLength = (Number(entry.encodedDataLength) || 0) + chunk.encodedDataLength;
      entry.streaming = entry.finished !== true;
      entry.responseBytes = Math.max(Number(entry.responseBytes) || 0, entry.encodedDataLength);
    }),
    onEvent(dbg, 'Network.loadingFinished', (event) => {
      const entry = state.byRequestId.get(event.requestId);
      if (!entry) return;
      entry.finishedAt = Date.now();
      entry.finished = true;
      entry.streaming = false;
      entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
      if (Number(event.encodedDataLength)) entry.responseBytes = Number(event.encodedDataLength);
      if (Number(event.dataLength)) entry.dataLength = Number(event.dataLength);
      const socket = state.wsIndex.findByRequestId(event.requestId);
      if (socket) socket.handshakeFinished = true;
    }),
    onEvent(dbg, 'Network.loadingFailed', (event) => {
      const entry = state.byRequestId.get(event.requestId);
      if (!entry) return;
      entry.error = event.errorText || 'failed';
      entry.blockedReason = event.blockedReason || null;
      entry.canceled = event.canceled === true;
      entry.finishedAt = Date.now();
      entry.streaming = false;
      entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
    }),
    onEvent(dbg, 'Network.webSocketCreated', (event) => {
      if (!event || !event.requestId) return;
      // 索引里保留原始 URL 用于 requestId/URL+时间关联；对外输出时统一 redactUrl。
      const socket = state.wsIndex.addSocket({
        requestId: event.requestId,
        url: event.url || '',
        createdAt: Date.now(),
      });
      const entry = state.byRequestId.get(event.requestId);
      if (entry) entry.webSocketId = socket.id;
    }),
    onEvent(dbg, 'Network.webSocketFrameSent', (event) => {
      const socket = event && state.wsIndex.findByRequestId(event.requestId);
      if (!socket) return;
      pushWebSocketFrame(state, socket, 'sent', event);
    }),
    onEvent(dbg, 'Network.webSocketFrameReceived', (event) => {
      const socket = event && state.wsIndex.findByRequestId(event.requestId);
      if (!socket) return;
      pushWebSocketFrame(state, socket, 'received', event);
    }),
    onEvent(dbg, 'Network.webSocketFrameError', (event) => {
      const socket = event && state.wsIndex.findByRequestId(event.requestId);
      if (!socket) return;
      pushWebSocketFrame(state, socket, 'error', event);
      state.wsIndex.closeSocket(socket.id, { error: String(event.errorMessage || 'websocket error'), at: Date.now() });
    }),
    onEvent(dbg, 'Network.webSocketClosed', (event) => {
      const socket = event && state.wsIndex.findByRequestId(event.requestId);
      if (socket) state.wsIndex.closeSocket(socket.id, { at: Date.now() });
    }),
    onEvent(dbg, 'Page.frameAttached', (event) => {
      if (!event || event.frameId == null) return;
      state.frames.set(String(event.frameId), {
        frameId: String(event.frameId),
        parentFrameId: event.parentFrameId == null ? null : String(event.parentFrameId),
        url: '',
        loaderId: null,
        detached: false,
        depth: 0,
        path: String(event.frameId),
      });
      recomputeFramePaths(state);
    }),
    onEvent(dbg, 'Page.frameNavigated', (event) => {
      if (event && event.frame) upsertFrame(state, event.frame);
    }),
    onEvent(dbg, 'Page.frameDetached', (event) => {
      if (!event || event.frameId == null) return;
      const record = state.frames.get(String(event.frameId));
      if (record) record.detached = true;
    }),
  ];
}

export async function networkStart(params = {}) {
  const tabId = requireTabId(params);
  const bodies = params.bodies === true;
  await networkStop({ tabId }).catch(() => {});
  const state = {
    tabId,
    bodies,
    entries: [],
    byRequestId: new Map(),
    frames: new Map(),
    wsIndex: createWebSocketIndex({
      maxFramesPerSocket: MAX_WS_FRAMES_PER_SOCKET,
      maxPayload: Number(params.wsPayloadLimit) > 0 ? Number(params.wsPayloadLimit) : DEFAULT_PAYLOAD_LIMIT,
    }),
    seq: 0,
    startedAt: Date.now(),
    stopped: false,
  };
  state.dbg = await acquire(tabId, 'network');
  await send(tabId, 'Network.enable', { maxTotalBufferSize: 10 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024 });
  // Page 域用于 frame 归属（拿不到 frame 树时请求仍可采集，只是 frame 归属退化为 frameId）。
  await send(tabId, 'Page.enable').catch(() => {});
  try {
    const tree = await send(tabId, 'Page.getFrameTree');
    if (tree && tree.frameTree) seedFrameTree(state, tree.frameTree);
  } catch (error) {
    log('读取 frame 树失败（跨 frame 归属退化为 frameId）tab=' + tabId + '：' + ((error && error.message) || error));
  }
  installDebuggerNetwork(state);
  captures.set(tabId, state);
  log('网络采集开始 tab=' + tabId + ' bodies=' + bodies + ' frames=' + state.frames.size);
  return {
    captureId: tabId + '-' + state.startedAt,
    bodies,
    mode: 'debugger',
    frames: state.frames.size,
    wsPayloadLimit: state.wsIndex.stats().limits.maxPayload,
  };
}

export async function networkStop(params = {}) {
  const tabId = requireTabId(params);
  const state = captures.get(tabId);
  if (!state) return { ok: true, entries: 0 };
  state.stopped = true;
  if (typeof state.cleanup === 'function') {
    try {
      state.cleanup();
    } catch (error) {
      log('卸载网络监听失败', error && error.message);
    }
    state.cleanup = null;
  }
  if (state.dbg) {
    for (const unsubscribe of state.unsubs || []) {
      try {
        unsubscribe();
      } catch {
        // 忽略
      }
    }
    state.unsubs = [];
    await send(tabId, 'Network.disable').catch(() => {});
    await release(tabId, 'network').catch(() => {});
  }
  const total = state.entries.length;
  const ws = state.wsIndex.stats();
  log('网络采集停止 tab=' + tabId + ' 共 ' + total + ' 条，WS ' + ws.sockets + ' 连接 / ' + ws.frames + ' 帧');
  return { ok: true, entries: total, websockets: ws.sockets, webSocketFrames: ws.frames };
}

/**
 * WebSocket 帧查询。默认返回 {sockets,total}（debug.current 兼容：每个 socket 带最近 N 帧）；
 * 指定 socketId/direction/since/until/opcode 时额外返回分页帧结果 `query`。
 */
export function networkWebSockets(params = {}) {
  const tabId = requireTabId(params);
  const state = captures.get(tabId);
  if (!state || !state.wsIndex) {
    return {
      sockets: [],
      total: 0,
      stats: { sockets: 0, frames: 0, sent: 0, received: 0, errors: 0, bytes: 0, truncatedFrames: 0 },
    };
  }
  const frameLimit = params.frameLimit == null ? 200 : Math.max(0, Math.min(Number(params.frameLimit) || 0, 2000));
  const limit = Math.max(1, Math.min(Number(params.limit) || 100, 500));
  const offset = Math.max(0, Number(params.offset) || 0);
  const list = state.wsIndex.listSockets({ frameLimit, limit, offset });
  const result = {
    total: list.total,
    sockets: list.sockets.map((socket) => ({ ...socket, url: redactUrl(socket.url) })),
    hasMore: list.hasMore,
    offset,
    limit,
    stats: state.wsIndex.stats(),
  };
  const wantsQuery = params.socketId != null || params.direction != null
    || params.since != null || params.until != null || params.opcode != null;
  if (wantsQuery) {
    result.query = state.wsIndex.query({
      socketId: params.socketId != null ? Number(params.socketId) : null,
      direction: params.direction || null,
      since: params.since != null ? Number(params.since) : null,
      until: params.until != null ? Number(params.until) : null,
      opcode: params.opcode != null ? Number(params.opcode) : null,
      offset: Math.max(0, Number(params.frameOffset) || 0),
      limit: Math.max(1, Math.min(Number(params.frameLimit) || 200, 2000)),
      order: params.order === 'desc' ? 'desc' : 'asc',
      maxPayload: params.maxPayload != null ? Number(params.maxPayload) : null,
    });
  }
  return result;
}

export function networkList(params = {}) {
  const tabId = requireTabId(params);
  const state = captures.get(tabId);
  if (!state) return { entries: [], active: false, bodies: false };
  const filter = params.filter && typeof params.filter === 'object' ? params.filter : {};
  const since = Number(params.since);
  const limitRaw = Number(params.limit);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200, 1), MAX_ENTRIES);
  let entries = state.entries.filter((entry) => {
    if (Number.isFinite(since) && since > 0 && entry.startedAt < since) return false;
    if (filter.urlContains && !String(entry.url).includes(String(filter.urlContains))) return false;
    if (filter.method && String(entry.method).toUpperCase() !== String(filter.method).toUpperCase()) return false;
    if (filter.status != null && Number(entry.status) !== Number(filter.status)) return false;
    if (filter.type && String(entry.type).toLowerCase() !== String(filter.type).toLowerCase()) return false;
    if (filter.frameId != null && String(entry.frameId) !== String(filter.frameId)) return false;
    if (filter.finished === true && entry.finished !== true) return false;
    if (filter.streaming === true && entry.streaming !== true) return false;
    return true;
  });
  entries = entries.slice(-limit);
  return {
    entries: entries.map((entry) => publicEntry(state, entry)),
    active: !state.stopped,
    bodies: state.bodies,
    total: state.entries.length,
  };
}

function webSocketDetail(state, entry) {
  const socket = (entry.webSocketId != null ? state.wsIndex.getSocket(entry.webSocketId) : null)
    || state.wsIndex.findByRequestId(entry.requestId)
    || state.wsIndex.findByUrl(entry.url, entry.startedAt);
  if (!socket) return null;
  const frames = state.wsIndex.query({ socketId: socket.id, limit: 500, maxPayload: DEFAULT_PAYLOAD_LIMIT });
  return {
    id: socket.id,
    requestId: socket.requestId,
    url: redactUrl(socket.url || ''),
    createdAt: socket.createdAt,
    closed: socket.closed === true,
    error: socket.error || null,
    frameCount: socket.frames.length,
    stats: { ...socket.stats },
    frames: frames.frames.map((frame) => ({
      ...frame,
      payload: frame.direction === 'error' ? frame.payload : redactBody(frame.payload),
    })),
    truncated: frames.truncatedFrames > 0,
    truncatedFrames: frames.truncatedFrames,
    returned: frames.frames.length,
  };
}

export async function networkDetail(params = {}) {
  const tabId = requireTabId(params);
  const state = captures.get(tabId);
  if (!state) throw bridgeError('E_BAD_ARG', '该 tab 没有网络采集记录；先 network start');
  const id = Number(params.id);
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) throw bridgeError('E_NOT_FOUND', '找不到网络记录 id=' + params.id);
  const timings = timingsForEntry(entry);
  const chunks = Array.isArray(entry.chunks) ? entry.chunks : [];
  const webSocket = webSocketDetail(state, entry);
  const result = {
    entry: publicEntry(state, entry),
    requestHeaders: redactHeaders(entry.requestHeaders) || null,
    responseHeaders: redactHeaders(entry.responseHeaders) || null,
    timing: {
      startedAt: entry.startedAt,
      responseAt: entry.responseAt || null,
      finishedAt: entry.finishedAt || null,
      durationMs: entry.durationMs,
    },
    timings,
    frame: entry.frameId == null ? null : frameView(state, entry.frameId),
    transferSize: entry.transferSize || entry.responseBytes || 0,
    protocol: entry.protocol || null,
    fromCache: entry.fromCache === true,
    serverIPAddress: entry.serverIPAddress || null,
    chunks: {
      count: chunks.length,
      dataLength: Number(entry.dataLength) || 0,
      encodedDataLength: Number(entry.encodedDataLength) || 0,
      chunked: entry.chunked === true,
      streaming: entry.streaming === true,
      finished: entry.finished === true,
      truncated: chunks.length >= MAX_CHUNKS,
      lastAt: chunks.length ? chunks[chunks.length - 1].at : null,
    },
    ...(webSocket ? { webSocket, webSocketMessages: webSocket.frames } : {}),
  };
  if (state.bodies && entry.requestId) {
    try {
      const body = await send(tabId, 'Network.getResponseBody', { requestId: entry.requestId });
      const clipped = clip(body && body.body ? body.body : '');
      result.responseBody = redactBody(clipped.body);
      result.responseBodyTruncated = clipped.truncated;
      result.responseBase64 = body && body.base64Encoded === true;
    } catch (error) {
      result.responseBodyError = String((error && error.message) || error);
    }
    try {
      const post = await send(tabId, 'Network.getRequestPostData', { requestId: entry.requestId });
      if (post && typeof post.postData === 'string') {
        const clipped = clip(post.postData);
        result.requestBody = redactBody(clipped.body);
        result.requestBodyTruncated = clipped.truncated;
      }
    } catch {
      // 没有请求体（GET 等）不报错
    }
  }
  return result;
}

export async function networkWaterfall(params = {}) {
  const tabId = requireTabId(params);
  const state = captures.get(tabId);
  if (!state) throw bridgeError('E_BAD_ARG', '该 tab 没有网络采集记录；先 network start');
  const limit = Math.max(1, Math.min(Number(params.limit) || 200, 2000));
  return buildWaterfall(state.entries, {
    limit,
    frames: state.frames,
    filter: params.filter && typeof params.filter === 'object' ? params.filter : null,
    now: Date.now(),
  });
}

export async function networkReplay(params = {}) {
  const tabId = requireTabId(params);
  const direct = params.request && typeof params.request === 'object' ? params.request : null;
  let entry = null;
  if (!direct) {
    const state = captures.get(tabId);
    if (!state) throw bridgeError('E_BAD_ARG', '该 tab 没有网络采集记录；先 network start');
    const id = Number(params.id);
    entry = state.entries.find((item) => item.id === id);
    if (!entry) throw bridgeError('E_NOT_FOUND', '找不到网络记录 id=' + params.id);
  }
  const overrides = params.overrides && typeof params.overrides === 'object' ? params.overrides : {};
  const request = {
    url: typeof overrides.url === 'string' && overrides.url ? overrides.url : (direct ? String(direct.url || '') : entry.url),
    method: typeof overrides.method === 'string' && overrides.method ? overrides.method.toUpperCase() : (direct ? String(direct.method || 'GET').toUpperCase() : entry.method),
  };
  if (!request.url) throw bridgeError('E_BAD_ARG', 'replay 需要 url');
  const baseHeaders = direct && direct.headers && typeof direct.headers === 'object' ? direct.headers : null;
  if (overrides.headers && typeof overrides.headers === 'object') request.headers = { ...(baseHeaders || {}), ...overrides.headers };
  else if (baseHeaders) request.headers = baseHeaders;
  const directBody = direct && typeof direct.body === 'string' ? direct.body : null;
  if (typeof overrides.body === 'string') request.body = overrides.body;
  else if (directBody != null) request.body = directBody;
  const id = Number(params.id) || 0;
  try {
    const result = await execPage(tabId, 'fetch-run', request);
    recordDebugEvent(tabId, 'replay', { id, method: request.method, url: request.url, ok: true });
    return result;
  } catch (error) {
    recordDebugEvent(tabId, 'replay', { id, method: request.method, url: request.url, ok: false, error: String((error && error.message) || error) });
    throw error;
  }
}

/** 页面关闭/会话结束时清理。 */
export async function forgetNetworkTab(tabId) {
  const state = captures.get(tabId);
  if (!state) return;
  captures.delete(tabId);
  if (typeof state.cleanup === 'function') {
    try {
      state.cleanup();
    } catch {
      // 忽略
    }
  }
  for (const unsubscribe of state.unsubs || []) {
    try {
      unsubscribe();
    } catch {
      // 忽略
    }
  }
  if (state.bodies) await release(tabId, 'network').catch(() => {});
}
