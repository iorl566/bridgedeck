// tests/unit/daemon-cli-tables.test.mjs —— CLI 表格/渲染层（cli/lib/table-views.mjs）。
//
// 覆盖：
// - 列模型：列定义归一化、单元格取值/formatter/空值占位/宽度截断/中文宽度对齐；
// - 表格渲染：表头/分隔线/右对齐/空数据/页脚/行数截断；
// - 排序/分页：asc/desc、缺失值兜底、limit/offset/hasMore/footer；
// - 摘要渲染：renderKeyValues/renderSection/formatPercent/formatMillis；
// - 业务渲染：renderBatchItems/BatchList/BatchReport/BatchPlan/renderQuota/renderArbitrationPlan/
//   renderStatusViews（每个视图字段都覆盖到；未知视图回显）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIGN,
  ARBITRATION_STEP_COLUMNS,
  ARBITRATION_VERDICT_COLUMNS,
  BATCH_ITEM_COLUMNS,
  BATCH_LIST_COLUMNS,
  buildTableModel,
  cellValue,
  formatCell,
  formatMillis,
  formatPercent,
  normalizeColumn,
  paginateRows,
  renderArbitrationPlan,
  renderBatchItems,
  renderBatchList,
  renderBatchPlan,
  renderBatchReport,
  renderKeyValues,
  renderQuota,
  renderRows,
  renderSection,
  renderStatusViews,
  renderTableModel,
  sortRows,
} from '../../cli/lib/table-views.mjs';

// ---------------------------------------------------------------------------
// 列模型
// ---------------------------------------------------------------------------

test('normalizeColumn：字符串列名与对象列定义都归一化，支持右对齐/截断', () => {
  const simple = normalizeColumn('batchId');
  assert.deepEqual(simple, { key: 'batchId', header: 'batchId', align: ALIGN.LEFT, maxWidth: 0, format: null, value: null });
  const rich = normalizeColumn({ key: 'count', header: '数量', align: 'right', maxWidth: '6' });
  assert.equal(rich.header, '数量');
  assert.equal(rich.align, ALIGN.RIGHT);
  assert.equal(rich.maxWidth, 6);
  const fallbackAlign = normalizeColumn({ key: 'x', align: 'stretch' });
  assert.equal(fallbackAlign.align, ALIGN.LEFT);
  assert.throws(() => normalizeColumn({}), /key/);
  assert.throws(() => normalizeColumn(null), /key/);
});

test('cellValue：value 提取器优先于行键，缺失返回 undefined', () => {
  assert.equal(cellValue({ a: 1 }, 'a'), 1);
  assert.equal(cellValue({ a: 1 }, normalizeColumn({ key: 'a', value: () => 2 })), 2);
  assert.equal(cellValue(null, 'a'), undefined);
  assert.equal(cellValue({ summary: { total: 3 } }, 'summary.total'), undefined, '不支持点路径（显式 value 提取器）');
});

test('formatCell：formatter/空值占位/按显示宽度截断（中文算 2 列）', () => {
  assert.equal(formatCell(undefined, {}), '—');
  assert.equal(formatCell('', {}), '—');
  assert.equal(formatCell(null, {}), '—');
  assert.equal(formatCell(3, { format: (value) => value * 2 }), '6');
  assert.equal(formatCell('abcdef', { maxWidth: 4 }), 'abc…');
  assert.equal(formatCell('中文字', { maxWidth: 2 }), '中…');
  assert.equal(formatCell('中文', { maxWidth: 3 }), '中文', '字符数未超限不截断');
  assert.equal(formatCell('ok', { format: () => { throw new Error('boom'); } }), 'ok');
});

test('buildTableModel：中文宽度、右对齐、行数统计', () => {
  const model = buildTableModel(
    [{ name: '甲', count: 12 }, { name: '乙乙', count: 3 }],
    [{ key: 'name', header: '名称' }, { key: 'count', header: '数量', align: ALIGN.RIGHT }],
  );
  assert.deepEqual(model.headers, ['名称', '数量']);
  assert.equal(model.widths[0], 4, '表头两字宽 4');
  assert.equal(model.widths[1], 4);
  assert.deepEqual(model.rows, [['甲', '12'], ['乙乙', '3']]);
  assert.equal(model.total, 2);
});

test('renderTableModel：表头/分隔线/数字右对齐/缩进/空模型', () => {
  const model = buildTableModel([{ a: 'x', n: 5 }], [{ key: 'a', header: 'A' }, { key: 'n', header: 'N', align: ALIGN.RIGHT }]);
  const text = renderTableModel(model);
  const lines = text.split('\n');
  assert.equal(lines[0], 'A  N');
  assert.match(lines[1], /^-+\s+-+$/);
  assert.match(lines[2], /x\s+5$/);
  assert.equal(renderTableModel({ rows: [] }), '');
  assert.equal(renderTableModel(null), '');
  const indented = renderTableModel(model, { indent: '  ', header: false });
  assert.equal(indented, '  x  5');
});

test('renderTableModel：maxRows 截断提示与 footer', () => {
  const model = buildTableModel([{ a: 1 }, { a: 2 }, { a: 3 }], ['a']);
  const text = renderTableModel(model, { maxRows: 2, footer: 'END' });
  assert.match(text, /还有 1 行/);
  assert.match(text, /END$/);
});

test('renderRows：空数据返回 empty 文案，否则渲染表格', () => {
  assert.equal(renderRows([], ['a']), '（无数据）');
  assert.equal(renderRows([], ['a'], { empty: '空' }), '空');
  const text = renderRows([{ a: 'x' }], ['a']);
  assert.match(text, /^a\n-/);
});

// ---------------------------------------------------------------------------
// 排序 / 分页
// ---------------------------------------------------------------------------

test('sortRows：数字/字符串、asc/desc、缺失值沉底、不修改原数组', () => {
  const rows = [{ n: 3 }, { n: 1 }, { n: 2 }];
  const sorted = sortRows(rows, ['n'], { sort: 'n' });
  assert.deepEqual(sorted.map((row) => row.n), [1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.n), [3, 1, 2], '原数组不被修改');
  assert.deepEqual(sortRows(rows, ['n'], { sort: 'n', direction: 'desc' }).map((row) => row.n), [3, 2, 1]);
  const withMissing = [{ n: 2 }, {}, { n: 1 }];
  assert.deepEqual(sortRows(withMissing, ['n'], { sort: 'n' }).map((row) => row.n), [1, 2, undefined]);
  const names = [{ name: 'b' }, { name: 'a' }];
  assert.deepEqual(sortRows(names, ['name'], { sort: 'name' }).map((row) => row.name), ['a', 'b']);
  assert.deepEqual(sortRows(rows, ['n'], {}).map((row) => row.n), [3, 1, 2]);
});

test('sortRows：按列 header 匹配也能排序', () => {
  const columns = [{ key: 'n', header: '数量' }];
  const rows = [{ n: 2 }, { n: 1 }];
  assert.deepEqual(sortRows(rows, columns, { sort: '数量' }).map((row) => row.n), [1, 2]);
});

test('paginateRows：limit/offset/hasMore/footer 语义', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ index }));
  const page = paginateRows(rows, { limit: 2, offset: 1 });
  assert.deepEqual(page.rows.map((row) => row.index), [1, 2]);
  assert.equal(page.total, 5);
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 1);
  assert.equal(page.hasMore, true);
  assert.match(page.footer, /2-3 \/ 5/);
  const last = paginateRows(rows, { limit: 10 });
  assert.equal(last.hasMore, false);
  assert.deepEqual(last.rows.map((row) => row.index), [0, 1, 2, 3, 4]);
  const empty = paginateRows([], { limit: 5 });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.footer, '');
  const negative = paginateRows(rows, { limit: 3, offset: -2 });
  assert.equal(negative.offset, 0);
});

// ---------------------------------------------------------------------------
// 通用摘要
// ---------------------------------------------------------------------------

test('renderKeyValues：键值对渲染（缺省占位/自定义分隔符/缩进）', () => {
  const text = renderKeyValues([['条目', 3], ['状态', ''], ['x', null], ['y', 0]]);
  assert.equal(text.split('\n')[0], '条目：3');
  assert.equal(text.split('\n')[1], '状态：—');
  assert.equal(text.split('\n')[3], 'y：0');
  assert.equal(renderKeyValues([['a', 1]], { separator: ' = ', indent: '  ' }), '  a = 1');
  assert.equal(renderKeyValues([null, 'x']), '');
});

test('renderSection：空正文不打印标题，正文逐行缩进', () => {
  assert.equal(renderSection('标题', ''), '');
  const text = renderSection('标题', 'a\nb', { indent: '  ' });
  assert.equal(text, '\n标题\n  a\n  b');
  assert.match(renderSection('标题', 'x', { blank: false }), /^标题/);
});

test('formatPercent / formatMillis：显示格式稳定', () => {
  assert.equal(formatPercent(12.34), '12.3%');
  assert.equal(formatPercent('x'), '—');
  assert.equal(formatMillis(0), '0ms');
  assert.equal(formatMillis(999), '999ms');
  assert.equal(formatMillis(1500), '1.5s');
  assert.equal(formatMillis(65_000), '1m5s');
  assert.equal(formatMillis(120_000), '2m');
});

// ---------------------------------------------------------------------------
// batch 渲染
// ---------------------------------------------------------------------------

function batchReportFixture() {
  return {
    schema: 1,
    kind: 'bridge/session-batch',
    batchId: 'b1-xyz',
    state: 'completed',
    outcome: 'ok',
    onError: 'continue',
    concurrency: 2,
    retries: 1,
    durationMs: 1500,
    group: 'matrix',
    reused: false,
    quota: { requested: 2, granted: 2, committed: 2, released: 0, denied: 0 },
    summary: { total: 2, admitted: 2, denied: 0, succeeded: 2, failed: 0, cancelled: 0, skipped: 0, rolledBack: 0 },
    warnings: ['示例警告'],
    rollback: null,
    items: [
      { index: 0, state: 'succeeded', admission: 'admitted', attempts: 1, browser: 'edge', url: 'https://a.example/very/long/path?q=' + 'x'.repeat(40), sessionId: 'sess-1', durationMs: 1200, error: null },
      { index: 1, state: 'failed', admission: 'admitted', attempts: 2, browser: null, url: null, share: true, tab: 7, sessionId: null, durationMs: 300, error: { code: 'E_TIMEOUT', message: '超时' } },
    ],
  };
}

test('BATCH_ITEM_COLUMNS / renderBatchItems：条目表含状态/尝试/错误码，share 行显示 tab', () => {
  assert.ok(BATCH_ITEM_COLUMNS.some((column) => column.key === 'state'));
  const text = renderBatchItems(batchReportFixture().items);
  assert.match(text, /succeeded/);
  assert.match(text, /E_TIMEOUT/);
  assert.match(text, /share tab 7/);
  assert.match(text, /1\.2s/, '耗时列格式化');
  assert.equal(renderBatchItems([], { empty: '空' }), '空');
});

test('renderBatchList：总览行 + 列表表格 + 空列表提示', () => {
  const list = {
    batches: [
      { batchId: 'b1', state: 'completed', outcome: 'ok', summary: { total: 2, succeeded: 2, failed: 0, denied: 0 }, createdAt: 1_700_000_000_000, durationMs: 1500 },
      { batchId: 'b2', state: 'aborted', outcome: 'failed', summary: { total: 1, succeeded: 0, failed: 1, denied: 0 }, createdAt: 1_700_000_100_000, durationMs: 50 },
    ],
    totals: { batches: 2, running: 0, completed: 1, cancelled: 0, rolledBack: 0, itemsSucceeded: 2, itemsFailed: 1, itemsDenied: 0 },
  };
  const text = renderBatchList(list);
  assert.match(text, /批处理：2 个/);
  assert.match(text, /b1/);
  assert.match(text, /b2/);
  assert.match(text, /完成 1/);
  const empty = renderBatchList({ batches: [], totals: {} });
  assert.match(empty, /还没有批处理记录/);
  const limited = renderBatchList(list, { limit: 1 });
  assert.match(limited, /还有 1 行/);
});

test('renderBatchReport：摘要/配额/警告/回滚/条目完整渲染', () => {
  const report = batchReportFixture();
  report.rollback = { requested: true, attempted: 2, stopped: 1, failed: 1, errors: [{ code: 'E_INTERNAL' }] };
  const text = renderBatchReport(report);
  assert.match(text, /批次 b1-xyz：completed \/ ok/);
  assert.match(text, /成功 2/);
  assert.match(text, /onError=continue/);
  assert.match(text, /申请 2，批准 2/);
  assert.match(text, /示例警告/);
  assert.match(text, /回滚：尝试 2，停止 1，失败 1/);
  assert.match(text, /条目：/);
  assert.equal(renderBatchReport({}), '（空批次报告）');
  assert.equal(renderBatchReport(null), '（空批次报告）');
  const reused = renderBatchReport({ ...report, reused: true });
  assert.match(reused, /幂等复用/);
});

test('renderBatchReport：itemsLimit 截断提示', () => {
  const report = batchReportFixture();
  report.items = Array.from({ length: 5 }, (_, index) => ({ index, state: 'succeeded', admission: 'admitted', attempts: 1, durationMs: 1, error: null }));
  const text = renderBatchReport(report, { itemsLimit: 2 });
  assert.match(text, /条目已截断/);
});

test('renderBatchPlan：dry-run 计划渲染准入/配额/策略/警告', () => {
  const plan = {
    schema: 1,
    kind: 'bridge/session-batch-plan',
    dryRun: true,
    spec: { onError: 'abort', concurrency: 2, retries: 1 },
    policy: { maxSessions: 6 },
    quota: {
      policy: { maxSessions: 6 },
      live: 1,
      reserved: 0,
      availableBefore: 5,
      totals: { requested: 3, granted: 2, denied: 1 },
    },
    items: [
      { index: 0, admission: 'admit', reason: 'quota-granted', url: 'https://a.example/', key: 'k0' },
      { index: 1, admission: 'deny', reason: 'quota-overflow', url: 'https://b.example/', key: null },
    ],
    summary: { total: 3, admissable: 2, denied: 1, estimatedStarts: 2, maxParallelObserved: 2, policyMaxSessions: 6 },
    warnings: ['配额只允许 2/3 个条目启动'],
  };
  const text = renderBatchPlan(plan);
  assert.match(text, /批处理计划（dry-run）：3 个条目/);
  assert.match(text, /存活 1 \/ 上限 6/);
  assert.match(text, /onError=abort/);
  assert.match(text, /配额只允许 2\/3/);
  assert.match(text, /admit/);
  assert.match(text, /deny/);
  // 非 dry-run 的报告走 renderBatchReport。
  assert.match(renderBatchPlan(batchReportFixture()), /批次 b1-xyz/);
});

test('renderQuota：配额摘要/实例/预约表/空预约提示', () => {
  const text = renderQuota({
    policy: { maxSessions: 12, maxPerBatch: 4, maxConcurrentStarts: 2, maxPerInstance: 8, reservationTtlMs: 60_000 },
    live: 3,
    reserved: 2,
    available: 7,
    usagePercent: 41.7,
    saturated: false,
    instances: [{ instanceId: 'edge-1', live: 3 }],
    batches: [{ batchId: 'b1', state: 'reserved', requested: 4, granted: 2, used: 2, released: 0, waiting: 2, expiresAt: 1_700_000_100_000 }],
  });
  assert.match(text, /会话配额：存活 3\/12/);
  assert.match(text, /用量 41.7%/);
  assert.match(text, /按实例/);
  assert.match(text, /edge-1/);
  assert.match(text, /预约：/);
  assert.match(text, /b1/);
  const empty = renderQuota({ policy: { maxSessions: 4 }, live: 0, reserved: 0, available: 4 });
  assert.match(empty, /没有配额预约/);
});

// ---------------------------------------------------------------------------
// 租约裁决渲染
// ---------------------------------------------------------------------------

function arbitrationPlanFixture() {
  return {
    schema: 1,
    kind: 'bridge/lease-arbitration',
    mode: 'plan',
    policy: { strategy: 'fifo', preempt: false, allowForce: false, limit: 20 },
    verdicts: [
      {
        tabId: 1,
        action: 'promote',
        severity: 'high',
        conflictCodes: ['lease-holder-missing'],
        winner: { sessionId: 's2' },
        losers: [{ sessionId: 's3', disposition: 'participant' }],
        reportOnly: false,
        confidence: 0.9,
        steps: [{ index: 0, op: 'transfer', tabId: 1, args: { from: 'dead', to: 's2' } }],
        reason: '把 tab 所有权判给 s2',
      },
      {
        tabId: 2,
        action: 'repair',
        severity: 'high',
        conflictCodes: ['lease-holder-not-participant'],
        winner: null,
        losers: [],
        reportOnly: true,
        confidence: 0.5,
        steps: [],
        reason: '只报告（结构不一致）',
      },
    ],
    steps: [
      { index: 0, op: 'transfer', tabId: 1, reason: 'holder-missing', args: { tabId: 1, from: 'dead', to: 's2' } },
    ],
    summary: { verdicts: 2, highSeverity: 2, warnSeverity: 0, infoSeverity: 0, conflicts: 2, leases: 2, sessions: 2, actionable: 1, reportOnly: 1, deferred: 0, steps: 1, byAction: { promote: 1, repair: 1 } },
    truncated: false,
  };
}

test('ARBITRATION_VERDICT_COLUMNS / renderArbitrationPlan：裁决表 + 步骤 + 仅报告 + 执行/残留段落', () => {
  assert.ok(ARBITRATION_VERDICT_COLUMNS.some((column) => column.key === 'winner'));
  assert.ok(ARBITRATION_STEP_COLUMNS.some((column) => column.key === 'args'));
  const plan = arbitrationPlanFixture();
  const text = renderArbitrationPlan(plan);
  assert.match(text, /租约裁决：2 个 tab/);
  assert.match(text, /strategy=fifo/);
  assert.match(text, /promote=1,repair=1/);
  assert.match(text, /s2/);
  assert.match(text, /仅报告（需人工确认/);
  assert.match(text, /步骤：/);
  const applied = {
    summary: { ok: 1, failed: 1, skipped: 0, unsupported: 0 },
    applied: [{ index: 0, op: 'transfer', tabId: 1, reason: 'holder-missing' }],
    failed: [{ index: 1, op: 'release', tabId: 2, code: 'E_TAB_LEASE_NOT_FOUND', message: '不存在' }],
  };
  const withApply = renderArbitrationPlan(plan, { applied, residual: { residualConflicts: 1, resolved: 1 } });
  assert.match(withApply, /1 步成功，1 步失败/);
  assert.match(withApply, /\[失败\] release tab=2/);
  assert.match(withApply, /\[ok\]   transfer tab=1/);
  assert.match(withApply, /应用后残留：冲突 1（已解决 1）/);
  assert.equal(renderArbitrationPlan(null), '（空裁决计划）');
});

test('renderArbitrationPlan：空裁决/截断标记/无步骤时也可读', () => {
  const empty = renderArbitrationPlan({ kind: 'bridge/lease-arbitration', verdicts: [], steps: [], summary: {}, policy: {} });
  assert.match(empty, /没有需要裁决的 tab/);
  const truncated = renderArbitrationPlan({ ...arbitrationPlanFixture(), truncated: true });
  assert.match(truncated, /结果已截断/);
});

// ---------------------------------------------------------------------------
// status --views 渲染
// ---------------------------------------------------------------------------

function statusViewsFixture() {
  return {
    service: 'browser-bridge',
    views: ['ledger', 'transfers', 'queues', 'doctor', 'leases', 'boundary', 'batch', 'arbitration'],
    ledger: { pending: [{}], wal: { parsed: 1, lines: 2 }, durability: { fsync: true } },
    transfers: { counts: { active: 1 }, quota: { maxConcurrent: 4, maxTotalBytes: 1024 }, bytes: { reserved: 10 } },
    queue: { totals: { pending: 1 }, inflight: { current: 1, limit: 2 }, fairness: { strategy: 'round-robin-per-tab' } },
    doctor: { status: 'ok', summary: { total: 9 }, checks: [] },
    leases: { totals: { tabs: 2, leasedTabs: 1, sharedTabs: 1, conflicts: 1, highConflicts: 1 } },
    boundary: { counts: { total: 160 }, invariantOk: true },
    batch: { quota: { policy: { maxSessions: 12 }, live: 2, reserved: 1 }, totals: { batches: 2, running: 0, succeeded: 3 } },
    arbitration: { summary: { verdicts: 2, actionable: 1, reportOnly: 1 } },
    unknownViews: ['nope'],
  };
}

test('renderStatusViews：8 个视图各渲染一段摘要（含未知视图回显）', () => {
  const text = renderStatusViews(statusViewsFixture());
  assert.match(text, /账本：/);
  assert.match(text, /传输：/);
  assert.match(text, /命令队列：/);
  assert.match(text, /daemon 自检：/);
  assert.match(text, /租约所有权：/);
  assert.match(text, /命令边界：/);
  assert.match(text, /批处理\/配额：/);
  assert.match(text, /租约裁决：/);
  assert.match(text, /未知视图：\s*nope/);
});

test('renderStatusViews：无 views 或字段缺失/空时返回空串', () => {
  assert.equal(renderStatusViews({}), '');
  assert.equal(renderStatusViews({ views: [] }), '');
  assert.equal(renderStatusViews({ views: ['batch'] }), '', '字段缺失时不渲染占位段');
  const unknownOnly = renderStatusViews({ views: ['mystery'], mystery: { a: 1 } });
  assert.match(unknownOnly, /mystery/);
});

test('renderStatusViews：queues 视图字段名是 queue（映射正确）', () => {
  const text = renderStatusViews({ views: ['queues'], queue: { totals: { pending: 2 }, inflight: { current: 0, limit: 3 }, fairness: { strategy: 'fifo' } } });
  assert.match(text, /排队 2/);
  assert.match(text, /公平性 fifo/);
});
