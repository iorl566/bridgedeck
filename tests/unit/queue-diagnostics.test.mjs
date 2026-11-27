// tests/unit/queue-diagnostics.test.mjs —— daemon 命令队列的诊断输出（等待时长/拒绝原因/公平性）。
//
// 覆盖 daemon/command-queue.js 的 diagnostics()：
//   totals / inflight / fairness(tabs) / rejects 直方图 / 每会话 wait·queueWait·tabWait·inflightWait。
// 时间全部用注入时钟，断言可复现（不依赖真实 wall clock）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandQueue } from '../../daemon/command-queue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeQueue(limits = {}) {
  let clock = 1_700_000_000_000;
  const logs = [];
  const queue = createCommandQueue({ limits, now: () => clock, log: (line) => logs.push(line) });
  return {
    queue,
    logs,
    tick: (ms) => { clock += ms; },
    clock: () => clock,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('diagnostics 空队列：结构完整、默认上限与 capacity 与 lib 对齐', () => {
  const { queue } = makeQueue();
  const diagnostics = queue.diagnostics();
  assert.equal(diagnostics.capacity, 64);
  assert.equal(diagnostics.limits.maxPendingPerSession, 64);
  assert.equal(diagnostics.limits.maxInflight, 64);
  assert.deepEqual(diagnostics.sessions, []);
  assert.deepEqual(diagnostics.fairness.tabs, []);
  assert.equal(diagnostics.fairness.strategy, 'round-robin-per-tab');
  assert.equal(diagnostics.fairness.jainIndex, null);
  assert.equal(diagnostics.totals.dispatch, 0);
  assert.equal(diagnostics.totals.completed, 0);
  assert.equal(diagnostics.totals.rejected, 0);
  assert.deepEqual(diagnostics.rejects, { total: 0, byCode: {}, byReason: {} });
  assert.equal(diagnostics.inflight.current, 0);
  assert.equal(diagnostics.inflight.limit, 64);
  assert.deepEqual(diagnostics.inflight.global.name, 'global');
});

test('全局等待时长进入诊断：inflightWait/global.wait 记录真实排队耗时', async () => {
  const { queue, tick } = makeQueue({ maxInflight: 1 });
  const gate = deferred();
  const first = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => { await gate.promise; return 1; } });
  await sleep(5);
  const second = queue.dispatch({ sessionId: 's2', method: 'click', run: async () => 2 });
  await sleep(5);
  tick(500); // s2 在全局槽位上等待 500ms（注入时钟）
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  const diagnostics = queue.diagnostics();
  assert.equal(diagnostics.inflight.global.waited, 1);
  assert.equal(diagnostics.inflight.global.wait.maxMs, 500);
  assert.equal(diagnostics.inflight.wait.maxMs, 500);
  const s2 = diagnostics.sessions.find((item) => item.sessionId === 's2');
  assert.ok(s2);
  assert.equal(s2.inflightWait.maxMs, 500);
  assert.equal(s2.completed, 1);
  assert.equal(s2.inflightPeak, 1);
});

test('每会话等待/完成份额：wait p50·p95 与会话占比', async () => {
  const { queue, tick } = makeQueue();
  const gate = deferred();
  const blocker = queue.dispatch({ sessionId: 's1', tabKey: 'tab:5', method: 'click', run: async () => { await gate.promise; return 0; } });
  await sleep(5);
  const queued = queue.dispatch({ sessionId: 's1', tabKey: 'tab:5', method: 'fill', run: async () => { tick(20); return 1; } });
  await sleep(5);
  tick(120);
  gate.resolve();
  await Promise.all([blocker, queued]);
  const diagnostics = queue.diagnostics();
  const s1 = diagnostics.sessions.find((item) => item.sessionId === 's1');
  assert.equal(s1.completed, 2);
  assert.equal(s1.wait.samples, 2);
  assert.equal(s1.wait.maxMs >= 120, true, '第二条命令至少等了 120ms');
  assert.equal(s1.completedSharePercent, 100);
  assert.equal(diagnostics.totals.completedShareFairness, 1);
});

test('拒绝直方图：byCode/byReason/lastReject 与 log 证据', async () => {
  const { queue, logs } = makeQueue({ maxInflightPerSession: 1 });
  const gate = deferred();
  const bypass = queue.dispatch({ sessionId: 's1', method: 'operation.await', bypass: true, run: async () => gate.promise });
  await sleep(5);
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      queue.dispatch({ sessionId: 's1', tabKey: 'tab:1', method: 'click', run: async () => index }),
      (error) => error.code === 'E_SESSION_BUSY',
    );
  }
  gate.resolve();
  await bypass;
  const diagnostics = queue.diagnostics();
  assert.equal(diagnostics.rejects.total, 3);
  assert.equal(diagnostics.rejects.byCode.E_SESSION_BUSY, 3);
  assert.equal(diagnostics.rejects.byReason['session-inflight'], 3);
  assert.equal(diagnostics.totals.rejected, 3);
  assert.equal(diagnostics.totals.rejectRate > 0, true);
  const s1 = diagnostics.sessions[0];
  assert.equal(s1.rejected, 3);
  assert.equal(s1.lastReject.code, 'E_SESSION_BUSY');
  assert.equal(s1.lastReject.reason, 'session-inflight');
  assert.equal(s1.lastReject.method, 'click');
  assert.equal(typeof s1.lastReject.at, 'number');
  assert.equal(logs.some((line) => line.includes('queue 拒绝 E_SESSION_BUSY')), true);
});

test('全局等待超时（maxWaitMs）：E_QUEUE_FULL 并计数', async () => {
  const { queue } = makeQueue({ maxInflight: 1, maxWaitMs: 30 });
  const gate = deferred();
  const first = queue.dispatch({ sessionId: 's1', method: 'click', run: async () => { await gate.promise; return 1; } });
  await sleep(5);
  await assert.rejects(
    queue.dispatch({ sessionId: 's2', method: 'click', run: async () => 2 }),
    (error) => error.code === 'E_QUEUE_FULL' && error.data.gate === 'global',
  );
  gate.resolve();
  assert.equal(await first, 1);
  const diagnostics = queue.diagnostics();
  assert.equal(diagnostics.inflight.global.rejected, 1);
  assert.equal(diagnostics.rejects.byReason['global-wait-timeout'], 1);
});

test('tab 公平性指标：轮转下 maxConsecutive 受控，tabs 视图包含 queued/holder/waits', async () => {
  const { queue, tick } = makeQueue();
  const startOrder = [];
  const runFor = (name) => async () => { startOrder.push(name); tick(10); return name; };
  const tasks = [];
  for (let index = 0; index < 3; index += 1) {
    tasks.push(queue.dispatch({ sessionId: 's1', tabKey: 'tab:8', method: 'click', run: runFor('a' + index) }));
    tasks.push(queue.dispatch({ sessionId: 's2', tabKey: 'tab:8', method: 'click', run: runFor('b' + index) }));
  }
  await Promise.all(tasks);
  // 严格轮转：a0,b0,a1,b1,a2,b2（或 b 先起手，但不会一个会话连续两次）。
  for (let index = 1; index < startOrder.length; index += 1) {
    assert.notEqual(startOrder[index][0], startOrder[index - 1][0], '同一会话不应连续获得 tab：' + startOrder.join(','));
  }
  const diagnostics = queue.diagnostics();
  const tab = diagnostics.fairness.tabs.find((item) => item.tabKey === 'tab:8');
  assert.equal(tab.served, 6);
  assert.equal(tab.maxConsecutive, 1);
  assert.equal(tab.queued, 0);
  assert.equal(tab.holder, null);
  assert.equal(tab.fairness, 1, '两个会话各 3 次 → Jain 指数 1');
  assert.equal(diagnostics.fairness.maxConsecutive, 1);
  assert.equal(diagnostics.fairness.starvingTabs, 0);
  assert.equal(diagnostics.fairness.sessions, 2);
});

test('diagnostics 截断：limitSessions/tabLimit 生效且不丢汇总', async () => {
  const { queue } = makeQueue();
  for (const sessionId of ['s1', 's2', 's3']) {
    await queue.dispatch({ sessionId, tabKey: 'tab:' + sessionId, method: 'observe', run: async () => sessionId });
  }
  const diagnostics = queue.diagnostics({ limitSessions: 1, tabLimit: 1 });
  assert.equal(diagnostics.sessions.length, 1);
  assert.equal(diagnostics.sessionsTruncated, true);
  assert.equal(diagnostics.fairness.tabs.length, 1);
  assert.equal(diagnostics.fairness.tabsTruncated, true);
  assert.equal(diagnostics.totals.completed, 3);
  assert.equal(diagnostics.fairness.sessions, 3);
});

test('sessionState 只读拷贝：修改返回值不影响队列内部状态', async () => {
  const { queue } = makeQueue();
  await queue.dispatch({ sessionId: 's1', method: 'observe', run: async () => 1 });
  const state = queue.sessionState('s1');
  assert.equal(state.completed, 1);
  state.completed = 999;
  state.rejectReasons.injected = 1;
  assert.equal(queue.sessionState('s1').completed, 1);
  assert.equal(queue.sessionState('s1').rejectReasons.injected, undefined);
  assert.equal(queue.sessionState('missing'), null);
});
