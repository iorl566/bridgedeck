import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoDownloads, DOWNLOAD_PREFIX } from '../../extension/src/video/downloads.js';

function harness(state = 'ready') {
  const storageMap = new Map();
  const events = [];
  const storage = {
    async get(key) { return key === null ? Object.fromEntries(storageMap) : (storageMap.has(key) ? { [key]: storageMap.get(key) } : {}); },
    async set(values) { for (const [key, value] of Object.entries(values)) storageMap.set(key, value); },
    async remove(key) { storageMap.delete(key); },
  };
  const downloads = {
    async download(details) { events.push(['download', details]); return 7; },
    async search() { return [{ id: 7, state: 'complete' }]; },
  };
  const host = { async request(command) { events.push(['host', command]); return command.action === 'download_url' ? 'blob:url' : undefined; } };
  const video = { async get() { return { recording_id: 'vid', state, title: 't', created_at: 0 }; }, async exported(id) { events.push(['exported', id]); } };
  let changed;
  const manager = new VideoDownloads(video, host, { storage, downloads, onChanged: (listener) => { changed = listener; } });
  return { manager, events, storageMap, changed: (id) => changed({ id }) };
}

test('save downloads and settles completion', async () => {
  const { manager, events, storageMap } = harness();
  const result = await manager.save('vid');
  assert.deepEqual(result, { download_id: 7 });
  assert.equal(events.some((event) => event[0] === 'download'), true);
  assert(events.some((event) => event[0] === 'exported' && event[1] === 'vid'));
  assert(events.some((event) => event[0] === 'host' && event[1].action === 'revoke_url'));
  assert.equal(storageMap.size, 0);
});

test('save rejects recording not ready and revokes on failure', async () => {
  const { manager } = harness('recording');
  await assert.rejects(() => manager.save('vid'), /not ready/);
  const failing = harness();
  failing.manager.downloads.download = async () => { throw new Error('cancelled'); };
  await assert.rejects(() => failing.manager.save('vid'), /cancelled/);
  assert(failing.events.some((event) => event[0] === 'host' && event[1].action === 'revoke_url'));
});

test('attach resumes persisted download jobs', async () => {
  const { manager, storageMap, changed } = harness();
  storageMap.set(`${DOWNLOAD_PREFIX}8`, { recording: 'vid', url: 'blob:url' });
  manager.attach();
  await new Promise((resolve) => setTimeout(resolve, 5));
  changed(7);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(manager.settling.size, 0);
});
