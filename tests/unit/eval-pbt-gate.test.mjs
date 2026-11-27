import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_AREAS, ROOT, assertLocationContains, parseLocation, runEvalCli, runEvalJson, tempDir } from '../eval/helpers.mjs';
import { verifyDigest, verifyReport } from '../../tools/eval/lib/report.mjs';

const GATE_ARGS = ['--check', '--cases', '8'];

test('门禁（真实子进程）：--check --json 退出码 0，报告 digest/结构自校验通过', () => {
  const report = runEvalJson(GATE_ARGS);
  assert.equal(report.schema, 'bridge-eval-report/1');
  assert.equal(verifyDigest(report).ok, true);
  assert.deepEqual(verifyReport(report), []);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.minimalityViolations, 0);
  assert.ok(report.summary.properties >= 100, 'property 数不足：' + report.summary.properties);
  assert.ok(report.summary.checks >= report.summary.properties * 8, 'checks 数不足');
  assert.equal(report.determinism.verified, true);
  assert.equal(report.gate.mode, 'check');
  assert.equal(report.gate.ok, true);
  assert.deepEqual(report.gate.coverageIssues, []);
  assert.deepEqual(report.gate.replayIssues, []);
  assert.equal(report.audits.forbiddenCalls.length, 0);
  assert.ok(report.audits.filesScanned >= 15, '确定性审计文件数过少');
});

test('门禁：五个必需 area 全部出现且 property/checks 计数自洽', () => {
  const report = runEvalJson(GATE_ARGS);
  const areaNames = report.areas.map((area) => area.area);
  for (const area of REQUIRED_AREAS) assert.equal(areaNames.includes(area), true, '报告缺少 area：' + area);
  assert.equal(areaNames.includes('eval-kernel'), true);
  for (const area of report.areas) {
    assert.equal(area.passed + area.failed, area.properties, area.area + ' 的通过/失败计数不符');
    assert.equal(area.properties > 0, true, area.area + ' 没有 property');
  }
  const propertySum = report.areas.reduce((sum, area) => sum + area.properties, 0);
  assert.equal(propertySum, report.summary.properties);
  const checkSum = report.areas.reduce((sum, area) => sum + area.checks, 0);
  assert.equal(checkSum, report.summary.checks);
});

test('门禁：runtime 消费点全部是真实的 file:line（行文本含符号）', () => {
  const report = runEvalJson(GATE_ARGS);
  assert.ok(report.runtime.length >= 40, 'runtime 消费点过少：' + report.runtime.length);
  const files = new Set();
  for (const entry of report.runtime) {
    assert.match(entry.location, /^[^:]+:\d+$/, '不是 file:line：' + entry.location);
    const parsed = parseLocation(entry.location);
    assert(parsed, 'location 解析失败：' + entry.location);
    assert(parsed.line >= 1);
    files.add(entry.file);
    assert(Array.isArray(entry.properties) && entry.properties.length > 0, '消费点没有 property：' + entry.location);
    assert.ok(entry.checks >= entry.properties.length, 'checks 计数异常：' + entry.location);
    // The strongest assertion: the cited line really contains the symbol today.
    assertLocationContains(entry.location, entry.symbol);
  }
  assert.ok(files.has('lib/session-queue.mjs'), '缺少 session-queue 运行时消费点');
  assert.ok(files.has('lib/observe-diff.mjs') || files.has('lib/observation-delta.mjs'), '缺少 diff 运行时消费点');
  assert.ok(files.has('lib/intent-ledger.mjs'), '缺少 ledger 运行时消费点');
  assert.ok(files.has('lib/method-state-machine.mjs'), '缺少状态机运行时消费点');
  assert.ok([...files].some((file) => file.startsWith('extension/src/lib/vom-')), '缺少 VOM 运行时消费点');
});

test('门禁：两次 --check 报告逐字节一致（digest 相同）', () => {
  const first = runEvalCli([...GATE_ARGS, '--json']);
  const second = runEvalCli([...GATE_ARGS, '--json']);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout, '两次运行 stdout 不一致');
  const report = JSON.parse(first.stdout);
  assert.equal(verifyDigest(report).ok, true);
});

test('门禁：--quiet 输出 PASS，--list 列出 property 与消费点', () => {
  const quiet = runEvalCli([...GATE_ARGS, '--quiet']);
  assert.equal(quiet.status, 0);
  assert.match(quiet.stdout, /verdict=PASS/);
  assert.match(quiet.stdout, /digest=\d+/);
  const list = runEvalCli(['--list']);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /observed-diff|observe-diff\/apply-roundtrip/);
  assert.match(list.stdout, /runtime: .+:\d+/);
  assert.match(list.stdout, /\[vom-geometry\]/);
});

test('门禁：--property / --area 过滤子集，报告保持结构合法', () => {
  const single = runEvalJson(['--property', 'observe-diff/apply-roundtrip', '--cases', '4', '--check']);
  assert.equal(single.summary.properties, 1);
  assert.equal(single.properties[0].id, 'observe-diff/apply-roundtrip');
  assert.equal(single.summary.failed, 0);
  assert.equal(verifyDigest(single).ok, true);
  const area = runEvalJson(['--area', 'session-queue', '--cases', '4', '--check']);
  assert.equal(area.summary.properties, 15);
  assert(area.areas.some((entry) => entry.area === 'session-queue'));
});

test('门禁：--out 写 JSON/Markdown 报告，digest 与 stdout 一致', () => {
  const dir = tempDir('eval-out-');
  const jsonPath = path.join(dir, 'report.json');
  const mdPath = path.join(dir, 'report.md');
  const jsonRun = runEvalCli([...GATE_ARGS, '--out', jsonPath]);
  assert.equal(jsonRun.status, 0);
  assert.ok(fs.existsSync(jsonPath));
  const written = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(verifyDigest(written).ok, true);
  const mdRun = runEvalCli([...GATE_ARGS, '--out', mdPath]);
  assert.equal(mdRun.status, 0);
  assert.match(fs.readFileSync(mdPath, 'utf8'), /# BridgeDeck eval property report/);
  assert.equal(path.isAbsolute(jsonPath), true);
  assert.equal(path.isAbsolute(mdPath), true);
  assert.equal(path.dirname(jsonPath), dir);
  assert.equal(path.dirname(jsonPath), dir);
});

test('门禁：用法错误 / 空过滤 / 未知参数退出码为 2', () => {
  const unknown = runEvalCli(['--nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知参数/);
  const badCases = runEvalCli(['--cases', '0']);
  assert.equal(badCases.status, 2);
  const badFilter = runEvalCli(['--property', 'no/such-property', '--check']);
  assert.equal(badFilter.status, 2);
  assert.match(badFilter.stderr, /没有匹配的 property/);
  const both = runEvalCli(['--json', '--md']);
  assert.equal(both.status, 2);
  const help = runEvalCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--check/);
});

test('门禁：报告里每个 property 都有 source 行与至少一个 runtime 位置', () => {
  const report = runEvalJson(GATE_ARGS);
  for (const property of report.properties) {
    assert.match(property.source, /^tools\/eval\/corpus\/[a-z-]+\.mjs:\d+$/, 'property source 不合法：' + property.id);
    assert.ok(property.consumeLocations.length > 0, 'property 缺少 runtime 位置：' + property.id);
    for (const location of property.consumeLocations) {
      const parsed = parseLocation(location);
      assert(parsed, 'property 消费点不是 file:line：' + location);
      assert.ok(fs.existsSync(path.join(ROOT, parsed.file)), '消费点文件不存在：' + parsed.file);
    }
  }
});
