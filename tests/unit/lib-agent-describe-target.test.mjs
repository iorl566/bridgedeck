import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessibleName,
  describeEventTarget,
  describeTarget,
  inferRole,
  resolveClickableElement,
  resolveHoverElement,
} from '../../extension/src/lib/describe-target.js';

// Minimal DOM used only to exercise the pure description helpers under node:test.
// It implements the handful of Element APIs describe-target actually consumes.
class FakeElement {
  constructor(tag, props = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(props.attributes ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    this.children = [];
    this.parentNode = null;
    this._text = props.text ?? '';
    this._id = null;
    this._tabIndex = props.tabIndex ?? -1;
    this.cursor = props.cursor ?? 'auto';
    this.isContentEditable = false;
    this.contentEditable = 'inherit';
    this.type = '';
    this.name = '';
    this.placeholder = '';
    this.value = '';
    this.alt = '';
    if (this.attributes.has('id')) this.id = this.attributes.get('id');
    if (this.attributes.has('tabindex')) this.tabIndex = Number(this.attributes.get('tabindex'));
    if (this.attributes.has('contenteditable')) this.contentEditable = this.attributes.get('contenteditable');
    if (this.attributes.has('type')) this.type = this.attributes.get('type');
    if (this.attributes.has('name')) this.name = this.attributes.get('name');
    if (this.attributes.has('placeholder')) this.placeholder = this.attributes.get('placeholder');
    if (this.attributes.has('value')) this.value = this.attributes.get('value');
    if (this.attributes.has('alt')) this.alt = this.attributes.get('alt');
  }

  get id() { return this._id ?? ''; }
  set id(value) { this._id = String(value); this.attributes.set('id', String(value)); }
  get className() { return this.attributes.get('class') ?? ''; }
  set className(value) { this.attributes.set('class', String(value)); }
  get tabIndex() { return this._tabIndex; }
  set tabIndex(value) { this._tabIndex = Number(value); }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index > 0 ? this.parentNode.children[index - 1] : null;
  }
  get textContent() { return `${this._text}${this.children.map((child) => child.textContent).join('')}`; }
  set textContent(value) { this._text = String(value); this.children = []; }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  getAttribute(name) {
    const key = name.toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) { return this.attributes.has(name.toLowerCase()); }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  cloneNode(deep) {
    const copy = new this.constructor(this.tagName, {
      attributes: Object.fromEntries(this.attributes),
      text: this._text,
      tabIndex: this._tabIndex,
      cursor: this.cursor,
    });
    copy.isContentEditable = this.isContentEditable;
    copy.contentEditable = this.contentEditable;
    copy.type = this.type;
    copy.name = this.name;
    copy.placeholder = this.placeholder;
    copy.value = this.value;
    copy.alt = this.alt;
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }

  matches(selector) {
    return selector.split(',').some((part) => matchCompound(this, part.trim()));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FakeHTMLElement extends FakeElement {}
class FakeInputElement extends FakeHTMLElement {
  constructor(tag, props) {
    super(tag, props);
    if (!this.type) this.type = 'text';
  }
}
class FakeTextAreaElement extends FakeHTMLElement {}
class FakeSelectElement extends FakeHTMLElement {}
class FakeButtonElement extends FakeHTMLElement {}
class FakeImageElement extends FakeHTMLElement {}
class FakeLabelElement extends FakeHTMLElement {}

globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeHTMLElement;
globalThis.HTMLInputElement = FakeInputElement;
globalThis.HTMLTextAreaElement = FakeTextAreaElement;
globalThis.HTMLSelectElement = FakeSelectElement;
globalThis.HTMLButtonElement = FakeButtonElement;
globalThis.HTMLImageElement = FakeImageElement;
globalThis.HTMLLabelElement = FakeLabelElement;
globalThis.CSS = { escape: (value) => String(value).replace(/["\\]/g, '\\$&') };
globalThis.getComputedStyle = (element) => ({ cursor: element.cursor ?? 'auto' });

function matchCompound(element, selector) {
  let rest = selector.trim();
  let negated = null;
  const notMatch = /:not\(([^)]*)\)/.exec(rest);
  if (notMatch) {
    negated = notMatch[1];
    rest = rest.replace(notMatch[0], '');
  }
  const attributeSpecs = [...rest.matchAll(/\[([^\]=\s]+)(?:="([^"]*)")?\]/g)];
  const tag = rest.replace(/\[[^\]]*\]/g, '').trim();
  if (tag && tag !== '*' && element.tagName.toLowerCase() !== tag) return false;
  for (const [, name, value] of attributeSpecs) {
    const key = name.toLowerCase();
    if (!element.attributes.has(key)) return false;
    if (value !== undefined && element.attributes.get(key) !== value) return false;
  }
  if (negated && matchCompound(element, negated)) return false;
  return true;
}

const TAG_CLASSES = {
  input: FakeInputElement,
  textarea: FakeTextAreaElement,
  select: FakeSelectElement,
  button: FakeButtonElement,
  img: FakeImageElement,
  label: FakeLabelElement,
};
const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
const TOKEN_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;

function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attributes[match[1]] = match[2] ?? '';
  return attributes;
}

function parseInto(root, markup) {
  const stack = [root];
  let match;
  while ((match = TOKEN_RE.exec(markup))) {
    if (match[5] !== undefined) {
      if (match[5].trim()) stack[stack.length - 1]._text += match[5];
      continue;
    }
    if (match[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const tag = match[2].toLowerCase();
    const ElementClass = TAG_CLASSES[tag] ?? FakeHTMLElement;
    const element = new ElementClass(tag, { attributes: parseAttributes(match[3] ?? '') });
    stack[stack.length - 1].appendChild(element);
    if (!VOID_TAGS.has(tag) && match[4] !== '/') stack.push(element);
  }
}

function render(markup) {
  const html = new FakeHTMLElement('html');
  const body = new FakeHTMLElement('body');
  html.appendChild(body);
  const document = {
    documentElement: html,
    body,
    getElementById: (id) => html.querySelectorAll(`[id="${id}"]`)[0] ?? null,
    querySelector: (selector) => html.querySelector(selector),
    querySelectorAll: (selector) => html.querySelectorAll(selector),
  };
  globalThis.document = document;
  parseInto(body, markup);
  return document;
}

function byId(id) {
  const element = globalThis.document.getElementById(id);
  assert.ok(element, `missing fixture element #${id}`);
  return element;
}

test('accessible name prefers explicit labels then compact visible text', () => {
  render(`
    <button id="aria" aria-label="  Save   now ">go</button>
    <span id="lbl">Labelled by</span><input id="labelledby" aria-labelledby="lbl" />
    <label for="for">For label</label><input id="for" />
    <label>Wrapped <input id="wrapped" /></label>
    <img id="image" alt="Logo" />
    <input id="placeholder" placeholder="Type here" />
    <div id="title" title="Tip">Body</div>
    <a id="heading" href="/x"><h3>Heading name</h3><cite>https://example.com</cite></a>
    <a id="image-link" href="/x"><img alt="Alt name" /></a>
    <a id="clean-link" href="/x"><span>Read story</span><script>bad()</script><svg></svg></a>
    <a id="url-link" href="/x">Visit https://example.com/path now</a>
    <input id="submit" type="submit" value="Send" />
    <button id="value" value="OK"></button>
    <div id="plain">Plain   text</div>
    <input id="empty" />
  `);

  assert.equal(accessibleName(byId('aria')), 'Save now');
  assert.equal(accessibleName(byId('labelledby')), 'Labelled by');
  assert.equal(accessibleName(byId('for')), 'For label');
  assert.equal(accessibleName(byId('wrapped')), 'Wrapped');
  assert.equal(accessibleName(byId('image')), 'Logo');
  assert.equal(accessibleName(byId('placeholder')), 'Type here');
  assert.equal(accessibleName(byId('title')), 'Tip');
  assert.equal(accessibleName(byId('heading')), 'Heading name');
  assert.equal(accessibleName(byId('image-link')), 'Alt name');
  assert.equal(accessibleName(byId('clean-link')), 'Read story');
  assert.equal(accessibleName(byId('url-link')), 'Visit now');
  assert.equal(accessibleName(byId('submit')), 'Send');
  assert.equal(accessibleName(byId('value')), 'OK');
  assert.equal(accessibleName(byId('plain')), 'Plain text');
  assert.equal(accessibleName(byId('empty')), undefined);
});

test('inferRole covers explicit roles, tags and input types', () => {
  render(`
    <div id="explicit" role=" TAB ">x</div>
    <button id="button">x</button>
    <a id="link" href="/x">x</a>
    <a id="anchor">x</a>
    <select id="select"></select>
    <textarea id="textarea"></textarea>
    <img id="img" />
    <summary id="summary">x</summary>
    <div id="editable" contenteditable="true">x</div>
    <div id="static" contenteditable="false">x</div>
    <input id="checkbox" type="checkbox" />
    <input id="radio" type="radio" />
    <input id="submit" type="submit" />
    <input id="image" type="image" />
    <input id="reset" type="reset" />
    <input id="range" type="range" />
    <input id="email" type="email" />
  `);

  assert.equal(inferRole(byId('explicit')), 'tab');
  assert.equal(inferRole(byId('button')), 'button');
  assert.equal(inferRole(byId('link')), 'link');
  assert.equal(inferRole(byId('anchor')), undefined);
  assert.equal(inferRole(byId('select')), 'combobox');
  assert.equal(inferRole(byId('textarea')), 'textbox');
  assert.equal(inferRole(byId('img')), 'img');
  assert.equal(inferRole(byId('summary')), 'button');
  assert.equal(inferRole(byId('editable')), 'textbox');
  assert.equal(inferRole(byId('static')), undefined);
  assert.equal(inferRole(byId('checkbox')), 'checkbox');
  assert.equal(inferRole(byId('radio')), 'radio');
  assert.equal(inferRole(byId('submit')), 'button');
  assert.equal(inferRole(byId('image')), 'button');
  assert.equal(inferRole(byId('reset')), 'button');
  assert.equal(inferRole(byId('range')), 'slider');
  assert.equal(inferRole(byId('email')), 'textbox');
});

test('describeTarget omits empty fields and adds the right label hints', () => {
  render(`
    <button id="button" aria-label="Go">x</button>
    <label for="svc">Service name</label><input id="svc" name="serviceName" />
    <div>Service</div><input id="nearby" />
    <input id="ph" name="user" placeholder="User" />
    <select id="select" name="choice"><option>One</option></select>
    <input id="agree" type="checkbox" name="agree" />
    <div id="custom" name="foo" placeholder="bar">Text</div>
    <div>background</div><button id="pub">发布</button>
  `);

  assert.deepEqual(describeTarget(byId('button')), { tag: 'button', role: 'button', name: 'Go' });
  assert.deepEqual(describeTarget(byId('svc')), {
    tag: 'input',
    role: 'textbox',
    name: 'Service name',
    name_attr: 'serviceName',
  });
  assert.deepEqual(describeTarget(byId('nearby')), {
    tag: 'input',
    role: 'textbox',
    nearby_label: 'Service',
  });
  assert.deepEqual(describeTarget(byId('ph')), {
    tag: 'input',
    role: 'textbox',
    name: 'User',
    name_attr: 'user',
    placeholder: 'User',
  });
  assert.deepEqual(describeTarget(byId('custom')), {
    tag: 'div',
    name: 'Text',
    name_attr: 'foo',
    placeholder: 'bar',
  });
  assert.deepEqual(describeTarget(byId('select')), {
    tag: 'select',
    role: 'combobox',
    name: 'One',
    name_attr: 'choice',
  });
  assert.deepEqual(describeTarget(byId('agree')), {
    tag: 'input',
    role: 'checkbox',
    name_attr: 'agree',
  });
  assert.deepEqual(describeTarget(byId('pub')), { tag: 'button', role: 'button', name: '发布' });
});

test('resolveClickableElement lifts to controls and rejects anonymous layout', () => {
  render(`
    <button id="button"><span id="icon">发布</span></button>
    <div class="btn" id="custom">发布</div>
    <div id="noise">background</div>
    <p id="copy">说明文字</p>
    <div class="btn" id="card">A long paragraph of card text that is not the name of any control</div>
  `);

  assert.equal(resolveClickableElement(byId('icon')), byId('button'));
  assert.equal(resolveClickableElement(byId('custom')), byId('custom'));
  assert.equal(resolveClickableElement(byId('noise')), null);
  assert.equal(resolveClickableElement(byId('copy')), null);
  assert.equal(resolveClickableElement(byId('card')), null);
});

test('resolveHoverElement falls back to the nearest pointer surface', () => {
  render(`
    <button id="button"><span id="icon">发布</span></button>
    <div id="wrap"><span id="kid"></span></div>
    <div id="plain"><span id="plain-kid"></span></div>
  `);
  byId('wrap').cursor = 'pointer';

  assert.equal(resolveHoverElement(byId('icon')), byId('button'));
  assert.equal(resolveHoverElement(byId('kid')), byId('wrap'));
  assert.equal(resolveHoverElement(byId('plain-kid')), null);
});

test('describeEventTarget records only teachable targets', () => {
  render(`
    <div id="noise">background</div>
    <button id="button"><span id="icon">发布</span></button>
    <button id="step"><span>Book and manage your theory test</span><span> , Show this section</span></button>
    <a id="story" href="/story">Next-Concept Modeling: Fast, Parallel Coarse-to-Fine Text Generation</a>
    <a id="bare" href="/bare">https://example.com/a/long/path/that/is/only/a/url</a>
    <div class="btn" id="card">A long paragraph of card text that is not the name of any control</div>
    <div class="btn" id="custom">发布</div>
  `);

  assert.equal(describeEventTarget(null), null);
  assert.equal(describeEventTarget({}), null);
  assert.equal(describeEventTarget(byId('noise')), null);
  assert.deepEqual(describeEventTarget(byId('icon')), { tag: 'button', role: 'button', name: '发布' });
  assert.deepEqual(describeEventTarget(byId('step')), {
    tag: 'button',
    role: 'button',
    name: 'Book and manage your theory test , Show this section',
  });
  assert.deepEqual(describeEventTarget(byId('story')), {
    tag: 'a',
    role: 'link',
    name: 'Next-Concept Modeling: Fast, Parallel Coarse-to-Fine Text Generation',
  });
  assert.equal(describeEventTarget(byId('bare')), null);
  assert.equal(describeEventTarget(byId('card')), null);
  assert.deepEqual(describeEventTarget(byId('custom')), { tag: 'div', name: '发布' });
});
