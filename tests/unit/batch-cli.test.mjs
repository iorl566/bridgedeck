// tests/unit/batch-cli.test.mjs —— CLI 批处理/租约命令层（cli/commands/batch.mjs、lease.mjs）。
//
// 这些测试不启动 daemon：用假 callRpc 记录 RPC 方法/参数并返回固定 result，
// 断言"取数 → 渲染 → 退出码"三段式（JSON 单行信封 / 人类表格 / strict schema / 参数错误）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BATCH_ACTIONS,
  BATCH_USAGE,
  createBatchCommand,
  loadBatchParams,
  mergeSpecDocuments,
  parseItemsFlag,
} from '../../cli/commands/batch.mjs';
import { LEASE_ACTIONS, LEASE_USAGE, createLeaseCommand, leaseParamsFromFlags } from '../../cli/commands/lease.mjs';

class FakeArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgError';
  }
}

const BASE_TIME = 1_700_000_000_000;

function makeCtx() {
  const state = { rpc: [], json: false, stdout: [], stderr: [], strictFailures: 0 };
  const ctx = {
    callRpc: async (method, params, timeoutMs) => {
      state.rpc.push({ method, params: JSON.parse(JSON.stringify(params || {})), timeoutMs });
      const handler = ctx.handlers[method];
      if (!handler) throw new Error('unexpected RPC ' + method);
      return handler(params || {});
    },
    handlers: {},
    timeoutOf: () => 60_000,
    outputFailure: (body) => 1,
    outputJsonBody: (body) => {
      state.stdout.push(JSON.stringify(body));
      return 0;
    },
    emitJson: (value) => { state.stdout.push(JSON.stringify(value)); },
    isJson: () => state.json,
    print: (text) => { state.stdout.push(text); },
    ArgError: FakeArgError,
  };
  return { ctx, state };
}

function batchFixture(overrides = {}) {
  return {
    schema: 1,
    kind: 'bridge/session-batch',
    batchId: 'b1',
    state: 'completed',
    outcome: 'ok',
    onError: 'continue',
    concurrency: 2,
    retries: 0,
    durationMs: 10,
    quota: { requested: 1, granted: 1, committed: 1, released: 0, denied: 0 },
    summary: { total: 1, admitted: 1, denied: 0, succeeded: 1, failed: 0, cancelled: 0, skipped: 0, rolledBack: 0 },
    items: [{ index: 0, state: 'succeeded', admission: 'admitted', attempts: 1, sessionId: 's1', durationMs: 10, error: null }],
    warnings: [],
    rollback: null,
    reused: false,
    ...overrides,
  };
}

function quotaFixture() {
  return {
    schema: 1,
    kind: 'bridge/session-quota',
    policy: { maxSessions: 12, maxPerBatch: 4, maxConcurrentStarts: 2, maxPerInstance: 8, maxBatchItems: 50, reservationTtlMs: 120_000 },
    live: 1,
    reserved: 0,
    used: 1,
    available: 11,
    usagePercent: 8.3,
    saturated: false,
    instances: [],
    batches: [],
    totals: {},
    counters: {},
  };
}

function arbitrationFixture(overrides = {}) {
  return {
    schema: 1,
    kind: 'bridge/lease-arbitration',
    mode: 'plan',
    policy: { strategy: 'fifo', preempt: false, allowForce: false, reviveWindowMs: 30_000, limit: 20, includeClean: false, by: 'lease-arbiter' },
    verdicts: [
      { tabId: 1, action: 'promote', severity: 'high', conflictCodes: ['lease-holder-missing'], winner: { sessionId: 's2' }, losers: [], reportOnly: false, confidence: 0.9, steps: [{ index: 0, op: 'transfer', args: { tabId: 1, from: 'dead', to: 's2' } }], notes: [] },
    ],
    steps: [{ index: 0, op: 'transfer', tabId: 1, reason: 'holder-missing', args: { tabId: 1, from: 'dead', to: 's2' } }],
    summary: { tabs: 1, leases: 1, sessions: 1, conflicts: 1, verdicts: 1, cleanTabs: 0, actionable: 1, reportOnly: 0, deferred: 0, steps: 1, highSeverity: 1, warnSeverity: 0, infoSeverity: 0, byAction: { promote: 1 }, byCode: { 'lease-holder-missing': 1 }, winners: ['s2'] },
    truncated: false,
    applied: null,
    residual: null,
    appliedAt: 0,
    ...overrides,
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-batch-cli-'));
}

// ---------------------------------------------------------------------------
// 规格解析（纯函数）
// ---------------------------------------------------------------------------

test('parseItemsFlag：数组/对象/非法 JSON/非法形状', () => {
  assert.deepEqual(parseItemsFlag('[{"url":"https://a.example/"}]', FakeArgError), [{ url: 'https://a.example/' }]);
  assert.deepEqual(parseItemsFlag('{"items":[{"url":"https://a.example/"}]}', FakeArgError), [{ url: 'https://a.example/' }]);
  assert.throws(() => parseItemsFlag('', FakeArgError), FakeArgError);
  assert.throws(() => parseItemsFlag('{bad json', FakeArgError), FakeArgError);
  assert.throws(() => parseItemsFlag('{"urls":[]}', FakeArgError), FakeArgError);
  assert.throws(() => parseItemsFlag('42', FakeArgError), FakeArgError);
});

test('mergeSpecDocuments：完整 spec / 条目数组 / URL 字符串数组 / urls 简写合并', () => {
  const merged = mergeSpecDocuments([
    { items: [{ url: 'https://a.example/' }], onError: 'abort', concurrency: 2, group: 'g1' },
    [{ url: 'https://b.example/' }, 'https://c.example/'],
    { urls: ['https://d.example/'] },
    { retries: 1, timeoutMs: 5000, batchId: 'merged-1', quota: { maxPerBatch: 1 } },
  ], { ArgError: FakeArgError });
  assert.equal(merged.items.length, 4);
  assert.equal(merged.onError, 'abort');
  assert.equal(merged.concurrency, 2);
  assert.equal(merged.retries, 1);
  assert.equal(merged.timeoutMs, 5000);
  assert.equal(merged.batchId, 'merged-1');
  assert.equal(merged.group, 'g1');
  assert.deepEqual(merged.quota, { maxPerBatch: 1 });
  assert.equal(merged.items[1].url, 'https://b.example/');
  assert.equal(merged.items[2].url, 'https://c.example/');
});

test('mergeSpecDocuments：非法文档/条目形状抛 ArgError', () => {
  assert.throws(() => mergeSpecDocuments([42], { ArgError: FakeArgError }), FakeArgError);
  assert.throws(() => mergeSpecDocuments([{ items: [42] }], { ArgError: FakeArgError }), FakeArgError);
  assert.throws(() => mergeSpecDocuments([[null]], { ArgError: FakeArgError }), FakeArgError);
  assert.deepEqual(mergeSpecDocuments([null, undefined], { ArgError: FakeArgError }), { items: [] });
});

test('loadBatchParams：没有来源返回 null；--file 读取 JSON 并检查存在性', () => {
  assert.equal(loadBatchParams({}, { ArgError: FakeArgError }), null);
  const dir = tempDir();
  try {
    const file = path.join(dir, 'spec.json');
    fs.writeFileSync(file, JSON.stringify([{ url: 'https://a.example/' }]), 'utf8');
    const loaded = loadBatchParams({ file }, { ArgError: FakeArgError });
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0].url, 'https://a.example/');
    assert.throws(() => loadBatchParams({ file: path.join(dir, 'missing.json') }, { ArgError: FakeArgError }), FakeArgError);
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{oops', 'utf8');
    assert.throws(() => loadBatchParams({ file: broken }, { ArgError: FakeArgError }), FakeArgError);
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, '[]', 'utf8');
    assert.throws(() => loadBatchParams({ file: empty }, { ArgError: FakeArgError }), FakeArgError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadBatchParams：--items/--url 与 flags 覆盖（on-error/concurrency/retries/max/batch-id/group/dry-run）', () => {
  const params = loadBatchParams({
    items: '["https://a.example/"]',
    url: 'https://b.example/',
    'on-error': 'ABORT',
    concurrency: '2',
    retries: '1',
    max: '2',
    'batch-id': 'cli-1',
    group: 'grp',
    'dry-run': true,
  }, { ArgError: FakeArgError });
  assert.equal(params.items.length, 2);
  assert.equal(params.onError, 'abort');
  assert.equal(params.concurrency, 2);
  assert.equal(params.retries, 1);
  assert.equal(params.max, 2);
  assert.equal(params.batchId, 'cli-1');
  assert.equal(params.group, 'grp');
  assert.equal(params.dryRun, true);
});

test('loadBatchParams：非法 flags 在本地以 ArgError 拒绝（不发 RPC）', () => {
  const base = { items: '["https://a.example/"]' };
  assert.throws(() => loadBatchParams({ ...base, 'on-error': 'explode' }, { ArgError: FakeArgError }), FakeArgError);
  assert.throws(() => loadBatchParams({ ...base, concurrency: '0' }, { ArgError: FakeArgError }), FakeArgError);
  assert.throws(() => loadBatchParams({ ...base, concurrency: 'x' }, { ArgError: FakeArgError }), FakeArgError);
  assert.throws(() => loadBatchParams({ ...base, retries: '9' }, { ArgError: FakeArgError }), FakeArgError);
  assert.throws(() => loadBatchParams({ ...base, max: '0' }, { ArgError: FakeArgError }), FakeArgError);
});

test('BATCH_ACTIONS / BATCH_USAGE：命令面稳定', () => {
  assert.deepEqual(BATCH_ACTIONS, ['plan', 'start', 'status', 'list', 'cancel', 'quota', 'schema']);
  assert.match(BATCH_USAGE, /daemon batch/);
  assert.match(BATCH_USAGE, /plan/);
  assert.match(BATCH_USAGE, /quota/);
});

// ---------------------------------------------------------------------------
// batch 命令
// ---------------------------------------------------------------------------

test('batch quota --json：真实走 batch.quota，退出码 0，strict 通过', async () => {
  const { ctx, state } = makeCtx();
  state.json = true;
  ctx.handlers['batch.quota'] = () => ({ ok: true, result: quotaFixture() });
  const cmd = createBatchCommand(ctx);
  const code = await cmd({ json: true, strict: true, limit: '20' }, ['daemon', 'batch', 'quota']);
  assert.equal(code, 0);
  assert.equal(state.rpc[0].method, 'batch.quota');
  assert.deepEqual(state.rpc[0].params, { limit: 20 });
  assert.equal(JSON.parse(state.stdout[0]).result.available, 11);
});

test('batch quota 人类输出：含配额/单批上限/实例段落', async () => {
  const { ctx, state } = makeCtx();
  state.json = false;
  ctx.handlers['batch.quota'] = () => ({ ok: true, result: quotaFixture() });
  const cmd = createBatchCommand(ctx);
  const code = await cmd({}, ['daemon', 'batch', 'quota']);
  assert.equal(code, 0);
  const text = state.stdout.join('\n');
  assert.match(text, /会话配额：存活 1\/12/);
  assert.match(text, /单批上限：4/);
});

test('batch plan：构造 dry-run 参数并渲染计划；strict 校验 plan schema', async () => {
  const { ctx, state } = makeCtx();
  state.json = false;
  ctx.handlers['batch.plan'] = (params) => ({
    ok: true,
    result: {
      schema: 1,
      kind: 'bridge/session-batch-plan',
      dryRun: true,
      plannedAt: BASE_TIME,
      policy: { maxSessions: 12 },
      quota: { decisions: [{ batchId: '(dry-run)', granted: 1, deniedCount: 0 }], totals: { requested: 1, granted: 1, denied: 0 }, live: 1, reserved: 0, availableBefore: 11 },
      spec: { items: params.items.length, desired: 1, onError: 'continue', concurrency: 2, retries: 0, timeoutMs: 60_000, max: null, priority: 0, batchId: null, group: null },
      items: [{ index: 0, admission: 'admit', reason: 'quota-granted', url: 'https://a.example/', key: null }],
      summary: { total: 1, admissable: 1, denied: 0, estimatedStarts: 1, maxParallelObserved: 1, policyMaxSessions: 12, liveSessions: 1 },
      warnings: [],
    },
  });
  const cmd = createBatchCommand(ctx);
  const code = await cmd({ strict: true, items: '["https://a.example/"]' }, ['daemon', 'batch', 'plan']);
  assert.equal(code, 0);
  assert.equal(state.rpc[0].method, 'batch.plan');
  assert.equal(state.rpc[0].timeoutMs, 60_000);
  assert.match(state.stdout.join('\n'), /批处理计划（dry-run）：1 个条目/);
});

test('batch start：成功批次退出码 0；失败/部分/配额拒绝/取消/回滚按结论映射', async () => {
  const cases = [
    { result: batchFixture(), code: 0 },
    { result: batchFixture({ outcome: 'partial', summary: { total: 2, succeeded: 1, failed: 1, denied: 0 } }), code: 3 },
    { result: batchFixture({ outcome: 'failed', state: 'failed', summary: { total: 1, succeeded: 0, failed: 1, denied: 0 } }), code: 1 },
    { result: batchFixture({ outcome: 'quota-denied', summary: { total: 1, succeeded: 0, failed: 0, denied: 1 } }), code: 4 },
    { result: batchFixture({ outcome: 'cancelled', state: 'cancelled' }), code: 5 },
    { result: batchFixture({ outcome: 'rolled-back', state: 'rolled-back' }), code: 5 },
  ];
  for (const entry of cases) {
    const { ctx } = makeCtx();
    ctx.handlers['batch.start'] = () => ({ ok: true, result: entry.result });
    const cmd = createBatchCommand(ctx);
    const code = await cmd({ items: '["https://a.example/"]' }, ['daemon', 'batch', 'start']);
    assert.equal(code, entry.code, entry.result.outcome);
  }
});

test('batch start --dry-run：daemon 返回 plan 时退出码固定 0（计划不是失败）', async () => {
  const { ctx } = makeCtx();
  ctx.handlers['batch.start'] = () => ({
    ok: true,
    result: {
      schema: 1,
      kind: 'bridge/session-batch-plan',
      dryRun: true,
      plannedAt: BASE_TIME,
      policy: { maxSessions: 12 },
      quota: { decisions: [], totals: {}, live: 0, reserved: 0, availableBefore: 12 },
      spec: { items: 1, desired: 1, onError: 'continue', concurrency: 1, retries: 0, timeoutMs: 60_000, max: null, priority: 0, batchId: null, group: null },
      items: [{ index: 0, admission: 'deny', reason: 'quota-exhausted', url: 'https://a.example/', key: null }],
      summary: { total: 1, admissable: 0, denied: 1, estimatedStarts: 0, maxParallelObserved: 0, policyMaxSessions: 12, liveSessions: 12 },
      warnings: [],
    },
  });
  const cmd = createBatchCommand(ctx);
  const code = await cmd({ items: '["https://a.example/"]', 'dry-run': true }, ['daemon', 'batch', 'start']);
  assert.equal(code, 0);
});

test('batch status：无 id 退化为 list；有 id 走 batch.status', async () => {
  const { ctx, state } = makeCtx();
  ctx.handlers['batch.list'] = () => ({ ok: true, result: { batches: [], totals: { batches: 0 } } });
  ctx.handlers['batch.status'] = () => ({ ok: true, result: batchFixture() });
  const cmd = createBatchCommand(ctx);
  assert.equal(await cmd({}, ['daemon', 'batch', 'status']), 0);
  assert.equal(state.rpc[0].method, 'batch.list');
  assert.equal(await cmd({}, ['daemon', 'batch', 'status', 'b1']), 0);
  assert.equal(state.rpc[1].method, 'batch.status');
  assert.deepEqual(state.rpc[1].params, { batchId: 'b1' });
});

test('batch list：--state 白名单校验与 limit 限制', async () => {
  const { ctx, state } = makeCtx();
  ctx.handlers['batch.list'] = (params) => ({ ok: true, result: { batches: [], totals: {}, state: params.state } });
  const cmd = createBatchCommand(ctx);
  await cmd({ state: 'completed', limit: '5' }, ['daemon', 'batch', 'list']);
  assert.deepEqual(state.rpc[0].params, { state: 'completed', limit: 5 });
  await assert.rejects(cmd({ state: 'bogus' }, ['daemon', 'batch', 'list']), FakeArgError);
});

test('batch cancel：需要 batchId；已结束批次也给 0', async () => {
  const { ctx, state } = makeCtx();
  ctx.handlers['batch.cancel'] = () => ({ ok: true, result: { ok: true, cancelled: false, batchId: 'b1', state: 'completed' } });
  const cmd = createBatchCommand(ctx);
  await assert.rejects(cmd({}, ['daemon', 'batch', 'cancel']), FakeArgError);
  const code = await cmd({}, ['daemon', 'batch', 'cancel', 'b1']);
  assert.equal(code, 0);
  assert.equal(state.rpc[0].method, 'batch.cancel');
});

test('batch schema：列出/查询 schema（JSON 与人类输出）', async () => {
  const { ctx, state } = makeCtx();
  state.json = true;
  const cmd = createBatchCommand(ctx);
  assert.equal(await cmd({ json: true }, ['daemon', 'batch', 'schema']), 0);
  const listed = JSON.parse(state.stdout[0]);
  assert.equal(listed.result.schemas.length, 5);
  assert.equal(state.rpc.length, 0, 'schema 是纯本地命令，不发 RPC');
  assert.equal(await cmd({ json: true }, ['daemon', 'batch', 'schema', 'bb.session-batch/1']), 0);
  const described = JSON.parse(state.stdout[1]);
  assert.equal(described.result.id, 'bb.session-batch/1');
  await assert.rejects(cmd({ json: true }, ['daemon', 'batch', 'schema', 'nope/1']), FakeArgError);
});

test('batch strict：daemon 返回的 result 不符合 schema 时输出失败信封并退出 1', async () => {
  const { ctx, state } = makeCtx();
  state.json = true;
  ctx.handlers['batch.quota'] = () => ({ ok: true, result: { policy: {}, live: 0, reserved: 0 } });
  const cmd = createBatchCommand(ctx);
  const code = await cmd({ json: true, strict: true }, ['daemon', 'batch', 'quota']);
  assert.equal(code, 1);
  const failure = JSON.parse(state.stdout[0]);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'E_INTERNAL');
  assert.ok(Array.isArray(failure.error.problems));
});

test('batch：未知子命令是参数错误（退出码 2 由 bridge 统一处理）', async () => {
  const { ctx } = makeCtx();
  const cmd = createBatchCommand(ctx);
  await assert.rejects(cmd({}, ['daemon', 'batch', 'explode']), FakeArgError);
});

// ---------------------------------------------------------------------------
// lease 命令
// ---------------------------------------------------------------------------

test('leaseParamsFromFlags：strategy/policy 别名、limit、tab、include-clean', () => {
  const params = leaseParamsFromFlags({ strategy: 'LRU', limit: '5', tab: '7', 'include-clean': true }, { ArgError: FakeArgError });
  assert.deepEqual(params, { strategy: 'lru', limit: 5, tabId: 7, includeClean: true });
  const viaPolicy = leaseParamsFromFlags({ policy: 'priority' }, { ArgError: FakeArgError });
  assert.equal(viaPolicy.strategy, 'priority');
  assert.throws(() => leaseParamsFromFlags({ strategy: 'random' }, { ArgError: FakeArgError }), FakeArgError);
  assert.throws(() => leaseParamsFromFlags({ tab: 'x' }, { ArgError: FakeArgError }), FakeArgError);
  assert.throws(() => leaseParamsFromFlags({ limit: '0' }, { ArgError: FakeArgError }), FakeArgError);
  assert.deepEqual(leaseParamsFromFlags({}, { ArgError: FakeArgError }), {});
});

test('LEASE_ACTIONS / LEASE_USAGE：命令面稳定', () => {
  assert.deepEqual(LEASE_ACTIONS, ['report', 'conflicts', 'arbitrate', 'schema']);
  assert.match(LEASE_USAGE, /lease report\|conflicts\|arbitrate/);
});

test('lease report --json：真实走 lease.report，退出码 0', async () => {
  const { ctx, state } = makeCtx();
  state.json = true;
  ctx.handlers['lease.report'] = () => ({ ok: true, result: arbitrationFixture() });
  const cmd = createLeaseCommand(ctx);
  const code = await cmd({ json: true, strategy: 'fifo', limit: '10' }, ['daemon', 'lease', 'report']);
  assert.equal(code, 0);
  assert.equal(state.rpc[0].method, 'lease.report');
  assert.deepEqual(state.rpc[0].params, { strategy: 'fifo', limit: 10 });
});

test('lease conflicts：过滤掉无冲突 verdict 后再输出', async () => {
  const { ctx, state } = makeCtx();
  state.json = true;
  const result = arbitrationFixture();
  result.verdicts = [
    ...result.verdicts,
    { tabId: 9, action: 'none', severity: 'info', conflictCodes: [], winner: null, losers: [], reportOnly: false, confidence: 1, steps: [], notes: [] },
  ];
  ctx.handlers['lease.report'] = () => ({ ok: true, result });
  const cmd = createLeaseCommand(ctx);
  const code = await cmd({ json: true }, ['daemon', 'lease', 'conflicts']);
  assert.equal(code, 0);
  const body = JSON.parse(state.stdout[0]);
  assert.equal(body.result.verdicts.length, 1);
  assert.equal(body.result.summary.filtered, true);
});

test('lease arbitrate：默认 dry-run，退出码 0 且不要求 --yes', async () => {
  const { ctx, state } = makeCtx();
  ctx.handlers['lease.arbitrate'] = (params) => ({ ok: true, result: arbitrationFixture({ applied: null, residual: null }) });
  const cmd = createLeaseCommand(ctx);
  const code = await cmd({ strategy: 'fifo' }, ['daemon', 'lease', 'arbitrate']);
  assert.equal(code, 0);
  assert.equal(state.rpc[0].params.apply, false);
  assert.equal(state.rpc[0].params.dryRun, true);
});

test('lease arbitrate --apply：缺 --yes 在本地拒绝；带 --yes 执行并按失败步骤给退出码', async () => {
  const { ctx, state } = makeCtx();
  const cmd = createLeaseCommand(ctx);
  await assert.rejects(cmd({ apply: true }, ['daemon', 'lease', 'arbitrate']), FakeArgError);
  assert.equal(state.rpc.length, 0, '本地拒绝时不得触达 daemon');
  ctx.handlers['lease.arbitrate'] = () => ({
    ok: true,
    result: arbitrationFixture({
      applied: { summary: { steps: 1, ok: 0, failed: 1, skipped: 0, unsupported: 0 }, applied: [], failed: [{ op: 'transfer', tabId: 1, code: 'E_INTERNAL', message: 'boom' }] },
      residual: { residualConflicts: 1, resolved: 0 },
    }),
  });
  const failedCode = await cmd({ apply: true, yes: true }, ['daemon', 'lease', 'arbitrate']);
  assert.equal(failedCode, 1);
  assert.equal(state.rpc[0].params.apply, true);
  assert.equal(state.rpc[0].params.dryRun, undefined, 'apply 时不强制 dryRun');
  ctx.handlers['lease.arbitrate'] = () => ({
    ok: true,
    result: arbitrationFixture({ applied: { summary: { steps: 1, ok: 1, failed: 0, skipped: 0, unsupported: 0 }, applied: [{ op: 'transfer', tabId: 1 }], failed: [] }, residual: { residualConflicts: 0, resolved: 1 } }),
  });
  assert.equal(await cmd({ apply: true, yes: true }, ['daemon', 'lease', 'arbitrate']), 0);
});

test('lease：人类输出含裁决摘要/执行结果；strict 失败退出 1', async () => {
  const { ctx, state } = makeCtx();
  const withReportOnly = arbitrationFixture({ summary: { ...arbitrationFixture().summary, reportOnly: 1 } });
  ctx.handlers['lease.report'] = () => ({ ok: true, result: withReportOnly });
  const cmd = createLeaseCommand(ctx);
  const code = await cmd({}, ['daemon', 'lease', 'report']);
  assert.equal(code, 0);
  const text = state.stdout.join('\n');
  assert.match(text, /租约裁决：/);
  assert.match(text, /report-only 冲突不会被自动修复/);
  // strict：result 缺 summary → schema 失败。
  const bad = makeCtx();
  bad.state.json = true;
  bad.ctx.handlers['lease.report'] = () => ({ ok: true, result: { kind: 'bridge/lease-arbitration', verdicts: [], steps: [] } });
  const badCmd = createLeaseCommand(bad.ctx);
  assert.equal(await badCmd({ json: true, strict: true }, ['daemon', 'lease', 'report']), 1);
  const failure = JSON.parse(bad.state.stdout[0]);
  assert.equal(failure.error.code, 'E_INTERNAL');
});

test('lease schema：列出/查询 schema（本地命令）', async () => {
  const { ctx, state } = makeCtx();
  state.json = true;
  const cmd = createLeaseCommand(ctx);
  assert.equal(await cmd({ json: true }, ['daemon', 'lease', 'schema']), 0);
  assert.equal(JSON.parse(state.stdout[0]).result.schemas.length, 5);
  await assert.rejects(cmd({ json: true }, ['daemon', 'lease', 'schema', 'nope/1']), FakeArgError);
});

test('lease：未知子命令是参数错误', async () => {
  const { ctx } = makeCtx();
  const cmd = createLeaseCommand(ctx);
  await assert.rejects(cmd({}, ['daemon', 'lease', 'steal']), FakeArgError);
});

test('命令层不修改传入 flags（纯读取）', async () => {
  const { ctx } = makeCtx();
  ctx.handlers['batch.quota'] = () => ({ ok: true, result: quotaFixture() });
  const flags = { limit: '10' };
  const snapshot = JSON.stringify(flags);
  await createBatchCommand(ctx)(flags, ['daemon', 'batch', 'quota']);
  assert.equal(JSON.stringify(flags), snapshot);
});
