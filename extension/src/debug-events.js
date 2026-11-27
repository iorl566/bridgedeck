// 调试会话事件流：start/stop/pin/rule/replay 等动作留痕，随归档持久化。
//
// 内存 API 保持同步（network.js / rules.js 在动作路径上同步调用），持久化交给
// lib/debug-journal-persist.js 的环形缓冲 + coalesce flush：recordDebugEvent 立即返回，
// flush 在微任务里合并写入 chrome.storage.session；service worker 重启后由
// hydrateDebugEvents() 恢复（seq 继续单调递增，不会从头再来）。
// 所有事件在 append 时已过 lib/debug-redact.js 脱敏，落盘文本不含明文 secret。
import {
  JOURNAL_STORE_VERSION,
  createChromeStorageAdapter,
  createDebugJournalStore,
  createMemoryStorage,
} from './lib/debug-journal-persist.js';
import { redactJournalEvent } from './lib/debug-redact.js';

const MAX_EVENTS = 200;
const SESSION_PREFIX = 'tab-';
let store = null;
let flushScheduled = false;

function sessionIdOf(tabId) {
  return SESSION_PREFIX + Number(tabId);
}

function chromeSessionStorage() {
  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.session) {
      return createChromeStorageAdapter(chrome.storage.session);
    }
  } catch {
    // 无 chrome.storage 时降级到内存（单测 / 非扩展环境）
  }
  return null;
}

/** 惰性单例：顶层不访问 chrome，module-load 测试与 Node 单测都能直接 import。 */
export function debugJournalStore() {
  if (store) return store;
  store = createDebugJournalStore({
    storage: chromeSessionStorage() || createMemoryStorage(),
    redact: redactJournalEvent,
    limits: { maxSessionEvents: MAX_EVENTS },
  });
  return store;
}

export function debugJournalVersion() {
  return JOURNAL_STORE_VERSION;
}

export function debugJournalStats() {
  return debugJournalStore().stats();
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  Promise.resolve().then(() => {
    flushScheduled = false;
    debugJournalStore().flush().catch(() => {});
  });
}

export function recordDebugEvent(tabId, type, detail = {}) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || !type) return null;
  const payload = detail && typeof detail === 'object' ? { ...detail } : { value: detail };
  const event = debugJournalStore().append(sessionIdOf(id), { ...payload, type: String(type) });
  scheduleFlush();
  return event;
}

export function readDebugEvents(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return [];
  return debugJournalStore().read(sessionIdOf(id), { limit: MAX_EVENTS });
}

/** 清空当前 tab 的事件（debug.start 复用），会话元数据保留。 */
export function clearDebugEvents(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return 0;
  const removed = debugJournalStore().clearSession(sessionIdOf(id));
  scheduleFlush();
  return removed.length;
}

/** tab 关闭/清理：连会话元数据一起丢掉。 */
export function forgetDebugEvents(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return false;
  const removed = debugJournalStore().removeSession(sessionIdOf(id));
  scheduleFlush();
  return removed;
}

export function beginDebugJournalSession(tabId, meta = {}) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return null;
  const session = debugJournalStore().beginSession(sessionIdOf(id), meta);
  scheduleFlush();
  return session;
}

export function endDebugJournalSession(tabId, meta = {}) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return null;
  const session = debugJournalStore().endSession(sessionIdOf(id), meta);
  scheduleFlush();
  return session;
}

/** journal 快照（coverage / 导出 / debug.current 用）。 */
export function debugJournalSnapshot(tabId, options = {}) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return null;
  return debugJournalStore().snapshot({ ...options, sessionId: sessionIdOf(id) });
}

/**
 * 从 storage 恢复 journal。返回 { restored, reason?, events?, seq? }；
 * 损坏/空 storage 都返回原因，不抛异常（采集功能不因历史损坏而不可用）。
 */
export async function hydrateDebugEvents(tabId) {
  const result = await debugJournalStore().hydrate();
  if (result && result.restored && Number.isInteger(Number(tabId))) {
    return { ...result, session: sessionIdOf(tabId) };
  }
  return result;
}

/** 落盘当前 journal（debug.start/stop 显式调用，不等微任务）。 */
export async function flushDebugEvents(options = {}) {
  return debugJournalStore().flush(options);
}
