// src/record/chrome-deps.ts —— record 服务的 chrome.* 依赖实现（background 接线唯一入口）。
//
// background 只需要三行：
//   const record = createChromeRecordService(browser, { extensionOrigin: browser.runtime.getURL('') });
//   router.register('record.start', (ctx) => record.start(ctx.params), ...); // stop/list/export/status 同理
//   runtime.onMessage 里先跑 recordMessages.handle(raw, sender)
//
// 这里把“注入页面录制器 / 显示浮层 / 读 tabs / 读 storage / 导出截图”都封成 RecordServiceDeps，
// 单测可以完全不碰 chrome.*（直接用 fake deps）；此文件只在 background 产物里引用。

import { installRecordCapture, stopRecordCapture } from './capture.ts';
import { installRecordOverlay, removeRecordOverlay } from '../content/record-overlay.ts';
import { RecordService, type RecordScreenshot, type RecordServiceDeps, type RecordTabInfo } from './service.ts';
import { RecordStore, type StorageAreaLike } from './store.ts';

export interface ChromeTabLike {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
}

export interface ChromeTabsApi {
  get(tabId: number): Promise<ChromeTabLike>;
  sendMessage?(tabId: number, message: unknown, options?: Record<string, unknown>): Promise<unknown>;
  captureVisibleTab?(windowId: number, options?: Record<string, unknown>): Promise<string>;
}

export interface ChromeScriptingApi {
  executeScript(options: Record<string, unknown>): Promise<Array<{ result?: unknown }>>;
}

export interface ChromeRecordApi {
  tabs?: ChromeTabsApi;
  scripting?: ChromeScriptingApi;
  storage?: {
    session?: StorageAreaLike | null;
    local?: StorageAreaLike | null;
  };
  runtime?: {
    id?: string;
    getURL?(path: string): string;
  };
}

export interface ChromeRecordOptions {
  /** 浮层语言（缺省从 storage.local 的 bb.uiLang 读，再回落 zh）。 */
  lang?: string | (() => string | Promise<string>);
  /** 失败路径日志（background 的 log）。 */
  log?: (message: string) => void;
  now?: () => number;
  agentInputAt?: (tabId: number) => number;
  /** 最终观察（background 可给 observe 命令的薄包装；缺省没有最终状态）。 */
  observe?: (tabId: number) => Promise<{ text: string; url?: string; title?: string; refs?: number; at?: number } | null> | null;
}

function toInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function readUiLang(api: ChromeRecordApi, options: ChromeRecordOptions): Promise<string> {
  if (typeof options.lang === 'string' && options.lang) return options.lang;
  if (typeof options.lang === 'function') {
    try {
      const value = await options.lang();
      if (typeof value === 'string' && value) return value;
    } catch {
      // 回落 storage/navigator
    }
  }
  try {
    const stored = await api.storage?.local?.get('bb.uiLang') ?? null;
    const value = stored ? stored['bb.uiLang'] : null;
    if (typeof value === 'string' && value) return value;
  } catch {
    // 忽略
  }
  return 'zh';
}

/** 用真实 chrome.* 构造 RecordServiceDeps（可选注入的项保留给调用方覆盖）。 */
export function createChromeRecordDeps(api: ChromeRecordApi, options: ChromeRecordOptions = {}): RecordServiceDeps {
  const scripting = api.scripting;
  const store = new RecordStore({
    session: api.storage?.session ?? null,
    local: api.storage?.local ?? null,
  });

  const injectCapture = async (tabId: number, startedAt: number, includeAgent: boolean): Promise<number> => {
    if (!scripting) return 0;
    const args = [{ startedAt, includeAgent }];
    const attempt = async (options: Record<string, unknown>): Promise<Array<{ result?: unknown }> | null> => {
      try {
        return await scripting.executeScript({ ...options, world: 'ISOLATED', func: installRecordCapture, args });
      } catch {
        return null;
      }
    };
    const usable = (results: Array<{ result?: unknown }> | null): number => {
      if (!results) return 0;
      let installed = 0;
      for (const item of results) {
        const result = item?.result as { ok?: boolean } | undefined;
        if (result && result.ok !== false) installed += 1;
      }
      return installed;
    };
    let results = await attempt({ target: { tabId, allFrames: true } });
    if (!results || usable(results) === 0) {
      // 某些 frame（受限/跨源/尚未有 documentElement）会整批失败：退化为只注入主文档。
      results = await attempt({ target: { tabId, frameIds: [0] } });
    }
    if (!results || usable(results) === 0) {
      // webNavigation.onCommitted 时文档可能还没 documentElement：稍后重试一次。
      await new Promise((resolve) => setTimeout(resolve, 250));
      results = await attempt({ target: { tabId, frameIds: [0] } });
    }
    const installed = usable(results);
    return installed > 0 ? installed : Array.isArray(results) ? results.length : 0;
  };

  return {
    now: options.now ?? Date.now,
    store,
    log: options.log,
    ...(options.agentInputAt ? { agentInputAt: options.agentInputAt } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
    tabs: {
      async get(tabId: number): Promise<RecordTabInfo | null> {
        try {
          const tab = await api.tabs?.get(tabId);
          if (!tab) return null;
          return {
            tabId: toInteger(tab.id) ?? tabId,
            windowId: Number.isInteger(Number(tab.windowId)) ? Number(tab.windowId) : null,
            url: String(tab.url ?? ''),
            title: String(tab.title ?? ''),
          };
        } catch {
          return null;
        }
      },
    },
    capture: {
      start: (tabId: number, captureOptions: { startedAt: number; includeAgent: boolean }) =>
        injectCapture(tabId, captureOptions.startedAt, captureOptions.includeAgent),
      async stop(tabId: number): Promise<number> {
        let replied = 0;
        try {
          const reply = await api.tabs?.sendMessage?.(tabId, { type: 'bb.record.deactivate' });
          if (reply) replied = 1;
        } catch {
          replied = 0;
        }
        // 内容脚本 deactivate 会先 flush 消息队列；留一拍让事件消息落库，避免 stop 落库
        // 早于最后一条 hover/click 事件（20d9 的 dwell 事件尤其依赖这一点）。
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (!scripting) return replied;
        // 兜底：直接注入 stop（tabs.sendMessage 在 frame 没有监听/页面刚导航时可能不可达）。
        try {
          await scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'ISOLATED',
            func: stopRecordCapture,
            args: [],
          });
        } catch {
          // 页面可能已关闭
        }
        return replied;
      },
    },
    overlay: {
      async show(tabId: number, startedAt: number): Promise<boolean> {
        if (!scripting) return false;
        const lang = await readUiLang(api, options);
        try {
          await scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'ISOLATED',
            func: installRecordOverlay,
            args: [startedAt, lang],
          });
          return true;
        } catch {
          return false;
        }
      },
      async hide(tabId: number): Promise<boolean> {
        if (!scripting) return false;
        try {
          await scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'ISOLATED',
            func: removeRecordOverlay,
            args: [],
          });
          return true;
        } catch {
          return false;
        }
      },
    },
    async captureScreenshot(tabId: number): Promise<RecordScreenshot | null> {
      const tabs = api.tabs;
      if (!tabs || typeof tabs.captureVisibleTab !== 'function') return null;
      try {
        const tab = await tabs.get(tabId);
        const windowId = Number(tab?.windowId);
        if (!Number.isInteger(windowId)) return null;
        const dataUrl = await tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 60 });
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
        return { dataUrl, width: null, height: null };
      } catch {
        return null;
      }
    },
  };
}

/** background 一行接线用：真实 chrome 依赖 + RecordService。 */
export function createChromeRecordService(api: ChromeRecordApi, options: ChromeRecordOptions = {}): RecordService {
  return new RecordService(createChromeRecordDeps(api, options));
}
