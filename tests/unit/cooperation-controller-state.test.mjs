// controller 显式状态机：合法迁移表、非法迁移拒绝证据、借用确认闸门的控制器迁移。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROLLER_STATES,
  allowedTransitions,
  canTransition,
  controllerTransitionTable,
  createControllerStateMachine,
  transitionBumps,
} from '../../extension/src/lib/controller-state.js';

function machine(options = {}) {
  let clock = options.start || 1000;
  return createControllerStateMachine({ now: () => (clock += Number(options.step) || 10), ...options });
}

test('合法迁移表：每个状态都可达、可回退，且表内没有重复 from|event', () => {
  const table = controllerTransitionTable();
  const states = Object.values(CONTROLLER_STATES);
  assert.equal(states.length, 6);
  const ruleKeys = new Set();
  for (const rule of table) {
    assert.ok(states.includes(rule.to), '目标状态非法：' + rule.to);
    assert.ok(rule.from.length > 0, '来源为空：' + rule.event);
    assert.ok(Array.isArray(rule.bumps), '缺少 bumps 声明：' + rule.event);
    for (const from of rule.from) {
      assert.ok(states.includes(from), '来源状态非法：' + from);
      const key = from + '|' + rule.event;
      assert.equal(ruleKeys.has(key), false, '重复迁移规则：' + key);
      ruleKeys.add(key);
    }
  }
  // 六个状态都必须能从 idle 抵达到，且都能回到 idle 或 agent（不允许死锁状态）。
  const adjacency = new Map(states.map((state) => [state, new Set()]));
  for (const rule of table) for (const from of rule.from) adjacency.get(from).add(rule.to);
  const reachable = new Set(['idle']);
  const queue = ['idle'];
  while (queue.length) {
    for (const next of adjacency.get(queue.shift())) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  assert.deepEqual([...reachable].sort(), [...states].sort(), '存在不可达状态');
  for (const state of states) {
    if (state === 'idle') continue;
    const from = new Set([state]);
    const walk = [state];
    while (walk.length) for (const next of adjacency.get(walk.shift())) if (!from.has(next)) { from.add(next); walk.push(next); }
    assert.ok(from.has('idle') || from.has('agent'), state + ' 无法回到 idle/agent（死锁）');
  }
  // canTransition 与表一致。
  assert.equal(canTransition('idle', 'agent.claim'), true);
  assert.equal(canTransition('idle', 'human.take'), false);
});

test('合法迁移：idle→agent→human→agent 与计数推进（controlRevision/authorityRevision）', () => {
  const state = machine();
  const claim = state.transition(7, 'agent.claim', { holder: 'session-1' });
  assert.equal(claim.ok, true);
  assert.equal(claim.from, 'idle');
  assert.equal(claim.to, 'agent');
  assert.equal(state.get(7), 'agent');
  assert.equal(state.snapshot(7).controlRevision, 1);
  assert.equal(state.snapshot(7).authorityRevision, 0);

  const human = state.transition(7, 'human.take', { source: 'human-input', humanAt: 2000 });
  assert.equal(human.ok, true);
  assert.equal(human.to, 'human');
  assert.deepEqual(human.evidence.bumps, ['controlRevision', 'authorityRevision']);
  assert.equal(state.snapshot(7).controlRevision, 2);
  assert.equal(state.snapshot(7).authorityRevision, 1);
  assert.deepEqual(transitionBumps(human), { controlRevision: 1, authorityRevision: 1 });

  const back = state.transition(7, 'human.return', { source: 'cooperate.handback' });
  assert.equal(back.ok, true);
  assert.equal(back.to, 'agent');
  assert.equal(state.snapshot(7).controlRevision, 3);
});

test('非法迁移被拒绝并给出 from/event/to/allowed 证据，状态不变', () => {
  const state = machine();
  const rejected = state.transition(8, 'human.take', { source: 'human-input' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'CONTROLLER_TRANSITION');
  assert.equal(rejected.state, 'idle');
  assert.equal(rejected.evidence.from, 'idle');
  assert.equal(rejected.evidence.event, 'human.take');
  assert.deepEqual(rejected.evidence.allowed.map((entry) => entry.event).sort(), ['agent.claim', 'borrow.request', 'hold.engage', 'reset']);
  const snapshot = state.snapshot(8);
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.rejected, 1);
  assert.equal(snapshot.lastRejection.code, 'CONTROLLER_TRANSITION');
  // 非法迁移不能偷偷改计数。
  assert.equal(snapshot.controlRevision, 0);
});

test('非法迁移：agent 不能释放 hold、idle 不能结算 handoff、borrowed 不能直接 deny', () => {
  const state = machine();
  state.transition(9, 'agent.claim', { holder: 's' });
  assert.equal(state.transition(9, 'hold.release', {}).code, 'CONTROLLER_TRANSITION');
  assert.equal(state.transition(10, 'handoff.settle.agent', {}).code, 'CONTROLLER_TRANSITION');
  state.transition(10, 'borrow.confirm', { confirmed: true, requestId: 'r1' }); // idle 也没有 borrow.confirm
  assert.equal(state.get(10), 'idle');
  assert.equal(state.transition(10, 'borrow.deny', {}).code, 'CONTROLLER_TRANSITION');
  assert.equal(state.snapshot(9).state, 'agent');
});

test('前置守卫：借用确认必须 confirmed、借用请求必须带 requestId、人工接管必须带来源', () => {
  const state = machine();
  const handoff = state.transition(11, 'borrow.request', { requestId: 'req-11' });
  assert.equal(handoff.ok, true);
  assert.equal(handoff.to, 'handoff');
  const unconfirmed = state.transition(11, 'borrow.confirm', { requestId: 'req-11' });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.code, 'BORROW_CONFIRM_REQUIRED');
  assert.equal(state.get(11), 'handoff');
  const deniedDecision = state.transition(11, 'borrow.confirm', { requestId: 'req-11', confirmed: true, decision: 'deny' });
  assert.equal(deniedDecision.code, 'E_BORROW_DENIED');
  const confirmed = state.transition(11, 'borrow.confirm', { requestId: 'req-11', confirmed: true, decision: 'allow' });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.to, 'borrowed');
  assert.deepEqual(confirmed.evidence.bumps, ['controlRevision', 'frameEpoch']);

  assert.equal(state.transition(12, 'borrow.request', {}).code, 'E_BORROW_CONFLICT');
  state.transition(13, 'agent.claim', { holder: 's' });
  assert.equal(state.transition(13, 'human.take', {}).code, 'E_CONTROL_STALE');
  // hasSession=false 明确表示会话已结束，不能认领。
  assert.equal(state.transition(14, 'agent.claim', { hasSession: false }).code, 'E_CONTROL_NOT_HELD');
});

test('同状态迁移幂等（duplicate=true）且不重复推进计数/历史', () => {
  const state = machine();
  state.transition(15, 'hold.engage', { source: 'cooperate.hold' });
  const before = state.snapshot(15);
  const again = state.transition(15, 'hold.engage', { source: 'takeover' });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  const after = state.snapshot(15);
  assert.equal(after.controlRevision, before.controlRevision);
  assert.equal(after.transitions, before.transitions);
  assert.equal(after.history.length, before.history.length);
  assert.equal(state.counters().duplicates, 1);
});

test('借用确认完整流程：idle→handoff→borrowed→idle 与拒绝分支', () => {
  const state = machine();
  state.transition(16, 'borrow.request', { requestId: 'r16' });
  assert.equal(state.get(16), 'handoff');
  state.transition(16, 'borrow.deny', { requestId: 'r16', decision: 'deny' });
  assert.equal(state.get(16), 'idle');
  state.transition(16, 'borrow.request', { requestId: 'r16b' });
  state.transition(16, 'borrow.confirm', { requestId: 'r16b', confirmed: true, decision: 'allow' });
  assert.equal(state.get(16), 'borrowed');
  const returned = state.transition(16, 'borrow.return', { source: 'tab.return' });
  assert.equal(returned.ok, true);
  assert.equal(state.get(16), 'idle');
  const errors = state.history(16).filter((entry) => entry.kind === 'reject');
  assert.equal(errors.length, 0);
});

test('actionGate：held 拒绝动作（E_SESSION_PAUSED）、handoff 拒绝动作（E_BORROW_CONFLICT）', () => {
  const state = machine();
  assert.deepEqual(state.actionGate(17, 'click').allowed, true);
  state.transition(17, 'agent.claim', { holder: 's' });
  state.transition(17, 'hold.engage', { source: 'cooperate.hold' });
  const held = state.actionGate(17, 'click');
  assert.equal(held.allowed, false);
  assert.equal(held.code, 'E_SESSION_PAUSED');
  assert.equal(held.evidence.state, 'held');
  state.transition(17, 'hold.release', { source: 'cooperate.handback' });
  state.transition(17, 'handoff.start', { source: 'handoff' });
  const handoff = state.actionGate(17, 'fill');
  assert.equal(handoff.allowed, false);
  assert.equal(handoff.code, 'E_BORROW_CONFLICT');
  assert.equal(state.actionGate(17, 'observe').allowed, false, 'handoff 对任何动作都拒绝');
});

test('adopt 采纳外部权威状态并留证据；noteAction 只累计动作不改状态', () => {
  const state = machine({ start: 5000 });
  const adopted = state.adopt(18, 'borrowed', { event: 'borrow.restore', source: 'tab.borrow' });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.from, 'idle');
  assert.equal(adopted.to, 'borrowed');
  assert.equal(adopted.state.since >= 5010, true);
  assert.equal(state.adopt(18, 'not-a-state').ok, false);
  const action = state.noteAction(18, 'click', { at: 6000 });
  assert.equal(action.actionCount, 1);
  assert.equal(action.lastAction, 'click');
  assert.equal(state.get(18), 'borrowed', 'noteAction 不应改变状态');
  assert.equal(state.snapshot(18).history.at(-1).kind, 'adopt');
});

test('显式 reset 从任意状态回到 idle；clear 移除 tab 记录', () => {
  const state = machine();
  for (const tabId of [19, 20, 21]) {
    state.transition(tabId, 'agent.claim', { holder: 's' });
    state.transition(tabId, 'hold.engage', { source: 'cooperate.hold' });
    const reset = state.transition(tabId, 'reset', { source: 'tab.close' });
    assert.equal(reset.ok, true);
    assert.equal(reset.to, 'idle');
  }
  assert.equal(state.counters().tabs, 3);
  assert.equal(state.clear(19), true);
  assert.equal(state.snapshot(19), null);
  assert.equal(state.list().length, 2);
  assert.deepEqual(allowedTransitions('bogus').map((entry) => entry.event).sort(), allowedTransitions('idle').map((entry) => entry.event).sort());
});

test('history 有界、lastRejection 可复现，非法 tabId 返回结构化错误', () => {
  const state = machine({ historyLimit: 4 });
  state.transition(22, 'agent.claim', { holder: 's' });
  for (let index = 0; index < 6; index += 1) state.transition(22, 'human.return', {});
  const snapshot = state.snapshot(22);
  assert.ok(snapshot.history.length <= 4);
  const bad = state.transition(null, 'agent.claim');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_BAD_ARG');
  assert.equal(state.transition(22, undefined).code, 'E_BAD_ARG');
});
