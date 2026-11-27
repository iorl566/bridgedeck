#!/usr/bin/env node
// 路径可移植性守卫：运行时源码里不允许硬编码 Windows 盘符/反斜杠路径。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIRS = ['extension/src', 'cli', 'lib', 'daemon', 'mcp'];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|mjs)$/.test(entry.name)) files.push(full);
  }
}
for (const dir of DIRS) {
  const full = path.join(ROOT, dir);
  if (fs.existsSync(full)) walk(full);
}

const problems = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (/['"`][A-Za-z]:[\\/]/.test(line)) {
      problems.push(path.relative(ROOT, file) + ':' + (index + 1) + ' 硬编码盘符路径');
    } else if (/['"`][^'"`\n]*\\\\\\\\[^'"`\n]*['"`]/.test(line)) {
      problems.push(path.relative(ROOT, file) + ':' + (index + 1) + ' 字符串内出现 Windows 反斜杠路径');
    }
  }
}

console.log(JSON.stringify({ ok: problems.length === 0, files: files.length, problems }, null, 2));
if (problems.length && process.argv.includes('--check')) process.exit(1);
