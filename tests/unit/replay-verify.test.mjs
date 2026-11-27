// tests/unit/replay-verify.test.mjs —— 回放自检：计划/覆盖/确定性/覆盖对照/总报告。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../extension/src/lib/replay-plan.js';
import * as V from '../../extension/src/lib/replay-verify.js';

let counter = 0;
function step(index, overrides = {}) {
  counter += 1;
  const target = '#s' + counter;
  return {
    ref: 'r' + counter,
    kind: 'action',
    method: 'click',
    params: { selector: target },
    target: { selector: target },
    idempotent: true,
    fallback: { onError: 'stop' },
    risk: 'read_only',
    evidence: { seq: index + 1, index, frameId: 0, documentId: 'doc-1', revision: 1, url: 'https://a.test/', actor: 'human', at: 1_700_000_000_000 + index },
    ...overrides,
  };
}

const baseOptions = { allowNonIdempotent: true, requireHumanValues: false };

test('verifyPlan：正常计划全部通过；checksum 可复算', () => {
  const plan = P.buildReplayPlan([step(0), step(1)], baseOptions);
  const result = V.verifyPlan(plan);
  assert.equal(result.ok, true);
  assert.equal(result.grade, 'pass');
  assert.equal(result.checksum.length, 8);
  assert.deepEqual(result.checks.map((check) => check.id), [
    'VERIFY_PLAN_SHAPE',
    'VERIFY_PLAN_FINGERPRINT',
    'VERIFY_PLAN_SCHEDULE',
    'VERIFY_PLAN_CHECKPOINTS',
    'VERIFY_PLAN_HUMAN_ORDER',
    'VERIFY_PLAN_BOUNDARY',
    'VERIFY_PLAN_TARGETS',
    'VERIFY_PLAN_BUDGET',
  ]);
  assert.equal(V.replayChecksum(plan), V.replayChecksum(plan));
});

test('verifyPlan：指纹/时间线/检查点/human 顺序/边界/预算 的破坏都能被识别', () => {
  const plan = P.buildReplayPlan([step(0), step(1)], baseOptions);

  const fingerprintBroken = structuredClone(plan);
  fingerprintBroken.fingerprint = 'deadbeef';
  assert.equal(V.verifyPlan(fingerprintBroken).ok, false);
  assert.equal(V.verifyPlan(fingerprintBroken).issues.some((issue) => issue.code === V.VERIFY_CODES.PLAN_FINGERPRINT), true);

  const scheduleBroken = structuredClone(plan);
  scheduleBroken.schedule.totalDelayMs += 100;
  assert.equal(V.verifyPlan(scheduleBroken).issues.some((issue) => issue.code === V.VERIFY_CODES.PLAN_SCHEDULE), true);

  const checkpointsBroken = structuredClone(plan);
  checkpointsBroken.checkpoints = [{ id: 'x', index: 99, kind: 'boundary' }];
  assert.equal(V.verifyPlan(checkpointsBroken).issues.some((issue) => issue.code === V.VERIFY_CODES.PLAN_CHECKPOINTS), true);

  const humanBroken = structuredClone(plan);
  humanBroken.steps[1].kind = 'action';
  humanBroken.steps[1].waitsForHuman = true;
  humanBroken.steps.splice(0, 1);
  humanBroken.steps.forEach((item, index) => { item.index = index; });
  humanBroken.fingerprint = P.planFingerprint(humanBroken.steps);
  assert.equal(V.verifyPlan(humanBroken).issues.some((issue) => issue.code === V.VERIFY_CODES.PLAN_HUMAN_ORDER), true);

  const targetBroken = structuredClone(plan);
  targetBroken.targets.steps[0].status = 'ambiguous';
  assert.equal(V.verifyPlan(targetBroken, { strict: true }).issues.some((issue) => issue.code === V.VERIFY_CODES.PLAN_TARGETS), true);

  const boundaryBroken = structuredClone(plan);
  boundaryBroken.boundaries.transitions = [{ kind: 'document', toIndex: 1, canNavigate: false }];
  boundaryBroken.boundaries.blockers = [];
  assert.equal(V.verifyPlan(boundaryBroken).issues.some((issue) => issue.code === V.VERIFY_CODES.PLAN_BOUNDARY), true);

  assert.equal(V.verifyPlan(null).ok, false);
});

test('verifyBudget：步数/重试/等待 上限', () => {
  const plan = P.buildReplayPlan([step(0), step(1)], baseOptions);
  assert.equal(V.verifyBudget(plan, { maxSteps: 10, maxRetries: 10, maxTotalMs: 10_000 }).ok, true);
  const tight = V.verifyBudget(plan, { maxSteps: 1, maxRetries: 0, maxTotalMs: 1 });
  assert.equal(tight.ok, false);
  assert.equal(tight.issues.length, 1);
  assert.equal(tight.issues[0].code, 'BUDGET_STEPS');
});

test('verifyOutcomes：缺步/多步/重复/乱序', () => {
  const plan = { steps: [{ index: 0 }, { index: 1 }, { index: 2 }] };
  const ok = V.verifyOutcomes(plan, [{ index: 0 }, { index: 1 }, { index: 2 }]);
  assert.equal(ok.ok, true);
  const missing = V.verifyOutcomes(plan, [{ index: 0 }]);
  assert.deepEqual(missing.missing, [1, 2]);
  const extra = V.verifyOutcomes(plan, [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 9 }]);
  assert.deepEqual(extra.extra, [9]);
  const duplicate = V.verifyOutcomes(plan, [{ index: 0 }, { index: 0 }, { index: 1 }, { index: 2 }]);
  assert.deepEqual(duplicate.duplicates, [0]);
  const outOfOrder = V.verifyOutcomes(plan, [{ index: 1 }, { index: 0 }, { index: 2 }]);
  assert.equal(outOfOrder.outOfOrder.length, 1);
  assert.equal(V.verifyOutcomes({ steps: [] }, []).ok, true);
});

test('verifyOutcomeVerdicts：失败步骤生成可解释失败', () => {
  const plan = P.buildReplayPlan([step(0), step(1)], baseOptions);
  const outcomes = [
    { index: 0, ok: true, severity: 'pass', code: 'DIFF_OK' },
    { index: 1, ok: false, severity: 'fail', code: 'DIFF_VALUE_MISMATCH', differences: [{ path: 'expect.text', kind: 'value', severity: 'fail', expected: 'a', actual: 'b' }] },
  ];
  const result = V.verifyOutcomeVerdicts(plan, outcomes);
  assert.equal(result.verdict.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].category, 'diff');
});

test('verifyAgainstRecord：丢失非幂等步骤会被抓出来，只读 observe 可被简化掉', () => {
  const recorded = [step(0), step(1, { idempotent: false, kind: 'action' }), step(2, { kind: 'observe', method: 'observe', target: null, params: {} })];
  const planned = P.buildReplayPlan(recorded.slice(0, 2), baseOptions);
  const coverage = V.verifyAgainstRecord(recorded, planned);
  assert.equal(coverage.ok, true);
  assert.equal(coverage.dropped.length, 0);

  const missingSideEffect = V.verifyAgainstRecord(recorded, P.buildReplayPlan([recorded[0]], baseOptions));
  assert.equal(missingSideEffect.ok, false);
  assert.equal(missingSideEffect.dropped.some((item) => item.kind === 'action'), true);

  const extra = V.verifyAgainstRecord([step(0)], P.buildReplayPlan([step(0), step(1)], baseOptions));
  assert.equal(extra.extra.length >= 1, true);
  assert.equal(V.verifyAgainstRecord(null, planned).ok, true);
});

test('verifyDeterminism：同输入两次构建一致', () => {
  const input = [step(0), step(1)];
  const result = V.verifyDeterminism(input, baseOptions);
  assert.equal(result.deterministic, true);
  assert.equal(result.tokenA, result.tokenB);
  assert.equal(result.fingerprintA, result.fingerprintB);
  assert.equal(result.mismatches.length, 0);
});

test('resumePointFrom：连续完成才可信；无检查点返回 no-checkpoint', () => {
  const plan = P.buildReplayPlan([step(0), step(1), step(2), step(3)], { ...baseOptions, limits: { checkpointEvery: 2 } });
  const resume = V.resumePointFrom(plan, [0, 1]);
  assert.equal(resume.ok, true);
  assert.equal(resume.completed, 2);
  assert.equal(resume.fromIndex >= 2, true);
  const gap = V.resumePointFrom(plan, [0, 2]);
  assert.equal(gap.completed, 1);
  assert.equal(V.resumePointFrom({ steps: [], checkpoints: [] }, []).ok, false);
  assert.equal(V.resumePointFrom(null, []).ok, false);
});

test('verifyBoundaryTrail：运行期边界偏离计划', () => {
  const plan = P.buildReplayPlan([step(0, { evidence: { documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/' } })], baseOptions);
  plan.boundaries.plans[0] = { ...plan.boundaries.plans[0], action: 'navigate', urlKey: 'https://a.test/next' };
  const mismatch = V.verifyBoundaryTrail(plan, [{ index: 0, boundary: { documentId: 'doc-1', frameId: 0, revision: 1, urlKey: 'https://a.test/' } }]);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.issues[0].code, 'BOUNDARY_TRAIL_URL');
  assert.equal(V.verifyBoundaryTrail(plan, []).ok, true);
});

test('verifyReplay：全通过 / 失败判决 / 录制覆盖 / 确定性 / 轨迹', () => {
  const recorded = [step(0), step(1)];
  const plan = P.buildReplayPlan(recorded, baseOptions);
  const passing = V.verifyReplay(plan, [{ index: 0, ok: true, severity: 'pass', code: 'DIFF_OK' }, { index: 1, ok: true, severity: 'pass', code: 'DIFF_OK' }], {
    record: recorded,
    verifyDeterminism: true,
    buildInput: recorded,
    buildOptions: baseOptions,
    trail: [{ index: 0, boundary: plan.steps[0].boundary }],
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.grade, 'pass');
  assert.equal(passing.coverage.missing, 0);
  assert.equal(passing.determinism, true);
  assert.equal(passing.planToken, plan.token);
  assert.equal(passing.failures.length, 0);
  assert.match(V.renderVerifyReport(passing, { verbose: true }), /回放自检 PASS/);

  const failing = V.verifyReplay(plan, [
    { index: 0, ok: true, severity: 'pass', code: 'DIFF_OK' },
    { index: 1, ok: false, severity: 'fail', code: 'DIFF_VALUE_MISMATCH', differences: [{ path: 'expect.text', kind: 'value', severity: 'fail', expected: 'a', actual: 'b' }] },
  ], { record: recorded });
  assert.equal(failing.ok, false);
  assert.equal(failing.grade, 'fail');
  assert.equal(failing.failures.length >= 1, true);
  assert.equal(failing.failureReport.total >= 1, true);

  const coverageFailure = V.verifyReplay(plan, [{ index: 0, ok: true, severity: 'pass', code: 'DIFF_OK' }], {});
  assert.equal(coverageFailure.coverage.missing, 1);
  assert.equal(coverageFailure.ok, false);

  const recordFailure = V.verifyReplay(P.buildReplayPlan([recorded[0]], baseOptions), [{ index: 0, ok: true, severity: 'pass', code: 'DIFF_OK' }], {
    record: [recorded[0], { ...recorded[1], idempotent: false }],
  });
  assert.equal(recordFailure.checks.some((check) => check.id === V.VERIFY_CODES.RECORD_COVERAGE && check.ok === false), true);
});

test('gradeOf / summarizeVerify / renderVerifyReport 边界输入', () => {
  assert.equal(V.gradeOf([{ ok: true, severity: 'pass' }]), 'pass');
  assert.equal(V.gradeOf([{ ok: true, severity: 'warning' }]), 'warn');
  assert.equal(V.gradeOf([{ ok: false, severity: 'fail' }]), 'fail');
  assert.equal(V.gradeOf([]), 'pass');
  assert.equal(V.summarizeVerify(null), null);
  const summary = V.summarizeVerify(V.verifyReplay(P.buildReplayPlan([step(0)], baseOptions), []));
  assert.equal(typeof summary.checksum, 'string');
  assert.equal(typeof summary.grade, 'string');
  assert.equal(V.renderVerifyReport(null), '回放自检：无报告');
});
