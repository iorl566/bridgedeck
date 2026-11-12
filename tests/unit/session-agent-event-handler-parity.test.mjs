import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSessionEventHandler } from '../../extension/src/session-manager/event-handler.js';

function listenerSet() {
  const listeners = new Set();
  return {
    addListener(handler) { listeners.add(handler); },
    removeListener(handler) { listeners.delete(handler); },
    emit(...args) { for (const handler of [...listeners]) handler(...args); },
    count() { return listeners.size; },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness({
  expectedClose = false,
  detachResult = false,
  expectedTabMoves,
  agentOverlayReset,
  cdp,
  tabEvents,
  useDefaultTabEvents = false,
} = {}) {
  const windowsRemoved = listenerSet();
  const tabsDetached = listenerSet();
  const tabsAttached = listenerSet();
  const tabsRemoved = listenerSet();
  const sent = [];
  const events = [];
  const cleared = [];
  let present = true;
  const ctx = {
    sessionId: 's1',
    agentWindowId: 10,
    refStore: { clear() { cleared.push('refStore'); } },
    agentCreatedTabs: new Set([1]),
    borrowedTabs: new Map(),
    observedTabs: new Set(),
  };
  const manager = {
    findByWindowId(id) { return present && id === 10 ? ctx : null; },
    get(id) { return present && id === 's1' ? ctx : null; },
    isWindowCloseExpected() { return expectedClose; },
    release(id) { if (id === 's1') present = false; },
    async stop(id) { events.push('stop'); if (id === 's1') present = false; },
  };
  const transport = {
    send(frame) {
      events.push(frame.event);
      sent.push(frame);
    },
  };
  const expected = expectedTabMoves ?? {
    onDetached: () => detachResult,
    onAttached() {},
    forget() {},
  };
  const options = {
    manager,
    transport,
    expectedTabMoves: expected,
    windowEvents: {
      addListener: (handler) => windowsRemoved.addListener(handler),
      removeListener: (handler) => windowsRemoved.removeListener(handler),
    },
    agentOverlayReset,
    cdp,
  };
  if (!useDefaultTabEvents) {
    options.tabEvents = tabEvents ?? {
      onDetached: tabsDetached,
      onAttached: tabsAttached,
      onRemoved: tabsRemoved,
    };
  }
  const handle = attachSessionEventHandler(options);
  return {
    handle, manager, ctx, sent, events, cleared,
    windowsRemoved, tabsDetached, tabsAttached, tabsRemoved,
    defaultTabs: { onDetached: tabsDetached, onAttached: tabsAttached, onRemoved: tabsRemoved },
  };
}

function withChrome(chrome, run) {
  const previous = globalThis.chrome;
  globalThis.chrome = chrome;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete globalThis.chrome;
      else globalThis.chrome = previous;
    });
}

test('defaults tab listeners to the browser API and removes them on dispose', async () => {
  const chromeTabs = {
    onDetached: listenerSet(),
    onAttached: listenerSet(),
    onRemoved: listenerSet(),
  };
  await withChrome({ tabs: chromeTabs }, () => {
    const h = harness({ useDefaultTabEvents: true });
    assert.equal(chromeTabs.onDetached.count(), 1);
    assert.equal(chromeTabs.onAttached.count(), 1);
    assert.equal(chromeTabs.onRemoved.count(), 1);
    chromeTabs.onDetached.emit(1, { oldWindowId: 10 });
    assert.equal(h.sent[0].event, 'session.ended');
    assert.deepEqual(h.cleared, ['refStore']);
    h.handle.dispose();
    assert.equal(chromeTabs.onDetached.count(), 0);
    assert.equal(chromeTabs.onAttached.count(), 0);
    assert.equal(chromeTabs.onRemoved.count(), 0);
  });
});

test('default overlay reset messages every owned tab with a versioned reset', async () => {
  const calls = [];
  await withChrome({
    tabs: {
      async sendMessage(tabId, message) { calls.push([tabId, message]); },
    },
  }, async () => {
    const h = harness({ detachResult: false });
    h.ctx.borrowedTabs.set(7, { tabId: 7 });
    h.ctx.observedTabs.add(8);
    h.tabsDetached.emit(1, { oldWindowId: 10 });
    await flush();
    assert.deepEqual(calls.map(([tabId]) => tabId), [1, 7, 8]);
    for (const [, message] of calls) {
      assert.equal(message.type, 'bh-agent-overlay-reset');
      assert.equal(message.sessionId, 's1');
      assert.equal(typeof message.epoch, 'string');
      assert.equal(typeof message.generation, 'number');
    }
  });
});

test('accepts an injected reset object and runs it after ownership is removed', async () => {
  const calls = [];
  const h = harness({
    detachResult: false,
    agentOverlayReset: {
      resetAgentOverlays(tabId, sessionId) {
        calls.push([tabId, sessionId, h.manager.get(sessionId)]);
      },
    },
  });
  h.tabsDetached.emit(1, { oldWindowId: 10 });
  await flush();
  assert.deepEqual(calls, [[1, 's1', null]]);
});

test('waits for an asynchronous detach expectation before ending the session', async () => {
  let settle;
  const expectation = new Promise((resolve) => { settle = resolve; });
  const h = harness({
    expectedTabMoves: { onDetached: () => expectation, onAttached() {}, forget() {} },
  });
  h.tabsDetached.emit(1, { oldWindowId: 10 });
  assert.equal(h.sent.length, 0);
  settle(true);
  await flush();
  assert.equal(h.sent.length, 0);
  let conclude;
  const second = new Promise((resolve) => { conclude = resolve; });
  const moved = harness({
    expectedTabMoves: { onDetached: () => second, onAttached() {}, forget() {} },
  });
  moved.tabsDetached.emit(1, { oldWindowId: 10 });
  conclude(false);
  await flush();
  assert.equal(moved.sent[0].event, 'session.ended');
});

test('reports borrowed tabs as return failures when the user closes the window', () => {
  const h = harness();
  h.ctx.borrowedTabs.set(7, { tabId: 7 });
  h.windowsRemoved.emit(10);
  assert.deepEqual(h.sent[0].payload.return_failures, [{
    tab_id: 7,
    code: 'cdp_failed',
    message: 'Agent Window was closed before borrowed tab could be returned',
  }]);
});

test('publishes the close event before page and debugger cleanup', async () => {
  const h = harness({
    cdp: {
      async releaseSessionTab() { h.events.push('releaseSessionTab'); },
      async detachSession() { h.events.push('detachSession'); },
    },
  });
  h.windowsRemoved.emit(10);
  await flush();
  assert.deepEqual(h.events, [
    'session.window_closed',
    'releaseSessionTab',
    'detachSession',
  ]);
});
