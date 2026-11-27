// extension/src/lib/replay-executor.js —— 回放执行编排（第二轮：从“规划层”到“可执行/可复现”）。
//
// 本文件只留执行编排：runReplayPlan（依赖注入的确定性执行）、recordExecutionOutcomes
//（真实命令路径“执行一次 + 记账”）、compareExecutions/verifyDeterministicExecution
//（跨次确定性比较）、explainExecutionResult 与摘要/文本。
//
// 纯模型已拆分（仍经本模块 re-export，公开 API 不变）：
//   - replay-exec-semantics.js：结果码/上限/选项归一/副作用画像/基础工具；
//   - replay-exec-envelope.js：执行信封与信封指纹；
//   - replay-exec-audit.js：单步结果归一/expect 判决/错误分类/条目语义键。
//
// 运行时消费者：extension/src/replay.js（replayNetworkCommand 真实 path、
// replayNetworkCommandTwice、replayFailureMatrixCommand）。

import { stableHash } from '../record-steps.js';
import { stableStringify } from './replay-plan.js';
import { explainFailure, explainPlanBlockers } from './replay-explain.js';
import { buildExecutionEnvelope } from './replay-exec-envelope.js';
import { REPLAY_EXECUTOR_VERSION, EXECUTOR_CODES, EXECUTOR_LIMITS, clampInt, isObject, nonNegativeInt, pieceIsObject, shortText, stepsOf, stepEffectOf, normalizeExecutionOptions, normalizeExecutionProviders } from './replay-exec-semantics.js';
import { classifyExecutionError, makeEntry, boundaryPlanAt, RESTORE_ACTIONS, verdictOfStep, normalizeStepOutcomeValue, entrySemanticKey, summarizeEntry, catalogCodeOfExecution } from './replay-exec-audit.js';

// ---------------------------------------------------------------------------
// 主执行流程
// ---------------------------------------------------------------------------

/**
 * 执行一份计划（确定性、依赖注入）。
 *
 * providers：
 *   - execute(step, context)：执行一步，返回结果对象 / 抛异常（必需，除非 dryRun）；
 *   - restoreBoundary(action, context)：执行 navigate/frame-switch/tab-switch（边界步必需）；
 *   - sampleIdentity()：采样当前身份（本轮执行器只透传，不强制）；
 *   - sleep(ms)：重试退避（虚拟时间；缺省视为 0 延迟）；
 *   - now()：读虚拟时钟（缺省恒 0，保证轨迹确定）；
 *   - isCancelled()：执行前检查取消。
 *
 * @param {object} plan buildReplayPlan / planNetworkReplay 结果
 * @param {object} [providers]
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function runReplayPlan(plan, providers = {}, options = {}) {
  const config = normalizeExecutionOptions(options);
  const p = normalizeExecutionProviders(providers);
  const steps = stepsOf(plan).slice(0, config.limits.maxSteps);
  const truncated = stepsOf(plan).length > steps.length;
  const envelope = buildExecutionEnvelope(plan, { source: options.source });
  const blockers = Array.isArray(plan && plan.blockers) ? plan.blockers : [];
  const base = {
    version: REPLAY_EXECUTOR_VERSION,
    deterministic: true,
    hasWallClock: false,
    plan: {
      token: String(plan && plan.token || ''),
      fingerprint: String(plan && plan.fingerprint || ''),
      steps: stepsOf(plan).length,
      blocked: blockers.length > 0,
      blockers: blockers.slice(0, 8).map((blocker) => ({
        code: shortText(blocker && blocker.code, 80),
        index: Number.isInteger(blocker && blocker.index) ? blocker.index : -1,
        message: shortText(blocker && blocker.message, 200),
      })),
    },
    envelope,
    entries: [],
    planned: steps.length,
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    effects: [],
    virtualDurationMs: 0,
    sideEffectAtRisk: false,
    cancelled: false,
    cancelledAt: -1,
    truncated,
    stoppedAt: -1,
    explanation: null,
  };
  if (!isObject(plan) || !Array.isArray(plan.steps)) {
    return finishExecution({ ...base, ok: false, code: EXECUTOR_CODES.BLOCKED }, [
      { code: 'PLAN_SHAPE', index: -1, message: '计划不是对象或缺少 steps 数组' },
    ]);
  }
  if (blockers.length && !config.ignoreBlockers && !config.dryRun) {
    const explanations = explainPlanBlockers(blockers, plan).slice(0, 4);
    return {
      ...finishExecution({ ...base, ok: false, code: EXECUTOR_CODES.BLOCKED }, blockers),
      explanation: explanations[0] || null,
      explanations,
    };
  }
  if (!config.dryRun && !p.execute) {
    return finishExecution({
      ...base,
      ok: false,
      code: EXECUTOR_CODES.NO_EXECUTOR,
      explanation: explainFailure({ code: 'PLAN_VALIDATION', detail: '执行器没有注入 execute provider（拒绝假装执行）' }),
    }, [{ code: EXECUTOR_CODES.NO_EXECUTOR, index: -1, message: '没有 execute provider' }]);
  }

  let virtualNow = typeof p.now === 'function' ? nonNegativeInt(p.now(), 0) : 0;
  const effects = [];
  let stopped = false;
  for (let position = 0; position < steps.length; position += 1) {
    if (stopped) break;
    const step = steps[position];
    const index = Number.isInteger(step && step.index) ? step.index : position;
    const startMs = virtualNow;
    if (typeof p.isCancelled === 'function' && p.isCancelled() === true) {
      base.cancelled = true;
      base.cancelledAt = index;
      break;
    }
    const entry = makeEntry(step, index, {
      virtualStartMs: startMs,
      virtualEndMs: startMs,
      iteration: Number.isInteger(step && step.iteration) ? step.iteration : 0,
    });

    // 1) 边界还原：需要外部动作的一律 fail-closed，不拿“当前页面”猜。
    const boundaryPlan = boundaryPlanAt(plan, position);
    if (boundaryPlan) {
      const action = String(boundaryPlan.action || 'continue');
      entry.boundary = { action, ok: true, code: 'BOUNDARY_CONTINUE' };
      if (action === 'abort') {
        entry.boundary = { action, ok: false, code: 'BOUNDARY_ABORT', reason: shortText(boundaryPlan.reason, 120) };
        entry.status = 'blocked';
        entry.code = EXECUTOR_CODES.BOUNDARY_BLOCKED;
        entry.error = { code: 'BOUNDARY_ABORT', catalogCode: 'BOUNDARY_DOCUMENT_CHANGED', message: '边界计划要求中止：' + shortText(boundaryPlan.reason, 120) };
        entry.error.category = 'boundary';
        base.entries.push(entry);
        base.blocked += 1;
        base.stoppedAt = index;
        stopped = true;
        continue;
      }
      if (RESTORE_ACTIONS.has(action)) {
        if (typeof p.restoreBoundary !== 'function') {
          entry.status = 'blocked';
          entry.code = EXECUTOR_CODES.NO_BOUNDARY_EXECUTOR;
          entry.boundary = { action, ok: false, code: 'NO_BOUNDARY_EXECUTOR', reason: shortText(boundaryPlan.reason, 120) };
          entry.error = {
            code: EXECUTOR_CODES.NO_BOUNDARY_EXECUTOR,
            catalogCode: catalogCodeOfExecution(EXECUTOR_CODES.NO_BOUNDARY_EXECUTOR),
            message: '边界动作 ' + action + ' 需要 restoreBoundary provider',
            category: 'boundary',
          };
          base.entries.push(entry);
          base.blocked += 1;
          base.stoppedAt = index;
          stopped = true;
          continue;
        }
        const beforeNow = virtualNow;
        let restored = null;
        try {
          restored = await p.restoreBoundary(boundaryPlan, {
            index,
            position,
            planToken: base.plan.token,
            boundary: step && step.boundary,
          });
        } catch (error) {
          const classified = classifyExecutionError(error, { stepIndex: index, method: 'boundary' });
          entry.status = 'blocked';
          entry.code = EXECUTOR_CODES.BOUNDARY_BLOCKED;
          entry.boundary = { action, ok: false, code: classified.code, reason: classified.message };
          entry.error = {
            code: classified.code,
            catalogCode: classified.catalogCode || catalogCodeOfExecution(EXECUTOR_CODES.BOUNDARY_BLOCKED),
            message: classified.message,
            category: 'boundary',
          };
          entry.virtualEndMs = beforeNow;
          base.entries.push(entry);
          base.blocked += 1;
          base.stoppedAt = index;
          stopped = true;
          continue;
        }
        const restoredOk = !isObject(restored) || restored.ok !== false;
        if (!restoredOk) {
          entry.status = 'blocked';
          entry.code = EXECUTOR_CODES.BOUNDARY_BLOCKED;
          entry.boundary = {
            action,
            ok: false,
            code: shortText(restored && (restored.code || restored.reason), 120) || 'BOUNDARY_BLOCKED',
            reason: shortText(restored && restored.reason, 120),
          };
          entry.error = {
            code: EXECUTOR_CODES.BOUNDARY_BLOCKED,
            catalogCode: catalogCodeOfExecution(EXECUTOR_CODES.BOUNDARY_BLOCKED),
            message: '边界还原失败：' + shortText(restored && restored.reason, 120),
            category: 'boundary',
          };
          base.entries.push(entry);
          base.blocked += 1;
          base.stoppedAt = index;
          stopped = true;
          continue;
        }
        entry.boundary = {
          action,
          ok: true,
          code: shortText(restored && restored.code, 120) || 'BOUNDARY_RESTORED',
          reason: shortText(restored && restored.reason, 120),
        };
      }
    }

    // 2) dry-run：只验证“计划确实有这一步”，绝不调用 execute。
    if (config.dryRun) {
      entry.status = 'planned';
      entry.code = EXECUTOR_CODES.PLANNED;
      base.entries.push(entry);
      continue;
    }

    const effect = stepEffectOf(step, isObject(plan.network) ? plan.network : null);
    const retries = (step && step.fallback && step.fallback.onError === 'retry')
      ? clampInt(step.fallback.retries, 0, config.limits.maxRetries)
      : 0;
    const retryDelay = (step && step.fallback && nonNegativeInt(step.fallback.retryDelayMs, 0)) || 0;
    const skipOnError = Boolean(step && step.fallback && step.fallback.onError === 'skip');
    let attempts = 0;
    let finalVerdict = null;

    for (;;) {
      if (typeof p.isCancelled === 'function' && p.isCancelled() === true) {
        base.cancelled = true;
        base.cancelledAt = index;
        break;
      }
      attempts += 1;
      const attemptStart = virtualNow;
      try {
        const value = await p.execute(step, {
          index,
          position,
          planToken: base.plan.token,
          attempt: attempts,
          effect,
          remaining: steps.length - position - 1,
        });
        base.executed += 1;
        const outcome = normalizeStepOutcomeValue(step, value);
        const verdict = verdictOfStep(step, outcome, config);
        finalVerdict = verdict;
        if (verdict && verdict.ok === false) {
          // 期望不一致不是瞬时故障：不做自动重试（重试只会重复同一个观测）。
          entry.status = 'failed';
          entry.code = verdict.code || EXECUTOR_CODES.STEP_FAILED;
          entry.result = outcome;
          entry.verdict = verdict;
          entry.attempts = attempts;
          entry.error = {
            code: verdict.code || EXECUTOR_CODES.STEP_FAILED,
            catalogCode: verdict.code || '',
            message: '观测/期望不一致（' + (verdict.code || 'DIFF') + '）',
            category: 'diff',
          };
          break;
        }
        entry.status = 'passed';
        entry.code = EXECUTOR_CODES.OK;
        entry.result = outcome;
        entry.verdict = verdict;
        entry.attempts = attempts;
        entry.error = null;
        break;
      } catch (error) {
        const classified = classifyExecutionError(error, { stepIndex: index, ref: step && step.ref, method: step && step.method });
        const canRetry = classified.retriable && attempts <= retries && !config.dryRun;
        if (canRetry) {
          virtualNow = attemptStart + retryDelay;
          if (typeof p.sleep === 'function') await p.sleep(retryDelay);
          continue;
        }
        const exhausted = classificationsIsRetryable(classified) && retries > 0;
        entry.status = skipOnError ? 'skipped' : 'failed';
        entry.code = skipOnError
          ? EXECUTOR_CODES.STEP_SKIPPED
          : (exhausted ? EXECUTOR_CODES.RETRY_EXHAUSTED : classified.code);
        entry.attempts = attempts;
        entry.result = null;
        entry.verdict = finalVerdict;
        entry.error = {
          code: classified.code,
          catalogCode: classified.catalogCode,
          message: classified.message,
          category: classified.category,
          retriable: classified.retriable,
        };
        break;
      }
    }
    entry.virtualEndMs = virtualNow;
    if (config.measureDurations && entry.virtualEndMs > entry.virtualStartMs) {
      entry.durationMs = entry.virtualEndMs - entry.virtualStartMs;
    }
    base.entries.push(entry);
    if (entry.status === 'failed') {
      base.failed += 1;
      // 只有“不幂等的写请求可能已发出”才算副作用风险；只读 GET 失败不构成写入风险。
      if (effect.mutating || (effect.potentiallySent && effect.idempotent !== true)) base.sideEffectAtRisk = true;
      base.stoppedAt = index;
      if (config.stopOnFailure) stopped = true;
    } else if (entry.status === 'skipped') {
      base.skipped += 1;
    } else if (entry.status === 'passed') {
      base.passed += 1;
      if (effect.mutating) {
        effects.push({
          kind: effect.kind,
          effect: effect.effect,
          index,
          method: effect.method,
          idempotent: effect.idempotent,
          compensatable: effect.compensatable,
          atVirtualMs: entry.virtualEndMs,
        });
      }
    }
    if (base.cancelled) break;
  }

  base.effects = effects;
  base.virtualDurationMs = virtualNow;
  base.summary = {
    steps: steps.length,
    passed: base.passed,
    failed: base.failed,
    skipped: base.skipped,
    blocked: base.blocked,
    cancelled: base.cancelled,
    truncated,
    sideEffectAtRisk: base.sideEffectAtRisk,
    effects: effects.length,
  };
  const executedOk = !base.cancelled && base.failed === 0 && base.blocked === 0;
  base.ok = executedOk;
  base.code = config.dryRun
    ? EXECUTOR_CODES.PLANNED
    : base.cancelled
      ? EXECUTOR_CODES.CANCELLED
      : base.blocked > 0
        ? EXECUTOR_CODES.BOUNDARY_BLOCKED
        : base.failed > 0
          ? (base.entries.some((item) => item.code === EXECUTOR_CODES.RETRY_EXHAUSTED) ? EXECUTOR_CODES.RETRY_EXHAUSTED : EXECUTOR_CODES.STEP_FAILED)
          : EXECUTOR_CODES.OK;
  const finished = finishExecution(base, base.plan.blockers);
  if (!finished.ok) {
    const failureInput = failureInputOf(finished);
    finished.explanation = failureInput ? explainFailure(failureInput) : null;
    withExecutionEvidence(finished.explanation, finished);
  }
  return finished;
}

function classificationsIsRetryable(classified) {
  return Boolean(classified && classified.retriable === true);
}

/** 收尾：计算语义指纹与整体 digest（任何返回路径都必须经过）。 */
function finishExecution(result, blockers) {
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const semanticMaterial = entries.map(entrySemanticKey);
  const semanticFingerprint = stableHash(semanticMaterial.join('>'));
  const effectsDigest = stableHash(stableStringify(result.effects || []));
  const digest = stableHash([
    REPLAY_EXECUTOR_VERSION,
    result.envelope ? result.envelope.fingerprint : '',
    String(result.code || ''),
    result.ok === true ? 'ok' : 'fail',
    semanticFingerprint,
    effectsDigest,
    String(result.plan && result.plan.token || ''),
  ].join('|'));
  result.semanticFingerprint = semanticFingerprint;
  result.effectsDigest = effectsDigest;
  result.digest = digest;
  if (!Array.isArray(result.effects)) result.effects = [];
  if (!result.blockers) result.blockers = Array.isArray(blockers) ? blockers.slice(0, 8) : [];
  if (!result.summary) {
    result.summary = {
      steps: result.planned || 0,
      passed: result.passed || 0,
      failed: result.failed || 0,
      skipped: result.skipped || 0,
      blocked: result.blocked || 0,
      cancelled: result.cancelled === true,
      truncated: result.truncated === true,
      sideEffectAtRisk: result.sideEffectAtRisk === true,
      effects: result.effects.length,
    };
  }
  return result;
}

/** 从执行结果里挑“最该解释的失败”（blocked > failed > sideEffect）。 */
function failureInputOf(execution) {
  if (!execution || execution.ok === true) return null;
  const entries = Array.isArray(execution.entries) ? execution.entries : [];
  const failed = entries.find((entry) => entry.status === 'failed');
  const blocked = entries.find((entry) => entry.status === 'blocked');
  const target = failed || blocked || null;
  const code = target
    ? (target.error && target.error.catalogCode) || catalogCodeOfExecution(target.code) || (target.code && target.code.startsWith('DIFF_') ? target.code : '')
    : (execution.code === EXECUTOR_CODES.BLOCKED ? 'PLAN_BLOCKED' : 'REPLAY_INTERNAL');
  return {
    code: code || 'REPLAY_INTERNAL',
    step: target ? { index: target.index, ref: target.ref, kind: target.kind, method: target.method } : null,
    error: target && target.error ? { code: target.error.code, message: target.error.message } : undefined,
    outcome: target && target.verdict
      ? { severity: target.verdict.ok ? 'warning' : 'fail', code: target.verdict.code, differences: target.verdict.differences, summary: { failed: target.verdict.failed, checked: target.verdict.checks } }
      : null,
    boundary: target && target.boundary ? { relation: target.boundary.action, reason: target.boundary.reason } : null,
    plan: execution.envelope && execution.envelope.planToken ? { token: execution.envelope.planToken } : null,
  };
}

/** 给失败解释挂上有界的执行证据（不改目录字段，只加 execution 子对象）。 */
function withExecutionEvidence(explanation, execution) {
  if (!isObject(explanation)) return explanation;
  explanation.execution = {
    envelopeFingerprint: String((execution.envelope && execution.envelope.fingerprint) || ''),
    semanticFingerprint: String(execution.semanticFingerprint || ''),
    digest: String(execution.digest || ''),
    stoppedAt: Number.isInteger(execution.stoppedAt) ? execution.stoppedAt : -1,
    sideEffectAtRisk: execution.sideEffectAtRisk === true,
  };
  return explanation;
}

/** 失败解释：执行结果 → 目录解释（成功返回 null）。 */
export function explainExecutionResult(execution) {
  if (!execution || execution.ok === true) return null;
  if (isObject(execution.explanation)) return withExecutionEvidence(execution.explanation, execution);
  const input = failureInputOf(execution);
  const explanation = input ? explainFailure(input) : null;
  return withExecutionEvidence(explanation, execution);
}

// ---------------------------------------------------------------------------
// 从“已拿到的结果”记录执行（真实命令路径用：只执行一次，然后记账）
// ---------------------------------------------------------------------------

/**
 * 把一次真实执行的结果记账成执行轨迹（不再调用外部执行器）。
 * 用于命令包装层：真正的副作用已经由既有命令完成，本函数只做确定性记录。
 *
 * @param {object} plan
 * @param {Array<object>} outcomes [{index?, value?, error?, verdict?, boundary?}]
 * @param {{measureDurations?:boolean, source?:string}} [options]
 * @returns {object} 与 runReplayPlan 同形状的执行结果
 */
export function recordExecutionOutcomes(plan, outcomes, options = {}) {
  const config = normalizeExecutionOptions(options);
  const steps = stepsOf(plan);
  const envelope = buildExecutionEnvelope(plan, { source: options.source });
  const base = {
    version: REPLAY_EXECUTOR_VERSION,
    deterministic: true,
    hasWallClock: false,
    plan: {
      token: String(plan && plan.token || ''),
      fingerprint: String(plan && plan.fingerprint || ''),
      steps: steps.length,
      blocked: false,
      blockers: [],
    },
    envelope,
    entries: [],
    planned: steps.length,
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    effects: [],
    virtualDurationMs: 0,
    sideEffectAtRisk: false,
    cancelled: false,
    cancelledAt: -1,
    truncated: false,
    stoppedAt: -1,
    explanation: null,
  };
  const list = Array.isArray(outcomes) ? outcomes : [];
  for (let position = 0; position < steps.length; position += 1) {
    const step = steps[position];
    if (!pieceIsObject(step)) continue;
    const index = Number.isInteger(step.index) ? step.index : position;
    const explicitOutcome = list.find((item) => pieceIsObject(item) && Number.isInteger(item.index) && item.index === position);
    const outcome = explicitOutcome || list[position] || null;
    const entry = makeEntry(step, index);
    base.executed += 1;
    if (outcome && outcome.error) {
      const classified = classifyExecutionError(outcome.error, { stepIndex: index, ref: step.ref, method: step.method });
      entry.status = 'failed';
      entry.code = classified.code;
      entry.attempts = 1;
      entry.error = { code: classified.code, catalogCode: classified.catalogCode, message: classified.message, category: classified.category };
      base.failed += 1;
      base.stoppedAt = index;
      base.sideEffectAtRisk = base.sideEffectAtRisk || stepEffectOf(step, isObject(plan.network) ? plan.network : null).potentiallySent;
    } else if (outcome && outcome.value !== undefined) {
      const normalized = normalizeStepOutcomeValue(step, outcome.value);
      const verdict = outcome.verdict ? {
        ok: outcome.verdict.ok === true,
        severity: String(outcome.verdict.severity || (outcome.verdict.ok === true ? 'pass' : 'fail')),
        code: String(outcome.verdict.code || ''),
        checks: nonNegativeInt(outcome.verdict.summary && outcome.verdict.summary.checked),
        failed: nonNegativeInt(outcome.verdict.summary && outcome.verdict.summary.failed),
        warnings: nonNegativeInt(outcome.verdict.summary && outcome.verdict.summary.warnings),
        unsupported: Array.isArray(outcome.verdict.unsupported) ? outcome.verdict.unsupported.slice(0, 8) : [],
        differences: Array.isArray(outcome.verdict.differences) ? outcome.verdict.differences.slice(0, 8) : [],
      } : verdictOfStep(step, normalized, config);
      if (verdict && verdict.ok === false) {
        entry.status = 'failed';
        entry.code = verdict.code || EXECUTOR_CODES.STEP_FAILED;
        entry.error = { code: entry.code, catalogCode: entry.code, message: '观测/期望不一致', category: 'diff' };
        base.failed += 1;
        base.stoppedAt = index;
      } else {
        entry.status = 'passed';
        entry.code = EXECUTOR_CODES.OK;
        base.passed += 1;
        const effect = stepEffectOf(step, isObject(plan.network) ? plan.network : null);
        if (effect.mutating) {
          base.effects.push({
            kind: effect.kind,
            effect: effect.effect,
            index,
            method: effect.method,
            idempotent: effect.idempotent,
            compensatable: effect.compensatable,
            atVirtualMs: 0,
          });
        }
      }
      entry.result = normalized;
      entry.verdict = verdict;
      entry.attempts = 1;
      if (outcome.boundary && isObject(outcome.boundary)) entry.boundary = outcome.boundary;
    } else if (outcome && outcome.skipped === true) {
      entry.status = 'skipped';
      entry.code = EXECUTOR_CODES.STEP_SKIPPED;
      entry.attempts = 1;
      base.skipped += 1;
    } else {
      entry.status = 'planned';
      entry.code = EXECUTOR_CODES.PLANNED;
    }
    base.entries.push(entry);
  }
  base.summary = {
    steps: steps.length,
    passed: base.passed,
    failed: base.failed,
    skipped: base.skipped,
    blocked: base.blocked,
    cancelled: false,
    truncated: false,
    sideEffectAtRisk: base.sideEffectAtRisk,
    effects: base.effects.length,
  };
  base.ok = base.failed === 0 && base.blocked === 0;
  base.code = base.ok ? EXECUTOR_CODES.OK : EXECUTOR_CODES.STEP_FAILED;
  const finished = finishExecution(base, []);
  if (!finished.ok) {
    const input = failureInputOf(finished);
    finished.explanation = input ? explainFailure(input) : null;
    withExecutionEvidence(finished.explanation, finished);
  }
  return finished;
}

// ---------------------------------------------------------------------------
// 确定性比较
// ---------------------------------------------------------------------------

/** 执行结果指纹（有则用 digest，无则现场算）。 */
export function executionFingerprint(execution) {
  if (!execution || typeof execution !== 'object') return '';
  if (execution.digest) return String(execution.digest);
  const entries = Array.isArray(execution.entries) ? execution.entries : [];
  return stableHash(entries.map(entrySemanticKey).join('>'));
}

/** 计划指纹比较（两次构建同一输入必须一致）。 */
export function comparePlanFingerprints(leftPlan, rightPlan) {
  const left = {
    token: String(leftPlan && leftPlan.token || ''),
    fingerprint: String(leftPlan && leftPlan.fingerprint || ''),
    steps: stepsOf(leftPlan).length,
  };
  const right = {
    token: String(rightPlan && rightPlan.token || ''),
    fingerprint: String(rightPlan && rightPlan.fingerprint || ''),
    steps: stepsOf(rightPlan).length,
  };
  return {
    same: left.token === right.token && left.fingerprint === right.fingerprint && left.steps === right.steps,
    left,
    right,
  };
}

/**
 * 两次执行的确定性比较：计划指纹、信封指纹、逐步语义、副作用账本。
 * 只比较语义，不比较耗时/日志文案（那些本来就不确定）。
 * @param {object} left runReplayPlan / recordExecutionOutcomes 结果
 * @param {object} right 同上
 */
export function compareExecutions(left, right) {
  const a = isObject(left) ? left : {};
  const b = isObject(right) ? right : {};
  const differences = [];
  const push = (path, leftValue, rightValue) => {
    if (differences.length >= 16) return;
    differences.push({ path, left: leftValue === undefined ? null : leftValue, right: rightValue === undefined ? null : rightValue });
  };
  const planComparison = comparePlanFingerprints(a.plan, b.plan);
  if (!planComparison.same) push('plan', a.plan, b.plan);
  const leftEnvelope = String((a.envelope && a.envelope.fingerprint) || '');
  const rightEnvelope = String((b.envelope && b.envelope.fingerprint) || '');
  if (leftEnvelope !== rightEnvelope) push('envelope.fingerprint', leftEnvelope, rightEnvelope);
  const leftEntries = Array.isArray(a.entries) ? a.entries : [];
  const rightEntries = Array.isArray(b.entries) ? b.entries : [];
  const length = Math.max(leftEntries.length, rightEntries.length);
  let divergedAt = -1;
  for (let index = 0; index < length; index += 1) {
    const leftKey = leftEntries[index] ? entrySemanticKey(leftEntries[index]) : 'missing';
    const rightKey = rightEntries[index] ? entrySemanticKey(rightEntries[index]) : 'missing';
    if (leftKey !== rightKey) {
      if (divergedAt < 0) divergedAt = index;
      push('entries[' + index + ']', leftKey, rightKey);
    }
  }
  const leftEffects = stableStringify(a.effects || []);
  const rightEffects = stableStringify(b.effects || []);
  if (leftEffects !== rightEffects) push('effects', leftEffects, rightEffects);
  const sameStatus = a.ok === b.ok && String(a.code || '') === String(b.code || '');
  if (!sameStatus) push('outcome', String(a.code || ''), String(b.code || ''));
  const sameEntries = length > 0 && divergedAt < 0 && leftEntries.length === rightEntries.length;
  const sameSemantics = sameEntries && leftEffects === rightEffects && String(a.semanticFingerprint || '') === String(b.semanticFingerprint || '');
  const deterministic = planComparison.same && leftEnvelope === rightEnvelope && sameSemantics && sameStatus;
  return {
    version: REPLAY_EXECUTOR_VERSION,
    deterministic,
    samePlan: planComparison.same,
    sameEnvelope: leftEnvelope === rightEnvelope,
    sameEntries,
    sameEffects: leftEffects === rightEffects,
    sameStatus,
    sameSemantics,
    divergedAt,
    differences,
    fingerprints: {
      plan: planComparison.left.fingerprint,
      envelope: leftEnvelope,
      leftSemantic: String(a.semanticFingerprint || ''),
      rightSemantic: String(b.semanticFingerprint || ''),
      leftDigest: executionFingerprint(a),
      rightDigest: executionFingerprint(b),
    },
    digest: stableHash([
      planComparison.same ? 'plan' : 'plan-x',
      leftEnvelope === rightEnvelope ? 'env' : 'env-x',
      divergedAt,
      String(a.semanticFingerprint || ''),
      String(b.semanticFingerprint || ''),
    ].join('|')),
  };
}

/**
 * 确定性验证：同一 planFactory 构建两次 + 执行两次 → 比较指纹与语义。
 * @param {object|Function} planOrFactory 计划对象，或 () => 计划（推荐：验证“同输入两次”）
 * @param {object|Function} providers 执行 providers；或 () => providers（每次执行新建）
 * @param {object} [options]
 */
export async function verifyDeterministicExecution(planOrFactory, providers, options = {}) {
  const factory = typeof planOrFactory === 'function' ? planOrFactory : () => planOrFactory;
  const providerFactory = typeof providers === 'function' ? providers : () => providers;
  const firstPlan = factory();
  const secondPlan = factory();
  const first = await runReplayPlan(firstPlan, providerFactory(), options);
  const second = await runReplayPlan(secondPlan, providerFactory(), options);
  const planComparison = comparePlanFingerprints(firstPlan, secondPlan);
  const comparison = compareExecutions(first, second);
  return {
    version: REPLAY_EXECUTOR_VERSION,
    ok: planComparison.same && comparison.deterministic,
    deterministic: planComparison.same && comparison.deterministic,
    plan: {
      same: planComparison.same,
      first: planComparison.left,
      second: planComparison.right,
    },
    comparison,
    first: summarizeExecution(first),
    second: summarizeExecution(second),
    digest: stableHash([planComparison.same ? 'p' : 'p-x', comparison.digest].join('|')),
  };
}

// ---------------------------------------------------------------------------
// 摘要 / 文本
// ---------------------------------------------------------------------------

/** 执行结果摘要（RPC 字段用：有界、稳定）。 */
export function summarizeExecution(execution) {
  if (!isObject(execution)) return null;
  const entries = Array.isArray(execution.entries) ? execution.entries : [];
  const firstFailure = entries.find((entry) => entry.status === 'failed' || entry.status === 'blocked') || null;
  const summary = isObject(execution.summary) ? execution.summary : {};
  return {
    version: REPLAY_EXECUTOR_VERSION,
    ok: execution.ok === true,
    code: String(execution.code || ''),
    planned: nonNegativeInt(execution.planned || summary.steps),
    executed: nonNegativeInt(execution.executed),
    passed: nonNegativeInt(execution.passed || summary.passed),
    failed: nonNegativeInt(execution.failed || summary.failed),
    skipped: nonNegativeInt(execution.skipped || summary.skipped),
    blocked: nonNegativeInt(execution.blocked || summary.blocked),
    cancelled: execution.cancelled === true,
    truncated: execution.truncated === true,
    sideEffectAtRisk: execution.sideEffectAtRisk === true,
    envelopeFingerprint: String((execution.envelope && execution.envelope.fingerprint) || ''),
    semanticFingerprint: String(execution.semanticFingerprint || ''),
    digest: String(execution.digest || ''),
    virtualDurationMs: nonNegativeInt(execution.virtualDurationMs),
    effects: Array.isArray(execution.effects) ? execution.effects.length : 0,
    entries: entries.length <= 8
      ? entries.map(summarizeEntry)
      : entries.slice(0, 6).map(summarizeEntry).concat([{ truncated: entries.length - 6 }]),
    firstFailure: firstFailure ? summarizeEntry(firstFailure) : null,
  };
}

/** 文本摘要（日志/CLI 展示用；有界）。 */
export function formatExecutionSummary(execution, options = {}) {
  const summary = summarizeExecution(execution);
  if (!summary) return '回放执行：无结果';
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : 20;
  const lines = [];
  lines.push('回放执行 ' + (summary.ok ? '成功' : '失败（' + summary.code + '）')
    + '：steps ' + summary.passed + '/' + summary.planned + ' 通过'
    + (summary.failed ? '，失败 ' + summary.failed : '')
    + (summary.blocked ? '，阻断 ' + summary.blocked : '')
    + (summary.skipped ? '，跳过 ' + summary.skipped : ''));
  if (summary.sideEffectAtRisk) lines.push('⚠ 失败点可能已产生副作用：重试前先对账页面/服务端状态');
  if (summary.effects > 0) lines.push('已产生的副作用 ' + summary.effects + ' 项（见 effects 账本）');
  for (const entry of summary.entries) {
    if (entry.truncated) {
      lines.push('… 其余 ' + entry.truncated + ' 步省略');
      continue;
    }
    lines.push('- #' + entry.index + ' ' + entry.kind + '/' + entry.method + ' → ' + entry.status
      + (entry.error ? ' [' + entry.error.code + '] ' + entry.error.message : ''));
  }
  if (summary.envelopeFingerprint) lines.push('计划信封指纹：' + summary.envelopeFingerprint);
  if (summary.digest) lines.push('执行语义指纹：' + summary.digest);
  return lines.slice(0, maxLines).join('\n');
}

// 公开 API 保持：语义/信封/记账模型在此 re-export（replay.js 与单测零改动）。
export { REPLAY_EXECUTOR_VERSION, EXECUTOR_CODES, EXEC_STATUS, EXECUTOR_LIMITS, EXECUTOR_CATALOG_CODES, normalizeExecutionOptions, normalizeExecutionProviders, sideEffectSemantics, summarizeSideEffects } from './replay-exec-semantics.js';
export { executionEnvelopeFingerprint, buildExecutionEnvelope } from './replay-exec-envelope.js';
export { classifyExecutionError, normalizeStepOutcomeValue } from './replay-exec-audit.js';
