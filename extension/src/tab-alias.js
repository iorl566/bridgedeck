// src/tab-alias.js —— 给 tab 起稳定名字（work-mail），浏览器重启后按 URL 对账恢复。
import { reconcileAliasRecords } from './lib/tab-restore.js';

const KEY = 'bb.tabAliases.v2';
const ALIAS_RE = /^[a-z][a-z0-9_-]{0,39}$/;
let records = null;
let loading = null;

async function ensure() {
  if (records) return records;
  if (!loading) {
    loading = (async () => {
      try {
        const stored = await chrome.storage.local.get(KEY);
        records = new Map(Object.entries((stored && stored[KEY]) || {}));
      } catch {
        records = new Map();
      }
      return records;
    })();
  }
  return loading;
}

async function persist() {
  try {
    await chrome.storage.local.set({ [KEY]: Object.fromEntries(records) });
  } catch { /* 存储不可用时保持内存 */ }
}

async function reconcile() {
  await ensure();
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { tabs = []; }
  const result = reconcileAliasRecords(Object.fromEntries(records), tabs);
  const next = new Map(Object.entries(result.aliases));
  const changed = next.size !== records.size
    || [...next].some(([alias, record]) => {
      const old = records.get(alias);
      return !old || old.tabId !== record.tabId;
    });
  records = next;
  if (changed) await persist();
  return result;
}

export function normalizeAlias(value) {
  const alias = String(value || '').trim().toLowerCase();
  return ALIAS_RE.test(alias) ? alias : '';
}

export async function setTabAlias(tabId, value) {
  const alias = normalizeAlias(value);
  if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, code: 'E_BAD_ARG', message: 'tabId 需要正整数' };
  if (!alias) return { ok: false, code: 'E_BAD_ARG', message: 'alias 需要小写字母开头，可含数字/_/-（≤40）' };
  await ensure();
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { tab = null; }
  for (const [name, record] of [...records]) if (record.tabId === tabId) records.delete(name);
  records.set(alias, {
    tabId,
    url: tab && tab.url ? String(tab.url) : '',
    windowId: tab && Number.isInteger(tab.windowId) ? tab.windowId : null,
    updatedAt: Date.now(),
  });
  await persist();
  return { ok: true, alias, tabId };
}

export async function resolveTabAlias(value) {
  const alias = normalizeAlias(value);
  if (!alias) return null;
  await ensure();
  const record = records.get(alias);
  if (record && Number.isInteger(record.tabId)) {
    try {
      await chrome.tabs.get(record.tabId);
      return record.tabId;
    } catch { /* 浏览器重启后 id 变化，走 URL 对账 */ }
  }
  const result = await reconcile();
  return result.aliases[alias] ? result.aliases[alias].tabId : null;
}

export async function clearTabAlias(value) {
  const alias = normalizeAlias(value);
  await ensure();
  const existed = records.delete(alias);
  await persist();
  return existed;
}

export async function listTabAliases() {
  const result = await reconcile();
  return Object.fromEntries(Object.entries(result.aliases).map(([alias, record]) => [alias, record.tabId]));
}

// 浏览器重启时 onRemoved 会把所有 tab 都移除；这里故意不删 alias，等 URL 对账。
