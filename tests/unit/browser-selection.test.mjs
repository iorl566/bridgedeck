import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_SELECTION_ERRORS, selectBrowserInstance } from '../../lib/browser-selection.mjs';

const list = [
  { instanceId: 'aaa111', label: 'Work profile', browser: 'edge' },
  { instanceId: 'bbb222', label: 'Home', browser: 'chrome' },
  { instanceId: 'ccc333', label: 'Work profile', browser: 'chrome' },
];

test('instanceId 精确匹配优先于名称', () => {
  assert.equal(selectBrowserInstance(list, 'aaa111').instance.instanceId, 'aaa111');
  assert.equal(selectBrowserInstance(list, 'AAA111').instance.instanceId, 'aaa111');
});

test('唯一名称可选中，同名名称必须报歧义', () => {
  assert.equal(selectBrowserInstance(list, 'home').instance.instanceId, 'bbb222');
  const duplicate = selectBrowserInstance(list, 'WORK PROFILE');
  assert.equal(duplicate.error, BROWSER_SELECTION_ERRORS.AMBIGUOUS);
  assert.match(duplicate.message, /instanceId/);
});

test('edge/chrome 前缀只在唯一时生效', () => {
  const single = list.filter((item) => item.browser === 'edge');
  assert.equal(selectBrowserInstance(single, 'edge').instance.instanceId, 'aaa111');
  const ambiguous = selectBrowserInstance(list, 'chrome');
  assert.equal(ambiguous.error, BROWSER_SELECTION_ERRORS.AMBIGUOUS);
});

test('没有浏览器 / 找不到选择器返回稳定错误码', () => {
  assert.equal(selectBrowserInstance([], 'edge').error, BROWSER_SELECTION_ERRORS.NO_BROWSER);
  assert.equal(selectBrowserInstance(list, 'nope').error, BROWSER_SELECTION_ERRORS.NOT_FOUND);
});
