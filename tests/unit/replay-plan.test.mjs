// tests/unit/replay-plan.test.mjs —— 确定性回放计划：展开/等待/检查点/预算/阻塞/确定性。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../extension/src/lib/replay-plan.js';
import * as VIEW from '../../extension/src/lib/replay-plan-view.js';
import { preflightReplay } from '../../extension/src/record-program.js';

let refCounter = 0;
function step(index, overrides = {}) {
  refCounter += 1;
  const base = {
    model: 2,
    ref: overrides.ref || 'r' + refCounter,
    kind: 'action',
    type: 'action',
    method: 'click',
    params: { selector: '#x' + index },
    target: { selector: '#x' + index },
    idempotent: true,
    fallback: { onError: 'stop', skipReason: '' },
    risk: 'read_only',
    evidence: { seq: index + 1, index, frameId: 0, documentId: 'doc-1', revision: 1, url: 'https://a.test/', actor: 'human', at: 1_700_000_000_000 + index * 100 },
    sourceKind: 'click',
  };
  return { ...base, ...overrides, evidence: { ...base.evidence, ...(overrides.evidence || {}) } };
}

function navigate(index, url = 'https://a.test/next', overrides = {}) {
  return step(index, {
    kind: 'branch',
    type: 'branch',
    method: 'navigate',
    params: { url },
    target: null,
    idempotent: true,
    risk: 'read_only',
    fallback: { onError: 'retry', retries: 1, retryDelayMs: 400 },
    evidence: { documentId: 'doc-2', revision: 0, url, ...(overrides.evidence || {}) },
    branch: { boundary: 'document', source: 'navigation', url },
    ...overrides,
  });
}

const baseOptions = { allowNonIdempotent: true, requireHumanValues: false };

test('stableStringify：键排序、undefined 省略、非有限数字 null、嵌套稳定', () => {
  const left = { b: 1, a: { d: undefined, c: [1, undefined, NaN] } };
  const right = { a: { c: [1, null, null] }, b: 1 };
  assert.equal(P.stableStringify(left), P.stableStringify(right));
  assert.equal(P.stableStringify('x'), '"x"');
  assert.equal(P.stableStringify(undefined), 'null');
  assert.equal(P.stableStringify(1.5), '1.5');
});

test('normalizePlanLimits：嵌套 limits 与直接参数都接受', () => {
  const nested = P.normalizePlanLimits({ limits: { maxSteps: 10, maxWaitMs: 500 } });
  assert.equal(nested.maxSteps, 10);
  assert.equal(nested.maxWaitMs, 500);
  assert.equal(nested.maxLoopIterations, P.DEFAULT_PLAN_LIMITS.maxLoopIterations);
  const flat = P.normalizePlanLimits({ maxSteps: 7 });
  assert.equal(flat.maxSteps, 7);
  assert.equal(P.normalizePlanLimits({ maxSteps: -1 }).maxSteps, P.DEFAULT_PLAN_LIMITS.maxSteps);
});

test('normalizePlanStep：kind 映射、参数截断、wait/repeat 上限', () => {
  const human = P.normalizePlanStep({ kind: 'human-gate', method: 'fill', params: { value: 'x'.repeat(600) }, humanGate: { reason: 'r', valueKind: 'text' } }, 0);
  assert.equal(human.kind, 'human');
  assert.equal(human.params.value.length <= P.DEFAULT_PLAN_LIMITS.maxParamText, true);
  assert.equal(human.humanGate.reason, 'r');
  assert.equal(human.waitsForHuman, false);

  const branch = P.normalizePlanStep({ kind: 'branch', method: 'navigate', params: { url: 'https://a.test/' } }, 1);
  assert.equal(branch.kind, 'branch');
  assert.equal(branch.boundary.urlKey, 'https://a.test/');

  const capped = P.normalizePlanStep({ kind: 'action', method: 'click', waitBeforeMs: 999_999, repeat: 999 }, 2);
  assert.equal(capped.waitBeforeMs, P.DEFAULT_PLAN_LIMITS.maxWaitMs);
  assert.equal(capped.repeat, P.DEFAULT_PLAN_LIMITS.maxLoopIterations);
  assert.equal(capped.fallback.onError, 'stop');
  assert.equal(P.normalizePlanStep({ kind: 'weird' }, 3).kind, 'action');
});

test('coercePlanInput：steps / 录制事件 / program / preflight 四种形状', () => {
  assert.equal(P.coercePlanInput([step(0)]).source, 'steps');
  const events = [{ recordStep: step(0) }, { recordStep: step(1) }];
  assert.equal(P.coercePlanInput(events).nodes.length, 2);
  assert.equal(P.coercePlanInput(events).source, 'events');
  const program = P.coercePlanInput({ nodes: [step(0)], loops: [{ from: 0, to: 0, count: 2 }], segments: [] });
  assert.equal(program.source, 'program');
  assert.equal(program.loops.length, 1);
  const preflight = { replayPlan: [{ index: 0, kind: 'action', method: 'click', params: { selector: '#a' }, idempotent: true }, { index: 1, kind: 'branch', method: 'navigate', boundary: { documentId: 'd', frameId: 0, revision: 0, url: 'https://a.test/n' }, ref: 'b1' }], token: 'rp-1' };
  const coerced = P.coercePlanInput(preflight);
  assert.equal(coerced.source, 'preflight');
  assert.equal(coerced.nodes.length, 2);
  assert.equal(coerced.nodes[1].branch.boundary, 'document');
  assert.equal(P.coercePlanInput(null).nodes.length, 0);
});

test('expandLoops：loop 展开、step.repeat、超限 clamp、重叠告警', () => {
  const steps = [step(0, { kind: 'action' }), step(1, { kind: 'action' })];
  const looped = P.expandLoops(steps, [{ from: 0, to: 1, count: 3 }], P.DEFAULT_PLAN_LIMITS);
  assert.equal(looped.steps.length, 6);
  assert.deepEqual(looped.steps.map((item) => item.iteration), [0, 0, 1, 1, 2, 2]);
  assert.equal(looped.steps[0].loopOf, 0);

  const repeated = P.expandLoops([step(0, { repeat: 3, kind: 'action', idempotent: false })], [], P.DEFAULT_PLAN_LIMITS);
  assert.equal(repeated.steps.length, 3);
  assert.equal(repeated.steps[2].iterateOf.startsWith('r'), true);
  assert.equal(repeated.steps[2].idempotent, false);

  const clamped = P.expandLoops([step(0, { repeat: 999 })], [], { ...P.DEFAULT_PLAN_LIMITS, maxLoopIterations: 2 });
  assert.equal(clamped.steps.length, 2);
  assert.equal(clamped.warnings.some((warning) => warning.code === P.PLAN_CODES.LOOP_CLAMPED), true);

  const overlap = P.expandLoops(steps, [{ from: 0, to: 1, count: 2 }, { from: 1, to: 1, count: 2 }], P.DEFAULT_PLAN_LIMITS);
  assert.equal(overlap.warnings.some((warning) => warning.code === P.PLAN_CODES.LOOP_OVERLAP), true);
});

test('insertWaitsAndHuman：waitBeforeMs 逐动作插入、显式 wait 合并、human 步骤插在动作前', () => {
  const steps = [
    step(0, { waitBeforeMs: 100, idempotent: true }),
    step(1, { waitBeforeMs: 200, kind: 'action' }),
    step(2, { humanGate: { reason: '补值', valueKind: 'text' }, params: { selector: '#p', value: 'v' }, kind: 'action' }),
  ];
  const result = P.insertWaitsAndHuman(steps, P.DEFAULT_PLAN_LIMITS);
  assert.equal(result.waits, 2);
  assert.equal(result.humans, 1);
  assert.deepEqual(result.steps.filter((item) => item.kind === 'wait').map((item) => item.ms), [100, 200]);
  const merged = P.insertWaitsAndHuman([
    step(0, { kind: 'wait', ms: 100, params: {} }),
    step(1, { kind: 'wait', ms: 200, params: {} }),
  ], P.DEFAULT_PLAN_LIMITS);
  assert.equal(merged.waits, 1);
  assert.equal(merged.steps.length, 1);
  assert.equal(merged.steps[0].ms, 300);
  assert.equal(merged.steps[0].merged, 2);
  const humanIndex = result.steps.findIndex((item) => item.kind === 'human');
  const actionIndex = result.steps.findIndex((item) => item.waitsForHuman === true);
  assert.equal(humanIndex >= 0 && actionIndex === humanIndex + 1, true);
  assert.equal(result.steps[humanIndex].humanGate.valueKind, 'text');
});

test('dedupeSafe：只合并同 ref+sourceIndex 的幂等重复，非幂等永不删', () => {
  const duplicated = [step(0, { ref: 'r0', sourceIndex: 0 }), step(0, { ref: 'r0', sourceIndex: 0 })];
  const deduped = P.dedupeSafe(duplicated);
  assert.equal(deduped.steps.length, 1);
  assert.equal(deduped.removed, 1);
  assert.equal(deduped.steps[0].deduped, 2);

  const distinct = [step(0, { ref: 'r0', sourceIndex: 0 }), step(1, { ref: 'r1', sourceIndex: 1 })];
  assert.equal(P.dedupeSafe(distinct).steps.length, 2);

  const sideEffect = [step(0, { ref: 'r0', sourceIndex: 0, idempotent: false }), step(0, { ref: 'r0', sourceIndex: 0, idempotent: false })];
  assert.equal(P.dedupeSafe(sideEffect).steps.length, 2);
  assert.equal(P.dedupeSafe(duplicated, { dedupeIdempotent: false }).steps.length, 2);
});

test('planStepSignature / planFingerprint / planToken：确定且随参数/方法/作用域变化', () => {
  const one = P.normalizePlanStep(step(0), 0);
  const same = P.normalizePlanStep(step(0), 0);
  const other = P.normalizePlanStep(step(1, { method: 'hover' }), 0);
  assert.equal(P.planStepSignature(one), P.planStepSignature(same));
  assert.notEqual(P.planStepSignature(one), P.planStepSignature(other));
  const fingerprint = P.planFingerprint([one]);
  assert.equal(fingerprint, P.planFingerprint([same]));
  assert.equal(P.planToken(fingerprint), P.planToken(fingerprint));
  assert.notEqual(P.planToken(fingerprint, 'a'), P.planToken(fingerprint, 'b'));
  assert.equal(P.planToken(fingerprint).startsWith('rp1-'), true);
});

test('schedulePlan / planBudget：纯相对时间线、预算统计', () => {
  const normalized = [step(0), step(1)].map((item, index) => P.normalizePlanStep(item, index));
  const wait = P.insertWaitsAndHuman([P.normalizePlanStep(step(0, { waitBeforeMs: 500 }), 0)], P.DEFAULT_PLAN_LIMITS).steps;
  const schedule = P.schedulePlan(wait, P.DEFAULT_PLAN_LIMITS);
  assert.equal(schedule.totalDelayMs, 500);
  assert.equal(schedule.capped, false);
  assert.equal(schedule.units.length, wait.length);

  const capped = P.schedulePlan([{ index: 0, kind: 'wait', ms: 10 }], { ...P.DEFAULT_PLAN_LIMITS, maxTotalMs: 5 });
  assert.equal(capped.capped, true);
  assert.equal(capped.totalDelayMs, 5);

  const budget = P.planBudget([...normalized, { index: 9, kind: 'wait', ms: 300 }, { index: 10, kind: 'human' }], P.DEFAULT_PLAN_LIMITS);
  assert.equal(budget.steps, 4);
  assert.equal(budget.actions, 2);
  assert.equal(budget.waits, 1);
  assert.equal(budget.waitMs, 300);
  assert.equal(budget.humans, 1);
  assert.equal(budget.humanGates, 1);
  assert.equal(budget.overBudget, false);
});

test('checkpointsFor：起点/边界/human/间隔/终点，去重且有序', () => {
  const steps = Array.from({ length: 6 }, (_, index) => P.normalizePlanStep(step(index), index));
  steps[2] = { ...steps[2], kind: 'human', index: 2 };
  const boundaries = { epochs: [{ epoch: 0, startIndex: 0, boundary: { documentId: 'doc-1', frameId: 0 } }, { epoch: 1, startIndex: 4, boundary: { documentId: 'doc-2', frameId: 0 } }] };
  const checkpoints = P.checkpointsFor(steps, boundaries, { ...P.DEFAULT_PLAN_LIMITS, checkpointEvery: 3 });
  assert.equal(checkpoints[0].kind, 'start');
  assert.equal(checkpoints.some((checkpoint) => checkpoint.kind === 'boundary' && checkpoint.index === 4), true);
  assert.equal(checkpoints.some((checkpoint) => checkpoint.kind === 'human' && checkpoint.index === 2), true);
  assert.equal(checkpoints.some((checkpoint) => checkpoint.kind === 'interval' && checkpoint.index === 3), true);
  assert.equal(checkpoints[checkpoints.length - 1].kind, 'end');
  for (let index = 1; index < checkpoints.length; index += 1) {
    assert.equal(checkpoints[index].index >= checkpoints[index - 1].index, true);
  }
  assert.equal(new Set(checkpoints.map((checkpoint) => checkpoint.id)).size, checkpoints.length);
});

test('buildReplayPlan：正常计划（阶段/检查点/预算/指纹/token 齐全）', () => {
  const plan = P.buildReplayPlan([step(0), step(1, { waitBeforeMs: 120 }), navigate(2)], baseOptions);
  assert.equal(plan.ok, true);
  assert.equal(plan.version, P.REPLAY_PLAN_VERSION);
  assert.equal(plan.deterministic, true);
  assert.equal(plan.hasWallClock, false);
  assert.equal(plan.steps.length >= 4, true);
  assert.equal(plan.phases.length >= 2, true);
  assert.equal(plan.phases[plan.phases.length - 1].kind, 'verify');
  assert.equal(plan.checkpoints.length >= 2, true);
  assert.equal(plan.budget.steps, plan.steps.length);
  assert.equal(plan.schedule.totalDelayMs, 120);
  assert.equal(typeof plan.token, 'string');
  assert.equal(plan.token.startsWith('rp1-'), true);
  assert.equal(plan.stats.inputNodes, 3);
  assert.equal(P.summarizeReplayPlan(plan).steps, plan.steps.length);
  assert.equal(P.validatePlanShape(plan).ok, true);
});

test('buildReplayPlan：空计划 / 非幂等 / human 缺值 的阻断与放行', () => {
  const empty = P.buildReplayPlan([], {});
  assert.equal(empty.ok, false);
  assert.equal(empty.blockers.some((blocker) => blocker.code === P.PLAN_CODES.EMPTY), true);

  const sideEffect = P.buildReplayPlan([step(0, { idempotent: false })], {});
  assert.equal(sideEffect.ok, false);
  assert.equal(sideEffect.blockers.some((blocker) => blocker.code === 'REPLAY_SIDE_EFFECT'), true);
  const allowed = P.buildReplayPlan([step(0, { idempotent: false })], { allowNonIdempotent: true });
  assert.equal(allowed.ok, true);

  const human = step(1, { humanGate: { reason: '补值', valueKind: 'text' }, params: { selector: '#p' } });
  const humanPlan = P.buildReplayPlan([human], { allowNonIdempotent: true });
  assert.equal(humanPlan.ok, false);
  assert.equal(humanPlan.blockers.some((blocker) => blocker.code === P.PLAN_CODES.HUMAN_VALUE), true);
  const humanWithValue = P.buildReplayPlan([step(1, { humanGate: { reason: '补值', valueKind: 'text' }, params: { selector: '#p', value: 'v' } })], { allowNonIdempotent: true });
  assert.equal(humanWithValue.ok, true);
});

test('buildReplayPlan：token 重复 / 重试预算 / 边界不可还原 / 目标缺快照', () => {
  const base = P.buildReplayPlan([step(0)], baseOptions);
  const duplicate = P.buildReplayPlan([step(0)], { ...baseOptions, knownTokens: [base.token] });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.blockers.some((blocker) => blocker.code === P.PLAN_CODES.DUPLICATE), true);
  const allowedDuplicate = P.buildReplayPlan([step(0)], { ...baseOptions, knownTokens: [base.token], allowDuplicate: true });
  assert.equal(allowedDuplicate.ok, true);

  const retryHeavy = P.buildReplayPlan(
    Array.from({ length: 3 }, (_, index) => step(index, { fallback: { onError: 'retry', retries: 100, retryDelayMs: 10 } })),
    { ...baseOptions, limits: { maxRetries: 5 } },
  );
  assert.equal(retryHeavy.ok, false);
  assert.equal(retryHeavy.blockers.some((blocker) => blocker.code === P.PLAN_CODES.RETRY_BUDGET), true);

  const noUrl = P.buildReplayPlan([step(0), navigate(1, '')], baseOptions);
  assert.equal(noUrl.ok, false);
  assert.equal(noUrl.blockers.some((blocker) => blocker.code === 'BOUNDARY_URL_MISSING'), true);

  const snapshotRequired = P.buildReplayPlan([step(0)], { ...baseOptions, requireSnapshot: true });
  assert.equal(snapshotRequired.ok, false);
  assert.equal(snapshotRequired.blockers.some((blocker) => blocker.code === 'TARGET_NO_SNAPSHOT'), true);
});

test('buildReplayPlan：确定性（两次构建逐字节相同；salt 只影响 token）', () => {
  const input = [step(0), step(1, { waitBeforeMs: 80 }), navigate(2)];
  const first = P.buildReplayPlan(input, baseOptions);
  const second = P.buildReplayPlan(input, baseOptions);
  assert.equal(P.stableStringify(first), P.stableStringify(second));
  assert.equal(first.token, second.token);
  assert.equal(first.fingerprint, second.fingerprint);
  const salted = P.buildReplayPlan(input, { ...baseOptions, salt: 'session-1' });
  assert.equal(salted.fingerprint, first.fingerprint);
  assert.notEqual(salted.token, first.token);
  // 计划对象不共享可变引用：改动一份不影响另一份。
  first.steps[0].method = 'mutated';
  assert.equal(second.steps[0].method, 'click');
});

test('buildReplayPlan：循环/重复展开后不会被去重合并（保留每一次迭代）', () => {
  const repeated = P.buildReplayPlan([step(0, { repeat: 3 })], baseOptions);
  assert.equal(repeated.steps.length, 3);
  assert.deepEqual(repeated.steps.map((item) => item.iteration), [0, 1, 2]);

  const looped = P.buildReplayPlan({ nodes: [step(0)], loops: [{ from: 0, to: 0, count: 3 }] }, baseOptions);
  assert.equal(looped.steps.length, 3);
  assert.deepEqual(looped.steps.map((item) => item.iteration), [0, 1, 2]);
  assert.equal(looped.steps[2].loopOf, 0);
});

test('buildReplayPlan：上限截断与外部 blockers 合并', () => {
  const many = Array.from({ length: 5 }, (_, index) => step(index));
  const truncated = P.buildReplayPlan(many, { ...baseOptions, limits: { maxSteps: 3 } });
  assert.equal(truncated.steps.length <= 3, true);
  assert.equal(truncated.warnings.some((warning) => warning.code === P.PLAN_CODES.TOO_LARGE || warning.code === P.PLAN_CODES.TRUNCATED), true);

  const withExternal = P.buildReplayPlan([step(0)], {
    ...baseOptions,
    blockers: [{ code: 'NETWORK_REPLAY_BAD_URL', message: 'bad url' }],
    validationIssues: [{ severity: 'error', code: 'PLAN_VALIDATION', message: 'bad shape' }, { severity: 'warning', code: 'WARN', message: 'warn' }],
  });
  assert.equal(withExternal.ok, false);
  assert.equal(withExternal.blockers.some((blocker) => blocker.code === 'NETWORK_REPLAY_BAD_URL'), true);
  assert.equal(withExternal.blockers.some((blocker) => blocker.source === 'validation'), true);
  assert.equal(withExternal.warnings.some((warning) => warning.code === 'WARN'), true);
});

test('planFromPreflight：与 preflightReplay 的 token/blockers 对齐', () => {
  const steps = [
    { model: 2, ref: 'a1', kind: 'action', method: 'click', params: { selector: '#go' }, target: { selector: '#go' }, idempotent: false, fallback: { onError: 'stop' }, risk: 'browser_mutation', evidence: { seq: 1, index: 0, frameId: 0, documentId: 'd1', revision: 1, url: 'https://a.test/', actor: 'human', at: 1 } },
  ];
  const preflight = preflightReplay(steps, { allowNonIdempotent: true, requireHumanValues: false });
  assert.equal(preflight.ok, true);
  const plan = P.planFromPreflight(preflight, { allowNonIdempotent: true, requireHumanValues: false });
  assert.equal(plan.source, 'preflight');
  assert.equal(plan.preflight.token, preflight.token);
  assert.equal(plan.token.startsWith('rp1-'), true);
  assert.equal(plan.steps.length, 1);

  const blocked = preflightReplay([], {});
  const blockedPlan = P.planFromPreflight(blocked, {});
  assert.equal(blockedPlan.ok, false);
  assert.equal(P.planFromPreflight(null, {}).ok, false);
});

test('validatePlanShape：能识别顺序/kind/ref 重复/缺 token', () => {
  const plan = P.buildReplayPlan([step(0), step(1)], baseOptions);
  assert.equal(P.validatePlanShape(plan).ok, true);
  const broken = structuredClone(plan);
  broken.steps[1].index = 0;
  broken.steps[0].kind = 'bogus';
  broken.token = '';
  const issues = P.validatePlanShape(broken);
  assert.equal(issues.ok, false);
  assert.equal(issues.issues.some((issue) => issue.code === 'PLAN_STEP_ORDER'), true);
  assert.equal(issues.issues.some((issue) => issue.code === 'PLAN_STEP_KIND'), true);
  assert.equal(issues.issues.some((issue) => issue.code === 'PLAN_SHAPE_TOKEN'), true);
  assert.equal(P.validatePlanShape(null).ok, false);
});

test('计划派生视图：diffPlans / simplifyPlan / resumePlan / 模板与摘要', () => {
  const left = P.buildReplayPlan([step(0), step(1), step(2)], baseOptions);
  const right = P.buildReplayPlan([step(0), step(2)], baseOptions);
  const diff = VIEW.diffPlans(left, right);
  assert.equal(diff.ok, false);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.summary.left, left.steps.length);
  assert.equal(VIEW.diffPlans(left, left).same, true);

  const simplified = VIEW.simplifyPlan(P.buildReplayPlan([step(0, { waitBeforeMs: 100 }), step(1, { waitBeforeMs: 200 }), step(2, { kind: 'observe', method: 'observe', target: null, params: {} })], baseOptions));
  assert.equal(simplified.steps.some((item) => item.kind === 'observe'), false);
  assert.equal(simplified.token.startsWith('rp1-'), true);
  assert.equal(typeof simplified.removed.waits, 'boolean');

  const resume = VIEW.resumePlan(left, 'cp-1');
  assert.equal(resume.ok, true);
  assert.equal(resume.fromIndex >= 0, true);
  assert.equal(VIEW.resumePlan(left, 'nope').ok, false);
  assert.equal(VIEW.resumePlan(null, null).ok, false);

  const template = VIEW.planOutcomeTemplate(left);
  assert.equal(template.length, left.steps.length);
  assert.equal(template[0].status, 'pending');
  assert.equal(VIEW.findPlanStep(left, left.steps[0].ref).index, left.steps[0].index);
  assert.equal(VIEW.findPlanStep(left, 'missing'), null);
  assert.match(VIEW.describeReplayPlan(left), /steps=/);
  assert.equal(VIEW.sameReplayPlan(left, P.buildReplayPlan([step(0), step(1), step(2)], baseOptions)), true);
  assert.equal(VIEW.planHash(left).length, 8);
  assert.equal(VIEW.recordedStepSignature({ kind: 'action', method: 'click' }).includes('action'), true);
});
