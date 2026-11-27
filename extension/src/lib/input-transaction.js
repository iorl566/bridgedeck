import { createInputClock } from './input-clock.js';

/**
 * 每 tab 同一时刻只允许一个原生输入事务；崩溃/超时后可过期回收。
 *
 * 时钟余项（W2）：stamp() 返回全局单调序号 globalSeq（跨事务共享），
 * snapshot()/order() 给出“跨事务顺序”结构化报告，供动作结果与测试取证。
 */
export class InputTransactions {
  constructor({ ttlMs = 15000, now = Date.now, clock, clockNow } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    // 原生输入时钟：per-transaction epoch + 单调序号，供 CDP 事件 timestamp 与账本记录。
    // 默认用 performance.now（单调）；clockNow 可注入，注入 clock 时整个时钟由调用方控制。
    this.clock = clock || createInputClock(typeof clockNow === 'function' ? { now: clockNow } : {});
    this.byTab = new Map();
    this.counters = { begins: 0, ends: 0, expired: 0, stamps: 0, busy: 0 };
  }

  begin(tabId, kind) {
    const current = this.byTab.get(tabId);
    if (current) {
      if (this.now() - current.at < this.ttlMs) {
        this.counters.busy += 1;
        return { ok: false, code: 'E_INPUT_BUSY', active: { ...current } };
      }
      // 过期的输入事务：视为释放，避免一次异常永久锁死标签页。
      this.clock.end(current.epoch, 'expired');
      this.byTab.delete(tabId);
      this.counters.expired += 1;
    }
    const at = this.now();
    const handle = this.clock.begin(tabId, kind);
    const tx = {
      kind: String(kind || 'input'),
      at,
      epoch: handle.epoch,
      seq: 0,
      lastAt: null,
      lastTimestamp: null,
      globalSeq: null,
      firstGlobalSeq: null,
      equalReadings: 0,
      wakes: 0,
    };
    this.byTab.set(tabId, tx);
    this.counters.begins += 1;
    return { ok: true, active: { ...tx } };
  }

  /**
   * 给当前事务取一个只增时间戳（timestamp 单位秒，CDP 口径）。
   * 时钟回退/事务乱序返回结构化错误，调用方应在派发前中止。
   * 返回值额外带 globalSeq / equal / woke，便于调用方把“时钟余项”写进动作结果。
   */
  stamp(tabId) {
    const current = this.byTab.get(tabId);
    if (!current) {
      return {
        ok: false,
        code: 'E_INTERNAL',
        cause: 'clock_stale',
        message: '当前标签页没有进行中的输入事务',
        evidence: { clock: 'input', tabId: Number(tabId), epoch: null, seq: 0, previousAt: null, observedAt: null },
      };
    }
    const tick = this.clock.tick(current.epoch);
    if (tick.ok !== true) return tick;
    this.counters.stamps += 1;
    current.seq = tick.seq;
    current.lastAt = tick.at;
    current.lastTimestamp = tick.timestamp;
    current.globalSeq = tick.globalSeq;
    if (current.firstGlobalSeq === null) current.firstGlobalSeq = tick.globalSeq;
    if (tick.equal === true) current.equalReadings += 1;
    if (tick.woke === true) current.wakes += 1;
    return {
      ...tick,
      transaction: {
        kind: current.kind,
        epoch: current.epoch,
        seq: current.seq,
        firstGlobalSeq: current.firstGlobalSeq,
        lastGlobalSeq: current.globalSeq,
      },
    };
  }

  end(tabId, kind) {
    const current = this.byTab.get(tabId);
    if (!current) return false;
    if (kind && current.kind !== kind) return false;
    this.clock.end(current.epoch, 'end');
    this.byTab.delete(tabId);
    this.counters.ends += 1;
    return true;
  }

  get(tabId) {
    return this.byTab.get(tabId) || null;
  }

  /** 跨事务顺序报告：同一 tab 的并发/交错判 violation；不同 tab 并行合法。 */
  order(options = {}) {
    return this.clock.transactionOrder(options);
  }

  /** 时钟快照 + 活动事务：把“相等读数/唤醒/跨事务顺序”一次性暴露给调用方。 */
  snapshot() {
    const active = [...this.byTab.entries()].map(([tabId, tx]) => ({
      tabId: Number(tabId),
      kind: tx.kind,
      epoch: tx.epoch,
      seq: tx.seq,
      lastAt: tx.lastAt,
      lastTimestamp: tx.lastTimestamp,
      firstGlobalSeq: tx.firstGlobalSeq,
      lastGlobalSeq: tx.globalSeq,
      equalReadings: tx.equalReadings,
      wakes: tx.wakes,
    }));
    return {
      clock: this.clock.snapshot(),
      active,
      order: this.clock.transactionOrder(),
      counters: { ...this.counters },
    };
  }

  clear() {
    for (const current of this.byTab.values()) this.clock.end(current.epoch, 'clear');
    this.byTab.clear();
    this.counters = { begins: 0, ends: 0, expired: 0, stamps: 0, busy: 0 };
  }
}

export const inputTransactions = new InputTransactions();
