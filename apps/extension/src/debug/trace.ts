// src/debug/trace.ts —— CDP Performance tracing：trace start/stop/status + Trace JSON 汇总（20u2）。
//
// 数据面：Tracing.start(transferMode=ReportEvents) → Tracing.dataCollected 累积 → Tracing.end 后
// 等 tracingComplete（最多 stopTimeoutMs）→ 返回 traceEvents（可被 CLI 写成 .json）。
//
// 为什么不用 ReturnAsStream：ReportEvents 无需 IO.read 流式读，扩展 SW 里实现更简单；
// 事件体积由 maxEvents 上限保护（超出截断并在 summary.truncated 标注，不谎报完整）。

import type { CdpChannel } from './cdp-channel.ts';
import { finiteNumber } from './cdp-channel.ts';

export interface TraceServiceOptions {
  client: CdpChannel;
  now?: () => number;
  /** 默认 trace 分类。 */
  defaultCategories?: string;
  /** 停止时等待 tracingComplete 的上限（默认 10s）。 */
  stopTimeoutMs?: number;
  /** 单次采集事件上限（默认 200000，防止 SW 内存被拖垮）。 */
  maxEvents?: number;
}

export interface TraceSummary {
  events: number;
  categories: Array<{ category: string; count: number }>;
  topNames: Array<{ name: string; count: number }>;
  spanMs: number | null;
  truncated: boolean;
}

export const DEFAULT_TRACE_CATEGORIES = 'devtools.timeline,v8.execute,blink.user_timing';

interface TraceTabState {
  tabId: number;
  categories: string;
  startedAt: number;
  events: Array<Record<string, unknown>>;
  truncated: boolean;
  offs: Array<() => void>;
  settle: (() => void) | null;
  complete: Promise<void>;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

/** 汇总 trace 事件（纯函数；单测直接覆盖）。 */
export function summarizeTraceEvents(events: unknown[], options: { truncated?: boolean } = {}): TraceSummary {
  const categories = new Map<string, number>();
  const names = new Map<string, number>();
  let minTs = Infinity;
  let maxTs = -Infinity;
  let count = 0;
  for (const raw of Array.isArray(events) ? events : []) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    count += 1;
    const category = String(event['cat'] ?? '');
    const name = String(event['name'] ?? '');
    categories.set(category, (categories.get(category) ?? 0) + 1);
    names.set(name, (names.get(name) ?? 0) + 1);
    const ts = Number(event['ts']);
    if (Number.isFinite(ts)) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
  }
  const span = Number.isFinite(minTs) && maxTs >= minTs ? Math.round((maxTs - minTs) / 1000) : null;
  return {
    events: count,
    categories: [...categories.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([category, value]) => ({ category, count: value })),
    topNames: [...names.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, value]) => ({ name, count: value })),
    // 不同 clock domain 的事件可能混入超大 ts；超过 1h 视为不可信（与 JS 兼容目标同口径）。
    spanMs: span !== null && span >= 0 && span < 3_600_000 ? span : null,
    truncated: options.truncated === true,
  };
}

/**
 * Tracing 服务（一个实例管所有 tab）。
 *
 * ```ts
 * const trace = new TraceService({ client });
 * await trace.start(tabId);
 * const stopped = await trace.stop(tabId); // stopped.trace = JSON.stringify({ traceEvents })
 * ```
 */
export class TraceService {
  private readonly client: CdpChannel;
  private readonly now: () => number;
  private readonly defaultCategories: string;
  private readonly stopTimeoutMs: number;
  private readonly maxEvents: number;
  private readonly states = new Map<number, TraceTabState>();
  private disposed = false;

  constructor(options: TraceServiceOptions) {
    if (!options || !options.client) throw new TypeError('TraceService 需要 CdpChannel');
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.defaultCategories = String(options.defaultCategories || DEFAULT_TRACE_CATEGORIES);
    this.stopTimeoutMs = finiteNumber(options.stopTimeoutMs, 10_000) > 0 ? Math.floor(finiteNumber(options.stopTimeoutMs, 10_000)) : 10_000;
    this.maxEvents = finiteNumber(options.maxEvents, 200_000) > 0 ? Math.floor(finiteNumber(options.maxEvents, 200_000)) : 200_000;
  }

  isTracing(tabId: number): boolean {
    return this.states.has(Number(tabId));
  }

  tracingTabs(): number[] {
    return [...this.states.keys()];
  }

  /** trace.start：开始 tracing（同一 tab 重复 start 明确报错，与 JS 参考一致）。 */
  async start(tabId: number, options: { categories?: string } = {}): Promise<Record<string, unknown>> {
    this.assertUsable();
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('trace 需要正整数 tabId'), { code: 'E_BAD_ARG' });
    if (this.states.has(id)) throw Object.assign(new Error('该标签页已在 tracing'), { code: 'E_BAD_ARG' });
    const categories = String(options.categories || this.defaultCategories);
    await this.client.acquire(id, 'trace');
    const state: TraceTabState = {
      tabId: id,
      categories,
      startedAt: this.now(),
      events: [],
      truncated: false,
      offs: [],
      settle: null,
      complete: Promise.resolve(),
    };
    state.complete = new Promise<void>((resolve) => {
      state.settle = resolve;
    });
    const offCollected = this.client.onEvent(id, 'Tracing.dataCollected', (params) => {
      const value = params['value'];
      if (!Array.isArray(value)) return;
      for (const event of value) {
        if (state.events.length >= this.maxEvents) {
          state.truncated = true;
          break;
        }
        if (event && typeof event === 'object') state.events.push(event as Record<string, unknown>);
      }
    });
    const offComplete = this.client.onEvent(id, 'Tracing.tracingComplete', () => {
      const settle = state.settle;
      state.settle = null;
      settle?.();
    });
    state.offs.push(offCollected, offComplete);
    try {
      await this.client.send(id, 'Tracing.start', {
        categories,
        options: 'sampling-frequency=1000',
        transferMode: 'ReportEvents',
      });
    } catch (error) {
      for (const off of state.offs) {
        try {
          off();
        } catch {
          // 忽略
        }
      }
      this.client.release(id, 'trace');
      throw error;
    }
    this.states.set(id, state);
    return { ok: true, tabId: id, categories, startedAt: state.startedAt, tracing: true, mode: 'cdp-tracing' };
  }

  /** trace.stop：停止并返回 Trace JSON 字符串 + summary。 */
  async stop(tabId: number): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    const state = this.states.get(id);
    if (!state) throw Object.assign(new Error('该标签页没有进行中的 tracing'), { code: 'E_BAD_ARG' });
    this.states.delete(id);
    try {
      await this.client.send(id, 'Tracing.end', {}).catch(() => undefined);
      await this.waitComplete(state);
    } finally {
      for (const off of state.offs) {
        try {
          off();
        } catch {
          // 忽略
        }
      }
      state.offs = [];
      this.client.release(id, 'trace');
    }
    const summary = summarizeTraceEvents(state.events, { truncated: state.truncated });
    return {
      ok: true,
      tabId: id,
      categories: state.categories,
      startedAt: state.startedAt,
      durationMs: Math.max(0, this.now() - state.startedAt),
      events: state.events.length,
      summary,
      trace: state.events.length ? JSON.stringify({ traceEvents: state.events }) : '',
      mode: 'cdp-tracing',
    };
  }

  /** trace.status。 */
  status(tabId: number): Record<string, unknown> {
    const id = Number(tabId);
    const state = this.states.get(id);
    return {
      ok: true,
      tabId: id,
      tracing: Boolean(state),
      events: state ? state.events.length : 0,
      categories: state ? state.categories : null,
      startedAt: state ? state.startedAt : null,
      mode: 'cdp-tracing',
    };
  }

  /** tab 关闭/会话回收：丢弃进行中的 tracing（不再回调 Tracing.end）。 */
  async forgetTab(tabId: number): Promise<void> {
    const id = Number(tabId);
    const state = this.states.get(id);
    if (!state) return;
    this.states.delete(id);
    for (const off of state.offs) {
      try {
        off();
      } catch {
        // 忽略
      }
    }
    state.offs = [];
    await this.client.send(id, 'Tracing.end', {}).catch(() => undefined);
    this.client.release(id, 'trace');
  }

  /** 释放全部资源。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(this.tracingTabs().map((id) => this.forgetTab(id).catch(() => undefined)));
    this.states.clear();
  }

  private waitComplete(state: TraceTabState): Promise<void> {
    if (!state.settle) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        state.settle = null;
        resolve();
      }, this.stopTimeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      state.complete.then(() => {
        clearTimeout(timer);
        resolve();
      }).catch(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('TraceService 已释放');
  }
}

/** 便捷工厂。 */
export function createTraceService(options: TraceServiceOptions): TraceService {
  return new TraceService(options);
}

/** 诊断文本（错误归一用；保持与其它模块一致的错误文案）。 */
export function traceErrorText(error: unknown): string {
  return errorText(error);
}
