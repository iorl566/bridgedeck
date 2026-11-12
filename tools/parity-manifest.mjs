import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const reference = join(root, '.ref', 'repo', 'apps', 'extension', 'src');
const mirror = join(root, 'extension', 'src');
const areas = ['debug', 'transport', 'session-manager', 'browser-driver', 'content', 'long-screenshot', 'video', 'lib', 'shared'];
const lines = (path) => readFileSync(path, 'utf8').split(/\n/).length;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) && !/\.d\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

const rows = [];
for (const area of areas) {
  for (const ref of walk(join(reference, area))) {
    const name = relative(join(reference, area), ref).replace(/\.(ts|tsx)$/, '.js');
    const target = join(mirror, area, name);
    let actual = null;
    try { actual = lines(target); } catch { /* missing mirror */ }
    rows.push({ area, name, expected: lines(ref), actual, delta: actual === null ? null : actual - lines(ref) });
  }
}

const missing = rows.filter((row) => row.actual === null);
const table = rows
  .map((row) => `| ${row.area} | ${row.name} | ${row.expected} | ${row.actual ?? '—'} | ${row.delta === null ? '—' : row.delta > 0 ? `+${row.delta}` : row.delta} |`)
  .join('\n');
const totals = areas.map((area) => {
  const items = rows.filter((row) => row.area === area);
  return `| ${area} | ${items.length} | ${items.reduce((sum, row) => sum + row.expected, 0)} | ${items.reduce((sum, row) => sum + (row.actual ?? 0), 0)} |`;
}).join('\n');

const report = `# 逐文件镜像清单

由 \`node tools/parity-manifest.mjs\` 生成。\`delta\` 为镜像行数减对照行数，正数表示镜像注释更多。目录汇总只统计与对照一一对应的文件，辅助镜像不计入。

## 目录汇总

| 目录 | 文件 | 对照行 | 镜像行 |
| --- | ---: | ---: | ---: |
${totals}

## 文件明细

| 目录 | 文件 | 对照行 | 镜像行 | delta |
| --- | --- | ---: | ---: | ---: |
${table}

## 结论

- 对照文件总数：**${rows.length}**
- 缺失镜像：**${missing.length}**
- 完全同行的文件：**${rows.filter((row) => row.delta === 0).length}**（${rows.filter((row) => row.delta === 0).map((row) => `${row.area}/${row.name}`).join('、') || '无'}）
- 行数差异绝对值不超过 20 的文件：**${rows.filter((row) => row.delta !== null && Math.abs(row.delta) <= 20).length}**
`;

writeFileSync(join(root, 'docs', 'PARITY-MANIFEST.md'), report);
if (process.argv.includes('--check') && missing.length) process.exitCode = 1;
console.log(JSON.stringify({ files: rows.length, missing: missing.map((row) => `${row.area}/${row.name}`), exact: rows.filter((row) => row.delta === 0).length }));
