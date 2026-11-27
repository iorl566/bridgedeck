// src/record-steps.js —— 录制 step 模型 v2（页面录制事件的规范化层，纯函数）。
//
// 录制器（content/record-capture.ts 编译产物 record-capture.js）发出的是“原始事件”：
// click/input/select/file/hover/dragstart/drop/navigate/state/media/text/tab-switch。
// 这里把它规范成可回放、可审计的步骤模型：
//   { model, ref, kind, type, method, params, target, idempotent, fallback, risk,
//     expect?, humanGate?, branch?, evidence }
//
// 关键点：
//   - kind：action / observe / wait / branch / human-gate（branch 用于记录上下文边界，
//     录制无法可靠推断 if/loop 意图，所以只标记“这里换文档/换 tab 了”）；
//   - ref：由 documentId + frameId + seq + kind + 目标算出的稳定短哈希，回放/导出/去重都用它；
//   - idempotent：只读/可逆事件为 true；click/fill/select/drag/upload 为 false；
//   - fallback：观察/等待类默认 retry，写入类默认 stop（绝不自动重放副作用）；
//   - humanGate：需要输入值（fill/select/upload/password）的位置标记为人工补值点。
//
// 运行时消费者：src/record-events.js 对每条录制事件调用 buildRecordStep，把 step 挂回事件；
// src/record-ports.js 在快照里带上模型版本。都是纯 JS，不依赖 chrome/node API。

export const RECORD_STEP_VERSION = 2;
export const RECORD_STEP_KINDS = Object.freeze(['action', 'observe', 'wait', 'branch', 'human-gate']);
// 第三轮扩展字段：并发区（parallel）、取消域（cancel）、分支条件选项（branch.options）。
// 只有录制事件真的带了这些信息才会出现在 step 上；线性录制的 step 形状与 v2 完全一致。
export const RECORD_STEP_EXTENSION_VERSION = 1;
export const RECORD_STEP_EXTENSIONS = Object.freeze(['parallel', 'cancel', 'branchOptions']);

const WRITE_KINDS = new Set(['click', 'input', 'select', 'file', 'dragstart', 'drop']);
const OBSERVE_KINDS = new Set(['state', 'media', 'text']);
const BOUNDARY_KINDS = new Set(['navigate']);

/** 32-bit FNV-1a：SW 里同步、确定、足够短；不用于安全场景。 */
export function stableHash(text) {
  let hash = 0x811c9dc5;
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function textOf(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function urlPath(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.pathname + parsed.search;
  } catch {
    return '';
  }
}

/** 事件目标：selector 优先，其次可见文本/名字（与 run log 的 target 保持同形）。 */
export function recordEventTarget(event) {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.selector === 'string' && event.selector) return { selector: textOf(event.selector) };
  if (typeof event.text === 'string' && event.text) return { text: textOf(event.text, 120) };
  if (typeof event.name === 'string' && event.name) return { name: textOf(event.name, 120) };
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 并发区字段规整：只保留可回放的声明（groupId/role/arm/waitFor/label/failFast）。
 * 录制事件没有 parallel 时返回 null —— 默认行为（完全串行）不变。
 * @param {object|null|undefined} parallel
 * @returns {null|{groupId:string, role:string|null, arm:number, waitFor:string, label:string, failFast:boolean}}
 */
export function normalizeStepParallel(parallel) {
  if (parallel == null || parallel === false) return null;
  const input = parallel === true ? {} : (isPlainObject(parallel) ? parallel : null);
  if (!input) return null;
  const groupId = String(input.groupId || input.group || input.id || '').slice(0, 48);
  if (!groupId) return null;
  const roleInput = String(input.role || '').toLowerCase();
  const role = ['fork', 'arm', 'join'].includes(roleInput) ? roleInput : null;
  const waitForInput = String(input.waitFor || input.mode || '').toLowerCase();
  const waitFor = ['all', 'any', 'race'].includes(waitForInput) ? waitForInput : 'all';
  return {
    groupId,
    role,
    arm: Number.isSafeInteger(Number(input.arm != null ? input.arm : input.armIndex)) ? Math.max(0, Number(input.arm != null ? input.arm : input.armIndex)) : 0,
    waitFor,
    label: textOf(input.label, 64),
    failFast: input.failFast === true,
  };
}

/**
 * 取消域字段规整：只保留声明（scope/onCancel/afterMs/reason/close/token）。
 * 录制事件没有 cancel 时返回 null —— 默认行为（没有取消域）不变。
 * @param {object|null|undefined} cancel
 */
export function normalizeStepCancel(cancel) {
  if (cancel == null || cancel === false) return null;
  const input = cancel === true ? {} : (isPlainObject(cancel) ? cancel : null);
  if (!input) return null;
  const scope = String(input.scope || input.id || input.name || '').slice(0, 48);
  if (!scope) return null;
  const modeInput = String(input.onCancel || input.mode || '').toLowerCase();
  const onCancel = ['abort', 'skip', 'continue'].includes(modeInput) ? modeInput : 'abort';
  return {
    scope,
    onCancel,
    afterMs: Number.isFinite(Number(input.afterMs)) && Number(input.afterMs) > 0 ? Math.round(Number(input.afterMs)) : 0,
    reason: textOf(input.reason, 120),
    close: input.close === true || input.end === true,
    token: textOf(input.token, 64),
  };
}

/**
 * 分支条件选项规整：录制器可以在边界事件里带 options（条件 + 目标）。
 * 旧事件没有 options 时返回空数组（branch 形状不变）。
 * @param {Array|null|undefined} options
 */
export function normalizeStepBranchOptions(options) {
  const list = Array.isArray(options) ? options : [];
  const out = [];
  for (const item of list.slice(0, 16)) {
    if (!isPlainObject(item)) continue;
    const when = isPlainObject(item.when) ? item.when : (isPlainObject(item.expect) ? item.expect : null);
    const normalizedWhen = when ? {
      ...(typeof when.urlIncludes === 'string' ? { urlIncludes: textOf(when.urlIncludes, 300) } : {}),
      ...(typeof when.selector === 'string' ? { selector: textOf(when.selector, 200) } : {}),
      ...(typeof when.selectorValue === 'string' ? { selectorValue: textOf(when.selectorValue, 200) } : {}),
      ...(typeof when.textIncludes === 'string' ? { textIncludes: textOf(when.textIncludes, 200) } : {}),
    } : null;
    out.push({
      label: textOf(item.label || item.name || 'option-' + (out.length + 1), 64),
      ...(normalizedWhen ? { when: normalizedWhen } : {}),
      ...(Number.isSafeInteger(item.to) ? { to: item.to } : (typeof item.to === 'string' && item.to ? { to: textOf(item.to, 64) } : {})),
    });
  }
  return out;
}

/**
 * 把并发/取消/分支选项挂到 step 上（只加字段；没有声明就什么都不加）。
 * @param {object} step
 * @param {object} event
 */
export function attachStepExtensions(step, event) {
  if (!step || typeof step !== 'object' || !event || typeof event !== 'object') return step;
  const parallel = normalizeStepParallel(event.parallel || (event.stepExtensions && event.stepExtensions.parallel));
  if (parallel) step.parallel = parallel;
  const cancel = normalizeStepCancel(event.cancel || (event.stepExtensions && event.stepExtensions.cancel));
  if (cancel) step.cancel = cancel;
  const options = normalizeStepBranchOptions(event.branchOptions || (isPlainObject(event.branch) ? event.branch.options : null));
  if (options.length) {
    step.branch = { ...(step.branch || {}), options };
    step.branchOptions = options.length;
  }
  return step;
}

/**
 * 事件 → 步骤骨架（不含 ref/evidence，便于单独测试）。
 * @returns {null|{kind:string, type:string, method:string, params:object, target:object|null,
 *   idempotent:boolean, fallback:object, risk:string, expect:object|null,
 *   humanGate:object|null, branch:object|null}}
 */
export function classifyRecordEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const kind = String(event.kind || '').trim().toLowerCase();
  const target = recordEventTarget(event);
  const base = { kind: 'observe', type: 'observe', method: '', params: {}, target, idempotent: true, risk: 'read_only' };
  if (kind === 'click') {
    return {
      kind: 'action', type: 'action', method: 'click',
      params: target ? { ...target } : {},
      target, idempotent: false,
      fallback: { onError: 'stop', skipReason: '' },
      risk: 'browser_mutation', expect: null, humanGate: null, branch: null,
    };
  }
  if (kind === 'input') {
    const masked = String(event.value || '') === '********';
    const type = String(event.type || 'text').toLowerCase();
    const params = { ...(target || {}) };
    if (!masked) params.value = textOf(event.value, 200);
    const humanGate = masked || type === 'password'
      ? { reason: '输入值被脱敏，回放前需要人工补值' + (target && target.selector ? '：' + target.selector : ''), valueKind: 'text' }
      : null;
    return {
      kind: 'action', type: 'action', method: 'fill',
      params,
      target, idempotent: false,
      fallback: { onError: 'stop', skipReason: '' },
      risk: humanGate ? 'human_gate' : 'browser_mutation',
      expect: masked || !params.value ? null : { selectorValue: params.value },
      humanGate, branch: null,
    };
  }
  if (kind === 'select') {
    const params = { ...(target || {}) };
    if (event.value !== undefined) params.value = textOf(String(event.value), 200);
    return {
      kind: 'action', type: 'action', method: 'select', params, target, idempotent: false,
      fallback: { onError: 'stop', skipReason: '' }, risk: 'browser_mutation',
      expect: params.value ? { selectorValue: params.value } : null, humanGate: null, branch: null,
    };
  }
  if (kind === 'file') {
    return {
      kind: 'action', type: 'action', method: 'upload',
      params: { ...(target || {}) },
      target, idempotent: false,
      fallback: { onError: 'stop', skipReason: '' },
      risk: 'human_gate',
      expect: null,
      humanGate: { reason: '文件上传无法从录制还原文件路径，回放前需要人工指定文件', valueKind: 'file' },
      branch: null,
    };
  }
  if (kind === 'hover') {
    return {
      kind: 'action', type: 'action', method: 'hover', params: { ...(target || {}) }, target,
      idempotent: true, fallback: { onError: 'skip', skipReason: '悬停失败可跳过' }, risk: 'read_only',
      expect: null, humanGate: null, branch: null,
      ...(Number.isInteger(event.dwellMs) ? { params: { ...(target || {}), dwellMs: event.dwellMs } } : {}),
    };
  }
  if (kind === 'dragstart' || kind === 'drop') {
    const params = {};
    if (kind === 'dragstart') params.from = target && (target.selector || target.text) || '';
    else {
      params.to = target && (target.selector || target.text) || '';
      if (typeof event.from === 'string' && event.from) params.from = event.from;
    }
    return {
      kind: 'action', type: 'action', method: 'drag', params, target, idempotent: false,
      fallback: { onError: 'stop', skipReason: '' }, risk: 'browser_mutation',
      expect: null, humanGate: null, branch: null,
    };
  }
  if (BOUNDARY_KINDS.has(kind)) {
    const url = String(event.url || '');
    const path = urlPath(url);
    return {
      kind: 'branch', type: 'branch', method: 'navigate',
      params: url ? { url } : {},
      target: null, idempotent: true,
      fallback: { onError: 'retry', retries: 1, retryDelayMs: 400 },
      risk: 'read_only',
      expect: path ? { urlIncludes: path } : null,
      humanGate: null,
      branch: { boundary: 'document', source: String(event.source || 'navigation'), url },
    };
  }
  if (OBSERVE_KINDS.has(kind)) {
    if (kind === 'state') {
      return {
        ...base, method: 'observe', params: { refs: Number(event.refs) || 0 },
        idempotent: true, fallback: { onError: 'retry', retries: 2, retryDelayMs: 300 }, risk: 'read_only',
        expect: null, humanGate: null, branch: null,
      };
    }
    if (kind === 'media') {
      return {
        ...base, method: 'observe-media', params: { selector: textOf(event.media && event.media.selector, 160) },
        idempotent: true, fallback: { onError: 'skip', skipReason: '媒体状态观察失败可跳过' }, risk: 'read_only',
        expect: null, humanGate: null, branch: null,
      };
    }
    return {
      ...base, method: 'observe-text', params: { changes: Array.isArray(event.changes) ? event.changes.length : 0 },
      idempotent: true, fallback: { onError: 'skip', skipReason: '文本变化观察失败可跳过' }, risk: 'read_only',
      expect: null, humanGate: null, branch: null,
    };
  }
  if (kind === 'tab-switch' || kind === 'window-switch') {
    return {
      kind: 'branch', type: 'branch', method: '',
      params: {},
      target: null, idempotent: true,
      fallback: { onError: 'stop', skipReason: '' },
      risk: 'read_only',
      expect: null, humanGate: null,
      branch: {
        boundary: kind,
        tabId: Number.isInteger(event.tabId) ? event.tabId : null,
        windowId: Number.isInteger(event.windowId) ? event.windowId : null,
      },
    };
  }
  return {
    ...base, method: 'observe', params: { sourceKind: kind || 'unknown' },
    fallback: { onError: 'skip', skipReason: '未知事件类型，跳过' },
    expect: null, humanGate: null, branch: null,
  };
}

/** 稳定 ref：换文档/换帧/换目标都会变；同一事件重复投递保持一致。 */
export function recordStepRef(event, step, context = {}) {
  const boundary = event && event.boundary && typeof event.boundary === 'object' ? event.boundary : {};
  const documentKey = String(
    context.documentId
    || (event && event.documentId)
    || boundary.documentId
    || 'frame:' + String(context.frameId ?? (event && event.frameId) ?? 0),
  );
  const seq = Number.isInteger(context.seq)
    ? context.seq
    : (Number.isInteger(event && event.seq) ? event.seq : 0);
  const target = step && step.target ? (step.target.selector || step.target.text || step.target.name || '') : '';
  return 's' + stableHash([documentKey, seq, step && step.kind, step && step.method, target].join('|'));
}

/**
 * 完整 step v2：骨架 + ref + 证据 + 录制模型版本。
 * @param {object} event 已归一化的录制事件（含 boundary/frameId/documentId/actor/url）
 * @param {{seq?:number, index?:number, frameId?:number, documentId?:string, now?:number}} context
 */
export function buildRecordStep(event, context = {}) {
  const skeleton = classifyRecordEvent(event);
  if (!skeleton) return null;
  const ref = recordStepRef(event, skeleton, context);
  const boundary = event.boundary && typeof event.boundary === 'object' ? event.boundary : {};
  const url = String(event.url || event.frameUrl || '');
  const step = {
    model: RECORD_STEP_VERSION,
    ref,
    kind: skeleton.kind,
    type: skeleton.type,
    method: skeleton.method,
    params: skeleton.params || {},
    target: skeleton.target || null,
    idempotent: skeleton.idempotent === true,
    fallback: skeleton.fallback || { onError: 'stop' },
    risk: skeleton.risk || 'read_only',
    evidence: {
      seq: Number.isInteger(context.seq) ? context.seq : (Number.isInteger(event.seq) ? event.seq : 0),
      index: Number.isInteger(context.index) ? context.index : null,
      frameId: Number.isInteger(context.frameId) ? context.frameId : (Number.isInteger(event.frameId) ? event.frameId : 0),
      documentId: String(context.documentId || event.documentId || boundary.documentId || ''),
      revision: Number.isInteger(event.revision) ? event.revision : null,
      actor: String(event.actor || 'human'),
      url: url.slice(0, 500),
      at: Number.isFinite(context.now) ? Number(context.now) : (Number(event.ts) || Date.now()),
    },
    sourceKind: String(event.kind || ''),
  };
  if (skeleton.expect) step.expect = skeleton.expect;
  if (skeleton.humanGate) step.humanGate = skeleton.humanGate;
  if (skeleton.branch) step.branch = skeleton.branch;
  // 第三轮扩展：并发区/取消域/分支条件选项（没有声明就完全不出现，step v2 形状不变）。
  attachStepExtensions(step, event);
  return step;
}

/** 步骤签名：用于识别「同一动作连续重复」（录制侧只能给 loop 建议，不猜测意图）。 */
export function stepSignature(step) {
  if (!step || typeof step !== 'object') return '';
  const target = step.target ? (step.target.selector || step.target.text || step.target.name || '') : '';
  const value = step.method === 'fill' && step.params && step.params.value !== undefined
    ? '=' + String(step.params.value).slice(0, 80)
    : '';
  return [step.kind || '', step.method || '', target, value].join('|');
}

/**
 * 一批录制 step 的摘要（record export / 草拟前的质量检查用）。
 */
export function summarizeRecordSteps(steps) {
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const byKind = { action: 0, observe: 0, wait: 0, branch: 0, 'human-gate': 0 };
  let idempotent = 0;
  let nonIdempotent = 0;
  let humanGates = 0;
  let retryable = 0;
  let waits = 0;
  let repeated = 0;
  const refs = [];
  const methods = new Set();
  const parallelGroups = new Set();
  const cancelScopes = new Set();
  let branchOptions = 0;
  for (const step of list) {
    if (byKind[step.kind] === undefined) byKind[step.kind] = 0;
    byKind[step.kind] += 1;
    if (step.idempotent) idempotent += 1;
    else nonIdempotent += 1;
    if (step.humanGate) humanGates += 1;
    if (step.fallback && step.fallback.onError === 'retry') retryable += 1;
    if (Number(step.waitBeforeMs) > 0) waits += 1;
    if (Number(step.repeat) > 1) repeated += 1;
    if (step.parallel && step.parallel.groupId) parallelGroups.add(step.parallel.groupId);
    if (step.cancel && step.cancel.scope) cancelScopes.add(step.cancel.scope);
    if (Array.isArray(step.branch && step.branch.options)) branchOptions += step.branch.options.length;
    if (step.ref) refs.push(step.ref);
    if (step.method) methods.add(step.method);
  }
  return {
    model: RECORD_STEP_VERSION,
    total: list.length,
    byKind,
    idempotent,
    nonIdempotent,
    humanGates,
    retryable,
    waits,
    repeated,
    parallelGroups: parallelGroups.size,
    cancelScopes: cancelScopes.size,
    branchOptions,
    refs,
    methods: [...methods],
  };
}

/**
 * 录制 step → recipe 原始步骤（草拟/保存用）。
 * 只保留可回放形状；humanGate 不自动插入 human 节点（避免改变既有回放契约）。
 */
export function toRecipeSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const out = [];
  for (const step of list) {
    if (!step) continue;
    if (step.kind === 'branch' && step.method === 'navigate' && step.params && step.params.url) {
      out.push({
        method: 'navigate',
        params: { url: step.params.url },
        ...(step.expect ? { expect: step.expect } : {}),
        ...(step.fallback ? { fallback: step.fallback } : {}),
        source: { recordRef: step.ref, kind: step.kind, at: step.evidence && step.evidence.at },
      });
      continue;
    }
    if (step.kind !== 'action') continue;
    if (!step.method) continue;
    const params = { ...(step.params || {}) };
    out.push({
      method: step.method,
      params,
      ...(step.expect ? { expect: step.expect } : {}),
      ...(step.idempotent ? { idempotent: true } : {}),
      ...(step.fallback ? { fallback: step.fallback } : {}),
      source: { recordRef: step.ref, at: step.evidence && step.evidence.at },
    });
  }
  return out;
}
