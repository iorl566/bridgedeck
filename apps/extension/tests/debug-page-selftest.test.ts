// tests/debug-page-selftest.test.ts —— 33d 页面级自测：`debug.html?selftest=replay` 真链路。
//
// 与 debug-page-replay.test.ts 的分工：那边测纯函数（可注入 sleep/RPC），这里把页面模块
// 真的 boot 起来（假 DOM + 假 chrome.runtime），断言 E2E 轮询的那行标题：
//   SELFTEST:ok:replay:<status>
//
// 页面链路（与 background 的真实实现对齐）：
//   tabs → debug.start → 制造一次请求 → debug.current 采集条目 →
//   network.replay（页面 MAIN world fetch）→ debug.stop → 写 title。

import assert from 'node:assert/strict';
import { test } from 'node:test';

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

  addEventListener(): void {
    // 页面引导的 DOMContentLoaded 监听：fake 环境里 readyState=complete，不会触发。
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

// ---------------------------------------------------------------------------
// 假运行时：bb.ui 回包（链路里每个 op 都必须被真实调用）
// ---------------------------------------------------------------------------

const PAGE_URL = 'http://127.0.0.1:9/test.html';
const PING_URL = 'http://127.0.0.1:9/api/ping';
const calls: Array<{ op: string; params: Record<string, unknown> }> = [];

function reply(result: Record<string, unknown>): { ok: true; result: Record<string, unknown> } {
  return { ok: true, result };
}

function handleUi(op: string, params: Record<string, unknown>): unknown {
  switch (op) {
    case 'tabs':
      return reply({ ok: true, tabs: [{ tabId: 7, url: PAGE_URL, title: 'E2E 夹具页', windowId: 1, active: true }] });
    case 'debug.rule.list':
      return reply({ ok: true, rules: [] });
    case 'debug.performance':
      return reply({ ok: true, metrics: { url: PAGE_URL, resources: { count: 3 } } });
    case 'debug.start':
      return reply({ ok: true, capturing: true, tabId: params.tabId });
    case 'debug.current':
      return reply({
        ok: true,
        active: true,
        requests: [{ id: 1, url: PING_URL, method: 'GET', status: 200, startedAt: 1 }],
        console: [],
      });
    case 'network.replay':
      return reply({ ok: true, status: 200, url: PING_URL, method: 'GET', durationMs: 9, mode: 'page-fetch-replay' });
    case 'debug.stop':
      return reply({ ok: true, requests: 1, console: 0 });
    default:
      return { ok: false, code: 'E_UNKNOWN_OP', message: 'unexpected op ' + op };
  }
}

const doc = new FakeDocument();
const globals = globalThis as unknown as Record<string, unknown>;
globals.document = doc;
globals.location = { search: '?selftest=replay' };
globals.window = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
globals.chrome = {
  runtime: {
    async sendMessage(message: { op?: unknown; params?: unknown }) {
      const op = String(message?.op ?? '');
      const params = (message?.params ?? {}) as Record<string, unknown>;
      calls.push({ op, params });
      return handleUi(op, params);
    },
  },
};

// 页面模块 import 即启动 main()（selftest=replay 分支会真实跑链路）。
await import('../src/ui/pages/debug.ts');

async function waitForTitle(pattern: RegExp, timeoutMs = 8_000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const title = String(doc.title || '');
    if (pattern.test(title)) return title;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return String(doc.title || '');
}

test('33d：debug.html?selftest=replay 写出 SELFTEST:ok:replay:200 并真的调用 network.replay', async () => {
  const title = await waitForTitle(/^SELFTEST:/);
  assert.match(title, /^SELFTEST:ok:replay:\d+$/, '标题必须是 SELFTEST:ok:replay:<status>，实际：' + JSON.stringify(title));
  const status = Number(title.split(':').pop());
  assert.equal(status, 200, '重放响应 status 应为 200');
  const ops = calls.map((call) => call.op);
  assert.equal(ops.includes('debug.start'), true, '必须先真实开始采集');
  assert.equal(ops.includes('debug.current'), true, '必须读真实采集结果');
  assert.equal(ops.includes('network.replay'), true, '必须经 background 的 network.replay 重放');
  assert.equal(ops.includes('debug.stop'), true, '自测结束必须收尾采集');
  // 重放参数来自真实采集条目（URL 一致），而不是页面自己编一个 URL。
  const replayCall = calls.find((call) => call.op === 'network.replay');
  const request = (replayCall?.params.request ?? {}) as Record<string, unknown>;
  assert.equal(request.url, PING_URL);
  assert.equal(request.method, 'GET');
  assert.equal(replayCall?.params.tabId, 7);
});
