// extension/src/lib/replay-plan-view.js —— 计划派生视图（纯函数，零 chrome 依赖）。
//
// replay-plan.js 负责“构建计划”；本文件只做构建之后的派生操作，便于调用方按需引用：
//   - diffPlans：两份计划按签名对齐，报 added/removed/changed/moved；
//   - simplifyPlan：合并相邻 wait、去掉尾部 observe、去重相邻幂等动作并重算 token；
//   - resumePlan：从检查点切出“剩余步骤”，供断点续跑；
//   - planOutcomeTemplate：每步的执行占位（运行时按 index 记结果）；
//   - findPlanStep / describeReplayPlan：按 ref 查步、一行摘要；
//   - recordedStepSignature：显式区分“录制侧签名”与“计划侧签名”。
//
// 约束：纯函数；不修改入参计划（simplifyPlan 返回新对象）；输出有界（moved 最多 32 条）。

import { stableHash, stepSignature } from '../record-steps.js';
import {
  DEFAULT_PLAN_LIMITS,
  planFingerprint,
  planStepSignature,
  planToken,
  dedupeSafe,
  summarizeReplayPlan,
} from './replay-plan.js';

// ---------------------------------------------------------------------------
// 派生视图
// ---------------------------------------------------------------------------

/** 计划差异：按“签名序列”对齐，输出 added/removed/moved/changed。 */
export function diffPlans(leftPlan, rightPlan) {
  const left = Array.isArray(leftPlan) ? leftPlan : (leftPlan && Array.isArray(leftPlan.steps) ? leftPlan.steps : []);
  const right = Array.isArray(rightPlan) ? rightPlan : (rightPlan && Array.isArray(rightPlan.steps) ? rightPlan.steps : []);
  const leftSig = left.map(planStepSignature);
  const rightSig = right.map(planStepSignature);
  const added = [];
  const removed = [];
  const changed = [];
  const max = Math.max(leftSig.length, rightSig.length);
  for (let index = 0; index < max; index += 1) {
    const leftValue = leftSig[index];
    const rightValue = rightSig[index];
    if (leftValue === undefined && rightValue !== undefined) {
      added.push({ index, ref: right[index] ? right[index].ref : '' });
    } else if (leftValue !== undefined && rightValue === undefined) {
      removed.push({ index, ref: left[index] ? left[index].ref : '' });
    } else if (leftValue !== rightValue) {
      changed.push({
        index,
        left: { ref: left[index] ? left[index].ref : '', method: left[index] ? left[index].method : '' },
        right: { ref: right[index] ? right[index].ref : '', method: right[index] ? right[index].method : '' },
      });
    }
  }
  // 移动检测：同一签名从一处挪到另一处（只报前 32 条，保持有界）。
  const positionOfRight = new Map();
  rightSig.forEach((signature, index) => {
    if (!positionOfRight.has(signature)) positionOfRight.set(signature, []);
    positionOfRight.get(signature).push(index);
  });
  const moved = [];
  leftSig.forEach((signature, index) => {
    const positions = positionOfRight.get(signature);
    if (!positions || positions.includes(index)) return;
    if (moved.length < 32) moved.push({ from: index, to: positions[0], ref: left[index] ? left[index].ref : '' });
  });
  return {
    ok: added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
    moved,
    same: leftSig.length === rightSig.length && added.length === 0 && removed.length === 0 && changed.length === 0,
    summary: { left: leftSig.length, right: rightSig.length, added: added.length, removed: removed.length, changed: changed.length, moved: moved.length },
  };
}

/**
 * 简化计划：合并相邻 wait、删除尾部 observe（可选）、去重相邻幂等动作。
 * 返回新计划对象（不改原对象），token/fingerprint 重算。
 */
export function simplifyPlan(plan, options = {}) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps.map((step) => ({ ...step })) : [];
  const merged = [];
  for (const step of steps) {
    const previous = merged[merged.length - 1];
    if (previous && step.kind === 'wait' && previous.kind === 'wait') {
      previous.ms = Math.min((Number(previous.ms) || 0) + (Number(step.ms) || 0), DEFAULT_PLAN_LIMITS.maxWaitMs);
      previous.merged = (previous.merged || 1) + 1;
      continue;
    }
    merged.push(step);
  }
  let trimmed = merged;
  if (options.dropTrailingObserves !== false) {
    while (trimmed.length && trimmed[trimmed.length - 1].kind === 'observe') trimmed = trimmed.slice(0, -1);
  }
  const deduped = dedupeSafe(trimmed, { dedupeIdempotent: options.dedupeIdempotent !== false });
  const finalSteps = deduped.steps.map((step, index) => ({ ...step, index }));
  const fingerprint = planFingerprint(finalSteps);
  return {
    version: plan && plan.version ? plan.version : 1,
    steps: finalSteps,
    fingerprint,
    token: planToken(fingerprint, options.salt),
    removed: {
      waits: Boolean(merged.length < steps.length),
      trailingObserves: merged.length - trimmed.length,
      duplicates: deduped.removed,
    },
  };
}

/** 从检查点恢复：返回从该检查点继续所需的步骤切片与状态。 */
export function resumePlan(plan, checkpointId) {
  if (!plan || !Array.isArray(plan.steps)) return { ok: false, reason: 'no-plan' };
  const checkpoints = Array.isArray(plan.checkpoints) ? plan.checkpoints : [];
  if (!checkpoints.length) return { ok: false, reason: 'no-checkpoints' };
  const checkpoint = checkpointId
    ? checkpoints.find((item) => item.id === checkpointId)
    : checkpoints[0];
  if (!checkpoint) return { ok: false, reason: 'unknown-checkpoint', checkpointId: String(checkpointId || '') };
  const fromIndex = Math.max(0, Math.min(Number(checkpoint.index) || 0, plan.steps.length));
  return {
    ok: true,
    fromIndex,
    checkpoint,
    remaining: plan.steps.length - fromIndex,
    steps: plan.steps.slice(fromIndex),
    token: plan.token || '',
    fingerprint: plan.fingerprint || '',
  };
}

/** 每步的执行占位（运行时按 index 记录结果；与 steps 等长）。 */
export function planOutcomeTemplate(plan) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  return steps.map((step) => ({
    index: step.index,
    ref: step.ref || '',
    kind: step.kind,
    status: 'pending',
  }));
}

/** 按 ref 取 step（运行期把结果映射回计划）。 */
export function findPlanStep(plan, ref) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  return steps.find((step) => step.ref === ref) || null;
}

/** 计划的纯文本一行摘要（日志/解释用）。 */
export function describeReplayPlan(plan) {
  const summary = summarizeReplayPlan(plan);
  return [
    'plan ' + summary.token + ' steps=' + summary.steps,
    'boundaries=' + (summary.boundaries ? summary.boundaries.epochs : 0),
    'targets=' + (summary.targets ? summary.targets.total : 0),
    'blockers=' + summary.blockerCount,
    'warnings=' + summary.warningCount,
  ].join(' ');
}

/** 兼容 record-steps 的 stepSignature（计划侧签名与录制侧签名不是一回事，显式区分）。 */
export function recordedStepSignature(step) {
  if (!step || typeof step !== 'object') return '';
  return stepSignature(step);
}

/** 一份计划是否与另一份“等价”（用于缓存/幂等判断；忽略 token 生成时的 salt）。 */
export function sameReplayPlan(left, right) {
  const leftFingerprint = left && left.fingerprint ? String(left.fingerprint) : planFingerprint(left && left.steps);
  const rightFingerprint = right && right.fingerprint ? String(right.fingerprint) : planFingerprint(right && right.steps);
  return leftFingerprint === rightFingerprint;
}

/** 计划指纹的稳定短哈希（日志/关联用）。 */
export function planHash(plan) {
  return stableHash(plan && plan.token ? String(plan.token) : planFingerprint(plan && plan.steps));
}
