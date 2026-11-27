// 借用确认闸门：确认前禁用动作（拒绝 + 证据）、确认后可动作；dispatch 接线验证。
import test from 'node:test';
import assert from 'node:assert/strict';

const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
const sent = [];
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
    async sendMessage(tabId, message) { sent.push({ tabId, message }); return { ok: true, generation: message && message.generation }; },
  },
  windows: { getLastFocused: async () => ({ id: 1 }), get: async () => ({ id: 1, type: 'normal' }), create: async () => ({ id: 1 }), update: async () => ({}), getAll: async () => [] },
  debugger: { onEvent: listener(), onDetach: listener(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
  offscreen: { hasDocument: async () => false, createDocument: async () => {} },
  scripting: { executeScript: async () => [] },
  downloads: { onCreated: listener(), search: async () => [], download: async () => 1 },
  action: { openPopup: async () => {} },
  permissions: { contains: async () => true },
};

const { BORROW_STATUS, borrowGate, createBorrowGate } = await import('../../extension/src/lib/borrow-confirm.js');
const { controllerState } = await import('../../extension/src/lib/controller-state.js');
const { HANDLERS, runSerialized } = await import('../../extension/src/dispatch.js');

function gateAt(clockValue = 1000) {
  let clock = clockValue;
  const gate = createBorrowGate({ now: () => clock });
  return { gate, advance: (ms) => { clock += ms; return clock; }, now: () => clock };
}

test('闸门：确认前（pending）动作被拒绝并给出 requestId/等待时长/放行条件证据', () => {
  const { gate, advance } = gateAt();
  const requested = gate.request(41, { requestId: 'req-41', timeoutMs: 60000, windowId: 2, title: '购物车' });
  assert.equal(requested.ok, true);
  assert.equal(requested.status, BORROW_STATUS.PENDING);
  advance(1500);
  const blocked = gate.check(41, 'click');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'E_BORROW_CONFLICT');
  assert.equal(blocked.evidence.requestId, 'req-41');
  assert.equal(blocked.evidence.pendingMs, 1500);
  assert.equal(blocked.evidence.timeoutMs, 60000);
  assert.equal(blocked.evidence.allowedAfter, 'borrow.confirm');
  assert.equal(blocked.evidence.title, '购物车');
  assert.match(blocked.evidence.hint, /允许/);
  assert.equal(controllerState.get(41), 'handoff', '借用确认期间 controller 处于 handoff');
  assert.equal(gate.counters().blocked, 1);
});

test('闸门：用户允许后动作放行，controller 进入 borrowed 且计数推进', () => {
  const { gate } = gateAt();
  gate.request(42, { requestId: 'req-42' });
  const allowed = gate.resolve('req-42', { decision: 'allow', allow: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.status, BORROW_STATUS.CONFIRMED);
  assert.equal(gate.check(42, 'click').allowed, true);
  assert.equal(controllerState.get(42), 'borrowed');
  const snapshot = controllerState.snapshot(42);
  assert.equal(snapshot.frameEpoch, 1, '借用确认应推进 frameEpoch（浮层重建）');
  assert.equal(snapshot.lastRejection, null);
  // 重复结算幂等。
  const again = gate.resolve('req-42', { decision: 'allow' });
  assert.equal(again.duplicate, true);
  assert.equal(again.allowed, true);
});

test('闸门：拒绝/超时是终态，不阻塞后续已授权动作；未知 requestId 给出结构化错误', () => {
  const { gate } = gateAt();
  gate.request(43, { requestId: 'req-43' });
  const denied = gate.resolve('req-43', { decision: 'deny' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.status, BORROW_STATUS.DENIED);
  assert.equal(denied.code, 'E_BORROW_DENIED');
  assert.equal(gate.check(43, 'click').allowed, true, '拒绝记录不应永久阻塞动作');
  const timeout = gate.request(44, { requestId: 'req-44' });
  assert.equal(timeout.ok, true);
  const timedOut = gate.resolve('req-44', { decision: 'timeout' });
  assert.equal(timedOut.status, BORROW_STATUS.TIMEOUT);
  assert.equal(timedOut.code, 'E_BORROW_TIMEOUT');
  assert.equal(controllerState.get(44), 'idle', '超时后 controller 回到 idle');
  const unknown = gate.resolve('missing', { decision: 'allow' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'E_BORROW_CONFLICT');
  assert.equal(gate.request('bad-tab').code, 'E_BAD_ARG');
});

test('闸门：cancel/clear 清理 pending，status 暴露过期标记；history 有界', () => {
  const { gate, advance } = gateAt();
  gate.request(45, { requestId: 'req-45', timeoutMs: 1000 });
  advance(1500);
  const status = gate.status(45);
  assert.equal(status.status, BORROW_STATUS.PENDING);
  assert.equal(status.expired, true, '超过 timeoutMs 应标记 expired');
  const cancelled = gate.cancel(45, 'overlay-closed');
  assert.equal(cancelled.cancelled, true);
  assert.equal(controllerState.get(45), 'idle');
  gate.request(45, { requestId: 'req-45b' });
  const cleared = gate.clear(45);
  assert.equal(cleared.cleared, true);
  assert.equal(controllerState.get(45), 'idle', 'clear 时 pending 应走 cancel，不留 handoff');
  assert.equal(gate.pending().length, 0);
  assert.equal(gate.history().length >= 3, true);
  const bounded = createBorrowGate({ historyLimit: 2 });
  for (let index = 0; index < 5; index += 1) {
    bounded.request(50 + index, { requestId: 'r' + index });
    bounded.resolve('r' + index, { decision: 'deny' });
  }
  assert.equal(bounded.history().length, 2);
});

test('dispatch 接线：借用确认 pending 时动作被拒绝且不触达 handler；确认后放行', async () => {
  const original = HANDLERS.click;
  let calls = 0;
  HANDLERS.click = async () => { calls += 1; return { ok: true, clicked: true }; };
  try {
    const tabId = 61;
    borrowGate.request(tabId, { requestId: 'dispatch-req-61' });
    await assert.rejects(
      () => runSerialized('click', { tabId }),
      (error) => error && error.code === 'E_BORROW_CONFLICT' && error.data && error.data.requestId === 'dispatch-req-61',
    );
    assert.equal(calls, 0, '确认前动作不应触达页面 handler');
    borrowGate.resolve('dispatch-req-61', { decision: 'allow' });
    const result = await runSerialized('click', { tabId });
    assert.equal(calls, 1);
    assert.equal(result.clicked, true);
  } finally {
    HANDLERS.click = original;
    borrowGate.clear(61);
    controllerState.clear(61);
  }
});

