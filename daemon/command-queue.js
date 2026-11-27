// daemon/command-queue.js —— daemon 命令队列：per-session 串行 + tab 轮转公平 + 排队诊断。
//
// 0.3.0 的派发链路是两层纯 FIFO 队列（lib/session-queue.mjs 各建一份）：
//   sessionQueue.enqueue(sessionId, () => tabQueue.enqueue('tab:'+tabId, run))
// 它保证"同一会话串行"，但无法回答：
//   1) 某会话一次压了 50 条命令，另一个会话在同 tab 上要等多久（tab 级 FIFO 会让它饿死）；
//   2) 一条命令排队了多久、被谁挡着、到上限时拒绝原因是什么；
//   3) 每个会话同时有多少条命令真的在跑（inflight 上限）。
//
// 本模块保留 sessionQueue（同一 lib 实现、同样的 64 容量与错误码）做会话串行，
// 在它之上补：
//   - 全局 inflight 上限 + per-session inflight 上限（槽位门，FIFO，等待时长有统计）；
//   - tab 轮转公平调度（同一 tab 上多个会话竞争时，按会话轮转而不是按提交顺序 FIFO，
//     单会话场景下顺序与旧实现完全一致）；
//   - 排队诊断：每会话 pending/inflight/等待 P50/P95/最大、拒绝原因直方图、
//     tab 公平性指标（连续获得次数 / Jain 指数 / 当前最长等待）。
//
// 兼容性：
//   - `snapshot()` 仍返回 lib session-queue 的数组形状（health.status.queues 字段不变）；
//   - `enqueue(sessionId, task)` / `drop(key)` / `capacity` 与 lib 语义一致；
//   - 默认上限足够宽松（见 QUEUE_DEFAULT_LIMITS），正常单/多会话负载不会新增拒绝；
//   - 拒绝码复用已登记清单：排队满=E_QUEUE_FULL、per-session 执行中上限=E_SESSION_BUSY、
//     会话停止=E_SESSION_STOPPED；具体原因放 data.reason，便于 CLI/doctor 归类。
//   - 只有显式传入更小 limits（单测/运维环境变量）才会看到新的拒绝路径。

import { DEFAULT_QUEUE_CAPACITY, createSessionQueue } from '../lib/session-queue.mjs';

/** 默认上限：与 0.3.0 行为兼容（容量 64），其余维度留足余量。 */
export const QUEUE_DEFAULT_LIMITS = Object.freeze({
  capacity: DEFAULT_QUEUE_CAPACITY,
  maxPendingPerSession: DEFAULT_QUEUE_CAPACITY,
  maxPendingGlobal: 1024,
  maxInflight: 64,
  maxInflightPerSession: 8,
  maxTabWaitPerSession: 64,
  maxWaitMs: 0,
});

const WAIT_SAMPLE_LIMIT = 256;

export class QueueLimitError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'QueueLimitError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function positiveIntOr(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** 合并上限覆盖项；非法值退回默认（不允许把容量配成 0 误伤所有命令）。 */
export function normalizeQueueLimits(limits = {}) {
  const source = limits && typeof limits === 'object' ? limits : {};
  const base = QUEUE_DEFAULT_LIMITS;
  return {
    capacity: positiveIntOr(source.capacity, base.capacity),
    maxPendingPerSession: positiveIntOr(source.maxPendingPerSession, base.maxPendingPerSession),
    maxPendingGlobal: positiveIntOr(source.maxPendingGlobal, base.maxPendingGlobal),
    maxInflight: positiveIntOr(source.maxInflight, base.maxInflight),
    maxInflightPerSession: positiveIntOr(source.maxInflightPerSession, base.maxInflightPerSession),
    maxTabWaitPerSession: positiveIntOr(source.maxTabWaitPerSession, base.maxTabWaitPerSession),
    maxWaitMs: Number.isInteger(Number(source.maxWaitMs)) && Number(source.maxWaitMs) >= 0 ? Number(source.maxWaitMs) : base.maxWaitMs,
  };
}

/** 运维/测试用：从环境变量读取队列上限（BB_QUEUE_*），未设置时用默认。 */
export function queueLimitsFromEnv(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const pick = (name) => {
    const raw = source[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
    const number = Number(String(raw).trim());
    return Number.isFinite(number) ? number : undefined;
  };
  return normalizeQueueLimits({
    capacity: pick('BB_QUEUE_CAPACITY'),
    maxPendingPerSession: pick('BB_QUEUE_MAX_PENDING_PER_SESSION'),
    maxPendingGlobal: pick('BB_QUEUE_MAX_PENDING_GLOBAL'),
    maxInflight: pick('BB_QUEUE_MAX_INFLIGHT'),
    maxInflightPerSession: pick('BB_QUEUE_MAX_INFLIGHT_PER_SESSION'),
    maxTabWaitPerSession: pick('BB_QUEUE_MAX_TAB_WAIT_PER_SESSION'),
    maxWaitMs: pick('BB_QUEUE_MAX_WAIT_MS'),
  });
}

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

/** 等待时长统计：avg/max/P50/P95 + 分桶（分桶给 CLI 人类输出用）。 */
export function computeWaitStats(samples) {
  const list = Array.isArray(samples) ? samples.filter((item) => Number.isFinite(item) && item >= 0) : [];
  if (!list.length) {
    return { samples: 0, avgMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, buckets: { lt10: 0, lt100: 0, lt1s: 0, lt5s: 0, gte5s: 0 } };
  }
  const sorted = [...list].sort((a, b) => a - b);
  // nearest-rank 百分位（向上取整）：小样本下 P95 更接近尾部，避免被中位数掩盖。
  const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
  const buckets = { lt10: 0, lt100: 0, lt1s: 0, lt5s: 0, gte5s: 0 };
  for (const value of sorted) {
    if (value < 10) buckets.lt10 += 1;
    else if (value < 100) buckets.lt100 += 1;
    else if (value < 1000) buckets.lt1s += 1;
    else if (value < 5000) buckets.lt5s += 1;
    else buckets.gte5s += 1;
  }
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    samples: sorted.length,
    avgMs: round1(total / sorted.length),
    maxMs: sorted[sorted.length - 1],
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    buckets,
  };
}

/** Jain 公平指数（1=完全平均，1/n=完全独占）。空输入返回 null。 */
export function jainFairnessIndex(counts) {
  const list = Array.isArray(counts) ? counts.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0) : [];
  if (!list.length) return null;
  const sum = list.reduce((acc, value) => acc + value, 0);
  if (sum <= 0) return 1;
  const squares = list.reduce((acc, value) => acc + value * value, 0);
  return Math.round((sum * sum / (list.length * squares)) * 1000) / 1000;
}

function pushSample(list, value) {
  if (!Number.isFinite(value) || value < 0) return;
  list.push(value);
  if (list.length > WAIT_SAMPLE_LIMIT) list.shift();
}

/**
 * FIFO 槽位门：limit 个并发槽位，超出排队；maxWaitMs>0 时超时拒绝（E_QUEUE_FULL + reason 超时）。
 * acquire() 返回 release 函数；调用方必须 finally 里释放。
 */
function createSlotGate({ name, limit, maxWaitMs = 0, now, onWaiter }) {
  let active = 0;
  const waiters = [];
  const stats = { name, limit, acquired: 0, waited: 0, rejected: 0, waitSamples: [], maxWaitMs: 0, peakActive: 0 };

  function makeRelease(waiter) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      pump();
      return waiter ? now() - waiter.acceptedAt : 0;
    };
  }

  function pump() {
    while (active < limit && waiters.length) {
      const waiter = waiters.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      active += 1;
      stats.peakActive = Math.max(stats.peakActive, active);
      stats.acquired += 1;
      const waitedMs = now() - waiter.acceptedAt;
      if (waitedMs > 0) {
        stats.waited += 1;
        stats.maxWaitMs = Math.max(stats.maxWaitMs, waitedMs);
        pushSample(stats.waitSamples, waitedMs);
        if (typeof waiter.onWait === 'function') waiter.onWait(waitedMs);
      }
      waiter.resolve(makeRelease(waiter));
    }
  }

  function acquire({ onWait = null } = {}) {
    if (active < limit && !waiters.length) {
      active += 1;
      stats.acquired += 1;
      stats.peakActive = Math.max(stats.peakActive, active);
      return Promise.resolve(makeRelease(null));
    }
    const acceptedAt = now();
    return new Promise((resolve, reject) => {
      const waiter = { acceptedAt, resolve, reject, settled: false, timer: null, onWait };
      if (maxWaitMs > 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          stats.rejected += 1;
          if (typeof onWaiter === 'function') onWaiter({ gate: name, reason: 'global-wait-timeout', waitedMs: now() - acceptedAt });
          reject(new QueueLimitError('E_QUEUE_FULL', `${name} 队列等待超过 ${maxWaitMs}ms`, {
            gate: name, waitedMs: now() - acceptedAt, limit, reason: 'global-wait-timeout',
          }));
        }, maxWaitMs);
        if (waiter.timer && waiter.timer.unref) waiter.timer.unref();
      }
      waiters.push(waiter);
      if (typeof onWaiter === 'function') onWaiter({ gate: name, reason: 'queued', waitedMs: 0 });
    });
  }

  function snapshot() {
    return {
      name,
      limit,
      active,
      queued: waiters.length,
      acquired: stats.acquired,
      waited: stats.waited,
      rejected: stats.rejected,
      peakActive: stats.peakActive,
      wait: computeWaitStats(stats.waitSamples),
    };
  }

  return { acquire, snapshot, get active() { return active; }, get queued() { return waiters.length; } };
}

/**
 * 命令队列主体。
 * @param {{limits?: object, now?: () => number, log?: Function, sessionQueue?: object}} options
 */
export function createCommandQueue({ limits = {}, now = () => Date.now(), log = () => {}, sessionQueue = null } = {}) {
  const cfg = normalizeQueueLimits(limits);
  const baseQueue = sessionQueue || createSessionQueue({ capacity: cfg.capacity });
  const perSession = new Map();
  const tabs = new Map();
  const totals = {
    dispatch: 0,
    completed: 0,
    failed: 0,
    rejected: 0,
    pending: 0,
    inflight: 0,
    peakInflight: 0,
    bypass: 0,
    direct: 0,
  };
  const rejects = { byCode: Object.create(null), byReason: Object.create(null), total: 0 };
  const globalWaitSamples = [];

  const globalGate = createSlotGate({
    name: 'global',
    limit: cfg.maxInflight,
    maxWaitMs: cfg.maxWaitMs,
    now,
    onWaiter: (event) => {
      if (event.reason === 'global-wait-timeout') recordReject('E_QUEUE_FULL', 'global-wait-timeout', null, null);
    },
  });

  function ensureSession(sessionId) {
    let state = perSession.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        pending: 0,
        inflight: 0,
        inflightPeak: 0,
        dispatched: 0,
        completed: 0,
        failed: 0,
        rejected: 0,
        closed: false,
        closedAt: 0,
        queueWaitSamples: [],
        tabWaitSamples: [],
        inflightWaitSamples: [],
        waitSamples: [],
        rejectReasons: Object.create(null),
        lastReject: null,
        lastActivityAt: now(),
      };
      perSession.set(sessionId, state);
    }
    return state;
  }

  function ensureTab(tabKey) {
    let tab = tabs.get(tabKey);
    if (!tab) {
      tab = {
        tabKey,
        holder: null,
        holderSince: 0,
        waiters: [],
        served: 0,
        lastServed: null,
        consecutive: Object.create(null),
        maxConsecutive: 0,
        sessionsServed: Object.create(null),
        waitSamples: [],
        closed: false,
        accepted: 0,
      };
      tabs.set(tabKey, tab);
    }
    return tab;
  }

  function recordReject(code, reason, session, method) {
    rejects.total += 1;
    rejects.byCode[code] = (rejects.byCode[code] || 0) + 1;
    rejects.byReason[reason] = (rejects.byReason[reason] || 0) + 1;
    totals.rejected += 1;
    if (session) {
      session.rejected += 1;
      session.rejectReasons[reason] = (session.rejectReasons[reason] || 0) + 1;
      session.lastReject = { code, reason, method: method || null, at: now() };
    }
    log(`queue 拒绝 ${code} reason=${reason}${session ? ' session=' + session.sessionId : ''}${method ? ' method=' + method : ''}`);
    return new QueueLimitError(code, reasonMessage(code, reason, session), {
      sessionId: session ? session.sessionId : null,
      reason,
      method: method || null,
      limits: { ...cfg },
      pending: session ? session.pending : totals.pending,
      inflight: session ? session.inflight : totals.inflight,
    });
  }

  function reasonMessage(code, reason, session) {
    if (reason === 'global-wait-timeout') return '命令排队超时（超过 ' + cfg.maxWaitMs + 'ms）';
    if (reason === 'global-pending') return 'daemon 命令队列已满（' + cfg.maxPendingGlobal + '）';
    if (reason === 'session-pending') return '会话 ' + (session ? session.sessionId : '?') + ' 的命令队列已满（' + cfg.maxPendingPerSession + '）';
    if (reason === 'tab-wait') return '会话 ' + (session ? session.sessionId : '?') + ' 在同一 tab 上排队过多（' + cfg.maxTabWaitPerSession + '）';
    if (reason === 'session-closed') return '会话 ' + (session ? session.sessionId : '?') + ' 已停止';
    if (reason === 'tab-closed') return '标签页队列已停止';
    if (reason === 'session-inflight') return '会话 ' + (session ? session.sessionId : '?') + ' 同时执行中的命令已达上限（' + cfg.maxInflightPerSession + '）';
    return code;
  }

  function statWaitSummary(samples) {
    return computeWaitStats(samples);
  }

  // —— tab 公平轮转 ——
  function pumpTab(tabKey) {
    const tab = tabs.get(tabKey);
    if (!tab || tab.holder) return;
    if (!tab.waiters.length) {
      if (tab.closed) tabs.delete(tabKey);
      return;
    }
    // 轮转：优先选"上一次没被服务"的会话（多会话同 tab 时不会让一个会话连续霸占）。
    let index = tab.waiters.findIndex((waiter) => waiter.sessionId !== tab.lastServed);
    if (index < 0) index = 0;
    const [waiter] = tab.waiters.splice(index, 1);
    tab.holder = waiter.sessionId;
    tab.holderSince = now();
    tab.served += 1;
    // 连续获得次数：按"上一次服务对象是否同一会话"计算 streak，maxConsecutive 即饥饿指标。
    const streak = tab.lastServed === waiter.sessionId ? (tab.consecutive[waiter.sessionId] || 0) + 1 : 1;
    tab.consecutive[waiter.sessionId] = streak;
    tab.maxConsecutive = Math.max(tab.maxConsecutive, streak);
    tab.lastServed = waiter.sessionId;
    tab.sessionsServed[waiter.sessionId] = (tab.sessionsServed[waiter.sessionId] || 0) + 1;
    const waitedMs = now() - waiter.acceptedAt;
    pushSample(tab.waitSamples, waitedMs);
    const state = perSession.get(waiter.sessionId);
    if (state) {
      pushSample(state.tabWaitSamples, waitedMs);
      state.lastActivityAt = now();
    }
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      const current = tabs.get(tabKey);
      if (!current) return;
      if (current.holder === waiter.sessionId) current.holder = null;
      pumpTab(tabKey);
      if (current.closed && !current.waiters.length && !current.holder) tabs.delete(tabKey);
    });
  }

  function acquireTabTurn(tabKey, sessionId) {
    const tab = ensureTab(tabKey);
    if (tab.closed) throw new QueueLimitError('E_SESSION_STOPPED', '标签页队列已停止（' + tabKey + '）', { tabKey, reason: 'tab-closed' });
    tab.accepted += 1;
    const waiter = { sessionId, acceptedAt: now(), resolve: null };
    const promise = new Promise((resolve) => { waiter.resolve = resolve; });
    tab.waiters.push(waiter);
    pumpTab(tabKey);
    return promise;
  }

  function startInflight(state) {
    if (state) {
      state.inflight += 1;
      state.inflightPeak = Math.max(state.inflightPeak, state.inflight);
    }
    totals.inflight += 1;
    totals.peakInflight = Math.max(totals.peakInflight, totals.inflight);
  }

  function endInflight(state) {
    if (state && state.inflight > 0) state.inflight -= 1;
    if (totals.inflight > 0) totals.inflight -= 1;
  }

  function releasePending(state) {
    if (state && state.pending > 0) state.pending -= 1;
    if (totals.pending > 0) totals.pending -= 1;
  }

  /** 队列外/旁路命令：不排队、不抢 tab 轮转，只计数（旁路方法本身在等待/解除别的命令）。 */
  async function runDirect({ state, method, run, bypassed }) {
    if (state) {
      if (state.closed) throw recordReject('E_SESSION_STOPPED', 'session-closed', state, method);
      state.dispatched += 1;
      if (bypassed) totals.bypass += 1; else totals.direct += 1;
    }
    startInflight(state);
    try {
      const value = await run();
      totals.completed += 1;
      if (state) {
        state.completed += 1;
        state.lastActivityAt = now();
      }
      return value;
    } catch (error) {
      totals.failed += 1;
      if (state) {
        state.failed += 1;
        state.lastActivityAt = now();
      }
      throw error;
    } finally {
      endInflight(state);
    }
  }

  /**
   * 统一派发入口（route-queue 调用）：
   * @param {{sessionId?: string, tabKey?: string, method?: string, run: Function, bypass?: boolean}} request
   */
  async function dispatch({ sessionId = null, tabKey = null, method = null, run, bypass = false } = {}) {
    if (typeof run !== 'function') throw new TypeError('command queue dispatch 需要 run 函数');
    totals.dispatch += 1;
    const sid = sessionId == null || sessionId === '' ? null : String(sessionId);
    const key = tabKey == null || tabKey === '' ? null : String(tabKey);
    if (!sid) return runDirect({ state: null, method, run, bypassed: false });
    const state = ensureSession(sid);
    if (bypass === true) return runDirect({ state, method, run, bypassed: true });
    if (state.closed) throw recordReject('E_SESSION_STOPPED', 'session-closed', state, method);
    if (totals.pending >= cfg.maxPendingGlobal) throw recordReject('E_QUEUE_FULL', 'global-pending', state, method);
    if (state.pending >= cfg.maxPendingPerSession) throw recordReject('E_QUEUE_FULL', 'session-pending', state, method);
    if (key) {
      const tab = ensureTab(key);
      if (tab.closed) throw recordReject('E_SESSION_STOPPED', 'tab-closed', state, method);
      const waitingForTab = tab.waiters.filter((waiter) => waiter.sessionId === sid).length;
      if (waitingForTab >= cfg.maxTabWaitPerSession) throw recordReject('E_QUEUE_FULL', 'tab-wait', state, method);
    }
    state.dispatched += 1;
    state.pending += 1;
    totals.pending += 1;
    let pendingHeld = true;
    const releaseOnce = () => {
      if (!pendingHeld) return;
      pendingHeld = false;
      releasePending(state);
    };
    const acceptedAt = now();
    try {
      return await baseQueue.enqueue(sid, async () => {
        releaseOnce();
        if (state.closed) throw recordReject('E_SESSION_STOPPED', 'session-closed', state, method);
        const queueWaitedMs = now() - acceptedAt;
        pushSample(state.queueWaitSamples, queueWaitedMs);
        const releaseGlobal = await globalGate.acquire({
          onWait: (waitedMs) => {
            pushSample(globalWaitSamples, waitedMs);
            pushSample(state.inflightWaitSamples, waitedMs);
          },
        });
        let releaseTab = null;
        try {
          // per-session inflight 上限：旁路方法（operation.await 等）同步在跑时，排队命令不硬挤。
          if (state.inflight >= cfg.maxInflightPerSession) {
            throw recordReject('E_SESSION_BUSY', 'session-inflight', state, method);
          }
          if (key) {
            const tabStartedAt = now();
            releaseTab = await acquireTabTurn(key, sid);
            pushSample(state.tabWaitSamples, now() - tabStartedAt);
          }
          startInflight(state);
          const runStartedAt = now();
          pushSample(state.waitSamples, runStartedAt - acceptedAt);
          state.lastActivityAt = runStartedAt;
          try {
            const value = await run();
            totals.completed += 1;
            state.completed += 1;
            return value;
          } catch (error) {
            totals.failed += 1;
            state.failed += 1;
            throw error;
          } finally {
            endInflight(state);
            state.lastActivityAt = now();
          }
        } finally {
          if (releaseTab) releaseTab();
          if (releaseGlobal) releaseGlobal();
        }
      });
    } finally {
      releaseOnce();
    }
  }

  /** 兼容 lib session-queue 的 API：健康检查/旧调用点仍按 sessionId 入队。 */
  function enqueue(sessionId, task) {
    return dispatch({ sessionId, run: task });
  }

  /** 兼容 lib session-queue 的 API：'tab:xxx' 关 tab，其余关会话。 */
  function drop(key) {
    const text = String(key == null ? '' : key);
    if (text.startsWith('tab:')) {
      const tab = tabs.get(text);
      if (tab) {
        tab.closed = true;
        if (!tab.holder && !tab.waiters.length) tabs.delete(text);
      }
      return;
    }
    const state = perSession.get(text);
    baseQueue.drop(text);
    if (state) {
      state.closed = true;
      state.closedAt = now();
    }
  }

  /** health.status.queues 的既有形状（lib session-queue.snapshot() 数组）。 */
  function snapshot() {
    return baseQueue.snapshot();
  }

  function tabDiagnostics() {
    return [...tabs.values()].map((tab) => {
      const servedCounts = Object.values(tab.sessionsServed || {});
      return {
        tabKey: tab.tabKey,
        holder: tab.holder,
        holderForMs: tab.holder ? Math.max(0, now() - tab.holderSince) : 0,
        queued: tab.waiters.length,
        queuedSessions: [...new Set(tab.waiters.map((waiter) => waiter.sessionId))],
        served: tab.served,
        maxConsecutive: tab.maxConsecutive,
        lastServed: tab.lastServed,
        closed: tab.closed === true,
        fairness: jainFairnessIndex(servedCounts),
        wait: statWaitSummary(tab.waitSamples),
        longestQueuedMs: tab.waiters.length ? Math.max(...tab.waiters.map((waiter) => now() - waiter.acceptedAt)) : 0,
      };
    }).sort((a, b) => b.queued - a.queued || b.served - a.served);
  }

  /** 每会话排队诊断（等待时长/拒绝原因/公平份额），CLI `daemon queue` 直接打印。 */
  function diagnostics({ limitSessions = 50, tabLimit = 20 } = {}) {
    const sessions = [...perSession.values()].map((state) => {
      const totalWait = statWaitSummary(state.waitSamples);
      const completedShare = totals.completed > 0 ? round1((state.completed / totals.completed) * 100) : 0;
      return {
        sessionId: state.sessionId,
        pending: state.pending,
        inflight: state.inflight,
        inflightPeak: state.inflightPeak,
        closed: state.closed === true,
        dispatched: state.dispatched,
        completed: state.completed,
        failed: state.failed,
        rejected: state.rejected,
        completedSharePercent: completedShare,
        wait: totalWait,
        queueWait: statWaitSummary(state.queueWaitSamples),
        tabWait: statWaitSummary(state.tabWaitSamples),
        inflightWait: statWaitSummary(state.inflightWaitSamples),
        rejectReasons: { ...state.rejectReasons },
        lastReject: state.lastReject,
        lastActivityAt: state.lastActivityAt,
      };
    }).sort((a, b) => b.pending - a.pending || b.inflight - a.inflight || a.sessionId.localeCompare(b.sessionId));
    const tabsView = tabDiagnostics();
    const maxSession = Number.isInteger(limitSessions) && limitSessions > 0 ? limitSessions : 50;
    const maxTabs = Number.isInteger(tabLimit) && tabLimit > 0 ? tabLimit : 20;
    const fairnessIndex = jainFairnessIndex(sessions.map((state) => state.completed));
    const starving = tabsView.filter((tab) => tab.longestQueuedMs > 0);
    return {
      at: now(),
      capacity: baseQueue.capacity,
      limits: { ...cfg },
      totals: {
        ...totals,
        pendingBySessions: sessions.filter((state) => state.pending > 0).length,
        rejectRate: totals.dispatch > 0 ? round1((totals.rejected / totals.dispatch) * 100) : 0,
        completedShareFairness: fairnessIndex,
      },
      inflight: {
        current: totals.inflight,
        peak: totals.peakInflight,
        limit: cfg.maxInflight,
        global: globalGate.snapshot(),
        wait: statWaitSummary(globalWaitSamples),
      },
      fairness: {
        strategy: 'round-robin-per-tab',
        jainIndex: fairnessIndex,
        sessions: sessions.length,
        maxConsecutive: tabsView.reduce((max, tab) => Math.max(max, tab.maxConsecutive), 0),
        starvingTabs: starving.length,
        longestQueuedMs: tabsView.reduce((max, tab) => Math.max(max, tab.longestQueuedMs), 0),
        tabs: tabsView.slice(0, maxTabs),
        tabsTruncated: tabsView.length > maxTabs,
      },
      rejects: {
        total: rejects.total,
        byCode: { ...rejects.byCode },
        byReason: { ...rejects.byReason },
      },
      sessions: sessions.slice(0, maxSession),
      sessionsTruncated: sessions.length > maxSession,
    };
  }

  /** 供单测/diagnosis 观察内部会话状态（只读拷贝）。 */
  function sessionState(sessionId) {
    const state = perSession.get(String(sessionId));
    return state ? { ...state, rejectReasons: { ...state.rejectReasons } } : null;
  }

  return {
    dispatch,
    enqueue,
    drop,
    snapshot,
    diagnostics,
    sessionState,
    limits: cfg,
    get capacity() { return baseQueue.capacity; },
  };
}
