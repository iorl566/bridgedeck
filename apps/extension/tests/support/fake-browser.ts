// tests/support/fake-browser.ts —— 运行命令单测用的假 browser API。
//
// 覆盖 createRuntimeCommands 用到的面：tabs/windows/storage + onUpdated 事件。
// 行为刻意贴近真实扩展：tabs.update 后 status=complete 并触发一次 onUpdated；
// sessions/local 存储是内存 Map；会话级存储可以被测到（端口记忆/agent 窗口）。

import type {
  BrowserApiLike,
  BrowserTabLike,
  BrowserWindowLike,
  StorageAreaLike,
  TabUpdatedListener,
  TabsLike,
  WindowsLike,
} from '../../src/runtime/commands.ts';

export class FakeStorageArea implements StorageAreaLike {
  readonly data = new Map<string, unknown>();

  async get(key: string): Promise<Record<string, unknown>> {
    return this.data.has(key) ? { [key]: this.data.get(key) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

interface FakeTab extends BrowserTabLike {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  status: string;
}

interface FakeWindow extends BrowserWindowLike {
  id: number;
  focused: boolean;
  type: string;
  incognito: boolean;
}

export class FakeBrowserApi implements BrowserApiLike {
  readonly windowsData: FakeWindow[] = [];
  readonly tabsData: FakeTab[] = [];
  readonly storage = { local: new FakeStorageArea(), session: new FakeStorageArea() };
  readonly listeners: TabUpdatedListener[] = [];
  /** 模拟 Edge 启动早期：即使传 focused:false，新窗口也会抢到焦点。 */
  forceFocusOnCreate = false;
  private nextWindowId = 1;
  private nextTabId = 100;

  readonly tabs: TabsLike;
  readonly windows: WindowsLike;

  constructor() {
    this.tabs = {
      get: async (tabId: number) => this.getTab(tabId),
      query: async (queryInfo: Record<string, unknown>) => this.queryTabs(queryInfo),
      update: async (tabId: number, props: Record<string, unknown>) => this.updateTab(tabId, props),
      create: async (props: Record<string, unknown>) => this.createTab(props),
      remove: async (tabId: number) => this.removeTab(tabId),
      reload: async (tabId: number) => this.reloadTab(tabId),
      move: async (tabId: number, props: Record<string, unknown>) => this.moveTab(tabId, props),
      onUpdated: {
        addListener: (listener: TabUpdatedListener) => {
          this.listeners.push(listener);
        },
        removeListener: (listener: TabUpdatedListener) => {
          const index = this.listeners.indexOf(listener);
          if (index >= 0) this.listeners.splice(index, 1);
        },
      },
    };
    this.windows = {
      getAll: async (info: Record<string, unknown>) => this.getAllWindows(info),
      create: async (props: Record<string, unknown>) => this.createWindow(props),
      get: async (windowId: number) => this.getWindow(windowId),
      update: async (windowId: number, props: Record<string, unknown>) => this.updateWindow(windowId, props),
      remove: async (windowId: number) => this.removeWindow(windowId),
    };
  }

  private getTab(tabId: number): FakeTab {
    const tab = this.tabsData.find((item) => item.id === tabId);
    if (!tab) throw new Error('No tab with id ' + String(tabId));
    return tab;
  }

  private getWindow(windowId: number): FakeWindow {
    const window = this.windowsData.find((item) => item.id === windowId);
    if (!window) throw new Error('No window with id ' + String(windowId));
    return window;
  }

  private queryTabs(queryInfo: Record<string, unknown>): FakeTab[] {
    return this.tabsData.filter((tab) => {
      for (const [key, value] of Object.entries(queryInfo ?? {})) {
        if (key === 'windowId' && tab.windowId !== Number(value)) return false;
        if (key === 'active' && tab.active !== value) return false;
      }
      return true;
    });
  }

  private createTab(props: Record<string, unknown>): FakeTab {
    const windowId = Number.isInteger(Number(props.windowId))
      ? Number(props.windowId)
      : (this.windowsData[0]?.id ?? this.createWindow({}).id);
    const tab: FakeTab = {
      id: ++this.nextTabId,
      windowId,
      url: String(props.url ?? 'about:blank'),
      title: '',
      active: props.active !== false,
      status: 'complete',
    };
    if (tab.active) for (const other of this.tabsData) if (other.windowId === windowId) other.active = false;
    this.tabsData.push(tab);
    return tab;
  }

  private updateTab(tabId: number, props: Record<string, unknown>): FakeTab {
    const tab = this.getTab(tabId);
    if (typeof props.url === 'string') {
      tab.url = props.url;
      tab.status = 'complete';
      this.emit(tabId, { status: 'complete', url: tab.url }, tab);
    }
    if (props.active === true) {
      for (const other of this.tabsData) if (other.windowId === tab.windowId) other.active = false;
      tab.active = true;
    }
    return tab;
  }

  private removeTab(tabId: number): void {
    const index = this.tabsData.findIndex((item) => item.id === tabId);
    if (index < 0) throw new Error('No tab with id ' + String(tabId));
    this.tabsData.splice(index, 1);
  }

  private reloadTab(tabId: number): void {
    const tab = this.getTab(tabId);
    tab.status = 'complete';
    this.emit(tabId, { status: 'complete', url: tab.url }, tab);
  }

  private moveTab(tabId: number, props: Record<string, unknown>): FakeTab {
    const tab = this.getTab(tabId);
    tab.windowId = Number(props.windowId);
    return tab;
  }

  private getAllWindows(info: Record<string, unknown>): FakeWindow[] {
    return this.windowsData.map((window) => ({
      ...window,
      ...(info.populate === true
        ? {
          tabs: this.tabsData
            .filter((tab) => tab.windowId === window.id)
            .map((tab) => ({ id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title, active: tab.active, status: tab.status })),
        }
        : {}),
    }));
  }

  private createWindow(props: Record<string, unknown>): FakeWindow {
    const shouldFocus = this.forceFocusOnCreate || props.focused === true;
    if (shouldFocus) for (const other of this.windowsData) other.focused = false;
    const window: FakeWindow = {
      id: ++this.nextWindowId,
      focused: shouldFocus,
      type: String(props.type ?? 'normal'),
      incognito: props.incognito === true,
    };
    this.windowsData.push(window);
    this.createTab({ windowId: window.id, url: String(props.url ?? 'about:blank'), active: true });
    return window;
  }

  private updateWindow(windowId: number, props: Record<string, unknown>): FakeWindow {
    const window = this.getWindow(windowId);
    if (props.focused === true) {
      for (const other of this.windowsData) other.focused = false;
      window.focused = true;
    }
    return window;
  }

  private removeWindow(windowId: number): void {
    const index = this.windowsData.findIndex((item) => item.id === windowId);
    if (index < 0) throw new Error('No window with id ' + String(windowId));
    for (let tabIndex = this.tabsData.length - 1; tabIndex >= 0; tabIndex -= 1) {
      const tab = this.tabsData[tabIndex];
      if (tab && tab.windowId === windowId) this.tabsData.splice(tabIndex, 1);
    }
    this.windowsData.splice(index, 1);
  }

  private emit(tabId: number, info: { status?: string; url?: string }, tab?: BrowserTabLike): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(tabId, info, tab);
      } catch {
        // 监听器异常不影响测试主流程
      }
    }
  }

  // ---- 测试驱动面 ----

  seedWindow(props: { focused?: boolean; url?: string } = {}): FakeWindow {
    return this.createWindow({ focused: props.focused ?? false, url: props.url ?? 'about:blank' });
  }

  findTab(tabId: number): FakeTab | null {
    return this.tabsData.find((item) => item.id === tabId) ?? null;
  }

  activeTab(): FakeTab | null {
    return this.tabsData.find((item) => item.active === true) ?? null;
  }
}

/** settings 存储里的 daemon 形状（供 settings.get 用例种子）。 */
export function seedBridgeSettings(api: FakeBrowserApi, settings: Record<string, unknown>): void {
  api.storage.local.data.set('bridgeSettings', settings);
}
