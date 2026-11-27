// daemon/effect-state.js —— 动作结果/错误 effect_state 标注。
import { isMutating } from '../lib/methods.mjs';

export function withEffectState(error, effectState) {
  if (!error || typeof error !== 'object') return error;
  const data = { ...(error.data && typeof error.data === 'object' ? error.data : {}) };
  if (data.effect_state === undefined && data.effectState === undefined) data.effect_state = effectState;
  error.data = data;
  return error;
}

/** 变异操作成功 → committed；业务失败结果（ok:false / failedAt）与只读方法保持原样。 */
export function annotateEffectSuccess(result, method) {
  if (!isMutating(method) || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (result.ok === false || result.failed === true || result.failedAt !== undefined) return result;
  if (result.effectState === undefined && result.effect_state === undefined) result.effectState = 'committed';
  return result;
}
