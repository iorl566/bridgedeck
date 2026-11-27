// tests/unit/ui-view-state.test.mjs —— extension/ui/lib/view-state.js 视图状态单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIEW_STATE_SCHEMA,
  applyViewStateToHref,
  createViewStateStore,
  decodeSort,
  decodeViewState,
  defaultViewState,
  encodeSort,
  encodeViewState,
  isAllowedKey,
  readViewStateFromLocation,
} from '../../extension/ui/lib/view-state.js';

test('白名单：只接受声明过的字段与表面', () => {
  assert.equal(isAllowedKey('list', 'query'), true);
  assert.equal(isAllowedKey('list', 'evil'), false);
  assert.equal(isAllowedKey('nope', 'query'), false);
  assert.deepEqual(Object.keys(VIEW_STATE_SCHEMA).sort(), ['compare', 'list', 'timeline']);
  assert.deepEqual(defaultViewState('timeline'), { zoom: 1, pan: 0, view: 'waterfall' });
  assert.deepEqual(defaultViewState('nope'), {});
});

test('decodeViewState：查询串/对象/越界夹取', () => {
  const state = decodeViewState('list', '?query=api&sort=duration&direction=desc&page=3&pageSize=999');
  assert.equal(state.query, 'api');
  assert.equal(state.sort, 'duration');
  assert.equal(state.direction, 'desc');
  assert.equal(state.page, 3);
  assert.equal(state.pageSize, 500, 'pageSize 夹到最大值');

  const clamped = decodeViewState('list', 'query=x&page=0&pageSize=-5');
  assert.equal(clamped.page, 1);
  assert.equal(clamped.pageSize, 1);

  const fromParams = decodeViewState('list', new URLSearchParams('tab=history'));
  assert.equal(fromParams.tab, 'history');

  const unknown = decodeViewState('list', '?evil=1&query=a');
  assert.equal(unknown.evil, undefined, '未知字段被忽略');
  assert.equal(unknown.query, 'a');

  const badDirection = decodeViewState('list', 'direction=sideways');
  assert.equal(badDirection.direction, 'asc', '非法方向回退 asc');

  // 默认值不因空串被覆盖
  assert.equal(decodeViewState('list', '?query=&page=').query, '');
  assert.equal(decodeViewState('nope', '?query=a').query, undefined);

  const zoomed = decodeViewState('timeline', '?zoom=999&pan=-999');
  assert.equal(zoomed.zoom, 64);
  assert.equal(zoomed.pan, -50);
  const overrides = decodeViewState('list', '', { overrides: { page: 4, evil: 1 } });
  assert.equal(overrides.page, 4);
  assert.equal(overrides.evil, undefined);
});

test('encodeViewState：只写与默认值不同的字段', () => {
  assert.equal(encodeViewState('list', { query: '', page: 1, direction: 'asc' }), '', '全默认值时 query 为空');
  assert.equal(encodeViewState('list', { query: 'api', page: 1 }), 'query=api');
  const full = encodeViewState('list', { query: 'a b', sort: 'ts', direction: 'desc', page: 2 });
  const params = new URLSearchParams(full);
  assert.equal(params.get('query'), 'a b');
  assert.equal(params.get('page'), '2');
  assert.equal(params.get('direction'), 'desc');
  assert.equal(encodeViewState('list', { query: 'api' }, { includeDefaults: true }), 'query=api&direction=asc&page=1&pageSize=20&view=list');
  assert.equal(encodeViewState('nope', {}), '');
});

test('readViewStateFromLocation / applyViewStateToHref', () => {
  const state = readViewStateFromLocation('list', 'chrome-extension://id/ui/debug.html?query=ping&page=2#top');
  assert.equal(state.query, 'ping');
  assert.equal(state.page, 2);
  assert.equal(readViewStateFromLocation('list', 'chrome-extension://id/ui/debug.html').query, '');

  const href = applyViewStateToHref('list', 'chrome-extension://id/ui/audit.html?old=1#note', { query: 'api', page: 2 });
  assert.match(href, /^chrome-extension:\/\/id\/ui\/audit\.html\?/);
  assert.match(href, /query=api/);
  assert.match(href, /page=2/);
  assert.match(href, /#note$/);
  assert.doesNotMatch(href, /old=1/);
  const clean = applyViewStateToHref('list', 'https://x/y?z=1', {});
  assert.equal(clean, 'https://x/y');
});

test('createViewStateStore：set 过滤未知字段并通知订阅者', () => {
  const store = createViewStateStore('list', { query: 'a' });
  assert.equal(store.get('query'), 'a');
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state.query));
  store.set({ query: 'b' });
  store.set({ query: 'b' });
  store.set({ evil: 'x' });
  assert.deepEqual(seen, ['b'], '相同值/未知字段不触发通知');
  unsubscribe();
  store.set({ query: 'c' });
  assert.deepEqual(seen, ['b'], '取消订阅后不再通知');
  assert.equal(store.toQuery(), 'query=c');
  assert.deepEqual(store.reset().query, '');
  assert.equal(store.toQuery(), '');
  store.set(null);
  assert.equal(store.get('query'), '');
});

test('encodeSort / decodeSort', () => {
  assert.equal(encodeSort(null), '');
  assert.equal(encodeSort({ key: 'ts', direction: 'asc' }), 'ts:asc');
  assert.equal(encodeSort({ key: 'durationMs', direction: 'desc' }), 'durationMs:desc');
  assert.deepEqual(decodeSort('ts:desc'), { key: 'ts', direction: 'desc' });
  assert.deepEqual(decodeSort('ts'), { key: 'ts', direction: 'asc' });
  assert.deepEqual(decodeSort(''), { key: '', direction: 'asc' });
  assert.deepEqual(decodeSort(null), { key: '', direction: 'asc' });
});
