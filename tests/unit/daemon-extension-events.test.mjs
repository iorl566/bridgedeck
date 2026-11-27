import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionEventHandler } from '../../daemon/extension-events.js';

function makeCtx() {
  const sessions = new Map();
  const calls = { saved: 0, dropped: 0, transfer: 0, events: [] };
  const ctx = {
    normalizeSettings: (params) => ({ borrowConfirm: params.borrowConfirm !== false, allowHelp: params.allowHelp !== false }),
    log: () => {},
    humanEventSeen: new Map(),
    sessions,
    sendInstanceEvent: (instance, type, payload) => calls.events.push({ type, payload }),
    stopSession: async () => {},
    aliases: { clear: () => {} },
    releaseTransfersForSession: () => { calls.transfer += 1; },
    sessionState: { finish: () => {} },
    sessionQueue: { drop: () => { calls.dropped += 1; } },
    tabQueue: { drop: () => { calls.dropped += 1; } },
    saveSessions: () => { calls.saved += 1; },
  };
  return { ctx, sessions, calls };
}

test('extension settings 事件更新实例', () => {
  const { ctx } = makeCtx();
  const handler = createExtensionEventHandler(ctx);
  const instance = { instanceId: 'i1' };
  handler(instance, { event: 'settings', params: { label: '工作台' } });
  assert.equal(instance.label, '工作台');
  assert.equal(instance.settings.allowHelp, true);
});

test('human.input 自动暂停同 tab 会话并广播', () => {
  const { ctx, sessions, calls } = makeCtx();
  sessions.set('s1', { instanceId: 'i1', tabId: 7, paused: false, borrowed: false });
  const handler = createExtensionEventHandler(ctx);
  handler({ instanceId: 'i1' }, { event: 'human.input', params: { tabId: 7 } });
  assert.equal(sessions.get('s1').paused, true);
  assert.equal(sessions.get('s1').pausedBy, 'auto');
  assert.ok(calls.events.some((item) => item.type === 'takeover.state' && item.payload.paused === true));
});

test('tab-removed 删除会话并保存', () => {
  const { ctx, sessions, calls } = makeCtx();
  sessions.set('s1', { instanceId: 'i1', tabId: 9 });
  const handler = createExtensionEventHandler(ctx);
  handler({ instanceId: 'i1' }, { event: 'tab-removed', params: { tabId: 9 } });
  assert.equal(sessions.has('s1'), false);
  assert.ok(calls.saved >= 1);
});
