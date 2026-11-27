// src/record/messages.ts —— record.* 的消息面（background 路由 + 子页面/内容脚本客户端）。
//
// 为什么独立于 `bb.ui`：`bb.ui` 的 op 白名单在 src/ui/messages.ts 里硬校验，record 是
// background 自己的服务（不经过 daemon），因此用独立的 `bb.record.*` 消息类型：
//
//   页面/内容脚本 → background：
//     {type:'bb.record.start'|'stop'|'list'|'export'|'status'|'remove', params}
//     {type:'bb.record.event', event}     内容脚本上报页面事件（sender 带 tab/frame/documentId）
//     {type:'bb.record.finish'}           录制浮层“结束”按钮
//
// background 侧只加一个分支：
//   const handled = recordMessages.handle(raw, sender);
//   if (handled) { void handled.then(sendResponse); return true; }
//
// 权限边界：页面 op 只接受**本扩展上下文**（sender.id / chrome-extension:// URL）；
// 事件上报只接受内容脚本（sender.tab.id），页面不能伪造别人的 tab id。

import type { RecordService } from './service.ts';
import { RecordServiceError } from './service.ts';

/** 页面可调用的 op。 */
export const RECORD_PAGE_OPS = Object.freeze(['start', 'stop', 'list', 'export', 'status', 'remove'] as const);

export type RecordPageOp = (typeof RECORD_PAGE_OPS)[number];

export type RecordPageMessageType = `bb.record.${RecordPageOp}`;

export type RecordRuntimeMessageType = RecordPageMessageType | 'bb.record.event' | 'bb.record.finish';

const PAGE_OP_SET: ReadonlySet<string> = new Set<string>(RECORD_PAGE_OPS);

export interface ParsedRecordMessage {
  type: RecordRuntimeMessageType;
  /** 页面 op（`bb.record.event`/`finish` 为 null）。 */
  op: RecordPageOp | null;
  params: Record<string, unknown>;
  event?: unknown;
}

export type RecordReply =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string; data?: unknown };

export type RecordParseFailure = Extract<RecordReply, { ok: false }>;

export interface RecordMessageSender {
  id?: string;
  url?: string;
  tab?: { id?: number; windowId?: number; url?: string };
  frameId?: number;
  documentId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function failure(code: string, message: string, data?: unknown): RecordParseFailure {
  return data === undefined ? { ok: false, code, message } : { ok: false, code, message, data };
}

/**
 * 解析 `bb.record.*` 消息。
 * 返回 null 表示不是 record 消息（交给其它处理器）；非法形状返回结构化失败。
 */
export function parseRecordMessage(raw: unknown): ParsedRecordMessage | RecordParseFailure | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  const type = raw.type;
  if (!type.startsWith('bb.record.')) return null;
  if (type === 'bb.record.event') {
    if (!isRecord(raw.event)) return failure('E_BAD_ARG', 'bb.record.event 缺少 event 对象');
    return { type, op: null, params: {}, event: raw.event };
  }
  if (type === 'bb.record.finish') return { type, op: null, params: {} };
  const op = type.slice('bb.record.'.length);
  if (!PAGE_OP_SET.has(op)) {
    return failure('E_BAD_ARG', '未知的 record 消息：' + type, { allowlist: [...RECORD_PAGE_OPS] });
  }
  const params = raw.params;
  if (params !== undefined && params !== null && !isRecord(params)) {
    return failure('E_BAD_ARG', 'bb.record.* 的 params 必须是对象');
  }
  return { type: type as RecordPageMessageType, op: op as RecordPageOp, params: isRecord(params) ? params : {} };
}

export interface RecordMessageHandlerOptions {
  /** 本扩展的 origin（`chrome.runtime.getURL('')`，如 chrome-extension://<id>/）。 */
  extensionOrigin?: string;
  /** 本扩展 id（sender.id 校验；缺省时退化为 URL 前缀判定）。 */
  extensionId?: string;
  /** 单测/嵌入场景可关闭扩展上下文校验（默认开启）。 */
  requireExtensionSender?: boolean;
}

/**
 * background 侧消息处理器：`handle()` 返回 null 表示“不是 record 消息”。
 * 与 UiMessageHandler 同约定：永不抛异常，一律回结构化信封。
 */
export class RecordMessageHandler {
  private readonly service: RecordService;
  private readonly options: RecordMessageHandlerOptions;

  constructor(service: RecordService, options: RecordMessageHandlerOptions = {}) {
    this.service = service;
    this.options = options;
  }

  private isExtensionSender(sender: RecordMessageSender | null | undefined): boolean {
    if (this.options.requireExtensionSender === false) return true;
    if (!sender) return false;
    const url = typeof sender.url === 'string' ? sender.url : '';
    const origin = this.options.extensionOrigin;
    if (origin && url.startsWith(origin)) return true;
    if (/^(chrome|moz|ms-browser)-extension:\/\//i.test(url)) return true;
    // 扩展页面/弹窗（popup 没有 tab.url，sender.url 可能是空的）：只认扩展 id，
    // 且不能是带 http(s) url 的内容脚本（内容脚本的 sender.id 也是扩展 id）。
    if (!url) {
      if (this.options.extensionId) return sender.id === this.options.extensionId;
      return typeof sender.id === 'string' && sender.id !== '';
    }
    return false;
  }

  async handle(raw: unknown, sender?: RecordMessageSender | null): Promise<RecordReply | null> {
    const parsed = parseRecordMessage(raw);
    if (parsed === null) return null;
    if ('ok' in parsed && parsed.ok === false) return parsed as RecordParseFailure;
    const message = parsed as ParsedRecordMessage;
    try {
      if (message.type === 'bb.record.event') {
        const tabId = Number(sender?.tab?.id);
        if (!Number.isInteger(tabId) || tabId <= 0) return failure('E_FORBIDDEN', 'bb.record.event 必须来自内容脚本（缺少 sender.tab）');
        const result = this.service.pushEvent(message.event, sender ?? null);
        return { ok: true, result };
      }
      if (message.type === 'bb.record.finish') {
        const tabId = Number(sender?.tab?.id);
        if (!Number.isInteger(tabId) || tabId <= 0) return failure('E_FORBIDDEN', 'bb.record.finish 必须来自内容脚本');
        const result = await this.service.finishFromOverlay(tabId);
        return { ok: true, result };
      }
      if (!this.isExtensionSender(sender)) {
        return failure('E_FORBIDDEN', 'record.* 页面操作只接受本扩展上下文的消息');
      }
      const result = await this.dispatchPageOp(message.op as RecordPageOp, message.params);
      return { ok: true, result };
    } catch (error) {
      if (error instanceof RecordServiceError) return { ok: false, ...error.toPayload() };
      if (error && typeof error === 'object') {
        const code = (error as { code?: unknown }).code;
        const messageText = (error as { message?: unknown }).message;
        const data = (error as { data?: unknown }).data;
        if (typeof code === 'string' && code) {
          return data === undefined
            ? { ok: false, code, message: typeof messageText === 'string' && messageText ? messageText : code }
            : { ok: false, code, message: typeof messageText === 'string' && messageText ? messageText : code, data };
        }
      }
      return failure('E_RECORD_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  private async dispatchPageOp(op: RecordPageOp, params: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'start':
        return this.service.start(params);
      case 'stop':
        return this.service.stop(params);
      case 'list':
        return this.service.list(params);
      case 'export':
        return this.service.export(params);
      case 'status':
        return this.service.status();
      case 'remove':
        return this.service.remove(String(params.id ?? ''));
      default:
        throw new RecordServiceError('E_BAD_ARG', '未知的 record op：' + String(op));
    }
  }
}

export interface ChromeRuntimeLike {
  sendMessage(message: unknown): Promise<unknown>;
}

/** 从 globalThis 取 chrome.runtime（页面客户端用；不可用返回 null）。 */
export function runtimeFromGlobal(): ChromeRuntimeLike | null {
  const runtime = (globalThis as unknown as { chrome?: { runtime?: ChromeRuntimeLike } }).chrome?.runtime;
  if (!runtime || typeof runtime.sendMessage !== 'function') return null;
  return runtime;
}

/**
 * 页面侧调用 record.* 的轻客户端（ops 页/录制浮层按钮用）。
 * 返回统一信封：`{ok:true,result}` / `{ok:false,code,message}`。
 */
export async function sendRecordMessage<T extends object = Record<string, unknown>>(
  op: RecordPageOp | 'finish',
  params: Record<string, unknown> = {},
  runtime: ChromeRuntimeLike | null = runtimeFromGlobal(),
): Promise<{ ok: true; result: T } | RecordParseFailure> {
  if (!runtime) return failure('E_NO_RUNTIME', '当前页面拿不到扩运行时通道（chrome.runtime 不可用）');
  try {
    const reply = await runtime.sendMessage({ type: 'bb.record.' + op, params });
    if (!reply || typeof reply !== 'object') {
      return failure('E_BAD_RESPONSE', '后台没有回包（record 服务可能未注册）');
    }
    const bag = reply as { ok?: unknown; result?: unknown; code?: unknown; message?: unknown; data?: unknown };
    if (bag.ok === true) return { ok: true, result: (bag.result ?? {}) as T };
    return failure(
      typeof bag.code === 'string' ? bag.code : 'E_RECORD_FAILED',
      typeof bag.message === 'string' ? bag.message : 'record 调用失败',
      bag.data,
    );
  } catch (error) {
    return failure('E_NO_RUNTIME', error instanceof Error ? error.message : String(error));
  }
}
