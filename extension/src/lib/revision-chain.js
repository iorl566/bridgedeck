// src/lib/revision-chain.js —— 四项 revision/epoch 的全链路单源（control/authority/revision/frameEpoch）。
//
// 0.3.0 的四项计数分散在 control.js 的一次性对象、content/cooperation.js 的
// frameState 与 control-generation.js 的 Map 里，问题有三个：
//   1. service worker 重启后内存 Map 清空，generation/revision 回退到 0，
//      内容脚本的 authority 更高，于是后台消息被判 stale；
//   2. 没有统一的“谁比谁旧”判定，各处自己写 `<` 比较，方向经常搞反；
//   3. 计数与文档（navigation 后 DOM revision 归零）没有区分，导航会被误判成回退。
//
// 本模块是这四个计数的单源：
//   controlRevision   控制面变化（接管/交回/借用/暂停/交接）
//   authorityRevision 动作许可被撤销（人工介入/暂停）
//   revision          当前文档的 DOM 代数（文档内单调；换文档按 document 重置）
//   frameEpoch        文档/frame 集合变化（导航、top-layer 重建）
// 另外一并维护 epoch、generation、documentEpoch 三个辅助计数（内容脚本 authority
// 与上下文代），保证“跨 service worker 重启不倒退”。
//
// 不变量：
//   - 所有计数只增不减（revision 只在 document 变化时重置，并推进 documentEpoch）；
//   - 载入持久化状态时按字段取 max（restore/adopt），绝不覆盖成更小的值；
//   - 写入持久化前先读再 merge-max，避免旧快照把新计数写回去；
//   - stale 判定只在一处实现：compareRevisionVectors。

export const REVISION_FIELDS = Object.freeze(['controlRevision', 'authorityRevision', 'revision', 'frameEpoch']);
export const AUX_FIELDS = Object.freeze(['epoch', 'generation']);
export const CHAIN_FIELDS = Object.freeze([...REVISION_FIELDS, ...AUX_FIELDS]);

const FIELD_SET = new Set(CHAIN_FIELDS);
const DEFAULT_KEY = 'bb.revisionChain';
const DEFAULT_MAX_TABS = 256;

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** 空向量（所有计数从 0 起）。 */
export function emptyRevisionVector() {
  const vector = {};
  for (const field of CHAIN_FIELDS) vector[field] = 0;
  return vector;
}

/** 把一个任意对象规整成完整的计数向量（缺字段补 0，非法值补 0）。 */
export function normalizeRevisionVector(value) {
  const vector = emptyRevisionVector();
  if (!value || typeof value !== 'object') return vector;
  const source = value.four && typeof value.four === 'object' ? { ...value, ...value.four } : value;
  for (const field of CHAIN_FIELDS) {
    if (source[field] !== undefined) vector[field] = count(source[field]);
  }
  return vector;
}

/**
 * 纯函数：比较两个计数向量。
 * @returns {{
 *   equal: boolean,
 *   stale: boolean,
 *   side: 'local'|'remote'|null,
 *   fields: Array<{field:string, local:number, remote:number, delta:number, side:'local'|'remote'}>,
 *   behind: string[], ahead: string[], maxDistance: number
 * }}
 * side='remote' 表示 remote 落后（内容脚本/会话持有旧 authority，需要把它们抬高）；
 * side='local' 表示本进程落后（重启后回退，需要 adopt remote 的更大值）。
 */
export function compareRevisionVectors(localInput, remoteInput) {
  const local = normalizeRevisionVector(localInput);
  const remote = normalizeRevisionVector(remoteInput);
  const fields = [];
  const behind = [];
  const ahead = [];
  let maxDistance = 0;
  for (const field of CHAIN_FIELDS) {
    const left = local[field];
    const right = remote[field];
    if (left === right) continue;
    const side = left > right ? 'remote' : 'local';
    const delta = Math.abs(left - right);
    maxDistance = Math.max(maxDistance, delta);
    fields.push({ field, local: left, remote: right, delta, side });
    if (side === 'local') behind.push(field);
    else ahead.push(field);
  }
  const remoteBehind = fields.some((entry) => entry.side === 'remote');
  const localBehind = fields.some((entry) => entry.side === 'local');
  return {
    equal: fields.length === 0,
    stale: fields.length > 0,
    side: remoteBehind && localBehind ? 'mixed' : remoteBehind ? 'remote' : localBehind ? 'local' : null,
    fields,
    behind,
    ahead,
    maxDistance,
  };
}

/** 纯函数：按字段取 max 合并两个向量（持久化写入与恢复都用它保证不倒退）。 */
export function mergeRevisionVectors(baseInput, otherInput) {
  const base = normalizeRevisionVector(baseInput);
  const other = normalizeRevisionVector(otherInput);
  const merged = emptyRevisionVector();
  for (const field of CHAIN_FIELDS) merged[field] = Math.max(base[field], other[field]);
  return merged;
}

/** 纯函数：给定本地向量与远端向量，算出“对齐后”的向量（每字段 max）。 */
export function alignRevisionVectors(localInput, remoteInput) {
  const comparison = compareRevisionVectors(localInput, remoteInput);
  return { comparison, aligned: mergeRevisionVectors(localInput, remoteInput) };
}

/** 默认持久化：chrome.storage.session（service worker 重启后仍存在，浏览器重启才清）。 */
export function createSessionPersistence(options = {}) {
  const key = typeof options.key === 'string' && options.key ? options.key : DEFAULT_KEY;
  const areaName = options.area === 'local' ? 'local' : 'session';
  function area() {
    const api = options.chrome || (typeof globalThis !== 'undefined' ? globalThis.chrome : null);
    const storage = api && api.storage ? api.storage[areaName] : null;
    return storage || null;
  }
  return {
    key,
    async load() {
      const storage = area();
      if (!storage || typeof storage.get !== 'function') return null;
      try {
        const stored = await storage.get(key);
        const payload = stored ? stored[key] : null;
        return payload && typeof payload === 'object' ? payload : null;
      } catch {
        return null;
      }
    },
    async save(payload) {
      const storage = area();
      if (!storage || typeof storage.set !== 'function') return { ok: false, code: 'STORAGE_UNAVAILABLE' };
      try {
        await storage.set({ [key]: payload });
        return { ok: true, key };
      } catch (error) {
        return { ok: false, code: 'STORAGE_WRITE', error: String((error && error.message) || error) };
      }
    },
  };
}

function normalizeTabId(tabId) {
  // null/''/非数字都不是合法 tabId（Number(null)===0 会把“没传”误判成 tab 0）。
  if (tabId == null || tabId === '') return null;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : null;
}

function emptyRecord(tabId, now) {
  return {
    tabId,
    ...emptyRevisionVector(),
    document: '',
    documentEpoch: 0,
    updatedAt: now,
    alignedAt: 0,
    staleAt: 0,
    staleSide: null,
  };
}

function stripRecord(record) {
  return {
    tabId: record.tabId,
    controlRevision: record.controlRevision,
    authorityRevision: record.authorityRevision,
    revision: record.revision,
    frameEpoch: record.frameEpoch,
    epoch: record.epoch,
    generation: record.generation,
    document: record.document,
    documentEpoch: record.documentEpoch,
    updatedAt: record.updatedAt,
    alignedAt: record.alignedAt,
    staleAt: record.staleAt,
    staleSide: record.staleSide,
  };
}

function toVector(record) {
  const vector = {};
  for (const field of CHAIN_FIELDS) vector[field] = record[field];
  return vector;
}

/** 把 delta 规整成 {field: 增量}：数字按值、true/字段名 记 1。 */
export function normalizeBump(delta) {
  const bump = {};
  if (delta == null) return bump;
  if (typeof delta === 'string') {
    if (FIELD_SET.has(delta)) bump[delta] = 1;
    return bump;
  }
  if (Array.isArray(delta)) {
    for (const field of delta) if (FIELD_SET.has(String(field))) bump[String(field)] = 1;
    return bump;
  }
  if (typeof delta !== 'object') return bump;
  for (const [field, value] of Object.entries(delta)) {
    if (!FIELD_SET.has(field)) continue;
    if (value === true) bump[field] = 1;
    else if (value === false || value == null) continue;
    else if (Number.isFinite(Number(value)) && Number(value) > 0) bump[field] = Math.floor(Number(value));
  }
  return bump;
}

/**
 * 创建一个 revision 链实例。
 * @param {{now?: () => number, persist?: {load: Function, save: Function}, persistKey?: string,
 *          maxTabs?: number, debounceMs?: number, autoLoad?: boolean}} [options]
 */
export function createRevisionChain(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const persist = options.persist && typeof options.persist.load === 'function' && typeof options.persist.save === 'function'
    ? options.persist
    : null;
  const persistKey = typeof options.persistKey === 'string' && options.persistKey ? options.persistKey : (persist && persist.key) || DEFAULT_KEY;
  const maxTabs = Number.isInteger(options.maxTabs) && options.maxTabs > 0 ? options.maxTabs : DEFAULT_MAX_TABS;
  const tabs = new Map();
  const stats = { bumps: 0, observes: 0, aligns: 0, stale: 0, restores: 0, writes: 0, writeFailures: 0, documentResets: 0 };
  let dirty = false;

  function recordFor(tabId) {
    const id = normalizeTabId(tabId);
    if (id == null) return null;
    let record = tabs.get(id);
    if (!record) {
      if (tabs.size >= maxTabs) {
        const oldest = tabs.keys().next().value;
        if (oldest !== undefined) tabs.delete(oldest);
      }
      record = emptyRecord(id, now());
      tabs.set(id, record);
    }
    return record;
  }

  /** 递增若干计数；返回新向量。非法 tabId 返回 null（不抛异常）。 */
  function bump(tabId, delta) {
    const record = recordFor(tabId);
    if (!record) return null;
    const bumpMap = normalizeBump(delta);
    for (const [field, amount] of Object.entries(bumpMap)) record[field] += amount;
    if (Object.keys(bumpMap).length) {
      record.updatedAt = now();
      dirty = true;
      stats.bumps += 1;
    }
    return toVector(record);
  }

  /**
   * 记录一次“外部权威”的计数（每字段取 max）：service worker 重启后从内容脚本/
   * 会话恢复更大的 authority 时用它，保证本进程不回退。
   */
  function retain(tabId, patch) {
    const record = recordFor(tabId);
    if (!record) return null;
    const vector = normalizeRevisionVector(patch);
    let changed = false;
    for (const field of CHAIN_FIELDS) {
      if (vector[field] > record[field]) {
        record[field] = vector[field];
        changed = true;
      }
    }
    if (changed) {
      record.updatedAt = now();
      dirty = true;
    }
    return toVector(record);
  }

  /**
   * 观察当前文档的 DOM revision。
   * 同文档：revision 取 max（不倒退）；document 变化：revision 重置为观测值并推进
   * documentEpoch（导航后内容脚本 revision 从 0 重来，这不是“回退”）。
   */
  function observe(tabId, observation = {}) {
    const record = recordFor(tabId);
    if (!record) return null;
    stats.observes += 1;
    const observed = observation.revision;
    const documentId = observation.document == null ? '' : String(observation.document).slice(0, 512);
    const sameDocument = !documentId || !record.document || documentId === record.document;
    if (documentId && record.document && documentId !== record.document) {
      record.document = documentId;
      record.documentEpoch += 1;
      record.revision = count(observed);
      record.frameEpoch += 1;
      record.updatedAt = now();
      dirty = true;
      stats.documentResets += 1;
      return { ...toVector(record), document: record.document, documentEpoch: record.documentEpoch, reset: true };
    }
    if (!record.document && documentId) record.document = documentId;
    if (Number.isInteger(Number(observed)) && Number(observed) > record.revision) {
      record.revision = Number(observed);
      record.updatedAt = now();
      dirty = true;
    }
    return { ...toVector(record), document: record.document, documentEpoch: record.documentEpoch, reset: false, sameDocument };
  }

  /** 本进程当前向量。 */
  function record(tabId) {
    const id = normalizeTabId(tabId);
    const stored = id == null ? null : tabs.get(id);
    return stored ? stripRecord(stored) : { ...emptyRecord(id, now()), document: '', documentEpoch: 0, alignedAt: 0, staleAt: 0, staleSide: null };
  }

  /**
   * stale 检测 + 对齐：远端（内容脚本/会话/其它进程）的计数可能落后或超前。
   * 对齐规则：每字段取 max 写回本进程（绝不倒退），并返回方向证据。
   */
  function align(tabId, remote) {
    const stored = recordFor(tabId);
    if (!stored) return null;
    stats.aligns += 1;
    const local = toVector(stored);
    const comparison = compareRevisionVectors(local, remote);
    const aligned = mergeRevisionVectors(local, remote);
    if (!comparison.equal) {
      for (const field of CHAIN_FIELDS) stored[field] = aligned[field];
      stored.updatedAt = now();
      stored.alignedAt = stored.updatedAt;
      stored.staleAt = comparison.stale ? stored.updatedAt : stored.staleAt;
      stored.staleSide = comparison.side;
      dirty = true;
      if (comparison.stale) stats.stale += 1;
    }
    return {
      ok: true,
      tabId: stored.tabId,
      stale: comparison.stale,
      side: comparison.side,
      fields: comparison.fields,
      aligned,
      local,
      remote: normalizeRevisionVector(remote),
      evidence: {
        tabId: stored.tabId,
        local,
        remote: normalizeRevisionVector(remote),
        stale: comparison.stale,
        side: comparison.side,
        behind: comparison.behind,
        ahead: comparison.ahead,
        maxDistance: comparison.maxDistance,
        alignedAt: stored.alignedAt,
      },
    };
  }

  /** 用持久化记录恢复单个 tab（按字段 max，不倒退）。 */
  function restore(tabId, persisted) {
    const record = recordFor(tabId);
    if (!record || !persisted || typeof persisted !== 'object') return record ? stripRecord(record) : null;
    const vector = normalizeRevisionVector(persisted);
    for (const field of CHAIN_FIELDS) record[field] = Math.max(record[field], vector[field]);
    const documentId = persisted.document == null ? '' : String(persisted.document).slice(0, 512);
    if (documentId && !record.document) record.document = documentId;
    if (count(persisted.documentEpoch) > record.documentEpoch) record.documentEpoch = count(persisted.documentEpoch);
    record.updatedAt = now();
    stats.restores += 1;
    return stripRecord(record);
  }

  /** 把持久化载荷（{tabs:{id:record}} 或 {id:record} 或数组）恢复进内存。 */
  function restorePayload(payload) {
    if (!payload || typeof payload !== 'object') return { restored: 0, tabs: [] };
    const source = payload.tabs && typeof payload.tabs === 'object' ? payload.tabs : payload;
    const restored = [];
    if (Array.isArray(source)) {
      for (const entry of source) {
        const id = normalizeTabId(entry && entry.tabId);
        if (id != null) { restore(id, entry); restored.push(id); }
      }
    } else {
      for (const [key, entry] of Object.entries(source)) {
        const id = normalizeTabId(key);
        if (id != null && entry && typeof entry === 'object') { restore(id, entry); restored.push(id); }
      }
    }
    dirty = restored.length > 0;
    return { restored: restored.length, tabs: restored };
  }

  /** 从持久化载入（service worker 重启后第一步）。 */
  async function load() {
    if (!persist) return { restored: 0, tabs: [], skipped: 'no-persist' };
    const payload = await persist.load().catch(() => null);
    if (!payload) return { restored: 0, tabs: [], empty: true };
    const result = restorePayload(payload);
    return { ...result, key: persistKey };
  }

  function payload() {
    const tabsPayload = {};
    for (const [id, stored] of tabs) tabsPayload[id] = stripRecord(stored);
    return { version: 1, key: persistKey, at: now(), tabs: tabsPayload };
  }

  /**
   * 写入持久化。先读回已有快照再按字段 merge-max：即使本进程是刚启动的空白实例，
   * 也不会把别人写入的更大计数覆盖成 0。
   */
  async function flush() {
    if (!persist) return { ok: false, code: 'NO_PERSIST' };
    if (!dirty) return { ok: true, skipped: true, writes: stats.writes };
    let existing = null;
    try { existing = await persist.load(); } catch { existing = null; }
    if (existing && typeof existing === 'object') restorePayload(existing);
    const result = await persist.save(payload());
    if (result && result.ok) {
      stats.writes += 1;
      dirty = false;
    } else {
      stats.writeFailures += 1;
    }
    return { ...result, writes: stats.writes, writeFailures: stats.writeFailures };
  }

  function snapshot(tabId) {
    const stored = record(tabId);
    return {
      ...stored,
      key: persistKey,
      counters: { ...stats },
    };
  }

  function list() {
    return [...tabs.values()].map((stored) => stripRecord(stored));
  }

  function clear(tabId) {
    const id = normalizeTabId(tabId);
    if (id == null) return false;
    const removed = tabs.delete(id);
    if (removed) dirty = true;
    return removed;
  }

  function counters() {
    return { ...stats, tabs: tabs.size, dirty };
  }

  return { bump, retain, observe, record, align, restore, restorePayload, load, flush, payload, snapshot, list, clear, counters };
}

/** 后台共享单例：control.js / cooperation.js / control-generation.js 共用一条链。 */
export const revisionChain = createRevisionChain({ persist: createSessionPersistence() });
