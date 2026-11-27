// tests/unit/ui-pages-smoke.test.mjs —— 页面模块启动冒烟（DOM/chrome 桩，Node 内）。
//
// 目的：捕获「页面一加载就炸」的问题（import 路径错、TDZ、顶层 undefined 标识符、
// 新增渲染函数在空数据下的异常）。真正交互仍由 E2E 覆盖，这里只做静态无法保证的
// 模块求值 + 首次渲染。
//
// 桩的边界：只实现页面首屏会碰到的 API；所有数据为空（空态路径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UI_DIR = path.resolve(import.meta.dirname, '..', '..', 'extension', 'ui');

function makeElement(holder = {}) {
  const element = function () {};
  element.nodeType = 1;
  element.tagName = 'DIV';
  element.children = [];
  element.childNodes = [];
  element.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  element.dataset = {};
  element.style = { setProperty() {}, removeProperty() {} };
  element.hidden = false;
  element.value = '';
  element.textContent = '';
  element.disabled = false;
  element.tabIndex = -1;
  element.options = [];
  element.querySelectorAll = () => [];
  element.querySelector = () => null;
  element.closest = () => null;
  element.addEventListener = () => {};
  element.removeEventListener = () => {};
  element.appendChild = () => element;
  element.append = () => {};
  element.insertBefore = () => element;
  element.remove = () => {};
  element.setAttribute = () => {};
  element.removeAttribute = () => {};
  element.getAttribute = () => null;
  element.focus = () => {};
  element.click = () => {};
  element.scrollIntoView = () => {};
  element.prepend = () => {};
  element.getBoundingClientRect = () => ({ width: 100, height: 30, top: 0, left: 0 });
  element.contains = () => false;
  element.cloneNode = () => makeElement({});
  element.clientWidth = 480;
  element.clientHeight = 320;
  const target = element;
  Object.defineProperty(target, 'parentElement', {
    get() {
      if (!holder.parent) holder.parent = makeElement({});
      return holder.parent;
    },
  });
  Object.defineProperty(target, 'nextElementSibling', { get() { return null; } });
  Object.defineProperty(target, 'previousElementSibling', { get() { return null; } });
  return target;
}

function installStubs() {
  const sent = [];
  const payload = {
    ok: true,
    entries: [],
    history: [],
    total: 0,
    requests: [],
    console: [],
    metrics: {},
    rules: [],
    recordings: [],
    active: [],
    state: { active: false },
    integrity: null,
    result: { entries: [], history: [], total: 0, recordings: [], active: [] },
  };
  const documentStub = {
    body: makeElement(),
    documentElement: makeElement(),
    head: makeElement(),
    readyState: 'complete',
    title: '',
    createElement: () => makeElement({}),
    createTextNode: () => makeElement({}),
    createDocumentFragment: () => makeElement({}),
    getElementById: () => makeElement({}),
    querySelector: () => makeElement({}),
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
  };
  documentStub.body.childNodes = [];
  Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', {
    value: { search: '', href: 'chrome-extension://stub/ui/page.html', pathname: '/ui/page.html', reload() {} },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'history', { value: { replaceState() {}, back() {}, length: 1 }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'URL', {
    value: Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL() {} }),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'chrome', {
    value: {
      runtime: {
        getURL: (suffix) => 'chrome-extension://stub/' + (suffix || ''),
        sendMessage: async (message) => { sent.push(message && message.type); return payload; },
        onMessage: { addListener() {} },
        lastError: null,
      },
      tabs: { query: async () => [], getCurrent: async () => null, create: async () => {}, remove: async () => {}, get: async () => null },
      storage: {
        session: { get: async () => ({}), set: async () => {} },
        local: { get: async () => ({}), set: async () => {} },
      },
      scripting: { executeScript: async () => [] },
      permissions: { contains: async () => true },
    },
    configurable: true,
    writable: true,
  });
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.MutationObserver = class { observe() {} };
  globalThis.indexedDB = { open: () => ({}) };
  return { sent, payload };
}

test('五个页面模块在空数据下可以完成首屏渲染并发出真实 RPC', async () => {
  installStubs();
  const pages = ['debug', 'audit', 'ops', 'record', 'longshot'];
  const sent = [];
  // 桩里的 sendMessage 会记录消息类型；从全局 chrome 上换成同一个收集器。
  // 注意：录制状态必须明确 active:false，否则页面会启动每秒计时的 interval
  // （真实后台的 bb.rec.state 返回 {active:false}）。
  globalThis.chrome.runtime.sendMessage = async (message) => {
    const type = message && message.type;
    sent.push(type);
    if (type === 'bb.rec.state' || type === 'bb.video.state') {
      return { ok: true, result: { active: false, tabId: null, startedAt: 0 } };
    }
    if (type === 'bb.ops.active') return { ok: true, active: [] };
    if (type === 'bb.debug.history' || type === 'bb.audit.list' || type === 'bb.ops.list') {
      return { ok: true, entries: [], history: [], recordings: [], total: 0 };
    }
    return {
      ok: true, entries: [], history: [], total: 0, requests: [], console: [], metrics: {}, rules: [],
      recordings: [], active: [], integrity: null, state: { active: false },
      result: { entries: [], history: [], total: 0, recordings: [], active: [], active_operations: [] },
    };
  };
  for (const page of pages) {
    try {
      await import(pathToFileURL(path.join(UI_DIR, page + '.js')).href);
      // 让首屏的 await（storage/get/list）完成，空态路径全部走到。
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.ok(true, page + ' 加载成功');
    } catch (error) {
      assert.fail(page + '.js 模块加载/首屏渲染失败：' + (error && error.message) + '\n' + String(error && error.stack).split('\n').slice(0, 6).join('\n'));
    }
  }
  assert.ok(sent.length >= 5, '页面没有发出 RPC（桩计数异常）：' + JSON.stringify(sent));
  assert.ok(sent.some((type) => type === 'bb.debug.history'), 'debug 页没有请求历史');
  assert.ok(sent.some((type) => type === 'bb.audit.list'), 'audit 页没有请求审计列表');
  assert.ok(sent.some((type) => type === 'bb.ops.list'), 'ops 页没有请求录制列表');
});
