// src/cdp/frames.ts —— frame 域对 CDP 的门面（懒 attach / 帧图缓存 / owner 投影 / 降级）。
//
// 上层（src/frames/service.ts）只依赖窄接口：
//   inspectFrames(tabId, urls)  → 每帧的 owner/几何（frames 列表用，一次 attach 批量算）
//   projectFramePoint(tabId, {url,x,y}) → 动作点投影（dispatchInFrame 用）
//   status(tabId)               → 诊断（是否挂上 / 子 session 数 / 缓存时间）
// 所有方法失败都返回 null（降级），绝不把 CDP 异常抛给业务层 —— OOPIF 投影是增强，
// 不是动作的前置条件（JS 兼容目标同样在 CDP 不可用时回退页面侧投影）。

import type { CdpPoint } from './frame-matrix.ts';
import type { ChromeDebuggerApi } from './types.ts';
import { CdpClient } from './client.ts';
import { errorMessage } from './errors.ts';
import type { CdpFrameGraph } from './frame-tree.ts';
import { readFrameGraph } from './frame-tree.ts';
import type { FrameOwnerGeometry, FrameOwnerProjection } from './frame-owner.ts';
import { frameOwnerGeometry, projectFrameOwnerPoint } from './frame-owner.ts';

export interface FrameCdpOptions {
  /** 显式注入 chrome.debugger（测试用假实现）；undefined = 惰性从 globalThis 解析；null = 禁用。 */
  api?: ChromeDebuggerApi | null;
  /** 复用外部 CdpClient（多域共享一个通道）；与 api 互斥，优先 client。 */
  client?: CdpClient | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 帧图缓存 TTL（默认 1000ms；0 = 不缓存）。 */
  graphTtlMs?: number;
  /** autoAttach 后等子 session 的静默窗口（默认 250ms）。 */
  settleMs?: number;
  /** 等子 session 的总超时（默认 3000ms）。 */
  sessionWaitMs?: number;
  /** 单条 CDP 命令超时（默认 5000ms）。 */
  timeoutMs?: number;
  /** 空闲软分离窗口（默认 75000ms）。 */
  idleDetachMs?: number;
}

export interface FrameCdpSnapshotOptions {
  fresh?: boolean;
  timeoutMs?: number;
  settleMs?: number;
  sessionWaitMs?: number;
}

export interface FrameCdpPointOptions {
  url: string;
  x?: number;
  y?: number;
  timeoutMs?: number;
}

export interface FrameCdpStatus {
  available: boolean;
  attached: boolean;
  sessions: number;
  cdpFrames: number;
  graphAt: number | null;
  error: string | null;
}

const DEFAULT_GRAPH_TTL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export class FrameCdpService {
  private readonly client: CdpClient | null;
  private readonly now: () => number;
  private readonly graphTtlMs: number;
  private readonly settleMs: number;
  private readonly sessionWaitMs: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<number, { graph: CdpFrameGraph; at: number }>();
  private readonly lastError = new Map<number, string>();
  private leaseCounter = 0;
  private disposed = false;

  constructor(options: FrameCdpOptions = {}) {
    this.now = options.now ?? Date.now;
    this.graphTtlMs = clamp(options.graphTtlMs, 0, 60_000, DEFAULT_GRAPH_TTL_MS);
    this.settleMs = clamp(options.settleMs, 0, 5_000, 250);
    this.sessionWaitMs = clamp(options.sessionWaitMs, this.settleMs, 30_000, 3_000);
    this.timeoutMs = clamp(options.timeoutMs, 1, 120_000, DEFAULT_TIMEOUT_MS);
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      this.client = new CdpClient({
        api: options.api,
        ...(options.now ? { now: options.now } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        defaultTimeoutMs: this.timeoutMs,
        attachTimeoutMs: this.timeoutMs,
        ...(options.idleDetachMs !== undefined ? { idleDetachMs: options.idleDetachMs } : {}),
      });
    }
  }

  /** chrome.debugger 是否可用（不 attach）。 */
  available(): boolean {
    return !this.disposed && (this.client?.available() ?? false);
  }

  /** 诊断状态（frames 结果的 cdp 摘要字段用）。 */
  status(tabId: number): FrameCdpStatus {
    const id = Number(tabId);
    const cached = this.cache.get(id);
    return {
      available: this.available(),
      attached: this.client?.isAttached(id) ?? false,
      sessions: this.client?.sessions(id).length ?? 0,
      cdpFrames: cached ? cached.graph.frames.length : 0,
      graphAt: cached ? cached.at : null,
      error: this.lastError.get(id) ?? null,
    };
  }

  /** 取帧图：优先 TTL 内缓存；fresh=true 强制重读。失败返回 null（降级）。 */
  async snapshot(tabId: number, options: FrameCdpSnapshotOptions = {}): Promise<CdpFrameGraph | null> {
    const client = this.client;
    if (!client || this.disposed) return null;
    const id = Number(tabId);
    if (!Number.isInteger(id) || id < 0) return null;
    if (options.fresh !== true) {
      const cached = this.cache.get(id);
      if (cached && this.now() - cached.at <= this.graphTtlMs) return cached.graph;
    }
    const token = this.nextLease();
    try {
      await client.acquire(id, token);
      const graph = await readFrameGraph(client, id, {
        timeoutMs: clamp(options.timeoutMs, 1, 120_000, this.timeoutMs),
        settleMs: clamp(options.settleMs, 0, 5_000, this.settleMs),
        sessionWaitMs: clamp(options.sessionWaitMs, 0, 30_000, this.sessionWaitMs),
        now: this.now,
      });
      this.cache.set(id, { graph, at: this.now() });
      this.lastError.delete(id);
      return graph;
    } catch (error) {
      this.lastError.set(id, errorMessage(error));
      this.cache.delete(id);
      return null;
    } finally {
      client.release(id, token);
    }
  }

  /** 用已有帧图算某帧的 owner 投影（动作点）。失败返回 null。 */
  async projectInGraph(
    graph: CdpFrameGraph,
    options: { url: string; point?: CdpPoint; timeoutMs?: number },
  ): Promise<FrameOwnerProjection | null> {
    const client = this.client;
    if (!client || this.disposed || !options.url) return null;
    try {
      return await projectFrameOwnerPoint(client, graph, {
        url: options.url,
        ...(options.point ? { point: options.point } : {}),
        timeoutMs: clamp(options.timeoutMs, 1, 120_000, this.timeoutMs),
      });
    } catch {
      return null;
    }
  }

  /** 动作点投影：内部 snapshot（可命中 1s 缓存）→ owner 链。失败返回 null。 */
  async projectFramePoint(tabId: number, options: FrameCdpPointOptions): Promise<FrameOwnerProjection | null> {
    if (!this.client || this.disposed || !options.url) return null;
    const graph = await this.snapshot(tabId);
    if (!graph) return null;
    const point = { x: Number(options.x ?? 0), y: Number(options.y ?? 0) };
    return this.projectInGraph(graph, {
      url: options.url,
      point: { x: Number.isFinite(point.x) ? point.x : 0, y: Number.isFinite(point.y) ? point.y : 0 },
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /** 批量 owner 几何（frames 列表用）：一次 fresh 帧图 + 每帧 owner 链；失败位置为 null。 */
  async inspectFrames(
    tabId: number,
    urls: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<Array<FrameOwnerGeometry | null>> {
    const client = this.client;
    if (!client || this.disposed) return urls.map(() => null);
    const graph = await this.snapshot(tabId, {
      fresh: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (!graph) return urls.map(() => null);
    const timeoutMs = clamp(options.timeoutMs, 1, 120_000, this.timeoutMs);
    const result: Array<FrameOwnerGeometry | null> = [];
    for (const url of urls) {
      if (typeof url !== 'string' || !url) {
        result.push(null);
        continue;
      }
      try {
        result.push(await frameOwnerGeometry(client, graph, url, timeoutMs));
      } catch {
        result.push(null);
      }
    }
    return result;
  }

  /** tab 关闭清理（缓存 + 会话 + 事件监听）。 */
  forgetTab(tabId: number): void {
    const id = Number(tabId);
    this.cache.delete(id);
    this.lastError.delete(id);
    void this.client?.forgetTab(id).catch(() => {});
  }

  /** 释放本服务（background 卸载/测试收尾）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cache.clear();
    this.lastError.clear();
    void this.client?.dispose().catch(() => {});
  }

  private nextLease(): string {
    this.leaseCounter += 1;
    return 'frame-cdp-' + String(this.leaseCounter);
  }
}

/** 默认门面（惰性解析 chrome.debugger；Node 单测里自动降级为不可用）。 */
export function createFrameCdpService(options: FrameCdpOptions = {}): FrameCdpService {
  return new FrameCdpService(options);
}
