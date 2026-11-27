// tests/unit/capture-upgrade-crosspath.test.mjs
// 第十一批-E 跨路径不变量：默认输出不变 + 新证据在“非默认输入”下也稳定（不抛/不伪造）。
// 覆盖：layoutCanvas 多帧/截断画布、segmentPlanWire 分数 DPR、manifestSummary 分数 DPR、
//       persistenceBrief 空/封版、persistenceVerifyView 老记录、summarizeRestore 封版跳过。
import test from 'node:test';
import assert from 'node:assert/strict';

import { layoutCanvas } from '../../extension/src/longshot-render.js';
import { planLongshotSegments, segmentPlanWire } from '../../extension/src/lib/longshot-segments.js';
import { appendSegment, buildLongshotManifest, manifestSummary, sealManifest } from '../../extension/src/lib/longshot-manifest.js';
import { persistenceBrief, persistenceVerifyView } from '../../extension/src/lib/video-persist-view.js';
import { createPersistenceSession, sealPersistence } from '../../extension/src/lib/video-persist.js';
import { planPartialReassembly, summarizeRestore } from '../../extension/src/lib/video-restore.js';

test('layoutCanvas：40 帧无缝长图只加字段、与既有字段一致', () => {
  const frames = Array.from({ length: 40 }, (_, index) => ({ drawY: index * 1000, bitmapHeight: 1000 }));
  const layout = layoutCanvas(frames, { width: 1241, totalHeight: 40_000 });
  assert.equal(layout.width, 1241);
  assert.equal(layout.height, 40_000);
  assert.equal(layout.placements.length, 40);
  assert.equal(layout.coverage.coverageRatio, 1);
  assert.equal(layout.stitch.seamless, true);
  assert.equal(layout.frames.counts.expected, 40);
  assert.equal(layout.frames.counts.matched, 40);
  assert.equal(layout.repaint.action, 'skip');
});

test('layoutCanvas：帧数被上限截断（画布比页面矮）不误报尾部未覆盖', () => {
  const frames = Array.from({ length: 3 }, (_, index) => ({ drawY: index * 4000, bitmapHeight: 4000 }));
  const layout = layoutCanvas(frames, { width: 800, totalHeight: 120_000 });
  assert.equal(layout.height, 12_000, '按实际捕获高度出图');
  assert.equal(layout.frames.ok, true);
  assert.equal(layout.frames.findings.length, 0, '截断是预期行为，不应被帧对账报错');
  assert.equal(layout.repaint.action, 'skip');
});

test('layoutCanvas：帧重叠/空帧/非法帧输入稳定', () => {
  const overlap = layoutCanvas([
    { drawY: 0, bitmapHeight: 100 },
    { drawY: 50, bitmapHeight: 100 },
  ], { width: 100, totalHeight: 100 });
  assert.equal(overlap.height, 100);
  assert.equal(overlap.coverage.overlaps.length >= 1, true);
  assert.equal(typeof overlap.frames.ok, 'boolean');
  const weird = layoutCanvas([{ drawY: -10, bitmapHeight: 0 }, { drawY: NaN, bitmapHeight: NaN }], { width: 10, totalHeight: 10 });
  assert.equal(weird.placements.length, 2);
  assert.equal(weird.frames.counts.expected, 2);
});

test('segmentPlanWire：分数 DPR 段身份稳定且旧字段口径不变', () => {
  const plan = planLongshotSegments({ deviceWidth: 1862, deviceHeight: 33_750, dpr: 1.5, fixedTop: 84, fixedBottom: 120 });
  assert.equal(plan.fractional, true);
  const wires = plan.segments.map((segment) => segmentPlanWire(segment));
  assert.equal(wires.length, plan.totalSegments);
  for (const wire of wires) {
    assert.match(wire.frame_sig, /^[0-9a-f]{16}$/);
    assert.equal(wire.dpr, 1.5);
    assert.equal(wire.frame_id, 'longshot-segment#' + wire.index);
  }
  // 段身份不能随调用次数变化
  assert.equal(segmentPlanWire(plan.segments[0]).frame_sig, wires[0].frame_sig);
});

test('manifestSummary：分数 DPR + 未封版 + 缺号 都只加派生字段', () => {
  const manifest = appendSegment(buildLongshotManifest({
    captureId: 'frac-1',
    dpr: 1.5,
    width: 1862,
    height: 33_750,
    total: 3,
  }), { index: 0, offset: 0, bytes: 100, hash: 'aaaaaaaaaaaaaaaa', width: 1862, height: 11_250 });
  const summary = manifestSummary(manifest);
  assert.equal(summary.dpr, 1.5);
  assert.equal(summary.sealed, false);
  assert.equal(summary.captured, 1);
  assert.equal(summary.frames.missing.length, 2);
  assert.equal(summary.frames.ok, false);
  assert.ok(summary.storage.totalBytes > 0);
  assert.equal(summary.storage.ok, true);
});

test('manifestSummary：封版完整 manifest 不再报缺号（派生对账自洽）', () => {
  const built = buildLongshotManifest({ captureId: 'frac-2', dpr: 1.5, width: 1862, height: 11_250, total: 1 });
  const sealed = sealManifest(appendSegment(built, {
    index: 0, offset: 0, bytes: 100, hash: 'bbbbbbbbbbbbbbbb', width: 1862, height: 11_250,
  }), { now: 5000 });
  const summary = manifestSummary(sealed);
  assert.equal(summary.sealed, true);
  assert.equal(summary.frames.ok, true);
  assert.equal(summary.frames.presentRatio, 1);
  assert.equal(summary.frames.coverage.seamless, true);
});

test('persistenceBrief：空会话/封版会话的新证据都稳定（无帧不编造）', () => {
  const empty = createPersistenceSession({ recordingId: 'empty-1', now: 1000 });
  const emptyBrief = persistenceBrief(empty);
  assert.equal(emptyBrief.frames, 0);
  assert.equal(emptyBrief.frame_axis.counts.frames, 0);
  assert.equal(emptyBrief.frame_axis.counts.expected, 0);
  assert.equal(emptyBrief.video_evidence.repair.action, 'accept');
  assert.equal(emptyBrief.segment_budget.segments, 0);

  const session = createPersistenceSession({ recordingId: 'seal-1', now: 1000, mime: 'video/mp4' });
  const sealed = sealPersistence(session, { now: 2000, totalBytes: 10_000 });
  const sealedBrief = persistenceBrief(sealed.session);
  assert.equal(['sealed', 'failed', 'degraded', 'recording'].includes(sealedBrief.state), true);
  assert.equal(sealedBrief.frames, 0);
  assert.equal(sealedBrief.mux_budget.durationMs, 0);
  assert.equal(sealedBrief.mux_budget.fragmentCount, 0);
});

test('persistenceVerifyView：老记录/no-journal 返回既有语义，新证据为 null 或零值', () => {
  const legacy = persistenceVerifyView({ id: 'legacy', bytes: 10 }, { now: 1000 });
  assert.ok(legacy === null || legacy.state === 'recording' || legacy.state === 'unknown');
  if (legacy) {
    assert.equal(legacy.transcode_budget, null, '没有宽高不伪造转码预算');
    assert.equal(legacy.video_evidence.frames === null || legacy.video_evidence.frames !== undefined, true);
  }
  assert.equal(persistenceVerifyView(null), null);
});

test('summarizeRestore：封版跳过 → 旧摘要语义不变，新预算字段仍可序列化', () => {
  const manifest = {
    version: 2,
    recordingId: 'seal-2',
    sealed: true,
    segments: [{ index: 0, bytes: 100, checksum: 'sha0', tMs: 0, durationMs: 200 }],
  };
  const plan = planPartialReassembly(manifest, [{ index: 0, bytes: 100, checksum: 'sha0', position: 0 }], {
    recordingId: 'seal-2',
    now: 1000,
  });
  assert.equal(plan.strategy, 'sealed');
  const summary = summarizeRestore(plan);
  assert.equal(summary.strategy, 'sealed');
  assert.equal(summary.nextAction, 'skip');
  assert.equal(summary.sealed, true);
  assert.equal(summary.assembledBytes, 0);
  assert.equal(summary.mux_budget.fragmentCount, 0);
  assert.equal(typeof summary.segment_budget.action, 'string');
  // 序列化不丢字段（wire 层））
  assert.equal(JSON.parse(JSON.stringify(summary)).segment_budget.version, 1);
});

test('summarizeRestore：空/非法 plan 返回 null（不伪造）', () => {
  assert.equal(summarizeRestore(null), null);
  assert.equal(summarizeRestore(undefined), null);
  assert.equal(summarizeRestore({}).mux_budget.fragmentCount, 0);
});
