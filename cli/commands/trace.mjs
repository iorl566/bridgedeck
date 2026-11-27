// cli/commands/trace.mjs —— trace 命令（从 bridge 拆出）。
import fs from 'node:fs';
import path from 'node:path';
import { isDryRun } from '../lib/action-plan.mjs';
import { dryRunIo, preflight } from '../lib/command-plans.mjs';
import {
  formatTraceDiffLines,
  formatTraceStatusLines,
  formatTraceStopLines,
  formatTraceSummaryLines,
  summarizeTraceDiff,
  summarizeTraceReport,
  summarizeTraceStatus,
  summarizeTraceStop,
} from '../lib/diagnostic-summary.mjs';

export async function traceCommand(ctx, flags, pos) {
  const { callRpc, withControl, timeoutOf, outputFailure, outputJsonBody, print, emitJson, isJson, loadTraceSummary, loadTraceViewer, writeFileAtomic, BridgeError, ArgError } = ctx;
  const sub = pos[1] || 'view';
  // --dry-run：summary/diff/view 是纯本地命令，预检只列出将读取/渲染的文件。
  if (isDryRun(flags)) {
    return preflight('trace', sub, { flags, pos, session: withControl(flags, {}) }, dryRunIo({ isJson, emitJson, print }));
  }
  if (sub === 'start') {
    const body = await callRpc('trace.start', withControl(flags, {}), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print('已开始 tracing（tab ' + (body.result && body.result.tabId) + '）');
    return 0;
  }
  if (sub === 'status') {
    const body = await callRpc('trace.status', withControl(flags, {}), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    const summary = summarizeTraceStatus(result);
    if (isJson()) {
      emitJson({ ...body, result: { ...result, summary } });
      return 0;
    }
    print('tracing: ' + (result.tracing ? 'on' : 'off') + '（events=' + (result.events || 0) + '）');
    for (const line of formatTraceStatusLines(result)) print(line);
    return 0;
  }
  if (sub === 'stop') {
    const body = await callRpc('trace.stop', withControl(flags, {}), Math.max(timeoutOf(flags), 30000));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    let tracePath = '';
    if (flags.out !== undefined && result.trace) {
      tracePath = path.resolve(process.cwd(), String(flags.out));
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      writeFileAtomic(tracePath, result.trace, 0o600);
    }
    // 扩展侧 trace.stop 已带 summary（events/spanMs/categories/topNames）；
    // 这里只**追加**结论字段，不替换原字段。
    const analysis = summarizeTraceStop(result);
    const enrichedSummary = { ...(result.summary || {}), findings: analysis.findings, verdict: analysis.verdict, nextSteps: analysis.nextSteps };
    if (isJson()) {
      const { trace, ...rest } = result;
      emitJson({ ok: true, result: { ...rest, summary: enrichedSummary, ...(tracePath ? { path: tracePath, bytes: Buffer.byteLength(result.trace || '') } : {}) } });
      return 0;
    }
    print('tracing 已停止：events=' + (result.events || 0) + '，时长 ' + (result.durationMs || 0) + 'ms');
    if (tracePath) print('已保存 trace：' + tracePath);
    for (const line of formatTraceStopLines(result)) print(line);
    return 0;
  }
  if (sub === 'diff') {
    const baseFile = pos[2] || '';
    const headFile = pos[3] || '';
    if (!baseFile || !headFile) throw new ArgError('trace diff 需要 <base.json> <head.json>');
    const loadTrace = async (file) => {
      try {
        return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
      } catch (error) {
        throw new BridgeError('E_BAD_ARG', 'trace 不是合法 JSON：' + file + '（' + error.message + '）');
      }
    };
    const { summarizeTrace, diffTraceSummary } = await loadTraceSummary();
    const baseTrace = await loadTrace(baseFile);
    const headTrace = await loadTrace(headFile);
    const diff = diffTraceSummary(summarizeTrace(baseTrace), summarizeTrace(headTrace), { top: flags.limit !== undefined ? Number(flags.limit) : 10 });
    const diagnostics = summarizeTraceDiff(diff);
    if (isJson()) {
      emitJson({ ok: true, result: { ...diff, diagnostics } });
      return 0;
    }
    print('events ' + diff.events.base + ' → ' + diff.events.head + '（' + (diff.events.delta >= 0 ? '+' : '') + diff.events.delta + '）');
    print('duration ' + diff.durationMs.base + 'ms → ' + diff.durationMs.head + 'ms');
    print('longTasks ' + diff.longTaskCount.base + ' → ' + diff.longTaskCount.head);
    for (const change of diff.topChanges) print('  ' + change.key + ' ' + change.base + ' → ' + change.head);
    if (diff.criticalPath) {
      print('关键路径 ' + diff.criticalPath.base + 'ms → ' + diff.criticalPath.head + 'ms（' + (diff.criticalPath.delta >= 0 ? '+' : '') + diff.criticalPath.delta + 'ms）');
      print('  路径 span ' + diff.criticalPath.baseSpans + ' → ' + diff.criticalPath.headSpans);
    }
    if (diff.spanCount) print('span ' + diff.spanCount.base + ' → ' + diff.spanCount.head);
    for (const line of formatTraceDiffLines(diff)) print(line);
    return 0;
  }
  if (sub === 'summary') {
    const file = pos[2] || (flags.file !== undefined ? String(flags.file) : '');
    if (!file) throw new ArgError('trace summary 需要 <trace.json>');
    let trace;
    try {
      trace = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
    } catch (error) {
      throw new BridgeError('E_BAD_ARG', 'trace 不是合法 JSON：' + error.message);
    }
    const { summarizeTrace } = await loadTraceSummary();
    const summary = summarizeTrace(trace, { top: flags.limit !== undefined ? Number(flags.limit) : 20 });
    const diagnostics = summarizeTraceReport(summary);
    if (isJson()) {
      emitJson({ ok: true, result: { ...summary, diagnostics } });
      return 0;
    }
    print('events=' + summary.events + ' duration=' + summary.durationMs + 'ms longTasks=' + summary.longTaskCount);
    for (const item of summary.topNames.slice(0, 10)) print('  ' + item.key + ' ×' + item.count);
    if (summary.spanSummary) {
      const spans = summary.spanSummary;
      print('span=' + spans.spans + ' roots=' + spans.roots + ' unfinished=' + spans.unfinished + ' truncated=' + spans.truncated + ' self=' + spans.selfTotalMs + 'ms');
      if (spans.criticalPath) print('关键路径=' + spans.criticalPath.totalMs + 'ms（' + spans.criticalPath.spanCount + ' spans，' + (spans.criticalPath.metric || 'self') + '）');
      for (const frame of (spans.frames || []).slice(0, 5)) print('  frame ' + frame.key + '：' + frame.count + ' spans / ' + frame.selfMs + 'ms');
      for (const span of (spans.topSpans || []).slice(0, 5)) print('  ' + span.name + ' ' + span.durMs + 'ms（self ' + span.selfMs + 'ms）');
    }
    for (const line of formatTraceSummaryLines(summary)) print(line);
    return 0;
  }
  // 查看器 loader 由 bridge 注入；若注入缺失（历史接线缺口）则回退到直接 import，
  // 避免 `bridge trace view` 因未传入 loader 而整体不可用。
  const loadViewer = typeof loadTraceViewer === 'function'
    ? loadTraceViewer
    : () => import('../../lib/trace-viewer.mjs');
  if (sub !== 'view') throw new ArgError('用法：bridge trace start|stop|status [--out trace.json] | bridge trace view <trace.json> [--out <viewer.html>]');
  const file = pos[2] || (flags.file !== undefined ? String(flags.file) : '');
  if (!file) throw new ArgError('trace view 需要 <trace.json>');
  const source = path.resolve(process.cwd(), file);
  let raw;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch {
    throw new BridgeError('E_NOT_FOUND', '读不到 trace 文件：' + source);
  }
  let trace;
  try {
    trace = JSON.parse(raw);
  } catch (error) {
    throw new BridgeError('E_BAD_ARG', 'trace 不是合法 JSON：' + error.message);
  }
  if (!trace || trace.version !== 3 || !Array.isArray(trace.steps)) {
    throw new BridgeError('E_BAD_ARG', '需要 Trace v3（version=3 且包含 steps）');
  }
  if (flags.debug !== undefined) {
    const debugPath = path.resolve(process.cwd(), String(flags.debug));
    let archive;
    try {
      archive = JSON.parse(fs.readFileSync(debugPath, 'utf8'));
    } catch (error) {
      throw new BridgeError('E_BAD_ARG', '读不到 debug 归档或不是 JSON：' + debugPath + '（' + error.message + '）');
    }
    const requests = Array.isArray(archive && archive.requests) ? archive.requests : [];
    if (!requests.length) throw new BridgeError('E_BAD_ARG', 'debug 归档里没有 requests 数组');
    trace.network = requests.map((request) => ({
      at: Number.isFinite(Number(request.startedAt)) ? new Date(Number(request.startedAt)).toISOString() : null,
      method: String(request.method || ''),
      url: String(request.url || ''),
      status: request.status == null ? null : Number(request.status),
      type: String(request.type || ''),
    }));
  }
  const output = path.resolve(process.cwd(), flags.out !== undefined ? String(flags.out) : source.replace(/\.json$/i, '') + '.html');
  // 查看器深度：分页大小 / HTML 字节上限可从 CLI 调（--limit 同时驱动 summary 的 top）。
  const limitFlag = flags.limit !== undefined && Number.isFinite(Number(flags.limit)) ? Math.max(1, Math.floor(Number(flags.limit))) : 0;
  const maxBytesFlag = flags['max-bytes'] !== undefined && Number.isFinite(Number(flags['max-bytes']))
    ? Math.max(1024, Math.floor(Number(flags['max-bytes'])))
    : 0;
  const maxCharsFlag = flags['max-chars'] !== undefined && Number.isFinite(Number(flags['max-chars']))
    ? Math.max(16, Math.floor(Number(flags['max-chars'])))
    : 0;
  const limits = {};
  if (limitFlag) limits.spanPageSize = limitFlag;
  if (maxCharsFlag) limits.stateBodyChars = maxCharsFlag;
  const viewerModule = await loadViewer();
  const viewerOptions = {
    ...(Object.keys(limits).length ? { limits } : {}),
    ...(maxBytesFlag ? { maxHtmlBytes: maxBytesFlag } : {}),
  };
  let html;
  let viewerStats = null;
  if (typeof viewerModule.renderTraceReport === 'function') {
    const report = viewerModule.renderTraceReport(trace, viewerOptions);
    html = report.html;
    viewerStats = report.stats;
  } else if (typeof viewerModule.renderTraceHtml === 'function') {
    // 兼容只导出旧入口的注入实现：仍能生成 HTML，只是没有预算统计。
    html = viewerModule.renderTraceHtml(trace, viewerOptions);
  } else {
    throw new BridgeError('E_INTERNAL', 'trace viewer 模块缺少渲染入口（renderTraceReport/renderTraceHtml）');
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeFileAtomic(output, html, 0o600);
  const result = {
    trace: source,
    out: output,
    bytes: Buffer.byteLength(html),
    steps: trace.steps.length,
    states: Array.isArray(trace.states) ? trace.states.length : 0,
    network: Array.isArray(trace.network) ? trace.network.length : 0,
    screenshots: Array.isArray(trace.screenshots) ? trace.screenshots.length : 0,
    stepScreenshots: trace.steps.filter((step) => typeof step.screenshot === 'string' && step.screenshot.startsWith('data:image/')).length,
    viewer: viewerStats,
  };
  if (isJson()) {
    emitJson({ ok: true, result });
    return 0;
  }
  print('已生成 Trace Viewer：' + output + '（' + Buffer.byteLength(html) + ' 字节）');
  print('步骤 ' + result.steps + ' · 状态 ' + result.states + ' · 网络 ' + result.network + ' · 截图 ' + result.screenshots);
  if (viewerStats) {
    print('span ' + viewerStats.spans.total + '（渲染 ' + viewerStats.spans.rendered + ' / ' + viewerStats.spanPages + ' 页）· 因果链 ' + viewerStats.causalChains.total + '（渲染 ' + viewerStats.causalChains.rendered + ' / ' + viewerStats.causalPages + ' 页）');
    if (viewerStats.criticalPath) print('关键路径 ' + viewerStats.criticalPath.totalMs + 'ms（' + viewerStats.criticalPath.spanCount + ' spans）');
    if (viewerStats.truncated) print('注意：内容超过渲染上限，已按上限截断（' + (viewerStats.notes.join('；') || '见 --json viewer.truncated') + '）');
    if (viewerStats.degraded) print('注意：HTML 超过字节上限，已降级渲染（' + viewerStats.notes.join('；') + '）');
    if (viewerStats.fallback) print('注意：已降级为最小摘要页（HTML 字节上限 ' + viewerStats.maxHtmlBytes + '）');
  }
  return 0;
}
