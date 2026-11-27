// extension/src/lib/replay-explain.js —— 回放失败的“可解释”层（纯函数，零 chrome 依赖）。
//
// 回放失败时调用方最需要三件事：这属于哪一类问题、能不能重试、下一步该做什么。
// 本模块把 boundary / target / diff / plan / network / verify / runtime 各层的错误码
// 收敛成一张稳定的目录（REPLAY_ERROR_CODES），并负责：
//   - classifyReplayError：未知异常（含 chrome/CDP 文案）→ 目录码，绝不抛异常；
//   - explainFailure：单条失败 → {code, category, severity, retriable, needsHuman,
//     sideEffectPossible, title, detail, hint, remediation, causeChain, evidence, signature}；
//   - explainPlanBlockers：计划阻断项批量解释（对齐 preflightReplay 的 PROGRAM_CODES）；
//   - buildFailureReport / formatFailureReport：整批失败的根因、风险与建议（稳定排序）；
//   - redactMessage：失败文案里的 token/cookie/密码/邮箱脱敏（确定性替换）。
//
// 设计约束：
//   - 纯函数：无时钟/随机数/chrome；同一失败必得同一解释与签名；
//   - 只读：不改 error/step/outcome 入参，不触发任何重试；
//   - 输出有界：文案/证据/建议都有条数或长度上限，避免把整段录制塞进 RPC。

import { stableHash } from '../record-steps.js';

/** 解释层版本。 */
export const REPLAY_EXPLAIN_VERSION = 1;
import { EXPLAIN_LIMITS, REPLAY_ERROR_CODES, canonicalCode, getErrorEntry, catalogCodes, catalogByCategory } from './replay-explain-catalog.js';
export { EXPLAIN_LIMITS, REPLAY_ERROR_CODES, canonicalCode, getErrorEntry, catalogCodes, catalogByCategory };

/** 失败大类：决定报告分组与“是否值得自动重试”。 */
export const FAILURE_CATEGORIES = Object.freeze([
  'boundary',
  'target',
  'diff',
  'plan',
  'network',
  'verify',
  'runtime',
  'human',
  'internal',
]);

// ---------------------------------------------------------------------------

const REDACTION_RULES = Object.freeze([
  [/authorization\s*[:=]\s*(?:bearer|basic|token)?\s*[^\s,;"']+/gi, 'Authorization: [redacted]'],
  [/\b(?:set-)?cookie\s*[:=]\s*[^;\n]+/gi, 'Cookie: [redacted]'],
  [/\b([a-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|otp|session[_-]?id|auth)[a-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s&,;"'}]+)/gi, '$1=[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[redacted-token]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-hex]'],
  [/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '***@$1'],
]);

/**
 * 失败文案脱敏：token/cookie/密码/JWT/长 hex/邮箱都被替换；确定性（同一输入同一输出）。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function redactMessage(value, max = EXPLAIN_LIMITS.maxText) {
  let text = value === null || value === undefined ? '' : String(value);
  for (const [pattern, replacement] of REDACTION_RULES) text = text.replace(pattern, replacement);
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : EXPLAIN_LIMITS.maxText;
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

/** 文案启发式：未知异常 → 目录码（顺序即优先级，必须稳定）。 */
const MESSAGE_RULES = Object.freeze([
  [/cancel|abort|leaving page/i, 'REPLAY_CANCELLED'],
  [/timeout|timed out|超时/i, 'REPLAY_TIMEOUT'],
  [/not found|no such|找不到|missing element/i, 'TARGET_NOT_FOUND'],
  [/ambiguous|multiple|多个|不唯一/i, 'TARGET_AMBIGUOUS'],
  [/document|navigat|导航|documentId/i, 'BOUNDARY_DOCUMENT_CHANGED'],
  [/frame|iframe|帧/i, 'BOUNDARY_FRAME_CHANGED'],
  [/redact|脱敏|placeholder/i, 'NETWORK_REPLAY_REDACTED'],
  [/origin|cors|跨源/i, 'NETWORK_REPLAY_CROSS_ORIGIN'],
  [/url|地址/i, 'NETWORK_REPLAY_BAD_URL'],
  [/method|方法/i, 'NETWORK_REPLAY_BAD_METHOD'],
  [/tabid|tab 切换|tab is not/i, 'BOUNDARY_TAB_MISSING'],
  [/not allowed|不允许|denied|forbidden/i, 'PLAN_INVALID_INPUT'],
  [/unknown|undefined is not|typeerror|internal/i, 'REPLAY_INTERNAL'],
]);

/**
 * 把任意异常收敛成目录项。永不抛异常；原始 message/code 保留在 evidence 里。
 * @param {unknown} error
 * @param {{context?:object, fallbackCode?:string}} [options]
 * @returns {object}
 */
export function classifyReplayError(error, options = {}) {
  const context = options.context && typeof options.context === 'object' ? options.context : {};
  const originalCode = String((error && (error.code || error.name)) || '');
  const message = String((error && (error.message || error.reason)) || error || '');
  const direct = canonicalCode(originalCode);
  let code = REPLAY_ERROR_CODES[direct] ? direct : '';
  if (!code) {
    for (const [pattern, candidate] of MESSAGE_RULES) {
      if (pattern.test(message)) { code = candidate; break; }
    }
  }
  if (!code) code = options.fallbackCode && REPLAY_ERROR_CODES[options.fallbackCode] ? options.fallbackCode : 'REPLAY_INTERNAL';
  const entry = REPLAY_ERROR_CODES[code];
  return {
    code,
    category: entry.category,
    originalCode: originalCode.slice(0, 80),
    message: redactMessage(message),
    matchedBy: direct && REPLAY_ERROR_CODES[direct] ? 'code' : code === options.fallbackCode ? 'fallback' : 'message',
    context: {
      stepIndex: Number.isInteger(context.stepIndex) ? context.stepIndex : -1,
      ref: String(context.ref || '').slice(0, 80),
      method: String(context.method || '').slice(0, 80),
    },
  };
}

// ---------------------------------------------------------------------------
// 单条解释
// ---------------------------------------------------------------------------

/** 归一化失败输入（显式 code > error > outcome > 上下文）。 */
function resolveFailureCode(input) {
  const explicit = canonicalCode(input && input.code);
  if (explicit && REPLAY_ERROR_CODES[explicit]) return explicit;
  if (input && input.error) return classifyReplayError(input.error, { context: input.context }).code;
  const outcomeCode = canonicalCode(input && input.outcome && input.outcome.code);
  if (outcomeCode && REPLAY_ERROR_CODES[outcomeCode]) return outcomeCode;
  const targetCode = canonicalCode(input && input.target && input.target.reasonCode);
  if (targetCode && REPLAY_ERROR_CODES[targetCode]) return targetCode;
  const boundaryCode = canonicalCode(input && input.boundary && input.boundary.code);
  if (boundaryCode && REPLAY_ERROR_CODES[boundaryCode]) return boundaryCode;
  const stepCode = canonicalCode(input && input.step && input.step.code);
  if (stepCode && REPLAY_ERROR_CODES[stepCode]) return stepCode;
  return 'REPLAY_INTERNAL';
}

/** 从上下文推断是否需要人工/是否可能已产生副作用（覆盖目录默认值）。 */
function contextFlags(entry, input) {
  const flags = {
    retriable: entry.retriable,
    needsHuman: entry.needsHuman,
    sideEffectPossible: entry.sideEffectPossible,
  };
  const step = input && input.step;
  if (step && (step.humanGate || step.kind === 'human')) flags.needsHuman = true;
  const plan = input && input.plan;
  if (plan && plan.budget && plan.budget.actions > 0 && step && step.idempotent === false) {
    flags.sideEffectPossible = true;
  }
  const outcome = input && input.outcome;
  if (outcome && outcome.completed === true && step && step.idempotent === false) flags.sideEffectPossible = true;
  if (outcome && outcome.severity === 'warning') flags.retriable = true;
  return flags;
}

/** 把上下文压成有界证据（全部经过脱敏）。 */
function buildEvidence(input) {
  const evidence = {};
  const step = input && input.step;
  if (step && typeof step === 'object') {
    evidence.step = {
      index: Number.isInteger(step.index) ? step.index : -1,
      ref: String(step.ref || '').slice(0, 80),
      kind: String(step.kind || '').slice(0, 40),
      method: String(step.method || '').slice(0, 80),
      idempotent: step.idempotent === true,
    };
  }
  const boundary = input && input.boundary;
  if (boundary && typeof boundary === 'object') {
    evidence.boundary = {
      relation: String(boundary.relation || '').slice(0, 40),
      reason: String(boundary.reason || '').slice(0, 120),
      documentChanged: boundary.documentChanged === true,
      frameChanged: boundary.frameChanged === true,
      revisionChanged: boundary.revisionChanged === true,
    };
  }
  const target = input && input.target;
  if (target && typeof target === 'object') {
    evidence.target = {
      status: String(target.status || '').slice(0, 40),
      reasonCode: String(target.reasonCode || '').slice(0, 80),
      strategy: String(target.strategy || '').slice(0, 40),
      alternatives: Array.isArray(target.alternatives) ? target.alternatives.length : 0,
    };
  }
  const outcome = input && input.outcome;
  if (outcome && typeof outcome === 'object') {
    evidence.outcome = {
      severity: String(outcome.severity || '').slice(0, 20),
      code: String(outcome.code || '').slice(0, 80),
      failed: Number.isInteger(outcome.summary && outcome.summary.failed) ? outcome.summary.failed : 0,
      checked: Number.isInteger(outcome.summary && outcome.summary.checked) ? outcome.summary.checked : 0,
    };
    const diffs = Array.isArray(outcome.differences) ? outcome.differences.slice(0, 4) : [];
    if (diffs.length) {
      evidence.differences = diffs.map((diff) => ({
        path: String(diff && diff.path || '').slice(0, 80),
        kind: String(diff && diff.kind || '').slice(0, 20),
        expected: redactMessage(diff && diff.expected, 80),
        actual: redactMessage(diff && diff.actual, 80),
      }));
    }
  }
  const error = input && input.error;
  if (error) evidence.error = redactMessage(error.message || error, EXPLAIN_LIMITS.maxDetail);
  if (input && input.detail) evidence.detail = redactMessage(input.detail, EXPLAIN_LIMITS.maxDetail);
  return evidence;
}

/** 依据失败上下文补充建议（去重、截断）。 */
function contextualRemediation(entry, input) {
  const remediation = entry.remediation.slice();
  const target = input && input.target;
  if (target && target.strategy === 'selector' && target.reasonCode === 'TARGET_AMBIGUOUS') {
    remediation.push('selector 命中多个元素：改用 role+name 或 data-testid 收敛');
  }
  if (target && target.status === 'planned') {
    remediation.push('当前只是静态候选：执行前需要真实快照验证');
  }
  const boundary = input && input.boundary;
  if (boundary && boundary.documentChanged === true) {
    remediation.push('用 plan.boundaries 的 navigate 动作回到录制 URL，而不是手动点回');
  }
  if (boundary && boundary.frameChanged === true) {
    remediation.push('按录制帧切换后重新采样该帧快照');
  }
  if (input && input.outcome && input.outcome.observation && input.outcome.observation.changed) {
    remediation.push('查看 observation.hunks 判断变化是否由本步动作引起');
  }
  const seen = new Set();
  const out = [];
  for (const item of remediation) {
    const text = String(item || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text.slice(0, 200));
    if (out.length >= EXPLAIN_LIMITS.maxRemediation) break;
  }
  return out;
}

/** 失败签名：code + step index/ref + 证据关键位（稳定哈希）。 */
export function failureSignature(failure) {
  const item = failure && typeof failure === 'object' ? failure : {};
  const step = item.step && typeof item.step === 'object' ? item.step : {};
  const evidence = item.evidence && typeof item.evidence === 'object' ? item.evidence : {};
  return stableHash([
    item.code || '',
    step.index === undefined ? -1 : step.index,
    step.ref || '',
    item.category || '',
    evidence.target && evidence.target.status || '',
    evidence.boundary && evidence.boundary.relation || '',
  ].join('|'));
}

/**
 * 解释一条失败（单条失败的主入口）。
 * @param {object} input {code?, error?, step?, outcome?, boundary?, target?, plan?, detail?, context?}
 * @returns {object} 固定形状的解释对象（有界、脱敏、确定性）
 */
export function explainFailure(input = {}) {
  const code = resolveFailureCode(input);
  const entry = REPLAY_ERROR_CODES[code] || REPLAY_ERROR_CODES.REPLAY_INTERNAL;
  const flags = contextFlags(entry, input);
  const evidence = buildEvidence(input);
  const remediation = contextualRemediation(entry, input);
  const step = input && input.step;
  const causeChain = [];
  causeChain.push({ layer: 'replay', code, category: entry.category });
  if (evidence.boundary) causeChain.push({ layer: 'boundary', relation: evidence.boundary.relation });
  if (evidence.target) causeChain.push({ layer: 'target', status: evidence.target.status, reason: evidence.target.reasonCode });
  if (input && input.outcome && input.outcome.code) causeChain.push({ layer: 'diff', code: input.outcome.code });
  if (evidence.error) causeChain.push({ layer: 'error', message: evidence.error });
  const explanation = {
    version: REPLAY_EXPLAIN_VERSION,
    ok: false,
    code,
    category: entry.category,
    severity: entry.severity,
    title: entry.title,
    detail: entry.detail,
    hint: entry.hint,
    retriable: flags.retriable,
    needsHuman: flags.needsHuman,
    sideEffectPossible: flags.sideEffectPossible,
    step: step && typeof step === 'object'
      ? {
        index: Number.isInteger(step.index) ? step.index : -1,
        ref: String(step.ref || '').slice(0, 80),
        kind: String(step.kind || '').slice(0, 40),
        method: String(step.method || '').slice(0, 80),
      }
      : null,
    causeChain: causeChain.slice(0, 8),
    remediation,
    evidence,
  };
  explanation.signature = failureSignature(explanation);
  return explanation;
}

// ---------------------------------------------------------------------------
// 各层专用解释
// ---------------------------------------------------------------------------

/** 边界比较结果 → 解释（relation 直接映射目录码）。 */
export function explainBoundaryComparison(comparison, step) {
  const relation = String(comparison && (comparison.relation || comparison.reason) || '');
  const mapping = {
    'document-changed': 'BOUNDARY_DOCUMENT_CHANGED',
    'frame-changed': 'BOUNDARY_FRAME_CHANGED',
    'revision-changed': 'BOUNDARY_REVISION_CHANGED',
    'url-changed': 'BOUNDARY_URL_CHANGED',
    'missing-boundary': 'BOUNDARY_MISSING',
    'tab-changed': 'BOUNDARY_TAB_MISSING',
  };
  return explainFailure({
    code: mapping[relation] || 'BOUNDARY_MISSING',
    boundary: comparison,
    step,
    detail: comparison && comparison.detail,
  });
}

/** 目标还原结果 → 解释。 */
export function explainTargetFailure(targetStep, step) {
  const status = String(targetStep && targetStep.status || '');
  const mapping = {
    ambiguous: 'TARGET_AMBIGUOUS',
    missing: 'TARGET_MISSING_SNAPSHOT_PLACEHOLDER',
    forbidden: 'TARGET_ANONYMOUS',
    planned: 'TARGET_NO_SNAPSHOT',
    'stale-document': 'TARGET_STALE_DOCUMENT',
  };
  let code = mapping[status] || 'TARGET_NOT_FOUND';
  if (code === 'TARGET_MISSING_SNAPSHOT_PLACEHOLDER') code = 'TARGET_NOT_FOUND';
  const reasonCode = String(targetStep && targetStep.reasonCode || '');
  if (reasonCode === 'TARGET_ONLY_HIDDEN') code = 'TARGET_ONLY_HIDDEN';
  if (reasonCode === 'TARGET_NO_SNAPSHOT') code = 'TARGET_NO_SNAPSHOT';
  if (reasonCode === 'TARGET_EMPTY_SNAPSHOT') code = 'TARGET_EMPTY_SNAPSHOT';
  if (reasonCode === 'TARGET_NO_MATCH') code = 'TARGET_NOT_FOUND';
  if (reasonCode === 'TARGET_AMBIGUOUS') code = 'TARGET_AMBIGUOUS';
  if (reasonCode === 'TARGET_ANONYMOUS') code = 'TARGET_ANONYMOUS';
  if (step && (step.humanGate || step.kind === 'human')) code = 'TARGET_HUMAN_REQUIRED';
  return explainFailure({ code, target: targetStep, step });
}

/** 单步判决 → 解释。 */
export function explainDiffVerdict(verdict, step) {
  if (verdict && verdict.ok === true) {
    return explainFailure({ code: verdict.severity === 'warning' ? 'DIFF_UNSUPPORTED_EXPECTATION' : 'REPLAY_NOT_ATTEMPTED', outcome: verdict, step });
  }
  if (verdict && verdict.ok === false && verdict.code === 'DIFF_MISSING_ACTUAL') {
    return explainFailure({ code: 'DIFF_MISSING_ACTUAL', outcome: verdict, step });
  }
  return explainFailure({ code: 'DIFF_EXPECTATION_FAILED', outcome: verdict, step });
}

/**
 * 单步执行结果 → 解释（失败才返回非 null；成功返回 null，方便调用方只挂失败字段）。
 * @param {object} step
 * @param {object} outcome validateStepOutcome 的结果
 * @param {object} [context] {boundary, target, plan}
 */
export function explainOutcome(step, outcome, context = {}) {
  const verdict = outcome && typeof outcome === 'object' ? outcome : null;
  if (!verdict) return explainFailure({ code: 'DIFF_MISSING_ACTUAL', step, ...context });
  if (verdict.ok === true && verdict.severity !== 'warning') return null;
  let code = canonicalCode(verdict.code);
  if (!REPLAY_ERROR_CODES[code]) {
    const failedCheck = Array.isArray(verdict.checks) ? verdict.checks.find((check) => check && check.severity === 'fail') : null;
    code = canonicalCode(failedCheck && failedCheck.code) || 'DIFF_EXPECTATION_FAILED';
  }
  if (!REPLAY_ERROR_CODES[code]) code = 'DIFF_EXPECTATION_FAILED';
  return explainFailure({ code, outcome: verdict, step, ...context });
}

/**
 * 计划阻断项批量解释（对齐 preflightReplay().blockers 的 {code,index,message}）。
 * @param {Array<object>} blockers
 * @param {object} [plan]
 * @returns {Array<object>}
 */
export function explainPlanBlockers(blockers, plan) {
  const list = Array.isArray(blockers) ? blockers.slice(0, 32) : [];
  const out = [];
  for (const blocker of list) {
    if (!blocker || typeof blocker !== 'object') continue;
    const code = canonicalCode(blocker.code) || 'PLAN_BLOCKED';
    const step = plan && Array.isArray(plan.steps) && Number.isInteger(blocker.index) ? plan.steps[blocker.index] : null;
    out.push(explainFailure({
      code: REPLAY_ERROR_CODES[code] ? code : 'PLAN_BLOCKED',
      step,
      detail: blocker.message || blocker.detail || '',
      plan,
      outcome: blocker.source === 'diff' ? blocker : null,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 批量报告
// ---------------------------------------------------------------------------

/** 按码分组（稳定排序）。 */
export function groupFailures(failures) {
  const list = Array.isArray(failures) ? failures : [];
  const groups = new Map();
  for (const failure of list) {
    if (!failure || typeof failure !== 'object') continue;
    const code = String(failure.code || 'REPLAY_INTERNAL');
    if (!groups.has(code)) {
      groups.set(code, { code, category: failure.category || 'internal', count: 0, firstIndex: -1, firstRef: '', retriable: false, needsHuman: false, sideEffectPossible: false, signatures: [] });
    }
    const group = groups.get(code);
    group.count += 1;
    if (group.firstIndex < 0 && failure.step && Number.isInteger(failure.step.index)) group.firstIndex = failure.step.index;
    if (!group.firstRef && failure.step && failure.step.ref) group.firstRef = failure.step.ref;
    group.retriable = group.retriable || failure.retriable === true;
    group.needsHuman = group.needsHuman || failure.needsHuman === true;
    group.sideEffectPossible = group.sideEffectPossible || failure.sideEffectPossible === true;
    if (failure.signature && group.signatures.length < 8) group.signatures.push(failure.signature);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

/** 任意失败集合里是否有“可能已产生副作用”的项。 */
export function hasSideEffectRisk(failures) {
  return (Array.isArray(failures) ? failures : []).some((failure) => failure && failure.sideEffectPossible === true);
}

/** 任意失败是否可自动重试（全部可重试且不涉及人工/副作用才算 true）。 */
export function isRetriable(failures) {
  const list = Array.isArray(failures) ? failures : [];
  if (!list.length) return false;
  return list.every((failure) => failure && failure.retriable === true && failure.needsHuman !== true);
}

/** 取“最该先看”的失败：副作用风险 > 人工 > fail severity > 首个。 */
function rootCauseOf(failures) {
  const list = Array.isArray(failures) ? failures : [];
  if (!list.length) return null;
  const score = (failure) => {
    let value = 0;
    if (failure.sideEffectPossible) value += 100;
    if (failure.needsHuman) value += 50;
    if (failure.severity === 'fail') value += 10;
    if (failure.severity === 'warning') value += 1;
    return value;
  };
  let best = list[0];
  for (const failure of list) {
    if (score(failure) > score(best)) best = failure;
  }
  return best;
}

/**
 * 批量失败报告。
 * @param {Array<object>} failures explainFailure 的输出
 * @param {{plan?:object, limit?:number}} [options]
 */
export function buildFailureReport(failuresIn, options = {}) {
  const failures = (Array.isArray(failuresIn) ? failuresIn : []).filter(Boolean).slice(0, EXPLAIN_LIMITS.maxFailures);
  const groups = groupFailures(failures);
  const rootCause = rootCauseOf(failures);
  const byCategory = {};
  for (const failure of failures) {
    const category = failure.category || 'internal';
    byCategory[category] = (byCategory[category] || 0) + 1;
  }
  const remediation = [];
  const seen = new Set();
  for (const failure of failures) {
    for (const item of Array.isArray(failure.remediation) ? failure.remediation : []) {
      if (seen.has(item)) continue;
      seen.add(item);
      remediation.push(item);
      if (remediation.length >= EXPLAIN_LIMITS.maxRemediation) break;
    }
    if (remediation.length >= EXPLAIN_LIMITS.maxRemediation) break;
  }
  const report = {
    version: REPLAY_EXPLAIN_VERSION,
    ok: failures.length === 0,
    total: failures.length,
    byCategory,
    byCode: Object.fromEntries(groups.map((group) => [group.code, group.count])),
    groups,
    rootCause,
    firstFailure: failures[0] || null,
    sideEffectAtRisk: hasSideEffectRisk(failures),
    retriable: isRetriable(failures),
    needsHuman: failures.some((failure) => failure.needsHuman === true),
    remediation,
    planToken: options.plan && options.plan.token ? String(options.plan.token) : '',
    signatures: failures.map((failure) => failure.signature).filter(Boolean).slice(0, 16),
  };
  report.signature = stableHash([report.planToken, ...report.signatures, ...groups.map((group) => group.code + ':' + group.count)].join('|'));
  return report;
}

/** 把报告渲染成中文多行文本（日志/CLI 展示用；有界）。 */
export function formatFailureReport(report, options = {}) {
  if (!report || typeof report !== 'object') return '回放失败：无报告';
  const lines = [];
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : EXPLAIN_LIMITS.maxReportLines;
  lines.push('回放失败 ' + report.total + ' 处' + (report.planToken ? '（plan ' + report.planToken + '）' : ''));
  if (report.sideEffectAtRisk) lines.push('⚠ 失败点可能已产生副作用：重试前先对账页面/服务端状态');
  if (report.needsHuman) lines.push('需要人工介入（human-gate/敏感输入）');
  if (report.rootCause) {
    lines.push('根因候选：[' + report.rootCause.code + '] ' + report.rootCause.title);
  }
  for (const group of report.groups.slice(0, 8)) {
    lines.push('- [' + group.code + '] ×' + group.count + ' ' + (group.category || '') + (group.firstIndex >= 0 ? '（首个 step #' + group.firstIndex + '）' : ''));
  }
  if (report.remediation.length) {
    lines.push('建议：');
    for (const item of report.remediation.slice(0, 5)) lines.push('  · ' + item);
  }
  return lines.slice(0, maxLines).join('\n');
}

/** 紧凑的失败字段（挂到 RPC 输出用）。 */
export function summarizeFailure(failure) {
  if (!failure || typeof failure !== 'object') return null;
  return {
    code: failure.code || 'REPLAY_INTERNAL',
    category: failure.category || 'internal',
    title: String(failure.title || '').slice(0, 160),
    hint: String(failure.hint || '').slice(0, 200),
    retriable: failure.retriable === true,
    needsHuman: failure.needsHuman === true,
    sideEffectPossible: failure.sideEffectPossible === true,
    stepIndex: failure.step && Number.isInteger(failure.step.index) ? failure.step.index : -1,
    ref: failure.step ? String(failure.step.ref || '').slice(0, 80) : '',
    remediation: Array.isArray(failure.remediation) ? failure.remediation.slice(0, 3) : [],
    signature: String(failure.signature || ''),
  };
}

/** 紧凑报告（挂到 RPC/导出用；不含完整证据）。 */
export function summarizeFailureReport(report) {
  if (!report || typeof report !== 'object') return null;
  return {
    ok: report.ok === true,
    total: report.total || 0,
    byCategory: report.byCategory || {},
    byCode: report.byCode || {},
    rootCause: report.rootCause ? summarizeFailure(report.rootCause) : null,
    sideEffectAtRisk: report.sideEffectAtRisk === true,
    retriable: report.retriable === true,
    needsHuman: report.needsHuman === true,
    remediation: (report.remediation || []).slice(0, 5),
    planToken: report.planToken || '',
    signature: report.signature || '',
  };
}
