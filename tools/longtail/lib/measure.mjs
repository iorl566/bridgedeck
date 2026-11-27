// tools/longtail/lib/measure.mjs —— 时间 / 内存测量与原语（长尾预算证据的地基）。
//
// 目标不是做 profiling，而是给"真实模块在大夹具上跑一次"提供可复现的量化口径：
//   - 时间：performance.now()（单调时钟），记录每轮样本 + 分位数；
//   - 内存：process.memoryUsage() 快照差（heapUsed / rss），加上轮内峰值采样；
//   - 统计：count/min/mean/median/p95/max/stddev，避免只看一次"抖动值"；
//   - 错误：测量函数永不因为被测函数抛错而丢上下文，而是返回结构化 error。
//
// 注意：内存阈值不能按 process.memoryUsage().heapUsed 的绝对值卡死（V8 堆随进程历史增长），
// 所以预算门禁用"轮内相对增量（peak - before）"作为主证据，绝对 rss 只做上限兜底。

import { performance } from 'node:perf_hooks';

export const MEASURE_VERSION = 1;

export const BYTES_PER_MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// 时钟
// ---------------------------------------------------------------------------

/** 单调毫秒时钟。 */
export function nowMs() {
  return performance.now();
}

/** 从起点到现在的毫秒数（保留 3 位小数）。 */
export function elapsedMs(startMs) {
  return roundMs(performance.now() - Number(startMs || 0));
}

/** 毫秒保留 3 位小数，避免 JSON 里出现浮点尾巴。 */
export function roundMs(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : 0;
}

/** 毫秒→整数（预算阈值比较用）。 */
export function ceilMs(value) {
  return Math.ceil(roundMs(value));
}

// ---------------------------------------------------------------------------
// 内存
// ---------------------------------------------------------------------------

/** 当前内存快照（字节）。 */
export function readMemory() {
  const usage = process.memoryUsage();
  return {
    rss: Number(usage.rss) || 0,
    heapTotal: Number(usage.heapTotal) || 0,
    heapUsed: Number(usage.heapUsed) || 0,
    external: Number(usage.external) || 0,
    arrayBuffers: Number(usage.arrayBuffers) || 0,
  };
}

/** 字节→MB（2 位小数）。 */
export function toMb(bytes) {
  return Math.round((Number(bytes) || 0) / BYTES_PER_MB * 100) / 100;
}

/** 快照 → MB 视图。 */
export function memoryInMb(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : readMemory();
  return {
    rssMb: toMb(source.rss),
    heapTotalMb: toMb(source.heapTotal),
    heapUsedMb: toMb(source.heapUsed),
    externalMb: toMb(source.external),
    arrayBuffersMb: toMb(source.arrayBuffers),
  };
}

/** 两个快照的增量（MB）；峰值用第三个参数传入。 */
export function memoryDelta(before, after, peak = null) {
  const start = before && typeof before === 'object' ? before : readMemory();
  const end = after && typeof after === 'object' ? after : readMemory();
  const high = peak && typeof peak === 'object' ? peak : end;
  return {
    heapUsedMb: toMb(Number(end.heapUsed) - Number(start.heapUsed)),
    heapTotalMb: toMb(Number(end.heapTotal) - Number(start.heapTotal)),
    rssMb: toMb(Number(end.rss) - Number(start.rss)),
    peakHeapUsedMb: toMb(Number(high.heapUsed) - Number(start.heapUsed)),
    peakRssMb: toMb(Number(high.rss)),
    externalMb: toMb(Number(end.external) - Number(start.external)),
    before: memoryInMb(start),
    after: memoryInMb(end),
    peak: memoryInMb(high),
  };
}

/** 内存峰值跟踪器（在同步循环里定期 sampleHeap()，避免只测首尾两帧）。 */
export function createMemoryTracker() {
  const start = readMemory();
  let peak = start;
  let samples = 0;
  return {
    before: start,
    sample() {
      const current = readMemory();
      samples += 1;
      if (current.heapUsed > peak.heapUsed) peak = { ...current };
      if (current.rss > peak.rss) peak = { ...peak, rss: current.rss };
      return current;
    },
    samples: () => samples,
    finish() {
      const after = readMemory();
      if (after.heapUsed > peak.heapUsed) peak = { ...after };
      if (after.rss > peak.rss) peak = { ...peak, rss: after.rss };
      return memoryDelta(start, after, peak);
    },
  };
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

/** p 为 0..100 的分位数（线性插值；空数组返回 0）。 */
export function percentile(values, p) {
  const list = (Array.isArray(values) ? values : [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .sort((a, b) => a - b);
  if (list.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, Number(p) || 0));
  if (list.length === 1) return list[0];
  const position = (clamped / 100) * (list.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return list[lower];
  const weight = position - lower;
  return list[lower] * (1 - weight) + list[upper] * weight;
}

/** 样本统计（round 到毫秒 3 位小数）。 */
export function computeStats(values) {
  const list = (Array.isArray(values) ? values : [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  if (list.length === 0) {
    return { count: 0, sum: 0, min: 0, mean: 0, median: 0, p95: 0, max: 0, stddev: 0 };
  }
  const sum = list.reduce((total, item) => total + item, 0);
  const mean = sum / list.length;
  const variance = list.reduce((total, item) => total + (item - mean) ** 2, 0) / list.length;
  return {
    count: list.length,
    sum: roundMs(sum),
    min: roundMs(Math.min(...list)),
    mean: roundMs(mean),
    median: roundMs(percentile(list, 50)),
    p95: roundMs(percentile(list, 95)),
    max: roundMs(Math.max(...list)),
    stddev: roundMs(Math.sqrt(variance)),
  };
}

// ---------------------------------------------------------------------------
// 测量原语
// ---------------------------------------------------------------------------

function normalizeOptions(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  return {
    label: typeof source.label === 'string' && source.label ? source.label : 'run',
    rounds: Math.max(1, Math.floor(Number(source.rounds) || 1)),
    warmup: Math.max(0, Math.floor(Number(source.warmup) || 0)),
    sampleMemory: source.sampleMemory !== false,
    captureValue: source.captureValue !== false,
  };
}

function resultOf(label, samples, totalMs, memory, value, error = null) {
  return {
    label,
    version: MEASURE_VERSION,
    ok: error === null,
    error: error ? { name: String((error && error.name) || 'Error'), message: String((error && error.message) || error) } : null,
    stats: computeStats(samples),
    totalMs: roundMs(totalMs),
    samples: samples.map((item) => roundMs(item)),
    memory,
    ...(error || value === undefined ? {} : { value }),
  };
}

/**
 * 同步测量：warmup 轮不计样本；rounds 轮分别计时；每轮后采内存峰值。
 * @template T
 * @param {(round:number)=>T} fn
 * @param {{label?:string, rounds?:number, warmup?:number, sampleMemory?:boolean, captureValue?:boolean}} [options]
 */
export function measureSync(fn, options = {}) {
  const opts = normalizeOptions(options);
  if (typeof fn !== 'function') throw new TypeError('measureSync 需要函数');
  let value;
  let error = null;
  const samples = [];
  try {
    for (let round = 0; round < opts.warmup; round += 1) fn(-1 - round);
    const tracker = opts.sampleMemory ? createMemoryTracker() : null;
    const start = nowMs();
    for (let round = 0; round < opts.rounds; round += 1) {
      const roundStart = nowMs();
      const current = fn(round);
      if (round === opts.rounds - 1) value = current;
      samples.push(nowMs() - roundStart);
      if (tracker) tracker.sample();
    }
    const totalMs = nowMs() - start;
    return resultOf(
      opts.label,
      samples,
      totalMs,
      tracker ? tracker.finish() : null,
      opts.captureValue ? value : undefined,
    );
  } catch (caught) {
    error = caught;
    const memory = opts.sampleMemory ? memoryDelta(readMemory(), readMemory()) : null;
    return resultOf(opts.label, [], 0, memory, undefined, error);
  }
}

/**
 * 异步测量（sealManifest 等真实 async 模块用）。
 * @param {(round:number)=>Promise<any>} fn
 */
export async function measureAsync(fn, options = {}) {
  const opts = normalizeOptions(options);
  if (typeof fn !== 'function') throw new TypeError('measureAsync 需要函数');
  const samples = [];
  let value;
  try {
    for (let round = 0; round < opts.warmup; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      await fn(-1 - round);
    }
    const tracker = opts.sampleMemory ? createMemoryTracker() : null;
    const start = nowMs();
    for (let round = 0; round < opts.rounds; round += 1) {
      const roundStart = nowMs();
      // eslint-disable-next-line no-await-in-loop
      const current = await fn(round);
      if (round === opts.rounds - 1) value = current;
      samples.push(nowMs() - roundStart);
      if (tracker) tracker.sample();
    }
    const totalMs = nowMs() - start;
    return resultOf(opts.label, samples, totalMs, tracker ? tracker.finish() : null, opts.captureValue ? value : undefined);
  } catch (caught) {
    return resultOf(opts.label, samples, 0, opts.sampleMemory ? memoryDelta(readMemory(), readMemory()) : null, undefined, caught);
  }
}

/**
 * 探针：只关心"是否抛错 / 耗时 / 结构化错误内容"，用于失败注入矩阵
 * （例如"sealed manifest 再追加分片必须拒绝"）。永远不抛。
 */
export function probe(label, fn, { rounds = 1 } = {}) {
  const measured = measureSync(fn, { label, rounds, warmup: 0, captureValue: true });
  return {
    label,
    ok: measured.ok,
    ms: measured.stats.median,
    errorCode: measured.ok ? null : (measured.error && measured.error.name) || null,
    errorMessage: measured.ok ? null : (measured.error && measured.error.message) || null,
    value: measured.value,
  };
}

/** JSON 文本的 UTF-8 字节数（大夹具不复制字符串）。 */
export function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

/** 字节 → 人类可读。 */
export function formatBytes(bytes) {
  const number = Number(bytes) || 0;
  if (Math.abs(number) < 1024) return number + 'B';
  if (Math.abs(number) < 1024 * 1024) return Math.round(number / 1024 * 10) / 10 + 'KB';
  if (Math.abs(number) < 1024 * 1024 * 1024) return Math.round(number / BYTES_PER_MB * 10) / 10 + 'MB';
  return Math.round(number / (1024 * 1024 * 1024) * 100) / 100 + 'GB';
}

/** 毫秒 → 人类可读。 */
export function formatMs(ms) {
  const number = Number(ms) || 0;
  if (Math.abs(number) < 1) return roundMs(number) + 'ms';
  if (Math.abs(number) < 1000) return Math.round(number * 10) / 10 + 'ms';
  return Math.round(number / 1000 * 100) / 100 + 's';
}

/** 数字 → 紧凑显示（≥1e4 用 K，≥1e6 用 M）。 */
export function formatCount(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1_000_000) return Math.round(number / 10_000) / 100 + 'M';
  if (Math.abs(number) >= 10_000) return Math.round(number / 100) / 10 + 'K';
  return String(number);
}

/** 内存差 → 一行文本（诊断/报告用）。 */
export function describeMemory(memory) {
  if (!memory || typeof memory !== 'object') return 'memory=n/a';
  return 'heap+' + (Number(memory.peakHeapUsedMb) || 0) + 'MB rss=' + (Number(memory.peakRssMb) || 0) + 'MB';
}
