// tests/unit/ui-table.test.mjs —— extension/ui/lib/table.js 表格视图模型单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COLUMNS,
  ariaSort,
  buildRowModels,
  buildTableModel,
  cellText,
  filterRows,
  nextSort,
  normalizeColumns,
  rowLabel,
  sortRows,
} from '../../extension/ui/lib/table.js';

function sample() {
  return [
    { id: 'a', ts: 300, method: 'GET', status: 200, durationMs: 12, url: 'https://x/api/one' },
    { id: 'b', ts: 100, method: 'POST', status: 500, durationMs: 240, url: 'https://x/api/two' },
    { id: 'c', ts: 200, method: 'GET', status: 404, url: 'https://x/api/three' },
  ];
}

test('normalizeColumns：过滤非法列，补齐默认值', () => {
  const columns = normalizeColumns([
    { key: 'url', label: 'URL', numeric: false, width: '120' },
    { id: 'status' },
    { noKey: true },
    null,
  ]);
  assert.equal(columns.length, 2);
  assert.equal(columns[0].key, 'url');
  assert.equal(columns[0].label, 'URL');
  assert.equal(columns[0].sortable, true);
  assert.equal(columns[0].width, 120);
  assert.equal(columns[1].key, 'status');
  assert.equal(columns[1].label, 'status');
  assert.deepEqual(normalizeColumns(null), []);
  assert.ok(DEFAULT_COLUMNS.length >= 4);
});

test('cellText / rowLabel', () => {
  const row = { url: 'https://x/api', method: 'GET', durationMs: 12 };
  assert.equal(cellText({ key: 'method' }, row), 'GET');
  assert.equal(cellText({ key: 'durationMs', format: (value) => value + 'ms' }, row), '12ms');
  assert.equal(cellText({ key: 'x', text: (item) => item.method + '!' }, row), 'GET!');
  assert.equal(cellText({ key: 'missing' }, row), '');
  assert.equal(cellText({ key: 'x', format: () => { throw new Error('boom'); } }, row), '?');
  assert.equal(cellText(null, row), '');

  const columns = normalizeColumns([{ key: 'method' }, { key: 'url' }]);
  assert.equal(rowLabel(columns, row), 'GET · https://x/api');
  assert.equal(rowLabel(columns, { method: '', url: '' }), '');
});

test('sortRows：数字/字符串、null 最后、相等稳定', () => {
  const rows = sample();
  const byDuration = sortRows(rows, { key: 'durationMs', direction: 'desc' });
  assert.deepEqual(byDuration.map((row) => row.id), ['b', 'a', 'c'], '缺失 duration 的 c 排最后');

  const byStatus = sortRows(rows, { key: 'status', direction: 'asc' });
  assert.deepEqual(byStatus.map((row) => row.status), [200, 404, 500]);

  const byUrl = sortRows(rows, { key: 'url', direction: 'asc' });
  assert.deepEqual(byUrl.map((row) => row.id), ['a', 'c', 'b']);

  // 稳定：相同 status 保留原顺序
  const same = [{ id: 1, status: 200 }, { id: 2, status: 200 }, { id: 3, status: 200 }];
  assert.deepEqual(sortRows(same, { key: 'status' }).map((row) => row.id), [1, 2, 3]);
  assert.deepEqual(sortRows(null, { key: 'x' }), []);
  assert.deepEqual(sortRows(rows, null).map((row) => row.id), ['a', 'b', 'c']);
  // 不修改入参
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c']);
});

test('filterRows：大小写不敏感 + 自定义 predicate', () => {
  const rows = sample();
  assert.equal(filterRows(rows, 'API/TWO').length, 1);
  assert.equal(filterRows(rows, 'get').length, 2);
  assert.equal(filterRows(rows, '   ').length, 3);
  assert.equal(filterRows(rows, '').length, 3);
  assert.equal(filterRows(rows, 'nomatch').length, 0);
  const custom = filterRows(rows, '500', { predicate: (row) => String(row.status) === '500' });
  assert.equal(custom.length, 1);
  assert.equal(custom[0].id, 'b');
  assert.deepEqual(filterRows(null, 'x'), []);
});

test('buildTableModel：过滤 + 排序 + 分页', () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({
    id: 'id-' + index,
    ts: index,
    method: index % 2 ? 'POST' : 'GET',
    url: 'https://x/api/' + index,
  }));
  const model = buildTableModel(rows, {
    columns: [{ key: 'ts', numeric: true, sortable: true }, { key: 'method' }, { key: 'url' }],
    sort: { key: 'ts', direction: 'desc' },
    page: 2,
    pageSize: 20,
  });
  assert.equal(model.total, 45);
  assert.equal(model.filtered, 45);
  assert.equal(model.pages, 3);
  assert.equal(model.page, 2);
  assert.equal(model.rows.length, 20);
  assert.equal(model.rows[0].ts, 24, 'desc 排序后第 2 页从 ts=24 开始');
  assert.equal(model.empty, false);
  assert.equal(model.matching, true);

  const filtered = buildTableModel(rows, { columns: [{ key: 'url' }], query: 'api/3', page: 1, pageSize: 10 });
  assert.equal(filtered.filtered, 11);
  assert.equal(filtered.rows.length, 10);
  assert.equal(filtered.pages, 2);

  const empty = buildTableModel([], {});
  assert.equal(empty.empty, true);
  assert.equal(empty.matching, false);
  assert.equal(empty.pages, 0);
  assert.deepEqual(empty.rows, []);

  const noMatch = buildTableModel(rows, { query: 'zzz' });
  assert.equal(noMatch.empty, false);
  assert.equal(noMatch.matching, false);
  assert.equal(noMatch.rows.length, 0);

  const overflow = buildTableModel(rows, { page: 99, pageSize: 20 });
  assert.equal(overflow.page, 3, '越界页码夹到最后一页');
});

test('nextSort / ariaSort', () => {
  assert.deepEqual(nextSort(null, 'ts'), { key: 'ts', direction: 'asc' });
  assert.deepEqual(nextSort(null, 'durationMs', { numeric: true }), { key: 'durationMs', direction: 'desc' });
  assert.deepEqual(nextSort({ key: 'ts', direction: 'asc' }, 'ts'), { key: 'ts', direction: 'desc' });
  assert.deepEqual(nextSort({ key: 'ts', direction: 'desc' }, 'ts'), { key: 'ts', direction: 'asc' });
  assert.deepEqual(nextSort({ key: 'ts', direction: 'asc' }, 'url'), { key: 'url', direction: 'asc' });

  const columns = normalizeColumns([{ key: 'ts' }, { key: 'fixed', sortable: false }]);
  assert.equal(ariaSort(columns[0], { key: 'ts', direction: 'desc' }), 'descending');
  assert.equal(ariaSort(columns[0], { key: 'url', direction: 'asc' }), 'none');
  assert.equal(ariaSort(columns[1], { key: 'fixed', direction: 'asc' }), null);
  assert.equal(ariaSort(null, null), null);
});

test('buildRowModels：行号/选中态/单元格文本', () => {
  const columns = normalizeColumns([{ key: 'method' }, { key: 'url' }]);
  const selected = new Set(['b']);
  const models = buildRowModels(sample(), { columns, selected, startIndex: 10 });
  assert.equal(models.length, 3);
  assert.equal(models[0].index, 10);
  assert.equal(models[0].key, 'a');
  assert.equal(models[0].selected, false);
  assert.equal(models[1].selected, true);
  assert.equal(models[1].label, 'POST · https://x/api/two');
  assert.deepEqual(models[0].cells.map((cell) => cell.text), ['GET', 'https://x/api/one']);
  assert.equal(buildRowModels(null, { columns }).length, 0);
  const keyed = buildRowModels(sample(), { columns, rowKey: (row) => row.id.toUpperCase() });
  assert.equal(keyed[0].key, 'A');
});
