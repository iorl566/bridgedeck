// lib/recipe-blocks.mjs —— recipe 的块级能力：条件、循环、人工节点。
// 运行时由 CLI 逐块解释；这里只放纯判定，方便测试与审批。
export function recipeStepType(step) {
  const type = step && typeof step.type === 'string' ? step.type.trim().toLowerCase() : '';
  return type;
}

export function normalizeLoopTimes(value, max = 50) {
  const times = Number(value);
  if (!Number.isInteger(times) || times < 1) return 0;
  return Math.min(times, max);
}

/** URL 条件；支持 urlIncludes / urlMatches，二者都为空时视为 false。 */
export function matchRecipeWhen(when, url) {
  if (!when || typeof when !== 'object') return false;
  const target = String(url || '');
  if (typeof when.urlIncludes === 'string' && when.urlIncludes) return target.includes(when.urlIncludes);
  if (typeof when.urlMatches === 'string' && when.urlMatches) {
    try { return new RegExp(when.urlMatches).test(target); } catch { return false; }
  }
  return false;
}

/** 递归检查风险：human 安全，if/loop 只看分支。 */
export function recipeBlockRisk(steps, isSafeMethod, risky = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    const type = recipeStepType(step);
    if (type === 'human') continue;
    if (type === 'if') {
      recipeBlockRisk(step.then, isSafeMethod, risky);
      recipeBlockRisk(step.else, isSafeMethod, risky);
      continue;
    }
    if (type === 'loop') {
      recipeBlockRisk(step.steps, isSafeMethod, risky);
      continue;
    }
    if (!isSafeMethod(step)) risky.push(step && (step.method || step.action || step.command) || '(unknown)');
  }
  return risky;
}
