// lib/debug-evidence.mjs —— 调试证据包：把一次采集整理成可归档/可比对的 envelope。
import crypto from 'node:crypto';

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value === undefined ? null : value)).digest('hex');
}

export function buildDebugEvidence(snapshot, { session = '', generatedAt = Date.now(), operations = [] } = {}) {
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const requests = Array.isArray(input.requests) ? input.requests : [];
  const consoleEntries = Array.isArray(input.console) ? input.console : [];
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const performance = input.performance && typeof input.performance === 'object' ? input.performance : null;
  const ops = (Array.isArray(operations) ? operations : []).map((op) => {
    const commandId = op && op.commandId ? String(op.commandId) : null;
    const linked = commandId ? requests.filter((request) => request && String(request.commandId || '') === commandId) : [];
    return {
      id: op && op.id ? String(op.id) : '',
      method: op && op.method ? String(op.method) : '',
      commandId,
      startedAt: op && op.ts ? Number(op.ts) : null,
      durationMs: op && op.durationMs != null ? Number(op.durationMs) : null,
      ok: !(op && op.ok === false),
      requestIds: linked.map((request) => request.id),
    };
  });
  return {
    version: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    session: String(session || ''),
    page: {
      url: String(context.url || ''),
      title: String(context.title || ''),
    },
    counts: {
      requests: requests.length,
      console: consoleEntries.length,
      operations: ops.length,
    },
    operations: ops,
    requests,
    console: consoleEntries,
    performance,
    integrity: {
      requestsSha256: hash(requests),
      consoleSha256: hash(consoleEntries),
      performanceSha256: hash(performance),
      operationsSha256: hash(ops),
    },
  };
}
