// tests/unit/ui-virtual-list.test.mjs —— extension/ui/lib/virtual-list.js 窗口计算单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROW_HEIGHTS,
  buildOffsets,
  computeVariableWindow,
  computeWindow,
  createVirtualModel,
  indexAtOffset,
} from '../../extension/ui/lib/virtual-list.js';

test('computeWindow：等行高窗口 + 占位高度守恒', () => {
  const window = computeWindow({ scrollTop: 0, viewportHeight: 100, rowHeight: 36, total: 50, overscan: 2 });
  assert.equal(window.start, 0);
  assert.equal(window.end, 5);
  assert.equal(window.topPad, 0);
  assert.equal(window.bottomPad, 45 * 36);
  assert.equal(window.totalHeight, 1800);
  assert.equal(window.visibleCount, 5);

  // 不变量：窗口覆盖可视区
  assert.ok(window.start * 36 <= 0);
  assert.ok(window.end * 36 >= 100, '窗口必须覆盖整屏');

  const scrolled = computeWindow({ scrollTop: 500, viewportHeight: 100, rowHeight: 36, total: 50, overscan: 2 });
  assert.equal(scrolled.start, 11);
  assert.equal(scrolled.end, 19);
  assert.equal(scrolled.topPad, 11 * 36);
  assert.equal(scrolled.bottomPad, (50 - 19) * 36);
  // 占位守恒：topPad + 已渲染高度 + bottomPad = 总高
  assert.equal(scrolled.topPad + (scrolled.end - scrolled.start) * 36 + scrolled.bottomPad, scrolled.totalHeight);
});

test('computeWindow：空列表/越界滚动/overscan=0', () => {
  assert.deepEqual(computeWindow({ total: 0 }), { start: 0, end: 0, topPad: 0, bottomPad: 0, totalHeight: 0, visibleCount: 0 });
  const over = computeWindow({ scrollTop: 999999, viewportHeight: 100, rowHeight: 36, total: 10 });
  assert.equal(over.start, 9, '滚动超过末尾时窗口贴最后一行');
  assert.equal(over.end, 10);
  assert.equal(over.bottomPad, 0);
  const noOverscan = computeWindow({ scrollTop: 0, viewportHeight: 72, rowHeight: 36, total: 10, overscan: 0 });
  assert.equal(noOverscan.start, 0);
  assert.equal(noOverscan.end, 2);
  const negative = computeWindow({ scrollTop: -50, viewportHeight: -1, rowHeight: 0, total: -3 });
  assert.equal(negative.start, 0);
  assert.equal(negative.end, 0);
  assert.equal(negative.totalHeight, 0);
});

test('buildOffsets / indexAtOffset', () => {
  assert.deepEqual(buildOffsets([10, 20, 30]), [0, 10, 30, 60]);
  assert.deepEqual(buildOffsets([]), [0]);
  assert.deepEqual(buildOffsets(['x', -5, 8]), [0, 0, 0, 8]);
  const offsets = buildOffsets([10, 20, 30]);
  assert.equal(indexAtOffset(offsets, 0), 0);
  assert.equal(indexAtOffset(offsets, 9), 0);
  assert.equal(indexAtOffset(offsets, 10), 1);
  assert.equal(indexAtOffset(offsets, 29), 1);
  assert.equal(indexAtOffset(offsets, 30), 2);
  assert.equal(indexAtOffset(offsets, 999), 2);
  assert.equal(indexAtOffset([0], 10), 0);
});

test('computeVariableWindow：变行高窗口', () => {
  const offsets = buildOffsets([10, 20, 30]);
  const window = computeVariableWindow({ offsets, scrollTop: 12, viewportHeight: 15, overscan: 0 });
  assert.equal(window.start, 1);
  assert.equal(window.end, 2, 'offset 12–27 只覆盖第 2 行（第三行从 30 开始）');
  assert.equal(window.topPad, 10);
  assert.equal(window.bottomPad, 30);
  assert.equal(window.totalHeight, 60);
  const first = computeVariableWindow({ offsets, scrollTop: 0, viewportHeight: 10, overscan: 0 });
  assert.equal(first.start, 0);
  assert.equal(first.end, 2, '边界命中的下一行会多渲染一行（无害）');
  assert.equal(computeVariableWindow({ offsets: [0] }).end, 0);
});

test('createVirtualModel：等行高模式', () => {
  const model = createVirtualModel({ rowHeight: 36, total: 10, overscan: 3 });
  assert.equal(model.variable, false);
  assert.equal(model.total, 10);
  model.setViewport(72);
  const window = model.window();
  assert.equal(window.start, 0);
  assert.equal(window.end, 5);
  assert.equal(model.totalHeight(), 360);
  assert.equal(model.offsetOf(3), 108);
  assert.equal(model.offsetOf(999), 9 * 36, '越界索引夹到末行');
  assert.equal(model.heightOf(2), 36);
  assert.equal(model.heightOf(999), 36);
  assert.equal(model.scrollToIndex(5, { align: 'start' }), 180);
  assert.equal(model.scrollToIndex(5, { align: 'end' }), 216 - 72);
  assert.equal(model.scrollToIndex(0), 0, '已在视口内则不动');
  model.setScroll(108);
  assert.equal(model.scrollToIndex(2), 72, '行在视口上方时向上滚动到它');
  assert.equal(model.scrollToIndex(5), 144, '行在视口下方时向下滚动到它');
  model.setTotal(3);
  assert.equal(model.total, 3);
  assert.equal(model.variable, false);
});

test('createVirtualModel：变行高模式', () => {
  const model = createVirtualModel({ heights: [12, 24, 36], overscan: 1 });
  assert.equal(model.variable, true);
  assert.equal(model.total, 3);
  assert.equal(model.totalHeight(), 72);
  assert.equal(model.offsetOf(1), 12);
  assert.equal(model.heightOf(2), 36);
  model.setViewport(12);
  const window = model.window();
  assert.equal(window.start, 0);
  assert.equal(window.end, 3);
  model.setHeights([10, 10, 10, 10]);
  assert.equal(model.total, 4);
  assert.equal(model.totalHeight(), 40);
});

test('ROW_HEIGHTS 提供常用估值', () => {
  assert.deepEqual({ ...ROW_HEIGHTS }, { compact: 30, single: 36, double: 56, action: 64 });
});
