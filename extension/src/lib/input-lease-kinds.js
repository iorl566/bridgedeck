// src/lib/input-lease-kinds.js —— passthrough 租约的类别/错误码/规整与证据工具（纯函数）。
//
// 从 cooperate.js 拆出的“叶子”部分：租约类别、抑制作用域映射、结构化错误码、
// 参数规整、四项 revision 只读向量、证据摘要函数。拆出原因有两个：
//   1. extension/src 有单文件 ≤1100 行的复杂度预算（architecture-guards.test.mjs），
//      cooperate.js 的调度器与这些无状态工具混在一起会超预算；
//   2. 这些函数没有闭包依赖（时钟/单例都由调用方传入），单独放便于复用与单测。
//
// 约定：
//   - 不 import 任何会碰 chrome/DOM 的模块，保持纯函数；
//   - revisionVector 只读 control-generation（revision-chain 单源），不写计数。

import { SUPPRESSION_KINDS } from './suppression-scope.js';
import { controlGeneration, controlGenerationRecord } from '../control-generation.js';

export const LEASE_KINDS = Object.freeze({
  ACTION: 'action',
  NATIVE_INPUT: 'native-input',
  CAPTURE: 'capture',
  RECORD_SHOT: 'record-shot',
  MANUAL: 'manual',
});

export const LEASE_KIND_LIST = Object.freeze(Object.values(LEASE_KINDS));

/** 业务 kind → capture-suppression 的抑制作用域类别；无映射表示本次租约不抑制。 */
export const SUPPRESSION_KIND_FOR = Object.freeze({
  [LEASE_KINDS.NATIVE_INPUT]: SUPPRESSION_KINDS.NATIVE_INPUT,
  [LEASE_KINDS.CAPTURE]: SUPPRESSION_KINDS.CAPTURE,
  [LEASE_KINDS.RECORD_SHOT]: SUPPRESSION_KINDS.RECORD_SHOT,
  [LEASE_KINDS.MANUAL]: SUPPRESSION_KINDS.MANUAL,
});

export const LEASE_ERROR = Object.freeze({
  BAD_ARG: 'E_BAD_ARG',
  BAD_KIND: 'E_BAD_ARG',
  DEPTH: 'E_CAPTURE_LIMIT',
  TOKEN: 'E_INTERNAL',
  HUMAN_ACTIVE: 'E_HUMAN_GATE',
  HUMAN_CONFLICT: 'E_HUMAN_GATE',
  UNKNOWN: 'E_NOT_FOUND',
  REQUIRED: 'E_INPUT_BUSY',
  ACTIVE: 'E_INPUT_BUSY',
  HANDOFF: 'E_SESSION_STATE',
});

export const DEFAULT_TTL_MS = 30000;
export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_TABS = 256;
export const DEFAULT_HUMAN_ACTIVE_MS = 2000;
export const DEFAULT_HISTORY_LIMIT = 32;
export const MASK_KEEP = 6;

export function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function integer(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

export function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function clip(text, limit) {
  return String(text == null ? '' : text).slice(0, limit);
}

export function maskToken(token) {
  const text = String(token == null ? '' : token);
  return text.length <= MASK_KEEP * 2 ? text : text.slice(0, MASK_KEEP) + '…' + text.slice(-MASK_KEEP);
}

export function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

/** tabId 规整：null/''/非整数都视为没有 tab（Number(null)===0 会把“没传”误判成 tab 0）。 */
export function normalizeCooperationTabId(tabId) {
  if (tabId == null || tabId === '') return null;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : null;
}

export function normalizeLeaseKind(kind) {
  const value = String(kind == null ? '' : kind);
  return LEASE_KIND_LIST.includes(value) ? value : null;
}

/** 规整一次 acquire 参数：非法 kind/ttl/expectation 返回结构化失败。 */
export function normalizeLeaseOptions(options = {}) {
  if (options != null && typeof options !== 'object') {
    return fail(LEASE_ERROR.BAD_ARG, 'acquire 选项必须是对象');
  }
  const kind = normalizeLeaseKind(options.kind == null ? LEASE_KINDS.ACTION : options.kind);
  if (!kind) return fail(LEASE_ERROR.BAD_KIND, '未知租约类别：' + String(options.kind), { kind: String(options.kind) });
  return {
    ok: true,
    options: {
      kind,
      method: clip(options.method || options.action || '', 64),
      owner: clip(options.owner || 'cooperate', 48),
      expectation: options.expectation && typeof options.expectation === 'object' ? options.expectation : null,
      ttlMs: positive(options.ttlMs, DEFAULT_TTL_MS),
      maxDepth: Math.max(1, Math.floor(positive(options.maxDepth, DEFAULT_MAX_DEPTH))),
      suppress: options.suppress !== false,
      respectHuman: options.respectHuman !== false,
      force: options.force === true,
      reason: clip(options.reason || '', 120),
    },
  };
}

/** 四项 revision + generation 的只读向量（不触发持久化写）。 */
export function revisionVector(tabId) {
  const record = controlGenerationRecord(tabId) || {};
  return {
    controlRevision: num(record.controlRevision),
    authorityRevision: num(record.authorityRevision),
    revision: num(record.revision),
    frameEpoch: num(record.frameEpoch),
    epoch: num(record.epoch),
    generation: record.generation != null ? num(record.generation) : controlGeneration(tabId),
  };
}

import { transitionBumps } from './controller-state.js';

/** 把 controller 迁移声明的 bumps 落到 revision-chain（control-generation 唯一写入口）。 */
export function applyControllerBumps(tabId, bumpFn, moved) {
  const delta = transitionBumps(moved);
  return Object.keys(delta).length ? bumpFn(tabId, delta) : null;
}

/** 新型 tab 记录：租约栈 + handback 状态 + revision 历史的空骨架。 */
export function emptyTab(tabId, now) {
  return {
    tabId,
    createdAt: now,
    updatedAt: now,
    leases: new Map(),
    depth: 0,
    minted: 0,
    consumed: 0,
    revoked: 0,
    conflicts: 0,
    lastHumanAt: 0,
    lastHumanKind: null,
    lastAction: null,
    lastActionAt: 0,
    actionCount: 0,
    handoff: {
      state: 'idle',
      since: now,
      event: null,
      reason: null,
      history: [],
      pendingSince: 0,
      completedAt: 0,
      sealed: null,
    },
    revisionHistory: [],
    revisionAtOpen: null,
  };
}

/** 有界数组追加：历史/证据链只保留最近 limit 条。 */
export function pushBounded(list, entry, limit) {
  list.push(entry);
  if (list.length > limit) list.splice(0, list.length - limit);
}

/** FNV-1a 32 位摘要：用于把 handback/借用证据封成可复算的 fingerprint（非加密用途）。 */
export function evidenceDigest(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value == null ? null : value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ('0000000' + hash.toString(16)).slice(-8);
}

/** 一条租约对外摘要（token 打码，避免租约凭据进日志）。 */
export function summarizeLease(lease) {
  if (!lease) return null;
  return {
    leaseId: lease.leaseId,
    tabId: lease.tabId,
    kind: lease.kind,
    method: lease.method,
    owner: lease.owner,
    grantee: lease.grantee,
    token: lease.tokenMasked,
    depth: lease.depth,
    startedAt: lease.startedAt,
    expiresAt: lease.expiresAt,
    ttlMs: lease.ttlMs,
    released: lease.released === true,
    outcome: lease.outcome || null,
    suppressionScopeId: lease.suppressionScopeId || null,
    suppressionKind: lease.suppressionKind || null,
    active: lease.released !== true,
  };
}

/** 一行摘要：CLI/诊断默认文本输出用。 */
export function describeCooperationState(state) {
  if (!state || typeof state !== 'object') return 'cooperate: 无状态';
  const parts = ['leases=' + num(state.depth)];
  if (state.handoff && state.handoff.state) parts.push('handoff=' + state.handoff.state);
  if (state.human && state.human.state) parts.push('human=' + state.human.state);
  if (state.suppression && state.suppression.active) parts.push('suppressed');
  const revisions = state.revisions || {};
  parts.push('ctrl=' + num(revisions.controlRevision) + '/auth=' + num(revisions.authorityRevision) + '/rev=' + num(revisions.revision) + '/frame=' + num(revisions.frameEpoch));
  return parts.join(' ');
}
