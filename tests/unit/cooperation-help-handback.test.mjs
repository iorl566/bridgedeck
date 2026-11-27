// 人工交还控制权（帮助完成 / cooperate handback）：解除 daemon 会话暂停 + controller 回 agent。
// 覆盖 E2E 24b~26 级联失败的根因：协助期间的人工交互触发 daemon auto pause 后，
// 旧路径只等下一次 cooperate.sync 空闲恢复，期间动作全部 E_SESSION_PAUSED。
import test from 'node:test';
import assert from 'node:assert/strict';

const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
const store = {};
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.3.0' }), onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async (key) => (typeof key === 'string' && store[key] !== undefined ? { [key]: store[key] } : {}), set: async (payload) => Object.assign(store, payload), remove: async () => {} },
    onChanged: listener(),
  },
  tabs: { onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(), query: async () => [], get: async (tabId) => ({ id: tabId, windowId: 1, url: 'https://example.test/form', title: 'form' }) },
  windows: { getLastFocused: async () => ({ id: 1 }), get: async () => ({ id: 1 }), update: async () => ({}) },
  scripting: { executeScript: async () => [] },
};

const { registerDaemonEventSender, sendDaemonEvent, hasDaemonEventSender } = await import('../../extension/src/lib/daemon-events.js');
const { getTakeoverState, setTakeoverState, resumeTakeover, applyDaemonTakeoverState, recentlyHandedBack, clearTakeoverState } = await import('../../extension/src/takeover.js');
const { controllerState } = await import('../../extension/src/lib/controller-state.js');
const { cooperateHandback } = await import('../../extension/src/control.js');

function captureEvents() {
  const events = [];
  registerDaemonEventSender((event, params) => events.push({ event, params }));
  return events;
}

test('daemon 事件出口：注册后可发；解绑后返回结构化失败', () => {
  const events = captureEvents();
  assert.equal(hasDaemonEventSender(), true);
  assert.deepEqual(sendDaemonEvent('takeover.pause', { tabId: 1, paused: false }), { ok: true, event: 'takeover.pause' });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { event: 'takeover.pause', params: { tabId: 1, paused: false } });
  registerDaemonEventSender(null);
  const missing = sendDaemonEvent('takeover.pause', { tabId: 1 });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NO_DAEMON_LINK');
  assert.equal(hasDaemonEventSender(), false);
});

test('resumeTakeover：paused→false、controller held→agent、通知 daemon resume', async () => {
  const events = captureEvents();
  const tabId = 31;
  setTakeoverState(tabId, { paused: true, sessionId: 's-31' });
  assert.equal(controllerState.get(tabId), 'held');
  const result = await resumeTakeover(tabId, { source: 'request-help.done', force: true });
  assert.equal(result.ok, true);
  assert.equal(result.resumed, true);
  assert.equal(getTakeoverState(tabId).paused, false);
  assert.equal(controllerState.get(tabId), 'agent');
  assert.equal(recentlyHandedBack(tabId), true);
  assert.deepEqual(events, [{ event: 'takeover.pause', params: { tabId, paused: false } }]);
  assert.equal(result.evidence.previousPaused, true);
  assert.equal(result.evidence.source, 'request-help.done');
  assert.equal(result.evidence.controllerBefore, 'held');
  assert.equal(result.evidence.controllerAfter, 'agent');
  clearTakeoverState(tabId);
  controllerState.clear(tabId);
});

test('resumeTakeover：未暂停时不发事件；force=true 仍显式通知 daemon', async () => {
  const events = captureEvents();
  const tabId = 32;
  setTakeoverState(tabId, { paused: false });
  const skipped = await resumeTakeover(tabId, { source: 'help.done' });
  assert.equal(skipped.resumed, false);
  assert.equal(events.length, 0);
  const forced = await resumeTakeover(tabId, { source: 'cooperate.handback', force: true });
  assert.equal(forced.resumed, false);
  assert.deepEqual(events, [{ event: 'takeover.pause', params: { tabId, paused: false } }]);
  assert.equal((await resumeTakeover(null)).code, 'E_BAD_ARG');
  clearTakeoverState(tabId);
});

test('协助期间的 auto pause 会卡住动作；交还后回到可用，尾随 auto pause 被丢弃、手动暂停仍尊重', async () => {
  const events = captureEvents();
  const tabId = 33;
  // 1) 协助期间人工输入 → daemon auto pause → 扩展 controller=held：动作被拒绝（旧级联根因）。
  applyDaemonTakeoverState(tabId, { paused: true, pausedBy: 'auto', sessionId: 's-33' });
  assert.equal(getTakeoverState(tabId).paused, true);
  assert.equal(controllerState.get(tabId), 'held');
  const blocked = controllerState.actionGate(tabId, 'click');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'E_SESSION_PAUSED');
  // 2) “完成并交还控制权”：解除暂停 + controller 回 agent + 通知 daemon resume。
  await resumeTakeover(tabId, { source: 'request-help.done', force: true });
  assert.equal(controllerState.actionGate(tabId, 'click').allowed, true, '交还后动作必须可用');
  assert.deepEqual(events, [{ event: 'takeover.pause', params: { tabId, paused: false } }]);
  // 3) 帮助期间的人工输入事件晚到：pausedBy=auto，应被交还窗口丢弃，不能重新卡住。
  const ignored = applyDaemonTakeoverState(tabId, { paused: true, pausedBy: 'auto', sessionId: 's-33' });
  assert.equal(ignored.ignoredAutoPause, true);
  assert.equal(ignored.state.paused, false);
  assert.equal(getTakeoverState(tabId).paused, false, '交还后不应被尾随 auto pause 重新暂停');
  assert.equal(controllerState.get(tabId), 'agent', 'controller 不应回到 held');
  assert.equal(controllerState.actionGate(tabId, 'click').allowed, true);
  // 4) 手动暂停（pausedBy=manual）必须尊重，不能被交还窗口吞掉。
  const manual = applyDaemonTakeoverState(tabId, { paused: true, pausedBy: 'manual', sessionId: 's-33' });
  assert.equal(manual.ignoredAutoPause, false);
  assert.equal(manual.state.paused, true);
  assert.equal(controllerState.get(tabId), 'held');
  assert.equal(controllerState.actionGate(tabId, 'click').allowed, false);
  clearTakeoverState(tabId);
  controllerState.clear(tabId);
});

test('cooperate.handback：返回 session 已恢复，并向 daemon 发 resume 事件', async () => {
  const events = captureEvents();
  const tabId = 34;
  setTakeoverState(tabId, { paused: true, sessionId: 's-34' });
  const result = await cooperateHandback({ tabId });
  assert.equal(result.ok, true);
  assert.equal(result.state.mode, 'ready');
  assert.equal(result.session.paused, false);
  assert.equal(result.session.resumed, true);
  assert.equal(result.controller.state, 'agent');
  assert.deepEqual(events, [{ event: 'takeover.pause', params: { tabId, paused: false } }]);
  assert.equal(getTakeoverState(tabId).paused, false);
  clearTakeoverState(tabId);
  controllerState.clear(tabId);
});

test('帮助完成后的 ready 语义：controller=human 也随交回收回 agent', async () => {
  captureEvents();
  const tabId = 35;
  controllerState.transition(tabId, 'agent.claim', { holder: 'coop:' + tabId });
  controllerState.transition(tabId, 'human.take', { source: 'human-input', humanAt: Date.now() });
  assert.equal(controllerState.get(tabId), 'human');
  await resumeTakeover(tabId, { source: 'request-help.done', force: true });
  assert.equal(controllerState.get(tabId), 'agent');
  controllerState.clear(tabId);
});
