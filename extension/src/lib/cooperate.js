// src/lib/cooperate.js —— 协作 passthrough 租约的引用计数调度器（人机互斥 + handback + revision 全链路）。
//
// 0.3.0 的 passthrough 是一条“单槽”链路：
//   cooperation.beginCooperationPassthrough() 签发一次性 token → 内容脚本解锁；
//   dispatch.js 在 tabId → lease 的 Map 里记一份（dispatch.js:483），动作结束消费掉。
// 这条链路在并行/嵌套场景下有四个缺口：
//   1. 同一 tab 的嵌套动作会覆盖单槽（后一次 begin 覆盖前一次 lease，前一次永不消费）；
//   2. 引用计数只在 capture-suppression 里做，passthrough 本身没有“还差几层”的概念；
//   3. 人工活动与 Agent 租约没有互斥判定：人刚停手 100ms，下一个动作就抢走焦点；
//   4. handback（人工把控制交回 Agent）没有状态机，也没有“交还时租约必须已清空”的
//      前置条件，异常路径可以带着租约进入 Agent 控制态。
//
// 本模块把上面四件事收敛成一份可证据化的调度：
//
//   acquire(tabId, {kind, method, ttlMs, expectation}) → 租约句柄
//     - 每个 tab 维护租约栈（深度上限，默认 8），嵌套 acquire 记 depth+1；
//     - 每次 acquire 都 mint 一个独立 passthrough token（passsthrough-token.js），
//       因此任何一层崩溃都不会让其它层的 token 悬空；
//     - kind 映射到 capture-suppression 抑制作用域（原生输入/截图/录制），
//       acquire 即 begin、release 即 end —— 引用计数由 capture-suppression 保证；
//   release(handle) → 释放并给出 token/抑制/revision 三段证据（重复 release 幂等）
//   releaseAll(tabId) → tab 关闭/出错时倒序清空（fail closed：先撤 token 再记证据）
//
//   mayAct(tabId, {method, borrowGate}) → 动作前的互斥判定
//     controller 状态机（held/handoff）> 借用确认 pending > 人机冲突 > 人工冷却；
//     判定只报告不处决（真正拦截仍在 dispatch/control），但证据能被 CLI 复现。
//
//   beginHandback / completeHandback / abortHandback → handback 状态机
//     状态：idle → human-active → handback-pending → handback-done → agent-active
//     前置：开始交还必须没有活跃租约（否则 E_LEASE_ACTIVE，绝不带着解锁令牌交权）；
//     结算：驱动 controller-state 的 human.return / handoff.settle.agent / agent.claim，
//     并把四项 revision（control/authority/revision/frameEpoch）在交还前后的向量
//     与 stale 方向一起封存成可校验证据。
//
//   alignRevision(tabId, remote) / revisionTrace(tabId) → revision 全链路
//     直接复用 control-generation.js 的 align/bump/record（revision-chain 单源），
//     不在此模块里重新实现计数合并；stale 方向只由 compareRevisionVectors 判定。
//
// 约定：
//   - 纯内存 + 可注入时钟/依赖，不碰 DOM/chrome 直接 API；
//   - 结构化返回，绝不抛异常（除 withLease 透传回调自身的异常）；
//   - 所有证据里 token 一律打码，避免租约凭据进日志/诊断。

import { passthroughTokens } from './passthrough-token.js';
import { suppressionScope, SUPPRESSION_KINDS, SUPPRESSION_OUTCOMES } from './suppression-scope.js';
import { captureSuppression } from './capture-suppression.js';
import { controllerState, transitionBumps } from './controller-state.js';
import { compareRevisionVectors } from './revision-chain.js';
import {
  alignControlGeneration,
  bumpRevisions,
  controlGeneration,
  controlGenerationRecord,
} from '../control-generation.js';
import { humanGate } from './human-gate.js';
import { getHumanState } from '../human-state.js';
import { getOverlayState } from '../overlay-state.js';

// 租约类别/错误码/规整/证据工具拆在 input-lease-kinds.js（单文件行数预算）；
// handback 迁移表拆在 human-handoff.js。此处按原 API 重导出，调用方 import 路径不变。
import {
  LEASE_KINDS, LEASE_KIND_LIST, SUPPRESSION_KIND_FOR, LEASE_ERROR,
  DEFAULT_TTL_MS, DEFAULT_MAX_DEPTH, DEFAULT_MAX_TABS, DEFAULT_HUMAN_ACTIVE_MS, DEFAULT_HISTORY_LIMIT,
  num, integer, positive, clip, maskToken, fail, normalizeCooperationTabId, normalizeLeaseKind,
  normalizeLeaseOptions, revisionVector, evidenceDigest, summarizeLease, describeCooperationState,
  applyControllerBumps, emptyTab, pushBounded,
} from './input-lease-kinds.js';
import {
  HANDOFF_STATES, HANDOFF_EVENTS, HANDOFF_TRANSITIONS, handoffRuleFor, handoffAllowedEvents, handoffTransitionTable,
} from './human-handoff.js';
import { cooperateControlPlane, controlLeaseEvidence, controlReleaseEvidence, controlMayActEvidence } from './cooperate-control-plane.js';

export {
  LEASE_KINDS, LEASE_KIND_LIST, SUPPRESSION_KIND_FOR, LEASE_ERROR,
  normalizeCooperationTabId, normalizeLeaseKind, normalizeLeaseOptions, revisionVector,
  evidenceDigest, summarizeLease, describeCooperationState,
  HANDOFF_STATES, HANDOFF_EVENTS, HANDOFF_TRANSITIONS, handoffRuleFor, handoffAllowedEvents, handoffTransitionTable,
};

/** 租约序号：仅用于生成可读 leaseId（进程内单调，不参与安全判定）。 */
let leaseSequence = 0;

/**
 * 创建协作租约调度器。
 * @param {{
 *   now?: () => number,
 *   tokens?: object,
 *   suppression?: object,
 *   capture?: object,
 *   controller?: object,
 *   human?: object,
 *   maxDepth?: number,
 *   maxTabs?: number,
 *   ttlMs?: number,
 *   historyLimit?: number,
 *   granteeFor?: (tabId:number) => string,
 *   bumpRevisions?: (tabId:number, delta:object) => object,
 *   revisionRecord?: (tabId:number) => object,
 *   alignRevisions?: (tabId:number, remote:object) => object,
 * }} [options]
 */
export function createCooperationCoordinator(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const tokens = options.tokens && typeof options.tokens.mint === 'function' ? options.tokens : passthroughTokens;
  const suppression = options.suppression && typeof options.suppression.begin === 'function' ? options.suppression : suppressionScope;
  const capture = options.capture && typeof options.capture.snapshot === 'function' ? options.capture : captureSuppression;
  const controller = options.controller && typeof options.controller.transition === 'function' ? options.controller : controllerState;
  const human = options.human && typeof options.human.exclusive === 'function' ? options.human : humanGate;
  const defaultMaxDepth = Math.max(1, Math.floor(positive(options.maxDepth, DEFAULT_MAX_DEPTH)));
  const maxTabs = Math.max(1, Math.floor(positive(options.maxTabs, DEFAULT_MAX_TABS)));
  const defaultTtlMs = positive(options.ttlMs, DEFAULT_TTL_MS);
  const historyLimit = Math.max(1, Math.floor(positive(options.historyLimit, DEFAULT_HISTORY_LIMIT)));
  const humanActiveMs = positive(options.humanActiveMs, DEFAULT_HUMAN_ACTIVE_MS);
  const bumpFn = typeof options.bumpRevisions === 'function' ? options.bumpRevisions : bumpRevisions;
  const recordFn = typeof options.revisionRecord === 'function' ? options.revisionRecord : controlGenerationRecord;
  const alignFn = typeof options.alignRevisions === 'function' ? options.alignRevisions : alignControlGeneration;
  const granteeFor = typeof options.granteeFor === 'function' ? options.granteeFor : (tabId) => 'coop:' + tabId;
  const controlPlane = options.control && typeof options.control.snapshot === 'function' ? options.control : cooperateControlPlane;
  const tabs = new Map();
  const stats = {
    acquired: 0,
    released: 0,
    revoked: 0,
    conflicts: 0,
    humanRejected: 0,
    tokenFailures: 0,
    suppressionFailures: 0,
    handoffs: 0,
    handbackCompletes: 0,
    handbackAborts: 0,
    peakDepth: 0,
    badArgs: 0,
  };

  function tabFor(tabId) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return null;
    let tab = tabs.get(id);
    if (!tab) {
      if (tabs.size >= maxTabs) {
        const oldest = tabs.keys().next().value;
        if (oldest !== undefined) tabs.delete(oldest);
      }
      tab = emptyTab(id, now());
      tabs.set(id, tab);
    }
    return tab;
  }

  /**
   * 内部 revision 向量：默认与 revisionVector 相同，但尊重注入的 recordFn。
   * （测试/复用场景下把四项计数换成内存单源时，租约与 handback 证据必须读同一份。）
   */
  function localVector(tabId) {
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

  function rememberRevision(tab, reason) {
    const vector = localVector(tab.tabId);
    pushBounded(tab.revisionHistory, { at: now(), reason, vector }, historyLimit);
    tab.updatedAt = now();
    return vector;
  }

  function activeLeaseList(tab) {
    if (!tab) return [];
    return [...tab.leases.values()].filter((lease) => lease.released !== true).map(summarizeLease);
  }

  /** 最近一次人工活动的富证据（human-state 模块 + human-gate 判定合并）。 */
  function humanEvidence(tabId) {
    const rich = getHumanState(tabId) || null;
    const gate = human.state(tabId);
    const richAt = rich ? num(rich.at) : 0;
    const ageMs = richAt > 0 ? Math.max(0, now() - richAt) : null;
    return {
      state: gate.state,
      active: gate.active === true || (richAt > 0 && ageMs != null && ageMs < humanActiveMs),
      lastAt: Math.max(gate.lastAt || 0, richAt),
      lastKind: gate.lastKind || (rich ? clip(rich.kind || 'human-state', 32) : null),
      ageMs: gate.ageMs != null ? gate.ageMs : ageMs,
      source: rich ? 'human-state' : 'human-gate',
      rich: rich ? { at: richAt, kind: clip(rich.kind || '', 32), frameId: integer(rich.frameId), label: clip(rich.label || '', 120) } : null,
      toleranceMs: human.toleranceMs,
    };
  }

  /** 人工互斥判定：最近人工活动在窗口内、且本次租约要求互斥时拒绝。 */
  function humanBlocked(tabId, options) {
    const evidenceHuman = humanEvidence(tabId);
    if (options.force) return { blocked: false, human: evidenceHuman };
    if (evidenceHuman.active) {
      stats.humanRejected += 1;
      return { blocked: true, human: evidenceHuman };
    }
    const gate = human.state(tabId);
    if (gate.cooling) {
      stats.humanRejected += 1;
      return { blocked: true, human: { ...evidenceHuman, state: gate.state, cooling: true } };
    }
    return { blocked: false, human: evidenceHuman };
  }

  /**
   * 取得一次 passthrough 租约（栈式引用计数）。
   * @param {number} tabId
   * @param {object} acquireOptions {kind, method, owner, expectation, ttlMs, suppress, respectHuman, force}
   */
  function acquire(tabId, acquireOptions = {}) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) {
      stats.badArgs += 1;
      return fail(LEASE_ERROR.BAD_ARG, 'acquire 需要整数 tabId', { tabId: null, evidence: { tabId: null, reason: 'bad-tab' } });
    }
    if (acquireOptions != null && typeof acquireOptions !== 'object') {
      stats.badArgs += 1;
      return fail(LEASE_ERROR.BAD_ARG, 'acquire 选项必须是对象', { tabId: id, evidence: { tabId: id, reason: 'bad-options' } });
    }
    const normalized = normalizeLeaseOptions({ ttlMs: defaultTtlMs, ...acquireOptions });
    if (!normalized.ok) {
      stats.badArgs += 1;
      return { ...normalized, tabId: id };
    }
    const opts = normalized.options;
    const maxDepth = Math.min(opts.maxDepth, defaultMaxDepth);
    const tab = tabFor(id);
    if (tab.depth >= maxDepth) {
      return fail(LEASE_ERROR.DEPTH, 'passthrough 嵌套深度超上限（' + maxDepth + '）', {
        tabId: id,
        depth: tab.depth,
        maxDepth,
        evidence: { tabId: id, depth: tab.depth, maxDepth, reason: 'depth-limit' },
      });
    }
    // 人机互斥：人工刚动过（或仍在冷却窗）时，原子输入/截图类租约默认不签发。
    if (opts.respectHuman) {
      const blocked = humanBlocked(id, opts);
      if (blocked.blocked) {
        tab.conflicts += 1;
        stats.conflicts += 1;
        return fail(LEASE_ERROR.HUMAN_ACTIVE, '人工正在操作该标签页：暂不签发 passthrough 租约', {
          tabId: id,
          code: LEASE_ERROR.HUMAN_ACTIVE,
          human: blocked.human,
          evidence: {
            tabId: id,
            kind: opts.kind,
            method: opts.method,
            human: blocked.human,
            reason: 'human-exclusive',
            retryAfterMs: blocked.human.state === 'cooling' ? Math.max(0, humanActiveMs) : null,
          },
        });
      }
    }
    const grantee = granteeFor(id); const minted = tokens.mint({ grantee, ttlMs: opts.ttlMs });
    if (!minted || minted.ok !== true) {
      stats.tokenFailures += 1;
      return fail(LEASE_ERROR.TOKEN, 'passthrough token 签发失败', {
        tabId: id,
        cause: minted ? minted.code || null : null,
        evidence: { tabId: id, reason: 'mint-failed', cause: minted ? minted.code || null : null },
      });
    }
    const suppressionKind = opts.suppress ? SUPPRESSION_KIND_FOR[opts.kind] || null : null;
    let suppressionResult = null;
    if (suppressionKind) {
      suppressionResult = suppression.begin(id, { kind: suppressionKind, method: opts.method, owner: 'cooperate:' + opts.kind });
      if (!suppressionResult || suppressionResult.ok !== true) stats.suppressionFailures += 1;
    }
    leaseSequence = (leaseSequence + 1) % 0xffffff;
    const startedAt = now(); const vectorAtStart = rememberRevision(tab, 'lease-acquire');
    const lease = {
      leaseId: 'coop-lease-' + leaseSequence.toString(36) + '-' + startedAt.toString(36),
      tabId: id,
      token: minted.token,
      tokenMasked: maskToken(minted.token),
      grantee,
      kind: opts.kind,
      method: opts.method,
      owner: opts.owner,
      expectation: opts.expectation,
      reason: opts.reason,
      ttlMs: opts.ttlMs,
      startedAt,
      expiresAt: num(minted.expiresAt),
      depthAtStart: tab.depth,
      suppressionKind,
      suppressionScopeId: suppressionResult && suppressionResult.ok ? suppressionResult.scopeId || null : null,
      suppressionSkipped: suppressionResult && suppressionResult.ok !== true ? suppressionResult.code || 'skipped' : null,
      released: false,
      outcome: null,
      vectorAtStart,
      endedAt: 0,
    };
    tab.leases.set(lease.leaseId, lease);
    tab.depth = tab.leases.size;
    tab.minted += 1;
    tab.updatedAt = startedAt;
    stats.acquired += 1;
    stats.peakDepth = Math.max(stats.peakDepth, tab.depth);
    const evidence = {
      control: controlLeaseEvidence(controlPlane, { tabId: id, record: recordFn(id), token: minted.token, leaseId: lease.leaseId, policy: acquireOptions.policy, context: acquireOptions.context, at: startedAt }),
      tabId: id,
      leaseId: lease.leaseId,
      kind: lease.kind,
      method: lease.method,
      owner: lease.owner,
      grantee,
      token: lease.tokenMasked,
      ttlMs: lease.ttlMs,
      expiresAt: lease.expiresAt,
      depth: tab.depth,
      controller: controller.get(id),
      human: { active: false, lastAt: human.state(id).lastAt },
      suppression: suppressionResult
        ? { ok: suppressionResult.ok === true, kind: suppressionKind, scopeId: suppressionResult.scopeId || null, code: suppressionResult.code || null, count: suppressionResult.count || 0 }
        : null,
      revision: { at: startedAt, vector: vectorAtStart },
      reason: lease.reason || null,
    };
    return {
      ok: true,
      tabId: id,
      leaseId: lease.leaseId,
      token: minted.token,
      grantee,
      kind: lease.kind,
      method: lease.method,
      startedAt,
      expiresAt: lease.expiresAt,
      depth: tab.depth,
      count: tab.depth,
      suppression: evidence.suppression,
      evidence,
      handle: { tabId: id, leaseId: lease.leaseId, token: minted.token },
    };
  }

  /** 从各种引用（句柄对象/leaseId 字符串/token 字符串）定位租约。 */
  function locate(ref, explicitTabId) {
    const tabId = normalizeCooperationTabId(explicitTabId != null ? explicitTabId : (ref && typeof ref === 'object' ? ref.tabId : null));
    const candidates = tabId != null ? [tabs.get(tabId)] : [...tabs.values()];
    const wanted = ref && typeof ref === 'object'
      ? String(ref.leaseId || ref.token || '')
      : String(ref == null ? '' : ref);
    if (!wanted) return null;
    for (const tab of candidates) {
      if (!tab) continue;
      for (const lease of tab.leases.values()) {
        if (lease.leaseId === wanted || lease.token === wanted) return { tab, lease };
      }
    }
    return null;
  }

  /** 抑制/捕获的只读证据：引用计数当前值和持有者。 */
  function suppressionEvidence(tabId) {
    const scopeSnapshot = suppression.snapshot(tabId);
    const captureSnapshot = capture.snapshot(tabId);
    return {
      active: scopeSnapshot ? scopeSnapshot.active === true : false,
      count: captureSnapshot ? captureSnapshot.count : 0,
      effective: captureSnapshot ? captureSnapshot.effective === true : false,
      live: scopeSnapshot && Array.isArray(scopeSnapshot.live) ? scopeSnapshot.live : [],
      holders: captureSnapshot && Array.isArray(captureSnapshot.holders) ? captureSnapshot.holders : [],
      detection: scopeSnapshot ? scopeSnapshot.counters || null : null,
    };
  }

  /**
   * 释放一次租约（幂等）：先 end 抑制、再消费 token、最后记 revision 证据。
   * @param {object|string} ref 句柄/leaseId/token
   * @param {{outcome?: string, tabId?: number}} [releaseOptions]
   */
  function release(ref, releaseOptions = {}) {
    const located = locate(ref, releaseOptions.tabId);
    const outcome = clip(releaseOptions.outcome || SUPPRESSION_OUTCOMES.OK, 24);
    if (!located) {
      return {
        ok: true,
        released: false,
        alreadyReleased: true,
        code: LEASE_ERROR.UNKNOWN,
        outcome,
        evidence: { reason: 'unknown-lease', outcome, at: now() },
      };
    }
    const { tab, lease } = located;
    if (lease.released) {
      return {
        ok: true,
        released: false,
        alreadyReleased: true,
        leaseId: lease.leaseId,
        tabId: tab.tabId,
        outcome: lease.outcome,
        evidence: { tabId: tab.tabId, leaseId: lease.leaseId, alreadyReleased: true, outcome: lease.outcome },
      };
    }
    lease.released = true; lease.outcome = outcome; lease.endedAt = now();
    tab.leases.delete(lease.leaseId); tab.depth = tab.leases.size;
    tab.consumed += 1;
    tab.updatedAt = lease.endedAt;
    stats.released += 1;
    const suppressionResult = lease.suppressionScopeId
      ? suppression.end(tab.tabId, { scopeId: lease.suppressionScopeId, outcome })
      : null;
    const tokenResult = tokens.consume(lease.token, lease.grantee);
    if (!tokenResult.ok) stats.tokenFailures += 1;
    const vectorAfter = rememberRevision(tab, 'lease-release');
    const comparison = compareRevisionVectors(lease.vectorAtStart, vectorAfter);
    const evidence = {
      control: controlReleaseEvidence(controlPlane, lease.token, { at: lease.endedAt, record: recordFn(tab.tabId), policy: releaseOptions.policy }),
      tabId: tab.tabId,
      leaseId: lease.leaseId,
      released: true,
      kind: lease.kind,
      method: lease.method,
      owner: lease.owner,
      grantee: lease.grantee,
      tokenMasked: lease.tokenMasked,
      startedAt: lease.startedAt,
      endedAt: lease.endedAt,
      heldMs: Math.max(0, lease.endedAt - lease.startedAt),
      depthBefore: lease.depthAtStart + 1,
      depthAfter: tab.depth,
      outcome,
      suppression: suppressionResult
        ? {
          ok: suppressionResult.ok === true,
          scopeId: suppressionResult.scopeId || null,
          outcome: suppressionResult.outcome || outcome,
          released: suppressionResult.released === true,
          alreadyReleased: suppressionResult.alreadyReleased === true,
          evidence: suppressionResult.evidence || null,
        }
        : null,
      token: { ...(tokenResult || {}), token: maskToken(lease.token) },
      revisions: {
        before: lease.vectorAtStart,
        after: vectorAfter,
        stale: comparison.stale,
        side: comparison.side,
        fields: comparison.fields,
      },
    };
    return {
      ok: true,
      released: true,
      tabId: tab.tabId,
      leaseId: lease.leaseId,
      outcome,
      depth: tab.depth,
      remaining: tab.depth,
      suppression: evidence.suppression,
      token: evidence.token,
      revisions: evidence.revisions,
      evidence,
    };
  }

  /** 倒序释放某 tab 全部租约（tab 关闭/异常收尾）；返回逐条证据。 */
  function releaseAll(tabId, releaseOptions = {}) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return fail(LEASE_ERROR.BAD_ARG, 'releaseAll 需要整数 tabId', { tabId: null });
    const tab = tabs.get(id);
    if (!tab || !tab.leases.size) {
      return { ok: true, tabId: id, released: 0, remaining: 0, results: [], evidence: { tabId: id, released: 0 } };
    }
    const outcome = releaseOptions.outcome || 'released-all';
    const order = [...tab.leases.keys()].reverse();
    const results = [];
    for (const leaseId of order) {
      results.push(release(leaseId, { tabId: id, outcome }));
    }
    const released = results.filter((result) => result.released).length;
    if (releaseOptions.revokeTokens === true) {
      const revoked = tokens.clearGrantee(granteeFor(id));
      stats.revoked += revoked && Number.isInteger(revoked.revoked) ? revoked.revoked : 0;
    }
    const evidence = {
      tabId: id,
      released,
      remaining: tab.depth,
      outcome,
      leases: results.map((result) => ({ leaseId: result.leaseId || null, released: result.released === true, outcome: result.outcome || null })),
      at: now(),
    };
    return { ok: true, tabId: id, released, remaining: tab.depth, results, evidence };
  }

  /** 包住一次动作：acquire → fn → finally release；异常时把租约证据塞进 error.data。 */
  async function withLease(tabId, acquireOptions, fn) {
    const callback = typeof acquireOptions === 'function' ? acquireOptions : fn;
    const optionsObject = typeof acquireOptions === 'function' ? {} : (acquireOptions || {});
    if (typeof callback !== 'function') throw new TypeError('cooperate.withLease 需要函数');
    const lease = acquire(tabId, optionsObject);
    if (!lease.ok) {
      // 互斥拒绝时默认 fail closed：不执行动作，直接把结构化失败交给调用方。
      if (optionsObject.failOpen !== true) return lease;
      return callback();
    }
    try {
      const result = await callback(lease);
      release(lease.handle, { outcome: SUPPRESSION_OUTCOMES.OK });
      return result;
    } catch (error) {
      const ended = release(lease.handle, { outcome: SUPPRESSION_OUTCOMES.ERROR });
      if (error && typeof error === 'object') {
        error.data = {
          ...(error.data && typeof error.data === 'object' ? error.data : {}),
          cooperation: ended.evidence || null,
        };
      }
      throw error;
    }
  }

  /** 登记一条人工活动：更新 human-gate；有活跃租约时记冲突（可选立即释放）。 */
  function noteHuman(tabId, facts = {}) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) {
      stats.badArgs += 1;
      return fail(LEASE_ERROR.BAD_ARG, 'noteHuman 需要整数 tabId');
    }
    const tab = tabFor(id);
    const noted = human.noteHuman(id, facts);
    tab.lastHumanAt = noted && noted.signal ? num(noted.signal.at) : now();
    tab.lastHumanKind = noted && noted.signal ? noted.signal.kind : null;
    tab.updatedAt = now();
    const active = activeLeaseList(tab);
    const conflict = active.length > 0;
    let releasedAll = null;
    if (conflict) {
      tab.conflicts += 1;
      stats.conflicts += 1;
      pushBounded(tab.revisionHistory, { at: now(), reason: 'human-conflict', leases: active.length }, historyLimit);
      if (facts && facts.release === true) {
        releasedAll = releaseAll(id, { outcome: 'human-preempted', revokeTokens: true });
      }
    }
    return {
      ok: true,
      tabId: id,
      human: { ...(noted && noted.evidence ? noted.evidence : {}), state: noted && noted.state },
      conflict,
      activeLeases: active.length,
      released: releasedAll ? releasedAll.evidence : null,
      evidence: {
        tabId: id,
        at: now(),
        humanAt: tab.lastHumanAt,
        kind: tab.lastHumanKind,
        conflict,
        activeLeases: active.length,
        released: releasedAll ? releasedAll.released : 0,
      },
    };
  }

  /** 登记内容脚本归因计数（humanAttributed/agentAttributed）。 */
  function noteAttributed(tabId, facts = {}) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return fail(LEASE_ERROR.BAD_ARG, 'noteAttributed 需要整数 tabId');
    const tab = tabFor(id);
    const noted = human.noteAttributed(id, facts);
    const active = activeLeaseList(tab);
    return {
      ok: true,
      tabId: id,
      deltas: noted && noted.deltas ? noted.deltas : { human: 0, agent: 0 },
      conflict: active.length > 0 && noted && noted.deltas && noted.deltas.human > 0,
      activeLeases: active.length,
      evidence: { tabId: id, at: now(), deltas: noted && noted.deltas ? noted.deltas : null, activeLeases: active.length },
    };
  }

  /** 登记一次 Agent 动作：controller 动作计数 + 打开/关闭 self-input 窗口。 */
  function noteAgentAction(tabId, method) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return fail(LEASE_ERROR.BAD_ARG, 'noteAgentAction 需要整数 tabId');
    const tab = tabFor(id);
    const start = now();
    tab.actionCount += 1;
    tab.lastAction = clip(method || '', 64);
    tab.lastActionAt = start;
    tab.updatedAt = start;
    controller.noteAction(id, method);
    human.noteAgentWindow(id, { start, end: Infinity });
    return {
      ok: true,
      tabId: id,
      method: tab.lastAction,
      actionCount: tab.actionCount,
      at: start,
      evidence: { tabId: id, method: tab.lastAction, at: start, actionCount: tab.actionCount },
    };
  }

  /** 结束一次 Agent 动作：关闭 self-input 窗口，避免把之后的人工事件误判成 Agent 自产。 */
  function endAgentAction(tabId, outcome = 'ok') {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return fail(LEASE_ERROR.BAD_ARG, 'endAgentAction 需要整数 tabId');
    human.closeAgentWindow(id, now());
    return { ok: true, tabId: id, outcome: clip(outcome, 24), at: now() };
  }

  /**
   * 动作前互斥判定（只报告）：controller 状态机、借用确认 pending、人机冲突、人工冷却。
   * @param {number} tabId
   * @param {{method?:string, borrowGate?:object, allowCooling?:boolean, requireLease?:boolean, leases?:Array}} [mayActOptions]
   */
  function mayAct(tabId, mayActOptions = {}) {
    const id = normalizeCooperationTabId(tabId);
    const method = clip(mayActOptions.method || '', 64);
    if (id == null) {
      return { allowed: false, code: LEASE_ERROR.BAD_ARG, state: HANDOFF_STATES.IDLE, evidence: { tabId: null, method } };
    }
    const tab = tabs.get(id);
    const leases = mayActOptions.leases != null ? mayActOptions.leases : activeLeaseList(tab);
    const controllerGate = mayActOptions.controllerGate !== undefined
      ? mayActOptions.controllerGate
      : (typeof controller.actionGate === 'function' ? controller.actionGate(id, method) : null);
    const borrowGate = mayActOptions.borrowGate || null;
    const decided = human.exclusive(id, {
      method,
      leases,
      controllerGate,
      borrowGate,
      allowCooling: mayActOptions.allowCooling === true,
    });
    if (decided.allowed && mayActOptions.requireLease === true && (!leases || leases.length === 0)) {
      return {
        allowed: false,
        code: LEASE_ERROR.REQUIRED,
        state: decided.state,
        evidence: { tabId: id, method, reason: 'lease-required', human: decided.evidence },
      };
    }
    const evidence = {
      ...decided.evidence,
      control: controlMayActEvidence(controlPlane, { tabId: id, record: recordFn(id), policy: mayActOptions.policy, context: mayActOptions.context, action: mayActOptions.action || 'guarded', controller: controller.get(id), borrowGate, now: now() }),
      controller: controllerGate ? controllerGate.evidence || null : null,
      borrow: borrowGate ? borrowGate.evidence || null : null,
      leases: Array.isArray(leases) ? leases.length : 0,
      suppression: suppressionEvidence(id),
      handoff: tab ? { ...tab.handoff, history: tab.handoff.history.slice(-4) } : null,
    };
    return { allowed: decided.allowed === true, code: decided.code || null, state: decided.state, evidence };
  }

  /** 读取某 tab 的 handback 状态（只读）。 */
  function handoffState(tabId) {
    const id = normalizeCooperationTabId(tabId);
    const tab = id == null ? null : tabs.get(id);
    if (!tab) {
      return { tabId: id, state: HANDOFF_STATES.IDLE, since: 0, event: null, reason: null, history: [], activeLeases: 0 };
    }
    return {
      tabId: id,
      state: tab.handoff.state,
      since: tab.handoff.since,
      event: tab.handoff.event,
      reason: tab.handoff.reason,
      pendingSince: tab.handoff.pendingSince,
      completedAt: tab.handoff.completedAt,
      history: tab.handoff.history.slice(-8),
      activeLeases: tab.depth,
      sealed: tab.handoff.sealed || null,
    };
  }

  /** 内部 handback 迁移：命中迁移表才改状态，拒绝时给 allowed 列表证据。 */
  function transitionHandoff(tab, event, facts = {}) {
    const rule = handoffRuleFor(tab.handoff.state, event);
    const at = now();
    const fromState = tab.handoff.state;
    if (!rule) {
      const rejection = {
        ok: false,
        code: LEASE_ERROR.HANDOFF,
        error: '非法 handback 迁移：' + tab.handoff.state + ' -[' + event + ']-> ?',
        from: tab.handoff.state,
        event,
        allowed: handoffAllowedEvents(tab.handoff.state),
        evidence: { tabId: tab.tabId, from: tab.handoff.state, event, at, rejected: true },
        taboo: true,
      };
      pushBounded(tab.handoff.history, { kind: 'reject', event, at, from: tab.handoff.state }, historyLimit);
      return rejection;
    }
    // reset 之外的同态迁移是幂等的（多个调用点声明同一事实时不重复计数）。
    const duplicate = rule.to === tab.handoff.state && tab.handoff.event === event;
    if (!duplicate) {
      pushBounded(tab.handoff.history, { kind: 'transition', event, at, from: tab.handoff.state, to: rule.to, facts: clip(facts.reason || '', 80) }, historyLimit);
      tab.handoff.state = rule.to;
      tab.handoff.since = at;
      tab.handoff.event = event;
      tab.handoff.reason = facts.reason == null ? null : clip(facts.reason, 120);
      if (rule.to === HANDOFF_STATES.PENDING) tab.handoff.pendingSince = at;
      if (rule.to === HANDOFF_STATES.DONE) tab.handoff.completedAt = at;
      tab.updatedAt = at;
    }
    const delta = {};
    for (const field of rule.bumps) delta[field] = 1;
    const bumped = Object.keys(delta).length ? bumpFn(tab.tabId, delta) : null;
    return {
      ok: true,
      duplicate,
      tabId: tab.tabId,
      from: fromState,
      to: tab.handoff.state,
      event,
      bumps: rule.bumps.slice(),
      at,
      evidence: { tabId: tab.tabId, from: fromState, to: tab.handoff.state, event, at, duplicate, bumps: rule.bumps.slice(), revision: bumped || null, reason: tab.handoff.reason },
    };
  }

  /** 人工接管：把 handback 状态推到 human-active，并驱动 controller 的 human.take。 */
  function noteHumanTakeover(tabId, facts = {}) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return fail(LEASE_ERROR.BAD_ARG, 'noteHumanTakeover 需要整数 tabId');
    const tab = tabFor(id);
    const moved = transitionHandoff(tab, HANDOFF_EVENTS.HUMAN_TAKE, facts);
    const controllerAttempts = [];
    let controllerMoved = null;
    if (moved.ok) {
      // 人工接管本身也是一次人工活动：登记进 human-gate，后续 acquire/mayAct 才会互斥。
      human.noteHuman(id, {
        at: num(facts.humanAt) || now(),
        kind: 'takeover',
        frameId: facts.frameId,
        source: 'explicit',
      });
      // 人工接管：优先 human.take；controller 还在 idle（无会话）时先 agent.claim 再 human.take，
      // 保证 controller 状态机与 handback 状态机方向一致（都指向 human）。
      controllerMoved = controller.transition(id, 'human.take', {
        source: clip(facts.source || 'cooperate.handoff', 80),
        humanAt: num(facts.humanAt) || now(),
      });
      controllerAttempts.push({ event: 'human.take', ok: controllerMoved && controllerMoved.ok === true, code: controllerMoved ? controllerMoved.code || null : null });
      if (!(controllerMoved && controllerMoved.ok) && controller.get(id) === 'idle') {
        const claimed = controller.transition(id, 'agent.claim', { source: 'cooperate.handoff', hasSession: true });
        controllerAttempts.push({ event: 'agent.claim', ok: claimed && claimed.ok === true, code: claimed ? claimed.code || null : null });
        if (claimed && claimed.ok) {
          controllerMoved = controller.transition(id, 'human.take', { source: clip(facts.source || 'cooperate.handoff', 80), humanAt: num(facts.humanAt) || now() });
          controllerAttempts.push({ event: 'human.take', ok: controllerMoved && controllerMoved.ok === true, code: controllerMoved ? controllerMoved.code || null : null });
        }
      }
      if (controllerMoved && controllerMoved.ok) applyControllerBumps(id, bumpFn, controllerMoved);
    }
    return {
      ok: moved.ok,
      tabId: id,
      state: tab.handoff.state,
      controller: controllerMoved
        ? {
          ok: controllerMoved.ok === true,
          from: controllerMoved.from || null,
          to: controllerMoved.state ? controllerMoved.state.state : null,
          code: controllerMoved.code || null,
          attempts: controllerAttempts,
        }
        : { ok: false, attempts: controllerAttempts },
      evidence: { tabId: id, handoff: moved.evidence, controller: controllerMoved && controllerMoved.evidence ? controllerMoved.evidence : null, attempts: controllerAttempts },
    };
  }

  /**
   * 开始 handback：人工把控制权交回 Agent 的“请求”阶段。
   * 前置：没有活跃 passthrough 租约（否则 E_LEASE_ACTIVE）——绝不能带着令牌交权。
   */
  function beginHandback(tabId, beginOptions = {}) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) {
      stats.badArgs += 1;
      return fail(LEASE_ERROR.BAD_ARG, 'beginHandback 需要整数 tabId');
    }
    const tab = tabFor(id);
    const force = beginOptions.force === true;
    if (tab.depth > 0 && !force) {
      return fail(LEASE_ERROR.ACTIVE, '还有 ' + tab.depth + ' 个 passthrough 租约未释放，不能开始交还', {
        tabId: id,
        activeLeases: activeLeaseList(tab),
        evidence: { tabId: id, reason: 'lease-active', depth: tab.depth, leases: activeLeaseList(tab) },
      });
    }
    if (tab.depth > 0 && force) releaseAll(id, { outcome: 'handback-force', revokeTokens: true });
    if (tab.handoff.state !== HANDOFF_STATES.HUMAN && !force) {
      return fail(LEASE_ERROR.HANDOFF, '当前不是人工操作态（' + tab.handoff.state + '），没有可交还的控制权', {
        tabId: id,
        state: tab.handoff.state,
        allowed: handoffAllowedEvents(tab.handoff.state),
        evidence: { tabId: id, state: tab.handoff.state, reason: 'not-human-active', hint: '先 noteHumanTakeover（人工接管）再 handback' },
      });
    }
    const before = rememberRevision(tab, 'handback-begin');
    let moved;
    if (tab.handoff.state === HANDOFF_STATES.HUMAN) {
      moved = transitionHandoff(tab, HANDOFF_EVENTS.HANDOFF_REQUEST, beginOptions);
      if (!moved.ok) return { ...moved, tabId: id, revisions: { before, after: localVector(id) } };
    } else {
      // force：状态机不允许从当前态直接请求交还时，显式进入 handback-pending（只推进
      // controlRevision），并在 history 里记 force 证据，绝不静默“成功但状态没变”。
      const at = now();
      pushBounded(tab.handoff.history, { kind: 'force', event: HANDOFF_EVENTS.HANDOFF_FORCE, at, from: tab.handoff.state, to: HANDOFF_STATES.PENDING }, historyLimit);
      tab.handoff.state = HANDOFF_STATES.PENDING;
      tab.handoff.since = at;
      tab.handoff.event = HANDOFF_EVENTS.HANDOFF_FORCE;
      tab.handoff.reason = clip(beginOptions.reason || '', 120);
      tab.handoff.pendingSince = at;
      tab.updatedAt = at;
      bumpFn(id, { controlRevision: 1 });
      moved = { ok: true, duplicate: false, from: null, to: HANDOFF_STATES.PENDING, event: HANDOFF_EVENTS.HANDOFF_FORCE, evidence: { tabId: id, force: true, at, from: null, to: HANDOFF_STATES.PENDING } };
    }
    tab.handoff.pendingSince = now();
    stats.handoffs += 1;
    return {
      ok: true,
      tabId: id,
      state: tab.handoff.state,
      reason: clip(beginOptions.reason || '', 120),
      at: now(),
      revisions: { before, after: localVector(id) },
      evidence: {
        tabId: id,
        state: tab.handoff.state,
        reason: clip(beginOptions.reason || '', 120),
        human: humanEvidence(id),
        leases: activeLeaseList(tab),
        overlays: overlayEvidence(id),
        suppression: suppressionEvidence(id),
        controller: controller.snapshot(id),
        revisions: { before, after: localVector(id) },
        at: now(),
      },
    };
  }

  function overlayEvidence(tabId) {
    const overlay = getOverlayState(tabId) || {};
    return {
      capturing: overlay.capturing === true,
      overlays: (Array.isArray(overlay.overlays) ? overlay.overlays : []).map((entry) => ({ kind: clip(entry && entry.kind || '', 32), priority: num(entry && entry.priority), since: num(entry && entry.since) })),
    };
  }

  /**
   * 结算 handback：驱动 controller 回到 agent 态，并把 revision 前后向量 + stale 方向
   * 一起封成可校验证据。
   */
  function completeHandback(tabId, completeOptions = {}) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return fail(LEASE_ERROR.BAD_ARG, 'completeHandback 需要整数 tabId');
    const tab = tabFor(id);
    if (tab.depth > 0) {
      return fail(LEASE_ERROR.ACTIVE, '还有 ' + tab.depth + ' 个 passthrough 租约未释放，不能完成交还', {
        tabId: id,
        activeLeases: activeLeaseList(tab),
        evidence: { tabId: id, reason: 'lease-active', depth: tab.depth },
      });
    }
    const before = rememberRevision(tab, 'handback-before');
    const move = transitionHandoff(tab, HANDOFF_EVENTS.HANDOFF_COMPLETE, completeOptions);
    if (!move.ok && completeOptions.force !== true) return { ...move, tabId: id, revisions: { before, after: localVector(id) } };
    // 驱动 controller：human.return（human→agent）/ handoff.settle.agent（handoff→agent）/
    // agent.claim（idle|agent→agent）按优先级依次尝试，只接受第一条合法迁移。
    const attempts = [];
    let accepted = null;
    for (const event of ['human.return', 'handoff.settle.agent', 'agent.claim']) {
      const moved = controller.transition(id, event, {
        source: 'cooperate.handback',
        hasSession: completeOptions.hasSession !== false,
        reason: clip(completeOptions.reason || '', 120),
      });
      attempts.push({ event, ok: moved && moved.ok === true, code: moved ? moved.code || null : null, duplicate: moved ? moved.duplicate === true : false });
      if (moved && moved.ok) {
        accepted = { event, moved };
        applyControllerBumps(id, bumpFn, moved);
        break;
      }
    }
    const after = rememberRevision(tab, 'handback-after');
    const comparison = compareRevisionVectors(before, after);
    const entries = [
      { kind: 'handback.before', at: before && now(), vector: before },
      { kind: 'handback.controller', accepted: accepted ? accepted.event : null, attempts },
      { kind: 'handback.after', at: after && now(), vector: after },
    ];
    const sealed = {
      tabId: id,
      state: tab.handoff.state,
      sealedAt: now(),
      entries,
      digest: evidenceDigest(entries),
      revision: { before, after, stale: comparison.stale, side: comparison.side, fields: comparison.fields },
      human: humanEvidence(id),
      leases: activeLeaseList(tab),
    };
    tab.handoff.sealed = sealed;
    stats.handbackCompletes += 1;
    return {
      ok: true,
      tabId: id,
      state: tab.handoff.state,
      controller: { accepted: accepted ? accepted.event : null, attempts },
      revisions: sealed.revision,
      sealed,
      evidence: {
        tabId: id,
        state: tab.handoff.state,
        controller: { accepted: accepted ? accepted.event : null, attempts },
        revisions: sealed.revision,
        human: sealed.human,
        leases: sealed.leases,
        digest: sealed.digest,
      },
    };
  }

  /** 中止 handback：回到 human-active（人工还在操作），并把原因写进证据。 */
  function abortHandback(tabId, abortOptions = {}) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return fail(LEASE_ERROR.BAD_ARG, 'abortHandback 需要整数 tabId');
    const tab = tabFor(id);
    const moved = transitionHandoff(tab, HANDOFF_EVENTS.HANDOFF_ABORT, abortOptions);
    if (moved.ok) {
      const rejected = controller.transition(id, 'handoff.abort', { reason: clip(abortOptions.reason || '', 120), source: 'cooperate.handback.abort' });
      if (rejected && rejected.ok) applyControllerBumps(id, bumpFn, rejected);
    }
    stats.handbackAborts += moveCount(moved);
    return {
      ok: moved.ok,
      tabId: id,
      state: tab.handoff.state,
      reason: clip(abortOptions.reason || '', 120),
      evidence: { tabId: id, state: tab.handoff.state, reason: clip(abortOptions.reason || '', 120), transition: moved.evidence || null },
    };
  }

  function moveCount(moved) { return moved && moved.ok && moved.duplicate !== true ? 1 : 0; }

  /** 交还证据自校验：重算 digest，确认链没有被事后改动。 */
  function verifyHandback(sealed) {
    if (!sealed || !Array.isArray(sealed.entries)) {
      return { ok: false, code: 'HANDOFF_EVIDENCE_MISMATCH', error: '证据缺失或结构不对' };
    }
    const digest = evidenceDigest(sealed.entries);
    return {
      ok: digest === sealed.digest,
      code: digest === sealed.digest ? null : 'HANDOFF_EVIDENCE_MISMATCH',
      expected: sealed.digest,
      actual: digest,
      entries: sealed.entries.length,
    };
  }

  /** revision 全链路：当前向量 + 最近变化历史 + 最近一次对外对齐的 stale 方向。 */
  function revisionTrace(tabId) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return fail(LEASE_ERROR.BAD_ARG, 'revisionTrace 需要整数 tabId');
    const tab = tabFor(id);
    return {
      ok: true,
      tabId: id,
      vector: localVector(id),
      generation: controlGeneration(id),
      record: controlGenerationRecord(id),
      history: tab.revisionHistory.slice(-8),
      handoffSealed: tab.handoff.sealed ? { digest: tab.handoff.sealed.digest, at: tab.handoff.sealed.sealedAt } : null,
    };
  }

  /**
   * 把内容脚本/会话给出的 revision 向量与本地对齐（复用 control-generation 的
   * align 语义：每字段取 max，绝不倒退），返回 stale 方向证据。
   */
  function alignRevision(tabId, remote = {}) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return fail(LEASE_ERROR.BAD_ARG, 'alignRevision 需要整数 tabId');
    const tab = tabFor(id);
    const result = alignFn(id, remote);
    if (!result || result.ok === false) {
      return { ok: false, code: (result && result.code) || 'E_COOPERATION_STALE', tabId: id, evidence: { tabId: id, remote } };
    }
    rememberRevision(tab, result.stale ? 'align-stale' : 'align');
    return {
      ok: true,
      tabId: id,
      stale: result.stale === true,
      side: result.side || null,
      fields: Array.isArray(result.fields) ? result.fields : [],
      aligned: result.aligned || null,
      local: result.local || null,
      remote: result.remote || null,
      evidence: { tabId: id, stale: result.stale === true, side: result.side || null, fields: result.fields || [], alignedAt: result.evidence ? result.evidence.alignedAt : now() },
    };
  }

  /** 只读快照：租约栈 + 抑制 + handback + 人机 + revision + 浮层。 */
  function snapshot(tabId) {
    const id = normalizeCooperationTabId(tabId);
    const tab = id == null ? null : tabs.get(id);
    const leases = activeLeaseList(tab);
    return {
      tabId: id,
      valid: tab != null,
      at: now(),
      control: controlPlane.snapshot(id),
      depth: tab ? tab.depth : 0,
      leases,
      minted: tab ? tab.minted : 0,
      consumed: tab ? tab.consumed : 0,
      conflicts: tab ? tab.conflicts : 0,
      handoff: handoffState(id),
      human: humanEvidence(id),
      suppression: suppressionEvidence(id),
      overlays: id == null ? { capturing: false, overlays: [] } : overlayEvidence(id),
      controller: id == null ? null : controller.snapshot(id),
      revisions: localVector(id),
      lastAction: tab ? { method: tab.lastAction, at: tab.lastActionAt, count: tab.actionCount } : { method: null, at: 0, count: 0 },
      counters: { ...stats, tabs: tabs.size },
    };
  }

  /** 一行摘要。 */
  function summary(tabId) {
    return describeCooperationState(snapshot(tabId));
  }

  /** tab 关闭/会话结束：清空租约（fail closed）、人机状态与 revision 历史。 */
  function forget(tabId) {
    const id = normalizeCooperationTabId(tabId);
    if (id == null) return { ok: false, code: LEASE_ERROR.BAD_ARG };
    const released = releaseAll(id, { outcome: 'tab-closed', revokeTokens: true });
    controlPlane.forget(id);
    human.clear(id);
    tabs.delete(id);
    return { ok: true, tabId: id, released: released.released, remaining: 0 };
  }

  function list() {
    return [...tabs.keys()].map((id) => snapshot(id));
  }

  function counters() {
    return { ...stats, tabs: tabs.size, depth: [...tabs.values()].reduce((total, tab) => total + tab.depth, 0) };
  }

  function reset() {
    const cleared = tabs.size;
    tabs.clear();
    return { ok: true, cleared };
  }

  return {
    acquire,
    release,
    releaseAll,
    withLease,
    locate,
    noteHuman,
    noteAttributed,
    noteHumanTakeover,
    noteAgentAction,
    endAgentAction,
    mayAct,
    beginHandback,
    completeHandback,
    abortHandback,
    verifyHandback,
    handoffState,
    revisionTrace,
    alignRevision,
    snapshot,
    summary,
    suppressionEvidence,
    humanEvidence,
    forget,
    list,
    counters,
    reset,
    get maxDepth() { return defaultMaxDepth; },
    get ttlMs() { return defaultTtlMs; },
  };
}

/** 后台共享单例：borrow.js（交还证据闭环）与诊断快照共用。 */
export const cooperationCoordinator = createCooperationCoordinator();
