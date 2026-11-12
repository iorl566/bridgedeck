import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentWindowRouting } from '../../extension/src/session-manager/window-routing.js';

function listenerSet() {
  const listeners = new Set();
  return {
    addListener(handler) { listeners.add(handler); },
    removeListener(handler) { listeners.delete(handler); },
    emit(...args) { for (const handler of [...listeners]) handler(...args); },
    count() { return listeners.size; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for routing mutation');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function task(agentCreatedTabs = new Set()) {
  return {
    sessionId: 's1',
    agentWindowId: 10,
    agentCreatedTabs,
    borrowedTabs: new Map(),
    observedTabs: new Set(),
    pendingRoutingTabs: new Set(),
  };
}

function managerFor(ctx) {
  return {
    get: (id) => (id === 's1' ? ctx : null),
    list: () => [ctx],
    findByWindowId: (id) => (id === 10 ? ctx : null),
    isWindowCloseExpected: () => false,
    findBorrowingSession: () => null,
  };
}

function fakeApi({ windows: initialWindows, tab: initialTab } = {}) {
  const events = {
    created: listenerSet(),
    attached: listenerSet(),
    updated: listenerSet(),
    removed: listenerSet(),
    detached: listenerSet(),
    nav: listenerSet(),
    focus: listenerSet(),
    windowRemoved: listenerSet(),
  };
  const calls = [];
  const state = {
    windows: (initialWindows ?? [
      { id: 1, type: 'normal', focused: true, incognito: false },
      { id: 10, type: 'normal', focused: false, incognito: false },
    ]).map((window) => ({ ...window })),
    tab: { ...(initialTab ?? { id: 2, windowId: 10, incognito: false, active: false }) },
    moveAttempts: 0,
    moveImpl: async (id, options) => {
      state.tab.windowId = options.windowId;
    },
  };
  const api = {
    tabs: {
      onCreated: events.created,
      onAttached: events.attached,
      onUpdated: events.updated,
      onRemoved: events.removed,
      onDetached: events.detached,
      async get(id) {
        if (id !== state.tab.id) throw new Error('No tab');
        return { ...state.tab };
      },
      async query() {
        return [];
      },
      async move(id, options) {
        state.moveAttempts += 1;
        calls.push(['move', id, options]);
        const attempt = state.moveImpl;
        if (!attempt) throw new Error('No move');
        return attempt(id, options);
      },
      async update(id, options) {
        calls.push(['tabUpdate', id, options]);
        Object.assign(state.tab, options);
        return { ...state.tab };
      },
    },
    webNavigation: { onCreatedNavigationTarget: events.nav },
    windows: {
      onFocusChanged: events.focus,
      onRemoved: events.windowRemoved,
      async getAll() {
        return state.windows.map((window) => ({ ...window }));
      },
      async get(id) {
        const window = state.windows.find((candidate) => candidate.id === id);
        if (!window) throw new Error('No window');
        return { ...window };
      },
      async create(options) {
        calls.push(['create', options]);
        const window = {
          id: 20,
          type: 'normal',
          focused: false,
          incognito: options.incognito === true,
        };
        state.windows.push(window);
        state.tab.windowId = window.id;
        return window;
      },
      async update(id, options) {
        calls.push(['windowUpdate', id, options]);
        return { id, ...options };
      },
    },
  };
  return { api, events, calls, state };
}

const moveCalls = (calls) => calls.filter((call) => call[0] === 'move');
const updateCalls = (calls) => calls.filter((call) => call[0] === 'tabUpdate' || call[0] === 'windowUpdate');

test('retries a failed move and reuses the reselected destination', async () => {
  const ctx = task();
  const { api, events, calls, state } = fakeApi();
  state.moveImpl = async (id, options) => {
    if (state.moveAttempts === 1) throw new Error('Window busy');
    state.tab.windowId = options.windowId;
  };
  const routing = new AgentWindowRouting(managerFor(ctx), api);
  await tick();
  events.created.emit({ id: 2, windowId: 10 });
  await waitFor(() => moveCalls(calls).length >= 2);
  assert.equal(state.tab.windowId, 1);
  assert.equal(ctx.pendingRoutingTabs.has(2), false);
  assert.equal(moveCalls(calls)[1][2].windowId, 1);
  routing.dispose();
});

test('follows the tab into the last user window when the user was viewing the task', async () => {
  const ctx = task();
  const { api, events, calls } = fakeApi({
    tab: { id: 2, windowId: 10, incognito: false, active: true },
  });
  const routing = new AgentWindowRouting(managerFor(ctx), api);
  await tick();
  events.focus.emit(10);
  events.created.emit({ id: 2, windowId: 10 });
  await waitFor(() => calls.some((call) => call[0] === 'windowUpdate'));
  assert.deepEqual(updateCalls(calls), [
    ['tabUpdate', 2, { active: true }],
    ['windowUpdate', 1, { focused: true }],
  ]);
  routing.dispose();
});

test('does not activate a background arrival or select a user tab', async () => {
  const ctx = task();
  const { api, events, calls } = fakeApi({
    tab: { id: 2, windowId: 10, incognito: false, active: true },
  });
  const routing = new AgentWindowRouting(managerFor(ctx), api);
  await tick();
  events.focus.emit(-1);
  events.created.emit({ id: 2, windowId: 10 });
  await waitFor(() => moveCalls(calls).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(updateCalls(calls), []);
  routing.dispose();
});

test('dispose removes every listener and cancels the pending routing timer', async () => {
  const ctx = task();
  const { api, events, calls } = fakeApi();
  const routing = new AgentWindowRouting(managerFor(ctx), api);
  await tick();
  assert.equal(events.created.count(), 1);
  assert.equal(events.nav.count(), 1);
  assert.equal(events.focus.count(), 1);
  events.created.emit({ id: 2, windowId: 10 });
  routing.dispose();
  assert.equal(events.created.count(), 0);
  assert.equal(events.attached.count(), 0);
  assert.equal(events.updated.count(), 0);
  assert.equal(events.removed.count(), 0);
  assert.equal(events.detached.count(), 0);
  assert.equal(events.nav.count(), 0);
  assert.equal(events.focus.count(), 0);
  assert.equal(events.windowRemoved.count(), 0);
  assert.equal(ctx.pendingRoutingTabs.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(moveCalls(calls).length, 0);
});

test('retains multi-level page provenance without claiming the opened pages', async () => {
  const ctx = task(new Set([100]));
  const { api, events, calls } = fakeApi();
  const routing = new AgentWindowRouting(managerFor(ctx), api);
  await tick();
  events.created.emit({ id: 100, windowId: 10 });
  events.nav.emit({ sourceTabId: 100, tabId: 101 });
  events.created.emit({ id: 101, windowId: 10 });
  events.nav.emit({ sourceTabId: 101, tabId: 102 });
  events.created.emit({ id: 102, windowId: 10 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(moveCalls(calls).length, 0);
  assert.equal(ctx.pendingRoutingTabs.size, 0);
  assert.equal(ctx.agentCreatedTabs.has(102), false);
  routing.dispose();
});

test('creates a private replacement window instead of reusing an incompatible one', async () => {
  const ctx = task();
  const { api, events, calls, state } = fakeApi({
    windows: [{ id: 10, type: 'normal', focused: false, incognito: true }],
    tab: { id: 2, windowId: 10, incognito: true, active: false },
  });
  const routing = new AgentWindowRouting(managerFor(ctx), api);
  await tick();
  events.created.emit({ id: 2, windowId: 10 });
  await waitFor(() => calls.some((call) => call[0] === 'create'));
  assert.deepEqual(calls.find((call) => call[0] === 'create'), [
    'create',
    { tabId: 2, type: 'normal', focused: false, incognito: true },
  ]);
  assert.equal(state.tab.windowId, 20);
  assert.equal(moveCalls(calls).length, 0);
  routing.dispose();
});
