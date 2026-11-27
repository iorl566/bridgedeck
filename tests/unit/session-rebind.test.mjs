import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRebind } from '../../daemon/session-rebind.js';

function make() {
  const session = { sessionId: 's1', instanceId: 'i1', tabId: 1, borrowed: false };
  const calls = [];
  const rebind = createSessionRebind({
    resolveSession: () => session,
    tabControls: { claimTab: (tabId, sid) => calls.push(['claim', tabId, sid]) },
    instances: new Map([['i1', {}], ['i2', {}]]),
    sendCommand: async (instance, method, params) => { calls.push([method, params]); return { windowId: 9, url: 'u2', title: 't2' }; },
    tabReservations: { release: () => {}, reserve: () => {} },
    rebindSessionRecord: (target, patch) => Object.assign(target, patch),
    tabControl: { unregister: () => {}, attach: () => {}, status: () => ({ mode: 'open' }) },
    saveSessions: () => {},
    sendInstanceEvent: () => {},
    log: () => {},
    sessionPublicView: (target) => ({ sessionId: target.sessionId, tabId: target.tabId }),
    sessionState: { phase: () => 'active' },
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    findInstanceForTab: async () => ({ instanceId: 'i2' }),
  });
  return { rebind, session, calls };
}

test('rebindSession 切到新 tab 并同步记录', async () => {
  const { rebind, session, calls } = make();
  const result = await rebind.rebindSession({ session: 's1', tab: 2 }, 1000);
  assert.equal(session.instanceId, 'i2');
  assert.equal(session.tabId, 2);
  assert.equal(result.tabId, 2);
  assert.ok(calls.some(([method]) => method === 'tab.borrow'));
});

test('rebindSession 拒绝非法 tab', async () => {
  const { rebind } = make();
  await assert.rejects(() => rebind.rebindSession({ session: 's1', tab: 'x' }, 1000), (error) => error.code === 'E_BAD_ARG');
});
