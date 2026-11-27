#!/usr/bin/env node
// dsh-plugin/scripts/tool-matrix.mjs —— 离线跑 37 工具 × 4 场景矩阵并写 TOOLS-MATRIX.md。
//
// 不连 daemon、不连浏览器、不联网：驱动是 lib/tool-matrix.mjs 里的 fake adapter 场景。
// 用法：
//   node dsh-plugin/scripts/tool-matrix.mjs           # 跑矩阵并写报告（有失败格 exit 1）
//   node dsh-plugin/scripts/tool-matrix.mjs --check   # 跑矩阵并校验报告与实现一致
//   node dsh-plugin/scripts/tool-matrix.mjs --json    # 只输出汇总 JSON（不写文件）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMatrixReport, runMatrix } from '../lib/tool-matrix.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const OUTPUT = path.join(PLUGIN_DIR, 'TOOLS-MATRIX.md');

async function main(argv) {
  const check = argv.includes('--check');
  const json = argv.includes('--json');
  const result = await runMatrix();
  const report = renderMatrixReport(result);
  if (json) {
    console.log(JSON.stringify({ summary: result.summary, failures: result.summary.failures }, null, 2));
    process.exit(result.summary.failed ? 1 : 0);
  }
  const relative = path.relative(process.cwd(), OUTPUT);
  if (check) {
    let current = null;
    try {
      current = fs.readFileSync(OUTPUT, 'utf8');
    } catch {
      current = null;
    }
    if (result.summary.failed) {
      console.error('TOOL MATRIX FAILED: ' + result.summary.failed + ' 格失败');
      for (const failure of result.summary.failures) {
        console.error('  - ' + failure.tool + '/' + failure.cls + '：' + failure.detail);
      }
      process.exit(1);
    }
    if (current === null) {
      console.error('TOOL MATRIX CHECK FAILED: 缺少生成物 ' + relative + '（先运行不带 --check 的命令）');
      process.exit(1);
    }
    if (current !== report) {
      console.error('TOOL MATRIX CHECK FAILED: ' + relative + ' 与当前实现不一致，请重新生成');
      process.exit(1);
    }
    console.log('tool matrix check: clean (' + result.summary.passed + '/' + result.summary.cells + ' 格，' + relative + ')');
    return;
  }
  fs.writeFileSync(OUTPUT, report, 'utf8');
  console.log('tool matrix: ' + result.summary.passed + '/' + result.summary.cells + ' 格通过（'
    + result.summary.tools + ' 工具 × ' + result.summary.classes + ' 场景类），报告已写 '
    + relative + '（' + report.length + ' chars）');
  if (result.summary.failed) {
    for (const failure of result.summary.failures) console.error('  - ' + failure.tool + '/' + failure.cls + '：' + failure.detail);
    process.exit(1);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error('TOOL MATRIX ERROR: ' + ((error && error.stack) || error));
  process.exit(1);
});
