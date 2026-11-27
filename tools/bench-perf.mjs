#!/usr/bin/env node
// tools/bench-perf.mjs —— BridgeDeck 性能基准：CLI 单发 / plan 批量 / MCP 常驻 / daemon RPC。
//
// 用法：node tools/bench-perf.mjs [--out docs/comparison/performance.json]
// 依赖：Windows + Edge；会自起临时 daemon、浏览器与夹具站点，结束后清理。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp', 'bench-perf');
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
const NODE = process.execPath;
const CLi = path.join(ROOT, 'cli', 'bridge.mjs');
const PORT = 53991;
const outArg = process.argv.indexOf('--out');
const OUT = outArg >= 0 ? path.resolve(ROOT, process.argv[outArg + 1]) : path.join(ROOT, 'docs', 'comparison', 'performance.json');

if (!EDGE) {
  console.error('找不到 Edge');
  process.exit(2);
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const home = path.join(TMP, 'home');
fs.mkdirSync(home, { recursive: true });
const ext = path.join(TMP, 'ext');
fs.cpSync(path.join(ROOT, 'extension'), ext, { recursive: true });
const ws = path.join(ext, 'src', 'ws-client.js');
fs.writeFileSync(ws, fs.readFileSync(ws, 'utf8').replace(/const PORTS = \[[^\]]*\];/, `const PORTS = [${PORT}];`), 'utf8');
const env = { ...process.env, BB_HOME: home, BB_PORT: String(PORT), BB_NO_PROBE: '1' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const round = (n) => Math.round(n * 10) / 10;

function cli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(NODE, [CLi, ...args, '--json'], { cwd: ROOT, env: { ...env, ...extraEnv }, windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out, ms: performance.now() - started }));
  });
}

function rpc(method, params = {}) {
  const info = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'));
  const body = JSON.stringify({ method, params });
  return new Promise((resolve) => {
    const started = performance.now();
    const req = http.request({ host: '127.0.0.1', port: info.port, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-bridge-token': info.token } }, (res) => {
      res.resume();
      res.on('end', () => resolve(performance.now() - started));
    });
    req.on('error', () => resolve(performance.now() - started));
    req.end(body);
  });
}

const results = { at: new Date().toISOString(), platform: process.platform, node: process.version, cli: {}, rpc: {}, plan: {}, mcp: {} };

const fixture = spawn(NODE, [path.join(ROOT, 'tools', 'serve-fixture.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
const fixtureInfo = await new Promise((resolve) => {
  let buf = '';
  fixture.stdout.on('data', (chunk) => {
    buf += chunk;
    const m = buf.match(/\{.*\}/);
    if (m) resolve(JSON.parse(m[0]));
  });
});

await cli(['status']);
const edge = spawn(EDGE, [
  `--user-data-dir=${path.join(TMP, 'profile')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-features=DisableLoadExtensionCommandLineSwitch,FirstRunExperience,msEdgeFirstRunExperience,msEdgeSyncConsent,msEdgeSyncFRE,msEdgeIdentityFRE',
  `--load-extension=${ext}`, '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore', windowsHide: false });
for (let i = 0; i < 120; i += 1) {
  await sleep(1000);
  const state = await cli(['browsers']);
  if (/"browsers"\s*:\s*\[\s*\{/.test(state.out)) break;
}

const open = await cli(['open', fixtureInfo.url, '--observe']);
const match = /"sessionId"\s*:\s*"([^"]+)"/.exec(open.out);
const sessionId = match ? match[1] : null;

async function benchCli(name, args, times = 5) {
  const samples = [];
  let last = null;
  for (let i = 0; i < times; i += 1) {
    last = await cli(args);
    samples.push(last.ms);
  }
  results.cli[name] = { avgMs: round(avg(samples)), samples: samples.map(round), code: last ? last.code : null };
}

await benchCli('version', ['--version']);
await benchCli('observe', ['observe']);
await benchCli('read', ['read', '--selector', '#out']);
await benchCli('extract', ['extract', 'table', '--selector', '#people']);
await benchCli('click', ['click', '#more-link']);
await benchCli('screenshot', ['screenshot', '--out', path.join(TMP, 'shot.png')]);

// open 新建 vs 复用窗口
{
  const fresh = [];
  for (let i = 0; i < 3; i += 1) fresh.push((await cli(['open', fixtureInfo.url])).ms);
  results.cli['open(new)'] = { avgMs: round(avg(fresh)), samples: fresh.map(round) };
  const reuse = [];
  for (let i = 0; i < 3; i += 1) reuse.push((await cli(['open', fixtureInfo.url, '--reuse-window'])).ms);
  results.cli['open(reuse)'] = { avgMs: round(avg(reuse)), samples: reuse.map(round) };
}

// plan 批量：5 步一次调用
{
  const steps = [
    { method: 'fill', params: { selector: '#kw', value: 'hello' } },
    { method: 'select', params: { selector: '#kind', value: 'b' } },
    { method: 'click', params: { selector: '#agree' } },
    { method: 'click', params: { selector: '#submit-btn' } },
    { method: 'read', params: { selector: '#out' } },
  ];
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const run = await cli(['plan', '--steps', JSON.stringify(steps), '--session', sessionId]);
    samples.push(run.ms);
    results.plan.lastCode = run.code;
    results.plan.lastOut = run.out.slice(0, 300);
  }
  results.plan.avgMs = round(avg(samples));
  results.plan.samples = samples.map(round);
}

// daemon RPC 单独计时
for (const [name, method, params] of [
  ['observe', 'observe', {}],
  ['read', 'read', { selector: '#out' }],
  ['extract', 'extract.table', { selector: '#people' }],
  ['click', 'click', { selector: '#more-link' }],
]) {
  const samples = [];
  for (let i = 0; i < 5; i += 1) samples.push(await rpc(method, { ...params, sessionId }));
  results.rpc[name] = { avgMs: round(avg(samples)), samples: samples.map(round) };
}

// MCP 常驻：initialize → tools/list → tools/call 5 次
{
  const mcp = spawn(NODE, [path.join(ROOT, 'mcp', 'server.mjs')], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const rl = readline.createInterface({ input: mcp.stdout });
  let nextId = 1;
  const pending = new Map();
  rl.on('line', (line) => {
    let message = null;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const started = performance.now();
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bench', version: '0' } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  results.mcp.initializeMs = round(performance.now() - started);
  const listed = await request('tools/list', {});
  const tools = (listed.result && listed.result.tools) || [];
  results.mcp.tools = tools.length;
  const extractTool = tools.find((tool) => /extract.*table|table.*extract/i.test(tool.name)) || tools.find((tool) => /extract/i.test(tool.name));
  const target = extractTool || tools.find((tool) => /read|observe/i.test(tool.name));
  results.mcp.tool = target ? target.name : null;
  if (target) {
    const args = /extract/i.test(target.name) ? { selector: '#people' } : { selector: '#out' };
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const t = performance.now();
      const reply = await request('tools/call', { name: target.name, arguments: args });
      samples.push(performance.now() - t);
      results.mcp.lastCode = reply && reply.error ? 'error' : 'ok';
    }
    results.mcp.avgMs = round(avg(samples));
    results.mcp.samples = samples.map(round);
  }
  mcp.stdin.end();
  try { mcp.kill(); } catch { /* ignore */ }
}

spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
await cli(['daemon', 'stop']);
fixture.kill();
await sleep(400);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n', 'utf8');

console.log('CLI 单发（ms）');
for (const [name, value] of Object.entries(results.cli)) console.log('  ' + name.padEnd(12), value.avgMs);
console.log('daemon RPC（ms）');
for (const [name, value] of Object.entries(results.rpc)) console.log('  ' + name.padEnd(12), value.avgMs);
console.log('plan 批量 5 步（ms）', results.plan.avgMs, 'code=' + results.plan.lastCode);
console.log('MCP 常驻（ms）', 'initialize=' + results.mcp.initializeMs, 'tool=' + results.mcp.tool, 'call=' + results.mcp.avgMs, 'tools=' + results.mcp.tools);
console.log('→', path.relative(ROOT, OUT));
