// src/debug.js —— 网站调试：请求 / 控制台 / 页面上下文 + 历史回看
//
// W2-C 深度：除了「采一次、存一条」，还维护三层可恢复证据：
//   1. journal 持久化（debug-events.js → lib/debug-journal-persist.js）：
//      单调 seq、环形缓冲、session/时间索引，service worker 重启后 hydrate 恢复；
//   2. coverage/gaps（lib/debug-coverage.js）：明确报告缺哪些请求/帧/阶段、原因分类；
//   3. 关联与导出（lib/debug-correlation.js + lib/debug-export.js）：
//      requestId ↔ trace 事件 ↔ 截图时间线，查询分页，导出 JSON 带 schema 版本与 checksum。
import { consoleEntries } from './actions.js';
import { execPage } from './inject.js';
import { networkDetail, networkList, networkStart, networkStop, networkWebSockets } from './network.js';
import { ensureHooks, releaseHooks } from './page-hooks.js';
import { log } from './log.js';
import {
  beginDebugJournalSession,
  clearDebugEvents,
  debugJournalSnapshot,
  debugJournalStats,
  endDebugJournalSession,
  flushDebugEvents,
  hydrateDebugEvents,
  readDebugEvents,
  recordDebugEvent,
} from './debug-events.js';
import { buildDebugCoverage, summarizeCoverage } from './lib/debug-coverage.js';
import {
  buildDebugCorrelation,
  findLink,
  queryRequests,
  summarizeCorrelation,
} from './lib/debug-correlation.js';
import { buildJournalExport, summarizeJournalExport, verifyJournalExport } from './lib/debug-export.js';
import { redactForPersistence } from './lib/debug-redact.js';

const HISTORY_KEY = 'bb.debug.history';
const MAX_HISTORY = 50;
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 200;
const MAX_SCREENSHOTS = 20;

const activeSessions = new Map(); // tabId -> { tabId, url, title, startedAt }

function pruneHistory(list) {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  return (Array.isArray(list) ? list : [])
    .filter((item) => (Number(item.endedAt) || Number(item.startedAt) || 0) >= cutoff)
    .slice(0, MAX_HISTORY);
}

/** trace 入参允许对象或 JSON 文本（tracing.stop 的 trace 字段就是字符串）。 */
function normalizeTraceInput(trace) {
  if (!trace) return null;
  if (typeof trace === 'string') {
    try {
      return JSON.parse(trace);
    } catch {
      return null;
    }
  }
  return typeof trace === 'object' ? trace : null;
}

/** 帧覆盖：有 webNavigation 权限时读真实帧列表；不可用时返回 null（coverage 记为未订阅）。 */
async function collectFrames(tabId) {
  try {
    if (typeof chrome === 'undefined' || !chrome.webNavigation || typeof chrome.webNavigation.getAllFrames !== 'function') return null;
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!Array.isArray(frames)) return null;
    return frames.map((frame) => ({
      frameId: Number(frame.frameId),
      parentFrameId: Number(frame.parentFrameId),
      url: String(frame.url || ''),
      errorOccurred: frame.errorOccurred === true,
    }));
  } catch {
    return null;
  }
}

/**
 * 截图时间线：最近一次长截图（session storage）+ 本地 capture manifest 索引。
 * 只取元数据（id/时间/尺寸/URL），不把 dataURL 塞进 journal 或导出物。
 */
async function collectScreenshots() {
  const screenshots = [];
  try {
    const stored = await chrome.storage.session.get('bb.longshot.last');
    const last = stored && stored['bb.longshot.last'];
    if (last && Number.isFinite(Number(last.ts))) {
      screenshots.push({
        id: 'longshot-last',
        at: Number(last.ts),
        kind: 'longshot',
        width: Number(last.width) || 0,
        height: Number(last.height) || 0,
        label: '最近长截图',
      });
    }
  } catch {
    // session storage 不可用时忽略
  }
  try {
    const stored = await chrome.storage.local.get('bb.capture.manifests');
    const list = Array.isArray(stored && stored['bb.capture.manifests']) ? stored['bb.capture.manifests'] : [];
    for (const item of list.slice(0, MAX_SCREENSHOTS)) {
      const at = Date.parse(item && item.createdAt ? String(item.createdAt) : '');
      if (!Number.isFinite(at)) continue;
      screenshots.push({
        id: String((item && item.id) || 'capture'),
        at,
        kind: String((item && item.kind) || 'capture'),
        width: Number(item && item.width) || 0,
        height: Number(item && item.height) || 0,
        url: String((item && item.url) || ''),
      });
    }
  } catch {
    // local storage 不可用时忽略
  }
  return screenshots.sort((left, right) => left.at - right.at);
}

function sessionMeta(tabId, session, extra = {}) {
  return {
    tabId,
    id: 'tab-' + tabId,
    name: session && session.name ? session.name : '',
    url: session && session.url ? session.url : '',
    title: session && session.title ? session.title : '',
    bodies: session && session.bodies === true,
    startedAt: session && session.startedAt ? session.startedAt : null,
    ...extra,
  };
}

/** 落 history 的 journal 摘要：去掉事件正文（events 已在 record.journal 里），避免 2x 存储。 */
function compactJournalSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const { events, ...rest } = snapshot;
  return { ...rest, count: Array.isArray(events) ? events.length : 0 };
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
  // service worker 重启后先恢复持久化 journal，保证 seq 继续单调递增而不是从 1 重来。
  await hydrateDebugEvents(tabId).catch(() => {});
  await networkStart({ tabId, bodies: params.bodies === true });
  // 调试采集是显式"我在观察这个页面"的模式：此时才安装主世界钩子
  // （console 缓冲 + 请求命令归因），平时浏览不留痕。
  await ensureHooks(tabId).catch(() => {});
  const startedAt = Date.now();
  activeSessions.set(tabId, {
    tabId,
    url: String(tab.url || ''),
    title: tab.title || '',
    startedAt,
    bodies: params.bodies === true,
    name: typeof params.name === 'string' ? params.name : '',
  });
  clearDebugEvents(tabId);
  beginDebugJournalSession(tabId, sessionMeta(tabId, activeSessions.get(tabId)));
  recordDebugEvent(tabId, 'start', { name: typeof params.name === 'string' ? params.name : '', bodies: params.bodies === true });
  await flushDebugEvents().catch(() => {});
  log('网站调试开始 tab=' + tabId);
  return { ok: true, tabId, startedAt };
}

async function collect(tabId) {
  let requests = [];
  let totalRequests = 0;
  let networkActive = false;
  let networkBodies = false;
  try {
    const list = networkList({ tabId, limit: MAX_ITEMS });
    requests = list.entries || [];
    totalRequests = Number.isFinite(Number(list.total)) ? Number(list.total) : requests.length;
    networkActive = list.active === true;
    networkBodies = list.bodies === true;
  } catch {
    requests = [];
    totalRequests = 0;
  }
  let consoleList = [];
  let totalConsole = 0;
  let consoleError = null;
  try {
    const result = await consoleEntries({ tabId });
    const entries = result && Array.isArray(result.entries) ? result.entries : [];
    totalConsole = entries.length;
    consoleList = entries.slice(-MAX_ITEMS);
  } catch (error) {
    consoleList = [];
    totalConsole = 0;
    consoleError = String((error && error.message) || error);
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
  return {
    requests,
    totalRequests,
    networkActive,
    networkBodies,
    console: consoleList,
    totalConsole,
    consoleError,
    context,
    websockets: networkWebSockets({ tabId, frameLimit: 200 }),
  };
}

/** 用当前采集 + journal 快照构建覆盖率报告（coverage / debug.stop / debug.current 共用）。 */
function coverageFor(tabId, session, data, extras = {}) {
  const journal = debugJournalSnapshot(tabId);
  return buildDebugCoverage({
    session: session
      ? { ...sessionMeta(tabId, session), active: data.networkActive !== false, bodies: session.bodies === true || data.networkBodies === true }
      : { id: 'tab-' + tabId, tabId, active: false },
    requests: data.requests,
    requestsTotal: data.totalRequests,
    console: data.console,
    consoleTotal: data.totalConsole,
    consoleError: data.consoleError,
    frames: extras.frames === undefined ? null : extras.frames,
    frameTotal: Array.isArray(extras.frames) ? extras.frames.length : null,
    websockets: data.websockets,
    trace: extras.trace === undefined ? null : extras.trace,
    screenshots: extras.screenshots === undefined ? null : extras.screenshots,
    journal,
    limits: { requests: MAX_ITEMS, console: MAX_ITEMS },
    now: Date.now(),
  });
}

/** 用当前采集构建关联报告（debug.stop / debug.current / debug.request 共用）。 */
function correlationFor(tabId, session, data, extras = {}) {
  return buildDebugCorrelation({
    session: { id: 'tab-' + tabId, tabId },
    requests: data.requests,
    trace: extras.trace === undefined ? null : extras.trace,
    traceOrigin: Number.isFinite(Number(extras.traceOrigin)) ? Number(extras.traceOrigin) : null,
    screenshots: extras.screenshots === undefined ? null : extras.screenshots,
    journal: debugJournalSnapshot(tabId),
    now: Date.now(),
  });
}

export function debugCapabilities() {
  return {
    ok: true,
    actions: ['start', 'stop', 'status', 'requests', 'request', 'console', 'pages', 'performance', 'aggregate', 'duplicates', 'operations', 'operation', 'export', 'replay', 'rules', 'rule_add', 'rule_enable', 'rule_disable', 'rule_remove', 'capabilities', 'pin', 'unpin'],
    parts: ['metadata', 'request', 'response', 'headers', 'timing'],
    features: {
      rules: true,
      replay: true,
      export: true,
      pin: true,
      operations: true,
      performance: true,
      duplicates: true,
      coverage: true,
      gaps: true,
      journalPersistence: true,
      journalRestore: true,
      journalExport: true,
      journalChecksum: true,
      redaction: true,
      correlation: true,
      query: true,
      pagination: true,
    },
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
  recordDebugEvent(params.tabId, params.pinned === false ? 'unpin' : 'pin', { id });
  return { ok: true, pinned: next };
}

export async function debugPinned() {
  return { ok: true, pinned: await readPinned() };
}

/**
 * 调试覆盖：明确说出“这次采集缺了什么、为什么缺”，而不是让调用方以为全量。
 * 返回同时保留旧字段（requests/console/pinned/bufferTruncated）与新的 { coverage, gaps }。
 */
export async function debugCoverage(params = {}) {
  const tabId = requireTabId(params);
  await hydrateDebugEvents(tabId).catch(() => {});
  const session = activeSessions.get(tabId) || null;
  const data = await collect(tabId);
  const frames = await collectFrames(tabId);
  const screenshots = await collectScreenshots();
  const trace = normalizeTraceInput(params.trace);
  const report = coverageFor(tabId, session, data, { frames, screenshots, trace });
  const pinned = await readPinned();
  const entries = data.requests;
  const consoleList = data.console;
  const truncatedUrls = entries.filter((entry) => entry && entry.truncated === true).length;
  const httpErrors = entries.filter((entry) => Number(entry && entry.status) >= 400).length;
  const consoleErrors = consoleList.filter((entry) => String((entry && entry.level) || '').toLowerCase() === 'error').length;
  const bufferTruncated = entries.length < data.totalRequests;
  return {
    ok: true,
    tabId,
    active: Boolean(session),
    requests: { total: entries.length, httpErrors, truncatedUrls },
    console: { total: consoleList.length, errors: consoleErrors },
    pinned: pinned.length,
    bufferTruncated,
    coverage: report.coverage,
    gaps: report.gaps,
    complete: report.complete,
    journal: debugJournalSnapshot(tabId),
    journalStats: debugJournalStats(),
  };
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
  await hydrateDebugEvents(tabId).catch(() => {});
  const data = await collect(tabId);
  const frames = await collectFrames(tabId);
  const screenshots = await collectScreenshots();
  const trace = normalizeTraceInput(params.trace);
  const coverage = coverageFor(tabId, session, data, { frames, screenshots, trace });
  const correlation = correlationFor(tabId, session, data, { frames, screenshots, trace });
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
    journal: readDebugEvents(tabId),
    journalSummary: compactJournalSummary(debugJournalSnapshot(tabId)),
    websockets: data.websockets,
    frames,
    screenshots,
    coverage: coverage.coverage,
    gaps: coverage.gaps,
    complete: coverage.complete,
    correlation: summarizeCorrelation(correlation),
    timeline: correlation.timeline.slice(0, 100),
  };
}

export async function debugStop(params = {}) {
  const tabId = requireTabId(params);
  const session = activeSessions.get(tabId);
  if (!session) return { ok: false, error: '该标签页没有进行中的调试采集' };
  const data = await collect(tabId);
  await networkStop({ tabId }).catch(() => {});
  await releaseHooks(tabId).catch(() => {});
  activeSessions.delete(tabId);
  recordDebugEvent(tabId, 'stop', { requests: data.requests.length, console: data.console.length });
  const endedAt = Date.now();
  endDebugJournalSession(tabId, { endedAt, requests: data.requests.length, console: data.console.length });
  const frames = await collectFrames(tabId);
  const screenshots = await collectScreenshots();
  const trace = normalizeTraceInput(params.trace);
  const traceOrigin = Number.isFinite(Number(params.traceOrigin)) ? Number(params.traceOrigin) : null;
  const coverage = coverageFor(tabId, session, data, { frames, screenshots, trace });
  const correlation = correlationFor(tabId, session, data, { frames, screenshots, trace, traceOrigin });
  const journal = readDebugEvents(tabId);
  const journalSnapshot = debugJournalSnapshot(tabId);
  const journalExport = buildJournalExport({
    session: sessionMeta(tabId, session, { endedAt }),
    journal: journalSnapshot,
    requests: data.requests,
    coverage,
    correlation,
    generatedAt: endedAt,
  });
  const journalExportSummary = summarizeJournalExport(journalExport);
  await flushDebugEvents().catch(() => {});
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  const record = {
    id,
    tabId,
    name: session.name || '',
    url: data.context && data.context.url ? data.context.url : session.url,
    title: data.context && data.context.title ? data.context.title : session.title,
    startedAt: session.startedAt,
    endedAt,
    requests: data.requests,
    console: data.console,
    context: data.context,
    journal,
    journalSummary: compactJournalSummary(journalSnapshot),
    journalExport: journalExportSummary,
    websockets: data.websockets,
    frames,
    screenshots,
    coverage: coverage.coverage,
    gaps: coverage.gaps,
    complete: coverage.complete,
    correlation: summarizeCorrelation(correlation),
  };
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  // 历史记录是持久化面：统一走 redactForPersistence，console/URL/错误文本里的
  // cookie/token/password 不会以明文写进 chrome.storage.local。
  const safeRecord = redactForPersistence(record);
  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: [safeRecord, ...list].slice(0, MAX_HISTORY) });
  } catch (error) {
    // 配额不足时降级：只保留最近 10 条 + 本条精简版，保证 stop 本身不失败。
    log('调试历史写入失败，降级保存：' + ((error && error.message) || error));
    const slim = {
      ...safeRecord,
      requests: Array.isArray(safeRecord.requests) ? safeRecord.requests.slice(-50) : [],
      console: Array.isArray(safeRecord.console) ? safeRecord.console.slice(-50) : [],
      journal: Array.isArray(safeRecord.journal) ? safeRecord.journal.slice(-50) : [],
      screenshots: Array.isArray(safeRecord.screenshots) ? safeRecord.screenshots.slice(-5) : [],
    };
    await chrome.storage.local.set({ [HISTORY_KEY]: [slim, ...list.slice(0, 9)] }).catch(() => {});
  }
  log('网站调试结束 tab=' + tabId + ' requests=' + record.requests.length + ' console=' + record.console.length + ' gaps=' + coverage.gaps.length);
  return {
    ok: true,
    id,
    requests: record.requests.length,
    console: record.console.length,
    coverage: coverage.coverage,
    gaps: coverage.gaps,
    complete: coverage.complete,
    correlation: summarizeCorrelation(correlation),
    journalExport: journalExportSummary,
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
      journal: item.journal ? item.journal.length : 0,
      frames: Array.isArray(item.frames) ? item.frames.length : 0,
      screenshots: Array.isArray(item.screenshots) ? item.screenshots.length : 0,
      complete: item.complete === true,
      coverage: item.coverage && item.coverage.score ? item.coverage.score : null,
      gaps: Array.isArray(item.gaps) ? item.gaps.length : 0,
      checksum: item.journalExport && item.journalExport.digest ? String(item.journalExport.digest) : null,
    })),
  };
}

/**
 * 单条历史详情：
 *   - 默认返回完整 record + 重新生成的 journal 导出 envelope（含 schema 版本 + checksum）；
 *   - `params.query` 提供 url/method/status/时间窗过滤与分页，返回 { total, items, hasMore }；
 *   - `params.verify !== false` 时对 envelope 重算 checksum 自校验。
 */
export async function debugHistoryDetail(params = {}) {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  const record = list.find((item) => item.id === params.id);
  if (!record) return { ok: false, error: '找不到这条调试记录' };
  const session = {
    id: 'record-' + String(record.id || ''),
    tabId: record.tabId == null ? null : Number(record.tabId),
    name: record.name || '',
    url: record.url || '',
    startedAt: record.startedAt || null,
    endedAt: record.endedAt || null,
    bodies: false,
  };
  const correlation = buildDebugCorrelation({
    session,
    requests: Array.isArray(record.requests) ? record.requests : [],
    screenshots: Array.isArray(record.screenshots) ? record.screenshots : [],
    journal: Array.isArray(record.journal) ? record.journal : [],
    now: Date.now(),
  });
  const storedSummary = record.journalSummary && typeof record.journalSummary === 'object' ? record.journalSummary : {};
  const journalSnapshot = {
    ...storedSummary,
    events: Array.isArray(record.journal) ? record.journal : [],
  };
  const journalExport = buildJournalExport({
    session,
    journal: journalSnapshot,
    requests: Array.isArray(record.requests) ? record.requests : [],
    coverage: record.coverage && record.gaps
      ? { version: 1, coverage: record.coverage, gaps: record.gaps, complete: record.complete === true }
      : null,
    correlation,
    generatedAt: Date.now(),
  });
  const verification = params.verify === false ? null : verifyJournalExport(journalExport);
  const query = params.query && typeof params.query === 'object'
    ? queryRequests(correlation.links, params.query)
    : null;
  return {
    ok: true,
    record,
    journalExport,
    journalExportSummary: summarizeJournalExport(journalExport),
    verification,
    correlation: summarizeCorrelation(correlation),
    ...(query ? { query } : {}),
  };
}

export async function debugDelete(params = {}) {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  const next = list.filter((item) => item.id !== params.id);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return { ok: true, removed: list.length - next.length };
}

/** debug.request：单条请求详情（含 headers/timing，bodies 开启时含正文）+ 关联证据。 */
export async function debugRequest(params = {}) {
  const tabId = requireTabId(params);
  const id = Number(params.id);
  if (!Number.isFinite(id)) throw new Error('需要请求 id');
  const result = await networkDetail({ tabId, id });
  // 关联详情：同一 requestId 的 trace 事件 / 截图时间线 / journal 动作。
  let related = null;
  try {
    const list = networkList({ tabId, limit: MAX_ITEMS });
    const correlation = buildDebugCorrelation({
      session: { id: 'tab-' + tabId, tabId },
      requests: Array.isArray(list.entries) ? list.entries : [],
      screenshots: await collectScreenshots(),
      journal: debugJournalSnapshot(tabId),
      now: Date.now(),
    });
    const link = findLink(correlation, { requestId: 'req-' + id, id });
    if (link) {
      related = {
        requestId: link.requestId,
        status: link.status,
        trace: link.trace.count,
        traceNames: link.trace.topNames,
        screenshots: link.screenshots,
        journal: link.journal,
        correlated: link.correlated,
      };
    }
  } catch {
    related = null;
  }
  return { ok: true, ...result, ...(related ? { related } : {}) };
}

/** debug.performance：主文档性能指标（TTFB/DOMContentLoaded/load/paint/LCP/资源量）。 */
export async function debugPerformance(params = {}) {
  const tabId = requireTabId(params);
  const metrics = await execPage(tabId, 'perf-metrics', {});
  return { ok: true, metrics };
}
