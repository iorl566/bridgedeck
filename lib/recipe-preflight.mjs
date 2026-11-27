// lib/recipe-preflight.mjs —— recipe 只读预检：回放前把「将要做什么/有什么风险」算清楚。
//
// 预检只读本地 recipe 内容（不触达 daemon、不改浏览器），输出：
//   - 展平后的执行序（if 分支各一份、loop 按次数展开）与每步风险/幂等/回退；
//   - 危险动作清单（browser_mutation）与需要人工确认的步骤；
//   - 阻塞项（缺参数、非幂等重试、只读模式下的写动作、审批缺失）；
//   - dry-run/真实执行共用同一份结论（CLI 直接渲染它）。
//
// 纯函数，零依赖。

import {
  normalizeRecipeSteps, flattenRecipeSteps, recipeStepMethod, recipeMaxDepth,
} from './recipe-model.mjs';
import { collectRecipeParamNames } from './recipe-params.mjs';

export const PREFLIGHT_VERSION = 1;

// 会改变页面/会话状态的方法。可逆动作（scroll-to/wheel/hover/focus/blur）不在此表：
// 它们由 RECIPE_SAFE_METHODS 判定为可逆，免审批；是否危险以 step.risk 为准。
const DANGEROUS_METHODS = new Set([
  'click', 'fill', 'press', 'select', 'drag', 'upload', 'evaluate', 'navigate', 'navigate-back',
  'navigate-forward', 'reload', 'dialog', 'tab.close', 'tab.open', 'window.close',
]);

export function isDangerousMethod(method) {
  return DANGEROUS_METHODS.has(String(method || ''));
}

/**
 * @param {object[]} rawSteps 原始 recipe steps（未归一化也可）
 * @param {{approved?:boolean, readOnly?:boolean, params?:object, paramNames?:string[],
 *   requireConfirm?:boolean, now?:number}} options
 */
export function preflightRecipe(rawSteps, options = {}) {
  const normalized = normalizeRecipeSteps(rawSteps);
  const steps = normalized.steps;
  const flat = flattenRecipeSteps(steps);
  const flattened = [];
  const dangerous = [];
  const humanGates = [];
  const confirmations = [];
  const blockers = [];
  const warnings = [...normalized.warnings];
  let actions = 0;
  let idempotent = 0;
  let nonIdempotent = 0;
  let retryable = 0;
  let skippable = 0;
  let branches = 0;
  let loops = 0;

  for (const error of normalized.errors) blockers.push({ code: 'E_INVALID_PARAMS', message: error });

  const walk = (list, depth) => {
    for (const step of Array.isArray(list) ? list : []) {
      if (step.kind === 'if') {
        branches += 1;
        walk(step.then, depth + 1);
        walk(step.else, depth + 1);
        continue;
      }
      if (step.kind === 'loop') {
        loops += 1;
        for (let index = 0; index < step.times; index += 1) walk(step.steps, depth + 1);
        continue;
      }
      if (step.kind === 'human') {
        humanGates.push({ ref: step.ref, path: step.path, reason: step.reason, timeoutMs: step.timeoutMs });
        continue;
      }
      actions += 1;
      const method = recipeStepMethod(step);
      const retryPolicy = step.fallback && step.fallback.onError === 'retry';
      const skipPolicy = step.fallback && step.fallback.onError === 'skip';
      if (step.idempotent) idempotent += 1;
      else nonIdempotent += 1;
      if (retryPolicy) retryable += 1;
      if (skipPolicy) skippable += 1;
      const entry = {
        ref: step.ref,
        path: step.path,
        kind: step.kind,
        method,
        risk: step.risk,
        idempotent: step.idempotent === true,
        fallback: step.fallback,
        expect: step.expect,
        confirm: step.params && step.params.__recipeConfirm ? String(step.params.__recipeConfirm) : null,
        depth,
      };
      flattened.push(entry);
      if (isDangerousMethod(method) || step.risk === 'browser_mutation') {
        dangerous.push({
          ref: step.ref,
          path: step.path,
          method,
          reason: step.idempotent ? '可逆动作（会改变浏览器状态）' : '非幂等动作：重复执行可能产生副作用',
        });
      }
      if (entry.confirm) {
        confirmations.push({ ref: step.ref, path: step.path, method, reason: entry.confirm });
      }
      if (retryPolicy && !step.idempotent) {
        blockers.push({
          code: 'E_ARG_CONFLICT',
          message: '第 ' + step.path + ' 步 ' + method + ' 是非幂等动作却声明了 retry：请改成 idempotent:true（确认可重复）或 fallback.onError="stop"。',
          ref: step.ref,
        });
      }
      if (step.expect && step.expectOn === 'fail' && !step.idempotent && retryPolicy) {
        warnings.push('第 ' + step.path + ' 步同时有 expect 失败策略与重试：非幂等动作不会自动重试。');
      }
    }
  };
  walk(steps, 1);

  // 参数相关：模板里有、声明里没有 → 阻塞（执行时必然缺值）。
  const templateNames = Array.isArray(options.paramNames) ? options.paramNames : collectRecipeParamNames(rawSteps);
  const declaredNames = new Set((options.declaredParams || []).map((item) => (typeof item === 'string' ? item : item && item.name)).filter(Boolean));
  const provided = options.params && typeof options.params === 'object' ? options.params : {};
  for (const name of templateNames) {
    if (!declaredNames.has(name) && !Object.prototype.hasOwnProperty.call(provided, name)) {
      blockers.push({
        code: 'E_ARG_MISSING',
        message: 'recipe 使用了 {{' + name + '}}，但没有声明默认值也没有用 --param ' + name + '=值 传入',
        param: name,
      });
    }
  }

  const approved = options.approved === true;
  const needsApproval = dangerous.length > 0;
  const requiresConfirm = confirmations.length > 0 || options.requireConfirm === true;
  if (options.readOnly === true && dangerous.length) {
    blockers.push({
      code: 'E_READ_ONLY',
      message: '只读预检模式：recipe 含 ' + dangerous.length + ' 个会改变浏览器状态的步骤，已阻止执行。',
    });
  }
  if (needsApproval && !approved) {
    blockers.push({
      code: 'E_RECIPE_NOT_APPROVED',
      message: 'recipe 含危险步骤，需人类执行 bridge recipe approve <name> --confirm-human。',
    });
  }
  const ok = blockers.length === 0;
  return {
    version: PREFLIGHT_VERSION,
    ok,
    readOnly: options.readOnly === true,
    approved,
    needsApproval,
    requiresConfirm,
    counts: {
      total: steps.length,
      flattened: flat.length,
      actions,
      idempotent,
      nonIdempotent,
      retryable,
      skippable,
      dangerous: dangerous.length,
      humanGates: humanGates.length,
      confirmations: confirmations.length,
      branches,
      loops,
      maxDepth: recipeMaxDepth(steps),
    },
    flattened,
    dangerous,
    humanGates,
    confirmations,
    blockers,
    warnings,
    paramNames: templateNames,
    // 回放估算：动作段每段一次 plan RPC；human/if/loop 各一次额外 RPC。
    estimatedRpcCalls: Math.ceil(actions / 8) + humanGates.length + confirmations.length + branches + loops,
  };
}

/** 人类可读预检文本（dry-run 与 run 失败后的下一步提示共用）。 */
export function renderPreflightText(preflight) {
  const lines = [];
  const counts = preflight.counts;
  lines.push('预检：' + (preflight.ok ? '通过' : '有阻塞项') + '（' + counts.actions + ' 个动作步骤，展平后 ' + counts.flattened + ' 步）');
  if (counts.humanGates) lines.push('  人工节点：' + counts.humanGates + ' 个（回放时会等待人类操作）');
  if (counts.dangerous) lines.push('  危险动作：' + counts.dangerous + ' 个（会改变浏览器状态，需要人工审批）');
  if (counts.nonIdempotent) lines.push('  非幂等动作：' + counts.nonIdempotent + ' 个（默认禁止自动重试）');
  if (counts.confirmations) lines.push('  需逐步确认：' + counts.confirmations + ' 个（回放时逐个请求人工确认）');
  if (counts.branches) lines.push('  条件分支：' + counts.branches + ' 个（按运行时 URL/DOM 选择，预检按两分支合计风险）');
  if (counts.loops) lines.push('  循环：' + counts.loops + ' 个（预检按次数展开风险统计）');
  for (const blocker of preflight.blockers) lines.push('  阻塞：' + blocker.code + ' ' + blocker.message);
  for (const warning of preflight.warnings) lines.push('  警告：' + warning);
  return lines;
}

/** 执行前断言：预检必须 ok，且危险步骤必须有审批。 */
export function assertPreflightRunnable(preflight, options = {}) {
  if (preflight.ok) return true;
  const first = preflight.blockers[0];
  const error = new Error(first.message);
  error.name = 'RecipePreflightError';
  error.code = first.code;
  error.details = { blockers: preflight.blockers, ...(options.details || {}) };
  throw error;
}

/** 统计预检摘要（写进 run marker / show JSON，避免把整份预检塞进 marker）。 */
export function summarizePreflight(preflight) {
  return {
    ok: preflight.ok,
    counts: preflight.counts,
    blockers: preflight.blockers,
    dangerous: preflight.dangerous.map((item) => ({ ref: item.ref, method: item.method, path: item.path })),
    humanGates: preflight.humanGates.map((item) => ({ ref: item.ref, reason: item.reason })),
    requiresConfirm: preflight.requiresConfirm,
  };
}
