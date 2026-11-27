// tests/unit/ui-views.test.mjs —— extension/ui/views/*.js 纯视图模型单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSpans } from '../../extension/ui/lib/timeline.js';
import { describeTree } from '../../extension/ui/lib/render.js';
import {
  buildSequenceView,
  buildSpanDetail,
  buildTimelineControls,
  buildTimelineFromLayout,
  buildTimelineView,
  relayout,
} from '../../extension/ui/views/timeline-view.js';
import {
  buildCaptureCompareView,
  buildComparePicker,
  buildCompareView,
  buildSequenceCompareView,
  compareSummaryLine,
} from '../../extension/ui/views/compare-view.js';
import {
  buildDetailPanel,
  buildHistorySummary,
  buildHistoryView,
  buildPagingControls,
  defaultColumns,
} from '../../extension/ui/views/history-view.js';

const SPANS = buildSpans([
  { id: 'a', url: '/api/a', ts: 1000, durationMs: 50 },
  { id: 'b', url: '/api/b', ts: 1020, durationMs: 80 },
]);

test('buildTimelineView：空态与非空树', () => {
  const empty = buildTimelineView({ spans: [], lang: 'zh' });
  assert.equal(empty.empty, true);
  assert.equal(empty.tree.attrs.role, 'status');

  const view = buildTimelineView({ spans: SPANS, width: 320, lang: 'zh', title: '请求时间线' });
  assert.equal(view.empty, false);
  assert.equal(view.tree.attrs.role, 'group');
  assert.ok(view.ariaLabel.includes('2'));
  const stats = describeTree(view.tree);
  assert.ok(stats.elements >= 4, '时间线树应有刻度/轨道/柱');
  assert.equal(view.model.spans.length, 2);
  assert.ok(view.summaryLine.includes('跨度'));

  const withClick = buildTimelineView({ spans: SPANS, width: 320, onBar: () => {} });
  assert.equal(withClick.empty, false);

  const english = buildTimelineView({ spans: SPANS, width: 320, lang: 'en' });
  assert.ok(english.ariaLabel.includes('spans'));
});

test('buildSequenceView：步骤序列', () => {
  const empty = buildSequenceView({ items: [], lang: 'en' });
  assert.equal(empty.empty, true);
  assert.match(empty.tree.attrs.class, /state-block/);
  const view = buildSequenceView({
    items: [{ label: 'click #a', at: 1000 }, { label: 'input #b' }],
    width: 200,
    onStep: () => {},
  });
  assert.equal(view.empty, false);
  assert.equal(view.count, 2);
  assert.equal(view.tree.attrs.role, 'list');
  const stats = describeTree(view.tree);
  assert.equal(stats.elements, 3, '容器 + 两个步骤按钮');
});

test('buildTimelineControls / buildSpanDetail / buildTimelineFromLayout / relayout', () => {
  const controls = buildTimelineControls({ lang: 'zh', onZoomIn: () => {}, onZoomOut: () => {}, onReset: () => {} });
  assert.equal(controls.length, 3);
  for (const control of controls) assert.equal(control.tag, 'button');
  assert.equal(controls[0].on.click instanceof Function, true);

  const detail = buildSpanDetail({ span: SPANS[0], lang: 'zh' });
  assert.equal(detail.attrs.role, 'group');
  const emptyDetail = buildSpanDetail({ span: null, lang: 'zh' });
  assert.match(emptyDetail.attrs.class, /state-block/);

  const layout = relayout(SPANS, { domain: { min: 1000, max: 1100 }, width: 100 });
  assert.equal(layout.placements.length, 2);
  const fromLayout = buildTimelineFromLayout(layout.placements, { lang: 'zh' });
  assert.equal(fromLayout.attrs.class, 'tl-track');
  assert.equal(fromLayout.children.length, 2);
});

test('buildCaptureCompareView：缺数据 / 有差异 / 无差异', () => {
  const missing = buildCaptureCompareView({ lang: 'zh' });
  assert.equal(missing.empty, true);
  assert.match(missing.tree.attrs.class, /state-block/);

  const base = { title: 'base run', requests: [{ method: 'GET', url: '/a', status: 200 }], console: [{ level: 'log', text: 'x' }] };
  const other = { title: 'other run', requests: [{ method: 'GET', url: '/b', status: 500 }], console: [{ level: 'error', text: 'y' }] };
  const view = buildCaptureCompareView({ base, other, lang: 'zh' });
  assert.equal(view.empty, false);
  assert.equal(view.summary.identical, false);
  assert.equal(view.summary.added, 2, '1 个新增请求 + 1 条新增控制台输出');
  assert.equal(view.summary.removed, 2);
  assert.equal(view.summary.changed, 0);
  const stats = describeTree(view.tree);
  assert.ok(stats.elements >= 6, '对比树应包含摘要与分区');
  assert.ok(JSON.stringify(view.tree).includes('/b'));

  const same = buildCaptureCompareView({ base, other: base, lang: 'en' });
  assert.equal(same.summary.identical, true);
  assert.ok(same.tree.children.some((child) => child.children && String(child.children[0]).includes('identical')));
});

test('buildSequenceCompareView / buildCompareView', () => {
  const left = [{ type: 'click', selector: '#a' }, { type: 'click', selector: '#b' }];
  const right = [{ type: 'click', selector: '#a' }];
  const view = buildSequenceCompareView({ leftEvents: left, rightEvents: right, lang: 'zh', title: '对比' });
  assert.equal(view.empty, false);
  assert.equal(view.stats.removed, 1);
  assert.ok(view.tree.children.length >= 2);
  assert.ok(Array.isArray(view.result.hunks));
  assert.ok(view.result.hunks.length >= 1 || view.rows.length >= 1);

  const empty = buildSequenceCompareView({ leftEvents: [], rightEvents: [], lang: 'zh' });
  assert.equal(empty.empty, true);

  const capture = buildCompareView({ kind: 'capture', base: { requests: [] }, other: { requests: [] }, lang: 'zh' });
  assert.equal(capture.kind, 'capture');
  const events = buildCompareView({ kind: 'events', leftEvents: left, rightEvents: right, lang: 'zh' });
  assert.equal(events.kind, 'events');
});

test('buildComparePicker / compareSummaryLine', () => {
  const picker = buildComparePicker({
    records: [{ id: 'a', label: 'run a' }, { id: 'b', label: 'run b' }],
    base: 'a',
    other: 'b',
    lang: 'zh',
    onBase: () => {},
    onOther: () => {},
    onCompare: () => {},
  });
  assert.equal(picker.attrs.class.includes('toolbar'), true);
  assert.equal(picker.children.length, 5);
  const baseSelect = picker.children[1];
  assert.equal(baseSelect.tag, 'select');
  assert.equal(baseSelect.attrs['aria-label'], '基准');
  assert.equal(baseSelect.children.length, 2);
  assert.equal(baseSelect.children[0].attrs.selected, '');
  const disabled = buildComparePicker({ records: [], lang: 'en', disabled: true });
  assert.equal(disabled.children[4].attrs.disabled, '');

  assert.equal(compareSummaryLine({ identical: true }, 'zh'), '两条记录没有差异');
  assert.equal(compareSummaryLine({ added: 1, removed: 2, changed: 0 }, 'en'), '1 added / 2 removed / 0 changed');
  assert.equal(compareSummaryLine(null), '');
});

test('buildHistoryView：行/空态/过滤无匹配/分页', () => {
  const items = [
    { id: 'r1', title: 'first run', startedAt: 1000, requests: 3, console: 1, endedAt: 2000 },
    { id: 'r2', title: 'second run', startedAt: 2000, requests: 5, console: 2, endedAt: 3000 },
    { id: 'r3', title: 'third run', startedAt: 3000, requests: 0, console: 0 },
  ];
  const view = buildHistoryView({ items, kind: 'debug', lang: 'zh', page: 1, pageSize: 2 });
  assert.equal(view.body.attrs.role, 'list');
  assert.equal(view.body.children.length, 2);
  assert.equal(view.model.filtered, 3);
  assert.equal(view.paging.pages, 2);
  assert.ok(view.controls.children.length >= 3);

  const empty = buildHistoryView({ items: [], kind: 'debug', lang: 'zh' });
  assert.match(empty.body.attrs.class, /state-block/);
  assert.match(empty.body.attrs.class, /empty/);

  const noMatch = buildHistoryView({ items, kind: 'debug', lang: 'zh', query: 'zzz' });
  assert.match(noMatch.body.attrs.class, /state-block/);
  assert.ok(JSON.stringify(noMatch.body).includes('没有匹配的条目'));

  const filtered = buildHistoryView({ items, kind: 'debug', lang: 'zh', query: 'second' });
  assert.equal(filtered.model.filtered, 1);

  const sorted = buildHistoryView({ items, kind: 'debug', lang: 'zh', sort: { key: 'ts', direction: 'desc' } });
  assert.equal(sorted.model.rows[0].ts, 3000);

  const selected = buildHistoryView({ items, kind: 'debug', lang: 'zh', selected: ['r2'] });
  assert.equal(selected.rows[1].attrs['aria-selected'], 'true');

  const clicked = [];
  const withClick = buildHistoryView({ items, kind: 'debug', lang: 'zh', onRowClick: (index) => clicked.push(index) });
  withClick.rows[0].on.click();
  assert.deepEqual(clicked, [0]);
  withClick.rows[0].on.keydown({ key: 'Enter', preventDefault: () => {} });
  assert.deepEqual(clicked, [0, 0]);

  const withActions = buildHistoryView({ items, kind: 'debug', lang: 'zh', actions: () => [] });
  assert.equal(withActions.rows.length, 3);
});

test('defaultColumns / buildPagingControls / buildDetailPanel / buildHistorySummary', () => {
  assert.equal(defaultColumns('ops').length, 3);
  assert.equal(defaultColumns('unknown').length, 3);
  const columns = defaultColumns('debug');
  assert.equal(columns[0].format(1000) !== '', true);
  assert.equal(columns[1].sortable, true);

  const controls = buildPagingControls({ lang: 'en' });
  assert.equal(controls.children[0].attrs.disabled, '', '没有数据时上一页禁用');
  const withPages = buildPagingControls({
    paging: { page: 2, pages: 3, total: 45, hasPrev: true, hasNext: true, range: '21–40 / 45' },
    lang: 'zh',
    onPage: () => {},
  });
  assert.equal(withPages.children[0].attrs.disabled, undefined);
  assert.equal(withPages.children[2].attrs['data-page-action'], 'next');

  const detail = buildDetailPanel({
    item: { url: 'https://x', title: 't', startedAt: 1000, endedAt: 2000, requests: [{ durationMs: 10 }], console: [1] },
    kind: 'debug',
    lang: 'zh',
  });
  assert.equal(detail.attrs.role, 'group');
  assert.ok(describeTree(detail).elements >= 4);
  const emptyDetail = buildDetailPanel({ item: null, lang: 'zh' });
  assert.match(emptyDetail.attrs.class, /state-block/);
  const opsDetail = buildDetailPanel({ item: { url: 'u', events: [1, 2] }, kind: 'ops' });
  assert.ok(JSON.stringify(opsDetail).includes('events'));
  const auditDetail = buildDetailPanel({ item: { method: 'page.goto', ok: true }, kind: 'audit' });
  assert.ok(JSON.stringify(auditDetail).includes('page.goto'));

  const summary = buildHistorySummary({ model: { filtered: 7 }, selected: ['a'], lang: 'zh' });
  assert.match(summary.attrs.class, /muted/);
  assert.ok(JSON.stringify(summary).includes('7'));
  const noSelection = buildHistorySummary({ model: { filtered: 0 } });
  assert.ok(JSON.stringify(noSelection).includes('0'));
});
