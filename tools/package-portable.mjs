#!/usr/bin/env node
// tools/package-portable.mjs —— 生成 Windows 便携包（目录 + zip，含 install/uninstall）。
//
// 用法：
//   node tools/package-portable.mjs                 # dist/bridgedeck-portable-<version>.zip
//   node tools/package-portable.mjs --out <path>
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const withNode = !args.includes('--no-node');
const out = path.resolve(ROOT, outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : path.join('dist', `bridgedeck-portable-${pkg.version}.zip`));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-portable-'));

const DIRS = ['bin', 'cli', 'daemon', 'lib', 'mcp', 'skill', 'extension'];
const FILES = ['package.json', 'install.ps1', 'uninstall.ps1', 'README.md'];
try {
  for (const dir of DIRS) {
    const from = path.join(ROOT, dir);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(stage, dir), { recursive: true });
  }
  for (const file of FILES) {
    const from = path.join(ROOT, file);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(stage, file));
  }
  if (withNode) {
    fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(stage, 'bin', 'node.exe'));
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const script = `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${out.replace(/'/g, "''")}' -Force`;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Compress-Archive 失败：' + (result.stderr || result.stdout));
  const bytes = fs.statSync(out).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  console.log('portable package: ' + out);
  console.log('  bytes  ' + bytes);
  console.log('  sha256 ' + sha256);
  console.log('  node   ' + (withNode ? 'bundled bin/node.exe' : 'external'));
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
