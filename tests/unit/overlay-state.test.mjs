import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginCapture,
  closeOverlay,
  endCapture,
  getOverlayState,
  isCapturing,
  openOverlay,
} from '../../extension/src/overlay-state.js';

test('overlay registry is idempotent per kind and token-aware on close', () => {
  const first = openOverlay(401, 'takeover', { priority: 10 });
  assert.equal(first.duplicate, false);
  const again = openOverlay(401, 'takeover', { priority: 10 });
  assert.equal(again.duplicate, true);
  assert.equal(again.token, first.token);
  assert.equal(closeOverlay(401, 'takeover', 'wrong-token'), false);
  assert.equal(closeOverlay(401, 'takeover', first.token), true);
  assert.equal(getOverlayState(401).overlays.length, 0);
});

test('exclusive overlay removes lower priority overlays', () => {
  openOverlay(402, 'record', { priority: 5 });
  openOverlay(402, 'takeover', { priority: 10 });
  openOverlay(402, 'borrow', { priority: 100, exclusive: true });
  const kinds = getOverlayState(402).overlays.map((item) => item.kind);
  assert.deepEqual(kinds, ['borrow']);
});

test('capture count is nested and clears at zero', () => {
  beginCapture(403);
  beginCapture(403);
  assert.equal(isCapturing(403), true);
  endCapture(403);
  assert.equal(isCapturing(403), true);
  endCapture(403);
  assert.equal(isCapturing(403), false);
});
