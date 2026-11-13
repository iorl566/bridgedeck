import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoManager } from '../../extension/src/video/manager.js';

function harness() {
  const values = new Map();
  const store = {
    async put(value) { values.set(value.recording_id, value); },
    async get(id) { return values.get(id); },
    async list() { return [...values.values()]; },
    async remove(id) { values.delete(id); },
  };
  const session = { sessionId: 's1', agentWindowId: 2, agentCreatedTabs: new Set([7]), borrowedTabs: new Map(), observedTabs: new Set() };
  let id = 0;
  const manager = new VideoManager({
    store,
    now: () => 1000,
    createId: () => `vid_${String(++id).padStart(32, '0')}`,
    createCapability: () => 'cap',
    sessions: { get: (sessionId) => (sessionId === 's1' ? session : null) },
    tabs: { async get(tabId) { return tabId === 7 ? { id: 7, windowId: 2, title: 'Owned' } : { id: tabId, windowId: 3, title: 'Other' }; } },
  });
  return manager;
}

const options = { session_id: 's1', tab_id: 7, request_id: 'req12345' };

test('start accepts a task-owned tab in the agent window', async () => {
  const manager = harness();
  const grant = await manager.start(options);
  assert.equal(grant.recording.tab_id, 7);
});

test('start rejects an unowned or outside-window tab', async () => {
  const manager = harness();
  await assert.rejects(manager.start({ ...options, tab_id: 8 }), /task-created or borrowed/);
});

test('start rejects an unknown session', async () => {
  const manager = harness();
  await assert.rejects(manager.start({ ...options, session_id: 'nope' }), /active task/);
});
