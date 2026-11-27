import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerTarget } from '../../daemon/ledger-target.js';

function make() {
  const sessions = new Map([['s1', { sessionId: 's1', tabId: 7 }]]);
  return createLedgerTarget({
    resolveSession: (id) => {
      const session = sessions.get(String(id));
      if (!session) throw new Error('missing');
      return session;
    },
    EXT_METHODS: new Set(['click', 'observe']),
  });
}

test('ledgerTarget 解析会话或回退 sessionId', () => {
  const ops = make();
  assert.deepEqual(ops.ledgerTarget({ session: 's1' }), { tabId: 7, sessionId: 's1' });
  assert.deepEqual(ops.ledgerTarget({ session: 'missing' }), { tabId: null, sessionId: 'missing' });
  assert.deepEqual(ops.ledgerTarget({}), { tabId: null, sessionId: null });
});

test('ledgerTargetFromRoute 优先显式 tabId', () => {
  const ops = make();
  assert.deepEqual(ops.ledgerTargetFromRoute({ session: { sessionId: 's1', tabId: 7 }, params: { tabId: 9 } }), { tabId: 9, sessionId: 's1' });
  assert.deepEqual(ops.ledgerTargetFromRoute({ params: {} }), { tabId: null, sessionId: null });
});

test('isExtensionRouted 包含 EXT_METHODS 与 settings.get', () => {
  const ops = make();
  assert.equal(ops.isExtensionRouted('click'), true);
  assert.equal(ops.isExtensionRouted('settings.get'), true);
  assert.equal(ops.isExtensionRouted('daemon.status'), false);
});
