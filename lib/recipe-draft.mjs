// lib/recipe-draft.mjs —— 从 session run log 草拟 recipe（纯函数）。
//
// 只映射**可回放且不依赖输入值**的步骤：
// - navigate/reload/back/forward → 对应命令（navigate 只用 origin+path，query 已在 run log 丢弃）；
// - click/hover/focus → selector / text / name 目标；
// - fill/press/select/drag/wheel 需要输入值或额外参数，run log 不保存这些值 → 跳过并给出原因。
// 结果仍是草稿（approved:false），需要人类 approve 才能跑。

const TARGET_BY_TEXT = new Set(['click', 'hover', 'focus']);

function stepTargetParams(target) {
  if (!target || typeof target !== 'object') return null;
  if (target.selector) return { selector: target.selector };
  if (target.text) return { text: target.text };
  if (target.name && TARGET_BY_TEXT.has(target.method)) return { text: target.name };
  return null;
}

/**
 * @param {string} name
 * @param {{steps?:object[]}} snapshot SessionRunLog.snapshot()
 * @param {{maxSteps?:number}} options
 * @returns {{name:string, steps:object[], skipped:object[], warnings:string[]}}
 */
export function draftRecipe(name, snapshot = {}, options = {}) {
  const maxSteps = Math.max(1, Math.min(Number(options.maxSteps) || 100, 200));
  const input = Array.isArray(snapshot && snapshot.steps) ? snapshot.steps : [];
  const steps = [];
  const skipped = [];
  const warnings = [];
  for (let index = 0; index < input.length; index += 1) {
    const step = input[index];
    if (!step || typeof step !== 'object') {
      skipped.push({ index, method: '', reason: 'invalid' });
      continue;
    }
    if (step.ok === false) {
      skipped.push({ index, method: String(step.method || ''), reason: 'failed' });
      continue;
    }
    if (steps.length >= maxSteps) {
      warnings.push('步骤超过 ' + maxSteps + '，已截断');
      break;
    }
    const method = String(step.method || '');
    if (step.kind === 'navigate') {
      if (method === 'navigate') {
        const url = String(step.origin || '') + String(step.path || '');
        if (!step.origin || !step.path) {
          skipped.push({ index, method, reason: 'no_url' });
          continue;
        }
        steps.push({ method: 'navigate', params: { url } });
      } else if (method === 'reload' || method === 'navigate-back' || method === 'navigate-forward') {
        steps.push({ method, params: {} });
      } else {
        skipped.push({ index, method, reason: 'unsupported_navigation' });
      }
      continue;
    }
    if (step.kind !== 'action') {
      skipped.push({ index, method, reason: 'unsupported_step' });
      continue;
    }
    if (step.replayable !== true) {
      skipped.push({ index, method, reason: 'needs_input' });
      continue;
    }
    const target = step.target && typeof step.target === 'object' ? { ...step.target, method } : null;
    const params = stepTargetParams(target);
    if (!params) {
      skipped.push({ index, method, reason: 'no_replay_target' });
      continue;
    }
    if (Number.isInteger(step.frameId) && step.frameId > 0) params.frameId = step.frameId;
    if (TARGET_BY_TEXT.has(method) || method === 'scroll-to') {
      steps.push({ method, params });
    } else {
      // press/select/drag/wheel/blur 等需要 run log 未保存的参数（key/value/坐标）。
      skipped.push({ index, method, reason: 'needs_args' });
    }
  }
  if (snapshot && snapshot.truncated === true) warnings.push('run log 已达到步数上限，草稿可能不完整');
  return { name: String(name || ''), steps, skipped, warnings };
}
