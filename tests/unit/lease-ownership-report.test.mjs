// tests/unit/lease-ownership-report.test.mjs —— 多会话 tab 所有权报告：
// 所有权矩阵/租约报告序列化、status 增量视图（leases）、默认载荷零变化、视图异常降级。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLeases } from '../../lib/session-lease.mjs';
import { createSessionState } from '../../lib/session-state.mjs';
import { createLeaseOps } from '../../daemon/lease-ops.js';
import { buildOwnershipMatrix, detectOwnershipConflicts, diffOwnershipMatrices, ownershipChangeOf, summarizeConflicts } from '../../daemon/lease-registry.js';
import { STATUS_VIEWS, createStatusViews, parseStatusViews } from '../../daemon/status-views.js';

const NOW = 1_700_000_000_000;

function makeWorld() {
  let now = NOW;
  const sessions = new Map();
  const state = createSessionState({ now: () => now });
  const leases = createSessionLeases({ now: () => now, defaultTtlMs: 60_000, isSessionAlive: () => true });
  const ops = createLeaseOps({ leases, sessions, sessionState: state, now: () => now, log: () => {} });
  function addSession(sessionId, tabId, overrides = {}) {
    const session = { sessionId, tabId, instanceId: 'i1', startedAt: now - 1_000, shared: false, ...overrides };
    sessions.set(sessionId, session);
    state.prepare(sessionId);
    state.begin(sessionId);
    state.activate(sessionId);
    return session;
  }
  return { sessions, state, leases, ops, addSession, advance: (ms) => { now += ms; }, clock: () => now };
}

test('所有权矩阵：独占 + 共享 tab 的 holder/participant 角色与 totals', () => {
  const world = makeWorld();
  world.addSession('s1', 7);
  world.addSession('s2', 7, { shared: true, startedAt: NOW - 500 });
  world.addSession('s3', 8);
  world.ops.acquire(7, 's1', { reason: 'session-start' });
  world.ops.join(7, 's2', { reason: 'share-attach' });
  world.ops.acquire(8, 's3', { reason: 'session-start' });
  const matrix = world.ops.ownershipMatrix();
  assert.equal(matrix.totals.tabs, 2);
  assert.equal(matrix.totals.sharedTabs, 1);
  assert.equal(matrix.totals.leasedTabs, 2);
  assert.equal(matrix.totals.sessions, 3);
  assert.equal(matrix.totals.participants, 3);
  const tab7 = matrix.rows.find((row) => row.tabId === 7);
  assert.equal(tab7.holder, 's1');
  assert.equal(tab7.state, 'shared');
  assert.equal(tab7.sessions.find((item) => item.sessionId === 's1').role, 'holder');
  assert.equal(tab7.sessions.find((item) => item.sessionId === 's2').role, 'participant');
  assert.equal(tab7.sessions.find((item) => item.sessionId === 's1').phase, 'active');
  const tab8 = matrix.rows.find((row) => row.tabId === 8);
  assert.equal(tab8.state, 'held');
  assert.equal(matrix.conflicts.length, 0, '已登记会话+租约不应产生冲突');
});

test('冲突检测：stopping 会话的 holder / 会话与租约不一致', () => {
  const world = makeWorld();
  world.addSession('s1', 9);
  world.ops.acquire(9, 's1', { reason: 'session-start' });
  world.state.requestStop('s1');
  const conflicts = detectOwnershipConflicts({
    leases: world.leases.snapshot(),
    sessions: [...world.sessions.values()],
    phases: { s1: 'stopping' },
    now: NOW,
    isAlive: () => true,
  });
  assert.equal(conflicts.some((item) => item.code === 'lease-holder-stopping'), true);
  // 会话在 tab 上但租约被别的会话持有。
  const inconsistent = detectOwnershipConflicts({
    leases: [{ tabId: 10, holder: 'owner', participants: [{ sessionId: 'owner' }], participantCount: 1, expiresAt: NOW + 1_000, ttlMs: 60_000, epoch: 1 }],
    sessions: [{ sessionId: 'other', tabId: 10, startedAt: NOW - 1 }],
    phases: {},
    now: NOW,
    isAlive: () => true,
  });
  assert.equal(inconsistent.some((item) => item.code === 'session-not-participant'), true);
  const summary = summarizeConflicts(conflicts);
  assert.equal(summary.total >= 1, true);
});

test('leaseOps.report：可 JSON 序列化，含 tabsReclaimRenewalsCounters', () => {
  const world = makeWorld();
  world.addSession('s1', 11);
  world.ops.acquire(11, 's1', { reason: 'session-start' });
  const report = world.ops.report({ limit: 10 });
  assert.equal(report.kind, 'bridge/tab-ownership');
  assert.equal(report.tabsTotal, 1);
  assert.equal(report.reclaim.dryRun, true);
  assert.equal(report.renewals.withinMs > 0, true);
  assert.equal(report.reconcile.stats.sessions, 1);
  assert.equal(typeof report.counters.acquire, 'number');
  assert.equal(report.sweeper.running, false);
  const json = JSON.stringify(report);
  assert.equal(typeof json, 'string');
  const parsed = JSON.parse(json);
  assert.equal(parsed.tabs[0].tabId, 11);
  assert.equal(parsed.tabs[0].holder, 's1');
  assert.equal(parsed.reclaim.skipped.length >= 0, true);
});

test('leaseOps.report 截断：limit 限制 tabs/conflicts/evidence，并标记截断', () => {
  const world = makeWorld();
  for (let index = 0; index < 5; index += 1) {
    const tabId = 100 + index;
    world.addSession('s' + tabId, tabId);
    world.ops.acquire(tabId, 's' + tabId, { reason: 'session-start' });
  }
  const report = world.ops.report({ limit: 2 });
  assert.equal(report.tabsTotal, 5);
  assert.equal(report.tabs.length, 2);
  assert.equal(report.tabsTruncated, true);
  assert.equal(report.conflictsTruncated, false);
});

// ---------------------------------------------------------------------------
// status 增量视图
// ---------------------------------------------------------------------------

function baseStatus() {
  return {
    service: 'browser-bridge',
    version: '0.3.0',
    protocol: '1.9',
    pid: 1,
    port: 52900,
    uptimeMs: 1,
    browsers: [],
    sessions: [],
    inflight: [],
    queues: [],
    auth: { tracked: 0, blocked: [] },
    recovery: { at: 1 },
    compatibility: {},
  };
}

test('status 默认载荷：未请求视图时既无 leases 也无 boundary 字段', () => {
  const world = makeWorld();
  world.addSession('s1', 1);
  world.ops.acquire(1, 's1', { reason: 'session-start' });
  const views = createStatusViews({ baseStatus, leaseOps: world.ops, commandBoundary: null });
  const plain = views.buildStatus({});
  assert.deepEqual(plain, baseStatus());
  assert.equal(Object.prototype.hasOwnProperty.call(plain, 'leases'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(plain, 'boundary'), false);
  // 只请求 limit 不触发视图。
  assert.deepEqual(views.buildStatus({ limit: 5 }), baseStatus());
});

test('status views=leases：追加真实所有权报告；视图异常降级不炸 status', () => {
  const world = makeWorld();
  world.addSession('s1', 2);
  world.ops.acquire(2, 's1', { reason: 'session-start' });
  const views = createStatusViews({ baseStatus, leaseOps: world.ops });
  const result = views.buildStatus({ views: ['leases'], limit: 3 });
  assert.deepEqual(result.views, ['leases']);
  assert.equal(result.leases.kind, 'bridge/tab-ownership');
  assert.equal(result.leases.tabs[0].tabId, 2);
  assert.equal(result.service, 'browser-bridge');
  // 异常视图降级。
  const broken = createStatusViews({
    baseStatus,
    leaseOps: { report: () => { throw Object.assign(new Error('lease boom'), { code: 'E_INTERNAL' }); } },
  });
  const degraded = broken.buildStatus({ views: ['leases'] });
  assert.equal(degraded.leases.ok, false);
  assert.equal(degraded.leases.error, 'E_INTERNAL');
  assert.equal(degraded.service, 'browser-bridge');
});

test('status views=all：leases 视图包含在 STATUS_VIEWS 里，且缺数据源时字段不出现', () => {
  const world = makeWorld();
  world.addSession('s1', 3);
  world.ops.acquire(3, 's1', { reason: 'session-start' });
  const views = createStatusViews({ baseStatus, leaseOps: world.ops });
  assert.equal(STATUS_VIEWS.includes('leases'), true);
  assert.equal(STATUS_VIEWS.includes('boundary'), true);
  const all = views.buildStatus({ views: 'all' });
  assert.deepEqual(all.views, STATUS_VIEWS);
  assert.ok(all.leases);
  assert.equal(all.boundary, undefined, '未注入 boundary 时字段不出现');
  const parsed = parseStatusViews({ views: ['leases', 'nope'] });
  assert.deepEqual(parsed.views, ['leases']);
  assert.deepEqual(parsed.unknown, ['nope']);
});

test('status 增量视图只增不减：keys = base keys + leases + views', () => {
  const world = makeWorld();
  world.addSession('s1', 4);
  world.ops.acquire(4, 's1', { reason: 'session-start' });
  const views = createStatusViews({ baseStatus, leaseOps: world.ops });
  const base = baseStatus();
  const result = views.buildStatus({ views: ['leases'] });
  const baseKeys = Object.keys(base);
  for (const key of baseKeys) assert.equal(Object.prototype.hasOwnProperty.call(result, key), true, '基础字段不能丢: ' + key);
  const added = Object.keys(result).filter((key) => !baseKeys.includes(key)).sort();
  assert.deepEqual(added, ['leases', 'views']);
  // 同一引用语义：默认路径不拷贝、不计算。
  const plain = views.buildStatus({});
  assert.deepEqual(plain, base);
});

test('status views 顺序保留调用方顺序且去重（leases/boundary 组合）', () => {
  const world = makeWorld();
  world.addSession('s1', 5);
  world.ops.acquire(5, 's1', { reason: 'session-start' });
  const views = createStatusViews({ baseStatus, leaseOps: world.ops });
  const combined = views.buildStatus({ views: ['leases', 'leases'], limit: 1 });
  assert.deepEqual(combined.views, ['leases']);
  assert.equal(combined.leases.tabs.length, 1);
  assert.equal(combined.leases.tabsTotal, 1);
  // 空数组请求：不追加任何字段。
  assert.deepEqual(views.buildStatus({ views: [] }), baseStatus());
  // boundary 视图在没有数据源时不出现，但 views 标记仍回显请求。
  const missing = views.buildStatus({ views: ['boundary'] });
  assert.equal(missing.boundary, undefined);
  assert.deepEqual(missing.views, ['boundary']);
});

// ---------------------------------------------------------------------------
// 所有权变化（diff）
// ---------------------------------------------------------------------------

test('ownershipChangeOf：added/removed/holder-changed/sessions-changed/null', () => {
  const row = (overrides = {}) => ({ tabId: 1, holder: 's1', epoch: 1, sessionCount: 1, participantCount: 1, acquiredAt: 100, ...overrides });
  assert.equal(ownershipChangeOf(null, null), null);
  assert.deepEqual(ownershipChangeOf(null, row()), { type: 'added', tabId: 1, holder: 's1', epoch: 1, sessionCount: 1, at: 100 });
  assert.deepEqual(ownershipChangeOf(row(), null), { type: 'removed', tabId: 1, holder: 's1', epoch: 1, sessionCount: 1 });
  assert.deepEqual(
    ownershipChangeOf(row(), row({ holder: 's2', epoch: 2 })),
    { type: 'holder-changed', tabId: 1, from: 's1', to: 's2', fromEpoch: 1, toEpoch: 2, sessionCount: 1 },
  );
  assert.deepEqual(
    ownershipChangeOf(row(), row({ sessionCount: 2, participantCount: 2 })),
    { type: 'sessions-changed', tabId: 1, holder: 's1', fromSessions: 1, toSessions: 2, fromParticipants: 1, toParticipants: 2 },
  );
  assert.equal(ownershipChangeOf(row(), row()), null);
});

test('diffOwnershipMatrices：按 tab 汇总 added/removed/holder-changed/sessions-changed', () => {
  const make = (rows) => ({ rows, totals: { tabs: rows.length } });
  const previous = make([
    { tabId: 1, holder: 's1', epoch: 1, sessionCount: 1, participantCount: 1 },
    { tabId: 2, holder: 's2', epoch: 1, sessionCount: 1, participantCount: 1 },
    { tabId: 3, holder: 's3', epoch: 1, sessionCount: 1, participantCount: 1 },
  ]);
  const current = make([
    { tabId: 1, holder: 's9', epoch: 2, sessionCount: 1, participantCount: 1 },
    { tabId: 2, holder: 's2', epoch: 1, sessionCount: 2, participantCount: 2 },
    { tabId: 4, holder: 's4', epoch: 1, sessionCount: 1, participantCount: 1 },
    { tabId: 5, holder: null, epoch: 0, sessionCount: 0, participantCount: 0 },
  ]);
  const diff = diffOwnershipMatrices(previous, current, { now: NOW });
  assert.equal(diff.firstReport, false);
  assert.equal(diff.changed, true);
  assert.equal(diff.unchanged, false);
  assert.deepEqual(diff.counts, { added: 2, removed: 1, holderChanged: 1, sessionsChanged: 1 });
  assert.deepEqual(diff.changes.map((item) => item.tabId), [1, 2, 3, 4, 5]);
  const first = diffOwnershipMatrices(null, current, { now: NOW });
  assert.equal(first.firstReport, true);
  assert.equal(first.counts.added, 4);
  const same = diffOwnershipMatrices(current, current, { now: NOW });
  assert.equal(same.unchanged, true);
  assert.deepEqual(same.changes, []);
});

test('leaseOps.report.changes：跨报告记录 holder 变更/移除/参与者变化', () => {
  const world = makeWorld();
  world.addSession('s1', 6);
  world.ops.acquire(6, 's1', { reason: 'session-start' });
  const first = world.ops.report({ limit: 5 });
  assert.equal(first.changes.firstReport, true);
  assert.equal(first.changes.counts.added, 1);
  assert.equal(first.changes.changes[0].holder, 's1');
  // 同一状态再报告：无变化。
  const second = world.ops.report({ limit: 5 });
  assert.equal(second.changes.unchanged, true);
  // 加入共享参与者 → sessions-changed。
  world.addSession('s2', 6, { shared: true });
  world.ops.join(6, 's2', { reason: 'share-attach' });
  const third = world.ops.report({ limit: 5 });
  assert.equal(third.changes.counts.sessionsChanged, 1);
  // holder 变更（release 晋升）→ holder-changed。
  world.ops.release(6, 's1', { reason: 'session-stop' });
  const fourth = world.ops.report({ limit: 5 });
  assert.equal(fourth.changes.counts.holderChanged, 1);
  const change = fourth.changes.changes.find((item) => item.type === 'holder-changed');
  assert.equal(change.from, 's1');
  assert.equal(change.to, 's2');
  // 释放最后一个会话（并从会话表移除）→ tab 行消失 → removed。
  world.ops.release(6, 's2', { reason: 'session-stop' });
  world.sessions.delete('s1');
  world.sessions.delete('s2');
  const fifth = world.ops.report({ limit: 5 });
  assert.equal(fifth.changes.counts.removed, 1);
  // reset 清空跨报告基线：下一次视为首份报告。
  world.ops.reset();
  world.ops.acquire(6, 's1', { reason: 'session-start' });
  const afterReset = world.ops.report({ limit: 5 });
  assert.equal(afterReset.changes.firstReport, true);
});
