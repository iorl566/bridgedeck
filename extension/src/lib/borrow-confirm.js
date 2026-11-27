// src/lib/borrow-confirm.js —— 借用确认闸门：确认前禁用动作，确认后才放行。
//
// 借用用户标签页前必须由用户在页面浮层/Toast 上点「允许」。0.3.0 的确认流程只在
// tabs-borrow.js 里等一个 Promise：等待期间如果另一个命令（并行会话、queued plan
// 步骤、用户从 CLI 直接下发的动作）打到同一个 tab，就会在“未确认”状态下动用户
// 的页面——这正是借用确认要防的事。本模块把确认状态变成显式闸门：
//
//   request  记录一次待确认请求（进入 controller handoff 态）
//   resolve  用户决定：allow → confirmed；deny/timeout → 终态
//   check    动作前查询：pending 时拒绝并给出证据（E_BORROW_CONFLICT，
//            “同一标签页已被其他会话借用或正在确认中”）
//   clear    确认流程结束、tab.return、tab 关闭时清掉记录
//
// 闸门只拦“动作”类方法（dispatch 用 TAB_METHODS 判断），不会拦 tab.borrow 自己、
// 状态读取或截图诊断。deny/timeout 是终态：被拒绝的借用不会因为残留记录而阻塞
// 后续已授权的动作（记录在 tab.borrow 的 finally 里被 clear）。

import { controllerState, transitionBumps } from './controller-state.js';
import { bumpRevisions } from '../control-generation.js';
// 【第十批接线】借用旅程证据链 + 工具栏视图证据：只记录、只附加字段，不改变任何判定。
//   borrow.js   —— 把 request/resolve/cancel/clear 的真实事件串成带哈希链的证据闭环；
//   toolbar.js  —— 在“确认未完成”拦截时附上用户此刻看到的动作/焦点（toolbarEvidence）。
import { borrowJourneys } from './borrow.js';
import { toolbarBlockedEvidence } from './toolbar.js';
// 【M6 P0③】控制面语义对齐：context_id / control_policy / allow-ask-deny / 交接窗口 /
// borrow 确认超时（兼容目标 cooperate.rs + compatibility.rs + tab borrow --timeout 映射）。
// 只做条件附加证据：沿用本文件既有 allowed/status 判定，任何旁路异常都回退到旧结构。
import { cooperateControlPlane, borrowControlEvidence } from './cooperate-control-plane.js';
// 【第十一批接线】借用证据链第二轮：snapshot 里附带多来源相关摘要（journey/gate/controller/
// 租约/human 链的 digest 与语义冲突）。只读旁路，失败就省略字段，不影响任何判定。
import { borrowEvidenceLinks } from './borrow-evidence-chain.js';

export const BORROW_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DENIED: 'denied',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
});

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_HISTORY = 32;

/**
 * 把借用闸门的真实事件通知给 borrow.js 的证据链。
 * 证据记录失败绝不能影响借用流程，因此这里吞掉一切异常（默认行为不变）。
 */
function notifyJourney(event) {
  try {
    borrowJourneys.observeGateEvent(event);
  } catch {
    // 证据链是旁路：不打断借用确认。
  }
}

/** 把 controller 迁移声明的 bumps 落到 revision-chain（四项计数的唯一写入口）。 */
function applyTransitionBumps(tabId, moved) {
  const delta = transitionBumps(moved);
  return Object.keys(delta).length ? bumpRevisions(tabId, delta) : null;
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeTabId(tabId) {
  // null/''/非数字都不是合法 tabId（Number(null)===0 会把“没传”误判成 tab 0）。
  if (tabId == null || tabId === '') return null;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : null;
}

function summarize(record) {
  if (!record) return null;
  return {
    tabId: record.tabId,
    requestId: record.requestId,
    status: record.status,
    requestedAt: record.requestedAt,
    resolvedAt: record.resolvedAt,
    timeoutMs: record.timeoutMs,
    decision: record.decision,
    surface: record.surface,
    windowId: record.windowId,
    title: record.title,
    pendingMs: record.resolvedAt ? Math.max(0, record.resolvedAt - record.requestedAt) : null,
  };
}

/**
 * 创建独立的借用确认闸门（时钟可注入，便于单测）。
 * @param {{now?: () => number, historyLimit?: number}} [options]
 */
export function createBorrowGate(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const historyLimit = Number.isInteger(options.historyLimit) && options.historyLimit > 0 ? options.historyLimit : DEFAULT_HISTORY;
  const control = options.control && typeof options.control.observe === 'function' ? options.control : cooperateControlPlane;
  const byTab = new Map(); // tabId -> record
  const byRequest = new Map(); // requestId -> record
  const history = [];
  const stats = { requested: 0, confirmed: 0, denied: 0, timeout: 0, cancelled: 0, blocked: 0, allowed: 0 };
  // 【M6 P0③】控制面条件证据：失败一律回退 null（旧结构逐字节不变）。
  function controlFacts(tabId, facts = {}) {
    try {
      return borrowControlEvidence(control, { tabId, ...facts });
    } catch {
      return null;
    }
  }

  function remember(record) {
    history.push({ ...summarize(record) });
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
  }

  function forget(tabId) {
    const id = normalizeTabId(tabId);
    if (id == null) return false;
    const record = byTab.get(id);
    if (!record) return false;
    byTab.delete(id);
    byRequest.delete(record.requestId);
    return true;
  }

  /**
   * 登记一次待确认借用。同一 tab 重复请求返回 duplicate（不覆盖 requestId）。
   * @param {number} tabId
   * @param {{requestId?: string, timeoutMs?: number, windowId?: number, title?: string, surface?: string}} [request]
   */
  function request(tabId, requestInput = {}) {
    const id = normalizeTabId(tabId);
    if (id == null) {
      return { ok: false, code: 'E_BAD_ARG', error: 'borrow.request 需要整数 tabId', evidence: { tabId: null } };
    }
    const existing = byTab.get(id);
    if (existing && existing.status === BORROW_STATUS.PENDING) {
      return { ok: true, duplicate: true, requestId: existing.requestId, status: existing.status, record: summarize(existing), evidence: { tabId: id, requestId: existing.requestId, status: existing.status, duplicate: true } };
    }
    const requestId = typeof requestInput.requestId === 'string' && requestInput.requestId
      ? requestInput.requestId
      : 'borrow-' + id + '-' + now().toString(36);
    const record = {
      tabId: id,
      requestId,
      status: BORROW_STATUS.PENDING,
      requestedAt: now(),
      resolvedAt: 0,
      timeoutMs: Number(requestInput.timeoutMs) > 0 ? Number(requestInput.timeoutMs) : DEFAULT_TIMEOUT_MS,
      windowId: Number.isInteger(Number(requestInput.windowId)) ? Number(requestInput.windowId) : null,
      title: String(requestInput.title || '').slice(0, 200),
      surface: requestInput.surface == null ? null : String(requestInput.surface),
      decision: null,
    };
    byTab.set(id, record);
    byRequest.set(requestId, record);
    stats.requested += 1;
    remember(record);
    // 借用确认是 handoff（控制权交接中）：idle/agent/human 都能进入，但必须带 requestId。
    const moved = controllerState.transition(id, 'borrow.request', { requestId, source: 'tab.borrow' });
    if (moved && moved.ok) applyTransitionBumps(id, moved);
    notifyJourney({ type: 'request', tabId: id, requestId, title: record.title, windowId: record.windowId, timeoutMs: record.timeoutMs, at: record.requestedAt });
    // 【M6 P0③】条件附加：contextId/policy/epoch + 确认窗口/handoff 窗口（无控制面事实时省略）。
    const controlEvidence = controlFacts(id, { status: record.status, requestedAt: record.requestedAt, timeoutMs: record.timeoutMs, controller: 'handoff', source: 'tab.borrow', now: record.requestedAt });
    const controlFields = controlEvidence ? { control: controlEvidence, contextId: controlEvidence.contextId, policy: controlEvidence.policy, epoch: controlEvidence.epoch } : {};
    return {
      ok: true,
      duplicate: false,
      requestId,
      status: record.status,
      ...controlFields,
      record: summarize(record),
      controller: moved && moved.ok ? { from: moved.from, to: moved.to, evidence: moved.evidence } : { from: null, to: null, evidence: moved && moved.evidence },
      evidence: { tabId: id, requestId, status: record.status, requestedAt: record.requestedAt, timeoutMs: record.timeoutMs, source: 'tab.borrow', ...(controlEvidence ? { control: controlEvidence } : {}) },
    };
  }

  /**
   * 用户决定：allow 才算确认。返回 { ok, allowed } 与证据；未知 requestId 不改变状态。
   * @param {string} requestId
   * @param {{decision?: string, allow?: boolean}} [answer]
   */
  function resolve(requestId, answerInput = {}) {
    const id = typeof requestId === 'string' ? requestId : '';
    const record = id ? byRequest.get(id) : null;
    if (!record) {
      return { ok: false, code: 'E_BORROW_CONFLICT', error: '没有匹配的借用确认请求（可能已超时/已清理）', evidence: { requestId: id || null, source: 'borrow.resolve' } };
    }
    if (record.status !== BORROW_STATUS.PENDING) {
      return { ok: true, duplicate: true, allowed: record.status === BORROW_STATUS.CONFIRMED, status: record.status, record: summarize(record), evidence: { requestId: id, status: record.status, duplicate: true } };
    }
    const decision = answerInput.decision != null
      ? String(answerInput.decision)
      : (answerInput.allow === true ? 'allow' : 'deny');
    const allowed = decision === 'allow' && answerInput.allow !== false;
    const status = allowed ? BORROW_STATUS.CONFIRMED : decision === 'timeout' ? BORROW_STATUS.TIMEOUT : BORROW_STATUS.DENIED;
    record.status = status;
    record.decision = decision;
    record.resolvedAt = now();
    notifyJourney({ type: 'resolve', tabId: record.tabId, requestId: id, status, decision, at: record.resolvedAt });
    const controlEvidence = controlFacts(record.tabId, { status, decision, requestedAt: record.requestedAt, timeoutMs: record.timeoutMs, controller: allowed ? 'borrowed' : 'idle', source: 'borrow.resolve', now: record.resolvedAt });
    const controlFields = controlEvidence ? { control: controlEvidence, contextId: controlEvidence.contextId, policy: controlEvidence.policy, epoch: controlEvidence.epoch } : {};
    if (allowed) {
      stats.confirmed += 1;
      const moved = controllerState.transition(record.tabId, 'borrow.confirm', { confirmed: true, requestId: id, decision, source: 'borrow.resolve' });
      if (moved && moved.ok) applyTransitionBumps(record.tabId, moved);
      remember(record);
      return { ok: true, allowed: true, status, ...controlFields, record: summarize(record), evidence: { tabId: record.tabId, requestId: id, decision, status, confirmedAt: record.resolvedAt, ...(controlEvidence ? { control: controlEvidence } : {}) } };
    }
    if (status === BORROW_STATUS.TIMEOUT) stats.timeout += 1;
    else stats.denied += 1;
    const rejected = controllerState.transition(record.tabId, 'borrow.deny', { requestId: id, decision, source: 'borrow.resolve' });
    if (rejected && rejected.ok) applyTransitionBumps(record.tabId, rejected);
    remember(record);
    return {
      ok: true,
      allowed: false,
      status,
      ...controlFields,
      code: status === BORROW_STATUS.TIMEOUT ? 'E_BORROW_TIMEOUT' : 'E_BORROW_DENIED',
      record: summarize(record),
      evidence: { tabId: record.tabId, requestId: id, decision, status, resolvedAt: record.resolvedAt, timeoutMs: record.timeoutMs, ...(controlEvidence ? { control: controlEvidence } : {}) },
    };
  }

  /** 撤回一次待确认请求（用户关闭浮层、tab 关闭、流程异常）。 */
  function cancel(tabId, reason = 'cancelled') {
    const id = normalizeTabId(tabId);
    const record = id == null ? null : byTab.get(id);
    if (!record || record.status !== BORROW_STATUS.PENDING) {
      return { ok: true, cancelled: false, evidence: { tabId: id, reason, found: Boolean(record), status: record ? record.status : BORROW_STATUS.NONE } };
    }
    record.status = BORROW_STATUS.CANCELLED;
    record.decision = 'cancel';
    record.resolvedAt = now();
    stats.cancelled += 1;
    remember(record);
    notifyJourney({ type: 'cancel', tabId: id, requestId: record.requestId, reason, at: record.resolvedAt });
    const moved = controllerState.transition(id, 'handoff.abort', { requestId: record.requestId, reason, source: 'borrow.cancel' });
    if (moved && moved.ok) applyTransitionBumps(id, moved);
    return { ok: true, cancelled: true, record: summarize(record), evidence: { tabId: id, requestId: record.requestId, reason, at: record.resolvedAt } };
  }

  /** 清掉记录（借用流程 finally / tab.return / tab 关闭）。 */
  function clear(tabId) {
    const id = normalizeTabId(tabId);
    const record = id == null ? null : byTab.get(id);
    let cancelled = false;
    if (record && record.status === BORROW_STATUS.PENDING) {
      // 流程异常时仍有 pending：先走 cancel 迁移，避免 controller 卡在 handoff。
      cancel(id, 'clear-pending');
      cancelled = true;
    }
    const cleared = forget(id);
    notifyJourney({ type: 'clear', tabId: id, reason: 'borrow.clear', at: now() });
    return { ok: true, cleared, cancelled, status: record ? record.status : BORROW_STATUS.NONE };
  }

  function status(tabId) {
    const id = normalizeTabId(tabId);
    const record = id == null ? null : byTab.get(id);
    if (!record) return null;
    const value = { ...summarize(record), expired: record.status === BORROW_STATUS.PENDING && now() - record.requestedAt > record.timeoutMs };
    // 【第十批接线】条件附加字段：借用旅程证据链位置（没有旅程记录时输出与 0.3.0 完全一致）。
    try {
      const journey = borrowJourneys.journey(id);
      if (journey) value.journey = journey;
      // 【M6 P0③】条件附加：contextId/policy/epoch + handoff 窗口（没有旅程/控制面事实时省略）。
      if (journey) {
        const controlEvidence = controlFacts(id, { status: record.status, requestedAt: record.requestedAt, timeoutMs: record.timeoutMs, controller: controllerState.get(id), source: 'borrow.status' });
        if (controlEvidence) value.control = controlEvidence;
      }
    } catch {
      // 旁路：旅程证据不可读不影响闸门状态。
    }
    return value;
  }

  /**
   * 动作闸门：pending 期间拒绝动作并给证据；其余状态放行。
   * @param {number} tabId
   * @param {string} method
   */
  function check(tabId, method = '') {
    const id = normalizeTabId(tabId);
    const record = id == null ? null : byTab.get(id);
    if (!record || record.status !== BORROW_STATUS.PENDING) {
      stats.allowed += 1;
      return { allowed: true, code: null, status: record ? record.status : BORROW_STATUS.NONE, evidence: { tabId: id, method, status: record ? record.status : BORROW_STATUS.NONE } };
    }
    stats.blocked += 1;
    const pendingMs = Math.max(0, now() - record.requestedAt);
    const expired = pendingMs > record.timeoutMs;
    // 【第十批接线】条件附加（新字段）：把“用户此刻看到的工具栏动作/焦点”和“借用旅程
    // 证据链位置”附在拦截证据里。判定（allowed/code/status）与 0.3.0 完全一致；
    // 旁路读取失败就当作没有这两个字段，绝不影响拦截本身。
    let toolbar = null;
    let journey = null;
    try {
      borrowJourneys.noteBlockedCheck(id, { method, pendingMs, at: now() });
      toolbar = toolbarBlockedEvidence(id, {
        borrow: {
          status: record.status,
          requestId: record.requestId,
          requestedAt: record.requestedAt,
          timeoutMs: record.timeoutMs,
          surface: record.surface,
          windowId: record.windowId,
          title: record.title,
          pendingMs,
        },
      });
      const current = borrowJourneys.journey(id);
      journey = current
        ? {
          state: current.state,
          requestId: current.requestId,
          decision: current.decision,
          surface: current.surface,
          requestedAt: current.requestedAt,
          entryCount: current.entryCount,
          blockedChecks: current.checkBlocked,
        }
        : null;
    } catch {
      // 旁路证据不可用：保持 0.3.0 的拦截证据结构。
    }
    const evidence = {
      tabId: id,
      method,
      requestId: record.requestId,
      status: record.status,
      requestedAt: record.requestedAt,
      pendingMs,
      timeoutMs: record.timeoutMs,
      expired,
      windowId: record.windowId,
      title: record.title,
      allowedAfter: 'borrow.confirm',
      hint: '借用确认未完成：等用户点「允许」，或在超时后重新 tab.borrow',
    };
    if (toolbar) evidence.toolbar = toolbar;
    if (journey) evidence.journey = journey;
    // 【M6 P0③】控制面证据：allow-ask-deny + owner + contextId/policy/epoch + 确认窗口。
    // 真实消费：dispatch.js:499-508（assertBorrowAllowed 错误 data）与 control.js:440-441。
    const controlEvidence = controlFacts(id, { status: record.status, requestedAt: record.requestedAt, timeoutMs: record.timeoutMs, controller: 'handoff', source: 'borrow.check', now: now() });
    if (controlEvidence) evidence.control = controlEvidence;
    return {
      allowed: false,
      code: 'E_BORROW_CONFLICT',
      status: record.status,
      evidence,
    };
  }

  function list() {
    return [...byTab.values()].map(summarize);
  }

  function pending() {
    return [...byTab.values()].filter((record) => record.status === BORROW_STATUS.PENDING).map(summarize);
  }

  function snapshot(tabId) {
    const id = normalizeTabId(tabId);
    const statusValue = status(tabId);
    const base = { status: statusValue, pending: pending(), history: history.slice(-8), counters: counters() };
    // 【第十一批接线】多来源证据相关摘要：只增加 evidenceLinks 字段；没有旅程/证据时省略。
    if (id != null) {
      try {
        if (statusValue || borrowJourneys.journey(id)) {
          base.evidenceLinks = borrowEvidenceLinks({
            tabId: id,
            status: statusValue,
            journey: borrowJourneys.journey(id),
            sealed: borrowJourneys.evidence(id),
            controller: controllerState.get(id),
            control: controlFacts(id, { status: statusValue && statusValue.status, requestedAt: statusValue && statusValue.requestedAt, timeoutMs: statusValue && statusValue.timeoutMs, controller: controllerState.get(id), source: 'borrow.snapshot' }),
            at: now(),
          });
        }
      } catch {
        // 旁路：证据链不可读不影响闸门快照。
      }
    }
    return base;
  }

  function historyOf() {
    return history.slice();
  }

  function counters() {
    return { ...stats, live: byTab.size };
  }

  function reset() {
    const cleared = byTab.size;
    byTab.clear();
    byRequest.clear();
    return { ok: true, cleared };
  }

  return { request, resolve, cancel, clear, check, status, list, pending, snapshot, history: historyOf, counters, reset };
}

/** 后台共享单例：tabs-borrow 登记/结算，dispatch 每动作前查询。 */
export const borrowGate = createBorrowGate();

// 【第十批接线】把单例交给 borrow.js 的旅程账本（只注入引用，不反向依赖）：
// 之后 tabs-borrow → borrowGate.request/resolve/cancel/clear 的真实事件都会进入证据链。
try {
  borrowJourneys.bindGate(borrowGate);
} catch {
  // 绑定失败只意味着少一份旁路证据，闸门行为不变。
}
