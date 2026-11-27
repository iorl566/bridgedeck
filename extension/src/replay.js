// extension/src/replay.js —— 录制→回放引擎的命令路径接线（只加字段，默认行为不变）。
//
// 第十二批为了文件预算把规划层与执行包装拆到：
//   - extension/src/replay-plan.js：规划/字段/失败解释挂载（第一轮 API）；
//   - extension/src/replay-execution.js：第二轮执行包装与附加字段常量；
// 本文件只保留命令接线：replayNetworkCommand / replayDebugCommand（dispatch.js:147 与
// bridge.js:475 的真实入口）、consumeRecordExport、replayCapabilities / replayReport /
// checkReplayPlan / serializeReplayField，并 re-export 上述两文件的既有公开 API。

import {
  planNetworkReplay, planDebugReplay, extractNetworkReplay, explainReplayError, replayFailureOf,
  buildReplayField, withReplayFields, isPlainObject,
  REPLAY_SOURCES, REPLAY_WIRING_VERSION, REPLAY_FIELD, REPLAY_FAILURE_FIELD, REPLAY_PLAN_FIELD,
  REPLAY_NETWORK_LIMITS, REPLAY_COMMAND_PATHS,
} from './replay-plan.js';
import { REPLAY_EXECUTION_VERSION, REPLAY_EXECUTION_FIELD, replayDiffOptions, boundaryExecutionField, matrixEvidenceOf, attachExecutionEvidenceToError, observeNetworkReplay } from './replay-execution.js';
import { buildExecutionEnvelope, executionEnvelopeFingerprint, sideEffectSemantics, summarizeSideEffects } from './lib/replay-executor.js';
import { summarizeObservation } from './lib/replay-diff-exec.js';
import { DEFAULT_PLAN_LIMITS, summarizeReplayPlan, stableStringify } from './lib/replay-plan.js';
import { summarizeBoundaries } from './lib/replay-boundary-plan.js';
import { summarizeTargetPlan } from './lib/replay-target.js';
import { verifyPlan, verifyReplay, summarizeVerify } from './lib/replay-verify.js';
import { summarizeFailure } from './lib/replay-explain.js';
// MV3 service worker 禁止动态 import()，真实命令包装静态依赖既有 networkReplay。
import { networkReplay } from './network.js';
import { attachMatrixRecovery } from './lib/replay-failure-matrix.js';

// 既有公开 API 全部保持（第一轮测试/CLI/MCP 零改动）。
export * from './replay-plan.js';
export * from './replay-execution.js';

/**
 * network.replay 的包装：先出计划 → 调既有 networkReplay → 附加 replay 字段。
 * 失败时把 replayFailure + 失败矩阵恢复建议挂到原异常上再原样抛出（code/message 不变）。
 * 第二轮新增字段（execution/observation/verdict）均为附加字段，默认路径仍只发一次请求。
 * @param {object} params 既有 network.replay 入参
 * @param {{current?:object, frames?:Array<object>, enrich?:boolean, salt?:string,
 *          execution?:object, diff?:object, expect?:object, boundaryExecution?:object}} [options]
 */
export async function replayNetworkCommand(params, options = {}) {
  const plan = planNetworkReplay(params, options);
  const envelope = buildExecutionEnvelope(plan, { source: REPLAY_SOURCES.NETWORK });
  const execute = typeof options.execute === 'function' ? options.execute : networkReplay;
  const boundaryExecution = await boundaryExecutionField(options, plan);
  try {
    const result = await execute(params);
    if (options.enrich === false) return result;
    const { observation, verdict, execution } = observeNetworkReplay(params, options, plan, result);
    return withReplayFields(result, buildReplayField(plan, {
      executed: true,
      execution,
      envelope,
      observation: summarizeObservation(observation),
      verdict,
      boundaryExecution,
    }));
  } catch (error) {
    explainReplayError(error, plan);
    const failure = matrixEvidenceOf(error, plan, options);
    const explanation = replayFailureOf(error);
    if (explanation) attachMatrixRecovery(explanation, failure);
    attachExecutionEvidenceToError(error, {
      version: REPLAY_EXECUTION_VERSION,
      envelopeFingerprint: envelope.fingerprint,
      envelopeFingerprintAfter: executionEnvelopeFingerprint(envelope),
      planToken: plan.token || '',
      planFingerprint: plan.fingerprint || '',
      sideEffects: summarizeSideEffects(sideEffectSemantics(plan)),
      failure,
    });
    throw error;
  }
}

/**
 * debug replay 的包装：bridge.js 的 bb.debug.replay 语义（成功时补 {ok:true}）。
 * @param {object} message {tabId, id?, overrides?}
 * @param {object} [options]
 */
export async function replayDebugCommand(message, options = {}) {
  const plan = planDebugReplay(message, options);
  const envelope = buildExecutionEnvelope(plan, { source: REPLAY_SOURCES.DEBUG });
  const params = { tabId: message && message.tabId, id: message && message.id, overrides: message && message.overrides };
  const execute = typeof options.execute === 'function' ? options.execute : networkReplay;
  const boundaryExecution = await boundaryExecutionField(options, plan);
  try {
    const result = await execute(params);
    if (options.enrich === false) return { ok: true, ...result };
    const { observation, verdict, execution } = observeNetworkReplay(params, options, plan, result);
    return withReplayFields({ ok: true, ...result }, buildReplayField(plan, {
      executed: true,
      execution,
      envelope,
      observation: summarizeObservation(observation),
      verdict,
      boundaryExecution,
    }));
  } catch (error) {
    explainReplayError(error, plan);
    const failure = matrixEvidenceOf(error, plan, options);
    const explanation = replayFailureOf(error);
    if (explanation) attachMatrixRecovery(explanation, failure);
    attachExecutionEvidenceToError(error, {
      version: REPLAY_EXECUTION_VERSION,
      envelopeFingerprint: envelope.fingerprint,
      planToken: plan.token || '',
      planFingerprint: plan.fingerprint || '',
      sideEffects: summarizeSideEffects(sideEffectSemantics(plan)),
      failure,
    });
    throw error;
  }
}

/** 能力声明（debug.capabilities.features 的可加字段；不改变既有 features）。 */
export function replayCapabilities() {
  return {
    version: REPLAY_WIRING_VERSION,
    executionVersion: REPLAY_EXECUTION_VERSION,
    plan: true,
    boundaryRestoration: true,
    targetRestoration: true,
    diffValidation: true,
    explainability: true,
    verification: true,
    determinism: true,
    execution: true,
    boundaryExecution: true,
    observationDiff: true,
    failureMatrix: true,
    sources: Object.values(REPLAY_SOURCES),
    fields: { result: REPLAY_FIELD, failure: REPLAY_FAILURE_FIELD, plan: REPLAY_PLAN_FIELD, execution: REPLAY_EXECUTION_FIELD },
    limits: {
      steps: DEFAULT_PLAN_LIMITS.maxSteps,
      waitMs: DEFAULT_PLAN_LIMITS.maxWaitMs,
      retries: DEFAULT_PLAN_LIMITS.maxRetries,
      bodyChars: REPLAY_NETWORK_LIMITS.maxBodyChars,
    },
    commandPaths: REPLAY_COMMAND_PATHS.map((item) => ({ command: item.command, file: item.file, symbol: item.symbol })),
  };
}

/** 汇总一次“计划 + 结果”为完整报告（verify + 失败解释）。 */
export function replayReport(plan, outcomes, context = {}) {
  const report = verifyReplay(plan, outcomes, context);
  return {
    ...summarizeVerify(report),
    plan: summarizeReplayPlan(plan),
    boundaries: summarizeBoundaries(plan && plan.boundaries),
    targets: summarizeTargetPlan(plan && plan.targets),
    checks: Array.isArray(report.checks) ? report.checks.map((item) => ({ id: item.id, ok: item.ok, severity: item.severity, detail: item.detail })) : [],
    failures: Array.isArray(report.failures) ? report.failures.map(summarizeFailure) : [],
    failureReport: report.failureReport || null,
  };
}

/** 计划完整性快速自检（接线层对外的一行入口）。 */
export function checkReplayPlan(plan) {
  const result = verifyPlan(plan || {});
  return {
    ok: result.ok,
    grade: result.grade,
    issues: result.issues,
    checksum: result.checksum,
  };
}

/** 输出字段序列化（测试/日志用：同一计划必得同一字符串）。 */
export function serializeReplayField(field) {
  return stableStringify(field);
}
