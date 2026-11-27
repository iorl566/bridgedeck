// tools/longtail/lib/budget.mjs —— 规模预设 + 预算判定（通过/警告/失败 + 失败原因码）。
//
// 设计要点：
//   1. 规模（fixture scale）与预算（budget）分离。smoke 是缩小夹具（单测用），default 是
//      任务要求的真实规模（≥1000 refs / ≥5MB HAR / ≥200 步 / ≥100 分片）。
//   2. 预算判定不只看时间：时间/内存是"性能预算"，计数/不变量是"正确性预算"。任何一项
//      失败都会给出稳定的原因码（FAILURE_CODES），报告与基线都按原因码聚合。
//   3. 阈值可以按比例放宽（--time-scale），但**计数下限不放宽**——否则"≥1000 refs"就失去意义。
//   4. 纯函数：evaluateBudget 不读环境变量、不读时钟；调用方把实测 metrics 传进来。

import { stableHash } from './prng.mjs';

export const BUDGET_VERSION = 1;

/** 规模预设。default 的数字即验收目标；smoke 用于单测和快速回归。 */
export const FIXTURE_SCALES = Object.freeze({
  smoke: Object.freeze({
    name: 'smoke',
    description: '缩小夹具（单测/快速回归，目标 < 2s）',
    page: Object.freeze({ refs: 320, depth: 10, frames: 6, subgraphNodes: 24 }),
    har: Object.freeze({ sources: 2, entriesPerSource: 80, bodyBytes: 1400, minBytes: 900_000 }),
    record: Object.freeze({ steps: 72, boundaries: 2, loops: 2, humanGates: 1 }),
    video: Object.freeze({ segments: 36, segmentBytes: 48_000, budgetBytes: 3_000_000 }),
  }),
  default: Object.freeze({
    name: 'default',
    description: '任务目标规模：≥1000 refs / ≥5MB HAR / ≥200 步 / ≥100 分片',
    page: Object.freeze({ refs: 1200, depth: 16, frames: 12, subgraphNodes: 48 }),
    har: Object.freeze({ sources: 4, entriesPerSource: 320, bodyBytes: 4200, minBytes: 5_000_000 }),
    record: Object.freeze({ steps: 240, boundaries: 6, loops: 5, humanGates: 4 }),
    video: Object.freeze({ segments: 120, segmentBytes: 48_000, budgetBytes: 12_000_000 }),
  }),
});

export const SCALE_NAMES = Object.freeze(Object.keys(FIXTURE_SCALES));

/** 解析规模名；未知名字直接抛错（拼错不应静默降级成 smoke）。 */
export function resolveScale(name = 'default') {
  const key = String(name || 'default');
  const scale = FIXTURE_SCALES[key];
  if (!scale) {
    throw new Error('未知 longtail 规模：' + key + '（可选：' + SCALE_NAMES.join('/') + '）');
  }
  return scale;
}

// ---------------------------------------------------------------------------
// 失败原因码
// ---------------------------------------------------------------------------

export const FAILURE_CODES = Object.freeze({
  ERROR: 'scenario-error',
  TIME: 'time-budget-exceeded',
  TIME_WARN: 'time-warning',
  MEMORY: 'memory-budget-exceeded',
  MIN: 'metric-below-minimum',
  MAX: 'metric-above-maximum',
  EQUAL: 'metric-mismatch',
  RANGE: 'metric-out-of-range',
  TRUTHY: 'invariant-failed',
  EXISTS: 'metric-missing',
  FINGERPRINT: 'fingerprint-drift',
  EVIDENCE: 'evidence-missing',
});

const FAILURE_MESSAGES = Object.freeze({
  [FAILURE_CODES.ERROR]: '场景执行抛错（见 error 字段）',
  [FAILURE_CODES.TIME]: '实测耗时超过性能预算',
  [FAILURE_CODES.TIME_WARN]: '实测耗时进入警告区间',
  [FAILURE_CODES.MEMORY]: '实测内存增量超过内存预算',
  [FAILURE_CODES.MIN]: '规模/计数低于验收下限',
  [FAILURE_CODES.MAX]: '产物体积/计数超过上限',
  [FAILURE_CODES.EQUAL]: '实测值与预期不一致（确定性/语义被破坏）',
  [FAILURE_CODES.RANGE]: '实测值不在预期区间',
  [FAILURE_CODES.TRUTHY]: '不变量为假',
  [FAILURE_CODES.EXISTS]: '缺少必需指标',
  [FAILURE_CODES.FINGERPRINT]: '夹具/产物指纹与基线不一致（生成器漂移）',
  [FAILURE_CODES.EVIDENCE]: '缺少真实模块消费证据',
});

/** 原因码 → 中文解释。 */
export function describeFailure(code) {
  return FAILURE_MESSAGES[code] || '未知失败原因：' + String(code);
}

// ---------------------------------------------------------------------------
// 预算规格
// ---------------------------------------------------------------------------

export const CHECK_KINDS = Object.freeze(['min', 'max', 'equal', 'truthy', 'range', 'exists']);
export const CHECK_SEVERITIES = Object.freeze(['error', 'warning']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 按点路径读取指标：'graph.nodes' / 'modules.vomGraph.ms'。 */
export function readMetric(metrics, pathText) {
  if (!isPlainObject(metrics)) return undefined;
  if (typeof pathText !== 'string' || pathText === '') return metrics;
  let current = metrics;
  for (const part of pathText.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function normalizeCheck(check, index) {
  if (!isPlainObject(check)) throw new Error('budget.checks[' + index + '] 必须是对象');
  const name = String(check.name || check.metric || 'check-' + index);
  const kind = String(check.kind || 'max');
  if (!CHECK_KINDS.includes(kind)) throw new Error('非法 check.kind：' + kind + '（' + name + '）');
  const severity = String(check.severity || 'error');
  if (!CHECK_SEVERITIES.includes(severity)) throw new Error('非法 check.severity：' + severity + '（' + name + '）');
  const normalized = {
    name,
    metric: String(check.metric || name),
    kind,
    severity,
    unit: String(check.unit || ''),
    reason: String(check.reason || name),
  };
  if (kind === 'range') {
    if (!Number.isFinite(Number(check.min)) || !Number.isFinite(Number(check.max))) {
      throw new Error('range check 需要 min/max：' + name);
    }
    normalized.min = Number(check.min);
    normalized.max = Number(check.max);
  } else if (kind === 'truthy' || kind === 'exists') {
    normalized.limit = null;
  } else {
    if (!Number.isFinite(Number(check.limit))) throw new Error('check 需要数值 limit：' + name);
    normalized.limit = Number(check.limit);
  }
  return normalized;
}

/** 校验并归一预算规格（深层只读）。 */
export function normalizeBudget(spec, label = 'budget') {
  if (!isPlainObject(spec)) throw new Error(label + ' 必须是对象');
  const rawTimeMs = Number(spec.timeMs);
  const rawTimeWarnMs = Number(spec.timeWarnMs);
  const rawMemoryMb = Number(spec.memoryMb);
  const timeMs = rawTimeMs > 0 ? rawTimeMs : 0;
  const timeWarnMs = rawTimeWarnMs > 0 ? rawTimeWarnMs : 0;
  const memoryMb = rawMemoryMb > 0 ? rawMemoryMb : 0;
  const checks = Array.isArray(spec.checks) ? spec.checks.map((check, index) => normalizeCheck(check, index)) : [];
  if (timeMs > 0 && timeWarnMs > 0 && timeWarnMs > timeMs) {
    throw new Error(label + ' 的 timeWarnMs 不能大于 timeMs');
  }
  return Object.freeze({
    version: BUDGET_VERSION,
    label: String(spec.label || label),
    kind: String(spec.kind || 'custom'),
    timeMs,
    timeWarnMs,
    timeMetric: String(spec.timeMetric || 'timeMs'),
    memoryMb,
    memoryMetric: String(spec.memoryMetric || 'peakHeapUsedMb'),
    checks: Object.freeze(checks),
    fingerprint: stableHash({ timeMs, timeWarnMs, memoryMb, checks: checks.map((item) => [item.metric, item.kind, item.limit, item.min, item.max, item.severity]) }),
  });
}

// ---------------------------------------------------------------------------
// 预算判定
// ---------------------------------------------------------------------------

function makeResult(check, actual, ok, code, message) {
  return {
    name: check.name,
    metric: check.metric,
    kind: check.kind,
    severity: check.severity,
    unit: check.unit,
    actual: actual === undefined ? null : actual,
    limit: check.kind === 'range' ? [check.min, check.max] : (check.limit === undefined ? null : check.limit),
    ok,
    code: ok ? null : code,
    message: ok ? 'ok' : message,
  };
}

function evaluateCheck(check, metrics) {
  const actual = readMetric(metrics, check.metric);
  switch (check.kind) {
    case 'min': {
      const ok = Number.isFinite(Number(actual)) && Number(actual) >= check.limit;
      return makeResult(check, actual, ok, FAILURE_CODES.MIN, '实测 ' + actual + ' < 下限 ' + check.limit);
    }
    case 'max': {
      const ok = Number.isFinite(Number(actual)) && Number(actual) <= check.limit;
      return makeResult(check, actual, ok, FAILURE_CODES.MAX, '实测 ' + actual + ' > 上限 ' + check.limit);
    }
    case 'equal': {
      const ok = actual === check.limit || Number(actual) === check.limit;
      return makeResult(check, actual, ok, FAILURE_CODES.EQUAL, '实测 ' + String(actual) + ' ≠ 预期 ' + check.limit);
    }
    case 'truthy': {
      const ok = actual === true;
      return makeResult(check, actual, ok, FAILURE_CODES.TRUTHY, '不变量要求 true，实测 ' + String(actual));
    }
    case 'range': {
      const value = Number(actual);
      const ok = Number.isFinite(value) && value >= check.min && value <= check.max;
      return makeResult(check, actual, ok, FAILURE_CODES.RANGE, '实测 ' + String(actual) + ' 不在 [' + check.min + ', ' + check.max + ']');
    }
    case 'exists': {
      const ok = actual !== undefined && actual !== null && actual !== '';
      return makeResult(check, actual, ok, FAILURE_CODES.EXISTS, '缺少指标 ' + check.metric);
    }
    default:
      return makeResult(check, actual, false, FAILURE_CODES.EXISTS, '未知检查类型 ' + check.kind);
  }
}

/**
 * 判定一次场景实测是否在预算内。
 * @param {{budget:object, metrics:object, error?:object|null, evidence?:object|null}} input
 */
export function evaluateBudget({ budget, metrics, error = null, evidence = null } = {}) {
  const spec = budget && budget.__normalized === true ? budget : normalizeBudget(budget, 'budget');
  const checks = [];
  const failures = [];
  const warnings = [];

  if (error) {
    failures.push({ code: FAILURE_CODES.ERROR, message: describeFailure(FAILURE_CODES.ERROR), detail: error });
    return {
      version: BUDGET_VERSION,
      label: spec.label,
      kind: spec.kind,
      ok: false,
      level: 'fail',
      checks,
      failures,
      warnings,
      time: { actualMs: null, budgetMs: spec.timeMs, warnMs: spec.timeWarnMs, ok: false },
      memory: { actualMb: null, budgetMb: spec.memoryMb, ok: false },
    };
  }

  const values = isPlainObject(metrics) ? metrics : {};

  // 时间预算：低于 warnMs 通过；warnMs..timeMs 警告；> timeMs 失败。
  const actualMs = readMetric(values, spec.timeMetric);
  const time = { actualMs: actualMs === undefined ? null : Number(actualMs), budgetMs: spec.timeMs, warnMs: spec.timeWarnMs, ok: true };
  if (spec.timeMs > 0) {
    if (!Number.isFinite(time.actualMs)) {
      time.ok = false;
      failures.push({ code: FAILURE_CODES.TIME, message: '缺少时间指标 ' + spec.timeMetric });
    } else if (time.actualMs > spec.timeMs) {
      time.ok = false;
      failures.push({
        code: FAILURE_CODES.TIME,
        message: describeFailure(FAILURE_CODES.TIME) + '：' + time.actualMs + 'ms > ' + spec.timeMs + 'ms',
        metric: spec.timeMetric,
        actual: time.actualMs,
        limit: spec.timeMs,
      });
    } else if (spec.timeWarnMs > 0 && time.actualMs > spec.timeWarnMs) {
      warnings.push({
        code: FAILURE_CODES.TIME_WARN,
        message: describeFailure(FAILURE_CODES.TIME_WARN) + '：' + time.actualMs + 'ms > ' + spec.timeWarnMs + 'ms（未超 ' + spec.timeMs + 'ms）',
        actual: time.actualMs,
        limit: spec.timeWarnMs,
      });
    }
  }

  // 内存预算（默认按轮内 heap 峰值增量，绝对 rss 由场景另行给 max check）。
  const actualMb = readMetric(values, spec.memoryMetric);
  const memory = { actualMb: actualMb === undefined ? null : Number(actualMb), budgetMb: spec.memoryMb, ok: true };
  if (spec.memoryMb > 0) {
    if (!Number.isFinite(memory.actualMb)) {
      memory.ok = false;
      failures.push({ code: FAILURE_CODES.MEMORY, message: '缺少内存指标 ' + spec.memoryMetric });
    } else if (memory.actualMb > spec.memoryMb) {
      memory.ok = false;
      failures.push({
        code: FAILURE_CODES.MEMORY,
        message: describeFailure(FAILURE_CODES.MEMORY) + '：' + memory.actualMb + 'MB > ' + spec.memoryMb + 'MB',
        actual: memory.actualMb,
        limit: spec.memoryMb,
      });
    }
  }

  // 计数/不变量/证据检查。
  for (const check of spec.checks) {
    const result = evaluateCheck(check, values);
    checks.push(result);
    if (result.ok) continue;
    const item = {
      code: result.code,
      message: result.message,
      name: check.name,
      metric: check.metric,
      actual: result.actual,
      limit: result.limit,
      reason: check.reason,
    };
    if (check.severity === 'warning') warnings.push(item);
    else failures.push(item);
  }

  // 真实模块消费证据：至少一个模块/调用点，否则"真实消费"就是空话。
  if (evidence && evidence.realModuleCalls !== undefined) {
    const calls = Array.isArray(evidence.realModuleCalls) ? evidence.realModuleCalls : [];
    if (calls.length === 0) {
      failures.push({ code: FAILURE_CODES.EVIDENCE, message: describeFailure(FAILURE_CODES.EVIDENCE) });
    }
  }

  const level = failures.length ? 'fail' : (warnings.length ? 'warn' : 'pass');
  return {
    version: BUDGET_VERSION,
    label: spec.label,
    kind: spec.kind,
    ok: failures.length === 0,
    level,
    checks,
    failures,
    warnings,
    time,
    memory,
  };
}

/** 判定结果是否失败（error 级别）。 */
export function verdictFailed(verdict) {
  return !verdict || verdict.level === 'fail' || verdict.ok !== true;
}

/** 汇总多条判定。 */
export function summarizeVerdicts(verdicts) {
  const list = (Array.isArray(verdicts) ? verdicts : []).filter(Boolean);
  const counts = { pass: 0, warn: 0, fail: 0 };
  const byCode = {};
  for (const verdict of list) {
    counts[verdict.level] = (counts[verdict.level] || 0) + 1;
    for (const failure of verdict.failures || []) {
      byCode[failure.code] = (byCode[failure.code] || 0) + 1;
    }
    for (const warning of verdict.warnings || []) {
      byCode[warning.code] = (byCode[warning.code] || 0) + 1;
    }
  }
  return {
    total: list.length,
    pass: counts.pass,
    warn: counts.warn,
    fail: counts.fail,
    ok: counts.fail === 0,
    byCode,
  };
}

/** 退出码：场景错误永远 1；预算失败只在 --check 时 1。 */
export function deriveExitCode({ verdicts = [], errors = [], check = false } = {}) {
  if ((Array.isArray(errors) ? errors : []).length > 0) return 1;
  const list = (Array.isArray(verdicts) ? verdicts : []).filter(Boolean);
  if (check && list.some((verdict) => verdict.level === 'fail')) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// 阈值覆盖（CLI 放宽用；计数下限不参与）
// ---------------------------------------------------------------------------

/** 按比例放宽时间阈值（checks 里 unit=ms 的 max 检查一起放宽）。 */
export function scaleTimeBudget(budget, factor) {
  const spec = normalizeBudget(budget);
  const ratio = Number(factor);
  if (!Number.isFinite(ratio) || ratio <= 0) return spec;
  return normalizeBudget({
    ...spec,
    timeMs: spec.timeMs > 0 ? Math.round(spec.timeMs * ratio) : 0,
    timeWarnMs: spec.timeWarnMs > 0 ? Math.round(spec.timeWarnMs * ratio) : 0,
    checks: spec.checks.map((check) => (
      check.kind === 'max' && check.unit === 'ms' && Number.isFinite(check.limit)
        ? { ...check, limit: Math.round(check.limit * ratio) }
        : check
    )),
  });
}

/** 覆盖内存预算（MB）。 */
export function overrideMemoryBudget(budget, memoryMb) {
  const spec = normalizeBudget(budget);
  const value = Number(memoryMb);
  if (!Number.isFinite(value) || value <= 0) return spec;
  return normalizeBudget({ ...spec, memoryMb: value });
}

/** 一次性应用 CLI 覆盖：{timeScale, memoryMb}。 */
export function applyBudgetOverrides(budget, overrides = {}) {
  let spec = normalizeBudget(budget);
  if (overrides && Number.isFinite(Number(overrides.timeScale)) && Number(overrides.timeScale) > 0) {
    spec = scaleTimeBudget(spec, overrides.timeScale);
  }
  if (overrides && Number.isFinite(Number(overrides.memoryMb)) && Number(overrides.memoryMb) > 0) {
    spec = overrideMemoryBudget(spec, overrides.memoryMb);
  }
  return spec;
}

/** 预算规格指纹（基线里用来发现阈值被悄悄改动）。 */
export function budgetFingerprint(budget) {
  return stableHash({
    label: budget.label,
    timeMs: budget.timeMs,
    timeWarnMs: budget.timeWarnMs,
    timeMetric: budget.timeMetric,
    memoryMb: budget.memoryMb,
    memoryMetric: budget.memoryMetric,
    checks: (budget.checks || []).map((check) => [check.metric, check.kind, check.limit, check.min, check.max, check.severity]),
  });
}
