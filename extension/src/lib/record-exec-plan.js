// src/lib/record-exec-plan.js —— 录制 program 执行器：dry-run / 图形校验 / 回放前置。
//
// record-program.js 已经能做“线性程序”的校验、指纹、diff 与回放预检（preflightReplay）。
// 本轮补的是“执行器”：在真的回放之前，先在内存里把程序跑一遍，回答四个问题：
//   1. 这条路径能不能走完？（分支选项有没有目标、并发区有没有汇合点、取消域有没有歧义）
//   2. 会在哪一步停下来等人工？（human-gate 缺值、人工策略=block 时）
//   3. 预算够不够？（步数 / 模拟耗时 / 重试次数 / human-gate 个数 / 并发宽度）
//   4. 中途被取消会留下什么证据？（取消域 abort/skip/continue 的差异、剩余步骤、轨迹摘要）
//
// 三个入口：
//   plan(program)              只读规划：批次（serial/branch/parallel）+ 回放计划，不执行
//   dryRun(program, options)   内存执行：按批次推进、写轨迹、统计预算、支持取消/人工/失败注入
//   preflight(program, options) 回放前置：复用 record-program.preflightReplay（线性语义不变），
//                               再叠加图形校验/并发/取消/执行器侧阻断，返回 executable 判定
//
// 关键约定：
//   - 默认行为不变：没有 parallel/cancel/branchOptions 的线性程序，批次全是 serial，
//     dryRun 的推进顺序 == 原回放顺序；
//   - 执行器是纯内存、可注入时钟/ID；不碰 chrome/DOM，不真的执行动作（dry-run 永远是模拟）；
//   - 结构化返回，不抛异常（取消/失败都变成 status + blockers + 轨迹）；
//   - 每次 dry-run 产出可复算 digest 与可封存轨迹（lib/record-exec-trace.js 的哈希链），
//     供 record-events.js 挂到录制事件、或落诊断/导出做对账。
//
// 接入点（file:line）：record-events.js 的程序摘要采样（record-events.js:204-212）在生成
// recordProgram 后调用 summarizeExecReport(dryRunProgram(...))，只新增 event.recordExec 字段。

import {
  buildRecordProgram,
  preflightReplay,
  programFingerprint,
  summarizeRecordProgram,
} from '../record-program.js';
import { stableHash } from '../record-steps.js';
import {
  BATCH_KINDS,
  CANCEL_MODES,
  PARALLEL_MODES,
  PARALLEL_MODE_LIST,
  buildStepGraph,
  cancelScopeAt,
  planStepBatches,
  stepGraphDigest,
  summarizeStepGraph,
  validateStepGraph,
} from './record-step-graph.js';
import {
  TRACE_PHASES,
  TRACE_STATUSES,
  createTraceRecorder,
  describeTrace,
  diffTraces,
  formatTrace,
  sealTrace,
  summarizeTrace,
  verifyTrace,
} from './record-exec-trace.js';

export const EXEC_VERSION = 1;

/** 执行状态：dry-run / 回放共用。 */
export const EXEC_STATUS = Object.freeze({
  READY: 'ready',
  RUNNING: 'running',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked',
  FAILED: 'failed',
});

export const EXEC_STATUS_LIST = Object.freeze(Object.values(EXEC_STATUS));

/** 执行器问题码（内部证据码，不是 wire 错误码）。 */
export const EXEC_CODES = Object.freeze({
  EXEC_OK: 'EXEC_OK',
  EXEC_EMPTY: 'EXEC_EMPTY',
  EXEC_VALIDATION: 'EXEC_VALIDATION',
  EXEC_GRAPH: 'EXEC_GRAPH',
  EXEC_CANCELLED: 'EXEC_CANCELLED',
  EXEC_CANCEL_UNKNOWN_SCOPE: 'EXEC_CANCEL_UNKNOWN_SCOPE',
  EXEC_HUMAN_REQUIRED: 'EXEC_HUMAN_REQUIRED',
  EXEC_HUMAN_LIMIT: 'EXEC_HUMAN_LIMIT',
  EXEC_BRANCH_UNRESOLVED: 'EXEC_BRANCH_UNRESOLVED',
  EXEC_BRANCH_TARGET_UNKNOWN: 'EXEC_BRANCH_TARGET_UNKNOWN',
  EXEC_PARALLEL_NO_JOIN: 'EXEC_PARALLEL_NO_JOIN',
  EXEC_PARALLEL_TIMEOUT: 'EXEC_PARALLEL_TIMEOUT',
  EXEC_RETRY_EXHAUSTED: 'EXEC_RETRY_EXHAUSTED',
  EXEC_RETRY_NON_IDEMPOTENT: 'EXEC_RETRY_NON_IDEMPOTENT',
  EXEC_BUDGET_STEPS: 'EXEC_BUDGET_STEPS',
  EXEC_BUDGET_DURATION: 'EXEC_BUDGET_DURATION',
  EXEC_BUDGET_RETRIES: 'EXEC_BUDGET_RETRIES',
  EXEC_SIDE_EFFECT: 'EXEC_SIDE_EFFECT',
  EXEC_REPLAY_BLOCKED: 'EXEC_REPLAY_BLOCKED',
  EXEC_REPLAY_DUPLICATE: 'EXEC_REPLAY_DUPLICATE',
  EXEC_FAILED_STEP: 'EXEC_FAILED_STEP',
  EXEC_BAD_ARG: 'EXEC_BAD_ARG',
});

/** 执行器预算（可用 run options 覆盖）。 */
export const EXEC_LIMITS = Object.freeze({
  maxSteps: 4000,
  maxDurationMs: 600_000,
  maxRetries: 20,
  maxHumanGates: 64,
  maxParallelArms: 16,
  maxRuns: 32,
});

const FAIL_STRATEGIES = Object.freeze(['stop', 'skip', 'continue']);
const HUMAN_POLICIES = Object.freeze(['block', 'allow']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clip(text, limit) {
  return String(text == null ? '' : text).slice(0, limit);
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function normalizeLimits(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const limits = isPlainObject(source.limits) ? source.limits : {};
  return {
    maxSteps: nonNegative(limits.maxSteps || source.maxSteps) || EXEC_LIMITS.maxSteps,
    maxDurationMs: nonNegative(limits.maxDurationMs || source.maxDurationMs) || EXEC_LIMITS.maxDurationMs,
    maxRetries: nonNegative(limits.maxRetries || source.maxRetries) || EXEC_LIMITS.maxRetries,
    maxHumanGates: nonNegative(limits.maxHumanGates || source.maxHumanGates) || EXEC_LIMITS.maxHumanGates,
    maxParallelArms: nonNegative(limits.maxParallelArms || source.maxParallelArms) || EXEC_LIMITS.maxParallelArms,
    maxRuns: nonNegative(limits.maxRuns || source.maxRuns) || EXEC_LIMITS.maxRuns,
  };
}

function normalizeRunOptions(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const human = isPlainObject(source.human) ? source.human : {};
  const values = isPlainObject(human.values) ? { ...human.values }
    : (isPlainObject(source.humanValues) ? { ...source.humanValues } : {});
  return {
    mode: clip(source.mode || 'dry-run', 24),
    humanPolicy: HUMAN_POLICIES.includes(String(human.policy || source.humanPolicy)) ? String(human.policy || source.humanPolicy) : 'block',
    humanValues: values,
    allowNonIdempotent: source.allowNonIdempotent === true,
    failAt: typeof source.failAt === 'function' ? source.failAt : new Set((Array.isArray(source.failAt) ? source.failAt : []).map((item) => String(item))),
    failStrategy: FAIL_STRATEGIES.includes(source.failStrategy) ? source.failStrategy : 'stop',
    facts: isPlainObject(source.facts) ? source.facts : {},
    startAtBatch: Math.max(0, integer(source.startAtBatch, 0)),
    initialSimulatedAt: nonNegative(source.initialSimulatedAt),
    includeTrace: source.includeTrace === true,
    at: nonNegative(source.at),
    runTag: clip(source.tag || '', 64),
    shouldCancel: typeof source.shouldCancel === 'function' ? source.shouldCancel : null,
    program: isPlainObject(source.program) ? source.program : null,
    // 预算覆盖（只影响 dry-run 的模拟上限，不改变 program 本身）。
    maxSteps: nonNegative(source.maxSteps),
    maxDurationMs: nonNegative(source.maxDurationMs),
    maxRetries: nonNegative(source.maxRetries),
    maxHumanGates: nonNegative(source.maxHumanGates),
    maxParallelArms: nonNegative(source.maxParallelArms),
  };
}

/**
 * 分支条件求值：facts 提供当前页面事实（url/selectorFound/selectorValue/text/status）。
 * 没有 when 的选项视为“总是命中”（按顺序第一个），用于录制侧只能记“这里换了文档”。
 * @param {object|null} when
 * @param {object} [facts]
 * @returns {boolean}
 */
export function matchesWhen(when, facts = {}) {
  if (!when || typeof when !== 'object') return true;
  const source = isPlainObject(facts) ? facts : {};
  if (when.urlEquals !== undefined && String(source.url || '') !== String(when.urlEquals)) return false;
  if (when.urlIncludes !== undefined && !String(source.url || '').includes(String(when.urlIncludes))) return false;
  if (when.selectorValue !== undefined && String(source.selectorValue == null ? '' : source.selectorValue) !== String(when.selectorValue)) return false;
  if (when.textIncludes !== undefined && !String(source.text || '').includes(String(when.textIncludes))) return false;
  if (when.status !== undefined && String(source.status || '') !== String(when.status)) return false;
  if (when.selector !== undefined) {
    const selector = String(when.selector || '');
    if (typeof source.hasSelector === 'function') {
      if (!source.hasSelector(selector)) return false;
    } else if (Array.isArray(source.selectors)) {
      if (!source.selectors.includes(selector)) return false;
    }
  }
  if (Number.isInteger(when.refIndex)) {
    if (typeof source.hasRef !== 'function' || !source.hasRef(when.refIndex)) return false;
  }
  return true;
}

/**
 * 分支决策：第一个命中的选项；都不命中返回 fallthrough（顺序执行）。
 * @param {{index:number, ref:string, options:Array, fallthrough:number|null}} branch
 * @param {object} [facts]
 */
export function resolveBranchDecision(branch, facts = {}) {
  if (!branch || typeof branch !== 'object') return { matched: false, option: null, to: null, label: null, reason: 'no-branch' };
  const options = Array.isArray(branch.options) ? branch.options : [];
  for (const option of options) {
    if (!option || typeof option !== 'object') continue;
    if (matchesWhen(option.when, facts)) {
      return {
        matched: true,
        option,
        to: option.to != null ? option.to : null,
        label: option.label || '',
        reason: option.when ? 'when-matched' : 'unconditional',
      };
    }
  }
  return {
    matched: false,
    option: null,
    to: branch.fallthrough != null ? branch.fallthrough : null,
    label: null,
    reason: options.length ? 'no-option-matched' : 'no-options',
  };
}

function failAtHit(run, node) {
  const failAt = run.options.failAt;
  if (typeof failAt === 'function') return failAt(node) === true;
  if (failAt instanceof Set) return failAt.has(String(node.index)) || failAt.has(String(node.ref));
  return false;
}

/** 单步模拟结果：确定状态/尝试次数/是否触发重试/是否等人工。 */
function simulateStep(run, node) {
  const result = { status: TRACE_STATUSES.OK, attempts: 1, retried: false, human: false, note: '', code: null };
  // 1) human-gate：没有值就按策略阻断（dry-run 绝不替人编造输入）。
  if (node.humanGate) {
    const key = node.ref || String(node.index);
    const provided = run.options.humanValues[key] !== undefined
      ? run.options.humanValues[key]
      : (isPlainObject(node.params) ? node.params.value : undefined);
    if (provided === undefined || provided === null || provided === '') {
      run.human.required += 1;
      result.human = true;
      if (run.options.humanPolicy === 'block') {
        result.status = TRACE_STATUSES.BLOCKED;
        result.note = 'human-gate 缺少人工值（dry-run 不自动补值）';
        result.code = EXEC_CODES.EXEC_HUMAN_REQUIRED;
        return result;
      }
      result.note = 'human-gate 缺值但策略=allow';
    } else {
      run.human.provided += 1;
      result.note = 'human-gate 已提供值';
    }
  }
  // 2) 非幂等副作用：默认允许 dry-run（只是模拟），但 replay 前置会单独阻断。
  if (!node.idempotent && run.options.allowNonIdempotent !== true) {
    run.warnings.push({ code: EXEC_CODES.EXEC_SIDE_EFFECT, severity: 'warning', index: node.index, ref: node.ref, message: '非幂等副作用步骤（dry-run 只模拟）' });
  }
  // 3) 失败注入 + fallback 重试模拟。
  if (failAtHit(run, node)) {
    const fallback = isPlainObject(node.fallback) ? node.fallback : {};
    const retries = integer(fallback.retries, 0);
    if (fallback.onError === 'retry' && node.idempotent) {
      const allowed = Math.min(retries, EXEC_LIMITS.maxRetries);
      result.attempts = Math.max(1, allowed + 1);
      result.retried = true;
      run.budgets.retries += allowed;
      if (run.budgets.retries > run.limits.maxRetries) {
        run.blockers.push({ code: EXEC_CODES.EXEC_BUDGET_RETRIES, severity: 'error', index: node.index, ref: node.ref, message: '重试预算耗尽', retries: run.budgets.retries, max: run.limits.maxRetries });
      }
      result.status = TRACE_STATUSES.OK;
      result.note = '失败后按 fallback.idempotent 重试 ' + allowed + ' 次';
      return result;
    }
    if (fallback.onError === 'retry' && !node.idempotent) {
      result.status = TRACE_STATUSES.FAILED;
      result.code = EXEC_CODES.EXEC_RETRY_NON_IDEMPOTENT;
      result.note = '非幂等步骤不允许自动重试';
      return result;
    }
    if (fallback.onError === 'skip') {
      result.status = TRACE_STATUSES.SKIPPED;
      result.note = '失败后按 fallback=skip 跳过';
      return result;
    }
    result.status = TRACE_STATUSES.FAILED;
    result.code = fallback.onError === 'retry' ? EXEC_CODES.EXEC_RETRY_EXHAUSTED : EXEC_CODES.EXEC_FAILED_STEP;
    result.note = fallback.onError === 'retry' ? '重试预算耗尽后仍失败' : '步骤失败且 fallback=stop';
    return result;
  }
  return result;
}

/** 取消域命中判定：返回需要执行的取消动作（null 表示不取消）。 */
function cancelDecision(run, scope, elapsedInScope, node) {
  if (run.cancel.active) {
    return { trigger: 'external', mode: scope ? scope.mode : CANCEL_MODES.ABORT, scope: scope ? scope.scope : 'run', reason: run.cancel.reason };
  }
  if (run.options.shouldCancel) {
    try {
      const asked = run.options.shouldCancel({ node, scope, elapsedInScope, simulatedAt: run.simulatedAt, graph: run.graph });
      if (asked === true || (isPlainObject(asked) && asked.cancel === true)) {
        return { trigger: 'callback', mode: isPlainObject(asked) && CANCEL_MODES[String(asked.mode || '').toUpperCase()] ? asked.mode : (scope ? scope.mode : CANCEL_MODES.ABORT), scope: scope ? scope.scope : 'run', reason: isPlainObject(asked) && asked.reason ? clip(asked.reason, 120) : 'shouldCancel' };
      }
    } catch {
      // 取消回调异常不能打断 dry-run：按“不取消”处理。
    }
  }
  if (scope && scope.afterMs > 0 && elapsedInScope > scope.afterMs) {
    return { trigger: 'timeout', mode: scope.mode, scope: scope.scope, reason: scope.reason || '取消域超时' };
  }
  return null;
}

function createRun(executor, options, graph, program) {
  const runNumber = (executor.counters().runs + 1);
  const startedAt = options.at || executor.now();
  return {
    runId: 'run-' + runNumber.toString(36) + '-' + startedAt.toString(36),
    number: runNumber,
    status: EXEC_STATUS.RUNNING,
    startedAt,
    simulatedAt: options.initialSimulatedAt || startedAt,
    options,
    graph,
    program,
    limits: normalizeLimits(options),
    trace: createTraceRecorder({ now: () => thisClock(executor), limit: 2000 }),
    traceStartedAt: startedAt,
    human: { required: 0, provided: 0 },
    budgets: { steps: 0, retries: 0, humanGates: 0 },
    blockers: [],
    warnings: [],
    branchDecisions: [],
    parallel: [],
    cancels: [],
    skipped: [],
    checkpoint: null,
    // 取消状态：executor.cancel() 或取消域命中都写这里，后续步骤统一消费。
    cancel: { active: false, scope: null, mode: null, reason: null, at: 0 },
    scopeStartedAt: new Map(),
  };
}

function thisClock(executor) {
  return executor.now();
}

/** 摘要一条执行报告的 digest（不含可变时间字段之外的东西：id/时间参与，保证每次运行有独立身份）。 */
function reportDigest(report) {
  return 'x' + stableHash(JSON.stringify({
    v: EXEC_VERSION,
    runId: report.runId,
    fingerprint: report.fingerprint,
    graph: report.graph ? report.graph.digest : '',
    status: report.status,
    steps: report.stats ? report.stats.steps : 0,
    branch: report.branchDecisions.map((item) => [item.index, item.label, item.to]),
    cancel: report.cancels.map((item) => [item.scope, item.mode, item.reason]),
    trace: report.traceDigest,
  }));
}

function addBlocker(run, code, message, extra = {}) {
  run.blockers.push({ severity: 'error', ...extra, code, message });
}

function addWarning(run, code, message, extra = {}) {
  run.warnings.push({ code, severity: 'warning', message, ...extra });
}

function traceOf(run, node, phase, status, extra = {}) {
  return run.trace.push({
    index: node.index,
    ref: node.ref,
    kind: node.kind,
    method: node.method,
    phase,
    status,
    attempts: extra.attempts || 1,
    at: run.simulatedAt,
    note: extra.note || '',
    params: node.params,
    ...(node.humanGate ? { humanGate: true } : {}),
    ...(extra.branch !== undefined ? { branch: extra.branch } : {}),
    ...(extra.parallel !== undefined ? { parallel: extra.parallel } : {}),
    ...(extra.cancel !== undefined ? { cancel: extra.cancel } : {}),
  });
}

function finalizeRun(run, statusInput, program) {
  const status = statusInput || run.status;
  const traceEntries = run.trace.entries();
  const traceSummary = run.trace.summary();
  const sealed = run.options.includeTrace ? run.trace.seal({ runId: run.runId, tab: run.options.runTag || null }) : null;
  const report = {
    version: EXEC_VERSION,
    mode: run.options.mode,
    dryRun: true,
    ok: status === EXEC_STATUS.COMPLETED,
    status,
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.simulatedAt,
    simulatedMs: Math.max(0, run.simulatedAt - run.startedAt),
    fingerprint: program ? program.fingerprint : '',
    graph: summarizeStepGraph(run.graph),
    program: program ? summarizeRecordProgram(program) : null,
    validation: program ? program.validation : null,
    trace: summarizeTrace(traceEntries),
    traceDigest: traceSummary.digest,
    ...(sealed ? { traceSealed: sealed } : {}),
    blockers: run.blockers.slice(0, 32),
    warnings: run.warnings.slice(0, 32),
    branchDecisions: run.branchDecisions.slice(0, 64),
    parallel: run.parallel.slice(0, 16),
    cancels: run.cancels.slice(0, 16),
    skipped: run.skipped.slice(-16),
    human: { ...run.human, policy: run.options.humanPolicy },
    budgets: { ...run.budgets, limits: run.limits },
    stats: {
      trace: traceEntries.length,
      steps: traceEntries.filter((entry) => entry.status !== TRACE_STATUSES.SKIPPED && entry.status !== TRACE_STATUSES.CANCELLED).length,
      serial: traceEntries.filter((entry) => entry.phase === TRACE_PHASES.SERIAL && entry.status !== TRACE_STATUSES.SKIPPED && entry.status !== TRACE_STATUSES.CANCELLED).length,
      parallel: traceEntries.filter((entry) => entry.phase === TRACE_PHASES.PARALLEL).length,
      branches: run.branchDecisions.length,
      cancels: run.cancels.length,
      retries: run.budgets.retries,
      blockers: run.blockers.length,
      warnings: run.warnings.length,
    },
    checkpoint: {
      batchIndex: run.checkpoint ? run.checkpoint.batchIndex : 0,
      simulatedAt: run.simulatedAt,
      traceDigest: traceSummary.digest,
    },
  };
  report.digest = reportDigest(report);
  return report;
}

function buildProgramFor(steps, options, provided) {
  if (provided && Array.isArray(provided.nodes)) return provided;
  return buildRecordProgram(steps, options && options.programOptions ? options.programOptions : {});
}

/**
 * 批次里的节点是 compact 形状（plan 输出用）；执行前按 index 还原成完整图节点，
 * 保证 fallback/params/humanGate 等执行期字段不丢。
 */
function resolveBatchNode(run, batchNode) {
  if (!batchNode || typeof batchNode !== 'object') return batchNode;
  const index = Number.isSafeInteger(batchNode.index) ? batchNode.index : -1;
  if (index >= 0 && run.graph && Array.isArray(run.graph.nodes) && run.graph.nodes[index]) return run.graph.nodes[index];
  return batchNode;
}

function executeSerialNode(run, node, phaseInput, parallelGroup) {
  node = resolveBatchNode(run, node);
  const phase = phaseInput || TRACE_PHASES.SERIAL;
  const scope = cancelScopeAt(run.graph, node.index);
  if (scope && !run.scopeStartedAt.has(scope.scope)) run.scopeStartedAt.set(scope.scope, run.simulatedAt);
  const elapsedInScope = scope ? run.simulatedAt - (run.scopeStartedAt.get(scope.scope) || run.startedAt) : 0;
  const cancelled = cancelDecision(run, scope, elapsedInScope, node);
  if (cancelled) {
    // 外部/回调取消代表“整个 run 停”，计时型取消只作用于当前取消域：
    // 否则 timeout 触发的 skip 会污染后续域外步骤（把正常步骤误判成 abort）。
    if (cancelled.trigger !== 'timeout') {
      run.cancel.active = true;
      run.cancel.scope = cancelled.scope;
      run.cancel.mode = cancelled.mode;
      run.cancel.reason = cancelled.reason;
    }
    const cancelEntry = { scope: cancelled.scope, mode: cancelled.mode, trigger: cancelled.trigger, reason: cancelled.reason, index: node.index, at: run.simulatedAt };
    if (!run.cancels.some((item) => item.scope === cancelEntry.scope && item.reason === cancelEntry.reason)) run.cancels.push(cancelEntry);
    if (cancelled.mode === CANCEL_MODES.ABORT) {
      traceOf(run, node, TRACE_PHASES.CANCEL, TRACE_STATUSES.CANCELLED, { note: '取消域 abort：' + cancelled.reason, cancel: cancelled.scope });
      run.skipped.push({ index: node.index, ref: node.ref, reason: 'cancelled-abort' });
      addBlocker(run, EXEC_CODES.EXEC_CANCELLED, 'dry-run 被取消（abort）', { scope: cancelled.scope, reason: cancelled.reason });
      return 'abort';
    }
    if (cancelled.mode === CANCEL_MODES.SKIP) {
      traceOf(run, node, TRACE_PHASES.CANCEL, TRACE_STATUSES.SKIPPED, { note: '取消域 skip：' + cancelled.reason, cancel: cancelled.scope });
      run.skipped.push({ index: node.index, ref: node.ref, reason: 'cancelled-skip' });
      return 'skip';
    }
    addWarning(run, EXEC_CODES.EXEC_CANCELLED, '取消域 continue：记录后继续', { scope: cancelled.scope, index: node.index });
  }
  run.simulatedAt += node.waitBeforeMs || 0;
  const simulated = simulateStep(run, node);
  run.budgets.steps += 1;
  // 重试次数由 simulateStep 统一记账（避免同一批重试被累计两次）。
  if (simulated.attempts > 1) run.budgets.retries = Math.max(run.budgets.retries, simulated.attempts - 1);
  if (simulated.human) run.budgets.humanGates += 1;
  if (run.budgets.steps > run.limits.maxSteps) {
    addBlocker(run, EXEC_CODES.EXEC_BUDGET_STEPS, 'dry-run 超过步数预算', { steps: run.budgets.steps, max: run.limits.maxSteps });
    return 'abort';
  }
  if (run.budgets.humanGates > run.limits.maxHumanGates) {
    addBlocker(run, EXEC_CODES.EXEC_HUMAN_LIMIT, 'human-gate 数量超过预算', { humanGates: run.budgets.humanGates, max: run.limits.maxHumanGates });
  }
  if (run.simulatedAt - run.startedAt > run.limits.maxDurationMs) {
    addBlocker(run, EXEC_CODES.EXEC_BUDGET_DURATION, 'dry-run 模拟耗时超过预算', { durationMs: run.simulatedAt - run.startedAt, max: run.limits.maxDurationMs });
    return 'abort';
  }
  traceOf(run, node, phase, simulated.status, {
    attempts: simulated.attempts,
    note: simulated.note,
    ...(parallelGroup ? { parallel: parallelGroup } : {}),
  });
  if (simulated.status === TRACE_STATUSES.FAILED) {
    addBlocker(run, simulated.code || EXEC_CODES.EXEC_FAILED_STEP, '步骤失败：' + (simulated.note || node.method), { index: node.index, ref: node.ref, method: node.method });
    if (run.options.failStrategy === 'stop') return 'abort';
    if (run.options.failStrategy === 'skip') {
      run.skipped.push({ index: node.index, ref: node.ref, reason: 'fail-strategy-skip' });
      return 'skip';
    }
    return 'continue';
  }
  if (simulated.status === TRACE_STATUSES.BLOCKED) {
    addBlocker(run, simulated.code || EXEC_CODES.EXEC_HUMAN_REQUIRED, 'dry-run 在 human-gate 阻断', { index: node.index, ref: node.ref });
    return run.options.humanPolicy === 'block' ? 'abort' : 'continue';
  }
  if (simulated.status === TRACE_STATUSES.SKIPPED) run.skipped.push({ index: node.index, ref: node.ref, reason: 'fallback-skip' });
  return 'continue';
}

function executeBranchBatch(run, batch) {
  // 录制参数里的 url 只是“录制时看到的地址”；dry-run 给出的事实（facts）优先，
  // 否则“无命中 → fallthrough”的分支永远会命中录制时的 url。
  const recorded = run.graph.nodes[batch.index] && isPlainObject(run.graph.nodes[batch.index].params)
    ? run.graph.nodes[batch.index].params
    : {};
  const facts = { ...recorded, ...run.options.facts };
  const branch = { index: batch.index, ref: batch.ref, options: batch.options, fallthrough: batch.fallthrough };
  const decided = resolveBranchDecision(branch, facts);
  run.simulatedAt += 0;
  traceOf(run, { index: batch.index, ref: batch.ref, kind: 'branch', method: 'branch', params: {}, target: null, humanGate: null }, TRACE_PHASES.BRANCH, TRACE_STATUSES.OK, {
    note: decided.matched ? '命中分支 ' + decided.label : '无命中，顺序执行',
    branch: decided.label || 'fallthrough',
  });
  run.branchDecisions.push({
    index: batch.index,
    ref: batch.ref,
    label: decided.label,
    to: decided.to,
    matched: decided.matched,
    reason: decided.reason,
  });
  if (decided.to != null && decided.to > batch.index) {
    // dry-run 不在批次流里跳跃（跳转会跳过 shouldCancel/预算检查），只记录目标；
    // 回放器按 branches 里的 to 自行跳转，这里保证“目标存在”已在校验阶段证明。
    addWarning(run, EXEC_CODES.EXEC_BRANCH_UNRESOLVED, '分支目标跳过中间步骤（回放按目标执行）', { index: batch.index, to: decided.to });
  }
  return 'continue';
}

function executeParallelBatch(run, batch) {
  const group = batch.groupId;
  const armResults = [];
  const mode = PARALLEL_MODE_LIST.includes(batch.waitFor) ? batch.waitFor : PARALLEL_MODES.ALL;
  run.simulatedAt += 0;
  for (let armIndex = 0; armIndex < batch.arms.length; armIndex += 1) {
    const arm = batch.arms[armIndex];
    const armLines = [];
    let armStatus = TRACE_STATUSES.OK;
    for (const node of arm.steps) {
      if (run.cancel.active && run.cancel.mode === CANCEL_MODES.ABORT) {
        armLines.push({ index: node.index, ref: node.ref, status: TRACE_STATUSES.CANCELLED });
        armStatus = TRACE_STATUSES.CANCELLED;
        continue;
      }
      const outcome = executeSerialNode(run, node, TRACE_PHASES.PARALLEL, group);
      const lastEntry = run.trace.entries()[run.trace.size() - 1];
      armLines.push({ index: node.index, ref: node.ref, status: lastEntry ? lastEntry.status : TRACE_STATUSES.OK });
      if (outcome === 'abort') {
        armStatus = run.cancel.active ? TRACE_STATUSES.CANCELLED : TRACE_STATUSES.FAILED;
        break;
      }
      if (outcome === 'skip') {
        armStatus = TRACE_STATUSES.SKIPPED;
        break;
      }
      if (lastEntry && lastEntry.status === TRACE_STATUSES.FAILED) {
        armStatus = TRACE_STATUSES.FAILED;
        if (batch.failFast) break;
      }
    }
    armResults.push({ arm: arm.arm, status: armStatus, steps: armLines.length, refs: arm.steps.map((node) => node.ref) });
    if (mode === PARALLEL_MODES.RACE && armStatus === TRACE_STATUSES.OK) break;
    if (mode === PARALLEL_MODES.ANY && armStatus === TRACE_STATUSES.OK) break;
    if (batch.failFast && armStatus === TRACE_STATUSES.FAILED) {
      run.cancels.push({ scope: group, mode: CANCEL_MODES.ABORT, trigger: 'fail-fast', reason: '并发 arm 失败', at: run.simulatedAt });
      break;
    }
  }
  run.parallel.push({
    groupId: group,
    waitFor: mode,
    arms: armResults,
    completed: batch.joinIndex != null,
  });
  const failed = armResults.filter((arm) => arm.status === TRACE_STATUSES.FAILED).length;
  const ok = armResults.filter((arm) => arm.status === TRACE_STATUSES.OK).length;
  if (mode === PARALLEL_MODES.ALL && failed > 0) {
    addBlocker(run, EXEC_CODES.EXEC_PARALLEL_TIMEOUT, '并发区有 arm 失败（waitFor=all）', { groupId: group, failed, arms: armResults.length });
    return 'abort';
  }
  if (mode !== PARALLEL_MODES.ALL && ok === 0) {
    addBlocker(run, EXEC_CODES.EXEC_PARALLEL_TIMEOUT, '并发区没有成功 arm', { groupId: group, mode, arms: armResults.length });
    return 'abort';
  }
  if (batch.joinIndex == null) {
    addWarning(run, EXEC_CODES.EXEC_PARALLEL_NO_JOIN, '并发区没有 join（按最后一个 arm 结束）', { groupId: group });
  }
  return run.cancel.active && run.cancel.mode === CANCEL_MODES.ABORT ? 'abort' : 'continue';
}

function batchLabel(batch) {
  if (!batch) return 'unknown';
  if (batch.kind === BATCH_KINDS.PARALLEL) return 'parallel:' + batch.groupId;
  if (batch.kind === BATCH_KINDS.BRANCH) return 'branch:' + (batch.ref || batch.index);
  return 'serial:' + (batch.index != null ? batch.index : '?');
}

/** 只读：批次的可读标签（诊断/测试用）。 */
export function describeBatch(batch) {
  return batchLabel(batch);
}

/**
 * 创建录制 program 执行器（时钟/ID/容量可注入，便于单测与 record-events 热路径共用）。
 * @param {{now?: () => number}} [options]
 */
export function createRecordExecutor(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const runs = new Map();
  const order = [];
  const stats = { runs: 0, completed: 0, blocked: 0, cancelled: 0, failed: 0, resumed: 0, badArgs: 0, steps: 0, cancels: 0 };

  function register(run) {
    runs.set(run.runId, run);
    order.push(run.runId);
    while (order.length > EXEC_LIMITS.maxRuns) {
      const oldest = order.shift();
      runs.delete(oldest);
    }
    stats.runs += 1;
  }

  function finish(run, status, program) {
    run.status = status;
    if (status === EXEC_STATUS.COMPLETED) stats.completed += 1;
    else if (status === EXEC_STATUS.BLOCKED) stats.blocked += 1;
    else if (status === EXEC_STATUS.CANCELLED) stats.cancelled += 1;
    else if (status === EXEC_STATUS.FAILED) stats.failed += 1;
    stats.steps += run.budgets.steps;
    const report = finalizeRun(run, status, program);
    run.report = report;
    return report;
  }

  /**
   * 内存执行一次 program（不真的做动作）。
   * @param {Array|object} stepsOrProgram step 数组 / program / {steps} / {nodes}
   * @param {object} [runOptions]
   */
  function dryRun(stepsOrProgram, runOptions = {}) {
    const runOptionsNormalized = normalizeRunOptions(runOptions);
    const graph = buildStepGraph(
      isPlainObject(stepsOrProgram) && Array.isArray(stepsOrProgram.nodes) ? stepsOrProgram.nodes : stepsOrProgram,
      isPlainObject(runOptions.graph) ? runOptions.graph : (isPlainObject(options.graph) ? options.graph : {}),
    );
    const program = buildProgramFor(stepsOrProgram, options, runOptionsNormalized.program
      || (isPlainObject(stepsOrProgram) && Array.isArray(stepsOrProgram.nodes) ? stepsOrProgram : null));
    const run = createRun(executorFacade, runOptionsNormalized, graph, program);
    register(run);
    if (!graph.nodes.length) {
      addBlocker(run, EXEC_CODES.EXEC_EMPTY, '没有可执行步骤');
      return finish(run, EXEC_STATUS.BLOCKED, program);
    }
    const graphCheck = validateStepGraph(graph);
    if (!graphCheck.ok) {
      for (const issue of graphCheck.issues.filter((item) => item.severity === 'error')) {
        addBlocker(run, issue.code || EXEC_CODES.EXEC_GRAPH, issue.message, { index: issue.index, ref: issue.ref, scope: issue.scope, groupId: issue.groupId });
      }
    }
    if (program && program.validation && program.validation.ok === false) {
      for (const issue of (program.validation.issues || []).filter((item) => item.severity === 'error')) {
        addBlocker(run, EXEC_CODES.EXEC_VALIDATION, issue.message, { index: issue.index, issue: issue.code });
      }
    }
    if (run.blockers.length) {
      traceOf(run, graph.nodes[0], TRACE_PHASES.SERIAL, TRACE_STATUSES.BLOCKED, { note: '图形/程序校验失败' });
      return finish(run, EXEC_STATUS.BLOCKED, program);
    }
    const batches = graph.schedule;
    let outcome = 'continue';
    const startAt = Math.min(runOptionsNormalized.startAtBatch, batches.length);
    for (let batchIndex = startAt; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      if (run.cancel.active && run.cancel.mode === CANCEL_MODES.ABORT) {
        outcome = 'abort';
        break;
      }
      if (batch.kind === BATCH_KINDS.PARALLEL) outcome = executeParallelBatch(run, batch);
      else if (batch.kind === BATCH_KINDS.BRANCH) outcome = executeBranchBatch(run, batch);
      else outcome = executeSerialNode(run, batch.node);
      run.checkpoint = { batchIndex: batchIndex + 1, simulatedAt: run.simulatedAt };
      if (outcome === 'abort') break;
    }
    if (outcome === 'abort' && run.cancel.active) {
      // 被取消时把剩余步骤记成 skipped（证据里能回答“取消后还有多少没跑”）。
      for (let index = run.checkpoint ? run.checkpoint.batchIndex : 0; index < batches.length; index += 1) {
        const batch = batches[index];
        if (batch.kind === BATCH_KINDS.SERIAL) run.skipped.push({ index: batch.node.index, ref: batch.node.ref, reason: 'after-cancel' });
        if (batch.kind === BATCH_KINDS.PARALLEL) for (const arm of batch.arms) for (const node of arm.steps) run.skipped.push({ index: node.index, ref: node.ref, reason: 'after-cancel' });
      }
      stats.cancels += 1;
      return finish(run, EXEC_STATUS.CANCELLED, program);
    }
    const humanBlocked = run.blockers.some((item) => item.code === EXEC_CODES.EXEC_HUMAN_REQUIRED);
    const cancelTriggered = run.blockers.some((item) => item.code === EXEC_CODES.EXEC_CANCELLED);
    let status;
    if (cancelTriggered) status = EXEC_STATUS.CANCELLED;
    else if (run.blockers.some((item) => item.severity === 'error')) status = humanBlocked || run.budgets.steps === 0 ? EXEC_STATUS.BLOCKED : EXEC_STATUS.FAILED;
    else status = EXEC_STATUS.COMPLETED;
    return finish(run, status, program);
  }

  /**
   * 只读规划：不执行、不写轨迹，返回批次/分支/并发/取消/回放计划。
   */
  function plan(stepsOrProgram, planOptions = {}) {
    const graph = buildStepGraph(
      isPlainObject(stepsOrProgram) && Array.isArray(stepsOrProgram.nodes) ? stepsOrProgram.nodes : stepsOrProgram,
      isPlainObject(planOptions.graph) ? planOptions.graph : {},
    );
    const program = buildProgramFor(stepsOrProgram, options, isPlainObject(stepsOrProgram) && Array.isArray(stepsOrProgram.nodes) ? stepsOrProgram : null);
    const batches = planStepBatches(graph);
    return {
      version: EXEC_VERSION,
      ok: validateStepGraph(graph).ok,
      fingerprint: program ? program.fingerprint : '',
      graph: summarizeStepGraph(graph),
      graphDigest: stepGraphDigest(graph),
      batches: batches.slice(0, 400).map((batch) => ({
        kind: batch.kind,
        ...(batch.index != null ? { index: batch.index } : {}),
        ...(batch.ref ? { ref: batch.ref } : {}),
        ...(batch.node ? { node: batch.node } : {}),
        ...(batch.groupId ? { groupId: batch.groupId, forkIndex: batch.forkIndex, joinIndex: batch.joinIndex, waitFor: batch.waitFor, arms: batch.arms.map((arm) => ({ arm: arm.arm, refs: arm.steps.map((stepValue) => stepValue.ref) })) } : {}),
        ...(batch.options ? { options: batch.options.map((option) => ({ label: option.label, to: option.to })) } : {}),
      })),
      branchPoints: graph.branches.map((branch) => ({ index: branch.index, ref: branch.ref, options: branch.options.length, fallthrough: branch.fallthrough })),
      parallelGroups: graph.parallel.map((region) => ({ groupId: region.groupId, forkIndex: region.forkIndex, joinIndex: region.joinIndex, waitFor: region.waitFor, arms: region.arms.length })),
      cancelScopes: graph.cancels.map((scope) => ({ scope: scope.scope, from: scope.from, to: scope.to, mode: scope.mode, afterMs: scope.afterMs })),
      humanSteps: graph.nodes.filter((node) => Boolean(node.humanGate)).map((node) => ({ index: node.index, ref: node.ref, valueKind: node.humanGate.valueKind || '' })),
      stats: {
        batches: batches.length,
        serial: batches.filter((batch) => batch.kind === BATCH_KINDS.SERIAL).length,
        parallel: batches.filter((batch) => batch.kind === BATCH_KINDS.PARALLEL).length,
        branches: batches.filter((batch) => batch.kind === BATCH_KINDS.BRANCH).length,
      },
    };
  }

  /**
   * 回放前置（v2）：复用线性 preflightReplay（原字段/判定不变），叠加图形/并发/取消/执行器阻断。
   * @returns {object} base preflight 字段 + preflight v2 字段
   */
  function preflight(stepsOrProgram, preflightOptions = {}) {
    const base = preflightReplay(stepsOrProgram, preflightOptions);
    const steps = isPlainObject(stepsOrProgram) && Array.isArray(stepsOrProgram.nodes) ? stepsOrProgram.nodes : stepsOrProgram;
    const graph = buildStepGraph(steps, isPlainObject(preflightOptions.graph) ? preflightOptions.graph : {});
    const graphCheck = validateStepGraph(graph);
    const extraBlockers = [];
    const extraWarnings = [];
    for (const issue of graphCheck.issues) {
      if (issue.severity === 'error') extraBlockers.push({ code: EXEC_CODES.EXEC_GRAPH, severity: 'error', message: issue.message, issue: issue.code, index: issue.index, ref: issue.ref });
      else extraWarnings.push({ code: issue.code, severity: 'warning', message: issue.message, index: issue.index, ref: issue.ref });
    }
    for (const region of graph.parallel) {
      if (region.joinIndex == null) extraBlockers.push({ code: EXEC_CODES.EXEC_PARALLEL_NO_JOIN, severity: 'error', message: '并发区缺少 join，回放顺序不可复现', groupId: region.groupId });
      if (region.arms.length > EXEC_LIMITS.maxParallelArms) extraBlockers.push({ code: EXEC_CODES.EXEC_GRAPH, severity: 'error', message: '并发宽度超过执行器上限', groupId: region.groupId, arms: region.arms.length });
    }
    for (const scope of graph.cancels) {
      const overlapping = graph.issues.some((issue) => issue.code === 'CANCEL_SCOPE_OVERLAP' && (issue.left === scope.scope || issue.right === scope.scope));
      if (overlapping) {
        extraBlockers.push({ code: EXEC_CODES.EXEC_CANCEL_UNKNOWN_SCOPE, severity: 'error', message: '取消域语义有歧义（与其他取消域部分重叠）', scope: scope.scope });
      }
    }
    const blockers = [...(base.blockers || []), ...extraBlockers];
    const warnings = [...(base.warnings || []), ...extraWarnings];
    const requiredHuman = graph.nodes.filter((node) => Boolean(node.humanGate) && (!node.params || node.params.value === undefined || node.params.value === '')).length;
    if (requiredHuman > EXEC_LIMITS.maxHumanGates) {
      blockers.push({ code: EXEC_CODES.EXEC_HUMAN_LIMIT, severity: 'error', message: 'human-gate 数量超过执行器上限', humanGates: requiredHuman });
    }
    const planResult = plan(stepsOrProgram, { graph: preflightOptions.graph });
    const executable = blockers.length === 0;
    return {
      ...base,
      ok: executable,
      allowed: executable,
      executable,
      graph: summarizeStepGraph(graph),
      graphDigest: stepGraphDigest(graph),
      graphValidation: { ok: graphCheck.ok, errors: graphCheck.errors, warnings: graphCheck.warnings, byCode: graphCheck.byCode },
      blocks: blockers,
      blockers,
      warnings,
      plan: planResult,
      preflight: {
        version: EXEC_VERSION,
        requiredHuman,
        parallelGroups: graph.parallel.length,
        cancelScopes: graph.cancels.length,
        branchPoints: graph.branches.length,
        batches: planResult.stats.batches,
        extraBlockers: extraBlockers.length,
        extraWarnings: extraWarnings.length,
        rules_evaluated: 18,
      },
      replayPlanV2: planResult.batches,
    };
  }

  /** 从 checkpoint 继续 dry-run（同一 program；人工值/取消状态需重新传入）。 */
  function resume(report, stepsOrProgram, runOptions = {}) {
    if (!report || !report.checkpoint) {
      stats.badArgs += 1;
      return { ok: false, code: EXEC_CODES.EXEC_BAD_ARG, status: EXEC_STATUS.BLOCKED, error: 'resume 需要带 checkpoint 的 dry-run 报告' };
    }
    stats.resumed += 1;
    return dryRun(stepsOrProgram, {
      ...runOptions,
      startAtBatch: report.checkpoint.batchIndex,
      initialSimulatedAt: report.checkpoint.simulatedAt,
      tag: runOptions.tag || (report.runId + '-resume'),
    });
  }

  /** 校验执行报告 digest（事后发现报告/轨迹被改动）。 */
  function verify(report) {
    if (!report || typeof report !== 'object') return { ok: false, code: EXEC_CODES.EXEC_BAD_ARG, error: '报告缺失' };
    const expected = reportDigest(report);
    const traceCheck = report.traceSealed ? verifyTrace(report.traceSealed) : { ok: true, count: report.trace ? report.trace.count : 0 };
    return {
      ok: expected === report.digest && traceCheck.ok,
      digestOk: expected === report.digest,
      traceOk: traceCheck.ok,
      trace: traceCheck,
      expected,
      actual: report.digest,
    };
  }

  /** 取消当前/最近一次运行（外部中止；dry-run 会在下一个批次消费）。 */
  function cancel(reason = 'cancelled') {
    const runId = order.length ? order[order.length - 1] : null;
    const run = runId ? runs.get(runId) : null;
    if (!run) return { ok: false, code: EXEC_CODES.EXEC_BAD_ARG, error: '没有可取消的运行' };
    run.cancel.active = true;
    run.cancel.mode = CANCEL_MODES.ABORT;
    run.cancel.reason = clip(reason, 120);
    run.cancel.at = run.simulatedAt;
    return { ok: true, runId: run.runId, reason: run.cancel.reason, at: run.cancel.at };
  }

  /** 两次 dry-run 轨迹 diff（同一 program 的确定性检查）。 */
  function diffReports(left, right) {
    const leftTrace = left && left.traceSealed ? left.traceSealed : null;
    const rightTrace = right && right.traceSealed ? right.traceSealed : null;
    if (!leftTrace || !rightTrace) {
      return diffTraces(left && left.branchDecisions ? left.branchDecisions : [], right && right.branchDecisions ? right.branchDecisions : []);
    }
    return diffTraces(leftTrace.entries, rightTrace.entries);
  }

  function reportOf(runId) {
    const run = runs.get(runId);
    return run ? run.report || null : null;
  }

  function list() {
    return order.map((runId) => {
      const run = runs.get(runId);
      return run && run.report ? run.report : null;
    }).filter(Boolean);
  }

  function counters() {
    return { ...stats, active: runs.size };
  }

  function reset() {
    const cleared = runs.size;
    runs.clear();
    order.length = 0;
    return { ok: true, cleared };
  }

  const executorFacade = {
    dryRun,
    plan,
    preflight,
    resume,
    verify,
    cancel,
    diffReports,
    reportOf,
    list,
    counters,
    reset,
    now,
    get lastRun() { return order.length ? runs.get(order[order.length - 1]) : null; },
  };
  return executorFacade;
}

/** 一次 dry-run 的紧凑摘要（挂到录制事件；体积有界）。 */
export function summarizeExecReport(report) {
  if (!report || typeof report !== 'object') return null;
  const trace = report.trace && typeof report.trace === 'object' ? report.trace : {};
  const stats = report.stats && typeof report.stats === 'object' ? report.stats : {};
  const summary = {
    version: EXEC_VERSION,
    digest: String(report.digest || ''),
    status: String(report.status || ''),
    trace: {
      count: nonNegative(trace.count),
      digest: String(trace.digest || ''),
      retries: nonNegative(trace.retries),
      humanGates: nonNegative(trace.humanGates),
      cancels: nonNegative(trace.cancels),
      ok: trace.ok === true,
    },
    steps: nonNegative(stats.steps),
    branches: nonNegative(stats.branches),
    parallel: nonNegative(stats.parallel),
    cancels: nonNegative(stats.cancels),
    blockers: Array.isArray(report.blockers) ? report.blockers.slice(0, 4).map((item) => ({ code: item.code, severity: item.severity, ...(item.index != null ? { index: item.index } : {}) })) : [],
    fingerprint: String(report.fingerprint || ''),
    ...(report.human && report.human.required > 0 ? { requiresHuman: report.human.required } : {}),
  };
  return summary;
}

/** 一行文本摘要：诊断/CLI 用。 */
export function describeExecReport(report) {
  if (!report || typeof report !== 'object') return 'record-exec: 无报告';
  const parts = ['exec=' + (report.status || '?')];
  const stats = report.stats || {};
  parts.push('steps=' + nonNegative(stats.steps));
  if (stats.branches > 0) parts.push('branches=' + stats.branches);
  if (stats.parallel > 0) parts.push('parallel=' + stats.parallel);
  if (stats.cancels > 0) parts.push('cancels=' + stats.cancels);
  if (stats.retries > 0) parts.push('retries=' + stats.retries);
  if (report.human && report.human.required > 0) parts.push('human=' + report.human.required);
  if (Array.isArray(report.blockers) && report.blockers.length) parts.push('blockers=' + report.blockers.length);
  if (report.digest) parts.push('digest=' + report.digest);
  return parts.join(' ');
}

/** 便捷入口：一次性 dry-run（无长生命周期状态，record-events 采样用）。 */
export function dryRunProgram(stepsOrProgram, options = {}) {
  return createRecordExecutor(options && options.executor).dryRun(stepsOrProgram, options);
}

/** 便捷入口：只读规划。 */
export function planProgram(stepsOrProgram, options = {}) {
  return createRecordExecutor(options && options.executor).plan(stepsOrProgram, options);
}

/** 便捷入口：回放前置 v2。 */
export function preflightProgram(stepsOrProgram, options = {}) {
  return createRecordExecutor(options && options.executor).preflight(stepsOrProgram, options);
}

/** 轨迹相关工具按原 API 重导出，调用方只 import 执行器即可。 */
export {
  createTraceRecorder,
  describeTrace,
  diffTraces,
  formatTrace,
  sealTrace,
  summarizeTrace,
  verifyTrace,
};

/** 供单元测试复用：把 program 的指纹/执行报告拼成对账键。 */
export function execReconciliationKey(report, program) {
  const runDigest = report && report.digest ? String(report.digest) : '';
  const fingerprint = program ? programFingerprint(program) : (report && report.fingerprint ? String(report.fingerprint) : '');
  return 'r1-' + stableHash([fingerprint, runDigest].join('|'));
}

/** 供 record-events 的采样点复用：一次调用同时产出摘要与文本（避免重复 build）。 */
export function sampledExec(stepsOrProgram, options = {}) {
  const report = dryRunProgram(stepsOrProgram, options);
  return {
    report,
    summary: summarizeExecReport(report),
    text: describeExecReport(report),
  };
}

/** 只读：program 是否含并发/取消/多分支（决定是否值得在录制热路径上采样）。 */
export function programHasGraphFeatures(stepsOrProgram) {
  const steps = isPlainObject(stepsOrProgram) && Array.isArray(stepsOrProgram.nodes) ? stepsOrProgram.nodes : stepsOrProgram;
  const graph = buildStepGraph(steps);
  return {
    parallel: graph.parallel.length > 0,
    cancels: graph.cancels.length > 0,
    branches: graph.branches.some((branch) => branch.options.length > 0),
    graph: summarizeStepGraph(graph),
  };
}

/** 校验一个已构造的 program+report 对是否一致（record-events 采样后自检用）。 */
export function verifyExecPair(report, program) {
  const executor = createRecordExecutor();
  const result = executor.verify(report);
  return {
    ...result,
    key: execReconciliationKey(report, program),
    fingerprintMatches: Boolean(program && report && program.fingerprint === report.fingerprint),
  };
}

/** 只读：把报告转成 CLI 可打印的行（有上限）。 */
export function formatExecReport(report, options = {}) {
  if (!report || typeof report !== 'object') return ['record-exec: 无报告'];
  const lines = [describeExecReport(report)];
  const maxLines = Math.max(1, integer(options.maxLines, 40));
  if (report.traceSealed) {
    for (const line of formatTrace(report.traceSealed, { maxLines: Math.max(1, maxLines - 1) }).split('\n')) lines.push('  ' + line);
  }
  for (const blocker of (Array.isArray(report.blockers) ? report.blockers : []).slice(0, Math.max(0, maxLines - lines.length))) {
    lines.push('  blocker ' + blocker.code + (blocker.index != null ? '@' + blocker.index : '') + ' ' + clip(blocker.message, 120));
  }
  return lines.slice(0, maxLines);
}
