// tests/support/stub-content.ts —— 假内容脚本传输（ActionRegistry 单测用）。
//
// 不 mock ActionRegistry 本身：只替换最外层 tabs.sendMessage 那一跳，
// 断言注册表确实按 op 组装了命令、把 refKey/documentId 传给了页面、
// 并且把页面回包原样映射成业务错误码。

import type { ActionContentTransport } from '../../src/actions/registry.ts';
import type { ContentReply, ContentRequest } from '../../src/content/protocol.ts';

export interface StubContentCall {
  tabId: number;
  request: ContentRequest;
  timeoutMs: number | undefined;
}

export type StubContentHandler = (request: ContentRequest, tabId: number) => ContentReply | Promise<ContentReply>;

export class StubContentTransport implements ActionContentTransport {
  readonly calls: StubContentCall[] = [];
  private readonly handlers = new Map<string, StubContentHandler>();
  /** 未注册 op 时的兜底（默认 E_UNKNOWN_OP）。 */
  fallback: StubContentHandler | null = null;

  set(op: string, handler: StubContentHandler): this {
    this.handlers.set(op, handler);
    return this;
  }

  lastCall(): StubContentCall | null {
    return this.calls[callsLength(this.calls) - 1] ?? null;
  }

  callsFor(op: string): StubContentCall[] {
    return this.calls.filter((call) => call.request.op === op);
  }

  async request(
    tabId: number,
    request: ContentRequest,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ContentReply> {
    this.calls.push({ tabId, request, timeoutMs: options.timeoutMs });
    const handler = this.handlers.get(request.op) ?? this.fallback;
    if (!handler) {
      return { ok: false, code: 'E_UNKNOWN_OP', message: 'stub 未注册 op：' + request.op };
    }
    return handler(request, tabId);
  }
}

function callsLength(calls: readonly unknown[]): number {
  return calls.length;
}
