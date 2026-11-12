import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTarget } from '../../extension/src/lib/task-preview.js';

function task(overrides = {}) {
  return { sessionId: 's1', remote: true, agentWindowId: 10, agentCreatedTabs: new Set([1]), borrowedTabs: new Map(), observedTabs: new Set(), ...overrides };
}

test('taskTarget requires a remote task', async () => {
  const manager = { get: () => task({ remote: false }) };
  await assert.rejects(() => taskTarget(manager, 's1', { tabs: { query: async () => [] } }), /Task unavailable/);
});

test('taskTarget prefers the active owned tab', async () => {
  const ctx = task();
  const manager = { get: () => ctx };
  const tabs = { async query() { return [{ id: 1, active: false }, { id: 2, active: true }, { id: 3, active: true }]; } };
  assert.equal(await taskTarget(manager, 's1', { tabs }), 1);
});

test('taskTarget rejects when no owned tab exists', async () => {
  const ctx = task({ agentCreatedTabs: new Set() });
  const manager = { get: () => ctx };
  await assert.rejects(() => taskTarget(manager, 's1', { tabs: { query: async () => [{ id: 9, active: true }] } }), /Task tab unavailable/);
});
