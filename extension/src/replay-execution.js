// extension/src/replay-execution.js —— 回放执行包装（第二轮：确定性执行/观测 diff/边界执行/失败矩阵）。
//
// 本文件承接 replay.js 的第二轮部分：执行选项与失败矩阵证据助手、
// replayNetworkCommandTwice / replayBoundaryCommand / replayObservationCommand /
// replayFailureMatrixCommand / replayExecutionCapabilities，以及第二轮附加字段常量。
// 只 import replay-plan.js 与 lib/replay-*.js（不 import replay.js，避免循环）；
// replay.js 通过 re-export 保持公开 API 不变。

import { stableHash } from './record-steps.js';
import { planNetworkReplay, extractNetworkReplay, REPLAY_SOURCES, isPlainObject, planRecordReplay, withReplayFields, buildReplayField } from './replay-plan.js';
import { explainFailure } from './lib/replay-explain.js';
import { REPLAY_EXECUTOR_VERSION, EXECUTOR_CODES, buildExecutionEnvelope, compareExecutions, comparePlanFingerprints, executionEnvelopeFingerprint, recordExecutionOutcomes, summarizeExecution, summarizeSideEffects, sideEffectSemantics } from './lib/replay-executor.js';
import { REPLAY_BOUNDARY_EXEC_VERSION, evaluateBoundaryExecution, executeBoundaryRestoration, explainBoundaryExecution, summarizeBoundaryExecution } from './lib/replay-boundary-exec.js';
import { REPLAY_OBSERVATION_VERSION, consumeReplayObservation, diffReplayObservations, evaluateReplayObservation, normalizeReplayObservation, summarizeObservation, summarizeObservationVerdict } from './lib/replay-diff-exec.js';
import { REPLAY_FAILURE_MATRIX_VERSION, MATRIX_CODES, attachMatrixRecovery, classifyReplayFailure, recoveryPlanFor, runFailureMatrix, verifyFailureMatrixCatalog } from './lib/replay-failure-matrix.js';

/** 第二轮附加字段/版本：执行轨迹、观测 diff、边界执行、失败矩阵。默认行为不变。 */
export const REPLAY_EXECUTION_FIELD = 'replayExecution';
export const REPLAY_EXECUTION_VERSION = REPLAY_EXECUTOR_VERSION;
export const REPLAY_BOUNDARY_EXECUTION_VERSION = REPLAY_BOUNDARY_EXEC_VERSION;
export const REPLAY_OBSERVATION_EXEC_VERSION = REPLAY_OBSERVATION_VERSION;
export const REPLAY_FAILURE_MATRIX_VERSION_OUT = REPLAY_FAILURE_MATRIX_VERSION;

/** 回放失败矩阵的公开错误码（供 CLI/测试引用；不新增 RPC 方法）。 */
export const REPLAY_MATRIX_CODES = MATRIX_CODES;

/** 从包装层选项里收集“观测/expect 判定”参数（只取已知键）。 */
function replayDiffOptions(options) {
  const source = isPlainObject(options) ? options : {};
  const execution = isPlainObject(source.execution) ? source.execution : {};
  const diff = isPlainObject(source.diff) ? source.diff : {};
  const merged = {
    expect: source.expect !== undefined ? source.expect : (execution.expect !== undefined ? execution.expect : diff.expect),
    tolerance: source.tolerance !== undefined ? source.tolerance : (execution.tolerance !== undefined ? execution.tolerance : diff.tolerance),
    volatileJsonPaths: source.volatileJsonPaths || execution.volatileJsonPaths || diff.volatileJsonPaths,
    ignoreHeaders: source.ignoreHeaders || execution.ignoreHeaders || diff.ignoreHeaders,
    ignoreQuery: source.ignoreQuery === true || execution.ignoreQuery === true || diff.ignoreQuery === true,
    requireAllItems: source.requireAllItems !== undefined ? source.requireAllItems : (execution.requireAllItems !== undefined ? execution.requireAllItems : diff.requireAllItems),
  };
  const out = {};
  for (const key of Object.keys(merged)) if (merged[key] !== undefined) out[key] = merged[key];
  return out;
}

/**
 * 可选边界执行（opt-in）：options.boundaryExecution = {trace, current?, frames?, mode?,
 * providers?, execute?}。执行器缺省只做判定（evaluate），有 providers 且 execute:true 才动作。
 */
async function boundaryExecutionField(options, plan) {
  const spec = isPlainObject(options && options.boundaryExecution) ? options.boundaryExecution : null;
  if (!spec) return null;
  const trace = spec.trace !== undefined ? spec.trace : (Array.isArray(spec.entries) ? spec.entries : []);
  const context = { current: spec.current, frames: spec.frames, mode: spec.mode, requireUrl: spec.requireUrl === true };
  if (spec.execute === true && isPlainObject(spec.providers)) {
    return executeBoundaryRestoration(plan || null, trace, spec.providers, { ...context, continueOnBlock: spec.continueOnBlock === true });
  }
  return evaluateBoundaryExecution(plan || null, trace, context);
}

/** 失败矩阵证据：把一次失败分类成“能不能安全重试 + 恢复动作”。 */
function matrixEvidenceOf(error, plan, options) {
  const method = String((plan && plan.network && plan.network.method) || (options && options.method) || 'GET').toUpperCase();
  const classification = classifyReplayFailure(error, { method, plan });
  const recovery = recoveryPlanFor(classification);
  return {
    ...classification,
    recovery: {
      ok: recovery.ok,
      primary: recovery.primary ? recovery.primary.action : '',
      actions: recovery.actions.map((item) => item.action),
      retry: recovery.retry,
      stopRecommended: recovery.stopRecommended,
    },
  };
}

/** 把执行证据挂到原异常上（不可枚举；错误码/信息不变）。 */
function attachExecutionEvidenceToError(error, evidence) {
  if (!error || typeof error !== 'object') return error;
  try {
    Object.defineProperty(error, REPLAY_EXECUTION_FIELD, {
      value: evidence,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // 冻结/宿主异常：保留主错误优先。
  }
  return error;
}

/** 从错误上读执行证据（没有则 null）。 */
export function replayExecutionOf(errorOrResult) {
  if (!errorOrResult || typeof errorOrResult !== 'object') return null;
  const value = errorOrResult[REPLAY_EXECUTION_FIELD];
  return isPlainObject(value) ? value : null;
}

/** 观测 + expect 判定 + 执行记账（真实命令路径共用）。 */
function observeNetworkReplay(params, options, plan, result) {
  const facts = extractNetworkReplay(params, { current: options.current, overrides: options.overrides });
  const observation = normalizeReplayObservation(result, {
    request: { method: facts.method, url: facts.url },
    plan,
  });
  const verdict = evaluateReplayObservation(plan, observation, replayDiffOptions(options));
  const execution = recordExecutionOutcomes(plan, [{ value: result, verdict }], { source: REPLAY_SOURCES.NETWORK });
  return { observation, verdict, execution };
}

/**
 * 同一输入执行两次并比较（诊断/确定性证明用；显式调用，默认命令路径绝不双发）。
 * 默认执行器是既有 networkReplay；单测/调用方可注入 options.execute。
 * @param {object} params 既有 network.replay 入参
 * @param {{execute?:Function, current?:object, frames?:Array<object>, salt?:string,
 *          expect?:object, tolerance?:object|string}} [options]
 * @returns {Promise<object>} 不抛异常：两次失败都收敛成可解释字段
 */
export async function replayNetworkCommandTwice(params, options = {}) {
  const execute = typeof options.execute === 'function' ? options.execute : networkReplay;
  const runOnce = async () => {
    const plan = planNetworkReplay(params, options);
    const envelope = buildExecutionEnvelope(plan, { source: REPLAY_SOURCES.NETWORK });
    try {
      const result = await execute(params);
      const { observation, verdict, execution } = observeNetworkReplay(params, options, plan, result);
      return {
        ok: true,
        plan,
        envelope,
        execution,
        observation,
        verdict,
        digest: execution.digest,
      };
    } catch (error) {
      const explanation = explainFailure({ error, plan });
      const failure = matrixEvidenceOf(error, plan, options);
      attachMatrixRecovery(explanation, failure);
      return {
        ok: false,
        plan,
        envelope,
        error: { code: String(error && error.code || ''), message: String(error && error.message || '').slice(0, 200) },
        explanation,
        failure,
        digest: stableHash([envelope.fingerprint, 'failure', failure.code].join('|')),
      };
    }
  };
  const first = await runOnce();
  const second = await runOnce();
  const planComparison = comparePlanFingerprints(first.plan, second.plan);
  const sideFirst = summarizeSideEffects(sideEffectSemantics(first.plan));
  const sideSecond = summarizeSideEffects(sideEffectSemantics(second.plan));
  const sideEffectsSame = sideFirst.digest === sideSecond.digest && sideFirst.mutating === sideSecond.mutating;
  const envelopeSame = first.envelope.fingerprint === second.envelope.fingerprint;
  const outcomeSame = first.ok === second.ok
    && (first.ok ? true : (first.failure && second.failure ? first.failure.code === second.failure.code : false));
  let comparison = null;
  let observationDiff = null;
  if (first.ok && second.ok) {
    comparison = compareExecutions(first.execution, second.execution);
    observationDiff = diffReplayObservations(first.observation, second.observation, replayDiffOptions(options));
  }
  const deterministic = planComparison.same && envelopeSame && sideEffectsSame && outcomeSame;
  const digest = stableHash([
    REPLAY_EXECUTION_VERSION,
    planComparison.same ? 'plan' : 'plan-x',
    envelopeSame ? 'env' : 'env-x',
    sideEffectsSame ? 'side' : 'side-x',
    outcomeSame ? 'outcome' : 'outcome-x',
    String(first.digest || ''),
    String(second.digest || ''),
  ].join('|'));
  return {
    version: REPLAY_EXECUTION_VERSION,
    ok: deterministic && first.ok === true,
    deterministic,
    plans: {
      same: planComparison.same,
      first: planComparison.left,
      second: planComparison.right,
    },
    envelopes: {
      same: envelopeSame,
      first: first.envelope.fingerprint,
      second: second.envelope.fingerprint,
    },
    sideEffects: { same: sideEffectsSame, first: sideFirst, second: sideSecond },
    comparison,
    observationDiff,
    first: {
      ok: first.ok,
      execution: first.ok ? summarizeExecution(first.execution) : null,
      observation: first.ok ? summarizeObservation(first.observation) : null,
      verdict: first.ok ? summarizeObservationVerdict(first.verdict) : null,
      failure: first.ok ? null : first.failure,
      explanation: first.ok ? null : first.explanation,
    },
    second: {
      ok: second.ok,
      execution: second.ok ? summarizeExecution(second.execution) : null,
      observation: second.ok ? summarizeObservation(second.observation) : null,
      verdict: second.ok ? summarizeObservationVerdict(second.verdict) : null,
      failure: second.ok ? null : second.failure,
      explanation: second.ok ? null : second.explanation,
    },
    digest,
  };
}

/**
 * 边界还原命令（navigate / frame-switch / tab-switch / resume）：
 * 用真实 documentId/URL 轨迹判定 + 可证明执行 + 阻断证据。
 * @param {{plan?:object, boundaryPlan?:object, steps?:Array<object>, trace?:Array<object>,
 *          current?:object, frames?:Array<object>, mode?:string, providers?:object}} input
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function replayBoundaryCommand(input = {}, options = {}) {
  const source = isPlainObject(input) ? input : {};
  const planInput = source.plan !== undefined
    ? source.plan
    : (source.boundaryPlan !== undefined
      ? source.boundaryPlan
      : (Array.isArray(source.steps) ? { steps: source.steps, context: { current: source.current, frames: source.frames } } : null));
  const trace = source.trace !== undefined ? source.trace : (Array.isArray(source.entries) ? source.entries : []);
  const context = {
    current: source.current !== undefined ? source.current : options.current,
    frames: source.frames !== undefined ? source.frames : options.frames,
    mode: source.mode || options.mode,
    requireUrl: source.requireUrl === true || options.requireUrl === true,
  };
  const evaluation = evaluateBoundaryExecution(planInput, trace, context);
  const providers = isPlainObject(source.providers) ? source.providers : null;
  const execution = providers
    ? await executeBoundaryRestoration(planInput, trace, providers, { ...context, continueOnBlock: source.continueOnBlock === true })
    : null;
  const outcome = execution || evaluation;
  return {
    version: REPLAY_BOUNDARY_EXECUTION_VERSION,
    ok: outcome.ok === true,
    code: String(outcome.code || ''),
    evaluation: {
      ok: evaluation.ok === true,
      code: String(evaluation.code || ''),
      matched: Number(evaluation.matched) || 0,
      needsAction: Number(evaluation.needsAction) || 0,
      blocked: Number(evaluation.blocked) || 0,
      blockers: Array.isArray(evaluation.blockers) ? evaluation.blockers.slice(0, 4) : [],
      trace: evaluation.trace,
      digest: String(evaluation.digest || ''),
    },
    execution: execution ? summarizeBoundaryExecution(execution) : null,
    resume: summarizeResume(execution ? execution.resume : evaluation.resume),
    explanation: outcome.ok === true ? null : explainBoundaryExecution(outcome),
    digest: String(outcome.digest || ''),
  };
}

/** resume 摘要（内部用：有界稳定）。 */
function summarizeResume(resume) {
  if (!isPlainObject(resume)) return null;
  return {
    ok: resume.ok === true,
    code: String(resume.code || ''),
    fromIndex: Number.isInteger(resume.fromIndex) ? resume.fromIndex : 0,
    epoch: Number.isInteger(resume.epoch) ? resume.epoch : -1,
    reason: String(resume.reason || '').slice(0, 80),
  };
}

/**
 * 观测 diff 命令：把真实 replay 结果（可含第二次重放）判成 expect 判决 + 确定性 diff。
 * @param {{plan?:object, params?:object, result?:unknown, error?:unknown,
 *          secondResult?:unknown, secondError?:unknown, expect?:object}} input
 * @param {object} [options]
 */
export function replayObservationCommand(input = {}, options = {}) {
  const source = isPlainObject(input) ? input : {};
  const plan = source.plan !== undefined ? source.plan : planNetworkReplay(source.params || {}, options);
  const consumed = consumeReplayObservation(plan, {
    result: source.result,
    error: source.error,
    secondResult: source.secondResult,
    secondError: source.secondError,
  }, {
    ...replayDiffOptions(options),
    ...(isPlainObject(source.options) ? source.options : {}),
    expect: source.expect !== undefined ? source.expect : replayDiffOptions(options).expect,
  });
  return {
    version: REPLAY_OBSERVATION_EXEC_VERSION,
    ok: consumed.ok === true,
    verdict: summarizeObservationVerdict(consumed.verdict),
    determinism: consumed.determinism
      ? {
        deterministic: consumed.determinism.deterministic === true,
        code: consumed.determinism.code,
        differences: consumed.determinism.differences.length,
        ignored: consumed.determinism.ignored,
        digests: consumed.determinism.digests,
      }
      : null,
    observed: consumed.observed,
    digest: consumed.digest,
  };
}

/**
 * 失败注入矩阵命令：对一次 network.replay 的计划跑“超时/404/连接失败/重定向…”矩阵，
 * 输出每格分类与恢复建议（默认全本地注入，不产生网络副作用）。
 * @param {object} params 既有 network.replay 入参（或直接传 plan {steps,...}）
 * @param {object} [options] 透传 runFailureMatrix（injections/execute/method/maxCells）
 */
export function replayFailureMatrixCommand(params = {}, options = {}) {
  const plan = isPlainObject(params) && Array.isArray(params.steps)
    ? params
    : planNetworkReplay(params, options);
  return runFailureMatrix(plan, options);
}

/** 第二轮能力声明（附加字段；不改变既有 features）。 */
export function replayExecutionCapabilities() {
  const catalog = verifyFailureMatrixCatalog();
  return {
    version: REPLAY_EXECUTION_VERSION,
    execution: {
      version: REPLAY_EXECUTOR_VERSION,
      deterministic: true,
      virtualClock: true,
      hasWallClock: false,
      codes: Object.values(EXECUTOR_CODES),
      field: REPLAY_EXECUTION_FIELD,
    },
    boundaryExecution: {
      version: REPLAY_BOUNDARY_EXECUTION_VERSION,
      actions: ['navigate', 'frame-switch', 'tab-switch', 'resume'],
      traceKinds: ['identity', 'navigation', 'frame-switch', 'tab-switch', 'resume', 'observation'],
    },
    observation: {
      version: REPLAY_OBSERVATION_EXEC_VERSION,
      diff: true,
      toleranceProfiles: ['exact', 'normalized', 'fuzzy'],
    },
    failureMatrix: {
      version: REPLAY_FAILURE_MATRIX_VERSION_OUT,
      cells: catalog.cells,
      kinds: catalog.kinds,
      catalogOk: catalog.ok,
      codes: Object.values(MATRIX_CODES),
    },
    commands: [
      'replayNetworkCommand',
      'replayDebugCommand',
      'replayNetworkCommandTwice',
      'replayBoundaryCommand',
      'replayObservationCommand',
      'replayFailureMatrixCommand',
    ],
  };
}

/**
 * record export 回放的消费：纯规划，不执行（执行由 CLI/外部驱动）。
 * 把 replay 字段附加到导出结果上；recording 为空时返回原结果（默认行为不变）。
 * @param {object} result 既有 record export 输出
 * @param {unknown} recording 录制事件/程序
 * @param {object} [options]
 */
export function consumeRecordExport(result, recording, options = {}) {
  if (!recording) return result;
  const plan = planRecordReplay(recording, options);
  return withReplayFields(result, buildReplayField(plan, { executed: false }), options);
}

// 供 replay.js 的 network/debug 包装复用的执行侧助手（公开 API 以 replay.js 为准）。
export { replayDiffOptions, boundaryExecutionField, matrixEvidenceOf, attachExecutionEvidenceToError, observeNetworkReplay };
