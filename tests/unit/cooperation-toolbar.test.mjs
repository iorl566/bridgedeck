// controller/toolbar/borrow 只读快照：纯聚合器字段 + cooperationRuntimeState / cooperate.sync 接线。
import test from 'node:test';
import assert from 'node:assert/strict';

const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
const pageResults = {};
const sentMessages = [];
const storage = {};
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.3.0' }), onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null },
  storage: {
    local: { get: async (key) => (key && typeof key === 'object' ? {} : key ? { [key]: storage[key] } : {}), set: async (payload) => Object.assign(storage, payload), remove: async () => {} },
    session: { get: async (key) => (typeof key === 'string' && storage[key] !== undefined ? { [key]: storage[key] } : {}), set: async (payload) => Object.assign(storage, payload), remove: async () => {} },
    onChanged: listener(),
  },
  alarms: { create: async () => {}, onAlarm: listener() },
  tabs: {
    onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(),
    query: async () => [],
    get: async (tabId) => ({ id: tabId, windowId: 1, url: 'https://example.test/form', title: 'form', index: 0, active: true }),
    create: async () => ({ id: 1 }),
    remove: async () => {},
    update: async () => ({}),
    captureVisibleTab: async () => 'data:image/png;base64,',
    async sendMessage(tabId, message) { sentMessages.push({ tabId, message }); return { ok: true, generation: message && message.generation }; },
  },
  windows: { getLastFocused: async () => ({ id: 1 }), get: async () => ({ id: 1, type: 'normal' }), create: async () => ({ id: 1 }), update: async () => ({}), getAll: async () => [] },
  debugger: { onEvent: listener(), onDetach: listener(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
  offscreen: { hasDocument: async () => false, createDocument: async () => {} },
  scripting: {
    async executeScript(options) {
      const args = options && Array.isArray(options.args) ? options.args : null;
      if (args) {
        // runInjection 的 pageCallFunc：args = [name, params, version]。
        const name = String(args[0] || '');
        const result = Object.prototype.hasOwnProperty.call(pageResults, name) ? pageResults[name] : {};
        return [{ frameId: 0, result: { ok: true, result } }];
      }
      // readCooperationFrames 直接注入 readState 函数。
      return [{ frameId: 0, result: pageResults.__cooperation || null }];
    },
  },
  downloads: { onCreated: listener(), search: async () => [], download: async () => 1 },
  action: { openPopup: async () => {} },
  permissions: { contains: async () => true },
};

const { buildControllerToolbarSnapshot, describeControllerToolbar, CONTROLLER_LABELS } = await import('../../extension/src/lib/controller-toolbar.js');
const { createBorrowGate, borrowGate } = await import('../../extension/src/lib/borrow-confirm.js');
const { controllerState } = await import('../../extension/src/lib/controller-state.js');
const { captureSuppression } = await import('../../extension/src/lib/capture-suppression.js');
const { cooperationControllerSnapshot, cooperationRuntimeState, registerControllerSource } = await import('../../extension/src/cooperation.js');
const { cooperateHold, cooperateSync } = await import('../../extension/src/control.js');

test('纯聚合器：完整输入 → controller/toolbar/borrow/capture/human/revisions/blocking 字段齐全', () => {
  const snapshot = buildControllerToolbarSnapshot({
    tabId: 3,
    at: 5000,
    controller: { state: 'borrowed', since: 4000, event: 'borrow.confirm', holder: 'coop:3', transitions: 2, rejected: 1, lastRejection: { code: 'CONTROLLER_TRANSITION' }, actionCount: 4, lastAction: 'click', lastActionAt: 4900 },
    takeover: { paused: false, borrowed: true, sessionId: 's-1', mode: 'borrowed' },
    borrow: { status: 'confirmed', requestId: 'r-1', requestedAt: 4500, timeoutMs: 60000, surface: 'modal', controlled: true, decision: 'allow' },
    overlays: { capturing: false, overlays: [{ kind: 'takeover', priority: 10, since: 4100 }, { kind: 'borrow', priority: 100, since: 4200 }] },
    capture: { count: 1, active: true, effective: true, holders: [{ owner: 'dispatch', acked: true, frames: 2, at: 4800 }], pending: [] },
    suppression: { live: [{ scopeId: 'sup-1', kind: 'capture', method: 'screenshot', heldMs: 120, startedAt: 4880 }], count: 1, effective: true, maxHoldMs: 180000, history: [] },
    passthrough: { list: [{ token: 'abc…xyz', grantee: 'coop:3', expiresAt: 9000, used: false }] },
    human: {
      who: 'human',
      basis: 'input',
      confidence: 0.95,
      where: { frameId: 0, kind: 'pointer', label: 'buy', editing: false },
      when: { at: 4700, skewMs: 0, toleranceMs: 1.5, withinTolerance: null },
      counts: { humanAttributed: 1, agentAttributed: 2 },
      conflict: { conflicting: false },
    },
    revisions: { controlRevision: 5, authorityRevision: 2, revision: 9, frameEpoch: 3, epoch: 4, generation: 7, documentEpoch: 1, document: 'https://example.test/form', stale: true, staleSide: 'remote', alignedAt: 4990 },
  });
  assert.equal(snapshot.tabId, 3);
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.at, 5000);
  assert.equal(snapshot.controller.state, 'borrowed');
  assert.equal(snapshot.controller.label, CONTROLLER_LABELS.borrowed);
  assert.equal(snapshot.controller.heldMs, 1000);
  assert.equal(snapshot.controller.borrowed, true);
  assert.equal(snapshot.toolbar.visible, true);
  assert.equal(snapshot.toolbar.kind, 'borrow', 'borrow 优先级最高');
  assert.equal(snapshot.toolbar.priority, 100);
  assert.deepEqual(snapshot.toolbar.overlays.map((entry) => entry.kind), ['borrow', 'takeover']);
  assert.equal(snapshot.toolbar.labels.mode, 'borrow');
  assert.match(snapshot.toolbar.labels.title, /借用/);
  assert.deepEqual(snapshot.toolbar.badges, ['state:borrowed', 'borrow-confirmed', 'capturing', 'suppress:capture', 'human-active']);
  assert.equal(snapshot.borrow.status, 'confirmed');
  assert.equal(snapshot.borrow.controlled, true);
  assert.equal(snapshot.capture.effective, true);
  assert.equal(snapshot.capture.holders[0].owner, 'dispatch');
  assert.equal(snapshot.suppression.active, true);
  assert.equal(snapshot.suppression.live[0].heldMs, 120);
  assert.equal(snapshot.passthrough.count, 1);
  assert.equal(snapshot.human.who, 'human');
  assert.equal(snapshot.human.where.label, 'buy');
  assert.equal(snapshot.revisions.controlRevision, 5);
  assert.equal(snapshot.revisions.stale, true);
  assert.equal(snapshot.revisions.staleSide, 'remote');
  assert.equal(snapshot.blocking.blocked, false);
  assert.equal(snapshot.evidence.sources.controller, true);
});

test('纯聚合器：held / 借用 pending / handoff 的 blocking 原因', () => {
  const held = buildControllerToolbarSnapshot({
    tabId: 4,
    controller: { state: 'held', since: 1000 },
    takeover: { paused: true },
  });
  assert.equal(held.blocking.blocked, true);
  assert.equal(held.blocking.primary, 'E_SESSION_PAUSED');
  assert.equal(held.blocking.reasons[0].source, 'controller');
  assert.equal(held.toolbar.labels.title, '人工接管中');
  assert.equal(held.toolbar.badges.includes('paused'), true);

  const pending = buildControllerToolbarSnapshot({
    tabId: 5,
    at: 2000,
    controller: { state: 'handoff', since: 1500 },
    borrow: { status: 'pending', requestId: 'r-2', requestedAt: 1000, timeoutMs: 60000 },
  });
  assert.equal(pending.blocking.blocked, true);
  assert.equal(pending.blocking.primary, 'E_BORROW_CONFLICT');
  assert.equal(pending.borrow.pendingMs, 1000);
  assert.equal(pending.toolbar.visible, true);
  assert.match(pending.toolbar.labels.subtitle, /允许/);

  const handoffNoBorrow = buildControllerToolbarSnapshot({ tabId: 6, controller: { state: 'handoff' } });
  assert.equal(handoffNoBorrow.blocking.primary, 'E_CONTROL_STALE');
});

test('纯聚合器：空输入/非法 tab 给出安全默认值，不抛异常', () => {
  const snapshot = buildControllerToolbarSnapshot({});
  assert.equal(snapshot.tabId, null);
  assert.equal(snapshot.controller.state, 'idle');
  assert.equal(snapshot.toolbar.kind, 'none');
  assert.equal(snapshot.toolbar.visible, false);
  assert.equal(snapshot.blocking.blocked, false);
  assert.equal(snapshot.borrow.status, 'none');
  assert.equal(snapshot.capture.count, 0);
  assert.equal(snapshot.revisions.controlRevision, 0);
  assert.equal(buildControllerToolbarSnapshot({ tabId: 'nope' }).tabId, null);
  assert.equal(buildControllerToolbarSnapshot({ controller: { state: 'weird' } }).controller.label, CONTROLLER_LABELS.idle);
});

test('一行摘要：controller/toolbar/borrow/四项计数/stale/blocked', () => {
  const text = describeControllerToolbar(buildControllerToolbarSnapshot({
    tabId: 7,
    at: 9000,
    controller: { state: 'held', since: 8000 },
    takeover: { paused: true },
    overlays: { overlays: [{ kind: 'takeover', priority: 10, since: 8100 }] },
    borrow: { status: 'pending', requestedAt: 8500 },
    revisions: { controlRevision: 3, authorityRevision: 1, revision: 8, frameEpoch: 2, stale: true, staleSide: 'local' },
  }));
  assert.match(text, /controller=held/);
  assert.match(text, /held=1000ms/);
  assert.match(text, /toolbar=takeover/);
  assert.match(text, /borrow=pending\(500ms\)/);
  assert.match(text, /ctrl=3\/auth=1\/rev=8\/frame=2/);
  assert.match(text, /stale=local/);
  assert.match(text, /blocked=E_SESSION_PAUSED/);
  assert.equal(describeControllerToolbar(null), 'controller: 无快照');
});

test('cooperationControllerSnapshot：聚合真实 controller/借用闸门/抑制/passthrough/human 来源', () => {
  const tabId = 91;
  controllerState.transition(tabId, 'agent.claim', { holder: 'coop:' + tabId });
  const gate = borrowGate;
  gate.request(tabId, { requestId: 'snap-' + tabId, timeoutMs: 5000, title: '结算页' });
  const snapshot = cooperationControllerSnapshot(tabId);
  assert.equal(snapshot.controller.state, 'handoff');
  assert.equal(snapshot.borrow.status, 'pending');
  assert.equal(snapshot.borrow.requestId, 'snap-' + tabId);
  assert.equal(snapshot.borrow.title, '结算页');
  assert.equal(snapshot.blocking.blocked, true);
  assert.equal(snapshot.blocking.primary, 'E_BORROW_CONFLICT');
  assert.equal(snapshot.evidence.sources.borrow, true);
  assert.equal(snapshot.evidence.sources.controller, true);
  assert.equal(Number.isInteger(snapshot.revisions.controlRevision), true);
  gate.clear(tabId);
  controllerState.clear(tabId);
  const invalid = cooperationControllerSnapshot(null);
  assert.equal(invalid.tabId, null);
});

test('cooperationRuntimeState：只读运行时状态含 controller/toolbar/revisions/humanInput/summary', () => {
  const tabId = 92;
  controllerState.transition(tabId, 'agent.claim', { holder: 'coop:' + tabId });
  const lease = captureSuppression.acquire(tabId, { owner: 'unit-test' });
  registerControllerSource('takeover', () => ({ paused: false, borrowed: false, sessionId: 's-92' }));
  const runtime = cooperationRuntimeState(tabId);
  assert.equal(runtime.tabId, tabId);
  assert.equal(runtime.controller.state, 'agent');
  assert.equal(runtime.controller.sessionId, 's-92');
  assert.equal(runtime.capture.count, 1);
  assert.equal(runtime.capture.holders[0].owner, 'unit-test');
  assert.equal(runtime.revisions.generation >= 0, true);
  assert.equal(typeof runtime.toolbar.kind, 'string');
  assert.equal(typeof runtime.humanInput.who, 'string');
  assert.equal(typeof runtime.blocking.blocked, 'boolean');
  assert.equal(typeof runtime.summary, 'string');
  assert.match(runtime.attributionSummary, /^归因：/);
  captureSuppression.release(tabId, lease.token);
  controllerState.clear(tabId);
  registerControllerSource('takeover', () => ({}));
});

test('cooperate.sync 输出 controller/toolbar/revisions/human_input/attributionSummary（供 CLI 查询）', async () => {
  pageResults.observe = { observation: 'form\n@e1 submit', revision: 12, url: 'https://example.test/form', title: 'form', refs: 1 };
  pageResults['media-progress'] = { playing: 0 };
  pageResults['ref-signatures'] = { signatures: [{ ref: '@e1', tag: 'button', text: 'submit' }] };
  pageResults['frame-meta'] = { hidden: false };
  pageResults.__cooperation = {
    url: 'https://example.test/form',
    revision: 12,
    control: { inputLocked: false, shared: false, humanActive: false, agentActive: false, agentGraceMs: 0 },
    frameState: {
      revision: 12,
      inputClock: 3,
      human: 1,
      humanAttributed: 1,
      agentAttributed: 2,
      agentAttributedByTimestamp: 1,
      timeToleranceMs: 1.5,
      attribution: { owner: 'agent', reason: 'timestamp', kind: 'pointer', skewMs: 0.5, at: Date.now() - 10 },
      lastHumanAt: Date.now() - 2000,
      lastAgentAt: Date.now() - 10,
      document: 'https://example.test/form',
      events: [{ kind: 'pointer', at: Date.now() - 10, label: 'submit' }],
    },
    activity: { lastHumanAt: Date.now() - 2000, editing: false, recent: [] },
  };
  const tabId = 93;
  const reply = await cooperateSync({ tabId, policy: 'target' });
  assert.equal(reply.control_policy, 'target');
  assert.equal(reply.controller.state, 'agent');
  assert.equal(reply.toolbar.kind, 'none');
  assert.equal(reply.revisions.controlRevision >= 1, true);
  assert.equal(reply.revisions.frameEpoch >= 1, true);
  assert.equal(reply.revisions.revision, 12);
  assert.equal(reply.authority.controlRevision, reply.revisions.controlRevision);
  assert.equal(reply.authority.four.controller.state, 'agent');
  assert.equal(reply.authority.four.action.allowed, true);
  assert.equal(reply.human_input.who, 'agent');
  assert.equal(reply.human_input.when.toleranceMs, 1.5);
  assert.match(reply.attributionSummary, /^归因：Agent（timestamp）/);
  assert.equal(reply.blocking.blocked, false);
  assert.equal(reply.authority.stale, false);

  // hold 之后：controller=held、动作被拒绝、blocking 给出 E_SESSION_PAUSED。
  const held = await cooperateHold({ tabId, held: true });
  assert.equal(held.held, true);
  assert.equal(held.controller.state, 'held');
  const afterHold = await cooperateSync({ tabId });
  assert.equal(afterHold.controller.state, 'held');
  assert.equal(afterHold.authority.four.action.allowed, false);
  assert.equal(afterHold.authority.four.action.deniedReason, 'held');
  assert.equal(afterHold.blocking.primary, 'E_SESSION_PAUSED');
  const { checkControl } = await import('../../extension/src/control.js');
  assert.throws(() => checkControl({ tabId, method: 'click' }), (error) => error && error.code === 'E_SESSION_PAUSED');
  await cooperateHold({ tabId, held: false });
  assert.equal((await cooperateSync({ tabId })).controller.state, 'agent');
  controllerState.clear(tabId);
  borrowGate.clear(tabId);
});

void createBorrowGate;
