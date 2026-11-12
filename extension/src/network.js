// src/network.js —— 网络采集：webRequest 记元数据，debugger 取正文
import { bridgeError } from './errors.js';
import { acquire, onEvent, release, send } from './debugger.js';
import { execPage } from './inject.js';
import { log } from './log.js';
import { redactBody, redactHeaders, redactUrl } from './redact.js';
import { currentCommand } from './command-context.js';

const MAX_ENTRIES = 500;
const MAX_BODY = 1024 * 1024;
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

function publicEntry(entry) {
  return {
    id: entry.id,
    method: entry.method,
    url: redactUrl(entry.url),
    status: entry.status,
    type: entry.type || '',
    startedAt: entry.startedAt,
    durationMs: entry.durationMs,
    requestBytes: entry.requestBytes || 0,
    responseBytes: entry.responseBytes || 0,
    error: entry.error || null,
    fromCache: entry.fromCache === true,
    pageUrl: entry.pageUrl || '',
    commandId: entry.commandId || null,
  };
}

function installWebRequest(state) {
  const filter = { urls: ['<all_urls>'], tabId: state.tabId };
  const onBefore = (details) => {
    state.seq += 1;
    const entry = {
      id: state.seq,
      requestId: details.requestId,
      method: details.method,
      url: details.url,
      type: details.type,
      startedAt: details.timeStamp,
      status: null,
      durationMs: null,
      pageUrl: details.initiator || '',
      commandId: currentCommand(state.tabId),
    };
    state.byRequestId.set(details.requestId, entry);
    pushEntry(state, entry);
  };
  const onCompleted = (details) => {
    const entry = state.byRequestId.get(details.requestId);
    if (!entry) return;
    entry.status = details.statusCode;
    entry.durationMs = Math.max(0, Math.round(details.timeStamp - entry.startedAt));
    entry.fromCache = details.fromCache === true;
    entry.requestBytes = details.requestSize || 0;
    entry.responseBytes = details.responseSize != null
      ? details.responseSize
      : headerBytes(details.responseHeaders);
    if (details.responseHeaders) entry.responseHeaders = redactHeaders(details.responseHeaders);
  };
  const onError = (details) => {
    const entry = state.byRequestId.get(details.requestId);
    if (!entry) return;
    entry.error = details.error || 'failed';
    entry.durationMs = Math.max(0, Math.round(details.timeStamp - entry.startedAt));
  };
  const onSendHeaders = (details) => {
    const entry = state.byRequestId.get(details.requestId);
    if (!entry) return;
    if (details.requestHeaders) {
      entry.requestHeaders = redactHeaders(details.requestHeaders);
      const tagged = Object.entries(details.requestHeaders).find(([key]) => key.toLowerCase() === 'x-bridge-command');
      if (tagged) entry.commandId = String(tagged[1] || '') || entry.commandId;
    }
  };
  chrome.webRequest.onBeforeRequest.addListener(onBefore, filter);
  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, filter, ['requestHeaders']);
  chrome.webRequest.onCompleted.addListener(onCompleted, filter, ['responseHeaders']);
  chrome.webRequest.onErrorOccurred.addListener(onError, filter);
  state.cleanup = () => {
    chrome.webRequest.onBeforeRequest.removeListener(onBefore);
    chrome.webRequest.onSendHeaders.removeListener(onSendHeaders);
    chrome.webRequest.onCompleted.removeListener(onCompleted);
    chrome.webRequest.onErrorOccurred.removeListener(onError);
  };
}

function installDebuggerNetwork(state) {
  const dbg = state.dbg;
  state.unsubs = [
    onEvent(dbg, 'Network.requestWillBeSent', (event) => {
      if (!event || !event.request) return;
      if (event.type === 'Preflight') return;
      state.seq += 1;
      const entry = {
        id: state.seq,
        requestId: event.requestId,
        method: event.request.method,
        url: event.request.url,
        type: event.type,
        startedAt: event.wallTime ? Math.round(event.wallTime * 1000) : Date.now(),
        status: null,
        durationMs: null,
        pageUrl: event.documentURL || '',
      };
      state.byRequestId.set(event.requestId, entry);
      pushEntry(state, entry);
    }),
    onEvent(dbg, 'Network.responseReceived', (event) => {
      const entry = state.byRequestId.get(event.requestId);
      if (!entry) return;
      entry.status = event.response ? event.response.status : null;
      entry.mime = event.response ? event.response.mimeType : '';
      entry.responseBytes = event.response && event.response.encodedDataLength ? event.response.encodedDataLength : 0;
    }),
    onEvent(dbg, 'Network.loadingFinished', (event) => {
      const entry = state.byRequestId.get(event.requestId);
      if (!entry) return;
      entry.durationMs = Math.max(0, Math.round((event.timestamp ? event.timestamp * 1000 : Date.now()) - entry.startedAt));
      if (event.encodedDataLength) entry.responseBytes = event.encodedDataLength;
      entry.finished = true;
    }),
    onEvent(dbg, 'Network.loadingFailed', (event) => {
      const entry = state.byRequestId.get(event.requestId);
      if (!entry) return;
      entry.error = event.errorText || 'failed';
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
    seq: 0,
    startedAt: Date.now(),
    stopped: false,
  };
  if (bodies) {
    state.dbg = await acquire(tabId, 'network');
    await send(tabId, 'Network.enable', { maxTotalBufferSize: 10 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024 });
    installDebuggerNetwork(state);
  } else {
    installWebRequest(state);
  }
  captures.set(tabId, state);
  log('网络采集开始 tab=' + tabId + ' bodies=' + bodies);
  return { captureId: tabId + '-' + state.startedAt, bodies, mode: bodies ? 'debugger' : 'webRequest' };
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
      log('卸载 webRequest 监听失败', error && error.message);
    }
    state.cleanup = null;
  }
  if (state.bodies) {
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
  log('网络采集停止 tab=' + tabId + ' 共 ' + total + ' 条');
  return { ok: true, entries: total };
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
    return true;
  });
  entries = entries.slice(-limit);
  return { entries: entries.map(publicEntry), active: !state.stopped, bodies: state.bodies, total: state.entries.length };
}

export async function networkDetail(params = {}) {
  const tabId = requireTabId(params);
  const state = captures.get(tabId);
  if (!state) throw bridgeError('E_BAD_ARG', '该 tab 没有网络采集记录；先 network start');
  const id = Number(params.id);
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) throw bridgeError('E_NOT_FOUND', '找不到网络记录 id=' + params.id);
  const result = {
    entry: publicEntry(entry),
    requestHeaders: redactHeaders(entry.requestHeaders) || null,
    responseHeaders: redactHeaders(entry.responseHeaders) || null,
    timing: {
      startedAt: entry.startedAt,
      durationMs: entry.durationMs,
    },
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

export async function networkReplay(params = {}) {
  const tabId = requireTabId(params);
  const state = captures.get(tabId);
  if (!state) throw bridgeError('E_BAD_ARG', '该 tab 没有网络采集记录；先 network start');
  const id = Number(params.id);
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) throw bridgeError('E_NOT_FOUND', '找不到网络记录 id=' + params.id);
  const overrides = params.overrides && typeof params.overrides === 'object' ? params.overrides : {};
  const request = {
    url: typeof overrides.url === 'string' && overrides.url ? overrides.url : entry.url,
    method: typeof overrides.method === 'string' && overrides.method ? overrides.method.toUpperCase() : entry.method,
  };
  if (overrides.headers && typeof overrides.headers === 'object') request.headers = overrides.headers;
  if (typeof overrides.body === 'string') request.body = overrides.body;
  return execPage(tabId, 'fetch-run', request);
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
