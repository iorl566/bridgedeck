// tools/longtail/lib/report.mjs —— 预算报告 / 基线读写 / 人类可读输出 / 退出码。
//
// 门禁的"结论"只在这里产生，避免 run.mjs 里散落判定逻辑：
//   - scenarioVerdict：场景实测 → 预算判定（+ 基线指纹漂移）；
//   - assembleReport：把各场景结果组装成稳定 JSON（供 CI/测试消费）；
//   - humanReport：一行场景摘要 + 失败原因 + 基线漂移；
//   - reportExitCode：--check 的退出码语义；
//   - baselineArtifact / readBaseline / writeBaseline：阈值与参考实测的持久化。
//
// 基线只存"阈值 + 参考实测 + 夹具指纹"，不存大夹具本身（大文件只在 tmpdir）。
// 指纹漂移是 error（生成器不可复现），时间/计数漂移只是 warning（机器/负载噪声）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableHash, stableStringify } from './prng.mjs';
import { FAILURE_CODES, budgetFingerprint, deriveExitCode, evaluateBudget, summarizeVerdicts } from './budget.mjs';
import { describeMemory, formatMs, roundMs } from './measure.mjs';

export const REPORT_VERSION = 1;
export const BASELINE_VERSION = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LONGTAIL_DIR = path.resolve(HERE, '..');

/** 报告里保留的参考指标（基线对比用；其余 metrics 仍会随场景一起输出）。 */
export const REFERENCE_METRICS = Object.freeze([
  'timeMs', 'generateMs', 'writeMs', 'readMs', 'persistMs', 'readbackMs',
  'mergeMs', 'validateMs', 'roundTripMs', 'attributionMs', 'fullAttributionMs',
  'graphMs', 'framesMs', 'relationsMs', 'depthMs', 'semanticMs', 'rankMs', 'budgetMs',
  'buildMs', 'preflightMs', 'diffMs', 'writeMs', 'scanMs', 'appendMs', 'sealMs', 'recoveryMs',
  'refs', 'nodes', 'edges', 'maxDepth', 'frames', 'relations', 'frameLinks', 'depthLinks',
  'sourceCount', 'sourceBytes', 'totalEntries', 'keptEntries', 'duplicates', 'conflicts',
  'steps', 'boundaries', 'segments', 'loops', 'humanGates', 'nonIdempotent',
  'totalBytes', 'checksumMatches', 'manifestSegments',
  'peakHeapUsedMb', 'peakRssMb',
]);

function pickReferenceMetrics(metrics) {
  const source = metrics && typeof metrics === 'object' ? metrics : {};
  const picked = {};
  for (const key of REFERENCE_METRICS) {
    if (source[key] === undefined) continue;
    picked[key] = source[key];
  }
  return picked;
}

/**
 * 场景结果 → 预算判定（可选叠加基线指纹检查）。
 * @param {{result:object, budget:object, baselineEntry?:object|null, checkFingerprint?:boolean}} input
 */
export function scenarioVerdict({ result, budget, baselineEntry = null, checkFingerprint = true } = {}) {
  const source = result && typeof result === 'object' ? result : {};
  const fingerprint = source.evidence && source.evidence.fixture ? source.evidence.fixture.fingerprint || null : null;
  if (source.ok !== true || source.error) {
    const verdict = evaluateBudget({ budget, metrics: {}, error: source.error || { message: '场景未成功执行' } });
    return { verdict, fingerprint, budget };
  }
  const verdict = evaluateBudget({ budget, metrics: source.metrics || {}, evidence: source.evidence || null });
  if (checkFingerprint && baselineEntry && baselineEntry.fingerprint && fingerprint && baselineEntry.fingerprint !== fingerprint) {
    verdict.failures.push({
      code: FAILURE_CODES.FINGERPRINT,
      message: '夹具指纹与基线不一致（同 seed 应完全可复现）：' + String(baselineEntry.fingerprint) + ' → ' + String(fingerprint),
      expected: baselineEntry.fingerprint,
      actual: fingerprint,
    });
    verdict.level = 'fail';
    verdict.ok = false;
  }
  return { verdict, fingerprint, budget };
}

/** 组装报告（纯函数；不影响判定）。 */
export function assembleReport({ entries, scale, seed, mode, baselinePath = null, baseline = null, drift = null, durationMs = 0, errors = [] } = {}) {
  const list = (Array.isArray(entries) ? entries : []).map((entry) => ({
    id: entry.id,
    title: entry.title || entry.id,
    scale: entry.scale,
    seed: entry.seed,
    ok: entry.verdict ? entry.verdict.ok === true && entry.verdict.level !== 'fail' : false,
    level: entry.verdict ? entry.verdict.level : 'fail',
    fingerprint: entry.fingerprint || null,
    budgetFingerprint: entry.budget ? budgetFingerprint(entry.budget) : null,
    budget: entry.budget ? {
      version: entry.budget.version || 1,
      label: entry.budget.label,
      kind: entry.budget.kind,
      timeMs: entry.budget.timeMs,
      timeWarnMs: entry.budget.timeWarnMs,
      timeMetric: entry.budget.timeMetric,
      memoryMb: entry.budget.memoryMb,
      memoryMetric: entry.budget.memoryMetric,
      checks: entry.budget.checks || [],
    } : null,
    verdict: entry.verdict || null,
    metrics: entry.metrics || {},
    fixture: entry.fixture || null,
  }));
  const summary = summarizeVerdicts(list.map((entry) => entry.verdict));
  const report = {
    version: REPORT_VERSION,
    generator: 'tools/longtail/run.mjs',
    mode: String(mode || 'report'),
    scale,
    seed: String(seed),
    durationMs: roundMs(durationMs),
    scenarios: list,
    summary: {
      ...summary,
      ok: summary.fail === 0 && (Array.isArray(errors) ? errors.length : 0) === 0,
      errors: Array.isArray(errors) ? errors.length : 0,
    },
    baseline: {
      version: BASELINE_VERSION,
      present: Boolean(baseline && baseline.present),
      path: baselinePath || null,
      drift: drift || null,
    },
    errors: Array.isArray(errors) ? errors : [],
  };
  return report;
}

/** 退出码：场景错误永远 1；预算失败只在 check 模式 1。 */
export function reportExitCode(report, { check = false } = {}) {
  const errors = report && Array.isArray(report.errors) ? report.errors : [];
  if (errors.length > 0) return 1;
  const list = report && Array.isArray(report.scenarios) ? report.scenarios : [];
  return deriveExitCode({ verdicts: list.map((entry) => entry.verdict), errors, check });
}

/** 一行场景摘要（人类可读输出）。 */
export function summarizeVerdictLine(entry) {
  const verdict = entry.verdict || {};
  const time = verdict.time && verdict.time.actualMs != null ? formatMs(verdict.time.actualMs) : 'time=n/a';
  const memory = describeMemory({ peakHeapUsedMb: entry.metrics && entry.metrics.peakHeapUsedMb, peakRssMb: entry.metrics && entry.metrics.peakRssMb });
  const checks = Array.isArray(verdict.checks) ? verdict.checks : [];
  const passed = checks.filter((check) => check.ok).length;
  const failed = (verdict.failures || []).length;
  const warned = (verdict.warnings || []).length;
  return '[' + String(verdict.level || 'fail').toUpperCase().padEnd(4) + '] '
    + String(entry.id).padEnd(16) + ' ' + time + ' ' + memory
    + '  checks=' + passed + '/' + checks.length
    + (failed ? ' failures=' + failed : '')
    + (warned ? ' warnings=' + warned : '');
}

/** 场景关键计数（第二行，便于一眼看到规模）。 */
export function summarizeMetricsLine(entry) {
  const metrics = entry.metrics || {};
  const keys = ['refs', 'edges', 'relations', 'frames', 'frameLinks', 'depthMaxDepth',
    'sourceBytes', 'totalEntries', 'keptEntries', 'duplicates', 'conflicts',
    'steps', 'boundaries', 'loops', 'humanGates',
    'segments', 'totalBytes', 'checksumMatches'];
  const parts = [];
  for (const key of keys) {
    if (metrics[key] === undefined) continue;
    parts.push(key + '=' + metrics[key]);
  }
  return parts.join(' ');
}

/** 人类可读报告文本。 */
export function humanReport(report, { verbose = false } = {}) {
  const lines = [];
  const summary = report.summary || {};
  lines.push('BridgeDeck 长尾/规模预算门禁 v' + REPORT_VERSION
    + '  mode=' + report.mode + ' scale=' + report.scale + ' seed=' + report.seed);
  lines.push('');
  for (const entry of report.scenarios || []) {
    lines.push(summarizeVerdictLine(entry));
    const metricsLine = summarizeMetricsLine(entry);
    if (metricsLine) lines.push('         ' + metricsLine);
    for (const failure of (entry.verdict && entry.verdict.failures) || []) {
      lines.push('         FAIL ' + failure.code + ': ' + failure.message);
    }
    for (const warning of (entry.verdict && entry.verdict.warnings) || []) {
      lines.push('         WARN ' + warning.code + ': ' + warning.message);
    }
    if (verbose) {
      for (const check of (entry.verdict && entry.verdict.checks) || []) {
        lines.push('         ' + (check.ok ? 'ok  ' : 'FAIL') + ' ' + check.name
          + (check.actual === null ? '' : ' actual=' + check.actual)
          + (check.limit === null ? '' : ' limit=' + JSON.stringify(check.limit)));
      }
    }
  }
  if (report.errors && report.errors.length) {
    lines.push('');
    for (const error of report.errors) lines.push('[ERROR] ' + String(error.id || 'run') + ': ' + String(error.message || error));
  }
  lines.push('');
  lines.push('SUMMARY: pass=' + (summary.pass || 0) + ' warn=' + (summary.warn || 0) + ' fail=' + (summary.fail || 0)
    + ' ok=' + (summary.ok === true) + ' duration=' + formatMs(report.durationMs));
  lines.push('baseline: ' + (report.baseline && report.baseline.present ? (report.baseline.path || 'present') : 'absent')
    + (report.baseline && report.baseline.drift ? ' drift=' + (report.baseline.drift.drifts ? report.baseline.drift.drifts.length : 0) : ''));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 基线：阈值 + 参考实测 + 夹具指纹
// ---------------------------------------------------------------------------

/** 从报告生成基线产物（--update-baseline 写盘内容）。 */
export function baselineArtifact(report) {
  const scenarios = {};
  for (const entry of report.scenarios || []) {
    scenarios[entry.id] = {
      fingerprint: entry.fingerprint || null,
      budgetFingerprint: entry.budgetFingerprint || null,
      budget: entry.budget ? normalizedBudgetOf(entry) : null,
      reference: pickReferenceMetrics(entry.metrics),
    };
  }
  return {
    version: BASELINE_VERSION,
    generator: 'tools/longtail/run.mjs',
    createdWith: { scale: report.scale, seed: report.seed },
    scenarios,
  };
}

function normalizedBudgetOf(entry) {
  const budget = entry.budget || {};
  return {
    version: 1,
    label: budget.label,
    kind: budget.kind,
    timeMs: budget.timeMs,
    timeWarnMs: budget.timeWarnMs,
    timeMetric: budget.timeMetric,
    memoryMb: budget.memoryMb,
    memoryMetric: budget.memoryMetric,
    checks: budget.checks || [],
  };
}

/** 读基线（不存在/损坏都返回 present:false，不抛）。 */
export function readBaseline(filePath) {
  if (!filePath) return { present: false, path: null, artifact: null, error: 'no-path' };
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const artifact = JSON.parse(text);
    if (!artifact || typeof artifact !== 'object' || !artifact.scenarios) {
      return { present: false, path: filePath, artifact: null, error: 'bad-shape' };
    }
    return { present: true, path: filePath, artifact, error: null };
  } catch (error) {
    const code = error && error.code === 'ENOENT' ? 'missing' : 'unreadable';
    return { present: false, path: filePath, artifact: null, error: code };
  }
}

/** 写基线（只允许写 tools/longtail 下的小 JSON；拒绝把基线写进仓库其他位置）。 */
export function writeBaseline(filePath, artifact) {
  const resolved = path.resolve(String(filePath || ''));
  const insideLongtail = resolved.toLowerCase().startsWith(LONGTAIL_DIR.toLowerCase() + path.sep);
  if (!insideLongtail) {
    throw new Error('基线只能写在 tools/longtail/ 下（实际：' + resolved + '）');
  }
  const text = JSON.stringify(artifact, null, 2) + '\n';
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, text, 'utf8');
  return { path: resolved, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * 与基线对比：指纹漂移 = error；时间/计数漂移 = warning。
 * 内存峰值与 <5ms 的极小时耗受进程状态/GC 噪声影响，不参与漂移（绝对上限另有 check）。
 * @returns {{present:boolean, ok:boolean, drifts:Array, missing:string[], extra:string[]}}
 */
export function diffBaseline(report, baseline) {
  if (!baseline || baseline.present !== true || !baseline.artifact) {
    return { present: false, ok: true, drifts: [], missing: [], extra: [] };
  }
  const expected = baseline.artifact.scenarios || {};
  const actual = new Map((report.scenarios || []).map((entry) => [entry.id, entry]));
  const drifts = [];
  const missing = [];
  const extra = [];
  const noisyMetrics = new Set(['peakHeapUsedMb', 'peakRssMb']);
  for (const [id, entry] of actual) {
    const base = expected[id];
    if (!base) {
      extra.push(id);
      continue;
    }
    if (base.fingerprint && entry.fingerprint && base.fingerprint !== entry.fingerprint) {
      drifts.push({ id, kind: 'fingerprint', severity: 'error', before: base.fingerprint, after: entry.fingerprint });
    }
    const reference = base.reference || {};
    for (const [metric, before] of Object.entries(reference)) {
      const after = entry.metrics ? entry.metrics[metric] : undefined;
      if (after === undefined || after === null || before === null) continue;
      if (typeof before !== 'number' || typeof after !== 'number') continue;
      if (noisyMetrics.has(metric)) continue;
      if (String(metric).endsWith('Ms')) {
        if (before < 5) continue;
        const ratio = before > 0 ? after / before : 1;
        if (ratio > 2.5 || ratio < 0.25) {
          drifts.push({ id, kind: 'timing', severity: 'warning', metric, before, after, ratio: Math.round(ratio * 100) / 100 });
        }
        continue;
      }
      if (before > 0) {
        const ratio = after / before;
        if (ratio > 1.4 || ratio < 0.6) {
          drifts.push({ id, kind: 'count', severity: 'warning', metric, before, after, ratio: Math.round(ratio * 100) / 100 });
        }
      }
    }
  }
  for (const id of Object.keys(expected)) {
    if (!actual.has(id)) missing.push(id);
  }
  const hasError = drifts.some((drift) => drift.severity === 'error');
  return {
    present: true,
    ok: !hasError && missing.length === 0,
    drifts,
    missing,
    extra,
    fingerprint: stableHash({ expected: Object.keys(expected).sort(), actual: [...actual.keys()].sort() }),
    expectedScenarioCount: Object.keys(expected).length,
    actualScenarioCount: actual.size,
  };
}

/** JSON 文本（稳定键序；测试/CI 直接比对结构）。 */
export function reportToJson(report) {
  return stableStringify(report);
}
