// tests/extension/mock-daemon.mjs
// 独立 mock daemon：用 Node 内置模块 + lib/ws.mjs（只 import，不修改）模拟 daemon，
// 让扩展连上来后自动跑一遍 hello → navigate → observe → fill → click → get-html 等断言。
//
// 用法：
//   node tests/extension/mock-daemon.mjs                 # 等待手动在浏览器里加载 extension/
//   node tests/extension/mock-daemon.mjs --launch edge   # 自动启动独立 user-data-dir 的 Edge 并跑
//   node tests/extension/mock-daemon.mjs --launch chrome --timeout 90
//
// 说明：扩展硬编码候选端口 52900..52909（PROTOCOL.md §1），mock daemon 占用其中第一个可用端口。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachWsServer } from '../../lib/ws.mjs';
import { browserArgs, prepareBrowserProfile } from '../../tools/browser-launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_PATH = path.join(HERE, 'self-test.html');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const PORT_CANDIDATES = Array.from({ length: 10 }, (_, index) => 52900 + index);
const BROWSERS = {
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};

function timestamp() {
  return new Date().toISOString();
}
function log(...args) {
  console.log(`[mock ${timestamp()}]`, ...args);
}
function warn(...args) {
  console.warn(`[mock ${timestamp()}]`, ...args);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 参数 ----------
function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}
const launchRaw = getArg('--launch', '');
const launchTarget = launchRaw === true ? 'edge' : launchRaw;
const connectTimeoutMs = Number(getArg('--timeout', 120)) * 1000;
const keepOpen = process.argv.includes('--keep-open');

// ---------- 断言 ----------
const results = [];
function check(name, passed, detail) {
  const ok = Boolean(passed);
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
  return ok;
}
function summary() {
  const failed = results.filter((item) => !item.ok);
  log(`===== 断言结果：${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    for (const item of failed) warn(`FAILED: ${item.name} — ${item.detail || ''}`);
  }
  return failed.length === 0;
}

// ---------- 状态 ----------
let server = null;
let listenPort = 0;
let wsConn = null;
let helloMessage = null;
let scenarioStarted = false;
let scenarioPromise = null;
let browserProcess = null;
let browserExited = false;
let profileDir = null;
let pongWaiter = null;
let firstInstanceId = null;
let reconnectWaiter = null;
const pending = new Map();

// ---------- HTTP + WS ----------
function handleHttpRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    const body = JSON.stringify({
      ok: true,
      service: 'browser-bridge-mock',
      port: listenPort,
      browsers: wsConn ? 1 : 0,
      pid: process.pid,
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (url.pathname === '/self-test.html' || url.pathname === '/test.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(FIXTURE_PATH).pipe(res);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function createBridgeServer() {
  const bridgeServer = http.createServer(handleHttpRequest);
  attachWsServer(bridgeServer, (conn, req) => {
    log(`收到扩展 WS 连接 role=${conn.query.get('role')} v=${conn.query.get('v')} remote=${req.socket.remoteAddress}`);
    wsConn = conn;
    conn.on('message', (data, isBinary) => {
      if (isBinary) return;
      handleWsMessage(conn, String(data));
    });
    conn.on('close', () => {
      log('扩展 WS 连接关闭');
      if (wsConn === conn) wsConn = null;
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`WS 在等待 ${entry.method} 回包时断开`));
        pending.delete(id);
      }
    });
  });
  return bridgeServer;
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const bridgeServer = createBridgeServer();
    const onError = (error) => {
      bridgeServer.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      bridgeServer.removeListener('error', onError);
      resolve(bridgeServer);
    };
    bridgeServer.once('error', onError);
    bridgeServer.once('listening', onListening);
    bridgeServer.listen(port, '127.0.0.1');
  });
}

async function startServer() {
  for (const port of PORT_CANDIDATES) {
    try {
      server = await listenOnce(port);
      listenPort = port;
      log(`mock daemon 监听 http://127.0.0.1:${port}（扩展候选端口之一）`);
      return;
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        log(`端口 ${port} 已被占用，尝试下一个`);
        continue;
      }
      throw error;
    }
  }
  throw new Error('52900..52909 全部被占用，无法启动 mock daemon');
}

function handleWsMessage(conn, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    warn('收到非 JSON 帧，忽略');
    return;
  }
  switch (message.type) {
    case 'hello': {
      helloMessage = message;
      const instanceId = crypto.randomBytes(4).toString('hex');
      if (!firstInstanceId) firstInstanceId = instanceId;
      log(`hello: ext=${message.extVersion} browser=${message.browser} browserVersion=${message.browserVersion} hint=${message.instanceId || '-'}`);
      conn.sendJson({ type: 'hello-ack', instanceId, daemonVersion: '0.1.1' });
      if (reconnectWaiter) {
        const resolve = reconnectWaiter;
        reconnectWaiter = null;
        resolve(message);
      }
      if (!scenarioStarted) {
        scenarioStarted = true;
        scenarioPromise = runScenario().catch((error) => {
          check('场景执行未抛异常', false, String((error && error.stack) || error));
        });
      }
      return;
    }
    case 'pong':
      if (pongWaiter) {
        const resolve = pongWaiter;
        pongWaiter = null;
        resolve(true);
      }
      return;
    case 'res': {
      const entry = pending.get(message.id);
      if (!entry) {
        warn(`收到未知 id 的 res: ${message.id}`);
        return;
      }
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) {
        entry.resolve(message.result);
      } else {
        const error = new Error(message.error && message.error.message ? message.error.message : '扩展返回失败');
        error.code = message.error && message.error.code ? message.error.code : 'E_INTERNAL';
        entry.reject(error);
      }
      return;
    }
    case 'event':
      log(`收到事件 ${message.event} ${JSON.stringify(message.params || {})}`);
      return;
    default:
      warn('未知消息类型', message.type);
  }
}

function call(method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!wsConn) {
      reject(new Error('扩展未连接'));
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`命令 ${method} 等待回包超时（${timeoutMs}ms）`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method });
    log(`-> ${method} ${JSON.stringify(params).slice(0, 160)}`);
    wsConn.sendJson({ type: 'cmd', id, method, params, timeoutMs });
  });
}

async function callExpectError(method, params = {}, timeoutMs = 20000) {
  try {
    const result = await call(method, params, timeoutMs);
    throw new Error(`期望 ${method} 返回错误，但成功了: ${JSON.stringify(result).slice(0, 200)}`);
  } catch (error) {
    if (error.code && String(error.code).startsWith('E_')) return error;
    throw error;
  }
}

function waitForPong(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    pongWaiter = resolve;
    wsConn.sendJson({ type: 'ping' });
    setTimeout(() => {
      if (pongWaiter === resolve) {
        pongWaiter = null;
        reject(new Error('等待 pong 超时'));
      }
    }, timeoutMs);
  });
}

function findRef(observation, role, name) {
  const pattern = new RegExp(`- ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^\\n]*\\[@e(\\d+)\\]`);
  const match = pattern.exec(observation);
  return match ? `@e${match[1]}` : null;
}

// ---------- 浏览器 ----------
function launchBrowser(target) {
  const executable = BROWSERS[target];
  if (!executable) throw new Error(`--launch 只支持 edge|chrome，收到: ${target}`);
  if (!fs.existsSync(executable)) throw new Error(`找不到浏览器: ${executable}`);
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`找不到扩展: ${EXTENSION_DIR}`);
  }
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ext-test-'));
  prepareBrowserProfile(profileDir);
  const args = browserArgs({
    profileDir,
    extensionDir: EXTENSION_DIR,
    newWindow: true,
  });
  log(`启动 ${target}: ${executable}`);
  log(`参数: ${args.join(' ')}`);
  browserProcess = spawn(executable, args, { stdio: 'ignore' });
  browserProcess.on('exit', (code) => {
    browserExited = true;
    log(`浏览器进程退出 code=${code}`);
  });
  browserProcess.on('error', (error) => {
    browserExited = true;
    warn('浏览器启动失败', error && error.message);
  });
  profileDirAbsoluteCheck();
  return browserProcess.pid;
}

function profileDirAbsoluteCheck() {
  const absolute = path.resolve(profileDir);
  const temp = path.resolve(os.tmpdir());
  if (!absolute.startsWith(temp + path.sep) || !path.basename(absolute).startsWith('bb-ext-test-')) {
    throw new Error(`拒绝删除非预期的临时目录: ${absolute}`);
  }
}

function killBrowser() {
  if (!browserProcess || browserExited) return;
  const pid = browserProcess.pid;
  log(`终止浏览器进程树 pid=${pid}`);
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch (error) {
    warn('终止浏览器失败', error && error.message);
  }
  browserProcess = null;
}

function removeProfileDir() {
  if (!profileDir) return;
  try {
    profileDirAbsoluteCheck();
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
    log(`已清理临时 profile: ${profileDir}`);
  } catch (error) {
    warn(`清理临时 profile 失败（可手动删除）: ${profileDir} — ${error && error.message}`);
  }
  profileDir = null;
}

// ---------- 场景 ----------
function fixtureUrl() {
  return `http://127.0.0.1:${listenPort}/self-test.html`;
}

async function runScenario() {
  log('===== 开始 mock daemon 自测 =====');
  check(
    'hello 字段完整',
    helloMessage &&
      helloMessage.type === 'hello' &&
      typeof helloMessage.extVersion === 'string' &&
      /^(edge|chrome|opera)$/.test(String(helloMessage.browser)) &&
      typeof helloMessage.userAgent === 'string',
    JSON.stringify({
      extVersion: helloMessage && helloMessage.extVersion,
      browser: helloMessage && helloMessage.browser,
      browserVersion: helloMessage && helloMessage.browserVersion,
    }),
  );

  const pong = await waitForPong(5000).catch(() => false);
  check('daemon ping → 扩展 pong', pong);

  const agent = await call('window.ensureAgent', { noFocus: true }, 30000);
  check(
    'window.ensureAgent 返回 tabId/windowId',
    Number.isInteger(agent.tabId) && Number.isInteger(agent.windowId),
    JSON.stringify(agent),
  );
  const tabId = agent.tabId;

  const targetUrl = fixtureUrl();
  const nav = await call('navigate', { tabId, url: targetUrl }, 40000);
  check('navigate 后 url 正确', String(nav.url).startsWith(targetUrl), JSON.stringify(nav));
  check('navigate 后 title 正确', nav.title === 'Mock Bridge Test', nav.title);

  const waited = await call('wait-for-element', { tabId, selector: '#submit', state: 'visible', timeoutMs: 8000 });
  check('wait-for-element #submit visible', waited && waited.ok === true);

  const observation = await call('observe', { tabId }, 30000);
  log(`observe 文本（${observation.refs} 个 ref）：\n${observation.observation}`);
  check(
    'observe 返回 url/title',
    String(observation.url).startsWith(targetUrl) && observation.title === 'Mock Bridge Test',
    `${observation.url} / ${observation.title}`,
  );
  check('observe 含 heading', /heading "Mock Bridge Test" \[level=1\]/.test(observation.observation));
  check('observe 含 textbox "Name"', /textbox "Name"/.test(observation.observation));
  check('observe 含 button "Submit"', /button "Submit"/.test(observation.observation));
  check('observe 含 @eN ref', /\[@e\d+\]/.test(observation.observation));
  check('observe refs >= 3', Number.isInteger(observation.refs) && observation.refs >= 3, String(observation.refs));

  const textboxRef = findRef(observation.observation, 'textbox', 'Name');
  const buttonRef = findRef(observation.observation, 'button', 'Submit');
  check('从 observe 提取 textbox/button ref', Boolean(textboxRef && buttonRef), `${textboxRef} / ${buttonRef}`);

  const filled = await call('fill', { tabId, ref: textboxRef, value: 'hello' }, 20000);
  check('fill @ref 成功', filled && filled.ok === true);

  const clicked = await call('click', { tabId, ref: buttonRef }, 20000);
  check('click @ref 成功', clicked && clicked.ok === true);

  const html = await call('get-html', { tabId, selector: '#out' }, 20000);
  const outHtml = String((html && html.html) || '');
  check('get-html 断言 #out 文本为 clicked', /id="out"[^>]*>\s*clicked\s*</.test(outHtml), outHtml.slice(0, 200));

  const evaluated = await call(
    'evaluate',
    {
      tabId,
      expression: `document.getElementById('name').value + '|' + document.getElementById('out').textContent`,
    },
    20000,
  );
  check('evaluate 读取页面状态', evaluated && evaluated.value === 'hello|clicked', JSON.stringify(evaluated));

  const consoleResult = await call('console', { tabId }, 20000);
  const entries = (consoleResult && consoleResult.entries) || [];
  check('console 返回数组', Array.isArray(entries), `${entries.length} 条`);
  check(
    'console 捕获到页面日志',
    entries.some((entry) => String(entry.text).includes('submit clicked')),
    entries.map((entry) => entry.text).join(' | ').slice(0, 300),
  );

  const unknown = await callExpectError('no-such-method', { tabId });
  check('未知方法返回 E_UNKNOWN_METHOD', unknown.code === 'E_UNKNOWN_METHOD', unknown.message);

  const badArg = await callExpectError('click', { tabId, ref: buttonRef, selector: '#submit' });
  check('ref 与 selector 同时给返回 E_BAD_ARG', badArg.code === 'E_BAD_ARG', badArg.message);

  const listed = await call('tab.list', { scope: 'agent' }, 20000);
  check(
    'tab.list --scope agent 含目标 tab',
    Array.isArray(listed.tabs) && listed.tabs.some((tab) => tab.tabId === tabId),
    JSON.stringify(listed.tabs && listed.tabs.map((tab) => tab.tabId)),
  );

  // 重新 navigate（同 URL 会 reload）后旧 ref 应失效
  await call('navigate', { tabId, url: targetUrl }, 40000);
  const stale = await callExpectError('click', { tabId, ref: buttonRef }, 20000);
  check('导航后旧 ref 返回 E_STALE_REF', stale.code === 'E_STALE_REF', stale.message);

  // 重新 observe 拿新 ref，覆盖其余页面命令
  await call('observe', { tabId }, 30000);
  const probeObs = await call('observe', { tabId, probeHover: true }, 30000);
  check(
    'observe --probe-hover 输出 hover 提示',
    /\[hover first: Alpha \| Beta\]/.test(probeObs.observation),
    probeObs.observation.split('\n').find((line) => line.includes('hover first')) || probeObs.observation.slice(0, 200),
  );
  const textboxRef2 = findRef(probeObs.observation, 'textbox', 'Name');
  const delayedRef = findRef(probeObs.observation, 'button', 'Delayed nav');
  check('重新 observe 后 ref 可用', Boolean(textboxRef2 && delayedRef), `${textboxRef2} / ${delayedRef}`);

  const htmlByRef = await call('get-html', { tabId, ref: textboxRef2 }, 20000);
  check('get-html --ref 返回元素 HTML', /<input[^>]*id="name"/.test(String(htmlByRef && htmlByRef.html)));

  const fullHtml = await call('get-html', { tabId }, 20000);
  check(
    'get-html 无参返回整页 HTML',
    /<title>Mock Bridge Test<\/title>/.test(String(fullHtml && fullHtml.html)),
  );

  const snapshotResult = await call('snapshot', { tabId }, 20000);
  check(
    'snapshot 不含 ref 且含 heading',
    typeof snapshotResult.text === 'string' &&
      /heading "Mock Bridge Test"/.test(snapshotResult.text) &&
      !/@e\d+/.test(snapshotResult.text),
  );

  const selected = await call('select', { tabId, selector: '#color', value: 'blue' }, 20000);
  check('select 成功', selected && selected.ok === true);
  const colorValue = await call('evaluate', {
    tabId,
    expression: `document.getElementById('color').value`,
  });
  check('select 生效', colorValue.value === 'blue', JSON.stringify(colorValue));

  const focusResult = await call('focus', { tabId, selector: '#name' }, 20000);
  const activeId = await call('evaluate', {
    tabId,
    expression: `document.activeElement && document.activeElement.id`,
  });
  check('focus 生效', focusResult.ok === true && activeId.value === 'name', JSON.stringify(activeId));

  const pressResult = await call('press', { tabId, key: 'Tab', selector: '#name' }, 20000);
  check('press 成功', pressResult.ok === true);
  const hoverResult = await call('hover', { tabId, selector: '#submit' }, 20000);
  check('hover 成功', hoverResult.ok === true);
  const scrollResult = await call('scroll-to', { tabId, selector: '#tall' }, 20000);
  check('scroll-to 成功', scrollResult.ok === true);

  const attached = await call('wait-for-element', { tabId, selector: '#submit', state: 'attached', timeoutMs: 2000 });
  check('wait-for-element attached', attached.ok === true);
  const hidden = await call('wait-for-element', { tabId, selector: '#not-exist', state: 'hidden', timeoutMs: 2000 });
  check('wait-for-element hidden 立即满足', hidden.ok === true);
  const detached = await call('wait-for-element', { tabId, selector: '#not-exist', state: 'detached', timeoutMs: 2000 });
  check('wait-for-element detached 立即满足', detached.ok === true);

  const resized = await call('window.resize', { tabId, width: 900, height: 700 }, 20000);
  check('window.resize 成功', resized.ok === true);

  const newTab = await call('tab.new', { url: 'about:blank', noFocus: true }, 20000);
  check('tab.new 返回新 tabId', Number.isInteger(newTab.tabId) && newTab.tabId !== tabId, JSON.stringify(newTab));
  const closed = await call('tab.close', { tabId: newTab.tabId }, 20000);
  check('tab.close 成功', closed.ok === true);

  // screenshot 软检查：截图需要临时置前目标窗口，失败不算致命
  try {
    const shot = await call('screenshot', { tabId }, 40000);
    check(
      'screenshot 返回 PNG dataUrl 且尺寸合理',
      typeof shot.dataUrl === 'string' &&
        shot.dataUrl.startsWith('data:image/png;base64,') &&
        shot.width > 100 &&
        shot.height > 100,
      `${shot.width}x${shot.height}`,
    );
  } catch (error) {
    warn(`screenshot 软检查失败（不影响主流程）: ${error.message}`);
  }

  // 页面已撑高，fullPage 应走拼接路径
  try {
    const fullShot = await call('screenshot', { tabId, fullPage: true }, 45000);
    check(
      'screenshot fullPage 尺寸大于视口',
      typeof fullShot.dataUrl === 'string' && fullShot.dataUrl.startsWith('data:image/png;base64,') && fullShot.height > 700,
      `${fullShot.width}x${fullShot.height}`,
    );
  } catch (error) {
    warn(`screenshot fullPage 软检查失败（不影响主流程）: ${error.message}`);
  }

  // wait-for-navigation：点延迟导航按钮（500ms 后跳转），随后等待导航完成
  await call('click', { tabId, ref: delayedRef }, 20000);
  const navWait = await call('wait-for-navigation', { tabId, timeoutMs: 15000 }, 20000);
  check('wait-for-navigation 等到新 url', String(navWait.url).includes('nav=1'), JSON.stringify(navWait));

  // 断线重连：关闭 WS 后扩展应 3s 内重连，并在 hello 里带上上次的 instanceId 作为提示
  const reconnectHelloPromise = new Promise((resolve) => {
    reconnectWaiter = resolve;
    setTimeout(() => resolve(null), 20000);
  });
  if (wsConn) wsConn.close(1000, 'mock reconnect test');
  const reHello = await reconnectHelloPromise;
  check(
    '断线重连后 hello 带 instanceId 提示',
    reHello && reHello.type === 'hello' && reHello.instanceId === firstInstanceId,
    JSON.stringify({ hint: reHello && reHello.instanceId, first: firstInstanceId }),
  );
  const pongAfterReconnect = await waitForPong(5000).catch(() => false);
  check('重连后 ping → pong', pongAfterReconnect);

  log('===== mock daemon 自测结束 =====');
}

// ---------- 主流程 ----------
async function main() {
  if (launchTarget) {
    log('注意：--launch 会使用独立临时 user-data-dir，结束后精确杀进程树并清理 profile');
  }
  await startServer();
  if (launchTarget) {
    const pid = launchBrowser(launchTarget);
    log(`浏览器 pid=${pid}，等待扩展连接（最长 ${connectTimeoutMs / 1000}s）…`);
  } else {
    log('等待扩展连接：请在 Edge/Chrome 里加载 D:\\BridgeDeck\\extension（edge://extensions → 开发者模式 → 加载解压缩的扩展）');
    log(`最长等待 ${connectTimeoutMs / 1000}s；也可以用 --launch edge 自动启动`);
  }

  const deadline = Date.now() + connectTimeoutMs;
  while (!scenarioStarted && Date.now() < deadline) {
    if (browserExited) {
      throw new Error('浏览器进程提前退出，扩展未能连接');
    }
    await sleep(200);
  }
  if (!scenarioStarted) {
    throw new Error(`等待扩展连接超时（${connectTimeoutMs / 1000}s）`);
  }
  await scenarioPromise;

  if (keepOpen) {
    log('--keep-open：保持运行，Ctrl+C 退出');
    return new Promise(() => {});
  }

  const passed = summary();
  cleanup();
  process.exitCode = passed ? 0 : 1;
}

function cleanup() {
  killBrowser();
  if (wsConn) {
    try {
      wsConn.close(1000, 'mock daemon done');
    } catch {
      // 忽略
    }
    wsConn = null;
  }
  if (server) {
    try {
      server.close();
    } catch {
      // 忽略
    }
  }
  setTimeout(() => {
    removeProfileDir();
    log(`完成，退出码=${process.exitCode || 0}`);
    process.exit(process.exitCode || 0);
  }, 300);
}

let exiting = false;
function handleSignal(signal) {
  if (exiting) return;
  exiting = true;
  warn(`收到 ${signal}，清理后退出`);
  killBrowser();
  removeProfileDir();
  process.exit(130);
}
process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

main().catch((error) => {
  check('mock daemon 主流程完成', false, String((error && error.stack) || error));
  const passed = summary();
  cleanup();
  process.exitCode = passed ? 0 : 1;
});
