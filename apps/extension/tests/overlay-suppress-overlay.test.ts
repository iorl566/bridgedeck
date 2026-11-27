// tests/overlay-suppress-overlay.test.ts —— 接管浮层（24d）单测：fake DOM。
//
// 覆盖：
// - closed shadow host 的注入/固定 id/data-bb-ui 标记；
// - 可见性三态：attached / wantedVisible / suppressed（含 getComputedStyle 语义）；
// - 截图抑制的 hide → restore 幂等与 best-effort（没有 host 时不报错）；
// - 内容脚本 op handler（visible/hidden/只读）参数分派。
//
// 用最小假 DOM（不新增 jsdom 依赖）：只实现本模块用到的 DOM 形状，断言的是我们自己的
// 浮层层逻辑而不是 DOM 规范。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TAKEOVER_OVERLAY_HOST_ID,
  TAKEOVER_OVERLAY_UI,
  TAKEOVER_SUPPRESS_OP,
  handleTakeoverOverlayOp,
  installTakeoverOverlay,
  removeTakeoverOverlay,
  setTakeoverVisible,
  suppressTakeoverOverlay,
  takeoverOverlayState,
} from '../src/content/takeover-overlay.ts';

class FakeStyle {
  cssText = '';
  visibility = '';
  display = '';
  setProperty(name: string, value: string, _priority?: string): void {
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
  shadowMode = '';
  shadow: FakeShadowRoot | null = null;
  private text = '';

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = String(value);
    // 真 DOM 的 textContent 赋值会替换所有子节点；fake 也清掉，避免残留节点被 getElementById 找到。
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

  attachShadow(init: { mode: 'open' | 'closed' }): FakeShadowRoot {
    this.shadowMode = init.mode;
    this.shadow = new FakeShadowRoot(this);
    return this.shadow;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    walk(this, (element) => {
      if (element !== this && matches(element, selector)) out.push(element);
    });
    return out;
  }
}

class FakeShadowRoot {
  readonly host: FakeElement;
  readonly children: FakeElement[] = [];
  readonly mode = 'closed';

  constructor(host: FakeElement) {
    this.host = host;
  }

  appendChild<T extends FakeElement>(child: T): T {
    this.children.push(child);
    return child;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      if (matches(child, selector)) out.push(child);
      walk(child, (element) => {
        if (matches(element, selector)) out.push(element);
      });
    }
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function walk(root: FakeElement, visit: (element: FakeElement) => void): void {
  for (const child of root.children) {
    visit(child);
    walk(child, visit);
  }
}

function matches(element: FakeElement, selector: string): boolean {
  const text = String(selector ?? '').trim();
  if (!text) return false;
  if (text.startsWith('[') && text.endsWith(']')) {
    const body = text.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) return element.hasAttribute(body);
    const name = body.slice(0, eq);
    const wanted = body.slice(eq + 1).replace(/^['"]|['"]$/g, '');
    return element.getAttribute(name) === wanted;
  }
  if (text.startsWith('#')) return element.id === text.slice(1);
  return element.tagName === text.toUpperCase();
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

  getElementById(id: string): FakeElement | null {
    let found: FakeElement | null = null;
    walk(this.documentElement, (element) => {
      if (!found && element.id === id) found = element;
    });
    if (!found && this.documentElement.id === id) found = this.documentElement;
    return found;
  }

  querySelector(selector: string): FakeElement | null {
    if (matches(this.documentElement, selector)) return this.documentElement;
    let found: FakeElement | null = null;
    walk(this.documentElement, (element) => {
      if (!found && matches(element, selector)) found = element;
    });
    return found;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    if (matches(this.documentElement, selector)) out.push(this.documentElement);
    walk(this.documentElement, (element) => {
      if (matches(element, selector)) out.push(element);
    });
    return out;
  }
}

interface FakeWindowLike {
  getComputedStyle(element: FakeElement): { visibility: string; display: string };
}

function createFakeDom(): { doc: Document; win: Window; raw: FakeDocument } {
  const raw = new FakeDocument();
  const win: FakeWindowLike = {
    getComputedStyle(element: FakeElement) {
      return {
        // 真浏览器里 visibility 默认 visible（与父级无关时）；display 默认 block。
        visibility: element.style.visibility || 'visible',
        display: element.style.display || 'block',
      };
    },
  };
  return {
    doc: raw as unknown as Document,
    win: win as unknown as Window,
    raw,
  };
}

function hostOf(raw: FakeDocument): FakeElement | null {
  return raw.getElementById(TAKEOVER_OVERLAY_HOST_ID) as unknown as FakeElement | null;
}

test('takeover 浮层：注入 closed shadow host 且带固定 id/data-bb-ui 标记', () => {
  const { doc, win, raw } = createFakeDom();
  const state = installTakeoverOverlay({ doc, win });
  const host = hostOf(raw);
  assert.ok(host, 'host 应挂到 documentElement 上');
  assert.equal(state.ok, true);
  assert.equal(state.hostId, '__bb_takeover_host');
  assert.equal(state.dataBbUi, 'takeover');
  assert.equal(host.getAttribute('data-bb-ui'), TAKEOVER_OVERLAY_UI);
  assert.equal(host.hasAttribute('data-bb-overlay'), true);
  assert.equal(host.shadowMode, 'closed', 'shadow 必须是 closed（页面脚本看不到卡片内部）');
  assert.ok(host.shadow, '应真实创建 shadow root');
  assert.equal(host.shadow.children.some((child) => child.tagName === 'DIV'), true);
  assert.equal(state.attached, true);
  assert.equal(state.visible, true);
  assert.equal(state.suppressed, false);
  assert.equal(state.cardRendered, true);
  // computed visibility 语义：默认 visible（E2E 24d 的判据）
  assert.equal(state.visibility, 'visible');
});

test('takeover 浮层：visible=false 先登记不显示、再切换可见', () => {
  const { doc, win, raw } = createFakeDom();
  const installed = installTakeoverOverlay({ doc, win, visible: false });
  assert.equal(installed.attached, true);
  assert.equal(installed.visible, false);
  assert.equal(installed.display, 'none');
  const shown = setTakeoverVisible(true, { doc, win });
  assert.equal(shown.visible, true);
  assert.notEqual(shown.display, 'none');
  const hidden = setTakeoverVisible(false, { doc, win });
  assert.equal(hidden.attached, false);
  assert.equal(hidden.visible, false);
  assert.equal(hostOf(raw), null, 'visible=false 时 host 从 DOM 移除');
});

test('takeover 浮层：截图抑制隐藏 → 恢复（visibility 语义、host 保留）', () => {
  const { doc, win, raw } = createFakeDom();
  installTakeoverOverlay({ doc, win });
  const hidden = suppressTakeoverOverlay(true, { doc, win });
  assert.equal(hidden.attached, true);
  assert.equal(hidden.suppressed, true);
  assert.equal(hidden.visible, false);
  assert.equal(hidden.visibility, 'hidden');
  assert.ok(hostOf(raw), '抑制只改 visibility，不卸载 host');
  const restored = suppressTakeoverOverlay(false, { doc, win });
  assert.equal(restored.suppressed, false);
  assert.equal(restored.visible, true);
  assert.equal(restored.visibility, 'visible');
});

test('takeover 浮层：抑制幂等（重复 hide / 重复 restore 不出错）', () => {
  const { doc, win, raw } = createFakeDom();
  installTakeoverOverlay({ doc, win });
  suppressTakeoverOverlay(true, { doc, win });
  suppressTakeoverOverlay(true, { doc, win });
  const host = hostOf(raw);
  assert.equal(host?.style.visibility, 'hidden');
  suppressTakeoverOverlay(false, { doc, win });
  assert.equal(host?.style.visibility, '');
  const again = suppressTakeoverOverlay(false, { doc, win });
  assert.equal(again.visibility, 'visible');
});

test('takeover 浮层：没有浮层时抑制/恢复是 no-op（best-effort，不抛错）', () => {
  const { doc, win } = createFakeDom();
  const hidden = suppressTakeoverOverlay(true, { doc, win });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.attached, false);
  assert.equal(hidden.suppressed, false);
  const restored = suppressTakeoverOverlay(false, { doc, win });
  assert.equal(restored.ok, true);
  assert.equal(restored.attached, false);
});

test('takeover 浮层：op handler 按 visible/hidden 分派，空参数只读', () => {
  const { doc, win, raw } = createFakeDom();
  // hidden:false 在未安装时是 no-op（截图恢复语义）
  const noop = handleTakeoverOverlayOp({ hidden: false }, { doc, win });
  assert.equal(noop.attached, false);
  // visible:true 安装
  const shown = handleTakeoverOverlayOp({ visible: true }, { doc, win });
  assert.equal(shown.attached, true);
  assert.equal(shown.visible, true);
  // hidden:true 抑制
  const hidden = handleTakeoverOverlayOp({ hidden: true }, { doc, win });
  assert.equal(hidden.visibility, 'hidden');
  // 只读状态
  const state = handleTakeoverOverlayOp({}, { doc, win });
  assert.equal(state.attached, true);
  assert.equal(state.suppressed, true);
  // visible:false 卸载
  const gone = handleTakeoverOverlayOp({ visible: false }, { doc, win });
  assert.equal(gone.attached, false);
  assert.equal(hostOf(raw), null);
  assert.equal(TAKEOVER_SUPPRESS_OP, 'overlay-suppress');
});

test('takeover 浮层：remove 与状态查询幂等', () => {
  const { doc, win, raw } = createFakeDom();
  installTakeoverOverlay({ doc, win });
  removeTakeoverOverlay({ doc, win });
  assert.equal(hostOf(raw), null);
  const state = takeoverOverlayState({ doc, win });
  assert.equal(state.attached, false);
  assert.equal(state.visible, false);
  // 再 remove 一次不抛错
  assert.equal(removeTakeoverOverlay({ doc, win }).attached, false);
});
