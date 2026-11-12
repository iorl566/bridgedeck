import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSessionEventHandler } from '../../extension/src/session-manager/event-handler.js';

function harness({ expectedClose = false, detachResult = true } = {}) {
  const listeners = { removed: [], detached: [], attached: [], tabRemoved: [] };
  const sent = [];
  const ctx = {
    sessionId: 's1', agentWindowId: 10, refStore: { clear() {} },
    agentCreatedTabs: new Set([1]), borrowedTabs: new Map(), observedTabs: new Set(),
  };
  let present = true;
  const manager = {
    findByWindowId(id) { return present && id === 10 ? ctx : null; },
    get(id) { return present && id === 's1' ? ctx : null; },
    isWindowCloseExpected() { return expectedClose; },
    release(id) { if (id === 's1') present = false; },
    async stop(id) { if (id === 's1') present = false; },
  };
  const transport = { send(event) { sent.push(event); } };
  const expected = { onDetached: () => detachResult, onAttached() {}, forget() {} };
  attachSessionEventHandler({
    manager, transport, expectedTabMoves: expected,
    windowEvents: { addListener: (h) => listeners.removed.push(h), removeListener() {} },
    tabEvents: {
      onDetached: { addListener: (h) => listeners.detached.push(h), removeListener() {} },
      onAttached: { addListener: (h) => listeners.attached.push(h), removeListener() {} },
      onRemoved: { addListener: (h) => listeners.tabRemoved.push(h), removeListener() {} },
    },
    cdp: { async detachSession() {}, async releaseSessionTab() {} },
  });
  return { listeners, sent, manager, ctx };
}

test('expected window close stops session without user event', async () => {
  const { listeners, sent } = harness({ expectedClose: true });
  listeners.removed[0](10);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.length, 0);
});

test('user close releases and emits window_closed', () => {
  const { listeners, sent, manager } = harness();
  listeners.removed[0](10);
  assert.equal(sent[0].event, 'session.window_closed');
  assert.equal(manager.get('s1'), null);
});

test('unexpected detach ends session; expected move does not', () => {
  const { listeners, sent } = harness({ detachResult: false });
  listeners.detached[0](1, { oldWindowId: 10 });
  assert.equal(sent[0].event, 'session.ended');

  const expectedHarness = harness({ detachResult: true });
  expectedHarness.listeners.detached[0](1, { oldWindowId: 10 });
  assert.equal(expectedHarness.sent.length, 0);
});
