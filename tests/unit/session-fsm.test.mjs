// tests/unit/session-fsm.test.mjs —— 会话生命周期 8 状态机：迁移表/非法迁移证据/暂停/失败/退休。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_ALIASES,
  SESSION_STATES,
  SESSION_TRANSITIONS,
  SessionTransitionError,
  allowedTransitions,
  canonicalState,
  createSessionState,
  isKnownState,
  isLegalTransition,
} from '../../lib/session-state.mjs';

function clocked() {
  let now = 1_000_000;
  const state = createSessionState({ now: () => now });
  return { state, advance: (ms) => { now += ms; return now; } };
}

test('8 个规范状态与迁移表齐全，旧标签有别名', () => {
  assert.deepEqual([...SESSION_STATES], ['idle', 'preparing', 'starting', 'ready', 'paused', 'stopping', 'stopped', 'failed']);
  for (const state of SESSION_STATES) assert.equal(Array.isArray(SESSION_TRANSITIONS[state]), true, state);
  assert.equal(SESSION_ALIASES.active, 'ready');
  assert.equal(SESSION_ALIASES.recovering, 'preparing');
  assert.equal(canonicalState('active'), 'ready');
  assert.equal(canonicalState('recovering'), 'preparing');
  assert.equal(canonicalState('bogus'), null);
  assert.equal(isKnownState('ready'), true);
  assert.equal(isKnownState('bogus'), false);
});

test('合法路径 idle→preparing→starting→ready→paused→ready→stopping→stopped，历史留证据', () => {
  const { state, advance } = clocked();
  state.transition('s1', 'preparing', { reason: 'request-accepted' });
  advance(5);
  state.transition('s1', 'starting', { reason: 'tab-created' });
  advance(5);
  state.transition('s1', 'ready', { reason: 'session-registered' });
  advance(5);
  state.transition('s1', 'paused', { reason: 'human-takeover' });
  assert.equal(state.phase('s1'), 'paused');
  assert.equal(state.canonicalPhase('s1'), 'paused');
  advance(5);
  state.transition('s1', 'ready', { reason: 'agent-resume' });
  advance(5);
  state.transition('s1', 'stopping', { reason: 'stop-requested' });
  advance(5);
  const stopped = state.transition('s1', 'stopped', { reason: 'tab-closed' });
  assert.equal(stopped.canonical, 'stopped');
  const history = state.history('s1');
  assert.deepEqual(history.map((item) => item.from + '→' + item.to), [
    'idle→preparing', 'preparing→starting', 'starting→ready', 'ready→paused',
    'paused→ready', 'ready→stopping', 'stopping→stopped',
  ]);
  assert.equal(history.every((item) => typeof item.at === 'number'), true);
  assert.equal(history[0].reason, 'request-accepted');
  assert.equal(history[history.length - 1].to, 'stopped');
});

test('非法迁移被拒绝：抛 E_SESSION_TRANSITION，带 from/to/allowed/history 证据且状态不变', () => {
  const { state } = clocked();
  state.transition('s1', 'ready');
  assert.throws(
    () => state.transition('s1', 'preparing', { reason: 'bogus-regression' }),
    (error) => {
      assert.equal(error instanceof SessionTransitionError, true);
      assert.equal(error.code, 'E_SESSION_TRANSITION');
      assert.equal(error.data.from, 'ready');
      assert.equal(error.data.to, 'preparing');
      assert.equal(error.data.reason, 'bogus-regression');
      assert.deepEqual(error.data.allowed, allowedTransitions('ready'));
      assert.equal(Array.isArray(error.data.history), true);
      assert.equal(error.data.history.length, 1);
      return true;
    },
  );
  // 拒绝后状态不变。
  assert.equal(state.canonicalPhase('s1'), 'ready');
  const violations = state.violationsOf('s1');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].from, 'ready');
  assert.equal(violations[0].to, 'preparing');
  assert.equal(violations[0].reason, 'bogus-regression');
  assert.equal(violations[0].forced, false);
});

test('多条非法边都被拒绝：idle→stopped、stopped→ready、paused→starting、failed→ready', () => {
  assert.equal(isLegalTransition('idle', 'stopped'), false);
  assert.equal(isLegalTransition('stopped', 'ready'), false);
  assert.equal(isLegalTransition('paused', 'starting'), false);
  assert.equal(isLegalTransition('failed', 'ready'), false);
  const { state } = clocked();
  assert.throws(() => state.transition('s1', 'stopped'), (error) => error.code === 'E_SESSION_TRANSITION');
  state.transition('s1', 'ready');
  state.transition('s1', 'paused');
  assert.throws(() => state.transition('s1', 'starting'), (error) => error.code === 'E_SESSION_TRANSITION');
});

test('0.3.0 兼容入口：begin→starting，activate→active(ready)，requestStop→stopping，finish→退休', () => {
  const { state } = clocked();
  assert.equal(state.begin('s1'), 'starting');
  assert.equal(state.phase('s1'), 'starting');
  assert.equal(state.canonicalPhase('s1'), 'starting');
  assert.equal(state.activate('s1'), 'active');
  assert.equal(state.canonicalPhase('s1'), 'ready');
  assert.equal(state.requestStop('s1'), true);
  assert.equal(state.requestStop('s1'), false, '重复 stop 请求幂等');
  state.finish('s1');
  assert.equal(state.get('s1'), null);
  const tomb = state.listAll().find((item) => item.sessionId === 's1');
  assert.equal(tomb.retired, true);
  assert.equal(tomb.phase, 'stopped');
  // 退休后可再次 begin（新生命周期）。
  assert.equal(state.begin('s1'), 'starting');
});

test('重复 begin 在 starting/ready 时拒绝，错误带当前状态与历史证据', () => {
  const { state } = clocked();
  state.begin('s1');
  assert.throws(
    () => state.begin('s1'),
    (error) => {
      assert.equal(error.code, 'E_SESSION_BUSY');
      assert.equal(error.data.sessionId, 's1');
      assert.equal(error.data.from, 'starting');
      assert.equal(error.data.to, 'starting');
      assert.equal(Array.isArray(error.data.history), true);
      return true;
    },
  );
  state.activate('s1');
  assert.throws(() => state.begin('s1'), (error) => error.code === 'E_SESSION_BUSY');
  state.finish('s1');
  assert.doesNotThrow(() => state.begin('s1'));
});

test('recover 恢复为 recovering（canonical preparing），activate 后 active（canonical ready）', () => {
  const { state } = clocked();
  assert.equal(state.recover('s2'), 'recovering');
  assert.equal(state.canonicalPhase('s2'), 'preparing');
  assert.equal(state.activate('s2'), 'active');
  assert.equal(state.canonicalPhase('s2'), 'ready');
  const row = state.list().find((item) => item.sessionId === 's2');
  assert.equal(row.phase, 'active');
  assert.equal(row.canonical, 'ready');
});

test('pause/resume 同步真状态；非暂停状态 resume 返回 false', () => {
  const { state } = clocked();
  state.activate('s3');
  assert.equal(state.pause('s3', { reason: 'manual' }), 'paused');
  assert.equal(state.resume('s3', { reason: 'manual-resume' }), true);
  assert.equal(state.resume('s3'), false);
  assert.equal(state.canonicalPhase('s3'), 'ready');
});

test('fail 保留 failed 记录与错误证据，可从 failed 恢复', () => {
  const { state } = clocked();
  state.prepare('s4');
  state.fail('s4', { code: 'E_BROWSER_GONE', message: '浏览器实例断开' });
  assert.equal(state.phase('s4'), 'failed');
  const described = state.describe('s4');
  assert.equal(described.canonical, 'failed');
  assert.equal(described.lastTransition.reason, 'fail');
  assert.equal(described.lastTransition.evidence.code, 'E_BROWSER_GONE');
  // failed 是保留状态，不是退休：仍可恢复。
  state.transition('s4', 'preparing', { reason: 'retry' });
  state.transition('s4', 'starting');
  state.transition('s4', 'ready');
  assert.equal(state.canonicalPhase('s4'), 'ready');
});

test('finish 强制退休会记录 forced violation 与证据（清理路径不抛错）', () => {
  const { state } = clocked();
  state.activate('s5');
  // ready 状态直接 finish：清理仍执行，但留下被绕开 transition 的证据。
  assert.equal(state.finish('s5'), true);
  assert.equal(state.get('s5'), null);
  const violations = state.violationsOf('s5');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].from, 'ready');
  assert.equal(violations[0].to, 'stopped');
  assert.equal(violations[0].forced, true);
  const tomb = state.listAll().find((item) => item.sessionId === 's5');
  assert.equal(tomb.forced, true);
});

test('snapshot/reset：状态表、迁移计数、非法迁移证据可查询', () => {
  const { state } = clocked();
  state.prepare('s6');
  state.begin('s6');
  assert.throws(() => state.transition('s6', 'paused'), (error) => error.code === 'E_SESSION_TRANSITION');
  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.states, [...SESSION_STATES]);
  assert.equal(snapshot.transitionCount >= 2, true);
  assert.equal(snapshot.violationCount, 1);
  assert.equal(snapshot.violations[0].from, 'starting');
  state.reset();
  assert.equal(state.list().length, 0);
  assert.equal(state.snapshot().violationCount, 0);
});

test('allowedTransitions 对未知/空会话按 idle 计算；clock 注入时间可复现', () => {
  const { state, advance } = clocked();
  assert.deepEqual(state.allowedTransitions('nobody'), SESSION_TRANSITIONS.idle);
  state.transition('s7', 'preparing', { reason: 't0' });
  const at0 = state.describe('s7').since;
  advance(1000);
  state.transition('s7', 'starting', { reason: 't1' });
  assert.equal(state.describe('s7').since - at0, 1000);
  assert.equal(state.history('s7').map((item) => item.reason).join(','), 't0,t1');
});

test('未知目标状态抛 E_SESSION_STATE', () => {
  const { state } = clocked();
  assert.throws(
    () => state.transition('s8', 'zombie'),
    (error) => error.code === 'E_SESSION_STATE' && error.data.to === 'zombie',
  );
});
