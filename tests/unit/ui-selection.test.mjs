// tests/unit/ui-selection.test.mjs —— extension/ui/lib/selection.js 多选模型单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSelection, difference, intersect } from '../../extension/ui/lib/selection.js';

test('click 切换 + 锚点', () => {
  const selection = createSelection({ order: ['a', 'b', 'c'] });
  assert.deepEqual(selection.click('a'), ['a']);
  assert.equal(selection.anchor, 'a');
  assert.deepEqual(selection.click('b'), ['a', 'b']);
  assert.equal(selection.anchor, 'b');
  assert.deepEqual(selection.click('b'), ['a'], '重复点击取消选择');
  assert.equal(selection.has('b'), false);
  assert.equal(selection.size, 1);
});

test('shiftClick 区间选择（与顺序无关的锚点）', () => {
  const selection = createSelection({ order: ['a', 'b', 'c', 'd', 'e'] });
  selection.setAnchor('b');
  assert.deepEqual(selection.shiftClick('d'), ['b', 'c', 'd']);
  // 反向区间
  selection.clear();
  selection.setAnchor('d');
  assert.deepEqual(selection.shiftClick('b'), ['b', 'c', 'd']);
  // 没有锚点时退化为单选加入
  selection.clear();
  assert.deepEqual(selection.shiftClick('c'), ['c']);
  assert.equal(selection.anchor, 'c');
  // 不在 order 里的 key 不改变选择
  const before = selection.selected;
  assert.deepEqual(selection.shiftClick('zzz'), before);
});

test('limit：超过上限按列表顺序截断', () => {
  const selection = createSelection({ order: ['a', 'b', 'c', 'd'], limit: 2 });
  assert.deepEqual(selection.selectAll(['d', 'a', 'c']), ['a', 'c']);
  assert.equal(selection.summary().full, true);
  assert.deepEqual(selection.summary().keys.sort(), ['a', 'c']);
  const wide = createSelection({ order: ['a', 'b'], limit: 0 });
  assert.deepEqual(wide.selectAll(['a', 'b']), ['a', 'b'], 'limit=0 表示不限制');
  assert.equal(wide.summary().full, false);
});

test('prune / remove / ordered 保持列表顺序', () => {
  const selection = createSelection({ order: ['a', 'b', 'c', 'd'], selected: ['d', 'b'] });
  assert.deepEqual(selection.ordered(), ['b', 'd']);
  assert.deepEqual(selection.prune(['a', 'b']), ['b']);
  assert.equal(selection.anchor, null);
  selection.setAnchor('b');
  assert.deepEqual(selection.remove('b'), []);
  assert.equal(selection.anchor, null);
  assert.deepEqual(selection.ordered(), []);
  declarationFree();
});

function declarationFree() {
  // 占位：确认没有意外副作用（无 document 引用等）
  assert.equal(typeof document, 'undefined');
}

test('setOrder 去重并保留已选', () => {
  const selection = createSelection();
  assert.deepEqual(selection.setOrder(['b', 'a', 'b']), ['b', 'a']);
  selection.click('a');
  assert.equal(selection.size, 1);
  assert.deepEqual(selection.setOrder(['a']), ['b', 'a'], '已记录的 key 不会被重复追加');
});

test('intersect / difference', () => {
  assert.deepEqual(intersect(['a', 'b', 'c'], ['b', 'c', 'd']).sort(), ['b', 'c']);
  assert.deepEqual(difference(['a', 'b', 'c'], ['b']).sort(), ['a', 'c']);
  assert.deepEqual(intersect(null, null), []);
  assert.deepEqual(difference([], ['a']), []);
});
