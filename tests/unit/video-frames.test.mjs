import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_CODES,
  FRAME_DEFAULTS,
  FRAME_VERSION,
  classifyFrameProblems,
  describeFrames,
  estimateFps,
  frameChainDigest,
  frameChecksumChain,
  frameDigestOf,
  frameReport,
  framesFromRecord,
  keyframeStats,
  normalizeFrame,
  planFrameRepair,
  summarizeFrames,
  validateFrameSequence,
} from '../../extension/src/lib/video-frames.js';

function framesOf(count, { step = 200, duration = 200, gop = 30, bytes = 5000 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    pts: index * step,
    durationMs: duration,
    // gop:0 表示“一个关键帧都没有”（用于卡死/不可 seek 场景）
    keyframe: gop > 0 && index % gop === 0,
    bytes,
    checksum: ('c' + index).padEnd(16, '0'),
    width: 1280,
    height: 720,
  }));
}

test('normalizeFrame：字段别名归一化', () => {
  assert.equal(normalizeFrame({ pts: 100, duration: 50, key: true, size: 10, hash: 'AB' }).tMs, 100);
  assert.equal(normalizeFrame({ tMs: 200 }).tMs, 200);
  assert.equal(normalizeFrame({ timestamp: 300 }).tMs, 300);
  assert.equal(normalizeFrame({ timeMs: 400 }).tMs, 400);
  assert.equal(normalizeFrame({ durationMs: 33 }).durationMs, 33);
  assert.equal(normalizeFrame({ sync: true }).keyframe, true);
  assert.equal(normalizeFrame({ checksum: 'DEAD' }).checksum, 'dead');
  assert.equal(normalizeFrame({}, 5).index, 5);
  assert.equal(normalizeFrame({ pts: -10 }).tMs, 0);
});

test('validateFrameSequence：单调序列通过', () => {
  const report = validateFrameSequence(framesOf(30));
  assert.equal(report.ok, true);
  assert.equal(report.frames, 30);
  assert.equal(report.monotonic, true);
  assert.equal(report.regressions, 0);
  assert.equal(report.duplicateTimestamps, 0);
  assert.equal(report.gaps, 0);
  assert.equal(report.durationMs, 29 * 200);
  assert.equal(report.coverageRatio, 1);
  assert.equal(report.digest.length, 16);
  assert.equal(report.lastAt, 29 * 200);
});

test('validateFrameSequence：空帧/时间戳倒退/重复/间隔', () => {
  const empty = validateFrameSequence([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.problems[0].code, FRAME_CODES.EMPTY);
  const frames = framesOf(4);
  frames[2].pts = 100;
  const regression = validateFrameSequence(frames);
  assert.equal(regression.ok, false);
  assert.equal(regression.monotonic, false);
  assert.equal(regression.regressions, 1);
  assert.ok(regression.problems.some((problem) => problem.code === FRAME_CODES.TIMESTAMP_REGRESSION));
  const duplicated = framesOf(3);
  duplicated[2].pts = duplicated[1].pts;
  const dup = validateFrameSequence(duplicated);
  assert.equal(dup.duplicateTimestamps, 1);
  assert.ok(dup.problems.some((problem) => problem.code === FRAME_CODES.TIMESTAMP_DUPLICATE));
  const gap = framesOf(3);
  gap[2].pts = 4000;
  const gapped = validateFrameSequence(gap);
  assert.equal(gapped.gaps, 1);
  assert.ok(gapped.problems.some((problem) => problem.code === FRAME_CODES.GAP));
});

test('validateFrameSequence：时长/字节/checksum/尺寸问题', () => {
  const frames = framesOf(3);
  frames[0].durationMs = 0;
  frames[1].durationMs = 9000;
  frames[2].bytes = 0;
  frames[2].checksum = '';
  frames[1].width = 640;
  const report = validateFrameSequence(frames);
  const codes = report.problems.map((problem) => problem.code);
  assert.ok(codes.includes(FRAME_CODES.DURATION_ZERO));
  assert.ok(codes.includes(FRAME_CODES.DURATION_INVALID));
  assert.ok(codes.includes(FRAME_CODES.BYTES_ZERO));
  assert.ok(codes.includes(FRAME_CODES.CHECKSUM_MISSING));
  assert.ok(codes.includes(FRAME_CODES.DIMENSION));
  assert.equal(report.ok, false, '尺寸不一致是致命问题');
});

test('keyframeStats：GOP 长度/首个关键帧/长 GOP', () => {
  const stats = keyframeStats(framesOf(100, { gop: 30 }));
  assert.equal(stats.frames, 100);
  assert.equal(stats.keyframes, 4);
  assert.equal(stats.firstKeyframe, 0);
  assert.equal(stats.maxGop, 30);
  assert.equal(stats.longGop, false);
  const long = keyframeStats(framesOf(100, { gop: 0 }), { maxGopFrames: 10 });
  assert.equal(long.longGop, true);
  const noKey = keyframeStats(framesOf(5, { gop: 0 }));
  assert.equal(noKey.noKeyframe, true);
  assert.equal(noKey.firstKeyframe, -1);
  assert.equal(keyframeStats([]).frames, 0);
});

test('estimateFps：中位数抗抖动，抖动比与稳定判定', () => {
  const steady = estimateFps(framesOf(30, { step: 200 }));
  assert.equal(steady.fps, 5);
  assert.equal(steady.medianDeltaMs, 200);
  assert.equal(steady.stable, true);
  assert.equal(steady.samples, 29);
  const jittery = estimateFps([
    { pts: 0 }, { pts: 100 }, { pts: 300 }, { pts: 400 }, { pts: 700 }, { pts: 800 },
  ]);
  assert.equal(jittery.medianDeltaMs, 100);
  assert.equal(jittery.stable, false);
  assert.equal(estimateFps([]).fps, 0);
  assert.equal(estimateFps([{ pts: 0 }]).fps, 0);
});

test('frameChecksumChain：全帧有 checksum 才 ok；缺 checksum 计数', () => {
  const chain = frameChecksumChain(framesOf(4));
  assert.equal(chain.ok, true);
  assert.equal(chain.checked, 4);
  assert.equal(chain.missing, 0);
  assert.equal(chain.chain.length, 16);
  assert.equal(chain.partial, false);
  const missing = frameChecksumChain([...framesOf(2), { pts: 400 }]);
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, 1);
  const partial = frameChecksumChain(framesOf(10), { maxChainFrames: 3 });
  assert.equal(partial.checked, 3);
  assert.equal(partial.partial, true);
});

test('frameChainDigest / frameDigestOf：确定性', () => {
  const frames = framesOf(3);
  assert.equal(frameChainDigest(frames), frameChainDigest(frames.map((frame) => ({ ...frame }))));
  assert.notEqual(frameChainDigest(frames), frameChainDigest(framesOf(4)));
  assert.equal(frameDigestOf('x').length, 16);
  assert.notEqual(frameDigestOf('x'), frameDigestOf('y'));
});

test('classifyFrameProblems：致命/可修/可接受分类', () => {
  const classification = classifyFrameProblems([
    { code: FRAME_CODES.TIMESTAMP_REGRESSION },
    { code: FRAME_CODES.TIMESTAMP_DUPLICATE },
    { code: FRAME_CODES.GAP },
    { code: FRAME_CODES.GOP_LONG },
  ]);
  assert.equal(classification.fatal, 1);
  assert.equal(classification.repairable, 1);
  assert.equal(classification.acceptable, 2);
  assert.equal(classification.playable, false);
  assert.equal(classification.needsRepair, true);
  const onlyAcceptable = classifyFrameProblems([{ code: FRAME_CODES.GAP }]);
  assert.equal(onlyAcceptable.playable, true);
  assert.equal(onlyAcceptable.needsRepair, false);
});

test('planFrameRepair：无问题 → accept；重复时间戳 → drop；致命 → abort+trim', () => {
  const healthy = planFrameRepair(framesOf(5));
  assert.equal(healthy.ok, true);
  assert.equal(healthy.action, 'accept');
  assert.deepEqual(healthy.dropIndexes, []);
  const frames = framesOf(4);
  frames[2].pts = frames[1].pts;
  const repair = planFrameRepair(frames);
  assert.equal(repair.ok, true);
  assert.deepEqual(repair.dropIndexes, [2]);
  assert.ok(repair.steps.some((step) => step.action === 'drop'));
  const fatal = framesOf(4);
  fatal[2].pts = 0;
  const aborted = planFrameRepair(fatal);
  assert.equal(aborted.ok, false);
  assert.equal(aborted.action, 'abort');
  assert.ok(aborted.trimToMs > 0);
  assert.ok(aborted.notes.some((note) => note.includes('有效前缀')));
  const empty = planFrameRepair([]);
  assert.equal(empty.action, 'abort');
  assert.deepEqual(empty.dropIndexes, []);
});

test('planFrameRepair：零字节/坏 checksum → reencode；零时长 → rewrite-duration', () => {
  const frames = framesOf(3);
  frames[1].bytes = 0;
  frames[2].durationMs = 0;
  const repair = planFrameRepair(frames);
  assert.ok(repair.steps.some((step) => step.action === 'reencode'));
  assert.ok(repair.steps.some((step) => step.action === 'rewrite-duration'));
  assert.equal(repair.action, 'rewrite');
});

test('frameReport：综合报告（可播放/卡死/修复）', () => {
  const report = frameReport(framesOf(60, { gop: 30 }));
  assert.equal(report.version, FRAME_VERSION);
  assert.equal(report.ok, true);
  assert.equal(report.playable, true);
  assert.equal(report.stuck, false);
  assert.equal(report.keyframes.keyframes, 2);
  assert.equal(report.repair.action, 'accept');
  const noKey = frameReport(framesOf(10, { gop: 0 }));
  assert.equal(noKey.stuck, true);
  assert.equal(noKey.playable, false);
  const noRepair = frameReport(framesOf(3), { planRepair: false });
  assert.equal(noRepair.repair, null);
});

test('summarizeFrames / describeFrames：协议与日志', () => {
  const report = frameReport(framesOf(30));
  const summary = summarizeFrames(report);
  assert.equal(summary.version, FRAME_VERSION);
  assert.equal(summary.frames, 30);
  assert.equal(summary.fps, 5);
  assert.equal(summary.keyframes, 1);
  assert.equal(summary.monotonic, true);
  assert.equal(summary.problem_count, 0);
  assert.equal(summary.repair.action, 'accept');
  assert.equal(summarizeFrames(null), null);
  assert.match(describeFrames(report), /帧校验 30 帧 \/ 5fps \/ 单调/);
  assert.match(describeFrames(null), /帧校验 无/);
  const bad = frameReport(framesOf(3, { gop: 0 }));
  assert.match(describeFrames(bad), /（不可播）/);
});

test('framesFromRecord：从 record/fragments 提取帧元数据', () => {
  const direct = framesFromRecord({ frames: framesOf(2) });
  assert.equal(direct.length, 2);
  const nested = framesFromRecord({
    fragments: [
      { index: 0, frames: [{ pts: 0, durationMs: 100 }, { pts: 100, durationMs: 100 }] },
      { index: 1, frames: [{ pts: 200 }] },
    ],
  });
  assert.equal(nested.length, 3);
  assert.equal(nested[2].fragmentIndex, 1);
  assert.deepEqual(framesFromRecord(null), []);
  assert.deepEqual(framesFromRecord({ fragments: [{ index: 0 }] }), []);
});

test('默认常量稳定', () => {
  assert.equal(FRAME_DEFAULTS.maxGapMs, 500);
  assert.equal(FRAME_DEFAULTS.maxChainFrames, 8192);
  assert.ok(Object.keys(FRAME_CODES).length >= 10);
});
