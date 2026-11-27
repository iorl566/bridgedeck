// tests/unit/release-scale-gate.test.mjs —— 规模门禁（tools/scale-report.mjs）。
//
// 覆盖：扫描口径（目录/扩展名过滤）、分组汇总、绝对上限（文件/行/单文件/生成物宽限）、
// 基线容差、BSK 对标百分比、阈值可配置（inline JSON / 环境变量），以及真实 CLI 的
// “只报告 exit 0 / --check 超限 exit 1”。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BSK_REFERENCE_LINES,
  DEFAULT_LIMITS,
  SCALE_TARGET_LINES,
  UsageError,
  evaluateScale,
  formatReport,
  loadLimits,
  loadScaleBaseline,
  parseArgs,
  resolveLimits,
  scanRepository,
  summarizeScale,
  writeScaleBaseline,
} from '../../tools/scale-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'tools', 'scale-report.mjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-scale-gate-'));
}

function runTool(args, { env = {}, timeout = 120000 } = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', timeout, env: { ...process.env, ...env } });
}

function summaryOf(files, lines, largest = []) {
  return { files, lines, groups: { other: lines }, largest };
}

test('BSK 对标常量与默认阈值自洽', () => {
  assert.equal(BSK_REFERENCE_LINES, 316463, 'BSK 0.5.0 代码行基线来自 BSK-PARITY-PROGRAM §1');
  assert.ok(SCALE_TARGET_LINES > 0);
  assert.ok(DEFAULT_LIMITS.maxFiles > 900, '默认文件上限不应低于当前仓库规模');
  assert.ok(DEFAULT_LIMITS.maxLines > 155552, '默认行数上限不应低于当前仓库规模');
  assert.ok(DEFAULT_LIMITS.maxFileLines < DEFAULT_LIMITS.maxLines);
  assert.ok(DEFAULT_LIMITS.maxGeneratedFileLines > DEFAULT_LIMITS.maxFileLines, '生成物上限应更宽');
  assert.ok(DEFAULT_LIMITS.minParityPct > 0 && DEFAULT_LIMITS.minParityPct < 100);
});

test('scanRepository：只统计 .js/.mjs，跳过 node_modules/dist/.tmp 等目录', () => {
  const dir = tempDir();
  try {
    const write = (relative, content) => {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    };
    write('lib/a.mjs', 'a\nb\n');
    write('daemon/b.js', 'x');
    write('extension/src/generated/protocol.js', 'g\n');
    write('tests/readme.md', 'should not count');
    write('node_modules/dep/index.js', 'skip');
    write('dist/bundle.js', 'skip');
    write('.tmp/scratch.mjs', 'skip');
    write('ref/bsk.js', 'skip');
    const rows = scanRepository(dir);
    assert.deepEqual(rows.map((row) => row.file), [
      'daemon/b.js',
      'extension/src/generated/protocol.js',
      'lib/a.mjs',
    ]);
    const byFile = new Map(rows.map((row) => [row.file, row]));
    assert.equal(byFile.get('lib/a.mjs').lines, 3, "split('\\n').length 口径");
    assert.equal(byFile.get('lib/a.mjs').group, 'lib');
    assert.equal(byFile.get('daemon/b.js').group, 'daemon');
    assert.equal(byFile.get('extension/src/generated/protocol.js').group, 'extension');
    assert.equal(byFile.get('extension/src/generated/protocol.js').generated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeScale：总数/分组排序/最大文件 topN', () => {
  const records = [
    { file: 'extension/a.js', lines: 100, group: 'extension' },
    { file: 'lib/b.mjs', lines: 300, group: 'lib' },
    { file: 'daemon/c.js', lines: 50, group: 'daemon' },
    { file: 'tools/d.mjs', lines: 10, group: 'other' },
  ];
  const summary = summarizeScale(records, { largest: 3 });
  assert.equal(summary.files, 4);
  assert.equal(summary.lines, 460);
  assert.deepEqual(summary.groups, { lib: 300, extension: 100, daemon: 50, other: 10 });
  assert.deepEqual(summary.largest.map((row) => row.file), ['lib/b.mjs', 'extension/a.js', 'daemon/c.js']);
  assert.equal(summary.largest[0].lines, 300);
  assert.deepEqual(summarizeScale([], { largest: 2 }), { files: 0, lines: 0, groups: {}, largest: [] });
});

test('resolveLimits：默认 → inline → 环境变量覆盖', () => {
  assert.deepEqual(resolveLimits({ env: {} }), { ...DEFAULT_LIMITS, bskLines: BSK_REFERENCE_LINES, targetLines: SCALE_TARGET_LINES });
  const fromFile = resolveLimits({ limits: { maxFiles: 2000, maxLines: 300000, minParityPct: 40 }, env: {} });
  assert.equal(fromFile.maxFiles, 2000);
  assert.equal(fromFile.maxLines, 300000);
  assert.equal(fromFile.minParityPct, 40);
  assert.equal(fromFile.maxFileLines, DEFAULT_LIMITS.maxFileLines, '未给的键沿用默认');
  const fromEnv = resolveLimits({
    limits: { maxFiles: 2000 },
    env: { BB_SCALE_MAX_FILES: '1234', BB_SCALE_MAX_LINES: '456789', BB_SCALE_BSK_LINES: '100000', BB_SCALE_TARGET: '200000', BB_SCALE_MIN_PARITY: '75' },
  });
  assert.equal(fromEnv.maxFiles, 1234, '环境变量优先于 inline');
  assert.equal(fromEnv.maxLines, 456789);
  assert.equal(fromEnv.bskLines, 100000);
  assert.equal(fromEnv.targetLines, 200000);
  assert.equal(fromEnv.minParityPct, 75);
});

test('loadLimits/loadScaleBaseline：文件与 inline JSON；坏输入不放行', () => {
  const dir = tempDir();
  try {
    assert.equal(loadLimits(null), null);
    assert.deepEqual(loadLimits('{"maxFiles": 9}'), { maxFiles: 9 });
    const file = path.join(dir, 'limits.json');
    fs.writeFileSync(file, JSON.stringify({ maxLines: 42 }), 'utf8');
    assert.deepEqual(loadLimits(file), { maxLines: 42 });
    assert.throws(() => loadLimits('{bad'), /不是合法 JSON 对象/);
    assert.throws(() => loadLimits('[1,2]'), /不是合法 JSON 对象/);

    const baselinePath = path.join(dir, 'baseline.json');
    assert.equal(loadScaleBaseline(baselinePath), null);
    writeScaleBaseline({ files: 10, lines: 20 }, { file: baselinePath, recordedAt: '2026-11-25T00:00:00.000Z' });
    assert.deepEqual(loadScaleBaseline(baselinePath), { files: 10, lines: 20 });
    fs.writeFileSync(baselinePath, JSON.stringify({ files: 'x' }), 'utf8');
    assert.throws(() => loadScaleBaseline(baselinePath), /格式非法/);
    fs.writeFileSync(baselinePath, '{oops', 'utf8');
    assert.throws(() => loadScaleBaseline(baselinePath), /不是合法 JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateScale：上限内通过；文件/行/单文件/基线/对标分别失败', () => {
  const limits = { ...DEFAULT_LIMITS, minParityPct: 10 };
  const base = { files: 100, lines: 1000 };
  const pass = evaluateScale({
    summary: summaryOf(100, 1000, [{ file: 'lib/a.mjs', lines: 500, generated: false }]),
    limits,
    baseline: base,
    bskLines: 10000,
  });
  assert.equal(pass.ok, true, JSON.stringify(pass.violations));
  assert.equal(pass.parity.parityPct, 10);
  assert.equal(pass.parity.targetPct, Math.round((1000 / SCALE_TARGET_LINES) * 1000) / 10);

  const tooManyFiles = evaluateScale({ summary: summaryOf(5000, 1000, []), limits, baseline: base, bskLines: 10000 });
  assert.equal(tooManyFiles.ok, false);
  assert.ok(tooManyFiles.violations.some((item) => item.id === 'limits.files'));

  const tooManyLines = evaluateScale({ summary: summaryOf(10, 999999, []), limits, baseline: base, bskLines: 1000000 });
  assert.equal(tooManyLines.ok, false);
  assert.ok(tooManyLines.violations.some((item) => item.id === 'limits.lines'));

  const bigHandwritten = evaluateScale({
    summary: summaryOf(10, 1000, [{ file: 'lib/huge.mjs', lines: limits.maxFileLines + 1, generated: false }]),
    limits, baseline: base, bskLines: 10000,
  });
  assert.equal(bigHandwritten.ok, false);
  assert.match(bigHandwritten.violations.find((item) => item.id === 'limits.file-size').detail, /超单文件上限/);

  const bigGenerated = evaluateScale({
    summary: summaryOf(10, 1000, [{ file: 'extension/src/generated/protocol.js', lines: limits.maxFileLines + 1, generated: true }]),
    limits, baseline: base, bskLines: 10000,
  });
  assert.equal(bigGenerated.ok, true, '生成物走更宽上限');

  const noBaseline = evaluateScale({ summary: summaryOf(10, 1000, []), limits, baseline: null, bskLines: 10000 });
  assert.equal(noBaseline.ok, false);
  assert.ok(noBaseline.violations.some((item) => item.id === 'baseline.present'));

  const drifted = evaluateScale({ summary: summaryOf(200, 5000, []), limits, baseline: { files: 100, lines: 1000 }, bskLines: 10000 });
  assert.equal(drifted.ok, false);
  assert.ok(drifted.violations.some((item) => item.id === 'baseline.regression'));

  const lowParity = evaluateScale({ summary: summaryOf(10, 1000, []), limits: { ...limits, minParityPct: 90 }, baseline: { files: 10, lines: 1000 }, bskLines: 10000 });
  assert.equal(lowParity.ok, false);
  assert.ok(lowParity.violations.some((item) => item.id === 'bsk.parity'));
});

test('formatReport：报告含对标百分比/分组/上限状态；check/报告模式措辞不同', () => {
  const evaluated = evaluateScale({ summary: summaryOf(10, 1000, [{ file: 'lib/a.mjs', lines: 100, generated: false }]), limits: { ...DEFAULT_LIMITS, minParityPct: 1 }, baseline: { files: 10, lines: 1000 }, bskLines: 10000 });
  const report = formatReport({ summary: summaryOf(10, 1000, [{ file: 'lib/a.mjs', lines: 100, generated: false }]), parity: evaluated.parity, checks: evaluated.checks, violations: evaluated.violations, ok: evaluated.ok, checkMode: false });
  assert.match(report, /BridgeDeck 规模/);
  assert.match(report, /BSK 0\.5\.0 对标/);
  assert.match(report, /SCALE REPORT/);
  const gate = formatReport({ summary: summaryOf(10, 1000, []), parity: evaluated.parity, checks: evaluated.checks, violations: [], ok: true, checkMode: true });
  assert.match(gate, /SCALE GATE PASS/);
});

test('parseArgs：默认只报告；--check/--json/--limits/--baseline/--update-baseline', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.check, false);
  assert.equal(defaults.json, false);
  assert.equal(defaults.updateBaseline, false);
  assert.equal(parseArgs(['--check']).check, true);
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--limits', '{"maxLines":1}']).limits, '{"maxLines":1}');
  assert.equal(parseArgs(['--limits={"maxLines":1}']).limits, '{"maxLines":1}');
  assert.equal(parseArgs(['--baseline', '.tmp/b.json']).baseline, '.tmp/b.json');
  const update = parseArgs(['--update-baseline']);
  assert.equal(update.updateBaseline, true);
  assert.equal(update.check, true, '更新基线同时走门禁判定');
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['--limits']), /--limits/);
});

test('真实 CLI：默认只报告 exit 0；--update-baseline 后 --check 通过；收紧阈值 exit 1', { timeout: 240000 }, () => {
  const dir = tempDir();
  const baselineFile = path.join(dir, 'scale-baseline.json');
  try {
    const reported = runTool(['--json']);
    assert.equal(reported.status, 0, reported.stderr || reported.stdout);
    const result = JSON.parse(reported.stdout);
    assert.ok(result.summary.files > 500, '真实仓库文件数应 > 500');
    assert.ok(result.summary.lines > 100000, '真实仓库行数应 > 100000');
    assert.equal(result.checkMode, false);
    assert.ok(result.parity.bskLines >= 300000);
    // 对标百分比是相对 BSK 0.5.0 的体量比：>100% 表示已超过对照体量，仍属合理区间
    // （上限留出裕量，避免把“超过对标”误判为坏数据；下限防止真实行数读空）。
    assert.ok(result.parity.parityPct > 20 && result.parity.parityPct < 150, '对标百分比应在合理区间：' + result.parity.parityPct);
    assert.ok(result.summary.groups.extension > 10000);
    assert.ok(result.limits.maxFiles > 0);
    assert.equal(result.summary.largest.length, 8);

    const updated = runTool(['--update-baseline', '--baseline', baselineFile, '--json']);
    assert.equal(updated.status, 0, updated.stderr || updated.stdout);
    assert.ok(fs.existsSync(baselineFile));

    const checked = runTool(['--check', '--baseline', baselineFile, '--json']);
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.equal(JSON.parse(checked.stdout).ok, true);

    const tightened = runTool(['--check', '--baseline', baselineFile, '--limits', '{"maxLines":1,"minParityPct":0}', '--json']);
    assert.equal(tightened.status, 1, '收紧 maxLines 后必须失败');
    const tightenedResult = JSON.parse(tightened.stdout);
    assert.equal(tightenedResult.ok, false);
    assert.ok(tightenedResult.violations.some((item) => item.id === 'limits.lines'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
