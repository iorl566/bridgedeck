#!/usr/bin/env node
// tools/compare/run.mjs —— 同一个夹具页、同一组任务，分别用 bsk CLI 与 BridgeDeck CLI 跑一遍。
//
// 用法：
//   node tools/compare/run.mjs --tool bsk    --run docs/comparison/runs/<id>
//   node tools/compare/run.mjs --tool bridge --run docs/comparison/runs/<id>
//   node tools/compare/report.mjs --run docs/comparison/runs/<id>
//
// 产出：<run>/<tool>.json（任务级 ok / 步数 / 耗时 / 原始输出片段）+ <run>/shots/<tool>-*.png
//
// 环境：Windows + Edge（158 已验证）。bsk 可执行文件取 .tmp/bsk-compare/bsk.exe（没有就从 ref 的 zip 解出来）；
// 两个工具各自使用独立的 Edge profile 与 daemon 端口，互不干扰。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(ROOT, '.tmp', 'compare');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EDGE = EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
const NODE = process.execPath;
const BRIDGE_CLI = path.join(ROOT, 'cli', 'bridge.mjs');
const BSK_EXE = path.join(ROOT, '.tmp', 'bsk-compare', 'bsk.exe');
const BSK_EXT = path.join(ROOT, '.tmp', 'bsk-compare', 'ext');
const BRIDGE_PORT = 53980;

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const TOOL = arg('--tool');
const RUN_DIR = path.resolve(ROOT, arg('--run', path.join('docs', 'comparison', 'runs', new Date().toISOString().replace(/[:.]/g, '-'))));
const KEEP = process.argv.includes('--keep');

if (!['bsk', 'bridge'].includes(TOOL)) {
  console.error('用法：node tools/compare/run.mjs --tool bsk|bridge --run <dir> [--keep]');
  process.exit(2);
}
if (!EDGE) {
  console.error('找不到 Edge（msedge.exe）');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 同步执行并返回 stdout/stderr/退出码/耗时，超时则杀掉。 */
function run(cmd, args, { env = {}, timeoutMs = 120000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(error?.message || error), ms: Date.now() - started, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), ms: Date.now() - started, timedOut });
    });
  });
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function waitFor(label, fn, timeoutMs = 90000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = String(error?.message || error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} 超时（${timeoutMs}ms）${last ? '：' + last : ''}`);
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* ignore */ }
}

function launchEdge(profileDir, extDir) {
  ensureDir(profileDir);
  const features = [
    // Edge/Chrome 137+ 会把 --load-extension 当成可疑开关；关掉该判定，保证 unpacked 扩展能装。
    'DisableLoadExtensionCommandLineSwitch',
    'FirstRunExperience',
    'msEdgeFirstRunExperience',
    'msEdgeSyncConsent',
    'msEdgeSyncFRE',
    'msEdgeIdentityFRE',
  ].join(',');
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-service-autorun',
    `--disable-features=${features}`,
    `--load-extension=${extDir}`,
    '--window-size=1280,900',
    'about:blank',
  ];
  const child = spawn(EDGE, args, { stdio: 'ignore', windowsHide: false, detached: false });
  console.log(`  edge pid=${child.pid} profile=${path.relative(ROOT, profileDir)}`);
  return child;
}

async function prepareBskExt() {
  if (fs.existsSync(path.join(BSK_EXT, 'manifest.json'))) return BSK_EXT;
  const zip = path.join(ROOT, 'ref', 'bsk-0.5.0-browser-skill-extension.zip');
  if (!fs.existsSync(zip)) throw new Error('缺少 bsk 扩展包：' + path.relative(ROOT, zip));
  ensureDir(BSK_EXT);
  const result = await run('tar', ['-xf', zip, '-C', BSK_EXT]);
  if (result.code !== 0) throw new Error('解压 bsk 扩展失败：' + result.stderr);
  return BSK_EXT;
}

function prepareBridgeExt(port) {
  const extDir = path.join(TMP, 'bridge-ext');
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'extension'), extDir, { recursive: true });
  const wsClient = path.join(extDir, 'src', 'ws-client.js');
  const source = fs.readFileSync(wsClient, 'utf8');
  const patched = source.replace(/const PORTS = \[[^\]]*\];/, `const PORTS = [${port}];`);
  if (patched === source) throw new Error('无法改写扩展探测端口（src/ws-client.js PORTS）');
  fs.writeFileSync(wsClient, patched, 'utf8');
  return extDir;
}

// ---------------------------------------------------------------- 工具适配器

const adapters = {
  bsk: {
    name: 'bsk',
    display: 'BSK 0.5.0',
    async setup() {
      if (!fs.existsSync(BSK_EXE)) throw new Error('缺少 .tmp/bsk-compare/bsk.exe（从 ref/bsk-0.5.0-bsk-windows-x64.zip 解出）');
      const home = path.join(TMP, 'bsk-home');
      fs.rmSync(home, { recursive: true, force: true });
      ensureDir(home);
      this.env = { BSK_HOME: home, BSK_AUTO_START: '0' };
      this.daemon = spawn(BSK_EXE, ['daemon', 'start', '--foreground'], {
        cwd: ROOT,
        env: { ...process.env, ...this.env },
        stdio: 'ignore',
        windowsHide: true,
      });
      await waitFor('bsk daemon 启动', () => fs.existsSync(path.join(home, 'daemon.json')));
      const extDir = await prepareBskExt();
      this.edge = launchEdge(path.join(TMP, 'bsk-profile'), extDir);
      await waitFor('bsk 扩展连接', async () => {
        const status = await this.cli(['status', '--json']);
        const json = parseJson(status.stdout);
        return json && Array.isArray(json.browsers) && json.browsers.length > 0;
      }, 120000);
    },
    async cli(args, options = {}) {
      return run(BSK_EXE, args, { ...options, env: { ...this.env, ...(options.env || {}) } });
    },
    async teardown() {
      try { await this.cli(['close'], { timeoutMs: 20000 }); } catch { /* ignore */ }
      killTree(this.daemon?.pid);
      killTree(this.edge?.pid);
      await sleep(1500);
    },
  },
  bridge: {
    name: 'bridge',
    display: 'BridgeDeck 0.3.1',
    async setup() {
      const home = path.join(TMP, 'bridge-home');
      fs.rmSync(home, { recursive: true, force: true });
      ensureDir(home);
      this.env = { BB_HOME: home, BB_PORT: String(BRIDGE_PORT), BB_NO_PROBE: '1' };
      const extDir = prepareBridgeExt(BRIDGE_PORT);
      await waitFor('bridge daemon 启动', async () => {
        const status = await this.cli(['status', '--json']);
        const json = parseJson(status.stdout);
        return json && json.ok === true;
      }, 60000);
      this.edge = launchEdge(path.join(TMP, 'bridge-profile'), extDir);
      await waitFor('BridgeDeck 扩展连接', async () => {
        const status = await this.cli(['status', '--json']);
        const json = parseJson(status.stdout);
        return json && json.result && Array.isArray(json.result.browsers) && json.result.browsers.length > 0;
      }, 120000);
    },
    async cli(args, options = {}) {
      return run(NODE, [BRIDGE_CLI, ...args], { ...options, env: { ...this.env, ...(options.env || {}) } });
    },
    async teardown() {
      try { await this.cli(['session', 'stop', '--all'], { timeoutMs: 20000 }); } catch { /* ignore */ }
      try { await this.cli(['daemon', 'stop'], { timeoutMs: 30000 }); } catch { /* ignore */ }
      killTree(this.edge?.pid);
      await sleep(1500);
    },
  },
};

// ---------------------------------------------------------------- 任务集

const FIXTURE = 'http://127.0.0.1:__FIXTURE_PORT__/test.html';

const tasks = [
  {
    id: 'T1',
    title: '打开页面并读取结构',
    async run(tool, ctx) {
      const open = tool.name === 'bsk'
        ? await tool.cli(['open', ctx.url, '--json'])
        : await tool.cli(['open', ctx.url, '--observe', '--json']);
      const text = open.stdout;
      const ok = open.code === 0 && text.includes('人员表') && text.includes('E2E 夹具页');
      return { ok, steps: 1, ms: open.ms, detail: ok ? '页面结构与人员表可见' : `退出码 ${open.code}；输出片段 ${text.slice(0, 300)}`, raw: text.slice(0, 4000) };
    },
  },
  {
    id: 'T2',
    title: '填表 + 提交 + 回读结果',
    async run(tool, ctx) {
      const steps = [];
      let total = 0;
      const call = async (args) => {
        const result = await tool.cli(args);
        steps.push({ args, code: result.code, ms: result.ms });
        total += result.ms;
        return result;
      };
      async function doSteps() {
        await call(['fill', '#kw', '--value', 'hello', '--json']);
        await call(['select', '#kind', '--value', 'b', '--json']);
        await call(['click', '#agree', '--json']);
        await call(['click', '#submit-btn', '--json']);
        return call(['read', '--selector', '#out', '--json']);
      }
      const read = await doSteps();
      const ok = read.code === 0 && read.stdout.includes('clicked:hello:b:yes');
      return {
        ok,
        steps: steps.length,
        ms: total,
        detail: ok ? '结果文本 clicked:hello:b:yes 与预期一致' : `回读失败：${read.stdout.slice(0, 400)} ${read.stderr.slice(0, 200)}`,
        raw: steps.map((s) => `${s.args.join(' ')} -> ${s.code} (${s.ms}ms)`).join('\n') + '\n' + read.stdout.slice(0, 2000),
      };
    },
  },
  {
    id: 'T3',
    title: '表格提取（人员表 3×3）',
    async run(tool, ctx) {
      const result = await tool.cli(['extract', 'table', '--selector', '#people', '--json']);
      const ok = result.code === 0 && ['张三', '北京', '李四', '上海', '王五', '深圳'].every((value) => result.stdout.includes(value));
      return { ok, steps: 1, ms: result.ms, detail: ok ? '6 个单元格值齐全' : `提取失败：${result.stdout.slice(0, 400)}`, raw: result.stdout.slice(0, 4000) };
    },
  },
  {
    id: 'T4',
    title: '视口截图落盘',
    async run(tool, ctx) {
      const out = path.join(ctx.runDir, 'shots', `${tool.name}-viewport.png`);
      ensureDir(path.dirname(out));
      fs.rmSync(out, { force: true });
      // bsk daemon 在受限沙箱里可能写不进仓库目录，先写临时目录再拷回来。
      const tmpOut = path.join(os.tmpdir(), `cmp-${tool.name}-${Date.now()}.png`);
      const result = await tool.cli(['screenshot', '--out', tmpOut, '--json']);
      const source = fs.existsSync(tmpOut) ? tmpOut : out;
      if (source !== out && fs.existsSync(source)) fs.copyFileSync(source, out);
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      const ok = result.code === 0 && size > 5000;
      return { ok, steps: 1, ms: result.ms, detail: ok ? `PNG ${size} 字节` : `截图失败：${result.stdout.slice(0, 300)}`, raw: result.stdout.slice(0, 1500) };
    },
  },
];

// ---------------------------------------------------------------- 主流程

async function main() {
  ensureDir(RUN_DIR);
  ensureDir(path.join(RUN_DIR, 'shots'));
  console.log(`\n${adapters[TOOL].display} → ${path.relative(ROOT, RUN_DIR)}`);

  // 夹具站点：独立进程，输出一行 JSON 后常驻。
  const fixture = spawn(NODE, [path.join(ROOT, 'tools', 'serve-fixture.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const fixtureInfo = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('夹具站点启动超时')), 20000);
    fixture.stdout.setEncoding('utf8');
    fixture.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((item) => item.trim().startsWith('{'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
  });
  const url = `http://127.0.0.1:${fixtureInfo.port}/test.html`;
  console.log(`  fixture ${url}`);

  const tool = adapters[TOOL];
  const record = {
    tool: tool.name,
    display: tool.display,
    startedAt: new Date().toISOString(),
    url,
    tasks: [],
    environment: {
      edge: EDGE,
      node: process.version,
      os: process.platform,
    },
  };

  try {
    await tool.setup();
    for (const task of tasks) {
      process.stdout.write(`  ${task.id} ${task.title} … `);
      let outcome;
      try {
        outcome = await task.run(tool, { url, runDir: RUN_DIR });
      } catch (error) {
        outcome = { ok: false, steps: 0, ms: 0, detail: `异常：${error.message}`, raw: '' };
      }
      record.tasks.push({ id: task.id, title: task.title, ...outcome });
      console.log(outcome.ok ? `OK (${outcome.ms}ms, ${outcome.steps} 步)` : `FAIL (${outcome.ms}ms)`);
      console.log(`     ${String(outcome.detail).slice(0, 200)}`);
    }
  } finally {
    await tool.teardown().catch(() => {});
    fixture.kill();
    record.finishedAt = new Date().toISOString();
    const okCount = record.tasks.filter((task) => task.ok).length;
    record.summary = { ok: okCount, total: record.tasks.length, totalMs: record.tasks.reduce((sum, task) => sum + (task.ms || 0), 0) };
    writeJson(path.join(RUN_DIR, `${TOOL}.json`), record);
    console.log(`\n  ${okCount}/${record.tasks.length} 通过，总耗时 ${record.summary.totalMs}ms → ${path.relative(ROOT, path.join(RUN_DIR, `${TOOL}.json`))}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
