// tests/coop-human-watch.test.ts —— 页面侧人工协作代理单测（human-watch + 协助卡片 + 完成条件）。
//
// 不引入 jsdom：用本文件里的最小 fake DOM（createElement/appendChild/attachShadow/事件派发），
// 断言的是“我们的协作语义”，不是 DOM 规范：
// - 只有 isTrusted === true 的页面输入才算人工操作；
// - Agent 可信输入标记窗口内的事件必须被忽略；
// - 协助卡片是 closed shadow DOM 宿主（id=__bb_help_host），点“完成并交还控制权”后
//   页面侧状态 = done、卡片移除、并回传 bb.help.resolved；
// - 完成条件 / 目标测量的判定口径。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HELP_HOST_ID,
  checkHelpCriteria,
  hideHelpOverlay,
  installHumanWatch,
  markAgentInput,
  measureTarget,
  readHelpState,
  readHumanActivity,
  showHelpOverlay,
} from '../src/content/cooperation.ts';

type Listener = (event: unknown) => void;

interface FakeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

class FakeElement {
  readonly tagName: string;
  id = '';
  readonly attrs = new Map<string, string>();
  textContent = '';
  innerText = '';
  value = '';
  readonly style: Record<string, unknown> = {};
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  isConnected = true;
  shadowRoot: FakeShadowRoot | null = null;
  /** 真实浏览器里 closed shadow root 只在 attachShadow 调用方手里；这里单独留一份给测试。 */
  shadowInternal: FakeShadowRoot | null = null;
  rect: FakeRect | null = null;
  readonly listeners = new Map<string, Listener[]>();
  readonly doc: FakeDocument;

  constructor(tag: string, doc: FakeDocument) {
    this.tagName = tag.toUpperCase();
    this.doc = doc;
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

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    child.isConnected = true;
    this.children.push(child);
    this.doc.register(child);
    return child;
  }

  attachShadow(options: { mode: 'open' | 'closed' }): FakeShadowRoot {
    if (this.shadowInternal) throw new Error('shadow root already attached');
    const root = new FakeShadowRoot(this, this.doc, options.mode);
    this.shadowInternal = root;
    // closed shadow：宿主上的 shadowRoot 必须为 null（页面脚本拿不到）。
    this.shadowRoot = options.mode === 'open' ? root : null;
    return root;
  }

  remove(): void {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
    this.parent = null;
    this.isConnected = false;
    this.doc.unregister(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type: string, event: unknown = {}): void {
    const bag = event as Record<string, unknown>;
    if (bag.type === undefined) bag.type = type;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(bag);
  }

  click(): void {
    this.dispatch('click', { type: 'click', isTrusted: true, target: this });
  }

  matches(selector: string): boolean {
    const tokens = String(selector).split(',').map((token) => token.trim()).filter(Boolean);
    return tokens.some((token) => {
      if (token === 'input' || token === 'textarea' || token === 'select') return this.tagName === token.toUpperCase();
      if (token === '[contenteditable="true"]') return this.getAttribute('contenteditable') === 'true';
      return false;
    });
  }

  getBoundingClientRect(): FakeRect {
    return this.rect ?? { left: 10, top: 10, width: 100, height: 20 };
  }

  focus(): void {
    // 无真实焦点系统
  }
}

function matchesSimple(element: FakeElement, selector: string): boolean {
  const text = String(selector ?? '').trim();
  if (!text) return false;
  if (text.startsWith('#')) return element.id === text.slice(1);
  if (text.startsWith('.')) return String(element.getAttribute('class') || '').split(/\s+/).includes(text.slice(1));
  if (text.startsWith('[') && text.endsWith(']')) {
    const body = text.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) return element.hasAttribute(body);
    return element.getAttribute(body.slice(0, eq)) === body.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return element.tagName === text.toUpperCase();
}

class FakeShadowRoot {
  readonly host: FakeElement;
  readonly mode: 'open' | 'closed';
  readonly children: FakeElement[] = [];
  readonly doc: FakeDocument;
  activeElement: FakeElement | null = null;

  constructor(host: FakeElement, doc: FakeDocument, mode: 'open' | 'closed') {
    this.host = host;
    this.doc = doc;
    this.mode = mode;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = null;
    child.isConnected = true;
    this.children.push(child);
    this.doc.register(child);
    return child;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (element: FakeElement): void => {
      for (const child of element.children) {
        if (matchesSimple(child, selector)) out.push(child);
        walk(child);
      }
    };
    for (const child of this.children) {
      if (matchesSimple(child, selector)) out.push(child);
      walk(child);
    }
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  readonly nodes: FakeElement[] = [];
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  readonly listeners = new Map<string, Listener[]>();
  title = 'fake';
  URL = 'https://example.test/page';
  activeElement: FakeElement | null = null;

  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.body);
  }

  register(element: FakeElement): void {
    if (!this.nodes.includes(element)) this.nodes.push(element);
  }

  unregister(element: FakeElement): void {
    const index = this.nodes.indexOf(element);
    if (index >= 0) this.nodes.splice(index, 1);
    for (const child of element.children) this.unregister(child);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  getElementById(id: string): FakeElement | null {
    return this.nodes.find((element) => element.id === id) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.nodes.find((element) => matchesSimple(element, selector)) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.nodes.filter((element) => matchesSimple(element, selector));
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type: string, event: unknown = {}): void {
    const bag = event as Record<string, unknown>;
    if (bag.type === undefined) bag.type = type;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(bag);
  }
}

class FakeWindow {
  innerWidth = 1280;
  innerHeight = 800;
  readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type: string, event: unknown = {}): void {
    const bag = event as Record<string, unknown>;
    if (bag.type === undefined) bag.type = type;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(bag);
  }
}

interface Harness {
  doc: FakeDocument;
  win: FakeWindow;
  sent: Array<Record<string, unknown>>;
}

function installFakeEnvironment(): Harness {
  const doc = new FakeDocument();
  const win = new FakeWindow();
  const sent: Array<Record<string, unknown>> = [];
  const bag = globalThis as unknown as Record<string, unknown>;
  bag['document'] = doc;
  bag['window'] = win;
  bag['location'] = { href: 'https://example.test/page' };
  bag['getComputedStyle'] = (element: FakeElement) => ({
    display: element.style['display'],
    visibility: element.style['visibility'],
    opacity: element.style['opacity'],
  });
  bag['chrome'] = {
    runtime: {
      sendMessage: (message: unknown) => {
        sent.push(message as Record<string, unknown>);
        return Promise.resolve({ ok: true });
      },
    },
  };
  // 每个用例从干净页面状态开始（human-watch / 协助卡片状态都挂在 globalThis 上）。
  delete bag['__bbTsHumanWatch'];
  delete bag['__bbTsHelpState'];
  delete bag['__bbTsHelpRoots'];
  return { doc, win, sent };
}

function shadowOf(host: FakeElement): FakeShadowRoot {
  const roots = (globalThis as unknown as Record<string, unknown>)['__bbTsHelpRoots'] as
    | WeakMap<object, FakeShadowRoot>
    | undefined;
  assert.ok(roots, '协助卡片应把 closed shadow root 放进 __bbTsHelpRoots（诊断/单测钩子）');
  const root = roots.get(host);
  assert.ok(root, '协助卡片宿主应有关联 shadow root');
  return root;
}

// ---------------------------------------------------------------------------
// human-watch
// ---------------------------------------------------------------------------

test('coop human-watch：安装幂等，未安装时如实回 installed:false', () => {
  const { doc } = installFakeEnvironment();
  const before = readHumanActivity();
  assert.equal(before.installed, false);
  assert.equal(before.active, false);
  assert.equal(installHumanWatch(), true, '首次安装应成功');
  assert.equal(installHumanWatch(), false, '重复安装应幂等返回 false');
  const state = readHumanActivity();
  assert.equal(state.installed, true);
  assert.equal(state.active, false);
  assert.equal(state.inputClock, 0);
  assert.equal(doc.nodes.length > 0, true);
});

test('coop human-watch：isTrusted 的 pointerdown/keydown/input 才计入人工活动', () => {
  const { doc, sent } = installFakeEnvironment();
  installHumanWatch();
  const input = doc.createElement('input');
  input.setAttribute('type', 'text');
  input.setAttribute('aria-label', '搜索关键词');
  doc.body.appendChild(input);

  doc.dispatch('pointerdown', { isTrusted: false, target: input });
  assert.equal(readHumanActivity().inputClock, 0, 'isTrusted=false 的合成事件不能算人工');
  assert.equal(sent.length, 0);

  doc.dispatch('pointerdown', { isTrusted: true, target: input });
  const activity = sent.find((message) => message.type === 'bb.human.activity');
  assert.ok(activity, '真实输入应回传 bb.human.activity');
  assert.equal(activity.kind, 'pointerdown');
  assert.equal(activity.label, '搜索关键词');
  assert.equal(activity.editable, true);
  assert.equal(activity.sensitive, false);
  assert.equal(activity.inputClock, 1);
  assert.equal(typeof activity.at, 'number');

  const state = readHumanActivity();
  assert.equal(state.active, true);
  assert.equal(state.lastKind, 'pointerdown');

  doc.dispatch('keydown', { isTrusted: true, target: input });
  assert.equal(readHumanActivity().inputClock, 2);
});

test('coop human-watch：密码输入只标 sensitive，不读取值', () => {
  const { doc, sent } = installFakeEnvironment();
  installHumanWatch();
  const password = doc.createElement('input');
  password.setAttribute('type', 'password');
  password.setAttribute('autocomplete', 'current-password');
  password.setAttribute('name', 'pwd');
  password.value = '__secret__';
  doc.body.appendChild(password);
  doc.dispatch('input', { isTrusted: true, target: password });
  const activity = sent.find((message) => message.type === 'bb.human.activity');
  assert.ok(activity);
  assert.equal(activity.sensitive, true);
  assert.equal(activity.label, 'pwd');
  assert.equal('value' in activity, false, 'human-watch 不应回传表单值');
  assert.equal(JSON.stringify(activity).includes('__secret__'), false);
});

test('coop human-watch：Agent 可信输入标记窗口内忽略事件（避免误判人工接管）', () => {
  const { doc, sent } = installFakeEnvironment();
  installHumanWatch();
  const button = doc.createElement('button');
  button.textContent = '提交查询';
  doc.body.appendChild(button);

  const marker = markAgentInput();
  assert.equal(typeof marker, 'number');
  assert.equal(marker > 0, true);
  assert.equal(doc.documentElement.getAttribute('data-bb-agent-input'), String(marker));

  doc.dispatch('click', { isTrusted: true, target: button });
  assert.equal(readHumanActivity().inputClock, 0, 'Agent 可信输入窗口内的事件不算人工');
  assert.equal(sent.length, 0);
});

test('coop human-watch：窗口失焦回传 bb.human.blur 并清活动标记', () => {
  const { doc, win, sent } = installFakeEnvironment();
  installHumanWatch();
  const input = doc.createElement('input');
  doc.body.appendChild(input);
  doc.dispatch('pointerdown', { isTrusted: true, target: input });
  assert.equal(readHumanActivity().active, true);

  // 静默一段时间后失焦：活动标记清零（页面内焦点切换不会清，故先拨旧时间戳）。
  const bag = globalThis as unknown as Record<string, unknown>;
  const watch = bag['__bbTsHumanWatch'] as Record<string, unknown>;
  watch['lastInputAt'] = Date.now() - 2_000;
  win.dispatch('blur', { type: 'blur' });
  assert.equal(sent.some((message) => message.type === 'bb.human.blur'), true);
  assert.equal(readHumanActivity().active, false);
  assert.equal(readHumanActivity().lastInputAt, 0);
});

// ---------------------------------------------------------------------------
// 人工协助卡片
// ---------------------------------------------------------------------------

test('coop help：卡片出现（closed shadow 宿主）→ 点完成并交还 → done + 移除', () => {
  const { doc, sent } = installFakeEnvironment();
  const shown = showHelpOverlay({
    requestId: 'help_1',
    reason: '请确认页面上的登录状态',
    title: '',
    targetRect: { x: 20, y: 30, width: 120, height: 32, viewport: { width: 1280, height: 800 } },
  });
  assert.equal(shown.ok, true);
  assert.equal(shown.requestId, 'help_1');
  assert.equal(shown.highlight, true);

  const host = doc.getElementById(HELP_HOST_ID) as FakeElement | null;
  assert.ok(host, '协助卡片宿主应出现在页面里');
  assert.equal(host.getAttribute('data-bb-ui'), 'help');
  assert.equal(host.shadowRoot, null, 'closed shadow：页面拿不到 shadowRoot');
  assert.ok(doc.getElementById('__bb_help_highlight'), '目标高亮层应存在');

  const shadow = shadowOf(host);
  const done = shadow.querySelector('[data-act="done"]') as FakeElement | null;
  assert.ok(done, '卡片应有“完成并交还控制权”按钮');
  assert.equal(done.textContent, '完成并交还控制权');
  const cancel = shadow.querySelector('[data-act="cancel"]') as FakeElement | null;
  assert.ok(cancel);
  assert.equal(cancel.textContent, '取消请求');
  const note = shadow.querySelector('.note') as FakeElement | null;
  assert.ok(note, '卡片应有备注输入框');

  done.click();
  assert.equal(doc.getElementById(HELP_HOST_ID), null, '点击后卡片应移除');
  assert.equal(doc.getElementById('__bb_help_highlight'), null, '点击后高亮应移除');
  const resolved = sent.find((message) => message.type === 'bb.help.resolved');
  assert.ok(resolved, '应回传 bb.help.resolved');
  assert.equal(resolved.requestId, 'help_1');
  assert.equal(resolved.action, 'done');
  assert.equal(resolved.note, '');

  const pageState = readHelpState();
  assert.ok(pageState);
  assert.equal(pageState.action, 'done');
  assert.equal(pageState.requestId, 'help_1');
  assert.equal(pageState.attached, false);
});

test('coop help：取消请求 → skip；备注随决定回传', () => {
  const { doc, sent } = installFakeEnvironment();
  showHelpOverlay({ requestId: 'help_2', reason: '需要登录' });
  const host = doc.getElementById(HELP_HOST_ID) as FakeElement;
  const shadow = shadowOf(host);
  const note = shadow.querySelector('.note') as FakeElement;
  note.value = '已经登录好了';
  (shadow.querySelector('[data-act="cancel"]') as FakeElement).click();
  const resolved = sent.find((message) => message.type === 'bb.help.resolved');
  assert.ok(resolved);
  assert.equal(resolved.action, 'skip');
  assert.equal(resolved.note, '已经登录好了');
  const pageState = readHelpState();
  assert.equal(pageState?.action, 'skip');
});

test('coop help：hideHelpOverlay 幂等清理宿主/高亮/页面侧决定', () => {
  const { doc } = installFakeEnvironment();
  assert.equal(hideHelpOverlay(), false, '没有卡片时清理应返回 false');
  showHelpOverlay({ requestId: 'help_3', reason: '等待页面条件' });
  assert.ok(doc.getElementById(HELP_HOST_ID));
  assert.equal(hideHelpOverlay(), true);
  assert.equal(doc.getElementById(HELP_HOST_ID), null);
  assert.equal(readHelpState(), null, '清理后不应残留上次的 requestId 决定');
});

// ---------------------------------------------------------------------------
// 完成条件 / 目标测量
// ---------------------------------------------------------------------------

test('coop criteria：selector_exists / selector_visible / text_exists / url_contains', () => {
  const { doc } = installFakeEnvironment();
  const card = doc.createElement('div');
  card.setAttribute('class', 'login-ok');
  card.textContent = '登录成功';
  doc.body.appendChild(card);
  doc.body.innerText = '欢迎回来，页面已登录成功';

  const exists = checkHelpCriteria([{ kind: 'selector_exists', selector: '.login-ok' }]);
  assert.equal(exists.ok, true);
  assert.equal(exists.checks[0]?.kind, 'selector_exists');

  const visible = checkHelpCriteria([{ kind: 'selector_visible', selector: '.login-ok' }]);
  assert.equal(visible.ok, true);
  card.style['display'] = 'none';
  const hidden = checkHelpCriteria([{ kind: 'selector_visible', selector: '.login-ok' }]);
  assert.equal(hidden.ok, false);
  assert.equal(hidden.checks[0]?.reason, 'not-visible');

  const missing = checkHelpCriteria([{ kind: 'selector_exists', selector: '.nope' }]);
  assert.equal(missing.ok, false);
  assert.equal(missing.checks[0]?.reason, 'not-found');

  const text = checkHelpCriteria([{ kind: 'text_exists', text: '登录成功' }]);
  assert.equal(text.ok, true);
  const noText = checkHelpCriteria([{ kind: 'text_exists', text: '没出现过' }]);
  assert.equal(noText.ok, false);

  const url = checkHelpCriteria([{ kind: 'url_contains', text: 'example.test' }]);
  assert.equal(url.ok, true);
  const badUrl = checkHelpCriteria([{ kind: 'url_contains', text: 'other.test' }]);
  assert.equal(badUrl.ok, false);

  // 多个条件必须全部满足；未知 kind 明确不通过（不静默成功）。
  const mixed = checkHelpCriteria([
    { kind: 'selector_exists', selector: '.login-ok' },
    { kind: 'text_exists', text: '登录成功' },
  ]);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.checks.length, 2);
  const unsupported = checkHelpCriteria([{ kind: 'window_count', selector: '.login-ok' }]);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.checks[0]?.reason, 'unsupported-kind');
  assert.equal(checkHelpCriteria([]).ok, false);
});

test('coop measureTarget：按 selector 量视口矩形，坏 selector 回 null', () => {
  const { doc } = installFakeEnvironment();
  const button = doc.createElement('button');
  button.setAttribute('id', 'submit-btn');
  button.rect = { left: 70, top: 180, width: 120, height: 32 };
  doc.body.appendChild(button);
  const rect = measureTarget('#submit-btn');
  assert.ok(rect);
  assert.equal(rect.x, 70);
  assert.equal(rect.y, 180);
  assert.equal(rect.width, 120);
  assert.equal(rect.height, 32);
  assert.equal(rect.viewport.width, 1280);
  assert.equal(rect.viewport.height, 800);
  assert.equal(measureTarget('#missing'), null);
  assert.equal(measureTarget(''), null);
});
