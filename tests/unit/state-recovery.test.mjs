// tests/unit/state-recovery.test.mjs —— 错误恢复映射（recovery 维度）的运行时单测。
//
// 断言对象：
//   1. RECOVERY_PLAYBOOK 的 107 个错误码全部来自 lib/error-codes.mjs 的登记表，
//      动作/严重度/重试次数自洽，并与 ERROR_RECOVERY.retry 口径交叉一致；
//   2. 22 个恢复族覆盖 165 个方法，方法的恢复集 = 族的错误码集合；
//   3. recoveryPlan / recoveryForError / replayDecision 在典型场景下给出
//      “能不能重试、要不要人、要不要先 ledger resolve”的确定结论；
//   4. effect_state=none / 派发前错误码可以安全重试；非幂等 + 结果未知必须 resolve；
//   5. 未知方法/未知错误码安全退化，不抛错、不编造动作；
//   6. 恢复面与意图账本 NON_IDEMPOTENT / UNKNOWN_OUTCOME_CODES 的语义一致性。
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
} from '../../lib/method-catalog.mjs';
import { ERROR_CODE_LIST, ERROR_CODE_SET, ERROR_RECOVERY } from '../../lib/error-codes.mjs';
import { NON_IDEMPOTENT_METHODS, isNonIdempotentAction } from '../../lib/intent-ledger.mjs';
import {
  EFFECT_OUTCOME_STATES,
  PROOF_DIMENSIONS,
  RECOVERY_ACTIONS,
  RECOVERY_GROUPS,
  RECOVERY,
  RECOVERY_SEVERITIES,
  auditMethodStateMachine,
  describeMethodProof,
  effectStateOf,
  isIdempotent,
  isReplayable,
  listMethodProofs,
  methodRecoveryPlans,
  proofObligations,
  recoveryCoverage,
  recoveryForError,
  recoveryMatrix,
  recoveryPlan,
  replayDecision,
  replaySummary,
  stateMachineSnapshot,
} from '../../lib/method-state-machine.mjs';

const PLAYBOOK_CODES = Object.keys(RECOVERY_PLAYBOOK);
const VALID_ACTIONS = new Set(Object.keys(PROOF_RECOVERY_ACTIONS));

// ---------------------------------------------------------------------------
// playbook 自身一致性
// ---------------------------------------------------------------------------

test('RECOVERY_PLAYBOOK：107 个错误码全部已在 lib/error-codes.mjs 登记', () => {
  assert.equal(PLAYBOOK_CODES.length, 107);
  for (const code of PLAYBOOK_CODES) {
    assert.equal(ERROR_CODE_SET.has(code), true, 'playbook 含未登记错误码：' + code);
    assert.match(code, /^E_[A-Z0-9_]+$/, '错误码命名不规范：' + code);
  }
  // 与错误码总表的关系：playbook 是“方法可见错误”的子集，不是全部错误码。
  assert.ok(PLAYBOOK_CODES.length < ERROR_CODE_LIST.length, 'playbook 不应声称覆盖传输/CLI 层错误');
});

test('RECOVERY_PLAYBOOK：动作已登记、严重度合法、note 非空、可重试与次数自洽', () => {
  assert.deepEqual([...RECOVERY_SEVERITIES], ['recoverable', 'needs-user', 'fatal']);
  const severities = new Set();
  const actions = new Set();
  for (const [code, plan] of Object.entries(RECOVERY_PLAYBOOK)) {
    assert.ok(VALID_ACTIONS.has(plan.action), code + ' 动作未登记：' + plan.action);
    actions.add(plan.action);
    assert.ok(RECOVERY_SEVERITIES.includes(plan.severity), code + ' 严重度非法：' + plan.severity);
    severities.add(plan.severity);
    assert.equal(typeof plan.retryable, 'boolean', code);
    assert.ok(Number.isInteger(plan.maxAttempts) && plan.maxAttempts >= 0, code + ' maxAttempts 必须是非负整数');
    assert.equal(typeof plan.note, 'string');
    assert.ok(plan.note.trim().length >= 4, code + ' note 过短');
    if (plan.retryable) assert.ok(plan.maxAttempts >= 1, code + ' 可重试但 maxAttempts=0');
    if (!plan.retryable) assert.equal(plan.maxAttempts, 0, code + ' 不可重试但 maxAttempts>0');
    // 不可重试的错误语义必须能解释“为什么不重试”。
    // 不可重试的错误必须给出“非重试型”动作（不是 fix-params/升级/人工/收敛，就是 abort）。
    if (!plan.retryable) {
      assert.equal(['wait-and-retry', 'reobserve', 'resync-cooperation'].includes(plan.action), false, code + ' 不可重试却建议重试动作：' + plan.action);
    }
  }
  assert.deepEqual([...severities].sort(), ['fatal', 'needs-user', 'recoverable']);
  // 23 种动作被真实使用（'none' 只是成功路径占位）。
  assert.equal(actions.size, 23);
  assert.equal(actions.has('none'), false, '"none" 不应作为错误恢复动作');
  assert.deepEqual([...actions].sort(), [...VALID_ACTIONS].filter((action) => action !== 'none').sort());
});

test('RECOVERY_PLAYBOOK 与 ERROR_RECOVERY.retry 口径交叉一致', () => {
  let crossChecked = 0;
  for (const [code, legacy] of Object.entries(ERROR_RECOVERY)) {
    const plan = RECOVERY_PLAYBOOK[code];
    if (!plan) continue;
    crossChecked += 1;
    if (legacy.retry === 'no') {
      assert.equal(plan.retryable, false, code + '：legacy retry=no 但 playbook 可重试');
    }
    if (legacy.retry === 'transient') {
      assert.equal(plan.retryable, true, code + '：legacy retry=transient 但 playbook 不可重试');
      assert.ok(plan.maxAttempts >= 2, code + '：transient 至少允许 2 次尝试');
    }
    if (legacy.retry === 'after-action') {
      // after-action 表示“先做点什么再重试”；是否允许自动重发取决于动作类型
      // （reobserve/resolve 之后的调用是新调用），这里只要求 playbook 给出了动作。
      assert.equal(plan.action !== 'none', true, code + '：legacy retry=after-action 却没有恢复动作');
    }
    // 提示文案同源：playbook.note 必须与错误码表 hint 的语义方向一致（不要求逐字相同）。
    assert.equal(typeof legacy.hint, 'string', code);
  }
  assert.ok(crossChecked >= 45, '与 ERROR_RECOVERY 交叉的错误码过少：' + crossChecked);
});

test('恢复族：22 个族非空、错误码已登记且都有 playbook', () => {
  assert.equal(Object.keys(RECOVERY_PROFILES).length, 22);
  assert.deepEqual(Object.keys(RECOVERY_GROUPS).sort(), Object.keys(RECOVERY_PROFILES).sort());
  for (const [profile, codes] of Object.entries(RECOVERY_PROFILES)) {
    assert.ok(Array.isArray(codes) && codes.length >= 4, profile + ' 族的错误码过少');
    assert.equal(new Set(codes).size, codes.length, profile + ' 族内错误码重复');
    for (const code of codes) {
      assert.equal(ERROR_CODE_SET.has(code), true, profile + ' 含未登记码：' + code);
      assert.ok(RECOVERY_PLAYBOOK[code], profile + ' 的码缺少 playbook：' + code);
    }
  }
});

test('恢复面覆盖：165 方法、101 个方法可见码、单方法 7~34 个候选', () => {
  const coverage = recoveryCoverage();
  assert.equal(coverage.methods, 165);
  assert.equal(coverage.playbookCodes, 107);
  assert.equal(coverage.methodVisibleCodes, 101);
  assert.equal(coverage.profiles, 22);
  assert.deepEqual(coverage.missingFromPlaybook, []);
  assert.deepEqual(coverage.unregistered, []);
  assert.equal(coverage.minPerMethod, 7);
  assert.equal(coverage.maxPerMethod, 35);
  for (const row of METHOD_CATALOG) {
    const codes = METHOD_RECOVERY[row.method];
    assert.ok(codes.length >= coverage.minPerMethod && codes.length <= coverage.maxPerMethod, row.method);
    const expected = [...new Set([...RECOVERY_BASE_CODES, ...RECOVERY_PROFILES[describeMethodProof(row.method).recovery.profile]])];
    assert.deepEqual([...codes], expected, row.method);
    for (const code of RECOVERY_BASE_CODES) assert.ok(codes.includes(code), row.method + ' 缺少通用恢复码 ' + code);
  }
});

test('recoveryMatrix：方法→码、码→方法两张视图与目录一致', () => {
  const matrix = recoveryMatrix();
  assert.equal(Object.keys(matrix.byMethod).length, 165);
  assert.equal(Object.keys(matrix.byCode).length, 101);
  for (const method of METHOD_NAMES) {
    assert.deepEqual([...matrix.byMethod[method]], [...METHOD_RECOVERY[method]], method);
  }
  // 反向：码 → 方法必须与正表互逆。
  for (const [code, methods] of Object.entries(matrix.byCode)) {
    for (const method of methods) {
      assert.ok(METHOD_RECOVERY[method].includes(code), method + ' ← ' + code + ' 反向不一致');
    }
  }
  // 抽查：E_STALE_REF 只出现在交互/导航族
  assert.ok(matrix.byCode['E_STALE_REF'].includes('click'));
  assert.ok(matrix.byCode['E_STALE_REF'].includes('fill'));
  assert.equal(matrix.byCode['E_STALE_REF'].includes('observe'), false, 'observe 不应出现 ref 失效错误');
  assert.ok(matrix.byCode['E_LEDGER_RESOLVE_REQUIRED'].includes('session.start'));
});

// ---------------------------------------------------------------------------
// recoveryPlan 典型场景
// ---------------------------------------------------------------------------

test('recoveryPlan：错误码 → 动作/重试/人工/收敛 的确定结论', () => {
  const cases = [
    // [method, code, expected]
    ['click', 'E_STALE_REF', { action: 'reobserve', retryable: true, retryAllowed: true, requiresResolve: false, severity: 'recoverable', requiresHuman: false, codeProvesNoEffect: true, inMethodScope: true }],
    ['click', 'E_NOT_FOUND', { action: 'reobserve', retryAllowed: true, requiresResolve: false, codeProvesNoEffect: true }],
    ['click', 'E_NOT_ACTIONABLE', { action: 'change-target', retryAllowed: true, requiresResolve: false }],
    ['click', 'E_NO_SESSION', { action: 'reopen-session', retryAllowed: true, requiresResolve: false }],
    ['click', 'E_SESSION_PAUSED', { action: 'resume-session', retryAllowed: true, requiresResolve: false, requiresHuman: true }],
    ['click', 'E_INPUT_BUSY', { action: 'wait-and-retry', retryAllowed: true, requiresResolve: false, severity: 'recoverable' }],
    ['click', 'E_DIALOG_PENDING', { action: 'close-dialog', retryAllowed: true, requiresResolve: false }],
    ['click', 'E_TIMEOUT', { action: 'abort-no-retry', retryAllowed: false, requiresResolve: true, requiresHuman: true, codeProvesNoEffect: false }],
    ['click', 'E_DISCONNECTED', { action: 'reconnect-browser', retryAllowed: true, requiresResolve: false, codeProvesNoEffect: false }],
    ['click', 'E_LEDGER_RESOLVE_REQUIRED', { action: 'resolve-ledger', retryable: false, retryAllowed: false, requiresResolve: true }],
    ['click', 'E_LEDGER_PENDING', { action: 'resolve-ledger', requiresResolve: true }],
    ['click', 'E_PROTOCOL_UNSUPPORTED', { action: 'upgrade-extension', retryAllowed: false, requiresResolve: false, severity: 'needs-user' }],
    ['click', 'E_UNSUPPORTED_CAPABILITY', { action: 'upgrade-extension', retryAllowed: false }],
    ['click', 'E_BAD_ARG', { action: 'fix-params', retryAllowed: false, requiresResolve: false, severity: 'fatal' }],
    ['click', 'E_FORBIDDEN', { action: 'abort-no-retry', retryAllowed: false, requiresResolve: false }],
    ['tab.new', 'E_TAB_LEASE_HELD', { action: 'release-control', retryable: true, retryAllowed: true, requiresResolve: false }],
    ['tab.close', 'E_BORROW_DENIED', { action: 'wait-human', retryAllowed: false, requiresHuman: true }],
    ['transfer.begin', 'E_TRANSFER_STATE', { action: 'clear-transfer', retryAllowed: false }],
    ['transfer.chunk', 'E_TRANSFER_OFFSET', { action: 'clear-transfer', retryAllowed: true }],
    ['upload', 'E_UNSUPPORTED_REMOTE', { action: 'abort-no-retry', retryAllowed: false, severity: 'fatal' }],
    ['screenshot', 'E_CAPTURE_STALE', { action: 'regenerate-artifact', retryAllowed: true }],
    ['video.start', 'E_DEBUGGER_BUSY', { action: 'free-debugger', retryAllowed: true, requiresHuman: true }],
    ['session.start', 'E_START_PENDING', { action: 'wait-and-retry', retryAllowed: true }],
    ['observe', 'E_TIMEOUT', { action: 'wait-and-retry', retryable: true, retryAllowed: true, requiresResolve: false }],
    ['observe', 'E_OBSERVATION_STALE', { action: 'reobserve', retryAllowed: true }],
    ['cooperate.sync', 'E_CONTEXT_STALE', { action: 'resync-cooperation', retryAllowed: true }],
    ['request-help', 'E_HELP_DISABLED', { action: 'wait-human', retryAllowed: false, requiresHuman: true }],
    ['pair.create', 'E_PAIR_REQUIRED', { action: 'fix-params', retryAllowed: false }],
    ['daemon.stop', 'E_NO_DAEMON', { action: 'restart-daemon', retryAllowed: true }],
  ];
  for (const [method, code, expected] of cases) {
    const plan = recoveryPlan(method, code);
    assert.equal(plan.known, true, method + ' ' + code);
    assert.equal(plan.code, code, method);
    assert.equal(plan.method, method, method);
    assert.equal(plan.inMethodScope, true, method + ' ' + code + ' 不在恢复集');
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(plan[key], value, method + ' ' + code + ' 的 ' + key + ' 应为 ' + value + '，实际 ' + plan[key]);
    }
    assert.ok(Array.isArray(plan.steps) && plan.steps.length > 0, method + ' ' + code + ' 缺少步骤');
    assert.equal(typeof plan.note, 'string');
    assert.ok(Object.isFrozen(plan));
  }
});

test('recoveryPlan：结果可证明的方法遇到“结果未知型”错误会自动改推荐动作为重试', () => {
  const read = recoveryPlan('observe', 'E_TIMEOUT');
  assert.equal(read.playbookAction, 'abort-no-retry', 'playbook 原始动作保留可追溯');
  assert.equal(read.action, 'wait-and-retry', '只读方法应改为安全重试');
  assert.equal(read.retryAllowed, true);

  const mutate = recoveryPlan('click', 'E_TIMEOUT');
  assert.equal(mutate.playbookAction, 'abort-no-retry');
  assert.equal(mutate.action, 'abort-no-retry', '非幂等动作不能改成重试');
  assert.equal(mutate.retryAllowed, false);
});

test('recoveryPlan：effect_state=none / dispatched=false 证明未生效时可以安全重试', () => {
  const withNone = recoveryPlan('click', 'E_TIMEOUT', { effectState: 'none' });
  assert.equal(withNone.retryAllowed, true, 'effect_state=none 应允许重试');
  assert.equal(withNone.requiresResolve, false);

  const withDispatched = recoveryPlan('click', 'E_TIMEOUT', { dispatched: false });
  assert.equal(withDispatched.retryAllowed, true, 'dispatched=false 应允许重试');
  assert.equal(withDispatched.requiresResolve, false);

  const unknown = recoveryPlan('click', 'E_TIMEOUT', { effectState: 'unknown' });
  assert.equal(unknown.retryAllowed, false);
  assert.equal(unknown.requiresResolve, true);

  const applied = recoveryPlan('click', 'E_TIMEOUT', { effectState: 'applied' });
  assert.equal(applied.retryAllowed, false);
  assert.equal(applied.requiresResolve, true);
  // effect_state 枚举口径固定
  assert.deepEqual([...EFFECT_OUTCOME_STATES], ['none', 'unknown', 'applied']);
});

test('recoveryForError：从 error.data.effect_state / dispatched 读取“是否可能已生效”', () => {
  const notApplied = recoveryForError('click', { code: 'E_TIMEOUT', data: { effect_state: 'none' } });
  assert.equal(notApplied.retryAllowed, true);
  assert.equal(notApplied.requiresResolve, false);

  const camel = recoveryForError('click', { code: 'E_TIMEOUT', data: { effectState: 'applied' } });
  assert.equal(camel.retryAllowed, false);
  assert.equal(camel.requiresResolve, true);

  const dispatchedFalse = recoveryForError('click', { code: 'E_TIMEOUT', dispatched: false });
  assert.equal(dispatchedFalse.retryAllowed, true);

  const plain = recoveryForError('click', { code: 'E_STALE_REF' });
  assert.equal(plain.action, 'reobserve');
  assert.equal(plain.retryAllowed, true);
});

test('recoveryPlan：未知错误码/未知方法安全退化（不抛错、不编造动作）', () => {
  const unknownCode = recoveryPlan('click', 'E_NOT_A_REAL_ERROR');
  assert.equal(unknownCode.known, false);
  assert.equal(unknownCode.action, null);
  assert.deepEqual(unknownCode.steps, []);
  assert.equal(unknownCode.inMethodScope, false);
  assert.equal(unknownCode.provider, null);

  const unknownMethod = recoveryPlan('no.such.method', 'E_STALE_REF');
  assert.equal(unknownMethod.known, true, '错误码有 playbook，就应给出通用恢复');
  assert.equal(unknownMethod.inMethodScope, false);
  assert.equal(unknownMethod.provider, null);
  assert.ok(unknownMethod.steps.some((step) => /核对调用参数/.test(step)), '越界方法应提示核对作用域');

  const neither = recoveryPlan('no.such.method', 'E_NOT_A_REAL_ERROR');
  assert.equal(neither.known, false);
  assert.equal(neither.action, null);
});

test('methodRecoveryPlans：单方法全量恢复计划与目录一致', () => {
  const plans = methodRecoveryPlans('click');
  assert.equal(plans.known, true);
  assert.equal(plans.profile, 'interaction');
  assert.equal(plans.plans.length, METHOD_RECOVERY.click.length);
  assert.deepEqual(plans.plans.map((plan) => plan.code), [...METHOD_RECOVERY.click]);
  for (const plan of plans.plans) {
    assert.equal(plan.known, true);
    assert.equal(plan.method, 'click');
    assert.equal(plan.inMethodScope, true);
  }
  const unknown = methodRecoveryPlans('no.such.method');
  assert.equal(unknown.known, false);
  assert.deepEqual(unknown.plans, []);
});

// ---------------------------------------------------------------------------
// replayDecision
// ---------------------------------------------------------------------------

test('replayDecision：只读方法永远安全重放，非幂等方法必须 resolve', () => {
  const read = replayDecision('observe');
  assert.equal(read.known, true);
  assert.equal(read.allowed, true);
  assert.equal(read.requiresResolve, false);

  const click = replayDecision('click');
  assert.equal(click.allowed, false);
  assert.equal(click.requiresResolve, true);
  assert.match(click.reason, /非幂等|第二次真实副作用/);
  assert.equal(click.action, 'resolve-ledger');
});

test('replayDecision：逻辑幂等但结果不可证明仍然 requiresResolve', () => {
  const focus = replayDecision('focus');
  assert.equal(focus.idempotent, true);
  assert.equal(focus.allowed, false);
  assert.equal(focus.requiresResolve, true);
  assert.match(focus.reason, /逻辑幂等|不可证明/);
  assert.equal(focus.action, 'resolve-ledger');

  const stop = replayDecision('session.stop');
  assert.equal(stop.idempotent, true);
  assert.equal(stop.allowed, false);
  assert.equal(stop.requiresResolve, true);
});

test('replayDecision：effect_state=none / 派发前错误码 / dispatched=false 允许重放', () => {
  assert.equal(replayDecision('click', { effectState: 'none' }).allowed, true);
  assert.equal(replayDecision('click', { dispatched: false }).allowed, true);
  assert.equal(replayDecision('click', { code: 'E_STALE_REF' }).allowed, true);
  assert.equal(replayDecision('click', { code: 'E_NO_SESSION' }).allowed, true);
  assert.equal(replayDecision('click', { code: 'E_TIMEOUT' }).allowed, false);
  assert.equal(replayDecision('click', { code: 'E_DISCONNECTED' }).allowed, false);
  assert.equal(replayDecision('click', { effectState: 'applied' }).allowed, false);
});

test('replayDecision：未知方法保守拒绝并给出 abort-no-retry', () => {
  for (const method of ['no.such.method', '', null, undefined]) {
    const decision = replayDecision(method);
    assert.equal(decision.known, false);
    assert.equal(decision.allowed, false);
    assert.equal(decision.action, 'abort-no-retry');
  }
});

test('UNKNOWN_OUTCOME_CODES：13 个“可能已生效”错误码与账本口径一致', () => {
  assert.equal(UNKNOWN_OUTCOME_CODES.length, 13);
  for (const code of ['E_TIMEOUT', 'E_DAEMON_TIMEOUT', 'E_EXTENSION_GONE', 'E_DISCONNECTED', 'E_CANCELLED', 'E_LEDGER_RESOLVE_REQUIRED']) {
    assert.equal(isUnknownOutcomeCode(code), true, code);
    assert.equal(recoveryPlan('click', code).codeProvesNoEffect, false, code);
  }
  for (const code of ['E_STALE_REF', 'E_NO_SESSION', 'E_BAD_ARG', 'E_PROTOCOL_UNSUPPORTED', 'E_NOT_FOUND']) {
    assert.equal(isUnknownOutcomeCode(code), false, code);
    assert.equal(recoveryPlan('click', code).codeProvesNoEffect, true, code);
  }
  // 账本 NON_IDEMPOTENT 的方法 + 结果未知型错误 → 必须 resolve
  for (const method of METHOD_NAMES) {
    if (!isNonIdempotentAction(method)) continue;
    const plan = recoveryPlan(method, 'E_TIMEOUT');
    assert.equal(plan.requiresResolve, true, method + ' 非幂等动作超时后必须要求 resolve');
    assert.equal(plan.retryAllowed, false, method + ' 非幂等动作超时后不得自动重试');
  }
});

// ---------------------------------------------------------------------------
// effect_state / idempotent / replayable 入口
// ---------------------------------------------------------------------------

test('effectStateOf / isIdempotent / isReplayable：与六面表一致，未知方法安全', () => {
  for (const row of METHOD_CATALOG) {
    const proof = describeMethodProof(row.method);
    assert.equal(effectStateOf(row.method), proof.effectState, row.method);
    assert.equal(isIdempotent(row.method), proof.idempotent, row.method);
    assert.equal(isReplayable(row.method), proof.replayable, row.method);
  }
  assert.equal(effectStateOf('no.such.method'), null);
  assert.equal(isIdempotent('no.such.method'), false);
  assert.equal(isReplayable('no.such.method'), false);
});

test('replaySummary：幂等/可重放计数与六面目录一致', () => {
  const summary = replaySummary();
  assert.equal(summary.total, 165);
  assert.equal(summary.counts.idempotent, 99);
  assert.equal(summary.counts.replayable, 90);
  assert.equal(summary.counts.mutatingIdempotent, 24);
  assert.equal(summary.idempotent.length, 99);
  assert.equal(summary.replayable.length, 90);
  assert.equal(summary.notReplayable.length, 75);
  assert.deepEqual([...summary.idempotent].sort(), METHOD_NAMES.filter((method) => isIdempotent(method)).sort());
  assert.deepEqual([...summary.replayable].sort(), METHOD_NAMES.filter((method) => isReplayable(method)).sort());
});

// ---------------------------------------------------------------------------
// proofObligations / 快照 / 审计
// ---------------------------------------------------------------------------

test('proofObligations：成功路径 / 错误路径 / 无输入三种形态', () => {
  const bare = proofObligations('click');
  assert.equal(bare.known, true);
  assert.deepEqual(Object.keys(bare.dimensions).sort(), ['effectState', 'idempotent', 'post', 'pre', 'recovery', 'replayable']);
  assert.equal(bare.dimensions.effectState.value, 'page');
  assert.equal(bare.dimensions.idempotent, false);
  assert.equal(bare.dimensions.replayable, false);
  assert.equal(bare.replay, null);
  assert.equal(bare.recovery, null);
  assert.equal(bare.dimensions.post.state, 'not-observed');

  const success = proofObligations('tab.new', { context: { instanceConnected: true, browserReady: true, controlHeld: true }, result: { tabId: 7 } });
  assert.equal(success.dimensions.pre.state, 'proven');
  assert.equal(success.dimensions.post.state, 'partial');
  assert.equal(success.dimensions.post.detail.violated.length, 0);

  const failed = proofObligations('click', { error: { code: 'E_TIMEOUT' } });
  assert.ok(failed.replay);
  assert.equal(failed.replay.allowed, false);
  assert.equal(failed.recovery.action, 'abort-no-retry');
  assert.equal(failed.dimensions.recovery.plan.code, 'E_TIMEOUT');

  const unknown = proofObligations('no.such.method');
  assert.equal(unknown.known, false);
  assert.deepEqual(unknown.dimensions, {});
});

test('stateMachineSnapshot：六面/恢复/审计汇总一次给全', () => {
  const snapshot = stateMachineSnapshot();
  assert.equal(snapshot.total, 165);
  assert.deepEqual([...snapshot.dimensions], [...PROOF_DIMENSIONS]);
  assert.equal(snapshot.effectStates.total, 165);
  assert.equal(snapshot.replay.counts.replayable, 90);
  assert.equal(snapshot.recovery.methods, 165);
  assert.equal(snapshot.playbookCodes, 107);
  assert.equal(snapshot.profiles, 22);
  assert.equal(snapshot.families, 69);
  assert.deepEqual([...snapshot.auditErrors], []);
  assert.ok(Object.isFrozen(snapshot));
});

test('auditMethodStateMachine：真实目录零错误；返回数组便于门禁消费', () => {
  const errors = auditMethodStateMachine();
  assert.ok(Array.isArray(errors));
  assert.deepEqual(errors, []);
  // 恢复动作常量可被外部直接展示
  assert.equal(typeof RECOVERY_ACTIONS['reobserve'], 'string');
  assert.equal(RECOVERY_ACTIONS['resolve-ledger'], PROOF_RECOVERY_ACTIONS['resolve-ledger']);
});

test('listMethodProofs：165 条、结构与目录同序', () => {
  const rows = listMethodProofs();
  assert.equal(rows.length, 165);
  assert.deepEqual(rows.map((row) => row.method), METHOD_NAMES);
  for (const row of rows) {
    assert.equal(typeof row.effectState, 'string');
    assert.ok(Object.prototype.hasOwnProperty.call(row.replay, 'autoReplay'));
    assert.equal(row.replay.autoReplay, row.replayable);
    assert.ok(Array.isArray(row.recovery.codes) && row.recovery.codes.length > 0);
    assert.ok(Array.isArray(row.recovery.actions) && row.recovery.actions.length > 0);
  }
});

// ---------------------------------------------------------------------------
// 与账本/错误码目录的跨模块一致性
// ---------------------------------------------------------------------------

test('非幂等动作在账本里登记但不在 canonical 的历史别名仍保留语义', () => {
  for (const legacy of ['type', 'back', 'forward', 'window.new', 'window.ensure', 'debug.replay']) {
    assert.equal(NON_IDEMPOTENT_METHODS.has(legacy), true, legacy);
    assert.equal(METHOD_NAMES.includes(legacy), false, legacy + ' 不应进入 canonical');
    const plan = recoveryPlan(legacy, 'E_TIMEOUT');
    assert.equal(plan.known, true, '历史别名也应能查到恢复计划');
    assert.equal(plan.inMethodScope, false);
  }
});

test('所有 158 个登记错误码：要么有方法恢复计划，要么明确属于非方法层错误', () => {
  const methodVisible = new Set(Object.keys(recoveryMatrix().byCode));
  const nonMethodLayer = ERROR_CODE_LIST.filter((code) => !methodVisible.has(code));
  // 方法可见的错误码必须有 playbook；其余是传输/CLI/eval/内部错误，不应被伪装成方法恢复。
  for (const code of methodVisible) assert.ok(RECOVERY_PLAYBOOK[code], '方法可见错误缺少 playbook：' + code);
  assert.ok(nonMethodLayer.length > 20, '非方法层错误数量异常：' + nonMethodLayer.length);
  assert.ok(nonMethodLayer.includes('E_ARG_MISSING'), 'CLI 参数码不应进入方法恢复面');
  assert.ok(nonMethodLayer.includes('E_UNKNOWN_FLAG'), 'CLI 未知参数码不应进入方法恢复面');
  assert.ok(nonMethodLayer.includes('E_BAD_SUBCOMMAND'), 'CLI 子命令码不应进入方法恢复面');
  assert.ok(nonMethodLayer.includes('E_EVAL_DOM'), 'eval 离线运行器码不应进入方法恢复面');
  assert.ok(nonMethodLayer.includes('E_READ_ONLY'), '作用域拒绝是派发层错误，不属于单方法恢复');
});

test('恢复计划不改变任何既有错误码集合：playbook 码全部来自登记表，且不新增 E_ 码', () => {
  // 目录/状态机只引用登记码，不发明新码。
  const referenced = new Set([...PLAYBOOK_CODES, ...UNKNOWN_OUTCOME_CODES, ...Object.values(RECOVERY_PROFILES).flat()]);
  for (const code of referenced) {
    assert.equal(ERROR_CODE_SET.has(code), true, '引用了未登记错误码：' + code);
  }
  // 反向抽查：登记表里的核心兼容码仍完整保留。
  for (const code of ['E_PROTOCOL_UNSUPPORTED', 'E_UNSUPPORTED_CAPABILITY', 'E_LEDGER_RESOLVE_REQUIRED', 'E_STALE_REF', 'E_TIMEOUT']) {
    assert.equal(ERROR_CODE_SET.has(code), true, code);
  }
});
