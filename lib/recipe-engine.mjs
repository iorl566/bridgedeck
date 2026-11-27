// lib/recipe-engine.mjs —— recipe 执行器（step 模型 v2 的解释器）。
//
// 与旧 executeRecipeBlocks 的关系：
//   - 旧实现把连续动作切段交给 daemon plan，遇到 human/if/loop 时自己递归；
//   - 这里把「切段/递归/失败策略/期望对比/证据」收进一个可注入 driver 的纯解释器，
//     连续动作仍然合并成 plan 段（每段 ≤ MAX_SEGMENT），因此默认回放语义与旧实现一致；
//   - driver 由 CLI 注入（runSteps → plan RPC；evaluate → evaluate RPC；requestHelp）；
//     单测注入假 driver 即可逐条断言重试/跳过/差异报告。
//
// 不变量：
//   1. 非幂等动作默认不重试（避免 click/fill 重复副作用）；显式 idempotent:true 才允许。
//   2. 每步都有固定上限（总执行步数 maxSteps），循环/分支不会无限放大。
//   3. 失败一定留下结构化证据：哪一步、什么错误、试了几次、能否重试、下一步建议。
//
// 错误码复用已登记集合（lib/error-codes.mjs）：E_INVALID_PARAMS / E_FORBIDDEN /
// E_TOO_LARGE / E_EXPECT_FAILED / E_HUMAN_GATE / E_CANCELLED / E_TIMEOUT 等。

import {
  normalizeRecipeSteps, flattenRecipeSteps, describeRecipeStep,
} from './recipe-model.mjs';
import {
  expectationProbes, buildActual, compareExpectation, buildReplayReport,
} from './recipe-diff.mjs';

export const ENGINE_VERSION = 2;
export const MAX_SEGMENT = 8;
export const DEFAULT_MAX_STEPS = 200;

const RETRYABLE_CODES = new Set([
  'E_TIMEOUT', 'E_OBSERVATION_STALE', 'E_STALE_REF', 'E_TARGET_MISMATCH',
  'E_TARGET_DETACHED', 'E_SESSION_BUSY', 'E_CAPTURE_STALE', 'E_EXPECT_FAILED',
]);

export class RecipeEngineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RecipeEngineError';
    this.code = code;
    this.details = details;
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function errorOf(body) {
  const error = asObject(body && body.error);
  return {
    code: error && typeof error.code === 'string' ? error.code : 'E_INTERNAL',
    message: error && typeof error.message === 'string' ? error.message : 'recipe 步骤执行失败',
    ...(error && asObject(error.data) ? { data: error.data } : {}),
  };
}

export function isRetryableCode(code, retryOn) {
  const allowed = Array.isArray(retryOn) && retryOn.length ? retryOn : [...RETRYABLE_CODES];
  return allowed.includes(String(code || ''));
}

/**
 * 把 when 条件编译成一条只读 evaluate 表达式。
 * - url* 条件：读 location.href
 * - selector 条件：读 document.querySelector 的存在/可见
 * - expression：调用方明确写的表达式（视为已审批内容）
 * 返回的表达式永远返回布尔值。
 */
export function buildConditionExpression(when) {
  const source = asObject(when) || {};
  const parts = [];
  if (source.urlIncludes !== undefined) {
    parts.push('u.indexOf(' + JSON.stringify(String(source.urlIncludes)) + ')>=0');
  }
  if (source.urlMatches !== undefined) {
    parts.push('(function(){try{return new RegExp(' + JSON.stringify(String(source.urlMatches)) + ').test(u)}catch(e){return false}})()');
  }
  if (source.urlEquals !== undefined) parts.push('u===' + JSON.stringify(String(source.urlEquals)));
  const selector = source.selector !== undefined ? String(source.selector) : '';
  const needsDom = selector && (source.selectorVisible !== undefined || source.selector !== undefined);
  if (needsDom) {
    let body = 'function(){var u=String(location.href||"");';
    body += 'var el=null;try{el=document.querySelector(' + JSON.stringify(selector) + ')}catch(e){el=null};';
    if (source.selectorVisible !== undefined) {
      body += 'if(!el)return false;var r=el.getBoundingClientRect();var st=null;try{st=getComputedStyle(el)}catch(e){};'
        + 'return r.width>0&&r.height>0&&(!st||(st.visibility!=="hidden"&&st.display!=="none"&&Number(st.opacity)!==0));';
    } else {
      body += 'return !!el;';
    }
    parts.push('(function(){' + body + '})()');
  }
  if (source.expression !== undefined) parts.push('Boolean(function(){try{return (' + String(source.expression) + ')}catch(e){return false}})()');
  if (!parts.length) return 'false';
  const joined = parts.join('&&');
  return '(function(){return Boolean(' + (source.negate === true ? '!(' + joined + ')' : joined) + ')})()';
}

/** 可见性/文本探测表达式（差异报告用；只读 DOM）。 */
export function buildSelectorProbeExpression(selector) {
  return '(function(){var el=null;try{el=document.querySelector(' + JSON.stringify(String(selector)) + ')}catch(e){return {exists:false}};'
    + 'if(!el)return {exists:false};var r=el.getBoundingClientRect();var st=null;try{st=getComputedStyle(el)}catch(e){};'
    + 'var count=0;try{count=document.querySelectorAll(' + JSON.stringify(String(selector)) + ').length}catch(e){count=1};'
    + 'return {exists:true,visible:r.width>0&&r.height>0&&(!st||(st.visibility!=="hidden"&&st.display!=="none"&&Number(st.opacity)!==0)),'
    + 'text:String(el.innerText||el.textContent||"").slice(0,500),value:String(el.value==null?"":el.value),count:count};})()';
}

function stepIdentity(step, executedIndex) {
  return {
    ref: step.ref || '',
    path: step.path || String(executedIndex),
    kind: step.kind || 'action',
    method: step.method || '',
    idempotent: step.idempotent === true,
  };
}

function normalizedParams(value) {
  const out = {};
  for (const [key, current] of Object.entries(asObject(value) || {})) {
    out[key] = typeof current === 'string' && current.length > 120 ? current.slice(0, 120) + '…' : current;
  }
  return out;
}

/** 失败证据：给 run marker / CLI 输出的结构化“错误闭环”。 */
export function buildFailureEvidence(failure, results) {
  if (!failure || !failure.entry) return null;
  const executed = (Array.isArray(results) ? results : []).filter((item) => item.status === 'ok' || item.status === 'failed');
  return {
    failedStep: {
      ref: failure.entry.ref,
      path: failure.entry.path,
      method: failure.entry.method,
      kind: failure.entry.kind,
      attempts: failure.entry.attempts,
    },
    reason: failure.error,
    canRetry: failure.retryable === true,
    next: failure.next,
    fallback: failure.entry.fallback || null,
    history: executed.slice(-8).map((item) => ({ ref: item.ref, status: item.status, method: item.method, attempts: item.attempts })),
  };
}

/**
 * 执行一份已归一化的 recipe。
 * @param {object[]} steps normalizeRecipeSteps().steps
 * @param {object} options
 * @param {object} options.drivers 见文件头注释
 * @param {object} [options.policy] 全局失败策略
 * @param {number} [options.maxSteps]
 * @returns {Promise<{ok:boolean, completed:number, planned:number, failedAt:number|null, failedPath:string|null,
 *   results:object[], report:object, aborted:boolean, error:object|null}>}
 */
export async function runRecipeEngine(steps, options = {}) {
  const drivers = asObject(options.drivers) || {};
  if (typeof drivers.runSteps !== 'function') {
    throw new RecipeEngineError('E_INTERNAL', 'recipe engine 缺少 driver.runSteps');
  }
  const now = typeof drivers.now === 'function' ? drivers.now : () => Date.now();
  const sleep = typeof drivers.sleep === 'function' ? drivers.sleep : ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const policy = asObject(options.policy) || {};
  const maxSteps = Math.max(1, Math.min(Number(options.maxSteps) || DEFAULT_MAX_STEPS, 2000));
  const structural = options.structuralSteps === true;
  const normalized = structural
    ? { steps, warnings: [], errors: [] }
    : normalizeRecipeSteps(steps, { defaults: policy });
  for (const error of normalized.errors || []) {
    throw new RecipeEngineError('E_INVALID_PARAMS', 'recipe 步骤不合法：' + error);
  }

  const results = [];
  const startedAt = now();
  let planned = 0;
  let completed = 0;
  let executedSteps = 0;
  let failedAt = null;
  let failedPath = null;
  let aborted = false;
  let failure = null;
  let currentGroup = [];

  const emit = (event) => {
    if (typeof options.onEvent !== 'function') return;
    try { options.onEvent(event); } catch { /* 观察者异常不影响回放 */ }
  };

  const stepPolicy = (step) => {
    const fallback = asObject(step.fallback) || {};
    const onError = ['stop', 'retry', 'skip'].includes(fallback.onError)
      ? fallback.onError
      : (['stop', 'retry', 'skip'].includes(policy.onError) ? policy.onError : 'stop');
    const retries = Math.max(0, Math.min(
      Number(fallback.retries) || 0,
      Number(policy.retries) || 0 || Number(fallback.retries) || 0,
      5,
    ));
    const retryDelayMs = Math.max(0, Math.min(Number(fallback.retryDelayMs) || Number(policy.retryDelayMs) || 0, 60_000));
    const retryOn = Array.isArray(fallback.retryOn) && fallback.retryOn.length
      ? fallback.retryOn
      : (Array.isArray(policy.retryOn) && policy.retryOn.length ? policy.retryOn : [...RETRYABLE_CODES]);
    return { onError, retries, retryDelayMs, retryOn, skipReason: String(fallback.skipReason || policy.skipReason || '') };
  };

  const retryableFor = (step, error) => {
    const stepPolicyValue = stepPolicy(step);
    const code = error && error.code;
    if (!isRetryableCode(code, stepPolicyValue.retryOn)) return false;
    if (step.idempotent === true) return true;
    // 非幂等动作：只有显式 retrySafe 才允许重试。
    return step.retrySafe === true || (step.params && step.params.retrySafe === true);
  };

  const noteFailure = (step, error, extra = {}) => {
    const identity = stepIdentity(step, results.length);
    const retryable = retryableFor(step, error);
    const entry = {
      ...identity,
      status: 'failed',
      startedAt: extra.startedAt || startedAt,
      durationMs: Math.max(0, now() - (extra.startedAt || startedAt)),
      attempts: Number(extra.attempts) || 1,
      error,
      retryable,
      fallback: stepPolicy(step),
      stepExcerpt: describeRecipeStep(step),
      ...(extra.diff ? { diff: extra.diff } : {}),
    };
    results.push(entry);
    failure = {
      step,
      entry,
      error,
      retryable,
      next: retryable
        ? '可重试：确认页面状态后重跑同一 recipe，或把该步 fallback.onError 设为 retry。'
        : '不可自动重试：这是非幂等动作，重复执行可能产生副作用；请人工检查页面后决定是否跳过。',
    };
    failedPath = entry.path;
    return entry;
  };

  const fail = (step, error, extra = {}) => {
    noteFailure(step, error, extra);
    aborted = true;
    // 1-based“第几步失败”（= 已成功步数 + 1）；failedPath 用于定位嵌套块。
    failedAt = completed + 1;
    return false;
  };

  const stripInternal = (params) => {
    const out = { ...(asObject(params) || {}) };
    delete out.__recipeConfirm;
    return out;
  };

  /** 执行单个动作（用于重试/确认后的单步执行）。 */
  const executeSingle = async (step, execOptions = {}) => {
    const startedAt = now();
    executedSteps += 1;
    if (executedSteps > maxSteps) {
      throw new RecipeEngineError('E_TOO_LARGE', 'recipe 回放超过 ' + maxSteps + ' 步上限（检查 loop 次数）');
    }
    if (execOptions.countPlanned === true) planned += 1;
    const body = await drivers.runSteps([{ method: step.method, params: stripInternal(step.params) }]);
    if (body && body.ok === true && asObject(body.result)) {
      const failedIndex = body.result.failedAt;
      if (failedIndex !== null && failedIndex !== undefined) {
        const first = Array.isArray(body.result.steps) ? body.result.steps[Number(failedIndex)] : null;
        return { ok: false, error: errorOf(first || body), startedAt };
      }
      const first = Array.isArray(body.result.steps) ? body.result.steps[0] : null;
      return { ok: true, result: first && first.result !== undefined ? first.result : null, startedAt };
    }
    return { ok: false, error: errorOf(body), startedAt };
  };

  /** 执行前确认（step.confirm → 临时 human gate）。 */
  const confirmStep = async (step) => {
    const reason = step.params && step.params.__recipeConfirm;
    if (!reason) return { ok: true };
    if (typeof drivers.requestHelp !== 'function') {
      return { ok: false, error: { code: 'E_INTERNAL', message: '该 recipe 需要危险动作确认，但 driver 未提供 requestHelp' } };
    }
    const body = await drivers.requestHelp({ reason: String(reason), timeoutMs: 180_000, stepRef: step.ref });
    const action = String((body && body.result && body.result.action) || (body && body.action) || 'timeout');
    if (body && body.ok !== false && ['approve', 'approved', 'continue', 'continue-once', 'done'].includes(action)) {
      return { ok: true, action };
    }
    if (body && body.ok === true && action === 'skip') return { ok: true, action: 'skip' };
    return {
      ok: false,
      error: {
        code: action === 'timeout' ? 'E_TIMEOUT' : 'E_HUMAN_GATE',
        message: action === 'timeout' ? '危险动作确认等待超时' : '人工拒绝了危险动作：' + String(reason),
      },
      declined: true,
    };
  };

  /** 差异比对：执行成功后采集实际值并记录。 */
  const evaluateExpectation = async (step, rawResult, ok) => {
    if (!step.expect) return null;
    const parseValue = (value) => {
      // evaluate 的 value 有时是 JSON 字符串（页面侧 JSON.stringify），统一解成对象。
      if (typeof value !== 'string') return value;
      const text = value.trim();
      if (!text || (text[0] !== '{' && text[0] !== '[')) return value;
      try { return JSON.parse(text); } catch { return value; }
    };
    const probes = expectationProbes(step.expect);
    const raw = { url: '', selectors: {}, ok, result: rawResult };
    for (const probe of probes) {
      if (probe.kind === 'url') {
        if (typeof drivers.evaluate !== 'function') continue;
        const body = await drivers.evaluate('String(location.href||"")');
        raw.url = body && body.ok ? String(body.value ?? (body.result && body.result.value) ?? '') : '';
      } else if (probe.kind === 'selector' && probe.selector) {
        if (typeof drivers.evaluate !== 'function') continue;
        const expression = buildSelectorProbeExpression(probe.selector);
        const body = await drivers.evaluate(expression);
        const value = parseValue(body && body.ok ? (body.value ?? (body.result && body.result.value)) : null);
        raw.selectors[probe.selector] = asObject(value) || { exists: false };
      }
    }
    const actual = buildActual(step.expect, raw);
    return compareExpectation(step.expect, actual);
  };

  const recordOk = (step, extra = {}) => {
    const identity = stepIdentity(step, results.length);
    results.push({
      ...identity,
      status: 'ok',
      startedAt: extra.startedAt || startedAt,
      durationMs: Math.max(0, now() - (extra.startedAt || startedAt)),
      attempts: Number(extra.attempts) || 1,
      ...(extra.diff && extra.diff.length ? { diff: extra.diff } : {}),
    });
  };

  /** 首步失败后为段内未执行步骤补 blocked 记录。 */
  const markBlocked = (group, fromIndex) => {
    for (let rest = fromIndex; rest < group.length; rest += 1) {
      results.push({
        ...stepIdentity(group[rest], results.length),
        status: 'blocked',
        attempts: 0,
        durationMs: 0,
        error: { code: 'E_CANCELLED', message: '前一步失败，未执行' },
      });
    }
  };

  /** 失败策略处理：返回 'continue' 表示可以继续执行后续步骤。 */
  const handleFailure = async (step, error, extra = {}) => {
    const stepPolicyValue = stepPolicy(step);
    if (stepPolicyValue.onError === 'skip') {
      results.push({
        ...stepIdentity(step, results.length),
        status: 'skipped',
        skippedReason: stepPolicyValue.skipReason || ('失败后跳过：' + error.code),
        error,
        attempts: Number(extra.attempts) || 1,
        durationMs: 0,
      });
      emit({ type: 'step-skipped', ref: step.ref, code: error.code });
      return 'continue';
    }
    if (stepPolicyValue.onError === 'retry') {
      const retryable = retryableFor(step, error);
      let attempts = Number(extra.attempts) || 1;
      if (!retryable) {
        fail(step, {
          code: 'E_FORBIDDEN',
          message: '非幂等步骤拒绝自动重试（' + error.code + '）：' + error.message,
          data: { original: error, idempotent: step.idempotent === true },
        }, { attempts });
        return 'stop';
      }
      while (attempts <= stepPolicyValue.retries) {
        attempts += 1;
        if (stepPolicyValue.retryDelayMs) await sleep(stepPolicyValue.retryDelayMs);
        emit({ type: 'step-retry', ref: step.ref, attempt: attempts });
        const retried = await executeSingle(step, { countPlanned: false });
        if (retried.ok) {
          const diff = await evaluateExpectation(step, retried.result, true);
          if (diff && !diff.match && step.expectOn === 'fail') {
            error = { code: 'E_EXPECT_FAILED', message: '期望不满足：' + diff.mismatches.map((item) => item.field).join(',') };
            if (!isRetryableCode(error.code, stepPolicyValue.retryOn)) break;
            continue;
          }
          completed += 1;
          recordOk(step, { startedAt: retried.startedAt, attempts, diff: diff && diff.mismatches });
          return 'continue';
        }
        error = retried.error;
        if (!retryableFor(step, error)) break;
      }
      fail(step, { code: error.code, message: error.message, data: { ...(error.data || {}), attempts } }, { attempts });
      return 'stop';
    }
    fail(step, error, extra);
    return 'stop';
  };

  /** 把连续普通步骤合并成 plan 段执行。 */
  const flushGroup = async (flushOptions = {}) => {
    const countPlanned = flushOptions.countPlanned !== false;
    const countBudget = flushOptions.countBudget !== false;
    if (!currentGroup.length || aborted) {
      currentGroup = [];
      return;
    }
    const group = currentGroup;
    currentGroup = [];
    const startedAt = now();
    // 危险动作确认：组内任一步需要确认就先拆分，按“head → 确认步 → tail”执行。
    const needsConfirmAt = group.findIndex((step) => step.params && step.params.__recipeConfirm);
    if (needsConfirmAt >= 0) {
      const head = group.slice(0, needsConfirmAt);
      const step = group[needsConfirmAt];
      const tail = group.slice(needsConfirmAt + 1);
      currentGroup = head;
      await flushGroup();
      if (aborted) { currentGroup = []; return; }
      const confirmed = await confirmStep(step);
      if (!confirmed.ok) {
        if (confirmed.declined) {
          planned += 1;
          const action = await handleFailure(step, confirmed.error, { attempts: 1 });
          if (action !== 'continue') { currentGroup = []; return; }
        } else {
          fail(step, confirmed.error);
          currentGroup = [];
          return;
        }
      }
      if (confirmed.action === 'skip') {
        planned += 1;
        results.push({ ...stepIdentity(step, results.length), status: 'skipped', skippedReason: '人工在确认环节选择跳过', attempts: 1, durationMs: 0 });
      } else if (confirmed.ok) {
        const single = await executeSingle(step, { countPlanned: true });
        if (!single.ok) {
          const action = await handleFailure(step, single.error, { attempts: 1 });
          if (action !== 'continue') { currentGroup = []; return; }
        } else {
          const diff = await evaluateExpectation(step, single.result, true);
          if (diff && !diff.match && step.expectOn === 'fail') {
            const action = await handleFailure(step, { code: 'E_EXPECT_FAILED', message: '期望不满足：' + diff.mismatches.map((item) => item.field).join(',') }, { attempts: 1, diff: diff.mismatches });
            if (action !== 'continue') { currentGroup = []; return; }
          } else {
            completed += 1;
            recordOk(step, { startedAt: single.startedAt, attempts: 1, diff: diff && diff.mismatches });
          }
        }
      }
      currentGroup = tail;
      await flushGroup();
      return;
    }
    if (countBudget) executedSteps += group.length;
    if (countBudget && executedSteps > maxSteps) {
      aborted = true;
      failedAt = completed + 1;
      results.push({
        ref: group[0].ref, path: group[0].path, kind: 'batch', method: 'plan', status: 'failed',
        startedAt, durationMs: 0, attempts: 1,
        error: { code: 'E_TOO_LARGE', message: 'recipe 回放超过 ' + maxSteps + ' 步上限（检查 loop 次数）' },
        retryable: false,
      });
      return;
    }
    if (countPlanned) planned += group.length;
    const body = await drivers.runSteps(group.map((step) => ({ method: step.method, params: stripInternal(step.params) })));
    const stepResults = body && body.ok === true && asObject(body.result) && Array.isArray(body.result.steps) ? body.result.steps : null;
    const failedIndex = body && body.ok === true && asObject(body.result) ? body.result.failedAt : null;
    if (!body || body.ok !== true) {
      // 整段请求失败（daemon/协议层错误）：归因到第一步。
      const error = errorOf(body);
      const step = group[0];
      const action = await handleFailure(step, error, { attempts: 1 });
      if (action === 'continue') {
        currentGroup = group.slice(1);
        // 整段 planned/budget 已记账，剩余步骤不重复计数。
        await flushGroup({ countPlanned: false, countBudget: false });
      }
      return;
    }
    let failureHandled = false;
    for (let index = 0; index < group.length; index += 1) {
      const step = group[index];
      if (failedIndex !== null && failedIndex !== undefined && !failureHandled && index > failedIndex) {
        markBlocked(group, index);
        break;
      }
      if (failedIndex !== null && failedIndex !== undefined && !failureHandled && index === failedIndex) {
        const rawError = stepResults && stepResults[index] && stepResults[index].error ? stepResults[index].error : errorOf(body);
        const action = await handleFailure(step, rawError, { startedAt, attempts: 1 });
        if (action !== 'continue') {
          markBlocked(group, index + 1);
          return;
        }
        failureHandled = true;
        continue;
      }
      const rawResult = stepResults && stepResults[index] ? stepResults[index].result : null;
      const diff = await evaluateExpectation(step, rawResult, true);
      if (diff && !diff.match && step.expectOn === 'fail') {
        const action = await handleFailure(step, { code: 'E_EXPECT_FAILED', message: '期望不满足：' + diff.mismatches.map((item) => item.field).join(',') }, { startedAt, attempts: 1, diff: diff.mismatches });
        if (action !== 'continue') {
          markBlocked(group, index + 1);
          return;
        }
        failureHandled = true;
        continue;
      }
      completed += 1;
      recordOk(step, { startedAt, attempts: 1, diff: diff && diff.mismatches });
      if (diff && !diff.match && index < group.length - 1) {
        // warn 模式：差异只记录，不阻断后续步骤。
        emit({ type: 'step-mismatch', ref: step.ref, fields: diff.mismatches.map((item) => item.field) });
      }
    }
  };

  /** 执行普通动作：入段，凑满 MAX_SEGMENT 就发一段。 */
  const queueAction = async (step) => {
    currentGroup.push(step);
    if (currentGroup.length >= MAX_SEGMENT) await flushGroup();
  };

  const runCondition = async (when) => {
    if (typeof drivers.evaluate !== 'function') {
      throw new RecipeEngineError('E_INTERNAL', 'recipe 条件需要 driver.evaluate');
    }
    const expression = buildConditionExpression(when);
    const body = await drivers.evaluate(expression);
    if (!body || body.ok !== true) {
      return { ok: false, error: errorOf(body) };
    }
    const value = body.value !== undefined ? body.value : (body.result && body.result.value);
    return { ok: true, value: value === true || value === 'true' || value === 1 };
  };

  const runHumanGate = async (step) => {
    const startedAt = now();
    const timeoutMs = Math.max(5000, Math.min(Number(step.timeoutMs) || 180000, 1_800_000));
    if (typeof drivers.requestHelp !== 'function') {
      return handleFailure(step, { code: 'E_INTERNAL', message: 'human 节点需要 driver.requestHelp' }, { startedAt });
    }
    emit({ type: 'human-gate', ref: step.ref, reason: step.reason });
    const body = await drivers.requestHelp({ reason: String(step.reason || '请完成人工步骤'), timeoutMs, stepRef: step.ref });
    const action = String((body && body.result && body.result.action) || (body && body.action) || 'timeout');
    if (body && body.ok !== false && ['approve', 'approved', 'continue', 'continue-once', 'done', 'ok'].includes(action)) {
      results.push({ ...stepIdentity(step, results.length), status: 'ok', gate: true, action, startedAt, durationMs: Math.max(0, now() - startedAt), attempts: 1 });
      return 'continue';
    }
    const error = action === 'timeout'
      ? { code: 'E_TIMEOUT', message: '人工节点等待超时' }
      : { code: 'E_CANCELLED', message: action === 'skip' ? '用户在人工节点选择跳过' : '用户取消了人工节点' };
    return handleFailure(step, error, { startedAt });
  };

  const walk = async (list) => {
    for (const step of Array.isArray(list) ? list : []) {
      if (aborted) return;
      if (step.kind === 'if') {
        await flushGroup();
        if (aborted) return;
        const condition = await runCondition(step.when);
        if (!condition.ok) {
          const action = await handleFailure(step, condition.error, { attempts: 1 });
          if (action !== 'continue') return;
          continue;
        }
        const branch = condition.value ? 'then' : 'else';
        results.push({
          ref: step.ref, path: step.path, kind: 'if', method: '', status: 'ok', branch,
          conditionActual: condition.value, attempts: 1, durationMs: 0,
        });
        emit({ type: 'branch', ref: step.ref, branch });
        await walk(step[branch]);
        if (aborted) return;
        continue;
      }
      if (step.kind === 'loop') {
        await flushGroup();
        if (aborted) return;
        const times = Math.max(1, Math.min(Number(step.times) || 1, 50));
        for (let index = 0; index < times; index += 1) {
          if (aborted) return;
          results.push({
            ref: step.ref + ':i' + index, path: step.path + '.i' + index, kind: 'loop', method: '', status: 'ok',
            iteration: index + 1, attempts: 1, durationMs: 0,
          });
          await walk(step.steps);
          if (aborted) return;
          if (step.until && step.breakOn !== false) {
            const condition = await runCondition(step.until);
            if (condition.ok && condition.value) {
              emit({ type: 'loop-break', ref: step.ref, iteration: index + 1 });
              break;
            }
          }
        }
        continue;
      }
      if (step.kind === 'human') {
        await flushGroup();
        if (aborted) return;
        const action = await runHumanGate(step);
        if (action !== 'continue') return;
        continue;
      }
      // action / observe / wait：普通步骤，入段。
      await queueAction(step);
      if (aborted) return;
    }
  };

  try {
    await walk(normalized.steps);
    if (!aborted) await flushGroup();
  } catch (error) {
    // driver 抛出的非结构化异常也要变成证据，而不是裸崩。
    if (error instanceof RecipeEngineError) throw error;
    aborted = true;
    failedAt = completed + 1;
    results.push({
      ref: '', path: String(planned), kind: 'engine', method: '', status: 'failed', attempts: 1, durationMs: 0,
      error: { code: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) },
      retryable: false,
    });
  }
  currentGroup = [];
  // 预算/结构类中止不会走 handleFailure，从最后一条 failed 结果补齐 error/evidence。
  if (aborted && failure === null) {
    const lastFailed = [...results].reverse().find((item) => item && item.status === 'failed');
    if (lastFailed) {
      failure = {
        entry: lastFailed,
        error: lastFailed.error || { code: 'E_INTERNAL', message: '回放中止' },
        retryable: lastFailed.retryable === true,
        next: '回放中止：检查 recipe 结构与预算（loop 次数 / maxSteps）后重跑 --dry-run。',
      };
      failedAt = failedAt === null || failedAt === undefined ? completed + 1 : failedAt;
      failedPath = failedPath || lastFailed.path || null;
    }
  }
  // 未执行的顶层步骤标记 blocked（只给一条边界记录，避免报告膨胀）。
  if (aborted) {
    const total = flattenRecipeSteps(normalized.steps).length;
    if (planned < total) {
      results.push({
        ref: '', path: String(planned), kind: 'engine', method: '', status: 'blocked', attempts: 0, durationMs: 0,
        error: { code: 'E_CANCELLED', message: '回放中止，剩余 ' + Math.max(0, total - planned) + ' 步未执行' },
      });
    }
  }

  const endedAt = now();
  const report = buildReplayReport({
    name: options.name,
    params: normalizedParams(options.params),
    paramsFingerprint: options.paramsFingerprint || null,
    startedAt,
    endedAt,
    ok: !aborted && failure === null,
    completed,
    planned,
    failedAt,
    results,
  });
  return {
    ok: !aborted && failure === null,
    completed,
    planned,
    failedAt,
    failedPath,
    results,
    report,
    aborted,
    error: failure ? failure.error : null,
    next: failure ? failure.next : null,
    evidence: failure ? buildFailureEvidence(failure, results) : null,
  };
}
