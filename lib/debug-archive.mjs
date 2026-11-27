// lib/debug-archive.mjs —— 调试归档模型：标准化、保留期、离线查询。
import { filterDebugRequests } from './debug-analysis.mjs';

export const ARCHIVE_VERSION = 1;
export const DEFAULT_ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_ARCHIVE_BUDGET = { maxRequests: 200, maxConsole: 200, maxBytes: 512 * 1024 };

function byteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return 0; }
}

function keepWithinBudget(items, maxCount, maxBytes, usedBytes) {
  const kept = [];
  let bytes = 0;
  let limitedByBytes = false;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (kept.length >= maxCount) break;
    const size = byteLength(items[i]);
    if (usedBytes + bytes + size > maxBytes) {
      limitedByBytes = true;
      break;
    }
    kept.push(items[i]);
    bytes += size;
  }
  kept.reverse();
  return { kept, bytes, dropped: items.length - kept.length, limitedByBytes };
}

/** 按条数/字节预算裁剪归档，并明确记录 coverage 与 gaps。 */
export function applyArchiveBudget(archive, options = {}) {
  const budget = {
    maxRequests: Number(options.maxRequests) > 0 ? Number(options.maxRequests) : DEFAULT_ARCHIVE_BUDGET.maxRequests,
    maxConsole: Number(options.maxConsole) > 0 ? Number(options.maxConsole) : DEFAULT_ARCHIVE_BUDGET.maxConsole,
    maxBytes: Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_ARCHIVE_BUDGET.maxBytes,
  };
  const requests = Array.isArray(archive.requests) ? archive.requests : [];
  const consoleEntries = Array.isArray(archive.console) ? archive.console : [];
  const contextBytes = byteLength({ page: archive.page, performance: archive.performance, session: archive.session });
  const requestPart = keepWithinBudget(requests, budget.maxRequests, budget.maxBytes, contextBytes);
  const usedAfterRequests = contextBytes + requestPart.bytes;
  const consolePart = keepWithinBudget(consoleEntries, budget.maxConsole, budget.maxBytes, usedAfterRequests);
  const bytes = contextBytes + requestPart.bytes + consolePart.bytes;
  const dropped = { requests: requestPart.dropped, console: consolePart.dropped };
  const gaps = [];
  if (dropped.requests > 0) gaps.push({ kind: 'archive-budget', reason: 'max-requests', count: dropped.requests });
  if (dropped.console > 0) gaps.push({ kind: 'archive-budget', reason: 'max-console', count: dropped.console });
  if (requestPart.limitedByBytes || consolePart.limitedByBytes) gaps.push({ kind: 'archive-budget', reason: 'max-bytes', count: null });
  return {
    ...archive,
    requests: requestPart.kept,
    console: consolePart.kept,
    summary: {
      ...(archive.summary || {}),
      requests: requestPart.kept.length,
      console: consolePart.kept.length,
      bytes,
    },
    coverage: {
      budget,
      bytes,
      kept: { requests: requestPart.kept.length, console: consolePart.kept.length },
      dropped,
      complete: dropped.requests === 0 && dropped.console === 0 && bytes < budget.maxBytes,
    },
    gaps,
  };
}

function normalizeRequest(request) {
  return {
    id: request.id,
    method: String(request.method || ''),
    url: String(request.url || ''),
    status: request.status == null ? null : Number(request.status),
    type: String(request.type || ''),
    startedAt: request.startedAt == null ? null : Number(request.startedAt),
    durationMs: request.durationMs == null ? null : Number(request.durationMs),
    commandId: request.commandId || null,
    error: request.error || null,
  };
}

export function buildDebugArchive(snapshot, { id = '', session = '', now = Date.now(), ttlMs = DEFAULT_ARCHIVE_TTL_MS, budget = {} } = {}) {
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const requests = (Array.isArray(input.requests) ? input.requests : []).map(normalizeRequest);
  const consoleEntries = (Array.isArray(input.console) ? input.console : []).map((entry) => ({
    level: String((entry && entry.level) || 'log'),
    text: String((entry && entry.text) || ''),
    at: entry && entry.at != null ? Number(entry.at) : null,
  }));
  const archiveId = String(id || 'debug-' + now);
  const archive = {
    version: ARCHIVE_VERSION,
    id: archiveId,
    session: String(session || ''),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Number(ttlMs)).toISOString(),
    page: { url: String(context.url || ''), title: String(context.title || '') },
    requests,
    console: consoleEntries,
    journal: (Array.isArray(input.journal) ? input.journal : []).slice(-200),
    performance: input.performance || null,
    summary: {
      requests: requests.length,
      console: consoleEntries.length,
      journal: (Array.isArray(input.journal) ? input.journal : []).length,
      commands: new Set(requests.map((item) => item.commandId).filter(Boolean)).size,
    },
  };
  return applyArchiveBudget(archive, budget);
}

export function queryArchive(archive, filters = {}) {
  const source = archive && typeof archive === 'object' ? archive : {};
  return filterDebugRequests(source.requests || [], filters);
}

export function pruneArchives(archives, now = Date.now()) {
  return (Array.isArray(archives) ? archives : []).filter((archive) => {
    const expires = archive && archive.expiresAt ? Date.parse(archive.expiresAt) : Infinity;
    return !Number.isFinite(expires) || expires > now;
  });
}
