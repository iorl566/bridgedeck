// tests/unit/ui-render.test.mjs —— extension/ui/lib/render.js 纯渲染描述单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEXT_NODE,
  button,
  describeTree,
  diffRow,
  flattenNodes,
  fragment,
  h,
  listRole,
  listRow,
  mapNodes,
  nodePath,
  sortHeader,
  stateBlock,
  text,
  timelineBar,
  timelineTick,
  when,
  withAria,
  withClass,
} from '../../extension/ui/lib/render.js';

test('h / text / fragment / flattenNodes', () => {
  const node = h('div', { class: 'row' }, ['a', h('span', {}, 'b')]);
  assert.equal(node.tag, 'div');
  assert.equal(node.attrs.class, 'row');
  assert.equal(node.children.length, 2);
  assert.deepEqual(text('x'), { tag: TEXT_NODE, text: 'x' });
  assert.equal(fragment(['a']).tag, '#fragment');
  assert.deepEqual(flattenNodes([[text('a')], null, 'b', 1, false, { tag: 'span' }]).map((item) => item.tag), [TEXT_NODE, TEXT_NODE, TEXT_NODE, 'span']);
  assert.deepEqual(flattenNodes(null), []);
});

test('describeTree：统计元素/文本/深度', () => {
  const tree = h('div', {}, [h('span', {}, 'a'), h('p', {}, [h('b', {}, 'c')])]);
  const stats = describeTree(tree);
  assert.equal(stats.elements, 4);
  assert.equal(stats.texts, 2);
  assert.equal(stats.maxDepth, 3, 'div → p → b → text 共 3 层');
  assert.ok(stats.textBytes >= 2);
  const withText = describeTree(h('div', { class: 'x' }, []));
  assert.equal(withText.elements, 1);
  assert.equal(describeTree(text('abc')).textBytes, 3);
});

test('withAria / withClass / when / mapNodes / nodePath', () => {
  const node = h('button', { class: 'btn primary', 'aria-label': 'keep' });
  const withAttrs = withAria(node, { 'aria-label': 'ignored', 'aria-pressed': 'false', 'aria-describedby': '' });
  assert.equal(withAttrs.attrs['aria-label'], 'keep', '不覆盖已有 aria');
  assert.equal(withAttrs.attrs['aria-pressed'], 'false');
  assert.equal(withAttrs.attrs['aria-describedby'], undefined, '空值不写入');
  assert.equal(node.attrs['aria-pressed'], undefined, '不修改原描述');

  const classed = withClass(node, 'primary extra');
  assert.equal(classed.attrs.class, 'btn primary extra');
  assert.equal(withClass(text('x'), 'a').tag, TEXT_NODE);

  assert.equal(when(false, node), null);
  assert.equal(when(true, node), node);
  assert.deepEqual(mapNodes([1, 2], (item) => (item === 2 ? null : text(String(item)))).length, 1);
  assert.equal(nodePath(['0', '', 'div', '2']), '0/div/2');
});

test('listRow / button / sortHeader / listRole', () => {
  const row = listRow({ index: 0, total: 3, label: 'row one' });
  assert.equal(row.tag, 'div');
  assert.equal(row.attrs.role, 'row');
  assert.equal(row.attrs['aria-rowindex'], '1');
  assert.equal(row.attrs['aria-selected'], 'false');
  assert.equal(row.attrs.tabindex, '-1');
  const selected = listRow({ index: 2, total: 3, label: 'row three', selected: true, disabled: true });
  assert.equal(selected.attrs['aria-selected'], 'true');
  assert.equal(selected.attrs.tabindex, '0');
  assert.equal(selected.attrs['aria-disabled'], 'true');
  assert.match(selected.attrs.class, /selected/);
  assert.match(selected.attrs.class, /disabled/);

  const btn = button({ label: '重试', tone: 'primary' });
  assert.equal(btn.tag, 'button');
  assert.equal(btn.attrs.type, 'button');
  assert.ok(btn.attrs.class.includes('primary'));
  assert.equal(btn.attrs['aria-label'], '重试');
  assert.equal(button({ label: 'x', disabled: true }).attrs.disabled, '');
  assert.equal(button({ label: 'y', on: { click: () => {} } }).on.click instanceof Function, true);

  const header = sortHeader({ label: 'time', sortDirection: 'ascending' });
  assert.equal(header.tag, 'th');
  assert.equal(header.attrs['aria-sort'], 'ascending');
  assert.equal(header.attrs.scope, 'col');
  assert.ok(Array.isArray(header.children));
  assert.equal(header.children[1], ' ▲');
  assert.equal(sortHeader({ label: 'x', sortDirection: 'descending' }).children[1], ' ▼');
  assert.equal(sortHeader({ label: 'x', sortDirection: null }).attrs['aria-sort'], undefined);

  assert.equal(listRole('table').role, 'table');
  assert.equal(listRole('listbox')['aria-multiselectable'], 'true');
  assert.equal(listRole().role, 'list');
});

test('timelineBar / timelineTick / diffRow', () => {
  const bar = timelineBar({ x: 10.4, y: 3, width: 0.2, height: 8, label: 'GET /api', tone: 'tone-a' });
  assert.equal(bar.attrs.role, 'img');
  assert.equal(bar.attrs['aria-label'], 'GET /api');
  assert.equal(bar.attrs.style.insetInlineStart, '10px');
  assert.equal(bar.attrs.style.width, '2px', '宽度地板 2px');
  assert.equal(bar.attrs.style.top, '3px');
  assert.match(bar.attrs.class, /tone-a/);

  const tick = timelineTick({ x: 50, label: '200ms' });
  assert.equal(tick.tag, 'span');
  assert.equal(tick.attrs['aria-hidden'], 'true');
  assert.equal(tick.attrs.style.insetInlineStart, '50px');

  const insertRow = diffRow({ type: 'insert', rightNumber: '3', text: 'new line' });
  assert.equal(insertRow.attrs.role, 'row');
  assert.match(insertRow.attrs.class, /insert/);
  const textNode = insertRow.children[2].children[1];
  assert.equal(textNode.trim(), 'new line');
  assert.equal(diffRow({ type: 'delete', text: 'gone' }).children[2].children[0], '- ');
});

test('stateBlock：空/错误/重试按钮', () => {
  const empty = stateBlock({ kind: 'empty', message: '没有记录' });
  assert.equal(empty.attrs.role, 'status');
  assert.equal(empty.attrs['aria-live'], 'polite');
  assert.match(empty.attrs.class, /empty/);
  assert.equal(empty.children[0], '没有记录');

  let retried = 0;
  const error = stateBlock({ kind: 'error', message: '失败', retry: { label: '重试', on: () => { retried += 1; } } });
  assert.equal(error.children.length, 2);
  const retryButton = error.children[1];
  assert.equal(retryButton.tag, 'button');
  assert.equal(retryButton.children.length >= 0, true);
  retryButton.on.click();
  assert.equal(retried, 1);
  assert.equal(stateBlock({ kind: 'error', role: 'alert' }).attrs.role, 'alert');
});
