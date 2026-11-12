import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoArtifactStore, videoDirectory } from '../../extension/src/video/store.js';

const id = 'vid_' + 'a'.repeat(32);
const value = (overrides = {}) => ({ recording_id: id, expires_at: 100, title: 't', ...overrides });

test('VideoArtifactStore fallback put/list/get/remove', async () => {
  const store = new VideoArtifactStore({ factory: undefined, storage: undefined, now: () => 50 });
  await store.put(value());
  assert.deepEqual((await store.list()).map((item) => item.recording_id), [id]);
  assert.equal((await store.get(id)).title, 't');
  assert.equal(await store.get('bad'), undefined);
  await store.remove(id);
  assert.equal(await store.get(id), undefined);
});

test('VideoArtifactStore prepare removes expired except active', async () => {
  const store = new VideoArtifactStore({ factory: undefined, storage: undefined, now: () => 200 });
  const expiring = 'vid_' + 'c'.repeat(32);
  await store.put(value({ recording_id: id, expires_at: 100 }));
  await store.put(value({ recording_id: 'vid_' + 'b'.repeat(32), expires_at: 300 }));
  await store.put(value({ recording_id: expiring, expires_at: 50 }));
  await store.prepare(id);
  const ids = (await store.list()).map((item) => item.recording_id).sort();
  assert.deepEqual(ids, [id, 'vid_' + 'b'.repeat(32)].sort());
});

test('videoDirectory validates ids', async () => {
  await assert.rejects(() => videoDirectory('bad'), /Invalid recording ID/);
});
