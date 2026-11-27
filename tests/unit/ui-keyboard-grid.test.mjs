// tests/unit/ui-keyboard-grid.test.mjs —— 网格键盘/选择模型（extension/ui/lib/keyboard-grid.js）单测。
//
// 覆盖：二维光标移动与夹取、循环开关、Home/End/PgUp/PgDn、roving tabindex、
// 选择集合（范围/切换/全选/裁剪）、类型前置缓冲、aria 属性与快捷键帮助。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PAGE_ROWS,
  applyGridIntent,
  applyListIntent,
  cellId,
  clampCursor,
  createGridSelection,
  createTypeahead,
  gridAria,
  gridRowAria,
  reconcileCursor,
  rovingTabIndex,
  selectionText,
  shortcutGroups,
} from '../../extension/ui/lib/keyboard-grid.js';

const DIMS = { rows: 5, cols: 4, pageRows: 2 };

test('光标夹取：空网格返回 -1，越界夹回，默认列 0', () => {
  assert.deepEqual(clampCursor({ row: 2, col: 2 }, 5, 4), { row: 2, col: 2 });
  assert.deepEqual(clampCursor({ row: 99, col: 99 }, 5, 4), { row: 4, col: 3 });
  assert.deepEqual(clampCursor({ row: -3, col: -2 }, 5, 4), { row: 0, col: 0 });
  assert.deepEqual(clampCursor({}, 0, 4), { row: -1, col: -1 });
  assert.deepEqual(clampCursor(null, 5, 0), { row: -1, col: -1 });
  assert.deepEqual(clampCursor(null, 5, 4), { row: 0, col: 0 });
});

test('二维移动：上下左右、边界不越界、wrap 选项', () => {
  assert.deepEqual(applyGridIntent({ row: 1, col: 1 }, 'down', DIMS), { row: 2, col: 1 });
  assert.deepEqual(applyGridIntent({ row: 1, col: 1 }, 'up', DIMS), { row: 0, col: 1 });
  assert.deepEqual(applyGridIntent({ row: 1, col: 1 }, 'right', DIMS), { row: 1, col: 2 });
  assert.deepEqual(applyGridIntent({ row: 1, col: 1 }, 'left', DIMS), { row: 1, col: 0 });
  assert.deepEqual(applyGridIntent({ row: 0, col: 3 }, 'right', DIMS), { row: 0, col: 3 });
  assert.deepEqual(applyGridIntent({ row: 4, col: 0 }, 'down', DIMS), { row: 4, col: 0 });
  // 行/列循环开关独立。
  assert.deepEqual(applyGridIntent({ row: 4, col: 0 }, 'down', { ...DIMS, wrapRows: true }), { row: 0, col: 0 });
  assert.deepEqual(applyGridIntent({ row: 0, col: 3 }, 'right', { ...DIMS, wrapCols: true }), { row: 0, col: 0 });
});

test('Home/End/PgUp/PgDn/first/last 与未知意图', () => {
  assert.deepEqual(applyGridIntent({ row: 2, col: 2 }, 'home', DIMS), { row: 2, col: 0 });
  assert.deepEqual(applyGridIntent({ row: 2, col: 2 }, 'home', { ...DIMS, homeToColumnStart: false }), { row: 0, col: 2 });
  assert.deepEqual(applyGridIntent({ row: 2, col: 2 }, 'end', DIMS), { row: 2, col: 3 });
  assert.deepEqual(applyGridIntent({ row: 3, col: 1 }, 'page-up', DIMS), { row: 1, col: 1 });
  assert.deepEqual(applyGridIntent({ row: 0, col: 1 }, 'page-up', DIMS), { row: 0, col: 1 });
  assert.deepEqual(applyGridIntent({ row: 1, col: 1 }, 'page-down', DIMS), { row: 3, col: 1 });
  assert.deepEqual(applyGridIntent({ row: 1, col: 1 }, 'page-down', { ...DIMS, pageRows: 99 }), { row: 4, col: 1 });
  assert.deepEqual(applyGridIntent({ row: 3, col: 1 }, 'first', DIMS), { row: 0, col: 0 });
  assert.deepEqual(applyGridIntent({ row: 1, col: 1 }, 'last', DIMS), { row: 4, col: 3 });
  assert.deepEqual(applyGridIntent({ row: 1, col: 1 }, 'tab', DIMS), { row: 1, col: 1 });
  assert.equal(DEFAULT_PAGE_ROWS, 10);
});

test('列表意图：复用网格语义（Home/End/PgUp/PgDn/空列表）', () => {
  assert.equal(applyListIntent(2, 'down', { total: 5 }), 3);
  assert.equal(applyListIntent(0, 'up', { total: 5 }), 0);
  assert.equal(applyListIntent(4, 'down', { total: 5 }), 4);
  assert.equal(applyListIntent(4, 'down', { total: 5, wrap: true }), 0);
  assert.equal(applyListIntent(4, 'end', { total: 5 }), 4);
  assert.equal(applyListIntent(4, 'home', { total: 5 }), 0);
  assert.equal(applyListIntent(0, 'page-down', { total: 5, pageSize: 2 }), 2);
  assert.equal(applyListIntent(4, 'page-up', { total: 5, pageSize: 2 }), 2);
  assert.equal(applyListIntent(0, 'down', { total: 0 }), -1);
});

test('roving tabindex：只有当前行 0，越界夹取，空列表全 -1', () => {
  assert.deepEqual(rovingTabIndex(3, 1), [-1, 0, -1]);
  assert.deepEqual(rovingTabIndex(3, -1), [0, -1, -1]);
  assert.deepEqual(rovingTabIndex(3, 9), [-1, -1, 0]);
  assert.deepEqual(rovingTabIndex(0, 0), []);
});

test('单元格 id / aria 属性', () => {
  assert.equal(cellId('p', 2, 3), 'p-r2-c3');
  assert.equal(cellId('p', 2), 'p-r2');
  assert.equal(cellId('', -1), 'bb-grid-r0');
  const grid = gridAria({ rows: 5, cols: 3, label: '数据表' });
  assert.deepEqual(grid, { role: 'grid', 'aria-rowcount': '5', 'aria-colcount': '3', 'aria-label': '数据表', 'aria-multiselectable': 'true' });
  assert.equal(gridAria({ multiselectable: false })['aria-multiselectable'], undefined);
  const row = gridRowAria({ index: 2, count: 5, label: '第 3 行', selected: true });
  assert.equal(row['aria-rowindex'], '3');
  assert.equal(row['aria-selected'], 'true');
  assert.equal(row['aria-setsize'], '5');
  assert.equal(gridRowAria({}).role, 'row');
});

test('选择集合：切换/范围/全选/清空/裁剪/上限', () => {
  const selection = createGridSelection();
  selection.toggle('a');
  assert.equal(selection.size, 1);
  assert.equal(selection.has('a'), true);
  selection.toggle('a');
  assert.equal(selection.size, 0);
  selection.select('b');
  assert.deepEqual(selection.keys, ['b']);
  selection.selectRange('d', ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual([...selection.keys].sort(), ['b', 'c', 'd']);
  selection.selectAll(['a', 'b', 'c']);
  assert.equal(selection.size, 3);
  selection.prune(['a', 'c']);
  assert.deepEqual([...selection.keys].sort(), ['a', 'c']);
  selection.clear();
  assert.equal(selection.size, 0);
  assert.equal(selection.summary('zh'), '已选 0 项');

  const limited = createGridSelection({ limit: 2 });
  limited.selectAll(['a', 'b', 'c', 'd']);
  assert.equal(limited.size, 2);
  limited.toggle('c');
  assert.equal(limited.size, 2);
});

test('选择集合：范围在 anchor 缺失时退化为单选；订阅通知', () => {
  const selection = createGridSelection();
  selection.selectRange('c', ['a', 'b', 'c']);
  assert.deepEqual(selection.keys, ['c']);
  const seen = [];
  const off = selection.subscribe((payload) => seen.push(payload.size));
  selection.toggle('a');
  off();
  selection.toggle('b');
  assert.deepEqual(seen, [2], '退订后不再通知，但状态仍继续变化');
  assert.equal(selection.size, 3);
  assert.equal(selection.summary('en'), '3 selected');
});

test('类型前置缓冲：短时间合字、超时重置、命中/未命中', () => {
  let time = 0;
  const typeahead = createTypeahead({ timeoutMs: 500, now: () => time });
  assert.equal(typeahead.push('a'), 'a');
  time += 100;
  assert.equal(typeahead.push('b'), 'ab');
  // 'ab' 前缀命中 about（下标 2）。
  assert.equal(typeahead.match(['alpha', 'beta', 'about']), 2);
  assert.equal(typeahead.query, 'ab');
  time += 100;
  assert.equal(typeahead.push('z'), 'abz');
  assert.equal(typeahead.match(['alpha', 'beta']), -1, '未命中后重置');
  assert.equal(typeahead.query, '');
  time += 100;
  assert.equal(typeahead.push('b'), 'b');
  assert.equal(typeahead.match(['alpha', 'beta']), 1);
  time += 1000;
  assert.equal(typeahead.push('a'), 'a', '超时后重新开始');
  typeahead.reset();
  assert.equal(typeahead.query, '');
});

test('快捷键帮助：已知意图分组，未知忽略', () => {
  const groups = shortcutGroups(['up', 'down', 'select', 'close', 'nope']);
  assert.deepEqual(groups.map((group) => group.intent), ['up', 'down', 'select', 'close']);
  assert.equal(groups[0].keys, '↑ / k');
  assert.equal(groups[0].labelKey, 'help.moveUp');
  assert.equal(shortcutGroups().length >= 9, true);
  assert.deepEqual(shortcutGroups([]), []);
});

test('数据刷新：光标修复与选中摘要', () => {
  assert.deepEqual(reconcileCursor({ row: 9, col: 2 }, 3, 4), { row: 2, col: 2 });
  assert.deepEqual(reconcileCursor({ row: 1, col: 1 }, 0, 4), { row: -1, col: -1 });
  assert.equal(selectionText(['a', 'b', 'c', 'd'], { limit: 3, lang: 'zh' }), '已选 4 项: a, b, c +1');
  assert.equal(selectionText([], { lang: 'zh' }), '');
});
