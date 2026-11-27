// src/lib/human-borrow-ledger.js —— 借用旅程的状态/事件/哈希链（纯数据与纯函数）。
//
// 从 borrow.js 拆出的“叶子”部分：旅程状态、事件、迁移表、异常/错误码、哈希链工具。
// 拆出原因：
//   1. extension/src 单文件 ≤1100 行（architecture-guards.test.mjs），账本实现 + 对账逻辑
//      放在同一文件会超预算；
//   2. 这些是“证据格式契约”，CLI/诊断/单测只依赖它们，不应被实现细节牵动。
//
// 哈希链：entry.digest = FNV-1a(prevDigest + {seq,kind,at,data})，用于事后发现证据被改动，
// 不是密码学签名。链为空时 digest 由 extra 计算，保证“空链封存也能校验”。

import { evidenceDigest } from './input-lease-kinds.js';

/** 封存证书的“第二轮”标记：version 仍是 1（契约不变），chainVersion 标明来源摘要已启用。 */
export const CHAIN_SEAL_VERSION = 2;

export const JOURNEY_STATES = Object.freeze({
  REQUESTED: 'requested',
  PRESENTED: 'presented',
  ALLOWED: 'allowed',
  DENIED: 'denied',
  TIMEOUT: 'timeout',
  CONFIRMED: 'confirmed',
  ACTIVE: 'active',
  RETURNING: 'returning',
  RETURNED: 'returned',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  CLOSED: 'closed',
});

export const JOURNEY_STATE_LIST = Object.freeze(Object.values(JOURNEY_STATES));

export const JOURNEY_EVENTS = Object.freeze({
  REQUEST: 'request',
  PRESENTED: 'presented',
  DECISION_ALLOW: 'decision.allow',
  DECISION_DENY: 'decision.deny',
  DECISION_TIMEOUT: 'decision.timeout',
  CONFIRM: 'confirm',
  ACTIVATE: 'activate',
  RETURN_BEGIN: 'return.begin',
  RETURN_COMPLETE: 'return.complete',
  CANCEL: 'cancel',
  EXPIRE: 'expire',
  CLEAR: 'clear',
  CHECK_BLOCKED: 'check.blocked',
  ANOMALY: 'anomaly',
});

export const JOURNEY_ANOMALIES = Object.freeze({
  PENDING_EXPIRED: 'JOURNEY_PENDING_EXPIRED',
  GATE_MISSING: 'JOURNEY_GATE_MISSING',
  GATE_CONTROLLER_MISMATCH: 'JOURNEY_GATE_CONTROLLER_MISMATCH',
  CONTROLLER_AFTER_RETURN: 'JOURNEY_CONTROLLER_AFTER_RETURN',
  LEASE_AFTER_RETURN: 'JOURNEY_LEASE_AFTER_RETURN',
  OVERLAY_AFTER_DECISION: 'JOURNEY_OVERLAY_AFTER_DECISION',
  SURFACE_MISSING: 'JOURNEY_SURFACE_MISSING',
  EVIDENCE_TAMPERED: 'JOURNEY_EVIDENCE_TAMPERED',
});

export const JOURNEY_ERRORS = Object.freeze({
  BAD_ARG: 'E_BAD_ARG',
  TRANSITION: 'E_SESSION_STATE',
  NOT_FOUND: 'E_NOT_FOUND',
  LEASE_ACTIVE: 'E_INPUT_BUSY',
  NO_GATE: 'E_INTERNAL',
});

/** 状态迁移表：event + from[] → to。没有命中就是非法迁移（拒绝并留证据）。 */
export const JOURNEY_TRANSITIONS = Object.freeze([
  { event: 'request', from: [null, 'closed', 'returned', 'cancelled', 'expired', 'denied', 'timeout'], to: 'requested' },
  { event: 'presented', from: ['requested'], to: 'presented' },
  { event: 'decision.allow', from: ['requested', 'presented'], to: 'allowed' },
  { event: 'decision.deny', from: ['requested', 'presented'], to: 'denied' },
  { event: 'decision.timeout', from: ['requested', 'presented'], to: 'timeout' },
  { event: 'confirm', from: ['allowed', 'requested', 'presented'], to: 'confirmed' },
  { event: 'activate', from: ['confirmed', 'allowed'], to: 'active' },
  { event: 'return.begin', from: ['active', 'confirmed'], to: 'returning' },
  { event: 'return.complete', from: ['returning', 'active', 'confirmed'], to: 'returned' },
  { event: 'cancel', from: ['requested', 'presented', 'allowed'], to: 'cancelled' },
  { event: 'expire', from: ['requested', 'presented'], to: 'expired' },
  { event: 'clear', from: ['requested', 'presented', 'allowed', 'denied', 'timeout', 'confirmed', 'active', 'returning', 'returned', 'cancelled', 'expired'], to: 'closed' },
]);

const TRANSITION_INDEX = new Map();
for (const rule of JOURNEY_TRANSITIONS) {
  for (const from of rule.from) {
    const key = String(from) + '|' + rule.event;
    if (TRANSITION_INDEX.has(key)) throw new Error('borrow journey 迁移表重复：' + key);
    TRANSITION_INDEX.set(key, rule);
  }
}

/** 按 (state, event) 查迁移目标；非法返回 null。 */
export function journeyTransitionFor(state, event) {
  const rule = TRANSITION_INDEX.get(String(state) + '|' + String(event)) || null;
  return rule ? rule.to : null;
}

/** 某个状态允许的事件列表（拒绝证据里用）。 */
export function journeyAllowedEvents(state) {
  return JOURNEY_TRANSITIONS.filter((rule) => rule.from.includes(state == null ? null : state)).map((rule) => rule.event);
}

/**
 * 生成一条链式证据：prevDigest + payload → digest。
 * @param {{digest?:string}|null} previous
 * @param {{seq:number,kind:string,at:number,data?:object}} payload
 */
export function chainEntry(previous, payload) {
  const prevDigest = previous && previous.digest ? previous.digest : 'genesis';
  const body = {
    seq: payload.seq,
    kind: payload.kind,
    at: payload.at,
    data: payload.data || null,
  };
  return {
    ...body,
    prevDigest,
    digest: evidenceDigest({ prevDigest, body }),
  };
}

/** 把证据数组封成可校验证书（含条数/首末时间/总摘要）。 */
export function sealChain(entries, extra = {}) {
  const list = (Array.isArray(entries) ? entries : []).map((entry) => ({ ...entry }));
  const digest = list.length ? list[list.length - 1].digest : evidenceDigest({ empty: true, extra });
  // 第二轮：封存时附带来源摘要（事件种类/offered surface/决策序列），只加字段不改既有 digest 语义；
  // verifyChain 会在字段存在时一起复算，用于发现“条目没改但摘要被替换”的伪造。
  const sourceSummary = summarizeChainSources(list);
  return {
    version: 1,
    chainVersion: CHAIN_SEAL_VERSION,
    sealed: true,
    count: list.length,
    firstAt: list.length ? list[0].at : 0,
    lastAt: list.length ? list[list.length - 1].at : 0,
    digest,
    sourceDigest: sourceSummary.sourceDigest,
    kinds: sourceSummary.kinds,
    sources: { decisions: sourceSummary.decisions, surfaces: sourceSummary.surfaces },
    entries: list,
    extra: extra || null,
  };
}

/**
 * 链条目来源摘要：把 entries 里的事件种类/决策/surface 聚合成可复算摘要。
 * @param {Array} entriesInput
 * @returns {{entries:number, kinds:object, firstAt:number, lastAt:number, decisions:Array,
 *            surfaces:Array, sourceDigest:string}}
 */
export function summarizeChainSources(entriesInput) {
  const entries = (Array.isArray(entriesInput) ? entriesInput : []).filter((entry) => entry && typeof entry === 'object');
  const kinds = {};
  const decisions = new Set();
  const surfaces = new Set();
  let firstAt = 0;
  let lastAt = 0;
  for (const entry of entries) {
    kinds[entry.kind || 'unknown'] = (kinds[entry.kind || 'unknown'] || 0) + 1;
    const data = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data) ? entry.data : {};
    if (typeof data.decision === 'string' && data.decision) decisions.add(data.decision);
    if (typeof data.surface === 'string' && data.surface) surfaces.add(data.surface);
    const at = Number(entry.at) || 0;
    if (at > 0) {
      if (firstAt === 0 || at < firstAt) firstAt = at;
      if (at > lastAt) lastAt = at;
    }
  }
  const body = {
    entries: entries.length,
    kinds,
    decisions: [...decisions].sort(),
    surfaces: [...surfaces].sort(),
    firstAt,
    lastAt,
  };
  return { ...body, sourceDigest: evidenceDigest(body) };
}

/** 一行来源摘要：CLI 默认输出用。 */
export function describeChainSources(summary) {
  if (!summary || typeof summary !== 'object') return 'chain-sources: 无摘要';
  const kinds = summary.kinds && typeof summary.kinds === 'object' ? summary.kinds : {};
  const parts = ['entries=' + (Number(summary.entries) || 0)];
  const kindList = Object.keys(kinds).filter((key) => kinds[key] > 0).slice(0, 4);
  if (kindList.length) parts.push(kindList.map((key) => key + ':' + kinds[key]).join(','));
  if (Array.isArray(summary.decisions) && summary.decisions.length) parts.push('decisions=' + summary.decisions.join('/'));
  if (summary.sourceDigest) parts.push('sourceDigest=' + summary.sourceDigest);
  return parts.join(' ');
}

/** 校验封存证据：逐条重算 prevDigest/digest，任何一条被改都能定位。 */
export function verifyChain(sealed) {
  if (!sealed || !Array.isArray(sealed.entries)) {
    return { ok: false, code: JOURNEY_ANOMALIES.EVIDENCE_TAMPERED, error: '证据缺失或结构不对', at: null };
  }
  let previous = null;
  for (let index = 0; index < sealed.entries.length; index += 1) {
    const entry = sealed.entries[index];
    const recomputed = chainEntry(previous, entry);
    if (recomputed.digest !== entry.digest) {
      return {
        ok: false,
        code: JOURNEY_ANOMALIES.EVIDENCE_TAMPERED,
        error: '证据链第 ' + index + ' 条被改动',
        at: entry.at,
        index,
        expected: entry.digest,
        actual: recomputed.digest,
      };
    }
    previous = entry;
  }
  const digest = previous ? previous.digest : evidenceDigest({ empty: true, extra: sealed.extra || null });
  // 第二轮：sourceDigest 存在时一起复算（空链/旧证书没有该字段时行为与之前完全一致）。
  let sourcesOk = true;
  if (sealed.sourceDigest !== undefined) {
    sourcesOk = summarizeChainSources(sealed.entries).sourceDigest === sealed.sourceDigest;
    if (!sourcesOk) {
      return {
        ok: false,
        code: JOURNEY_ANOMALIES.EVIDENCE_TAMPERED,
        error: '证据链来源摘要被改动',
        at: sealed.lastAt || null,
        index: null,
        expected: sealed.sourceDigest,
        actual: summarizeChainSources(sealed.entries).sourceDigest,
        sourcesOk: false,
      };
    }
  }
  return {
    ok: digest === sealed.digest,
    code: digest === sealed.digest ? null : JOURNEY_ANOMALIES.EVIDENCE_TAMPERED,
    count: sealed.entries.length,
    digest,
    expected: sealed.digest,
    at: sealed.lastAt || null,
    sourcesOk,
  };
}

function clip(text, limit) {
  return String(text == null ? '' : text).slice(0, limit);
}

/** 一行摘要：CLI 默认文本输出用。 */
export function describeJourney(journey) {
  if (!journey || typeof journey !== 'object') return 'borrow: 无借用记录';
  const parts = ['borrow=' + (journey.state || '?')];
  if (journey.requestId) parts.push('request=' + clip(journey.requestId, 40));
  if (journey.requestedAt > 0) parts.push('age=' + Math.round(Math.max(0, (journey.now || journey.requestedAt) - journey.requestedAt)) + 'ms');
  if (journey.surface) parts.push('surface=' + journey.surface);
  if (journey.decision) parts.push('decision=' + journey.decision);
  if (journey.entries) parts.push('entries=' + journey.entries.length);
  if (journey.anomalies && journey.anomalies.length) parts.push('anomalies=' + journey.anomalies.length);
  return parts.join(' ');
}
