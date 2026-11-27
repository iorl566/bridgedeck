// tests/unit/performance-budget-gate.test.mjs —— 性能预算门禁（tools/performance-budget.mjs）。
//
// 覆盖两层：
//   1) 纯判定逻辑（统计/预算推导/超预算/缺基线/参数解析/基线读写）——确定性断言；
//   2) 真实 CLI：spawn 工具本身，验证 --update 写基线、预算内 exit 0、缺基线 exit 1。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BENCHMARKS,
  DEFAULT_BASELINE,
  DEFAULT_TOLERANCE,
  UsageError,
  buildBaseline,
  computeStats,
  deriveBudget,
  evaluateBudgets,
  formatReport,
  loadBaseline,
  parseArgs,
  writeBaseline,
} from '../../tools/performance-budget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'tools', 'performance-budget.mjs');
const MIB = 1024 * 1024;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-perf-budget-'));
}

function runTool(args, { timeout = 120000 } = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', timeout });
}

test('四个真实热路径都在基准表里，且有迭代次数与标签', () => {
  assert.deepEqual(BENCHMARKS.map((bench) => bench.id), ['observe.vom-rank', 'vom.billing', 'har.normalize', 'longshot.plan']);
  assert.deepEqual(BENCHMARKS.map((bench) => bench.group), ['observe', 'vom', 'har', 'longshot']);
  for (const bench of BENCHMARKS) {
    assert.equal(typeof bench.label, 'string');
    assert.ok(bench.label.length > 4, bench.id + ' 标签太短');
    assert.ok(Number.isInteger(bench.iterations) && bench.iterations >= 5, bench.id + ' 迭代次数不合理');
    assert.equal(typeof bench.setup, 'function');
    assert.equal(typeof bench.run, 'function');
  }
  // 内置基线覆盖全部基准，不允许“有基准无基线”。
  for (const bench of BENCHMARKS) {
    const entry = DEFAULT_BASELINE.benchmarks[bench.id];
    assert.ok(entry, bench.id + ' 缺少内置基线');
    assert.ok(Number.isFinite(entry.p95Ms) && entry.p95Ms > 0, bench.id + ' p95 基线非法');
    assert.ok(Number.isFinite(entry.retainedBytes) && entry.retainedBytes >= 0, bench.id + ' 内存基线非法');
  }
});

test('computeStats：中位数/p95/极值/均值，过滤非法样本', () => {
  const stats = computeStats([4, 1, 3, 2, 10]);
  assert.equal(stats.samples, 5);
  assert.equal(stats.minMs, 1);
  assert.equal(stats.medianMs, 3);
  assert.equal(stats.p95Ms, 10);
  assert.equal(stats.maxMs, 10);
  assert.equal(stats.meanMs, 4);
  const noisy = computeStats([2, '3', NaN, -1, Infinity, 4]);
  assert.equal(noisy.samples, 3);
  assert.equal(noisy.medianMs, 3);
  const empty = computeStats([]);
  assert.equal(empty.samples, 0);
  assert.equal(empty.medianMs, null);
  assert.equal(computeStats(null).p95Ms, null);
});

test('deriveBudget：基线 × 容差 + 最小预算下限', () => {
  const budget = deriveBudget({ p95Ms: 10, retainedBytes: 1 * MIB });
  assert.equal(budget.p95Ms, 30);
  assert.equal(budget.retainedBytes, 9 * MIB, '内存预算取 max(4x, baseline+8MB, 8MB)');
  assert.equal(budget.latencyFactor, DEFAULT_TOLERANCE.latency);
  const custom = deriveBudget({ p95Ms: 10, retainedBytes: 1 * MIB }, { latency: 2, memory: 2, minLatencyBudgetMs: 1, minMemoryBudgetBytes: 0 });
  assert.equal(custom.p95Ms, 20);
  assert.equal(custom.retainedBytes, 2 * MIB);
  // 极小基线由最小预算兜底，避免 0.1ms 抖动直接判失败。
  const tiny = deriveBudget({ p95Ms: 0.1, retainedBytes: 0 });
  assert.ok(tiny.p95Ms >= 2);
  assert.ok(tiny.retainedBytes >= 8 * MIB);
  const missing = deriveBudget({});
  assert.equal(missing.p95Ms, null);
  assert.equal(missing.retainedBytes, null);
});

test('evaluateBudgets：预算内通过；延迟/内存/缺基线分别失败', () => {
  const baseline = {
    tolerance: { latency: 3, memory: 4, minLatencyBudgetMs: 2, minMemoryBudgetBytes: 8 * MIB },
    benchmarks: {
      'observe.vom-rank': { p95Ms: 6, retainedBytes: 1 * MIB },
      'har.normalize': { p95Ms: 10, retainedBytes: 1 * MIB },
    },
  };
  const pass = evaluateBudgets([
    { id: 'observe.vom-rank', label: 'o', group: 'observe', p50Ms: 4, p95Ms: 10, maxMs: 11, retainedBytes: 2 * MIB },
    { id: 'har.normalize', label: 'h', group: 'har', p50Ms: 2, p95Ms: 12, maxMs: 13, retainedBytes: 3 * MIB },
  ], baseline);
  assert.equal(pass.ok, true, JSON.stringify(pass.breaches));
  assert.equal(pass.rows.length, 2);
  for (const row of pass.rows) {
    assert.equal(row.status, 'ok');
    assert.equal(row.latencyOk, true);
    assert.equal(row.memoryOk, true);
  }

  const slow = evaluateBudgets([
    { id: 'har.normalize', label: 'h', group: 'har', p50Ms: 30, p95Ms: 40, maxMs: 41, retainedBytes: 1 * MIB },
  ], baseline);
  assert.equal(slow.ok, false);
  assert.equal(slow.breaches.length, 1);
  assert.equal(slow.breaches[0].kind, 'latency');
  assert.match(slow.breaches[0].detail, /超预算/);
  assert.equal(slow.rows[0].status, 'over-budget');

  const fat = evaluateBudgets([
    { id: 'har.normalize', label: 'h', group: 'har', p50Ms: 2, p95Ms: 3, maxMs: 4, retainedBytes: 40 * MIB },
  ], baseline);
  assert.equal(fat.ok, false);
  assert.equal(fat.breaches[0].kind, 'memory');
  assert.match(fat.breaches[0].detail, /保留内存/);

  const unknown = evaluateBudgets([
    { id: 'longshot.plan', label: 'l', group: 'longshot', p50Ms: 1, p95Ms: 2, maxMs: 3, retainedBytes: 0 },
  ], baseline);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.breaches[0].kind, 'baseline-missing');
  assert.equal(unknown.rows[0].status, 'no-baseline');
});

test('evaluateBudgets：null 内存测量不参与判定（受限环境只测延迟）', () => {
  const baseline = { benchmarks: { 'har.normalize': { p95Ms: 10, retainedBytes: 1 * MIB } } };
  const result = evaluateBudgets([
    { id: 'har.normalize', label: 'h', group: 'har', p50Ms: 2, p95Ms: 3, maxMs: 4, retainedBytes: null },
  ], baseline);
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].memoryOk, null);
});

test('parseArgs：默认 check；--only/--iterations/--baseline/--tolerance/--no-memory', () => {
  assert.deepEqual(parseArgs([]), {
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
  });
  const parsed = parseArgs(['--json', '--only', 'har.normalize,longshot.plan', '--iterations', '7', '--baseline', '.tmp/p.json', '--tolerance', '2.5', '--memory-tolerance', '3', '--no-memory']);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.only, ['har.normalize', 'longshot.plan']);
  assert.equal(parsed.iterations, 7);
  assert.equal(parsed.baseline, '.tmp/p.json');
  assert.equal(parsed.latencyTolerance, 2.5);
  assert.equal(parsed.memoryTolerance, 3);
  assert.equal(parsed.noMemory, true);
  assert.equal(parseArgs(['--update']).update, true);
  assert.equal(parseArgs(['--check']).check, true);
  assert.equal(parseArgs(['--list']).list, true);
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['--only']), UsageError);
  assert.throws(() => parseArgs(['--only', 'no-such-bench']), /未知 benchmark/);
  assert.throws(() => parseArgs(['--iterations', '0']), /--iterations/);
  assert.throws(() => parseArgs(['--iterations', '999']), /--iterations/);
  assert.throws(() => parseArgs(['--tolerance', '0.5']), /--tolerance/);
  assert.throws(() => parseArgs(['--baseline']), /需要一个值/);
});

test('buildBaseline/loadBaseline/writeBaseline：往返一致，坏基线不放行', () => {
  const dir = tempDir();
  const file = path.join(dir, 'perf.json');
  try {
    assert.equal(loadBaseline(file), null, '不存在的基线返回 null（由内置基线兜底）');
    const measurements = [
      { id: 'har.normalize', medianMs: 2.5, p95Ms: 3.5, retainedBytes: 100 },
      { id: 'longshot.plan', medianMs: 1, p95Ms: 1.5, retainedBytes: null },
    ];
    const baseline = buildBaseline(measurements, { recordedAt: '2026-11-25T00:00:00.000Z' });
    assert.equal(baseline.version, 1);
    assert.equal(baseline.benchmarks['har.normalize'].p95Ms, 3.5);
    assert.equal(baseline.benchmarks['longshot.plan'].retainedBytes, null);
    writeBaseline(file, baseline);
    const loaded = loadBaseline(file);
    assert.deepEqual(loaded.benchmarks, baseline.benchmarks);
    assert.equal(loaded.recordedAt, '2026-11-25T00:00:00.000Z');

    fs.writeFileSync(file, '{not json', 'utf8');
    assert.throws(() => loadBaseline(file), /不是合法 JSON/);
    fs.writeFileSync(file, JSON.stringify({ version: 2, benchmarks: {} }), 'utf8');
    assert.throws(() => loadBaseline(file), /格式非法/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatReport：可读表包含全部基准与 PASS/FAIL 结论', () => {
  const evaluated = evaluateBudgets([
    { id: 'har.normalize', label: 'h', group: 'har', p50Ms: 2, p95Ms: 3, maxMs: 4, retainedBytes: 1 * MIB },
  ], { benchmarks: { 'har.normalize': { p95Ms: 10, retainedBytes: 1 * MIB } } });
  const text = formatReport({
    ok: evaluated.ok,
    baselineSource: 'embedded',
    tolerance: { latency: 3, memory: 4, minLatencyBudgetMs: 2, minMemoryBudgetBytes: 8 * MIB },
    rows: evaluated.rows,
    breaches: evaluated.breaches,
    measureMemory: true,
  });
  assert.match(text, /性能预算门禁/);
  assert.match(text, /har\.normalize/);
  assert.match(text, /PERF BUDGET PASS/);
  const failed = formatReport({ ok: false, rows: [], breaches: [{ kind: 'latency', detail: 'x 超预算' }] });
  assert.match(failed, /PERF BUDGET FAILED/);
  assert.match(failed, /breach\[latency\]/);
});

test('真实 CLI：--update 写基线、预算内 exit 0、同基线缺条目 exit 1', { timeout: 180000 }, () => {
  const dir = tempDir();
  const baselineFile = path.join(dir, 'baseline.json');
  try {
    const updated = runTool(['--update', '--baseline', baselineFile, '--only', 'longshot.plan', '--iterations', '3']);
    assert.equal(updated.status, 0, updated.stderr || updated.stdout);
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    assert.ok(baseline.benchmarks['longshot.plan'], '基线应包含 longshot.plan');
    assert.equal(baseline.benchmarks['longshot.plan'].retainedBytes != null, true, '默认应测内存（--expose-gc 自举）');

    const checked = runTool(['--json', '--baseline', baselineFile, '--only', 'longshot.plan', '--iterations', '3']);
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    const result = JSON.parse(checked.stdout.slice(checked.stdout.indexOf('{')));
    assert.equal(result.ok, true, JSON.stringify(result.breaches));
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, 'longshot.plan');
    assert.ok(result.rows[0].p95Ms > 0);
    assert.ok(result.rows[0].budget.p95Ms >= 2);

    const missing = runTool(['--json', '--baseline', baselineFile, '--only', 'har.normalize', '--iterations', '3']);
    assert.equal(missing.status, 1, '基线缺少该 benchmark 时必须失败');
    const missingResult = JSON.parse(missing.stdout.slice(missing.stdout.indexOf('{')));
    assert.equal(missingResult.ok, false);
    assert.equal(missingResult.breaches[0].kind, 'baseline-missing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
