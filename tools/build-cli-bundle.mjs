#!/usr/bin/env node
// tools/build-cli-bundle.mjs —— 重新打包 CLI/daemon/lib/mcp/skill 为 dist/BridgeDeck-cli-bundle-<version>.zip
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const name = `BridgeDeck-cli-bundle-${pkg.version}.zip`;
const out = path.join(DIST, name);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-bundle-'));

const DIRS = ['cli', 'daemon', 'lib', 'mcp', 'skill'];
const FILES = ['install.ps1', 'install-online.ps1', 'AGENT_INSTALL.md', 'LICENSE', 'package.json', 'README.md', 'uninstall.ps1'];

try {
  fs.mkdirSync(DIST, { recursive: true });
  for (const dir of DIRS) fs.cpSync(path.join(ROOT, dir), path.join(stage, dir), { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(ROOT, file), path.join(stage, file));
  fs.rmSync(out, { force: true });
  const psPath = (value) => String(value).replace(/'/g, "''");
  const script = `Compress-Archive -Path '${psPath(path.join(stage, '*'))}' -DestinationPath '${psPath(out)}' -Force`;
  const packed = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (packed.status !== 0) throw new Error('Compress-Archive 失败：' + (packed.stderr || packed.stdout));
  const listed = spawnSync('tar', ['-tf', out], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error('无法读取 zip 列表：' + (listed.stderr || listed.stdout));
  const entries = new Set(String(listed.stdout).split(/\r?\n/).filter(Boolean));
  for (const required of ['cli/bridge.mjs', 'daemon/server.mjs', 'mcp/server.mjs', 'install.ps1']) {
    if (!entries.has(required)) throw new Error('CLI bundle 缺少文件：' + required);
  }
  console.log(JSON.stringify({ ok: true, name, bytes: fs.statSync(out).size, entries: entries.size }, null, 2));
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
