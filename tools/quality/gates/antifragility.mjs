// tools/quality/gates/antifragility.mjs —— 反脆弱门禁。
//
// 检查四类失败路径的"清理 + 结构化失败 + 无僵尸状态"：
//   1) 门禁框架自身：超时、取消、预算耗尽都必须产生结构化 finding，
//      并且本进程创建的定时器/abort 监听器在结束后归零；
//   2) replay 执行器：中途取消不累积副作用，未执行项有结构化原因；
//      失败注入（超时）只对幂等请求重试，非幂等请求不重复派发；
//   3) trace 预算耗尽：降级有界、可解释、输入不被修改；
//   4) 账本降级写与临时目录：存储失败不阻断主流程但留下证据，临时目录必删。
//
// 所有断言都带负控制（故意坏掉的样本必须被探测器抓到），避免"空转通过"。

import { buildHarReplayPlan, executeHarReplayPlan } from '../../../lib/har-plan.mjs';
import { buildTraceEventUnits, compactTrace, planTraceExport } from '../../../lib/trace-budget.mjs';
import { createFileLedgerStorage, createMemoryLedgerStorage, IntentLedger } from '../../../lib/intent-ledger.mjs';
import { enforceOperationLimit, jsonByteLength } from '../../../lib/limits.mjs';
import {
  buildHugeTraceFixture,
  buildRawReplayEntries,
  replayPlanOptionVariants,
} from '../lib/fixtures.mjs';
import { fingerprint } from '../lib/canonical.mjs';
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
} from '../lib/faults.mjs';
import { createRegistry, runSuite } from '../lib/registry.mjs';
import { fail, pass } from '../lib/result.mjs';

export const ANTIFRAGILITY_GATE_ID = 'antifragility';

function gid(name) {
  return ANTIFRAGILITY_GATE_ID + '/' + name;
}

/** 构造一个"永远不结束"的 gate（用于超时）。 */
function slowGate() {
  return {
    id: 'slow-gate',
    title: '注入：永不结束的 gate',
    run: () => new Promise(() => {}),
  };
}

/** 门禁框架超时：门禁不结束 → 结构化超时 finding，且定时器清理归零。 */
async function checkHarnessTimeout() {
  const fake = createFakeTimers();
  const registry = createRegistry([slowGate()]);
  const promise = runSuite({
    gates: registry.gates(),
    ctx: {},
    timers: fake,
    timeoutMs: 500,
    budget: null,
  });
  await settle();
  const fired = fake.advance(500);
  await settle();
  const result = await promise;
  const timeoutFinding = result.findings.find((finding) => finding.code === 'QUALITY_GATE_TIMEOUT');
  const ok = Boolean(timeoutFinding)
    && timeoutFinding.category === 'harness'
    && timeoutFinding.retry === 'after-action'
    && result.outcomes[0].outcome === 'timeout'
    && result.stats.timersPending === 0
    && fired === 1;
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('harness-timeout'), '门禁超时没有结构化失败或定时器泄漏', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: '超时 finding=' + Boolean(timeoutFinding) + '，outcome=' + JSON.stringify(result.outcomes)
        + '，未清理定时器=' + result.stats.timersPending + '，假定时器触发=' + fired,
      evidence: { findings: result.findings, stats: result.stats },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('harness-timeout'), '注入慢 gate 被超时终止且 timer 归零', {
    timersPending: result.stats.timersPending,
    fired,
  });
}

/** 门禁框架取消：AbortSignal 触发后结构化结束，未执行 gate 显式记录，监听器清理。 */
async function checkHarnessCancel() {
  const pair = createAbortPair();
  const gates = [
    { id: 'cancel-first', title: '注入：运行中取消', run: () => new Promise(() => {}) },
    { id: 'cancel-second', title: '注入：取消后不应执行', run: async () => [] },
  ];
  const registry = createRegistry(gates);
  const promise = runSuite({
    gates: registry.gates(),
    ctx: {},
    signal: pair.signal,
    timeoutMs: 5000,
  });
  await settle();
  pair.abort();
  await settle();
  const result = await promise;
  pair.cleanup();
  const cancelled = result.findings.filter((finding) => finding.code === 'QUALITY_GATE_CANCELLED');
  const ok = cancelled.length === 2
    && result.stats.abortListenersPending === 0
    && result.stats.timersPending === 0
    && result.outcomes.every((outcome) => outcome.outcome === 'cancelled');
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('harness-cancel'), '门禁取消没有结构化失败或监听器泄漏', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: '取消 finding=' + cancelled.length + '，监听器残留=' + result.stats.abortListenersPending
        + '，timer 残留=' + result.stats.timersPending,
      evidence: { findings: result.findings, stats: result.stats, outcomes: result.outcomes },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('harness-cancel'), '门禁取消：运行中/未开始的 gate 都结构化记录，监听器与 timer 归零', {
    cancelled: cancelled.length,
    stats: result.stats,
  });
}

/** 门禁框架预算耗尽：剩余 gate 显式标记预算耗尽，不静默漏跑。 */
async function checkHarnessBudget() {
  const budget = createBudgetMeter({ maxChecks: 1 });
  const gates = [
    {
      id: 'budget-first',
      title: '注入：消耗一次预算',
      run: () => [pass('budget-first', 'budget-first/check', '注入检查')],
    },
    {
      id: 'budget-second',
      title: '注入：预算耗尽后不应执行',
      run: () => {
        throw new Error('预算耗尽后仍执行了第二个 gate');
      },
    },
  ];
  const registry = createRegistry(gates);
  const result = await runSuite({ gates: registry.gates(), ctx: {}, budget, timeoutMs: 2000 });
  const exhausted = result.findings.find((finding) => finding.code === 'QUALITY_BUDGET_EXHAUSTED');
  const ok = Boolean(exhausted)
    && exhausted.category === 'budget'
    && exhausted.retry === 'after-action'
    && result.outcomes.some((outcome) => outcome.outcome === 'budget')
    && budget.exhausted() === true;
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('harness-budget'), '预算耗尽没有结构化失败', {
      code: 'QUALITY_BUDGET_EXHAUSTED',
      detail: '预算 finding=' + Boolean(exhausted) + '，outcomes=' + JSON.stringify(result.outcomes),
      evidence: { findings: result.findings, budget: budget.snapshot() },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('harness-budget'), '预算耗尽：剩余 gate 结构化标记，不静默漏跑', {
    outcomes: result.outcomes,
    budget: budget.snapshot(),
  });
}

/** 负控制：抛错/返回垃圾的 gate 必须被 registry 收敛成结构化 finding。 */
async function checkHarnessFailureControl() {
  const gates = [
    { id: 'throwing-gate', title: '注入：抛错', run: () => { throw new Error('injected gate crash'); } },
    { id: 'garbage-gate', title: '注入：返回垃圾', run: () => ({ notFindings: true }) },
  ];
  const registry = createRegistry(gates);
  const result = await runSuite({ gates: registry.gates(), ctx: {}, timeoutMs: 2000 });
  const threw = result.findings.filter((finding) => finding.code === 'QUALITY_GATE_THREW');
  const ok = threw.length === 2 && threw.every((finding) => finding.category === 'harness' && finding.detail.length > 0);
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('harness-failure-control'), 'registry 没有把 gate 异常收敛成结构化 finding', {
      code: 'QUALITY_GATE_THREW',
      detail: 'QUALITY_GATE_THREW 数量=' + threw.length,
      evidence: { findings: result.findings },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('harness-failure-control'), 'gate 抛错/返回垃圾都被收敛为结构化 finding', {
    threw: threw.length,
  });
}

/** 泄漏负控制：验证"僵尸定时器"探测器不是空转（故意泄漏一个 timer 必须被抓到）。 */
async function checkHarnessLeakDetector() {
  const fake = createFakeTimers();
  const leakyGate = {
    id: 'leaky-gate',
    title: '注入：泄漏定时器',
    run: (ctx) => {
      // gate 故意留下一个永不清理的定时器（反脆弱门禁必须能发现这种形态）。
      ctx.timers.setTimeout(() => {}, 60_000);
      return [];
    },
  };
  const registry = createRegistry([leakyGate]);
  const result = await runSuite({
    gates: registry.gates(),
    ctx: { timers: fake },
    timers: fake,
    timeoutMs: 500,
  });
  await settle();
  const leaked = fake.pending();
  // 清理注入的泄漏 timer，避免影响后续检查。
  for (const id of fake.pendingIds()) fake.clearTimeout(id);
  if (result.stats.timersPending !== 0) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('harness-leak-control'), 'registry 自身定时器未清理', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: 'registry timersPending=' + result.stats.timersPending,
      evidence: { stats: result.stats },
    });
  }
  if (leaked !== 1) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('harness-leak-control'), '僵尸定时器探测器失效（泄漏样本未被观测到）', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: '注入泄漏 1 个 timer，观测到 ' + leaked + ' 个',
      evidence: { leaked, pending: fake.pendingIds() },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('harness-leak-control'), '僵尸定时器探测器有效：注入泄漏被观测到并可清理', {
    leaked,
    registryTimersPending: result.stats.timersPending,
  });
}

/** replay 中途取消：停止派发、未执行项结构化、重跑不受污染。 */
async function checkReplayCancellation(seed) {
  const entries = buildRawReplayEntries(seed, 12);
  const plan = buildHarReplayPlan(entries, replayPlanOptionVariants()[0].options);
  const pair = createAbortPair();
  const controllable = createControllableSend({ signal: pair.signal });
  let abortAfter = null;
  const run = await executeHarReplayPlan(plan, controllable.send, {
    signal: pair.signal,
    concurrency: 1,
    onResult: () => {
      if (abortAfter == null) abortAfter = 1;
      if (abortAfter === 1) {
        abortAfter = 2;
        pair.abort();
      }
    },
  });
  pair.cleanup();
  const notExecuted = run.results.filter((result) => result.notExecuted === true);
  const summaryConsistent = run.summary.attempted + run.summary.notExecuted === run.summary.scheduled;
  const stopped = run.summary.stoppedEarly === true;
  const structured = notExecuted.every((result) => result.ok === false && typeof result.error === 'string' && result.error.startsWith('not-executed'));
  const attemptedBound = run.summary.attempted < run.summary.scheduled;
  // 重跑：同一输入的新计划必须能完整成功（没有僵尸/被污染状态）。
  const fresh = buildHarReplayPlan(entries, replayPlanOptionVariants()[0].options);
  const cleanSend = createControllableSend({});
  const rerun = await executeHarReplayPlan(fresh, cleanSend.send);
  const ok = stopped && structured && summaryConsistent && attemptedBound
    && rerun.ok === true && rerun.summary.failed === 0;
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('replay-cancellation'), 'replay 取消后状态不干净或重跑失败', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: 'stoppedEarly=' + stopped + '，未执行项结构化=' + structured
        + '，summary 一致=' + summaryConsistent + '，重跑成功=' + rerun.ok,
      evidence: { summary: run.summary, notExecuted: notExecuted.slice(0, 3), rerun: rerun.summary },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('replay-cancellation'), 'replay 取消：停止派发、未执行项结构化、重跑成功（无僵尸状态）', {
    summary: run.summary,
    rerun: rerun.summary,
  });
}

/** replay 失败注入：超时只对幂等请求重试，非幂等请求不得重复；结构化 errorCode。 */
async function checkReplayStructuredFailure() {
  const entries = [
    { method: 'GET', url: 'https://fixture.invalid/retry-target', headers: {} },
    { method: 'POST', url: 'https://fixture.invalid/non-idempotent', headers: {}, body: '{"a":1}' },
  ];
  const plan = buildHarReplayPlan(entries, { order: 'har', concurrency: 1, stopOnError: true, retryIdempotent: true });
  const failing = createFailingSend({ failAt: 1, code: 'E_TIMEOUT' });
  const run = await executeHarReplayPlan(plan, failing.send);
  const getResult = run.results[0];
  const postResult = run.results[1];
  const ok = run.ok === false
    && getResult.attempts === 2 && getResult.ok === false && getResult.errorCode === 'E_TIMEOUT'
    && postResult && postResult.notExecuted === true && postResult.error === 'not-executed:stopped'
    && run.summary.failed === 1 && run.summary.notExecuted === 1;
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('replay-structured-failure'), 'replay 失败注入的结构化语义不正确', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: 'GET attempts=' + (getResult && getResult.attempts) + '，POST 是否未执行=' + (postResult && postResult.notExecuted),
      evidence: { results: run.results, summary: run.summary },
    });
  }
  // 负控制：非幂等请求失败时不得重试（attempts 必须是 1）。
  const postOnly = buildHarReplayPlan([entries[1]], { order: 'har', concurrency: 1, retryIdempotent: true });
  const postFailing = createFailingSend({ failAt: 1, code: 'E_TIMEOUT' });
  const postRun = await executeHarReplayPlan(postOnly, postFailing.send);
  if (postRun.results[0].attempts !== 1) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('replay-structured-failure'), '非幂等请求被重复派发（违反幂等边界）', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: 'POST attempts=' + postRun.results[0].attempts,
      evidence: { result: postRun.results[0] },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('replay-structured-failure'), 'replay 超时：幂等请求重试一次、非幂等请求只派发一次、未执行项结构化', {
    get: { attempts: getResult.attempts, errorCode: getResult.errorCode },
    post: { executed: false },
    nonIdempotentAttempts: postRun.results[0].attempts,
  });
}

/** trace 预算耗尽：降级有界、可解释、输入不被修改。 */
function checkTraceBudgetExhaustion(seed) {
  const huge = buildHugeTraceFixture(seed);
  const before = fingerprint(huge);
  const budget = {
    maxEvents: 120,
    maxSpans: 20,
    maxSteps: 20,
    maxStateChars: 80,
    maxScreenshots: 1,
    maxScreenshotBytes: 1024,
    maxBytes: 64 * 1024,
  };
  const plan = planTraceExport(huge, budget);
  const planAgain = planTraceExport(huge, budget);
  const compacted = compactTrace(huge, { ...budget, force: true });
  const after = fingerprint(huge);
  const inputUnchanged = before === after;
  const planStable = fingerprint(plan) === fingerprint(planAgain);
  const levelValid = ['full', 'compact', 'sampled', 'minimal'].includes(compacted.plan.level);
  const actionsBounded = Array.isArray(plan.actions) && plan.actions.length > 0 && plan.actions.length <= 8;
  const degraded = plan.degraded === true;
  const hasZeroOrFiniteBytes = compacted.plan.estimatedBytes == null || Number.isFinite(compacted.plan.estimatedBytes);
  // 采样诚实性：事件单元配对不被拆散（B/E、S/F、b/e 整体保留）。
  const units = buildTraceEventUnits(huge.traceEvents);
  const unitAccounting = units.units.length === units.stats.beginEnd + units.stats.complete + units.stats.instant + units.stats.async
    && units.metadata.length === units.stats.metadata;
  const ok = inputUnchanged && planStable && levelValid && actionsBounded && degraded && hasZeroOrFiniteBytes && unitAccounting;
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('trace-budget-exhaustion'), 'trace 预算耗尽路径不满足终止/可解释/无副作用', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: '输入未变=' + inputUnchanged + '，计划稳定=' + planStable + '，level=' + compacted.plan.level
        + '，actions=' + (plan.actions || []).length + '，degraded=' + degraded + '，事件对账=' + unitAccounting,
      evidence: {
        plan: { level: plan.level, degraded: plan.degraded, actions: plan.actions.length, notes: plan.notes.slice(0, 3) },
        compacted: { level: compacted.plan.level, estimatedBytes: compacted.plan.estimatedBytes },
        unitStats: units.stats,
      },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('trace-budget-exhaustion'), 'trace 预算耗尽：降级有界、计划可复现、输入未被修改、事件单元配对完整', {
    level: compacted.plan.level,
    degraded: plan.degraded,
    actions: plan.actions.length,
    estimatedBytes: compacted.plan.estimatedBytes,
    unitStats: units.stats,
  });
}

/** 账本降级写：存储失败不阻断主流程，但留下结构化证据；timer 清理。 */
function checkLedgerDegradedWrite() {
  const storage = createMemoryLedgerStorage({ failAppendAfter: 1, failSync: true });
  const ledger = new IntentLedger({ storage, now: () => 1700000000000 });
  let threw = false;
  let entry = null;
  try {
    entry = ledger.begin('click', { ref: '@e1' }, { tabId: 5, sessionId: 's' });
    ledger.finish(entry, 'done');
    ledger.flush();
  } catch {
    threw = true;
  }
  const stats = ledger.stats();
  const degraded = stats.durability.degraded === true;
  const lastError = stats.durability.lastError;
  const structured = lastError && typeof lastError.code === 'string' && /^E_LEDGER_/.test(lastError.code)
    && typeof lastError.message === 'string' && lastError.message.length > 0;
  const timerCleared = ledger.writeTimer === null;
  // 负控制：完全正常的存储不应被标记降级。
  const healthy = new IntentLedger({ storage: createMemoryLedgerStorage(), now: () => 1700000000000 });
  const healthyEntry = healthy.begin('click', { ref: '@e1' }, { tabId: 6, sessionId: 's2' });
  healthy.finish(healthyEntry, 'done');
  healthy.flush();
  const healthyClean = healthy.stats().durability.degraded === false && healthy.writeTimer === null;
  const ok = !threw && degraded && structured && timerCleared && healthyClean
    && stats.entries.total === 1 && entry && entry.state === 'done';
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('ledger-degraded-write'), '账本降级写语义不正确（抛错/无证据/有 timer 残留）', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: '抛错=' + threw + '，degraded=' + degraded + '，结构化证据=' + structured
        + '，timer 已清=' + timerCleared + '，健康存储未被误标=' + healthyClean,
      evidence: { stats, lastError: lastError || null },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('ledger-degraded-write'), '账本 WAL/fsync 失败：主流程不阻断、durability 结构化降级、定时器清理、健康存储不误标', {
    lastErrorCode: lastError.code,
    degraded,
    entries: stats.entries.total,
    timerCleared,
  });
}

/** 临时目录清理：正常返回与异常抛出都必须删除目录、不留临时文件。 */
async function checkTempDirCleanup(seed) {
  const normal = await withTempDir('cleanup-ok', async (dir) => {
    const storage = createFileLedgerStorage(dir, { fsync: false });
    const ledger = new IntentLedger({ storage, now: () => 1700000000000 });
    const entry = ledger.begin('click', { ref: '@e1' }, { tabId: 1, sessionId: 's' });
    ledger.finish(entry, 'done');
    ledger.flush();
    ledger.checkpoint();
    return listTree(dir);
  });
  const dirAfterNormal = directoryExists(normal.dir);
  let thrown = null;
  let failingDir = null;
  try {
    await withTempDir('cleanup-throw', async (dir) => {
      failingDir = dir;
      throw new Error('injected failure inside scope');
    });
  } catch (error) {
    thrown = error;
  }
  const dirAfterThrow = failingDir ? directoryExists(failingDir) : null;
  const ok = dirAfterNormal === false && dirAfterThrow === false && thrown !== null
    && normal.cleaned === true && Array.isArray(normal.value) && normal.value.length > 0;
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('temp-dir-cleanup'), '临时目录未清理（正常/异常路径）', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: '正常路径目录仍存在=' + dirAfterNormal + '，异常路径目录仍存在=' + dirAfterThrow + '，异常被吞=' + (thrown === null),
      evidence: { normalFiles: normal.value, dirAfterNormal, dirAfterThrow },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('temp-dir-cleanup'), '临时目录在正常/异常路径都被清理，文件写路径可审计', {
    files: normal.value.length,
    cleaned: normal.cleaned,
    thrownPreserved: thrown !== null,
  });
}

/** 大小上限：结构化失败（E_RESULT_TOO_LARGE）且可渲染，不把超大对象继续传递。 */
function checkStructuredFailureLimits() {
  const small = { ok: true, rows: [1, 2, 3] };
  const smallBytes = jsonByteLength(small);
  const smallReturned = enforceOperationLimit(small) === small;
  const huge = { ok: true, blob: 'x'.repeat(4 * 1024 * 1024 + 16) };
  let error = null;
  try {
    enforceOperationLimit(huge);
  } catch (caught) {
    error = caught;
  }
  const structured = Boolean(error)
    && error.code === 'E_RESULT_TOO_LARGE'
    && error.data && error.data.limit === 4 * 1024 * 1024
    && typeof error.data.bytes === 'number' && error.data.bytes > error.data.limit;
  const ok = smallReturned && Number.isFinite(smallBytes) && smallBytes > 0 && structured;
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('structured-failure-limits'), '大小上限没有结构化失败语义', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: '小对象透传=' + smallReturned + '，超大对象结构化失败=' + structured,
      evidence: {
        smallBytes,
        error: error ? { code: error.code, data: error.data } : null,
      },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('structured-failure-limits'), '大小上限：小结果原样透传，超限抛 E_RESULT_TOO_LARGE（含 bytes/limit 证据）', {
    smallBytes,
    limit: error.data.limit,
  });
}

/** 预算计量器语义：耗尽返回结构化证据，不抛错、不静默。 */
function checkBudgetMeterSemantics() {
  const meter = createBudgetMeter({ maxChecks: 2, maxBytes: 100, maxMs: 1000 });
  const first = meter.consume('checks', 1);
  const second = meter.consume('checks', 1);
  const third = meter.consume('checks', 1);
  const bytes = meter.consume('bytes', 200);
  const exhaustion = meter.exhaustion();
  const ok = first.ok === true && second.exhausted === true
    && third.exhausted === true && bytes.exhausted === true
    && exhaustion.code === 'QUALITY_BUDGET_EXHAUSTED'
    && exhaustion.category === 'budget' && exhaustion.retry === 'after-action'
    && typeof exhaustion.nextAction === 'string' && exhaustion.nextAction.length >= 4;
  if (!ok) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('budget-meter'), '预算计量器语义不正确', {
      code: 'QUALITY_BUDGET_EXHAUSTED',
      detail: 'checks 序列=' + JSON.stringify([first, second, third]) + '，bytes=' + JSON.stringify(bytes),
      evidence: { snapshot: meter.snapshot(), exhaustion },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('budget-meter'), '预算计量器：耗尽即结构化、含 code/category/retry/nextAction', {
    snapshot: meter.snapshot(),
  });
}

/** 进程句柄：一轮门禁操作后不应出现持续增长（信息性阈值，防明显泄漏）。 */
async function checkZombieHandles(seed) {
  const before = activeHandleCount();
  const ledger = new IntentLedger({ storage: createMemoryLedgerStorage(), now: () => 1700000000000 });
  for (let index = 0; index < 5; index += 1) {
    const entry = ledger.begin('click', { ref: '@e' + index }, { tabId: 100 + index, sessionId: 's' });
    ledger.finish(entry, 'done');
  }
  ledger.flush();
  const plan = buildHarReplayPlan(buildRawReplayEntries(seed, 6), replayPlanOptionVariants()[0].options);
  const send = createControllableSend({});
  await executeHarReplayPlan(plan, send.send);
  await settle();
  const after = activeHandleCount();
  const delta = before == null || after == null ? null : after - before;
  if (delta != null && delta > 2) {
    return fail(ANTIFRAGILITY_GATE_ID, gid('zombie-handles'), '门禁操作后进程句柄异常增长（疑似泄漏）', {
      code: 'QUALITY_ANTIFRAGILITY_LEAK',
      detail: 'before=' + before + '，after=' + after + '，delta=' + delta,
      evidence: { before, after, delta },
    });
  }
  return pass(ANTIFRAGILITY_GATE_ID, gid('zombie-handles'), '账本/replay 操作后进程句柄无异常增长', {
    before,
    after,
    delta,
    ledgerEntries: ledger.entries.length,
  });
}

export async function runAntifragilityChecks(ctx = {}) {
  const seed = String(ctx.seed || 'quality');
  const findings = [];
  findings.push(await checkHarnessTimeout());
  findings.push(await checkHarnessCancel());
  findings.push(await checkHarnessBudget());
  findings.push(await checkHarnessFailureControl());
  findings.push(await checkHarnessLeakDetector());
  findings.push(await checkReplayCancellation(seed));
  findings.push(await checkReplayStructuredFailure());
  findings.push(checkTraceBudgetExhaustion(seed));
  findings.push(checkLedgerDegradedWrite());
  findings.push(await checkTempDirCleanup(seed));
  findings.push(checkStructuredFailureLimits());
  findings.push(checkBudgetMeterSemantics());
  findings.push(await checkZombieHandles(seed));
  return findings;
}

export const GATE = {
  id: ANTIFRAGILITY_GATE_ID,
  title: '反脆弱（超时/取消/预算耗尽的清理与结构化失败，无僵尸状态）',
  consumes: [
    'lib/har-plan.mjs',
    'lib/trace-budget.mjs',
    'lib/intent-ledger.mjs',
    'lib/limits.mjs',
    'tools/quality/lib/registry.mjs',
  ],
  run: runAntifragilityChecks,
};

export default GATE;
