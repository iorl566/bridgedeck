// tests/unit/eval-report.test.mjs —— 报告器：三态计数、指标门禁、JSON/Markdown 结构、退出码。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LAYER_SPECS,
  REPORT_SCHEMA,
  ReportError,
  loadThresholds,
  main,
  renderMarkdown,
  runReport,
} from '../../tools/eval-report.mjs';

const ROOT = process.cwd();

function stubResult(item, status = item.expectedStatus, extra = {}) {
  return {
    id: item.id,
    title: item.title,
    layer: item.layer,
    source: item.source,
    capability: item.capability,
    oracleLevel: item.oracleLevel,
    expectedStatus: item.expectedStatus,
    status,
    checks: [{ id: item.id + ':stub', status: status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : 'unverified', ok: status === 'passed', evidence: { stub: true } }],
    unverified: status === 'unverified' ? [{ id: item.id + ':stub', reason: 'stub unverified' }] : [],
    evidence: { stub: true },
    evidenceRule: item.evidenceRule,
    negative: item.negative,
    error: null,
    adapterCalls: [],
    cliCalls: [],
    durationMs: 2,
    ...extra,
  };
}

function stubRunners(transform = (item) => item.expectedStatus) {
  const runner = async (cases) => cases.map((item) => stubResult(item, transform(item)));
  return { offline: runner, dom: runner };
}

async function baseReport(overrides = {}) {
  return runReport({
    root: ROOT,
    knownTools: null,
    write: false,
    runners: stubRunners(),
    now: new Date('2026-11-25T00:00:00.000Z'),
    ...overrides,
  });
}

test('runReport：默认三层 70 case，三态矩阵与实际一致，门禁 PASS exitCode=0', async () => {
  const report = await baseReport();
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.generatedAt, '2026-11-25T00:00:00.000Z');
  assert.equal(report.corpus.total, 70);
  assert.deepEqual(report.corpus.byLayer, { dom: 12, offline: 58 });
  assert.deepEqual(report.corpus.byExpectedStatus, { passed: 58, failed: 7, unverified: 5 });
  assert.equal(report.corpus.runs.length, 3);
  assert.deepEqual(report.corpus.runs.map((run) => run.layer), ['offline', 'offline', 'dom']);
  assert.deepEqual(report.metrics.actual, { passed: 58, failed: 7, unverified: 5 });
  assert.equal(report.metrics.precision, 1);
  assert.equal(report.metrics.recall, 1);
  assert.equal(report.metrics.skipRate, 0);
  assert.equal(report.gate.ok, true, JSON.stringify(report.gate.checks.filter((check) => !check.ok)));
  assert.equal(report.exitCode, 0);
  assert.equal(report.ok, true);
  assert.equal(report.cases.length, 70);
  for (const item of report.cases) {
    assert.ok(item.id && item.capability && item.oracleLevel && item.expectedStatus && item.status);
    assert.ok(item.evidenceRule && item.evidenceRule.length > 0);
    assert.ok(Array.isArray(item.checks));
  }
  // JSON 可序列化且关键字段不丢。
  const roundTrip = JSON.parse(JSON.stringify(report));
  assert.equal(roundTrip.metrics.counts.truePositives, 58);
  assert.equal(roundTrip.gate.checks.length, report.gate.checks.length);
});

test('renderMarkdown：包含三态矩阵/指标/门禁/分层/每 case 证据/复现命令', async () => {
  const report = await baseReport();
  const markdown = renderMarkdown(report);
  assert.ok(markdown.startsWith('# BridgeDeck eval 三态报告'));
  assert.ok(markdown.includes('| passed | 58 | 0 | 0 |'));
  assert.ok(markdown.includes('| failed | 0 | 7 | 0 |'));
  assert.ok(markdown.includes('| unverified | 0 | 0 | 5 |'));
  assert.ok(markdown.includes('## 1. 三态计数'));
  assert.ok(markdown.includes('## 2. 指标与门禁'));
  assert.ok(markdown.includes('## 3. 分层统计'));
  assert.ok(markdown.includes('## 5. 每 case 证据'));
  assert.ok(markdown.includes('## 6. 复现'));
  assert.ok(markdown.includes('| overlay.rtl |'));
  assert.ok(markdown.includes('fail-value-mismatch'));
  assert.ok(markdown.includes('tools/eval-report.mjs'));
  // 负向自检的失败证据必须出现在每 case 证据表里（可复现）。
  assert.ok(/FAIL fail-value-mismatch:stub=/.test(markdown));
});

test('runReport：构造一个未期望失败 → 门禁 FAIL，exitCode=1，fp/fn 分类落盘', async () => {
  const domOnly = DEFAULT_LAYER_SPECS.filter((spec) => spec.layer === 'dom');
  let flipped = false;
  const runner = async (cases) => cases.map((item) => {
    if (!flipped && item.expectedStatus === 'passed') {
      flipped = true;
      return stubResult(item, 'failed', {
        checks: [{ id: item.id + ':hit.x', status: 'fail', ok: false, evidence: { path: 'hit.x', expected: 'a', actual: 'b' } }],
      });
    }
    return stubResult(item);
  });
  const report = await runReport({
    root: ROOT,
    knownTools: null,
    write: false,
    layerSpecs: domOnly,
    runners: { offline: runner, dom: runner },
    thresholdsOverride: {
      minCases: 0,
      minPrecision: 0,
      minRecall: 0,
      maxSkipRate: 1,
      maxUnverifiedRate: 1,
      maxFalsePositives: 10,
      maxFalseNegatives: 0,
      maxMissedNegatives: 10,
      maxUnexpected: 0,
      requiredStatuses: ['passed'],
      requiredOracleLevels: ['dom-real'],
    },
    now: new Date('2026-11-25T00:00:00.000Z'),
  });
  assert.equal(report.gate.ok, false);
  assert.equal(report.exitCode, 1);
  assert.ok(report.gate.failures.includes('false-negatives'));
  assert.ok(report.gate.failures.includes('unexpected'));
  assert.equal(report.metrics.classification.falseNegatives.length, 1);
  const failed = report.metrics.classification.falseNegatives[0];
  assert.equal(failed.expectedStatus, 'passed');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.category, 'dom-fact-mismatch');
  assert.ok(failed.evidence);
  const markdown = renderMarkdown(report);
  assert.ok(markdown.includes('false negatives'));
  assert.ok(markdown.includes(failed.id));
  assert.ok(markdown.includes('dom-fact-mismatch'));
});

test('runReport：offline-only 模式只跑离线层并清空 DOM oracle 要求（显式降级）', async () => {
  const report = await runReport({
    root: ROOT,
    knownTools: null,
    write: false,
    offlineOnly: true,
    runners: stubRunners(),
    now: new Date('2026-11-25T00:00:00.000Z'),
  });
  assert.equal(report.corpus.total, 58);
  assert.deepEqual(report.corpus.byLayer, { offline: 58 });
  assert.deepEqual(report.thresholds.values.requiredOracleLevels, []);
  assert.equal(report.thresholds.offlineOnly, true);
  assert.equal(report.gate.ok, true);
  assert.ok(!Object.keys(report.corpus.byOracleLevel).includes('dom-real'));
});

test('runReport：markdown 单元格转义管道符，避免破坏表格', async () => {
  const domOnly = DEFAULT_LAYER_SPECS.filter((spec) => spec.layer === 'dom');
  const runner = async (cases) => cases.map((item) => stubResult(item, item.expectedStatus, { evidence: { 'a|b': 1 } }));
  const report = await runReport({
    root: ROOT,
    knownTools: null,
    write: false,
    layerSpecs: domOnly,
    runners: { offline: runner, dom: runner },
    now: new Date('2026-11-25T00:00:00.000Z'),
  });
  const markdown = renderMarkdown(report);
  assert.ok(markdown.includes('a\\|b'));
  assert.ok(!/ \| a\|b \|/.test(markdown));
});

test('runReport/loadThresholds：非法配置与空层都抛 ReportError（退出码 2 语义）', async () => {
  await assert.rejects(
    () => runReport({ root: ROOT, knownTools: null, write: false, layerNames: ['nope'], runners: stubRunners() }),
    (error) => error instanceof ReportError && error.code === 'E_EVAL_NO_LAYERS' && error.exitCode === 2,
  );
  await assert.rejects(
    () => runReport({ root: ROOT, knownTools: null, write: false, runners: stubRunners(), thresholdsOverride: { minPrecision: 2 } }),
    (error) => error instanceof ReportError && error.code === 'E_EVAL_THRESHOLDS',
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-report-'));
  const badJson = path.join(dir, 'bad.json');
  const badKey = path.join(dir, 'bad-key.json');
  const valid = path.join(dir, 'valid.json');
  fs.writeFileSync(badJson, '{oops', 'utf8');
  fs.writeFileSync(badKey, '{"minPrecisoin":0.9}', 'utf8');
  fs.writeFileSync(valid, '{"minCases":57,"requiredStatuses":["passed"]}', 'utf8');
  assert.throws(() => loadThresholds(dir, badJson), (error) => error.code === 'E_EVAL_THRESHOLDS');
  assert.throws(() => loadThresholds(dir, badKey), (error) => error.code === 'E_EVAL_THRESHOLDS');
  const loaded = loadThresholds(dir, valid);
  assert.equal(loaded.thresholds.minCases, 57);
  assert.deepEqual(loaded.thresholds.requiredStatuses, ['passed']);
  assert.equal(loadThresholds(dir, path.join(dir, 'missing.json')).file, null);
});

test('renderMarkdown/main：坏报告结构拒绝渲染；--help 不执行语料直接返回', async () => {
  assert.throws(() => renderMarkdown({ schema: 'other' }), (error) => error.code === 'E_EVAL_REPORT_SHAPE');
  assert.throws(() => renderMarkdown(null), (error) => error.code === 'E_EVAL_REPORT_SHAPE');
  const help = await main(['--help']);
  assert.deepEqual(help, { exitCode: 0, help: true });
  await assert.rejects(() => main(['--unknown-flag']), (error) => error instanceof ReportError && error.code === 'E_EVAL_USAGE');
});
