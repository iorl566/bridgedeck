// tests/unit/ui-focus.test.mjs —— extension/ui/lib/focus.js 焦点模型单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFocusReturnStack,
  createGridModel,
  createRovingModel,
  focusWithin,
  orderFocusables,
  topmostTrap,
  trapStep,
} from '../../extension/ui/lib/focus.js';

test('createRovingModel：唯一 tabindex=0 + 循环移动', () => {
  const model = createRovingModel({ total: 5, activeIndex: 0 });
  assert.equal(model.activeIndex, 0);
  assert.equal(model.tabIndexAt(0), 0);
  assert.equal(model.tabIndexAt(1), -1);
  assert.deepEqual(model.attributesFor(0), { tabindex: 0, 'aria-selected': 'true' });
  assert.deepEqual(model.attributesFor(1), { tabindex: -1, 'aria-selected': 'false' });

  assert.equal(model.move(1), 1);
  assert.equal(model.move(-1), 0);
  assert.equal(model.move(-1), 4, '默认 wrap=true 循环');
  assert.equal(model.move(1), 0);
  assert.equal(model.moveTo(3), 3);
  assert.equal(model.moveTo(99), 4, '越界夹到末项');
  assert.equal(model.first(), 0);
  assert.equal(model.last(), 4);

  model.setTotal(2);
  assert.equal(model.total, 2);
  assert.equal(model.activeIndex, 1, '收缩后活动项夹到末项');
  model.setTotal(0);
  assert.equal(model.activeIndex, -1);
  assert.equal(model.move(1), -1);
  assert.equal(model.tabIndexAt(0), -1);
});

test('createRovingModel：默认无活动项，方向键落位', () => {
  const model = createRovingModel({ total: 3 });
  assert.equal(model.activeIndex, -1);
  assert.equal(model.move(1), 0, '没有活动项时 ↓ 落到第一项');
  assert.equal(model.onArrow('ArrowDown'), 1);
  assert.equal(model.onArrow('ArrowUp'), 0);
  assert.equal(model.onArrow('Home'), 0);
  assert.equal(model.onArrow('End'), 2);
  assert.equal(model.onArrow('Enter'), null, '非方向键返回 null，页面不 preventDefault');

  const noWrap = createRovingModel({ total: 3, activeIndex: 0, wrap: false });
  assert.equal(noWrap.onArrow('ArrowUp'), 0);
  assert.equal(noWrap.move(1), 1);

  const horizontal = createRovingModel({ total: 3, orientation: 'horizontal', activeIndex: 1 });
  assert.equal(horizontal.onArrow('ArrowDown'), 1, '横向列表 ↑↓ 不移动');
  assert.equal(horizontal.onArrow('ArrowRight'), 2);
  assert.equal(horizontal.onArrow('ArrowLeft'), 1);
});

test('createGridModel：二维导航与 wrap', () => {
  const grid = createGridModel({ rows: 2, cols: 3, row: 0, col: 0 });
  assert.equal(grid.index(), 0);
  assert.equal(grid.onArrow('ArrowRight'), 1);
  assert.equal(grid.onArrow('ArrowDown'), 4);
  assert.equal(grid.onArrow('ArrowLeft'), 3);
  assert.equal(grid.onArrow('ArrowUp'), 0);
  assert.equal(grid.onArrow('Home'), 0);
  assert.equal(grid.onArrow('End'), 2);
  assert.equal(grid.onArrow('Enter'), null);
  assert.equal(grid.tabIndexAt(2), 0);
  assert.equal(grid.tabIndexAt(0), -1);

  grid.setSize(2, 2);
  assert.equal(grid.index(), 1, '列数收缩后索引按新布局重算');

  const wrapped = createGridModel({ rows: 2, cols: 2, row: 0, col: 0, wrap: true });
  assert.equal(wrapped.move(-1, 0), 2, 'wrap 时上移到最后一行');
  assert.equal(wrapped.move(0, -1), 3, 'wrap 时左移回行尾');
  assert.equal(createGridModel({ rows: 0, cols: 0 }).index(), -1);
});

test('trapStep：Tab 循环', () => {
  assert.equal(trapStep(0, 3), 1);
  assert.equal(trapStep(2, 3), 0, '末项 Tab 回到首项');
  assert.equal(trapStep(0, 3, { shift: true }), 2, '首项 Shift+Tab 到末项');
  assert.equal(trapStep(1, 3, { shift: true }), 0);
  assert.equal(trapStep(0, 3, { wrap: false }), 1, '不循环时首项 Tab 正常前进');
  assert.equal(trapStep(2, 3, { wrap: false }), 2, '不循环时末项 Tab 停住');
  assert.equal(trapStep(0, 0), -1);
});

test('createFocusReturnStack：面板收起后焦点还给触发按钮', () => {
  const stack = createFocusReturnStack();
  const focused = [];
  const opener = { isConnected: true, focus: (options) => focused.push(options) };
  assert.equal(stack.push(opener), 1);
  assert.equal(stack.depth, 1);
  const popped = stack.pop();
  assert.equal(popped, opener);
  assert.deepEqual(focused, [{ preventScroll: true }]);
  assert.equal(stack.depth, 0);

  // 已从 DOM 移除的元素不能抢焦点
  const detached = { isConnected: false, focus: () => { throw new Error('should not focus'); } };
  stack.push(detached);
  assert.equal(stack.pop(), detached);
  assert.equal(stack.depth, 0);

  const first = { isConnected: true, focus: () => focused.push('first') };
  const second = { isConnected: true, focus: () => focused.push('second') };
  stack.push(first);
  stack.push(second);
  assert.equal(stack.drop(), second, 'drop 只弹出不还焦点');
  assert.equal(stack.pop(), first);
  stack.push(first);
  stack.clear();
  assert.equal(stack.depth, 0);
  assert.equal(stack.push(null), 0, '空元素不入栈');
});

test('orderFocusables：过滤不可聚焦项并稳定排序', () => {
  const items = [
    { id: 'a', order: 2 },
    { id: 'b', hidden: true },
    { id: 'c', disabled: true },
    { id: 'd', ariaHidden: true },
    { id: 'e', tabindex: -1 },
    { id: 'f', order: 1 },
    { id: 'g' },
  ];
  assert.deepEqual(orderFocusables(items).map((item) => item.id), ['f', 'a', 'g']);
  assert.deepEqual(orderFocusables(null), []);
});

test('focusWithin / topmostTrap', () => {
  assert.equal(focusWithin({ contains: () => true }, {}), true);
  assert.equal(focusWithin({ contains: () => false }, {}), false);
  assert.equal(focusWithin({ contains: () => { throw new Error('x'); } }, {}), false);
  assert.equal(focusWithin({ items: [1, 2] }, 2), true);
  assert.equal(focusWithin({ items: [1] }, 3), false);
  assert.equal(focusWithin(null, null), false);

  assert.equal(topmostTrap([]), null);
  assert.equal(topmostTrap(null), null);
  const low = { id: 'low', layer: 1 };
  const high = { id: 'high', layer: 2 };
  const disabled = { id: 'off', layer: 9, active: false };
  assert.equal(topmostTrap([low, high, disabled]).id, 'high');
  assert.equal(topmostTrap([{ id: 'only' }]).id, 'only');
});
