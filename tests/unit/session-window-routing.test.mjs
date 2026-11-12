import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentWindowRouting } from '../../extension/src/session-manager/window-routing.js';

function fakeApi() {
  const listeners = {};
  const add = (name) => ({ addListener: (h) => { (listeners[name] ??= []).push(h); }, removeListener: (h) => { listeners[name] = (listeners[name] ?? []).filter((x) => x !== h); } });
  const calls = [];
  const api = {
    tabs: {
      onCreated: add('created'), onAttached: add('attached'), onUpdated: add('updated'), onRemoved: add('removed'), onDetached: add('detached'),
      async get(id) { return { id, windowId: 10, incognito: false, active: false }; },
      async query() { return []; },
      async move(id, opts) { calls.push(['move', id, opts]); },
      async update(id, opts) { calls.push(['update', id, opts]); },
    },
    webNavigation: { onCreatedNavigationTarget: add('nav') },
    windows: {
      onFocusChanged: add('focus'), onRemoved: add('winRemoved'),
      async getAll() { return [{ id: 1, focused: true, type: 'normal', incognito: false }, { id: 10, focused: false, type: 'normal', incognito: false }]; },
      async get() { return { id: 1, type: 'normal' }; },
      async create() { calls.push(['create']); return { id: 20 }; },
      async update(id, opts) { calls.push(['updateWindow', id, opts]); },
    },
  };
  return { api, emit: (name, ...args) => (listeners[name] ?? []).forEach((h) => h(...args)), calls };
}

function task(agentCreated = new Set()) {
  return { sessionId: 's1', agentWindowId: 10, agentCreatedTabs: agentCreated, borrowedTabs: new Map(), observedTabs: new Set(), pendingRoutingTabs: new Set() };
}
const managerFor = (ctx) => ({
  get: (id) => (id === 's1' ? ctx : null),
  list: () => [ctx],
  findByWindowId: (id) => (id === 10 ? ctx : null),
  isWindowCloseExpected: () => false,
  findBorrowingSession: () => null,
});

test('routes unrelated tab to user window', async () => {
  const ctx = task();
  const { api, emit, calls } = fakeApi();
  const routing = new AgentWindowRouting(managerFor(ctx), api);
  await new Promise((resolve) => setTimeout(resolve, 1));
  emit('created', { id: 2, windowId: 10 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(calls.some((call) => call[0] === 'move' && call[1] === 2 && call[2].windowId === 1));
  assert.equal(ctx.pendingRoutingTabs.has(2), false);
  routing.dispose();
});

test('protected tab is not routed and navigation target clears pending', async () => {
  const ctx = task(new Set([3]));
  const { api, emit, calls } = fakeApi();
  const routing = new AgentWindowRouting(managerFor(ctx), api);
  await new Promise((resolve) => setTimeout(resolve, 1));
  emit('created', { id: 3, windowId: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0);
  ctx.pendingRoutingTabs.add(4);
  emit('nav', { sourceTabId: 3, tabId: 4 });
  assert.equal(ctx.pendingRoutingTabs.has(4), false);
  routing.dispose();
});
