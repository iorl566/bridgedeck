// tests/unit/state-machine-matrix.test.mjs —— 165 方法 × 恢复码 的穷举矩阵测试。
//
// 目标不是再抄一遍目录，而是证明“六面语义在笛卡尔积上自洽”：
//   1. 每个方法 × 恢复集里的每个错误码，recoveryPlan 都返回结构合法的计划；
//   2. 计划的 action/severity/retryAllowed/requiresResolve/requiresHuman/codeProvesNoEffect
//      之间的关系不矛盾（例如不可重试却 retryAllowed、可重放方法却不能重试）；
//   3. 恢复索引（recoveryIndex/explainRecovery）与逐方法计划同源；
//   4. proofMatrix / listMethodProofs / METHOD_PROOF 三视图一致；
//   5. 每个恢复族在真实方法上都有非空适用面，且 severity 分布合理。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METHOD_CATALOG,
  METHOD_NAMES,
  METHOD_RECOVERY,
  PROOF_RECOVERY_ACTIONS,
  RECOVERY_BASE_CODES,
  RECOVERY_PLAYBOOK,
  RECOVERY_PROFILES,
  UNKNOWN_OUTCOME_CODES,
  isUnknownOutcomeCode,
  methodStateOf,
} from '../../lib/method-catalog.mjs';
import { ERROR_CODE_SET } from '../../lib/error-codes.mjs';
import {
  describeMethodProof,
  explainRecovery,
  listMethodProofs,
  methodRecoveryPlans,
  proofMatrix,
  recoveryCoverage,
  recoveryIndex,
  recoveryMatrix,
  recoveryPlan,
  recoverySeveritySummary,
  replayDecision,
  replaySummary,
  stateMachineSnapshot,
} from '../../lib/method-state-machine.mjs';

/** METHOD_STATE 的等价访问（避免测试直接依赖生成物）。 */
function stateOf(method) {
  return methodStateOf(method);
}

const VALID_ACTIONS = new Set(Object.keys(PROOF_RECOVERY_ACTIONS));
const VALID_SEVERITIES = new Set(['recoverable', 'needs-user', 'fatal']);
/**
 * 这些恢复动作会先改变环境（重连/重开/重新观察/升级）再让调用方重新发起调用，
 * 因此“重试”是全新调用而不是重放；但 effect_state=applied 时仍然禁止（见状态机实现）。
 */
const SAFE_NEW_CALL_ACTIONS = new Set([
  'reobserve', 'resync-cooperation', 'reopen-session', 'rebind-tab', 'resume-session',
  'fix-params', 'close-dialog', 'free-debugger', 'change-target', 'regenerate-artifact',
  'retry-download', 'clear-transfer', 'upgrade-extension', 'upgrade-cli', 'restart-daemon',
  'reconnect-browser', 'enable-incognito', 'wait-human', 'release-control',
]);
const ALL_PLAN_CASES = METHOD_NAMES.flatMap((method) => METHOD_RECOVERY[method].map((code) => ({ method, code })));

// ---------------------------------------------------------------------------
// 笛卡尔积：165 方法 × 各自恢复码
// ---------------------------------------------------------------------------

test('恢复矩阵规模：165 方法 × 各自的恢复码，覆盖 101 个错误码', () => {
  assert.equal(ALL_PLAN_CASES.length, METHOD_NAMES.reduce((sum, method) => sum + METHOD_RECOVERY[method].length, 0));
  assert.ok(ALL_PLAN_CASES.length >= 2000, '矩阵规模异常：' + ALL_PLAN_CASES.length);
  const codes = new Set(ALL_PLAN_CASES.map((item) => item.code));
  assert.equal(codes.size, 101);
  assert.equal(codes.size, Object.keys(recoveryMatrix().byCode).length);
});

test('每个（方法，恢复码）组合的 recoveryPlan 结构合法且自洽', () => {
  for (const { method, code } of ALL_PLAN_CASES) {
    const plan = recoveryPlan(method, code);
    const label = method + ' × ' + code;
    assert.equal(plan.known, true, label);
    assert.equal(plan.method, method, label);
    assert.equal(plan.code, code, label);
    assert.equal(plan.inMethodScope, true, label + ' 恢复集里的码必须 inMethodScope');
    assert.equal(typeof plan.note, 'string', label);
    assert.ok(plan.note.length >= 4, label + ' note 过短');
    assert.ok(VALID_ACTIONS.has(plan.action), label + ' 动作未登记：' + plan.action);
    assert.ok(VALID_SEVERITIES.has(plan.severity), label + ' 严重度非法：' + plan.severity);
    assert.ok(Array.isArray(plan.steps) && plan.steps.length >= 1, label + ' 缺少步骤');
    assert.equal(typeof plan.retryable, 'boolean', label);
    assert.equal(typeof plan.retryAllowed, 'boolean', label);
    assert.equal(typeof plan.requiresResolve, 'boolean', label);
    assert.equal(typeof plan.requiresHuman, 'boolean', label);
    // retryAllowed 的前提：错误本身可重试、且本方法/本次结果允许重放
    if (plan.retryAllowed) assert.equal(plan.retryable, true, label + ' retryAllowed 但 retryable=false');
    // codeProvesNoEffect 必须与“可能已生效错误码”表互逆
    assert.equal(plan.codeProvesNoEffect, !isUnknownOutcomeCode(code), label + ' codeProvesNoEffect 口径不一致');
    // 需要人工 ⇔ needs-user / wait-human
    assert.equal(plan.requiresHuman, plan.severity === 'needs-user' || plan.action === 'wait-human', label);
    // 非幂等 + 结果未知 ⇒ 除非动作暗示“重连/重开后是全新调用”，否则必须 resolve。
    if (!plan.codeProvesNoEffect && !isReplayableMethod(method) && !SAFE_NEW_CALL_ACTIONS.has(plan.action)) {
      assert.equal(plan.requiresResolve, true, label + ' 非幂等且结果未知却没有要求 resolve');
    }
    // 需要 resolve 时绝不自动重试；effect_state=applied 时同理。
    if (plan.requiresResolve) assert.equal(plan.retryAllowed, false, label + ' 需要 resolve 却允许重试');
    assert.ok(Object.isFrozen(plan), label + ' 计划应冻结');
  }
});

function isReplayableMethod(method) {
  return describeMethodProof(method).replayable;
}

test('结果可证明的方法：playbook 允许重试且无需 resolve 时 retryAllowed 必须为 true', () => {
  for (const { method, code } of ALL_PLAN_CASES) {
    if (!isReplayableMethod(method)) continue;
    const playbook = RECOVERY_PLAYBOOK[code];
    const plan = recoveryPlan(method, code);
    if (playbook.retryable && playbook.maxAttempts > 0 && !plan.requiresResolve) {
      assert.equal(plan.retryAllowed, true, method + ' × ' + code + ' 只读方法应允许重试');
    }
  }
});

test('不可重试的 playbook：任何方法下 retryAllowed 都必须为 false', () => {
  for (const { method, code } of ALL_PLAN_CASES) {
    const playbook = RECOVERY_PLAYBOOK[code];
    if (playbook.retryable) continue;
    assert.equal(recoveryPlan(method, code).retryAllowed, false, method + ' × ' + code);
  }
});

test('“结果未知型”错误码：只读方法可安全重试；重连/重开类动作属于全新调用', () => {
  for (const code of UNKNOWN_OUTCOME_CODES) {
    for (const method of METHOD_NAMES) {
      if (!METHOD_RECOVERY[method].includes(code)) continue;
      const plan = recoveryPlan(method, code);
      assert.equal(plan.codeProvesNoEffect, false);
      if (isReplayableMethod(method)) {
        // 账本类错误即使方法可重放也要先 resolve 账本。
        if (!plan.requiresResolve && RECOVERY_PLAYBOOK[code].retryable) {
          assert.equal(plan.retryAllowed, true, method + ' × ' + code + ' 只读方法应允许重试');
        }
      } else if (!SAFE_NEW_CALL_ACTIONS.has(plan.action)) {
        assert.equal(plan.requiresResolve, true, method + ' × ' + code + ' 非只读方法必须 resolve');
      }
    }
  }
});

test('effect_state=none 时结果未知错误可安全重试（账本类错误除外）', () => {
  const ledgerCodes = new Set(['E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED', 'E_LEDGER_CONFLICT']);
  for (const code of UNKNOWN_OUTCOME_CODES) {
    if (ledgerCodes.has(code)) continue;
    for (const method of METHOD_NAMES) {
      if (!METHOD_RECOVERY[method].includes(code)) continue;
      const plan = recoveryPlan(method, code, { effectState: 'none' });
      assert.equal(plan.requiresResolve, false, method + ' × ' + code);
      if (RECOVERY_PLAYBOOK[code].retryable) assert.equal(plan.retryAllowed, true, method + ' × ' + code);
    }
  }
  // 账本类错误即使 effect_state=none 也必须显式 resolve（账本状态机要求）。
  for (const code of ledgerCodes) {
    assert.equal(recoveryPlan('click', code, { effectState: 'none' }).requiresResolve, true, code);
  }
});

test('effect_state=applied 时任何方法都不会被建议自动重试', () => {
  for (const code of ['E_TIMEOUT', 'E_DISCONNECTED', 'E_CANCELLED']) {
    for (const method of ['click', 'navigate', 'video.start', 'session.start', 'tab.new']) {
      const plan = recoveryPlan(method, code, { effectState: 'applied' });
      assert.equal(plan.retryAllowed, false, method + ' × ' + code);
    }
  }
  // 最容易被误判的一类：可重连错误 + 只读方法 + applied（页面确实变了）也不能自动重发。
  assert.equal(recoveryPlan('observe', 'E_DISCONNECTED', { effectState: 'applied' }).retryAllowed, false);
});

test('方法恢复计划（methodRecoveryPlans）与矩阵逐项一致', () => {
  for (const method of METHOD_NAMES) {
    const plans = methodRecoveryPlans(method);
    assert.equal(plans.known, true, method);
    assert.equal(plans.plans.length, METHOD_RECOVERY[method].length, method);
    assert.deepEqual(plans.plans.map((plan) => plan.code), [...METHOD_RECOVERY[method]], method);
    for (const plan of plans.plans) {
      assert.equal(plan.method, method);
      assert.equal(plan.inMethodScope, true);
    }
  }
});

// ---------------------------------------------------------------------------
// profile（恢复族）维度
// ---------------------------------------------------------------------------

test('22 个恢复族：每个族至少覆盖 1 个方法，错误码在 playbook 与注册表内', () => {
  const profileUsage = {};
  for (const row of METHOD_CATALOG) {
    const proof = describeMethodProof(row.method);
    profileUsage[proof.recovery.profile] = (profileUsage[proof.recovery.profile] || 0) + 1;
  }
  assert.equal(Object.keys(profileUsage).length, Object.keys(RECOVERY_PROFILES).length);
  for (const [profile, codes] of Object.entries(RECOVERY_PROFILES)) {
    assert.ok(profileUsage[profile] >= 1, profile + ' 没有被任何方法使用（死族）');
    for (const code of codes) {
      assert.ok(RECOVERY_PLAYBOOK[code], profile + ' 的码缺少 playbook：' + code);
      assert.ok(ERROR_CODE_SET.has(code), profile + ' 的码未登记：' + code);
      // 族内每个码至少有一个方法真正适用
      assert.ok(recoveryMatrix().byCode[code].some((method) => describeMethodProof(method).recovery.profile === profile), profile + ' × ' + code + ' 没有适用方法');
    }
  }
});

test('恢复族包含通用错误码（E_BAD_ARG/E_INVALID_PARAMS），但不同族有各自专属码', () => {
  assert.deepEqual([...RECOVERY_BASE_CODES], ['E_BAD_ARG', 'E_INVALID_PARAMS']);
  for (const method of ['click', 'observe', 'video.start', 'tab.new', 'session.start']) {
    for (const code of RECOVERY_BASE_CODES) assert.ok(METHOD_RECOVERY[method].includes(code), method + ' 缺少 ' + code);
  }
  // 专属码：E_STALE_REF 只在交互/导航；E_CAPTURE_STALE 只在 capture；E_TRANSFER_* 只在 transfer
  assert.ok(METHOD_RECOVERY.click.includes('E_STALE_REF'));
  assert.equal(METHOD_RECOVERY['video.start'].includes('E_STALE_REF'), false);
  assert.ok(METHOD_RECOVERY.screenshot.includes('E_CAPTURE_STALE'));
  assert.equal(METHOD_RECOVERY.click.includes('E_CAPTURE_STALE'), false);
  assert.ok(METHOD_RECOVERY['transfer.chunk'].includes('E_TRANSFER_OFFSET'));
  assert.equal(METHOD_RECOVERY.click.includes('E_TRANSFER_OFFSET'), false);
});

// ---------------------------------------------------------------------------
// 恢复索引 / 解释
// ---------------------------------------------------------------------------

test('recoveryIndex：107 个错误码，画像字段与 playbook/矩阵同源', () => {
  const index = recoveryIndex();
  assert.equal(Object.keys(index).length, 107);
  assert.deepEqual(Object.keys(index).sort(), Object.keys(RECOVERY_PLAYBOOK).sort());
  for (const [code, entry] of Object.entries(index)) {
    const plan = RECOVERY_PLAYBOOK[code];
    assert.equal(entry.code, code);
    assert.equal(entry.action, plan.action);
    assert.equal(entry.severity, plan.severity);
    assert.equal(entry.retryable, plan.retryable);
    assert.equal(entry.maxAttempts, plan.maxAttempts);
    assert.equal(entry.note, plan.note);
    assert.equal(entry.methods, (recoveryMatrix().byCode[code] || []).length);
    assert.ok(Array.isArray(entry.profiles));
    assert.deepEqual([...entry.profiles].sort(), [...new Set((recoveryMatrix().byCode[code] || []).map((method) => describeMethodProof(method).recovery.profile))].sort());
  }
  // 无适用方法的码也应在索引里（这类码属于方法外错误，不能在方法恢复面出现）
  const orphan = Object.values(index).filter((entry) => entry.methods === 0).map((entry) => entry.code).sort();
  assert.deepEqual(orphan, ['E_READ_ONLY', 'E_SNAPSHOT_CORRUPT', 'E_SNAPSHOT_DISABLED', 'E_SNAPSHOT_WRITE', 'E_UNKNOWN_METHOD', 'E_UNSUPPORTED']);
  for (const code of orphan) assert.equal(recoveryMatrix().byCode[code], undefined, code + ' 不应出现在方法矩阵里');
});

test('explainRecovery：有 playbook 的码给动作/步骤/适用面，未知码安全', () => {
  const stale = explainRecovery('E_STALE_REF');
  assert.equal(stale.known, true);
  assert.equal(stale.action, 'reobserve');
  assert.equal(stale.actionLabel, PROOF_RECOVERY_ACTIONS.reobserve);
  assert.equal(stale.severity, 'recoverable');
  assert.ok(stale.steps.length >= 2);
  assert.ok(stale.methods >= 10);
  assert.deepEqual([...stale.profiles], ['interaction']);

  const timeout = explainRecovery('E_TIMEOUT');
  assert.equal(timeout.known, true);
  assert.equal(timeout.action, 'abort-no-retry');
  assert.equal(timeout.severity, 'needs-user');
  assert.ok(timeout.profiles.includes('interaction'));

  const unknown = explainRecovery('E_NOT_A_REAL_ERROR');
  assert.equal(unknown.known, false);
  assert.equal(unknown.action, null);
  assert.deepEqual(unknown.steps, []);
  assert.deepEqual(unknown.profiles, []);
  assert.equal(unknown.methods, 0);
});

test('recoverySeveritySummary：29 可恢复 / 49 需人工 / 29 致命，可恢复动作清单非空', () => {
  const summary = recoverySeveritySummary();
  assert.equal(summary.counts.recoverable, 29);
  assert.equal(summary.counts['needs-user'], 49);
  assert.equal(summary.counts.fatal, 29);
  assert.equal(summary.counts.recoverable + summary.counts['needs-user'] + summary.counts.fatal, 107);
  assert.equal(summary.recoverableActions.length, 29);
  for (const entry of summary.recoverableActions) {
    assert.equal(RECOVERY_PLAYBOOK[entry.code].severity, 'recoverable');
    assert.ok(entry.maxAttempts >= 1);
  }
  assert.deepEqual([...summary.codes.fatal].sort(), Object.entries(RECOVERY_PLAYBOOK).filter(([, plan]) => plan.severity === 'fatal').map(([code]) => code).sort());
});

// ---------------------------------------------------------------------------
// proofMatrix / listMethodProofs / METHOD_PROOF 三视图
// ---------------------------------------------------------------------------

test('proofMatrix：165 行，字段与六面快照一致', () => {
  const matrix = proofMatrix();
  assert.equal(matrix.length, 165);
  assert.deepEqual(matrix.map((row) => row.method), METHOD_NAMES);
  for (const row of matrix) {
    const described = describeMethodProof(row.method);
    assert.equal(row.known, true);
    assert.equal(row.owner, described.owner);
    assert.equal(row.effect, described.effect);
    assert.equal(row.effectState, described.effectState);
    assert.equal(row.idempotent, described.idempotent);
    assert.equal(row.replayable, described.replayable);
    assert.equal(row.profile, described.recovery.profile);
    assert.equal(row.preCount, described.pre.length);
    assert.equal(row.postCount, described.post.length);
    assert.equal(row.recoveryCount, described.recovery.codes.length);
    assert.deepEqual([...row.pre], [...described.pre]);
    assert.deepEqual([...row.post], [...described.post]);
  }
});

test('proofMatrix：未知方法给出 known=false 的空行', () => {
  const rows = proofMatrix(['ghost.method']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].known, false);
  assert.equal(rows[0].owner, null);
  assert.equal(rows[0].preCount, 0);
  assert.equal(rows[0].recoveryCount, 0);
});

test('三视图一致：listMethodProofs / proofMatrix / METHOD_PROOF', () => {
  const proofs = listMethodProofs();
  const rows = proofMatrix();
  assert.equal(proofs.length, rows.length);
  for (let index = 0; index < proofs.length; index += 1) {
    assert.equal(proofs[index].method, rows[index].method);
    assert.equal(proofs[index].effectState, rows[index].effectState);
    assert.equal(proofs[index].replayable, rows[index].replayable);
    assert.deepEqual([...proofs[index].post], [...rows[index].post]);
  }
});

// ---------------------------------------------------------------------------
// replayDecision 与恢复计划联动（每个方法）
// ---------------------------------------------------------------------------

test('replayDecision：165 方法在 UNKNOWN 下的结论与 retryAllowed 语义一致', () => {
  for (const method of METHOD_NAMES) {
    const decision = replayDecision(method, { effectState: 'unknown' });
    const plan = recoveryPlan(method, 'E_TIMEOUT', { effectState: 'unknown' });
    if (decision.allowed) {
      assert.equal(plan.requiresResolve, false, method + ' 可重放却被要求 resolve');
    } else {
      assert.equal(plan.requiresResolve, true, method + ' 不可重放却没有要求 resolve');
    }
  }
});

test('replaySummary 与逐方法六面一致（无隐藏清单）', () => {
  const summary = replaySummary();
  assert.equal(summary.total, 165);
  assert.equal(summary.idempotent.length + (165 - summary.idempotent.length), 165);
  assert.deepEqual([...summary.replayable].sort(), METHOD_NAMES.filter((method) => describeMethodProof(method).replayable).sort());
  assert.deepEqual([...summary.idempotent].sort(), METHOD_NAMES.filter((method) => describeMethodProof(method).idempotent).sort());
  for (const method of summary.notReplayable) {
    assert.equal(describeMethodProof(method).replayable, false, method);
    assert.equal(stateOf(method).unknown, true, method);
  }
});

// ---------------------------------------------------------------------------
// 快照/覆盖
// ---------------------------------------------------------------------------

test('stateMachineSnapshot：与各专项入口一致', () => {
  const snapshot = stateMachineSnapshot();
  assert.equal(snapshot.total, 165);
  assert.equal(snapshot.effectStates.total, 165);
  assert.equal(snapshot.recovery.methods, 165);
  assert.equal(snapshot.replay.counts.idempotent, replaySummary().counts.idempotent);
  assert.equal(snapshot.playbookCodes, Object.keys(RECOVERY_PLAYBOOK).length);
  assert.equal(snapshot.profiles, Object.keys(RECOVERY_PROFILES).length);
  assert.deepEqual([...snapshot.auditErrors], []);
});

test('recoveryCoverage：与方法恢复集实测一致', () => {
  const coverage = recoveryCoverage();
  assert.equal(coverage.methods, 165);
  assert.equal(coverage.methodVisibleCodes, new Set(ALL_PLAN_CASES.map((item) => item.code)).size);
  assert.equal(coverage.minPerMethod, Math.min(...METHOD_NAMES.map((method) => METHOD_RECOVERY[method].length)));
  assert.equal(coverage.maxPerMethod, Math.max(...METHOD_NAMES.map((method) => METHOD_RECOVERY[method].length)));
  assert.deepEqual(coverage.missingFromPlaybook, []);
  assert.deepEqual(coverage.unregistered, []);
});
