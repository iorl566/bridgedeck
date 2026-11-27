import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionViews } from '../../daemon/session-views.js';

function make() {
  const sessions = new Map();
  sessions.set('b', { sessionId: 'b', instanceId: 'i', tabId: 2, startedAt: 20 });
  sessions.set('a', { sessionId: 'a', instanceId: 'i', tabId: 1, startedAt: 10 });
  const views = createSessionViews({
    sessions,
    instances: new Map([['i', {}]]),
    tabControl: { status: (tabId) => ({ tabId, mode: 'open', epoch: 1, holder: 'a', primary: 'a', shared: false, sessionCount: 1, leaseRemainingMs: 0 }) },
    sessionState: { phase: () => 'active' },
    sessionPublicView: (session, extra) => ({ sessionId: session.sessionId, ...extra }),
    isSessionExpired: () => false,
    resolveSession: (id) => sessions.get(id),
  });
  return { views, sessions };
}

test('sessionList 按 startedAt 升序', () => {
  const { views } = make();
  const list = views.sessionList();
  assert.deepEqual(list.map((item) => item.sessionId), ['a', 'b']);
  assert.equal(list[0].control.mode, 'open');
});

test('runLogView 返回快照', () => {
  const { views, sessions } = make();
  const session = sessions.get('a');
  session.runLog = { snapshot: () => ({ entries: [1] }) };
  const view = views.runLogView({ session: 'a' });
  assert.equal(view.sessionId, 'a');
  assert.deepEqual(view.entries, [1]);
});
