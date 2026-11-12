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
    async reserve() {},
  };
  let id = 0;
  return new VideoManager({
    store,
    now: () => 1000,
    createId: () => `vid_${String(++id).padStart(32, '0')}`,
    createCapability: () => 'cap',
    tabs: { async get() { return { title: 'Tab title' }; } },
  });
}

const options = { session_id: 's1', tab_id: 7, request_id: 'req12345' };

test('start is idempotent for the same owner and request id', async () => {
  const manager = harness();
  const first = await manager.start(options);
  const second = await manager.start(options);
  assert.equal(second.recording.recording_id, first.recording.recording_id);
  assert.equal(manager.active.size, 1);
});

test('start fills title from the tab dependency', async () => {
  const manager = harness();
  const started = await manager.start(options);
  assert.equal(started.recording.title, 'Tab title');
});

test('start refuses a second active recording', async () => {
  const manager = harness();
  await manager.start(options);
  await assert.rejects(manager.start({ ...options, request_id: 'req67890' }), /already recording/);
});
