#!/usr/bin/env node
// tools/eval-report.mjs —— 跑分层 eval 语料，输出三态 JSON + Markdown 报告，并按阈值门禁给退出码。
//
// 分层（默认全部执行）：
//   offline —— fake adapter 驱动 DSH 插件工具（tests/eval/cases/fake-core.json + offline-extended.json）
//   dom     —— 真实 headless Chromium 事实（tests/eval/cases/dom-cases.json + tests/eval/dom/ 夹具）
//
// 判定：三态 passed/failed/unverified；unverified 永不算 pass。指标见 lib/eval-e2e-metrics.mjs：
// precision/recall/skipRate + fp/fn 分类；阈值见 tests/eval/thresholds.json。
//
// 退出码：0 = 门禁 PASS；1 = 语料跑通但门禁 FAIL（低于阈值/三态不符）；2 = 用法/语料/基础设施错误。
//
// 用法：
//   node tools/eval-report.mjs                          # 全量 offline+dom，写 .tmp/eval-report/
//   node tools/eval-report.mjs --offline-only           # 只跑离线层（明确放弃 DOM 证据）
//   node tools/eval-report.mjs --cases x.json --layer offline
//   node tools/eval-report.mjs --thresholds t.json --out out --no-write
//   node tools/eval-report.mjs --json j.json --md m.md --quiet
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CorpusError,
  loadCorpusLayers,
  loadPluginToolNames,
  runOfflineLayer,
  summarizeCorpus,
  validateResults,
} from '../lib/eval-e2e-corpus.mjs';
import { DomHarnessError, runDomLayer } from '../lib/eval-e2e-dom.mjs';
import {
  EXPECTED_STATUSES,
  computeMetrics,
  evaluateGate,
  formatMetric,
  renderMatrixRows,
  validateThresholds,
} from '../lib/eval-e2e-metrics.mjs';

export const REPORT_SCHEMA = 'bdeval-report/1';
export const DEFAULT_THRESHOLDS_PATH = 'tests/eval/thresholds.json';
export const DEFAULT_OUT_DIR = '.tmp/eval-report';
export const DEFAULT_LAYER_SPECS = Object.freeze([
  { layer: 'offline', file: 'tests/eval/cases/fake-core.json', legacy: true },
  { layer: 'offline', file: 'tests/eval/cases/offline-extended.json' },
  { layer: 'dom', file: 'tests/eval/cases/dom-cases.json' },
]);

/** 报告器自身的基础设施错误：退出码 2（区别于门禁失败 1）。 */
export class ReportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ReportError';
    this.code = details.code || 'E_EVAL_REPORT';
    this.details = details;
    this.exitCode = details.exitCode || 2;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 读取阈值文件；不存在时返回空对象（使用 lib 默认值），存在但非法时抛 ReportError。 */
export function loadThresholds(root, thresholdsPath = DEFAULT_THRESHOLDS_PATH) {
  const file = path.isAbsolute(thresholdsPath) ? thresholdsPath : path.join(root, thresholdsPath);
  if (!fs.existsSync(file)) return { file: null, thresholds: {}, problems: [] };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ReportError('阈值文件不是合法 JSON：' + file + '（' + (error && error.message) + '）', { code: 'E_EVAL_THRESHOLDS' });
  }
  if (!isPlainObject(data)) throw new ReportError('阈值文件需要 JSON 对象：' + file, { code: 'E_EVAL_THRESHOLDS' });
  const { schema, note, description, ...thresholds } = data;
  void schema;
  void note;
  void description;
  const validation = validateThresholds(thresholds);
  if (!validation.ok) {
    throw new ReportError('阈值文件校验失败：' + validation.problems.join('；'), {
      code: 'E_EVAL_THRESHOLDS',
      problems: validation.problems,
      file,
    });
  }
  return { file, thresholds, problems: [] };
}

function escapeCell(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function sortCases(results) {
  const order = { offline: 0, dom: 1, e2e: 2 };
  return [...results].sort((a, b) => {
    const layerDiff = (order[a.layer] ?? 9) - (order[b.layer] ?? 9);
    if (layerDiff !== 0) return layerDiff;
    return String(a.id).localeCompare(String(b.id));
  });
}

function compactCase(result) {
  return {
    id: result.id,
    title: result.title,
    layer: result.layer,
    source: result.source,
    capability: result.capability,
    oracleLevel: result.oracleLevel,
    expectedStatus: result.expectedStatus,
    status: result.status,
    negative: result.negative === true,
    evidenceRule: result.evidenceRule,
    checks: (result.checks || []).map((check) => ({
      id: check.id,
      status: check.status || (check.ok === true ? 'pass' : check.ok === false ? 'fail' : 'unverified'),
      ok: check.ok === true,
      reason: check.reason || null,
      evidence: check.evidence === undefined ? null : check.evidence,
    })),
    unverified: (result.unverified || []).map((item) => ({ id: item.id, reason: item.reason })),
    evidence: result.evidence || {},
    error: result.error || null,
    adapterCalls: Array.isArray(result.adapterCalls) ? result.adapterCalls : [],
    cliCalls: Array.isArray(result.cliCalls) ? result.cliCalls : [],
    durationMs: result.durationMs || 0,
  };
}

/**
 * 执行分层语料并生成报告对象（不写文件）。runner 可注入（单测不需要 dsh-plugin/浏览器）。
 * @param {object} [options]
 */
export async function runReport(options = {}) {
  const root = options.root || process.cwd();
  const includeDom = options.includeDom !== false && options.offlineOnly !== true;
  const layerFilter = Array.isArray(options.layerNames) && options.layerNames.length
    ? new Set(options.layerNames)
    : null;
  const specs = (Array.isArray(options.layerSpecs) ? options.layerSpecs : DEFAULT_LAYER_SPECS)
    .filter((spec) => (includeDom || spec.layer !== 'dom') && (!layerFilter || layerFilter.has(spec.layer)));
  if (!specs.length) throw new ReportError('没有可执行的语料层（检查 --layer/--offline-only）', { code: 'E_EVAL_NO_LAYERS' });

  const thresholdInfo = loadThresholds(root, options.thresholdsPath || DEFAULT_THRESHOLDS_PATH);
  const thresholdsOverride = { ...(thresholdInfo.thresholds || {}), ...(options.thresholdsOverride || {}) };
  if (options.offlineOnly === true) thresholdsOverride.requiredOracleLevels = [];
  const thresholdValidation = validateThresholds(thresholdsOverride);
  if (!thresholdValidation.ok) {
    throw new ReportError('阈值覆盖非法：' + thresholdValidation.problems.join('；'), { code: 'E_EVAL_THRESHOLDS' });
  }

  let knownTools = null;
  if (Object.prototype.hasOwnProperty.call(options, 'knownTools')) {
    knownTools = options.knownTools;
  } else if (specs.some((spec) => spec.layer === 'offline')) {
    try {
      knownTools = await loadPluginToolNames();
    } catch (error) {
      throw new ReportError('离线层需要 dsh-plugin/lib/tools.mjs，但加载失败：' + ((error && error.message) || error), {
        code: 'E_EVAL_PLUGIN_UNAVAILABLE',
      });
    }
  }

  let layers;
  try {
    layers = loadCorpusLayers(root, specs, { knownTools });
  } catch (error) {
    if (error instanceof CorpusError) throw new ReportError(error.message, { code: error.code, details: error.details });
    throw error;
  }
  const corpusSummary = summarizeCorpus(layers);

  const offlineRunner = typeof options.runners?.offline === 'function' ? options.runners.offline : runOfflineLayer;
  const domRunner = typeof options.runners?.dom === 'function' ? options.runners.dom : runDomLayer;
  const results = [];
  const layerRuns = [];
  for (const layer of layers) {
    const startedAt = Date.now();
    let layerResults;
    try {
      /* eslint-disable no-await-in-loop */
      layerResults = layer.layer === 'dom'
        ? await domRunner(layer.cases, { timeoutMs: options.domTimeoutMs, pagePath: options.domPagePath })
        : await offlineRunner(layer.cases, {});
      /* eslint-enable no-await-in-loop */
    } catch (error) {
      if (error instanceof DomHarnessError || error instanceof CorpusError) {
        throw new ReportError('执行 ' + layer.source + ' 失败：' + error.message, { code: error.code, details: error.details });
      }
      throw new ReportError('执行 ' + layer.source + ' 抛出异常：' + ((error && error.stack) || error), { code: 'E_EVAL_RUN' });
    }
    const normalized = layerResults.map((item) => ({ ...item, layer: item.layer || layer.layer, source: item.source || layer.source }));
    results.push(...normalized);
    layerRuns.push({
      layer: layer.layer,
      source: layer.source,
      file: path.relative(root, layer.file).replace(/\\/g, '/'),
      cases: layer.cases.length,
      durationMs: Date.now() - startedAt,
    });
  }

  const resultProblems = validateResults(results);
  if (resultProblems.length) {
    throw new ReportError('执行结果自检失败（' + resultProblems.length + ' 项）：' + resultProblems.join('；'), {
      code: 'E_EVAL_RESULT_INTEGRITY',
      problems: resultProblems,
    });
  }
  const cases = sortCases(results).map(compactCase);
  const metrics = computeMetrics(results);
  const gate = evaluateGate(metrics, thresholdValidation.thresholds);
  const generatedAt = options.now instanceof Date ? options.now.toISOString() : new Date().toISOString();
  return {
    schema: REPORT_SCHEMA,
    generatedAt,
    root,
    ok: gate.ok,
    exitCode: gate.ok ? 0 : 1,
    corpus: {
      total: corpusSummary.total,
      byLayer: corpusSummary.byLayer,
      byCapability: corpusSummary.byCapability,
      byOracleLevel: corpusSummary.byOracleLevel,
      byExpectedStatus: corpusSummary.byExpectedStatus,
      files: corpusSummary.files,
      runs: layerRuns,
    },
    thresholds: {
      file: thresholdInfo.file ? path.relative(root, thresholdInfo.file).replace(/\\/g, '/') : null,
      values: gate.thresholds,
      problems: gate.thresholdProblems,
      offlineOnly: options.offlineOnly === true,
    },
    metrics,
    gate: {
      ok: gate.ok,
      exitCode: gate.exitCode,
      checks: gate.checks,
      failures: gate.failures,
    },
    failures: metrics.classification,
    cases,
  };
}

function gateTable(report) {
  const lines = ['| 门禁项 | 实际 | 阈值 | 结果 | 说明 |', '| --- | ---: | ---: | --- | --- |'];
  for (const check of report.gate.checks) {
    const actual = typeof check.actual === 'number' && !Number.isInteger(check.limit) ? formatMetric(check.actual) : check.actual;
    lines.push('| ' + escapeCell(check.id) + ' | ' + escapeCell(actual) + ' | ' + escapeCell(check.limit)
      + ' | ' + (check.ok ? 'PASS' : '**FAIL**') + ' | ' + escapeCell(check.detail) + ' |');
  }
  return lines;
}

function metricsTable(report) {
  const value = (id) => {
    const check = report.gate.checks.find((item) => item.id === id);
    return check ? check.actual : null;
  };
  const rows = [
    ['precision', value('precision'), '>= ' + formatMetric(report.thresholds.values.minPrecision)],
    ['recall', value('recall'), '>= ' + formatMetric(report.thresholds.values.minRecall)],
    ['skipRate', value('skip-rate'), '<= ' + formatMetric(report.thresholds.values.maxSkipRate)],
    ['unverifiedRate', value('unverified-rate'), '<= ' + formatMetric(report.thresholds.values.maxUnverifiedRate)],
    ['falsePositives', report.metrics.counts.falsePositives, '<= ' + report.thresholds.values.maxFalsePositives],
    ['falseNegatives(fn+skip)', report.metrics.counts.falseNegatives, '<= ' + report.thresholds.values.maxFalseNegatives],
    ['skips', report.metrics.counts.skips, 'information'],
    ['missedNegatives', report.metrics.counts.missedNegatives, '<= ' + report.thresholds.values.maxMissedNegatives],
    ['unexpected', report.metrics.counts.unexpected, '<= ' + report.thresholds.values.maxUnexpected],
  ];
  const lines = ['| 指标 | 实际 | 门禁 |', '| --- | ---: | --- |'];
  for (const [name, actual, limit] of rows) {
    lines.push('| ' + name + ' | ' + (name.includes('Rate') || name === 'precision' || name === 'recall' ? formatMetric(actual) : escapeCell(actual)) + ' | ' + escapeCell(limit) + ' |');
  }
  return lines;
}

function groupTable(group, label) {
  const lines = ['| ' + label + ' | 总数 | tp | tn | tu | fp | fn | skip | precision | recall | skipRate |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const [name, item] of Object.entries(group)) {
    lines.push('| ' + escapeCell(name) + ' | ' + item.total + ' | ' + (item.outcomes.tp || 0) + ' | ' + (item.outcomes.tn || 0)
      + ' | ' + (item.outcomes.tu || 0) + ' | ' + item.falsePositives + ' | ' + item.falseNegatives + ' | '
      + (item.outcomes.skip || 0) + ' | ' + formatMetric(item.precision) + ' | ' + formatMetric(item.recall) + ' | '
      + formatMetric(item.skipRate) + ' |');
  }
  return lines;
}

function failureSection(report, key, title) {
  const items = (report.failures && report.failures[key]) || [];
  const lines = ['### ' + title + '（' + items.length + '）', ''];
  if (!items.length) {
    lines.push('无。');
    lines.push('');
    return lines;
  }
  lines.push('| case | layer | capability | 期望→实际 | 分类 | 证据/原因 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const item of items) {
    const evidence = item.evidence ? JSON.stringify(item.evidence) : item.reason || '';
    lines.push('| ' + escapeCell(item.id) + ' | ' + escapeCell(item.layer) + ' | ' + escapeCell(item.capability)
      + ' | ' + escapeCell((item.expectedStatus || '?') + '→' + (item.status || '?')) + ' | ' + escapeCell(item.category)
      + ' | ' + escapeCell(evidence) + ' |');
  }
  lines.push('');
  return lines;
}

/** 生成 Markdown 报告（纯函数，便于单测）。 */
export function renderMarkdown(report) {
  if (!report || report.schema !== REPORT_SCHEMA) throw new ReportError('renderMarkdown 需要 ' + REPORT_SCHEMA + ' 报告', { code: 'E_EVAL_REPORT_SHAPE' });
  const lines = [];
  lines.push('# BridgeDeck eval 三态报告');
  lines.push('');
  lines.push('- 结论：**' + (report.ok ? 'PASS' : 'FAIL') + '**（退出码 ' + report.exitCode + '）');
  lines.push('- 生成时间：' + report.generatedAt);
  lines.push('- 语料：' + report.corpus.total + ' case / ' + report.corpus.files.length + ' 个文件；oracle levels: '
    + Object.keys(report.corpus.byOracleLevel).join(', '));
  lines.push('- 阈值文件：' + (report.thresholds.file || '(内置默认)') + (report.thresholds.offlineOnly ? '（offline-only 模式：未要求 DOM 证据）' : ''));
  lines.push('');
  lines.push('## 1. 三态计数');
  lines.push('');
  lines.push('| 期望 \\ 实际 | passed | failed | unverified |');
  lines.push('| --- | ---: | ---: | ---: |');
  lines.push(...renderMatrixRows(report.metrics.matrix));
  lines.push('');
  lines.push('- 期望：' + EXPECTED_STATUSES.map((status) => status + '=' + report.metrics.expected[status]).join(' / '));
  lines.push('- 实际：' + EXPECTED_STATUSES.map((status) => status + '=' + report.metrics.actual[status]).join(' / '));
  lines.push('- unverified 永不算 pass；skip 计入 recall 的漏判。');
  lines.push('');
  lines.push('## 2. 指标与门禁');
  lines.push('');
  lines.push(...metricsTable(report));
  lines.push('');
  lines.push(...gateTable(report));
  lines.push('');
  lines.push('## 3. 分层统计');
  lines.push('');
  lines.push(...groupTable(report.metrics.byLayer, 'layer'));
  lines.push('');
  lines.push(...groupTable(report.metrics.byCapability, 'capability'));
  lines.push('');
  lines.push(...groupTable(report.metrics.byOracleLevel, 'oracle level'));
  lines.push('');
  lines.push('## 4. 失败 / 漏判明细（fp/fn/skip 分类）');
  lines.push('');
  lines.push(...failureSection(report, 'falsePositives', 'false positives（过度断言）'));
  lines.push(...failureSection(report, 'falseNegatives', 'false negatives（真实 pass 被判 failed）'));
  lines.push(...failureSection(report, 'skips', 'skips（期望 pass 但 unverified）'));
  lines.push(...failureSection(report, 'missedNegatives', 'missed negatives（期望 failed 但 unverified）'));
  lines.push(...failureSection(report, 'unexpectedFailures', 'unexpected failures（期望 unverified 却 failed）'));
  lines.push(...failureSection(report, 'invalid', 'invalid（非法三态/期望）'));
  lines.push('## 5. 每 case 证据');
  lines.push('');
  lines.push('| case | layer | capability | oracle | 期望 | 实际 | checks | 关键证据 | evidence 规则 |');
  lines.push('| --- | --- | --- | --- | --- | --- | ---: | --- | --- |');
  for (const item of report.cases) {
    const evidenceKeys = Object.keys(item.evidence || {});
    const failed = item.checks.filter((check) => check.ok === false);
    const keyEvidence = failed.length
      ? 'FAIL ' + failed.map((check) => check.id + '=' + JSON.stringify(check.evidence)).join(' ; ')
      : evidenceKeys.join(', ');
    lines.push('| ' + escapeCell(item.id) + ' | ' + escapeCell(item.layer) + ' | ' + escapeCell(item.capability)
      + ' | ' + escapeCell(item.oracleLevel) + ' | ' + escapeCell(item.expectedStatus) + ' | ' + escapeCell(item.status)
      + ' | ' + item.checks.length + ' | ' + escapeCell(keyEvidence) + ' | ' + escapeCell(item.evidenceRule) + ' |');
  }
  lines.push('');
  lines.push('## 6. 复现');
  lines.push('');
  lines.push('```powershell');
  lines.push('$env:ELECTRON_RUN_AS_NODE="1"');
  lines.push('& "D:\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe" tools/eval-report.mjs');
  lines.push('& "D:\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe" --test tests/unit/eval-*.test.mjs');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function consoleSummary(report) {
  const m = report.metrics;
  return [
    'BridgeDeck eval report（' + Object.keys(report.corpus.byOracleLevel).join(' + ') + '）',
    '语料：' + report.corpus.total + ' case / ' + report.corpus.files.length + ' 个文件'
      + '（期望 passed=' + m.expected.passed + ' failed=' + m.expected.failed + ' unverified=' + m.expected.unverified + '）',
    '三态计数：passed=' + m.actual.passed + ' failed=' + m.actual.failed + ' unverified=' + m.actual.unverified,
    '指标：precision=' + formatMetric(m.precision) + ' recall=' + formatMetric(m.recall)
      + ' skipRate=' + formatMetric(m.skipRate) + ' fp=' + m.counts.falsePositives + ' fn=' + m.counts.falseNegatives,
    '门禁：' + (report.ok ? 'PASS' : 'FAIL') + '（' + report.gate.checks.length + ' 项，失败 '
      + report.gate.failures.length + ' 项' + (report.gate.failures.length ? '：' + report.gate.failures.join(', ') : '') + '）',
  ];
}

/** CLI 入口：解析参数 → runReport → 控制台汇总 + 落盘 → 返回退出码。 */
export async function main(argv = process.argv.slice(2)) {
  const options = {
    root: process.cwd(),
    layerSpecs: DEFAULT_LAYER_SPECS.map((spec) => ({ ...spec })),
    includeDom: true,
    write: true,
    outDir: DEFAULT_OUT_DIR,
    jsonPath: null,
    mdPath: null,
    quiet: false,
  };
  const customSpecs = [];
  let layerNames = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new ReportError('参数 ' + arg + ' 缺少值', { code: 'E_EVAL_USAGE' });
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') return { exitCode: 0, help: true };
    else if (arg === '--cases') customSpecs.push({ layer: 'offline', file: next(), source: null });
    else if (arg === '--dom-cases') customSpecs.push({ layer: 'dom', file: next(), source: null });
    else if (arg === '--layer') layerNames.push(next());
    else if (arg === '--thresholds') options.thresholdsPath = next();
    else if (arg === '--out') options.outDir = next();
    else if (arg === '--json') options.jsonPath = next();
    else if (arg === '--md') options.mdPath = next();
    else if (arg === '--no-write') options.write = false;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--offline-only' || arg === '--no-dom') options.offlineOnly = true;
    else throw new ReportError('未知参数：' + arg + '（--help 查看用法）', { code: 'E_EVAL_USAGE' });
  }
  if (customSpecs.length) {
    options.layerSpecs = customSpecs;
    if (layerNames.length) options.layerNames = layerNames;
  } else if (layerNames.length) {
    options.layerNames = layerNames;
  }
  if (options.offlineOnly) options.includeDom = false;
  const report = await runReport(options);
  for (const line of consoleSummary(report)) console.log(line);
  for (const check of report.gate.checks.filter((item) => !item.ok)) {
    console.error('  GATE-FAIL ' + check.id + ': actual=' + check.actual + ' limit=' + check.comparator + ' ' + check.limit
      + (check.detail ? '（' + check.detail + '）' : ''));
  }
  const groups = [
    ['falsePositives', report.failures.falsePositives],
    ['falseNegatives', report.failures.falseNegatives],
    ['skips', report.failures.skips],
    ['missedNegatives', report.failures.missedNegatives],
    ['unexpectedFailures', report.failures.unexpectedFailures],
    ['invalid', report.failures.invalid],
  ];
  for (const [key, items] of groups) {
    if (!items.length) continue;
    console.error('  ' + key + '（' + items.length + '）：');
    for (const item of items) {
      console.error('    - ' + (item.id || '?') + ' [' + (item.category || '?') + '] ' + JSON.stringify(item.evidence || item.reason || ''));
    }
  }
  if (options.write) {
    const outDir = path.isAbsolute(options.outDir) ? options.outDir : path.join(options.root, options.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = options.jsonPath ? path.resolve(options.root, options.jsonPath) : path.join(outDir, 'eval-report.json');
    const mdPath = options.mdPath ? path.resolve(options.root, options.mdPath) : path.join(outDir, 'eval-report.md');
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
    report.files = { json: jsonPath, markdown: mdPath };
    if (!options.quiet) {
      console.log('报告：JSON ' + jsonPath);
      console.log('      Markdown ' + mdPath);
    }
  }
  console.log(report.ok ? 'EVAL REPORT PASS（unverified 不计入 pass）' : 'EVAL REPORT FAIL（门禁未通过，退出码 1）');
  return { exitCode: report.exitCode, report };
}

const IS_MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  try {
    const outcome = await main();
    if (outcome && outcome.help) {
      console.log('用法：node tools/eval-report.mjs [--cases <file>] [--dom-cases <file>] [--layer offline|dom]');
      console.log('      [--offline-only] [--thresholds <file>] [--out <dir>] [--json <file>] [--md <file>] [--no-write] [--quiet]');
      process.exitCode = 0;
    } else {
      process.exitCode = outcome.exitCode;
    }
  } catch (error) {
    console.error('EVAL REPORT ERROR：' + ((error && error.message) || error));
    if (error && error.details && error.details.details) console.error(JSON.stringify(error.details.details, null, 2));
    process.exitCode = (error && error.exitCode) || 2;
  }
}
