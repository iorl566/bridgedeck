// tests/unit/mcp-approval-audit.test.mjs —— 审批分级决策 + 哈希链硬审计。
//
// 覆盖：风险评分/等级/升级矩阵、参数摘要（不泄明文）、账本哈希链（append/verify/trim/anchor）、
// 篡改检测、回执签发/校验、decideApproval 四种决策（not-required/bypassed/denied/approved/
// mandatory-approved）、审计自检（真实 92 工具 + 合成坏工具）、strict 包装与能力快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_AUDIT_LIMITS,
  APPROVAL_DECISIONS,
  APPROVAL_ESCALATIONS,
  APPROVAL_REASON_CODES,
  APPROVAL_RISK_BANDS,
  approvalAuditSnapshot,
  approvalRisk,
  assertApprovalAudit,
  auditApprovalAudit,
  canonicalize,
  createApprovalLedger,
  decideApproval,
  escalationRuleFor,
  hashApprovalEntry,
  paramsDigest,
  riskBandOf,
  verifyApprovalChain,
  verifyApprovalReceipt,
} from '../../mcp/approval-audit.mjs';
import { APPROVAL_CONFIRMED, APPROVAL_META_KEY, approvalDisabled, approvalEnforced, policyFor } from '../../mcp/tool-policy.mjs';
import { approvalGradeFor, APPROVAL_GRADES } from '../../mcp/approval-grades.mjs';
import { createBrowserTools } from '../../mcp/tools.mjs';
import { TOOL_METHODS } from '../../mcp/tool-methods.mjs';

/** 与 server 启动期同样的装配：先挂 methods，再派生 policy。 */
function buildTools() {
  const tools = createBrowserTools({
    rpc: async () => ({}),
    ensureSession: async () => 's1',
    withSession: () => ({}),
    parseDurationMs: () => 0,
    runCliJson: async () => ({}),
    HOME: 'C:/tmp/bb-approval-audit-test',
    state: {},
  });
  for (const tool of tools) {
    tool.methods = TOOL_METHODS[tool.name];
    tool.policy = policyFor(tool.name, tool);
  }
  return tools;
}

const TOOLS = buildTools();
const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));
const fixedClock = () => 1_700_000_000_000;
function fixedNonce() {
  let index = 0;
  return () => 'nonce-' + (index += 1);
}

function ledgerOf(limit = 32) {
  return createApprovalLedger({ limit, env: {}, now: fixedClock, nonce: fixedNonce() });
}

test('approvalRisk：tier/等级/openWorld/幂等/恒审批的加权与等级带', () => {
  const evaluate = TOOL_MAP.get('browser_evaluate');
  const risk = approvalRisk(evaluate.policy);
  assert.equal(risk.tool, 'browser_evaluate');
  assert.equal(risk.tier, 'destructive');
  assert.equal(risk.band, APPROVAL_RISK_BANDS.CRITICAL);
  assert.ok(risk.score >= 75 && risk.score <= 100);
  assert.ok(risk.factors.some((factor) => factor.code === 'tier-destructive'));
  assert.ok(risk.factors.some((factor) => factor.code === 'non-idempotent'));

  const status = TOOL_MAP.get('browser_status');
  const readRisk = approvalRisk(status.policy);
  assert.equal(readRisk.band, APPROVAL_RISK_BANDS.LOW);
  assert.ok(readRisk.score < 25);

  const update = TOOL_MAP.get('browser_update');
  const mandatoryRisk = approvalRisk(update.policy);
  assert.equal(mandatoryRisk.band, APPROVAL_RISK_BANDS.CRITICAL);
  assert.ok(mandatoryRisk.factors.some((factor) => factor.code === 'grade-mandatory'));
  assert.ok(mandatoryRisk.factors.some((factor) => factor.code === 'approval-always'));

  assert.equal(approvalRisk(null), null);
  assert.equal(riskBandOf(0), APPROVAL_RISK_BANDS.LOW);
  assert.equal(riskBandOf(25), APPROVAL_RISK_BANDS.MEDIUM);
  assert.equal(riskBandOf(50), APPROVAL_RISK_BANDS.HIGH);
  assert.equal(riskBandOf(75), APPROVAL_RISK_BANDS.CRITICAL);
  assert.equal(riskBandOf(999), APPROVAL_RISK_BANDS.CRITICAL);
});

test('escalationRuleFor：none / confirm / manual-review / mandatory 四档', () => {
  const read = escalationRuleFor(TOOL_MAP.get('browser_status').policy);
  assert.equal(read.escalate, APPROVAL_ESCALATIONS.NONE);
  assert.equal(read.requiresReason, false);

  const evaluate = escalationRuleFor(TOOL_MAP.get('browser_evaluate').policy);
  assert.equal(evaluate.escalate, APPROVAL_ESCALATIONS.MANUAL_REVIEW);
  assert.equal(evaluate.requiresReason, true);
  assert.equal(evaluate.requiresFreshContext, true);

  const update = escalationRuleFor(TOOL_MAP.get('browser_update').policy);
  assert.equal(update.escalate, APPROVAL_ESCALATIONS.MANDATORY);
  assert.equal(update.requiresReason, true);

  // 合成一个“低风险 destructive”：只应要求普通确认。
  const synthetic = {
    name: 'synthetic_tool', tier: 'destructive', approvalRequired: true, approvalAlways: false,
    approvalReason: '测试用', openWorld: false, idempotent: true, readOnly: false, destructive: true,
    title: 'Synthetic', timeoutMs: 60_000,
  };
  const confirm = escalationRuleFor(synthetic, approvalGradeFor(synthetic));
  assert.equal(confirm.escalate, APPROVAL_ESCALATIONS.CONFIRM);
  assert.equal(confirm.requiresReason, false);
  assert.equal(escalationRuleFor(null).escalate, APPROVAL_ESCALATIONS.NONE);
});

test('canonicalize / paramsDigest：键排序、深度有界、不回显明文', () => {
  const canonical = canonicalize({ b: 2, a: [3, { z: 1, y: 2 }] });
  assert.deepEqual(Object.keys(canonical), ['a', 'b']);
  assert.equal(typeof canonical.a[1].z, 'number');
  assert.equal(canonicalize('x'.repeat(5000)).endsWith('…'), true);
  const deep = canonicalize({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } });
  assert.equal(JSON.stringify(deep).includes('max-depth'), true);

  const digest = paramsDigest({ name: 'browser_evaluate', arguments: { expression: 'document.cookie', secret: 'hunter2' } });
  assert.equal(digest.length, APPROVAL_AUDIT_LIMITS.maxParamsDigestLength);
  assert.equal(/hunter2|document\.cookie/.test(digest), false, '摘要不能包含明文参数');
  // 参数顺序/空白不影响摘要；不同参数不同摘要。
  assert.equal(paramsDigest({ arguments: { a: 1, b: 2 } }), paramsDigest({ arguments: { b: 2, a: 1 } }));
  assert.notEqual(paramsDigest({ arguments: { a: 1 } }), paramsDigest({ arguments: { a: 2 } }));
  assert.equal(paramsDigest(null).length, APPROVAL_AUDIT_LIMITS.maxParamsDigestLength);
});

test('审批账本：哈希链自洽、seq 连续、anchor 与 trim', () => {
  const ledger = ledgerOf(3);
  const first = ledger.append({ tool: 'browser_evaluate', grade: 'confirm', decision: APPROVAL_DECISIONS.APPROVED, reasonCode: APPROVAL_REASON_CODES.CONFIRMED, tier: 'destructive', riskBand: 'critical' });
  const second = ledger.append({ tool: 'browser_session_stop', grade: 'confirm', decision: APPROVAL_DECISIONS.DENIED, reasonCode: APPROVAL_REASON_CODES.DENIED_ENFORCED, tier: 'destructive', riskBand: 'critical' });
  assert.equal(first.prevHash, 'genesis');
  assert.equal(second.prevHash, first.hash);
  assert.equal(second.hash, hashApprovalEntry(second, first.hash));
  assert.equal(ledger.size(), 2);
  assert.equal(ledger.verify().ok, true);
  assert.equal(ledger.stats().counters.denied, 1);

  // 超出容量：丢最旧但保留 anchor，链仍可校验且 seq 不重置。
  ledger.append({ tool: 'browser_evaluate', grade: 'confirm', decision: APPROVAL_DECISIONS.APPROVED, reasonCode: APPROVAL_REASON_CODES.CONFIRMED });
  ledger.append({ tool: 'browser_settings', grade: 'confirm', decision: APPROVAL_DECISIONS.APPROVED, reasonCode: APPROVAL_REASON_CODES.CONFIRMED });
  assert.equal(ledger.size(), 3);
  const stats = ledger.stats();
  assert.equal(stats.seq, 4);
  assert.equal(stats.counters.trimmed, 1);
  assert.notEqual(stats.anchorHash, 'genesis');
  const verify = ledger.verify();
  assert.equal(verify.ok, true, 'trim 后应以 anchorHash 为链头继续校验');

  const tampered = ledger.entries().map((entry, index) => (index === 1 ? { ...entry, decision: APPROVAL_DECISIONS.BYPASSED } : entry));
  const tamperedReport = verifyApprovalChain(tampered, { anchorHash: stats.anchorHash });
  assert.equal(tamperedReport.ok, false);
  assert.ok(tamperedReport.errors.some((error) => error.code === 'approval-hash'));
  // 删除中间条目 → prevHash 断裂。
  const gapped = [ledger.entries()[0], ledger.entries()[2]].filter(Boolean);
  const gapReport = verifyApprovalChain(gapped, { anchorHash: stats.anchorHash });
  assert.equal(gapReport.ok, false);
  assert.ok(gapReport.errors.some((error) => error.code === 'approval-prev-hash' || error.code === 'approval-seq-gap'));
});

test('回执：确认放行才签发，可校验且不可跨账本', () => {
  const ledger = ledgerOf();
  const evaluate = TOOL_MAP.get('browser_evaluate');
  const approved = decideApproval({
    name: 'browser_evaluate',
    params: { arguments: { expression: '1 + 1' }, _meta: { [APPROVAL_META_KEY]: APPROVAL_CONFIRMED } },
    policy: evaluate.policy,
    env: { BB_MCP_APPROVAL: 'required' },
    ledger,
  });
  assert.equal(approved.allowed, true);
  assert.equal(approved.decision, APPROVAL_DECISIONS.APPROVED);
  assert.ok(approved.receipt);
  assert.equal(approved.receipt.id.startsWith('apr_'), true);
  assert.equal(approved.receipt.chain, 'sha256');
  assert.equal(verifyApprovalReceipt(approved.receipt, ledger).ok, true);

  const otherLedger = ledgerOf();
  otherLedger.append({ tool: 'x', grade: 'confirm', decision: APPROVAL_DECISIONS.APPROVED, reasonCode: 'x' });
  assert.equal(verifyApprovalReceipt(approved.receipt, otherLedger).ok, false);
  assert.equal(verifyApprovalReceipt(null, ledger).ok, false);

  // 被拒绝的调用不签发回执。
  const denied = decideApproval({
    name: 'browser_evaluate',
    params: { arguments: { expression: '1' } },
    policy: evaluate.policy,
    env: { BB_MCP_APPROVAL: 'required' },
    ledger,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.decision, APPROVAL_DECISIONS.DENIED);
  assert.equal(denied.receipt, null);
  assert.equal(denied.record.enforced, true);
});

test('decideApproval：not-required / bypassed / denied / approved / mandatory-approved', () => {
  const ledger = ledgerOf();
  const status = TOOL_MAP.get('browser_status');
  const read = decideApproval({ name: 'browser_status', params: {}, policy: status.policy, env: { BB_MCP_APPROVAL: 'strict' }, ledger });
  assert.equal(read.allowed, true);
  assert.equal(read.decision, APPROVAL_DECISIONS.NOT_REQUIRED);
  assert.equal(read.record.escalation, APPROVAL_ESCALATIONS.NONE);
  assert.equal(read.entry, null, 'read 工具不进审批账本');
  assert.equal(read.gate, null);

  const evaluate = TOOL_MAP.get('browser_evaluate');
  // 默认环境不强制审批 → 未确认也放行，但记为 bypassed（可审计）。
  const bypassed = decideApproval({ name: 'browser_evaluate', params: {}, policy: evaluate.policy, env: {}, ledger });
  assert.equal(bypassed.allowed, true);
  assert.equal(bypassed.decision, APPROVAL_DECISIONS.BYPASSED);
  assert.equal(bypassed.receipt, null);
  assert.ok(bypassed.entry);

  // 显式开启审批 → 拦截，错误结构与 tool-policy 完全一致。
  const denied = decideApproval({
    name: 'browser_evaluate',
    params: {},
    policy: evaluate.policy,
    env: { BB_MCP_APPROVAL: 'required' },
    ledger,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.gate.isError, true);
  assert.equal(String(denied.gate.content[0].text).includes('E_HUMAN_GATE'), true);
  assert.equal(denied.reasonCode, APPROVAL_REASON_CODES.DENIED_ENFORCED);

  const mandatoryDenied = decideApproval({
    name: 'browser_update',
    params: {},
    policy: TOOL_MAP.get('browser_update').policy,
    env: {},
    ledger,
  });
  assert.equal(mandatoryDenied.allowed, false);
  assert.equal(mandatoryDenied.reasonCode, APPROVAL_REASON_CODES.DENIED_MANDATORY);

  const mandatoryApproved = decideApproval({
    name: 'browser_update',
    params: { _meta: { [APPROVAL_META_KEY]: APPROVAL_CONFIRMED } },
    policy: TOOL_MAP.get('browser_update').policy,
    env: {},
    ledger,
  });
  assert.equal(mandatoryApproved.allowed, true);
  assert.equal(mandatoryApproved.decision, APPROVAL_DECISIONS.MANDATORY_APPROVED);
  assert.equal(mandatoryApproved.reasonCode, APPROVAL_REASON_CODES.MANDATORY);
  assert.ok(mandatoryApproved.receipt);

  // 关闭账本（BB_MCP_APPROVAL_AUDIT=off）不影响拦截：强制审批仍生效，只是不记账。
  const quietLedger = createApprovalLedger({ env: { BB_MCP_APPROVAL_AUDIT: 'off' } });
  const quietDenied = decideApproval({ name: 'browser_evaluate', params: {}, policy: evaluate.policy, env: { BB_MCP_APPROVAL: 'required' }, ledger: quietLedger });
  assert.equal(quietDenied.allowed, false);
  assert.equal(quietDenied.entry, null);
  assert.equal(quietLedger.enabled, false);
  assert.equal(quietLedger.stats().counters.skipped, 1);
});

test('decideApproval：未知工具抛错；tool-policy 环境开关与决策一致', () => {
  assert.throws(() => decideApproval({ name: 'browser_nope', params: {} }), /未知 MCP 工具策略/);
  const evaluate = TOOL_MAP.get('browser_evaluate');
  const offEnv = { BB_MCP_APPROVAL: 'off' };
  assert.equal(approvalDisabled(offEnv), true);
  assert.equal(approvalEnforced(offEnv), false);
  const allowedWhenOff = decideApproval({ name: 'browser_evaluate', params: {}, policy: evaluate.policy, env: offEnv });
  assert.equal(allowedWhenOff.allowed, true);
  assert.equal(allowedWhenOff.decision, APPROVAL_DECISIONS.BYPASSED);
  // 决策与直接调用 approvalGate 的语义一致（denied 文本一致）。
  const strict = { BB_MCP_APPROVAL: 'required' };
  const decision = decideApproval({ name: 'browser_evaluate', params: {}, policy: evaluate.policy, env: strict });
  assert.ok(decision.gate);
});

test('auditApprovalAudit：真实 92 工具通过、strict 不抛错、统计正确', () => {
  const report = auditApprovalAudit(TOOLS);
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.stats.tools, 92);
  assert.equal(report.stats.bands.low + report.stats.bands.medium + report.stats.bands.high + report.stats.bands.critical, 92);
  assert.equal(report.stats.escalations.mandatory, 1);
  assert.ok(report.stats.escalations['manual-review'] >= 1);
  assert.equal(report.stats.ledger.size, 3, '审计内部用 3 条记录验证链');
  assert.doesNotThrow(() => assertApprovalAudit(TOOLS));
  assert.equal(auditApprovalAudit([]).ok, false);

  // 坏工具：缺 policy / destructive 但 none 级 / mandatory 等级错配。
  const badTools = [
    { name: 'no_policy' },
    {
      name: 'browser_evaluate',
      policy: {
        name: 'browser_evaluate', tier: 'destructive', approvalRequired: false, approvalAlways: false,
        approvalReason: 'x', openWorld: true, idempotent: false, title: 'X', timeoutMs: 60_000,
      },
    },
    {
      name: 'synthetic_confirm',
      policy: {
        name: 'synthetic_confirm', tier: 'destructive', approvalRequired: true, approvalAlways: false,
        approvalReason: null, openWorld: false, idempotent: true, title: 'X', timeoutMs: 60_000,
      },
    },
  ];
  const badReport = auditApprovalAudit(badTools);
  assert.equal(badReport.ok, false);
  const codes = badReport.errors.map((error) => error.code);
  assert.ok(codes.includes('approval-audit-policy'));
  assert.ok(codes.includes('approval-audit-destructive'));
  assert.ok(codes.includes('approval-audit-always-missing'));
  assert.ok(codes.includes('approval-audit-reason'));
});

test('approvalAuditSnapshot：风险/升级分布、账本、回执与审计字段声明', () => {
  const ledger = ledgerOf();
  const snapshot = approvalAuditSnapshot(TOOLS, { ledger, env: {} });
  assert.equal(snapshot.supported, true);
  assert.equal(snapshot.grades ?? null, null, '快照不重复暴露 grades（由 approval-grades 模块负责）');
  assert.equal(snapshot.tools.length, 92);
  assert.equal(snapshot.byBand.critical >= 1, true);
  assert.equal(snapshot.byEscalation.mandatory, 1);
  assert.equal(snapshot.ledger.enabled, true);
  assert.equal(snapshot.ledger.chainAlgorithm, 'sha256');
  assert.equal(snapshot.receipt.metaKey, 'browser-bridge/approval-receipt');
  assert.equal(snapshot.audit.metaKey, 'browser-bridge/approval-audit');
  assert.equal(snapshot.enabled, true);

  const disabled = approvalAuditSnapshot(TOOLS, { ledger: null, env: { BB_MCP_APPROVAL_AUDIT: 'off' } });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.ledger, null);
  assert.equal(disabled.decisions.DENIED, APPROVAL_DECISIONS.DENIED);
});

test('风险/升级矩阵覆盖与分级一致（与 approval-grades 模块对账）', () => {
  for (const tool of TOOLS) {
    const grade = approvalGradeFor(tool.policy);
    if (!grade || !grade.required) continue;
    const risk = approvalRisk(tool.policy, grade);
    const escalation = escalationRuleFor(tool.policy, grade);
    assert.ok(risk.band, tool.name + ' 缺风险等级');
    if (grade.grade === APPROVAL_GRADES.MANDATORY) {
      assert.equal(escalation.escalate, APPROVAL_ESCALATIONS.MANDATORY, tool.name);
      assert.equal(escalation.requiresReason, true);
    } else {
      assert.ok([APPROVAL_ESCALATIONS.CONFIRM, APPROVAL_ESCALATIONS.MANUAL_REVIEW].includes(escalation.escalate), tool.name);
    }
  }
  // 账本条目数量与确认放行的 destructive 调用一致：审计只统计需要审批的调用。
  const ledger = ledgerOf();
  decideApproval({ name: 'browser_observe', params: {}, policy: TOOL_MAP.get('browser_observe').policy, ledger });
  decideApproval({ name: 'browser_click', params: {}, policy: TOOL_MAP.get('browser_click').policy, ledger });
  decideApproval({ name: 'browser_evaluate', params: {}, policy: TOOL_MAP.get('browser_evaluate').policy, env: {}, ledger });
  assert.equal(ledger.size(), 1);
});
