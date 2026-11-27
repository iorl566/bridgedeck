import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStop } from '../../daemon/session-stop.js';

function make(requestStop = true) {
  const calls = [];
  const sessions = new Map();
  const session = { sessionId: 's1', instanceId: 'i1', tabId: 7, borrowed: true, shared: false };
  sessions.set('s1', session);
  const stop = createSessionStop({
    resolveSession: () => session,
    aliases: { clear: (id) => calls.push(['alias.clear', id]) },
    tabReservations: { release: (tabId, sid) => calls.push(['release', tabId, sid]), reserve: () => {} },
    tabControls: { syncTabControl: (tabId) => calls.push(['sync', tabId]) },
    tabControl: { unregister: () => ({}) },
    sessionState: {
      requestStop: () => requestStop,
      finish: (id) => calls.push(['finish', id]),
    },
    sessions,
    instances: new Map([['i1', { instanceId: 'i1' }]]),
    sendCommand: async (instance, method, params) => { calls.push([method, params]); return {}; },
    sendInstanceEvent: (instance, event) => calls.push(['event', event]),
    saveSessions: () => {},
    sessionPublicView: () => ({}),
    log: () => {},
    logError: () => {},
    BridgeError: class extends Error {},
    sessionQueue: { drop: (id) => calls.push(['queue.drop', id]) },
    releaseTransfersForSession: (id) => calls.push(['transfers', id]),
  });
  return { stop, session, sessions, calls };
}

test('stopSession 清理借用标签并删除会话', async () => {
  const { stop, sessions, calls } = make(true);
  const result = await stop.stopSession({ session: 's1' }, 1000);
  assert.equal(result.ok, true);
  assert.equal(result.borrowed, true);
  assert.equal(sessions.has('s1'), false);
  assert.ok(calls.some(([method]) => method === 'tab.return'));
  assert.ok(calls.some(([kind]) => kind === 'transfers'));
});

test('stopSession 已 stopping 时直接返回', async () => {
  const { stop, sessions } = make(false);
  const result = await stop.stopSession({ session: 's1' }, 1000);
  assert.equal(result.alreadyStopping, true);
  assert.equal(sessions.has('s1'), true);
});
