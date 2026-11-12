import test from 'node:test';
import assert from 'node:assert/strict';
import { planCaptureTiles, frameSignature, sameFrame, pruneCaptures } from '../../extension/src/longshot.js';

test('planCaptureTiles covers page height without exceeding max', () => {
  assert.deepEqual(planCaptureTiles({ scrollHeight: 250, viewportHeight: 100 }), [0, 100, 200]);
  assert.deepEqual(planCaptureTiles({ scrollHeight: 200, viewportHeight: 100, overlap: 20 }), [0, 80, 160]);
  assert.deepEqual(planCaptureTiles({ scrollHeight: 1000, viewportHeight: 100, maxTiles: 3 }), [0, 100, 200]);
  assert.deepEqual(planCaptureTiles({ scrollHeight: 0, viewportHeight: 100 }), [0]);
});

test('frameSignature ignores scroll position but detects page size/body changes', () => {
  const a = frameSignature({ scrollHeight: 1000, scrollY: 0, innerHeight: 800, bodyLength: 10 });
  const b = frameSignature({ scrollHeight: 1000, scrollY: 600, innerHeight: 800, bodyLength: 10 });
  assert.equal(a, b);
  assert.equal(sameFrame({ scrollHeight: 1000, innerHeight: 800, bodyLength: 10 }, { scrollHeight: 1200, innerHeight: 800, bodyLength: 10 }), false);
});

test('pruneCaptures removes expired and overflow entries', () => {
  const now = 10000;
  const captures = new Map([
    ['old', { at: 1000 }],
    ['a', { at: 9000 }],
    ['b', { at: 9500 }],
  ]);
  pruneCaptures(captures, { now, ttlMs: 5000, max: 1 });
  assert.deepEqual([...captures.keys()], ['b']);
});
