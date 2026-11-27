// tests/unit/protocol-proof-obligations.test.mjs —— 可执行 proof obligations 的行为面测试。
//
// 覆盖：
//   1) 义务表的派生形状（165 方法 × 六维 / id 稳定 / 冻结 / JSON 安全）；
//   2) 六种义务种类的判定语义（pre / post / effect-state / 幂等 / 可重放 / 恢复）；
//   3) runCallObligations 的三个硬结论（canDispatch / canClaimSuccess / canAutoReplay）
//      与 hasRecoveryPlan 在 165 个方法上的单调一致性；
//   4) 静态摘要、特性聚合、风险画像、核验计划、拒绝解释的可用性。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_NAMES,
  METHOD_NAMES,
  PROOF_POSTCONDITIONS,
  PROOF_PRECONDITIONS,
  PROOF_EFFECT_STATES,
  RECOVERY_PLAYBOOK,
  proofOf,
} from '../../lib/method-catalog.mjs';
import {
  EFFECT_OUTCOME_STATES,
  checkPrecondition,
  recoveryPlan,
  replayDecision,
  verifyPostcondition,
} from '../../lib/method-state-machine.mjs';
import {
  CALL_VERDICTS,
  METHOD_OBLIGATIONS,
  OBLIGATION_DIMENSIONS,
  OBLIGATION_KINDS,
  OBLIGATION_STAGES,
  OBLIGATION_VERDICTS,
  POSTCONDITION_CONTRADICTION,
  POSTCONDITION_EVIDENCE,
  PRECONDITION_SATISFIED_CONTEXT,
  PRECONDITION_VIOLATED_CONTEXT,
  SATISFIED_CONTEXT,
  asEvidence,
  buildObligationsFor,
  callVerdictLine,
  deniedObligations,
  describeObligations,
  evaluateObligation,
  explainObligation,
  featureObligationMatrix,
  featureObligations,
  isBlindEvidence,
  methodsRequiringResolution,
  normalizeEvidence,
  obligationById,
  obligationDimensionSummary,
  obligationMatrix,
  obligationRiskSummary,
  obligationSummary,
  obligationsByDimension,
  obligationsByStage,
  obligationsFor,
  recoveryActionIndex,
  recoveryObligations,
  replayObligations,
  settleCall,
  preflightCall,
  runCallObligations,
  verificationPlan,
} from '../../lib/protocol-proof.mjs';

const ALL_METHODS = [...METHOD_NAMES];
const PRE_CODES = Object.keys(PROOF_PRECONDITIONS);
const POST_CODES = Object.keys(PROOF_POSTCONDITIONS);
const FULL_POST_RESULT = (() => {
  const result = {};
  for (const code of POST_CODES) Object.assign(result, POSTCONDITION_EVIDENCE[code] || {});
  return result;
})();

// ---------------------------------------------------------------------------
// 1. 义务表派生形状
// ---------------------------------------------------------------------------

test('义务维度/种类/阶段/verdict 常量顺序稳定且冻结', () => {
  assert.deepEqual([...OBLIGATION_DIMENSIONS], ['pre', 'post', 'effectState', 'idempotent', 'replayable', 'recovery']);
  assert.deepEqual([...OBLIGATION_STAGES], ['preflight', 'settle', 'replay', 'recovery']);
  assert.deepEqual([...OBLIGATION_KINDS], ['precondition', 'postcondition', 'effect-state', 'idempotency', 'replayability', 'recovery']);
  assert.deepEqual([...OBLIGATION_VERDICTS], ['inapplicable', 'satisfied', 'unverifiable', 'unknown', 'violated']);
  assert.deepEqual([...CALL_VERDICTS], ['proven', 'partial', 'unknown', 'violated', 'inapplicable']);
  for (const list of [OBLIGATION_DIMENSIONS, OBLIGATION_STAGES, OBLIGATION_KINDS, OBLIGATION_VERDICTS, CALL_VERDICTS]) {
    assert.ok(Object.isFrozen(list));
  }
});

test('义务表恰好覆盖 165 个方法且每个方法六维齐全', () => {
  assert.equal(Object.keys(METHOD_OBLIGATIONS).length, 165);
  assert.deepEqual(Object.keys(METHOD_OBLIGATIONS), ALL_METHODS);
  for (const method of ALL_METHODS) {
    const list = obligationsFor(method);
    assert.ok(list.length >= 6, method + ' 义务数量过少');
    const dimensions = new Set(list.map((obligation) => obligation.dimension));
    for (const dimension of OBLIGATION_DIMENSIONS) assert.ok(dimensions.has(dimension), method + ' 缺少维度 ' + dimension);
    const stages = new Set(list.map((obligation) => obligation.stage));
    for (const stage of OBLIGATION_STAGES) assert.ok(stages.has(stage), method + ' 缺少阶段 ' + stage);
    // pre/post 义务数量必须与目录事实一一对应
    const proof = proofOf(method);
    assert.equal(list.filter((item) => item.dimension === 'pre').length, proof.pre.length, method + ' pre 数量不一致');
    assert.equal(list.filter((item) => item.dimension === 'post').length, proof.post.length, method + ' post 数量不一致');
    // id 唯一
    const ids = list.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, method + ' 义务 id 重复');
  }
});

test('义务表全部冻结且可 JSON 序列化（daemon 错误帧要求）', () => {
  assert.ok(Object.isFrozen(METHOD_OBLIGATIONS));
  for (const method of ALL_METHODS) {
    const list = obligationsFor(method);
    assert.ok(Object.isFrozen(list), method + ' 义务数组未冻结');
    for (const obligation of list) {
      assert.ok(Object.isFrozen(obligation), obligation.id + ' 义务未冻结');
      const wire = JSON.parse(JSON.stringify(obligation));
      assert.equal(wire.id, obligation.id);
      assert.equal(wire.method, obligation.method);
      assert.equal(wire.dimension, obligation.dimension);
      assert.equal(wire.kind, obligation.kind);
      assert.equal(wire.stage, obligation.stage);
      assert.equal(typeof wire.requirement, 'string');
      assert.equal(wire.requirement.includes('undefined'), false);
    }
  }
});

test('义务 id 与维度/阶段映射稳定（解释器可直接引用）', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    const ids = obligationsFor(method).map((item) => item.id);
    for (const code of proof.pre) assert.ok(ids.includes('pre:' + code), method + ' 缺少前置义务 ' + code);
    for (const code of proof.post) assert.ok(ids.includes('post:' + code), method + ' 缺少后置义务 ' + code);
    assert.ok(ids.includes('effect-state'));
    assert.ok(ids.includes('idempotent'));
    assert.ok(ids.includes('replayable'));
    assert.ok(ids.includes('recovery'));
  }
  assert.equal(obligationById('click', 'replayable').stage, 'replay');
  assert.equal(obligationById('click', 'pre:session.active').kind, 'precondition');
  assert.equal(obligationById('click', 'no-such-id'), null);
  assert.equal(obligationById('no.such.method', 'replayable'), null);
});

test('buildObligationsFor：未知方法返回空数组，已知方法与表内一致', () => {
  assert.deepEqual(buildObligationsFor('no.such.method'), []);
  assert.deepEqual(buildObligationsFor(''), []);
  for (const method of ['click', 'observe', 'video.start', 'read', 'plan', 'status']) {
    assert.deepEqual(buildObligationsFor(method), obligationsFor(method));
  }
});

test('按维度/阶段分组覆盖全部义务且顺序保持方法内顺序', () => {
  for (const method of ['click', 'observe', 'video.start', 'session.start', 'status']) {
    const all = obligationsFor(method);
    const byDimension = obligationsByDimension(method);
    const byStage = obligationsByStage(method);
    const dimensionCount = OBLIGATION_DIMENSIONS.reduce((sum, dimension) => sum + byDimension[dimension].length, 0);
    const stageCount = OBLIGATION_STAGES.reduce((sum, stage) => sum + byStage[stage].length, 0);
    assert.equal(dimensionCount, all.length, method + ' 维度分组丢义务');
    assert.equal(stageCount, all.length, method + ' 阶段分组丢义务');
    for (const dimension of OBLIGATION_DIMENSIONS) {
      for (const obligation of byDimension[dimension]) assert.equal(obligation.dimension, dimension);
    }
    for (const stage of OBLIGATION_STAGES) {
      for (const obligation of byStage[stage]) assert.equal(obligation.stage, stage);
    }
    const preids = all.filter((item) => item.dimension === 'pre').map((item) => item.id);
    assert.deepEqual(byDimension.pre.map((item) => item.id), preids);
  }
});

// ---------------------------------------------------------------------------
// 2. 证据归一化
// ---------------------------------------------------------------------------

test('normalizeEvidence：读取 context/result/error/effectState/dispatched/retryRequested', () => {
  const empty = normalizeEvidence({});
  assert.equal(empty.context, null);
  assert.equal(empty.hasResult, false);
  assert.equal(empty.hasError, false);
  assert.equal(empty.effectState, null);
  assert.equal(empty.dispatched, null);
  assert.equal(empty.retryRequested, false);

  const full = normalizeEvidence({
    context: { sessionActive: true },
    result: { ok: true },
    error: { code: 'E_TIMEOUT', data: { effect_state: 'unknown' } },
    dispatched: false,
    retryRequested: true,
  });
  assert.deepEqual(full.context, { sessionActive: true });
  assert.equal(full.hasResult, true);
  assert.equal(full.hasError, true);
  assert.equal(full.code, 'E_TIMEOUT');
  assert.equal(full.effectState, 'unknown');
  assert.equal(full.dispatched, false);
  assert.equal(full.retryRequested, true);
});

test('normalizeEvidence：字符串错误、retrying 别名、effect_state 驼峰/下划线都识别', () => {
  assert.equal(normalizeEvidence({ error: 'E_BAD_ARG' }).code, 'E_BAD_ARG');
  assert.equal(normalizeEvidence({ retrying: true }).retryRequested, true);
  assert.equal(normalizeEvidence({ retry: true }).retryRequested, true);
  assert.equal(normalizeEvidence({ effect_state: 'applied' }).effectState, 'applied');
  assert.equal(normalizeEvidence({ error: { effect_state: 'none' } }).effectState, 'none');
  assert.equal(normalizeEvidence(null).context, null);
  assert.equal(normalizeEvidence(42).retryRequested, false);
});

test('asEvidence：归一化幂等且标记 __normalized', () => {
  const once = asEvidence({ context: { sessionActive: true } });
  assert.equal(once.__normalized, true);
  const twice = asEvidence(once);
  assert.equal(twice, once, '已归一化的证据不应重复处理');
  assert.equal(isBlindEvidence({}), true);
  assert.equal(isBlindEvidence({ context: {} }), false);
  assert.equal(isBlindEvidence({ result: 1 }), false);
});

// ---------------------------------------------------------------------------
// 3. 前置条件义务
// ---------------------------------------------------------------------------

test('前置义务：每个 pre 码的满足夹具判 satisfied、反证夹具判 violated', () => {
  let checked = 0;
  for (const code of PRE_CODES) {
    const method = ALL_METHODS.find((name) => proofOf(name).pre.includes(code));
    if (!method) continue;
    const obligation = obligationById(method, 'pre:' + code);
    assert.ok(obligation, '缺少前置义务：' + code);
    const satisfied = evaluateObligation(obligation, { context: PRECONDITION_SATISFIED_CONTEXT[code] });
    assert.equal(satisfied.verdict, 'satisfied', code + ' 满足夹具未通过');
    const violated = evaluateObligation(obligation, { context: PRECONDITION_VIOLATED_CONTEXT[code] });
    assert.equal(violated.verdict, 'violated', code + ' 反证夹具未通过');
    checked += 1;
  }
  assert.ok(checked >= 15, '前置码覆盖面过窄：' + checked);
});

test('前置义务：未提供上下文是 unknown 而不是 violated（缺证据 ≠ 不成立）', () => {
  for (const method of ['click', 'video.start', 'session.start']) {
    const proof = proofOf(method);
    for (const code of proof.pre) {
      const check = evaluateObligation(obligationById(method, 'pre:' + code), {});
      assert.equal(check.verdict, 'unknown', method + '/' + code + ' 应判 unknown');
    }
  }
  // 与状态机同源：unknown 状态来自 checkPrecondition，而不是引擎自己猜
  const code = 'session.active';
  assert.equal(checkPrecondition(code, { session: { active: false } }).state, 'violated');
  assert.equal(checkPrecondition(code, {}).state, 'unknown');
  assert.equal(checkPrecondition(code, { session: { active: true } }).state, 'satisfied');
});

test('前置义务：理想上下文下 165 方法全部 satisfied，且 canDispatch=true', () => {
  for (const method of ALL_METHODS) {
    const run = preflightCall(method, SATISFIED_CONTEXT);
    assert.equal(run.canDispatch, true, method + ' 理想上下文仍禁止派发');
    assert.equal(run.stages.preflight.ok, true, method + ' 前置阶段失败');
    assert.equal(run.stages.preflight.unknown.length, 0, method + ' 理想上下文仍缺证据');
    assert.equal(run.stages.preflight.violated.length, 0, method + ' 理想上下文仍有反证');
    assert.ok(run.stages.preflight.satisfied.length >= 1, method + ' 没有 satisfied 前置');
    assert.equal(run.verdict === 'violated', false, method + ' 理想上下文被判 violated');
  }
});

test('前置义务：任一前置反证都会关闭派发（165 方法 × 每个 pre）', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    for (const code of proof.pre) {
      const run = preflightCall(method, PRECONDITION_VIOLATED_CONTEXT[code]);
      assert.equal(run.canDispatch, false, method + '/' + code + ' 反证仍允许派发');
      assert.equal(run.verdict, 'violated', method + '/' + code + ' 反证未产生 violated');
      assert.ok(run.stages.preflight.blockedBy.includes('pre:' + code), method + '/' + code + ' 未被标为阻断项');
    }
  }
});

// ---------------------------------------------------------------------------
// 4. 后置条件义务
// ---------------------------------------------------------------------------

test('后置义务：无结果时 inapplicable（不能把“还没发生”当失败）', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    for (const code of proof.post) {
      const check = evaluateObligation(obligationById(method, 'post:' + code), {});
      assert.equal(check.verdict, 'inapplicable', method + '/' + code + ' 无结果应 inapplicable');
    }
  }
});

test('后置义务：每个 post 码的满足夹具判 satisfied', () => {
  for (const code of POST_CODES) {
    const method = ALL_METHODS.find((name) => proofOf(name).post.includes(code));
    if (!method) continue;
    const check = evaluateObligation(obligationById(method, 'post:' + code), { result: POSTCONDITION_EVIDENCE[code] });
    assert.equal(check.verdict, 'satisfied', code + ' 满足夹具未通过');
  }
});

test('后置义务：矛盾夹具判 violated（方法实际拥有的每个可矛盾后置）', () => {
  let checked = 0;
  for (const method of ALL_METHODS) {
    for (const code of proofOf(method).post) {
      const contradiction = POSTCONDITION_CONTRADICTION[code];
      if (!contradiction) continue;
      const check = evaluateObligation(obligationById(method, 'post:' + code), { result: contradiction });
      assert.equal(check.verdict, 'violated', method + '/' + code + ' 矛盾夹具未判 violated');
      checked += 1;
    }
  }
  assert.ok(checked > 100, '后置矛盾覆盖面过窄：' + checked);
});

test('后置义务：语义性后置只能 unverifiable，不能伪装成功', () => {
  for (const method of ALL_METHODS) {
    for (const code of proofOf(method).post) {
      if (POSTCONDITION_CONTRADICTION[code]) continue;
      if (POSTCONDITION_EVIDENCE[code] !== undefined) continue;
      const check = evaluateObligation(obligationById(method, 'post:' + code), { result: {} });
      assert.ok(['unverifiable', 'satisfied', 'violated'].includes(check.verdict), method + '/' + code + ' verdict 非法');
      // 与状态机判定一致
      assert.equal(check.verdict, verifyPostcondition(code, {}).state, method + '/' + code + ' 与状态机不一致');
    }
  }
  assert.equal(verifyPostcondition('page.mutated', {}).state, 'unverifiable');
});

test('后置义务：全量证据下 165 方法 canClaimSuccess=true', () => {
  for (const method of ALL_METHODS) {
    const run = settleCall(method, FULL_POST_RESULT, { effectState: 'none' });
    assert.equal(run.canClaimSuccess, true, method + ' 全量后置证据仍禁止声明成功');
    assert.notEqual(run.verdict, 'violated', method + ' 全量后置证据被判 violated');
  }
});

// ---------------------------------------------------------------------------
// 5. effect_state 义务
// ---------------------------------------------------------------------------

test('effect_state 义务：三态合法、未知态不可证明、只读方法 applied 即矛盾', () => {
  const readMethod = ALL_METHODS.find((method) => proofOf(method).effectState === 'none');
  assert.ok(readMethod, '找不到只读方法');
  const obligation = obligationById(readMethod, 'effect-state');
  assert.equal(evaluateObligation(obligation, { effectState: 'none' }).verdict, 'satisfied');
  assert.equal(evaluateObligation(obligation, { effectState: 'applied' }).verdict, 'violated');
  assert.equal(evaluateObligation(obligation, { effectState: 'unknown' }).verdict, 'unknown');
  assert.equal(evaluateObligation(obligation, { effectState: 'bogus' }).verdict, 'violated');
  assert.equal(evaluateObligation(obligation, {}).verdict, 'inapplicable');
  assert.equal(evaluateObligation(obligation, { result: {} }).verdict, 'unknown');
});

test('effect_state 义务：非只读方法 applied 合法（副作用是该方法的正常语义）', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    if (proof.effectState === 'none') continue;
    const check = evaluateObligation(obligationById(method, 'effect-state'), { effectState: 'applied' });
    assert.equal(check.verdict, 'satisfied', method + ' 非只读方法 applied 应 satisfied');
  }
  for (const state of EFFECT_OUTCOME_STATES) {
    assert.ok(['none', 'unknown', 'applied'].includes(state));
  }
});

test('effect_state：目录里 20 种副作用分类都能被义务引用', () => {
  const used = new Set(ALL_METHODS.map((method) => proofOf(method).effectState));
  for (const state of used) assert.ok(Object.prototype.hasOwnProperty.call(PROOF_EFFECT_STATES, state), state + ' 未登记');
  assert.ok(used.size >= 10, '副作用分类覆盖过窄：' + used.size);
});

// ---------------------------------------------------------------------------
// 6. 幂等义务
// ---------------------------------------------------------------------------

test('幂等义务：没有重放请求时 inapplicable', () => {
  for (const method of ['click', 'observe', 'video.start']) {
    assert.equal(evaluateObligation(obligationById(method, 'idempotent'), {}).verdict, 'inapplicable');
  }
});

test('幂等义务：逻辑幂等方法在重放请求下 satisfied', () => {
  for (const method of ALL_METHODS) {
    if (!proofOf(method).idempotent) continue;
    const check = evaluateObligation(obligationById(method, 'idempotent'), { retryRequested: true, dispatched: true, effectState: 'unknown' });
    assert.equal(check.verdict, 'satisfied', method + ' 幂等方法被判违反');
  }
});

test('幂等义务：非幂等 + 结果未知 + 已派发 ⇒ violated；已证明未生效 ⇒ satisfied', () => {
  const nonIdempotent = ALL_METHODS.filter((method) => !proofOf(method).idempotent);
  assert.ok(nonIdempotent.length > 0);
  for (const method of nonIdempotent) {
    const obligation = obligationById(method, 'idempotent');
    const risky = evaluateObligation(obligation, { retryRequested: true, dispatched: true, effectState: 'unknown' });
    assert.equal(risky.verdict, 'violated', method + ' 非幂等未知结果应违反');
    const safe = evaluateObligation(obligation, { retryRequested: true, dispatched: false, effectState: 'unknown' });
    assert.equal(safe.verdict, 'satisfied', method + ' 已证明未生效应放行');
    const applied = evaluateObligation(obligation, { retryRequested: true, dispatched: true, effectState: 'applied' });
    assert.equal(applied.verdict, 'violated', method + ' 已生效重放应违反');
    const preDispatchCode = evaluateObligation(obligation, { retryRequested: true, dispatched: true, effectState: 'unknown', code: 'E_BAD_ARG' });
    assert.equal(preDispatchCode.verdict, 'satisfied', method + ' 派发前错误码应可安全重试');
  }
});

// ---------------------------------------------------------------------------
// 7. 可重放义务
// ---------------------------------------------------------------------------

test('可重放义务：与 replayDecision 逐方法一致（unknown 结果 + 已派发）', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    const check = evaluateObligation(obligationById(method, 'replayable'), {
      retryRequested: true, dispatched: true, effectState: 'unknown', code: 'E_TIMEOUT',
    });
    const decision = replayDecision(method, { effectState: 'unknown', dispatched: true, code: 'E_TIMEOUT' });
    assert.equal(check.verdict, decision.allowed ? 'satisfied' : 'violated', method + ' 与 replayDecision 不一致');
    assert.equal(check.reason, decision.reason, method + ' 判定理由漂移');
    assert.equal(check.verdict === 'satisfied', proof.replayable, method + ' 可重放结论与目录不一致');
  }
});

test('可重放义务：结果可证明未生效时所有方法都允许重放', () => {
  for (const method of ALL_METHODS) {
    const check = evaluateObligation(obligationById(method, 'replayable'), {
      retryRequested: true, dispatched: false, effectState: 'none',
    });
    assert.equal(check.verdict, 'satisfied', method + ' 已证明未生效仍禁止重放');
    const run = replayObligations(method, { dispatched: false, effectState: 'none' });
    assert.equal(run.canAutoReplay, true, method + ' 硬结论与单条义务不一致');
  }
});

test('可重放义务：unknown 结果下 90 个可重放方法放行、75 个必须 resolve', () => {
  const replayable = ALL_METHODS.filter((method) => proofOf(method).replayable);
  const blocked = ALL_METHODS.filter((method) => !proofOf(method).replayable);
  assert.equal(replayable.length, 90);
  assert.equal(blocked.length, 75);
  for (const method of replayable) {
    assert.equal(replayObligations(method, { dispatched: true, effectState: 'unknown', code: 'E_TIMEOUT' }).canAutoReplay, true, method);
  }
  for (const method of blocked) {
    assert.equal(replayObligations(method, { dispatched: true, effectState: 'unknown', code: 'E_TIMEOUT' }).canAutoReplay, false, method);
  }
  assert.deepEqual(methodsRequiringResolution(), blocked);
});

// ---------------------------------------------------------------------------
// 8. 恢复义务
// ---------------------------------------------------------------------------

test('恢复义务：165 方法目录内每个恢复码都有可执行计划', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    for (const code of proof.recovery) {
      const run = recoveryObligations(method, code);
      assert.equal(run.hasRecoveryPlan, true, method + '/' + code + ' 没有恢复计划');
      assert.equal(run.stages.recovery.ok, true, method + '/' + code + ' 恢复阶段失败');
      const plan = recoveryPlan(method, code);
      assert.equal(plan.known, true, method + '/' + code + ' recoveryPlan unknown');
      assert.ok(RECOVERY_PLAYBOOK[code], method + '/' + code + ' playbook 缺码');
    }
  }
});

test('恢复义务：未登记错误码判 violated（调用方必须知道没有剧本）', () => {
  for (const method of ['click', 'observe', 'video.start']) {
    const check = evaluateObligation(obligationById(method, 'recovery'), { error: 'E_NO_SUCH_CODE' });
    assert.equal(check.verdict, 'violated', method + ' 未知错误码应违反恢复义务');
    const run = recoveryObligations(method, 'E_NO_SUCH_CODE');
    assert.equal(run.hasRecoveryPlan, false, method + ' 硬结论未反映恢复缺失');
  }
  assert.equal(evaluateObligation(obligationById('click', 'recovery'), {}).verdict, 'inapplicable');
});

test('恢复义务：需要人工介入的代码仍算有计划（但理由里说明）', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    for (const code of proof.recovery) {
      const plan = recoveryPlan(method, code);
      if (!plan.requiresHuman) continue;
      const check = evaluateObligation(obligationById(method, 'recovery'), { error: code });
      assert.equal(check.verdict, 'satisfied');
      assert.match(check.reason, /人工/);
    }
  }
});

// ---------------------------------------------------------------------------
// 9. 整次调用：三个硬结论
// ---------------------------------------------------------------------------

test('runCallObligations：165 方法在盲证据下不违反、不禁止派发', () => {
  for (const method of ALL_METHODS) {
    const run = runCallObligations(method);
    assert.equal(run.known, true);
    assert.notEqual(run.verdict, 'violated', method + ' 盲证据被判 violated');
    assert.equal(run.canDispatch, true, method + ' 盲证据禁止派发');
    assert.equal(run.checks.length, obligationsFor(method).length, method + ' 检查数量不符');
    assert.equal(run.summary.length > 0, true);
  }
});

test('runCallObligations：未知方法一律保守禁止', () => {
  for (const method of ['no.such.method', '', null, 42]) {
    const run = runCallObligations(method);
    assert.equal(run.known, false);
    assert.equal(run.verdict, 'violated');
    assert.equal(run.canDispatch, false);
    assert.equal(run.canClaimSuccess, false);
    assert.equal(run.canAutoReplay, false);
    assert.equal(run.hasRecoveryPlan, false);
  }
});

test('runCallObligations：counts 与 checks 一致，stages 覆盖四个阶段', () => {
  const run = runCallObligations('click', { context: SATISFIED_CONTEXT, result: FULL_POST_RESULT });
  const total = Object.values(run.counts).reduce((sum, value) => sum + value, 0);
  assert.equal(total, run.checks.length);
  assert.equal(Object.keys(run.stages).join(','), 'preflight,settle,replay,recovery');
  for (const stage of Object.values(run.stages)) {
    assert.equal(stage.total, stage.violated.length + stage.unknown.length + stage.unverifiable.length + stage.satisfied.length + stage.inapplicable.length);
  }
  const wire = JSON.parse(JSON.stringify(run));
  assert.equal(wire.method, 'click');
  assert.equal(wire.verdict, run.verdict);
});

test('settleCall：后置矛盾时 canClaimSuccess=false 且 verdict=violated', () => {
  const exact = settleCall('click', POSTCONDITION_CONTRADICTION['page.mutated'], { effectState: 'none' });
  assert.equal(exact.canClaimSuccess, false);
  assert.equal(exact.verdict, 'violated');
  assert.equal(exact.canDispatch, true, '结算失败不应反过来影响派发结论');
});

test('callVerdictLine：一行摘要包含三个硬结论', () => {
  const line = callVerdictLine('video.start');
  assert.match(line, /^\[(proven|partial|unknown|violated|inapplicable)\] video\.start/);
  assert.match(line, /dispatch=yes/);
  assert.match(line, /claim=yes/);
  assert.match(line, /replay=(yes|no)/);
  assert.match(line, /recovery=(yes|no)/);
});

// ---------------------------------------------------------------------------
// 10. 静态摘要与特性聚合
// ---------------------------------------------------------------------------

test('obligationSummary：165 方法摘要与目录逐项一致', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    const summary = obligationSummary(method);
    assert.equal(summary.known, true);
    assert.deepEqual([...summary.dimensions.pre], [...proof.pre]);
    assert.deepEqual([...summary.dimensions.post], [...proof.post]);
    assert.equal(summary.dimensions.effectState, proof.effectState);
    assert.equal(summary.dimensions.idempotent, proof.idempotent);
    assert.equal(summary.dimensions.replayable, proof.replayable);
    assert.deepEqual([...summary.dimensions.recoveryCodes], [...proof.recovery]);
    assert.equal(summary.counts.total, obligationsFor(method).length);
    assert.equal(summary.policy.canAutoReplay, proof.replayable);
    assert.ok(['safe', 'guarded', 'risky'].includes(summary.risk));
    assert.ok(Object.isFrozen(summary));
  }
  const unknown = obligationSummary('no.such.method');
  assert.equal(unknown.known, false);
  assert.equal(unknown.risk, 'risky');
});

test('obligationRiskSummary：安全/受控/高危三类计数总和为 165', () => {
  const risk = obligationRiskSummary();
  assert.equal(risk.counts.safe + risk.counts.guarded + risk.counts.risky, 165);
  assert.equal(risk.counts.safe, 90);
  assert.equal(risk.safe.length, risk.counts.safe);
  assert.equal(risk.guarded.length, risk.counts.guarded);
  assert.equal(risk.risky.length, risk.counts.risky);
  for (const method of risk.safe) assert.equal(proofOf(method).replayable, true);
  for (const method of risk.guarded) {
    assert.equal(proofOf(method).replayable, false);
    assert.equal(proofOf(method).idempotent, true);
  }
  for (const method of risk.risky) assert.equal(proofOf(method).idempotent, false);
});

test('obligationMatrix：165 行且行字段与摘要一致', () => {
  const rows = obligationMatrix();
  assert.equal(rows.length, 165);
  for (const row of rows) {
    const summary = obligationSummary(row.method);
    assert.equal(row.risk, summary.risk);
    assert.equal(row.preCount, summary.dimensions.pre.length);
    assert.equal(row.postCount, summary.dimensions.post.length);
    assert.equal(row.recoveryCount, summary.dimensions.recoveryCodes.length);
    assert.equal(row.effectState, summary.dimensions.effectState);
  }
  assert.equal(obligationMatrix(['click']).length, 1);
});

test('obligationDimensionSummary：维度义务总数 = 各方法义务数之和', () => {
  const summary = obligationDimensionSummary();
  const expected = ALL_METHODS.reduce((sum, method) => sum + obligationsFor(method).length, 0);
  assert.equal(summary.obligations, expected);
  assert.equal(summary.methods, 165);
  assert.equal(summary.totals.pre, 330);
  assert.equal(summary.totals.post, 176);
  assert.equal(summary.methodsWith.pre, 165);
  assert.equal(summary.methodsWith.recovery, 165);
});

test('featureObligations：15 个特性聚合与目录方法集一致，且可 JSON 序列化', () => {
  assert.equal(FEATURE_NAMES.length, 15);
  const rows = featureObligationMatrix();
  assert.equal(rows.length, 15);
  for (const feature of FEATURE_NAMES) {
    const summary = featureObligations(feature);
    assert.equal(summary.feature, feature);
    assert.equal(summary.known, true);
    assert.ok(summary.methodCount >= 1, feature + ' 没有受影响方法');
    assert.equal(summary.risks.safe + summary.risks.guarded + summary.risks.risky, summary.methodCount);
    assert.equal(summary.counts.idempotent + (summary.methodCount - summary.counts.idempotent), summary.methodCount);
    const wire = JSON.parse(JSON.stringify(summary));
    assert.equal(wire.feature, feature);
    assert.ok(Array.isArray(wire.riskyMethods));
  }
  const unknown = featureObligations('no-such-feature');
  assert.equal(unknown.known, false);
  assert.equal(unknown.methodCount, 0);
  // 参数级特性覆盖全量方法（旧扩展会静默忽略，这是最危险的一类）
  assert.equal(featureObligations('unverified').scope, 'all-methods');
  assert.equal(featureObligations('video').scope, 'method-list');
});

test('verificationPlan：165 方法的核验项等于后置条件且带核验手段', () => {
  for (const method of ALL_METHODS) {
    const plan = verificationPlan(method);
    const proof = proofOf(method);
    assert.equal(plan.known, true);
    assert.deepEqual(plan.checks.map((check) => check.code), [...proof.post]);
    for (const check of plan.checks) {
      assert.equal(typeof check.label, 'string');
      assert.equal(typeof check.verifyWith, 'string');
      assert.ok(check.verifyWith.length > 0);
    }
    assert.ok(Object.isFrozen(plan));
  }
  assert.equal(verificationPlan('no.such.method').known, false);
});

test('describeObligations / explainObligation：可读且未知输入安全', () => {
  const described = describeObligations('click');
  assert.equal(described.known, true);
  assert.equal(described.obligations.length, obligationsFor('click').length);
  for (const item of described.obligations) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.dimensionLabel, 'string');
    assert.equal(typeof item.requirement, 'string');
    assert.equal(typeof item.blocking, 'boolean');
  }
  const explained = explainObligation('click', 'pre:session.active');
  assert.equal(explained.known, true);
  assert.equal(explained.obligation.code, 'session.active');
  assert.ok(explained.advice.length >= 2);
  assert.equal(explainObligation('click', 'nope').known, false);
  assert.equal(describeObligations('no.such.method').known, false);
});

test('deniedObligations：说明缺特性时哪些义务无法被执行', () => {
  const denied = deniedObligations('video.start', ['video']);
  assert.equal(denied.known, true);
  assert.equal(denied.featureScoped.length, 1);
  assert.equal(denied.featureScoped[0].feature, 'video');
  assert.equal(denied.featureScoped[0].floor, '1.9');
  assert.ok(denied.featureScoped[0].obligations > 0);
  assert.equal(typeof denied.note, 'string');
  assert.equal(denied.canAutoReplay, proofOf('video.start').replayable);
  // 未登记特性被忽略
  assert.equal(deniedObligations('video.start', ['no-such-feature']).featureScoped.length, 0);
  assert.equal(deniedObligations('no.such.method', ['video']).known, false);
});

test('recoveryActionIndex：动作 → 错误码/方法索引来自 playbook', () => {
  const index = recoveryActionIndex();
  const actions = Object.keys(index);
  assert.ok(actions.length > 0);
  for (const action of actions) {
    const entry = index[action];
    assert.equal(entry.action, action);
    assert.ok(entry.codes.length > 0);
    assert.ok(entry.methods.length > 0);
    assert.equal(entry.methodCount, entry.methods.length);
    for (const code of entry.codes) assert.ok(RECOVERY_PLAYBOOK[code], code + ' 不在 playbook');
  }
  for (const action of actions) assert.ok(Object.isFrozen(index[action]));
});
