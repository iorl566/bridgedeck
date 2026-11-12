// lib/debug-analysis.mjs —— 调试采集的分析与查询（不依赖浏览器）。
//
// 对应参考实现的 analysis/query 能力：请求分类、状态分布、慢请求、
// 错误、重复 URL、按 commandId 分组，以及离线过滤。

export function requestKind(request) {
  const url = String((request && request.url) || '');
  if (/^(chrome|edge|moz)-extension:/i.test(url) || /^(chrome|edge|moz)-extension:\/\//i.test(String(request && request.initiator || ''))) return 'extension';
  const type = String((request && request.type) || '');
  const method = String((request && request.method) || '').toUpperCase();
  if (['Fetch', 'XHR', 'Document'].includes(type) || !['GET', 'HEAD'].includes(method)) return 'business';
  return 'resource';
}

export function filterDebugRequests(requests, { url = '', method = '', status = null, minDuration = null, kind = '', limit = 100 } = {}) {
  const needle = String(url || '');
  const upper = String(method || '').toUpperCase();
  const kindFilter = String(kind || '');
  const max = Math.max(1, Number(limit) || 100);
  return (Array.isArray(requests) ? requests : []).filter((request) => {
    if (needle && !String(request.url || '').includes(needle)) return false;
    if (upper && String(request.method || '').toUpperCase() !== upper) return false;
    if (status != null && Number(request.status) !== Number(status)) return false;
    if (minDuration != null && Number(request.durationMs || 0) < Number(minDuration)) return false;
    if (kindFilter && requestKind(request) !== kindFilter) return false;
    return true;
  }).slice(0, max);
}

export function analyzeDebugCapture(snapshot, { slowMs = 500, top = 10 } = {}) {
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const requests = Array.isArray(input.requests) ? input.requests : [];
  const consoleEntries = Array.isArray(input.console) ? input.console : [];
  const status = {};
  const methods = {};
  const kinds = { business: 0, resource: 0, extension: 0 };
  const byUrl = new Map();
  const slow = [];
  const errors = [];
  for (const request of requests) {
    const code = request.status == null ? 'pending' : String(request.status);
    status[code] = (status[code] || 0) + 1;
    const method = String(request.method || 'UNKNOWN').toUpperCase();
    methods[method] = (methods[method] || 0) + 1;
    kinds[requestKind(request)] += 1;
    const key = String(request.url || '');
    byUrl.set(key, (byUrl.get(key) || 0) + 1);
    if (Number(request.durationMs || 0) >= Number(slowMs)) slow.push(request);
    if (request.status === 0 || request.error) errors.push(request);
  }
  const consoleLevel = {};
  for (const entry of consoleEntries) {
    const level = String((entry && entry.level) || 'log');
    consoleLevel[level] = (consoleLevel[level] || 0) + 1;
  }
  const duplicates = [...byUrl.entries()].filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([url, count]) => ({ url, count }));
  const groups = [];
  const byCommand = new Map();
  for (const request of requests) {
    const key = request.commandId ? String(request.commandId) : '(unattributed)';
    if (!byCommand.has(key)) byCommand.set(key, []);
    byCommand.get(key).push(request);
  }
  for (const [commandId, list] of byCommand) {
    groups.push({ commandId, count: list.length, urls: list.slice(0, top).map((item) => item.url) });
  }
  groups.sort((a, b) => b.count - a.count);
  return {
    version: 1,
    counts: { requests: requests.length, console: consoleEntries.length },
    status,
    methods,
    kinds,
    consoleLevel,
    slow: slow.slice(0, top),
    errors: errors.slice(0, top),
    duplicates,
    groups: groups.slice(0, top),
  };
}
