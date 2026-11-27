// tests/unit/quality-run.test.mjs —— 门禁入口的真实 CLI 集成测试。
//
// 这些测试走 `node tools/quality/run.mjs` 子进程（不是直接 import），
// 覆盖任务要求的"被 node tools/quality/run.mjs --check 真实消费"：
// 退出码、确定性输出、消费点 file:line、--gate 过滤、子进程指纹模式、报告落盘。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  assertReportShape,
  findingById,
  parseStdoutJson,
  runQualityCli,
  runQualityJson,
  tempDir,
} from '../../tools/quality/lib/testkit.mjs';
import { assertLocationContains } from '../../tools/quality/lib/consumers.mjs';
import { verifyDigest } from '../../tools/quality/lib/result.mjs';

test('run.mjs --check --json：退出码 0、报告结构/digest 自校验、verdict=PASS', () => {
  const run = runQualityCli(['--check', '--json']);
  assert.equal(run.status, 0, 'stderr=' + run.stderr);
  const report = parseStdoutJson(run);
  assertReportShape(assert, report);
  assert.equal(report.summary.verdict, 'PASS');
  assert.equal(report.gate.mode, 'check');
  assert.equal(report.gate.seed, 'quality-12');
  assert.equal(report.gate.repeats, 5);
  assert.equal(report.gate.timeoutMs, 15000);
  assert.deepEqual(report.gate.allGates, ['determinism', 'idempotency', 'explainability', 'antifragility']);
  assert.equal(report.gates.length, 5); // 4 个 gate + 消费点门禁
  const gateIds = report.gates.map((gate) => gate.id);
  for (const gate of ['determinism', 'idempotency', 'explainability', 'antifragility', 'consumption']) {
    assert.ok(gateIds.includes(gate), '缺少 gate：' + gate);
  }
  assert.equal(report.explainability.taxonomyProblems, 0);
  assert.equal(report.explainability.qualityCodeProblems, 0);
  assert.ok(report.explainability.errorCodes >= 150);
  assert.ok(report.explainability.hintCoverage > 0 && report.explainability.hintCoverage <= 1);
  assert.equal(report.findings.every((finding) => finding.ok === true), true);
  assert.ok(report.summary.checks >= 50, '检查项过少：' + report.summary.checks);
});

test('run.mjs：报告自带运行时消费点 file:line，且行文本真实包含符号', () => {
  const report = runQualityJson(['--check', '--json']);
  assert.ok(report.runtime.length >= 65, '消费点过少：' + report.runtime.length);
  const gates = new Set(report.runtime.map((entry) => entry.gate));
  for (const gate of ['determinism', 'idempotency', 'explainability', 'antifragility', 'run']) {
    assert.ok(gates.has(gate), '消费点缺少 gate：' + gate);
  }
  const modules = new Set(report.runtime.map((entry) => entry.module));
  for (const module of ['lib/har-plan.mjs', 'lib/intent-ledger.mjs', 'lib/trace-budget.mjs', 'lib/error-codes.mjs', 'cli/lib/json-contract.mjs']) {
    assert.ok(modules.has(module), '消费点缺少模块：' + module);
  }
  for (const entry of report.runtime) {
    assert.match(entry.location, /^[^:]+:\d+$/);
    assert.match(entry.consumedAt, /^[^:]+:\d+$/);
    assert.equal(assertLocationContains(ROOT, entry.location, entry.symbol).ok, true, '定义行不含符号：' + entry.location);
    assert.equal(assertLocationContains(ROOT, entry.consumedAt, entry.symbol).ok, true, '调用行不含符号：' + entry.consumedAt);
  }
});

test('run.mjs --check --json：两次运行逐字节一致（确定性报告）', () => {
  const first = runQualityCli(['--check', '--json']);
  const second = runQualityCli(['--check', '--json']);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout, '两次 --check 输出不一致（报告含非确定因素）');
  const report = JSON.parse(first.stdout);
  assert.equal(verifyDigest(report).ok, true);
});

test('run.mjs --check：人类可读报告含结论/消费点/digest/selftest 建议', () => {
  const run = runQualityCli(['--check']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /BridgeDeck 质量门禁报告/);
  assert.match(run.stdout, /结论：PASS/);
  assert.match(run.stdout, /运行时消费点/);
  assert.match(run.stdout, /digest=[0-9a-f]{16}/);
  assert.match(run.stdout, /selftest 建议：.*run\.mjs --check/);
  assert.match(run.stdout, /\[determinism\]/);
  assert.match(run.stdout, /\[antifragility\]/);
});

test('run.mjs --quiet：单行结论，digest 与 JSON 报告一致', () => {
  const quiet = runQualityCli(['--check', '--quiet']);
  assert.equal(quiet.status, 0);
  const lines = quiet.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^quality verdict=PASS gates=5\/5 checks=\d+ blocking=0 warnings=0 seed=quality-12 repeats=5 digest=[0-9a-f]{16}$/);
  const json = runQualityJson(['--check', '--json']);
  assert.equal(lines[0].includes('digest=' + json.summary.digest), true);
});

test('run.mjs --list 与 --print-consumption：列出 gate 与真实消费点', () => {
  const list = runQualityCli(['--list']);
  assert.equal(list.status, 0);
  for (const gate of ['determinism', 'idempotency', 'explainability', 'antifragility']) assert.match(list.stdout, new RegExp(gate));
  assert.match(list.stdout, /消费：lib\//);
  const consumption = runQualityCli(['--print-consumption']);
  assert.equal(consumption.status, 0);
  assert.match(consumption.stdout, /运行时消费点（\d+ 条/);
  assert.match(consumption.stdout, /lib\/har-plan\.mjs:\d+ ← tools\/quality\//);
  assert.match(consumption.stdout, /!|problems=0/);
});

test('run.mjs --gate：只跑指定 gate，报告 requested/gates 一致', () => {
  const report = runQualityJson(['--check', '--gate', 'determinism', '--json']);
  assert.deepEqual(report.gate.requested, ['determinism']);
  const gateIds = report.gates.map((gate) => gate.id);
  assert.ok(gateIds.includes('determinism'));
  assert.ok(gateIds.includes('consumption'));
  assert.equal(gateIds.includes('antifragility'), false);
  assert.equal(report.findings.every((finding) => finding.gate !== 'antifragility'), true);
  assert.equal(report.summary.verdict, 'PASS');
  // 多个 --gate 与逗号分隔等价。
  const multi = runQualityJson(['--check', '--gate', 'determinism,idempotency', '--json']);
  assert.deepEqual(multi.gate.requested, ['determinism', 'idempotency']);
});

test('run.mjs --fingerprint-suite：同 seed 跨进程逐字节一致，alt seed 夹具不同', () => {
  const first = runQualityCli(['--fingerprint-suite', '--seed', 'integration', '--json']);
  const second = runQualityCli(['--fingerprint-suite', '--seed', 'integration', '--json']);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout);
  const suite = JSON.parse(first.stdout);
  assert.equal(suite.schema, 'bb.quality-fingerprint/1');
  assert.equal(suite.seed, 'integration');
  assert.match(suite.digest, /^[0-9a-f]{16}$/);
  assert.ok(Object.keys(suite.targets).length >= 15);
  const alt = JSON.parse(runQualityCli(['--fingerprint-suite', '--seed', 'integration-alt', '--json']).stdout);
  assert.notEqual(JSON.stringify(alt.fixtures), JSON.stringify(suite.fixtures));
  assert.equal(Object.values(alt.targets).every((entry) => entry.stable), true);
});

test('run.mjs 报告落盘：--out .json/.md 可写且内容自洽', () => {
  const temp = tempDir('quality-out-');
  try {
    const jsonPath = path.join(temp.dir, 'report.json');
    const jsonRun = runQualityCli(['--check', '--json', '--out', jsonPath]);
    assert.equal(jsonRun.status, 0);
    assert.equal(fs.existsSync(jsonPath), true);
    const written = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(verifyDigest(written).ok, true);
    const stdoutReport = JSON.parse(jsonRun.stdout);
    assert.equal(written.summary.digest, stdoutReport.summary.digest);

    const mdPath = path.join(temp.dir, 'report.md');
    const mdRun = runQualityCli(['--check', '--out', mdPath]);
    assert.equal(mdRun.status, 0);
    const markdown = fs.readFileSync(mdPath, 'utf8');
    assert.match(markdown, /^# BridgeDeck 质量门禁报告/m);
    assert.match(markdown, /## 运行时消费点/);
    assert.match(markdown, /## findings/);
    assert.equal(fs.readdirSync(temp.dir).length, 2);
  } finally {
    temp.cleanup();
  }
});

test('run.mjs 用法错误：未知参数/坏取值/未知 gate 退出码为 2', () => {
  const unknown = runQualityCli(['--nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知参数：--nope/);
  const badRepeats = runQualityCli(['--repeats', '1']);
  assert.equal(badRepeats.status, 2);
  assert.match(badRepeats.stderr, /--repeats/);
  const badTimeout = runQualityCli(['--timeout', '100']);
  assert.equal(badTimeout.status, 2);
  const unknownGate = runQualityCli(['--gate', 'ghost-gate', '--json']);
  assert.equal(unknownGate.status, 2);
  const conflict = runQualityCli(['--json', '--quiet']);
  assert.equal(conflict.status, 2);
  const help = runQualityCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--check/);
});

test('run.mjs 报告的一致性：gate checks 求和 = summary.checks，blockingIds = 阻断项 id', () => {
  const report = runQualityJson(['--check', '--json']);
  const sum = report.gates.reduce((total, gate) => total + gate.checks, 0);
  assert.equal(sum, report.summary.checks);
  const blocking = report.findings.filter((finding) => finding.ok === false && finding.severity === 'blocking').map((finding) => finding.id).sort();
  assert.deepEqual(blocking, report.summary.blockingIds);
  for (const gate of report.gates) {
    const gateFindings = report.findings.filter((finding) => finding.gate === gate.id);
    assert.equal(gateFindings.length, gate.checks);
    assert.equal(gateFindings.filter((finding) => finding.ok === false && finding.severity === 'blocking').length, gate.blocking);
  }
  // selftest 建议必须可直接执行。
  assert.equal(report.selftest.command, 'node tools/quality/run.mjs --check');
  assert.equal(report.selftest.consumedBy.includes('tests/unit/quality-run.test.mjs'), true);
  assert.equal(findingById(report, 'determinism/cross-process').ok, true);
  assert.equal(findingById(report, 'idempotency/cross-process-token').ok, true);
  assert.equal(findingById(report, 'antifragility/harness-timeout').ok, true);
  assert.equal(findingById(report, 'explainability/cli-render-real').ok, true);
});
