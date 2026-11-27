// tests/unit/bsk-diff-determinism.test.mjs —— 可复现性：二次运行逐字节一致、--check 退出 0、--out 不写仓库。
//
// 覆盖 task 验收里的两条硬指标：
//   1) `node tools/bsk-diff/run.mjs --check` exit 0；
//   2) 连续两次生成/序列化，产物逐字节相同（无时间戳、无随机、无平台路径）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(REPO_ROOT, 'tools', 'bsk-diff', 'run.mjs');

function runGenerator(args, timeout = 120000) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    // --json 会输出整份矩阵（约 1MB），默认 maxBuffer 是 1MB，会误判成 spawn 失败。
    maxBuffer: 16 * 1024 * 1024,
  });
}

test('--check 退出 0（仓库内产物与生成结果一致）', () => {
  const result = runGenerator(['--check']);
  assert.equal(result.status, 0, `--check 失败：\nstdout=${result.stdout}\nstderr=${result.stderr}`);
});

test('--check 二次运行结论一致（幂等，不会边跑边改状态）', () => {
  const first = runGenerator(['--check', '--quiet']);
  const second = runGenerator(['--check', '--quiet']);
  assert.equal(first.status, 0, `第一次 --check 失败：${first.stderr}`);
  assert.equal(second.status, 0, `第二次 --check 失败：${second.stderr}`);
  assert.equal(first.stdout, second.stdout);
});

test('--json 两次输出逐字节一致', () => {
  const first = runGenerator(['--json', '--quiet']);
  const second = runGenerator(['--json', '--quiet']);
  assert.equal(first.status, 0, `--json 失败：${first.stderr}`);
  assert.equal(second.status, 0, `--json 失败：${second.stderr}`);
  assert.ok(first.stdout.length > 1000, '--json 输出过短，可能没生成矩阵');
  assert.equal(first.stdout, second.stdout, '--json 两次输出不一致（确定性被破坏）');
});

test('--out 写到临时目录：两次生成逐字节一致，且与仓库内产物一致', () => {
  const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsk-diff-a-'));
  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsk-diff-b-'));
  const first = runGenerator(['--out', firstDir, '--quiet']);
  const second = runGenerator(['--out', secondDir, '--quiet']);
  assert.equal(first.status, 0, `--out 失败：${first.stderr}`);
  assert.equal(second.status, 0, `--out 失败：${second.stderr}`);

  const firstJson = fs.readFileSync(path.join(firstDir, 'matrix.json'), 'utf8');
  const secondJson = fs.readFileSync(path.join(secondDir, 'matrix.json'), 'utf8');
  const firstMd = fs.readFileSync(path.join(firstDir, 'BSK-DIFF-MATRIX.md'), 'utf8');
  const secondMd = fs.readFileSync(path.join(secondDir, 'BSK-DIFF-MATRIX.md'), 'utf8');
  assert.equal(firstJson, secondJson, 'matrix.json 两次生成不一致');
  assert.equal(firstMd, secondMd, 'Markdown 两次生成不一致');
  assert.equal(firstJson, fs.readFileSync(path.join(REPO_ROOT, 'tools/bsk-diff/matrix.json'), 'utf8'), '临时目录 matrix.json 与仓库内产物不一致');
  assert.equal(firstMd, fs.readFileSync(path.join(REPO_ROOT, 'docs/BSK-DIFF-MATRIX.md'), 'utf8'), '临时目录文档与仓库内产物不一致');

  fs.rmSync(firstDir, { recursive: true, force: true });
  fs.rmSync(secondDir, { recursive: true, force: true });
});

test('--out 不会写入仓库（生成物只落在指定目录）', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsk-diff-c-'));
  const before = fs.statSync(path.join(REPO_ROOT, 'tools/bsk-diff/matrix.json')).mtimeMs;
  const result = runGenerator(['--out', outDir, '--quiet']);
  assert.equal(result.status, 0, result.stderr);
  const after = fs.statSync(path.join(REPO_ROOT, 'tools/bsk-diff/matrix.json')).mtimeMs;
  assert.equal(before, after, '--out 模式不应触碰仓库内 matrix.json');
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('未知参数退出 2 语义：--bad-flag 会被拒绝而不是静默忽略', () => {
  const result = runGenerator(['--definitely-not-a-flag']);
  assert.equal(result.status, 1, '未知参数应以非 0 退出');
  assert.match(result.stderr, /未知参数/);
});

test('--help 退出 0 并列出可用开关', () => {
  const result = runGenerator(['--help']);
  assert.equal(result.status, 0);
  for (const flag of ['--check', '--json', '--out', '--quiet', '--probe-exe', '--snapshot-help']) {
    assert.ok(result.stdout.includes(flag), `--help 未列出 ${flag}`);
  }
});
