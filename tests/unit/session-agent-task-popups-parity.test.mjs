import test from 'node:test';
import assert from 'node:assert/strict';
import { withTaskPopups } from '../../extension/src/session-manager/task-popups.js';

function listenerSet() {
  const listeners = new Set();
  return {
    addListener(handler) { listeners.add(handler); },
    removeListener(handler) { listeners.delete(handler); },
    emit(...args) { for (const handler of [...listeners]) handler(...args); },
    count() { return listeners.size; },
  };
}

function fakeApi() {
  const targets = listenerSet();
  const tabRemoved = listenerSet();
  const tabDetached = listenerSet();
  const tabFocus = listenerSet();
  const bounds = listenerSet();
  const tabs = new Map([[1, { id: 1, windowId: 10 }]]);
  const api = {
    webNavigation: { onCreatedNavigationTarget: targets },
    tabs: {
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab');
        return { ...tab };
      },
      onRemoved: tabRemoved,
      onDetached: tabDetached,
    },
    windows: {
      onFocusChanged: tabFocus,
      onBoundsChanged: bounds,
      async getAll() {
        return [
          { id: 1, focused: true, state: 'normal' },
          { id: 10, focused: false, state: 'normal' },
        ];
      },
      async get(id) {
        return { id, state: 'normal' };
      },
      async update() {},
    },
  };
  return { api, targets, tabRemoved, tabDetached, tabFocus, bounds, tabs };
}

function setup(remote = false) {
  const ctx = {
    sessionId: 's1',
    remote,
    agentWindowId: 10,
    agentCreatedTabs: new Set([1]),
    borrowedTabs: new Map(),
    observedTabs: new Set(),
  };
  const manager = {
    get: (id) => (id === 's1' ? ctx : null),
    isWindowCloseExpected: () => false,
    findBorrowingSession: () => null,
    findControllingSession: () => null,
  };
  return { ctx, manager };
}

test('abort removes observation listeners immediately and blocks late claims', async () => {
  const f = fakeApi();
  const { ctx, manager } = setup();
  const controller = new AbortController();
  let release;
  const work = withTaskPopups(manager, { session_id: 's1' }, async (input) => {
    input(1);
    await new Promise((resolve) => { release = resolve; });
  }, undefined, controller.signal, f.api);
  assert.equal(f.targets.count(), 1);
  assert.equal(f.tabRemoved.count(), 1);
  assert.equal(f.tabDetached.count(), 1);
  controller.abort();
  assert.equal(f.targets.count(), 0);
  assert.equal(f.tabRemoved.count(), 0);
  assert.equal(f.tabDetached.count(), 0);
  f.tabs.set(2, { id: 2, windowId: 10 });
  f.targets.emit({ sourceTabId: 1, sourceFrameId: 0, tabId: 2 });
  release();
  await work;
  assert.equal(ctx.observedTabs.has(2), false);
  assert.equal(f.tabFocus.count(), 0);
  assert.equal(f.bounds.count(), 0);
});

test('a source tab removal invalidates a pending popup observation', async () => {
  const f = fakeApi();
  const { ctx, manager } = setup();
  await withTaskPopups(manager, { session_id: 's1' }, async (input) => {
    input(1);
    f.tabRemoved.emit(1);
    f.tabs.set(2, { id: 2, windowId: 10 });
    f.targets.emit({ sourceTabId: 1, sourceFrameId: 0, tabId: 2 });
  }, undefined, undefined, f.api);
  assert.equal(ctx.observedTabs.has(2), false);
});

test('observes nested same-window targets opened from an observed popup', async () => {
  const f = fakeApi();
  const { ctx, manager } = setup();
  await withTaskPopups(manager, { session_id: 's1' }, async (input) => {
    input(1);
    f.tabs.set(2, { id: 2, windowId: 10 });
    f.targets.emit({ sourceTabId: 1, sourceFrameId: 0, tabId: 2 });
    f.tabs.set(3, { id: 3, windowId: 10 });
    f.targets.emit({ sourceTabId: 2, sourceFrameId: 0, tabId: 3 });
  }, undefined, undefined, f.api);
  assert.deepEqual([...ctx.observedTabs].sort((a, b) => a - b), [2, 3]);
});

test('does not observe targets arriving after the input window closes', async () => {
  const f = fakeApi();
  const { ctx, manager } = setup();
  await withTaskPopups(manager, { session_id: 's1' }, async (input) => {
    input(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    f.tabs.set(2, { id: 2, windowId: 10 });
    f.targets.emit({ sourceTabId: 1, sourceFrameId: 0, tabId: 2 });
  }, undefined, undefined, f.api);
  assert.equal(ctx.observedTabs.has(2), false);
  assert.equal(f.targets.count(), 0);
});

test('ignores input signals from a tab outside the requested target', async () => {
  const f = fakeApi();
  const { manager } = setup();
  await withTaskPopups(manager, { session_id: 's1', tab_id: 1 }, async (input) => {
    input(2);
  }, undefined, undefined, f.api);
  assert.equal(f.targets.count(), 0);
  assert.equal(f.tabFocus.count(), 0);
});

test('does not observe anything when the action sends no input', async () => {
  const f = fakeApi();
  const { ctx, manager } = setup();
  const result = await withTaskPopups(manager, { session_id: 's1' }, async () => 42, undefined, undefined, f.api);
  assert.equal(result, 42);
  assert.equal(ctx.observedTabs.size, 0);
  assert.equal(f.targets.count(), 0);
  assert.equal(f.tabFocus.count(), 0);
});
