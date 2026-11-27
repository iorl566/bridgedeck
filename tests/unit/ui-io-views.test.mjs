// tests/unit/ui-io-views.test.mjs —— 第十一批 F 新视图模型单测（纯描述，无 DOM）。
//
// 覆盖：导入导出工具栏、过滤条、列配置面板、导入报告、导出预览、多维对比矩阵、
// 差异工具栏/行、空态视图。断言描述树里的 tag/文本/aria 与模型字段。
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeTree, flattenNodes } from '../../extension/ui/lib/render.js';
import { buildIoToolbar, buildDataStats, buildExportResultLine, buildLoadNotice, buildSplitNotice, LOAD_SOURCES } from '../../extension/ui/views/io-toolbar.js';
import { buildFilterBar, buildFilterEmptyHint, buildFilterSuggestions, describeFilterError } from '../../extension/ui/views/filter-bar.js';
import { buildColumnsPanel, buildColumnsNotice } from '../../extension/ui/views/columns-panel.js';
import { buildImportReport, buildImportConfirm, buildMergeChooser, importSummaryText } from '../../extension/ui/views/import-report.js';
import { buildExportPreview, buildExportWarnings, previewCell, previewSummary } from '../../extension/ui/views/export-preview.js';
import { buildFieldCompareMatrix, buildRowCompareMatrix, buildRunPicker, buildMatrixSummary, collectFields } from '../../extension/ui/views/compare-matrix.js';
import { buildDiffPanel, buildDiffRowsView, buildDiffToolbar, buildHunksSummary, buildInlineDiffRows, segmentsToNodes } from '../../extension/ui/views/diff-toolbar.js';
import { buildEmptyStateView, EMPTY_ACTION_KEYS, isEmptyVisible } from '../../extension/ui/views/empty-state-view.js';
import { createColumnsState, presetFor, toggleColumn } from '../../extension/ui/lib/columns-model.js';
import { createDiffNavigator } from '../../extension/ui/lib/diff-nav.js';
import { diffLines } from '../../extension/ui/lib/diff.js';

/** 收集描述树里所有文本（含按钮/单元格）。 */
function texts(descriptor) {
  const parts = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number') { parts.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.tag === '#text') { parts.push(String(node.text || '')); return; }
    if (node.text !== undefined && node.text !== null) parts.push(String(node.text));
    for (const child of node.children || []) walk(child);
  };
  walk(descriptor);
  return parts.join(' ');
}

/** 找第一个匹配 tag 的节点。 */
function findNode(descriptor, predicate) {
  let found = null;
  const walk = (node) => {
    if (found || node === null || node === undefined || typeof node !== 'object') return;
    if (node.tag && predicate(node)) { found = node; return; }
    for (const child of node.children || []) walk(child);
  };
  walk(descriptor);
  return found;
}

/** 找所有匹配 predicate 的节点。 */
function findAll(descriptor, predicate) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.tag && predicate(node)) found.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(descriptor);
  return found;
}

test('IO 工具栏：无数据时导出/复制禁用、有数据时可用、格式下拉 3 项', () => {
  const empty = buildIoToolbar({ surface: 'workspace', rows: 0, lang: 'zh' });
  assert.match(texts(empty.tree), /先导入或载入数据/);
  const exportButton = findNode(empty.tree, (node) => node.attrs && node.attrs['data-io-export'] === '1');
  assert.ok(exportButton);
  assert.equal(exportButton.attrs.disabled, '');
  const select = findNode(empty.tree, (node) => node.tag === 'select');
  assert.equal(select.children.length, 3);
  assert.deepEqual(select.children.map((option) => option.attrs.value), ['json', 'csv', 'ndjson']);
  assert.equal(empty.model.disabled, true);
  assert.equal(empty.model.rows, 0);

  const calls = [];
  const filled = buildIoToolbar({
    surface: 'audit',
    rows: 12,
    selected: 2,
    format: 'csv',
    onExport: (format) => calls.push(['export', format]),
    onCopy: (format) => calls.push(['copy', format]),
    onImport: () => calls.push(['import']),
    onLoad: (source) => calls.push(['load', source]),
    onClear: () => calls.push(['clear']),
  });
  assert.match(texts(filled.tree), /12 行/);
  assert.match(texts(filled.tree), /已选 2 行/);
  assert.equal(filled.model.buttonCount >= 7, true);
  const exportNode = findNode(filled.tree, (node) => node.attrs && node.attrs['data-io-export'] === '1');
  exportNode.on.click();
  assert.deepEqual(calls[0], ['export', 'csv']);
  const loadNode = findNode(filled.tree, (node) => node.attrs && node.attrs['data-io-load'] === 'ops');
  loadNode.on.click();
  assert.deepEqual(calls[calls.length - 1], ['load', 'ops']);
  assert.deepEqual(LOAD_SOURCES.map((item) => item.key), ['audit', 'debug', 'ops']);
  assert.equal(filled.model.sources.includes('debug'), true);
});

test('IO 辅助行：导出结果/载入提示/统计/分片', () => {
  assert.match(texts(buildExportResultLine({ rowCount: 3, bytes: 2048, redacted: 1, truncated: true })), /3 行/);
  assert.match(texts(buildExportResultLine({ rowCount: 0 })), /没有可导出的行/);
  assert.match(texts(buildLoadNotice('debug', { ok: true, count: 5 })), /5 行/);
  assert.match(texts(buildLoadNotice('debug', { error: new Error('boom') })), /boom/);
  assert.match(texts(buildDataStats({ rows: 2, bytes: 1024, selected: 1 })), /2 行/);
  assert.equal(buildSplitNotice([1]), null);
  assert.match(texts(buildSplitNotice([1, 2, 3])), /3 份/);
});

test('过滤条：芯片可删、常用过滤、摘要与错误文案', () => {
  const removed = [];
  const applied = [];
  const bar = buildFilterBar({
    surface: 'debug',
    query: 'status:>=400 method:GET',
    result: { matched: 0, total: 5 },
    onInput: () => {},
    onClear: () => {},
    onRemove: (chip) => removed.push(chip),
    onApplySaved: (query) => applied.push(query),
  });
  assert.equal(bar.model.chips.length, 2);
  assert.match(texts(bar.tree), /没有匹配 5 行中的任何一行/);
  const chipClose = findNode(bar.tree, (node) => node.attrs && node.attrs['data-filter-remove']);
  assert.ok(chipClose);
  chipClose.on.click();
  assert.equal(removed.length, 1);
  const savedNode = findNode(bar.tree, (node) => node.attrs && node.attrs['data-filter-saved']);
  assert.ok(savedNode, '应有常用过滤按钮');
  savedNode.on.click();
  assert.ok(applied.length === 1);
  assert.equal(bar.model.saved.length >= 2, true);
  // 未知字段错误 → 可读文案。
  assert.match(describeFilterError({ code: 'E_FILTER_UNKNOWN_FIELD', field: 'nope' }, 'zh'), /未知字段/);
  assert.match(describeFilterError({ code: 'E_FILTER_BAD_NUMBER', raw: 'status:>abc' }, 'zh'), /abc/);
  assert.equal(describeFilterError(null, 'zh').length > 0, true);
  // 过滤为空提示只在“有数据但没匹配”时出现。
  assert.equal(buildFilterEmptyHint({ matched: 1, total: 5 }), null);
  assert.match(texts(buildFilterEmptyHint({ matched: 0, total: 5 })), /没有匹配/);
  const suggestions = buildFilterSuggestions([{ field: 'status', label: '状态' }], { onPick: () => {} });
  assert.match(texts(suggestions), /status/);
  assert.equal(buildFilterSuggestions([]), null);
});

test('列配置面板：switch aria、移动/宽度按钮、摘要、拒绝提示', () => {
  let state = createColumnsState(presetFor('audit'));
  state = toggleColumn(state, 'tabId').state;
  const actions = [];
  const panel = buildColumnsPanel({
    state,
    onToggle: (key) => actions.push(['toggle', key]),
    onMove: (key, delta) => actions.push(['move', key, delta]),
    onResize: (key, steps) => actions.push(['resize', key, steps]),
    onReset: () => actions.push(['reset']),
    onShowAll: () => actions.push(['show-all']),
    onClose: () => actions.push(['close']),
  });
  assert.match(panel.model.summary, /6 \/ 7 列可见/);
  assert.equal(panel.model.columns.length, 7);
  const switches = [];
  const walk = (node) => { if (!node || typeof node !== 'object') return; if (node.attrs && node.attrs['data-col-toggle']) switches.push(node); for (const child of node.children || []) walk(child); };
  walk(panel.tree);
  assert.equal(switches.length, 7);
  assert.ok(switches.every((node) => node.attrs.role === 'switch' && ['true', 'false'].includes(node.attrs['aria-checked'])));
  // 隐藏行的 switch 点击触发 onToggle。
  const hiddenSwitch = switches.find((node) => node.attrs['data-col-toggle'] === 'tabId');
  hiddenSwitch.on.click();
  assert.deepEqual(actions[0], ['toggle', 'tabId']);
  const up = findNode(panel.tree, (node) => node.attrs && node.attrs['data-col-up']);
  assert.ok(up);
  assert.equal(findNode(panel.tree, (node) => node.attrs && node.attrs['data-col-show-all']) !== null, true);
  // 拒绝原因提示。
  assert.match(texts(buildColumnsNotice('last-visible', 'zh')), /至少保留一列/);
  assert.equal(buildColumnsNotice('noop'), null);
  assert.equal(buildColumnsNotice('resized'), null);
});

test('导入报告：有效/问题/重复/合并统计/错误行', () => {
  const report = buildImportReport({
    parsed: { ok: true, format: 'csv', objects: [{ a: '1' }], errors: [{ line: 3, index: 1, code: 'E_TYPE', field: 'a', message: 'bad' }], warnings: ['row-limit'], bytes: 2048 },
    validation: { ok: false, valid: 2, invalid: 1, duplicates: 1, errors: [], warnings: [] },
    merge: { stats: { existing: 5, imported: 3, appended: 2, replaced: 1, unchanged: 0, result: 7 } },
  });
  assert.equal(report.model.formatText, 'CSV');
  assert.match(report.model.summary, /2 \/ 1 行有效/);
  assert.match(texts(report.tree), /现有 5 行/);
  assert.equal(report.model.rows.length, 1);
  assert.match(texts(report.tree), /bad/);
  assert.match(importSummaryText({ total: 3, valid: 3 }), /3 \/ 3 行有效/);
  assert.match(importSummaryText({ total: 3, valid: 2, invalid: 1, duplicates: 2 }), /重复/);
  // 合并方式选择：当前值高亮，点击回调。
  const picked = [];
  const chooser = buildMergeChooser('merge', 'zh', (value) => picked.push(value));
  assert.equal(chooser.value, 'merge');
  assert.equal(chooser.options.length, 3);
  const radio = findNode(chooser.tree, (node) => node.attrs && node.attrs['data-merge-mode'] === 'append');
  radio.on.click();
  assert.deepEqual(picked, ['append']);
  assert.equal(buildMergeChooser('bogus').value, 'append');
  // 确认条两个按钮。
  const confirm = buildImportConfirm({ count: 3, onConfirm: () => {}, onCancel: () => {} });
  assert.match(texts(confirm), /3 行/);
  assert.ok(findNode(confirm, (node) => node.attrs && node.attrs['data-import-confirm']));
});

test('导出预览：列顺序、单元格、截断/脱敏提示、警告', () => {
  const payload = {
    fileName: 'bridge-audit-x.csv',
    mime: 'text/csv',
    format: 'csv',
    bytes: 4096,
    rowCount: 10,
    preview: [{ url: 'https://a', token: 'x' }, { url: 'https://b', token: 'y' }],
    redacted: 2,
    truncated: true,
    warnings: ['size-limit', 'no-rows'],
  };
  const columns = [{ key: 'url', label: 'URL' }, { key: 'token', label: 'Token' }];
  const preview = buildExportPreview({ payload, columns });
  assert.equal(preview.model.columns.length, 2);
  assert.equal(preview.model.rows.length, 2);
  assert.match(preview.model.summary, /10 行/);
  assert.match(texts(preview.tree), /bridge-audit-x\.csv/);
  assert.match(texts(preview.tree), /已脱敏 2 处/);
  // 行头只出现一次（第 1 行），不会重复拼。
  const previewHead = findNode(preview.tree, (node) => node.attrs && node.attrs.role === 'row');
  assert.ok(previewHead);
  assert.deepEqual(previewCell({ a: 1 }, { key: 'a' }), '1');
  assert.deepEqual(previewCell({ a: { b: 1 } }, { key: 'a' }), '{"b":1}');
  assert.equal(previewCell(null, { key: 'a' }), '');
  assert.equal(previewCell({ a: 1 }, { key: 'a', text: () => { throw new Error('x'); } }), '?');
  assert.equal(previewSummary({ rowCount: 2, bytes: 1024 }), '2 行 · 大小：1.0 KB');
  const warnings = buildExportWarnings(payload, 'zh');
  assert.match(texts(warnings), /截断/);
  assert.equal(buildExportWarnings({ warnings: [] }), null);
});

test('多维对比矩阵：字段差异标记/基准列/摘要/不可比提示', () => {
  const runs = [
    { id: 'a', label: 'run A', data: { status: 200, durationMs: 10 } },
    { id: 'b', label: 'run B', data: { status: 500, durationMs: 10 } },
    { id: 'c', label: 'run C', data: { status: 200, durationMs: 11 } },
  ];
  const matrix = buildFieldCompareMatrix({ runs, baselineIndex: 0 });
  assert.equal(matrix.model.fields.length, 2);
  assert.equal(matrix.model.differences, 2);
  assert.equal(matrix.model.baseline.label, 'run A');
  assert.match(texts(matrix.tree), /3 条记录/);
  const changedCells = matrix.model.fieldRows.find((row) => row.field === 'status').cells.map((cell) => cell.state);
  assert.deepEqual(changedCells, ['same', 'changed', 'same']);
  const changedCells2 = matrix.model.fieldRows.find((row) => row.field === 'durationMs').cells.map((cell) => cell.state);
  assert.deepEqual(changedCells2, ['same', 'same', 'changed']);
  // 缺失字段标 missing。
  const missing = buildFieldCompareMatrix({ runs: [{ data: { a: 1 } }, { data: {} }] });
  assert.equal(missing.model.fieldRows[0].cells[1].state, 'missing');
  const empty = buildFieldCompareMatrix({ runs: [] });
  assert.equal(empty.model.empty, true);
  assert.deepEqual(collectFields([{ a: 1 }, { b: 2, a: 3 }]), ['a', 'b']);
  assert.equal(collectFields(null).length, 0);
  assert.match(buildMatrixSummary(matrix.model), /2 处不同/);
});

test('行级对比矩阵：key 对齐、出现/缺失、截断提示', () => {
  const runs = [
    { label: 'A', rows: [{ url: '/a', status: 200 }, { url: '/b', status: 200 }] },
    { label: 'B', rows: [{ url: '/a', status: 500 }] },
  ];
  const matrix = buildRowCompareMatrix({ runs, keyOf: (row) => row.url, fields: ['status'] });
  assert.equal(matrix.model.keys.length, 2);
  assert.equal(matrix.model.rows[0].missing, 0);
  assert.equal(matrix.model.rows[1].missing, 1);
  assert.equal(matrix.model.rows[0].cells[0].changed, true);
  assert.match(texts(matrix.tree), /●/);
  const empty = buildRowCompareMatrix({ runs: [] });
  assert.equal(empty.model.empty, true);
});

test('多记录选择条：已选芯片可移除、候选项去重', () => {
  const removed = [];
  const picker = buildRunPicker({
    runs: [{ id: '1', label: 'A' }, { id: '2', label: 'B' }],
    choices: [{ id: '1', label: 'A' }, { id: '2', label: 'B' }, { id: '3', label: 'C' }],
    lang: 'zh',
    onPick: () => {},
    onRemove: (id) => removed.push(id),
  });
  const close = findNode(picker, (node) => node.attrs && node.attrs['data-run-remove'] === '2');
  close.on.click();
  assert.deepEqual(removed, ['2']);
  const select = findNode(picker, (node) => node.tag === 'select');
  assert.deepEqual(select.children.slice(1).map((option) => option.attrs.value), ['3']);
});

test('差异工具栏：位置/统计/只看差异/上下文选择与回调', () => {
  const nav = createDiffNavigator(diffLines('a\nb\nc', 'a\nB\nc'), { context: 1 });
  const snapshot = nav.snapshot();
  const calls = [];
  const toolbar = buildDiffToolbar({
    snapshot,
    lang: 'zh',
    onNext: () => calls.push('next'),
    onPrev: () => calls.push('prev'),
    onToggleOnlyChanges: (value) => calls.push(['only', value]),
    onChangeContext: (value) => calls.push(['context', value]),
  });
  assert.match(toolbar.model.text, /第 1 \/ 1 处差异/);
  assert.equal(toolbar.model.total, 1);
  assert.match(texts(toolbar.tree), /行变化/);
  findNode(toolbar.tree, (node) => node.attrs && node.attrs['data-diff-next'] === '1').on.click();
  findNode(toolbar.tree, (node) => node.attrs && node.attrs['data-diff-only'] === '1').on.click();
  assert.deepEqual(calls, ['next', ['only', true]]);
  const contextSelect = findNode(toolbar.tree, (node) => node.tag === 'select');
  contextSelect.on.change({ target: { value: '5' } });
  assert.deepEqual(calls[2], ['context', '5']);
});

test('差异行：插入/删除/折叠/空差异与行内片段', () => {
  const nav = createDiffNavigator(diffLines('a\nb\nc', 'a\nB\nc'), { onlyChanges: true, context: 0 });
  const rowsView = buildDiffRowsView({ snapshot: nav.snapshot(), lang: 'zh' });
  assert.ok(rowsView.model.changed >= 2);
  assert.equal(rowsView.model.empty, false);
  const identical = buildDiffRowsView({ snapshot: { rows: [] } });
  assert.equal(identical.model.empty, true);
  assert.match(texts(identical.tree), /没有差异/);
  // 折叠行有可访问名称。
  const folded = buildDiffRowsView({
    rows: [{ type: 'fold', count: 12 }],
  });
  assert.match(texts(folded.tree), /折叠 12 行/);
  // 行内差异：mark 只包变化片段。
  const inline = buildInlineDiffRows([
    { type: 'change', left: '/a', right: '/b', leftSegments: [{ type: 'same', text: '/' }, { type: 'delete', text: 'a' }], rightSegments: [{ type: 'same', text: '/' }, { type: 'insert', text: 'b' }] },
  ]);
  assert.equal(inline.model.changes, 1);
  const marks = findAll(inline.tree, (node) => node.tag === 'mark');
  assert.equal(marks.length, 2);
  assert.equal(segmentsToNodes([{ type: 'same', text: 'x' }])[0], 'x');
  assert.match(texts(buildHunksSummary({ total: 3, onlyChanges: false })), /3 个差异块/);
  assert.match(texts(buildHunksSummary({ total: 0 })), /没有差异/);
});

test('差异面板：工具栏与行组合，结构可统计', () => {
  const nav = createDiffNavigator(diffLines('a\nb', 'a\nc'), { context: 1 });
  const panel = buildDiffPanel({ snapshot: nav.snapshot(), lang: 'zh' });
  assert.ok(panel.toolbar.total >= 1);
  assert.ok(panel.rows.changed >= 2);
  assert.ok(describeTree(panel.tree).elements >= 8);
});

test('空态视图：原因映射、动作回调、aria-live 与不可见判定', () => {
  const actions = [];
  const empty = buildEmptyStateView({ surface: 'workspace', total: 4, matched: 0, query: 'x', onAction: (key) => actions.push(key) });
  assert.equal(empty.model.reason, 'no-match');
  assert.equal(empty.tree.attrs['data-empty-reason'], 'no-match');
  assert.equal(empty.tree.attrs['data-empty-icon'], 'search');
  const clearButton = findNode(empty.tree, (node) => node.attrs && node.attrs['data-empty-action'] === 'clear-filter');
  clearButton.on.click();
  assert.deepEqual(actions, ['clear-filter']);
  assert.equal(isEmptyVisible(empty.model), true);
  assert.match(EMPTY_ACTION_KEYS.import, /import/);
  // 首次进入：workspace 默认动作是 import。
  const first = buildEmptyStateView({ surface: 'workspace' });
  assert.equal(first.model.actions[0].key, 'import');
  assert.equal(first.model.reason, 'first-run');
  // 错误态：alert。
  const error = buildEmptyStateView({ surface: 'audit', error: { code: 'E_TIMEOUT' } });
  assert.equal(error.tree.attrs.role, 'alert');
  assert.equal(error.tree.attrs['aria-live'], 'assertive');
});
