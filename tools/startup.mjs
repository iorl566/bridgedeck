#!/usr/bin/env node
// tools/startup.mjs —— CLI 冷启动开销：多次 spawn `bridge help`，解析 BB_STARTUP_TRACE 阶段。
//
// 用法：node tools/startup.mjs [--runs N] [--json]
// 输出：module-body / main / args-parsed 的中位数与进程总耗时（wall）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const runsIdx = argv.indexOf('--runs');
const runs = runsIdx >= 0 ? Math.max(1, Number(argv[runsIdx + 1]) || 7) : 7;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const samples = [];
for (let i = 0; i < runs; i += 1) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'bridge.mjs'), 'help'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, BB_STARTUP_TRACE: '1' },
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.status !== 0) {
    console.error('startup 采样失败：exit ' + result.status + '\n' + (result.stderr || ''));
    process.exit(1);
  }
  const stages = {};
  for (const line of String(result.stderr || '').split(/\r?\n/)) {
    const match = /^\[startup\] ([\w-]+) (\d+)ms$/.exec(line.trim());
    if (match) stages[match[1]] = Number(match[2]);
  }
  samples.push({ stages, wallMs });
}

const keys = [...new Set(samples.flatMap((sample) => Object.keys(sample.stages)))].sort();
const summary = {
  runs,
  stages: Object.fromEntries(keys.map((key) => [key, median(samples.filter((s) => s.stages[key] != null).map((s) => s.stages[key]))])),
  wallMs: median(samples.map((s) => s.wallMs)),
};

if (json) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} else {
  console.log('BridgeDeck CLI 冷启动（' + runs + ' 次中位数）');
  console.log('  wall          ' + summary.wallMs.toFixed(1) + ' ms');
  for (const [key, value] of Object.entries(summary.stages)) console.log('  ' + key.padEnd(14) + value + ' ms');
}
