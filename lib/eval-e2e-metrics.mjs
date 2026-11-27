/**
 * lib/eval-e2e-metrics.mjs —— eval 三态指标与阈值门禁（纯函数，无 IO/无浏览器）。
 *
 * 术语与判定（三态：passed / failed / unverified，unverified 永不算 pass）：
 *
 *   expected \ actual | passed   | failed            | unverified
 *   -------------------+----------+-------------------+-------------------
 *   passed            | tp       | fn                | skip
 *   failed            | fp       | tn                | missed-negative
 *   unverified        | overclaim| unexpected-failure| tu
 *
 * - tp / tn / tu：与预期一致；
 * - fp（false positive）：oracle 把“已知的失败/无法判定”判成 pass（overclaim 是它的子类）；
 * - fn（false negative）：oracle 把真实的 pass 判成 failed；
 * - skip：预期 pass 却 unverified —— 属于“漏验证”，不进入 precision/recall 的分子，
 *   并单独用 skipRate 门禁（skip 绝不通过“全部通过”伪造绿）；
 * - missed-negative / unexpected-failure：负向或无法判定用例的漏判/误判，单独计数。
 *
 * precision = tp / (tp + fp)
 * recall    = tp / (tp + fn + skip)      # 未验证按漏判计入 recall，避免 skip 抬高召回
 * skipRate  = skip / expectedPassed      # 预期 pass 中无法判定的比例
 *
 * 所有函数对非法输入给出结构化结果（invalid / n/a），不因数据脏而静默通过。
 */

export const EXPECTED_STATUSES = Object.freeze(['passed', 'failed', 'unverified']);

export const OUTCOMES = Object.freeze([
  'tp',
  'tn',
  'tu',
  'fp',
  'fn',
  'skip',
  'missed-negative',
  'overclaim',
  'unexpected-failure',
]);

/** 失败/漏判的根因分类。fp/fn/skip 明细里每项都带一个 category。 */
export const FAILURE_CATEGORIES = Object.freeze([
  'error-code-mismatch',
  'rpc-params-mismatch',
  'cli-argv-mismatch',
  'dom-fact-mismatch',
  'missing-value',
  'value-mismatch',
  'contains-mismatch',
  'unexpected-error',
  'missing-evidence',
  'no-checks',
  'runner-error',
  'check-failed',
  'e2e-fail-line',
  'accepted-negative-as-pass',
  'accepted-unverified-as-pass',
]);

/** 默认阈值；tests/eval/thresholds.json 会覆盖其中若干项（报告里展示实际生效值）。 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  minCases: 57,
  minPrecision: 0.98,
  minRecall: 0.98,
  maxSkipRate: 0.05,
  maxUnverifiedRate: 0.2,
  maxFalsePositives: 0,
  maxFalseNegatives: 0,
  maxMissedNegatives: 0,
  maxUnexpected: 0,
  maxInvalid: 0,
  requiredStatuses: EXPECTED_STATUSES.slice(),
  requiredOracleLevels: [],
});

/** 把比例阈值字段（0..1）与计数阈值字段（>=0 整数）分开，便于校验。 */
const RATIO_THRESHOLDS = Object.freeze([
  'minPrecision',
  'minRecall',
  'maxSkipRate',
  'maxUnverifiedRate',
]);
const COUNT_THRESHOLDS = Object.freeze([
  'minCases',
  'maxFalsePositives',
  'maxFalseNegatives',
  'maxMissedNegatives',
  'maxUnexpected',
  'maxInvalid',
]);

export function isExpectedStatus(value) {
  return EXPECTED_STATUSES.includes(value);
}

function emptyMatrix() {
  const matrix = {};
  for (const expected of EXPECTED_STATUSES) {
    matrix[expected] = {};
    for (const actual of EXPECTED_STATUSES) matrix[expected][actual] = 0;
  }
  return matrix;
}

/**
 * 判定单个 case 的 outcome。
 * @param {string} expectedStatus 语料声明（passed|failed|unverified）
 * @param {string} status 实际三态
 */
export function classifyOutcome(expectedStatus, status) {
  if (!isExpectedStatus(expectedStatus) || !isExpectedStatus(status)) {
    return { outcome: 'invalid', isFalsePositive: false, isFalseNegative: false, isSkip: false, isUnexpected: true };
  }
  if (expectedStatus === 'passed') {
    if (status === 'passed') return { outcome: 'tp', isFalsePositive: false, isFalseNegative: false, isSkip: false, isUnexpected: false };
    if (status === 'failed') return { outcome: 'fn', isFalsePositive: false, isFalseNegative: true, isSkip: false, isUnexpected: true };
    return { outcome: 'skip', isFalsePositive: false, isFalseNegative: true, isSkip: true, isUnexpected: true };
  }
  if (expectedStatus === 'failed') {
    if (status === 'failed') return { outcome: 'tn', isFalsePositive: false, isFalseNegative: false, isSkip: false, isUnexpected: false };
    if (status === 'passed') return { outcome: 'fp', isFalsePositive: true, isFalseNegative: false, isSkip: false, isUnexpected: true };
    return { outcome: 'missed-negative', isFalsePositive: false, isFalseNegative: true, isSkip: false, isUnexpected: true };
  }
  // expectedStatus === 'unverified'
  if (status === 'unverified') return { outcome: 'tu', isFalsePositive: false, isFalseNegative: false, isSkip: false, isUnexpected: false };
  if (status === 'passed') return { outcome: 'overclaim', isFalsePositive: true, isFalseNegative: false, isSkip: false, isUnexpected: true };
  return { outcome: 'unexpected-failure', isFalsePositive: false, isFalseNegative: false, isSkip: false, isUnexpected: true };
}

function firstFailedCheck(result) {
  const checks = Array.isArray(result && result.checks) ? result.checks : [];
  return checks.find((check) => check && (check.status === 'fail' || (check.ok === false && check.status !== 'unverified'))) || null;
}

function firstUnverified(result) {
  if (result && Array.isArray(result.unverified) && result.unverified.length) return result.unverified[0];
  const checks = Array.isArray(result && result.checks) ? result.checks : [];
  const judged = checks.find((check) => check && check.status === 'unverified');
  return judged || null;
}

function evidenceOf(check) {
  return check && check.evidence && typeof check.evidence === 'object' ? check.evidence : {};
}

/**
 * 对单个结果给出可复现的失败/漏判根因。
 * 分类优先命中错误码、参数/argv、DOM 事实等最具体的证据，最后才落到通用 check-failed。
 */
export function classifyFailure(result) {
  const item = result && typeof result === 'object' ? result : {};
  const id = item.id === undefined ? null : String(item.id);
  const base = {
    id,
    layer: item.layer || null,
    capability: item.capability || null,
    oracleLevel: item.oracleLevel || null,
    expectedStatus: item.expectedStatus || null,
    status: item.status || null,
  };
  if (item.status === 'unverified') {
    const missing = firstUnverified(item);
    return {
      ...base,
      category: missing && missing.id ? 'missing-evidence' : 'no-checks',
      checkId: missing && missing.id ? String(missing.id) : null,
      reason: missing && missing.reason ? String(missing.reason) : 'unverified without reason',
      evidence: null,
    };
  }
  if (item.status === 'failed') {
    if (item.error && item.error.code) {
      const check = firstFailedCheck(item);
      const evidence = evidenceOf(check);
      return {
        ...base,
        category: check && /error-code$/.test(String(check.id || '')) ? 'error-code-mismatch' : 'unexpected-error',
        checkId: check ? String(check.id) : null,
        reason: String(item.error.message || item.error.code),
        evidence: { code: item.error.code, ...(evidence.expected !== undefined ? { expected: evidence.expected } : {}) },
      };
    }
    const check = firstFailedCheck(item);
    if (!check) {
      return { ...base, category: item.runnerError ? 'runner-error' : 'check-failed', checkId: null, reason: item.runnerError || 'failed without failed check', evidence: null };
    }
    const checkId = String(check.id || '');
    const evidence = evidenceOf(check);
    let category = 'check-failed';
    if (/error-code$/.test(checkId)) category = 'error-code-mismatch';
    else if (/:e2e-line$/.test(checkId)) category = 'e2e-fail-line';
    else if (/:rpc:/.test(checkId)) category = 'rpc-params-mismatch';
    else if (/:cli:/.test(checkId)) category = 'cli-argv-mismatch';
    else if (item.layer === 'dom' && evidence.path !== undefined) category = 'dom-fact-mismatch';
    else if (evidence.needle !== undefined) category = 'contains-mismatch';
    else if (evidence.path !== undefined && evidence.actual === undefined) category = 'missing-value';
    else if (evidence.path !== undefined) category = 'value-mismatch';
    else if (item.error) category = 'unexpected-error';
    return {
      ...base,
      category,
      checkId,
      reason: check.reason || (check.evidence ? JSON.stringify(check.evidence) : 'check failed'),
      evidence: check.evidence === undefined ? null : check.evidence,
    };
  }
  // 非法 expected（语料/运行器 bug）：不算通过，单独列为 invalid。
  if (!isExpectedStatus(item.expectedStatus)) {
    return { ...base, category: 'runner-error', checkId: null, reason: 'invalid expectedStatus', evidence: null };
  }
  // status=passed 但期望不是 passed —— 过度断言。
  return {
    ...base,
    category: item.expectedStatus === 'failed' ? 'accepted-negative-as-pass' : 'accepted-unverified-as-pass',
    checkId: null,
    reason: 'oracle 判定 passed，但语料期望 ' + item.expectedStatus,
    evidence: null,
  };
}

function summaryOf(results) {
  const matrix = emptyMatrix();
  const outcomes = Object.fromEntries(OUTCOMES.map((name) => [name, 0]));
  const expected = { passed: 0, failed: 0, unverified: 0 };
  const actual = { passed: 0, failed: 0, unverified: 0 };
  const invalid = [];
  for (const item of results) {
    const expectedStatus = item && item.expectedStatus;
    const status = item && item.status;
    if (!isExpectedStatus(expectedStatus) || !isExpectedStatus(status)) {
      invalid.push(item);
      continue;
    }
    matrix[expectedStatus][status] += 1;
    expected[expectedStatus] += 1;
    actual[status] += 1;
    outcomes[classifyOutcome(expectedStatus, status).outcome] += 1;
  }
  const total = results.length;
  return { total, expected, actual, matrix, outcomes, invalid };
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/** 把原始 summary 换算成对外指标（null 表示“无分母，n/a”；门禁会把 n/a 视为不满足）。 */
export function computeMetricsFromResults(results) {
  const list = Array.isArray(results) ? results : [];
  const summary = summaryOf(list);
  const o = summary.outcomes;
  const expectedPassed = summary.expected.passed;
  const falsePositives = o.fp + o.overclaim;
  const falseNegatives = o.fn + o.skip;
  const precision = ratio(o.tp, o.tp + falsePositives);
  const recall = ratio(o.tp, o.tp + o.fn + o.skip);
  const skipRate = ratio(o.skip, expectedPassed);
  // 先把结果分桶，再对每组重算指标，避免把“分组”混进上面的总计数。
  const buckets = new Map();
  const bucket = (name, item) => {
    const key = name === undefined || name === null || name === '' ? '(unspecified)' : String(name);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  };
  const groupBy = (keyOf) => {
    buckets.clear();
    for (const item of list) bucket(keyOf(item), item);
    const out = new Map();
    for (const [name, items] of buckets) out.set(name, summarizeGroup(items));
    return out;
  };
  const byLayer = groupBy((item) => item && item.layer);
  const byCapability = groupBy((item) => item && item.capability);
  const byOracleLevel = groupBy((item) => item && item.oracleLevel);
  const classification = {
    falsePositives: [],
    falseNegatives: [],
    skips: [],
    missedNegatives: [],
    unexpectedFailures: [],
    invalid: summary.invalid.map((item) => ({ id: item && item.id ? String(item.id) : null, reason: 'invalid status/expectedStatus' })),
  };
  for (const item of list) {
    const outcome = classifyOutcome(item && item.expectedStatus, item && item.status).outcome;
    if (outcome === 'fp' || outcome === 'overclaim') classification.falsePositives.push(classifyFailure(item));
    else if (outcome === 'fn') classification.falseNegatives.push(classifyFailure(item));
    else if (outcome === 'skip') classification.skips.push(classifyFailure(item));
    else if (outcome === 'missed-negative') classification.missedNegatives.push(classifyFailure(item));
    else if (outcome === 'unexpected-failure') classification.unexpectedFailures.push(classifyFailure(item));
  }
  const grouped = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return {
    total: summary.total,
    expected: summary.expected,
    actual: summary.actual,
    matrix: summary.matrix,
    outcomes: o,
    precision,
    recall,
    skipRate,
    unverifiedRate: ratio(summary.actual.unverified, summary.total),
    unexpectedRate: ratio(summary.total - summary.invalid.length - (o.tp + o.tn + o.tu), summary.total),
    falsePositiveRate: ratio(falsePositives, summary.total),
    falseNegativeRate: ratio(falseNegatives, expectedPassed),
    passRate: ratio(summary.actual.passed, summary.total),
    verifiedPassRate: ratio(o.tp, summary.total),
    counts: {
      truePositives: o.tp,
      trueNegatives: o.tn,
      trueUnverified: o.tu,
      falsePositives,
      falseNegatives,
      skips: o.skip,
      missedNegatives: o['missed-negative'],
      unexpectedFailures: o['unexpected-failure'],
      invalid: summary.invalid.length,
      unexpected: summary.total - summary.invalid.length - (o.tp + o.tn + o.tu),
    },
    oracleLevels: Object.keys(Object.fromEntries(byOracleLevel)),
    byLayer: grouped(byLayer),
    byCapability: grouped(byCapability),
    byOracleLevel: grouped(byOracleLevel),
    classification,
  };
}

/** 单个分组的精简指标（不含更细的分组，避免递归爆炸）。 */
function summarizeGroup(items) {
  const summary = summaryOf(items);
  const o = summary.outcomes;
  const falsePositives = o.fp + o.overclaim;
  return {
    total: summary.total,
    expected: summary.expected,
    actual: summary.actual,
    precision: ratio(o.tp, o.tp + falsePositives),
    recall: ratio(o.tp, o.tp + o.fn + o.skip),
    skipRate: ratio(o.skip, summary.expected.passed),
    falsePositives,
    falseNegatives: o.fn + o.skip,
    outcomes: o,
  };
}

/** 兼容别名：computeMetrics(results)。 */
export function computeMetrics(results) {
  return computeMetricsFromResults(results);
}

function compare(actual, limit, comparator) {
  if (actual === null || actual === undefined || !Number.isFinite(actual)) return false;
  if (comparator === '>=') return actual >= limit;
  if (comparator === '<=') return actual <= limit;
  if (comparator === '==') return actual === limit;
  return false;
}

/** 校验阈值对象；返回 {ok, problems, thresholds}（未知键报问题，不静默忽略）。 */
export function validateThresholds(input) {
  const problems = [];
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input && typeof input === 'object' ? input : {}) };
  const known = new Set([
    ...RATIO_THRESHOLDS,
    ...COUNT_THRESHOLDS,
    'requiredStatuses',
    'requiredOracleLevels',
    // 文档字段：允许出现在阈值文件里，不参与门禁计算。
    'schema',
    'note',
    'description',
  ]);
  for (const key of Object.keys(input && typeof input === 'object' ? input : {})) {
    if (!known.has(key)) problems.push('未知阈值字段：' + key);
  }
  for (const key of RATIO_THRESHOLDS) {
    const value = thresholds[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      problems.push(key + ' 需要 0..1 的数字，实际 ' + JSON.stringify(value));
    }
  }
  for (const key of COUNT_THRESHOLDS) {
    const value = thresholds[key];
    if (!Number.isInteger(value) || value < 0) problems.push(key + ' 需要非负整数，实际 ' + JSON.stringify(value));
  }
  if (!Array.isArray(thresholds.requiredStatuses) || thresholds.requiredStatuses.some((item) => !isExpectedStatus(item))) {
    problems.push('requiredStatuses 需要 passed/failed/unverified 数组');
  }
  if (!Array.isArray(thresholds.requiredOracleLevels) || thresholds.requiredOracleLevels.some((item) => typeof item !== 'string' || !item)) {
    problems.push('requiredOracleLevels 需要字符串数组');
  }
  return { ok: problems.length === 0, problems, thresholds };
}

/**
 * 阈值门禁：metrics 低于阈值 → ok=false，调用方必须 exit≠0。
 * 返回结构化 checks，报告里逐项展示 actual/limit。
 */
export function evaluateGate(metrics, overrides = {}) {
  const validated = validateThresholds(overrides);
  const thresholds = validated.thresholds;
  const checks = [];
  const push = (id, actual, limit, comparator, detail) => {
    checks.push({ id, actual, limit, comparator, ok: compare(actual, limit, comparator), detail: detail || '' });
  };
  const counts = metrics && metrics.counts ? metrics.counts : {};
  const total = Number(metrics && metrics.total) || 0;
  push('min-cases', total, thresholds.minCases, '>=', '语料至少达到本轮对标下限');
  push('precision', metrics ? metrics.precision : null, thresholds.minPrecision, '>=', 'tp/(tp+fp)');
  push('recall', metrics ? metrics.recall : null, thresholds.minRecall, '>=', 'tp/(tp+fn+skip)，skip 计入漏判');
  push('skip-rate', metrics ? metrics.skipRate : null, thresholds.maxSkipRate, '<=', '预期 pass 中 unverified 的比例');
  push('unverified-rate', metrics ? metrics.unverifiedRate : null, thresholds.maxUnverifiedRate, '<=', '实际 unverified / 总数');
  push('false-positives', counts.falsePositives === undefined ? null : counts.falsePositives, thresholds.maxFalsePositives, '<=', '过度断言（含 overclaim）');
  push('false-negatives', counts.falseNegatives === undefined ? null : counts.falseNegatives, thresholds.maxFalseNegatives, '<=', 'fn + skip');
  push('missed-negatives', counts.missedNegatives === undefined ? null : counts.missedNegatives, thresholds.maxMissedNegatives, '<=', '期望 failed 却 unverified');
  push('unexpected', counts.unexpected === undefined ? null : counts.unexpected, thresholds.maxUnexpected, '<=', '三态与期望不一致的总数');
  push('invalid', counts.invalid === undefined ? null : counts.invalid, thresholds.maxInvalid, '<=', '非法三态/期望的结果');
  for (const status of thresholds.requiredStatuses) {
    const actual = metrics && metrics.expected ? metrics.expected[status] : null;
    push('expected-' + status, actual, 1, '>=', '语料必须覆盖期望 ' + status + '（含负向自检）');
  }
  const levels = metrics && Array.isArray(metrics.oracleLevels) ? metrics.oracleLevels : [];
  for (const level of thresholds.requiredOracleLevels) {
    checks.push({
      id: 'oracle-' + level,
      actual: levels.includes(level) ? 1 : 0,
      limit: 1,
      comparator: '>=',
      ok: levels.includes(level),
      detail: '本轮必须实际执行 oracle level ' + level + '（只声明不执行不算）',
    });
  }
  const failures = checks.filter((check) => !check.ok).map((check) => check.id);
  return {
    ok: failures.length === 0 && validated.ok,
    exitCode: failures.length === 0 && validated.ok ? 0 : 1,
    thresholds,
    thresholdProblems: validated.problems,
    checks,
    failures,
  };
}

/** 报告/日志统一的数值格式：n/a 或三位小数。 */
export function formatMetric(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return Number(value).toFixed(3);
}

/** 三态矩阵渲染成 markdown 表格行（供报告与测试复用）。 */
export function renderMatrixRows(matrix) {
  const rows = [];
  for (const expected of EXPECTED_STATUSES) {
    const cells = EXPECTED_STATUSES.map((actual) => String((matrix && matrix[expected] && matrix[expected][actual]) || 0));
    rows.push('| ' + expected + ' | ' + cells.join(' | ') + ' |');
  }
  return rows;
}
