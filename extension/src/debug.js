// src/debug.js —— 网站调试：请求 / 控制台 / 页面上下文 + 历史回看
import { consoleEntries } from './actions.js';
import { execPage } from './inject.js';
import { networkDetail, networkList, networkStart, networkStop } from './network.js';
import { log } from './log.js';

const HISTORY_KEY = 'bb.debug.history';
const MAX_HISTORY = 50;
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 200;

const activeSessions = new Map(); // tabId -> { tabId, url, title, startedAt }

function pruneHistory(list) {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  return (Array.isArray(list) ? list : [])
    .filter((item) => (Number(item.endedAt) || Number(item.startedAt) || 0) >= cutoff)
    .slice(0, MAX_HISTORY);
}

function requireTabId(params) {
  const tabId = Number(params && params.tabId);
  if (!Number.isInteger(tabId)) throw new Error('需要 tabId');
  return tabId;
}

export async function debugStart(params = {}) {
  const tabId = requireTabId(params);
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('标签页不存在或已关闭');
  }
  await networkStart({ tabId, bodies: params.bodies === true });
  activeSessions.set(tabId, {
    tabId,
    url: String(tab.url || ''),
    title: tab.title || '',
    startedAt: Date.now(),
    bodies: params.bodies === true,
    name: typeof params.name === 'string' ? params.name : '',
  });
  log('网站调试开始 tab=' + tabId);
  return { ok: true, tabId, startedAt: Date.now() };
}

async function collect(tabId) {
  let requests = [];
  try {
    const list = networkList({ tabId, limit: MAX_ITEMS });
    requests = list.entries || [];
  } catch {
    requests = [];
  }
  let consoleList = [];
  try {
    const result = await consoleEntries({ tabId });
    consoleList = (result && result.entries ? result.entries : []).slice(-MAX_ITEMS);
  } catch {
    consoleList = [];
  }
  let context = null;
  try {
    const metrics = await execPage(tabId, 'page-metrics', {});
    context = {
      url: metrics.url,
      title: metrics.title,
      innerWidth: metrics.innerWidth,
      innerHeight: metrics.innerHeight,
      scrollHeight: metrics.scrollHeight,
      dpr: metrics.dpr,
    };
  } catch {
    context = null;
  }
  return { requests, console: consoleList, context };
}

export function debugCapabilities() {
  return {
    ok: true,
    actions: ['start', 'stop', 'status', 'requests', 'request', 'console', 'pages', 'performance', 'aggregate', 'duplicates', 'operations', 'operation', 'export', 'replay', 'rules', 'rule_add', 'rule_enable', 'rule_disable', 'rule_remove', 'capabilities', 'pin', 'unpin'],
    parts: ['metadata', 'request', 'response', 'headers', 'timing'],
    features: { rules: true, replay: true, export: true, pin: true, operations: true, performance: true, duplicates: true },
  };
}

const PINNED_KEY = 'bb.debug.pinned';

async function readPinned() {
  try {
    const stored = await chrome.storage.session.get(PINNED_KEY);
    return Array.isArray(stored && stored[PINNED_KEY]) ? stored[PINNED_KEY] : [];
  } catch {
    return [];
  }
}

export async function debugPin(params = {}) {
  const id = String(params.id == null ? '' : params.id);
  if (!id) throw new Error('pin 需要请求/操作 id');
  const list = await readPinned();
  const next = params.pinned === false ? list.filter((item) => item !== id) : [...new Set([...list, id])];
  await chrome.storage.session.set({ [PINNED_KEY]: next });
  return { ok: true, pinned: next };
}

export async function debugPinned() {
  return { ok: true, pinned: await readPinned() };
}

export function debugTasks() {
  return Array.from(activeSessions.values()).map((session) => ({
    tabId: session.tabId,
    name: session.name || '',
    url: session.url,
    title: session.title,
    startedAt: session.startedAt,
    bodies: session.bodies === true,
  }));
}

export async function debugCurrent(params = {}) {
  const tabId = requireTabId(params);
  const session = activeSessions.get(tabId);
  if (!session) return { ok: false, error: '该标签页没有进行中的调试采集' };
  const data = await collect(tabId);
  return {
    ok: true,
    active: true,
    tabId,
    name: session.name || '',
    bodies: session.bodies === true,
    url: session.url,
    title: session.title,
    startedAt: session.startedAt,
    requests: data.requests,
    console: data.console,
    context: data.context,
  };
}

export async function debugStop(params = {}) {
  const tabId = requireTabId(params);
  const session = activeSessions.get(tabId);
  if (!session) return { ok: false, error: '该标签页没有进行中的调试采集' };
  const data = await collect(tabId);
  await networkStop({ tabId }).catch(() => {});
  activeSessions.delete(tabId);
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  const record = {
    id,
    tabId,
    name: session.name || '',
    url: data.context && data.context.url ? data.context.url : session.url,
    title: data.context && data.context.title ? data.context.title : session.title,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    requests: data.requests,
    console: data.console,
    context: data.context,
  };
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  list.unshift(record);
  await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(0, MAX_HISTORY) });
  log('网站调试结束 tab=' + tabId + ' requests=' + record.requests.length + ' console=' + record.console.length);
  return {
    ok: true,
    id,
    requests: record.requests.length,
    console: record.console.length,
    record,
  };
}

export async function debugHistory() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const list = pruneHistory(stored && stored[HISTORY_KEY]);
  return {
    ok: true,
    history: list.map((item) => ({
      id: item.id,
      name: item.name || '',
      url: item.url,
      title: item.title,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      requests: item.requests ? item.requests.length : 0,
      console: item.console ? item.console.length : 0,
    })),
  };
}

export async function debugHistoryDetail(params = {}) {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  const record = list.find((item) => item.id === params.id);
  if (!record) return { ok: false, error: '找不到这条调试记录' };
  return { ok: true, record };
}

export async function debugDelete(params = {}) {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  const next = list.filter((item) => item.id !== params.id);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return { ok: true, removed: list.length - next.length };
}

/** debug.request：单条请求详情（含 headers/timing，bodies 开启时含正文）。 */
export async function debugRequest(params = {}) {
  const tabId = requireTabId(params);
  const id = Number(params.id);
  if (!Number.isFinite(id)) throw new Error('需要请求 id');
  const result = await networkDetail({ tabId, id });
  return { ok: true, ...result };
}

/** debug.performance：主文档性能指标（TTFB/DOMContentLoaded/load/paint/LCP/资源量）。 */
export async function debugPerformance(params = {}) {
  const tabId = requireTabId(params);
  const metrics = await execPage(tabId, 'perf-metrics', {});
  return { ok: true, metrics };
}
