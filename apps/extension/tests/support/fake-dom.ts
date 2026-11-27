// tests/support/fake-dom.ts —— 内容脚本单测用的最小 DOM（不引入 jsdom 依赖）。
//
// 只实现 dom.ts 真正用到的形状：树遍历用平面 querySelectorAll('*')，选择器支持
// `*` / 逗号列表 / `#id` / `tag` / `#id tag` / `[attr]`；elementFromPoint 可由用例注入。
// 这不是浏览器实现，断言的是“我们的动作逻辑”而不是 DOM 规范。

import type {
  DocumentLike,
  DomEnvironment,
  DomRectLike,
  ElementLike,
  StyleLike,
  WindowLike,
} from '../../src/content/dom.ts';

export interface FakeElementSpec {
  tag: string;
  id?: string;
  attrs?: Record<string, string>;
  text?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  type?: string;
  style?: StyleLike;
  rect?: Partial<DomRectLike>;
  clickable?: boolean;
  /** 滚动高度（affordance scrollable 事实用；缺省 = 视口高度，不滚动）。 */
  scrollHeight?: number;
  children?: FakeElementSpec[];
}

interface FakeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export class FakeElement implements ElementLike {
  readonly tagName: string;
  readonly attrs: Map<string, string>;
  textContent: string;
  innerHTML = '';
  value: string | undefined;
  checked: boolean | undefined;
  disabled: boolean | undefined;
  type: string | undefined;
  id: string;
  isConnected = true;
  style: StyleLike;
  rect: FakeRect;
  scrollHeight: number;
  clicked = 0;
  focused = 0;
  scrolled = 0;
  readonly events: string[] = [];
  readonly parent: FakeElement | null;
  readonly children: FakeElement[] = [];

  constructor(spec: FakeElementSpec, parent: FakeElement | null = null) {
    this.tagName = spec.tag.toUpperCase();
    this.attrs = new Map(Object.entries(spec.attrs ?? {}));
    this.textContent = spec.text ?? '';
    this.id = spec.id ?? this.attrs.get('id') ?? '';
    if (this.id) this.attrs.set('id', this.id);
    this.value = spec.value;
    this.checked = spec.checked;
    this.disabled = spec.disabled;
    this.type = spec.type;
    if (spec.type) this.attrs.set('type', spec.type);
    this.style = spec.style ?? {};
    this.rect = {
      left: spec.rect?.left ?? 10,
      top: spec.rect?.top ?? 10,
      width: spec.rect?.width ?? 100,
      height: spec.rect?.height ?? 30,
    };
    this.scrollHeight = spec.scrollHeight ?? this.rect.height;
    this.parent = parent;
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name) ?? null : null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  getBoundingClientRect(): DomRectLike {
    return { ...this.rect };
  }

  contains(other: ElementLike | null | undefined): boolean {
    let current = other as FakeElement | null | undefined;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }

  closest(selector: string): ElementLike | null {
    let current: FakeElement | null = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parent;
    }
    return null;
  }

  querySelector(selector: string): ElementLike | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ElementLike[] {
    const out: FakeElement[] = [];
    const tokens = String(selector ?? '').split(',').map((token) => token.trim()).filter(Boolean);
    walk(this, (element) => {
      for (const token of tokens) {
        if (matchesSelector(element, token)) {
          out.push(element);
          break;
        }
      }
    });
    return out;
  }

  get parentElement(): FakeElement | null {
    return this.parent;
  }

  scrollIntoView(): void {
    this.scrolled += 1;
  }

  focus(): void {
    this.focused += 1;
  }

  click(): void {
    this.clicked += 1;
  }

  dispatchEvent(event: unknown): boolean {
    const type = (event as { type?: string } | null)?.type ?? 'unknown';
    this.events.push(type);
    return true;
  }
}

function walk(root: FakeElement, visit: (element: FakeElement) => void): void {
  for (const child of root.children) {
    visit(child);
    walk(child, visit);
  }
}

function tagMatches(element: FakeElement, token: string): boolean {
  if (token === '*') return true;
  let tag = token;
  let id: string | null = null;
  const hashIndex = token.indexOf('#');
  if (hashIndex >= 0) {
    tag = token.slice(0, hashIndex);
    id = token.slice(hashIndex + 1);
  }
  if (tag && tag.toUpperCase() !== element.tagName) return false;
  if (id !== null && element.id !== id) return false;
  return true;
}

export function matchesSelector(element: FakeElement, selector: string): boolean {
  const text = String(selector ?? '').trim();
  if (!text) return false;
  if (text.startsWith('[') && text.endsWith(']')) {
    const attr = text.slice(1, -1);
    const eq = attr.indexOf('=');
    if (eq >= 0) return element.getAttribute(attr.slice(0, eq)) === attr.slice(eq + 1).replace(/^['"]|['"]$/g, '');
    return element.hasAttribute(attr);
  }
  // 后代选择器：`#root tag` / `tag#id` 之外只支持最后一个简单选择器。
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    const target = parts[parts.length - 1];
    if (!target) return false;
    let matched = tagMatches(element, target);
    if (!matched) return false;
    const ancestors = parts.slice(0, -1);
    let current: FakeElement | null = element.parent;
    let remaining = [...ancestors].reverse();
    while (current && remaining.length > 0) {
      const selectorPart = remaining[0] ?? '';
      if (tagMatches(current, selectorPart)) remaining = remaining.slice(1);
      current = current.parent;
    }
    return remaining.length === 0;
  }
  return tagMatches(element, text);
}

export class FakeDocument implements DocumentLike {
  title: string;
  URL: string;
  body: FakeElement | null = null;
  documentElement: FakeElement | null = null;
  readonly all: FakeElement[] = [];
  hitTest: ((x: number, y: number) => ElementLike | null) | null = null;

  constructor(options: { title?: string; url?: string } = {}) {
    this.title = options.title ?? '';
    this.URL = options.url ?? 'https://example.test/';
  }

  elementFromPoint(x: number, y: number): ElementLike | null {
    if (this.hitTest) return this.hitTest(x, y);
    // 默认：文档顺序里最后一个“点落进矩形”的元素（近似最上层）；根元素不参与命中。
    let found: FakeElement | null = null;
    for (const element of this.all) {
      if (element.tagName === 'HTML' || element.tagName === 'BODY') continue;
      if (element.style.display === 'none') continue;
      const { left, top, width, height } = element.rect;
      if (x >= left && x <= left + width && y >= top && y <= top + height) found = element;
    }
    return found;
  }

  createElement(tag: string): ElementLike {
    return new FakeElement({ tag });
  }

  getElementById(id: string): ElementLike | null {
    return this.all.find((element) => element.id === id) ?? null;
  }

  querySelector(selector: string): ElementLike | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ElementLike[] {
    const out: FakeElement[] = [];
    for (const element of this.all) {
      for (const token of String(selector ?? '').split(',')) {
        if (matchesSelector(element, token)) {
          out.push(element);
          break;
        }
      }
    }
    return out;
  }
}

export interface FakeDom {
  env: DomEnvironment;
  document: FakeDocument;
  window: WindowLike;
  byId: Map<string, FakeElement>;
  events: Array<{ type: string; init: Record<string, unknown> }>;
  setValues: Array<{ element: FakeElement; value: string }>;
  allElements(): FakeElement[];
}

function buildTree(spec: FakeElementSpec, parent: FakeElement | null, doc: FakeDocument): FakeElement {
  const element = new FakeElement(spec, parent);
  doc.all.push(element);
  for (const child of spec.children ?? []) {
    element.children.push(buildTree(child, element, doc));
  }
  if (element.tagName === 'BODY' && !doc.body) doc.body = element;
  return element;
}

/** 按 spec 建一个假文档；`elements` 是 body 的子节点。 */
export function createFakeDom(elements: FakeElementSpec[], options: { title?: string; url?: string; hitTest?: (x: number, y: number) => ElementLike | null } = {}): FakeDom {
  const doc = new FakeDocument({ title: options.title, url: options.url });
  const bodySpec: FakeElementSpec = { tag: 'body', children: elements };
  const html = new FakeElement({ tag: 'html' }, null);
  doc.all.push(html);
  doc.documentElement = html;
  const body = buildTree({ ...bodySpec, tag: 'body' }, html, doc);
  html.children.push(body);
  doc.body = body;
  const byId = new Map<string, FakeElement>();
  for (const element of doc.all) if (element.id) byId.set(element.id, element);
  (doc as unknown as { byId: Map<string, FakeElement> }).byId = byId;
  if (options.hitTest) doc.hitTest = options.hitTest;
  const events: FakeDom['events'] = [];
  const setValues: FakeDom['setValues'] = [];
  const env: DomEnvironment = {
    document: doc,
    window: {
      getComputedStyle: (element) => (element as FakeElement).style ?? {},
      innerWidth: 1280,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
    },
    setValue: (element, value) => {
      const fake = element as FakeElement;
      fake.value = value;
      setValues.push({ element: fake, value });
    },
    createEvent: (type, init) => {
      events.push({ type, init });
      return { type, ...init };
    },
  };
  return {
    env,
    document: doc,
    window: env.window,
    byId,
    events,
    setValues,
    allElements: () => [...doc.all],
  };
}

/** 常用 fixture：标题 + 输入框 + 按钮 + 隐藏文本（E2E 夹具页的最小影子）。 */
export function fixtureElements(): FakeElementSpec[] {
  return [
    { tag: 'h1', text: 'E2E 夹具页', rect: { left: 0, top: 0, width: 600, height: 40 } },
    {
      tag: 'form',
      id: 'demo-form',
      rect: { left: 0, top: 40, width: 600, height: 260 },
      children: [
        {
          tag: 'div',
          rect: { left: 0, top: 50, width: 600, height: 40 },
          children: [
            { tag: 'label', text: '关键词', rect: { left: 0, top: 55, width: 60, height: 20 } },
            {
              tag: 'input',
              id: 'kw',
              type: 'text',
              attrs: { 'aria-label': '搜索关键词', placeholder: '输入关键词' },
              value: '',
              rect: { left: 70, top: 55, width: 200, height: 28 },
            },
          ],
        },
        {
          tag: 'div',
          rect: { left: 0, top: 100, width: 600, height: 40 },
          children: [
            {
              tag: 'select',
              id: 'kind',
              attrs: { 'aria-label': '类型' },
              rect: { left: 70, top: 105, width: 120, height: 28 },
              children: [
                { tag: 'option', attrs: { value: 'a' }, text: '甲' },
                { tag: 'option', attrs: { value: 'b' }, text: '乙' },
              ],
            },
          ],
        },
        { tag: 'input', id: 'agree', type: 'checkbox', attrs: { 'aria-label': '同意条款' }, checked: false, rect: { left: 70, top: 145, width: 20, height: 20 } },
        { tag: 'button', id: 'submit-btn', type: 'button', text: '提交查询', rect: { left: 70, top: 180, width: 120, height: 32 } },
      ],
    },
    { tag: 'p', rect: { left: 0, top: 320, width: 600, height: 30 }, children: [{ tag: 'strong', id: 'out', text: '未提交', rect: { left: 30, top: 322, width: 80, height: 20 } }] },
    { tag: 'div', id: 'hidden-box', style: { display: 'none' }, text: '默认不可见的文本', rect: { left: 0, top: 400, width: 200, height: 20 } },
  ];
}
