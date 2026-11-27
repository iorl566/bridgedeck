// tests/record-overlay.test.ts —— 录制浮层（closed shadow host __bb_record_host 出现/移除/结束按钮）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installRecordOverlay, removeRecordOverlay } from '../src/content/record-overlay.ts';

interface FakeEvent {
  type: string;
  key?: string;
  preventDefault(): void;
}

class FakeShadow {
  readonly mode: 'open' | 'closed';
  readonly children: FakeNode[] = [];

  constructor(mode: 'open' | 'closed') {
    this.mode = mode;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.children.push(node);
  }
}

class FakeNode {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly children: FakeNode[] = [];
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  id = '';
  className = '';
  textContent = '';
  dir = '';
  style: { cssText: string } = { cssText: '' };
  parent: FakeNode | null = null;
  isConnected = true;
  shadowRoot: FakeShadow | null = null;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'dir') this.dir = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name) ?? null : null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.textContent += node;
        continue;
      }
      node.parent = this;
      this.children.push(node);
    }
  }

  appendChild<T extends FakeNode>(node: T): T {
    this.append(node);
    return node;
  }

  attachShadow(init: { mode: 'open' | 'closed' }): FakeShadow {
    if (this.shadowRoot) throw new Error('shadow already attached');
    this.shadowRoot = new FakeShadow(init.mode);
    return this.shadowRoot;
  }

  remove(): void {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = null;
    }
    this.isConnected = false;
  }

  addEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatch(type: string, extra: Partial<FakeEvent> = {}): void {
    const event: FakeEvent = {
      type,
      key: extra.key,
      preventDefault: () => undefined,
    };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  contains(candidate: FakeNode | null): boolean {
    let node = candidate;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
}

class FakeDocument {
  readonly documentElement = new FakeNode('html');
  createElement(tag: string): FakeNode {
    return new FakeNode(tag);
  }

  getElementById(id: string): FakeNode | null {
    const walk = (node: FakeNode): FakeNode | null => {
      for (const child of node.children) {
        if (child.id === id) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this.documentElement);
  }
}

interface FakeHarness {
  document: FakeDocument;
  sent: unknown[];
}

function withFakeDom(run: (harness: FakeHarness) => void): void {
  const document = new FakeDocument();
  const sent: unknown[] = [];
  const globals = globalThis as unknown as {
    document?: unknown;
    window?: unknown;
    chrome?: unknown;
    __bbRecordOverlayTimer?: unknown;
  };
  const previous = { document: globals.document, window: globals.window, chrome: globals.chrome };
  globals.document = document as unknown as Document;
  globals.window = { matchMedia: () => ({ matches: false }) } as unknown as Window;
  globals.chrome = {
    runtime: {
      sendMessage: (message: unknown) => {
        sent.push(message);
        return undefined;
      },
    },
  };
  try {
    run({ document, sent });
  } finally {
    // 断言失败时也要清掉浮层定时器，避免 Node 测试进程被 interval 挂住。
    const timer = (globalThis as unknown as { __bbRecordOverlayTimer?: ReturnType<typeof setInterval> }).__bbRecordOverlayTimer;
    if (timer) clearInterval(timer);
    globals.document = previous.document;
    globals.window = previous.window;
    globals.chrome = previous.chrome;
    globals.__bbRecordOverlayTimer = undefined;
  }
}

test('installRecordOverlay：closed shadow host 出现，带 id/role/胶囊/结束按钮', () => {
  withFakeDom(({ document }) => {
    const result = installRecordOverlay(Date.now(), 'zh');
    assert.equal(result.ok, true);
    const host = document.getElementById('__bb_record_host');
    assert.ok(host, 'host 必须出现在文档里（E2E 24c 用 HTML 里的 id 判定）');
    assert.equal(host.attrs.get('role'), 'status');
    assert.equal(host.attrs.get('aria-live'), 'polite');
    assert.equal(host.attrs.get('aria-keyshortcuts'), 'Escape');
    assert.equal(host.attrs.get('dir'), 'ltr');
    assert.equal(host.style.cssText.includes('position:fixed'), true);
    const shadow = host.shadowRoot;
    assert.ok(shadow, '宿主必须挂 shadow root');
    assert.equal(shadow.mode, 'closed', '浮层必须用 closed shadow（不泄漏给页面）');
    assert.equal(shadow.children.length, 2, 'style + 胶囊');
    const pill = shadow.children[1];
    assert.ok(pill);
    assert.equal(pill.className, 'bb-pill');
    const button = pill.children.find((child) => child.tagName === 'BUTTON');
    assert.ok(button, '必须有关闭按钮');
    assert.equal(button.textContent, '结束');
    const time = pill.children.find((child) => child.className === 'bb-time');
    assert.equal(time?.textContent, '00:00');
    removeRecordOverlay();
  });
});

test('removeRecordOverlay：host 移除、定时器清理、重复移除返回 false', () => {
  withFakeDom(({ document }) => {
    installRecordOverlay(1_700_000_000_000, 'en');
    const host = document.getElementById('__bb_record_host');
    assert.ok(host);
    assert.equal(removeRecordOverlay(), true);
    assert.equal(document.getElementById('__bb_record_host'), null, 'stop 后浮层必须消失（E2E 24c）');
    assert.equal(host.isConnected, false);
    assert.equal((globalThis as unknown as { __bbRecordOverlayTimer?: unknown }).__bbRecordOverlayTimer, undefined, '定时器必须清理');
    assert.equal(removeRecordOverlay(), false);
  });
});

test('结束按钮点击：移除浮层并向 background 发 bb.record.finish', () => {
  withFakeDom(({ document, sent }) => {
    installRecordOverlay(undefined, 'zh');
    const host = document.getElementById('__bb_record_host');
    const pill = host?.shadowRoot?.children[1];
    const button = pill?.children.find((child) => child.tagName === 'BUTTON');
    assert.ok(button);
    button.dispatch('click');
    assert.equal(document.getElementById('__bb_record_host'), null);
    assert.deepEqual(sent, [{ type: 'bb.record.finish' }]);
  });
});

test('Esc 结束：胶囊 keydown Escape 移除浮层', () => {
  withFakeDom(({ document, sent }) => {
    installRecordOverlay(undefined, 'zh');
    const host = document.getElementById('__bb_record_host');
    const pill = host?.shadowRoot?.children[1];
    assert.ok(pill);
    pill.dispatch('keydown', { key: 'Escape' });
    assert.equal(document.getElementById('__bb_record_host'), null);
    assert.equal(sent.length, 1);
  });
});

test('重复注入只保留一个 host；RTL 语言与深色主题标记生效', () => {
  withFakeDom(({ document }) => {
    installRecordOverlay(1, 'zh');
    installRecordOverlay(2, 'ar', 'dark');
    const host = document.getElementById('__bb_record_host');
    assert.ok(host);
    const hosts = document.documentElement.children.filter((child) => child.id === '__bb_record_host');
    assert.equal(hosts.length, 1, '重复注入必须先移除旧 host');
    assert.equal(host.attrs.get('dir'), 'rtl');
    assert.equal(host.attrs.get('data-bb-theme'), 'dark');
    removeRecordOverlay();
  });
});

test('无 DOM 环境（Node 单测/后台上下文）安装返回结构化失败而不是抛错', () => {
  const result = installRecordOverlay(1, 'zh');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-dom');
});
