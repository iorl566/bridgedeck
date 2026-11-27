// tests/mc6-defects.test.ts —— M-C 第六批：已迁移能力里的真实缺陷（35d / 35e / 23j4 / 29 / 29d）。
//
// 每个用例断言真实行为，不是形状占位：
// - 35d：focus 后目标被替换 → E_NOT_ACTIONABLE + receipt.effectState='unknown'，且不重放点击；
// - 35e：页面在 Agent 窗口打开的新 tab 走 follow/rebind 语义（tab.borrow 成功），
//        无归属证据的 Agent 窗口 tab 仍 E_FORBIDDEN；
// - 23j4：目标节点脱离文档 → E_TARGET_DETACHED（而不是内容脚本的 E_STALE_REF）；
// - 29：popup 产物/目录路径 = ui/popup.html（WXT 别名页），且 ui.open 登记归属；
// - 29d：RTL 语言判定 + title 固定到 head（游离 BOM 解析异常的防线）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clickElement, PageError, resolveTarget } from '../src/content/dom.ts';
import { ActionRegistry } from '../src/actions/registry.ts';
import { ReceiptStore } from '../src/actions/receipts.ts';
import { RefRegistry } from '../src/refs/registry.ts';
import { RpcMethodError } from '../src/rpc/registry.ts';
import type { ContentReply, ContentRequest } from '../src/content/protocol.ts';
import {
  createRuntimeCommands,
  type BrowserApiLike,
  type BrowserTabLike,
  type TabCreatedListener,
} from '../src/runtime/commands.ts';
import {
  AgentOwnedTabRegistry,
  decideAgentWindowBorrow,
  isOpenedFromAgentWindow,
} from '../src/runtime/tab-ownership.ts';
import { UiPageService } from '../src/ui/open.ts';
import type { UiTabsApi } from '../src/ui/open.ts';
import { findUiPage } from '../src/ui/catalog.ts';
import { applyHtmlCompat, createUiHtmlCompatPlugin, htmlOutputName, needsPopupAlias, stripHtmlBom, UI_POPUP_ALIAS_FILE } from '../src/ui/html-compat.ts';
import { applyDocumentDirection, isRtlLanguage, setDocumentTitle, type UiLanguage } from '../src/ui/page.ts';
import { createFakeDom, FakeElement } from './support/fake-dom.ts';

// ---------------------------------------------------------------------------
// 35d：动作前目标被替换 → fail closed + 不重放
// ---------------------------------------------------------------------------

test('35d：focus 后目标脱离文档 → E_NOT_ACTIONABLE(receipt.effectState=unknown)，不点击旧节点', async () => {
  const fake = createFakeDom([
    { tag: 'button', id: 'focus-swap', text: 'focus-swap', rect: { left: 10, top: 10, width: 100, height: 30 } },
  ], { title: 'vom', url: 'https://example.test/vom.html' });
  const target = fake.byId.get('focus-swap');
  assert.ok(target);
  const resolved = resolveTarget(fake.env.document, new Map(), { selector: '#focus-swap' });
  assert.equal(resolved.element, target);
  // 模拟页面 focus 处理器把目标 replaceWith 掉：旧节点脱离文档。
  target.isConnected = false;
  await assert.rejects(
    async () => clickElement(fake.env, resolved, {}),
    (error: unknown) => {
      assert.ok(error instanceof PageError);
      assert.equal(error.code, 'E_NOT_ACTIONABLE');
      const data = error.data as {
        receipt: { effectState: string; replay: boolean; method: string };
        effectState: string;
        reason: string;
        cause: string;
      };
      assert.equal(data.receipt.effectState, 'unknown');
      assert.equal(data.receipt.method, 'click');
      assert.equal(data.receipt.replay, false);
      assert.equal(data.effectState, 'unknown');
      assert.equal(data.reason, 'target-replaced');
      assert.equal(data.cause, 'detached');
      return true;
    },
  );
  assert.equal(target.focused, 1, 'focus 已经发生（替换发生在 focus 时）');
  assert.equal(target.clicked, 0, 'fail closed 后绝不能再点击旧节点');
});

test('35d：focus 后 selector 指向新节点 → E_NOT_ACTIONABLE(selector-replaced)，不重放', async () => {
  const fake = createFakeDom([
    { tag: 'button', id: 'focus-swap', text: 'focus-swap', rect: { left: 10, top: 10, width: 100, height: 30 } },
  ], { title: 'vom', url: 'https://example.test/vom.html' });
  const target = fake.byId.get('focus-swap');
  assert.ok(target);
  const resolved = resolveTarget(fake.env.document, new Map(), { selector: '#focus-swap' });
  const replacement = new FakeElement({ tag: 'button', id: 'focus-swap' });
  // focus 时页面 replaceWith 了新节点：再次查询 selector 命中新节点。
  (fake.document as unknown as { querySelector(selector: string): FakeElement | null }).querySelector = () => replacement;
  await assert.rejects(
    async () => clickElement(fake.env, resolved, {}),
    (error: unknown) => {
      assert.ok(error instanceof PageError);
      assert.equal(error.code, 'E_NOT_ACTIONABLE');
      const data = error.data as { cause: string; receipt: { effectState: string } };
      assert.equal(data.cause, 'selector-replaced');
      assert.equal(data.receipt.effectState, 'unknown');
      return true;
    },
  );
  assert.equal(target.clicked, 0);
});

test('35d：focus 处理器里 setTimeout 异步替换 → 有界复核在 ≤50ms 窗口内 fail closed，不重放', async () => {
  const fake = createFakeDom([
    { tag: 'button', id: 'focus-swap', text: 'focus-swap', rect: { left: 10, top: 10, width: 100, height: 30 } },
  ], { title: 'vom', url: 'https://example.test/vom.html' });
  const target = fake.byId.get('focus-swap');
  assert.ok(target);
  const resolved = resolveTarget(fake.env.document, new Map(), { selector: '#focus-swap' });
  const waits: number[] = [];
  // 注入有界等待：记录请求的毫秒数，并让出一个真实宏任务（让 setTimeout(0) 的替换先跑）。
  fake.env.wait = (ms: number): Promise<void> => {
    waits.push(ms);
    return new Promise<void>((resolve) => setTimeout(resolve, 5));
  };
  target.focus = () => {
    setTimeout(() => { target.isConnected = false; }, 0);
  };
  await assert.rejects(
    async () => clickElement(fake.env, resolved, {}),
    (error: unknown) => {
      assert.ok(error instanceof PageError);
      assert.equal(error.code, 'E_NOT_ACTIONABLE');
      const data = error.data as { cause: string; receipt: { effectState: string } };
      assert.equal(data.cause, 'detached');
      assert.equal(data.receipt.effectState, 'unknown');
      return true;
    },
  );
  assert.ok(waits.length >= 1, '发生了有界等待复核');
  assert.equal(waits[0], 20, '默认复核窗口 20ms');
  assert.ok(waits[0]! <= 50, '复核窗口不超过 50ms');
  assert.equal(target.clicked, 0, '异步替换后也不能重放点击');
});

test('35d：未聚焦文档里 focus() 不派发 focus 事件 → 补发合成 focus，页面替换仍被 fail closed', async () => {
  const fake = createFakeDom([
    { tag: 'button', id: 'focus-swap', text: 'focus-swap', rect: { left: 10, top: 10, width: 100, height: 30 } },
  ], { title: 'vom', url: 'https://example.test/vom.html' });
  const target = fake.byId.get('focus-swap');
  assert.ok(target);
  (fake.document as unknown as { hasFocus(): boolean }).hasFocus = () => false;
  const synthetic: string[] = [];
  target.dispatchEvent = (event: unknown): boolean => {
    const type = String((event as { type?: unknown } | null)?.type ?? '');
    synthetic.push(type);
    // 模拟夹具页面：focus 处理器里 replaceWith 新节点（旧节点脱离文档）。
    if (type === 'focus') target.isConnected = false;
    return true;
  };
  const resolved = resolveTarget(fake.env.document, new Map(), { selector: '#focus-swap' });
  await assert.rejects(
    async () => clickElement(fake.env, resolved, {}),
    (error: unknown) => {
      assert.ok(error instanceof PageError);
      assert.equal(error.code, 'E_NOT_ACTIONABLE');
      assert.equal((error.data as { cause: string }).cause, 'detached');
      return true;
    },
  );
  assert.deepEqual(synthetic, ['focusin', 'focus'], '未聚焦文档补发 focusin/focus 让页面副作用先跑');
  assert.equal(target.clicked, 0);
});

test('35d：复核窗口有界（settleAfterFocusMs 超过上限时截到 50ms，0 表示只做同步复核）', async () => {
  const fake = createFakeDom([
    { tag: 'button', id: 'btn', text: 'btn', rect: { left: 10, top: 10, width: 100, height: 30 } },
  ], { title: 't', url: 'https://example.test/' });
  const waits: number[] = [];
  fake.env.wait = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  const resolved = resolveTarget(fake.env.document, new Map(), { selector: '#btn' });
  await clickElement(fake.env, resolved, { settleAfterFocusMs: 9999 });
  await clickElement(fake.env, resolved, { settleAfterFocusMs: 0 });
  assert.deepEqual(waits, [50], '超过上限截到 50ms；0 不等待');
});

test('35d：content bridge 对异步 click 回包保持消息通道（sendResponse 延迟到复核结束）', async () => {
  const fake = createFakeDom([
    { tag: 'button', id: 'btn', text: 'btn', rect: { left: 10, top: 10, width: 100, height: 30 } },
  ], { title: 't', url: 'https://example.test/' });
  const listeners: Array<(raw: unknown, sender: unknown, sendResponse: (value: unknown) => void) => unknown> = [];
  const chromeStub = {
    runtime: {
      onMessage: {
        addListener(listener: (raw: unknown, sender: unknown, sendResponse: (value: unknown) => void) => unknown) {
          listeners.push(listener);
        },
      },
    },
  };
  const globals = globalThis as unknown as { chrome?: unknown; browser?: unknown };
  const previousChrome = globals.chrome;
  globals.chrome = chromeStub;
  try {
    const entry = await import('../src/content/entry.ts');
    entry.installContentBridge({
      doc: fake.document as unknown as Document,
      win: fake.window as unknown as Window,
      listen: true,
      protocol: '1.9',
    });
    assert.equal(listeners.length, 1, 'content bridge 注册了 runtime.onMessage 监听');
    let response: unknown = null;
    const returned = listeners[0]!(
      { type: 'bb.content', requestId: 'r-async', op: 'click', params: { selector: '#btn' } },
      { frameId: 0 },
      (value: unknown) => { response = value; },
    );
    // click 走异步复核：监听器必须返回 true 保持通道，回包尚未产生。
    assert.equal(returned, true);
    assert.equal(response, null);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.ok(response, '复核结束后必须回包');
    assert.equal((response as { ok: boolean }).ok, true);
    assert.equal((response as { result?: { ok?: boolean } }).result?.ok, true);
    assert.equal(fake.byId.get('btn')?.clicked, 1);
  } finally {
    if (previousChrome === undefined) delete globals.chrome;
    else globals.chrome = previousChrome;
  }
});

// ---------------------------------------------------------------------------
// 23j4：--node-scope 目标 detached → E_TARGET_DETACHED
// ---------------------------------------------------------------------------

function registryHarness(target: Record<string, unknown>) {
  const calls: string[] = [];
  const content = {
    async request(_tabId: number, request: ContentRequest): Promise<ContentReply> {
      calls.push(request.op);
      if (request.op === 'page-state') {
        return {
          ok: true,
          result: { url: 'https://example.test/test.html', documentId: 'doc-1', revision: 3, fingerprint: 'fp-1', target },
        };
      }
      if (request.op === 'click') return { ok: true, result: { ok: true, tag: 'button', x: 1, y: 2 } };
      return { ok: true, result: {} };
    },
  };
  const receipts = new ReceiptStore({ now: () => 1 });
  receipts.addObservation(7, {
    observationId: 'ob-1',
    documentId: 'doc-1',
    revision: 3,
    url: 'https://example.test/test.html',
    fingerprint: 'fp-1',
    signatures: {
      '@e5': { attached: true, tag: 'button', id: 'submit-btn', text: '提交查询', value: null, checked: null, signature: 'sig-same' },
    },
  });
  const refs = new RefRegistry({ now: () => 1 });
  refs.registerObservation(7, { documentId: 'doc-1', revision: 3, refs: [{ ref: '@e5', identity: 'button|submit-btn' }] });
  const actions = new ActionRegistry({ content, refs, receipts, now: () => 1 });
  return { actions, calls };
}

test('23j4：节点脱离文档但签名未变 → E_TARGET_DETACHED（不是 E_STALE_REF）', async () => {
  // 关键：脱离文档的节点仍保留 tag/id/text，签名与观察时一致 —— 只看签名会漏判。
  const { actions, calls } = registryHarness({
    attached: false,
    tag: 'button',
    id: 'submit-btn',
    text: '提交查询',
    value: null,
    checked: null,
    signature: 'sig-same',
  });
  await assert.rejects(
    actions.dispatch('click', { tabId: 7, ref: '@e5', observation: 'ob-1', nodeScope: true }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_TARGET_DETACHED');
      const data = error.data as { observed_changes: { scope: string; kinds: string[] }; ref: string };
      assert.equal(data.observed_changes.scope, 'node');
      assert.deepEqual(data.observed_changes.kinds, ['detached']);
      assert.equal(data.ref, '@e5');
      return true;
    },
  );
  assert.deepEqual(calls, ['page-state'], 'node-scope 失败前只做了 page-state 复核，click 未被派发');
});

test('23j4：节点仍在但文本变化 → E_OBSERVATION_CHANGED(scope=node, kinds=[text])', async () => {
  const { actions } = registryHarness({
    attached: true,
    tag: 'button',
    id: 'submit-btn',
    text: '已被改名',
    value: null,
    checked: null,
    signature: 'sig-changed',
  });
  await assert.rejects(
    actions.dispatch('click', { tabId: 7, ref: '@e5', observation: 'ob-1', nodeScope: true }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_OBSERVATION_CHANGED');
      const data = error.data as { observed_changes: { scope: string; kinds: string[] } };
      assert.equal(data.observed_changes.scope, 'node');
      assert.deepEqual(data.observed_changes.kinds, ['text']);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 35e：follow / rebind 归属语义
// ---------------------------------------------------------------------------

test('35e：归属判定纯函数 —— Agent 窗口 + opener 证据放行，无证据仍拒绝', () => {
  assert.equal(isOpenedFromAgentWindow({ windowId: 10 }, [10]), true);
  assert.equal(isOpenedFromAgentWindow({ windowId: 11 }, [10]), false);
  assert.equal(isOpenedFromAgentWindow(null, [10]), false);
  assert.equal(decideAgentWindowBorrow({ inAgentWindow: false, ownedReason: null, openerInAgentWindow: false }).allowed, true);
  assert.equal(decideAgentWindowBorrow({ inAgentWindow: true, ownedReason: 'extension-ui', openerInAgentWindow: false }).reason, 'agent-owned');
  assert.equal(decideAgentWindowBorrow({ inAgentWindow: true, ownedReason: 'page-opened', openerInAgentWindow: false }).reason, 'page-opened');
  assert.equal(decideAgentWindowBorrow({ inAgentWindow: true, ownedReason: null, openerInAgentWindow: true }).reason, 'opener-in-agent-window');
  const denied = decideAgentWindowBorrow({ inAgentWindow: true, ownedReason: null, openerInAgentWindow: false });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'agent-window');
});

test('35e：AgentOwnedTabRegistry 登记/查询/清理（关闭 tab 后不再命中）', () => {
  const registry = new AgentOwnedTabRegistry({ now: () => 5, limit: 2 });
  registry.mark(1, 'page-opened');
  registry.mark(2, 'extension-ui');
  assert.equal(registry.get(1)?.reason, 'page-opened');
  assert.equal(registry.get(2)?.reason, 'extension-ui');
  registry.mark(3, 'page-opened');
  assert.equal(registry.list().length, 2, '超过上限丢弃最旧登记');
  assert.equal(registry.has(1), false);
  registry.drop(2);
  assert.equal(registry.has(2), false);
});

function storageArea(seed: Record<string, unknown> = {}) {
  return {
    async get(key: string): Promise<Record<string, unknown>> {
      return { [key]: seed[key] };
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(seed, items);
    },
  };
}

function runtimeHarness() {
  const tabsMap = new Map<number, BrowserTabLike>([
    [44, { id: 44, windowId: 10, url: 'https://example.test/test.html', title: '夹具页' }],
    [55, { id: 55, windowId: 10, openerTabId: 44, url: 'https://example.test/frame.html', title: 'frame', index: 1 }],
    [66, { id: 66, windowId: 10, url: 'about:blank', title: '' }],
    [88, { id: 88, windowId: 10, url: 'chrome-extension://x/ui/popup.html', title: 'BridgeDeck' }],
    [99, { id: 99, windowId: 20, url: 'https://user.example/', title: '用户标签页' }],
  ]);
  const createdListeners: TabCreatedListener[] = [];
  const api = {
    tabs: {
      async get(tabId: number): Promise<BrowserTabLike> {
        const tab = tabsMap.get(Number(tabId));
        if (!tab) throw new Error('no tab ' + String(tabId));
        return tab;
      },
      async query(): Promise<BrowserTabLike[]> { return [...tabsMap.values()]; },
      async update(tabId: number, props: Record<string, unknown>): Promise<BrowserTabLike> { return { id: tabId, ...props } as BrowserTabLike; },
      async create(props: Record<string, unknown>): Promise<BrowserTabLike> { return { id: 900, windowId: 10, url: String(props.url ?? '') }; },
      async remove(tabId: number): Promise<void> { tabsMap.delete(Number(tabId)); },
      async reload(): Promise<void> { /* noop */ },
      onUpdated: { addListener() { /* noop */ }, removeListener() { /* noop */ } },
      onCreated: {
        addListener(listener: TabCreatedListener) { createdListeners.push(listener); },
        removeListener() { /* noop */ },
      },
    },
    windows: {
      async getAll(): Promise<Array<Record<string, unknown>>> { return []; },
      async create(): Promise<Record<string, unknown>> { return { id: 10 }; },
      async get(): Promise<Record<string, unknown>> { return { id: 10 }; },
      async update(): Promise<Record<string, unknown>> { return { id: 10 }; },
      async remove(): Promise<void> { /* noop */ },
    },
    storage: { local: storageArea(), session: storageArea({ 'bb.agentWindows': [10] }) },
  } as unknown as BrowserApiLike;
  return { api, tabsMap, createdListeners };
}

function commandContext(params: Record<string, unknown>) {
  return { method: 'tab.borrow', params, timeoutMs: 5000, requestId: 'test', now: 0 };
}

test('35e：Agent 窗口 tab 的 borrow —— 页面 opener 证据放行，普通 tab 仍 E_FORBIDDEN', async () => {
  const { api } = runtimeHarness();
  const ownedTabs = new AgentOwnedTabRegistry({ now: () => 1 });
  const commands = createRuntimeCommands({ api, ownedTabs, now: () => 1 });
  const borrow = commands.find((command) => command.method === 'tab.borrow');
  assert.ok(borrow);

  // 无归属证据（例如会话自己的 tab）：保持借用策略拒绝（E2E 26/20q 的断言）。
  await assert.rejects(
    async () => { await borrow.handler(commandContext({ tabId: 66 })); },
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_FORBIDDEN');
      assert.equal((error.data as { reason: string }).reason, 'agent-window');
      return true;
    },
  );

  // 用户窗口里的 tab：借用路径仍未迁移，必须明确 E_NOT_IMPLEMENTED（不能静默成功）。
  await assert.rejects(
    async () => { await borrow.handler(commandContext({ tabId: 99 })); },
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_NOT_IMPLEMENTED');
      return true;
    },
  );

  // 页面在 Agent 窗口里打开的 tab（openerTabId 指向 Agent 窗口内的 tab）：follow/rebind 放行。
  const followed = await borrow.handler(commandContext({ tabId: 55 })) as Record<string, unknown>;
  assert.equal(followed.tabId, 55);
  assert.equal(followed.windowId, 10);
  assert.equal(followed.url, 'https://example.test/frame.html');
  assert.equal(followed.borrowed, false);
  assert.equal(followed.ownership, 'opener-in-agent-window');
  assert.equal(ownedTabs.get(55)?.reason, 'page-opened', 'opener 复核通过后落归属表');
});

test('35e：onCreated 先登记归属；扩展 UI 页由 ui.open 登记后可直接改绑', async () => {
  const { api, tabsMap, createdListeners } = runtimeHarness();
  const ownedTabs = new AgentOwnedTabRegistry({ now: () => 1 });
  const commands = createRuntimeCommands({ api, ownedTabs, now: () => 1 });
  const borrow = commands.find((command) => command.method === 'tab.borrow');
  assert.ok(borrow);
  assert.equal(createdListeners.length, 1, '工厂注册了 tabs.onCreated（页面在 Agent 窗口开 tab 时登记）');

  // onCreated：新 tab 的 opener 在 Agent 窗口内 → 落归属表。
  tabsMap.set(77, { id: 77, windowId: 10, openerTabId: 55, url: 'https://example.test/frame.html', title: 'frame' });
  createdListeners[0]?.({ id: 77, windowId: 10, openerTabId: 55 });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(ownedTabs.get(77)?.reason, 'page-opened');
  const fromCreated = await borrow.handler(commandContext({ tabId: 77 })) as Record<string, unknown>;
  assert.equal(fromCreated.ownership, 'page-opened');

  // ui.open 打开的扩展 UI 页：extension-ui 归属 → session start/rebind 不被借用流程误挡。
  ownedTabs.mark(88, 'extension-ui');
  const uiTab = await borrow.handler(commandContext({ tabId: 88 })) as Record<string, unknown>;
  assert.equal(uiTab.ownership, 'agent-owned');
  assert.equal(uiTab.borrowed, false);

  // 归属与窗口位置无关：扩展 UI 页即使落在用户窗口，也按 Agent 控制面直接改绑。
  ownedTabs.mark(99, 'extension-ui');
  const uiTabInUserWindow = await borrow.handler(commandContext({ tabId: 99 })) as Record<string, unknown>;
  assert.equal(uiTabInUserWindow.ownership, 'agent-owned');
  assert.equal(uiTabInUserWindow.windowId, 20);
});

// ---------------------------------------------------------------------------
// 29 / 29d：popup 产物路径 + RTL / title 固定
// ---------------------------------------------------------------------------

test('29：catalog popup 路径 = ui/popup.html；WXT 输出名映射与 popup 别名页判定', () => {
  assert.equal(findUiPage('popup')?.path, UI_POPUP_ALIAS_FILE);
  assert.equal(UI_POPUP_ALIAS_FILE, 'ui/popup.html');
  assert.equal(htmlOutputName('entrypoints/options.html'), 'options.html');
  assert.equal(htmlOutputName('entrypoints/popup/index.html'), 'popup.html');
  assert.equal(needsPopupAlias('entrypoints/popup/index.html'), true);
  assert.equal(needsPopupAlias('entrypoints/options.html'), false);
  assert.equal(needsPopupAlias('entrypoints/ui/popup.html'), false, '嵌套 ui 入口不由别名逻辑处理');
});

test('29d：去游离 BOM（Vite 留在 DOCTYPE 后的 U+FEFF）——head 解析正常，title 不再落进 body', () => {
  const broken = '<!DOCTYPE html>\uFEFF\n<html lang="zh-CN"><head><title>设置</title></head><body></body></html>';
  const fixed = stripHtmlBom(broken);
  assert.equal(fixed.includes('\uFEFF'), false);
  assert.equal(fixed, '<!DOCTYPE html>\n<html lang="zh-CN"><head><title>设置</title></head><body></body></html>');
  assert.equal(stripHtmlBom('plain html'), 'plain html');
  assert.equal(stripHtmlBom(''), '');
});

test('29d：applyHtmlCompat 清理 bundle 内全部 HTML，并为 popup 写出 ui/popup.html 别名页', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'bb-html-compat-'));
  try {
    const brokenOptions = '<!DOCTYPE html>\uFEFF\n<html><head><title>设置</title></head><body></body></html>';
    const brokenPopup = '<!DOCTYPE html>\uFEFF\n<html><head><title>BridgeDeck</title></head><body></body></html>';
    const bundle = {
      'entrypoints/options.html': { type: 'asset', source: brokenOptions },
      'entrypoints/popup/index.html': { type: 'asset', source: brokenPopup },
      'chunks/page.js': { type: 'asset', source: 'no-bom' },
    };
    const written = applyHtmlCompat(bundle, outDir);
    assert.deepEqual(written, [UI_POPUP_ALIAS_FILE]);
    assert.equal((bundle['entrypoints/options.html']?.source as string).includes('\uFEFF'), false);
    assert.equal((bundle['entrypoints/popup/index.html']?.source as string).includes('\uFEFF'), false);
    const alias = readFileSync(join(outDir, 'ui', 'popup.html'), 'utf8');
    assert.equal(alias.includes('\uFEFF'), false);
    assert.match(alias, /<title>BridgeDeck<\/title>/);
    assert.match(alias, /^<!DOCTYPE html>\n<html>/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('29/29d：Vite 插件钩子（generateBundle）真实清理 bundle 并落盘 popup 别名页', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'bb-html-plugin-'));
  try {
    const plugin = createUiHtmlCompatPlugin();
    assert.equal(plugin.name, 'bridgedeck:ui-html-compat');
    const generateBundle = plugin.generateBundle;
    assert.equal(typeof generateBundle, 'function');
    const brokenOptions = '<!DOCTYPE html>\uFEFF\n<html><head><title>设置</title></head><body></body></html>';
    const brokenPopup = '<!DOCTYPE html>\uFEFF\n<html><head><title>BridgeDeck</title></head><body></body></html>';
    const bundle: Record<string, { type: string; fileName: string; source: string | Uint8Array }> = {
      'entrypoints/options.html': { type: 'asset', fileName: 'entrypoints/options.html', source: brokenOptions },
      'entrypoints/popup/index.html': { type: 'asset', fileName: 'entrypoints/popup/index.html', source: brokenPopup },
      'chunks/background.js': { type: 'chunk', fileName: 'chunks/background.js', source: '' },
    };
    const infos: string[] = [];
    const context = {
      info(message: string) { infos.push(message); },
    };
    (generateBundle as unknown as (this: unknown, options: unknown, bundle: unknown) => void)
      .call(context, { dir: outDir }, bundle);
    assert.equal((bundle['entrypoints/options.html']?.source as string).includes('\uFEFF'), false);
    assert.equal((bundle['entrypoints/popup/index.html']?.source as string).includes('\uFEFF'), false);
    const alias = readFileSync(join(outDir, 'ui', 'popup.html'), 'utf8');
    assert.match(alias, /<title>BridgeDeck<\/title>/);
    assert.equal(infos.some((line) => line.includes(UI_POPUP_ALIAS_FILE)), true, '插件把额外产出写进构建日志');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('29/29d：真实 Vite MPA 构建（临时 root）→ 产物 HTML 无游离 BOM 且产出 ui/popup.html', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-vite-mpa-'));
  try {
    mkdirSync(join(root, 'entrypoints', 'popup'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    // 源码带 UTF-8 BOM，复现 WXT 实际输入（Vite 输出会把 BOM 留在 HTML 里）。
    writeFileSync(
      join(root, 'entrypoints', 'popup', 'index.html'),
      '\uFEFF<!doctype html>\n<html lang="zh-CN"><head><title>BridgeDeck</title><script type="module" src="./main.js"></script></head><body><div id="root"></div></body></html>',
    );
    writeFileSync(join(root, 'entrypoints', 'popup', 'main.js'), 'document.body.dataset.ready = "1";\n');
    writeFileSync(
      join(root, 'entrypoints', 'options.html'),
      '\uFEFF<!doctype html>\n<html><head><title>设置</title><script type="module" src="../src/options.js"></script></head><body></body></html>',
    );
    writeFileSync(join(root, 'src', 'options.js'), 'console.log("options");\n');
    const { build } = await import('vite');
    const outDir = join(root, 'dist');
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [createUiHtmlCompatPlugin()],
      build: {
        outDir,
        emptyOutDir: true,
        rollupOptions: {
          input: {
            popup: join(root, 'entrypoints', 'popup', 'index.html'),
            options: join(root, 'entrypoints', 'options.html'),
          },
        },
      },
    });
    const popupHtml = readFileSync(join(outDir, 'entrypoints', 'popup', 'index.html'), 'utf8');
    const optionsHtml = readFileSync(join(outDir, 'entrypoints', 'options.html'), 'utf8');
    assert.equal(popupHtml.includes('\uFEFF'), false);
    assert.equal(optionsHtml.includes('\uFEFF'), false);
    assert.match(optionsHtml, /<head>[\s\S]*<title>设置<\/title>/);
    const alias = readFileSync(join(outDir, UI_POPUP_ALIAS_FILE), 'utf8');
    assert.equal(alias.includes('\uFEFF'), false);
    assert.match(alias, /<title>BridgeDeck<\/title>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('29d：ar/he 为 RTL；applyDocumentDirection 写 lang/dir（逻辑属性前提）', () => {
  for (const [language, dir] of [['ar', 'rtl'], ['he', 'rtl'], ['zh', 'ltr'], ['en', 'ltr']] as Array<[UiLanguage, string]>) {
    const attrs = new Map<string, string>();
    const root = { setAttribute(name: string, value: string) { attrs.set(name, value); } } as unknown as Element;
    applyDocumentDirection(root, language);
    assert.equal(attrs.get('lang'), language);
    assert.equal(attrs.get('dir'), dir);
    assert.equal(isRtlLanguage(language), dir === 'rtl');
  }
});

test('29/35e：ui.open 打开的扩展 UI 页登记 extension-ui 归属（可被 session start/rebind 直接改绑）', async () => {
  const registry = new AgentOwnedTabRegistry({ now: () => 1 });
  const api: UiTabsApi = {
    tabs: {
      async create(props: Record<string, unknown>) {
        return { id: 901, windowId: 10, url: String(props.url ?? ''), title: 'BridgeDeck' };
      },
      async get(tabId: number) {
        return { id: tabId, windowId: 10, url: 'chrome-extension://x/ui/popup.html', title: 'BridgeDeck' };
      },
      async update() { return { ok: true }; },
      async query() { return []; },
    },
  };
  const service = new UiPageService({
    api,
    resolveUrl: (pagePath: string) => 'chrome-extension://x/' + pagePath,
    agentTabs: registry,
    now: () => 1,
  });
  const opened = await service.open({ page: 'popup' });
  assert.equal(opened.page, 'popup');
  assert.equal(opened.url, 'chrome-extension://x/ui/popup.html');
  assert.equal(registry.get(opened.tabId)?.reason, 'extension-ui');
});

test('29d：setDocumentTitle 把 title 固定到 head（body 重绘不会连 title 一起清掉）', () => {
  // 模仿“title 被解析进 body”的坏文档：head 里没有 title，body 里有一个。
  const head: Record<string, unknown> = {};
  const bodyTitle: Record<string, unknown> = { tagName: 'TITLE', textContent: '设置', parentNode: null };
  const headQueryTitle: Record<string, unknown>[] = [];
  head.querySelector = () => headQueryTitle[0] ?? null;
  head.appendChild = (node: Record<string, unknown>) => {
    headQueryTitle[0] = node;
    node.parentNode = head;
    return node;
  };
  const doc = {
    head,
    title: '',
    createElement: (tag: string) => ({ tagName: tag.toUpperCase(), textContent: '', parentNode: null }),
    querySelector: (selector: string) => (selector === 'title' ? bodyTitle : null),
  };
  setDocumentTitle(doc as unknown as Document, 'الإعدادات');
  const title = headQueryTitle[0];
  assert.ok(title, 'title 被移进 head');
  assert.equal(title.textContent, 'الإعدادات');
  assert.equal(title.parentNode, head);
  // 再次设置（切换语言）复用同一个 title，不重复创建。
  setDocumentTitle(doc as unknown as Document, 'הגדרות');
  assert.equal(headQueryTitle.length, 1);
  assert.equal((headQueryTitle[0] as { textContent: string }).textContent, 'הגדרות');
});
