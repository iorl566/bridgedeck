// tests/unit/release-source-sync.test.mjs —— 协议生成物同步守卫（tools/source-guard.mjs 内）。
//
// W4-C 要求：docs/PROTOCOL-METHODS.md 的方法索引/特性门表/状态机表只能由
// tools/gen-protocol.mjs 生成，docs 更新只允许这张生成表。source-guard 现在会调用
// 生成器 --check；本测试验证真实仓库 clean、以及“生成器报漂移时 source-guard 必须 fail”。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_GUARD = path.join(ROOT, 'tools', 'source-guard.mjs');
const GEN_PROTOCOL = path.join(ROOT, 'tools', 'gen-protocol.mjs');

function tempDir(prefix = 'bb-source-sync-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(file, { cwd = ROOT, timeout = 120000 } = {}) {
  return spawnSync(process.execPath, [file], { cwd, encoding: 'utf8', timeout });
}

test('真实仓库：协议生成物与 docs 特性门表同步（gen-protocol --check clean）', { timeout: 120000 }, () => {
  const checked = spawnSync(process.execPath, [GEN_PROTOCOL, '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /up to date/);
});

test('source-guard 在真实仓库跑通，并且包含协议生成物同步守卫输出', { timeout: 180000 }, () => {
  const guard = run(SOURCE_GUARD);
  assert.equal(guard.status, 0, guard.stderr || guard.stdout);
  assert.match(guard.stdout, /source guard: clean/);
  assert.match(guard.stdout, /protocol docs sync: clean/);
  assert.match(guard.stdout, /focus guard: clean/);
  assert.match(guard.stdout, /encoding guard: clean/);
});

test('生成器报漂移时 source-guard 必须 fail（且失败信息指向 docs 生成表）', { timeout: 120000 }, () => {
  const root = tempDir();
  try {
    // 最小可运行目录：只需要 tools/gen-protocol.mjs（模拟生成物过期）。
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'gen-protocol.mjs'),
      '#!/usr/bin/env node\nconsole.error("generated artifact is stale: docs/PROTOCOL-METHODS.md");\nprocess.exit(1);\n', 'utf8');
    const guard = run(SOURCE_GUARD, { cwd: root });
    assert.equal(guard.status, 1);
    assert.match(guard.stderr, /PROTOCOL DOCS SYNC FAILED/);
    assert.match(guard.stderr, /generated artifact is stale/);
    assert.match(guard.stderr, /docs\/PROTOCOL-METHODS\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('生成器通过时 source-guard 继续执行后续守卫（focus/encoding）', { timeout: 120000 }, () => {
  const root = tempDir();
  try {
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'gen-protocol.mjs'),
      '#!/usr/bin/env node\nconsole.log("protocol generated artifacts are up to date");\n', 'utf8');
    const guard = run(SOURCE_GUARD, { cwd: root });
    assert.equal(guard.status, 0, guard.stderr || guard.stdout);
    assert.match(guard.stdout, /protocol docs sync: clean/);
    assert.match(guard.stdout, /focus guard: clean/);
    assert.match(guard.stdout, /encoding guard: clean/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
