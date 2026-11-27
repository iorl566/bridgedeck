// lib/session-state.mjs —— 会话生命周期状态机 v2。
//
// 兼容目标把会话生命周期做成显式状态机；0.3.0 只有 starting/active/stopping/recovering 四个
// 字符串，非法迁移不会被发现。v2 补齐 8 状态迁移表：
//
//   idle → preparing → starting → ready ⇄ paused
//                          │           │
//                          └──────→ stopping → stopped
//                          └──────→ failed
//
// 兼容性：
// - 对外 phase 仍返回 0.3.0 的字符串（'active'/'recovering' 保留为 ready/preparing 的
//   旧标签），既有调用方/测试不用改；
// - canonicalPhase() 给出规范化状态名（active→ready，recovering→preparing）；
// - 每次迁移都记录 from/to/at/reason 证据；非法迁移抛 E_SESSION_TRANSITION 并附带
//   allowed（当前状态允许的目标）与最近迁移历史，供 CLI/日志解释“为什么被拒绝”；
// - finish() 是清理入口：即使当前状态没走到 stopping，也会退休为 stopped 并留下
//   forced 证据（清理路径不能因为状态机异常而漏删会话）。
//
// 状态机本身不依赖 daemon/存储，daemon、测试、UI 都可以复用。

/** 规范化（canonical）状态集合，与兼容目标对齐。 */
export const SESSION_STATES = Object.freeze([
  'idle', 'preparing', 'starting', 'ready', 'paused', 'stopping', 'stopped', 'failed',
]);

/** 0.3.0 的旧 phase 标签（'active'/'recovering' 是别名，不是新状态）。 */
export const SESSION_PHASES = Object.freeze([
  'starting', 'active', 'stopping', 'recovering', 'preparing', 'ready', 'paused', 'stopped', 'failed',
]);

/** 旧标签 → 规范状态。 */
export const SESSION_ALIASES = Object.freeze({
  active: 'ready',
  recovering: 'preparing',
});

/**
 * 迁移表。任何不在表中的 (from → to) 都是非法迁移；idle 的宽松边是 0.3.0
 * “没有先 prepare/begin 就直接 activate/requestStop”的兼容路径。
 */
export const SESSION_TRANSITIONS = Object.freeze({
  idle: ['preparing', 'starting', 'ready', 'paused', 'stopping', 'failed'],
  preparing: ['starting', 'ready', 'paused', 'failed', 'stopped'],
  starting: ['ready', 'preparing', 'stopping', 'failed'],
  ready: ['paused', 'stopping', 'failed'],
  paused: ['ready', 'stopping', 'failed'],
  stopping: ['stopped', 'starting', 'failed'],
  stopped: ['preparing', 'starting', 'failed'],
  failed: ['preparing', 'starting', 'stopped'],
});

export function canonicalState(state) {
  const text = String(state === undefined || state === null ? '' : state).trim();
  if (!text) return null;
  const mapped = SESSION_ALIASES[text] || text;
  return SESSION_STATES.includes(mapped) ? mapped : null;
}

export function isKnownState(state) {
  return canonicalState(state) !== null;
}

export function isLegalTransition(from, to) {
  const source = canonicalState(from) || 'idle';
  const target = canonicalState(to);
  if (!target) return false;
  if (source === target) return true;
  return (SESSION_TRANSITIONS[source] || []).includes(target);
}

export function allowedTransitions(from) {
  const source = canonicalState(from) || 'idle';
  return [...(SESSION_TRANSITIONS[source] || [])];
}

export class SessionTransitionError extends Error {
  constructor(sessionId, from, to, { reason = '', history = [] } = {}) {
    const source = canonicalState(from) || String(from || 'idle');
    const target = canonicalState(to) || String(to || '');
    super(
      `会话 ${sessionId} 的非法生命周期迁移：${source} → ${target}（${reason || '未说明'}）；` +
      `当前状态允许：${allowedTransitions(source).join(', ') || '(无)'}`,
    );
    this.name = 'SessionTransitionError';
    this.code = 'E_SESSION_TRANSITION';
    this.sessionId = String(sessionId);
    this.from = source;
    this.to = target;
    this.data = {
      sessionId: String(sessionId),
      from: source,
      to: target,
      reason: reason || '',
      allowed: allowedTransitions(source),
      states: [...SESSION_STATES],
      history: history.slice(-8),
    };
  }
}

function labelFor(canonical) {
  // 规范状态 ready/preparing 对外分别用 'active'/'recovering' 旧标签返回。
  if (canonical === 'ready') return 'active';
  return canonical;
}

function nowOf(clock) {
  return typeof clock === 'function' ? clock() : Date.now();
}

/**
 * 创建会话生命周期状态机。
 * @param {{now?: () => number, historyLimit?: number, violationLimit?: number}} options
 */
export function createSessionState({ now = () => Date.now(), historyLimit = 50, violationLimit = 100 } = {}) {
  const states = new Map();
  const tombstones = new Map();
  const violations = [];
  let transitionCount = 0;
  let seq = 0;

  function get(sessionId) {
    return states.get(String(sessionId)) || null;
  }

  function phase(sessionId) {
    return get(sessionId)?.phase || null;
  }

  function canonicalPhase(sessionId) {
    return get(sessionId)?.canonical || null;
  }

  function recordViolation(sessionId, from, to, reason, extra = {}) {
    const violation = {
      sessionId: String(sessionId),
      from: canonicalState(from) || 'idle',
      to: canonicalState(to) || String(to || ''),
      reason: reason || '',
      at: nowOf(now),
      allowed: allowedTransitions(from),
      forced: extra.forced === true,
    };
    violations.push(violation);
    const overflow = violations.length - violationLimit;
    if (overflow > 0) violations.splice(0, overflow);
    return violation;
  }

  function pushTransition(state, from, to, reason, meta = {}) {
    seq += 1;
    transitionCount += 1;
    const transition = {
      seq,
      at: nowOf(now),
      from,
      to,
      reason: reason || '',
      ...(meta.forced === true ? { forced: true } : {}),
      ...(meta.evidence !== undefined ? { evidence: meta.evidence } : {}),
    };
    state.history.push(transition);
    const overflow = state.history.length - historyLimit;
    if (overflow > 0) state.history.splice(0, overflow);
    state.lastTransition = transition;
    state.since = transition.at;
    return transition;
  }

  function snapshotState(state) {
    return {
      sessionId: state.sessionId,
      phase: state.phase,
      canonical: state.canonical,
      since: state.since,
      enteredAt: state.enteredAt,
      reason: state.reason,
      transitions: state.history.length,
      lastTransition: state.lastTransition,
      history: state.history.slice(-5),
    };
  }

  /**
   * 规范迁移入口：严格校验迁移表，非法时留下 violation 证据并抛错。
   */
  function enter(sessionId, targetLabel, { reason = '', meta = {}, force = false } = {}) {
    const id = String(sessionId);
    const target = canonicalState(targetLabel);
    if (!target) {
      const error = new Error(`未知的会话状态：${targetLabel}`);
      error.code = 'E_SESSION_STATE';
      error.data = { sessionId: id, to: String(targetLabel), states: [...SESSION_STATES] };
      throw error;
    }
    const current = states.get(id);
    const from = current ? current.canonical : 'idle';
    if (current && from === target) {
      // 同状态重复迁移：幂等（例如重复 activate），不写历史、不报错。
      current.since = nowOf(now);
      return snapshotState(current);
    }
    if (!force && !isLegalTransition(from, target)) {
      recordViolation(id, from, target, reason, meta);
      throw new SessionTransitionError(id, from, target, { reason, history: current ? current.history : [] });
    }
    const at = nowOf(now);
    let state = current;
    if (!state) {
      state = {
        sessionId: id,
        phase: targetLabel,
        canonical: target,
        since: at,
        enteredAt: at,
        reason: reason || '',
        history: [],
        lastTransition: null,
      };
      states.set(id, state);
    } else {
      state.phase = targetLabel;
      state.canonical = target;
      state.enteredAt = at;
      state.reason = reason || '';
    }
    if (force && !isLegalTransition(from, target)) {
      recordViolation(id, from, target, reason, { ...meta, forced: true });
      pushTransition(state, from, target, reason, { ...meta, forced: true });
    } else {
      pushTransition(state, from, target, reason, meta);
    }
    tombstones.delete(id);
    return snapshotState(state);
  }

  // —— 0.3.0 兼容入口 ——

  function begin(sessionId) {
    const id = String(sessionId);
    const current = states.get(id);
    if (current && (current.canonical === 'starting' || current.canonical === 'ready')) {
      const error = new Error('会话已经在启动或运行中：' + id);
      error.code = 'E_SESSION_BUSY';
      error.data = {
        sessionId: id,
        phase: current.phase,
        from: current.canonical,
        to: 'starting',
        since: current.since,
        history: current.history.slice(-5),
        hint: '先 session.stop，或在现有会话上继续操作',
      };
      throw error;
    }
    enter(id, 'starting', { reason: 'begin' });
    return phase(id);
  }

  /** recover()：上次 daemon 持久化的会话恢复为 preparing；对外 phase 仍叫 recovering。 */
  function recover(sessionId) {
    enter(sessionId, 'recovering', { reason: 'daemon-restore' });
    return phase(sessionId);
  }

  function prepare(sessionId, { reason = 'prepare' } = {}) {
    enter(sessionId, 'preparing', { reason });
    return phase(sessionId);
  }

  function activate(sessionId) {
    enter(sessionId, 'active', { reason: 'activate' });
    return phase(sessionId);
  }

  function pause(sessionId, { reason = 'pause', by = null } = {}) {
    enter(sessionId, 'paused', { reason, meta: by ? { evidence: { pausedBy: by } } : {} });
    return phase(sessionId);
  }

  function resume(sessionId, { reason = 'resume' } = {}) {
    const current = states.get(String(sessionId));
    if (!current || current.canonical !== 'paused') return false;
    enter(sessionId, 'active', { reason });
    return true;
  }

  function requestStop(sessionId) {
    const id = String(sessionId);
    const current = states.get(id);
    if (current && current.canonical === 'stopping') return false;
    enter(id, 'stopping', { reason: 'request-stop' });
    return true;
  }

  /** 进入 failed（daemon 启动/派发异常），保留证据；失败不是清理，不删记录。 */
  function fail(sessionId, error) {
    const id = String(sessionId);
    const detail = error && typeof error === 'object'
      ? { code: error.code || 'E_INTERNAL', message: String(error.message || error) }
      : { code: 'E_INTERNAL', message: String(error === undefined ? 'unknown' : error) };
    enter(id, 'failed', { reason: 'fail', meta: { evidence: detail } });
    return get(id);
  }

  function pruneTombstones() {
    // 退休记录只用于证据查询：保留最近 200 条，避免长生命周期 daemon 无界增长。
    while (tombstones.size > 200) {
      const oldest = tombstones.keys().next().value;
      if (oldest === undefined) break;
      tombstones.delete(oldest);
    }
  }

  /**
   * 清理入口：退休为 stopped 并从活动表删除（既有调用方依赖 get() 返回 null）。
   * 如果当前状态不允许直接 → stopped（例如调用方漏了 requestStop），清理仍然执行，
   * 但会记录 forced 的 violation 证据，方便排查状态机被绕开的位置。
   */
  function finish(sessionId, { reason = 'finish' } = {}) {
    const id = String(sessionId);
    const current = states.get(id);
    if (!current) {
      tombstones.set(id, {
        sessionId: id,
        phase: 'stopped',
        canonical: 'stopped',
        since: nowOf(now),
        exitedAt: nowOf(now),
        reason,
        forced: false,
        history: [],
      });
      pruneTombstones();
      return false;
    }
    const at = nowOf(now);
    const legal = isLegalTransition(current.canonical, 'stopped');
    if (legal) {
      if (current.canonical !== 'stopping') {
        // ready/paused/failed 直接退休：迁移表允许 failed→stopped、preparing→stopped，
        // 其余情况按 forced 记录。
        if (!(current.canonical === 'failed' || current.canonical === 'preparing')) {
          recordViolation(id, current.canonical, 'stopped', reason, { forced: true });
          pushTransition(current, current.canonical, 'stopped', reason, { forced: true });
        } else {
          pushTransition(current, current.canonical, 'stopped', reason, {});
        }
      } else {
        pushTransition(current, 'stopping', 'stopped', reason, {});
      }
    } else {
      recordViolation(id, current.canonical, 'stopped', reason, { forced: true });
      pushTransition(current, current.canonical, 'stopped', reason, { forced: true });
    }
    tombstones.set(id, {
      sessionId: id,
      phase: 'stopped',
      canonical: 'stopped',
      since: at,
      exitedAt: at,
      reason,
      forced: !legal,
      history: current.history.slice(-10),
    });
    states.delete(id);
    pruneTombstones();
    return true;
  }

  /** 严格迁移（测试/运维用）：非法迁移抛 E_SESSION_TRANSITION。 */
  function transition(sessionId, to, { reason = 'manual', meta = {}, force = false } = {}) {
    return enter(sessionId, to, { reason, meta, force });
  }

  function describe(sessionId) {
    const current = states.get(String(sessionId));
    if (current) return snapshotState(current);
    const tomb = tombstones.get(String(sessionId));
    return tomb ? { ...tomb, retired: true } : null;
  }

  function history(sessionId) {
    const current = states.get(String(sessionId));
    return current ? current.history.slice() : [];
  }

  function list() {
    return [...states.values()].map((state) => ({
      sessionId: state.sessionId,
      phase: state.phase,
      canonical: state.canonical,
      since: state.since,
    }));
  }

  function listAll() {
    return [
      ...list(),
      ...[...tombstones.values()].map((tomb) => ({
        sessionId: tomb.sessionId,
        phase: tomb.phase,
        canonical: tomb.canonical,
        since: tomb.since,
        retired: true,
        retiredAt: tomb.exitedAt,
        forced: tomb.forced === true,
        reason: tomb.reason,
      })),
    ];
  }

  function violationsOf(sessionId) {
    const id = String(sessionId);
    return violations.filter((item) => item.sessionId === id);
  }

  function snapshot() {
    return {
      states: [...SESSION_STATES],
      transitions: SESSION_TRANSITIONS,
      active: list(),
      retired: [...tombstones.values()].map((tomb) => ({ ...tomb, history: undefined })),
      violations: violations.slice(-20),
      transitionCount,
      violationCount: violations.length,
    };
  }

  function reset() {
    states.clear();
    tombstones.clear();
    violations.length = 0;
    transitionCount = 0;
    seq = 0;
  }

  return {
    // 0.3.0 API
    begin,
    recover,
    activate,
    requestStop,
    finish,
    phase,
    get,
    list,
    // v2 API
    prepare,
    pause,
    resume,
    fail,
    transition,
    canonicalPhase,
    describe,
    history,
    listAll,
    violationsOf,
    allowedTransitions: (sessionId) => {
      const current = states.get(String(sessionId));
      return allowedTransitions(current ? current.canonical : 'idle');
    },
    snapshot,
    reset,
  };
}
