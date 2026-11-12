import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoOptions, pickVideoMime, VIDEO_MIME_CANDIDATES } from '../../extension/src/video-encoder.js';

test('pickVideoMime prefers supported preferred codec', () => {
  const supported = (mime) => mime === 'video/mp4' || mime === 'video/webm';
  assert.equal(pickVideoMime(supported, { preferred: 'video/mp4;codecs=avc1.42E01E' }), 'video/mp4');
  assert.equal(pickVideoMime(() => false), '');
  assert.equal(VIDEO_MIME_CANDIDATES.length, 4);
});

test('normalizeVideoOptions clamps fps and scales dimensions', () => {
  assert.deepEqual(normalizeVideoOptions({ width: 1600, height: 900, fps: 60, bitrate: 1000 }), {
    width: 1280, height: 720, fps: 30, bitrate: 100000,
  });
  assert.deepEqual(normalizeVideoOptions({}), { width: 1280, height: 800, fps: 10, bitrate: 4000000 });
});

test('normalizeVideoOptions keeps even dimensions', () => {
  const options = normalizeVideoOptions({ width: 641, height: 481, fps: 12 });
  assert.equal(options.width % 2, 0);
  assert.equal(options.height % 2, 0);
  assert.equal(options.fps, 12);
});
