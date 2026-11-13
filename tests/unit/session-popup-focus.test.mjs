import test from 'node:test';
import assert from 'node:assert/strict';
import { watchPopupFocus } from '../../extension/src/session-manager/popup-focus.js';

function harness(state = 'normal') {
  const listeners = [];
  const updates = [];
  const removals = [];
  const windows = {
    onFocusChanged: { addListener: (h) => listeners.push(['focus', h]), removeListener: (h) => removals.push(h) },
    onBoundsChanged: { addListener: (h) => listeners.push(['bounds', h]), removeListener: (h) => removals.push(h) },
    async getAll() { return [{ id: 1, focused: true, state }, { id: 2, focused: false, state }]; },
    async get(id) { return { id, state }; },
    async update(id, value) { updates.push([id, value]); },
  };
  const focus = (id) => listeners.filter(([type]) => type === 'focus').forEach(([, handler]) => handler(id));
  return { watcher: watchPopupFocus(2, windows), updates, focus, removals };
}

test('restores previously focused window after popup activation', async () => {
  const { watcher, updates, focus } = harness();
  await new Promise((resolve) => setTimeout(resolve, 1));
  watcher.arm();
  focus(2);
  await watcher.finish(() => true);
  assert.deepEqual(updates, [[1, { focused: true }]]);
});

test('does not restore when user switched windows', async () => {
  const { watcher, updates, focus } = harness();
  await new Promise((resolve) => setTimeout(resolve, 1));
  watcher.arm();
  focus(3);
  focus(2);
  await watcher.finish(() => true);
  assert.equal(updates.length, 0);
});

test('minimizes previously minimized window', async () => {
  const { watcher, updates, focus } = harness('minimized');
  await new Promise((resolve) => setTimeout(resolve, 1));
  watcher.arm();
  focus(2);
  await watcher.finish(() => true);
  assert.deepEqual(updates, [[2, { state: 'minimized' }]]);
});
