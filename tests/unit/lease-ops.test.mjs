// tests/unit/lease-ops.test.mjs —— daemon 侧多会话租约运行时服务：
// 冲突证据、续租/touch、会话生命周期登记、过期回收、批量续租、对账、报告与证据环。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLeases } from '../../lib/session-lease.mjs';
import { createLeaseOps } from '../../daemon/lease-ops.js';

const NOW = 1_700_000_000_000;

function harness({ ttlMs = 60_000, sessions = [], evidenceLimit = 50 } = {}) {
  let now = NOW;
  const sessionMap = new Map();
  for (const session of sessions) sessionMap.set(session.sessionId, session);
  const leases = createSessionLeases({
    now: () => now,
    defaultTtlMs: ttlMs,
    // lib 层 takeover 只在 isSessionAlive=false 时发生；本测试聚焦 lease-ops 自己的
    // 会话集合判定（由 ops 注入 isAlive），因此 lib 层一律视为存活。
    isSessionAlive: () => true,
  });
  const ops = createLeaseOps({
    leases,
    sessions: sessionMap,
    now: () => now,
    defaultTtlMs: ttlMs,
    log: () => {},
    evidenceLimit,
    recordTouches: true,
  });
  return {
    ops,
    leases,
    sessions: sessionMap,
    advance: (ms) => { now += ms; return now; },
    clock: () => now,
  };
}

function sessionFixture(sessionId, tabId, overrides = {}) {
  return { sessionId, tabId, instanceId: 'i1', startedAt: NOW - 5_000, shared: false, borrowed: false, ...overrides };
}

// ---------------------------------------------------------------------------
// 构造与基础操作
// ---------------------------------------------------------------------------

test('createLeaseOps：缺少 lease 实例快速失败；ttl 有上下限钳制', () => {
  assert.throws(() => createLeaseOps({}), /session lease/);
  assert.throws(() => createLeaseOps({ leases: {} }), /session lease/);
  const leases = createSessionLeases();
  const low = createLeaseOps({ leases, defaultTtlMs: 5 });
  assert.equal(low.ttlMs, 1_000);
  const high = createLeaseOps({ leases, defaultTtlMs: 99_999_999 });
  assert.equal(high.ttlMs, 600_000);
});

test('acquire/join：成功进证据环，冲突返回 holder 证据并计数，不抛错', () => {
  const { ops, sessions } = harness();
  const first = ops.acquire(7, 's1', { reason: 'session-start' });
  assert.equal(first.ok, true);
  assert.equal(first.lease.holder, 's1');
  const second = ops.acquire(7, 's2', { reason: 'rebind' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E_TAB_LEASE_HELD');
  assert.equal(second.conflict.holder, 's1');
  assert.equal(second.conflict.requestedBy, 's2');
  const stats = ops.stats();
  assert.equal(stats.counters.acquire, 1);
  assert.equal(stats.counters.conflict, 1);
  const evidence = ops.evidence({ limit: 10 });
  assert.equal(evidence.some((item) => item.type === 'acquire' && item.tabId === 7), true);
  assert.equal(evidence.some((item) => item.type === 'conflict'), true);
  // join：共享登记只加参与者。
  sessions.set('s1', sessionFixture('s1', 7));
  const joined = ops.join(7, 's2', { reason: 'share-attach' });
  assert.equal(joined.ok, true);
  assert.equal(joined.shared, true);
  assert.equal(ops.status(7).participantCount, 2);
  // 坏参数返回 E_BAD_ARG，不抛错。
  assert.equal(ops.acquire('x', 's1').code, 'E_BAD_ARG');
  assert.equal(ops.join(7, '').code, 'E_BAD_ARG');
});

test('renew/transfer/release：非 holder 拒绝、force 需要 by、重复 release 幂等', () => {
  const { ops, leases, sessions } = harness();
  ops.acquire(1, 's1', { reason: 'session-start' });
  const denied = ops.renew(1, 's2', { reason: 'touch' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'E_TAB_LEASE_NOT_HELD');
  assert.equal(ops.renew(99, 's2').conflict.reason, 'no-lease');
  // transfer 需要 from 是 holder。
  assert.equal(ops.transfer(1, 's2', 's3'), false);
  assert.equal(ops.transfer(1, 's1', 's2', { reason: 'handoff' }), true);
  assert.equal(leases.ownerOf(1), 's2');
  // 参与者加入后非参与者 release 被拒；force 必须显式 by。
  sessions.set('s1', sessionFixture('s1', 1));
  sessions.set('s2', sessionFixture('s2', 1));
  ops.join(1, 's1', { reason: 'share-attach' });
  const noBy = ops.release(1, 's3', { reason: 'cleanup', force: true });
  assert.equal(noBy.ok, false);
  assert.equal(noBy.code, 'E_BAD_ARG');
  const forced = ops.release(1, 's3', { reason: 'operator-unlock', force: true, by: 'admin' });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(forced.evidence.by, 'admin');
  // 重复释放（租约已不存在）返回 no-lease 证据。
  const again = ops.release(99, 's2', { reason: 'cleanup' });
  assert.equal(again.ok, true);
  assert.equal(again.reason, 'no-lease');
  assert.equal(ops.evidence({ limit: 50 }).some((item) => item.type === 'release'), true);
});

test('conflict()：空闲 clear=true；占用带解释/历史；坏 tab 不抛错', () => {
  const { ops, leases } = harness();
  const clear = ops.conflict(7, 's1');
  assert.equal(clear.clear, true);
  leases.acquire(7, 's1', { reason: 'session-start' });
  const busy = ops.conflict(7, 's2', { reason: 'rebind' });
  assert.equal(busy.clear, false);
  assert.equal(busy.holder, 's1');
  assert.equal(busy.requestedBy, 's2');
  assert.equal(Array.isArray(busy.history), true);
  assert.match(busy.explanation, /tab 7/);
  assert.equal(ops.conflict('x', 's1').clear, true);
});

// ---------------------------------------------------------------------------
// touch：命令派发前续租
// ---------------------------------------------------------------------------

test('touch：剩余充足跳过；剩余不足一半或过期时原地续租（不换代）', () => {
  const { ops, sessions, advance } = harness();
  sessions.set('s1', sessionFixture('s1', 3));
  ops.acquire(3, 's1', { reason: 'session-start' });
  const epoch = ops.status(3).epoch;
  const fresh = ops.touch(3, 's1');
  assert.equal(fresh.ok, true);
  assert.equal(fresh.renewed, false);
  assert.equal(fresh.skipped, 'fresh');
  // 剩余 20s（< 一半）→ 续租。
  advance(40_000);
  const renewed = ops.touch(3, 's1');
  assert.equal(renewed.ok, true);
  assert.equal(renewed.renewed, true);
  assert.equal(ops.status(3).epoch, epoch, 'touch 不换代');
  assert.equal(renewed.remainingMs > 30_000, true);
  // 非 holder：静默失败但保留原因（此处 holder 仍是 s1）。
  const notHolder = ops.touch(3, 's2');
  assert.equal(notHolder.ok, false);
  assert.equal(notHolder.silent, true);
  assert.equal(notHolder.reason, 'not-holder');
  // 过期后 lib 的 settle 会清空唯一 holder 的租约；touch 返回 no-holder 证据，不抛错。
  advance(70_000);
  const expiredTouch = ops.touch(3, 's1');
  assert.equal(expiredTouch.ok, false);
  assert.equal(expiredTouch.reason, 'no-holder');
  assert.equal(ops.status(3).holder, null);
  const noLease = ops.touch(99, 's1');
  assert.equal(noLease.ok, false);
  assert.equal(noLease.reason, 'no-holder');
  assert.equal(ops.touch('x', 's1').code, 'E_BAD_ARG');
  assert.equal(ops.evidence({ type: 'touch' }).length >= 1, true);
});

// ---------------------------------------------------------------------------
// 会话生命周期登记
// ---------------------------------------------------------------------------

test('noteSessionStarted：新会话直接 acquire；已有 holder 时降级 join 不抢所有权', () => {
  const { ops, leases } = harness();
  const newly = ops.noteSessionStarted({ sessionId: 's1', tabId: 1, shared: false });
  assert.equal(newly.ok, true);
  assert.equal(leases.ownerOf(1), 's1');
  const second = ops.noteSessionStarted({ sessionId: 's2', tabId: 1, shared: false });
  assert.equal(second.ok, true);
  assert.equal(second.adopted, true);
  assert.equal(second.takeoverSkipped, true);
  assert.equal(leases.ownerOf(1), 's1', '已有 holder 不被抢占');
  assert.equal(leases.participants(1).length, 2);
  // 显式 shared：join。
  const shared = ops.noteSessionStarted({ sessionId: 's3', tabId: 2, shared: true });
  assert.equal(shared.ok, true);
  assert.equal(leases.ownerOf(2), 's3');
  assert.equal(ops.noteSessionStarted({}).code, 'E_BAD_ARG');
});

test('noteSessionStopped / noteSessionRebound：释放并晋升、迁移所有权', () => {
  const { ops, leases, sessions } = harness();
  sessions.set('s1', sessionFixture('s1', 5));
  sessions.set('s2', sessionFixture('s2', 5, { startedAt: NOW - 1_000 }));
  ops.acquire(5, 's1', { reason: 'session-start' });
  ops.join(5, 's2', { reason: 'share-attach' });
  const stopped = ops.noteSessionStopped({ sessionId: 's1', tabId: 5 });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.released, true);
  assert.equal(stopped.promotedTo, 's2');
  assert.equal(leases.ownerOf(5), 's2');
  assert.equal(ops.noteSessionStopped({ sessionId: 's1', tabId: 5 }).ok, true, '重复停止幂等');
  assert.equal(ops.noteSessionStopped({}).code, 'E_BAD_ARG');
  // 重绑：旧 tab 释放、新 tab 获取。
  sessions.set('s2', sessionFixture('s2', 5));
  const rebound = ops.noteSessionRebound({ sessionId: 's2', fromTabId: 5, toTabId: 6 });
  assert.equal(rebound.ok, true);
  assert.equal(rebound.released, true);
  assert.equal(rebound.acquired, true);
  assert.equal(leases.ownerOf(5), null);
  assert.equal(leases.ownerOf(6), 's2');
  // 新 tab 已有 holder：降级 join。
  leases.acquire(7, 's9', { reason: 'session-start' });
  const joinedRebind = ops.noteSessionRebound({ sessionId: 's2', fromTabId: 6, toTabId: 7 });
  assert.equal(joinedRebind.ok, true);
  assert.equal(joinedRebind.joined, true);
  assert.equal(leases.ownerOf(7), 's9');
});

// ---------------------------------------------------------------------------
// 过期回收 / 续租 / 对账
// ---------------------------------------------------------------------------

test('sweep：dryRun 只出计划；执行时回收失联 holder 并晋升存活参与者', () => {
  const { ops, leases, sessions, advance } = harness();
  sessions.set('alive', sessionFixture('alive', 9));
  leases.acquire(9, 'dead', { reason: 'session-start' });
  leases.join(9, 'alive', { reason: 'share-attach' });
  advance(10_000);
  const dry = ops.sweep({ dryRun: true });
  assert.equal(dry.plan.reclaim.length, 1);
  assert.equal(dry.applied.released, 0);
  assert.equal(leases.ownerOf(9), 'dead', 'dryRun 不改租约');
  const applied = ops.sweep();
  assert.equal(applied.plan.reclaim.length, 1);
  assert.equal(applied.applied.released, 1);
  assert.equal(applied.applied.promoted, 1);
  assert.equal(leases.ownerOf(9), 'alive');
  assert.equal(ops.evidence({ type: 'reap' }).length >= 1, true);
  // 没有可回收项时 sweep 幂等。
  const clean = ops.sweep();
  assert.equal(clean.plan.reclaim.length, 0);
  assert.equal(clean.applied.released, 0);
});

test('sweep：失联 holder 默认回收；存活 holder 过期默认不回收，显式才回收', () => {
  const { ops, leases, sessions, advance } = harness();
  leases.acquire(11, 'ghost', { reason: 'session-start' });
  advance(1_000);
  // ghost 不在 sessions → 崩溃残留，回收。
  const recovered = ops.sweep();
  assert.equal(recovered.applied.released, 1);
  assert.equal(leases.status(11), null);
  // 存活 holder 的 TTL 过期：lib 的 settle 会清空唯一 holder（没有参与者可晋升），
  // 因此 sweep 看到的是"无 holder + 存活参与者"，既不出回收计划也不误删。
  sessions.set('live', sessionFixture('live', 12));
  ops.acquire(12, 'live', { reason: 'session-start', ttlMs: 1_000 });
  advance(2_000);
  const conservative = ops.sweep();
  assert.equal(conservative.plan.reclaim.length, 0);
  assert.equal(leases.ownerOf(12), null);
  assert.equal(ops.status(12).participantCount, 1, '参与者保留，不会被误清理');
  // 显式 reclaimAliveExpired 对已清空 holder 的租约也不会误删存活参与者。
  const forced = ops.sweep({ reclaimAliveExpired: true });
  assert.equal(forced.applied.released, 0);
  assert.equal(leases.participants(12).length, 1);
});

test('renewDue：批量续租到期候选；dryRun 只出计划', () => {
  const { ops, leases, sessions, advance } = harness();
  sessions.set('s1', sessionFixture('s1', 20));
  sessions.set('s2', sessionFixture('s2', 21));
  leases.acquire(20, 's1', { reason: 'session-start', ttlMs: 60_000 });
  leases.acquire(21, 's2', { reason: 'session-start', ttlMs: 60_000 });
  advance(50_000);
  const dry = ops.renewDue({ withinMs: 15_000, dryRun: true });
  assert.equal(dry.due.length, 2);
  assert.equal(dry.applied.renewed, 0);
  const applied = ops.renewDue({ withinMs: 15_000 });
  assert.equal(applied.applied.renewed, 2);
  assert.equal(applied.applied.failed, 0);
  const after = ops.renewDue({ withinMs: 15_000, dryRun: true });
  assert.equal(after.due.length, 0);
  assert.equal(ops.stats().counters.renew >= 2, true);
});

test('reconcile：默认只出计划；apply 时补登（无 holder acquire，有 holder join，不抢活 holder）', () => {
  const { ops, leases, sessions } = harness();
  sessions.set('s1', sessionFixture('s1', 30));
  sessions.set('s2', sessionFixture('s2', 30));
  leases.acquire(30, 's1', { reason: 'session-start' });
  const plan = ops.reconcile();
  assert.equal(plan.plan.adopt.length, 1);
  assert.equal(plan.plan.adopt[0].action, 'join');
  assert.equal(plan.applied.joined, 0, '默认不应用');
  const applied = ops.reconcile({ apply: true });
  assert.equal(applied.applied.joined, 1);
  assert.equal(leases.participants(30).length, 2);
  assert.equal(leases.ownerOf(30), 's1');
  // 无租约的会话：apply 时 acquire。
  sessions.set('s3', sessionFixture('s3', 31));
  const adopted = ops.reconcile({ apply: true });
  assert.equal(adopted.applied.adopted, 1);
  assert.equal(leases.ownerOf(31), 's3');
  assert.equal(ops.evidence({ type: 'recover' }).length >= 2, true);
});

// ---------------------------------------------------------------------------
// 报告 / 视图 / 计数器
// ---------------------------------------------------------------------------

test('report / ownershipOf / ownershipMatrix / classifyStatus：所有权证据与冲突计数', () => {
  const { ops, leases, sessions } = harness();
  sessions.set('s1', sessionFixture('s1', 40));
  ops.acquire(40, 's1', { reason: 'session-start' });
  sessions.set('s2', sessionFixture('s2', 41));
  // s2 在 tab 41 上没有租约 → 冲突（session-without-lease）。
  const row = ops.ownershipOf(40);
  assert.equal(row.tabId, 40);
  assert.equal(row.holder, 's1');
  assert.equal(row.sessionCount, 1);
  const matrix = ops.ownershipMatrix();
  assert.equal(matrix.totals.tabs, 2);
  assert.equal(matrix.totals.conflicts >= 1, true);
  const report = ops.report({ limit: 5 });
  assert.equal(report.kind, 'bridge/tab-ownership');
  assert.equal(report.tabsTotal, 2);
  assert.equal(report.reclaim.dryRun, true);
  assert.equal(report.renewals.stats.scanned >= 1, true);
  assert.equal(report.reconcile.stats.adopt, 1);
  assert.equal(report.counters.acquire, 1);
  assert.equal(report.sweeper.running, false);
  assert.equal(Array.isArray(report.evidence), true);
  const classified = ops.classifyStatus(40);
  assert.equal(classified.kind, 'held');
  assert.equal(ops.classifyStatus(999), null);
  const conflicts = ops.summarizeConflicts();
  assert.equal(conflicts.total >= 1, true);
  assert.equal(ops.describeConflict({ tabId: 40, holder: 's1' }).includes('tab 40'), true);
});

test('evidence 过滤：按 tab/type/limit；reset 清空计数器与证据', () => {
  const { ops } = harness({ evidenceLimit: 5 });
  ops.acquire(1, 's1');
  ops.acquire(1, 's2'); // conflict
  ops.acquire(2, 's1');
  assert.equal(ops.evidence({ tabId: 1 }).every((item) => item.tabId === 1), true);
  assert.equal(ops.evidence({ type: 'conflict' }).every((item) => item.type === 'conflict'), true);
  assert.equal(ops.evidence({ limit: 1 }).length, 1);
  // 环容量 5：写入 10 条以上后最多保留 5 条。
  for (let index = 0; index < 10; index += 1) ops.conflict(3 + index, 's1');
  assert.equal(ops.evidence({ limit: 100 }).length <= 5, true);
  const reset = ops.reset();
  assert.equal(reset.counters.acquire, 0);
  assert.equal(reset.evidenceSize, 0);
  assert.equal(ops.evidence({ limit: 10 }).length, 0);
});

test('startSweeper / stopSweeper：幂等启停与状态快照', () => {
  const { ops } = harness();
  const started = ops.startSweeper({ intervalMs: 250 });
  assert.equal(started.running, true);
  assert.equal(started.intervalMs, 250);
  const again = ops.startSweeper();
  assert.equal(again.running, true);
  assert.equal(again.intervalMs, 250);
  const stopped = ops.stopSweeper();
  assert.equal(stopped.running, false);
  const stats = ops.stats();
  assert.equal(stats.sweeper.running, false);
  assert.equal(typeof stats.evidenceSize, 'number');
});

test('recordRecovery：启动对账证据写入 recover 事件', () => {
  const { ops } = harness();
  ops.recordRecovery({ adopt: [{ tabId: 1 }], conflicts: [], releaseOrphans: [] });
  const recorded = ops.evidence({ type: 'recover' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].op, 'startup');
  assert.equal(recorded[0].adopt, 1);
});
