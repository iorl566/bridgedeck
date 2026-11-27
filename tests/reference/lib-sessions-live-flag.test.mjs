import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSessionsLiveFlag, SESSIONS_LIVE_FLAG_KEY } from '../../reference/extension-mirror/src/lib/sessions-live-flag.js';

test('sessions live flag writes once and clears', async () => {
  const writes = [];
  const storage = {
    async setAccessLevel() {},
    async set(items) { writes.push(['set', items]); },
    async remove(key) { writes.push(['remove', key]); },
  };
  const manager = { list: () => [] };
  const flag = attachSessionsLiveFlag({ manager, storage });
  await flag.refresh();
  assert.deepEqual(writes, [['remove', SESSIONS_LIVE_FLAG_KEY]]);
  manager.list = () => [{ sessionId: 's1' }];
  await flag.syncFromManager();
  assert.deepEqual(writes[1], ['set', { [SESSIONS_LIVE_FLAG_KEY]: true }]);
  await flag.syncFromManager();
  assert.equal(writes.length, 2);
});
