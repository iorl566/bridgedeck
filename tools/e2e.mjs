#!/usr/bin/env node
// tools/e2e.mjs — BridgeDeck端到端验收：真实 Edge + 真实扩展 + 真实 daemon/CLI。
//
// 流程：静态页服务 → 临时 BB_HOME 起 daemon → 独立 user-data-dir 起 Edge 并加载 extension/
//       → CLI 跑 session start / navigate / observe / fill / click / get-html / evaluate /
//         screenshot / session stop，逐项断言。
//
// 用法（node 需用绝对路径，见 README）：
//   node tools/e2e.mjs [--browser edge|chrome] [--port 53907] [--keep]
// 退出码：0 全通过，1 有失败。
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import readline from 'node:readline';
import { browserArgs, prepareBrowserProfile } from './browser-launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.argv[0]; // 当前 node 可执行文件
const CLI = path.join(ROOT, 'cli', 'bridge.mjs');
const EXT_DIR = path.join(ROOT, 'extension');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const browser = opt('--browser', 'edge');
const keep = args.includes('--keep');
// 默认每次 E2E 都同步 README 截图；需要保持工作树干净时设 BB_E2E_SYNC_DOCS=0。
const SYNC_DOCS = process.env.BB_E2E_SYNC_DOCS !== '0';

function browserCandidates(name) {
  if (process.platform === 'win32') {
    return name === 'edge'
      ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
      : ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  }
  if (process.platform === 'darwin') {
    return name === 'edge'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', path.join(process.env.HOME || '', 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')]
      : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')];
  }
  return name === 'edge'
    ? ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
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
function check(name, fn) {
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

  if (!(await check('3. session start（开 agent 窗口）', async () => {
    const r = await cliJson(['session', 'start']);
    const res = expectOk(r, 'session start');
    sessionId = res.sessionId;
    assert(/^[a-z]{4}$/.test(sessionId), `sessionId 应为 4 位小写字母，实际 ${sessionId}`);
    assert(Number.isInteger(res.tabId), 'tabId 缺失');
    const st = expectOk(await cliJson(['status']), 'status after start');
    const row = (st.sessions || []).find((item) => item.sessionId === sessionId);
    assert(row && row.phase === 'active', 'session phase 不是 active：' + JSON.stringify(row));
    return `session=${sessionId} tab=${res.tabId} window=${res.windowId}`;
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
    assert(button.rect && Number.isFinite(button.rect.w) && Number.isFinite(button.rect.h), 'vom rect 不合法：' + JSON.stringify(button.rect));
    const textbox = res.nodes.find((node) => String(node.role || '').toLowerCase() === 'textbox');
    assert(textbox && textbox.rect, 'vom 里没有 textbox/rect');
    assert(textbox.inForm === true, 'vom textbox 应标记 inForm：' + JSON.stringify(textbox));
    assert(textbox.inputState === 'empty', 'vom textbox 初始 inputState 应为 empty：' + JSON.stringify(textbox.inputState));
    assert(button.clickable === true, 'vom button 应标记 clickable：' + JSON.stringify(button.clickable));
    assert(Number.isInteger(button.paintOrder), 'vom button 缺少 paintOrder：' + JSON.stringify(button.paintOrder));
    const draggable = res.nodes.find((node) => node.dragHint === 'draggable');
    assert(draggable, 'vom 里没有 draggable 节点：' + JSON.stringify(res.nodes.filter((node) => node.tag === 'div').slice(0, 3)));
    assert(typeof draggable.name === 'string' && draggable.name.length > 0, 'draggable 节点缺少 name');
    return 'nodes=' + res.nodes.length + ' button=' + button.ref;
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
    expectOk(r, 'fill');
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

  await check('8. get-html 读回结果（#out 变成 clicked:...）', async () => {
    const r = await cliJson(['get-html', '--selector', '#out', '--session', sessionId]);
    const res = expectOk(r, 'get-html');
    const html = res.html || '';
    assert(html.includes('clicked:hello bridge'), `#out 内容不符：${JSON.stringify(html).slice(0, 300)}`);
    return html.replace(/\s+/g, ' ').slice(0, 120);
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

    const listed = expectOk(await cliJson(['debug', 'requests', '--filter', '/api/ping', '--session', sessionId]), 'debug requests');
    assert((listed.entries || []).length >= 1, 'debug requests 没抓到 /api/ping');
    const requestId = listed.entries[0].id;

    const detail = expectOk(await cliJson(['debug', 'request', String(requestId), '--session', sessionId]), 'debug request');
    assert(detail.entry && detail.entry.url.includes('/api/ping'), '请求详情 url 不对');
    assert(detail.responseBody && detail.responseBody.includes('ok'), '响应正文没取到（bodies 未生效）：' + JSON.stringify(detail.responseBody || null).slice(0, 120));

    const consoleBody = expectOk(await cliJson(['debug', 'console', '--session', sessionId]), 'debug console');
    assert((consoleBody.entries || []).some((item) => String(item.text || '').includes('bridge-e2e-console')), '控制台里没有我们的 warn');

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
    assert(existsSync(path.join(outDir, '.bb-debug-index.json')), '归档索引文件未生成');
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

  await check('20d3. record 记录 tab-switch 步骤', async () => {
    expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record tab-switch start');
    const opened = expectOk(await cliJson(['tab', 'new', 'about:blank', '--session', sessionId]), 'tab new for record');
    await sleep(700);
    expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record tab-switch stop');
    const listed = expectOk(await cliJson(['record', 'list', '--session', sessionId]), 'record list tab-switch');
    const recording = (listed.recordings || [])[0] || {};
    const switched = (recording.events || []).some((event) => event.kind === 'tab-switch');
    if (opened && opened.tabId != null) await cliJson(['tab', 'close', String(opened.tabId), '--session', sessionId]);
    assert(switched, '没有记录 tab-switch：' + JSON.stringify((recording.events || []).map((event) => event.kind)));
    return 'tab-switch recorded';
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
    await cliJson(['wait-ms', '800', '--session', sessionId]);
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
    const alias = (frames.aliases || []).find((item) => item.ref === '@' + local[1]) || (frames.aliases || []).find((item) => Number(item.frameId) > 0 && String(item.url || '').includes('frame-x.html'));
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
    expectOk(await cliJson(['record', 'start', '--include-agent', '--session', sessionId]), 'record dwell start');
    expectOk(await cliJson(['hover', '#more-link', '--session', sessionId]), 'hover link');
    await sleep(1000);
    expectOk(await cliJson(['record', 'stop', '--session', sessionId]), 'record dwell stop');
    const listed = expectOk(await cliJson(['record', 'list', '--session', sessionId]), 'record list dwell');
    const recording = (listed.recordings || [])[0] || {};
    const hoverEvent = (recording.events || []).find((event) => event.kind === 'hover' && event.dwellMs === 800);
    assert(hoverEvent, '没有记录 hover 停留：' + JSON.stringify((recording.events || []).map((event) => ({ kind: event.kind, dwellMs: event.dwellMs }))));
    return 'hover dwell=' + hoverEvent.dwellMs;
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

  await check('20e. debug duplicates 重复请求检测', async () => {
    expectOk(await cliJson(['debug', 'start', '--name', 'dup', '--session', sessionId]), 'debug start dup');
    for (let i = 0; i < 3; i += 1) await cliJson(['click', '#ping-btn', '--session', sessionId]);
    await sleep(400);
    const dup = expectOk(await cliJson(['debug', 'duplicates', '--window-ms', '3000', '--filter', '/api/ping', '--session', sessionId]), 'debug duplicates');
    assert(Array.isArray(dup.groups) && dup.groups.length >= 1, '没有检测到重复请求：' + JSON.stringify(dup));
    assert(dup.groups[0].count >= 3, '重复计数不对：' + dup.groups[0].count);
    await cliJson(['debug', 'stop', '--session', sessionId]);
    return 'count=' + dup.groups[0].count;
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
      return 'tools=' + tools.length + ', shot=' + readFileSync(shotPath).length + 'B';
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
    const fresh = expectOk(await cliJson(['session', 'start', '--browser', 'edge']), 'frames fresh session');
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
    return '拒绝覆盖 → --overwrite 成功（' + result.bytes + ' 字节，transfer=' + result.transferBytes + '）';
  });

  await check('23h. cooperate sync + --context 授权动作', async () => {
    expectOk(await cliJson(['navigate', pageUrl, '--session', sessionId]), 'sync navigate');
    const sync = expectOk(await cliJson(['cooperate', 'sync', '--session', sessionId]), 'cooperate sync');
    assert(sync.cooperation && sync.cooperation.frameState && Number.isInteger(sync.cooperation.frameState.revision), 'cooperate sync 缺少 frameState：' + JSON.stringify(sync.cooperation && sync.cooperation.frameState));
    assert(sync.authority && sync.authority.generation >= 1 && Number.isInteger(sync.authority.revision), 'cooperate sync 缺少 authority：' + JSON.stringify(sync.authority));
    assert(sync.control_policy === 'target', 'control_policy 不对：' + JSON.stringify(sync.control_policy));
    assert(typeof sync.context_id === 'string' && sync.context_id, '缺少 context_id');
    assert(typeof sync.observation_id === 'string' && sync.observation_id, '缺少 observation_id');
    assert(sync.observation && String(sync.observation.text).includes('E2E 夹具页'), 'sync 没返回观察文本');
    expectOk(await cliJson(['click', '#submit-btn', '--context', sync.context_id, '--session', sessionId]), 'click with context');
    return 'context=' + sync.context_id.slice(0, 8) + '… policy=' + sync.control_policy;
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
    await cliJson(['wait-ms', '800', '--session', sessionId]);
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
    return 'human → ready';
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
    const pressed = uiaClick('提交查询', 'BridgeDeck E2E 夹具页');
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
    const opened = expectOk(await cliJson(args), 'ui open ' + page);
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

  await check('29c. CLI 不能通过 daemonUrl 完成本机配对', async () => {
    const before = expectOk(await cliJson(['browsers']), 'browsers before pair');
    assert((before.browsers || []).some((item) => item.localAuth === 'unpaired'), '默认应为未配对');
    const paired = expectOk(await cliJson(['daemon', 'pair']), 'daemon pair');
    assert(paired.link && paired.link.includes('#'), '配对链接格式不对：' + JSON.stringify(paired).slice(0, 120));
    const denied = await cliJson(['settings', 'set', '--daemon-url', 'ws://127.0.0.1:1/ws', '--daemon-token', paired.token]);
    assert(denied.code === 1 && denied.json && denied.json.error && denied.json.error.code === 'E_FORBIDDEN', 'CLI 修改配对地址应被拒绝：' + JSON.stringify(denied.json));
    return 'E_FORBIDDEN';
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
    const { title, tabId } = await openPageAndReadTitle('longshot', 'selftest=1');
    await closePage(tabId);
    assert(/^SELFTEST:ok:longshot:\d+x\d+$/.test(title), '长截图自测失败：' + JSON.stringify(title));
    return title.replace('SELFTEST:ok:longshot:', '');
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
    const { title, tabId } = await openPageAndReadTitle('record', 'selftest=1');
    await closePage(tabId);
    assert(/^SELFTEST:ok:video:\d+:(mp4|webm):\d+$/.test(title), '视频录制自测失败：' + JSON.stringify(title));
    const parts = title.replace('SELFTEST:ok:video:', '').split(':');
    assert(Number(parts[2]) > 0, '录出来的视频是空文件：' + parts[2] + ' 字节');
    return parts[1] + ' ' + parts[2] + ' 字节';
  });

  await check('35b. observe --vom 命中测试：遮挡 / pointer-events / 屏外', async () => {
    const vomUrl = pageUrl.replace(/test\.html.*$/, 'vom.html');
    // 前面的 UI/人工接管检查可能让会话处于暂停态；这里先恢复，避免级联 E_SESSION_PAUSED。
    await cliJson(['session', 'resume', sessionId]).catch(() => {});
    expectOk(await cliJson(['navigate', vomUrl, '--session', sessionId]), 'navigate vom');
    const res = expectOk(await cliJson(['observe', '--vom', '--session', sessionId]), 'observe vom');
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

  await check('36. 收尾：清空 session + status', async () => {
    const before = expectOk(await cliJson(['session', 'list']), 'session list');
    for (const session of before.sessions || []) {
      await cliJson(['session', 'stop', session.sessionId]);
    }
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
