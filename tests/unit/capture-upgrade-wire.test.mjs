// tests/unit/capture-upgrade-wire.test.mjs
// 第十一批-E 协议层：所有新增 wire 接口都必须 JSON 可序列化、键集稳定、列表有界，
// 且对空/非法输入给可解释的降级形状（不允许把 undefined/循环结构带进结果）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compressionWire,
  planLongshotCompression,
} from '../../extension/src/lib/longshot-compress.js';
import { frameLedgerWire, frameReportWire, reconcileFrames } from '../../extension/src/lib/capture-frame-ledger.js';
import { longshotFrameWire, reconcileLongshotFrames } from '../../extension/src/lib/longshot-frame-reconcile.js';
import { planLongshotRepaint, repaintWire, mergeRepaintPlans } from '../../extension/src/lib/longshot-repaint.js';
import { planShardRecovery, shardRecoveryWire } from '../../extension/src/lib/longshot-shard-recover.js';
import { planStorageBudget, storageBudgetWire } from '../../extension/src/lib/capture-storage-budget.js';
import { planVideoFrameRepair, reconcileVideoFrames, videoFrameWire } from '../../extension/src/lib/video-frame-reconcile.js';
import { planVideoTranscode, transcodeBudgetWire } from '../../extension/src/lib/video-transcode-budget.js';
import { muxBudgetWire, planVideoMux } from '../../extension/src/lib/video-mux-budget.js';
import { planSegmentCompression, segmentCompressionWire } from '../../extension/src/lib/video-segment-compress.js';

function jsonRoundTrip(value) {
  const text = JSON.stringify(value);
  assert.equal(typeof text, 'string');
  return JSON.parse(text);
}

function assertBounded(value, maxDepth = 8, path = '$') {
  if (value == null) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  assert.ok(maxDepth > 0, path + ' 嵌套过深（可能存在循环结构）');
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertBounded(value[index], maxDepth - 1, path + '[' + index + ']');
    return;
  }
  assert.equal(typeof value, 'object', path + ' 类型异常：' + typeof value);
  for (const key of Object.keys(value)) assertBounded(value[key], maxDepth - 1, path + '.' + key);
}

const SEG = (index, pageY, pageHeight = 100, extra = {}) => ({
  kind: 'longshot-segment', index, pageY, drawY: pageY, pageHeight, drawHeight: pageHeight, width: 800, dpr: 1, ...extra,
});

test('capture 侧 wire：帧台账/帧对账/长截图对账/重绘/分片/存储全部 JSON 安全', () => {
  const report = reconcileFrames({
    expected: [SEG(0, 0), SEG(1, 100), SEG(2, 200)],
    captured: [SEG(0, 0), SEG(1, 104)],
    totalHeight: 300,
  });
  const longs = reconcileLongshotFrames({
    expected: [SEG(0, 0), SEG(1, 100)],
    tiles: [{ index: 0, drawY: 0, height: 100, width: 800 }],
    totalHeight: 200,
  });
  const repairs = [{ index: 1, reason: 'missing', severity: 'error', pageY: 100, pageHeight: 100 }];
  const repaint = planLongshotRepaint({ repairs }, { dpr: 1, width: 800 });
  const storage = planStorageBudget({ captures: [], incomingBytes: 1024, quotaBytes: 10 * 1024 * 1024 });
  const shard = planShardRecovery({
    manifest: { captureId: 'c', total: 1, segments: [{ index: 0, offset: 0, bytes: 1, hash: 'aaaaaaaaaaaaaaaa', width: 800, height: 100 }] },
    tiles: [{ index: 0, bytes: 1, hash: 'aaaaaaaaaaaaaaaa', width: 800, height: 100 }],
    now: 1000,
  });
  const compression = planLongshotCompression([{ index: 0, width: 800, height: 100, bytes: 1000, hash: 'aa' }], {});

  const wires = [
    frameReportWire(report),
    frameLedgerWire(null),
    longshotFrameWire(longs),
    repaintWire(repaint),
    storageBudgetWire(storage),
    shardRecoveryWire(shard),
    compressionWire(compression),
  ];
  for (const wire of wires) {
    assertBounded(wire);
    const roundTripped = jsonRoundTrip(wire);
    assert.deepEqual(Object.keys(roundTripped).sort(), Object.keys(wire).sort());
  }
  // 列表有界：计数 > 列表长度时依然返回计数全量
  assert.equal(wires[0].counts.expected, 3);
  assert.equal(wires[3].batches.length <= 8, true);
  assert.equal(wires[6].framesPreview.length <= 6, true);
});

test('video 侧 wire：帧/转码/封装/分片预算全部 JSON 安全且键集稳定', () => {
  const frameReport = reconcileVideoFrames({
    frames: [
      { index: 0, tMs: 0, durationMs: 100 },
      { index: 1, tMs: 100, durationMs: 100 },
    ],
    durationMs: 200,
    fps: 10,
  });
  const transcode = planVideoTranscode({
    width: 640, height: 360, fps: 10, durationMs: 1000, sourceBytes: 100_000,
  });
  const mux = planVideoMux({ durationMs: 2000, fps: 10, payloadBytes: 100_000 });
  const segment = planSegmentCompression({
    segments: [{ index: 0, bytes: 1000, durationMs: 1000, hash: 'aa' }],
    quotaBytes: 10 * 1024 * 1024,
  });
  const repair = planVideoFrameRepair(frameReport);
  const wires = {
    frameReport: videoFrameWire(frameReport),
    transcode: transcodeBudgetWire(transcode),
    mux: muxBudgetWire(mux),
    segment: segmentCompressionWire(segment),
  };
  for (const [name, wire] of Object.entries(wires)) {
    assertBounded(wire);
    const roundTripped = jsonRoundTrip(wire);
    assert.deepEqual(Object.keys(roundTripped).sort(), Object.keys(wire).sort(), name + ' 键集应稳定');
  }
  assert.equal(wires.mux.fragments.length <= 8, true);
  assert.equal(Array.isArray(repair.ranges), true);
  assert.equal(typeof repair.action, 'string');
});

test('wire 截断参数：maxListed=0 只留计数；maxListed 很大多留但不超上限', () => {
  const frames = Array.from({ length: 20 }, (_, index) => SEG(index, index * 100));
  const report = reconcileFrames({ expected: frames, captured: [], totalHeight: 2000 });
  const zero = frameReportWire(report, { maxListed: 0 });
  assert.equal(zero.missing.length, 0);
  assert.equal(zero.counts.missing, 20);
  const many = frameReportWire(report, { maxListed: 100 });
  assert.equal(many.missing.length <= 64, true, '硬上限 64');
  assert.equal(many.missing.length > 8, true);

  const compression = planLongshotCompression(frames.map((frame) => ({
    index: frame.index, width: 800, height: 100, bytes: 1000, hash: 'h' + frame.index,
  })), {});
  assert.equal(compressionWire(compression, { maxListed: 0 }).framesPreview.length, 0);
  assert.equal(compressionWire(compression, { maxListed: 3 }).framesPreview.length, 3);
});

test('空/非法输入的 wire 降级：不抛、有稳定默认键', () => {
  const cases = [
    { wire: frameReportWire(null), keys: ['action', 'counts', 'ok', 'version'] },
    { wire: longshotFrameWire(null), keys: ['action', 'counts', 'findings', 'ok', 'version'] },
    { wire: repaintWire(null), keys: ['action', 'batches', 'counts', 'version'] },
    { wire: storageBudgetWire(null), keys: ['action', 'code', 'ok', 'version'] },
    { wire: shardRecoveryWire(null), keys: ['action', 'ok', 'total', 'usable', 'version'] },
    { wire: compressionWire(null), keys: ['action', 'frames', 'totalBytes', 'version'] },
    { wire: videoFrameWire(null), keys: ['action', 'counts', 'gaps', 'ok', 'version'] },
    { wire: transcodeBudgetWire(null), keys: ['action', 'chosen', 'ok', 'version'] },
    { wire: muxBudgetWire(null), keys: ['action', 'fragments', 'ok', 'version'] },
    { wire: segmentCompressionWire(null), keys: ['action', 'ok', 'segments', 'version'] },
  ];
  for (const { wire, keys } of cases) {
    for (const key of keys) assert.ok(Object.prototype.hasOwnProperty.call(wire, key), '缺少默认键 ' + key);
    assertBounded(wire);
  }
});

test('mergeRepaintPlans 的 wire：来源不同计划合并后仍可序列化且有界', () => {
  const a = planLongshotRepaint({ repairs: [{ index: 0, reason: 'missing', severity: 'error' }] }, { dpr: 1, width: 800 });
  const b = planLongshotRepaint({ repairs: [{ index: 0, reason: 'band:top', severity: 'warn' }, { index: 1, reason: 'hash-mismatch', severity: 'error' }] }, { dpr: 1, width: 800 });
  const merged = mergeRepaintPlans([a, b], { dpr: 1, width: 800, maxFramesPerPass: 1 });
  const wire = repaintWire(merged, { maxListed: 1 });
  assertBounded(wire);
  assert.equal(wire.counts.requested, 2);
  assert.equal(wire.batches.length <= 1, true);
  assert.deepEqual(jsonRoundTrip(wire).counts, wire.counts);
});
