// cli/lib/table-views.mjs —— 可组合表格模型 + 批处理/配额/租约裁决的人类可读渲染（纯函数）。
//
// 与 cli/lib/format.mjs 的关系：
// - format.mjs 只有最底层的宽度/对齐/`renderTable` 原语；
// - 本模块在其上补"列模型"（列定义/排序/截断/空值/右对齐数字/页脚），
//   并为第十一批 G 的 batch / quota / arbitration 结果提供稳定的表格/摘要渲染。
//
// 设计目标：
// 1) 命令层保持"取数 → 渲染"两段式：命令只负责 RPC 与退出码，渲染全在这里，便于单测；
// 2) 表格输出**确定性**：列顺序由调用方给定，排序显式，不依赖对象键顺序；
// 3) 数字右对齐、长文本按显示宽度截断（中文按 2 列宽，见 format.textWidth）；
// 4) 空结果不打印空表头，而是给一行可读提示（默认"（无数据）"）。
//
// 本模块不做 I/O、不读环境变量、不引用 daemon 模块。

import { formatBytes, padEndWidth, textWidth, truncateText } from './format.mjs';

/** 列对齐。 */
export const ALIGN = Object.freeze({ LEFT: 'left', RIGHT: 'right', CENTER: 'center' });

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 归一化列定义。
 * @param {string|object} column 字符串 = 键名（表头同键名）；对象 = {key, header, align, maxWidth, format, value}
 */
export function normalizeColumn(column) {
  if (typeof column === 'string') {
    return { key: column, header: column, align: ALIGN.LEFT, maxWidth: 0, format: null, value: null };
  }
  if (!isObject(column) || !column.key) {
    throw new Error('列定义需要 key');
  }
  const align = [ALIGN.LEFT, ALIGN.RIGHT, ALIGN.CENTER].includes(column.align) ? column.align : ALIGN.LEFT;
  const maxWidth = Number.isFinite(Number(column.maxWidth)) && Number(column.maxWidth) > 0 ? Math.floor(Number(column.maxWidth)) : 0;
  return {
    key: String(column.key),
    header: column.header === undefined ? String(column.key) : String(column.header),
    align,
    maxWidth,
    format: typeof column.format === 'function' ? column.format : null,
    value: typeof column.value === 'function' ? column.value : null,
  };
}

/** 取单元格原始值：优先 column.value(row)，否则 row[key]。 */
export function cellValue(row, column) {
  const def = typeof column === 'string' ? normalizeColumn(column) : column;
  if (def.value) return def.value(row);
  if (!isObject(row)) return undefined;
  return row[def.key];
}

/** 单元格 → 文本：空值用占位符，超宽截断，formatter 优先。 */
export function formatCell(value, column = {}) {
  let text;
  if (column.format) {
    try {
      text = column.format(value);
    } catch {
      text = value;
    }
  } else {
    text = value;
  }
  const raw = text === undefined || text === null || text === '' ? '—' : toText(text);
  const maxWidth = Number(column.maxWidth) || 0;
  if (maxWidth > 0) return truncateText(raw, maxWidth);
  return raw;
}

/**
 * 构建表格模型：归一化列、格式化每行、计算显示宽度（中文 2 列）。
 * @returns {{headers: string[], rows: string[][], widths: number[], columns: object[], total: number}}
 */
export function buildTableModel(rows = [], columns = []) {
  const defs = (Array.isArray(columns) ? columns : []).map(normalizeColumn);
  const source = Array.isArray(rows) ? rows : [];
  const cells = source.map((row) => defs.map((column) => formatCell(cellValue(row, column), column)));
  const widths = defs.map((column, index) => Math.max(
    textWidth(column.header),
    ...cells.map((row) => textWidth(row[index] || '')),
  ));
  return {
    headers: defs.map((column) => column.header),
    rows: cells,
    widths,
    columns: defs,
    total: source.length,
  };
}

function padCell(text, width, align) {
  const value = toText(text);
  const gap = Math.max(0, width - textWidth(value));
  if (align === ALIGN.RIGHT) return ' '.repeat(gap) + value;
  if (align === ALIGN.CENTER) {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + value + ' '.repeat(gap - left);
  }
  return padEndWidth(value, width);
}

/**
 * 渲染表格模型（带可选页脚与缩进）。
 * @param {object} model buildTableModel 的输出
 * @param {{indent?: string, footer?: string, header?: boolean, separate?: boolean, maxRows?: number}} [options]
 */
export function renderTableModel(model, { indent = '', footer = '', header = true, separate = false, maxRows = 0 } = {}) {
  if (!model || !Array.isArray(model.rows)) return '';
  if (!model.rows.length) return '';
  const lines = [];
  const renderCells = (cells) => cells
    .map((cell, index) => padCell(cell, model.widths[index], model.columns[index].align))
    .join('  ')
    .trimEnd();
  if (header) {
    lines.push(renderCells(model.headers));
    lines.push(model.columns.map((_, index) => '-'.repeat(model.widths[index])).join('  '));
  }
  const limit = Number.isInteger(maxRows) && maxRows > 0 ? Math.min(maxRows, model.rows.length) : model.rows.length;
  for (let index = 0; index < limit; index += 1) {
    lines.push(renderCells(model.rows[index]));
    if (separate && index < limit - 1) lines.push('');
  }
  if (limit < model.rows.length) lines.push('… 还有 ' + (model.rows.length - limit) + ' 行（用 --limit 调整）');
  if (footer) lines.push(footer);
  return lines.map((line) => (indent ? indent + line : line)).join('\n');
}

/** 一步到位：行 + 列 → 表格文本（空数据返回 empty 文案）。 */
export function renderRows(rows = [], columns = [], { empty = '（无数据）', indent = '', footer = '', header = true, maxRows = 0 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return empty;
  const model = buildTableModel(list, columns);
  return renderTableModel(model, { indent, footer, header, maxRows });
}

/**
 * 按某列排序（不改原数组）。
 * @param {object[]} rows
 * @param {object[]} columns 列定义（用于找到 value 提取器）
 * @param {{sort?: string, direction?: 'asc'|'desc'}} options
 */
export function sortRows(rows = [], columns = [], { sort = null, direction = 'asc' } = {}) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!sort) return list;
  const defs = (Array.isArray(columns) ? columns : []).map(normalizeColumn);
  const column = defs.find((item) => item.key === sort || item.header === sort) || normalizeColumn(sort);
  const sign = String(direction).toLowerCase() === 'desc' ? -1 : 1;
  return list.sort((left, right) => {
    const a = cellValue(left, column);
    const b = cellValue(right, column);
    if (a === b) return 0;
    if (a === undefined || a === null) return 1;
    if (b === undefined || b === null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
    return String(a).localeCompare(String(b), 'zh-Hans-CN') * sign;
  });
}

/**
 * 分页视图：返回裁剪后的行 + 页脚信息（CLI --limit/--offset 共用）。
 * @returns {{rows: object[], total: number, limit: number, offset: number, hasMore: boolean, footer: string}}
 */
export function paginateRows(rows = [], { limit = null, offset = 0 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const max = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : list.length;
  const sliced = list.slice(start, start + max);
  const hasMore = start + sliced.length < list.length;
  return {
    rows: sliced,
    total: list.length,
    limit: max,
    offset: start,
    hasMore,
    footer: list.length > sliced.length
      ? '显示 ' + (sliced.length ? start + 1 : 0) + '-' + (start + sliced.length) + ' / ' + list.length + (hasMore ? '（还有 ' + (list.length - start - sliced.length) + ' 条）' : '')
      : '',
  };
}

/** 键值对渲染（摘要块）：[['label', value], ...]。 */
export function renderKeyValues(pairs = [], { indent = '', separator = '：' } = {}) {
  const lines = [];
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (!Array.isArray(pair)) continue;
    const [label, value] = pair;
    const text = value === undefined || value === null || value === '' ? '—' : toText(value);
    lines.push(toText(label) + separator + text);
  }
  return lines.map((line) => (indent ? indent + line : line)).join('\n');
}

/** 段落：标题 + 正文（空正文不打印标题）。 */
export function renderSection(title, body, { indent = '  ', blank = true } = {}) {
  const text = toText(body).trimEnd();
  if (!text) return '';
  return (blank ? '\n' : '') + toText(title) + '\n' + text.split('\n').map((line) => indent + line).join('\n');
}

/** 百分比文本（0.1234 → 12.3%）。 */
export function formatPercent(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toFixed(digits) + '%';
}

/** 毫秒时长文本（与 daemon-views 的 formatDurationMs 同口径，但不依赖它）。 */
export function formatMillis(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return Math.round(value) + 'ms';
  if (value < 60_000) return (value / 1000).toFixed(1) + 's';
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return minutes + 'm' + (seconds ? seconds + 's' : '');
}

// ---------------------------------------------------------------------------
// batch 输出
// ---------------------------------------------------------------------------

/** batch 条目表列定义（`daemon batch status` 与 batch 报告共用）。 */
export const BATCH_ITEM_COLUMNS = Object.freeze([
  { key: 'index', header: '#', align: ALIGN.RIGHT },
  { key: 'state', header: 'state', maxWidth: 14 },
  { key: 'admission', header: 'admission', maxWidth: 10 },
  { key: 'attempts', header: 'try', align: ALIGN.RIGHT },
  { key: 'browser', header: 'browser', maxWidth: 12 },
  { key: 'url', header: 'url', maxWidth: 42, value: (row) => row.url || (row.share ? '(share tab ' + (row.tab == null ? '?' : row.tab) + ')' : '') },
  { key: 'sessionId', header: 'session', maxWidth: 14 },
  { key: 'durationMs', header: '耗时', align: ALIGN.RIGHT, format: (value) => formatMillis(value) },
  { key: 'error', header: 'error', maxWidth: 28, format: (value) => (value && value.code ? value.code : '') },
]);

/** batch 条目表（自动截断长 url/错误码）。 */
export function renderBatchItems(items = [], { limit = 50, empty = '（没有条目）' } = {}) {
  return renderRows(items, BATCH_ITEM_COLUMNS, { empty, maxRows: limit });
}

/** batch 列表（summary 视图，不带完整 items）。 */
export const BATCH_LIST_COLUMNS = Object.freeze([
  { key: 'batchId', header: 'batch', maxWidth: 20 },
  { key: 'state', header: 'state', maxWidth: 14 },
  { key: 'outcome', header: 'outcome', maxWidth: 14 },
  { key: 'summary.total', header: 'total', align: ALIGN.RIGHT, value: (row) => (row.summary && row.summary.total) || 0 },
  { key: 'summary.succeeded', header: 'ok', align: ALIGN.RIGHT, value: (row) => (row.summary && row.summary.succeeded) || 0 },
  { key: 'summary.failed', header: 'fail', align: ALIGN.RIGHT, value: (row) => (row.summary && row.summary.failed) || 0 },
  { key: 'summary.denied', header: 'denied', align: ALIGN.RIGHT, value: (row) => (row.summary && row.summary.denied) || 0 },
  { key: 'createdAt', header: 'created', align: ALIGN.RIGHT, format: (value) => (value ? new Date(value).toISOString().slice(11, 19) : '—') },
  { key: 'durationMs', header: '耗时', align: ALIGN.RIGHT, format: (value) => formatMillis(value) },
]);

export function renderBatchList(list = {}, { limit = 20 } = {}) {
  const batches = Array.isArray(list.batches) ? list.batches : [];
  const totals = list.totals || {};
  const lines = [];
  lines.push('批处理：' + (totals.batches ?? batches.length) + ' 个（运行中 ' + (totals.running ?? 0)
    + '，完成 ' + (totals.completed ?? 0) + '，取消 ' + (totals.cancelled ?? 0) + '，回滚 ' + (totals.rolledBack ?? 0) + '）'
    + '，条目成功 ' + (totals.itemsSucceeded ?? 0) + ' / 失败 ' + (totals.itemsFailed ?? 0) + ' / 配额拒绝 ' + (totals.itemsDenied ?? 0));
  lines.push('');
  lines.push(renderRows(batches, BATCH_LIST_COLUMNS, { empty: '（还没有批处理记录）', maxRows: limit }));
  return lines.join('\n');
}

/**
 * 单批次完整报告（`daemon batch start` / `status <id>`）：
 * 摘要 + 配额证据 + 条目表 + 回滚/警告。
 */
export function renderBatchReport(report = {}, { itemsLimit = 50 } = {}) {
  if (!isObject(report) || !report.batchId) return '（空批次报告）';
  const summary = report.summary || {};
  const quota = report.quota || {};
  const lines = [];
  lines.push('批次 ' + report.batchId + '：' + (report.state || '?') + ' / ' + (report.outcome || '?')
    + (report.reused ? '（幂等复用）' : ''));
  lines.push(renderKeyValues([
    ['条目', (summary.total ?? 0) + '（准入 ' + (summary.admitted ?? 0) + '，配额拒绝 ' + (summary.denied ?? 0) + '）'],
    ['结果', '成功 ' + (summary.succeeded ?? 0) + '，失败 ' + (summary.failed ?? 0) + '，取消 ' + (summary.cancelled ?? 0)
      + '，跳过 ' + (summary.skipped ?? 0) + '，回滚 ' + (summary.rolledBack ?? 0)],
    ['策略', 'onError=' + (report.onError || '?') + '，并发 ' + (report.concurrency ?? '?') + '，重试上限 ' + (report.retries ?? 0)],
    ['配额', '申请 ' + (quota.requested ?? 0) + '，批准 ' + (quota.granted ?? 0) + '，提交 ' + (quota.committed ?? 0)
      + '，释放 ' + (quota.released ?? 0) + '，拒绝 ' + (quota.denied ?? 0)],
    ['耗时', formatMillis(report.durationMs || 0) + (report.group ? '，组 ' + report.group : '')],
  ], { indent: '  ' }));
  if (Array.isArray(report.warnings) && report.warnings.length) {
    lines.push('');
    lines.push('警告：');
    for (const warning of report.warnings) lines.push('  - ' + warning);
  }
  if (report.rollback && report.rollback.requested) {
    lines.push('');
    lines.push('回滚：尝试 ' + (report.rollback.attempted ?? 0) + '，停止 ' + (report.rollback.stopped ?? 0)
      + '，失败 ' + (report.rollback.failed ?? 0)
      + (report.rollback.errors && report.rollback.errors.length ? '（' + report.rollback.errors.map((item) => item.code).join(',') + '）' : ''));
  }
  const items = Array.isArray(report.items) ? report.items : [];
  lines.push('');
  lines.push('条目：');
  lines.push(renderBatchItems(items, { limit: itemsLimit, empty: '（没有条目）' }));
  if (items.length > itemsLimit) lines.push('（条目已截断，用 --limit 调整）');
  return lines.join('\n');
}

/** 批处理计划（dry-run）渲染：准入决策 + 配额算式 + 警告。 */
export function renderBatchPlan(plan = {}, { itemsLimit = 50 } = {}) {
  if (!isObject(plan) || plan.dryRun !== true) return renderBatchReport(plan);
  const summary = plan.summary || {};
  const quota = plan.quota || {};
  const totals = quota.totals || {};
  const lines = [];
  lines.push('批处理计划（dry-run）：' + (summary.total ?? 0) + ' 个条目，可启动 ' + (summary.admissable ?? 0)
    + '，配额拒绝 ' + (summary.denied ?? 0));
  lines.push(renderKeyValues([
    ['配额', '存活 ' + (quota.live ?? 0) + ' / 上限 ' + ((quota.policy && quota.policy.maxSessions) ?? summary.policyMaxSessions ?? '?')
      + '，已预约 ' + (quota.reserved ?? 0) + '，可用 ' + (quota.availableBefore ?? quota.availableAfter ?? '?')],
    ['分配', '请求 ' + (totals.requested ?? 0) + '，批准 ' + (totals.granted ?? 0) + '，拒绝 ' + (totals.denied ?? 0)],
    ['策略', 'onError=' + ((plan.spec && plan.spec.onError) || '?') + '，并发 ' + ((plan.spec && plan.spec.concurrency) ?? '?')
      + '，重试上限 ' + ((plan.spec && plan.spec.retries) ?? 0)],
    ['预计', '启动 ' + (summary.estimatedStarts ?? 0) + ' 个，并行度 ' + (summary.maxParallelObserved ?? 0)],
  ], { indent: '  ' }));
  if (Array.isArray(plan.warnings) && plan.warnings.length) {
    lines.push('');
    lines.push('警告：');
    for (const warning of plan.warnings) lines.push('  - ' + warning);
  }
  const items = Array.isArray(plan.items) ? plan.items : [];
  lines.push('');
  lines.push('准入：');
  lines.push(renderRows(items, [
    { key: 'index', header: '#', align: ALIGN.RIGHT },
    { key: 'admission', header: 'admission', maxWidth: 10 },
    { key: 'reason', header: 'reason', maxWidth: 20 },
    { key: 'url', header: 'url', maxWidth: 48 },
    { key: 'key', header: 'key', maxWidth: 16 },
  ], { empty: '（没有条目）', maxRows: itemsLimit }));
  return lines.join('\n');
}

/** 配额快照渲染（`daemon batch quota`）。 */
export function renderQuota(snapshot = {}) {
  const policy = snapshot.policy || {};
  const lines = [];
  lines.push('会话配额：存活 ' + (snapshot.live ?? 0) + '/' + (policy.maxSessions ?? '?')
    + '，预约 ' + (snapshot.reserved ?? 0) + '，可用 ' + (snapshot.available ?? 0)
    + '（用量 ' + formatPercent(snapshot.usagePercent ?? 0) + (snapshot.saturated ? '，已饱和' : '') + '）');
  lines.push(renderKeyValues([
    ['单批上限', policy.maxPerBatch ?? '?'],
    ['启动并发', policy.maxConcurrentStarts ?? '?'],
    ['单实例上限', policy.maxPerInstance ?? '?'],
    ['预约 TTL', formatMillis(policy.reservationTtlMs ?? 0)],
  ], { indent: '  ' }));
  const instances = Array.isArray(snapshot.instances) ? snapshot.instances : [];
  if (instances.length) {
    lines.push('');
    lines.push('按实例：');
    lines.push(renderRows(instances, [
      { key: 'instanceId', header: 'instance', maxWidth: 20 },
      { key: 'live', header: 'live', align: ALIGN.RIGHT },
    ], { empty: '（无实例）' }));
  }
  const batches = Array.isArray(snapshot.batches) ? snapshot.batches : [];
  if (batches.length) {
    lines.push('');
    lines.push('预约：');
    lines.push(renderRows(batches, [
      { key: 'batchId', header: 'batch', maxWidth: 20 },
      { key: 'state', header: 'state', maxWidth: 12 },
      { key: 'requested', header: 'req', align: ALIGN.RIGHT },
      { key: 'granted', header: 'grant', align: ALIGN.RIGHT },
      { key: 'used', header: 'used', align: ALIGN.RIGHT },
      { key: 'released', header: 'rel', align: ALIGN.RIGHT },
      { key: 'waiting', header: 'wait', align: ALIGN.RIGHT },
      { key: 'expiresAt', header: 'expires', align: ALIGN.RIGHT, format: (value) => (value ? new Date(value).toISOString().slice(11, 19) : '—') },
    ], { empty: '（没有预约）' }));
  } else {
    lines.push('');
    lines.push('（没有配额预约）');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 租约裁决输出
// ---------------------------------------------------------------------------

/** 裁决 verdict 表列（report / arbitrate 共用）。 */
export const ARBITRATION_VERDICT_COLUMNS = Object.freeze([
  { key: 'tabId', header: 'tab', align: ALIGN.RIGHT },
  { key: 'severity', header: 'severity', maxWidth: 6 },
  { key: 'action', header: 'action', maxWidth: 12 },
  { key: 'conflictCodes', header: '冲突', maxWidth: 40, format: (value) => (Array.isArray(value) ? value.join(',') : '') },
  { key: 'winner', header: 'winner', maxWidth: 14, format: (value) => (value && value.sessionId ? value.sessionId : '—') },
  { key: 'losers', header: 'losers', maxWidth: 24, format: (value) => (Array.isArray(value) ? value.map((item) => item.sessionId + ':' + item.disposition).join(',') : '') },
  { key: 'reportOnly', header: 'report', maxWidth: 6, format: (value) => (value === true ? 'only' : '') },
  { key: 'confidence', header: 'conf', align: ALIGN.RIGHT, format: (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—') },
  { key: 'steps', header: 'steps', align: ALIGN.RIGHT, format: (value) => String(Array.isArray(value) ? value.length : 0) },
]);

/** 步骤表列。 */
export const ARBITRATION_STEP_COLUMNS = Object.freeze([
  { key: 'index', header: '#', align: ALIGN.RIGHT },
  { key: 'tabId', header: 'tab', align: ALIGN.RIGHT },
  { key: 'op', header: 'op', maxWidth: 14 },
  { key: 'reason', header: 'reason', maxWidth: 26 },
  { key: 'args', header: 'args', maxWidth: 52, format: (value) => JSON.stringify(value || {}) },
]);

/** 裁决计划渲染（含 apply/residual 段落）。 */
export function renderArbitrationPlan(plan = {}, { verdictLimit = 20, stepLimit = 20, applied = null, residual = null } = {}) {
  if (!isObject(plan)) return '（空裁决计划）';
  const summary = plan.summary || {};
  const policy = plan.policy || {};
  const lines = [];
  lines.push('租约裁决：' + (summary.verdicts ?? 0) + ' 个 tab（高 ' + (summary.highSeverity ?? 0)
    + '，警告 ' + (summary.warnSeverity ?? 0) + '，信息 ' + (summary.infoSeverity ?? 0) + '）'
    + (plan.truncated ? '（结果已截断）' : ''));
  lines.push(renderKeyValues([
    ['策略', 'strategy=' + (policy.strategy || '?') + '，preempt=' + (policy.preempt === true) + '，force=' + (policy.allowForce === true)],
    ['冲突', '总数 ' + (summary.conflicts ?? 0) + '（租约 ' + (summary.leases ?? 0) + '，会话 ' + (summary.sessions ?? 0) + '）'],
    ['可执行', (summary.actionable ?? 0) + '，仅报告 ' + (summary.reportOnly ?? 0) + '，延后 ' + (summary.deferred ?? 0) + '，步骤 ' + (summary.steps ?? 0)],
    ['动作分布', Object.entries(summary.byAction || {}).map(([key, count]) => key + '=' + count).join(',') || '无'],
  ], { indent: '  ' }));
  const verdicts = Array.isArray(plan.verdicts) ? plan.verdicts : [];
  lines.push('');
  lines.push('裁决：');
  lines.push(renderRows(verdicts, ARBITRATION_VERDICT_COLUMNS, { empty: '（没有需要裁决的 tab）', maxRows: verdictLimit }));
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length) {
    lines.push('');
    lines.push('步骤：');
    lines.push(renderRows(steps, ARBITRATION_STEP_COLUMNS, { empty: '（没有可执行步骤）', maxRows: stepLimit }));
  }
  const reportOnlyVerdicts = verdicts.filter((verdict) => verdict.reportOnly === true);
  if (reportOnlyVerdicts.length) {
    lines.push('');
    lines.push('仅报告（需人工确认，不会自动改结构）：');
    for (const verdict of reportOnlyVerdicts.slice(0, 10)) {
      lines.push('  tab ' + verdict.tabId + '  ' + (verdict.reason || verdict.conflictCodes.join(',')));
    }
  }
  if (applied && isObject(applied)) {
    lines.push('');
    lines.push('执行结果：' + (applied.summary && applied.summary.ok ? applied.summary.ok : 0) + ' 步成功，'
      + (applied.summary && applied.summary.failed ? applied.summary.failed : 0) + ' 步失败，'
      + (applied.summary && applied.summary.skipped ? applied.summary.skipped : 0) + ' 步跳过'
      + (applied.summary && applied.summary.unsupported ? '（不支持 ' + applied.summary.unsupported + '）' : ''));
    const failed = Array.isArray(applied.failed) ? applied.failed : [];
    for (const item of failed.slice(0, 10)) lines.push('  [失败] ' + item.op + ' tab=' + item.tabId + '  ' + (item.code || '?') + ' ' + (item.message || ''));
    const okSteps = Array.isArray(applied.applied) ? applied.applied : [];
    for (const item of okSteps.slice(0, 10)) lines.push('  [ok]   ' + item.op + ' tab=' + item.tabId + (item.reason ? '  ' + item.reason : ''));
  }
  if (residual && isObject(residual)) {
    lines.push('');
    lines.push('应用后残留：冲突 ' + (residual.residualConflicts ?? 0) + '（已解决 ' + (residual.resolved ?? 0) + '）');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// status --views 输出
// ---------------------------------------------------------------------------

const VIEW_TITLES = Object.freeze({
  ledger: '账本',
  transfers: '传输',
  queues: '命令队列',
  doctor: 'daemon 自检',
  leases: '租约所有权',
  boundary: '命令边界',
  batch: '批处理/配额',
  arbitration: '租约裁决',
});

/**
 * status 增量视图的人类输出：只渲染请求了且存在的视图字段；
 * 默认 status（没有 views）根本不调用本函数，保证既有输出不变。
 */
export function renderStatusViews(result = {}) {
  const views = Array.isArray(result.views) ? result.views : [];
  if (!views.length) return '';
  const sections = [];
  for (const view of views) {
    const value = result[view === 'queues' ? 'queue' : view];
    if (value === undefined || value === null) continue;
    const title = VIEW_TITLES[view] || view;
    if (view === 'ledger') {
      sections.push(renderSection(title + '：', 'pending ' + ((value.pending && value.pending.length) ?? 0)
        + '，WAL ' + ((value.wal && value.wal.parsed) ?? 0) + '/' + ((value.wal && value.wal.lines) ?? 0)
        + '，fsync ' + (value.durability && value.durability.fsync === true ? 'on' : 'off')));
    } else if (view === 'transfers') {
      sections.push(renderSection(title + '：', '并发 ' + ((value.counts && value.counts.active) ?? 0) + '/' + ((value.quota && value.quota.maxConcurrent) ?? '?')
        + '，字节 ' + formatBytes((value.bytes && value.bytes.reserved) || 0) + '/' + formatBytes((value.quota && value.quota.maxTotalBytes) || 0)));
    } else if (view === 'queues') {
      sections.push(renderSection(title + '：', '排队 ' + ((value.totals && value.totals.pending) ?? 0)
        + '，执行中 ' + ((value.inflight && value.inflight.current) ?? 0) + '/' + ((value.inflight && value.inflight.limit) ?? '?')
        + '，公平性 ' + ((value.fairness && value.fairness.strategy) || '?')));
    } else if (view === 'doctor') {
      sections.push(renderSection(title + '：', (value.status || '?') + '（检查 ' + ((value.summary && value.summary.total) ?? (value.checks || []).length) + ' 项）'));
    } else if (view === 'leases') {
      const totals = value.totals || {};
      sections.push(renderSection(title + '：', 'tab ' + (totals.tabs ?? 0) + '，持有 ' + (totals.leasedTabs ?? 0)
        + '，共享 ' + (totals.sharedTabs ?? 0) + '，冲突 ' + (totals.conflicts ?? 0) + '（高 ' + (totals.highConflicts ?? 0) + '）'));
    } else if (view === 'boundary') {
      const counts = value.counts || {};
      sections.push(renderSection(title + '：', '方法 ' + (counts.total ?? 0) + '，不变量 ' + (value.invariantOk === true ? 'ok' : 'fail')));
    } else if (view === 'batch') {
      const quota = value.quota || {};
      const totals = value.totals || {};
      sections.push(renderSection(title + '：', '存活 ' + (quota.live ?? 0) + '/' + ((quota.policy && quota.policy.maxSessions) ?? '?')
        + '，预约 ' + (quota.reserved ?? 0) + '，批次 ' + (totals.batches ?? 0)
        + '（运行中 ' + (totals.running ?? 0) + '，成功 ' + (totals.succeeded ?? 0) + '）'));
    } else if (view === 'arbitration') {
      const summary = value.summary || {};
      sections.push(renderSection(title + '：', '裁决 ' + (summary.verdicts ?? 0) + ' 个 tab，可执行 ' + (summary.actionable ?? 0)
        + '，仅报告 ' + (summary.reportOnly ?? 0)));
    } else {
      sections.push(renderSection(title + '：', JSON.stringify(value).slice(0, 200)));
    }
  }
  if (Array.isArray(result.unknownViews) && result.unknownViews.length) {
    sections.push(renderSection('未知视图：', result.unknownViews.join(',')));
  }
  return sections.join('');
}
