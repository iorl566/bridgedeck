// tests/unit/session-tab-ownership.test.mjs —— 多会话 tab 所有权接线：
// claimTab 互斥/回滚、session.list 租约视图、session.stop 释放与 handoff、
// session.rebind 迁移、leaseOps 生命周期登记与所有权报告一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabControls } from '../../daemon/tab-controls.js';
import { createSessionStop } from '../../daemon/session-stop.js';
import { createSessionRebind } from '../../daemon/session-rebind.js';
import { createSessionViews } from '../../daemon/session-views.js';
import { createSessionLeases } from '../../lib/session-lease.mjs';
import { createLeaseOps } from '../../daemon/lease-ops.js';
import { sessionPublicView } from '../../lib/session-model.mjs';

const NOW = 1_700_000_000_000;

class TestBridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function world() {
  const sessions = new Map();
  const reservations = new Map();
  let now = NOW;
  const leases = createSessionLeases({ now: () => now, defaultTtlMs: 60_000, isSessionAlive: () => true });
  const leaseOps = createLeaseOps({ leases, sessions, now: () => now, log: () => {} });
  const tabControl = {
    sync: (tabId, ids, opts) => ({ tabId, ids, opts, mode: (opts && opts.mode) || 'open', epoch: 1, holder: ids[0] || null, primary: ids[0] || null, shared: ids.length > 1, sessionCount: ids.length, leaseRemainingMs: 60_000 }),
    unregister: () => ({ promotedTo: null }),
    status: () => null,
    attach: () => {},
    setMode: () => {},
    check: () => ({ ok: true, control: { epoch: 1, holder: null, mode: 'open' } }),
  };
  const controls = createTabControls({
    sessions,
    tabReservations: {
      reserve: (tabId, owner) => {
        if (reservations.has(tabId) && reservations.get(tabId) !== owner) return { ok: false, owner: reservations.get(tabId) };
        reservations.set(tabId, owner);
        return { ok: true, owner };
      },
      transfer: () => true,
      release: (tabId) => { reservations.delete(tabId); },
    },
    tabControl,
    sessionState: { phase: () => 'active' },
    CONTROL_MODES: ['open', 'exclusive'],
    BridgeError: TestBridgeError,
    saveSessions: () => {},
    lease: leases,
  });
  function addSession(sessionId, tabId, overrides = {}) {
    const session = { sessionId, instanceId: 'i1', tabId, windowId: 0, url: '', title: '', startedAt: now - 1_000, borrowed: true, ...overrides };
    sessions.set(sessionId, session);
    return session;
  }
  return { sessions, reservations, leases, leaseOps, controls, tabControl, addSession, clock: () => now, advance: (ms) => { now += ms; } };
}

// ---------------------------------------------------------------------------
// claimTab 互斥 / 回滚
// ---------------------------------------------------------------------------

test('claimTab：第二个会话拿到 E_TAB_LEASE_HELD 且 data.conflict 带 holder/剩余/历史', () => {
  const w = world();
  assert.deepEqual(w.controls.claimTab(7, 's1'), { ok: true, owner: 's1' });
  assert.equal(w.leases.ownerOf(7), 's1');
  assert.throws(
    () => w.controls.claimTab(7, 's2'),
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
  assert.doesNotThrow(() => w.controls.claimTab(7, 's1'));
  assert.equal(w.controls.tabLeaseStatus(7).holder, 's1');
});

test('claimTab：reservation 冲突时回滚刚拿到的租约（不泄漏 holder）', () => {
  const w = world();
  w.reservations.set(9, 'someone-else');
  assert.throws(() => w.controls.claimTab(9, 's9'), (error) => error.code === 'E_BORROW_CONFLICT');
  assert.equal(w.leases.status(9), null, 'reservation 失败后租约必须回滚');
});

// ---------------------------------------------------------------------------
// session.list 租约视图
// ---------------------------------------------------------------------------

test('session.list：透出租约快照并清理过期会话的租约', () => {
  const w = world();
  w.addSession('s1', 7, { startedAt: NOW - 10_000 });
  w.leases.acquire(7, 's1', { reason: 'session-start' });
  w.leases.join(7, 's2', { reason: 'share-attach' });
  const views = createSessionViews({
    sessions: w.sessions,
    instances: new Map([['i1', {}]]),
    tabControl: { status: () => null, unregister: () => {} },
    sessionState: { phase: () => 'active' },
    sessionPublicView,
    isSessionExpired: (session, { connected }) => !connected,
    resolveSession: (id) => w.sessions.get(id),
    sessionLeases: w.leases,
  });
  const rows = views.sessionList();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lease.holder, 's1');
  assert.equal(rows[0].lease.participantCount, 2);
  assert.equal(rows[0].lease.shared, true);
  assert.equal(rows[0].lease.history.some((item) => item.type === 'acquire'), true);
  // 浏览器断开的会话被清理时同步释放租约。
  const disconnected = createSessionViews({
    sessions: w.sessions,
    instances: new Map(),
    tabControl: { status: () => null, unregister: () => {} },
    sessionState: { phase: () => 'active' },
    sessionPublicView,
    isSessionExpired: () => true,
    resolveSession: (id) => w.sessions.get(id),
    sessionLeases: w.leases,
  });
  assert.deepEqual(disconnected.sessionList(), []);
  assert.equal(w.leases.ownerOf(7), 's2', 'holder 释放后晋升下一个参与者');
  assert.equal(w.sessions.size, 0);
});

// ---------------------------------------------------------------------------
// session.stop handoff
// ---------------------------------------------------------------------------

function stopHarness({ requestStop = true, shared = false, participant = null } = {}) {
  const w = world();
  const calls = [];
  w.addSession('s1', 7, { shared, borrowed: true });
  w.leases.acquire(7, 's1', { reason: 'session-start' });
  if (participant) w.leases.join(7, participant, { reason: 'share-attach' });
  const stop = createSessionStop({
    resolveSession: (id) => {
      const session = w.sessions.get(id);
      if (!session) throw new TestBridgeError('E_NO_SESSION', '没有会话 ' + id);
      return session;
    },
    aliases: { clear: (id) => calls.push(['alias.clear', id]) },
    tabReservations: { release: (tabId, sid) => calls.push(['release', tabId, sid]), reserve: () => {} },
    tabControls: { syncTabControl: (tabId) => calls.push(['sync', tabId]) },
    tabControl: { unregister: () => ({ promotedTo: participant }) },
    sessionState: {
      requestStop: () => requestStop,
      finish: (id) => calls.push(['finish', id]),
      fail: () => {},
    },
    sessions: w.sessions,
    instances: new Map([['i1', { instanceId: 'i1' }]]),
    sendCommand: async (instance, method, params) => { calls.push([method, params]); return {}; },
    sendInstanceEvent: () => {},
    saveSessions: () => {},
    sessionPublicView: () => ({}),
    log: () => {},
    logError: () => {},
    BridgeError: TestBridgeError,
    sessionQueue: { drop: (id) => calls.push(['queue.drop', id]) },
    lease: w.leases,
    releaseTransfersForSession: () => {},
  });
  return { stop, world: w, calls };
}

test('session.stop：holder 停止时释放租约并晋升共享参与者（lease history handoff 证据）', async () => {
  const { stop, world: w, calls } = stopHarness({ participant: 's2' });
  assert.equal(w.leases.ownerOf(7), 's1');
  const result = await stop.stopSession({ session: 's1' }, 1000);
  assert.equal(result.ok, true);
  assert.equal(w.sessions.has('s1'), false);
  assert.equal(w.leases.ownerOf(7), 's2');
  assert.equal(w.leases.status(7).history.some((item) => item.type === 'handoff'), true);
  assert.equal(calls.some(([name]) => name === 'finish'), true);
});

test('session.stop：已 stopping 提前返回时也先释放租约；leaseOps 登记停止为幂等', async () => {
  const { stop, world: w } = stopHarness({ requestStop: false });
  const result = await stop.stopSession({ session: 's1' }, 1000);
  assert.equal(result.alreadyStopping, true);
  assert.equal(w.leases.ownerOf(7), null);
  const noted = w.leaseOps.noteSessionStopped({ sessionId: 's1', tabId: 7 });
  assert.equal(noted.ok, true, '重复释放不应失败');
  assert.equal(noted.released, false);
});

// ---------------------------------------------------------------------------
// session.rebind 迁移
// ---------------------------------------------------------------------------

test('session.rebind：新 tab 拿租约、旧 tab 释放，leaseOps 记录迁移后所有权报告一致', async () => {
  const w = world();
  w.addSession('s1', 7, { borrowed: false });
  w.leases.acquire(7, 's1', { reason: 'session-start' });
  const calls = [];
  const instances = new Map([
    ['i1', { instanceId: 'i1' }],
    ['i2', { instanceId: 'i2' }],
  ]);
  const rebind = createSessionRebind({
    resolveSession: () => w.sessions.get('s1'),
    tabControls: w.controls,
    instances,
    sendCommand: async (instance, method, params) => {
      calls.push({ instanceId: instance.instanceId, method, params });
      return { windowId: 3, url: 'https://example.test/', title: 'example' };
    },
    tabReservations: { release: () => {}, reserve: () => {} },
    rebindSessionRecord: (session, record) => Object.assign(session, record),
    tabControl: { unregister: () => ({}), attach: () => {}, status: () => ({ mode: 'open' }) },
    saveSessions: () => {},
    sendInstanceEvent: () => {},
    log: () => {},
    sessionPublicView,
    sessionState: { phase: () => 'active' },
    BridgeError: TestBridgeError,
    findInstanceForTab: async () => instances.get('i2'),
    lease: w.leases,
  });
  const view = await rebind.rebindSession({ session: 's1', tab: 42 }, 1000);
  assert.equal(view.tabId, 42);
  assert.equal(w.sessions.get('s1').tabId, 42);
  assert.equal(w.leases.ownerOf(42), 's1', '新 tab 所有权已登记');
  assert.equal(w.leases.ownerOf(7), null, '旧 tab 所有权已释放');
  assert.equal(calls.some((call) => call.method === 'tab.borrow' && call.params.tabId === 42), true);
  // leaseOps 生命周期登记（daemon wrapper 会调用）后所有权报告一致。
  const noted = w.leaseOps.noteSessionRebound({ sessionId: 's1', fromTabId: 7, toTabId: 42 });
  assert.equal(noted.ok, true);
  assert.equal(w.leases.ownerOf(42), 's1');
  const report = w.leaseOps.report({ limit: 5 });
  assert.equal(report.tabs.some((row) => row.tabId === 42 && row.holder === 's1'), true);
  assert.equal(report.totals.conflicts, 0);
});

test('leaseOps 生命周期登记：启动登记 + 所有权报告 + 冲突解释', () => {
  const w = world();
  w.addSession('s1', 7);
  const started = w.leaseOps.noteSessionStarted({ sessionId: 's1', tabId: 7 });
  assert.equal(started.ok, true);
  // 第二个会话登记到同一 tab：降级为共享参与者，不抢 holder。
  w.addSession('s2', 7, { shared: true });
  const second = w.leaseOps.noteSessionStarted({ sessionId: 's2', tabId: 7, shared: true });
  assert.equal(second.ok, true);
  assert.equal(w.leases.ownerOf(7), 's1');
  const conflict = w.leaseOps.conflict(7, 's3', { reason: 'rebind' });
  assert.equal(conflict.clear, false);
  assert.equal(conflict.holder, 's1');
  assert.match(conflict.explanation, /s3/);
  const rows = w.leaseOps.ownershipMatrix().rows;
  const row = rows.find((item) => item.tabId === 7);
  assert.equal(row.holder, 's1');
  assert.equal(row.sessionCount, 2);
  assert.equal(row.participantCount, 2);
  assert.equal(row.state, 'shared');
  assert.equal(w.leaseOps.classifyStatus(7).kind, 'shared');
});
