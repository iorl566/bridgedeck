#!/usr/bin/env node
// tools/e2e.mjs — BridgeDeck端到端验收：真实 Edge + 真实扩展 + 真实 daemon/CLI。
//
// 流程：静态页服务 → 临时 BB_HOME 起 daemon → 独立 user-data-dir 起 Edge 并加载 extension/
//       → CLI 跑 session start / navigate / observe / fill / click / get-html / evaluate /
//         screenshot / session stop，逐项断言。
//
// 用法（node 需用绝对路径，见 README）：
//   node tools/e2e.mjs [--browser edge|chrome] [--port 53907] [--keep] [--ext-dir <dir>]
//   --ext-dir 默认 repo 根 extension/；架构路线用它可以对 TS 产物（apps/extension/.output/chrome-mv3）跑同一套验收。
// 退出码：0 全通过，1 有失败。
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import readline from 'node:readline';
import { browserArgs, prepareBrowserProfile } from './browser-launch.mjs';
import { analyzeMp4 } from '../extension/src/lib/mp4-boxes.js';
import { compatibilityReport } from '../lib/protocol-features.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.argv[0]; // 当前 node 可执行文件
const CLI = path.join(ROOT, 'cli', 'bridge.mjs');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const browser = opt('--browser', 'edge');
const EXT_DIR = path.resolve(opt('--ext-dir', path.join(ROOT, 'extension')));
if (browser !== 'edge') process.env.BB_E2E_FORCE_A11Y = '1';
const keep = args.includes('--keep');
// 默认每次 E2E 都同步 README 截图；需要保持工作树干净时设 BB_E2E_SYNC_DOCS=0。
const SYNC_DOCS = process.env.BB_E2E_SYNC_DOCS !== '0';

const BROWSER_PATHS = (() => {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const local = process.env.LOCALAPPDATA || '';
  const programs = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programsX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  if (process.platform === 'win32') {
    return {
      edge: [`${programsX86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${programs}\\Microsoft\\Edge\\Application\\msedge.exe`],
      chrome: [`${programs}\\Google\\Chrome\\Application\\chrome.exe`, `${programsX86}\\Google\\Chrome\\Application\\chrome.exe`],
      brave: [`${programs}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${local}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`],
      vivaldi: [`${local}\\Vivaldi\\Application\\vivaldi.exe`, `${programs}\\Vivaldi\\Application\\vivaldi.exe`],
      opera: [`${local}\\Programs\\Opera\\opera.exe`, `${programs}\\Opera\\opera.exe`],
      arc: [`${local}\\Programs\\Arc\\Arc.exe`, `${programs}\\Arc\\Arc.exe`],
      helium: [`${local}\\Programs\\Helium\\helium.exe`, `${programs}\\Helium\\helium.exe`],
    };
  }
  if (process.platform === 'darwin') {
    return {
      edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')],
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')],
      brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      vivaldi: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'],
      opera: ['/Applications/Opera.app/Contents/MacOS/Opera'],
      arc: ['/Applications/Arc.app/Contents/MacOS/Arc'],
      helium: ['/Applications/Helium.app/Contents/MacOS/Helium'],
    };
  }
  return {
    edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    brave: ['/usr/bin/brave-browser', '/opt/brave.com/brave/brave'],
    vivaldi: ['/usr/bin/vivaldi', '/opt/vivaldi/vivaldi'],
    opera: ['/usr/bin/opera', '/usr/lib/x86_64-linux-gnu/opera/opera'],
    arc: ['/usr/bin/arc'],
    helium: ['/usr/bin/helium', '/opt/helium/helium'],
  };
})();

function browserCandidates(name) {
  const override = process.env['BB_BROWSER_' + String(name || '').toUpperCase()];
  if (override) return [override];
  return BROWSER_PATHS[String(name || '').toLowerCase()] || [];
}


function findBrowser(name) {
  for (const candidate of browserCandidates(name)) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    const commands = name === 'edge' ? ['microsoft-edge', 'microsoft-edge-stable'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
    for (const command of commands) {
      const found = spawnSync('which', [command], { encoding: 'utf8' });
      if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
    }
  }
  return browserCandidates(name)[0];
}

const BROWSER_EXE = findBrowser(browser);

const results = [];
const E2E_FILTER = (process.env.BB_E2E_FILTER || '').split(',').map((item) => item.trim()).filter(Boolean);
const E2E_ALWAYS = ['2.', '3.', '4.'];
function check(name, fn) {
  if (E2E_FILTER.length && !E2E_ALWAYS.some((prefix) => name.startsWith(prefix)) && !E2E_FILTER.some((prefix) => name.startsWith(prefix))) {
    return Promise.resolve(true);
  }
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail }); console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); return true; })
    .catch((err) => { results.push({ name, ok: false, detail: err.message }); console.log(`  FAIL  ${name} — ${err.message}`); return false; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function uiaClick(name) {
  const script = path.join(ROOT, 'tools', 'uia-click.ps1');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Name', name], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跳过不是通过：记录为未完成，最终必须让 E2E 失败，避免假绿。 */
function skip(name, reason) {
  results.push({ name, ok: false, skipped: true, detail: reason });
  console.log(`  SKIP  ${name} — ${reason}`);
}

/** 找一个空闲端口（优先用偏好的端口）。 */
async function pickPort(preferred) {
  const tryBind = (port) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
  if (await tryBind(preferred)) return preferred;
  for (let p = preferred + 1; p <= preferred + 20; p++) if (await tryBind(p)) return p;
  // 不用 52900-52909：那是生产扩展的探测段，会让日常浏览器扩展连进测试 daemon。
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const assigned = srv.address().port;
      srv.close(() => resolve(assigned));
    });
  });
}

// ---------------------------------------------------------------- 静态夹具服务
let crossPort = 0;
// 真实服务端副作用计数器：network replay 每次真的重发请求，命中数必须递增（证明不是缓存/伪造）。
let replayHits = 0;
const fixtureHandler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/script-mock') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end('window.__modifiedScript = true;');
    return;
  }
  if (url.pathname === '/api/script') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end('window.__realScript = true;');
    return;
  }
  if (url.pathname === '/api/image') {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'no-store' });
    res.end(png);
    return;
  }
  if (url.pathname === '/api/download') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="sample.txt"',
      'cache-control': 'no-store',
    });
    res.end('browser-bridge download sample\n');
    return;
  }
  if (url.pathname === '/api/ping') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }
  if (url.pathname === '/api/replay-count') {
    replayHits += 1;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, hit: replayHits, at: Date.now() }));
    return;
  }
  const file = url.pathname === '/' ? 'test.html' : url.pathname.replace(/^\//, '');
  const full = path.join(ROOT, 'tests', 'fixtures', file);
  if (!existsSync(full)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  const body = readFileSync(full, 'utf8').split('__XFRAME_PORT__').join(String(crossPort || 0));
  res.end(body);
};
const fixtureServer = createServer(fixtureHandler);
const crossServer = createServer(fixtureHandler);

// ---------------------------------------------------------------- 环境准备
const workRoot = mkdtempSync(path.join(tmpdir(), 'bb-e2e-'));
const bbHome = path.join(workRoot, 'home');
const profileDir = path.join(workRoot, 'profile');
const outDir = path.join(workRoot, 'out');
mkdirSync(bbHome, { recursive: true });
mkdirSync(profileDir, { recursive: true });
prepareBrowserProfile(profileDir);
mkdirSync(outDir, { recursive: true });

const staticPort = await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', () => resolve(fixtureServer.address().port)));
crossPort = await new Promise((resolve) => crossServer.listen(0, '127.0.0.1', () => resolve(crossServer.address().port)));
const port = await pickPort(Number(opt('--port', 53907)));
const pageUrl = `http://127.0.0.1:${staticPort}/test.html`;

// 测试扩展：复制一份并把 WS 探测端口限制成本次 daemon 的端口。
// 生产扩展会探测 52900-52909；如果用户日常浏览器也装了这个扩展，它会连进测试 daemon，
// 抢走 session 默认实例、并在 settings.set 广播时被改设置。复制并改写端口后，测试与日常浏览器隔离。
const testExtDir = path.join(workRoot, 'extension');
cpSync(EXT_DIR, testExtDir, { recursive: true });
const testWsClient = path.join(testExtDir, 'src', 'ws-client.js');
const wsSource = readFileSync(testWsClient, 'utf8');
const wsPatched = wsSource.replace(/const PORTS = \[[^\]]*\];/, `const PORTS = [${port}];`);
if (wsPatched === wsSource) throw new Error('无法改写测试扩展的探测端口（src/ws-client.js 的 PORTS 行）');
writeFileSync(testWsClient, wsPatched, 'utf8');

console.log('BridgeDeck E2E');
console.log(`  repo      ${ROOT}`);
console.log(`  daemon    port=${port} BB_HOME=${bbHome}`);
console.log(`  fixture   ${pageUrl}`);
console.log(`  browser   ${browser} (${BROWSER_EXE})`);
console.log(`  profile   ${profileDir}\n`);

// ---------------------------------------------------------------- 浏览器进程
let browserProc = null;
// 扩展需要真实浏览器窗口（MV3 扩展不能跑 headless），所以始终有头启动。
const BROWSER_ARGS = (p) => browserArgs({
  profileDir: p,
  extensionDir: testExtDir,
  windowSize: '1280,900',
});

async function launchBrowser() {
  const exe = BROWSER_EXE;
  if (!existsSync(exe)) throw new Error(`找不到浏览器：${exe}`);
  if (!existsSync(path.join(testExtDir, 'manifest.json'))) throw new Error('测试扩展目录缺少 manifest.json（extension/ 还没交付？）');
  const baseArgs = BROWSER_ARGS(profileDir);
  let args = baseArgs;
  let stdio = 'ignore';
  if (browser === 'chrome') {
    // Chrome 137+ 的品牌版忽略 --load-extension；改走 CDP pipe 的
    // Extensions.loadUnpacked（需要 --enable-unsafe-extension-debugging）。
    args = baseArgs.filter((arg) => !arg.startsWith('--load-extension='));
    args.push('--remote-debugging-pipe', '--enable-unsafe-extension-debugging');
    stdio = ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'];
  }
  // 注意：windowsHide 会让 Edge 主窗口以 SW_HIDE 启动，用户看不到调试页面；
  // 这里必须保持可见（浏览器是 GUI，不是控制台子进程）。
  const proc = spawn(exe, args, { stdio, windowsHide: false, detached: false });
  proc.on('error', (e) => console.log(`  browser spawn error: ${e.message}`));
  if (browser === 'chrome') await loadChromeExtensionViaPipe(proc);
  return proc;
}

/** 通过 Chrome CDP pipe 加载 unpacked 扩展；成功返回扩展 ID。 */
function loadChromeExtensionViaPipe(proc) {
  return new Promise((resolve, reject) => {
    const input = proc.stdio[3];
    const output = proc.stdio[4];
    if (!input || !output) return reject(new Error('Chrome CDP pipe 不可用'));
    let buffer = '';
    const timer = setTimeout(() => {
      output.removeAllListeners('data');
      reject(new Error('Chrome Extensions.loadUnpacked 超时'));
    }, 30000);
    output.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\0');
      buffer = parts.pop();
      for (const part of parts) {
        if (!part.trim()) continue;
        let message;
        try { message = JSON.parse(part); } catch { continue; }
        if (message.id !== 1) continue;
        clearTimeout(timer);
        output.removeAllListeners('data');
        if (message.error) reject(new Error('Chrome 加载扩展失败：' + JSON.stringify(message.error)));
        else resolve(message.result && message.result.id);
        return;
      }
    });
    input.write(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: testExtDir } }) + '\0');
  });
}
/** 关掉浏览器并等它真的退出（否则 profile 目录还被占着，删不掉）。 */
async function killBrowser() {
  if (!browserProc || browserProc.killed) return;
  const proc = browserProc;
  const exited = new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', resolve);
    setTimeout(resolve, 5000);
  });
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  await exited;
  await sleep(200);
}

/** Windows 上进程刚退出时文件仍可能被短暂占用，带重试地删目录。 */
async function removeDirWithRetry(dir) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return true;
    } catch {
      await sleep(300);
    }
  }
  return false;
}

// ---------------------------------------------------------------- CLI 调用
// 必须异步：夹具页 HTTP 服务跑在本进程里，用 spawnSync 会堵死事件循环，
// 导致浏览器请求夹具页时永远等不到响应、导航 30s 超时（曾因此整条 e2e 失败）。
function cli(args, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, BB_HOME: bbHome, BB_PORT: String(port), BB_NO_PROBE: '1' },
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
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    const settle = (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    };
    child.on('error', (error) => { stderr += String((error && error.message) || error); settle(null); });
    child.on('close', (code) => settle(code));
  });
}
async function assertSessionAlive(label) {
  const st = await cliJson(['status']);
  const sessions = (st.json && (st.json.sessions || (st.json.result && st.json.result.sessions))) || [];
  if (sessions.some((item) => item.sessionId === sessionId)) return;
  let tail = '';
  try {
    tail = readFileSync(path.join(bbHome, 'daemon.log'), 'utf8').split(/\r?\n/).slice(-10).join('\n');
  } catch { /* log may be gone */ }
  throw new Error(`${label}: session ${sessionId} disappeared; daemon log tail:\n${tail}`);
}
async function cliJson(args, opts) {
  const r = await cli([...args, '--json'], opts);
  let parsed = null;
  const line = r.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  if (line) { try { parsed = JSON.parse(line); } catch { /* 留给调用方报告原文 */ } }
  return { ...r, json: parsed };
}
function expectOk(r, what) {
  assert(r.json, `${what}: 输出不是 JSON（stdout=${JSON.stringify(r.stdout).slice(0, 400)} stderr=${JSON.stringify(r.stderr).slice(0, 400)}）`);
  assert(r.json.ok === true, `${what}: 失败 ${JSON.stringify(r.json.error)}`);
  return r.json.result;
}

/**
 * 直连 daemon 的 /rpc（真实 daemon 通道 + 真实 token）。
 * 少数命令的 CLI JSON 只保留 0.3.0 字段（例如 longshot recover 会裁剪扩展原始证据），
 * 这里读原始结果是为了断言扩展真的产出了 shard/restore 证据，不替代 CLI 用例。
 */
function rpcDirect(method, params = {}, timeoutMs = 60000) {
  const info = JSON.parse(readFileSync(path.join(bbHome, 'daemon.json'), 'utf8'));
  const payload = JSON.stringify({ method, params, timeoutMs });
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: info.port,
      path: '/rpc',
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-bridge-token': info.token,
      },
      timeout: Math.max(timeoutMs, 10000) + 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 留给调用方报告原文 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('rpcDirect 超时：' + method)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function startMcp(env) {
  const proc = spawn(NODE, [path.join(ROOT, 'mcp', 'server.mjs')], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let seq = 0;
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry.resolve(message);
  });
  proc.stderr.on('data', () => {});
  function rpc(method, params) {
    const id = ++seq;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP 响应超时: ' + method)), 30000);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject,
      });
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  }
  return {
    proc,
    rpc,
    close() {
      try {
        proc.kill();
      } catch {
        // 忽略
      }
    },
  };
}

async function waitBrowser(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cliJson(['browsers'], { timeoutMs: 20000 });
    if (state.json && state.json.ok && state.json.result && state.json.result.browsers && state.json.result.browsers.length) {
      return true;
    }
    await sleep(400);
  }
  throw new Error('等待浏览器连接超时（' + timeoutMs + 'ms）');
}

let sessionId = null;
let killSignal = false;

/** 取当前 observation 文本（失败即抛）。 */
async function observationText() {
  const r = await cliJson(['observe', '--session', sessionId]);
  return expectOk(r, 'observe').observation || '';
}
/** 从 observation 文本里按 aria role（可加名称提示）找一个 @eN ref。 */
function pickRef(text, role, nameHint) {
  const line = text.split(/\r?\n/).find((l) => new RegExp(`^\\s*-\\s*${role}`, 'i').test(l) && (!nameHint || l.includes(nameHint)));
  const m = line && line.match(/\[@(e\d+)\]/);
  return m ? m[1] : null;
}
async function cleanup() {
  if (sessionId) { try { await cli(['session', 'stop', sessionId]); } catch { /* ignore */ } sessionId = null; }
  try { await cli(['daemon', 'stop'], { timeoutMs: 20000 }); } catch { /* ignore */ }
  await killBrowser();
  await new Promise((r) => fixtureServer.close(r));
  await new Promise((r) => crossServer.close(r));
  if (!keep) {
    if (!(await removeDirWithRetry(workRoot))) console.log(`  （临时目录清理失败，可手动删除：${workRoot}）`);
  }
}
process.on('SIGINT', async () => { killSignal = true; await cleanup(); process.exit(130); });

// ---------------------------------------------------------------- 主流程
// 前三步是前置条件：任一失败就直接终止，否则后面 9 项只会连锁爆 E_NO_SESSION 掩盖真正原因。
const LOAD_HINT =
  browser === 'chrome'
    ? '（Chrome 137+ 品牌版已忽略 --load-extension；E2E 会自动用 CDP Extensions.loadUnpacked 加载，失败时检查 --enable-unsafe-extension-debugging 是否生效）'
    : '';
try {
  if (!(await check('1. 启动 daemon 并连通（CLI 自动拉起）', async () => {
    const r = await cliJson(['status']);
    const st = expectOk(r, 'status');
    assert(typeof st.port === 'number' && st.port === port, `daemon 端口应为 ${port}，实际 ${st.port}`);
    return `pid=${st.pid} port=${st.port} version=${st.version}`;
  }))) throw new Error('前置条件失败：daemon 未就绪，终止验收');

  if (!(await check('2. 启动浏览器并等扩展连上', async () => {
    browserProc = await launchBrowser();
    let last = null;
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      const r = await cliJson(['browsers']);
      if (r.json?.ok && (r.json.result.browsers || []).length > 0) {
        const b = r.json.result.browsers[0];
        return `${b.browser} ${b.browserVersion} ext=${b.extVersion} instance=${b.instanceId}`;
      }
      last = r;
    }
    throw new Error(
      `40s 内扩展未连上 ${LOAD_HINT}。最后一次 browsers 输出：${JSON.stringify(last?.stdout || '').slice(0, 500)} ${last?.stderr || ''}`,
    );
  }))) throw new Error(`前置条件失败：浏览器没连上扩展 ${LOAD_HINT}，终止验收`);

  if (!(await check('3. session start（开 agent 窗口，默认不抢焦点）', async () => {
    const r = await cliJson(['session', 'start']);
    const res = expectOk(r, 'session start');
    sessionId = res.sessionId;
    assert(/^[a-z]{4}$/.test(sessionId), `sessionId 应为 4 位小写字母，实际 ${sessionId}`);
    assert(Number.isInteger(res.tabId), 'tabId 缺失');
    const st = expectOk(await cliJson(['status']), 'status after start');
    const row = (st.sessions || []).find((item) => item.sessionId === sessionId);
    assert(row && row.phase === 'active', 'session phase 不是 active：' + JSON.stringify(row));
    const windows = expectOk(await cliJson(['window', 'list', '--session', sessionId]), 'window list after start');
    const agentWindow = (windows.windows || []).find((win) => win.windowId === res.windowId);
    assert(agentWindow, '找不到新建的 Agent Window');
    assert(agentWindow.focused === false, 'session start 默认不应聚焦 Agent Window：' + JSON.stringify(agentWindow));
    return `session=${sessionId} tab=${res.tabId} window=${res.windowId} focus=false`;
  }))) throw new Error('前置条件失败：session 未建立，终止验收');

  await check('4. navigate 到本地夹具页', async () => {
    const r = await cliJson(['navigate', pageUrl, '--session', sessionId]);
    const res = expectOk(r, 'navigate');
    assert((res.url || '').includes('test.html'), `url 未生效：${res.url}`);
    return res.url;
  });

  let textboxRef = null;
  let buttonRef = null;
  await check('5. observe 输出语义树与 @eN ref', async () => {
    const text = await observationText();
    assert(text.includes('E2E 夹具页'), 'observation 里没有页面 heading 文本');
    assert(/textbox/i.test(text), 'observation 里没有 textbox');
    assert(/button/i.test(text), 'observation 里没有 button');
    assert(/\[@e\d+\]/.test(text), 'observation 里没有 @eN ref');
    assert(!text.includes('默认不可见的文本'), 'observe 输出了 display:none 的文本');
    textboxRef = pickRef(text, 'textbox') || pickRef(text, 'input');
    buttonRef = pickRef(text, 'button', '提交') || pickRef(text, 'button');
    assert(textboxRef, `没在 observation 里找到 textbox ref，原文：\n${text}`);
    assert(buttonRef, `没在 observation 里找到 button ref，原文：\n${text}`);
    return `textbox=@${textboxRef} button=@${buttonRef} lines=${text.split(/\r?\n/).length}`;
  });

  await check('5b. observe --vom 返回结构化节点', async () => {
    const res = expectOk(await cliJson(['observe', '--vom', '--session', sessionId]), 'observe --vom');
    assert(Array.isArray(res.nodes) && res.nodes.length > 0, 'vom nodes 为空：' + JSON.stringify(res).slice(0, 500));
    const button = res.nodes.find((node) => String(node.role || '').toLowerCase() === 'button');
    assert(button, 'vom 里没有 button：' + JSON.stringify(res.nodes.slice(0, 3)));
    assert(typeof button.name === 'string' && button.name.length > 0, 'vom button 没有 name');
    assert(button.ref && /^@e\d+$/.test(button.ref), 'vom button 没有 ref：' + JSON.stringify(button));
    const negotiated = expectOk(await cliJson(['refs', 'negotiate', button.stableRef, '--session', sessionId]), 'refs negotiate');
    assert(negotiated.refs && negotiated.refs[0] && negotiated.refs[0].ok === true && negotiated.refs[0].ref === button.ref, 'stableRef 协商失败：' + JSON.stringify(negotiated));
    assert(button.rect && Number.isFinite(button.rect.w) && Number.isFinite(button.rect.h), 'vom rect 不合法：' + JSON.stringify(button.rect));
    const textbox = res.nodes.find((node) => String(node.role || '').toLowerCase() === 'textbox');
    assert(textbox && textbox.rect, 'vom 里没有 textbox/rect');
    assert(textbox.inForm === true, 'vom textbox 应标记 inForm：' + JSON.stringify(textbox));
    assert(textbox.inputState === 'empty', 'vom textbox 初始 inputState 应为 empty：' + JSON.stringify(textbox.inputState));
    assert(button.clickable === true, 'vom button 应标记 clickable：' + JSON.stringify(button.clickable));
    assert(Number.isInteger(button.paintOrder), 'vom button 缺少 paintOrder：' + JSON.stringify(button.paintOrder));
    assert(typeof res.ariaSnapshot === 'string' && /- (button|link|textbox)/.test(res.ariaSnapshot), 'vom ariaSnapshot 缺失：' + JSON.stringify(res.ariaSnapshot));
    assert(res.semantic && res.semantic.version >= 1 && res.semantic.stats.members > 0, 'vom semantic graph 缺失：' + JSON.stringify(res.semantic && res.semantic.stats));
    if (process.env.BB_E2E_DUMP_VOM) {
      writeFileSync(path.resolve(process.env.BB_E2E_DUMP_VOM), JSON.stringify({
        url: res.url || pageUrl,
        title: res.title || '',
        viewport: res.viewport || { width: 1280, height: 800 },
        nodes: res.nodes,
      }, null, 2) + '\n', 'utf8');
    }
    assert(res.vomWeights && res.vomWeights.billing && res.vomWeights.billing.totalTokens > 0, 'vom billing 缺失：' + JSON.stringify(res.vomWeights && res.vomWeights.billing));
    assert(res.vomWeights.billing.groups > 0 && res.vomWeights.billing.grouped > 0, 'billing 未关联 semantic groups：' + JSON.stringify(res.vomWeights.billing));
    const altBilling = expectOk(await cliJson(['observe', '--vom', '--vom-billing-model', 'chars-per-4', '--session', sessionId]), 'observe billing model');
    assert(altBilling.vomWeights.billing.model === 'chars-per-4', 'vom billing model 没有生效：' + JSON.stringify(altBilling.vomWeights.billing));
    const o200kBilling = expectOk(await cliJson(['observe', '--vom', '--vom-billing-model', 'o200k', '--session', sessionId]), 'observe o200k billing');
    assert(o200kBilling.vomWeights.billing.model === 'o200k' && o200kBilling.vomWeights.billing.totalTokens > 0, 'o200k billing 没有生效：' + JSON.stringify(o200kBilling.vomWeights.billing));
    assert(o200kBilling.vomWeights.estimatedTokens === o200kBilling.vomWeights.billing.totalTokens, 'estimatedTokens 未使用 o200k 账本：' + JSON.stringify({ estimated: o200kBilling.vomWeights.estimatedTokens, billing: o200kBilling.vomWeights.billing.totalTokens }));
    const contextual = expectOk(await cliJson(['observe', '--vom', '--vom-semantic-max-groups', '2', '--vom-group-context', '--session', sessionId]), 'observe group context');
    assert(contextual.vomWeights.semanticFiltered && typeof contextual.vomWeights.semanticFiltered.contextGroups === 'number', 'vom group context 没有生效：' + JSON.stringify(contextual.vomWeights.semanticFiltered));
    const semanticFiltered = expectOk(await cliJson(['observe', '--vom', '--vom-semantic-max-groups', '1', '--session', sessionId]), 'observe semantic filter');
    assert(semanticFiltered.vomWeights.semanticFiltered && semanticFiltered.vomWeights.semanticFiltered.groups >= 1, 'vom semantic filter 没有生效：' + JSON.stringify(semanticFiltered.vomWeights.semanticFiltered));
    const semanticTokens = expectOk(await cliJson(['observe', '--vom', '--vom-semantic-max-tokens', '100', '--session', sessionId]), 'observe semantic tokens');
    assert(semanticTokens.vomWeights.semanticFiltered && semanticTokens.vomWeights.semanticFiltered.tokensUsed >= 0, 'vom semantic token budget 没有生效：' + JSON.stringify(semanticTokens.vomWeights.semanticFiltered));
    assert(semanticTokens.vomWeights.budgetPlan && semanticTokens.vomWeights.budgetPlan.nodes >= 0 && typeof semanticTokens.vomWeights.budgetPlan.tokens === 'number', 'vom budgetPlan 缺失：' + JSON.stringify(semanticTokens.vomWeights.budgetPlan));
    assert(res.nodes.every((node) => Number.isInteger(node.vomScore)), 'vom 节点缺少 vomScore：' + JSON.stringify(res.nodes.slice(0, 2)));
    const ranked = expectOk(await cliJson(['observe', '--vom', '--vom-rank', '--session', sessionId]), 'observe vom-rank');
    assert(ranked.vomWeights && ranked.vomWeights.ranked === true, 'vom-rank 没有生效');
    const custom = expectOk(await cliJson(['observe', '--vom', '--vom-weights', 'interactive=100,text=2', '--session', sessionId]), 'observe vom-weights');
    assert(custom.vomWeights && Array.isArray(custom.vomWeights.custom) && custom.vomWeights.custom.includes('interactive'), 'vom-weights 没有生效：' + JSON.stringify(custom.vomWeights));
    const topN = expectOk(await cliJson(['observe', '--vom', '--vom-rank', '--vom-top', '10', '--session', sessionId]), 'observe vom-top');
    assert(topN.nodes.length <= 10 && topN.vomWeights.top === 10 && topN.vomWeights.tokenSafetyFactor === 1.1 && Number.isInteger(topN.vomWeights.estimatedTokens) && topN.vomWeights.estimatedTokens > 0, 'vom-top/token factor 没有生效：' + JSON.stringify({ count: topN.nodes.length, weights: topN.vomWeights }));
    const minScored = expectOk(await cliJson(['observe', '--vom', '--vom-min-score', '20', '--session', sessionId]), 'observe vom-min-score');
    assert(minScored.nodes.length > 0 && minScored.nodes.every((node) => node.vomScore >= 20) && minScored.vomWeights.minScore === 20, 'vom-min-score 没有生效：' + JSON.stringify({ count: minScored.nodes.length, score: minScored.nodes[0] && minScored.nodes[0].vomScore }));
    const budgeted = expectOk(await cliJson(['observe', '--vom', '--vom-rank', '--vom-max-nodes', '10', '--session', sessionId]), 'observe vom budget');
    assert(budgeted.nodes.length <= 10 && budgeted.vomWeights.budget && budgeted.vomWeights.budget.nodes > 0, 'vom 预算没有生效：' + JSON.stringify({ count: budgeted.nodes.length, budget: budgeted.vomWeights.budget }));
    const explained = expectOk(await cliJson(['observe', '--vom', '--vom-explain', '--session', sessionId]), 'observe vom-explain');
    const explainValues = Object.values(explained.vomExplain || {});
    assert(explainValues.length > 0 && explainValues.some((factors) => Array.isArray(factors) && factors.some((factor) => typeof factor.score === 'number')), 'vom-explain 没有因素明细：' + JSON.stringify(explained.vomExplain).slice(0, 200));
    const compact = expectOk(await cliJson(['observe', '--vom', '--vom-profile', 'compact', '--session', sessionId]), 'observe vom-profile');
    assert(compact.nodes.length <= 80 && compact.vomWeights.profile === 'compact' && compact.vomWeights.minScore === 20, 'vom-profile compact 没有生效：' + JSON.stringify({ count: compact.nodes.length, weights: compact.vomWeights }));
    const grouped = expectOk(await cliJson(['observe', '--vom', '--vom-rank', '--vom-per-group', '2', '--session', sessionId]), 'observe vom-per-group');
    assert(grouped.vomWeights.perGroup === 2 && grouped.vomWeights.compacted, 'vom-per-group 没有生效：' + JSON.stringify({ count: grouped.nodes.length, weights: grouped.vomWeights }));
    const groupTokens = expectOk(await cliJson(['observe', '--vom', '--vom-rank', '--vom-per-group', '3', '--vom-group-tokens', '30', '--session', sessionId]), 'observe vom-group-tokens');
    assert(groupTokens.vomWeights.groupTokens === 30 && groupTokens.vomWeights.compacted, 'vom-group-tokens 没有生效：' + JSON.stringify({ count: groupTokens.nodes.length, weights: groupTokens.vomWeights }));
    const visibleOnly = expectOk(await cliJson(['observe', '--vom', '--vom-exclude-hidden', '--session', sessionId]), 'observe vom-exclude-hidden');
    assert(visibleOnly.vomWeights.excludeHidden === true && visibleOnly.nodes.length <= res.nodes.length, 'vom-exclude-hidden 没有生效：' + JSON.stringify({ count: visibleOnly.nodes.length, weights: visibleOnly.vomWeights }));
    const draggable = res.nodes.find((node) => node.dragHint === 'draggable');
    assert(draggable, 'vom 里没有 draggable 节点：' + JSON.stringify({ total: res.nodes.length, tags: [...new Set(res.nodes.map((node) => node.tag))].slice(0, 20), drag: res.nodes.filter((node) => node.dragHint).length }));
    assert(typeof draggable.name === 'string' && draggable.name.length > 0, 'draggable 节点缺少 name');
    return 'nodes=' + res.nodes.length + ' button=' + button.ref;
  });

  await check('5b2. observe --vom-deep 六阶段过滤 + 绘制序 + token 预算', async () => {
    const deep = expectOk(await cliJson(['observe', '--vom-deep', '--session', sessionId]), 'observe vom-deep');
    const data = deep.deepVom;
    assert(data && Array.isArray(data.nodes) && data.nodes.length >= 1, 'deepVom 没有节点：' + JSON.stringify(deep.issues));
    assert(data.stages.collected >= data.stages.emitted, '漏斗 collect 计数不对：' + JSON.stringify(data.stages));
    assert(data.stages.sorted === 'paint-order' && Number.isInteger(data.stages.tokens), 'deepVom 阶段元数据不完整：' + JSON.stringify(data.stages));
    assert(data.vomFunnel && data.vomFunnel.collected >= data.vomFunnel.emitted && Array.isArray(data.vomFunnel.droppedReasons), 'deepVom 缺少漏斗摘要：' + JSON.stringify(data.vomFunnel));
    const refs = data.nodes.filter((node) => typeof node.ref === 'string');
    assert(refs.length >= 1 && refs.every((node) => /^@e[0-9]+$/.test(node.ref)), 'deepVom 交互节点没有 ref：' + JSON.stringify(data.nodes.filter((node) => node.interactive).slice(0, 3)));
    const ys = data.nodes.map((node) => Number(node.rect && node.rect.y));
    assert(ys.every((value, index) => index === 0 || value >= ys[index - 1]), 'deepVom 不是绘制序：' + JSON.stringify(ys.slice(0, 5)));
    return 'nodes=' + data.nodes.length + ' tokens=' + data.stages.tokens;
  });

  await check('5i. upload 文件事务：CDP setFileInputFiles', async () => {
    const file = path.join(outDir, 'upload.txt');
    writeFileSync(file, 'bridge-upload', 'utf8');
    const uploaded = expectOk(await cliJson(['upload', '#file', '--file', file, '--session', sessionId]), 'upload file');
    assert(uploaded.effectState === 'committed', '上传事务字段不对：' + JSON.stringify(uploaded));
    const got = expectOk(await cliJson(['evaluate', 'document.getElementById("file").files.length', '--session', sessionId]), 'upload read');
    assert(Number(got.value) >= 1, '文件没有写入 input：' + JSON.stringify(got));
    const mcp = startMcp({ ...process.env, BB_HOME: bbHome, BB_PORT: String(port), BB_NO_PROBE: '1' });
    try {
      await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e' } });
      const mcpUpload = await mcp.rpc('tools/call', { name: 'browser_upload', arguments: { target: '#hidden-file', files: [file], session: sessionId } });
      assert(mcpUpload.result.isError === false, 'MCP upload 失败：' + String(mcpUpload.result.content[0].text).slice(0, 160));
    } finally {
      mcp.close();
    }
    const hidden = expectOk(await cliJson(['evaluate', 'document.getElementById("hidden-file").files.length', '--session', sessionId]), 'upload read hidden');
    assert(Number(hidden.value) >= 1, 'MCP 文件没有写入 hidden input：' + JSON.stringify(hidden));
    return 'uploaded files=' + got.value;
  });

  await check('5c. observe --ax 返回 AX 树 + --vom 合并', async () => {
    const res = expectOk(await cliJson(['observe', '--vom', '--ax', '--session', sessionId]), 'observe --vom --ax');
    const nodes = res.axNodes || [];
    assert(nodes.length > 0, 'AX 树为空：' + JSON.stringify(res).slice(0, 300));
    const button = nodes.find((node) => node.role === 'button' && String(node.name || '').includes('提交查询'));
    assert(button, 'AX 里没有提交按钮：' + JSON.stringify(nodes.slice(0, 5)));
    const textbox = nodes.find((node) => node.role === 'textbox' && String(node.name || '').includes('搜索关键词'));
    assert(textbox, 'AX 里没有搜索输入框：' + JSON.stringify(nodes.filter((node) => node.role === 'textbox').slice(0, 3)));
    assert(res.axJoin && res.axJoin.matched > 0, 'AX 与 DOM 没有合并：' + JSON.stringify(res.axJoin));
    assert(res.axJoin.byBackendNodeId > 0, 'AX join 没有走 backendNodeId：' + JSON.stringify(res.axJoin));
    const joinedButton = (res.nodes || []).find((node) => node.role === 'button' && String(node.name || '').includes('提交查询'));
    assert(joinedButton && joinedButton.ax && joinedButton.ax.role === 'button', 'DOM button 未带上 AX 信息：' + JSON.stringify(joinedButton));
    assert(Number.isInteger(joinedButton.backendNodeId), 'DOM button 缺少 backendNodeId：' + JSON.stringify(joinedButton.backendNodeId));
    return 'ax=' + nodes.length + ' matched=' + res.axJoin.matched + ' backend=' + res.axJoin.byBackendNodeId + ' button=' + joinedButton.ref;
  });

  await check('5d. DOMSnapshot 事实：几何 / 可见性 / 可点击', async () => {
    const res = expectOk(await cliJson(['observe', '--vom', '--ax', '--facts', '--session', sessionId]), 'observe --facts');
    assert(res.facts && res.facts.nodes > 0, 'DOMSnapshot 事实为空：' + JSON.stringify(res.facts));
    assert(res.facts.axMatched > 0, 'AX 节点未匹配到事实：' + JSON.stringify(res.facts));
    const button = (res.axNodes || []).find((node) => node.role === 'button' && String(node.name || '').includes('提交查询'));
    assert(button && button.bounds && button.bounds.width > 0, 'AX 按钮缺少 geometry：' + JSON.stringify(button));
    assert(button.visible === true, 'AX 按钮应可见：' + JSON.stringify(button));
    return 'nodes=' + res.facts.nodes + ' axMatched=' + res.facts.axMatched + ' vomMatched=' + res.facts.vomMatched;
  });

  await check('5d2. observe --vom --facts 直接富化结构化节点', async () => {
    const res = expectOk(await cliJson(['observe', '--vom', '--facts', '--session', sessionId]), 'observe --vom --facts');
    assert(res.facts && res.facts.vomMatched > 0, 'VOM 节点未匹配到事实：' + JSON.stringify(res.facts));
    const node = (res.nodes || []).find((item) => item && item.bounds && Number.isInteger(item.backendNodeId));
    assert(node, 'VOM 节点缺少 bounds/backendNodeId：' + JSON.stringify((res.nodes || []).slice(0, 3)));
    assert(typeof node.visible === 'boolean', 'VOM 节点缺少 visible：' + JSON.stringify(node));
    assert(typeof node.domPaintOrder === 'number', 'VOM 节点缺少 domPaintOrder：' + JSON.stringify(node));
    return 'vomMatched=' + res.facts.vomMatched + ' node=' + node.role + ' ' + node.bounds.width + 'x' + node.bounds.height;
  });

  await check('5e. observe --fallback-ax：AX 兜底观察（无 ref）', async () => {
    const res = expectOk(await cliJson(['observe', '--fallback-ax', '--session', sessionId]), 'observe --fallback-ax');
    assert(res.fallback === 'ax', '应标记 fallback=ax：' + JSON.stringify(res).slice(0, 300));
    assert(res.refs === 0, '兜底观察不应有 ref：' + JSON.stringify(res.refs));
    assert(typeof res.observation === 'string' && res.observation.includes('- '), '兜底文本为空：' + JSON.stringify(res.observation));
    return 'fallback=ax lines=' + res.observation.split('\n').length;
  });

  await check('5f. observe --ax --vom 补充未映射的可交互元素（closed shadow）', async () => {
    expectOk(await cliJson([
      'evaluate',
      "const h=document.createElement('div');h.id='__ax_only_host';h.style='position:fixed;left:20px;top:20px;z-index:99999';" +
        "const s=h.attachShadow({mode:'closed'});const b=document.createElement('button');b.textContent='AX only button';" +
        "b.onclick=()=>{window.__axClicks=(window.__axClicks||0)+1};s.appendChild(b);document.body.appendChild(h);'ok'",
      '--session', sessionId,
    ]), 'inject closed shadow');
    await sleep(300);
    const res = expectOk(await cliJson(['observe', '--ax', '--vom', '--facts', '--session', sessionId]), 'observe --ax --vom --facts');
    assert(Array.isArray(res.unmappedAx), '缺少 unmappedAx 数组：' + JSON.stringify(res).slice(0, 300));
    const target = res.unmappedAx.find((item) => item && item.name === 'AX only button');
    assert(target, 'closed-shadow 按钮未出现在 unmappedAx：' + JSON.stringify(res.unmappedAx));
    assert(Number.isInteger(target.backendNodeId), '未映射元素缺少 backendNodeId');
    assert(target.bounds && target.bounds.width > 0, '未映射元素缺少几何：' + JSON.stringify(target));
    assert(!res.observation.includes('[@e' + target.backendNodeId + ']'), '未映射元素不应带 ref');
    assert(res.observation.includes('未映射的可交互元素'), '文本缺少未映射段');
    const clicked = expectOk(await cliJson(['click-backend', '--backend', String(target.backendNodeId), '--session', sessionId]), 'click-backend');
    assert(clicked.via === 'cdp-backend' && clicked.trusted === true, 'click-backend 结果不对：' + JSON.stringify(clicked));
    const counter = expectOk(await cliJson(['evaluate', 'window.__axClicks || 0', '--session', sessionId]), 'click counter');
    assert(counter.value === 1, 'closed-shadow 按钮没有被点到：' + JSON.stringify(counter));
    await cliJson(['evaluate', "document.getElementById('__ax_only_host')?.remove();'ok'", '--session', sessionId]);
    return 'unmapped=' + res.unmappedAx.length + ' target=AX only button click=ok';
  });

  await check('5g. observe --compare-ax 双跑对照', async () => {
    const res = expectOk(await cliJson(['observe', '--compare-ax', '--vom', '--session', sessionId]), 'observe --compare-ax');
    const cmp = res.pipelineCompare;
    assert(cmp && cmp.pageLib && cmp.ax, '缺少 pipelineCompare：' + JSON.stringify(res).slice(0, 300));
    assert(cmp.pageLib.refs > 0 && cmp.pageLib.lines > 0, 'page-lib 指标不对：' + JSON.stringify(cmp.pageLib));
    assert(cmp.ax.nodes > 0 && cmp.ax.lines > 0, 'AX 指标不对：' + JSON.stringify(cmp.ax));
    assert(cmp.interactiveTotal > 0, '交互元素统计为 0：' + JSON.stringify(cmp));
    assert(cmp.matched <= cmp.interactiveTotal, 'matched 越界：' + JSON.stringify(cmp));
    assert(typeof cmp.axCoverage === 'number' && cmp.axCoverage >= 0 && cmp.axCoverage <= 1, 'axCoverage 不对：' + JSON.stringify(cmp));
    assert(typeof res.observation === 'string' && res.observation.length > 0, '默认观察文本不应为空');
    return 'pageLib=' + cmp.pageLib.lines + '行 ax=' + cmp.ax.lines + '行 coverage=' + cmp.axCoverage;
  });

  await check('5h. observe --pipeline ax 备用采集器', async () => {
    const res = expectOk(await cliJson(['observe', '--pipeline', 'ax', '--session', sessionId]), 'observe --pipeline ax');
    assert(res.pipeline === 'ax', 'pipeline 标记不对：' + JSON.stringify(res).slice(0, 200));
    assert(res.refs === 0, 'AX 管线不应有 ref：' + res.refs);
    assert(Array.isArray(res.nodes) && res.nodes.length > 0, 'AX 管线没有节点');
    const withBounds = res.nodes.filter((node) => node && node.bounds);
    assert(withBounds.length > 0, 'AX 管线没有几何信息');
    const interactive = res.nodes.filter((node) => node && node.interactive);
    assert(interactive.length > 0, 'AX 管线没有交互节点');
    assert(typeof res.observation === 'string' && res.observation.length > 0, 'AX 管线文本为空');
    return 'nodes=' + res.nodes.length + ' interactive=' + interactive.length + ' bounds=' + withBounds.length;
  });

  await check('6. fill 填输入框', async () => {
    const r = await cliJson(['fill', `@${textboxRef}`, '--value', 'hello bridge', '--session', sessionId]);
    const filled = expectOk(r, 'fill');
    assert(filled.matches === true, 'fill 读回 matches 不为 true：' + JSON.stringify(filled));
    assert(filled.expected_value === 'hello bridge' && filled.effectState === 'committed', 'fill 事务字段不对：' + JSON.stringify(filled));
    return '@' + textboxRef + ' ← "hello bridge"';
  });

  await check('6b. observe --vom --facts 表单值事实', async () => {
    expectOk(await cliJson(['evaluate', "document.getElementById('pw').value='secret';'ok'", '--session', sessionId]), 'seed password');
    const res = expectOk(await cliJson(['observe', '--vom', '--facts', '--session', sessionId]), 'observe form facts');
    const kw = (res.nodes || []).find((node) => node && node.id === 'kw');
    assert(kw && kw.domValue === 'hello bridge', 'kw.domValue 不对：' + JSON.stringify(kw));
    assert(kw.formStateStale !== true, 'kw 不应标记 stale：' + JSON.stringify(kw.formStateStale));
    const pw = (res.nodes || []).find((node) => node && node.id === 'pw');
    assert(pw && pw.domValue === '********', 'password 未遮蔽：' + JSON.stringify(pw));
    assert(!JSON.stringify(res.nodes || []).includes('"secret"'), '密码明文泄漏到 observe 结果');
    const agree = (res.nodes || []).find((node) => node && node.id === 'agree');
    if (agree) assert(agree.domChecked === false || agree.domChecked === undefined, 'agree.domChecked 初始值不对：' + JSON.stringify(agree));
    return 'kw=hello bridge pw=masked';
  });

  await check('6c. observe --ax --vom 表格结构事实', async () => {
    const res = expectOk(await cliJson(['observe', '--ax', '--vom', '--session', sessionId]), 'observe table facts');
    assert(Array.isArray(res.tables) && res.tables.length > 0, '缺少 tables 汇总：' + JSON.stringify(res.tables));
    const table = (res.tables || []).find((item) => Array.isArray(item.headers) && item.headers.includes('姓名') && item.headers.includes('城市'));
    assert(table, '表格表头不对：' + JSON.stringify(res.tables));
    const axCells = (res.axNodes || []).filter((node) => node && node.table && Number.isInteger(node.table.row) && Number.isInteger(node.table.col));
    assert(axCells.length > 0, 'AX 节点缺少表格坐标：' + JSON.stringify(res.tables));
    return 'tables=' + res.tables.length + ' axCells=' + axCells.length;
  });

  await check('6d. observe --ax --vom 阻挡层事实', async () => {
    expectOk(await cliJson([
      'evaluate',
      "const d=document.createElement('div');d.id='__e2e_dialog';d.setAttribute('role','dialog');d.setAttribute('aria-label','E2E dialog');" +
        "d.style='position:fixed;inset:10%;z-index:2147483646;background:rgba(0,0,0,.2)';document.body.appendChild(d);'ok'",
      '--session', sessionId,
    ]), 'inject dialog');
    await sleep(300);
    const res = expectOk(await cliJson(['observe', '--ax', '--vom', '--facts', '--session', sessionId]), 'observe blocking layers');
    assert(Array.isArray(res.blockingLayers) && res.blockingLayers.length > 0, '缺少 blockingLayers：' + JSON.stringify(res).slice(0, 300));
    const layer = res.blockingLayers.find((item) => item && item.name === 'E2E dialog');
    assert(layer, '未识别注入的 dialog：' + JSON.stringify(res.blockingLayers));
    assert(layer.coverage > 0.25, '阻挡层覆盖面积不对：' + JSON.stringify(layer));
    const under = (res.nodes || []).filter((node) => node && node.underBlockingLayer);
    assert(under.length > 0, '阻挡层内的节点缺少 underBlockingLayer：' + JSON.stringify(res.blockingLayers));
    await cliJson(['evaluate', "document.getElementById('__e2e_dialog')?.remove();'ok'", '--session', sessionId]);
    return 'layers=' + res.blockingLayers.length + ' coverage=' + layer.coverage + ' under=' + under.length;
  });

  await check('7. select 选项 + click 按钮', async () => {
    const text = await observationText();
    const comboRef = pickRef(text, 'combobox');
    let selectNote = 'no-combobox';
    if (comboRef) {
      const r = await cliJson(['select', `@${comboRef}`, '--value', 'b', '--session', sessionId]);
      if (r.json?.ok) selectNote = `@${comboRef}=b`;
      else selectNote = `select 失败（不阻塞主断言）：${JSON.stringify(r.json?.error || r.stderr).slice(0, 120)}`;
    }
    const r = await cliJson(['click', `@${buttonRef}`, '--session', sessionId]);
    let clickResult;
    if (!r.json?.ok && /E_STALE_REF/.test(JSON.stringify(r.json))) {
      const fresh = await observationText();
      const m = pickRef(fresh, 'button', '提交') || pickRef(fresh, 'button');
      assert(m, `重新 observe 后仍找不到提交按钮：\n${fresh}`);
      buttonRef = m;
      clickResult = expectOk(await cliJson(['click', `@${m}`, '--session', sessionId]), 'click(retry)');
    } else {
      clickResult = expectOk(r, 'click');
    }
    assert(clickResult.effectState === 'committed', '成功动作应带 effectState=committed：' + JSON.stringify(clickResult));
    assert(clickResult.via === 'cdp-backend', '主文档 ref 未自动补 backendNodeId：' + JSON.stringify(clickResult));
    return `${selectNote} click=@${buttonRef} effect=committed`;
  });

  await check('7b. stableRef 驱动动作', async () => {
    const obs = expectOk(await cliJson(['observe', '--vom', '--force', '--session', sessionId]), 'observe stable');
    const detail = (obs.refDetails || []).find((item) => item.stableRef && item.ref);
    assert(detail, 'observe 没有 stableRef：nodes=' + obs.nodeCount + ' refs=' + (obs.refs) + ' details=' + JSON.stringify((obs.refDetails || []).slice(0, 3)));
    const clicked = expectOk(await cliJson(['click', '--stable-ref', detail.stableRef, '--session', sessionId]), 'click stableRef');
    assert(clicked.via === 'cdp-backend', 'stableRef 未走 CDP：' + JSON.stringify(clicked));
    return 'stableRef=' + detail.stableRef + ' via=' + clicked.via;
  });

  await check('8. get-html 读回结果（#out 变成 clicked:...）', async () => {
    const r = await cliJson(['get-html', '--selector', '#out', '--session', sessionId]);
    const res = expectOk(r, 'get-html');
    const html = res.html || '';
    assert(html.includes('clicked:hello bridge'), `#out 内容不符：${JSON.stringify(html).slice(0, 300)}`);
    return html.replace(/\s+/g, ' ').slice(0, 120);
  });

  await check('8b. stableRef 驱动 fill/select/read/actionable（跨观察身份）', async () => {
    const obs = expectOk(await cliJson(['observe', '--vom', '--force', '--session', sessionId]), 'observe stable fill');
    const details = obs.refDetails || [];
    const textbox = details.find((item) => item.stableRef && item.role === 'textbox' && /关键词/.test(String(item.name || '')))
      || details.find((item) => item.stableRef && item.role === 'textbox');
    assert(textbox, '没有 textbox 的 stableRef：' + JSON.stringify(details.slice(0, 6)));
    expectOk(await cliJson(['fill', '--stable-ref', textbox.stableRef, '--value', 'stable-fill', '--session', sessionId]), 'fill stableRef');
    const read = expectOk(await cliJson(['read', '--selector', '#kw', '--session', sessionId]), 'read stable fill');
    assert(read.fields[0].value === 'stable-fill', 'stableRef fill 没写入：' + JSON.stringify(read.fields[0]));

    let selectNote = 'no-combobox';
    const combo = details.find((item) => item.stableRef && item.role === 'combobox');
    if (combo) {
      expectOk(await cliJson(['select', '--stable-ref', combo.stableRef, '--value', 'b', '--session', sessionId]), 'select stableRef');
      const kind = expectOk(await cliJson(['read', '--selector', '#kind', '--session', sessionId]), 'read stable select');
      assert(kind.fields[0].value === 'b', 'stableRef select 没生效：' + JSON.stringify(kind.fields[0]));
      selectNote = 'select=b';
    }
    const actionable = await cliJson(['actionable', '--stable-ref', textbox.stableRef, '--session', sessionId]);
    assert(actionable.code === 0, 'actionable stableRef 失败：' + JSON.stringify(actionable.json));
    return 'fill + ' + selectNote + ' + actionable';
  });

  await check('9. evaluate 读 document.title', async () => {
    const r = await cliJson(['evaluate', 'document.title', '--session', sessionId]);
    const res = expectOk(r, 'evaluate');
    const value = typeof res.value === 'string' ? res.value : JSON.stringify(res.value);
    assert(value && value.includes('夹具页'), `title 不符：${value}`);
    return value;
  });

  await check('10. screenshot 落盘 PNG', async () => {
    const shot = path.join(outDir, 'shot.png');
    const r = await cliJson(['screenshot', '--out', shot, '--session', sessionId]);
    expectOk(r, 'screenshot');
    assert(existsSync(shot), 'screenshot 没写出文件');
    const buf = readFileSync(shot);
    assert(buf.length > 5000, `PNG 太小：${buf.length} 字节`);
    const magic = buf.subarray(0, 8).toString('hex');
    assert(magic === '89504e470d0a1a0a', `PNG 魔数不对：${magic}`);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert(width > 100 && height > 100, `截图尺寸过小：${width}x${height}`);
    return `${width}x${height} ${buf.length} 字节`;
  });

  await check('11. session stop 后无残留 session', async () => {
    expectOk(await cliJson(['session', 'stop', sessionId]), 'session stop');
    sessionId = null;
    const r = await cliJson(['session', 'list']);
    const res = expectOk(r, 'session list');
    assert((res.sessions || []).length === 0, `还有 ${res.sessions.length} 个 session`);
    return 'sessions=0';
  });

  await check('12. status 汇总', async () => {
    const r = await cliJson(['status']);
    const st = expectOk(r, 'status');
    assert(Array.isArray(st.inflight), 'status 缺少 inflight 列表');
    assert(Array.isArray(st.queues), 'status 缺少 queues 列表');
    return `browsers=${(st.browsers || []).length} sessions=${(st.sessions || []).length} inflight=${st.inflight.length} queues=${st.queues.length}`;
  });

  // ---------------------------------------------------------------- v0.2 能力面
  await check('13. settings：借用确认受安全策略保护', async () => {
    const rejected = await cliJson(['settings', 'set', '--borrow-confirm', 'off']);
    assert(rejected.code !== 0, 'CLI 不应允许关闭借用确认');
    assert(rejected.json && rejected.json.error && rejected.json.error.code === 'E_FORBIDDEN', '错误码应为 E_FORBIDDEN：' + JSON.stringify(rejected.json));
    const view = expectOk(await cliJson(['settings']), 'settings get');
    assert(view.settings.borrowConfirm === true, '默认 borrowConfirm 应为 true');
    return 'E_FORBIDDEN（只能由扩展设置页修改）';
  });

  await check('14. 第二个 session + read', async () => {
    sessionId = expectOk(await cliJson(['session', 'start']), 'session start').sessionId;
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'navigate');
    expectOk(await cliJson(['fill', '#kw', '--value', 'read-me', '--session', sessionId]), 'fill');
    const read = expectOk(await cliJson(['read', '--selector', '#kw', '--session', sessionId]), 'read');
    assert(read.fields[0].value === 'read-me', 'read 未读到 fill 的值：' + JSON.stringify(read.fields[0]));
    expectOk(await cliJson(['select', '#kind', '--value', 'b', '--session', sessionId]), 'select');
    const all = expectOk(await cliJson(['read', '--all', '--session', sessionId]), 'read --all');
    assert((all.fields || []).length >= 3, 'read --all 字段太少：' + (all.fields || []).length);
    const combo = (all.fields || []).find((field) => field.tag === 'select');
    assert(combo && combo.value === 'b', 'read --all 没读到 select 的值：' + JSON.stringify(combo));
    return 'read=' + read.fields[0].value + ' fields=' + all.fields.length;
  });

  await check('14b. cancel_forward 取消进行中的 wait-ms', async () => {
    const pending = cliJson(['wait-ms', '15000', '--session', sessionId]);
    await sleep(400);
    const st = expectOk(await cliJson(['status']), 'status inflight');
    const entry = (st.inflight || []).find((item) => item.method === 'wait-ms');
    assert(entry, '没有找到 wait-ms 的 inflight 记录：' + JSON.stringify(st.inflight));
    const cancelled = expectOk(await cliJson(['cancel', entry.id]), 'cancel');
    assert(cancelled.forwarded === true && cancelled.accepted === true, 'cancel 未生效：' + JSON.stringify(cancelled));
    const done = await pending;
    const payload = (done && done.json) || done;
    assert(payload && payload.error && payload.error.code === 'E_CANCELLED', 'wait-ms 未被取消：' + JSON.stringify(done));
    return 'cancelled ' + entry.id.slice(0, 8);
  });

  await check('14c. agent brief 返回页面简报与下一步', async () => {
    const brief = expectOk(await cliJson(['agent', 'brief', '--session', sessionId]), 'agent brief');
    assert(brief.page && String(brief.page.url || '').includes(pageUrl), 'brief 缺少页面 URL：' + JSON.stringify(brief.page));
    assert(brief.observation && brief.observation.refs > 0 && String(brief.observation.text || '').includes('button'), 'brief 观察不完整');
    assert(Array.isArray(brief.next) && brief.next.length > 0, 'brief 没有下一步建议');
    return 'refs=' + brief.observation.refs + ' next=' + brief.next.length;
  });

  await check('15. extract（JSON + CSV）', async () => {
    const json = expectOk(await cliJson(['extract', '--selector', '#people', '--session', sessionId]), 'extract');
    assert(json.rowCount === 3, '行数应为 3，实际 ' + json.rowCount);
    assert(json.columns[0].label === '姓名', '列名不对：' + JSON.stringify(json.columns));
    assert(json.rows[0].c1 === '张三', '首行内容不对：' + JSON.stringify(json.rows[0]));
    const csvPath = path.join(outDir, 'people.csv');
    expectOk(await cliJson(['extract', '--selector', '#people', '--format', 'csv', '--out', csvPath, '--session', sessionId]), 'extract csv');
    const csv = readFileSync(csvPath, 'utf8');
    assert(csv.includes('姓名') && csv.includes('张三'), 'CSV 内容不对');
    return 'rows=3 csv=' + csvPath;
  });

  await check('15b. extract discover 跨 frame + frame 句柄导出', async () => {
    const discovered = expectOk(await cliJson(['extract', 'discover', '--session', sessionId]), 'extract discover frames');
    assert(Array.isArray(discovered.targets) && discovered.targets.length > 0, 'discover 没有 target：' + JSON.stringify(discovered));
    assert(discovered.frameCount >= 1, 'discover 没有 frameCount：' + JSON.stringify(discovered.frameCount));
    assert(discovered.targets.every((target) => Number.isInteger(target.frameId)), 'target 缺少 frameId：' + JSON.stringify(discovered.targets.slice(0, 2)));
    assert(discovered.limits && discovered.limits.maxFrames === 16 && discovered.limits.maxTargets === 32 && discovered.limits.previewColumns === 8, 'discover 缺少上限说明：' + JSON.stringify(discovered.limits));
    assert(discovered.targets.length <= 32, 'discover target 超过 32：' + discovered.targets.length);
    assert(typeof discovered.truncated === 'boolean', 'discover 缺少 truncated');
    assert(discovered.framesScanned === discovered.frameCount, 'framesScanned 与 frameCount 不一致：' + JSON.stringify({ scanned: discovered.framesScanned, frames: discovered.frameCount }));
    assert(discovered.framesSeen >= discovered.frameCount, 'framesSeen 小于 frameCount：' + JSON.stringify({ seen: discovered.framesSeen, frames: discovered.frameCount }));
    for (const target of discovered.targets) {
      assert(target.preview && Array.isArray(target.preview.columns) && target.preview.columns.length <= 8, 'target preview 缺失或超 8 列：' + JSON.stringify(target));
      assert(Array.isArray(target.preview.sample), 'target preview.sample 不是数组：' + JSON.stringify(target.preview));
    }
    const table = discovered.targets.find((target) => target.kind === 'table' && target.frameId === 0);
    assert(table, 'discover 没有主文档 table target：' + JSON.stringify(discovered.targets.slice(0, 5)));
    const extracted = expectOk(await cliJson(['extract', 'table', '--target', String(table.id), '--frame', String(table.frameId), '--session', sessionId]), 'extract table frame');
    assert(extracted.rowCount >= 1, '按 frame 句柄导出失败：' + JSON.stringify(extracted));
    return 'frames=' + discovered.frameCount + ' target=' + table.id + ' rows=' + extracted.rowCount;
  });

  await check('15c. extract 预算证据：max-rows / max-cells / max-bytes', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'extract budget navigate');
    const limited = expectOk(await cliJson(['extract', '--max-rows', '1', '--session', sessionId]), 'extract budget rows');
    assert(limited.truncated === true && limited.stopReason === 'max-rows', '--max-rows 没有截断证据：' + JSON.stringify({ truncated: limited.truncated, stopReason: limited.stopReason }));
    assert(limited.budget && limited.budget.maxRows === 1 && limited.budget.rows === 1, '预算字段不对：' + JSON.stringify(limited.budget));
    assert(Number.isInteger(limited.budget.bytes) && limited.budget.bytes > 0, 'budget.bytes 缺失：' + JSON.stringify(limited.budget));
    assert(limited.coverage && limited.coverage.stopReason === 'max-rows', 'coverage 缺少 stopReason：' + JSON.stringify(limited.coverage));
    assert(limited.coverage.omitted === null || Number.isInteger(limited.coverage.omitted), 'coverage.omitted 类型不对：' + JSON.stringify(limited.coverage));
    assert(typeof limited.cells === 'number' && limited.cells > 0, 'cells 缺失：' + JSON.stringify(limited.cells));
    const capped = expectOk(await cliJson(['extract', '--max-cells', '2', '--session', sessionId]), 'extract budget cells');
    assert(capped.stopReason === 'max-cells' && capped.budget.maxCells === 2, '--max-cells 没有生效：' + JSON.stringify({ stopReason: capped.stopReason, budget: capped.budget }));
    assert(capped.cells <= 2, '--max-cells 未限制单元格数：' + capped.cells);
    const bytesCapped = expectOk(await cliJson(['extract', '--max-bytes', '1200', '--session', sessionId]), 'extract budget bytes');
    assert(bytesCapped.budget && bytesCapped.budget.maxBytes === 1200, 'budget.maxBytes 不对：' + JSON.stringify(bytesCapped.budget));
    assert(bytesCapped.budget.bytes <= 1200 || bytesCapped.stopReason === 'max-bytes', '--max-bytes 未生效：' + JSON.stringify({ bytes: bytesCapped.budget.bytes, stopReason: bytesCapped.stopReason }));
    const full = expectOk(await cliJson(['extract', '--max-rows', '100', '--session', sessionId]), 'extract budget full');
    assert(full.budget && full.budget.maxRows === 100 && full.budget.stopReason === 'end', '正常提取预算不对：' + JSON.stringify(full.budget));
    return 'rows=' + limited.budget.rows + ' cells=' + capped.cells + ' bytes=' + bytesCapped.budget.bytes;
  });

  await check('15d. observe --frames --vom 跨源 iframe 子图', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'frame vom navigate');
    const frames = expectOk(await cliJson(['observe', '--frames', '--vom', '--force', '--session', sessionId]), 'frame vom observe');
    assert(Array.isArray(frames.frames) && frames.frames.length >= 2, 'frames 不足：' + JSON.stringify(frames.frames && frames.frames.length));
    assert(frames.vomFrames && frames.vomFrames.count >= 2, '缺少 vomFrames 摘要：' + JSON.stringify(frames.vomFrames));
    assert(frames.vomLimits && frames.vomLimits.frames === 16, '缺少 vomLimits：' + JSON.stringify(frames.vomLimits));
    const main = frames.frames.find((frame) => Number(frame.frameId) === 0);
    assert(main && main.vom && main.vom.available === true, '主文档缺少子图：' + JSON.stringify(main && main.vom));
    assert(main.vom.nodes.some((node) => node.id === 'frame:0'), '主文档缺少 frame:0 节点');
    const cross = frames.frames.find((frame) => Number(frame.frameId) > 0
      && /\/frame-x\.html/.test(String(frame.url || ''))
      && !String(frame.url || '').includes('hidden'));
    assert(cross, '没有找到跨源 frame：' + JSON.stringify((frames.frames || []).map((frame) => ({ id: frame.frameId, url: frame.url }))));
    assert(cross.vom && cross.vom.available === true, '跨源 frame 缺少子图：' + JSON.stringify(cross.vom));
    const ids = new Set(cross.vom.nodes.map((node) => node.id));
    assert(ids.has('frame:' + cross.frameId), '跨源子图缺少 frame 节点：' + JSON.stringify([...ids]));
    assert([...ids].some((id) => id.startsWith('f' + cross.frameId + ':')), '跨源子图 id 未加帧前缀：' + JSON.stringify([...ids]));
    for (const edge of cross.vom.edges) {
      assert(ids.has(edge.from) && ids.has(edge.to), '跨源子图边端点越界：' + JSON.stringify(edge));
    }
    assert(cross.vom.edges.some((edge) => edge.type === 'frame' && edge.from === 'frame:' + cross.frameId), '缺少 frame 边');
    // 主文档的 iframe 元素 → 跨源子图根
    const link = (frames.vomFrames.links || []).find((item) => Number(item.fromFrameId) === 0 && Number(item.toFrameId) === Number(cross.frameId));
    assert(link, '缺少 iframe→子图根 link：' + JSON.stringify(frames.vomFrames.links));
    const mainIds = new Set(main.vom.nodes.map((node) => node.id));
    assert(mainIds.has(link.ownerId), 'ownerId 不在主文档子图：' + link.ownerId);
    assert(mainIds.has('frame:' + cross.frameId), '主文档缺少子帧节点：' + JSON.stringify([...mainIds].slice(0, 10)));
    assert(main.vom.edges.some((edge) => edge.type === 'frame' && edge.from === link.ownerId && edge.to === 'frame:' + cross.frameId), '主文档缺少 iframe→frame 边');
    assert(Number(frames.vomFrames.unlinked) === 0, '存在未匹配的 iframe owner：' + frames.vomFrames.unlinked);
    return 'frames=' + frames.vomFrames.count + ' main=' + main.vom.counts.nodes + ' cross=' + cross.vom.counts.nodes + ' link=' + link.ownerId;
  });

  await check('15e. 嵌套 iframe 链：父帧把 iframe 元素接到自己的子图根', async () => {
    const nestedUrl = new URL('nested-cross.html', pageUrl).href;
    expectOk(await cliJson(['navigate', nestedUrl, '--session', sessionId]), 'nested frame vom navigate');
    const frames = expectOk(await cliJson(['observe', '--frames', '--vom', '--force', '--session', sessionId]), 'nested frame vom observe');
    // 先回到主夹具页，失败时也不会污染后续用例。
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'nested frame vom restore');
    const links = frames.vomFrames && Array.isArray(frames.vomFrames.links) ? frames.vomFrames.links : [];
    const nested = links.filter((item) => Number(item.fromFrameId) > 0);
    assert(nested.length >= 1, '没有嵌套 iframe 的 owner link：' + JSON.stringify({ links, frames: (frames.frames || []).map((frame) => ({ id: frame.frameId, parent: frame.parentFrameId, url: frame.url })) }));
    const link = nested[0];
    const parent = (frames.frames || []).find((frame) => Number(frame.frameId) === Number(link.fromFrameId));
    assert(parent && parent.vom && parent.vom.available === true, '嵌套父帧缺少子图：' + JSON.stringify({ frameId: link.fromFrameId, frames: (frames.frames || []).map((frame) => frame.frameId) }));
    const parentIds = new Set(parent.vom.nodes.map((node) => node.id));
    assert(parentIds.has(link.ownerId), 'ownerId 不在父帧子图：' + link.ownerId);
    assert(parentIds.has('frame:' + link.toFrameId), '父帧缺少子帧节点：' + link.toFrameId);
    assert(parent.vom.edges.some((edge) => edge.type === 'frame' && edge.from === link.ownerId && edge.to === 'frame:' + link.toFrameId), '父帧缺少 iframe→frame 边');
    const child = (frames.frames || []).find((frame) => Number(frame.frameId) === Number(link.toFrameId));
    assert(child && child.vom && child.vom.available === true, '嵌套子帧缺少子图');
    assert(Number(frames.vomFrames.unlinked) === 0, '存在未匹配 owner：' + frames.vomFrames.unlinked);
    return 'nested link ' + link.fromFrameId + '→' + link.toFrameId;
  });

  await check('15f. extract 多页游标：续取 + 过期/类型校验', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'extract cursor navigate');
    const first = expectOk(await cliJson(['extract', '--max-rows', '1', '--session', sessionId]), 'extract cursor first');
    assert(first.offset === 0 && first.rows.length === 1, '首块 offset/rows 不对：' + JSON.stringify({ offset: first.offset, rows: first.rows.length }));
    assert(first.hasMore === true && typeof first.cursor === 'string' && first.cursor.startsWith('x1.'), '首块缺少 cursor/hasMore：' + JSON.stringify({ hasMore: first.hasMore, cursor: first.cursor }));
    const second = expectOk(await cliJson(['extract', '--cursor', first.cursor, '--session', sessionId]), 'extract cursor second');
    assert(second.offset === 1 && second.rows.length >= 1, '续取 offset/rows 不对：' + JSON.stringify({ offset: second.offset, rows: second.rows.length }));
    assert(JSON.stringify(second.rows[0]) !== JSON.stringify(first.rows[0]), '续取返回了同一行：' + JSON.stringify({ first: first.rows[0], second: second.rows[0] }));
    const wrongKind = await cliJson(['extract', 'list', '--cursor', second.cursor, '--session', sessionId]);
    assert(wrongKind.code === 1 && wrongKind.json && wrongKind.json.error && wrongKind.json.error.code === 'E_CURSOR_STALE', '类型不符应 E_CURSOR_STALE：' + JSON.stringify(wrongKind.json && wrongKind.json.error));
    const bogus = await cliJson(['extract', '--cursor', 'x1.bogus', '--session', sessionId]);
    assert(bogus.code === 1 && bogus.json && bogus.json.error && bogus.json.error.code === 'E_CURSOR_STALE', '非法 cursor 应 E_CURSOR_STALE：' + JSON.stringify(bogus.json && bogus.json.error));
    const fresh = expectOk(await cliJson(['extract', '--max-rows', '1', '--session', sessionId]), 'extract cursor fresh');
    expectOk(await cliJson(['evaluate', "document.getElementById('out').textContent='cursor-stale';'ok'", '--session', sessionId]), 'extract cursor mutate');
    const stale = await cliJson(['extract', '--cursor', fresh.cursor, '--session', sessionId]);
    assert(stale.code === 1 && stale.json && stale.json.error && stale.json.error.code === 'E_CURSOR_STALE', 'DOM 变化后 cursor 应失效：' + JSON.stringify(stale.json && stale.json.error));
    return 'offset 0→1，kind/revision 校验生效';
  });

  await check('15g. view 分页缓存：offset/limit/grep 组合', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'view page navigate');
    expectOk(await cliJson(['observe', '--force', '--session', sessionId]), 'view page observe');
    const all = expectOk(await cliJson(['view', '--limit', '200', '--session', sessionId]), 'view all');
    assert(Number(all.total) > 5, 'observation 行数太少，无法验证分页：' + JSON.stringify({ total: all.total }));
    const first = expectOk(await cliJson(['view', '--limit', '3', '--session', sessionId]), 'view first');
    assert(first.offset === 0 && first.lines.length === 3 && first.limit === 3, '第一页 offset/limit 不对：' + JSON.stringify({ offset: first.offset, limit: first.limit, lines: first.lines.length }));
    const second = expectOk(await cliJson(['view', '--offset', '3', '--limit', '3', '--session', sessionId]), 'view second');
    assert(second.offset === 3, '第二页 offset 不对：' + JSON.stringify(second.offset));
    assert(JSON.stringify(second.lines) !== JSON.stringify(first.lines), '第二页与第一页内容相同');
    const grep = expectOk(await cliJson(['view', '--grep', '搜索关键词', '--offset', '0', '--limit', '2', '--session', sessionId]), 'view grep');
    assert(Number(grep.matched) >= 1 && Number(grep.matched) <= Number(grep.total), 'grep 命中数不合理：' + JSON.stringify({ matched: grep.matched, total: grep.total }));
    return 'total=' + all.total + ' matched=' + grep.matched;
  });

  await check('16. drag 拖拽', async () => {
    expectOk(await cliJson(['drag', '#drag-src', '--to', '#dropzone', '--session', sessionId]), 'drag');
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('drop-out').textContent", '--session', sessionId]), 'evaluate drop');
    assert(out.value === 'dropped', '拖拽未生效：' + JSON.stringify(out.value));
    return 'drop-out=' + out.value;
  });

  await check('16b. drag --modifiers ctrl+shift', async () => {
    expectOk(await cliJson(['drag', '#drag-src', '--to', '#dropzone', '--modifiers', 'ctrl+shift', '--session', sessionId]), 'drag modifiers');
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('drop-out').textContent", '--session', sessionId]), 'evaluate drop modifiers');
    assert(out.value === 'dropped+ctrl+shift', '修饰键未传给拖拽事件：' + JSON.stringify(out.value));
    return out.value;
  });

  await check('17. wheel 滚动 + blur', async () => {
    const wheel = expectOk(await cliJson(['wheel', '--delta-y', '600', '--session', sessionId]), 'wheel');
    assert(wheel.scrollY > 100, 'wheel 后 scrollY 太小：' + wheel.scrollY);
    expectOk(await cliJson(['focus', '#kw', '--session', sessionId]), 'focus');
    expectOk(await cliJson(['blur', '--session', sessionId]), 'blur');
    const active = expectOk(await cliJson(['evaluate', 'document.activeElement ? document.activeElement.id : ""', '--session', sessionId]), 'evaluate active');
    assert(active.value !== 'kw', 'blur 后焦点仍在 #kw');
    expectOk(await cliJson(['wheel', '--delta-y', '-600', '--session', sessionId]), 'wheel up');
    return 'scrollY=' + wheel.scrollY;
  });

  await check('18. upload 填 input[type=file]', async () => {
    const filePath = path.join(outDir, 'upload-sample.txt');
    writeFileSync(filePath, 'hello upload', 'utf8');
    const up = expectOk(await cliJson(['upload', '#file', '--file', filePath, '--session', sessionId]), 'upload');
    assert((up.names || [])[0] === 'upload-sample.txt', 'upload 未返回文件名');
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('file-out').textContent", '--session', sessionId]), 'evaluate file-out');
    assert(out.value === 'upload-sample.txt', '页面没收到文件：' + JSON.stringify(out.value));
    return 'files=' + out.value;
  });

  await check('18b. upload 通过按钮触发并拦截文件选择器', async () => {
    const filePath = path.join(outDir, 'chooser-sample.txt');
    writeFileSync(filePath, 'chooser upload', 'utf8');
    const uploaded = expectOk(await cliJson(['upload', '#pick-file', '--file', filePath, '--session', sessionId]), 'upload chooser');
    assert(uploaded.via === 'chooser' || uploaded.via === 'hidden-input', '既没拦截选择器也没有隐藏 input：' + JSON.stringify(uploaded));
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('file-out').textContent", '--session', sessionId]), 'file out');
    assert(out.value === 'chooser-sample.txt', '页面没收到文件：' + JSON.stringify(out.value));
    return 'via=chooser name=' + out.value;
  });

  await check('18c. upload --mode drop 拖放到 dropzone', async () => {
    const filePath = path.join(outDir, 'drop-sample.txt');
    writeFileSync(filePath, 'drop upload', 'utf8');
    const uploaded = expectOk(await cliJson(['upload', '#file-drop', '--mode', 'drop', '--file', filePath, '--session', sessionId]), 'upload drop');
    assert(uploaded.via === 'drop', '没有走 drop 模式：' + JSON.stringify(uploaded));
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('drop-file-out').textContent", '--session', sessionId]), 'drop file out');
    assert(out.value === 'drop-sample.txt', 'dropzone 没收到文件：' + JSON.stringify(out.value));
    return 'dropzone=' + out.value;
  });

  await check('18d. 大文件分块上传（daemon staging → 选择器）', async () => {
    const filePath = path.join(outDir, 'big-upload.bin');
    writeFileSync(filePath, Buffer.alloc(5 * 1024 * 1024, 0x61));
    const uploaded = expectOk(await cliJson(['upload', '#pick-file', '--file', filePath, '--session', sessionId]), 'upload big chunked');
    assert(uploaded.via === 'chooser' || uploaded.via === 'hidden-input', '大文件走选择器或路径兜底：' + JSON.stringify(uploaded));
    assert((uploaded.names || [])[0] === 'big-upload.bin', '大文件上传文件名不对：' + JSON.stringify(uploaded.names));
    const sizes = expectOk(await cliJson([
      'evaluate',
      "JSON.stringify(Array.from(document.querySelectorAll('input[type=file]')).map((el) => (el.files && el.files[0] ? el.files[0].size : 0)))",
      '--session', sessionId,
    ]), 'big file sizes');
    assert(JSON.parse(sizes.value).includes(5 * 1024 * 1024), '页面拿到的文件大小不是 5MB：' + String(sizes.value));
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('file-out').textContent", '--session', sessionId]), 'big file out');
    assert(out.value === 'big-upload.bin', '页面没收到大文件：' + JSON.stringify(out.value));
    return '5MB via ' + uploaded.via;
  });

  await check('18e. 超大文件直接 input 赋值（CDP 路径兜底）', async () => {
    const filePath = path.join(outDir, 'big-direct.bin');
    writeFileSync(filePath, Buffer.alloc(9 * 1024 * 1024, 0x62));
    const uploaded = expectOk(await cliJson(['upload', '#file', '--file', filePath, '--session', sessionId]), 'upload big direct');
    assert(uploaded.via === 'input-path' || uploaded.via === 'hidden-input', '超大文件应走 CDP 路径兜底：' + JSON.stringify(uploaded));
    assert((uploaded.names || [])[0] === 'big-direct.bin', '超大文件上传文件名不对：' + JSON.stringify(uploaded.names));
    const sizes = expectOk(await cliJson([
      'evaluate',
      "JSON.stringify(Array.from(document.querySelectorAll('input[type=file]')).map((el) => (el.files && el.files[0] ? el.files[0].size : 0)))",
      '--session', sessionId,
    ]), 'big direct sizes');
    assert(JSON.parse(sizes.value).includes(9 * 1024 * 1024), '页面拿到的文件大小不是 9MB：' + String(sizes.value));
    return '9MB via ' + uploaded.via;
  });

  await check('19. 对话框 pending → dialog dismiss/accept → operation await', async () => {
    const click = await cliJson(['click', '#dlg-confirm', '--session', sessionId]);
    assert(click.code === 6, '应返回退出码 6，实际 ' + click.code + ' stderr=' + click.stderr);
    assert(click.json && click.json.error && click.json.error.code === 'E_DIALOG_PENDING', '错误码不对：' + JSON.stringify(click.json));
    const first = click.json.error.data;
    assert(first.dialog && first.dialog.type === 'confirm' && first.dialog.id != null, '缺少 dialog 信息');
    assert(typeof first.operationId === 'string' && first.operationId, '缺少 operationId');

    const status = expectOk(await cliJson(['dialog', 'status', '--session', sessionId]), 'dialog status');
    assert((status.dialogs || []).some((item) => item.action === 'pending'), 'status 里没有 pending 对话框');

    const blocked = await cliJson(['click', '#dlg-alert', '--session', sessionId]);
    assert(blocked.code === 6, '挂起期间新动作也应返回 6');
    assert(blocked.json.error.data.dispatched === false, '挂起期间不应派发新动作：' + JSON.stringify(blocked.json));

    expectOk(await cliJson(['dialog', 'dismiss', String(first.dialog.id), '--session', sessionId]), 'dialog dismiss');
    const awaited = expectOk(await cliJson(['operation', 'await', first.operationId, '--timeout', '10s', '--session', sessionId]), 'operation await');
    assert(awaited.state === 'completed', 'operation 未完成：' + JSON.stringify(awaited));
    await sleep(300);
    const out1 = expectOk(await cliJson(['evaluate', "document.getElementById('dlg-out').textContent", '--session', sessionId]), 'evaluate dlg');
    assert(out1.value === 'dismissed', 'confirm 结果不对：' + JSON.stringify(out1.value));

    const promptClick = await cliJson(['click', '#dlg-prompt', '--session', sessionId]);
    assert(promptClick.code === 6, 'prompt 也应返回 6');
    const promptData = promptClick.json.error.data;
    expectOk(await cliJson(['dialog', 'accept', String(promptData.dialog.id), '--text', '桥', '--session', sessionId]), 'dialog accept');
    const promptAwaited = expectOk(await cliJson(['operation', 'await', promptData.operationId, '--timeout', '10s', '--session', sessionId]), 'await prompt');
    assert(promptAwaited.state === 'completed', 'prompt operation 未完成');
    await sleep(300);
    const out2 = expectOk(await cliJson(['evaluate', "document.getElementById('dlg-out').textContent", '--session', sessionId]), 'evaluate dlg2');
    assert(out2.value === 'value:桥', 'prompt 结果不对：' + JSON.stringify(out2.value));
    return 'confirm/prompt 走 dialog_pending + operation';
  });

  await check('20. network 抓到 /api/ping', async () => {
    expectOk(await cliJson(['network', 'start', '--session', sessionId]), 'network start');
    expectOk(await cliJson(['click', '#ping-btn', '--session', sessionId]), 'click ping');
    await sleep(800);
    const list = expectOk(await cliJson(['network', 'list', '--filter', '/api/ping', '--session', sessionId]), 'network list');
    const entries = (list.entries || []);
    const entry = entries.find((item) => item.commandId) || entries[0];
    assert(entry, '没有抓到 /api/ping：' + JSON.stringify(list).slice(0, 300));
    assert(entry.status === 200, 'status 不是 200：' + entry.status);
    assert(entry.commandId, '请求缺少 commandId：' + JSON.stringify(entry));
    expectOk(await cliJson(['network', 'stop', '--session', sessionId]), 'network stop');
    return 'GET /api/ping ' + entry.status;
  });

  await check('20b. debug start/requests/request/console/pages/performance/aggregate/export', async () => {
    expectOk(await cliJson(['debug', 'start', '--name', 'e2e-debug', '--bodies', '--session', sessionId]), 'debug start');
    await cliJson(['click', '#ping-btn', '--session', sessionId]);
    await cliJson(['evaluate', "console.warn('bridge-e2e-console')", '--session', sessionId]);
    await sleep(900);

    const debugJournal = expectOk(await cliJson(['debug', 'journal', '--session', sessionId]), 'debug journal');
    assert(debugJournal.counts && debugJournal.counts.debug >= 1, 'debug journal 没有调试动作：' + JSON.stringify(debugJournal.counts));
    assert((debugJournal.events || []).some((event) => event.type === 'debug' && event.action === 'start'), 'debug journal 缺少 start 事件');
    const mergedJournal = expectOk(await cliJson(['debug', 'journal', '--merged', '--session', sessionId]), 'debug journal merged');
    assert(mergedJournal.merged === true && Array.isArray(mergedJournal.timeline) && mergedJournal.timeline.length >= 1, 'debug journal --merged 时间线不完整');
    assert(Number.isInteger(mergedJournal.timeline[0].elapsedMs), 'merged timeline 缺少 elapsedMs');

    const listed = expectOk(await cliJson(['debug', 'requests', '--filter', '/api/ping', '--session', sessionId]), 'debug requests');
    assert((listed.entries || []).length >= 1, 'debug requests 没抓到 /api/ping');
    const requestId = listed.entries[0].id;

    const detail = expectOk(await cliJson(['debug', 'request', String(requestId), '--session', sessionId]), 'debug request');
    assert(detail.entry && detail.entry.url.includes('/api/ping'), '请求详情 url 不对');
    assert(detail.responseBody && detail.responseBody.includes('ok'), '响应正文没取到（bodies 未生效）：' + JSON.stringify(detail.responseBody || null).slice(0, 120));

    const consoleBody = expectOk(await cliJson(['debug', 'console', '--session', sessionId]), 'debug console');
    assert((consoleBody.entries || []).some((item) => String(item.text || '').includes('bridge-e2e-console')), '控制台里没有我们的 warn');
    await cliJson(['evaluate', "try { window.__bbWs = new WebSocket('ws://127.0.0.1:1/'); window.__bbWs.onerror = () => {}; } catch (error) {} 'ok'", '--session', sessionId]);
    await sleep(500);
    const wsFile = path.join(outDir, 'ws-output.json');
    const wsFrames = expectOk(await cliJson(['debug', 'ws', '--output', wsFile, '--session', sessionId]), 'debug ws');
    assert(Number(wsFrames.total) >= 1 && Array.isArray(wsFrames.sockets), '没有捕获 WebSocket：' + JSON.stringify(wsFrames).slice(0, 200));
    assert(existsSync(wsFile), 'WebSocket 导出文件不存在');

    const pages = expectOk(await cliJson(['debug', 'pages', '--session', sessionId]), 'debug pages');
    assert(pages.context && String(pages.context.url).includes('test.html'), '页面上下文 url 不对');

    const perf = expectOk(await cliJson(['debug', 'performance', '--session', sessionId]), 'debug performance');
    assert(perf.metrics && perf.metrics.url && perf.metrics.resources.count >= 1, '性能指标不完整：' + JSON.stringify(perf.metrics));

    const aggregate = expectOk(await cliJson(['debug', 'aggregate', '--filter', '/api/ping', '--session', sessionId]), 'debug aggregate');
    assert((aggregate.groups || []).length >= 1 && aggregate.groups[0].count >= 1, '聚合结果不对');

    const exported = path.join(outDir, 'debug-export.json');
    expectOk(await cliJson(['debug', 'export', '--output', exported, '--session', sessionId]), 'debug export');
    const parsed = JSON.parse(readFileSync(exported, 'utf8'));
    assert(Array.isArray(parsed.requests) && parsed.requests.length >= 1, '导出的 JSON 没有请求');
    const queried = expectOk(await cliJson(['debug', 'query', '--file', exported, '--filter', '/api/ping', '--session', sessionId]), 'debug query');
    assert(queried.matched >= 1 && queried.entries[0].url.includes('/api/ping'), '离线查询没有命中：' + JSON.stringify(queried).slice(0, 200));
    const offlineAnalysis = expectOk(await cliJson(['debug', 'analyze', '--file', exported, '--session', sessionId]), 'debug analyze file');
    assert(offlineAnalysis.counts && offlineAnalysis.counts.requests >= 1, '离线分析没有统计请求');
    const archiveFile = path.join(outDir, 'debug-archive.json');
    expectOk(await cliJson(['debug', 'archive', '--output', archiveFile, '--session', sessionId]), 'debug archive');
    const archived = JSON.parse(readFileSync(archiveFile, 'utf8'));
    assert(archived.version === 1 && archived.summary.requests >= 1 && archived.expiresAt, '调试归档结构不完整');
    assert(Array.isArray(archived.journal) && archived.journal.length >= 1, '调试归档没有保留 journal：' + JSON.stringify(archived.summary));
    assert(existsSync(path.join(outDir, '.bb-debug-index.json')), '归档索引文件未生成');
    const harFile = path.join(outDir, 'debug.har');
    const har = expectOk(await cliJson(['debug', 'har', '--output', harFile, '--session', sessionId]), 'debug har');
    assert(har.entries >= 1, 'HAR 没有条目：' + JSON.stringify(har));
    const harJson = JSON.parse(readFileSync(harFile, 'utf8'));
    assert(harJson.log && harJson.log.version === '1.2' && harJson.log.entries.length >= 1, 'HAR 结构不完整');
    const importedArchive = path.join(outDir, 'har-imported.json');
    expectOk(await cliJson(['debug', 'har-import', harFile, '--output', importedArchive, '--session', sessionId]), 'debug har-import');
    const importedAnalysis = expectOk(await cliJson(['debug', 'analyze', '--file', importedArchive, '--session', sessionId]), 'har imported analyze');
    assert(importedAnalysis.counts && importedAnalysis.counts.requests >= 1, 'HAR 导入后分析没有请求');
    const waterfall = expectOk(await cliJson(['network', 'waterfall', '--session', sessionId]), 'network waterfall');
    assert(Array.isArray(waterfall.rows) && waterfall.rows.length >= 1 && waterfall.summary.count >= 1, 'waterfall 为空');
    const mcp = startMcp({ ...process.env, BB_HOME: bbHome, BB_PORT: String(port), BB_NO_PROBE: '1' });
    try {
      await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e' } });
      const mcpWaterfall = await mcp.rpc('tools/call', { name: 'browser_network_waterfall', arguments: { limit: 20, session: sessionId } });
      assert(mcpWaterfall.result.isError === false, 'MCP waterfall 失败：' + String(mcpWaterfall.result.content[0].text).slice(0, 160));
      assert(String(mcpWaterfall.result.content[0].text).includes('"rows"'), 'MCP waterfall 没有返回 rows');
      const mcpReplay = await mcp.rpc('tools/call', { name: 'browser_network_replay_har', arguments: { file: harFile, entry: 0, session: sessionId } });
      assert(mcpReplay.result.isError === false, 'MCP HAR 重放失败：' + String(mcpReplay.result.content[0].text).slice(0, 160));
      const mcpHarPath = path.join(outDir, 'mcp-debug.har');
      const mcpHar = await mcp.rpc('tools/call', { name: 'browser_debug_har', arguments: { out: mcpHarPath, session: sessionId } });
      assert(mcpHar.result.isError === false && existsSync(mcpHarPath), 'MCP debug HAR 导出失败');
      const mcpHarImport = path.join(outDir, 'mcp-debug-import.json');
      const mcpHarImported = await mcp.rpc('tools/call', { name: 'browser_debug_har_import', arguments: { file: harFile, out: mcpHarImport } });
      assert(mcpHarImported.result.isError === false && existsSync(mcpHarImport), 'MCP HAR 导入失败');
    } finally {
      mcp.close();
    }
    const replayed = expectOk(await cliJson(['network', 'replay-har', harFile, '--all', '--limit', '3', '--session', sessionId]), 'network replay-har');
    assert(Array.isArray(replayed.results) && replayed.results.length >= 1, 'HAR 批量重放没有结果：' + JSON.stringify(replayed).slice(0, 200));
    const archiveIndex = expectOk(await cliJson(['debug', 'archives', '--dir', outDir, '--session', sessionId]), 'debug archives');
    assert(archiveIndex.stats && archiveIndex.entries.some((entry) => entry.id === archived.id), '归档索引没有包含新归档');
    const dirQuery = expectOk(await cliJson(['debug', 'query', '--dir', outDir, '--filter', '/api/ping', '--session', sessionId]), 'debug query dir');
    assert(dirQuery.matched >= 1, '目录查询没有命中归档请求');
    const evidenceFile = path.join(outDir, 'debug-evidence.json');
    const evidence = expectOk(await cliJson(['debug', 'evidence', '--output', evidenceFile, '--session', sessionId]), 'debug evidence');
    assert(existsSync(evidenceFile) && evidence.counts.requests >= 1 && evidence.integrity.requestsSha256.length === 64, '证据包不完整');
    const offlineEvidenceFile = path.join(outDir, 'debug-evidence-offline.json');
    expectOk(await cliJson(['debug', 'evidence', '--file', exported, '--output', offlineEvidenceFile, '--session', sessionId]), 'debug evidence offline');
    assert(existsSync(offlineEvidenceFile), '离线证据包未生成');
    const journal = expectOk(await cliJson(['debug', 'journal', '--session', sessionId]), 'debug journal');
    assert(Array.isArray(journal.entries), 'journal 结构不对');

    const stopped = expectOk(await cliJson(['debug', 'stop', '--session', sessionId]), 'debug stop');
    assert(stopped.requests >= 1, '停止时没有统计到请求');
    const history = expectOk(await cliJson(['debug', 'history', '--session', sessionId]), 'debug history');
    assert((history.history || []).some((item) => item.name === 'e2e-debug'), '历史里没有本次记录');
    return 'requests=' + listed.entries.length + ' console=' + consoleBody.entries.length + ' aggregate=' + aggregate.groups.length;
  });

  await check('20b2. debug capabilities / pin / unpin', async () => {
    const caps = expectOk(await cliJson(['debug', 'capabilities', '--session', sessionId]), 'debug capabilities');
    assert((caps.actions || []).includes('pin'), 'capabilities 缺少 pin');
    expectOk(await cliJson(['debug', 'pin', 'req-test', '--session', sessionId]), 'debug pin');
    const pinned = expectOk(await cliJson(['debug', 'pinned', '--session', sessionId]), 'debug pinned');
    assert((pinned.pinned || []).includes('req-test'), 'pin 未生效');
    expectOk(await cliJson(['debug', 'unpin', 'req-test', '--session', sessionId]), 'debug unpin');
    const after = expectOk(await cliJson(['debug', 'pinned', '--session', sessionId]), 'debug pinned after');
    assert(!(after.pinned || []).includes('req-test'), 'unpin 未生效');
    return 'caps + pin';
  });

  await check('20b3. debug requests 过滤 + request metadata', async () => {
    const limited = expectOk(await cliJson(['debug', 'requests', '--method', 'GET', '--limit', '1', '--session', sessionId]), 'debug requests filter');
    assert((limited.entries || []).length <= 1, 'limit 未生效');
    const all = expectOk(await cliJson(['debug', 'requests', '--session', sessionId]), 'debug requests all');
    const entry = (all.entries || [])[0];
    if (entry) {
      const meta = expectOk(await cliJson(['debug', 'request', String(entry.id), '--part', 'metadata', '--session', sessionId]), 'debug request metadata');
      assert(meta.entry && typeof meta.entry.url === 'string', 'metadata 缺少 entry');
    }
    return 'filter + metadata';
  });

  await check('20b4. console --limit/--cursor 分页', async () => {
    expectOk(await cliJson(['debug', 'start', '--session', sessionId]), 'debug start console');
    expectOk(await cliJson(['evaluate', "console.log('cursor-a'); console.log('cursor-b'); 'ok'", '--session', sessionId]), 'seed console');
    const first = expectOk(await cliJson(['console', '--limit', '1', '--session', sessionId]), 'console limit');
    assert((first.entries || []).length === 1, 'console --limit 未生效：' + JSON.stringify(first.entries));
    assert(typeof first.nextCursor === 'number', 'console 缺少 nextCursor：' + JSON.stringify(first));
    const second = expectOk(await cliJson(['console', '--cursor', String(first.nextCursor), '--limit', '1', '--session', sessionId]), 'console cursor');
    assert((second.entries || []).length === 1, 'console --cursor 未返回一条');
    assert(second.nextCursor === null || second.nextCursor === first.nextCursor + 1, 'console 末页应结束或推进游标：' + JSON.stringify({ first: first.nextCursor, second: second.nextCursor }));
    expectOk(await cliJson(['debug', 'stop', '--session', sessionId]), 'debug stop console');
    return 'limit=1 cursor=' + first.nextCursor;
  });

  await check('20c. video CLI：录制 → 状态 → 保存 → 列表 → 丢弃', async () => {
    let buffer = null;
    let recordingId = null;
    let container = '';
    for (let attempt = 0; attempt < 2 && !buffer; attempt += 1) {
      const started = expectOk(await cliJson(['video', 'start', '--duration', '3s', '--session', sessionId]), 'video start');
      recordingId = started.recordingId;
      assert(typeof recordingId === 'string' && recordingId, '缺少 recordingId');
      await sleep(500);
      // 制造画面变化，避免静态页 screencast 没有帧
      await cliJson(['evaluate', "window.scrollBy(0, 40); document.body.style.outline='1px solid #eef'; 'ok'", '--session', sessionId]);
      await sleep(700);
      await cliJson(['evaluate', "window.scrollBy(0, -40); 'ok'", '--session', sessionId]);
      await sleep(3500);
      const status = expectOk(await cliJson(['video', 'status', recordingId, '--session', sessionId]), 'video status');
      if (status.state !== 'ready') { await cli(['video', 'discard', recordingId, '--session', sessionId]); continue; }
      const file = path.join(outDir, 'media.mp4');
      expectOk(await cliJson(['video', 'save', recordingId, '--out', file, '--overwrite', '--session', sessionId]), 'video save');
      const current = readFileSync(file);
      if (current.length > 1000) {
        buffer = current;
        container = current.subarray(4, 8).toString('ascii') === 'ftyp' ? 'MP4' : (current.subarray(0, 4).toString('hex') === '1a45dfa3' ? 'WebM' : '');
      } else {
        await cli(['video', 'discard', recordingId, '--session', sessionId]);
      }
    }
    assert(buffer && buffer.length > 1000, '视频文件太小（两次尝试）：' + (buffer ? buffer.length : 0));
    assert(container, '不是 MP4/WebM 容器：' + buffer.subarray(0, 8).toString('hex'));

    const listed = expectOk(await cliJson(['video', 'list', '--session', sessionId]), 'video list');
    assert((listed.recordings || []).some((item) => item.id === recordingId), '列表里没有新录制');
    expectOk(await cliJson(['video', 'discard', recordingId, '--session', sessionId]), 'video discard');
    const after = expectOk(await cliJson(['video', 'list', '--session', sessionId]), 'video list after');
    assert(!(after.recordings || []).some((item) => item.id === recordingId), '丢弃后仍在列表里');
    return container + ' ' + buffer.length + ' 字节';
  });

  await check('20c2. video 逐帧编码（--force-frames 默认 CanvasSource → MP4）', async () => {
    const started = expectOk(await cliJson(['video', 'start', '--duration', '3s', '--force-frames', '--session', sessionId]), 'video encoder start');
    const recordingId = started.recordingId;
    assert(typeof recordingId === 'string' && recordingId, '缺少 recordingId');
    await sleep(500);
    await cliJson(['evaluate', "window.scrollBy(0, 40); document.body.style.outline='1px solid #eef'; 'ok'", '--session', sessionId]);
    await sleep(700);
    await cliJson(['evaluate', "window.scrollBy(0, -40); 'ok'", '--session', sessionId]);
    await sleep(4000);
    const status = expectOk(await cliJson(['video', 'status', recordingId, '--session', sessionId]), 'video encoder status');
    assert(status.state === 'ready', '逐帧编码录制未完成：' + JSON.stringify(status));
    assert(status.finish_via === 'encoder' && status.faststart === true, '没有走逐帧编码/faststart：' + JSON.stringify({ via: status.finish_via, faststart: status.faststart }));
    assert(status.mime === 'video/mp4', '编码输出不是 mp4：' + JSON.stringify(status.mime));
    const file = path.join(outDir, 'encoder.mp4');
    const saved = expectOk(await cliJson(['video', 'save', recordingId, '--out', file, '--overwrite', '--session', sessionId]), 'video encoder save');
    const buffer = readFileSync(file);
    assert(buffer.length > 1000 && buffer.subarray(4, 8).toString('ascii') === 'ftyp', '编码输出容器不对：' + buffer.length + ' ' + buffer.subarray(0, 8).toString('hex'));
    assert(saved.bytes === buffer.length, '保存字节不一致');
    return 'encoder mp4 ' + buffer.length + 'B';
  });

  await check('20d. record CLI：记录用户操作 → 事件 → 历史', async () => {
    expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record start');
    await cliJson(['click', '#submit-btn', '--session', sessionId]);
    await sleep(900);
    const stopped = expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record stop');
    assert(stopped.recording && stopped.recording.events >= 1, '没有记录到事件：' + JSON.stringify(stopped.recording));
    const listed = expectOk(await cliJson(['record', 'list', '--session', sessionId]), 'record list');
    assert((listed.recordings || []).length >= 1, '历史里没有记录');
    return stopped.recording.events + ' 条事件';
  });

  await check('20d2. record export：Trace v3 + states + 截图', async () => {
    const dir = path.join(outDir, 'trace-export');
    const exported = expectOk(await cliJson(['record', 'export', '--out', dir, '--screenshot', '--session', sessionId]), 'record export');
    assert(existsSync(path.join(dir, 'trace.json')), '缺少 trace.json');
    const trace = JSON.parse(readFileSync(path.join(dir, 'trace.json'), 'utf8'));
    assert(trace.version === 3, 'trace 不是 v3：' + JSON.stringify(trace).slice(0, 300));
    assert((trace.steps || []).length >= 1, 'trace 缺少 steps');
    assert((trace.states || []).length >= 1, 'trace 缺少 states');
    assert(exported.traceVersion === 3, 'CLI 返回 traceVersion 不对');
    assert(exported.screenshots === 1, 'CLI 未返回截图计数：' + JSON.stringify(exported));
    assert(Array.isArray(trace.screenshots) && trace.screenshots.length === 1, 'trace 缺少截图');
    assert(/^data:image\//.test(String(trace.screenshots[0].dataUrl || '')), '截图不是 dataUrl');
    for (const state of trace.states || []) assert(existsSync(path.join(dir, 'states', state.id + '.txt')), '缺少 state 文件：' + state.id);
    return 'steps=' + trace.steps.length + ' states=' + trace.states.length + ' shots=' + trace.screenshots.length;
  });

  await check('20d3. record 记录切换步骤（tab-select）', async () => {
    const opened = expectOk(await cliJson(['tab', 'new', 'about:blank', '--session', sessionId]), 'tab new for record');
    const listed = expectOk(await cliJson(['window', 'list', '--session', sessionId]), 'window list for record');
    let ownerWindowId = null;
    for (const win of listed.windows || []) {
      if ((win.tabs || []).some((tab) => tab.tabId === opened.tabId)) { ownerWindowId = win.windowId; break; }
    }
    assert(ownerWindowId !== null, '找不到新 tab 所在窗口：' + JSON.stringify(opened));
    // 显式聚焦该窗口（用户意图）再做 tab-select；记录器至少应留下一次切换步骤。
    expectOk(await cliJson(['window', 'focus', String(ownerWindowId), '--session', sessionId]), 'window focus for record');
    expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record switch start');
    expectOk(await cliJson(['tab', 'select', String(opened.tabId), '--session', sessionId]), 'tab select for record');
    await sleep(700);
    expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record switch stop');
    const recordingList = expectOk(await cliJson(['record', 'list', '--session', sessionId]), 'record list switch');
    const recording = (recordingList.recordings || [])[0] || {};
    const kinds = (recording.events || []).map((event) => event.kind);
    const switched = kinds.some((kind) => kind === 'tab-switch' || kind === 'window-switch');
    const after = expectOk(await cliJson(['window', 'list', '--session', sessionId]), 'window list after select');
    let selected = null;
    for (const win of after.windows || []) {
      const found = (win.tabs || []).find((tab) => tab.tabId === opened.tabId);
      if (found) selected = found;
    }
    await cliJson(['tab', 'close', String(opened.tabId), '--session', sessionId]);
    assert(selected && selected.active === true, 'tab.select 后目标 tab 不是 active：' + JSON.stringify(selected));
    assert(switched, '没有记录切换步骤：' + JSON.stringify(kinds));
    return 'switched(' + kinds.join(',') + ')';
  });

  await check('20d4. record 导航后恢复记录器', async () => {
    expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record nav start');
    expectOk(await cliJson(['navigate', pageUrl + '?record-nav=1', '--session', sessionId]), 'navigate during record');
    await sleep(900);
    expectOk(await cliJson(['click', '#submit-btn', '--session', sessionId]), 'click after record nav');
    await sleep(300);
    expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record nav stop');
    const listed = expectOk(await cliJson(['record', 'list', '--session', sessionId]), 'record list nav');
    const recording = (listed.recordings || [])[0] || {};
    const clicked = (recording.events || []).some((event) => event.kind === 'click' && String(event.url || '').includes('record-nav=1'));
    assert(clicked, '导航后没有继续记录点击：' + JSON.stringify((recording.events || []).map((event) => ({ kind: event.kind, url: event.url }))));
    return 'recovered ' + (recording.events || []).length + ' events';
  });

  await check('20d5. record 记录跨窗口步骤', async () => {
    expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record window start');
    const opened = expectOk(await cliJson(['tab', 'new', 'about:blank', '--window', '--session', sessionId]), 'tab new window for record');
    await sleep(700);
    expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record window stop');
    const listed = expectOk(await cliJson(['record', 'list', '--session', sessionId]), 'record list window');
    const recording = (listed.recordings || [])[0] || {};
    const switched = (recording.events || []).find((event) => event.kind === 'window-switch');
    if (opened && opened.tabId != null) await cliJson(['tab', 'close', String(opened.tabId), '--session', sessionId]);
    assert(switched, '没有记录 window-switch：' + JSON.stringify((recording.events || []).map((event) => event.kind)));
    assert(switched.toWindowId != null && switched.fromWindowId != null && switched.toWindowId !== switched.fromWindowId, '窗口 id 不正确：' + JSON.stringify(switched));
    return 'window-switch ' + switched.fromWindowId + '→' + switched.toWindowId;
  });

  await check('20d6. record 记录 iframe 内操作', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'record iframe navigate');
    expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record frame start');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'observe frames for record');
    const frame = (frames.frames || []).find((item) => Number(item.frameId) > 0 && String(item.observation || '').includes('框架内按钮'));
    assert(frame, '没有找到 iframe 按钮 frame');
    const local = /button "框架内按钮" \[@(e\d+)\]/.exec(String(frame.observation || ''));
    assert(local, '没有找到 iframe 按钮 ref');
    const alias = (frames.aliases || []).find((item) => Number(item.frameId) > 0 && item.localRef === '@' + local[1] && String(item.url || '').includes('/frame.html')) || (frames.aliases || []).find((item) => Number(item.frameId) > 0 && String(item.url || '').includes('/frame.html'));
    assert(alias, '没有 iframe 按钮别名');
    expectOk(await cliJson(['click', alias.ref, '--session', sessionId]), 'click frame button for record');
    await sleep(500);
    expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record frame stop');
    const listed = expectOk(await cliJson(['record', 'list', '--session', sessionId]), 'record list frame');
    const recording = (listed.recordings || [])[0] || {};
    const framed = (recording.events || []).find((event) => event.kind === 'click' && Number(event.frameId) > 0);
    assert(framed, '没有记录 iframe 内点击：' + JSON.stringify((recording.events || []).map((event) => ({ kind: event.kind, frameId: event.frameId }))));
    assert(framed.documentId, 'iframe 事件缺少 documentId：' + JSON.stringify({ frameId: framed.frameId, documentId: framed.documentId }));
    assert(framed.boundary && framed.boundary.documentId === framed.documentId, 'iframe 事件缺少 replay boundary：' + JSON.stringify(framed.boundary));
    return 'frameId=' + framed.frameId + ' documentId=' + String(framed.documentId).slice(0, 12);
  });

  await check('20d7. record 跨 frame popup 归属', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'record popup navigate');
    expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record cross popup start');
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'observe frames for popup');
    const frame = (frames.frames || []).find((item) => Number(item.frameId) > 0 && String(item.observation || '').includes('打开菜单'));
    assert(frame, '没有找到 iframe 菜单 frame');
    const local = /button "打开菜单" \[@(e\d+)\]/.exec(String(frame.observation || ''));
    assert(local, '没有找到 iframe 菜单触发 ref');
    // alias 选择：两套实现的 ref 命名不同（JS：全局 @eN；TS：@f<frameId>eN），
    // 且观察里给出的 ref 可能是全局也可能是帧内 @eN。这里按“同一 frame + 四种等价写法”匹配，
    // 不能再拿 ref 直接和帧内 @eN 比较（旧写法在两类实现间必有一边不中）。
    const expectedFrameId = Number(frame.frameId);
    const localRef = '@' + local[1];
    const frameAliases = (frames.aliases || []).filter((item) => Number(item.frameId) === expectedFrameId
      || String(item.url || '').includes('frame-x.html'));
    const alias = frameAliases.find((item) => item.ref === localRef
      || item.localRef === localRef
      || item.ref === '@f' + expectedFrameId + 'e' + local[1]
      || item.localRef === '@f' + expectedFrameId + 'e' + local[1])
      || frameAliases.find((item) => String(item.url || '').includes('frame-x.html'));
    assert(alias, '没有 iframe 菜单别名');
    expectOk(await cliJson(['click', alias.ref, '--session', sessionId]), 'click iframe menu trigger');
    await sleep(3000);
    const visible = expectOk(await cliJson(['evaluate', "document.getElementById('xframe-menu').hidden === false", '--session', sessionId]), 'read popup visibility');
    assert(visible.value === true, 'iframe menu 没有打开顶层菜单');
    const top = expectOk(await cliJson(['observe', '--session', sessionId]), 'observe top menu');
    const item = /menuitem "跨域菜单项" \[@(e\d+)\]/.exec(String(top.observation || ''));
    assert(item, '顶层菜单项没有 ref：' + String(top.observation || '').slice(-500));
    expectOk(await cliJson(['click', '@' + item[1], '--session', sessionId]), 'click top menu item');
    await sleep(500);
    expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record cross popup stop');
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('xframe-out').textContent", '--session', sessionId]), 'xframe popup out');
    assert(out.value === 'xframe-menu-clicked', '菜单点击没有回传：' + JSON.stringify(out.value));
    return 'iframe menu -> top menu item';
  });

  await check('20d8. record 文本 diff + 媒体进度', async () => {
    expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record text/media start');
    expectOk(await cliJson(['click', '#submit-btn', '--session', sessionId]), 'click for text diff');
    await sleep(150);
    expectOk(await cliJson(['evaluate', "document.getElementById('out').textContent='diff-' + Date.now(); 'ok'", '--session', sessionId]), 'mutate text for diff');
    await sleep(800);
    expectOk(await cliJson(['evaluate', "const v=document.getElementById('media-demo'); v.dispatchEvent(new Event('play')); v.dispatchEvent(new Event('timeupdate')); 'ok'", '--session', sessionId]), 'dispatch media events');
    await sleep(300);
    expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record text/media stop');
    const listed = expectOk(await cliJson(['record', 'list', '--session', sessionId]), 'record list text/media');
    const recording = (listed.recordings || [])[0] || {};
    const clickEvent = (recording.events || []).find((event) => event.kind === 'click' && Array.isArray(event.textChanges) && event.textChanges.length > 0);
    assert(clickEvent, '没有记录文本变化：' + JSON.stringify((recording.events || []).map((event) => ({ kind: event.kind, textChanges: event.textChanges }))));
    const mediaEvent = (recording.events || []).find((event) => Array.isArray(event.media) && event.media.length > 0);
    assert(mediaEvent, '没有记录媒体进度：' + JSON.stringify((recording.events || []).map((event) => ({ kind: event.kind, media: event.media }))));
    return 'textChanges=' + clickEvent.textChanges.length + ' media=' + mediaEvent.media.length;
  });

  await check('20d9. record hover 停留', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record dwell start');
      expectOk(await cliJson(['hover', '#more-link', '--session', sessionId]), 'hover link');
      await sleep(1200);
      expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record dwell stop');
      const listed = expectOk(await cliJson(['record', 'list', '--session', sessionId]), 'record list dwell');
      const recording = (listed.recordings || [])[0] || {};
      const hoverEvent = (recording.events || []).find((event) => event.kind === 'hover' && event.dwellMs === 800);
      if (hoverEvent) return 'hover dwell=' + hoverEvent.dwellMs;
      if (attempt === 1) {
        assert(hoverEvent, '没有记录 hover 停留：' + JSON.stringify((recording.events || []).map((event) => ({ kind: event.kind, dwellMs: event.dwellMs }))));
      }
    }
    return 'hover dwell=800';
  });

  await check('20d10. record 默认过滤 Agent 动作', async () => {
    expectOk(await cliJson(['record', 'start', '--session', sessionId]), 'record agent-filter start');
    expectOk(await cliJson(['click', '#submit-btn', '--session', sessionId]), 'agent click should be filtered');
    await sleep(500);
    expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record agent-filter stop');
    const listed = expectOk(await cliJson(['record', 'list', '--session', sessionId]), 'record list agent-filter');
    const recording = (listed.recordings || [])[0] || {};
    const clicks = (recording.events || []).filter((event) => event.kind === 'click');
    assert(clicks.length === 0, 'Agent 动作没有被过滤：' + JSON.stringify(clicks.map((event) => ({ actor: event.actor, selector: event.selector }))));
    return 'filtered';
  });

  await check('20d11. 焦点策略：tab.new 默认不激活', async () => {
    const created = expectOk(await cliJson(['tab', 'new', 'about:blank', '--session', sessionId]), 'focus tab new');
    const listed = expectOk(await cliJson(['window', 'list', '--session', sessionId]), 'focus list after tab');
    let createdTab = null;
    let ownerWin = null;
    for (const win of listed.windows || []) {
      const found = (win.tabs || []).find((tab) => tab.tabId === created.tabId);
      if (found) {
        createdTab = found;
        ownerWin = win;
        break;
      }
    }
    assert(createdTab, '找不到新 tab：' + JSON.stringify({ created, windows: (listed.windows || []).map((win) => ({ windowId: win.windowId, tabs: (win.tabs || []).map((tab) => tab.tabId) })) }));
    assert(createdTab.active === false, 'tab.new 默认不应激活新 tab：' + JSON.stringify({ createdTab, windowId: ownerWin.windowId }));
    expectOk(await cliJson(['tab', 'close', String(created.tabId), '--session', sessionId]), 'focus cleanup tab');
    return 'tab.new 未激活（window=' + ownerWin.windowId + '）';
  });

  await check('20e. debug duplicates 重复请求检测', async () => {
    expectOk(await cliJson(['debug', 'start', '--name', 'dup', '--session', sessionId]), 'debug start dup');
    for (let i = 0; i < 3; i += 1) {
      expectOk(await cliJson(['click', '#ping-btn', '--session', sessionId]), 'dup click ' + i);
      await sleep(150);
    }
    await sleep(1200);
    const dup = expectOk(await cliJson(['debug', 'duplicates', '--window-ms', '10000', '--filter', '/api/ping', '--session', sessionId]), 'debug duplicates');
    assert(Array.isArray(dup.groups) && dup.groups.length >= 1, '没有检测到重复请求：' + JSON.stringify(dup));
    assert(dup.groups[0].count >= 3, '重复计数不对：' + dup.groups[0].count);
    await cliJson(['debug', 'stop', '--session', sessionId]);
    return 'count=' + dup.groups[0].count;
  });

  await check('20e2. debug coverage 明确缺口', async () => {
    expectOk(await cliJson(['debug', 'start', '--session', sessionId]), 'debug coverage start');
    expectOk(await cliJson(['click', '#ping-btn', '--session', sessionId]), 'debug coverage ping');
    await sleep(300);
    const coverage = expectOk(await cliJson(['debug', 'coverage', '--session', sessionId]), 'debug coverage');
    assert(Number(coverage.requests && coverage.requests.total) >= 1, 'coverage 没有请求：' + JSON.stringify(coverage));
    assert(Array.isArray(coverage.gaps), 'coverage 缺少 gaps');
    assert(coverage.gaps.some((gap) => gap.kind === 'response-body'), '未开 bodies 时没有 response-body gap：' + JSON.stringify(coverage.gaps));
    assert(coverage.complete === false, '有 gap 时 complete 应为 false');
    await cliJson(['debug', 'stop', '--session', sessionId]);
    return 'requests=' + coverage.requests.total + ' gaps=' + coverage.gaps.length;
  });

  await check('20f. debug rule_add fulfill/block 拦截请求', async () => {
    const fulfill = { urlPattern: '*/api/ping*', action: 'fulfill', status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":false}' };
    expectOk(await cliJson(['debug', 'rule_add', '--rule', JSON.stringify(fulfill), '--session', sessionId]), 'rule add fulfill');
    await cliJson(['click', '#ping-btn', '--session', sessionId]);
    const listed = expectOk(await cliJson(['debug', 'rule_list', '--session', sessionId]), 'rule list');
    assert(listed.rules.length === 1 && listed.rules[0].action === 'fulfill', '规则列表不对：' + JSON.stringify(listed.rules));
    const hit = expectOk(await cliJson(['evaluate', "document.getElementById('ping-out').textContent", '--session', sessionId]), 'ping after fulfill');
    assert(hit.value === 'bad', 'fulfill 规则没有生效：' + JSON.stringify(hit.value));
    expectOk(await cliJson(['debug', 'rule_clear', '--session', sessionId]), 'rule clear');

    await cliJson(['click', '#ping-btn', '--session', sessionId]);
    const normal = expectOk(await cliJson(['evaluate', "document.getElementById('ping-out').textContent", '--session', sessionId]), 'ping after clear');
    assert(normal.value === 'ok', '清理规则后应恢复真实响应：' + JSON.stringify(normal.value));

    expectOk(await cliJson(['debug', 'rule_add', '--rule', JSON.stringify({ urlPattern: '*/api/ping*', action: 'block' }), '--session', sessionId]), 'rule add block');
    await cliJson(['click', '#ping-btn', '--session', sessionId]);
    const blocked = expectOk(await cliJson(['evaluate', "document.getElementById('ping-out').textContent", '--session', sessionId]), 'ping after block');
    assert(blocked.value === 'error', 'block 规则没有生效：' + JSON.stringify(blocked.value));
    expectOk(await cliJson(['debug', 'rule_clear', '--session', sessionId]), 'rule clear 2');
    return 'fulfill→bad, clear→ok, block→error';
  });

  await check('20f2. debug rule 启用/停用/删除', async () => {
    const added = expectOk(await cliJson(['debug', 'rule_add', '--rule', '{"action":"block","urlPattern":"*rule-toggle*"}', '--session', sessionId]), 'rule add');
    const rule = (added.rules || []).find((item) => String(item.urlPattern).includes('rule-toggle'));
    assert(rule && rule.id, '规则没有 id：' + JSON.stringify(added.rules || []));
    const disabled = expectOk(await cliJson(['debug', 'rule_disable', String(rule.id), '--session', sessionId]), 'rule disable');
    assert((disabled.rules || []).find((item) => item.id === rule.id).enabled === false, '停用未生效');
    const removed = expectOk(await cliJson(['debug', 'rule_remove', String(rule.id), '--session', sessionId]), 'rule remove');
    assert(!(removed.rules || []).some((item) => item.id === rule.id), '删除未生效');
    return 'id=' + rule.id;
  });

  await check('20f3. 规则导出/导入', async () => {
    expectOk(await cliJson(['debug', 'rule_add', '--rule', '{"action":"fulfill","urlPattern":"*rule-export*","body":"ok"}', '--session', sessionId]), 'rule add for export');
    const file = path.join(outDir, 'rules.json');
    expectOk(await cliJson(['debug', 'rule_export', '--output', file, '--session', sessionId]), 'rule export');
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    assert(Array.isArray(snapshot.rules) && snapshot.rules.length >= 1, '规则导出为空');
    expectOk(await cliJson(['debug', 'rule_clear', '--session', sessionId]), 'rule clear before import');
    const imported = expectOk(await cliJson(['debug', 'rule_import', '--file', file, '--session', sessionId]), 'rule import');
    assert(imported.imported >= 1, '规则导入失败');
    expectOk(await cliJson(['debug', 'rule_clear', '--session', sessionId]), 'rule clear after import');
    return 'rules=' + snapshot.rules.length;
  });

  await check('20g. video prune 清理过期录制', async () => {
    const started = expectOk(await cliJson(['video', 'start', '--duration', '1s', '--session', sessionId]), 'video for prune');
    await sleep(1800);
    // 等录制真正落库后再 prune；否则全量高负载下 save 可能晚于 prune，导致“过期录制仍在”。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = expectOk(await cliJson(['video', 'list', '--session', sessionId]), 'video list before prune');
      if ((current.recordings || []).some((item) => item.id === started.recordingId)) break;
      await sleep(200);
    }
    const pruned = expectOk(await cliJson(['video', 'prune', '--ttl', '1ms', '--session', sessionId]), 'video prune');
    assert(pruned.removed >= 1, '没有清理过期录制：' + JSON.stringify(pruned));
    const listed = expectOk(await cliJson(['video', 'list', '--session', sessionId]), 'video list after prune');
    assert(!(listed.recordings || []).some((item) => item.id === started.recordingId), '过期录制仍然在列表里');
    return 'removed=' + pruned.removed;
  });

  await check('20h. audit list --limit/--offset 分页', async () => {
    const first = expectOk(await cliJson(['audit', 'list', '--limit', '1', '--session', sessionId]), 'audit first');
    assert((first.entries || []).length === 1, 'limit=1 应只返回一条');
    const second = expectOk(await cliJson(['audit', 'list', '--limit', '1', '--offset', '1', '--session', sessionId]), 'audit offset');
    assert((second.entries || []).length === 1, 'offset=1 应返回一条');
    assert(second.total >= 2, 'total 应 >= 2：' + second.total);
    const firstKey = (first.entries[0].ts || 0) + ':' + first.entries[0].method;
    const secondKey = (second.entries[0].ts || 0) + ':' + second.entries[0].method;
    assert(firstKey !== secondKey, 'offset 没有生效（两页同一条）');
    return 'total=' + second.total;
  });

  await check('20i. screenshot --scope viewport 与整页区分', async () => {
    const viewport = expectOk(await cliJson(['screenshot', '--mode', 'auto', '--scope', 'viewport', '--out', path.join(outDir, 'scope-viewport.png'), '--session', sessionId]), 'scope viewport');
    const full = expectOk(await cliJson(['screenshot', '--mode', 'auto', '--out', path.join(outDir, 'scope-full.png'), '--session', sessionId]), 'scope full');
    assert(viewport.height > 0 && full.height > 0, '截图高度无效');
    assert(viewport.height < full.height, 'viewport 截图不应高于整页：' + JSON.stringify({ viewport: viewport.height, full: full.height }));
    return 'viewport=' + viewport.height + ' full=' + full.height;
  });

  await check('20j. MCP server：initialize → tools/list → observe/click/screenshot', async () => {
    const mcp = startMcp({ ...process.env, BB_HOME: bbHome, BB_PORT: String(port), BB_NO_PROBE: '1' });
    try {
      const init = await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e' } });
      assert(init.result && init.result.serverInfo && init.result.serverInfo.name === 'browser-bridge', 'initialize 不对：' + JSON.stringify(init.result));
      const list = await mcp.rpc('tools/list', {});
      const tools = (list.result && list.result.tools) || [];
      assert(tools.length >= 10, 'tools 数量不足：' + tools.length);

      const observed = await mcp.rpc('tools/call', { name: 'browser_observe', arguments: { session: sessionId } });
      const observedText = observed.result && observed.result.content && observed.result.content[0].text;
      assert(observed.result.isError === false, 'observe 失败：' + String(observedText).slice(0, 160));
      assert(String(observedText).includes('E2E 夹具页'), 'MCP observe 没返回页面内容');
      const rankedObserve = await mcp.rpc('tools/call', { name: 'browser_observe', arguments: { vom: true, vom_rank: true, vom_top: 5, vom_profile: 'compact', vom_per_group: 2, vom_group_tokens: 30, session: sessionId } });
      assert(rankedObserve.result.isError === false, 'MCP observe VOM flags 失败：' + String(rankedObserve.result.content[0].text).slice(0, 160));

      const brief = await mcp.rpc('tools/call', { name: 'browser_brief', arguments: { session: sessionId } });
      const briefText = brief.result && brief.result.content && brief.result.content[0].text;
      assert(brief.result.isError === false && String(briefText).includes('E2E 夹具页'), 'MCP brief 失败：' + String(briefText).slice(0, 160));

      const clicked = await mcp.rpc('tools/call', { name: 'browser_click', arguments: { selector: '#submit-btn', session: sessionId } });
      assert(clicked.result.isError === false, 'MCP click 失败：' + String(clicked.result.content[0].text).slice(0, 160));

      const evaluated = await mcp.rpc('tools/call', {
        name: 'browser_evaluate',
        arguments: { expression: "document.getElementById('out').textContent", session: sessionId },
      });
      assert(String(evaluated.result.content[0].text).includes('clicked:'), 'MCP evaluate 结果不对');

      const shotPath = path.join(outDir, 'mcp-shot.png');
      const shot = await mcp.rpc('tools/call', { name: 'browser_screenshot', arguments: { out: shotPath, session: sessionId } });
      assert(shot.result.isError === false, 'MCP screenshot 失败：' + String(shot.result.content[0].text).slice(0, 160));
      assert(existsSync(shotPath) && readFileSync(shotPath).length > 1000, 'MCP 截图没有落盘');
      const longPath = path.join(outDir, 'mcp-long.png');
      const longShot = await mcp.rpc('tools/call', { name: 'browser_screenshot', arguments: { out: longPath, full_page: true, tile_size: 512, stale_attempts: 2, session: sessionId } });
      assert(longShot.result.isError === false && /"tile_size"\s*:\s*512/.test(String(longShot.result.content[0].text)), 'MCP 长截图 tile_size 没有生效：' + String(longShot.result.content[0].text));
      assert(existsSync(longPath) && readFileSync(longPath).subarray(1, 4).toString() === 'PNG', 'MCP 长截图没有落盘');
      const pdfPath = path.join(outDir, 'mcp-doc.pdf');
      const pdfResult = await mcp.rpc('tools/call', { name: 'browser_pdf', arguments: { out: pdfPath, page_ranges: '1', margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }, scale: 1, session: sessionId } });
      assert(pdfResult.result.isError === false, 'MCP pdf 失败：' + String(pdfResult.result.content[0].text).slice(0, 160));
      const pdfBytes = readFileSync(pdfPath);
      assert(pdfBytes.subarray(0, 5).toString('ascii') === '%PDF-', 'MCP PDF 头不对');

      await cliJson(['session', 'resume', sessionId]).catch(() => {});
      const traceStarted = await mcp.rpc('tools/call', { name: 'browser_trace_start', arguments: { session: sessionId } });
      assert(traceStarted.result.isError === false, 'MCP trace_start 失败：' + String(traceStarted.result.content[0].text).slice(0, 160));
      await sleep(300);
      const traceStopped = await mcp.rpc('tools/call', { name: 'browser_trace_stop', arguments: { session: sessionId } });
      assert(traceStopped.result.isError === false, 'MCP trace_stop 失败：' + String(traceStopped.result.content[0].text).slice(0, 160));
      return 'tools=' + tools.length + ', shot=' + readFileSync(shotPath).length + 'B, trace ok';
    } finally {
      mcp.close();
    }
  });

  await check('20k. 会话可恢复：daemon 重启后 session 仍在且可继续操作', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'navigate before restart');
    console.log('   · daemon stop…');
    const stopped = await cli(['daemon', 'stop'], { timeoutMs: 30000 });
    assert(stopped.code === 0, 'daemon stop 失败（' + stopped.code + '）：' + stopped.stdout + ' ' + stopped.stderr);
    console.log('   · 重新拉起 daemon…');
    expectOk(await cliJson(['status'], { timeoutMs: 30000 }), 'status after restart');

    let connected = false;
    for (let i = 0; i < 20 && !connected; i += 1) {
      await sleep(1000);
      const state = await cliJson(['browsers'], { timeoutMs: 30000 });
      connected = Boolean(state.json && state.json.result && state.json.result.browsers && state.json.result.browsers.length);
    }
    assert(connected, 'daemon 重启后扩展没有重新连上');

    let restored = null;
    for (let i = 0; i < 60; i += 1) {
      const listed = expectOk(await cliJson(['session', 'list'], { timeoutMs: 30000 }), 'session list after restart');
      restored = (listed.sessions || []).find((item) => item.sessionId === sessionId);
      if (restored && restored.connected === true) break;
      await sleep(500);
    }
    assert(restored, '重启后会话丢了');
    assert(restored.connected === true, '恢复的会话应标记 connected：' + JSON.stringify(restored));

    const observed = expectOk(await cliJson(['observe', '--session', sessionId], { timeoutMs: 30000 }), 'observe after restart');
    assert(String(observed.observation).includes('E2E 夹具页'), '恢复后 observe 内容不对');
    return 'session ' + sessionId + ' 恢复并可操作';
  });

  await check('20l. session start --incognito（允许则成功，否则明确报错）', async () => {
    const result = await cliJson(['session', 'start', '--incognito']);
    if (result.code === 0) {
      const created = result.json.result;
      expectOk(await cliJson(['session', 'stop', created.sessionId]), 'stop incognito session');
      return 'incognito 可用（tab ' + created.tabId + '）';
    }
    assert(result.json && result.json.error, 'incognito 失败但没有 JSON 错误');
    assert(result.json.error.code === 'E_INCOGNITO_UNAVAILABLE', 'incognito 错误码不对：' + JSON.stringify(result.json.error));
    assert(/无痕|InPrivate/i.test(result.json.error.message), '错误信息没有提示如何开启：' + result.json.error.message);
    return 'E_INCOGNITO_UNAVAILABLE（扩展未获准 InPrivate）';
  });

  await check('20m. debug operations 时间线（请求关联 + 单条查询）', async () => {
    expectOk(await cliJson(['debug', 'start', '--name', 'ops', '--session', sessionId]), 'debug start ops');
    await cliJson(['click', '#ping-btn', '--session', sessionId]);
    await sleep(600);

    const listed = expectOk(await cliJson(['debug', 'operations', '--limit', '10', '--session', sessionId]), 'debug operations');
    const entries = listed.entries || [];
    assert(entries.length >= 1, '没有操作记录');
    assert(entries[0].id && entries[0].method, '操作记录缺 id/method：' + JSON.stringify(entries[0]));
    assert(typeof entries[0].durationMs === 'number', '操作记录缺 durationMs');

    const withRequests = entries.find((row) => row.method === 'click' && Number(row.requests) >= 1);
    assert(withRequests, 'operations 没有把请求关联到命令：' + JSON.stringify(entries.slice(0, 3)));

    const detail = expectOk(await cliJson(['debug', 'operation', withRequests.id, '--with-requests', '--session', sessionId]), 'debug operation');
    assert(detail.entry && detail.entry.id === withRequests.id, '单条查询结果不对');
    assert(Array.isArray(detail.requests) && detail.requests.length >= 1, '单条 operation 没有返回关联请求');
    assert(String(detail.requests[0].url).includes('/api/ping'), '关联到的请求不是 /api/ping');

    await cliJson(['debug', 'stop', '--session', sessionId]);
    return 'id=' + withRequests.id + ' reqs=' + detail.requests.length;
  });

  await check('20n. CLI 不能修改人工 daemonUrl 开关', async () => {
    const denied = await cliJson(['settings', 'set', '--daemon-url', 'ws://127.0.0.1:' + port + '/ws', '--session', sessionId]);
    assert(denied.code === 1 && denied.json && denied.json.error && denied.json.error.code === 'E_FORBIDDEN', 'CLI 修改 daemonUrl 应被拒绝：' + JSON.stringify(denied.json));
    return 'E_FORBIDDEN';
  });

  await check('20o. 规则拦截子资源（DNR）：图片被 block 后恢复', async () => {
    expectOk(await cliJson(['evaluate', "document.getElementById('sub-img').src = '/api/image?t=init' + Date.now()", '--session', sessionId]), 'img init request');
    await sleep(900);
    const before = expectOk(await cliJson(['evaluate', "document.getElementById('sub-img').naturalWidth", '--session', sessionId]), 'img before');
    assert(before.value === 1, '图片初始未加载：' + JSON.stringify(before.value));

    expectOk(await cliJson(['debug', 'rule_add', '--rule', JSON.stringify({ urlPattern: '*/api/image*', action: 'block' }), '--session', sessionId]), 'rule block image');
    expectOk(await cliJson(['evaluate', "document.getElementById('sub-img').src = '/api/image?t=blocked' + Date.now()", '--session', sessionId]), 'img blocked request');
    await sleep(1000);
    const blocked = expectOk(await cliJson(['evaluate', "document.getElementById('sub-img').naturalWidth", '--session', sessionId]), 'img blocked');
    if (blocked.value !== 0) {
      const listed = await cliJson(['debug', 'rule_list', '--session', sessionId]);
      assert(false, '子资源没有被 DNR 拦截：' + JSON.stringify(blocked.value) + ' rules=' + JSON.stringify(listed.json));
    }

    expectOk(await cliJson(['debug', 'rule_clear', '--session', sessionId]), 'clear image rule');
    expectOk(await cliJson(['evaluate', "document.getElementById('sub-img').src = '/api/image?t=restored' + Date.now()", '--session', sessionId]), 'img restored request');
    await sleep(1000);
    const restored = expectOk(await cliJson(['evaluate', "document.getElementById('sub-img').naturalWidth", '--session', sessionId]), 'img restored');
    assert(restored.value === 1, '清理规则后子资源没有恢复：' + JSON.stringify(restored.value));
    return 'block → 0，clear → 1';
  });

  await check('20p. 跨源 iframe：统一 @eN ref（含 --frames）', async () => {
    await cliJson(['session', 'stop', sessionId]);
    const fresh = expectOk(await cliJson(['session', 'start', '--browser', browser]), 'frames fresh session');
    sessionId = fresh.sessionId;
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'frames navigate');
    await cliJson(['wait-ms', '2000', '--session', sessionId]);
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'observe frames');
    assert(Array.isArray(frames.frames) && frames.frames.length >= 2, '应至少看到主文档 + 跨源 frame：' + JSON.stringify(frames.frames));
    const frame = frames.frames.find((item) => Number(item.frameId) > 0 && String(item.observation || '').includes('跨域按钮'));
    assert(frame, 'observe --frames 没看到跨域按钮：' + JSON.stringify(frames.frames.map((item) => ({ id: item.frameId, url: item.url, has: !!item.observation }))));
    const snapshot = String(frame.observation || '').slice();
    const local = /button "跨域按钮" \[@(e\d+)\]/.exec(snapshot);
    assert(local, '跨域按钮没有 ref：' + snapshot.slice(0, 300));
    const alias = (frames.aliases || []).find((item) => Number(item.frameId) > 0 && String(item.url || '').includes('frame-x.html'));
    assert(alias, '没有跨源 frame alias：' + JSON.stringify(frames.aliases));
    expectOk(await cliJson(['click', alias.ref, '--session', sessionId]), 'click cross frame');
    await sleep(600);
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('xframe-out').textContent", '--session', sessionId]), 'xframe out');
    assert(out.value === 'xframe-clicked', '跨源点击没有回传到主文档：' + JSON.stringify(out.value));
    return 'cross frame ref=' + alias.ref;
  });

  await check('20p2. observe --frames 标记隐藏 iframe', async () => {
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'observe hidden frame');
    assert(frames.hiddenFrames >= 1, '没有标记隐藏 frame：' + JSON.stringify((frames.frames || []).map((f) => ({ id: f.frameId, hidden: f.hidden, reason: f.hiddenReason }))));
    assert(Array.isArray(frames.frameGaps), 'observe-frames 没有暴露 frameGaps：' + JSON.stringify(frames.frameGaps));
    assert(frames.frameGapCounts && typeof frames.frameGapCounts === 'object', 'observe-frames 缺少 frameGapCounts');
    assert(frames.frameRepairs && Number.isInteger(frames.frameRepairs.skippedHidden), 'observe-frames 缺少 frameRepairs 统计：' + JSON.stringify(frames.frameRepairs));
    assert(Number.isInteger(frames.frameRepairs.pruned), 'frameRepairs 缺少 inventory 对账计数：' + JSON.stringify(frames.frameRepairs));
    const hidden = (frames.frames || []).find((frame) => frame.hidden === true);
    assert(hidden && hidden.frameId > 0, '隐藏 frame 记录不完整：' + JSON.stringify(hidden));
    const hiddenCross = (frames.frames || []).find((frame) => frame.hidden === true && String(frame.url || '').includes('frame-x.html'));
    assert(hiddenCross, '跨源隐藏 frame 未标记：' + JSON.stringify((frames.frames || []).map((f) => ({ url: f.url, hidden: f.hidden }))));
    return 'hidden frame=' + hidden.frameId + ' cross=' + hiddenCross.frameId;
  });

  await check('20q. session rebind 拒绝 Agent 窗口标签页', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'session list for rebind');
    const current = (listed.sessions || [])[0] || {};
    const denied = await cliJson(['session', 'rebind', '--tab', String(current.tabId), '--session', sessionId]);
    assert(denied.code === 1 && denied.json && denied.json.error && /E_FORBIDDEN|E_BORROW_CONFLICT/.test(denied.json.error.code), 'rebind 不应借用 Agent 窗口标签页：' + JSON.stringify(denied.json));
    return denied.json.error.code;
  });

  await check('20q2. tab move 跨窗口移动', async () => {
    const created = expectOk(await cliJson(['tab', 'new', 'about:blank', '--window', '--session', sessionId]), 'tab new for move');
    const listBefore = expectOk(await cliJson(['tab', 'list', '--scope', 'all', '--session', sessionId]), 'tab list for move');
    const first = (listBefore.tabs || []).find((tab) => tab.windowId !== created.windowId);
    assert(first && created.tabId, '没有找到目标窗口/tab');
    expectOk(await cliJson(['tab', 'move', String(created.tabId), '--to-window', String(first.windowId), '--session', sessionId]), 'tab move');
    const listAfter = expectOk(await cliJson(['tab', 'list', '--scope', 'all', '--session', sessionId]), 'tab list after move');
    const moved = (listAfter.tabs || []).find((tab) => tab.tabId === created.tabId);
    assert(moved && moved.windowId === first.windowId, 'tab 没有移动到目标窗口');
    expectOk(await cliJson(['tab', 'close', String(created.tabId), '--session', sessionId]), 'close moved tab');
    return 'window=' + first.windowId;
  });

  await check('20q3. window list/focus 窗口路由', async () => {
    const listed = expectOk(await cliJson(['window', 'list', '--session', sessionId]), 'window list');
    assert(listed.windows.length >= 1, '没有窗口');
    const focused = listed.windows.find((win) => win.focused) || listed.windows[0];
    expectOk(await cliJson(['window', 'focus', String(focused.windowId), '--session', sessionId]), 'window focus');
    return 'windows=' + listed.windows.length;
  });

  await check('20q4. window ensure 复用/创建 Agent 窗口', async () => {
    const ensured = expectOk(await cliJson(['window', 'ensure', '--session', sessionId]), 'window ensure');
    assert(Number.isInteger(ensured.windowId) && Number.isInteger(ensured.tabId), 'window ensure 返回不完整');
    // 会话所在 tab 不能关：ensure 可能复用当前 Agent 窗口里的活动 tab（就是 session 自己）。
    const listed = expectOk(await cliJson(['session', 'list']), 'session list for ensure');
    const current = (listed.sessions || []).find((item) => item.sessionId === sessionId);
    if (!current || ensured.tabId !== current.tabId) {
      await cliJson(['tab', 'close', String(ensured.tabId), '--session', sessionId]).catch(() => {});
    }
    return 'window=' + ensured.windowId;
  });

  await check('20q5. read-only scope 拒绝变更动作', async () => {
    const ro = expectOk(await cliJson(['session', 'start', '--scope', 'read']), 'readonly session start');
    assert(ro.sessionId, '只读会话没有 sessionId');
    try {
      const click = await cliJson(['click', '#submit-btn', '--session', ro.sessionId]);
      assert(click.json && click.json.ok === false, '只读会话允许了 click：' + JSON.stringify(click.json));
      assert(click.json.error && click.json.error.code === 'E_READ_ONLY', '只读会话错误码不对：' + JSON.stringify(click.json.error));
    } finally {
      await cliJson(['session', 'stop', ro.sessionId]).catch(() => {});
    }
    return 'click=E_READ_ONLY';
  });

  await check('20q6. per-tab read-only / allowedOrigins', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'session list before tab policy');
    const current = (listed.sessions || []).find((item) => item.sessionId === sessionId) || {};
    assert(Number.isInteger(current.tabId), '当前会话没有 tabId');
    try {
      expectOk(await cliJson(['tab', 'policy', String(current.tabId), '--read-only', '--session', sessionId]), 'tab policy readonly');
      const authority = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'authority readonly sync');
      assert(authority.authority && authority.authority.four && authority.authority.four.action.allowed === false, '只读 tab 的 action 应为 false：' + JSON.stringify(authority.authority && authority.authority.four));
      assert(authority.authority.four.action.deniedReason === 'read-only', '只读 tab 的 deniedReason 不对：' + JSON.stringify(authority.authority.four.action));
      const click = await cliJson(['click', '#submit-btn', '--session', sessionId]);
      assert(click.json && click.json.ok === false, 'per-tab 只读允许了 click：' + JSON.stringify(click.json));
      assert(click.json.error && click.json.error.code === 'E_READ_ONLY', 'per-tab 只读错误码不对：' + JSON.stringify(click.json.error));
      expectOk(await cliJson(['tab', 'policy', String(current.tabId), '--allow-origins', new URL(pageUrl).origin, '--session', sessionId]), 'tab policy origins');
      const blocked = await cliJson(['navigate', 'https://example.com', '--session', sessionId]);
      assert(blocked.json && blocked.json.ok === false, 'allowedOrigins 允许了跨源导航：' + JSON.stringify(blocked.json));
      assert(blocked.json.error && blocked.json.error.code === 'E_FORBIDDEN', 'allowedOrigins 错误码不对：' + JSON.stringify(blocked.json.error));
    } finally {
      await cliJson(['tab', 'policy', String(current.tabId), '--clear', '--session', sessionId]).catch(() => {});
    }
    return 'readOnly + allowedOrigins enforced';
  });

  await check('20q7. tab group 命名标签组', async () => {
    const created = expectOk(await cliJson(['tab', 'new', pageUrl, '--group', 'E2E-Group', '--session', sessionId]), 'tab new group');
    assert(Number.isInteger(created.groupId), 'tab new 没有返回 groupId：' + JSON.stringify(created));
    try {
      const listed = expectOk(await cliJson(['tab', 'list', '--scope', 'all', '--session', sessionId]), 'tab list group');
      const tab = (listed.tabs || []).find((item) => item.tabId === created.tabId);
      assert(tab, '标签组里的 tab 不在列表：' + JSON.stringify(listed.tabs));
      assert(tab.groupId === created.groupId, 'tab groupId 不一致：' + JSON.stringify(tab));
      assert(tab.group === 'E2E-Group', 'tab group 标题不一致：' + JSON.stringify(tab));
    } finally {
      await cliJson(['tab', 'close', String(created.tabId), '--session', sessionId]).catch(() => {});
    }
    return 'group=' + created.groupId;
  });

  await check('20q8. 命名 tab alias 可驱动动作', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'session list alias');
    const current = (listed.sessions || []).find((item) => item.sessionId === sessionId) || {};
    assert(Number.isInteger(current.tabId), '当前会话没有 tabId');
    expectOk(await cliJson(['tab', 'alias', String(current.tabId), 'e2e-alias', '--session', sessionId]), 'tab alias set');
    try {
      const aliases = expectOk(await cliJson(['tab', 'aliases', '--session', sessionId]), 'tab aliases');
      assert(aliases.aliases && aliases.aliases['e2e-alias'] === current.tabId, 'alias 列表不对：' + JSON.stringify(aliases));
      const clicked = expectOk(await cliJson(['click', '#submit-btn', '--tab-id', 'e2e-alias', '--session', sessionId]), 'click alias');
      assert(clicked.effectState === 'committed', 'alias 点击未提交：' + JSON.stringify(clicked));
    } finally {
      await cliJson(['tab', 'alias', String(current.tabId), '--clear', 'e2e-alias', '--session', sessionId]).catch(() => {});
    }
    return 'alias→tab ' + current.tabId;
  });

  await check('20q9. tab keepOpen + idle cleanup dry-run', async () => {
    const created = expectOk(await cliJson(['tab', 'new', pageUrl, '--keep-open', '--session', sessionId]), 'tab new keepOpen');
    try {
      const listed = expectOk(await cliJson(['tab', 'list', '--scope', 'all', '--session', sessionId]), 'tab list keepOpen');
      const tab = (listed.tabs || []).find((item) => item.tabId === created.tabId);
      assert(tab && tab.keepOpen === true, 'tab 没有 keepOpen：' + JSON.stringify(tab));
      const cleanup = expectOk(await cliJson(['tab', 'cleanup', '--idle-ms', '0', '--dry-run', '--session', sessionId]), 'tab cleanup dry');
      assert(cleanup.dryRun === true, 'cleanup 不是 dry-run：' + JSON.stringify(cleanup));
      assert(!(cleanup.close || []).includes(created.tabId), 'keepOpen tab 被列入关闭：' + JSON.stringify(cleanup.close));
      assert((cleanup.keep || []).some((item) => item.tabId === created.tabId && item.reason === 'keep-open'), 'keepOpen 未出现在 keep：' + JSON.stringify(cleanup.keep));
    } finally {
      await cliJson(['tab', 'close', String(created.tabId), '--session', sessionId]).catch(() => {});
    }
    return 'keepOpen=true, cleanup dry-run';
  });

  await check('20s1. seeded fixture：同 seed 可复现、异 seed 不同', async () => {
    const seedA = (String(process.env.BB_E2E_SEED || 'alpha').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)) || 'alpha';
    const seedB = seedA + 'x';
    const base = new URL('seeded.html', pageUrl).href;
    expectOk(await cliJson(['navigate', base + '?seed=' + seedA, '--session', sessionId]), 'seed navigate');
    const first = expectOk(await cliJson(['observe', '--vom', '--force', '--session', sessionId]), 'seed observe');
    const names = (first.nodes || []).map((node) => node.name).filter(Boolean).sort();
    assert(names.some((name) => name.startsWith(seedA + '-item-')), 'seed 没有生成内容：' + JSON.stringify(names.slice(0, 5)));
    expectOk(await cliJson(['navigate', base + '?seed=' + seedA, '--session', sessionId]), 'seed reload');
    const second = expectOk(await cliJson(['observe', '--vom', '--force', '--session', sessionId]), 'seed observe 2');
    const names2 = (second.nodes || []).map((node) => node.name).filter(Boolean).sort();
    assert(JSON.stringify(names2) === JSON.stringify(names), '同 seed 观察结果不稳定');
    expectOk(await cliJson(['navigate', base + '?seed=' + seedB, '--session', sessionId]), 'seed other navigate');
    const third = expectOk(await cliJson(['observe', '--vom', '--force', '--session', sessionId]), 'seed other observe');
    const names3 = (third.nodes || []).map((node) => node.name).filter(Boolean).sort();
    assert(JSON.stringify(names3) !== JSON.stringify(names), '不同 seed 结果相同');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'seed restore');
    return seedA + '=' + names.length + ' ' + seedB + '=' + names3.length;
  });

  await check('20s3. stress smoke：连续 observe/read', async () => {
    const base = new URL('seeded.html', pageUrl).href;
    expectOk(await cliJson(['navigate', base + '?seed=beta', '--session', sessionId]), 'stress seed navigate');
    for (let round = 0; round < 5; round += 1) {
      expectOk(await cliJson(['observe', '--force', '--session', sessionId]), 'stress observe ' + round);
      const read = expectOk(await cliJson(['read', '#seed-input', '--session', sessionId]), 'stress read ' + round);
      const value = (read.fields && read.fields[0] && read.fields[0].value) || '';
      assert(String(value).startsWith('beta-'), 'stress read 值不对：' + JSON.stringify(read));
    }
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'stress restore');
    return '5 rounds';
  });

  await check('20s4. bridge exec 受限脚本', async () => {
    const script = path.join(outDir, 'exec-script.mjs');
    writeFileSync(script, [
      "const observed = await page.observe({ maxNodes: 5 });",
      "await page.waitFor('#submit-btn', { timeout: 2000 });",
      "const button = page.locator('#submit-btn');",
      "await button.click();",
      "const text = await page.evaluate(\"document.getElementById('out').textContent\");",
      // locator 读取面（vm 沙箱）：textContent / getAttribute / count
      "const label = await page.locator('#out').textContent();",
      "const attr = await page.locator('#out').getAttribute('id');",
      "const buttons = await page.locator('button').count();",
      "console.log('exec-ok', observed.title);",
      "return { title: observed.title, text: text.value, label, attr, buttons };",
    ].join('\n'));
    const body = expectOk(await cliJson(['exec', '--file', script, '--session', sessionId]), 'exec script');
    assert(body.result && String(body.result.text || '').includes('clicked'), 'exec 结果不对：' + JSON.stringify(body.result));
    assert(String(body.result.label || '').includes('clicked'), 'vm locator.textContent 不对：' + JSON.stringify(body.result.label));
    assert(body.result.attr === 'out', 'vm locator.getAttribute 不对：' + JSON.stringify(body.result.attr));
    assert(Number(body.result.buttons) >= 1, 'vm locator.count 不对：' + JSON.stringify(body.result.buttons));
    assert(Array.isArray(body.logs) && body.logs.some((item) => /exec-ok/.test(item.text)), 'exec 没有捕获 console：' + JSON.stringify(body.logs));
    return 'exec result=' + body.result.text + ' buttons=' + body.result.buttons;
  });

  await check('20s5. WebMCP：list + call 页面工具', async () => {
    const base = new URL('webmcp.html', pageUrl).href;
    expectOk(await cliJson(['navigate', base, '--session', sessionId]), 'webmcp navigate');
    const listed = expectOk(await cliJson(['webmcp', 'list', '--session', sessionId]), 'webmcp list');
    assert(listed.available === true, 'WebMCP 不可用：' + JSON.stringify(listed));
    const names = (listed.tools || []).map((tool) => tool.name).sort();
    assert(names.includes('echo') && names.includes('set_out'), 'WebMCP 工具缺失：' + JSON.stringify(names));
    const echoed = expectOk(await cliJson(['webmcp', 'call', 'echo', '--input', '{"text":"hi"}', '--session', sessionId]), 'webmcp echo');
    assert(echoed.result && echoed.result.echo === 'hi', 'webmcp echo 结果不对：' + JSON.stringify(echoed));
    expectOk(await cliJson(['webmcp', 'call', 'set_out', '--input', '{"text":"written-by-webmcp"}', '--session', sessionId]), 'webmcp set_out');
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('out').textContent", '--session', sessionId]), 'webmcp out');
    assert(out.value === 'written-by-webmcp', 'webmcp 写入未生效：' + JSON.stringify(out));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'webmcp restore');
    return names.length + ' tools';
  });

  await check('20s6. VOM 阶段证据（facts/identity/relations/layout/paint/interact）', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'vom stages navigate');
    const observed = expectOk(await cliJson(['observe', '--vom', '--facts', '--force', '--session', sessionId]), 'vom stages observe');
    const stages = (observed.vom && observed.vom.stages) || [];
    assert(JSON.stringify(stages.map((stage) => stage.stage)) === JSON.stringify(['facts', 'identity', 'relations', 'layout', 'paint', 'interact']), 'VOM 阶段缺失：' + JSON.stringify(stages));
    for (const name of ['facts', 'identity', 'relations', 'layout', 'interact']) {
      const stage = stages.find((item) => item.stage === name);
      assert(stage && stage.ok === true, 'VOM 阶段未成立 ' + name + '：' + JSON.stringify(stage));
    }
    const nodes = (observed.vom && observed.vom.nodes) || [];
    assert(nodes.some((node) => node.bounds && node.pointerEvents !== undefined), 'VOM 节点缺少 layout 证据：' + JSON.stringify(nodes.slice(0, 2)));
    assert(nodes.some((node) => Array.isArray(node.ancestors) && node.ancestors.length > 0), 'VOM 节点缺少祖先关系：' + JSON.stringify(nodes.slice(0, 2)));
    assert(Array.isArray(observed.vom.edges) && observed.vom.edges.length > 0, 'VOM 缺少关系边：' + JSON.stringify(observed.vom.edges && observed.vom.edges.slice(0, 2)));
    return stages.map((stage) => stage.stage + '=' + stage.count).join(',');
  });

  await check('20s7. bridge exec QuickJS 沙箱（同步 page API）', async () => {
    const script = path.join(outDir, 'exec-quickjs.mjs');
    writeFileSync(script, [
      // QuickJS 沙箱是同步 page API：host 调用会阻塞返回，不写 await。
      "const observed = page.observe({ maxNodes: 5 });",
      "page.click('#submit-btn');",
      "const text = page.evaluate(\"document.getElementById('out').textContent\");",
      "return { title: observed.title, text: text.value };",
    ].join('\n'));
    const body = expectOk(await cliJson(['exec', '--file', script, '--sandbox', 'quickjs', '--session', sessionId]), 'exec quickjs');
    assert(body.result && String(body.result.text || '').includes('clicked'), 'QuickJS exec 结果不对：' + JSON.stringify(body.result));
    return 'quickjs result=' + body.result.text;
  });

  await check('20s8. QuickJS locator 全量（同步链式 + 错误码）', async () => {
    const script = path.join(outDir, 'exec-quickjs-locator.mjs');
    writeFileSync(script, [
      "page.locator('#kw').fill('quickjs-loc');",
      "const before = page.locator('#out').textContent();",
      "page.locator('#submit-btn').click();",
      "const after = page.locator('#out').textContent();",
      "const inputValue = page.locator('#kw').inputValue();",
      "const visible = page.locator('#out').isVisible();",
      "const attr = page.locator('#out').getAttribute('id');",
      "const buttons = page.locator('button').count();",
      "const enabled = page.locator('#submit-btn').isEnabled();",
      "const act = page.locator('#submit-btn').actionable();",
      "let errorCode = '';",
      "try { page.locator('#no-such-element').click(); } catch (e) { errorCode = e.code; }",
      "console.log('quickjs-locator', after);",
      "return { before, after, inputValue, visible, attr, buttons, enabled, actOk: act.ok, errorCode };",
    ].join('\n'));
    const body = expectOk(await cliJson(['exec', '--file', script, '--sandbox', 'quickjs', '--session', sessionId]), 'exec quickjs locator');
    const result = body.result || {};
    assert(String(result.after || '').includes('clicked'), 'QuickJS locator 未驱动点击：' + JSON.stringify(result));
    assert(result.inputValue === 'quickjs-loc', 'QuickJS locator.inputValue 不对：' + JSON.stringify(result.inputValue));
    assert(result.visible === true, 'QuickJS locator.isVisible 不对：' + JSON.stringify(result.visible));
    assert(result.attr === 'out', 'QuickJS locator.getAttribute 不对：' + JSON.stringify(result.attr));
    assert(Number(result.buttons) >= 1, 'QuickJS locator.count 不对：' + JSON.stringify(result.buttons));
    assert(result.enabled === true, 'QuickJS locator.isEnabled 不对：' + JSON.stringify(result.enabled));
    assert(result.actOk === true, 'QuickJS locator.actionable 不对：' + JSON.stringify(result.actOk));
    assert(result.errorCode === 'E_NOT_FOUND', 'QuickJS locator 错误码未保留：' + JSON.stringify(result.errorCode));
    assert(Array.isArray(body.logs) && body.logs.some((item) => /quickjs-locator/.test(item.text)), 'QuickJS locator 没有捕获 console：' + JSON.stringify(body.logs));
    // 同步契约：带 await 的脚本应被明确拒绝（E_BAD_ARG），而不是 wasm 断言。
    const awaitScript = path.join(outDir, 'exec-quickjs-await.mjs');
    writeFileSync(awaitScript, "const r = await page.observe(); return r.title;");
    const rejected = await cliJson(['exec', '--file', awaitScript, '--sandbox', 'quickjs', '--session', sessionId]);
    assert(rejected.code === 1 && rejected.json && rejected.json.error.code === 'E_BAD_ARG', 'QuickJS await 脚本应返回 E_BAD_ARG：' + JSON.stringify(rejected.json));
    return 'locator ok, buttons=' + result.buttons + ', await→E_BAD_ARG';
  });

  await check('20s9. session run log → recipe draft（不含输入值）', async () => {
    const fresh = expectOk(await cliJson(['session', 'start']), 'run-log session start');
    const sid = fresh.sessionId;
    const recipeName = 'e2e-runlog-draft';
    try {
      expectOk(await cliJson(['navigate', pageUrl, '--session', sid]), 'run-log navigate');
      expectOk(await cliJson(['fill', '#kw', '--value', 'runlog-secret', '--session', sid]), 'run-log fill');
      expectOk(await cliJson(['click', '#submit-btn', '--session', sid]), 'run-log click');
      const log = expectOk(await cliJson(['session', 'run-log', sid]), 'session run-log');
      assert(Array.isArray(log.steps) && log.steps.length >= 2, 'run log 步骤不足：' + JSON.stringify(log));
      assert(log.steps.some((step) => step.kind === 'navigate' && String(step.path || '').includes('test.html')), 'run log 缺少 navigate：' + JSON.stringify(log.steps.map((step) => step.kind)));
      assert(log.steps.some((step) => step.method === 'click' && step.target && step.target.selector === '#submit-btn'), 'run log 缺少 click target：' + JSON.stringify(log.steps));
      assert(!JSON.stringify(log).includes('runlog-secret'), 'run log 不应保存输入值');
      const drafted = expectOk(await cliJson(['recipe', 'draft', '--name', recipeName, '--session', sid]), 'recipe draft');
      assert(Array.isArray(drafted.steps) && drafted.steps.length >= 1 && typeof drafted.file === 'string', 'recipe draft 结果不对：' + JSON.stringify(drafted));
      assert(Array.isArray(drafted.skipped) && drafted.skipped.some((item) => item.method === 'fill'), 'fill 步骤应被跳过：' + JSON.stringify(drafted.skipped));
      expectOk(await cliJson(['recipe', 'approve', recipeName, '--confirm-human', '--by', 'e2e']), 'draft recipe approve');
      const ran = expectOk(await cliJson(['recipe', 'run', recipeName, '--session', sid]), 'draft recipe run');
      assert((ran.completed || 0) >= 1, '草稿 recipe 未执行成功：' + JSON.stringify(ran));
    } finally {
      await cliJson(['recipe', 'rm', recipeName]).catch(() => {});
      await cliJson(['session', 'stop', sid]).catch(() => {});
    }
    return 'run-log → draft → approve → run';
  });

  await check('20q10. 多 Agent session 共享同一 tab', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'share list');
    const current = (listed.sessions || []).find((item) => item.sessionId === sessionId) || {};
    assert(Number.isInteger(current.tabId), '共享测试缺少主会话 tabId');
    const shared = expectOk(await cliJson(['session', 'start', '--tab', String(current.tabId), '--share']), 'session share start');
    assert(shared.shared === true && shared.ownerSession === sessionId, '共享会话字段不对：' + JSON.stringify(shared));
    try {
      const observed = expectOk(await cliJson(['observe', '--force', '--session', shared.sessionId]), 'shared observe');
      assert(observed.refs >= 1, '共享会话 observe 无 refs：' + JSON.stringify(observed.refs));
      expectOk(await cliJson(['click', '#submit-btn', '--session', shared.sessionId]), 'shared click');
      const after = expectOk(await cliJson(['observe', '--force', '--session', sessionId]), 'owner observe after share');
      assert(String(after.observation || '').includes('clicked'), '主会话看不到共享会话改动：' + JSON.stringify(String(after.observation || '').slice(0, 200)));
    } finally {
      await cliJson(['session', 'stop', shared.sessionId]).catch(() => {});
    }
    const alive = expectOk(await cliJson(['evaluate', "document.title", '--session', sessionId]), 'owner alive after shared stop');
    assert(String(alive.value || '').includes('E2E 夹具页'), '共享会话停止后主会话/标签页不可用：' + JSON.stringify(alive));
    return 'shared=' + shared.sessionId + ' owner continues';
  });

  await check('20q11. 共享 tab 控制权：exclusive 闸门 + 租约 + handoff', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'control list');
    const owner = (listed.sessions || []).find((item) => item.sessionId === sessionId) || {};
    assert(Number.isInteger(owner.tabId), '控制权测试缺少主会话 tabId');
    // 主会话先写一次拿到租约，保证后面的 exclusive 判定是确定性的。
    expectOk(await cliJson(['click', '#submit-btn', '--session', sessionId]), 'owner acquire lease');
    const shared = expectOk(await cliJson(['session', 'start', '--tab', String(owner.tabId), '--share', '--control', 'exclusive']), 'control share start');
    const sharedId = shared.sessionId;
    try {
      assert(shared.shared === true && shared.ownerSession === sessionId, '共享会话字段不对：' + JSON.stringify(shared));
      assert(shared.control && shared.control.mode === 'exclusive', '--control exclusive 没有生效：' + JSON.stringify(shared.control));
      const status = expectOk(await cliJson(['session', 'control', sharedId]), 'control status');
      assert(status.mode === 'exclusive' && status.shared === true, '控制状态不对：' + JSON.stringify(status));
      assert(status.holder === sessionId && status.holdsControl === false, '控制权应暂由主会话持有：' + JSON.stringify(status));

      // 1) exclusive：非持有者的变更动作被拒，且拒绝信息带 holder/epoch
      const blocked = await cliJson(['click', '#submit-btn', '--session', sharedId]);
      assert(blocked.code === 1 && blocked.json && blocked.json.error.code === 'E_CONTROL_NOT_HELD', 'exclusive 下非持有者点击应被拒：' + JSON.stringify(blocked.json));
      assert(blocked.json.error.data && blocked.json.error.data.holder === sessionId, '拒绝信息应带 holder：' + JSON.stringify(blocked.json.error.data));
      // 2) 只读动作不受影响
      const observed = expectOk(await cliJson(['observe', '--force', '--session', sharedId]), 'control read allowed');
      assert(observed.refs >= 1, '共享会话只读 observe 应允许：' + JSON.stringify(observed.refs));
      // 3) 控制权被占用时认领 → E_CONTROL_BUSY
      const busy = await cliJson(['session', 'claim-control', sharedId]);
      assert(busy.code === 1 && busy.json && busy.json.error.code === 'E_CONTROL_BUSY', '控制权被占应返回 E_CONTROL_BUSY：' + JSON.stringify(busy.json));
      // 4) handoff → 共享会话拿到控制权，写动作生效
      const handed = expectOk(await cliJson(['session', 'handoff', sessionId, '--to', sharedId, '--lease', '2s']), 'handoff');
      assert(handed.holder === sharedId && handed.epoch >= 1, 'handoff 结果不对：' + JSON.stringify(handed));
      expectOk(await cliJson(['click', '#submit-btn', '--session', sharedId]), 'shared click after handoff');
      const clicked = expectOk(await cliJson(['evaluate', "document.getElementById('out').textContent", '--session', sharedId]), 'shared click result');
      assert(String(clicked.value).includes('clicked'), 'handoff 后共享会话点击未生效：' + JSON.stringify(clicked.value));
      // 5) 控制权已转交：主会话写被拒
      const ownerBlocked = await cliJson(['click', '#submit-btn', '--session', sessionId]);
      assert(ownerBlocked.code === 1 && ownerBlocked.json && ownerBlocked.json.error.code === 'E_CONTROL_NOT_HELD', '转交后主会话应被拒：' + JSON.stringify(ownerBlocked.json));
      // 6) 过期 epoch 的 CAS → E_CONTROL_STALE
      const stale = await cliJson(['session', 'claim-control', sharedId, '--expect-epoch', '0']);
      assert(stale.code === 1 && stale.json && stale.json.error.code === 'E_CONTROL_STALE', 'epoch 不符应返回 E_CONTROL_STALE：' + JSON.stringify(stale.json));
      // 7) 租约到期 → 控制权空闲（holder 变空）
      await sleep(2400);
      const expired = expectOk(await cliJson(['session', 'control', sharedId]), 'control after lease');
      assert(expired.holder === null, '租约到期后 holder 应为空：' + JSON.stringify(expired));
      assert(expired.epoch > handed.epoch, '租约到期应推进 epoch：' + JSON.stringify({ before: handed.epoch, now: expired.epoch }));
      // 8) 空闲后先到先得：显式 claim 一个长租约，释放后写动作自动认领（避免 2s 租约在慢机上过期）
      expectOk(await cliJson(['session', 'claim-control', sharedId, '--lease', '30s']), 'claim long lease');
      expectOk(await cliJson(['session', 'release-control', sharedId]), 'release long lease');
      expectOk(await cliJson(['click', '#submit-btn', '--session', sharedId]), 'shared click after lease expiry');
      const reclaimed = expectOk(await cliJson(['session', 'control', sharedId]), 'control after reclaim');
      assert(reclaimed.holder === sharedId, '空闲控制权应由写者认领：' + JSON.stringify(reclaimed));
      // 9) 主动释放 → 主会话可再写
      expectOk(await cliJson(['session', 'release-control', sharedId]), 'release control');
      const released = expectOk(await cliJson(['session', 'control', sharedId]), 'control after release');
      assert(released.holder === null, '释放后 holder 应为空：' + JSON.stringify(released));
      expectOk(await cliJson(['click', '#submit-btn', '--session', sessionId]), 'owner write after release');
    } finally {
      await cliJson(['session', 'control', sharedId, '--mode', 'open']).catch(() => {});
      await cliJson(['session', 'stop', sharedId]).catch(() => {});
    }
    const alive = expectOk(await cliJson(['evaluate', 'document.title', '--session', sessionId]), 'owner alive after control test');
    assert(String(alive.value || '').includes('E2E 夹具页'), '控制权测试后主会话不可用：' + JSON.stringify(alive.value));
    return 'exclusive 拒写 → handoff → 租约到期 → 认领 → 释放';
  });

  await check('20q12. 主会话停止 → 控制权/主会话转交给共享会话（tab 存活）', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'handoff-on-stop list');
    const owner = (listed.sessions || []).find((item) => item.sessionId === sessionId) || {};
    assert(Number.isInteger(owner.tabId), '转交测试缺少主会话 tabId');
    const shared = expectOk(await cliJson(['session', 'start', '--tab', String(owner.tabId), '--share']), 'handoff-on-stop share start');
    const sharedId = shared.sessionId;
    const stopped = expectOk(await cliJson(['session', 'stop', sessionId]), 'owner stop with handoff');
    assert(stopped.handedOff && stopped.handedOff.sessionId === sharedId, '主会话停止没有转交控制权：' + JSON.stringify(stopped));
    sessionId = null;
    const after = expectOk(await cliJson(['session', 'list']), 'handoff-on-stop list after');
    const promoted = (after.sessions || []).find((item) => item.sessionId === sharedId);
    assert(promoted, '转交后共享会话消失了：' + JSON.stringify(after.sessions));
    assert(promoted.shared === false && promoted.ownerSession === null, '共享会话未被提升为主会话：' + JSON.stringify(promoted));
    const title = expectOk(await cliJson(['evaluate', 'document.title', '--session', sharedId]), 'promoted evaluate');
    assert(String(title.value || '').includes('E2E 夹具页'), '转交后标签页不可用：' + JSON.stringify(title.value));
    expectOk(await cliJson(['click', '#submit-btn', '--session', sharedId]), 'promoted click');
    // 收尾：停掉被提升的主会话（关 tab），再重建主会话给后续用例。
    expectOk(await cliJson(['session', 'stop', sharedId]), 'promoted stop');
    const remaining = expectOk(await cliJson(['session', 'list']), 'handoff-on-stop list final');
    assert((remaining.sessions || []).length === 0, '收尾还有会话：' + JSON.stringify(remaining.sessions));
    const fresh = expectOk(await cliJson(['session', 'start']), 'handoff-on-stop fresh session');
    sessionId = fresh.sessionId;
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'handoff-on-stop fresh navigate');
    return 'handedOff=' + sharedId + ' tab 存活并重建主会话';
  });

  await check('20r. 协议协商（protocol + capabilities）', async () => {
    const status = expectOk(await cliJson(['status']), 'status protocol');
    assert(status.protocol === '1.9', 'daemon protocol 不是 1.9：' + JSON.stringify(status.protocol));
    const browser = (status.browsers || [])[0];
    assert(browser && browser.protocol === '1.9', '扩展 protocol 不是 1.9：' + JSON.stringify(browser && browser.protocol));
    assert(Array.isArray(browser.capabilities) && browser.capabilities.includes('frames'), '缺少 frames 能力：' + JSON.stringify(browser.capabilities));
    return 'protocol=1.9 caps=' + browser.capabilities.length;
  });

  await check('20s. recipe 草稿 → 审批 → 执行', async () => {
    const recipeFile = path.join(outDir, 'recipe-e2e.json');
    writeFileSync(recipeFile, JSON.stringify({
      name: 'e2e-recipe',
      steps: [{ method: 'click', params: { selector: '#submit-btn' } }],
    }), 'utf8');
    expectOk(await cliJson(['recipe', 'save', 'e2e-recipe', '--file', recipeFile]), 'recipe save');

    const blocked = await cliJson(['recipe', 'run', 'e2e-recipe', '--session', sessionId]);
    assert(blocked.code === 1 && blocked.json && blocked.json.error.code === 'E_RECIPE_NOT_APPROVED', '未审批的 recipe 应被拒绝：' + JSON.stringify(blocked.json));

    const unconfirmed = await cliJson(['recipe', 'approve', 'e2e-recipe']);
    assert(unconfirmed.code !== 0, 'approve 不带 --confirm-human 应该失败');

    expectOk(await cliJson(['recipe', 'approve', 'e2e-recipe', '--confirm-human', '--by', 'e2e']), 'recipe approve');
    const ran = expectOk(await cliJson(['recipe', 'run', 'e2e-recipe', '--session', sessionId]), 'recipe run');
    assert((ran.completed || 0) >= 1, 'recipe 没有执行成功：' + JSON.stringify(ran));

    // 审批绑定内容：审批后篡改步骤应被拒绝
    const storedPath = path.join(bbHome, 'recipes', 'e2e-recipe.json');
    const stored = JSON.parse(readFileSync(storedPath, 'utf8'));
    stored.steps.push({ method: 'click', params: { selector: '#submit-btn' } });
    writeFileSync(storedPath, JSON.stringify(stored, null, 2), 'utf8');
    const tampered = await cliJson(['recipe', 'run', 'e2e-recipe', '--session', sessionId]);
    assert(tampered.code === 1 && tampered.json && tampered.json.error.code === 'E_RECIPE_CHANGED', '篡改后的 recipe 应被拒绝：' + JSON.stringify(tampered.json));
    expectOk(await cliJson(['recipe', 'approve', 'e2e-recipe', '--confirm-human', '--by', 'e2e']), 're-approve');
    expectOk(await cliJson(['recipe', 'run', 'e2e-recipe', '--session', sessionId]), 'recipe run after re-approve');

    const expired = JSON.parse(readFileSync(storedPath, 'utf8'));
    expired.expiresAt = Date.now() - 1000;
    writeFileSync(storedPath, JSON.stringify(expired, null, 2), 'utf8');
    const stale = await cliJson(['recipe', 'run', 'e2e-recipe', '--session', sessionId]);
    assert(stale.code === 1 && stale.json && stale.json.error.code === 'E_RECIPE_EXPIRED', '过期审批应被拒绝：' + JSON.stringify(stale.json));
    expectOk(await cliJson(['recipe', 'approve', 'e2e-recipe', '--confirm-human', '--by', 'e2e']), 're-approve expired');
    expectOk(await cliJson(['recipe', 'run', 'e2e-recipe', '--session', sessionId]), 'recipe run after expiry re-approve');

    expectOk(await cliJson(['recipe', 'rm', 'e2e-recipe']), 'recipe rm');
    return '未审批被拒 → 审批 → 执行 → 篡改被拒 → 过期被拒 → 重新审批 → 执行';
  });

  await check('20s2. session pause/resume 阻断动作', async () => {
    expectOk(await cliJson(['session', 'pause', sessionId]), 'session pause');
    const blocked = await cliJson(['click', '#submit-btn', '--session', sessionId]);
    assert(blocked.code === 1 && blocked.json && blocked.json.error.code === 'E_SESSION_PAUSED', '暂停后动作应被拒绝：' + JSON.stringify(blocked.json));
    const observed = expectOk(await cliJson(['observe', '--session', sessionId]), 'observe while paused');
    assert(String(observed.observation).length > 0, '暂停时仍应允许 observe');
    expectOk(await cliJson(['session', 'resume', sessionId]), 'session resume');
    expectOk(await cliJson(['click', '#submit-btn', '--session', sessionId]), 'click after resume');
    return 'paused → 拒绝动作 → 恢复 → 可点击';
  });

  await check('20t. wait-for-element 可被 operation cancel 中止', async () => {
    const waitId = 'e2e-wait-' + Date.now();
    const waiting = cli(['wait-for-element', '#never-exists', '--timeout', '5s', '--operation-id', waitId, '--session', sessionId, '--json']);
    await sleep(500);
    expectOk(await cliJson(['operation', 'cancel', waitId, '--session', sessionId]), 'cancel wait');
    const done = await waiting;
    assert(done.code === 0, '被取消的等待应以 0 退出：' + done.code + ' ' + done.stderr);
    const parsed = JSON.parse(String(done.stdout).trim().split('\n').pop());
    assert(parsed.result && parsed.result.cancelled === true, '等待没有被取消：' + done.stdout);
    return 'cancelled after ' + parsed.result.elapsedMs + 'ms';
  });

  await check('20u. closed shadow：按文本点击/读取（CDP pierce）', async () => {
    const clicked = expectOk(await cliJson(['click', '--closed-shadow-text', '封闭按钮', '--session', sessionId]), 'closed shadow click');
    assert(clicked.via === 'cdp-closed-shadow', '没有走 CDP closed shadow 路径：' + JSON.stringify(clicked));
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('closed-result').textContent", '--session', sessionId]), 'closed result');
    assert(out.value === 'closed-clicked', 'closed shadow 内点击没有生效：' + JSON.stringify(out.value));

    const read = expectOk(await cliJson(['read', '--closed-shadow-text', '封闭按钮', '--session', sessionId]), 'closed shadow read');
    assert(String(read.matched).includes('封闭按钮'), 'closed shadow 读取结果不对：' + JSON.stringify(read));
    return 'click + read 均走 pierce';
  });

  await check('20v. closed shadow 只读并入 observe + 按 ref 点击/读取', async () => {
    const observed = expectOk(await cliJson(['observe', '--closed-shadow', '--session', sessionId]), 'observe closed shadow');
    assert(String(observed.observation).includes('封闭按钮'), 'observe --closed-shadow 没看到封闭按钮');
    assert(Array.isArray(observed.closedShadow) && observed.closedShadow.length >= 1, 'closedShadow 数组为空');
    const entry = observed.closedShadow.find((item) => String(item.text).includes('封闭按钮'));
    assert(entry && /^@e\d+$/.test(entry.ref || ''), 'closed shadow 条目没有 ref：' + JSON.stringify(entry));
    const line = String(observed.observation).split('\n').find((item) => item.includes('封闭按钮'));
    assert(line && line.includes(entry.ref) && line.includes('closed shadow'), 'closed shadow 行没有 ref 标记：' + line);

    const clicked = expectOk(await cliJson(['click', entry.ref, '--session', sessionId]), 'click closed shadow ref');
    assert(clicked.via === 'closed-shadow-ref', '没有走 closed shadow ref 路径：' + JSON.stringify(clicked));
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('closed-result').textContent", '--session', sessionId]), 'closed result');
    assert(out.value === 'closed-clicked', 'closed shadow ref 点击没有生效：' + JSON.stringify(out.value));

    const read = expectOk(await cliJson(['read', '--ref', entry.ref, '--session', sessionId]), 'read closed shadow ref');
    assert(String(read.value).includes('封闭按钮'), 'closed shadow ref 读取结果不对：' + JSON.stringify(read));
    return 'ref=' + entry.ref;
  });

  await check('20w. CDP Fetch 诊断：requestPaused 是否派发', async () => {
    const probe = cli(['debug', 'fetch_probe', '--ms', '3000', '--session', sessionId, '--json']);
    await sleep(600);
    await cliJson(['click', '#ping-btn', '--session', sessionId]);
    const done = await probe;
    const parsed = JSON.parse(String(done.stdout).trim().split('\n').pop());
    assert(parsed && parsed.ok && parsed.result, 'fetch_probe 失败：' + done.stdout + done.stderr);
    assert(parsed.result.paused >= 1, 'CDP Fetch 没有派发 requestPaused（paused=' + parsed.result.paused + ' error=' + parsed.result.error + '）');
    assert((parsed.result.urls || []).some((url) => url.includes('/api/ping')), 'paused 列表里没有 /api/ping：' + JSON.stringify(parsed.result.urls));
    return 'paused=' + parsed.result.paused + ' urls=' + (parsed.result.urls || []).length;
  });

  await check('20x. 子资源 fulfill：用 Fetch 伪造 /api/script', async () => {
    const rule = {
      urlPattern: '*/api/script*',
      action: 'fulfill',
      status: 200,
      headers: { 'content-type': 'application/javascript; charset=utf-8' },
      body: 'window.__mockedScript = true;',
    };
    expectOk(await cliJson(['debug', 'rule_add', '--rule', JSON.stringify(rule), '--session', sessionId]), 'rule fulfill script');
    // 同一文档内注入一个新脚本（不导航，避免 Fetch 在导航后只拦截文档请求）
    expectOk(await cliJson([
      'evaluate',
      "window.__mockedScript = undefined; window.__realScript = undefined; const s = document.createElement('script'); s.src = '/api/script?x=' + Date.now(); document.head.appendChild(s); 'appended'",
      '--session', sessionId,
    ]), 'inject subresource script');
    await sleep(1000);
    const state = expectOk(await cliJson(['evaluate', '({ mocked: !!window.__mockedScript, real: !!window.__realScript })', '--session', sessionId]), 'script state');
    if (!(state.value && state.value.mocked === true)) {
      const listed = await cliJson(['debug', 'rule_list', '--session', sessionId]);
      assert(false, '子资源没有被伪造：' + JSON.stringify(state.value) + ' rules=' + JSON.stringify(listed.json));
    }
    assert(state.value.real !== true, '真实脚本仍然执行了：' + JSON.stringify(state.value));
    expectOk(await cliJson(['debug', 'rule_clear', '--session', sessionId]), 'clear fulfill rule');
    return 'mocked 生效，real 未执行';
  });

  await check('20y. 子资源 modify：把 /api/script 改写到 /api/script-mock', async () => {
    const rule = {
      // 只匹配带查询串的原始脚本，避免改写后的 mock URL 再次命中
      urlPattern: '*/api/script?*',
      action: 'modify',
      url: 'http://127.0.0.1:' + staticPort + '/api/script-mock',
    };
    expectOk(await cliJson(['debug', 'rule_add', '--rule', JSON.stringify(rule), '--session', sessionId]), 'rule modify script');
    expectOk(await cliJson([
      'evaluate',
      "window.__mockedScript = undefined; window.__realScript = undefined; window.__modifiedScript = undefined; const s = document.createElement('script'); s.src = '/api/script?m=' + Date.now(); document.head.appendChild(s); 'appended'",
      '--session', sessionId,
    ]), 'inject script for modify');
    await sleep(1000);
    const state = expectOk(await cliJson(['evaluate', '({ modified: !!window.__modifiedScript, real: !!window.__realScript })', '--session', sessionId]), 'modify state');
    assert(state.value && state.value.modified === true, '子资源 modify 未生效：' + JSON.stringify(state.value));
    assert(state.value.real !== true, '原始脚本仍然执行了：' + JSON.stringify(state.value));
    expectOk(await cliJson(['debug', 'rule_clear', '--session', sessionId]), 'clear modify rule');
    return 'redirect 到 script-mock 生效';
  });

  await check('20z. --trusted 可信点击通过反爬挑战', async () => {
    const antibotUrl = pageUrl.replace(/test\.html.*$/, 'antibot.html');
    expectOk(await cliJson(['navigate', antibotUrl, '--session', sessionId]), 'navigate antibot');
    expectOk(await cliJson(['wait-for-element', '#challenge-btn', '--timeout', '5s', '--session', sessionId]), 'wait antibot button');
    await sleep(300);
    const sessions = expectOk(await cliJson(['session', 'list']), 'session list for focus');
    const current = (sessions.sessions || []).find((item) => item.sessionId === sessionId);
    if (current && Number.isInteger(current.windowId)) {
      // 可信输入依赖窗口前台；显式 focus 属用户命令，避免 headed 浏览器被其它窗口遮挡导致 0 个 mousemove。
      expectOk(await cliJson(['window', 'focus', String(current.windowId), '--session', sessionId]), 'antibot window focus');
      await sleep(400);
    }
    let focusState = null;
    let focusInfo = { visibility: 'unknown', focus: false };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (current) await cliJson(['tab', 'select', String(current.tabId)]);
      await sleep(300);
      focusState = expectOk(await cliJson(['evaluate', 'JSON.stringify({ visibility: document.visibilityState, focus: document.hasFocus() })', '--session', sessionId]), 'antibot focus');
      focusInfo = JSON.parse(focusState.value);
      if (focusInfo.visibility === 'visible') break;
    }
    if (focusInfo.visibility !== 'visible') {
      console.log('  WARN  反爬页当前不可见（focus=' + focusInfo.focus + '），继续由 --trusted 的置前/焦点仿真尝试：' + JSON.stringify(focusInfo));
    }
    const hovered = expectOk(await cliJson(['hover', '#challenge-btn', '--trusted', '--session', sessionId]), 'trusted hover');
    assert(hovered.trusted === true, 'hover 没有走可信输入：' + JSON.stringify(hovered));
    const clicked = expectOk(await cliJson(['click', '#challenge-btn', '--trusted', '--session', sessionId]), 'trusted click');
    assert(clicked.trusted === true, 'click 没有走可信输入：' + JSON.stringify(clicked));
    const state = expectOk(await cliJson(['evaluate', 'JSON.stringify(window.__antibot)', '--session', sessionId]), 'antibot state');
    const parsed = JSON.parse(state.value);
    assert(
      parsed.passed === true && parsed.trusted === true,
      '反爬挑战未通过：' + JSON.stringify(parsed) + ' hover=' + JSON.stringify(hovered) +
        ' click=' + JSON.stringify(clicked) + ' focus=' + String(focusState.value),
    );
    const filled = expectOk(await cliJson(['fill', '#typed', '--value', 'native-typing', '--trusted', '--session', sessionId]), 'trusted fill');
    assert(filled.trusted === true, 'fill 没有走可信输入：' + JSON.stringify(filled));
    const pressed = expectOk(await cliJson(['press', 'Enter', '--trusted', '--session', sessionId]), 'trusted press');
    assert(pressed.trusted === true, 'press 没有走可信输入：' + JSON.stringify(pressed));
    const typing = expectOk(await cliJson(['evaluate', 'JSON.stringify(window.__trustedInput)', '--session', sessionId]), 'trusted input state');
    const typed = JSON.parse(typing.value);
    assert(typed.input >= 1 && typed.keydown >= 1 && typed.value === 'native-typing', '可信输入事件未收到：' + JSON.stringify(typed));

    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'navigate back fixture');
    expectOk(await cliJson(['evaluate', "document.getElementById('drop-out').textContent = 'none'; 'ok'", '--session', sessionId]), 'reset drop');
    const tdrag = expectOk(await cliJson(['drag', '#drag-src', '--to', '#dropzone', '--trusted', '--session', sessionId]), 'trusted drag');
    assert(tdrag.trusted === true, 'drag 没有走可信输入：' + JSON.stringify(tdrag));
    const drop = expectOk(await cliJson(['evaluate', "document.getElementById('drop-out').textContent", '--session', sessionId]), 'trusted drop');
    assert(drop.value === 'dropped', '可信拖拽没有触发 drop：' + JSON.stringify(drop.value));
    return 'passed, trustedMoves=' + parsed.trustedMoves + ' typed=' + typed.value + ' drag=' + drop.value;
  });

  await check('20u2. CDP 性能追踪：trace start/stop 落 Trace JSON', async () => {
    await cliJson(['session', 'resume', sessionId]).catch(() => {});
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'trace navigate');
    const started = expectOk(await cliJson(['trace', 'start', '--session', sessionId]), 'trace start');
    assert(Number.isInteger(started.tabId), 'trace.start 没有 tabId');
    await cliJson(['evaluate', "window.scrollBy(0, 20); document.body.style.outline='1px solid #ddd'; 'ok'", '--session', sessionId]);
    await sleep(400);
    const tracePath = path.join(outDir, 'perf-trace.json');
    const stopped = expectOk(await cliJson(['trace', 'stop', '--out', tracePath, '--session', sessionId]), 'trace stop');
    assert(Number(stopped.events) > 0, 'trace 没有采集到事件：' + JSON.stringify(stopped.summary));
    assert(stopped.summary && stopped.summary.events === stopped.events, 'trace summary 不一致');
    const parsed = JSON.parse(readFileSync(tracePath, 'utf8'));
    assert(Array.isArray(parsed.traceEvents) && parsed.traceEvents.length > 0, 'trace 文件没有 traceEvents');
    const traceSummary = expectOk(await cliJson(['trace', 'summary', tracePath, '--session', sessionId]), 'trace summary');
    assert(traceSummary.events > 0 && Array.isArray(traceSummary.topNames), 'trace summary 不完整：' + JSON.stringify(traceSummary).slice(0, 200));
    const traceDiff = expectOk(await cliJson(['trace', 'diff', tracePath, tracePath, '--session', sessionId]), 'trace diff');
    assert(traceDiff.events && traceDiff.events.delta === 0 && Array.isArray(traceDiff.topChanges), 'trace diff 不完整');
    const status = expectOk(await cliJson(['trace', 'status', '--session', sessionId]), 'trace status');
    assert(status.tracing === false, 'trace.stop 后仍在 tracing');
    return 'events=' + stopped.events + ' span=' + (stopped.summary.spanMs || 0) + 'ms';
  });

  await check('20v2. PDF 导出：Page.printToPDF 落盘', async () => {
    await cliJson(['session', 'resume', sessionId]).catch(() => {});
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'pdf navigate');
    const pdfPath = path.join(outDir, 'fixture.pdf');
    const result = expectOk(await cliJson(['pdf', '--out', pdfPath, '--pages', '1', '--margins', '0.5,0.5,0.5,0.5', '--scale', '1', '--session', sessionId]), 'pdf export');
    assert(result.bytes > 1000, 'PDF 太小：' + JSON.stringify(result));
    const pdf = readFileSync(pdfPath);
    assert(pdf.subarray(0, 5).toString('ascii') === '%PDF-', 'PDF 头不对：' + pdf.subarray(0, 8).toString('hex'));
    return 'pdf=' + pdf.length + 'B';
  });

  await check('21. emulate 视口覆盖与重置', async () => {
    expectOk(await cliJson(['emulate', '--width', '800', '--height', '600', '--session', sessionId]), 'emulate');
    await sleep(300);
    const width = expectOk(await cliJson(['evaluate', 'window.innerWidth', '--session', sessionId]), 'evaluate innerWidth');
    assert(width.value === 800, 'innerWidth 应为 800，实际 ' + JSON.stringify(width.value));
    const reset = expectOk(await cliJson(['emulate', '--reset', '--session', sessionId]), 'emulate reset');
    if (typeof reset.innerWidthAfter === 'number' && reset.innerWidthAfter !== 800) {
      return '800 → ' + reset.innerWidthAfter + '（扩展内校验）';
    }
    let back = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep(400);
      back = expectOk(await cliJson(['evaluate', 'window.innerWidth', '--session', sessionId]), 'evaluate innerWidth reset');
      if (back.value !== 800) break;
    }
    assert(back && back.value !== 800, '重置后 innerWidth 仍是 800；reset=' + JSON.stringify(reset));
    return '800 → ' + back.value;
  });

  await check('22. plan 一次下发多步', async () => {
    // 20z 若失败会停在 antibot 页；这里显式回到夹具页，避免后续检查连锁误报。
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'navigate fixture before plan');
    const steps = JSON.stringify([
      { method: 'fill', params: { selector: '#kw', value: 'plan' } },
      { method: 'click', params: { selector: '#submit-btn' } },
    ]);
    const res = expectOk(await cliJson(['plan', '--steps', steps, '--until-visible', '#out', '--wait-timeout-ms', '3000', '--save-full', path.join(outDir, 'plan-full.txt'), '--session', sessionId]), 'plan');
    assert(res.completed === 2, 'plan 完成步数不对：' + res.completed);
    assert(res.savedTo && existsSync(res.savedTo), 'plan --save-full 未落盘：' + JSON.stringify(res.savedTo));
    assert(res.untilVisible && res.untilVisible.selector === '#out' && res.untilVisible.satisfied === true, 'plan --until-visible 未生效：' + JSON.stringify(res.untilVisible));
    const html = expectOk(await cliJson(['get-html', '--selector', '#out', '--session', sessionId]), 'get-html');
    assert((html.html || '').includes('clicked:plan'), '#out 不是 clicked:plan：' + html.html);
    return 'completed=2 until-visible=#out';
  });

  await check('22b. step 单步动作 + until-visible 就绪', async () => {
    const res = expectOk(await cliJson([
      'step', 'focus', '--selector', '#kw',
      '--until-visible', '#out', '--wait-timeout-ms', '3000',
      '--session', sessionId,
    ]), 'step');
    assert(res.action && res.action.ok === true, 'step 动作失败：' + JSON.stringify(res.action));
    assert(res.untilVisible && res.untilVisible.selector === '#out' && res.untilVisible.satisfied === true, 'step --until-visible 未生效：' + JSON.stringify(res.untilVisible));
    return 'step focus + until-visible';
  });

  await check('23. observe --save-full + view --grep', async () => {
    const saved = path.join(outDir, 'observation.txt');
    expectOk(await cliJson(['observe', '--save-full', saved, '--session', sessionId]), 'observe save-full');
    assert(existsSync(saved), '观察文件没落盘');
    const view = expectOk(await cliJson(['view', '--grep', '人员表', '--session', sessionId]), 'view');
    assert((view.lines || []).length > 0, 'view 没命中：' + JSON.stringify(view).slice(0, 300));
    return 'lines=' + view.lines.length + ' matched=' + view.matched;
  });

  await check('23b. wait-for-element 超时返回 satisfied=false 且退出码 0', async () => {
    const r = await cliJson(['wait-for-element', '#never-exists', '--state', 'visible', '--timeout', '400ms', '--session', sessionId]);
    assert(r.code === 0, '超时不应是错误退出码：' + r.code + ' ' + r.stderr);
    const result = expectOk(r, 'wait-for-element');
    assert(result.satisfied === false, 'satisfied 应为 false：' + JSON.stringify(result));
    assert(result.timedOut === true, '缺少 timedOut 标记');
    const ok = await cliJson(['wait-for-element', '#people', '--state', 'visible', '--timeout', '2s', '--session', sessionId]);
    assert(expectOk(ok, 'wait-for-element ok').satisfied === true, '已存在元素应 satisfied');
    return '超时 satisfied=false，退出码 0';
  });

  await check('23c. fill --no-clear 追加 + read --fields-json', async () => {
    expectOk(await cliJson(['fill', '#kw', '--value', 'AB', '--session', sessionId]), 'fill reset');
    expectOk(await cliJson(['fill', '#kw', '--value', 'CD', '--no-clear', '--session', sessionId]), 'fill append');
    const read = expectOk(await cliJson(['read', '--selector', '#kw', '--fields-json', '[{"key":"v","read":"value"},{"key":"n","read":"attribute","attribute":"name"}]', '--session', sessionId]), 'read fields');
    assert(read.fields[0].v === 'ABCD', 'no-clear 未追加：' + JSON.stringify(read.fields));
    assert(read.fields[0].n === 'kw', 'attribute 读取不对：' + JSON.stringify(read.fields));
    return 'value=ABCD name=kw';
  });

  await check('23d. screenshot --selector 元素截图', async () => {
    const shot = path.join(outDir, 'element.png');
    expectOk(await cliJson(['screenshot', '--selector', '#people', '--out', shot, '--session', sessionId]), 'screenshot element');
    const buf = readFileSync(shot);
    assert(buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', '元素截图不是 PNG');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert(width > 80 && width < 1000, '元素截图宽度不对：' + width);
    assert(height > 40 && height < 700, '元素截图高度不对：' + height);
    return width + 'x' + height;
  });

  await check('23d2. screenshot --region 像素区域', async () => {
    const region = expectOk(await cliJson(['screenshot', '--region', '10,10,100,50', '--out', path.join(outDir, 'region.png'), '--session', sessionId]), 'screenshot region');
    assert(region.width === 100 && region.height === 50, '区域截图尺寸不对：' + JSON.stringify({ width: region.width, height: region.height }));
    return region.width + 'x' + region.height;
  });

  await check('23e. extract discover + table --target', async () => {
    const discovered = expectOk(await cliJson(['extract', 'discover', '--session', sessionId]), 'extract discover');
    const targets = discovered.targets || [];
    assert(targets.length >= 2, 'discover 目标太少：' + JSON.stringify(targets));
    const table = targets.find((item) => item.kind === 'table');
    assert(table, '没有发现表格目标');
    const exported = expectOk(await cliJson(['extract', 'table', '--target', String(table.id), '--session', sessionId]), 'extract table');
    assert(exported.rowCount === 3, '表格行数不对：' + exported.rowCount);
    assert(exported.columns[0].label === '姓名', '列名不对');
    return 'targets=' + targets.length + ' rows=' + exported.rowCount;
  });

  await check('23e6. extract 完整性元数据（truncated/complete）', async () => {
    const limited = expectOk(await cliJson(['extract', 'table', '--selector', '#people', '--max-rows', '1', '--session', sessionId]), 'extract completeness');
    assert(limited.complete === false && limited.truncated === true, '截断标记不完整：' + JSON.stringify({ complete: limited.complete, truncated: limited.truncated }));
    assert(limited.totalRows >= 3 && limited.rowCount === 1, '行数元数据不对：' + JSON.stringify({ totalRows: limited.totalRows, rowCount: limited.rowCount }));
    return 'totalRows=' + limited.totalRows + ' complete=false';
  });

  await check('23e2. extract 识别 ARIA grid（role=grid / ag-grid）', async () => {
    const disc = expectOk(await cliJson(['extract', 'discover', '--session', sessionId]), 'discover grid');
    const grid = (disc.targets || []).find((item) => item.kind === 'table' && item.columns >= 2 && /示例网格|demo-grid|grid/i.test(String(item.label || '')));
    assert(grid, 'discover 没找到 ARIA grid：' + JSON.stringify(disc.targets));
    const table = expectOk(await cliJson(['extract', 'table', '--target', String(grid.id), '--session', sessionId]), 'extract grid');
    assert((table.columns || []).length >= 2, 'grid 列太少：' + JSON.stringify(table.columns));
    assert(table.rows && table.rows.length >= 2, 'grid 行太少：' + JSON.stringify(table.rows));
    const first = table.rows[0];
    assert(Object.values(first).includes('张三') && Object.values(first).includes('北京'), 'grid 第一行数据不对：' + JSON.stringify(first));
    return 'grid rows=' + table.rows.length + ' cols=' + table.columns.length;
  });

  await check('23e3. observe 输出 ARIA grid 行级 ref', async () => {
    const observed = expectOk(await cliJson(['observe', '--session', sessionId]), 'observe grid rows');
    const lines = String(observed.observation).split('\n');
    const gridLine = lines.find((line) => line.includes('grid') && line.includes('姓名'));
    assert(gridLine, 'observe 没有 grid 节点：' + JSON.stringify(lines.filter((l) => l.includes('grid')).slice(0, 3)));
    const rowLine = lines.find((line) => line.includes('张三') && /@e\d+/.test(line));
    assert(rowLine, 'observe 没有带 ref 的 grid 行：' + JSON.stringify(lines.filter((l) => l.includes('张三'))));
    const ref = (rowLine.match(/@e\d+/) || [])[0];
    const read = expectOk(await cliJson(['read', '--ref', ref, '--session', sessionId]), 'read grid row');
    const value = read.value !== undefined ? read.value : (read.fields && read.fields[0] ? read.fields[0].value : '');
    assert(String(value).includes('张三'), 'grid 行 ref 读取不对：' + JSON.stringify(read));
    return 'rowRef=' + ref;
  });

  await check('23e4. observe 覆盖 ARIA 树/菜单等语义角色', async () => {
    const observed = expectOk(await cliJson(['observe', '--session', sessionId]), 'observe tree');
    const lines = String(observed.observation).split('\n');
    const treeLine = lines.find((line) => /tree "示例树"/.test(line));
    assert(treeLine, 'observe 没有 tree 节点：' + JSON.stringify(lines.filter((l) => /tree/i.test(l)).slice(0, 3)));
    const itemLine = lines.find((line) => /treeitem "节点 A"/.test(line) && /@e\d+/.test(line));
    assert(itemLine, 'observe 没有带 ref 的 treeitem：' + JSON.stringify(lines.filter((l) => l.includes('节点 A'))));
    return 'tree + treeitem ref ok';
  });

  await check('23e5. 多行表头/rowspan 提取 + 链接 target', async () => {
    const disc = expectOk(await cliJson(['extract', 'discover', '--session', sessionId]), 'discover multi-head');
    const target = (disc.targets || []).find((item) => item.kind === 'table' && String(item.label || '').includes('multi-head'));
    assert(target, 'discover 没找到 multi-head：' + JSON.stringify(disc.targets));
    assert(target.columns === 3, 'multi-head 列数应为 3，实际 ' + target.columns);
    const table = expectOk(await cliJson(['extract', 'table', '--target', String(target.id), '--session', sessionId]), 'extract multi-head');
    const labels = table.columns.map((c) => c.label).join('|');
    assert(labels === '等级|金额 / 小|金额 / 大', '表头合并错误：' + labels);
    assert(table.rows.length === 2, '行数不对：' + table.rows.length);
    assert(table.rows[0].c1 === 'A' && table.rows[0].c2 === '1' && table.rows[0].c3 === '2', '首行错位：' + JSON.stringify(table.rows[0]));
    assert(table.rows[1].c1 === 'A' && table.rows[1].c2 === '3' && table.rows[1].c3 === '4', 'rowspan 行错位：' + JSON.stringify(table.rows[1]));
    const observed = expectOk(await cliJson(['observe', '--session', sessionId]), 'observe href');
    assert(String(observed.observation).includes('→ example.com/x'), '链接没有输出目标 URL');
    const rowLine = String(observed.observation).split('\n').find((line) => /- row /.test(line) && line.includes('A12') && /@e\d+/.test(line));
    assert(rowLine, '表格没有行级 ref：' + JSON.stringify(String(observed.observation).split('\n').filter((l) => /- row /.test(l)).slice(0, 3)));
    const rowRef = (rowLine.match(/@e\d+/) || [])[0];
    const rowRead = expectOk(await cliJson(['read', '--ref', rowRef, '--session', sessionId]), 'read table row');
    const rowValue = rowRead.fields && rowRead.fields[0] ? rowRead.fields[0].value : rowRead.value;
    assert(String(rowValue).includes('A12'), '行 ref 读取不对：' + JSON.stringify(rowRead));
    return 'cols=3 rows=2 href+rowref ok';
  });

  await check('23f. drag --dx/--dy 位移拖拽', async () => {
    const result = expectOk(await cliJson(['drag', '#drag-src', '--dx', '40', '--dy', '30', '--hold', '100ms', '--duration', '200ms', '--session', sessionId]), 'drag dx');
    assert(result.ok === true, 'drag 失败');
    return '位移拖拽 ok';
  });

  await check('23g. download 默认拒绝覆盖 + --overwrite', async () => {
    const target = path.join(outDir, 'download.txt');
    writeFileSync(target, 'existing', 'utf8');
    const refused = await cliJson(['download', '#dl', '--out', target, '--session', sessionId]);
    assert(refused.code === 1 && refused.json && refused.json.error.code === 'E_EXISTS', '应拒绝覆盖：' + JSON.stringify(refused.json));
    const forced = await cliJson(['download', '#dl', '--out', target, '--overwrite', '--session', sessionId]);
    const result = expectOk(forced, 'download overwrite');
    assert(readFileSync(target, 'utf8').includes('browser-bridge download sample'), '覆盖后内容不对');
    assert(typeof result.browserPath === 'string' && result.browserPath, 'JSON 里缺少 browserPath');
    assert(typeof result.transferBytes === 'number' && result.transferBytes > 0, '下载没有走 transfer staging：' + JSON.stringify(result));
    assert(result.transferReleased === true, '下载 staging 没有在 CLI 提交后释放：' + JSON.stringify(result));
    assert(result.effectState === 'committed' && result.cleanupState === 'ok', '下载事务字段不对：' + JSON.stringify(result));
    const mcpPath = path.join(outDir, 'mcp-download.txt');
    const mcp = startMcp({ ...process.env, BB_HOME: bbHome, BB_PORT: String(port), BB_NO_PROBE: '1' });
    try {
      await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e' } });
      const mcpDownload = await mcp.rpc('tools/call', { name: 'browser_download', arguments: { target: '#dl', out: mcpPath, session: sessionId } });
      assert(mcpDownload.result.isError === false, 'MCP download 失败：' + String(mcpDownload.result.content[0].text).slice(0, 160));
      assert(existsSync(mcpPath) && readFileSync(mcpPath, 'utf8').includes('browser-bridge download sample'), 'MCP 下载文件不对');
    } finally {
      mcp.close();
    }
    return '拒绝覆盖 → --overwrite 成功（' + result.bytes + ' 字节，transfer=' + result.transferBytes + '）';
  });

  await check('23g2. download 无结果 → effect_state=unknown', async () => {
    const missed = await cliJson(['download', '#noop', '--timeout', '1500', '--session', sessionId]);
    assert(missed.code === 1 && missed.json && missed.json.error.code === 'E_NO_DOWNLOAD', '无下载应报 E_NO_DOWNLOAD：' + JSON.stringify(missed.json));
    const data = missed.json.error.data || {};
    assert(data.effect_state === 'unknown' && data.dispatched === true, '无下载应标 unknown/dispatched：' + JSON.stringify(data));
    return 'no-download → unknown';
  });

  await check('23h. cooperate sync + --context 授权动作', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'sync navigate');
    const sync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'cooperate sync');
    assert(sync.cooperation && sync.cooperation.frameState && Number.isInteger(sync.cooperation.frameState.revision), 'cooperate sync 缺少 frameState：' + JSON.stringify(sync.cooperation && sync.cooperation.frameState));
    assert(Array.isArray(sync.cooperation.frames) && sync.cooperation.frames.length >= 1, 'cooperate sync 缺少按帧快照：' + JSON.stringify(sync.cooperation && sync.cooperation.frames));
    assert(sync.cooperation.aggregateFrameState && Number.isInteger(sync.cooperation.aggregateFrameState.revision), 'cooperate sync 缺少聚合 frameState');
    assert(Array.isArray(sync.cooperation.frameGaps), 'cooperate sync 缺少 frameGaps');
    assert(sync.authority && sync.authority.generation >= 1 && Number.isInteger(sync.authority.revision), 'cooperate sync 缺少 authority：' + JSON.stringify(sync.authority));
    assert(sync.authority.four && ['tab', 'control', 'observation', 'action'].every((key) => sync.authority.four[key]), '缺少四类权威：' + JSON.stringify(sync.authority.four));
    assert(Number.isInteger(sync.authority.controlRevision) && Number.isInteger(sync.authority.authorityRevision), 'authority 独立计数缺失：' + JSON.stringify(sync.authority));
    assert(Number(sync.authority.epoch) >= 1 && Number(sync.authority.frameEpoch) >= 1, 'authority epoch/frameEpoch 未推进：' + JSON.stringify(sync.authority));
    assert(sync.authority.four.control.controlRevision === sync.authority.controlRevision, 'four.control 计数不一致');
    assert(sync.authority.four.observation.epoch === sync.authority.epoch && sync.authority.four.action.authorityRevision === sync.authority.authorityRevision, 'four 计数与顶层不一致');
    assert(sync.control_policy === 'target', 'control_policy 不对：' + JSON.stringify(sync.control_policy));
    assert(typeof sync.context_id === 'string' && sync.context_id, '缺少 context_id');
    assert(typeof sync.observation_id === 'string' && sync.observation_id, '缺少 observation_id');
    assert(sync.observation && String(sync.observation.text).includes('E2E 夹具页'), 'sync 没返回观察文本');
    expectOk(await cliJson(['click', '#submit-btn', '--context', sync.context_id, '--session', sessionId]), 'click with context');
    return 'context=' + sync.context_id.slice(0, 8) + '… policy=' + sync.control_policy;
  });

  await check('23h2. cooperation frameState 计数器：DOM/滚动推进 revision', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'coop counters session list');
    const current = (listed.sessions || []).find((item) => item.sessionId === sessionId);
    if (current && Number.isInteger(current.windowId)) {
      // 归因/滚动依赖窗口前台；显式 focus 属于用户命令，不违反默认不抢焦点。
      expectOk(await cliJson(['window', 'focus', String(current.windowId), '--session', sessionId]), 'coop counters focus');
    }
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'coop counters navigate');
    const first = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'coop counters sync1');
    const before = first.cooperation && first.cooperation.frameState;
    assert(before && Number.isInteger(before.revision), 'sync1 缺少 frameState：' + JSON.stringify(before));
    expectOk(await cliJson(['evaluate', "const tall=document.createElement('div'); tall.id='__coop_tall'; tall.style.height='3000px'; document.body.appendChild(tall); document.body.appendChild(document.createElement('div')).id='__coop_probe'; const outNode=document.getElementById('out'); if (outNode && outNode.firstChild) outNode.firstChild.data='coop-text'; window.scrollTo(0, 320); 'ok'", '--session', sessionId]), 'coop counters mutate');
    const scrolled = expectOk(await cliJson(['evaluate', 'window.scrollY', '--session', sessionId]), 'coop counters scrollY');
    assert(Number(scrolled.value) > 0, '夹具页没有滚动起来：' + JSON.stringify(scrolled.value));
    await sleep(350);
    const second = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'coop counters sync2');
    const after = second.cooperation && second.cooperation.frameState;
    assert(after, 'sync2 缺少 frameState');
    assert(Number(after.revision) > Number(before.revision), 'frameState.revision 没有推进：' + before.revision + ' → ' + after.revision);
    assert(Number(after.mutations) > Number(before.mutations), 'mutations 没有推进：' + before.mutations + ' → ' + after.mutations);
    assert(Number(after.structure) >= 1, 'structure 没有推进：' + JSON.stringify({ structure: after.structure }));
    assert(Array.isArray(after.texts) && after.texts.length >= 1, 'texts 没有记录文本变更：' + JSON.stringify({ texts: after.texts }));
    assert(typeof after.document === 'string' && after.document.includes('test.html') && Array.isArray(after.events), 'document/events 元数据缺失：' + JSON.stringify({ document: after.document, events: after.events }));
    assert(typeof after.focusNeutral === 'boolean', 'focusNeutral 缺失：' + JSON.stringify(after.focusNeutral));
    assert(typeof after.selection === 'string', 'selection 缺失：' + JSON.stringify(after.selection));
    assert(Array.isArray(after.media), 'media 缺失：' + JSON.stringify(after.media));
    assert(typeof after.mediaComplete === 'boolean', 'mediaComplete 缺失：' + JSON.stringify(after.mediaComplete));
    assert(typeof after.textsComplete === 'boolean', 'textsComplete 缺失：' + JSON.stringify(after.textsComplete));
    assert(typeof after.eventsComplete === 'boolean', 'eventsComplete 缺失：' + JSON.stringify(after.eventsComplete));
    assert(after.fieldsComplete === true && typeof after.focusIsDocument === 'boolean', 'frameState 缺少 focus/fields 元数据：' + JSON.stringify({ fieldsComplete: after.fieldsComplete, focusIsDocument: after.focusIsDocument }));
    assert(Number(after.scroll) > Number(before.scroll), 'scroll 没有推进：' + before.scroll + ' → ' + after.scroll);
    return 'revision ' + before.revision + '→' + after.revision + ' mutations=' + after.mutations + ' scroll=' + after.scroll;
  });

  await check('23h3. 归因时钟：Agent 点击计入 agentAttributed', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'attribution session list');
    const current = (listed.sessions || []).find((item) => item.sessionId === sessionId);
    // 可信输入依赖窗口前台；headed 浏览器可能被其它窗口遮挡，重试并显式 focus（用户命令）。
    let frame = null;
    let sync = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (current && Number.isInteger(current.windowId)) {
        expectOk(await cliJson(['window', 'focus', String(current.windowId), '--session', sessionId]), 'attribution focus');
      }
      if (current && Number.isInteger(current.tabId)) {
        expectOk(await cliJson(['tab', 'select', String(current.tabId)]), 'attribution tab select');
      }
      await sleep(300);
      expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'attribution navigate');
      await sleep(250);
      expectOk(await cliJson(['click', '#submit-btn', '--trusted', '--session', sessionId]), 'attribution click');
      await sleep(250);
      sync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'attribution sync');
      frame = sync.cooperation && sync.cooperation.frameState;
      if (frame && Number(frame.agentAttributed) >= 1) break;
    }
    assert(frame, '归因 sync 缺少 frameState');
    assert(Number(frame.agentAttributed) >= 1, 'Agent 点击没有计入 agentAttributed：' + JSON.stringify(frame));
    assert(frame.expectationPending === false, 'expectation 未消费：' + JSON.stringify(frame));
    // 环境里的真实 focus 事件可能被记为 human；只要最后不是 pointer，就说明点击没有被误记。
    assert(frame.lastHumanKind !== 'pointer', 'Agent 点击被误记为 human：' + JSON.stringify(frame));
    assert(Number(frame.inputClock) >= 1, '输入时钟没有推进：' + JSON.stringify(frame));
    assert(frame.timeToleranceMs === 1.5, '归因时间戳容差不是 1.5ms：' + JSON.stringify(frame.timeToleranceMs));
    assert(Number.isInteger(Number(frame.agentAttributedByTimestamp)) && Number.isInteger(Number(frame.agentAttributedByCoordinate)), '归因分项计数缺失：' + JSON.stringify(frame));
    assert(frame.attribution && typeof frame.attribution.owner === 'string', '缺少最近归因结果：' + JSON.stringify(frame.attribution));
    assert(Number(frame.agentAttributedByTimestamp) + Number(frame.agentAttributedByCoordinate) <= Number(frame.agentAttributed), '归因分项计数超过总数：' + JSON.stringify(frame));
    const control = sync.cooperation && sync.cooperation.control;
    assert(control && control.inputLocked === false && control.humanActive === false, 'control authority 状态不对：' + JSON.stringify(control));
    assert(sync.held === false, '未接管时 held 应为 false：' + JSON.stringify(sync.held));
    return 'agent=' + frame.agentAttributed + ' human=' + frame.humanAttributed;
  });

  await check('23h4. 归因时钟：Agent 按键计入 agentAttributed', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'attribution key session list');
    const current = (listed.sessions || []).find((item) => item.sessionId === sessionId);
    if (current && Number.isInteger(current.windowId)) {
      expectOk(await cliJson(['window', 'focus', String(current.windowId), '--session', sessionId]), 'attribution key focus');
    }
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'attribution key navigate');
    const observed = expectOk(await cliJson(['observe', '--force', '--session', sessionId]), 'attribution key observe');
    const kwMatch = /textbox "搜索关键词" \[@(e\d+)\]/.exec(String(observed.observation || ''));
    assert(kwMatch, '归因按键测试找不到关键词输入框 ref');
    const kwRef = '@' + kwMatch[1];
    // 先 fill（建立 recentFillFocus），再 press --trusted --ref：trustedPress 会跳过 pointer 点击，
    // 只派发 keydown，避免焦点事件触发人工接管判定。
    expectOk(await cliJson(['fill', kwRef, '--value', 'key-attr', '--session', sessionId]), 'attribution key fill');
    expectOk(await cliJson(['press', 'Tab', '--trusted', '--ref', kwRef, '--session', sessionId]), 'attribution press');
    await sleep(200);
    const sync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'attribution key sync');
    const frame = sync.cooperation && sync.cooperation.frameState;
    assert(frame, '按键归因 sync 缺少 frameState');
    assert(Number(frame.agentAttributed) >= 1, 'Agent 按键没有计入 agentAttributed：' + JSON.stringify(frame));
    // 同 23h3：真实 focus 事件可能被记为 human；只要最后不是 keydown，就说明按键没有被误记。
    assert(frame.lastHumanKind !== 'keydown', 'Agent 按键被误记为 human：' + JSON.stringify(frame));
    assert(Number(frame.inputClock) >= 1, '按键没有推进输入时钟：' + JSON.stringify(frame));
    assert(frame.timeToleranceMs === 1.5, '按键归因时间戳容差不是 1.5ms：' + JSON.stringify(frame));
    assert(Number.isInteger(Number(frame.agentAttributedByTimestamp)) && Number.isInteger(Number(frame.agentAttributedByCoordinate)), '按键归因分项计数缺失：' + JSON.stringify(frame));
    return 'agent=' + frame.agentAttributed + ' human=' + frame.humanAttributed;
  });

  await check('23h6. cooperate hold：held 时拒绝 Agent 动作，release 后恢复', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'hold navigate');
    expectOk(await cliJson(['cooperate', 'hold', '--session', sessionId]), 'hold on');
    try {
      const heldSync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'hold sync');
      assert(heldSync.held === true, 'hold 后 sync.held 应为 true：' + JSON.stringify(heldSync.held));
      const blocked = await cliJson(['click', '#submit-btn', '--session', sessionId]);
      assert(blocked.code === 1 && blocked.json && blocked.json.error.code === 'E_SESSION_PAUSED', 'held 时点击应被拒绝：' + JSON.stringify(blocked.json));
    } finally {
      expectOk(await cliJson(['cooperate', 'hold', '--release', '--session', sessionId]), 'hold release');
    }
    const released = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'hold release sync');
    assert(released.held === false, 'release 后 held 应为 false：' + JSON.stringify(released.held));
    expectOk(await cliJson(['click', '#submit-btn', '--session', sessionId]), 'hold release click');
    return 'held→E_SESSION_PAUSED→release';
  });

  await check('23j3. 观察代际：DOM 变化后旧 observation 被拒绝', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'revision navigate');
    const sync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'revision sync');
    expectOk(await cliJson(['evaluate', "document.getElementById('out').textContent='changed-after-sync';'ok'", '--session', sessionId]), 'revision mutate');
    const stale = await cliJson(['click', '#submit-btn', '--observation', sync.observation_id, '--session', sessionId]);
    assert(stale.code === 1 && stale.json && stale.json.error.code === 'E_OBSERVATION_STALE', '旧 observation 应失效：' + JSON.stringify(stale.json));
    assert(stale.json.error.data && stale.json.error.data.observed_changes, '缺少 observed_changes：' + JSON.stringify(stale.json.error));
    const fresh = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'revision fresh sync');
    expectOk(await cliJson(['click', '#submit-btn', '--observation', fresh.observation_id, '--session', sessionId]), 'revision fresh click');
    return 'E_OBSERVATION_STALE → fresh';
  });

  await check('23j4. 节点级动态读取校验（--node-scope / target_detached）', async () => {
    const buttonRefOf = (payload) => {
      const match = /button "提交查询" \[@(e\d+)\]/.exec(String((payload && payload.observation && payload.observation.text) || ''));
      return match ? '@' + match[1] : '';
    };
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'node-scope navigate');
    const sync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'node-scope sync');
    assert(sync.node_scope && sync.node_scope.count > 0, 'cooperate sync 未记录节点签名：' + JSON.stringify(sync.node_scope));
    const buttonRef = buttonRefOf(sync);
    assert(buttonRef, '同步观察里找不到提交按钮 ref');
    // 1) 无关节点变化：--node-scope 只校验目标节点 → 动作放行
    expectOk(await cliJson(['evaluate', "document.getElementById('out').textContent='unrelated';'ok'", '--session', sessionId]), 'node-scope unrelated mutate');
    const allowed = expectOk(await cliJson(['click', buttonRef, '--observation', sync.observation_id, '--node-scope', '--session', sessionId]), 'node-scope click unrelated');
    assert(allowed.ok !== false, '无关变化不应拦动作：' + JSON.stringify(allowed));
    // 2) 目标节点自身文本变化 → E_OBSERVATION_CHANGED（节点级 observed_changes）
    const fresh = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'node-scope sync fresh');
    const freshRef = buttonRefOf(fresh);
    assert(freshRef, '新同步里找不到提交按钮 ref');
    expectOk(await cliJson(['evaluate', "document.getElementById('submit-btn').textContent='已被改名';'ok'", '--session', sessionId]), 'node-scope target mutate');
    const changed = await cliJson(['click', freshRef, '--observation', fresh.observation_id, '--node-scope', '--session', sessionId]);
    assert(changed.code === 1 && changed.json && changed.json.error.code === 'E_OBSERVATION_CHANGED', '目标节点变化应拒绝：' + JSON.stringify(changed.json));
    const observed = changed.json.error.data && changed.json.error.data.observed_changes;
    assert(observed && observed.scope === 'node' && (observed.kinds || []).includes('text'), '缺少节点级 text 证据：' + JSON.stringify(observed));
    // 3) 目标节点被移除 → E_TARGET_DETACHED
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'node-scope detach restore');
    const detachSync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'node-scope sync detach');
    const detachRef = buttonRefOf(detachSync);
    assert(detachRef, '脱离测试找不到提交按钮 ref');
    expectOk(await cliJson(['evaluate', "const b=document.getElementById('submit-btn'); b.replaceWith(document.createElement('i')); 'ok'", '--session', sessionId]), 'node-scope detach');
    const detached = await cliJson(['click', detachRef, '--observation', detachSync.observation_id, '--node-scope', '--session', sessionId]);
    assert(detached.code === 1 && detached.json && detached.json.error.code === 'E_TARGET_DETACHED', '节点移除应 E_TARGET_DETACHED：' + JSON.stringify(detached.json));
    // 4) 读取类同样支持：目标没变时，页面别处变化不拦 read
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'node-scope read restore');
    const readSync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'node-scope sync read');
    const kwMatch = /textbox "搜索关键词" \[@(e\d+)\]/.exec(String((readSync.observation && readSync.observation.text) || ''));
    assert(kwMatch, '同步观察里找不到关键词输入框 ref');
    expectOk(await cliJson(['evaluate', "document.getElementById('out').textContent='read-scope';'ok'", '--session', sessionId]), 'node-scope read mutate');
    const readOk = expectOk(await cliJson(['read', '@' + kwMatch[1], '--observation', readSync.observation_id, '--node-scope', '--session', sessionId]), 'node-scope read');
    assert(Array.isArray(readOk.fields) && readOk.fields.length >= 1, 'node-scope read 结果不对：' + JSON.stringify(readOk));
    // 5) 兼容：未开 --node-scope 仍是整页 stale
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'node-scope compat restore');
    const compat = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'node-scope compat sync');
    expectOk(await cliJson(['evaluate', "document.getElementById('out').textContent='compat';'ok'", '--session', sessionId]), 'node-scope compat mutate');
    const pageStale = await cliJson(['click', '#submit-btn', '--observation', compat.observation_id, '--session', sessionId]);
    assert(pageStale.code === 1 && pageStale.json && pageStale.json.error.code === 'E_OBSERVATION_STALE', '未开 node-scope 应仍整页 stale：' + JSON.stringify(pageStale.json));
    return 'unrelated 放行 → text E_OBSERVATION_CHANGED → E_TARGET_DETACHED → read 放行 → 兼容 stale';
  });

  await check('23h5. 拟人输入：--human 产生多段鼠标轨迹', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'human navigate');
    expectOk(await cliJson(['evaluate', "window.__bbMoves=0; addEventListener('mousemove',()=>window.__bbMoves++); 'ok'", '--session', sessionId]), 'human hook');
    const clicked = expectOk(await cliJson(['click', '#submit-btn', '--human', '--trusted', '--session', sessionId]), 'human click');
    assert(clicked.effectState === 'committed', '拟人点击未提交：' + JSON.stringify(clicked));
    const moves = expectOk(await cliJson(['evaluate', 'window.__bbMoves', '--session', sessionId]), 'human moves');
    assert(Number(moves.value) >= 3, '拟人点击没有多段轨迹：' + JSON.stringify(moves.value));
    return 'moves=' + moves.value;
  });

  await check('23i. --expect 事实校验（失败带 actual，成功后动作执行）', async () => {
    const bad = await cliJson(['click', '#submit-btn', '--expect', '[{"target":"#out","field":"text","equals":"__never__"}]', '--session', sessionId]);
    assert(bad.code === 1, 'expect 失败应是退出码 1，实际 ' + bad.code);
    assert(bad.json && bad.json.error && bad.json.error.code === 'E_EXPECT_FAILED', '错误码不对：' + JSON.stringify(bad.json));
    assert(/__never__/.test(bad.json.error.message), '错误信息里没有期望值');
    const good = expectOk(await cliJson(['click', '#submit-btn', '--expect', '[{"target":"#out","field":"exists","equals":true}]', '--session', sessionId]), 'click expect ok');
    assert(good.ok === true, 'expect 通过后动作应成功');
    return 'E_EXPECT_FAILED → 通过';
  });

  await check('23j. 导航后旧 context 失效', async () => {
    const sync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'sync before nav');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'navigate');
    const stale = await cliJson(['click', '#submit-btn', '--context', sync.context_id, '--session', sessionId]);
    assert(stale.code === 1 && stale.json && stale.json.error.code === 'E_CONTEXT_STALE', '旧 context 应失效：' + JSON.stringify(stale.json));
    return 'E_CONTEXT_STALE';
  });

  await check('23j2. cooperation authority stale：generation 单调 + 旧 context/observation 拒绝', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'stale navigate');
    const first = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'sync first');
    const g1 = Number(first.authority && first.authority.generation);
    assert(Number.isInteger(g1) && g1 >= 1, '缺少 authority.generation：' + JSON.stringify(first.authority));
    const second = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'sync second');
    const g2 = Number(second.authority && second.authority.generation);
    assert(g2 === g1 + 1, 'generation 没有严格递增：' + g1 + ' → ' + g2);
    assert(second.context_id !== first.context_id, '重新 sync 应换发 context');
    const stale = await cliJson(['click', '#submit-btn', '--context', first.context_id, '--session', sessionId]);
    assert(stale.code === 1 && stale.json && stale.json.error.code === 'E_CONTEXT_STALE', '旧 context 应拒绝：' + JSON.stringify(stale.json));
    const staleObservation = await cliJson(['evaluate', '1+1', '--observation', first.observation_id, '--session', sessionId]);
    assert(staleObservation.code === 1 && staleObservation.json && staleObservation.json.error.code === 'E_OBSERVATION_STALE', '旧 observation 应拒绝：' + JSON.stringify(staleObservation.json));
    const good = await cliJson(['click', '#submit-btn', '--context', second.context_id, '--session', sessionId]);
    assert(good.code === 0, '新 context 应可执行：' + JSON.stringify(good.json));
    return 'generation ' + g1 + '→' + g2 + '；旧 context/observation 均拒绝';
  });

  await check('23k. --observation 收据校验', async () => {
    const sync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'sync obs');
    const bad = await cliJson(['evaluate', '1+1', '--observation', 'bogus', '--session', sessionId]);
    assert(bad.code === 1 && bad.json && bad.json.error.code === 'E_OBSERVATION_STALE', '错误 observation 应失效：' + JSON.stringify(bad.json));
    const good = expectOk(await cliJson(['evaluate', '1+1', '--observation', sync.observation_id, '--session', sessionId]), 'evaluate with observation');
    assert(good.value === 2, 'evaluate 结果不对');
    const wait = expectOk(await cliJson(['cooperate', 'wait', '--timeout', '3s', '--session', sessionId]), 'cooperate wait');
    assert(wait.ready === true, 'wait 应 ready');
    return 'E_OBSERVATION_STALE → ok';
  });

  await check('23l. observe --max-tokens/--cursor 分页', async () => {
    const first = expectOk(await cliJson(['observe', '--max-tokens', '20', '--session', sessionId]), 'observe chunk');
    assert(first.truncated === true && first.cursor, '首块应截断并给 cursor：' + JSON.stringify({ truncated: first.truncated, cursor: first.cursor }));
    assert(first.budget && first.budget.omittedChars > 0, '首块缺少 omitted 统计：' + JSON.stringify(first.budget));
    let text = first.observation;
    let cursor = first.cursor;
    let pages = 1;
    while (cursor && pages < 80) {
      const next = expectOk(await cliJson(['observe', '--cursor', cursor, '--max-tokens', '20', '--session', sessionId]), 'observe next');
      text += '\n' + next.observation;
      cursor = next.cursor;
      pages += 1;
    }
    assert(cursor == null, '翻页没有结束');
    assert(text.includes('人员表') || text.includes('E2E 夹具页'), '拼接后的观察文本不完整');
    return pages + ' 页，共 ' + text.length + ' 字符';
  });

  await check('23m. view <file> --find 文件检索', async () => {
    const saved = path.join(outDir, 'obs-view.txt');
    expectOk(await cliJson(['observe', '--save-full', saved, '--session', sessionId]), 'observe save-full');
    const result = await cli(['view', saved, '--find', '人员表']);
    assert(result.code === 0, 'view 退出码 ' + result.code);
    assert(result.stdout.includes('人员表'), 'view 没命中：' + result.stdout.slice(0, 200));
    assert(/^\s*\d+ \|/m.test(result.stdout), 'view 输出没有行号');
    return '命中人员表';
  });

  await check('23n. cooperate sync --match-text 折叠', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'fold navigate');
    const folded = expectOk(await cliJson(['cooperate', 'sync', '--match-text', '提交', '--context-lines', '1', '--session', sessionId]), 'sync folded');
    const text = String((folded.observation && folded.observation.text) || '');
    assert(text.includes('提交'), '折叠结果里没有命中行');
    assert(text.includes('lines omitted'), '折叠结果没有省略标记');
    assert(text.length < 2500, '折叠后仍然太长：' + text.length);
    return text.length + ' 字符';
  });

  await check('23o. VOM 标记（has-submenu/expanded/draggable/drop-target/selected）', async () => {
    const observed = expectOk(await cliJson(['observe', '--session', sessionId]), 'observe markers');
    const text = String(observed.observation || '');
    for (const marker of ['[has-submenu]', '[expanded]', '[draggable]', '[drag-handle]', '[drop-target]', '[selected:class]', '[selected:data]']) {
      assert(text.includes(marker), '缺少标记 ' + marker);
    }
    return '7 种标记齐全';
  });

  await check('23p. 同源 iframe / Shadow DOM：refs 可达、selector 不跨树', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'iframe navigate');
    const observed = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'observe frames');
    const frames = observed.frames || [];
    const frame = frames.find((item) => Number(item.frameId) > 0 && String(item.observation || '').includes('框架内按钮'));
    assert(frame, 'observation 里没有 iframe 内按钮：' + JSON.stringify(frames.map((item) => ({ id: item.frameId, url: item.url }))));
    const local = /button "框架内按钮" \[@(e\d+)\]/.exec(String(frame.observation || ''));
    assert(local, 'iframe 内按钮没有 ref：' + String(frame.observation || '').slice(0, 300));
    const alias = (observed.aliases || []).find((item) => Number(item.frameId) > 0 && item.localRef === '@' + local[1] && String(item.url || '').includes('/frame.html')) || (observed.aliases || []).find((item) => Number(item.frameId) > 0 && String(item.url || '').includes('/frame.html'));
    assert(alias, '没有 iframe ref 别名：' + JSON.stringify(observed.aliases));
    const shadowText = String(observed.text || observed.observation || '');
    const shadowRef = /button "影子按钮" \[@(e\d+)\]/.exec(shadowText);
    assert(shadowRef, 'observation 里没有 shadow 内按钮：' + shadowText.slice(0, 500));

    expectOk(await cliJson(['click', alias.ref, '--session', sessionId]), 'click frame button');
    expectOk(await cliJson(['click', '@' + shadowRef[1], '--session', sessionId]), 'click shadow button');

    const frameOut = expectOk(await cliJson([
      'evaluate',
      "document.getElementById('inner-frame').contentDocument.getElementById('frame-out').textContent",
      '--session', sessionId,
    ]), 'frame out');
    assert(frameOut.value === '框架已点击', 'iframe 内点击无效：' + JSON.stringify(frameOut.value));

    const shadowOut = expectOk(await cliJson(['evaluate', "document.getElementById('shadow-out').textContent", '--session', sessionId]), 'shadow out');
    assert(shadowOut.value === '影子已点击', 'shadow 内点击无效：' + JSON.stringify(shadowOut.value));

    const miss = await cliJson(['click', '#shadow-btn', '--session', sessionId]);
    assert(miss.code === 1 && miss.json && miss.json.error.code === 'E_NOT_FOUND', 'selector 不应该跨 shadow：' + JSON.stringify(miss.json));
    return 'iframe/shadow refs 可用，selector 不跨树';
  });

  await check('23p2. 嵌套 iframe：owner 链逐层投影', async () => {
    const nestedUrl = new URL('nested.html', pageUrl).href;
    expectOk(await cliJson(['navigate', nestedUrl, '--session', sessionId]), 'nested navigate');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'nested observe');
    const frame = (frames.frames || []).find((item) => Number(item.frameId) > 0 && String(item.observation || '').includes('嵌套按钮'));
    assert(frame, '没有找到嵌套按钮 frame：' + JSON.stringify((frames.frames || []).map((item) => ({ id: item.frameId, url: item.url }))));
    const ref = /button "嵌套按钮" \[@(e\d+)\]/.exec(String(frame.observation || ''));
    assert(ref, '嵌套按钮没有 ref');
    const clicked = expectOk(await cliJson(['click', '@' + ref[1], '--session', sessionId]), 'nested click');
    assert(clicked.via === 'frame-projected', '嵌套 frame 未走 owner 链投影：' + JSON.stringify(clicked));
    await sleep(500);
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('nested-out').textContent", '--session', sessionId]), 'nested out');
    assert(out.value === 'nested-clicked', '嵌套 iframe 点击没有回传：' + JSON.stringify(out.value));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'nested restore');
    return 'nested projected via=' + clicked.via;
  });

  await check('23p3. 真正 OOPIF：CDP frame owner 投影', async () => {
    const nestedUrl = new URL('nested-cross2.html', pageUrl).href;
    expectOk(await cliJson(['navigate', nestedUrl, '--session', sessionId]), 'oopif navigate');
    await cliJson(['wait-ms', '1500', '--session', sessionId]);
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'oopif observe');
    const alias = (frames.aliases || []).find((item) => String(item.url || '').includes('nested-cross2-inner.html'));
    assert(alias, '没有 OOPIF alias：' + JSON.stringify((frames.frames || []).map((item) => ({ id: item.frameId, url: item.url }))));
    const clicked = expectOk(await cliJson(['click', alias.ref, '--session', sessionId]), 'oopif click');
    assert(clicked.via === 'cdp-frame-owner', 'OOPIF 未走 CDP owner 投影：' + JSON.stringify(clicked));
    await sleep(500);
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('cross2-out').textContent", '--session', sessionId]), 'oopif out');
    assert(out.value === 'cross2-clicked', 'OOPIF 点击没有回传：' + JSON.stringify(out.value));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'oopif restore');
    return 'oopif via=' + clicked.via;
  });

  await check('23p4. 缩放 iframe：owner 链 scale 投影', async () => {
    const scaledUrl = new URL('scaled-frame.html', pageUrl).href;
    expectOk(await cliJson(['navigate', scaledUrl, '--session', sessionId]), 'scaled navigate');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'scaled observe');
    const frame = (frames.frames || []).find((item) => Number(item.frameId) > 0 && String(item.observation || '').includes('框架内按钮'));
    assert(frame, '没有缩放的 iframe 按钮：' + JSON.stringify((frames.frames || []).map((item) => ({ id: item.frameId, url: item.url }))));
    const ref = /button "框架内按钮" \[@(e\d+)\]/.exec(String(frame.observation || ''));
    assert(ref, '缩放 iframe 按钮没有 ref');
    const clicked = expectOk(await cliJson(['click', '@' + ref[1], '--session', sessionId]), 'scaled click');
    assert(['frame-projected', 'cdp-frame-owner'].includes(clicked.via), '缩放 iframe 未走投影：' + JSON.stringify(clicked));
    await sleep(400);
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('scaled').contentDocument.getElementById('frame-out').textContent", '--session', sessionId]), 'scaled out');
    assert(out.value === '框架已点击', '缩放 iframe 点击没有回传：' + JSON.stringify(out.value));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'scaled restore');
    return 'scaled via=' + clicked.via;
  });

  await check('23p5. 滚动容器 iframe：rect 投影', async () => {
    const scrollUrl = new URL('scroll-frame.html', pageUrl).href;
    expectOk(await cliJson(['navigate', scrollUrl, '--session', sessionId]), 'scroll navigate');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'scroll observe');
    const frame = (frames.frames || []).find((item) => Number(item.frameId) > 0 && String(item.observation || '').includes('框架内按钮'));
    assert(frame, '滚动容器里没有 iframe 按钮');
    const ref = /button "框架内按钮" \[@(e\d+)\]/.exec(String(frame.observation || ''));
    assert(ref, '滚动容器 iframe 按钮没有 ref');
    const clicked = expectOk(await cliJson(['click', '@' + ref[1], '--session', sessionId]), 'scroll click');
    assert(clicked.via === 'frame-projected', '滚动容器未走投影：' + JSON.stringify(clicked));
    await sleep(400);
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('inner').contentDocument.getElementById('frame-out').textContent", '--session', sessionId]), 'scroll out');
    assert(out.value === '框架已点击', '滚动容器 iframe 点击没有回传：' + JSON.stringify(out.value));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'scroll restore');
    return 'scroll via=' + clicked.via;
  });

  await check('23p6. 变换 iframe：rotate + skew 矩阵投影（同源）', async () => {
    const transformedUrl = new URL('transform-frame.html', pageUrl).href;
    expectOk(await cliJson(['navigate', transformedUrl, '--session', sessionId]), 'transform navigate');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'transform observe');
    const frame = (frames.frames || []).find((item) => Number(item.frameId) > 0 && String(item.observation || '').includes('框架内按钮'));
    assert(frame, '没有变换 iframe 按钮：' + JSON.stringify((frames.frames || []).map((item) => ({ id: item.frameId, url: item.url }))));
    const ref = /button "框架内按钮" \[@(e\d+)\]/.exec(String(frame.observation || ''));
    assert(ref, '变换 iframe 按钮没有 ref');
    const clicked = expectOk(await cliJson(['click', '@' + ref[1], '--session', sessionId]), 'transform click');
    assert(['frame-projected', 'cdp-frame-owner'].includes(clicked.via), '变换 iframe 未走投影：' + JSON.stringify(clicked));
    await sleep(400);
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('transformed').contentDocument.getElementById('frame-out').textContent", '--session', sessionId]), 'transform out');
    assert(out.value === '框架已点击', '变换 iframe 点击没有回传：' + JSON.stringify(out.value));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'transform restore');
    return 'rotate+skew via=' + clicked.via;
  });

  await check('23p7. 变换 OOPIF：矩阵 owner 投影（跨源）', async () => {
    const crossUrl = new URL('transform-cross.html', pageUrl).href;
    expectOk(await cliJson(['navigate', crossUrl, '--session', sessionId]), 'transform oopif navigate');
    await cliJson(['wait-ms', '1500', '--session', sessionId]);
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'transform oopif observe');
    const alias = (frames.aliases || []).find((item) => String(item.url || '').includes('frame-transform.html'));
    assert(alias, '没有跨源变换 alias：' + JSON.stringify((frames.frames || []).map((item) => ({ id: item.frameId, url: item.url }))));
    const clicked = expectOk(await cliJson(['click', alias.ref, '--session', sessionId]), 'transform oopif click');
    assert(clicked.via === 'cdp-frame-owner', '跨源变换未走 CDP owner 投影：' + JSON.stringify(clicked));
    await sleep(600);
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('xform-out').textContent", '--session', sessionId]), 'transform oopif out');
    assert(out.value === 'matrix-clicked', '跨源变换点击没有回传：' + JSON.stringify(out.value));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'transform oopif restore');
    return 'rotate+scale via=' + clicked.via;
  });

  await check('23p8. 3D 变换 iframe：matrix3d 投影', async () => {
    const t3dUrl = new URL('transform3d-frame.html', pageUrl).href;
    expectOk(await cliJson(['navigate', t3dUrl, '--session', sessionId]), '3d transform navigate');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), '3d transform observe');
    const frame = (frames.frames || []).find((item) => Number(item.frameId) > 0 && String(item.observation || '').includes('框架内按钮'));
    assert(frame, '没有 3D 变换 iframe 按钮：' + JSON.stringify((frames.frames || []).map((item) => ({ id: item.frameId, url: item.url }))));
    const ref = /button "框架内按钮" \[@(e\d+)\]/.exec(String(frame.observation || ''));
    assert(ref, '3D 变换 iframe 按钮没有 ref');
    const clicked = expectOk(await cliJson(['click', '@' + ref[1], '--session', sessionId]), '3d transform click');
    assert(clicked.via === 'cdp-frame-owner', '3D 变换未走 CDP owner 投影：' + JSON.stringify(clicked));
    await sleep(400);
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('t3d').contentDocument.getElementById('frame-out').textContent", '--session', sessionId]), '3d transform out');
    assert(out.value === '框架已点击', '3D 变换点击没有回传：' + JSON.stringify(out.value));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), '3d transform restore');
    return 'matrix3d via=' + clicked.via;
  });

  await check('23p9. perspective 3D iframe：homography 投影', async () => {
    const perspectiveUrl = new URL('perspective-frame.html', pageUrl).href;
    expectOk(await cliJson(['navigate', perspectiveUrl, '--session', sessionId]), 'perspective navigate');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    const frames = expectOk(await cliJson(['observe', '--frames', '--force', '--session', sessionId]), 'perspective observe');
    const frame = (frames.frames || []).find((item) => Number(item.frameId) > 0 && String(item.observation || '').includes('框架内按钮'));
    assert(frame, '没有 perspective iframe 按钮：' + JSON.stringify((frames.frames || []).map((item) => ({ id: item.frameId, url: item.url }))));
    const ref = /button "框架内按钮" \[@(e\d+)\]/.exec(String(frame.observation || ''));
    assert(ref, 'perspective iframe 按钮没有 ref');
    const clicked = expectOk(await cliJson(['click', '@' + ref[1], '--session', sessionId]), 'perspective click');
    assert(clicked.via === 'cdp-frame-owner', 'perspective 未走 CDP owner 投影：' + JSON.stringify(clicked));
    await sleep(400);
    const out = expectOk(await cliJson(['evaluate', "document.getElementById('p3d').contentDocument.getElementById('frame-out').textContent", '--session', sessionId]), 'perspective out');
    assert(out.value === '框架已点击', 'perspective 点击没有回传：' + JSON.stringify(out.value));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'perspective restore');
    return 'perspective via=' + clicked.via;
  });

  await check('23q. screenshot --annotate + 按图坐标点击', async () => {
    const observed = expectOk(await cliJson(['observe', '--session', sessionId]), 'observe for annotate');
    const match = /button "提交查询" \[@(e\d+)\]/.exec(String(observed.observation || ''));
    assert(match, '没找到提交按钮 ref');
    expectOk(await cliJson(['scroll-to', '@' + match[1], '--session', sessionId]), 'scroll submit into view');

    const shotPath = path.join(outDir, 'annotated.png');
    const shot = expectOk(await cliJson(['screenshot', '--annotate', '--out', shotPath, '--session', sessionId]), 'screenshot annotate');
    assert(typeof shot.capture_id === 'string' && shot.capture_id, '缺少 capture_id');
    assert(Array.isArray(shot.visual_refs) && shot.visual_refs.length > 0, '缺少 visual_refs');
    assert(existsSync(shotPath), '标注截图没有落盘');
    assert(readFileSync(shotPath).length > 1000, '标注截图太小');

    const target = shot.visual_refs.find((item) => item.ref === '@' + match[1]) ||
      shot.visual_refs.find((item) => item.role === 'button' && String(item.name || '').includes('提交'));
    assert(target, 'visual_refs 里没有提交按钮：' + JSON.stringify(shot.visual_refs.slice(0, 5)));
    assert(Number.isFinite(target.image_x) && Number.isFinite(target.image_y), 'visual_ref 缺少 image_x/image_y');

    const clicked = expectOk(await cliJson([
      'click', '--capture', shot.capture_id,
      '--image-x', String(target.image_x),
      '--image-y', String(target.image_y),
      '--session', sessionId,
    ]), 'click by image');
    assert(clicked.ok === true, '按图点击失败');

    const out = expectOk(await cliJson(['evaluate', "document.getElementById('out').textContent", '--session', sessionId]), 'evaluate out');
    assert(String(out.value).startsWith('clicked:'), '按图坐标点击没有触发按钮：' + JSON.stringify(out.value));
    return 'capture=' + shot.capture_id.slice(0, 8) + ' refs=' + shot.visual_refs.length + ' via=' + clicked.via;
  });

  await check('23r. --settle 动作后等待', async () => {
    const started = Date.now();
    const result = expectOk(await cliJson(['click', '#submit-btn', '--settle', '400ms', '--session', sessionId]), 'click settle');
    const elapsed = Date.now() - started;
    assert(result.settledMs === 400, 'settledMs 不对：' + JSON.stringify(result));
    assert(elapsed >= 400, '没有真的等待：' + elapsed + 'ms');
    return 'settledMs=400 实际 ' + elapsed + 'ms';
  });

  await check('23s. --depends-on 依赖校验（失败带结构化 data）', async () => {
    const bad = await cliJson(['click', '#submit-btn', '--depends-on', '[{"target":"#kw","field":"value","equals":"__never__"}]', '--session', sessionId]);
    assert(bad.code === 1, 'depends-on 失败应退出码 1');
    assert(bad.json && bad.json.error.code === 'E_DEPENDS_FAILED', '错误码不对：' + JSON.stringify(bad.json));
    assert(bad.json.error.data && bad.json.error.data.mismatch, '缺少结构化 mismatch');
    assert(bad.json.error.data.mismatch.actual !== undefined, 'mismatch 里没有 actual');

    const good = expectOk(await cliJson(['click', '#submit-btn', '--depends-on', '[{"target":"#kw","field":"exists","equals":true}]', '--session', sessionId]), 'depends ok');
    assert(good.ok === true, 'depends-on 通过后动作应执行');
    return 'E_DEPENDS_FAILED(data) → 通过';
  });

  await check('23t. --expect 失败带 data.mismatch', async () => {
    const bad = await cliJson(['click', '#submit-btn', '--expect', '[{"target":"#out","field":"text","equals":"__x__"}]', '--session', sessionId]);
    assert(bad.code === 1 && bad.json.error.code === 'E_EXPECT_FAILED', '错误码不对');
    const data = bad.json.error.data || {};
    assert(data.mismatch && data.mismatch.target === '#out', 'data.mismatch.target 不对：' + JSON.stringify(data));
    assert(data.effect_state === 'none' && data.dispatched === false, '校验失败应带 effect_state=none/dispatched=false：' + JSON.stringify(data));
    return 'data.mismatch 完整，effect_state=none';
  });

  await check('23u. 人工接管：cooperate wait 检测到人操作 → 等待后恢复', async () => {
    const pressed = uiaClick('提交查询');
    assert(pressed.code === 0 && /INVOKED|CLICKED/.test(pressed.stdout), 'UIA 人工点击失败：' + JSON.stringify(pressed));
    const busy = expectOk(await cliJson(['cooperate', 'wait', '--timeout', '500ms', '--session', sessionId]), 'wait busy');
    assert(busy.ready === false, '应检测到人工操作：' + JSON.stringify(busy));
    assert(busy.state && busy.state.mode === 'human', 'state 应为 human：' + JSON.stringify(busy.state));
    await sleep(2100);
    const idle = expectOk(await cliJson(['cooperate', 'wait', '--timeout', '500ms', '--session', sessionId]), 'wait idle');
    assert(idle.ready === true, '人工停手后应恢复 ready：' + JSON.stringify(idle));
    const reconciled = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'human reconcile sync');
    assert(reconciled.reconciliation && reconciled.reconciliation.humanEdits >= 1, 'sync 没有报告人工编辑：' + JSON.stringify(reconciled.reconciliation));
    return 'human → ready → edits=' + reconciled.reconciliation.humanEdits;
  });

  await check('23v. scroll-to 返回边界 + 性能 CLS/长任务', async () => {
    await cliJson(['session', 'resume', '--session', sessionId]);
    const scrolled = expectOk(await cliJson(['scroll-to', '#bottom', '--session', sessionId]), 'scroll bottom');
    assert(scrolled.bounds && typeof scrolled.bounds.height === 'number', 'scroll-to 没有返回 bounds：' + JSON.stringify(scrolled));
    assert(scrolled.viewport && scrolled.viewport.height > 0, 'scroll-to 没有返回 viewport');
    const perf = expectOk(await cliJson(['debug', 'performance', '--session', sessionId]), 'performance cls');
    assert(typeof perf.metrics.cls === 'number', '缺少 CLS：' + JSON.stringify(perf.metrics && perf.metrics.cls));
    assert(perf.metrics.longTasks && typeof perf.metrics.longTasks.count === 'number', '缺少长任务统计');
    return 'bounds.y=' + scrolled.bounds.y + ' cls=' + perf.metrics.cls + ' longtasks=' + perf.metrics.longTasks.count;
  });

  await check('23v2. snapshot 带 @eN ref 且可读', async () => {
    const snap = expectOk(await cliJson(['snapshot', '--session', sessionId]), 'snapshot refs');
    assert(/@e\d+/.test(String(snap.text)), 'snapshot 没有 @eN ref');
    const line = String(snap.text).split('\n').find((item) => item.includes('查看详情') && /@e\d+/.test(item));
    assert(line, 'snapshot 没找到查看详情 ref：' + JSON.stringify(String(snap.text).split('\n').filter((l) => l.includes('查看详情'))));
    const ref = (line.match(/@e\d+/) || [])[0];
    const read = expectOk(await cliJson(['read', '--ref', ref, '--session', sessionId]), 'read snapshot ref');
    const value = read.fields && read.fields[0] ? read.fields[0].value : read.value;
    assert(String(value).includes('查看详情'), 'snapshot ref 读取不对：' + JSON.stringify(read));
    return 'ref=' + ref;
  });

  await check('23w. strict 策略强制 --context', async () => {
    expectOk(await cliJson(['cooperate', 'sync', '--policy', 'strict', '--session', sessionId]), 'sync strict');
    const missing = await cliJson(['click', '#submit-btn', '--session', sessionId]);
    assert(missing.code === 1 && missing.json && missing.json.error.code === 'E_CONTEXT_REQUIRED', 'strict 下缺 context 应报 E_CONTEXT_REQUIRED：' + JSON.stringify(missing.json));

    const sync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'sync strict context');
    expectOk(await cliJson(['click', '#submit-btn', '--context', sync.context_id, '--session', sessionId]), 'strict click with context');
    const reuse = await cliJson(['click', '#submit-btn', '--context', sync.context_id, '--session', sessionId]);
    assert(reuse.code === 1 && reuse.json && reuse.json.error.code === 'E_CONTEXT_STALE', 'strict 下 context 应单次使用：' + JSON.stringify(reuse.json));

    expectOk(await cliJson(['cooperate', 'sync', '--policy', 'auto', '--session', sessionId]), 'reset policy auto');
    expectOk(await cliJson(['click', '#submit-btn', '--session', sessionId]), 'auto click without context');
    return 'strict 强制 → 单次 → 恢复 auto';
  });

  await check('23x. cooperate handback：人工交回后立刻 ready', async () => {
    // UIA 只能点到前台窗口；headed 浏览器可能被遮挡/最小化，先显式 focus 并重试一次。
    const listed = expectOk(await cliJson(['session', 'list']), 'uia session list');
    const current = (listed.sessions || []).find((item) => item.sessionId === sessionId);
    let pressed = uiaClick('提交查询', 'BridgeDeck E2E 夹具页');
    for (let attempt = 0; attempt < 2 && !(pressed.code === 0 && /INVOKED|CLICKED/.test(pressed.stdout)); attempt += 1) {
      if (current && Number.isInteger(current.windowId)) {
        await cliJson(['window', 'focus', String(current.windowId), '--session', sessionId]);
      }
      if (current && Number.isInteger(current.tabId)) await cliJson(['tab', 'select', String(current.tabId)]);
      await sleep(600);
      pressed = uiaClick('提交查询', 'BridgeDeck E2E 夹具页');
    }
    assert(pressed.code === 0 && /INVOKED|CLICKED/.test(pressed.stdout), 'UIA 人工点击失败：' + JSON.stringify(pressed));
    const busy = expectOk(await cliJson(['cooperate', 'wait', '--timeout', '400ms', '--session', sessionId]), 'wait busy');
    assert(busy.ready === false, '应检测到人工操作：' + JSON.stringify(busy));
    expectOk(await cliJson(['cooperate', 'handback', '--session', sessionId]), 'cooperate handback');
    const ready = expectOk(await cliJson(['cooperate', 'wait', '--timeout', '3s', '--session', sessionId]), 'wait after handback');
    assert(ready.ready === true, '交回后应立即 ready：' + JSON.stringify(ready));
    return 'human → handback → ready';
  });

  await check('23x2. extract list 字段映射 + max-rows', async () => {
    const list = expectOk(await cliJson(['extract', 'list', '--selector', '#items', '--item-selector', 'li', '--fields-json', '[{"name":"text"}]', '--session', sessionId]), 'extract list');
    assert(list.rowCount === 3, '列表行数应为 3，实际 ' + list.rowCount);
    assert((list.columns || []).some((column) => column.key === 'text'), '缺少字段列');
    const limited = expectOk(await cliJson(['extract', 'list', '--selector', '#items', '--item-selector', 'li', '--max-rows', '2', '--session', sessionId]), 'extract list max rows');
    assert(limited.rowCount === 2 && limited.truncated === true, 'max-rows 截断不正确');
    return 'rows=3, limit=2';
  });

  await check('23x3. observe --max-depth 截断标记', async () => {
    const res = expectOk(await cliJson(['observe', '--max-depth', '1', '--session', sessionId]), 'observe max depth');
    assert(String(res.observation || '').includes('截断更深层'), '缺少深度截断提示');
    return 'depth=1';
  });

  await check('23x4. extract --max-bytes 截断', async () => {
    const capped = expectOk(await cliJson(['extract', 'list', '--selector', '#items', '--item-selector', 'li', '--max-bytes', '120', '--session', sessionId]), 'extract max bytes');
    assert(capped.truncated === true, '没有按字节截断');
    assert((capped.rows || []).length < 3, '字节截断后行数未减少：' + (capped.rows || []).length);
    return 'rows=' + (capped.rows || []).length;
  });

  await check('23x5. screenshot --scope follow', async () => {
    const file = path.join(outDir, 'follow.png');
    const shot = expectOk(await cliJson(['screenshot', '--scope', 'follow', '--out', file, '--session', sessionId]), 'screenshot follow');
    assert(shot.width > 0 && shot.height > 0, '截图尺寸异常');
    assert(existsSync(file), '截图未落盘');
    return shot.width + 'x' + shot.height;
  });

  await check('23x6. observe --debug-surfaces', async () => {
    const res = expectOk(await cliJson(['observe', '--debug-surfaces', '--session', sessionId]), 'observe debug surfaces');
    assert(String(res.observation || '').includes('surfaces iframes='), '缺少 surfaces 诊断');
    return 'surfaces';
  });

  await check('24. request-help 在设置关闭时被拒绝', async () => {
    expectOk(await cliJson(['settings', 'set', '--allow-help', 'off']), 'settings allow-help off');
    const r = await cliJson(['request-help', '--reason', '需要登录', '--session', sessionId]);
    assert(r.json && r.json.ok === false, 'request-help 应该失败：' + JSON.stringify(r.json));
    assert(r.json.error.code === 'E_HELP_DISABLED', '错误码不对：' + r.json.error.code);
    return 'E_HELP_DISABLED';
  });

  await check('24b. 人工协助卡片：完成并交还控制权', async () => {
    expectOk(await cliJson(['settings', 'set', '--allow-help', 'on']), 'settings allow-help on');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'navigate before help');
    await sleep(300);
    const pending = cliJson(['request-help', '--prompt', '请确认页面上的登录状态', '--target', '#kw', '--timeout', '60s', '--session', sessionId]);
    let present = false;
    for (let attempt = 0; attempt < 10 && !present; attempt += 1) {
      await sleep(400);
      const html = await cli(['get-html', '--session', sessionId]);
      if (String(html.stdout).includes('__bb_help_host')) present = true;
    }
    let clicked = null;
    if (present) clicked = uiaClick('完成并交还控制权');
    if (!clicked) {
      const failed = await pending;
      const html = await cli(['get-html', '--session', sessionId]);
      assert(false, '协助卡片没有出现；request-help=' + JSON.stringify({ code: failed.code, stdout: failed.stdout, stderr: failed.stderr }) + ' htmlHasHost=' + String(html.stdout).includes('__bb_help_host'));
    }
    assert(clicked.code === 0 && /INVOKED|CLICKED/.test(clicked.stdout), 'UIA 未能点击协助卡片：' + JSON.stringify(clicked));
    const done = await pending;
    assert(done.code === 0, 'request-help 退出码 ' + done.code);
    const result = (done.json && done.json.result) || {};
    assert(result.action === 'done', 'action 不是 done：' + JSON.stringify(result) + ' stdout=' + done.stdout + ' clicked=' + JSON.stringify(clicked && clicked.json));
    assert(result.note === '' || result.note == null, '未输入备注时不应回传备注：' + JSON.stringify(result));
    const gone = expectOk(await cliJson(['evaluate', "!!document.getElementById('__bb_help_host')", '--session', sessionId]), 'help overlay removed');
    assert(gone.value === false, '协助卡片没有移除');
    return 'done + note';
  });

  await check('24b2. request-help 完成条件满足后自动交还', async () => {
    const started = Date.now();
    const result = expectOk(await cliJson([
      'request-help', '--reason', '等待页面条件', '--until', '[{"kind":"selector_exists","selector":"body"}]',
      '--timeout', '10s', '--session', sessionId,
    ]), 'request-help criteria');
    assert(result.action === 'done', '条件满足应返回 done：' + JSON.stringify(result));
    assert(Date.now() - started < 8000, '完成条件应快速返回，不应等到超时');
    const gone = expectOk(await cliJson(['evaluate', "!!document.getElementById('__bb_help_host')", '--session', sessionId]), 'criteria overlay removed');
    assert(gone.value === false, '条件完成后协助卡片没有移除');
    return 'done via criteria';
  });

  await check('24c. 操作录制浮层：出现 → 结束', async () => {
    expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record start overlay');
    let present = false;
    for (let attempt = 0; attempt < 10 && !present; attempt += 1) {
      await sleep(300);
      const html = await cli(['get-html', '--session', sessionId]);
      if (String(html.stdout).includes('__bb_record_host')) present = true;
    }
    assert(present, '录制浮层没有出现');
    expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record stop overlay');
    await sleep(600);
    const html = await cli(['get-html', '--session', sessionId]);
    assert(!String(html.stdout).includes('__bb_record_host'), '录制浮层没有移除');
    const listed = expectOk(await cliJson(['record', 'list']), 'record list after overlay');
    assert((listed.recordings || []).length > 0, '录制没有保存');
    return 'overlay + stop';
  });

  await check('24d. 截图时隐藏接管浮层并恢复', async () => {
    const visibleBefore = expectOk(await cliJson(['evaluate', "(()=>{const h=document.querySelector('[data-bb-ui=\"takeover\"]')||document.getElementById('__bb_takeover_host');return h?getComputedStyle(h).visibility:'missing';})()", '--session', sessionId]), 'overlay before');
    assert(visibleBefore.value === 'visible', '接管浮层应可见：' + JSON.stringify(visibleBefore));
    const file = path.join(outDir, 'overlay-suppressed.png');
    expectOk(await cliJson(['screenshot', '--out', file, '--session', sessionId]), 'screenshot with overlay');
    const visibleAfter = expectOk(await cliJson(['evaluate', "(()=>{const h=document.querySelector('[data-bb-ui=\"takeover\"]')||document.getElementById('__bb_takeover_host');return h?getComputedStyle(h).visibility:'missing';})()", '--session', sessionId]), 'overlay after');
    assert(visibleAfter.value === 'visible', '截图后浮层没有恢复：' + JSON.stringify(visibleAfter));
    return 'hidden during capture, restored';
  });

  await check('25. 手动长截图拼接', async () => {
    expectOk(await cliJson(['screenshot', '--mode', 'manual', '--session', sessionId]), 'manual frame 1');
    const overlay = expectOk(await cliJson(['evaluate', "!!document.getElementById('__bb_manual_host')", '--session', sessionId]), 'manual overlay');
    assert(overlay.value === true, '手动长截图浮层没有出现');
    expectOk(await cliJson(['screenshot', '--mode', 'manual', '--session', sessionId]), 'manual frame 2');
    const shot = path.join(outDir, 'stitch.png');
    expectOk(await cliJson(['screenshot', '--mode', 'manual', '--stitch', '--out', shot, '--session', sessionId]), 'stitch');
    const gone = expectOk(await cliJson(['evaluate', "!!document.getElementById('__bb_manual_host')", '--session', sessionId]), 'manual overlay gone');
    assert(gone.value === false, '手动长截图浮层没有移除');
    const buf = readFileSync(shot);
    assert(buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', '拼接结果不是 PNG');
    const height = buf.readUInt32BE(20);
    assert(height > 800, '拼接高度太小：' + height);
    return buf.readUInt32BE(16) + 'x' + height;
  });

  await check('26. 借用安全策略：Agent 窗口标签页不可借用', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'session list for borrow');
    const current = (listed.sessions || [])[0] || {};
    const denied = await cliJson(['tab', 'borrow', String(current.tabId), '--session', sessionId]);
    assert(denied.code === 1 && denied.json && denied.json.error && /E_FORBIDDEN|E_BORROW_CONFLICT/.test(denied.json.error.code), 'Agent 窗口标签页不应可借用：' + JSON.stringify(denied.json));
    return denied.json.error.code;
  });

  await check('27. audit 记录可见', async () => {
    const res = expectOk(await cliJson(['audit', 'list', '--limit', '300']), 'audit list');
    assert((res.entries || []).length > 0, '没有审计记录');
    const methods = new Set((res.entries || []).map((entry) => entry.method));
    assert(methods.has('observe'), '审计里没有 observe');
    return 'entries=' + res.entries.length;
  });

  await check('28. doctor 包含扩展 UI 自检', async () => {
    const r = await cli(['doctor']);
    assert(r.code === 0, 'doctor 退出码 ' + r.code + ' stdout=' + r.stdout + ' stderr=' + r.stderr);
    assert(r.stdout.includes('extension-ui'), 'doctor 没有 extension-ui 项：' + r.stdout);
    assert(/\[ok\]\s+extension-ui/.test(r.stdout), 'extension-ui 不是 ok：' + r.stdout);
    return 'extension-ui ok';
  });

  await check('29. 扩展弹窗页面在真实浏览器里渲染', async () => {
    const opened = expectOk(await cliJson(['ui', '--page', 'popup']), 'ui open');
    assert(Number.isInteger(opened.tabId), 'ui open 没返回 tabId');
    await sleep(600);
    const tabs = expectOk(await cliJson(['tab', 'list', '--scope', 'all']), 'tab list all');
    const popup = (tabs.tabs || []).find((tab) => tab.tabId === opened.tabId);
    assert(popup, '没在 tab list 里看到弹窗标签页');
    assert(String(popup.title || '').includes('BridgeDeck'), '弹窗标题不对：' + JSON.stringify(popup.title));
    assert(String(popup.url || '').includes('ui/popup.html'), '弹窗 url 不对：' + popup.url);
    const shot = path.join(outDir, 'popup.png');
    let bytes = 0;
    try {
      const borrowed = expectOk(await cliJson(['session', 'start', '--tab', String(opened.tabId)]), 'session start(ui)');
      // 用 340x620 的视口把弹窗页面拍成一张能直接放进文档的图（顺带验证借用标签页上的 emulate）
      expectOk(await cliJson(['emulate', '--width', '360', '--height', '640', '--session', borrowed.sessionId]), 'emulate popup');
      await sleep(500);
      expectOk(await cliJson(['screenshot', '--out', shot, '--session', borrowed.sessionId]), 'screenshot popup');
      bytes = readFileSync(shot).length;
      if (SYNC_DOCS) {
        try { copyFileSync(shot, path.join(ROOT, 'docs', 'assets', 'popup.png')); } catch { /* 文档图同步失败忽略 */ }
      }
      expectOk(await cliJson(['session', 'stop', borrowed.sessionId]), 'stop ui session');
    } finally {
      await cli(['tab', 'close', String(opened.tabId)]);
    }
    assert(bytes > 4000, '弹窗截图太小：' + bytes);
    return 'title=BridgeDeck url=ui/popup.html png=' + bytes + ' bytes';
  });


  // ---------------------------------------------------------------- v0.3 扩展子页面
  async function openPageAndReadTitle(page, query) {
    const args = ['ui', '--page', page];
    if (query) args.push('--query', query);
    let openedResult = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      openedResult = await cliJson(args);
      if (openedResult.json && openedResult.json.ok === true) break;
      const message = String((openedResult.json && openedResult.json.error && openedResult.json.error.message) || '');
      if (!/cannot be edited|dragging a tab/i.test(message)) break;
      await sleep(800);
    }
    const opened = expectOk(openedResult, 'ui open ' + page);
    if (page === 'longshot') {
      const tabs = expectOk(await cliJson(['tab', 'list', '--scope', 'all']), 'tab list longshot focus');
      const tab = (tabs.tabs || []).find((item) => item.tabId === opened.tabId);
      if (tab && Number.isInteger(tab.windowId)) await cliJson(['window', 'focus', String(tab.windowId)]);
      await cliJson(['tab', 'select', String(opened.tabId)]).catch(() => {});
      await sleep(300);
    }
    let title = '';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(500);
      const tabs = expectOk(await cliJson(['tab', 'list', '--scope', 'all']), 'tab list ' + page);
      const tab = (tabs.tabs || []).find((item) => item.tabId === opened.tabId);
      title = tab && tab.title ? tab.title : '';
      if (/^SELFTEST:/.test(title) || (query == null && title)) break;
    }
    return { title, tabId: opened.tabId };
  }

  async function closePage(tabId) {
    await cli(['tab', 'close', String(tabId)]);
  }

  await check('29b. 弹窗设置开关自测', async () => {
    await waitBrowser();
    const opened = expectOk(await cliJson(['ui', '--page', 'popup', '--query', 'selftest=1']), 'ui open popup selftest');
    let title = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(400);
      const listed = await cliJson(['tab', 'list', '--scope', 'all']);
      if (!listed.json || !listed.json.ok) continue;
      const tabs = listed.json.result || {};
      const tab = (tabs.tabs || []).find((item) => item.tabId === opened.tabId);
      title = tab && tab.title ? tab.title : '';
      if (/^SELFTEST:/.test(title)) break;
    }
    await cli(['tab', 'close', String(opened.tabId)]);
    assert(title.startsWith('SELFTEST:ok:popup:toggles'), '弹窗开关自测失败：' + JSON.stringify(title));
    return 'controlHint + 远程配对设置 写入/还原正常';
  });

  await check('29e. 可访问性基础自检（lang/按钮名/switch/alt）', async () => {
    const opened = await openPageAndReadTitle('popup', 'selftest=a11y');
    await closePage(opened.tabId);
    assert(opened.title === 'SELFTEST:ok:a11y:0', '可访问性自检失败：' + JSON.stringify(opened.title));
    return 'a11y ok';
  });

  await check('29c. CLI 不能通过 daemonUrl 完成本机配对', async () => {
    const before = expectOk(await cliJson(['browsers']), 'browsers before pair');
    assert((before.browsers || []).some((item) => item.localAuth === 'unpaired'), '默认应为未配对');
    const paired = expectOk(await cliJson(['daemon', 'pair']), 'daemon pair');
    assert(paired.link && paired.link.includes('#'), '配对链接格式不对：' + JSON.stringify(paired).slice(0, 120));
    const denied = await cliJson(['settings', 'set', '--daemon-url', 'ws://127.0.0.1:1/ws', '--daemon-token', paired.token]);
    assert(denied.code === 1 && denied.json && denied.json.error && denied.json.error.code === 'E_FORBIDDEN', 'CLI 修改配对地址应被拒绝：' + JSON.stringify(denied.json));
    return 'E_FORBIDDEN';
  });

  await check('29d. 阿拉伯语 / 希伯来语界面（完整 RTL 语言包）', async () => {
    const readUiTitle = async (query) => {
      const opened = expectOk(await cliJson(['ui', '--page', 'options', '--query', query]), 'ui open options ' + query);
      let title = '';
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(400);
        const tabs = expectOk(await cliJson(['tab', 'list', '--scope', 'all']), 'tab list ' + query);
        const tab = (tabs.tabs || []).find((item) => item.tabId === opened.tabId);
        title = tab && tab.title ? tab.title : '';
        if (/[\u0600-\u06FF\u0590-\u05FF]/.test(title)) break;
      }
      await closePage(opened.tabId);
      return title;
    };
    const arabic = await readUiTitle('lang=ar');
    assert(/[\u0600-\u06FF]/.test(arabic), '阿拉伯语标题未生效：' + JSON.stringify(arabic));
    const hebrew = await readUiTitle('lang=he');
    assert(/[\u0590-\u05FF]/.test(hebrew), '希伯来语标题未生效：' + JSON.stringify(hebrew));
    return 'ar=' + arabic.slice(0, 24) + ' he=' + hebrew.slice(0, 24);
  });

  await check('30. 快捷功能页渲染 5 个入口', async () => {
    await waitBrowser();
    let { title, tabId } = await openPageAndReadTitle('quick', null);
    if (!title) {
      await closePage(tabId);
      await sleep(500);
      ({ title, tabId } = await openPageAndReadTitle('quick', null));
    }
    const shot = path.join(outDir, 'quick.png');
    try {
      const borrowed = expectOk(await cliJson(['session', 'start', '--tab', String(tabId)]), 'session start(quick)');
      try {
        expectOk(await cliJson(['emulate', '--width', '360', '--height', '640', '--session', borrowed.sessionId]), 'emulate quick');
        await sleep(500);
        expectOk(await cliJson(['screenshot', '--out', shot, '--session', borrowed.sessionId]), 'screenshot quick');
        if (SYNC_DOCS) {
          try { copyFileSync(shot, path.join(ROOT, 'docs', 'assets', 'quick.png')); } catch { /* 文档图同步失败忽略 */ }
        }
      } catch (error) {
        console.log('  WARN  快捷功能文档截图失败（不影响功能断言）：' + error.message);
      }
      expectOk(await cliJson(['session', 'stop', borrowed.sessionId]), 'stop quick session');
    } finally {
      await closePage(tabId);
    }
    assert(title.includes('快捷功能'), '快捷功能页标题不对：' + JSON.stringify(title));
    return 'title=' + title;
  });

  await check('31. 长截图页（真实整页截图）', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'longshot focus list');
    const current = (listed.sessions || []).find((item) => item.sessionId === sessionId);
    if (current && Number.isInteger(current.windowId)) expectOk(await cliJson(['window', 'focus', String(current.windowId), '--session', sessionId]), 'longshot window focus');
    await sleep(300);
    const { title, tabId } = await openPageAndReadTitle('longshot', 'selftest=1');
    await closePage(tabId);
    assert(/^SELFTEST:ok:longshot:\d+x\d+$/.test(title), '长截图自测失败：' + JSON.stringify(title));
    return title.replace('SELFTEST:ok:longshot:', '');
  });

  await check('31b. 长截图恢复：本地分片 → 重新拼接', async () => {
    const listed = expectOk(await cliJson(['session', 'list']), 'longshot focus list');
    const current = (listed.sessions || []).find((item) => item.sessionId === sessionId);
    if (current && Number.isInteger(current.windowId)) expectOk(await cliJson(['window', 'focus', String(current.windowId), '--session', sessionId]), 'longshot window focus');
    await sleep(300);
    const { title, tabId } = await openPageAndReadTitle('longshot', 'selftest=restore');
    await closePage(tabId);
    assert(/^SELFTEST:ok:restore:\d+:\d+x\d+$/.test(title), '长截图恢复失败：' + JSON.stringify(title));
    const parts = title.replace('SELFTEST:ok:restore:', '').split(':');
    assert(Number(parts[0]) >= 1, '恢复的分片数不对：' + title);
    assert(/^\d+x\d+$/.test(parts[1]), '恢复尺寸不对：' + title);
    return 'tiles=' + parts[0] + ' ' + parts[1];
  });

  await check('32. 操作录制页（真实开始/停止录制）', async () => {
    const { title, tabId } = await openPageAndReadTitle('ops', 'selftest=1');
    await closePage(tabId);
    assert(/^SELFTEST:ok:ops:\d+:\d+$/.test(title), '操作录制自测失败：' + JSON.stringify(title));
    const parts = title.replace('SELFTEST:ok:ops:', '').split(':');
    assert(Number(parts[0]) >= 1, '停止后没有落库的录制：' + title);
    assert(Number(parts[1]) >= 1, '录制里没有采到用户操作事件：' + title);
    return parts[0] + ' 条录制 / ' + parts[1] + ' 条事件';
  });

  await check('33. 网站调试页（真实采集一次）', async () => {
    const { title, tabId } = await openPageAndReadTitle('debug', 'selftest=1');
    await closePage(tabId);
    assert(/^SELFTEST:ok:debug:\d+:\d+$/.test(title), '网站调试自测失败：' + JSON.stringify(title));
    const parts = title.replace('SELFTEST:ok:debug:', '').split(':');
    assert(Number(parts[0]) >= 1, '调试采集没抓到任何请求：' + title);
    return parts[0] + ' 请求 / ' + parts[1] + ' 条输出';
  });

  await check('33b. 调试页规则面板：添加 → 列出 → 清空', async () => {
    const { title, tabId } = await openPageAndReadTitle('debug', 'selftest=rules');
    await closePage(tabId);
    assert(/^SELFTEST:ok:rules:\d+$/.test(title), '调试页规则自测失败：' + JSON.stringify(title));
    return 'rules=' + title.replace('SELFTEST:ok:rules:', '');
  });

  await check('33c. 调试页性能面板：读取指标', async () => {
    const { title, tabId } = await openPageAndReadTitle('debug', 'selftest=perf');
    await closePage(tabId);
    assert(/^SELFTEST:ok:perf:\d+$/.test(title), '调试页性能自测失败：' + JSON.stringify(title));
    return 'metrics=' + title.replace('SELFTEST:ok:perf:', '');
  });

  await check('33d. 调试页重放面板：采集后重放请求', async () => {
    const { title, tabId } = await openPageAndReadTitle('debug', 'selftest=replay');
    await closePage(tabId);
    assert(/^SELFTEST:ok:replay:\d+$/.test(title), '调试页重放自测失败：' + JSON.stringify(title));
    return 'status=' + title.replace('SELFTEST:ok:replay:', '');
  });

  await check('34. 操作审计页（任务审计）', async () => {
    const { title, tabId } = await openPageAndReadTitle('audit', 'selftest=1');
    await closePage(tabId);
    assert(/^SELFTEST:ok:audit:\d+$/.test(title), '操作审计自测失败：' + JSON.stringify(title));
    return title.replace('SELFTEST:ok:audit:', '') + ' 条';
  });

  await check('35. 视频录制页（真实录 MP4 并落库）', async () => {
    await cliJson(['session', 'resume', sessionId]).catch(() => {});
    const { title, tabId } = await openPageAndReadTitle('record', 'selftest=1');
    await closePage(tabId);
    assert(/^SELFTEST:ok:video:\d+:(mp4|webm):\d+$/.test(title), '视频录制自测失败：' + JSON.stringify(title));
    const parts = title.replace('SELFTEST:ok:video:', '').split(':');
    assert(Number(parts[2]) > 0, '录出来的视频是空文件：' + parts[2] + ' 字节');
    const state = expectOk(await cliJson(['video', 'status', '--session', sessionId]), 'video status');
    assert(state.completeness === 'complete', '正常录制不是 complete：' + JSON.stringify(state));
    assert(state.stop_reason === 'user' || state.stop_reason === 'duration', '正常录制 stop_reason 不对：' + JSON.stringify(state));
    assert(Array.isArray(state.fragments) && state.fragments.length >= 1, '正常录制没有分片日记：' + JSON.stringify(state.fragments));
    const fragmentBytes = state.fragments.reduce((sum, item) => sum + Number(item.bytes || 0), 0);
    assert(fragmentBytes > 0, '分片日记字节为 0：' + JSON.stringify(state.fragments));
    assert(state.fragments.every((item) => /^[0-9a-f]{64}$/.test(String(item.sha256 || ''))), '分片日记缺少 SHA-256：' + JSON.stringify(state.fragments));
    const listedAfterRecord = expectOk(await cliJson(['video', 'list', '--session', sessionId]), 'video list storage');
    const recorded = (listedAfterRecord.recordings || []).find((item) => item.id === String(state.recordingId || state.id));
    assert(recorded && typeof recorded.storage_persisted === 'boolean', '录制缺少 storage_persisted：' + JSON.stringify(recorded));
    assert(recorded.durability_policy === 'browser-readback' && recorded.fsync_supported === false, '录制 durability policy 不对：' + JSON.stringify({ policy: recorded.durability_policy, fsync: recorded.fsync_supported }));
    const verified = expectOk(await cliJson(['video', 'verify', String(state.recordingId || state.id), '--session', sessionId]), 'video verify');
    assert(verified.verified === true && verified.mismatches.length === 0, '分片校验失败：' + JSON.stringify(verified));
    assert(verified.container && verified.container.format === 'mp4', 'MP4 容器解析失败：' + JSON.stringify(verified.container));
    assert(typeof state.complete_frames === 'boolean', '录制缺少完帧标记：' + JSON.stringify(state));
    assert(['worker', 'main', 'encoder'].includes(state.finish_via), '录制缺少完帧重封装来源：' + JSON.stringify(state.finish_via));
    if (verified.container.fragmented) {
      assert(state.journal && Number(state.journal.fragments) >= 1, 'fMP4 缺少分片日记：' + JSON.stringify(state.journal));
      assert(state.journal.complete_bytes > 0, '分片日记缺少 complete_bytes：' + JSON.stringify(state.journal));
    }
    const savedPath = path.join(outDir, 'video-frames.mp4');
    const saved = expectOk(await cliJson(['video', 'save', String(state.recordingId || state.id), '--out', savedPath, '--overwrite', '--session', sessionId]), 'video save');
    const savedBuffer = readFileSync(savedPath);
    assert(saved.bytes > 0 && savedBuffer.length === saved.bytes, '视频保存失败：' + JSON.stringify(saved));
    const savedContainer = analyzeMp4(savedBuffer);
    assert(savedContainer.format === 'mp4', '保存文件不是 MP4：' + JSON.stringify(savedContainer));
    const trimPath = path.join(outDir, 'video-trim.mp4');
    const trimmed = expectOk(await cliJson(['video', 'trim', savedPath, '--out', trimPath, '--start', '0s', '--end', '5s', '--session', sessionId]), 'video trim');
    const trimBuffer = readFileSync(trimPath);
    assert(trimmed.packets >= 1 && trimBuffer.length > 0, '裁剪没有输出帧：' + JSON.stringify(trimmed));
    assert(trimBuffer.subarray(4, 8).toString() === 'ftyp', '裁剪输出不是 MP4：' + trimBuffer.subarray(0, 8).toString('hex'));
    const info = expectOk(await cliJson(['video', 'info', savedPath, '--session', sessionId]), 'video info');
    assert(info.codec && info.bytes > 0 && info.packets >= 1 && Number.isFinite(info.duration), 'video info 不完整：' + JSON.stringify(info));
    assert(Number.isInteger(info.width) && Number.isInteger(info.height), 'video info 缺少尺寸：' + JSON.stringify(info));
    const splitDir = path.join(outDir, 'video-split');
    const split = expectOk(await cliJson(['video', 'split', savedPath, '--out-dir', splitDir, '--parts', '2', '--session', sessionId]), 'video split');
    assert(split.count >= 1 && Array.isArray(split.outputs) && split.outputs.length === split.count, 'video split 输出不足：' + JSON.stringify(split));
    for (const part of split.outputs) {
      assert(existsSync(part.path), '分段文件不存在：' + part.path);
      const bytes = readFileSync(part.path);
      assert(bytes.subarray(4, 8).toString() === 'ftyp', '分段不是 MP4：' + part.path);
    }
    const mergedPath = path.join(outDir, 'video-merged.mp4');
    const merged = expectOk(await cliJson(['video', 'merge', savedPath, savedPath, '--out', mergedPath, '--session', sessionId]), 'video merge');
    assert(merged.packets >= 2 && Number.isInteger(merged.width) && Number.isInteger(merged.height) && existsSync(mergedPath) && readFileSync(mergedPath).subarray(4, 8).toString() === 'ftyp', '合并输出不完整：' + JSON.stringify(merged));
    const mcp = startMcp({ ...process.env, BB_HOME: bbHome, BB_PORT: String(port), BB_NO_PROBE: '1' });
    try {
      await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e' } });
      const mcpInfo = await mcp.rpc('tools/call', { name: 'browser_video_info', arguments: { input: savedPath } });
      assert(mcpInfo.result.isError === false && String(mcpInfo.result.content[0].text).includes('codec'), 'MCP video info 失败：' + String(mcpInfo.result.content[0].text).slice(0, 160));
      const mcpTrimPath = path.join(outDir, 'mcp-trim.mp4');
      const mcpTrim = await mcp.rpc('tools/call', { name: 'browser_video_trim', arguments: { input: savedPath, out: mcpTrimPath, start: '0s', end: '1s' } });
      assert(mcpTrim.result.isError === false && existsSync(mcpTrimPath) && readFileSync(mcpTrimPath).subarray(4, 8).toString() === 'ftyp', 'MCP video trim 失败');
      const mcpSplitDir = path.join(outDir, 'mcp-split');
      const mcpSplit = await mcp.rpc('tools/call', { name: 'browser_video_split', arguments: { input: savedPath, out_dir: mcpSplitDir, parts: 2 } });
      assert(mcpSplit.result.isError === false && existsSync(mcpSplitDir), 'MCP video split 失败');
      const mcpMergePath = path.join(outDir, 'mcp-merge.mp4');
      const mcpMerge = await mcp.rpc('tools/call', { name: 'browser_video_merge', arguments: { inputs: [savedPath, savedPath], out: mcpMergePath } });
      assert(mcpMerge.result.isError === false && existsSync(mcpMergePath) && readFileSync(mcpMergePath).subarray(4, 8).toString() === 'ftyp', 'MCP video merge 失败');
    } finally {
      mcp.close();
    }
    assert(state.faststart === true, '录制收尾没有 faststart 重封装：' + JSON.stringify({ faststart: state.faststart }));
    if (saved.faststart === true) {
      assert(savedContainer.hasMoov === true && savedContainer.hasMoof === false, 'faststart 文件不是 moov 前置：' + JSON.stringify(savedContainer.boxes));
      const moovAt = savedContainer.boxes.indexOf('moov');
      const mdatAt = savedContainer.boxes.indexOf('mdat');
      assert(moovAt >= 0 && mdatAt > moovAt, 'faststart 文件 moov 不在 mdat 前：' + JSON.stringify(savedContainer.boxes));
    } else {
      const expectedBytes = Number(state.bytes) + (state.indexed ? Number(state.sidx_bytes || 0) : 0);
      assert(saved.bytes === expectedBytes, '保存字节不一致：' + saved.bytes + ' != ' + expectedBytes + '（indexed=' + Boolean(state.indexed) + '）');
      if (state.indexed) {
        assert(Number(state.sidx_bytes) > 0 && savedContainer.hasSidx === true, '可 seek 索引缺失：' + JSON.stringify({ sidx: state.sidx_bytes, container: savedContainer.boxes }));
      }
    }
    return parts[1] + ' ' + parts[2] + ' 字节 completeness=' + state.completeness + ' fragmented=' + verified.container.fragmented + ' fmp4=' + Number((state.journal && state.journal.fragments) || 0) + ' saved=' + saved.bytes + ' sidx=' + (state.indexed ? state.sidx_bytes : 0) + (saved.faststart ? ' faststart=' + saved.bytes : '');
  });

  await check('35r. 视频完帧恢复：分片扫描 → 重建可播放文件', async () => {
    await cliJson(['session', 'resume', sessionId]).catch(() => {});
    const seeded = await openPageAndReadTitle('record', 'selftest=seed');
    await closePage(seeded.tabId);
    assert(/^SELFTEST:ok:seed:/.test(seeded.title), '生成恢复分片失败：' + JSON.stringify(seeded.title));
    const parts = seeded.title.replace('SELFTEST:ok:seed:', '').split(':');
    const recordingId = parts[0];
    const expectedBytes = Number(parts[1]);
    assert(recordingId && expectedBytes > 0, '分片元数据不完整：' + seeded.title);
    const recovered = expectOk(await cliJson(['video', 'recover', '--session', sessionId]), 'video recover');
    const recoveredId = recovered.id || recovered.recordingId;
    assert(recoveredId === recordingId, '恢复 id 不一致：' + JSON.stringify(recovered));
    assert(Number(recovered.bytes) === expectedBytes, '恢复字节数不一致：' + recovered.bytes + ' != ' + expectedBytes);
    assert(recovered.stop_reason === 'recovered', '恢复记录 stop_reason 不对：' + JSON.stringify(recovered));
    assert(recovered.completeness === 'partial', '恢复记录 completeness 不对：' + JSON.stringify(recovered));
    assert(Array.isArray(recovered.fragments) && recovered.fragments.length >= 1, '恢复记录没有分片日记：' + JSON.stringify(recovered.fragments));
    const fragmentBytes = recovered.fragments.reduce((sum, item) => sum + Number(item.bytes || 0), 0);
    assert(fragmentBytes === expectedBytes, '分片日记字节不一致：' + fragmentBytes + ' != ' + expectedBytes);
    const listed = expectOk(await cliJson(['video', 'list', '--session', sessionId]), 'video list recovered');
    assert((listed.recordings || []).some((item) => item.id === recoveredId && Number(item.bytes) === expectedBytes), 'video list 没有恢复记录：' + JSON.stringify(listed.recordings));
    const out = path.join(outDir, 'recovered.mp4');
    expectOk(await cliJson(['video', 'save', recoveredId, '--out', out, '--overwrite', '--session', sessionId]), 'video save recovered');
    const magic = readFileSync(out).subarray(0, 8);
    const isMp4 = magic.subarray(4, 8).toString() === 'ftyp';
    const isWebm = magic[0] === 0x1a && magic[1] === 0x45;
    assert(isMp4 || isWebm, '恢复文件不是可识别视频：' + magic.toString('hex'));
    const second = await cli(['video', 'recover', '--json']);
    assert(second.code !== 0, '分片恢复后再次 recover 不应成功');
    return 'recovered ' + recovered.bytes + 'B ' + (isMp4 ? 'mp4' : 'webm');
  });

  await check('35b. observe --vom 命中测试：遮挡 / pointer-events / 屏外', async () => {
    const vomUrl = pageUrl.replace(/test\.html.*$/, 'vom.html');
    // 前面的 UI/人工接管检查可能让会话处于暂停态；这里先恢复，避免级联 E_SESSION_PAUSED。
    await cliJson(['session', 'resume', sessionId]).catch(() => {});
    expectOk(await cliJson(['navigate', vomUrl, '--session', sessionId]), 'navigate vom');
    const res = expectOk(await cliJson(['observe', '--vom', '--session', sessionId]), 'observe vom');
    assert(res.stages && res.stages.visited >= 1 && Number.isInteger(res.stages.tokens), 'observe 缺少 VOM 阶段指标：' + JSON.stringify(res.stages));
    assert(Number.isInteger(res.stages.lineTokens) && Number.isInteger(res.stages.maxLineTokens), 'observe 缺少逐行 token 计量：' + JSON.stringify(res.stages));
    assert(res.stages.ms && Number.isFinite(res.stages.ms.visibility) && Number.isFinite(res.stages.ms.semantics), 'observe 缺少阶段耗时：' + JSON.stringify(res.stages.ms));
    assert(Array.isArray(res.refDetails) && res.refDetails.every((item) => typeof item.cdpSessionId === 'string' && item.cdpSessionId.endsWith(':0')), 'refDetails 缺少 cdpSessionId');
    const byId = (id) => (res.nodes || []).find((node) => node.id === id);
    const normal = byId('normal-btn');
    assert(normal, 'vom 里没有 normal-btn：' + JSON.stringify((res.nodes || []).map((node) => node.id)));
    assert(normal.clickable === true, '正常按钮应 clickable：' + JSON.stringify(normal));
    assert(normal.hitTest === 'self' || normal.hitTest === 'descendant', '正常按钮命中测试不对：' + JSON.stringify(normal.hitTest));

    const covered = byId('covered-btn');
    assert(covered, 'vom 里没有 covered-btn');
    assert(covered.clickable === false, '被遮挡按钮不应 clickable：' + JSON.stringify(covered));
    assert(covered.hitTest === 'blocked', '被遮挡按钮 hitTest 应为 blocked：' + JSON.stringify(covered.hitTest));
    assert(covered.occludedBy && covered.occludedBy.id === 'cover', 'occludedBy 应指向遮挡层：' + JSON.stringify(covered.occludedBy));

    const noPointer = byId('no-pointer');
    assert(noPointer, 'vom 里没有 no-pointer');
    assert(noPointer.clickable === false, 'pointer-events:none 不应 clickable：' + JSON.stringify(noPointer));
    assert(noPointer.hitTest === 'pointer-events-none', 'pointer-events:none hitTest 不对：' + JSON.stringify(noPointer.hitTest));

    const offscreen = byId('offscreen-btn');
    assert(offscreen, 'vom 里没有 offscreen-btn');
    assert(offscreen.hitTest === 'offscreen', '屏外按钮 hitTest 应为 offscreen：' + JSON.stringify(offscreen.hitTest));
    assert(offscreen.inViewport === false, '屏外按钮 inViewport 应为 false');

    const normalClick = expectOk(await cliJson(['click', '#normal-btn', '--trusted', '--session', sessionId]), 'trusted normal click');
    assert(normalClick.trusted === true, '正常按钮可信点击失败：' + JSON.stringify(normalClick));
    const blockedClick = await cliJson(['click', '#covered-btn', '--trusted', '--session', sessionId]);
    assert(
      blockedClick.json && blockedClick.json.error && blockedClick.json.error.code === 'E_OCCLUDED',
      '被遮挡按钮应返回 E_OCCLUDED：' + JSON.stringify(blockedClick.json),
    );
    assert(
      blockedClick.json.error.data && blockedClick.json.error.data.occludedBy && blockedClick.json.error.data.occludedBy.id === 'cover',
      'E_OCCLUDED 应带 occludedBy：' + JSON.stringify(blockedClick.json.error.data),
    );
    const forced = expectOk(await cliJson(['click', '#covered-btn', '--trusted', '--force', '--session', sessionId]), 'trusted forced click');
    assert(forced.trusted === true, '--force 应绕过遮挡校验：' + JSON.stringify(forced));
    return 'blocked=' + covered.ref + ' normal=' + normal.hitTest + ' offscreen=' + offscreen.hitTest;
  });

  await check('35c. VOM 对比度（含 oklch / color-mix）', async () => {
    const res = expectOk(await cliJson(['observe', '--vom', '--session', sessionId]), 'observe contrast');
    const byId = (id) => (res.nodes || []).find((node) => node.id === id);
    const good = byId('good-contrast');
    const bad = byId('bad-contrast');
    const oklch = byId('oklch-contrast');
    assert(good && good.contrast >= 20 && good.lowContrast === false, '高对比度节点不对：' + JSON.stringify(good));
    assert(bad && bad.contrast < 4.5 && bad.lowContrast === true, '低对比度节点不对：' + JSON.stringify(bad));
    assert(oklch && Number.isFinite(oklch.contrast) && oklch.contrast > 1, 'oklch/color-mix 未解析出对比度：' + JSON.stringify(oklch));
    return 'good=' + good.contrast + ' bad=' + bad.contrast + ' oklch=' + oklch.contrast;
  });

  await check('35f. VOM visualObjects：稳定身份 + 动作闭环', async () => {
    const visualUrl = new URL('visual.html', pageUrl).href;
    expectOk(await cliJson(['navigate', visualUrl, '--session', sessionId]), 'visual navigate');
    await sleep(400);
    const observed = expectOk(await cliJson(['observe', '--vom', '--session', sessionId]), 'observe visual');
    const objects = Array.isArray(observed.visualObjects) ? observed.visualObjects : [];
    assert(objects.length > 0, 'observe --vom 没有 visualObjects');
    assert(objects.some((item) => item.kind === 'region' && String(item.tag || '') === 'canvas'), 'visualObjects 没有 canvas region：' + JSON.stringify(objects.slice(0, 5)));
    const visualRef = objects.find((item) => item.kind === 'ref' && item.stableRef);
    assert(visualRef, 'visualObjects 的 ref 缺少 stableRef：' + JSON.stringify(objects.slice(0, 8)));
    const vomVisual = Array.isArray(observed.vom && observed.vom.visual) ? observed.vom.visual : [];
    assert(vomVisual.some((item) => item.stableRef), 'VOM visual 缺少 stableRef');
    const clicked = expectOk(await cliJson(['click', '--stable-ref', visualRef.stableRef, '--session', sessionId]), 'click visual stableRef');
    assert(clicked.effectState === 'committed', 'visual stableRef 点击未提交：' + JSON.stringify(clicked));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'visual restore');
    return 'objects=' + objects.length + ' visualRef=' + visualRef.ref + ' via=' + clicked.via;
  });

  await check('35g. paint-order 分层 + capture issues', async () => {
    const layersUrl = new URL('layers.html', pageUrl).href;
    expectOk(await cliJson(['navigate', layersUrl, '--session', sessionId]), 'layers navigate');
    await sleep(400);
    const observed = expectOk(await cliJson(['observe', '--vom', '--facts', '--ax', '--force', '--session', sessionId]), 'observe layers');
    const layers = Array.isArray(observed.layers) ? observed.layers : [];
    assert(layers.length >= 1, 'observe 没有 layers：' + JSON.stringify({ layers: observed.layers, issues: observed.issues }));
    const modal = layers.find((item) => item.kind === 'modal');
    const mask = layers.find((item) => item.kind === 'mask');
    assert(modal, 'layers 缺少 modal 带：' + JSON.stringify(layers));
    assert(mask, 'layers 缺少 mask 带：' + JSON.stringify(layers));
    assert(Number.isInteger(modal.paintOrder), 'modal 缺少 paintOrder：' + JSON.stringify(modal));
    assert(Number(modal.members) >= 1, 'modal 缺少 members：' + JSON.stringify(modal));
    assert(Array.isArray(observed.issues) && observed.issues.length === 0, '正常页面不应有 issues：' + JSON.stringify(observed.issues));
    assert(Array.isArray(observed.vom && observed.vom.issues) && observed.vom.issues.length === 0, 'vom.issues 不为空');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'layers restore');
    return 'layers=' + layers.length + ' modal=' + modal.coverage + ' mask=' + mask.coverage;
  });

  await check('35h. VOM 完整关系图：containment / ownership / roots', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'vom graph navigate');
    const observed = expectOk(await cliJson(['observe', '--vom', '--ax', '--facts', '--force', '--session', sessionId]), 'vom graph observe');
    const vom = observed.vom || {};
    const graph = vom.graph;
    assert(graph && graph.available === true, '缺少 vom.graph：' + JSON.stringify({ hasGraph: Boolean(graph), vomKeys: Object.keys(vom) }));
    assert(Array.isArray(graph.nodes) && graph.nodes.length > 10, 'graph.nodes 太少：' + JSON.stringify(graph.counts));
    assert(Array.isArray(graph.edges) && graph.edges.length > 5, 'graph.edges 太少：' + JSON.stringify(graph.counts));
    assert(Array.isArray(graph.roots) && graph.roots.length >= 1, '缺少 roots：' + JSON.stringify(graph.roots));
    const ids = new Set(graph.nodes.map((node) => node.id));
    for (const edge of graph.edges.slice(0, 200)) {
      assert(ids.has(edge.from) && ids.has(edge.to), '边端点必须落在 graph.nodes 里：' + JSON.stringify(edge));
    }
    for (const node of vom.nodes || []) {
      assert(typeof node.id === 'string' && node.id.length > 0, 'VOM 节点缺少 id：' + JSON.stringify(node.ref));
      for (const ancestorId of node.ancestorIds || []) {
        assert(ids.has(ancestorId), 'VOM 节点的祖先 id 不在图里：' + ancestorId);
      }
    }
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const nested = (vom.nodes || []).find((node) => Array.isArray(node.ancestorIds) && node.ancestorIds.length >= 2);
    assert(nested, '没有节点给出 ≥2 层祖先链');
    const chain = [];
    let current = byId.get(nested.id);
    let guard = 0;
    while (current && current.parentId && guard < 40) {
      chain.push(current.parentId);
      current = byId.get(current.parentId);
      guard += 1;
    }
    assert(chain.length === nested.ancestorIds.length, 'ancestorIds 与 parentId 链不一致：' + JSON.stringify({ chain, ancestorIds: nested.ancestorIds }));
    if (!graph.truncated) {
      assert(current && graph.roots.includes(current.id), '祖先链没有通到 roots：' + JSON.stringify({ tail: current && current.id, roots: graph.roots }));
    }
    const labelEdges = graph.edges.filter((edge) => edge.type === 'label');
    assert(labelEdges.length >= 1, '缺少 label 关系边：' + JSON.stringify(graph.counts.byType));
    const axEdges = graph.edges.filter((edge) => edge.type === 'ax');
    assert(axEdges.length >= 1, '缺少 AX 父子边：' + JSON.stringify(graph.counts.byType));
    assert(axEdges.every((edge) => ids.has(edge.from) && ids.has(edge.to)), 'AX 边端点必须落在 graph.nodes 里：' + JSON.stringify(axEdges.slice(0, 3)));
    assert(graph.nodes.some((node) => node.ax === true), '缺少 AX 上下文节点（ax:<nodeId>）');
    const child = (vom.edges || []).find((edge) => edge.type === 'child' && edge.child && edge.parent);
    assert(child, 'vom.edges 缺少兼容 child/parent：' + JSON.stringify((vom.edges || []).slice(0, 3)));
    assert(child.child === child.to && child.parent === child.from, '兼容字段与 from/to 不一致：' + JSON.stringify(child));
    return 'nodes=' + graph.counts.nodes + ' edges=' + graph.counts.edges + ' roots=' + graph.roots.length + ' label=' + labelEdges.length;
  });

  await check('35d. 动作前目标被替换：fail closed，不重放', async () => {
    const vomUrl = pageUrl.replace(/test\.html.*$/, 'vom.html');
    expectOk(await cliJson(['navigate', vomUrl, '--session', sessionId]), 'swap navigate');
    expectOk(await cliJson(['screenshot', '--out', path.join(ROOT, 'docs/assets/ui/breathing-glow-0.1.11.png'), '--session', sessionId]), 'breathing screenshot');
    const swapped = await cliJson(['click', '--synthetic', '#focus-swap', '--session', sessionId]);
    assert(swapped.code === 1 && swapped.json && swapped.json.error && swapped.json.error.code === 'E_NOT_ACTIONABLE', '替换目标应 fail closed：' + JSON.stringify(swapped.json));
    assert(swapped.json.error.data && swapped.json.error.data.receipt && swapped.json.error.data.receipt.effectState === 'unknown', '失败动作缺少 receipt：' + JSON.stringify(swapped.json.error.data));
    const counter = expectOk(await cliJson(['evaluate', 'String(window.__fswap)', '--session', sessionId]), 'swap counter');
    assert(counter.value === 'undefined', '替换目标不应被重放点击：' + JSON.stringify(counter.value));
    return 'E_NOT_ACTIONABLE, no replay';
  });

  await check('35e. click --text --trusted --follow 跟随新标签页', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'follow navigate');
    const clicked = expectOk(await cliJson([
      'click', '--text', '打开新标签页', '--trusted', '--follow', '--session', sessionId,
    ]), 'click text follow');
    assert(clicked.followed && String(clicked.followed.url).includes('frame.html'), '没有跟随新标签页：' + JSON.stringify(clicked));
    const current = expectOk(await cliJson(['evaluate', 'location.href', '--session', sessionId]), 'followed url');
    assert(String(current.value).includes('frame.html'), 'session 没有切到新标签页：' + JSON.stringify(current.value));
    return 'followed=' + clicked.followed.url;
  });

  await check('31c. 超长页面 capture：CDP 分块拼接', async () => {
    await assertSessionAlive('31c');
    const tallUrl = new URL('tall.html', pageUrl).href;
    expectOk(await cliJson(['navigate', tallUrl, '--session', sessionId]), 'tall navigate');
    await sleep(500);
    const out = path.join(outDir, 'tall.png');
    const shot = expectOk(await cliJson(['screenshot', '--full-page', '--timeout', '180000', '--out', out, '--session', sessionId]), 'tall screenshot');
    assert(Number(shot.height) >= 20000, '超长截图高度不足：' + JSON.stringify({ width: shot.width, height: shot.height, tiles: shot.tiled }));
    assert(Number(shot.tiled) >= 3, '超长截图没有走分块：' + JSON.stringify(shot.tiled));
    const png = readFileSync(out);
    assert(png.length > 5000, '超长截图文件太小：' + png.length);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert(width === shot.width && height === shot.height, 'PNG 尺寸与结果不一致：' + width + 'x' + height + ' vs ' + shot.width + 'x' + shot.height);
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'tall restore');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    return shot.width + 'x' + shot.height + ' tiles=' + shot.tiled;
  });

  await check('31d. 超宽页面 capture：横向分块拼接', async () => {
    await assertSessionAlive('31d');
    const wideUrl = new URL('wide.html', pageUrl).href;
    expectOk(await cliJson(['navigate', wideUrl, '--session', sessionId]), 'wide navigate');
    await sleep(500);
    const out = path.join(outDir, 'wide.png');
    const shot = expectOk(await cliJson(['screenshot', '--full-page', '--timeout', '180000', '--out', out, '--session', sessionId]), 'wide screenshot');
    assert(Number(shot.width) >= 16000, '超宽截图宽度不足：' + JSON.stringify({ width: shot.width, height: shot.height, tiles: shot.tiled }));
    assert(Number(shot.tiled) >= 2, '超宽截图没有横向分块：' + JSON.stringify(shot.tiled));
    const png = readFileSync(out);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert(width === shot.width && height === shot.height, 'PNG 尺寸与结果不一致：' + width + 'x' + height + ' vs ' + shot.width + 'x' + shot.height);
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'wide restore');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    return shot.width + 'x' + shot.height + ' tiles=' + shot.tiled;
  });

  await check('31e. 超大高度 capture：>30000px 分块', async () => {
    await assertSessionAlive('31e');
    const tallUrl = new URL('tall35.html', pageUrl).href;
    expectOk(await cliJson(['navigate', tallUrl, '--session', sessionId]), 'tall35 navigate');
    await sleep(500);
    const out = path.join(outDir, 'tall35.png');
    const shot = expectOk(await cliJson(['screenshot', '--full-page', '--timeout', '180000', '--out', out, '--session', sessionId]), 'tall35 screenshot');
    assert(Number(shot.height) >= 35000, '超大截图高度不足：' + JSON.stringify({ width: shot.width, height: shot.height, tiles: shot.tiled }));
    assert(Number(shot.tiled) >= 5, '超大截图分块不足：' + JSON.stringify(shot.tiled));
    const png = readFileSync(out);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert(width === shot.width && height === shot.height, 'PNG 尺寸与结果不一致：' + width + 'x' + height + ' vs ' + shot.width + 'x' + shot.height);
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'tall35 restore');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    return shot.width + 'x' + shot.height + ' tiles=' + shot.tiled;
  });

  await check('31e2. 超过单画布上限：分段 PNG 输出', async () => {
    await assertSessionAlive('31e2');
    const tallUrl = new URL('tall35.html', pageUrl).href;
    expectOk(await cliJson(['navigate', tallUrl, '--session', sessionId]), 'segmented navigate');
    await cliJson(['evaluate', "document.documentElement.style.height='45000px'; document.body.style.height='45000px'; window.scrollTo(0,0); 'ok'", '--session', sessionId]);
    await sleep(500);
    const out = path.join(outDir, 'segmented.png');
    const shot = expectOk(await cliJson(['screenshot', '--full-page', '--timeout', '240000', '--out', out, '--session', sessionId]), 'segmented screenshot');
    assert(shot.segmented === true && Number(shot.segment_count) >= 2, '没有分段输出：' + JSON.stringify({ segmented: shot.segmented, count: shot.segment_count, height: shot.height }));
    assert(Number(shot.height) >= 45000, '分段总高度不足：' + shot.height);
    assert(Array.isArray(shot.segments) && shot.segments.length === shot.segment_count, 'segments 元数据不完整');
    for (const part of shot.segments) assert(existsSync(part.path), '分段文件不存在：' + part.path);
    const first = readFileSync(out);
    assert(first.subarray(1, 4).toString() === 'PNG', '第一段不是 PNG');
    const firstHeight = first.readUInt32BE(20);
    assert(firstHeight > 0 && firstHeight <= 40000, '第一段高度异常：' + firstHeight);
    const second = readFileSync(shot.segments[1].path);
    assert(second.subarray(1, 4).toString() === 'PNG', '第二段不是 PNG');
    return 'segments=' + shot.segment_count + ' first=' + firstHeight + ' total=' + shot.height;
  });

  await check('31f. 固定页脚重绘：final footer overlay', async () => {
    await assertSessionAlive('31f');
    const footerUrl = new URL('footer.html', pageUrl).href;
    expectOk(await cliJson(['navigate', footerUrl, '--session', sessionId]), 'footer navigate');
    await sleep(500);
    const out = path.join(outDir, 'footer.png');
    const shot = expectOk(await cliJson(['screenshot', '--full-page', '--tile-size', '512', '--timeout', '180000', '--out', out, '--session', sessionId]), 'footer screenshot');
    assert(shot.tile_size === 512, '--tile-size 没有生效：' + JSON.stringify(shot.tile_size));
    assert(Number(shot.height) >= 15000, '页脚页截图高度不足：' + JSON.stringify({ width: shot.width, height: shot.height, tiled: shot.tiled }));
    assert(Number(shot.fixedFooter) >= 60, '没有识别/重绘固定页脚：' + JSON.stringify(shot.fixedFooter));
    assert(Number(shot.fixedTop) >= 40, '没有识别/重绘固定顶栏：' + JSON.stringify(shot.fixedTop));
    assert(Number(shot.fixedBands) >= 2, '没有记录多段固定带：' + JSON.stringify(shot.fixedBands));
    assert(shot.stale !== true, '稳定页面不应标记 stale：' + JSON.stringify(shot.stale));
    assert(Number(shot.tiles_persisted) >= 1 && typeof shot.longshot_id === 'string', '长截图没有落盘 tile：' + JSON.stringify({ tiles: shot.tiles_persisted, id: shot.longshot_id }));
    const recoveredPath = path.join(outDir, 'footer-recovered.png');
    const recovered = expectOk(await cliJson(['longshot', 'recover', shot.longshot_id, '--out', recoveredPath, '--session', sessionId]), 'longshot recover');
    assert(recovered.width === shot.width && recovered.height === shot.height && existsSync(recoveredPath), '长截图恢复尺寸不对：' + JSON.stringify(recovered));
    const mcp = startMcp({ ...process.env, BB_HOME: bbHome, BB_PORT: String(port), BB_NO_PROBE: '1' });
    try {
      await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e' } });
      const mcpShot = path.join(outDir, 'mcp-longshot.png');
      const mcpResult = await mcp.rpc('tools/call', { name: 'browser_longshot_recover', arguments: { longshot_id: shot.longshot_id, out: mcpShot, session: sessionId } });
      assert(mcpResult.result.isError === false, 'MCP longshot recover 失败：' + String(mcpResult.result.content[0].text).slice(0, 160));
      assert(existsSync(mcpShot) && readFileSync(mcpShot).subarray(1, 4).toString() === 'PNG', 'MCP 长截图没有落盘');
    } finally {
      mcp.close();
    }
    const png = readFileSync(out);
    assert(png.readUInt32BE(20) === shot.height, 'PNG 高度不一致');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'footer restore');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    return shot.width + 'x' + shot.height + ' footer=' + shot.fixedFooter + ' header=' + shot.fixedTop + ' dpr=' + shot.dpr;
  });

  await check('31h3. stale 页面：重复变化触发 stale 补拍', async () => {
    await assertSessionAlive('31h3');
    const staleUrl = new URL('stale.html', pageUrl).href;
    expectOk(await cliJson(['navigate', staleUrl, '--session', sessionId]), 'stale navigate');
    await sleep(300);
    const out = path.join(outDir, 'stale.png');
    const shot = expectOk(await cliJson(['screenshot', '--full-page', '--tile-size', '1024', '--stale-attempts', '2', '--timeout', '180000', '--out', out, '--session', sessionId]), 'stale screenshot');
    assert(shot.stale === true, '持续变化页面没有标记 stale：' + JSON.stringify({ stale: shot.stale, attempts: shot.stale_attempts }));
    assert(Number(shot.stale_repairs) >= 1 || Number(shot.stale_attempts) >= 2, 'stale 没有触发补拍/重拍：' + JSON.stringify({ repairs: shot.stale_repairs, attempts: shot.stale_attempts }));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'stale restore');
    return 'stale attempts=' + shot.stale_attempts;
  });

  await check('31f2. 长截图分数 DPR（1.5）与固定顶栏/页脚', async () => {
    await assertSessionAlive('31f2');
    const footerUrl = new URL('footer.html', pageUrl).href;
    expectOk(await cliJson(['emulate', '--width', '1241', '--height', '800', '--dpr', '1.5', '--session', sessionId]), 'emulate dpr');
    expectOk(await cliJson(['navigate', footerUrl, '--session', sessionId]), 'dpr footer navigate');
    await sleep(500);
    const out = path.join(outDir, 'footer-dpr15.png');
    const shot = expectOk(await cliJson(['screenshot', '--full-page', '--timeout', '180000', '--out', out, '--session', sessionId]), 'dpr footer screenshot');
    assert(Number(shot.dpr) === 1.5, '截图没有使用分数 DPR：' + JSON.stringify({ dpr: shot.dpr }));
    // 模拟视口含滚动条时 CSS 内容宽会少 ~15px；只约束“确实按 1.5 倍放大”的区间。
    assert(Number(shot.width) >= Math.round(1226 * 1.5) - 3 && Number(shot.width) <= Math.round(1241 * 1.5) + 3, '宽度没有按 1.5 DPR 放大：' + shot.width);
    assert(Math.abs(Number(shot.height) - Math.round(15000 * 1.5)) <= 5, '高度没有按 1.5 DPR 放大：' + shot.height);
    assert(Number(shot.fixedTop) >= Math.round(56 * 1.5) - 2, '固定顶栏没有按 DPR 重绘：' + shot.fixedTop);
    assert(Number(shot.fixedFooter) >= Math.round(80 * 1.5) - 2, '固定页脚没有按 DPR 重绘：' + shot.fixedFooter);
    const png = readFileSync(out);
    assert(png.readUInt32BE(16) === shot.width && png.readUInt32BE(20) === shot.height, 'DPR 截图 PNG 尺寸不一致');
    expectOk(await cliJson(['emulate', '--reset', '--session', sessionId]), 'emulate reset');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'dpr footer restore');
    expectOk(await cliJson(['wait-ms', '800', '--session', sessionId]), 'restore wait');
    return shot.width + 'x' + shot.height + ' dpr=' + shot.dpr + ' header=' + shot.fixedTop + ' footer=' + shot.fixedFooter;
  });

  await check('31g. 截图差分：YIQ changed pixels', async () => {
    await assertSessionAlive('31g');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'diff navigate');
    await sleep(300);
    const first = expectOk(await cliJson(['screenshot', '--out', path.join(outDir, 'diff-a.png'), '--session', sessionId]), 'diff screenshot 1');
    assert(Number(first.height) > 0, '基线截图失败');
    const same = expectOk(await cliJson(['screenshot', '--diff', '--out', path.join(outDir, 'diff-a2.png'), '--session', sessionId]), 'diff screenshot 1b');
    assert(same.diff && same.diff.sizeMatch === true, '同页差分尺寸不匹配：' + JSON.stringify(same.diff));
    expectOk(await cliJson(['evaluate', "document.body.style.background='#ff0000'; 'ok'", '--session', sessionId]), 'diff mutate');
    await sleep(300);
    const second = expectOk(await cliJson(['screenshot', '--diff', '--out', path.join(outDir, 'diff-b.png'), '--session', sessionId]), 'diff screenshot 2');
    assert(second.diff && second.diff.sizeMatch === true, '差分尺寸不匹配：' + JSON.stringify(second.diff));
    assert(Number(second.diff.changed) > 0, '差分没有检测到变化：' + JSON.stringify(second.diff));
    assert(Number(second.diff.ratio) > 0, '差分 ratio 为 0：' + JSON.stringify(second.diff));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'diff restore');
    return 'changed=' + second.diff.changed + ' ratio=' + second.diff.ratio;
  });

  await check('31h. 大截图流式读（--stream + screenshot.read/release）', async () => {
    await assertSessionAlive('31h');
    const tallUrl = new URL('tall.html', pageUrl).href;
    expectOk(await cliJson(['navigate', tallUrl, '--session', sessionId]), 'stream navigate');
    await sleep(400);
    const out = path.join(outDir, 'tall-stream.png');
    const streamed = expectOk(await cliJson(['screenshot', '--out', out, '--full', '--stream', '--session', sessionId]), 'stream screenshot');
    assert(streamed.streamed === true, '截图没有走流式：' + JSON.stringify(streamed));
    const buffer = readFileSync(out);
    assert(buffer.length > 10000, '流式截图文件太小：' + buffer.length);
    assert(buffer.length === Number(streamed.bytes), '流式字节数与落盘不一致：' + JSON.stringify({ bytes: streamed.bytes, file: buffer.length }));
    assert(buffer.subarray(1, 4).toString('latin1') === 'PNG', '流式截图不是 PNG');
    const inlineOut = path.join(outDir, 'tall-inline.png');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'inline navigate');
    await sleep(300);
    const inline = expectOk(await cliJson(['screenshot', '--out', inlineOut, '--session', sessionId]), 'inline screenshot');
    assert(inline.streamed !== true, '默认截图不应流式：' + JSON.stringify(inline));
    assert(readFileSync(inlineOut).subarray(1, 4).toString('latin1') === 'PNG', '默认截图不是 PNG');
    return 'streamed=' + buffer.length + 'B height=' + (streamed.height || '?');
  });

  // ---------------------------------------------------------------- 第十二批 A：深层子系统扩围
  // 全部走真实 CLI/daemon/Edge：network/debug replay、status 兼容证据、daemon batch/lease、
  // status --views、HAR 自检、video 持久化、longshot 分片恢复。扩展未产出的加法字段
  // 在断言里按“有证据就必须一致”处理，保证 JS 基线（含 replay/persist/shard 接线）全量校验。
  const batchItems = JSON.stringify([
    { url: pageUrl, key: 'e2e-batch-a', label: 'batch A' },
    { url: pageUrl, key: 'e2e-batch-b', label: 'batch B' },
  ]);

  await check('38. network replay 确定性：真实重放两次 + replay 证据', async () => {
    await assertSessionAlive('38');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'replay navigate');
    expectOk(await cliJson(['network', 'start', '--session', sessionId]), 'replay network start');
    try {
      expectOk(await cliJson([
        'evaluate',
        "window.__bbReplayHit = null; fetch('/api/replay-count').then((r) => r.json()).then((j) => { window.__bbReplayHit = j; }); 'started'",
        '--session', sessionId,
      ]), 'replay-count fetch');
      let hitValue = '';
      for (let attempt = 0; attempt < 30 && !hitValue; attempt += 1) {
        await sleep(100);
        const probe = await cliJson(['evaluate', "window.__bbReplayHit ? JSON.stringify(window.__bbReplayHit) : ''", '--session', sessionId]);
        const value = String((probe.json && probe.json.ok && probe.json.result && probe.json.result.value) || '');
        if (value.includes('"hit"')) hitValue = value;
      }
      assert(hitValue.includes('"hit"'), '页面内 /api/replay-count 没有返回计数：' + JSON.stringify(hitValue));
      await sleep(600);
      const listed = expectOk(await cliJson(['network', 'list', '--filter', '/api/replay-count', '--session', sessionId]), 'replay list');
      const entry = (listed.entries || []).find((item) => String(item.url || '').includes('/api/replay-count')) || (listed.entries || [])[0];
      assert(entry && Number.isInteger(Number(entry.id)), '没有抓到 /api/replay-count 请求：' + JSON.stringify(listed).slice(0, 300));
      const first = expectOk(await cliJson(['network', 'replay', String(entry.id), '--session', sessionId]), 'replay #1');
      const second = expectOk(await cliJson(['network', 'replay', String(entry.id), '--session', sessionId]), 'replay #2');
      assert(Number(first.status) === 200 && Number(second.status) === 200, '重放没有返回 200：' + JSON.stringify({ first: first.status, second: second.status }));
      let firstBody = null;
      let secondBody = null;
      try {
        firstBody = JSON.parse(String(first.body || ''));
        secondBody = JSON.parse(String(second.body || ''));
      } catch { /* 下面的断言会给出原文 */ }
      assert(firstBody && Number.isInteger(firstBody.hit), '第一次重放响应不是计数 JSON：' + JSON.stringify(String(first.body || '').slice(0, 200)));
      assert(secondBody && secondBody.hit === firstBody.hit + 1, '两次重放没有真实执行（服务端计数不递增）：' + JSON.stringify({ first: firstBody, second: secondBody }));
      const stillThere = expectOk(await cliJson(['evaluate', 'location.pathname', '--session', sessionId]), 'replay location');
      assert(stillThere.value === '/test.html', '重放导致页面导航（页面副作用不可复现）：' + JSON.stringify(stillThere.value));
      const evidence = [];
      if (first.replay || second.replay) {
        assert(first.replay && second.replay, '两次重放只有一次带 replay 字段：' + JSON.stringify({ first: Boolean(first.replay), second: Boolean(second.replay) }));
        for (const [index, replay] of [first.replay, second.replay].entries()) {
          assert(replay.ok === true, 'replay#' + (index + 1) + ' 计划不 ok：' + JSON.stringify(replay.blockers || replay));
          assert(Number.isInteger(replay.version), 'replay#' + (index + 1) + ' 缺少版本：' + JSON.stringify(replay.version));
          assert(typeof replay.token === 'string' && replay.token.length > 0, 'replay#' + (index + 1) + ' 缺少幂等 token');
          assert(/^[0-9a-f]{8,}$/.test(String(replay.fingerprint || '')), 'replay#' + (index + 1) + ' fingerprint 不合法：' + JSON.stringify(replay.fingerprint));
          assert(replay.deterministic === true && replay.executed === true, 'replay#' + (index + 1) + ' 缺少确定性/已执行标记：' + JSON.stringify({ deterministic: replay.deterministic, executed: replay.executed }));
          assert(Number(replay.steps) >= 1, 'replay#' + (index + 1) + ' steps 为空：' + JSON.stringify(replay.steps));
          assert(replay.network && replay.network.sideEffect === true, 'replay#' + (index + 1) + ' 缺少 network 副作用证据：' + JSON.stringify(replay.network));
        }
        assert(first.replay.token === second.replay.token, '同一请求两次重放的 token 不一致：' + JSON.stringify({ first: first.replay.token, second: second.replay.token }));
        assert(first.replay.fingerprint === second.replay.fingerprint, '同一请求两次重放的 fingerprint 不一致：' + JSON.stringify({ first: first.replay.fingerprint, second: second.replay.fingerprint }));
        evidence.push('token=' + String(first.replay.token).slice(0, 16) + ' fp=' + first.replay.fingerprint);
      }
      return 'hit=' + firstBody.hit + '→' + secondBody.hit + ' ' + (evidence.join(' ') || 'replay 字段未接线');
    } finally {
      await cliJson(['network', 'stop', '--session', sessionId]);
    }
  });

  await check('38b. debug replay CLI：debug start → replay → stop', async () => {
    await assertSessionAlive('38b');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'debug replay navigate');
    expectOk(await cliJson(['network', 'start', '--session', sessionId]), 'debug replay network start');
    try {
      expectOk(await cliJson(['debug', 'start', '--name', 'e2e-deep-replay', '--bodies', '--session', sessionId]), 'debug replay start');
      expectOk(await cliJson(['click', '#ping-btn', '--session', sessionId]), 'debug replay click');
      await sleep(900);
      const listed = expectOk(await cliJson(['network', 'list', '--filter', '/api/ping', '--session', sessionId]), 'debug replay requests');
      const entry = (listed.entries || [])[0];
      assert(entry && Number.isInteger(Number(entry.id)), 'debug 采集没有 /api/ping：' + JSON.stringify(listed).slice(0, 300));
      const first = expectOk(await cliJson(['debug', 'replay', String(entry.id), '--session', sessionId]), 'debug replay #1');
      const second = expectOk(await cliJson(['debug', 'replay', String(entry.id), '--session', sessionId]), 'debug replay #2');
      assert(Number(first.status) === 200 && Number(second.status) === 200, 'debug replay 没有返回 200：' + JSON.stringify({ first: first.status, second: second.status }));
      assert(String(first.body || '').includes('ok'), 'debug replay 响应里没有 ok：' + String(first.body || '').slice(0, 160));
      const tokens = [];
      for (const [index, replay] of [first.replay, second.replay].entries()) {
        if (!replay) continue;
        assert(replay.ok === true && replay.executed === true && replay.deterministic === true, 'debug replay#' + (index + 1) + ' 证据不完整：' + JSON.stringify({ ok: replay.ok, executed: replay.executed, deterministic: replay.deterministic }));
        assert(typeof replay.token === 'string' && replay.token.length > 0, 'debug replay#' + (index + 1) + ' 缺少 token');
        tokens.push(replay.token);
      }
      if (tokens.length === 2) assert(tokens[0] === tokens[1], 'debug replay 两次 token 不一致：' + JSON.stringify(tokens));
      return 'HTTP ' + first.status + (tokens.length ? ' token=' + tokens[0].slice(0, 16) : ' replay 字段未接线');
    } finally {
      await cliJson(['debug', 'stop', '--session', sessionId]);
      await cliJson(['network', 'stop', '--session', sessionId]);
    }
  });

  await check('38c. status 兼容证据：obligations + upgradePlan 真实载荷', async () => {
    await assertSessionAlive('38c');
    const st = expectOk(await cliJson(['status']), 'compat status');
    const compat = st.compatibility;
    assert(compat && compat.daemon && compat.daemon.features, 'status 缺少 compatibility.daemon.features：' + JSON.stringify(Object.keys(st)));
    const feature = compat.daemon.features.video;
    assert(feature && feature.available === true, 'daemon 的 video 特性不可用：' + JSON.stringify(feature && feature.available));
    const obligations = feature.obligations;
    assert(obligations && obligations.feature === 'video', 'video 缺少 obligations：' + JSON.stringify(obligations));
    assert(obligations.counts && Number(obligations.counts.obligations) >= 60, 'video obligations 计数不足：' + JSON.stringify(obligations.counts));
    assert(Number(obligations.methodCount) === 9, 'video obligations 方法数不对：' + JSON.stringify(obligations.methodCount));
    assert(obligations.risks && Number.isInteger(Number(obligations.risks.safe) + Number(obligations.risks.guarded) + Number(obligations.risks.risky)), 'video obligations 缺少风险画像：' + JSON.stringify(obligations.risks));
    assert(obligations.profiles && Object.keys(obligations.profiles).length >= 1, 'video obligations 缺少 profile：' + JSON.stringify(obligations.profiles));
    assert(feature.support && feature.support.monotone === true && feature.support.currentAllowed === true, 'video 缺少支持画像：' + JSON.stringify(feature.support));
    const browserRow = (compat.browsers || [])[0];
    assert(browserRow, 'status.compatibility.browsers 为空');
    assert(/^\d+\.\d+$/.test(String(browserRow.protocol)), '浏览器协议版本格式不对：' + JSON.stringify(browserRow.protocol));
    const harFeature = browserRow.features && browserRow.features.har;
    assert(harFeature && harFeature.obligations && Number(harFeature.obligations.counts.obligations) === 7, '浏览器 har 特性 obligations 不对：' + JSON.stringify(harFeature && harFeature.obligations && harFeature.obligations.counts));
    const report = compatibilityReport({ protocol: String(browserRow.protocol) });
    assert(report.obligations && Object.keys(report.obligations.features || {}).length === 15, 'compatibilityReport obligations 特性数不对：' + JSON.stringify(Object.keys((report.obligations && report.obligations.features) || {})));
    assert(Object.keys((report.obligations && report.obligations.dimensions) || {}).length >= 3 && Object.keys((report.obligations && report.obligations.risks) || {}).length >= 3, 'compatibilityReport obligations 维度/风险聚合不完整');
    const upgradePlan = report.upgradePlan || {};
    assert(upgradePlan.from === String(browserRow.protocol) && upgradePlan.to === report.current, 'upgradePlan 起止版本不对：' + JSON.stringify({ from: upgradePlan.from, to: upgradePlan.to }));
    assert(upgradePlan.verdict === 'compatible' && upgradePlan.feasible === true && upgradePlan.upgradeRequired === false, 'upgradePlan 对同版本对端判定不对：' + JSON.stringify({ verdict: upgradePlan.verdict, feasible: upgradePlan.feasible }));
    assert(/^[0-9a-f]{8}$/.test(String(upgradePlan.fingerprint || '')), 'upgradePlan 缺少稳定 fingerprint：' + JSON.stringify(upgradePlan.fingerprint));
    assert(Array.isArray(upgradePlan.batches) && upgradePlan.batches.length >= 3 && upgradePlan.batches.every((batch) => batch.phase && Array.isArray(batch.steps)), 'upgradePlan batches 不完整：' + JSON.stringify(upgradePlan.batches));
    const legacy = compatibilityReport({ protocol: '1.8' });
    const legacyPlan = legacy.upgradePlan || {};
    assert(legacyPlan.from === '1.8' && legacyPlan.to === '1.9' && legacyPlan.verdict === 'upgrade-required' && legacyPlan.feasible === true, '1.8→1.9 升级计划判定不对：' + JSON.stringify({ verdict: legacyPlan.verdict, feasible: legacyPlan.feasible }));
    assert(legacyPlan.upgradeRequired === true && legacyPlan.requiredVersion === '1.9', '1.8 升级计划缺少必须升级标记：' + JSON.stringify({ upgradeRequired: legacyPlan.upgradeRequired, requiredVersion: legacyPlan.requiredVersion }));
    assert(Array.isArray(legacyPlan.gainedFeatures) && legacyPlan.gainedFeatures.length === 15, '1.8 升级计划获得特性数不对：' + JSON.stringify(legacyPlan.gainedFeatures));
    assert(Array.isArray(legacyPlan.batches) && legacyPlan.batches.length >= 3, '1.8 升级计划缺少执行批次：' + JSON.stringify(legacyPlan.batches && legacyPlan.batches.length));
    return 'obligations=' + obligations.counts.obligations + ' fp=' + upgradePlan.fingerprint + ' legacy=' + legacyPlan.verdict;
  });

  await check('38e. daemon batch plan：配额准入 dry-run + strict schema', async () => {
    const planned = expectOk(await cliJson(['daemon', 'batch', 'plan', '--items', batchItems, '--strict']), 'batch plan');
    assert(planned.kind === 'bridge/session-batch-plan' && planned.dryRun === true, 'batch plan 形状不对：' + JSON.stringify({ kind: planned.kind, dryRun: planned.dryRun }));
    assert(planned.schema === 1, 'batch plan schema 版本不对：' + JSON.stringify(planned.schema));
    assert(Number(planned.summary && planned.summary.total) === 2, 'batch plan 条目数不对：' + JSON.stringify(planned.summary));
    assert(Number(planned.summary && planned.summary.admissable) >= 2, '配额没有准入 2 个条目：' + JSON.stringify(planned.summary));
    const items = planned.items || [];
    assert(items.length === 2 && items.every((item) => item.admission === 'admit'), 'batch plan 条目未全部准入：' + JSON.stringify(items.map((item) => ({ key: item.key, admission: item.admission, reason: item.reason }))));
    assert(planned.quota && planned.quota.policy && Number(planned.quota.policy.maxSessions) >= 2, 'batch plan 缺少配额策略：' + JSON.stringify(planned.quota && planned.quota.policy));
    assert(planned.quota.decisions && planned.quota.decisions[0] && Number(planned.quota.decisions[0].granted) === 2, 'batch plan 缺少配额决策证据：' + JSON.stringify(planned.quota && planned.quota.decisions));
    return 'admit=' + items.length + ' maxSessions=' + planned.quota.policy.maxSessions;
  });

  await check('38f. daemon batch start/status：真建 2 会话 + 导航 + 幂等', async () => {
    await assertSessionAlive('38f');
    const started = expectOk(await cliJson(['daemon', 'batch', 'start', '--items', batchItems, '--batch-id', 'e2e-batch-38', '--on-error', 'continue', '--concurrency', '2']), 'batch start');
    assert(started.batchId === 'e2e-batch-38' && started.state === 'completed', 'batch start 未完成：' + JSON.stringify({ batchId: started.batchId, state: started.state, warnings: started.warnings }));
    assert(started.kind === 'bridge/session-batch', 'batch start kind 不对：' + JSON.stringify(started.kind));
    assert(Number(started.summary && started.summary.succeeded) === 2 && Number(started.summary.failed) === 0, 'batch start 成功数不对：' + JSON.stringify(started.summary));
    const created = (started.items || []).map((item) => ({ index: item.index, sessionId: item.sessionId, navigated: item.navigated, state: item.state }));
    const batchSessionIds = created.map((item) => item.sessionId);
    assert(created.length === 2 && created.every((item) => /^[a-z]{4}$/.test(String(item.sessionId))), 'batch start 没有真建 2 个会话：' + JSON.stringify(created));
    assert(created.every((item) => item.state === 'succeeded' && item.navigated === true), 'batch start 条目没有导航成功：' + JSON.stringify(created));
    const status = expectOk(await cliJson(['daemon', 'batch', 'status', 'e2e-batch-38']), 'batch status');
    assert(status.batchId === 'e2e-batch-38' && status.state === 'completed', 'batch status 不对：' + JSON.stringify({ batchId: status.batchId, state: status.state }));
    assert(JSON.stringify((status.items || []).map((item) => item.sessionId)) === JSON.stringify(batchSessionIds), 'batch status 的会话 id 与 start 不一致：' + JSON.stringify({ start: batchSessionIds, status: (status.items || []).map((item) => item.sessionId) }));
    const snapshot = expectOk(await cliJson(['status', '--views', 'batch']), 'status --views batch');
    assert(Array.isArray(snapshot.views) && snapshot.views.includes('batch'), 'status --views batch 没有回显视图：' + JSON.stringify(snapshot.views));
    assert(snapshot.batch && Array.isArray(snapshot.batch.recent) && snapshot.batch.recent.some((item) => item.batchId === 'e2e-batch-38'), 'status --views batch 没有最近批次：' + JSON.stringify(snapshot.batch && snapshot.batch.recent));
    const again = expectOk(await cliJson(['daemon', 'batch', 'start', '--items', batchItems, '--batch-id', 'e2e-batch-38']), 'batch start idempotent');
    assert(again.reused === true && again.state === 'completed' && again.note === 'batch-already-finished', '同一 batchId 重启不幂等：' + JSON.stringify({ reused: again.reused, state: again.state, note: again.note }));
    const before = expectOk(await cliJson(['status']), 'status before batch stop');
    assert((before.sessions || []).length >= 3, 'batch 会话没有出现在 status.sessions：' + JSON.stringify((before.sessions || []).map((item) => item.sessionId)));
    for (const id of batchSessionIds) expectOk(await cliJson(['session', 'stop', String(id)]), 'batch stop ' + id);
    const after = expectOk(await cliJson(['status']), 'status after batch stop');
    assert(!(after.sessions || []).some((item) => batchSessionIds.includes(item.sessionId)), 'batch 会话没有停止：' + JSON.stringify((after.sessions || []).map((item) => item.sessionId)));
    const cancelled = expectOk(await cliJson(['daemon', 'batch', 'cancel', 'e2e-batch-38']), 'batch cancel finished');
    assert(cancelled.cancelled === false && cancelled.state === 'completed', '已完成的批次 cancel 语义不对：' + JSON.stringify(cancelled));
    return 'sessions=' + batchSessionIds.join(',') + ' succeeded=2';
  });

  await check('38g. daemon lease report/arbitrate：dry-run 与 apply 护栏', async () => {
    await assertSessionAlive('38g');
    const report = expectOk(await cliJson(['daemon', 'lease', 'report', '--include-clean', '--strict']), 'lease report');
    assert(report.kind === 'bridge/lease-arbitration' && report.mode === 'plan', 'lease report 形状不对：' + JSON.stringify({ kind: report.kind, mode: report.mode }));
    assert(report.summary && Number(report.summary.sessions) >= 1, 'lease report 没有看到活动会话：' + JSON.stringify(report.summary));
    assert(Number(report.summary.tabs) >= 1, 'lease report 没有看到 tab：' + JSON.stringify(report.summary));
    assert(Array.isArray(report.verdicts) && Array.isArray(report.steps), 'lease report 缺少 verdicts/steps');
    for (const verdict of report.verdicts.slice(0, 5)) {
      assert(Number.isInteger(Number(verdict.tabId)) && typeof verdict.action === 'string' && Array.isArray(verdict.conflictCodes), 'lease verdict 字段不完整：' + JSON.stringify(verdict));
    }
    const plan = expectOk(await cliJson(['daemon', 'lease', 'arbitrate', '--strategy', 'lru', '--limit', '5']), 'lease arbitrate');
    assert(plan.mode === 'plan' && plan.applied === null && plan.residual === null && plan.appliedAt === 0, 'dry-run 不应执行任何裁决步骤：' + JSON.stringify({ mode: plan.mode, applied: plan.applied, residual: plan.residual, appliedAt: plan.appliedAt }));
    assert(plan.policy && plan.policy.strategy === 'lru' && Number(plan.policy.limit) === 5, 'arbitrate 策略/上限参数没有生效：' + JSON.stringify(plan.policy));
    assert(plan.summary && Number.isInteger(Number(plan.summary.steps)) && Number.isInteger(Number(plan.summary.verdicts)), 'arbitrate summary 不完整：' + JSON.stringify(plan.summary));
    assert(Array.isArray(plan.steps), 'arbitrate steps 不是数组');
    const denied = await cliJson(['daemon', 'lease', 'arbitrate', '--apply']);
    assert(denied.code === 2 && denied.json && denied.json.ok === false && denied.json.error && denied.json.error.code === 'E_ARG_USAGE', '--apply 未带 --yes 应本地拒绝（退出码 2）：' + JSON.stringify({ code: denied.code, error: denied.json && denied.json.error }));
    return 'sessions=' + report.summary.sessions + ' strategy=' + plan.policy.strategy + ' apply-guard=exit2';
  });

  await check('38h. status --views queues：队列诊断 + 默认载荷兼容', async () => {
    await assertSessionAlive('38h');
    const base = expectOk(await cliJson(['status']), 'status base');
    assert(base.views === undefined, '默认 status 不应回显 views（0.3.0 载荷兼容）：' + JSON.stringify(base.views));
    assert(Array.isArray(base.queues), '默认 status 缺少 0.3.0 queues 字段');
    const view = expectOk(await cliJson(['status', '--views', 'queues', '--limit', '10']), 'status --views queues');
    assert(Array.isArray(view.views) && view.views.length === 1 && view.views[0] === 'queues', 'views 回显不对：' + JSON.stringify(view.views));
    const queue = view.queue;
    assert(queue && Number(queue.capacity) > 0, 'queue 视图缺少容量：' + JSON.stringify(queue && queue.capacity));
    assert(queue.limits && Number(queue.limits.maxInflightPerSession) >= 1, 'queue 视图缺少会话并发上限：' + JSON.stringify(queue && queue.limits));
    assert(queue.inflight && Number.isInteger(Number(queue.inflight.current)) && Number(queue.inflight.limit) > 0, 'queue inflight 证据不完整：' + JSON.stringify(queue && queue.inflight));
    assert(queue.fairness && queue.fairness.strategy === 'round-robin-per-tab', 'queue 公平策略缺失：' + JSON.stringify(queue && queue.fairness && queue.fairness.strategy));
    assert(Array.isArray(queue.sessions), 'queue.sessions 不是数组');
    const mine = queue.sessions.find((item) => item.sessionId === sessionId);
    assert(mine, 'queue 视图没有当前会话：' + JSON.stringify(queue.sessions.map((item) => item.sessionId)));
    assert(Number.isInteger(Number(mine.inflight)) && Number.isInteger(Number(mine.dispatched)) && mine.wait && typeof mine.wait === 'object', 'queue 会话统计不完整：' + JSON.stringify(mine));
    const unknown = expectOk(await cliJson(['status', '--views', 'queues,not-a-view']), 'status unknown view');
    assert(Array.isArray(unknown.unknownViews) && unknown.unknownViews.length === 1 && unknown.unknownViews[0] === 'not-a-view', '未知视图没有回显：' + JSON.stringify(unknown.unknownViews));
    assert(Array.isArray(unknown.views) && unknown.views.includes('queues') && unknown.queue, '未知视图不应吞掉已知视图');
    return 'capacity=' + queue.capacity + ' session=' + sessionId + ' peak=' + mine.inflightPeak;
  });

  await check('38i. debug har 导出即自检：log._validation', async () => {
    await assertSessionAlive('38i');
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'har navigate');
    expectOk(await cliJson(['debug', 'start', '--name', 'e2e-deep-har', '--bodies', '--session', sessionId]), 'har debug start');
    let result;
    try {
      expectOk(await cliJson(['click', '#ping-btn', '--session', sessionId]), 'har click');
      await sleep(900);
      const out = path.join(outDir, 'deep-debug.har');
      result = expectOk(await cliJson(['debug', 'har', '--output', out, '--session', sessionId]), 'debug har');
      assert(Number(result.entries) >= 1 && existsSync(out), 'HAR 没有条目：' + JSON.stringify(result));
      const har = JSON.parse(readFileSync(out, 'utf8'));
      assert(har.log && har.log.version === '1.2', 'HAR 版本不是 1.2：' + JSON.stringify(har.log && har.log.version));
      assert(Array.isArray(har.log.entries) && har.log.entries.length === Number(result.entries), 'HAR 条目数与 CLI 结果不一致：' + JSON.stringify({ file: har.log.entries.length, cli: result.entries }));
      const v = har.log._validation;
      assert(v && v.ok === true, 'HAR 缺少通过的 _validation：' + JSON.stringify(v && v.counts));
      assert(v.counts && Number(v.counts.errors) === 0, 'HAR 自检有错误：' + JSON.stringify(v.issues && v.issues.slice(0, 3)));
      assert(Array.isArray(v.issues) && Array.isArray(v.explain), '_validation 缺少 issues/explain：' + JSON.stringify({ issues: v.issues, explain: v.explain }));
      assert(typeof v.truncated === 'boolean', '_validation.truncated 缺失');
      const entry = har.log.entries[0];
      assert(entry.request && entry.response && entry.timings, 'HAR 条目结构不完整：' + JSON.stringify(entry && Object.keys(entry)));
    } finally {
      await cliJson(['debug', 'stop', '--session', sessionId]);
    }
    return 'entries=' + result.entries + ' validation=ok';
  });

  await check('38j. video status 持久化：persist_*/durability/journal 回读', async () => {
    await assertSessionAlive('38j');
    const listed = expectOk(await cliJson(['video', 'list', '--session', sessionId]), 'video list');
    const recordings = listed.recordings || [];
    assert(recordings.length >= 1, 'video list 为空');
    const record = recordings.find((item) => item.persistence && item.persistence.state && item.completeness === 'complete')
      || recordings.find((item) => item.persistence && item.persistence.state)
      || recordings.find((item) => typeof item.storage_persisted === 'boolean')
      || recordings[0];
    assert(record && record.id, '找不到可断言持久化的录制：' + JSON.stringify(recordings.map((item) => ({ id: item.id, completeness: item.completeness }))));
    assert(typeof record.storage_persisted === 'boolean', '录制缺少 storage_persisted：' + JSON.stringify(record.storage_persisted));
    assert(typeof record.durability_policy === 'string' && record.durability_policy.length > 0, '录制缺少 durability_policy：' + JSON.stringify(record.durability_policy));
    const status = expectOk(await cliJson(['video', 'status', String(record.id), '--session', sessionId]), 'video status persisted');
    assert(status.state === 'ready' && status.id === record.id, 'video status 没有返回就绪录制：' + JSON.stringify({ state: status.state, id: status.id }));
    assert(Number(status.bytes) === Number(record.bytes), 'video status 字节数与列表不一致：' + JSON.stringify({ status: status.bytes, list: record.bytes }));
    const durability = expectOk(await cliJson(['video', 'durability', String(record.id), '--session', sessionId]), 'video durability');
    assert(durability.id === record.id && durability.durability_policy === record.durability_policy, 'video durability 与录制不一致：' + JSON.stringify(durability));
    assert(durability.storage_persisted === record.storage_persisted, 'video durability 的 storage_persisted 不一致：' + JSON.stringify({ durability: durability.storage_persisted, record: record.storage_persisted }));
    const verified = expectOk(await cliJson(['video', 'verify', String(record.id), '--session', sessionId]), 'video verify persisted');
    assert(verified.verified === true && Array.isArray(verified.mismatches) && verified.mismatches.length === 0, '录制分片校验失败：' + JSON.stringify(verified.mismatches));
    let persistEvidence = null;
    if (record.persistence && record.persistence.state) {
      const persistence = record.persistence;
      assert(['recording', 'sealing', 'sealed', 'recovered', 'degraded', 'failed'].includes(String(persistence.state)), 'persistence.state 取值不合法：' + JSON.stringify(persistence.state));
      assert(Number.isInteger(Number(persistence.journal_entries)), '缺少 persistence.journal_entries：' + JSON.stringify(persistence.journal_entries));
      assert(typeof persistence.journal_valid === 'boolean' || persistence.journal_valid === null, 'persistence.journal_valid 类型不对：' + JSON.stringify(persistence.journal_valid));
      assert(Number(persistence.frames) >= 0 && Number.isInteger(Number(persistence.frames)), 'persistence.frames 不合法：' + JSON.stringify(persistence.frames));
      assert(status.persistence && status.persistence.state === persistence.state, 'video status 没有回读持久化摘要：' + JSON.stringify({ status: status.persistence, list: persistence }));
      assert(Number(status.persistence.journal_entries) === Number(persistence.journal_entries), 'video status 的 journal_entries 不一致：' + JSON.stringify({ status: status.persistence.journal_entries, list: persistence.journal_entries }));
      const verifiedPersistence = verified.persistence;
      assert(verifiedPersistence && typeof verifiedPersistence === 'object' && typeof verifiedPersistence.state === 'string', 'video verify 缺少持久化视图：' + JSON.stringify(verifiedPersistence));
      assert(verifiedPersistence.journal && typeof verifiedPersistence.journal === 'object', 'video verify 持久化视图缺少 journal：' + JSON.stringify(verifiedPersistence.journal));
      persistEvidence = 'persist=' + persistence.state + '/journal=' + persistence.journal_entries + '/verify=' + verifiedPersistence.state;
    }
    return 'id=' + record.id + ' storage_persisted=' + record.storage_persisted + ' ' + (persistEvidence || 'persist 字段未接线');
  });

  await check('38k. longshot recover：分片/恢复证据（shard/restore）', async () => {
    await assertSessionAlive('38k');
    const footerUrl = new URL('footer.html', pageUrl).href;
    expectOk(await cliJson(['navigate', footerUrl, '--session', sessionId]), 'longshot navigate');
    await sleep(500);
    const out = path.join(outDir, 'deep-longshot.png');
    const shot = expectOk(await cliJson(['screenshot', '--full-page', '--tile-size', '1024', '--timeout', '180000', '--out', out, '--session', sessionId]), 'longshot screenshot');
    assert(typeof shot.longshot_id === 'string' && shot.longshot_id.length > 0, '长截图没有落盘 longshot_id：' + JSON.stringify({ id: shot.longshot_id, tiles: shot.tiles_persisted }));
    assert(Number(shot.tiles_persisted) >= 1, '长截图没有持久化分片：' + JSON.stringify(shot.tiles_persisted));
    const recoveredPath = path.join(outDir, 'deep-longshot-recovered.png');
    const recovered = expectOk(await cliJson(['longshot', 'recover', shot.longshot_id, '--out', recoveredPath, '--session', sessionId]), 'longshot recover');
    assert(existsSync(recoveredPath) && readFileSync(recoveredPath).subarray(1, 4).toString('latin1') === 'PNG', '长截图恢复没有写出 PNG');
    assert(Number(recovered.width) === Number(shot.width) && Number(recovered.height) === Number(shot.height), '恢复尺寸与截图不一致：' + JSON.stringify({ shot: [shot.width, shot.height], recovered: [recovered.width, recovered.height] }));
    const summary = recovered.summary;
    assert(summary && summary.kind === 'longshot-recovery', 'longshot recover 缺少恢复摘要：' + JSON.stringify(summary && summary.kind));
    assert(Number(summary.width) === Number(shot.width) && Number(summary.height) === Number(shot.height), '恢复摘要尺寸不对：' + JSON.stringify({ width: summary.width, height: summary.height }));
    assert(Array.isArray(summary.warnings) && Array.isArray(summary.nextSteps), '恢复摘要缺少 warnings/nextSteps');
    assert(summary.classification && typeof summary.classification.code === 'string', '恢复摘要缺少分类：' + JSON.stringify(summary.classification));
    let restoreEvidence = null;
    if (summary.verification) {
      assert(Number.isInteger(Number(summary.verification.checked)) && Number(summary.verification.checked) >= 1, '恢复校验没有 checked：' + JSON.stringify(summary.verification));
      assert(summary.verification.hashVerified === true, '恢复分片哈希校验未通过：' + JSON.stringify(summary.verification));
      assert(Array.isArray(summary.verification.missing) && Array.isArray(summary.verification.duplicates), '恢复校验缺少 missing/duplicates');
      assert(Number.isInteger(Number(summary.verification.refetch)), '恢复校验缺少 refetch 计数：' + JSON.stringify(summary.verification.refetch));
      restoreEvidence = 'checked=' + summary.verification.checked;
    }
    const raw = await rpcDirect('longshot.recover', { longshotId: shot.longshot_id, session: sessionId }, 120000);
    assert(raw.status === 200 && raw.json && raw.json.ok === true, 'daemon 原始 longshot.recover 失败：' + JSON.stringify(raw.json && raw.json.error));
    const rawResult = raw.json.result || {};
    assert(Number(rawResult.tiles) >= 1 && rawResult.complete === true && Array.isArray(rawResult.gaps) && rawResult.gaps.length === 0, '原始恢复结果不完整：' + JSON.stringify({ tiles: rawResult.tiles, complete: rawResult.complete, gaps: rawResult.gaps }));
    assert(typeof rawResult.dataUrl === 'string' && rawResult.dataUrl.startsWith('data:image/png;base64,'), '原始恢复结果没有 PNG dataUrl');
    assert(rawResult.manifest && typeof rawResult.manifest === 'object', '原始恢复结果缺少 manifest：' + JSON.stringify(rawResult.manifest));
    let shardEvidence = null;
    if (rawResult.recovery && rawResult.recovery.shards) {
      const shards = rawResult.recovery.shards;
      assert(Number(shards.count) >= 1 && shards.ok === true, '分片证据没有分片或状态异常：' + JSON.stringify({ count: shards.count, ok: shards.ok }));
      assert(/^shards:\d+:/.test(String(shards.signature || '')), '分片签名不合法：' + JSON.stringify(shards.signature));
      assert(shards.index && Number(shards.index.shardCount) >= 1 && /^[0-9a-f]{8,}$/.test(String(shards.index.indexSha || '')), '分片索引不完整：' + JSON.stringify(shards.index && { count: shards.index.shardCount, sha: shards.index.indexSha }));
      const resume = rawResult.recovery.resume_decision;
      assert(resume && typeof resume.action === 'string', '断点恢复结论缺失：' + JSON.stringify(resume));
      assert(Number(resume.total) >= 1 && Array.isArray(resume.done) && Array.isArray(resume.pending), '断点恢复计数不完整：' + JSON.stringify({ total: resume.total, done: resume.done, pending: resume.pending }));
      assert(resume.action === 'done' || resume.action === 'resume' || resume.action === 'restart', '断点恢复动作不合法：' + JSON.stringify(resume.action));
      shardEvidence = 'shards=' + shards.count + ' sig=' + String(shards.signature).slice(0, 16) + ' resume=' + resume.action + ' done=' + resume.done.length;
    }
    assert(rawResult.canvas === undefined || (Number(rawResult.canvas.width) > 0 && Number(rawResult.canvas.dpr) > 0), '画布规划证据不合法：' + JSON.stringify(rawResult.canvas));
    assert(rawResult.manifest_parse === undefined || rawResult.manifest_parse.ok === true, 'manifest 解析失败：' + JSON.stringify(rawResult.manifest_parse));
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'longshot restore');
    expectOk(await cliJson(['wait-ms', '600', '--session', sessionId]), 'longshot restore wait');
    return 'tiles=' + shot.tiles_persisted + ' ' + (restoreEvidence || 'restore 未接线') + ' ' + (shardEvidence || 'shard 未接线');
  });

  await check('36. 收尾：清空 session（stop --all）+ status', async () => {
    const stopped = expectOk(await cliJson(['session', 'stop', '--all']), 'session stop all');
    assert((stopped.count || 0) >= 1, 'session stop --all 没有停止任何会话：' + JSON.stringify(stopped));
    sessionId = null;
    const st = expectOk(await cliJson(['status']), 'status');
    assert((st.sessions || []).length === 0, '还有 ' + (st.sessions || []).length + ' 个 session');
    return 'sessions=0 browsers=' + (st.browsers || []).length;
  });

  await check('37. 内嵌技能安装（不依赖仓库目录）', async () => {
    const dir = path.join(outDir, 'skill-embed');
    rmSync(dir, { recursive: true, force: true });
    const res = expectOk(await cliJson(['install-skill', '--dir', dir, '--embedded']), 'install embedded');
    assert(res.skillVersion, '缺少 skillVersion');
    const installed = (res.results || [])[0];
    assert(installed && installed.files === 15, '内嵌技能文件数不对：' + JSON.stringify(installed));
    assert(existsSync(path.join(dir, 'SKILL.md')), 'SKILL.md 未写入');
    assert(existsSync(path.join(dir, 'references', 'recipes.md')), 'references 未写入');
    return '15 files, v' + res.skillVersion;
  });

} catch (err) {
  console.log(`\nE2E 异常中断：${err.stack || err.message}`);
  results.push({ name: 'e2e', ok: false, detail: err.message });
} finally {
  await cleanup();
}

const skipped = results.filter((r) => r.skipped === true).length;
const failed = results.filter((r) => !r.ok && r.skipped !== true);
console.log(`\n结果：${results.length - failed.length - skipped}/${results.length} 通过，${skipped} 跳过，${failed.length} 失败`);
if (failed.length || skipped) {
  console.log(skipped ? '存在跳过项，跳过不算通过。' : '失败项：');
  for (const f of [...failed, ...results.filter((r) => r.skipped === true)]) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log('E2E 全通过');
process.exit(killSignal ? 130 : 0);
