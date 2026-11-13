import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERACTIVE_SELECTOR, isActionableLabel, isMeaningfulClickTarget } from '../../extension/src/lib/describe-target.js';

test('actionable label rejects empty, long and URL-only names', () => {
  assert.equal(isActionableLabel('  Save  '), true);
  assert.equal(isActionableLabel(''), false);
  assert.equal(isActionableLabel('x'.repeat(49)), false);
  assert.equal(isActionableLabel('https://example.com'), false);
  assert.equal(isActionableLabel('x'.repeat(100), Infinity), true);
});

test('meaningful click target needs a name or form name attr', () => {
  assert.equal(isMeaningfulClickTarget({ tag: 'button', name: 'Go' }), true);
  assert.equal(isMeaningfulClickTarget({ tag: 'input', role: 'checkbox', name_attr: 'agree' }), true);
  assert.equal(isMeaningfulClickTarget({ tag: 'div' }), false);
  assert.equal(isMeaningfulClickTarget({ tag: 'input', role: 'checkbox' }), false);
});

test('interactive selector covers core controls', () => {
  assert.match(INTERACTIVE_SELECTOR, /a\[href\]/);
  assert.match(INTERACTIVE_SELECTOR, /button/);
  assert.match(INTERACTIVE_SELECTOR, /role="menuitem"/);
  assert.match(INTERACTIVE_SELECTOR, /contenteditable/);
});
