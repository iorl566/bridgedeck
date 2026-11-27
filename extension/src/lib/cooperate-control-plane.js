// src/lib/cooperate-control-plane.js —— 控制面登记簿 + 既有路径的接线助手（M6 P0③ 第二半）。
//
// cooperate-control.js 是纯函数层（策略/context_id/allow-ask-deny/borrow 超时/handoff 窗口），
// 本文件是它唯一的有状态半边：一张有界的内存登记簿，把既有 cooperate/borrow/borrow-confirm
// 路径的**真实事件**（passthrough 租约签发/释放、借用确认 pending/allow/deny、mayAct 判定）
// 映射成 兼容目标 语义的证据字段（contextId / policy / epoch / owner / decision / handoff 窗口）。
//
// 拆分原因：extension/src 单文件复杂度预算 1100 行（architecture-guards.test.mjs:22）。
// 依赖方向：本文件 → cooperate-control.js / input-lease-kinds.js / control-generation.js，
// 不被这三个模块反向 import（无环）。
//
// 真实消费点（file:line）：
//   extension/src/lib/cooperate.js acquire → controlLeaseEvidence（租约 ↔ context 双向绑定）
//   extension/src/lib/cooperate.js release → controlReleaseEvidence
//   extension/src/lib/cooperate.js mayAct  → controlMayActEvidence（allow/ask/deny + owner + 窗口）
//   extension/src/lib/cooperate.js snapshot → cooperateControlPlane.snapshot
//   extension/src/lib/borrow-confirm.js request/resolve/check/status → borrowControlEvidence
//     经 dispatch.js:499-508（assertBorrowAllowed 错误 data）与 control.js:440-441 输出到 CLI/MCP。

import { evidenceDigest, num, positive, clip, normalizeCooperationTabId } from './input-lease-kinds.js';
import { controlGenerationRecord } from '../control-generation.js';
import {
  CONTROL_POLICY,
  CONTROL_OWNER,
  CONTROL_DECISION,
  CONTROL_ERROR,
  CONTROL_REASON,
  CONTROL_POLICY_RULES,
  CONTROL_EVIDENCE_VERSION,
  normalizeControlPolicy,
  policyRules,
  policyDecision,
  confirmationPlan,
  handoffWindow,
  controlEvidence,
  contextIdentityOf,
  stableContextId,
  contextReusable,
  leaseEpochOf,
  leaseContextBinding,
} from './cooperate-control.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 控制面登记簿（tab → context/policy；token ↔ context 双向映射）
// ---------------------------------------------------------------------------

/**
 * 创建一份有界的控制面登记簿。
 * @param {{now?: () => number, revisionRecord?: (tabId:number) => object, maxTabs?:number,
 *          maxLeases?:number}} [options]
 */
export function createControlPlane(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const revisionRecord = typeof options.revisionRecord === 'function' ? options.revisionRecord : controlGenerationRecord;
  const maxTabs = Math.max(1, Math.floor(positive(options.maxTabs, 256)));
  const maxLeases = Math.max(1, Math.floor(positive(options.maxLeases, 64)));
  const observed = new Map(); // tabId -> {identity, contextId, previousContextId, reused, policy, negotiated, at, consumedAt}
  const policies = new Map(); // tabId -> {policy, source, at, negotiated}
  const leaseByToken = new Map(); // token(full, 内存内) -> binding
  const leasesByContext = new Map(); // contextId -> Map(leaseId -> binding)
  const stats = { observes: 0, contexts: 0, reused: 0, consumptions: 0, bindings: 0, releases: 0, policyNotes: 0, evictions: 0 };

  function evictTabIfNeeded(exclude) {
    if (observed.size < maxTabs && policies.size < maxTabs) return;
    for (const key of observed.keys()) {
      if (key === exclude) continue;
      forget(key);
      stats.evictions += 1;
      return;
    }
  }

  function forget(tabId) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return false;
    const entry = observed.get(id) || null;
    observed.delete(id);
    policies.delete(id);
    if (entry && entry.contextId) {
      const bucket = leasesByContext.get(entry.contextId);
      if (bucket) {
        for (const leaseId of bucket.keys()) {
          for (const [token, binding] of leaseByToken) {
            if (binding.leaseId === leaseId) leaseByToken.delete(token);
          }
        }
        leasesByContext.delete(entry.contextId);
      }
    }
    return true;
  }

  function notePolicy(tabId, policy, meta = {}) {
    const id = normalizeCooperationTabId(tabId);
    const normalized = normalizeControlPolicy(policy);
    if (id == null || !normalized) return null;
    const record = { tabId: id, policy: normalized, source: clip((meta && meta.source) || 'control', 48), at: now(), negotiated: true };
    policies.set(id, record);
    stats.policyNotes += 1;
    return { ...record };
  }

  function policyFor(tabId) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return { tabId: null, policy: CONTROL_POLICY.AUTO, effective: CONTROL_POLICY.TARGET, negotiated: false, source: null };
    const record = policies.get(id) || null;
    const policy = record ? record.policy : CONTROL_POLICY.AUTO;
    return {
      tabId: id,
      policy,
      effective: policy === CONTROL_POLICY.AUTO ? CONTROL_POLICY.TARGET : policy,
      negotiated: record != null,
      source: record ? record.source : null,
      at: record ? record.at : 0,
    };
  }

  function isNegotiated(tabId) {
    const id = normalizeCooperationTabId(tabId);
    return id != null && policies.has(id);
  }

  function isConsumed(tabId) {
    const id = normalizeCooperationTabId(tabId);
    const entry = id == null ? null : observed.get(id);
    return Boolean(entry && entry.consumedAt > 0);
  }

  /** 观察一次控制上下文：刷新 identity/contextId（有界；不写任何真实控制状态）。 */
  function observe(tabId, input = {}) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return null;
    const source = isPlainObject(input) ? input : {};
    const previous = observed.get(id) || null;
    const identity = contextIdentityOf(id, source.record || revisionRecord(id), source);
    if (!identity) return null;
    const policyInfo = policyFor(id);
    const policy = normalizeControlPolicy(source.policy) || policyInfo.policy;
    const reusable = previous ? contextReusable(previous.identity, identity, policy) : false;
    const contextId = previous && reusable ? previous.contextId : stableContextId(identity);
    // strict 单次消费只在“真正 sync”（source.sync===true）或上下文换代时复位；
    // mayAct/acquire 这类动作前探测不得把已消费状态洗掉。
    const sameContext = Boolean(previous && previous.contextId === contextId);
    const consumedAt = sameContext && source.sync !== true ? previous.consumedAt : 0;
    const changed = previous ? !reusable && previous.contextId !== contextId : false;
    const entry = {
      tabId: id,
      identity,
      contextId,
      previousContextId: previous ? previous.contextId : null,
      reused: Boolean(previous && reusable),
      changed,
      policy,
      negotiated: policyInfo.negotiated,
      at: now(),
      consumedAt,
    };
    if (!previous || previous.contextId !== contextId) stats.contexts += 1;
    if (entry.reused) stats.reused += 1;
    stats.observes += 1;
    observed.set(id, entry);
    evictTabIfNeeded(id);
    return entry;
  }

  /** strict 单次消费：标记当前 context 已被一次动作消费（下一次动作必须重新 sync）。 */
  function consumeContext(tabId) {
    const entry = observed.get(normalizeCooperationTabId(tabId));
    if (!entry) return null;
    const record = policies.get(entry.tabId);
    const policy = record ? record.policy : entry.policy;
    entry.consumedAt = now();
    stats.consumptions += 1;
    return { tabId: entry.tabId, contextId: entry.contextId, policy, consumedAt: entry.consumedAt, singleUse: policy === CONTROL_POLICY.STRICT };
  }

  function resetConsumed(tabId) {
    const entry = observed.get(normalizeCooperationTabId(tabId));
    if (!entry) return false;
    entry.consumedAt = 0;
    return true;
  }

  function bindLease(input = {}) {
    const source = isPlainObject(input) ? input : {};
    const id = normalizeCooperationTabId(source.tabId);
    const token = typeof source.token === 'string' ? source.token : '';
    if (id == null || !token) return null;
    if (leaseByToken.size >= maxLeases) {
      const oldest = leaseByToken.keys().next().value;
      if (oldest !== undefined) leaseByToken.delete(oldest);
    }
    const entry = observed.get(id) || observe(id, { record: source.record, policy: source.policy });
    if (!entry) return null;
    const binding = leaseContextBinding({
      tabId: id,
      contextId: source.contextId || entry.contextId,
      token,
      leaseId: source.leaseId,
      epoch: source.epoch || entry.identity,
      policy: normalizeControlPolicy(source.policy) || entry.policy,
      at: num(source.at) || now(),
    });
    if (!binding) return null;
    const full = { ...binding };
    leaseByToken.set(token, full);
    const bucket = leasesByContext.get(full.contextId) || new Map();
    bucket.set(full.leaseId || ('lease-' + leaseByToken.size), full);
    leasesByContext.set(full.contextId, bucket);
    stats.bindings += 1;
    return full;
  }

  function releaseLease(token) {
    const key = typeof token === 'string' ? token : '';
    const binding = key ? leaseByToken.get(key) : null;
    if (!binding) return null;
    leaseByToken.delete(key);
    const bucket = leasesByContext.get(binding.contextId);
    if (bucket && binding.leaseId) bucket.delete(binding.leaseId);
    stats.releases += 1;
    return binding;
  }

  function contextForToken(token) {
    const key = typeof token === 'string' ? token : '';
    const binding = key ? leaseByToken.get(key) : null;
    if (!binding) return null;
    return { contextId: binding.contextId, epoch: binding.epoch, leaseId: binding.leaseId, tabId: binding.tabId, token: binding.token, active: true };
  }

  function tokensForContext(contextId) {
    const key = contextId == null ? '' : String(contextId);
    const bucket = key ? leasesByContext.get(key) : null;
    if (!bucket) return [];
    return [...bucket.values()].map((binding) => ({ token: binding.token, leaseId: binding.leaseId, epoch: binding.epoch, active: true }));
  }

  /** tab 的控制面快照（只读）：contextId/policy/owner/epoch + 活跃 token 映射。 */
  function snapshot(tabId) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return null;
    const entry = observed.get(id) || observe(id);
    if (!entry) return null;
    const policyInfo = policyFor(id);
    const effective = policyInfo.effective;
    const rules = policyRules(effective) || CONTROL_POLICY_RULES[CONTROL_POLICY.TARGET];
    const consumed = entry.consumedAt > 0;
    const owner = consumed ? CONTROL_OWNER.HUMAN : rules.owner;
    const body = {
      version: CONTROL_EVIDENCE_VERSION,
      tabId: id,
      contextId: entry.contextId,
      previousContextId: entry.previousContextId,
      reused: entry.reused,
      policy: policyInfo.policy,
      effectivePolicy: effective,
      negotiated: policyInfo.negotiated,
      owner,
      epoch: entry.identity.epoch,
      frameEpoch: entry.identity.frameEpoch,
      generation: entry.identity.generation,
      revision: entry.identity.revision,
      documentId: entry.identity.documentId,
      documentEpoch: entry.identity.documentEpoch,
      consumed,
      consumedAt: entry.consumedAt,
      singleUse: rules.singleUseContext,
      requiresContext: rules.requiresContext,
      leases: tokensForContext(entry.contextId),
      at: now(),
      identityDigest: entry.identity.digest,
    };
    return { ...body, digest: evidenceDigest(body) };
  }

  function counters() {
    return { ...stats, tabs: observed.size, policies: policies.size, leaseTokens: leaseByToken.size, contexts: leasesByContext.size };
  }

  function reset() {
    const cleared = observed.size;
    observed.clear();
    policies.clear();
    leaseByToken.clear();
    leasesByContext.clear();
    return { ok: true, cleared };
  }

  return {
    observe,
    policyFor,
    notePolicy,
    isNegotiated,
    consumeContext,
    resetConsumed,
    isConsumed,
    bindLease,
    releaseLease,
    contextForToken,
    tokensForContext,
    snapshot,
    forget,
    counters,
    reset,
    get maxTabs() { return maxTabs; },
    get maxLeases() { return maxLeases; },
  };
}

/** 后台共享登记簿：cooperate.js 的租约、borrow-confirm 的确认窗口共用同一份上下文映射。 */
export const cooperateControlPlane = createControlPlane();

// ---------------------------------------------------------------------------
// 既有路径的接线助手（函数名即调用点，返回“条件证据块”）
// ---------------------------------------------------------------------------

/**
 * cooperate.acquire 的条件证据：租约 ↔ context 双向绑定 + contextId/policy/epoch。
 * 真实消费：extension/src/lib/cooperate.js 的 acquire 证据对象。
 */
export function controlLeaseEvidence(plane, input = {}) {
  const target = plane && typeof plane.bindLease === 'function' ? plane : cooperateControlPlane;
  const source = isPlainObject(input) ? input : {};
  const id = normalizeCooperationTabId(source.tabId);
  if (id == null) return null;
  const policyInfo = target.policyFor(id);
  const policy = normalizeControlPolicy(source.policy) || policyInfo.policy;
  const binding = target.bindLease({
    tabId: id,
    token: source.token,
    leaseId: source.leaseId,
    record: source.record,
    policy,
    contextId: source.contextId,
    epoch: source.record,
    at: source.at,
  });
  if (!binding) return null;
  return controlEvidence({
    contextId: binding.contextId,
    policy,
    epoch: binding.epoch,
    owner: CONTROL_OWNER.AGENT,
    decision: CONTROL_DECISION.ALLOW,
    reason: CONTROL_REASON.POLICY_ALLOWS,
    negotiated: policyInfo.negotiated,
    binding,
    singleUse: (policyRules(policy) || {}).singleUseContext === true,
    requiresContext: (policyRules(policy) || {}).requiresContext === true,
    at: binding.at,
    source: 'lease',
  });
}

/**
 * cooperate.release 的条件证据：解绑 token↔context 并回放绑定事实。
 * 真实消费：cooperate.js 的 release 证据对象。
 */
export function controlReleaseEvidence(plane, token, input = {}) {
  const target = plane && typeof plane.releaseLease === 'function' ? plane : cooperateControlPlane;
  const source = isPlainObject(input) ? input : {};
  const binding = target.releaseLease(token);
  if (!binding) return null;
  const at = num(source.at) || Date.now();
  return controlEvidence({
    contextId: binding.contextId,
    policy: binding.policy || (normalizeControlPolicy(source.policy) || undefined),
    epoch: binding.epoch,
    owner: CONTROL_OWNER.AGENT,
    decision: CONTROL_DECISION.ALLOW,
    reason: 'lease-released',
    negotiated: target.isNegotiated ? target.isNegotiated(binding.tabId) : undefined,
    binding: { ...binding, releasedAt: at, heldMs: binding.at > 0 ? Math.max(0, at - binding.at) : 0 },
    at,
    source: 'lease-release',
  });
}

/**
 * cooperate.mayAct 的条件证据：控制面判定（allow/ask/deny + owner + handoff 窗口）。
 * 真实消费：cooperate.js 的 mayAct 证据对象（旧 allowed/code/state 完全不变）。
 */
export function controlMayActEvidence(plane, input = {}) {
  const target = plane && typeof plane.observe === 'function' ? plane : cooperateControlPlane;
  const source = isPlainObject(input) ? input : {};
  const id = normalizeCooperationTabId(source.tabId);
  if (id == null) return null;
  const policyInfo = target.policyFor(id);
  const entry = target.observe(id, { record: source.record, policy: source.policy });
  if (!entry) return null;
  const policy = normalizeControlPolicy(source.policy) || policyInfo.policy;
  const borrowGate = isPlainObject(source.borrowGate) ? source.borrowGate : null;
  const borrow = borrowGate && isPlainObject(borrowGate.evidence)
    ? { status: borrowGate.status || borrowGate.evidence.status || (borrowGate.pending === true ? 'pending' : null), pending: borrowGate.pending === true, timeoutMs: borrowGate.evidence.timeoutMs, requestedAt: borrowGate.evidence.requestedAt }
    : null;
  const window = handoffWindow({
    controller: source.controller,
    policy,
    contextId: entry.contextId,
    epoch: entry.identity.epoch,
    borrow,
    now: source.now,
    timeoutMs: source.timeoutMs,
  });
  const decision = policyDecision({
    policy,
    sessionPolicy: policyInfo.policy === CONTROL_POLICY.AUTO && !policyInfo.negotiated ? null : policyInfo.policy,
    defaultPolicy: source.defaultPolicy,
    negotiated: policyInfo.negotiated,
    action: source.action,
    passive: source.passive,
    acknowledged: source.acknowledged,
    contextId: source.contextId || entry.contextId,
    currentContextId: source.currentContextId || entry.contextId,
    contextConsumed: target.isConsumed ? target.isConsumed(id) : false,
    observationRequired: source.observationRequired,
    observationConsumed: source.observationConsumed,
    humanActive: source.humanActive === true || window.owner === CONTROL_OWNER.HUMAN && window.state === 'human',
    borrow,
    at: source.now,
  });
  // strict 的单次消费语义：判定为 allow 的 guarded 动作之后，该 context 视为已消费。
  if (decision.decision === CONTROL_DECISION.ALLOW && (policyRules(policy) || {}).singleUseContext === true && source.passive !== true) {
    target.consumeContext(id);
  }
  const rules = policyRules(policy) || CONTROL_POLICY_RULES[CONTROL_POLICY.TARGET];
  const evidence = decision.evidence ? { ...decision.evidence } : controlEvidence({ contextId: entry.contextId, policy, epoch: entry.identity.epoch });
  if (evidence) {
    evidence.decision = decision.decision;
    evidence.owner = decision.owner;
    evidence.singleUse = rules.singleUseContext === true;
    evidence.requiresContext = rules.requiresContext === true;
    if (decision.code) evidence.code = decision.code;
    if (decision.reason) evidence.reason = decision.reason;
    if (window) evidence.window = { state: window.state, owner: window.owner, openedAt: window.openedAt, closesAt: window.closesAt, widthMs: window.widthMs, remainingMs: window.remainingMs, expired: window.expired };
  }
  return evidence;
}

/**
 * borrow-confirm 的条件证据：确认窗口 + handoff 窗口 + policy/context/epoch。
 * 真实消费：borrow-confirm.request/resolve/cancel/check/status 的证据字段，
 * 经 dispatch.js:499-508（assertBorrowAllowed → 错误 data）与 control.js:440-441 输出。
 */
export function borrowControlEvidence(plane, input = {}) {
  const target = plane && typeof plane.observe === 'function' ? plane : cooperateControlPlane;
  const source = isPlainObject(input) ? input : {};
  const id = normalizeCooperationTabId(source.tabId);
  if (id == null) return null;
  const policyInfo = target.policyFor(id);
  const policy = normalizeControlPolicy(source.policy) || policyInfo.policy;
  const entry = target.observe(id, { record: source.record, policy });
  if (!entry) return null;
  const plan = confirmationPlan({
    timeoutMs: source.timeoutMs,
    requestedAt: source.requestedAt,
    now: source.now,
    noConfirm: source.noConfirm,
    confirmationRequired: source.confirmationRequired,
    policy,
    contextId: entry.contextId,
    epoch: entry.identity.epoch,
    negotiated: policyInfo.negotiated,
  });
  const status = clip(source.status || 'pending', 24);
  const pending = status === 'pending' || status === '';
  const decision = pending
    ? policyDecision({
      policy,
      sessionPolicy: policyInfo.policy === CONTROL_POLICY.AUTO && !policyInfo.negotiated ? null : policyInfo.policy,
      negotiated: policyInfo.negotiated,
      contextId: entry.contextId,
      currentContextId: entry.contextId,
      borrow: { status, pending: true, timeoutMs: plan.timeoutMs, requestedAt: plan.requestedAt },
      at: source.now,
    })
    : status === 'confirmed'
      ? policyDecision({
        policy,
        sessionPolicy: policyInfo.policy === CONTROL_POLICY.AUTO && !policyInfo.negotiated ? null : policyInfo.policy,
        negotiated: policyInfo.negotiated,
        contextId: entry.contextId,
        currentContextId: entry.contextId,
        at: source.now,
      })
      : {
        decision: CONTROL_DECISION.DENY,
        owner: CONTROL_OWNER.HUMAN,
        policy,
        requestedPolicy: null,
        negotiated: policyInfo.negotiated,
        code: status === 'timeout' ? CONTROL_ERROR.BORROW_TIMEOUT : 'E_BORROW_DENIED',
        reason: 'borrow-' + status,
        evidence: null,
      };
  const window = handoffWindow({
    controller: source.controller || (source.status === 'pending' ? 'handoff' : undefined),
    borrow: { status: source.status || 'pending', requestedAt: plan.requestedAt, timeoutMs: plan.timeoutMs },
    policy,
    contextId: entry.contextId,
    epoch: entry.identity.epoch,
    now: source.now,
  });
  const base = {
    contextId: entry.contextId,
    policy,
    epoch: entry.identity.epoch,
    owner: decision.owner,
    decision: decision.decision,
    code: decision.code,
    reason: decision.reason,
    negotiated: policyInfo.negotiated,
    timeoutMs: plan.timeoutMs,
    deadlineAt: plan.deadlineAt,
    at: source.now,
    source: clip(source.source || 'borrow', 32),
    window: { state: window.state, owner: window.owner, openedAt: window.openedAt, closesAt: window.closesAt, widthMs: window.widthMs, remainingMs: window.remainingMs, expired: window.expired },
  };
  const evidence = controlEvidence(base);
  if (!evidence) return null;
  evidence.confirmation = {
    timeoutMs: plan.timeoutMs,
    defaultTimeoutMs: plan.defaultTimeoutMs,
    clamped: plan.clamped,
    deadlineAt: plan.deadlineAt,
    remainingMs: plan.remainingMs,
    expired: plan.expired,
    onTimeout: plan.onTimeout,
    timeoutCode: plan.timeoutCode,
    noConfirm: plan.noConfirm,
    deprecatedFlag: plan.noConfirm.deprecated,
    decidedBy: plan.noConfirm.decidedBy,
  };
  evidence.timeout = { widthMs: plan.timeoutMs, remainingMs: plan.remainingMs, expired: plan.expired };
  return evidence;
}
