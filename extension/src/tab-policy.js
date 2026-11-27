// src/tab-policy.js —— 每个 tab 的只读/允许来源/keepOpen；本地持久化，重启按 URL 对账。
import { bridgeError } from './errors.js';
import { checkActionPolicy, originOf } from './lib/action-policy.js';
import { reconcilePolicyRecords } from './lib/tab-restore.js';

const KEY = 'bb.tabPolicies.v2';
let policies = null;
let loading = null;

async function ensureLoaded() {
  if (policies) return policies;
  if (!loading) {
    loading = (async () => {
      try {
        const stored = await chrome.storage.local.get(KEY);
        policies = new Map(Object.entries((stored && stored[KEY]) || {}).map(([key, value]) => [Number(key), value]));
      } catch {
        policies = new Map();
      }
      return policies;
    })();
  }
  return loading;
}

async function persist() {
  try {
    await chrome.storage.local.set({ [KEY]: Object.fromEntries(policies) });
  } catch { /* 存储不可用时保持内存策略 */ }
}

async function reconcile() {
  await ensureLoaded();
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { tabs = []; }
  const result = reconcilePolicyRecords(Object.fromEntries(policies), tabs);
  const next = new Map(Object.entries(result.policies).map(([id, policy]) => [Number(id), policy]));
  const changed = next.size !== policies.size
    || [...next].some(([id, policy]) => {
      const old = policies.get(id);
      return !old || old.url !== policy.url;
    });
  policies = next;
  if (changed) await persist();
  return result;
}

export async function setTabPolicy(tabId, { readOnly = false, allowedOrigins = [], keepOpen = false } = {}) {
  if (!Number.isInteger(tabId)) return;
  const list = Array.isArray(allowedOrigins) ? allowedOrigins.map(originOf).filter(Boolean) : [];
  await ensureLoaded();
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { tab = null; }
  policies.set(tabId, {
    readOnly: readOnly === true,
    allowedOrigins: list,
    keepOpen: keepOpen === true,
    url: tab && tab.url ? String(tab.url) : '',
    windowId: tab && Number.isInteger(tab.windowId) ? tab.windowId : null,
    updatedAt: Date.now(),
  });
  await persist();
}

export async function getTabPolicy(tabId) {
  await ensureLoaded();
  const direct = policies.get(tabId);
  if (direct) return direct;
  // 浏览器重启后 tabId 变了：按 URL 唯一对账，找不到就返回默认。
  const result = await reconcile();
  return result.policies[tabId] || { readOnly: false, allowedOrigins: [], keepOpen: false };
}

export async function checkTabPolicy(tabId, method, params = {}) {
  if (!Number.isInteger(tabId)) return;
  const policy = await getTabPolicy(tabId);
  const denied = checkActionPolicy(method, {
    readOnly: policy.readOnly,
    allowedOrigins: policy.allowedOrigins,
    url: params && params.url ? String(params.url) : '',
  });
  if (denied) throw bridgeError(denied.code, denied.message);
}

export function clearTabPolicy(tabId) {
  if (!Number.isInteger(tabId) || !policies) return;
  policies.delete(tabId);
  persist();
}

// 浏览器重启时 onRemoved 会移除全部 tab；这里不删策略，等 URL 对账。
