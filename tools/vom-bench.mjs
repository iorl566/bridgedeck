#!/usr/bin/env node
// VOM 权重回归基准：固定节点集 + 默认/自定义权重，验证排序语义与分数基线。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachVomScores, rankVomNodes } from '../extension/src/lib/vom-weights.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'tests', 'fixtures', 'vom-baseline.json');

const NODES = [
  { id: 'button', interactive: true, role: 'button', name: '提交', rect: { x: 20, y: 20, w: 90, h: 32 }, depth: 3 },
  { id: 'text', interactive: false, role: 'paragraph', name: '一段说明文字', rect: { x: 20, y: 80, w: 300, h: 40 }, depth: 4 },
  { id: 'offscreen', interactive: false, role: 'link', name: '远处链接', rect: { x: -9000, y: 0, w: 40, h: 20 }, depth: 8 },
  { id: 'input', interactive: true, role: 'textbox', name: '关键词', rect: { x: 20, y: 140, w: 200, h: 30 }, depth: 5 },
  { id: 'blocked', interactive: true, role: 'button', name: '被遮挡', rect: { x: 20, y: 200, w: 80, h: 30 }, clickable: false, hitTest: 'blocked' },
];

function run(weights) {
  const scored = attachVomScores(NODES, weights ? { weights } : {});
  const ranked = rankVomNodes(scored);
  return {
    order: ranked.map((node) => node.id),
    scores: Object.fromEntries(ranked.map((node) => [node.id, Math.round(Number(node.vomScore) * 100) / 100])),
  };
}

const defaults = run();
const custom = run({ interactive: 200, semanticRole: 0, area: 0, depth: 0, offscreen: 0 });
const problems = [];
if (!['button', 'input'].includes(defaults.order[0])) problems.push('默认排序首位不是交互控件：' + defaults.order[0]);
if (!defaults.order.includes('blocked')) problems.push('遮挡节点被丢弃');
if (!['button', 'input'].includes(custom.order[0])) problems.push('自定义权重首位不是交互控件：' + custom.order[0]);
if (new Set(defaults.order).size !== NODES.length) problems.push('排序丢失/重复节点：' + JSON.stringify(defaults.order));
if (Number(defaults.scores.blocked) >= Number(defaults.scores.text)) problems.push('hidden 分数未低于普通文本：' + defaults.scores.blocked + ' >= ' + defaults.scores.text);

const update = process.argv.includes('--update');
let baseline = null;
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
} catch {
  baseline = null;
}
if (update) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify({ version: 1, nodes: NODES.length, ...defaults }, null, 2) + '\n', 'utf8');
  baseline = defaults;
}
if (baseline && !update) {
  if (JSON.stringify(baseline.order) !== JSON.stringify(defaults.order)) {
    problems.push('排序与基线不一致：' + JSON.stringify(baseline.order) + ' → ' + JSON.stringify(defaults.order));
  }
  for (const [id, score] of Object.entries(baseline.scores || {})) {
    const current = defaults.scores[id];
    if (!Number.isFinite(current) || Math.abs(current - Number(score)) > 0.01) {
      problems.push('分数漂移 ' + id + '：' + score + ' → ' + current);
    }
  }
}

console.log(JSON.stringify({ ok: problems.length === 0, baseline: Boolean(baseline), ...defaults, custom: custom.order, problems }, null, 2));
if (problems.length && process.argv.includes('--check')) process.exit(1);
