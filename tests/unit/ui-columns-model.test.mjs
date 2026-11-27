// tests/unit/ui-columns-model.test.mjs —— 列配置模型（extension/ui/lib/columns-model.js）单测。
//
// 覆盖：默认列/持久化往返、未知列与缺失列的修复、至少一列可见、顺序移动、
// 宽度夹取、排序状态、损坏配置回退、预设与本地化标签。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLUMNS_VERSION,
  COLUMN_PRESETS,
  COLUMN_TYPES,
  WIDTH_DEFAULT,
  WIDTH_MAX,
  WIDTH_MIN,
  clampWidth,
  columnsSignature,
  columnsSummary,
  createColumnsState,
  deserializeColumns,
  hideAllColumns,
  localizedColumnDefs,
  moveColumn,
  nextColumnSort,
  normalizeColumnDefs,
  orderedColumns,
  presetFor,
  repairColumnsState,
  resetColumns,
  resizeColumn,
  restoreColumns,
  serializeColumns,
  setColumnVisible,
  setColumnWidth,
  showAllColumns,
  toggleColumn,
  visibleColumns,
} from '../../extension/ui/lib/columns-model.js';

const DEFS = [
  { key: 'ts', label: 'Time', type: 'timestamp', width: 160 },
  { key: 'method', label: 'Method', type: 'string', width: 90 },
  { key: 'status', label: 'Status', type: 'number', width: 80, hideable: true },
  { key: 'url', label: 'URL', type: 'string', width: 320 },
];

test('规范化：未知类型回退 string、缺 key 跳过、重复 key 去重、宽度夹取', () => {
  const defs = normalizeColumnDefs([
    { key: 'a', type: 'number', width: 10 },
    { key: 'b', type: 'weird' },
    { label: 'no-key' },
    { key: 'a', label: 'dup' },
    { id: 'c', label: 'C' },
  ]);
  assert.deepEqual(defs.map((def) => def.key), ['a', 'b', 'c']);
  assert.equal(defs[0].width, WIDTH_MIN);
  assert.equal(defs[1].type, 'string');
  assert.equal(defs[0].sortable, true);
  assert.equal(defs[0].hideable, true);
  assert.equal(defs[2].label, 'C');
  assert.deepEqual([...COLUMN_TYPES], ['string', 'number', 'timestamp', 'boolean', 'json']);
  assert.equal(clampWidth('abc'), WIDTH_DEFAULT);
  assert.equal(clampWidth(-5), WIDTH_DEFAULT);
  assert.equal(clampWidth(9999), WIDTH_MAX);
  assert.equal(clampWidth(100.6), 101);
});

test('初始状态：默认可见、顺序与定义一致、无可视差异', () => {
  const state = createColumnsState(DEFS);
  assert.equal(state.version, COLUMNS_VERSION);
  assert.deepEqual(state.order, ['ts', 'method', 'status', 'url']);
  assert.equal(state.hidden.size, 0);
  assert.deepEqual(state.sort, { key: '', direction: 'asc' });
  assert.equal(visibleColumns(state).length, 4);
  const ordered = orderedColumns(state);
  assert.equal(ordered[0].canMoveUp, false);
  assert.equal(ordered[ordered.length - 1].canMoveDown, false);
  assert.equal(ordered[0].width, 160);
});

test('切换可见性：隐藏/显示、最后一列不能隐藏、不可隐藏列被拒', () => {
  let state = createColumnsState(DEFS);
  const hidden = toggleColumn(state, 'status');
  assert.equal(hidden.changed, true);
  assert.equal(hidden.reason, 'hidden');
  state = hidden.state;
  assert.equal(state.hidden.has('status'), true);
  assert.equal(visibleColumns(state).length, 3);

  const shown = toggleColumn(state, 'status');
  assert.equal(shown.reason, 'shown');
  assert.equal(shown.state.hidden.has('status'), false);
  state = shown.state;

  // 藏到只剩 1 列时再藏被拒绝。
  let one = createColumnsState(DEFS);
  for (const key of ['status', 'method', 'url']) one = toggleColumn(one, key).state;
  assert.equal(visibleColumns(one).length, 1);
  const rejected = toggleColumn(one, 'ts');
  assert.equal(rejected.changed, false);
  assert.equal(rejected.reason, 'last-visible');

  // hideable:false 的列被拒绝。
  const locked = createColumnsState([{ key: 'a', label: 'A', hideable: false }, { key: 'b', label: 'B' }]);
  assert.equal(toggleColumn(locked, 'a').reason, 'not-hideable');
  // 未知列。
  assert.equal(toggleColumn(locked, 'nope').reason, 'unknown');

  // setColumnVisible 幂等。
  assert.equal(setColumnVisible(state, 'status', true).changed, false);
  assert.equal(setColumnVisible(state, 'status', false).changed, true);
});

test('移动列：上下移动、边界拒绝、不影响可见性', () => {
  let state = createColumnsState(DEFS);
  const moved = moveColumn(state, 'status', -1);
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.state.order, ['ts', 'status', 'method', 'url']);
  state = moved.state;
  assert.deepEqual(moveColumn(state, 'ts', -1).reason, 'boundary');
  assert.deepEqual(moveColumn(state, 'url', 1).reason, 'boundary');
  assert.equal(moveColumn(state, 'nope', 1).reason, 'unknown');
  assert.equal(moveColumn(state, 'ts', 0).reason, 'noop');
});

test('宽度：夹取、步进、无效 key', () => {
  let state = createColumnsState(DEFS);
  const resized = resizeColumn(state, 'url', -2);
  assert.equal(resized.changed, true);
  assert.equal(resized.width, 320 - 32);
  state = resizeColumn(state, 'url', -100).state;
  assert.equal(state.widths.url, WIDTH_MIN);
  assert.equal(resizeColumn(state, 'url', -1).reason, 'noop');
  assert.equal(resizeColumn(state, 'nope', 1).reason, 'unknown');
  assert.equal(setColumnWidth(state, 'url', 5000).width, WIDTH_MAX);
});

test('显示全部 / 只留一列 / 恢复默认', () => {
  let state = createColumnsState(DEFS);
  state = toggleColumn(state, 'method').state;
  state = toggleColumn(state, 'url').state;
  const shown = showAllColumns(state);
  assert.equal(shown.changed, true);
  assert.equal(shown.state.hidden.size, 0);
  assert.equal(showAllColumns(shown.state).changed, false);

  const hiddenAll = hideAllColumns(state);
  assert.equal(hiddenAll.changed, true);
  assert.equal(visibleColumns(hiddenAll.state).length, 1);
  assert.ok(hiddenAll.kept);
  // 全部不可隐藏时拒绝。
  const locked = createColumnsState([{ key: 'a', label: 'A', hideable: false }]);
  assert.equal(hideAllColumns(locked).reason, 'no-hideable');

  const reset = resetColumns(hiddenAll.state);
  assert.equal(reset.changed, true);
  assert.equal(visibleColumns(reset.state).length, 4);
});

test('排序状态：同列翻转、新列数值默认降序、未知列拒绝', () => {
  let state = createColumnsState(DEFS);
  let sorted = nextColumnSort(state, 'method');
  assert.deepEqual(sorted.sort, { key: 'method', direction: 'asc' });
  state = sorted.state;
  sorted = nextColumnSort(state, 'method');
  assert.deepEqual(sorted.sort, { key: 'method', direction: 'desc' });
  sorted = nextColumnSort(state, 'status', { numeric: true });
  assert.deepEqual(sorted.sort, { key: 'status', direction: 'desc' });
  assert.equal(nextColumnSort(state, 'nope').reason, 'unknown');
});

test('序列化/反序列化：稳定字符串、往返一致、坏值返回 null', () => {
  let state = createColumnsState(DEFS);
  state = toggleColumn(state, 'status').state;
  state = moveColumn(state, 'url', -1).state;
  state = resizeColumn(state, 'ts', 1).state;
  state = nextColumnSort(state, 'ts', { numeric: true }).state;
  const text = serializeColumns(state);
  assert.match(text, /^v1:/);
  assert.equal(text, serializeColumns(state), '序列化必须稳定');
  const parsed = deserializeColumns(text);
  assert.ok(parsed);
  const round = createColumnsState(DEFS, parsed);
  assert.equal(columnsSignature(round), text);

  assert.equal(deserializeColumns(''), null);
  assert.equal(deserializeColumns('garbage'), null);
  assert.equal(deserializeColumns('v999:url'), null);
  // 非法宽度被丢弃、未知排序方向归一到 asc（而不是整个配置失败）。
  const tolerant = deserializeColumns('v1:url|ts;h=;w=url=abc;s=x:y');
  assert.deepEqual(tolerant.order, ['url', 'ts']);
  assert.deepEqual(tolerant.widths, {});
  assert.deepEqual(tolerant.sort, { key: 'x', direction: 'asc' });
});

test('修复：未知列丢弃、缺失新列补到末尾、宽度白名单', () => {
  const saved = {
    order: ['status', 'ghost', 'ts'],
    hidden: ['ghost', 'method'],
    widths: { ghost: 100, url: 9999 },
    sort: { key: 'ghost', direction: 'desc' },
  };
  const repaired = repairColumnsState({ version: COLUMNS_VERSION, defs: normalizeColumnDefs(DEFS), order: [], hidden: new Set(), widths: {}, sort: { key: '', direction: 'asc' } }, saved);
  assert.deepEqual(repaired.order, ['status', 'ts', 'method', 'url']);
  assert.equal(repaired.hidden.has('ghost'), false);
  assert.equal(repaired.hidden.has('method'), true);
  assert.equal(repaired.widths.url, WIDTH_MAX);
  assert.equal(repaired.widths.ghost, undefined);
  assert.deepEqual(repaired.sort, { key: '', direction: 'asc' });

  // 保存配置把全部列藏起来 → 强制恢复一列。
  const allHidden = repairColumnsState(createColumnsState(DEFS), { hidden: ['ts', 'method', 'status', 'url'] });
  assert.ok(visibleColumns(allHidden).length >= 1);
});

test('restoreColumns：空/损坏回退默认，旧版本报告 invalid', () => {
  const defaults = restoreColumns(DEFS, '');
  assert.equal(defaults.recovered, false);
  assert.equal(defaults.reason, 'empty');
  const invalid = restoreColumns(DEFS, 'v2:url');
  assert.equal(invalid.recovered, false);
  assert.equal(invalid.reason, 'invalid');
  const good = restoreColumns(DEFS, serializeColumns(toggleColumn(createColumnsState(DEFS), 'ts').state));
  assert.equal(good.recovered, true);
  assert.equal(good.state.hidden.has('ts'), true);
});

test('预设：每个表面都有默认列，未知回退 workspace；本地化标签', () => {
  for (const surface of ['workspace', 'audit', 'debug', 'ops', 'record', 'longshot']) {
    const preset = presetFor(surface);
    assert.ok(preset.length >= 3, surface + ' 预设列太少');
    assert.ok(preset.every((column) => column.key && column.labelKey));
  }
  assert.equal(presetFor('nope'), COLUMN_PRESETS.workspace);
  assert.ok(COLUMN_PRESETS.audit.some((column) => column.key === 'session'));
  const localized = localizedColumnDefs(presetFor('audit'), 'en');
  assert.equal(localized[0].label, 'Time');
  assert.equal(localized.find((column) => column.key === 'session').label, 'Session');
  const zh = localizedColumnDefs(presetFor('audit'), 'zh');
  assert.equal(zh[0].label, '时间');
});

test('摘要：可见/总数文本', () => {
  const state = toggleColumn(createColumnsState(DEFS), 'status').state;
  assert.equal(columnsSummary(state, 'zh'), '3 / 4 列可见');
  assert.equal(columnsSummary(state, 'en'), '3 of 4 columns visible');
  assert.equal(columnsSummary(null, 'zh'), '0 / 0 列可见');
});
