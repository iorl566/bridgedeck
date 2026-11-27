// src/lib/suppression-scope.js —— capture 抑制作用域：acqurie 在动作最外层、release 在 finally。
//
// 0.3.0 的 capture 抑制只在 overlay-suppress 内部用：截图/原生输入真正开始前才会
// acquire，而且“没有浮层”时直接跳过（连引用都不拿）。中心枢纽 dispatch.js/ops.js
// 从来没有把一次截图/原生输入整体包起来，于是：
//   - 截图过程中浮层才被打开（例如借用确认弹出来）不会被抑制，会被截进图里；
//   - 动作抛错/卡死时没有任何地方能证明抑制被释放，只能靠引用计数兜底；
//   - 诊断里看不到“当前是谁在抑制、抑制了多久、为什么释放”。
//
// 本模块给 dispatch/ops 一个可证据化的作用域：
//   begin(tabId, {kind, method})   取一次引用并登记作用域（含“最长持有”看门狗）
//   end(tabId, {scopeId, outcome}) 释放并记录结局（ok/error/timeout/expired）
//   run(tabId, options, fn)        begin → fn → finally end；抛错时把证据塞进 error.data
// 看门狗：超过 maxHoldMs 自动释放并标记 expired（失败/卡死路径也不会永久抑制）。

import { captureSuppression } from './capture-suppression.js';

export const SUPPRESSION_OUTCOMES = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
  TIMEOUT: 'timeout',
  EXPIRED: 'expired',
  SKIPPED: 'skipped',
});

export const SUPPRESSION_KINDS = Object.freeze({
  CAPTURE: 'capture',
  NATIVE_INPUT: 'native-input',
  RECORD_SHOT: 'record-shot',
  MANUAL: 'manual',
});

const DEFAULT_MAX_HOLD_MS = 180000;
const DEFAULT_HISTORY = 32;

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

/**
 * 创建一个抑制作用域管理器。
 * @param {{suppression?: object, now?: () => number, maxHoldMs?: number, historyLimit?: number,
 *          timers?: {setTimeout: Function, clearTimeout: Function}}} [options]
 */
export function createSuppressionScope(options = {}) {
  const suppression = options.suppression && typeof options.suppression.acquire === 'function'
    ? options.suppression
    : captureSuppression;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let maxHoldMs = Number(options.maxHoldMs) > 0 ? Number(options.maxHoldMs) : DEFAULT_MAX_HOLD_MS;
  const historyLimit = Number.isInteger(options.historyLimit) && options.historyLimit > 0 ? options.historyLimit : DEFAULT_HISTORY;
  const timerApi = options.timers && typeof options.timers.setTimeout === 'function'
    ? options.timers
    : { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle) };
  const active = new Map(); // tabId -> Map(scopeId -> scope)
  const history = [];
  const stats = { begun: 0, ended: 0, expired: 0, failed: 0, skipped: 0, peakCount: 0 };
  let sequence = 0;

  function scopeMap(tabId) {
    let map = active.get(tabId);
    if (!map) {
      map = new Map();
      active.set(tabId, map);
    }
    return map;
  }

  function remember(entry) {
    history.push(entry);
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
  }

  function summaryOf(scope) {
    return {
      scopeId: scope.scopeId,
      tabId: scope.tabId,
      kind: scope.kind,
      method: scope.method,
      owner: scope.owner,
      token: scope.token,
      startedAt: scope.startedAt,
      heldMs: Math.max(0, now() - scope.startedAt),
      count: scope.count,
      released: scope.released,
      outcome: scope.outcome,
      expired: scope.expired,
    };
  }

  /**
   * 取一次抑制引用。若引用上限已满（E_CAPTURE_LIMIT）或 tabId 非法，返回 skipped
   * 作用域——调用方继续动作，但证据里明确写了“没有抑制”，不能假装成功。
   */
  function begin(tabId, beginOptions = {}) {
    const id = normalizeTabId(tabId);
    const kind = String(beginOptions.kind || SUPPRESSION_KINDS.CAPTURE).slice(0, 32);
    const method = String(beginOptions.method || '').slice(0, 64);
    const owner = String(beginOptions.owner || ('dispatch:' + kind)).slice(0, 48);
    if (id == null) {
      stats.skipped += 1;
      return { ok: false, skipped: true, code: 'E_CAPTURE_BAD_TAB', tabId: null, scopeId: null, evidence: { tabId: null, kind, method, reason: 'bad-tab' } };
    }
    const lease = suppression.acquire(id, { owner });
    if (!lease || lease.ok !== true) {
      stats.skipped += 1;
      return {
        ok: false,
        skipped: true,
        code: (lease && lease.code) || 'E_CAPTURE_LIMIT',
        tabId: id,
        scopeId: null,
        evidence: { tabId: id, kind, method, owner, code: (lease && lease.code) || null, reason: 'acquire-failed' },
      };
    }
    sequence = (sequence + 1) % 0xffffff;
    const scopeId = 'sup-' + sequence.toString(36) + '-' + now().toString(36);
    const scope = {
      scopeId,
      tabId: id,
      kind,
      method,
      owner,
      token: lease.token,
      count: lease.count,
      startedAt: now(),
      released: false,
      outcome: null,
      expired: false,
      timer: null,
    };
    scopeMap(id).set(scopeId, scope);
    stats.begun += 1;
    stats.peakCount = Math.max(stats.peakCount, lease.count);
    // 看门狗：动作卡死时也要释放，否则该 tab 的浮层会被永久隐藏。
    scope.timer = timerApi.setTimeout(() => {
      if (scope.released) return;
      scope.expired = true;
      stats.expired += 1;
      const released = suppression.release(id, scope.token);
      scope.released = true;
      scope.outcome = SUPPRESSION_OUTCOMES.EXPIRED;
      scope.endedAt = now();
      scope.countAfter = released && Number.isInteger(released.count) ? released.count : 0;
      const map = active.get(id);
      if (map) {
        map.delete(scopeId);
        if (!map.size) active.delete(id);
      }
      remember({ ...summaryOf(scope), kind: 'expired', at: now() });
    }, maxHoldMs);
    return {
      ok: true,
      tabId: id,
      scopeId,
      count: lease.count,
      kind,
      method,
      evidence: { tabId: id, scopeId, kind, method, owner, count: lease.count, startedAt: scope.startedAt, maxHoldMs },
    };
  }

  /** 释放一次引用；重复 end 幂等（alreadyReleased=true），绝不抛异常。 */
  function end(tabId, endOptions = {}) {
    const id = normalizeTabId(tabId);
    if (id == null) {
      return { ok: false, code: 'E_CAPTURE_BAD_TAB', tabId: null, evidence: { tabId: null, reason: 'bad-tab' } };
    }
    const map = active.get(id);
    const requested = endOptions.scopeId != null ? String(endOptions.scopeId) : null;
    const scope = requested
      ? (map ? map.get(requested) : null)
      : (map ? map.values().next().value : null);
    if (!scope) {
      // 看门狗已经释放过：按 expiry 结局返回，不当成失败。
      return { ok: true, released: false, alreadyReleased: true, tabId: id, outcome: SUPPRESSION_OUTCOMES.EXPIRED, evidence: { tabId: id, scopeId: requested, alreadyReleased: true } };
    }
    const outcome = String(endOptions.outcome || SUPPRESSION_OUTCOMES.OK);
    if (scope.timer != null) timerApi.clearTimeout(scope.timer);
    scope.timer = null;
    const released = suppression.release(id, scope.token);
    scope.released = true;
    scope.outcome = outcome;
    scope.endedAt = now();
    scope.countAfter = released && Number.isInteger(released.count) ? released.count : 0;
    map.delete(scope.scopeId);
    if (!map.size) active.delete(id);
    stats.ended += 1;
    if (outcome === SUPPRESSION_OUTCOMES.ERROR || outcome === SUPPRESSION_OUTCOMES.TIMEOUT) stats.failed += 1;
    const evidence = {
      ...summaryOf(scope),
      outcome,
      endedAt: scope.endedAt,
      disabled: released ? released.disabled === true : false,
      duplicate: released ? released.duplicate === true : false,
      released: true,
    };
    remember({ kind: 'end', at: now(), ...evidence });
    return { ok: true, released: true, tabId: id, scopeId: scope.scopeId, outcome, evidence };
  }

  /**
   * 包住一次真正的截图/原生输入：begin → fn → finally end。
   * fn 抛错时把抑制证据塞进 error.data.suppression（不吞原始错误）。
   */
  async function run(tabId, runOptions, fn) {
    const callback = typeof runOptions === 'function' ? runOptions : fn;
    const optionsObject = typeof runOptions === 'function' ? {} : (runOptions || {});
    if (typeof callback !== 'function') throw new TypeError('suppression.run 需要函数');
    const started = begin(tabId, optionsObject);
    if (!started.ok) return callback();
    try {
      const result = await callback();
      end(tabId, { scopeId: started.scopeId, outcome: SUPPRESSION_OUTCOMES.OK });
      return result;
    } catch (error) {
      const evidence = end(tabId, { scopeId: started.scopeId, outcome: SUPPRESSION_OUTCOMES.ERROR });
      if (error && typeof error === 'object') {
        error.data = {
          ...(error.data && typeof error.data === 'object' ? error.data : {}),
          suppression: evidence.evidence,
        };
      }
      throw error;
    }
  }

  /** 当前活着的抑制作用域（供 toolbar/诊断展示“谁在抑制、多久了”）。 */
  function list(tabId) {
    const id = normalizeTabId(tabId);
    if (id == null) {
      const all = [];
      for (const [key, map] of active) for (const scope of map.values()) all.push(summaryOf(scope));
      return all;
    }
    const map = active.get(id);
    return map ? [...map.values()].map(summaryOf) : [];
  }

  function snapshot(tabId) {
    const id = normalizeTabId(tabId);
    const live = id == null ? list(null) : list(id);
    const capture = suppression.snapshot(id);
    return {
      tabId: id,
      live,
      active: live.length > 0,
      count: capture ? capture.count : 0,
      effective: capture ? capture.effective === true : false,
      pending: capture ? capture.pending : [],
      holders: capture ? capture.holders : [],
      maxHoldMs,
      history: history.slice(-8),
      counters: { ...stats },
    };
  }

  function recent(tabId) {
    const id = normalizeTabId(tabId);
    return history.filter((entry) => entry.tabId === id).slice(-8);
  }

  /** 测试/诊断可调：看门狗最长持有时间（只影响之后 begin 的作用域）。 */
  function setMaxHoldMs(value) {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) return maxHoldMs;
    maxHoldMs = next;
    return maxHoldMs;
  }

  function counters() {
    return { ...stats, tabs: active.size };
  }

  function reset() {
    for (const [id, map] of [...active]) {
      for (const scope of map.values()) {
        if (scope.timer != null) timerApi.clearTimeout(scope.timer);
        suppression.release(id, scope.token);
      }
    }
    active.clear();
    history.length = 0;
    return { ok: true };
  }

  return { begin, end, run, list, snapshot, recent, counters, reset, setMaxHoldMs, get maxHoldMs() { return maxHoldMs; } };
}

/** 后台共享单例：dispatch（截图/原生输入）与 ops（录制步骤截图）共用。 */
export const suppressionScope = createSuppressionScope();
