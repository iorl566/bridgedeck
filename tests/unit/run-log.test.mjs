import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRunLog, RUN_LOG_LIMITS } from '../../lib/run-log.mjs';

const log = (options) => new SessionRunLog({ now: () => 1000, ...options });

test('只记录 navigate/action，其余方法忽略', () => {
  const run = log();
  assert.equal(run.record({ method: 'observe', tabId: 1 }), null);
  assert.equal(run.record({ method: 'read', tabId: 1 }), null);
  const nav = run.record({ method: 'navigate', tabId: 1, url: 'https://a.test/path?token=secret#x' });
  assert.equal(nav.kind, 'navigate');
  assert.equal(nav.origin, 'https://a.test');
  assert.equal(nav.path, '/path');
  assert.equal(nav.dropped_query, true);
  const click = run.record({ method: 'click', tabId: 1, target: { selector: '#ok' }, revision: 3 });
  assert.equal(click.kind, 'action');
  assert.equal(click.target.selector, '#ok');
  assert.equal(run.snapshot().count, 2);
});

test('navigate 不保留 query/hash，且非 http(s) 不记录', () => {
  const run = log();
  run.record({ method: 'navigate', tabId: 1, url: 'https://a.test/p?x=1' });
  assert.equal(JSON.stringify(run.snapshot()).includes('x=1'), false);
  assert.equal(run.record({ method: 'navigate', tabId: 1, url: 'chrome://settings' }), null);
  assert.equal(run.record({ method: 'navigate', tabId: 1, url: 'not a url' }), null);
});

test('目标只保留白名单字段，不保存输入值', () => {
  const run = log();
  run.record({
    method: 'fill',
    tabId: 1,
    target: { selector: '#pw', value: 'hunter2', text: 'secret', token: 'abc', role: 'textbox', name: '密码', stableRef: 's-1', ref: '@e4' },
  });
  const step = run.snapshot().steps[0];
  assert.equal(step.target.selector, '#pw');
  assert.equal(step.target.role, 'textbox');
  assert.equal(step.target.stableRef, 's-1');
  assert.equal(JSON.stringify(step).includes('hunter2'), false);
  assert.equal(JSON.stringify(step).includes('"value"'), false);
  assert.equal(JSON.stringify(step).includes('abc'), false);
});

test('步数上限：保留前 N 步并标记 truncated', () => {
  const run = log({ limits: { steps: 2 } });
  run.record({ method: 'click', tabId: 1, target: { selector: '#a' } });
  run.record({ method: 'click', tabId: 1, target: { selector: '#b' } });
  run.record({ method: 'click', tabId: 1, target: { selector: '#c' } });
  const view = run.snapshot();
  assert.equal(view.total, 2);
  assert.equal(view.truncated, true);
  assert.equal(view.dropped, 1);
  assert.deepEqual(view.steps.map((step) => step.target.selector), ['#a', '#b']);
});

test('refs 上限：超出后不再增长 refs 计数', () => {
  const run = log({ limits: { refs: 2 } });
  for (let index = 0; index < 5; index += 1) {
    run.record({ method: 'click', tabId: 1, target: { stableRef: 's-' + index, selector: '#x' + index } });
  }
  assert.equal(run.snapshot().refs, 2);
});

test('snapshot limit 取最近 N 步；clear 清空', () => {
  const run = log();
  run.record({ method: 'click', tabId: 1, target: { selector: '#1' } });
  run.record({ method: 'click', tabId: 1, target: { selector: '#2' } });
  run.record({ method: 'click', tabId: 1, target: { selector: '#3' } });
  const view = run.snapshot({ limit: 2 });
  assert.deepEqual(view.steps.map((step) => step.target.selector), ['#2', '#3']);
  run.clear();
  assert.equal(run.snapshot().count, 0);
  assert.equal(run.snapshot().refs, 0);
});

test('默认上限符合 兼容对齐值（200 步 / 8000 refs）', () => {
  assert.equal(RUN_LOG_LIMITS.steps, 200);
  assert.equal(RUN_LOG_LIMITS.refs, 8000);
});
