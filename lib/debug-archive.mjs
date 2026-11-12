// lib/debug-archive.mjs —— 调试归档模型：标准化、保留期、离线查询。
import { filterDebugRequests } from './debug-analysis.mjs';

export const ARCHIVE_VERSION = 1;
export const DEFAULT_ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

export function buildDebugArchive(snapshot, { id = '', session = '', now = Date.now(), ttlMs = DEFAULT_ARCHIVE_TTL_MS } = {}) {
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const requests = (Array.isArray(input.requests) ? input.requests : []).map(normalizeRequest);
  const consoleEntries = (Array.isArray(input.console) ? input.console : []).map((entry) => ({
    level: String((entry && entry.level) || 'log'),
    text: String((entry && entry.text) || ''),
    at: entry && entry.at != null ? Number(entry.at) : null,
  }));
  const archiveId = String(id || 'debug-' + now);
  return {
    version: ARCHIVE_VERSION,
    id: archiveId,
    session: String(session || ''),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Number(ttlMs)).toISOString(),
    page: { url: String(context.url || ''), title: String(context.title || '') },
    requests,
    console: consoleEntries,
    performance: input.performance || null,
    summary: {
      requests: requests.length,
      console: consoleEntries.length,
      commands: new Set(requests.map((item) => item.commandId).filter(Boolean)).size,
    },
  };
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
