import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoManager } from '../../extension/src/video/manager.js';

function harness(now = 1000) {
  const values = new Map();
  const store = {
    async put(value) { values.set(value.recording_id, value); },
    async get(id) { return values.get(id); },
    async list() { return [...values.values()]; },
    async remove(id) { values.delete(id); },
  };
  let id = 0;
  const manager = new VideoManager({
    store,
    now: () => now,
    createId: () => `vid_${String(++id).padStart(32, '0')}`,
    createCapability: () => 'cap',
  });
  return { manager, values };
}

const options = { session_id: 's1', tab_id: 7, request_id: 'req12345' };

test('finished keeps failed state and clears active', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  const id = started.recording.recording_id;
  await h.manager.stop(id);
  await h.manager.finished(id);
  assert.equal((await h.values.get(id)).state, 'ready');
  assert.equal(h.manager.active.size, 0);
});

test('sync prunes expired recordings but keeps active ones', async () => {
  const h = harness(1000);
  const started = await h.manager.start(options);
  const expiredId = `vid_${'9'.repeat(32)}`;
  h.values.set(expiredId, { ...started.recording, recording_id: expiredId, expires_at: 0 });
  assert.equal(await h.manager.sync(), 1);
  assert.equal(h.values.has(expiredId), false);
  assert.equal(h.values.has(started.recording.recording_id), true);
});
