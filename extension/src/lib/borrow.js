// src/lib/borrow.js —— 借用确认与交还的证据闭环（human gate / borrow journey）。
//
// 0.3.0 的借用流程是“一个 Promise”：
//   tabs-borrow.js 生成 requestId → 注入模态/Toast → waitHumanDecision → borrowGate.resolve
//   → controller 推到 borrowed → 写 controlledTabs。
// 确认之后发生的事只留下零散状态：controlledTabs 里一个 id、controller 的一个状态、
// borrowGate 的一条记录。真实故障排查时无法回答这四个问题：
//   1. 用户到底看没看到确认界面？（surface=modal/toast、什么时候渲染的）
//   2. 用户是“允许/拒绝/超时”哪一种？决定前等了多久？
//   3. 确认后 Agent 真的开始动作了吗？用了哪些 passthrough 租约？
//   4. 交还（tab.return / 关闭）时，租约、浮层、controller 都干净了吗？
//
// 本模块把一次借用从请求到交还封成一条**带哈希链的证据链**：
//
//   begin ─▶ requested ─▶ presented ─▶ decided(allow/deny/timeout) ─▶ confirmed
//        ─▶ active ─▶ returning ─▶ returned（sealed）
//   任意点可 cancelled / expired；
//   check.blocked（确认未完成时动作被拒）作为证据事件记录，不改变状态。
//
// 事实来源全部是既有路径，本模块只做“记录 + 校验 + 对账”：
//   borrowGate（borrow-confirm.js）        request/resolve/cancel/clear 的真实状态机
//   controllerState（controller-state.js）  borrowed/handoff/human 的 controller 快照
//   passthroughTokens（passthrough-token） 交还时租约是否已撤销（coop:<tab> grantee）
//   cooperationCoordinator（cooperate.js） 租约栈/抑制/handback 的联调证据
//   overlay-state.js                       交还时浮层是否已关闭
//   toolbar.js                             用户看到的工具栏动作/焦点（交还时封存）
//
// 接线方式（不复制、不改默认行为）：
//   borrow-confirm.js 在 request/resolve/cancel/clear/check 之后调用
//   borrowJourneys.observeGateEvent(...)，本模块按事件推进自己的证据链。
//   观察失败绝不影响借用流程：所有通知都由 borrow-confirm 侧 try/catch 包裹。
//
// 约定：
//   - 纯内存 + 可注入时钟/依赖，不碰 DOM/chrome；
//   - 哈希链用 FNV-1a（与 cooperate.js 的 evidenceDigest 同一实现），只做“事后防篡改
//     校验”，不是密码学签名；
//   - 交还必须没有活跃 passthrough 租约（E_LEASE_ACTIVE），避免带着解锁令牌交权；
//   - 对账（reconcile）只报告异常，不修状态——修复仍由既有控制路径负责。

import { passthroughTokens } from './passthrough-token.js';
import { controllerState, transitionBumps } from './controller-state.js';
import { compareRevisionVectors } from './revision-chain.js';
import { bumpRevisions, controlGenerationRecord } from '../control-generation.js';
import { getOverlayState } from '../overlay-state.js';
import { cooperationCoordinator } from './cooperate.js';
import { cooperateControlPlane } from './cooperate-control-plane.js';
import { confirmationPlan, handoffWindow, controlEvidence } from './cooperate-control.js';
import { liveToolbarSnapshot, toolbarBlockedEvidence, buildToolbarModel, toolbarEvidence } from './toolbar.js';

// 旅程状态/事件/哈希链契约拆在 human-borrow-ledger.js（单文件行数预算），此处按原 API 重导出；
// 通用工具（num/positive/clip/fail/evidenceDigest）复用 input-lease-kinds.js，避免三份实现。
import {
  num,
  positive,
  clip,
  fail,
  normalizeCooperationTabId as normalizeTabId,
  evidenceDigest,
} from './input-lease-kinds.js';
import {
  JOURNEY_STATES,
  JOURNEY_STATE_LIST,
  JOURNEY_EVENTS,
  JOURNEY_ANOMALIES,
  JOURNEY_ERRORS,
  JOURNEY_TRANSITIONS,
  journeyTransitionFor,
  journeyAllowedEvents,
  chainEntry,
  sealChain,
  verifyChain,
  describeJourney,
} from './human-borrow-ledger.js';

export {
  JOURNEY_STATES,
  JOURNEY_STATE_LIST,
  JOURNEY_EVENTS,
  JOURNEY_ANOMALIES,
  JOURNEY_ERRORS,
  JOURNEY_TRANSITIONS,
  journeyTransitionFor,
  journeyAllowedEvents,
  chainEntry,
  sealChain,
  verifyChain,
  describeJourney,
} from './human-borrow-ledger.js';

const DEFAULT_MAX_TABS = 256;
const DEFAULT_HISTORY_LIMIT = 48;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_CHECK_BLOCKED_LIMIT = 12;
const DEFAULT_TERMINAL_KEEP = 32;

function emptyJourney(tabId, now) {
  return {
    tabId,
    state: null,
    requestId: null,
    requestedAt: 0,
    presentedAt: 0,
    decidedAt: 0,
    confirmedAt: 0,
    activeAt: 0,
    returnRequestedAt: 0,
    returnedAt: 0,
    closedAt: 0,
    surface: null,
    surfaceTabId: null,
    title: '',
    windowId: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    decision: null,
    decisionSurface: null,
    entries: [],
    anomalies: [],
    checkBlocked: 0,
    lastBlockedAt: 0,
    lastBlockedMethod: null,
    sealed: null,
    rev: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 创建借用旅程账本（证据闭环）。
 * @param {{
 *   now?: () => number,
 *   gate?: object,
 *   tokens?: object,
 *   controller?: object,
 *   coordinator?: object,
 *   overlays?: (tabId:number) => object,
 *   bumpRevisions?: (tabId:number, delta:object) => object,
 *   revisionRecord?: (tabId:number) => object,
 *   maxTabs?: number,
 *   historyLimit?: number,
 *   timeoutMs?: number,
 *   checkBlockedLimit?: number,
 *   autoSeal?: boolean,
 * }} [options]
 */
export function createBorrowJourneys(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const tokens = options.tokens && typeof options.tokens.clearGrantee === 'function' ? options.tokens : passthroughTokens;
  const controller = options.controller && typeof options.controller.transition === 'function' ? options.controller : controllerState;
  const coordinator = options.coordinator && typeof options.coordinator.snapshot === 'function' ? options.coordinator : cooperationCoordinator;
  const overlaysFor = typeof options.overlays === 'function' ? options.overlays : (tabId) => getOverlayState(tabId);
  const bumpFn = typeof options.bumpRevisions === 'function' ? options.bumpRevisions : bumpRevisions;
  const recordFn = typeof options.revisionRecord === 'function' ? options.revisionRecord : controlGenerationRecord;
  const maxTabs = Math.max(1, Math.floor(positive(options.maxTabs, DEFAULT_MAX_TABS)));
  const historyLimit = Math.max(1, Math.floor(positive(options.historyLimit, DEFAULT_HISTORY_LIMIT)));
  const timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const checkBlockedLimit = Math.max(1, Math.floor(positive(options.checkBlockedLimit, DEFAULT_CHECK_BLOCKED_LIMIT)));
  const autoSeal = options.autoSeal !== false;
  let gate = options.gate && typeof options.gate.request === 'function' ? options.gate : null;
  const journeys = new Map();
  const byRequest = new Map();
  const terminalOrder = [];
  const stats = {
    begun: 0,
    presented: 0,
    decisions: 0,
    confirmed: 0,
    activated: 0,
    returns: 0,
    anomalies: 0,
    blockedChecks: 0,
    sealed: 0,
    verifyFailures: 0,
    clears: 0,
    badArgs: 0,
    ignored: 0,
  };

  function journeyFor(tabId) {
    const id = normalizeTabId(tabId);
    if (id == null) return null;
    let journey = journeys.get(id);
    if (!journey) {
      if (journeys.size >= maxTabs) {
        const oldest = journeys.keys().next().value;
        if (oldest !== undefined) {
          const dropped = journeys.get(oldest);
          if (dropped && dropped.requestId) byRequest.delete(dropped.requestId);
          journeys.delete(oldest);
        }
      }
      journey = emptyJourney(id, now());
      journeys.set(id, journey);
    }
    return journey;
  }

  /** 绑定真实借用闸门（borrow-confirm 创建单例后调用；只注入，不反向依赖）。 */
  function bindGate(borrowGate) {
    gate = borrowGate && typeof borrowGate.request === 'function' ? borrowGate : null;
    return { ok: gate != null, gate: gate != null };
  }

  function gateBound() {
    return gate != null;
  }

  function append(journey, kind, data = {}) {
    journey.rev += 1;
    const previous = journey.entries.length ? journey.entries[journey.entries.length - 1] : null;
    const entry = chainEntry(previous, {
      seq: journey.rev,
      kind,
      at: num(data.at) || now(),
      data,
    });
    journey.entries.push(entry);
    if (journey.entries.length > historyLimit) journey.entries.splice(0, journey.entries.length - historyLimit);
    journey.updatedAt = entry.at;
    return entry;
  }

  function rememberAnomaly(journey, code, detail = {}) {
    journey.anomalies.push({ code, at: now(), ...detail });
    if (journey.anomalies.length > 16) journey.anomalies.splice(0, journey.anomalies.length - 16);
    stats.anomalies += 1;
    return journey.anomalies[journey.anomalies.length - 1];
  }

  function terminal(journey) {
    if (![JOURNEY_STATES.RETURNED, JOURNEY_STATES.CLOSED, JOURNEY_STATES.CANCELLED, JOURNEY_STATES.EXPIRED, JOURNEY_STATES.DENIED, JOURNEY_STATES.TIMEOUT].includes(journey.state)) return;
    if (journey.requestId) byRequest.delete(journey.requestId);
    terminalOrder.push({ tabId: journey.tabId, at: now(), state: journey.state });
    while (terminalOrder.length > DEFAULT_TERMINAL_KEEP) terminalOrder.shift();
  }

  /**
   * 内部状态迁移：命中迁移表才改状态；非法迁移返回结构化拒绝（含允许事件）。
   * @returns {{ok:boolean, code?:string, state:string|null, from:string|null}}
   */
  function transition(journey, event, facts = {}) {
    const from = journey.state;
    const to = journeyTransitionFor(from, event);
    if (!to) {
      return {
        ok: false,
        code: JOURNEY_ERRORS.TRANSITION,
        error: '非法借用旅程迁移：' + String(from) + ' -[' + event + ']-> ?',
        from,
        allowed: journeyAllowedEvents(from),
        evidence: { tabId: journey.tabId, from, event, allowed: journeyAllowedEvents(from), at: now() },
      };
    }
    journey.state = to;
    journey.updatedAt = now();
    journey[stageFieldOf(to)] = journey.updatedAt;
    append(journey, 'state', { from, event, to, at: journey.updatedAt, facts: summarizeFacts(facts) });
    if (from == null && journey.requestId) byRequest.set(journey.requestId, journey);
    terminal(journey);
    return { ok: true, from, to, tabId: journey.tabId };
  }

  function stageFieldOf(state) {
    switch (state) {
      case JOURNEY_STATES.REQUESTED: return 'requestedAt';
      case JOURNEY_STATES.PRESENTED: return 'presentedAt';
      case JOURNEY_STATES.ALLOWED:
      case JOURNEY_STATES.DENIED:
      case JOURNEY_STATES.TIMEOUT: return 'decidedAt';
      case JOURNEY_STATES.CONFIRMED: return 'confirmedAt';
      case JOURNEY_STATES.ACTIVE: return 'activeAt';
      case JOURNEY_STATES.RETURNING: return 'returnRequestedAt';
      case JOURNEY_STATES.RETURNED: return 'returnedAt';
      case JOURNEY_STATES.CLOSED: return 'closedAt';
      default: return 'updatedAt';
    }
  }

  function summarizeFacts(facts) {
    if (!facts || typeof facts !== 'object') return null;
    const summary = {};
    for (const key of ['surface', 'decision', 'reason', 'requestId', 'title', 'timeoutMs', 'windowId', 'method', 'source']) {
      if (facts[key] === undefined) continue;
      summary[key] = typeof facts[key] === 'string' ? clip(facts[key], 120) : facts[key];
    }
    return Object.keys(summary).length ? summary : null;
  }

  /** 公开：开始一次借用旅程（可选真实调用闸门 request）。 */
  function begin(tabId, beginOptions = {}) {
    const id = normalizeTabId(tabId);
    if (id == null) {
      stats.badArgs += 1;
      return fail(JOURNEY_ERRORS.BAD_ARG, '借journey.begin 需要整数 tabId');
    }
    const journey = journeyFor(id);
    const requestId = clip(beginOptions.requestId || ('borrow-' + id + '-' + now().toString(36)), 80);
    let gateResult = null;
    if (beginOptions.useGate === true) {
      if (!gate) return fail(JOURNEY_ERRORS.NO_GATE, '未绑定借用闸门（borrow-confirm 尚未加载）', { tabId: id });
      gateResult = gate.request(id, {
        requestId,
        timeoutMs: positive(beginOptions.timeoutMs, timeoutMs),
        windowId: beginOptions.windowId,
        title: beginOptions.title,
        surface: beginOptions.surface,
      });
      if (!gateResult || gateResult.ok !== true) {
        return { ok: false, code: gateResult ? gateResult.code || 'E_BORROW_CONFLICT' : 'E_BORROW_CONFLICT', tabId: id, error: '借用确认登记失败', evidence: gateResult && gateResult.evidence ? gateResult.evidence : null };
      }
    }
    journey.requestId = requestId;
    journey.title = clip(beginOptions.title || '', 200);
    journey.windowId = Number.isInteger(Number(beginOptions.windowId)) ? Number(beginOptions.windowId) : null;
    journey.timeoutMs = positive(beginOptions.timeoutMs, timeoutMs);
    journey.surface = null;
    const moved = transition(journey, JOURNEY_EVENTS.REQUEST, {
      requestId,
      title: journey.title,
      timeoutMs: journey.timeoutMs,
      source: clip(beginOptions.source || 'borrow.begin', 80),
      gate: beginOptions.useGate === true,
    });
    if (!moved.ok) return moved;
    byRequest.set(requestId, journey);
    stats.begun += 1;
    // 【M6 P0③】借用确认窗口映射（兼容目标 tab borrow --timeout / confirmation_timeout_ms）：
    // 默认 60s、超时判定 deny（E_BORROW_TIMEOUT），--no-confirm 是废弃位由扩展决定是否确认。
    const plan = confirmationPlan({ timeoutMs: journey.timeoutMs, requestedAt: journey.requestedAt, now: now() });
    const control = controlFactsFor(id, gateResult ? { status: gateResult.status, requestedAt: journey.requestedAt, timeoutMs: journey.timeoutMs } : { status: 'pending', requestedAt: journey.requestedAt, timeoutMs: journey.timeoutMs });
    return {
      ok: true,
      tabId: id,
      requestId,
      state: journey.state,
      entryCount: journey.entries.length,
      gate: gateResult ? { ok: true, status: gateResult.status, duplicate: gateResult.duplicate === true } : null,
      confirmation: { timeoutMs: plan.timeoutMs, deadlineAt: plan.deadlineAt, onTimeout: plan.onTimeout, timeoutCode: plan.timeoutCode, noConfirm: plan.noConfirm },
      ...(control ? { control } : {}),
      evidence: { tabId: id, requestId, state: journey.state, at: now(), gate: gateResult ? gateResult.status : null, confirmation: plan.evidence, ...(control ? { control } : {}) },
    };
  }

  /** 借用确认界面已渲染：记录 surface（modal/toast/notification）与渲染时间。 */
  function presented(tabId, presentedOptions = {}) {
    const id = normalizeTabId(tabId);
    if (id == null) return fail(JOURNEY_ERRORS.BAD_ARG, 'presented 需要整数 tabId');
    const journey = journeyFor(id);
    const surface = presentedOptions.surface == null ? null : clip(presentedOptions.surface, 24);
    const moved = transition(journey, JOURNEY_EVENTS.PRESENTED, { surface, at: now() });
    if (!moved.ok) return moved;
    journey.surface = surface;
    journey.surfaceTabId = Number.isInteger(Number(presentedOptions.surfaceTabId)) ? Number(presentedOptions.surfaceTabId) : null;
    stats.presented += 1;
    return {
      ok: true,
      tabId: id,
      state: journey.state,
      surface,
      evidence: { tabId: id, requestId: journey.requestId, surface, at: journey.presentedAt },
    };
  }

  function decisionEventFor(answer) {
    const decision = answer && answer.decision != null ? String(answer.decision) : (answer && answer.allow === true ? 'allow' : 'deny');
    if (decision === 'allow' && (answer == null || answer.allow !== false)) return JOURNEY_EVENTS.DECISION_ALLOW;
    if (decision === 'timeout') return JOURNEY_EVENTS.DECISION_TIMEOUT;
    return JOURNEY_EVENTS.DECISION_DENY;
  }

  /**
   * 用户决定：allow/deny/timeout。默认只记录；useGate=true 时真实调用闸门 resolve。
   */
  function decide(requestId, answer = {}, decideOptions = {}) {
    const id = typeof requestId === 'string' ? requestId : '';
    const journey = id ? byRequest.get(id) : null;
    if (!journey) {
      return fail(JOURNEY_ERRORS.NOT_FOUND, '没有匹配的借用旅程（可能已超时/已清理）', { requestId: id || null });
    }
    let gateResult = null;
    if (decideOptions.useGate === true) {
      if (!gate) return fail(JOURNEY_ERRORS.NO_GATE, '未绑定借用闸门');
      gateResult = gate.resolve(id, answer);
      if (gateResult && gateResult.status === 'confirmed') {
        journey.decision = 'allow';
      }
    }
    const event = decisionEventFor(answer);
    const decision = event === JOURNEY_EVENTS.DECISION_ALLOW ? 'allow' : event === JOURNEY_EVENTS.DECISION_TIMEOUT ? 'timeout' : 'deny';
    const moved = transition(journey, event, { decision, at: now() });
    if (!moved.ok) {
      // 重复决定（闸门幂等）不应让调用方失败：已在 allowed 再 allow 视为 duplicate。
      if (journey.decision === decision) {
        return { ok: true, duplicate: true, tabId: journey.tabId, state: journey.state, decision, evidence: { tabId: journey.tabId, requestId: id, duplicate: true, decision } };
      }
      return moved;
    }
    journey.decision = decision;
    journey.decisionSurface = journey.surface;
    stats.decisions += 1;
    if (decision === 'allow') {
      // 闸门允许后 controller 已进入 borrowed：立刻记 confirmed（evidence 里带 controller 事实）。
      const confirmed = transition(journey, JOURNEY_EVENTS.CONFIRM, { decision, at: now() });
      if (confirmed.ok) stats.confirmed += 1;
    }
    return {
      ok: true,
      tabId: journey.tabId,
      requestId: id,
      state: journey.state,
      decision,
      allowed: decision === 'allow',
      gate: gateResult ? { ok: gateResult.ok === true, status: gateResult.status || null, code: gateResult.code || null } : null,
      evidence: { tabId: journey.tabId, requestId: id, decision, state: journey.state, at: now() },
    };
  }

  /** 确认后 Agent 真正开始使用该标签页。 */
  function activate(tabId, activateOptions = {}) {
    const id = normalizeTabId(tabId);
    if (id == null) return fail(JOURNEY_ERRORS.BAD_ARG, 'activate 需要整数 tabId');
    const journey = journeyFor(id);
    const moved = transition(journey, JOURNEY_EVENTS.ACTIVATE, { at: now(), method: activateOptions.method });
    if (!moved.ok) return moved;
    stats.activated += 1;
    return {
      ok: true,
      tabId: id,
      state: journey.state,
      evidence: { tabId: id, state: journey.state, at: journey.activeAt, controller: controller.get(id) },
    };
  }

  /** 当前 tab 的借用状态（闸门 + controller + 租约）只读汇总。 */
  function liveFacts(tabId) {
    const id = normalizeTabId(tabId);
    const snapshot = coordinator.snapshot(id);
    const gateStatus = gate && typeof gate.status === 'function' ? gate.status(id) : null;
    return {
      tabId: id,
      gate: gateStatus,
      controller: controller.snapshot(id),
      controllerState: controller.get(id),
      leases: snapshot ? snapshot.leases : [],
      leaseDepth: snapshot ? snapshot.depth : 0,
      suppression: snapshot ? snapshot.suppression : null,
      overlays: overlaysFor(id),
      revisions: recordFn(id) || null,
      // 【M6 P0③】控制面语义：contextId/policy/owner/epoch + token↔context 映射（有控制面事实时才有值）。
      control: snapshot && snapshot.control ? snapshot.control : controlFactsFor(id, gateStatus),
    };
  }

  /** 控制面证据（条件）：借用路径统一从这里取，失败回退 null（旧证据结构不变）。 */
  function controlFactsFor(tabId, gateStatus) {
    try {
      const context = cooperateControlPlane.snapshot(tabId);
      const policyInfo = cooperateControlPlane.policyFor(tabId);
      const status = gateStatus && gateStatus.status ? gateStatus.status : null;
      const window = handoffWindow({ controller: controller.get(tabId), borrow: gateStatus || null, policy: policyInfo.policy, contextId: context ? context.contextId : null, epoch: context ? context.epoch : null, now: now() });
      return controlEvidence({
        contextId: context ? context.contextId : null,
        policy: policyInfo.policy,
        epoch: context ? context.epoch : null,
        owner: status === 'pending' ? 'human' : window.owner,
        decision: status === 'pending' ? 'ask' : (window.owner === 'agent' ? 'allow' : 'deny'),
        reason: status === 'pending' ? 'borrow-confirmation' : window.reason,
        code: status === 'pending' ? 'E_BORROW_CONFLICT' : null,
        deadlineAt: window.closesAt,
        window,
        at: now(),
        source: 'borrow.facts',
      });
    } catch {
      return null;
    }
  }

  /** 交还前检查：租约必须已清空（fail closed），否则返回 E_LEASE_ACTIVE。 */
  function returnPrecheck(tabId, precheckOptions = {}) {
    const facts = liveFacts(tabId);
    const activeLeases = Array.isArray(facts.leases) ? facts.leases.filter((lease) => lease && lease.released !== true) : [];
    if (activeLeases.length && precheckOptions.force !== true) {
      return {
        ok: false,
        code: JOURNEY_ERRORS.LEASE_ACTIVE,
        error: '还有 ' + activeLeases.length + ' 个 passthrough 租约未释放，不能交还',
        facts,
        evidence: { tabId: facts.tabId, reason: 'lease-active', leases: activeLeases, controller: facts.controllerState },
      };
    }
    return { ok: true, facts, activeLeases };
  }

  /**
   * 开始交还：记录交还前事实（租约/浮层/controller/revision）。
   */
  function beginReturn(tabId, returnOptions = {}) {
    const id = normalizeTabId(tabId);
    if (id == null) return fail(JOURNEY_ERRORS.BAD_ARG, 'beginReturn 需要整数 tabId');
    const precheck = returnPrecheck(id, returnOptions);
    if (!precheck.ok) {
      const journey = journeys.get(id);
      if (journey) rememberAnomaly(journey, JOURNEY_ANOMALIES.LEASE_AFTER_RETURN, { leases: precheck.evidence.leases.length });
      return precheck;
    }
    const journey = journeyFor(id);
    const before = revisionVectorOf(id);
    const moved = transition(journey, JOURNEY_EVENTS.RETURN_BEGIN, { reason: clip(returnOptions.reason || '', 120), at: now() });
    if (!moved.ok) return { ...moved, revisions: { before } };
    stats.returns += 1;
    const toolbarModel = safeToolbarModel(id, precheck.facts);
    // 【M6 P0③】交还前控制面证据：交还意味着 owner 从 human/handoff 回到 agent（只读附加）。
    const control = controlFactsFor(id, precheck.facts.gate);
    const evidence = {
      tabId: id,
      reason: clip(returnOptions.reason || '', 120),
      controller: precheck.facts.controller,
      leases: precheck.facts.leases,
      overlays: summarizeOverlays(precheck.facts.overlays),
      revisions: { before },
      toolbar: toolbarEvidence(toolbarModel),
      ...(control ? { control } : {}),
      at: now(),
    };
    append(journey, 'return.begin', { before, reason: evidence.reason, leases: precheck.facts.leases.length });
    return { ok: true, tabId: id, state: journey.state, revisions: { before }, evidence, toolbar: evidence.toolbar };
  }

  function revisionVectorOf(tabId) {
    const record = recordFn(tabId) || {};
    return {
      controlRevision: num(record.controlRevision),
      authorityRevision: num(record.authorityRevision),
      revision: num(record.revision),
      frameEpoch: num(record.frameEpoch),
      epoch: num(record.epoch),
      generation: num(record.generation),
    };
  }

  function summarizeOverlays(overlayState) {
    const overlays = overlayState && Array.isArray(overlayState.overlays) ? overlayState.overlays : [];
    return {
      capturing: Boolean(overlayState && overlayState.capturing === true),
      overlays: overlays.map((entry) => ({ kind: clip(entry && entry.kind || '', 32), priority: num(entry && entry.priority), since: num(entry && entry.since) })),
    };
  }

  function safeToolbarModel(tabId, facts) {
    try {
      const snapshot = liveToolbarSnapshot(tabId, {
        borrow: facts && facts.gate ? facts.gate : null,
        controller: facts && facts.controller ? facts.controller : null,
        overlays: facts && facts.overlays ? facts.overlays : undefined,
      });
      return buildToolbarModel(snapshot, { now: now() });
    } catch {
      return null;
    }
  }

  /**
   * 完成交还：清租约 → controller 迁移 → 关闭浮层事实 → 封存证据链。
   * 真实消费：passthroughTokens.clearGrantee / controller.transition / bumpRevisions。
   */
  function completeReturn(tabId, completeOptions = {}) {
    const id = normalizeTabId(tabId);
    if (id == null) return fail(JOURNEY_ERRORS.BAD_ARG, 'completeReturn 需要整数 tabId');
    const journey = journeyFor(id);
    const precheck = returnPrecheck(id, completeOptions);
    if (!precheck.ok) {
      rememberAnomaly(journey, JOURNEY_ANOMALIES.LEASE_AFTER_RETURN, { leases: precheck.evidence.leases.length });
      return precheck;
    }
    const before = revisionVectorOf(id);
    const revoked = tokens.clearGrantee('coop:' + id);
    const attempts = [];
    let accepted = null;
    for (const event of ['borrow.return', 'handoff.abort', 'reset']) {
      const moved = controller.transition(id, event, {
        source: clip(completeOptions.source || 'borrow.return', 80),
        reason: clip(completeOptions.reason || '', 120),
      });
      attempts.push({ event, ok: moved && moved.ok === true, code: moved ? moved.code || null : null, duplicate: moved ? moved.duplicate === true : false });
      if (moved && moved.ok) {
        accepted = { event, moved };
        const delta = transitionBumps(moved);
        if (Object.keys(delta).length) bumpFn(id, delta);
        break;
      }
    }
    const after = revisionVectorOf(id);
    const comparison = compareRevisionVectors(before, after);
    const moved = transition(journey, JOURNEY_EVENTS.RETURN_COMPLETE, { at: now(), reason: clip(completeOptions.reason || '', 120) });
    if (!moved.ok && completeOptions.force !== true) {
      return { ...moved, revisions: { before, after } };
    }
    const toolbarModel = safeToolbarModel(id, liveFacts(id));
    // 【M6 P0③】交还完成：owner 回到 agent，contextId/policy/epoch 随证据封存（无控制面事实时省略）。
    const control = controlFactsFor(id, null);
    const summary = {
      tabId: id,
      requestId: journey.requestId,
      decision: journey.decision,
      returningAt: journey.returnRequestedAt,
      returnedAt: now(),
      revokedTokens: revoked && Number.isInteger(revoked.revoked) ? revoked.revoked : 0,
      controller: { accepted: accepted ? accepted.event : null, attempts },
      revisions: { before, after, stale: comparison.stale, side: comparison.side, fields: comparison.fields },
      overlays: summarizeOverlays(overlaysFor(id)),
      toolbar: toolbarEvidence(toolbarModel),
      leaseDepth: coordinator.snapshot(id).depth,
      ...(control ? { control } : {}),
    };
    append(journey, 'return.complete', summary);
    stats.sealed += 1;
    const sealed = autoSeal ? sealJourney(journey) : null;
    return {
      ok: true,
      tabId: id,
      state: journey.state,
      summary,
      sealed,
      evidence: {
        tabId: id,
        state: journey.state,
        controller: summary.controller,
        revisions: summary.revisions,
        revokedTokens: summary.revokedTokens,
        toolbar: summary.toolbar,
        ...(control ? { control } : {}),
        at: now(),
      },
    };
  }

  /** 封存当前旅程：返回带哈希链的证据证书。 */
  function sealJourney(journey) {
    const sealed = sealChain(journey.entries, {
      tabId: journey.tabId,
      requestId: journey.requestId,
      state: journey.state,
      decision: journey.decision,
      sealedAt: now(),
      anomalies: journey.anomalies.map((anomaly) => anomaly.code),
    });
    journey.sealed = sealed;
    return sealed;
  }

  function seal(tabId) {
    const id = normalizeTabId(tabId);
    if (id == null) return fail(JOURNEY_ERRORS.BAD_ARG, 'seal 需要整数 tabId');
    const journey = journeys.get(id);
    if (!journey) return fail(JOURNEY_ERRORS.NOT_FOUND, '没有该 tab 的借用旅程', { tabId: id });
    stats.sealed += 1;
    return { ok: true, tabId: id, state: journey.state, sealed: sealJourney(journey) };
  }

  /** 校验某 tab 已封存的证据（无封存时现场重算并校验）。 */
  function verify(tabIdOrSealed) {
    const sealed = tabIdOrSealed && typeof tabIdOrSealed === 'object' && Array.isArray(tabIdOrSealed.entries)
      ? tabIdOrSealed
      : (() => {
        const id = normalizeTabId(tabIdOrSealed);
        const journey = id == null ? null : journeys.get(id);
        return journey && journey.sealed ? journey.sealed : null;
      })();
    if (!sealed) return { ok: false, code: JOURNEY_ERRORS.NOT_FOUND, error: '没有可校验的证据（先 seal）' };
    const result = verifyChain(sealed);
    if (!result.ok) stats.verifyFailures += 1;
    return { ...result, tabId: sealed.extra ? sealed.extra.tabId : null, requestId: sealed.extra ? sealed.extra.requestId : null };
  }

  /** 取消借用（用户关浮层/tab 关闭/流程异常）。 */
  function cancel(tabId, reason = 'cancelled') {
    const id = normalizeTabId(tabId);
    if (id == null) return fail(JOURNEY_ERRORS.BAD_ARG, 'cancel 需要整数 tabId');
    const journey = journeyFor(id);
    let gateResult = null;
    if (gate) gateResult = gate.cancel(id, reason);
    const moved = transition(journey, JOURNEY_EVENTS.CANCEL, { reason, at: now() });
    if (!moved.ok) return moved;
    return {
      ok: true,
      tabId: id,
      state: journey.state,
      gate: gateResult ? { ok: gateResult.ok === true, cancelled: gateResult.cancelled === true } : null,
      evidence: { tabId: id, state: journey.state, reason: clip(reason, 120), at: now() },
    };
  }

  /** 记录一次“借用确认未完成时动作被拒”的证据（不改状态）。 */
  function noteBlockedCheck(tabId, check = {}) {
    const id = normalizeTabId(tabId);
    if (id == null) return fail(JOURNEY_ERRORS.BAD_ARG, 'noteBlockedCheck 需要整数 tabId');
    const journey = journeyFor(id);
    journey.checkBlocked += 1;
    journey.lastBlockedAt = num(check.at) || now();
    journey.lastBlockedMethod = clip(check.method || '', 64);
    if (journey.entries.length) append(journey, JOURNEY_EVENTS.CHECK_BLOCKED, {
      method: journey.lastBlockedMethod,
      pendingMs: num(check.pendingMs),
      requestId: journey.requestId,
      at: journey.lastBlockedAt,
    });
    stats.blockedChecks += 1;
    const bounded = journey.checkBlocked > checkBlockedLimit ? checkBlockedLimit : journey.checkBlocked;
    return {
      ok: true,
      tabId: id,
      blockedChecks: bounded,
      totalBlockedChecks: journey.checkBlocked,
      evidence: { tabId: id, requestId: journey.requestId, method: journey.lastBlockedMethod, pendingMs: num(check.pendingMs), at: journey.lastBlockedAt },
    };
  }

  /**
   * 过期扫描：requested/presented 超过 timeoutMs 还没决定 → 标 expired + 异常。
   * @param {number} [at]
   */
  function sweep(at) {
    const time = Number.isFinite(Number(at)) ? Number(at) : now();
    const expired = [];
    for (const journey of journeys.values()) {
      if (journey.state !== JOURNEY_STATES.REQUESTED && journey.state !== JOURNEY_STATES.PRESENTED) continue;
      if (!(journey.requestedAt > 0)) continue;
      const ageMs = time - journey.requestedAt;
      if (ageMs <= journey.timeoutMs) continue;
      const moved = transition(journey, JOURNEY_EVENTS.EXPIRE, { at: time, ageMs });
      if (!moved.ok) continue;
      rememberAnomaly(journey, JOURNEY_ANOMALIES.PENDING_EXPIRED, { ageMs, timeoutMs: journey.timeoutMs, requestId: journey.requestId });
      expired.push({ tabId: journey.tabId, requestId: journey.requestId, ageMs, timeoutMs: journey.timeoutMs });
    }
    return { ok: true, at: time, expired, count: expired.length };
  }

  /**
   * 对账：把旅程状态与真实世界（闸门/controller/租约/浮层）对齐，只报告不修。
   * @param {number} tabId
   */
  function reconcile(tabId) {
    const id = normalizeTabId(tabId);
    if (id == null) return fail(JOURNEY_ERRORS.BAD_ARG, 'reconcile 需要整数 tabId');
    const journey = journeys.get(id) || null;
    const facts = liveFacts(id);
    const anomalies = [];
    const push = (code, detail) => anomalies.push({ code, ...detail, at: now() });
    const gateStatus = facts.gate || null;
    const journeyState = journey ? journey.state : null;
    if (gateStatus) {
      if (gateStatus.status === 'pending' && journeyState !== JOURNEY_STATES.REQUESTED && journeyState !== JOURNEY_STATES.PRESENTED) {
        push(JOURNEY_ANOMALIES.GATE_MISSING, { gateStatus: gateStatus.status, journeyState });
      }
      if (gateStatus.status === 'confirmed' && facts.controllerState !== 'borrowed' && facts.controllerState !== 'agent') {
        push(JOURNEY_ANOMALIES.GATE_CONTROLLER_MISMATCH, { gateStatus: gateStatus.status, controller: facts.controllerState });
      }
      if (gateStatus.status === 'pending' && gateStatus.expired === true) {
        push(JOURNEY_ANOMALIES.PENDING_EXPIRED, { requestId: gateStatus.requestId, pendingMs: gateStatus.pendingMs });
      }
    } else if (journeyState && ![JOURNEY_STATES.CLOSED, JOURNEY_STATES.RETURNED, JOURNEY_STATES.CANCELLED, JOURNEY_STATES.EXPIRED, JOURNEY_STATES.DENIED, JOURNEY_STATES.TIMEOUT].includes(journeyState)) {
      // 只有“还在进行中”的旅程缺闸门记录才算异常；终态后闸门被 clear 是正常收尾。
      push(JOURNEY_ANOMALIES.GATE_MISSING, { gateStatus: null, journeyState });
    }
    if (journey) {
      if (journey.state === JOURNEY_STATES.PRESENTED && journey.surface == null) {
        push(JOURNEY_ANOMALIES.SURFACE_MISSING, { requestId: journey.requestId });
      }
      if ([JOURNEY_STATES.RETURNED, JOURNEY_STATES.CLOSED].includes(journey.state) && facts.leaseDepth > 0) {
        push(JOURNEY_ANOMALIES.LEASE_AFTER_RETURN, { leaseDepth: facts.leaseDepth });
      }
      if ([JOURNEY_STATES.RETURNED, JOURNEY_STATES.DENIED, JOURNEY_STATES.TIMEOUT, JOURNEY_STATES.CANCELLED].includes(journey.state)) {
        const openOverlays = facts.overlays && Array.isArray(facts.overlays.overlays)
          ? facts.overlays.overlays.filter((entry) => ['borrow', 'borrow-toast'].includes(String(entry && entry.kind)))
          : [];
        if (openOverlays.length) push(JOURNEY_ANOMALIES.OVERLAY_AFTER_DECISION, { overlays: openOverlays.map((entry) => entry.kind) });
        if (facts.controllerState === 'borrowed') push(JOURNEY_ANOMALIES.CONTROLLER_AFTER_RETURN, { controller: facts.controllerState });
      }
    }
    for (const anomaly of anomalies) {
      if (journey) rememberAnomaly(journey, anomaly.code, anomaly);
    }
    return {
      ok: anomalies.length === 0,
      tabId: id,
      at: now(),
      journeyState,
      controller: facts.controllerState,
      gateStatus: gateStatus ? gateStatus.status : null,
      leaseDepth: facts.leaseDepth,
      anomalies,
      evidence: { tabId: id, journeyState, controller: facts.controllerState, gateStatus: gateStatus ? gateStatus.status : null, leaseDepth: facts.leaseDepth, anomalies: anomalies.length },
    };
  }

  /**
   * 外部（borrow-confirm）通知入口：把既有借用路径的真实事件灌进证据链。
   * 事件类型：request / presented / resolve / cancel / clear / check-blocked。
   * 绝不抛异常、绝不影响调用方返回值（调用方包了 try/catch，这里再兜一层）。
   */
  function observeGateEvent(event = {}) {
    try {
      const type = String(event.type || '');
      const tabId = normalizeTabId(event.tabId);
      if (tabId == null) {
        stats.ignored += 1;
        return { ok: false, code: JOURNEY_ERRORS.BAD_ARG, ignored: true };
      }
      if (type === 'request') {
        const journey = journeyFor(tabId);
        // 同 tab 的新请求：若旧旅程已终态，重置链重新开始。
        if (journey.state && ![JOURNEY_STATES.CLOSED, JOURNEY_STATES.RETURNED, JOURNEY_STATES.CANCELLED, JOURNEY_STATES.EXPIRED, JOURNEY_STATES.DENIED, JOURNEY_STATES.TIMEOUT].includes(journey.state)) {
          stats.ignored += 1;
          return { ok: true, ignored: true, duplicate: true, state: journey.state, requestId: journey.requestId };
        }
        if (journey.requestId) byRequest.delete(journey.requestId);
        const fresh = emptyJourney(tabId, now());
        journeys.set(tabId, fresh);
        fresh.requestId = clip(event.requestId || '', 80);
        fresh.title = clip(event.title || '', 200);
        fresh.windowId = Number.isInteger(Number(event.windowId)) ? Number(event.windowId) : null;
        fresh.timeoutMs = positive(event.timeoutMs, timeoutMs);
        const moved = transition(fresh, JOURNEY_EVENTS.REQUEST, { requestId: fresh.requestId, timeoutMs: fresh.timeoutMs, source: 'borrow.confirm', at: num(event.at) || now() });
        if (moved.ok) stats.begun += 1;
        byRequest.set(fresh.requestId, fresh);
        return { ok: moved.ok, tabId, state: fresh.state, requestId: fresh.requestId, transition: moved };
      }
      if (type === 'presented') {
        const journey = journeys.get(tabId);
        if (!journey || !journey.requestId) {
          stats.ignored += 1;
          return { ok: false, ignored: true, reason: 'no-journey' };
        }
        journey.surface = event.surface == null ? null : clip(event.surface, 24);
        const moved = transition(journey, JOURNEY_EVENTS.PRESENTED, { surface: journey.surface, at: num(event.at) || now() });
        if (moved.ok) stats.presented += 1;
        return { ok: moved.ok, tabId, state: journey.state, surface: journey.surface, transition: moved };
      }
      if (type === 'resolve') {
        const requestId = clip(event.requestId || '', 80);
        const journey = byRequest.get(requestId);
        if (!journey) {
          stats.ignored += 1;
          return { ok: false, ignored: true, reason: 'unknown-request' };
        }
        const eventKind = event.status === 'confirmed' || event.decision === 'allow'
          ? JOURNEY_EVENTS.DECISION_ALLOW
          : event.status === 'timeout' || event.decision === 'timeout'
            ? JOURNEY_EVENTS.DECISION_TIMEOUT
            : JOURNEY_EVENTS.DECISION_DENY;
        const decision = eventKind === JOURNEY_EVENTS.DECISION_ALLOW ? 'allow' : eventKind === JOURNEY_EVENTS.DECISION_TIMEOUT ? 'timeout' : 'deny';
        journey.decision = decision;
        journey.decisionSurface = journey.surface;
        const moved = transition(journey, eventKind, { decision, at: num(event.at) || now(), requestId });
        if (moved.ok) stats.decisions += 1;
        if (moved.ok && decision === 'allow') {
          const confirmed = transition(journey, JOURNEY_EVENTS.CONFIRM, { decision, at: num(event.at) || now() });
          if (confirmed.ok) stats.confirmed += 1;
        }
        return { ok: moved.ok, tabId, state: journey.state, decision, transition: moved };
      }
      if (type === 'cancel') {
        const journey = journeys.get(tabId);
        if (!journey || !journey.requestId) {
          stats.ignored += 1;
          return { ok: false, ignored: true, reason: 'no-journey' };
        }
        const moved = transition(journey, JOURNEY_EVENTS.CANCEL, { reason: clip(event.reason || 'cancelled', 120), at: num(event.at) || now() });
        return { ok: moved.ok, tabId, state: journey.state, transition: moved };
      }
      if (type === 'clear') {
        const journey = journeys.get(tabId);
        if (!journey || !journey.requestId) {
          stats.ignored += 1;
          return { ok: false, ignored: true, reason: 'no-journey' };
        }
        if (journey.requestedAt > 0) {
          // 借用流程的 finally 会 clear 闸门记录：不改变“是否 returned”的事实，只记证据。
          append(journey, 'gate.clear', { reason: clip(event.reason || 'clear', 120), at: num(event.at) || now(), state: journey.state });
          stats.clears += 1;
        }
        return { ok: true, tabId, state: journey.state };
      }
      if (type === 'check-blocked') {
        return noteBlockedCheck(tabId, event);
      }
      stats.ignored += 1;
      return { ok: false, ignored: true, reason: 'unknown-event', type };
    } catch (error) {
      stats.ignored += 1;
      return { ok: false, code: 'E_INTERNAL', error: clip((error && error.message) || error, 200), ignored: true };
    }
  }

  /** 只读：某 tab 的旅程快照（不含完整链，链用 evidence()）。 */
  function journey(tabId) {
    const id = normalizeTabId(tabId);
    const journeyValue = id == null ? null : journeys.get(id);
    if (!journeyValue) return null;
    return {
      tabId: journeyValue.tabId,
      state: journeyValue.state,
      requestId: journeyValue.requestId,
      title: journeyValue.title,
      surface: journeyValue.surface,
      windowId: journeyValue.windowId,
      timeoutMs: journeyValue.timeoutMs,
      requestedAt: journeyValue.requestedAt,
      presentedAt: journeyValue.presentedAt,
      decidedAt: journeyValue.decidedAt,
      confirmedAt: journeyValue.confirmedAt,
      activeAt: journeyValue.activeAt,
      returnRequestedAt: journeyValue.returnRequestedAt,
      returnedAt: journeyValue.returnedAt,
      decision: journeyValue.decision,
      checkBlocked: journeyValue.checkBlocked,
      anomalies: journeyValue.anomalies.map((anomaly) => anomaly.code),
      entryCount: journeyValue.entries.length,
      sealed: journeyValue.sealed ? { digest: journeyValue.sealed.digest, count: journeyValue.sealed.count, sealedAt: journeyValue.sealed.lastAt } : null,
      now: now(),
    };
  }

  function byRequestId(requestId) {
    const journeyValue = typeof requestId === 'string' && requestId ? byRequest.get(requestId) : null;
    return journeyValue ? journey(journeyValue.tabId) : null;
  }

  /** 完整证据链（未封存时现场封存一份返回，不写回状态）。 */
  function evidence(tabId) {
    const id = normalizeTabId(tabId);
    const journeyValue = id == null ? null : journeys.get(id);
    if (!journeyValue) return null;
    return journeyValue.sealed || sealChain(journeyValue.entries, {
      tabId: journeyValue.tabId,
      requestId: journeyValue.requestId,
      state: journeyValue.state,
      decision: journeyValue.decision,
      sealedAt: now(),
      anomalies: journeyValue.anomalies.map((anomaly) => anomaly.code),
    });
  }

  function snapshot(tabId) {
    const id = normalizeTabId(tabId);
    const journeyValue = id == null ? null : journeys.get(id);
    const facts = id == null ? null : liveFacts(id);
    return {
      tabId: id,
      journey: journey(id),
      anomalies: journeyValue ? journeyValue.anomalies.slice(-8) : [],
      facts: facts ? {
        gate: facts.gate,
        controller: facts.controllerState,
        leaseDepth: facts.leaseDepth,
        overlays: summarizeOverlays(facts.overlays),
        toolbar: toolbarEvidence(safeToolbarModel(id, facts)),
        ...(facts.control ? { control: facts.control } : {}),
      } : null,
      counters: { ...stats },
    };
  }

  /** 借用确认被拦截时给 dispatch/控制面的证据（toolbar + journey，均精简）。 */
  function blockedEvidence(tabId, blocked = {}) {
    const id = normalizeTabId(tabId);
    if (id == null) return null;
    const journeyValue = journeys.get(id) || null;
    return {
      journey: journeyValue ? {
        state: journeyValue.state,
        requestId: journeyValue.requestId,
        decision: journeyValue.decision,
        surface: journeyValue.surface,
        requestedAt: journeyValue.requestedAt,
        entryCount: journeyValue.entries.length,
        blockedChecks: journeyValue.checkBlocked,
      } : null,
      toolbar: toolbarBlockedEvidence(id, { borrow: blocked.borrow || null }),
      checkedAt: now(),
    };
  }

  function list() {
    return [...journeys.keys()].map((id) => journey(id)).filter(Boolean);
  }

  function counters() {
    return {
      ...stats,
      tabs: journeys.size,
      active: [...journeys.values()].filter((item) => [JOURNEY_STATES.REQUESTED, JOURNEY_STATES.PRESENTED, JOURNEY_STATES.CONFIRMED, JOURNEY_STATES.ACTIVE, JOURNEY_STATES.RETURNING].includes(item.state)).length,
    };
  }

  function forget(tabId) {
    const id = normalizeTabId(tabId);
    if (id == null) return false;
    const journeyValue = journeys.get(id);
    if (journeyValue && journeyValue.requestId) byRequest.delete(journeyValue.requestId);
    return journeys.delete(id);
  }

  function reset() {
    const cleared = journeys.size;
    journeys.clear();
    byRequest.clear();
    terminalOrder.length = 0;
    return { ok: true, cleared };
  }

  return {
    bindGate,
    gateBound,
    begin,
    presented,
    decide,
    activate,
    beginReturn,
    completeReturn,
    cancel,
    seal,
    verify,
    verifyChain,
    sweep,
    reconcile,
    observeGateEvent,
    noteBlockedCheck,
    blockedEvidence,
    journey,
    byRequestId,
    evidence,
    snapshot,
    liveFacts,
    list,
    counters,
    forget,
    reset,
    get timeoutMs() { return timeoutMs; },
    get gate() { return gate; },
  };
}

/** 后台共享单例：borrow-confirm 的事件通知与 CLI 证据读取共用。 */
export const borrowJourneys = createBorrowJourneys();

export { toolbarEvidence };
