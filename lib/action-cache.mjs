// lib/action-cache.mjs —— 记住 observe --actions 的语义，供 ref 失效时自愈。
import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 300;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function prune(entries, now = Date.now()) {
  return entries
    .filter((item) => item && item.ref && Number(item.updatedAt) > now - TTL_MS)
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
    .slice(0, MAX_ENTRIES);
}

export function loadActionCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return prune(Array.isArray(parsed.entries) ? parsed.entries : []);
  } catch {
    return [];
  }
}

export function rememberActions(file, actions, url = '', now = Date.now()) {
  if (!Array.isArray(actions) || !actions.length) return 0;
  const existing = loadActionCache(file);
  const byRef = new Map(existing.map((item) => [item.ref, item]));
  for (const action of actions) {
    if (!action || !action.ref) continue;
    byRef.set(action.ref, {
      ref: action.ref,
      action: action.action,
      role: action.role || '',
      name: action.name || '',
      url: String(url || ''),
      updatedAt: now,
    });
  }
  const entries = prune([...byRef.values()], now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  return entries.length;
}

export function recallAction(file, ref, url = '') {
  if (!ref) return null;
  const entries = loadActionCache(file);
  const candidates = entries.filter((item) => item.ref === ref);
  if (!candidates.length) return null;
  if (url) {
    const sameUrl = candidates.find((item) => !item.url || item.url === url);
    if (sameUrl) return sameUrl;
  }
  return candidates[0];
}
