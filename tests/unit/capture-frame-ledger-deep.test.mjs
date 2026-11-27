// tests/unit/capture-frame-ledger-deep.test.mjs
// 第十一批-E 深度：帧台账/对账内核的边界与新增窗口/直方图/集合对比/覆盖改善工具。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendFrame,
  buildFrameIndex,
  compareFrameSets,
  coverageDelta,
  coverageWire,
  createFrameLedger,
  expectedFramesFromPlan,
  frameCoverage,
  frameDigest,
  frameHistogram,
  frameKey,
  frameLedgerFromFrames,
  frameSignatureDigest,
  groupFramesByKind,
  hashFrameBytes,
  mergeFrameIntervals,
  reconcileFrames,
  selectFrameWindow,
  worstCoverageGap,
} from '../../extension/src/lib/capture-frame-ledger.js';

const seg = (index, pageY, pageHeight = 100, extra = {}) => ({
  kind: 'longshot-segment', index, pageY, drawY: pageY, pageHeight, drawHeight: pageHeight, width: 800, dpr: 1, ...extra,
});
const tile = (index, pageY, pageHeight = 100, extra = {}) => ({
  kind: 'longshot-tile', index, pageY, drawY: pageY, pageHeight, drawHeight: pageHeight, width: 512, dpr: 1, ...extra,
});

test('frameKey/groupFramesByKind：稳定主键与分组顺序', () => {
  assert.equal(frameKey(seg(3, 300)), 'longshot-segment#3');
  assert.equal(frameKey(tile(1, 100)), 'longshot-tile#1');
  const groups = groupFramesByKind([
    tile(0, 0),
    seg(0, 0),
    tile(1, 100),
    null,
  ]);
  assert.deepEqual([...groups.keys()], ['longshot-tile', 'longshot-segment']);
  assert.equal(groups.get('longshot-tile').length, 2);
  assert.equal(groupFramesByKind(null).size, 0);
});

test('frameHistogram：kind/role/state 计数 + 字节/像素合计 + 非法计数', () => {
  const histogram = frameHistogram([
    seg(0, 0, 100, { role: 'first', bytes: 10, state: 'verified' }),
    seg(1, 100, 100, { role: 'middle', bytes: 20 }),
    tile(0, 0, 50, { bytes: 5 }),
    { index: 'bad' },
    null,
  ]);
  assert.equal(histogram.frames, 3);
  assert.equal(histogram.invalid, 2);
  assert.equal(histogram.byKind['longshot-segment'], 2);
  assert.equal(histogram.byKind['longshot-tile'], 1);
  assert.equal(histogram.byRole.first, 1);
  assert.equal(histogram.byState.verified, 1);
  assert.equal(histogram.bytes, 35);
  assert.equal(histogram.pixels, 2 * 800 * 100 + 512 * 50);
  assert.deepEqual(frameHistogram([]).byKind, {});
});

test('selectFrameWindow：kind 过滤 + index 区间 + 数量截断', () => {
  const frames = [seg(2, 200), seg(0, 0), seg(1, 100), tile(5, 0)];
  const window = selectFrameWindow(frames, { kind: 'longshot-segment', fromIndex: 1, toIndex: 2 });
  assert.deepEqual(window.indexes, [1, 2]);
  assert.equal(window.total, 2);
  assert.equal(window.truncated, false);
  const limited = selectFrameWindow(frames, { max: 2 });
  assert.equal(limited.returned, 2);
  assert.equal(limited.truncated, true);
  const all = selectFrameWindow(frames, {});
  assert.deepEqual(all.indexes, [0, 1, 2, 5]);
  assert.deepEqual(selectFrameWindow(null, {}).frames, []);
});

test('compareFrameSets：新增/移除/替换/相同', () => {
  const before = [seg(0, 0, 100, { hash: 'aaaaaaaaaaaaaaaa' }), seg(1, 100, 100, { hash: 'bbbbbbbbbbbbbbbb' })];
  const after = [seg(1, 100, 100, { hash: 'cccccccccccccccc' }), seg(2, 200, 100, { hash: 'dddddddddddddddd' })];
  const diff = compareFrameSets(before, after);
  assert.deepEqual(diff.added.map((item) => item.index), [2]);
  assert.deepEqual(diff.removed.map((item) => item.index), [0]);
  assert.deepEqual(diff.changed.map((item) => item.index), [1]);
  assert.equal(diff.ok, false);
  assert.equal(diff.common, 1);
  assert.equal(diff.changedRatio, 0.5);
  const same = compareFrameSets(before, before.map((frame) => ({ ...frame })));
  assert.equal(same.ok, true);
  assert.equal(compareFrameSets(null, null).ok, true);
});

test('worstCoverageGap：最长缺口与占比', () => {
  const worst = worstCoverageGap([seg(0, 0, 100), seg(1, 250, 100)], { totalHeight: 350 });
  assert.equal(worst.gapCount, 1);
  assert.equal(worst.largestLength, 150);
  assert.equal(worst.worstRatio, Number((150 / 350).toFixed(6)));
  assert.equal(worst.seamless, false);
  const perfect = worstCoverageGap([seg(0, 0, 100)], { totalHeight: 100 });
  assert.equal(perfect.largest, null);
  assert.equal(perfect.largestLength, 0);
  const noTotal = worstCoverageGap([seg(0, 0, 100)]);
  assert.equal(noTotal.total, 0);
});

test('frameLedgerFromFrames：一次建台账、重复/非法计数与摘要', () => {
  const built = frameLedgerFromFrames([
    seg(0, 0, 100, { bytes: 10 }),
    seg(1, 100, 100, { bytes: 20 }),
    seg(1, 100, 100, { bytes: 20 }),
    { index: -1 },
  ], { captureId: 'deep-1', now: 100 });
  assert.equal(built.accepted, 2);
  assert.equal(built.duplicates, 1);
  assert.equal(built.rejected, 1);
  assert.equal(built.summary.frames, 2);
  assert.equal(built.summary.bytes, 30);
  assert.equal(built.ledger.captureId, 'deep-1');
  const empty = frameLedgerFromFrames(null);
  assert.equal(empty.summary.frames, 0);
});

test('coverageWire/coverageDelta：协议形状与改善判断', () => {
  const coverage = frameCoverage([seg(0, 0, 100), seg(1, 120, 100)], { totalHeight: 300 });
  const wire = coverageWire(coverage);
  assert.deepEqual(Object.keys(wire).sort(), ['covered', 'gapLength', 'gaps', 'ratio', 'seamless', 'total']);
  assert.equal(wire.gaps, 2);
  assert.equal(coverageWire(null).seamless, false);
  const delta = coverageDelta({ ratio: 0.8, gapCount: 2 }, { ratio: 1, gapCount: 0 });
  assert.equal(delta.improved, true);
  assert.equal(delta.delta, 0.2);
  const worse = coverageDelta({ ratio: 1, gapCount: 0 }, { ratio: 1, gapCount: 1 });
  assert.equal(worse.improved, false);
  assert.equal(coverageDelta(null, null).improved, false);
});

test('容差语义：几何对比容差/合并容差/覆盖容差', () => {
  const merged = mergeFrameIntervals([seg(0, 0, 100), seg(1, 105, 100)], { tolerance: 10 });
  assert.equal(merged.mergedCount, 1);
  const covered = frameCoverage([seg(0, 0, 100), seg(1, 105, 100)], { totalHeight: 205, tolerance: 10 });
  assert.equal(covered.gapCount, 0);
  assert.equal(covered.ratio, 1);
});

test('多 kind 混合对账：kind 不串号、不同 kind 同 index 不会互相匹配', () => {
  const report = reconcileFrames({
    expected: [seg(0, 0, 100), tile(0, 0, 100)],
    captured: [seg(0, 0, 100), tile(0, 0, 100)],
    totalHeight: 100,
  });
  assert.equal(report.ok, true);
  assert.equal(report.counts.matched, 2);
  const half = reconcileFrames({
    expected: [seg(0, 0, 100), tile(0, 0, 100)],
    captured: [seg(0, 0, 100)],
    totalHeight: 100,
  });
  assert.deepEqual(half.missing.map((item) => item.kind), ['longshot-tile']);
});

test('expectedFramesFromPlan：kind 归一/缺字段兜底/空输入', () => {
  const frames = expectedFramesFromPlan([
    { index: 0, offset: 10, height: 50, width: 100 },
    { index: 1, pageY: 60, pageHeight: 40 },
  ], { kind: 'longshot-tile' });
  assert.equal(frames[0].kind, 'longshot-tile');
  assert.equal(frames[0].drawY, 10);
  assert.equal(frames[1].pageY, 60);
  assert.equal(frames[1].role, 'middle');
  assert.deepEqual(expectedFramesFromPlan([{}], { kind: 'video-fragment' })[0].kind, 'video-fragment');
  assert.deepEqual(expectedFramesFromPlan(undefined), []);
});

test('签名/摘要稳定性：重复 append 的台账摘要与一次性构建一致', () => {
  const frames = [seg(0, 0, 100), seg(1, 100, 100, { hash: 'bbbbbbbbbbbbbbbb' })];
  const built = frameLedgerFromFrames(frames, { captureId: 'sig', now: 100 });
  let manual = createFrameLedger({ captureId: 'sig', now: 100 });
  for (const frame of frames) manual = appendFrame(manual, frame, { now: 100 }).ledger;
  assert.equal(frameDigest(built.ledger.frames), frameDigest(manual.frames));
  assert.equal(frameSignatureDigest(frames[0]), frameSignatureDigest({ ...frames[0] }));
});

test('hashFrameBytes 与帧 hash：内容变化会改变对账结论', () => {
  const a = hashFrameBytes([1, 2, 3, 4]);
  const b = hashFrameBytes([4, 3, 2, 1]);
  assert.notEqual(a, b);
  const report = reconcileFrames({
    expected: [seg(0, 0, 100, { hash: a })],
    captured: [seg(0, 0, 100, { hash: b })],
    totalHeight: 100,
    requireHash: true,
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.hashMismatched.map((item) => item.index), [0]);
  const index = buildFrameIndex([seg(0, 0, 100, { hash: a }), seg(0, 0, 100, { hash: b, at: 99 })]);
  assert.equal(index.duplicates.length, 1);
  assert.equal(index.list[0].hash, b, 'at 更大的重复帧胜出');
});
