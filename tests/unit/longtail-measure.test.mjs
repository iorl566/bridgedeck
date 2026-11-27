// tests/unit/longtail-measure.test.mjs —— 时间/内存测量原语与统计。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BYTES_PER_MB,
  MEASURE_VERSION,
  ceilMs,
  computeStats,
  createMemoryTracker,
  describeMemory,
  elapsedMs,
  formatBytes,
  formatCount,
  formatMs,
  jsonByteLength,
  measureAsync,
  measureSync,
  memoryDelta,
  memoryInMb,
  nowMs,
  percentile,
  probe,
  readMemory,
  roundMs,
  toMb,
} from '../../tools/longtail/lib/measure.mjs';

test('版本与时钟', () => {
  assert.equal(MEASURE_VERSION, 1);
  const start = nowMs();
  assert.ok(nowMs() >= start);
  assert.ok(elapsedMs(start) >= 0);
  assert.equal(roundMs(1.23456), 1.235);
  assert.equal(roundMs('x'), 0);
  assert.equal(ceilMs(1.2), 2);
});

test('toMb/memoryInMb/memoryDelta 单位换算', () => {
  assert.equal(toMb(BYTES_PER_MB), 1);
  assert.equal(toMb(0), 0);
  const snapshot = memoryInMb({ rss: 2 * BYTES_PER_MB, heapTotal: BYTES_PER_MB, heapUsed: BYTES_PER_MB / 2, external: 0, arrayBuffers: 0 });
  assert.equal(snapshot.rssMb, 2);
  assert.equal(snapshot.heapUsedMb, 0.5);
  const mb = BYTES_PER_MB;
  const delta = memoryDelta(
    { rss: 100 * mb, heapTotal: 100 * mb, heapUsed: 100 * mb, external: 0, arrayBuffers: 0 },
    { rss: 300 * mb, heapTotal: 200 * mb, heapUsed: 180 * mb, external: 10 * mb, arrayBuffers: 0 },
    { rss: 400 * mb, heapUsed: 190 * mb, heapTotal: 200 * mb, external: 10 * mb, arrayBuffers: 0 },
  );
  assert.equal(delta.peakHeapUsedMb, 90);
  assert.equal(delta.peakRssMb, 400);
  assert.equal(delta.heapUsedMb, 80);
  assert.equal(delta.rssMb, 200);
  assert.equal(delta.before.rssMb, 100);
});

test('readMemory 返回 5 个非负字节字段', () => {
  const memory = readMemory();
  for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
    assert.equal(typeof memory[key], 'number');
    assert.ok(memory[key] >= 0);
  }
});

test('percentile 线性插值与边界', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5], 0), 5);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.ok(Math.abs(percentile([1, 2, 3, 4], 95) - 3.85) < 1e-9);
  assert.equal(percentile([4, 3, 2, 1], 50), 2.5);
});

test('computeStats 已知样本', () => {
  const stats = computeStats([1, 2, 3, 4]);
  assert.equal(stats.count, 4);
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 4);
  assert.equal(stats.mean, 2.5);
  assert.equal(stats.median, 2.5);
  assert.equal(stats.sum, 10);
  assert.equal(stats.p95, 3.85);
  assert.equal(stats.stddev, 1.118);
  assert.deepEqual(computeStats([]), { count: 0, sum: 0, min: 0, mean: 0, median: 0, p95: 0, max: 0, stddev: 0 });
  assert.deepEqual(computeStats([1, 'x', Number.NaN, 3]), { count: 2, sum: 4, min: 1, mean: 2, median: 2, p95: 2.9, max: 3, stddev: 1 });
});

test('measureSync：轮数/样本/返回值/总时长', () => {
  let counter = 0;
  const result = measureSync((round) => {
    counter += 1;
    return round * 2;
  }, { label: 'double', rounds: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.label, 'double');
  assert.equal(result.stats.count, 3);
  assert.equal(result.samples.length, 3);
  assert.equal(counter, 3);
  assert.equal(result.value, 4);
  assert.ok(result.totalMs >= 0);
  assert.ok(result.memory.peakRssMb > 0);
});

test('measureSync：warmup 不计样本但仍执行；captureValue=false 不返回 value', () => {
  let calls = 0;
  const result = measureSync(() => { calls += 1; return 'value'; }, { rounds: 2, warmup: 3, captureValue: false });
  assert.equal(calls, 5);
  assert.equal(result.stats.count, 2);
  assert.equal('value' in result, false);
});

test('measureSync：被测函数抛错时不穿透，返回结构化 error', () => {
  const result = measureSync(() => { throw new RangeError('boom'); }, { label: 'explode' });
  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'RangeError');
  assert.match(result.error.message, /boom/);
  assert.equal(result.stats.count, 0);
});

test('measureAsync：异步测量与错误捕获', async () => {
  const result = await measureAsync(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return 42;
  }, { label: 'async', rounds: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.value, 42);
  assert.equal(result.stats.count, 2);
  const failed = await measureAsync(async () => { throw new Error('async-boom'); }, {});
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /async-boom/);
});

test('createMemoryTracker：采样次数与 finish 字段', () => {
  const tracker = createMemoryTracker();
  const before = tracker.sample();
  assert.equal(tracker.samples(), 1);
  const memory = tracker.finish();
  assert.ok(Number.isFinite(memory.peakHeapUsedMb));
  assert.ok(Number.isFinite(memory.peakRssMb));
  assert.ok(before.heapUsed >= 0);
});

test('probe：成功/失败都结构化，绝不抛出', () => {
  const ok = probe('ok', () => 7);
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 7);
  assert.equal(ok.errorCode, null);
  const failed = probe('fail', () => { throw new TypeError('nope'); });
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'TypeError');
  assert.match(failed.errorMessage, /nope/);
});

test('jsonByteLength 与格式化工具', () => {
  assert.ok(jsonByteLength({ a: 1 }) > 0);
  assert.equal(jsonByteLength(undefined), 0);
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(2048), '2KB');
  assert.equal(formatBytes(2 * BYTES_PER_MB), '2MB');
  assert.equal(formatMs(0.5), '0.5ms');
  assert.equal(formatMs(25.4), '25.4ms');
  assert.equal(formatMs(2500), '2.5s');
  assert.equal(formatCount(9999), '9999');
  assert.equal(formatCount(12_345), '12.3K');
  assert.equal(formatCount(2_500_000), '2.5M');
  assert.match(describeMemory({ peakHeapUsedMb: 12, peakRssMb: 34 }), /heap\+12MB rss=34MB/);
  assert.equal(describeMemory(null), 'memory=n/a');
});
