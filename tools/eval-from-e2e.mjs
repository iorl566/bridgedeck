#!/usr/bin/env node
// tools/eval-from-e2e.mjs —— 用真实 E2E 执行 eval case 清单（127 条），并带上 capability/oracle level 元数据。
//
// 既有行为保持：
// - 解析 `PASS <id>.` / `FAIL <id>.` 行；缺失 case = unverified；未列入 case 的 E2E 失败单独报告；
// - --retry N（默认 1）：首轮失败会重跑，重跑通过则标记 flakyFirstRun 并把首轮失败原因打到 stderr；
// - 失败时退出码非 0。
//
// 新增（W6）：
// - --metadata <file>：tests/eval/cases/e2e-metadata.json（capability/oracleLevel/expectedStatus/evidenceRule）；
// - --print-metadata：不跑 E2E，只打印“清单 + 元数据”派生结果（可 --out 写文件），用于审计派生链路；
// - 三态指标（precision/recall/skipRate、fp/fn 分类）与阈值门禁：低于阈值同样退出码非 0；
// - payload 内每 case 带 capability/oracleLevel/expectedStatus/evidence 规则，便于报告聚合。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { judge } from '../lib/eval-oracle.mjs';
import {
  buildE2EMetadataPayload,
  DEFAULT_E2E_MANIFEST,
  DEFAULT_E2E_METADATA,
  loadE2EManifest,
  summarizeCases,
} from '../lib/eval-e2e.mjs';
import { findNonCaseFailures } from '../lib/eval-e2e-extra.mjs';
import {
  computeMetrics,
  evaluateGate,
  formatMetric,
  validateThresholds,
} from '../lib/eval-e2e-metrics.mjs';

export const DEFAULT_THRESHOLDS_PATH = path.join('tests', 'eval', 'thresholds.json');

function readThresholds(root, thresholdsPath) {
  const file = path.isAbsolute(thresholdsPath) ? thresholdsPath : path.join(root, thresholdsPath);
  if (!fs.existsSync(file)) return { file: null, thresholds: {} };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('阈值文件不是合法 JSON：' + file + '（' + (error && error.message) + '）');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('阈值文件需要 JSON 对象：' + file);
  const { schema, note, description, ...thresholds } = data;
  void schema;
  void note;
  void description;
  const validation = validateThresholds(thresholds);
  if (!validation.ok) throw new Error('阈值文件校验失败：' + validation.problems.join('；'));
  return { file, thresholds };
}

/** 汇总一次 E2E 运行：既有三态判定 + 新增 metrics/gate。 */
export function buildAttempt({ run, manifest, thresholds = {} }) {
  const output = [run.stdout || '', run.stderr || ''].join('\n');
  const results = parseResultsCompat(output);
  const { checks, unverified, entries } = summarizeCases(manifest.cases, results);
  const verdict = judge({ checks, unverified });
  const metrics = computeMetrics(entries);
  const gate = evaluateGate(metrics, thresholds);
  return {
    run,
    output,
    checks,
    entries,
    verdict,
    unverified: verdict.unverified,
    metrics,
    gate,
    failedE2e: findNonCaseFailures(manifest.cases, results),
  };
}

// 保持与旧实现同样的解析入口（单测通过 parseE2EResults 已覆盖；这里只做一次转调）。
function parseResultsCompat(output) {
  const results = new Map();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^\s*(PASS|FAIL)\s+([0-9A-Za-z_.-]+)\.\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, status, id, detail] = match;
    results.set(id, { id, ok: status === 'PASS', detail: detail.trim() });
  }
  return results;
}

function firstFailures(attempt) {
  return attempt.entries.filter((entry) => entry.status !== entry.expectedStatus);
}

/**
 * 跑 E2E + 判定（不含 console 输出）。runner 可注入，单测不需要真实浏览器。
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {string} [options.browser]
 * @param {number} [options.retries] 0..3，默认 1
 * @param {string} [options.manifestPath]
 * @param {string} [options.metadataPath]
 * @param {string} [options.thresholdsPath]
 * @param {Function} [options.runner] async ({browser}) => {status,stdout,stderr}
 */
export async function runE2EEvaluation(options = {}) {
  const root = options.root || process.cwd();
  const browser = options.browser || '';
  const retries = Math.max(0, Math.min(Number.isInteger(options.retries) ? options.retries : 1, 3));
  const manifest = loadE2EManifest({
    root,
    manifestPath: options.manifestPath || DEFAULT_E2E_MANIFEST,
    metadataPath: options.metadataPath || DEFAULT_E2E_METADATA,
  });
  const thresholdInfo = readThresholds(root, options.thresholdsPath || DEFAULT_THRESHOLDS_PATH);
  // E2E 语料全部声明 expectedStatus=passed（真实 E2E 的 FAIL 行就是失败），且必须保持 127 条规模：
  // 覆盖文件的 requiredStatuses/minCases/requiredOracleLevels，避免用 offline+dom 的门禁语义误判 E2E。
  const expectedStatuses = [...new Set(manifest.cases.map((item) => item.expectedStatus))].sort();
  const thresholdsForRun = {
    ...thresholdInfo.thresholds,
    requiredStatuses: expectedStatuses,
    minCases: Math.max(Number(thresholdInfo.thresholds.minCases) || 0, manifest.total),
    requiredOracleLevels: ['e2e-real'],
  };
  const runner = typeof options.runner === 'function' ? options.runner : defaultRunner(root, browser);
  const attempts = [];
  let final = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const run = await runner({ browser, attempt: attempt + 1, root });
    const current = buildAttempt({ run, manifest, thresholds: thresholdsForRun });
    attempts.push({
      attempt: attempt + 1,
      exitCode: run.status === undefined ? null : run.status,
      status: current.verdict.status,
      gateOk: current.gate.ok,
      failed: firstFailures(current),
      e2eFailures: current.failedE2e,
    });
    final = current;
    const e2eSucceeded = (run.status === null || run.status === undefined) ? false : run.status === 0;
    if (current.verdict.status === 'passed' && e2eSucceeded && current.gate.ok) break;
  }
  const first = attempts[0];
  const flakyFirstRun = attempts.length > 1 && (first.status !== 'passed' || first.gateOk !== true || first.e2eFailures.length > 0);
  const finalRun = final.run;
  const payload = {
    status: final.verdict.status,
    browser: browser || 'edge',
    checks: final.checks,
    unverified: final.verdict.unverified,
    exitCode: finalRun.status === undefined ? null : finalRun.status,
    attempts: attempts.length,
    flakyFirstRun,
    firstRunFailures: flakyFirstRun ? first.failed : [],
    firstRunE2eFailures: flakyFirstRun ? first.e2eFailures : [],
    metadata: {
      manifest: path.relative(root, manifest.manifestPath).replace(/\\/g, '/'),
      metadataFile: manifest.metadataPath ? path.relative(root, manifest.metadataPath).replace(/\\/g, '/') : null,
      total: manifest.total,
      fallbacks: manifest.fallbacks,
      warnings: manifest.warnings,
    },
    thresholds: {
      file: thresholdInfo.file ? path.relative(root, thresholdInfo.file).replace(/\\/g, '/') : null,
      values: thresholdsForRun,
    },
    metrics: {
      total: final.metrics.total,
      expected: final.metrics.expected,
      actual: final.metrics.actual,
      matrix: final.metrics.matrix,
      precision: final.metrics.precision,
      recall: final.metrics.recall,
      skipRate: final.metrics.skipRate,
      counts: final.metrics.counts,
      byCapability: final.metrics.byCapability,
      byOracleLevel: final.metrics.byOracleLevel,
      classification: final.metrics.classification,
    },
    gate: final.gate,
    cases: final.entries,
  };
  payload.ok = final.verdict.status === 'passed' && payload.exitCode === 0 && final.gate.ok;
  return { payload, attempts, final, manifest, thresholdInfo: { ...thresholdInfo, thresholds: thresholdsForRun } };
}

function defaultRunner(root, browser) {
  return async () => {
    const e2eArgs = [path.join(root, 'tools', 'e2e.mjs')];
    if (browser) e2eArgs.push('--browser', browser);
    const env = { ...process.env, BB_E2E_SYNC_DOCS: '0' };
    return spawnSync(process.execPath, e2eArgs, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  };
}

/** `--print-metadata`：派生“清单 + 元数据”结果（不执行 E2E）。 */
export function printMetadata(options = {}) {
  const root = options.root || process.cwd();
  const manifest = loadE2EManifest({
    root,
    manifestPath: options.manifestPath || DEFAULT_E2E_MANIFEST,
    metadataPath: options.metadataPath || DEFAULT_E2E_METADATA,
  });
  return {
    manifest,
    payload: {
      ...buildE2EMetadataPayload(manifest),
      metadataFile: manifest.metadataPath ? path.relative(root, manifest.metadataPath).replace(/\\/g, '/') : null,
      fallbacks: manifest.fallbacks,
      warnings: manifest.warnings,
    },
  };
}

function parseArgs(argv) {
  const options = { root: process.cwd(), retries: 1, browser: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error('参数 ' + arg + ' 缺少值');
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--browser') options.browser = next();
    else if (arg === '--retry') options.retries = Math.max(0, Math.min(Number(next()) || 0, 3));
    else if (arg === '--metadata') options.metadataPath = next();
    else if (arg === '--manifest') options.manifestPath = next();
    else if (arg === '--thresholds') options.thresholdsPath = next();
    else if (arg === '--print-metadata') options.printMetadata = true;
    else if (arg === '--out') options.out = next();
    else throw new Error('未知参数：' + arg);
  }
  return options;
}

function reportFailures(payload, attempts) {
  const gateFailures = payload.gate && payload.gate.failures ? payload.gate.failures : [];
  if (payload.flakyFirstRun) {
    console.error('EVAL WARN: 首轮失败、重试后通过（flake）；首轮失败：');
    for (const item of attempts[0].failed) console.error('  FAIL ' + item.id + ': ' + JSON.stringify(item.checks.filter((check) => check.ok === false)));
    for (const item of attempts[0].e2eFailures || []) console.error('  E2E-FAIL ' + item.id + ': ' + item.detail);
  }
  if (!payload.ok) {
    console.error('EVAL FAILED: status=' + payload.status + ' e2eExit=' + payload.exitCode + ' attempts=' + payload.attempts
      + ' gate=' + (payload.gate && payload.gate.ok ? 'PASS' : 'FAIL'));
    for (const item of payload.cases.filter((entry) => entry.status !== entry.expectedStatus)) {
      console.error('  MISMATCH ' + item.id + ': expected=' + item.expectedStatus + ' actual=' + item.status
        + ' capability=' + item.capability + ' oracle=' + item.oracleLevel);
    }
    for (const check of (payload.gate && payload.gate.checks ? payload.gate.checks : []).filter((item) => !item.ok)) {
      console.error('  GATE-FAIL ' + check.id + ': actual=' + check.actual + ' limit=' + check.comparator + ' ' + check.limit);
    }
  }
  const detail = payload.metrics ? {
    precision: formatMetric(payload.metrics.precision),
    recall: formatMetric(payload.metrics.recall),
    skipRate: formatMetric(payload.metrics.skipRate),
    counts: payload.metrics.counts,
  } : null;
  if (gateFailures.length && detail) console.error('  metrics=' + JSON.stringify(detail));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('用法：node tools/eval-from-e2e.mjs [--browser edge] [--retry N] [--metadata <file>]');
    console.log('      [--manifest <file>] [--thresholds <file>] [--print-metadata [--out <file>]]');
    return 0;
  }
  if (options.printMetadata) {
    const { payload } = printMetadata(options);
    const text = JSON.stringify(payload, null, 2) + '\n';
    if (options.out) {
      const file = path.isAbsolute(options.out) ? options.out : path.join(options.root, options.out);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
      console.log('metadata 派生结果已写入：' + file);
    } else {
      process.stdout.write(text);
    }
    console.log('metadata 派生：' + payload.count + ' case；fallbacks=' + payload.fallbacks + '；oracleLevel=' + payload.oracleLevel);
    return 0;
  }
  const { payload, attempts } = await runE2EEvaluation(options);
  console.log(JSON.stringify(payload, null, 2));
  reportFailures(payload, attempts);
  return payload.ok ? 0 : 1;
}

const IS_MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error('EVAL FROM E2E ERROR：' + ((error && error.message) || error));
    process.exitCode = 1;
  }
}
