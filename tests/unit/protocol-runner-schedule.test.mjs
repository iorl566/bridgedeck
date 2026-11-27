// tests/unit/protocol-runner-schedule.test.mjs —— 兼容矩阵 runner 的横向视图测试。
//
// 覆盖：
//   1) riskGrid / riskMethodsAt：版本 → 可调用方法的风险分布，与矩阵报告逐项一致；
//   2) capabilitySchedule：相邻版本的能力获得时间表；
//   3) matrixSummaryLines / riskSummaryLines：文本模式摘要；
//   4) validateRiskProfile：风险画像自证（含注入错误的负例）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { METHOD_NAMES, proofOf } from '../../lib/method-catalog.mjs';
import {
  capabilitySchedule,
  defaultRunnerReport,
  matrixSummaryLines,
  riskGrid,
  riskMethodsAt,
  riskSummaryLines,
  runCompatibilityMatrix,
  validateRiskProfile,
  versionDelta,
} from '../../lib/protocol-compat-runner.mjs';

const REPORT = defaultRunnerReport();

// ---------------------------------------------------------------------------
// 1. 风险网格
// ---------------------------------------------------------------------------

test('riskGrid：每个版本的风险分桶与报告 obligations 逐项一致', () => {
  const grid = riskGrid({});
  assert.deepEqual([...grid.versions], [...REPORT.versions]);
  assert.equal(grid.rows.length, REPORT.versions.length);
  for (const row of grid.rows) {
    const profile = REPORT.obligations[row.version];
    assert.equal(row.allowed, profile.allowed, row.version);
    assert.equal(row.safe, profile.safe, row.version);
    assert.equal(row.guarded, profile.guarded, row.version);
    assert.equal(row.risky, profile.risky, row.version);
    assert.equal(row.requiresResolve, profile.requiresResolve, row.version);
    assert.equal(row.gated, profile.gated, row.version);
    assert.equal(row.safe + row.guarded + row.risky, row.allowed, row.version);
    assert.equal(row.band, REPORT.featureRows[0].cells[row.version].band);
  }
});

test('riskGrid：1.8 与 1.9 的放行/风险数字', () => {
  const grid = riskGrid({});
  const at198 = grid.rows.find((row) => row.version === '1.8');
  const at199 = grid.rows.find((row) => row.version === '1.9');
  assert.equal(at198.allowed, 136);
  assert.equal(at198.requiresResolve, 61);
  assert.equal(at198.gated, 0);
  assert.equal(at199.allowed, 165);
  assert.equal(at199.risky, 51);
  assert.equal(at199.guarded, 24);
  assert.equal(at199.safe, 90);
  assert.equal(at199.requiresResolve, 75);
  assert.equal(at199.gated, 29);
});

test('riskGrid：自定义方法与版本子集', () => {
  const grid = riskGrid({ versions: ['1.8', '1.9'], methods: ['click', 'video.start', 'read'] });
  assert.equal(grid.rows.length, 2);
  const at198 = grid.rows[0];
  assert.equal(at198.allowed, 1, '1.8 只有 click 放行');
  assert.equal(at198.risky, 1, 'click 是 risky');
  const at199 = grid.rows[1];
  assert.equal(at199.allowed, 3);
  assert.equal(at199.safe, 1, 'read 是 safe');
  // totals = 各行求和
  for (const key of Object.keys(grid.totals)) {
    assert.equal(grid.totals[key], grid.rows.reduce((sum, row) => sum + row[key], 0), key);
  }
});

test('riskMethodsAt：按风险分组且只包含该版本可调用方法', () => {
  const at198 = riskMethodsAt('1.8');
  assert.equal(at198.counts.safe + at198.counts.guarded + at198.counts.risky, 136);
  for (const method of at198.risky) assert.equal(proofOf(method).idempotent, false);
  for (const method of at198.guarded) {
    assert.equal(proofOf(method).replayable, false);
    assert.equal(proofOf(method).idempotent, true);
  }
  for (const method of at198.safe) assert.equal(proofOf(method).replayable, true);
  // 1.8 不允许 video.start；1.9 允许且它是 risky
  assert.equal(at198.risky.includes('video.start'), false);
  const at199 = riskMethodsAt('1.9');
  assert.equal(at199.risky.includes('video.start'), true);
  assert.equal(at199.counts.risky, 51);
  for (const method of [...at199.safe, ...at199.guarded, ...at199.risky]) {
    assert.ok(METHOD_NAMES.includes(method));
  }
});

// ---------------------------------------------------------------------------
// 2. 能力时间表
// ---------------------------------------------------------------------------

test('capabilitySchedule：默认版本产生 4 段，累计获得 15 特性 / 29 方法', () => {
  const schedule = capabilitySchedule({});
  assert.equal(schedule.steps.length, 4);
  assert.deepEqual(schedule.steps.map((step) => step.from + '>' + step.to), [
    '1.7>1.8', '1.8>1.9', '1.9>1.10', '1.10>2.0',
  ]);
  const upgrade = schedule.steps.find((step) => step.from === '1.8' && step.to === '1.9');
  assert.equal(upgrade.gainedFeatures.length, 15);
  assert.equal(upgrade.gainedMethods.length, 29);
  assert.equal(upgrade.lostFeatures.length, 0);
  assert.match(schedule.summary, /累计获得 15 特性 \/ 29 方法/);
});

test('capabilitySchedule：每段 delta 与 versionDelta 一致', () => {
  const schedule = capabilitySchedule({});
  for (const step of schedule.steps) {
    const delta = versionDelta(step.from, step.to);
    assert.equal(step.gainedFeatures.length, delta.counts.gainedFeatures, step.from + '>' + step.to);
    assert.equal(step.gainedMethods.length, delta.counts.gainedMethods, step.from + '>' + step.to);
    assert.equal(step.lostFeatures.length, delta.counts.lostFeatures);
    assert.equal(step.lostMethods.length, delta.counts.lostMethods);
  }
});

test('capabilitySchedule：不可解析版本被跳过，少于两个版本没有时间表', () => {
  const withInvalid = capabilitySchedule({ versions: ['x', '1.8', '1.9'] });
  assert.equal(withInvalid.steps.length, 1);
  assert.equal(withInvalid.steps[0].from, '1.8');
  const single = capabilitySchedule({ versions: ['1.9'] });
  assert.equal(single.steps.length, 0);
  assert.match(single.summary, /没有时间表/);
});

// ---------------------------------------------------------------------------
// 3. 文本摘要
// ---------------------------------------------------------------------------

test('matrixSummaryLines：标题 + 表头 + 每版本一行 + 单调性 + 指纹', () => {
  const lines = matrixSummaryLines(REPORT);
  assert.equal(lines[0], REPORT.summary);
  assert.match(lines[1], /version/);
  assert.equal(lines.length, 2 + REPORT.versions.length + 2);
  for (const version of REPORT.versions) {
    assert.ok(lines.some((line) => line.startsWith(version)), version + ' 缺少行');
  }
  assert.ok(lines.some((line) => line.startsWith('monotonicity: OK')));
  assert.ok(lines.some((line) => line.startsWith('fingerprint: ' + REPORT.fingerprint)));
});

test('riskSummaryLines：表头 + 每版本一行 + 汇总行', () => {
  const lines = riskSummaryLines({});
  assert.match(lines[0], /version/);
  assert.equal(lines.length, 1 + REPORT.versions.length + 1);
  assert.match(lines[lines.length - 1], /^totals: /);
  for (const row of riskGrid({}).rows) {
    assert.ok(lines.some((line) => line.startsWith(row.version)));
  }
});

// ---------------------------------------------------------------------------
// 4. 风险画像自证
// ---------------------------------------------------------------------------

test('validateRiskProfile：默认矩阵零问题；与 validateMatrixReport 一致', () => {
  assert.deepEqual(validateRiskProfile(REPORT), []);
  assert.deepEqual(validateRiskProfile(runCompatibilityMatrix({ versions: ['1.8', '1.9'], methods: ['click', 'video.start'] })), []);
  assert.deepEqual(validateRiskProfile({ versions: [], methodRows: [], obligations: {} }), []);
});

test('validateRiskProfile 负例：篡改分桶/requiresResolve/缺失画像', () => {
  const tamperedSum = JSON.parse(JSON.stringify(REPORT));
  tamperedSum.obligations['1.9'].risky = 0;
  const sumIssues = validateRiskProfile(tamperedSum);
  assert.ok(sumIssues.some((issue) => issue.scope === 'risk.sum'));
  assert.ok(sumIssues.some((issue) => issue.scope === 'risk.risky'));

  const tamperedResolve = JSON.parse(JSON.stringify(REPORT));
  tamperedResolve.obligations['1.8'].requiresResolve = 0;
  assert.ok(validateRiskProfile(tamperedResolve).some((issue) => issue.scope === 'risk.resolve'));

  const missing = JSON.parse(JSON.stringify(REPORT));
  delete missing.obligations['1.8'];
  assert.ok(validateRiskProfile(missing).some((issue) => issue.scope === 'risk.missing'));

  const tamperedSafe = JSON.parse(JSON.stringify(REPORT));
  tamperedSafe.obligations['1.9'].safe = 0;
  assert.ok(validateRiskProfile(tamperedSafe).some((issue) => issue.scope === 'risk.safe'));
});
