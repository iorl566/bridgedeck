// tests/unit/video-budget-deep.test.mjs
// 第十一批-E 深度：转码/封装/分片存储三块预算的交叉场景（预算联动、极端档位、恢复摘要）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { planVideoTranscode, estimateTranscodeCost, resolveLadder } from '../../extension/src/lib/video-transcode-budget.js';
import { planVideoMux, validateMuxPlan, muxFragmentIndex } from '../../extension/src/lib/video-mux-budget.js';
import {
  planSegmentCompression,
  estimateSegmentBytes,
  compressJournalEntries,
  mergeVideoEvidence,
} from '../../extension/src/lib/video-segment-compress.js';

const MB = 1024 * 1024;

function muxAndStorage({ durationMs, bytes, segments = 4 }) {
  const mux = planVideoMux({ durationMs, payloadBytes: bytes });
  const perSegment = Math.round(bytes / segments);
  const storage = planSegmentCompression({
    segments: Array.from({ length: segments }, (_, index) => ({
      index,
      bytes: perSegment,
      durationMs: Math.round(durationMs / segments),
      hash: 'hash' + index,
    })),
  });
  return { mux, storage };
}

test('长录制（10 分钟）：封装分片数受开销/片数预算约束，存储预算仍 accept', () => {
  const { mux, storage } = muxAndStorage({ durationMs: 600_000, bytes: 120 * MB, segments: 12 });
  assert.equal(mux.action, 'ok');
  assert.equal(mux.fragmentCount, 300);
  assert.equal(mux.keyframeMs, 2000);
  assert.ok(mux.overhead.bytes > 0);
  const validation = validateMuxPlan(mux);
  assert.equal(validation.ok, true);
  assert.equal(storage.action, 'keep');
  assert.equal(storage.segments, 12);
  assert.equal(storage.reencode.length, 0);
});

test('短录制（1.2 秒）：分片数按 250ms 切分、末片标记、索引开销不消失', () => {
  const mux = planVideoMux({ durationMs: 1200, fragmentMs: 250, keyframeMs: 250 });
  assert.equal(mux.fragmentCount, 5);
  assert.equal(mux.fragments[mux.fragments.length - 1].isLast, true);
  assert.equal(validateMuxPlan(mux).ok, true);
  const index = muxFragmentIndex(mux);
  assert.equal(index.length, mux.fragmentCount);
  assert.equal(index[index.length - 1].last, true);
  assert.equal(mux.overhead.bytes >= 5 * 900, true);
});

test('转码预算与封装预算联动：转码后体积进入封装 totalBytes', () => {
  const transcode = planVideoTranscode({
    width: 1280,
    height: 720,
    fps: 30,
    durationMs: 5000,
    sourceBytes: 4 * MB,
    maxTotalPixels: 0,
    maxDurationMs: 60_000,
  });
  assert.equal(transcode.ok, true);
  assert.ok(transcode.cost.estimateBytes > 0);
  const mux = planVideoMux({ durationMs: 5000, payloadBytes: transcode.cost.estimateBytes });
  assert.equal(mux.totalBytes, transcode.cost.estimateBytes + mux.overhead.bytes);
  assert.equal(mux.action, 'ok');
  // 封装摘要里的分片估算字节应覆盖 payload 量级
  const index = muxFragmentIndex(mux);
  const sum = index.reduce((total, item) => total + item.estimateBytes, 0);
  assert.ok(sum >= transcode.cost.estimateBytes);
});

test('极端场景：4K 10 分钟转码被预算拒绝（不尝试编码）', () => {
  const reject = planVideoTranscode({
    width: 3840,
    height: 2160,
    fps: 60,
    durationMs: 600_000,
    maxTotalPixels: 100 * 1024 * 1024,
    maxDurationMs: 30_000,
    ladder: [{ name: 'low', scale: 0.25, bitrateFactor: 0.25 }],
  });
  assert.equal(reject.action, 'reject');
  assert.equal(reject.ok, false);
  assert.equal(reject.reason, 'budget-exceeded');
});

test('极端场景：单段 2GB 超配额直接 reject，短段保留', () => {
  const plan = planSegmentCompression({
    segments: [
      { index: 0, bytes: 2 * 1024 * MB, durationMs: 600_000, hash: 'aa' },
      { index: 1, bytes: 4 * MB, durationMs: 2000, hash: 'bb' },
    ],
    maxSegmentBytes: 1024 * MB,
    targetSegmentBytes: 512 * MB,
    quotaBytes: 512 * MB,
    usedBytes: 0,
    maxCaptureRatio: 0.5,
  });
  assert.equal(plan.action, 'reject');
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.reencode.map((item) => item.index), [0]);
  assert.deepEqual(plan.keep.map((item) => item.index), [1]);
});

test('resolveLadder：非法档位被丢弃、空列表回落默认；成本随档位单调', () => {
  const ladder = resolveLadder({ ladder: [{ name: 'a', scale: 1, bitrateFactor: 1 }, { name: 'b', scale: 0 }, null] });
  assert.equal(ladder.length, 1);
  const defaults = resolveLadder({ ladder: [] });
  assert.ok(defaults.length >= 4);
  assert.ok(defaults[0].scale >= defaults[defaults.length - 1].scale);
  const source = estimateTranscodeCost({ width: 1000, height: 1000, fps: 10, durationMs: 1000, scale: 1 });
  const half = estimateTranscodeCost({ width: 1000, height: 1000, fps: 10, durationMs: 1000, scale: 0.5 });
  assert.ok(source.pixels > half.pixels);
  assert.ok(source.estimateMs >= half.estimateMs);
});

test('分片日记瘦身 + 证据合并：合成一份可序列化的 video evidence', () => {
  const journal = compressJournalEntries([
    { index: 0, bytes: 100, hash: 'aa', tMs: 0, durationMs: 1000, frames: [{ pts: 0, durationMs: 33, bytes: 10 }], debug: 'x'.repeat(100) },
  ]);
  assert.equal(journal.count, 1);
  const evidence = mergeVideoEvidence({
    frames: { action: 'accept', ok: true, counts: { frames: 30, gaps: 0 }, coverage: { ratio: 1 } },
    transcode: { action: 'skip' },
    mux: { action: 'ok', fragmentCount: 3, overhead: { bytes: 100 }, keyframeMs: 2000 },
    storage: planSegmentCompression({
      segments: [{ index: 0, bytes: MB, durationMs: 2000, hash: 'aa' }],
    }),
    journal,
  });
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.actions, ['accept', 'skip', 'ok', 'keep']);
  assert.equal(evidence.journal.count, 1);
  assert.equal(JSON.parse(JSON.stringify(evidence)).version, 1, '证据必须可 JSON 序列化');
});

test('estimateSegmentBytes 与真实分片字节口径一致（字节/时长两条路径）', () => {
  const byBitrate = estimateSegmentBytes({ durationMs: 2000, bitrate: 4_000_000 });
  assert.equal(byBitrate, Math.round((4_000_000 / 8) * 2 * 1.02));
  const byBytes = estimateSegmentBytes({ bytes: 1234, durationMs: 2000 });
  assert.equal(byBytes, 1234);
  const zero = estimateSegmentBytes({});
  assert.equal(zero, 0);
});
