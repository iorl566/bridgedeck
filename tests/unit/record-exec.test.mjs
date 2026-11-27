// tests/unit/record-exec.test.mjs —— 录制 program 执行器：
//   1) 规划（plan）：批次/分支点/并发区/取消域/human 步骤，纯只读；
//   2) dry-run：线性推进、human-gate 阻断/放行、失败注入与重试、并发 arm、取消（外部/条件/超时）；
//   3) 回放前置（preflight v2）：复用 record-program.preflightReplay 的既有判定，叠加图校验；
//   4) 报告证据：digest 可复算、轨迹可封存校验、resume/对账键/文本输出。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXEC_CODES,
  EXEC_LIMITS,
  EXEC_STATUS,
  EXEC_VERSION,
  createRecordExecutor,
  describeBatch,
  describeExecReport,
  diffTraces,
  dryRunProgram,
  execReconciliationKey,
  formatExecReport,
  matchesWhen,
  planProgram,
  preflightProgram,
  programHasGraphFeatures,
  resolveBranchDecision,
  sampledExec,
  summarizeExecReport,
  verifyExecPair,
} from '../../extension/src/lib/record-exec-plan.js';
import { programFingerprint, preflightReplay } from '../../extension/src/record-program.js';
import { PARALLEL_ROLES } from '../../extension/src/lib/record-step-graph.js';
import { TRACE_STATUSES } from '../../extension/src/lib/record-exec-trace.js';

let refCounter = 0;
function step(overrides = {}) {
  refCounter += 1;
  const base = {
    model: 2,
    ref: 'x' + refCounter,
    kind: 'action',
    type: 'action',
    method: 'click',
    params: { selector: '#go' },
    target: { selector: '#go' },
    idempotent: false,
    fallback: { onError: 'stop', skipReason: '' },
    risk: 'browser_mutation',
    evidence: { seq: refCounter, index: refCounter - 1, frameId: 0, documentId: 'doc-1', revision: 1, actor: 'human', url: 'https://a.test/f', at: 1_700_000_000_000 + refCounter },
    sourceKind: 'click',
  };
  return {
    ...base,
    ...overrides,
    params: { ...base.params, ...(overrides.params || {}) },
    evidence: { ...base.evidence, ...(overrides.evidence || {}) },
  };
}

function click(ref, overrides = {}) {
  return step({ ref, method: 'click', params: { selector: '#' + ref }, target: { selector: '#' + ref }, ...overrides });
}

function idle(ref, overrides = {}) {
  return step({ ref, kind: 'wait', type: 'wait', method: 'wait', idempotent: true, risk: 'read_only', target: null, params: {}, fallback: { onError: 'retry', retries: 1, retryDelayMs: 100 }, ...overrides });
}

function gate(ref, overrides = {}) {
  return step({
    ref,
    method: 'fill',
    kind: 'action',
    params: { selector: '#' + ref },
    target: { selector: '#' + ref },
    humanGate: { reason: '输入值被脱敏，回放前需要人工补值', valueKind: 'text' },
    risk: 'human_gate',
    ...overrides,
  });
}

function navigate(ref, options = null) {
  return step({
    ref,
    kind: 'branch',
    type: 'branch',
    method: 'navigate',
    params: { url: 'https://a.test/next' },
    idempotent: true,
    risk: 'read_only',
    target: null,
    branch: { boundary: 'document', source: 'navigation', url: 'https://a.test/next', ...(options ? { options } : {}) },
    sourceKind: 'navigate',
    expect: { urlIncludes: '/next' },
    fallback: { onError: 'retry', retries: 1, retryDelayMs: 400 },
  });
}

function forkGroup(prefix, arms) {
  const steps = [idle(prefix + '-fork', { parallel: { groupId: prefix, role: PARALLEL_ROLES.FORK } })];
  for (let arm = 0; arm < arms; arm += 1) {
    steps.push(step({ ref: prefix + '-arm' + arm, parallel: { groupId: prefix, role: PARALLEL_ROLES.ARM, arm } }));
  }
  steps.push(idle(prefix + '-join', { parallel: { groupId: prefix, role: PARALLEL_ROLES.JOIN } }));
  return steps;
}

test('matchesWhen：无 when 恒真；url/selectorValue/text/status/selectors/hasRef 条件', () => {
  assert.equal(matchesWhen(null), true);
  assert.equal(matchesWhen({}), true);
  const facts = { url: 'https://a.test/next?q=1', selectorValue: 'v', text: 'hello world', status: 'ok', selectors: ['#a'], hasRef: (index) => index === 2 };
  assert.equal(matchesWhen({ urlIncludes: '/next' }, facts), true);
  assert.equal(matchesWhen({ urlIncludes: '/missing' }, facts), false);
  assert.equal(matchesWhen({ urlEquals: 'https://a.test/next?q=1' }, facts), true);
  assert.equal(matchesWhen({ urlEquals: 'https://a.test/next' }, facts), false);
  assert.equal(matchesWhen({ selectorValue: 'v' }, facts), true);
  assert.equal(matchesWhen({ selectorValue: 'w' }, facts), false);
  assert.equal(matchesWhen({ textIncludes: 'world' }, facts), true);
  assert.equal(matchesWhen({ status: 'ok' }, facts), true);
  assert.equal(matchesWhen({ status: 'error' }, facts), false);
  assert.equal(matchesWhen({ selector: '#a' }, facts), true);
  assert.equal(matchesWhen({ selector: '#b' }, facts), false);
  assert.equal(matchesWhen({ selector: '#a' }, { hasSelector: (selector) => selector === '#a' }), true);
  assert.equal(matchesWhen({ refIndex: 2 }, facts), true);
  assert.equal(matchesWhen({ refIndex: 3 }, facts), false);
});

test('resolveBranchDecision：第一个命中选项 / fallthrough / 无选项', () => {
  const branch = {
    index: 1,
    ref: 'nav',
    fallthrough: 2,
    options: [
      { label: 'a', when: { urlIncludes: '/a' }, to: 5 },
      { label: 'b', when: { urlIncludes: '/b' }, to: 6 },
      { label: 'always', when: null, to: 7 },
    ],
  };
  const hitA = resolveBranchDecision(branch, { url: 'https://x/a' });
  assert.equal(hitA.matched, true);
  assert.equal(hitA.label, 'a');
  assert.equal(hitA.to, 5);
  const hitB = resolveBranchDecision(branch, { url: 'https://x/b' });
  assert.equal(hitB.label, 'b');
  const hitAlways = resolveBranchDecision(branch, { url: 'https://x/c' });
  assert.equal(hitAlways.label, 'always');
  assert.equal(hitAlways.reason, 'unconditional');
  const fallback = resolveBranchDecision({ ...branch, options: [{ label: 'a', when: { urlIncludes: '/a' }, to: 5 }] }, { url: 'https://x/z' });
  assert.equal(fallback.matched, false);
  assert.equal(fallback.to, 2);
  assert.equal(fallback.reason, 'no-option-matched');
  const none = resolveBranchDecision({ index: 0, ref: 'x', options: [], fallthrough: null }, {});
  assert.equal(none.reason, 'no-options');
  assert.equal(resolveBranchDecision(null).reason, 'no-branch');
});

test('plan：线性程序全 serial 批次、指纹/graph/预算上限常量', () => {
  const steps = [click('a'), click('b'), idle('c')];
  const plan = planProgram(steps);
  assert.equal(plan.version, EXEC_VERSION);
  assert.equal(plan.ok, true);
  assert.equal(plan.stats.batches, 3);
  assert.equal(plan.stats.serial, 3);
  assert.equal(plan.stats.parallel, 0);
  assert.equal(plan.stats.branches, 0);
  assert.equal(plan.graph.nodes, 3);
  assert.equal(plan.fingerprint, programFingerprint(steps));
  assert.equal(plan.branchPoints.length, 0);
  assert.equal(plan.parallelGroups.length, 0);
  assert.equal(plan.cancelScopes.length, 0);
  assert.equal(plan.humanSteps.length, 0);
  assert.equal(plan.batches[0].node.ref, 'a');
  assert.equal(plan.graphDigest.startsWith('g'), true);
  assert.equal(planProgram([]).ok, true);
  assert.ok(EXEC_LIMITS.maxSteps >= 100);
});

test('plan：分支点/并发区/取消域/human 步骤都进入规划输出', () => {
  const steps = [
    click('pre'),
    navigate('nav', [{ label: 'go', to: 2 }]),
    ...forkGroup('g', 2),
    gate('pwd'),
    step({ ref: 'paid', method: 'click', params: { selector: '#paid' }, target: { selector: '#paid' }, cancel: { scope: 'pay', onCancel: 'skip', afterMs: 500 } }),
    idle('close', { cancel: { scope: 'pay', close: true } }),
  ];
  const plan = planProgram(steps);
  assert.equal(plan.branchPoints.length, 1);
  assert.equal(plan.branchPoints[0].ref, 'nav');
  assert.equal(plan.branchPoints[0].options, 1);
  assert.equal(plan.parallelGroups.length, 1);
  assert.equal(plan.parallelGroups[0].arms, 2);
  assert.equal(plan.cancelScopes.length, 1);
  assert.equal(plan.cancelScopes[0].scope, 'pay');
  assert.equal(plan.cancelScopes[0].mode, 'skip');
  assert.equal(plan.humanSteps.length, 1);
  assert.equal(plan.humanSteps[0].ref, 'pwd');
  assert.equal(plan.humanSteps[0].valueKind, 'text');
  assert.equal(plan.stats.parallel, 1);
  assert.equal(plan.stats.branches, 1);
});

test('dryRun：线性完成、轨迹条数/摘要/指纹、报告 digest 可复算、checkpoint', () => {
  const steps = [click('a'), click('b'), idle('c')];
  const executor = createRecordExecutor({ now: () => 5000 });
  const report = executor.dryRun(steps, { allowNonIdempotent: true, includeTrace: true });
  assert.equal(report.version, EXEC_VERSION);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.dryRun, true);
  assert.equal(report.ok, true);
  assert.equal(report.status, EXEC_STATUS.COMPLETED);
  assert.equal(report.stats.steps, 3);
  assert.equal(report.stats.blockers, 0);
  assert.equal(report.fingerprint, programFingerprint(steps));
  assert.equal(report.trace.count, 3);
  assert.equal(report.traceSealed.count, 3);
  assert.equal(report.checkpoint.batchIndex, 3);
  assert.match(report.digest, /^x[0-9a-f]{8}$/);
  const verified = executor.verify(report);
  assert.equal(verified.ok, true);
  assert.equal(verified.digestOk, true);
  assert.equal(verified.traceOk, true);
  assert.equal(executor.lastRun.status, EXEC_STATUS.COMPLETED);
  assert.equal(executor.reportOf(report.runId).trace.count, 3);
  assert.equal(executor.list().length, 1);
  assert.equal(executor.counters().completed, 1);
  assert.equal(executor.counters().tabs === undefined, true);
  assert.equal(describeExecReport(report).includes('exec=completed'), true);
  const formatted = formatExecReport(report, { maxLines: 4 });
  assert.equal(formatted[0].startsWith('exec=completed'), true);
  assert.equal(formatted.length <= 4, true);
});

test('dryRun：空程序阻断；human-gate 默认阻断、提供值/策略 allow 时继续', () => {
  const executor = createRecordExecutor({ now: () => 100 });
  const empty = executor.dryRun([]);
  assert.equal(empty.status, EXEC_STATUS.BLOCKED);
  assert.equal(empty.ok, false);
  assert.equal(empty.blockers[0].code, EXEC_CODES.EXEC_EMPTY);

  const blocked = executor.dryRun([click('a'), gate('pwd')], { allowNonIdempotent: true });
  assert.equal(blocked.status, EXEC_STATUS.BLOCKED);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.human.required, 1);
  assert.equal(blocked.blockers.some((item) => item.code === EXEC_CODES.EXEC_HUMAN_REQUIRED), true);
  assert.equal(blocked.trace.count >= 1, true);

  const provided = executor.dryRun([click('a'), gate('pwd')], { allowNonIdempotent: true, humanValues: { pwd: 'secret' } });
  assert.equal(provided.status, EXEC_STATUS.COMPLETED);
  assert.equal(provided.human.provided, 1);
  assert.equal(provided.human.required, 0);

  const allowed = executor.dryRun([gate('pwd')], { allowNonIdempotent: true, humanPolicy: 'allow' });
  assert.equal(allowed.status, EXEC_STATUS.COMPLETED);
  assert.equal(allowed.human.required, 1);
  assert.equal(allowed.human.policy, 'allow');
});

test('dryRun：失败注入（stop/skip/continue）、幂等重试预算、非幂等重试 = 失败', () => {
  const executor = createRecordExecutor({ now: () => 1000 });
  const stop = executor.dryRun([click('a'), click('b')], { failAt: [1], failStrategy: 'stop' });
  assert.equal(stop.status, EXEC_STATUS.FAILED);
  assert.equal(stop.blockers.some((item) => item.code === EXEC_CODES.EXEC_FAILED_STEP), true);

  const skip = executor.dryRun([click('a'), click('b'), click('c')], { failAt: ['b'], failStrategy: 'skip' });
  assert.equal(skip.status, EXEC_STATUS.FAILED);
  assert.equal(skip.skipped.some((item) => item.ref === 'b'), true);

  const retried = executor.dryRun([idle('probe', { fallback: { onError: 'retry', retries: 2 } })], { failAt: ['probe'], allowNonIdempotent: true });
  assert.equal(retried.status, EXEC_STATUS.COMPLETED);
  assert.equal(retried.stats.retries, 2);
  assert.equal(retried.trace.retries, 2);

  const nonIdempotentRetry = executor.dryRun([click('risky', { fallback: { onError: 'retry', retries: 2 } })], { failAt: ['risky'], allowNonIdempotent: true });
  assert.equal(nonIdempotentRetry.status, EXEC_STATUS.BLOCKED, '非幂等重试在程序校验阶段就阻断');
  assert.equal(nonIdempotentRetry.blockers.some((item) => item.code === EXEC_CODES.EXEC_VALIDATION), true);
  assert.equal(nonIdempotentRetry.blockers.some((item) => item.issue === 'RETRY_NON_IDEMPOTENT'), true);

  const skipFallback = executor.dryRun([idle('opt', { fallback: { onError: 'skip' } })], { failAt: ['opt'], allowNonIdempotent: true });
  assert.equal(skipFallback.status, EXEC_STATUS.COMPLETED);
  assert.equal(skipFallback.skipped.some((item) => item.ref === 'opt'), true);
});

test('dryRun：并发区全 arm 执行、waitFor=race/any 提前结束、failFast 取消', () => {
  const executor = createRecordExecutor({ now: () => 1000 });
  const parallel = [idle('pre'), ...forkGroup('g', 2), click('post')];
  const all = executor.dryRun(parallel, { allowNonIdempotent: true });
  assert.equal(all.status, EXEC_STATUS.COMPLETED);
  assert.equal(all.parallel.length, 1);
  assert.equal(all.parallel[0].groupId, 'g');
  assert.equal(all.parallel[0].waitFor, 'all');
  assert.equal(all.parallel[0].arms.length, 2);
  assert.deepEqual(all.parallel[0].arms.map((arm) => arm.status), ['ok', 'ok']);
  assert.equal(all.trace.parallel, 2, '两个 arm 各一条 parallel 轨迹');
  assert.equal(all.stats.parallel, 2);

  const raceSteps = [idle('f', { parallel: { groupId: 'r', role: PARALLEL_ROLES.FORK, waitFor: 'race' } }), step({ ref: 'r0', parallel: { groupId: 'r', role: PARALLEL_ROLES.ARM, arm: 0 } }), step({ ref: 'r1', parallel: { groupId: 'r', role: PARALLEL_ROLES.ARM, arm: 1 } }), idle('j', { parallel: { groupId: 'r', role: PARALLEL_ROLES.JOIN, waitFor: 'race' } })];
  const race = executor.dryRun(raceSteps, { allowNonIdempotent: true });
  assert.equal(race.status, EXEC_STATUS.COMPLETED);
  assert.equal(race.parallel[0].waitFor, 'race');
  assert.equal(race.parallel[0].arms.length, 1, 'race 只跑第一个 arm');

  const failFastSteps = [
    idle('f', { parallel: { groupId: 'ff', role: PARALLEL_ROLES.FORK, failFast: true } }),
    click('ff0', { parallel: { groupId: 'ff', role: PARALLEL_ROLES.ARM, arm: 0 } }),
    click('ff1', { parallel: { groupId: 'ff', role: PARALLEL_ROLES.ARM, arm: 1 } }),
    idle('j', { parallel: { groupId: 'ff', role: PARALLEL_ROLES.JOIN } }),
  ];
  const failFast = executor.dryRun(failFastSteps, { failAt: ['ff0'], allowNonIdempotent: true, failStrategy: 'continue' });
  assert.equal(failFast.status, EXEC_STATUS.FAILED);
  assert.equal(failFast.cancels.some((item) => item.trigger === 'fail-fast'), true);
});

test('dryRun：取消（shouldCancel 条件 / 外部 cancel / 取消域超时 skip / 剩余步骤记 skipped）', () => {
  const executor = createRecordExecutor({ now: () => 1000 });
  const conditional = executor.dryRun([click('a'), click('b'), click('c')], {
    allowNonIdempotent: true,
    shouldCancel: ({ node }) => node.ref === 'b',
  });
  assert.equal(conditional.status, EXEC_STATUS.CANCELLED);
  assert.equal(conditional.cancels.length >= 1, true);
  assert.equal(conditional.skipped.some((item) => item.ref === 'c'), true);

  const skippedByScope = executor.dryRun([
    idle('slow', { waitBeforeMs: 300, cancel: { scope: 'pay', onCancel: 'skip', afterMs: 100 } }),
    click('pay-next', { cancel: { scope: 'pay' } }),
    click('pay-last', { cancel: { scope: 'pay', close: true } }),
    click('after'),
  ], { allowNonIdempotent: true });
  assert.equal(skippedByScope.status, EXEC_STATUS.COMPLETED);
  assert.equal(skippedByScope.skipped.some((item) => item.ref === 'pay-next'), true);
  assert.equal(skippedByScope.skipped.some((item) => item.ref === 'pay-last'), true);
  assert.equal(skippedByScope.stats.steps, 2, '只有 slow 与 after 真的执行');

  const aborted = executor.dryRun([
    idle('slow2', { waitBeforeMs: 300, cancel: { scope: 'ab', afterMs: 100 } }),
    click('ab-next', { cancel: { scope: 'ab' } }),
    click('ab-after'),
  ], { allowNonIdempotent: true });
  assert.equal(aborted.status, EXEC_STATUS.CANCELLED);
  assert.equal(aborted.blockers.some((item) => item.code === EXEC_CODES.EXEC_CANCELLED), true);
  assert.equal(aborted.skipped.some((item) => item.ref === 'ab-next'), true);

  const continued = executor.dryRun([
    idle('slow3', { waitBeforeMs: 300, cancel: { scope: 'co', onCancel: 'continue', afterMs: 100 } }),
    click('co-next', { cancel: { scope: 'co', close: true } }),
  ], { allowNonIdempotent: true });
  assert.equal(continued.status, EXEC_STATUS.COMPLETED);
  assert.equal(continued.warnings.some((item) => item.code === EXEC_CODES.EXEC_CANCELLED), true);

  const external = executor.dryRun([click('e1'), click('e2')], { allowNonIdempotent: true, shouldCancel: () => false });
  const cancelled = executor.cancel('user-stop');
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.reason, 'user-stop');
  assert.equal(executor.cancel().ok, true, '再次 cancel 幂等成功');
});

test('dryRun：预算（步数/模拟耗时/human-gate 数/重试上限）触发阻断', () => {
  const executor = createRecordExecutor({ now: () => 1000 });
  const steps = Array.from({ length: 6 }, (_, index) => click('b' + index));
  const stepBudget = executor.dryRun(steps, { allowNonIdempotent: true, maxSteps: 2 });
  assert.equal(stepBudget.status, EXEC_STATUS.FAILED);
  assert.equal(stepBudget.blockers.some((item) => item.code === EXEC_CODES.EXEC_BUDGET_STEPS), true);

  const duration = executor.dryRun([idle('w1', { waitBeforeMs: 5000 }), idle('w2', { waitBeforeMs: 5000 })], { allowNonIdempotent: true, maxDurationMs: 6000 });
  assert.equal(duration.blockers.some((item) => item.code === EXEC_CODES.EXEC_BUDGET_DURATION), true);

  const human = executor.dryRun([gate('h1'), gate('h2')], { allowNonIdempotent: true, humanPolicy: 'allow', maxHumanGates: 1 });
  assert.equal(human.blockers.some((item) => item.code === EXEC_CODES.EXEC_HUMAN_LIMIT), true);

  const retryBudget = executor.dryRun([idle('r1', { fallback: { onError: 'retry', retries: 4 } })], { failAt: ['r1'], allowNonIdempotent: true, maxRetries: 2 });
  assert.equal(retryBudget.blockers.some((item) => item.code === EXEC_CODES.EXEC_BUDGET_RETRIES), true);
});

test('preflight：线性判定与 record-program.preflightReplay 一致，叠加图校验/执行器阻断', () => {
  const steps = [click('a'), navigate('nav'), idle('b')];
  const executor = createRecordExecutor({ now: () => 1000 });
  const base = preflightReplay(steps, { allowNonIdempotent: true, requireHumanValues: false });
  const v2 = executor.preflight(steps, { allowNonIdempotent: true, requireHumanValues: false });
  assert.equal(v2.ok, base.ok);
  assert.equal(v2.allowed, base.allowed);
  assert.equal(v2.token, base.token);
  assert.equal(v2.fingerprint, base.fingerprint);
  assert.equal(v2.executable, true);
  assert.equal(v2.graphValidation.ok, true);
  assert.equal(v2.preflight.version, EXEC_VERSION);
  assert.equal(v2.preflight.rules_evaluated, 18);
  assert.equal(v2.plan.stats.batches, 3);
  assert.equal(Array.isArray(v2.replayPlanV2), true);
  assert.equal(v2.replayPlanV2.length, 3);

  // 副作用阻断沿用既有语义（allowNonIdempotent 缺省为 false）。
  const blocked = executor.preflight([click('side')], { requireHumanValues: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockers.some((item) => item.code === 'REPLAY_SIDE_EFFECT'), true);
  assert.equal(blocked.executable, false);

  // human-gate 未给值：沿用既有 requiresHuman。
  const human = executor.preflight([gate('pwd')], { allowNonIdempotent: true });
  assert.equal(human.requiresHuman.length, 1);
  assert.equal(human.ok, false);
  assert.equal(human.preflight.requiredHuman, 1);
});

test('preflight：并发缺 join / 图规模错误 → 附加阻断（EXEC_GRAPH/EXEC_PARALLEL_NO_JOIN）', () => {
  const executor = createRecordExecutor({ now: () => 1000 });
  const open = executor.preflight([
    idle('f', { parallel: { groupId: 'open', role: PARALLEL_ROLES.FORK } }),
    click('a', { parallel: { groupId: 'open', role: PARALLEL_ROLES.ARM, arm: 0 } }),
  ], { allowNonIdempotent: true, requireHumanValues: false });
  assert.equal(open.ok, false);
  assert.equal(open.blockers.some((item) => item.code === EXEC_CODES.EXEC_PARALLEL_NO_JOIN), true);
  assert.equal(open.competingBlockers === undefined, true);

  const overlap = executor.preflight([
    click('o1', { cancel: { scope: 'x' } }),
    click('o2', { cancel: { scope: 'y' } }),
    click('o3', { cancel: { scope: 'x', close: true } }),
    click('o4', { cancel: { scope: 'y', close: true } }),
  ], { allowNonIdempotent: true, requireHumanValues: false });
  assert.equal(overlap.ok, false);
  assert.equal(overlap.blockers.some((item) => item.code === EXEC_CODES.EXEC_CANCEL_UNKNOWN_SCOPE), true);
});

test('resume：从 checkpoint 续跑；报告 digest 篡改可被发现', () => {
  let clock = 1000;
  const executor = createRecordExecutor({ now: () => clock });
  const steps = [click('a'), click('b'), click('c')];
  const first = executor.dryRun(steps, { allowNonIdempotent: true, startAtBatch: 0 });
  assert.equal(first.checkpoint.batchIndex, 3);
  const resumed = executor.resume(first, steps, { allowNonIdempotent: true });
  assert.equal(resumed.status, EXEC_STATUS.COMPLETED);
  assert.equal(resumed.stats.steps, 0, 'checkpoint 到末尾后续跑没有新步骤');
  assert.equal(executor.counters().resumed, 1);

  const partial = executor.dryRun(steps, { allowNonIdempotent: true, startAtBatch: 1 });
  assert.equal(partial.stats.steps, 2);
  const badResume = executor.resume({}, steps);
  assert.equal(badResume.ok, false);
  assert.equal(badResume.code, EXEC_CODES.EXEC_BAD_ARG);

  const tampered = { ...first, status: EXEC_STATUS.FAILED };
  assert.equal(executor.verify(tampered).ok, false);
  assert.equal(executor.verify(null).ok, false);
  clock += 1;
});

test('便捷入口/摘要/对账键/图特征/轨迹 diff 与格式：字段有界且一致', () => {
  const steps = [click('a'), gate('p'), idle('b')];
  const report = dryRunProgram(steps, { allowNonIdempotent: true, humanPolicy: 'allow', includeTrace: true, now: () => 1000 });
  assert.equal(report.status, EXEC_STATUS.COMPLETED);
  const summary = summarizeExecReport(report);
  assert.equal(summary.version, EXEC_VERSION);
  assert.equal(summary.digest, report.digest);
  assert.equal(summary.steps, 3);
  assert.equal(summary.trace.count, 3);
  assert.equal(summary.requiresHuman, 1);
  assert.ok(JSON.stringify(summary).length < 600);
  assert.equal(summarizeExecReport(null), null);

  const key = execReconciliationKey(report, null);
  assert.match(key, /^r1-[0-9a-f]{8}$/);
  assert.equal(execReconciliationKey(report, null), key);
  const pair = verifyExecPair(report, null);
  assert.equal(pair.digestOk, true);

  const features = programHasGraphFeatures(steps);
  assert.equal(features.parallel, false);
  assert.equal(features.branches, false);
  const parallelFeatures = programHasGraphFeatures(forkGroup('pf', 2));
  assert.equal(parallelFeatures.parallel, true);

  const sampled = sampledExec(steps, { allowNonIdempotent: true, humanPolicy: 'allow', includeTrace: true });
  assert.equal(sampled.summary.steps, 3);
  assert.match(sampled.text, /exec=completed/);

  const traced = dryRunProgram(steps, { allowNonIdempotent: true, humanPolicy: 'allow', includeTrace: true });
  const diff = diffTraces(traced.traceSealed.entries, traced.traceSealed.entries);
  assert.equal(diff.equal, true);

  const branch = { kind: 'serial', index: 1, node: { ref: 'a' } };
  assert.equal(describeBatch(branch), 'serial:1');
  assert.equal(describeBatch(null), 'unknown');
  assert.deepEqual(formatExecReport(null), ['record-exec: 无报告']);
});

test('默认行为不变：无额外字段的程序 dry-run 崩溃点为零，EXEC_STATUS 枚举稳定', () => {
  assert.deepEqual(Object.values(EXEC_STATUS).sort(), ['blocked', 'cancelled', 'completed', 'failed', 'ready', 'running']);
  assert.equal(TRACE_STATUSES.BLOCKED, 'blocked');
  const executor = createRecordExecutor();
  const report = executor.dryRun([click('only')], { allowNonIdempotent: true });
  assert.equal(report.status, EXEC_STATUS.COMPLETED);
  assert.equal(report.graph.parallel, 0);
  assert.equal(report.graph.cancels, 0);
  assert.equal(report.graph.branches, 0);
  assert.equal(executor.reset().cleared, 1);
  assert.equal(executor.list().length, 0);
  assert.equal(executor.counters().active, 0);
});

test('dryRun：分支批次按 facts 命中选择并记录 branchDecisions；无命中走 fallthrough', () => {
  const branchStep = navigate('nav', [{ label: 'next-page', when: { urlIncludes: '/next' }, to: 2 }]);
  const steps = [click('start'), branchStep, idle('landed')];
  const executor = createRecordExecutor({ now: () => 1000 });
  const hit = executor.dryRun(steps, {
    allowNonIdempotent: true,
    requireHumanValues: false,
    facts: { url: 'https://a.test/next?x=1' },
  });
  assert.equal(hit.status, EXEC_STATUS.COMPLETED);
  assert.equal(hit.branchDecisions.length, 1);
  assert.equal(hit.branchDecisions[0].index, 1);
  assert.equal(hit.branchDecisions[0].ref, 'nav');
  assert.equal(hit.branchDecisions[0].matched, true);
  assert.equal(hit.branchDecisions[0].label, 'next-page');
  assert.equal(hit.branchDecisions[0].to, 2);
  assert.equal(hit.stats.branches, 1);
  assert.equal(hit.trace.branches, 1);

  const missed = executor.dryRun(steps, {
    allowNonIdempotent: true,
    facts: { url: 'https://a.test/other' },
  });
  assert.equal(missed.branchDecisions[0].matched, false);
  assert.equal(missed.branchDecisions[0].reason, 'no-option-matched');
  assert.equal(missed.branchDecisions[0].to, 2, 'fallthrough 指向下一步');
});

test('plan/preflight 边界：取消域被识别、封存轨迹可格式化、两次 dry-run 可 diff', () => {
  const steps = [idle('f', { cancel: { scope: 'pay', onClose: 'skip', close: true } })];
  const plan = planProgram(steps);
  assert.equal(plan.cancelScopes.length, 1);
  const features = programHasGraphFeatures(steps);
  assert.equal(features.cancels, true);
  assert.equal(features.graph.cancels, 1);

  const withTrace = dryRunProgram([click('a'), idle('b')], { allowNonIdempotent: true, includeTrace: true });
  const formatted = formatExecReport(withTrace, { maxLines: 6 });
  assert.equal(formatted[0].startsWith('exec=completed'), true);
  assert.equal(formatted.length <= 6, true);
  assert.equal(formatted.some((line) => line.includes(' serial ')), true);

  const executor = createRecordExecutor({ now: () => 1000 });
  const left = executor.dryRun([click('a'), idle('b')], { allowNonIdempotent: true, includeTrace: true });
  const right = executor.dryRun([click('a'), idle('b')], { allowNonIdempotent: true, includeTrace: true });
  const diff = executor.diffReports(left, right);
  assert.equal(diff.equal, true, '同一程序两次 dry-run 轨迹一致');
  assert.equal(executor.diffReports({}, {}).equal, true, '无封存轨迹时退化为分支决策 diff');
});
