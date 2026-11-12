import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closestRecognizedHoverSurface, decideHoverSurfaceRelation, isHoverSurfaceCandidateElement,
  isLikelyHoverSurfaceOwner, isRecognizedHoverSurfaceElement,
} from '../../extension/src/content/record-hover-surface.js';

function rect(x, y, width, height) {
  return { left: x, top: y, width, height, right: x + width, bottom: y + height };
}

function element({ rect: box = rect(0, 0, 10, 10), className = '', role = '', id = '', parent = null, text = '' } = {}) {
  return {
    id,
    className,
    textContent: text,
    parentElement: parent,
    getAttribute(name) { return name === 'role' ? role : null; },
    matches(selector) { return role ? selector.includes(`[role="${role}"]`) : false; },
    getBoundingClientRect() { return box; },
    contains(other) { return other === this; },
  };
}

test('recognized surfaces use selectors and word tokens', () => {
  assert.equal(isRecognizedHoverSurfaceElement(element({ role: 'menu' })), true);
  assert.equal(isRecognizedHoverSurfaceElement(element({ className: 'dropdown-menu' })), true);
  assert.equal(isRecognizedHoverSurfaceElement(element({ className: 'dropdown-menu-item' })), false);
  assert.equal(isRecognizedHoverSurfaceElement(element({ className: 'plain' })), false);
});

test('closest recognized surface stops at body', () => {
  const body = element();
  const surface = element({ role: 'menu', parent: body });
  const child = element({ parent: surface });
  assert.equal(closestRecognizedHoverSurface(child, { body }), surface);
});

test('ownership geometry accepts below/right/corner only', () => {
  const trigger = element({ rect: rect(0, 0, 100, 20) });
  assert.equal(isLikelyHoverSurfaceOwner(trigger, element({ rect: rect(0, 20, 100, 80) })), true);
  assert.equal(isLikelyHoverSurfaceOwner(trigger, element({ rect: rect(100, 0, 80, 20) })), true);
  assert.equal(isLikelyHoverSurfaceOwner(trigger, element({ rect: rect(110, 25, 10, 10) })), true);
  assert.equal(isLikelyHoverSurfaceOwner(trigger, element({ rect: rect(200, 200, 10, 10) })), false);
});

test('relation prefers near surface and floating candidate', () => {
  const trigger = element({ rect: rect(0, 0, 100, 20) });
  const surface = element({ role: 'menu', rect: rect(0, 20, 100, 80) });
  const click = element({ parent: surface, rect: rect(10, 30, 5, 5) });
  assert.deepEqual(decideHoverSurfaceRelation({ triggerElement: trigger }, click, { body: null }), {
    related: true, reason: 'click-inside-hover-surface', surface,
  });
  const floating = element({ rect: rect(0, 20, 10, 10) });
  const floatingClick = element({ parent: floating, rect: rect(1, 1, 2, 2) });
  const env = { body: null, isHTMLElement: () => true, getComputedStyle: () => ({ position: 'absolute', pointerEvents: 'auto', visibility: 'visible', display: 'block' }), innerWidth: 1000, innerHeight: 1000 };
  assert.equal(isHoverSurfaceCandidateElement(floating, env), true);
  assert.equal(decideHoverSurfaceRelation({ triggerElement: trigger }, floatingClick, env).related, true);
});
