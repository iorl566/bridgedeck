import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionExpired, sessionPublicView, summarizeSessions } from '../../lib/session-model.mjs';

const session = {
  sessionId: 's1', instanceId: 'i1', tabId: 7, windowId: 8, url: 'https://example.com/', title: 't',
  borrowed: true, incognito: false, startedAt: 1000, disconnectedAt: 0,
};

test('sessionPublicView includes connection and phase', () => {
  const view = sessionPublicView(session, { connected: true, phase: 'active', now: 2000 });
  assert.equal(view.sessionId, 's1');
  assert.equal(view.connected, true);
  assert.equal(view.phase, 'active');
  assert.equal(view.borrowed, true);
  assert.equal(view.ageMs, 1000);
});

test('isSessionExpired only when disconnected past ttl', () => {
  assert.equal(isSessionExpired(session, { connected: true, now: 10_000_000 }), false);
  assert.equal(isSessionExpired({ ...session, disconnectedAt: 1000 }, { now: 2000, ttlMs: 5000 }), false);
  assert.equal(isSessionExpired({ ...session, disconnectedAt: 1000 }, { now: 7000, ttlMs: 5000 }), true);
});

test('summarizeSessions sorts by startedAt and maps connection', () => {
  const rows = summarizeSessions([
    { ...session, sessionId: 'b', startedAt: 2000 },
    { ...session, sessionId: 'a', startedAt: 1000 },
  ], { isConnected: (item) => item.sessionId === 'b', phaseOf: () => 'active' });
  assert.deepEqual(rows.map((row) => row.sessionId), ['a', 'b']);
  assert.equal(rows[1].connected, true);
  assert.equal(rows[1].phase, 'active');
});
