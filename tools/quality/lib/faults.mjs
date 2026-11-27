// tools/quality/lib/faults.mjs —— 反脆弱门禁的注入工具（假定时器/预算/取消/临时目录）。
//
// 反脆弱检查必须能在**不等待真实时间**的前提下证明：超时会触发、取消会清理、
// 预算耗尽会结构化失败、临时目录与 timer 不会残留。这里只提供注入原语，
// 断言留给 gate（真实模块 + 注入故障）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixedClock } from './prng.mjs';

/** 假定时器：与 registry 协作时把"等待"变成"手动推进"。 */
export function createFakeTimers(startMs = 1700000000000) {
  const clock = createFixedClock(startMs);
  const timers = new Map();
  let nextId = 1;
  const api = {
    now: () => clock.now(),
    setTimeout(callback, ms = 0) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, dueAt: clock.now() + Math.max(0, Number(ms) || 0), callback });
      return id;
    },
    clearTimeout(id) {
      if (id == null) return false;
      return timers.delete(Number(id));
    },
    setInterval() {
      throw new Error('fake timers 不支持 interval（门禁不使用周期定时器）');
    },
    pending() {
      return timers.size;
    },
    pendingIds() {
      return [...timers.keys()].sort((left, right) => left - right);
    },
    /** 推进假时钟并执行到期回调（回调里可以再注册新的 timer）。 */
    advance(ms = 0) {
      const target = clock.now() + Math.max(0, Number(ms) || 0);
      let fired = 0;
      let guard = 0;
      for (;;) {
        if (guard > 10000) throw new Error('fake timers advance 超过 10000 次回调，疑似死循环');
        guard += 1;
        const due = [...timers.values()]
          .filter((timer) => timer.dueAt <= target)
          .sort((left, right) => (left.dueAt - right.dueAt) || (left.id - right.id))[0];
        if (!due) break;
        timers.delete(due.id);
        if (due.dueAt > clock.now()) clock.advance(due.dueAt - clock.now());
        due.callback();
        fired += 1;
      }
      if (target > clock.now()) clock.advance(target - clock.now());
      return fired;
    },
    clock,
  };
  return api;
}

/** 让出一轮事件循环（假定时器推进后等 Promise 链结算）。 */
export async function settle(times = 3) {
  for (let index = 0; index < Math.max(1, times); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 预算计量器：时间/次数/字节三类预算，耗尽返回结构化证据而不是抛错。 */
export function createBudgetMeter({ maxMs = 0, maxChecks = 0, maxBytes = 0, clock = () => Date.now() } = {}) {
  const startedAt = clock();
  const used = { ms: 0, checks: 0, bytes: 0 };
  const limits = {
    ms: Math.max(0, Number(maxMs) || 0),
    checks: Math.max(0, Number(maxChecks) || 0),
    bytes: Math.max(0, Number(maxBytes) || 0),
  };
  const api = {
    limits,
    used,
    remaining(kind) {
      const limit = limits[kind];
      if (!limit) return Infinity;
      return Math.max(0, limit - used[kind]);
    },
    elapsedMs() {
      return Math.max(0, clock() - startedAt);
    },
    /** 记账；返回 {ok, exhausted, kind, used, limit}。 */
    consume(kind, amount = 1) {
      const name = ['ms', 'checks', 'bytes'].includes(kind) ? kind : 'checks';
      const value = Math.max(0, Number(amount) || 0);
      used[name] += value;
      if (name === 'ms') used.ms = Math.max(used.ms, api.elapsedMs());
      const limit = limits[name];
      const exhausted = limit > 0 && used[name] >= limit;
      return { ok: !exhausted, exhausted, kind: name, used: used[name], limit: limit || Infinity };
    },
    /** 时间预算的隐式消耗（每次检查前调用）。 */
    checkTime() {
      return api.consume('ms', Math.max(0, clock() - startedAt - used.ms));
    },
    exhausted() {
      return (limits.ms > 0 && api.elapsedMs() >= limits.ms)
        || (limits.checks > 0 && used.checks >= limits.checks)
        || (limits.bytes > 0 && used.bytes >= limits.bytes);
    },
    snapshot() {
      return { limits: { ...limits }, used: { ...used }, elapsedMs: api.elapsedMs(), exhausted: api.exhausted() };
    },
    /** 结构化耗尽证据（finding 的素材；detail 只放确定性字段，避免报告抖动）。 */
    exhaustion(detail) {
      const deterministic = {
        limits: { ...limits },
        used: { checks: used.checks, bytes: used.bytes },
        exhausted: api.exhausted(),
      };
      return {
        code: 'QUALITY_BUDGET_EXHAUSTED',
        category: 'budget',
        retry: 'after-action',
        nextAction: '提高预算或缩小 --gate 范围，确保所有 gate 都被真实执行',
        detail: detail || ('预算耗尽：' + JSON.stringify(deterministic)),
        evidence: deterministic,
      };
    },
  };
  return api;
}

/** 临时目录作用域：即使回调抛错也必须删除；返回是否清理干净。 */
export async function withTempDir(prefix, fn) {
  const base = path.join(os.tmpdir(), 'bb-quality-' + String(prefix || 'tmp') + '-');
  const dir = fs.mkdtempSync(base);
  const result = { dir, cleaned: false, value: undefined, error: null };
  try {
    result.value = await fn(dir);
    return result;
  } catch (error) {
    result.error = error;
    throw error;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      result.cleaned = true;
    } catch {
      result.cleaned = false;
    }
  }
}

/** 统计目录里的文件（用于"写路径重复执行后没有多出文件"检查）。 */
export function listTree(dir) {
  const out = [];
  const walk = (current, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const nextRel = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), nextRel);
      else out.push(nextRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * 取消对：返回 controller + 可等待的 aborted promise。
 * `cleanup()` 由调用方在 finally 里执行，保证监听器不残留。
 */
export function createAbortPair() {
  const controller = new AbortController();
  let listenerCount = 0;
  const waiters = [];
  const onAbort = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  const api = {
    controller,
    signal: controller.signal,
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
      return controller.signal.aborted;
    },
    /** 注册一次性等待（返回取消函数）。 */
    whenAborted() {
      if (controller.signal.aborted) return Promise.resolve();
      listenerCount += 1;
      return new Promise((resolve) => {
        waiters.push(resolve);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    listenerCount: () => listenerCount,
    cleanup() {
      listenerCount = 0;
      return controller.signal.aborted;
    },
  };
  return api;
}

/**
 * 可取消的 send：用于 executeHarReplayPlan 的中途取消。
 * 返回 {send, calls, cancel(), pending()}；cancel 后 send 返回 rejected Promise。
 */
export function createControllableSend({ plan, bodyOf, signal = null } = {}) {
  const calls = [];
  let cancelled = false;
  const api = {
    calls,
    get cancelled() {
      return cancelled;
    },
    cancel() {
      cancelled = true;
    },
    send: async (request) => {
      calls.push({ method: request.method, url: request.url });
      if (signal && signal.aborted) {
        const error = new Error('replay cancelled');
        error.code = 'E_CANCELLED';
        throw error;
      }
      if (cancelled) {
        const error = new Error('replay cancelled');
        error.code = 'E_CANCELLED';
        throw error;
      }
      // 模拟一次异步 IO：不读时钟，只让出事件循环，保证多 worker 并发时可被 abort 打断。
      await new Promise((resolve) => setImmediate(resolve));
      if (signal && signal.aborted) {
        const error = new Error('replay cancelled');
        error.code = 'E_CANCELLED';
        throw error;
      }
      const body = typeof bodyOf === 'function' ? bodyOf(request) : ('ok:' + request.method + ':' + request.url);
      return { status: 200, body };
    },
  };
  return api;
}

/** 让 send 在指定次数后抛错（注入 timeout）。 */
export function createFailingSend({ failAt = 1, code = 'E_TIMEOUT', message = 'injected timeout' } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    send: async () => {
      calls += 1;
      if (calls >= failAt) {
        const error = new Error(message);
        error.code = code;
        throw error;
      }
      return { status: 200, body: 'ok' };
    },
  };
}

/** 当前活跃句柄数量（信息性检查；失败不影响门禁判定）。 */
export function activeHandleCount() {
  if (typeof process._getActiveHandles !== 'function') return null;
  try {
    return process._getActiveHandles().length;
  } catch {
    return null;
  }
}

/** 结构化清理断言用的临时目录残留检查。 */
export function directoryExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
