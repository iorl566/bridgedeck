// tests/unit/session-tab-lease-wiring.test.mjs —— daemon 侧 tab 所有权租约接线：
// claimTab 互斥/回滚、session.stop 释放与晋升、session.list 透出租约快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabControls } from '../../daemon/tab-controls.js';
import { createSessionStop } from '../../daemon/session-stop.js';
import { createSessionViews } from '../../daemon/session-views.js';
import { createSessionLeases } from '../../lib/session-lease.mjs';
import { sessionPublicView } from '../../lib/session-model.mjs';

class TestBridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function controlsWithLease() {
  const sessions = new Map();
  const reservations = new Map();
  const lease = createSessionLeases();
  const controls = createTabControls({
    sessions,
    tabReservations: {
      reserve: (tabId, owner) => {
        if (reservations.has(tabId) && reservations.get(tabId) !== owner) return { ok: false, owner: reservations.get(tabId) };
        reservations.set(tabId, owner);
        return { ok: true, owner };
      },
      transfer: () => true,
      release: () => true,
    },
    tabControl: { sync: (tabId, ids, opts) => ({ tabId, ids, opts }) },
    sessionState: { phase: () => 'active' },
    CONTROL_MODES: ['open', 'exclusive'],
    BridgeError: TestBridgeError,
    saveSessions: () => {},
    lease,
  });
  return { controls, sessions, reservations, lease };
}

test('claimTab：第二个会话拿到 E_TAB_LEASE_HELD，data 带 holder/剩余租期/历史证据', () => {
  const { controls, lease } = controlsWithLease();
  assert.deepEqual(controls.claimTab(7, 's1'), { ok: true, owner: 's1' });
  assert.equal(lease.ownerOf(7), 's1');
  assert.throws(
    () => controls.claimTab(7, 's2'),
    (error) => {
      assert.equal(error.code, 'E_TAB_LEASE_HELD');
      assert.equal(error.data.conflict.holder, 's1');
      assert.equal(error.data.conflict.requestedBy, 's2');
      assert.equal(error.data.conflict.remainingMs > 0, true);
      assert.equal(Array.isArray(error.data.conflict.history), true);
      assert.equal(error.data.lease.holder, 's1');
      return true;
    },
  );
  // 同一会话重复 claim 是续租，不冲突。
  assert.doesNotThrow(() => controls.claimTab(7, 's1'));
  assert.equal(controls.tabLeaseStatus(7).holder, 's1');
});

test('claimTab：reservation 冲突时回滚刚拿到的租约（不泄漏 holder）', () => {
  const sessions = new Map();
  const lease = createSessionLeases();
  const reservations = new Map([['9', 'someone-else']]);
  const controls = createTabControls({
    sessions,
    tabReservations: {
      reserve: (tabId, owner) => (reservations.has(String(tabId)) ? { ok: false, owner: reservations.get(String(tabId)) } : { ok: true, owner }),
    },
    tabControl: { sync: () => null },
    sessionState: { phase: () => 'active' },
    CONTROL_MODES: ['open', 'exclusive'],
    BridgeError: TestBridgeError,
    saveSessions: () => {},
    lease,
  });
  assert.throws(() => controls.claimTab(9, 's9'), (error) => error.code === 'E_BORROW_CONFLICT');
  assert.equal(lease.status(9), null, 'reservation 失败后租约必须回滚');
});

function stopHarness({ requestStop = true, shared = false, holder = 's1', participant = null } = {}) {
  const calls = [];
  const sessions = new Map();
  const session = { sessionId: 's1', instanceId: 'i1', tabId: 7, borrowed: true, shared };
  sessions.set('s1', session);
  const lease = createSessionLeases();
  lease.acquire(7, holder, { reason: 'session-start' });
  if (participant) lease.join(7, participant, { reason: 'share-attach' });
  const stop = createSessionStop({
    resolveSession: () => session,
    aliases: { clear: (id) => calls.push(['alias.clear', id]) },
    tabReservations: { release: (tabId, sid) => calls.push(['release', tabId, sid]), reserve: () => {} },
    tabControls: { syncTabControl: (tabId) => calls.push(['sync', tabId]) },
    tabControl: { unregister: () => ({ promotedTo: participant }) },
    sessionState: {
      requestStop: () => requestStop,
      finish: (id) => calls.push(['finish', id]),
      fail: () => {},
    },
    sessions,
    instances: new Map([['i1', { instanceId: 'i1' }]]),
    sendCommand: async (instance, method, params) => { calls.push([method, params]); return {}; },
    sendInstanceEvent: () => {},
    saveSessions: () => {},
    sessionPublicView: () => ({}),
    log: () => {},
    logError: () => {},
    BridgeError: TestBridgeError,
    sessionQueue: { drop: (id) => calls.push(['queue.drop', id]) },
    lease,
    releaseTransfersForSession: () => {},
  });
  return { stop, session, sessions, calls, lease };
}

test('session.stop：holder 停止时释放租约并晋升共享参与者', async () => {
  const { stop, lease, sessions } = stopHarness({ participant: 's2' });
  assert.equal(lease.ownerOf(7), 's1');
  const result = await stop.stopSession({ session: 's1' }, 1000);
  assert.equal(result.ok, true);
  assert.equal(sessions.has('s1'), false);
  assert.equal(lease.ownerOf(7), 's2');
  assert.equal(lease.status(7).history.some((item) => item.type === 'handoff'), true);
});

test('session.stop：已 stopping 提前返回时也先释放租约（不留悬挂 holder）', async () => {
  const { stop, lease } = stopHarness({ requestStop: false });
  const result = await stop.stopSession({ session: 's1' }, 1000);
  assert.equal(result.alreadyStopping, true);
  assert.equal(lease.ownerOf(7), null);
});

test('session.list：会话视图透出 tab 租约快照（holder/participants/冲突证据来源）', () => {
  const sessions = new Map();
  const session = { sessionId: 's1', instanceId: 'i1', tabId: 7, startedAt: 10 };
  sessions.set('s1', session);
  const lease = createSessionLeases();
  lease.acquire(7, 's1', { reason: 'session-start' });
  lease.join(7, 's2', { reason: 'share-attach' });
  const views = createSessionViews({
    sessions,
    instances: new Map([['i1', {}]]),
    tabControl: { status: () => null, unregister: () => {} },
    sessionState: { phase: () => 'active' },
    sessionPublicView,
    isSessionExpired: () => false,
    resolveSession: () => session,
    sessionLeases: lease,
  });
  const rows = views.sessionList();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lease.holder, 's1');
  assert.equal(rows[0].lease.participantCount, 2);
  assert.equal(rows[0].lease.shared, true);
  assert.equal(rows[0].lease.history.some((item) => item.type === 'acquire'), true);
});
