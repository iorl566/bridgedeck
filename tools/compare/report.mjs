#!/usr/bin/env node
// tools/compare/report.mjs —— 合并 bsk / bridge 两边的任务结果，生成 Markdown 对比报告。
// 用法：node tools/compare/report.mjs --run docs/comparison/runs/<id>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const runArg = arg('--run');
if (!runArg) {
  console.error('用法：node tools/compare/report.mjs --run docs/comparison/runs/<id>');
  process.exit(2);
}
const RUN = path.resolve(ROOT, runArg);

function load(name) {
  const file = path.join(RUN, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const bsk = load('bsk');
const bridge = load('bridge');
if (!bsk && !bridge) {
  console.error('没有找到 bsk.json / bridge.json');
  process.exit(2);
}

const tools = [bsk, bridge].filter(Boolean);
const taskIds = [...new Set(tools.flatMap((tool) => tool.tasks.map((task) => task.id)))];
const titles = new Map();
for (const tool of tools) for (const task of tool.tasks) titles.set(task.id, task.title);

const cell = (task) => (task ? `${task.ok ? '✅' : '❌'} ${task.ms}ms / ${task.steps} 步` : '—');

const lines = [];
lines.push(`# BSK 0.5.0 vs BridgeDeck 0.3.1 — 实测对比`);
lines.push('');
lines.push(`- 生成时间：${new Date().toISOString()}`);
lines.push(`- 夹具页：${tools[0].url}`);
lines.push(`- 浏览器：${path.basename(path.dirname(path.dirname(path.dirname(tools[0].environment.edge))))}（两个工具各自独立 profile + 扩展 + daemon，顺序执行）`);
lines.push(`- 任务：打开并读结构 / 填表并回读 / 表格提取 / 视口截图，四条都由同一个夹具页给出确定答案`);
lines.push('');
lines.push('| 任务 | 内容 | ' + tools.map((tool) => tool.display).join(' | ') + ' |');
lines.push('| --- | --- | ' + tools.map(() => '---').join(' | ') + ' |');
for (const id of taskIds) {
  const cells = tools.map((tool) => cell(tool.tasks.find((task) => task.id === id)));
  lines.push(`| ${id} | ${titles.get(id)} | ${cells.join(' | ')} |`);
}
lines.push('');
lines.push('| 汇总 | ' + tools.map((tool) => tool.display).join(' | ') + ' |');
lines.push('| --- | ' + tools.map(() => '---').join(' | ') + ' |');
lines.push('| 通过 | ' + tools.map((tool) => `${tool.summary.ok}/${tool.summary.total}`).join(' | ') + ' |');
lines.push('| 任务耗时合计 | ' + tools.map((tool) => `${tool.summary.totalMs}ms`).join(' | ') + ' |');
lines.push('| CLI 步数合计 | ' + tools.map((tool) => tool.tasks.reduce((sum, task) => sum + (task.steps || 0), 0)).join(' | ') + ' |');
lines.push('');

lines.push('## 逐任务的实测细节');
lines.push('');
for (const id of taskIds) {
  lines.push(`### ${id} ${titles.get(id)}`);
  lines.push('');
  for (const tool of tools) {
    const task = tool.tasks.find((item) => item.id === id);
    if (!task) continue;
    lines.push(`- **${tool.display}**：${task.detail}`);
    if (task.raw) {
      lines.push('');
      lines.push('  ```text');
      for (const rawLine of String(task.raw).split('\n').slice(0, 14)) lines.push('  ' + rawLine.slice(0, 220));
      lines.push('  ```');
      lines.push('');
    }
  }
}

if (tools.length === 2) {
  lines.push('## 差异摘要（自动）');
  lines.push('');
  for (const id of taskIds) {
    const left = bsk.tasks.find((task) => task.id === id);
    const right = bridge.tasks.find((task) => task.id === id);
    if (!left || !right) continue;
    const parts = [];
    if (left.ok !== right.ok) parts.push(`通过状态不同（BSK ${left.ok ? '通过' : '失败'} / BridgeDeck ${right.ok ? '通过' : '失败'}）`);
    if (left.ok && right.ok) {
      const delta = right.ms - left.ms;
      parts.push(`耗时差 ${delta >= 0 ? '+' : ''}${delta}ms（BSK ${left.ms}ms / BridgeDeck ${right.ms}ms）`);
      if (left.steps !== right.steps) parts.push(`步数不同（${left.steps} / ${right.steps}）`);
    }
    lines.push(`- ${id}：${parts.length ? parts.join('；') : '结果与步数一致'}`);
  }
  lines.push('');
}

const outFile = path.join(RUN, 'report.md');
fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log('report → ' + path.relative(ROOT, outFile));
