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
  const requests = [];
  let id = 0;
  const manager = new VideoManager({
    store,
    now: () => 1000,
    createId: () => `vid_${String(++id).padStart(32, '0')}`,
    createCapability: () => 'cap',
    host: {
      async request(command) {
        requests.push(command);
        if (command.action === 'stop') return { recording: { recording_id: command.recording_id, frames: 3, duration_ms: 2000 } };
        return {};
      },
    },
  });
  return { manager, requests };
}

const options = { session_id: 's1', tab_id: 7, request_id: 'req12345' };

test('stop forwards to host and merges final metadata', async () => {
  const h = harness();
  const started = await h.manager.start(options);
  const stopped = await h.manager.stop(started.recording.recording_id, 'duration_limit');
  assert.equal(h.requests.at(-1).action, 'stop');
  assert.equal(stopped.frames, 3);
  assert.equal(stopped.duration_ms, 2000);
  assert.equal(stopped.completeness, 'complete');
});

test('disconnect stops the active recording', async () => {
  const h = harness();
  await h.manager.start(options);
  await h.manager.disconnect();
  assert.equal(h.manager.active.size, 0);
  assert.equal(h.requests.filter((command) => command.action === 'stop').length, 1);
});
