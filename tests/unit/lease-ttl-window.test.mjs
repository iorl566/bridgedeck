// tests/unit/lease-ttl-window.test.mjs —— 租约 TTL 窗口/续租抽样/证据形状的边界矩阵：
// 分桶边界、touch 抽样（recordTouches=false）、renewDue 窗口边界、report 截断与证据字段。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLeases } from '../../lib/session-lease.mjs';
import { createLeaseOps } from '../../daemon/lease-ops.js';
import { ttlBucketOf } from '../../daemon/lease-registry.js';

const NOW = 1_700_000_000_000;

function harness(options = {}) {
  let now = NOW;
  const sessions = new Map();
  const leases = createSessionLeases({ now: () => now, defaultTtlMs: 60_000, isSessionAlive: () => true });
  const ops = createLeaseOps({ leases, sessions, now: () => now, log: () => {}, ...options });
  sessions.set('s1', { sessionId: 's1', tabId: 1, startedAt: now - 1_000 });
  return { ops, leases, sessions, advance: (ms) => { now += ms; }, clock: () => now };
}

test('ttlBucketOf 边界：fresh/aging/expiring/expired 与 0 TTL', () => {
  assert.equal(ttlBucketOf(60_000, 60_000), 'fresh');
  assert.equal(ttlBucketOf(45_000, 60_000), 'fresh');
  assert.equal(ttlBucketOf(44_999, 60_000), 'aging');
  assert.equal(ttlBucketOf(30_000, 60_000), 'aging');
  assert.equal(ttlBucketOf(29_999, 60_000), 'expiring');
  assert.equal(ttlBucketOf(1, 60_000), 'expiring');
  assert.equal(ttlBucketOf(0, 60_000), 'expired');
  assert.equal(ttlBucketOf(10_000, 0), 'expiring');
  assert.equal(ttlBucketOf(-1, 0), 'expired');
});

test('acquire 的 ttlMs 按 lib 上下限钳制（1s~10min），并进入状态视图', () => {
  const { ops, leases } = harness();
  const low = ops.acquire(1, 's1', { reason: 'session-start', ttlMs: 5 });
  assert.equal(low.ok, true);
  assert.equal(leases.status(1).ttlMs, 1_000);
  const high = ops.acquire(2, 's1', { reason: 'session-start', ttlMs: 99_999_999 });
  assert.equal(leases.status(2).ttlMs, 600_000);
  // 不传 ttl 用 ops 默认 60s。
  ops.acquire(3, 's1', { reason: 'session-start' });
  assert.equal(leases.status(3).ttlMs, 60_000);
  // 视图里的 ttlBucket 随剩余时间演进。
  const fresh = ops.snapshot().find((row) => row.tabId === 3);
  assert.equal(fresh.ttlBucket, 'fresh');
  assert.equal(fresh.remainingMs, 60_000);
});

test('touch 抽样：recordTouches=false 时按 touchSampleEvery 采样，仍会真实续租', () => {
  const { ops, leases, advance } = harness({ recordTouches: false, touchSampleEvery: 3 });
  ops.acquire(1, 's1', { reason: 'session-start' });
  let renewedCount = 0;
  for (let round = 0; round < 6; round += 1) {
    advance(35_000);
    const result = ops.touch(1, 's1', { reason: 'command' });
    assert.equal(result.ok, true);
    if (result.renewed) renewedCount += 1;
    assert.equal(leases.status(1).epoch, 1, 'touch 不换代');
  }
  assert.equal(renewedCount, 6, '每一轮都应真正续租（剩余 < 一半）');
  const touches = ops.evidence({ type: 'touch' });
  // 第 1、4 次 touch 采样（touchCount%3===1），其余不写事件。
  assert.equal(touches.length, 2);
  assert.equal(touches.every((item) => item.tabId === 1), true);
  assert.equal(typeof touches[0].remainingBeforeMs, 'number');
});

test('recordTouches=true 时逐条记录 touch 事件', () => {
  const { ops, advance } = harness({ recordTouches: true });
  ops.acquire(1, 's1', { reason: 'session-start' });
  advance(40_000);
  ops.touch(1, 's1', { reason: 'command' });
  advance(40_000);
  ops.touch(1, 's1', { reason: 'command' });
  const touches = ops.evidence({ type: 'touch' });
  assert.equal(touches.length, 2);
  assert.equal(touches[0].seq < touches[1].seq, true);
  assert.equal(touches[0].at <= touches[1].at, true);
});

test('renewDue 窗口边界：withinMs=0 只续过期项；边界上的剩余时间进入 due', () => {
  const { ops, leases, advance } = harness();
  ops.acquire(1, 's1', { reason: 'session-start', ttlMs: 60_000 });
  ops.acquire(2, 's1', { reason: 'session-start', ttlMs: 60_000 });
  advance(49_000); // 剩余 11s
  const zeroWindow = ops.renewDue({ withinMs: 0, dryRun: true });
  assert.equal(zeroWindow.due.length, 0, '未过期且窗口 0 时不续租');
  const wide = ops.renewDue({ withinMs: 12_000, dryRun: true });
  assert.deepEqual(wide.due.map((item) => item.tabId).sort(), [1, 2]);
  assert.equal(wide.due.every((item) => item.reason === 'due'), true);
  // 边界：剩余正好等于窗口 → due。
  advance(1_000); // 剩余 10s
  const exact = ops.renewDue({ withinMs: 10_000, dryRun: true });
  assert.equal(exact.due.length, 2);
  // 已过期：reason=expired（lib settle 前 ops 的 status 会先 settle 清 holder，
  // 因此这里用活跃持有者保证仍可见）。
  const applied = ops.renewDue({ withinMs: 15_000 });
  assert.equal(applied.applied.renewed, 2);
  assert.equal(leases.status(1).epoch, 1);
});

test('report：includeEvidence=false 时不带证据；limit 截断 skipped；counters 含 touchTotal', () => {
  const { ops, advance } = harness();
  ops.acquire(1, 's1', { reason: 'session-start' });
  ops.acquire(2, 's1', { reason: 'session-start' });
  advance(10_000);
  const report = ops.report({ limit: 1, includeEvidence: false });
  assert.deepEqual(report.evidence, []);
  assert.equal(report.tabs.length, 1);
  assert.equal(report.tabsTotal, 2);
  assert.equal(report.tabsTruncated, true);
  assert.equal(report.counters.touchTotal, 0);
  assert.equal(report.reclaim.skipped.length <= 1, true);
  assert.equal(report.reclaim.skippedTruncated, true);
  assert.equal(typeof report.counters.evidenceSize, 'number');
});

test('证据事件形状：seq 单调、at 可读、失败也留证据且计数不重复', () => {
  const { ops } = harness();
  ops.acquire(1, 's1', { reason: 'session-start' });
  ops.acquire(1, 's2', { reason: 'rebind' }); // conflict
  ops.renew(1, 's2'); // conflict
  ops.release(1, 's2'); // conflict
  const events = ops.evidence({ limit: 50 });
  assert.equal(events.length >= 4, true);
  const seqs = events.map((item) => item.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(events.every((item) => item.at === NOW), true);
  const stats = ops.stats();
  assert.equal(stats.counters.acquire, 1);
  assert.equal(stats.counters.conflict, 3);
  // 证据环上限（默认 500）不会因为计数而膨胀。
  assert.equal(stats.evidenceSize, events.length);
});

test('acquire 失败参数/异常：E_BAD_ARG 不写租约，evidence 不泄漏 tab', () => {
  const { ops, leases } = harness();
  const bad = ops.acquire('x', 's1');
  assert.equal(bad.code, 'E_BAD_ARG');
  const badSession = ops.acquire(1, '');
  assert.equal(badSession.code, 'E_BAD_ARG');
  assert.equal(leases.snapshot().length, 0);
  assert.equal(ops.evidence({ limit: 10 }).length, 0, '参数错误不写事件');
  const joinBad = ops.join(null, 's1');
  assert.equal(joinBad.code, 'E_BAD_ARG');
  const releaseBad = ops.release(1, null);
  assert.equal(releaseBad.code, 'E_BAD_ARG');
});

test('ownershipOf / report：非法 tab 返回 null；游离会话进入冲突与报告 totals', () => {
  const { ops, sessions } = harness();
  ops.acquire(1, 's1', { reason: 'session-start' });
  // 会话 s2 登记在 tab 2 但没有租约 → info 级 session-without-lease 冲突。
  sessions.set('s2', { sessionId: 's2', tabId: 2, startedAt: NOW - 500 });
  assert.equal(ops.ownershipOf('x'), null);
  assert.equal(ops.ownershipOf(null), null);
  const free = ops.ownershipOf(99);
  assert.equal(free.state, 'free');
  assert.equal(free.holder, null);
  const report = ops.report({ limit: 10 });
  assert.equal(report.totals.tabs, 2);
  assert.equal(report.totals.freeTabs, 1);
  assert.equal(report.totals.conflicts >= 1, true);
  assert.equal(report.conflicts.some((item) => item.code === 'session-without-lease'), true);
  assert.equal(report.reconcile.stats.adopt, 1);
  // 冲突解释：给运维直接可读的一句话。
  const row = ops.ownershipOf(1);
  assert.equal(row.sessionCount, 1);
  assert.equal(row.conflictCount, 0);
  const conflict = ops.conflict(1, 's2', { reason: 'rebind' });
  assert.equal(conflict.clear, false, 'tab 1 由 s1 持有，s2 请求会得到冲突证据');
  assert.equal(conflict.holder, 's1');
  assert.match(conflict.explanation, /s2/);
});

test('reconcile：stopping/stopped 会话不进入补登计划（生命周期过滤）', () => {
  let now = NOW;
  const sessions = new Map([
    ['s1', { sessionId: 's1', tabId: 1, startedAt: NOW - 3_000 }],
    ['s2', { sessionId: 's2', tabId: 2, startedAt: NOW - 2_000 }],
    ['s3', { sessionId: 's3', tabId: 3, startedAt: NOW - 1_000 }],
  ]);
  const leases = createSessionLeases({ now: () => now, defaultTtlMs: 60_000, isSessionAlive: () => true });
  const phases = { s2: 'stopping', s3: 'stopped' };
  const ops = createLeaseOps({
    leases,
    sessions,
    sessionState: { phase: (id) => phases[id] || 'active' },
    now: () => now,
    log: () => {},
  });
  const plan = ops.reconcile();
  assert.deepEqual(plan.plan.adopt.map((item) => item.sessionId), ['s1']);
  assert.deepEqual(plan.adopt, undefined);
  // apply 后只为 s1 补登租约。
  const applied = ops.reconcile({ apply: true });
  assert.equal(applied.applied.adopted, 1);
  assert.equal(leases.ownerOf(1), 's1');
  assert.equal(leases.ownerOf(2), null);
  assert.equal(leases.ownerOf(3), null);
  // 停止中的会话即使持有租约，也只进 conflicts 证据（lease-holder-stopping）。
  leases.acquire(2, 's2', { reason: 'session-start' });
  const report = ops.report({ limit: 5 });
  assert.equal(report.conflicts.some((item) => item.code === 'lease-holder-stopping'), true);
  assert.equal(report.totals.highConflicts >= 0, true);
  assert.equal(report.sweeper.running, false);
  assert.equal(typeof report.counters.evidenceSize, 'number');
});
