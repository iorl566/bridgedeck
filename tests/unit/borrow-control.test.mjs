// M6 P0③ 接线单测：既有 cooperate / tab.borrow / borrow-confirm 路径真实消费
// contextId / policy / epoch / allow-ask-deny / 交接窗口 / borrow 确认超时。
//
// 真实消费点（file:line）：
//   dispatch.js:499-508  assertBorrowAllowed → borrowGate.check → 错误 data（动作被拒时）
//   control.js:440-441   checkControl 交接中 → borrow.evidence（cooperate 动作路径）
//   tabs-borrow.js:64/105/117  borrowGate.request/resolve/status（tab.borrow 路径）
//   lib/cooperate.js:310/424/651/1018  acquire/release/mayAct/snapshot 证据
//   lib/borrow.js:428/begin/beginReturn/completeReturn 借用旅程证据
import test from 'node:test';
import assert from 'node:assert/strict';

const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.3.0' }), onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: listener() },
  alarms: { create: async () => {}, onAlarm: listener() },
  tabs: {
    onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(),
    query: async () => [],
    get: async (tabId) => ({ id: tabId, windowId: 1, url: 'https://example.test/form', title: 'form', index: 0, active: true }),
    create: async () => ({ id: 1 }),
    remove: async () => {},
    update: async () => ({}),
    captureVisibleTab: async () => 'data:image/png;base64,',
    sendMessage: async () => ({ ok: true }),
  },
  windows: { getLastFocused: async () => ({ id: 1 }), get: async () => ({ id: 1, type: 'normal' }), create: async () => ({ id: 1 }), update: async () => ({}), getAll: async () => [] },
  debugger: { onEvent: listener(), onDetach: listener(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
  offscreen: { hasDocument: async () => false, createDocument: async () => {} },
  scripting: { executeScript: async () => [] },
  downloads: { onCreated: listener(), search: async () => [], download: async () => 1 },
  action: { openPopup: async () => {} },
  permissions: { contains: async () => true },
};

const { createBorrowGate, borrowGate, BORROW_STATUS } = await import('../../extension/src/lib/borrow-confirm.js');
const { createBorrowJourneys, borrowJourneys, JOURNEY_STATES } = await import('../../extension/src/lib/borrow.js');
const { createCooperationCoordinator, LEASE_KINDS } = await import('../../extension/src/lib/cooperate.js');
const { createControllerStateMachine } = await import('../../extension/src/lib/controller-state.js');
const { createPassthroughTokens } = await import('../../extension/src/lib/passthrough-token.js');
const { createHumanGate } = await import('../../extension/src/lib/human-gate.js');
const { createControlPlane } = await import('../../extension/src/lib/cooperate-control-plane.js');
const { HANDLERS, runSerialized } = await import('../../extension/src/dispatch.js');
const { controllerState } = await import('../../extension/src/lib/controller-state.js');

const RECORD = (tabId, overrides = {}) => ({
  tabId,
  document: 'https://example.test/form',
  documentEpoch: 1,
  revision: 7,
  controlRevision: 2,
  authorityRevision: 1,
  frameEpoch: 1,
  epoch: 2,
  generation: 3,
  ...overrides,
});

function isolatedWorld(tabId, clockValue = 1000) {
  let clock = clockValue;
  const now = () => clock;
  const planes = createControlPlane({ now, revisionRecord: (id) => RECORD(id) });
  const controller = createControllerStateMachine({ now });
  const human = createHumanGate({ now });
  const tokens = createPassthroughTokens({ now });
  const revisions = new Map();
  const revisionRecord = (id) => ({ ...RECORD(id), ...(revisions.get(id) || {}) });
  const bumpRevisions = (id, delta = {}) => {
    const next = { ...revisionRecord(id) };
    for (const [field, value] of Object.entries(delta)) next[field] = (next[field] || 0) + (typeof value === 'number' ? value : 1);
    revisions.set(id, next);
    return next;
  };
  const coordinator = createCooperationCoordinator({
    now,
    tokens,
    human,
    controller,
    revisionRecord,
    bumpRevisions,
    control: planes,
  });
  return { now, advance: (ms) => { clock += ms; return clock; }, planes, controller, human, tokens, coordinator, revisionRecord };
}

async function cleanup(tabId) {
  const { borrowJourneys } = await import('../../extension/src/lib/borrow.js');
  borrowJourneys.forget(tabId);
  borrowGate.clear(tabId);
  controllerState.clear(tabId);
}

test('tab.borrow 闸门：request/resolve/check 条件附加 contextId/policy/epoch + 确认窗口', async () => {
  const gate = createBorrowGate({ now: (() => { let clock = 1000; return () => clock; })() });
  const requested = gate.request(71, { requestId: 'ctl-71', timeoutMs: 60000 });
  assert.equal(requested.ok, true);
  assert.ok(requested.control, 'request 返回条件控制面字段');
  assert.match(requested.control.contextId, /^ctx-/);
  assert.equal(requested.control.policy, 'auto', '未协商时 policy=auto（兼容基线 legacy 缺省）');
  assert.equal(typeof requested.control.epoch, 'number', 'borrow 证据里的 epoch 是租约 epoch 标量');
  assert.equal(requested.control.decision, 'ask');
  assert.equal(requested.control.owner, 'human');
  assert.equal(requested.control.confirmation.timeoutMs, 60000);
  assert.equal(requested.control.confirmation.onTimeout, 'deny');
  assert.equal(requested.control.confirmation.timeoutCode, 'E_BORROW_TIMEOUT');
  assert.equal(requested.contextId, requested.control.contextId);
  assert.equal(requested.evidence.control.contextId, requested.control.contextId);

  const blocked = gate.check(71, 'click');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.evidence.control.decision, 'ask');
  assert.equal(blocked.evidence.control.owner, 'human');
  assert.ok(blocked.evidence.control.deadlineAt > 0);
  assert.equal(blocked.evidence.control.confirmation.timeoutMs, 60000);

  const denied = gate.resolve('ctl-71', { decision: 'deny' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.control.decision, 'deny');
  assert.equal(denied.control.owner, 'human');
  assert.equal(denied.control.policy, 'auto');
  assert.equal(gate.check(71, 'click').allowed, true, '既有判定不变：拒绝后不再阻塞');
  await cleanup(71);
});

test('tab.borrow 真实握手：allow 后 control 变 allow/owner=agent（既有 allowed 判定不变）', async () => {
  const { gate } = (() => { const value = createBorrowGate({}); return { gate: value }; })();
  const requested = gate.request(72, { requestId: 'ctl-72' });
  assert.equal(requested.status, BORROW_STATUS.PENDING);
  const allowed = gate.resolve('ctl-72', { decision: 'allow', allow: true });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.control.decision, 'allow');
  assert.equal(allowed.control.owner, 'agent');
  assert.equal(allowed.control.confirmation.timeoutMs, 60000);
  await cleanup(72);
});

test('真实消费：dispatch.assertBorrowAllowed 的拒绝 data 携带控制面证据（dispatch.js:499-508）', async () => {
  const tabId = 73;
  const original = HANDLERS.click;
  let calls = 0;
  HANDLERS.click = async () => { calls += 1; return { clicked: true }; };
  try {
    borrowGate.request(tabId, { requestId: 'ctl-73', timeoutMs: 60000 });
    await assert.rejects(
      () => runSerialized('click', { tabId }),
      (error) => {
        assert.equal(error && error.code, 'E_BORROW_CONFLICT');
        assert.ok(error.data && error.data.control, 'dispatch 拒绝 data 带 control 证据');
        assert.equal(error.data.control.decision, 'ask');
        assert.equal(error.data.control.owner, 'human');
        assert.match(error.data.control.contextId, /^ctx-/);
        assert.ok(error.data.control.confirmation.deadlineAt > 0);
        return true;
      },
    );
    assert.equal(calls, 0, '确认前动作不触达 handler（既有判定不变）');
    borrowGate.resolve('ctl-73', { decision: 'allow' });
    const result = await runSerialized('click', { tabId });
    assert.equal(calls, 1);
    assert.equal(result.clicked, true);
  } finally {
    HANDLERS.click = original;
    await cleanup(73);
  }
});

test('cooperate.acquire/release/snapshot：租约证据带 contextId/policy/epoch 与 token↔context 映射', async () => {
  const w = isolatedWorld(74);
  w.planes.notePolicy(74, 'target', { source: 'test' });
  const lease = w.coordinator.acquire(74, { kind: LEASE_KINDS.ACTION, method: 'click' });
  assert.equal(lease.ok, true);
  assert.ok(lease.evidence.control, 'acquire evidence.control');
  assert.match(lease.evidence.control.contextId, /^ctx-/);
  assert.equal(lease.evidence.control.policy, 'target');
  assert.equal(typeof lease.evidence.control.epoch, 'object');
  assert.equal(lease.evidence.control.decision, 'allow');
  assert.equal(lease.evidence.control.binding.token, lease.evidence.token, 'token 与租约证据一致（打码）');
  const contextId = lease.evidence.control.contextId;
  // 双向映射：token → context / context → token。
  assert.equal(w.planes.contextForToken(lease.token).contextId, contextId);
  assert.equal(w.planes.tokensForContext(contextId).length, 1);
  // 快照也带控制面（状态路径）。
  assert.equal(w.coordinator.snapshot(74).control.contextId, contextId);
  assert.equal(w.coordinator.snapshot(74).control.policy, 'target');
  const released = w.coordinator.release(lease.handle);
  assert.equal(released.released, true);
  assert.equal(released.evidence.control.contextId, contextId, 'release 证据回放同一 context');
  assert.equal(w.planes.contextForToken(lease.token), null, '释放后 token↔context 解绑');
});

test('mayAct：借用确认 pending 时控制面证据是 ask/human + 交接窗口截止时间', async () => {
  const w = isolatedWorld(75);
  const decided = w.coordinator.mayAct(75, {
    method: 'click',
    borrowGate: { allowed: false, code: 'E_BORROW_CONFLICT', status: 'pending', evidence: { requestId: 'req-75', pendingMs: 900, requestedAt: w.now(), timeoutMs: 60000 } },
  });
  assert.equal(decided.allowed, false, '既有判定不变');
  assert.equal(decided.code, 'E_BORROW_CONFLICT');
  assert.equal(decided.evidence.control.decision, 'ask');
  assert.equal(decided.evidence.control.owner, 'human');
  assert.ok(decided.evidence.control.deadlineAt >= w.now() + 59000);
  assert.equal(decided.evidence.control.window.state, 'handoff');
});

test('strict 策略单次消费：第一次 allow 后同一 context 再判定 deny（controller.ts:1863/1896）', async () => {
  const w = isolatedWorld(76);
  w.planes.notePolicy(76, 'strict', { source: 'test' });
  const first = w.coordinator.mayAct(76, { method: 'click' });
  assert.equal(first.evidence.control.policy, 'strict');
  assert.equal(first.evidence.control.decision, 'allow');
  assert.equal(first.evidence.control.singleUse, true);
  const second = w.coordinator.mayAct(76, { method: 'click' });
  assert.equal(second.evidence.control.decision, 'deny');
  assert.equal(second.evidence.control.reason, 'context-consumed');
  // 重新 sync（observe sync:true 会复位消费标志）后 strict 又能 allow；既有 allowed 判定始终由 human-gate 决定。
  w.planes.observe(76, { policy: 'strict', sync: true });
  const third = w.coordinator.mayAct(76, { method: 'click' });
  assert.equal(third.evidence.control.decision, 'allow');
});

test('借用旅程 begin：兼容基线 确认超时映射（默认 60s / 显式覆盖 / 超时 deny）进入证据', async () => {
  const journeys = createBorrowJourneys({ now: () => 5000 });
  journeys.bindGate(null);
  const begun = journeys.begin(77, { requestId: 'ctl-77', source: 'test' });
  assert.equal(begun.ok, true);
  assert.equal(begun.state, JOURNEY_STATES.REQUESTED);
  assert.equal(begun.confirmation.timeoutMs, 60000);
  assert.equal(begun.confirmation.onTimeout, 'deny');
  assert.equal(begun.confirmation.timeoutCode, 'E_BORROW_TIMEOUT');
  assert.equal(begun.confirmation.noConfirm.decidedBy, 'extension');
  assert.match(begun.control.contextId, /^ctx-/);
  assert.equal(begun.evidence.control.contextId, begun.control.contextId);
  const custom = journeys.begin(78, { requestId: 'ctl-78', timeoutMs: 5000 });
  assert.equal(custom.confirmation.timeoutMs, 5000);
  assert.equal(custom.confirmation.deadlineAt, 10000);
  journeys.forget(77);
  journeys.forget(78);
});

test('借用旅程交还：beginReturn/completeReturn 控制面证据随封存（只加字段）', async () => {
  const journeys = createBorrowJourneys({ now: (() => { let clock = 8000; return () => clock; })() });
  journeys.bindGate(null);
  journeys.begin(79, { requestId: 'ctl-79' });
  journeys.presented(79, { surface: 'modal' });
  journeys.decide('ctl-79', { decision: 'allow' });
  journeys.activate(79);
  const beganReturn = journeys.beginReturn(79);
  assert.equal(beganReturn.ok, true);
  assert.ok(beganReturn.evidence.control, '交还前证据带 control');
  assert.match(beganReturn.evidence.control.contextId, /^ctx-/);
  const completed = journeys.completeReturn(79);
  assert.equal(completed.ok, true);
  assert.equal(journeys.verify(79).ok, true, '封存链校验不受附加字段影响');
  assert.equal(completed.summary.control.contextId, beganReturn.evidence.control.contextId);
  journeys.forget(79);
});

test('控制面条件附加不改变旧输出：无旅程时 status 字段集合与旧版一致', async () => {
  const baseKeys = ['decision', 'expired', 'pendingMs', 'requestId', 'requestedAt', 'resolvedAt', 'status', 'surface', 'tabId', 'timeoutMs', 'title', 'windowId'];
  const gate = createBorrowGate({});
  gate.request(80, { requestId: 'ctl-80', timeoutMs: 60000 });
  const { borrowJourneys } = await import('../../extension/src/lib/borrow.js');
  borrowJourneys.forget(80);
  const plain = gate.status(80);
  assert.deepEqual(Object.keys(plain).sort(), baseKeys.slice().sort(), '没有旅程证据时不附加 control/journey');
  assert.equal(Object.prototype.hasOwnProperty.call(plain, 'control'), false);
  gate.clear(80);
  controllerState.clear(80);
});
