import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameClock, VideoTimeline, videoDimensions } from '../../lib/video-timeline.mjs';

test('VideoTimeline emits fps-gated chunks and keyframes', () => {
  const timeline = new VideoTimeline(10, 5000);
  assert.equal(timeline.advance(50), null);
  const first = timeline.advance(100);
  assert.equal(first.keyFrame, true);
  assert.equal(first.timestamp, 0);
  assert.equal(first.duration, 100000);
  const second = timeline.advance(200);
  assert.equal(second.keyFrame, false);
  assert.equal(timeline.durationMs, 200);
});

test('VideoTimeline honors final and limit', () => {
  const timeline = new VideoTimeline(30, 1000);
  timeline.advance(500);
  const final = timeline.advance(5000, true);
  assert.equal(final.timestamp, 500000);
  assert.equal(timeline.durationMs, 1000);
  assert.equal(timeline.advance(1500, true), null);
});

test('videoDimensions and FrameClock normalize', () => {
  assert.deepEqual(videoDimensions(1920, 1080, 1280), { width: 1280, height: 720 });
  assert.throws(() => videoDimensions(0, 0, 100));
  const clock = new FrameClock();
  assert.equal(clock.elapsed(10, 1000), 1000);
  assert.equal(clock.elapsed(10.5, 1500), 1500);
  assert.equal(clock.elapsed(undefined, 1600), 1600);
});
