// tests/unit/capture-frame-ledger.test.mjs
// 第十一批-E：采集帧台账与帧级对账内核（lib/capture-frame-ledger.js）。
// 覆盖：hash/签名/摘要、归一化、帧索引（重复/乱序/非法）、几何对比、区间合并、
//       覆盖计算（含越界/缺口）、帧级对账（missing/extra/misaligned/hash/coverage）、
//       报告 wire/describe、运行时台账（追加/重复/摘要/wire/差异）、计划反建。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTURE_FRAME_VERSION,
  FRAME_CODES,
  FRAME_KINDS,
  FRAME_STATES,
  appendFrame,
  buildFrameIndex,
  classifyFrameState,
  compareFrameGeometry,
  createFrameLedger,
  describeFrameReport,
  diffFrameLedger,
  digestText,
  djb2_32,
  expectedFramesFromPlan,
  fnv1a32,
  frameCoverage,
  frameDigest,
  frameIdentity,
  frameLedgerSummary,
  frameLedgerWire,
  frameReportWire,
  frameSignature,
  frameSignatureDigest,
  hashFrameBytes,
  mergeFrameIntervals,
  normalizeFrame,
  normalizeFrameKind,
  reconcileFrames,
  toByteView,
} from '../../extension/src/lib/capture-frame-ledger.js';

const SEG = (index, pageY, pageHeight = 100, extra = {}) => ({
  kind: 'longshot-segment',
  index,
  pageY,
  drawY: pageY,
  pageHeight,
  drawHeight: pageHeight,
  width: 800,
  dpr: 1,
  ...extra,
});

test('常量：版本/帧类型/状态/问题码形状稳定', () => {
  assert.equal(CAPTURE_FRAME_VERSION, 1);
  assert.deepEqual([...FRAME_KINDS], ['longshot-segment', 'longshot-tile', 'video-fragment', 'viewport']);
  for (const state of ['planned', 'captured', 'verified', 'suspect', 'missing', 'duplicate', 'superseded']) {
    assert.ok(FRAME_STATES.includes(state));
  }
  for (const code of ['frame.missing', 'frame.extra', 'frame.duplicate', 'frame.misaligned', 'frame.reordered', 'frame.hash-mismatch', 'frame.coverage', 'frame.ok']) {
    assert.ok(Object.values(FRAME_CODES).includes(code));
  }
  assert.equal(normalizeFrameKind('longshot-tile'), 'longshot-tile');
  assert.equal(normalizeFrameKind('weird'), 'viewport');
  assert.equal(normalizeFrameKind(null), 'viewport');
});

test('fnv1a32/djb2_32/digestText：确定性且对输入敏感', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('abc'), fnv1a32('abc'));
  assert.notEqual(fnv1a32('abc'), fnv1a32('abd'));
  assert.equal(djb2_32('abc'), djb2_32('abc'));
  assert.notEqual(djb2_32('abc'), djb2_32('bac'));
  assert.match(digestText('abc'), /^[0-9a-f]{16}$/);
  assert.notEqual(digestText('abc'), digestText('abd'));
  assert.equal(digestText(null), digestText(''));
});

test('toByteView/hashFrameBytes：Uint8Array/ArrayBuffer/数组/字符串都支持', () => {
  assert.equal(toByteView(new Uint8Array([1, 2, 3])).length, 3);
  assert.equal(toByteView(new Uint8Array([1, 2, 3]).buffer).length, 3);
  assert.equal(toByteView([1, 2, 300]).length, 3);
  assert.equal(toByteView([1, 2, 300])[2], 44, '超 255 的数组元素按 &0xff 截断');
  assert.equal(toByteView('ab').length, 2);
  assert.equal(toByteView(null).length, 0);
  assert.match(hashFrameBytes([1, 2, 3]), /^[0-9a-f]{16}$/);
  assert.equal(hashFrameBytes([1, 2, 3]), hashFrameBytes([1, 2, 3]));
  assert.notEqual(hashFrameBytes([1, 2, 3]), hashFrameBytes([3, 2, 1]));
});

test('frameIdentity：高度字段互相兜底，role 缺省为 frame', () => {
  const identity = frameIdentity({ kind: 'longshot-segment', index: 2, pageY: 10, pageHeight: 50, width: 100, dpr: 1.5 });
  assert.equal(identity.kind, 'longshot-segment');
  assert.equal(identity.index, 2);
  assert.equal(identity.pageHeight, 50);
  assert.equal(identity.drawHeight, 50);
  assert.equal(identity.role, 'frame');
  const onlyHeight = frameIdentity({ index: 0, height: 30, width: 5 });
  assert.equal(onlyHeight.pageHeight, 30);
  assert.equal(onlyHeight.drawHeight, 30);
  const offsetAlias = frameIdentity({ index: 0, offset: 40, height: 20, width: 5 });
  assert.equal(offsetAlias.drawY, 40);
});

test('frameSignature/frameDigest：跨次一致、对几何/角色敏感', () => {
  const a = SEG(0, 0);
  assert.equal(frameSignature(a), frameSignature({ ...a }));
  assert.match(frameSignatureDigest(a), /^[0-9a-f]{16}$/);
  assert.notEqual(frameSignatureDigest(a), frameSignatureDigest({ ...a, index: 1 }));
  assert.notEqual(frameSignatureDigest(a), frameSignatureDigest({ ...a, role: 'first' }));
  const list = [SEG(0, 0), SEG(1, 100)];
  assert.equal(frameDigest(list), frameDigest(list.map((frame) => ({ ...frame }))));
  assert.notEqual(frameDigest(list), frameDigest([...list].reverse()));
  assert.equal(frameDigest([]), frameDigest([], { seed: 'capture-frames/1' }));
  assert.notEqual(frameDigest([]), frameDigest([], { seed: 'other' }));
});

test('normalizeFrame：非法输入给理由，合法输入带签名哈希与状态', () => {
  assert.equal(normalizeFrame(null).ok, false);
  assert.equal(normalizeFrame([]).ok, false);
  assert.equal(normalizeFrame({}).reason, 'bad-index');
  assert.equal(normalizeFrame({ index: 0, width: 0, height: 10 }).reason, 'bad-width');
  assert.equal(normalizeFrame({ index: 0, width: 10, height: 0 }).reason, 'bad-height');
  const ok = normalizeFrame(SEG(3, 300, 120, { bytes: 500, at: 10, role: 'last' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.frame.index, 3);
  assert.equal(ok.frame.bytes, 500);
  assert.equal(ok.frame.state, 'captured');
  assert.match(ok.frame.hash, /^[0-9a-f]{16}$/);
  const withHash = normalizeFrame(SEG(0, 0, 10, { hash: 'ABCDEF0123456789' }));
  assert.equal(withHash.frame.hash, 'abcdef0123456789');
  const withBytes = normalizeFrame(SEG(0, 0, 10, { data: [1, 2, 3, 4] }));
  assert.equal(withBytes.frame.hash, hashFrameBytes([1, 2, 3, 4]));
});

test('buildFrameIndex：排序/重复折叠（保留较新）/乱序/非法', () => {
  const index = buildFrameIndex([
    SEG(2, 200),
    { kind: 'longshot-segment', index: 'x', width: 1, height: 1 },
    SEG(0, 0, 100, { at: 5, hash: 'aaaaaaaaaaaaaaaa' }),
    SEG(0, 0, 100, { at: 9, hash: 'bbbbbbbbbbbbbbbb' }),
  ]);
  assert.equal(index.list.length, 2);
  assert.deepEqual(index.list.map((frame) => frame.index), [0, 2]);
  assert.equal(index.list[0].hash, 'bbbbbbbbbbbbbbbb', '重复 index 保留 at 更大的一版');
  assert.deepEqual(index.duplicates.map((item) => item.index), [0]);
  assert.equal(index.reordered, true, '先 2 后 0 应标记乱序');
  assert.equal(index.invalid.length, 1);
  assert.match(index.signature, /^[0-9a-f]{16}$/);
  const empty = buildFrameIndex([]);
  assert.deepEqual(empty.list, []);
  assert.equal(buildFrameIndex(null).list.length, 0);
});

test('compareFrameGeometry：容差内相等、dpr 用 1e-6、缺失字段不误报高度', () => {
  const equal = compareFrameGeometry(SEG(0, 100), SEG(0, 100));
  assert.equal(equal.equal, true);
  const shifted = compareFrameGeometry(SEG(0, 100), SEG(0, 102), { tolerance: 1 });
  assert.equal(shifted.equal, false);
  assert.deepEqual(shifted.diffs.map((diff) => diff.field), ['pageY', 'drawY']);
  const withinTolerance = compareFrameGeometry(SEG(0, 100), SEG(0, 101), { tolerance: 1 });
  assert.equal(withinTolerance.equal, true);
  const dprTiny = compareFrameGeometry({ ...SEG(0, 0), dpr: 1.5 }, { ...SEG(0, 0), dpr: 1.5000001 });
  assert.equal(dprTiny.equal, true);
  const zeroHeight = compareFrameGeometry(
    { kind: 'longshot-segment', index: 0, pageY: 0, width: 10, dpr: 1 },
    { kind: 'longshot-segment', index: 0, pageY: 0, width: 10, dpr: 1 },
  );
  assert.equal(zeroHeight.equal, true, '两边都没有高度时不应报 0-0 差异以外的错');
});

test('mergeFrameIntervals：合并重叠/相邻、时间轴模式', () => {
  const page = mergeFrameIntervals([
    { index: 0, pageY: 0, pageHeight: 100 },
    { index: 1, pageY: 90, pageHeight: 100 },
    { index: 2, pageY: 200, pageHeight: 50 },
  ]);
  assert.equal(page.mode, 'page');
  assert.deepEqual(page.merged.map((interval) => [interval.start, interval.end]), [[0, 190], [200, 250]]);
  assert.equal(page.total, 240);
  const time = mergeFrameIntervals([
    { index: 0, startMs: 0, durationMs: 100 },
    { index: 1, startMs: 100, durationMs: 100 },
  ], { mode: 'time' });
  assert.equal(time.mode, 'time');
  assert.deepEqual(time.merged.map((interval) => [interval.start, interval.end]), [[0, 200]]);
  assert.deepEqual(mergeFrameIntervals(null).merged, []);
});

test('frameCoverage：有总长时越界不算覆盖、缺口逐段列出', () => {
  const full = frameCoverage([SEG(0, 0), SEG(1, 100)], { totalHeight: 200 });
  assert.equal(full.ratio, 1);
  assert.equal(full.gapCount, 0);
  assert.equal(full.seamless, true);
  const gap = frameCoverage([SEG(0, 0), SEG(1, 120)], { totalHeight: 200 });
  assert.equal(gap.gapCount, 1);
  assert.deepEqual(gap.gaps[0], { start: 100, end: 120, length: 20 });
  assert.equal(gap.ratio, 0.9);
  assert.equal(gap.seamless, false);
  const overrun = frameCoverage([SEG(0, 0, 300)], { totalHeight: 200 });
  assert.equal(overrun.covered, 200);
  assert.equal(overrun.ratio, 1);
  const empty = frameCoverage([], { totalHeight: 100 });
  assert.equal(empty.ratio, 0);
  assert.equal(empty.gapCount, 1);
  const noTotal = frameCoverage([SEG(0, 0), SEG(1, 100)], {});
  assert.equal(noTotal.ratio, 1);
  const time = frameCoverage([{ startMs: 0, durationMs: 50 }], { mode: 'time', totalMs: 100 });
  assert.equal(time.ratio, 0.5);
});

test('reconcileFrames：完全匹配 → ok/accept；只加计数不伪造', () => {
  const expected = [SEG(0, 0), SEG(1, 100)];
  const captured = [SEG(0, 0), SEG(1, 100)];
  const report = reconcileFrames({ expected, captured, totalHeight: 200 });
  assert.equal(report.ok, true);
  assert.equal(report.action, 'accept');
  assert.deepEqual(report.issues, [FRAME_CODES.OK]);
  assert.deepEqual(report.counts.matched, 2);
  assert.equal(report.counts.missing, 0);
  assert.equal(report.coverage.ratio, 1);
  assert.match(report.capturedSignature, /^[0-9a-f]{16}$/);
  assert.equal(report.evidence.expected, 2);
});

test('reconcileFrames：缺帧/多帧/错位/乱序/覆盖缺口都被点名', () => {
  const expected = [SEG(0, 0), SEG(1, 100), SEG(2, 200)];
  const captured = [
    SEG(2, 200),
    SEG(0, 0, 100, { pageY: 5, drawY: 5 }),
    SEG(9, 400),
  ];
  const report = reconcileFrames({ expected, captured, totalHeight: 300, tolerance: 0 });
  assert.equal(report.ok, false);
  assert.equal(report.action, 'repair-partial');
  assert.deepEqual(report.missing.map((item) => item.index), [1]);
  assert.deepEqual(report.extra.map((item) => item.index), [9]);
  assert.deepEqual(report.mismatched.map((item) => item.index), [0]);
  assert.ok(report.issues.includes(FRAME_CODES.MISSING));
  assert.ok(report.issues.includes(FRAME_CODES.EXTRA));
  assert.ok(report.issues.includes(FRAME_CODES.MISALIGNED));
  assert.ok(report.issues.includes(FRAME_CODES.REORDERED));
  assert.ok(report.coverage.gapCount > 0);
  assert.equal(report.action, 'repair-partial');
});

test('reconcileFrames：requireHash 时 hash 不一致单独记；空输入→nothing', () => {
  const expected = [SEG(0, 0, 100, { hash: 'aaaaaaaaaaaaaaaa' })];
  const captured = [SEG(0, 0, 100, { hash: 'bbbbbbbbbbbbbbbb' })];
  const report = reconcileFrames({ expected, captured, totalHeight: 100, requireHash: true });
  assert.equal(report.ok, false);
  assert.deepEqual(report.hashMismatched.map((item) => item.index), [0]);
  assert.ok(report.issues.includes(FRAME_CODES.HASH_MISMATCH));
  const empty = reconcileFrames({});
  assert.equal(empty.action, 'nothing');
  assert.deepEqual(empty.issues, [FRAME_CODES.EMPTY]);
});

test('frameReportWire/describeFrameReport：列表截断但计数完整', () => {
  const report = reconcileFrames({
    expected: [SEG(0, 0), SEG(1, 100), SEG(2, 200), SEG(3, 300)],
    captured: [SEG(0, 0)],
    totalHeight: 400,
  });
  const wire = frameReportWire(report, { maxListed: 1 });
  assert.equal(wire.ok, false);
  assert.equal(wire.counts.missing, 3);
  assert.equal(wire.missing.length, 1);
  assert.equal(wire.coverage.gaps > 0, true);
  assert.match(wire.text, /帧对账/);
  assert.match(describeFrameReport(report), /丢 3/);
  assert.equal(frameReportWire(null).ok, false);
  assert.match(describeFrameReport(null), /无报告/);
});

test('classifyFrameState：按对账结论归类（missing/suspect/duplicate/verified）', () => {
  const report = reconcileFrames({
    expected: [SEG(0, 0), SEG(1, 100), SEG(2, 200), SEG(3, 300), SEG(4, 400)],
    captured: [SEG(0, 0, 100, { pageY: 4, drawY: 4 }), SEG(1, 100), SEG(2, 200), SEG(2, 200), SEG(3, 300)],
    totalHeight: 500,
  });
  assert.equal(classifyFrameState(SEG(0, 0), report), 'suspect');
  assert.equal(classifyFrameState(SEG(2, 200), report), 'duplicate');
  assert.equal(classifyFrameState(SEG(1, 100), report), 'verified');
  assert.equal(classifyFrameState(SEG(4, 400), report), 'missing');
  assert.equal(classifyFrameState(null, report), 'missing');
  assert.equal(classifyFrameState(SEG(0, 0), null), 'captured');
});

test('createFrameLedger/appendFrame：不可变追加、重复折叠、非法计数', () => {
  const ledger = createFrameLedger({ captureId: 'cap-1', now: 1000, kind: 'longshot-segment' });
  assert.equal(ledger.frames.length, 0);
  assert.equal(ledger.totals.bytes, 0);
  const first = appendFrame(ledger, SEG(0, 0, 100, { bytes: 10, at: 1 }), { now: 1001 });
  assert.equal(first.accepted, true);
  assert.equal(first.ledger.frames.length, 1);
  assert.equal(first.ledger.totals.bytes, 10);
  const duplicateNewer = appendFrame(first.ledger, SEG(0, 0, 100, { bytes: 20, at: 5 }), { now: 1002 });
  assert.equal(duplicateNewer.accepted, false);
  assert.equal(duplicateNewer.duplicate, true);
  assert.equal(duplicateNewer.ledger.frames.length, 1);
  assert.equal(duplicateNewer.ledger.totals.bytes, 20, '较新的一版覆盖旧版');
  const invalid = appendFrame(duplicateNewer.ledger, { bad: true }, { now: 1003 });
  assert.equal(invalid.accepted, false);
  assert.equal(invalid.reason, 'bad-index');
  assert.equal(invalid.ledger.totals.rejected, 1);
  assert.equal(ledger.frames.length, 0, '原台账未被修改');
});

test('frameLedgerSummary/frameLedgerWire/diffFrameLedger：摘要与差异', () => {
  let ledger = createFrameLedger({ captureId: 'cap-2', now: 1000 });
  ledger = appendFrame(ledger, SEG(0, 0, 100, { bytes: 10 }), { now: 1001 }).ledger;
  ledger = appendFrame(ledger, SEG(1, 100, 100, { bytes: 20 }), { now: 1002 }).ledger;
  const summary = frameLedgerSummary(ledger);
  assert.equal(summary.frames, 2);
  assert.equal(summary.bytes, 30);
  assert.equal(summary.coverage.ratio, 1);
  assert.equal(summary.states.captured, 2);
  const wire = frameLedgerWire(ledger);
  assert.equal(wire.capture_id, 'cap-2');
  assert.equal(wire.frames, 2);
  assert.equal(wire.coverage.seamless, true);
  assert.deepEqual(frameLedgerSummary(null).frames, 0);
  assert.equal(frameLedgerWire(null).frames, 0);

  const swapped = createFrameLedger({ captureId: 'cap-2', now: 1000 });
  let nextLedger = appendFrame(swapped, SEG(1, 100, 100, { bytes: 99, hash: 'bbbbbbbbbbbbbbbb' }), { now: 2000 }).ledger;
  nextLedger = appendFrame(nextLedger, SEG(2, 200, 100, { bytes: 30 }), { now: 2001 }).ledger;
  const diff = diffFrameLedger(ledger, nextLedger);
  assert.deepEqual(diff.added.map((item) => item.index), [2]);
  assert.deepEqual(diff.removed.map((item) => item.index), [0]);
  assert.deepEqual(diff.changed.map((item) => item.index), [1]);
  assert.equal(diff.ok, false);
  const same = diffFrameLedger(ledger, ledger);
  assert.equal(same.ok, true);
});

test('expectedFramesFromPlan：从 tiled-capture 段/恢复 tile 反建期望帧', () => {
  const frames = expectedFramesFromPlan([
    { index: 0, offsetY: 0, pageY: 0, pageHeight: 40000, height: 40000, width: 800, dpr: 1.5 },
    { index: 1, offsetY: 40000, pageY: 40000, pageHeight: 5000, height: 5000, width: 800, dpr: 1.5 },
  ], { kind: 'longshot-segment' });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].state, 'planned');
  assert.equal(frames[0].kind, 'longshot-segment');
  assert.equal(frames[0].pageY, 0);
  assert.equal(frames[0].pageHeight, 40000);
  assert.equal(frames[1].drawY, 40000);
  assert.equal(frames[1].role, 'middle');
  assert.deepEqual(expectedFramesFromPlan(null), []);
});
