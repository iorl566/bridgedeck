// borrow 证据闭环的真实接线：tabs-borrow/dispatch 走的 borrowGate 事件 → borrowJourneys 证据链。
// 这里用真实单例（borrowGate / borrowJourneys / controllerState / cooperationCoordinator），
// 验证默认行为只加不改：判定不变，条件附加 journey/toolbar 字段。
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
  tabs: {
    onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(),
    query: async () => [],
    get: async (tabId) => ({ id: tabId, windowId: 1, url: 'https://example.test/shop', title: 'shop', index: 0, active: true }),
    sendMessage: async () => ({ ok: true }),
    update: async () => ({}),
  },
  windows: { getLastFocused: async () => ({ id: 1 }), get: async () => ({ id: 1 }), update: async () => ({}) },
  scripting: { executeScript: async () => [] },
  permissions: { contains: async () => true },
};

const { borrowGate, createBorrowGate, BORROW_STATUS } = await import('../../extension/src/lib/borrow-confirm.js');
const { borrowJourneys, JOURNEY_STATES, JOURNEY_ANOMALIES, JOURNEY_ERRORS, verifyChain } = await import('../../extension/src/lib/borrow.js');
const { cooperationCoordinator, LEASE_KINDS } = await import('../../extension/src/lib/cooperate.js');
const { controllerState } = await import('../../extension/src/lib/controller-state.js');
const { passthroughTokens } = await import('../../extension/src/lib/passthrough-token.js');
const { toolbarBlockedEvidence, toolbarController, TOOLBAR_ACTION_IDS } = await import('../../extension/src/lib/toolbar.js');
const { controlGenerationRecord, clearControlGeneration } = await import('../../extension/src/control-generation.js');

function cleanup(tabId) {
  try { borrowGate.clear(tabId); } catch { /* 清理不抛 */ }
  controllerState.clear(tabId);
  borrowJourneys.forget(tabId);
  cooperationCoordinator.forget(tabId);
  clearControlGeneration(tabId);
}

function cleanupMany(...tabIds) {
  for (const tabId of tabIds) cleanup(tabId);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('真实借用闸门事件自动进入证据链：request → 旅程 requested，status 条件附加 journey', () => {
  const tabId = 501;
  try {
    const requested = borrowGate.request(tabId, { requestId: 'ev-501', timeoutMs: 60000, windowId: 2, title: '结算页', surface: null });
    assert.equal(requested.ok, true);
    const journey = borrowJourneys.journey(tabId);
    assert.equal(journey.state, JOURNEY_STATES.REQUESTED);
    assert.equal(journey.requestId, 'ev-501');
    assert.equal(journey.entryCount, 1);
    const status = borrowGate.status(tabId);
    assert.equal(status.status, BORROW_STATUS.PENDING);
    assert.equal(status.journey.state, JOURNEY_STATES.REQUESTED);
    assert.equal(status.journey.requestId, 'ev-501');
    assert.equal(controllerState.get(tabId), 'handoff');
  } finally {
    cleanupMany(tabId);
  }
});

test('拦截证据条件附加 toolbar + journey：判定与 0.3.0 一致，默认字段不变', () => {
  const tabId = 502;
  try {
    borrowGate.request(tabId, { requestId: 'ev-502', timeoutMs: 60000, windowId: 3, title: '付款页' });
    const blocked = borrowGate.check(tabId, 'click');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.code, 'E_BORROW_CONFLICT');
    // 既有字段完全保留（默认路径不变）。
    assert.equal(blocked.evidence.requestId, 'ev-502');
    assert.equal(blocked.evidence.allowedAfter, 'borrow.confirm');
    assert.equal(blocked.evidence.tabId, tabId);
    assert.equal(blocked.evidence.status, 'pending');
    // 新增字段：用户看到的工具栏动作 + 旅程链位置。
    assert.equal(blocked.evidence.toolbar.mode, 'borrow-confirm');
    assert.equal(blocked.evidence.toolbar.focusId, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
    assert.equal(blocked.evidence.toolbar.actions.find((action) => action.id === TOOLBAR_ACTION_IDS.BORROW_ALLOW).enabled, true);
    assert.equal(blocked.evidence.toolbar.actions.find((action) => action.id === TOOLBAR_ACTION_IDS.BORROW_DENY).enabled, true);
    assert.match(blocked.evidence.toolbar.ariaLabel, /借用确认/);
    assert.equal(blocked.evidence.journey.state, JOURNEY_STATES.REQUESTED);
    assert.equal(blocked.evidence.journey.blockedChecks, 1);
    assert.equal(borrowJourneys.journey(tabId).checkBlocked, 1);
    // 再拦一次：阻断计数累积。
    borrowGate.check(tabId, 'fill');
    assert.equal(borrowJourneys.journey(tabId).checkBlocked, 2);
  } finally {
    cleanupMany(tabId);
  }
});

test('真实 resolve(allow)：旅程 confirmed，controller borrowed，动作放行', () => {
  const tabId = 503;
  try {
    borrowGate.request(tabId, { requestId: 'ev-503', timeoutMs: 60000, windowId: 4, title: 'checkout' });
    const allowed = borrowGate.resolve('ev-503', { decision: 'allow', allow: true });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.status, BORROW_STATUS.CONFIRMED);
    const journey = borrowJourneys.journey(tabId);
    assert.equal(journey.state, JOURNEY_STATES.CONFIRMED);
    assert.equal(journey.decision, 'allow');
    assert.equal(journey.confirmedAt > 0, true);
    assert.equal(controllerState.get(tabId), 'borrowed');
    assert.equal(borrowGate.check(tabId, 'click').allowed, true);
    assert.equal(borrowJourneys.journey(tabId).entryCount >= 3, true);
  } finally {
    cleanupMany(tabId);
  }
});

test('tab.return 真实交还：租约清空 → controller borrow.return → 证据封存可校验', () => {
  const tabId = 504;
  try {
    borrowGate.request(tabId, { requestId: 'ev-504', timeoutMs: 60000, windowId: 5, title: 'return-flow' });
    borrowGate.resolve('ev-504', { decision: 'allow' });
    const begun = borrowJourneys.beginReturn(tabId, { reason: 'tab.return' });
    assert.equal(begun.ok, true);
    assert.equal(begun.state, JOURNEY_STATES.RETURNING);
    const completed = borrowJourneys.completeReturn(tabId, { source: 'tab.return', reason: 'tab.return' });
    assert.equal(completed.ok, true);
    assert.equal(completed.state, JOURNEY_STATES.RETURNED);
    assert.equal(completed.summary.controller.accepted, 'borrow.return');
    assert.equal(controllerState.get(tabId), 'idle');
    assert.equal(verifyChain(completed.sealed).ok, true);
    assertEqualsArray(completed.summary.overlays.overlays, []);
    borrowGate.clear(tabId);
    assert.equal(borrowGate.status(tabId), null, 'tab.return 后闸门记录被清掉');
    assert.equal(borrowJourneys.journey(tabId).state, JOURNEY_STATES.RETURNED);
  } finally {
    cleanupMany(tabId);
  }
});

function assertEqualsArray(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
}

test('真实 resolve(deny)：旅程 denied，controller idle，对账无异常', () => {
  const tabId = 505;
  try {
    borrowGate.request(tabId, { requestId: 'ev-505', timeoutMs: 60000 });
    const denied = borrowGate.resolve('ev-505', { decision: 'deny' });
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 'E_BORROW_DENIED');
    assert.equal(borrowJourneys.journey(tabId).state, JOURNEY_STATES.DENIED);
    assert.equal(controllerState.get(tabId), 'idle');
    borrowGate.clear(tabId);
    const reconciled = borrowJourneys.reconcile(tabId);
    assert.equal(reconciled.ok, true);
    assert.deepEqual(reconciled.anomalies, []);
  } finally {
    cleanupMany(tabId);
  }
});

test('超时扫描：pending 旅程过期 → expired + PENDING_EXPIRED 异常（真实时钟）', async () => {
  const tabId = 506;
  try {
    borrowGate.request(tabId, { requestId: 'ev-506', timeoutMs: 5, windowId: 6 });
    await sleep(20);
    const swept = borrowJourneys.sweep();
    assert.equal(swept.count >= 1, true);
    assert.equal(swept.expired.some((entry) => entry.tabId === tabId), true);
    const journey = borrowJourneys.journey(tabId);
    assert.equal(journey.state, JOURNEY_STATES.EXPIRED);
    assert.equal(journey.anomalies.includes(JOURNEY_ANOMALIES.PENDING_EXPIRED), true);
  } finally {
    cleanupMany(tabId);
  }
});

test('交还前置 fail closed：有活跃租约时 beginReturn 拒绝（E_LEASE_ACTIVE）', () => {
  const tabId = 507;
  try {
    borrowGate.request(tabId, { requestId: 'ev-507', timeoutMs: 60000 });
    borrowGate.resolve('ev-507', { decision: 'allow' });
    const lease = cooperationCoordinator.acquire(tabId, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click', respectHuman: false });
    assert.equal(lease.ok, true);
    const blocked = borrowJourneys.beginReturn(tabId);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, JOURNEY_ERRORS.LEASE_ACTIVE);
    assert.equal(blocked.evidence.leases.length, 1);
    cooperationCoordinator.release(lease.handle);
    const completed = borrowJourneys.completeReturn(tabId, { force: true });
    assert.equal(completed.ok, true);
  } finally {
    cleanupMany(tabId);
  }
});

test('交还撤销 passthrough token：revokedTokens 计数且 list 清空', () => {
  const tabId = 508;
  try {
    borrowGate.request(tabId, { requestId: 'ev-508', timeoutMs: 60000 });
    borrowGate.resolve('ev-508', { decision: 'allow' });
    const lease = cooperationCoordinator.acquire(tabId, { kind: LEASE_KINDS.ACTION, method: 'click', respectHuman: false });
    cooperationCoordinator.release(lease.handle);
    assert.equal(passthroughTokens.list('coop:' + tabId).length, 1);
    borrowJourneys.beginReturn(tabId);
    const completed = borrowJourneys.completeReturn(tabId);
    assert.equal(completed.ok, true);
    assert.equal(completed.summary.revokedTokens >= 1, true, '交还时撤销该 tab 的租约令牌');
    assert.equal(passthroughTokens.list('coop:' + tabId).length, 0);
  } finally {
    cleanupMany(tabId);
  }
});

test('交还推进 revision 链：controlRevision 单调增加（真实 revision-chain）', () => {
  const tabId = 509;
  clearControlGeneration(tabId);
  try {
    borrowGate.request(tabId, { requestId: 'ev-509', timeoutMs: 60000 });
    borrowGate.resolve('ev-509', { decision: 'allow' });
    borrowJourneys.beginReturn(tabId);
    const before = controlGenerationRecord(tabId);
    const completed = borrowJourneys.completeReturn(tabId);
    assert.equal(completed.ok, true);
    const after = controlGenerationRecord(tabId);
    assert.ok(after.controlRevision > before.controlRevision, 'borrow.return 推进 controlRevision');
    assert.equal(completed.summary.revisions.before.controlRevision, before.controlRevision);
    assert.equal(completed.summary.revisions.after.controlRevision, after.controlRevision);
    assert.equal(typeof completed.summary.revisions.stale, 'boolean');
  } finally {
    cleanupMany(tabId);
  }
});

test('证据链防篡改：封存后改动任一 entry 会被 verify 抓到', () => {
  const tabId = 510;
  try {
    borrowGate.request(tabId, { requestId: 'ev-510', timeoutMs: 60000, title: 'tamper' });
    borrowGate.resolve('ev-510', { decision: 'allow' });
    borrowJourneys.beginReturn(tabId);
    const completed = borrowJourneys.completeReturn(tabId);
    assert.equal(borrowJourneys.verify(tabId).ok, true);
    const tampered = {
      ...completed.sealed,
      entries: completed.sealed.entries.map((entry, index) => (index === 0 ? { ...entry, data: { ...entry.data, requestId: 'forged' } } : entry)),
    };
    const checked = borrowJourneys.verify(tampered);
    assert.equal(checked.ok, false);
    assert.equal(checked.code, JOURNEY_ANOMALIES.EVIDENCE_TAMPERED);
  } finally {
    cleanupMany(tabId);
  }
});

test('交还后 controller 仍 borrowed：reconcile 报 CONTROLLER_AFTER_RETURN（只报告不修状态）', () => {
  const tabId = 511;
  try {
    borrowGate.request(tabId, { requestId: 'ev-511', timeoutMs: 60000 });
    borrowGate.resolve('ev-511', { decision: 'allow' });
    borrowJourneys.beginReturn(tabId);
    borrowJourneys.completeReturn(tabId);
    assert.equal(controllerState.get(tabId), 'idle');
    controllerState.adopt(tabId, 'borrowed', { event: 'test.regress' });
    const reconciled = borrowJourneys.reconcile(tabId);
    assert.equal(reconciled.ok, false);
    assert.equal(reconciled.anomalies.some((anomaly) => anomaly.code === JOURNEY_ANOMALIES.CONTROLLER_AFTER_RETURN), true);
    assert.equal(controllerState.get(tabId), 'borrowed', '对账不修改真实状态');
  } finally {
    cleanupMany(tabId);
  }
});

test('默认行为不变：status 的既有字段集合保留，journey 只在证据存在时附加', () => {
  const baseKeys = ['decision', 'expired', 'pendingMs', 'requestId', 'requestedAt', 'resolvedAt', 'status', 'surface', 'tabId', 'timeoutMs', 'title', 'windowId'];
  const isolated = createBorrowGate({});
  const requested = isolated.request(512, { requestId: 'iso-512', timeoutMs: 60000, title: 'x' });
  assert.equal(requested.ok, true);
  // 证据可用时：既有 12 个字段全部保留，仅条件附加 journey。
  const withEvidence = isolated.status(512);
  for (const key of baseKeys) assert.equal(Object.prototype.hasOwnProperty.call(withEvidence, key), true, '缺少既有字段：' + key);
  assert.equal(withEvidence.journey.state, JOURNEY_STATES.REQUESTED);
  // 旁路证据不可用（被清理）时：输出与 0.3.0 完全一致，多出的 journey 字段消失。
  borrowJourneys.forget(512);
  const plain = isolated.status(512);
  assert.deepEqual(Object.keys(plain).sort(), baseKeys.slice().sort());
  assert.equal(Object.prototype.hasOwnProperty.call(plain, 'journey'), false);
  controllerState.clear(512);
});

test('toolbarBlockedEvidence：直接构造借用确认工具栏证据；suppress/bad-tab 返回 null', () => {
  const tabId = 513;
  try {
    borrowGate.request(tabId, { requestId: 'ev-513', timeoutMs: 60000, title: '工具条' });
    const evidence = toolbarBlockedEvidence(tabId, {
      borrow: { status: 'pending', requestId: 'ev-513', requestedAt: Date.now(), timeoutMs: 60000, title: '工具条', surface: 'modal' },
    });
    assert.equal(evidence.mode, 'borrow-confirm');
    assert.equal(evidence.modal, true);
    assert.equal(evidence.actions.length, 2);
    assert.equal(evidence.actions[0].id, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
    assert.equal(toolbarBlockedEvidence(tabId, { suppress: true }), null);
    assert.equal(toolbarBlockedEvidence(null), null);
    const model = toolbarController.model(tabId, {
      borrow: { status: 'pending', requestId: 'ev-513', requestedAt: Date.now(), timeoutMs: 60000, title: '工具条', surface: 'modal' },
    });
    assert.equal(model.mode, 'borrow-confirm');
  } finally {
    cleanupMany(tabId);
  }
});

test('blockedEvidence：journey + toolbar 一次给全（dispatch 错误证据可用）', () => {
  const tabId = 514;
  try {
    borrowGate.request(tabId, { requestId: 'ev-514', timeoutMs: 60000 });
    borrowGate.check(tabId, 'click');
    const evidence = borrowJourneys.blockedEvidence(tabId, {
      borrow: { status: 'pending', requestId: 'ev-514', requestedAt: Date.now(), timeoutMs: 60000 },
    });
    assert.equal(evidence.journey.state, JOURNEY_STATES.REQUESTED);
    assert.equal(evidence.journey.blockedChecks, 1);
    assert.equal(evidence.toolbar.mode, 'borrow-confirm');
    assert.equal(evidence.toolbar.focusId, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
    assert.equal(evidence.checkedAt > 0, true);
    assert.equal(borrowJourneys.blockedEvidence(null), null);
  } finally {
    cleanupMany(tabId);
  }
});

test('observeGateEvent 容错：非法/未知事件返回 ignored，不影响借用流程', () => {
  const ignoredNull = borrowJourneys.observeGateEvent(null);
  assert.equal(ignoredNull.ok, false);
  assert.equal(ignoredNull.ignored, true);
  const ignoredUnknown = borrowJourneys.observeGateEvent({ type: 'mystery', tabId: 515 });
  assert.equal(ignoredUnknown.ignored, true);
  const ignoredResolve = borrowJourneys.observeGateEvent({ type: 'resolve', tabId: 516, requestId: 'nope', status: 'confirmed' });
  assert.equal(ignoredResolve.ignored, true);
  controllerState.clear(515);
  controllerState.clear(516);
});

test('计数器与清理：真实事件计数落在 borrowJourneys.counters()', () => {
  const tabId = 517;
  try {
    borrowGate.request(tabId, { requestId: 'ev-517', timeoutMs: 60000 });
    borrowGate.check(tabId, 'click');
    borrowGate.resolve('ev-517', { decision: 'allow' });
    borrowJourneys.beginReturn(tabId);
    borrowJourneys.completeReturn(tabId);
    const counters = borrowJourneys.counters();
    assert.ok(counters.begun >= 1);
    assert.ok(counters.decisions >= 1);
    assert.ok(counters.confirmed >= 1);
    assert.ok(counters.returns >= 1);
    assert.ok(counters.sealed >= 1);
    assert.ok(counters.blockedChecks >= 1);
    assert.ok(counters.tabs >= 1);
    assert.ok(counters.active >= 0);
    assert.equal(borrowJourneys.list().some((journey) => journey.tabId === tabId), true);
  } finally {
    cleanupMany(tabId);
  }
});
