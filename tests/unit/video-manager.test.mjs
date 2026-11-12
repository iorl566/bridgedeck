import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoManager } from '../../extension/src/video/manager.js';
import { VideoArtifactStore } from '../../extension/src/video/store.js';

function harness() {
  const store = new VideoArtifactStore({ factory: undefined, storage: undefined, now: () => 1000 });
  let serial = 0;
  const manager = new VideoManager({
    store, now: () => 1000,
    createId: () => `vid_${String(serial++).padStart(32, 'a')}`,
    createCapability: () => 'cap-' + serial,
    createOwner: () => 'owner',
  });
  return { manager, store };
}

test('VideoManager start/stop/list persists lifecycle', async () => {
  const { manager } = harness();
  const grant = await manager.start({ session_id: 's1', request_id: 'req_12345', tab_id: 3 });
  assert.equal(grant.recording.state, 'starting');
  assert.equal(grant.recording.quality, 'standard');
  assert.equal(grant.recording.expires_at, 1000 + 24 * 60 * 60 * 1000);
  assert.equal(manager.isRecording('s1'), true);
  const stopped = await manager.stop(grant.recording.recording_id, 'user_stopped');
  assert.equal(stopped.state, 'ready');
  assert.equal(stopped.completeness, 'complete');
  assert.equal((await manager.list('owner')).length, 1);
});

test('VideoManager get enforces capability and discard removes', async () => {
  const { manager } = harness();
  const grant = await manager.start({ session_id: 's1', request_id: 'req_12345' });
  const value = await manager.get(grant.recording.recording_id, { owner: 'owner', capability: grant.capability });
  assert.equal(value.recording_id, grant.recording.recording_id);
  await assert.rejects(() => manager.get(grant.recording.recording_id, { owner: 'owner', capability: 'bad' }), /denied/);
  await assert.rejects(() => manager.discard(grant.recording.recording_id), /Stop the recording/);
  await manager.stop(grant.recording.recording_id);
  await manager.discard(grant.recording.recording_id);
  await assert.rejects(() => manager.get(grant.recording.recording_id), /not found/);
});

test('VideoManager validates start options', async () => {
  const { manager } = harness();
  await assert.rejects(() => manager.start({ session_id: '', request_id: 'req_12345' }), /session_id/);
  await assert.rejects(() => manager.start({ session_id: 's', request_id: 'short' }), /request_id/);
});
