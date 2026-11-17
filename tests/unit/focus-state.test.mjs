import test from 'node:test';
import assert from 'node:assert/strict';
import { isElementFocused } from '../../lib/focus-state.mjs';

function node(root) {
  return { getRootNode: () => root };
}

test('focus predicate follows document and shadow-root activeElement', () => {
  const focused = node(null);
  const documentRoot = { activeElement: focused };
  focused.getRootNode = () => documentRoot;
  assert.equal(isElementFocused(focused), true);

  const shadowNode = node(null);
  const shadowRoot = { activeElement: shadowNode, host: { getRootNode: () => documentRoot } };
  shadowNode.getRootNode = () => shadowRoot;
  assert.equal(isElementFocused(shadowNode), true);

  const nested = node(null);
  const innerRoot = { activeElement: nested, host: { getRootNode: () => shadowRoot } };
  nested.getRootNode = () => innerRoot;
  assert.equal(isElementFocused(nested), true);

  const unfocused = node({ activeElement: focused, host: null });
  assert.equal(isElementFocused(unfocused), false);
  assert.equal(isElementFocused(null), false);
});
