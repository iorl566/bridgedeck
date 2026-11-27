// lib/trace-viewer.mjs —— 把 Trace v3 渲染成离线、零依赖的 HTML 查看器。
//
// 目标是对标通用 trace viewer 的轻量离线版：步骤时间线、目标、填写/选择值、
// before/after 状态文本、搜索过滤；W3-A 追加跨 frame 归属、因果链、span 关键路径与
// span 表（数据来自 lib/trace-spans.mjs / trace-v3.mjs 的 depth 字段）。
// 不依赖网络、不内嵌外部资源（Trace v3 截图是步骤内的 data:image）。所有动态内容都经过
// HTML 转义，trace 里的页面文本不能变成脚本。
//
// W5-B 深度扩展（全部是加法能力，旧字段/旧类名保持不变）：
//   * span 树：按 parentId 还原父子关系（parent 缺失时按 depth 回退缩进），
//     逐行缩进渲染 + 分页；
//   * 关键路径：self 占比条 + 瓶颈高亮 + 口径说明；
//   * 因果链：显式/推断分组、节点解析到具体步骤（点击锚点回链）、分页；
//   * 分页：span 树 / 网络 / 因果链按页切片，纯前端翻页，离线文件可用；
//   * 大数据保护：文本截断、行数上限、单张截图体积上限、HTML 字节上限，
//     超限时先降级渲染、仍超限则输出最小摘要页（仍带完整转义与计数）。
import { buildSpanTree, summarizeSpans, querySpans } from './trace-spans.mjs';

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const MAX_INDENT_DEPTH = 32;
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,/i;

/** HTML 转义（文本与属性共用）。 */
export function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ESCAPE_MAP[character]);
}

function text(value) {
  return escapeHtml(value);
}

/** 把任意 JSON 值压成可读字符串（不抛错、不产生 [object Object]）。 */
function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return String(value);
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? fallback : encoded;
  } catch {
    return fallback;
  }
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function isDataImage(value) {
  return typeof value === 'string' && DATA_IMAGE.test(value);
}

function byteLength(value) {
  // 不依赖 Buffer：CLI/测试/浏览器同构可用。
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(value)).length;
  return String(value).length * 2;
}

/**
 * 查看器默认上限（可被 options.limits 单点覆盖）。
 * 这些数字不是“展示参数”，而是防 OOM/防超大 HTML 的硬保护：超限时降级并显式标注。
 */
export const VIEWER_LIMITS = Object.freeze({
  steps: 500,
  network: 300,
  screenshots: 20,
  screenshotBytes: 2 * 1024 * 1024,
  spanRows: 2000,
  spanPageSize: 100,
  causalChains: 100,
  causalNodes: 64,
  causalPageSize: 25,
  networkPageSize: 100,
  stateBodyChars: 4000,
  stepValueChars: 500,
  labelChars: 200,
  urlChars: 1000,
  maxHtmlBytes: 6 * 1024 * 1024,
});

/** HTML 字节超限后的第二轮上限（仍超限才走最小页）。 */
const RELAXED_LIMITS = Object.freeze({
  steps: 80,
  network: 40,
  screenshots: 4,
  screenshotBytes: 500 * 1024,
  spanRows: 200,
  spanPageSize: 50,
  causalChains: 20,
  causalNodes: 16,
  causalPageSize: 10,
  networkPageSize: 40,
  stateBodyChars: 800,
  stepValueChars: 200,
  labelChars: 120,
  urlChars: 300,
  maxHtmlBytes: VIEWER_LIMITS.maxHtmlBytes,
});

function resolveLimits(overrides) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  const merged = { ...VIEWER_LIMITS };
  for (const key of Object.keys(VIEWER_LIMITS)) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value > 0) merged[key] = Math.floor(value);
  }
  return merged;
}

/** 文本截断（保留长度证据，不在 HTML 里塞超长原文）。 */
export function truncateText(value, max = VIEWER_LIMITS.stateBodyChars) {
  const source = safeString(value);
  const limit = Math.max(0, Math.floor(numberOr(max, VIEWER_LIMITS.stateBodyChars)));
  if (limit <= 0 || source.length <= limit) return source;
  return source.slice(0, limit) + '…（已截断，共 ' + source.length + ' 字符）';
}

/** 安全百分比：非法/负值归零，封顶 100，保留 1 位小数。 */
export function sharePercent(value, total) {
  const numerator = numberOr(value, 0);
  const denominator = numberOr(total, 0);
  if (!(numerator > 0) || !(denominator > 0)) return 0;
  return Math.min(100, Math.round((numerator / denominator) * 1000) / 10);
}

/** 通用分页切片（纯函数；viewer 用它算页码，CLI/测试也可复用）。 */
export function paginate(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const pageSize = Math.max(1, Math.floor(numberOr(options.pageSize, VIEWER_LIMITS.spanPageSize)));
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(numberOr(options.page, 1))));
  const offset = (page - 1) * pageSize;
  const pageItems = list.slice(offset, offset + pageSize);
  return {
    items: pageItems,
    page,
    pageSize,
    pageCount,
    total: list.length,
    offset,
    hasPrev: page > 1,
    hasNext: page < pageCount,
  };
}

function pageOfRow(index, pageSize) {
  return Math.floor(index / Math.max(1, pageSize)) + 1;
}

function renderPager(kind, pageCount, options = {}) {
  if (!(pageCount > 1)) return '';
  const label = safeString(options.label, '页');
  return `<nav class="pager" data-pager="${escapeHtml(kind)}" data-pages="${pageCount}">
      <button type="button" data-page-prev disabled>上一页</button>
      <span class="page-label">第 <b data-page-current>1</b> / ${pageCount} ${text(label)}</span>
      <button type="button" data-page-next>下一页</button>
    </nav>`;
}

function budgetOf(total, limit) {
  const normalizedTotal = Math.max(0, Math.floor(numberOr(total, 0)));
  const normalizedLimit = Math.max(1, Math.floor(numberOr(limit, 1)));
  return {
    total: normalizedTotal,
    rendered: Math.min(normalizedTotal, normalizedLimit),
    omitted: Math.max(0, normalizedTotal - normalizedLimit),
  };
}

function validScreenshots(trace) {
  return arrayOf(trace && trace.screenshots).filter((item) => item && isDataImage(item.dataUrl));
}

function spanContextOf(trace) {
  if (trace.spanSummary && typeof trace.spanSummary === 'object') {
    return { summary: trace.spanSummary, spans: arrayOf(trace.spans) };
  }
  if (arrayOf(trace.spans).length) return { summary: null, spans: trace.spans };
  const events = arrayOf(trace.traceEvents);
  if (!events.length) return null;
  const tree = buildSpanTree({ traceEvents: events }, { maxSpans: 8000 });
  return {
    summary: summarizeSpans(tree, { top: 10 }),
    spans: querySpans(tree, { order: 'duration', limit: 50 }).spans,
  };
}

/**
 * 计算本次渲染的预算（消费上限/省略数/页数）。不渲染 HTML，便于 CLI 先做 JSON 预检。
 * @returns {object} 每类内容的 {total, rendered, omitted} 与页数、是否截断。
 */
export function planViewerBudget(trace, options = {}) {
  const limits = resolveLimits(options.limits);
  const source = trace && typeof trace === 'object' ? trace : {};
  const spanContext = options.spanContext === undefined ? spanContextOf(source) : options.spanContext;
  const spanRows = spanContext ? arrayOf(spanContext.spans) : [];
  const spans = budgetOf(spanRows.length, limits.spanRows);
  const spanPages = Math.max(1, Math.ceil(spans.rendered / limits.spanPageSize));
  const steps = budgetOf(arrayOf(source.steps).length, limits.steps);
  const network = budgetOf(arrayOf(source.network).length, limits.network);
  const screenshots = budgetOf(validScreenshots(source).length, limits.screenshots);
  const causal = budgetOf(arrayOf(source.causalChains).length, limits.causalChains);
  const causalPages = Math.max(1, Math.ceil(Math.min(causal.rendered, limits.causalChains) / limits.causalPageSize));
  const networkPages = Math.max(1, Math.ceil(network.rendered / limits.networkPageSize));
  return {
    limits,
    steps,
    network,
    networkPages,
    screenshots,
    spans,
    spanPages,
    causalChains: causal,
    causalPages,
    truncated: [steps, network, screenshots, spans, causal].some((item) => item.omitted > 0),
  };
}

function stateById(states) {
  const map = new Map();
  for (const state of arrayOf(states)) {
    if (state && typeof state.id === 'string') map.set(state.id, state);
  }
  return map;
}

function targetLabel(step) {
  const target = step && step.target ? step.target : {};
  return safeString(target.name || target.role || target.ref || target.ctx, '(未知目标)');
}

function targetDetail(step) {
  const target = step && step.target ? step.target : {};
  const parts = [];
  if (target.ref) parts.push('ref=' + safeString(target.ref));
  if (target.role) parts.push('role=' + safeString(target.role));
  if (target.ctx) parts.push('ctx=' + safeString(target.ctx));
  return parts.join(' · ');
}

/** ISO 时间 → HH:MM:SS.mmm（无法解析时返回空串）。 */
export function timeLabel(value) {
  const source = String(value || '');
  const match = /T(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/.exec(source);
  if (match) return match[1];
  const ms = Date.parse(source);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 23) : '';
}

function stepAnchor(step, index) {
  const raw = step && step.id !== undefined && step.id !== null ? safeString(step.id) : String(index + 1);
  return 'step-' + raw.replace(/[^\w.-]+/g, '_');
}

function renderNetwork(trace, budget) {
  const network = arrayOf(trace.network);
  if (network.length === 0) return '';
  const limits = budget.limits;
  const rows = network.slice(0, limits.network).map((item, index) => {
    const status = item && item.status != null ? safeString(item.status) : '—';
    return `<tr data-row-page="${pageOfRow(index, limits.networkPageSize)}">
      <td class="num">${index + 1}</td>
      <td class="time">${text(timeLabel(item && item.at))}</td>
      <td><span class="method">${text(safeString(item && item.method))}</span></td>
      <td class="status">${text(status)}</td>
      <td class="url" title="${escapeHtml(truncateText(item && item.url, limits.urlChars))}">${text(truncateText(item && item.url, limits.urlChars))}</td>
      <td class="type">${text(safeString(item && item.type))}</td>
    </tr>`;
  }).join('');
  const omitted = `<p class="guard">网络请求共 ${budget.network.total} 条，已渲染前 ${budget.network.rendered} 条。</p>`;
  return `<section class="network page-group" data-page-size="${limits.networkPageSize}">
    <h2>网络请求 <span class="count">${network.length}</span></h2>
    ${budget.network.omitted > 0 ? omitted : ''}
    ${renderPager('network', budget.networkPages, { label: '页' })}
    <table>
      <thead><tr><th>#</th><th>时间</th><th>方法</th><th>状态</th><th>URL</th><th>类型</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function stateBlock(id, states, limits) {
  const state = states.get(id);
  if (!state) return '';
  const body = truncateText(state.body, limits.stateBodyChars);
  const empty = body ? '' : '(空)';
  return `
      <details class="state">
        <summary>状态 ${text(id)}${state.at ? '<span class="time">' + text(timeLabel(state.at)) + '</span>' : ''}${state.title ? ' · ' + text(truncateText(state.title, limits.labelChars)) : ''}</summary>
        <div class="state-url">${text(truncateText(state.url, limits.urlChars))}</div>
        <pre>${empty ? empty : text(body)}</pre>
      </details>`;
}

function stepValue(step, limits) {
  if (step.redacted === true) return '<span class="redacted">•••（敏感值已脱敏）</span>';
  if (Array.isArray(step.selection) && step.selection.length) {
    return '<div class="value">选择：' + step.selection
      .map((item) => text(truncateText(item && (item.label || item.value), limits.stepValueChars)))
      .join('、') + '</div>';
  }
  if (step.value !== undefined) {
    return '<div class="value">值：<code>' + text(truncateText(step.value, limits.stepValueChars)) + '</code></div>';
  }
  return '';
}

function stepRequests(step, context) {
  const network = arrayOf(context.network);
  const start = Date.parse(step.at || '');
  if (!Number.isFinite(start) || network.length === 0) return [];
  const next = Number.isFinite(context.nextAt) ? context.nextAt : context.recordedAt;
  const end = Number.isFinite(next) && next > start ? next : start + 60000;
  return network.filter((item) => {
    const at = Date.parse(item && item.at);
    return Number.isFinite(at) && at >= start && at < end;
  });
}

function causeBadges(step) {
  const causes = Array.isArray(step.causedBy) ? step.causedBy : [];
  return causes.slice(0, 8).map((id) => {
    const anchor = 'step-' + safeString(id).replace(/[^\w.-]+/g, '_');
    return '<a class="badge badge-cause" href="#' + escapeHtml(anchor) + '" data-cause="' + escapeHtml(id) + '">caused by #' + text(id) + '</a>';
  }).join(' ');
}

function renderStep(step, index, states, context = {}) {
  const limits = context.limits || VIEWER_LIMITS;
  const op = safeString(step.op, 'step');
  const label = truncateText(targetLabel(step), limits.labelChars);
  const detail = truncateText(targetDetail(step), limits.urlChars);
  const search = [op, label, detail, step.redacted === true ? 'redacted' : safeString(step.value), safeString(step.commit)]
    .filter(Boolean).join(' ').toLowerCase();
  const badges = [];
  if (Number(step.frameId) > 0) badges.push('frame ' + Number(step.frameId));
  if (step.commit) badges.push('commit ' + safeString(step.commit));
  if (step.redacted === true) badges.push('redacted');
  const requests = stepRequests(step, context);
  const requestSummary = requests.length
    ? '<div class="step-net">' + text(requests.length) + ' 个请求 · ' + requests.slice(0, 3)
      .map((item) => text(safeString(item.method) + ' ' + (item.status == null ? '—' : item.status)))
      .join(' · ') + '</div>'
    : '';
  let screenshot = '';
  if (typeof step.screenshot === 'string' && DATA_IMAGE.test(step.screenshot)) {
    const size = byteLength(step.screenshot);
    screenshot = size > limits.screenshotBytes
      ? '<div class="guard">步骤截图过大（' + Math.round(size / 1024) + 'KB），已省略。</div>'
      : '<img class="step-shot" src="' + escapeHtml(step.screenshot) + '" alt="步骤截图" loading="lazy">';
  }
  return `
    <article class="step" id="${escapeHtml(stepAnchor(step, index))}" data-search="${escapeHtml(search)}" data-op="${escapeHtml(op)}">
      <header>
        <span class="index">${index + 1}</span>
        <span class="op op-${escapeHtml(op)}">${text(op)}</span>
        <span class="target">${text(label)}</span>
        ${step.at ? '<span class="time">' + text(timeLabel(step.at)) + '</span>' : ''}
        ${badges.map((badge) => '<span class="badge">' + text(badge) + '</span>').join('')}
        ${causeBadges(step)}
      </header>
      ${detail ? '<div class="detail">' + text(detail) + '</div>' : ''}
      ${stepValue(step, limits)}
      ${screenshot}
      ${requestSummary}
      ${stateBlock(step.state, states, limits)}
      ${step.result && step.result.state && step.result.state !== step.state ? stateBlock(step.result.state, states, limits) : ''}
    </article>`;
}

function renderSteps(trace, states, budget, recordedAt) {
  const steps = arrayOf(trace.steps);
  const limits = budget.limits;
  const network = arrayOf(trace.network);
  if (steps.length === 0) return '<p class="empty">这个 trace 没有可回放步骤。</p>';
  const rendered = steps.slice(0, limits.steps).map((step, index) => renderStep(step, index, states, {
    limits,
    network,
    nextAt: index + 1 < steps.length ? Date.parse(steps[index + 1].at || '') : recordedAt,
    recordedAt,
  })).join('\n');
  if (budget.steps.omitted === 0) return rendered;
  return rendered + '\n<p class="guard">步骤共 ' + budget.steps.total + ' 步，已渲染前 ' + budget.steps.rendered + ' 步（剩余 ' + budget.steps.omitted + ' 步未渲染）。</p>';
}

// ---------------------------------------------------------------------------
// span 树
// ---------------------------------------------------------------------------

function spanIdOf(span) {
  return safeString(span && span.id);
}

/**
 * 把扁平 spans 还原成森林（父在、子不在或成环时按 depth 回退缩进）。
 * 返回按先序遍历展开的行：{span, depth, childCount}。
 */
export function buildSpanView(spans) {
  const list = arrayOf(spans).filter((span) => span && typeof span === 'object');
  const byId = new Map();
  const order = [];
  for (const span of list) {
    const id = spanIdOf(span);
    if (!id || byId.has(id)) continue;
    byId.set(id, span);
    order.push(span);
  }
  const parentOf = new Map();
  for (const span of order) {
    const id = spanIdOf(span);
    const parentId = span.parentId === undefined || span.parentId === null ? '' : safeString(span.parentId);
    if (!parentId || parentId === id || !byId.has(parentId)) continue;
    // 成环保护：沿 parent 链向上走，遇到自己就放弃这条父边。
    const seen = new Set([id]);
    let cursor = byId.get(parentId);
    let cycle = false;
    while (cursor) {
      const cursorId = spanIdOf(cursor);
      if (seen.has(cursorId)) { cycle = true; break; }
      seen.add(cursorId);
      const nextId = cursor.parentId === undefined || cursor.parentId === null ? '' : safeString(cursor.parentId);
      cursor = nextId && byId.has(nextId) ? byId.get(nextId) : null;
    }
    if (!cycle) parentOf.set(id, parentId);
  }
  const children = new Map();
  const roots = [];
  for (const span of order) {
    const id = spanIdOf(span);
    const parentId = parentOf.get(id);
    if (parentId) {
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(id);
    } else {
      roots.push(id);
    }
  }
  const startOf = (span) => numberOr(span.tsMs, numberOr(span.ts, 0));
  const sortIds = (ids) => ids.slice().sort((left, right) => {
    const a = byId.get(left);
    const b = byId.get(right);
    const delta = startOf(a) - startOf(b);
    if (delta !== 0) return delta;
    return numberOr(b && b.durMs, 0) - numberOr(a && a.durMs, 0);
  });
  for (const [parentId, ids] of children.entries()) children.set(parentId, sortIds(ids));
  const rows = [];
  const visited = new Set();
  const visit = (id, depth) => {
    if (visited.has(id) || depth > MAX_INDENT_DEPTH) return;
    visited.add(id);
    const span = byId.get(id);
    const childIds = (children.get(id) || []).filter((childId) => !visited.has(childId));
    rows.push({ span, depth, childCount: (children.get(id) || []).length });
    for (const childId of childIds) visit(childId, depth + 1);
  };
  for (const rootId of sortIds(roots)) visit(rootId, 0);
  // 未被遍历到的（成环/重复 id 的边缘情况）按原顺序补在根层，保证一条都不丢。
  for (const span of order) {
    const id = spanIdOf(span);
    if (visited.has(id)) continue;
    visited.add(id);
    const fallbackDepth = Math.max(0, Math.min(MAX_INDENT_DEPTH, Math.floor(numberOr(span.depth, 0))));
    rows.push({ span, depth: fallbackDepth, childCount: 0 });
  }
  return { rows, roots: roots.length, total: order.length };
}

function renderSpanTreeRows(spanView, budget) {
  const limits = budget.limits;
  const rows = spanView.rows.slice(0, limits.spanRows);
  const tr = rows.map((entry, index) => {
    const span = entry.span;
    const depth = Math.max(0, Math.min(MAX_INDENT_DEPTH, entry.depth));
    const frameId = span.frame && span.frame.frameId != null ? safeString(span.frame.frameId) : '';
    const name = truncateText(span.name, limits.labelChars);
    const indent = '<span class="tree-indent" aria-hidden="true">' + (depth > 0 ? '<span class="tree-branch"></span>'.repeat(depth) : '') + '</span>';
    return `<tr data-row-page="${pageOfRow(index, limits.spanPageSize)}" data-depth="${depth}"${entry.childCount > 0 ? ' class="has-children"' : ''}>
      <td class="span-name">${indent}${entry.childCount > 0 ? '<span class="tree-toggle" aria-hidden="true">▾</span>' : '<span class="tree-toggle tree-leaf">·</span>'}${text(name)}</td>
      <td class="type">${text(span.cat)}</td>
      <td class="num">${text(span.durMs == null ? '—' : span.durMs)}</td>
      <td class="num">${text(span.selfMs == null ? '—' : span.selfMs)}</td>
      <td>${text(frameId)}</td>
    </tr>`;
  }).join('');
  const spanPages = Math.max(1, Math.ceil(rows.length / limits.spanPageSize));
  const omitted = budget.spans.omitted > 0
    ? '<p class="guard">span 共 ' + budget.spans.total + ' 条，已渲染前 ' + budget.spans.rendered + ' 条（分页只覆盖已渲染部分）。</p>'
    : '';
  if (!rows.length) return '<p class="empty">这个 trace 没有 span 数据。</p>';
  return `${omitted}
    ${renderPager('spans', spanPages, { label: '页' })}
    <table class="span-tree">
      <thead><tr><th>span（按父子缩进）</th><th>category</th><th>dur(ms)</th><th>self(ms)</th><th>frame</th></tr></thead>
      <tbody>${tr}</tbody>
    </table>`;
}

function renderCriticalPath(summary, budget) {
  const path = summary && summary.criticalPath && Array.isArray(summary.criticalPath.path) ? summary.criticalPath.path : [];
  if (!path.length) return '';
  const limits = budget.limits;
  const totalMs = numberOr(summary.criticalPath.totalMs, 0);
  const items = path.slice(0, limits.spanRows).map((item) => {
    const selfMs = numberOr(item.selfMs, 0);
    const share = sharePercent(selfMs, totalMs);
    const frame = item.frame && item.frame.frameId != null ? safeString(item.frame.frameId) : '';
    return `<li>
          <span class="cp-bar" style="width:${share}%"></span>
          <code>${text(truncateText(item.name, limits.labelChars))}</code>
          <span class="time">${text(item.durMs == null ? '—' : item.durMs)}ms</span>
          <span class="badge">self ${text(item.selfMs == null ? 0 : item.selfMs)}ms · ${share}%</span>
          ${frame ? '<span class="badge">frame ' + text(frame) + '</span>' : ''}
        </li>`;
  }).join('');
  let bottleneck = null;
  for (const item of path) {
    const selfMs = numberOr(item.selfMs, 0);
    if (!bottleneck || selfMs > numberOr(bottleneck.selfMs, 0)) bottleneck = item;
  }
  const bottleneckHtml = bottleneck
    ? `<p class="cp-bottleneck">瓶颈：<code>${text(truncateText(bottleneck.name, limits.labelChars))}</code>（self ${numberOr(bottleneck.selfMs, 0)}ms，占 ${sharePercent(numberOr(bottleneck.selfMs, 0), totalMs)}%）</p>`
    : '';
  return `<div class="critical-path">
        <h3>关键路径 <span class="count">${text(totalMs)}ms · ${path.length} spans</span></h3>
        <p class="cp-metric">口径：${text(summary.criticalPath.metric || 'self')} time 链；bar 宽度 = 该 span 的 self 占比。</p>
        ${bottleneckHtml}
        <ol>${items}</ol>
      </div>`;
}

function renderSpans(spanContext, budget) {
  if (!spanContext) return '';
  const summary = spanContext.summary;
  const spanView = buildSpanView(arrayOf(spanContext.spans));
  const meta = summary
    ? `<div class="meta"><span><b>span</b> ${text(summary.spans)}</span><span><b>根</b> ${text(summary.roots)}</span><span><b>未完成</b> ${text(summary.unfinished)}</span><span><b>截断</b> ${summary.truncated ? '是' : '否'}</span><span><b>self 合计</b> ${text(summary.selfTotalMs)}ms</span>${summary.dropped ? '<span><b>丢弃</b> ' + text(summary.dropped) + '</span>' : ''}</div>`
    : '';
  return `<section class="spans page-group" data-page-size="${budget.limits.spanPageSize}">
    <h2>Span / 关键路径 <span class="count">${spanView.total}</span></h2>
    ${meta}
    ${renderCriticalPath(summary, budget)}
    ${renderSpanTreeRows(spanView, budget)}
  </section>`;
}

// ---------------------------------------------------------------------------
// 跨 frame / 因果链
// ---------------------------------------------------------------------------

function renderFrames(trace, spanContext) {
  const registry = arrayOf(trace.frames).length ? trace.frames : arrayOf(trace.entry && trace.entry.frames);
  let byFrame = spanContext && spanContext.summary && Array.isArray(spanContext.summary.byFrame)
    ? spanContext.summary.byFrame : [];
  if (byFrame.length === 0 && spanContext && Array.isArray(spanContext.spans)) {
    const aggregate = new Map();
    for (const span of spanContext.spans) {
      const frameId = span && span.frame && span.frame.frameId;
      if (!frameId) continue;
      if (!aggregate.has(String(frameId))) aggregate.set(String(frameId), { key: String(frameId), count: 0, selfMs: 0 });
      const record = aggregate.get(String(frameId));
      record.count += 1;
      record.selfMs = Math.round((record.selfMs + numberOr(span.selfMs, 0)) * 100) / 100;
    }
    byFrame = [...aggregate.values()];
  }
  if (registry.length === 0 && byFrame.length === 0) return '';
  const rows = [];
  const seen = new Set();
  for (const frame of registry) {
    const frameId = frame && frame.frameId != null ? String(frame.frameId) : '';
    if (!frameId || seen.has(frameId)) continue;
    seen.add(frameId);
    const stats = byFrame.find((item) => String(item.key) === frameId) || null;
    const depth = Math.max(0, Math.min(MAX_INDENT_DEPTH, Math.floor(numberOr(frame.depth, 0))));
    rows.push(`<tr>
      <td class="num">${text(frameId)}</td>
      <td>${depth > 0 ? '<span class="tree-indent">' + '<span class="tree-branch"></span>'.repeat(depth) + '</span>' : ''}${text(frame.depth == null ? '' : 'depth ' + frame.depth)}</td>
      <td class="url">${text(truncateText(frame.url, VIEWER_LIMITS.urlChars))}</td>
      <td class="num">${text(frame.stepCount == null ? '' : frame.stepCount)}</td>
      <td class="num">${stats ? text(stats.count) : '0'}</td>
      <td class="num">${stats ? text(stats.selfMs) + 'ms' : '—'}</td>
    </tr>`);
  }
  for (const stats of byFrame) {
    const frameId = String(stats.key);
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    rows.push(`<tr>
      <td class="num">${text(frameId)}</td>
      <td></td>
      <td class="url"></td>
      <td class="num"></td>
      <td class="num">${text(stats.count)}</td>
      <td class="num">${text(stats.selfMs)}ms</td>
    </tr>`);
  }
  return `<section class="frames">
    <h2>跨 frame 归属 <span class="count">${rows.length}</span></h2>
    <table>
      <thead><tr><th>frameId</th><th>深度</th><th>URL</th><th>步骤</th><th>span 数</th><th>self 时间</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  </section>`;
}

function stepLookup(trace) {
  const map = new Map();
  for (const step of arrayOf(trace.steps)) {
    if (step && step.id !== undefined && step.id !== null) map.set(safeString(step.id), step);
  }
  return map;
}

function chainAnchor(id) {
  return 'step-' + safeString(id).replace(/[^\w.-]+/g, '_');
}

/** 链条节点保持 `<code>#1</code> → <code>#2</code>` 的朴素序列（文本匹配稳定），跳转另置。 */
function chainNode(id) {
  return '<code>#' + text(id) + '</code>';
}

function chainLinks(ids) {
  if (!ids.length) return '';
  return '<span class="chain-links">跳转：' + ids.slice(0, 16)
    .map((id) => '<a href="#' + escapeHtml(chainAnchor(id)) + '">#' + text(id) + '</a>')
    .join(' ') + '</span>';
}

function renderCausalChains(trace, budget) {
  const chains = arrayOf(trace.causalChains);
  if (chains.length === 0) return '';
  const limits = budget.limits;
  const steps = stepLookup(trace);
  const explicit = chains.filter((chain) => chain && chain.inferred !== true).length;
  const inferred = chains.length - explicit;
  const items = chains.slice(0, limits.causalChains).map((chain, index) => {
    const chainSteps = arrayOf(chain && chain.steps);
    const shown = chainSteps.slice(0, limits.causalNodes);
    const nodes = shown.map(chainNode).join(' → ');
    const more = chainSteps.length > shown.length ? ' <span class="badge">+' + (chainSteps.length - shown.length) + '</span>' : '';    const detail = shown.map((id) => {
      const step = steps.get(safeString(id));
      if (!step) return '<li><code>#' + text(id) + '</code> <span class="detail">（trace 里没有该步骤）</span></li>';
      return '<li><code>#' + text(id) + '</code> ' + text(safeString(step.op)) + ' ' + text(truncateText(targetLabel(step), limits.labelChars)) + '</li>';
    }).join('');
    return `<li class="${chain && chain.inferred === true ? 'inferred' : 'explicit'}" data-row-page="${pageOfRow(index, limits.causalPageSize)}">
      <span class="badge">${chain && chain.inferred === true ? 'inferred' : 'explicit'}</span>
      <span class="chain-nodes">${nodes}${more}</span>
      ${chainLinks(shown)}
      ${chain && chain.reason ? '<span class="detail">' + text(truncateText(chain.reason, limits.stepValueChars)) + '</span>' : ''}
      ${detail ? '<details class="chain-detail"><summary>解析步骤</summary><ol>' + detail + '</ol></details>' : ''}
    </li>`;
  }).join('');
  const omitted = budget.causalChains.omitted > 0
    ? '<p class="guard">因果链共 ' + budget.causalChains.total + ' 条，已渲染前 ' + budget.causalChains.rendered + ' 条。</p>'
    : '';
  return `<section class="causal page-group" data-page-size="${limits.causalPageSize}">
    <h2>因果链 <span class="count">${chains.length}</span> <span class="badge">explicit ${explicit}</span> <span class="badge">inferred ${inferred}</span></h2>
    ${omitted}
    ${renderPager('causal', budget.causalPages, { label: '页' })}
    <ul>${items}</ul>
  </section>`;
}

function renderScreenshots(trace, budget) {
  const items = validScreenshots(trace).slice(0, budget.limits.screenshots);
  if (items.length === 0) return '';
  const limits = budget.limits;
  const figures = items.map((item, index) => {
    const size = byteLength(item.dataUrl);
    const dimensions = Number(item.width) > 0 && Number(item.height) > 0 ? ' · ' + text(item.width) + '×' + text(item.height) : '';
    const image = size > limits.screenshotBytes
      ? '<div class="guard">截图过大（' + Math.round(size / 1024) + 'KB），已省略。</div>'
      : '<img src="' + escapeHtml(item.dataUrl) + '" alt="' + escapeHtml(item.label || '截图') + '" loading="lazy">';
    return `<figure data-row-page="${pageOfRow(index, limits.networkPageSize)}">
      ${image}
      <figcaption>${text(truncateText(item.label || '截图', limits.labelChars))}${item.at ? ' · ' + text(timeLabel(item.at)) : ''}${dimensions}</figcaption>
    </figure>`;
  }).join('');
  const omitted = budget.screenshots.omitted > 0
    ? '<p class="guard">截图共 ' + budget.screenshots.total + ' 张，已渲染前 ' + budget.screenshots.rendered + ' 张。</p>'
    : '';
  return `<section class="screens page-group" data-page-size="${limits.networkPageSize}">
    <h2>截图 <span class="count">${validScreenshots(trace).length}</span></h2>
    ${omitted}
    ${figures}
  </section>`;
}

// ---------------------------------------------------------------------------
// 文档骨架 / 客户端分页脚本
// ---------------------------------------------------------------------------

const CLIENT_SCRIPT = `(function () {
  var input = document.getElementById('q');
  var count = document.getElementById('count');
  var steps = Array.prototype.slice.call(document.querySelectorAll('article.step'));
  function applySearch() {
    var q = input ? input.value.trim().toLowerCase() : '';
    var shown = 0;
    steps.forEach(function (step) {
      var hit = !q || (step.getAttribute('data-search') || '').indexOf(q) !== -1;
      step.hidden = !hit;
      if (hit) shown += 1;
    });
    if (count) count.textContent = shown + ' / ' + steps.length;
  }
  if (input) input.addEventListener('input', applySearch);
  applySearch();
  function setupPager(group) {
    var rows = Array.prototype.slice.call(group.querySelectorAll('[data-row-page]'));
    if (!rows.length) return;
    var nav = group.querySelector('[data-pager]');
    if (!nav) return;
    var total = Number(nav.getAttribute('data-pages')) || 1;
    var page = 1;
    function paint() {
      rows.forEach(function (row) {
        row.hidden = Number(row.getAttribute('data-row-page')) !== page;
      });
      var current = nav.querySelector('[data-page-current]');
      if (current) current.textContent = String(page);
      var prev = nav.querySelector('[data-page-prev]');
      var next = nav.querySelector('[data-page-next]');
      if (prev) prev.disabled = page <= 1;
      if (next) next.disabled = page >= total;
    }
    var prev = nav.querySelector('[data-page-prev]');
    var next = nav.querySelector('[data-page-next]');
    if (prev) prev.addEventListener('click', function () { if (page > 1) { page -= 1; paint(); } });
    if (next) next.addEventListener('click', function () { if (page < total) { page += 1; paint(); } });
    paint();
  }
  Array.prototype.slice.call(document.querySelectorAll('.page-group')).forEach(setupPager);
})();`;

function styleSheet() {
  return `
  :root { color-scheme: light; --bg:#f6f7fb; --panel:#fff; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --accent:#2f6fed; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
  header.top { position:sticky; top:0; z-index:2; background:rgba(255,255,255,.94); backdrop-filter:blur(8px); border-bottom:1px solid var(--line); padding:16px 24px; }
  h1 { margin:0 0 6px; font-size:18px; }
  .meta { display:flex; flex-wrap:wrap; gap:6px 18px; color:var(--muted); font-size:12px; }
  .meta b { color:var(--ink); font-weight:600; }
  .toolbar { display:flex; gap:10px; align-items:center; margin-top:12px; }
  .toolbar input { flex:1; max-width:420px; padding:8px 12px; border:1px solid var(--line); border-radius:8px; font:inherit; }
  .toolbar .count { color:var(--muted); font-size:12px; }
  main { max-width:1100px; margin:0 auto; padding:20px 24px 64px; }
  .step { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin:0 0 12px; box-shadow:0 1px 2px rgba(15,23,42,.04); }
  .step header { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .index { width:26px; height:26px; border-radius:50%; background:#eef2ff; color:var(--accent); display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
  .op { font-weight:700; text-transform:lowercase; }
  .op-fill { color:#0f766e; } .op-click { color:#b45309; } .op-select { color:#7c3aed; } .op-hover { color:#0369a1; } .op-switch_tab { color:#be123c; }
  .target { font-weight:600; }
  .badge { font-size:11px; color:var(--muted); background:#f1f5f9; border-radius:999px; padding:1px 8px; text-decoration:none; }
  .badge-cause { color:#92400e; background:#fef3c7; }
  .time { font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .step-net { margin-top:8px; font-size:12px; color:#0f766e; background:#f0fdfa; border:1px solid #ccfbf1; border-radius:8px; padding:5px 9px; }
  .step-shot { display:block; max-width:100%; max-height:260px; margin-top:8px; border:1px solid var(--line); border-radius:8px; object-fit:contain; }
  .network, .spans, .frames, .causal, .screens { margin-top:28px; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .network h2, .spans h2, .frames h2, .causal h2, .screens h2, .spans h3 { font-size:15px; margin:0 0 10px; }
  .count { color:var(--muted); font-size:12px; font-weight:400; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .num { color:var(--muted); font-variant-numeric:tabular-nums; width:64px; }
  .network .num { width:36px; }
  .method { font-weight:700; }
  .url { word-break:break-all; }
  .type { color:var(--muted); }
  tbody tr:last-child td { border-bottom:0; }
  .screens figure { margin:0 0 16px; }
  .screens img { max-width:100%; border:1px solid var(--line); border-radius:8px; display:block; }
  .screens figcaption { color:var(--muted); font-size:12px; margin-top:6px; }
  .critical-path { margin:0 0 14px; border:1px solid #ccfbf1; background:#f0fdfa; border-radius:10px; padding:10px 12px; }
  .critical-path h3 { margin:0 0 8px; }
  .cp-metric { margin:0 0 6px; color:var(--muted); font-size:12px; }
  .cp-bottleneck { margin:0 0 8px; font-size:12px; color:#92400e; }
  .critical-path ol { margin:0; padding-left:20px; }
  .critical-path li { margin:3px 0; position:relative; }
  .cp-bar { display:inline-block; height:6px; min-width:0; background:#14b8a6; border-radius:3px; vertical-align:middle; margin-right:6px; }
  .critical-path code { font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
  .causal ul { margin:0; padding-left:18px; }
  .causal li { margin:5px 0; }
  .causal code, .chain-detail code { font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
  .causal .inferred { color:#92400e; }
  .chain-nodes { word-break:break-word; }
  .chain-node { color:inherit; }
  .chain-detail { margin-top:4px; }
  .chain-detail summary { color:var(--muted); font-size:12px; cursor:pointer; }
  .chain-detail ol { margin:4px 0 0; }
  .detail { color:var(--muted); font-size:12px; margin-top:4px; }
  .value { margin-top:8px; }
  .value code { background:#f1f5f9; padding:2px 6px; border-radius:6px; }
  .redacted { color:#b45309; }
  details.state { margin-top:10px; border-top:1px dashed var(--line); padding-top:8px; }
  details.state summary { cursor:pointer; color:var(--muted); font-size:12px; }
  .state-url { color:var(--muted); font-size:12px; margin:6px 0; word-break:break-all; }
  pre { margin:0; padding:12px; background:#0f172a; color:#e2e8f0; border-radius:8px; overflow:auto; max-height:360px; white-space:pre-wrap; word-break:break-word; font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
  .empty { color:var(--muted); }
  .guard { color:#92400e; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:5px 9px; font-size:12px; margin:8px 0; }
  .tree-indent { display:inline-block; }
  .tree-branch { display:inline-block; width:14px; height:12px; border-left:1px solid #cbd5e1; margin-left:4px; }
  .tree-toggle { display:inline-block; width:14px; color:#94a3b8; font-size:10px; }
  .tree-leaf { color:#cbd5e1; }
  .span-tree td.span-name { word-break:break-word; }
  .pager { display:flex; gap:8px; align-items:center; margin:6px 0 10px; font-size:12px; color:var(--muted); }
  .pager button { padding:3px 10px; border:1px solid var(--line); background:#fff; border-radius:6px; font:inherit; cursor:pointer; }
  .pager button:disabled { opacity:.45; cursor:default; }
  .page-label b { color:var(--ink); }
  [hidden] { display:none !important; }
  @media (max-width:640px) { header.top { padding:12px 14px; } main { padding:14px; } }
`;
}

function renderDocument(trace, options = {}) {
  const limits = resolveLimits(options.limits);
  const spanContext = spanContextOf(trace);
  const budget = planViewerBudget(trace, { limits, spanContext });
  const steps = arrayOf(trace.steps);
  const states = arrayOf(trace.states);
  const statesMap = stateById(states);
  const title = truncateText(safeString(options.title || trace.purpose || 'BridgeDeck Trace'), 300);
  const startUrl = truncateText(trace.entry && trace.entry.start_url, limits.urlChars);
  const recordedAt = Date.parse(trace.recorded_at || '');
  const meta = [
    ['起始 URL', startUrl],
    ['开始', safeString(trace.started_at)],
    ['结束', safeString(trace.recorded_at)],
    ['步骤', String(steps.length)],
    ['状态', String(states.length)],
    ['录制成因', safeString(trace.stopped_by)],
    ['recorder', trace.recorder ? 'cli ' + safeString(trace.recorder.cli, '?') + ' · vom ' + safeString(trace.recorder.vom, '?') : ''],
  ].filter(([, value]) => value);
  const guardNotes = arrayOf(options.guardNotes).map((note) => safeString(note)).filter(Boolean);
  if (budget.truncated) guardNotes.push('内容超过渲染上限，已按上限截断（顶部计数是原始数量）。');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${text(title)} · Trace Viewer</title>
<style>${styleSheet()}</style>
</head>
<body>
<header class="top">
  <h1>${text(title)}</h1>
  <div class="meta">${meta.map(([key, value]) => `<span><b>${text(key)}</b> ${key === '起始 URL' ? `<code>${text(value)}</code>` : text(value)}</span>`).join('')}</div>
  ${guardNotes.length ? '<div class="guard">' + guardNotes.map((note) => text(note)).join(' ') + '</div>' : ''}
  <div class="toolbar">
    <input id="q" type="search" placeholder="搜索步骤 / 目标 / 值…" autocomplete="off">
    <span class="count" id="count"></span>
  </div>
</header>
<main id="steps">
${renderSteps(trace, statesMap, budget, recordedAt)}
${renderSpans(spanContext, budget)}
${renderFrames(trace, spanContext)}
${renderCausalChains(trace, budget)}
${renderNetwork(trace, budget)}
${renderScreenshots(trace, budget)}
</main>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
  return { html, budget, spanContext };
}

/** 兜底最小页：连降级渲染都超字节上限时使用；仍然只输出转义后的计数与元信息。 */
function renderMinimal(trace, statistics) {
  const title = truncateText(safeString(trace && trace.purpose) || 'BridgeDeck Trace', 200);
  const startUrl = truncateText(trace && trace.entry && trace.entry.start_url, 300);
  const rows = [
    ['步骤', statistics.steps.total],
    ['状态', arrayOf(trace.states).length],
    ['网络请求', statistics.network.total],
    ['截图', statistics.screenshots.total],
    ['span', statistics.spans.total],
    ['因果链', statistics.causalChains.total],
    ['HTML 字节上限', statistics.maxHtmlBytes],
  ].map(([key, value]) => `<tr><th>${text(key)}</th><td>${text(value)}</td></tr>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>${text(title)} · Trace Viewer（摘要）</title></head>
<body>
<h1>${text(title)}</h1>
<p class="guard">这份 trace 超过 HTML 体积上限，已按大小上限降级为摘要页；完整数据请直接用 JSON 工具查看。</p>
<table><tbody>${rows}</tbody></table>
${startUrl ? '<p>起始 URL：<code>' + text(startUrl) + '</code></p>' : ''}
</body>
</html>`;
}

/**
 * 渲染并返回 {html, stats}：stats 是本次渲染的真实预算/上限证据（CLI --json 直接输出）。
 * @param {object} trace Trace v3
 * @param {{ title?: string, limits?: object, maxHtmlBytes?: number }} [options]
 */
export function renderTraceReport(trace, options = {}) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    throw new Error('trace 必须是对象');
  }
  const maxHtmlBytes = Math.max(1024, Math.floor(numberOr(options.maxHtmlBytes, VIEWER_LIMITS.maxHtmlBytes)));
  let rendered = renderDocument(trace, options);
  let bytes = byteLength(rendered.html);
  const notes = [];
  let degraded = false;
  let fallback = false;
  if (bytes > maxHtmlBytes) {
    rendered = renderDocument(trace, {
      ...options,
      limits: { ...RELAXED_LIMITS },
      guardNotes: ['首次渲染超过 HTML 字节上限，已降级渲染。'],
    });
    bytes = byteLength(rendered.html);
    degraded = true;
    notes.push('首次渲染超过 HTML 字节上限，已降级渲染。');
  }
  if (bytes > maxHtmlBytes) {
    const statistics = {
      limits: rendered.budget.limits,
      steps: rendered.budget.steps,
      network: rendered.budget.network,
      screenshots: rendered.budget.screenshots,
      spans: rendered.budget.spans,
      causalChains: rendered.budget.causalChains,
      maxHtmlBytes,
    };
    rendered = { html: renderMinimal(trace, statistics), budget: rendered.budget, spanContext: rendered.spanContext };
    bytes = byteLength(rendered.html);
    fallback = true;
    notes.push('降级后仍超过 HTML 字节上限，已输出最小摘要页。');
  }
  const budget = rendered.budget;
  const criticalPath = rendered.spanContext && rendered.spanContext.summary && rendered.spanContext.summary.criticalPath
    ? {
      totalMs: numberOr(rendered.spanContext.summary.criticalPath.totalMs, 0),
      spanCount: numberOr(rendered.spanContext.summary.criticalPath.spanCount, 0),
      framePath: arrayOf(rendered.spanContext.summary.criticalPath.framePath),
    }
    : null;
  return {
    html: rendered.html,
    stats: {
      bytes,
      maxHtmlBytes,
      degraded,
      fallback,
      notes,
      steps: budget.steps,
      network: budget.network,
      screenshots: budget.screenshots,
      spans: budget.spans,
      spanPages: budget.spanPages,
      networkPages: budget.networkPages,
      causalChains: budget.causalChains,
      causalPages: budget.causalPages,
      frames: arrayOf(trace.frames).length,
      criticalPath,
      truncated: budget.truncated,
      // W9-C 加法：采样/导出预算证据（旧字段不变；没有这些字段时为 null）。
      sampling: trace.sampling && typeof trace.sampling === 'object' ? trace.sampling : null,
      spanExport: trace.spanExport && typeof trace.spanExport === 'object' ? trace.spanExport : null,
      exportBudget: trace.exportBudget && typeof trace.exportBudget === 'object' ? trace.exportBudget : null,
    },
  };
}

/**
 * 渲染 Trace v3 为完整 HTML 字符串（旧入口，行为向后兼容）。
 * @param {object} trace buildTraceV3 的输出
 * @param {{ title?: string, limits?: object, maxHtmlBytes?: number }} [options]
 */
export function renderTraceHtml(trace, options = {}) {
  return renderTraceReport(trace, options).html;
}
