// cooperate handback 状态机：人工接管 → 交还请求 → 结算（controller + 四项 revision 证据）。
import test from 'node:test';
import assert from 'node:assert/strict';

const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.3.0' }), onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: listener(),
  },
  alarms: { create: async () => {}, onAlarm: listener() },
  tabs: { onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(), query: async () => [], get: async (tabId) => ({ id: tabId, windowId: 1, url: 'https://example.test/', title: 'p', index: 0 }), sendMessage: async () => ({ ok: true }) },
  scripting: { executeScript: async () => [] },
  permissions: { contains: async () => true },
};

const {
  createCooperationCoordinator,
  LEASE_ERROR,
  LEASE_KINDS,
  HANDOFF_STATES,
  HANDOFF_EVENTS,
  HANDOFF_TRANSITIONS,
  describeCooperationState,
} = await import('../../extension/src/lib/cooperate.js');
const { createPassthroughTokens } = await import('../../extension/src/lib/passthrough-token.js');
const { createHumanGate } = await import('../../extension/src/lib/human-gate.js');
const { createControllerStateMachine } = await import('../../extension/src/lib/controller-state.js');
const { clearControlGeneration, controlGenerationRecord } = await import('../../extension/src/control-generation.js');

const emptyVector = () => ({ controlRevision: 0, authorityRevision: 0, revision: 0, frameEpoch: 0, epoch: 0, generation: 0 });

function world(start = 1000) {
  let clock = start;
  const now = () => clock;
  const advance = (ms) => { clock += ms; return clock; };
  const tokens = createPassthroughTokens({ now });
  const human = createHumanGate({ now });
  const controller = createControllerStateMachine({ now });
  const suppression = {
    begin: (tabId, options) => ({ ok: true, scopeId: 'sup-' + tabId, count: 1 }),
    end: () => ({ ok: true, released: true, outcome: 'ok' }),
    snapshot: () => ({ active: false, live: [], count: 0 }),
  };
  const capture = { snapshot: () => ({ count: 0, effective: false, holders: [] }) };
  const revisions = new Map();
  const revisionRecord = (tabId) => ({ ...emptyVector(), ...(revisions.get(tabId) || {}) });
  const bumpRevisions = (tabId, delta = {}) => {
    const next = { ...revisionRecord(tabId) };
    for (const [field, value] of Object.entries(delta)) next[field] = (next[field] || 0) + (typeof value === 'number' ? value : 1);
    revisions.set(tabId, next);
    return next;
  };
  const coordinator = createCooperationCoordinator({ now, tokens, human, controller, suppression, capture, revisionRecord, bumpRevisions });
  return { now, advance, tokens, human, controller, suppression, capture, coordinator, revisions };
}

/** 把 controller 直接推到指定状态（测试造局面用）。 */
function controllerTo(worldValue, tabId, state) {
  if (state === 'agent') {
    worldValue.controller.transition(tabId, 'agent.claim', { source: 'test.agent' });
    return;
  }
  if (state === 'handoff') {
    worldValue.controller.transition(tabId, 'agent.claim', { source: 'test.agent' });
    worldValue.controller.transition(tabId, 'handoff.start', { source: 'test.handoff' });
    return;
  }
  if (state === 'borrowed') {
    worldValue.controller.transition(tabId, 'agent.claim', { source: 'test.agent' });
    worldValue.controller.transition(tabId, 'borrow.request', { requestId: 'req-' + tabId, source: 'test.borrow' });
    worldValue.controller.transition(tabId, 'borrow.confirm', { confirmed: true, requestId: 'req-' + tabId, decision: 'allow', source: 'test.borrow' });
    return;
  }
  throw new Error('未知 controller 目标态：' + state);
}

test('初始 handoff=idle；非人工态直接 beginHandback 被拒绝并给提示', () => {
  const w = world();
  assert.equal(w.coordinator.handoffState(1).state, HANDOFF_STATES.IDLE);
  const rejected = w.coordinator.beginHandback(1, { reason: 'no-human' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, LEASE_ERROR.HANDOFF);
  assert.equal(rejected.state, HANDOFF_STATES.IDLE);
  assert.match(rejected.evidence.hint, /noteHumanTakeover/);
});

test('noteHumanTakeover：handoff 推到 human-active 且 controller 兜底到 human（idle→agent→human）', () => {
  const w = world();
  const taken = w.coordinator.noteHumanTakeover(2, { source: 'test.human', humanAt: w.now() });
  assert.equal(taken.ok, true);
  assert.equal(taken.state, HANDOFF_STATES.HUMAN);
  assert.equal(w.controller.get(2), 'human');
  assert.deepEqual(taken.controller.attempts.map((attempt) => attempt.event), ['human.take', 'agent.claim', 'human.take']);
  assert.equal(taken.controller.attempts[0].ok, false);
  assert.equal(taken.controller.attempts[1].ok, true);
  assert.equal(taken.controller.attempts[2].ok, true);
  const revised = w.revisions.get(2);
  assert.ok(revised.controlRevision >= 2, 'human.take/agent.claim 都推进 controlRevision');
  assert.ok(revised.authorityRevision >= 1);
});

test('handback 迁移表：无重复 from+event、reset 覆盖全部状态、非法事件给 allowed 列表', () => {
  const keys = new Set();
  for (const rule of HANDOFF_TRANSITIONS) {
    for (const from of rule.from) {
      const key = from + '|' + rule.event;
      assert.equal(keys.has(key), false, '重复迁移：' + key);
      keys.add(key);
    }
  }
  const reset = HANDOFF_TRANSITIONS.find((rule) => rule.event === HANDOFF_EVENTS.RESET);
  assert.ok(reset.from.includes(HANDOFF_STATES.AGENT));
  assert.ok(reset.from.includes(HANDOFF_STATES.HUMAN));
  assert.ok(reset.from.includes(HANDOFF_STATES.PENDING));
  const w = world();
  // force 语义：状态机不允许从当前态请求交还时，显式进入 handback-pending 并记 force 证据。
  const forcedBegin = w.coordinator.beginHandback(3, { force: true, reason: 'force-begin' });
  assert.equal(forcedBegin.ok, true);
  assert.equal(forcedBegin.state, HANDOFF_STATES.PENDING);
  assert.equal(w.coordinator.handoffState(3).event, HANDOFF_EVENTS.HANDOFF_FORCE);
  // 非 force 的重复请求必须走迁移表，非法组合给出 allowed 列表。
  const illegal = w.coordinator.beginHandback(3, { reason: 'again' });
  assert.equal(illegal.ok, false);
  assert.equal(illegal.code, LEASE_ERROR.HANDOFF);
  assert.ok(Array.isArray(illegal.allowed));
});

test('beginHandback 有活跃租约时 fail closed（E_LEASE_ACTIVE），force 才撤销并进入 pending', () => {
  const w = world();
  w.coordinator.noteHumanTakeover(4, { source: 'test.human', humanAt: w.now() });
  const lease = w.coordinator.acquire(4, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click', force: true });
  assert.equal(lease.ok, true);
  const blocked = w.coordinator.beginHandback(4, { reason: 'try' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, LEASE_ERROR.ACTIVE);
  assert.equal(blocked.activeLeases.length, 1);
  assert.equal(w.coordinator.handoffState(4).state, HANDOFF_STATES.HUMAN, '拒绝后状态不变');

  const forced = w.coordinator.beginHandback(4, { reason: 'forced', force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.state, HANDOFF_STATES.PENDING);
  assert.equal(w.coordinator.snapshot(4).depth, 0, 'force 撤掉了租约');
  assert.equal(w.tokens.list('coop:4').length, 0, 'force 撤销了租约 token（fail closed）');
  assert.equal(w.tokens.counter().revoked >= 1, true);
});

test('正常 handback：takeover → begin → complete，controller 走 human.return，证据可校验', () => {
  const w = world();
  w.coordinator.noteHumanTakeover(5, { source: 'test.human', humanAt: w.now() });
  w.advance(1500);
  const begun = w.coordinator.beginHandback(5, { reason: '用户做完了' });
  assert.equal(begun.ok, true);
  assert.equal(begun.state, HANDOFF_STATES.PENDING);
  assert.equal(begun.evidence.human.state, 'human-active');
  assert.ok(begun.evidence.revisions.after.controlRevision >= begun.evidence.revisions.before.controlRevision);
  const beforeVector = begun.revisions.before;

  const completed = w.coordinator.completeHandback(5, { source: 'test.handback', reason: '用户做完了' });
  assert.equal(completed.ok, true);
  assert.equal(completed.state, HANDOFF_STATES.DONE);
  assert.equal(completed.controller.accepted, 'human.return');
  assert.equal(w.controller.get(5), 'agent');
  assert.equal(completed.sealed.entries.length >= 3, true);
  assert.deepEqual(completed.sealed.entries.map((entry) => entry.kind), ['handback.before', 'handback.controller', 'handback.after']);
  assert.match(completed.sealed.digest, /^[0-9a-f]{8}$/);
  assert.equal(w.coordinator.verifyHandback(completed.sealed).ok, true);
  assert.ok(completed.revisions.before.controlRevision >= beforeVector.controlRevision, 'begin 已推进一次 controlRevision');
  assert.ok(completed.revisions.after.controlRevision > completed.revisions.before.controlRevision, '交还推进 controlRevision');
  assert.equal(completed.sealed.revision.stale, true);
  assert.ok(['local', 'remote', 'mixed'].includes(completed.sealed.revision.side));
});

test('completeHandback 在 controller handoff 态：接受 handoff.settle.agent', () => {
  const w = world();
  controllerTo(w, 6, 'handoff');
  w.coordinator.noteHumanTakeover(6, { source: 'test.human', humanAt: w.now() });
  // takeover 后 controller 已是 human；先再推回 handoff 造局。
  w.controller.transition(6, 'handoff.start', { source: 'test.handoff' });
  const computed = w.coordinator.completeHandback(6, { source: 'test.handback' });
  assert.equal(computed.ok, true);
  // human.return 在 handoff 态被拒，handoff.settle.agent 被接受。
  assert.equal(computed.controller.accepted, 'handoff.settle.agent');
  assert.equal(w.controller.get(6), 'agent');
});

test('completeHandback 在 controller idle 态：接受 agent.claim 兜底', () => {
  const w = world();
  w.coordinator.noteHumanTakeover(7, { source: 'test.human', humanAt: w.now() });
  // controller 被外部重置回 idle（service worker 重启/接管恢复）。
  w.controller.adopt(7, 'idle', { event: 'test.reset' });
  const completed = w.coordinator.completeHandback(7, { source: 'test.handback' });
  assert.equal(completed.ok, true);
  assert.equal(completed.controller.accepted, 'agent.claim');
  assert.equal(w.controller.get(7), 'agent');
});

test('abortHandback：回到 handback-aborted，controller 走 handoff.abort', () => {
  const w = world();
  w.coordinator.noteHumanTakeover(8, { source: 'test.human', humanAt: w.now() });
  w.controller.transition(8, 'handoff.start', { source: 'test.handoff' });
  w.coordinator.beginHandback(8, { reason: '误点' });
  const aborted = w.coordinator.abortHandback(8, { reason: '用户还在操作' });
  assert.equal(aborted.ok, true);
  assert.equal(aborted.state, HANDOFF_STATES.ABORTED);
  assert.equal(aborted.reason, '用户还在操作');
  assert.equal(w.coordinator.handoffState(8).event, HANDOFF_EVENTS.HANDOFF_ABORT);
});

test('重复 complete：第二次是非法迁移（拒绝并给出允许事件），除非 force', () => {
  const w = world();
  w.coordinator.noteHumanTakeover(9, { source: 'test.human', humanAt: w.now() });
  w.coordinator.beginHandback(9);
  assert.equal(w.coordinator.completeHandback(9).ok, true);
  const again = w.coordinator.completeHandback(9);
  assert.equal(again.ok, false);
  assert.equal(again.code, LEASE_ERROR.HANDOFF);
  assert.ok(again.allowed.includes(HANDOFF_EVENTS.AGENT_CLAIM));
  const forced = w.coordinator.completeHandback(9, { force: true });
  assert.equal(forced.ok, true, 'force 允许把 done 状态再结算一次（幂等重放）');
});

test('verifyHandback 发现证据被改动（哈希链防篡改）', () => {
  const w = world();
  w.coordinator.noteHumanTakeover(10, { source: 'test.human', humanAt: w.now() });
  w.coordinator.beginHandback(10);
  const completed = w.coordinator.completeHandback(10);
  assert.equal(w.coordinator.verifyHandback(completed.sealed).ok, true);
  const tampered = {
    ...completed.sealed,
    entries: completed.sealed.entries.map((entry, index) => (index === 1 ? { ...entry, data: { ...entry.data, accepted: 'handoff.settle.human' } } : entry)),
  };
  const verified = w.coordinator.verifyHandback(tampered);
  assert.equal(verified.ok, false);
  assert.equal(verified.code, 'HANDOFF_EVIDENCE_MISMATCH');
  assert.equal(w.coordinator.verifyHandback(null).ok, false);
});

test('beginHandback 证据：human/leases/overlays/suppression/controller/revisions 一次封存', () => {
  const w = world();
  w.coordinator.noteHumanTakeover(11, { source: 'test.human', humanAt: w.now() });
  const begun = w.coordinator.beginHandback(11, { reason: 'evidence' });
  const evidence = begun.evidence;
  assert.equal(evidence.tabId, 11);
  assert.equal(evidence.reason, 'evidence');
  assert.equal(evidence.human.state, 'human-active');
  assert.deepEqual(evidence.leases, []);
  assert.deepEqual(evidence.overlays, { capturing: false, overlays: [] });
  assert.equal(evidence.suppression.active, false);
  assert.equal(evidence.controller.tabId, 11);
  assert.ok(evidence.revisions.before.controlRevision >= 1);
  assert.equal(evidence.revisions.after.controlRevision >= evidence.revisions.before.controlRevision, true);
});

test('handoffState 记录 event/reason/pendingSince，history 有界且有迁移证据', () => {
  const w = world();
  w.coordinator.noteHumanTakeover(12, { source: 'test.human', humanAt: w.now() });
  const begun = w.coordinator.beginHandback(12, { reason: 'history' });
  assert.ok(begun.at > 0);
  const state = w.coordinator.handoffState(12);
  assert.equal(state.event, HANDOFF_EVENTS.HANDOFF_REQUEST);
  assert.equal(state.reason, 'history');
  assert.equal(state.pendingSince > 0, true);
  assert.equal(state.activeLeases, 0);
  assert.equal(state.history.length >= 1, true);
  assert.equal(state.history[state.history.length - 1].kind, 'transition');
  w.coordinator.completeHandback(12);
  const done = w.coordinator.handoffState(12);
  assert.equal(done.completedAt > 0, true);
  assert.ok(done.sealed && done.sealed.digest);
});

test('noteHuman/noteAttributed/noteAgentAction/endAgentAction 联动 human-gate 与 controller 动作计数', () => {
  const w = world();
  const noted = w.coordinator.noteHuman(13, { at: w.now(), kind: 'key', frameId: 2, label: '名称' });
  assert.equal(noted.ok, true);
  assert.equal(w.human.state(13).active, true);
  assert.equal(w.human.state(13).lastFrameId, 2);

  const attributed = w.coordinator.noteAttributed(13, { at: w.now(), humanAttributed: 3, agentAttributed: 1 });
  assert.equal(attributed.ok, true);
  assert.equal(attributed.deltas.human, 2, 'noteHuman 已计 1，再补 2 到总数 3');
  assert.equal(w.human.state(13).humanAttributed >= 1, true);

  const action = w.coordinator.noteAgentAction(13, 'click');
  assert.equal(action.ok, true);
  assert.equal(action.actionCount, 1);
  assert.equal(w.controller.snapshot(13).lastAction, 'click');
  const closed = w.coordinator.endAgentAction(13, 'ok');
  assert.equal(closed.ok, true);
  const snapshot = w.coordinator.snapshot(13);
  assert.equal(snapshot.lastAction.method, 'click');
  assert.equal(snapshot.lastAction.count, 1);
});

test('交还前后 mayAct：pending 时 controller handoff 拒绝动作，完成后放行', () => {
  const w = world();
  w.coordinator.noteHumanTakeover(14, { source: 'test.human', humanAt: w.now() });
  // controller 被外部推到 handoff（交接中）：动作应被 controller 闸门拒绝。
  w.controller.adopt(14, 'handoff', { event: 'test.handoff' });
  w.coordinator.beginHandback(14);
  const during = w.coordinator.mayAct(14, { method: 'click' });
  assert.equal(during.allowed, false);
  assert.equal(during.code, 'E_BORROW_CONFLICT', 'controller handoff 期间拒绝动作');
  w.coordinator.completeHandback(14);
  w.advance(3000);
  w.human.settle(14, { now: w.now() });
  const after = w.coordinator.mayAct(14, { method: 'click' });
  assert.equal(after.allowed, true);
});

test('真实 revision-chain 配合 handback：controlRevision 推进且 trace 有历史', () => {
  clearControlGeneration(15);
  const w = world();
  const coordinator = createCooperationCoordinator({
    now: w.now,
    tokens: createPassthroughTokens({ now: w.now }),
    human: w.human,
    controller: w.controller,
    suppression: w.suppression,
    capture: w.capture,
  });
  coordinator.noteHumanTakeover(15, { source: 'test.human', humanAt: w.now() });
  const recordBefore = controlGenerationRecord(15);
  const begun = coordinator.beginHandback(15, { reason: 'real-chain' });
  assert.equal(begun.revisions.before.controlRevision, recordBefore.controlRevision);
  const completed = coordinator.completeHandback(15, { source: 'test.handback' });
  const recordAfter = controlGenerationRecord(15);
  assert.ok(recordAfter.controlRevision > recordBefore.controlRevision);
  assert.ok(recordAfter.authorityRevision >= 1);
  assert.ok(completed.sealed.revision.before.controlRevision >= begun.revisions.before.controlRevision);
  const trace = coordinator.revisionTrace(15);
  assert.equal(trace.history.length >= 1, true);
  clearControlGeneration(15);
});

test('snapshot/describe 暴露 handoff 与 handback 摘要', () => {
  const w = world();
  w.coordinator.noteHumanTakeover(16, { source: 'test.human', humanAt: w.now() });
  const snapshot = w.coordinator.snapshot(16);
  assert.equal(snapshot.handoff.state, HANDOFF_STATES.HUMAN);
  assert.match(describeCooperationState(snapshot), /handoff=human-active/);
  assert.equal(snapshot.controller.state, 'human');
  assert.equal(w.coordinator.counters().handoffs, 0);
  w.coordinator.beginHandback(16);
  assert.equal(w.coordinator.counters().handoffs, 1);
  w.coordinator.completeHandback(16);
  assert.equal(w.coordinator.counters().handbackCompletes, 1);
  assert.equal(w.coordinator.counters().tabs, 1);
});
