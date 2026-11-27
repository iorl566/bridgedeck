// tests/unit/daemon-batch-status-views.test.mjs —— status 增量视图的第十一批 G 扩展。
//
// 关键回归：
// - 默认 status（不请求 views）仍然原样返回 0.3.0 载荷（同一引用、字段集合不变）；
// - 新增 batch / arbitration 视图只在显式请求时出现，且数据源缺失时不产生字段；
// - 数据源抛错降级为 {ok:false,error}，不拖垮整条 status；
// - strategy/limit 参数被传到裁决视图，parseStatusViews 的正确性；
// - "all" 现在包含新视图，但旧视图行为不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_MAX_LIMIT, STATUS_VIEWS, createStatusViews, parseStatusViews } from '../../daemon/status-views.js';

function baseStatus() {
  return {
    service: 'browser-bridge',
    version: '0.3.0',
    protocol: '1.9',
    pid: 321,
    port: 52900,
    uptimeMs: 1000,
    browsers: [],
    sessions: [],
    inflight: [],
    queues: [],
    auth: { tracked: 0, blocked: [] },
    recovery: { at: 1, sessions: { live: 0 } },
    compatibility: { daemon: { protocol: '1.9', features: {} }, browsers: [] },
  };
}

function makeBatchSource() {
  const calls = [];
  return {
    calls,
    snapshot: (params) => {
      calls.push(params);
      return {
        schema: 1,
        kind: 'bridge/session-batch',
        at: 10,
        quota: { schema: 1, kind: 'bridge/session-quota', policy: { maxSessions: 12 }, live: 0, reserved: 0, available: 12 },
        recent: [{ batchId: 'b1', state: 'completed' }],
        running: [],
        totals: { batches: 1, succeeded: 2, failed: 0, denied: 0 },
      };
    },
  };
}

function makeArbiterSource() {
  const calls = [];
  return {
    calls,
    report: (params) => {
      calls.push(params);
      return {
        schema: 1,
        kind: 'bridge/lease-arbitration',
        mode: 'plan',
        verdicts: [{ tabId: 1, action: 'promote', severity: 'high', conflictCodes: ['lease-holder-missing'] }],
        steps: [{ index: 0, op: 'transfer', tabId: 1 }],
        summary: { verdicts: 1, actionable: 1, reportOnly: 0, conflicts: 1 },
        at: 20,
      };
    },
  };
}

function makeViews({ batchSessions = makeBatchSource(), leaseArbiter = makeArbiterSource() } = {}) {
  const views = createStatusViews({
    baseStatus,
    ledgerReport: { summary: () => ({ pending: 1 }) },
    transferOps: { transferSnapshot: () => ({ counts: { total: 0 } }) },
    commandQueue: { diagnostics: () => ({ totals: { pending: 0 } }) },
    daemonDoctor: { run: () => ({ status: 'ok', checks: [] }) },
    leaseOps: { report: () => ({ kind: 'bridge/tab-ownership', totals: { tabs: 0 } }) },
    commandBoundary: { summary: () => ({ kind: 'bridge/command-boundary', counts: { total: 160 }, invariantOk: true }) },
    batchSessions,
    leaseArbiter,
  });
  return { views, batchSessions, leaseArbiter };
}

test('STATUS_VIEWS：包含第十一批 G 的 batch / arbitration，顺序稳定', () => {
  assert.deepEqual(STATUS_VIEWS, ['ledger', 'transfers', 'queues', 'doctor', 'leases', 'boundary', 'batch', 'arbitration']);
  assert.equal(STATUS_MAX_LIMIT, 500);
});

test('parseStatusViews：batch/arbitration 可识别，strategy 透传并小写化', () => {
  const parsed = parseStatusViews({ views: ['batch', 'arbitration'], strategy: 'LRU', limit: 7 });
  assert.deepEqual(parsed.views, ['batch', 'arbitration']);
  assert.equal(parsed.strategy, 'lru');
  assert.equal(parsed.limit, 7);
  const noStrategy = parseStatusViews({ views: 'batch' });
  assert.equal(noStrategy.strategy, null);
  const all = parseStatusViews({ views: 'all' });
  assert.deepEqual(all.views, STATUS_VIEWS);
  const unknown = parseStatusViews({ views: ['batch', 'nope'] });
  assert.deepEqual(unknown.views, ['batch']);
  assert.deepEqual(unknown.unknown, ['nope']);
});

test('默认 status：请求空参数时原样返回 base（字段集合不变），不出现 batch/arbitration', () => {
  const { views, batchSessions, leaseArbiter } = makeViews();
  const result = views.buildStatus({});
  assert.equal(result.batch, undefined);
  assert.equal(result.arbitration, undefined);
  assert.equal(batchSessions.calls.length, 0, '未请求不计算 batch 视图');
  assert.equal(leaseArbiter.calls.length, 0, '未请求不计算 arbitration 视图');
  const expected = baseStatus();
  assert.deepEqual(result, expected);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(expected).sort());
});

test('views=batch：追加 batch 字段与 views 标记，limit 传给数据源', () => {
  const { views, batchSessions } = makeViews();
  const result = views.buildStatus({ views: ['batch'], limit: 3 });
  assert.deepEqual(result.views, ['batch']);
  assert.equal(result.batch.kind, 'bridge/session-batch');
  assert.equal(result.batch.quota.available, 12);
  assert.deepEqual(batchSessions.calls, [{ limit: 3 }]);
  assert.equal(result.arbitration, undefined);
  // 基础字段仍在。
  assert.equal(result.service, 'browser-bridge');
});

test('views=arbitration：追加 arbitration 字段，strategy/limit 透传', () => {
  const { views, leaseArbiter } = makeViews();
  const result = views.buildStatus({ views: ['arbitration'], limit: 5, strategy: 'priority' });
  assert.deepEqual(result.views, ['arbitration']);
  assert.equal(result.arbitration.kind, 'bridge/lease-arbitration');
  assert.deepEqual(leaseArbiter.calls, [{ limit: 5, strategy: 'priority' }]);
  const noStrategy = views.buildStatus({ views: ['arbitration'] });
  assert.deepEqual(leaseArbiter.calls[1], { limit: 20 }, '未指定 strategy 时不注入键');
});

test('views=all：8 个视图全部出现（有数据源时），views 数组与 STATUS_VIEWS 一致', () => {
  const { views } = makeViews();
  const result = views.buildStatus({ views: 'all', limit: 2 });
  assert.deepEqual(result.views, STATUS_VIEWS);
  for (const key of ['ledger', 'transfers', 'queue', 'doctor', 'leases', 'boundary', 'batch', 'arbitration']) {
    assert.ok(result[key], '缺少视图字段 ' + key);
  }
  assert.equal(result.views.length, STATUS_VIEWS.length);
});

test('数据源缺失：只安装部分依赖时对应字段不出现（旧部署安全）', () => {
  const views = createStatusViews({ baseStatus });
  const result = views.buildStatus({ views: 'all' });
  assert.deepEqual(result.views, STATUS_VIEWS);
  for (const key of ['ledger', 'transfers', 'queue', 'doctor', 'leases', 'boundary', 'batch', 'arbitration']) {
    assert.equal(result[key], undefined, key);
  }
  assert.equal(result.unknownViews, undefined);
});

test('数据源抛错：batch/arbitration 各自降级为 {ok:false,error}，不影响基础字段', () => {
  const views = createStatusViews({
    baseStatus,
    batchSessions: { snapshot: () => { throw Object.assign(new Error('batch boom'), { code: 'E_BATCH_BOOM' }); } },
    leaseArbiter: { report: () => { throw new Error('arb boom'); } },
  });
  const result = views.buildStatus({ views: ['batch', 'arbitration'] });
  assert.equal(result.batch.ok, false);
  assert.equal(result.batch.error, 'E_BATCH_BOOM');
  assert.match(result.batch.message, /batch boom/);
  assert.equal(result.arbitration.ok, false);
  assert.equal(result.arbitration.error, 'E_INTERNAL');
  assert.equal(result.service, 'browser-bridge');
  assert.deepEqual(result.views, ['batch', 'arbitration']);
});

test('未知视图回显 unknownViews（含新视图名拼写错误）', () => {
  const { views } = makeViews();
  const result = views.buildStatus({ views: ['batch', 'arbitrationn', 'batches'] });
  assert.deepEqual(result.views, ['batch']);
  assert.deepEqual(result.unknownViews, ['arbitrationn', 'batches']);
  assert.ok(result.batch);
  assert.equal(result.arbitration, undefined);
});

test('同时请求 batch+arbitration+leases：顺序去重且互不干扰', () => {
  const { views } = makeViews();
  const result = views.buildStatus({ views: ['arbitration', 'batch', 'leases', 'batch'] });
  assert.deepEqual(result.views, ['arbitration', 'batch', 'leases']);
  assert.ok(result.arbitration && result.batch && result.leases);
  assert.equal(result.arbitration.summary.verdicts, 1);
});

test('createStatusViews：缺 baseStatus 仍然快速失败', () => {
  assert.throws(() => createStatusViews({ batchSessions: makeBatchSource() }), /baseStatus/);
});
