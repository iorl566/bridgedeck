// src/lib/human-gate-chain.js —— 人机互斥闸门的证据链 v2（纯函数 + 可复算证书）。
//
// 第一轮的 human-gate.js 已经能回答“现在是不是人在动、冷却还剩多少”，并把每条人工信号
// 记进有界 history。但 history 只是内存数组：事后无法证明“这条拒绝判定当时看到的信号
// 就是后来诊断里那几条”，人机冲突也没有可校验的证书。
//
// 第二轮把判定升级成可证据化的链：
//   - humanSignalEntry：每条人工/Agent 信号进链（prevDigest + digest，FNV-1a，非加密），
//     链里带归因结论（who/basis/confidence）与当时状态机状态；
//   - sealHumanChain / verifyHumanChain：把一段信号封成证书，逐条重算定位被改动位置；
//   - mergeHumanChains：多 tab / 多来源（content/human-state/explicit）的链按时间合并，
//     保留来源标签，供导出/诊断按 tab 对账；
//   - humanConflictCertificate：人机冲突证书（人工时刻、租约起点、重叠毫秒、容差、当时
//     链尾 digest），verifyConflictCertificate 重算 digest；
//   - summarizeHumanChain / describeHumanChain：紧凑摘要与一行文本。
//
// 只依赖 input-lease-kinds.evidenceDigest（叶子工具），不 import human-gate.js，
// 因此 human-gate.js 可以安全地 import 本模块（无环）。
//
// 接入点（file:line）：human-gate.js 的 noteHuman / settle / state / exclusive / evidence
// 在既有字段之外追加 chain 字段；cooperate.js:635-657 的 mayAct 通过 human.exclusive 的
// evidence 自动带上链摘要，无需改 cooperate.js。

import { evidenceDigest } from './input-lease-kinds.js';

export const HUMAN_CHAIN_VERSION = 1;

export const HUMAN_CHAIN_CODES = Object.freeze({
  CHAIN_MISMATCH: 'HUMAN_CHAIN_MISMATCH',
  CHAIN_EMPTY: 'HUMAN_CHAIN_EMPTY',
  CHAIN_BAD_ARG: 'HUMAN_CHAIN_BAD_ARG',
  CERT_MISMATCH: 'HUMAN_CONFLICT_CERT_MISMATCH',
  CERT_MISSING: 'HUMAN_CONFLICT_CERT_MISSING',
});

export const HUMAN_CHAIN_LIMITS = Object.freeze({
  maxEntries: 256,
  maxMerged: 512,
  maxLeases: 16,
  maxSignals: 32,
});

const WHO_VALUES = Object.freeze(['human', 'agent', 'unknown']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function clip(text, limit) {
  return String(text == null ? '' : text).slice(0, limit);
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * 一条信号 → 链条目（不含 digest/prevDigest 之外的派生字段）。
 * @param {object} signal 已归一化的人工信号（at/kind/frameId/source/trusted/count/revision）
 * @param {{who?:string, basis?:string, confidence?:number, state?:string}} [attribution]
 * @param {{seq?:number}} [context]
 */
export function normalizeHumanChainSignal(signal, attribution = {}, context = {}) {
  if (!signal || typeof signal !== 'object') return null;
  const who = WHO_VALUES.includes(attribution.who) ? attribution.who : 'unknown';
  const confidence = Number.isFinite(Number(attribution.confidence)) ? Math.max(0, Math.min(1, Number(attribution.confidence))) : 0;
  return {
    seq: Math.max(1, integer(context.seq, 1)),
    at: Math.max(0, num(signal.at)),
    kind: clip(signal.kind || 'input', 32),
    frameId: integer(signal.frameId, 0),
    source: clip(signal.source || 'explicit', 32),
    who,
    basis: clip(attribution.basis || '', 32),
    confidence,
    state: clip(context.state || attribution.state || 'idle', 24),
    count: nonNegative(signal.count),
    trusted: signal.trusted !== false,
    revision: Number.isInteger(signal.revision) ? signal.revision : null,
    label: clip(signal.label || '', 120),
  };
}

/**
 * 追加一条链条目：entry.digest = h(prevDigest + 规范化 body)。
 * @param {{digest?:string}|null} previous 上一条
 * @param {object} entry normalizeHumanChainSignal 的结果
 */
export function humanSignalEntry(previous, entry) {
  if (!entry || typeof entry !== 'object') return null;
  const prevDigest = previous && previous.digest ? previous.digest : 'genesis';
  const body = {
    seq: entry.seq,
    at: entry.at,
    kind: entry.kind,
    frameId: entry.frameId,
    source: entry.source,
    who: entry.who,
    basis: entry.basis,
    confidence: entry.confidence,
    state: entry.state,
    count: entry.count,
    trusted: entry.trusted,
    revision: entry.revision,
    label: entry.label,
  };
  return { ...body, prevDigest, digest: evidenceDigest({ prevDigest, body }) };
}

/**
 * 把手动维护的链数组封成证书；空链也有确定 digest（空链封存可校验）。
 * @param {Array} entriesInput
 * @param {object} [extra]
 */
export function sealHumanChain(entriesInput, extra = {}) {
  const entries = [];
  let previous = null;
  for (const raw of (Array.isArray(entriesInput) ? entriesInput : [])) {
    const normalized = normalizeHumanChainSignal(raw.raw && isPlainObject(raw.raw) ? raw.raw : raw, raw.attribution || {}, { seq: raw.seq, state: raw.state });
    if (!normalized) continue;
    const chained = raw && raw.digest && raw.prevDigest ? raw : humanSignalEntry(previous, normalized);
    entries.push(chained);
    previous = chained;
  }
  const digest = previous && previous.digest ? previous.digest : evidenceDigest({ empty: true, extra: extra || null });
  return {
    version: HUMAN_CHAIN_VERSION,
    sealed: true,
    count: entries.length,
    firstAt: entries.length ? entries[0].at : 0,
    lastAt: entries.length ? entries[entries.length - 1].at : 0,
    digest,
    extra: isPlainObject(extra) ? { ...extra } : null,
    entries: entries.slice(0, HUMAN_CHAIN_LIMITS.maxEntries),
  };
}

/**
 * 校验人机信号链：逐条重算 prevDigest/digest，返回第一条被改动的 index。
 * @param {{entries?:Array, digest?:string}} sealed
 */
export function verifyHumanChain(sealed) {
  if (!sealed || !Array.isArray(sealed.entries)) {
    return { ok: false, code: HUMAN_CHAIN_CODES.CHAIN_BAD_ARG, error: '人机信号链缺失或结构不对', at: null };
  }
  let previous = null;
  for (let index = 0; index < sealed.entries.length; index += 1) {
    const entry = sealed.entries[index];
    if (!isPlainObject(entry)) continue;
    const expected = humanSignalEntry(previous, entry);
    if (!expected || expected.digest !== entry.digest) {
      return {
        ok: false,
        code: HUMAN_CHAIN_CODES.CHAIN_MISMATCH,
        error: '人机信号链第 ' + index + ' 条被改动',
        index,
        expected: entry.digest,
        actual: expected ? expected.digest : null,
        at: num(entry.at),
      };
    }
    previous = entry;
  }
  const digest = previous && previous.digest ? previous.digest : evidenceDigest({ empty: true, extra: sealed.extra || null });
  return {
    ok: digest === sealed.digest,
    code: digest === sealed.digest ? null : HUMAN_CHAIN_CODES.CHAIN_MISMATCH,
    count: sealed.entries.length,
    digest,
    expected: sealed.digest,
    at: sealed.lastAt || null,
  };
}

/**
 * 多来源链合并：按 at 排序（同一时刻按 source 名稳定排序），重新链接。
 * 输入可以是 sealed 证书、条目数组、或 {tabId, entries} 列表。
 * @param {Array} chainsInput
 * @param {{maxEntries?:number}} [options]
 */
export function mergeHumanChains(chainsInput, options = {}) {
  const maxEntries = Math.max(1, integer(options.maxEntries, HUMAN_CHAIN_LIMITS.maxMerged));
  const sources = [];
  const rows = [];
  for (const chain of (Array.isArray(chainsInput) ? chainsInput : [])) {
    if (!chain) continue;
    const entries = Array.isArray(chain) ? chain : (Array.isArray(chain.entries) ? chain.entries : []);
    const sourceLabel = clip((!Array.isArray(chain) && (chain.extra && chain.extra.tabId != null ? 'tab:' + chain.extra.tabId : chain.source)) || options.source || 'chain-' + (sources.length + 1), 48);
    sources.push({ source: sourceLabel, count: entries.length });
    for (const entry of entries) {
      if (!isPlainObject(entry)) continue;
      rows.push({ sourceLabel, entry });
    }
  }
  rows.sort((left, right) => {
    if (left.entry.at !== right.entry.at) return left.entry.at - right.entry.at;
    if (left.sourceLabel !== right.sourceLabel) return left.sourceLabel < right.sourceLabel ? -1 : 1;
    return integer(left.entry.seq, 0) - integer(right.entry.seq, 0);
  });
  const merged = [];
  let previous = null;
  for (const row of rows.slice(-maxEntries)) {
    const normalized = normalizeHumanChainSignal({
      at: row.entry.at,
      kind: row.entry.kind,
      frameId: row.entry.frameId,
      source: row.entry.source + '@' + row.sourceLabel,
      trusted: row.entry.trusted !== false,
      count: row.entry.count,
      revision: row.entry.revision,
      label: row.entry.label,
    }, { who: row.entry.who, basis: row.entry.basis, confidence: row.entry.confidence }, { seq: merged.length + 1, state: row.entry.state });
    const chained = humanSignalEntry(previous, normalized);
    merged.push(chained);
    previous = chained;
  }
  const byWho = { human: 0, agent: 0, unknown: 0 };
  for (const entry of merged) byWho[entry.who] = (byWho[entry.who] || 0) + 1;
  return {
    version: HUMAN_CHAIN_VERSION,
    merged: true,
    count: merged.length,
    sources,
    byWho,
    firstAt: merged.length ? merged[0].at : 0,
    lastAt: merged.length ? merged[merged.length - 1].at : 0,
    digest: previous ? previous.digest : evidenceDigest({ empty: true }),
    entries: merged,
  };
}

/**
 * 人机冲突证书：把“当时人工在 X ms、租约起点在 Y、重叠 Z ms、容差 T”封成可校验证据。
 * @param {{tabId:number, human?:object, leases?:Array, conflict?:object, decision?:object,
 *          chainDigest?:string, at?:number, toleranceMs?:number}} input
 */
export function humanConflictCertificate(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const tabId = Number.isInteger(Number(source.tabId)) ? Number(source.tabId) : null;
  const human = isPlainObject(source.human) ? source.human : {};
  const leases = (Array.isArray(source.leases) ? source.leases : []).slice(0, HUMAN_CHAIN_LIMITS.maxLeases).map((lease) => ({
    leaseId: clip(lease && (lease.leaseId || lease.token || ''), 64),
    kind: clip(lease && lease.kind || '', 24),
    method: clip(lease && lease.method || '', 64),
    startedAt: num(lease && (lease.startedAt || lease.at)),
    active: lease && lease.active !== false && lease.used !== true,
  }));
  const conflict = isPlainObject(source.conflict) ? source.conflict : {};
  const decision = isPlainObject(source.decision) ? source.decision : {};
  const certificate = {
    version: HUMAN_CHAIN_VERSION,
    kind: 'human.conflict',
    tabId,
    at: num(source.at) || Date.now(),
    human: {
      lastAt: num(human.lastAt),
      lastKind: clip(human.lastKind || '', 32),
      ageMs: human.ageMs == null ? null : num(human.ageMs),
      state: clip(human.state || '', 24),
    },
    leases,
    conflict: {
      conflicting: conflict.conflicting === true || source.conflicting === true,
      overlapMs: num(conflict.overlapMs),
      leaseStart: num(conflict.leaseStart),
      toleranceMs: num(source.toleranceMs != null ? source.toleranceMs : conflict.evidence && conflict.evidence.toleranceMs),
    },
    decision: {
      allowed: decision.allowed === true,
      code: clip(decision.code || '', 48),
      source: clip(decision.source || '', 24),
      method: clip(decision.method || '', 64),
    },
    chainDigest: clip(source.chainDigest || '', 16),
  };
  certificate.digest = evidenceDigest(certificate);
  return certificate;
}

/** 校验冲突证书 digest（忽略 digest 字段本身后重算）。 */
export function verifyConflictCertificate(certificate) {
  if (!certificate || typeof certificate !== 'object') {
    return { ok: false, code: HUMAN_CHAIN_CODES.CERT_MISSING, error: '冲突证书缺失' };
  }
  const body = { ...certificate };
  delete body.digest;
  const expected = evidenceDigest(body);
  return {
    ok: expected === certificate.digest,
    code: expected === certificate.digest ? null : HUMAN_CHAIN_CODES.CERT_MISMATCH,
    expected,
    actual: certificate.digest || null,
    tabId: certificate.tabId == null ? null : certificate.tabId,
    conflicting: Boolean(certificate.conflict && certificate.conflict.conflicting),
  };
}

/** 紧凑摘要（挂到 state()/exclusive evidence；体积有界）。 */
export function summarizeHumanChain(chainOrSealed) {
  if (!chainOrSealed || typeof chainOrSealed !== 'object') return null;
  const entries = Array.isArray(chainOrSealed.entries) ? chainOrSealed.entries : (Array.isArray(chainOrSealed) ? chainOrSealed : null);
  if (!entries) return null;
  const byWho = { human: 0, agent: 0, unknown: 0 };
  const sources = new Set();
  const kinds = new Set();
  let lastAt = 0;
  let lastKind = '';
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (byWho[entry.who] === undefined) byWho[entry.who] = 0;
    byWho[entry.who] += 1;
    if (entry.source) sources.add(entry.source);
    if (entry.kind) kinds.add(entry.kind);
    if (num(entry.at) >= lastAt) {
      lastAt = num(entry.at);
      lastKind = entry.kind || '';
    }
  }
  const last = entries.length ? entries[entries.length - 1] : null;
  return {
    version: HUMAN_CHAIN_VERSION,
    count: entries.length,
    byWho,
    kinds: [...kinds].slice(0, 8),
    sources: [...sources].slice(0, 8),
    lastAt,
    lastKind: clip(lastKind, 32),
    digest: last && last.digest ? last.digest : evidenceDigest({ empty: true }),
  };
}

/** 一行摘要：CLI/诊断用。 */
export function describeHumanChain(chain) {
  if (!chain || typeof chain !== 'object') return 'human-chain: 无链';
  const parts = ['human-chain=' + integer(chain.count, 0)];
  const byWho = isPlainObject(chain.byWho) ? chain.byWho : {};
  if (byWho.human > 0) parts.push('human=' + byWho.human);
  if (byWho.agent > 0) parts.push('agent=' + byWho.agent);
  if (chain.digest) parts.push('digest=' + chain.digest);
  return parts.join(' ');
}

/**
 * 链一致性检查：把 live 链与封存证书对比（用于“诊断期间链是否被重建/丢失”）。
 * @returns {{ok:boolean, code:string|null, live:string, sealed:string, delta:number}}
 */
export function compareHumanChain(liveEntries, sealed) {
  const live = sealHumanChain(liveEntries);
  if (!sealed || !Array.isArray(sealed.entries)) {
    return { ok: false, code: HUMAN_CHAIN_CODES.CERT_MISSING, live: live.digest, sealed: '', delta: live.count };
  }
  return {
    ok: live.digest === sealed.digest && live.count === sealed.count,
    code: live.digest === sealed.digest ? null : HUMAN_CHAIN_CODES.CHAIN_MISMATCH,
    live: live.digest,
    sealed: sealed.digest,
    delta: live.count - sealed.count,
  };
}
