// tests/unit/batch-sessions.test.mjs —— 批处理会话编排（daemon/batch-sessions.js）。
//
// 覆盖：
// - 条目/整批规格归一化（URL、share、key 幂等、优先级、重试、超时、quota 覆盖）；
// - 准入计划（dry-run）与配额交互；
// - 启动状态机：成功、失败、重试（退避可注入）、失败清理、abort / rollback / cancel；
// - 幂等（同一 batchId 复用）、保留上限、list/status/snapshot/reset；
// - 真实副作用边界：startSession/stopSession/navigate 全部为注入假实现，单测不启 daemon。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_DEFAULTS,
  BATCH_ITEM_STATES,
  BATCH_KIND,
  BATCH_ON_ERROR,
  BATCH_OUTCOMES,
  BATCH_PLAN_KIND,
  BATCH_SCHEMA,
  BATCH_STATES,
  BATCH_RETRYABLE_CODES,
  BatchSpecError,
  classifyBatchOutcome,
  createBatchSessions,
  isRetryableBatchError,
  normalizeBatchItem,
  normalizeBatchSpec,
} from '../../daemon/batch-sessions.js';
import { SESSION_QUOTA_DEFAULTS, createSessionQuota } from '../../daemon/session-quota.js';

const NOW = 1_700_000_000_000;

function makeHarness(options = {}) {
  const state = {
    now: NOW,
    live: 0,
    seq: 0,
    sessions: new Set(),
    calls: { start: [], stop: [], navigate: [], sleep: [] },
    active: 0,
    maxActive: 0,
    policy: { ...SESSION_QUOTA_DEFAULTS, maxSessions: 10, maxPerBatch: 4, maxConcurrentStarts: 2, ...(options.policy || {}) },
  };
  const now = () => state.now;
  const quota = createSessionQuota({ policy: state.policy, liveSessions: () => state.live, now });
  const startImpl = options.start || (async () => {
    state.seq += 1;
    const sessionId = 's' + state.seq;
    state.sessions.add(sessionId);
    state.live += 1;
    return { sessionId, tabId: 100 + state.seq, windowId: 1, url: 'about:blank', title: '' };
  });
  const stopImpl = options.stop || (async (params) => {
    const sessionId = params && params.session;
    if (sessionId && state.sessions.delete(sessionId)) state.live = Math.max(0, state.live - 1);
    return { ok: true, sessionId: sessionId || null };
  });
  const navigateImpl = options.navigate || (async (sessionId, url) => ({ ok: true, sessionId, url }));
  const batch = createBatchSessions({
    quota,
    startSession: async (params, timeoutMs) => {
      state.calls.start.push({ params: { ...params }, timeoutMs });
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (typeof options.delayStartMs === 'number' && options.delayStartMs > 0) {
          state.now += options.delayStartMs;
        }
        return await startImpl(params, timeoutMs);
      } finally {
        state.active -= 1;
      }
    },
    stopSession: async (params, timeoutMs) => {
      state.calls.stop.push({ params: { ...params }, timeoutMs });
      return stopImpl(params, timeoutMs);
    },
    navigate: async (sessionId, url, timeoutMs) => {
      state.calls.navigate.push({ sessionId, url, timeoutMs });
      return navigateImpl(sessionId, url, timeoutMs);
    },
    now,
    sleep: async (ms) => { state.calls.sleep.push(ms); state.now += ms; },
    idFactory: options.idFactory || (() => { state.seq += 1; return 'batch-' + state.seq; }),
    BridgeError: BatchSpecError,
    retention: options.retention,
  });
  return { state, quota, batch };
}

function items(count, extra = {}) {
  return Array.from({ length: count }, (_, index) => ({ url: 'https://e' + (index + 1) + '.example/', ...extra }));
}

// ---------------------------------------------------------------------------
// 条目 / 规格归一化
// ---------------------------------------------------------------------------

test('normalizeBatchItem：最小条目、URL、浏览器、label 与默认值', () => {
  const item = normalizeBatchItem({ url: 'https://a.example/path?q=1', browser: 'edge', label: '首页' }, 3);
  assert.equal(item.index, 3);
  assert.equal(item.url, 'https://a.example/path?q=1');
  assert.equal(item.browser, 'edge');
  assert.equal(item.label, '首页');
  assert.equal(item.share, false);
  assert.equal(item.tab, null);
  assert.equal(item.priority, 0);
  assert.equal(item.retries, null);
  assert.equal(item.timeoutMs, null);
  assert.equal(item.key, null);
  const bare = normalizeBatchItem({}, 0);
  assert.equal(bare.url, null);
  assert.equal(bare.browser, null);
});

test('normalizeBatchItem：url scheme/控制字符/超长拒绝', () => {
  assert.throws(() => normalizeBatchItem({ url: 'example.com' }), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchItem({ url: 'https://a.example/\u0000' }), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchItem({ url: 'https://a.example/' + 'x'.repeat(2100) }), (error) => error.code === 'E_BAD_ARG');
  assert.equal(normalizeBatchItem({ url: 'about:blank' }).url, 'about:blank');
});

test('normalizeBatchItem：share 需要整数 tab，且不能与 url 同时出现', () => {
  const shared = normalizeBatchItem({ share: true, tab: 7 }, 0);
  assert.equal(shared.share, true);
  assert.equal(shared.tab, 7);
  assert.throws(() => normalizeBatchItem({ share: true }, 0), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchItem({ share: true, tab: 'x' }, 0), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchItem({ share: true, tab: 7, url: 'https://a.example/' }, 0), (error) => error.code === 'E_BAD_ARG');
});

test('normalizeBatchItem：key/priority/retries/timeout 的边界与非法值', () => {
  assert.equal(normalizeBatchItem({ key: 'job.1:alpha' }, 0).key, 'job.1:alpha');
  assert.throws(() => normalizeBatchItem({ key: 'has space' }, 0), (error) => error.code === 'E_BAD_ARG');
  assert.equal(normalizeBatchItem({ priority: -10 }, 0).priority, -10);
  assert.equal(normalizeBatchItem({ priority: 10 }, 0).priority, 10);
  assert.throws(() => normalizeBatchItem({ priority: 11 }, 0), (error) => error.code === 'E_BAD_ARG');
  assert.equal(normalizeBatchItem({ retries: 3 }, 0).retries, 3);
  assert.throws(() => normalizeBatchItem({ retries: 4 }, 0), (error) => error.code === 'E_BAD_ARG');
  assert.equal(normalizeBatchItem({ timeoutMs: 5000 }, 0).timeoutMs, 5000);
  assert.throws(() => normalizeBatchItem({ timeoutMs: 10 }, 0), (error) => error.code === 'E_BAD_ARG');
  assert.equal(normalizeBatchItem({ unrelated: true }, 0).unrelated, undefined);
});

test('normalizeBatchSpec：默认值、并发夹取、onError 枚举', () => {
  const spec = normalizeBatchSpec({ items: items(2) }, { policy: { maxConcurrentStarts: 1 } });
  assert.equal(spec.items.length, 2);
  assert.equal(spec.onError, 'continue');
  assert.equal(spec.concurrency, 1, '请求并发不能超过 daemon 策略');
  assert.equal(spec.retries, 0);
  assert.equal(spec.timeoutMs, BATCH_DEFAULTS.itemTimeoutMs);
  assert.equal(spec.dryRun, false);
  assert.deepEqual(BATCH_ON_ERROR, ['continue', 'abort', 'rollback']);

  const explicit = normalizeBatchSpec({ items: items(1), concurrency: 2, retries: 2, timeoutMs: 5000, onError: 'ABORT' }, { policy: { maxConcurrentStarts: 4 } });
  assert.equal(explicit.concurrency, 2);
  assert.equal(explicit.retries, 2);
  assert.equal(explicit.timeoutMs, 5000);
  assert.equal(explicit.onError, 'abort');
});

test('normalizeBatchSpec：空条目/超量/重复 key/非法字段全部 E_BAD_ARG', () => {
  assert.throws(() => normalizeBatchSpec({}), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchSpec({ items: [] }), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchSpec({ items: items(3) }, { policy: { maxBatchItems: 2 } }), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchSpec({ items: [{ key: 'dup' }, { key: 'dup' }] }), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchSpec({ items: items(1), onError: 'nope' }), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchSpec({ items: items(1), concurrency: 0 }), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchSpec({ items: items(1), retries: 9 }), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchSpec({ items: items(1), batchId: 'bad id!' }), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeBatchSpec({ items: items(1), quota: 5 }), (error) => error.code === 'E_BAD_ARG');
});

test('normalizeBatchSpec：max 上限、batchId/group 透传、quota 覆盖只收紧', () => {
  const spec = normalizeBatchSpec({
    items: items(3),
    max: 2,
    batchId: 'job-1',
    group: 'matrix',
    quota: { maxPerBatch: 1, maxSessions: 1, reservationTtlMs: 1, nope: true },
  }, { policy: { maxPerBatch: 4, maxSessions: 6 } });
  assert.equal(spec.max, 2);
  assert.equal(spec.batchId, 'job-1');
  assert.equal(spec.group, 'matrix');
  assert.equal(spec.quotaPatch.policy.maxPerBatch, 1);
  assert.equal(spec.quotaPatch.policy.maxSessions, 1);
  assert.ok(spec.quotaPatch.ignored.some((item) => item.key === 'reservationTtlMs'));
});

test('isRetryableBatchError：只认已知瞬时错误码（大小写不敏感）', () => {
  for (const code of BATCH_RETRYABLE_CODES) assert.equal(isRetryableBatchError(code), true, code);
  assert.equal(isRetryableBatchError('e_timeout'), true);
  assert.equal(isRetryableBatchError('E_BAD_ARG'), false);
  assert.equal(isRetryableBatchError('E_FORBIDDEN'), false);
  assert.equal(isRetryableBatchError(undefined), false);
});

test('classifyBatchOutcome：ok/partial/failed/quota-denied/cancelled/rolled-back 全矩阵', () => {
  assert.equal(classifyBatchOutcome({ state: 'completed', summary: { total: 2, succeeded: 2, failed: 0, denied: 0 } }), 'ok');
  assert.equal(classifyBatchOutcome({ state: 'completed', summary: { total: 2, succeeded: 1, failed: 1, denied: 0 } }), 'partial');
  assert.equal(classifyBatchOutcome({ state: 'completed', summary: { total: 2, succeeded: 1, failed: 0, denied: 1 } }), 'partial');
  assert.equal(classifyBatchOutcome({ state: 'completed', summary: { total: 2, succeeded: 0, failed: 2, denied: 0 } }), 'failed');
  assert.equal(classifyBatchOutcome({ state: 'completed', summary: { total: 2, succeeded: 0, failed: 0, denied: 2 } }), 'quota-denied');
  assert.equal(classifyBatchOutcome({ state: 'cancelled', summary: { total: 2, cancelled: 2 } }), 'cancelled');
  assert.equal(classifyBatchOutcome({ state: 'rolled-back', summary: { total: 2 } }), 'rolled-back');
  assert.equal(classifyBatchOutcome({ state: 'completed', summary: { total: 0 } }), 'ok');
  assert.deepEqual(BATCH_OUTCOMES, ['ok', 'partial', 'failed', 'quota-denied', 'cancelled', 'rolled-back']);
});

test('模块常量：状态机/kind/schema 稳定（对外契约）', () => {
  assert.equal(BATCH_SCHEMA, 1);
  assert.equal(BATCH_KIND, 'bridge/session-batch');
  assert.equal(BATCH_PLAN_KIND, 'bridge/session-batch-plan');
  assert.deepEqual(BATCH_STATES, ['planning', 'running', 'completed', 'aborted', 'cancelled', 'rolled-back']);
  for (const state of ['pending', 'starting', 'succeeded', 'failed', 'denied', 'cancelled', 'skipped', 'rolled-back']) {
    assert.ok(BATCH_ITEM_STATES.includes(state), state);
  }
});

// ---------------------------------------------------------------------------
// plan（dry-run）
// ---------------------------------------------------------------------------

test('plan：不触碰配额与启动，返回条目准入与配额算式', () => {
  const { state, quota, batch } = makeHarness({ policy: { maxSessions: 4, maxPerBatch: 2 } });
  const plan = batch.plan({ items: items(3) });
  assert.equal(plan.schema, BATCH_SCHEMA);
  assert.equal(plan.kind, BATCH_PLAN_KIND);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.summary.total, 3);
  assert.equal(plan.summary.admissable, 2);
  assert.equal(plan.summary.denied, 1);
  assert.deepEqual(plan.items.map((item) => item.admission), ['admit', 'admit', 'deny']);
  assert.equal(plan.items[2].reason, 'quota-overflow');
  assert.equal(quota.outstanding(), 0);
  assert.equal(state.calls.start.length, 0);
  assert.ok(plan.warnings.some((warning) => warning.includes('2/3')));
});

test('plan：配额耗尽时全部 deny，并给出 quota-exhausted 原因', () => {
  const { quota, batch } = makeHarness({ policy: { maxSessions: 1, maxPerBatch: 1 } });
  quota.reserve('other', 1);
  const plan = batch.plan({ items: items(2) });
  assert.equal(plan.summary.admissable, 0);
  assert.equal(plan.summary.denied, 2);
  assert.ok(plan.items.every((item) => item.admission === 'deny' && item.reason === 'quota-exhausted'));
});

test('plan：share 条目带提示，quota.ignored 转为 warning', () => {
  const { batch } = makeHarness();
  const plan = batch.plan({ items: [{ share: true, tab: 5 }], quota: { reservationTtlMs: 10 } });
  assert.ok(plan.warnings.some((warning) => warning.includes('share=true')));
  assert.ok(plan.warnings.some((warning) => warning.includes('quota')));
});

// ---------------------------------------------------------------------------
// start：成功路径
// ---------------------------------------------------------------------------

test('start：两条带 url 的条目成功启动 + 导航，配额提交并收尾', async () => {
  const { state, quota, batch } = makeHarness();
  const report = await batch.start({ items: items(2) });
  assert.equal(report.state, 'completed');
  assert.equal(report.outcome, 'ok');
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.succeeded, 2);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.admitted, 2);
  assert.equal(report.summary.navigated, 2);
  assert.equal(report.quota.requested, 2);
  assert.equal(report.quota.committed, 2);
  assert.equal(state.live, 2);
  assert.equal(state.calls.navigate.length, 2);
  assert.equal(state.calls.navigate[0].url, 'https://e1.example/');
  assert.ok(report.items.every((item) => item.state === 'succeeded' && item.sessionId));
  assert.ok(report.items.every((item) => item.startedAt >= NOW && item.durationMs >= 0));
  assert.equal(quota.snapshot().totals.used, 2);
  assert.equal(quota.outstanding(), 0);
});

test('start：条目参数按 share/tab/browser/label 透传给 startSession', async () => {
  const { state, batch } = makeHarness();
  await batch.start({ items: [{ share: true, tab: 9, browser: 'edge', label: '共享' }] });
  const call = state.calls.start[0];
  assert.equal(call.params.share, true);
  assert.equal(call.params.tab, 9);
  assert.equal(call.params.browser, 'edge');
  assert.equal(call.params.url, undefined);
  assert.equal(call.timeoutMs, BATCH_DEFAULTS.itemTimeoutMs);
});

test('start：每个条目的 timeoutMs 覆盖整批默认值', async () => {
  const { state, batch } = makeHarness();
  await batch.start({ items: [{ url: 'https://a.example/', timeoutMs: 7000 }], timeoutMs: 3000 });
  assert.equal(state.calls.start[0].timeoutMs, 7000);
  const second = makeHarness();
  await second.batch.start({ items: [{ url: 'https://a.example/' }], timeoutMs: 3000 });
  assert.equal(second.state.calls.start[0].timeoutMs, 3000);
});

test('start：并发受 concurrency 限制（观测最大并行数）', async () => {
  const { state, batch } = makeHarness({ policy: { maxConcurrentStarts: 4 } });
  await batch.start({ items: items(4), concurrency: 2 });
  assert.equal(state.maxActive, 2, '并发不能超过 2');
  assert.equal(state.calls.start.length, 4);
});

test('start：部分条目被配额拒绝 → outcome partial，denied 条目带 E_QUEUE_FULL', async () => {
  const { state, batch } = makeHarness({ policy: { maxSessions: 6, maxPerBatch: 2 } });
  const report = await batch.start({ items: items(3) });
  assert.equal(report.state, 'completed');
  assert.equal(report.outcome, 'partial');
  assert.equal(report.summary.succeeded, 2);
  assert.equal(report.summary.denied, 1);
  assert.equal(state.calls.start.length, 2);
  const denied = report.items.find((item) => item.state === 'denied');
  assert.equal(denied.error.code, 'E_QUEUE_FULL');
  assert.equal(denied.admission, 'denied');
});

test('start：全部被配额拒绝 → outcome quota-denied，不调用 startSession', async () => {
  const { state, quota, batch } = makeHarness({ policy: { maxSessions: 1, maxPerBatch: 1 } });
  quota.reserve('holder', 1);
  const report = await batch.start({ items: items(1) });
  assert.equal(report.outcome, 'quota-denied');
  assert.equal(report.summary.denied, 1);
  assert.equal(state.calls.start.length, 0);
  assert.equal(report.items[0].error.code, 'E_QUEUE_FULL');
  assert.equal(report.quota.granted, 0);
  // 批次自己的预约被 finalize，其余批次不受影响。
  assert.equal(quota.get('holder').state, 'reserved');
});

test('start：dryRun 等价 plan（不启动、不 reserve）', async () => {
  const { state, quota, batch } = makeHarness();
  const plan = await batch.start({ items: items(2), dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.kind, BATCH_PLAN_KIND);
  assert.equal(state.calls.start.length, 0);
  assert.equal(quota.outstanding(), 0);
});

test('start：同一 batchId 幂等复用，不重复启动', async () => {
  const { state, batch } = makeHarness();
  const first = await batch.start({ items: items(1), batchId: 'idem-1' });
  const second = await batch.start({ items: items(1), batchId: 'idem-1' });
  assert.equal(first.batchId, 'idem-1');
  assert.equal(second.reused, true);
  assert.equal(second.batchId, 'idem-1');
  assert.equal(state.calls.start.length, 1);
  assert.equal(second.summary.succeeded, 1);
});

// ---------------------------------------------------------------------------
// start：失败、清理、重试
// ---------------------------------------------------------------------------

test('start：startSession 抛错 → 条目 failed，状态 failed，配额释放', async () => {
  const { quota, batch } = makeHarness({
    start: async () => { throw Object.assign(new Error('没有浏览器'), { code: 'E_NO_BROWSER' }); },
  });
  const report = await batch.start({ items: items(1) });
  assert.equal(report.outcome, 'failed');
  assert.equal(report.items[0].state, 'failed');
  assert.equal(report.items[0].error.code, 'E_NO_BROWSER');
  assert.equal(report.quota.released, 1);
  assert.equal(quota.outstanding(), 0);
});

test('start：startSession 未返回 sessionId → 条目 failed E_INTERNAL', async () => {
  const { batch } = makeHarness({ start: async () => ({}) });
  const report = await batch.start({ items: items(1) });
  assert.equal(report.items[0].error.code, 'E_INTERNAL');
  assert.equal(report.outcome, 'failed');
});

test('start：导航失败会 stop 已建会话并释放名额（失败清理）', async () => {
  const { state, quota, batch } = makeHarness({
    navigate: async () => { throw Object.assign(new Error('导航失败'), { code: 'E_TIMEOUT' }); },
  });
  const report = await batch.start({ items: items(1) });
  assert.equal(report.items[0].state, 'failed');
  assert.equal(report.items[0].cleanup, 'stopped');
  assert.equal(state.calls.stop.length, 1);
  assert.equal(state.live, 0, '失败会话应被停止');
  assert.equal(report.quota.committed, 0);
  assert.equal(quota.outstanding(), 0);
});

test('start：没有 navigate 能力时带 url 的条目显式失败（不静默忽略）', async () => {
  const quota = createSessionQuota({ policy: { maxSessions: 4 }, liveSessions: () => 0, now: () => NOW });
  const batch = createBatchSessions({
    quota,
    startSession: async () => ({ sessionId: 's1' }),
    stopSession: async () => ({ ok: true }),
    navigate: null,
    now: () => NOW,
    BridgeError: BatchSpecError,
    idFactory: () => 'no-nav',
  });
  const report = await batch.start({ items: items(1) });
  assert.equal(report.items[0].error.code, 'E_UNSUPPORTED');
});

test('start：瞬时错误按退避重试直到成功（sleep 可注入）', async () => {
  let attempts = 0;
  const { state, batch } = makeHarness({
    start: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('超时'), { code: 'E_TIMEOUT' });
      state.live += 1;
      return { sessionId: 's-retry' };
    },
    navigate: async () => ({ ok: true }),
  });
  const report = await batch.start({ items: items(1), retries: 2 });
  assert.equal(attempts, 3);
  assert.equal(report.items[0].attempts, 3);
  assert.equal(report.items[0].state, 'succeeded');
  assert.equal(report.summary.retried, 2);
  assert.deepEqual(state.calls.sleep, [20, 40], '指数退避 20ms/40ms');
  assert.equal(report.outcome, 'ok');
});

test('start：不可重试错误立即失败（不消耗重试次数）', async () => {
  let attempts = 0;
  const { batch } = makeHarness({
    start: async () => {
      attempts += 1;
      throw Object.assign(new Error('参数错误'), { code: 'E_BAD_ARG' });
    },
  });
  const report = await batch.start({ items: items(1), retries: 3 });
  assert.equal(attempts, 1);
  assert.equal(report.items[0].attempts, 1);
  assert.equal(report.items[0].error.code, 'E_BAD_ARG');
});

test('start：重试耗尽后失败，并清理最后一次创建的会话', async () => {
  let attempts = 0;
  let harness = null;
  harness = makeHarness({
    start: async () => {
      attempts += 1;
      const sessionId = 's-fail-' + attempts;
      harness.state.live += 1;
      harness.state.sessions.add(sessionId);
      return { sessionId };
    },
    navigate: async () => { throw Object.assign(new Error('导航失败'), { code: 'E_TIMEOUT' }); },
  });
  const { state, batch } = harness;
  const report = await batch.start({ items: items(1), retries: 1 });
  assert.equal(attempts, 2);
  assert.equal(report.items[0].state, 'failed');
  assert.equal(state.calls.stop.length, 2, '每次尝试的会话都要清理');
  assert.equal(state.live, 0);
});

// ---------------------------------------------------------------------------
// onError：abort / rollback
// ---------------------------------------------------------------------------

test('onError=abort：首次失败后不再调度，其余条目标记 skipped', async () => {
  let calls = 0;
  const { state, batch } = makeHarness({
    start: async () => {
      calls += 1;
      throw Object.assign(new Error('失败'), { code: 'E_NO_BROWSER' });
    },
  });
  const report = await batch.start({ items: items(3), onError: 'abort', concurrency: 1 });
  assert.equal(report.state, 'aborted');
  assert.equal(calls, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.skipped, 2);
  assert.equal(report.abortReason.policy, 'abort');
  assert.ok(report.items.slice(1).every((item) => item.state === 'skipped' && item.error.code === 'E_CANCELLED'));
});

test('onError=rollback：回收本批已建会话，状态 rolled-back', async () => {
  let index = 0;
  let harness = null;
  harness = makeHarness({
    start: async () => {
      index += 1;
      if (index === 2) throw Object.assign(new Error('第二个失败'), { code: 'E_NO_BROWSER' });
      const sessionId = 'ok-' + index;
      harness.state.live += 1;
      harness.state.sessions.add(sessionId);
      return { sessionId };
    },
  });
  const { state, batch } = harness;
  const report = await batch.start({ items: items(2), onError: 'rollback', concurrency: 1 });
  assert.equal(report.state, 'rolled-back');
  assert.equal(report.outcome, 'rolled-back');
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.rolledBack, 1);
  assert.equal(report.rollback.requested, true);
  assert.equal(report.rollback.attempted, 1);
  assert.equal(report.rollback.stopped, 1);
  assert.equal(state.calls.stop.length, 1);
  assert.equal(state.live, 0);
  const rolled = report.items.find((item) => item.state === 'rolled-back');
  assert.equal(rolled.sessionId, 'ok-1');
});

test('onError=rollback：清理失败被记录但不影响其余回滚', async () => {
  let index = 0;
  const { batch } = makeHarness({
    start: async () => {
      index += 1;
      if (index === 2) throw Object.assign(new Error('失败'), { code: 'E_NO_BROWSER' });
      return { sessionId: 'ok-' + index };
    },
    stop: async () => { throw Object.assign(new Error('停止失败'), { code: 'E_INTERNAL' }); },
  });
  const report = await batch.start({ items: items(2), onError: 'rollback', concurrency: 1 });
  assert.equal(report.rollback.failed, 1);
  assert.equal(report.rollback.stopped, 0);
  assert.equal(report.rollback.errors[0].code, 'E_INTERNAL');
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('cancel：运行中取消，后续条目不启动/标记 cancelled', async () => {
  const gate = deferred();
  let started = 0;
  const { batch } = makeHarness({
    start: async () => {
      started += 1;
      if (started === 1) await gate.promise;
      return { sessionId: 's-cancel-' + started };
    },
  });
  const running = batch.start({ items: items(3), concurrency: 1 });
  // 等到第一个条目进入 startSession 后再取消。
  await new Promise((resolve) => setImmediate(resolve));
  const cancelResult = batch.cancel('batch-1');
  assert.equal(cancelResult.ok, true);
  assert.equal(cancelResult.cancelled, true);
  gate.resolve();
  const report = await running;
  assert.equal(report.state, 'cancelled');
  assert.equal(report.cancelled, true);
  assert.ok(report.items.filter((item) => item.state === 'cancelled').length >= 2);
});

test('cancel：未知 batchId 返回 E_NOT_FOUND；已结束批次返回 cancelled=false', async () => {
  const { batch } = makeHarness();
  assert.equal(batch.cancel('missing').code, 'E_NOT_FOUND');
  await batch.start({ items: items(1), batchId: 'done-batch' });
  const late = batch.cancel('done-batch');
  assert.equal(late.ok, true);
  assert.equal(late.cancelled, false);
  assert.equal(late.reason, 'already-finished');
});

// ---------------------------------------------------------------------------
// status / list / snapshot / retention / reset
// ---------------------------------------------------------------------------

test('status：未知批次返回 null，已存在批次返回完整视图', async () => {
  const { batch } = makeHarness();
  assert.equal(batch.status('missing'), null);
  await batch.start({ items: items(1), batchId: 'view-me', group: 'g1' });
  const view = batch.status('view-me');
  assert.equal(view.batchId, 'view-me');
  assert.equal(view.group, 'g1');
  assert.equal(view.state, 'completed');
  assert.equal(view.items.length, 1);
  assert.equal(view.schema, BATCH_SCHEMA);
});

test('list：状态过滤/limit/汇总 totals/truncated', async () => {
  const { batch } = makeHarness();
  await batch.start({ items: items(1), batchId: 'a-1' });
  await batch.start({ items: [{ url: 'https://fail.example/' }], batchId: 'b-2', start: undefined });
  const all = batch.list({ limit: 50 });
  assert.equal(all.totals.batches >= 2, true);
  assert.equal(all.batches.length >= 2, true);
  assert.ok(Array.isArray(all.batches));
  const limited = batch.list({ limit: 1 });
  assert.equal(limited.batches.length, 1);
  assert.equal(limited.truncated, true);
  const none = batch.list({ state: 'nope' });
  assert.equal(none.batches.length, 0);
});

test('snapshot：配额/最近批次/总计/计数器齐全（status 视图用）', async () => {
  const { batch } = makeHarness();
  await batch.start({ items: items(1), batchId: 'snap-1' });
  const snapshot = batch.snapshot({ limit: 5 });
  assert.equal(snapshot.kind, BATCH_KIND);
  assert.equal(snapshot.quota.schema, 1);
  assert.equal(snapshot.quota.policy.maxSessions, 10);
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.totals.batches, 1);
  assert.equal(snapshot.totals.succeeded, 1);
  assert.equal(typeof snapshot.counters.started, 'number');
  assert.deepEqual(snapshot.running, []);
});

test('retention：超过保留上限时回收最旧的已结束批次，运行中的不动', async () => {
  const { batch } = makeHarness({ retention: 2 });
  for (let index = 0; index < 4; index += 1) {
    await batch.start({ items: items(1), batchId: 'keep-' + index });
  }
  const list = batch.list({ limit: 10 });
  assert.ok(list.totals.batches <= 2, '保留上限 2，实际 ' + list.totals.batches);
  assert.ok(batch.status('keep-3'));
  assert.equal(batch.status('keep-0'), null);
});

test('reset：清空批次与计数器', async () => {
  const { batch } = makeHarness();
  await batch.start({ items: items(1), batchId: 'r-1' });
  batch.reset();
  assert.equal(batch.size, 0);
  assert.equal(batch.list({}).totals.batches, 0);
  assert.equal(batch.counters.started, 0);
});

test('createBatchSessions：缺 quota/startSession/stopSession 时快速失败', () => {
  assert.throws(() => createBatchSessions({}), /quota/);
  assert.throws(() => createBatchSessions({ quota: { reserve() {} } }), /startSession/);
  assert.throws(() => createBatchSessions({ quota: { reserve() {} }, startSession() {} }), /stopSession/);
});

test('normalizeBatchSpec 方法：实例上可用且使用当前策略', () => {
  const { batch } = makeHarness({ policy: { maxConcurrentStarts: 1 } });
  const spec = batch.normalizeBatchSpec({ items: items(1), concurrency: 3 });
  assert.equal(spec.concurrency, 1);
});
