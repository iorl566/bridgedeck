// tests/unit/daemon-doctor.test.mjs —— daemon 结构化自检（ledger/transfer/queue/recovery/storage/runtime）。
//
// 所有数据源都用可注入的假对象：单测不启动 daemon、不读真实 BB_HOME，
// 只验证"状态 → 检查项 → 汇总/退出码"的判定与降级行为（任何数据源异常都不能抛）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAEMON_DOCTOR_SCHEMA, aggregateDoctorStatus, createDaemonDoctor, summarizeDoctorChecks } from '../../daemon/doctor.js';

const NOW = Date.parse('2026-11-26T02:00:00.000Z');

function fakeLedgerReport({ pending = [], wal = { lines: 3, parsed: 3, corrupted: 0, tornTail: false, duplicates: 0, outOfOrder: 0 }, durability = { fsync: true, appends: 3, degraded: false, lastError: null }, restore = null } = {}) {
  const status = { staleMs: 15_000, pending, recent: [], recovery: { ok: true, recovered: 0, replayBlocked: 0 }, wal, durability };
  return {
    readStatus: () => ({ status, stats: {} }),
    restore: () => restore || { ok: true, exists: false, path: null },
    get restoreEvidence() { return restore; },
  };
}

function fakeTransferOps({ counts = { total: 0, active: 0 }, quota = { maxConcurrent: 16, maxTotalBytes: 512, usagePercent: 0, slotsPercent: 0, idleTtlMs: 600_000 }, bytes = { reserved: 0, received: 0 }, transfers = [], counters = {} } = {}) {
  return {
    transferSnapshot: () => ({ counts, quota, bytes, transfers, counters }),
  };
}

function fakeCommandQueue({ totals = { dispatch: 0, completed: 0, failed: 0, rejected: 0, pending: 0, peakInflight: 0 }, inflight = { current: 0, limit: 64, peak: 0 }, fairness = { strategy: 'round-robin-per-tab', jainIndex: 1, maxConsecutive: 0, longestQueuedMs: 0, starvingTabs: 0, tabs: [] }, rejects = { total: 0, byCode: {}, byReason: {} } } = {}) {
  return { diagnostics: () => ({ totals, inflight, fairness, rejects }) };
}

function fakeRecovery({ plan = { restore: 0, expired: 0, invalid: 0, duplicates: 0 }, ledger = { ok: true, recovered: 0 }, leases = [] } = {}) {
  return { snapshot: () => ({ sessions: { plan }, ledger, leases }) };
}

test('aggregateDoctorStatus / summarizeDoctorChecks：fail > warn > ok 与 area 计分', () => {
  assert.equal(aggregateDoctorStatus([]), 'ok');
  assert.equal(aggregateDoctorStatus([{ status: 'ok' }, { status: 'warn' }]), 'warn');
  assert.equal(aggregateDoctorStatus([{ status: 'warn' }, { status: 'fail' }]), 'fail');
  const summary = summarizeDoctorChecks([
    { area: 'ledger', status: 'ok' },
    { area: 'ledger', status: 'warn' },
    { area: 'queue', status: 'fail' },
    { area: 'queue', status: 'ok', skipped: true },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.ok, 2);
  assert.equal(summary.warn, 1);
  assert.equal(summary.fail, 1);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.areas.ledger, { ok: 1, warn: 1, fail: 0 });
  assert.deepEqual(summary.areas.queue, { ok: 1, warn: 0, fail: 1 });
});

test('干净运行：所有检查 ok，schema/status/ok 汇总正确', () => {
  const doctor = createDaemonDoctor({
    ledgerReport: fakeLedgerReport(),
    transferOps: fakeTransferOps(),
    commandQueue: fakeCommandQueue(),
    sessionRecovery: fakeRecovery(),
    startedAt: NOW - 5_000,
    version: '0.3.0',
    protocol: '1.9',
    now: () => NOW,
    homeDir: null, // storage 检查跳过
  });
  const report = doctor.run();
  assert.equal(report.schema, DAEMON_DOCTOR_SCHEMA);
  assert.equal(report.at, new Date(NOW).toISOString());
  assert.equal(report.ok, true);
  assert.equal(report.status, 'ok');
  assert.equal(report.checks.length, 10);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.warn, 0);
  const ids = report.checks.map((item) => item.id);
  assert.deepEqual(ids, [
    'ledger.durability', 'ledger.pending', 'ledger.snapshot',
    'transfer.quota', 'transfer.stuck',
    'queue.saturation', 'queue.fairness',
    'recovery.sessions', 'storage.home', 'runtime.daemon',
  ]);
  const storage = report.checks.find((item) => item.id === 'storage.home');
  assert.equal(storage.skipped, true);
  const runtime = report.checks.find((item) => item.id === 'runtime.daemon');
  assert.equal(runtime.status, 'ok');
  assert.match(runtime.detail, /v0\.3\.0（protocol 1\.9）/);
});

test('账本：unknown pending 与 WAL 损坏分别 warn/fail', () => {
  const pending = [
    { id: 'lt_u', state: 'unknown', tabId: 7, method: 'click', replayBlocked: true },
    { id: 'lt_s', state: 'stale', tabId: 7, method: 'fill', replayBlocked: false },
  ];
  const report = createDaemonDoctor({
    ledgerReport: fakeLedgerReport({
      pending,
      wal: { lines: 4, parsed: 2, corrupted: 2, tornTail: true, duplicates: 1, outOfOrder: 1 },
      durability: { fsync: true, appends: 4, degraded: false },
    }),
    now: () => NOW,
  }).run({ include: ['ledger'] });
  const pendingCheck = report.checks.find((item) => item.id === 'ledger.pending');
  assert.equal(pendingCheck.status, 'warn');
  assert.match(pendingCheck.detail, /待确认 2 条/);
  assert.deepEqual(pendingCheck.data.tabs, [7]);
  const durability = report.checks.find((item) => item.id === 'ledger.durability');
  assert.equal(durability.status, 'fail');
  assert.match(durability.detail, /WAL 损坏行 2/);
  assert.match(durability.detail, /尾部撕裂/);
  assert.equal(report.status, 'fail');
  assert.equal(report.ok, false);
});

test('账本持久化降级 / fsync 关闭：fail 与 warn 分开', () => {
  const degraded = createDaemonDoctor({
    ledgerReport: fakeLedgerReport({ durability: { fsync: true, appends: 1, degraded: true, lastError: { code: 'E_LEDGER_WAL_IO', message: 'disk full' } } }),
    now: () => NOW,
  }).run({ include: ['ledger'] });
  const check = degraded.checks.find((item) => item.id === 'ledger.durability');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /E_LEDGER_WAL_IO disk full/);

  const noFsync = createDaemonDoctor({
    ledgerReport: fakeLedgerReport({ durability: { fsync: false, appends: 1, degraded: false } }),
    now: () => NOW,
  }).run({ include: ['ledger'] });
  const warnCheck = noFsync.checks.find((item) => item.id === 'ledger.durability');
  assert.equal(warnCheck.status, 'warn');
  assert.match(warnCheck.detail, /fsync 关闭/);
});

test('账本恢复对账：快照漂移 → warn（新增未知），损坏快照 → warn', () => {
  const drift = createDaemonDoctor({
    ledgerReport: fakeLedgerReport({
      restore: { ok: true, exists: true, snapshotAt: '2026-11-26T01:00:00.000Z', digestOk: true, blocked: 1, drift: { drift: true, counts: { resolvedSince: 2, becameUnknown: 1, stillBlocked: 1 } } },
    }),
    now: () => NOW,
  }).run({ include: ['ledger'] });
  const snapshotCheck = drift.checks.find((item) => item.id === 'ledger.snapshot');
  assert.equal(snapshotCheck.status, 'warn');
  assert.match(snapshotCheck.detail, /新增未知意图 1 条/);

  const invalid = createDaemonDoctor({
    ledgerReport: fakeLedgerReport({ restore: { ok: false, exists: true, error: 'E_LEDGER_SNAPSHOT_INVALID', validation: { errors: ['digest 不一致'] } } }),
    now: () => NOW,
  }).run({ include: ['ledger'] });
  const invalidCheck = invalid.checks.find((item) => item.id === 'ledger.snapshot');
  assert.equal(invalidCheck.status, 'warn');
  assert.match(invalidCheck.detail, /快照不可用/);
});

test('transfer：配额吃紧/拒绝计数 warn；打满 fail；长期空闲传输 warn', () => {
  const tight = createDaemonDoctor({
    transferOps: fakeTransferOps({
      counts: { total: 2, active: 2 },
      quota: { maxConcurrent: 2, maxTotalBytes: 100, usagePercent: 85, slotsPercent: 90, idleTtlMs: 600_000 },
      counters: { quotaRejected: 1 },
    }),
    now: () => NOW,
  }).run({ include: ['transfer'] });
  assert.equal(tight.checks[0].id, 'transfer.quota');
  assert.equal(tight.checks[0].status, 'warn');
  assert.match(tight.checks[0].detail, /已拒绝 1 次/);

  const full = createDaemonDoctor({
    transferOps: fakeTransferOps({
      counts: { total: 2, active: 2 },
      quota: { maxConcurrent: 2, maxTotalBytes: 100, usagePercent: 100, slotsPercent: 100, idleTtlMs: 600_000 },
    }),
    now: () => NOW,
  }).run({ include: ['transfer'] });
  assert.equal(full.checks[0].status, 'fail');
  assert.equal(full.ok, false);

  const stuck = createDaemonDoctor({
    transferOps: fakeTransferOps({
      quota: { maxConcurrent: 16, maxTotalBytes: 512, usagePercent: 0, slotsPercent: 0, idleTtlMs: 600_000 },
      transfers: [{ transferId: 'tr_a', finished: false, idleMs: 400_000, sessionId: 's1' }],
      counters: { sweepRemoved: 2 },
    }),
    now: () => NOW,
  }).run({ include: ['transfer'] });
  const stuckCheck = stuck.checks.find((item) => item.id === 'transfer.stuck');
  assert.equal(stuckCheck.status, 'warn');
  assert.match(stuckCheck.detail, /空闲超过 300s/);
  assert.equal(stuck.status, 'warn');
});

test('queue：拒绝/高 inflight → warn；公平性连续过长/排队过久 → warn', () => {
  const busy = createDaemonDoctor({
    commandQueue: fakeCommandQueue({
      totals: { dispatch: 10, completed: 8, failed: 0, rejected: 2, pending: 3, peakInflight: 5 },
      inflight: { current: 60, limit: 64, peak: 61 },
      rejects: { total: 2, byCode: { E_QUEUE_FULL: 2 }, byReason: { 'session-pending': 2 } },
      fairness: { strategy: 'round-robin-per-tab', jainIndex: 0.8, maxConsecutive: 2, longestQueuedMs: 100, starvingTabs: 0, tabs: [] },
    }),
    now: () => NOW,
  }).run({ include: ['queue'] });
  const saturation = busy.checks.find((item) => item.id === 'queue.saturation');
  assert.equal(saturation.status, 'warn');
  assert.match(saturation.detail, /session-pending=2/);
  // busy 的公平性指标正常（最长连续 2、排队 100ms）→ ok。
  assert.equal(busy.checks.find((item) => item.id === 'queue.fairness').status, 'ok');

  const unfair = createDaemonDoctor({
    commandQueue: fakeCommandQueue({
      fairness: { strategy: 'round-robin-per-tab', jainIndex: 0.3, maxConsecutive: 12, longestQueuedMs: 30_000, starvingTabs: 1, tabs: [] },
    }),
    now: () => NOW,
  }).run({ include: ['queue'] });
  const fairness = unfair.checks.find((item) => item.id === 'queue.fairness');
  assert.equal(fairness.status, 'warn');
  assert.match(fairness.detail, /最长连续 12/);
  assert.match(fairness.detail, /饥饿 tab 1/);
});

test('recovery：坏行/过期 warn，账本恢复降级 fail；正常时给出恢复计数', () => {
  const warn = createDaemonDoctor({
    sessionRecovery: fakeRecovery({ plan: { restore: 2, expired: 1, invalid: 1, duplicates: 1 }, ledger: { ok: true, recovered: 1 }, leases: [{}, {}] }),
    now: () => NOW,
  }).run({ include: ['recovery'] });
  assert.equal(warn.status, 'warn');
  assert.match(warn.checks[0].detail, /坏行 1/);
  assert.match(warn.checks[0].detail, /过期会话 1/);

  const fail = createDaemonDoctor({
    sessionRecovery: fakeRecovery({ ledger: { ok: false, error: 'ledger-unavailable' } }),
    now: () => NOW,
  }).run({ include: ['recovery'] });
  assert.equal(fail.status, 'fail');
  assert.match(fail.checks[0].detail, /账本恢复降级/);

  const ok = createDaemonDoctor({
    sessionRecovery: fakeRecovery({ plan: { restore: 3, expired: 0, invalid: 0, duplicates: 0 }, ledger: { ok: true, recovered: 4 }, leases: [{}, {}] }),
    now: () => NOW,
  }).run({ include: ['recovery'] });
  assert.equal(ok.status, 'ok');
  assert.match(ok.checks[0].detail, /会话 3/);
  assert.match(ok.checks[0].detail, /pending→unknown 4/);
});

test('storage：不可写 fail；可写给出磁盘可用空间；statfs 不可用也 ok', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-doctor-home-'));
  try {
    const ok = createDaemonDoctor({ homeDir: home, now: () => NOW }).run({ include: ['storage'] });
    assert.equal(ok.checks[0].status, 'ok');
    assert.match(ok.checks[0].detail, /BB_HOME 可写/);

    const missing = path.join(home, 'missing-dir');
    const fail = createDaemonDoctor({ homeDir: missing, now: () => NOW }).run({ include: ['storage'] });
    assert.equal(fail.status, 'fail');

    const noStatfs = createDaemonDoctor({ homeDir: home, now: () => NOW, statfs: null, fsImpl: { ...fs, statfsSync: undefined } }).run({ include: ['storage'] });
    assert.equal(noStatfs.checks[0].status, 'ok');
    assert.match(noStatfs.checks[0].detail, /磁盘可用空间未知/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('数据源异常降级为 fail 检查项而不是抛出；缺失数据源标记 skipped', () => {
  const broken = createDaemonDoctor({
    ledgerReport: {
      readStatus: () => { throw new Error('ledger exploded'); },
      restore: () => { throw new Error('restore exploded'); },
    },
    now: () => NOW,
  }).run({ include: ['ledger'] });
  assert.equal(broken.status, 'fail');
  assert.equal(broken.checks.every((item) => item.status === 'fail'), true, '三个 ledger 检查项都应降级为 fail');
  assert.match(broken.checks[0].detail, /自检异常：ledger exploded/);

  const empty = createDaemonDoctor({ now: () => NOW }).run();
  assert.equal(empty.status, 'ok');
  assert.equal(empty.checks.every((item) => item.skipped === true), true);
  assert.equal(empty.summary.skipped, empty.checks.length);
});

test('include 过滤：只跑请求的区域', () => {
  const doctor = createDaemonDoctor({
    ledgerReport: fakeLedgerReport(),
    transferOps: fakeTransferOps(),
    commandQueue: fakeCommandQueue(),
    sessionRecovery: fakeRecovery(),
    startedAt: NOW - 1000,
    version: '0.3.0',
    protocol: '1.9',
    now: () => NOW,
  });
  const queueOnly = doctor.run({ include: ['queue'] });
  assert.equal(queueOnly.checks.length, 2);
  assert.equal(queueOnly.checks.every((item) => item.area === 'queue'), true);
  const ledgerAndRecovery = doctor.run({ include: ['ledger', 'recovery'] });
  assert.deepEqual(ledgerAndRecovery.checks.map((item) => item.area), ['ledger', 'ledger', 'ledger', 'recovery']);
  const unknownArea = doctor.run({ include: ['nope'] });
  assert.equal(unknownArea.checks.length, 0);
  assert.equal(unknownArea.status, 'ok');
});
