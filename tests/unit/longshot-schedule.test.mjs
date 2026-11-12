import test from 'node:test';
import assert from 'node:assert/strict';
import { nextGrowthTiles, tileForScroll } from '../../extension/src/longshot-schedule.js';

test('nextGrowthTiles appends only up to scrollHeight and maxTiles', () => {
  assert.deepEqual(nextGrowthTiles([0], { scrollHeight: 350, step: 100 }), [0, 100, 200, 300]);
  assert.deepEqual(nextGrowthTiles([0], { scrollHeight: 500, step: 100, maxTiles: 3 }), [0, 100, 200]);
  assert.deepEqual(nextGrowthTiles([0, 100], { scrollHeight: 250, step: 100 }), [0, 100, 200]);
});

test('tileForScroll falls back to index * step', () => {
  assert.equal(tileForScroll(123, 100, 2), 123);
  assert.equal(tileForScroll(undefined, 100, 2), 200);
  assert.equal(tileForScroll(-1, 100, 3), 300);
});
