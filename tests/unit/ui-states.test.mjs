// tests/unit/ui-states.test.mjs —— extension/ui/lib/states.js 状态模型单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIEW_STATES,
  aggregateStates,
  createStateMachine,
  emptyActions,
  isStale,
  stateFromResult,
  stateModel,
} from '../../extension/ui/lib/states.js';

test('stateModel：loading / empty / error / ready / idle', () => {
  const loading = stateModel('loading', { lang: 'zh' });
  assert.equal(loading.kind, 'loading');
  assert.equal(loading.busy, true);
  assert.equal(loading.visible, true);
  assert.equal(loading.text, '正在加载…');
  assert.equal(loading.aria, '内容加载中');

  const empty = stateModel('empty', { lang: 'en' });
  assert.equal(empty.text, 'Nothing here yet');
  assert.equal(empty.visible, true);

  const error = stateModel('error', { lang: 'zh', error: 'E_TIMEOUT' });
  assert.equal(error.showRetry, true);
  assert.ok(error.text.length > 0);
  assert.equal(error.code, 'E_TIMEOUT');
  const englishError = stateModel('error', { lang: 'en', error: 'E_TIMEOUT' });
  assert.notEqual(englishError.text, error.text, '12 语言错误提示生效');

  const withDetail = stateModel('error', { lang: 'zh', error: 'E_X', detail: '自定义失败' });
  assert.equal(withDetail.text, '自定义失败');
  assert.equal(stateModel('error', { lang: 'zh' }).retryText, '重试');

  const ready = stateModel('ready', { total: 5 });
  assert.equal(ready.visible, false);
  assert.equal(ready.text, '5');
  const idle = stateModel('idle');
  assert.equal(idle.visible, false);
  assert.equal(stateModel('bogus').kind, 'idle', '未知状态回退 idle');
  assert.ok(VIEW_STATES.includes('error'));
});

test('stateFromResult：从回复推断状态', () => {
  assert.equal(stateFromResult(null, { loading: true }), 'loading');
  assert.equal(stateFromResult({ ok: false }, { items: [] }), 'error');
  assert.equal(stateFromResult({ ok: true }, { items: [] }), 'empty');
  assert.equal(stateFromResult({ ok: true }, { items: [1] }), 'ready');
  assert.equal(stateFromResult({ ok: true }), 'empty');
});

test('createStateMachine：合法迁移与通知', () => {
  const seen = [];
  const machine = createStateMachine({ onChange: (payload) => seen.push(payload.state) });
  assert.equal(machine.state, 'idle');
  machine.loading();
  machine.empty();
  machine.fail('E_X');
  assert.equal(machine.state, 'error');
  assert.equal(machine.error, 'E_X');
  machine.ready();
  assert.equal(machine.error, null, '离开 error 后清空错误');
  assert.equal(machine.is('ready'), true);
  assert.deepEqual(seen, ['loading', 'empty', 'error', 'ready']);
  machine.set('bogus');
  assert.equal(machine.state, 'ready', '非法状态被忽略');
  const noChange = createStateMachine({ initial: 'loading' });
  assert.equal(noChange.state, 'loading');
  assert.equal(noChange.set('loading'), 'loading');
  // 监听器异常不影响状态机
  const noisy = createStateMachine({ onChange: () => { throw new Error('listener'); } });
  assert.equal(noisy.ready(), 'ready');
});

test('isStale', () => {
  const now = 1_000_000;
  assert.equal(isStale(now - 1000, { ttlMs: 60_000, now }), false);
  assert.equal(isStale(now - 120_000, { ttlMs: 60_000, now }), true);
  assert.equal(isStale(0, { now }), false, '没有时间戳不算过期');
  assert.equal(isStale(null, { now }), false);
  assert.equal(isStale(now - 5, { ttlMs: 0, now }), true);
});

test('aggregateStates：错误优先，其次加载，全空则空', () => {
  assert.equal(aggregateStates(['ready', 'error', 'loading']), 'error');
  assert.equal(aggregateStates(['ready', 'loading']), 'loading');
  assert.equal(aggregateStates(['empty', 'empty']), 'empty');
  assert.equal(aggregateStates(['ready', 'empty']), 'ready');
  assert.equal(aggregateStates([]), 'idle');
  assert.equal(aggregateStates(['bogus']), 'idle');
});

test('emptyActions：每个页面都有可执行的重试动作', () => {
  for (const surface of ['debug', 'audit', 'ops', 'record', 'longshot']) {
    const actions = emptyActions(surface, 'zh');
    assert.ok(actions.length >= 1, surface + ' 空态没有动作');
    assert.equal(actions[0].label, '重试');
    assert.ok(actions[0].key);
  }
  assert.deepEqual(emptyActions('nope'), []);
});
