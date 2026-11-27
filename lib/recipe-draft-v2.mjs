// lib/recipe-draft-v2.mjs —— 从 session run log 草拟 step 模型 v2 的 recipe。
//
// 与 v1 draftRecipe 的差异：
//   - 每个草稿步骤都带稳定 ref、kind（action/observe/wait）、幂等标记、回退策略、
//     可选 expect（navigate 步骤记录期望 URL，回放时进差异报告）；
//   - 保留来源证据（sessionId/run-log 下标/revision/frameId），审批时能回答“这步从哪来”；
//   - 需要输入值（fill/press/select/upload）的步骤仍跳过，但额外给出 humanGates 建议，
//     让人类知道哪些位置需要在回放时人工补值——不自动插入 human 节点，避免改变既有回放契约。
//
// 纯函数；CLI draft 子命令调用。

import { normalizeRecipeSteps } from './recipe-model.mjs';

const TARGET_BY_TEXT = new Set(['click', 'hover', 'focus']);

export const DRAFT_V2_VERSION = 2;

function targetParams(method, target) {
  if (!target || typeof target !== 'object') return null;
  if (target.selector) return { selector: target.selector };
  if (target.text) return { text: target.text };
  if (target.name && TARGET_BY_TEXT.has(method)) return { text: target.name };
  return null;
}

function navigateUrl(step) {
  if (!step || !step.origin || !step.path) return '';
  return String(step.origin) + String(step.path);
}

/**
 * @param {string} name
 * @param {{steps?:object[], sessionId?:string, truncated?:boolean, recordingId?:string}} snapshot
 * @param {{maxSteps?:number}} options
 * @returns {{name:string, version:number, steps:object[], skipped:object[], humanGates:object[],
 *   warnings:string[], source:object}}
 */
export function draftRecipeV2(name, snapshot = {}, options = {}) {
  const maxSteps = Math.max(1, Math.min(Number(options.maxSteps) || 100, 200));
  const input = Array.isArray(snapshot && snapshot.steps) ? snapshot.steps : [];
  const raw = [];
  const skipped = [];
  const humanGates = [];
  const warnings = [];
  let truncated = false;
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
    const method = String(step.method || '');
    if (step.kind === 'navigate') {
      if (method === 'navigate') {
        const url = navigateUrl(step);
        if (!url) {
          skipped.push({ index, method, reason: 'no_url' });
          continue;
        }
        raw.push({
          method: 'navigate',
          params: { url },
          expect: step.path ? { urlIncludes: String(step.path) } : null,
          // 导航到确定的 URL 是可重复的（同目标），显式声明幂等，允许 draft 带 retry。
          idempotent: true,
          fallback: { onError: 'retry', retries: 1, retryDelayMs: 300 },
          source: { index, sessionId: snapshot.sessionId || '', revision: Number.isInteger(step.revision) ? step.revision : null },
        });
      } else if (method === 'reload' || method === 'navigate-back' || method === 'navigate-forward') {
        raw.push({
          method,
          params: {},
          idempotent: true,
          fallback: { onError: 'retry', retries: 1, retryDelayMs: 300 },
          source: { index, sessionId: snapshot.sessionId || '' },
        });
      } else {
        skipped.push({ index, method, reason: 'unsupported_navigation' });
      }
      continue;
    }
    if (step.kind !== 'action') {
      skipped.push({ index, method, reason: 'unsupported_step' });
      continue;
    }
    const params = targetParams(method, step.target && typeof step.target === 'object' ? { ...step.target, method } : null);
    if (!params) {
      skipped.push({ index, method, reason: 'no_replay_target' });
      continue;
    }
    if (Number.isInteger(step.frameId) && step.frameId > 0) params.frameId = step.frameId;
    if (step.replayable !== true || ['fill', 'press', 'select', 'drag', 'wheel', 'upload', 'evaluate'].includes(method)) {
      skipped.push({ index, method, reason: step.replayable !== true ? 'needs_input' : 'needs_args' });
      const needsValue = ['fill', 'press', 'select', 'upload'].includes(method);
      if (needsValue) {
        humanGates.push({
          index,
          method,
          target: params.selector || params.text || '',
          reason: '回放前需要人工补值：' + method + (params.selector ? ' ' + params.selector : ''),
        });
      }
      continue;
    }
    if (TARGET_BY_TEXT.has(method) || method === 'scroll-to') {
      raw.push({
        method,
        params,
        // click/hover/focus 没有可断言的稳定结果；expect 留空，避免误报差异。
        fallback: { onError: 'stop', skipReason: '' },
        source: { index, sessionId: snapshot.sessionId || '', revision: Number.isInteger(step.revision) ? step.revision : null },
      });
      continue;
    }
    skipped.push({ index, method, reason: 'needs_args' });
  }
  if (raw.length > maxSteps) {
    truncated = true;
    warnings.push('步骤超过 ' + maxSteps + '，已截断');
  }
  const kept = raw.slice(0, maxSteps);
  const modelSteps = kept.map((step) => ({
    method: step.method,
    params: step.params,
    ...(step.expect ? { expect: step.expect } : {}),
    ...(step.fallback ? { fallback: step.fallback } : {}),
    // 幂等声明必须透传：否则 draft 里的 navigate retry 会被预检判成"非幂等却重试"。
    ...(step.idempotent !== undefined ? { idempotent: step.idempotent } : {}),
  }));
  const normalized = normalizeRecipeSteps(modelSteps, { defaults: { onError: 'stop' } });
  for (const warning of normalized.warnings) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  const steps = normalized.steps.map((step, index) => ({
    ...step,
    ...(kept[index] && kept[index].source ? { source: kept[index].source } : {}),
  }));
  if (snapshot && snapshot.truncated === true) warnings.push('run log 已达到步数上限，草稿可能不完整');
  return {
    name: String(name || ''),
    version: DRAFT_V2_VERSION,
    steps,
    skipped,
    humanGates,
    warnings,
    source: {
      kind: 'session-run-log',
      sessionId: String((snapshot && snapshot.sessionId) || ''),
      ...(snapshot && snapshot.recordingId ? { recordingId: String(snapshot.recordingId) } : {}),
      stepsRead: input.length,
      draftedAt: Date.now(),
      truncated,
    },
  };
}

/** 草稿来源摘要（审批/回放证据展示用）。 */
export function summarizeDraftSource(draft) {
  const source = draft && draft.source ? draft.source : {};
  return {
    sessionId: source.sessionId || '',
    stepsRead: Number(source.stepsRead) || 0,
    draftedSteps: Array.isArray(draft && draft.steps) ? draft.steps.length : 0,
    skipped: Array.isArray(draft && draft.skipped) ? draft.skipped.length : 0,
    humanGates: Array.isArray(draft && draft.humanGates) ? draft.humanGates.length : 0,
  };
}
