import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveIndexPath, readArchiveIndex, updateArchiveIndex } from '../../lib/debug-archive-store.mjs';

const archive = (id, createdAt, expiresAt) => ({
  id,
  createdAt: new Date(createdAt).toISOString(),
  expiresAt: new Date(expiresAt).toISOString(),
  summary: { requests: 1, console: 0 },
  page: { url: 'https://example.com/' },
});

test('updateArchiveIndex writes sorted, deduped entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-archive-'));
  try {
    const now = Date.now();
    updateArchiveIndex(dir, archive('a', now - 3000, now + 60000));
    updateArchiveIndex(dir, archive('b', now - 2000, now + 60000));
    updateArchiveIndex(dir, archive('a', now - 1000, now + 60000));
    const entries = readArchiveIndex(dir);
    assert.deepEqual(entries.map((entry) => entry.id), ['a', 'b']);
    assert.equal(entries[0].createdAt, new Date(now - 1000).toISOString());
    assert.equal(fs.existsSync(archiveIndexPath(dir)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateArchiveIndex prunes expired and limits entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-archive-'));
  try {
    const now = Date.now();
    updateArchiveIndex(dir, archive('old', now - 5000, now - 1000), { now });
    updateArchiveIndex(dir, archive('a', now - 3000, now + 60000), { now });
    updateArchiveIndex(dir, archive('b', now - 2000, now + 60000), { now, maxEntries: 1 });
    assert.deepEqual(readArchiveIndex(dir).map((entry) => entry.id), ['b']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
