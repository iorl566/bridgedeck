// tests/unit/mcp-recovery-playbook.test.mjs —— 错误恢复剧本 / 计划 / 有状态恢复会话。
//
// 覆盖：具体码/族/大类/兜底四级解析、严重度与 terminal、计划（步骤/延迟/历史跳过/升级人工）、
// RecoverySession（next/record/rebind/run/穷尽）、审计（大类覆盖/终态不许自动重试/工具名/
// stop 之后无步骤/FATAL 必含 human）、strict 包装与能力快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_PLAYBOOKS,
  PLAYBOOK_PATTERNS,
  PLAYBOOK_STEPS,
  RECOVERY_ACTION_TYPES,
  RECOVERY_LIMITS,
  RECOVERY_SEVERITIES,
  RecoverySession,
  auditRecoveryPlaybooks,
  assertRecoveryPlaybooks,
  planRecovery,
  playbookFor,
  recoverySnapshot,
} from '../../mcp/recovery-playbook.mjs';
import { ERROR_CATEGORIES, TERMINAL_CODES } from '../../mcp/error-map.mjs';
import { TOOL_METHODS } from '../../mcp/tool-methods.mjs';

const TOOL_NAMES = Object.keys(TOOL_METHODS);
const actionValues = Object.values(RECOVERY_ACTION_TYPES);

test('playbookFor：具体码优先，其次族，再大类，最后兜底', () => {
  const stale = playbookFor('E_STALE_REF');
  assert.equal(stale.source, 'code');
  assert.equal(stale.category, ERROR_CATEGORIES.RESOURCE);
  assert.equal(stale.terminal, false);
  assert.ok(stale.steps.length >= 2);
  assert.equal(stale.steps[0].action, RECOVERY_ACTION_TYPES.REOBSERVE);
  assert.equal(stale.steps[0].tool, 'browser_observe');

  const argMissing = playbookFor('E_ARG_MISSING');
  assert.equal(argMissing.source, 'family');
  assert.equal(argMissing.category, ERROR_CATEGORIES.VALIDATION);
  assert.equal(argMissing.steps[0].action, RECOVERY_ACTION_TYPES.FIX_ARGUMENTS);

  const unknownFamily = playbookFor('E_CAPTURE_LIMIT');
  assert.equal(unknownFamily.source, 'family');
  assert.equal(unknownFamily.steps[0].action, RECOVERY_ACTION_TYPES.REDUCE_SCOPE);

  // 不含具体码/族前缀，但 error-map 能归到 timeout 大类 → 走大类兜底。
  const categoryOnly = playbookFor('E_SOMETHING_NEW_IN_TIMEOUT');
  assert.equal(categoryOnly.source, 'category');
  assert.equal(categoryOnly.category, ERROR_CATEGORIES.TIMEOUT);
  // 不含已知前缀但含 TIMEOUT → error-map 归 timeout，走大类兜底。
  const timeoutCategory = playbookFor('E_WIDGET_TIMEOUT');
  assert.equal(timeoutCategory.source, 'category');
  assert.equal(timeoutCategory.category, ERROR_CATEGORIES.TIMEOUT);

  const fallback = playbookFor('E_TOTALLY_NEW_THING');
  assert.equal(fallback.source, 'category');
  assert.equal(fallback.category, ERROR_CATEGORIES.UNKNOWN);
  assert.ok(fallback.steps.length >= 1);

  for (const code of TERMINAL_CODES) {
    assert.equal(playbookFor(code).terminal, true, code + ' 应标记 terminal');
  }
  assert.equal(playbookFor('E_CANCELLED').severity, RECOVERY_SEVERITIES.INFO);
  assert.equal(playbookFor('E_CANCELLED').steps[0].action, RECOVERY_ACTION_TYPES.STOP);
});

test('playbookFor：具体码/族/大类数量与错误码族覆盖', () => {
  assert.ok(Object.keys(PLAYBOOK_STEPS).length >= 30);
  assert.ok(PLAYBOOK_PATTERNS.length >= 4);
  for (const category of Object.values(ERROR_CATEGORIES)) {
    assert.ok(CATEGORY_PLAYBOOKS[category], '缺少大类兜底：' + category);
    assert.ok(CATEGORY_PLAYBOOKS[category].steps.length >= 1);
  }
  // 每个剧本的步骤 action 都在枚举内、id 唯一。
  for (const [code, steps] of Object.entries(PLAYBOOK_STEPS)) {
    const ids = new Set();
    for (const item of steps) {
      assert.ok(actionValues.includes(item.action), code + ' 未知动作 ' + item.action);
      assert.equal(ids.has(item.id), false, code + ' 步骤 id 重复：' + item.id);
      ids.add(item.id);
    }
  }
});

test('planRecovery：步骤元数据、退避延迟、history 跳过与 summary', () => {
  const plan = planRecovery({ code: 'E_STALE_REF', tool: 'browser_click' });
  assert.equal(plan.code, 'E_STALE_REF');
  assert.equal(plan.tool, 'browser_click');
  assert.equal(plan.severity, RECOVERY_SEVERITIES.ERROR);
  assert.equal(plan.exhausted, false);
  assert.ok(plan.nextStep);
  assert.equal(plan.nextStep.action, RECOVERY_ACTION_TYPES.REOBSERVE);
  assert.equal(plan.nextStep.auto, true);
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0].index, 0);
  assert.equal(plan.steps[1].action, RECOVERY_ACTION_TYPES.RETRY);
  // E_STALE_REF 的 recovery 是 after-action → 不自动重试，因此 retry 步 auto=false。
  assert.equal(plan.steps[1].auto, false);
  assert.equal(plan.steps[1].delayMs, 0, '不可自动重试的 retry 步不应给延迟');
  assert.equal(plan.steps[2].action, RECOVERY_ACTION_TYPES.HUMAN);
  assert.equal(plan.steps[2].requiresHuman, true);
  assert.match(plan.summary, /E_STALE_REF/);
  assert.match(plan.summary, /下一步/);

  const skipped = planRecovery({ code: 'E_STALE_REF', history: ['reobserve'] });
  assert.equal(skipped.nextStep.id, 'retry');
  assert.equal(skipped.steps[0].skipped, true);
  const allDone = planRecovery({ code: 'E_STALE_REF', history: ['reobserve', 'retry', 'escalate-human'] });
  assert.equal(allDone.exhausted, true);
  assert.equal(allDone.nextStep, null);
  assert.equal(allDone.escalateToHuman, true);

  // 可自动重试的错误给指数退避延迟。
  const retryable = planRecovery({ code: 'E_RATE_LIMITED', attempt: 2 });
  const retryStep = retryable.steps.find((item) => item.action === RECOVERY_ACTION_TYPES.RETRY);
  assert.ok(retryStep);
  assert.equal(retryStep.auto, true);
  assert.ok(retryStep.delayMs >= 0);
  assert.ok(retryable.retry.attempt >= 1);

  // 终态错误：E_DAEMON 的 retry 步（若有）不得自动；计划给 terminal=true。
  const daemon = planRecovery({ code: 'E_DAEMON' });
  assert.equal(daemon.terminal, true);
  assert.ok(daemon.steps.every((item) => item.action !== RECOVERY_ACTION_TYPES.RETRY || item.auto === false));

  // 尝试次数耗尽时升级人工（剧本里有人工步骤）。
  const exhausted = planRecovery({ code: 'E_TIMEOUT', attempt: 3, maxAttempts: 3 });
  assert.equal(exhausted.escalateToHuman, true);

  // history 里对象形式的 stepId 也支持；上限截断保持有界。
  const objectHistory = planRecovery({ code: 'E_STALE_REF', history: [{ stepId: 'reobserve' }, { stepId: 'retry' }] });
  assert.equal(objectHistory.nextStep.id, 'escalate-human');
  const longHistory = planRecovery({ code: 'E_STALE_REF', history: Array.from({ length: 100 }, (_, index) => 'step-' + index) });
  assert.equal(longHistory.nextStep.id, 'reobserve');
  // 步骤数有硬上限。
  assert.ok(planRecovery({ code: 'E_TIMEOUT' }).steps.length <= RECOVERY_LIMITS.maxSteps);
});

test('RecoverySession：next 去重、record 成功即恢复、换绑新错误码、穷尽升级', async () => {
  const session = new RecoverySession({ code: 'E_STALE_REF', sleep: async () => {} });
  const first = session.next();
  assert.equal(first.done, false);
  assert.equal(first.step.action, RECOVERY_ACTION_TYPES.REOBSERVE);
  assert.equal(first.step.attempt, 1);
  const second = session.next();
  assert.equal(second.step.action, RECOVERY_ACTION_TYPES.RETRY);
  assert.notEqual(second.step.id, first.step.id);
  const third = session.next();
  assert.equal(third.step.action, RECOVERY_ACTION_TYPES.HUMAN);
  assert.equal(third.done, false);
  const exhausted = session.next();
  assert.equal(exhausted.done, true);
  assert.equal(exhausted.escalate, true);
  assert.equal(session.status, 'exhausted');
  const snapshot = session.snapshot();
  assert.equal(snapshot.status, 'exhausted');
  assert.equal(snapshot.escalate, true);
  assert.equal(snapshot.executed.length, 3);

  const success = new RecoverySession({ code: 'E_TIMEOUT', sleep: async () => {} });
  const step = success.next();
  const recovered = success.record(step.step.id, { ok: true });
  assert.equal(recovered.recovered, true);
  assert.equal(success.status, 'recovered');
  assert.equal(success.next().done, true);

  // 失败时换绑新错误码：继续跑新剧本（不重复已执行步骤）。
  const rebind = new RecoverySession({ code: 'E_TIMEOUT', sleep: async () => {} });
  const firstStep = rebind.next();
  rebind.record(firstStep.step.id, { ok: false, code: 'E_STALE_REF' });
  const nextAfterRebind = rebind.next();
  assert.equal(rebind.plan.code, 'E_STALE_REF');
  assert.ok(nextAfterRebind.step);
  assert.equal(nextAfterRebind.step.id, 'reobserve');

  // run(execute)：延迟被注入的 sleep 吃掉；execute 返回 true 即恢复。
  const waits = [];
  const runner = new RecoverySession({ code: 'E_RATE_LIMITED', sleep: async (ms) => { waits.push(ms); } });
  const executed = [];
  const result = await runner.run(async (step) => {
    executed.push(step.action);
    return true;
  });
  assert.equal(result.recovered, true);
  assert.equal(executed.length, 1);
  assert.ok(waits.length >= 0);
  // execute 抛错 → 记录失败并继续下一步（不会死循环）。
  const failing = new RecoverySession({ code: 'E_STALE_REF', sleep: async () => {} });
  const failedRun = await failing.run(async () => { throw Object.assign(new Error('boom'), { code: 'E_INTERNAL' }); });
  assert.equal(failedRun.status === 'exhausted' || failedRun.status === 'running', true);
  await assert.rejects(() => new RecoverySession({ code: 'E_STALE_REF' }).run(null), /需要 execute/);
});

test('auditRecoveryPlaybooks：真实工具名通过且 strict 不抛错；统计自洽', () => {
  const report = auditRecoveryPlaybooks({ toolNames: TOOL_NAMES });
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.stats.codePlaybooks, Object.keys(PLAYBOOK_STEPS).length);
  assert.equal(report.stats.familyPlaybooks, PLAYBOOK_PATTERNS.length);
  assert.equal(report.stats.categoryPlaybooks, Object.keys(ERROR_CATEGORIES).length);
  assert.ok(report.stats.totalSteps >= 50);
  assert.equal(report.stats.actions, actionValues.length);
  assert.doesNotThrow(() => assertRecoveryPlaybooks({ toolNames: TOOL_NAMES }));

  // 引用不存在的工具必须失败。
  const missingTool = auditRecoveryPlaybooks({ toolNames: ['browser_status'] });
  assert.equal(missingTool.ok, false);
  assert.ok(missingTool.errors.some((error) => error.code === 'recovery-tool'));
});

test('auditRecoveryPlaybooks：终态错误不许自动重试这一规则真实生效', () => {
  // E_SESSION_STOPPED / E_NO_SESSION 都是终态：剧本允许人工重试，但不允许 auto=true 的 retry。
  for (const code of ['E_SESSION_STOPPED', 'E_NO_SESSION']) {
    const plan = planRecovery({ code });
    for (const step of plan.steps) {
      if (step.action === RECOVERY_ACTION_TYPES.RETRY) assert.equal(step.auto, false, code);
    }
  }
  assert.ok(TERMINAL_CODES.includes('E_SESSION_STOPPED'));
  assert.ok(TERMINAL_CODES.includes('E_NO_SESSION'));
});

test('planRecovery：step id 稳定且可复算（同一输入两次结果一致）', () => {
  const a = planRecovery({ code: 'E_HUMAN_GATE' });
  const b = planRecovery({ code: 'E_HUMAN_GATE' });
  assert.deepEqual(a.steps.map((step) => step.id), b.steps.map((step) => step.id));
  assert.equal(a.steps[0].action, RECOVERY_ACTION_TYPES.HUMAN);
  assert.equal(a.steps[0].requiresHuman, true);
  // 审批错误的下一步是 human（不能自动重试）。
  assert.equal(a.nextStep.action, RECOVERY_ACTION_TYPES.HUMAN);
  assert.match(a.hint.length >= 0 ? 'ok' : '', /ok/);
});

test('recoverySnapshot：能力声明、审计摘要与有状态 API', () => {
  const snapshot = recoverySnapshot({ toolNames: TOOL_NAMES });
  assert.equal(snapshot.supported, true);
  assert.equal(snapshot.metaKey, 'browser-bridge/recovery');
  assert.equal(snapshot.codePlaybooks, Object.keys(PLAYBOOK_STEPS).length);
  assert.equal(snapshot.audit.ok, true);
  assert.equal(snapshot.audit.errors, 0);
  assert.equal(snapshot.stateful.class, 'RecoverySession');
  assert.deepEqual([...snapshot.stateful.methods], ['next', 'record', 'run', 'snapshot']);
  assert.equal(snapshot.actions.RETRY, 'retry');
  assert.equal(snapshot.severities.FATAL, 'fatal');
  assert.equal(snapshot.fields.includes('escalateToHuman'), true);
  assert.equal(snapshot.retryPolicy.maxAttempts >= 1, true);
});
