#!/usr/bin/env node
// tests/extension/page-guard.mjs —— 页面守卫与 Agent 窗口的回归测试。
//
// 背景：session start 会新建一个独立的 Agent Window，但 chrome.tabs.onCreated
// 可能先于 window id 登记到达。守卫若把它当成"落进 agent 窗口的外部标签页"，
// 就会把唯一的标签页挪回用户窗口，Agent 于是跑在用户当前页面里。
//
// 这里用最小 chrome stub 复现这条时序，断言：
//   1. 刚建好（已登记）的 Agent 窗口，无论几个 tab 都不搬；
//   2. 未登记、且只有 1 个 tab 的新窗口（建窗竞态），不搬；
//   3. 未登记、已有 2 个 tab 的 agent 窗口里的外部 tab，仍然搬回用户窗口（守卫原职责）。

const listeners = new Map();
function makeListener(name) {
  return {
    addListener(fn) {
      const set = listeners.get(name) ?? new Set();
      set.add(fn);
      listeners.set(name, set);
    },
    removeListener(fn) {
      listeners.get(name)?.delete(fn);
    },
  };
}

const state = {
  agentWindowId: 111,
  agentWindowIds: [111],
  pageGuard: true,
  tabsByWindow: new Map([[111, [{ id: 222, windowId: 111, active: true }]]]),
  moved: [],
  created: [],
};

const storageLocal = { 'bb.settings': { pageGuard: true, borrowConfirm: true, allowHelp: true, longShotMode: 'auto' } };

const chromeApi = {
  runtime: {
    getManifest: () => ({ version: '0.1.2' }),
    onMessage: makeListener('runtime.onMessage'),
    onInstalled: makeListener('runtime.onInstalled'),
    onStartup: makeListener('runtime.onStartup'),
    sendMessage: async () => ({}),
    getURL: (p) => 'chrome-extension://stub/' + p,
    lastError: null,
  },
  storage: {
    local: {
      get: async (key) => (typeof key === 'string' ? { [key]: storageLocal[key] } : { ...storageLocal }),
      set: async () => {},
      remove: async () => {},
    },
    session: {
      get: async (key) => {
        if (key === 'bb.agentWindowIds') return { 'bb.agentWindowIds': state.agentWindowIds };
        if (key === 'bb.agentWindowId') return { 'bb.agentWindowId': state.agentWindowId };
        return { [key]: undefined };
      },
      set: async (props) => {
        if (props && Array.isArray(props['bb.agentWindowIds'])) state.agentWindowIds = props['bb.agentWindowIds'];
        if (props && props['bb.agentWindowId'] !== undefined) state.agentWindowId = props['bb.agentWindowId'];
      },
      remove: async () => {},
    },
    onChanged: makeListener('storage.onChanged'),
  },
  alarms: { create: async () => {}, onAlarm: makeListener('alarms.onAlarm') },
  tabs: {
    onRemoved: makeListener('tabs.onRemoved'),
    onUpdated: makeListener('tabs.onUpdated'),
    onCreated: makeListener('tabs.onCreated'),
    onActivated: makeListener('tabs.onActivated'),
    onDetached: makeListener('tabs.onDetached'),
    onAttached: makeListener('tabs.onAttached'),
    query: async (info = {}) => state.tabsByWindow.get(info.windowId) ?? [],
    get: async (id) => {
      for (const tabs of state.tabsByWindow.values()) {
        const found = tabs.find((tab) => tab.id === id);
        if (found) return found;
      }
      throw new Error('No tab with id: ' + id);
    },
    create: async (props = {}) => {
      const tab = { id: 900 + state.created.length, windowId: props.windowId ?? 111, active: props.active !== false };
      state.created.push(tab);
      return tab;
    },
    remove: async () => {},
    update: async () => ({}),
    move: async (tabId, props) => {
      state.moved.push({ tabId, windowId: props.windowId });
    },
    captureVisibleTab: async () => 'data:image/png;base64,',
  },
  windows: {
    onCreated: makeListener('windows.onCreated'),
    getLastFocused: async () => ({ id: 500 }),
    get: async (id) => ({ id, type: 'normal' }),
    create: async () => ({ id: 111, tabs: [{ id: 222, windowId: 111 }] }),
    update: async () => ({}),
    getAll: async () => [
      { id: 111, type: 'normal', focused: false },
      { id: 500, type: 'normal', focused: true },
    ],
  },
  debugger: { onEvent: makeListener('debugger.onEvent'), onDetach: makeListener('debugger.onDetach'), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
  offscreen: { hasDocument: async () => false, createDocument: async () => {} },
  scripting: { executeScript: async () => [] },
  webRequest: {
    onBeforeRequest: makeListener('webRequest.onBeforeRequest'),
    onSendHeaders: makeListener('webRequest.onSendHeaders'),
    onCompleted: makeListener('webRequest.onCompleted'),
    onErrorOccurred: makeListener('webRequest.onErrorOccurred'),
  },
  downloads: { onCreated: makeListener('downloads.onCreated'), search: async () => [], download: async () => 1 },
  action: { openPopup: async () => {} },
  permissions: { contains: async () => true },
};

globalThis.chrome = chromeApi;
globalThis.WebSocket = class {
  constructor() { this.readyState = 0; }
  send() {}
  close() {}
};

function emit(name, ...args) {
  for (const fn of listeners.get(name) ?? []) fn(...args);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function main() {
  const { markSelfCreatedWindow } = await import(new URL('../../extension/src/tabs.js', import.meta.url).href);
  await import(new URL('../../extension/src/bridge.js', import.meta.url).href);

  // 1. 已登记的 Agent 窗口（2 个 tab）：不搬
  state.agentWindowId = 111;
  state.agentWindowIds = [111];
  markSelfCreatedWindow(111);
  state.tabsByWindow.set(111, [{ id: 222, windowId: 111 }, { id: 223, windowId: 111 }]);
  emit('tabs.onCreated', { id: 223, windowId: 111, openerTabId: undefined });
  await settle();
  assert(state.moved.length === 0, '已登记 Agent 窗口里的 tab 不应被搬走');

  // 2. 已登记、但只有 1 个 tab 的新 Agent 窗口（建窗竞态）：不搬
  state.agentWindowId = 112;
  state.agentWindowIds = [111, 112];
  state.tabsByWindow.set(112, [{ id: 300, windowId: 112 }]);
  emit('tabs.onCreated', { id: 300, windowId: 112 });
  await settle();
  assert(state.moved.length === 0, '单 tab 的新 Agent 窗口不应被搬走');

  // 3. 已登记、2 个 tab 的 agent 窗口里的外部 tab：搬回用户窗口
  state.agentWindowId = 120;
  state.agentWindowIds = [111, 112, 120];
  state.tabsByWindow.set(120, [{ id: 400, windowId: 120 }, { id: 401, windowId: 120 }]);
  emit('tabs.onCreated', { id: 402, windowId: 120 });
  await settle();
  assert(state.moved.length === 1 && state.moved[0].windowId === 500, '外部 tab 应被搬回用户窗口 500');

  console.log('PASS  页面守卫回归：自建窗口放行 / 单 tab 放行 / 外部 tab 归位');
}

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL  ' + message);
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('FAIL  ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : String(error)));
  process.exit(1);
});
