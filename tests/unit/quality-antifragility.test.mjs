// tests/unit/quality-antifragility.test.mjs —— 反脆弱语义的直接单测（真实模块 + 故障注入）。
//
// 与 quality-gates.test.mjs 的区别：这里不跑整个 gate，而是逐条验证
// "超时/取消/预算耗尽/存储失败 ⇒ 结构化失败 + 清理 + 无僵尸状态"的语义，
// 便于定位回归发生在哪一层。夹具全部来自 tools/quality/lib/fixtures.mjs。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHarReplayPlan, executeHarReplayPlan } from '../../lib/har-plan.mjs';
import { buildTraceEventUnits, compactTrace, planTraceExport } from '../../lib/trace-budget.mjs';
import { createMemoryLedgerStorage, IntentLedger } from '../../lib/intent-ledger.mjs';
import { enforceOperationLimit, jsonByteLength } from '../../lib/limits.mjs';
import { buildRawReplayEntries, buildTraceFixture, replayPlanOptionVariants } from '../../tools/quality/lib/fixtures.mjs';
import { createFingerprintFixture } from '../../tools/quality/lib/writes.mjs';
import { canonicalJson, fingerprint } from '../../tools/quality/lib/canonical.mjs';
import {
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

test('执行器取消：停止派发、未执行项结构化、summary 自洽、重跑成功', async () => {
  const entries = buildRawReplayEntries('antifragility', 10);
  const plan = buildHarReplayPlan(entries, replayPlanOptionVariants()[0].options);
  const pair = createAbortPair();
  const send = createControllableSend({ signal: pair.signal });
  let results = 0;
  const run = await executeHarReplayPlan(plan, send.send, {
    concurrency: 1,
    signal: pair.signal,
    onResult: () => {
      results += 1;
      pair.abort();
    },
  });
  pair.cleanup();
  assert.equal(run.summary.stoppedEarly, true);
  assert.equal(run.summary.attempted + run.summary.notExecuted, run.summary.scheduled);
  assert.ok(run.summary.attempted < run.summary.scheduled);
  const notExecuted = run.results.filter((result) => result.notExecuted === true);
  assert.ok(notExecuted.length > 0);
  for (const result of notExecuted) {
    assert.equal(result.ok, false);
    assert.match(result.error, /^not-executed/);
  }
  assert.equal(results, 1);
  // 重跑：不携带取消信号的新计划必须完整成功（无僵尸状态）。
  const fresh = buildHarReplayPlan(entries, replayPlanOptionVariants()[0].options);
  const rerun = await executeHarReplayPlan(fresh, createControllableSend({}).send);
  assert.equal(rerun.ok, true);
  assert.equal(rerun.summary.failed, 0);
  assert.equal(rerun.summary.notExecuted, 0);
});

test('执行器失败注入：幂等 GET 重试一次，非幂等 POST 只派发一次', async () => {
  const entries = [
    { method: 'GET', url: 'https://fixture.invalid/get', headers: {} },
    { method: 'POST', url: 'https://fixture.invalid/post', headers: {}, body: '{}' },
  ];
  const plan = buildHarReplayPlan(entries, { order: 'har', concurrency: 1, retryIdempotent: true, stopOnError: true });
  const failing = createFailingSend({ failAt: 1, code: 'E_TIMEOUT' });
  const run = await executeHarReplayPlan(plan, failing.send);
  assert.equal(run.results[0].attempts, 2);
  assert.equal(run.results[0].errorCode, 'E_TIMEOUT');
  assert.equal(run.results[1].notExecuted, true);
  assert.equal(run.summary.notExecuted, 1);
  // 单独验证非幂等请求不会重试。
  const postPlan = buildHarReplayPlan([entries[1]], { order: 'har', concurrency: 1, retryIdempotent: true });
  const postFailing = createFailingSend({ failAt: 1 });
  const postRun = await executeHarReplayPlan(postPlan, postFailing.send);
  assert.equal(postRun.results[0].attempts, 1);
});

test('账本降级写：WAL/fsync 失败不阻断、durability 有结构化证据、timer 清理', () => {
  const storage = createMemoryLedgerStorage({ failAppendAfter: 1, failSync: true });
  const ledger = new IntentLedger({ storage, now: () => 1700000000000 });
  const entry = ledger.begin('click', { ref: '@e1' }, { tabId: 3, sessionId: 's' });
  ledger.finish(entry, 'done');
  ledger.flush();
  const stats = ledger.stats();
  assert.equal(stats.durability.degraded, true);
  assert.ok(stats.durability.lastError, '缺少 lastError 证据');
  assert.match(stats.durability.lastError.code, /^E_LEDGER_/);
  assert.ok(stats.durability.lastError.message.length > 0);
  assert.equal(entry.state, 'done');
  assert.equal(ledger.writeTimer, null);
  assert.equal(ledger.checkpoint().entries.total, 1);
});

test('账本崩溃恢复：active → unknown + replayBlocked，显式 resolve 解锁', () => {
  const storage = createMemoryLedgerStorage();
  const first = new IntentLedger({ storage, now: () => 1700000000000 });
  const entry = first.begin('click', { ref: '@e1' }, { tabId: 4, sessionId: 's' });
  const second = new IntentLedger({ storage, now: () => 1700000000500 });
  const recovery = second.recover({ reason: 'test-crash' });
  assert.equal(recovery.recovered, 1);
  const restored = second.entries.find((item) => item.id === entry.id);
  assert.equal(restored.state, 'unknown');
  assert.equal(restored.replayBlocked, true);
  assert.equal(second.checkReplay('click', { tabId: 4 }).ok, false);
  assert.equal(second.checkReplay('observe', { tabId: 4 }).ok, true);
  second.resolve(entry.id, 'confirmed');
  assert.equal(second.checkReplay('click', { tabId: 4 }).ok, true);
  second.flush();
  assert.equal(second.writeTimer, null);
});

test('trace 预算耗尽：有界终止、动作可解释、输入不变、事件单元对账', () => {
  const trace = buildTraceFixture('antifragility');
  const before = canonicalJson(trace);
  const budget = { maxEvents: 60, maxSpans: 6, maxSteps: 4, maxStateChars: 64, maxScreenshots: 1, maxBytes: 1024 };
  const plan = planTraceExport(trace, budget);
  assert.equal(plan.degraded, true);
  assert.ok(plan.actions.length > 0 && plan.actions.length <= 8);
  for (const action of plan.actions) {
    assert.equal(typeof action.kind, 'string');
    assert.equal(typeof action.reason, 'string');
    assert.equal(typeof action.from, 'number');
  }
  const compacted = compactTrace(trace, { ...budget, force: true });
  assert.ok(['compact', 'sampled', 'minimal'].includes(compacted.plan.level));
  assert.ok(Number.isFinite(compacted.plan.estimatedBytes));
  assert.equal(canonicalJson(trace), before, 'compactTrace 修改了输入');
  const units = buildTraceEventUnits(trace.traceEvents);
  assert.equal(units.units.length, units.stats.beginEnd + units.stats.complete + units.stats.instant + units.stats.async);
  assert.equal(units.metadata.length, units.stats.metadata);
});

test('大小上限：超限抛结构化 E_RESULT_TOO_LARGE（bytes/limit 证据）', () => {
  const small = { ok: true, rows: [1, 2, 3] };
  assert.equal(enforceOperationLimit(small), small);
  assert.ok(jsonByteLength(small) > 0);
  const huge = { ok: true, blob: 'x'.repeat(4 * 1024 * 1024 + 8) };
  assert.throws(
    () => enforceOperationLimit(huge),
    (error) => error.code === 'E_RESULT_TOO_LARGE'
      && error.data.limit === 4 * 1024 * 1024
      && error.data.bytes > error.data.limit,
  );
});

test('临时目录：正常/异常都清理，文件树可审计', async () => {
  const normal = await withTempDir('antifragility', async (dir) => {
    const created = pathJoinCase(dir);
    return { files: listTree(dir), created };
  });
  assert.equal(directoryExists(normal.dir), false);
  assert.deepEqual(normal.value.files, []);
  let caught = null;
  let failedDir = null;
  try {
    await withTempDir('antifragility-fail', async (dir) => {
      failedDir = dir;
      throw new Error('boom');
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.message, 'boom');
  assert.equal(directoryExists(failedDir), false);
});

function pathJoinCase(dir) {
  // 仅用于断言目录存在；不写文件，保持门禁"不落盘大文件"的约束。
  return directoryExists(dir);
}

test('预算计量器：耗尽证据是确定性的（不含真实耗时字段）', () => {
  const meter = createBudgetMeter({ maxChecks: 1, maxBytes: 10 });
  meter.consume('checks', 1);
  meter.consume('bytes', 20);
  const exhaustion = meter.exhaustion();
  assert.equal(exhaustion.code, 'QUALITY_BUDGET_EXHAUSTED');
  assert.equal('ms' in exhaustion.evidence.used, false, 'evidence 不得含真实耗时 ms');
  assert.equal('elapsedMs' in exhaustion.evidence, false);
  assert.equal('elapsedMs' in exhaustion.evidence.used, false);
  // 两次耗尽证据逐字节一致（不含时间/随机）。
  assert.equal(canonicalJson(meter.exhaustion()), canonicalJson(exhaustion));
});

test('假定时器：pending 计数/清理/推进确定性', () => {
  const fake = createFakeTimers();
  const order = [];
  fake.setTimeout(() => order.push(2), 20);
  const first = fake.setTimeout(() => order.push(1), 10);
  assert.equal(fake.pending(), 2);
  fake.clearTimeout(first);
  assert.equal(fake.pending(), 1);
  fake.advance(19);
  assert.deepEqual(order, []);
  fake.advance(1);
  assert.deepEqual(order, [2]);
  assert.equal(fake.pending(), 0);
});

test('产物指纹与夹具：写路径夹具真实可执行（createFingerprintFixture）', async () => {
  const fixture = createFingerprintFixture();
  assert.equal(typeof fixture.operationToken, 'string');
  assert.match(fixture.operationToken, /^wt_[0-9a-f]{16}$/);
  assert.equal(fingerprint(fixture), fingerprint(createFingerprintFixture()));
  assert.equal(fixture.operation.method, 'click');
  await settle(1);
});
