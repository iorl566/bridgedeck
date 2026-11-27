// src/lib/cooperate-evidence.js —— 协作 passthrough 判定（mayAct）的证据包 v2（纯函数）。
//
// cooperate.js 的 mayAct 已经在读四类事实：human-gate 判定、controller 闸门、borrowGate、
// 活跃租约栈；它把这些合成 evidence 返回给调用方（cooperate.js:623-659）。但这些证据
// 是“散装对象”：没有统一摘要、没有前后链路，跨来源的语义冲突（例如 borrowGate 说
// pending、租约栈却是空）只能靠人读日志。
//
// 第二轮补的是“证据包”：
//   - normalizeLeaseEvidence / leaseStackEvidence：租约栈归一化（token 打码、窗口、kind 分布、
//     栈摘要）；leaseOverlap 判断某时刻是否与租约窗口重叠；
//   - borrowGateEvidence / controllerGateEvidence / humanGateEvidence：三类外部闸门的归一化摘要；
//   - mayActEvidence：把四类事实封成一个证据包，带 flags（humanActive/cooling/borrowPending/
//     leaseAmbient…）与 digest；不同来源互相矛盾时给出 anomalies（只报告不处决）；
//   - chainMayActEvidence：证据包的哈希链（prevDigest+digest），同 tab 连续判定可对账；
//   - verifyMayActEvidence / summarizeMayActEvidence / describeMayActEvidence：校验/紧凑/文本。
//
// 接入点（file:line）：
//   human-gate.js 的 exclusive() 对 cooperate.js:635 的调用返回 evidence.cooperation
//   （新增字段，allowed/code/state 判定与之前完全一致）；cooperate.js:650-657 把
//   decided.evidence 原样并进自己的 evidence，因此 CLI/诊断无需改 cooperate.js 就能读到。
//
// 只依赖 input-lease-kinds.evidenceDigest；不 import cooperate.js/human-gate.js（无环）。

import { evidenceDigest } from './input-lease-kinds.js';

export const COOPERATION_EVIDENCE_VERSION = 1;

export const COOPERATION_EVIDENCE_CODES = Object.freeze({
  EVIDENCE_MISMATCH: 'COOPERATION_EVIDENCE_MISMATCH',
  EVIDENCE_MISSING: 'COOPERATION_EVIDENCE_MISSING',
  LEASE_PENDING_CONFLICT: 'COOPERATION_LEASE_PENDING_CONFLICT',
  CONTROLLER_BORROW_CONFLICT: 'COOPERATION_CONTROLLER_BORROW_CONFLICT',
  HUMAN_LEASE_AMBIENT: 'COOPERATION_HUMAN_LEASE_AMBIENT',
  STALE_REVISION: 'COOPERATION_STALE_REVISION',
});

export const COOPERATION_EVIDENCE_LIMITS = Object.freeze({
  maxLeases: 16,
  maxChain: 8,
  maxSources: 8,
});

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

/** 租约凭据一律打码：只保留长度与来源，不把 token 写进证据包。 */
function maskLeaseToken(token) {
  const text = String(token == null ? '' : token);
  if (!text) return '';
  return text.slice(0, 2) + '***' + text.slice(-2);
}

/**
 * 单条租约 → 证据摘要（token 打码；只读窗口事实，不含凭据）。
 * @param {object} lease summarizeLease 形状或原始租约
 */
export function normalizeLeaseEvidence(lease) {
  if (!lease || typeof lease !== 'object') return null;
  const startedAt = num(lease.startedAt || lease.at);
  const endedAt = num(lease.endedAt || lease.releasedAt);
  return {
    leaseId: clip(lease.leaseId || '', 64),
    kind: clip(lease.kind || '', 24),
    method: clip(lease.method || '', 64),
    owner: clip(lease.owner || '', 64),
    grantee: clip(lease.grantee || '', 64),
    token: maskLeaseToken(lease.token || lease.tokenMasked),
    startedAt,
    expiresAt: num(lease.expiresAt),
    depth: Math.max(0, integer(lease.depth, 0)),
    active: lease.active !== false && lease.released !== true && lease.used !== true,
    suppressionKind: clip(lease.suppressionKind || '', 24),
    state: endedAt > 0 ? 'ended' : (lease.active !== false && lease.released !== true ? 'active' : 'released'),
  };
}

/**
 * 租约栈证据：条数/活跃数/kind 分布/方法集合/窗口范围/摘要 digest。
 * @param {Array} leasesInput
 */
export function leaseStackEvidence(leasesInput) {
  const list = (Array.isArray(leasesInput) ? leasesInput : [])
    .map((lease) => normalizeLeaseEvidence(lease))
    .filter(Boolean)
    .slice(0, COOPERATION_EVIDENCE_LIMITS.maxLeases);
  const active = list.filter((lease) => lease.active);
  const kinds = {};
  const methods = new Set();
  let firstStartedAt = 0;
  let lastStartedAt = 0;
  let latestExpiresAt = 0;
  for (const lease of active) {
    kinds[lease.kind || 'unknown'] = (kinds[lease.kind || 'unknown'] || 0) + 1;
    if (lease.method) methods.add(lease.method);
    if (lease.startedAt > 0) {
      if (firstStartedAt === 0 || lease.startedAt < firstStartedAt) firstStartedAt = lease.startedAt;
      if (lease.startedAt > lastStartedAt) lastStartedAt = lease.startedAt;
    }
    latestExpiresAt = Math.max(latestExpiresAt, lease.expiresAt);
  }
  const body = {
    count: list.length,
    active: active.length,
    kinds,
    methods: [...methods].slice(0, 8),
    firstStartedAt,
    lastStartedAt,
    latestExpiresAt,
    leaseIds: active.map((lease) => lease.leaseId).filter(Boolean).slice(0, 8),
  };
  return { ...body, digest: evidenceDigest(body) };
}

/**
 * 某时刻是否与租约窗口重叠：返回重叠的租约与毫秒数（无重叠时 lease=null）。
 * @param {Array} leasesInput
 * @param {number} at
 */
export function leaseOverlap(leasesInput, at) {
  const time = num(at);
  const list = (Array.isArray(leasesInput) ? leasesInput : []).map((lease) => normalizeLeaseEvidence(lease)).filter(Boolean);
  if (!(time > 0)) return { overlapping: false, lease: null, overlapMs: 0, checked: list.length };
  let best = null;
  let bestOverlap = 0;
  for (const lease of list) {
    if (!lease.active) continue;
    const start = lease.startedAt;
    const end = lease.expiresAt > 0 ? lease.expiresAt : Infinity;
    if (!(start > 0) || time < start || time > end) continue;
    const overlapMs = Math.min(time, end === Infinity ? time : end) - start;
    if (!best || overlapMs > bestOverlap) {
      best = lease;
      bestOverlap = Math.max(0, overlapMs);
    }
  }
  return { overlapping: best != null, lease: best, overlapMs: Math.round(bestOverlap), checked: list.length };
}

/**
 * borrowGate 结果归一化：pending/confirmed/absent 三态 + 摘要 digest。
 * cooperate.mayAct 传入的 borrowGate 是 human.exclusive 的参数（borrow-confirm 的 check 结果）。
 */
export function borrowGateEvidence(borrowGate) {
  if (!borrowGate || typeof borrowGate !== 'object') {
    return { present: false, allowed: true, code: null, status: 'absent', digest: evidenceDigest({ present: false }) };
  }
  const body = {
    present: true,
    allowed: borrowGate.allowed !== false,
    code: clip(borrowGate.code || '', 48),
    status: clip(borrowGate.status || (borrowGate.pending === true ? 'pending' : ''), 24),
    pending: borrowGate.pending === true || borrowGate.allowed === false,
    requestId: clip(borrowGate.evidence && borrowGate.evidence.requestId || borrowGate.requestId || '', 80),
    decision: clip(borrowGate.decision || '', 24),
  };
  return { ...body, digest: evidenceDigest(body) };
}

/**
 * controller 闸门归一化：allowed / code / state 与摘要。
 */
export function controllerGateEvidence(controllerGate) {
  if (!controllerGate || typeof controllerGate !== 'object') {
    return { present: false, allowed: true, code: null, state: null, digest: evidenceDigest({ present: false }) };
  }
  const body = {
    present: true,
    allowed: controllerGate.allowed !== false,
    code: clip(controllerGate.code || '', 48),
    state: clip(controllerGate.state || '', 24),
    reason: clip(controllerGate.evidence && controllerGate.evidence.reason || '', 80),
  };
  return { ...body, digest: evidenceDigest(body) };
}

/** human-gate 判定摘要（human.exclusive 内部用；也可单独给 CLI 读）。 */
export function humanGateEvidence(human) {
  const source = isPlainObject(human) ? human : {};
  const body = {
    state: clip(source.state || 'idle', 24),
    active: source.active === true,
    cooling: source.cooling === true,
    lastAt: num(source.lastAt),
    ageMs: source.ageMs == null ? null : num(source.ageMs),
    toleranceMs: num(source.toleranceMs),
  };
  return { ...body, digest: evidenceDigest(body) };
}

/**
 * 组装 mayAct 证据包：四类来源 + 冲突标记 + digest。
 * @param {{method?:string, at?:number, leases?:Array, controllerGate?:object,
 *          borrowGate?:object, human?:object, allowCooling?:boolean, decision?:object}} input
 */
export function mayActEvidence(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const method = clip(source.method || '', 64);
  const at = num(source.at);
  const leaseStack = leaseStackEvidence(source.leases);
  const controller = controllerGateEvidence(source.controllerGate);
  const borrow = borrowGateEvidence(source.borrowGate);
  const human = humanGateEvidence(source.human);
  const anomalyList = [];
  const addAnomaly = (code, detail = {}) => anomalyList.push({ code, ...detail });
  // 语义冲突只报告：真正拦截仍由 human.exclusive 的既有优先级决定。
  if (borrow.pending && leaseStack.active > 0 && controller.allowed !== false) {
    addAnomaly(COOPERATION_EVIDENCE_CODES.LEASE_PENDING_CONFLICT, { activeLeases: leaseStack.active, borrowStatus: borrow.status });
  }
  if (borrow.status === 'confirmed' && controller.state === 'borrowed' && controller.allowed === false) {
    addAnomaly(COOPERATION_EVIDENCE_CODES.CONTROLLER_BORROW_CONFLICT, { controllerState: controller.state, borrowStatus: borrow.status });
  }
  if (human.active && leaseStack.active > 0 && controller.allowed !== false) {
    addAnomaly(COOPERATION_EVIDENCE_CODES.HUMAN_LEASE_AMBIENT, { activeLeases: leaseStack.active, humanState: human.state });
  }
  const flags = {
    humanActive: human.active === true,
    cooling: human.cooling === true,
    borrowPending: borrow.pending === true,
    controllerHeld: controller.allowed === false,
    leaseAmbient: leaseStack.active > 0,
    allowCooling: source.allowCooling === true,
  };
  const decision = isPlainObject(source.decision) ? {
    allowed: source.decision.allowed === true,
    code: clip(source.decision.code || '', 48),
    source: clip(source.decision.source || '', 24),
  } : null;
  const body = {
    version: COOPERATION_EVIDENCE_VERSION,
    method,
    at,
    humans: human,
    controller,
    borrow,
    leases: leaseStack,
    flags,
    anomalies: anomalyList,
    decision,
  };
  return { ...body, digest: evidenceDigest(body) };
}

/** 校验证据包 digest（忽略 digest 字段本身）。 */
export function verifyMayActEvidence(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, code: COOPERATION_EVIDENCE_CODES.EVIDENCE_MISSING, error: '证据包缺失' };
  }
  const body = { ...bundle };
  delete body.digest;
  const expected = evidenceDigest(body);
  return {
    ok: expected === bundle.digest,
    code: expected === bundle.digest ? null : COOPERATION_EVIDENCE_CODES.EVIDENCE_MISMATCH,
    expected,
    actual: bundle.digest || null,
    method: bundle.method || null,
    anomalies: Array.isArray(bundle.anomalies) ? bundle.anomalies.length : 0,
  };
}

/**
 * mayAct 证据链：previous(上一条证据包或链节) + bundle → 链节（prevDigest + digest）。
 * 同 tab 连续判定形成链，可回答“第 N 次判定当时看到的四类事实是什么”。
 * @param {{digest?:string}|null} previous
 * @param {object} bundle mayActEvidence 的结果
 * @param {{seq?:number, at?:number}} [context]
 */
export function chainMayActEvidence(previous, bundle, context = {}) {
  if (!bundle || typeof bundle !== 'object') return null;
  const prevDigest = previous && (previous.chainDigest || previous.digest) ? (previous.chainDigest || previous.digest) : 'genesis';
  const body = {
    seq: Math.max(1, integer(context.seq, 1)),
    at: num(context.at) || num(bundle.at),
    method: bundle.method || '',
    digest: bundle.digest || '',
    flags: bundle.flags || null,
    anomalies: Array.isArray(bundle.anomalies) ? bundle.anomalies.map((item) => (typeof item === 'string' ? item : (item && item.code))) : [],
    decision: bundle.decision || null,
  };
  return { ...body, prevDigest, chainDigest: evidenceDigest({ prevDigest, body }) };
}

/**
 * 校验 mayAct 证据链：逐条重算 chainDigest，返回第一条不一致的 index。
 * @param {Array} entries
 */
export function verifyMayActChain(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let previous = null;
  for (let index = 0; index < list.length; index += 1) {
    const expected = chainMayActEvidence(previous, {
      digest: list[index].digest,
      method: list[index].method,
      at: list[index].at,
      flags: list[index].flags,
      anomalies: list[index].anomalies,
      decision: list[index].decision,
    }, { seq: list[index].seq, at: list[index].at });
    if (!expected || expected.chainDigest !== list[index].chainDigest) {
      return {
        ok: false,
        code: COOPERATION_EVIDENCE_CODES.EVIDENCE_MISMATCH,
        index,
        expected: list[index].chainDigest,
        actual: expected ? expected.chainDigest : null,
      };
    }
    previous = list[index];
  }
  return { ok: true, code: null, count: list.length, digest: list.length ? list[list.length - 1].chainDigest : 'genesis' };
}

/** 紧凑摘要（挂到 exclusive evidence；体积有界）。 */
export function summarizeMayActEvidence(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  return {
    version: COOPERATION_EVIDENCE_VERSION,
    digest: clip(bundle.digest || '', 16),
    method: clip(bundle.method || '', 64),
    flags: bundle.flags ? {
      humanActive: bundle.flags.humanActive === true,
      cooling: bundle.flags.cooling === true,
      borrowPending: bundle.flags.borrowPending === true,
      leaseAmbient: bundle.flags.leaseAmbient === true,
    } : null,
    leases: bundle.leases ? { active: bundle.leases.active, count: bundle.leases.count, digest: bundle.leases.digest } : null,
    borrow: bundle.borrow ? { present: bundle.borrow.present === true, status: bundle.borrow.status, requestId: bundle.borrow.requestId || '', digest: bundle.borrow.digest } : null,
    controller: bundle.controller ? { present: bundle.controller.present === true, allowed: bundle.controller.allowed !== false, state: bundle.controller.state } : null,
    anomalies: Array.isArray(bundle.anomalies) ? bundle.anomalies.slice(0, 4).map((item) => item.code) : [],
  };
}

/** 一行文本摘要。 */
export function describeMayActEvidence(bundle) {
  if (!bundle || typeof bundle !== 'object') return 'coop-evidence: 无证据';
  const parts = ['method=' + (bundle.method || '-')];
  const flags = isPlainObject(bundle.flags) ? bundle.flags : {};
  if (flags.humanActive) parts.push('human-active');
  if (flags.cooling) parts.push('cooling');
  if (flags.borrowPending) parts.push('borrow-pending');
  if (flags.leaseAmbient) parts.push('leases=' + (bundle.leases ? bundle.leases.active : 0));
  if (Array.isArray(bundle.anomalies) && bundle.anomalies.length) parts.push('anomalies=' + bundle.anomalies.length);
  if (bundle.digest) parts.push('digest=' + bundle.digest);
  return parts.join(' ');
}

/** 只读：把证据包摊平成 CLI 行（有上限）。 */
export function formatMayActEvidence(bundle, options = {}) {
  const maxLines = Math.max(1, integer(options.maxLines, 8));
  if (!bundle || typeof bundle !== 'object') return ['coop-evidence: 无证据'];
  const lines = [describeMayActEvidence(bundle)];
  if (bundle.leases) {
    lines.push('  leases: count=' + bundle.leases.count + ' active=' + bundle.leases.active + ' digest=' + bundle.leases.digest);
  }
  if (bundle.borrow && bundle.borrow.present) lines.push('  borrow: status=' + bundle.borrow.status + ' digest=' + bundle.borrow.digest);
  if (bundle.controller && bundle.controller.present) lines.push('  controller: allowed=' + bundle.controller.allowed + ' state=' + (bundle.controller.state || '-'));
  for (const anomaly of (Array.isArray(bundle.anomalies) ? bundle.anomalies : []).slice(0, Math.max(0, maxLines - lines.length))) {
    lines.push('  anomaly: ' + anomaly.code);
  }
  return lines.slice(0, maxLines);
}
