import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCooperationCapture } from '../../extension/src/content/cooperation-capture.js';
import {
  COOPERATION_ARM,
  COOPERATION_DISABLE,
  COOPERATION_READ,
  COOPERATION_READY,
} from '../../extension/src/cooperation/types.js';

/** Minimal DOM stand-in: these tests need nodes, listeners and clocks, not layout. */
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
    this.value = attrs.value ?? '';
    this.checked = false;
    this.readOnly = false;
    this.disabled = false;
    this.isContentEditable = false;
    this.labels = [];
    this.form = null;
    this.queries = new Map();
    this.rect = { x: 0, y: 0, left: 0, top: 0, width: 10, height: 10 };
  }
  get type() { return this.attrs.get('type') ?? 'text'; }
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
  getRootNode() { return this.ownerRoot ?? document; }
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
  focus() { document.activeElement = this; }
  addEventListener(type, handler) {
    const list = this._listeners?.get(type) ?? [];
    list.push(handler);
    if (!this._listeners) this._listeners = new Map();
    this._listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this._listeners?.get(type) ?? [];
    this._listeners.set(type, list.filter((item) => item !== handler));
  }
  dispatch(event) {
    for (const handler of [...(this._listeners?.get(event.type) ?? [])]) handler(event);
  }
}

class FakeInput extends FakeElement {}
class FakeTextArea extends FakeElement {}
class FakeSelect extends FakeElement {}
class FakeShadowRoot extends FakeElement {}

class FakeMutationObserver {
  constructor(callback) { this.callback = callback; this.records = []; this.observed = new Set(); }
  observe(root) { this.observed.add(root); }
  disconnect() { this.observed.clear(); }
  takeRecords() {
    const records = this.records;
    this.records = [];
    return records;
  }
}

globalThis.KeyboardEvent = class KeyboardEvent {};
globalThis.MouseEvent = class MouseEvent {};
globalThis.MutationObserver = FakeMutationObserver;

let document;
let window;

function resetDom() {
  globalThis.Node = FakeElement;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLInputElement = FakeInput;
  globalThis.HTMLTextAreaElement = FakeTextArea;
  globalThis.HTMLSelectElement = FakeSelect;
  globalThis.HTMLSourceElement = FakeElement;
  globalThis.ShadowRoot = FakeShadowRoot;
  globalThis.visualViewport = undefined;

  document = new FakeElement('#document');
  document.documentElement = new FakeElement('html');
  document.body = new FakeElement('body');
  document.documentElement.append(document.body);
  document.activeElement = document.body;
  document.queries.set('*', []);
  document.queries.set('video,audio', []);
  globalThis.document = document;

  window = new FakeElement('#window');
  window.top = window;
  globalThis.window = window;
  globalThis.location = { href: 'https://page.test/start' };
}

function makeElement(localName, attrs = {}) {
  return localName === 'input' ? new FakeInput(localName, attrs) : new FakeElement(localName, attrs);
}

function fire(target, type, extra = {}) {
  const event = {
    type,
    target: extra.target ?? target,
    composedPath: () => extra.path ?? [extra.target ?? target],
    isTrusted: true,
    timeStamp: 1000,
    detail: 1,
    button: 0,
    key: '',
    ...extra,
  };
  target.dispatch(event);
  return event;
}

function collector() {
  let receive;
  const sent = [];
  globalThis.chrome = {
    dom: undefined,
    runtime: {
      sendMessage: async (message) => { sent.push(message); },
      onMessage: {
        addListener(listener) { receive = listener; },
        removeListener() {},
      },
    },
  };
  const dispose = attachCooperationCapture();
  const read = (kind = COOPERATION_READ, lease = 'first', input) => {
    let result;
    receive({ kind, lease, input }, {}, (value) => { result = value; });
    return result;
  };
  return { read, dispose, sent };
}

test('announces readiness, collects fields and reports deep focus', () => {
  resetDom();
  const input = makeElement('input', { 'aria-label': 'City', type: 'text' });
  input.value = 'Shanghai';
  document.queries.set('*', [input]);
  const { read, dispose, sent } = collector();

  assert.deepEqual(sent[0], { kind: COOPERATION_READY });
  const initial = read();
  assert.match(initial.document, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(initial.fields.map((field) => [field.label, field.value]), [['City', 'Shanghai']]);
  assert.equal(initial.focusIsDocument, true);
  assert.equal(initial.human, 0);

  const bodyFocus = initial.focus;
  input.focus();
  const focused = read();
  assert.equal(focused.focusIsDocument, false);
  assert.notEqual(focused.focus, bodyFocus);
  assert.equal(focused.human, 0);
  dispose();
});

test('retires older leases so delayed reads cannot restart collection after stop', () => {
  resetDom();
  const { read, dispose } = collector();
  assert.ok(read());
  read(COOPERATION_DISABLE);
  assert.equal(read(COOPERATION_READ, 'first'), undefined);
  assert.ok(read(COOPERATION_READ, 'second'));
  read(COOPERATION_DISABLE, 'first');
  assert.ok(read(COOPERATION_READ, 'second'));
  assert.equal(read(COOPERATION_READ, 'first'), undefined);
  dispose();
});

test('keeps scrolling, ineffective keys and wheel out of human control', () => {
  resetDom();
  const input = makeElement('input', { 'aria-label': 'City', type: 'text' });
  document.queries.set('*', [input]);
  const { read, dispose } = collector();
  read();

  fire(window, 'wheel', { target: input, path: [input, document.body] });
  fire(document, 'scroll', { target: input, path: [input, document.body] });
  for (const type of ['keydown', 'keyup']) {
    fire(document, type, { target: input, path: [input], key: 'Shift' });
    fire(document, type, { target: input, path: [input], key: 'Tab' });
  }
  const state = read();
  assert.equal(state.human, 0);
  assert.equal(state.lastInput, 0);
  assert.equal(state.busy, false);
  assert.equal(state.editing, false);
  assert.equal(state.pending, false);
  dispose();
});

test('ignores untrusted events and records trusted page clicks', () => {
  resetDom();
  const button = makeElement('button', { 'aria-label': 'Apply' });
  document.queries.set('*', [button]);
  const { read, dispose } = collector();
  read();

  fire(document, 'click', { target: button, path: [button], isTrusted: false });
  assert.equal(read().human, 0);

  fire(document, 'click', { target: button, path: [button], detail: 1 });
  const clicked = read();
  assert.equal(clicked.human, 1);
  assert.equal(clicked.events.at(-1).type, 'click');
  assert.equal(clicked.events.at(-1).label, 'Apply');
  assert.ok(clicked.lastInput > 0);
  dispose();
});

test('releases a pending pointer when the native menu is dismissed with Escape', () => {
  resetDom();
  const button = makeElement('button', { 'aria-label': 'Choose' });
  document.queries.set('*', [button]);
  const { read, dispose } = collector();
  read();

  fire(document, 'pointerdown', { target: button, path: [button] });
  assert.equal(read().pending, true);

  fire(document, 'keydown', { target: button, path: [button], key: 'Escape' });
  const released = read();
  assert.equal(released.pending, false);
  assert.equal(released.busy, false);
  assert.equal(released.human, 0);
  dispose();
});

test('protects an unfinished composition and publishes the transition', () => {
  resetDom();
  const input = makeElement('input', { 'aria-label': 'Note', type: 'text' });
  document.queries.set('*', [input]);
  const { read, dispose } = collector();
  read();

  fire(document, 'compositionstart', { target: input, path: [input] });
  const composing = read();
  assert.equal(composing.pending, true);
  assert.equal(composing.busy, false);
  assert.equal(composing.human, 0);

  fire(document, 'compositionend', { target: input, path: [input] });
  assert.equal(read().pending, false);
  dispose();
});

test('ignores toolbar gestures but lets them finish a page-originated press', async () => {
  resetDom();
  const pageButton = makeElement('button', { 'aria-label': 'Apply' });
  const host = makeElement('div', { 'data-bb-overlay': '' });
  const toolbarButton = makeElement('button', { 'aria-label': 'Pause' });
  host.append(toolbarButton);
  document.body.append(host);
  document.queries.set('*', []);
  const toolbarPath = [toolbarButton, host, document.body, document.documentElement];
  const { read, dispose } = collector();
  const before = read();

  fire(document, 'pointerdown', { target: toolbarButton, path: toolbarPath });
  fire(document, 'click', { target: toolbarButton, path: toolbarPath });
  const ignored = read();
  assert.equal(ignored.human, before.human);
  assert.equal(ignored.revision, before.revision);
  assert.equal(ignored.pending, false);

  fire(document, 'pointerdown', { target: pageButton, path: [pageButton] });
  fire(document, 'pointerup', { target: toolbarButton, path: toolbarPath });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const finished = read();
  assert.equal(finished.human, 0);
  assert.equal(finished.pending, false);
  dispose();
});

test('resets the document identity when an SPA route changes', () => {
  resetDom();
  const { read, dispose } = collector();
  const first = read();
  location.href = 'https://page.test/next';
  const second = read();
  assert.notEqual(second.document, first.document);
  assert.ok(second.revision > first.revision);
  dispose();
});

test('keeps an editing lease until the field stops being editable', () => {
  resetDom();
  const input = makeElement('input', { 'aria-label': 'City', type: 'text' });
  input.value = 'Shanghai';
  document.queries.set('*', [input]);
  const { read, dispose } = collector();
  read();
  input.focus();
  read();

  fire(document, 'beforeinput', { target: input, path: [input], inputType: 'insertText', data: 'Paris' });
  input.value = 'Paris';
  fire(document, 'input', { target: input, path: [input], inputType: 'insertText', data: 'Paris' });
  const edited = read();
  assert.equal(edited.human, 1);
  assert.equal(edited.editing, true);
  assert.deepEqual(edited.fields.map((field) => field.value), ['Paris']);

  input.readOnly = true;
  assert.equal(read().editing, false);
  dispose();
});

test('fails closed when clock sampling is interrupted', () => {
  resetDom();
  const button = makeElement('button', { 'aria-label': 'Continue' });
  document.queries.set('*', [button]);
  const { read, dispose } = collector();
  read();

  const originalDateNow = Date.now;
  const originalPerformance = globalThis.performance;
  Date.now = () => 1_790_000_000_000;
  let ticks = 0;
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => (ticks += 50), timeOrigin: 1000 },
    configurable: true,
  });
  try {
    const armed = read(COOPERATION_ARM, 'first', { type: 'pointerdown', x: 0, y: 0, timestamp: Date.now() });
    assert.equal(armed, undefined);
  } finally {
    Date.now = originalDateNow;
    Object.defineProperty(globalThis, 'performance', { value: originalPerformance, configurable: true });
  }
  dispose();
});

test('attributes a clock-matched pointer press without swallowing the next human one', () => {
  resetDom();
  const button = makeElement('button', { 'aria-label': 'Continue' });
  document.queries.set('*', [button]);
  const { read, dispose } = collector();
  read();

  const originalDateNow = Date.now;
  const originalPerformance = globalThis.performance;
  const timestamp = 1_790_000_000_000;
  Date.now = () => timestamp;
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => 1000, timeOrigin: 1000 },
    configurable: true,
  });
  try {
    assert.ok(read(COOPERATION_ARM, 'first', { type: 'pointerdown', x: 0, y: 0, timestamp }));
    fire(document, 'pointerdown', { target: button, path: [button], timeStamp: 1000 });
    fire(document, 'click', { target: button, path: [button], detail: 1 });
    assert.equal(read().human, 0);

    assert.ok(read(COOPERATION_ARM, 'first', { type: 'pointerdown', x: 0, y: 0, timestamp }));
    fire(document, 'pointerdown', { target: button, path: [button], timeStamp: 5000 });
    fire(document, 'click', { target: button, path: [button], detail: 1 });
    assert.equal(read().human, 1);
  } finally {
    Date.now = originalDateNow;
    Object.defineProperty(globalThis, 'performance', { value: originalPerformance, configurable: true });
  }
  dispose();
});

test('classifies a media timeline without masking business fields', () => {
  resetDom();
  const range = makeElement('input', { type: 'range', 'aria-label': 'Playback progress' });
  range.value = '1';
  const video = makeElement('video', { id: 'preview' });
  document.queries.set('*', [range, video]);
  document.queries.set('video,audio', [video]);
  const { read, dispose } = collector();

  const state = read();
  assert.equal(state.fields[0].kind, 'media_progress');
  assert.equal(state.fields[0].value, '1');
  assert.equal(state.media.length, 1);
  assert.equal(state.media[0].srcObject, null);
  dispose();
});
