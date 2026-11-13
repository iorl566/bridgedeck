import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationNodeIndex, captureRecordingObservation } from '../../extension/src/lib/recording/observation-capture.js';

const ref = (refId, backendNodeId, frameId) => ({ ref: refId, backendNodeId, frameId, role: 'button', name: refId });

test('index groups candidates and refs', () => {
  const index = new ObservationNodeIndex({
    rootFrameId: 'root',
    refs: [ref('@e1', 1), ref('@e2', 2)],
    matchNodes: [
      { frameId: 'root', backendNodeId: 1, tag: 'button', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { frameId: 'root', backendNodeId: 2, tag: 'A', rect: { x: 0, y: 0, w: 1, h: 1 } },
    ],
  });
  assert.equal(index.candidates('root', 'BUTTON').length, 1);
  assert.equal(index.candidates('root', 'a').length, 1);
  assert.equal(index.candidates('root', 'button')[0].ref.ref, '@e1');
  assert.equal(index.ref('@e2').backendNodeId, 2);
  assert.equal(index.refs('root').length, 2);
});

test('document scope duplicates become unavailable', () => {
  const index = new ObservationNodeIndex({
    rootFrameId: 'root',
    refs: [],
    matchNodes: [],
    frames: [
      { frameId: 'f1', recordingDocumentId: 'd', target: { tabId: 1 } },
      { frameId: 'f2', recordingDocumentId: 'd', target: { tabId: 1 } },
      { frameId: 'f3', recordingDocumentId: 'e', target: { tabId: 1 } },
    ],
  });
  assert.equal(index.documentScope('d'), undefined);
  assert.deepEqual(index.documentScope('e'), { frameId: 'f3', target: { tabId: 1 } });
});

test('capture falls back to about:blank when tab read fails', async () => {
  const result = await captureRecordingObservation({
    cdp: {}, tabId: 1, maxTokens: 10, redactValues: false,
    tabsApi: { async get() { throw new Error('closed'); } },
  }, {
    async captureVom() { return { rootFrameId: 'root', refs: [], matchNodes: [], text: 't', truncated: false }; },
  });
  assert.equal(result.url, 'about:blank');
  assert.equal(result.vomText, 't');
});

test('capture builds an index from the observation', async () => {
  const result = await captureRecordingObservation({
    cdp: {}, tabId: 1, maxTokens: 10, redactValues: true,
    tabsApi: { async get() { return { url: 'https://x', title: 'X' }; } },
  }, {
    async captureVom(_cdp, _tab, url, options) {
      assert.equal(options.redactValues, true);
      assert.equal(url, 'https://x');
      return { rootFrameId: 'root', refs: [ref('@e1', 1)], matchNodes: [{ frameId: 'root', backendNodeId: 1, tag: 'button' }], text: 'body', truncated: true };
    },
  });
  assert.equal(result.title, 'X');
  assert.equal(result.truncated, true);
  assert.equal(result.index.candidates('root', 'button').length, 1);
});
