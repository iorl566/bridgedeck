// tests/debug-page-replay.test.ts —— 33d：调试页重放自测链路（纯函数层，fake RPC）。
//
// 覆盖：
// - `pickReplayTarget` / `requestEntriesOf` 的取值语义（CDP 与资源计时两种快照形状）；
// - `runReplaySelftest` 的真实链路顺序：debug.start → 采集 → debug.current →
//   network.replay（页面 MAIN world 重放）→ 断言 status 200 → debug.stop；
// - 失败分支：重放 RPC 失败 / 非 200 status / 没采集到请求，都必须如实 fail（不造假）。
//
// 页面模块在 import 时就会启动 main()，所以这里注入最小假 DOM + 假 chrome.runtime，
// 让页面完成“渲染含重放面板的骨架”，再单独驱动导出的纯函数。

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ---------------------------------------------------------------------------
// 最小假 DOM（页面骨架渲染够用；不引入 jsdom 依赖）
// ---------------------------------------------------------------------------

class FakeStyle {
  cssText = '';
  visibility = '';
  display = '';
  setProperty(name: string, value: string): void {
    if (name === 'visibility') this.visibility = value;
    else if (name === 'display') this.display = value;
  }

  removeProperty(name: string): string {
    if (name === 'visibility') this.visibility = '';
    else if (name === 'display') this.display = '';
    return '';
  }
}

class FakeElement {
  readonly tagName: string;
  id = '';
  className = '';
  value = '';
  selected = false;
  innerHTML = '';
  readonly attrs = new Map<string, string>();
  readonly style = new FakeStyle();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<() => void>>();
  parentNode: FakeElement | null = null;
  isConnected = true;
  private text = '';

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = String(value);
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name) ?? null : null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentNode = this;
    child.isConnected = true;
    this.children.push(child);
    // 页面用 `<select>.value` 读当前标签页：fake 里同步选中项的值。
    if (this.tagName === 'SELECT' && child.tagName === 'OPTION' && child.selected) this.value = child.value;
    return child;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const text = new FakeElement('#text');
        text.textContent = node;
        this.appendChild(text);
      } else {
        this.appendChild(node);
      }
    }
  }

  addEventListener(type: string, handler: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }

  remove(): void {
    if (this.parentNode) {
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
    }
    this.isConnected = false;
  }

  attachShadow(init: { mode: 'open' | 'closed' }): { children: FakeElement[]; appendChild<T extends FakeElement>(child: T): T } {
    const shadow = {
      children: [] as FakeElement[],
      appendChild<T extends FakeElement>(child: T): T {
        shadow.children.push(child);
        return child;
      },
    };
    return shadow;
  }

  querySelector(selector: string): FakeElement | null {
    return queryAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return queryAll(this, selector);
  }
}

function matchElement(element: FakeElement, selector: string): boolean {
  const text = selector.trim();
  if (!text) return false;
  if (text.startsWith('[') && text.endsWith(']')) {
    const body = text.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) return element.hasAttribute(body);
    return element.getAttribute(body.slice(0, eq)) === body.slice(eq + 1).replace(/^['"]|['"]$/g, '');
  }
  if (text.startsWith('#')) return element.id === text.slice(1);
  return element.tagName === text.toUpperCase();
}

function queryAll(root: FakeElement, selector: string): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of root.children) {
    if (matchElement(child, selector)) out.push(child);
    for (const nested of queryAll(child, selector)) out.push(nested);
  }
  return out;
}

class FakeDocument {
  title = '';
  readyState = 'complete';
  readonly documentElement = new FakeElement('html');
  readonly head = new FakeElement('head');
  readonly body = new FakeElement('body');
  readonly listeners = new Map<string, Array<() => void>>();

  constructor() {
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  createTextNode(text: string): FakeElement {
    const node = new FakeElement('#text');
    node.textContent = text;
    return node;
  }

  addEventListener(type: string, handler: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }

  getElementById(id: string): FakeElement | null {
    if (this.documentElement.id === id) return this.documentElement;
    return queryAll(this.documentElement, '#' + id)[0] ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    if (matchElement(this.documentElement, selector)) return this.documentElement;
    return queryAll(this.documentElement, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return queryAll(this.documentElement, selector);
  }
}

interface FakeGlobals {
  doc: FakeDocument;
  calls: Array<{ op: string; params: Record<string, unknown> }>;
}

function installGlobals(options: {
  search?: string;
  handleUi?: (op: string, params: Record<string, unknown>) => unknown;
}): FakeGlobals {
  const doc = new FakeDocument();
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = doc;
  globals.location = { search: options.search ?? '' };
  globals.window = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
  globals.chrome = {
    runtime: {
      async sendMessage(message: { op?: unknown; params?: unknown }) {
        const op = String(message?.op ?? '');
        const params = (message?.params ?? {}) as Record<string, unknown>;
        calls.push({ op, params });
        return options.handleUi ? options.handleUi(op, params) : { ok: true, result: {} };
      },
    },
  };
  return { doc, calls };
}

const boot = installGlobals({ handleUi: () => ({ ok: true, result: { tabs: [] } }) });
const debugPage = await import('../src/ui/pages/debug.ts');

function makeCall(handlers: Record<string, (params: Record<string, unknown>) => unknown>, ops: string[]) {
  return async function call<T extends object = Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    ops.push(op);
    const handler = handlers[op];
    if (!handler) throw new Error('unexpected bb.ui op: ' + op);
    const value = await handler(params);
    if (value instanceof Error) throw value;
    return value as T;
  };
}

test('33d：页面骨架渲染出“请求重放”面板与“重放最近一条”按钮', () => {
  assert.ok(boot.doc.getElementById('dbg-replay-card'), '重放面板卡片应渲染');
  assert.ok(boot.doc.getElementById('dbg-replay'), '重放结果容器应渲染');
  assert.ok(boot.doc.getElementById('dbg-replay-last'), '重放最近一条按钮应渲染');
  assert.ok(boot.doc.querySelector('[data-bb-ui="x"]') === null);
});

test('33d：requestEntriesOf 同时兼容 current 的数组与 stop 的计数', () => {
  assert.deepEqual(debugPage.requestEntriesOf({ requests: [{ url: 'http://a/1' }] }), [{ url: 'http://a/1' }]);
  assert.deepEqual(debugPage.requestEntriesOf({ requests: 3 }), []);
  assert.deepEqual(debugPage.requestEntriesOf({ entries: [{ url: 'http://b/2' }] }), [{ url: 'http://b/2' }]);
  assert.deepEqual(debugPage.requestEntriesOf(null), []);
});

test('33d：pickReplayTarget 优先 /api/ping，其次 200 条目，非 http 一律跳过', () => {
  const picked = debugPage.pickReplayTarget([
    { url: 'chrome-extension://x/a.js', method: 'GET', status: 200 },
    { url: 'http://127.0.0.1:9/static.css', method: null, status: 200 },
    { url: 'http://127.0.0.1:9/api/ping', method: 'get', status: 200 },
  ]);
  assert.deepEqual(picked, { url: 'http://127.0.0.1:9/api/ping', method: 'GET' });
  const fallback = debugPage.pickReplayTarget([{ url: 'http://127.0.0.1:9/a', method: null, status: 204 }]);
  assert.deepEqual(fallback, { url: 'http://127.0.0.1:9/a', method: 'GET' });
  assert.equal(debugPage.pickReplayTarget([{ url: 'data:text/plain,hi' }]), null);
});

test('33d：runReplaySelftest 走 debug.start→current→network.replay→stop 并断言 200', async () => {
  const ops: string[] = [];
  const call = makeCall({
    'debug.start': () => ({ ok: true, capturing: true }),
    'debug.current': () => ({
      ok: true,
      requests: [
        { id: 1, url: 'http://127.0.0.1:9/static.js', method: 'GET', status: 200 },
        { id: 2, url: 'http://127.0.0.1:9/api/ping', method: 'GET', status: 200 },
      ],
    }),
    'network.replay': () => ({ ok: true, status: 200, url: 'http://127.0.0.1:9/api/ping', method: 'GET', durationMs: 7 }),
    'debug.stop': () => ({ ok: true, requests: 2, console: 0 }),
  }, ops);
  const outcome = await debugPage.runReplaySelftest({
    tabId: 7,
    call,
    poke: async () => true,
    sleep: async () => undefined,
    settleMs: 0,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.detail, '200');
  assert.equal(outcome.requestsSeen, 2);
  assert.equal(outcome.replayed, true);
  assert.deepEqual(ops, ['debug.start', 'debug.current', 'network.replay', 'debug.stop']);
});

test('33d：runReplaySelftest 在重放 RPC 失败时如实 fail（仍 stop 收尾）', async () => {
  const ops: string[] = [];
  const call = makeCall({
    'debug.start': () => ({ ok: true }),
    'debug.current': () => ({ ok: true, requests: [{ id: 1, url: 'http://127.0.0.1:9/api/ping', method: 'GET', status: 200 }] }),
    'network.replay': () => {
      throw new Error('E_REPLAY_FAILED: 主世界重放失败');
    },
    'debug.stop': () => ({ ok: true, requests: 1, console: 0 }),
  }, ops);
  const outcome = await debugPage.runReplaySelftest({ tabId: 7, call, sleep: async () => undefined, settleMs: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.replayed, false);
  assert.match(String(outcome.error), /E_REPLAY_FAILED/);
  assert.equal(ops[ops.length - 1], 'debug.stop', '失败后也要收尾采集');
});

test('33d：runReplaySelftest 对非 200 status 不谎报成功', async () => {
  const ops: string[] = [];
  const call = makeCall({
    'debug.start': () => ({ ok: true }),
    'debug.current': () => ({ ok: true, requests: [{ id: 1, url: 'http://127.0.0.1:9/api/ping', method: 'GET', status: 200 }] }),
    'network.replay': () => ({ ok: true, status: 503, url: 'http://127.0.0.1:9/api/ping', method: 'GET' }),
    'debug.stop': () => ({ ok: true }),
  }, ops);
  const outcome = await debugPage.runReplaySelftest({ tabId: 7, call, sleep: async () => undefined, settleMs: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 503);
  assert.equal(outcome.detail, '503');
  assert.match(String(outcome.error), /503/);
});

test('33d：runReplaySelftest 没采集到请求时 fail 且不调用 network.replay', async () => {
  const ops: string[] = [];
  const call = makeCall({
    'debug.start': () => ({ ok: true }),
    'debug.current': () => ({ ok: true, requests: [] }),
    'debug.stop': () => ({ ok: true }),
  }, ops);
  const outcome = await debugPage.runReplaySelftest({ tabId: 7, call, sleep: async () => undefined, settleMs: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.requestsSeen, 0);
  assert.match(String(outcome.error), /没有可重放的请求/);
  assert.equal(ops.includes('network.replay'), false);
});

test('33d：runReplaySelftest 没有目标标签页时直接 fail（不触任何 RPC）', async () => {
  const ops: string[] = [];
  const call = makeCall({}, ops);
  const outcome = await debugPage.runReplaySelftest({ tabId: 0, call, sleep: async () => undefined, settleMs: 0 });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /没有可采集的目标标签页/);
  assert.deepEqual(ops, []);
});
