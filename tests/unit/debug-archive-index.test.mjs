import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveSummary, createArchiveIndex } from '../../lib/debug-archive-index.mjs';

const archive = (id, created, expires, requests = 1) => ({
  id,
  createdAt: new Date(created).toISOString(),
  expiresAt: new Date(expires).toISOString(),
  summary: { requests, console: 0 },
  page: { url: 'https://example.com/' },
});

test('archive index lists newest first and prunes expired', () => {
  const index = createArchiveIndex();
  index.add(archive('a', 1000, 9000, 2));
  index.add(archive('b', 2000, 9000, 1));
  index.add(archive('c', 1500, 3000, 1));
  assert.deepEqual(index.list({ now: 4000 }).map((item) => item.id), ['b', 'a']);
  assert.equal(index.prune(4000), 1);
  assert.deepEqual(index.list({ now: 4000 }).map((item) => item.id), ['b', 'a']);
});

test('archive index enforces max entries', () => {
  const index = createArchiveIndex({ maxEntries: 2 });
  const far = Date.now() + 86400000;
  index.add(archive('a', 1000, far));
  index.add(archive('b', 2000, far));
  index.add(archive('c', 3000, far));
  assert.deepEqual(index.list().map((item) => item.id), ['c', 'b']);
});

test('archive stats and summary are stable', () => {
  const index = createArchiveIndex();
  index.add(archive('a', 1000, 9000000000000, 3));
  assert.deepEqual(index.stats(5000), { total: 1, live: 1, requests: 3 });
  assert.deepEqual(archiveSummary(archive('a', 1000, 9000000000000, 3)), {
    id: 'a', createdAt: new Date(1000).toISOString(), expiresAt: new Date(9000000000000).toISOString(), requests: 3, console: 0, url: 'https://example.com/',
  });
});
