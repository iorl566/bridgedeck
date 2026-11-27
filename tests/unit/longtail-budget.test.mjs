// tests/unit/longtail-budget.test.mjs —— 规模预设、预算判定、原因码、阈值覆盖。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET_VERSION,
  CHECK_KINDS,
  CHECK_SEVERITIES,
  FAILURE_CODES,
  FIXTURE_SCALES,
  SCALE_NAMES,
  applyBudgetOverrides,
  budgetFingerprint,
  describeFailure,
  deriveExitCode,
  evaluateBudget,
  normalizeBudget,
  overrideMemoryBudget,
  readMetric,
  resolveScale,
  scaleTimeBudget,
  summarizeVerdicts,
} from '../../tools/longtail/lib/budget.mjs';

test('规模预设：default 满足任务目标，smoke 更小', () => {
  const def = resolveScale('default');
  const smoke = resolveScale('smoke');
  assert.equal(BUDGET_VERSION, 1);
  assert.deepEqual(SCALE_NAMES, ['smoke', 'default']);
  assert.ok(def.page.refs >= 1000, 'page refs ≥1000');
  assert.ok(def.page.depth >= 12, '嵌套深度 ≥12');
  assert.ok(def.page.frames >= 8, 'iframe ≥8');
  assert.ok(def.har.minBytes >= 5_000_000, 'HAR ≥5MB');
  assert.ok(def.record.steps >= 200, 'record ≥200 步');
  assert.ok(def.record.boundaries >= 4, 'record 分支 ≥4');
  assert.ok(def.video.segments >= 100, '视频分片 ≥100');
  assert.ok(smoke.page.refs < def.page.refs);
  assert.ok(smoke.har.minBytes < def.har.minBytes);
  assert.ok(smoke.record.steps < def.record.steps);
  assert.ok(smoke.video.segments < def.video.segments);
  assert.ok(Object.isFrozen(FIXTURE_SCALES));
  assert.equal(resolveScale(), def);
});

test('resolveScale：未知规模直接报错（不静默降级）', () => {
  assert.throws(() => resolveScale('huge'), /未知 longtail 规模：huge/);
  assert.throws(() => resolveScale('huge'), /smoke\/default/);
});

test('normalizeBudget：默认值、冻结、指纹', () => {
  const budget = normalizeBudget({ label: 'x', timeMs: 100 });
  assert.equal(budget.version, BUDGET_VERSION);
  assert.equal(budget.timeMs, 100);
  assert.equal(budget.timeWarnMs, 0);
  assert.equal(budget.memoryMb, 0);
  assert.equal(budget.timeMetric, 'timeMs');
  assert.equal(budget.memoryMetric, 'peakHeapUsedMb');
  assert.deepEqual(budget.checks, []);
  assert.match(budget.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(Object.isFrozen(budget), true);
  // 幂等：已归一化的预算再归一化结果一致。
  assert.equal(normalizeBudget(budget).fingerprint, budget.fingerprint);
});

test('normalizeBudget：非法规格报错', () => {
  assert.throws(() => normalizeBudget(null), /必须是对象/);
  assert.throws(() => normalizeBudget({ checks: [{ kind: 'weird', limit: 1 }] }), /非法 check.kind/);
  assert.throws(() => normalizeBudget({ checks: [{ kind: 'min', limit: 1, severity: 'fatal' }] }), /非法 check.severity/);
  assert.throws(() => normalizeBudget({ checks: [{ kind: 'min', name: 'no-limit' }] }), /需要数值 limit/);
  assert.throws(() => normalizeBudget({ checks: [{ kind: 'range', min: 0 }] }), /需要 min\/max/);
  assert.throws(() => normalizeBudget({ timeMs: 100, timeWarnMs: 200 }), /timeWarnMs 不能大于 timeMs/);
  assert.equal(CHECK_KINDS.length, 6);
  assert.deepEqual(CHECK_SEVERITIES, ['error', 'warning']);
});

test('readMetric 支持点路径', () => {
  const metrics = { a: { b: { c: 3 } }, flat: 4, nil: null };
  assert.equal(readMetric(metrics, 'a.b.c'), 3);
  assert.equal(readMetric(metrics, 'flat'), 4);
  assert.equal(readMetric(metrics, 'a.b'), metrics.a.b);
  assert.equal(readMetric(metrics, 'missing.x'), undefined);
  assert.equal(readMetric(null, 'a'), undefined);
  assert.equal(readMetric(metrics, ''), metrics);
});

function passingBudget() {
  return {
    label: 'unit-pass',
    kind: 'unit',
    timeMs: 100,
    timeWarnMs: 50,
    memoryMb: 10,
    checks: [
      { name: 'count-min', metric: 'count', kind: 'min', limit: 1 },
      { name: 'other-max', metric: 'other', kind: 'max', limit: 5 },
      { name: 'eq', metric: 'eq', kind: 'equal', limit: 2 },
      { name: 'flag', metric: 'flag', kind: 'truthy' },
      { name: 'ratio', metric: 'ratio', kind: 'range', min: 0.5, max: 2 },
      { name: 'exists', metric: 'text', kind: 'exists' },
    ],
  };
}

function passingMetrics() {
  return { timeMs: 40, peakHeapUsedMb: 5, count: 2, other: 3, eq: 2, flag: true, ratio: 1.2, text: 'x' };
}

test('evaluateBudget：全部通过 → pass', () => {
  const verdict = evaluateBudget({ budget: passingBudget(), metrics: passingMetrics() });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.level, 'pass');
  assert.equal(verdict.failures.length, 0);
  assert.equal(verdict.warnings.length, 0);
  assert.equal(verdict.checks.length, 6);
  assert.ok(verdict.checks.every((check) => check.ok));
  assert.deepEqual(verdict.time, { actualMs: 40, budgetMs: 100, warnMs: 50, ok: true });
  assert.deepEqual(verdict.memory, { actualMb: 5, budgetMb: 10, ok: true });
});

test('evaluateBudget：各类 check 失败给稳定原因码', () => {
  const cases = [
    [{ count: 0 }, 'metric-below-minimum'],
    [{ other: 9 }, 'metric-above-maximum'],
    [{ eq: 3 }, 'metric-mismatch'],
    [{ flag: false }, 'invariant-failed'],
    [{ ratio: 9 }, 'metric-out-of-range'],
    [{ text: '' }, 'metric-missing'],
  ];
  for (const [patch, expectedCode] of cases) {
    const verdict = evaluateBudget({ budget: passingBudget(), metrics: { ...passingMetrics(), ...patch } });
    assert.equal(verdict.ok, false, JSON.stringify(patch));
    assert.equal(verdict.level, 'fail');
    assert.ok(verdict.failures.some((failure) => failure.code === expectedCode), expectedCode + ' not in ' + JSON.stringify(verdict.failures.map((failure) => failure.code)));
  }
});

test('evaluateBudget：warning 级失败只降为 warn，不失败', () => {
  const budget = {
    label: 'warn-only',
    checks: [{ name: 'soft', metric: 'count', kind: 'min', limit: 10, severity: 'warning' }],
  };
  const verdict = evaluateBudget({ budget, metrics: { count: 1 } });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.level, 'warn');
  assert.equal(verdict.failures.length, 0);
  assert.equal(verdict.warnings.length, 1);
  assert.equal(verdict.warnings[0].code, FAILURE_CODES.MIN);
});

test('evaluateBudget：时间/内存区间与失败原因', () => {
  const metrics = passingMetrics();
  const warn = evaluateBudget({ budget: passingBudget(), metrics: { ...metrics, timeMs: 60 } });
  assert.equal(warn.level, 'warn');
  assert.ok(warn.warnings.some((warning) => warning.code === FAILURE_CODES.TIME_WARN));
  const slow = evaluateBudget({ budget: passingBudget(), metrics: { ...metrics, timeMs: 101 } });
  assert.equal(slow.level, 'fail');
  assert.deepEqual(slow.time, { actualMs: 101, budgetMs: 100, warnMs: 50, ok: false });
  assert.ok(slow.failures.some((failure) => failure.code === FAILURE_CODES.TIME));
  const heavy = evaluateBudget({ budget: passingBudget(), metrics: { ...metrics, peakHeapUsedMb: 11 } });
  assert.equal(heavy.level, 'fail');
  assert.ok(heavy.failures.some((failure) => failure.code === FAILURE_CODES.MEMORY));
  const missing = evaluateBudget({ budget: passingBudget(), metrics: {} });
  assert.equal(missing.level, 'fail');
  assert.ok(missing.failures.some((failure) => failure.code === FAILURE_CODES.TIME));
  assert.ok(missing.failures.some((failure) => failure.code === FAILURE_CODES.MEMORY));
});

test('evaluateBudget：场景错误直接 fail 且带 ERROR 原因码', () => {
  const verdict = evaluateBudget({ budget: passingBudget(), metrics: {}, error: { message: 'boom' } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.level, 'fail');
  assert.equal(verdict.failures[0].code, FAILURE_CODES.ERROR);
  assert.equal(verdict.time.ok, false);
});

test('evaluateBudget：真实模块消费证据为空 → 失败', () => {
  const noEvidence = evaluateBudget({ budget: passingBudget(), metrics: passingMetrics(), evidence: { realModuleCalls: [] } });
  assert.equal(noEvidence.ok, false);
  assert.ok(noEvidence.failures.some((failure) => failure.code === FAILURE_CODES.EVIDENCE));
  const withEvidence = evaluateBudget({ budget: passingBudget(), metrics: passingMetrics(), evidence: { realModuleCalls: ['x.js#f'] } });
  assert.equal(withEvidence.ok, true);
});

test('summarizeVerdicts / deriveExitCode', () => {
  const pass = evaluateBudget({ budget: passingBudget(), metrics: passingMetrics() });
  const warn = evaluateBudget({ budget: { label: 'w', checks: [{ name: 'soft', metric: 'x', kind: 'min', limit: 2, severity: 'warning' }] }, metrics: { x: 0 } });
  const fail = evaluateBudget({ budget: { label: 'f', checks: [{ name: 'hard', metric: 'x', kind: 'min', limit: 2 }] }, metrics: { x: 0 } });
  const summary = summarizeVerdicts([pass, warn, fail]);
  assert.equal(summary.total, 3);
  assert.equal(summary.pass, 1);
  assert.equal(summary.warn, 1);
  assert.equal(summary.fail, 1);
  assert.equal(summary.ok, false);
  assert.equal(summary.byCode[FAILURE_CODES.MIN], 2);
  assert.equal(deriveExitCode({ verdicts: [pass, fail] }), 0);
  assert.equal(deriveExitCode({ verdicts: [pass, fail], check: true }), 1);
  assert.equal(deriveExitCode({ verdicts: [pass], check: true }), 0);
  assert.equal(deriveExitCode({ verdicts: [pass], errors: [{ id: 'x' }] }), 1);
  assert.equal(deriveExitCode({ verdicts: [fail], check: false }), 0);
});

test('时间阈值按比例放宽：时间与 unit=ms 的 max check 一起变', () => {
  const budget = normalizeBudget({
    label: 'scale-me',
    timeMs: 100,
    timeWarnMs: 50,
    checks: [
      { name: 'a', metric: 'a', kind: 'max', unit: 'ms', limit: 80 },
      { name: 'b', metric: 'b', kind: 'max', unit: 'count', limit: 10 },
      { name: 'c', metric: 'c', kind: 'min', unit: 'ms', limit: 5 },
    ],
  });
  const scaled = scaleTimeBudget(budget, 2);
  assert.equal(scaled.timeMs, 200);
  assert.equal(scaled.timeWarnMs, 100);
  assert.equal(scaled.checks[0].limit, 160);
  assert.equal(scaled.checks[1].limit, 10, '计数上限不放大');
  assert.equal(scaled.checks[2].limit, 5, 'min 下限不放大');
  assert.equal(scaleTimeBudget(budget, 0).timeMs, 100, '非法比例不改变规格');
  assert.notEqual(scaleTimeBudget(budget, 2).fingerprint, budget.fingerprint);
});

test('overrideMemoryBudget / applyBudgetOverrides', () => {
  const budget = normalizeBudget({ label: 'm', timeMs: 100, memoryMb: 10 });
  assert.equal(overrideMemoryBudget(budget, 64).memoryMb, 64);
  assert.equal(overrideMemoryBudget(budget, 0).memoryMb, 10);
  const combined = applyBudgetOverrides(budget, { timeScale: 3, memoryMb: 32 });
  assert.equal(combined.timeMs, 300);
  assert.equal(combined.memoryMb, 32);
  assert.equal(applyBudgetOverrides(budget, {}).timeMs, 100);
});

test('budgetFingerprint 随阈值变化、同阈值稳定', () => {
  const left = normalizeBudget({ label: 'f', timeMs: 100, memoryMb: 10 });
  const right = normalizeBudget({ label: 'f', timeMs: 100, memoryMb: 10 });
  const changed = normalizeBudget({ label: 'f', timeMs: 101, memoryMb: 10 });
  assert.equal(budgetFingerprint(left), budgetFingerprint(right));
  assert.notEqual(budgetFingerprint(left), budgetFingerprint(changed));
});

test('每个失败原因码都有可读解释', () => {
  for (const code of Object.values(FAILURE_CODES)) {
    assert.ok(describeFailure(code).length > 4, code);
  }
  assert.match(describeFailure('unknown-code'), /未知失败原因/);
});
