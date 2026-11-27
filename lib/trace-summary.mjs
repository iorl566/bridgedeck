// Trace 分析：从 CDP traceEvents 提取耗时、热点事件、长任务与分类分布。
//
// 本模块同时是 lib/trace-spans.mjs 的运行时消费点：非空 trace 会附带 spanSummary
// （span 树统计 / 关键路径 / 跨 frame 归属 / 异步组），供 CLI `trace summary` 与
// MCP browser_trace_summary 直接输出。空 trace 保持原有 6 字段结构不变。
//
// W9-C 加法：非空 trace 追加 `spanExport`（导出时 span 选择计划：关键路径/未完成/root
// 优先 + 父链闭包）与 `sampling`（事件数 vs 上限，是否建议采样），旧字段语义不变。
import { buildSpanTree, summarizeSpans, querySpans } from './trace-spans.mjs';
import { DEFAULT_MAX_EVENTS, planSpanExport } from './trace-budget.mjs';

const US_PER_MS = 1000;

export function summarizeTrace(trace, options = {}) {
  const {
    top = 20,
    longTaskMs = 50,
    spans = true,
  } = options && typeof options === 'object' ? options : {};
  const events = Array.isArray(trace && trace.traceEvents) ? trace.traceEvents.filter((event) => event && typeof event === 'object') : [];
  const categories = new Map();
  const names = new Map();
  let minTs = null;
  let maxTs = null;
  const longTasks = [];
  for (const event of events) {
    const category = String(event.cat || '');
    categories.set(category, (categories.get(category) || 0) + 1);
    const name = String(event.name || '');
    names.set(name, (names.get(name) || 0) + 1);
    const ts = Number(event.ts);
    const dur = Number(event.dur);
    if (Number.isFinite(ts) && ts > 0) {
      if (minTs == null || ts < minTs) minTs = ts;
      if (maxTs == null || ts > maxTs) maxTs = ts;
    }
    if (Number.isFinite(dur) && dur / US_PER_MS >= longTaskMs) {
      longTasks.push({
        name,
        category,
        durationMs: Math.round(dur / US_PER_MS),
        ...(Number.isFinite(ts) ? { at: Math.round(ts) } : {}),
        ...(event.args && event.args.data && event.args.data.url ? { url: String(event.args.data.url) } : {}),
      });
    }
  }
  const topOf = (map) => [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Number(top) || 20))
    .map(([key, count]) => ({ key, count }));
  const span = minTs != null && maxTs != null ? (maxTs - minTs) / US_PER_MS : 0;
  longTasks.sort((a, b) => b.durationMs - a.durationMs);
  const summary = {
    events: events.length,
    durationMs: Math.round(span),
    topCategories: topOf(categories),
    topNames: topOf(names),
    longTasks: longTasks.slice(0, Math.max(1, Number(top) || 20)),
    longTaskCount: longTasks.length,
  };
  if (events.length > 0 && spans !== false) {
    const tree = buildSpanTree({ traceEvents: events }, { maxSpans: 8000 });
    const spanSummary = summarizeSpans(tree, { top });
    const keyPath = querySpans(tree, { order: 'duration', limit: Math.max(1, Math.min(Number(top) || 20, 100)) });
    summary.spanSummary = {
      spans: spanSummary.spans,
      roots: spanSummary.roots,
      unfinished: spanSummary.unfinished,
      truncated: spanSummary.truncated,
      dropped: spanSummary.dropped,
      selfTotalMs: spanSummary.selfTotalMs,
      byPhase: spanSummary.byPhase,
      byCategory: spanSummary.byCategory,
      byName: spanSummary.byName,
      frames: spanSummary.byFrame,
      criticalPath: spanSummary.criticalPath,
      topSpans: keyPath.spans,
      processCount: spanSummary.processCount,
      threadCount: spanSummary.threadCount,
    };
    // 导出计划（不实际裁剪）：给调用方"这份 trace 导出时要保留哪些 span"的确定性答案。
    summary.spanExport = planSpanExport(tree, { maxSpans: options && Number(options.maxExportSpans) > 0 ? Number(options.maxExportSpans) : undefined });
    // 事件预算：超出建议上限时明确提示需要采样，而不是偷偷截断。
    summary.sampling = {
      events: events.length,
      maxEvents: DEFAULT_MAX_EVENTS,
      exceeds: events.length > DEFAULT_MAX_EVENTS,
      note: events.length > DEFAULT_MAX_EVENTS
        ? '事件数超过默认导出上限，导出请用 trace-budget.sampleTraceEvents（结构安全采样）而不是直接截断。'
        : '',
    };
  }
  return summary;
}

/** 对比两份 trace summary：事件/时长/长任务与热点事件变化。 */
export function diffTraceSummary(baseSummary, headSummary, { top = 10 } = {}) {
  const base = baseSummary || {};
  const head = headSummary || {};
  const baseNames = new Map((base.topNames || []).map((item) => [item.key, item.count]));
  const headNames = new Map((head.topNames || []).map((item) => [item.key, item.count]));
  const keys = new Set([...baseNames.keys(), ...headNames.keys()]);
  const topChanges = [...keys].map((key) => ({
    key,
    base: baseNames.get(key) || 0,
    head: headNames.get(key) || 0,
    delta: (headNames.get(key) || 0) - (baseNames.get(key) || 0),
  })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, Math.max(1, Number(top) || 10));
  const diff = {
    events: { base: Number(base.events) || 0, head: Number(head.events) || 0, delta: (Number(head.events) || 0) - (Number(base.events) || 0) },
    durationMs: { base: Number(base.durationMs) || 0, head: Number(head.durationMs) || 0, delta: (Number(head.durationMs) || 0) - (Number(base.durationMs) || 0) },
    longTaskCount: { base: Number(base.longTaskCount) || 0, head: Number(head.longTaskCount) || 0, delta: (Number(head.longTaskCount) || 0) - (Number(base.longTaskCount) || 0) },
    topChanges,
  };
  // 两边都有 span 摘要时才给关键路径差分，保持旧输入形状兼容。
  if (base.spanSummary && head.spanSummary) {
    const before = Number(base.spanSummary.criticalPath && base.spanSummary.criticalPath.totalMs) || 0;
    const after = Number(head.spanSummary.criticalPath && head.spanSummary.criticalPath.totalMs) || 0;
    diff.criticalPath = {
      base: before,
      head: after,
      delta: Math.round((after - before) * 100) / 100,
      baseSpans: (base.spanSummary.criticalPath && base.spanSummary.criticalPath.spanCount) || 0,
      headSpans: (head.spanSummary.criticalPath && head.spanSummary.criticalPath.spanCount) || 0,
    };
    diff.spanCount = { base: Number(base.spanSummary.spans) || 0, head: Number(head.spanSummary.spans) || 0 };
  }
  // 导出计划差分（W9-C 加法）：base/head 任一带 spanExport 时给出保留/裁剪对比。
  if (base.spanExport || head.spanExport) {
    const before = base.spanExport || {};
    const after = head.spanExport || {};
    diff.spanExport = {
      base: { total: Number(before.total) || 0, keep: Number(before.keep) || 0, dropped: Number(before.dropped) || 0, strategy: before.strategy || null },
      head: { total: Number(after.total) || 0, keep: Number(after.keep) || 0, dropped: Number(after.dropped) || 0, strategy: after.strategy || null },
      deltaKept: (Number(after.keep) || 0) - (Number(before.keep) || 0),
      deltaDropped: (Number(after.dropped) || 0) - (Number(before.dropped) || 0),
    };
  }
  return diff;
}
