// src/content/transport.ts —— background → 内容脚本的传输层（tabs.sendMessage 封装）。
//
// 只做三件事：
// 1) 把内容脚本回包规范化成 ContentReply（畸形回包 → E_BAD_RESPONSE）；
// 2) 传输失败分类：目标 tab 没有内容脚本/已关闭 → E_NO_CONTENT（可注入重试/提示
//    “页面未注入扩展脚本”），其它异常 → E_CONTENT_ERROR，两者都带 retryable 语义；
// 3) 超时/取消与调用方 signal 分开映射（E_TIMEOUT / E_CANCELLED），不让
//    “接收方不存在” 被浏览器错误文案糊住。
//
// 注入 api 而不是直接用 browser：单测可以用假 API 精确构造错误分支；
// 生产入口把 WXT 的 browser.tabs 传进来。

import { normalizeContentReply, type ContentReply, type ContentRequest } from './protocol.ts';

/** 只依赖 tabs.sendMessage 的最小 API 形状（第三个参数 frameId 用于锁定主文档）。 */
export interface ContentTabsApi {
  tabs: {
    sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown> | unknown;
  };
}

export interface ContentTransportOptions {
  timeoutMs?: number;
  /** 测试注入：setTimeout/clearTimeout。 */
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const DEFAULT_CONTENT_TIMEOUT_MS = 10_000;

/** 主文档 frameId（Chrome 约定）。 */
export const MAIN_FRAME_ID = 0;

/** 没有接收方时的浏览器错误特征（Chrome/Edge/Firefox 文案不同，全部覆盖）。 */
const NO_RECEIVER_PATTERN = /Could not establish connection|Receiving end does not exist|message port closed|The message port closed|No tab with id|Invalid tab ID|Cannot access contents of/i;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const bag = error as { message?: unknown } | null;
  if (bag && typeof bag.message === 'string') return bag.message;
  return String(error);
}

function failure(code: string, message: string, data?: unknown): ContentReply {
  return data === undefined ? { ok: false, code, message } : { ok: false, code, message, data };
}

/**
 * tabs.sendMessage 传输实现。
 *
 * ```ts
 * const transport = new ContentScriptTransport(browser);
 * const reply = await transport.request(7, makeContentRequest('observe', {}));
 * ```
 */
export class ContentScriptTransport {
  private readonly api: ContentTabsApi;
  private readonly timeoutMs: number;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(api: ContentTabsApi, options: ContentTransportOptions = {}) {
    if (!api || !api.tabs || typeof api.tabs.sendMessage !== 'function') {
      throw new TypeError('ContentScriptTransport 需要 tabs.sendMessage');
    }
    this.api = api;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Math.floor(Number(options.timeoutMs)) : DEFAULT_CONTENT_TIMEOUT_MS;
    this.setTimer = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async request(
    tabId: number,
    request: ContentRequest,
    options: { timeoutMs?: number; signal?: AbortSignal; frameId?: number } = {},
  ): Promise<ContentReply> {
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return failure('E_BAD_ARG', '内容脚本传输需要正整数 tabId', { tabId });
    }
    if (options.signal?.aborted) return failure('E_CANCELLED', '内容脚本调用已取消');
    const timeoutMs = Number(options.timeoutMs) > 0 ? Math.floor(Number(options.timeoutMs)) : this.timeoutMs;
    let settled = false;
    let timer: unknown = null;
    let onAbort: (() => void) | null = null;
    // 目标帧：缺省 0（主文档）；跨 frame 观察/动作显式指定 frameId，并在 params 里带上
    // targetFrameId，内容脚本侧据此确认“这条消息确实是发给本帧的”。
    const frameId = Number.isInteger(options.frameId) ? Number(options.frameId) : MAIN_FRAME_ID;
    const message: ContentRequest = frameId === MAIN_FRAME_ID && request.params?.targetFrameId === undefined
      ? request
      : { ...request, params: { ...request.params, targetFrameId: frameId } };
    const send = (async (): Promise<ContentReply> => {
      try {
        // 显式 frameId：不指定时 Chrome 会把消息发给**所有帧**，页面里的 iframe
        // 会先回包（实测 E2E 14/23 系列因此把 iframe 当成当前页面）。
        const raw = await this.api.tabs.sendMessage(tabId, message, { frameId });
        return normalizeContentReply(raw);
      } catch (error) {
        const messageText = messageOf(error);
        if (NO_RECEIVER_PATTERN.test(messageText)) {
          return failure('E_NO_CONTENT', 'tab ' + String(tabId) + ' 的 frame ' + String(frameId) + ' 没有内容脚本接收动作：' + messageText, {
            tabId,
            frameId,
            retryable: true,
          });
        }
        return failure('E_CONTENT_ERROR', '内容脚本调用失败：' + messageText, { tabId, frameId, reason: messageText });
      }
    })();

    const timed = new Promise<ContentReply>((resolve) => {
      timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        resolve(failure('E_TIMEOUT', '内容脚本动作超时（' + String(timeoutMs) + 'ms）', { tabId, timeoutMs, retryable: true }));
      }, timeoutMs);
      if (options.signal) {
        onAbort = () => {
          if (settled) return;
          settled = true;
          resolve(failure('E_CANCELLED', '内容脚本调用已取消', { tabId }));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    try {
      const reply = await Promise.race([send, timed]);
      if (!settled) {
        settled = true;
        if (timer !== null) this.clearTimer(timer);
        if (options.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
      }
      return reply;
    } finally {
      if (timer !== null) this.clearTimer(timer);
      if (options.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
    }
  }
}

/** 便捷工厂。 */
export function createContentTransport(api: ContentTabsApi, options: ContentTransportOptions = {}): ContentScriptTransport {
  return new ContentScriptTransport(api, options);
}
