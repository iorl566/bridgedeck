#!/usr/bin/env node
// tools/eval-fake.mjs —— 离线三态 eval 运行器：用 fake adapter 驱动插件工具，跑 tests/eval/cases/fake-core.json。
//
// 特点：
// - 不连 daemon、不起浏览器、不落盘（只读语料 + 内存）；默认语义即“离线”。
// - 每个 case 用 fake-adapter 脚本化响应/错误/延迟，插件工具的直连路径被完整执行。
// - 判定走 lib/eval-oracle.mjs 三态：passed / failed / unverified；缺证据一律降级 unverified。
// - case 声明 expect（期望三态）：实际与期望不符 → 退出码 1。
//   expect=failed 的 case 必须显式 negative=true，表示“负向自检”（验证 harness 真能抓失败），
//   它们的失败原因是可复现证据；未被期望的 failed 同样让退出码非 0。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge } from '../lib/eval-oracle.mjs';
import { buildToolSpecs } from '../dsh-plugin/lib/tools.mjs';
import { createFakeAdapter } from '../dsh-plugin/lib/fake-adapter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CASES_PATH = path.join(ROOT, 'tests', 'eval', 'cases', 'fake-core.json');
const EXPECTS = new Set(['passed', 'failed', 'unverified']);
const MODES = new Set(['tool', 'rpc']);

function readPath(value, dotted) {
  let current = value;
  for (const part of String(dotted).split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function clone(value) {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** 读取并校验语料；返回 case 数组（失败即抛错，避免静默跳过 case）。 */
export function loadCorpus(file = DEFAULT_CASES_PATH) {
  const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(cases) || !cases.length) throw new Error('eval 语料需要非空数组：' + file);
  const ids = new Set();
  for (const item of cases) {
    if (!item || typeof item !== 'object') throw new Error('eval case 需要对象');
    if (typeof item.id !== 'string' || !item.id) throw new Error('eval case 缺少 id');
    if (ids.has(item.id)) throw new Error('eval case id 重复：' + item.id);
    ids.add(item.id);
    if (!MODES.has(item.mode)) throw new Error(item.id + ' 的 mode 只能是 tool | rpc');
    if (!EXPECTS.has(item.expect)) throw new Error(item.id + ' 的 expect 只能是三态之一');
    if (item.expect === 'failed' && item.negative !== true) {
      throw new Error(item.id + '：expect=failed 必须显式 negative=true（负向自检）');
    }
    if (item.mode === 'tool' && (typeof item.tool !== 'string' || !item.tool)) throw new Error(item.id + ' 缺少 tool');
    if (item.mode === 'rpc' && (!item.rpc || typeof item.rpc.method !== 'string')) throw new Error(item.id + ' 缺少 rpc.method');
  }
  return cases;
}

/** 执行单个 case，返回三态判定与可复现证据。 */
export async function evaluateCase(item) {
  const adapter = createFakeAdapter(item.script || {});
  const cliCalls = [];
  const cli = item.cli && typeof item.cli === 'object' ? item.cli : {};
  const run = async (argv) => {
    cliCalls.push(argv);
    if (cli.error) {
      const error = new Error(String(cli.error.message || cli.error.code || 'CLI 失败'));
      error.code = String(cli.error.code || 'E_CLI');
      throw error;
    }
    return cli.result === undefined ? { ok: true, argv } : clone(cli.result);
  };
  const specs = buildToolSpecs(run, { rpc: adapter.call });

  let output = null;
  let error = null;
  try {
    if (item.mode === 'rpc') {
      const spec = item.rpc;
      output = await adapter.call(spec.method, spec.params || {}, { timeoutMs: spec.timeoutMs });
    } else {
      const tool = specs.find((candidate) => candidate.name === item.tool);
      if (!tool) throw new Error('语料引用了不存在的工具：' + item.tool);
      output = await tool.execute(item.args || {}, {});
    }
  } catch (caught) {
    error = caught;
  }

  const checks = [];
  if (item.expectError) {
    checks.push({
      id: item.id + ':error-code',
      ok: Boolean(error) && error.code === item.expectError,
      evidence: {
        expected: item.expectError,
        actual: error ? error.code || null : null,
        message: error ? String(error.message || '') : null,
      },
      evidenceRequired: true,
    });
  } else {
    checks.push({
      id: item.id + ':no-error',
      ok: !error,
      evidence: { error: error ? { code: error.code || null, message: String(error.message || error) } : null },
      evidenceRequired: true,
    });
  }
  for (const [dotted, expected] of Object.entries(item.assert || {})) {
    const actual = readPath(output, dotted);
    checks.push({
      id: item.id + ':' + dotted,
      ok: actual === expected,
      evidence: { path: dotted, expected, actual },
      evidenceRequired: true,
    });
  }
  for (const [dotted, needle] of Object.entries(item.contains || {})) {
    const actual = readPath(output, dotted);
    const text = typeof actual === 'string' ? actual : JSON.stringify(actual);
    checks.push({
      id: item.id + ':' + dotted,
      ok: text.includes(String(needle)),
      evidence: { path: dotted, needle, actual },
      evidenceRequired: true,
    });
  }

  // evidence 声明：缺任一证据 → unverified（不得算 pass）。
  const unverified = [];
  const evidence = {};
  const evidenceSource = error ? { error: { code: error.code || null, message: String(error.message || error) } } : output;
  for (const dotted of item.evidence || []) {
    const value = readPath(evidenceSource, dotted);
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      unverified.push({ id: item.id + ':' + dotted, reason: 'missing evidence' });
    } else {
      evidence[dotted] = value;
    }
  }

  const verdict = judge({ checks, unverified });
  return {
    id: item.id,
    title: item.title || '',
    mode: item.mode,
    expect: item.expect,
    negative: item.negative === true,
    status: verdict.status,
    counts: verdict.counts,
    checks,
    unverified: verdict.unverified,
    evidence,
    error: error ? { code: error.code || null, message: String(error.message || error) } : null,
    adapter: adapter.toJSON(),
    cliCalls,
  };
}

/** 批量执行语料并汇总三态计数。cases 可传数组或语料路径。 */
export async function runCorpus(casesOrFile = DEFAULT_CASES_PATH) {
  const cases = Array.isArray(casesOrFile) ? casesOrFile : loadCorpus(casesOrFile);
  const results = [];
  for (const item of cases) results.push(await evaluateCase(item));
  const counts = { passed: 0, failed: 0, unverified: 0 };
  const expected = { passed: 0, failed: 0, unverified: 0 };
  for (const result of results) {
    counts[result.status] += 1;
    expected[result.expect] += 1;
  }
  const unexpected = results.filter((result) => result.status !== result.expect);
  return {
    cases,
    results,
    counts,
    expected,
    unexpected,
    ok: unexpected.length === 0,
  };
}

function failureEvidence(result) {
  const parts = [];
  for (const check of result.checks) {
    if (check.ok === false) parts.push(check.id + ' evidence=' + JSON.stringify(check.evidence));
  }
  for (const item of result.unverified) parts.push(item.id + ' reason=' + item.reason);
  return parts.join('；') || '无';
}

async function main() {
  const arg = process.argv[2];
  const file = arg && !arg.startsWith('-') ? path.resolve(arg) : DEFAULT_CASES_PATH;
  let report;
  try {
    report = await runCorpus(file);
  } catch (error) {
    console.error('EVAL FAKE ERROR：' + ((error && error.message) || error));
    process.exitCode = 1;
    return;
  }
  console.log('BridgeDeck fake-core eval（离线：fake adapter；不触碰真实 daemon/浏览器）');
  console.log('语料：' + path.relative(ROOT, file) + '（' + report.results.length + ' case）');
  for (const result of report.results) {
    const mark = result.status === result.expect ? 'PASS' : 'FAIL';
    const extra = result.error ? ' error=' + result.error.code : '';
    console.log(
      '  ' + mark + '  ' + result.id.padEnd(28) + result.status.padEnd(11) +
      'checks=' + result.checks.length + ' evidence=' + Object.keys(result.evidence).length + extra,
    );
  }
  const counts = report.counts;
  console.log('');
  console.log('三态计数：passed=' + counts.passed + ' failed=' + counts.failed + ' unverified=' + counts.unverified + ' 共 ' + report.results.length);
  console.log('期望矩阵：passed=' + report.expected.passed + ' failed=' + report.expected.failed + ' unverified=' + report.expected.unverified);
  const negative = report.results.filter((result) => result.expect === 'failed');
  if (negative.length) {
    console.log('负向自检（expect=failed，失败原因可复现）：');
    for (const result of negative) console.log('  ' + result.id + ' → ' + failureEvidence(result));
  }
  const failedUnexpected = report.unexpected.filter((result) => result.status === 'failed');
  if (failedUnexpected.length) {
    console.error('未期望的失败项：');
    for (const result of failedUnexpected) console.error('  ' + result.id + ' → ' + failureEvidence(result));
  }
  if (!report.ok) {
    console.error('FAKE EVAL FAILED：' + report.unexpected.length + ' 个 case 的三态与期望不符（' + report.unexpected.map((result) => result.id).join(', ') + '）');
    process.exitCode = 1;
    return;
  }
  console.log('FAKE EVAL PASS（未期望失败 0 项；unverified 不计入 pass）');
}

const IS_MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) await main();
