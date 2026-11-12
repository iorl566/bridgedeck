import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeStop, isVideoId, publicVideo, validateVideoStart, videoFilename, VIDEO_PRESETS,
} from '../../extension/src/video/types.js';
import { FrameClock, VideoTimeline, videoDimensions } from '../../extension/src/video/timeline.js';
import { videoEncoderConfig } from '../../extension/src/video/encoder-config.js';

test('video types validate ids/start/filename', () => {
  assert.equal(isVideoId('vid_' + 'a'.repeat(32)), true);
  assert.equal(isVideoId('vid_bad'), false);
  assert.equal(validateVideoStart({ session_id: 's', request_id: 'req_12345' }), undefined);
  assert.match(validateVideoStart({ session_id: '', request_id: 'req_12345' }), /session_id/);
  assert.match(validateVideoStart({ session_id: 's', request_id: 'short' }), /request_id/);
  assert.match(validateVideoStart({ session_id: 's', request_id: 'req_12345', quality: 'bad' }), /quality/);
  assert.equal(completeStop('user_stopped'), true);
  assert.equal(completeStop('tab_closed'), false);
  assert.equal(videoFilename({ title: 'a/b', created_at: 0 }), 'a b-1970-01-01T00-00-00-000Z.mp4');
  const publicValue = publicVideo({ id: 1, owner: 'o', capability: 'c', request_id: 'r' });
  assert.deepEqual(publicValue, { id: 1 });
  assert.equal(VIDEO_PRESETS.clear.maxDimension, 1920);
});

test('VideoTimeline gates fps and creates keyframes', () => {
  const timeline = new VideoTimeline(10, 5000);
  assert.equal(timeline.advance(50), null);
  assert.deepEqual(timeline.advance(100), { timestamp: 0, duration: 100000, keyFrame: true });
  assert.equal(timeline.advance(150), null);
  const second = timeline.advance(200);
  assert.equal(second.keyFrame, false);
  assert.equal(timeline.advance(9000).timestamp, 200000);
  assert.equal(timeline.durationMs, 5000);
});

test('videoDimensions scales/evens and rejects invalid', () => {
  assert.deepEqual(videoDimensions(1920, 1080, 1280), { width: 1280, height: 720 });
  assert.deepEqual(videoDimensions(1, 1, 1280), { width: 2, height: 2 });
  assert.throws(() => videoDimensions(0, 1, 1280), /invalid/);
});

test('videoEncoderConfig selects AVC level by macroblocks', () => {
  assert.equal(videoEncoderConfig(1280, 720, 'standard').codec, 'avc1.42002a');
  assert.equal(videoEncoderConfig(1920, 1920, 'clear').codec, 'avc1.420032');
  assert.equal(videoEncoderConfig(1920, 1920, 'clear').framerate, 30);
});
