// extension/src/lib/replay-verify.js —— 回放计划/执行的自检与报告（纯函数，零 chrome 依赖）。
//
// “回放跑完了”不等于“回放是对的”。本模块在三个时点做自检：
//   1) 执行前 verifyPlan：计划结构、token/指纹、时间线、检查点、human 顺序、
//      边界还原动作、目标可还原性、预算；
//   2) 执行后 verifyOutcomes：覆盖（缺步/多步/重复）、顺序、单步判决（replay-diff）；
//   3) 收尾 verifyReplay：计划 + 结果 + 与录制程序的覆盖对照 + 确定性复核，
//      汇总成 {ok, grade, checks, failures, summary, checksum} 并渲染中文报告。
// 另外提供 verifyDeterminism（同输入两次构建必须同指纹）与 resumePointFrom
// （从已完成步骤推恢复检查点），供断点续跑使用。
//
// 设计约束：
//   - 纯函数：不读时钟/不访问 chrome；同输入同输出；
//   - 只返回证据，不抛异常（调用方处理失败）；
//   - 报告有界（checks/failures/文本行数都有上限）。

import { stableHash } from '../record-steps.js';
import {
  DEFAULT_PLAN_LIMITS,
  buildReplayPlan,
  summarizeReplayPlan,
  validatePlanShape,
  planBudget,
  planFingerprint,
  planStepSignature,
} from './replay-plan.js';
import { verdictForPlan, summarizeDifferences } from './replay-diff.js';
import { explainFailure, buildFailureReport, summarizeFailureReport } from './replay-explain.js';
import { verifyTargetPlan, summarizeTargetPlan } from './replay-target.js';
import { summarizeBoundaries, verifyBoundarySequence } from './replay-boundary-plan.js';

/** 自检模型版本。 */
export const REPLAY_VERIFY_VERSION = 1;

/** 自检项 id（稳定，便于报告/测试断言）。 */
export const VERIFY_CODES = Object.freeze({
  PLAN_SHAPE: 'VERIFY_PLAN_SHAPE',
  PLAN_FINGERPRINT: 'VERIFY_PLAN_FINGERPRINT',
  PLAN_SCHEDULE: 'VERIFY_PLAN_SCHEDULE',
  PLAN_CHECKPOINTS: 'VERIFY_PLAN_CHECKPOINTS',
  PLAN_HUMAN_ORDER: 'VERIFY_PLAN_HUMAN_ORDER',
  PLAN_BOUNDARY: 'VERIFY_PLAN_BOUNDARY',
  PLAN_TARGETS: 'VERIFY_PLAN_TARGETS',
  PLAN_BUDGET: 'VERIFY_PLAN_BUDGET',
  OUTCOME_COVERAGE: 'VERIFY_OUTCOME_COVERAGE',
  OUTCOME_ORDER: 'VERIFY_OUTCOME_ORDER',
  OUTCOME_VERDICTS: 'VERIFY_OUTCOME_VERDICTS',
  RECORD_COVERAGE: 'VERIFY_RECORD_COVERAGE',
  DETERMINISM: 'VERIFY_DETERMINISM',
  CHECKSUM: 'VERIFY_CHECKSUM',
  CHECKPOINT_RESUME: 'VERIFY_CHECKPOINT_RESUME',
  BOUNDARY_TRAIL: 'VERIFY_BOUNDARY_TRAIL',
});

/** 默认自检选项。 */
export const DEFAULT_VERIFY_OPTIONS = Object.freeze({
  requireOutcomes: false,
  requireAllOutcomes: false,
  requireSnapshots: false,
  maxChecks: 64,
  maxFailures: 32,
  strict: false,
});

const GRADE_ORDER = Object.freeze({ pass: 0, warn: 1, fail: 2 });

/** 组装一条自检结果（统一形状；severity 决定整体等级）。 */
function check(id, title, ok, options = {}) {
  return {
    id,
    title,
    ok,
    severity: ok ? (options.info ? 'info' : 'pass') : (options.severity || 'fail'),
    detail: String(options.detail || '').slice(0, 400),
    evidence: options.evidence === undefined ? null : options.evidence,
  };
}

function maxSeverity(checks) {
  let grade = 'pass';
  for (const item of checks) {
    const severity = item.severity || (item.ok ? 'pass' : 'fail');
    if ((GRADE_ORDER[severity] || 0) > (GRADE_ORDER[grade] || 0)) grade = severity;
  }
  return grade;
}

/** 等级：任何 fail → fail；任何 warn/warning → warn；否则 pass。 */
export function gradeOf(checksIn) {
  const checks = Array.isArray(checksIn) ? checksIn : [];
  if (!checks.length) return 'pass';
  if (checks.some((item) => (item.severity || (item.ok ? 'pass' : 'fail')) === 'fail')) return 'fail';
  if (checks.some((item) => ['warning', 'warn'].includes(item.severity))) return 'warn';
  return 'pass';
}

/** 计划校验和：步骤签名 + token + 版本（执行前后比对，防止计划被改）。 */
export function replayChecksum(plan) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  return stableHash([
    REPLAY_VERIFY_VERSION,
    plan && plan.token || '',
    plan && plan.fingerprint || '',
    steps.map((step) => planStepSignature(step)).join('>'),
  ].join('|'));
}

// ---------------------------------------------------------------------------
// 计划自检
// ---------------------------------------------------------------------------

/**
 * 执行前计划自检。
 * @param {object} plan buildReplayPlan 结果
 * @param {{strict?:boolean, maxChecks?:number}} [options]
 * @returns {{ok:boolean, grade:string, checks:Array<object>, issues:Array<object>, checksum:string}}
 */
export function verifyPlan(plan, options = {}) {
  const config = { ...DEFAULT_VERIFY_OPTIONS, ...(options && typeof options === 'object' ? options : {}) };
  const checks = [];
  const shape = validatePlanShape(plan);
  checks.push(check(VERIFY_CODES.PLAN_SHAPE, '计划结构', shape.ok, {
    detail: shape.ok ? '结构完整' : shape.issues.slice(0, 6).map((issue) => issue.code + ':' + issue.message).join('; '),
    evidence: shape.issues.slice(0, 8),
  }));
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const expectedFingerprint = planFingerprint(steps);
  const fingerprintOk = Boolean(plan && plan.fingerprint) && plan.fingerprint === expectedFingerprint;
  checks.push(check(VERIFY_CODES.PLAN_FINGERPRINT, '计划指纹一致', fingerprintOk, {
    detail: fingerprintOk ? '指纹可复算' : 'fingerprint 与 steps 不一致（计划被改动或生成有非确定因素）',
    evidence: { declared: plan && plan.fingerprint || '', computed: expectedFingerprint },
  }));

  // 时间线：units 与 steps 等长、单调、非负。
  const units = plan && plan.schedule && Array.isArray(plan.schedule.units) ? plan.schedule.units : [];
  let scheduleOk = units.length === steps.length;
  let cursor = 0;
  for (const unit of units) {
    if (!unit || Number(unit.startMs) !== cursor || Number(unit.durationMs) < 0 || Number(unit.endMs) < Number(unit.startMs)) {
      scheduleOk = false;
      break;
    }
    cursor = Number(unit.endMs);
  }
  if (plan && plan.schedule && Number(plan.schedule.totalDelayMs) !== cursor) scheduleOk = false;
  checks.push(check(VERIFY_CODES.PLAN_SCHEDULE, '时间线自洽', scheduleOk, {
    detail: scheduleOk ? '等待/时长可复算' : 'schedule.units 与 steps/累计时长不一致',
    evidence: { units: units.length, steps: steps.length, total: plan && plan.schedule ? plan.schedule.totalDelayMs : 0 },
  }));

  // 检查点：有序、在范围内、id 唯一。
  const checkpoints = plan && Array.isArray(plan.checkpoints) ? plan.checkpoints : [];
  const checkpointIds = new Set();
  let checkpointsOk = checkpoints.length > 0;
  let previousIndex = -1;
  for (const checkpoint of checkpoints) {
    if (!checkpoint || !checkpoint.id || checkpointIds.has(checkpoint.id)) { checkpointsOk = false; break; }
    checkpointIds.add(checkpoint.id);
    const index = Number(checkpoint.index);
    if (!Number.isInteger(index) || index < previousIndex || index > steps.length) { checkpointsOk = false; break; }
    previousIndex = index;
  }
  checks.push(check(VERIFY_CODES.PLAN_CHECKPOINTS, '检查点有序', checkpointsOk, {
    detail: checkpointsOk ? '检查点可用于断点续跑' : '检查点缺失、乱序或越界',
    evidence: { count: checkpoints.length },
  }));

  // human 步骤必须在其动作之前；带 humanGate 的动作必须有暂停点（除非预算截断）。
  let humanOk = true;
  let pendingHuman = false;
  for (const step of steps) {
    if (!step) continue;
    if (step.kind === 'human') pendingHuman = true;
    if (step.kind === 'action' && step.waitsForHuman === true && !pendingHuman) humanOk = false;
    if (step.kind === 'action') pendingHuman = false;
  }
  checks.push(check(VERIFY_CODES.PLAN_HUMAN_ORDER, 'human-gate 顺序', humanOk, {
    detail: humanOk ? '每个 human-gate 动作前都有暂停点' : 'human-gate 动作前缺少暂停点',
  }));

  // 边界：epoch 覆盖连续；换文档 transition 必须可导航或有显式 blocker。
  const boundaries = plan && plan.boundaries;
  const sequence = verifyBoundarySequence(boundaries, steps.length);
  const unreachable = (Array.isArray(boundaries && boundaries.transitions) ? boundaries.transitions : [])
    .filter((transition) => transition && transition.kind === 'document' && !transition.canNavigate).length;
  const hasBoundaryBlockers = Boolean(boundaries && Array.isArray(boundaries.blockers) && boundaries.blockers.length);
  const boundaryOk = sequence.ok && (unreachable === 0 || hasBoundaryBlockers);
  checks.push(check(VERIFY_CODES.PLAN_BOUNDARY, '边界还原完整', boundaryOk, {
    detail: boundaryOk ? '每个换窗口动作都可还原或已显式阻断' : '存在不可导航的换文档且没有 blocker',
    evidence: { issues: sequence.issues.slice(0, 6), unreachable, blocked: hasBoundaryBlockers },
  }));

  // 目标计划：结构合法；strict 模式下不允许 ambiguous/missing。
  const targetCheck = verifyTargetPlan(plan && plan.targets, steps.length);
  let targetsOk = targetCheck.ok;
  let targetDetail = targetsOk ? '目标计划结构合法' : targetCheck.issues.slice(0, 4).map((issue) => issue.code).join(',');
  const targetSummary = summarizeTargetPlan(plan && plan.targets);
  if (config.strict) {
    // strict 以“逐步状态”为准，而不是汇总计数（汇总可能被兼容目标改写或未刷新）。
    const targetSteps = plan && plan.targets && Array.isArray(plan.targets.steps) ? plan.targets.steps : [];
    const strictBad = targetSteps.filter((item) => item && (item.status === 'ambiguous' || item.status === 'missing' || item.status === 'forbidden')).length;
    if (strictBad > 0) {
      targetsOk = false;
      targetDetail = 'strict 模式下存在不可还原目标（' + strictBad + '）';
    }
  }
  checks.push(check(VERIFY_CODES.PLAN_TARGETS, '目标可还原性', targetsOk, {
    detail: targetDetail,
    evidence: { summary: targetSummary, issues: targetCheck.issues.slice(0, 6) },
  }));

  // 预算：不超过 limits。
  const budget = plan && plan.budget ? plan.budget : planBudget(steps, DEFAULT_PLAN_LIMITS);
  const budgetLimits = (plan && plan.budget && plan.budget.maxSteps) ? plan.budget : DEFAULT_PLAN_LIMITS;
  const budgetOk = budget.steps <= (budgetLimits.maxSteps || DEFAULT_PLAN_LIMITS.maxSteps)
    && budget.retries <= (budgetLimits.maxRetries || DEFAULT_PLAN_LIMITS.maxRetries)
    && budget.waitMs <= (budgetLimits.maxTotalMs || DEFAULT_PLAN_LIMITS.maxTotalMs);
  checks.push(check(VERIFY_CODES.PLAN_BUDGET, '预算未超限', budgetOk, {
    detail: budgetOk ? '步数/重试/等待都在预算内' : '计划超出预算',
    evidence: budget,
  }));

  const checksum = replayChecksum(plan);
  const issues = [];
  for (const item of checks) {
    if (item.ok) continue;
    issues.push({ code: item.id, severity: item.severity, message: item.detail, evidence: item.evidence });
  }
  return {
    ok: checks.every((item) => item.ok === true),
    grade: gradeOf(checks),
    checks: checks.slice(0, config.maxChecks),
    issues,
    checksum,
  };
}

/** 预算自检单列（便于只跑预算的调用方）。 */
export function verifyBudget(plan, limits) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const budget = planBudget(steps, limits || DEFAULT_PLAN_LIMITS);
  const maxSteps = Number(limits && limits.maxSteps) > 0 ? Number(limits.maxSteps) : DEFAULT_PLAN_LIMITS.maxSteps;
  const maxRetries = Number(limits && limits.maxRetries) > 0 ? Number(limits.maxRetries) : DEFAULT_PLAN_LIMITS.maxRetries;
  const maxTotalMs = Number(limits && limits.maxTotalMs) > 0 ? Number(limits.maxTotalMs) : DEFAULT_PLAN_LIMITS.maxTotalMs;
  return {
    ok: budget.steps <= maxSteps && budget.retries <= maxRetries && budget.waitMs <= maxTotalMs,
    budget,
    limits: { maxSteps, maxRetries, maxTotalMs },
    issues: [
      ...(budget.steps > maxSteps ? [{ code: 'BUDGET_STEPS', message: '步数超限', value: budget.steps, max: maxSteps }] : []),
      ...(budget.retries > maxRetries ? [{ code: 'BUDGET_RETRIES', message: '重试超限', value: budget.retries, max: maxRetries }] : []),
      ...(budget.waitMs > maxTotalMs ? [{ code: 'BUDGET_WAIT', message: '等待时长超限', value: budget.waitMs, max: maxTotalMs }] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// 执行结果自检
// ---------------------------------------------------------------------------

/**
 * 执行后覆盖自检：每个计划 step 都要有结果；不允许计划外结果；顺序单调。
 * @param {object} plan
 * @param {Array<object>} outcomes 每步结果（至少带 index）
 * @returns {{ok:boolean, missing:Array<number>, extra:Array<number>, outOfOrder:Array<object>, duplicates:Array<number>, counts:object}}
 */
export function verifyOutcomes(plan, outcomesIn) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const outcomes = Array.isArray(outcomesIn) ? outcomesIn : [];
  const indexes = new Set();
  const duplicates = [];
  const extra = [];
  const seenOrder = [];
  for (const outcome of outcomes) {
    if (!outcome || !Number.isInteger(outcome.index)) continue;
    if (indexes.has(outcome.index)) duplicates.push(outcome.index);
    indexes.add(outcome.index);
    seenOrder.push(outcome.index);
  }
  const expected = steps.map((step) => (Number.isInteger(step.index) ? step.index : 0));
  const missing = expected.filter((index) => !indexes.has(index));
  for (const index of indexes) {
    if (!expected.includes(index)) extra.push(index);
  }
  const outOfOrder = [];
  for (let position = 1; position < seenOrder.length; position += 1) {
    if (seenOrder[position] < seenOrder[position - 1]) {
      outOfOrder.push({ at: position, previous: seenOrder[position - 1], current: seenOrder[position] });
    }
  }
  return {
    ok: missing.length === 0 && extra.length === 0 && duplicates.length === 0 && outOfOrder.length === 0,
    missing,
    extra,
    outOfOrder,
    duplicates,
    counts: { steps: expected.length, outcomes: outcomes.filter((outcome) => outcome && Number.isInteger(outcome.index)).length },
  };
}

/** 单步判决汇总 + 失败解释（执行结果 → 报告字段）。 */
export function verifyOutcomeVerdicts(plan, outcomesIn, options = {}) {
  const verdict = verdictForPlan(plan, outcomesIn, { requireAll: options.requireAllOutcomes === true });
  const failures = [];
  for (const item of verdict.verdicts) {
    if (item.status !== 'failed') continue;
    const outcome = (Array.isArray(outcomesIn) ? outcomesIn : []).find((candidate) => candidate && candidate.index === item.index);
    const step = plan && Array.isArray(plan.steps) ? plan.steps.find((candidate) => candidate && candidate.index === item.index) : null;
    failures.push(explainFailure({ code: outcome && outcome.code, outcome, step, plan }));
  }
  return { verdict, failures };
}

// ---------------------------------------------------------------------------
// 与录制程序的覆盖对照
// ---------------------------------------------------------------------------

/**
 * 计划是否覆盖了录制程序里所有“有副作用/可观察”的步骤（按签名对齐）。
 * 只读 observe 允许被简化掉（计划侧 dropTrailingObserves），非幂等动作绝不允许丢失。
 * @param {unknown} program {nodes} / step 数组 / preflight 结果
 * @param {object} plan
 * @returns {{ok:boolean, coverage:number, dropped:Array<object>, extra:Array<object>}}
 */
export function verifyAgainstRecord(program, plan) {
  const recorded = extractRecordedSteps(program);
  const planned = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const plannedSignatures = new Set();
  for (const step of planned) {
    plannedSignatures.add(signatureOfRecorded(step));
  }
  const dropped = [];
  let covered = 0;
  for (let position = 0; position < recorded.length; position += 1) {
    const step = recorded[position];
    if (!step) continue;
    const signature = signatureOfRecorded(step);
    const matched = plannedSignatures.has(signature);
    const droppable = step.kind === 'observe' || step.kind === 'wait' || step.idempotent === true;
    if (matched) covered += 1;
    else if (!droppable) dropped.push({ index: Number.isInteger(step.index) ? step.index : position, ref: step.ref || '', method: step.method || '', kind: step.kind || '' });
  }
  const recordedSignatures = new Set(recorded.filter(Boolean).map(signatureOfRecorded));
  const extra = [];
  for (const step of planned) {
    const signature = signatureOfRecorded(step);
    if (step.synthetic === true) continue;
    if (!recordedSignatures.has(signature)) extra.push({ index: step.index, ref: step.ref || '', method: step.method || '', kind: step.kind || '' });
  }
  const total = Math.max(1, recorded.filter(Boolean).length);
  return {
    ok: dropped.length === 0,
    coverage: Math.round((covered / total) * 1000) / 1000,
    dropped: dropped.slice(0, 16),
    extra: extra.slice(0, 16),
  };
}

function extractRecordedSteps(program) {
  if (!program) return [];
  if (Array.isArray(program)) {
    return program.map((item) => (item && item.recordStep ? item.recordStep : item)).filter(Boolean);
  }
  if (Array.isArray(program.nodes)) return program.nodes.filter(Boolean);
  if (program.program && Array.isArray(program.program.nodes)) return program.program.nodes.filter(Boolean);
  if (Array.isArray(program.steps)) return program.steps.filter(Boolean);
  if (Array.isArray(program.replayPlan)) return program.replayPlan.filter(Boolean);
  return [];
}

/** 录制 step 与计划 step 的对照签名（方法 + 目标 + 边界作用域，不含 index）。 */
function signatureOfRecorded(step) {
  if (!step || typeof step !== 'object') return '';
  const target = step.target && typeof step.target === 'object'
    ? [step.target.selector, step.target.name, step.target.text].filter(Boolean).join('\u0001')
    : '';
  return [step.kind || '', step.method || '', target].join('|');
}

// ---------------------------------------------------------------------------
// 确定性 / 断点
// ---------------------------------------------------------------------------

function deepClone(value, depth = 0) {
  if (depth > 6) return value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => deepClone(item, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) out[key] = deepClone(value[key], depth + 1);
  return out;
}

/**
 * 确定性复核：同一输入构建两次，指纹/token/序列化必须一致。
 * @param {unknown} input buildReplayPlan 的输入
 * @param {object} [options] 同一份 options
 * @returns {{deterministic:boolean, tokenA:string, tokenB:string, fingerprintA:string, fingerprintB:string, mismatches:Array<object>}}
 */
export function verifyDeterminism(input, options = {}) {
  const clone = deepClone(input);
  const first = buildReplayPlan(clone, options);
  const second = buildReplayPlan(clone, options);
  const mismatches = [];
  if (first.token !== second.token) mismatches.push({ field: 'token', a: first.token, b: second.token });
  if (first.fingerprint !== second.fingerprint) mismatches.push({ field: 'fingerprint', a: first.fingerprint, b: second.fingerprint });
  if (first.steps.length !== second.steps.length) mismatches.push({ field: 'steps.length', a: first.steps.length, b: second.steps.length });
  const limit = Math.min(first.steps.length, second.steps.length);
  for (let index = 0; index < limit; index += 1) {
    if (planStepSignature(first.steps[index]) !== planStepSignature(second.steps[index])) {
      mismatches.push({ field: 'step', index });
      if (mismatches.length >= 8) break;
    }
  }
  return {
    deterministic: mismatches.length === 0,
    tokenA: first.token,
    tokenB: second.token,
    fingerprintA: first.fingerprint,
    fingerprintB: second.fingerprint,
    mismatches,
  };
}

/**
 * 断点续跑：给定已完成步骤（或“已完成到哪一步”），算出最近可恢复检查点。
 * @param {object} plan
 * @param {Array<number>|number} completed 已完成 index 数组，或“连续完成到”的上界
 */
export function resumePointFrom(plan, completed) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const checkpoints = plan && Array.isArray(plan.checkpoints) ? plan.checkpoints : [];
  let completedIndexes;
  if (Number.isInteger(completed)) completedIndexes = Array.from({ length: Math.max(0, completed + 1) }, (_, index) => index);
  else completedIndexes = (Array.isArray(completed) ? completed : []).filter((index) => Number.isInteger(index)).sort((a, b) => a - b);
  const done = new Set(completedIndexes);
  // 连续完成的前缀：断点续跑只在“无空洞”时可信。
  let contiguous = 0;
  while (done.has(contiguous) && contiguous < steps.length) contiguous += 1;
  const resumable = checkpoints
    .filter((checkpoint) => checkpoint && Number.isInteger(checkpoint.index) && checkpoint.index >= contiguous && checkpoint.index <= steps.length)
    .sort((left, right) => left.index - right.index);
  const checkpoint = resumable[0] || null;
  return {
    ok: Boolean(checkpoint),
    completed: contiguous,
    completedIndexes,
    fromIndex: checkpoint ? checkpoint.index : steps.length,
    checkpoint,
    reason: checkpoint ? 'checkpoint' : 'no-checkpoint',
  };
}

/**
 * 边界轨迹自检：运行期采集的每一步边界应满足计划里的还原动作。
 * trail: [{index, boundary}]（按执行顺序）。
 * @returns {{ok:boolean, issues:Array<object>}}
 */
export function verifyBoundaryTrail(plan, trailIn) {
  const trail = Array.isArray(trailIn) ? trailIn : [];
  const plans = plan && plan.boundaries && Array.isArray(plan.boundaries.plans) ? plan.boundaries.plans : [];
  const issues = [];
  const byIndex = new Map();
  for (const entry of trail) {
    if (entry && Number.isInteger(entry.index)) byIndex.set(entry.index, entry.boundary);
  }
  for (let index = 0; index < plans.length; index += 1) {
    const action = plans[index];
    if (!action) continue;
    const observed = byIndex.get(index);
    if (!observed) continue;
    const expected = plans[index].boundary;
    if (!expected) continue;
    if (action.action === 'navigate' && action.urlKey && observed.urlKey && observed.urlKey !== action.urlKey) {
      issues.push({ code: 'BOUNDARY_TRAIL_URL', index, expected: action.urlKey, actual: observed.urlKey });
    }
    if (action.action === 'frame-switch' && Number.isInteger(action.frameId) && observed.frameId !== action.frameId) {
      issues.push({ code: 'BOUNDARY_TRAIL_FRAME', index, expected: action.frameId, actual: observed.frameId });
    }
  }
  return { ok: issues.length === 0, issues: issues.slice(0, 16) };
}

// ---------------------------------------------------------------------------
// 总报告
// ---------------------------------------------------------------------------

/**
 * 总自检：计划 + 结果 + 与录制覆盖 + 确定性综合。
 * @param {object} plan
 * @param {Array<object>} [outcomes]
 * @param {{options?:object, record?:unknown, trail?:Array<object>, verifyDeterminism?:boolean,
 *          buildInput?:unknown, buildOptions?:object}} [context]
 * @returns {object}
 */
export function verifyReplay(plan, outcomes, context = {}) {
  const config = { ...DEFAULT_VERIFY_OPTIONS, ...(context && context.options && typeof context.options === 'object' ? context.options : {}) };
  const planVerification = verifyPlan(plan, config);
  const checks = planVerification.checks.slice();
  const failures = [];

  const coverage = verifyOutcomes(plan, outcomes);
  const coverageOk = outcomes || config.requireOutcomes
    ? coverage.ok
    : true;
  checks.push(check(VERIFY_CODES.OUTCOME_COVERAGE, '执行覆盖完整', coverageOk, {
    detail: coverageOk ? '每个计划步骤都有结果' : '存在缺步/多步/重复执行',
    evidence: coverage,
  }));
  const orderOk = coverage.outOfOrder.length === 0 && coverage.duplicates.length === 0;
  checks.push(check(VERIFY_CODES.OUTCOME_ORDER, '执行顺序正确', orderOk, {
    detail: orderOk ? '结果顺序与计划一致' : '结果乱序或重复',
    evidence: { outOfOrder: coverage.outOfOrder.slice(0, 8), duplicates: coverage.duplicates.slice(0, 8) },
  }));
  let verdict = null;
  if (Array.isArray(outcomes)) {
    const verdicts = verifyOutcomeVerdicts(plan, outcomes, config);
    verdict = verdicts.verdict;
    failures.push(...verdicts.failures);
    const verdictOk = verdict.aggregate.failed === 0;
    checks.push(check(VERIFY_CODES.OUTCOME_VERDICTS, '单步判决通过', verdictOk, {
      detail: verdictOk ? '所有步骤判决通过' : '存在失败的步骤判决',
      evidence: summarizeDifferences((outcomes || []).flatMap((outcome) => (outcome && Array.isArray(outcome.differences) ? outcome.differences : []))),
    }));
  }
  if (context.record) {
    const recordCoverage = verifyAgainstRecord(context.record, plan);
    checks.push(check(VERIFY_CODES.RECORD_COVERAGE, '录制覆盖完整', recordCoverage.ok, {
      detail: recordCoverage.ok ? '计划覆盖全部录制副作用步骤' : '计划丢失了录制里的副作用步骤',
      evidence: recordCoverage,
    }));
    if (!recordCoverage.ok) {
      failures.push(explainFailure({ code: 'VERIFY_COVERAGE', plan, detail: '计划丢失录制步骤：' + recordCoverage.dropped.map((item) => item.ref || item.index).join(',') }));
    }
  }
  let determinism = null;
  if (context.verifyDeterminism === true && context.buildInput !== undefined) {
    determinism = verifyDeterminism(context.buildInput, context.buildOptions || {});
    checks.push(check(VERIFY_CODES.DETERMINISM, '计划确定性', determinism.deterministic, {
      detail: determinism.deterministic ? '两次构建完全一致' : '两次构建结果不一致',
      evidence: determinism.mismatches,
    }));
  }
  if (Array.isArray(context.trail)) {
    const trailResult = verifyBoundaryTrail(plan, context.trail);
    checks.push(check(VERIFY_CODES.BOUNDARY_TRAIL, '边界轨迹一致', trailResult.ok, {
      detail: trailResult.ok ? '运行期边界与计划一致' : '运行期边界偏离计划',
      evidence: trailResult.issues,
    }));
  }
  const checksum = replayChecksum(plan);
  const checksumOk = checksum === replayChecksum(plan);
  checks.push(check(VERIFY_CODES.CHECKSUM, '计划校验和', checksumOk, {
    detail: checksumOk ? '校验和稳定' : '校验和不可复算',
    evidence: { checksum },
  }));

  const report = buildFailureReport(failures, { plan });
  const summary = {
    version: REPLAY_VERIFY_VERSION,
    ok: checks.every((item) => item.ok === true || item.severity === 'info'),
    grade: gradeOf(checks),
    checks: checks.length,
    passed: checks.filter((item) => item.ok === true).length,
    failed: checks.filter((item) => item.ok !== true && item.severity === 'fail').length,
    warned: checks.filter((item) => !item.ok && ['warning', 'warn'].includes(item.severity)).length,
    failures: failures.length,
    checksum,
    planToken: plan && plan.token || '',
    coverage: { steps: coverage.counts.steps, outcomes: coverage.counts.outcomes, missing: coverage.missing.length, extra: coverage.extra.length },
    verdict: verdict ? { ok: verdict.ok, divergedAt: verdict.divergedAt, aggregate: verdict.aggregate } : null,
    determinism: determinism ? determinism.deterministic : null,
  };
  return {
    ...summary,
    plan: summarizeReplayPlan(plan),
    boundaries: summarizeBoundaries(plan && plan.boundaries),
    targets: summarizeTargetPlan(plan && plan.targets),
    checks,
    coverageDetails: coverage,
    outcomeCoverage: {
      ok: coverage.ok,
      missing: coverage.missing,
      extra: coverage.extra,
      duplicates: coverage.duplicates,
      outOfOrder: coverage.outOfOrder,
    },
    verdict,
    determinismDetails: determinism,
    failures,
    failureReport: summarizeFailureReport(report),
    failureText: report.total ? buildReportText(report) : '',
  };
}

function buildReportText(report) {
  if (!report || !report.groups || !report.groups.length) return '';
  const lines = ['回放失败 ' + report.total + ' 处'];
  for (const group of report.groups.slice(0, 6)) lines.push('- [' + group.code + '] ×' + group.count + ' ' + (group.category || ''));
  return lines.join('\n');
}

/**
 * 渲染自检报告（CLI/日志展示；有界）。
 * @param {object} report verifyReplay 结果
 * @param {{maxLines?:number, verbose?:boolean}} [options]
 */
export function renderVerifyReport(report, options = {}) {
  if (!report || typeof report !== 'object') return '回放自检：无报告';
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : 24;
  const lines = [];
  lines.push('回放自检 ' + (report.grade || 'unknown').toUpperCase() + ' · plan ' + (report.planToken || '-') + ' · checksum ' + (report.checksum || '-'));
  if (report.coverage) {
    lines.push('覆盖：steps=' + report.coverage.steps + ' outcomes=' + report.coverage.outcomes + ' missing=' + report.coverage.missing + ' extra=' + report.coverage.extra);
  }
  if (report.determinism !== null && report.determinism !== undefined) {
    lines.push('确定性：' + (report.determinism ? '通过' : '不通过'));
  }
  for (const item of Array.isArray(report.checks) ? report.checks : []) {
    if (item.ok && options.verbose !== true) continue;
    lines.push((item.ok ? '✓ ' : '✗ ') + item.title + (item.detail ? '：' + item.detail : ''));
  }
  if (report.failureText) lines.push(report.failureText);
  return lines.slice(0, maxLines).join('\n');
}

/** 自检报告紧凑字段（挂到 RPC 输出）。 */
export function summarizeVerify(report) {
  if (!report || typeof report !== 'object') return null;
  return {
    version: REPLAY_VERIFY_VERSION,
    ok: report.ok === true,
    grade: report.grade || 'unknown',
    checksum: report.checksum || '',
    planToken: report.planToken || '',
    checks: Array.isArray(report.checks) ? report.checks.length : 0,
    failed: report.failed || 0,
    warned: report.warned || 0,
    failures: report.failures || 0,
    coverage: report.coverage || null,
    verdict: report.verdict ? { ok: report.verdict.ok, divergedAt: report.verdict.divergedAt } : null,
    determinism: report.determinism === null || report.determinism === undefined ? null : report.determinism === true,
    failureReport: report.failureReport || null,
  };
}
