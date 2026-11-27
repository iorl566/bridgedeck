// mcp/approval-grades.mjs —— 工具审批分级（approval grade）与可解释性/一致性审计。
//
// 目标（第十批-B ①：工具 annotations 与 approval 分级）：现有 mcp/tool-policy.mjs 只给
// 一个布尔 `approvalRequired`。真实使用里三档语义不同，客户端/人工审核需要区分：
//   - none      ：read/mutate 工具，不需要确认（observe/click/goto ...）；
//   - confirm   ：destructive 工具，默认要求确认；BB_MCP_APPROVAL=off 时可在本地自动化里关闭
//                 （evaluate/settings/pair/session_stop/tab_close/recipe）；
//   - mandatory ：无论环境如何都必须确认（browser_update：会替换本地程序文件）。
//
// 分级是“从 policy 派生的只读视图”，不新增第二份工具表：
//   grade = mandatory 当 policy.approvalAlways；confirm 当 policy.approvalRequired；否则 none。
//
// 同时提供启动期硬审计（与 assertToolPolicies 同风格）：
//   - destructive 工具必须落在 confirm/mandatory 且带 approvalReason；
//   - 非 destructive 工具不得要求审批（近似防御：避免误把 read 工具锁死）；
//   - mandatory 集合必须与 tool-policy 的 APPROVAL_ALWAYS 完全一致（防两处漂移）；
//   - 每个 grade 都能映射到一句可读理由（人工审核可解释）。
//
// 调用点：mcp/server.mjs 启动期 assertApprovalGrades(TOOLS)、tools/list 的
// _meta['browser-bridge/policy'].approvalGrade 与 _meta['browser-bridge/approval']、
// initialize experimental['browser-bridge/approval']；单测 tests/unit/mcp-approval-grades.test.mjs。

import {
  APPROVAL_ALWAYS,
  APPROVAL_CONFIRMED,
  APPROVAL_ENV,
  APPROVAL_META_KEY,
  APPROVAL_RETRY,
  TIERS,
  approvalDisabled,
  approvalEnforced,
} from './tool-policy.mjs';

/** 审批等级。 */
export const APPROVAL_GRADES = Object.freeze({
  NONE: 'none',
  CONFIRM: 'confirm',
  MANDATORY: 'mandatory',
});

/** 等级 → 人类可读说明（审计报告/initialize instructions 用）。 */
export const APPROVAL_GRADE_LABELS = Object.freeze({
  [APPROVAL_GRADES.NONE]: '无需确认：可直接调用',
  [APPROVAL_GRADES.CONFIRM]: '需要确认：destructive 工具，默认拦截；BB_MCP_APPROVAL=off 可关闭',
  [APPROVAL_GRADES.MANDATORY]: '强制确认：任何环境都必须带 approval 确认',
});

// TIERS 的键是小写（read/mutate/destructive）；这里取一次，避免各处写错大小写。
const DESTRUCTIVE_TIER = TIERS.destructive;

/** 等级 → 默认动作（客户端/人工审核可用它决定“要不要弹窗”）。 */
export const APPROVAL_GRADE_ACTIONS = Object.freeze({
  [APPROVAL_GRADES.NONE]: 'proceed',
  [APPROVAL_GRADES.CONFIRM]: 'confirm-when-enforced',
  [APPROVAL_GRADES.MANDATORY]: 'always-confirm',
});

/**
 * 单工具审批分级。
 * @param {object|null} policy policyFor() 的返回值
 * @returns null | { grade:string, required:boolean, bypassable:boolean, mandatory:boolean,
 *                   metaKey:string, confirmValue:string, retry:string, action:string,
 *                   label:string, reason:(string|null), tier:string, tool:string }
 */
export function approvalGradeFor(policy) {
  if (!policy || typeof policy !== 'object') return null;
  let grade = APPROVAL_GRADES.NONE;
  if (policy.approvalAlways) grade = APPROVAL_GRADES.MANDATORY;
  else if (policy.approvalRequired) grade = APPROVAL_GRADES.CONFIRM;
  const required = grade !== APPROVAL_GRADES.NONE;
  return Object.freeze({
    tool: policy.name,
    tier: policy.tier,
    grade,
    required,
    bypassable: grade === APPROVAL_GRADES.CONFIRM,
    mandatory: grade === APPROVAL_GRADES.MANDATORY,
    metaKey: APPROVAL_META_KEY,
    confirmValue: APPROVAL_CONFIRMED,
    retry: required ? APPROVAL_RETRY : null,
    action: APPROVAL_GRADE_ACTIONS[grade],
    label: APPROVAL_GRADE_LABELS[grade],
    reason: required ? (policy.approvalReason || null) : null,
  });
}

/**
 * 审批在当前环境是否真的会拦截。
 * 语义与 tool-policy.approvalGate 一致（默认放行，除非强制或显式开启）。
 * @returns {{ enforced:boolean, reason:string, env:string }}
 */
export function gradeEnforcement(grade, env = process.env) {
  const value = String((env && env[APPROVAL_ENV]) || '') || '(unset)';
  if (grade === APPROVAL_GRADES.MANDATORY) {
    return Object.freeze({ enforced: true, reason: 'mandatory-grade', env: value });
  }
  if (grade === APPROVAL_GRADES.CONFIRM) {
    const enforced = approvalEnforced(env) && !approvalDisabled(env);
    return Object.freeze({ enforced, reason: enforced ? 'destructive-grade-enforced' : (approvalDisabled(env) ? 'approval-disabled-env' : 'approval-not-enabled-env'), env: value });
  }
  return Object.freeze({ enforced: false, reason: 'not-required', env: value });
}

/** 全工具分级表（顺序与 TOOLS 一致）。 */
export function approvalGradeTable(tools, { policyOf } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const resolve = typeof policyOf === 'function' ? policyOf : (tool) => tool && tool.policy;
  return list.map((tool) => {
    const policy = resolve(tool) || null;
    return approvalGradeFor(policy);
  }).filter(Boolean);
}

/**
 * 审批分档统计（tools/list _meta 与 initialize experimental 用）。
 * @returns {{ total:number, byGrade:object, approvals:Array<string>, mandatory:Array<string>,
 *             bypassable:Array<string>, confirmable:number, env:object }}
 */
export function gradeSnapshot(tools, { env = process.env, policyOf } = {}) {
  const rows = approvalGradeTable(tools, { policyOf });
  const byGrade = { [APPROVAL_GRADES.NONE]: 0, [APPROVAL_GRADES.CONFIRM]: 0, [APPROVAL_GRADES.MANDATORY]: 0 };
  for (const row of rows) byGrade[row.grade] = (byGrade[row.grade] || 0) + 1;
  const approvals = rows.filter((row) => row.required).map((row) => row.tool);
  return Object.freeze({
    total: rows.length,
    byGrade: Object.freeze(byGrade),
    approvals: Object.freeze(approvals),
    mandatory: Object.freeze(rows.filter((row) => row.mandatory).map((row) => row.tool)),
    bypassable: Object.freeze(rows.filter((row) => row.bypassable).map((row) => row.tool)),
    confirmable: approvals.length,
    env: Object.freeze({
      variable: APPROVAL_ENV,
      value: String((env && env[APPROVAL_ENV]) || '') || null,
      enforced: !approvalDisabled(env) && approvalEnforced(env),
      disabled: approvalDisabled(env),
    }),
    metaKey: APPROVAL_META_KEY,
    confirmValue: APPROVAL_CONFIRMED,
    retry: APPROVAL_RETRY,
  });
}

/**
 * 单工具可解释审批描述（gate 提示/diagnostics 用）。
 * @returns {{ grade:string, enforcedNow:boolean, whyNow:string, how:string, reason:(string|null) }}
 */
export function describeApproval(name, policy, env = process.env) {
  const grade = approvalGradeFor(policy);
  if (!grade) throw new Error('未知 MCP 工具策略：' + name);
  const enforcement = gradeEnforcement(grade.grade, env);
  const how = grade.required
    ? '在 tools/call 的 params._meta 里传 "' + APPROVAL_META_KEY + '": "' + APPROVAL_CONFIRMED + '" 后重试'
    : '无需审批，直接调用';
  return Object.freeze({
    tool: name,
    grade: grade.grade,
    enforcedNow: enforcement.enforced,
    whyNow: enforcement.reason,
    how,
    reason: grade.reason,
  });
}

/**
 * 分级一致性审计（server 启动期硬门禁）。
 * @returns {{ ok:boolean, errors:Array<{code:string,tool:string,message:string}>, stats:object }}
 */
export function auditApprovalGrades(tools) {
  const errors = [];
  const push = (code, tool, message) => errors.push(Object.freeze({ code, tool: String(tool || '<unknown>'), message }));
  const list = Array.isArray(tools) ? tools : [];
  if (!list.length) push('approval-shape', '<none>', '没有可审计的工具');
  const mandatory = [];
  const confirm = [];
  for (const tool of list) {
    const name = tool && tool.name;
    const policy = tool && tool.policy;
    if (!policy) { push('approval-missing-policy', name, '工具缺少 policy（先跑 assertToolPolicies）'); continue; }
    const grade = approvalGradeFor(policy);
    if (!grade) { push('approval-missing-grade', name, '无法派生审批等级'); continue; }
    if (grade.mandatory) mandatory.push(name);
    if (grade.grade === APPROVAL_GRADES.CONFIRM) confirm.push(name);
    if (policy.tier === DESTRUCTIVE_TIER && grade.grade === APPROVAL_GRADES.NONE) {
      push('approval-destructive', name, 'destructive 工具不能是 none 级审批');
    }
    if (policy.tier !== DESTRUCTIVE_TIER && grade.required && !grade.mandatory) {
      push('approval-non-destructive', name, '非 destructive 工具不应要求确认（避免误锁 read/mutate）');
    }
    if (grade.required && typeof grade.reason !== 'string') {
      push('approval-reason', name, '需要审批的工具必须带可解释理由（policy.approvalReason）');
    }
    if (grade.mandatory && tool.name !== 'browser_update') {
      push('approval-mandatory-extra', name, 'mandatory 等级只用于替换/安装本地程序的工具（当前仅 browser_update）');
    }
    if (grade.bypassable && APPROVAL_ALWAYS.includes(name)) {
      push('approval-bypass', name, 'APPROVAL_ALWAYS 里的工具必须是 mandatory，不能可绕过');
    }
  }
  for (const name of APPROVAL_ALWAYS) {
    if (!mandatory.includes(name)) push('approval-mandatory-missing', name, 'APPROVAL_ALWAYS 工具没有落在 mandatory 等级');
  }
  const byGrade = { [APPROVAL_GRADES.NONE]: 0, [APPROVAL_GRADES.CONFIRM]: 0, [APPROVAL_GRADES.MANDATORY]: 0 };
  for (const tool of list) {
    const grade = approvalGradeFor(tool && tool.policy);
    if (grade) byGrade[grade.grade] += 1;
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    stats: Object.freeze({
      tools: list.length,
      byGrade: Object.freeze(byGrade),
      mandatory: Object.freeze(mandatory),
      confirm: Object.freeze(confirm),
      alwaysSet: APPROVAL_ALWAYS,
    }),
  });
}

/** strict 包装：分级表漂移时 server 启动即失败。 */
export function assertApprovalGrades(tools) {
  const report = auditApprovalGrades(tools);
  if (!report.ok) {
    throw new Error('MCP 审批分级审计失败：\n' + report.errors.map((error) => error.code + ' ' + error.tool + ' ' + error.message).join('\n'));
  }
  return report;
}

/**
 * 审批能力快照（initialize experimental['browser-bridge/approval']）。
 * 只描述结构与当前环境，不暴露任何机密。
 */
export function approvalSnapshot(tools, { env = process.env, policyOf } = {}) {
  const snapshot = gradeSnapshot(tools, { env, policyOf });
  return Object.freeze({
    supported: true,
    grades: APPROVAL_GRADES,
    labels: APPROVAL_GRADE_LABELS,
    actions: APPROVAL_GRADE_ACTIONS,
    metaKey: APPROVAL_META_KEY,
    confirmValue: APPROVAL_CONFIRMED,
    retry: APPROVAL_RETRY,
    envVariable: APPROVAL_ENV,
    envEnforced: snapshot.env.enforced,
    envDisabled: snapshot.env.disabled,
    byGrade: snapshot.byGrade,
    approvals: snapshot.approvals,
    mandatory: snapshot.mandatory,
    total: snapshot.total,
  });
}
