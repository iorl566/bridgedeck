import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STITCH_DEFAULTS,
  acceptableOverlaps,
  analyzePlacements,
  describeStitch,
  gapsToCaptureRanges,
  normalizePlacements,
  planRenderLayout,
  stitchCoverage,
  stitchWire,
} from '../../extension/src/lib/longshot-stitch.js';
import { describeLayout, layoutCanvas, layoutWire, planLayoutWithEvidence, planStitch } from '../../extension/src/longshot-render.js';

test('normalizePlacements：缺字段收敛，保留 requestedY', () => {
  const placements = normalizePlacements([
    { drawY: 10, bitmapHeight: 100 },
    { drawY: -5, height: 50 },
    null,
  ]);
  assert.equal(placements.length, 3);
  assert.equal(placements[0].drawY, 10);
  assert.equal(placements[0].height, 100);
  assert.equal(placements[1].drawY, 0);
  assert.equal(placements[1].height, 50);
  assert.equal(placements[2].height, 1);
  assert.equal(normalizePlacements(null).length, 0);
});

test('analyzePlacements：无缝拼接 → coverage 100%', () => {
  const analysis = analyzePlacements([
    { drawY: 0, bitmapHeight: 800 },
    { drawY: 800, bitmapHeight: 800 },
    { drawY: 1600, bitmapHeight: 800 },
  ], { width: 1241, totalHeight: 2400 });
  assert.equal(analysis.ok, true);
  assert.equal(analysis.frames, 3);
  assert.equal(analysis.covered, 2400);
  assert.equal(analysis.coverageRatio, 1);
  assert.deepEqual(analysis.gaps, []);
  assert.deepEqual(analysis.overlaps, []);
  assert.equal(analysis.tail, 0);
  assert.equal(analysis.seamless, true);
  assert.equal(analysis.degraded, false);
  assert.match(analysis.signature, /^stitch:2400:/);
});

test('analyzePlacements：重叠与缺口都被量化', () => {
  const analysis = analyzePlacements([
    { drawY: 0, bitmapHeight: 800 },
    { drawY: 700, bitmapHeight: 800 },
    { drawY: 1600, bitmapHeight: 800 },
  ], { width: 100, totalHeight: 2400 });
  assert.equal(analysis.gaps.length, 1);
  assert.deepEqual(analysis.gaps[0], { from: 1500, to: 1600 });
  assert.equal(analysis.overlaps.length, 1);
  assert.equal(analysis.overlaps[0].by, 100);
  assert.equal(analysis.covered, 2300);
  assert.ok(analysis.coverageRatio < 1);
  assert.equal(analysis.seamless, false);
  // 95.8% < 98% 阈值 → degraded（缺口会被显式标出来，不静默）
  assert.equal(analysis.degraded, true);
  assert.equal(analysis.tail, 0);
});

test('analyzePlacements：明显缺帧 → degraded；尾部未覆盖 → tail', () => {
  const analysis = analyzePlacements([
    { drawY: 0, bitmapHeight: 800 },
  ], { width: 100, totalHeight: 5000 });
  assert.equal(analysis.gaps.length, 1);
  assert.deepEqual(analysis.gaps[0], { from: 800, to: 5000 });
  assert.equal(analysis.tail, 4200);
  assert.equal(analysis.degraded, true);
  assert.ok(analysis.coverageRatio < 0.2);
  assert.equal(analyzePlacements([], { width: 10, totalHeight: 10 }).ok, false);
});

test('analyzePlacements：drawY 被夹取（requestedY 不一致）→ clamped 证据', () => {
  const analysis = analyzePlacements([
    { drawY: 0, bitmapHeight: 100, requestedY: 0 },
    { drawY: 50, bitmapHeight: 100, requestedY: 200 },
  ], { width: 10, totalHeight: 200 });
  assert.equal(analysis.clamped, 1);
  assert.equal(analysis.degraded, true);
  const withinTolerance = analyzePlacements([
    { drawY: 0, bitmapHeight: 100, requestedY: 0 },
    { drawY: 51, bitmapHeight: 100, requestedY: 52 },
  ], { width: 10, totalHeight: 200, snapTolerance: 2 });
  assert.equal(withinTolerance.clamped, 0);
});

test('stitchCoverage：直接吃 frames（layout 之前可用）', () => {
  const coverage = stitchCoverage([{ drawY: 0, bitmapHeight: 50 }, { drawY: 50, bitmapHeight: 50 }], { width: 10, totalHeight: 100 });
  assert.equal(coverage.coverageRatio, 1);
  assert.equal(coverage.signature, 'stitch:100:0+50,50+50');
});

test('planRenderLayout：保留 requestedY/wasClamped 并给 coverage', () => {
  const layout = planRenderLayout([
    { drawY: 0, bitmapHeight: 100 },
    { drawY: 190, bitmapHeight: 100 },
  ], { width: 800, totalHeight: 200 });
  assert.equal(layout.width, 800);
  assert.equal(layout.height, 200);
  assert.equal(layout.placements[1].wasClamped, true);
  assert.equal(layout.placements[1].drawY, 100);
  assert.equal(layout.placements[1].requestedY, 190);
  assert.equal(layout.coverage.clamped, 1);
});

test('stitchWire：协议字段（计数 + 头几段证据）', () => {
  const analysis = analyzePlacements([
    { drawY: 0, bitmapHeight: 100 },
    { drawY: 100, bitmapHeight: 100 },
  ], { width: 50, totalHeight: 300 });
  const wire = stitchWire(analysis, { maxListed: 2 });
  assert.equal(wire.ok, true);
  assert.equal(wire.frames, 2);
  assert.equal(wire.height, 300);
  assert.equal(wire.gaps, 1);
  assert.equal(wire.gap_list.length, 1);
  assert.equal(wire.tail, 100);
  assert.equal(wire.seamless, false);
  assert.equal(stitchWire(null).ok, false);
});

test('describeStitch：无缝/缺段/叠段/尾部/夹取都能说清', () => {
  const seamless = analyzePlacements([{ drawY: 0, bitmapHeight: 100 }], { width: 1, totalHeight: 100 });
  assert.match(describeStitch(seamless), /拼接 1 帧 100px 覆盖 100%/);
  assert.match(describeStitch(seamless), /（无缝）/);
  const broken = analyzePlacements([
    { drawY: 0, bitmapHeight: 100, requestedY: 0 },
    { drawY: 90, bitmapHeight: 100 },
  ], { width: 1, totalHeight: 500 });
  const text = describeStitch(broken);
  assert.match(text, /缺 1 段/);
  assert.match(text, /叠 1 段/);
  assert.match(text, /尾部差/);
  assert.match(describeStitch(null), /拼接 无布局/);
  assert.match(describeStitch({ ok: false }), /拼接 空/);
});

test('gapsToCaptureRanges：缺口 → 补拍区间', () => {
  const ranges = gapsToCaptureRanges([{ from: 100, to: 300 }, { from: 400, to: 400 }], { minHeight: 10 });
  assert.deepEqual(ranges, [{ pageY: 100, pageHeight: 200 }]);
  assert.deepEqual(gapsToCaptureRanges(null), []);
});

test('acceptableOverlaps：半行取整级重叠可接受', () => {
  const analysis = analyzePlacements([
    { drawY: 0, bitmapHeight: 100 },
    { drawY: 99, bitmapHeight: 100 },
  ], { width: 1, totalHeight: 199 });
  assert.equal(acceptableOverlaps(analysis, { snapTolerance: 1 }).length, 1);
  assert.equal(acceptableOverlaps(analysis, { snapTolerance: 0 }).length, 0);
  assert.equal(STITCH_DEFAULTS.snapTolerance, 1);
});

test('layoutCanvas：既有字段不变 + 新增 coverage/stitch', () => {
  const layout = layoutCanvas([
    { drawY: 0, bitmapHeight: 100 },
    { drawY: 90, bitmapHeight: 100 },
  ], { width: 800, totalHeight: 150 });
  // 既有断言口径（历史测试）：width/height/placements 完全不变
  assert.equal(layout.width, 800);
  assert.equal(layout.height, 150);
  assert.deepEqual(layout.placements.map((item) => item.drawY), [0, 50]);
  // 新增字段
  assert.ok(layout.coverage);
  assert.equal(layout.stitch.frames, 2);
  assert.equal(layout.stitch.overlaps, 1);
  assert.equal(layout.stitch.height, 150);
  const empty = layoutCanvas([], { width: 10, totalHeight: 0 });
  assert.equal(empty.width, 10);
  assert.equal(empty.height, 1);
  assert.deepEqual(empty.placements, []);
  assert.equal(empty.stitch.frames, 0);
});

test('planStitch：旧分片按顺序拼接，并带覆盖摘要', () => {
  const layout = planStitch([{ height: 100 }, { height: 50 }], { width: 10 });
  assert.equal(layout.height, 150);
  assert.deepEqual(layout.placements.map((item) => item.drawY), [0, 100]);
  assert.equal(layout.stitch.seamless, true);
  const explicit = planStitch([{ drawY: 0, height: 100 }, { drawY: 90, height: 100 }], { width: 10 });
  assert.deepEqual(explicit.placements.map((item) => item.drawY), [0, 90]);
  assert.equal(explicit.stitch.overlaps, 1);
});

test('layoutWire/describeLayout/planLayoutWithEvidence：运行时辅助', () => {
  const layout = layoutCanvas([{ drawY: 0, bitmapHeight: 100 }], { width: 50, totalHeight: 100 });
  const wire = layoutWire(layout);
  assert.equal(wire.width, 50);
  assert.equal(wire.height, 100);
  assert.equal(wire.frames, 1);
  assert.equal(wire.coverage_ratio, 1);
  assert.equal(wire.seamless, true);
  assert.match(describeLayout(layout), /拼接 1 帧 100px/);
  assert.match(describeLayout(null), /拼接 无布局/);
  const evidence = planLayoutWithEvidence([{ drawY: 190, bitmapHeight: 100 }], { width: 10, totalHeight: 200 });
  assert.equal(evidence.placements[0].wasClamped, true);
});
