// src/video/runtime.ts —— background 侧运行时适配：离屏文档端口 / chrome.storage 适配 / 存储能力探测。
//
// 全部通过注入的 chrome 命名空间结构类型工作（本工程未装 @types/chrome）：
// background 把 `browser.runtime` / `browser.offscreen` / `browser.storage.local` 传进来，
// 这里只做「最小接口 + 重试 + 错误归一」，不直接引用全局，Node 单测可整体绕过。

import type { StorageBackend, StorageState } from './types.ts';
import { OFFSCREEN_MESSAGES, OFFSCREEN_SOURCE, OFFSCREEN_TARGET } from './offscreen-protocol.ts';

export interface RuntimeMessageListener {
  (message: unknown, sender?: unknown, sendResponse?: (reply?: unknown) => void): boolean | void;
}

export interface RuntimeApiLike {
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  onMessage?: {
    addListener(listener: RuntimeMessageListener): void;
    removeListener?(listener: RuntimeMessageListener): void;
  };
}

export interface OffscreenApiLike {
  hasDocument?(): Promise<boolean>;
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument?(): Promise<void>;
}

export interface OffscreenPort {
  ensure(): Promise<void>;
  close(): Promise<void>;
  post<T = Record<string, unknown>>(message: Record<string, unknown>, options?: { retries?: number; intervalMs?: number }): Promise<T | null>;
  onMessage(handler: (message: Record<string, unknown>) => void): () => void;
  readonly documentAvailable: boolean;
}

interface PortOptions {
  runtime: RuntimeApiLike;
  offscreen: OffscreenApiLike;
  /** 离屏文档 URL（默认 runtime.getURL('offscreen.html')）。 */
  url?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, Math.max(0, ms)); });
}

/**
 * 建离屏端口：
 * - ensure()：没有文档则 createDocument（USER_MEDIA 理由）→ ping 重试到脚本就绪；
 * - post()：sendMessage 失败/无接收方时按 retries 重试，最终返回 null（调用方决定降级）；
 * - onMessage()：只把 `from:'offscreen'` 的 bb.rec.* 消息交给 handler（不与非视频消息抢通道）。
 */
export function createOffscreenPort(options: PortOptions): OffscreenPort {
  const sleep = options.sleep ?? defaultSleep;
  const url = options.url ?? options.runtime.getURL('offscreen.html');
  let available = false;
  let ensuring: Promise<void> | null = null;

  async function hasDocument(): Promise<boolean> {
    if (!options.offscreen.hasDocument) return available;
    try {
      return await options.offscreen.hasDocument();
    } catch {
      return available;
    }
  }

  async function post<T>(message: Record<string, unknown>, postOptions: { retries?: number; intervalMs?: number } = {}): Promise<T | null> {
    const retries = Math.max(1, Number(postOptions.retries) || 1);
    const intervalMs = Number.isFinite(Number(postOptions.intervalMs)) ? Number(postOptions.intervalMs) : 100;
    const payload = { ...message, target: OFFSCREEN_TARGET };
    let lastError: unknown = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const reply = await options.runtime.sendMessage(payload);
        if (reply !== undefined && reply !== null) {
          available = true;
          return reply as T;
        }
        lastError = new Error('离屏文档没有回包');
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < retries) await sleep(intervalMs);
    }
    options.log?.('离屏消息失败：' + String((lastError as { message?: string } | null)?.message ?? lastError));
    return null;
  }

  async function createDocument(): Promise<void> {
    try {
      await options.offscreen.createDocument({
        url,
        reasons: ['USER_MEDIA'],
        justification: '录制标签页视频（tabCapture / 逐帧编码）',
      });
      available = true;
    } catch (error) {
      const message = String((error as { message?: string } | null)?.message ?? error);
      // 已存在文档（并发 ensure / 浏览器不实现 hasDocument）时视为成功。
      if (!/single offscreen|already|仅能|已有/i.test(message)) {
        available = false;
        throw error;
      }
      available = true;
    }
  }

  return {
    get documentAvailable() { return available; },
    async ensure() {
      if (ensuring) return ensuring;
      ensuring = (async () => {
        if (!(await hasDocument())) await createDocument();
        // 文档脚本加载完成前 sendMessage 会失败：用 ping 握手（最多约 3s）。
        const pong = await post({ type: OFFSCREEN_MESSAGES.PING }, { retries: 20, intervalMs: 150 });
        if (!pong) throw new Error('离屏文档未就绪（offscreen.html 未加载或脚本报错）');
      })().finally(() => { ensuring = null; });
      return ensuring;
    },
    async close() {
      available = false;
      if (!options.offscreen.closeDocument) return;
      try {
        if (await hasDocument()) await options.offscreen.closeDocument();
      } catch {
        // 已经关闭/没有文档：忽略
      }
    },
    post,
    onMessage(handler) {
      const onMessage = options.runtime.onMessage;
      if (!onMessage || typeof onMessage.addListener !== 'function') return () => {};
      const listener: RuntimeMessageListener = (message) => {
        const bag = message && typeof message === 'object' ? message as Record<string, unknown> : null;
        if (!bag || bag.from !== OFFSCREEN_SOURCE || typeof bag.type !== 'string' || !bag.type.startsWith('bb.rec.')) return false;
        try {
          handler(bag);
        } catch (error) {
          options.log?.('离屏消息处理异常：' + String((error as { message?: string } | null)?.message ?? error));
        }
        return false;
      };
      onMessage.addListener(listener);
      return () => { try { onMessage.removeListener?.(listener); } catch { /* 忽略 */ } };
    },
  };
}

// ---------------------------------------------------------------------------
// chrome.storage.local 适配（只用来存活动态/状态机快照这类小 JSON，不存视频字节）
// ---------------------------------------------------------------------------

export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface VideoStorage {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createStorageAdapter(area: StorageAreaLike): VideoStorage {
  return {
    async getJson<T>(key: string): Promise<T | null> {
      try {
        const bag = await area.get(key);
        const value = bag ? bag[key] : undefined;
        return value === undefined ? null : value as T;
      } catch {
        return null;
      }
    },
    async setJson(key, value) {
      try {
        await area.set({ [key]: value });
      } catch {
        // 活动态持久化失败不阻断录制（SW 重启后证据会缺一段）
      }
    },
    async remove(key) {
      try {
        await area.remove(key);
      } catch {
        // 同上
      }
    },
  };
}

export interface NavigatorStorageLike {
  persist?(): Promise<boolean>;
  estimate?(): Promise<{ quota?: number; usage?: number }>;
}

/** 探测 navigator.storage（离屏/页面/worker 都有）；失败如实降级 persisted=false。 */
export async function probeBrowserStorage(backend: StorageBackend, scope?: NavigatorStorageLike): Promise<StorageState> {
  const storage = scope ?? (globalThis as unknown as { navigator?: { storage?: NavigatorStorageLike } }).navigator?.storage;
  const state: StorageState = { backend, persisted: false, quota: null, usage: null };
  if (!storage) return state;
  try {
    if (typeof storage.persist === 'function') state.persisted = (await storage.persist().catch(() => false)) === true;
  } catch {
    state.persisted = false;
  }
  try {
    if (typeof storage.estimate === 'function') {
      const estimate = await storage.estimate().catch(() => null);
      if (estimate && Number.isFinite(Number(estimate.quota))) state.quota = Number(estimate.quota);
      if (estimate && Number.isFinite(Number(estimate.usage))) state.usage = Number(estimate.usage);
    }
  } catch {
    // 估计值拿不到就留 null（不伪造容量）
  }
  return state;
}
