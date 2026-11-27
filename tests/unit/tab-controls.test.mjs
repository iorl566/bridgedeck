import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabControls } from '../../daemon/tab-controls.js';

function make() {
  const sessions = new Map();
  const reservations = new Map();
  const synced = [];
  const controls = createTabControls({
    sessions,
    tabReservations: {
      reserve: (tabId, owner) => {
        if (reservations.has(tabId)) return { ok: false, owner: reservations.get(tabId) };
        reservations.set(tabId, owner);
        return { ok: true, owner };
      },
    },
    tabControl: { sync: (tabId, ids, opts) => { synced.push({ tabId, ids, opts }); return { tabId, ids }; } },
    sessionState: { phase: () => 'active' },
    CONTROL_MODES: ['open', 'exclusive'],
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    saveSessions: () => {},
  });
  return { controls, sessions, reservations, synced };
}

test('tabSessionIds 按 startedAt 升序', () => {
  const { controls, sessions } = make();
  sessions.set('b', { sessionId: 'b', tabId: 7, startedAt: 20 });
  sessions.set('a', { sessionId: 'a', tabId: 7, startedAt: 10 });
  assert.deepEqual(controls.tabSessionIds(7), ['a', 'b']);
});

test('claimTab 冲突时报 E_BORROW_CONFLICT', () => {
  const { controls, sessions } = make();
  sessions.set('other', { sessionId: 'other', tabId: 7 });
  assert.throws(() => controls.claimTab(7, 'me'), (error) => error.code === 'E_BORROW_CONFLICT');
});

test('syncTabControl 选非 shared 主会话', () => {
  const { controls, sessions, synced } = make();
  sessions.set('shared', { sessionId: 'shared', tabId: 7, startedAt: 1, shared: true });
  sessions.set('main', { sessionId: 'main', tabId: 7, startedAt: 2 });
  controls.syncTabControl(7);
  assert.equal(synced[0].opts.primary, 'main');
});
