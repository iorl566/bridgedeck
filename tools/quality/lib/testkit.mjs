// tools/quality/lib/testkit.mjs —— 单测/集成测试共用的最小工具（不是产品运行时）。
//
// tests/unit/quality-*.test.mjs 需要：真实子进程调用 run.mjs、临时目录、
// JSON 解析与 digest 校验。把这些集中在这里，测试文件只做断言，避免复制粘贴。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyDigest } from './result.mjs';

export const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** 直接定位仓库内文件（测试里断言 file:line 用）。 */
export function repoPath(relPath) {
  return path.join(ROOT, String(relPath));
}

export function sourceText(relPath) {
  return fs.readFileSync(repoPath(relPath), 'utf8');
}

/**
 * 真实子进程执行 node tools/quality/run.mjs。
 * @returns {{status:number|null, stdout:string, stderr:string, args:string[]}}
 */
export function runQualityCli(args = [], options = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'quality', 'run.mjs'), ...args], {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, Number(options.timeoutMs) || 120000),
    env: { ...process.env, ...(options.env || {}) },
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    args: args.slice(),
  };
}

/** 解析 JSON stdout；解析失败时把 stdout 带进错误信息，便于定位。 */
export function parseStdoutJson(run) {
  const text = String(run.stdout || '').trim();
  if (!text) throw new Error('stdout 为空（stderr=' + String(run.stderr || '').slice(0, 500) + '）');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('stdout 不是合法 JSON：' + error.message + '\n--- stdout ---\n' + text.slice(0, 2000));
  }
}

/** 执行并解析 JSON（断言退出码由调用方决定）。 */
export function runQualityJson(args = [], options = {}) {
  return parseStdoutJson(runQualityCli(args, options));
}

/** 创建临时目录并返回清理函数（测试里 try/finally 调用）。 */
export function tempDir(prefix = 'quality-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 测试清理失败不应掩盖真正的断言错误。
      }
    },
  };
}

/** 目录树（相对路径，排序）。 */
export function listFiles(dir) {
  const out = [];
  const walk = (current, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const nextRel = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), nextRel);
      else out.push(nextRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** 报告结构自校验：schema/字段/verdict/digest 一致。 */
export function assertReportShape(assert, report) {
  assert.equal(report.schema, 'bb.quality/1');
  assert.equal(typeof report.gate.seed, 'string');
  assert.equal(typeof report.gate.repeats, 'number');
  assert.ok(report.gate.repeats >= 1);
  assert.ok(Array.isArray(report.gates) && report.gates.length > 0);
  assert.ok(Array.isArray(report.findings));
  assert.ok(Array.isArray(report.runtime));
  assert.ok(report.summary && typeof report.summary === 'object');
  const digest = verifyDigest(report);
  assert.equal(digest.ok, true, 'digest 自校验失败：' + JSON.stringify(digest));
  assert.equal(report.summary.verdict, report.summary.blocking === 0 ? 'PASS' : 'FAIL');
  for (const gate of report.gates) {
    assert.equal(typeof gate.id, 'string');
    assert.equal(typeof gate.ok, 'boolean');
    assert.equal(gate.checks >= 0, true);
  }
  for (const finding of report.findings) {
    assert.equal(typeof finding.id, 'string');
    assert.equal(typeof finding.gate, 'string');
    assert.equal(typeof finding.ok, 'boolean');
    assert.equal(typeof finding.title, 'string');
    if (finding.ok === false) {
      assert.equal(typeof finding.code, 'string');
      assert.equal(typeof finding.category, 'string');
      assert.ok(['no', 'transient', 'after-action'].includes(finding.retry), 'retry 非法：' + finding.retry);
      assert.ok(String(finding.nextAction || '').length >= 4, 'nextAction 缺失：' + finding.id);
      assert.ok(String(finding.detail || '').length >= 4, 'detail 缺失：' + finding.id);
    }
  }
}

/** 取某条 finding（不存在时抛错，避免测试空断言）。 */
export function findingById(report, id) {
  const found = (report.findings || []).find((finding) => finding.id === id);
  if (!found) throw new Error('报告里没有 finding：' + id + '（现有：' + (report.findings || []).map((item) => item.id).join(', ') + '）');
  return found;
}

/** 让出事件循环（假定时器测试用）。 */
export async function settle(times = 5) {
  for (let index = 0; index < Math.max(1, times); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 简单断言辅助：全部问题为空时返回。 */
export function assertNoProblems(assert, problems, label) {
  assert.deepEqual(problems, [], label + ' 存在问题：' + JSON.stringify(problems, null, 2));
}
