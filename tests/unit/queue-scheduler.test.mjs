// tests/unit/queue-scheduler.test.mjs —— daemon 命令队列：会话串行、tab 轮转公平、上限与 drop。
//
// 覆盖 daemon/command-queue.js 的调度语义：
//   1) 同一 session 严格串行且保持提交顺序（与 lib/session-queue.mjs 一致）；
//   2) 同一 tab 上多会话按轮转而非 FIFO（一个会话压 50 条不会饿死另一个）；
//   3) 全局 inflight 上限 / per-session inflight 上限 / per-session 排队上限；
//   4) drop('tab:x') / drop(sessionId) 与队列外旁路方法；
//   5) 结果/异常透传与计数。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUE_DEFAULT_LIMITS,
  QueueLimitError,
  computeWaitStats,
  createCommandQueue,
  jainFairnessIndex,
  normalizeQueueLimits,
  queueLimitsFromEnv,
} from '../../daemon/command-queue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeQueue(options = {}) {
  let clock = 1_000_000;
  const queue = createCommandQueue({
    limits: options.limits || {},
    now: () => clock,
    log: options.log || (() => {}),
  });
  return {
    queue,
    tick: (ms = 10) => { clock += ms; },
    clock: () => clock,
  };
}

test('同一 session 串行且保持提交顺序（与 lib session-queue 一致）', async () => {
  const { queue, tick } = makeQueue();
  const order = [];
  const gate = deferred();
  const first = queue.dispatch({
    sessionId: 's1', tabKey: 'tab:7', method: 'click', run: async () => { order.push('first-start'); tick(5); await gate.promise; order.push('first-end'); return 1; },
  });
  const second = queue.dispatch({
    sessionId: 's1', tabKey: 'tab:7', method: 'fill', run: async () => { order.push('second'); return 2; },
  });
  const third = queue.dispatch({
    sessionId: 's1', tabKey: 'tab:7', method: 'press', run: async () => { order.push('third'); return 3; },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ['first-start'], '第二条命令必须等第一条完成');
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 3]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second', 'third']);
});

test('不同 session 可并发（全局 inflight 上限内）', async () => {
  const { queue } = makeQueue();
  const started = [];
  const gates = [deferred(), deferred()];
  const a = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => { started.push('s1'); await gates[0].promise; return 'a'; } });
  const b = queue.dispatch({ sessionId: 's2', method: 'click', run: async () => { started.push('s2'); await gates[1].promise; return 'b'; } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started.sort(), ['s1', 's2'], '两个会话应同时在跑');
  gates[0].resolve();
  gates[1].resolve();
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
});

test('全局 inflight 上限：超出后排队，槽位释放后继续（不拒绝）', async () => {
  const { queue } = makeQueue({ limits: { maxInflight: 1 } });
  const started = [];
  const gate = deferred();
  const first = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => { started.push('s1:start'); await gate.promise; return 1; } });
  const second = queue.dispatch({ sessionId: 's2', method: 'click', run: async () => { started.push('s2:start'); return 2; } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, ['s1:start'], '全局槽位只有 1 个时第二个会话必须等');
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(started, ['s1:start', 's2:start']);
  const diagnostics = queue.diagnostics();
  assert.equal(diagnostics.inflight.limit, 1);
  assert.equal(diagnostics.inflight.peak, 1);
  assert.equal(diagnostics.totals.completed, 2);
});

test('同一 tab 多会话轮转公平：一个会话连压命令不会让另一个饿死', async () => {
  const { queue, tick } = makeQueue();
  const startOrder = [];
  const runFor = (name) => async () => { startOrder.push(name); tick(5); return name; };
  // s1 一次压 3 条、s2 压 1 条（全部同一 tab）。旧的两层 FIFO 会让 b 等到 a3 之后。
  const tasks = [
    queue.dispatch({ sessionId: 's1', tabKey: 'tab:9', method: 'click', run: runFor('a1') }),
    queue.dispatch({ sessionId: 's1', tabKey: 'tab:9', method: 'click', run: runFor('a2') }),
    queue.dispatch({ sessionId: 's1', tabKey: 'tab:9', method: 'click', run: runFor('a3') }),
    queue.dispatch({ sessionId: 's2', tabKey: 'tab:9', method: 'click', run: runFor('b1') }),
  ];
  await Promise.all(tasks);
  assert.deepEqual(startOrder, ['a1', 'b1', 'a2', 'a3'], '第二个会话应在第一个会话的下一条命令之前获得 tab');
  const diagnostics = queue.diagnostics();
  const tab = diagnostics.fairness.tabs.find((item) => item.tabKey === 'tab:9');
  assert.ok(tab);
  assert.equal(tab.served, 4);
  assert.deepEqual(tab.queuedSessions, []);
  assert.equal(diagnostics.fairness.strategy, 'round-robin-per-tab');
});

test('per-session inflight 上限：旁路方法占满后，排队命令被拒（E_SESSION_BUSY）', async () => {
  const { queue } = makeQueue({ limits: { maxInflightPerSession: 1 } });
  const gate = deferred();
  const bypass = queue.dispatch({ sessionId: 's1', method: 'operation.await', bypass: true, run: async () => { await gate.promise; return 'await-done'; } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    queue.dispatch({ sessionId: 's1', tabKey: 'tab:1', method: 'click', run: async () => 'click' }),
    (error) => error instanceof QueueLimitError
      && error.code === 'E_SESSION_BUSY'
      && error.data.reason === 'session-inflight'
      && error.data.sessionId === 's1',
  );
  gate.resolve();
  assert.equal(await bypass, 'await-done');
  const session = queue.sessionState('s1');
  assert.equal(session.rejected, 1);
  assert.equal(session.rejectReasons['session-inflight'], 1);
  assert.equal(session.lastReject.code, 'E_SESSION_BUSY');
});

test('per-session 排队上限：达到上限返回 E_QUEUE_FULL（与 lib 错误码一致）并记录原因', async () => {
  const { queue } = makeQueue({ limits: { maxPendingPerSession: 2 } });
  const gate = deferred();
  const blocker = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => { await gate.promise; return 1; } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const queued1 = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => 2 });
  const queued2 = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => 3 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    queue.dispatch({ sessionId: 's1', method: 'click', run: async () => 4 }),
    (error) => error.code === 'E_QUEUE_FULL' && error.data.reason === 'session-pending',
  );
  gate.resolve();
  assert.deepEqual(await Promise.all([blocker, queued1, queued2]), [1, 2, 3]);
  // 拒绝后队列仍能继续接受命令（计数已回退）。
  assert.equal(await queue.dispatch({ sessionId: 's1', method: 'click', run: async () => 5 }), 5);
});

test('全局排队上限：E_QUEUE_FULL reason=global-pending', async () => {
  const { queue } = makeQueue({ limits: { maxPendingGlobal: 1, maxPendingPerSession: 8 } });
  const gate = deferred();
  const blocker = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => { await gate.promise; return 1; } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const waiting = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => 2 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    queue.dispatch({ sessionId: 's2', method: 'click', run: async () => 3 }),
    (error) => error.code === 'E_QUEUE_FULL' && error.data.reason === 'global-pending',
  );
  gate.resolve();
  assert.deepEqual(await Promise.all([blocker, waiting]), [1, 2]);
});

test('drop(sessionId)：之后的命令 E_SESSION_STOPPED；已接受的排队命令不再执行', async () => {
  const { queue } = makeQueue();
  const gate = deferred();
  let ran = 0;
  const running = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => { await gate.promise; return 'running'; } });
  const queued = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => { ran += 1; return 'queued'; } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  queue.drop('s1');
  await assert.rejects(queue.dispatch({ sessionId: 's1', method: 'click', run: async () => 'new' }), (error) => error.code === 'E_SESSION_STOPPED');
  gate.resolve();
  assert.equal(await running, 'running');
  await assert.rejects(queued, (error) => error.code === 'E_SESSION_STOPPED');
  assert.equal(ran, 0, '会话停止后排队命令不应再真正执行');
});

test('drop("tab:xx")：该 tab 后续命令 E_SESSION_STOPPED，其他 tab 不受影响', async () => {
  const { queue } = makeQueue();
  const gate = deferred();
  const holder = queue.dispatch({ sessionId: 's1', tabKey: 'tab:3', method: 'click', run: async () => { await gate.promise; return 'held'; } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  queue.drop('tab:3');
  await assert.rejects(
    queue.dispatch({ sessionId: 's2', tabKey: 'tab:3', method: 'click', run: async () => 1 }),
    (error) => error.code === 'E_SESSION_STOPPED' && error.data.reason === 'tab-closed',
  );
  gate.resolve();
  assert.equal(await holder, 'held');
  // 另一 tab 正常；同一会话也可继续用别的 tab。
  assert.equal(await queue.dispatch({ sessionId: 's2', tabKey: 'tab:4', method: 'click', run: async () => 2 }), 2);
});

test('旁路方法不排队、不占全局槽位；不同会话互不影响', async () => {
  // 用 maxInflight=1 让排队路径互相阻塞，旁路仍应立即执行。
  const { queue } = makeQueue({ limits: { maxInflight: 1 } });
  const started = [];
  const gate = deferred();
  const longRunning = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => { started.push('queued-start'); await gate.promise; return 'queued'; } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const bypassed = await queue.dispatch({ sessionId: 's1', method: 'operation.await', bypass: true, run: async () => { started.push('bypass'); return 'bypass'; } });
  assert.equal(bypassed, 'bypass');
  assert.deepEqual(started, ['queued-start', 'bypass']);
  const diagnostics = queue.diagnostics();
  assert.equal(diagnostics.totals.bypass, 1);
  gate.resolve();
  await longRunning;
});

test('结果与异常透传：失败计入 totals.failed，不影响后续命令', async () => {
  const { queue } = makeQueue();
  await assert.rejects(
    queue.dispatch({ sessionId: 's1', tabKey: 'tab:1', method: 'click', run: async () => { throw Object.assign(new Error('boom'), { code: 'E_TIMEOUT' }); } }),
    (error) => error.code === 'E_TIMEOUT',
  );
  assert.equal(await queue.dispatch({ sessionId: 's1', tabKey: 'tab:1', method: 'observe', run: async () => 'ok' }), 'ok');
  const diagnostics = queue.diagnostics();
  assert.equal(diagnostics.totals.failed, 1);
  assert.equal(diagnostics.totals.completed, 1);
  const session = queue.sessionState('s1');
  assert.equal(session.failed, 1);
  assert.equal(session.completed, 1);
});

test('enqueue(sessionId, task) 兼容 lib API；snapshot() 保持 lib 数组形状', async () => {
  const { queue } = makeQueue();
  const snapshotEmpty = queue.snapshot();
  assert.deepEqual(snapshotEmpty, []);
  const gate = deferred();
  const first = queue.enqueue('s1', async () => { await gate.promise; return 1; });
  const second = queue.enqueue('s1', async () => 2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const snapshot = queue.snapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].sessionId, 's1');
  assert.equal(snapshot[0].pending >= 1, true);
  assert.equal(snapshot[0].closed, false);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(queue.capacity, QUEUE_DEFAULT_LIMITS.capacity);
});

test('normalizeQueueLimits / queueLimitsFromEnv：默认值与坏值回退', async () => {
  const defaults = normalizeQueueLimits();
  assert.equal(defaults.capacity, 64);
  assert.equal(defaults.maxInflight, QUEUE_DEFAULT_LIMITS.maxInflight);
  const custom = normalizeQueueLimits({ capacity: 8, maxInflight: 2, maxWaitMs: 500 });
  assert.equal(custom.capacity, 8);
  assert.equal(custom.maxInflight, 2);
  assert.equal(custom.maxWaitMs, 500);
  const bad = normalizeQueueLimits({ capacity: 0, maxInflight: -3, maxWaitMs: 'x' });
  assert.equal(bad.capacity, 64);
  assert.equal(bad.maxInflight, QUEUE_DEFAULT_LIMITS.maxInflight);
  assert.equal(bad.maxWaitMs, 0);
  const env = queueLimitsFromEnv({ BB_QUEUE_CAPACITY: '4', BB_QUEUE_MAX_INFLIGHT: '2', BB_QUEUE_MAX_WAIT_MS: '250' });
  assert.equal(env.capacity, 4);
  assert.equal(env.maxInflight, 2);
  assert.equal(env.maxWaitMs, 250);
  assert.deepEqual(queueLimitsFromEnv({}), QUEUE_DEFAULT_LIMITS);
});

test('computeWaitStats / jainFairnessIndex：P50/P95/分桶与公平指数', () => {
  assert.deepEqual(computeWaitStats([]), { samples: 0, avgMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, buckets: { lt10: 0, lt100: 0, lt1s: 0, lt5s: 0, gte5s: 0 } });
  const stats = computeWaitStats([1, 5, 20, 150, 1200, 7000]);
  assert.equal(stats.samples, 6);
  assert.equal(stats.maxMs, 7000);
  assert.equal(stats.p50Ms, 20);
  assert.equal(stats.p95Ms, 7000);
  assert.deepEqual(stats.buckets, { lt10: 2, lt100: 1, lt1s: 1, lt5s: 1, gte5s: 1 });
  assert.equal(jainFairnessIndex([1, 1, 1, 1]), 1);
  assert.equal(jainFairnessIndex([10, 0]), 0.5);
  assert.equal(jainFairnessIndex([]), null);
  assert.equal(jainFairnessIndex([0, 0]), 1);
});
