// src/cdp/errors.ts —— chrome.debugger 错误的归一化（不抛裸字符串，不吞错误）。
//
// chrome.debugger 的失败信息只有 message（没有稳定的 code），所以用正则分类：
// - busy：别的调试会话（DevTools/另一扩展）已附加 → 明确 E_CDP_BUSY，由调用方降级；
// - forbidden：受限页面（chrome://、扩展页、Web Store 等）→ E_CDP_FORBIDDEN；
// - detached：本地以为还挂着，浏览器侧已经分离 → E_CDP_DETACHED（可重挂重试一次）；
// - no-tab：tab 已关闭 → E_CDP_NO_TAB（不重试）；
// - timeout：本地超时（本模块自己抛的 E_CDP_TIMEOUT）；
// - 其它：保留原始 message，标 E_CDP_COMMAND / E_CDP_ATTACH。

import type { CdpErrorCode } from './types.ts';

export interface CdpErrorContext {
  method?: string;
  tabId?: number;
  sessionId?: string;
  phase?: 'attach' | 'send' | 'detach' | 'event';
}

/** CDP 通道错误：带稳定 code / method / 结构化 data，便于 frames 层判断能否降级。 */
export class CdpError extends Error {
  readonly code: CdpErrorCode;
  readonly method: string | null;
  readonly tabId: number | null;
  readonly sessionId: string | null;
  readonly phase: string | null;
  readonly data: Record<string, unknown>;
  override readonly cause: unknown;

  constructor(
    code: CdpErrorCode,
    message: string,
    options: {
      method?: string | null;
      tabId?: number | null;
      sessionId?: string | null;
      phase?: string | null;
      cause?: unknown;
      data?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
    this.method = options.method ?? null;
    this.tabId = options.tabId ?? null;
    this.sessionId = options.sessionId ?? null;
    this.phase = options.phase ?? null;
    this.cause = options.cause;
    this.data = options.data ?? {};
  }

  static isCdpError(value: unknown): value is CdpError {
    return value instanceof CdpError;
  }

  /** 是否值得重试（分离/超时/瞬时命令失败可重试；busy/forbidden/no-tab 不重试）。 */
  get retryable(): boolean {
    return this.code === 'E_CDP_DETACHED' || this.code === 'E_CDP_TIMEOUT' || this.code === 'E_CDP_COMMAND';
  }
}

/** 取任意错误的 message 文本（chrome.debugger 的 rejection 可能不是 Error 实例）。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
  }
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

const NOT_ATTACHED_RE = /debugger is not attached|not attached to the tab|was not attached/i;
const BUSY_RE = /another debugger|already attached|debugger is already attached|attach.*already/i;
const NO_TAB_RE = /no tab with (?:given )?id|tab (?:was )?closed|no tab with id|invalid tab id/i;
const FORBIDDEN_RE = /cannot access|not allowed|permission|denied|receiving end does not exist|unsupported|chrome:\/\/|edge:\/\//i;
const TIMEOUT_RE = /timed?\s*out|timeout/i;

export function isNotAttachedMessage(message: string): boolean {
  return NOT_ATTACHED_RE.test(message);
}

export function isBusyMessage(message: string): boolean {
  return BUSY_RE.test(message);
}

export function isForbiddenMessage(message: string): boolean {
  return FORBIDDEN_RE.test(message);
}

export function isNoTabMessage(message: string): boolean {
  return NO_TAB_RE.test(message);
}

/**
 * 把 chrome.debugger 抛出的任意失败收敛成 CdpError。
 * 已经是 CdpError 的原样返回（保留 timeout/attach 上下文）。
 */
export function normalizeCdpError(error: unknown, context: CdpErrorContext = {}): CdpError {
  if (error instanceof CdpError) return error;
  const message = errorMessage(error);
  const base = {
    method: context.method ?? null,
    tabId: context.tabId ?? null,
    sessionId: context.sessionId ?? null,
    phase: context.phase ?? null,
    cause: error,
    data: { rawMessage: message },
  } as const;
  if (isNotAttachedMessage(message)) {
    return new CdpError('E_CDP_DETACHED', '调试会话已分离（' + (context.method ?? 'cdp') + '）：' + message, base);
  }
  if (isBusyMessage(message)) {
    return new CdpError('E_CDP_BUSY', '标签页已被其它调试会话占用（DevTools/另一扩展）：' + message, base);
  }
  if (isNoTabMessage(message)) {
    return new CdpError('E_CDP_NO_TAB', '标签页已关闭，调试会话不可用：' + message, base);
  }
  if (TIMEOUT_RE.test(message) && /cdp|调试|timeout|超时/i.test(message)) {
    return new CdpError('E_CDP_TIMEOUT', 'CDP 命令超时：' + message, base);
  }
  if (isForbiddenMessage(message)) {
    return new CdpError('E_CDP_FORBIDDEN', '当前页面不允许挂载调试器：' + message, base);
  }
  if (context.phase === 'attach') {
    return new CdpError('E_CDP_ATTACH', '挂载 chrome.debugger 失败：' + message, base);
  }
  return new CdpError('E_CDP_COMMAND', 'CDP 命令失败（' + (context.method ?? 'unknown') + '）：' + message, base);
}

/** 结构化证据（报告/日志用；不含原始 Error 对象）。 */
export function cdpErrorData(error: unknown): Record<string, unknown> {
  const normalized = normalizeCdpError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    ...(normalized.method ? { method: normalized.method } : {}),
    ...(normalized.tabId !== null ? { tabId: normalized.tabId } : {}),
    ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
    ...(normalized.phase ? { phase: normalized.phase } : {}),
  };
}
