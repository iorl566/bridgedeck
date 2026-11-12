import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHoverTrigger, isUnsafeHoverTrigger } from '../../extension/src/lib/hover-trigger-policy.js';

const base = { tag: 'button', rect: { x: 10, y: 200, w: 40, h: 40 }, attrs: {} };

test('unsafe and invisible triggers are rejected', () => {
  assert.equal(isUnsafeHoverTrigger({ tag: 'input' }), true);
  assert.deepEqual(evaluateHoverTrigger({ ...base, tag: 'input' }), { eligible: false, score: 0, reasons: [] });
  assert.deepEqual(evaluateHoverTrigger({ ...base, rect: { x: 0, y: 0, w: 0, h: 10 } }), { eligible: false, score: 0, reasons: [] });
});

test('aria-haspopup button is eligible', () => {
  const decision = evaluateHoverTrigger({ ...base, attrs: { 'aria-haspopup': 'menu' } });
  assert.equal(decision.eligible, true);
  assert(decision.reasons.includes('aria-haspopup'));
});

test('plain text link is not eligible', () => {
  const decision = evaluateHoverTrigger({ tag: 'a', label: 'Read more', rect: { x: 10, y: 200, w: 80, h: 20 }, attrs: {} });
  assert.equal(decision.eligible, false);
});

test('icon-only topbar button is eligible', () => {
  const decision = evaluateHoverTrigger({ tag: 'button', hasGraphicDescendant: true, rect: { x: 10, y: 10, w: 32, h: 32 }, attrs: {} });
  assert.equal(decision.eligible, true);
  assert(decision.reasons.includes('topbar'));
  assert(decision.reasons.includes('compact'));
});
