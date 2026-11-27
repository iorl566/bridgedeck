// src/lib/debug-journal-persist.js —— 调试 journal 持久化模型（浏览器 / Node 双形态）。
//
// 目标：把调试动作（start/stop/pin/rule/replay/…）变成**可恢复、可查询、可审计**的
// 事件序列，而不是只活在 service worker 内存里的数组：
//
//   - 单调 seq：每条事件全局递增，跨 flush/restore 继续递增（恢复后不会回绕）；
//   - 环形缓冲：全局条数 / 单会话条数 / 字节预算 / 会话数四项上限，每次淘汰都登记
//     原因（global-ring-limit / session-ring-limit / byte-budget / session-capacity /
//     event-too-large / session-cleared），coverage/gaps 直接消费这些原因；
//   - 双索引：sessionId → seq 列表（按会话读取）、时间索引（按 at 二分范围查询）；
//   - storage 抽象：任何 `{ get, set, remove }` 异步键值 storage 都能注入。内置
//     memory / chrome.storage / IndexedDB 三种适配器；Node 侧通过
//     `createStorageFromHandlers` 组合 fs 即可复用同一状态机（单测有真实落盘证据）；
//   - 脱敏前置：append 时先过注入的 redactor（默认 debug-redact 的 journal 脱敏），
//     持久化文本里不可能出现明文 secret；
//   - flush / hydrate：coalesce 写入、损坏数据 fail-safe（返回原因而不是抛异常）。
//
// 本模块不 import chrome/node 任何东西，保持「纯状态机 + 可注入 adapter」，Node 单测
// 和扩展运行时用同一份代码。
import { redactJournalEvent } from './debug-redact.js';

export const JOURNAL_STORE_VERSION = 2;
export const JOURNAL_STORAGE_KEY = 'bb.debug.journal.v2';
export const JOURNAL_EVICTION_LIMIT = 128;

export const EVICTION_REASONS = Object.freeze({
  GLOBAL: 'global-ring-limit',
  SESSION: 'session-ring-limit',
  BYTES: 'byte-budget',
  EVENT_TOO_LARGE: 'event-too-large',
  SESSION_CAPACITY: 'session-capacity',
  CLEARED: 'session-cleared',
});

export const DEFAULT_JOURNAL_LIMITS = Object.freeze({
  maxEvents: 500,
  maxSessionEvents: 200,
  maxSessions: 16,
  maxEventBytes: 16 * 1024,
  maxBytes: 512 * 1024,
});

const EVICTION_REASON_SET = new Set(Object.values(EVICTION_REASONS));

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const TEXT_ENCODER = typeof globalThis.TextEncoder === 'function' ? new globalThis.TextEncoder() : null;

/** UTF-8 字节长度（不依赖 Buffer，浏览器/Node 同一实现）。 */
export function utf8ByteLength(text) {
  const value = String(text == null ? '' : text);
  if (!value) return 0;
  if (TEXT_ENCODER) return TEXT_ENCODER.encode(value).length;
  // 退化实现：encodeURIComponent 对代理对按 4 字节、其余按 1~3 字节计。
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** JSON 序列化后的 UTF-8 字节数（不可序列化记 0）。 */
export function jsonByteLength(value) {
  try {
    return utf8ByteLength(JSON.stringify(value === undefined ? null : value));
  } catch {
    return 0;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSessionId(sessionId) {
  if (typeof sessionId === 'string') return sessionId.trim() || null;
  if (typeof sessionId === 'number' && Number.isFinite(sessionId)) return String(sessionId);
  return null;
}

function normalizeLimits(limits = {}) {
  const out = { ...DEFAULT_JOURNAL_LIMITS };
  for (const key of Object.keys(DEFAULT_JOURNAL_LIMITS)) {
    const value = Number(limits && limits[key]);
    if (Number.isFinite(value) && value > 0) out[key] = Math.floor(value);
  }
  return out;
}

function normalizeTypes(types) {
  if (types == null || types === '') return null;
  const list = Array.isArray(types) ? types : [types];
  const set = new Set(list.map((item) => String(item)).filter(Boolean));
  return set.size ? set : null;
}

function cloneEvent(event) {
  return event && typeof event === 'object' ? { ...event } : event;
}

function validStoredEvent(event) {
  return isPlainObject(event)
    && Number.isInteger(event.seq) && event.seq > 0
    && typeof event.sessionId === 'string' && event.sessionId.length > 0
    && Number.isFinite(Number(event.at))
    && typeof event.type === 'string' && event.type.length > 0;
}

// ---------------------------------------------------------------------------
// storage 适配器（统一契约：get(key)->value|null，set(key, string)，remove(key)）
// ---------------------------------------------------------------------------

/** 内存 storage：单测 / 降级。 */
export function createMemoryStorage(initial = {}) {
  const map = new Map();
  if (initial && typeof initial === 'object') {
    for (const [key, value] of Object.entries(initial)) map.set(String(key), value);
  }
  return {
    kind: 'memory',
    async get(key) {
      const id = String(key);
      return map.has(id) ? map.get(id) : null;
    },
    async set(key, value) {
      map.set(String(key), value);
    },
    async remove(key) {
      map.delete(String(key));
    },
    keys() {
      return [...map.keys()];
    },
    dump() {
      return Object.fromEntries(map);
    },
  };
}

/**
 * 用外部 handler 组合 storage：Node 侧把 fs.readFile/writeFile 包进来即可。
 * @param {{get: (key: string) => unknown, set: (key: string, value: string) => unknown, remove?: (key: string) => unknown}} handlers
 */
export function createStorageFromHandlers(handlers) {
  if (!handlers || typeof handlers.get !== 'function' || typeof handlers.set !== 'function') {
    throw new Error('createStorageFromHandlers 需要 get/set handler');
  }
  return {
    kind: 'handlers',
    async get(key) {
      return handlers.get(String(key));
    },
    async set(key, value) {
      return handlers.set(String(key), String(value));
    },
    async remove(key) {
      if (typeof handlers.remove === 'function') return handlers.remove(String(key));
      return undefined;
    },
  };
}

/**
 * chrome.storage 适配器：`createChromeStorageAdapter(chrome.storage.session)`。
 * chrome 不可用时 get 返回 null（fail-safe），set 抛错由 store.flush 捕获成 storage-error。
 */
export function createChromeStorageAdapter(area, { keyPrefix = '' } = {}) {
  const prefix = String(keyPrefix || '');
  const fullKey = (key) => prefix + String(key);
  return {
    kind: 'chrome-storage',
    async get(key) {
      if (!area || typeof area.get !== 'function') return null;
      try {
        const stored = await area.get(fullKey(key));
        const value = stored ? stored[fullKey(key)] : undefined;
        return value === undefined ? null : value;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (!area || typeof area.set !== 'function') throw new Error('chrome.storage 不可用');
      await area.set({ [fullKey(key)]: String(value) });
    },
    async remove(key) {
      if (!area || typeof area.remove !== 'function') return undefined;
      return area.remove(fullKey(key));
    },
  };
}

/**
 * IndexedDB 适配器（键值单 object store）。`factory` 可注入以便测试；
 * 默认使用 globalThis.indexedDB。任何打开/事务错误都以 Error 抛出，由 store 兜底。
 */
export function createIndexedDbStorageAdapter({
  factory = globalThis.indexedDB,
  name = 'bb-debug-journal',
  storeName = 'journal',
  dbVersion = 1,
} = {}) {
  let dbPromise = null;
  const openDb = () => {
    if (!factory || typeof factory.open !== 'function') {
      return Promise.reject(new Error('IndexedDB 不可用'));
    }
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = factory.open(name, dbVersion);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db && db.objectStoreNames && !db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open 失败'));
    });
    return dbPromise;
  };
  const execute = async (mode, action) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(storeName, mode);
      } catch (error) {
        reject(error);
        return;
      }
      const store = transaction.objectStore(storeName);
      let request;
      let result = null;
      try {
        request = action(store);
      } catch (error) {
        reject(error);
        return;
      }
      if (request) {
        request.onsuccess = () => {
          result = request.result === undefined ? null : request.result;
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB request 失败'));
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务中止'));
    });
  };
  return {
    kind: 'indexeddb',
    open: openDb,
    async get(key) {
      const value = await execute('readonly', (store) => store.get(String(key)));
      return value === undefined ? null : value;
    },
    async set(key, value) {
      await execute('readwrite', (store) => store.put(String(value), String(key)));
      return true;
    },
    async remove(key) {
      await execute('readwrite', (store) => store.delete(String(key)));
      return true;
    },
    async close() {
      if (!dbPromise) return;
      try {
        const db = await dbPromise;
        if (db && typeof db.close === 'function') db.close();
      } finally {
        dbPromise = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// journal store
// ---------------------------------------------------------------------------

/**
 * 创建 journal 状态机。
 * @param {{
 *   storage?: {get: Function, set: Function, remove?: Function},
 *   clock?: () => number,
 *   redact?: (value: unknown) => unknown,
 *   limits?: Partial<typeof DEFAULT_JOURNAL_LIMITS>,
 *   onChange?: (event: object) => void,
 *   storageKey?: string,
 * }} [options]
 */
export function createDebugJournalStore(options = {}) {
  const limits = normalizeLimits(options.limits || {});
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const storage = options.storage || createMemoryStorage();
  const redact = typeof options.redact === 'function' ? options.redact : redactJournalEvent;
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const storageKey = String(options.storageKey || JOURNAL_STORAGE_KEY);

  const state = {
    seq: 0,
    savedSeq: 0,
    events: [], // 按 seq 升序的环形缓冲
    bySeq: new Map(), // seq -> event
    sizeBySeq: new Map(), // seq -> bytes
    bytes: 0,
    sessions: new Map(), // sessionId -> session record
    timeIndex: [], // [{ seq, at }] 按 (at, seq) 升序
    evictions: [], // 最近淘汰明细（上限 JOURNAL_EVICTION_LIMIT）
    evictionCounts: new Map(), // reason -> count（全局）
    sessionEvictions: new Map(), // sessionId -> count（全局）
    sessionReasonCounts: new Map(), // sessionId -> Map(reason -> count)
    hydrated: false,
    version: JOURNAL_STORE_VERSION,
  };
  let flushPromise = null;
  let pendingFlush = false;

  function recordEviction(entry) {
    const reason = EVICTION_REASON_SET.has(entry.reason) ? entry.reason : String(entry.reason || 'unknown');
    state.evictionCounts.set(reason, (state.evictionCounts.get(reason) || 0) + 1);
    if (entry.sessionId) {
      state.sessionEvictions.set(entry.sessionId, (state.sessionEvictions.get(entry.sessionId) || 0) + 1);
      const perSession = state.sessionReasonCounts.get(entry.sessionId) || new Map();
      perSession.set(reason, (perSession.get(reason) || 0) + 1);
      state.sessionReasonCounts.set(entry.sessionId, perSession);
    }
    state.evictions.push({
      seq: Number.isInteger(entry.seq) ? entry.seq : null,
      sessionId: entry.sessionId || null,
      reason,
      at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : clock(),
      ...(Number.isFinite(Number(entry.bytes)) ? { bytes: Number(entry.bytes) } : {}),
      ...(isPlainObject(entry.detail) ? { detail: entry.detail } : {}),
    });
    if (state.evictions.length > JOURNAL_EVICTION_LIMIT) {
      state.evictions.splice(0, state.evictions.length - JOURNAL_EVICTION_LIMIT);
    }
  }

  function ensureSession(sessionId) {
    let session = state.sessions.get(sessionId);
    if (!session) {
      const now = clock();
      session = {
        id: sessionId,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
        count: 0,
        evictedCount: 0,
        meta: {},
      };
      state.sessions.set(sessionId, session);
    }
    return session;
  }

  function timeIndexInsert(event) {
    const index = state.timeIndex;
    let low = 0;
    let high = index.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const current = index[mid];
      if (current.at < event.at || (current.at === event.at && current.seq < event.seq)) low = mid + 1;
      else high = mid;
    }
    index.splice(low, 0, { seq: event.seq, at: event.at });
  }

  function timeIndexRemove(seq) {
    const index = state.timeIndex;
    for (let position = 0; position < index.length; position += 1) {
      if (index[position].seq === seq) {
        index.splice(position, 1);
        return true;
      }
    }
    return false;
  }

  function insertEvent(event, bytes) {
    state.events.push(event);
    state.bySeq.set(event.seq, event);
    state.sizeBySeq.set(event.seq, bytes);
    state.bytes += bytes;
    timeIndexInsert(event);
    const session = ensureSession(event.sessionId);
    session.count += 1;
    session.updatedAt = event.at > session.updatedAt ? event.at : clock();
  }

  function removeEvent(event, reason) {
    if (!event) return null;
    const index = state.events.findIndex((item) => item.seq === event.seq);
    if (index < 0) return null;
    state.events.splice(index, 1);
    state.bySeq.delete(event.seq);
    const bytes = state.sizeBySeq.get(event.seq) || 0;
    state.sizeBySeq.delete(event.seq);
    state.bytes = Math.max(0, state.bytes - bytes);
    timeIndexRemove(event.seq);
    const session = state.sessions.get(event.sessionId);
    if (session) {
      session.count = Math.max(0, session.count - 1);
      session.evictedCount += 1;
    }
    recordEviction({ seq: event.seq, sessionId: event.sessionId, reason, at: clock(), bytes });
    return event;
  }

  function evictSession(session, reason) {
    const victim = state.events.filter((event) => event.sessionId === session.id);
    const removed = [];
    for (const event of victim) {
      if (removeEvent(event, reason)) removed.push(event);
    }
    state.sessions.delete(session.id);
    return removed;
  }

  function enforceLimits() {
    const evicted = [];
    // 1) 单会话环形缓冲
    for (const session of state.sessions.values()) {
      let guard = 0;
      while (session.count > limits.maxSessionEvents && guard < state.events.length) {
        guard += 1;
        const oldest = state.events.find((event) => event.sessionId === session.id);
        if (!oldest) break;
        const removed = removeEvent(oldest, EVICTION_REASONS.SESSION);
        if (removed) evicted.push({ seq: removed.seq, sessionId: removed.sessionId, reason: EVICTION_REASONS.SESSION });
      }
    }
    // 2) 全局环形缓冲
    while (state.events.length > limits.maxEvents) {
      const oldest = state.events[0];
      if (!oldest) break;
      const removed = removeEvent(oldest, EVICTION_REASONS.GLOBAL);
      if (!removed) break;
      evicted.push({ seq: removed.seq, sessionId: removed.sessionId, reason: EVICTION_REASONS.GLOBAL });
    }
    // 3) 字节预算（保留最后一条，避免一条大事件把缓冲清空）
    while (state.bytes > limits.maxBytes && state.events.length > 1) {
      const oldest = state.events[0];
      if (!oldest) break;
      const removed = removeEvent(oldest, EVICTION_REASONS.BYTES);
      if (!removed) break;
      evicted.push({ seq: removed.seq, sessionId: removed.sessionId, reason: EVICTION_REASONS.BYTES });
    }
    // 4) 会话容量：淘汰最久未更新的会话
    if (state.sessions.size > limits.maxSessions) {
      const candidates = [...state.sessions.values()].sort((left, right) => {
        const leftAt = left.endedAt == null ? left.updatedAt : left.endedAt;
        const rightAt = right.endedAt == null ? right.updatedAt : right.endedAt;
        if (leftAt !== rightAt) return leftAt - rightAt;
        return String(left.id).localeCompare(String(right.id));
      });
      let excess = state.sessions.size - limits.maxSessions;
      for (const session of candidates) {
        if (excess <= 0) break;
        if (session.count === 0) {
          state.sessions.delete(session.id);
          recordEviction({ seq: null, sessionId: session.id, reason: EVICTION_REASONS.SESSION_CAPACITY, at: clock() });
          excess -= 1;
          continue;
        }
        const removed = evictSession(session, EVICTION_REASONS.SESSION_CAPACITY);
        for (const event of removed) evicted.push({ seq: event.seq, sessionId: event.sessionId, reason: EVICTION_REASONS.SESSION_CAPACITY });
        excess -= 1;
      }
    }
    return evicted;
  }

  function resetState({ hydrated = false } = {}) {
    state.seq = 0;
    state.savedSeq = 0;
    state.events = [];
    state.bySeq = new Map();
    state.sizeBySeq = new Map();
    state.bytes = 0;
    state.sessions = new Map();
    state.timeIndex = [];
    state.evictions = [];
    state.evictionCounts = new Map();
    state.sessionEvictions = new Map();
    state.sessionReasonCounts = new Map();
    state.hydrated = hydrated;
  }

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  /**
   * 追加一条事件。返回存下来的扁平事件（含 seq/sessionId/at/type）与本次淘汰列表。
   * 事件 payload 在写入前统一过 redactor；超限事件会降级成带 dropped 标记的 stub。
   */
  function append(sessionId, event, appendOptions = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id) throw new Error('debug journal append 需要 sessionId');
    const rawAt = appendOptions.at != null ? appendOptions.at : (event && event.at);
    const at = Number.isFinite(Number(rawAt)) ? Number(rawAt) : clock();
    const rawType = appendOptions.type != null ? appendOptions.type : (event && event.type);
    const type = String(rawType == null || rawType === '' ? 'event' : rawType).slice(0, 96);
    const source = isPlainObject(event) ? event : { value: event };
    let payload;
    try {
      payload = redact ? redact(source) : { ...source };
    } catch {
      payload = { value: '[redact-failed]' };
    }
    if (!isPlainObject(payload)) payload = { value: payload };
    payload = { ...payload };
    delete payload.seq;
    delete payload.sessionId;
    delete payload.at;
    delete payload.type;

    const seq = state.seq + 1;
    const stored = { seq, sessionId: id, at, type, ...payload };
    let bytes = jsonByteLength(stored);
    const evicted = [];
    if (bytes > limits.maxEventBytes) {
      const originalBytes = bytes;
      const keys = Object.keys(payload).slice(0, 16);
      const stub = { seq, sessionId: id, at, type, dropped: true, reason: EVICTION_REASONS.EVENT_TOO_LARGE, bytes: originalBytes, keys };
      recordEviction({
        seq,
        sessionId: id,
        reason: EVICTION_REASONS.EVENT_TOO_LARGE,
        at,
        bytes: originalBytes,
        detail: { keys, maxEventBytes: limits.maxEventBytes },
      });
      state.seq = seq;
      insertEvent(stub, jsonByteLength(stub));
      const oversizeEvicted = enforceLimits();
      if (onChange) {
        try {
          onChange(cloneEvent(stub));
        } catch {
          // onChange 是观察者，不允许影响 journal 本身
        }
      }
      return { ...cloneEvent(stub), evicted: [...evicted, ...oversizeEvicted] };
    }
    state.seq = seq;
    insertEvent(stored, bytes);
    const limitEvicted = enforceLimits();
    if (onChange) {
      try {
        onChange(cloneEvent(stored));
      } catch {
        // 同上
      }
    }
    return { ...cloneEvent(stored), evicted: limitEvicted };
  }

  /** 批量追加（同一 session）。 */
  function appendMany(sessionId, events, appendOptions = {}) {
    const out = [];
    for (const event of Array.isArray(events) ? events : []) {
      out.push(append(sessionId, event, appendOptions));
    }
    return out;
  }

  /** 开始会话（幂等；重复调用只更新 meta）。 */
  function beginSession(sessionId, meta = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id) throw new Error('beginSession 需要 sessionId');
    const session = ensureSession(id);
    session.endedAt = null;
    if (isPlainObject(meta) && Object.keys(meta).length) {
      session.meta = redact ? redact(meta) : { ...meta };
    }
    session.updatedAt = clock();
    enforceLimits();
    return sessionSummary(id);
  }

  /** 结束会话（幂等）。 */
  function endSession(sessionId, meta = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id) throw new Error('endSession 需要 sessionId');
    const session = ensureSession(id);
    session.endedAt = clock();
    session.updatedAt = session.endedAt;
    if (isPlainObject(meta) && Object.keys(meta).length) {
      session.meta = { ...(session.meta || {}), ...(redact ? redact(meta) : meta) };
    }
    return sessionSummary(id);
  }

  /** 清空会话事件但保留会话元数据（debug.start 复用）。 */
  function clearSession(sessionId, { reason = EVICTION_REASONS.CLEARED } = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id) throw new Error('clearSession 需要 sessionId');
    const session = state.sessions.get(id);
    const removed = [];
    if (session) {
      for (const event of state.events.filter((item) => item.sessionId === id)) {
        if (removeEvent(event, reason)) removed.push(event);
      }
      session.count = 0;
      session.updatedAt = clock();
    }
    return removed;
  }

  /** 彻底删除会话（tab 关闭 / 显式 forget）。 */
  function removeSession(sessionId) {
    const id = normalizeSessionId(sessionId);
    if (!id) return false;
    const session = state.sessions.get(id);
    if (!session) return false;
    evictSession(session, EVICTION_REASONS.CLEARED);
    state.sessions.delete(id);
    state.sessionEvictions.delete(id);
    return true;
  }

  // -------------------------------------------------------------------------
  // 读取 / 查询
  // -------------------------------------------------------------------------

  function matchesFilters(event, filters) {
    if (!event) return false;
    if (filters.sinceSeq && !(event.seq > filters.sinceSeq)) return false;
    if (filters.since != null && !(event.at >= filters.since)) return false;
    if (filters.until != null && !(event.at <= filters.until)) return false;
    if (filters.types && !filters.types.has(event.type)) return false;
    return true;
  }

  /** 时间索引范围扫描：[from, to]，返回 seq 升序事件。 */
  function eventsInWindow(from, to, { sessionId = null } = {}) {
    const start = Number.isFinite(Number(from)) ? Number(from) : -Infinity;
    const end = Number.isFinite(Number(to)) ? Number(to) : Infinity;
    if (end < start) return [];
    const index = state.timeIndex;
    let low = 0;
    let high = index.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (index[mid].at < start) low = mid + 1;
      else high = mid;
    }
    const id = sessionId == null ? null : normalizeSessionId(sessionId);
    const out = [];
    for (let position = low; position < index.length; position += 1) {
      const entry = index[position];
      if (entry.at > end) break;
      const event = state.bySeq.get(entry.seq);
      if (!event) continue;
      if (id && event.sessionId !== id) continue;
      out.push(event);
    }
    // 时间索引本身按 (at, seq) 升序，这里保持「时间窗内按时间排序」的语义。
    return out;
  }

  /**
   * 读取事件（seq 升序；limit 取最后 N 条）。
   */
  function read(sessionId, readOptions = {}) {
    const id = sessionId == null ? null : normalizeSessionId(sessionId);
    const filters = {
      sinceSeq: Number.isFinite(Number(readOptions.sinceSeq)) ? Number(readOptions.sinceSeq) : 0,
      since: readOptions.since == null ? null : Number(readOptions.since),
      until: readOptions.until == null ? null : Number(readOptions.until),
      types: normalizeTypes(readOptions.types || readOptions.type),
    };
    let list;
    if (filters.since != null || filters.until != null) {
      list = eventsInWindow(filters.since == null ? -Infinity : filters.since, filters.until == null ? Infinity : filters.until, { sessionId: id });
    } else {
      list = id ? state.events.filter((event) => event.sessionId === id) : state.events.slice();
    }
    list = list.filter((event) => matchesFilters(event, { ...filters, since: null, until: null }));
    const limit = Number(readOptions.limit) > 0 ? Math.floor(Number(readOptions.limit)) : 0;
    if (limit) list = list.slice(-limit);
    const order = String(readOptions.order || 'asc');
    if (order === 'desc') list = list.slice().reverse();
    return list.map(cloneEvent);
  }

  /**
   * 分页查询（供 debug.history.detail / 离线导出复用）。
   * @returns {{total: number, offset: number, limit: number, returned: number, hasMore: boolean, nextOffset: number|null, items: object[]}}
   */
  function query(queryOptions = {}) {
    const order = String(queryOptions.order || 'asc') === 'desc' ? 'desc' : 'asc';
    const items = read(queryOptions.sessionId == null ? null : queryOptions.sessionId, {
      since: queryOptions.since,
      until: queryOptions.until,
      types: queryOptions.types || queryOptions.type,
      order: 'asc',
    });
    const total = items.length;
    const offset = Math.max(0, Number.isFinite(Number(queryOptions.offset)) ? Math.floor(Number(queryOptions.offset)) : 0);
    const limitRaw = Number(queryOptions.limit);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 100, 1), 1000);
    const ordered = order === 'desc' ? items.slice().reverse() : items;
    const page = ordered.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      total,
      offset,
      limit,
      returned: page.length,
      hasMore: next < total,
      nextOffset: next < total ? next : null,
      items: page,
    };
  }

  function sessionSummary(sessionId) {
    const id = normalizeSessionId(sessionId);
    const session = id ? state.sessions.get(id) : null;
    if (!session) return null;
    return {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      endedAt: session.endedAt,
      count: session.count,
      evictedCount: session.evictedCount,
      meta: session.meta || {},
    };
  }

  /** 淘汰明细 + 聚合计数（coverage/gaps 消费）。传 sessionId 时只返回该会话的统计。 */
  function evictionReport(sessionId = null) {
    const id = sessionId == null ? null : normalizeSessionId(sessionId);
    if (id) {
      const reasonMap = state.sessionReasonCounts.get(id) || new Map();
      const counts = Object.fromEntries(reasonMap);
      const total = [...reasonMap.values()].reduce((sum, count) => sum + count, 0);
      return {
        total,
        counts,
        sessions: { [id]: total },
        recent: state.evictions.filter((entry) => entry.sessionId === id).slice(-20),
        limit: JOURNAL_EVICTION_LIMIT,
      };
    }
    return {
      total: [...state.evictionCounts.values()].reduce((sum, count) => sum + count, 0),
      counts: Object.fromEntries(state.evictionCounts),
      sessions: Object.fromEntries(state.sessionEvictions),
      recent: state.evictions.map((entry) => ({ ...entry })),
      limit: JOURNAL_EVICTION_LIMIT,
    };
  }

  /** 快照：事件 + 会话 + 索引统计，供导出/coverage 消费。 */
  function snapshot(snapshotOptions = {}) {
    const events = read(
      snapshotOptions.sessionId == null ? null : snapshotOptions.sessionId,
      {
        since: snapshotOptions.since,
        until: snapshotOptions.until,
        types: snapshotOptions.types || snapshotOptions.type,
        limit: snapshotOptions.limit,
        order: snapshotOptions.order || 'asc',
      },
    );
    const byType = {};
    for (const event of events) byType[event.type] = (byType[event.type] || 0) + 1;
    return {
      version: state.version,
      seq: state.seq,
      savedSeq: state.savedSeq,
      hydrated: state.hydrated,
      bytes: state.bytes,
      limits,
      sessions: [...state.sessions.values()].map((session) => sessionSummary(session.id)),
      events,
      count: events.length,
      byType,
      evictions: evictionReport(snapshotOptions.sessionId == null ? null : snapshotOptions.sessionId),
      timeRange: state.timeIndex.length
        ? { from: state.timeIndex[0].at, to: state.timeIndex[state.timeIndex.length - 1].at }
        : { from: null, to: null },
    };
  }

  function stats() {
    return {
      version: state.version,
      seq: state.seq,
      savedSeq: state.savedSeq,
      events: state.events.length,
      bytes: state.bytes,
      sessions: state.sessions.size,
      timeIndex: state.timeIndex.length,
      hydrated: state.hydrated,
      evictions: [...state.evictionCounts.values()].reduce((sum, count) => sum + count, 0),
      limits,
    };
  }

  // -------------------------------------------------------------------------
  // 持久化 / 恢复
  // -------------------------------------------------------------------------

  function serializeState() {
    return JSON.stringify({
      version: JOURNAL_STORE_VERSION,
      seq: state.seq,
      savedAt: new Date(clock()).toISOString(),
      sessions: [...state.sessions.values()].map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        endedAt: session.endedAt,
        count: session.count,
        evictedCount: session.evictedCount,
        meta: session.meta || {},
      })),
      evictions: state.evictions.slice(-JOURNAL_EVICTION_LIMIT),
      evictionCounts: Object.fromEntries(state.evictionCounts),
      sessionEvictions: Object.fromEntries(state.sessionEvictions),
      sessionReasonCounts: Object.fromEntries(
        [...state.sessionReasonCounts.entries()].map(([sessionId, counts]) => [sessionId, Object.fromEntries(counts)]),
      ),
      events: state.events.map(cloneEvent),
    });
  }

  /**
   * 落盘。并发调用会 coalesce 到同一次写入（storage 写放大保护）。
   * @returns {Promise<{written: boolean, seq: number, bytes?: number, events?: number, reason?: string, error?: string}>}
   */
  async function flush(flushOptions = {}) {
    if (flushPromise) {
      pendingFlush = true;
      return flushPromise;
    }
    if (flushOptions.force !== true && state.savedSeq === state.seq) {
      return { written: false, seq: state.seq, reason: 'unchanged' };
    }
    const text = serializeState();
    flushPromise = (async () => {
      try {
        await storage.set(storageKey, text);
        state.savedSeq = state.seq;
        return { written: true, seq: state.seq, bytes: utf8ByteLength(text), events: state.events.length };
      } catch (error) {
        return { written: false, seq: state.seq, reason: 'storage-error', error: String((error && error.message) || error) };
      } finally {
        flushPromise = null;
        pendingFlush = false;
      }
    })();
    return flushPromise;
  }

  /**
   * 从 storage 恢复（fail-safe：损坏返回 reason，不抛异常）。
   * 事件按 seq 升序恢复，重复/非法事件计入 skipped；恢复后重新执行上限淘汰。
   */
  async function hydrate(hydrateOptions = {}) {
    if (state.hydrated && hydrateOptions.force !== true) {
      return { restored: false, reason: 'already-hydrated', events: state.events.length, seq: state.seq };
    }
    let raw = null;
    try {
      raw = await storage.get(storageKey);
    } catch (error) {
      state.hydrated = true;
      return { restored: false, reason: 'storage-error', error: String((error && error.message) || error) };
    }
    state.hydrated = true;
    if (raw == null || raw === '') return { restored: false, reason: 'empty' };
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return { restored: false, reason: 'corrupt', error: 'JSON.parse 失败' };
    }
    if (!isPlainObject(parsed)) return { restored: false, reason: 'corrupt', error: '不是对象' };
    const version = Number(parsed.version);
    if (version !== JOURNAL_STORE_VERSION) {
      return { restored: false, reason: 'version-mismatch', version: Number.isFinite(version) ? version : null };
    }
    resetState({ hydrated: true });
    const rawEvents = Array.isArray(parsed.events) ? parsed.events : [];
    const sorted = rawEvents
      .filter(validStoredEvent)
      .sort((left, right) => left.seq - right.seq);
    let skipped = rawEvents.length - sorted.length;
    for (const event of sorted) {
      if (event.seq <= state.seq) {
        skipped += 1;
        continue;
      }
      const stored = { ...event };
      const bytes = jsonByteLength(stored);
      state.seq = stored.seq;
      insertEvent(stored, bytes);
    }
    const minSeq = Number.isFinite(Number(parsed.seq)) ? Number(parsed.seq) : 0;
    if (minSeq > state.seq) state.seq = Math.floor(minSeq);
    for (const rawSession of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
      if (!isPlainObject(rawSession)) continue;
      const id = normalizeSessionId(rawSession.id);
      if (!id) continue;
      const session = ensureSession(id);
      if (Number.isFinite(Number(rawSession.createdAt))) session.createdAt = Number(rawSession.createdAt);
      if (Number.isFinite(Number(rawSession.updatedAt))) session.updatedAt = Number(rawSession.updatedAt);
      if (Number.isFinite(Number(rawSession.endedAt))) session.endedAt = Number(rawSession.endedAt);
      if (isPlainObject(rawSession.meta)) session.meta = rawSession.meta;
    }
    for (const entry of Array.isArray(parsed.evictions) ? parsed.evictions : []) {
      if (!isPlainObject(entry)) continue;
      state.evictions.push({ ...entry });
    }
    if (state.evictions.length > JOURNAL_EVICTION_LIMIT) state.evictions.splice(0, state.evictions.length - JOURNAL_EVICTION_LIMIT);
    if (isPlainObject(parsed.evictionCounts)) {
      for (const [reason, count] of Object.entries(parsed.evictionCounts)) {
        const value = Number(count);
        if (Number.isFinite(value) && value > 0) state.evictionCounts.set(String(reason), Math.floor(value));
      }
    }
    if (isPlainObject(parsed.sessionEvictions)) {
      for (const [sessionId, count] of Object.entries(parsed.sessionEvictions)) {
        const value = Number(count);
        if (Number.isFinite(value) && value > 0) state.sessionEvictions.set(String(sessionId), Math.floor(value));
      }
    }
    if (isPlainObject(parsed.sessionReasonCounts)) {
      for (const [sessionId, counts] of Object.entries(parsed.sessionReasonCounts)) {
        if (!isPlainObject(counts)) continue;
        const map = new Map();
        for (const [reason, count] of Object.entries(counts)) {
          const value = Number(count);
          if (Number.isFinite(value) && value > 0) map.set(String(reason), Math.floor(value));
        }
        if (map.size) state.sessionReasonCounts.set(String(sessionId), map);
      }
    }
    state.savedSeq = state.seq;
    const evicted = enforceLimits();
    return {
      restored: true,
      events: state.events.length,
      skipped,
      seq: state.seq,
      sessions: state.sessions.size,
      evicted: evicted.length,
      bytes: state.bytes,
    };
  }

  function exportState() {
    return serializeState();
  }

  /** 测试/诊断用：注入的 storage 与 key。 */
  function describe() {
    return { storage: storage.kind || 'injected', storageKey, limits, version: state.version };
  }

  return {
    append,
    appendMany,
    beginSession,
    endSession,
    clearSession,
    removeSession,
    read,
    query,
    eventsInWindow,
    sessionSummary,
    evictionReport,
    snapshot,
    stats,
    flush,
    hydrate,
    exportState,
    describe,
    _state: state, // 只读诊断入口（测试断言索引结构，生产代码不要写）
  };
}
