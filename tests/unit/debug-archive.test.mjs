import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDebugArchive, pruneArchives, queryArchive } from '../../lib/debug-archive.mjs';

test('buildDebugArchive normalizes requests and computes summary', () => {
  const archive = buildDebugArchive({
    context: { url: 'https://example.com/', title: 'Example' },
    requests: [
      { id: 1, method: 'GET', url: 'https://example.com/api', status: 200, type: 'XHR', commandId: 'c1', durationMs: 12 },
      { id: 2, method: 'GET', url: 'https://example.com/a.png', status: 404, commandId: 'c1' },
    ],
    console: [{ level: 'warn', text: 'hi' }],
  }, { id: 'a1', session: 's1', now: 1700000000000 });
  assert.equal(archive.version, 1);
  assert.equal(archive.id, 'a1');
  assert.equal(archive.summary.requests, 2);
  assert.equal(archive.summary.console, 1);
  assert.equal(archive.summary.commands, 1);
  assert.equal(archive.requests[0].commandId, 'c1');
  assert.equal(archive.page.url, 'https://example.com/');
});

test('queryArchive filters normalized requests', () => {
  const archive = buildDebugArchive({
    requests: [
      { id: 1, method: 'GET', url: 'https://example.com/api', status: 200, type: 'XHR' },
      { id: 2, method: 'POST', url: 'https://example.com/api', status: 500, type: 'Fetch' },
    ],
  }, { now: 1 });
  assert.equal(queryArchive(archive, { method: 'POST' }).length, 1);
  assert.equal(queryArchive(archive, { status: 500 })[0].id, 2);
  assert.equal(queryArchive(archive, { kind: 'business' }).length, 2);
});

test('pruneArchives drops expired archives', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const live = { expiresAt: new Date(now + 1000).toISOString() };
  const dead = { expiresAt: new Date(now - 1000).toISOString() };
  assert.deepEqual(pruneArchives([live, dead], now), [live]);
});
