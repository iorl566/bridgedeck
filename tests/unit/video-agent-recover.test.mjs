import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoManager } from '../../extension/src/video/manager.js';

function harness(host, initial = []) {
  const values = new Map(initial.map((value) => [value.recording_id, value]));
  const calls = [];
  const store = {
    prepared: 0,
    async prepare() { this.prepared += 1; },
    async put(value) { values.set(value.recording_id, value); },
    async get(id) { return values.get(id); },
    async list() { return [...values.values()]; },
    async remove(id) { values.delete(id); },
  };
  const manager = new VideoManager({ store, now: () => 1000, createId: () => `vid_${'1'.padStart(32, '0')}`, createCapability: () => 'cap', host });
  return { manager, values, store, calls };
}

const interrupted = {
  recording_id: `vid_${'1'.padStart(32, '0')}`,
  session_id: 's1', tab_id: 7, title: 'T', state: 'recording', quality: 'standard',
  created_at: 1, expires_at: 10_000, max_duration_ms: 60_000, duration_ms: 0,
  byte_size: 0, width: 0, height: 0, frames: 0, dropped_frames: 0, exported: false,
  owner: 'local', capability: 'cap', request_id: 'req12345',
};

test('recover prepares storage and asks the host to resume interrupted recordings', async () => {
  const calls = [];
  const h = harness({ async request(command) { calls.push(command); return {}; } }, [interrupted]);
  await h.manager.ready;
  assert.equal(h.store.prepared, 1);
  assert.deepEqual(calls[0], { action: 'recover', recording_id: interrupted.recording_id });
  assert.equal(h.values.get(interrupted.recording_id).state, 'recording');
});

test('recover marks a recording failed when the host cannot resume it', async () => {
  const h = harness({ async request() { throw new Error('worker gone'); } }, [interrupted]);
  await h.manager.ready;
  const stored = h.values.get(interrupted.recording_id);
  assert.equal(stored.state, 'failed');
  assert.equal(stored.stop_reason, 'browser_restarted');
  assert.equal(stored.completeness, 'partial');
});
