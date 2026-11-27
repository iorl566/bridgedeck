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
import { web2Tasks } from './web2-tasks.mjs';
import { web3Tasks } from './web3-tasks.mjs';
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
      let first = await run(BSK_EXE, args, { ...options, env: { ...this.env, ...(options.env || {}) } });
      if (/still settling/i.test(first.stdout)) {
        await sleep(1200);
        first = await run(BSK_EXE, args, { ...options, env: { ...this.env, ...(options.env || {}) } });
      }
      if (first.code === 0 && !/observation_required|permission_denied/.test(first.stdout)) return first;
      // bsk 默认 strict：每个动作都要一次未使用过的 cooperate sync 观察。
      const sync = await run(BSK_EXE, ['sync', '--json'], { ...options, env: { ...this.env, ...(options.env || {}) } });
      let observationId = null;
      try {
        const parsed = JSON.parse(sync.stdout.slice(sync.stdout.indexOf('{')));
        observationId = parsed.observation_id || null;
      } catch {
        observationId = null;
      }
      if (!observationId) return first;
      return run(BSK_EXE, [...args, '--observation', observationId], { ...options, env: { ...this.env, ...(options.env || {}) } });
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

function webSession(stdout) {
  const json = parseJson(stdout);
  if (!json) return null;
  return (json.result && json.result.sessionId) || json.session_id || json.sessionId || null;
}

function withSession(args, sessionId) {
  if (!sessionId) return args;
  return [...args, '--session', String(sessionId)];
}

const tasks = [
  {
    id: 'T1',
    phase: 'e2e',
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
    phase: 'e2e',
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
      await call(['fill', '#kw', '--value', 'hello', '--json']);
      await call(['select', '#kind', '--value', 'b', '--json']);
      await call(['click', '#agree', '--json']);
      await call(['click', '#submit-btn', '--json']);
      const read = await call(['read', '--selector', '#out', '--json']);
      const ok = read.code === 0 && read.stdout.includes('clicked:hello:b:yes');
      return {
        ok,
        steps: steps.length,
        ms: total,
        detail: ok ? '结果文本 clicked:hello:b:yes 与预期一致' : `回读失败：${read.stdout.slice(0, 300)}`,
        raw: steps.map((s) => `${s.args.join(' ')} -> ${s.code} (${s.ms}ms)`).join('\n') + '\n' + read.stdout.slice(0, 1500),
      };
    },
  },
  {
    id: 'T3',
    phase: 'e2e',
    title: '基础表格提取（3×3）',
    async run(tool, ctx) {
      const result = await tool.cli(['extract', 'table', '--selector', '#people', '--json']);
      const ok = result.code === 0 && ['张三', '北京', '李四', '上海', '王五', '深圳'].every((value) => result.stdout.includes(value));
      return { ok, steps: 1, ms: result.ms, detail: ok ? '6 个单元格值齐全' : `提取失败：${result.stdout.slice(0, 300)}`, raw: result.stdout.slice(0, 3000) };
    },
  },
  {
    id: 'T4',
    phase: 'e2e',
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
      return { ok, steps: 1, ms: result.ms, detail: ok ? `PNG ${size} 字节` : `截图失败：${result.stdout.slice(0, 220)}`, raw: result.stdout.slice(0, 1200) };
    },
  },
  {
    id: 'T5',
    phase: 'e2e',
    title: '多行表头表格提取',
    async run(tool, ctx) {
      const result = await tool.cli(['extract', 'table', '--selector', '#multi-head', '--json']);
      const needed = ['等级', '金额', '小', '大', 'A', '1', '2', '3', '4'];
      const ok = result.code === 0 && needed.every((value) => result.stdout.includes(value));
      return { ok, steps: 1, ms: result.ms, detail: ok ? 'rowspan/colspan 表头与单元格齐全' : `提取不完整：${result.stdout.slice(0, 300)}`, raw: result.stdout.slice(0, 3000) };
    },
  },
  {
    id: 'T6',
    phase: 'e2e',
    title: 'closed shadow 按钮点击',
    async run(tool, ctx) {
      let clicked;
      if (tool.name === 'bsk') {
        let ref = null;
        for (const args of [['observe', '--json'], ['snapshot', '--json'], ['observe', '--closed-shadow', '--json']]) {
          const probe = await tool.cli(args);
          const parsed = parseJson(probe.stdout);
          let vom = '';
          if (parsed) {
            vom = parsed.text || (parsed.result && parsed.result.text) || (parsed.data && parsed.data.text) || '';
            if (!vom) vom = JSON.stringify(parsed);
          }
          const match = /(@e\d+)\s+button\s+"封闭按钮"/.exec(vom);
          if (match) { ref = match[1]; break; }
        }
        clicked = ref ? await tool.cli(['click', ref, '--json']) : { code: null, ms: 0, stdout: 'VOM 里没找到封闭按钮 ref' };
      } else {
        clicked = await tool.cli(['click', '--closed-shadow-text', '封闭按钮', '--json']);
      }
      const read = await tool.cli(['read', '--selector', '#closed-result', '--json']);
      const ok = read.code === 0 && read.stdout.includes('closed-clicked');
      return { ok, steps: 2, ms: (clicked.ms || 0) + read.ms, detail: ok ? 'closed shadow 内按钮点击生效' : `点击/回读失败：${(clicked.stdout || '').slice(0, 200)} | ${read.stdout.slice(0, 200)}`, raw: ((clicked.stdout || '') + '\n' + read.stdout).slice(0, 2500) };
    },
  },
  {
    id: 'T7',
    phase: 'e2e',
    title: '原生 confirm 对话框',
    async run(tool, ctx) {
      const clicked = await tool.cli(['click', '#dlg-confirm', '--json']);
      let dialogId = null;
      let operationId = null;
      const parsed = parseJson(clicked.stdout);
      const data = parsed && parsed.data ? parsed.data : null;
      if (data && data.dialog && data.dialog.id) {
        dialogId = String(data.dialog.id);
        operationId = data.operation_id || null;
      }
      if (!dialogId) {
        const list = await tool.cli(['dialog', 'list', '--json']);
        const parsedList = parseJson(list.stdout);
        const dialogs = (parsedList && (parsedList.dialogs || (parsedList.result && parsedList.result.dialogs))) || [];
        if (dialogs.length) dialogId = String(dialogs[0].id);
      }
      if (!dialogId) {
        return { ok: false, steps: 2, ms: clicked.ms || 0, detail: '点击后没有检测到待处理对话框', raw: clicked.stdout.slice(0, 600) };
      }
      const accept = await tool.cli(['dialog', 'accept', dialogId, '--json']);
      let opMs = 0;
      if (operationId) {
        const op = await tool.cli(['operation', 'await', operationId, '--json']);
        opMs = op.ms || 0;
      }
      await sleep(600);
      const read = await tool.cli(['read', '--selector', '#dlg-out', '--json']);
      const ok = read.code === 0 && read.stdout.includes('accepted');
      return { ok, steps: 3, ms: (clicked.ms || 0) + accept.ms + opMs + read.ms, detail: ok ? 'confirm 被接受，结果 accepted' : `对话框处理失败：${accept.stdout.slice(0, 200)} | ${read.stdout.slice(0, 200)}`, raw: ((clicked.stdout || '') + '\n' + accept.stdout + '\n' + read.stdout).slice(0, 2500) };
    },
  },
  {
    id: 'T8',
    phase: 'e2e',
    title: '文件上传',
    async run(tool, ctx) {
      const file = path.join(ctx.runDir, 'upload-sample.txt');
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, 'bridgedeck compare upload\n', 'utf8');
      const upload = tool.name === 'bsk'
        ? await tool.cli(['upload', '--selector', '#file', '--file', file, '--json'])
        : await tool.cli(['upload', '#file', '--file', file, '--json']);
      await sleep(600);
      const read = await tool.cli(['read', '--selector', '#file-out', '--json']);
      const ok = upload.code === 0 && read.stdout.includes('upload-sample.txt');
      return { ok, steps: 2, ms: upload.ms + read.ms, detail: ok ? 'file input 收到 upload-sample.txt' : `上传失败：${upload.stdout.slice(0, 200)} | ${read.stdout.slice(0, 200)}`, raw: (upload.stdout + '\n' + read.stdout).slice(0, 2500) };
    },
  },
  {
    id: 'R1',
    phase: 'real',
    title: '真实站点：example.com',
    async run(tool, ctx) {
      const args = tool.name === 'bsk' ? ['open', 'https://example.com/', '--json'] : ['open', 'https://example.com/', '--observe', '--json'];
      const open = await tool.cli(args);
      const ok = open.code === 0 && open.stdout.includes('Example Domain');
      return { ok, steps: 1, ms: open.ms, detail: ok ? 'VOM 中读到 Example Domain' : `失败：${open.stdout.slice(0, 240)}`, raw: open.stdout.slice(0, 2500) };
    },
  },
  {
    id: 'R2',
    phase: 'real',
    title: '真实站点：GitHub 仓库页',
    async run(tool, ctx) {
      const args = tool.name === 'bsk' ? ['open', 'https://github.com/iorl566/bridgedeck', '--json'] : ['open', 'https://github.com/iorl566/bridgedeck', '--observe', '--json'];
      const open = await tool.cli(args);
      const ok = open.code === 0 && open.stdout.includes('BridgeDeck');
      return { ok, steps: 1, ms: open.ms, detail: ok ? '仓库页标题/README 可读' : `失败：${open.stdout.slice(0, 240)}`, raw: open.stdout.slice(0, 3000) };
    },
  },
  {
    id: 'R3',
    phase: 'real',
    title: '真实站点：Microsoft Learn 文档',
    async run(tool, ctx) {
      const args = tool.name === 'bsk' ? ['open', 'https://learn.microsoft.com/en-us/microsoft-edge/extensions/', '--json'] : ['open', 'https://learn.microsoft.com/en-us/microsoft-edge/extensions/', '--observe', '--json'];
      const open = await tool.cli(args);
      const ok = open.code === 0 && open.stdout.includes('Microsoft Edge');
      return { ok, steps: 1, ms: open.ms, detail: ok ? '文档页可读' : `失败：${open.stdout.slice(0, 240)}`, raw: open.stdout.slice(0, 3000) };
    },
  },

  {
    id: 'W1',
    phase: 'web',
    title: '真实站点：example.com 读取标题',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://example.com/', '--json']);
      const sid = webSession(open.stdout);
      const probe = await tool.cli(withSession(['evaluate', "document.body.innerText.includes('Example Domain')", '--json'], sid));
      const ok = open.code === 0 && probe.stdout.includes('true');
      return { ok, steps: 2, ms: open.ms + probe.ms, detail: ok ? '页面包含 Example Domain' : `失败：${open.stdout.slice(0, 160)} | ${probe.stdout.slice(0, 200)}`, raw: (open.stdout + '\n' + probe.stdout).slice(0, 2000) };
    },
  },
  {
    id: 'W2',
    phase: 'web',
    title: '真实站点：点击链接并跳转（example → iana）',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://example.com/', '--json']);
      const sid = webSession(open.stdout);
      const click = await tool.cli(withSession(['click', 'a', '--json'], sid));
      await sleep(2000);
      const href = await tool.cli(withSession(['evaluate', 'location.href', '--json'], sid));
      const ok = open.code === 0 && click.code === 0 && /iana\.org/.test(href.stdout);
      return { ok, steps: 3, ms: open.ms + click.ms + href.ms, detail: ok ? '跳转到 iana.org' : `失败：${click.stdout.slice(0, 160)} | ${href.stdout.slice(0, 200)}`, raw: (click.stdout + '\n' + href.stdout).slice(0, 2000) };
    },
  },
  {
    id: 'W3',
    phase: 'web',
    title: '真实站点：httpbin 表单填写并提交',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://httpbin.org/forms/post', '--json']);
      const sid = webSession(open.stdout);
      const fill = tool.name === 'bsk'
        ? await tool.cli(withSession(['fill', '--selector', 'input[name="custname"]', '--value', 'BridgeDeck', '--json'], sid))
        : await tool.cli(withSession(['fill', 'input[name="custname"]', '--value', 'BridgeDeck', '--json'], sid));
      const click = await tool.cli(withSession(['click', 'form button', '--json'], sid));
      await sleep(2500);
      const probe = await tool.cli(withSession(['evaluate', "document.body.innerText.includes('BridgeDeck')", '--json'], sid));
      const ok = open.code === 0 && fill.code === 0 && click.code === 0 && probe.stdout.includes('true');
      return { ok, steps: 4, ms: open.ms + fill.ms + click.ms + probe.ms, detail: ok ? '提交后页面包含 BridgeDeck' : `失败：${fill.stdout.slice(0, 140)} | ${click.stdout.slice(0, 140)} | ${probe.stdout.slice(0, 160)}`, raw: (fill.stdout + '\n' + click.stdout + '\n' + probe.stdout).slice(0, 2500) };
    },
  },
  {
    id: 'W4',
    phase: 'web',
    title: '真实站点：Microsoft Learn 整页截图',
    async run(tool, ctx) {
      const url = 'https://learn.microsoft.com/en-us/microsoft-edge/extensions/';
      const open = await tool.cli(['open', url, '--json']);
      const sid = webSession(open.stdout);
      const out = path.join(ctx.runDir, 'shots', `${tool.name}-full.png`);
      ensureDir(path.dirname(out));
      const tmpOut = path.join(os.tmpdir(), `web-${tool.name}-${Date.now()}.png`);
      const shot = tool.name === 'bsk'
        ? await tool.cli(withSession(['screenshot', '--full-page', '--timeout', '120s', '--out', tmpOut, '--json'], sid))
        : await tool.cli(withSession(['screenshot', '--mode', 'auto', '--timeout', '120s', '--out', tmpOut, '--json'], sid));
      const source = fs.existsSync(tmpOut) ? tmpOut : out;
      if (source !== out && fs.existsSync(source)) fs.copyFileSync(source, out);
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      const ok = open.code === 0 && shot.code === 0 && size > 20000;
      return { ok, steps: 2, ms: open.ms + shot.ms, detail: ok ? `整页 PNG ${size} 字节` : `失败：${shot.stdout.slice(0, 200)} (size=${size})`, raw: shot.stdout.slice(0, 1500) };
    },
  },
  {
    id: 'W5',
    phase: 'web',
    title: '真实站点：MDN 滚动 + 键盘',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/table', '--json']);
      const sid = webSession(open.stdout);
      const scroll = await tool.cli(withSession(['evaluate', 'window.scrollTo(0, 1200); window.scrollY', '--json'], sid));
      const press = await tool.cli(withSession(['press', 'Escape', '--json'], sid));
      const ok = open.code === 0 && scroll.code === 0 && press.code === 0 && !/error/i.test(scroll.stdout);
      return { ok, steps: 3, ms: open.ms + scroll.ms + press.ms, detail: ok ? '滚动与按键均成功' : `失败：${scroll.stdout.slice(0, 160)} | ${press.stdout.slice(0, 160)}`, raw: (scroll.stdout + '\n' + press.stdout).slice(0, 1500) };
    },
  },
  {
    id: 'W6',
    phase: 'web',
    title: '真实站点：Edge 商店页读取',
    async run(tool, ctx) {
      const url = 'https://microsoftedge.microsoft.com/addons/detail/ieflpefpmlmmlfgmpfakaglhgmcbcnig';
      const open = await tool.cli(['open', url, '--json']);
      const sid = webSession(open.stdout);
      const probe = await tool.cli(withSession(['evaluate', "document.body.innerText.toLowerCase().includes('bridgedeck')", '--json'], sid));
      const ok = open.code === 0 && probe.stdout.includes('true');
      return { ok, steps: 2, ms: open.ms + probe.ms, detail: ok ? '商店页包含 BridgeDeck' : `失败：${open.stdout.slice(0, 160)} | ${probe.stdout.slice(0, 200)}`, raw: (open.stdout + '\n' + probe.stdout).slice(0, 2000) };
    },
  },
];
tasks.push(...web2Tasks);
tasks.push(...web3Tasks);


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
    const phase = arg('--phase', 'all');
    const selected = tasks.filter((task) => phase === 'all' || task.phase === phase);
    for (const task of selected) {
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
