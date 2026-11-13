import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrameGraph, cdpTargetKey, omitFrameSubtrees } from '../../extension/src/browser-driver/frame-graph.js';

const root = { tabId: 1 };
const child = { tabId: 1, sessionId: 's2' };

test('buildFrameGraph walks root and OOPIF targets', () => {
  const graph = buildFrameGraph([
    { target: root, tree: { frame: { id: 'r' }, childFrames: [{ frame: { id: 'a', parentId: 'r' } }] } },
    { target: child, tree: { frame: { id: 'b', parentId: 'a' }, childFrames: [{ frame: { id: 'c', parentId: 'b' } }] } },
  ]);
  assert.equal(graph.rootFrameId, 'r');
  assert.deepEqual(graph.frames.map((frame) => frame.frameId), ['r', 'a', 'b', 'c']);
  assert.equal(graph.frames.find((frame) => frame.frameId === 'b').target.sessionId, 's2');
  assert.equal(graph.frames.find((frame) => frame.frameId === 'c').target.sessionId, 's2');
});

test('omitFrameSubtrees removes blocked descendants and preserves gaps', () => {
  const graph = buildFrameGraph([{ target: root, tree: { frame: { id: 'r' }, childFrames: [
    { frame: { id: 'a', parentId: 'r' }, childFrames: [{ frame: { id: 'b', parentId: 'a' } }] },
    { frame: { id: 'c', parentId: 'r' } },
  ] } }]);
  const omitted = omitFrameSubtrees(graph, new Map([['a', { tabId: 1, sessionId: 'x' }]]));
  assert.deepEqual(omitted.frames.map((frame) => frame.frameId), ['r', 'c']);
  assert(omitted.unavailableFrames.some((frame) => frame.frameId === 'a' && frame.target.sessionId === 'x'));
  assert(omitted.unavailableFrames.some((frame) => frame.frameId === 'b'));
});

test('cdpTargetKey distinguishes root and sessions', () => {
  assert.equal(cdpTargetKey({ tabId: 1 }), '1:root');
  assert.equal(cdpTargetKey({ tabId: 1, sessionId: 's' }), '1:s');
  assert.equal(buildFrameGraph([]), null);
});
