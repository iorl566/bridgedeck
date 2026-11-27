// lib/trace-spans.mjs —— CDP trace 的 span 树 / 因果链 / 关键路径 / 跨 frame 归属 / 查询。
//
// 输入是 Chrome DevTools trace（{traceEvents:[...]} 或事件数组）。支持的阶段：
//   X  完整事件（ts+dur）
//   B/E 嵌套区间（栈配对）
//   I  瞬时事件（dur=0）
//   S/T/F 异步事件（按 cat+id+id2 配对）
//   b/e 可嵌套异步事件
//   M  元数据（process_name / thread_name → 进程/线程名）
//
// 输出：
//   * span 树：每 span 带 parentId/children/depth/selfMs/frame/url/thread/process；
//   * 因果链：causalChain() 沿 parent 与异步组往回/往前找；
//   * 关键路径：criticalPath() 用 self time 求最长嵌套链（避免父子 duration 重复计算）；
//   * 跨 frame：从 args.data.frame / args.frame / args.data.url 归属，frames 汇总；
//   * 查询与摘要：querySpans()（过滤 + 分页）、summarizeSpans()（分布 + Top + 关键路径）。
//
// 消费点：
//   * lib/trace-summary.mjs（CLI `trace summary` / MCP browser_trace_summary 输出 spanSummary）；
//   * lib/trace-viewer.mjs（离线 HTML 的关键路径/span 表/跨 frame 区块）；
//   * lib/trace-v3.mjs（录制里带 traceEvents 时挂 spanSummary）。

const US_PER_MS = 1000;
const DEFAULT_MAX_SPANS = 20000;

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOf(value) {
  return String(value == null ? '' : value);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/** 提取事件里的 frame 归属（CDP 不同事件把 frameId/url 放在不同位置）。 */
export function frameOfEvent(event) {
  const args = event && event.args && typeof event.args === 'object' ? event.args : {};
  const data = args.data && typeof args.data === 'object' ? args.data : args;
  const frameId = data.frame ?? data.frameId ?? data.frame_id ?? args.frame ?? null;
  const url = stringOf(data.url || data.documentURL || data.requestUrl || args.url || '');
  if (frameId == null && !url) return null;
  return {
    frameId: frameId == null ? null : String(frameId),
    url,
  };
}

/** 提取事件里的进程/线程名（M 事件），非元数据事件返回 null。 */
function metadataOf(event) {
  if (!event || String(event.ph) !== 'M') return null;
  const name = stringOf(event.name);
  const args = event.args && typeof event.args === 'object' ? event.args : {};
  if (name === 'process_name' && args.name) return { kind: 'process', pid: Number(event.pid), name: String(args.name) };
  if (name === 'thread_name' && args.name) return { kind: 'thread', pid: Number(event.pid), tid: Number(event.tid), name: String(args.name) };
  return null;
}

function phaseOf(event) {
  return stringOf(event && (event.ph || event.phase)).trim();
}

function isCompletePhase(phase) {
  return phase === 'X';
}

/**
 * 构建 span 树。
 * options:
 *   minDurationMs  过滤掉短于该时长的 span（0 = 全部保留；过滤后 children 仍挂到最近保留祖先）
 *   maxSpans       安全上限，超出后不再新增（stats.truncated=true）
 *   includeArgs    是否携带原始 args（默认 false，输出更小）
 */
export function buildSpanTree(trace, options = {}) {
  const events = Array.isArray(trace) ? trace
    : Array.isArray(trace && trace.traceEvents) ? trace.traceEvents : [];
  const minDurationMs = Math.max(0, Number(options.minDurationMs) || 0);
  const maxSpans = Math.max(1, Number(options.maxSpans) || DEFAULT_MAX_SPANS);
  const includeArgs = options.includeArgs === true;
  const spans = [];
  const byKey = new Map(); // 内部 key（B/E 栈 / 异步组）
  const stackByThread = new Map(); // pid:tid -> [spanIndex]
  const asyncOpen = new Map(); // cat:id:id2 -> spanIndex[]
  const processes = {};
  const threads = {};
  let dropped = 0;
  let truncated = false;
  let minTs = null;
  let maxTs = null;
  let phaseCounts = {};

  const createSpan = (event) => {
    if (spans.length >= maxSpans) {
      truncated = true;
      return null;
    }
    const ts = numberOrNull(event.ts);
    const dur = numberOrNull(event.dur);
    const pid = numberOrNull(event.pid);
    const tid = numberOrNull(event.tid);
    const frame = frameOfEvent(event);
    const span = {
      id: 's' + (spans.length + 1),
      name: stringOf(event.name || '(anonymous)'),
      cat: stringOf(event.cat || ''),
      ph: phaseOf(event),
      pid,
      tid,
      ts,
      dur,
      tsMs: ts == null ? null : round(ts / US_PER_MS),
      durMs: dur == null ? null : round(dur / US_PER_MS),
      selfMs: null,
      parentId: null,
      children: [],
      depth: 0,
      frame: frame || null,
      url: frame ? frame.url : '',
      thread: tid == null ? null : (threads[pid + ':' + tid] || null),
      process: pid == null ? null : (processes[pid] || null),
      asyncGroup: null,
      ...(includeArgs && event.args !== undefined ? { args: event.args } : {}),
    };
    spans.push(span);
    if (ts != null) {
      if (minTs == null || ts < minTs) minTs = ts;
      const end = dur == null ? ts : ts + dur;
      if (maxTs == null || end > maxTs) maxTs = end;
    }
    return span;
  };

  const threadStack = (pid, tid) => {
    const key = pid + ':' + tid;
    if (!stackByThread.has(key)) stackByThread.set(key, []);
    return stackByThread.get(key);
  };

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const meta = metadataOf(event);
    if (meta) {
      if (meta.kind === 'process' && Number.isFinite(meta.pid)) processes[meta.pid] = meta.name;
      if (meta.kind === 'thread' && Number.isFinite(meta.pid) && Number.isFinite(meta.tid)) threads[meta.pid + ':' + meta.tid] = meta.name;
      continue;
    }
    const phase = phaseOf(event);
    if (!phase) continue;
    const ts = numberOrNull(event.ts);
    const pid = numberOrNull(event.pid);
    const tid = numberOrNull(event.tid);
    const stack = threadStack(pid, tid);
    const parentAtTop = () => (stack.length ? spans[stack[stack.length - 1]] : null);

    if (isCompletePhase(phase)) {
      const span = createSpan(event);
      if (!span) continue;
      if (span.dur == null) span.dur = 0;
      const parent = parentAtTop();
      if (parent) {
        span.parentId = parent.id;
        span.asyncGroup = parent.asyncGroup;
      }
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
      continue;
    }
    if (phase === 'B') {
      const span = createSpan(event);
      if (!span) continue;
      const parent = parentAtTop();
      if (parent) {
        span.parentId = parent.id;
        span.asyncGroup = parent.asyncGroup;
      }
      stack.push(spans.indexOf(span));
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
      continue;
    }
    if (phase === 'E') {
      const openIndex = stack.pop();
      if (openIndex == null) {
        dropped += 1;
        continue;
      }
      const span = spans[openIndex];
      if (span && span.dur == null && Number.isFinite(ts) && Number.isFinite(span.ts)) span.dur = Math.max(0, ts - span.ts);
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
      continue;
    }
    if (phase === 'I') {
      const span = createSpan(event);
      if (!span) continue;
      span.dur = 0;
      const parent = parentAtTop();
      if (parent) span.parentId = parent.id;
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
      continue;
    }
    if (phase === 'S') {
      const span = createSpan(event);
      if (!span) continue;
      const key = [span.cat, event.id, event.id2 == null ? '' : event.id2].join(':');
      if (!asyncOpen.has(key)) asyncOpen.set(key, []);
      asyncOpen.get(key).push(spans.indexOf(span));
      span.asyncGroup = key;
      const parent = parentAtTop();
      if (parent && parent.pid === span.pid) span.parentId = parent.id;
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
      continue;
    }
    if (phase === 'T') {
      const key = [stringOf(event.cat), event.id, event.id2 == null ? '' : event.id2].join(':');
      const group = asyncOpen.get(key);
      if (!group || !group.length) {
        dropped += 1;
        continue;
      }
      const span = spans[group[group.length - 1]];
      if (span && span.dur == null && Number.isFinite(ts) && Number.isFinite(span.ts)) span.dur = Math.max(0, ts - span.ts);
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
      continue;
    }
    if (phase === 'F') {
      const key = [stringOf(event.cat), event.id, event.id2 == null ? '' : event.id2].join(':');
      const group = asyncOpen.get(key);
      if (!group || !group.length) {
        dropped += 1;
        continue;
      }
      const span = spans[group.pop()];
      if (span && span.dur == null && Number.isFinite(ts) && Number.isFinite(span.ts)) span.dur = Math.max(0, ts - span.ts);
      if (group.length === 0) asyncOpen.delete(key);
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
      continue;
    }
    if (phase === 'b') {
      const span = createSpan(event);
      if (!span) continue;
      span.dur = 0;
      const key = [span.cat, event.id, event.id2 == null ? '' : event.id2].join(':');
      if (!asyncOpen.has(key)) asyncOpen.set(key, []);
      asyncOpen.get(key).push(spans.indexOf(span));
      span.asyncGroup = key;
      const parent = parentAtTop();
      if (parent) span.parentId = parent.id;
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
      continue;
    }
    if (phase === 'e') {
      const key = [stringOf(event.cat), event.id, event.id2 == null ? '' : event.id2].join(':');
      const group = asyncOpen.get(key);
      if (!group || !group.length) {
        dropped += 1;
        continue;
      }
      const span = spans[group.pop()];
      if (span && Number.isFinite(ts) && Number.isFinite(span.ts)) span.dur = Math.max(span.dur || 0, ts - span.ts);
      if (group.length === 0) asyncOpen.delete(key);
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
      continue;
    }
    dropped += 1;
  }
  // 未闭合的 B/S span：保留为"未完成"，dur=null，不伪造成 0 长度已完成。
  const byId = {};
  for (const span of spans) byId[span.id] = span;
  const roots = [];
  for (const span of spans) {
    if (span.parentId && byId[span.parentId]) byId[span.parentId].children.push(span.id);
    else roots.push(span.id);
  }
  for (const span of spans) {
    span.children.sort((a, b) => (byId[a].ts || 0) - (byId[b].ts || 0));
  }
  // 深度 + self time（不含子 span 的排他时间；未完成 span 的 self 视为 0）
  const visit = (id, depth) => {
    const span = byId[id];
    if (!span) return 0;
    span.depth = depth;
    let childDur = 0;
    for (const childId of span.children) childDur += visit(childId, depth + 1);
    const dur = span.dur == null ? 0 : span.dur;
    span.durMs = span.dur == null ? null : round(span.dur / US_PER_MS);
    span.selfMs = round(Math.max(0, dur - childDur) / US_PER_MS);
    return dur;
  };
  for (const rootId of roots) visit(rootId, 0);
  // minDurationMs 过滤：只影响对外列表，children/parent 关系保持。
  const includeIds = new Set();
  for (const span of spans) {
    if (minDurationMs > 0 && span.dur != null && (span.dur / US_PER_MS) < minDurationMs) continue;
    includeIds.add(span.id);
  }
  const publicSpans = [];
  for (const span of spans) {
    if (!includeIds.has(span.id)) continue;
    publicSpans.push({ ...span, children: span.children.filter((id) => includeIds.has(id)) });
  }
  const frameMap = new Map();
  for (const span of publicSpans) {
    if (!span.frame || !span.frame.frameId) continue;
    const key = span.frame.frameId;
    if (!frameMap.has(key)) frameMap.set(key, { frameId: key, url: span.frame.url || '', count: 0, totalMs: 0 });
    const record = frameMap.get(key);
    record.count += 1;
    record.totalMs = round(record.totalMs + (span.durMs || 0));
    if (!record.url && span.frame.url) record.url = span.frame.url;
  }
  const frames = [...frameMap.values()].sort((a, b) => b.totalMs - a.totalMs);
  const durationMs = minTs != null && maxTs != null ? round((maxTs - minTs) / US_PER_MS) : 0;
  return {
    events: events.length,
    spans: publicSpans,
    byId,
    roots: roots.filter((id) => includeIds.has(id)),
    frames,
    processes: Object.entries(processes).map(([pid, name]) => ({ pid: Number(pid), name })),
    threads: Object.entries(threads).map(([key, name]) => {
      const [pid, tid] = key.split(':');
      return { pid: Number(pid), tid: Number(tid), name };
    }),
    durationMs,
    minTs,
    maxTs,
    stats: {
      spans: publicSpans.length,
      dropped,
      truncated,
      unfinished: spans.filter((span) => span.dur == null).length,
      filtered: spans.length - publicSpans.length,
      phases: phaseCounts,
      asyncGroups: new Set(spans.filter((span) => span.asyncGroup && span.ph === 'S').map((span) => span.asyncGroup)).size,
    },
  };
}

function treeOf(source) {
  if (!source) return buildSpanTree(null);
  if (Array.isArray(source.spans) && typeof source.byId === 'object' && source.byId) return source;
  if (Array.isArray(source)) return buildSpanTree(source);
  if (Array.isArray(source.traceEvents)) return buildSpanTree(source);
  return buildSpanTree(source);
}

function publicSpan(span, tree) {
  const parent = span.parentId ? tree.byId[span.parentId] : null;
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
    parentName: parent ? parent.name : null,
    children: span.children.length,
    frame: span.frame,
    url: span.url,
    thread: span.thread,
    process: span.process,
    unfinished: span.dur == null,
  };
}

/**
 * 关键路径：在 span 树里找耗时最大的根→叶嵌套链。
 *   metric='self'（默认）：路径得分 = 沿链各 span 的独占时间(selfMs)之和；因为
 *     父的 self 已扣除全部子时长，求和不会重复计算父子 duration，totalMs 等于该链所在
 *     根 span 的总耗时，路径本身给出"时间花在哪条分支上"。
 *   metric='duration'：每层选 duration 最大的子 span，totalMs = 根 span 的 duration。
 * 返回 {spans:[...], totalMs, spanCount, metric, framePath}。
 */
export function criticalPath(source, options = {}) {
  const tree = treeOf(source);
  const metric = options.metric === 'duration' ? 'duration' : 'self';
  if (!tree.spans.length) return { spans: [], totalMs: 0, spanCount: 0, metric, framePath: [] };
  const weightOf = (span) => Math.max(0, Number(span.selfMs) || 0);
  let ids = [];
  let totalMs = 0;
  if (metric === 'duration') {
    const durationOf = (span) => Math.max(0, Number(span.durMs) || 0);
    let root = null;
    for (const rootId of tree.roots) {
      const span = tree.byId[rootId];
      if (!span) continue;
      if (!root || durationOf(span) > durationOf(root)) root = span;
    }
    let cursor = root;
    while (cursor) {
      ids.push(cursor.id);
      let best = null;
      for (const childId of cursor.children) {
        const child = tree.byId[childId];
        if (!child) continue;
        if (!best || durationOf(child) > durationOf(best)) best = child;
      }
      cursor = best;
    }
    totalMs = root ? durationOf(root) : 0;
  } else {
    const best = new Map();
    const score = (id) => {
      if (best.has(id)) return best.get(id);
      const span = tree.byId[id];
      if (!span) {
        best.set(id, { score: 0, path: [] });
        return best.get(id);
      }
      let bestChild = null;
      for (const childId of span.children) {
        const candidate = score(childId);
        if (!bestChild || candidate.score > bestChild.score) bestChild = candidate;
      }
      const path = [id, ...(bestChild ? bestChild.path : [])];
      const total = weightOf(span) + (bestChild ? bestChild.score : 0);
      best.set(id, { score: total, path });
      return best.get(id);
    };
    let winner = null;
    for (const rootId of tree.roots) {
      const candidate = score(rootId);
      if (!winner || candidate.score > winner.score) winner = candidate;
    }
    ids = winner ? winner.path : [];
    totalMs = winner ? winner.score : 0;
  }
  const spans = ids.map((id) => publicSpan(tree.byId[id], tree)).filter(Boolean);
  const framePath = [];
  const seenFrames = new Set();
  for (const span of spans) {
    const frameId = span.frame && span.frame.frameId;
    if (!frameId || seenFrames.has(frameId)) continue;
    seenFrames.add(frameId);
    framePath.push(frameId);
  }
  return {
    spans,
    totalMs: round(totalMs),
    spanCount: spans.length,
    metric,
    framePath,
  };
}

/**
 * 因果链：从某个 span 出发，向上收集祖先、向下收集后代（含异步组内成员）。
 * 返回 {span, ancestors, descendants, path, depth, frameIds}。
 */
export function causalChain(source, spanId) {
  const tree = treeOf(source);
  const span = tree.byId[spanId];
  if (!span) return null;
  const ancestors = [];
  let cursor = span.parentId ? tree.byId[span.parentId] : null;
  while (cursor) {
    ancestors.unshift(cursor.id);
    cursor = cursor.parentId ? tree.byId[cursor.parentId] : null;
  }
  const descendants = [];
  const walk = (id) => {
    const current = tree.byId[id];
    if (!current) return;
    for (const childId of current.children) {
      descendants.push(childId);
      walk(childId);
    }
  };
  walk(spanId);
  const asyncPeers = span.asyncGroup
    ? tree.spans.filter((item) => item.asyncGroup === span.asyncGroup && item.id !== spanId).map((item) => item.id)
    : [];
  return {
    span: publicSpan(span, tree),
    ancestors,
    descendants,
    asyncPeers,
    path: [...ancestors, span.id],
    depth: span.depth,
    frameIds: [...new Set([span, ...ancestors.map((id) => tree.byId[id])]
      .filter(Boolean)
      .map((item) => item.frame && item.frame.frameId)
      .filter(Boolean))],
  };
}

/**
 * 查询 span（过滤 + 排序 + 分页）。
 * filter: {name, nameIncludes, category, phase, frameId, urlContains, minDurationMs,
 *          maxDurationMs, processName, threadName, unfinished}
 * order:  'start' | 'duration' | 'self' | 'depth'；默认 duration
 */
export function querySpans(source, filter = {}) {
  const tree = treeOf(source);
  const options = filter && typeof filter === 'object' ? filter : {};
  const limit = Math.max(1, Math.min(Number(options.limit) || 200, 5000));
  const offset = Math.max(0, Number(options.offset) || 0);
  const order = ['start', 'duration', 'self', 'depth'].includes(options.order) ? options.order : 'duration';
  const needle = stringOf(options.name);
  const includes = stringOf(options.nameIncludes).toLowerCase();
  const category = stringOf(options.category).toLowerCase();
  const phase = stringOf(options.phase).toUpperCase();
  const frameId = options.frameId == null ? '' : String(options.frameId);
  const urlNeedle = stringOf(options.urlContains);
  const processName = stringOf(options.processName);
  const threadName = stringOf(options.threadName);
  const minDurationMs = options.minDurationMs == null ? null : Number(options.minDurationMs);
  const maxDurationMs = options.maxDurationMs == null ? null : Number(options.maxDurationMs);
  const unfinishedOnly = options.unfinished === true;
  const matched = [];
  for (const span of tree.spans) {
    if (needle && span.name !== needle) continue;
    if (includes && !span.name.toLowerCase().includes(includes)) continue;
    if (category && !String(span.cat || '').toLowerCase().includes(category)) continue;
    if (phase && String(span.ph || '').toUpperCase() !== phase) continue;
    if (frameId && !(span.frame && String(span.frame.frameId) === frameId)) continue;
    if (urlNeedle && !String(span.url || '').includes(urlNeedle)) continue;
    if (processName && !String(span.process || '').includes(processName)) continue;
    if (threadName && !String(span.thread || '').includes(threadName)) continue;
    if (unfinishedOnly && span.dur != null) continue;
    if (minDurationMs != null && Number.isFinite(minDurationMs) && (span.durMs == null || span.durMs < minDurationMs)) continue;
    if (maxDurationMs != null && Number.isFinite(maxDurationMs) && (span.durMs || 0) > maxDurationMs) continue;
    matched.push(span);
  }
  matched.sort((a, b) => {
    if (order === 'start') return (a.ts || 0) - (b.ts || 0);
    if (order === 'self') return (b.selfMs || 0) - (a.selfMs || 0);
    if (order === 'depth') return b.depth - a.depth;
    return (b.durMs || 0) - (a.durMs || 0);
  });
  const page = matched.slice(offset, offset + limit).map((span) => publicSpan(span, tree));
  return {
    spans: page,
    total: matched.length,
    offset,
    limit,
    hasMore: offset + page.length < matched.length,
    nextOffset: offset + page.length < matched.length ? offset + page.length : null,
    truncated: matched.length > page.length,
    scanned: tree.spans.length,
  };
}

/** span 摘要：分布、Top、关键路径、跨 frame。 */
export function summarizeSpans(source, options = {}) {
  const tree = treeOf(source);
  const top = Math.max(1, Math.min(Number(options.top) || 10, 100));
  const byName = new Map();
  const byCategory = new Map();
  const byPhase = new Map();
  const byFrame = new Map();
  let selfTotal = 0;
  for (const span of tree.spans) {
    selfTotal += Number(span.selfMs) || 0;
    const name = span.name;
    const category = span.cat || '(none)';
    const phase = span.ph || '?';
    const frameKey = span.frame && span.frame.frameId ? String(span.frame.frameId) : '(none)';
    for (const [map, key] of [[byName, name], [byCategory, category], [byPhase, phase], [byFrame, frameKey]]) {
      if (!map.has(key)) map.set(key, { key, count: 0, totalMs: 0, selfMs: 0 });
      const record = map.get(key);
      record.count += 1;
      record.totalMs = round(record.totalMs + (Number(span.durMs) || 0));
      record.selfMs = round(record.selfMs + (Number(span.selfMs) || 0));
    }
  }
  const topOf = (map) => [...map.values()].sort((a, b) => b.selfMs - a.selfMs || b.count - a.count).slice(0, top);
  const longest = tree.spans.slice().sort((a, b) => (b.durMs || 0) - (a.durMs || 0)).slice(0, top)
    .map((span) => publicSpan(span, tree));
  const path = criticalPath(tree, { metric: options.metric });
  return {
    events: tree.events,
    spans: tree.stats.spans,
    roots: tree.roots.length,
    durationMs: tree.durationMs,
    unfinished: tree.stats.unfinished,
    truncated: tree.stats.truncated,
    dropped: tree.stats.dropped,
    selfTotalMs: round(selfTotal),
    byName: topOf(byName),
    byCategory: topOf(byCategory),
    byPhase: topOf(byPhase),
    byFrame: topOf(byFrame),
    topSpans: longest,
    criticalPath: {
      totalMs: path.totalMs,
      spanCount: path.spanCount,
      metric: path.metric,
      framePath: path.framePath,
      path: path.spans.map((span) => ({ name: span.name, cat: span.cat, durMs: span.durMs, selfMs: span.selfMs, frame: span.frame })),
    },
    processCount: tree.processes.length,
    threadCount: tree.threads.length,
  };
}
