// src/lib/input-clock.js —— 原生输入单调时钟（含休眠唤醒检测与跨事务顺序）。
//
// CDP 的 Input.dispatchMouseEvent.timestamp 是 TimeSinceEpoch（秒），浏览器不保证
// Date.now() 不倒退（校时/NTP/休眠唤醒），乱序时间戳会让原生事件被丢弃或重排。
// 这里用单调源（performance.now 优先，可注入）做增量，给每个输入事务发
// epoch + 单调序号；时间回退/事务乱序返回结构化错误，让调用方在派发前中止。
//
// 时钟余项的三种“结构化结果”（W2 动作事务补充）：
//   1) 相等读数：observed === lastAt 不报回退，标 equal:true（CDP 允许重复 timestamp）；
//   2) 休眠唤醒：单调源与墙钟同时采样，墙钟跳变远大于单调增量时标 woke:true 并留 wake 证据；
//   3) 跨事务顺序：全局单调序号 globalSeq + 每事务 first/last 区间，可导出顺序报告，
//      同一 tab 的并发/交错会被判 violation（不同 tab 并行是允许的）。
const DEFAULT_EPOCH_MS = 0;
const DEFAULT_WAKE_THRESHOLD_MS = 2000;
const HISTORY_LIMIT = 32;
const WAKE_LIMIT = 8;

function defaultNow() {
  try {
    if (globalThis.performance && typeof globalThis.performance.now === 'function') {
      return globalThis.performance.now();
    }
  } catch {
    // 忽略：回退到 Date.now
  }
  return Date.now();
}

function defaultWallNow() {
  return Date.now();
}

function toEpoch(value) {
  if (value && typeof value === 'object') return Number(value.epoch);
  return Number(value);
}

function roundMs(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * 创建单调输入时钟。
 * @param {{ now?: () => number, wallNow?: () => number, epochMs?: number, toleranceMs?: number,
 *   wakeThresholdMs?: number, historyLimit?: number }} [options]
 *   now：单调毫秒源；wallNow：墙钟毫秒源（休眠检测用）；epochMs：单调源零点对应的墙钟毫秒
 *   （默认按 Date.now() - now() 推算）；toleranceMs：允许的微小回退（默认 0，任何回退都算异常）；
 *   wakeThresholdMs：墙钟相对单调源的跳变阈值，超过即记一次唤醒。
 */
export function createInputClock(options = {}) {
  const source = typeof options.now === 'function' ? options.now : defaultNow;
  const wallSource = typeof options.wallNow === 'function' ? options.wallNow : defaultWallNow;
  const toleranceMs = Number.isFinite(options.toleranceMs) && options.toleranceMs >= 0 ? options.toleranceMs : 0;
  const wakeThresholdMs = Number.isFinite(options.wakeThresholdMs) && options.wakeThresholdMs >= 0
    ? options.wakeThresholdMs
    : DEFAULT_WAKE_THRESHOLD_MS;
  const historyLimit = Number.isInteger(options.historyLimit) && options.historyLimit > 0 ? options.historyLimit : HISTORY_LIMIT;
  const firstReading = Number(source());
  const epochMs = Number.isFinite(options.epochMs)
    ? options.epochMs
    : (Number.isFinite(firstReading) ? Date.now() - firstReading : Number(DEFAULT_EPOCH_MS));
  let lastAt = null;
  let lastWallAt = null;
  let lastMonoAt = null;
  let epochCounter = 0;
  let globalSeq = 0;
  let equalReadings = 0;
  let wakeCount = 0;
  const wakes = [];
  const history = [];
  const transactions = new Map(); // epoch -> { epoch, tabId, kind, seq, at, timestamp, ended, firstGlobalSeq, ... }

  function failure(cause, message, evidence) {
    return { ok: false, code: 'E_INTERNAL', cause, message, evidence: { clock: 'input', ...evidence } };
  }

  function resolve(handle) {
    const epoch = toEpoch(handle);
    if (!Number.isInteger(epoch)) return null;
    return transactions.get(epoch) || null;
  }

  function wallReading() {
    try {
      const value = Number(wallSource());
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** 开一个新输入事务，返回 epoch 句柄；epoch 全局单调递增。 */
  function begin(tabId, kind) {
    epochCounter += 1;
    const id = Number(tabId);
    const tx = {
      epoch: epochCounter,
      tabId: Number.isInteger(id) ? id : null,
      kind: String(kind || 'input'),
      seq: 0,
      at: null,
      timestamp: null,
      ended: false,
      firstGlobalSeq: null,
      lastGlobalSeq: null,
      firstAt: null,
      wakeAt: null,
    };
    transactions.set(tx.epoch, tx);
    return { ok: true, epoch: tx.epoch, tabId: tx.tabId, kind: tx.kind };
  }

  /**
   * 取下一个单调时间戳。时间回退返回 { ok:false, cause:'clock_regression', evidence }；
   * 事务已结束/不存在返回 cause:'clock_stale'。成功时 timestamp 单位为秒（CDP 口径）。
   */
  function tick(handle) {
    const tx = resolve(handle);
    const epoch = toEpoch(handle);
    if (!tx) {
      return failure('clock_stale', '输入时钟事务不存在或已结束', {
        epoch: Number.isInteger(epoch) ? epoch : null,
        seq: 0,
        previousAt: lastAt,
        observedAt: null,
      });
    }
    if (tx.ended) {
      return failure('clock_stale', '输入时钟事务已结束，不能再派发', {
        epoch: tx.epoch,
        seq: tx.seq,
        previousAt: lastAt,
        observedAt: null,
      });
    }
    const observed = Number(source());
    if (!Number.isFinite(observed)) {
      return failure('clock_bad_source', '单调时钟源返回了非数值', {
        epoch: tx.epoch,
        seq: tx.seq,
        previousAt: lastAt,
        observedAt: null,
      });
    }
    // 墙钟采样：只用于“休眠唤醒”诊断，绝不参与 timestamp 计算。
    const wallObserved = wallReading();
    const wallDeltaMs = lastWallAt !== null && wallObserved !== null ? roundMs(wallObserved - lastWallAt) : null;
    let at = observed;
    let clamped = false;
    let equal = false;
    if (lastAt !== null && observed < lastAt) {
      const deltaMs = lastAt - observed;
      if (deltaMs > toleranceMs) {
        return failure('clock_regression', '单调时钟回退：时间戳只增不减，已拒绝本次派发', {
          epoch: tx.epoch,
          seq: tx.seq,
          previousAt: lastAt,
          observedAt: observed,
          deltaMs,
        });
      }
      at = lastAt;
      clamped = true;
    } else if (lastAt !== null && observed === lastAt) {
      // 相等读数：不推进也不拒绝；CDP 允许相同 timestamp，但会记录证据供合并策略参考。
      equal = true;
      equalReadings += 1;
    }
    const monoDeltaMs = lastMonoAt !== null ? roundMs(Math.max(0, observed - lastMonoAt)) : null;
    let woke = false;
    let wake = null;
    if (wallDeltaMs !== null && monoDeltaMs !== null) {
      const gapMs = roundMs(wallDeltaMs - monoDeltaMs);
      if (gapMs !== null && gapMs >= wakeThresholdMs) {
        woke = true;
        wakeCount += 1;
        wake = { at: roundMs(at), wallAt: wallObserved, gapMs, monoDeltaMs, wallDeltaMs, epoch: tx.epoch };
        wakes.push(wake);
        if (wakes.length > WAKE_LIMIT) wakes.shift();
      }
    }
    lastAt = at;
    lastWallAt = wallObserved !== null ? wallObserved : lastWallAt;
    lastMonoAt = observed;
    globalSeq += 1;
    tx.seq += 1;
    tx.at = at;
    tx.timestamp = (epochMs + at) / 1000;
    if (tx.firstGlobalSeq === null) {
      tx.firstGlobalSeq = globalSeq;
      tx.firstAt = at;
    }
    tx.lastGlobalSeq = globalSeq;
    if (woke) tx.wakeAt = at;
    return {
      ok: true,
      clock: 'input',
      epoch: tx.epoch,
      tabId: tx.tabId,
      kind: tx.kind,
      seq: tx.seq,
      globalSeq,
      at,
      timestamp: tx.timestamp,
      clamped,
      equal,
      woke,
      monoDeltaMs,
      wallDeltaMs,
      ...(wake ? { wake } : {}),
    };
  }

  function summarizeTransaction(tx) {
    return {
      epoch: tx.epoch,
      tabId: tx.tabId,
      kind: tx.kind,
      seq: tx.seq,
      firstGlobalSeq: tx.firstGlobalSeq,
      lastGlobalSeq: tx.lastGlobalSeq,
      firstAt: tx.firstAt,
      lastAt: tx.at,
      wakeAt: tx.wakeAt,
      ended: tx.ended === true,
      ...(typeof tx.endReason === 'string' ? { endReason: tx.endReason } : {}),
    };
  }

  /** 结束事务；返回该事务的事件数与最后时间戳，供账本记录。 */
  function end(handle, reason) {
    const tx = resolve(handle);
    if (!tx) {
      return failure('clock_stale', '输入时钟事务不存在', { epoch: toEpoch(handle), seq: 0, previousAt: lastAt, observedAt: null });
    }
    if (tx.ended) {
      return { ok: true, clock: 'input', epoch: tx.epoch, seq: tx.seq, events: tx.seq, alreadyEnded: true };
    }
    tx.ended = true;
    tx.endReason = reason ? String(reason) : null;
    transactions.delete(tx.epoch);
    history.push(summarizeTransaction(tx));
    if (history.length > historyLimit) history.shift();
    return {
      ok: true,
      clock: 'input',
      epoch: tx.epoch,
      seq: tx.seq,
      events: tx.seq,
      globalSeq: tx.lastGlobalSeq,
      lastAt: tx.at,
      lastTimestamp: tx.timestamp,
      reason: reason ? String(reason) : null,
      endedAt: lastAt,
      woke: tx.wakeAt !== null,
    };
  }

  /**
   * 跨事务顺序报告：按全局序号列出事务区间，并检查同一 tab 的区间是否重叠/逆序。
   * 不同 tab 并行交错是合法的（multi-tab 场景），只报同 tab 冲突。
   */
  function transactionOrder(options = {}) {
    const includeActive = options.includeActive !== false;
    const active = includeActive ? [...transactions.values()].map(summarizeTransaction) : [];
    const all = [...history, ...active].filter((item) => item.firstGlobalSeq !== null);
    all.sort((a, b) => (a.firstGlobalSeq || 0) - (b.firstGlobalSeq || 0));
    const violations = [];
    const lastByTab = new Map();
    for (const item of all) {
      if (item.tabId !== null) {
        const previous = lastByTab.get(item.tabId);
        if (previous) {
          if (item.firstGlobalSeq < previous.lastGlobalSeq) {
            violations.push({
              kind: 'tab-interleaved',
              tabId: item.tabId,
              earlierEpoch: previous.epoch,
              laterEpoch: item.epoch,
              earlierLastGlobalSeq: previous.lastGlobalSeq,
              laterFirstGlobalSeq: item.firstGlobalSeq,
            });
          } else if (item.epoch < previous.epoch) {
            violations.push({
              kind: 'epoch-order',
              tabId: item.tabId,
              earlierEpoch: previous.epoch,
              laterEpoch: item.epoch,
            });
          }
        }
        lastByTab.set(item.tabId, item);
      }
    }
    return {
      ok: violations.length === 0,
      clock: 'input',
      globalSeq,
      transactions: all,
      active: active.length,
      ended: history.length,
      parallel: all.length > 1,
      violations,
      wakes: wakes.slice(),
    };
  }

  /** 清空所有事务与历史（测试/扩展重载用）；计数器一并归零。 */
  function clear() {
    transactions.clear();
    history.length = 0;
    wakes.length = 0;
    lastAt = null;
    lastWallAt = null;
    lastMonoAt = null;
    globalSeq = 0;
    equalReadings = 0;
    wakeCount = 0;
  }

  function snapshot() {
    return {
      clock: 'input',
      epoch: epochCounter,
      globalSeq,
      lastAt,
      lastWallAt,
      equalReadings,
      wakeCount,
      lastWake: wakes.length ? wakes[wakes.length - 1] : null,
      active: [...transactions.values()]
        .filter((tx) => !tx.ended)
        .map((tx) => ({ epoch: tx.epoch, tabId: tx.tabId, kind: tx.kind, seq: tx.seq, at: tx.at, firstGlobalSeq: tx.firstGlobalSeq, lastGlobalSeq: tx.lastGlobalSeq })),
    };
  }

  return { begin, tick, end, clear, snapshot, transactionOrder, wakes: () => wakes.slice(), history: () => history.map((item) => ({ ...item })) };
}
