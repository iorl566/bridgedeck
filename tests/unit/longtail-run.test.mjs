// tests/unit/longtail-run.test.mjs —— 门禁 CLI：参数解析、场景选择、真实子进程消费、基线模式。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BASELINE,
  USAGE,
  parseArgs,
  runGate,
  selectScenarios,
} from '../../tools/longtail/run.mjs';
import { DEFAULT_SEED } from '../../tools/longtail/lib/prng.mjs';
import { FAILURE_CODES } from '../../tools/longtail/lib/budget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RUN_PATH = path.join(ROOT, 'tools', 'longtail', 'run.mjs');
const ALL_IDS = ['page-vom', 'har-merge', 'record-program', 'video-manifest'];

function runCli(args, { timeout = 180_000 } = {}) {
  return spawnSync(process.execPath, [RUN_PATH, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    env: { ...process.env },
  });
}

test('parseArgs：默认值', () => {
  const options = parseArgs([]);
  assert.equal(options.check, false);
  assert.equal(options.scale, 'default');
  assert.equal(options.seed, DEFAULT_SEED);
  assert.equal(options.json, false);
  assert.equal(options.baseline, DEFAULT_BASELINE);
  assert.equal(options.useBaseline, true);
  assert.equal(options.updateBaseline, false);
  assert.equal(options.keepTmp, false);
  assert.equal(options.verbose, false);
  assert.equal(options.timeScale, 1);
  assert.equal(options.memoryMb, 0);
  assert.equal(options.scenarios, null);
  assert.match(USAGE, /--check/);
});

test('parseArgs：完整参数组合', () => {
  const options = parseArgs([
    '--check', '--json', '--scale=smoke', '--seed=42', '--scenario=page-vom,har-merge',
    '--keep-tmp', '--time-scale=2.5', '--memory-mb=1024', '--no-baseline', '--verbose',
  ]);
  assert.equal(options.check, true);
  assert.equal(options.json, true);
  assert.equal(options.scale, 'smoke');
  assert.equal(options.seed, 42);
  assert.deepEqual(options.scenarios, ['page-vom', 'har-merge']);
  assert.equal(options.keepTmp, true);
  assert.equal(options.timeScale, 2.5);
  assert.equal(options.memoryMb, 1024);
  assert.equal(options.useBaseline, false);
  assert.equal(options.verbose, true);
  const stringSeed = parseArgs(['--seed=longtail']);
  assert.equal(stringSeed.seed, 'longtail');
});

test('parseArgs：非法参数报错（E_USAGE）', () => {
  const cases = [
    ['--scale=nope'],
    ['--time-scale=0'],
    ['--time-scale=-1'],
    ['--memory-mb=-5'],
    ['--unknown-flag'],
    ['positional'],
  ];
  for (const argv of cases) {
    assert.throws(() => parseArgs(argv), (error) => error && error.code === 'E_USAGE', JSON.stringify(argv));
  }
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('selectScenarios：默认全部、过滤、去重、未知报错', () => {
  assert.deepEqual(selectScenarios().map((module) => module.SCENARIO.id), ALL_IDS);
  assert.deepEqual(selectScenarios(null).map((module) => module.SCENARIO.id), ALL_IDS);
  const filtered = selectScenarios(['video-manifest', 'page-vom', 'video-manifest']);
  assert.deepEqual(filtered.map((module) => module.SCENARIO.id), ['page-vom', 'video-manifest']);
  assert.throws(() => selectScenarios(['nope']), (error) => error.code === 'E_USAGE' && /未知场景/.test(error.message));
});

test('runGate：smoke 规模 report 模式退出 0，报告结构完整', async () => {
  const outcome = await runGate({ scale: 'smoke', seed: 12345, useBaseline: false, check: false });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.report.mode, 'report');
  assert.equal(outcome.report.scale, 'smoke');
  assert.equal(outcome.report.seed, '12345');
  assert.equal(outcome.report.scenarios.length, 4);
  assert.equal(outcome.report.summary.pass, 4);
  assert.equal(outcome.report.summary.fail, 0);
  assert.equal(outcome.report.summary.ok, true);
  assert.equal(outcome.report.baseline.present, false);
  assert.deepEqual(outcome.report.errors, []);
  for (const scenario of outcome.report.scenarios) {
    assert.equal(scenario.level, 'pass');
    assert.equal(scenario.verdict.ok, true);
    assert.ok(scenario.metrics.timeMs > 0);
    assert.match(scenario.fingerprint, /^[0-9a-f]{16}$/);
    assert.match(scenario.budgetFingerprint, /^[0-9a-f]{16}$/);
    assert.ok(scenario.budget.checks.length > 0);
    assert.ok(scenario.fixture, scenario.id + ' 应带 fixture 证据');
  }
  assert.match(outcome.lines, /SUMMARY: pass=4 warn=0 fail=0 ok=true/);
});

test('runGate：smoke 规模 check 模式退出 0', async () => {
  const outcome = await runGate({ scale: 'smoke', seed: 12345, useBaseline: false, check: true });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.report.mode, 'check');
  assert.equal(outcome.report.summary.fail, 0);
});

test('runGate：--scenario 过滤只跑指定场景', async () => {
  const outcome = await runGate({ scale: 'smoke', seed: 12345, useBaseline: false, check: true, scenarios: ['record-program'] });
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.report.scenarios.map((entry) => entry.id), ['record-program']);
});

test('runGate：未知场景直接抛 E_USAGE', async () => {
  await assert.rejects(
    () => runGate({ scale: 'smoke', scenarios: ['nope'], useBaseline: false }),
    (error) => error.code === 'E_USAGE',
  );
});

test('runGate：与仓库 baseline.json 对比（default scale）通过且无指纹漂移', async () => {
  const outcome = await runGate({ check: true });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.report.baseline.present, true);
  assert.equal(outcome.report.baseline.path, DEFAULT_BASELINE);
  assert.equal(outcome.report.baseline.drift.present, true);
  assert.equal(outcome.report.baseline.drift.drifts.filter((item) => item.severity === 'error').length, 0);
  assert.deepEqual(outcome.report.errors, []);
});

test('runGate：seed 漂移 → 基线指纹失败（check 模式 exit 1）', async () => {
  const outcome = await runGate({ check: true, seed: 777 });
  assert.equal(outcome.exitCode, 1);
  const failures = outcome.report.scenarios.flatMap((entry) => entry.verdict.failures.map((failure) => failure.code));
  assert.ok(failures.includes(FAILURE_CODES.FINGERPRINT), '应包含指纹漂移失败：' + failures.join(','));
  assert.ok(outcome.report.errors.length >= 1);
});

test('CLI：node tools/longtail/run.mjs --check 真实消费（exit 0）', () => {
  const result = runCli(['--check']);
  assert.equal(result.status, 0, 'stderr=' + result.stderr);
  assert.match(result.stdout, /BridgeDeck 长尾\/规模预算门禁/);
  assert.match(result.stdout, /SUMMARY: pass=4 warn=0 fail=0 ok=true/);
  assert.equal(result.stderr, '');
});

test('CLI：--check --json --no-baseline --scale=smoke 输出可解析 JSON', () => {
  const result = runCli(['--check', '--json', '--no-baseline', '--scale=smoke']);
  assert.equal(result.status, 0, 'stderr=' + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'check');
  assert.equal(report.scale, 'smoke');
  assert.equal(report.scenarios.length, 4);
  assert.equal(report.summary.fail, 0);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.level, 'pass');
    assert.ok(scenario.metrics);
    assert.match(scenario.fingerprint, /^[0-9a-f]{16}$/);
  }
});

test('CLI：--list / --help / 非法规模', () => {
  const list = runCli(['--list']);
  assert.equal(list.status, 0);
  for (const id of ALL_IDS) assert.ok(list.stdout.includes(id), id);
  assert.match(list.stdout, /scale=default/);

  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法/);
  assert.match(help.stdout, /--update-baseline/);

  const bad = runCli(['--scale=nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /未知规模/);

  // smoke 阈值不能写进基线（否则会破坏 default 门禁）。
  const smokeBaseline = runCli(['--update-baseline', '--no-baseline', '--scale=smoke']);
  assert.equal(smokeBaseline.status, 2);
  assert.match(smokeBaseline.stderr, /只允许 default 规模更新基线/);
});

test('CLI：--scenario 过滤 + --out 写报告文件', () => {
  const outPath = path.join(os.tmpdir(), 'longtail-report-' + process.pid + '.json');
  try {
    const result = runCli(['--check', '--json', '--no-baseline', '--scale=smoke', '--scenario=video-manifest', '--out=' + outPath]);
    assert.equal(result.status, 0, 'stderr=' + result.stderr);
    assert.ok(fs.existsSync(outPath));
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(report.scenarios.length, 1);
    assert.equal(report.scenarios[0].id, 'video-manifest');
    assert.equal(report.summary.fail, 0);
  } finally {
    fs.rmSync(outPath, { force: true });
  }
});
