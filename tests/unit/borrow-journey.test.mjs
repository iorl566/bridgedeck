// borrow journey：借用确认 → 决策 → 交还的证据闭环（哈希链/对账/过期/强制交还）。
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
  createBorrowJourneys,
  borrowJourneys: singletonJourneys,
  JOURNEY_STATES,
  JOURNEY_EVENTS,
  JOURNEY_TRANSITIONS,
  JOURNEY_ANOMALIES,
  JOURNEY_ERRORS,
  journeyTransitionFor,
  journeyAllowedEvents,
  chainEntry,
  sealChain,
  verifyChain,
  describeJourney,
} = await import('../../extension/src/lib/borrow.js');
const { createBorrowGate, BORROW_STATUS } = await import('../../extension/src/lib/borrow-confirm.js');
const { createCooperationCoordinator, LEASE_KINDS } = await import('../../extension/src/lib/cooperate.js');
const { createPassthroughTokens } = await import('../../extension/src/lib/passthrough-token.js');
const { createHumanGate } = await import('../../extension/src/lib/human-gate.js');
const { createControllerStateMachine } = await import('../../extension/src/lib/controller-state.js');

function world(start = 1000) {
  let clock = start;
  const now = () => clock;
  const advance = (ms) => { clock += ms; return clock; };
  const tokens = createPassthroughTokens({ now });
  const human = createHumanGate({ now });
  const controller = createControllerStateMachine({ now });
  const suppression = {
    begin: () => ({ ok: true, scopeId: 'sup-x', count: 1 }),
    end: () => ({ ok: true, released: true }),
    snapshot: () => ({ active: false, live: [], count: 0 }),
  };
  const capture = { snapshot: () => ({ count: 0, effective: false, holders: [] }) };
  const coordinator = createCooperationCoordinator({ now, tokens, human, controller, suppression, capture });
  const gate = createBorrowGate({ now });
  const journeys = createBorrowJourneys({ now, gate, tokens, controller, coordinator, timeoutMs: 60000 });
  journeys.bindGate(gate);
  return { now, advance, tokens, human, controller, coordinator, gate, journeys };
}

test('旅程迁移表：合法/非法迁移与允许事件列表', () => {
  assert.equal(journeyTransitionFor(null, JOURNEY_EVENTS.REQUEST), JOURNEY_STATES.REQUESTED);
  assert.equal(journeyTransitionFor(JOURNEY_STATES.REQUESTED, JOURNEY_EVENTS.PRESENTED), JOURNEY_STATES.PRESENTED);
  assert.equal(journeyTransitionFor(JOURNEY_STATES.PRESENTED, JOURNEY_EVENTS.DECISION_ALLOW), JOURNEY_STATES.ALLOWED);
  assert.equal(journeyTransitionFor(JOURNEY_STATES.ALLOWED, JOURNEY_EVENTS.CONFIRM), JOURNEY_STATES.CONFIRMED);
  assert.equal(journeyTransitionFor(JOURNEY_STATES.CONFIRMED, JOURNEY_EVENTS.ACTIVATE), JOURNEY_STATES.ACTIVE);
  assert.equal(journeyTransitionFor(JOURNEY_STATES.ACTIVE, JOURNEY_EVENTS.RETURN_BEGIN), JOURNEY_STATES.RETURNING);
  assert.equal(journeyTransitionFor(JOURNEY_STATES.RETURNING, JOURNEY_EVENTS.RETURN_COMPLETE), JOURNEY_STATES.RETURNED);
  assert.equal(journeyTransitionFor(JOURNEY_STATES.DENIED, JOURNEY_EVENTS.CONFIRM), null, '被拒绝的借用不能确认');
  assert.equal(journeyTransitionFor(JOURNEY_STATES.RETURNED, JOURNEY_EVENTS.ACTIVATE), null);
  assert.deepEqual(journeyAllowedEvents(null).includes(JOURNEY_EVENTS.REQUEST), true);
  const keys = new Set();
  for (const rule of JOURNEY_TRANSITIONS) {
    for (const from of rule.from) {
      const key = String(from) + '|' + rule.event;
      assert.equal(keys.has(key), false, '迁移表重复：' + key);
      keys.add(key);
    }
  }
});

test('哈希链：chainEntry 逐条链接，sealChain 封存，verifyChain 定位被改条目', () => {
  const entries = [];
  entries.push(chainEntry(null, { seq: 1, kind: 'request', at: 1000, data: { requestId: 'r1' } }));
  entries.push(chainEntry(entries[0], { seq: 2, kind: 'presented', at: 1100, data: { surface: 'modal' } }));
  entries.push(chainEntry(entries[1], { seq: 3, kind: 'decision.allow', at: 1200, data: { decision: 'allow' } }));
  assert.equal(entries[0].prevDigest, 'genesis');
  assert.equal(entries[1].prevDigest, entries[0].digest);
  assert.equal(entries[2].prevDigest, entries[1].digest);
  const sealed = sealChain(entries, { tabId: 1, requestId: 'r1' });
  assert.equal(sealed.count, 3);
  assert.equal(sealed.firstAt, 1000);
  assert.equal(sealed.lastAt, 1200);
  assert.equal(verifyChain(sealed).ok, true);
  const tampered = { ...sealed, entries: sealed.entries.map((entry, index) => (index === 1 ? { ...entry, data: { surface: 'toast' } } : entry)) };
  const check = verifyChain(tampered);
  assert.equal(check.ok, false);
  assert.equal(check.code, JOURNEY_ANOMALIES.EVIDENCE_TAMPERED);
  assert.equal(check.index, 1);
  assert.equal(verifyChain(null).ok, false);
  assert.equal(verifyChain(sealChain([])).ok, true, '空链也能校验');
});

test('begin（不触闸门）：requested 状态、requestId 索引、entry 数', () => {
  const w = world();
  const begun = w.journeys.begin(1, { requestId: 'r-1', title: '商店', timeoutMs: 30000 });
  assert.equal(begun.ok, true);
  assert.equal(begun.state, JOURNEY_STATES.REQUESTED);
  assert.equal(begun.entryCount, 1);
  const journey = w.journeys.journey(1);
  assert.equal(journey.requestId, 'r-1');
  assert.equal(journey.title, '商店');
  assert.equal(journey.timeoutMs, 30000);
  assert.equal(journey.entryCount, 1);
  assert.equal(w.journeys.byRequestId('r-1').tabId, 1);
  assert.equal(w.journeys.byRequestId('missing'), null);
  assert.match(describeJourney(journey), /borrow=requested/);
  assert.equal(w.journeys.begin(null).code, JOURNEY_ERRORS.BAD_ARG);
});

test('observeGateEvent：request/presented/resolve 全链路（真实借用闸门事件形状）', () => {
  const w = world();
  const request = w.journeys.observeGateEvent({ type: 'request', tabId: 2, requestId: 'r-2', title: '结算', timeoutMs: 60000, at: w.now() });
  assert.equal(request.ok, true);
  assert.equal(request.state, JOURNEY_STATES.REQUESTED);
  const duplicate = w.journeys.observeGateEvent({ type: 'request', tabId: 2, requestId: 'r-2b', title: '结算', at: w.now() });
  assert.equal(duplicate.ignored, true, '已有同一旅程时重复 request 被忽略');
  const presented = w.journeys.observeGateEvent({ type: 'presented', tabId: 2, requestId: 'r-2', surface: 'modal', at: w.now() + 50 });
  assert.equal(presented.ok, true);
  assert.equal(presented.state, JOURNEY_STATES.PRESENTED);
  assert.equal(presented.surface, 'modal');
  const resolved = w.journeys.observeGateEvent({ type: 'resolve', tabId: 2, requestId: 'r-2', status: 'confirmed', decision: 'allow', at: w.now() + 100 });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.decision, 'allow');
  assert.equal(resolved.state, JOURNEY_STATES.CONFIRMED);
  const journey = w.journeys.journey(2);
  assert.equal(journey.decision, 'allow');
  assert.equal(journey.confirmedAt > 0, true);
  assert.equal(journey.entryCount >= 4, true);
});

test('observeGateEvent：deny/timeout/cancel/clear/check-blocked 证据事件', () => {
  const w = world();
  w.journeys.observeGateEvent({ type: 'request', tabId: 3, requestId: 'r-3', at: w.now() });
  const deny = w.journeys.observeGateEvent({ type: 'resolve', tabId: 3, requestId: 'r-3', status: 'denied', decision: 'deny', at: w.now() });
  assert.equal(deny.state, JOURNEY_STATES.DENIED);
  assert.equal(w.journeys.observeGateEvent({ type: 'resolve', tabId: 3, requestId: 'r-3', status: 'denied', decision: 'deny' }).ok, false, '已终态的重复 resolve 被拒绝（不重复推进）');

  w.journeys.observeGateEvent({ type: 'request', tabId: 4, requestId: 'r-4', at: w.now() });
  const timeout = w.journeys.observeGateEvent({ type: 'resolve', tabId: 4, requestId: 'r-4', status: 'timeout', decision: 'timeout', at: w.now() });
  assert.equal(timeout.state, JOURNEY_STATES.TIMEOUT);

  w.journeys.observeGateEvent({ type: 'request', tabId: 5, requestId: 'r-5' });
  const cancelled = w.journeys.observeGateEvent({ type: 'cancel', tabId: 5, requestId: 'r-5', reason: 'overlay-closed', at: w.now() });
  assert.equal(cancelled.state, JOURNEY_STATES.CANCELLED);

  w.journeys.observeGateEvent({ type: 'request', tabId: 6, requestId: 'r-6' });
  const before = w.journeys.journey(6).entryCount;
  const cleared = w.journeys.observeGateEvent({ type: 'clear', tabId: 6, reason: 'borrow.clear', at: w.now() });
  assert.equal(cleared.ok, true);
  assert.equal(w.journeys.journey(6).state, JOURNEY_STATES.REQUESTED, 'clear 不改变状态，只记录');
  assert.equal(w.journeys.journey(6).entryCount, before + 1);

  const blocked = w.journeys.observeGateEvent({ type: 'check-blocked', tabId: 6, method: 'click', pendingMs: 900, at: w.now() });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.blockedChecks, 1);
  assert.equal(w.journeys.journey(6).checkBlocked, 1);
  assert.equal(w.journeys.observeGateEvent({ type: 'unknown', tabId: 6 }).ignored, true);
  assert.equal(w.journeys.observeGateEvent({ type: 'request', tabId: null }).ignored, true);
});

test('手动 API：begin → presented → decide(allow) → activate → beginReturn → completeReturn 全链封存', () => {
  const w = world();
  w.journeys.begin(7, { requestId: 'r-7', title: '订单' });
  assert.equal(w.journeys.presented(7, { surface: 'toast', surfaceTabId: 9 }).state, JOURNEY_STATES.PRESENTED);
  const decided = w.journeys.decide('r-7', { decision: 'allow' });
  assert.equal(decided.ok, true);
  assert.equal(decided.allowed, true);
  assert.equal(decided.state, JOURNEY_STATES.CONFIRMED);
  assert.equal(w.journeys.activate(7, { method: 'click' }).state, JOURNEY_STATES.ACTIVE);
  const beginReturn = w.journeys.beginReturn(7, { reason: 'tab.return' });
  assert.equal(beginReturn.ok, true);
  assert.equal(beginReturn.state, JOURNEY_STATES.RETURNING);
  assert.ok(beginReturn.evidence.revisions.before);
  assert.ok(beginReturn.toolbar, '交还证据里带用户看到的工具栏');
  const completed = w.journeys.completeReturn(7, { reason: 'tab.return' });
  assert.equal(completed.ok, true);
  assert.equal(completed.state, JOURNEY_STATES.RETURNED);
  assert.equal(completed.summary.decision, 'allow');
  assert.equal(completed.sealed.count >= 5, true);
  assert.equal(verifyChain(completed.sealed).ok, true);
  assert.equal(w.journeys.verify(7).ok, true);
  assert.equal(w.journeys.verify('bad').code, JOURNEY_ERRORS.NOT_FOUND);
  assert.equal(w.journeys.decide('missing', { decision: 'allow' }).code, JOURNEY_ERRORS.NOT_FOUND);
});

test('交还前置：活跃租约 fail closed（E_LEASE_ACTIVE + 异常证据），force 才继续', () => {
  const w = world();
  w.journeys.begin(8, { requestId: 'r-8' });
  const lease = w.coordinator.acquire(8, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click', respectHuman: false });
  assert.equal(lease.ok, true, 'beginReturn 之前存在 passthrough 租约');
  const blocked = w.journeys.beginReturn(8, { reason: 'try' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, JOURNEY_ERRORS.LEASE_ACTIVE);
  assert.equal(blocked.evidence.leases.length, 1);
  assert.equal(w.journeys.journey(8).state, JOURNEY_STATES.REQUESTED);
  assert.equal(w.journeys.journey(8).anomalies.includes(JOURNEY_ANOMALIES.LEASE_AFTER_RETURN), true);
  w.coordinator.release(lease.handle);
  const forced = w.journeys.completeReturn(8, { force: true });
  assert.equal(forced.ok, true);
});

test('sweep：超过 timeoutMs 的 pending 旅程标记 expired 并记异常', () => {
  const w = world();
  w.journeys.begin(9, { requestId: 'r-9', timeoutMs: 1000 });
  w.journeys.begin(10, { requestId: 'r-10', timeoutMs: 5000 });
  const swept = w.journeys.sweep(3000);
  assert.equal(swept.count, 1);
  assert.equal(swept.expired[0].tabId, 9);
  assert.equal(swept.expired[0].requestId, 'r-9');
  assert.equal(w.journeys.journey(9).state, JOURNEY_STATES.EXPIRED);
  assert.equal(w.journeys.journey(9).anomalies.includes(JOURNEY_ANOMALIES.PENDING_EXPIRED), true);
  assert.equal(w.journeys.journey(10).state, JOURNEY_STATES.REQUESTED, '未超时的不动');
  assert.equal(w.journeys.sweep(9999).count, 1);
});

test('reconcile：交还后 controller 仍是 borrowed / 浮层未关 / 租约残留都能报异常', () => {
  const w = world();
  w.journeys.begin(11, { requestId: 'r-11' });
  w.journeys.presented(11, { surface: 'modal' });
  w.journeys.decide('r-11', { decision: 'allow' });
  w.journeys.activate(11);
  w.journeys.beginReturn(11);
  w.journeys.completeReturn(11);
  assert.equal(w.journeys.journey(11).state, JOURNEY_STATES.RETURNED);
  // 模拟 controller 没被交还（外部 adopt 回 borrowed）。
  w.controller.transition(11, 'agent.claim', { source: 'test' });
  w.controller.transition(11, 'borrow.request', { requestId: 'x11', source: 'test' });
  w.controller.transition(11, 'borrow.confirm', { confirmed: true, requestId: 'x11', decision: 'allow', source: 'test' });
  const reconciled = w.journeys.reconcile(11);
  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.anomalies.some((anomaly) => anomaly.code === JOURNEY_ANOMALIES.CONTROLLER_AFTER_RETURN), true);
  // 交还后仍有活跃租约也能被发现。
  const lease = w.coordinator.acquire(11, { kind: LEASE_KINDS.ACTION, respectHuman: false });
  const again = w.journeys.reconcile(11);
  assert.equal(again.anomalies.some((anomaly) => anomaly.code === JOURNEY_ANOMALIES.LEASE_AFTER_RETURN), true);
  w.coordinator.release(lease.handle);
});

test('seal/verify：封存后可校验，篡改链给出 EVIDENCE_TAMPERED', () => {
  const w = world();
  w.journeys.begin(12, { requestId: 'r-12' });
  assert.equal(w.journeys.verify(12).ok, false, '尚未封存时没有可校验证书');
  const sealed = w.journeys.seal(12);
  assert.equal(sealed.ok, true);
  assert.equal(w.journeys.verify(12).ok, true);
  const tampered = { ...sealed.sealed, entries: sealed.sealed.entries.map((entry) => ({ ...entry, at: entry.at + 1 })) };
  assert.equal(w.journeys.verify(tampered).ok, false);
  assert.equal(w.journeys.seal(null).code, JOURNEY_ERRORS.BAD_ARG);
  assert.equal(w.journeys.seal(999).code, JOURNEY_ERRORS.NOT_FOUND);
});

test('blockedEvidence：借用确认被拦截时附上旅程 + 工具栏精简证据', () => {
  const w = world();
  w.journeys.begin(13, { requestId: 'r-13', title: '付款' });
  w.journeys.presented(13, { surface: 'modal' });
  const evidence = w.journeys.blockedEvidence(13, { borrow: { status: BORROW_STATUS.PENDING, requestId: 'r-13', requestedAt: w.now(), timeoutMs: 60000, title: '付款', surface: 'modal' } });
  assert.equal(evidence.journey.state, JOURNEY_STATES.PRESENTED);
  assert.equal(evidence.journey.requestId, 'r-13');
  assert.equal(evidence.journey.surface, 'modal');
  assert.equal(evidence.toolbar.mode, 'borrow-confirm');
  assert.equal(evidence.toolbar.actions.some((action) => action.id === 'borrow.allow' && action.enabled), true);
  assert.equal(evidence.toolbar.actions.some((action) => action.id === 'borrow.deny' && action.enabled), true);
  assert.match(evidence.toolbar.ariaLabel, /借用确认/);
  assert.equal(w.journeys.blockedEvidence(null), null);
});

test('liveFacts/snapshot/list/counters/forget/reset：只读聚合与清理', () => {
  const w = world();
  w.journeys.begin(14, { requestId: 'r-14', title: 'A' });
  w.journeys.begin(15, { requestId: 'r-15', title: 'B' });
  const facts = w.journeys.liveFacts(14);
  assert.equal(facts.tabId, 14);
  assert.equal(facts.controllerState, null);
  assert.deepEqual(facts.leases, []);
  assert.equal(facts.leaseDepth, 0);
  assert.equal(Array.isArray(facts.overlays.overlays), true);
  const snapshot = w.journeys.snapshot(14);
  assert.equal(snapshot.journey.state, JOURNEY_STATES.REQUESTED);
  assert.equal(snapshot.counters.begun, 2);
  const list = w.journeys.list();
  assert.equal(list.length, 2);
  assert.equal(w.journeys.counters().tabs, 2);
  assert.equal(w.journeys.counters().active, 2);
  assert.equal(w.journeys.forget(14), true);
  assert.equal(w.journeys.journey(14), null);
  w.journeys.reset();
  assert.equal(w.journeys.list().length, 0);
  assert.equal(w.journeys.counters().tabs, 0);
});

test('单例 borrowJourneys 暴露全 API（模块级接线冒烟）', () => {
  assert.equal(typeof singletonJourneys.observeGateEvent, 'function');
  assert.equal(typeof singletonJourneys.completeReturn, 'function');
  assert.equal(typeof singletonJourneys.verifyChain, 'function');
  assert.equal(typeof singletonJourneys.blockedEvidence, 'function');
  assert.equal(typeof singletonJourneys.bindGate, 'function');
  assert.equal(typeof singletonJourneys.sweep, 'function');
  assert.equal(typeof singletonJourneys.reconcile, 'function');
});
