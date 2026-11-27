// src/ui/client.ts —— 子页面侧的 `bb.ui` 调用封装（页面只依赖这个文件与 page.ts）。
//
// 页面运行在扩展自己的 origin 上，`chrome.runtime.sendMessage` 由扩展页面直接可用；
// 但页面**不应**自己拼 fetch/WS，也不应直接调 daemon：所有业务动作都经 background 的
// `bb.ui` 处理器（可审计、可限流、可单测）。

import type { UiReply } from './messages.ts';

export type UiResult<T extends object = Record<string, unknown>> = T & { ok: true };

/** 发送一个 bb.ui 请求；网络/通道错误也归一成结构化失败，不抛异常。 */
export async function sendUi<T extends object = Record<string, unknown>>(
  op: string,
  params: Record<string, unknown> = {},
): Promise<UiReply & { result?: T }> {
  try {
    const runtime = (globalThis as unknown as {
      chrome?: { runtime?: { sendMessage(message: unknown): Promise<unknown> } };
    }).chrome?.runtime;
    if (!runtime || typeof runtime.sendMessage !== 'function') {
      return { ok: false, code: 'E_NO_RUNTIME', message: '当前页面拿不到扩运行时通道（chrome.runtime 不可用）' };
    }
    const reply = await runtime.sendMessage({ type: 'bb.ui', op, params });
    if (!reply || typeof reply !== 'object') {
      return { ok: false, code: 'E_BAD_RESPONSE', message: '后台没有回包（service worker 可能已退出）' };
    }
    const bag = reply as { ok?: unknown; result?: unknown; code?: unknown; message?: unknown; data?: unknown };
    if (bag.ok === true) return { ok: true, result: (bag.result ?? {}) as T };
    return {
      ok: false,
      code: typeof bag.code === 'string' ? bag.code : 'E_UI_FAILED',
      message: typeof bag.message === 'string' ? bag.message : '后台返回失败',
      ...(bag.data !== undefined ? { data: bag.data } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      code: 'E_NO_RUNTIME',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 与 sendUi 相同，但失败时抛出带 code 的错误（页面自测用：失败要变成 fail 标题）。 */
export async function requireUi<T extends object = Record<string, unknown>>(
  op: string,
  params: Record<string, unknown> = {},
): Promise<UiResult<T>> {
  const reply = await sendUi<T>(op, params);
  if (reply.ok !== true) {
    const failure = reply as { code?: string; message?: string; data?: unknown };
    const error = new Error(failure.message || failure.code || 'bb.ui 调用失败');
    (error as Error & { code?: string }).code = failure.code;
    (error as Error & { data?: unknown }).data = failure.data;
    throw error;
  }
  return { ...(reply.result ?? {}), ok: true } as UiResult<T>;
}

/** 失败信封 → 一行可读文本（页面状态栏用）。 */
export function describeFailure(reply: { code?: string; message?: string; data?: unknown }): string {
  const code = reply.code ? reply.code + ': ' : '';
  const data = reply.data === undefined ? '' : '（' + JSON.stringify(reply.data).slice(0, 300) + '）';
  return code + (reply.message || '失败') + data;
}
