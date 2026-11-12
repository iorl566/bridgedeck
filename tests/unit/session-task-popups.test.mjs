import test from 'node:test';
import assert from 'node:assert/strict';
import { withTaskPopups } from '../../extension/src/session-manager/task-popups.js';

function fakeApi() {
  const navListeners = [];
  const tabRemoved = [];
  const tabDetached = [];
  const windowsListeners = [];
  const api = {
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: (h) => navListeners.push(h),
        removeListener: (h) => { const index = navListeners.indexOf(h); if (index >= 0) navListeners.splice(index, 1); },
      },
    },
    tabs: {
      async get(id) { return { id, windowId: 10 }; },
      onRemoved: { addListener: (h) => tabRemoved.push(h), removeListener() {} },
      onDetached: { addListener: (h) => tabDetached.push(h), removeListener() {} },
    },
    windows: {
      onFocusChanged: { addListener() {}, removeListener() {} },
      onBoundsChanged: { addListener() {}, removeListener() {} },
      async getAll() { return [{ id: 1, focused: true, state: 'normal' }, { id: 10, focused: false, state: 'normal' }]; },
      async get(id) { return { id, state: 'normal' }; },
      async update() {},
    },
  };
  return { api, emit: (value) => navListeners.forEach((handler) => handler(value)), navCount: () => navListeners.length };
}

function task(remote = false) {
  return {
    sessionId: 's1', remote, agentWindowId: 10,
    agentCreatedTabs: new Set([1]), borrowedTabs: new Map(), observedTabs: new Set(),
  };
}
const managerFor = (ctx) => ({
  get: (id) => (id === 's1' ? ctx : null),
  isWindowCloseExpected: () => false,
  findBorrowingSession: () => null,
  findControllingSession: () => null,
});

test('without task runs without input tracking', async () => {
  let called = 0;
  const result = await withTaskPopups(managerFor(null), {}, async (input) => { input(1); called += 1; return 7; }, undefined, undefined, fakeApi().api);
  assert.equal(result, 7);
  assert.equal(called, 1);
});

test('observes same-window popup after input', async () => {
  const ctx = task();
  const { api, emit } = fakeApi();
  let claimed;
  const result = await withTaskPopups(managerFor(ctx), { session_id: 's1', tab_id: 1 }, async (input) => {
    input(1);
    emit({ sourceTabId: 1, sourceFrameId: 0, tabId: 2 });
    return 'ok';
  }, (tabId) => { claimed = tabId; }, undefined, api);
  assert.equal(result, 'ok');
  assert.equal(ctx.observedTabs.has(2), true);
  assert.equal(claimed, 2);
});

test('ignores cross-window popup', async () => {
  const ctx = task();
  const { api, emit } = fakeApi();
  api.tabs.get = async (id) => ({ id, windowId: id === 2 ? 11 : 10 });
  await withTaskPopups(managerFor(ctx), { session_id: 's1', tab_id: 1 }, async (input) => {
    input(1);
    emit({ sourceTabId: 1, sourceFrameId: 0, tabId: 2 });
  }, undefined, undefined, api);
  assert.equal(ctx.observedTabs.has(2), false);
});
