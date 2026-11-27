// src/lib/capture-suppression.js —— 引用计数 capture 抑制（2 帧 ack）。
//
// 截图/原生输入/录制期间要隐藏扩展浮层并拦截人工输入；这些路径可能嵌套
// （例如一次原生输入里夹着截图），所以按引用计数管理：多个持有者同时抑制时，
// 只有最后一个释放才真正解除。隐藏样式要等两帧渲染后才算生效，否则截图会把
// 旧帧带进去；2 帧 ack 的 raf 可注入，便于 Node 单测。
// 本模块只维护状态，不碰 DOM/chrome；调用方（overlay-suppress 等）根据
// snapshot().effective / released.count 决定隐藏与恢复。
const DEFAULT_ACK_FRAMES = 2;
const DEFAULT_MAX_PER_TAB = 64;
const MAX_OWNER_LEN = 48;

let sequence = 0;

function nextToken() {
  sequence = (sequence + 1) % 0xffffff;
  const random = Math.random().toString(36).slice(2, 8);
  return 'cap-' + Date.now().toString(36) + '-' + sequence.toString(36) + '-' + random;
}

function defaultRaf() {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return (callback) => globalThis.requestAnimationFrame(callback);
  }
  // Node/无 rAF 环境退化为宏任务：一次 setTimeout 视为一帧。
  return (callback) => setTimeout(callback, 0);
}

function normalizeTabId(tabId) {
  const id = Number(tabId);
  return Number.isInteger(id) ? id : null;
}

function emptySnapshot(tabId = null) {
  return { tabId, count: 0, active: false, effective: false, pending: [], holders: [], acked: 0, frame: 0 };
}

/**
 * 创建一个独立的抑制状态机（每个实例有自己的 raf/时钟/上限，便于单测隔离）。
 * @param {{raf?: (cb: () => void) => void, ackFrames?: number, maxPerTab?: number, now?: () => number}} [options]
 */
export function createCaptureSuppression(options = {}) {
  const raf = typeof options.raf === 'function' ? options.raf : defaultRaf();
  const ackFrames = Number.isInteger(options.ackFrames) && options.ackFrames >= 0 ? options.ackFrames : DEFAULT_ACK_FRAMES;
  const maxPerTab = Number.isInteger(options.maxPerTab) && options.maxPerTab > 0 ? options.maxPerTab : DEFAULT_MAX_PER_TAB;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const tabs = new Map(); // tabId -> entry
  const stats = { acquired: 0, released: 0, duplicates: 0, limited: 0, badTab: 0, releasedAll: 0 };

  function entryFor(tabId) {
    let entry = tabs.get(tabId);
    if (!entry) {
      entry = { tabId, count: 0, acked: 0, frame: 0, effective: false, holders: new Map(), pending: new Set() };
      tabs.set(tabId, entry);
    }
    return entry;
  }

  function acknowledge(tabId, entry, holder) {
    holder.acked = true;
    holder.frames = ackFrames;
    entry.pending.delete(holder.token);
    entry.acked += 1;
    entry.frame = Math.max(entry.frame, ackFrames);
    // 第一层抑制 ack 后即视为生效；嵌套 acquire 不会把已生效状态翻回 false。
    if (entry.count > 0 && entry.pending.size === 0) entry.effective = true;
  }

  function scheduleAck(tabId, entry, holder) {
    const tick = (remaining) => {
      raf(() => {
        const current = tabs.get(tabId);
        const live = current ? current.holders.get(holder.token) : null;
        if (!current || !live) return; // 已 release：这帧 ack 作废
        live.frames = Math.min(ackFrames, live.frames + 1);
        if (remaining > 1) {
          tick(remaining - 1);
          return;
        }
        acknowledge(tabId, current, live);
      });
    };
    tick(ackFrames);
  }

  /** 取得一次抑制引用；返回结构化结果（超上限不抛异常）。 */
  function acquire(tabId, acquireOptions = {}) {
    const id = normalizeTabId(tabId);
    if (id == null) {
      stats.badTab += 1;
      return { ok: false, code: 'E_CAPTURE_BAD_TAB', tabId: null, count: 0, active: false, effective: false, pending: 0 };
    }
    const owner = String(acquireOptions.owner || '').slice(0, MAX_OWNER_LEN);
    const entry = entryFor(id);
    if (entry.count >= maxPerTab) {
      stats.limited += 1;
      return { ok: false, code: 'E_CAPTURE_LIMIT', tabId: id, count: entry.count, active: true, effective: entry.effective, pending: entry.pending.size, max: maxPerTab };
    }
    const token = nextToken();
    const holder = { token, owner, at: now(), frames: 0, acked: false };
    entry.holders.set(token, holder);
    entry.count = entry.holders.size;
    stats.acquired += 1;
    if (ackFrames <= 0) {
      acknowledge(id, entry, holder);
    } else {
      entry.pending.add(token);
      scheduleAck(id, entry, holder);
    }
    return { ok: true, token, tabId: id, count: entry.count, active: true, effective: entry.effective, pending: entry.pending.size, owner };
  }

  /** 释放一次引用；重复/未知 token 幂等返回 duplicate=true，绝不抛异常。 */
  function release(tabId, token) {
    const id = normalizeTabId(tabId);
    const entry = id == null ? null : tabs.get(id);
    if (!entry || entry.count === 0) {
      stats.duplicates += 1;
      return { ok: true, tabId: id, released: false, duplicate: true, count: 0, active: false, effective: false, pending: 0, disabled: false };
    }
    let key = token == null ? '' : String(token);
    if (!key) {
      // 不带 token：释放最后取得的引用，兼容旧的“计数减一”语义。
      key = [...entry.holders.keys()].pop() || '';
    }
    const holder = key ? entry.holders.get(key) : null;
    if (!holder) {
      stats.duplicates += 1;
      return { ok: true, tabId: id, released: false, duplicate: true, unknownToken: Boolean(key), count: entry.count, active: true, effective: entry.effective, pending: entry.pending.size, disabled: false };
    }
    entry.holders.delete(key);
    entry.pending.delete(key);
    stats.released += 1;
    entry.count = entry.holders.size;
    if (entry.count === 0) {
      tabs.delete(id);
      return { ok: true, tabId: id, released: true, duplicate: false, count: 0, active: false, effective: false, pending: 0, disabled: true, releasedOwner: holder.owner };
    }
    return { ok: true, tabId: id, released: true, duplicate: false, count: entry.count, active: true, effective: entry.effective, pending: entry.pending.size, disabled: false, releasedOwner: holder.owner };
  }

  /** 清掉某 tab 的全部引用（tab 关闭/录制结束时的兜底）。 */
  function releaseAll(tabId) {
    const id = normalizeTabId(tabId);
    const entry = id == null ? null : tabs.get(id);
    if (!entry) return { ok: true, tabId: id, released: 0, count: 0, active: false, effective: false, pending: 0, disabled: true };
    const released = entry.count;
    stats.releasedAll += released;
    tabs.delete(id);
    return { ok: true, tabId: id, released, count: 0, active: false, effective: false, pending: 0, disabled: true };
  }

  function snapshot(tabId) {
    const id = normalizeTabId(tabId);
    const entry = id == null ? null : tabs.get(id);
    if (!entry) return emptySnapshot(id);
    return {
      tabId: id,
      count: entry.count,
      active: entry.count > 0,
      effective: entry.effective,
      acked: entry.acked,
      frame: entry.frame,
      pending: [...entry.pending].map((token) => ({ token, owner: (entry.holders.get(token) || {}).owner || '' })),
      holders: [...entry.holders.values()].map((holder) => ({ token: holder.token, owner: holder.owner, acked: holder.acked, frames: holder.frames, at: holder.at })),
    };
  }

  /** 尚未完成 2 帧 ack 的引用列表。 */
  function pending(tabId) {
    return snapshot(tabId).pending;
  }

  function list() {
    return [...tabs.keys()].map((id) => snapshot(id));
  }

  function clear() {
    const cleared = tabs.size;
    tabs.clear();
    return { ok: true, cleared };
  }

  /** 采集计数（诊断/测试用）：acquired/released/duplicates/limited/badTab。 */
  function counters() {
    return { ...stats, tabs: tabs.size, active: [...tabs.values()].filter((entry) => entry.count > 0).length };
  }

  return { acquire, release, releaseAll, snapshot, pending, list, clear, counters };
}

/** 后台共享单例：overlay-suppress 与 cooperation 状态读取共用同一份计数。 */
export const captureSuppression = createCaptureSuppression();
