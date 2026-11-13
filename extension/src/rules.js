// src/rules.js —— 调试规则：页面内 fetch/XHR 包裹 + DNR（block/redirect）+ CDP Fetch（fulfill 子资源）
import { bridgeError } from './errors.js';
import { acquire, onEvent, release, send as cdpSend } from './debugger.js';
import { log } from './log.js';

const store = new Map(); // tabId -> rules[]
let nextRuleId = 0;
const dnrIds = new Map(); // tabId -> number[]
const dnrError = new Map(); // tabId -> string
const fetchStates = new Map(); // tabId -> { dbg, unsubscribe }
const fetchPaused = new Map(); // tabId -> number
const fetchError = new Map(); // tabId -> string
const fetchUrls = new Map(); // tabId -> string[]
const RULE_KEY_PREFIX = 'bb.rules.';

function serializableRules(tabId) {
  return (store.get(tabId) || []).map(({ matcher, ...rest }) => rest);
}

function persistRules(tabId) {
  if (!chrome.storage || !chrome.storage.local) return;
  const key = RULE_KEY_PREFIX + tabId;
  const list = serializableRules(tabId);
  const task = list.length ? chrome.storage.local.set({ [key]: list }) : chrome.storage.local.remove(key);
  Promise.resolve(task).catch(() => {});
}

async function restoreRules() {
  if (!chrome.storage || !chrome.storage.local) return;
  let all = {};
  try { all = await chrome.storage.local.get(null); } catch { return; }
  for (const [key, value] of Object.entries(all || {})) {
    if (!key.startsWith(RULE_KEY_PREFIX) || !Array.isArray(value)) continue;
    const tabId = Number(key.slice(RULE_KEY_PREFIX.length));
    if (!Number.isInteger(tabId)) continue;
    const list = [];
    for (const raw of value) {
      try {
        const rule = normalize(raw);
        rule.id = Number(raw.id) || rule.id;
        rule.enabled = raw.enabled !== false;
        rule.hits = Number(raw.hits) || 0;
        nextRuleId = Math.max(nextRuleId, rule.id);
        list.push(rule);
      } catch {
        // 忽略损坏规则
      }
    }
    if (list.length) store.set(tabId, list);
  }
}

const restorePromise = restoreRules();


function escapeRegExp(text) {
  return String(text).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

function wildcardToRegExp(pattern) {
  const parts = String(pattern || '*').split('*').map((part) => escapeRegExp(part));
  return new RegExp('^' + parts.join('.*') + '$', 'i');
}

function toHeaders(headers) {
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }));
}

function base64Of(text) {
  return btoa(unescape(encodeURIComponent(String(text || ''))));
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw bridgeError('E_BAD_ARG', 'rule 需要对象');
  const action = String(raw.action || 'fulfill').toLowerCase();
  if (!['fulfill', 'block', 'modify'].includes(action)) {
    throw bridgeError('E_BAD_ARG', 'rule.action 只能是 fulfill/block/modify');
  }
  const urlPattern = String(raw.urlPattern || raw.url || '*');
  nextRuleId += 1;
  return {
    id: nextRuleId,
    enabled: true,
    urlPattern,
    matcher: wildcardToRegExp(urlPattern),
    action,
    status: Number(raw.status) || 200,
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : null,
    body: raw.body === undefined ? '' : String(raw.body),
    url: raw.url ? String(raw.url) : null,
    method: raw.method ? String(raw.method).toUpperCase() : null,
    hits: 0,
  };
}

function publicRules(tabId) {
  return (store.get(tabId) || []).map((item) => ({
    id: item.id,
    enabled: item.enabled !== false,
    urlPattern: item.urlPattern,
    action: item.action,
    status: item.status,
    hits: item.hits,
  }));
}

// ---------------------------------------------------------------- CDP Fetch（fulfill 子资源）

async function stopFetchRules(tabId) {
  const state = fetchStates.get(tabId);
  if (!state) return;
  fetchStates.delete(tabId);
  try { state.unsubscribe(); } catch { /* 忽略 */ }
  await cdpSend(tabId, 'Fetch.disable').catch(() => {});
  await release(tabId, 'rules-fetch').catch(() => {});
}

async function handleFulfillPaused(tabId, event) {
  fetchPaused.set(tabId, (fetchPaused.get(tabId) || 0) + 1);
  const seen = fetchUrls.get(tabId) || [];
  const url = event && event.request ? String(event.request.url || '') : '';
  if (seen.length < 10) seen.push(url);
  fetchUrls.set(tabId, seen);
  const list = store.get(tabId) || [];
  const rule = list.find((item) => item.enabled !== false && item.matcher && item.matcher.test(url) && (item.action === 'fulfill' || item.action === 'modify'));
  try {
    if (!rule) {
      await cdpSend(tabId, 'Fetch.continueRequest', { requestId: event.requestId });
      return;
    }
    rule.hits += 1;
    if (rule.action === 'modify') {
      const overrides = { requestId: event.requestId };
      if (rule.url) overrides.url = rule.url;
      if (rule.method) overrides.method = rule.method;
      if (rule.headers) overrides.headers = toHeaders(rule.headers).map((item) => ({ name: item.name, value: item.value }));
      await cdpSend(tabId, 'Fetch.continueRequest', overrides);
      return;
    }
    await cdpSend(tabId, 'Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: rule.status || 200,
      responseHeaders: toHeaders(rule.headers || { 'content-type': 'application/javascript; charset=utf-8' }),
      body: base64Of(rule.body),
    });
  } catch (error) {
    fetchError.set(tabId, String((error && error.message) || error));
    log('Fetch fulfill 失败：' + fetchError.get(tabId));
  }
}

async function ensureFetchRules(tabId) {
  if (fetchStates.has(tabId)) return;
  const dbg = await acquire(tabId, 'rules-fetch');
  const unsubscribe = onEvent(dbg, 'Fetch.requestPaused', (event) => handleFulfillPaused(tabId, event));
  await cdpSend(tabId, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  fetchStates.set(tabId, { dbg, unsubscribe });
  log('rules fetch 已启用 tab=' + tabId);
}

async function syncFetchRules(tabId) {
  const rules = (store.get(tabId) || []).filter((item) => item.enabled !== false);
  const needsFetch = rules.some((item) => item.action === 'fulfill' || (item.action === 'modify' && (item.url || item.method || item.headers)));
  try {
    if (needsFetch) await ensureFetchRules(tabId);
    else await stopFetchRules(tabId);
  } catch (error) {
    fetchError.set(tabId, String((error && error.message) || error));
    log('同步 Fetch 规则失败：' + fetchError.get(tabId));
  }
}

// ---------------------------------------------------------------- DNR（block/redirect 子资源）

let nextDnrId = 1000;

async function syncDnrRules(tabId) {
  if (!chrome.declarativeNetRequest) return;
  const previous = dnrIds.get(tabId) || [];
  const rules = (store.get(tabId) || []).filter((item) => item.enabled !== false);
  const addRules = [];
  const ids = [];
  for (const rule of rules) {
    let action = null;
    if (rule.action === 'block') action = { type: 'block' };
    else if (rule.action === 'modify' && rule.url && /^https?:\/\//i.test(rule.url)) {
      action = { type: 'redirect', redirect: { url: rule.url } };
    }
    if (!action) continue;
    nextDnrId += 1;
    ids.push(nextDnrId);
    addRules.push({
      id: nextDnrId,
      priority: 1,
      action,
      condition: {
        urlFilter: rule.urlPattern,
        isUrlFilterCaseSensitive: false,
        tabIds: [tabId],
      },
    });
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: previous, addRules });
    dnrIds.set(tabId, ids);
  } catch (error) {
    dnrError.set(tabId, String((error && error.message) || error));
    log('DNR 规则同步失败：' + dnrError.get(tabId));
  }
}

// ---------------------------------------------------------------- 页面内 fetch/XHR 包裹

/** 在页面主世界安装/更新拦截器（自包含函数，会被序列化执行）。 */
function installHook(rules) {
  window.__bbRules = rules || [];
  if (window.__bbRulesInstalled) return;
  window.__bbRulesInstalled = true;

  function toRegExp(pattern) {
    const parts = String(pattern || '*').split('*').map((part) => part.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&'));
    return new RegExp('^' + parts.join('.*') + '$', 'i');
  }
  function findRule(url) {
    return (window.__bbRules || []).find((rule) => toRegExp(rule.urlPattern).test(String(url)));
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const rule = findRule(url);
    if (rule) {
      rule.hits = (rule.hits || 0) + 1;
      if (rule.action === 'block') return Promise.reject(new TypeError('Failed to fetch'));
      if (rule.action === 'fulfill') {
        return Promise.resolve(new Response(rule.body || '', {
          status: rule.status || 200,
          headers: rule.headers || { 'content-type': 'application/json' },
        }));
      }
      if (rule.action === 'modify') {
        const nextInit = Object.assign({}, init || {});
        if (rule.method) nextInit.method = rule.method;
        if (rule.headers) nextInit.headers = rule.headers;
        return originalFetch.call(window, rule.url || input, nextInit);
      }
    }
    return originalFetch.apply(window, arguments);
  };

  const OriginalXhr = window.XMLHttpRequest;
  function WrappedXhr() {
    const xhr = new OriginalXhr();
    const open = xhr.open;
    xhr.open = function (method, url, ...rest) {
      const rule = findRule(url);
      xhr.__bbRule = rule || null;
      if (rule) {
        rule.hits = (rule.hits || 0) + 1;
        if (rule.action === 'modify') return open.call(xhr, rule.method || method, rule.url || url, ...rest);
      }
      return open.call(xhr, method, url, ...rest);
    };
    const send = xhr.send;
    xhr.send = function (body) {
      const rule = xhr.__bbRule;
      if (rule && rule.action === 'block') {
        setTimeout(() => {
          xhr.dispatchEvent(new Event('error'));
          if (typeof xhr.onerror === 'function') xhr.onerror(new Event('error'));
        }, 0);
        return;
      }
      if (rule && rule.action === 'fulfill') {
        const status = rule.status || 200;
        Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
        Object.defineProperty(xhr, 'status', { value: status, configurable: true });
        Object.defineProperty(xhr, 'responseText', { value: rule.body || '', configurable: true });
        setTimeout(() => {
          xhr.dispatchEvent(new Event('load'));
          if (typeof xhr.onload === 'function') xhr.onload(new Event('load'));
        }, 0);
        return;
      }
      return send.call(xhr, body);
    };
    return xhr;
  }
  window.XMLHttpRequest = WrappedXhr;
}

async function inject(tabId) {
  const rules = (store.get(tabId) || []).filter((item) => item.enabled !== false).map((item) => ({
    urlPattern: item.urlPattern,
    action: item.action,
    status: item.status,
    headers: item.headers,
    body: item.body,
    url: item.url,
    method: item.method,
  }));
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: installHook, args: [rules] });
  } catch (error) {
    log('注入规则拦截器失败 tab=' + tabId + '：' + ((error && error.message) || error));
    throw bridgeError('E_INTERNAL', '注入规则拦截器失败：' + ((error && error.message) || error));
  }
}

export async function ruleAdd(params = {}) {
  await restorePromise;
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '需要 tabId');
  const rule = normalize(params.rule);
  const list = store.get(tabId) || [];
  list.push(rule);
  store.set(tabId, list);
  persistRules(tabId);
  await inject(tabId);
  await syncDnrRules(tabId);
  await syncFetchRules(tabId);
  return {
    ok: true,
    rules: publicRules(tabId),
    dnr: { count: (dnrIds.get(tabId) || []).length, error: dnrError.get(tabId) || null },
    fetch: { enabled: fetchStates.has(tabId), paused: fetchPaused.get(tabId) || 0, error: fetchError.get(tabId) || null, urls: fetchUrls.get(tabId) || [] },
  };
}

async function applyRules(tabId) {
  await inject(tabId).catch(() => {});
  await syncDnrRules(tabId);
  await syncFetchRules(tabId);
}

function findRule(tabId, id) {
  const rule = (store.get(tabId) || []).find((item) => item.id === Number(id));
  if (!rule) throw bridgeError('E_NOT_FOUND', '规则不存在：' + id);
  return rule;
}

export async function ruleSetEnabled(params = {}) {
  await restorePromise;
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '需要 tabId');
  const rule = findRule(tabId, params.id);
  rule.enabled = params.enabled !== false;
  persistRules(tabId);
  await applyRules(tabId);
  return { ok: true, rules: publicRules(tabId) };
}

export async function ruleRemove(params = {}) {
  await restorePromise;
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '需要 tabId');
  const id = Number(params.id);
  const list = store.get(tabId) || [];
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) throw bridgeError('E_NOT_FOUND', '规则不存在：' + id);
  list.splice(index, 1);
  persistRules(tabId);
  await applyRules(tabId);
  return { ok: true, removed: id, rules: publicRules(tabId) };
}

export async function ruleList(params = {}) {
  await restorePromise;
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '需要 tabId');
  return {
    ok: true,
    rules: publicRules(tabId),
    dnr: { count: (dnrIds.get(tabId) || []).length, error: dnrError.get(tabId) || null },
    fetch: { enabled: fetchStates.has(tabId), paused: fetchPaused.get(tabId) || 0, error: fetchError.get(tabId) || null, urls: fetchUrls.get(tabId) || [] },
  };
}

export async function ruleClear(params = {}) {
  await restorePromise;
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '需要 tabId');
  const cleared = (store.get(tabId) || []).length;
  store.delete(tabId);
  if (chrome.storage && chrome.storage.local) chrome.storage.local.remove(RULE_KEY_PREFIX + tabId).catch(() => {});
  await inject(tabId).catch(() => {});
  await syncDnrRules(tabId);
  await syncFetchRules(tabId);
  return { ok: true, cleared };
}

export async function ruleExport(params = {}) {
  await restorePromise;
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '需要 tabId');
  return { ok: true, version: 1, rules: serializableRules(tabId) };
}

export async function ruleImport(params = {}) {
  await restorePromise;
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '需要 tabId');
  const raw = Array.isArray(params.rules) ? params.rules : (params.rule && Array.isArray(params.rule.rules) ? params.rule.rules : null);
  if (!raw) throw bridgeError('E_BAD_ARG', 'rule_import 需要 rules 数组');
  const list = [];
  for (const item of raw) {
    const rule = normalize(item);
    rule.id = Number(item.id) || rule.id;
    rule.enabled = item.enabled !== false;
    rule.hits = Number(item.hits) || 0;
    nextRuleId = Math.max(nextRuleId, rule.id);
    list.push(rule);
  }
  store.set(tabId, list);
  persistRules(tabId);
  await applyRules(tabId);
  return { ok: true, imported: list.length, rules: publicRules(tabId) };
}

/** 页面导航完成后重新注入（fetch/XHR 包裹会随文档丢失）。 */
export function reinjectRules(tabId) {
  if (!store.has(tabId)) return;
  inject(tabId).catch((error) => log('重新注入规则失败：' + ((error && error.message) || error)));
}

export function forgetRules(tabId) {
  store.delete(tabId);
  if (chrome.storage && chrome.storage.local) chrome.storage.local.remove(RULE_KEY_PREFIX + tabId).catch(() => {});
  stopFetchRules(tabId).catch(() => {});
  const ids = dnrIds.get(tabId) || [];
  dnrIds.delete(tabId);
  if (ids.length && chrome.declarativeNetRequest) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids, addRules: [] }).catch(() => {});
  }
}
