// lib/debug-journal.mjs —— 调试时间线：把请求、控制台、操作合并成一条 journal。
export function buildDebugJournal(snapshot, { operations = [], limit = 200 } = {}) {
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const events = [];
  for (const request of Array.isArray(input.requests) ? input.requests : []) {
    events.push({
      at: Number(request.startedAt) || 0,
      type: 'request',
      id: String(request.id == null ? '' : request.id),
      method: String(request.method || ''),
      url: String(request.url || ''),
      status: request.status == null ? null : Number(request.status),
      durationMs: request.durationMs == null ? null : Number(request.durationMs),
      commandId: request.commandId || null,
    });
  }
  for (const entry of Array.isArray(input.console) ? input.console : []) {
    events.push({
      at: Number(entry && entry.at) || 0,
      type: 'console',
      level: String((entry && entry.level) || 'log'),
      text: String((entry && entry.text) || ''),
    });
  }
  for (const operation of Array.isArray(operations) ? operations : []) {
    events.push({
      at: Number(operation && operation.ts) || 0,
      type: 'operation',
      id: String((operation && operation.id) || ''),
      method: String((operation && operation.method) || ''),
      ok: !(operation && operation.ok === false),
      durationMs: operation && operation.durationMs != null ? Number(operation.durationMs) : null,
      commandId: (operation && operation.commandId) || null,
    });
  }
  events.sort((a, b) => a.at - b.at);
  const max = Math.max(1, Number(limit) || 200);
  const trimmed = events.length > max ? events.slice(events.length - max) : events;
  return {
    version: 1,
    counts: {
      total: events.length,
      request: events.filter((event) => event.type === 'request').length,
      console: events.filter((event) => event.type === 'console').length,
      operation: events.filter((event) => event.type === 'operation').length,
    },
    truncated: events.length > trimmed.length,
    events: trimmed,
  };
}

export function formatJournalEvent(event) {
  const time = event.at ? new Date(event.at).toISOString() : '-';
  if (event.type === 'request') return `${time} request ${event.method} ${event.url} ${event.status == null ? '' : event.status}`.trim();
  if (event.type === 'console') return `${time} console[${event.level}] ${event.text}`;
  return `${time} operation ${event.method} ${event.ok ? 'ok' : 'fail'}${event.commandId ? ' ' + event.commandId : ''}`;
}
