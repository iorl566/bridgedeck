// src/content/entry.ts —— 内容脚本入口接线：runtime 消息 → ContentSession。
//
// 只接收 `{type:'bb.content'}` 的动作桥消息；其它 runtime 消息（popup/background 的
// bb.status / bb.ping 等）一律不接管，避免把别人的消息通道关掉。
// 同步回包（内容脚本里的 observe/click/fill 都是同步 DOM 操作），因此 listener 返回 false；
// 真正的异步等待由 background 侧的传输层超时控制。

import { browser } from 'wxt/browser';
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import { parseContentRequest } from './protocol.ts';
import { browserDomEnvironment, ContentSession, failureOf } from './session.ts';

export interface InstallContentBridgeOptions {
  protocol?: string;
  doc?: Document;
  win?: Window;
  /** 测试注入：false 时不注册 runtime 监听，只返回 session。 */
  listen?: boolean;
  now?: () => number;
  random?: () => number;
}

export interface ContentBridgeMarker {
  runtime: 'ts';
  protocol: string;
  at: number;
  documentId: string;
  refs: () => number;
}

function isContentMessage(raw: unknown): boolean {
  return Boolean(raw) && typeof raw === 'object' && (raw as { type?: unknown }).type === 'bb.content';
}

/**
 * 安装内容脚本动作桥；返回页面侧会话（测试/诊断可直接驱动）。
 */
export function installContentBridge(options: InstallContentBridgeOptions = {}): ContentSession {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const session = new ContentSession(browserDomEnvironment(doc, win), {
    protocol: options.protocol ?? PROTOCOL_VERSION,
    now: options.now ?? Date.now,
    random: options.random ?? Math.random,
  });

  const marker: ContentBridgeMarker = {
    runtime: 'ts',
    protocol: options.protocol ?? PROTOCOL_VERSION,
    at: Date.now(),
    documentId: session.documentId,
    refs: () => session.refCount,
  };
  (globalThis as unknown as { __bbTsBridge?: ContentBridgeMarker }).__bbTsBridge = marker;

  if (options.listen !== false) {
    browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
      if (!isContentMessage(raw)) return false;
      // 定向帧：background 会在 params.targetFrameId 里写明目标帧（iframe 动作/逐帧观察）。
      // 没有 targetFrameId 时只由主文档回复，避免漏传 frameId 时 iframe 抢先回包。
      const frameId = (sender as { frameId?: unknown } | undefined)?.frameId;
      const params = (raw as { params?: unknown }).params;
      const targetFrameId = params && typeof params === 'object' ? (params as { targetFrameId?: unknown }).targetFrameId : undefined;
      if (typeof frameId === 'number') {
        if (typeof targetFrameId === 'number') {
          if (targetFrameId !== frameId) return false;
        } else if (frameId !== 0) {
          return false;
        }
      }
      const parsed = parseContentRequest(raw);
      if (!parsed.ok) {
        sendResponse(parsed.error);
        return false;
      }
      // click 在 focus 后有 ≤50ms 的有界复核（异步替换 fail-closed）：统一走异步回包、
      // 保持消息通道打开（返回 true），复核结束后再 sendResponse；不会无界等待。
      session.handleAsync(parsed.request).then(
        (reply) => sendResponse(reply),
        (error: unknown) => sendResponse(failureOf(error)),
      );
      return true;
    });
  }
  return session;
}
