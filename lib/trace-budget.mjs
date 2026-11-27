// lib/trace-budget.mjs —— trace 采样 / 截断 / 导出体积降级的策略层。
//
// 与 lib/trace-spans.mjs 的分工：
//   * trace-spans 负责"把事件还原成可分析的 span 树"（正确性）；
//   * 本模块负责"数据太大时怎么办"（策略），并且必须诚实：
//       采样/截断/降级一律显式记录 total/keep/dropped/strategy/notes，
//       不把"被丢弃的样本"伪装成"完整数据"，也不因为截断把未完成 span 说成完成。
//
// 关键机制：
//   1. 结构安全采样：按 B/E、S/F、b/e 配对成"事件单元"再整体保留，绝不让采样拆散
//      begin/end 对（拆散会产生悬空 span 或错误的 duration）；
//   2. 采样策略：duration-priority（默认，保留最长区间，适合找瓶颈）/ head-tail /
//      uniform（确定性哈希）/ none；元数据事件与未配对的孤立事件始终保留；
//   3. span 导出选择：关键路径、root、未完成 span、self 时间 Top 优先，再做父链闭包，
//      保证导出的 span 集合仍是一棵"连通"的树；
//   4. 导出体积降级：plan → compact →（仍超限）minimal；每级都有机器可读的 actions。
//
// 消费点：
//   * lib/trace-summary.mjs `summarizeTrace`（CLI trace summary / MCP browser_trace_summary）
//     → `summary.spanExport` / `summary.sampling`（只在有事件时出现，空 trace 形状不变）；
//   * lib/trace-v3.mjs `buildTraceV3`（CLI record stop）
//     → 大 trace 自动采样 + `trace.sampling` / `trace.spanExport` / `trace.exportBudget`；
//   * lib/trace-viewer.mjs `renderTraceReport` → stats.sampling / stats.spanExport。

import { buildSpanTree, criticalPath } from './trace-spans.mjs';

export const TRACE_BUDGET_VERSION = 1;
export const DEFAULT_MAX_EVENTS = 20000;
export const DEFAULT_MAX_SPANS = 2500;
export const DEFAULT_MAX_STEPS = 1000;
export const DEFAULT_MAX_STATE_CHARS = 4000;
export const DEFAULT_MAX_SCREENSHOTS = 20;
export const DEFAULT_MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_EXPORT_BYTES = 4 * 1024 * 1024;
export const SAMPLING_STRATEGIES = Object.freeze(['duration-priority', 'head-tail', 'uniform', 'none']);
export const COMPACT_LEVELS = Object.freeze(['full', 'compact', 'sampled', 'minimal']);

const META_PHASES = new Set(['M', 'm']);
const COMPLETE_PHASES = new Set(['X']);
const BEGIN_PHASES = new Set(['B']);
const END_PHASES = new Set(['E']);
const ASYNC_BEGIN = new Set(['S', 'b']);
const ASYNC_STEP = new Set(['T']);
const ASYNC_END = new Set(['F', 'e']);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function textOf(value) {
  return String(value == null ? '' : value);
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text == null ? '' : text);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function byteLengthOf(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(text)).length;
  return String(text).length * 2;
}

/** JSON 体积估算（无法序列化时返回 null，不抛异常）。 */
export function estimateJsonBytes(value) {
  if (value === undefined) return 0;
  try {
    return byteLengthOf(JSON.stringify(value));
  } catch {
    return null;
  }
}

/** 事件相位分类（采样单元构建的基础）。 */
export function classifyTraceEvent(event) {
  if (!event || typeof event !== 'object') return 'invalid';
  const phase = textOf(event.ph || event.phase).trim();
  if (META_PHASES.has(phase)) return 'metadata';
  if (COMPLETE_PHASES.has(phase)) return 'complete';
  if (BEGIN_PHASES.has(phase)) return 'begin';
  if (END_PHASES.has(phase)) return 'end';
  if (ASYNC_BEGIN.has(phase)) return 'async-begin';
  if (ASYNC_STEP.has(phase)) return 'async-step';
  if (ASYNC_END.has(phase)) return 'async-end';
  if (phase === 'I') return 'instant';
  return phase === '' ? 'invalid' : 'other';
}

function keyOfThread(pid, tid) {
  return textOf(pid) + ':' + textOf(tid);
}

function keyOfAsync(event) {
  return [textOf(event.cat), textOf(event.id), event.id2 == null ? '' : textOf(event.id2)].join(':');
}

/**
 * 把事件流切成"不可再拆的单元"：B/E 对、S/F 对、b/e 对、X、I、元数据。
 * 返回 {metadata, units, unpaired, stats}；unpaired 是配不上对的 begin/end/async 事件，
 * 它们本身是"输入被截断"的证据，采样时必须保留。
 */
export function buildTraceEventUnits(events) {
  const list = Array.isArray(events) ? events : [];
  const metadata = [];
  const units = [];
  const unpaired = [];
  const stacks = new Map();
  const asyncStacks = new Map();
  const stats = { metadata: 0, complete: 0, instant: 0, beginEnd: 0, async: 0, other: 0, invalid: 0, unpaired: 0 };
  const pushUnit = (unit) => {
    units.push(unit);
    return unit;
  };
  list.forEach((event, index) => {
    const kind = classifyTraceEvent(event);
    if (kind === 'metadata') {
      metadata.push(index);
      stats.metadata += 1;
      return;
    }
    if (kind === 'invalid' || kind === 'other') {
      stats[kind] += 1;
      unpaired.push(index);
      return;
    }
    if (kind === 'complete') {
      pushUnit({ kind: 'complete', indices: [index], startIndex: index, ts: finite(event.ts), durUs: finite(event.dur) ?? 0 });
      stats.complete += 1;
      return;
    }
    if (kind === 'instant') {
      pushUnit({ kind: 'instant', indices: [index], startIndex: index, ts: finite(event.ts), durUs: 0 });
      stats.instant += 1;
      return;
    }
    if (kind === 'begin') {
      const key = keyOfThread(event.pid, event.tid);
      if (!stacks.has(key)) stacks.set(key, []);
      stacks.get(key).push(index);
      return;
    }
    if (kind === 'end') {
      const key = keyOfThread(event.pid, event.tid);
      const stack = stacks.get(key) || [];
      const beginIndex = stack.pop();
      if (beginIndex == null) {
        unpaired.push(index);
        stats.unpaired += 1;
        return;
      }
      const begin = list[beginIndex];
      const beginTs = begin ? finite(begin.ts) : null;
      const endTs = finite(event.ts);
      const durUs = beginTs != null && endTs != null ? Math.max(0, endTs - beginTs) : 0;
      pushUnit({ kind: 'begin-end', indices: [beginIndex, index], startIndex: beginIndex, ts: beginTs, durUs });
      stats.beginEnd += 1;
      return;
    }
    if (kind === 'async-begin') {
      const key = keyOfAsync(event);
      if (!asyncStacks.has(key)) asyncStacks.set(key, []);
      asyncStacks.get(key).push({ begin: index, steps: [] });
      return;
    }
    if (kind === 'async-step') {
      const key = keyOfAsync(event);
      const stack = asyncStacks.get(key) || [];
      const top = stack[stack.length - 1];
      if (top) top.steps.push(index);
      else {
        unpaired.push(index);
        stats.unpaired += 1;
      }
      return;
    }
    if (kind === 'async-end') {
      const key = keyOfAsync(event);
      const stack = asyncStacks.get(key) || [];
      const top = stack.pop();
      if (!top) {
        unpaired.push(index);
        stats.unpaired += 1;
        return;
      }
      const begin = list[top.begin];
      const beginTs = begin ? finite(begin.ts) : null;
      const endTs = finite(event.ts);
      const durUs = beginTs != null && endTs != null ? Math.max(0, endTs - beginTs) : 0;
      pushUnit({ kind: 'async', indices: [top.begin, ...top.steps, index], startIndex: top.begin, ts: beginTs, durUs });
      stats.async += 1;
    }
  });
  // 未闭合的 begin / async-begin 也是证据：保留原始事件。
  for (const stack of stacks.values()) {
    for (const index of stack) {
      unpaired.push(index);
      stats.unpaired += 1;
    }
  }
  for (const stack of asyncStacks.values()) {
    for (const entry of stack) {
      unpaired.push(entry.begin, ...entry.steps);
      stats.unpaired += 1;
    }
  }
  units.sort((a, b) => a.startIndex - b.startIndex);
  return { metadata, units, unpaired: [...new Set(unpaired)].sort((a, b) => a - b), stats };
}

function rankUnits(units, strategy, seed) {
  const list = units.slice();
  if (strategy === 'none') return list;
  if (strategy === 'uniform') {
    return list.sort((a, b) => {
      const left = fnv1a(seed + '#' + a.startIndex);
      const right = fnv1a(seed + '#' + b.startIndex);
      return left.localeCompare(right) || a.startIndex - b.startIndex;
    });
  }
  if (strategy === 'head-tail') {
    // head-tail 由调用方按数量分配，这里只按开始顺序返回。
    return list;
  }
  // duration-priority：最长区间优先；没有 dur 的单元排在后面，保持原始顺序。
  return list.sort((a, b) => (b.durUs || 0) - (a.durUs || 0) || a.startIndex - b.startIndex);
}

function chooseUnits(units, budgetEvents, strategy, seed) {
  if (budgetEvents <= 0) return [];
  if (strategy === 'head-tail') {
    // 头尾各占 ~40% 预算，中间均匀抽样补足；避免"预算全被头部吃光"。
    const chosen = [];
    const picked = new Set();
    let used = 0;
    const take = (unit) => {
      if (!unit || picked.has(unit.startIndex)) return false;
      const size = unit.indices.length;
      if (used + size > budgetEvents) return false;
      chosen.push(unit);
      picked.add(unit.startIndex);
      used += size;
      return true;
    };
    const headBudget = Math.max(1, Math.ceil(budgetEvents * 0.4));
    let headUsed = 0;
    for (const unit of units) {
      if (headUsed >= headBudget) break;
      const before = used;
      if (!take(unit)) continue;
      headUsed += used - before;
    }
    const tailBudget = Math.max(1, Math.ceil(budgetEvents * 0.4));
    let tailUsed = 0;
    for (let index = units.length - 1; index >= 0 && tailUsed < tailBudget; index -= 1) {
      const before = used;
      if (!take(units[index])) continue;
      tailUsed += used - before;
    }
    // 中间剩余：按均匀间隔取，补到预算
    const remaining = units.filter((unit) => !picked.has(unit.startIndex));
    if (remaining.length && used < budgetEvents) {
      const need = budgetEvents - used;
      const stride = Math.max(1, Math.floor(remaining.length / Math.max(1, need)));
      for (let index = 0; index < remaining.length && used < budgetEvents; index += stride) {
        take(remaining[index]);
      }
      for (const unit of remaining) {
        if (used >= budgetEvents) break;
        take(unit);
      }
    }
    return chosen;
  }
  const order = strategy === 'none' ? units.slice() : rankUnits(units, strategy, seed);
  // 预算以"事件数"计：单元不可拆，放不下就跳过（继续找更小的单元），保证 kept <= 预算。
  const chosen = [];
  let used = 0;
  for (const unit of order) {
    const size = unit.indices.length;
    if (used + size > budgetEvents) continue;
    chosen.push(unit);
    used += size;
    if (used >= budgetEvents) break;
  }
  return chosen;
}

/**
 * 结构安全采样 traceEvents。
 * options:
 *   maxEvents   目标事件数（默认 20000）；<=0 表示不限制
 *   strategy    'duration-priority'（默认）|'head-tail'|'uniform'|'none'
 *   seed        uniform 策略的确定性种子（默认 'bb-trace'）
 *   now         兼容参数（不参与计算）
 *
 * 返回：
 *   {version, strategy, seed, total, kept, dropped, ratio, events, units, notes, pairing}
 * 事件按原始顺序返回；元数据与孤立事件优先保留（它们是配对/截断证据）。
 */
export function sampleTraceEvents(events, options = {}) {
  const list = Array.isArray(events) ? events.filter((event) => event && typeof event === 'object') : [];
  const opts = options && typeof options === 'object' ? options : {};
  const strategy = SAMPLING_STRATEGIES.includes(opts.strategy) ? opts.strategy : 'duration-priority';
  const seed = textOf(opts.seed) || 'bb-trace';
  const maxEvents = Math.floor(finite(opts.maxEvents) ?? DEFAULT_MAX_EVENTS);
  const total = list.length;
  if (maxEvents <= 0 || total <= maxEvents) {
    return {
      version: TRACE_BUDGET_VERSION,
      strategy: 'none',
      seed,
      total,
      kept: total,
      dropped: 0,
      ratio: 1,
      events: list.slice(),
      units: { total: 0, kept: 0, dropped: 0, metadata: 0, unpaired: 0, byKind: {} },
      pairing: { intact: true, keptUnits: 0, droppedUnits: 0 },
      notes: maxEvents <= 0 && total > 0 ? ['maxEvents<=0：不限制事件数，未做采样。'] : [],
      honest: true,
    };
  }
  const built = buildTraceEventUnits(list);
  const pinned = new Set(built.metadata.concat(built.unpaired));
  const budget = Math.max(0, maxEvents - pinned.size);
  const chosen = chooseUnits(built.units, budget, strategy, seed);
  const keptIndices = new Set(pinned);
  for (const unit of chosen) {
    for (const index of unit.indices) keptIndices.add(index);
  }
  const selectedEvents = [];
  for (let index = 0; index < list.length; index += 1) {
    if (keptIndices.has(index)) selectedEvents.push(list[index]);
  }
  const dropped = total - selectedEvents.length;
  const keptUnits = chosen.length;
  const byKind = {};
  for (const unit of chosen) byKind[unit.kind] = (byKind[unit.kind] || 0) + 1;
  const notes = [];
  if (dropped > 0) {
    notes.push('事件数 ' + total + ' 超过上限 ' + maxEvents + '，按 ' + strategy + ' 采样后保留 ' + selectedEvents.length + ' 条；'
      + 'B/E、S/F、b/e 事件单元整体保留，元数据与孤立事件不丢。');
  }
  if (pinned.size > maxEvents) {
    notes.push('元数据/孤立事件就有 ' + pinned.size + ' 条，超过上限 ' + maxEvents + '；这些是配对证据，仍全部保留（kept 会大于 maxEvents）。');
  }
  return {
    version: TRACE_BUDGET_VERSION,
    strategy,
    seed,
    total,
    kept: selectedEvents.length,
    dropped,
    ratio: total > 0 ? round(selectedEvents.length / total, 4) : 1,
    events: selectedEvents,
    units: {
      total: built.units.length,
      kept: keptUnits,
      dropped: Math.max(0, built.units.length - keptUnits),
      metadata: built.metadata.length,
      unpaired: built.unpaired.length,
      byKind,
    },
    pairing: { intact: true, keptUnits, droppedUnits: Math.max(0, built.units.length - keptUnits) },
    notes,
    honest: true,
  };
}

/** 采样结果 → 可写进 trace 的紧凑摘要（不含事件本身）。 */
export function summarizeTraceSampling(sampling) {
  const source = sampling && typeof sampling === 'object' ? sampling : {};
  return {
    version: TRACE_BUDGET_VERSION,
    strategy: source.strategy || 'none',
    seed: source.seed || null,
    total: Number(source.total) || 0,
    kept: Number(source.kept) || 0,
    dropped: Number(source.dropped) || 0,
    ratio: Number.isFinite(Number(source.ratio)) ? Number(source.ratio) : 1,
    units: source.units || { total: 0, kept: 0, dropped: 0, metadata: 0, unpaired: 0, byKind: {} },
    pairing: source.pairing || { intact: true, keptUnits: 0, droppedUnits: 0 },
    notes: Array.isArray(source.notes) ? source.notes.slice(0, 5) : [],
    honest: true,
  };
}

function spanListOf(source) {
  if (!source) return { spans: [], roots: [], byId: {}, tree: null };
  if (Array.isArray(source)) {
    const byId = {};
    for (const span of source) if (span && span.id != null) byId[span.id] = span;
    const roots = source.filter((span) => span && (span.parentId == null || !byId[span.parentId])).map((span) => span.id);
    return { spans: source.filter(Boolean), roots, byId, tree: null };
  }
  if (Array.isArray(source.spans) && source.byId && typeof source.byId === 'object') {
    return { spans: source.spans, roots: Array.isArray(source.roots) ? source.roots : [], byId: source.byId, tree: source };
  }
  if (Array.isArray(source.traceEvents)) {
    const tree = buildSpanTree(source, { maxSpans: DEFAULT_MAX_EVENTS });
    return { spans: tree.spans, roots: tree.roots, byId: tree.byId, tree };
  }
  return { spans: [], roots: [], byId: {}, tree: null };
}

function publicSpanOf(span) {
  return {
    id: span.id,
    name: span.name,
    cat: span.cat,
    phase: span.ph,
    tsMs: span.tsMs,
    durMs: span.durMs,
    selfMs: span.selfMs,
    depth: span.depth,
    parentId: span.parentId,
    children: Array.isArray(span.children) ? span.children.length : 0,
    frame: span.frame || null,
    url: span.url || '',
    thread: span.thread || null,
    process: span.process || null,
    unfinished: span.dur == null,
  };
}

/**
 * 为导出选择 span 子集（保证树连通）。
 * options: {maxSpans, mustKeepIds}
 * 返回 {strategy, total, keep, dropped, ids, spans, criticalPath, rootsKept, closureAdded, notes}
 */
export function selectSpansForExport(source, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const tree = spanListOf(source);
  const spans = tree.spans;
  const maxSpans = Math.max(1, Math.floor(finite(opts.maxSpans) ?? DEFAULT_MAX_SPANS));
  const total = spans.length;
  if (total <= maxSpans) {
    return {
      strategy: 'none',
      total,
      keep: total,
      dropped: 0,
      ids: spans.map((span) => span.id),
      spans: spans.map(publicSpanOf),
      criticalPath: (tree.tree ? criticalPath(tree.tree) : { spans: [] }).spans.map((span) => span.id),
      rootsKept: tree.roots.length,
      closureAdded: 0,
      notes: [],
    };
  }
  const byId = tree.byId;
  const selected = new Set();
  const selectionOrder = [];
  const add = (id, reason) => {
    if (id == null || selected.has(id) || !byId[id]) return false;
    selected.add(id);
    selectionOrder.push({ id, reason });
    return true;
  };
  // 1) 关键路径（最长 self 链）
  const path = tree.tree ? criticalPath(tree.tree) : { spans: [] };
  const criticalIds = [];
  for (const span of path.spans) {
    if (add(span.id, 'critical-path')) criticalIds.push(span.id);
  }
  // 2) 未完成 span（截断证据）+ root
  for (const span of spans) {
    if (selected.size >= maxSpans) break;
    if (span.dur == null) add(span.id, 'unfinished');
  }
  for (const rootId of tree.roots) {
    if (selected.size >= maxSpans) break;
    add(rootId, 'root');
  }
  // 3) self 时间 Top（瓶颈），再按 duration 填充
  const bySelf = spans.slice().sort((a, b) => (Number(b.selfMs) || 0) - (Number(a.selfMs) || 0));
  for (const span of bySelf) {
    if (selected.size >= maxSpans) break;
    add(span.id, 'self-time');
  }
  const byDuration = spans.slice().sort((a, b) => (Number(b.durMs) || 0) - (Number(a.durMs) || 0));
  for (const span of byDuration) {
    if (selected.size >= maxSpans) break;
    add(span.id, 'duration');
  }
  // 4) 父链闭包：被选中的 span 必须有祖先，否则渲染时树会断。
  let closureAdded = 0;
  let closureIncomplete = false;
  for (const id of [...selected]) {
    let cursor = byId[id];
    let guard = 0;
    while (cursor && cursor.parentId != null && !selected.has(cursor.parentId) && guard < 64) {
      if (selected.size >= maxSpans) {
        closureIncomplete = true;
        break;
      }
      if (add(cursor.parentId, 'ancestor-closure')) closureAdded += 1;
      cursor = byId[cursor.parentId];
      guard += 1;
    }
  }
  const selectedSpans = spans.filter((span) => selected.has(span.id)).map(publicSpanOf);
  const notes = [];
  if (selected.size < total) {
    notes.push('span 数 ' + total + ' 超过导出上限 ' + maxSpans + '，保留 ' + selected.size + ' 个（关键路径/未完成/root/self Top 优先，父链闭包）；'
      + '省略 ' + (total - selected.size) + ' 个。');
  }
  if (closureIncomplete) notes.push('父链闭包触达上限，部分 span 的祖先未全部保留（见 spanExport.closureIncomplete）。');
  return {
    strategy: 'priority-tree',
    total,
    keep: selectedSpans.length,
    dropped: total - selectedSpans.length,
    ids: selectedSpans.map((span) => span.id),
    spans: selectedSpans,
    criticalPath: criticalIds,
    rootsKept: tree.roots.filter((id) => selected.has(id)).length,
    closureAdded,
    closureIncomplete,
    notes,
  };
}

/** 只算选择计划（不返回 span 明细），供 summarizeTrace 这类热路径使用。 */
export function planSpanExport(source, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxSpans = Math.max(1, Math.floor(finite(opts.maxSpans) ?? DEFAULT_MAX_SPANS));
  const tree = spanListOf(source);
  const total = tree.spans.length;
  if (total <= maxSpans) {
    return {
      version: TRACE_BUDGET_VERSION,
      strategy: 'none',
      total,
      keep: total,
      dropped: 0,
      criticalPathSpans: tree.tree ? criticalPath(tree.tree).spanCount : 0,
      closureAdded: 0,
      maxSpans,
      notes: [],
    };
  }
  const selection = selectSpansForExport(tree, { maxSpans });
  return {
    version: TRACE_BUDGET_VERSION,
    strategy: selection.strategy,
    total,
    keep: selection.keep,
    dropped: selection.dropped,
    criticalPathSpans: selection.criticalPath.length,
    closureAdded: selection.closureAdded,
    maxSpans,
    notes: selection.notes,
  };
}

function screenshotDataOf(item) {
  if (typeof item === 'string') return /^data:image\//i.test(item) ? item : '';
  if (item && typeof item === 'object' && typeof item.dataUrl === 'string' && /^data:image\//i.test(item.dataUrl)) return item.dataUrl;
  return '';
}

/**
 * 规划一次 trace 导出（不修改 trace）。
 * options: {maxEvents, maxSpans, maxSteps, maxStateChars, maxScreenshots, maxScreenshotBytes, maxBytes, strategy}
 * 语义：`degraded=true` 表示"按体积预算必须降级"；`wouldDegrade` 表示"即使体积没超，
 * 也建议按条数/正文上限裁剪"（由调用方决定是否 force）。
 */
export function planTraceExport(trace, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const source = trace && typeof trace === 'object' ? trace : {};
  const budget = {
    maxEvents: Math.floor(finite(opts.maxEvents) ?? DEFAULT_MAX_EVENTS),
    maxSpans: Math.max(1, Math.floor(finite(opts.maxSpans) ?? DEFAULT_MAX_SPANS)),
    maxSteps: Math.max(1, Math.floor(finite(opts.maxSteps) ?? DEFAULT_MAX_STEPS)),
    maxStateChars: Math.max(16, Math.floor(finite(opts.maxStateChars) ?? DEFAULT_MAX_STATE_CHARS)),
    maxScreenshots: Math.max(0, Math.floor(finite(opts.maxScreenshots) ?? DEFAULT_MAX_SCREENSHOTS)),
    maxScreenshotBytes: Math.max(1024, Math.floor(finite(opts.maxScreenshotBytes) ?? DEFAULT_MAX_SCREENSHOT_BYTES)),
    maxBytes: Math.max(1024, Math.floor(finite(opts.maxBytes) ?? DEFAULT_MAX_EXPORT_BYTES)),
  };
  const traceEvents = Array.isArray(source.traceEvents) ? source.traceEvents : [];
  const spans = Array.isArray(source.spans) ? source.spans : [];
  const steps = Array.isArray(source.steps) ? source.steps : [];
  const states = Array.isArray(source.states) ? source.states : [];
  const screenshots = Array.isArray(source.screenshots) ? source.screenshots : [];
  const actions = [];
  if (traceEvents.length > budget.maxEvents) {
    actions.push({ kind: 'sample-events', reason: 'events-over-budget', from: traceEvents.length, to: budget.maxEvents });
  }
  if (spans.length > budget.maxSpans) {
    actions.push({ kind: 'truncate-spans', reason: 'spans-over-budget', from: spans.length, to: budget.maxSpans });
  }
  if (steps.length > budget.maxSteps) {
    actions.push({ kind: 'truncate-steps', reason: 'steps-over-budget', from: steps.length, to: budget.maxSteps });
  }
  const longStates = states.filter((state) => state && typeof state.body === 'string' && state.body.length > budget.maxStateChars).length;
  if (longStates > 0) {
    actions.push({ kind: 'truncate-state-bodies', reason: 'state-body-over-budget', from: longStates, to: 0 });
  }
  const validScreenshots = screenshots.filter((item) => screenshotDataOf(item) !== '');
  const oversized = validScreenshots.filter((item) => byteLengthOf(screenshotDataOf(item)) > budget.maxScreenshotBytes).length;
  if (validScreenshots.length > budget.maxScreenshots || oversized > 0) {
    actions.push({
      kind: 'drop-screenshots',
      reason: validScreenshots.length > budget.maxScreenshots ? 'screenshots-over-budget' : 'screenshot-over-size',
      from: screenshots.length,
      to: Math.min(validScreenshots.length, budget.maxScreenshots),
      oversized,
    });
  }
  const estimatedBytes = estimateJsonBytes(source);
  const overBytes = estimatedBytes != null && estimatedBytes > budget.maxBytes;
  const wouldDegrade = actions.length > 0;
  let level = 'full';
  if (overBytes) {
    level = actions.some((action) => ['sample-events', 'truncate-spans'].includes(action.kind)) ? 'sampled' : 'compact';
  }
  const notes = actions.map((action) => action.kind + '：' + (action.reason || '') + '（from=' + action.from + ', to=' + action.to + '）');
  if (overBytes) notes.unshift('估算体积 ' + estimatedBytes + 'B 超过上限 ' + budget.maxBytes + 'B，必须降级。');
  else if (wouldDegrade) notes.unshift('体积在上限内，但存在可裁剪项（force 时执行；默认不改写输出）。');
  return {
    version: TRACE_BUDGET_VERSION,
    budget,
    level,
    degraded: overBytes,
    wouldDegrade,
    estimatedBytes,
    actions,
    notes,
  };
}

function truncateStateBody(body, maxChars) {
  const text = textOf(body);
  if (text.length <= maxChars) return { body: text, truncated: false, originalChars: text.length };
  return { body: text.slice(0, maxChars) + '…（已截断，共 ' + text.length + ' 字符）', truncated: true, originalChars: text.length };
}

function compactOnce(trace, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const plan = planTraceExport(trace, opts);
  const out = { ...trace };
  const actions = plan.actions.slice();
  let sampling = null;
  if (Array.isArray(out.traceEvents) && out.traceEvents.length > plan.budget.maxEvents) {
    sampling = sampleTraceEvents(out.traceEvents, {
      maxEvents: plan.budget.maxEvents,
      strategy: SAMPLING_STRATEGIES.includes(opts.strategy) ? opts.strategy : 'duration-priority',
      seed: opts.seed,
    });
    out.traceEvents = sampling.events;
    out.sampling = summarizeTraceSampling(sampling);
  }
  if (Array.isArray(out.spans) && out.spans.length > plan.budget.maxSpans) {
    const selection = selectSpansForExport(out.spans, { maxSpans: plan.budget.maxSpans });
    out.spans = selection.spans;
    out.spanExport = {
      version: TRACE_BUDGET_VERSION,
      strategy: selection.strategy,
      total: selection.total,
      keep: selection.keep,
      dropped: selection.dropped,
      criticalPathSpans: selection.criticalPath.length,
      closureAdded: selection.closureAdded,
      notes: selection.notes,
    };
  }
  if (Array.isArray(out.steps) && out.steps.length > plan.budget.maxSteps) {
    const head = Math.ceil(plan.budget.maxSteps / 2);
    const tail = Math.max(0, plan.budget.maxSteps - head);
    const keptSteps = out.steps.slice(0, head).concat(tail > 0 ? out.steps.slice(out.steps.length - tail) : []);
    out.steps = keptSteps;
    out.stepsTruncated = { total: trace.steps.length, kept: keptSteps.length, dropped: trace.steps.length - keptSteps.length, strategy: 'head-tail' };
  }
  if (Array.isArray(out.states)) {
    let truncatedStates = 0;
    out.states = out.states.map((state) => {
      if (!state || typeof state.body !== 'string') return state;
      const clipped = truncateStateBody(state.body, plan.budget.maxStateChars);
      if (!clipped.truncated) return state;
      truncatedStates += 1;
      return { ...state, body: clipped.body, bodyTruncated: true, bodyOriginalChars: clipped.originalChars };
    });
    if (truncatedStates > 0) out.statesTruncated = { states: truncatedStates, maxChars: plan.budget.maxStateChars };
  }
  if (Array.isArray(out.screenshots)) {
    const kept = out.screenshots.filter((item) => screenshotDataOf(item) !== ''
      && byteLengthOf(screenshotDataOf(item)) <= plan.budget.maxScreenshotBytes).slice(0, plan.budget.maxScreenshots);
    if (kept.length !== out.screenshots.length) {
      out.screenshotsTruncated = { total: out.screenshots.length, kept: kept.length, dropped: out.screenshots.length - kept.length };
      out.screenshots = kept;
    }
  }
  const estimatedBytes = estimateJsonBytes(out);
  let level = plan.level;
  if (level === 'full') {
    level = actions.some((action) => ['sample-events', 'truncate-spans'].includes(action.kind)) ? 'sampled' : 'compact';
  }
  if (estimatedBytes != null && estimatedBytes > plan.budget.maxBytes) level = 'minimal';
  out.exportBudget = {
    version: TRACE_BUDGET_VERSION,
    level,
    degraded: true,
    estimatedBytes,
    actions,
    notes: plan.notes,
    maxBytes: plan.budget.maxBytes,
  };
  return { trace: out, plan: out.exportBudget, sampling };
}

/**
 * 对 trace 应用体积降级（返回新对象，不修改入参）。
 * 默认只在 `plan.degraded`（估算体积超 maxBytes）时执行；`options.force=true` 时即使体积
 * 在预算内也按条数/正文上限裁剪（例如用户显式要求小文件）。
 * 先做一轮 compact；仍超 maxBytes 时输出 minimal（只剩 step 摘要 + spanSummary）。
 * 返回 {trace, plan}；plan.level ∈ full/compact/sampled/minimal。
 */
export function compactTrace(trace, options = {}) {
  const source = trace && typeof trace === 'object' ? trace : {};
  const opts = options && typeof options === 'object' ? options : {};
  const plan0 = planTraceExport(source, opts);
  if (!plan0.degraded && opts.force !== true) {
    return { trace: source, plan: plan0 };
  }
  const compacted = compactOnce(source, opts);
  const out = compacted.trace;
  if (out.exportBudget && out.exportBudget.level === 'minimal') {
    // minimal：去掉明细，只留摘要级字段，仍保留采样/预算证据。
    const minimal = { ...out };
    delete minimal.spans;
    delete minimal.traceEvents;
    if (Array.isArray(minimal.steps) && minimal.steps.length > 50) {
      const head = 25;
      const tail = 25;
      minimal.steps = minimal.steps.slice(0, head).concat(minimal.steps.slice(minimal.steps.length - tail));
      minimal.stepsTruncated = { ...(minimal.stepsTruncated || {}), minimal: true, kept: minimal.steps.length };
    }
    if (Array.isArray(minimal.states)) {
      minimal.states = minimal.states.slice(0, 50).map((state) => (state && typeof state.body === 'string'
        ? { ...state, body: state.body.slice(0, 500), bodyTruncated: true }
        : state));
      minimal.statesTruncated = { ...(minimal.statesTruncated || {}), minimal: true };
    }
    minimal.screenshots = [];
    minimal.screenshotsTruncated = { minimal: true, kept: 0 };
    const minimalBytes = estimateJsonBytes(minimal);
    minimal.exportBudget = {
      ...out.exportBudget,
      level: 'minimal',
      estimatedBytes: minimalBytes,
      notes: out.exportBudget.notes.concat(['仍超过字节上限，已降级为 minimal（只保留摘要与计数）。']),
    };
    return { trace: minimal, plan: minimal.exportBudget };
  }
  return { trace: out, plan: out.exportBudget };
}

/** 预算 + 采样/span 选择的合并摘要（trace.summary / viewer stats 用）。 */
export function summarizeTraceBudget(trace, options = {}) {
  const source = trace && typeof trace === 'object' ? trace : {};
  const plan = planTraceExport(source, options);
  return {
    version: TRACE_BUDGET_VERSION,
    level: plan.level,
    degraded: plan.degraded,
    estimatedBytes: plan.estimatedBytes,
    maxBytes: plan.budget.maxBytes,
    actions: plan.actions,
    notes: plan.notes,
  };
}
