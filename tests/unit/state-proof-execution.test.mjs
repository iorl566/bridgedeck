// tests/unit/state-proof-execution.test.mjs —— 状态机 × 可执行义务的交叉一致性测试。
//
// 第一轮的状态机（lib/method-state-machine.mjs）已经有 simulateCall / replayDecision /
// recoveryPlan / proofObligations 这些“判定函数”；第二轮把同样的六个维度编成了可执行
// 义务（lib/protocol-proof.mjs）。两份实现必须永远说同一句话，否则协议面就会出现
// “模拟器说不能重放、义务执行器说能重放”这种互相矛盾的建议。
//
// 本文件对 165 个方法逐项交叉验证：
//   - simulateCall 的 outcome 与 runCallObligations 的三个硬结论；
//   - replayDecision 与可重放义务（5 种证据组合）；
//   - recoveryPlan 与恢复义务（每个登记恢复码 + 未知码）；
//   - effectStateSummary / recoveryCoverage / proofMatrix 与义务摘要的计数。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METHOD_CATALOG,
  METHOD_NAMES,
  PROOF_POSTCONDITIONS,
  proofOf,
} from '../../lib/method-catalog.mjs';
import {
  effectStateSummary,
  proofMatrix,
  proofObligations,
  replayDecision,
  recoveryCoverage,
  recoveryPlan,
  simulateBatch,
  simulateCall,
} from '../../lib/method-state-machine.mjs';
import {
  METHOD_OBLIGATIONS,
  POSTCONDITION_CONTRADICTION,
  POSTCONDITION_EVIDENCE,
  PRECONDITION_VIOLATED_CONTEXT,
  SATISFIED_CONTEXT,
  obligationSummary,
  preflightCall,
  recoveryObligations,
  replayObligations,
  runCallObligations,
  settleCall,
} from '../../lib/protocol-proof.mjs';

const ALL_METHODS = [...METHOD_NAMES];

function fullResultFor(method) {
  const result = {};
  for (const code of proofOf(method).post) Object.assign(result, POSTCONDITION_EVIDENCE[code] || {});
  return result;
}

// ---------------------------------------------------------------------------
// 1. simulateCall × runCallObligations
// ---------------------------------------------------------------------------

test('理想上下文 + 全量证据：simulateCall 成功，义务结论不阻断', () => {
  for (const method of ALL_METHODS) {
    const result = fullResultFor(method);
    const simulated = simulateCall(method, { context: SATISFIED_CONTEXT, result });
    assert.equal(simulated.known, true, method);
    assert.equal(
      ['succeeded-verified', 'succeeded-unverified'].includes(simulated.outcome),
      true,
      method + ' 理想结果却得到 ' + simulated.outcome,
    );
    const run = runCallObligations(method, { context: SATISFIED_CONTEXT, result, effectState: 'none' });
    assert.equal(run.canDispatch, true, method + ' 理想路径禁止派发');
    assert.equal(run.canClaimSuccess, true, method + ' 理想路径禁止声明成功');
    assert.notEqual(run.verdict, 'violated', method + ' 理想路径被判 violated');
  }
});

test('前置反证：simulateCall blocked-precondition 与义务 canDispatch=false 一致', () => {
  for (const method of ALL_METHODS) {
    const code = proofOf(method).pre[0];
    const simulated = simulateCall(method, { context: PRECONDITION_VIOLATED_CONTEXT[code] });
    assert.equal(simulated.outcome, 'blocked-precondition', method + ' 前置反证未短路');
    assert.deepEqual([...simulated.pre.violations], [code], method + ' 违反的前置码不一致');
    const run = preflightCall(method, PRECONDITION_VIOLATED_CONTEXT[code]);
    assert.equal(run.canDispatch, false, method + ' 义务层仍允许派发');
    assert.equal(run.verdict, 'violated');
  }
});

test('后置矛盾：simulateCall succeeded-contradiction 与义务 canClaimSuccess=false 一致', () => {
  let checked = 0;
  for (const method of ALL_METHODS) {
    for (const code of proofOf(method).post) {
      const contradiction = POSTCONDITION_CONTRADICTION[code];
      if (!contradiction) continue;
      const simulated = simulateCall(method, { context: SATISFIED_CONTEXT, result: contradiction });
      assert.equal(simulated.outcome, 'succeeded-contradiction', method + '/' + code + ' 未判矛盾');
      const run = settleCall(method, contradiction, { effectState: 'none' });
      assert.equal(run.canClaimSuccess, false, method + '/' + code + ' 义务层仍允许声明成功');
      assert.equal(run.verdict, 'violated');
      checked += 1;
    }
  }
  assert.ok(checked > 100, '后置矛盾覆盖面过窄：' + checked);
});

test('只有上下文：simulateCall dispatched-pending，义务层不阻断也不证明', () => {
  for (const method of ALL_METHODS) {
    const simulated = simulateCall(method, { context: SATISFIED_CONTEXT });
    assert.equal(simulated.outcome, 'dispatched-pending', method);
    const run = runCallObligations(method, { context: SATISFIED_CONTEXT });
    assert.equal(run.canDispatch, true);
    assert.equal(run.canClaimSuccess, true, '没有结果时不应禁止声明成功（还没结算）');
    assert.equal(run.canAutoReplay, true, '没有重放请求时不应禁止重放（还没问）');
  }
});

test('未知方法：simulateCall 与义务执行器都保守', () => {
  for (const method of ['no.such.method', '']) {
    const simulated = simulateCall(method, { context: SATISFIED_CONTEXT });
    assert.equal(simulated.known, false);
    assert.equal(simulated.outcome, 'blocked-precondition');
    const run = runCallObligations(method, {});
    assert.equal(run.known, false);
    assert.equal(run.canDispatch, false);
    assert.equal(run.canClaimSuccess, false);
  }
});

// ---------------------------------------------------------------------------
// 2. replayDecision × 可重放义务
// ---------------------------------------------------------------------------

const REPLAY_CASES = [
  { label: '派发前错误码', options: { dispatched: true, effectState: 'unknown', code: 'E_BAD_ARG' } },
  { label: '已证明未生效', options: { dispatched: false, effectState: 'none' } },
  { label: '已生效', options: { dispatched: true, effectState: 'applied' } },
  { label: '结果未知', options: { dispatched: true, effectState: 'unknown', code: 'E_TIMEOUT' } },
  { label: '结果未知且有 resolve', options: { dispatched: true, effectState: 'unknown', code: 'E_RESOLVE' } },
];

test('replayDecision.allowed 与 replayObligations.canAutoReplay 逐方法逐场景一致', () => {
  for (const method of ALL_METHODS) {
    for (const item of REPLAY_CASES) {
      const decision = replayDecision(method, item.options);
      const run = replayObligations(method, item.options);
      assert.equal(run.canAutoReplay, decision.allowed, method + ' / ' + item.label);
      assert.equal(run.canDispatch, true, method + ' / ' + item.label + ' 重放判定不应影响派发结论');
      // 结算结论只可能被“只读方法报告已生效”这一矛盾影响，不能被重放判定影响
      const proof = proofOf(method);
      const appliedContradiction = proof.effectState === 'none' && item.options.effectState === 'applied';
      assert.equal(run.canClaimSuccess, !appliedContradiction, method + ' / ' + item.label + ' 结算结论被重放判定污染');
      // 理由来自同一实现（不是第二套文案）
      const replayCheck = run.checks.find((check) => check.kind === 'replayability');
      assert.equal(replayCheck.reason, decision.reason, method + ' / ' + item.label + ' 判定理由漂移');
    }
  }
});

test('可重放 / 应 resolve 两类方法在“结果未知”场景下的结论与目录一致', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    const run = replayObligations(method, { dispatched: true, effectState: 'unknown', code: 'E_TIMEOUT' });
    if (proof.replayable) {
      assert.equal(run.canAutoReplay, true, method + ' 可重放方法被禁止');
      // 只给失败证据时前置义务是 unknown（缺上下文），聚合结论只能是 unknown/proven，
      // 绝不能是 violated。
      assert.notEqual(run.verdict, 'violated', method + ' 可重放场景被判 violated');
    } else {
      assert.equal(run.canAutoReplay, false, method + ' 不可重放方法被放行');
      assert.equal(run.verdict, 'violated');
      const check = run.checks.find((item) => item.kind === 'replayability');
      assert.match(check.reason, /resolve|人工|不可证明/);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. recoveryPlan × 恢复义务
// ---------------------------------------------------------------------------

test('recoveryPlan 与恢复义务：方法登记的错误码逐码一致', () => {
  for (const method of ALL_METHODS) {
    for (const code of proofOf(method).recovery) {
      const plan = recoveryPlan(method, code);
      const run = recoveryObligations(method, code);
      assert.equal(plan.known, true, method + '/' + code);
      assert.equal(run.hasRecoveryPlan, true, method + '/' + code + ' 义务层说没有恢复计划');
      const check = run.checks.find((item) => item.kind === 'recovery');
      assert.equal(check.verdict, 'satisfied');
      assert.match(check.reason, new RegExp(plan.action));
    }
  }
});

test('recoveryPlan.requiresResolve ⇒ 义务层禁止自动重放（含账本类错误码）', () => {
  let checked = 0;
  for (const method of ALL_METHODS) {
    for (const code of proofOf(method).recovery) {
      const plan = recoveryPlan(method, code);
      if (!plan.requiresResolve) continue;
      const run = replayObligations(method, { dispatched: true, effectState: 'unknown', code });
      assert.equal(run.canAutoReplay, false, method + '/' + code + ' 需要 resolve 却允许自动重放');
      checked += 1;
    }
  }
  assert.ok(checked > 0, '没有覆盖到 requiresResolve 场景');
  // 账本类错误码即使方法可重放也必须先 resolve（派生自 playbook action=resolve-ledger）
  const replayableLedger = ALL_METHODS.find((method) => proofOf(method).replayable && proofOf(method).recovery.includes('E_LEDGER_PENDING'));
  if (replayableLedger) {
    assert.equal(
      replayObligations(replayableLedger, { dispatched: true, effectState: 'unknown', code: 'E_LEDGER_PENDING' }).canAutoReplay,
      false,
      replayableLedger + ' 账本未 resolve 却允许重放',
    );
  }
});

test('未知错误码：recoveryPlan unknown 与恢复义务 violated 一致', () => {
  for (const method of ALL_METHODS) {
    const plan = recoveryPlan(method, 'E_NOT_A_REAL_CODE');
    const run = recoveryObligations(method, 'E_NOT_A_REAL_CODE');
    assert.equal(plan.known, false, method);
    assert.equal(run.hasRecoveryPlan, false, method);
    assert.equal(run.verdict, 'violated', method);
  }
});

test('恢复计划动作与义务理由使用同一份 playbook action', () => {
  for (const method of ['click', 'observe', 'video.start', 'transfer.begin', 'dialog.accept']) {
    for (const code of proofOf(method).recovery) {
      const plan = recoveryPlan(method, code);
      const check = recoveryObligations(method, code).checks.find((item) => item.kind === 'recovery');
      assert.ok(check.reason.includes(plan.action), method + '/' + code + ' 未引用 playbook action');
    }
  }
});

// ---------------------------------------------------------------------------
// 4. 摘要与覆盖率交叉
// ---------------------------------------------------------------------------

test('proofObligations（第一轮快照）与 obligationSummary（第二轮）六维一致', () => {
  for (const method of ALL_METHODS) {
    const snapshot = proofObligations(method);
    const summary = obligationSummary(method);
    assert.deepEqual([...snapshot.dimensions.pre.codes], [...summary.dimensions.pre]);
    assert.deepEqual([...snapshot.dimensions.post.codes], [...summary.dimensions.post]);
    assert.equal(snapshot.dimensions.effectState.value, summary.dimensions.effectState);
    assert.equal(snapshot.dimensions.idempotent, summary.dimensions.idempotent);
    assert.equal(snapshot.dimensions.replayable, summary.dimensions.replayable);
    assert.deepEqual([...snapshot.dimensions.recovery.codes], [...summary.dimensions.recoveryCodes]);
    assert.equal(snapshot.dimensions.recovery.profile, summary.dimensions.recoveryProfile);
  }
});

test('effectStateSummary 与义务表的 effect_state 义务分布一致', () => {
  const summary = effectStateSummary();
  const counts = {};
  for (const method of ALL_METHODS) {
    const state = obligationSummary(method).dimensions.effectState;
    counts[state] = (counts[state] || 0) + 1;
  }
  assert.deepEqual(summary.counts, counts);
  assert.equal(summary.total, 165);
});

test('recoveryCoverage 的方法数与义务表的恢复义务一致', () => {
  const coverage = recoveryCoverage();
  assert.equal(coverage.methods, 165);
  assert.equal(coverage.minPerMethod >= 1, true);
  let min = Infinity;
  let max = 0;
  for (const method of ALL_METHODS) {
    const count = METHOD_OBLIGATIONS[method].find((item) => item.kind === 'recovery').codes.length;
    min = Math.min(min, count);
    max = Math.max(max, count);
  }
  assert.equal(coverage.minPerMethod, min);
  assert.equal(coverage.maxPerMethod, max);
});

test('proofMatrix 与方法义务矩阵逐行一致', () => {
  const rows = proofMatrix();
  assert.equal(rows.length, 165);
  for (const row of rows) {
    const proof = proofOf(row.method);
    assert.equal(row.preCount, proof.pre.length, row.method);
    assert.equal(row.postCount, proof.post.length, row.method);
    assert.equal(row.recoveryCount, proof.recovery.length, row.method);
    assert.equal(row.effectState, proof.effectState, row.method);
    assert.equal(row.idempotent, proof.idempotent, row.method);
    assert.equal(row.replayable, proof.replayable, row.method);
    const summary = obligationSummary(row.method);
    assert.equal(row.postCount, summary.dimensions.post.length);
  }
});

// ---------------------------------------------------------------------------
// 5. 批量模拟 × 义务结论
// ---------------------------------------------------------------------------

test('simulateBatch：混合场景的 outcome 分组与义务结论逐条一致', () => {
  const calls = [];
  for (const method of ALL_METHODS.slice(0, 20)) {
    calls.push({ method, input: { context: SATISFIED_CONTEXT, result: fullResultFor(method) } });
  }
  for (const method of ALL_METHODS.slice(20, 40)) {
    calls.push({ method, input: { context: PRECONDITION_VIOLATED_CONTEXT[proofOf(method).pre[0]] } });
  }
  const batch = simulateBatch(calls);
  assert.equal(batch.total, 40);
  assert.equal(batch.results.length, 40);
  assert.equal(batch.counts['succeeded-verified'] + batch.counts['succeeded-unverified'], 20);
  assert.equal(batch.counts['blocked-precondition'], 20);
  for (let index = 0; index < calls.length; index += 1) {
    const simulated = batch.results[index];
    const obligations = runCallObligations(calls[index].method, calls[index].input);
    if (simulated.outcome === 'blocked-precondition') {
      assert.equal(obligations.canDispatch, false, calls[index].method);
    } else {
      assert.equal(obligations.canClaimSuccess, true, calls[index].method);
    }
  }
});

test('全部方法在“失败但已证明未生效”场景下：模拟结论 known 且义务允许重放', () => {
  for (const method of ALL_METHODS) {
    const simulated = simulateCall(method, {
      context: SATISFIED_CONTEXT,
      error: { code: 'E_BAD_ARG' },
      dispatched: false,
      effectState: 'none',
    });
    assert.equal(simulated.outcome, 'failed-known', method + ' 派发前错误应 known');
    const run = replayObligations(method, { dispatched: false, effectState: 'none', code: 'E_BAD_ARG' });
    assert.equal(run.canAutoReplay, true, method + ' 已证明未生效应允许重放');
  }
});

test('未知结果（E_TIMEOUT）场景：模拟结论按“是否可重放”分类，与义务结论一致', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    const simulated = simulateCall(method, {
      context: SATISFIED_CONTEXT,
      error: { code: 'E_TIMEOUT' },
      dispatched: true,
      effectState: 'unknown',
    });
    // simulateCall 把“可安全重放”的失败归为 failed-known（结论已知可重试），
    // 其余归为 failed-unknown（必须观察/账本）。
    assert.equal(simulated.outcome, proof.replayable ? 'failed-known' : 'failed-unknown', method);
    const run = replayObligations(method, { dispatched: true, effectState: 'unknown', code: 'E_TIMEOUT' });
    assert.equal(run.canAutoReplay, proof.replayable, method);
    assert.equal(simulated.replay.allowed, run.canAutoReplay, method + ' 两次判定不一致');
  }
});

test('后置条件覆盖率：34 个后置码都在 165 方法里被用到，且义务表逐码一致', () => {
  const used = new Set();
  for (const row of METHOD_CATALOG) for (const code of proofOf(row.method).post) used.add(code);
  for (const code of Object.keys(PROOF_POSTCONDITIONS)) assert.ok(used.has(code), code + ' 未被任何方法使用');
  for (const method of ALL_METHODS) {
    const postObligations = METHOD_OBLIGATIONS[method].filter((item) => item.kind === 'postcondition').map((item) => item.code);
    assert.deepEqual(postObligations, [...proofOf(method).post], method);
  }
});
