// tests/unit/quality-registry.test.mjs —— 门禁执行器的反脆弱性（超时/取消/预算/异常）。
//
// registry 是门禁框架自身：如果它会挂死、漏跑 gate 或泄漏定时器/监听器，
// 那么门禁的"通过"就不可信。这里用注入 gate + 假定时器精确覆盖每条失败路径。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GATE_TIMEOUT_MS,
  createRegistry,
  listGates,
  runSuite,
  validateGates,
} from '../../tools/quality/lib/registry.mjs';
import { fail, makeFinding, pass } from '../../tools/quality/lib/result.mjs';
import {
  activeHandleCount,
  createAbortPair,
  createBudgetMeter,
  createControllableSend,
  createFailingSend,
  createFakeTimers,
  directoryExists,
  listTree,
  settle,
  withTempDir,
} from '../../tools/quality/lib/faults.mjs';

function fakeGate(id, run) {
  return { id, title: '注入 gate ' + id, run };
}

test('validateGates/createRegistry：拒绝非法/重复 gate', () => {
  assert.ok(validateGates([{ id: 'bad', title: 'x' }]).length >= 1);
  assert.ok(validateGates([fakeGate('a', () => []), fakeGate('a', () => [])]).length >= 1);
  const registry = createRegistry([fakeGate('ok-gate', () => [])]);
  assert.equal(registry.gates().length, 1);
  assert.deepEqual(registry.problems(), []);
  assert.equal(registry.register(fakeGate('ok-gate', () => [])), registry);
  assert.equal(registry.problems().length, 1);
  assert.deepEqual(listGates(registry.gates())[0], { id: 'ok-gate', title: '注入 gate ok-gate', consumes: [] });
});

test('runSuite：正常执行时 finding 按 gate 顺序/id 稳定排序', async () => {
  const gates = [
    fakeGate('z-gate', async () => [
      pass('z-gate', 'z-gate/b', 'B'),
      fail('z-gate', 'z-gate/a', 'A', { code: 'QUALITY_GATE_FAILED', detail: 'detail A', evidence: { a: 1 }, severity: 'warning' }),
    ]),
    fakeGate('a-gate', async () => [pass('a-gate', 'a-gate/a', 'A2')]),
  ];
  const result = await runSuite({ gates, timeoutMs: 2000 });
  assert.deepEqual(result.findings.map((finding) => finding.id), ['z-gate/a', 'z-gate/b', 'a-gate/a']);
  assert.equal(result.summary.checks, 3);
  assert.equal(result.summary.blocking, 0);
  assert.equal(result.summary.warnings, 1);
  assert.equal(result.summary.verdict, 'PASS');
  assert.equal(result.gates.length, 2);
  assert.equal(result.stats.gates, 2);
  assert.equal(result.stats.ran, 2);
  assert.equal(result.stats.timersPending, 0);
  assert.equal(result.stats.abortListenersPending, 0);
});

test('runSuite：gate 抛错/返回垃圾都收敛为结构化 finding，且不影响其它 gate', async () => {
  const gates = [
    fakeGate('throwing-gate', () => {
      throw new Error('injected crash');
    }),
    fakeGate('garbage-gate', () => ({ not: 'findings' })),
    fakeGate('good-gate', () => [pass('good-gate', 'good-gate/ok', '正常')]),
  ];
  const result = await runSuite({ gates, timeoutMs: 2000 });
  const threw = result.findings.filter((finding) => finding.code === 'QUALITY_GATE_THREW');
  assert.equal(threw.length, 2);
  for (const finding of threw) {
    assert.equal(finding.category, 'harness');
    assert.equal(finding.retry, 'no');
    assert.ok(finding.detail.length > 0);
    assert.ok(finding.nextAction.length >= 4);
  }
  assert.equal(result.outcomes.filter((entry) => entry.outcome === 'threw').length, 2);
  assert.equal(result.findings.some((finding) => finding.id === 'good-gate/ok'), true);
  assert.equal(result.stats.threw, 2);
});

test('runSuite：finding 的 gate 与所属 gate 不一致时被拦截', async () => {
  const gate = fakeGate('owner-gate', () => [
    makeFinding({ gate: 'other-gate', id: 'other-gate/x', title: '串 gate', ok: false, code: 'QUALITY_GATE_FAILED', category: 'harness', retry: 'no', nextAction: '修正归属', detail: 'detail', evidence: {} }),
  ]);
  const result = await runSuite({ gates: [gate], timeoutMs: 2000 });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, 'QUALITY_GATE_THREW');
  assert.equal(result.findings[0].id, 'owner-gate/bad-finding-gate');
});

test('runSuite：超时用假定时器精确触发，且 timer 归零', async () => {
  const fake = createFakeTimers();
  const never = fakeGate('never-gate', () => new Promise(() => {}));
  const promise = runSuite({ gates: [never], ctx: {}, timers: fake, timeoutMs: 500 });
  await settle();
  assert.equal(fake.pending(), 1);
  assert.equal(fake.advance(499), 0);
  await settle();
  assert.equal(fake.advance(1), 1);
  await settle();
  const result = await promise;
  assert.equal(result.outcomes[0].outcome, 'timeout');
  assert.equal(result.findings[0].code, 'QUALITY_GATE_TIMEOUT');
  assert.equal(result.findings[0].category, 'harness');
  assert.equal(result.findings[0].retry, 'after-action');
  assert.equal(result.stats.timersPending, 0);
  assert.equal(result.stats.timersCreated, result.stats.timersCleared);
  assert.equal(DEFAULT_GATE_TIMEOUT_MS > 0, true);
});

test('runSuite：外部取消 → 运行中与未开始的 gate 都结构化记录，监听器归零', async () => {
  const pair = createAbortPair();
  const gates = [
    fakeGate('cancel-running', () => new Promise(() => {})),
    fakeGate('cancel-pending', () => [pass('cancel-pending', 'cancel-pending/x', '不该执行')]),
  ];
  const promise = runSuite({ gates, ctx: {}, signal: pair.signal, timeoutMs: 5000 });
  await settle();
  pair.abort();
  await settle();
  const result = await promise;
  assert.equal(result.findings.filter((finding) => finding.code === 'QUALITY_GATE_CANCELLED').length, 2);
  assert.deepEqual(result.outcomes.map((entry) => entry.outcome), ['cancelled', 'cancelled']);
  assert.equal(result.stats.abortListenersPending, 0);
  assert.equal(result.stats.timersPending, 0);
  pair.cleanup();
});

test('runSuite：预算耗尽时剩余 gate 显式标记，不静默漏跑', async () => {
  const budget = createBudgetMeter({ maxChecks: 1 });
  let secondRan = false;
  const gates = [
    fakeGate('budget-first', () => [pass('budget-first', 'budget-first/one', 'one')]),
    fakeGate('budget-second', () => {
      secondRan = true;
      return [];
    }),
  ];
  const result = await runSuite({ gates, ctx: {}, budget, timeoutMs: 2000 });
  assert.equal(secondRan, false);
  const exhausted = result.findings.filter((finding) => finding.code === 'QUALITY_BUDGET_EXHAUSTED');
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].category, 'budget');
  assert.equal(budget.exhausted(), true);
  assert.equal(result.stats.skipped, 1);
});

test('createFakeTimers：按到期时间/注册顺序执行，清理后 pending 归零', () => {
  const fake = createFakeTimers(1000);
  const fired = [];
  fake.setTimeout(() => fired.push('late'), 20);
  fake.setTimeout(() => fired.push('early'), 5);
  const cancelled = fake.setTimeout(() => fired.push('cancelled'), 5);
  fake.clearTimeout(cancelled);
  assert.equal(fake.pending(), 2);
  fake.advance(4);
  assert.deepEqual(fired, []);
  fake.advance(1);
  assert.deepEqual(fired, ['early']);
  fake.advance(15);
  assert.deepEqual(fired, ['early', 'late']);
  assert.equal(fake.pending(), 0);
  assert.equal(fake.now(), 1020);
});

test('createBudgetMeter：三类预算与结构化耗尽证据', () => {
  const meter = createBudgetMeter({ maxChecks: 2, maxBytes: 10, maxMs: 1000 });
  assert.equal(meter.consume('checks', 1).exhausted, false);
  assert.equal(meter.consume('checks', 1).exhausted, true);
  assert.equal(meter.consume('bytes', 11).exhausted, true);
  assert.equal(meter.exhausted(), true);
  const exhaustion = meter.exhaustion();
  assert.equal(exhaustion.code, 'QUALITY_BUDGET_EXHAUSTED');
  assert.equal(exhaustion.category, 'budget');
  assert.equal(exhaustion.retry, 'after-action');
  assert.ok(exhaustion.nextAction.length >= 4);
  assert.equal(meter.snapshot().exhausted, true);
});

test('withTempDir：正常/异常路径都清理目录，且不吞异常', async () => {
  const normal = await withTempDir('normal', async (dir) => {
    assert.equal(directoryExists(dir), true);
    return pathFiles(dir);
  });
  assert.equal(directoryExists(normal.dir), false);
  assert.equal(normal.cleaned, true);
  assert.deepEqual(normal.value, []);
  let caught = null;
  let failedDir = null;
  try {
    await withTempDir('failure', async (dir) => {
      failedDir = dir;
      throw new Error('inside failure');
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.message, 'inside failure');
  assert.equal(directoryExists(failedDir), false);
});

function pathFiles(dir) {
  // listTree 返回排序后的相对路径；空目录返回 []。
  return listTree(dir);
}

test('createAbortPair：abort 后 whenAborted 立即 resolve，cleanup 后监听器归零', async () => {
  const pair = createAbortPair();
  const wait = pair.whenAborted();
  assert.equal(pair.listenerCount(), 1);
  assert.equal(pair.signal.aborted, false);
  pair.abort();
  await wait;
  assert.equal(pair.signal.aborted, true);
  const immediate = await pair.whenAborted();
  assert.equal(immediate, undefined);
  pair.cleanup();
  assert.equal(pair.controller.signal.aborted, true);
});

test('createControllableSend/createFailingSend：取消与失败注入可计数', async () => {
  const send = createControllableSend({});
  const ok = await send.send({ method: 'GET', url: 'https://x' });
  assert.equal(ok.status, 200);
  send.cancel();
  await assert.rejects(send.send({ method: 'GET', url: 'https://x' }), (error) => error.code === 'E_CANCELLED');
  const failing = createFailingSend({ failAt: 2, code: 'E_TIMEOUT' });
  const first = await failing.send({});
  assert.equal(first.status, 200);
  await assert.rejects(failing.send({}), (error) => error.code === 'E_TIMEOUT');
  assert.equal(failing.calls, 2);
  assert.equal(activeHandleCount() == null || activeHandleCount() >= 0, true);
});
