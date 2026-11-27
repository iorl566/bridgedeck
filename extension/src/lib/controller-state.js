// src/lib/controller-state.js —— 协作 controller 的显式状态机（合法迁移表 + 拒绝证据）。
//
// 0.3.0 之前“谁在控制这个标签页”散落在 takeover / tabs-borrow / control 三处临时
// Map 里，没有迁移表：非法组合只能靠人工阅读调用点推断，出问题时也无法复现
// “当时为什么允许/拒绝”。本模块把控制权收敛成 6 个状态 + 一张显式迁移表：
//
//   idle     没有会话、借用、接管，谁都没控制
//   agent    Agent 持有控制权（cooperate sync 之后）
//   human    人工正在操作（检测到人工输入，或 request-help 后人工介入）
//   borrowed 用户标签页已通过借用确认，Agent 可动作但归属仍是用户
//   held     显式暂停（cooperate hold）；动作被 E_SESSION_PAUSED 拒绝
//   handoff  控制权交接中的瞬时态（借用确认未决、人工↔Agent 交接中）
//
// 迁移必须命中迁移表；未命中的迁移被拒绝并返回 { from, event, to, allowed }
// 证据（deny-by-default）。同状态迁移是幂等的（duplicate=true），便于多个调用点
// 重复声明同一个事实而不互相打脸。本模块不碰 DOM/chrome，纯内存 + 可注入时钟，
// 便于 Node 单测与 service worker 内复用。

export const CONTROLLER_STATES = Object.freeze({
  IDLE: 'idle',
  AGENT: 'agent',
  HUMAN: 'human',
  BORROWED: 'borrowed',
  HELD: 'held',
  HANDOFF: 'handoff',
});

export const CONTROLLER_STATE_LIST = Object.freeze([
  CONTROLLER_STATES.IDLE,
  CONTROLLER_STATES.AGENT,
  CONTROLLER_STATES.HUMAN,
  CONTROLLER_STATES.BORROWED,
  CONTROLLER_STATES.HELD,
  CONTROLLER_STATES.HANDOFF,
]);

export const CONTROLLER_EVENTS = Object.freeze({
  AGENT_CLAIM: 'agent.claim',
  HUMAN_TAKE: 'human.take',
  HUMAN_RETURN: 'human.return',
  BORROW_REQUEST: 'borrow.request',
  BORROW_CONFIRM: 'borrow.confirm',
  BORROW_DENY: 'borrow.deny',
  BORROW_RETURN: 'borrow.return',
  HOLD_ENGAGE: 'hold.engage',
  HOLD_RELEASE: 'hold.release',
  HANDOFF_START: 'handoff.start',
  HANDOFF_SETTLE_AGENT: 'handoff.settle.agent',
  HANDOFF_SETTLE_HUMAN: 'handoff.settle.human',
  HANDOFF_ABORT: 'handoff.abort',
  RESET: 'reset',
});

// 迁移表：from + event -> to。bumps 声明这次迁移推进哪些计数（四项 revision/epoch
// 由 revision-chain 承载，这里只声明增量意图，调用方决定是否落到链上）。
//   controlRevision   控制面变化（接管/交回/借用/暂停/交接）
//   authorityRevision 动作许可被撤销（人工介入、暂停）
//   frameEpoch        文档/frame 集合变化（借用确认会重建浮层，视作 frame 变更）
const TRANSITIONS = Object.freeze([
  // 空闲态：Agent 认领、发起借用确认、显式暂停。
  { from: ['idle'], event: 'agent.claim', to: 'agent', bumps: ['controlRevision'] },
  { from: ['idle'], event: 'borrow.request', to: 'handoff', bumps: ['controlRevision'] },
  { from: ['idle'], event: 'hold.engage', to: 'held', bumps: ['controlRevision', 'authorityRevision'] },
  // Agent 持有：人工介入、暂停、交接、借用确认。
  { from: ['agent'], event: 'human.take', to: 'human', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['agent'], event: 'hold.engage', to: 'held', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['agent'], event: 'handoff.start', to: 'handoff', bumps: ['controlRevision'] },
  { from: ['agent'], event: 'borrow.request', to: 'handoff', bumps: ['controlRevision'] },
  { from: ['agent'], event: 'borrow.confirm', to: 'borrowed', bumps: ['controlRevision', 'frameEpoch'] },
  { from: ['agent'], event: 'agent.claim', to: 'agent', bumps: [] },
  // 人工持有：交回 Agent、暂停、开始借用确认。
  { from: ['human'], event: 'agent.claim', to: 'agent', bumps: ['controlRevision'] },
  { from: ['human'], event: 'human.return', to: 'agent', bumps: ['controlRevision'] },
  { from: ['human'], event: 'hold.engage', to: 'held', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['human'], event: 'borrow.request', to: 'handoff', bumps: ['controlRevision'] },
  { from: ['human'], event: 'human.take', to: 'human', bumps: [] },
  // 借用态：Agent 接管、人工介入、暂停、归还、进入交接。
  { from: ['borrowed'], event: 'agent.claim', to: 'agent', bumps: ['controlRevision'] },
  { from: ['borrowed'], event: 'human.take', to: 'human', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['borrowed'], event: 'hold.engage', to: 'held', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['borrowed'], event: 'borrow.return', to: 'idle', bumps: ['controlRevision'] },
  { from: ['borrowed'], event: 'handoff.start', to: 'handoff', bumps: ['controlRevision'] },
  { from: ['borrowed'], event: 'borrow.confirm', to: 'borrowed', bumps: [] },
  // 暂停态：只有显式恢复、借用确认之后才离开；held 不能直接进交接（先恢复）。
  { from: ['held'], event: 'hold.release', to: 'agent', bumps: ['controlRevision'] },
  { from: ['held'], event: 'agent.claim', to: 'agent', bumps: ['controlRevision'] },
  { from: ['held'], event: 'human.take', to: 'human', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['held'], event: 'borrow.confirm', to: 'borrowed', bumps: ['controlRevision', 'frameEpoch'] },
  { from: ['held'], event: 'hold.engage', to: 'held', bumps: [] },
  // 交接态：只能结算到 agent/human/borrowed，或中止回 idle。
  { from: ['handoff'], event: 'handoff.settle.agent', to: 'agent', bumps: ['controlRevision'] },
  { from: ['handoff'], event: 'handoff.settle.human', to: 'human', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['handoff'], event: 'agent.claim', to: 'agent', bumps: ['controlRevision'] },
  { from: ['handoff'], event: 'borrow.confirm', to: 'borrowed', bumps: ['controlRevision', 'frameEpoch'] },
  { from: ['handoff'], event: 'borrow.deny', to: 'idle', bumps: ['controlRevision'] },
  { from: ['handoff'], event: 'handoff.abort', to: 'idle', bumps: ['controlRevision'] },
  { from: ['handoff'], event: 'hold.engage', to: 'held', bumps: ['controlRevision', 'authorityRevision'] },
  // 显式 reset：从任何状态回到 idle（tab 关闭、会话停止、接管浮层清除）。
  { from: CONTROLLER_STATE_LIST, event: 'reset', to: 'idle', bumps: ['controlRevision'] },
]);

/** 迁移表索引：`from|event` -> rule。同一 from+event 只能有一条规则。 */
const RULE_INDEX = new Map();
for (const rule of TRANSITIONS) {
  for (const from of rule.from) {
    const key = from + '|' + rule.event;
    if (RULE_INDEX.has(key)) throw new Error('controller 迁移表重复：' + key);
    RULE_INDEX.set(key, rule);
  }
}

/** 校验器表：事件在迁移前必须带上的事实（deny-by-default 的前置条件）。 */
const GUARDS = Object.freeze({
  // 借用确认必须有用户确认结果，否则只是“请求”，绝不能直接进 borrowed。
  'borrow.confirm': (facts) => {
    if (facts.confirmed !== true) return { code: 'BORROW_CONFIRM_REQUIRED', error: '借用尚未确认，不能进入 borrowed 态', field: 'confirmed' };
    if (facts.requestId != null && facts.decision != null && String(facts.decision) !== 'allow') {
      return { code: 'E_BORROW_DENIED', error: '用户决定不是 allow，不能进入 borrowed 态', field: 'decision' };
    }
    return null;
  },
  // Agent 认领必须有会话事实；显式 hasSession=false 说明会话已结束，不能认领。
  'agent.claim': (facts) => (facts.hasSession === false
    ? { code: 'E_CONTROL_NOT_HELD', error: '会话已结束，不能认领控制权', field: 'hasSession' }
    : null),
  // 借用请求必须能定位到一次确认（requestId），否则无法追踪谁批的。
  'borrow.request': (facts) => (facts.requestId == null
    ? { code: 'E_BORROW_CONFLICT', error: '借用请求缺少 requestId，不能进入 handoff 态', field: 'requestId' }
    : null),
  // 人工接管需要来源事实，避免“凭空”把状态翻到 human。
  'human.take': (facts) => (facts.source == null && facts.humanAt == null
    ? { code: 'E_CONTROL_STALE', error: '人工接管缺少来源证据（source/humanAt）', field: 'source' }
    : null),
});

/** 某个状态允许的迁移（供 CLI/诊断展示，也用于拒绝证据里的 allowed 列表）。 */
export function allowedTransitions(from) {
  const state = CONTROLLER_STATE_LIST.includes(from) ? from : CONTROLLER_STATES.IDLE;
  return TRANSITIONS
    .filter((rule) => rule.from.includes(state))
    .map((rule) => ({ event: rule.event, to: rule.to, bumps: rule.bumps.slice() }));
}

/** 迁移表快照（只读），供单测与文档审计确认没有重复/悬空规则。 */
export function controllerTransitionTable() {
  return TRANSITIONS.map((rule) => ({ from: rule.from.slice(), event: rule.event, to: rule.to, bumps: rule.bumps.slice() }));
}

/**
 * 把一次迁移的 bumps 声明转成 revision-chain 的增量对象。
 * 计数写入口只有一个（control-generation.bumpRevisions），本函数只做纯映射。
 */
export function transitionBumps(moved) {
  const bumps = moved && moved.evidence && Array.isArray(moved.evidence.bumps) ? moved.evidence.bumps : [];
  const delta = {};
  for (const field of ['controlRevision', 'authorityRevision', 'frameEpoch', 'epoch', 'generation']) {
    if (bumps.includes(field)) delta[field] = 1;
  }
  return delta;
}

/** 当前状态是否允许该事件（不看 guards，只看迁移表）。 */
export function canTransition(from, event) {
  return RULE_INDEX.has(String(from) + '|' + String(event));
}

function emptyRecord(tabId, now) {
  return {
    tabId,
    state: CONTROLLER_STATES.IDLE,
    since: now,
    event: null,
    holder: null,
    controlRevision: 0,
    authorityRevision: 0,
    frameEpoch: 0,
    transitions: 0,
    rejected: 0,
    lastRejection: null,
    history: [],
  };
}

/** 迁移记录进 history（有界，最近的在前），供 CLI/报告复现“怎么走到这个状态的”。 */
function pushHistory(record, entry, limit) {
  record.history.push(entry);
  if (record.history.length > limit) record.history.splice(0, record.history.length - limit);
}

function normalizeTab(tabId) {
  // null/''/非数字都不是合法 tabId（Number(null)===0 会把“没传”误判成 tab 0）。
  if (tabId == null || tabId === '') return null;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : null;
}

/**
 * 创建一个独立的 controller 状态机；每个实例有独立的时钟/history 上限，便于单测隔离。
 * @param {{now?: () => number, historyLimit?: number, maxTabs?: number}} [options]
 */
export function createControllerStateMachine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const historyLimit = Number.isInteger(options.historyLimit) && options.historyLimit > 0 ? options.historyLimit : 32;
  const maxTabs = Number.isInteger(options.maxTabs) && options.maxTabs > 0 ? options.maxTabs : 512;
  const tabs = new Map();
  const stats = { transitions: 0, rejected: 0, duplicates: 0, resets: 0 };

  function recordFor(tabId) {
    const id = normalizeTab(tabId);
    if (id == null) return null;
    let record = tabs.get(id);
    if (!record) {
      // 简单 LRU：超过上限时丢最早插入的记录（tab 已关闭的典型场景）。
      if (tabs.size >= maxTabs) {
        const oldest = tabs.keys().next().value;
        if (oldest !== undefined) tabs.delete(oldest);
      }
      record = emptyRecord(id, now());
      tabs.set(id, record);
    }
    return record;
  }

  /** 拒绝一次迁移：不改状态，只记证据（含 allowed 列表，便于调用方自我修复）。 */
  function reject(record, event, to, facts, code, message) {
    const at = now();
    const evidence = {
      tabId: record.tabId,
      from: record.state,
      event,
      to: to == null ? null : String(to),
      allowed: allowedTransitions(record.state),
      code,
      error: message,
      at,
      facts: summarizeFacts(facts),
    };
    record.rejected += 1;
    record.lastRejection = evidence;
    stats.rejected += 1;
    pushHistory(record, { kind: 'reject', event, at, code, from: record.state }, historyLimit);
    return { ok: false, code, error: message, tabId: record.tabId, state: record.state, evidence };
  }

  function accept(record, rule, event, facts, duplicate) {
    const at = now();
    const from = record.state;
    if (!duplicate) {
      record.state = rule.to;
      record.since = at;
      record.event = event;
      record.holder = facts.holder != null ? String(facts.holder).slice(0, 80) : record.holder;
      record.transitions += 1;
      stats.transitions += 1;
      const bumps = Array.isArray(rule.bumps) ? rule.bumps : [];
      if (bumps.includes('controlRevision')) record.controlRevision += 1;
      if (bumps.includes('authorityRevision')) record.authorityRevision += 1;
      if (bumps.includes('frameEpoch')) record.frameEpoch += 1;
      pushHistory(record, { kind: 'transition', event, at, from, to: rule.to }, historyLimit);
    } else {
      stats.duplicates += 1;
    }
    return {
      ok: true,
      duplicate,
      tabId: record.tabId,
      from,
      to: record.state,
      state: snapshotOf(record),
      evidence: {
        tabId: record.tabId,
        from,
        event,
        to: record.state,
        bumps: (rule.bumps || []).slice(),
        duplicate,
        at,
        facts: summarizeFacts(facts),
      },
    };
  }

  /**
   * 迁移一次。两种调用方式都支持：
   *   transition(tabId, 'hold.engage', { source: 'cooperate.hold' })
   *   transition(tabId, { event: 'borrow.confirm', confirmed: true, requestId })
   * @returns {{ok:boolean, code?:string, error?:string, from?:string, to?:string, state?:object, evidence:object}}
   */
  function transition(tabId, eventOrOptions, factsInput = {}) {
    const id = normalizeTab(tabId);
    if (id == null) {
      return { ok: false, code: 'E_BAD_ARG', error: 'controller 迁移需要整数 tabId', tabId: null, evidence: { tabId: null } };
    }
    const optionsObject = eventOrOptions && typeof eventOrOptions === 'object' ? eventOrOptions : null;
    const event = optionsObject ? String(optionsObject.event || optionsObject.to || '') : String(eventOrOptions || '');
    const facts = optionsObject ? { ...optionsObject, ...factsInput } : { ...(factsInput || {}) };
    const record = recordFor(id);
    if (!event) return reject(record, '', null, facts, 'E_BAD_ARG', 'controller 迁移缺少 event');
    const rule = RULE_INDEX.get(record.state + '|' + event);
    if (!rule) {
      return reject(
        record,
        event,
        facts.to,
        facts,
        'CONTROLLER_TRANSITION',
        '非法 controller 迁移：' + record.state + ' -[' + event + ']-> ' + (facts.to || '?'),
      );
    }
    const guard = GUARDS[event];
    if (guard) {
      const blocked = guard(facts);
      if (blocked) return reject(record, event, rule.to, facts, blocked.code, blocked.error);
    }
    // 同一状态迁移是幂等的：多个调用点声明同一个事实时不打脸、不重复计数。
    const duplicate = rule.to === record.state && record.event === event;
    return accept(record, rule, event, facts, duplicate);
  }

  /** 外部权威（内容脚本/持久化恢复）给出的状态：直接采纳但不走迁移表，仍留证据。 */
  function adopt(tabId, state, facts = {}) {
    const id = normalizeTab(tabId);
    const next = CONTROLLER_STATE_LIST.includes(state) ? state : null;
    if (id == null || next == null) {
      return { ok: false, code: 'E_BAD_ARG', error: 'adopt 需要整数 tabId 与合法状态', tabId: id, evidence: { tabId: id, state } };
    }
    const record = recordFor(id);
    const at = now();
    const from = record.state;
    record.state = next;
    record.since = at;
    record.event = facts.event ? String(facts.event) : 'adopt';
    record.holder = facts.holder != null ? String(facts.holder).slice(0, 80) : record.holder;
    pushHistory(record, { kind: 'adopt', event: record.event, at, from, to: next }, historyLimit);
    return { ok: true, tabId: id, from, to: next, state: snapshotOf(record), evidence: { tabId: id, from, to: next, at, source: 'adopt' } };
  }

  /** 记录一次 Agent 动作（不改变状态，只累计动作计数与最近动作，供 toolbar/CLI 展示）。 */
  function noteAction(tabId, method, facts = {}) {
    const record = recordFor(tabId);
    if (!record) return null;
    record.actionCount = (record.actionCount || 0) + 1;
    record.lastActionAt = Number(facts.at) || now();
    record.lastAction = String(method || '').slice(0, 64);
    return { tabId: record.tabId, actionCount: record.actionCount, lastAction: record.lastAction, lastActionAt: record.lastActionAt };
  }

  function snapshotOf(record) {
    if (!record) return null;
    return {
      tabId: record.tabId,
      state: record.state,
      since: record.since,
      event: record.event,
      holder: record.holder,
      controlRevision: record.controlRevision,
      authorityRevision: record.authorityRevision,
      frameEpoch: record.frameEpoch,
      transitions: record.transitions,
      rejected: record.rejected,
      actionCount: record.actionCount || 0,
      lastAction: record.lastAction || null,
      lastActionAt: record.lastActionAt || 0,
      lastRejection: record.lastRejection,
      history: record.history.slice(-8),
    };
  }

  function snapshot(tabId) {
    const id = normalizeTab(tabId);
    if (id == null) return null;
    return snapshotOf(tabs.get(id));
  }

  function get(tabId) {
    const id = normalizeTab(tabId);
    const record = id == null ? null : tabs.get(id);
    return record ? record.state : null;
  }

  function history(tabId) {
    const id = normalizeTab(tabId);
    const record = id == null ? null : tabs.get(id);
    return record ? record.history.slice() : [];
  }

  /** 动作闸门：held 拒绝动作、handoff 拒绝动作（借用确认未决）。 */
  function actionGate(tabId, method = '') {
    const id = normalizeTab(tabId);
    const record = id == null ? null : tabs.get(id);
    const state = record ? record.state : CONTROLLER_STATES.IDLE;
    if (state === CONTROLLER_STATES.HELD) {
      return { allowed: false, state, code: 'E_SESSION_PAUSED', reason: 'held', evidence: { tabId: id, state, method, since: record ? record.since : null } };
    }
    if (state === CONTROLLER_STATES.HANDOFF) {
      return { allowed: false, state, code: 'E_BORROW_CONFLICT', reason: 'handoff', evidence: { tabId: id, state, method, since: record ? record.since : null } };
    }
    return { allowed: true, state, code: null, reason: null, evidence: { tabId: id, state, method } };
  }

  function list() {
    return [...tabs.keys()].map((id) => snapshotOf(tabs.get(id)));
  }

  function clear(tabId) {
    const id = normalizeTab(tabId);
    if (id == null) return false;
    const cleared = tabs.delete(id);
    if (cleared) stats.resets += 1;
    return cleared;
  }

  function counters() {
    return { ...stats, tabs: tabs.size, states: list().reduce((counts, record) => { counts[record.state] = (counts[record.state] || 0) + 1; return counts; }, {}) };
  }

  return { transition, adopt, noteAction, snapshot, get, history, actionGate, list, clear, counters, allowedTransitions };
}

function summarizeFacts(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const summary = {};
  for (const key of ['source', 'requestId', 'decision', 'confirmed', 'holder', 'humanAt', 'hasSession', 'reason']) {
    if (facts[key] === undefined) continue;
    summary[key] = typeof facts[key] === 'string' ? facts[key].slice(0, 120) : facts[key];
  }
  return Object.keys(summary).length ? summary : null;
}

/** 后台共享单例：control / tabs-borrow / takeover 的迁移都记在这里。 */
export const controllerState = createControllerStateMachine();
