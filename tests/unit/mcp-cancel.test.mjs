// tests/unit/mcp-cancel.test.mjs —— MCP 取消面：在途登记、超时、取消竞态、daemon 转发。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCEL_ERRORS,
  DEFAULT_MAX_REMOTE_CANCELS,
  cancelledError,
  createCallRegistry,
  raceToolCall,
  remoteCancelEnabled,
  timeoutError,
} from '../../mcp/cancel.mjs';

function fakeRpc({ inflight = [], failInflight = null, failCancel = new Set(), accepted = true } = {}) {
  const calls = [];
  const cancelled = [];
  return {
    calls,
    cancelled,
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'inflight.list') {
        if (failInflight) throw failInflight;
        return { inflight };
      }
      if (method === 'command.cancel') {
        if (failCancel.has(params.id)) throw Object.assign(new Error('命令已结束'), { code: 'E_NOT_FOUND' });
        cancelled.push(params.id);
        return { id: params.id, forwarded: true, accepted };
      }
      throw new Error('未预期的 daemon 方法：' + method);
    },
  };
}

function pendingPromise(ms = 5_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

test('错误构造：E_CANCELLED 带 reason/tool；E_TIMEOUT 文案与旧兜底一致', () => {
  const cancelled = cancelledError('browser_observe', '用户按下停止');
  assert.equal(cancelled.code, CANCEL_ERRORS.CANCELLED);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.tool, 'browser_observe');
  assert.equal(cancelled.reason, '用户按下停止');
  assert.match(cancelled.message, /已被客户端取消/);

  const timeout = timeoutError('browser_observe', 60_000);
  assert.equal(timeout.code, CANCEL_ERRORS.TIMEOUT);
  assert.equal(timeout.message, '工具 browser_observe 超过 60000ms 未返回');
});

test('在途登记：register/has/snapshot/release 与计数', () => {
  const registry = createCallRegistry({ now: () => 1_000 });
  const call = registry.register(7, { tool: 'browser_observe', methods: ['observe', 'dialog.status'] });
  assert.equal(call.id, 7);
  assert.equal(call.cancelled, false);
  assert.equal(registry.has(7), true);
  let snapshot = registry.snapshot();
  assert.equal(snapshot.inflightCount, 1);
  assert.equal(snapshot.inflight[0].tool, 'browser_observe');
  assert.deepEqual(snapshot.inflight[0].methods, ['observe', 'dialog.status']);
  assert.equal(snapshot.inflight[0].elapsedMs, 0);
  assert.equal(snapshot.counters.registered, 1);
  assert.equal(snapshot.remoteEnabled, false, '没有 rpc 时不应声称可向 daemon 转发');
  registry.release(7);
  assert.equal(registry.has(7), false);
  snapshot = registry.snapshot();
  assert.equal(snapshot.inflightCount, 0);
  assert.equal(snapshot.counters.released, 1);
  registry.release(7); // 幂等
  assert.equal(registry.snapshot().counters.released, 1);
});

test('取消未知请求：按规范静默忽略并计数', async () => {
  const registry = createCallRegistry({ now: () => 1_000 });
  const report = await registry.cancel(999, '迟到的取消');
  assert.equal(report.found, false);
  assert.equal(report.local, false);
  assert.equal(registry.snapshot().counters.unknownCancelled, 1);
});

test('raceToolCall：超时拒绝 E_TIMEOUT，并清理 onCancel', async () => {
  const registry = createCallRegistry({ now: () => 1_000 });
  const call = registry.register('t1', { tool: 'browser_observe' });
  const started = Date.now();
  await assert.rejects(
    raceToolCall(pendingPromise(5_000), { call, timeoutMs: 25, name: 'browser_observe' }),
    (error) => {
      assert.equal(error.code, 'E_TIMEOUT');
      assert.equal(error.message, '工具 browser_observe 超过 25ms 未返回');
      return true;
    },
  );
  assert.ok(Date.now() - started < 2_000);
  assert.equal(call.onCancel, null);
});

test('raceToolCall：工具成功原样返回，随后取消不再影响已 settle 的结果', async () => {
  const registry = createCallRegistry({ now: () => 1_000 });
  const call = registry.register('ok', { tool: 'browser_status' });
  const result = await raceToolCall(Promise.resolve({ ok: true }), { call, timeoutMs: 1_000, name: 'browser_status' });
  assert.deepEqual(result, { ok: true });
  assert.equal(call.onCancel, null);
  const report = await registry.cancel('ok', '晚到');
  assert.equal(report.found, true, '登记仍在（由 server finally 释放）');
  assert.equal(report.local, false, '已经 settle，不应再触发本地拒绝');
});

test('取消命中在途调用：本地立即拒绝，并转发 daemon inflight.list/command.cancel', async () => {
  const rpc = fakeRpc({
    inflight: [
      { id: 'cmd-old', method: 'observe', startedAt: 1_000, elapsedMs: 2_000 },
      { id: 'cmd-new', method: 'observe', startedAt: 2_000, elapsedMs: 1_000 },
      { id: 'cmd-other', method: 'click', startedAt: 3_000, elapsedMs: 500 },
    ],
  });
  const registry = createCallRegistry({ rpc: rpc.rpc, now: () => 10_000 });
  const call = registry.register('req-1', { tool: 'browser_observe', methods: ['observe'] });
  const raced = raceToolCall(pendingPromise(5_000), { call, timeoutMs: 5_000, name: 'browser_observe' });
  const report = await registry.cancel('req-1', '用户取消');
  assert.equal(report.found, true);
  assert.equal(report.local, true);
  assert.equal(call.cancelled, true);
  assert.equal(call.reason, '用户取消');
  assert.equal(report.remote.attempted, 2);
  assert.deepEqual(report.remote.accepted.sort(), ['cmd-new', 'cmd-old']);
  assert.deepEqual(rpc.calls.map((row) => row.method), ['inflight.list', 'command.cancel', 'command.cancel']);
  assert.deepEqual(rpc.cancelled.sort(), ['cmd-new', 'cmd-old']);
  assert.deepEqual(report.remote.rejected, []);
  await assert.rejects(raced, (error) => error.code === 'E_CANCELLED' && error.cancelled === true);
  // 幂等：重复取消不重复转发
  const again = await registry.cancel('req-1', '再来一次');
  assert.equal(again.alreadyCancelled, true);
  assert.equal(rpc.calls.filter((row) => row.method === 'command.cancel').length, 2);
});

test('取消转发有上限且优先取消最近开始的命令', async () => {
  const inflight = [];
  for (let index = 0; index < 10; index += 1) {
    inflight.push({ id: 'cmd-' + index, method: 'observe', startedAt: index, elapsedMs: 100 - index });
  }
  const rpc = fakeRpc({ inflight });
  const registry = createCallRegistry({ rpc: rpc.rpc, now: () => 1_000, maxRemote: 2 });
  registry.register('r1', { tool: 'browser_observe', methods: ['observe'] });
  const report = await registry.cancel('r1', 'test');
  assert.equal(report.remote.attempted, 2);
  assert.deepEqual(rpc.cancelled, ['cmd-9', 'cmd-8']);
  assert.equal(registry.remoteLimit, 2);
  assert.equal(DEFAULT_MAX_REMOTE_CANCELS, 3);
});

test('取消转发：无 rpc / 环境关闭 / 无方法映射时跳过并如实说明', async () => {
  const noRpc = createCallRegistry({ now: () => 1_000 });
  noRpc.register('a', { tool: 'browser_status' });
  const skipped = await noRpc.cancel('a', 'x');
  assert.equal(skipped.remote.skipped, true);
  assert.match(skipped.remote.note, /只停止 MCP 等待/);

  const rpc = fakeRpc({ inflight: [{ id: 'c1', method: 'observe', startedAt: 1 }] });
  const disabled = createCallRegistry({ rpc: rpc.rpc, now: () => 1_000, env: { BB_MCP_CANCEL_REMOTE: 'off' } });
  disabled.register('b', { tool: 'browser_observe', methods: ['observe'] });
  const report = await disabled.cancel('b', 'x');
  assert.equal(report.remote.skipped, true);
  assert.deepEqual(rpc.calls, []);
  assert.equal(remoteCancelEnabled({ BB_MCP_CANCEL_REMOTE: 'off' }), false);
  assert.equal(remoteCancelEnabled({}), true);

  const noMethods = createCallRegistry({ rpc: rpc.rpc, now: () => 1_000 });
  noMethods.register('c', { tool: 'browser_status' });
  const localOnly = await noMethods.cancel('c', 'x');
  assert.equal(localOnly.remote.skipped, true);
  assert.match(localOnly.remote.note, /没有映射扩展命令方法/);
});

test('取消转发容错：inflight.list 失败与单条 command.cancel 失败都不抛', async () => {
  const failingList = fakeRpc({ failInflight: Object.assign(new Error('daemon 未运行'), { code: 'E_DAEMON' }) });
  const registry = createCallRegistry({ rpc: failingList.rpc, now: () => 1_000 });
  registry.register('x', { tool: 'browser_observe', methods: ['observe'] });
  const report = await registry.cancel('x', 'x');
  assert.equal(report.found, true);
  // 没有挂 raceToolCall（无等待方）时 local=false：取消只更新状态，不存在“停止等待”可停止。
  assert.equal(report.local, false);
  assert.match(report.remote.error, /E_DAEMON/);
  assert.equal(registry.snapshot().counters.remoteFailed, 1);

  const partial = fakeRpc({
    inflight: [
      { id: 'ok-1', method: 'observe', startedAt: 2 },
      { id: 'bad-1', method: 'observe', startedAt: 1 },
    ],
    failCancel: new Set(['bad-1']),
  });
  const registry2 = createCallRegistry({ rpc: partial.rpc, now: () => 1_000 });
  registry2.register('y', { tool: 'browser_observe', methods: ['observe'] });
  const report2 = await registry2.cancel('y', 'y');
  assert.deepEqual(report2.remote.accepted, ['ok-1']);
  assert.deepEqual(report2.remote.rejected, ['bad-1']);
  assert.match(report2.remote.error, /E_NOT_FOUND/);
});

test('竞态：登记后立即取消（raceToolCall 之前）也能拿到 E_CANCELLED', async () => {
  const registry = createCallRegistry({ now: () => 1_000 });
  const call = registry.register('early', { tool: 'browser_observe' });
  await registry.cancel('early', '提前取消');
  await assert.rejects(
    raceToolCall(pendingPromise(5_000), { call, timeoutMs: 5_000, name: 'browser_observe' }),
    (error) => error.code === 'E_CANCELLED',
  );
});

test('工具自身异常原样透传，不被取消/超时逻辑改写', async () => {
  const registry = createCallRegistry({ now: () => 1_000 });
  const call = registry.register('err', { tool: 'browser_observe' });
  const boom = Object.assign(new Error('daemon 爆炸'), { code: 'E_INTERNAL' });
  await assert.rejects(
    raceToolCall(Promise.reject(boom), { call, timeoutMs: 1_000, name: 'browser_observe' }),
    (error) => error === boom,
  );
});

test('snapshot 暴露在途详情与转发开关', () => {
  const rpc = fakeRpc();
  const registry = createCallRegistry({ rpc: rpc.rpc, now: () => 5_000 });
  registry.register('s1', { tool: 'browser_screenshot', methods: ['screenshot'] });
  const snapshot = registry.snapshot();
  assert.equal(snapshot.remoteEnabled, true);
  assert.equal(snapshot.remoteLimit, DEFAULT_MAX_REMOTE_CANCELS);
  assert.equal(snapshot.inflight[0].elapsedMs, 0);
  assert.equal(snapshot.counters.registered, 1);
  assert.equal(snapshot.counters.cancelled, 0);
});

test('取消时由 registry 发最终 cancelled 进度通知，并在 cancelSettled 之前完成', async () => {
  const notifications = [];
  const progress = {
    cancel(reason, note) {
      notifications.push({ reason, note });
    },
  };
  const rpc = fakeRpc({ inflight: [{ id: 'cmd-1', method: 'observe', startedAt: 1 }] });
  const registry = createCallRegistry({ rpc: rpc.rpc, now: () => 1_000 });
  const call = registry.register('p1', { tool: 'browser_observe', methods: ['observe'], progress });
  let settled = false;
  const settledPromise = registry.cancel('p1', '用户取消');
  call.cancelSettled.then(() => { settled = true; });
  const report = await settledPromise;
  await call.cancelSettled;
  assert.equal(report.found, true);
  assert.equal(settled, true);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].reason, '用户取消');
  assert.match(notifications[0].note, /daemon 已取消 1 个在途命令/);
  assert.equal(call.remoteReport.accepted.length, 1);
});

test('没有 progress 会话时取消不报错，也不伪造通知', async () => {
  const rpc = fakeRpc({ inflight: [] });
  const registry = createCallRegistry({ rpc: rpc.rpc, now: () => 1_000 });
  const call = registry.register('p2', { tool: 'browser_observe', methods: ['observe'] });
  const report = await registry.cancel('p2', '无进度令牌');
  assert.equal(report.found, true);
  assert.equal(report.progress, null);
  assert.equal(report.remote.skipped, true);
  await call.cancelSettled;
});

