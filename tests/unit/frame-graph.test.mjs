import test from 'node:test';
import assert from 'node:assert/strict';

let calls = 0;
globalThis.chrome = {
  webNavigation: {
    async getAllFrames() {
      calls += 1;
      return [
        { frameId: 0, parentFrameId: -1, url: 'https://example.test/' },
        { frameId: 7, parentFrameId: 0, url: 'https://frame.test/' },
      ];
    },
  },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
  },
};

test('frame graph refreshes, caches and invalidates', async () => {
  const { ensureFrameGraph, getFrameGraph, invalidateFrameGraph } = await import('../../extension/src/frame-graph.js');
  const first = await ensureFrameGraph(101);
  assert.equal(first.length, 2);
  assert.equal(first[1].parentFrameId, 0);
  await ensureFrameGraph(101);
  assert.equal(calls, 1, '缓存命中不应重复调用 getAllFrames');
  assert.equal(getFrameGraph(101).length, 2);
  invalidateFrameGraph(101);
  assert.equal(getFrameGraph(101).length, 0);
  await ensureFrameGraph(101);
  assert.equal(calls, 2);
});
