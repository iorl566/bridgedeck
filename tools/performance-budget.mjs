#!/usr/bin/env node
// tools/performance-budget.mjs —— 性能预算门禁（数据驱动 + 可更新基线）。
//
// 为什么需要它：0.3.0 之前只有零散的“单测里 assert elapsed < 2000ms”式断言，既没有统一
// 基线，也没有内存预算，CI 上跑不跑全凭心情。W4 起把四条真实热路径的 latency/内存预算
// 收进同一个门禁：
//   observe       —— VOM 评分 → 排序 → 预算裁剪（extension/src/lib/vom-weights.js、vom-budget.js）
//   vom.billing   —— o200k token 计费（extension/src/lib/vom-billing.js + vendor 词表）
//   har           —— HAR 1.2 规范化解析（lib/har-normalize.mjs）
//   longshot      —— 长截图分段规划 + tile 矩形 + 计划自检（extension/src/lib/longshot-segments.js）
//
// 数据驱动：`tools/performance-baseline.json`（或 --baseline 指定）存最近一次实测的 p95/内存
// 基线；预算 = 基线 × 容差（延迟默认 3x、内存默认 4x，另有最小预算下限，避免 0.1ms 抖动）。
// 超预算 → exit 1。`--update` 只在显式调用时重写基线，避免“实现变慢 → 顺手更新基线”的静默漂移。
//
// 兼容性：CI 用 `node tools/performance-budget.mjs`（默认 check）；release-preflight 也调用它。
// 内存测量需要 --expose-gc：本进程没有 global.gc 时会自动以 --expose-gc 重跑自身
// （BB_PERF_CHILD=1 防递归）；无法重跑时退化为近似测量并在报告里标注。
//
// 用法：
//   node tools/performance-budget.mjs                 # 按基线检查（默认）
//   node tools/performance-budget.mjs --json          # 机器可读结果
//   node tools/performance-budget.mjs --update        # 用本次实测重写基线
//   node tools/performance-budget.mjs --only har,longshot --iterations 10
//   node tools/performance-budget.mjs --baseline .tmp/perf.json --list
//   node tools/performance-budget.mjs --no-memory     # 只测延迟（受限环境）
//   node tools/performance-budget.mjs --help
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { attachVomScores, rankVomNodes } from '../extension/src/lib/vom-weights.js';
import { evaluateVomBudget } from '../extension/src/lib/vom-budget.js';
import { createBillingLedger } from '../extension/src/lib/vom-billing.js';
import { isO200kLoaded, setO200kData } from '../extension/src/lib/o200k.js';
import { normalizeHar } from '../lib/har-normalize.mjs';
import { planLongshotSegments, tileRectsForSegment, validateSegmentPlan } from '../extension/src/lib/longshot-segments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE_PATH = path.join(ROOT, 'tools', 'performance-baseline.json');
const O200K_VOCAB = path.join(ROOT, 'extension', 'vendor', 'o200k', 'o200k_base.tiktoken');
const MIB = 1024 * 1024;
const SELF = fileURLToPath(import.meta.url);

/** 预算容差与下限：延迟/内存各一个倍数，再加最小预算，避免微小基线把抖动放大成失败。 */
export const DEFAULT_TOLERANCE = Object.freeze({
  latency: 3,
  memory: 4,
  minLatencyBudgetMs: 2,
  minMemoryBudgetBytes: 8 * MIB,
});

// ---------------------------------------------------------------------------
// 测试夹具：确定性的“生产形状”输入（不依赖真实浏览器）。
// ---------------------------------------------------------------------------

const ROLES = ['button', 'link', 'textbox', 'checkbox', 'heading', 'paragraph', 'listitem', 'combobox'];
const TAGS = ['button', 'a', 'input', 'h2', 'p', 'li', 'select', 'div'];
const NAMES = ['提交订单', 'Search', '登录 / Sign in', '下一页', 'Filter results', '购物车（3）', 'Save draft', 'Close dialog'];

/** 合成 VOM 节点：字段形状与 page-lib 产出的观察节点一致（rect/x,y,width,height）。 */
function syntheticVomNodes(count) {
  const nodes = [];
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / 24);
    nodes.push({
      id: 'n' + index,
      ref: '@e' + (index + 1),
      role: ROLES[index % ROLES.length],
      tag: TAGS[index % TAGS.length],
      name: NAMES[index % NAMES.length] + ' #' + (index % 97),
      depth: 3 + (index % 9),
      interactive: index % 3 !== 1,
      inForm: index % 7 === 0,
      required: index % 11 === 0,
      focused: index === 3,
      selected: index % 13 === 0,
      rect: { x: (index % 24) * 50, y: (row % 40) * 30, width: 40 + (index % 5) * 10, height: 24 },
      ancestors: index % 5 === 0 ? [{ role: 'main', tag: 'main' }] : [],
    });
  }
  return nodes;
}

/** 合成 HAR：400 条 HTTP entry（含 headers/timings/content）+ 30 条 WS 帧 entry。 */
function syntheticHar() {
  const started = Date.parse('2026-11-25T10:00:00.000Z');
  const entries = [];
  for (let index = 0; index < 400; index += 1) {
    const offset = index * 17;
    entries.push({
      startedDateTime: new Date(started + offset).toISOString(),
      time: 12.5,
      request: {
        method: index % 5 === 0 ? 'POST' : 'GET',
        url: 'https://example.test/api/items/' + index + '?page=' + (index % 9),
        httpVersion: 'http/2.0',
        headers: [
          { name: 'accept', value: 'application/json' },
          { name: 'x-trace', value: 'trace-' + index },
        ],
        queryString: [{ name: 'page', value: String(index % 9) }],
        cookies: [],
        headersSize: 120,
        bodySize: index % 5 === 0 ? 64 : 0,
        postData: index % 5 === 0 ? { mimeType: 'application/json', text: '{"id":' + index + '}' } : undefined,
      },
      response: {
        status: index % 37 === 0 ? 500 : 200,
        statusText: index % 37 === 0 ? 'Internal Server Error' : 'OK',
        httpVersion: 'http/2.0',
        headers: [{ name: 'content-type', value: 'application/json' }],
        cookies: [],
        content: { size: 512, mimeType: 'application/json', text: '{"ok":true,"index":' + index + '}' },
        redirectURL: '',
        headersSize: 90,
        bodySize: 512,
      },
      cache: {},
      timings: { blocked: 1, dns: 2, connect: 3, send: 0.5, wait: 8, receive: 4 },
      serverIPAddress: '127.0.0.1',
    });
  }
  for (let index = 0; index < 30; index += 1) {
    entries.push({
      startedDateTime: new Date(started + 9000 + index * 3).toISOString(),
      time: 2,
      request: { method: 'GET', url: 'wss://example.test/socket', httpVersion: 'http/1.1', headers: [], queryString: [], cookies: [], headersSize: 40, bodySize: 0 },
      response: { status: 101, statusText: 'Switching Protocols', httpVersion: 'http/1.1', headers: [], cookies: [], content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: 30, bodySize: 0 },
      cache: {},
      timings: { blocked: 0, dns: 0, connect: 1, send: 0.2, wait: 0.5, receive: 0.3 },
      _webSocketMessages: Array.from({ length: 12 }, (_, frame) => ({
        type: frame % 2 === 0 ? 'send' : 'receive',
        time: started + 9000 + index * 3 + frame,
        opcode: frame % 3 === 0 ? 2 : 1,
        data: 'frame-' + index + '-' + frame + ' ' + 'x'.repeat(200),
      })),
    });
  }
  return { log: { version: '1.2', creator: { name: 'bench', version: '1.0' }, pages: [], entries } };
}

/** 真实 o200k 词表（3.6MB tiktoken）；缺失时退化为测试同款合成词表，保证门禁可跑。 */
function ensureO200k() {
  if (isO200kLoaded()) return { vocab: 'already-loaded' };
  let text = null;
  try {
    if (fs.existsSync(O200K_VOCAB)) text = fs.readFileSync(O200K_VOCAB, 'utf8');
  } catch {
    text = null;
  }
  if (text) {
    setO200kData(text);
    return { vocab: 'vendor/o200k_base.tiktoken' };
  }
  const lines = [];
  for (let byte = 0; byte < 256; byte += 1) lines.push(Buffer.from([byte]).toString('base64') + ' ' + byte);
  lines.push(Buffer.from('ab').toString('base64') + ' 300');
  setO200kData(lines.join('\n'));
  return { vocab: 'synthetic-256' };
}

// ---------------------------------------------------------------------------
// 基准定义：每条都是一个真实运行时函数链，run() 的返回值会被保留用于内存测量。
// ---------------------------------------------------------------------------

export const BENCHMARKS = Object.freeze([
  {
    id: 'observe.vom-rank',
    label: 'observe：VOM 评分→排序→预算裁剪',
    group: 'observe',
    iterations: 20,
    setup: () => ({ nodes: syntheticVomNodes(1200) }),
    run(input) {
      const scored = attachVomScores(input.nodes);
      const ranked = rankVomNodes(scored, { limit: 600 });
      const budget = evaluateVomBudget(ranked, { maxNodes: 300, maxTokens: 9000 });
      return { ranked, kept: budget.kept, drops: budget.drops.length };
    },
  },
  {
    id: 'vom.billing',
    label: 'VOM 计费：o200k createBillingLedger',
    group: 'vom',
    iterations: 15,
    setup() {
      const vocab = ensureO200k();
      return { nodes: syntheticVomNodes(1200), vocab };
    },
    run(input) {
      return createBillingLedger(input.nodes);
    },
  },
  {
    id: 'har.normalize',
    label: 'HAR 解析：normalizeHar(400 HTTP + 30 WS)',
    group: 'har',
    iterations: 12,
    setup: () => ({ har: syntheticHar() }),
    run(input) {
      return normalizeHar(input.har);
    },
  },
  {
    id: 'longshot.plan',
    label: '长截图：分段规划 + tile 矩形 + 自检',
    group: 'longshot',
    iterations: 20,
    setup: () => ({
      params: { deviceWidth: 1241, deviceHeight: 1200000, dpr: 1.5, fixedTop: 84, fixedBottom: 120, maxSegmentHeight: 40000 },
    }),
    run(input) {
      const plan = planLongshotSegments(input.params);
      const tiles = plan.segments.map((segment) => tileRectsForSegment(segment, 512));
      const validation = validateSegmentPlan(plan);
      return { plan, tiles, validation };
    },
  },
]);

/**
 * 内置基线（2026-11-25 本机首次实测写入；CI 首次运行也可用）。
 * 真实门禁以 tools/performance-baseline.json 优先：存在即覆盖这份内置值。
 * 数值来源：`node tools/performance-budget.mjs --update`（30 次采样 / o200k 真实词表）。
 */
export const DEFAULT_BASELINE = Object.freeze({
  version: 1,
  recordedAt: '2026-11-25T10:33:11.901Z',
  source: 'embedded',
  tolerance: { ...DEFAULT_TOLERANCE },
  benchmarks: Object.freeze({
    'observe.vom-rank': Object.freeze({ p50Ms: 4, p95Ms: 6, retainedBytes: 351000 }),
    'vom.billing': Object.freeze({ p50Ms: 33.2, p95Ms: 45, retainedBytes: 176 }),
    'har.normalize': Object.freeze({ p50Ms: 2.37, p95Ms: 3.25, retainedBytes: 755088 }),
    'longshot.plan': Object.freeze({ p50Ms: 0.34, p95Ms: 0.6, retainedBytes: 1338416 }),
  }),
});

// ---------------------------------------------------------------------------
// 统计与判定（纯函数，便于单测；不读时钟以外的环境）。
// ---------------------------------------------------------------------------

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/** 采样 → {minMs, medianMs(p50), p95Ms, maxMs, meanMs, samples}。 */
export function computeStats(samples) {
  const values = (Array.isArray(samples) ? samples : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!values.length) return { samples: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null, meanMs: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    minMs: round(values[0]),
    medianMs: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(values[values.length - 1]),
    meanMs: round(total / values.length),
  };
}

/** 基线条目 → 本次允许的预算（倍数 + 最小下限）。 */
export function deriveBudget(entry, tolerance = DEFAULT_TOLERANCE) {
  const limits = { ...DEFAULT_TOLERANCE, ...(tolerance || {}) };
  const p95 = Number(entry && entry.p95Ms);
  const retained = Number(entry && entry.retainedBytes);
  const latencyFactor = Number(limits.latency) > 1 ? Number(limits.latency) : DEFAULT_TOLERANCE.latency;
  const memoryFactor = Number(limits.memory) > 1 ? Number(limits.memory) : DEFAULT_TOLERANCE.memory;
  return {
    p95Ms: Number.isFinite(p95)
      ? round(Math.max(p95 * latencyFactor, p95 + Number(limits.minLatencyBudgetMs), 0.5))
      : null,
    retainedBytes: Number.isFinite(retained)
      ? Math.max(Math.round(retained * memoryFactor), Math.round(retained + Number(limits.minMemoryBudgetBytes)), Math.round(Number(limits.minMemoryBudgetBytes)))
      : null,
    latencyFactor,
    memoryFactor,
  };
}

/**
 * 实测 vs 基线：超预算/缺基线都是失败。
 * @param {Array<{id:string,label:string,group:string,p50Ms:number,p95Ms:number,maxMs:number,retainedBytes:number|null}>} measurements
 * @param {{benchmarks:Object, tolerance?:object}} baseline
 * @param {{tolerance?:object, requireMemory?:boolean}} [options]
 */
export function evaluateBudgets(measurements, baseline, options = {}) {
  const entries = (baseline && baseline.benchmarks) || {};
  const tolerance = { ...DEFAULT_TOLERANCE, ...((baseline && baseline.tolerance) || {}), ...(options.tolerance || {}) };
  const requireMemory = options.requireMemory !== false;
  const rows = [];
  const breaches = [];
  for (const measurement of Array.isArray(measurements) ? measurements : []) {
    const entry = entries[measurement.id];
    if (!entry) {
      rows.push({ ...measurement, budget: null, latencyOk: false, memoryOk: true, status: 'no-baseline' });
      breaches.push({ id: measurement.id, kind: 'baseline-missing', detail: '基线缺少 ' + measurement.id + '（运行 --update 生成基线）' });
      continue;
    }
    const budget = deriveBudget(entry, tolerance);
    const latencyOk = budget.p95Ms == null || Number(measurement.p95Ms) <= budget.p95Ms;
    const hasMemory = measurement.retainedBytes != null && budget.retainedBytes != null && requireMemory;
    const memoryOk = !hasMemory || Number(measurement.retainedBytes) <= budget.retainedBytes;
    if (!latencyOk) {
      breaches.push({
        id: measurement.id,
        kind: 'latency',
        detail: measurement.id + ' p95 ' + measurement.p95Ms + 'ms 超预算 ' + budget.p95Ms + 'ms（基线 ' + entry.p95Ms + 'ms ×' + budget.latencyFactor + '）',
      });
    }
    if (!memoryOk) {
      breaches.push({
        id: measurement.id,
        kind: 'memory',
        detail: measurement.id + ' 保留内存 ' + measurement.retainedBytes + 'B 超预算 ' + budget.retainedBytes + 'B（基线 ' + entry.retainedBytes + 'B ×' + budget.memoryFactor + '）',
      });
    }
    rows.push({
      ...measurement,
      budget,
      latencyOk,
      memoryOk: hasMemory ? memoryOk : null,
      status: latencyOk && memoryOk ? 'ok' : 'over-budget',
    });
  }
  return { ok: breaches.length === 0, tolerance, rows, breaches };
}

/** 用实测结果构造/更新基线（--update 唯一写入路径）。 */
export function buildBaseline(measurements, { tolerance = DEFAULT_TOLERANCE, recordedAt = new Date().toISOString(), source = 'measured' } = {}) {
  const benchmarks = {};
  for (const measurement of Array.isArray(measurements) ? measurements : []) {
    benchmarks[measurement.id] = {
      p50Ms: measurement.medianMs,
      p95Ms: measurement.p95Ms,
      retainedBytes: measurement.retainedBytes == null ? null : Math.max(0, Math.round(measurement.retainedBytes)),
    };
  }
  return { version: 1, source, recordedAt, tolerance: { ...DEFAULT_TOLERANCE, ...(tolerance || {}) }, benchmarks };
}

/** 读取基线文件；不存在返回 null，存在但非法直接抛（不能把坏基线当默认值放过门禁）。 */
export function loadBaseline(file) {
  const target = file || DEFAULT_BASELINE_PATH;
  if (!fs.existsSync(target)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error('性能基线不是合法 JSON：' + target + '（' + ((error && error.message) || error) + '）');
  }
  if (!parsed || typeof parsed !== 'object' || Number(parsed.version) !== 1 || !parsed.benchmarks || typeof parsed.benchmarks !== 'object') {
    throw new Error('性能基线格式非法（需要 {version:1, benchmarks:{...}}）：' + target);
  }
  return parsed;
}

export function writeBaseline(file, baseline) {
  const target = file || DEFAULT_BASELINE_PATH;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  return target;
}

// ---------------------------------------------------------------------------
// 运行器：setup 只跑一次；先 warmup 再采样；内存用 gc 后 heapUsed 差值（结果保持可达）。
// ---------------------------------------------------------------------------

const WARMUP_RUNS = 3;

function gcBestEffort() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
    return true;
  }
  return false;
}

function measureRetainedBytes(run, input) {
  gcBestEffort();
  const before = process.memoryUsage().heapUsed;
  const retained = run(input);
  gcBestEffort();
  const after = process.memoryUsage().heapUsed;
  // retained 在读取 after 时仍可达，差值接近“这次调用的净保留内存”。
  void retained;
  return Math.max(0, after - before);
}

/**
 * 跑选中的基准。
 * @param {{only?:string[]|null, iterations?:number|null, measureMemory?:boolean}} [options]
 */
export function runBenchmarks(options = {}) {
  const only = Array.isArray(options.only) && options.only.length ? new Set(options.only) : null;
  const selected = BENCHMARKS.filter((bench) => !only || only.has(bench.id));
  const measureMemory = options.measureMemory !== false;
  const withGc = typeof global.gc === 'function';
  const measurements = [];
  for (const bench of selected) {
    const input = typeof bench.setup === 'function' ? bench.setup() : undefined;
    for (let index = 0; index < WARMUP_RUNS; index += 1) bench.run(input);
    const iterations = Math.max(1, Math.min(500, Math.round(Number(options.iterations) > 0 ? Number(options.iterations) : bench.iterations)));
    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      bench.run(input);
      samples.push(performance.now() - started);
    }
    const stats = computeStats(samples);
    const retainedBytes = measureMemory ? measureRetainedBytes(bench.run, input) : null;
    measurements.push({
      id: bench.id,
      label: bench.label,
      group: bench.group,
      iterations,
      retainedBytes,
      ...stats,
    });
  }
  return { measurements, measureMemory, gcAvailable: withGc };
}

// ---------------------------------------------------------------------------
// CLI：参数解析、报告、退出码。所有 gate 逻辑都在 evaluateBudgets，CLI 只做 IO。
// ---------------------------------------------------------------------------

export class UsageError extends Error {}

/** 解析 argv（不读环境，便于单测）。 */
export function parseArgs(argv = []) {
  const options = {
    check: true,
    json: false,
    update: false,
    list: false,
    help: false,
    noMemory: false,
    only: null,
    iterations: null,
    baseline: null,
    latencyTolerance: null,
    memoryTolerance: null,
  };
  const list = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = String(list[index]);
    const takeValue = (name) => {
      const value = list[index + 1];
      if (value === undefined || String(value).startsWith('--')) throw new UsageError(name + ' 需要一个值');
      index += 1;
      return String(value);
    };
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--update') { options.update = true; options.check = true; }
    else if (arg === '--list') options.list = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--no-memory') options.noMemory = true;
    else if (arg === '--only') {
      options.only = takeValue('--only').split(',').map((item) => item.trim()).filter(Boolean);
      if (!options.only.length) throw new UsageError('--only 需要至少一个 benchmark id');
      const known = new Set(BENCHMARKS.map((bench) => bench.id));
      const unknown = options.only.filter((id) => !known.has(id));
      if (unknown.length) throw new UsageError('--only 含未知 benchmark：' + unknown.join(', '));
    } else if (arg.startsWith('--only=')) {
      options.only = arg.slice('--only='.length).split(',').map((item) => item.trim()).filter(Boolean);
      if (!options.only.length) throw new UsageError('--only 需要至少一个 benchmark id');
      const known = new Set(BENCHMARKS.map((bench) => bench.id));
      const unknown = options.only.filter((id) => !known.has(id));
      if (unknown.length) throw new UsageError('--only 含未知 benchmark：' + unknown.join(', '));
    } else if (arg === '--iterations') {
      const value = Number(takeValue('--iterations'));
      if (!Number.isInteger(value) || value < 1 || value > 500) throw new UsageError('--iterations 需要 1..500 的整数');
      options.iterations = value;
    } else if (arg.startsWith('--iterations=')) {
      const value = Number(arg.slice('--iterations='.length));
      if (!Number.isInteger(value) || value < 1 || value > 500) throw new UsageError('--iterations 需要 1..500 的整数');
      options.iterations = value;
    } else if (arg === '--baseline') {
      options.baseline = takeValue('--baseline');
    } else if (arg.startsWith('--baseline=')) {
      options.baseline = arg.slice('--baseline='.length);
      if (!options.baseline) throw new UsageError('--baseline 需要文件路径');
    } else if (arg === '--tolerance') {
      const value = Number(takeValue('--tolerance'));
      if (!Number.isFinite(value) || value < 1 || value > 100) throw new UsageError('--tolerance 需要 1..100');
      options.latencyTolerance = value;
    } else if (arg === '--memory-tolerance') {
      const value = Number(takeValue('--memory-tolerance'));
      if (!Number.isFinite(value) || value < 1 || value > 100) throw new UsageError('--memory-tolerance 需要 1..100');
      options.memoryTolerance = value;
    } else {
      throw new UsageError('未知参数：' + arg);
    }
  }
  return options;
}

function formatMs(value) {
  return Number.isFinite(value) ? value.toFixed(2) + 'ms' : '-';
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '-';
  if (value >= MIB) return (value / MIB).toFixed(1) + 'MB';
  if (value >= 1024) return (value / 1024).toFixed(0) + 'KB';
  return Math.round(value) + 'B';
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** 可读报告（纯函数）。 */
export function formatReport(result) {
  const lines = [];
  const source = result.baselineSource || 'embedded';
  const tolerance = result.tolerance || DEFAULT_TOLERANCE;
  lines.push('性能预算门禁（baseline: ' + source + (result.baselineRecordedAt ? ' @ ' + result.baselineRecordedAt : '') + '；'
    + '容差 延迟 ×' + tolerance.latency + ' 内存 ×' + tolerance.memory + '）');
  lines.push('  ' + pad('domain', 10) + pad('benchmark', 24) + pad('median', 10) + pad('p95', 10) + pad('budget(p95)', 13) + pad('retained', 11) + pad('memBudget', 11) + '结果');
  for (const row of result.rows || []) {
    const budgetP95 = row.budget && row.budget.p95Ms != null ? formatMs(row.budget.p95Ms) : '-';
    const memBudget = row.budget && row.budget.retainedBytes != null ? formatBytes(row.budget.retainedBytes) : '-';
    lines.push('  ' + pad(row.group, 10) + pad(row.id, 24) + pad(formatMs(row.medianMs), 10) + pad(formatMs(row.p95Ms), 10)
      + pad(budgetP95, 13) + pad(formatBytes(row.retainedBytes), 11) + pad(memBudget, 11) + (row.status === 'ok' ? 'ok' : row.status));
  }
  if (result.measureMemory === false) lines.push('  说明：未测内存（--no-memory 或 gc 不可用）');
  for (const breach of result.breaches || []) lines.push('  breach[' + breach.kind + ']: ' + breach.detail);
  lines.push(result.ok ? 'PERF BUDGET PASS' : 'PERF BUDGET FAILED');
  return lines.join('\n');
}

function printUsage() {
  console.log(`性能预算门禁 v1

用法：
  node tools/performance-budget.mjs [--json] [--only id,id] [--iterations N]
                                    [--baseline <file>] [--update] [--no-memory]
                                    [--tolerance N] [--memory-tolerance N] [--list]

基准（id / 组 / 覆盖）：
${BENCHMARKS.map((bench) => '  ' + bench.id.padEnd(18) + bench.group.padEnd(10) + bench.label).join('\n')}

退出码：0=预算内；1=超预算/缺基线；2=用法错误或运行失败。`);
}

/** 主流程（可注入 IO 便于测试；默认返回退出码不直接 process.exit）。 */
export function main(argv = [], io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text + '\n'));
  const stderr = io.stderr || ((text) => process.stderr.write(text + '\n'));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(String((error && error.message) || error));
    return 2;
  }
  if (options.help) { (io.stdout || ((text) => process.stdout.write(text + '\n')))(printUsageText()); return 0; }
  if (options.list) {
    const rows = BENCHMARKS.map((bench) => ({ id: bench.id, group: bench.group, label: bench.label, iterations: bench.iterations }));
    stdout(options.json ? JSON.stringify({ benchmarks: rows }, null, 2) : rows.map((row) => row.id.padEnd(18) + row.group.padEnd(10) + row.label).join('\n'));
    return 0;
  }
  let baseline;
  let baselineSource = 'embedded';
  try {
    const file = options.baseline || DEFAULT_BASELINE_PATH;
    const loaded = loadBaseline(file);
    if (loaded) {
      baseline = loaded;
      baselineSource = path.relative(ROOT, path.resolve(file)).replace(/\\/g, '/');
    } else {
      baseline = DEFAULT_BASELINE;
    }
  } catch (error) {
    stderr(String((error && error.message) || error));
    return 2;
  }
  const tolerance = { ...DEFAULT_TOLERANCE, ...((baseline && baseline.tolerance) || {}) };
  if (options.latencyTolerance) tolerance.latency = options.latencyTolerance;
  if (options.memoryTolerance) tolerance.memory = options.memoryTolerance;
  let run;
  try {
    run = runBenchmarks({ only: options.only, iterations: options.iterations, measureMemory: options.noMemory !== true });
  } catch (error) {
    stderr('性能基准运行失败：' + String((error && error.message) || error));
    return 2;
  }
  if (options.update) {
    const next = buildBaseline(run.measurements, { tolerance, recordedAt: new Date().toISOString() });
    const target = writeBaseline(options.baseline || DEFAULT_BASELINE_PATH, next);
    stdout('性能基线已更新：' + path.relative(ROOT, target).replace(/\\/g, '/'));
    baseline = next;
    baselineSource = path.relative(ROOT, target).replace(/\\/g, '/');
  }
  const evaluated = evaluateBudgets(run.measurements, baseline, { tolerance, requireMemory: run.measureMemory });
  const result = {
    ok: evaluated.ok,
    baselineSource,
    baselineRecordedAt: baseline.recordedAt || null,
    tolerance: evaluated.tolerance,
    measureMemory: run.measureMemory,
    gcAvailable: run.gcAvailable,
    rows: evaluated.rows,
    breaches: evaluated.breaches,
  };
  if (options.json) stdout(JSON.stringify(result, null, 2));
  else stdout(formatReport(result));
  return result.ok ? 0 : 1;
}

function printUsageText() {
  return `性能预算门禁 v1

用法：
  node tools/performance-budget.mjs [--json] [--only id,id] [--iterations N]
                                    [--baseline <file>] [--update] [--no-memory]
                                    [--tolerance N] [--memory-tolerance N] [--list]

基准（id / 组 / 覆盖）：
${BENCHMARKS.map((bench) => '  ' + bench.id.padEnd(18) + bench.group.padEnd(10) + bench.label).join('\n')}

退出码：0=预算内；1=超预算/缺基线；2=用法错误或运行失败。`;
}

// ---------------------------------------------------------------------------
// 入口：若无 global.gc 则用 --expose-gc 重跑自身，拿到准确的内存保留量。
// ---------------------------------------------------------------------------
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMain = invokedPath.toLowerCase() === SELF.toLowerCase();

if (isMain) {
  const argv = process.argv.slice(2);
  const wantsMemory = !argv.includes('--no-memory');
  const alreadyChild = process.env.BB_PERF_CHILD === '1';
  if (wantsMemory && !alreadyChild && typeof global.gc !== 'function') {
    const child = spawnSync(process.execPath, ['--expose-gc', SELF, ...argv], {
      stdio: 'inherit',
      env: { ...process.env, BB_PERF_CHILD: '1' },
    });
    if (!child.error) process.exit(typeof child.status === 'number' ? child.status : 1);
    process.stderr.write('warn: 无法以 --expose-gc 重跑，内存预算退化为近似测量（' + ((child.error && child.error.message) || 'spawn failed') + '）\n');
  }
  process.exit(main(argv));
}
