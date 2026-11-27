// extension/src/lib/replay-exec-envelope.js —— 回放执行信封（第二轮，从 replay-executor.js 拆出）。
//
// 执行前的确定性契约：计划指纹 + 校验和 + 步签名 + 副作用语义 → 一个可比较的
// envelope 指纹（tamper 检查 / 跨次确定性比对）。纯函数，无时钟/随机。

import { stableHash } from '../record-steps.js';
import { planFingerprint, planStepSignature, stableStringify } from './replay-plan.js';
import { replayChecksum } from './replay-verify.js';
import { REPLAY_EXECUTOR_VERSION, isObject, nonNegativeInt, stepsOf, sideEffectSemantics, summarizeSideEffects } from './replay-exec-semantics.js';

// ---------------------------------------------------------------------------
// 执行信封（envelope）：执行前的确定性契约
// ---------------------------------------------------------------------------

/**
 * 执行信封指纹：只包含可复现字段（不含日志/耗时）。
 * 可用于执行前后比对“计划没被改、语义没被改”。
 * @param {object} envelope buildExecutionEnvelope 的结果
 */
export function executionEnvelopeFingerprint(envelope) {
  const source = isObject(envelope) ? envelope : {};
  const sideEffects = isObject(source.sideEffects) ? source.sideEffects : {};
  const budget = isObject(source.budget) ? source.budget : null;
  return stableHash(stableStringify({
    version: REPLAY_EXECUTOR_VERSION,
    source: String(source.source || ''),
    planToken: String(source.planToken || ''),
    planFingerprint: String(source.planFingerprint || ''),
    checksum: String(source.checksum || ''),
    steps: nonNegativeInt(source.steps),
    stepSignatures: Array.isArray(source.stepSignatures) ? source.stepSignatures : [],
    sideEffectsDigest: String(sideEffects.digest || ''),
    budget,
    blocked: source.blocked === true,
  }));
}

/**
 * 构建执行信封：执行前就能给出的确定性事实（同计划两次必得同一 fingerprint）。
 * @param {object} plan
 * @param {{source?:string, limits?:object}} [options]
 */
export function buildExecutionEnvelope(plan, options = {}) {
  const steps = stepsOf(plan);
  const semantics = sideEffectSemantics(plan);
  const blockers = Array.isArray(plan && plan.blockers) ? plan.blockers : [];
  const stepSignatures = steps.slice(0, 256).map((step) => (step && typeof step === 'object' ? planStepSignature(step) : ''));
  const budget = plan && isObject(plan.budget)
    ? {
      steps: nonNegativeInt(plan.budget.steps),
      actions: nonNegativeInt(plan.budget.actions),
      branches: nonNegativeInt(plan.budget.branches),
      waits: nonNegativeInt(plan.budget.waits),
      humans: nonNegativeInt(plan.budget.humans),
      waitMs: nonNegativeInt(plan.budget.waitMs),
      retries: nonNegativeInt(plan.budget.retries),
      overBudget: plan.budget.overBudget === true,
    }
    : null;
  const envelope = {
    version: REPLAY_EXECUTOR_VERSION,
    deterministic: true,
    hasWallClock: false,
    virtualClock: true,
    source: String((options && options.source) || (plan && plan.source) || ''),
    planToken: String(plan && plan.token || ''),
    planFingerprint: String((plan && plan.fingerprint) || planFingerprint(steps)),
    checksum: replayChecksum(plan),
    sideEffects: summarizeSideEffects(semantics),
    steps: steps.length,
    stepSignatures,
    phases: Array.isArray(plan && plan.phases) ? plan.phases.length : 0,
    checkpoints: Array.isArray(plan && plan.checkpoints) ? plan.checkpoints.length : 0,
    budget,
    blocked: blockers.length > 0 || steps.length === 0,
    blockerCodes: [...new Set(blockers.map((blocker) => String(blocker && blocker.code || '')).filter(Boolean))].sort().slice(0, 16),
  };
  envelope.fingerprint = executionEnvelopeFingerprint(envelope);
  return envelope;
}
