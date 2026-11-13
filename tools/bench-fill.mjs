#!/usr/bin/env node
// tools/bench-fill.mjs —— fill 单步热路径基准（IPC + CDP 往返）
//
// 用法：node tools/bench-fill.mjs --session <id> [--iterations 10] [--url file:///...]
// 输出：每次耗时、中位数、均值，以及一次 evaluate 的 IPC 基线。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'bridge.mjs');

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const session = option('--session');
const iterations = Math.max(1, Number(option('--iterations', '10')) || 10);
const url = option('--url', '');
const direct = args.includes('--direct');
if (!session) {
  console.error('需要 --session <id>');
  process.exit(2);
}

function daemonInfo() {
  const home = process.env.BB_HOME || path.join(os.homedir(), '.browser-bridge');
  return JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'));
}

async function rpc(method, params) {
  const info = daemonInfo();
  const started = process.hrtime.bigint();
  const response = await fetch('http://127.0.0.1:' + info.port + '/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': info.token },
    body: JSON.stringify({ method, params, timeoutMs: 60000 }),
  });
  const body = await response.json();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (!body.ok) throw new Error(method + ' failed: ' + JSON.stringify(body.error));
  return { ms, body };
}

async function run(argsList) {
  const started = process.hrtime.bigint();
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...argsList], {
    cwd: ROOT,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { ms, stdout };
}

const parse = (text) => {
  const lines = String(text).trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* 继续向上找 */ }
  }
  return null;
};

if (url) await run(['navigate', url, '--session', session, '--json']);

const ipc = [];
for (let i = 0; i < 3; i += 1) {
  const ms = direct
    ? (await rpc('evaluate', { session, expression: '(() => 1)()' })).ms
    : (await run(['evaluate', '(() => 1)()', '--session', session, '--json'])).ms;
  ipc.push(ms);
}

const fills = [];
for (let i = 0; i < iterations; i += 1) {
  const value = 'bench-' + i;
  let ms;
  if (direct) {
    ms = (await rpc('fill', { session, selector: 'input#name', value, trusted: true })).ms;
  } else {
    const result = await run(['fill', 'input#name', '--value', value, '--trusted', '--session', session, '--json']);
    const body = parse(result.stdout);
    if (!body || body.ok === false) throw new Error('fill failed: ' + result.stdout.slice(0, 300));
    ms = result.ms;
  }
  fills.push(ms);
}

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

console.log(JSON.stringify({
  iterations,
  ipcBaselineMs: { values: ipc.map((v) => +v.toFixed(1)), median: +median(ipc).toFixed(1) },
  fillMs: { values: fills.map((v) => +v.toFixed(1)), median: +median(fills).toFixed(1), min: +Math.min(...fills).toFixed(1), max: +Math.max(...fills).toFixed(1) },
}, null, 2));
