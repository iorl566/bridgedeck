// src/audit.js —— 任务审计（扩展侧）：记录 daemon 下发的每次命令，默认关闭
const KEY = 'bb.audit.events';
const MAX_EVENTS = 500;

export async function recordAudit(entry) {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const list = Array.isArray(stored && stored[KEY]) ? stored[KEY] : [];
    list.unshift(entry);
    if (list.length > MAX_EVENTS) list.length = MAX_EVENTS;
    await chrome.storage.local.set({ [KEY]: list });
  } catch {
    // 存储失败不影响命令执行
  }
}

export async function listAudit(params = {}) {
  const stored = await chrome.storage.local.get(KEY);
  const all = Array.isArray(stored && stored[KEY]) ? stored[KEY] : [];
  const since = Number(params.since) || 0;
  const limit = Math.max(1, Math.min(500, Number(params.limit) || 100));
  const entries = all.filter((item) => !since || Number(item.ts) >= since).slice(0, limit);
  return { entries, total: all.length };
}

export async function clearAudit() {
  await chrome.storage.local.set({ [KEY]: [] });
  return { ok: true };
}
