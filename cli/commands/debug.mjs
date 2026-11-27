// cli/commands/debug.mjs —— `bridge debug *`（采集/证据/归档/规则/重放/诊断大分派）。
//
// debug 相关重模块按需加载；CLI 共享 helper（RPC/输出/过滤/JSON pointer）由 bridge 注入。
import fs from 'node:fs';
import path from 'node:path';
import { ArgError, intFlag, requirePos } from '../lib/args.mjs';
import { isDryRun } from '../lib/action-plan.mjs';
import { dryRunIo, preflight } from '../lib/command-plans.mjs';
import { formatBytes } from '../lib/format.mjs';
import {
  formatDebugAnalyzeLines,
  formatDebugArchiveLines,
  formatDebugArchivesLines,
  formatDebugCoverageLines,
  formatDebugEvidenceLines,
  formatDebugHistoryLines,
  formatDebugJournalLines,
  formatDebugPerformanceLines,
  formatDebugRequestsLines,
  formatDebugStatusLines,
  formatDebugStopLines,
  summarizeDebugAnalyze,
  summarizeDebugArchive,
  summarizeDebugArchives,
  summarizeDebugCoverage,
  summarizeDebugEvidence,
  summarizeDebugHistory,
  summarizeDebugJournalResult,
  summarizeDebugRequests,
  summarizeDebugStatus,
  summarizeDebugStop,
  summarizePerformanceInsights,
} from '../lib/diagnostic-summary.mjs';

let debugModules = null;
async function loadDebug() {
  if (!debugModules) {
    debugModules = Promise.all([
      import('../../lib/debug-evidence.mjs'),
      import('../../lib/debug-analysis.mjs'),
      import('../../lib/debug-archive.mjs'),
      import('../../lib/debug-journal.mjs'),
      import('../../lib/debug-archive-index.mjs'),
      import('../../lib/debug-archive-store.mjs'),
      import('../../lib/har.mjs'),
      import('../../lib/har-import.mjs'),
      import('../../lib/perf-insights.mjs'),
    ]).then(([a, b, c, d, e, f, g, h, i]) => ({ ...a, ...b, ...c, ...d, ...e, ...f, ...g, ...h, ...i }));
  }
  return debugModules;
}

export function createDebugCommand({
  withControl,
  callRpc,
  timeoutOf,
  renderPageBody,
  emitJson,
  outputFailure,
  outputJsonBody,
  isJson,
  print,
  parseSince,
  writeFileAtomic,
  pathOfUrl,
  pickJsonPointer,
  filterDebugEntries,
  HOME_DIR,
}) {
  return async function cmdDebug(flags, pos) {
  const { archiveSummary, createArchiveIndex, buildDebugArchive, updateArchiveIndex, queryArchive, filterDebugRequests, buildDebugEvidence, analyzeDebugCapture, analyzePerformance, buildDebugJournal, formatJournalEvent, buildHar, importHar } = await loadDebug();
  const sub = pos[1];
  const session = withControl(flags, {});
  // --dry-run：只打印将要发出的 RPC 序列与本机读写路径；调试重模块已加载但不触达 daemon。
  if (isDryRun(flags)) {
    return preflight('debug', sub, { flags, pos, session }, dryRunIo({ isJson, emitJson, print }));
  }

  if (sub === 'start') {
    const params = { ...session };
    if (flags.name !== undefined) params.name = String(flags.name);
    if (flags.bodies === true) params.bodies = true;
    const body = await callRpc('debug.start', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print('调试采集已开始' + (params.name ? '：' + params.name : '') + (params.bodies ? '（含正文）' : '（只采集元数据）'));
    return 0;
  }

  if (sub === 'stop') {
    const body = await callRpc('debug.stop', session, Math.max(timeoutOf(flags), 30000));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    const summary = summarizeDebugStop(result);
    if (isJson()) {
      emitJson({ ...body, result: { ...result, summary } });
      return 0;
    }
    print('已停止：' + result.requests + ' 请求 / ' + result.console + ' 条控制台输出');
    for (const line of formatDebugStopLines(result)) print(line);
    return 0;
  }

  if (sub === 'status') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) {
      const history = await callRpc('debug.history', session, timeoutOf(flags));
      const list = (history.ok && history.result && history.result.history) || [];
      const summary = summarizeDebugHistory(list);
      if (isJson()) {
        emitJson({ ok: true, result: { active: false, history: list.slice(0, 5), summary } });
        return 0;
      }
      print('当前没有进行中的调试采集');
      if (list.length) print('最近记录：' + list.slice(0, 5).map((item) => item.id.slice(0, 8) + (item.name ? '(' + item.name + ')' : '')).join(', '));
      for (const line of formatDebugHistoryLines(list)) print(line);
      return 0;
    }
    const result = body.result || {};
    const summary = summarizeDebugStatus(result);
    if (isJson()) {
      emitJson({ ...body, result: { ...result, summary } });
      return 0;
    }
    print('采集中：' + (result.requests || []).length + ' 请求 / ' + (result.console || []).length + ' 条控制台');
    print('url: ' + (result.url || ''));
    for (const line of formatDebugStatusLines(result)) print(line);
    return 0;
  }

  if (sub === 'requests') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    let entries = filterDebugEntries(result.requests || [], flags);
    const summary = summarizeDebugRequests(result.requests || [], entries, flags);
    if (isJson()) {
      emitJson({ ok: true, result: { entries, summary } });
      return 0;
    }
    if (!entries.length) {
      print('(没有匹配的请求)');
      for (const line of formatDebugRequestsLines(summary)) print(line);
      return 0;
    }
    print(renderTable(['id', 'method', 'status', 'ms', 'type', 'url'], entries.map((entry) => [
      String(entry.id),
      entry.method || '',
      entry.status || '',
      entry.durationMs != null ? String(entry.durationMs) : '',
      entry.type || '',
      truncateText(entry.url || '', 64),
    ])));
    for (const line of formatDebugRequestsLines(summary)) print(line);
    return 0;
  }

  if (sub === 'har-import') {
    const file = pos[2] || (flags.file !== undefined ? String(flags.file) : '');
    if (!file) throw new ArgError('debug har-import 需要 <har.json>');
    if (!flags.output) throw new ArgError('debug har-import 需要 --output <archive.json>');
    let har;
    try {
      har = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
    } catch (error) {
      throw new ArgError('HAR 不是合法 JSON：' + error.message);
    }
    const archive = importHar(har, { id: String(flags.name || ''), session: String(flags.session || '') });
    const target = path.resolve(process.cwd(), String(flags.output));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, JSON.stringify(archive, null, 2) + '\n', 0o600);
    if (isJson()) emitJson({ ok: true, result: { path: target, id: archive.id, requests: archive.summary.requests } });
    else print('已导入 HAR：' + target + '（' + archive.summary.requests + ' 请求）');
    return 0;
  }

  if (sub === 'ws') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    const sockets = result.websockets && Array.isArray(result.websockets.sockets) ? result.websockets.sockets : [];
    const total = Number(result.websockets && result.websockets.total) || sockets.length;
    if (flags.output) {
      const target = path.resolve(process.cwd(), String(flags.output));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, JSON.stringify({ total, sockets }, null, 2) + '\n', 0o600);
    }
    if (isJson()) {
      emitJson({ ok: true, result: { total, sockets } });
      return 0;
    }
    if (!total) {
      print('(没有 WebSocket 帧)');
      return 0;
    }
    print('WebSocket ' + total + ' 个：');
    for (const socket of sockets) {
      print('  #' + socket.id + ' ' + socket.url + (socket.closed ? ' [closed]' : '') + (socket.error ? ' error=' + socket.error : ''));
      for (const frame of socket.frames.slice(0, Number(flags.limit) || 20)) {
        print('    ' + frame.direction + ' ' + (frame.opcode == null ? '?' : frame.opcode) + ' ' + String(frame.payload || '').slice(0, 200));
      }
    }
    return 0;
  }

  if (sub === 'har') {
    if (!flags.output) throw new ArgError('debug har 需要 --output <file>');
    const snapshotBody = await callRpc('debug.current', session, timeoutOf(flags));
    if (!snapshotBody.ok) return outputFailure(snapshotBody);
    const snapshot = snapshotBody.result || {};
    const requests = (Array.isArray(snapshot.requests) ? snapshot.requests : []).slice(0, flags.limit !== undefined ? Math.max(1, Math.min(500, Number(flags.limit) || 100)) : 100);
    const details = [];
    for (const request of requests) {
      const detail = await callRpc('debug.request', { ...session, id: Number(request.id) }, timeoutOf(flags));
      if (detail.ok && detail.result) details.push(detail.result);
    }
    const har = buildHar(details, {
      pageUrl: String((snapshot.context && snapshot.context.url) || ''),
      pageTitle: String((snapshot.context && snapshot.context.title) || ''),
    });
    const target = path.resolve(process.cwd(), String(flags.output));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, JSON.stringify(har, null, 2) + '\n', 0o600);
    if (isJson()) {
      emitJson({ ok: true, result: { path: target, entries: har.log.entries.length, bytes: Buffer.byteLength(JSON.stringify(har)) } });
      return 0;
    }
    print('已导出 HAR：' + target + '（' + har.log.entries.length + ' 条）');
    return 0;
  }

  if (sub === 'request') {
    const id = requirePos(pos, 2, '<id>');
    const body = await callRpc('debug.request', { ...session, id: Number(id) }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const maxChars = flags['max-chars'] !== undefined ? Math.max(1, Math.min(16384, Number(flags['max-chars']) || 4096)) : 4096;
    const offset = flags.offset !== undefined ? Math.max(0, Math.min(65536, Number(flags.offset) || 0)) : 0;
    const sliceBody = (text) => String(text == null ? '' : text).slice(offset, offset + maxChars);
    if (isJson()) {
      if (flags.pointer !== undefined || flags['max-chars'] !== undefined || offset > 0) {
        const result = { ...(body.result || {}) };
        for (const key of ['responseBody', 'requestBody']) {
          if (result[key] === undefined) continue;
          let value = result[key];
          if (flags.pointer !== undefined) {
            try { value = pickJsonPointer(JSON.parse(String(value)), String(flags.pointer)); } catch { value = { pointerError: '正文不是合法 JSON 或 pointer 无效' }; }
            result[key] = value;
          } else {
            result[key] = sliceBody(value);
          }
        }
        return outputJsonBody({ ...body, result });
      }
      return outputJsonBody(body);
    }
    const result = body.result || {};
    const part = flags.part === undefined ? 'all' : String(flags.part);
    if (part === 'metadata') {
      print(JSON.stringify(result.entry || {}, null, 2));
      return 0;
    }
    if (part === 'headers' || part === 'all') {
      print('请求头：' + JSON.stringify((result.requestHeaders || []).slice(0, 30)));
      print('响应头：' + JSON.stringify((result.responseHeaders || []).slice(0, 30)));
    }
    if (part === 'timing' || part === 'all') {
      print('timing：' + JSON.stringify(result.timing || {}));
    }
    if (part === 'response' || part === 'all') {
      if (result.responseBody !== undefined) {
        let text = sliceBody(result.responseBody);
        if (flags.pointer !== undefined) {
          try { text = JSON.stringify(pickJsonPointer(JSON.parse(String(result.responseBody)), String(flags.pointer)), null, 2); } catch { text = '(pointer 无法应用：正文不是合法 JSON)'; }
        }
        print('响应正文：' + text);
      }
      else print('(没有响应正文；debug start 需要 --bodies)');
    }
    if (part === 'request' || part === 'all') {
      if (result.requestBody !== undefined) print('请求正文：' + sliceBody(result.requestBody));
      else print('(没有请求正文)');
    }
    print('');
    print(JSON.stringify(result.entry || {}, null, 2));
    return 0;
  }

  if (sub === 'console') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const entries = ((body.result && body.result.console) || []).slice(-100);
    if (isJson()) {
      emitJson({ ok: true, result: { entries } });
      return 0;
    }
    if (!entries.length) {
      print('(没有控制台输出)');
      return 0;
    }
    print(entries.map((entry) => '[' + (entry.level || 'log') + '] ' + truncateText(String(entry.text || ''), 300)).join('\n'));
    return 0;
  }

  if (sub === 'pages') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const context = (body.result && body.result.context) || null;
    if (isJson()) return outputJsonBody({ ok: true, result: { context } });
    print(JSON.stringify(context, null, 2));
    return 0;
  }

  if (sub === 'performance') {
    const body = await callRpc('debug.performance', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const metrics = (body.result && body.result.metrics) || {};
    let insights = null;
    if (flags.insight === true) {
      insights = analyzePerformance(metrics);
      body.result.insights = insights;
    }
    const summary = insights ? summarizePerformanceInsights(insights) : null;
    if (isJson()) {
      emitJson(summary ? { ...body, result: { ...body.result, summary } } : body);
      return 0;
    }
    print('TTFB: ' + (metrics.ttfb != null ? metrics.ttfb + 'ms' : '—'));
    print('DOMContentLoaded: ' + (metrics.domContentLoaded != null ? metrics.domContentLoaded + 'ms' : '—'));
    print('load: ' + (metrics.load != null ? metrics.load + 'ms' : '—'));
    print('FCP: ' + ((metrics.paints || []).find((item) => item.name === 'first-contentful-paint') || {}).startTime ?? '—');
    print('LCP: ' + (metrics.lcp != null ? metrics.lcp + 'ms' : '—'));
    print('资源: ' + ((metrics.resources && metrics.resources.count) || 0) + ' 个 / ' + ((metrics.resources && metrics.resources.transferBytes) || 0) + ' 字节');
    print('CLS: ' + (metrics.cls != null ? metrics.cls : '—'));
    print('长任务: ' + ((metrics.longTasks && metrics.longTasks.count) || 0) + ' 个，最长 ' + ((metrics.longTasks && metrics.longTasks.maxMs) || 0) + 'ms');
    if (insights) {
      print('');
      for (const item of insights) print('  [' + item.level + '] ' + item.code + ': ' + item.message);
      for (const line of formatDebugPerformanceLines(insights)) print(line);
    }
    return 0;
  }

  if (sub === 'aggregate') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    let entries = (body.result && body.result.requests) || [];
    if (flags.filter !== undefined) entries = entries.filter((item) => String(item.url || '').includes(String(flags.filter)));
    const slowMs = intFlag(flags, 'slow-ms', { min: 1 }) ?? 1000;
    const groups = new Map();
    for (const entry of entries) {
      const key = String(entry.method || 'GET') + ' ' + pathOfUrl(entry.url);
      let group = groups.get(key);
      if (!group) {
        group = { key, count: 0, total: 0, max: 0, slow: 0, statuses: {} };
        groups.set(key, group);
      }
      group.count += 1;
      const ms = Number(entry.durationMs) || 0;
      group.total += ms;
      group.max = Math.max(group.max, ms);
      if (ms >= slowMs) group.slow += 1;
      const status = entry.status != null ? String(entry.status) : '—';
      group.statuses[status] = (group.statuses[status] || 0) + 1;
    }
    const rows = [...groups.values()].sort((a, b) => b.max - a.max);
    if (isJson()) {
      emitJson({ ok: true, result: { slowMs, groups: rows } });
      return 0;
    }
    if (!rows.length) {
      print('(没有请求可聚合)');
      return 0;
    }
    print(renderTable(['count', 'avg', 'max', 'slow', 'status', 'method+path'], rows.map((group) => [
      String(group.count),
      Math.round(group.total / group.count) + 'ms',
      group.max + 'ms',
      String(group.slow),
      JSON.stringify(group.statuses),
      truncateText(group.key, 60),
    ])));
    return 0;
  }

  if (sub === 'operations') {
    const params = {};
    if (flags.limit !== undefined) params.limit = intFlag(flags, 'limit', { min: 1 }) ?? 20;
    if (flags.since !== undefined) params.since = parseSince(flags.since);
    const body = await callRpc('operations.list', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const entries = (body.result && body.result.entries) || [];

    // 若当前有调试采集，把落在命令时间窗内的请求数标出来
    const capture = await callRpc('debug.current', session, timeoutOf(flags)).catch(() => null);
    const requests = capture && capture.ok && capture.result && Array.isArray(capture.result.requests)
      ? capture.result.requests
      : [];
    for (const row of entries) {
      const from = row.ts - (Number(row.durationMs) || 0) - 50;
      row.requests = requests.filter((item) => {
        if (row.commandId && item.commandId) return String(item.commandId) === String(row.commandId);
        return Number(item.startedAt) >= from && Number(item.startedAt) <= row.ts + 50;
      }).length;
    }

    if (isJson()) return outputJsonBody(body);
    if (!entries.length) {
      print('(没有操作记录)');
      return 0;
    }
    print(renderTable(['id', 'time', 'method', 'ok', 'ms', 'req', 'session'], entries.map((row) => [
      row.id || '',
      formatTime(row.ts),
      row.method || '',
      row.ok ? 'ok' : (row.code || 'fail'),
      row.durationMs != null ? String(row.durationMs) : '',
      String(row.requests || 0),
      (row.sessionId || '').slice(0, 12),
    ])));
    if (!requests.length) print('\n(当前没有调试采集，req 列恒为 0；先 bridge debug start)');
    return 0;
  }

  if (sub === 'operation') {
    const id = requirePos(pos, 2, '<operationId>');
    const body = await callRpc('operations.get', { id: String(id) }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const entry = (body.result && body.result.entry) || {};
    let matched = [];
    if (flags['with-requests'] === true) {
      const capture = await callRpc('debug.current', session, timeoutOf(flags)).catch(() => null);
      const requests = capture && capture.ok && capture.result && Array.isArray(capture.result.requests)
        ? capture.result.requests
        : [];
      const from = Number(entry.ts) - (Number(entry.durationMs) || 0) - 50;
      matched = requests.filter((item) => Number(item.startedAt) >= from && Number(item.startedAt) <= Number(entry.ts) + 50);
      body.result.requests = matched;
    }
    if (isJson()) return outputJsonBody(body);
    print(JSON.stringify(entry, null, 2));
    if (flags['with-requests'] === true) {
      print('');
      if (!matched.length) print('(时间窗内没有请求)');
      else print(renderTable(['id', 'method', 'status', 'ms', 'url'], matched.map((item) => [
        String(item.id),
        item.method || '',
        item.status || '',
        item.durationMs != null ? String(item.durationMs) : '',
        truncateText(item.url || '', 60),
      ])));
    }
    return 0;
  }

  if (sub === 'coverage') {
    const body = await callRpc('debug.coverage', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    const summary = summarizeDebugCoverage(result);
    if (isJson()) {
      emitJson({ ...body, result: { ...result, summary } });
      return 0;
    }
    print('覆盖：requests=' + (result.requests && result.requests.total) + ' console=' + (result.console && result.console.total) + ' pinned=' + result.pinned + ' complete=' + result.complete);
    for (const gap of result.gaps || []) print('  gap: ' + gap.kind + (gap.reason ? ' (' + gap.reason + ')' : '') + (gap.count != null ? ' count=' + gap.count : ''));
    for (const line of formatDebugCoverageLines(result)) print(line);
    return 0;
  }

  if (sub === 'duplicates') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    let entries = (body.result && body.result.requests) || [];
    if (flags.filter !== undefined) entries = entries.filter((item) => String(item.url || '').includes(String(flags.filter)));
    const windowMs = intFlag(flags, 'window-ms', { min: 1 }) ?? 1000;
    const byKey = new Map();
    for (const entry of entries) {
      const key = String(entry.method || 'GET') + ' ' + pathOfUrl(entry.url);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(entry);
    }
    const groups = [];
    for (const [key, list] of byKey) {
      list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      let cluster = [];
      for (const entry of list) {
        const previous = cluster[cluster.length - 1];
        if (previous && (entry.startedAt || 0) - (previous.startedAt || 0) > windowMs) {
          if (cluster.length >= 2) groups.push({ key, count: cluster.length, firstAt: cluster[0].startedAt, spanMs: cluster[cluster.length - 1].startedAt - cluster[0].startedAt });
          cluster = [];
        }
        cluster.push(entry);
      }
      if (cluster.length >= 2) groups.push({ key, count: cluster.length, firstAt: cluster[0].startedAt, spanMs: cluster[cluster.length - 1].startedAt - cluster[0].startedAt });
    }
    groups.sort((a, b) => b.count - a.count);
    if (isJson()) {
      emitJson({ ok: true, result: { windowMs, groups } });
      return 0;
    }
    if (!groups.length) {
      print('(窗口 ' + windowMs + 'ms 内没有重复请求)');
      return 0;
    }
    print(renderTable(['count', 'span', 'first', 'method+path'], groups.map((group) => [
      String(group.count),
      group.spanMs + 'ms',
      formatTime(group.firstAt),
      truncateText(group.key, 60),
    ])));
    return 0;
  }

  if (sub === 'fetch_probe') {
    const params = { ...session };
    if (flags.ms !== undefined) params.ms = intFlag(flags, 'ms', { min: 200 }) ?? 1500;
    const body = await callRpc('debug.fetch_probe', params, Math.max(timeoutOf(flags), (params.ms || 1500) + 8000));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const result = body.result || {};
    print('Fetch 拦截事件：' + (result.paused || 0) + ' 个（窗口 ' + (result.windowMs || 0) + 'ms）');
    for (const url of result.urls || []) print('  ' + url);
    if (result.error) print('错误：' + result.error);
    return 0;
  }

  if (sub === 'capabilities') {
    const body = await callRpc('debug.capabilities', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const result = body.result || {};
    print('debug 能力：' + (result.actions || []).join(', '));
    print('parts：' + (result.parts || []).join(', '));
    return 0;
  }

  if (sub === 'pin' || sub === 'unpin') {
    const id = pos[2];
    if (!id) throw new ArgError('debug ' + sub + ' 需要 id');
    const body = await callRpc('debug.pin', { ...session, id, pinned: sub === 'pin' }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print(sub === 'pin' ? '已钉住 ' + id : '已取消钉住 ' + id);
    return 0;
  }

  if (sub === 'pinned') {
    const body = await callRpc('debug.pinned', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print(((body.result && body.result.pinned) || []).join('\n') || '(没有钉住项)');
    return 0;
  }

  if (sub === 'activity') {
    const body = await callRpc('operations.list', { ...session, limit: flags.limit !== undefined ? Number(flags.limit) : 20 }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const ops = (body.result && body.result.operations) || [];
    if (!ops.length) {
      print('(没有调试/操作记录)');
      return 0;
    }
    print(renderTable(['id', 'method', 'status', 'ms'], ops.map((op) => [String(op.id || ''), String(op.method || ''), String(op.status || ''), String(op.durationMs == null ? '' : op.durationMs)])));
    return 0;
  }

  if (sub === 'rule_add') {
    let rule = null;
    if (flags['rule-file'] !== undefined) {
      const file = path.resolve(process.cwd(), String(flags['rule-file']));
      rule = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else if (flags.rule !== undefined) {
      rule = JSON.parse(String(flags.rule));
    } else {
      throw new ArgError('debug rule_add 需要 --rule <json> 或 --rule-file <path>');
    }
    const body = await callRpc('debug.rule_add', { ...session, rule }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const rules = (body.result && body.result.rules) || [];
    print('已添加规则，当前 ' + rules.length + ' 条：');
    for (const item of rules) print('  ' + item.action + ' ' + item.urlPattern + '（命中 ' + item.hits + '）');
    return 0;
  }

  if (sub === 'rule_enable' || sub === 'rule_disable' || sub === 'rule_remove') {
    const id = Number(pos[2]);
    if (!Number.isInteger(id)) throw new ArgError('debug ' + sub + ' 需要规则 id');
    const method = sub === 'rule_enable' ? 'debug.rule_enable' : sub === 'rule_disable' ? 'debug.rule_disable' : 'debug.rule_remove';
    const body = await callRpc(method, { ...session, id }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print(sub === 'rule_remove' ? '已删除规则 ' + id : (sub === 'rule_enable' ? '已启用规则 ' : '已停用规则 ') + id);
    return 0;
  }

  if (sub === 'rule_list') {
    const body = await callRpc('debug.rule_list', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const rules = (body.result && body.result.rules) || [];
    if (!rules.length) {
      print('(没有规则)');
      return 0;
    }
    print(renderTable(['action', 'status', 'hits', 'urlPattern'], rules.map((item) => [
      item.action,
      String(item.status),
      String(item.hits),
      truncateText(item.urlPattern, 60),
    ])));
    return 0;
  }

  if (sub === 'rule_clear') {
    const body = await callRpc('debug.rule_clear', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print('已清理 ' + ((body.result && body.result.cleared) || 0) + ' 条规则');
    return 0;
  }

  if (sub === 'rule_export') {
    if (!flags.output) throw new ArgError('debug rule_export 需要 --output <file>');
    const body = await callRpc('debug.rule_export', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const target = path.resolve(process.cwd(), String(flags.output));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, JSON.stringify(body.result || {}, null, 2) + '\n', 0o600);
    if (isJson()) {
      emitJson({ ok: true, result: { path: target, rules: (body.result && body.result.rules || []).length } });
      return 0;
    }
    print('已导出规则：' + target);
    return 0;
  }

  if (sub === 'rule_import') {
    const file = flags.file !== undefined ? String(flags.file) : (pos[2] || '');
    if (!file) throw new ArgError('debug rule_import 需要 --file <rules.json>');
    let snapshot;
    try { snapshot = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')); } catch (error) { throw new BridgeError('E_BAD_JSON', '读取规则文件失败：' + error.message); }
    const rules = Array.isArray(snapshot) ? snapshot : snapshot.rules;
    if (!Array.isArray(rules)) throw new ArgError('规则文件需要 rules 数组');
    const body = await callRpc('debug.rule_import', { ...session, rules }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print('已导入 ' + ((body.result && body.result.imported) || rules.length) + ' 条规则');
    return 0;
  }

  if (sub === 'export') {
    if (!flags.output) throw new ArgError('debug export 需要 --output <file>');
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const target = path.resolve(process.cwd(), String(flags.output));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(body.result, null, 2), 'utf8');
    if (isJson()) {
      emitJson({ ok: true, result: { path: target, bytes: fs.statSync(target).size } });
      return 0;
    }
    print('已导出调试数据：' + target);
    return 0;
  }

  if (sub === 'archives') {
    if (!flags.dir) throw new ArgError('debug archives 需要 --dir <目录>');
    const dir = path.resolve(process.cwd(), String(flags.dir));
    const index = createArchiveIndex();
    const fileById = new Map();
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'));
    } catch {
      throw new ArgError('目录不可读：' + dir);
    }
    for (const name of files) {
      try {
        const archive = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (archive && archive.id) {
          index.add(archive);
          fileById.set(String(archive.id), path.join(dir, name));
        }
      } catch {
        // 跳过非归档 JSON
      }
    }
    if (flags.prune === true) {
      const now = Date.now();
      for (const name of files) {
        try {
          const file = path.join(dir, name);
          const archive = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (archive && archive.expiresAt && Date.parse(archive.expiresAt) <= now) fs.rmSync(file, { force: true });
        } catch {
          // 跳过不可读/非归档文件
        }
      }
      index.prune(now);
    }
    const max = intFlag(flags, 'max', { min: 1 });
    if (max !== undefined) {
      const ordered = index.list().map(archiveSummary);
      for (const entry of ordered.slice(max)) {
        const file = fileById.get(entry.id);
        if (file) fs.rmSync(file, { force: true });
      }
    }
    const entries = index.list().map(archiveSummary);
    const summary = summarizeDebugArchives(entries, index.stats());
    if (isJson()) {
      emitJson({ ok: true, result: { dir, stats: index.stats(), entries, summary } });
      return 0;
    }
    if (!entries.length) {
      print('(没有有效归档)');
      for (const line of formatDebugArchivesLines(entries, index.stats())) print(line);
      return 0;
    }
    print(renderTable(['id', 'requests', 'console', 'bytes', 'complete', 'createdAt', 'url'], entries.map((entry) => [
      entry.id.slice(0, 20), String(entry.requests), String(entry.console), String(entry.bytes), entry.complete ? 'yes' : 'no', entry.createdAt.slice(0, 19), truncateText(entry.url, 40),
    ])));
    for (const line of formatDebugArchivesLines(entries, index.stats())) print(line);
    return 0;
  }

  if (sub === 'archive') {
    if (!flags.output) throw new ArgError('debug archive 需要 --output <file>');
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const budget = {};
    const maxRequests = intFlag(flags, 'max-requests', { min: 1 });
    const maxConsole = intFlag(flags, 'max-console', { min: 1 });
    const maxBytes = intFlag(flags, 'max-bytes', { min: 1 });
    if (maxRequests !== undefined) budget.maxRequests = maxRequests;
    if (maxConsole !== undefined) budget.maxConsole = maxConsole;
    if (maxBytes !== undefined) budget.maxBytes = maxBytes;
    const archive = buildDebugArchive(body.result, { id: String(flags.name || ''), session: String(flags.session || ''), budget });
    const summary = summarizeDebugArchive(archive);
    const target = path.resolve(process.cwd(), String(flags.output));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, JSON.stringify(archive, null, 2) + '\n', 0o600);
    updateArchiveIndex(path.dirname(target), archive);
    if (isJson()) {
      emitJson({
        ok: true,
        result: {
          path: target,
          id: archive.id,
          requests: archive.summary.requests,
          console: archive.summary.console,
          bytes: archive.summary.bytes,
          coverage: archive.coverage,
          gaps: archive.gaps,
          summary,
        },
      });
      return 0;
    }
    print('已归档调试数据：' + target + '（' + archive.summary.requests + ' 请求 / ' + formatBytes(archive.summary.bytes) + '）');
    if (archive.coverage && archive.coverage.complete !== true) {
      print('覆盖不完整：' + archive.gaps.map((gap) => gap.kind + ':' + gap.reason + (gap.count != null ? '×' + gap.count : '')).join('，'));
    }
    for (const line of formatDebugArchiveLines(archive)) print(line);
    return 0;
  }

  if (sub === 'query') {
    if (flags.dir) {
      const dir = path.resolve(process.cwd(), String(flags.dir));
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'));
      } catch {
        throw new ArgError('目录不可读：' + dir);
      }
      const all = [];
      for (const name of files) {
        try {
          const archive = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          if (!archive || !Array.isArray(archive.requests)) continue;
          for (const entry of queryArchive(archive, {
            url: String(flags.filter || flags.url || ''),
            method: String(flags.method || '').toUpperCase(),
            status: flags.status !== undefined ? Number(flags.status) : null,
            minDuration: flags['min-duration'] !== undefined ? Number(flags['min-duration']) : null,
            kind: String(flags.kind || ''),
            limit: intFlag(flags, 'limit', { min: 1 }) ?? 100,
          })) all.push({ archive: archive.id || name, ...entry });
        } catch {
          // 跳过非归档 JSON
        }
      }
      if (isJson()) {
        emitJson({ ok: true, result: { matched: all.length, entries: all } });
        return 0;
      }
      print('命中 ' + all.length + ' 条（目录 ' + dir + '）');
      for (const entry of all.slice(0, 50)) print(entry.archive + '  ' + entry.method + ' ' + entry.url + '  ' + (entry.status == null ? '' : entry.status));
      return 0;
    }
    const file = flags.file !== undefined ? String(flags.file) : (pos[2] || '');
    if (!file) throw new ArgError('debug query 需要 --file <debug-export.json>');
    const target = path.resolve(process.cwd(), file);
    let snapshot;
    try { snapshot = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) { throw new BridgeError('E_BAD_JSON', '读取调试归档失败：' + error.message); }
    const all = Array.isArray(snapshot.requests) ? snapshot.requests : [];
    const needle = String(flags.filter || flags.url || '');
    const method = String(flags.method || '').toUpperCase();
    const status = flags.status !== undefined ? Number(flags.status) : null;
    const minDuration = flags['min-duration'] !== undefined ? Number(flags['min-duration']) : null;
    const kind = String(flags.kind || '');
    const limit = intFlag(flags, 'limit', { min: 1 }) ?? 100;
    const entries = filterDebugRequests(all, { url: needle, method, status, minDuration, kind, limit });
    const result = { file: target, total: all.length, matched: entries.length, entries };
    if (isJson()) {
      emitJson({ ok: true, result });
      return 0;
    }
    if (!entries.length) {
      print('(归档里没有匹配的请求)');
      return 0;
    }
    print(renderTable(['id', 'method', 'status', 'ms', 'url'], entries.map((entry) => [
      String(entry.id || ''),
      String(entry.method || ''),
      String(entry.status == null ? '' : entry.status),
      String(entry.durationMs == null ? '' : entry.durationMs),
      truncateText(entry.url || '', 100),
    ])));
    return 0;
  }

  if (sub === 'evidence') {
    let snapshot;
    let operations = [];
    if (flags.file) {
      const target = path.resolve(process.cwd(), String(flags.file));
      try {
        snapshot = JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch (error) {
        throw new ArgError('无法读取证据文件：' + ((error && error.message) || error));
      }
    } else {
      const body = await callRpc('debug.current', session, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      snapshot = body.result;
      const opsBody = await callRpc('operations.list', { ...session, limit: 100 }, timeoutOf(flags)).catch(() => null);
      operations = opsBody && opsBody.ok && opsBody.result && Array.isArray(opsBody.result.entries) ? opsBody.result.entries : [];
    }
    const evidence = buildDebugEvidence(snapshot, { session: String(flags.session || ''), operations });
    if (flags.output) {
      const target = path.resolve(process.cwd(), String(flags.output));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, JSON.stringify(evidence, null, 2) + '\n', 0o600);
      evidence.path = target;
    }
    const summary = summarizeDebugEvidence(evidence);
    if (isJson()) {
      emitJson({ ok: true, result: { ...evidence, summary } });
      return 0;
    }
    print('证据包：' + evidence.counts.requests + ' 请求 / ' + evidence.counts.console + ' 控制台 / ' + evidence.page.url);
    print('requestsSha256 ' + evidence.integrity.requestsSha256.slice(0, 16) + '…');
    for (const line of formatDebugEvidenceLines(evidence)) print(line);
    return 0;
  }

  if (sub === 'analyze') {
    let snapshot;
    if (flags.file) {
      const target = path.resolve(process.cwd(), String(flags.file));
      try {
        snapshot = JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch (error) {
        throw new ArgError('无法读取分析文件：' + ((error && error.message) || error));
      }
    } else {
      const body = await callRpc('debug.current', session, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      snapshot = body.result;
    }
    const analysis = analyzeDebugCapture(snapshot, {
      slowMs: flags['min-duration'] !== undefined ? Number(flags['min-duration']) : 500,
    });
    const summary = summarizeDebugAnalyze(analysis);
    if (isJson()) {
      emitJson({ ok: true, result: { ...analysis, summary } });
      return 0;
    }
    print('请求 ' + analysis.counts.requests + ' / 控制台 ' + analysis.counts.console);
    print('状态：' + Object.entries(analysis.status).map(([key, value]) => key + '×' + value).join(' ') || '（无）');
    print('分类：business=' + analysis.kinds.business + ' resource=' + analysis.kinds.resource + ' extension=' + analysis.kinds.extension);
    if (analysis.slow.length) print('慢请求：' + analysis.slow.length);
    if (analysis.errors.length) print('错误：' + analysis.errors.length);
    if (analysis.duplicates.length) print('重复 URL：' + analysis.duplicates.length);
    for (const line of formatDebugAnalyzeLines(analysis)) print(line);
    return 0;
  }

  if (sub === 'journal') {
    const limit = intFlag(flags, 'limit', { min: 1 }) ?? 100;
    const merged = flags.merged === true;
    const snapshotBody = await callRpc('debug.current', session, timeoutOf(flags));
    if (!snapshotBody.ok) return outputFailure(snapshotBody);
    const opsBody = await callRpc('operations.list', { ...session, limit }, timeoutOf(flags));
    if (!opsBody.ok) return outputFailure(opsBody);
    const operations = (opsBody.result && opsBody.result.entries) || [];
    const journal = buildDebugJournal(snapshotBody.result, { operations, limit });
    const summary = summarizeDebugJournalResult(journal);
    if (isJson()) {
      if (!merged) {
        emitJson({ ok: true, result: { ...journal, entries: journal.events, summary } });
        return 0;
      }
      const startAt = journal.events.length ? Number(journal.events[0].at) || 0 : 0;
      const timeline = journal.events.map((event) => ({ ...event, elapsedMs: startAt ? Math.max(0, Number(event.at) - startAt) : 0 }));
      emitJson({ ok: true, result: { ...journal, merged: true, timeline, entries: timeline, summary } });
      return 0;
    }
    if (!journal.events.length) {
      print('(没有 journal 记录)');
      for (const line of formatDebugJournalLines(journal)) print(line);
      return 0;
    }
    if (merged) {
      const startAt = Number(journal.events[0].at) || 0;
      print(renderTable(['elapsed', 'type', 'event'], journal.events.map((event) => [
        '+' + Math.max(0, Number(event.at) - startAt) + 'ms',
        event.type,
        formatJournalEvent(event).replace(/^[^ ]+ /, ''),
      ])));
      print('合计 ' + journal.counts.total + ' 条（debug=' + journal.counts.debug + ' operation=' + journal.counts.operation + ' request=' + journal.counts.request + ' console=' + journal.counts.console + '）');
      for (const line of formatDebugJournalLines(journal)) print(line);
      return 0;
    }
    for (const event of journal.events) print(formatJournalEvent(event));
    if (journal.truncated) print('（已截断，共 ' + journal.counts.total + ' 条）');
    for (const line of formatDebugJournalLines(journal)) print(line);
    return 0;
  }

  if (sub === 'replay') {
    const id = requirePos(pos, 2, '<id>');
    const body = await callRpc('network.replay', { ...session, id: Number(id) }, Math.max(timeoutOf(flags), 120000));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const result = body.result || {};
    print('HTTP ' + result.status + '（' + (result.durationMs || 0) + 'ms）');
    print(truncateText(String(result.body || ''), 2000));
    return 0;
  }

  if (sub === 'history') {
    const body = await callRpc('debug.history', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const list = (body.result && body.result.history) || [];
    if (isJson()) return outputJsonBody(body);
    if (!list.length) {
      print('(没有调试历史)');
      return 0;
    }
    print(renderTable(['id', 'name', 'requests', 'console', 'started'], list.map((item) => [
      item.id.slice(0, 8),
      item.name || '',
      String(item.requests || 0),
      String(item.console || 0),
      formatTime(item.startedAt),
    ])));
    return 0;
  }

  throw new ArgError('用法：bridge debug start|stop|status|requests|request|console|pages|performance|aggregate|export|query|replay|history');
  };
}
