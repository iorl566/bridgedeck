// tests/cli/selftest.mjs — daemon + CLI 全链路自测（不依赖真实浏览器）。
//
// 流程：临时 BB_HOME/BB_PORT 起 daemon → mock-extension 连 /ws →
// 用 CLI 跑 status/session/browsers/navigate/observe/screenshot/evaluate/... →
// 断言退出码与输出 → 停 daemon、删临时目录。全部通过时退出码 0。
//
// 运行：node tests/cli/selftest.mjs

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signRelease } from '../../lib/release-sign.mjs';

const NODE = process.execPath;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const SERVER = path.join(REPO, 'daemon', 'server.mjs');
const CLI = path.join(REPO, 'cli', 'bridge.mjs');
const MOCK = path.join(HERE, 'mock-extension.mjs');
const DAEMON_JSON = () => path.join(homeDir, 'daemon.json');

let homeDir = '';
let port = 0;
let daemonProc = null;
let mockProc = null;
let daemonOutput = [];
let mockOutput = [];

let passCount = 0;
let failCount = 0;
const failures = [];

// ---------------------------------------------------------------------------
// 断言与输出
// ---------------------------------------------------------------------------

function section(title) {
  console.log(`\n== ${title} ==`);
}

function check(name, ok, detail = '') {
  if (ok) {
    passCount += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failCount += 1;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch { /* 继续重试 */ }
    await sleep(intervalMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

function httpRequest({ port: requestPort = port, method = 'GET', pathname = '/', headers = {}, body, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const requestHeaders = { ...headers };
    if (payload) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = payload.length;
    }
    const req = http.request({
      host: '127.0.0.1',
      port: requestPort,
      path: pathname,
      method,
      agent: false,
      headers: requestHeaders,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function health() {
  try {
    const res = await httpRequest({ pathname: '/health', timeoutMs: 800 });
    return res.json && res.json.service === 'browser-bridge' ? res.json : null;
  } catch {
    return null;
  }
}

function readDaemonInfo() {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_JSON(), 'utf8'));
  } catch {
    return null;
  }
}

async function directRpc(method, params = {}) {
  const info = readDaemonInfo();
  if (!info) return null;
  try {
    const res = await httpRequest({
      port: info.port,
      method: 'POST',
      pathname: '/rpc',
      headers: { 'x-bridge-token': info.token },
      body: { method, params },
      timeoutMs: 5000,
    });
    return res.json;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 子进程辅助
// ---------------------------------------------------------------------------

function baseEnv() {
  // BB_NO_PROBE：测试机可能还有别的 daemon 占着 52900，猜孤儿端口会污染自动拉起用例。
  return { ...process.env, BB_HOME: homeDir, BB_PORT: String(port), BB_NO_PROBE: '1' };
}

function runNode(args, { timeoutMs = 30_000, env = baseEnv() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* 忽略 */ }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function runCli(args, options = {}) {
  return runNode([CLI, ...args], options);
}

function jsonOf(result) {
  try {
    return JSON.parse(String(result.stdout).trim());
  } catch {
    return null;
  }
}

function singleLineJson(result) {
  const lines = String(result.stdout).trim().split('\n');
  return lines.length === 1 && jsonOf(result) !== null;
}

function startDaemonProcess() {
  daemonProc = spawn(NODE, [SERVER, '--foreground', '--port', String(port)], {
    env: baseEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  daemonProc.stdout.on('data', (chunk) => daemonOutput.push(String(chunk)));
  daemonProc.stderr.on('data', (chunk) => daemonOutput.push(String(chunk)));
  return daemonProc;
}

function startMockProcess(extraArgs = []) {
  mockProc = spawn(NODE, [MOCK, '--port', String(port), ...extraArgs], {
    env: baseEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  mockProc.stdout.on('data', (chunk) => mockOutput.push(String(chunk)));
  mockProc.stderr.on('data', (chunk) => mockOutput.push(String(chunk)));
  return mockProc;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

// ---------------------------------------------------------------------------
// 自测主体
// ---------------------------------------------------------------------------

async function runTests() {
  homeDir = path.join(os.tmpdir(), `bb-selftest-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(homeDir, { recursive: true });
  port = await freePort();
  console.log(`[setup] BB_HOME=${homeDir}`);
  console.log(`[setup] BB_PORT=${port}`);
  console.log(`[setup] node=${NODE}`);

  // -------------------------------------------------------------------------
  section('1. daemon 启动与 daemon.json');
  startDaemonProcess();
  const ready = await waitFor(async () => !!(await health()), 12_000, 120);
  if (!ready) {
    throw new Error(`daemon 未能启动：\n${daemonOutput.join('')}`);
  }
  check('daemon /health 就绪', true);

  const healthInfo = await health();
  check('health 字段齐全', Boolean(
    healthInfo
    && healthInfo.ok === true
    && healthInfo.service === 'browser-bridge'
    && healthInfo.pid === daemonProc.pid
    && healthInfo.port === port
    && healthInfo.browsers === 0
    && healthInfo.sessions === 0
    && healthInfo.uptimeMs >= 0
  ), JSON.stringify(healthInfo));

  const info = readDaemonInfo();
  check('daemon.json 已原子写入', Boolean(info));
  check('daemon.json pid 指向本 daemon', info && info.pid === daemonProc.pid, `json=${info && info.pid} child=${daemonProc.pid}`);
  check('daemon.json port 是实际监听端口', info && info.port === port, `json=${info && info.port} expect=${port}`);
  check('daemon.json version=' + PKG_VERSION, info && info.version === PKG_VERSION);
  check('daemon.json token 为 32 位 hex', Boolean(info && /^[0-9a-f]{32}$/.test(info.token || '')));
  check('daemon.json startedAt 为时间戳', Boolean(info && Number.isFinite(info.startedAt)));

  // -------------------------------------------------------------------------
  section('2. HTTP 鉴权与路由（PROTOCOL §2）');
  const wrongToken = await httpRequest({
    method: 'POST',
    pathname: '/rpc',
    headers: { 'x-bridge-token': '0'.repeat(32) },
    body: { method: 'status', params: {} },
  });
  check('错误 token → 401 + E_AUTH', wrongToken.status === 401 && wrongToken.json && wrongToken.json.error.code === 'E_AUTH');
  const unknown = await httpRequest({
    method: 'POST',
    pathname: '/rpc',
    headers: { 'x-bridge-token': info.token },
    body: { method: '__nope__', params: {} },
  });
  check('未知方法 → 404 + E_UNKNOWN_METHOD', unknown.status === 404 && unknown.json && unknown.json.error.code === 'E_UNKNOWN_METHOD');
  const noRoute = await httpRequest({ pathname: '/nope' });
  check('未知路径 → 404', noRoute.status === 404);

  // -------------------------------------------------------------------------
  section('3. CLI 基础命令（无浏览器）');
  const status1 = await runCli(['status', '--json']);
  check('bridge status --json 退出码 0', status1.code === 0, status1.stderr);
  check('--json 模式 stdout 只有一行 JSON', singleLineJson(status1), status1.stdout);
  const statusJson = jsonOf(status1);
  check('status.browsers 为空', Boolean(statusJson && statusJson.ok === true && statusJson.result.browsers.length === 0));

  const browsers1 = await runCli(['browsers', '--json']);
  check('bridge browsers --json 退出码 0', browsers1.code === 0);
  check('browsers 为空数组', Boolean(jsonOf(browsers1) && jsonOf(browsers1).result.browsers.length === 0));

  const daemonStatus = await runCli(['daemon', 'status']);
  check('bridge daemon status 显示运行中', daemonStatus.code === 0 && daemonStatus.stdout.includes(`pid ${daemonProc.pid}`), daemonStatus.stdout);

  const daemonStart = await runCli(['daemon', 'start']);
  check('bridge daemon start 幂等', daemonStart.code === 0 && /daemon/.test(daemonStart.stdout), daemonStart.stdout);
  check('daemon start 未重复启动（pid 不变）', (readDaemonInfo() || {}).pid === daemonProc.pid);

  const daemonLog = await runCli(['daemon', 'log', '--tail']);
  check('bridge daemon log --tail 有内容', daemonLog.code === 0 && daemonLog.stdout.includes('daemon'), daemonLog.stderr);

  // -------------------------------------------------------------------------
  section('4. mock 扩展连接（PROTOCOL §3 握手）');
  startMockProcess();
  const mockUp = await waitFor(async () => {
    const result = await directRpc('status');
    return Boolean(result && result.ok && result.result.browsers.length === 1);
  }, 12_000, 150);
  check('mock 扩展连上 daemon', mockUp, mockOutput.join('').slice(-400));
  if (!mockUp) throw new Error(`mock extension 未连接：\n${mockOutput.join('')}`);

  const status2 = jsonOf(await runCli(['status', '--json']));
  const browser = status2 && status2.result && status2.result.browsers[0];
  const instanceId = browser && browser.instanceId;
  check('status 显示 edge 实例', Boolean(browser && browser.browser === 'edge'), JSON.stringify(browser));
  check('instanceId 为 8 位 hex', /^[0-9a-f]{8}$/.test(instanceId || ''), instanceId);

  const statusHuman = await runCli(['status']);
  check('status 人类输出含 edge 与实例号', statusHuman.code === 0 && statusHuman.stdout.includes('edge') && statusHuman.stdout.includes(instanceId));
  const browsersHuman = await runCli(['browsers']);
  check('browsers 人类输出含实例号', browsersHuman.code === 0 && browsersHuman.stdout.includes(instanceId));

  // -------------------------------------------------------------------------
  section('5. session start / list / stop');
  const start1 = await runCli(['session', 'start', '--browser', 'edge', '--json']);
  check('session start 退出码 0', start1.code === 0, start1.stderr);
  check('session start --json 单行 JSON', singleLineJson(start1), start1.stdout);
  const startJson = jsonOf(start1);
  const session1 = startJson && startJson.result;
  const sessionId = session1 && session1.sessionId;
  check('sessionId 为 4 位小写字母', /^[a-z]{4}$/.test(sessionId || ''), sessionId);
  check('session.start 返回 tabId/windowId', Boolean(session1 && typeof session1.tabId === 'number' && typeof session1.windowId === 'number'));
  check('session.start 返回 instanceId', Boolean(session1 && session1.instanceId === instanceId));

  const framesGate = await runCli(['observe', '--frames', '--session', sessionId, '--json']);
  const framesGateJson = jsonOf(framesGate);
  check('能力降级：mock 未声明 frames → 降级主文档观察', framesGate.code === 0 && framesGateJson && framesGateJson.result && framesGateJson.result.downgraded === true && Array.isArray(framesGateJson.result.frames) && framesGateJson.result.frames.length === 1, framesGate.stdout + framesGate.stderr);

  const badBrowser = await runCli(['session', 'start', '--browser', 'chrome', '--json']);
  check('--browser chrome 无匹配 → 退出码 1 + E_NO_BROWSER', badBrowser.code === 1 && jsonOf(badBrowser) && jsonOf(badBrowser).error.code === 'E_NO_BROWSER', badBrowser.stdout + badBrowser.stderr);

  const list1 = jsonOf(await runCli(['session', 'list', '--json']));
  check('session list 有 1 个 session', Boolean(list1 && list1.ok === true && list1.result.sessions.length === 1 && list1.result.sessions[0].sessionId === sessionId));
  check('status.sessions 计数为 1', Boolean(jsonOf(await runCli(['status', '--json'])).result.sessions.length === 1));

  // -------------------------------------------------------------------------
  section('6. navigate / observe / screenshot / evaluate');
  const nav = await runCli(['navigate', 'https://example.com/', '--session', sessionId, '--json']);
  check('navigate 退出码 0 且 url 正确', nav.code === 0 && jsonOf(nav) && jsonOf(nav).result.url === 'https://example.com/', nav.stdout + nav.stderr);

  const autoSelect = await runCli(['navigate', 'https://auto.example/', '--json']);
  check('省略 --session 自动选用唯一 session', autoSelect.code === 0 && jsonOf(autoSelect) && jsonOf(autoSelect).ok === true, autoSelect.stdout + autoSelect.stderr);
  const status4 = jsonOf(await runCli(['status', '--json']));
  check('session.url 已同步（navigate 结果回写）', Boolean(status4 && status4.result.sessions[0] && status4.result.sessions[0].url === 'https://auto.example/'), JSON.stringify(status4 && status4.result.sessions));

  const observeHuman = await runCli(['observe', '--session', sessionId]);
  check('observe 人类输出含 url/title/@ref', observeHuman.code === 0 && observeHuman.stdout.includes('url:') && observeHuman.stdout.includes('Mock Page') && observeHuman.stdout.includes('@e2'), observeHuman.stdout);
  const observeJson = jsonOf(await runCli(['observe', '--json', '--session', sessionId]));
  check('observe result 含 observation/refs', Boolean(observeJson && observeJson.result.refs === 3 && String(observeJson.result.observation).includes('textbox')));

  const savedObs = path.join(homeDir, 'obs', 'observation.txt');
  const savedRes = jsonOf(await runCli(['observe', '--save-full', savedObs, '--json', '--session', sessionId]));
  check(
    'observe --save-full 原子落盘且无临时文件',
    Boolean(
      savedRes && savedRes.result.savedTo === savedObs &&
      fs.existsSync(savedObs) && fs.readFileSync(savedObs, 'utf8').includes('textbox') &&
      !fs.readdirSync(path.dirname(savedObs)).some((name) => name.includes('.tmp-')),
    ),
  );

  const shotPath = path.join(homeDir, 'shots', 'shot.png');
  const shot = await runCli(['screenshot', '--out', shotPath, '--full', '--session', sessionId]);
  check('screenshot 退出码 0', shot.code === 0, shot.stderr);
  check('screenshot 输出尺寸 300x200', shot.stdout.includes('300x200'), shot.stdout);
  const pngOk = fs.existsSync(shotPath);
  check('screenshot --out 落盘', pngOk);
  if (pngOk) {
    const buffer = fs.readFileSync(shotPath);
    check('screenshot 文件为 PNG 魔数', buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47);
    check('screenshot PNG IHDR 宽高 300x200', buffer.length >= 24 && buffer.readUInt32BE(16) === 300 && buffer.readUInt32BE(20) === 200);
    check('screenshot 文件大小 > 100 字节', buffer.length > 100, `${buffer.length} bytes`);
    check('screenshot 无 dataUrl 残留（纯 PNG）', buffer.length > 8 && buffer.indexOf(Buffer.from('data:image')) === -1);
  }

  const shotJsonPath = path.join(homeDir, 'shots', 'shot-json.png');
  const shotJsonRes = await runCli(['screenshot', '--out', shotJsonPath, '--json', '--session', sessionId]);
  const shotJson = jsonOf(shotJsonRes);
  check('screenshot --json 输出落盘摘要（不含巨大 dataUrl）', Boolean(
    shotJsonRes.code === 0
    && singleLineJson(shotJsonRes)
    && shotJson
    && shotJson.result
    && shotJson.result.path === path.resolve(shotJsonPath)
    && shotJson.result.width === 300
    && shotJson.result.height === 200
    && shotJson.result.dataUrl === undefined
    && fs.existsSync(shotJsonPath)
    && shotJsonRes.stdout.length < 2000
  ), shotJsonRes.stdout.slice(0, 300));

  const evaluateJson = jsonOf(await runCli(['evaluate', '1+1', '--json', '--session', sessionId]));
  check('evaluate --json 返回 value=2', Boolean(evaluateJson && evaluateJson.result.value === 2), JSON.stringify(evaluateJson));
  const evaluateHuman = await runCli(['evaluate', '2+3', '--session', sessionId]);
  check('evaluate 人类输出 5', evaluateHuman.code === 0 && evaluateHuman.stdout.trim() === '5', evaluateHuman.stdout);

  // -------------------------------------------------------------------------
  section('7. 页面动作 / tab / window');
  const getHtml = jsonOf(await runCli(['get-html', '--selector', 'h1', '--json', '--session', sessionId]));
  check('get-html 返回 html', Boolean(getHtml && String(getHtml.result.html).includes('Mock Page')));

  const actions = [
    ['click @e2', ['click', '@e2', '--session', sessionId]],
    ['hover @e2', ['hover', '@e2', '--session', sessionId]],
    ['fill @e2 --value hello', ['fill', '@e2', '--value', 'hello', '--session', sessionId]],
    ['press Enter --ref @e2', ['press', 'Enter', '--ref', '@e2', '--session', sessionId]],
    ['select @e2 --value v1', ['select', '@e2', '--value', 'v1', '--session', sessionId]],
    ['focus @e2', ['focus', '@e2', '--session', sessionId]],
    ['scroll-to @e2', ['scroll-to', '@e2', '--session', sessionId]],
    ['reload', ['reload', '--session', sessionId]],
    ['back', ['back', '--session', sessionId]],
    ['forward', ['forward', '--session', sessionId]],
    ['wait-ms 30', ['wait-ms', '30', '--session', sessionId]],
    ['wait-for-element #x', ['wait-for-element', '#x', '--state', 'visible', '--json', '--session', sessionId]],
    ['window resize', ['window', 'resize', '--width', '800', '--height', '600', '--session', sessionId]],
    ['tab select', ['tab', 'select', '12', '--session', sessionId]],
    ['tab close', ['tab', 'close', '12', '--session', sessionId]],
  ];
  for (const [label, args] of actions) {
    const result = await runCli(args);
    const expectsJson = args.includes('--json');
    const ok = result.code === 0 && (expectsJson ? Boolean(jsonOf(result) && jsonOf(result).ok === true) : true);
    check(`${label} 成功`, ok, `${result.stdout}${result.stderr}`);
  }

  const snapshot = await runCli(['snapshot', '--session', sessionId]);
  check('snapshot 输出 document 行', snapshot.code === 0 && snapshot.stdout.includes('document'), snapshot.stdout);
  const consoleJson = jsonOf(await runCli(['console', '--json', '--session', sessionId]));
  check('console 返回 1 条记录', Boolean(consoleJson && consoleJson.result.entries.length === 1));
  const tabList = jsonOf(await runCli(['tab', 'list', '--json']));
  check('tab list 无需 session 可用', Boolean(tabList && tabList.ok === true && Array.isArray(tabList.result.tabs) && tabList.result.tabs.length >= 1));
  const tabNew = jsonOf(await runCli(['tab', 'new', 'https://new.example/', '--json']));
  check('tab new 返回 tabId', Boolean(tabNew && tabNew.ok === true && typeof tabNew.result.tabId === 'number'));

  // -------------------------------------------------------------------------
  section('7b. v0.2 方法面（mock 扩展，无真实浏览器）');
  const readRes = jsonOf(await runCli(['read', '--all', '--json', '--session', sessionId]));
  check('read --all 返回 fields', Boolean(readRes && readRes.ok === true && readRes.result.fields.length >= 1));

  const extractJson = jsonOf(await runCli(['extract', '--selector', 'table', '--json', '--session', sessionId]));
  check('extract 返回列与行', Boolean(extractJson && extractJson.result.rowCount === 1 && extractJson.result.columns[0].label === '姓名'));
  const csvPath = path.join(homeDir, 'extract.csv');
  const extractCsv = await runCli(['extract', '--selector', 'table', '--format', 'csv', '--out', csvPath, '--json', '--session', sessionId]);
  check('extract --format csv 落盘', extractCsv.code === 0 && fs.existsSync(csvPath) && fs.readFileSync(csvPath, 'utf8').includes('姓名'));

  const dragRes = await runCli(['drag', '@e1', '--to', '@e3', '--json', '--session', sessionId]);
  check('drag 成功', dragRes.code === 0 && Boolean(jsonOf(dragRes) && jsonOf(dragRes).ok === true));
  const wheelRes = await runCli(['wheel', '--delta-y', '-300', '--json', '--session', sessionId]);
  check('wheel 支持负 delta', wheelRes.code === 0 && Boolean(jsonOf(wheelRes) && jsonOf(wheelRes).ok === true));
  const blurRes = await runCli(['blur', '--json', '--session', sessionId]);
  check('blur 成功', blurRes.code === 0 && Boolean(jsonOf(blurRes) && jsonOf(blurRes).ok === true));

  const uploadFile = path.join(homeDir, 'up.txt');
  fs.writeFileSync(uploadFile, 'x', 'utf8');
  const uploadRes = jsonOf(await runCli(['upload', '@e2', '--file', uploadFile, '--json', '--session', sessionId]));
  check('upload 返回文件名', Boolean(uploadRes && uploadRes.ok === true && uploadRes.result.names[0] === 'up.txt'));

  const downloadRes = jsonOf(await runCli(['download', '#dl', '--json', '--session', sessionId]));
  check('download 返回文件路径', Boolean(downloadRes && downloadRes.ok === true && String(downloadRes.result.filename).length > 0));

  const planRes = jsonOf(await runCli(['plan', '--steps', '[{"method":"click","params":{"ref":"@e1"}},{"method":"fill","params":{"ref":"@e2","value":"x"}}]', '--json', '--session', sessionId]));
  check('plan 返回两步结果', Boolean(planRes && planRes.result.completed === 2 && planRes.result.failedAt === null));

  const dialogList = jsonOf(await runCli(['dialog', 'list', '--json', '--session', sessionId]));
  check('dialog list 返回记录', Boolean(dialogList && dialogList.result.dialogs.length === 1));
  const networkList = jsonOf(await runCli(['network', 'list', '--json', '--session', sessionId]));
  check('network list 返回条目', Boolean(networkList && networkList.result.entries.length === 1));

  const manualFrame = jsonOf(await runCli(['screenshot', '--mode', 'manual', '--json', '--session', sessionId]));
  check('screenshot --mode manual 返回帧数', Boolean(manualFrame && manualFrame.result.frames === 1));
  const stitchPath = path.join(homeDir, 'stitch.png');
  const stitch = await runCli(['screenshot', '--mode', 'manual', '--stitch', '--out', stitchPath, '--json', '--session', sessionId]);
  check('screenshot --stitch 落盘', stitch.code === 0 && fs.existsSync(stitchPath));

  const settingsBlocked = jsonOf(await runCli(['settings', 'set', '--borrow-confirm', 'off', '--json']));
  check('settings set --borrow-confirm 被拒绝（人工开关）', Boolean(settingsBlocked && settingsBlocked.ok === false && settingsBlocked.error && settingsBlocked.error.code === 'E_FORBIDDEN'));
  const settingsSet = jsonOf(await runCli(['settings', 'set', '--label', 'selftest', '--json']));
  check('settings set 生效', Boolean(settingsSet && settingsSet.result.settings.instanceLabel === 'selftest'));

  const borrowRes = await runCli(['tab', 'borrow', '12', '--json']);
  check('tab borrow 成功', borrowRes.code === 0 && Boolean(jsonOf(borrowRes) && jsonOf(borrowRes).ok === true));
  const returnRes = await runCli(['tab', 'return', '12', '--json']);
  check('tab return 成功', returnRes.code === 0 && Boolean(jsonOf(returnRes) && jsonOf(returnRes).ok === true));

  const helpRes = jsonOf(await runCli(['request-help', '--reason', 'x', '--json', '--session', sessionId]));
  check('request-help 返回 action', Boolean(helpRes && helpRes.ok === true && helpRes.result.action === 'done'));

  const viewRes = jsonOf(await runCli(['view', '--grep', 'textbox', '--json', '--session', sessionId]));
  check('view 命中观察缓存', Boolean(viewRes && viewRes.ok === true && viewRes.result.lines.length >= 1));

  section('7c. transfer.* staging（分块 / 偏移 / 读取 / 释放）');
  const transferBegin = await directRpc('transfer.begin', { session: sessionId, name: 'probe.txt', byteSize: 5 });
  const transferId = transferBegin && transferBegin.result && transferBegin.result.transferId;
  check(
    'transfer.begin 返回 transferId/chunkSize',
    Boolean(transferId && /^tr_[0-9a-f]{16}$/.test(transferId) && transferBegin.result.chunkSize > 0),
    JSON.stringify(transferBegin && transferBegin.result),
  );
  const transferChunk = await directRpc('transfer.chunk', { transferId, offset: 0, dataBase64: Buffer.from('hello').toString('base64') });
  check(
    'transfer.chunk 写入并标记 eof',
    Boolean(transferChunk && transferChunk.ok === true && transferChunk.result.nextOffset === 5 && transferChunk.result.eof === true),
    JSON.stringify(transferChunk),
  );
  const transferBadOffset = await directRpc('transfer.chunk', { transferId, offset: 0, dataBase64: 'YQ==' });
  check('transfer.chunk 拒绝不连续 offset', Boolean(transferBadOffset && transferBadOffset.error && transferBadOffset.error.code === 'E_TRANSFER_OFFSET'));
  const transferFinish = await directRpc('transfer.finish', { transferId });
  check(
    'transfer.finish 校验字节数',
    Boolean(transferFinish && transferFinish.ok === true && transferFinish.result.byteSize === 5),
    JSON.stringify(transferFinish),
  );
  const transferRead1 = await directRpc('transfer.read', { transferId, offset: 0, maxBytes: 3 });
  const transferRead2 = await directRpc('transfer.read', { transferId, offset: 3, maxBytes: 3 });
  check(
    'transfer.read 分块读回',
    Boolean(
      transferRead1 && transferRead1.ok === true &&
      Buffer.from(transferRead1.result.dataBase64, 'base64').toString() === 'hel' &&
      transferRead1.result.eof === false &&
      transferRead2 && Buffer.from(transferRead2.result.dataBase64, 'base64').toString() === 'lo' &&
      transferRead2.result.eof === true,
    ),
  );
  const transferRelease = await directRpc('transfer.release', { transferId });
  const transferRelease2 = await directRpc('transfer.release', { transferId });
  check(
    'transfer.release 幂等',
    Boolean(transferRelease && transferRelease.result.released === true && transferRelease2 && transferRelease2.result.released === false),
  );
  const transferBadName = await directRpc('transfer.begin', { session: sessionId, name: '../evil.txt', byteSize: 1 });
  check('transfer 拒绝路径穿越文件名', Boolean(transferBadName && transferBadName.error && transferBadName.error.code === 'E_BAD_ARG'));

  // -------------------------------------------------------------------------
  section('8. 参数错误 / 业务错误与退出码');
  const noOut = await runCli(['screenshot', '--session', sessionId]);
  check('screenshot 缺 --out → 退出码 2', noOut.code === 2, `${noOut.stdout}${noOut.stderr}`);
  const fillNoValue = await runCli(['fill', '@e2']);
  check('fill 缺 --value → 退出码 2', fillNoValue.code === 2, `${fillNoValue.stdout}${fillNoValue.stderr}`);
  const unknownCommand = await runCli(['frobnicate']);
  check('未知命令 → 退出码 2', unknownCommand.code === 2, `${unknownCommand.stdout}${unknownCommand.stderr}`);
  const badSession = await runCli(['observe', '--session', 'zzzz', '--json']);
  check('不存在的 session → 退出码 1 + E_NO_SESSION', badSession.code === 1 && jsonOf(badSession) && jsonOf(badSession).error.code === 'E_NO_SESSION', badSession.stdout + badSession.stderr);

  const slow = await runCli(['evaluate', 'delay:2000', '--timeout', '300', '--json', '--session', sessionId]);
  check('命令超时 → 退出码 1 + E_TIMEOUT', slow.code === 1 && jsonOf(slow) && jsonOf(slow).error.code === 'E_TIMEOUT', `${slow.stdout}${slow.stderr}`);
  await sleep(2200); // 等 mock 的迟到回包到达 daemon（应被丢弃）
  const afterLate = await runCli(['status', '--json']);
  check('迟到回包被丢弃、daemon 仍正常', afterLate.code === 0 && jsonOf(afterLate) && jsonOf(afterLate).ok === true, `${afterLate.stdout}${afterLate.stderr}`);

  // -------------------------------------------------------------------------
  section('9. 多 session 消歧（PROTOCOL §7）');
  const start2 = jsonOf(await runCli(['session', 'start', '--json']));
  const session2 = start2 && start2.result && start2.result.sessionId;
  check('第二个 session 创建成功', /^[a-z]{4}$/.test(session2 || ''), JSON.stringify(start2));
  check('两个 session id 不同', Boolean(session2 && session2 !== sessionId));

  const ambiguous = await runCli(['navigate', 'https://x.example/', '--json']);
  const ambiguousJson = jsonOf(ambiguous);
  check('多 session 且省略 --session → 退出码 1 + E_NO_SESSION', ambiguous.code === 1 && ambiguousJson && ambiguousJson.error.code === 'E_NO_SESSION', ambiguous.stdout + ambiguous.stderr);
  check('E_NO_SESSION 消息列出候选 session', Boolean(ambiguousJson && String(ambiguousJson.error.message).includes(sessionId) && String(ambiguousJson.error.message).includes(session2)));

  const stop2 = await runCli(['session', 'stop', session2, '--json']);
  check('session stop 指定 id 成功', stop2.code === 0 && jsonOf(stop2) && jsonOf(stop2).ok === true, stop2.stdout + stop2.stderr);
  const navAgain = await runCli(['navigate', 'https://again.example/', '--json']);
  check('去掉多余 session 后自动选用恢复', navAgain.code === 0 && jsonOf(navAgain) && jsonOf(navAgain).result.url === 'https://again.example/', navAgain.stdout + navAgain.stderr);

  const stop1 = await runCli(['session', 'stop', sessionId]);
  check('session stop 人类输出成功', stop1.code === 0, stop1.stderr);
  const listAfter = jsonOf(await runCli(['session', 'list', '--json']));
  check('session stop 后 session.list 为空', Boolean(listAfter && listAfter.ok === true && listAfter.result.sessions.length === 0));
  check('daemon 无残留 session', Boolean(jsonOf(await runCli(['status', '--json'])).result.sessions.length === 0));

  // -------------------------------------------------------------------------
  section('10. 实例断开清理与重连 instanceId 复用');
  mockProc.kill();
  const cleaned = await waitFor(async () => {
    const result = await directRpc('status');
    return Boolean(result && result.ok && result.result.browsers.length === 0);
  }, 8_000, 150);
  check('mock 退出后 daemon 清理实例', cleaned);

  startMockProcess(['--instance-id', instanceId]);
  const reconnected = await waitFor(async () => {
    const result = await directRpc('status');
    return Boolean(result && result.ok && result.result.browsers.length === 1);
  }, 8_000, 150);
  check('mock 重连成功', reconnected);
  const status5 = jsonOf(await runCli(['status', '--json']));
  check('重连沿用 hello.instanceId 提示', Boolean(status5 && status5.result.browsers[0] && status5.result.browsers[0].instanceId === instanceId), JSON.stringify(status5 && status5.result.browsers));

  // -------------------------------------------------------------------------
  section('10b. update 发布清单校验');
  const updateCheck = jsonOf(await runCli(['update', 'check', '--json']));
  check(
    'update check 校验 SHA256/字节数',
    Boolean(updateCheck && updateCheck.ok === true && updateCheck.result.verified === true && (updateCheck.result.artifacts || []).length >= 2),
    JSON.stringify(updateCheck && updateCheck.result),
  );
  const updateAlias = jsonOf(await runCli(['update', '--check', '--json']));
  check('update --check 别名可用', Boolean(updateAlias && updateAlias.result && updateAlias.result.verified === true));
  const updateMissing = jsonOf(await runCli(['update', 'check', '--manifest', path.join(homeDir, 'nope.json'), '--json']));
  check('update 缺清单时明确报告', Boolean(updateMissing && updateMissing.result && updateMissing.result.verified === false && updateMissing.result.note));

  const stageDir = path.join(homeDir, 'update-stage');
  const staged = jsonOf(await runCli(['update', 'stage', '--dir', stageDir, '--json']));
  const stagedFiles = (staged && staged.result && staged.result.artifacts) || [];
  check(
    'update stage 落盘并校验 SHA256',
    Boolean(
      staged && staged.ok === true && staged.result.verified === true && stagedFiles.length >= 2 &&
      stagedFiles.every((item) => fs.existsSync(path.join(staged.result.dir, item.name))) &&
      fs.existsSync(path.join(staged.result.dir, 'staged.json')),
    ),
    JSON.stringify(staged && staged.result),
  );
  const stagedAgain = jsonOf(await runCli(['update', 'stage', '--dir', stageDir, '--json']));
  check('update stage 默认拒绝覆盖非空目录', Boolean(stagedAgain && stagedAgain.error && stagedAgain.error.code === 'E_EXISTS'));

  const keyPath = path.join(homeDir, 'release.key');
  fs.writeFileSync(keyPath, 'selftest-secret\n', 'utf8');
  const baseManifest = JSON.parse(fs.readFileSync(path.join(REPO, 'dist', 'release.json'), 'utf8'));
  const signedManifest = { ...baseManifest, signature: signRelease(baseManifest, 'selftest-secret') };
  const signedPath = path.join(homeDir, 'release-signed.json');
  fs.writeFileSync(signedPath, JSON.stringify(signedManifest, null, 2), 'utf8');
  const signedCheck = jsonOf(await runCli(['update', 'check', '--manifest', signedPath, '--key', keyPath, '--json']));
  check('update check 校验 HMAC 签名', Boolean(signedCheck && signedCheck.result && signedCheck.result.signature && signedCheck.result.signature.valid === true), JSON.stringify(signedCheck && signedCheck.result));
  const tamperedManifest = JSON.parse(JSON.stringify(signedManifest));
  tamperedManifest.artifacts[0].bytes += 1;
  const tamperedPath = path.join(homeDir, 'release-tampered.json');
  fs.writeFileSync(tamperedPath, JSON.stringify(tamperedManifest, null, 2), 'utf8');
  const tamperedCheck = jsonOf(await runCli(['update', 'check', '--manifest', tamperedPath, '--key', keyPath, '--json']));
  check('update check 发现签名被篡改', Boolean(tamperedCheck && tamperedCheck.result && tamperedCheck.result.signature && tamperedCheck.result.signature.valid === false));

  const releaseServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(signedManifest));
  });
  await new Promise((resolve) => releaseServer.listen(0, '127.0.0.1', resolve));
  const releasePort = releaseServer.address().port;
  const fetchedPath = path.join(homeDir, 'release-fetched.json');
  try {
    const fetched = jsonOf(await runCli(['update', 'fetch', '--source', 'http://127.0.0.1:' + releasePort + '/release.json', '--out', fetchedPath, '--key', keyPath, '--json']));
    check('update fetch 拉取并校验远程清单', Boolean(fetched && fetched.result && fetched.result.version === baseManifest.version && fetched.result.signature.valid === true && fs.existsSync(fetchedPath)), JSON.stringify(fetched && fetched.result));
    const state = jsonOf(await runCli(['update', 'state', '--json']));
    check('update state 记录 lastFetch', Boolean(state && state.result && state.result.state && state.result.state.lastFetch && state.result.state.lastFetch.version === baseManifest.version));

    const autoOn = jsonOf(await runCli(['update', 'auto', '--enable', '--source', 'https://example.com/release.json', '--interval', '1h', '--apply', '--target', homeDir, '--json']));
    check('update auto 配置开启', Boolean(autoOn && autoOn.result && autoOn.result.auto && autoOn.result.auto.enabled === true && autoOn.result.auto.apply === true && autoOn.result.auto.applyTarget));
    const autoOff = jsonOf(await runCli(['update', 'auto', '--disable', '--json']));
    check('update auto 配置关闭', Boolean(autoOff && autoOff.result && autoOff.result.auto && autoOff.result.auto.enabled === false));
  } finally {
    await new Promise((resolve) => releaseServer.close(resolve));
  }

  const applyTarget = path.join(homeDir, 'update-target');
  fs.mkdirSync(applyTarget, { recursive: true });
  const firstArtifact = stagedFiles[0];
  const targetFile = path.join(applyTarget, firstArtifact.name);
  fs.writeFileSync(targetFile, 'old', 'utf8');
  const applied = jsonOf(await runCli(['update', 'apply', '--staging', staged.result.dir, '--target', applyTarget, '--json']));
  check(
    'update apply 写入并备份旧文件',
    Boolean(
      applied && applied.ok === true && applied.result && applied.result.backupDir &&
      fs.existsSync(path.join(applied.result.backupDir, 'backup.json')) &&
      fs.readFileSync(targetFile).length === firstArtifact.bytes,
    ),
    JSON.stringify(applied && applied.result && applied.result.files),
  );
  const rolledBack = applied && applied.result
    ? jsonOf(await runCli(['update', 'rollback', '--backup', applied.result.backupDir, '--json']))
    : null;
  check(
    'update rollback 恢复旧文件',
    Boolean(rolledBack && rolledBack.ok === true && fs.readFileSync(targetFile, 'utf8') === 'old'),
    JSON.stringify(rolledBack),
  );

  section('11. doctor 与 daemon stop');
  const doctor = await runCli(['doctor']);
  check('bridge doctor 退出码 0', doctor.code === 0, `${doctor.stdout}${doctor.stderr}`);
  check('doctor 输出 daemon/token 检查项', doctor.stdout.includes('daemon') && doctor.stdout.includes('token'), doctor.stdout);
  const doctorJson = jsonOf(await runCli(['doctor', '--json']));
  check('doctor --json 单行 JSON 且 ok=true', Boolean(doctorJson && doctorJson.ok === true));

  mockProc.kill();
  await waitFor(async () => {
    const current = await health();
    return Boolean(current && current.browsers === 0);
  }, 8_000, 150);

  const daemonStop = await runCli(['daemon', 'stop']);
  check('bridge daemon stop 优雅停止', daemonStop.code === 0 && daemonStop.stdout.includes('已停止'), `${daemonStop.stdout}${daemonStop.stderr}`);
  check('daemon /health 消失', await waitFor(async () => !(await health()), 6_000, 120));
  check('daemon.json 已清理', !fs.existsSync(DAEMON_JSON()));
  check('前台 daemon 进程已退出', await waitFor(async () => daemonProc.exitCode !== null, 6_000, 120));

  // -------------------------------------------------------------------------
  section('12. daemon 自动拉起（CLI detached）');
  const autoStatus = await runCli(['status', '--json']);
  check('无 daemon 时 CLI 自动拉起并返回 0', autoStatus.code === 0 && jsonOf(autoStatus) && jsonOf(autoStatus).ok === true, `${autoStatus.stdout}${autoStatus.stderr}`);
  const autoInfo = readDaemonInfo();
  check('自动拉起的 daemon 写好 daemon.json', Boolean(autoInfo && typeof autoInfo.port === 'number'));
  check('自动拉起的 daemon 监听 BB_PORT', Boolean(autoInfo && autoInfo.port === port), `json.port=${autoInfo && autoInfo.port} BB_PORT=${port}`);
  check('自动拉起的 daemon /health 正常', Boolean(await health()));

  const autoStop = await runCli(['daemon', 'stop']);
  check('自动拉起的 daemon 可被 daemon stop 清理', autoStop.code === 0, `${autoStop.stdout}${autoStop.stderr}`);
  check('CLI 自动拉起的 daemon 已退出', await waitFor(async () => !(await health()), 6_000, 120));
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

async function cleanup() {
  try {
    if (mockProc && mockProc.exitCode === null) mockProc.kill();
  } catch { /* 忽略 */ }
  try {
    if (readDaemonInfo()) await runCli(['daemon', 'stop'], { timeoutMs: 8000 });
  } catch { /* 忽略 */ }
  await sleep(200);
  try {
    if (daemonProc && daemonProc.exitCode === null) daemonProc.kill();
  } catch { /* 忽略 */ }
  const current = await health();
  if (current && current.pid) {
    try { process.kill(current.pid); } catch { /* 忽略 */ }
    await sleep(200);
  }
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.rmSync(homeDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(200);
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  try {
    await runTests();
  } catch (err) {
    failCount += 1;
    failures.push('uncaught');
    console.log(`\n[FATAL] ${err && err.stack ? err.stack : err}`);
    if (daemonOutput.length) console.log(`\n--- daemon log ---\n${daemonOutput.join('')}`);
    if (mockOutput.length) console.log(`\n--- mock log ---\n${mockOutput.join('')}`);
  } finally {
    await cleanup();
  }

  console.log('\n== 结果 ==');
  console.log(`通过 ${passCount} 项，失败 ${failCount} 项`);
  if (failCount > 0) {
    console.log('失败项：');
    for (const name of failures) console.log(`  - ${name}`);
    console.log('SELFTEST FAIL');
    return 1;
  }
  console.log('SELFTEST PASS');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
    const timer = setTimeout(() => process.exit(code), 1000);
    timer.unref();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
