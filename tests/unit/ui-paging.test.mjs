// tests/unit/ui-paging.test.mjs —— extension/ui/lib/paging.js 分页模型单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PAGE_SIZE,
  buildPagingModel,
  clampPage,
  createCursorPager,
  pageBounds,
  pageCount,
  pageEdges,
  pageForKey,
  pageWindow,
  rangeLabel,
  slicePage,
} from '../../extension/ui/lib/paging.js';

test('pageCount / clampPage 边界', () => {
  assert.equal(DEFAULT_PAGE_SIZE, 20);
  assert.equal(pageCount(0, 20), 0);
  assert.equal(pageCount(1, 20), 1);
  assert.equal(pageCount(20, 20), 1);
  assert.equal(pageCount(21, 20), 2);
  assert.equal(pageCount(500, 100), 5);
  assert.equal(pageCount(-5, 20), 0);
  assert.equal(pageCount('x', 20), 0);

  assert.equal(clampPage(1, 0, 20), 1, '空集合保持第 1 页，避免出现 0/0 页');
  assert.equal(clampPage(99, 45, 20), 3);
  assert.equal(clampPage(-3, 45, 20), 1);
  assert.equal(clampPage(NaN, 45, 20), 1);
  assert.equal(clampPage('2', 45, 20), 2);
});

test('pageEdges / pageBounds / slicePage', () => {
  assert.deepEqual(pageEdges(1, 45, 20), { hasPrev: false, hasNext: true, pages: 3, page: 1 });
  assert.deepEqual(pageEdges(2, 45, 20), { hasPrev: true, hasNext: true, pages: 3, page: 2 });
  assert.deepEqual(pageEdges(3, 45, 20), { hasPrev: true, hasNext: false, pages: 3, page: 3 });
  assert.deepEqual(pageEdges(1, 0, 20), { hasPrev: false, hasNext: false, pages: 0, page: 1 });

  assert.deepEqual(pageBounds(2, 45, 20), { start: 20, end: 40, page: 2, pageSize: 20, total: 45 });
  assert.deepEqual(pageBounds(3, 45, 20), { start: 40, end: 45, page: 3, pageSize: 20, total: 45 });
  assert.deepEqual(pageBounds(1, 0, 20), { start: 0, end: 0, page: 1, pageSize: 20, total: 0 });

  const items = Array.from({ length: 45 }, (_, index) => index);
  const third = slicePage(items, 3, 20);
  assert.equal(third.items.length, 5);
  assert.equal(third.items[0], 40);
  assert.equal(third.items[4], 44);
  const overflow = slicePage(items, 99, 20);
  assert.equal(overflow.page, 3, '越界页码夹到最后一页');
  assert.equal(overflow.items.length, 5);
  assert.equal(slicePage(null, 1).items.length, 0);
});

test('pageWindow：≤7 页全列，>7 页首尾 + 邻居 + 省略号', () => {
  assert.deepEqual(pageWindow(1, 100, 20).items, [1, 2, 3, 4, 5], '5 页时全部列出');
  const many = pageWindow(5, 200, 20);
  assert.equal(many.pages, 10);
  assert.deepEqual(many.items, [1, '…', 4, 5, 6, '…', 10]);
  const first = pageWindow(1, 200, 20);
  assert.deepEqual(first.items, [1, 2, '…', 10]);
  const last = pageWindow(10, 200, 20);
  assert.deepEqual(last.items, [1, '…', 9, 10]);
  assert.deepEqual(pageWindow(1, 0, 20).items, []);
  assert.deepEqual(pageWindow(3, 200, 20, 2).items, [1, 2, 3, 4, 5, '…', 10], 'siblings=2 扩大邻居');
});

test('rangeLabel / pageForKey', () => {
  assert.equal(rangeLabel(1, 0, 20), '0 / 0');
  assert.equal(rangeLabel(1, 45, 20), '1–20 / 45');
  assert.equal(rangeLabel(2, 45, 20), '21–40 / 45');
  assert.equal(rangeLabel(3, 45, 20), '41–45 / 45');
  assert.equal(rangeLabel(1, 1234567, 20), '1–20 / 1,234,567');

  assert.equal(pageForKey(2, 45, 'PageDown', 20), 3);
  assert.equal(pageForKey(3, 45, 'PageDown', 20), 3, '最后一页不再前进');
  assert.equal(pageForKey(1, 45, 'PageUp', 20), 1);
  assert.equal(pageForKey(2, 45, 'PageUp', 20), 1);
  assert.equal(pageForKey(2, 45, 'Home', 20), 1);
  assert.equal(pageForKey(2, 45, 'End', 20), 3);
  assert.equal(pageForKey(2, 45, 'ArrowDown', 20), 2, '非分页键不改页码');
});

test('buildPagingModel 汇总视图状态', () => {
  const model = buildPagingModel({ page: 2, total: 45, pageSize: 20 });
  assert.equal(model.page, 2);
  assert.equal(model.pages, 3);
  assert.equal(model.total, 45);
  assert.equal(model.hasPrev, true);
  assert.equal(model.hasNext, true);
  assert.equal(model.range, '21–40 / 45');
  assert.equal(model.firstIndex, 20);
  assert.equal(model.lastIndex, 40);
  assert.equal(model.empty, false);
  const empty = buildPagingModel({ page: 5, total: 0 });
  assert.equal(empty.page, 1);
  assert.equal(empty.pages, 0);
  assert.equal(empty.empty, true);
  assert.equal(empty.range, '0 / 0');
  assert.equal(empty.hasNext, false);
});

test('createCursorPager：去重追加、游标、加载更多', () => {
  const pager = createCursorPager({ pageSize: 2, idOf: (item) => item.id });
  assert.equal(pager.size, 2);
  assert.equal(pager.done, false);
  assert.equal(pager.reset([{ id: 1 }, { id: 2 }], { nextCursor: 'c1', hasMore: true }), 2);
  assert.equal(pager.cursor, 'c1');
  assert.equal(pager.done, false);
  assert.deepEqual(pager.nextQuery(), { limit: 2, cursor: 'c1', after: 'c1' });
  assert.equal(pager.canLoadMore(), true);

  const added = pager.append([{ id: 2 }, { id: 3 }], { nextCursor: 'c2', hasMore: false });
  assert.equal(added, 1, '重复 id 不重复计数');
  assert.equal(pager.items.length, 3);
  assert.equal(pager.cursor, 'c2');
  assert.equal(pager.done, true);
  assert.equal(pager.canLoadMore(), false);
  assert.equal(pager.append([{ id: 9 }], {}), 1, '即使 done，append 仍可追加（页面兜底）');
  assert.equal(pager.loading, false);
  pager.setLoading(true);
  assert.equal(pager.canLoadMore(), false, '加载中不再发请求');
  assert.equal(pager.reset(null).valueOf(), 0);
  assert.deepEqual(pager.items, []);
});
