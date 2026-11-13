import test from 'node:test';
import assert from 'node:assert/strict';
import { startRecordCapture } from '../../extension/src/content/record-capture.js';

/** Minimal DOM stand-in: these tests need nodes, listeners and geometry, not layout. */
function matchesSelector(element, selector) {
  return selector.split(',').some((raw) => {
    const part = raw.trim();
    if (!part) return false;
    if (part === '*') return true;
    if (part === element.localName) return true;
    if (part === 'input:not([type="hidden"])') return element.localName === 'input' && element.getAttribute('type') !== 'hidden';
    const attribute = /^\[([\w-]+)(?:(\^?=)(?:"([^"]*)"|([^\]]*)))?\]$/.exec(part);
    if (!attribute) return false;
    const [, name, operator, quoted, bare] = attribute;
    const value = element.getAttribute(name);
    if (value === null) return false;
    if (!operator) return true;
    const expected = quoted ?? bare ?? '';
    return operator === '^=' ? value.startsWith(expected) : value === expected;
  });
}

class FakeElement {
  constructor(localName, attrs = {}) {
    this.localName = localName;
    this.tagName = localName.toUpperCase();
    this.nodeType = 1;
    this.attrs = new Map(Object.entries(attrs).map(([name, value]) => [name, String(value)]));
    this.parentNode = null;
    this.parentElement = null;
    this.childNodes = [];
    this.children = [];
    this.isConnected = true;
    this.shadowRoot = null;
    this.textContent = '';
    this.id = attrs.id ?? '';
    this.className = attrs.class ?? '';
    this.name = attrs.name ?? '';
    this.placeholder = attrs.placeholder ?? '';
    this.value = attrs.value ?? '';
    this.checked = false;
    this.isContentEditable = false;
    this.labels = [];
    this.form = null;
    this.queries = new Map();
    this.rect = { x: 0, y: 0, left: 0, top: 0, width: 10, height: 10 };
  }
  get type() { return this.attrs.get('type') ?? 'text'; }
  get selectedOptions() { return (this.options ?? []).filter((option) => option.value === this.value); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  hasAttribute(name) { return this.attrs.has(name); }
  matches(selector) { return matchesSelector(this, selector); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  querySelectorAll(selector) { return this.queries.get(selector) ?? []; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getRootNode() { return document; }
  getBoundingClientRect() { return this.rect; }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      node.parentElement = this;
      this.childNodes.push(node);
      this.children.push(node);
    }
    return this;
  }
  addEventListener(type, handler) {
    const list = this._listeners?.get(type) ?? [];
    list.push(handler);
    if (!this._listeners) this._listeners = new Map();
    this._listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    this._listeners?.set(type, (this._listeners.get(type) ?? []).filter((item) => item !== handler));
  }
  dispatch(event) {
    for (const handler of [...(this._listeners?.get(event.type) ?? [])]) handler(event);
  }
}

class FakeInput extends FakeElement {}
class FakeSelect extends FakeElement {}
FakeElement.TEXT_NODE = 3;

class FakeMutationObserver {
  constructor(callback) { this.callback = callback; this.records = []; }
  observe() {}
  disconnect() {}
  takeRecords() {
    const records = this.records;
    this.records = [];
    return records;
  }
}

let document;
let window;

function resetDom() {
  globalThis.Node = FakeElement;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLInputElement = FakeInput;
  globalThis.HTMLSelectElement = FakeSelect;
  globalThis.HTMLTextAreaElement = class HTMLTextAreaElement extends FakeElement {};
  globalThis.HTMLButtonElement = class HTMLButtonElement extends FakeElement {};
  globalThis.HTMLImageElement = class HTMLImageElement extends FakeElement {};
  globalThis.HTMLLabelElement = class HTMLLabelElement extends FakeElement {};
  globalThis.ShadowRoot = class ShadowRoot extends FakeElement {};
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.getComputedStyle = () => ({ position: 'static', cursor: '', pointerEvents: 'auto', visibility: 'visible', display: 'block' });

  document = new FakeElement('#document');
  document.documentElement = new FakeElement('html');
  document.body = new FakeElement('body');
  document.documentElement.append(document.body);
  document.queries.set('*', []);
  globalThis.document = document;

  window = new FakeElement('#window');
  window.top = window;
  globalThis.window = window;
  globalThis.location = { href: 'https://page.test/start' };
  globalThis.history = {
    pushState() {},
    replaceState() {},
  };
}

function makeElement(localName, attrs = {}) {
  if (localName === 'input') return new FakeInput(localName, attrs);
  if (localName === 'select') return new FakeSelect(localName, attrs);
  return new FakeElement(localName, attrs);
}

function fire(target, type, extra = {}) {
  const event = {
    type,
    target: extra.target ?? target,
    composedPath: () => extra.path ?? [extra.target ?? target],
    isTrusted: true,
    button: 0,
    detail: 1,
    key: '',
    ...extra,
  };
  target.dispatch(event);
  return event;
}

function capture(options) {
  const steps = [];
  const instance = startRecordCapture('record-1', (step) => steps.push(step), options);
  return { steps, dispose: () => instance.dispose() };
}

function press(button, key, extra = {}) {
  fire(document, 'keydown', { target: button, path: [button], key, ...extra });
}

test('records a semantic click with the clicked control geometry', () => {
  resetDom();
  const button = makeElement('button', { 'aria-label': 'Go' });
  button.rect = { x: 10, y: 20, left: 10, top: 20, width: 40, height: 20 };
  document.body.append(button);
  document.queries.set('*', [button]);
  const { steps, dispose } = capture();

  fire(document, 'click', { target: button, path: [button] });
  assert.deepEqual(steps, [{
    page_url: 'https://page.test/start',
    op: 'click',
    target: { tag: 'button', role: 'button', name: 'Go' },
    geometry: { rect: { x: 10, y: 20, w: 40, h: 20 }, tag: 'button' },
    expects_navigation: true,
  }]);
  dispose();
});

test('describes the composed-path target instead of the retargeted host', () => {
  resetDom();
  const button = makeElement('button', { 'aria-label': 'Go' });
  document.body.append(button);
  document.queries.set('*', [button]);
  const { steps, dispose } = capture();

  fire(document, 'click', { target: document.body, path: [button, document.body] });
  assert.equal(steps.filter((step) => step.op === 'click').length, 1);
  assert.equal(steps[0].target.name, 'Go');
  dispose();
});

test('ignores clicks whose composed path contains overlay chrome', () => {
  resetDom();
  const host = makeElement('div', { 'data-bb-overlay': '' });
  const button = makeElement('button', { 'aria-label': 'Pause' });
  host.append(button);
  document.body.append(host);
  document.queries.set('*', [button]);
  const { steps, dispose } = capture();

  const path = [button, host, document.body, document.documentElement];
  fire(document, 'click', { target: button, path });
  fire(document, 'keydown', { target: button, path, key: 'Enter' });
  assert.deepEqual(steps, []);
  dispose();
});

test('records Enter and Escape presses but not bare typing or clipboard keys', () => {
  resetDom();
  const button = makeElement('button', { 'aria-label': 'Go' });
  document.body.append(button);
  document.queries.set('*', [button]);
  const { steps, dispose } = capture();

  press(button, 'a');
  press(button, 'Shift');
  press(button, 'c', { ctrlKey: true });
  press(button, 'Escape');
  press(button, 'Enter');
  assert.deepEqual(steps.map((step) => step.op), ['press', 'press']);
  assert.deepEqual(steps.map((step) => step.key), ['Escape', 'Enter']);
  assert.equal(steps[0].expects_navigation, false);
  assert.equal(steps[1].expects_navigation, true);
  assert.deepEqual(steps[1].target, { tag: 'button', role: 'button', name: 'Go' });
  dispose();
});

test('commits the final fill value once and masks password sessions', () => {
  resetDom();
  const input = makeElement('input', { 'aria-label': 'City', type: 'text' });
  input.value = 'Shanghai';
  document.body.append(input);
  document.queries.set('*', [input]);
  const { steps, dispose } = capture();

  fire(document, 'focusin', { target: input, path: [input] });
  input.value = 'Paris';
  fire(document, 'input', { target: input, path: [input] });
  fire(document, 'focusout', { target: input, path: [input] });

  const password = makeElement('input', { 'aria-label': 'Password', type: 'password' });
  document.body.append(password);
  fire(document, 'focusin', { target: password, path: [password] });
  password.value = 'secret';
  fire(document, 'input', { target: password, path: [password] });
  fire(document, 'focusout', { target: password, path: [password] });

  const fills = steps.filter((step) => step.op === 'fill');
  assert.equal(fills.length, 2);
  assert.equal(fills[0].value, 'Paris');
  assert.equal(fills[0].commit, 'blur');
  assert.deepEqual(fills[0].target, { tag: 'input', role: 'textbox', name: 'City' });
  assert.equal(fills[1].value, '***');
  assert.equal(fills[1].redacted, true);
  assert.ok(!JSON.stringify(steps).includes('secret'));
  dispose();
});

test('records one select step for a native select', () => {
  resetDom();
  const select = makeElement('select', { 'aria-label': 'Choice' });
  select.options = [
    { value: 'a', label: 'Alpha', textContent: 'Alpha' },
    { value: 'b', label: 'Beta', textContent: 'Beta' },
  ];
  select.value = 'b';
  select.selectedOptions;
  document.body.append(select);
  document.queries.set('*', [select]);
  const { steps, dispose } = capture();

  fire(document, 'input', { target: select, path: [select] });
  fire(document, 'change', { target: select, path: [select] });
  assert.deepEqual(steps.map((step) => step.op), ['select']);
  assert.deepEqual(steps[0].values, ['b']);
  assert.deepEqual(steps[0].labels, ['Beta']);
  assert.deepEqual(steps[0].target, { tag: 'select', role: 'combobox', name: 'Choice' });
  assert.equal(steps[0].expects_navigation, true);
  dispose();
});

test('attributes navigations caused by a recorded action', async () => {
  resetDom();
  const button = makeElement('button', { 'aria-label': 'Go' });
  document.body.append(button);
  document.queries.set('*', [button]);
  const { steps, dispose } = capture();

  press(button, 'Enter');
  location.href = 'https://page.test/next';
  history.pushState({}, '', '/next');

  await new Promise((resolve) => setTimeout(resolve, 5));
  location.href = 'https://page.test/third';
  history.replaceState({}, '', '/third');

  const navigations = steps.filter((step) => step.op === 'navigate');
  assert.equal(navigations.length, 2);
  assert.deepEqual(navigations[0], {
    page_url: 'https://page.test/next',
    op: 'navigate',
    url: 'https://page.test/next',
    navigation_caused_by_action: true,
  });
  assert.deepEqual(navigations[1], {
    page_url: 'https://page.test/third',
    op: 'navigate',
    url: 'https://page.test/third',
  });
  dispose();
});

test('records the compact hover trigger label before a menu item click', () => {
  resetDom();
  const trigger = makeElement('div', { role: 'button', 'aria-haspopup': 'true' });
  trigger.rect = { x: 300, y: 20, left: 300, top: 20, right: 340, bottom: 44, width: 40, height: 24 };
  trigger.textContent = 'Menu Profile';
  const surface = makeElement('div', { role: 'menu' });
  surface.rect = { x: 300, y: 48, left: 300, top: 48, right: 420, bottom: 108, width: 120, height: 60 };
  surface.textContent = 'Profile';
  const item = makeElement('div', { role: 'menuitem', 'aria-label': 'Profile' });
  surface.append(item);
  trigger.childNodes.push({ nodeType: 3, textContent: 'Menu ' }, surface);
  trigger.children.push(surface);
  document.body.append(trigger);
  document.queries.set('*', [trigger, surface, item]);
  const { steps, dispose } = capture();

  fire(document, 'mouseover', { target: trigger, path: [trigger] });
  fire(document, 'click', { target: item, path: [item, surface] });

  assert.deepEqual(steps.map((step) => step.op), ['hover', 'click']);
  assert.equal(steps[0].target.name, 'Menu');
  assert.deepEqual(steps[0].target, { tag: 'div', role: 'button', name: 'Menu' });
  assert.equal(steps[1].target.name, 'Profile');
  dispose();
});

test('does not emit navigation from a capture with navigation disabled', () => {
  resetDom();
  const { steps, dispose } = capture({ captureNavigation: false });
  location.href = 'https://page.test/next';
  history.pushState({}, '', '/next');
  assert.deepEqual(steps, []);
  dispose();
});
