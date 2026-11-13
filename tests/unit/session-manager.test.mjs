import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../../extension/src/session-manager/manager.js';

function harness() {
  const removed = [];
  const agentWindow = {
    async create(url, opts) { return { windowId: 10, initialTabIds: [1], incognito: opts.incognito }; },
    async ensureActiveTab() { return 2; },
    async remove(windowId) { removed.push(windowId); },
  };
  const manager = new SessionManager({ agentWindow, now: () => 100 });
  return { manager, removed };
}

test('SessionManager start registers window/ref-store/home tab', async () => {
  const { manager } = harness();
  const ctx = await manager.start('s1', { incognito: true });
  assert.equal(ctx.agentWindowId, 10);
  assert.equal(ctx.incognito, true);
  assert(ctx.agentCreatedTabs.has(2));
  assert.equal(manager.findByWindowId(10).sessionId, 's1');
  assert.equal(manager.findControllingSession(2), 's1');
  assert.equal(manager.get('missing'), null);
  await assert.rejects(() => manager.start('s1'), /already exists/);
});

test('SessionManager forgetClosedTab and releaseObservedTab', async () => {
  const { manager } = harness();
  const ctx = await manager.start('s1');
  ctx.observedTabs.add(3);
  assert.equal(manager.findControllingSession(3), 's1');
  assert.deepEqual(manager.releaseObservedTab(3), ['s1']);
  assert.equal(manager.findControllingSession(3), null);
  manager.forgetClosedTab(2);
  assert.equal(ctx.agentCreatedTabs.has(2), false);
});

test('SessionManager borrow reservation prevents cross-session borrow', async () => {
  const { manager } = harness();
  await manager.start('s1');
  await manager.start('s2');
  const reservation = manager.tryReserveBorrow(5, 's1');
  assert.equal(manager.findBorrowingSession(5, 's2'), 's1');
  const blocked = manager.tryReserveBorrow(5, 's2');
  assert.equal(blocked.borrowedBy, 's1');
  reservation.commit({ tabId: 5, originalWindowId: 1, originalIndex: 0 });
  assert.equal(manager.get('s1').borrowedTabs.has(5), true);
  assert.equal(manager.tryReserveBorrow(5, 's1').borrowedBy, 's1');
});

test('SessionManager stop removes window and session', async () => {
  const { manager, removed } = harness();
  await manager.start('s1');
  const ctx = await manager.stop('s1');
  assert.equal(ctx.sessionId, 's1');
  assert.deepEqual(removed, [10]);
  assert.equal(manager.has('s1'), false);
  assert.equal(manager.findByWindowId(10), null);
});
