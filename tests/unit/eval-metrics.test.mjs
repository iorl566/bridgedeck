// tests/unit/eval-metrics.test.mjs —— 三态指标/分类/门禁纯函数单测（无 daemon/无浏览器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THRESHOLDS,
  EXPECTED_STATUSES,
  FAILURE_CATEGORIES,
  classifyFailure,
  classifyOutcome,
  computeMetrics,
  evaluateGate,
  formatMetric,
  renderMatrixRows,
  validateThresholds,
} from '../../lib/eval-e2e-metrics.mjs';

function result(expectedStatus, status, overrides = {}) {
  return {
    id: overrides.id || expectedStatus + '-' + status + '-' + Math.random().toString(36).slice(2, 7),
    layer: 'offline',
    capability: 'plugin.tool-contract',
    oracleLevel: 'offline-fake',
    expectedStatus,
    status,
    checks: [],
    unverified: [],
    ...overrides,
  };
}

test('classifyOutcome：三态 3×3 矩阵逐一对应 tp/tn/tu/fp/fn/skip/missed/overclaim/unexpected', () => {
  const table = {
    'passed/passed': 'tp',
    'passed/failed': 'fn',
    'passed/unverified': 'skip',
    'failed/passed': 'fp',
    'failed/failed': 'tn',
    'failed/unverified': 'missed-negative',
    'unverified/passed': 'overclaim',
    'unverified/failed': 'unexpected-failure',
    'unverified/unverified': 'tu',
  };
  for (const expected of EXPECTED_STATUSES) {
    for (const actual of EXPECTED_STATUSES) {
      const outcome = classifyOutcome(expected, actual);
      assert.equal(outcome.outcome, table[expected + '/' + actual], expected + '/' + actual);
      assert.equal(outcome.isUnexpected, !['tp', 'tn', 'tu'].includes(outcome.outcome));
    }
  }
  assert.equal(classifyOutcome('passed', 'skipped').outcome, 'invalid');
  assert.equal(classifyOutcome(undefined, 'passed').outcome, 'invalid');
});

test('computeMetrics：precision/recall/skipRate 与 fp/fn 计数符合定义', () => {
  const results = [
    result('passed', 'passed'),
    result('passed', 'failed'),
    result('passed', 'unverified', { unverified: [{ id: 'x:obs', reason: 'missing evidence' }] }),
    result('failed', 'passed'),
    result('failed', 'failed'),
    result('failed', 'unverified', { unverified: [{ id: 'y:obs', reason: 'missing evidence' }] }),
    result('unverified', 'passed'),
    result('unverified', 'failed'),
    result('unverified', 'unverified', { unverified: [{ id: 'z:obs', reason: 'missing evidence' }] }),
  ];
  const metrics = computeMetrics(results);
  assert.equal(metrics.total, 9);
  assert.equal(metrics.expected.passed, 3);
  assert.equal(metrics.expected.failed, 3);
  assert.equal(metrics.expected.unverified, 3);
  assert.equal(metrics.counts.truePositives, 1);
  assert.equal(metrics.counts.trueNegatives, 1);
  assert.equal(metrics.counts.trueUnverified, 1);
  assert.equal(metrics.counts.falsePositives, 2, 'fp + overclaim');
  assert.equal(metrics.counts.falseNegatives, 2, 'fn + skip');
  assert.equal(metrics.counts.skips, 1);
  assert.equal(metrics.counts.missedNegatives, 1);
  assert.equal(metrics.counts.unexpected, 6);
  assert.ok(Math.abs(metrics.precision - 1 / 3) < 1e-9);
  assert.ok(Math.abs(metrics.recall - 1 / 3) < 1e-9);
  assert.ok(Math.abs(metrics.skipRate - 1 / 3) < 1e-9);
  assert.equal(metrics.classification.falsePositives.length, 2);
  assert.equal(metrics.classification.falseNegatives.length, 1);
  assert.equal(metrics.classification.skips.length, 1);
  assert.equal(metrics.classification.missedNegatives.length, 1);
  assert.equal(metrics.classification.unexpectedFailures.length, 1);
  const categories = metrics.classification.falsePositives.map((item) => item.category).sort();
  assert.deepEqual(categories, ['accepted-negative-as-pass', 'accepted-unverified-as-pass']);
});

test('computeMetrics：空结果/无正例 → 指标为 n/a，门禁不会因此变绿', () => {
  const empty = computeMetrics([]);
  assert.equal(empty.precision, null);
  assert.equal(empty.recall, null);
  assert.equal(empty.total, 0);
  const gate = evaluateGate(empty, {});
  assert.equal(gate.ok, false);
  assert.ok(gate.failures.includes('min-cases'));
  assert.ok(gate.failures.includes('precision'));
  const negativesOnly = computeMetrics([result('failed', 'failed')]);
  assert.equal(negativesOnly.precision, null, '没有实际 pass 时 precision 无定义');
  assert.equal(negativesOnly.recall, null, '没有期望 pass 时 recall 无定义');
});

test('computeMetrics：按 layer/capability/oracleLevel 分组且组内指标独立', () => {
  const metrics = computeMetrics([
    result('passed', 'passed', { layer: 'offline', capability: 'plugin.tool-contract' }),
    result('passed', 'failed', { layer: 'dom', capability: 'overlay.rtl', oracleLevel: 'dom-real' }),
    result('failed', 'failed', { layer: 'dom', capability: 'overlay.rtl', oracleLevel: 'dom-real' }),
  ]);
  assert.deepEqual(Object.keys(metrics.byLayer).sort(), ['dom', 'offline']);
  assert.equal(metrics.byLayer.offline.precision, 1);
  assert.equal(metrics.byLayer.dom.precision, null);
  assert.equal(metrics.byLayer.dom.recall, 0);
  assert.equal(metrics.byCapability['overlay.rtl'].total, 2);
  assert.equal(metrics.byOracleLevel['dom-real'].total, 2);
  assert.deepEqual(metrics.oracleLevels.sort(), ['dom-real', 'offline-fake']);
});

test('classifyFailure：错误码/参数/argv/DOM/缺值/contains/证据缺失分类可复现', () => {
  const failed = (checks, extra = {}) => result('passed', 'failed', { checks, ...extra });
  const cases = [
    [failed([{ id: 'a:error-code', status: 'fail', ok: false, evidence: { expected: 'E_TIMEOUT', actual: 'E_FORBIDDEN' } }]), 'error-code-mismatch'],
    [failed([{ id: 'a:rpc:fill', status: 'fail', ok: false, evidence: { expectedParams: { value: 'x' }, actualCalls: [] } }]), 'rpc-params-mismatch'],
    [failed([{ id: 'a:cli:audit list', status: 'fail', ok: false, evidence: { expectedArgv: ['audit', 'list'], actualCliCalls: [] } }]), 'cli-argv-mismatch'],
    [failed([{ id: 'a:hit.x', status: 'fail', ok: false, evidence: { path: 'hit.x', expected: 'a', actual: 'b' } }], { layer: 'dom', capability: 'overlay.hit-testing', oracleLevel: 'dom-real' }), 'dom-fact-mismatch'],
    [failed([{ id: 'a:x', status: 'fail', ok: false, evidence: { path: 'x', expected: 1, actual: undefined } }]), 'missing-value'],
    [failed([{ id: 'a:x', status: 'fail', ok: false, evidence: { path: 'x', needle: 'n', actual: 'other' } }]), 'contains-mismatch'],
    [failed([{ id: 'a:obs', status: 'fail', ok: false, evidence: { path: 'obs', expected: 'a', actual: 'b' } }]), 'value-mismatch'],
    [result('passed', 'unverified', { unverified: [{ id: 'a:obs', reason: 'missing evidence' }] }), 'missing-evidence'],
    [result('passed', 'unverified'), 'no-checks'],
    [result('passed', 'failed', { runnerError: 'boom' }), 'runner-error'],
    [result('failed', 'passed'), 'accepted-negative-as-pass'],
    [result('unverified', 'passed'), 'accepted-unverified-as-pass'],
  ];
  for (const [item, expected] of cases) {
    const classified = classifyFailure(item);
    assert.equal(classified.category, expected, item.id);
    assert.ok(FAILURE_CATEGORIES.includes(classified.category));
  }
  // 失败 check 但既无证据也无 error：落到通用 check-failed，不得静默成 pass。
  assert.equal(classifyFailure(failed([{ id: 'a:z', status: 'fail', ok: false }])).category, 'check-failed');
});

test('validateThresholds：合法阈值通过，未知字段/越界比例/非法计数都被拒绝', () => {
  assert.equal(validateThresholds({}).ok, true);
  assert.equal(validateThresholds(DEFAULT_THRESHOLDS).ok, true);
  const unknown = validateThresholds({ minPrecisoin: 0.9 });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.problems.some((item) => item.includes('minPrecisoin')));
  const ratio = validateThresholds({ minPrecision: 1.5 });
  assert.equal(ratio.ok, false);
  const count = validateThresholds({ minCases: -1 });
  assert.equal(count.ok, false);
  const statuses = validateThresholds({ requiredStatuses: ['passed', 'skipped'] });
  assert.equal(statuses.ok, false);
  const levels = validateThresholds({ requiredOracleLevels: [''] });
  assert.equal(levels.ok, false);
  // 文档字段允许存在（阈值文件里写 schema/note 不应被判成非法）。
  assert.equal(validateThresholds({ schema: 'x', note: 'y' }).ok, true);
});

function goodCorpus() {
  const results = [];
  for (let index = 0; index < 55; index += 1) results.push(result('passed', 'passed', { id: 'g-' + index }));
  results.push(result('failed', 'failed', { id: 'g-fail-1' }));
  results.push(result('failed', 'failed', { id: 'g-fail-2' }));
  results.push(result('unverified', 'unverified', { id: 'g-unv-1', unverified: [{ id: 'u', reason: 'missing evidence' }] }));
  results.push(result('unverified', 'unverified', { id: 'g-unv-2', unverified: [{ id: 'u', reason: 'missing evidence' }] }));
  results.push(result('unverified', 'unverified', { id: 'g-unv-3', unverified: [{ id: 'u', reason: 'missing evidence' }] }));
  return results;
}

test('evaluateGate：满足阈值 PASS（exitCode=0），任一维度低于阈值 FAIL（exitCode=1）', () => {
  const metrics = computeMetrics(goodCorpus());
  const ok = evaluateGate(metrics, {});
  assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((check) => !check.ok)));
  assert.equal(ok.exitCode, 0);
  assert.ok(ok.checks.every((check) => typeof check.ok === 'boolean' && check.id && check.detail));

  const cases = [
    [{ minCases: 100 }, 'min-cases'],
    [{ maxSkipRate: 0 }, null], // 该语料 skip=0，不应失败
    [{ maxFalsePositives: 5 }, 'false-positives'],
    [{ requiredOracleLevels: ['dom-real'] }, 'oracle-dom-real'],
    [{ requiredStatuses: ['passed', 'failed', 'unverified', 'invalid'] }, null],
  ];
  const minCases = evaluateGate(metrics, cases[0][0]);
  assert.equal(minCases.ok, false);
  assert.ok(minCases.failures.includes('min-cases'));
  const oracle = evaluateGate(metrics, cases[3][0]);
  assert.equal(oracle.ok, false);
  assert.ok(oracle.failures.includes('oracle-dom-real'));

  // 用确定序号制造 50% skip（早前按随机 id 尾字符挑 case，会随机命中 0 个而假通过）。
  const skipMetrics = computeMetrics(
    goodCorpus().map((item, index) => (index % 2 === 0 && item.status === 'passed' ? { ...item, status: 'unverified', unverified: [{ id: 'm', reason: 'x' }] } : item)),
  );
  const skipGate = evaluateGate(skipMetrics, { maxSkipRate: 0.01, maxFalseNegatives: 5 });
  assert.equal(skipGate.ok, false);
  assert.ok(skipGate.failures.includes('skip-rate'));
  // 非法阈值 → gate.ok=false（调用方必须 exit≠0），不允许静默忽略配置错误。
  const invalid = evaluateGate(metrics, { minPrecision: 2 });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.thresholdProblems.length >= 1);
});

test('formatMetric / renderMatrixRows：n/a 与三态矩阵渲染稳定', () => {
  assert.equal(formatMetric(null), 'n/a');
  assert.equal(formatMetric(1), '1.000');
  assert.equal(formatMetric(0.12345), '0.123');
  const rows = renderMatrixRows({ passed: { passed: 1, failed: 2, unverified: 3 }, failed: { passed: 0, failed: 0, unverified: 0 }, unverified: { passed: 0, failed: 0, unverified: 0 } });
  assert.equal(rows.length, 3);
  assert.equal(rows[0], '| passed | 1 | 2 | 3 |');
  assert.equal(rows[2], '| unverified | 0 | 0 | 0 |');
});
