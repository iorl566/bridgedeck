// tests/unit/longshot-storage-deep.test.mjs
// 第十一批-E 深度：长截图“帧对账 → 重绘目标 → 分片恢复 → 压缩/配额”整链场景。
import test from 'node:test';
import assert from 'node:assert/strict';

import { planLongshotSegments } from '../../extension/src/lib/longshot-segments.js';
import {
  planFrameRepairs,
  reconcileLongshotFrames,
} from '../../extension/src/lib/longshot-frame-reconcile.js';
import { planLongshotRepaint, mergeRepaintResults, repaintProgress } from '../../extension/src/lib/longshot-repaint.js';
import { planLongshotCompression, planCompressionStorage } from '../../extension/src/lib/longshot-compress.js';
import { planShardRecovery } from '../../extension/src/lib/longshot-shard-recover.js';
import { estimateStorageUsage, planStorageBudget } from '../../extension/src/lib/capture-storage-budget.js';

const MB = 1024 * 1024;
const H = (seed) => (seed + '0'.repeat(16)).slice(0, 16);

function plan(dpr = 1) {
  return planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr });
}

test('整链：段计划 → 落盘缺 1 段 → 帧对账 → 重绘目标 → 重绘计划 → 分片恢复决策', () => {
  const segmentPlan = plan();
  const expected = segmentPlan.segments;
  const tiles = expected.slice(0, 1).map((segment) => ({
    index: segment.index,
    drawY: segment.drawY,
    pageY: segment.pageY,
    height: segment.drawHeight,
    width: segment.width,
    bytes: 100,
    hash: H(String(segment.index)),
  }));
  const report = reconcileLongshotFrames({ plan: segmentPlan, tiles });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing.map((item) => item.index), [1]);
  const repairs = planFrameRepairs(report);
  assert.deepEqual(repairs.map((item) => item.index), [1]);
  const repaint = planLongshotRepaint({ repairs }, { dpr: segmentPlan.dpr, width: segmentPlan.width });
  assert.equal(repaint.action, 'repaint');
  assert.equal(repaint.counts.scheduled, 1);
  const merged = mergeRepaintResults(repaint, [{ index: 1, ok: true, bytes: 500 }], { attemptsPerFrame: 1 });
  assert.equal(merged.ok, true);
  const progress = repaintProgress(repaint, merged);
  assert.equal(progress.done, true);
  // 分片恢复：manifest 期望 2 段、只有 1 片 → recover-partial
  const manifest = {
    captureId: 'deep-1',
    total: expected.length,
    dpr: segmentPlan.dpr,
    width: segmentPlan.width,
    height: segmentPlan.height,
    sealed: false,
    updatedAt: new Date(2_000_000).toISOString(),
    segments: expected.map((segment) => ({
      index: segment.index,
      offset: segment.drawY,
      bytes: 100,
      hash: H(String(segment.index)),
      width: segment.width,
      height: segment.drawHeight,
    })),
  };
  const shard = planShardRecovery({ manifest, tiles, now: 2_000_001 });
  assert.equal(shard.action, 'recover-partial');
  assert.deepEqual(shard.refetch.map((item) => item.index), [1]);
});

test('整链：压缩/配额联动——大 capture 触发降档/淘汰决策', () => {
  const segmentPlan = plan();
  const frames = segmentPlan.segments.map((segment) => ({
    index: segment.index,
    width: segment.width,
    height: segment.drawHeight,
    bytes: 18 * MB,
    hash: H(String(segment.index)),
    pageY: segment.pageY,
  }));
  const compression = planLongshotCompression(frames, {
    maxTotalBytes: 20 * MB,
    maxFrameBytes: 8 * MB,
  });
  assert.equal(typeof compression.action, 'string');
  assert.equal(typeof compression.ok, 'boolean');
  assert.ok(compression.degradedFrames + compression.rejectedFrames > 0, '8MB 单帧上限下 PNG 必须降档或超限');
  const combined = planCompressionStorage(compression, {
    quotaBytes: 64 * MB,
    usedBytes: 0,
  });
  assert.equal(['accept', 'warn', 'evict', 'reject'].includes(combined.storage.action), true);
  assert.equal(typeof combined.ok, 'boolean');
});

test('整链：存储使用量 + 配额决策（旧产物淘汰、未封版保护）', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 20 * day;
  const captures = [
    { id: 'sealed-old', kind: 'longshot', bytes: 30 * MB, sealed: true, at: now - 10 * day },
    { id: 'unsealed', kind: 'longshot', bytes: 20 * MB, sealed: false, at: now - 2 * day },
    { id: 'sealed-new', kind: 'longshot', bytes: 20 * MB, sealed: true, at: now - day },
  ];
  const usage = estimateStorageUsage(captures, { quotaBytes: 100 * MB });
  assert.equal(usage.captures, 3);
  assert.equal(usage.totalBytes, 70 * MB);
  const decision = planStorageBudget({
    captures,
    usedBytes: usage.totalBytes,
    incomingBytes: 20 * MB,
    quotaBytes: 100 * MB,
    now,
  });
  assert.equal(['evict', 'warn', 'reject', 'accept'].includes(decision.action), true);
  if (decision.action === 'evict') {
    assert.ok(decision.eviction.evicted.every((item) => item.id !== 'unsealed'));
  }
});

test('两段都缺：帧对账 repaint-all，重绘计划按预算分批', () => {
  const segmentPlan = plan(1.5);
  const report = reconcileLongshotFrames({ plan: segmentPlan, tiles: [], totalHeight: segmentPlan.height });
  assert.equal(report.counts.matched, 0);
  assert.equal(report.action, 'repaint-all');
  const repairs = planFrameRepairs(report);
  assert.equal(repairs.length, segmentPlan.totalSegments);
  const repaint = planLongshotRepaint({ repairs }, {
    dpr: segmentPlan.dpr,
    width: segmentPlan.width,
    maxFramesPerPass: 1,
    maxPixels: 0,
    maxBytes: 0,
  });
  assert.equal(repaint.action, 'repaint');
  assert.equal(repaint.batches.length, segmentPlan.totalSegments);
  const batches = repaint.batches.map((batch) => batch.frames.length);
  assert.ok(batches.every((count) => count === 1));
});

test('只差 hash：对账给 hash-mismatch，重绘目标优先 hash 修复', () => {
  const segmentPlan = plan();
  const tiles = segmentPlan.segments.map((segment) => ({
    index: segment.index,
    drawY: segment.drawY,
    pageY: segment.pageY,
    height: segment.drawHeight,
    width: segment.width,
    bytes: 100,
    hash: 'ffffffffffffffff',
  }));
  const expected = segmentPlan.segments.map((segment) => ({
    index: segment.index,
    pageY: segment.pageY,
    pageHeight: segment.pageHeight,
    drawY: segment.drawY,
    drawHeight: segment.drawHeight,
    width: segment.width,
    bytes: 100,
    hash: H(String(segment.index)),
  }));
  const report = reconcileLongshotFrames({ expected, tiles, requireHash: true, plan: segmentPlan });
  assert.equal(report.ok, false);
  assert.deepEqual(report.hashMismatched.map((item) => item.index), [0, 1]);
  const repairs = planFrameRepairs(report);
  assert.ok(repairs.some((item) => item.reason === 'hash-mismatch'));
});
