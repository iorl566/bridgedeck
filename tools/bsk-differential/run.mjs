#!/usr/bin/env node
// tools/bsk-differential/run.mjs —— 上游 0.5.0 ⇄ BridgeDeck 行为级差分基准（同一 fixture / 同一任务集）。
//
// 为什么需要它：`docs/上游-DIFF-MATRIX.md` 只能证明“线格式/字段/码面”的对应关系；本工具在真实
// Edge 里分别用两侧 CLI 跑同一组任务，比较**可观察行为**（退出码、观察文本、DOM 副作用、截图尺寸、
// PNG 头、错误拒绝），把行为级等价（equal）与“不可比/不支持”（unsupported）分开记录。
//
// 用法：
//   node tools/bsk-differential/run.mjs [--json-out <path>] [--md-out <path>] [--keep]
// 环境：
//   BSK_BIN / BSK_EXT 默认指向 ref/ 下的参考实现二进制与扩展产物
//
// 两侧都用**临时 profile + 临时 HOME**，互不污染；上游 侧 daemon 必须前台启动（本进程 Job Object
// 内 bsk 无法 detached 自启），我们侧 daemon 也用 --foreground 子进程。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { browserArgs, prepareBrowserProfile } from '../browser-launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BSK_BIN = path.resolve(ROOT, process.env.BSK_BIN || 'ref/bsk-0.5.0-bin/bsk.exe');
const BSK_EXT = path.resolve(ROOT, process.env.BSK_EXT || 'ref/bsk-0.5.0-ext');
const OUR_EXT = path.join(ROOT, 'extension');
const NODE = process.execPath;
const EDGE = (() => {
  const candidates = [
    process.env.BB_BROWSER_EDGE,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  return candidates.find((item) => existsSync(item)) || null;
})();

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const JSON_OUT = path.resolve(ROOT, arg('--json-out', 'docs/behavior-diff/report.json'));
const MD_OUT = path.resolve(ROOT, arg('--md-out', 'docs/BEHAVIOR-DIFF-BSK.md'));
const KEEP = process.argv.includes('--keep');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function tail(text, n = 400) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > n ? value.slice(0, n) + '…' : value;
}
function killTree(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* ignore */ }
}
function run(file, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(file, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child.pid);
      resolve({ file, args, exit: 'TIMEOUT', stdout, stderr, ms: Date.now() - started });
    }, options.timeoutMs || 60_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ file, args, exit: -1, stdout, stderr: stderr + String(error && error.message), ms: Date.now() - started });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ file, args, exit: code, stdout, stderr, ms: Date.now() - started });
    });
  });
}
function uiaInvoke(names, windowText, extra = []) {
  const script = path.join(ROOT, 'tools', 'uia-click.ps1');
  for (const name of names) {
    const out = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Name', name, '-WindowText', windowText, ...extra], { encoding: 'utf8', timeout: 15000 });
    const text = String((out.stdout || '') + (out.stderr || ''));
    if (out.status === 0 && /INVOKED|CLICKED/i.test(text)) return { ok: true, name, out: tail(text, 300) };
  }
  const listed = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Name', 'x', '-WindowText', windowText, '-List'], { encoding: 'utf8', timeout: 15000 });
  return { ok: false, out: tail(String((listed.stdout || '') + (listed.stderr || '')), 500) };
}
function spawnBackground(file, args, options = {}) {
  const child = spawn(file, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', (chunk) => { child.stdoutText += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { child.stderrText += chunk.toString('utf8'); });
  child.on('error', () => {});
  return child;
}
function parseJsonAny(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* fall through */ }
  return parseJsonLine(raw);
}
function parseJsonLine(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* try previous */ }
  }
  return null;
}
async function waitFor(description, probe, timeoutMs = 60_000, intervalMs = 500) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try { last = await probe(); if (last && last.ok) return { ok: true, value: last.value }; } catch (error) { last = { ok: false, error: String(error && error.message) }; }
    await sleep(intervalMs);
  }
  return { ok: false, timeoutMs, last };
}
function pngSize(file) {
  try {
    const buf = readFileSync(file);
    if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
  } catch { return null; }
}

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Differential Fixture</title></head>
<body>
<h1 id="title">Diff Fixture</h1>
<button id="btn" onclick="document.getElementById('result').textContent='CLICKED'">Submit Query</button>
<div id="result">idle</div>
<input id="inp" placeholder="keyword">
<ul id="list"><li>alpha</li><li>beta</li></ul>
<table id="tbl"><thead><tr><th>Name</th><th>Score</th></tr></thead><tbody><tr><td>Alice</td><td>10</td></tr><tr><td>Bob</td><td>20</td></tr></tbody></table>
<iframe id="same" src="/frame.html" width="320" height="120"></iframe>
<iframe id="cross" src="http://127.0.0.1:__OOPIF_PORT__/oopif.html" width="320" height="120"></iframe>
<div id="tall-spacer" style="height:1800px;background:linear-gradient(#fff,#ddd)">tall</div>
<script>window.MARKER="DIFF_MARKER_42";</script>
</body></html>`;

const FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Frame</title></head>
<body><h2 id="frame-title">Same-origin Frame</h2><button id="frame-btn" onclick="this.textContent='FRAME_CLICKED'">IFRAME_BTN</button><div id="frame-marker">IFRAME_MARKER</div></body></html>`;

const OOPIF_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>OOPIF</title></head>
<body><h2>Cross-origin Frame</h2><div id="oopif-marker">OOPIF_MARKER</div></body></html>`;

function fixtureServer(crossPort, oopifOnly = false) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = String(req.url || '/');
      const html = oopifOnly ? OOPIF_HTML
        : url === '/frame.html' ? FRAME_HTML
        : url === '/oopif.html' ? OOPIF_HTML
          : FIXTURE_HTML.replace('__OOPIF_PORT__', String(crossPort || 0));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function launchEdge(profileDir, extensionDir, startUrl) {
  if (!EDGE) throw new Error('找不到 Edge 可执行文件（设置 BB_BROWSER_EDGE）');
  prepareBrowserProfile(profileDir);
  const args = browserArgs({ profileDir, extensionDir, windowSize: '1280,900' });
  if (startUrl) {
    const blank = args.lastIndexOf('about:blank');
    if (blank >= 0) args.splice(blank, 1);
    args.push(startUrl);
  }
  const child = spawn(EDGE, args, { stdio: 'ignore', windowsHide: false, detached: false });
  child.on('error', () => {});
  return child;
}

// ---------------------------------------------------------------- 我们侧
async function startOurs(workRoot, options = {}) {
  const home = path.join(workRoot, 'our-home');
  const profile = path.join(workRoot, 'our-profile');
  const extDir = path.join(workRoot, 'our-extension');
  const port = 52917;
  mkdirSync(home, { recursive: true });
  mkdirSync(profile, { recursive: true });
  cpSync(OUR_EXT, extDir, { recursive: true });
  const wsPath = path.join(extDir, 'src', 'ws-client.js');
  const wsSource = readFileSync(wsPath, 'utf8');
  const wsPatched = wsSource.replace(/const PORTS = \[[^\]]*\];/, `const PORTS = [${port}];`);
  if (wsPatched === wsSource) throw new Error('无法改写扩展探测端口');
  writeFileSync(wsPath, wsPatched, 'utf8');
  const env = { BB_HOME: home, BB_PORT: String(port) };
  const daemon = spawn(NODE, [path.join(ROOT, 'daemon', 'server.mjs'), '--foreground', '--port', String(port)], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true,
  });
  daemon.on('error', () => {});
  const browser = await launchEdge(profile, extDir, options.startUrl);
  const bridge = path.join(ROOT, 'cli', 'bridge.mjs');
  const cli = async (argv, timeoutMs = 45_000) => run(NODE, [bridge, '--port', String(port), ...argv, '--json'], { env, timeoutMs });
  const ready = await waitFor('ours browser', async () => {
    const status = parseJsonLine((await cli(['status'], 20_000)).stdout);
    const body = status && status.result ? status.result : status;
    const browsers = body && Array.isArray(body.browsers) ? body.browsers : [];
    return { ok: browsers.length > 0, value: body };
  }, 60_000);
  return { kind: 'ours', daemon, browser, cli, ready, workRoot };
}
async function stopOurs(state) {
  killTree(state.browser && state.browser.pid);
  killTree(state.daemon && state.daemon.pid);
}

// ---------------------------------------------------------------- 上游 侧
async function startBsk(workRoot, options = {}) {
  // 支持复用外部已启动的 daemon：传 BSK_HOME 且 --reuse-daemon 时不再自起（本会话 Job Object 内自起不稳定）。
  const externalHome = process.env.BSK_HOME && process.argv.includes('--reuse-daemon') ? process.env.BSK_HOME : null;
  // 上游 在 %TEMP% 下创建 run/ 会被 ACL 拒绝（os error 5），改放仓库 .tmp（本工作区可写）。
  const home = externalHome || path.join(ROOT, '.tmp', 'bsk-differential', 'home-' + Date.now());
  const profile = path.join(workRoot, 'bsk-profile');
  mkdirSync(home, { recursive: true });
  mkdirSync(profile, { recursive: true });
  const env = { BSK_HOME: home, BSK_AUTO_START: '0' };
  const daemon = externalHome ? null : spawn(BSK_BIN, ['daemon', 'start', '--foreground'], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let daemonOut = '';
  let daemonErr = '';
  if (daemon) {
    daemon.stdout.on('data', (c) => { daemonOut += c; });
    daemon.stderr.on('data', (c) => { daemonErr += c; });
    daemon.on('error', () => {});
  }
  const bsk = (argv, timeoutMs = 60_000) => run(BSK_BIN, [...argv], { env, timeoutMs });
  const daemonReady = await waitFor('bsk daemon', async () => {
    const out = await bsk(['status', '--json'], 20_000);
    const json = parseJsonLine(out.stdout);
    return { ok: Boolean(json && (json.browsers !== undefined || json.version)), value: json };
  }, 60_000);
  const browser = await launchEdge(profile, BSK_EXT, options.startUrl);
  const browserReady = await waitFor('bsk browser', async () => {
    const out = await bsk(['browsers', '--json'], 20_000);
    const json = parseJsonLine(out.stdout);
    return { ok: Array.isArray(json) && json.length > 0, value: json };
  }, 60_000);
  return { kind: 'bsk', daemon, browser, bsk, daemonReady, browserReady, workRoot, home, daemonLog: tail(daemonOut + '\n' + daemonErr, 800) };
}
async function stopBsk(state) {
  killTree(state.browser && state.browser.pid);
  if (state.daemon) killTree(state.daemon.pid);
}

// ---------------------------------------------------------------- 任务
async function runTasks(side, pageUrl, workDir) {
  const call = side.kind === 'ours' ? side.cli : side.bsk;
  const out = {};
  const record = (task, result, extract) => {
    console.error('[diff] ' + side.kind + ' ' + task + ' exit=' + result.exit + ' ' + result.ms + 'ms');
    const parsed = parseJsonLine(result.stdout);
    out[task] = {
      exit: result.exit,
      ms: result.ms,
      stdout: tail(result.stdout, 600),
      stderr: tail(result.stderr, 300),
      json: parsed ? null : undefined,
      ...(extract ? extract(result, parsed) : {}),
    };
  };

  record('open', await call(side.kind === 'bsk' ? ['open', pageUrl, '--focus'] : ['open', pageUrl]));
  const openJson = parseJsonAny(out.open.stdout);
  const ourSessionId = side.kind === 'ours' && openJson && openJson.result ? openJson.result.sessionId : null;

  record('observe', await call(['observe']), (result) => ({
    sawTitle: /Diff Fixture/.test(result.stdout),
    sawButton: /Submit Query/.test(result.stdout),
    sawListItem: /alpha|beta/.test(result.stdout),
    sawTable: /Alice|Bob/.test(result.stdout),
  }));

  record('click', await call(['click', '#btn']));
  record('read_after_click', await call(['read', '--selector', '#result']), (result) => ({
    sawClicked: /CLICKED/.test(result.stdout),
  }));

  record('fill', await call(side.kind === 'ours'
    ? ['fill', '#inp', '--value', 'hello-diff']
    : ['fill', '#inp', '--value', 'hello-diff']));
  record('read_after_fill', await call(['read', '--selector', '#inp']), (result) => ({
    sawValue: /hello-diff/.test(result.stdout),
  }));

  record('extract_table', await call(side.kind === 'ours'
    ? ['extract', 'table', '--selector', '#tbl']
    : ['extract', 'table', '--selector', '#tbl']), (result) => ({
    sawAlice: /Alice/.test(result.stdout),
    sawBob: /Bob/.test(result.stdout),
  }));

  record('get_html', await call(['get-html']), (result) => ({
    sawMarker: /DIFF_MARKER_42/.test(result.stdout),
  }));

  const shotDir = path.join(ROOT, '.tmp', 'bsk-differential', 'shots');
  mkdirSync(shotDir, { recursive: true });
  const shotPath = path.join(shotDir, side.kind + '.png');
  try { rmSync(shotPath, { force: true }); } catch { /* ignore */ }
  record('screenshot', await call(['screenshot', '--out', shotPath]), (result) => ({
    png: result.exit === 0 ? pngSize(shotPath) : null,
  }));

  record('status', await call(['status']), (result, parsed) => ({
    version: parsed && (parsed.version || (parsed.result && parsed.result.version)) || null,
  }));

  // ---- 第二阶段：iframe / OOPIF / 长截图 / 视频 / 多会话 ----
  record('observe_iframe', await call(['observe']), (result) => ({
    sawIframe: /IFRAME_MARKER|IFRAME_BTN/.test(result.stdout),
  }));

  record('observe_oopif', await call(['observe']), (result) => ({
    sawOopif: /OOPIF_MARKER|Cross-origin Frame/.test(result.stdout),
  }));

  {
    let obsArg = [];
    if (side.kind === 'bsk') {
      const sync = await call(['sync', '--json']);
      const syncJson = parseJsonAny(sync.stdout);
      const obsId = syncJson && (syncJson.observation_id || (syncJson.result && syncJson.result.observation_id));
      if (obsId) obsArg = ['--observation', String(obsId)];
    }
    const fullPath = path.join(ROOT, '.tmp', 'bsk-differential', 'shots', side.kind + '-full.png');
    mkdirSync(path.dirname(fullPath), { recursive: true });
    try { rmSync(fullPath, { force: true }); } catch { /* ignore */ }
    let fullRes = await call(['screenshot', '--full-page', '--out', fullPath, ...obsArg]);
    if (side.kind === 'bsk' && fullRes.exit !== 0) {
      // Agent Window 被遮挡/隐藏时整页截图会拒绝；激活会话 tab 后重试一次（有界）。
      const tabs = await call(['tab', 'list', '--json']);
      const tabJson = parseJsonAny(tabs.stdout);
      const list = Array.isArray(tabJson) ? tabJson : (tabJson && Array.isArray(tabJson.tabs) ? tabJson.tabs : []);
      const id = list.length ? (list[0].tab_id || list[0].tabId || list[0].id) : null;
      if (id != null) { await call(['tab', 'select', String(id)]); await sleep(500); }
      fullRes = await call(['screenshot', '--full-page', '--out', fullPath, ...obsArg]);
    }
    record('fullpage', fullRes, (result) => ({
      png: result.exit === 0 ? pngSize(fullPath) : null,
      tall: Boolean(result.exit === 0 && pngSize(fullPath) && pngSize(fullPath).height > 1200),
    }));
  }

  {
    const videoOut = path.join(ROOT, '.tmp', 'bsk-differential', 'shots', side.kind + '-video.mp4');
    try { rmSync(videoOut, { force: true }); } catch { /* ignore */ }
    const start = await call(['video', 'start', '--duration', '12s']);
    await sleep(1800);
    const stop = side.kind === 'bsk'
      ? await call(['video', 'stop', '--out', videoOut])
      : await call(['video', 'stop']);
    out.video = {
      exit: start.exit === 0 && stop.exit === 0 ? 0 : (start.exit || stop.exit),
      ms: start.ms + stop.ms,
      stdout: tail(start.stdout + '\n' + stop.stdout, 600),
      stderr: tail(start.stderr + '\n' + stop.stderr, 300),
      recorded: start.exit === 0 && stop.exit === 0 && /mp4|recording|video/i.test(start.stdout + stop.stdout),
    };
  }

  {
    // 多会话：再 open 一次同页，看两侧是否出现第二个会话/作用域
    const second = side.kind === 'bsk' ? await call(['open', pageUrl, '--scope', 'diff-second']) : await call(['open', pageUrl]);
    const listArgv = side.kind === 'bsk' ? ['session', 'list', '--json'] : ['status'];
    const listing = await call(listArgv);
    const text = String(listing.stdout || '');
    const count = (text.match(/sessionId|session_id|"session"/g) || []).length;
    out.multi_session = {
      exit: second.exit === 0 && listing.exit === 0 ? 0 : (second.exit || listing.exit),
      ms: second.ms + listing.ms,
      stdout: tail(second.stdout + '\n' + listing.stdout, 600),
      stderr: tail(second.stderr + '\n' + listing.stderr, 300),
      sessions: count,
      twoSessions: count >= 2,
    };
  }

  {
    // 录制：两侧各录一小段（参考实现 record start 是阻塞命令，需要后台进程 + stop 兜底）
    const recDir = path.join(ROOT, '.tmp', 'bsk-differential', 'record', side.kind);
    try { rmSync(recDir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(recDir, { recursive: true });
    let startOk = false;
    let stopOk = false;
    let detail = '';
    let userClick = null;
    if (side.kind === 'bsk') {
      const child = spawnBackground(BSK_BIN, ['record', 'start', '--url', pageUrl, '--output', recDir], { env: { BSK_HOME: process.env.BSK_HOME || '', BSK_AUTO_START: '0' } });
      await sleep(1500);
      // 真实用户动作：UIA 点击用户窗口里的“Submit Query”（录制器需要人的操作）
      userClick = uiaInvoke(['Submit Query'], 'Differential Fixture');
      await sleep(500);
      const stop = await call(['record', 'stop', '--output', recDir]);
      stopOk = stop.exit === 0;
      startOk = stopOk;
      detail = tail(stop.stdout + ' ' + stop.stderr, 500);
      killTree(child.pid);
    } else {
      const sessionArg = ourSessionId ? ['--session', ourSessionId] : [];
      const start = await call(['record', 'start', ...sessionArg]);
      await sleep(600);
      const userClick = uiaInvoke(['Submit Query'], 'Differential Fixture');
      await sleep(300);
      const stop = await call(['record', 'stop', ...sessionArg]);
      startOk = start.exit === 0;
      stopOk = stop.exit === 0;
      detail = tail(start.stdout + ' ' + stop.stdout, 500);
    }
    let traceFile = false;
    try {
      const walk = (dir) => {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
      };
      traceFile = walk(recDir).some((f) => /trace.*\.json$/i.test(f));
    } catch { /* ignore */ }
    const eventsMatch = /\\"events\\":\\s*([0-9]+)/.exec(detail);
    const events = eventsMatch ? Number(eventsMatch[1]) : null;
    out.record = {
      exit: startOk && stopOk ? 0 : 1,
      ms: 0,
      stdout: detail,
      stderr: '',
      userClickClicked: userClick && userClick.ok ? userClick.name : null,
      events,
      recorded: startOk && stopOk && (side.kind === 'ours' ? /recording/.test(detail) : (/saved \d+ steps/.test(detail) || traceFile)),
    };
    // 回放对等性：参考实现没有独立 replay 子命令；我方 trace 回放 CLI 也不在本对比面暴露 → unsupported（诚实记录）
    out.record_replay = { exit: 0, ms: 0, stdout: 'replay 需要对等 CLI（参考实现仅 recipe run，我方 trace replay 未暴露 CLI）', stderr: '', replayable: false };
  }

  {
    // 配对链接：两侧是否都能生成本机配对链接（不实际配对）
    const pair = await call(['daemon', 'pair', '--json']);
    out.pair_link = {
      exit: pair.exit,
      ms: pair.ms,
      stdout: tail(pair.stdout + ' ' + pair.stderr, 500),
      stderr: '',
      hasLink: pair.exit === 0 && /ws:\/\/|ws%3A|#bsk|pair/i.test(pair.stdout + pair.stderr),
    };
  }

  {
    // 借用用户标签页：用户窗口里是真实页面；borrow 在后台等待确认，UIA 点 Allow 后取结果
    const listArgv = side.kind === 'bsk' ? ['tab', 'list', '--scope', 'user', '--json'] : ['tab', 'list', '--scope', 'user', '--json'];
    const listing = await call(listArgv);
    const listingJson = parseJsonAny(listing.stdout);
    const candidates = Array.isArray(listingJson) ? listingJson
      : (listingJson && Array.isArray(listingJson.tabs) ? listingJson.tabs
        : (listingJson && listingJson.result && Array.isArray(listingJson.result.tabs) ? listingJson.result.tabs : []));
    const tabId = candidates.length ? (candidates[0].tab_id || candidates[0].tabId || candidates[0].id) : null;
    if (!tabId) {
      out.tab_borrow = { exit: 1, ms: listing.ms, stdout: tail(listing.stdout + ' ' + listing.stderr, 500), stderr: '', borrowed: false, unsupported: true, note: 'no user-scope tab' };
    } else {
      const borrowArgv = side.kind === 'bsk'
        ? ['tab', 'borrow', String(tabId)]
        : ['tab', 'borrow', String(tabId)];
      const child = spawnBackground(side.kind === 'bsk' ? BSK_BIN : NODE, side.kind === 'bsk' ? borrowArgv : [path.join(ROOT, 'cli', 'bridge.mjs'), '--port', '52917', ...borrowArgv], {
        env: side.kind === 'bsk' ? { BSK_HOME: process.env.BSK_HOME || '', BSK_AUTO_START: '0' } : { BB_HOME: path.join(workDir, 'our-home'), BB_PORT: '52917' },
      });
      await sleep(1200);
      const uia = uiaInvoke(['Allow', '允许', 'Erlauben', 'Permit', 'Allow tab borrow?'], 'Differential Fixture');
      const started = Date.now();
      const result = await new Promise((resolve) => {
        let done = false;
        const waitMs = side.kind === 'bsk' ? 25000 : 6000;
        const timer = setTimeout(() => { if (done) return; done = true; killTree(child.pid); resolve({ exit: 'TIMEOUT', stdout: child.stdoutText, stderr: child.stderrText }); }, waitMs);
        child.on('exit', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ exit: code, stdout: child.stdoutText, stderr: child.stderrText }); });
        child.on('error', () => { if (done) return; done = true; clearTimeout(timer); resolve({ exit: -1, stdout: '', stderr: '' }); });
      });
      out.tab_borrow = {
        exit: result.exit,
        ms: Date.now() - started,
        stdout: tail(result.stdout + ' ' + result.stderr, 700),
        stderr: '',
        borrowed: result.exit === 0,
        pendingConfirmation: side.kind === 'ours' && result.exit === 'TIMEOUT',
        note: side.kind === 'ours' && result.exit === 'TIMEOUT' ? 'closed-shadow + human-only 借用确认，UIA 不可达；需要真实人点击 Allow' : undefined,
        uia: uia.ok ? { clicked: uia.name } : { clicked: null, available: uia.out },
      };
    }
  }

  record('click_missing', await call(['click', '#does-not-exist']), (result, parsed) => ({
    rejected: result.exit !== 0,
    code: parsed && parsed.error ? parsed.error.code : null,
    message: parsed && parsed.error ? tail(parsed.error.message, 160) : null,
  }));

  return out;
}

async function main() {
  if (!EDGE) throw new Error('找不到 Edge；请设置 BB_BROWSER_EDGE');
  for (const required of [BSK_BIN, path.join(BSK_EXT, 'manifest.json'), path.join(OUR_EXT, 'manifest.json')]) {
    if (!existsSync(required)) throw new Error('缺少依赖：' + required);
  }
  const workRoot = mkdtempSync(path.join(tmpdir(), 'bb-diff-'));
  const oopifServer = await fixtureServer(0, true);
  const crossPort = oopifServer.address().port;
  const server = await fixtureServer(crossPort);
  const pageUrl = `http://127.0.0.1:${server.address().port}/diff.html`;
  const report = {
    tool: 'bsk-differential',
    at: new Date().toISOString(),
    versions: {
      ours: JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
      bsk: (await run(BSK_BIN, ['--version'], { timeoutMs: 15_000 })).stdout.trim(),
      pageUrl,
    },
    sides: {},
    tasks: {},
    verdicts: {},
    environment: { edge: EDGE, node: process.version, platform: process.platform },
  };
  let ours = null;
  let bsk = null;
  try {
    ours = await startOurs(workRoot, { startUrl: pageUrl });
    report.sides.ours = { browserReady: ours.ready.ok, browser: ours.ready.value && ours.ready.value.browsers ? ours.ready.value.browsers.length : 0 };
    bsk = await startBsk(workRoot, { startUrl: pageUrl });
    report.sides.bsk = {
      externalDaemon: Boolean(process.env.BSK_HOME && process.argv.includes('--reuse-daemon')),
      daemonReady: bsk.daemonReady.ok,
      daemonLog: bsk.daemonLog,
      browserReady: bsk.browserReady.ok,
      browser: bsk.browserReady.value && bsk.browserReady.value.length ? bsk.browserReady.value[0] : null,
    };

    const ourTasks = await runTasks(ours, pageUrl, workRoot);
    const bskTasks = await runTasks(bsk, pageUrl, workRoot);
    report.tasks = { ours: ourTasks, bsk: bskTasks };
    const oursFinal = parseJsonLine((await ours.cli(['status'], 20_000)).stdout);
    const oursBody = oursFinal && oursFinal.result ? oursFinal.result : oursFinal;
    report.sides.ours = { browserReady: Boolean(oursBody && Array.isArray(oursBody.browsers) && oursBody.browsers.length), browser: oursBody && oursBody.browsers ? oursBody.browsers.length : 0 };
    const bskFinal = parseJsonLine((await bsk.bsk(['browsers', '--json'], 20_000)).stdout);
    report.sides.bsk.browserReady = Array.isArray(bskFinal) && bskFinal.length > 0;
    report.sides.bsk.browser = Array.isArray(bskFinal) && bskFinal.length ? bskFinal[0] : null;
    report.sides.bsk.daemonReady = Boolean(report.sides.bsk.browserReady);

    const checks = [
      ['open', (t) => t.exit === 0],
      ['observe', (t) => t.sawTitle === true],
      ['click', (t) => t.exit === 0],
      ['read_after_click', (t) => t.sawClicked === true],
      ['fill', (t) => t.exit === 0],
      ['read_after_fill', (t) => t.sawValue === true],
      ['extract_table', (t) => t.sawAlice === true && t.sawBob === true],
      ['get_html', (t) => t.sawMarker === true],
      ['screenshot', (t) => Boolean(t.png && t.png.width > 0 && t.png.height > 0)],
      ['click_missing', (t) => t.rejected === true],
      ['observe_iframe', (t) => t.sawIframe === true],
      ['observe_oopif', (t) => t.sawOopif === true],
      ['fullpage', (t) => t.tall === true],
      ['video', (t) => t.recorded === true],
      ['multi_session', (t) => t.twoSessions === true],
      ['record', (t) => t.recorded === true],
      ['record_replay', (t) => t.replayable === true],
      ['pair_link', (t) => t.hasLink === true],
      ['tab_borrow', (t) => t.borrowed === true],
    ];
    for (const [task, predicate] of checks) {
      const oursOk = Boolean(ourTasks[task] && predicate(ourTasks[task]));
      const bskOk = Boolean(bskTasks[task] && predicate(bskTasks[task]));
      const oursMs = ourTasks[task] ? ourTasks[task].ms : null;
      const bskMs = bskTasks[task] ? bskTasks[task].ms : null;
      report.verdicts[task] = {
        ours: oursOk,
        bsk: bskOk,
        verdict: oursOk && bskOk ? 'equal' : oursOk || bskOk ? 'diff' : 'unsupported',
        ms: { ours: oursMs, bsk: bskMs },
      };
    }
  } finally {
    if (ours) await stopOurs(ours);
    if (bsk) await stopBsk(bsk);
    server.close();
    oopifServer.close();
    if (!KEEP) {
      try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* profile 可能仍被占用 */ }
    } else {
      console.log('workRoot kept:', workRoot);
    }
  }
  mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeMarkdown(report);
  const failed = Object.entries(report.verdicts).filter(([, v]) => v.verdict !== 'equal');
  console.log(`behavior diff: ${Object.keys(report.verdicts).length} tasks, ${failed.length} 非 equal → ${path.relative(ROOT, JSON_OUT)}`);
  for (const [task, v] of Object.entries(report.verdicts)) console.log(`  ${v.verdict.padEnd(11)} ${task.padEnd(18)} ours=${v.ours ? 'ok' : 'no'} bsk=${v.bsk ? 'ok' : 'no'} (${v.ms.ours}ms / ${v.ms.bsk}ms)`);
  if (failed.length) process.exitCode = 2;
}

function writeMarkdown(report) {
  const lines = [
    '# BSK 0.5.0 ⇄ BridgeDeck 行为级差分基准',
    '',
    `> 生成：${report.at}；BSK \`${report.versions.bsk}\` ⇄ BridgeDeck \`${report.versions.ours}\`；`,
    `> fixture 同页：\`${report.versions.pageUrl}\`；两侧临时 profile/HOME，真实 Edge（非 headless）。`,
    '> 判定：equal = 两侧可观察行为一致；diff = 只有一侧满足；unsupported = 两侧都未满足/无法比较。',
    '',
    '## 汇总',
    '',
    '| 任务 | 我们 | BSK | 判定 | 耗时（我们/BSK） |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [task, v] of Object.entries(report.verdicts)) {
    lines.push(`| ${task} | ${v.ours ? '✅' : '❌'} | ${v.bsk ? '✅' : '❌'} | **${v.verdict}** | ${v.ms.ours}ms / ${v.ms.bsk}ms |`);
  }
  lines.push('', '## 任务细节（stdout 摘要，完整原始输出见 JSON）', '');
  for (const task of Object.keys(report.verdicts)) {
    lines.push(`### ${task}`, '', '| 侧 | exit | 摘要 |', '| --- | --- | --- |');
    for (const side of ['ours', 'bsk']) {
      const t = report.tasks[side] && report.tasks[side][task];
      if (!t) { lines.push(`| ${side} | — | 未执行 |`); continue; }
      const extra = t.png ? ` PNG ${t.png.width}x${t.png.height} (${t.png.bytes}B)` : '';
      lines.push(`| ${side} | ${t.exit} | \`${(t.stdout || '').replace(/\|/g, '\\|')}\`${extra} |`);
    }
    lines.push('');
  }
  lines.push('## 环境', '', '```json', JSON.stringify(report.environment, null, 2), '```', '');
  mkdirSync(path.dirname(MD_OUT), { recursive: true });
  writeFileSync(MD_OUT, lines.join('\n') + '\n', 'utf8');
}

main().catch((error) => {
  console.error('bsk-differential failed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
