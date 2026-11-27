import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFrameGap, summarizeFrameGaps } from '../../extension/src/lib/frame-gaps.js';

test('classifyFrameGap 区分隐藏/失效/加载错误', () => {
  assert.equal(classifyFrameGap({ error: 'x', hidden: true }), 'hidden_frame');
  assert.equal(classifyFrameGap({ error: 'frame detached' }), 'inactive_document');
  assert.equal(classifyFrameGap({ error: 'net::ERR_FAILED' }), 'load_error');
  assert.equal(classifyFrameGap({}), null);
});

test('summarizeFrameGaps 自有 URL 用 self_url，about:blank 用父帧', () => {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://example.com/a' },
    { frameId: 3, parentFrameId: 0, url: 'about:blank', gap: 'hidden_frame' },
    { frameId: 4, parentFrameId: 0, url: 'https://other.test/x', gap: 'load_error' },
  ];
  const result = summarizeFrameGaps(frames);
  assert.equal(result.gaps.length, 2);
  assert.equal(result.gaps[0].ownerUrl, 'https://example.com/a');
  assert.equal(result.gaps[0].ownerFrameId, 0);
  assert.equal(result.gaps[0].ownerDepth, 1);
  assert.equal(result.gaps[0].ownerUrlSource, 'parent_url');
  assert.equal(result.gaps[0].inferred, true);
  assert.equal(result.gaps[1].ownerUrl, 'https://other.test/x');
  assert.equal(result.gaps[1].ownerUrlSource, 'self_url');
  assert.equal(result.gaps[1].inferred, false);
  assert.equal(result.inferred, 1);
});

test('summarizeFrameGaps 沿祖先链推断 ownerUrl', () => {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://example.com/a' },
    { frameId: 2, parentFrameId: 0, url: 'about:blank' },
    { frameId: 5, parentFrameId: 2, url: 'about:blank', gap: 'inactive_document' },
  ];
  const result = summarizeFrameGaps(frames);
  assert.equal(result.gaps[0].ownerUrl, 'https://example.com/a');
  assert.equal(result.gaps[0].ownerFrameId, 0);
  assert.equal(result.gaps[0].ownerDepth, 2);
  assert.equal(result.gaps[0].ownerUrlSource, 'ancestor_url');
});

test('summarizeFrameGaps 优先使用 owner 元素 src', () => {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://example.com/a' },
    { frameId: 7, parentFrameId: 0, url: 'about:blank', gap: 'hidden_frame', ownerSrc: 'https://x.test/embed', ownerUrl: 'https://x.test/embed' },
  ];
  const result = summarizeFrameGaps(frames);
  assert.equal(result.gaps[0].ownerUrl, 'https://x.test/embed');
  assert.equal(result.gaps[0].ownerUrlSource, 'owner_element');
  assert.equal(result.gaps[0].ownerSrc, 'https://x.test/embed');
  assert.equal(result.gaps[0].inferred, true);
});
