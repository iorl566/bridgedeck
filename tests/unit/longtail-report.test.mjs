// tests/unit/longtail-report.test.mjs —— 预算报告、基线读写/漂移、人类可读输出、退出码。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_VERSION,
  REFERENCE_METRICS,
  REPORT_VERSION,
  assembleReport,
  baselineArtifact,
  diffBaseline,
  humanReport,
  readBaseline,
  reportExitCode,
  reportToJson,
  scenarioVerdict,
  summarizeMetricsLine,
  summarizeVerdictLine,
  writeBaseline,
} from '../../tools/longtail/lib/report.mjs';
import { FAILURE_CODES, normalizeBudget } from '../../tools/longtail/lib/budget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LONGTAIL_DIR = path.resolve(HERE, '..', '..', 'tools', 'longtail');

function fakeResult(overrides = {}) {
  return {
    id: 'fake',
    ok: true,
    metrics: { timeMs: 10, peakHeapUsedMb: 5, x: 2, refs: 50 },
    evidence: { realModuleCalls: ['lib/a.mjs#f'], fixture: { fingerprint: 'aabbccddeeff0011' } },
    ...overrides,
  };
}

function fakeBudget(overrides = {}) {
  return normalizeBudget({
    label: 'fake',
    timeMs: 1_000,
    memoryMb: 100,
    checks: [{ name: 'x-min', metric: 'x', kind: 'min', limit: 1 }],
    ...overrides,
  });
}

test('版本与参考指标清单', () => {
  assert.equal(REPORT_VERSION, 1);
  assert.equal(BASELINE_VERSION, 1);
  assert.ok(REFERENCE_METRICS.includes('timeMs'));
  assert.ok(REFERENCE_METRICS.includes('refs'));
  assert.ok(Object.isFrozen(REFERENCE_METRICS));
});

test('scenarioVerdict：通过场景 + 指纹透传', () => {
  const { verdict, fingerprint, budget } = scenarioVerdict({ result: fakeResult(), budget: fakeBudget() });
  assert.equal(verdict.level, 'pass');
  assert.equal(verdict.ok, true);
  assert.equal(fingerprint, 'aabbccddeeff0011');
  assert.ok(budget);
});

test('scenarioVerdict：场景错误 → fail（ERROR）', () => {
  const { verdict } = scenarioVerdict({
    result: { id: 'broken', ok: false, error: { name: 'Error', message: 'boom' }, metrics: {}, evidence: { realModuleCalls: [] } },
    budget: fakeBudget(),
  });
  assert.equal(verdict.level, 'fail');
  assert.equal(verdict.failures[0].code, FAILURE_CODES.ERROR);
});

test('scenarioVerdict：基线指纹漂移叠加 FINGERPRINT 失败', () => {
  const baselineEntry = { fingerprint: '0011223344556677' };
  const withCheck = scenarioVerdict({ result: fakeResult(), budget: fakeBudget(), baselineEntry, checkFingerprint: true });
  assert.equal(withCheck.verdict.level, 'fail');
  assert.ok(withCheck.verdict.failures.some((failure) => failure.code === FAILURE_CODES.FINGERPRINT));
  const withoutCheck = scenarioVerdict({ result: fakeResult(), budget: fakeBudget(), baselineEntry, checkFingerprint: false });
  assert.equal(withoutCheck.verdict.level, 'pass');
  const same = scenarioVerdict({ result: fakeResult(), budget: fakeBudget(), baselineEntry: { fingerprint: 'aabbccddeeff0011' }, checkFingerprint: true });
  assert.equal(same.verdict.level, 'pass');
});

function sampleEntries(pass = true) {
  const result = fakeResult({ metrics: { timeMs: 100, peakHeapUsedMb: 10, refs: 100, x: 2 }, evidence: { realModuleCalls: ['m#f'], fixture: { fingerprint: 'ffff0000ffff0000' } } });
  return [{
    id: 'fake',
    title: '假场景',
    scale: 'smoke',
    seed: '1',
    result,
    metrics: result.metrics,
    fixture: result.evidence.fixture,
    budget: fakeBudget({ timeMs: pass ? 1_000 : 50 }),
    verdict: scenarioVerdict({ result, budget: fakeBudget({ timeMs: pass ? 1_000 : 50 }) }).verdict,
    fingerprint: 'ffff0000ffff0000',
  }];
}

test('assembleReport：结构/汇总/错误计数', () => {
  const report = assembleReport({
    entries: sampleEntries(true),
    scale: 'smoke',
    seed: '1',
    mode: 'report',
    baselinePath: null,
    baseline: { present: false },
    durationMs: 12.34,
    errors: [],
  });
  assert.equal(report.version, REPORT_VERSION);
  assert.equal(report.generator, 'tools/longtail/run.mjs');
  assert.equal(report.mode, 'report');
  assert.equal(report.scale, 'smoke');
  assert.equal(report.seed, '1');
  assert.equal(report.scenarios.length, 1);
  assert.equal(report.scenarios[0].id, 'fake');
  assert.equal(report.scenarios[0].level, 'pass');
  assert.equal(report.summary.pass, 1);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.ok, true);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.baseline.present, false);
  assert.match(report.scenarios[0].budgetFingerprint, /^[0-9a-f]{16}$/);
  assert.equal(report.scenarios[0].budget.checks.length, 1);
});

test('assembleReport：失败场景与错误列表', () => {
  const report = assembleReport({
    entries: sampleEntries(false),
    scale: 'default',
    seed: '2',
    mode: 'check',
    errors: [{ id: 'page-vom', message: '爆炸' }],
  });
  assert.equal(report.mode, 'check');
  assert.equal(report.summary.pass, 0);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.summary.ok, false);
  assert.equal(report.summary.errors, 1);
  assert.equal(report.errors.length, 1);
});

test('reportExitCode：report 模式失败不退出，check 模式失败退出', () => {
  const failing = assembleReport({ entries: sampleEntries(false), scale: 'smoke', seed: '1', mode: 'check' });
  assert.equal(reportExitCode(failing, { check: true }), 1);
  assert.equal(reportExitCode(failing, { check: false }), 0);
  const passing = assembleReport({ entries: sampleEntries(true), scale: 'smoke', seed: '1', mode: 'check' });
  assert.equal(reportExitCode(passing, { check: true }), 0);
  const withErrors = assembleReport({ entries: sampleEntries(true), scale: 'smoke', seed: '1', mode: 'report', errors: [{ id: 'x' }] });
  assert.equal(reportExitCode(withErrors, { check: false }), 1);
});

test('summarizeVerdictLine / summarizeMetricsLine 可读性', () => {
  const entries = sampleEntries(false);
  const line = summarizeVerdictLine(entries[0]);
  assert.match(line, /^\[FAIL\]\s+fake/);
  assert.match(line, /checks=1\/1/);
  assert.match(line, /failures=1/);
  const metricsLine = summarizeMetricsLine(entries[0]);
  assert.match(metricsLine, /refs=100/);
  assert.match(summarizeMetricsLine({ metrics: {} }), /^$/);
});

test('humanReport：场景行/失败原因/SUMMARY', () => {
  const report = assembleReport({ entries: sampleEntries(false), scale: 'smoke', seed: '1', mode: 'check', durationMs: 20 });
  const text = humanReport(report);
  assert.match(text, /BridgeDeck 长尾\/规模预算门禁/v);
  assert.match(text, /mode=check scale=smoke/);
  assert.match(text, /\[FAIL\]/);
  assert.match(text, /FAIL time-budget-exceeded|FAIL metric-/);
  assert.match(text, /SUMMARY: pass=0 warn=0 fail=1 ok=false/);
  assert.match(text, /baseline: absent/);
  const verbose = humanReport(report, { verbose: true });
  assert.match(verbose, /x-min/);
});

test('baselineArtifact：阈值/检查/参考指标/指纹', () => {
  const report = assembleReport({ entries: sampleEntries(true), scale: 'smoke', seed: '7', mode: 'report', durationMs: 5 });
  const artifact = baselineArtifact(report);
  assert.equal(artifact.version, BASELINE_VERSION);
  assert.equal(artifact.createdWith.scale, 'smoke');
  assert.equal(artifact.createdWith.seed, '7');
  assert.equal(artifact.scenarios.fake.fingerprint, 'ffff0000ffff0000');
  assert.equal(artifact.scenarios.fake.budget.checks.length, 1);
  assert.equal(artifact.scenarios.fake.budget.timeMs, 1_000);
  assert.equal(artifact.scenarios.fake.reference.timeMs, 100);
  assert.equal(artifact.scenarios.fake.reference.refs, 100);
  assert.equal(artifact.scenarios.fake.budgetFingerprint.length, 16);
});

test('readBaseline/writeBaseline：缺失/损坏/写入路径护栏/往返', () => {
  const missing = readBaseline(path.join(os.tmpdir(), 'lt-definitely-missing-baseline.json'));
  assert.equal(missing.present, false);
  assert.equal(missing.error, 'missing');
  assert.equal(readBaseline(null).present, false);

  const badFile = path.join(os.tmpdir(), 'lt-bad-baseline-' + process.pid + '.json');
  fs.writeFileSync(badFile, '{ not json', 'utf8');
  try {
    const bad = readBaseline(badFile);
    assert.equal(bad.present, false);
    assert.equal(bad.error, 'unreadable');
  } finally {
    fs.rmSync(badFile, { force: true });
  }

  const artifact = baselineArtifact(assembleReport({ entries: sampleEntries(true), scale: 'smoke', seed: '1' }));
  assert.throws(() => writeBaseline(path.join(os.tmpdir(), 'lt-outside-baseline.json'), artifact), /只能写在 tools\/longtail/);
  const inside = path.join(LONGTAIL_DIR, '.tmp-unit-baseline.json');
  try {
    const written = writeBaseline(inside, artifact);
    assert.ok(written.bytes > 0);
    const read = readBaseline(inside);
    assert.equal(read.present, true);
    assert.deepEqual(read.artifact, artifact);
    fs.rmSync(inside, { force: true });
  } finally {
    fs.rmSync(inside, { force: true });
  }
});

test('diffBaseline：缺基线/一致/指纹漂移/时间与计数漂移', () => {
  const baselineReport = assembleReport({ entries: sampleEntries(true), scale: 'smoke', seed: '1' });
  const artifact = baselineArtifact(baselineReport);
  const absent = diffBaseline(baselineReport, { present: false });
  assert.equal(absent.present, false);
  assert.equal(absent.ok, true);

  const identical = diffBaseline(baselineReport, { present: true, artifact });
  assert.equal(identical.present, true);
  assert.equal(identical.ok, true);
  assert.equal(identical.drifts.length, 0);
  assert.deepEqual(identical.missing, []);
  assert.deepEqual(identical.extra, []);

  const drifted = JSON.parse(JSON.stringify(baselineReport));
  drifted.scenarios[0].fingerprint = '9999888877776666';
  const fingerprintDrift = diffBaseline(drifted, { present: true, artifact });
  assert.equal(fingerprintDrift.ok, false);
  assert.ok(fingerprintDrift.drifts.some((drift) => drift.kind === 'fingerprint' && drift.severity === 'error'));

  const faster = JSON.parse(JSON.stringify(baselineReport));
  faster.scenarios[0].metrics = { ...faster.scenarios[0].metrics, timeMs: 400 };
  const timingDrift = diffBaseline(faster, { present: true, artifact });
  assert.equal(timingDrift.drifts.some((drift) => drift.kind === 'timing' && drift.severity === 'warning'), true);

  const bigger = JSON.parse(JSON.stringify(baselineReport));
  bigger.scenarios[0].metrics = { ...bigger.scenarios[0].metrics, refs: 200 };
  const countDrift = diffBaseline(bigger, { present: true, artifact });
  assert.ok(countDrift.drifts.some((drift) => drift.kind === 'count' && drift.metric === 'refs'));

  const missingScenario = JSON.parse(JSON.stringify(baselineReport));
  missingScenario.scenarios = [];
  const missing = diffBaseline(missingScenario, { present: true, artifact });
  assert.deepEqual(missing.missing, ['fake']);
  assert.equal(missing.ok, false);

  const extraReport = JSON.parse(JSON.stringify(baselineReport));
  extraReport.scenarios.push({ ...extraReport.scenarios[0], id: 'extra' });
  const extra = diffBaseline(extraReport, { present: true, artifact });
  assert.deepEqual(extra.extra, ['extra']);
});

test('reportToJson：稳定文本化（同输入同输出）', () => {
  const report = assembleReport({ entries: sampleEntries(true), scale: 'smoke', seed: '1' });
  const left = reportToJson(report);
  const right = reportToJson(JSON.parse(JSON.stringify(report)));
  assert.equal(left, right);
  assert.deepEqual(JSON.parse(left), JSON.parse(right));
  assert.ok(left.includes('"scenarios"'));
});
