// src/control-generation.js —— 无依赖的 authority generation 存储，避免 control/takeover 循环。
//
// 0.3.0 只在内存 Map 里记 generation：service worker 重启后归零，而内容脚本仍持有
// 更高的 authority，于是后台消息被判 stale（这是已修过一次的问题，但根因是“计数
// 不持久、不单调”）。现在 generation 由 revision-chain 承载：
//   - 单调递增，绝不让 retry 把 generation 抬到比分发时更小的值；
//   - 落 chrome.storage.session，service worker 重启后恢复且按 max 合并（不倒退）；
//   - 与四项 revision/epoch（control/authority/revision/frameEpoch）共用一条链，
//     便于合作快照一次读全。
// 仍然导出原来的四个同步函数，调用方不用改。

import { createRevisionChain, createSessionPersistence } from './lib/revision-chain.js';

const PERSIST_KEY = 'bb.control.generation';
const generations = new Map(); // 同步快读缓存（与链保持一致，取 max）
const chain = createRevisionChain({ persist: createSessionPersistence({ key: PERSIST_KEY }), persistKey: PERSIST_KEY });

let flushTimer = null;
let restorePromise = null;
const stats = { bumps: 0, raises: 0, restores: 0, flushOk: 0, flushFail: 0 };

function tabIdOf(tabId) {
  // null/''/非数字都视为没有 tab（Number(null)===0 会把“没传”误判成 tab 0）。
  if (tabId == null || tabId === '') return null;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : null;
}

function mergeCache(id, value) {
  const current = generations.get(id) || 0;
  const next = Math.max(current, Number.isInteger(Number(value)) ? Math.max(0, Number(value)) : 0);
  generations.set(id, next);
  return next;
}

/** 把持久化里更大的 generation 合并进同步缓存（重启后不回退的关键）。 */
function adoptRecord(id, record) {
  if (!record || !Number.isInteger(record.tabId)) return;
  mergeCache(record.tabId, record.generation);
}

/** 测试/诊断用：显式等待恢复完成，返回恢复了多少个 tab。 */
export async function restoreControlGenerations() {
  const result = await chain.load().catch(() => ({ restored: 0, tabs: [] }));
  for (const record of chain.list()) adoptRecord(record.tabId, record);
  stats.restores += 1;
  return result;
}

/** 模块加载即恢复一次（SW 启动）；失败不影响动作，按内存 0 继续。 */
export function ensureControlGenerationsRestored() {
  if (!restorePromise) restorePromise = restoreControlGenerations().catch(() => ({ restored: 0, tabs: [] }));
  return restorePromise;
}

void ensureControlGenerationsRestored();

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushControlGenerations();
  }, 250);
  if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** 立即落盘（会话收尾/测试用）：读回旧快照后 merge-max 再写，绝不写小值。 */
export async function flushControlGenerations() {
  const result = await chain.flush().catch((error) => ({ ok: false, error: String((error && error.message) || error) }));
  if (result && result.ok) stats.flushOk += 1;
  else stats.flushFail += 1;
  return result;
}

export function controlGeneration(tabId) {
  const id = tabIdOf(tabId);
  if (id == null) return 0;
  const cached = generations.get(id) || 0;
  const persisted = chain.record(id).generation;
  return Math.max(cached, persisted);
}

export function bumpControlGeneration(tabId) {
  const id = tabIdOf(tabId);
  if (id == null) return 0;
  const record = chain.bump(id, { generation: true });
  stats.bumps += 1;
  const next = mergeCache(id, record ? record.generation : (generations.get(id) || 0) + 1);
  scheduleFlush();
  return next;
}

/** 把 generation 抬到至少 value（内容脚本已持有更高 authority 时用于重新对齐）。 */
export function raiseControlGeneration(tabId, value) {
  const id = tabIdOf(tabId);
  if (id == null) return 0;
  const wanted = Number.isInteger(Number(value)) ? Math.max(0, Number(value)) : 0;
  const record = chain.retain(id, { generation: wanted });
  stats.raises += 1;
  const next = mergeCache(id, record ? record.generation : wanted);
  scheduleFlush();
  return next;
}

/**
 * authority 对齐：把内容脚本/会话给出的 generation（及其它计数）与本地比较，
 * 返回 stale 方向证据。远端落后 → 调用方应抬高远端；本地落后 → 采纳远端更大值。
 */
export function alignControlGeneration(tabId, remote = {}) {
  const id = tabIdOf(tabId);
  if (id == null) return { ok: false, code: 'E_BAD_ARG', tabId: null };
  const result = chain.align(id, remote);
  if (!result) return { ok: false, code: 'E_BAD_ARG', tabId: id };
  adoptRecord(id, chain.record(id));
  scheduleFlush();
  return { ...result, generation: controlGeneration(id) };
}

/** 四项 revision/epoch + generation 的只读记录（toolbar/CLI 从这里读全）。 */
export function controlGenerationRecord(tabId) {
  const id = tabIdOf(tabId);
  if (id == null) return null;
  return { ...chain.record(id), generation: controlGeneration(id) };
}

/** 四项计数递增（control.js 迁移 controller 状态时按 bump 声明调用）。 */
export function bumpRevisions(tabId, delta) {
  const id = tabIdOf(tabId);
  if (id == null) return null;
  const record = chain.bump(id, delta);
  if (record && delta && delta.generation) mergeCache(id, record.generation);
  scheduleFlush();
  return record;
}

/**
 * 观察内容脚本的 DOM revision：同文档取 max（不倒退），文档变化时按文档重置并推进
 * frameEpoch（navigation 后 revision 从 0 重来不是回退）。返回观察证据。
 */
export function observeControlRevisions(tabId, observation = {}) {
  const id = tabIdOf(tabId);
  if (id == null) return null;
  const result = chain.observe(id, observation);
  scheduleFlush();
  return result;
}

export function clearControlGeneration(tabId) {
  const id = tabIdOf(tabId);
  if (id == null) return;
  generations.delete(id);
  chain.clear(id);
  scheduleFlush();
}

export function controlGenerationCounters() {
  return { ...stats, cachedTabs: generations.size, chain: chain.counters() };
}
