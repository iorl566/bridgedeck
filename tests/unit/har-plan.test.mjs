// tests/unit/har-plan.test.mjs —— HAR 重放计划（顺序/并发/幂等）+ 执行器 + 两次重放等价性。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHarReplayPlan,
  compareReplayRuns,
  executeHarReplayPlan,
  isIdempotentRequest,
  normalizeReplayEntry,
  replayIdOf,
  summarizeHarReplayPlan,
} from '../../lib/har-plan.mjs';
import { buildHar } from '../../lib/har.mjs';
import {
  parseHarReplayEntries,
  planHarReplay,
  replayHarPlan,
} from '../../lib/har-replay.mjs';

function entry(index, method, url, body = null, startedAt = 1000 + index) {
  return {
    index,
    method,
    url,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body } : {}),
    startedAt,
  };
}

test('replayIdOf 稳定且区分 method/url/body，幂等判定只看安全方法', () => {
  assert.equal(replayIdOf({ method: 'get', url: 'https://a/1' }), replayIdOf({ method: 'GET', url: 'https://a/1' }));
  assert.notEqual(replayIdOf({ method: 'GET', url: 'https://a/1' }), replayIdOf({ method: 'GET', url: 'https://a/2' }));
  assert.notEqual(replayIdOf({ method: 'POST', url: 'https://a/1', body: 'a' }), replayIdOf({ method: 'POST', url: 'https://a/1', body: 'b' }));
  assert.equal(isIdempotentRequest('GET'), true);
  assert.equal(isIdempotentRequest('head'), true);
  assert.equal(isIdempotentRequest('POST'), false);
  assert.equal(isIdempotentRequest('DELETE'), false);
});

test('buildHarReplayPlan：默认保持 HAR 顺序并分批次', () => {
  const plan = buildHarReplayPlan([
    entry(0, 'GET', 'https://a/1'),
    entry(1, 'POST', 'https://a/2'),
    entry(2, 'GET', 'https://a/3'),
  ], { concurrency: 2 });
  assert.equal(plan.version, 1);
  assert.equal(plan.mode, 'sequential');
  assert.equal(plan.concurrency, 2);
  assert.deepEqual(plan.entries.map((item) => item.order), [0, 1, 2]);
  assert.deepEqual(plan.batches.map((batch) => batch.indexes), [[0, 1], [2]]);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.summary.scheduled, 3);
  assert.equal(plan.summary.batches, 2);
});

test('buildHarReplayPlan：order=time 按时间排序，maxEntries 截断记 skip', () => {
  const plan = buildHarReplayPlan([
    entry(0, 'GET', 'https://a/late', null, 3000),
    entry(1, 'GET', 'https://a/early', null, 1000),
    entry(2, 'GET', 'https://a/mid', null, 2000),
  ], { order: 'time', maxEntries: 2 });
  assert.deepEqual(plan.entries.map((item) => item.index), [1, 2]);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, 'limit');
  assert.equal(plan.skipped[0].index, 0);
});

test('buildHarReplayPlan：idempotent 模式去重并跳过非幂等请求', () => {
  const plan = buildHarReplayPlan([
    entry(0, 'GET', 'https://a/1'),
    entry(1, 'GET', 'https://a/1'), // 完全重复
    entry(2, 'POST', 'https://a/2', '{"x":1}'),
    entry(3, 'GET', 'https://a/3'),
  ], { idempotent: true, concurrency: 3 });
  assert.equal(plan.mode, 'idempotent');
  assert.deepEqual(plan.entries.map((item) => item.index), [0, 3]);
  const reasons = plan.skipped.map((item) => item.reason);
  assert.deepEqual(reasons, ['duplicate', 'non-idempotent']);
  assert.equal(plan.skipped[0].duplicateOf, 0);
  assert.equal(plan.summary.skipReasons.duplicate, 1);
  assert.equal(plan.summary.skipReasons['non-idempotent'], 1);
  // 允许非幂等时可被排进计划，但重复项仍然去重
  const allowed = buildHarReplayPlan([
    entry(0, 'GET', 'https://a/1'),
    entry(1, 'POST', 'https://a/2', '{"x":1}'),
  ], { idempotent: true, allowNonIdempotent: true });
  assert.deepEqual(allowed.entries.map((item) => item.index), [0, 1]);
});

test('buildHarReplayPlan：skipMethods/skipTypes/missing-url 显式跳过', () => {
  const plan = buildHarReplayPlan([
    { index: 0, method: 'DELETE', url: 'https://a/1', resourceType: 'XHR' },
    { index: 1, method: 'GET', url: 'https://a/2', resourceType: 'Image' },
    { index: 2, method: 'GET', url: '' },
  ], { skipMethods: ['DELETE'], skipTypes: ['image'] });
  assert.equal(plan.entries.length, 0);
  assert.deepEqual(plan.skipped.map((item) => item.reason), ['method-skipped', 'type-skipped', 'missing-url']);
});

test('executeHarReplayPlan：顺序执行、结果按计划顺序、停用错误传播', async () => {
  const plan = buildHarReplayPlan([
    entry(0, 'GET', 'https://a/1'),
    entry(1, 'GET', 'https://a/2'),
    entry(2, 'GET', 'https://a/3'),
  ]);
  const calls = [];
  const result = await executeHarReplayPlan(plan, async (request) => {
    calls.push(request.url);
    if (request.url.endsWith('/2')) throw Object.assign(new Error('boom'), { code: 'E_NET' });
    return { status: 200, body: 'ok:' + request.url };
  });
  assert.deepEqual(calls, ['https://a/1', 'https://a/2', 'https://a/2']);
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].errorCode, 'E_NET');
  assert.equal(result.results[1].attempts, 2); // 幂等 GET 失败重试一次
  assert.equal(result.results[2].ok, false);
  assert.equal(result.results[2].notExecuted, true);
  assert.equal(result.results[2].errorCode, null);
  assert.equal(result.summary.stoppedEarly, true);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.succeeded, 1);
});

test('executeHarReplayPlan：并发 worker 池真正并行且结果顺序稳定', async () => {
  const plan = buildHarReplayPlan([
    entry(0, 'GET', 'https://a/1'),
    entry(1, 'GET', 'https://a/2'),
    entry(2, 'GET', 'https://a/3'),
    entry(3, 'GET', 'https://a/4'),
  ], { concurrency: 2 });
  let running = 0;
  let maxRunning = 0;
  const completionOrder = [];
  const result = await executeHarReplayPlan(plan, async (request) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 15));
    running -= 1;
    completionOrder.push(request.url);
    return { status: 200, body: request.url };
  });
  assert.equal(maxRunning, 2);
  assert.equal(result.ok, true);
  assert.equal(result.summary.concurrency, 2);
  assert.deepEqual(result.results.map((item) => item.index), [0, 1, 2, 3]);
  assert.equal(new Set(completionOrder).size, 4);
  assert.equal(result.results.every((item) => item.ok), true);
});

test('executeHarReplayPlan：跳过项进入 skipped 且不调用 send', async () => {
  const plan = buildHarReplayPlan([
    entry(0, 'GET', 'https://a/1'),
    entry(1, 'POST', 'https://a/2', '{}'),
  ], { idempotent: true });
  const calls = [];
  const result = await executeHarReplayPlan(plan, async (request) => {
    calls.push(request.url);
    return { status: 204, body: '' };
  });
  assert.deepEqual(calls, ['https://a/1']);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'non-idempotent');
  assert.equal(result.summary.skipped, 1);
});

test('compareReplayRuns：两次重放状态/正文一致即等价，忽略耗时', async () => {
  const plan = buildHarReplayPlan([
    entry(0, 'GET', 'https://a/1'),
    entry(1, 'GET', 'https://a/2'),
  ], { concurrency: 2 });
  const send = async (request) => ({ status: 200, body: 'payload-' + request.url });
  const first = await executeHarReplayPlan(plan, send);
  const second = await executeHarReplayPlan(plan, send);
  const compared = compareReplayRuns(first, second);
  assert.equal(compared.identical, true);
  assert.deepEqual(compared.differences, []);
  const changed = await executeHarReplayPlan(plan, async (request) => ({
    status: request.url.endsWith('/2') ? 500 : 200,
    body: 'payload-' + request.url,
  }));
  const drift = compareReplayRuns(first, changed);
  assert.equal(drift.identical, false);
  assert.equal(drift.differences.some((item) => item.field === 'status'), true);
});

test('normalizeReplayEntry 兼容 HAR entry / archive request', () => {
  const har = buildHar([{
    entry: { method: 'POST', url: 'https://a/api', status: 200, startedAt: 1700000000000, durationMs: 5 },
    requestHeaders: { 'content-type': 'application/json' },
    postData: '{"x":1}',
    responseBody: '',
    responseHeaders: {},
  }]);
  const entries = parseHarReplayEntries(har);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].method, 'POST');
  assert.equal(entries[0].body, '{"x":1}');
  assert.equal(entries[0].idempotent, false);
  const normalized = normalizeReplayEntry(entries[0], 0);
  assert.equal(normalized.url, 'https://a/api');
  assert.equal(normalized.startedAt, 1700000000000);
  assert.equal(normalized.idempotent, false);
});

test('parseHarReplayEntries 支持幂等模式注解与 honorPlan 过滤', () => {
  const har = buildHar([
    { entry: { method: 'GET', url: 'https://a/1', status: 200, startedAt: 1000, durationMs: 1 }, requestHeaders: {}, responseHeaders: {} },
    { entry: { method: 'GET', url: 'https://a/1', status: 200, startedAt: 1001, durationMs: 1 }, requestHeaders: {}, responseHeaders: {} },
    { entry: { method: 'POST', url: 'https://a/2', status: 200, startedAt: 1002, durationMs: 1 }, requestHeaders: {}, responseHeaders: {} },
  ]);
  const annotated = parseHarReplayEntries(har, { idempotent: true });
  assert.equal(annotated.length, 3);
  assert.equal(annotated[1].skip, 'duplicate');
  assert.equal(annotated[2].skip, 'non-idempotent');
  const honored = parseHarReplayEntries(har, { idempotent: true, honorPlan: true });
  assert.equal(honored.length, 1);
  assert.equal(honored[0].url, 'https://a/1');
});

test('replayHarPlan 端到端：HAR → 计划 → 执行 → 摘要', async () => {
  const har = buildHar([
    { entry: { method: 'GET', url: 'https://a/1', status: 200, startedAt: 1000, durationMs: 1 }, requestHeaders: {}, responseHeaders: {} },
    { entry: { method: 'GET', url: 'https://a/2', status: 200, startedAt: 1001, durationMs: 1 }, requestHeaders: {}, responseHeaders: {} },
  ]);
  const run = await replayHarPlan(har, async (request) => ({ status: 200, body: request.url }), { concurrency: 2 });
  assert.equal(run.ok, true);
  assert.equal(run.results.length, 2);
  assert.equal(run.summary.concurrency, 2);
  const plan = planHarReplay(har, { idempotent: true });
  assert.equal(plan.mode, 'idempotent');
  assert.equal(summarizeHarReplayPlan(plan).scheduled, 2);
  assert.equal(summarizeHarReplayPlan(null).scheduled, 0);
});

test('执行器拒绝无效计划/缺失 send', async () => {
  await assert.rejects(() => executeHarReplayPlan(null, async () => ({})), /无效的重放计划/);
  const plan = buildHarReplayPlan([entry(0, 'GET', 'https://a/1')]);
  await assert.rejects(() => executeHarReplayPlan(plan, null), /send/);
});
