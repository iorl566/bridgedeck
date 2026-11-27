#!/usr/bin/env node
// tools/quality/run.mjs —— BridgeDeck 质量门禁入口（零依赖）。
//
// 用法：
//   node tools/quality/run.mjs --check                 # 默认：跑全部 gate，PASS=exit 0 / 阻断=exit 1
//   node tools/quality/run.mjs --check --json          # 机器可读报告（stdout 只有这一份 JSON）
//   node tools/quality/run.mjs --check --quiet         # CI 单行结论
//   node tools/quality/run.mjs --check --gate determinism --gate antifragility
//   node tools/quality/run.mjs --check --seed quality-12 --repeats 7 --timeout 20000
//   node tools/quality/run.mjs --list                  # 列 gate 与消费点
//   node tools/quality/run.mjs --print-consumption     # 打印真实 file:line 消费点
//   node tools/quality/run.mjs --check --out report.md # 落盘 markdown 报告
//   node tools/quality/run.mjs --fingerprint-suite --seed X --json   # 子进程跨进程检查用
//
// 退出码：0 = PASS；1 = 存在 blocking finding；2 = 用法错误；3 = 门禁框架意外异常。
// 报告是确定性的：不含时间戳/耗时/绝对路径（便于两次运行逐字节比对与 CI 缓存）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATE as DETERMINISM_GATE, buildFingerprintSuite } from './gates/determinism.mjs';
import { GATE as IDEMPOTENCY_GATE } from './gates/idempotency.mjs';
import { GATE as EXPLAINABILITY_GATE, auditFindings } from './gates/explainability.mjs';
import { GATE as ANTIFRAGILITY_GATE } from './gates/antifragility.mjs';
import {
  attachDigest,
  configureSanitize,
  fail,
  makeFinding,
  sanitizeText,
  summarizeFindings,
  summarizeGate,
} from './lib/result.mjs';
import { createRegistry, listGates, runSuite } from './lib/registry.mjs';
import { collectConsumption, gatesWithoutConsumption } from './lib/consumers.mjs';
import { renderQuiet, renderReport } from './lib/render.mjs';
import { validateQualityCodes, validateTaxonomy } from './lib/taxonomy.mjs';
import { ERROR_CODES, ERROR_CODE_LIST, ERROR_RECOVERY } from '../../lib/error-codes.mjs';
import { QUALITY_CODE_LIST } from './lib/taxonomy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

export const REPORT_SCHEMA = 'bb.quality/1';
export const DEFAULT_SEED = 'quality-12';
export const DEFAULT_REPEATS = 5;
export const DEFAULT_TIMEOUT_MS = 15000;
export const MIN_REPEATS = 2;
export const MAX_REPEATS = 25;

const ALL_GATES = [DETERMINISM_GATE, IDEMPOTENCY_GATE, EXPLAINABILITY_GATE, ANTIFRAGILITY_GATE];

const HELP = `BridgeDeck 质量门禁（${REPORT_SCHEMA}）

用法：
  node tools/quality/run.mjs --check [选项]        运行全部 gate（默认动作）
  node tools/quality/run.mjs --list                列出 gate 与消费点
  node tools/quality/run.mjs --print-consumption   打印运行时消费点 file:line

选项：
  --check                 运行门禁（默认）
  --gate <id>             只跑指定 gate（可重复/逗号分隔）：determinism,idempotency,explainability,antifragility
  --seed <text>           夹具 seed（默认 ${DEFAULT_SEED}）；同 seed 跨进程必须一致
  --repeats <n>           每个确定性目标重复次数（${MIN_REPEATS}..${MAX_REPEATS}，默认 ${DEFAULT_REPEATS}）
  --timeout <ms>          单个 gate 超时（>=1000，默认 ${DEFAULT_TIMEOUT_MS}）
  --json                  输出确定性 JSON 报告（stdout 只有一份文档）
  --quiet                 CI 单行结论
  --md                    输出 markdown 报告
  --out <file>            把报告写到文件（.md → markdown，其余 → JSON）
  --verbose               额外把 gate 进度写到 stderr
  --fingerprint-suite     内部：只输出跨进程 fingerprint suite（供子进程校验）
  -h, --help              显示本帮助

退出码：0=PASS，1=blocking finding，2=用法错误，3=门禁框架异常。
`;

/** 解析 argv（纯函数，便于测试）。 */
export function parseArgs(argv = []) {
  const options = {
    action: 'check',
    gates: [],
    seed: DEFAULT_SEED,
    repeats: DEFAULT_REPEATS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    quiet: false,
    md: false,
    out: null,
    verbose: false,
    fingerprintSuite: false,
    help: false,
  };
  const errors = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = String(list[index]);
    switch (arg) {
      case '--check':
        options.action = 'check';
        break;
      case '--list':
        options.action = 'list';
        break;
      case '--print-consumption':
        options.action = 'consumption';
        break;
      case '--fingerprint-suite':
        options.fingerprintSuite = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--md':
        options.md = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--seed': {
        const value = list[index + 1];
        index += 1;
        if (value == null || String(value).trim() === '') errors.push('--seed 需要非空值');
        else options.seed = String(value).trim();
        break;
      }
      case '--repeats': {
        const value = Number(list[index + 1]);
        index += 1;
        if (!Number.isInteger(value) || value < MIN_REPEATS || value > MAX_REPEATS) {
          errors.push('--repeats 必须是 ' + MIN_REPEATS + '..' + MAX_REPEATS + ' 的整数');
        } else {
          options.repeats = value;
        }
        break;
      }
      case '--timeout': {
        const value = Number(list[index + 1]);
        index += 1;
        if (!Number.isFinite(value) || value < 1000) errors.push('--timeout 必须是 >=1000 的毫秒数');
        else options.timeoutMs = Math.floor(value);
        break;
      }
      case '--out': {
        const value = list[index + 1];
        index += 1;
        if (value == null || String(value).trim() === '') errors.push('--out 需要文件路径');
        else options.out = String(value).trim();
        break;
      }
      case '--gate': {
        const value = list[index + 1];
        index += 1;
        if (value == null || String(value).trim() === '') {
          errors.push('--gate 需要 gate id');
          break;
        }
        options.gates.push(...String(value).split(',').map((item) => item.trim()).filter(Boolean));
        break;
      }
      default:
        if (arg.startsWith('--gate=')) {
          options.gates.push(...arg.slice('--gate='.length).split(',').map((item) => item.trim()).filter(Boolean));
        } else {
          errors.push('未知参数：' + arg);
        }
    }
  }
  if (options.json && options.quiet) errors.push('--json 与 --quiet 互斥');
  if (options.json && options.md) errors.push('--json 与 --md 互斥');
  if (options.fingerprintSuite) options.action = 'fingerprint-suite';
  return { options, errors };
}

/** 选出要跑的 gate，并校验 --gate 过滤值。 */
export function selectGates(ids = []) {
  if (!ids.length) return { gates: ALL_GATES.slice(), unknown: [] };
  const wanted = new Set(ids);
  const known = new Set(ALL_GATES.map((gate) => gate.id));
  const unknown = [...wanted].filter((id) => !known.has(id));
  return { gates: ALL_GATES.filter((gate) => wanted.has(gate.id)), unknown };
}

function usageError(message) {
  return makeFinding({
    gate: 'run',
    id: 'run/usage',
    title: '命令行用法错误',
    ok: false,
    code: 'QUALITY_USAGE',
    detail: message,
    evidence: { message },
  });
}

/** 消费点核验：把 problems 变成 gate=consumption 的 blocking finding。 */
export function consumptionFindings(problems) {
  return (Array.isArray(problems) ? problems : []).map((problem, index) => fail('consumption', 'consumption/' + String(index + 1).padStart(3, '0'), '消费点漂移：' + String(problem.symbol || problem.module), {
    code: 'QUALITY_CONSUMPTION_DRIFT',
    category: 'consumption',
    retry: 'after-action',
    nextAction: '更新 tools/quality/lib/consumers.mjs 的声明或修复被引用符号，保证 file:line 真实可追溯',
    detail: String(problem.kind) + '：' + String(problem.detail || ''),
    evidence: { kind: problem.kind, gate: problem.gate, module: problem.module, symbol: problem.symbol },
  }));
}

/** 把 gate 执行结果 + 消费点 + explainability 审计合成最终报告。 */
export function buildReport({ gateResults, consumption, audit, options, gateIds }) {
  const findings = [];
  findings.push(...(gateResults.findings || []));
  findings.push(...consumptionFindings(consumption.problems));
  const missingConsumption = gatesWithoutConsumption(gateIds);
  for (const gate of missingConsumption) {
    findings.push(fail('consumption', 'consumption/' + gate, 'gate 没有登记运行时消费点：' + gate, {
      code: 'QUALITY_CONSUMPTION_DRIFT',
      category: 'consumption',
      retry: 'after-action',
      nextAction: '在 tools/quality/lib/consumers.mjs 为该 gate 登记真实消费点',
      detail: 'gate ' + gate + ' 没有出现在消费点表里（无法证明它真的调用了产品模块）',
      evidence: { gate },
    }));
  }
  findings.push(...audit);
  const gateIdsWithConsumption = gateIds.concat(['consumption']);
  const gateSummaries = [];
  for (const gateId of gateIds) {
    const gate = ALL_GATES.find((entry) => entry.id === gateId);
    const summary = summarizeGate(gateId, findings.filter((finding) => finding.gate === gateId));
    gateSummaries.push({
      ...summary,
      title: gate ? gate.title : gateId,
      consumes: gate && Array.isArray(gate.consumes) ? gate.consumes.slice() : [],
    });
  }
  const consumptionFindingsList = findings.filter((finding) => finding.gate === 'consumption');
  if (consumptionFindingsList.length || consumption.entries.length) {
    const summary = summarizeGate('consumption', consumptionFindingsList);
    gateSummaries.push({
      ...summary,
      title: '运行时消费点（gate 是否真实调用产品模块）',
      consumes: ['lib/**', 'cli/**'],
    });
  }
  const summary = summarizeFindings(findings);
  const taxonomyProblems = validateTaxonomy(ERROR_CODES, ERROR_RECOVERY);
  const explicitHints = Object.keys(ERROR_CODES).filter((code) => ERROR_RECOVERY[code] && ERROR_RECOVERY[code].hint).length;
  const report = {
    schema: REPORT_SCHEMA,
    gate: {
      mode: options.action,
      seed: String(options.seed),
      repeats: Number(options.repeats),
      timeoutMs: Number(options.timeoutMs),
      requested: options.gates.slice(),
      gates: gateIdsWithConsumption,
      allGates: ALL_GATES.map((gate) => gate.id),
    },
    gates: gateSummaries,
    findings,
    runtime: consumption.entries,
    explainability: {
      errorCodes: ERROR_CODE_LIST.length,
      explicitHints,
      hintCoverage: ERROR_CODE_LIST.length ? Number((explicitHints / ERROR_CODE_LIST.length).toFixed(3)) : 1,
      taxonomyProblems: taxonomyProblems.length,
      qualityCodes: QUALITY_CODE_LIST.length,
      qualityCodeProblems: validateQualityCodes().length,
    },
    summary,
    selftest: {
      command: 'node tools/quality/run.mjs --check',
      suggestion: '建议把 node tools/quality/run.mjs --check 加入 package.json 的 test 链与 CI（与其他 selftest 并列），阻断=exit 1',
      consumedBy: ['tests/unit/quality-run.test.mjs'],
    },
  };
  return attachDigest(report);
}

function writeOut(file, report, options) {
  const target = path.resolve(ROOT, file);
  const mode = path.extname(target).toLowerCase() === '.md' ? 'markdown' : 'json';
  fs.writeFileSync(target, renderReport(report, mode), 'utf8');
  return { target, mode };
}

function listReportText() {
  const lines = [];
  lines.push('gate 列表（' + ALL_GATES.length + '）：');
  for (const gate of listGates(ALL_GATES)) {
    lines.push('  - ' + gate.id + '：' + gate.title);
    lines.push('      消费：' + gate.consumes.join(', '));
  }
  return lines.join('\n') + '\n';
}

function printConsumptionText() {
  const consumption = collectConsumption(ROOT);
  const lines = [];
  lines.push('运行时消费点（' + consumption.entries.length + ' 条，problems=' + consumption.problems.length + '）：');
  for (const entry of consumption.entries) {
    lines.push('  - [' + entry.gate + '] ' + entry.symbol + ' @ ' + entry.location + ' ← ' + entry.consumedAt);
  }
  for (const problem of consumption.problems) {
    lines.push('  ! ' + problem.kind + ' [' + problem.gate + '] ' + problem.module + ':' + problem.symbol + ' —— ' + problem.detail);
  }
  return lines.join('\n') + '\n';
}

async function main(argv) {
  const { options, errors } = parseArgs(argv);
  configureSanitize({ root: ROOT, tmp: os.tmpdir() });

  if (errors.length) {
    const finding = usageError(errors.join('；'));
    const message = options.json
      ? JSON.stringify({ schema: REPORT_SCHEMA, ok: false, error: finding }, null, 2) + '\n'
      : '用法错误：' + errors.join('；') + '\n\n' + HELP;
    process.stderr.write(message);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.fingerprintSuite) {
    // 跨进程子进程模式：只输出 suite，不跑 gate（不递归 spawn）。
    const suite = buildFingerprintSuite({ seed: options.seed, repeats: options.repeats });
    process.stdout.write(JSON.stringify(suite) + '\n');
    return 0;
  }
  if (options.action === 'list') {
    process.stdout.write(listReportText());
    return 0;
  }
  if (options.action === 'consumption') {
    process.stdout.write(printConsumptionText());
    return 0;
  }

  const selected = selectGates(options.gates);
  if (selected.unknown.length) {
    const message = '未知 gate：' + selected.unknown.join(', ') + '（可用：' + ALL_GATES.map((gate) => gate.id).join(', ') + '）';
    if (options.json) {
      process.stdout.write(JSON.stringify({ schema: REPORT_SCHEMA, ok: false, error: usageError(message) }, null, 2) + '\n');
    } else {
      process.stderr.write('用法错误：' + message + '\n');
    }
    return 2;
  }
  if (!selected.gates.length) {
    process.stderr.write('用法错误：--gate 过滤后没有可执行的 gate\n');
    return 2;
  }

  const registry = createRegistry(selected.gates);
  const registryProblems = registry.problems();
  if (registryProblems.length) {
    process.stderr.write('门禁注册失败：' + registryProblems.join('；') + '\n');
    return 3;
  }
  const ctx = {
    root: ROOT,
    seed: options.seed,
    repeats: options.repeats,
    timeoutMs: options.timeoutMs,
    tmp: os.tmpdir(),
  };
  const gateResults = await runSuite({
    gates: registry.gates(),
    ctx,
    timeoutMs: options.timeoutMs,
  });
  if (options.verbose) {
    for (const summary of gateResults.gates) {
      const outcome = gateResults.outcomes.find((entry) => entry.gate === summary.id);
      process.stderr.write('[quality] ' + summary.id + ' checks=' + summary.checks + ' blocking=' + summary.blocking
        + ' outcome=' + (outcome ? outcome.outcome : '?') + '\n');
    }
  }
  const gateIds = selected.gates.map((gate) => gate.id);
  const consumption = collectConsumption(ROOT, { gates: gateIds.concat('run') });
  const audit = auditFindings([...gateResults.findings, ...consumptionFindings(consumption.problems)]);
  const report = buildReport({ gateResults, consumption, audit, options, gateIds });
  const mode = options.json ? 'json' : options.quiet ? 'quiet' : options.md ? 'markdown' : 'text';
  if (options.out) {
    try {
      writeOut(options.out, report, options);
    } catch (error) {
      const finding = makeFinding({
        gate: 'run',
        id: 'run/out-failed',
        title: '报告写入失败',
        ok: false,
        code: 'QUALITY_USAGE',
        detail: sanitizeText((error && error.message) || error),
        evidence: { out: options.out },
      });
      process.stderr.write('报告写入失败：' + finding.detail + '\n');
      return 2;
    }
  }
  process.stdout.write(renderReport(report, mode));
  return report.summary.verdict === 'PASS' ? 0 : 1;
}

const isEntry = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntry) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      configureSanitize({ root: ROOT, tmp: os.tmpdir() });
      const detail = sanitizeText((error && error.stack) || error, { max: 600 });
      const structured = {
        schema: REPORT_SCHEMA,
        ok: false,
        error: {
          code: 'QUALITY_GATE_THREW',
          category: 'harness',
          retry: 'no',
          nextAction: '门禁入口异常：按 stack 摘要修复后重跑（不要绕过门禁）',
          message: detail,
        },
      };
      process.stderr.write(JSON.stringify(structured, null, 2) + '\n');
      process.exitCode = 3;
    });
}
