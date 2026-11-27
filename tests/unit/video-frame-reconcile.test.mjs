// tests/unit/video-frame-reconcile.test.mjs
// 第十一批-E：视频时间轴帧级对账（lib/video-frame-reconcile.js）。
// 覆盖：帧归一化/签名/摘要、期望时间轴、丢帧/重叠/PTS 非单调/重复 PTS/尾部、
//       关键帧间隔、覆盖比例、修复建议、wire/describe。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIDEO_FRAME_CODES,
  VIDEO_FRAME_DEFAULTS,
  VIDEO_FRAME_VERSION,
  describeVideoFrames,
  expectedTimeline,
  normalizeVideoFrame,
  planVideoFrameRepair,
  reconcileVideoFrames,
  videoFrameDigest,
  videoFrameSignature,
  videoFrameWire,
} from '../../extension/src/lib/video-frame-reconcile.js';

function frame(index, tMs, extra = {}) {
  return { index, tMs, durationMs: 33, keyframe: index % 30 === 0, bytes: 100, hash: 'h' + index, ...extra };
}

function timeline(count, { fps = 30, startMs = 0 } = {}) {
  const frameMs = 1000 / fps;
  return Array.from({ length: count }, (_, index) => ({
    index,
    tMs: Math.round(startMs + index * frameMs),
    durationMs: Math.round(frameMs),
    keyframe: index % 30 === 0,
    bytes: 100,
    hash: 'h' + index,
  }));
}

test('常量：版本/问题码/默认值形状稳定', () => {
  assert.equal(VIDEO_FRAME_VERSION, 1);
  for (const code of Object.values(VIDEO_FRAME_CODES)) assert.match(code, /^video\.frames\./);
  assert.equal(VIDEO_FRAME_DEFAULTS.fps, 30);
  assert.ok(VIDEO_FRAME_DEFAULTS.toleranceFrames > 0);
  assert.ok(VIDEO_FRAME_DEFAULTS.maxKeyframeGapMs > 0);
});

test('normalizeVideoFrame：tMs/pts/startMs 别名、时长缺省按 fps、非法给理由', () => {
  assert.equal(normalizeVideoFrame(null).ok, false);
  assert.equal(normalizeVideoFrame({}).reason, 'bad-index');
  assert.equal(normalizeVideoFrame({ index: 0, durationMs: 0 }).ok, true, '时长 0 会被缺省补齐');
  const fromPts = normalizeVideoFrame({ index: 2, pts: 66, duration: 33, keyframe: true, size: 500 });
  assert.equal(fromPts.ok, true);
  assert.equal(fromPts.frame.startMs, 66);
  assert.equal(fromPts.frame.durationMs, 33);
  assert.equal(fromPts.frame.endMs, 99);
  assert.equal(fromPts.frame.keyframe, true);
  assert.equal(fromPts.frame.bytes, 500);
  const defaultDuration = normalizeVideoFrame({ index: 0, tMs: 10 }, { fps: 60 });
  assert.equal(defaultDuration.frame.durationMs, 17);
  assert.equal(normalizeVideoFrame({ index: 0, startMs: -5, durationMs: 10 }).frame.startMs, 0);
});

test('videoFrameSignature/videoFrameDigest：确定性、对时间/关键帧敏感', () => {
  const a = frame(0, 0);
  assert.equal(videoFrameSignature(a), videoFrameSignature({ ...a }));
  assert.notEqual(videoFrameSignature(a), videoFrameSignature({ ...a, tMs: 33 }));
  const list = timeline(3);
  assert.equal(videoFrameDigest(list), videoFrameDigest(list.map((item) => ({ ...item }))));
  assert.notEqual(videoFrameDigest(list), videoFrameDigest([...list].reverse()));
  assert.match(videoFrameDigest([]), /^[0-9a-f]{16}$/);
});

test('expectedTimeline：按 fps/时长分帧，尾部取剩余时长', () => {
  const timeline30 = expectedTimeline({ fps: 30, durationMs: 100 });
  assert.equal(timeline30.length, 3);
  assert.deepEqual(timeline30.map((item) => item.startMs), [0, 33, 67]);
  assert.equal(timeline30[0].endMs, 33);
  assert.deepEqual(expectedTimeline({ fps: 30, durationMs: 0 }), []);
  assert.deepEqual(expectedTimeline({}), []);
  const started = expectedTimeline({ fps: 10, durationMs: 250, startMs: 1000 });
  assert.equal(started[0].startMs, 1000);
  assert.equal(started[started.length - 1].endMs, 1250);
});

test('reconcileVideoFrames：等间隔完整 60 帧 → ok/accept', () => {
  const frames = timeline(60);
  const report = reconcileVideoFrames({ frames, durationMs: 1990, fps: 30 });
  assert.equal(report.ok, true);
  assert.equal(report.action, 'accept');
  assert.equal(report.counts.frames, 60);
  assert.equal(report.counts.gaps, 0);
  assert.equal(report.counts.droppedMs, 0);
  assert.equal(report.counts.keyframes, 2);
  assert.equal(report.coverage.ratio >= 0.99, true);
  assert.match(report.digest, /^[0-9a-f]{16}$/);
  assert.match(describeVideoFrames(report), /视频帧对账 ok/);
});

test('reconcileVideoFrames：丢帧区间被量化，droppedRatio 进入 error', () => {
  const frames = [frame(0, 0), frame(1, 100), frame(2, 200)];
  const report = reconcileVideoFrames({ frames, durationMs: 210, fps: 30 });
  assert.equal(report.ok, false);
  assert.equal(report.action, 'reencode');
  assert.equal(report.counts.gaps >= 2, true);
  assert.ok(report.counts.droppedMs > 0);
  assert.ok(report.coverage.gapCount >= 2);
  assert.ok(report.findings.some((finding) => finding.code === VIDEO_FRAME_CODES.DROPPED && finding.severity === 'error'));
  assert.equal(report.severity, 'error');
});

test('reconcileVideoFrames：少量丢帧 → warn + pad 修复建议', () => {
  const frames = timeline(300).filter((item, index) => index < 250 || index > 252);
  const report = reconcileVideoFrames({ frames, durationMs: 10_000, fps: 30 });
  assert.equal(report.ok, true, '少量丢帧不翻转 ok');
  assert.equal(report.action, 'accept');
  const repair = planVideoFrameRepair(report);
  assert.equal(repair.action, report.action);
  assert.equal(repair.rangeCount, report.gaps.length);
  assert.ok(repair.reasons.length > 0);
});

test('reconcileVideoFrames：PTS 非单调/重复 PTS/乱序都被归因', () => {
  const frames = [frame(0, 0), frame(1, 66), frame(2, 33), frame(3, 33), frame(4, 99)];
  const report = reconcileVideoFrames({ frames, durationMs: 132, fps: 30 });
  assert.ok(report.findings.some((finding) => finding.code === VIDEO_FRAME_CODES.NON_MONOTONIC));
  assert.ok(report.findings.some((finding) => finding.code === VIDEO_FRAME_CODES.DUPLICATE_PTS));
  assert.equal(report.counts.duplicates >= 1, true);
  assert.equal(report.counts.nonMonotonic >= 1, true);
});

test('reconcileVideoFrames：关键帧缺失/稀疏提示；尾部未覆盖', () => {
  const noKeyframes = timeline(10).map((item) => ({ ...item, keyframe: false }));
  const report = reconcileVideoFrames({ frames: noKeyframes, durationMs: 330, fps: 30 });
  assert.ok(report.findings.some((finding) => finding.code === VIDEO_FRAME_CODES.KEYFRAME_GAP));
  assert.equal(report.counts.keyframes, 0);
  const sparse = [frame(0, 0, { keyframe: true }), frame(1, 5000, { keyframe: true })];
  const sparseReport = reconcileVideoFrames({ frames: sparse, durationMs: 5033, fps: 30 });
  assert.ok(sparseReport.counts.maxKeyframeGapMs >= 5000);
});

test('reconcileVideoFrames：空帧/非法帧稳定降级', () => {
  const empty = reconcileVideoFrames({});
  assert.equal(empty.counts.frames, 0);
  assert.equal(empty.action, 'accept');
  assert.ok(empty.findings.some((finding) => finding.code === VIDEO_FRAME_CODES.EMPTY));
  const invalid = reconcileVideoFrames({ frames: [null, { index: 0 }, { index: 1, durationMs: 0, tMs: 10 }], durationMs: 43 });
  assert.equal(invalid.counts.invalid >= 1, true);
  assert.ok(invalid.findings.some((finding) => finding.code === VIDEO_FRAME_CODES.INVALID));
});

test('planVideoFrameRepair：reencode 区间策略 / 空报告 restart', () => {
  const report = reconcileVideoFrames({ frames: [frame(0, 0)], durationMs: 500, fps: 30 });
  const repair = planVideoFrameRepair(report);
  assert.equal(repair.action, 'reencode');
  assert.equal(repair.ranges.length, report.gaps.length);
  assert.ok(repair.ranges.every((range) => range.strategy === 'reencode'));
  assert.ok(repair.coveredMs > 0);
  assert.equal(planVideoFrameRepair(null).action, 'restart');
  const accept = planVideoFrameRepair(reconcileVideoFrames({ frames: timeline(60), durationMs: 1990 }));
  assert.equal(accept.action, 'accept');
  assert.deepEqual(accept.ranges, []);
});

test('videoFrameWire/describeVideoFrames：截断列表、计数完整', () => {
  const report = reconcileVideoFrames({ frames: [frame(0, 0), frame(1, 100)], durationMs: 200, fps: 30 });
  const wire = videoFrameWire(report, { maxListed: 1 });
  assert.equal(wire.version, VIDEO_FRAME_VERSION);
  assert.equal(wire.counts.frames, 2);
  assert.equal(wire.gaps.length <= 1, true);
  assert.equal(wire.findings.length <= 1, true);
  assert.match(wire.text, /视频帧对账/);
  assert.match(describeVideoFrames(report), /覆盖/);
  assert.equal(videoFrameWire(null).ok, false);
  assert.match(describeVideoFrames(null), /无/);
});
