#!/usr/bin/env node
// tools/longtail/run.mjs —— 长尾/规模预算门禁入口（真实消费生成器 + 真实模块）。
//
// 用法：
//   node tools/longtail/run.mjs                      # 跑全部场景，打印人类可读报告（不因预算失败退出）
//   node tools/longtail/run.mjs --check              # 严格门禁：任何预算/不变量/指纹失败 → exit 1
//   node tools/longtail/run.mjs --check --json       # 同上，输出机器可读 JSON（CI/测试用）
//   node tools/longtail/run.mjs --scale=smoke        # 缩小夹具（单测/快速回归）
//   node tools/longtail/run.mjs --scenario=page-vom,har-merge
//   node tools/longtail/run.mjs --seed=12345         # 换 seed（指纹会变；基线对比会报漂移）
//   node tools/longtail/run.mjs --update-baseline    # 全绿后把阈值+参考实测+指纹写入 baseline.json
//   node tools/longtail/run.mjs --list               # 列出场景与规模目标
//   node tools/longtail/run.mjs --no-baseline        # 忽略 baseline.json（用内置阈值）
//
// 只有两类文件会落盘：
//   1. 大夹具 → os.tmpdir() 下的临时工作区（默认跑完即删，--keep-tmp 保留）；
//   2. 基线 tools/longtail/baseline.json（KB 级，--update-baseline 才写）。
//
// 退出码：0 = 通过；1 = 预算/不变量/场景错误；2 = 用法错误。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SEED } from './lib/prng.mjs';
import {
  FIXTURE_SCALES,
  SCALE_NAMES,
  applyBudgetOverrides,
  normalizeBudget,
  resolveScale,
} from './lib/budget.mjs';
import { nowMs } from './lib/measure.mjs';
import { isInsideRepo } from './lib/tmpdir.mjs';
import {
  assembleReport,
  baselineArtifact,
  diffBaseline,
  humanReport,
  readBaseline,
  reportExitCode,
  scenarioVerdict,
  writeBaseline,
} from './lib/report.mjs';
import * as pageScenario from './scenarios/page-vom.mjs';
import * as harScenario from './scenarios/har-merge.mjs';
import * as recordScenario from './scenarios/record-program.mjs';
import * as videoScenario from './scenarios/video-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LONGTAIL_DIR = path.resolve(HERE);
const DEFAULT_BASELINE = path.join(LONGTAIL_DIR, 'baseline.json');
const SCENARIO_MODULES = Object.freeze([pageScenario, harScenario, recordScenario, videoScenario]);

const USAGE = [
  '用法: node tools/longtail/run.mjs [--check] [--json] [--scale=smoke|default]',
  '       [--scenario=id[,id]] [--seed=N] [--baseline=path] [--no-baseline]',
  '       [--update-baseline] [--keep-tmp] [--time-scale=F] [--memory-mb=F]',
  '       [--out=path] [--verbose] [--list] [--help]',
].join('\n');

function usageError(message) {
  const error = new Error(message + '\n' + USAGE);
  error.code = 'E_USAGE';
  return error;
}

function parseNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 解析 CLI 参数；未知参数直接报错（不允许静默忽略）。 */
export function parseArgs(argv = []) {
  const options = {
    check: false,
    scale: 'default',
    seed: DEFAULT_SEED,
    scenarios: null,
    json: false,
    out: null,
    baseline: DEFAULT_BASELINE,
    useBaseline: true,
    updateBaseline: false,
    keepTmp: false,
    verbose: false,
    list: false,
    help: false,
    timeScale: 1,
    memoryMb: 0,
  };
  for (const arg of argv) {
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--update-baseline') options.updateBaseline = true;
    else if (arg === '--no-baseline') options.useBaseline = false;
    else if (arg === '--keep-tmp') options.keepTmp = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--scale=')) options.scale = arg.slice('--scale='.length);
    else if (arg.startsWith('--seed=')) {
      const raw = arg.slice('--seed='.length);
      options.seed = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    } else if (arg.startsWith('--scenario=')) {
      options.scenarios = arg.slice('--scenario='.length).split(',').map((item) => item.trim()).filter(Boolean);
    } else if (arg.startsWith('--baseline=')) options.baseline = arg.slice('--baseline='.length);
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg.startsWith('--time-scale=')) options.timeScale = parseNumber(arg.slice('--time-scale='.length), 1);
    else if (arg.startsWith('--memory-mb=')) options.memoryMb = parseNumber(arg.slice('--memory-mb='.length), 0);
    else throw usageError('未知参数：' + arg);
  }
  if (!SCALE_NAMES.includes(options.scale)) throw usageError('未知规模：' + options.scale);
  if (!(options.timeScale > 0)) throw usageError('--time-scale 必须 > 0');
  if (options.memoryMb < 0) throw usageError('--memory-mb 不能为负');
  return options;
}

/** 选择场景（保持注册顺序）。 */
export function selectScenarios(ids = null) {
  const wanted = Array.isArray(ids) && ids.length ? ids : null;
  if (!wanted) return SCENARIO_MODULES.slice();
  const byId = new Map(SCENARIO_MODULES.map((module) => [module.SCENARIO.id, module]));
  for (const id of wanted) {
    if (!byId.has(id)) throw usageError('未知场景：' + id + '（可选：' + [...byId.keys()].join(', ') + '）');
  }
  const wantedSet = new Set(wanted);
  return SCENARIO_MODULES.filter((module) => wantedSet.has(module.SCENARIO.id));
}

function describeScale(scale) {
  return 'page.refs=' + scale.page.refs
    + ' depth=' + scale.page.depth
    + ' frames=' + scale.page.frames
    + ' | har=' + scale.har.sources + '×' + scale.har.entriesPerSource + '≥' + scale.har.minBytes + 'B'
    + ' | record.steps=' + scale.record.steps
    + ' | video.segments=' + scale.video.segments;
}

function listScenarios() {
  console.log('Longtail 场景（' + SCENARIO_MODULES.length + '）：');
  for (const module of SCENARIO_MODULES) {
    console.log('  ' + module.SCENARIO.id.padEnd(16) + module.SCENARIO.title);
    console.log('    ' + 'requires: ' + module.SCENARIO.requires.join(', '));
  }
  console.log('');
  for (const name of SCALE_NAMES) {
    console.log('scale=' + name + ': ' + describeScale(FIXTURE_SCALES[name]));
  }
}

function guardOutPath(outPath) {
  const resolved = path.resolve(String(outPath));
  if (isInsideRepo(resolved) && !resolved.toLowerCase().startsWith(LONGTAIL_DIR.toLowerCase() + path.sep)) {
    throw usageError('--out 不允许写仓库内的路径（请写 tmpdir 或 tools/longtail/ 下）：' + resolved);
  }
  return resolved;
}

/**
 * 跑门禁（可被测试直接 import，不依赖 CLI 进程）。
 * @param {object} rawOptions parseArgs 的形状（或部分覆盖）
 * @returns {Promise<{report:object, exitCode:number, lines:string}>}
 */
export async function runGate(rawOptions = {}) {
  const options = { ...parseArgs([]), ...rawOptions };
  const scale = resolveScale(options.scale || 'default');
  const selected = selectScenarios(options.scenarios);
  const baselineState = options.useBaseline
    ? readBaseline(options.baseline)
    : { present: false, path: options.baseline || null, artifact: null, error: 'disabled' };
  // 只有"基线创建时的规模"与本次规模一致才复用基线阈值/指纹：
  // smoke 与 default 的计数下限不同，跨规模套用会把门禁变成假失败。
  const baselineMatchesScale = baselineState.present
    && baselineState.artifact.createdWith
    && baselineState.artifact.createdWith.scale === scale.name;
  const entries = [];
  const errors = [];
  const startedAt = nowMs();

  for (const module of selected) {
    const id = module.SCENARIO.id;
    const baseEntry = baselineMatchesScale && baselineState.artifact.scenarios
      ? baselineState.artifact.scenarios[id] || null
      : null;
    let budget = module.budgetFor(scale);
    if (baseEntry && baseEntry.budget) {
      try {
        budget = normalizeBudget(baseEntry.budget, id + '-baseline');
      } catch (error) {
        process.stderr.write('[longtail] 基线预算非法，回退内置阈值：' + id + '（' + error.message + '）\n');
        budget = module.budgetFor(scale);
      }
    }
    if (options.timeScale !== 1 || options.memoryMb > 0) {
      budget = applyBudgetOverrides(budget, { timeScale: options.timeScale, memoryMb: options.memoryMb });
    }

    let result;
    try {
      result = await module.run({ scale: scale.name, seed: options.seed, keepTmp: options.keepTmp === true });
    } catch (error) {
      errors.push({ id, title: module.SCENARIO.title, message: String((error && error.stack) || error) });
      result = {
        id,
        title: module.SCENARIO.title,
        scale: scale.name,
        seed: String(options.seed),
        ok: false,
        error: { name: (error && error.name) || 'Error', message: (error && error.message) || String(error) },
        metrics: {},
        evidence: { realModuleCalls: [] },
      };
    }
    const { verdict, fingerprint } = scenarioVerdict({
      result,
      budget,
      baselineEntry: baseEntry,
      checkFingerprint: options.check && baselineMatchesScale,
    });
    entries.push({
      id,
      title: module.SCENARIO.title,
      scale: result.scale || scale.name,
      seed: result.seed || String(options.seed),
      result,
      metrics: result.metrics || {},
      fixture: result.evidence && result.evidence.fixture ? result.evidence.fixture : null,
      verdict,
      budget,
      fingerprint,
    });
  }

  const durationMs = nowMs() - startedAt;
  const report = assembleReport({
    entries,
    scale: scale.name,
    seed: String(options.seed),
    mode: options.check ? 'check' : 'report',
    baselinePath: options.useBaseline ? options.baseline : null,
    baseline: { ...baselineState, present: baselineMatchesScale },
    drift: null,
    durationMs,
    errors,
  });
  const drift = baselineMatchesScale ? diffBaseline(report, baselineState) : null;
  report.baseline.drift = drift;
  if (options.check && drift && drift.drifts.some((item) => item.severity === 'error')) {
    report.errors.push({ id: 'baseline', title: '基线指纹', message: '夹具指纹与基线不一致：' + JSON.stringify(drift.drifts.filter((item) => item.severity === 'error')) });
    report.summary.errors = report.errors.length;
    report.summary.ok = false;
  }
  const lines = humanReport(report, { verbose: options.verbose === true });
  return { report, exitCode: reportExitCode(report, { check: options.check }), lines, drift, results: entries.map((entry) => entry.result) };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    console.log('');
    console.log('规模目标：');
    for (const name of SCALE_NAMES) console.log('  ' + name.padEnd(8) + describeScale(FIXTURE_SCALES[name]));
    return 0;
  }
  if (options.list) {
    listScenarios();
    return 0;
  }

  let outcome;
  try {
    outcome = await runGate(options);
  } catch (error) {
    process.stderr.write('长尾门禁执行失败：' + String((error && error.stack) || error) + '\n');
    return 2;
  }
  const { report, exitCode, lines, results } = outcome;

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(lines + '\n');
  }

  if (options.out) {
    try {
      const outPath = guardOutPath(options.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
      if (!options.json) process.stdout.write('report: ' + outPath + '\n');
    } catch (error) {
      process.stderr.write('写报告失败：' + String(error.message) + '\n');
      return 2;
    }
  }

  if (options.updateBaseline) {
    if (options.scale !== 'default') {
      process.stderr.write('只允许 default 规模更新基线（smoke 阈值仅供单测，写入会破坏 default 门禁）\n');
      return 2;
    }
    if (report.summary.fail > 0 || (report.errors || []).length > 0) {
      process.stderr.write('存在失败项，拒绝更新基线（先修到全绿再 --update-baseline）\n');
      return 1;
    }
    try {
      const artifact = baselineArtifact(report);
      const written = writeBaseline(options.baseline, artifact);
      process.stdout.write('baseline: ' + written.path + ' (' + written.bytes + 'B)\n');
    } catch (error) {
      process.stderr.write('写基线失败：' + String(error.message) + '\n');
      return 2;
    }
  }

  // 保留 tmp 时把目录打印出来（排查大夹具；默认跑完即删）。
  if (options.keepTmp) {
    for (const result of results) {
      if (result && result.tmpDir) process.stdout.write('tmp: ' + result.tmpDir + '\n');
    }
  }
  for (const error of report.errors) {
    process.stderr.write('[error] ' + String(error.id) + ': ' + String(error.message || '') + '\n');
  }
  return exitCode;
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(String((error && error.stack) || error) + '\n');
    process.exitCode = 2;
  });
}

export { USAGE, LONGTAIL_DIR, DEFAULT_BASELINE };
