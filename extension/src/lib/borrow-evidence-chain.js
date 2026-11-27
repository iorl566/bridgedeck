// src/lib/borrow-evidence-chain.js —— 借用证据链第二轮：多来源证据的相关、校验与对账。
//
// borrow.js 已经有一条“借用旅程哈希链”（human-borrow-ledger.js 的 chainEntry/sealChain），
// 回答“用户允许/拒绝、什么时候交还”。真实排障还要回答“同一次借用在其它子系统里留下的
// 事实是否自洽”：
//   - controller 是不是也认为进入了 borrowed？
//   - 交还后 passthrough 租约栈是不是空的？
//   - human-gate 的证据链里，这次借用前后的“人工信号”对得上吗？
//   - 闸门（borrow-confirm）的 pending/confirmed 与旅程决策是否一致？
//
// 本模块不复制这些链，只做“相关 + 校验 + 对账”：
//   buildBorrowEvidence({journey, gate, controller, leases, human, revision})
//     → 证据证书：sources（每个来源的归一化摘要 + digest）、timeline（按时间合并的事件）、
//       anomalies（语义冲突，只报告不修）、correlationKey（跨链相关键）。
//   verifyBorrowEvidence(cert)      重算各来源/certificate digest，发现事后改动；
//   borrowEvidenceDiff(left,right)  两份证书的逐来源差异（导出/重放前后对账）；
//   chainBorrowEvidence(prev,cert)  证书链（prevDigest+digest），同 tab 多次借用可按序校验；
//   verifyBorrowEvidenceChain(entries) 逐节重算；
//   summarizeBorrowEvidence / describeBorrowEvidence / formatBorrowEvidence 紧凑与文本输出；
//   borrowEvidenceLinks(...)        给 borrow-confirm.snapshot 的轻量接线函数（只加字段）。
//
// 接入点（file:line）：
//   human-borrow-ledger.js sealChain 现在附带 sourceDigest/kinds/sources（第二轮字段），
//   borrow.js 的 evidence()/journey() 原样带出；borrow-confirm.js snapshot() 额外挂
//   evidenceLinks（本模块的轻量相关摘要），不改变 status/check 的既有判定。
//
// 依赖方向：本模块 → human-borrow-ledger / cooperate-evidence / human-gate-chain，
// 三者都只依赖 input-lease-kinds，因此不会与 borrow.js 形成环（borrow.js 不 import 本模块）。

import { evidenceDigest } from './input-lease-kinds.js';
import { summarizeChainSources, verifyChain } from './human-borrow-ledger.js';
import { leaseStackEvidence } from './cooperate-evidence.js';
import { summarizeHumanChain, verifyHumanChain } from './human-gate-chain.js';
import { controlEvidence } from './cooperate-control.js';

export const BORROW_EVIDENCE_VERSION = 2;

export const BORROW_EVIDENCE_SOURCES = Object.freeze({
  JOURNEY: 'journey',
  GATE: 'gate',
  CONTROLLER: 'controller',
  LEASES: 'leases',
  HUMAN: 'human',
  REVISION: 'revision',
});

export const BORROW_EVIDENCE_CODES = Object.freeze({
  EVIDENCE_MISMATCH: 'BORROW_EVIDENCE_MISMATCH',
  EVIDENCE_MISSING: 'BORROW_EVIDENCE_MISSING',
  JOURNEY_MISSING: 'BORROW_EVIDENCE_JOURNEY_MISSING',
  GATE_MISSING: 'BORROW_EVIDENCE_GATE_MISSING',
  DECISION_GATE_MISMATCH: 'BORROW_EVIDENCE_DECISION_GATE_MISMATCH',
  CONTROLLER_AFTER_RETURN: 'BORROW_EVIDENCE_CONTROLLER_AFTER_RETURN',
  LEASE_AFTER_RETURN: 'BORROW_EVIDENCE_LEASE_AFTER_RETURN',
  HUMAN_CHAIN_MISSING: 'BORROW_EVIDENCE_HUMAN_CHAIN_MISSING',
  CHAIN_TAMPERED: 'BORROW_EVIDENCE_CHAIN_TAMPERED',
  TIMELINE_GAP: 'BORROW_EVIDENCE_TIMELINE_GAP',
  CORRELATION_MISMATCH: 'BORROW_EVIDENCE_CORRELATION_MISMATCH',
});

export const BORROW_EVIDENCE_LIMITS = Object.freeze({
  maxTimeline: 64,
  maxAnomalies: 16,
  maxChain: 16,
  maxLeases: 16,
});

const TERMINAL_JOURNEY_STATES = Object.freeze(['returned', 'closed', 'cancelled', 'expired', 'denied', 'timeout']);
const ACTIVE_JOURNEY_STATES = Object.freeze(['requested', 'presented', 'allowed', 'confirmed', 'active', 'returning']);

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
 * 借用旅程来源：接受 borrow.js 的 journey(tabId) 快照或 evidence(tabId) 封存证书。
 * 链证书额外带 sourceDigest/kinds（第二轮字段）与逐条验证结论。
 */
export function journeyEvidence(journey) {
  if (!journey || typeof journey !== 'object') {
    return { present: false, state: null, digest: evidenceDigest({ present: false }) };
  }
  const sealed = Array.isArray(journey.entries) ? journey : null;
  const sealedExtra = sealed && sealed.extra && typeof sealed.extra === 'object' ? sealed.extra : {};
  const state = clip(journey.state || sealedExtra.state || '', 24);
  const decision = clip(journey.decision || sealedExtra.decision || '', 16);
  const requestId = clip(journey.requestId || sealedExtra.requestId || '', 80);
  const entryCount = sealed ? sealed.count || sealed.entries.length : nonNegative(journey.entryCount);
  const chainDigest = sealed ? clip(sealed.digest || '', 16) : (journey.sealed && journey.sealed.digest ? clip(journey.sealed.digest, 16) : '');
  const sources = sealed ? summarizeChainSources(sealed.entries) : null;
  const verification = sealed ? verifyChain(sealed) : null;
  const body = {
    present: true,
    state,
    decision,
    requestId,
    entryCount,
    chainDigest,
    sourceDigest: sources ? sources.sourceDigest : (sealed && sealed.sourceDigest) || '',
    kinds: sources ? sources.kinds : (sealed && sealed.kinds) || null,
    chainVerified: verification ? verification.ok === true : null,
    terminal: TERMINAL_JOURNEY_STATES.includes(state),
    active: ACTIVE_JOURNEY_STATES.includes(state),
  };
  return { ...body, digest: evidenceDigest(body) };
}

/** 借用闸门来源（borrow-confirm.status/check 结果）。 */
export function gateEvidence(gate) {
  if (!gate || typeof gate !== 'object') {
    return { present: false, status: 'none', digest: evidenceDigest({ present: false }) };
  }
  const body = {
    present: true,
    status: clip(gate.status || 'none', 24),
    requestId: clip(gate.requestId || (gate.evidence && gate.evidence.requestId) || '', 80),
    pending: gate.status === 'pending' || gate.pending === true,
    confirmed: gate.status === 'confirmed',
    expired: gate.expired === true,
    decision: clip(gate.decision || '', 16),
  };
  return { ...body, digest: evidenceDigest(body) };
}

/** controller 来源：接受 controller.get/snapshot 的结果或字符串状态。 */
export function controllerEvidence(controller) {
  const state = typeof controller === 'string'
    ? controller
    : (controller && typeof controller === 'object'
      ? (controller.state && typeof controller.state === 'string' ? controller.state : controller.state && controller.state.state || controller.controllerState || '')
      : '');
  if (!state) return { present: false, state: null, digest: evidenceDigest({ present: false }) };
  const body = {
    present: true,
    state: clip(state, 24),
    borrowed: state === 'borrowed',
    human: state === 'human',
    agent: state === 'agent',
    handoff: state === 'handoff',
  };
  return { ...body, digest: evidenceDigest(body) };
}

/** revision 来源：交还前后的四项计数 + stale 方向。 */
export function revisionEvidence(revision) {
  if (!revision || typeof revision !== 'object') {
    return { present: false, digest: evidenceDigest({ present: false }) };
  }
  const before = isPlainObject(revision.before) ? revision.before : {};
  const after = isPlainObject(revision.after) ? revision.after : {};
  const body = {
    present: true,
    before: {
      controlRevision: num(before.controlRevision),
      authorityRevision: num(before.authorityRevision),
      revision: num(before.revision),
      frameEpoch: num(before.frameEpoch),
    },
    after: {
      controlRevision: num(after.controlRevision),
      authorityRevision: num(after.authorityRevision),
      revision: num(after.revision),
      frameEpoch: num(after.frameEpoch),
    },
    stale: revision.stale === true,
    side: clip(revision.side || '', 16),
  };
  return { ...body, digest: evidenceDigest(body) };
}

function humanEvidence(humanInput) {
  if (!humanInput) return { present: false, digest: evidenceDigest({ present: false }) };
  const sealed = Array.isArray(humanInput.entries) ? humanInput : null;
  if (sealed) {
    const summary = summarizeHumanChain(sealed);
    const verification = verifyHumanChain(sealed);
    const body = {
      present: true,
      count: summary ? summary.count : 0,
      byWho: summary ? summary.byWho : null,
      chainDigest: summary ? summary.digest : '',
      chainVerified: verification.ok === true,
    };
    return { ...body, digest: evidenceDigest(body) };
  }
  const state = clip(humanInput.state || 'idle', 24);
  const body = {
    present: true,
    state,
    active: humanInput.active === true,
    cooling: humanInput.cooling === true,
    lastAt: num(humanInput.lastAt),
    ageMs: humanInput.ageMs == null ? null : num(humanInput.ageMs),
    chainDigest: humanInput.chain && humanInput.chain.digest ? clip(humanInput.chain.digest, 16) : '',
  };
  return { ...body, digest: evidenceDigest(body) };
}

function pushTimeline(rows, entry) {
  if (!entry || typeof entry !== 'object') return;
  const at = num(entry.at);
  if (!(at > 0)) return;
  rows.push({ at, source: clip(entry.source || '', 24), kind: clip(entry.kind || '', 48), detail: clip(entry.detail || '', 120) });
}

/**
 * 时间线：把旅程链条目、human 链条目、租约起点、闸门事件合并成一条有序证据线。
 * @param {{journey?:object, human?:object, leases?:Array, gate?:object, controller?:object}} parts
 */
export function borrowEvidenceTimeline(parts = {}) {
  const rows = [];
  const journey = parts.journey;
  if (journey && Array.isArray(journey.entries)) {
    for (const entry of journey.entries) {
      pushTimeline(rows, { at: entry.at, source: 'journey', kind: entry.kind || 'state', detail: entry.data && entry.data.event ? entry.data.event : '' });
    }
  } else if (journey && typeof journey === 'object') {
    for (const [kind, field] of [['requested', 'requestedAt'], ['presented', 'presentedAt'], ['decided', 'decidedAt'], ['confirmed', 'confirmedAt'], ['active', 'activeAt'], ['returning', 'returnRequestedAt'], ['returned', 'returnedAt']]) {
      const at = num(journey[field]);
      if (at > 0) pushTimeline(rows, { at, source: 'journey', kind, detail: clip(journey.decision || '', 24) });
    }
  }
  const human = parts.human;
  if (human && Array.isArray(human.entries)) {
    for (const entry of human.entries) {
      pushTimeline(rows, { at: entry.at, source: 'human', kind: entry.kind || entry.who || 'signal', detail: entry.who || '' });
    }
  }
  for (const lease of (Array.isArray(parts.leases) ? parts.leases : [])) {
    const at = num(lease.startedAt || lease.at);
    if (at > 0) pushTimeline(rows, { at, source: 'leases', kind: 'lease.start', detail: clip(lease.kind || '', 24) + ':' + clip(lease.method || '', 32) });
  }
  const gate = parts.gate;
  if (gate && typeof gate === 'object') {
    const at = num(gate.resolvedAt || gate.requestedAt || gate.at);
    if (at > 0) pushTimeline(rows, { at, source: 'gate', kind: 'gate.' + clip(gate.status || 'none', 24), detail: clip(gate.requestId || '', 40) });
  }
  rows.sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    if (left.source !== right.source) return left.source < right.source ? -1 : 1;
    return left.kind < right.kind ? -1 : (left.kind > right.kind ? 1 : 0);
  });
  return rows.slice(-BORROW_EVIDENCE_LIMITS.maxTimeline);
}

function detectAnomalies(journey, gate, controller, leasesEvidence, humanEvidenceValue) {
  const anomalies = [];
  const push = (code, detail = {}) => anomalies.push({ code, ...detail });
  const journeyActive = journey && journey.active === true;
  if (gate.present && !journey.present) push(BORROW_EVIDENCE_CODES.JOURNEY_MISSING, { gateStatus: gate.status });
  if (journey.present && !gate.present && journeyActive) push(BORROW_EVIDENCE_CODES.GATE_MISSING, { journeyState: journey.state });
  if (journey.present && gate.present) {
    if (journey.decision === 'allow' && gate.status === 'pending') push(BORROW_EVIDENCE_CODES.DECISION_GATE_MISMATCH, { decision: 'allow', gateStatus: gate.status });
    if (journey.decision === 'deny' && gate.status === 'confirmed') push(BORROW_EVIDENCE_CODES.DECISION_GATE_MISMATCH, { decision: 'deny', gateStatus: gate.status });
  }
  if (journey.present && journey.terminal) {
    if (controller.present && controller.borrowed) push(BORROW_EVIDENCE_CODES.CONTROLLER_AFTER_RETURN, { controller: controller.state, journeyState: journey.state });
    if (leasesEvidence.active > 0) push(BORROW_EVIDENCE_CODES.LEASE_AFTER_RETURN, { activeLeases: leasesEvidence.active });
    if (humanEvidenceValue.present && humanEvidenceValue.active === false && gate.present && gate.status === 'pending') {
      push(BORROW_EVIDENCE_CODES.HUMAN_CHAIN_MISSING, { reason: 'terminal-with-pending-gate' });
    }
  }
  if (humanEvidenceValue.present && humanEvidenceValue.chainVerified === false) {
    push(BORROW_EVIDENCE_CODES.CHAIN_TAMPERED, { source: 'human' });
  }
  if (journey.present && journey.chainVerified === false) push(BORROW_EVIDENCE_CODES.CHAIN_TAMPERED, { source: 'journey' });
  if (journey.present && journey.present && journey.requestId && gate.present && gate.requestId && gate.requestId !== journey.requestId) {
    push(BORROW_EVIDENCE_CODES.CORRELATION_MISMATCH, { journeyRequest: journey.requestId, gateRequest: gate.requestId });
  }
  return anomalies.slice(0, BORROW_EVIDENCE_LIMITS.maxAnomalies);
}

/**
 * 构建借用证据证书：多来源摘要 + 合并时间线 + 语义冲突 + correlationKey。
 * @param {{tabId?:number, journey?:object, gate?:object, controller?:object|string,
 *          leases?:Array, human?:object, revision?:object, at?:number}} input
 */
export function buildBorrowEvidence(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const tabIdValue = source.tabId == null || source.tabId === ''
    ? null
    : (Number.isInteger(Number(source.tabId)) ? Number(source.tabId) : null);
  const at = num(source.at) || Date.now();
  const journey = journeyEvidence(source.journey);
  const gate = gateEvidence(source.gate);
  const controller = controllerEvidence(source.controller);
  const leases = leaseStackEvidence(source.leases);
  const human = humanEvidence(source.human);
  const revision = revisionEvidence(source.revision);
  const timeline = borrowEvidenceTimeline({
    journey: source.journey,
    human: source.human,
    leases: source.leases,
    gate: source.gate,
    controller: source.controller,
  });
  const anomalies = detectAnomalies(journey, gate, controller, leases, human);
  // 【M6 P0③】控制面来源（context_id/control_policy/epoch）：只在调用方提供时附加，
  // 不进入 sources（保持既有 6 来源契约与 digest 稳定）。
  const control = controlEvidence(source.control);
  const sources = {
    journey: journey.digest,
    gate: gate.digest,
    controller: controller.digest,
    leases: leases.digest,
    human: human.digest,
    revision: revision.digest,
  };
  // 相关键只由“同一次借用”的稳定事实构成（tab + requestId + decision）；
  // 不能用旅程 state/sourceDigest 等随生命周期变化的字段，否则交还前后对不上账。
  const correlationKey = 'bk-' + evidenceDigest({
    tabId: tabIdValue,
    requestId: journey.requestId || gate.requestId || '',
    decision: journey.decision || gate.decision || '',
  });
  const body = {
    version: BORROW_EVIDENCE_VERSION,
    kind: 'borrow.evidence',
    tabId: tabIdValue,
    at,
    journey,
    gate,
    controller,
    leases,
    human,
    revision,
    ...(control ? { control } : {}),
    sources,
    timeline,
    anomalies,
    correlationKey,
  };
  return { ...body, digest: evidenceDigest(body) };
}

/** 校验借用证据证书（重算 digest；来源被替换/时间线被改都能发现）。 */
export function verifyBorrowEvidence(certificate) {
  if (!certificate || typeof certificate !== 'object') {
    return { ok: false, code: BORROW_EVIDENCE_CODES.EVIDENCE_MISSING, error: '借用证据证书缺失' };
  }
  const body = { ...certificate };
  delete body.digest;
  const expected = evidenceDigest(body);
  const anomalies = Array.isArray(certificate.anomalies) ? certificate.anomalies : [];
  return {
    ok: expected === certificate.digest && anomalies.length === 0,
    digestOk: expected === certificate.digest,
    anomaliesOk: anomalies.length === 0,
    code: expected === certificate.digest ? (anomalies.length ? BORROW_EVIDENCE_CODES.EVIDENCE_MISMATCH : null) : BORROW_EVIDENCE_CODES.EVIDENCE_MISMATCH,
    expected,
    actual: certificate.digest || null,
    tabId: certificate.tabId == null ? null : certificate.tabId,
    correlationKey: certificate.correlationKey || '',
  };
}

/** 两份借用证据证书的逐来源差异（导出/重放前后对账）。 */
export function borrowEvidenceDiff(left, right) {
  const leftSources = isPlainObject(left && left.sources) ? left.sources : {};
  const rightSources = isPlainObject(right && right.sources) ? right.sources : {};
  const sources = [];
  for (const name of Object.values(BORROW_EVIDENCE_SOURCES)) {
    const before = leftSources[name] || null;
    const after = rightSources[name] || null;
    if (before !== after) sources.push({ source: name, before, after });
  }
  const leftAnomalies = (Array.isArray(left && left.anomalies) ? left.anomalies : []).map((item) => item.code);
  const rightAnomalies = (Array.isArray(right && right.anomalies) ? right.anomalies : []).map((item) => item.code);
  const anomaliesAdded = rightAnomalies.filter((code) => !leftAnomalies.includes(code));
  const anomaliesRemoved = leftAnomalies.filter((code) => !rightAnomalies.includes(code));
  const leftTimeline = Array.isArray(left && left.timeline) ? left.timeline.length : 0;
  const rightTimeline = Array.isArray(right && right.timeline) ? right.timeline.length : 0;
  return {
    ok: true,
    equal: sources.length === 0 && anomaliesAdded.length === 0 && anomaliesRemoved.length === 0 && leftTimeline === rightTimeline,
    sources,
    anomaliesAdded,
    anomaliesRemoved,
    timeline: { left: leftTimeline, right: rightTimeline },
    correlation: {
      left: left && left.correlationKey ? left.correlationKey : '',
      right: right && right.correlationKey ? right.correlationKey : '',
      same: Boolean(left && right && left.correlationKey && left.correlationKey === right.correlationKey),
    },
    stats: { changedSources: sources.length, anomaliesAdded: anomaliesAdded.length, anomaliesRemoved: anomaliesRemoved.length },
  };
}

/**
 * 证书链：prevDigest + 证书关键字段 → 可连续校验的链节。
 * @param {{chainDigest?:string, digest?:string}|null} previous
 * @param {object} certificate
 * @param {{seq?:number, at?:number}} [context]
 */
export function chainBorrowEvidence(previous, certificate, context = {}) {
  if (!certificate || typeof certificate !== 'object') return null;
  const prevDigest = previous && (previous.chainDigest || previous.digest) ? (previous.chainDigest || previous.digest) : 'genesis';
  const body = {
    seq: Math.max(1, integer(context.seq, 1)),
    at: num(context.at) || num(certificate.at),
    tabId: certificate.tabId == null ? null : certificate.tabId,
    digest: certificate.digest || '',
    correlationKey: certificate.correlationKey || '',
    sources: certificate.sources || null,
    anomalies: (Array.isArray(certificate.anomalies) ? certificate.anomalies : []).map((item) => item.code),
  };
  return { ...body, prevDigest, chainDigest: 'bc' + evidenceDigest({ prevDigest, body }) };
}

/** 校验证书链（逐节重算，定位第一处被改动）。 */
export function verifyBorrowEvidenceChain(entriesInput) {
  const entries = (Array.isArray(entriesInput) ? entriesInput : []).slice(0, BORROW_EVIDENCE_LIMITS.maxChain);
  let previous = null;
  for (let index = 0; index < entries.length; index += 1) {
    const expected = chainBorrowEvidence(previous, {
      tabId: entries[index].tabId,
      at: entries[index].at,
      digest: entries[index].digest,
      correlationKey: entries[index].correlationKey,
      sources: entries[index].sources,
      anomalies: (entries[index].anomalies || []).map((code) => ({ code })),
    }, { seq: entries[index].seq, at: entries[index].at });
    if (!expected || expected.chainDigest !== entries[index].chainDigest) {
      return {
        ok: false,
        code: BORROW_EVIDENCE_CODES.CHAIN_TAMPERED,
        index,
        expected: entries[index].chainDigest,
        actual: expected ? expected.chainDigest : null,
      };
    }
    previous = entries[index];
  }
  return { ok: true, code: null, count: entries.length, digest: entries.length ? entries[entries.length - 1].chainDigest : 'genesis' };
}

/** 紧凑摘要（挂到 borrow-confirm.snapshot / 诊断）。 */
export function summarizeBorrowEvidence(certificate) {
  if (!certificate || typeof certificate !== 'object') return null;
  return {
    version: BORROW_EVIDENCE_VERSION,
    digest: clip(certificate.digest || '', 16),
    correlationKey: clip(certificate.correlationKey || '', 16),
    tabId: certificate.tabId == null ? null : certificate.tabId,
    journey: certificate.journey ? { state: certificate.journey.state, decision: certificate.journey.decision, chainDigest: certificate.journey.chainDigest, verified: certificate.journey.chainVerified } : null,
    gate: certificate.gate ? { status: certificate.gate.status, requestId: certificate.gate.requestId } : null,
    controller: certificate.controller ? { state: certificate.controller.state } : null,
    leases: certificate.leases ? { count: certificate.leases.count, active: certificate.leases.active } : null,
    human: certificate.human ? { count: certificate.human.count, chainDigest: certificate.human.chainDigest } : null,
    ...(certificate.control ? { control: certificate.control } : {}),
    anomalies: Array.isArray(certificate.anomalies) ? certificate.anomalies.slice(0, 4).map((item) => item.code) : [],
    timeline: Array.isArray(certificate.timeline) ? certificate.timeline.length : 0,
  };
}

/** 一行文本摘要。 */
export function describeBorrowEvidence(certificate) {
  if (!certificate || typeof certificate !== 'object') return 'borrow-evidence: 无证书';
  const parts = ['borrow-evidence=' + clip(certificate.correlationKey || '-', 16)];
  const journey = certificate.journey || {};
  if (journey.state) parts.push('journey=' + journey.state);
  if (journey.decision) parts.push('decision=' + journey.decision);
  if (certificate.leases) parts.push('leases=' + certificate.leases.active + '/' + certificate.leases.count);
  if (certificate.human && certificate.human.count) parts.push('human=' + certificate.human.count);
  if (Array.isArray(certificate.anomalies) && certificate.anomalies.length) parts.push('anomalies=' + certificate.anomalies.length);
  if (certificate.digest) parts.push('digest=' + certificate.digest);
  return parts.join(' ');
}

/** 文本证书（CLI/日志；行数有上限）。 */
export function formatBorrowEvidence(certificate, options = {}) {
  const maxLines = Math.max(1, integer(options.maxLines, 16));
  if (!certificate || typeof certificate !== 'object') return ['borrow-evidence: 无证书'];
  const lines = [describeBorrowEvidence(certificate)];
  lines.push('  sources: journey=' + (certificate.sources && certificate.sources.journey) + ' gate=' + (certificate.sources && certificate.sources.gate));
  for (const entry of (Array.isArray(certificate.timeline) ? certificate.timeline : []).slice(0, Math.max(0, maxLines - 2 - (certificate.anomalies || []).length))) {
    lines.push('  ' + entry.at + ' ' + entry.source + ' ' + entry.kind + (entry.detail ? ' ' + entry.detail : ''));
  }
  for (const anomaly of (Array.isArray(certificate.anomalies) ? certificate.anomalies : [])) {
    if (lines.length >= maxLines) break;
    lines.push('  anomaly ' + anomaly.code);
  }
  return lines.slice(0, maxLines);
}

/**
 * borrow-confirm.snapshot 的轻量接线：只读聚合，绝不影响借用判定。
 * @param {{tabId:number, status?:object, journey?:object, sealed?:object, controller?:object|string, leases?:Array, human?:object, control?:object}} input
 */
export function borrowEvidenceLinks(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const tabId = source.tabId == null || source.tabId === ''
    ? null
    : (Number.isInteger(Number(source.tabId)) ? Number(source.tabId) : null);
  if (tabId == null) return null;
  const journeySealed = source.sealed && Array.isArray(source.sealed.entries) ? source.sealed : null;
  const certificate = buildBorrowEvidence({
    tabId,
    journey: journeySealed || source.journey || null,
    gate: source.status || null,
    controller: source.controller || null,
    leases: source.leases || [],
    human: source.human || null,
    control: source.control || null,
    at: source.at,
  });
  const summary = summarizeBorrowEvidence(certificate);
  return {
    ok: certificate.anomalies.length === 0,
    correlationKey: summary.correlationKey,
    digest: summary.digest,
    sources: certificate.sources,
    timeline: summary.timeline,
    anomalies: summary.anomalies,
    journeyState: summary.journey ? summary.journey.state : null,
    controller: summary.controller,
    leases: summary.leases,
    human: summary.human,
    ...(summary.control ? { control: summary.control } : {}),
  };
}

/** 只读：两份 payload 的 correlationKey 是否指向同一次借用。 */
export function sameBorrowCorrelation(left, right) {
  const leftKey = left && (left.correlationKey || (left.extra && left.extra.correlationKey));
  const rightKey = right && (right.correlationKey || (right.extra && right.extra.correlationKey));
  if (!leftKey || !rightKey) return { same: false, reason: 'missing-key' };
  return { same: leftKey === rightKey, left: leftKey, right: rightKey, reason: leftKey === rightKey ? null : 'key-mismatch' };
}
