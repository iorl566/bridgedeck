// src/record/steps.ts —— 录制 step 模型 v2 的规范化层（纯函数，无 chrome/node 依赖）。
//
// 输入是页面录制器/Agent 动作层产出的原始录制事件：
//   click/input/select/file/hover/dragstart/drop/navigate/tab-switch/window-switch/
//   state/media/text/wait。
// 输出是可回放、可审计的步骤：
//   { model, ref, kind, type, method, params, target, idempotent, fallback, risk,
//     expect?, humanGate?, branch?, waitBeforeMs?, repeat?, evidence }
//
// 关键点（与 0.3.0 JS 运行时 record-steps.js 同口径）：
// - kind 最小集：action / observe / wait / branch / human-gate；
// - ref 由 documentId + seq + kind + method + target 算稳定短哈希，回放/导出/去重共用；
// - idempotent：只读/可逆事件为 true；click/fill/select/drag/upload 为 false；
// - fallback：观察/等待类默认 retry，写入类默认 stop（绝不自动重放副作用）；
// - humanGate：需要人工补值（脱敏输入/文件上传）的位置显式标记。
//
// 运行时消费者：sources.ts 对每条录制事件调用 buildRecordStep 把 step 挂回事件。

import {
  RECORD_STEP_VERSION,
  type RecordEvent,
  type RecordEventTarget,
  type RecordStep,
  type RecordStepBranch,
  type RecordStepFallback,
  type RecordStepHumanGate,
  type RecordStepKind,
} from './types.ts';

export { RECORD_STEP_VERSION };

/** 32-bit FNV-1a：SW 里同步、确定、足够短；不用于安全场景。 */
export function stableHash(text: unknown): string {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function textOf(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** url → pathname+search（跨域完整 URL 只用于 expect 的“路径包含”断言）。 */
export function urlPath(url: unknown): string {
  try {
    const parsed = new URL(String(url ?? ''));
    return parsed.pathname + parsed.search;
  } catch {
    return '';
  }
}

/** 事件目标：selector 优先，其次可见文本/名字（与 run log 的 target 保持同形）。 */
export function recordEventTarget(event: RecordEvent | null | undefined): RecordEventTarget | null {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.selector === 'string' && event.selector) return { selector: textOf(event.selector) };
  if (typeof event.text === 'string' && event.text) return { text: textOf(event.text, 120) };
  if (typeof event.name === 'string' && event.name) return { name: textOf(event.name, 120) };
  return null;
}

/** step 骨架（不含 ref/evidence，便于单独测试）。 */
export interface RecordStepSkeleton {
  kind: RecordStepKind;
  type: string;
  method: string;
  params: Record<string, unknown>;
  target: RecordEventTarget | null;
  idempotent: boolean;
  fallback: RecordStepFallback;
  risk: string;
  expect?: Record<string, unknown> | null;
  humanGate?: RecordStepHumanGate | null;
  branch?: RecordStepBranch | null;
}

const WRITE_FALLBACK: RecordStepFallback = Object.freeze({ onError: 'stop', skipReason: '' });
const RETRY_OBSERVE: RecordStepFallback = Object.freeze({ onError: 'retry', retries: 2, retryDelayMs: 300 });
const SKIP_OBSERVE: RecordStepFallback = Object.freeze({ onError: 'skip', skipReason: '观察类步骤失败可跳过' });

const BOUNDARY_KINDS = new Set(['navigate']);
const OBSERVE_KINDS = new Set(['state', 'media', 'text']);

/** 把一条已归一化的录制事件分类成 step 骨架；未知类型降级为 observe（不丢事件）。 */
export function classifyRecordEvent(event: RecordEvent | null | undefined): RecordStepSkeleton | null {
  if (!event || typeof event !== 'object') return null;
  const kind = String(event.kind || '').trim().toLowerCase();
  const target = recordEventTarget(event);
  const base: RecordStepSkeleton = {
    kind: 'observe',
    type: 'observe',
    method: '',
    params: {},
    target,
    idempotent: true,
    fallback: SKIP_OBSERVE,
    risk: 'read_only',
    expect: null,
    humanGate: null,
    branch: null,
  };
  if (kind === 'click') {
    return {
      kind: 'action',
      type: 'action',
      method: 'click',
      params: target ? { ...target } : {},
      target,
      idempotent: false,
      fallback: { ...WRITE_FALLBACK },
      risk: 'browser_mutation',
      expect: null,
      humanGate: null,
      branch: null,
    };
  }
  if (kind === 'input') {
    const masked = String(event.value ?? '') === '********';
    const type = String(event.type || 'text').toLowerCase();
    const params: Record<string, unknown> = { ...(target ?? {}) };
    if (!masked) params.value = textOf(event.value, 200);
    const humanGate: RecordStepHumanGate | null = masked || type === 'password'
      ? { reason: '输入值被脱敏，回放前需要人工补值' + (target && target.selector ? '：' + target.selector : ''), valueKind: 'text' }
      : null;
    return {
      kind: 'action',
      type: 'action',
      method: 'fill',
      params,
      target,
      idempotent: false,
      fallback: { ...WRITE_FALLBACK },
      risk: humanGate ? 'human_gate' : 'browser_mutation',
      expect: masked || !params.value ? null : { selectorValue: params.value },
      humanGate,
      branch: null,
    };
  }
  if (kind === 'select') {
    const params: Record<string, unknown> = { ...(target ?? {}) };
    if (event.value !== undefined) params.value = textOf(String(event.value), 200);
    return {
      kind: 'action',
      type: 'action',
      method: 'select',
      params,
      target,
      idempotent: false,
      fallback: { ...WRITE_FALLBACK },
      risk: 'browser_mutation',
      expect: params.value ? { selectorValue: params.value } : null,
      humanGate: null,
      branch: null,
    };
  }
  if (kind === 'file') {
    return {
      kind: 'action',
      type: 'action',
      method: 'upload',
      params: { ...(target ?? {}) },
      target,
      idempotent: false,
      fallback: { ...WRITE_FALLBACK },
      risk: 'human_gate',
      expect: null,
      humanGate: { reason: '文件上传无法从录制还原文件路径，回放前需要人工指定文件', valueKind: 'file' },
      branch: null,
    };
  }
  if (kind === 'hover') {
    const params: Record<string, unknown> = { ...(target ?? {}) };
    if (Number.isInteger(event.dwellMs)) params.dwellMs = event.dwellMs;
    return {
      kind: 'action',
      type: 'action',
      method: 'hover',
      params,
      target,
      idempotent: true,
      fallback: { onError: 'skip', skipReason: '悬停失败可跳过' },
      risk: 'read_only',
      expect: null,
      humanGate: null,
      branch: null,
    };
  }
  if (kind === 'dragstart' || kind === 'drop') {
    const params: Record<string, unknown> = {};
    if (kind === 'dragstart') params.from = target && (target.selector || target.text) || '';
    else {
      params.to = target && (target.selector || target.text) || '';
      if (typeof event.from === 'string' && event.from) params.from = event.from;
    }
    return {
      kind: 'action',
      type: 'action',
      method: 'drag',
      params,
      target,
      idempotent: false,
      fallback: { ...WRITE_FALLBACK },
      risk: 'browser_mutation',
      expect: null,
      humanGate: null,
      branch: null,
    };
  }
  if (BOUNDARY_KINDS.has(kind)) {
    const url = String(event.url || '');
    const path = urlPath(url);
    return {
      kind: 'branch',
      type: 'branch',
      method: 'navigate',
      params: url ? { url } : {},
      target: null,
      idempotent: true,
      fallback: { onError: 'retry', retries: 1, retryDelayMs: 400 },
      risk: 'read_only',
      expect: path ? { urlIncludes: path } : null,
      humanGate: null,
      branch: { boundary: 'document', source: String(event.source || 'navigation'), url },
    };
  }
  if (kind === 'tab-switch' || kind === 'window-switch') {
    return {
      kind: 'branch',
      type: 'branch',
      method: '',
      params: {},
      target: null,
      idempotent: true,
      fallback: { ...WRITE_FALLBACK },
      risk: 'read_only',
      expect: null,
      humanGate: null,
      branch: {
        boundary: kind,
        tabId: Number.isInteger(event.toTabId) ? Number(event.toTabId) : null,
        windowId: Number.isInteger(event.toWindowId) ? Number(event.toWindowId) : null,
        source: 'tab-focus',
      },
    };
  }
  if (kind === 'wait') {
    const ms = Number(event.ms);
    return {
      kind: 'wait',
      type: 'wait',
      method: 'wait',
      params: { ms: Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), 60_000) : 0 },
      target: null,
      idempotent: true,
      fallback: { onError: 'retry', retries: 1, retryDelayMs: 400 },
      risk: 'read_only',
      expect: null,
      humanGate: null,
      branch: null,
    };
  }
  if (OBSERVE_KINDS.has(kind)) {
    if (kind === 'state') {
      return {
        ...base,
        method: 'observe',
        params: { refs: Number(event.refs) || 0 },
        fallback: { ...RETRY_OBSERVE },
      };
    }
    if (kind === 'media') {
      return {
        ...base,
        method: 'observe-media',
        params: { selector: textOf(mediaSelector(event), 160) },
        fallback: { ...SKIP_OBSERVE },
      };
    }
    return {
      ...base,
      method: 'observe-text',
      params: { changes: Array.isArray(event.changes) ? event.changes.length : 0 },
      fallback: { ...SKIP_OBSERVE },
    };
  }
  return {
    ...base,
    method: 'observe',
    params: { sourceKind: kind || 'unknown' },
    fallback: { onError: 'skip', skipReason: '未知事件类型，跳过' },
  };
}

function mediaSelector(event: RecordEvent): string {
  const media = Array.isArray(event.media) ? event.media[0] : null;
  if (media && typeof media === 'object') {
    const selector = (media as Record<string, unknown>).selector;
    if (typeof selector === 'string') return selector;
  }
  return '';
}

export interface RecordStepContext {
  seq?: number;
  index?: number;
  frameId?: number;
  documentId?: string;
  now?: number;
}

/** 稳定 ref：换文档/换帧/换目标都会变；同一事件重复投递保持一致。 */
export function recordStepRef(event: RecordEvent, step: RecordStepSkeleton, context: RecordStepContext = {}): string {
  const boundary = event.boundary && typeof event.boundary === 'object' ? event.boundary : { documentId: null };
  const documentKey = String(
    context.documentId
    || event.documentId
    || boundary.documentId
    || 'frame:' + String(context.frameId ?? event.frameId ?? 0),
  );
  const seq = Number.isInteger(context.seq)
    ? Number(context.seq)
    : (Number.isInteger(event.seq) ? event.seq : 0);
  const target = step.target ? (step.target.selector || step.target.text || step.target.name || '') : '';
  return 's' + stableHash([documentKey, seq, step.kind, step.method, target].join('|'));
}

/** 完整 step v2：骨架 + ref + 证据 + 录制模型版本。 */
export function buildRecordStep(event: RecordEvent, context: RecordStepContext = {}): RecordStep | null {
  const skeleton = classifyRecordEvent(event);
  if (!skeleton) return null;
  const ref = recordStepRef(event, skeleton, context);
  const boundary = event.boundary && typeof event.boundary === 'object' ? event.boundary : { documentId: null };
  const seq = Number.isInteger(context.seq) ? Number(context.seq) : (Number.isInteger(event.seq) ? event.seq : 0);
  const url = String(event.url || event.frameUrl || '');
  const step: RecordStep = {
    model: RECORD_STEP_VERSION,
    ref,
    kind: skeleton.kind,
    type: skeleton.type,
    method: skeleton.method,
    params: skeleton.params ?? {},
    target: skeleton.target ?? null,
    idempotent: skeleton.idempotent === true,
    fallback: skeleton.fallback ?? { onError: 'stop' },
    risk: skeleton.risk || 'read_only',
    evidence: {
      seq,
      index: Number.isInteger(context.index) ? Number(context.index) : null,
      frameId: Number.isInteger(context.frameId) ? Number(context.frameId) : (Number.isInteger(event.frameId) ? event.frameId : 0),
      documentId: String(context.documentId || event.documentId || boundary.documentId || ''),
      revision: Number.isInteger(event.revision)
        ? Number(event.revision)
        : (Number.isInteger(event.boundary?.revision) ? Number(event.boundary.revision) : null),
      actor: String(event.actor || 'human'),
      url: url.slice(0, 500),
      at: Number.isFinite(context.now) ? Number(context.now) : (Number(event.ts) || Date.now()),
    },
    sourceKind: String(event.kind || ''),
  };
  if (skeleton.expect) step.expect = skeleton.expect;
  if (skeleton.humanGate) step.humanGate = skeleton.humanGate;
  if (skeleton.branch) step.branch = skeleton.branch;
  return step;
}

/** 步骤签名：识别「同一动作连续重复」（录制侧只给 loop 建议，不猜测意图）。 */
export function stepSignature(step: RecordStep | null | undefined): string {
  if (!step || typeof step !== 'object') return '';
  const target = step.target ? (step.target.selector || step.target.text || step.target.name || '') : '';
  const value = step.method === 'fill' && step.params && step.params.value !== undefined
    ? '=' + String(step.params.value).slice(0, 80)
    : '';
  return [step.kind || '', step.method || '', target, value].join('|');
}

export interface RecordStepSummary {
  model: number;
  total: number;
  byKind: Record<string, number>;
  idempotent: number;
  nonIdempotent: number;
  humanGates: number;
  retryable: number;
  waits: number;
  repeated: number;
  refs: string[];
  methods: string[];
}

/** 一批录制 step 的摘要（record export / 草拟前的质量检查用）。 */
export function summarizeRecordSteps(steps: Array<RecordStep | null | undefined>): RecordStepSummary {
  const list = (Array.isArray(steps) ? steps : []).filter((step): step is RecordStep => Boolean(step));
  const byKind: Record<string, number> = { action: 0, observe: 0, wait: 0, branch: 0, 'human-gate': 0 };
  let idempotent = 0;
  let nonIdempotent = 0;
  let humanGates = 0;
  let retryable = 0;
  let waits = 0;
  let repeated = 0;
  const refs: string[] = [];
  const methods = new Set<string>();
  for (const step of list) {
    byKind[step.kind] = (byKind[step.kind] ?? 0) + 1;
    if (step.idempotent) idempotent += 1;
    else nonIdempotent += 1;
    if (step.humanGate) humanGates += 1;
    if (step.fallback && step.fallback.onError === 'retry') retryable += 1;
    if (Number(step.waitBeforeMs) > 0) waits += 1;
    if (Number(step.repeat) > 1) repeated += 1;
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
    refs,
    methods: [...methods],
  };
}

export interface RecordRecipeStep {
  method: string;
  params: Record<string, unknown>;
  expect?: Record<string, unknown>;
  idempotent?: boolean;
  fallback?: RecordStepFallback;
  source?: { recordRef?: string; kind?: string; at?: number };
}

/** 录制 step → recipe 原始步骤（草拟/保存用）：只保留可回放形状。 */
export function toRecipeSteps(steps: Array<RecordStep | null | undefined>): RecordRecipeStep[] {
  const list = Array.isArray(steps) ? steps : [];
  const out: RecordRecipeStep[] = [];
  for (const step of list) {
    if (!step) continue;
    if (step.kind === 'branch' && step.method === 'navigate' && step.params && typeof step.params.url === 'string' && step.params.url) {
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
