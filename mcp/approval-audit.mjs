// mcp/approval-audit.mjs —— 审批分级决策 + 哈希链硬审计（approval receipt ledger）。
//
// 目标（第十一批-C ③：approval 分级与硬审计深化）：
//   mcp/approval-grades.mjs 只回答“这个工具是什么等级”；真实审计还缺三件事：
//     1. 决策记录：某次 tools/call 到底是被策略放行（not-required）、人工确认放行（approved）、
//        环境关闭审批而放行（bypassed），还是被拦下（denied）——要可追溯、不可事后篡改；
//     2. 回执：确认放行的调用应带一张“审批回执”（receipt），客户端/日志可对账；
//     3. 风险评分与升级矩阵：不是所有 destructive 的风险相同（是否 openWorld / 幂等 / 恒审批），
//        高风险工具应升级为“人工复核 + 必须说明理由”，而不是和普通确认混在一起。
//   本模块用「sha256 哈希链」实现 append-only 审批账本：每条记录带 prevHash/hash，
//   任何中间记录被改动都会让链校验失败（verifyApprovalChain）。账本有界（默认 256 条，
//   超出丢弃最旧并保留 anchorHash），因此长跑进程也不会无限增长。
//
// 设计约束：
//   1. 行为零漂移：决策内部直接调用 mcp/tool-policy.mjs 的 approvalGate()，不复制拦截逻辑，
//      因此“denied 时的错误文本/结构”与历史逐字节一致；
//   2. 不落盘：账本只在内存（服务端进程生命周期内），避免把审批记录写到用户磁盘；
//   3. 不泄露参数：只记录 params 的 sha256 摘要（前 32 hex），绝不记录表达式/凭据原文；
//   4. 链可校验：verifyApprovalChain 是纯函数，测试可以喂入被篡改的条目；
//   5. 开关：BB_MCP_APPROVAL_AUDIT=off 时停止记账（强制审批仍然生效），用于极限本地自动化。
//
// 调用点（真实消费）：
//   - mcp/server.mjs：tools/call 每个调用前 decideApproval()（拒绝时回 gate + 审计记录，
//     放行时回执进成功/失败结果 _meta['browser-bridge/approval-receipt']）；
//     tools/list 每个工具的 _meta['browser-bridge/policy'].riskBand/escalation；
//     initialize experimental['browser-bridge/approval-audit']；启动期 assertApprovalAudit()；
//   - 单测 tests/unit/mcp-approval-audit.test.mjs。

import { createHash, randomUUID } from 'node:crypto';
import {
  APPROVAL_ALWAYS,
  APPROVAL_CONFIRMED,
  APPROVAL_META_KEY,
  approvalDisabled,
  approvalEnforced,
  approvalGate,
  policyFor,
} from './tool-policy.mjs';
import {
  APPROVAL_GRADES,
  approvalGradeFor,
  gradeEnforcement,
} from './approval-grades.mjs';

/** 审批决策种类（写进账本，客户端可据此解释“为什么放行/拦截”）。 */
export const APPROVAL_DECISIONS = Object.freeze({
  NOT_REQUIRED: 'not-required',
  APPROVED: 'approved',
  MANDATORY_APPROVED: 'mandatory-approved',
  BYPASSED: 'bypassed',
  DENIED: 'denied',
});

/** 决策原因码（机器可读，不受文本变化影响）。 */
export const APPROVAL_REASON_CODES = Object.freeze({
  NOT_REQUIRED: 'not-required',
  CONFIRMED: 'approved-confirmed',
  MANDATORY: 'approved-mandatory',
  BYPASSED: 'bypassed-not-enforced',
  DENIED_ENFORCED: 'denied-enforced',
  DENIED_MANDATORY: 'denied-mandatory',
});

/** 风险等级。 */
export const APPROVAL_RISK_BANDS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

/** 升级策略。 */
export const APPROVAL_ESCALATIONS = Object.freeze({
  NONE: 'none',
  CONFIRM: 'confirm',
  MANDATORY: 'mandatory',
  MANUAL_REVIEW: 'manual-review',
});

/** 审计账本默认值。 */
export const APPROVAL_AUDIT_LIMITS = Object.freeze({
  maxEntries: 256,
  maxParamsDigestLength: 32,
  maxReasonLength: 200,
  /** 内存中最多保留的“最近决策”条数（与 maxEntries 一致，单独暴露便于文档）。 */
  retention: 256,
});

/** 环境变量。 */
export const APPROVAL_AUDIT_ENV = Object.freeze({
  disable: 'BB_MCP_APPROVAL_AUDIT',
  maxEntries: 'BB_MCP_APPROVAL_AUDIT_MAX',
});

/** 风险评分权重（可解释：每条 factor 都有理由）。 */
export const RISK_WEIGHTS = Object.freeze({
  tierRead: 5,
  tierMutate: 25,
  tierDestructive: 60,
  gradeConfirm: 12,
  gradeMandatory: 25,
  openWorld: 8,
  nonIdempotent: 8,
  always: 15,
});

/** 风险分数 → 等级。 */
export function riskBandOf(score) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  if (value >= 75) return APPROVAL_RISK_BANDS.CRITICAL;
  if (value >= 50) return APPROVAL_RISK_BANDS.HIGH;
  if (value >= 25) return APPROVAL_RISK_BANDS.MEDIUM;
  return APPROVAL_RISK_BANDS.LOW;
}

/**
 * 单工具风险评分（0..100，可解释 factors）。
 * @param {object|null} policy policyFor() 的返回值
 * @param {object|null} [grade] approvalGradeFor() 的返回值（不传则内部派生）
 * @returns null | { tool:string, tier:string, score:number, band:string,
 *                   factors:ReadonlyArray<{code:string,weight:number,reason:string}> }
 */
export function approvalRisk(policy, grade = null) {
  if (!policy || typeof policy !== 'object') return null;
  const resolvedGrade = grade || approvalGradeFor(policy);
  const factors = [];
  const add = (code, weight, reason) => factors.push(Object.freeze({ code, weight, reason }));
  if (policy.tier === 'destructive') add('tier-destructive', RISK_WEIGHTS.tierDestructive, 'destructive 级工具（可能不可逆）');
  else if (policy.tier === 'mutate') add('tier-mutate', RISK_WEIGHTS.tierMutate, 'mutate 级工具（改变页面/状态）');
  else add('tier-read', RISK_WEIGHTS.tierRead, 'read 级工具（只读）');
  if (resolvedGrade && resolvedGrade.grade === APPROVAL_GRADES.MANDATORY) add('grade-mandatory', RISK_WEIGHTS.gradeMandatory, 'mandatory 等级（任何环境都必须确认）');
  else if (resolvedGrade && resolvedGrade.grade === APPROVAL_GRADES.CONFIRM) add('grade-confirm', RISK_WEIGHTS.gradeConfirm, 'confirm 等级（destructive 需确认）');
  if (policy.openWorld) add('open-world', RISK_WEIGHTS.openWorld, 'openWorld：会与外部世界交互，结果不可预测');
  if (!policy.idempotent) add('non-idempotent', RISK_WEIGHTS.nonIdempotent, '非幂等：重试可能重复副作用');
  if (APPROVAL_ALWAYS.includes(policy.name)) add('approval-always', RISK_WEIGHTS.always, 'APPROVAL_ALWAYS：替换/安装本地程序');
  const score = Math.max(0, Math.min(100, factors.reduce((sum, factor) => sum + factor.weight, 0)));
  return Object.freeze({
    tool: policy.name,
    tier: policy.tier,
    score,
    band: riskBandOf(score),
    factors: Object.freeze(factors),
  });
}

/**
 * 升级矩阵：风险等级 + 等级 → 需要哪种确认/复核。
 * @returns {{ escalate:string, requiresReason:boolean, requiresFreshContext:boolean, note:string }}
 */
export function escalationRuleFor(policy, grade = null) {
  const resolvedGrade = grade || (policy ? approvalGradeFor(policy) : null);
  const risk = policy ? approvalRisk(policy, resolvedGrade) : null;
  if (!resolvedGrade || !risk) {
    return Object.freeze({ escalate: APPROVAL_ESCALATIONS.NONE, requiresReason: false, requiresFreshContext: false, note: '无策略信息' });
  }
  if (resolvedGrade.grade === APPROVAL_GRADES.MANDATORY) {
    return Object.freeze({
      escalate: APPROVAL_ESCALATIONS.MANDATORY,
      requiresReason: true,
      requiresFreshContext: true,
      note: '恒审批：必须在 _meta 显式确认，并要求操作者说明理由',
    });
  }
  if (risk.band === APPROVAL_RISK_BANDS.CRITICAL && resolvedGrade.required) {
    return Object.freeze({
      escalate: APPROVAL_ESCALATIONS.MANUAL_REVIEW,
      requiresReason: true,
      requiresFreshContext: true,
      note: '高风险 destructive（openWorld/非幂等）：建议人工复核并说明理由后再确认',
    });
  }
  if (resolvedGrade.required) {
    return Object.freeze({
      escalate: APPROVAL_ESCALATIONS.CONFIRM,
      requiresReason: false,
      requiresFreshContext: false,
      note: 'destructive：按策略确认后放行',
    });
  }
  return Object.freeze({ escalate: APPROVAL_ESCALATIONS.NONE, requiresReason: false, requiresFreshContext: false, note: '无需确认' });
}

/** 稳定 JSON：对象键排序、数组保序、深度/长度有界（用于参数摘要，避免大数据哈希爆炸）。 */
export function canonicalize(value, { depth = 0, maxDepth = 6, maxLength = 4096 } = {}) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > maxLength ? value.slice(0, maxLength) + '…' : value;
  if (typeof value !== 'object') return String(value);
  if (depth >= maxDepth) return '[max-depth]';
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => canonicalize(item, { depth: depth + 1, maxDepth, maxLength }));
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key], { depth: depth + 1, maxDepth, maxLength });
  return output;
}

/**
 * 工具入参摘要：只哈希 params.arguments（不含 approval token 本身），前 32 hex。
 * 绝不记录明文，避免表达式/凭据进审计。
 */
export function paramsDigest(params, { maxLength = APPROVAL_AUDIT_LIMITS.maxParamsDigestLength } = {}) {
  const bag = params && typeof params === 'object' ? params : {};
  const payload = canonicalize(bag.arguments == null ? {} : bag.arguments);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, maxLength);
}

function shortHash(hash) {
  return String(hash || '').slice(0, 16);
}

function digestText(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * 计算单条账本记录的哈希。纯函数：测试可用它构造“被篡改的链”。
 * @param {object} entry
 * @param {string} prevHash
 */
export function hashApprovalEntry(entry, prevHash) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const parts = [
    String(source.seq),
    String(source.at),
    String(source.tool),
    String(source.grade),
    String(source.decision),
    String(source.reasonCode),
    String(source.tier || ''),
    String(source.riskBand || ''),
    String(source.paramsDigest || ''),
    String(source.nonce || ''),
    String(prevHash),
  ];
  return digestText(parts);
}

/**
 * 校验哈希链（纯函数）。
 * @param {ReadonlyArray<object>} entries
 * @param {{anchorHash?:string, allowGaps?:boolean}} [options]
 * @returns {{ ok:boolean, length:number, headHash:string|null,
 *             errors:ReadonlyArray<{index:number,code:string,message:string}> }}
 */
export function verifyApprovalChain(entries, { anchorHash = 'genesis', allowGaps = false } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const errors = [];
  let previousHash = String(anchorHash);
  let previousSeq = null;
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index] || {};
    if (!Number.isInteger(entry.seq)) errors.push(Object.freeze({ index, code: 'approval-seq', message: 'seq 不是整数' }));
    if (previousSeq != null && !allowGaps && entry.seq !== previousSeq + 1) {
      errors.push(Object.freeze({ index, code: 'approval-seq-gap', message: 'seq 不连续：' + previousSeq + ' → ' + entry.seq }));
    }
    if (entry.prevHash !== previousHash) {
      errors.push(Object.freeze({ index, code: 'approval-prev-hash', message: 'prevHash 与上一条 hash 不一致（链断裂或记录被插入/删除）' }));
    }
    const expected = hashApprovalEntry(entry, entry.prevHash);
    if (entry.hash !== expected) {
      errors.push(Object.freeze({ index, code: 'approval-hash', message: 'hash 校验失败（记录被篡改）：期望 ' + shortHash(expected) + ' 实际 ' + shortHash(entry.hash) }));
    }
    previousHash = entry.hash;
    previousSeq = Number.isInteger(entry.seq) ? entry.seq : previousSeq;
  }
  return Object.freeze({
    ok: errors.length === 0,
    length: list.length,
    headHash: list.length ? String(list[list.length - 1].hash || null) : null,
    errors: Object.freeze(errors),
  });
}

function resolveAuditLimits(limit) {
  const requested = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : APPROVAL_AUDIT_LIMITS.maxEntries;
  return Math.max(1, Math.min(requested, 4096));
}

function auditDisabled(env) {
  const value = String((env && env[APPROVAL_AUDIT_ENV.disable]) || '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'disabled';
}

/**
 * 创建 append-only 审批账本（有界哈希链）。
 *
 * @param {{limit?:number, env?:object, now?:()=>number, nonce?:()=>string, log?:Function}} [options]
 */
export function createApprovalLedger({ limit = APPROVAL_AUDIT_LIMITS.maxEntries, env = process.env, now = () => Date.now(), nonce = () => randomUUID(), log = null } = {}) {
  const capacity = resolveAuditLimits(limit);
  const clock = typeof now === 'function' ? now : () => Date.now();
  const nonceOf = typeof nonce === 'function' ? nonce : () => randomUUID();
  const enabled = !auditDisabled(env);
  /** @type {Array<object>} */
  let entries = [];
  let seq = 0;
  let anchorHash = 'genesis';
  const counters = { appended: 0, skipped: 0, trimmed: 0, verify: 0, verifyFailed: 0, receipts: 0, denied: 0 };

  function append({ tool, grade, decision, reasonCode, tier = null, riskBand = null, paramsDigest: digest = null } = {}) {
    if (!enabled) { counters.skipped += 1; return null; }
    seq += 1;
    const at = new Date(clock()).toISOString();
    const entryBase = Object.freeze({
      seq,
      at,
      tool: String(tool || '<unknown>'),
      grade: String(grade || APPROVAL_GRADES.NONE),
      decision: String(decision || APPROVAL_DECISIONS.NOT_REQUIRED),
      reasonCode: String(reasonCode || '').slice(0, APPROVAL_AUDIT_LIMITS.maxReasonLength),
      tier: tier == null ? null : String(tier),
      riskBand: riskBand == null ? null : String(riskBand),
      paramsDigest: digest == null ? null : String(digest),
      nonce: String(nonceOf()),
    });
    // 先按“当前 head”算 hash；prevHash 用 anchorHash 与末条 hash。
    const previous = entries.length ? entries[entries.length - 1].hash : anchorHash;
    const hash = hashApprovalEntry(entryBase, previous);
    const entry = Object.freeze({ ...entryBase, prevHash: previous, hash });
    entries.push(entry);
    counters.appended += 1;
    if (entries.length > capacity) {
      const dropped = entries.slice(0, entries.length - capacity);
      entries = entries.slice(entries.length - capacity);
      anchorHash = dropped[dropped.length - 1].hash;
      counters.trimmed += dropped.length;
    }
    if (decision === APPROVAL_DECISIONS.DENIED) counters.denied += 1;
    return entry;
  }

  function receiptFor(entry) {
    if (!entry) return null;
    counters.receipts += 1;
    return Object.freeze({
      id: 'apr_' + entry.seq + '_' + shortHash(entry.hash),
      seq: entry.seq,
      tool: entry.tool,
      grade: entry.grade,
      decision: entry.decision,
      at: entry.at,
      paramsDigest: entry.paramsDigest,
      hash: entry.hash,
      prevHash: entry.prevHash,
      chain: 'sha256',
      version: 1,
    });
  }

  function list() {
    return Object.freeze(entries.map((entry) => entry));
  }

  function head() {
    return entries.length ? entries[entries.length - 1] : null;
  }

  function verify() {
    counters.verify += 1;
    const report = verifyApprovalChain(entries, { anchorHash });
    if (!report.ok) counters.verifyFailed += 1;
    return report;
  }

  function stats() {
    return Object.freeze({
      enabled,
      size: entries.length,
      capacity,
      seq,
      anchorHash,
      headHash: head() ? head().hash : null,
      counters: Object.freeze({ ...counters }),
    });
  }

  function snapshot() {
    return Object.freeze({
      supported: true,
      enabled,
      size: entries.length,
      capacity,
      seq,
      headHash: head() ? head().hash : null,
      anchorHash,
      counters: Object.freeze({ ...counters }),
      chainAlgorithm: 'sha256',
      retention: 'memory-only',
    });
  }

  return Object.freeze({ append, receiptFor, entries: list, head, verify, stats, snapshot, size: () => entries.length, enabled, capacity });
}

/** 回执校验：回执必须能在账本里找到同 seq 且 hash 一致。 */
export function verifyApprovalReceipt(receipt, ledger) {
  if (!receipt || typeof receipt !== 'object') return Object.freeze({ ok: false, reason: 'missing-receipt' });
  const entries = ledger && typeof ledger.entries === 'function' ? ledger.entries() : (Array.isArray(ledger) ? ledger : []);
  const entry = entries.find((item) => item.seq === receipt.seq);
  if (!entry) return Object.freeze({ ok: false, reason: 'receipt-not-in-ledger' });
  if (entry.hash !== receipt.hash) return Object.freeze({ ok: false, reason: 'hash-mismatch' });
  if (entry.tool !== receipt.tool) return Object.freeze({ ok: false, reason: 'tool-mismatch' });
  return Object.freeze({ ok: true, reason: 'verified', seq: entry.seq });
}

/**
 * 审批决策主入口。
 *
 * - 直接复用 tool-policy.approvalGate 决定是否拦截（行为零漂移）；
 * - 需要审批的调用无论放行/拦截都记账；不回执给被拦下的请求；
 * - 返回 { allowed, decision, gate, grade, risk, escalation, entry, receipt, record }。
 *
 * @param {{name:string, params?:object, policy?:object, env?:object, ledger?:object, tool?:object}} input
 */
export function decideApproval({ name, params = {}, policy = null, env = process.env, ledger = null, tool = null } = {}) {
  const resolvedPolicy = policy || policyFor(name, tool);
  if (!resolvedPolicy) throw new Error('未知 MCP 工具策略：' + name);
  const grade = approvalGradeFor(resolvedPolicy);
  const risk = approvalRisk(resolvedPolicy, grade);
  const escalation = escalationRuleFor(resolvedPolicy, grade);
  // 把已解析的 policy 传给 approvalGate：拦截文本/结构与 tool-policy 单一来源一致，
  // 同时允许调用方只给 policy（审计/测试）而不必构造完整 tool。
  const gate = approvalGate(name, params, { tool, env, policy: resolvedPolicy });
  const confirmed = resolvedPolicy.approvalRequired && gate == null && (
    Boolean(params && params._meta && (params._meta[APPROVAL_META_KEY] === APPROVAL_CONFIRMED || params._meta[APPROVAL_META_KEY] === true))
  );
  let decision;
  let reasonCode;
  if (!resolvedPolicy.approvalRequired) {
    decision = APPROVAL_DECISIONS.NOT_REQUIRED;
    reasonCode = APPROVAL_REASON_CODES.NOT_REQUIRED;
  } else if (gate != null) {
    decision = APPROVAL_DECISIONS.DENIED;
    reasonCode = escalation.escalate === APPROVAL_ESCALATIONS.MANDATORY || resolvedPolicy.approvalAlways
      ? APPROVAL_REASON_CODES.DENIED_MANDATORY
      : APPROVAL_REASON_CODES.DENIED_ENFORCED;
  } else if (confirmed && resolvedPolicy.approvalAlways) {
    decision = APPROVAL_DECISIONS.MANDATORY_APPROVED;
    reasonCode = APPROVAL_REASON_CODES.MANDATORY;
  } else if (confirmed) {
    decision = APPROVAL_DECISIONS.APPROVED;
    reasonCode = APPROVAL_REASON_CODES.CONFIRMED;
  } else {
    decision = APPROVAL_DECISIONS.BYPASSED;
    reasonCode = APPROVAL_REASON_CODES.BYPASSED;
  }
  // 只有“需要审批”的决策进账本（read/mutate 不计噪声）；被拦下的也要记。
  let entry = null;
  let receipt = null;
  if (resolvedPolicy.approvalRequired && ledger && typeof ledger.append === 'function') {
    entry = ledger.append({
      tool: name,
      grade: grade ? grade.grade : null,
      decision,
      reasonCode,
      tier: resolvedPolicy.tier,
      riskBand: risk ? risk.band : null,
      paramsDigest: paramsDigest(params),
    });
    if (entry && (decision === APPROVAL_DECISIONS.APPROVED || decision === APPROVAL_DECISIONS.MANDATORY_APPROVED)) {
      receipt = ledger.receiptFor(entry);
    }
  }
  const record = Object.freeze({
    tool: name,
    grade: grade ? grade.grade : null,
    decision,
    reasonCode,
    enforced: gate != null,
    escalation: escalation.escalate,
    requiresReason: escalation.requiresReason,
    riskBand: risk ? risk.band : null,
    riskScore: risk ? risk.score : null,
    receiptId: receipt ? receipt.id : null,
    ledgerSeq: entry ? entry.seq : null,
    chainHead: entry ? entry.hash : null,
    confirmed,
  });
  return Object.freeze({
    allowed: gate == null,
    decision,
    reasonCode,
    gate,
    grade,
    risk,
    escalation,
    entry,
    receipt,
    record,
  });
}

/**
 * 审批硬审计（启动期）：风险评分/升级矩阵/账本能力自洽。
 * @returns {{ ok:boolean, errors:Array<{code:string,tool:string,message:string}>, stats:object }}
 */
export function auditApprovalAudit(tools) {
  const errors = [];
  const push = (code, tool, message) => errors.push(Object.freeze({ code, tool: String(tool || '<none>'), message }));
  const list = Array.isArray(tools) ? tools : [];
  if (!list.length) push('approval-audit-shape', '<none>', '没有可审计的工具');
  const bands = { low: 0, medium: 0, high: 0, critical: 0 };
  const escalations = { none: 0, confirm: 0, 'manual-review': 0, mandatory: 0 };
  for (const tool of list) {
    const policy = tool && tool.policy;
    const name = tool && tool.name;
    if (!policy) { push('approval-audit-policy', name, '工具缺少 policy'); continue; }
    const grade = approvalGradeFor(policy);
    const risk = approvalRisk(policy, grade);
    if (!grade || !risk) { push('approval-audit-derive', name, '无法派生等级/风险'); continue; }
    if (!Object.values(APPROVAL_RISK_BANDS).includes(risk.band)) push('approval-audit-band', name, '未知风险等级：' + risk.band);
    if (risk.score < 0 || risk.score > 100) push('approval-audit-score', name, '风险分越界：' + risk.score);
    if (risk.band !== riskBandOf(risk.score)) push('approval-audit-band', name, '风险等级与分数不一致');
    bands[risk.band] += 1;
    const escalation = escalationRuleFor(policy, grade);
    if (!Object.values(APPROVAL_ESCALATIONS).includes(escalation.escalate)) push('approval-audit-escalation', name, '未知升级策略：' + escalation.escalate);
    escalations[escalation.escalate] += 1;
    if (grade.mandatory && escalation.escalate !== APPROVAL_ESCALATIONS.MANDATORY) {
      push('approval-audit-mandatory', name, 'mandatory 工具必须升级为 mandatory');
    }
    if (policy.tier === 'destructive' && grade.grade === APPROVAL_GRADES.NONE) {
      push('approval-audit-destructive', name, 'destructive 工具不能是 none 级');
    }
    if (grade.required && !grade.reason) push('approval-audit-reason', name, '需要审批的工具缺可解释理由');
    if (escalation.requiresReason && !escalation.requiresFreshContext) {
      push('approval-audit-escalation', name, '需要理由的升级策略也应要求新鲜上下文');
    }
  }
  for (const name of APPROVAL_ALWAYS) {
    const tool = list.find((item) => item && item.name === name);
    if (!tool) push('approval-audit-always-missing', name, 'APPROVAL_ALWAYS 工具不在工具表里');
    else {
      const escalation = escalationRuleFor(tool.policy, approvalGradeFor(tool.policy));
      if (escalation.escalate !== APPROVAL_ESCALATIONS.MANDATORY) push('approval-audit-always', name, 'APPROVAL_ALWAYS 工具必须是 mandatory 升级');
    }
  }
  // 决策逻辑自检：read 工具永远 allowed/not-required；mandatory 未确认永远 denied。
  const readTool = list.find((tool) => tool && tool.policy && tool.policy.tier === 'read');
  if (readTool) {
    const decision = decideApproval({ name: readTool.name, params: {}, policy: readTool.policy, env: { BB_MCP_APPROVAL: 'strict' } });
    if (!decision.allowed || decision.decision !== APPROVAL_DECISIONS.NOT_REQUIRED) {
      push('approval-audit-read', readTool.name, 'read 工具决策不是 not-required/allowed：' + JSON.stringify(decision.decision));
    }
  }
  const alwaysTool = list.find((tool) => tool && APPROVAL_ALWAYS.includes(tool.name));
  if (alwaysTool) {
    const denied = decideApproval({ name: alwaysTool.name, params: {}, policy: alwaysTool.policy, env: {} });
    if (denied.allowed || denied.decision !== APPROVAL_DECISIONS.DENIED) {
      push('approval-audit-mandatory-deny', alwaysTool.name, 'mandatory 工具未确认时没有拦截：' + JSON.stringify(denied.decision));
    }
    const approved = decideApproval({ name: alwaysTool.name, params: { _meta: { [APPROVAL_META_KEY]: APPROVAL_CONFIRMED } }, policy: alwaysTool.policy, env: {} });
    if (!approved.allowed || approved.decision !== APPROVAL_DECISIONS.MANDATORY_APPROVED) {
      push('approval-audit-mandatory-approve', alwaysTool.name, 'mandatory 工具确认后没有给出 mandatory-approved：' + JSON.stringify(approved.decision));
    }
  }
  // 账本链自检：3 条记录 + 篡改检测。
  const ledger = createApprovalLedger({ limit: 16, env: {}, now: () => 1_700_000_000_000, nonce: (() => { let index = 0; return () => 'n-' + (index += 1); })() });
  for (let index = 0; index < 3; index += 1) ledger.append({ tool: 'unit-tool-' + index, grade: 'confirm', decision: APPROVAL_DECISIONS.APPROVED, reasonCode: APPROVAL_REASON_CODES.CONFIRMED, tier: 'destructive', riskBand: 'high' });
  const chain = ledger.verify();
  if (!chain.ok || chain.length !== 3) push('approval-audit-chain', '<ledger>', '账本链自检失败：' + JSON.stringify(chain.errors));
  const tampered = ledger.entries().map((entry) => (entry.seq === 2 ? { ...entry, decision: APPROVAL_DECISIONS.BYPASSED } : entry));
  if (verifyApprovalChain(tampered, { anchorHash: 'genesis' }).ok) push('approval-audit-tamper', '<ledger>', '被篡改的账本没有被检测出来');

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    stats: Object.freeze({
      tools: list.length,
      bands: Object.freeze(bands),
      escalations: Object.freeze(escalations),
      ledger: ledger.stats(),
      limits: APPROVAL_AUDIT_LIMITS,
    }),
  });
}

/** strict 包装：审批审计自检/矩阵漂移时启动即失败。 */
export function assertApprovalAudit(tools) {
  const report = auditApprovalAudit(tools);
  if (!report.ok) {
    throw new Error('MCP 审批硬审计失败：\n' + report.errors.map((error) => error.code + ' ' + error.tool + ' ' + error.message).join('\n'));
  }
  return report;
}

/**
 * 审批硬审计能力快照（initialize experimental['browser-bridge/approval-audit']）。
 * @param {Array<object>} tools
 * @param {{env?:object, ledger?:object}} [options]
 */
export function approvalAuditSnapshot(tools, { env = process.env, ledger = null } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const rows = list.map((tool) => {
    const grade = approvalGradeFor(tool && tool.policy);
    const risk = approvalRisk(tool && tool.policy, grade);
    const escalation = escalationRuleFor(tool && tool.policy, grade);
    return Object.freeze({
      name: tool && tool.name,
      grade: grade ? grade.grade : null,
      riskBand: risk ? risk.band : null,
      riskScore: risk ? risk.score : null,
      escalation: escalation.escalate,
    });
  });
  const ledgerStats = ledger && typeof ledger.stats === 'function' ? ledger.stats() : null;
  return Object.freeze({
    supported: true,
    decisions: APPROVAL_DECISIONS,
    reasonCodes: APPROVAL_REASON_CODES,
    riskBands: APPROVAL_RISK_BANDS,
    escalations: APPROVAL_ESCALATIONS,
    limits: APPROVAL_AUDIT_LIMITS,
    envVariable: APPROVAL_AUDIT_ENV.disable,
    enabled: ledgerStats ? ledgerStats.enabled : !auditDisabled(env),
    ledger: ledgerStats ? Object.freeze({
      enabled: ledgerStats.enabled,
      size: ledgerStats.size,
      capacity: ledgerStats.capacity,
      headHash: ledgerStats.headHash,
      chainAlgorithm: 'sha256',
      retention: 'memory-only',
    }) : null,
    receipt: Object.freeze({
      metaKey: 'browser-bridge/approval-receipt',
      idPrefix: 'apr_',
      verifiable: true,
      fields: Object.freeze(['id', 'seq', 'tool', 'grade', 'decision', 'at', 'paramsDigest', 'hash', 'prevHash']),
    }),
    audit: Object.freeze({
      metaKey: 'browser-bridge/approval-audit',
      fields: Object.freeze(['decision', 'reasonCode', 'enforced', 'escalation', 'riskBand', 'ledgerSeq', 'chainHead']),
    }),
    tools: Object.freeze(rows),
    byBand: Object.freeze(rows.reduce((bag, row) => {
      if (row.riskBand) bag[row.riskBand] = (bag[row.riskBand] || 0) + 1;
      return bag;
    }, {})),
    byEscalation: Object.freeze(rows.reduce((bag, row) => {
      bag[row.escalation] = (bag[row.escalation] || 0) + 1;
      return bag;
    }, {})),
  });
}
