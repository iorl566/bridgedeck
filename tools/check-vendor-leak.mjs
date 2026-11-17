#!/usr/bin/env node
// tools/check-vendor-leak.mjs —— 发布源码目录/扩展包不得包含参考实现或研究材料标识。
// 只扫描会被打包的目录，不扫描 ref/、reference/、docs/bsk-study。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const DIRS = ['extension', 'cli', 'daemon', 'lib', 'dsh-plugin', 'sdk', 'skill', 'mcp'];
const TOKENS = [/browser\s*skill/i, /\bbsk\b/i];
const EXTRA = ['manifest.json'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const problems = [];
for (const dir of DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const file of walk(full)) {
    if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|mp4|zip)$/i.test(file)) continue;
    if (fs.statSync(file).size > 512 * 1024) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const token of TOKENS) {
      if (token.test(text)) problems.push(path.relative(ROOT, file) + ' :: ' + token);
    }
  }
}

const zip = path.join(ROOT, 'dist', 'BridgeDeck-extension-0.1.9.zip');
if (fs.existsSync(zip)) {
  const listed = spawnSync('tar', ['-tf', zip], { encoding: 'utf8' });
  if (listed.status === 0) {
    for (const name of listed.stdout.split(/\r?\n/).filter(Boolean)) {
      if (!/\.(js|json|html|css|md|txt)$/i.test(name)) continue;
      const read = spawnSync('tar', ['-xOf', zip, name], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
      if (read.status !== 0) continue;
      for (const token of TOKENS) {
        if (token.test(read.stdout)) problems.push(zip + '!' + name + ' :: ' + token);
      }
    }
  }
}

if (problems.length) {
  console.error('VENDOR LEAK:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}
console.log('vendor leak check: clean');
