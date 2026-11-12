#!/usr/bin/env node
/** Audit source-level mirror coverage by directory. Read-only. */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REF = path.join(ROOT, '.ref', 'repo', 'apps', 'extension', 'src');
const OURS = path.join(ROOT, 'extension', 'src');
const DIRS = ['debug', 'transport', 'session-manager', 'browser-driver', 'content', 'long-screenshot', 'video', 'lib', 'shared'];

async function walk(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.|\.browser\.test\./.test(entry.name)) {
      out.push({ path: path.relative(base, full), lines: (await fs.readFile(full, 'utf8')).split('\n').length });
    }
  }
  return out;
}

const rows = [];
for (const dir of DIRS) {
  const ref = await walk(path.join(REF, dir));
  const ours = await walk(path.join(OURS, dir));
  rows.push({
    dir,
    refFiles: ref.length,
    refLines: ref.reduce((sum, item) => sum + item.lines, 0),
    ourFiles: ours.length,
    ourLines: ours.reduce((sum, item) => sum + item.lines, 0),
  });
}

console.log('| 目录 | 对照文件 | 对照行 | 镜像文件 | 镜像行 |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const row of rows) console.log(`| ${row.dir} | ${row.refFiles} | ${row.refLines} | ${row.ourFiles} | ${row.ourLines} |`);
const total = rows.reduce((acc, row) => ({
  refFiles: acc.refFiles + row.refFiles,
  refLines: acc.refLines + row.refLines,
  ourFiles: acc.ourFiles + row.ourFiles,
  ourLines: acc.ourLines + row.ourLines,
}), { refFiles: 0, refLines: 0, ourFiles: 0, ourLines: 0 });
console.log(`| 合计 | ${total.refFiles} | ${total.refLines} | ${total.ourFiles} | ${total.ourLines} |`);
