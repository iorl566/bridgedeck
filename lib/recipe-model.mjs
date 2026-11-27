// lib/recipe-model.mjs —— recipe step 模型 v2（纯函数，零依赖）。
//
// 目标：把「手写或草拟出来的步骤」规范成一份可审计的执行模型：
//   - 每个 step 有稳定 ref（内容指纹，跨保存/审批/回放不变）；
//   - 明确 kind（action / observe / wait / human / if / loop）；
//   - 回退策略（failed → stop / retry / skip，可带 retries/retryOn/skipReason）；
//   - 幂等标记（只读/可逆方法默认幂等；写动作必须显式声明才能重试）；
//   - 期望（expect）用于回放差异报告。
//
// 这里不做任何 I/O，也不调用 daemon：CLI、草拟、预检、执行器共用这份模型。

import crypto from 'node:crypto';
import { RECIPE_SAFE_METHODS } from './recipe-store.mjs';

export const RECIPE_MODEL_VERSION = 2;
export const RECIPE_MAX_LOOP_TIMES = 50;
export const RECIPE_MAX_NESTING = 8;
export const RECIPE_MAX_RETRIES = 5;

/** step 的规范类型：structural 之外都映射到 action/observe/wait 三类。 */
export const RECIPE_KINDS = Object.freeze(['action', 'observe', 'wait', 'human', 'if', 'loop']);

/** 只读方法（不改变浏览器状态）——用于幂等标记与风险分级。 */
export const RECIPE_READ_METHODS = new Set([
  'observe', 'observe-frames', 'snapshot', 'get-html', 'screenshot', 'read', 'extract',
  'extract.discover', 'extract.table', 'extract.list', 'console', 'network', 'status', 'view',
  'debug.requests', 'debug.current', 'debug.performance', 'debug.history',
  'cooperate.sync', 'cooperate.wait',
]);

/** 观察类方法：执行后默认附带一次差异观测（见 recipe-diff.mjs）。 */
export const RECIPE_OBSERVE_METHODS = new Set([
  'observe', 'observe-frames', 'snapshot', 'get-html', 'read', 'extract',
  'extract.discover', 'extract.table', 'extract.list', 'console', 'network', 'status', 'view',
  'debug.requests', 'debug.current', 'debug.performance', 'debug.history',
]);

/** 等待类方法：失败多半是超时，默认建议重试而不是跳过。 */
export const RECIPE_WAIT_METHODS = new Set([
  'wait-ms', 'wait-for-element', 'wait-for-navigation', 'sleep',
]);

/** 结构性类型：不直接映射到协议方法。 */
const STRUCTURAL_TYPES = new Set(['human', 'gate', 'if', 'branch', 'loop', 'observe', 'wait', 'action']);

const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'E_TIMEOUT', 'E_OBSERVATION_STALE', 'E_STALE_REF', 'E_TARGET_MISMATCH',
  'E_TARGET_DETACHED', 'E_SESSION_BUSY', 'E_CAPTURE_STALE',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

export function recipeStepMethod(step) {
  if (!step || typeof step !== 'object') return '';
  const method = step.method ?? step.action ?? step.command;
  return typeof method === 'string' ? method.trim() : '';
}

/** 显式 type 优先；否则按 method 推断 kind。 */
export function recipeStepKind(step) {
  const raw = typeof step.type === 'string' ? step.type.trim().toLowerCase() : '';
  if (raw === 'branch') return 'if';
  if (raw === 'gate') return 'human';
  if (STRUCTURAL_TYPES.has(raw)) return raw;
  const method = recipeStepMethod(step);
  if (RECIPE_WAIT_METHODS.has(method)) return 'wait';
  if (RECIPE_OBSERVE_METHODS.has(method)) return 'observe';
  return 'action';
}

export function isRecipeStepStructural(step) {
  const kind = recipeStepKind(step);
  return kind === 'human' || kind === 'if' || kind === 'loop';
}

/** 幂等判定：只读/可逆方法 → true；step.idempotent 显式声明优先。 */
export function recipeStepIdempotent(step) {
  if (step && typeof step.idempotent === 'boolean') return step.idempotent;
  const method = recipeStepMethod(step);
  if (!method) return false;
  return RECIPE_READ_METHODS.has(method) || RECIPE_SAFE_METHODS.has(method);
}

/**
 * 稳定 ref：由「父路径 + 在父列表里的位置 + 结构类型 + 方法名 + 关键参数」算出来。
 * 只要同一份 recipe 结构不变，ref 在 save/approve/run 之间保持稳定；
 * 参数值变化会改变 ref（便于差异报告指出“这一步已经变了”）。
 */
export function recipeStepRef(step, path = '0', options = {}) {
  const kind = recipeStepKind(step);
  const method = recipeStepMethod(step);
  const detail = kind === 'human'
    ? String((step && (step.reason || step.prompt)) || '')
    : (kind === 'if' ? stableJson(step && step.when) : '');
  const params = options.includeParams === false ? '' : stableJson(asObject(step && step.params) || {});
  const seed = [RECIPE_MODEL_VERSION, path, kind, method, detail, params].join('|');
  return 'r' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

/**
 * 归一化回退/失败策略。
 * 输入兼容三种写法：
 *   - step.fallback = { onError, retries, retryOn, retryDelayMs, skipReason }
 *   - step.policy  = { onError, retries, ... }
 *   - step.onError / step.retry / step.retryDelayMs 平铺字段
 * 输出永远是稳定形状，未知字段忽略（避免把拼写错误带进执行器）。
 */
export function normalizeRecipeFallback(step, defaults = {}) {
  const source = asObject(step && step.fallback) || asObject(step && step.policy) || {};
  const onErrorRaw = source.onError ?? (step && step.onError) ?? defaults.onError ?? 'stop';
  const onError = ['stop', 'retry', 'skip', 'continue'].includes(String(onErrorRaw))
    ? (String(onErrorRaw) === 'continue' ? 'skip' : String(onErrorRaw))
    : 'stop';
  const retryRaw = source.retries ?? source.retry ?? (step && (step.retries ?? step.retry)) ?? defaults.retries ?? 0;
  const retries = Math.max(0, Math.min(Number(retryRaw) || 0, RECIPE_MAX_RETRIES));
  const delayRaw = source.retryDelayMs ?? source.retryDelay ?? (step && (step.retryDelayMs ?? step.retryDelay)) ?? defaults.retryDelayMs ?? 250;
  const retryDelayMs = Math.max(0, Math.min(Number(delayRaw) || 0, 60_000));
  const retryOnRaw = source.retryOn ?? (step && step.retryOn) ?? defaults.retryOn;
  const retryOn = Array.isArray(retryOnRaw) && retryOnRaw.length
    ? retryOnRaw.map((code) => String(code)).filter(Boolean)
    : [...DEFAULT_RETRYABLE_CODES];
  const skipReason = String(source.skipReason ?? (step && step.skipReason) ?? defaults.skipReason ?? '');
  return { onError, retries, retryDelayMs, retryOn, skipReason };
}

/** 期望（回放差异报告）：只接受白名单字段，禁止任意表达式混入。 */
const EXPECT_FIELDS = Object.freeze([
  'urlIncludes', 'urlMatches', 'urlEquals', 'urlOrigin',
  'selector', 'selectorVisible', 'selectorText', 'selectorValue', 'selectorCount',
  'methodOk', 'resultPath', 'equals', 'notEquals', 'contains', 'truthy',
]);

export function normalizeRecipeExpect(value) {
  const source = asObject(value);
  if (!source) return null;
  const expect = {};
  for (const field of EXPECT_FIELDS) {
    if (source[field] === undefined) continue;
    const current = source[field];
    if (field === 'equals' || field === 'notEquals' || field === 'contains') {
      expect[field] = current;
      continue;
    }
    if (typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') expect[field] = current;
  }
  return Object.keys(expect).length ? expect : null;
}

function normalizeCondition(value, warnings, path) {
  const source = asObject(value);
  if (!source) {
    warnings.push(path + '.when 不是对象，按“条件不成立”处理');
    return null;
  }
  const when = {};
  for (const field of ['urlIncludes', 'urlMatches', 'urlEquals', 'selector', 'selectorVisible', 'expression']) {
    if (source[field] === undefined) continue;
    const current = source[field];
    if (field === 'selectorVisible') {
      if (typeof current === 'boolean' || typeof current === 'string') when[field] = current;
    } else if (typeof current === 'string' && current) {
      when[field] = current;
    }
  }
  if (source.negate === true) when.negate = true;
  if (!Object.keys(when).length) warnings.push(path + '.when 没有可用条件字段（urlIncludes/urlMatches/urlEquals/selector/expression）');
  return Object.keys(when).length ? when : null;
}

function normalizeNestedList(value, warnings, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(path + ' 不是步骤数组，按空数组处理');
    return [];
  }
  return value;
}

/**
 * 归一化单个 step（递归处理 if/loop）。
 * @returns {{step: object|null, warnings: string[], errors: string[]}}
 */
export function normalizeRecipeStep(step, options = {}) {
  const path = String(options.path || '0');
  const depth = Number(options.depth) || 0;
  const defaults = asObject(options.defaults) || {};
  const warnings = [];
  const errors = [];
  if (depth > RECIPE_MAX_NESTING) {
    return { step: null, warnings, errors: ['步骤嵌套超过 ' + RECIPE_MAX_NESTING + ' 层：' + path] };
  }
  if (!step || typeof step !== 'object') {
    return { step: null, warnings, errors: ['第 ' + path + ' 步不是对象'] };
  }
  const kind = recipeStepKind(step);
  const method = recipeStepMethod(step);
  const ref = recipeStepRef(step, path, { includeParams: options.includeParams });

  if (kind === 'human') {
    const reason = String(step.reason || step.prompt || step.message || '请完成人工步骤');
    return {
      step: {
        ref,
        path,
        kind: 'human',
        type: 'human',
        reason,
        timeoutMs: Math.max(5000, Math.min(Number(step.timeoutMs) || 180000, 1_800_000)),
        confirm: step.confirm === true ? 'human-gate' : null,
        fallback: normalizeRecipeFallback(step, { onError: 'stop', ...defaults }),
        idempotent: true,
        risk: 'human_gate',
        expect: null,
      },
      warnings,
      errors,
    };
  }
  if (kind === 'if') {
    const when = normalizeCondition(step.when || step.condition, warnings, path);
    const thenList = normalizeNestedList(step.then ?? step.steps, warnings, path + '.then');
    const elseList = normalizeNestedList(step.else, warnings, path + '.else');
    const normalized = { ref, path, kind: 'if', type: 'if', when, then: [], else: [], fallback: normalizeRecipeFallback(step, defaults), idempotent: true, risk: 'read_only', expect: null };
    thenList.forEach((child, index) => {
      const result = normalizeRecipeStep(child, { path: path + '.then.' + index, depth: depth + 1, defaults, includeParams: options.includeParams });
      warnings.push(...result.warnings);
      errors.push(...result.errors);
      if (result.step) normalized.then.push(result.step);
    });
    elseList.forEach((child, index) => {
      const result = normalizeRecipeStep(child, { path: path + '.else.' + index, depth: depth + 1, defaults, includeParams: options.includeParams });
      warnings.push(...result.warnings);
      errors.push(...result.errors);
      if (result.step) normalized.else.push(result.step);
    });
    return { step: normalized, warnings, errors };
  }
  if (kind === 'loop') {
    const timesRaw = Number(step.times ?? step.count ?? 1);
    const times = Number.isInteger(timesRaw) && timesRaw >= 1 ? Math.min(timesRaw, RECIPE_MAX_LOOP_TIMES) : 1;
    if (Number.isInteger(timesRaw) && timesRaw > RECIPE_MAX_LOOP_TIMES) {
      warnings.push(path + '.times 超过上限，已裁剪为 ' + RECIPE_MAX_LOOP_TIMES);
    }
    if (timesRaw !== times) {
      errors.push('第 ' + path + ' 步 loop 的 times 需要 1-' + RECIPE_MAX_LOOP_TIMES + ' 的整数');
    }
    const body = normalizeNestedList(step.steps, warnings, path + '.steps');
    const normalized = {
      ref,
      path,
      kind: 'loop',
      type: 'loop',
      times,
      until: step.until !== undefined ? normalizeCondition(step.until, warnings, path) : null,
      breakOn: step.breakOn === false ? false : true,
      steps: [],
      fallback: normalizeRecipeFallback(step, defaults),
      idempotent: true,
      risk: 'read_only',
      expect: null,
    };
    body.forEach((child, index) => {
      const result = normalizeRecipeStep(child, { path: path + '.steps.' + index, depth: depth + 1, defaults, includeParams: options.includeParams });
      warnings.push(...result.warnings);
      errors.push(...result.errors);
      if (result.step) normalized.steps.push(result.step);
    });
    return { step: normalized, warnings, errors };
  }

  if (!method) {
    errors.push('第 ' + path + ' 步缺少 method/action/command');
    return { step: null, warnings, errors };
  }
  const params = asObject(step.params) ? { ...step.params } : {};
  if (step.confirm !== undefined && step.confirm !== false && step.confirm !== null) {
    // 危险动作确认：执行前插入一个人工闸门（见 recipe-engine.mjs）。
    const reason = typeof step.confirm === 'string' ? step.confirm : '确认执行危险步骤：' + method;
    params.__recipeConfirm = reason;
  }
  const idempotent = recipeStepIdempotent(step);
  const normalized = {
    ref,
    path,
    kind,
    type: kind === 'action' ? 'action' : kind,
    method,
    params,
    fallback: normalizeRecipeFallback(step, defaults),
    idempotent,
    risk: idempotent ? 'read_only' : 'browser_mutation',
    expect: normalizeRecipeExpect(step.expect),
    expectOn: step.expectOn === 'fail' ? 'fail' : 'warn',
    timeoutMs: Number.isFinite(Number(step.timeoutMs)) ? Math.max(1000, Number(step.timeoutMs)) : 0,
  };
  if (step.revision !== undefined) normalized.sourceRevision = step.revision;
  if (step.frameId !== undefined && params.frameId === undefined) params.frameId = step.frameId;
  if (!idempotent && /^(click|fill|press|select|drag|upload|evaluate|navigate)$/.test(method) && step.retry !== undefined) {
    warnings.push(path + ' 是非幂等动作 ' + method + '：默认拒绝重试（需 idempotent:true 或 retrySafe:true 才允许）');
  }
  return { step: normalized, warnings, errors };
}

/**
 * 归一化整份 recipe 步骤。
 * @returns {{version:number, steps:object[], warnings:string[], errors:string[], defaults:object}}
 */
export function normalizeRecipeSteps(steps, options = {}) {
  const warnings = [];
  const errors = [];
  const defaults = asObject(options.defaults) || {};
  const list = Array.isArray(steps) ? steps : [];
  const normalized = [];
  list.forEach((step, index) => {
    const result = normalizeRecipeStep(step, { path: String(index), defaults, includeParams: options.includeParams });
    warnings.push(...result.warnings);
    errors.push(...result.errors);
    if (result.step) normalized.push(result.step);
  });
  return { version: RECIPE_MODEL_VERSION, steps: normalized, warnings, errors, defaults };
}

/** 展平执行顺序（if 两分支都计入，loop 按次数展开），供预检/差异报告使用。 */
export function flattenRecipeSteps(steps) {
  const out = [];
  const walk = (list) => {
    for (const step of Array.isArray(list) ? list : []) {
      if (step.kind === 'if') {
        walk(step.then);
        walk(step.else);
        continue;
      }
      if (step.kind === 'loop') {
        for (let index = 0; index < step.times; index += 1) walk(step.steps);
        continue;
      }
      out.push(step);
    }
  };
  walk(steps);
  return out;
}

/** 统计结构信息：给预检/差异报告当摘要。 */
export function summarizeRecipeStructure(steps) {
  const counts = { action: 0, observe: 0, wait: 0, human: 0, if: 0, loop: 0, total: 0 };
  const methods = [];
  const refs = [];
  let idempotent = 0;
  let nonIdempotent = 0;
  let retryable = 0;
  let skippable = 0;
  const walk = (list) => {
    for (const step of Array.isArray(list) ? list : []) {
      counts.total += 1;
      counts[step.kind] = (counts[step.kind] || 0) + 1;
      if (step.ref) refs.push(step.ref);
      if (step.method) methods.push(step.method);
      if (step.kind === 'action' || step.kind === 'observe' || step.kind === 'wait') {
        if (step.idempotent) idempotent += 1;
        else nonIdempotent += 1;
        if (step.fallback.onError === 'retry') retryable += 1;
        if (step.fallback.onError === 'skip') skippable += 1;
      }
      if (step.kind === 'if') { walk(step.then); walk(step.else); }
      if (step.kind === 'loop') walk(step.steps);
    }
  };
  walk(steps);
  return {
    version: RECIPE_MODEL_VERSION,
    counts,
    methods,
    refs,
    idempotent,
    nonIdempotent,
    retryable,
    skippable,
    maxDepth: recipeMaxDepth(steps),
  };
}

export function recipeMaxDepth(steps, depth = 1) {
  let max = depth;
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step.kind === 'if') {
      max = Math.max(max, recipeMaxDepth(step.then, depth + 1), recipeMaxDepth(step.else, depth + 1));
    } else if (step.kind === 'loop') {
      max = Math.max(max, recipeMaxDepth(step.steps, depth + 1));
    }
  }
  return max;
}

/** 人类可读的一行步骤描述（CLI 文本输出/错误证据共用）。 */
export function describeRecipeStep(step) {
  if (!step || typeof step !== 'object') return '(无效步骤)';
  const label = step.method || step.kind || 'step';
  const target = step.params && (step.params.ref || step.params.selector || step.params.text);
  const where = target ? ' → ' + target : '';
  const fallback = step.fallback && step.fallback.onError !== 'stop'
    ? ' [' + step.fallback.onError + (step.fallback.retries ? '×' + step.fallback.retries : '') + ']'
    : '';
  return String(step.ref || '-') + ' ' + label + where + fallback;
}

/** 稳定 ref → step 的索引（预检/执行器回查）。 */
export function indexRecipeSteps(steps) {
  const index = new Map();
  const walk = (list) => {
    for (const step of Array.isArray(list) ? list : []) {
      if (step && step.ref) index.set(step.ref, step);
      if (step && step.kind === 'if') { walk(step.then); walk(step.else); }
      if (step && step.kind === 'loop') walk(step.steps);
    }
  };
  walk(steps);
  return index;
}
