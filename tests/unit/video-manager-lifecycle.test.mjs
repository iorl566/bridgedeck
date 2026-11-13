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
  let id = 0;
  return new VideoManager({
    store,
    now: () => 1000,
    createId: () => `vid_${String(++id).padStart(32, '0')}`,
    createCapability: () => 'cap',
  });
}

const options = { session_id: 's1', tab_id: 7, request_id: 'req12345' };

test('stopSession and stopTab stop only matching recordings', async () => {
  const manager = harness();
  const a = await manager.start(options);
  await manager.stopTab(7, 'tab_closed');
  assert.equal((await manager.get(a.recording.recording_id)).stop_reason, 'tab_closed');
  const b = await manager.start({ ...options, tab_id: 8, session_id: 's2', request_id: 'req67890' });
  await manager.stopSession('s2');
  assert.equal((await manager.get(b.recording.recording_id)).stop_reason, 'session_ended');
});

test('reserveActionRecording blocks video starts until released', async () => {
  const manager = harness();
  const release = manager.reserveActionRecording('s1');
  assert.equal(typeof release, 'function');
  await assert.rejects(manager.start(options), /action recording/);
  release();
  const started = await manager.start(options);
  assert.equal(manager.reserveActionRecording('s1'), undefined);
  await manager.stop(started.recording.recording_id);
  assert.equal(typeof manager.reserveActionRecording('s1'), 'function');
});
