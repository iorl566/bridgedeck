#!/usr/bin/env node
// tests/extension/module-load.mjs —— 用最小 chrome stub 加载 service worker 入口，
// 快速发现"语法错误 / 缺 import / 顶层异常"这类会让扩展完全连不上的问题。
// BB_EXT_ROOT 可指向解压后的发布包，用来验证 zip 裁剪没有漏文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extRoot = process.env.BB_EXT_ROOT
  ? path.resolve(process.cwd(), process.env.BB_EXT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
const target = pathToFileURL(path.join(extRoot, 'src', 'bridge.js')).href;
if (!fs.existsSync(path.join(extRoot, 'src', 'bridge.js'))) {
  console.log('FAIL  扩展入口不存在：' + path.join(extRoot, 'src', 'bridge.js'));
  process.exit(1);
}
const listener = () => ({ addListener() {}, removeListener() {} });
const stub = {
  runtime: {
    getManifest: () => ({ version: '0.1.2' }),
    onMessage: listener(),
    onInstalled: listener(),
    onStartup: listener(),
    sendMessage: async () => ({}),
    getURL: (p) => 'chrome-extension://stub/' + p,
    lastError: null,
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: listener(),
  },
  alarms: { create: async () => {}, onAlarm: listener() },
  tabs: {
    onRemoved: listener(),
    onUpdated: listener(),
    onCreated: listener(),
    onActivated: listener(),
    query: async () => [],
    get: async () => ({ id: 1, windowId: 1, url: 'about:blank' }),
    create: async () => ({ id: 1, windowId: 1 }),
    remove: async () => {},
    update: async () => ({}),
    captureVisibleTab: async () => 'data:image/png;base64,',
  },
  windows: {
    getLastFocused: async () => ({ id: 1 }),
    get: async () => ({ id: 1, type: 'normal' }),
    create: async () => ({ id: 1 }),
    update: async () => ({}),
    getAll: async () => [],
  },
  debugger: { onEvent: listener(), onDetach: listener(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
  offscreen: { hasDocument: async () => false, createDocument: async () => {} },
  scripting: { executeScript: async () => [] },
  webRequest: {
    onBeforeRequest: listener(),
    onSendHeaders: listener(),
    onCompleted: listener(),
    onErrorOccurred: listener(),
  },
  downloads: { onCreated: listener(), search: async () => [], download: async () => 1 },
  action: { openPopup: async () => {} },
  permissions: { contains: async () => true },
};

globalThis.chrome = stub;
globalThis.WebSocket = class {
  constructor() {
    this.readyState = 0;
  }
  send() {}
  close() {}
};

try {
  await import(target);
  console.log('PASS  扩展 service worker 模块加载正常');
  process.exit(0);
} catch (error) {
  console.log('FAIL  扩展模块加载失败：');
  console.log(error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n') : String(error));
  process.exit(1);
}
