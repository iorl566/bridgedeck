// tests/unit/mcp-approval-grades.test.mjs —— 工具审批分级（none/confirm/mandatory）测试。
//
// 覆盖：分级派生（approvalAlways→mandatory、approvalRequired→confirm、否则 none）、
// 环境强制判定（默认放行 / BB_MCP_APPROVAL=on / off / mandatory 恒拦截）、分级表与统计、
// 可解释描述、一致性审计（destructive 不得 none、非 destructive 不得 confirm、
// mandatory 集合与 APPROVAL_ALWAYS 一致）、strict 包装、能力快照。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_GRADES,
  APPROVAL_GRADE_ACTIONS,
  APPROVAL_GRADE_LABELS,
  approvalGradeFor,
  approvalGradeTable,
  approvalSnapshot,
  assertApprovalGrades,
  auditApprovalGrades,
  describeApproval,
  gradeEnforcement,
  gradeSnapshot,
} from '../../mcp/approval-grades.mjs';
import { createBrowserTools } from '../../mcp/tools.mjs';
import { TOOL_METHODS } from '../../mcp/tool-methods.mjs';
import { APPROVAL_ENV, APPROVAL_META_KEY, policyFor } from '../../mcp/tool-policy.mjs';

const CTX = {
  rpc: async () => { throw new Error('单测不执行 RPC'); },
  ensureSession: async () => 's-test',
  withSession: (sessionId, params) => ({ ...params, session: sessionId }),
  parseDurationMs: () => null,
  runCliJson: async () => ({}),
  HOME: '',
  state: {},
};

/** 与 mcp/server.mjs 启动装配一致：挂 methods + policy。 */
function buildTools() {
  const tools = createBrowserTools(CTX);
  for (const tool of tools) {
    tool.methods = TOOL_METHODS[tool.name];
    tool.policy = policyFor(tool.name, tool);
  }
  return tools;
}

const TOOLS = buildTools();

test('approvalGradeFor：三档派生与字段', () => {
  const read = approvalGradeFor(policyFor('browser_observe', TOOLS.find((tool) => tool.name === 'browser_observe')));
  assert.equal(read.grade, APPROVAL_GRADES.NONE);
  assert.equal(read.required, false);
  assert.equal(read.bypassable, false);
  assert.equal(read.mandatory, false);
  assert.equal(read.action, 'proceed');
  assert.equal(read.metaKey, APPROVAL_META_KEY);

  const confirm = approvalGradeFor(policyFor('browser_evaluate', TOOLS.find((tool) => tool.name === 'browser_evaluate')));
  assert.equal(confirm.grade, APPROVAL_GRADES.CONFIRM);
  assert.equal(confirm.required, true);
  assert.equal(confirm.bypassable, true);
  assert.equal(confirm.mandatory, false);
  assert.equal(confirm.retry, 'after-action');
  assert.equal(typeof confirm.reason, 'string');
  assert.match(confirm.label, /destructive/);

  const mandatory = approvalGradeFor(policyFor('browser_update', TOOLS.find((tool) => tool.name === 'browser_update')));
  assert.equal(mandatory.grade, APPROVAL_GRADES.MANDATORY);
  assert.equal(mandatory.mandatory, true);
  assert.equal(mandatory.bypassable, false);
  assert.equal(mandatory.action, 'always-confirm');

  assert.equal(approvalGradeFor(null), null);
  assert.equal(Object.isFrozen(confirm), true);
});

test('gradeEnforcement：默认放行 / 显式开启 / 关闭 / mandatory 恒拦截', () => {
  assert.deepEqual(
    { ...gradeEnforcement(APPROVAL_GRADES.NONE, {}) },
    { enforced: false, reason: 'not-required', env: '(unset)' },
  );
  assert.equal(gradeEnforcement(APPROVAL_GRADES.CONFIRM, {}).enforced, false);
  assert.equal(gradeEnforcement(APPROVAL_GRADES.CONFIRM, {}).reason, 'approval-not-enabled-env');
  assert.equal(gradeEnforcement(APPROVAL_GRADES.CONFIRM, { [APPROVAL_ENV]: 'required' }).enforced, true);
  assert.equal(gradeEnforcement(APPROVAL_GRADES.CONFIRM, { [APPROVAL_ENV]: 'on' }).enforced, true);
  assert.equal(gradeEnforcement(APPROVAL_GRADES.CONFIRM, { [APPROVAL_ENV]: 'off' }).enforced, false);
  assert.equal(gradeEnforcement(APPROVAL_GRADES.CONFIRM, { [APPROVAL_ENV]: 'off' }).reason, 'approval-disabled-env');
  // 即使关闭环境闸门，mandatory 仍强制。
  assert.equal(gradeEnforcement(APPROVAL_GRADES.MANDATORY, { [APPROVAL_ENV]: 'off' }).enforced, true);
  assert.equal(gradeEnforcement(APPROVAL_GRADES.MANDATORY, {}).reason, 'mandatory-grade');
});

test('approvalGradeTable / gradeSnapshot：92 工具三档统计与审批清单', () => {
  const table = approvalGradeTable(TOOLS, { policyOf: (tool) => tool.policy });
  assert.equal(table.length, 92);
  const snapshot = gradeSnapshot(TOOLS, { policyOf: (tool) => tool.policy });
  assert.equal(snapshot.total, 92);
  assert.equal(snapshot.byGrade[APPROVAL_GRADES.NONE], 85);
  assert.equal(snapshot.byGrade[APPROVAL_GRADES.CONFIRM], 6);
  assert.equal(snapshot.byGrade[APPROVAL_GRADES.MANDATORY], 1);
  assert.equal(snapshot.approvals.length, 7);
  assert.deepEqual([...snapshot.mandatory], ['browser_update']);
  assert.equal(snapshot.bypassable.length, 6);
  assert.ok(snapshot.approvals.includes('browser_evaluate'));
  assert.ok(snapshot.approvals.includes('browser_session_stop'));
  assert.equal(snapshot.confirmable, 7);
  assert.equal(snapshot.env.variable, APPROVAL_ENV);
  assert.equal(snapshot.env.disabled, false);
  assert.equal(snapshot.metaKey, APPROVAL_META_KEY);
});

test('describeApproval：可解释审批（等级/当前是否拦截/怎么做/理由）', () => {
  const evaluate = TOOLS.find((tool) => tool.name === 'browser_evaluate');
  const enforced = describeApproval('browser_evaluate', evaluate.policy, { [APPROVAL_ENV]: 'required' });
  assert.equal(enforced.grade, APPROVAL_GRADES.CONFIRM);
  assert.equal(enforced.enforcedNow, true);
  assert.match(enforced.how, /browser-bridge\/approval.*confirmed/);
  assert.equal(typeof enforced.reason, 'string');

  const readOnly = describeApproval('browser_observe', TOOLS.find((tool) => tool.name === 'browser_observe').policy, {});
  assert.equal(readOnly.enforcedNow, false);
  assert.match(readOnly.how, /无需审批/);

  assert.throws(() => describeApproval('nope', null), /未知 MCP 工具策略/);
});

test('auditApprovalGrades：92 工具全部分级且自洽，strict 包装不抛错', () => {
  const report = auditApprovalGrades(TOOLS);
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.stats.tools, 92);
  assert.deepEqual([...report.stats.mandatory], ['browser_update']);
  assert.equal(report.stats.confirm.length, 6);
  assert.deepEqual(report.stats.byGrade, { none: 85, confirm: 6, mandatory: 1 });
  assert.doesNotThrow(() => assertApprovalGrades(TOOLS));
});

test('auditApprovalGrades：破坏性/非破坏性/缺理由/缺 mandatory 的错误码', () => {
  const broken = TOOLS.map((tool) => ({ ...tool, policy: tool.policy ? { ...tool.policy } : tool.policy }));
  const evaluate = broken.find((tool) => tool.name === 'browser_evaluate');
  evaluate.policy = { ...evaluate.policy, approvalRequired: false, approvalAlways: false, approvalReason: null };
  const observe = broken.find((tool) => tool.name === 'browser_observe');
  observe.policy = { ...observe.policy, approvalRequired: true, approvalAlways: false };
  const update = broken.find((tool) => tool.name === 'browser_update');
  update.policy = { ...update.policy, approvalRequired: true, approvalAlways: false };
  const noReason = broken.find((tool) => tool.name === 'browser_settings');
  noReason.policy = { ...noReason.policy, approvalReason: null };

  const report = auditApprovalGrades(broken);
  assert.equal(report.ok, false);
  const codes = new Set(report.errors.map((error) => error.code));
  assert.ok(codes.has('approval-destructive'), 'destructive 变成 none 应报错');
  assert.ok(codes.has('approval-non-destructive'), 'read 工具被要求确认应报错');
  assert.ok(codes.has('approval-mandatory-missing'), 'APPROVAL_ALWAYS 未落 mandatory 应报错');
  assert.ok(codes.has('approval-reason'), '需要审批却无理由应报错');
});

test('approvalSnapshot：能力声明与环境状态', () => {
  const snapshot = approvalSnapshot(TOOLS, { policyOf: (tool) => tool.policy, env: { [APPROVAL_ENV]: 'on' } });
  assert.equal(snapshot.supported, true);
  assert.deepEqual({ ...snapshot.grades }, { ...APPROVAL_GRADES });
  assert.equal(snapshot.total, 92);
  assert.equal(snapshot.envVariable, APPROVAL_ENV);
  assert.equal(snapshot.envEnforced, true);
  assert.equal(snapshot.envDisabled, false);
  assert.equal(snapshot.metaKey, APPROVAL_META_KEY);
  assert.equal(snapshot.confirmValue, 'confirmed');
  assert.deepEqual([...snapshot.mandatory], ['browser_update']);
  assert.equal(APPROVAL_GRADE_LABELS.mandatory.includes('强制'), true);
  assert.equal(APPROVAL_GRADE_ACTIONS.none, 'proceed');
});
