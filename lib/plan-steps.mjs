// lib/plan-steps.mjs —— plan 步骤写法归一化。
//
// 规范写法：{ method, params }
// 兼容写法：{ action: "fill", ref: "@e1", value: "x" } 或 { action: { method, params } }
// daemon 在参数校验前统一成规范写法，这样 schema 仍可要求 method。
export function normalizePlanStep(step) {
  if (!step || typeof step !== 'object') return step;
  let method = typeof step.method === 'string' ? step.method : '';
  let params = step.params && typeof step.params === 'object' ? { ...step.params } : {};
  if (typeof step.action === 'string' && step.action) {
    if (!method) method = step.action;
    const flat = { ...step };
    delete flat.action;
    delete flat.method;
    delete flat.params;
    params = { ...flat, ...params };
  } else if (step.action && typeof step.action === 'object') {
    if (!method && typeof step.action.method === 'string') method = step.action.method;
    const nested = step.action.params && typeof step.action.params === 'object' ? step.action.params : {};
    params = { ...nested, ...params };
  }
  if (!method) return step;
  return { method, params };
}

export function normalizePlanSteps(steps) {
  return Array.isArray(steps) ? steps.map(normalizePlanStep) : steps;
}
