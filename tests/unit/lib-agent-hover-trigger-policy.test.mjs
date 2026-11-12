import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateHoverTrigger,
  hasDirectHoverInteractiveSignal,
  hasHoverPopupSignal,
  hasStrongHoverExpansionSignal,
  isUnsafeHoverTrigger,
} from '../../extension/src/lib/hover-trigger-policy.js';

const OFFSCREEN_RECT = { x: 10, y: 300, w: 200, h: 40 };

test('explicit popup triggers accumulate every scoring reason', () => {
  const decision = evaluateHoverTrigger({
    tag: 'button',
    role: 'button',
    label: 'Open user navigation menu',
    attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    rect: { x: 900, y: 8, w: 32, h: 32 },
    cursor: 'pointer',
    pointerEvents: 'auto',
  });

  assert.equal(decision.eligible, true);
  assert.equal(decision.score, 280);
  assert.deepEqual(decision.reasons, [
    'aria-haspopup',
    'collapsed',
    'popup-signal',
    'button',
    'pointer',
    'topbar',
    'compact',
  ]);
});

test('strong expansion signals qualify without popup words', () => {
  const collapsed = evaluateHoverTrigger({
    tag: 'div',
    role: 'tab',
    attrs: { 'aria-expanded': 'FALSE' },
    rect: OFFSCREEN_RECT,
    pointerEvents: 'auto',
  });
  assert.equal(collapsed.eligible, true);
  assert.equal(collapsed.score, 55);
  assert.deepEqual(collapsed.reasons, ['collapsed']);

  const cssHover = evaluateHoverTrigger({
    tag: 'div',
    role: 'tab',
    attrs: {},
    rect: OFFSCREEN_RECT,
    pointerEvents: 'auto',
    cssHoverMatch: true,
  });
  assert.equal(cssHover.eligible, false);
  assert.equal(cssHover.score, 40);
  assert.deepEqual(cssHover.reasons, ['css-hover']);

  const haspopupOnly = evaluateHoverTrigger({
    tag: 'div',
    role: 'tab',
    attrs: { 'aria-haspopup': '' },
    rect: OFFSCREEN_RECT,
    pointerEvents: 'auto',
  });
  assert.equal(haspopupOnly.eligible, true);
  assert.equal(haspopupOnly.score, 80);
  assert.deepEqual(haspopupOnly.reasons, ['aria-haspopup']);
});

test('popup word detection reads attributes and button labels only', () => {
  assert.equal(hasHoverPopupSignal({ tag: 'button', role: 'button', label: 'More' }), true);
  assert.equal(hasHoverPopupSignal({ tag: 'a', role: 'link', label: 'More' }), false);
  assert.equal(hasHoverPopupSignal({ tag: 'div', attrs: { 'data-testid': 'user-menu' } }), true);
  assert.equal(hasHoverPopupSignal({ tag: 'div', attrs: { 'aria-controls': 'account-panel' } }), true);
  assert.equal(hasHoverPopupSignal({ tag: 'div', attrs: { id: 'save' } }), false);
  assert.equal(hasHoverPopupSignal({ tag: 'div' }), false);
});

test('strong expansion and direct interactivity recognise every documented signal', () => {
  assert.equal(hasStrongHoverExpansionSignal({ tag: 'button', cssHoverMatch: true }), true);
  assert.equal(hasStrongHoverExpansionSignal({ tag: 'button', attrs: { 'aria-haspopup': 'menu' } }), true);
  assert.equal(hasStrongHoverExpansionSignal({ tag: 'button', attrs: { 'aria-expanded': 'False' } }), true);
  assert.equal(hasStrongHoverExpansionSignal({ tag: 'button', attrs: {} }), false);

  const directTrue = [
    { tag: 'a' },
    { tag: 'summary' },
    { tag: 'div', role: 'combobox' },
    { tag: 'div', attrs: { tabindex: '0' } },
    { tag: 'div', cursor: 'pointer' },
    { tag: 'div', attrs: { onclick: 'go()' } },
    { tag: 'div', attrs: { onmouseenter: 'go()' } },
    { tag: 'div', attrs: { onmouseover: 'go()' } },
    { tag: 'div', attrs: { 'aria-haspopup': 'menu' } },
    { tag: 'div', attrs: { 'aria-expanded': 'false' } },
  ];
  for (const signals of directTrue) assert.equal(hasDirectHoverInteractiveSignal(signals), true, JSON.stringify(signals));
  assert.equal(hasDirectHoverInteractiveSignal({ tag: 'div', attrs: { 'aria-expanded': 'False' } }), false);
  assert.equal(hasDirectHoverInteractiveSignal({ tag: 'div', attrs: {} }), false);
});

test('unsafe controls cannot be hover triggers', () => {
  for (const tag of ['input', 'textarea', 'select', 'option']) {
    assert.equal(isUnsafeHoverTrigger({ tag }), true, tag);
  }
  assert.equal(isUnsafeHoverTrigger({ tag: 'div', attrs: { contenteditable: 'true' } }), true);
  assert.equal(isUnsafeHoverTrigger({ tag: 'div', attrs: { disabled: '' } }), true);
  assert.equal(isUnsafeHoverTrigger({ tag: 'div', attrs: { inert: '' } }), true);
  assert.equal(isUnsafeHoverTrigger({ tag: 'div', attrs: { 'aria-disabled': 'TRUE' } }), true);
  assert.equal(isUnsafeHoverTrigger({ tag: 'button', attrs: {} }), false);
});

test('invisible, hidden and oversized targets score zero', () => {
  const visible = {
    tag: 'button',
    attrs: { 'aria-haspopup': 'menu' },
    rect: OFFSCREEN_RECT,
    pointerEvents: 'auto',
  };
  const rejected = [
    { ...visible, rect: null },
    { ...visible, rect: { x: 0, y: 0, w: 0, h: 40 } },
    { ...visible, rect: { x: 0, y: 0, w: 200, h: 0 } },
    { ...visible, pointerEvents: 'none' },
    { ...visible, attrs: { ...visible.attrs, hidden: '' } },
    { ...visible, attrs: { ...visible.attrs, inert: '' } },
    { ...visible, attrs: { ...visible.attrs, 'aria-hidden': 'TRUE' } },
  ];
  for (const signals of rejected) {
    assert.deepEqual(evaluateHoverTrigger(signals), { eligible: false, score: 0, reasons: [] }, JSON.stringify(signals));
  }

  assert.equal(evaluateHoverTrigger({ ...visible, rect: { x: 0, y: 0, w: 400, h: 400 } }).eligible, true);
  assert.deepEqual(
    evaluateHoverTrigger({ ...visible, rect: { x: 0, y: 0, w: 401, h: 400 } }),
    { eligible: false, score: 0, reasons: [] },
  );
});

test('text navigation items stay out even when their attributes mention menus', () => {
  const label = evaluateHoverTrigger({
    tag: 'a',
    role: 'link',
    label: 'My profile',
    attrs: { class: 'dropdown-item profile-link' },
    rect: { x: 820, y: 72, w: 96, h: 32 },
    cursor: 'pointer',
    pointerEvents: 'auto',
  });
  assert.deepEqual(label, { eligible: false, score: 0, reasons: [] });

  const listItem = evaluateHoverTrigger({
    tag: 'li',
    label: '文档C+D',
    attrs: { class: 'dropdown-item', tabindex: '0' },
    rect: { x: 820, y: 48, w: 160, h: 32 },
    cursor: 'pointer',
    pointerEvents: 'auto',
  });
  assert.deepEqual(listItem, { eligible: false, score: 0, reasons: [] });

  const menuItem = evaluateHoverTrigger({
    tag: 'div',
    role: 'menuitem',
    label: 'Item',
    attrs: { class: 'popup-menu' },
    rect: { x: 100, y: 200, w: 160, h: 32 },
    pointerEvents: 'auto',
  });
  assert.deepEqual(menuItem, { eligible: false, score: 0, reasons: [] });
});

test('compact topbar icons qualify with and without an image label', () => {
  const imageButton = evaluateHoverTrigger({
    tag: 'button',
    role: 'button',
    label: 'image',
    attrs: {},
    rect: { x: 900, y: 8, w: 32, h: 32 },
    pointerEvents: 'auto',
    hasGraphicDescendant: true,
  });
  assert.equal(imageButton.eligible, true);
  assert.deepEqual(imageButton.reasons, ['button', 'icon-only', 'topbar', 'compact']);

  const imageLink = evaluateHoverTrigger({
    tag: 'a',
    role: 'link',
    label: 'image',
    attrs: {},
    rect: { x: 900, y: 8, w: 32, h: 32 },
    pointerEvents: 'auto',
    hasGraphicDescendant: true,
  });
  assert.equal(imageLink.eligible, true);
  assert.deepEqual(imageLink.reasons, ['icon-only', 'topbar', 'compact']);

  const noLabel = evaluateHoverTrigger({
    tag: 'button',
    role: 'button',
    attrs: {},
    rect: { x: 900, y: 8, w: 32, h: 32 },
    pointerEvents: 'auto',
    hasGraphicDescendant: true,
  });
  assert.equal(noLabel.eligible, true);
  assert.deepEqual(noLabel.reasons, ['button', 'icon-only', 'topbar', 'compact']);
});

test('ordinary controls without a popup surface remain ineligible', () => {
  const decision = evaluateHoverTrigger({
    tag: 'button',
    role: 'button',
    label: 'Search',
    attrs: {},
    rect: { x: 100, y: 240, w: 120, h: 36 },
    pointerEvents: 'auto',
  });
  assert.deepEqual(decision, { eligible: false, score: 0, reasons: [] });
});
