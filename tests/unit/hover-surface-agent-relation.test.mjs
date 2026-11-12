import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closestHoverSurfaceCandidate,
  closestRecognizedHoverSurface,
  collectHoverSurfaceStates,
  decideHoverSurfaceRelation,
  isHoverSurfaceCandidateElement,
  isLikelyHoverSurfaceOwner,
  isPositionedFloatingElement,
  isRecognizedHoverSurfaceElement,
} from '../../extension/src/content/record-hover-surface.js';

/** Minimal element stand-in: these tests need attributes, geometry and parents. */
function rect(x, y, width, height) {
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height };
}

const DEFAULT_RECT = rect(0, 0, 10, 10);

function matchesSelector(el, selector) {
  return selector.split(',').some((raw) => {
    const part = raw.trim();
    const parsed = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
    if (!parsed) return false;
    const value = el.getAttribute(parsed[1]);
    if (value === null) return false;
    return parsed[2] === undefined || value === parsed[2];
  });
}

class FakeElement {
  constructor({
    rect: box = DEFAULT_RECT,
    className = '',
    role = '',
    id = '',
    attrs = {},
    parent = null,
    textContent = '',
  } = {}) {
    this.id = id;
    this.className = className;
    this.textContent = textContent;
    this.parentElement = parent;
    this._attrs = new Map(Object.entries(attrs));
    if (role) this._attrs.set('role', role);
    this._box = box;
  }

  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  getBoundingClientRect() {
    return this._box;
  }

  contains(other) {
    for (let node = other; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
}

function element(options = {}) {
  return new FakeElement(options);
}

function surfaceElement(options = {}) {
  return new FakeElement({ role: 'menu', ...options });
}

const VISIBLE_STYLE = {
  position: 'static',
  pointerEvents: 'auto',
  visibility: 'visible',
  display: 'block',
};

function styleEnv(overrides = {}) {
  return {
    isHTMLElement: () => true,
    getComputedStyle: () => VISIBLE_STYLE,
    innerWidth: 1_000,
    innerHeight: 800,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Recognition
 * ------------------------------------------------------------------ */

test('recognizes every declared semantic role and floating-layer marker', () => {
  const markers = [
    { role: 'menu' },
    { role: 'menubar' },
    { role: 'listbox' },
    { role: 'dialog' },
    { role: 'tooltip' },
    { attrs: { 'aria-modal': 'true' } },
    { attrs: { 'data-popper-placement': 'bottom-start' } },
    { attrs: { 'data-floating-ui-placement': 'top' } },
    { attrs: { 'data-headlessui-state': 'open' } },
    { attrs: { 'data-radix-popper-content-wrapper': '' } },
  ];
  for (const marker of markers) {
    assert.equal(isRecognizedHoverSurfaceElement(element(marker)), true, JSON.stringify(marker));
  }
  assert.equal(isRecognizedHoverSurfaceElement(element({ attrs: { 'aria-modal': 'false' } })), false);
  assert.equal(isRecognizedHoverSurfaceElement(element()), false);
  assert.equal(isRecognizedHoverSurfaceElement(element({ className: 'plain-content' })), false);
});

test('recognizes container naming and excludes surface items', () => {
  const containers = [
    'dropdown-menu',
    'drop-down-menu',
    'menu-list',
    'popover__popper',
    'popover__content',
    'popover__content-body',
    'popover-content',
    'popper',
    'popup',
    'flyout',
    'submenu',
    'submenu-wrapper',
    'context-menu',
    'account-menu',
    'user-menu',
    'avatar-menu',
    'Dropdown-Menu',
    'tg-popover__popper',
  ];
  for (const className of containers) {
    assert.equal(isRecognizedHoverSurfaceElement(element({ className })), true, className);
  }
  const items = [
    'dropdown-menu-item',
    'menu-link',
    'submenu__item',
    'context-menu__link',
    'item-text',
    'item__label',
    'item-content',
    'header-menu__item',
    'header-dropdown-menu__link',
  ];
  for (const className of items) {
    assert.equal(isRecognizedHoverSurfaceElement(element({ className })), false, className);
  }
  assert.equal(isRecognizedHoverSurfaceElement(element({ className: 'header-menu' })), false);
  assert.equal(isRecognizedHoverSurfaceElement(element({ className: 'tg-popover' })), false);
});

test('closest recognized surface stops before the body and root elements', () => {
  const body = element({ className: 'popover-content' });
  const documentElement = element({ className: 'popover-content' });
  const surface = surfaceElement({ parent: body });
  const child = element({ parent: surface });
  const plain = element({ parent: body });
  const env = { body, documentElement };

  assert.equal(closestRecognizedHoverSurface(child, env), surface);
  assert.equal(closestRecognizedHoverSurface(plain, env), null);
  assert.equal(closestRecognizedHoverSurface(surface, env), surface);
});

test('closest recognized surface respects the ancestor depth budget', () => {
  function nested(depth) {
    let node = surfaceElement();
    for (let index = 0; index < depth; index += 1) node = element({ parent: node });
    return node;
  }
  assert.notEqual(closestRecognizedHoverSurface(nested(0)), null);
  assert.notEqual(closestRecognizedHoverSurface(nested(9)), null);
  assert.equal(closestRecognizedHoverSurface(nested(10)), null);
});

/* ------------------------------------------------------------------ *
 * Floating layers
 * ------------------------------------------------------------------ */

test('floating layers must be absolute, visible, painted and smaller than half the viewport', () => {
  const absolute = styleEnv({
    getComputedStyle: () => ({ ...VISIBLE_STYLE, position: 'absolute' }),
  });
  assert.equal(isPositionedFloatingElement(element({ rect: rect(0, 0, 240, 300) }), absolute), true);

  for (const position of ['static', 'relative', 'fixed', 'sticky']) {
    assert.equal(
      isPositionedFloatingElement(
        element(),
        styleEnv({ getComputedStyle: () => ({ ...VISIBLE_STYLE, position }) }),
      ),
      false,
      position,
    );
  }

  for (const style of [
    { pointerEvents: 'none' },
    { visibility: 'hidden' },
    { display: 'none' },
  ]) {
    assert.equal(
      isPositionedFloatingElement(
        element(),
        styleEnv({ getComputedStyle: () => ({ ...VISIBLE_STYLE, position: 'absolute', ...style }) }),
      ),
      false,
      JSON.stringify(style),
    );
  }

  assert.equal(
    isPositionedFloatingElement(element({ rect: rect(0, 0, 0, 100) }), absolute),
    false,
  );
  assert.equal(
    isPositionedFloatingElement(element({ rect: rect(0, 0, 700, 600) }), absolute),
    false,
  );
  assert.equal(
    isPositionedFloatingElement(element({ rect: rect(0, 0, 500, 400) }), absolute),
    true,
  );
  // A zero-sized viewport reports no usable ratio, so the size gate is skipped.
  assert.equal(
    isPositionedFloatingElement(
      element({ rect: rect(0, 0, 900, 900) }),
      styleEnv({
        getComputedStyle: () => ({ ...VISIBLE_STYLE, position: 'absolute' }),
        innerWidth: 0,
        innerHeight: 0,
      }),
    ),
    true,
  );
});

test('candidates combine recognized surfaces with floating layers', () => {
  const floatingEnv = styleEnv({
    getComputedStyle: () => ({ ...VISIBLE_STYLE, position: 'absolute' }),
  });
  assert.equal(isHoverSurfaceCandidateElement(surfaceElement()), true);
  assert.equal(isHoverSurfaceCandidateElement(element({ className: 'popup' })), true);
  assert.equal(isHoverSurfaceCandidateElement(element({ rect: rect(0, 0, 20, 20) }), floatingEnv), true);
  assert.equal(isHoverSurfaceCandidateElement(element({ rect: rect(0, 0, 0, 0) }), floatingEnv), false);

  const body = element();
  const floating = element({ rect: rect(0, 0, 20, 20), parent: body });
  const surface = surfaceElement({ rect: rect(0, 20, 100, 80), parent: floating });
  const child = element({ parent: surface });
  const env = {
    ...floatingEnv,
    body,
    getComputedStyle: (el) => (el === floating
      ? { ...VISIBLE_STYLE, position: 'absolute' }
      : VISIBLE_STYLE),
  };
  assert.equal(closestHoverSurfaceCandidate(child, env), surface);
});

/* ------------------------------------------------------------------ *
 * Snapshot collection
 * ------------------------------------------------------------------ */

test('collects only visible candidates and fingerprints geometry plus text', () => {
  const visible = surfaceElement({ rect: rect(10.4, 20.6, 100.5, 20.4), textContent: '  Menu  ' });
  const hiddenDisplay = surfaceElement();
  const hiddenPointer = surfaceElement();
  const hiddenVisibility = surfaceElement();
  const floating = element({ rect: rect(5, 6, 40, 50) });
  const foreign = element({ className: 'popover-content', rect: rect(0, 0, 30, 30) });
  const styles = new Map([
    [hiddenDisplay, { ...VISIBLE_STYLE, display: 'none' }],
    [hiddenPointer, { ...VISIBLE_STYLE, pointerEvents: 'none' }],
    [hiddenVisibility, { ...VISIBLE_STYLE, visibility: 'hidden' }],
    [floating, { ...VISIBLE_STYLE, position: 'absolute' }],
  ]);
  const env = {
    document: {
      querySelectorAll: () => [visible, hiddenDisplay, hiddenPointer, hiddenVisibility, floating, foreign],
    },
    getComputedStyle: (el) => styles.get(el) ?? VISIBLE_STYLE,
    isHTMLElement: (el) => el !== foreign,
    innerWidth: 1_000,
    innerHeight: 800,
  };

  const states = collectHoverSurfaceStates(env);
  assert.deepEqual(states.map((state) => state.element), [visible, floating]);
  assert.equal(states[0].signature, '10,21,101,20|Menu');
  assert.equal(states[1].signature, '5,6,40,50|');
  assert.deepEqual(collectHoverSurfaceStates({ document: null }), []);
});

test('fingerprints truncate surface text to a bounded length', () => {
  const longText = 'x'.repeat(600);
  const surface = surfaceElement({ rect: rect(0, 0, 10, 10), textContent: longText });
  const states = collectHoverSurfaceStates({
    document: { querySelectorAll: () => [surface] },
    getComputedStyle: () => VISIBLE_STYLE,
    isHTMLElement: () => true,
    innerWidth: 1_000,
    innerHeight: 800,
  });
  assert.equal(states.length, 1);
  assert.equal(states[0].signature, `0,0,10,10|${'x'.repeat(512)}`);
});

/* ------------------------------------------------------------------ *
 * Ownership geometry
 * ------------------------------------------------------------------ */

test('ownership accepts openings on one axis or from the corner only', () => {
  const trigger = element({ rect: rect(0, 0, 100, 20) });
  const owner = (box) => isLikelyHoverSurfaceOwner(trigger, element({ rect: box }));

  assert.equal(owner(rect(0, 20, 100, 80)), true); // directly below
  assert.equal(owner(rect(0, -80, 100, 80)), true); // directly above
  assert.equal(owner(rect(100, 0, 80, 20)), true); // right
  assert.equal(owner(rect(-80, 0, 80, 20)), true); // left
  assert.equal(owner(rect(110, 26, 10, 10)), true); // diagonal corner
  assert.equal(owner(rect(0, 0, 100, 20)), false); // covers the trigger
  assert.equal(owner(rect(200, 200, 10, 10)), false); // far away
  assert.equal(owner(rect(0, 116, 100, 10)), true); // 96px vertical gap
  assert.equal(owner(rect(0, 117, 100, 10)), false); // 97px vertical gap
  assert.equal(owner(rect(196, 0, 10, 20)), true); // 96px horizontal gap
  assert.equal(owner(rect(197, 0, 10, 20)), false); // 97px horizontal gap
  assert.equal(owner(rect(116, 36, 10, 10)), true); // 16x16 corner gap
  assert.equal(owner(rect(117, 37, 10, 10)), false); // 17x17 corner gap
});

test('ownership tolerates surfaces overlapping the trigger on one axis only', () => {
  const avatar = element({ rect: rect(1340, 11, 26, 26) });
  const surface = element({ rect: rect(1111, 44, 240, 496) });
  assert.equal(isLikelyHoverSurfaceOwner(avatar, surface), true);
});

test('ownership falls back to true when geometry is unavailable', () => {
  assert.equal(
    isLikelyHoverSurfaceOwner(element({ rect: rect(0, 0, 0, 0) }), element({ rect: rect(0, 0, 10, 10) })),
    true,
  );
});

/* ------------------------------------------------------------------ *
 * Relation decisions
 * ------------------------------------------------------------------ */

test('decide prefers a recognized surface near the trigger', () => {
  const body = element();
  const trigger = element({ rect: rect(0, 0, 100, 20) });
  const surface = surfaceElement({ rect: rect(0, 20, 100, 80), parent: body });
  const click = element({ rect: rect(10, 30, 5, 5), parent: surface });

  const decision = decideHoverSurfaceRelation(
    { triggerElement: trigger },
    click,
    { body, documentElement: element() },
  );
  assert.equal(decision.related, true);
  assert.equal(decision.reason, 'click-inside-hover-surface');
  assert.equal(decision.surface, surface);
});

test('decide attributes clicks in a near floating layer to the trigger', () => {
  const body = element();
  const trigger = element({ rect: rect(0, 0, 100, 20) });
  const floating = element({ rect: rect(0, 20, 120, 90), parent: body });
  const click = element({ rect: rect(5, 25, 4, 4), parent: floating });
  const env = styleEnv({
    body,
    documentElement: element(),
    getComputedStyle: (el) => (el === floating
      ? { ...VISIBLE_STYLE, position: 'absolute' }
      : VISIBLE_STYLE),
  });

  const decision = decideHoverSurfaceRelation({ triggerElement: trigger }, click, env);
  assert.equal(decision.related, true);
  assert.equal(decision.reason, 'click-inside-near-floating-surface');
  assert.equal(decision.surface, floating);
});

test('decide accepts a click inside the trigger itself', () => {
  const body = element();
  const trigger = element({ rect: rect(0, 0, 100, 20), parent: body });
  const child = element({ rect: rect(10, 5, 4, 4), parent: trigger });
  const decision = decideHoverSurfaceRelation(
    { triggerElement: trigger },
    child,
    { body, documentElement: element() },
  );
  assert.equal(decision.related, true);
  assert.equal(decision.reason, 'click-inside-trigger-contained-surface');
  assert.equal(decision.surface, undefined);
});

test('decide rejects far surfaces and unrelated clicks', () => {
  const body = element();
  const trigger = element({ rect: rect(0, 0, 100, 20), parent: body });
  const farSurface = surfaceElement({ rect: rect(0, 900, 100, 80), parent: body });
  const farClick = element({ rect: rect(10, 910, 5, 5), parent: farSurface });
  const far = decideHoverSurfaceRelation(
    { triggerElement: trigger },
    farClick,
    { body, documentElement: element() },
  );
  assert.deepEqual(far, { related: false, reason: 'click-outside-hover-surface' });

  const unrelated = element({ rect: rect(400, 400, 5, 5), parent: body });
  assert.deepEqual(
    decideHoverSurfaceRelation({ triggerElement: trigger }, unrelated, { body, documentElement: element() }),
    { related: false, reason: 'click-outside-hover-surface' },
  );
});

test('decide treats a trigger that is itself a surface as the hover surface', () => {
  const body = element();
  const trigger = surfaceElement({ rect: rect(0, 0, 100, 20), parent: body });
  const decision = decideHoverSurfaceRelation(
    { triggerElement: trigger },
    trigger,
    { body, documentElement: element() },
  );
  assert.equal(decision.related, true);
  assert.equal(decision.reason, 'click-inside-hover-surface');

  // A plain trigger is not "contained in itself", so clicking it is unrelated.
  const plainTrigger = element({ rect: rect(0, 0, 100, 20), parent: body });
  const plain = decideHoverSurfaceRelation(
    { triggerElement: plainTrigger },
    plainTrigger,
    { body, documentElement: element() },
  );
  assert.equal(plain.related, false);
  assert.equal(plain.reason, 'click-outside-hover-surface');
});

/* ------------------------------------------------------------------ *
 * Default (browser) environment
 * ------------------------------------------------------------------ */

test('default environment uses the document boundaries, host elements and viewport', () => {
  const savedDocument = globalThis.document;
  const savedHTMLElement = globalThis.HTMLElement;
  const savedGetComputedStyle = globalThis.getComputedStyle;
  const savedWindow = globalThis.window;

  const body = element();
  const documentElement = element();
  const surface = surfaceElement({ rect: rect(0, 20, 100, 80), parent: body });
  const child = element({ parent: surface });
  const floating = element({ rect: rect(0, 0, 50, 40), parent: body });
  const foreign = {
    id: '',
    className: 'popover-content',
    textContent: '',
    parentElement: body,
    getAttribute: () => null,
    matches: () => false,
    getBoundingClientRect: () => rect(0, 0, 30, 30),
    contains: () => false,
  };
  globalThis.document = {
    body,
    documentElement,
    querySelectorAll: () => [documentElement, body, surface, floating, foreign],
  };
  globalThis.HTMLElement = FakeElement;
  globalThis.getComputedStyle = (el) => (el === floating
    ? { ...VISIBLE_STYLE, position: 'absolute' }
    : VISIBLE_STYLE);
  globalThis.window = { innerWidth: 1_000, innerHeight: 800 };

  try {
    // No env: parent walks must stop at document.body and documentElement.
    assert.equal(closestHoverSurfaceCandidate(child), surface);
    assert.equal(closestRecognizedHoverSurface(body), null);
    assert.equal(closestRecognizedHoverSurface(documentElement), null);

    assert.equal(isPositionedFloatingElement(floating), true);
    assert.equal(isPositionedFloatingElement(foreign), false);

    const states = collectHoverSurfaceStates();
    assert.deepEqual(states.map((state) => state.element), [surface, floating]);

    const decision = decideHoverSurfaceRelation(
      { triggerElement: element({ rect: rect(0, 0, 100, 20) }) },
      child,
    );
    assert.equal(decision.reason, 'click-inside-hover-surface');
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = savedHTMLElement;
    if (savedGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = savedGetComputedStyle;
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
});

test('default environment calls getComputedStyle with the window receiver', () => {
  const savedHTMLElement = globalThis.HTMLElement;
  const savedWindow = globalThis.window;
  const floating = element({ rect: rect(0, 0, 40, 30) });
  let calls = 0;
  globalThis.HTMLElement = FakeElement;
  globalThis.window = {
    innerWidth: 1_000,
    innerHeight: 800,
    getComputedStyle() {
      calls += 1;
      if (this !== globalThis.window) throw new TypeError('Illegal invocation');
      return { ...VISIBLE_STYLE, position: 'absolute' };
    },
  };
  try {
    assert.equal(isPositionedFloatingElement(floating), true);
    assert(calls > 0);
  } finally {
    if (savedHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = savedHTMLElement;
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
});
