import test from 'node:test';
import assert from 'node:assert/strict';
import { matchBrowserFrame, normalizeFrameUrl } from '../../extension/src/tools/frame-identity.js';

test('frame 身份按 frameId/URL/document 归一', () => {
  const frames = [
    { frameId: 1, parentFrameId: 0, url: 'https://a/', documentId: 'd1' },
    { frameId: 2, parentFrameId: 1, url: 'https://b/', documentId: 'd2' },
    { frameId: 3, parentFrameId: 1, url: 'https://b/', documentId: 'd3' },
  ];
  assert.equal(matchBrowserFrame(frames, { frameId: 2, url: 'https://b/' }).frameId, 2);
  assert.equal(matchBrowserFrame(frames, { url: 'https://b/', documentId: 'd3' }).frameId, 3);
  assert.equal(matchBrowserFrame(frames, { url: 'https://none/' }), null);
  assert.equal(normalizeFrameUrl('https://a'), 'https://a/');
});
