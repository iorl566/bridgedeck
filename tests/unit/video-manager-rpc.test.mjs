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
    async file() { return { size: 0, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }; },
  };
  let id = 0;
  const manager = new VideoManager({
    store,
    now: () => 1000,
    createId: () => `vid_${String(++id).padStart(32, '0')}`,
    createCapability: () => 'cap',
  });
  return { manager, store };
}

const options = { session_id: 's1', tab_id: 7, request_id: 'req12345' };

test('rpc capabilities and start/list/status', async () => {
  const h = harness();
  assert.equal((await h.manager.rpc({ action: 'capabilities' })).format, 'mp4');
  const started = await h.manager.rpc({ action: 'start', ...options });
  assert.equal(started.recording.state, 'starting');
  const listed = await h.manager.rpc({ action: 'list' });
  assert.equal(listed.recordings.length, 1);
  const status = await h.manager.rpc({ action: 'status', recording_id: started.recording.recording_id, capability: 'cap' });
  assert.equal(status.recording.recording_id, started.recording.recording_id);
  assert.equal(status.recording.owner, undefined);
});

test('rpc rejects wrong capability and unsupported action', async () => {
  const h = harness();
  const started = await h.manager.rpc({ action: 'start', ...options });
  await assert.rejects(h.manager.rpc({ action: 'status', recording_id: started.recording.recording_id, capability: 'bad' }), /access denied/);
  await assert.rejects(h.manager.rpc({ action: 'nope', recording_id: started.recording.recording_id, capability: 'cap' }), /Unsupported/);
});
