import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoManager } from '../../extension/src/video/manager.js';

function manager(deps = {}) {
  const values = new Map();
  const store = {
    async put(value) { values.set(value.recording_id, value); },
    async get(id) { return values.get(id); },
    async list() { return [...values.values()]; },
    async remove(id) { values.delete(id); },
  };
  let id = 0;
  return new VideoManager({
    store,
    now: () => 1000,
    createId: () => `vid_${String(++id).padStart(32, '0')}`,
    createCapability: () => 'cap',
    ...deps,
  });
}

test('tasks derive from sessions and tabs', async () => {
  const m = manager({
    sessions: { list: () => [{ sessionId: 's1', agentWindowId: 2 }] },
    tabs: { query: async () => [{ id: 7, title: 'T', url: 'u', active: true }, { title: 'no id' }] },
  });
  assert.deepEqual(await m.tasks(), [{ session_id: 's1', tabs: [{ id: 7, title: 'T', url: 'u', active: true }] }]);
});

test('queryOverlay returns recording id while starting and delegates otherwise', async () => {
  const calls = [];
  const m = manager({ overlay: async (tabId, id) => { calls.push([tabId, id]); return { recording_id: id ?? 'none' }; } });
  const started = await m.start({ session_id: 's1', tab_id: 7, request_id: 'req12345' });
  const id = started.recording.recording_id;
  assert.equal(await m.queryOverlay(7), id);
  assert.equal(await m.queryOverlay(8), 'none');
  assert.deepEqual(calls.at(-1), [8, null]);
});
