import test from 'node:test';
import assert from 'node:assert/strict';
import { screenshotDirectory, screenshotRoot, TileWriter } from '../../extension/src/long-screenshot/tiles.js';
import { pruneScreenshots, SCREENSHOT_HISTORY_AGE_MS } from '../../extension/src/long-screenshot/retention.js';

function fakeStorage() {
  const root = {
    async getDirectoryHandle(name, opts) { return { name, opts }; },
  };
  return { async getDirectory() { return root; } };
}

test('screenshotDirectory validates ids and root', async () => {
  const storage = fakeStorage();
  const root = await screenshotRoot(true, storage);
  assert.equal(root.name, 'long-screenshots');
  await assert.rejects(() => screenshotDirectory('../bad', false, storage), /Invalid screenshot id/);
});

test('TileWriter finish only after writing data', async () => {
  const writer = new TileWriter('id', 'title', () => 100);
  writer.shot.height = 10;
  let written = 0;
  await writer.finish(undefined, async () => { written += 1; });
  assert.equal(written, 0);
  writer.directory = { name: 'dir' };
  await writer.finish('timeout', async (_dir, name, text) => { written += 1; assert.equal(name, 'index.json'); assert.equal(JSON.parse(text).notice, 'timeout'); });
  assert.equal(written, 1);
  assert.equal(writer.shot.notice, 'timeout');
});

test('pruneScreenshots keeps recent/limit and respects keep()', async () => {
  const ids = [
    '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
    '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666',
  ];
  const removed = [];
  const root = {
    async *entries() {
      for (const [index, id] of ids.entries()) yield [id, { kind: 'directory' }];
      yield ['not-a-popup', { kind: 'directory' }];
    },
    async removeEntry(id) { removed.push(id); },
  };
  const createdAt = new Map(ids.map((id, index) => [id, 1000 - index]));
  await pruneScreenshots(async (id) => id === ids[5], 1000 + SCREENSHOT_HISTORY_AGE_MS + 1, {
    root,
    read: async (id) => ({ createdAt: createdAt.get(id) }),
  });
  assert.equal(removed.length, 5);
  assert.equal(removed.includes(ids[5]), false);
});
