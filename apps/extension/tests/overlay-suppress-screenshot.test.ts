// tests/overlay-suppress-screenshot.test.ts —— 截图抑制 hook 单测（24d）。
//
// 断言截图主路径的真实顺序：hide（overlay-suppress hidden=true）→ captureVisibleTab →
// restore（hidden=false），并且：
// - restore 在 finally 里无条件执行（截图抛错也不会把浮层留在隐藏状态）；
// - 内容脚本没有这个 op / 传输异常都不阻塞截图（best-effort）；
// - 抑制期间浮层 host 的 computed visibility 是 hidden，截图后恢复 visible。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScreenshotService } from '../src/capture/screenshot.ts';
import {
  handleTakeoverOverlayOp,
  installTakeoverOverlay,
  takeoverOverlayState,
} from '../src/content/takeover-overlay.ts';
import type { ContentReply, ContentRequest } from '../src/content/protocol.ts';
import { createFakeCanvasCodec, fakePngDataUrl } from './support/fake-canvas.ts';

// ---------------------------------------------------------------------------
// 最小假 DOM（只够 takeover 浮层用；与 overlay-suppress-overlay.test.ts 同形状）
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
  readonly attrs = new Map<string, string>();
  readonly style = new FakeStyle();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<() => void>>();
  parentNode: FakeElement | null = null;
  isConnected = true;
  shadowMode = '';
  shadow: { children: FakeElement[] } | null = null;
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

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentNode = this;
    child.isConnected = true;
    this.children.push(child);
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
    this.shadowMode = init.mode;
    const shadow = {
      children: [] as FakeElement[],
      appendChild<T extends FakeElement>(child: T): T {
        shadow.children.push(child);
        return child;
      },
    };
    this.shadow = shadow;
    return shadow;
  }

  querySelector(selector: string): FakeElement | null {
    return walkFind(this, selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      if (matchElement(child, selector)) out.push(child);
      const nested = child.querySelectorAll(selector);
      for (const item of nested) out.push(item);
    }
    return out;
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

function walkFind(root: FakeElement, selector: string): FakeElement | null {
  for (const child of root.children) {
    if (matchElement(child, selector)) return child;
    const nested = walkFind(child, selector);
    if (nested) return nested;
  }
  return null;
}

function createFakeDom(): { doc: Document; win: Window } {
  const html = new FakeElement('html');
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  html.appendChild(head);
  html.appendChild(body);
  const docLike = {
    documentElement: html,
    head,
    body,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => {
      const node = new FakeElement('#text');
      node.textContent = text;
      return node;
    },
    getElementById: (id: string): FakeElement | null => {
      const found = walkFind(html, '#' + id);
      return found;
    },
    querySelector: (selector: string): FakeElement | null => walkFind(html, selector),
    querySelectorAll: (selector: string): FakeElement[] => walkFindAll(html, selector),
  };
  const winLike = {
    getComputedStyle: (element: FakeElement) => ({
      visibility: element.style.visibility || 'visible',
      display: element.style.display || 'block',
    }),
  };
  return {
    doc: docLike as unknown as Document,
    win: winLike as unknown as Window,
  };
}

function walkFindAll(root: FakeElement, selector: string): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of root.children) {
    if (matchElement(child, selector)) out.push(child);
    for (const nested of walkFindAll(child, selector)) out.push(nested);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 假 tabs（captureVisibleTab 里读抑制状态）
// ---------------------------------------------------------------------------

interface CaptureHarness {
  service: ScreenshotService;
  events: string[];
  calls: Array<{ op: string; params: Record<string, unknown> }>;
  visibilityAtCapture: string[];
  doc: Document;
  win: Window;
}

function createHarness(options: {
  /** 浮层是否先安装（24d 的真实场景）。 */
  withOverlay?: boolean;
  /** 内容脚本对 overlay-suppress 的回包策略。 */
  suppressReply?: 'ok' | 'unknown-op' | 'throw';
  /** 第 N 次 captureVisibleTab 抛错（模拟截图失败）。 */
  failCapture?: boolean;
} = {}): CaptureHarness {
  const { doc, win } = createFakeDom();
  const events: string[] = [];
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const visibilityAtCapture: string[] = [];
  if (options.withOverlay !== false) installTakeoverOverlay({ doc, win });

  const tabsApi = {
    tabs: {
      async get(tabId: number) {
        return { id: tabId, windowId: 3, url: 'https://example.test/', title: '示例页', active: true };
      },
      async query(_queryInfo: Record<string, unknown>) {
        return [{ id: 7, windowId: 3, url: 'https://example.test/', active: true }];
      },
      async update(_tabId: number, _props: Record<string, unknown>) {
        return {};
      },
      async captureVisibleTab(_windowId?: number, _options?: Record<string, unknown>) {
        events.push('capture');
        visibilityAtCapture.push(takeoverOverlayState({ doc, win }).visibility);
        if (options.failCapture) throw new Error('boom');
        return fakePngDataUrl(400, 300);
      },
    },
  };

  const content = {
    async request(_tabId: number, request: ContentRequest, _options?: { timeoutMs?: number }): Promise<ContentReply> {
      calls.push({ op: request.op, params: { ...request.params } });
      if (String(request.op) === 'overlay-suppress') {
        events.push('suppress:' + String(request.params.hidden));
        if (options.suppressReply === 'throw') throw new Error('content channel down');
        if (options.suppressReply === 'unknown-op') {
          return { ok: false, code: 'E_UNKNOWN_OP', message: '内容脚本不支持的操作：' + request.op };
        }
        return { ok: true, result: handleTakeoverOverlayOp(request.params, { doc, win }) };
      }
      return { ok: false, code: 'E_UNKNOWN_OP', message: 'unexpected op ' + request.op };
    },
  };

  const service = new ScreenshotService({
    api: tabsApi,
    content,
    codec: createFakeCanvasCodec(),
    now: () => 1_000,
    sleep: async () => undefined,
    captureIntervalMs: 0,
    maxFullPageFrames: 4,
  });
  return { service, events, calls, visibilityAtCapture, doc, win };
}

test('24d：截图主路径按 hide → capture → restore 顺序执行，且期间浮层 computed visibility=hidden', async () => {
  const harness = createHarness();
  const result = await harness.service.takeScreenshot({ tabId: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.overlaySuppressed, true, '内容脚本确认抑制时应带 overlaySuppressed:true 证据');
  assert.deepEqual(harness.events, ['suppress:true', 'capture', 'suppress:false']);
  assert.deepEqual(harness.visibilityAtCapture, ['hidden'], 'captureVisibleTab 调用瞬间浮层必须已隐藏');
  const after = takeoverOverlayState({ doc: harness.doc, win: harness.win });
  assert.equal(after.visibility, 'visible', '截图后浮层必须恢复可见');
  assert.equal(after.attached, true, '抑制不是卸载 host');
});

test('24d：内容脚本没有 overlay-suppress op 时截图照常成功（best-effort），仍尝试恢复', async () => {
  const harness = createHarness({ suppressReply: 'unknown-op' });
  const result = await harness.service.takeScreenshot({ tabId: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.overlaySuppressed, false, '没有内容脚本回包不能谎报已抑制');
  assert.deepEqual(harness.events, ['suppress:true', 'capture', 'suppress:false']);
  const after = takeoverOverlayState({ doc: harness.doc, win: harness.win });
  assert.equal(after.visibility, 'visible');
});

test('24d：内容脚本传输异常不阻塞截图，恢复仍执行', async () => {
  const harness = createHarness({ suppressReply: 'throw' });
  const result = await harness.service.takeScreenshot({ tabId: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.overlaySuppressed, false);
  assert.deepEqual(harness.events, ['suppress:true', 'capture', 'suppress:false']);
});

test('24d：页面没有浮层时抑制是 no-op（不产生额外副作用）', async () => {
  const harness = createHarness({ withOverlay: false });
  const result = await harness.service.takeScreenshot({ tabId: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.overlaySuppressed, true, '内容脚本确认 no-op 也算成功回包');
  // 仍然走 hide/restore 两跳（内容脚本侧判断有没有浮层）
  assert.deepEqual(harness.calls.map((call) => call.op), ['overlay-suppress', 'overlay-suppress']);
  assert.deepEqual(harness.calls.map((call) => call.params.hidden), [true, false]);
});

test('24d：截图本身失败时恢复也必须执行（finally 保证）', async () => {
  const harness = createHarness({ failCapture: true });
  await assert.rejects(() => harness.service.takeScreenshot({ tabId: 7 }), /截图失败|E_CAPTURE_FAILED/);
  assert.deepEqual(harness.events, ['suppress:true', 'capture', 'suppress:false']);
  const after = takeoverOverlayState({ doc: harness.doc, win: harness.win });
  assert.equal(after.visibility, 'visible', '失败路径不能把浮层留在隐藏状态');
});
