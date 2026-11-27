// src/lib/human-gate.js —— 人机互斥闸门：人工活动归因、冷却窗与冲突证据。
//
// 0.3.0 的“人机互斥”只有两个孤立的判断：
//   - cooperate.wait / cooperate.sync 里用 human-state 的 at 时间戳近似判断“刚才有人动过”；
//   - dispatch.js 用 agentInputWindows 排除 Agent 自己产生的 trusted 事件。
// 这两处各自为政，导致三个真实问题：
//   1. 归因口径不一致：内容脚本的 humanAttributed 计数、human-state 快照、Agent 输入窗口
//      三套时间基准，跨 frame 时会出现“同一秒内既算人又算 Agent”；
//   2. 冷却窗缺失：人工刚停手 100ms，Agent 的 passthrough 就开始了，用户的键盘焦点被抢；
//   3. 冲突没有证据：人机同时操作时只有一个布尔，“谁先按的、差多少毫秒、在哪个 frame”
//      在事后诊断里查不到。
//
// 本模块把“现在能不能确认是人工在操作”收敛成一份可证据化的判定：
//   noteHuman(tabId, facts)      登记一条人工信号（来自 human-state / 内容脚本 / 显式来源）
//   noteAgentWindow(tabId, w)   登记 Agent 输入窗口（dispatch 的自产事件排除）
//   noteAttributed(tabId, f)    登记内容脚本的 humanAttributed/agentAttributed 计数
//   settle(tabId)               按时钟推进状态机：idle → human-active → cooling → idle / conflict
//   exclusive(tabId, options)   给调用方一个“现在能不能动作”的判定（含拒绝证据）
//
// 约定：
//   - 纯内存 + 可注入时钟，不碰 DOM/chrome，便于 Node 单测与 service worker 内复用；
//   - 判定只报告、不处决：真正是否拦截由调用方（cooperate.js / dispatch.js）决定，
//     本模块只保证“判定与证据一致”；
//   - 时间容差默认 ±1.5ms，与 attribution-evidence.js 的归因容差保持一致；
//   - 所有入口对非法 tabId/时间返回结构化失败，绝不抛异常（动作路径不能被观测代码打断）。
//
// 第二轮（证据链）：
//   - 每条人工/Agent 信号同时进 human-gate-chain 的哈希链（prevDigest+digest），
//     state()/exclusive()/evidence() 只新增 chain 字段，判定结果完全不变；
//   - exclusive() 额外产出 cooperation 证据包（cooperate-evidence.js），把“这次判定当时
//     看到的 human/controller/borrow/租约栈”封成 digest + 链节；cooperate.js 的 mayAct
//     会把 decided.evidence 原样并进自己的 evidence（cooperate.js:650-657），无需改它；
//   - 人机冲突额外产出可校验的冲突证书（conflictCertificate）；
//   - chainEvidence(tabId) 返回封存链 + 校验结论，供 CLI/诊断/借用证据链对账。

import {
  humanConflictCertificate,
  humanSignalEntry,
  normalizeHumanChainSignal,
  sealHumanChain,
  summarizeHumanChain,
  verifyHumanChain,
} from './human-gate-chain.js';
import {
  chainMayActEvidence,
  mayActEvidence,
  summarizeMayActEvidence,
  verifyMayActChain,
} from './cooperate-evidence.js';

export const HUMAN_GATE_STATES = Object.freeze({
  IDLE: 'idle',
  HUMAN_ACTIVE: 'human-active',
  COOLING: 'cooling',
  CONFLICT: 'conflict',
});

export const HUMAN_GATE_STATE_LIST = Object.freeze([
  HUMAN_GATE_STATES.IDLE,
  HUMAN_GATE_STATES.HUMAN_ACTIVE,
  HUMAN_GATE_STATES.COOLING,
  HUMAN_GATE_STATES.CONFLICT,
]);

export const HUMAN_SIGNAL_SOURCES = Object.freeze({
  HUMAN_STATE: 'human-state',
  CONTENT_ACTIVITY: 'content-activity',
  ATTRIBUTED: 'attributed',
  EXPLICIT: 'explicit',
  AGENT_WINDOW: 'agent-window',
});

export const HUMAN_GATE_CODES = Object.freeze({
  HUMAN_ACTIVE: 'E_HUMAN_GATE',
  HUMAN_COOLING: 'E_HUMAN_GATE',
  HUMAN_CONFLICT: 'E_HUMAN_GATE',
  BAD_ARG: 'E_BAD_ARG',
});

const DEFAULT_ACTIVE_MS = 2000;
const DEFAULT_COOLING_MS = 500;
const DEFAULT_TOLERANCE_MS = 1.5;
const DEFAULT_AGENT_WINDOW_AFTER_MS = 500;
const DEFAULT_AGENT_WINDOW_BEFORE_MS = 50;
const DEFAULT_HISTORY_LIMIT = 32;
const DEFAULT_MAX_TABS = 512;
const DEFAULT_CONFLICT_LIMIT = 16;

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clip(text, limit) {
  return String(text == null ? '' : text).slice(0, limit);
}

/** tabId 规整：null/''/非整数都视为没有 tab（Number(null)===0 会把“没传”误判成 tab 0）。 */
export function normalizeHumanTabId(tabId) {
  if (tabId == null || tabId === '') return null;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : null;
}

function tabKey(tabId) {
  return normalizeHumanTabId(tabId);
}

/**
 * 把各种来源的人工信号规整成统一形状。
 * @param {object} signal
 * @returns {{ok:boolean, code?:string, signal?:object}}
 */
export function normalizeHumanSignal(signal) {
  if (!signal || typeof signal !== 'object') {
    return { ok: false, code: HUMAN_GATE_CODES.BAD_ARG, error: '人工信号必须是对象' };
  }
  const source = Object.values(HUMAN_SIGNAL_SOURCES).includes(signal.source)
    ? signal.source
    : HUMAN_SIGNAL_SOURCES.EXPLICIT;
  const kind = clip(signal.kind || signal.type || 'input', 32) || 'input';
  const frameId = Number.isInteger(Number(signal.frameId)) ? Number(signal.frameId) : 0;
  return {
    ok: true,
    signal: {
      at: Math.max(0, num(signal.at)),
      kind,
      frameId,
      label: clip(signal.label || signal.target || '', 120),
      source,
      trusted: signal.trusted !== false,
      agentAttributed: signal.agentAttributed === true,
      count: Math.max(0, Math.floor(num(signal.count))),
      revision: Number.isInteger(Number(signal.revision)) ? Number(signal.revision) : null,
      certificate: signal.certificate == null ? null : clip(signal.certificate, 64),
    },
  };
}

/** Agent 输入窗口规整：start/end 任一非法都返回 null（宁可不排除，也不误排除人工事件）。 */
export function normalizeAgentWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const start = num(window.start);
  if (!(start > 0)) return null;
  const end = window.end === Infinity ? Infinity : Math.max(start, num(window.end) || start);
  return { start, end };
}

/** 时间是否落在 Agent 输入窗口内（含容差）：命中即“这是 Agent 自产事件”。 */
export function isWithinAgentWindow(at, window, options = {}) {
  const normalized = normalizeAgentWindow(window);
  if (!normalized) return false;
  const tolerance = Math.max(0, num(options.toleranceMs));
  const before = Math.max(tolerance, num(options.beforeMs));
  const after = Math.max(tolerance, num(options.afterMs));
  const time = num(at);
  if (!(time > 0)) return false;
  return time >= normalized.start - before && time <= normalized.end + after;
}

/**
 * 单条信号归因：human / agent / unknown，附判定依据（basis/confidence）。
 * 规则优先级：显式标记的 agent 事实 > Agent 输入窗口 > trusted 人工信号 > 计数来源。
 */
export function classifyHumanSignal(signalInput, options = {}) {
  const normalized = signalInput && signalInput.signal ? signalInput : normalizeHumanSignal(signalInput);
  if (!normalized.ok) {
    return { who: 'unknown', basis: 'invalid', confidence: 0, reason: normalized.error || '信号非法' };
  }
  const signal = normalized.signal;
  if (signal.agentAttributed) {
    return { who: 'agent', basis: 'agent-attributed', confidence: 1, reason: '内容脚本显式标记为 Agent 归因' };
  }
  if (signal.source === HUMAN_SIGNAL_SOURCES.AGENT_WINDOW) {
    return { who: 'agent', basis: 'agent-window', confidence: 1, reason: '信号来源是 Agent 输入窗口' };
  }
  const window = options.agentWindow || null;
  if (window && isWithinAgentWindow(signal.at, window, {
    toleranceMs: options.toleranceMs,
    beforeMs: options.agentWindowBeforeMs,
    afterMs: options.agentWindowAfterMs,
  })) {
    return { who: 'agent', basis: 'agent-window', confidence: 0.99, reason: '时间落在 Agent 自产事件窗口内' };
  }
  if (!signal.trusted) {
    return { who: 'unknown', basis: 'untrusted', confidence: 0.2, reason: '信号未被页面标记为可信（可能是脚本合成）' };
  }
  if (signal.count > 0) {
    return { who: 'human', basis: 'attributed-count', confidence: 0.95, reason: '内容脚本归因计数增加（' + signal.count + '）' };
  }
  if (signal.source === HUMAN_SIGNAL_SOURCES.HUMAN_STATE || signal.source === HUMAN_SIGNAL_SOURCES.CONTENT_ACTIVITY) {
    return { who: 'human', basis: signal.source, confidence: 0.9, reason: '页面回传人工活动快照' };
  }
  return { who: 'human', basis: 'explicit', confidence: 0.85, reason: '调用方显式声明人工信号' };
}

/**
 * 合并一组信号：返回最近一次人工活动、涉及 frame/kind 与活跃判定。
 * @param {Array<object>} signals
 * @param {{now?:number, windowMs?:number, agentWindow?:object, toleranceMs?:number}} [options]
 */
export function mergeHumanSignals(signals, options = {}) {
  const now = num(options.now) || Date.now();
  const windowMs = positive(options.windowMs, DEFAULT_ACTIVE_MS);
  const list = Array.isArray(signals) ? signals : [];
  const kinds = new Set();
  const frames = new Set();
  const sources = new Set();
  let lastAt = 0;
  let lastKind = null;
  let lastFrameId = 0;
  let humanCount = 0;
  let agentCount = 0;
  let unknownCount = 0;
  for (const item of list) {
    const classified = classifyHumanSignal(item, options);
    const signal = item && item.signal ? item.signal : (normalizeHumanSignal(item).signal || null);
    if (!signal) continue;
    sources.add(signal.source);
    if (classified.who === 'human') {
      humanCount += 1;
      kinds.add(signal.kind);
      frames.add(signal.frameId);
      if (signal.at >= lastAt) {
        lastAt = Math.max(lastAt, signal.at);
        lastKind = signal.kind;
        lastFrameId = signal.frameId;
      }
    } else if (classified.who === 'agent') {
      agentCount += 1;
    } else {
      unknownCount += 1;
    }
  }
  const ageMs = lastAt > 0 ? Math.max(0, now - lastAt) : null;
  return {
    active: lastAt > 0 && now - lastAt <= windowMs,
    cooling: lastAt > 0 && now - lastAt > windowMs,
    lastAt,
    lastKind,
    lastFrameId,
    ageMs,
    windowMs,
    kinds: [...kinds],
    frames: [...frames].sort((a, b) => a - b),
    sources: [...sources],
    counts: { human: humanCount, agent: agentCount, unknown: unknownCount, total: list.length },
  };
}

/**
 * 人机冲突判定：人工活动与 Agent 租约/动作在时间上重叠时给出冲突证据。
 * @param {{human?:object, leases?:Array, now?:number, toleranceMs?:number}} input
 */
export function humanConflict(input = {}) {
  const now = num(input.now) || Date.now();
  const tolerance = Math.max(0, num(input.toleranceMs));
  const human = input.human && typeof input.human === 'object' ? input.human : {};
  const leases = Array.isArray(input.leases) ? input.leases : [];
  const humanAt = num(human.lastAt);
  const activeLeases = leases.filter((lease) => lease && lease.active !== false && lease.used !== true);
  if (!(humanAt > 0) || !activeLeases.length) {
    return {
      conflicting: false,
      code: null,
      humanAt,
      activeLeases: activeLeases.length,
      overlapMs: 0,
      evidence: { humanAt, activeLeases: activeLeases.length, toleranceMs: tolerance },
    };
  }
  let earliest = Infinity;
  for (const lease of activeLeases) {
    const startedAt = num(lease.startedAt || lease.at);
    if (startedAt > 0) earliest = Math.min(earliest, startedAt);
  }
  const leaseStart = Number.isFinite(earliest) ? earliest : humanAt;
  const overlapMs = Math.abs(humanAt - leaseStart);
  // 人工动作发生在租约窗口内（或与租约起点相差不到容差）才算冲突：先人后 Agent 不算。
  const conflicting = humanAt + tolerance >= leaseStart;
  return {
    conflicting,
    code: conflicting ? HUMAN_GATE_CODES.HUMAN_CONFLICT : null,
    humanAt,
    leaseStart,
    overlapMs,
    activeLeases: activeLeases.length,
    evidence: {
      humanAt,
      leaseStart,
      overlapMs,
      toleranceMs: tolerance,
      activeLeases: activeLeases.length,
      leaseIds: activeLeases.map((lease) => clip(lease.leaseId || lease.token || '', 64)).filter(Boolean).slice(0, 8),
    },
  };
}

/** 一行文本摘要：toolbar/CLI 的默认输出用。 */
export function describeHumanGate(state) {
  if (!state || typeof state !== 'object') return 'human-gate: 无状态';
  const parts = ['state=' + (state.state || HUMAN_GATE_STATES.IDLE)];
  if (state.lastAt > 0) {
    parts.push('last=' + clip(state.lastKind || 'input', 24));
    if (state.ageMs != null) parts.push('age=' + Math.round(state.ageMs) + 'ms');
  }
  if (state.conflicts > 0) parts.push('conflicts=' + state.conflicts);
  if (state.agentWindows > 0) parts.push('agent-windows=' + state.agentWindows);
  return parts.join(' ');
}

function emptyTabRecord(tabId, now) {
  return {
    tabId,
    state: HUMAN_GATE_STATES.IDLE,
    since: now,
    lastAt: 0,
    lastKind: null,
    lastFrameId: 0,
    lastSource: null,
    updatedAt: now,
    humanAttributed: 0,
    agentAttributed: 0,
    signals: [],
    agentWindows: [],
    conflicts: 0,
    lastConflict: null,
    history: [],
    chain: [],
    chainSeq: 0,
    mayActChain: [],
    mayActSeq: 0,
  };
}

/**
 * 创建一个人机互斥闸门实例（时钟/容量可注入，便于单测隔离）。
 * @param {{now?: () => number, activeMs?: number, coolingMs?: number, toleranceMs?: number,
 *          historyLimit?: number, maxTabs?: number, conflictLimit?: number}} [options]
 */
export function createHumanGate(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const activeMs = positive(options.activeMs, DEFAULT_ACTIVE_MS);
  const coolingMs = Math.max(0, num(options.coolingMs) || DEFAULT_COOLING_MS);
  const toleranceMs = Math.max(0, Number.isFinite(Number(options.toleranceMs)) ? Number(options.toleranceMs) : DEFAULT_TOLERANCE_MS);
  const historyLimit = Number.isInteger(options.historyLimit) && options.historyLimit > 0 ? options.historyLimit : DEFAULT_HISTORY_LIMIT;
  const maxTabs = Number.isInteger(options.maxTabs) && options.maxTabs > 0 ? options.maxTabs : DEFAULT_MAX_TABS;
  const conflictLimit = Number.isInteger(options.conflictLimit) && options.conflictLimit > 0 ? options.conflictLimit : DEFAULT_CONFLICT_LIMIT;
  const tabs = new Map();
  const stats = { signals: 0, humanSignals: 0, agentSignals: 0, conflicts: 0, activeMs: 0, resets: 0, badArgs: 0 };

  function recordFor(tabId) {
    const id = tabKey(tabId);
    if (id == null) return null;
    let record = tabs.get(id);
    if (!record) {
      if (tabs.size >= maxTabs) {
        const oldest = tabs.keys().next().value;
        if (oldest !== undefined) tabs.delete(oldest);
      }
      record = emptyTabRecord(id, now());
      tabs.set(id, record);
    }
    return record;
  }

  function pushBounded(list, entry, limit) {
    list.push(entry);
    if (list.length > limit) list.splice(0, list.length - limit);
  }

  function pushHistory(record, entry) {
    pushBounded(record.history, entry, historyLimit);
  }

  function rememberSignal(record, signal) {
    pushBounded(record.signals, signal, historyLimit);
    record.updatedAt = now();
  }

  /** 把一条信号追加进哈希链（第二轮证据）：只加字段，不影响判定。 */
  function appendChain(record, signal, attribution) {
    if (!record || !signal) return null;
    const normalized = normalizeHumanChainSignal(signal, attribution, { seq: record.chainSeq + 1, state: record.state });
    if (!normalized) return null;
    record.chainSeq += 1;
    const previous = record.chain.length ? record.chain[record.chain.length - 1] : null;
    const entry = humanSignalEntry(previous, normalized);
    pushBounded(record.chain, entry, historyLimit);
    return entry;
  }

  /** 链尾 digest（冲突证书里引用“判定时链长什么样”）。 */
  function chainDigestOf(record) {
    return record && record.chain.length ? record.chain[record.chain.length - 1].digest : '';
  }

  /**
   * exclusive 的附加证据：把四类来源封成 cooperation 证据包 + 链节 + 冲突证书。
   * 任何异常都回退到原 evidence（判定路径绝不被证据代码打断）。
   */
  function attachCooperation(id, evidence, context = {}) {
    const record = recordFor(id);
    if (!record) return evidence;
    try {
      const bundle = mayActEvidence({
        method: evidence.method,
        at: evidence.at,
        leases: context.leases,
        controllerGate: context.controllerGate,
        borrowGate: context.borrowGate,
        human: {
          state: evidence.state,
          active: evidence.state === HUMAN_GATE_STATES.HUMAN_ACTIVE,
          cooling: evidence.state === HUMAN_GATE_STATES.COOLING,
          lastAt: evidence.humanAt,
          ageMs: evidence.ageMs,
          toleranceMs,
        },
        allowCooling: context.allowCooling === true,
        decision: context.decision || { allowed: false, code: evidence.code || null, source: evidence.source || null },
      });
      const seq = record.mayActSeq + 1;
      const previous = record.mayActChain.length ? record.mayActChain[record.mayActChain.length - 1] : null;
      const link = chainMayActEvidence(previous, bundle, { seq, at: evidence.at });
      record.mayActSeq = seq;
      if (link) pushBounded(record.mayActChain, link, 8);
      const enriched = {
        ...evidence,
        cooperation: summarizeMayActEvidence(bundle),
        mayAct: link ? { seq, digest: bundle.digest, chainDigest: link.chainDigest, prevDigest: link.prevDigest } : null,
      };
      if (context.conflict === true) {
        enriched.conflictCertificate = humanConflictCertificate({
          tabId: id,
          human: { lastAt: evidence.humanAt, lastKind: record.lastKind, ageMs: evidence.ageMs, state: evidence.state },
          leases: context.leases,
          conflict: { ...(evidence.conflict || {}), conflicting: true },
          decision: context.decision,
          chainDigest: chainDigestOf(record),
          at: evidence.at,
          toleranceMs,
        });
      }
      return enriched;
    } catch {
      return evidence;
    }
  }

  function pruneAgentWindows(record, at) {
    const keepAfter = at - Math.max(activeMs * 4, 10000);
    record.agentWindows = record.agentWindows.filter((window) => (window.end === Infinity ? true : window.end >= keepAfter));
  }

  function noteConflict(record, conflict) {
    record.conflicts += 1;
    stats.conflicts += 1;
    record.lastConflict = conflict;
    pushBounded(record.history, { kind: 'conflict', at: now(), ...conflict }, historyLimit);
  }

  /**
   * 登记一条人工信号。返回规整后的信号；非法输入返回结构化失败。
   * @param {number} tabId
   * @param {object} facts
   */
  function noteHuman(tabId, facts = {}) {
    const record = recordFor(tabId);
    if (!record) {
      stats.badArgs += 1;
      return { ok: false, code: HUMAN_GATE_CODES.BAD_ARG, error: 'noteHuman 需要整数 tabId' };
    }
    const at = num(facts.at) || now();
    const normalized = normalizeHumanSignal({ ...facts, at, source: facts.source || HUMAN_SIGNAL_SOURCES.HUMAN_STATE });
    if (!normalized.ok) {
      stats.badArgs += 1;
      return normalized;
    }
    const signal = normalized.signal;
    signal.at = at;
    const classified = classifyHumanSignal(signal, { agentWindow: activeAgentWindow(record, at), toleranceMs });
    rememberSignal(record, signal);
    stats.signals += 1;
    if (classified.who === 'human') {
      stats.humanSignals += 1;
      record.humanAttributed += Math.max(1, signal.count);
      if (at >= record.lastAt) {
        record.lastAt = at;
        record.lastKind = signal.kind;
        record.lastFrameId = signal.frameId;
        record.lastSource = signal.source;
      }
    } else if (classified.who === 'agent') {
      stats.agentSignals += 1;
      record.agentAttributed += 1;
    }
    record.state = HUMAN_GATE_STATES.HUMAN_ACTIVE;
    record.since = record.since || at;
    pushHistory(record, { kind: 'human', at, source: signal.source, who: classified.who, basis: classified.basis });
    appendChain(record, signal, classified);
    settle(tabId);
    return { ok: true, tabId: record.tabId, signal, attribution: classified, state: record.state, evidence: { tabId: record.tabId, at, who: classified.who, basis: classified.basis } };
  }

  /** 登记 Agent 自己的输入窗口：窗口内的人工信号会被归因为 Agent 自产事件。 */
  function noteAgentWindow(tabId, window) {
    const record = recordFor(tabId);
    if (!record) {
      stats.badArgs += 1;
      return { ok: false, code: HUMAN_GATE_CODES.BAD_ARG, error: 'noteAgentWindow 需要整数 tabId' };
    }
    const normalized = normalizeAgentWindow(window);
    if (!normalized) {
      stats.badArgs += 1;
      return { ok: false, code: HUMAN_GATE_CODES.BAD_ARG, error: 'Agent 输入窗口需要 start' };
    }
    record.agentWindows.push(normalized);
    if (record.agentWindows.length > historyLimit) record.agentWindows.splice(0, record.agentWindows.length - historyLimit);
    record.updatedAt = now();
    pushHistory(record, { kind: 'agent-window', at: now(), start: normalized.start, end: normalized.end === Infinity ? 'infinity' : normalized.end });
    appendChain(record, {
      at: now(),
      kind: 'agent-window',
      frameId: 0,
      source: HUMAN_SIGNAL_SOURCES.AGENT_WINDOW,
      count: 0,
      label: 'window:' + normalized.start,
    }, { who: 'agent', basis: 'agent-window', confidence: 1 });
    return { ok: true, tabId: record.tabId, window: normalized, count: record.agentWindows.length };
  }

  /** 关闭当前 Agent 输入窗口（动作结束时调用；未开窗口时幂等）。 */
  function closeAgentWindow(tabId, atInput) {
    const record = recordFor(tabId);
    if (!record) return { ok: false, code: HUMAN_GATE_CODES.BAD_ARG };
    const at = num(atInput) || now();
    let closed = 0;
    record.agentWindows = record.agentWindows.map((window) => {
      if (window.end !== Infinity) return window;
      closed += 1;
      return { start: window.start, end: at };
    });
    if (closed) record.updatedAt = at;
    return { ok: true, tabId: record.tabId, closed, windows: record.agentWindows.length };
  }

  function activeAgentWindow(record, at) {
    let hit = null;
    for (const window of record.agentWindows) {
      if (isWithinAgentWindow(at, window, { toleranceMs, beforeMs: DEFAULT_AGENT_WINDOW_BEFORE_MS, afterMs: DEFAULT_AGENT_WINDOW_AFTER_MS })) {
        if (!hit || window.start > hit.start) hit = window;
      }
    }
    return hit;
  }

  /** 登记内容脚本的归因计数增量（humanAttributed/agentAttributed）。 */
  function noteAttributed(tabId, facts = {}) {
    const record = recordFor(tabId);
    if (!record) {
      stats.badArgs += 1;
      return { ok: false, code: HUMAN_GATE_CODES.BAD_ARG, error: 'noteAttributed 需要整数 tabId' };
    }
    const at = num(facts.at) || now();
    const humanCount = Math.max(0, Math.floor(num(facts.humanAttributed)));
    const agentCount = Math.max(0, Math.floor(num(facts.agentAttributed)));
    const humanDelta = Math.max(0, humanCount - record.humanAttributed);
    const agentDelta = Math.max(0, agentCount - record.agentAttributed);
    record.humanAttributed = Math.max(record.humanAttributed, humanCount);
    record.agentAttributed = Math.max(record.agentAttributed, agentCount);
    record.updatedAt = at;
    if (humanDelta > 0) {
      const noted = noteHuman(tabId, {
        at,
        kind: clip(facts.kind || 'attributed', 32),
        frameId: facts.frameId,
        count: humanDelta,
        source: HUMAN_SIGNAL_SOURCES.ATTRIBUTED,
        revision: facts.revision,
      });
      return { ...noted, deltas: { human: humanDelta, agent: agentDelta }, totals: { human: record.humanAttributed, agent: record.agentAttributed } };
    }
    if (agentDelta > 0) stats.agentSignals += 1;
    return {
      ok: true,
      tabId: record.tabId,
      deltas: { human: humanDelta, agent: agentDelta },
      totals: { human: record.humanAttributed, agent: record.agentAttributed },
    };
  }

  /** 登记“内容脚本现在有活动”：不带计数，只按内容脚本回传的时间戳刷新。 */
  function noteActivity(tabId, facts = {}) {
    return noteHuman(tabId, {
      at: facts.at,
      kind: clip(facts.kind || 'activity', 32),
      frameId: facts.frameId,
      label: facts.label,
      source: HUMAN_SIGNAL_SOURCES.CONTENT_ACTIVITY,
      trusted: facts.trusted,
    });
  }

  /**
   * 按注入时钟推进状态机并返回当前判定。
   *   idle ──人工信号──▶ human-active ──超过 activeMs──▶ cooling ──超过 coolingMs──▶ idle
   *   任何阶段发现租约与人工时间重叠时，冲突由 humanConflict 单独报告，不改状态机
   *   （状态机描述“人在不在动”，冲突描述“人机是否同时动”，两者不能混为一谈）。
   */
  function settle(tabId, settleOptions = {}) {
    const record = recordFor(tabId);
    if (!record) return { ok: false, code: HUMAN_GATE_CODES.BAD_ARG, tabId: null };
    const at = settleOptions.now != null && Number.isFinite(Number(settleOptions.now)) ? Number(settleOptions.now) : now();
    const ageMs = record.lastAt > 0 ? Math.max(0, at - record.lastAt) : null;
    const leases = Array.isArray(settleOptions.leases) ? settleOptions.leases : [];
    const conflict = humanConflict({ human: { lastAt: record.lastAt }, leases, now: at, toleranceMs });
    let next = record.state;
    if (record.lastAt > 0) {
      if (ageMs <= activeMs) next = HUMAN_GATE_STATES.HUMAN_ACTIVE;
      else if (ageMs <= activeMs + coolingMs) next = HUMAN_GATE_STATES.COOLING;
      else next = HUMAN_GATE_STATES.IDLE;
    } else {
      next = HUMAN_GATE_STATES.IDLE;
    }
    if (conflict.conflicting && next !== HUMAN_GATE_STATES.IDLE) next = HUMAN_GATE_STATES.CONFLICT;
    if (next !== record.state) {
      pushHistory(record, { kind: 'settle', at, from: record.state, to: next, ageMs });
      record.state = next;
      record.since = at;
      stats.activeMs += 1;
      appendChain(record, {
        at,
        kind: 'settle',
        frameId: record.lastFrameId,
        source: HUMAN_SIGNAL_SOURCES.HUMAN_STATE,
        count: 0,
        label: next,
      }, { who: next === HUMAN_GATE_STATES.HUMAN_ACTIVE ? 'human' : 'unknown', basis: 'settle', confidence: 0.5 });
    }
    record.updatedAt = at;
    return {
      ok: true,
      tabId: record.tabId,
      state: record.state,
      active: record.state === HUMAN_GATE_STATES.HUMAN_ACTIVE,
      cooling: record.state === HUMAN_GATE_STATES.COOLING,
      ageMs,
      lastAt: record.lastAt,
      lastKind: record.lastKind,
      lastFrameId: record.lastFrameId,
      conflict,
      evidence: {
        tabId: record.tabId,
        state: record.state,
        at,
        lastAt: record.lastAt,
        ageMs,
        activeMs,
        coolingMs,
        toleranceMs,
        conflict: conflict.conflicting,
        overlapMs: conflict.overlapMs,
      },
    };
  }

  /** 只读当前状态（不推进状态机）。 */
  function state(tabId) {
    const id = tabKey(tabId);
    const record = id == null ? null : tabs.get(id);
    if (!record) {
      return {
        tabId: id,
        state: HUMAN_GATE_STATES.IDLE,
        active: false,
        cooling: false,
        lastAt: 0,
        lastKind: null,
        ageMs: null,
        conflicts: 0,
        history: [],
        chain: null,
        mayAct: { count: 0, digest: '' },
      };
    }
    const at = now();
    return {
      tabId: record.tabId,
      state: record.state,
      active: record.state === HUMAN_GATE_STATES.HUMAN_ACTIVE,
      cooling: record.state === HUMAN_GATE_STATES.COOLING,
      lastAt: record.lastAt,
      lastKind: record.lastKind,
      lastFrameId: record.lastFrameId,
      lastSource: record.lastSource,
      ageMs: record.lastAt > 0 ? Math.max(0, at - record.lastAt) : null,
      humanAttributed: record.humanAttributed,
      agentAttributed: record.agentAttributed,
      agentWindows: record.agentWindows.length,
      conflicts: record.conflicts,
      lastConflict: record.lastConflict,
      history: record.history.slice(-8),
      chain: summarizeHumanChain(record.chain),
      mayAct: record.mayActChain.length
        ? { count: record.mayActChain.length, digest: record.mayActChain[record.mayActChain.length - 1].chainDigest }
        : { count: 0, digest: '' },
    };
  }

  function active(tabId) {
    return state(tabId).active;
  }

  /**
   * 互斥判定：给调用方一个“现在允许动作吗”的答案。
   * options:
   *   leases         当前活跃租约（与人工时间重叠 → 冲突）
   *   controllerGate 外部 controller 动作闸门结果（held/handoff 时直接拒绝）
   *   borrowGate     外部借用确认闸门结果（pending 时直接拒绝）
   *   allowCooling   true 时冷却窗也放行（默认 false：冷却窗内仍拒绝）
   *   method         动作方法名（仅作证据）
   * @returns {{allowed:boolean, code:string|null, state:string, evidence:object}}
   */
  function exclusive(tabId, exclusiveOptions = {}) {
    const id = tabKey(tabId);
    if (id == null) {
      return { allowed: false, code: HUMAN_GATE_CODES.BAD_ARG, state: HUMAN_GATE_STATES.IDLE, evidence: { tabId: null, method: clip(exclusiveOptions.method, 64) } };
    }
    const at = num(exclusiveOptions.now) || now();
    const leaseList = Array.isArray(exclusiveOptions.leases) ? exclusiveOptions.leases : [];
    const settled = settle(id, { now: at, leases: leaseList });
    const method = clip(exclusiveOptions.method, 64);
    const allowCooling = exclusiveOptions.allowCooling === true;
    const base = {
      tabId: id,
      method,
      at,
      state: settled.state,
      humanAt: settled.lastAt,
      ageMs: settled.ageMs,
      toleranceMs,
      leases: leaseList.length,
    };
    const context = {
      leases: leaseList,
      controllerGate: exclusiveOptions.controllerGate || null,
      borrowGate: exclusiveOptions.borrowGate || null,
      allowCooling,
      conflict: settled.conflict.conflicting === true,
    };
    // 1) 外部 controller 闸门优先：暂停/交接由 controller-state 说了算。
    const controllerGate = exclusiveOptions.controllerGate || null;
    if (controllerGate && controllerGate.allowed === false) {
      const decision = { allowed: false, code: controllerGate.code || 'E_SESSION_STATE', source: 'controller', method };
      return {
        allowed: false,
        code: decision.code,
        state: settled.state,
        evidence: attachCooperation(id, {
          ...base,
          source: 'controller',
          controller: controllerGate.evidence || null,
          reason: 'controller 状态不允许动作',
        }, { ...context, decision }),
      };
    }
    // 2) 外部借用确认闸门：pending 期间动作必须等用户决定。
    const borrowGateResult = exclusiveOptions.borrowGate || null;
    if (borrowGateResult && borrowGateResult.allowed === false) {
      const decision = { allowed: false, code: borrowGateResult.code || 'E_BORROW_CONFLICT', source: 'borrow', method };
      return {
        allowed: false,
        code: decision.code,
        state: settled.state,
        evidence: attachCooperation(id, {
          ...base,
          source: 'borrow',
          borrow: borrowGateResult.evidence || null,
          reason: '借用确认未完成',
        }, { ...context, decision }),
      };
    }
    // 3) 人机冲突：有活跃租约且人工时间落在租约窗口内（人机同时操作）。
    if (settled.conflict.conflicting) {
      const decision = { allowed: false, code: HUMAN_GATE_CODES.HUMAN_CONFLICT, source: 'human', method };
      return {
        allowed: false,
        code: decision.code,
        state: settled.state,
        evidence: attachCooperation(id, {
          ...base,
          source: 'human',
          reason: '人工操作与 Agent 动作时间重叠',
          conflict: { ...settled.conflict.evidence, conflicting: true },
        }, { ...context, decision }),
      };
    }
    // 4) 人类正在操作：冷却窗内也拒绝（避免抢焦点），显式 allowCooling 才放宽。
    if (settled.state === HUMAN_GATE_STATES.HUMAN_ACTIVE) {
      const decision = { allowed: false, code: HUMAN_GATE_CODES.HUMAN_ACTIVE, source: 'human', method };
      return {
        allowed: false,
        code: decision.code,
        state: settled.state,
        evidence: attachCooperation(id, {
          ...base,
          source: 'human',
          reason: '人工正在操作（' + Math.round(settled.ageMs || 0) + 'ms 前）',
          retryAfterMs: Math.max(0, activeMs - (settled.ageMs || 0)),
        }, { ...context, decision }),
      };
    }
    if (settled.state === HUMAN_GATE_STATES.COOLING && !allowCooling) {
      const retryAfterMs = Math.max(0, activeMs + coolingMs - (settled.ageMs || 0));
      const decision = { allowed: false, code: HUMAN_GATE_CODES.HUMAN_COOLING, source: 'human', method };
      return {
        allowed: false,
        code: decision.code,
        state: settled.state,
        evidence: attachCooperation(id, {
          ...base,
          source: 'human',
          reason: '人工刚停手，冷却中',
          retryAfterMs,
        }, { ...context, decision }),
      };
    }
    const allowedDecision = { allowed: true, code: null, source: null, method };
    return {
      allowed: true,
      code: null,
      state: settled.state,
      evidence: attachCooperation(id, { ...base, source: null, reason: null }, { ...context, decision: allowedDecision }),
    };
  }

  function evidence(tabId, evidenceOptions = {}) {
    const id = tabKey(tabId);
    if (id == null) return { ok: false, code: HUMAN_GATE_CODES.BAD_ARG, tabId: null };
    const settled = settle(id, { now: evidenceOptions.now, leases: evidenceOptions.leases });
    const record = tabs.get(id);
    const sealedChain = record ? sealHumanChain(record.chain, { tabId: id, at: settled.evidence.at }) : null;
    return {
      ok: true,
      tabId: id,
      at: settled.evidence.at,
      state: settled.state,
      active: settled.active,
      cooling: settled.cooling,
      lastAt: settled.lastAt,
      lastKind: settled.lastKind,
      ageMs: settled.ageMs,
      frames: state(id).history,
      conflict: settled.conflict,
      humanAttributed: state(id).humanAttributed,
      agentAttributed: state(id).agentAttributed,
      toleranceMs,
      activeMs,
      coolingMs,
      chain: sealedChain,
      chainVerified: sealedChain ? verifyHumanChain(sealedChain).ok : false,
      mayActChain: record ? record.mayActChain.slice(-4) : [],
      mayActChainVerified: record ? verifyMayActChain(record.mayActChain).ok : true,
      cooperation: record && record.mayActChain.length
        ? { count: record.mayActChain.length, digest: record.mayActChain[record.mayActChain.length - 1].chainDigest }
        : { count: 0, digest: '' },
    };
  }

  /**
   * 证据链整体快照（CLI/诊断/借用证据链对账用）：
   * 返回封存的人机信号链 + 校验结论 + mayAct 判定链摘要。
   */
  function chainEvidence(tabId, chainOptions = {}) {
    const id = tabKey(tabId);
    if (id == null) return { ok: false, code: HUMAN_GATE_CODES.BAD_ARG, tabId: null };
    const record = recordFor(id);
    const sealed = sealHumanChain(record.chain, { tabId: id, at: now(), leases: Array.isArray(chainOptions.leases) ? chainOptions.leases.length : null });
    const verified = verifyHumanChain(sealed);
    return {
      ok: verified.ok,
      tabId: id,
      state: record.state,
      chain: sealed,
      verified,
      summary: summarizeHumanChain(sealed),
      mayAct: {
        count: record.mayActChain.length,
        verified: verifyMayActChain(record.mayActChain),
        entries: record.mayActChain.slice(-4),
      },
    };
  }

  function list() {
    return [...tabs.keys()].map((id) => state(id));
  }

  function counters() {
    const records = [...tabs.values()];
    return {
      ...stats,
      tabs: tabs.size,
      conflicts: records.reduce((total, record) => total + record.conflicts, 0),
      chainEntries: records.reduce((total, record) => total + record.chain.length, 0),
      mayActDecisions: records.reduce((total, record) => total + record.mayActSeq, 0),
    };
  }

  function clear(tabId) {
    const id = tabKey(tabId);
    if (id == null) return false;
    const removed = tabs.delete(id);
    if (removed) stats.resets += 1;
    return removed;
  }

  function reset() {
    const cleared = tabs.size;
    tabs.clear();
    stats.resets += 1;
    return { ok: true, cleared };
  }

  return {
    noteHuman,
    noteActivity,
    noteAttributed,
    noteAgentWindow,
    closeAgentWindow,
    settle,
    state,
    active,
    exclusive,
    evidence,
    chainEvidence,
    list,
    counters,
    clear,
    reset,
    get activeMs() { return activeMs; },
    get coolingMs() { return coolingMs; },
    get toleranceMs() { return toleranceMs; },
  };
}

/** 后台共享单例：cooperate.js 的 passthrough 互斥、toolbar 的按钮可用性都从这里读。 */
export const humanGate = createHumanGate();
