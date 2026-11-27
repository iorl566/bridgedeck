#!/usr/bin/env node
// tools/ui-shots-e2e.mjs —— 用 E2E 同款启动链（daemon + 扩展 + 有头 Edge）截图全部 UI 页面。
//
// 为什么：Edge 会阻止 CDP 直接顶层导航 chrome-extension://（ERR_BLOCKED_BY_CLIENT），
// 而隔离 profile 里扩展 SW 又不会被唤醒。这里复用已验证的 E2E 启动方式：
//   我们：临时 BB_HOME + daemon --foreground + 复制扩展并改写探测端口 + 有头 Edge
//   参考实现：临时 BSK_HOME（放在仓库 .tmp）+ daemon start --foreground + 复制扩展 + 有头 Edge
// 扩展连上后 SW 必然活跃，于是可以从 SW 用 chrome.tabs.create 打开扩展页并 CDP 截图。
//
// 用法：node tools/ui-shots-e2e.mjs [--side ours|bsk|all] [--out docs/ui-shots] [--keep]
import crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync , readdirSync } from 'node:fs';
import net from 'node:net';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs, prepareBrowserProfile } from './browser-launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const SIDE = arg('--side', 'all');
const OUT = path.resolve(ROOT, arg('--out', 'docs/ui-shots'));
const KEEP = process.argv.includes('--keep');
const WITH_DATA = process.argv.includes('--with-data');
const DARK = process.argv.includes('--dark');
const RUNTIME = process.argv.includes('--runtime');
const POPUP_CHECK = process.argv.includes('--popup-check');
const PANELS = process.argv.includes('--panels');
const LAUNCHER = process.argv.includes('--launcher');
const TYPO = process.argv.includes('--typo');
const BASELINE = path.resolve(ROOT, arg('--baseline', 'docs/ui-baseline.json'));
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const EDGE = [process.env.BB_BROWSER_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => existsSync(p));
const BSK_BIN = path.resolve(ROOT, process.env.BSK_BIN || 'ref/bsk-0.5.0-bin/bsk.exe');
const BSK_EXT_SRC = path.resolve(ROOT, process.env.BSK_EXT || 'ref/bsk-0.5.0-ext');
const PAGES = {
  ours: [
    ['popup', 'ui/popup.html', 420, 780],
    ['options', 'ui/options.html', 1000, 900],
    ['quick', 'ui/quick.html', 720, 620],
    ['workspace', 'ui/workspace.html', 1200, 900],
    ['audit', 'ui/audit.html', 1200, 900],
    ['debug', 'ui/debug.html', 1200, 900],
    ['ops', 'ui/ops.html', 1000, 900],
    ['record', 'ui/record.html', 1000, 900],
    ['longshot', 'ui/longshot.html', 1000, 900],
    ['preview', 'ui/preview.html', 900, 700],
    ['privacy', 'ui/privacy.html', 900, 700],
  ],
  bsk: [
    ['popup', 'popup.html', 420, 780],
    ['audit', 'audit.html', 1200, 900],
    ['debug', 'debug.html', 1200, 900],
    ['long-screenshot', 'long-screenshot.html', 1000, 900],
    ['video', 'video.html', 1000, 900],
  ],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tail = (value, n = 400) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, n);
function killTree(pid) {
  if (!pid) return;
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
}
async function pickPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function run(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd || ROOT, env: { ...process.env, ...(options.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { killTree(child.pid); resolve({ exit: 'TIMEOUT', stdout, stderr }); }, options.timeoutMs || 30000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ exit: -1, stdout, stderr: stderr + String(e && e.message) }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ exit: code, stdout, stderr }); });
  });
}
function parseJsonAny(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* try line */ }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch { /* next */ } }
  return null;
}
async function waitFor(fn, timeoutMs = 60000, interval = 400) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const value = await fn(); if (value) return value; } catch { /* retry */ }
    await sleep(interval);
  }
  return null;
}
async function cdpConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let message; try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result || {});
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}


let runtimeUrl = '';
function background(file, args, env) {
  const child = spawn(file, args, { cwd: ROOT, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.out = '';
  child.stdout.on('data', (c) => { child.out += c; });
  child.stderr.on('data', (c) => { child.out += c; });
  child.on('error', () => {});
  return child;
}
async function runtimeShot(side, name) {
  const sideOut = path.join(OUT, side.kind);
  mkdirSync(sideOut, { recursive: true });
  const portFile = path.join(side.profile, 'DevToolsActivePort');
  const info = await waitFor(() => {
    if (!existsSync(portFile)) return null;
    const lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    return lines[0] ? { port: Number(lines[0]) } : null;
  }, 15000);
  if (!info) return false;
  const listing = await (await fetch('http://127.0.0.1:' + info.port + '/json/list')).json();
  const pageTarget = [...listing].reverse().find((item) => item.type === 'page' && String(item.url).includes(runtimeUrl));
  if (!pageTarget) { console.error('  ' + name + ': 页面未找到'); return false; }
  const pageWs = await cdpConnect(pageTarget.webSocketDebuggerUrl);
  try {
    await pageWs.send('Page.enable');
    await pageWs.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const shot = await pageWs.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const buf = Buffer.from(shot.data, 'base64');
    writeFileSync(path.join(sideOut, name + '.png'), buf);
    console.log('  runtime/' + name + ': ' + buf.length + ' bytes');
    return true;
  } finally { pageWs.close(); }
}
async function captureRuntime(side) {
  const call = side.kind === 'ours'
    ? (argv) => run(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), '--port', String(side.port || 0), ...argv, '--json'], {})
    : (argv) => run(BSK_BIN, argv, { env: { BSK_HOME: process.env.BSK_HOME || '', BSK_AUTO_START: '0' } });
  const ours = side.kind === 'ours';
  if (ours) {
    await run(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), '--port', String(side.port), 'open', runtimeUrl, '--json'], {});
  } else {
    await call(['open', runtimeUrl, '--focus']);
  }
  await sleep(1200);
  // 1) 录制浮层
  if (ours) {
    const rec = background(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), '--port', String(side.port), 'record', 'start', '--include-agent', '--json'], {});
    await sleep(1200);
    await runtimeShot(side, 'runtime-record-overlay');
    background(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), '--port', String(side.port), 'record', 'stop', '--json'], {});
    killTree(rec.pid);
  } else {
    const rec = background(BSK_BIN, ['record', 'start', '--url', runtimeUrl, '--output', path.join(ROOT, '.tmp', 'ui-runtime', 'bsk-record')], { BSK_HOME: process.env.BSK_HOME || '', BSK_AUTO_START: '0' });
    await sleep(1800);
    await runtimeShot(side, 'runtime-record-overlay');
    await call(['record', 'stop', '--output', path.join(ROOT, '.tmp', 'ui-runtime', 'bsk-record')]);
    killTree(rec.pid);
  }
  // 2) 协助卡片
  if (ours) {
    const help = background(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), '--port', String(side.port), 'request-help', '--reason', '运行时 UI 截图：请完成一次人工确认', '--timeout-ms', '15000', '--json'], {});
    await sleep(1200);
    await runtimeShot(side, 'runtime-help-card');
    killTree(help.pid);
  } else {
    const help = background(BSK_BIN, ['request-help', '--prompt', '运行时 UI 截图：请完成一次人工确认'], { BSK_HOME: process.env.BSK_HOME || '', BSK_AUTO_START: '0' });
    await sleep(1500);
    await runtimeShot(side, 'runtime-help-card');
    killTree(help.pid);
  }
  // 3) 借用确认
  try {
    const list = ours
      ? await run(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), '--port', String(side.port), 'tab', 'list', '--scope', 'user', '--json'], {})
      : await call(['tab', 'list', '--scope', 'user', '--json']);
    const json = parseJsonAny(list.stdout) || {};
    const tabs = Array.isArray(json) ? json : (json.tabs || (json.result && json.result.tabs) || []);
    const id = tabs.length ? (tabs[0].tabId || tabs[0].tab_id || tabs[0].id) : null;
    if (id) {
      const borrow = ours
        ? background(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), '--port', String(side.port), 'tab', 'borrow', String(id), '--json'], {})
        : background(BSK_BIN, ['tab', 'borrow', String(id)], { BSK_HOME: process.env.BSK_HOME || '', BSK_AUTO_START: '0' });
      await sleep(1500);
      await runtimeShot(side, 'runtime-borrow-confirm');
      killTree(borrow.pid);
    }
  } catch { /* 借用确认在受限页面可能不可用 */ }
}

async function startOurs(workRoot) {
  const port = await pickPort();
  const home = path.join(workRoot, 'our-home');
  const profile = path.join(workRoot, 'our-profile');
  const extDir = path.join(workRoot, 'our-ext');
  mkdirSync(home, { recursive: true }); mkdirSync(profile, { recursive: true });
  cpSync(path.join(ROOT, 'extension'), extDir, { recursive: true });
  const wsPath = path.join(extDir, 'src', 'ws-client.js');
  const patched = readFileSync(wsPath, 'utf8').replace(/const PORTS = \[[^\]]*\];/, `const PORTS = [${port}];`);
  writeFileSync(wsPath, patched, 'utf8');
  const env = { BB_HOME: home, BB_PORT: String(port) };
  const daemon = spawn(NODE, [path.join(ROOT, 'daemon', 'server.mjs'), '--foreground', '--port', String(port)], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  daemon.on('error', () => {});
  prepareBrowserProfile(profile);
  const launchArgs = browserArgs({ profileDir: profile, extensionDir: extDir, windowSize: '1280,900' });
  if (RUNTIME) { const idx = launchArgs.indexOf('about:blank'); if (idx >= 0) launchArgs.splice(idx, 1); launchArgs.push(runtimeUrl); }
  const browser = spawn(EDGE, launchArgs.concat(['--remote-debugging-port=0']), { stdio: 'ignore', windowsHide: false });
  browser.on('error', () => {});
  const cli = (argv) => run(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), '--port', String(port), ...argv, '--json'], { env });
  const ready = await waitFor(async () => {
    const res = await cli(['status']);
    const body = parseJsonAny(res.stdout);
    const payload = body && body.result ? body.result : body;
    return payload && Array.isArray(payload.browsers) && payload.browsers.length > 0 ? payload : null;
  }, 60000);
  if (!ready) throw new Error('我们侧扩展未连接：' + tail((await cli(['status'])).stdout));
  const side = { kind: 'ours', daemon, browser, profile, nameHint: 'bridgedeck', cli };
  if (WITH_DATA) {
    const fixture = seedUrlValue;
    await cli(['open', fixture]);
    await sleep(500);
    await cli(['click', '#btn']).catch(() => {});
    await cli(['observe']).catch(() => {});
    await sleep(400);
    await cli(['close']).catch(() => {});
    await sleep(1500);

  }
  return side;
}

async function startBsk(workRoot) {
  const bskHome = path.join(ROOT, '.tmp', 'ui-shots', 'bsk-home-' + Date.now());
  const profile = path.join(workRoot, 'bsk-profile');
  const extDir = path.join(workRoot, 'bsk-ext');
  mkdirSync(bskHome, { recursive: true }); mkdirSync(profile, { recursive: true });
  cpSync(BSK_EXT_SRC, extDir, { recursive: true });
  const env = { BSK_HOME: bskHome, BSK_AUTO_START: '0' };
  const daemon = spawn(BSK_BIN, ['daemon', 'start', '--foreground'], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  daemon.on('error', () => {});
  const daemonReady = await waitFor(async () => {
    const out = await run(BSK_BIN, ['status', '--json'], { env });
    return parseJsonAny(out.stdout) ? true : null;
  }, 45000);
  if (!daemonReady) throw new Error('参考实现 daemon 未就绪');
  prepareBrowserProfile(profile);
  const launchArgs2 = browserArgs({ profileDir: profile, extensionDir: extDir, windowSize: '1280,900' });
  if (RUNTIME) { const idx = launchArgs2.indexOf('about:blank'); if (idx >= 0) launchArgs2.splice(idx, 1); launchArgs2.push(runtimeUrl); }
  const browser = spawn(EDGE, launchArgs2.concat(['--remote-debugging-port=0']), { stdio: 'ignore', windowsHide: false });
  browser.on('error', () => {});
  const ready = await waitFor(async () => {
    const out = await run(BSK_BIN, ['browsers', '--json'], { env });
    const json = parseJsonAny(out.stdout);
    return Array.isArray(json) && json.length > 0 ? json : null;
  }, 60000);
  if (!ready) throw new Error('参考实现扩展未连接');
  const bskCall = (argv) => run(BSK_BIN, argv, { env });
  const side = { kind: 'bsk', daemon, browser, profile, nameHint: 'browser-skill', bskCall };
  if (WITH_DATA) {
    await bskCall(['open', seedUrlValue, '--focus']).catch(() => {});
    await sleep(800);
  }
  return side;
}

async function captureSide(side, workRoot) {
  const sideOut = path.join(OUT, side.kind);
  mkdirSync(sideOut, { recursive: true });
  const portFile = path.join(side.profile, 'DevToolsActivePort');
  const info = await waitFor(() => {
    if (!existsSync(portFile)) return null;
    const lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    return lines[0] ? { port: Number(lines[0]), path: lines[1] || '' } : null;
  }, 30000);
  if (!info) throw new Error('DevToolsActivePort 未出现');
  const browser = await cdpConnect('ws://127.0.0.1:' + info.port + (info.path.startsWith('/') ? info.path : '/' + info.path));
  const all = await browser.send('Target.getTargets');
  console.error('TARGETS: ' + all.targetInfos.map((i) => i.type + ' | ' + i.url + ' | ' + i.title).join('\n         '));
  const swTargets = await waitFor(async () => {
    const { targetInfos } = await browser.send('Target.getTargets');
    const list = targetInfos.filter((item) => item.type === 'service_worker' && item.url.includes('/background'));
    return list.length ? list : null;
  }, 30000);
  if (!swTargets) throw new Error('未找到扩展 SW');
  let chosen = null;
  let chosenSession = null;
  for (const candidate of swTargets) {
    let attached = null;
    try { attached = await browser.send('Target.attachToTarget', { targetId: candidate.targetId, flatten: true }); } catch { continue; }
    try {
      await browser.send('Runtime.enable', {}, attached.sessionId);
      const probeRel = PAGES[side.kind][0][1];
      const probe = await browser.send('Runtime.evaluate', {
        expression: 'new Promise(function (resolve) { chrome.tabs.create({ url: chrome.runtime.getURL(' + JSON.stringify(probeRel) + ') }, function (tab) { resolve(tab && tab.id); }); })',
        awaitPromise: true, returnByValue: true,
      }, attached.sessionId);
      const probeTab = probe && probe.result ? probe.result.value : null;
      const probeTarget = await waitFor(async () => {
        const listing = await (await fetch('http://127.0.0.1:' + info.port + '/json/list')).json();
        return listing.find((item) => item.type === 'page' && String(item.url).includes(probeRel)) || null;
      }, 8000);
      if (probeTarget) {
        const probeWs = await cdpConnect(probeTarget.webSocketDebuggerUrl);
        try {
          await probeWs.send('Runtime.enable');
          const title = await probeWs.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
          const value = String(title && title.result ? title.result.value : '').toLowerCase();
          if (value.includes(side.nameHint)) { chosen = candidate; chosenSession = attached.sessionId; }
        } finally { probeWs.close(); }
      }
      if (probeTab) await browser.send('Runtime.evaluate', { expression: 'chrome.tabs.remove(' + Number(probeTab) + ')' }, attached.sessionId).catch(() => {});
      if (chosen) break;
    } catch { /* try next */ }
  }
  if (!chosen) throw new Error('无法 attach 扩展 SW');
  console.log(side.kind + ': sw=' + chosen.url + ' title=' + chosen.title);
  const sessionId = chosenSession;
  for (const [label, rel, width, height] of PAGES[side.kind]) {
    const expression = 'new Promise(function (resolve) { chrome.tabs.create({ url: chrome.runtime.getURL(' + JSON.stringify(rel) + '), active: true }, function (tab) { resolve(tab && tab.id); }); })';
    const created = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const tabId = created && created.result ? created.result.value : null;
    const pageTarget = await waitFor(async () => {
      const listing = await (await fetch('http://127.0.0.1:' + info.port + '/json/list')).json();
      return listing.find((item) => item.type === 'page' && String(item.url).includes(rel)) || null;
    }, 20000);
    if (!pageTarget) { console.error('  ' + label + ': 页面未打开'); continue; }
    const pageWs = await cdpConnect(pageTarget.webSocketDebuggerUrl);
    try {
      await pageWs.send('Page.enable');
      await pageWs.send('Runtime.enable');
      await pageWs.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      if (DARK) {
        await pageWs.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      }
      await waitFor(async () => {
        const ready = await pageWs.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        return ready && ready.result && ready.result.value === 'complete';
      }, 20000);
      await sleep(900);
      const shot = await pageWs.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const buf = Buffer.from(shot.data, 'base64');
      writeFileSync(path.join(sideOut, label + '.png'), buf);
      if (LAUNCHER && label === 'popup') {
        const clickL = (expression) => pageWs.send('Runtime.evaluate', { expression, returnByValue: true });
        if (side.kind === 'ours') await clickL("document.getElementById('openFeatures')?.click()");
        else await clickL("(function(){const all=[...document.querySelectorAll('button,[role=button]')];const b=all.find(x=>/快捷功能/.test((x.getAttribute&&x.getAttribute('aria-label')||'')+(x.getAttribute&&x.getAttribute('title')||'')))||all.find(x=>/快捷功能/.test(x.textContent||''));if(b)b.click();})()");
        await sleep(600);
        const shotL = await pageWs.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        writeFileSync(path.join(sideOut, 'popup-features.png'), Buffer.from(shotL.data, 'base64'));
      }
      if (PANELS && label === 'popup') {
        const click = (expression) => pageWs.send('Runtime.evaluate', { expression, returnByValue: true });
        if (side.kind === 'ours') {
          await click("document.getElementById('openFeatures')?.click()");
          await sleep(350);
          await click("document.querySelector('.feature[data-page=\"ops.html\"]')?.click()");
        } else {
          await click("(function(){const all=[...document.querySelectorAll('button,[role=button]')];const b=all.find(x=>/快捷功能/.test((x.getAttribute&&x.getAttribute('aria-label')||'')+(x.getAttribute&&x.getAttribute('title')||'')))||all.find(x=>/快捷功能/.test(x.textContent||''));if(b)b.click();})()");
          await sleep(450);
          await click("(function(){const all=[...document.querySelectorAll('button,[role=button],a')];const b=all.find(x=>/操作录制/.test(x.textContent||''));if(b)b.click();})()");
        }
        await sleep(600);
        const shotPanel = await pageWs.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        writeFileSync(path.join(sideOut, 'popup-panel.png'), Buffer.from(shotPanel.data, 'base64'));
        console.log('  panel: popup-panel.png');
      }
      if (TYPO && label === 'popup') {
        const script = `(() => {
          const labels = ['已连接','当前浏览器','未命名浏览器','连接设置','控制提示','自动化设置','借用标签页前确认','允许请求人工协助','CLI','实例 ID','视频录制','网站调试','长截图','操作录制','操作审计','将任务标签页录制为 MP4 视频','记录请求、异常与页面上下文'];
          const out = {};
          const all = [...document.querySelectorAll('*')];
          for (const label of labels) {
            const el = all.find((e) => e.children.length === 0 && (e.textContent || '').trim().startsWith(label));
            if (!el) { out[label] = null; continue; }
            const s = getComputedStyle(el);
            out[label] = { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, padding: s.padding, margin: s.margin };
          }
          const h1 = document.querySelector('.brand h1');
          if (h1) { const r=h1.getBoundingClientRect(); const s=getComputedStyle(h1); const bt=h1.parentElement; const br=bt.getBoundingClientRect(); const bs=getComputedStyle(bt); out.__header={text:h1.textContent,rect:{x:Math.round(r.x),w:Math.round(r.width)},textAlign:s.textAlign,flex:s.flex,parentTag:bt.tagName,parentClass:bt.className,parentDisplay:bs.display,parentAlign:bs.alignItems,parentRect:{x:Math.round(br.x),w:Math.round(br.width)},backRect:(()=>{const b=document.getElementById('backFromFeatures');if(!b)return null;const rr=b.getBoundingClientRect();return {x:Math.round(rr.x),w:Math.round(rr.width),hidden:b.classList.contains('hidden')}})()}; }
          const body = getComputedStyle(document.body);
          out.__body = { fontSize: body.fontSize, lineHeight: body.lineHeight, width: document.body.clientWidth };
          return out;
        })()`;
        const res = await pageWs.send('Runtime.evaluate', { expression: script, returnByValue: true });
        console.log('TYPO ' + side.kind + ' ' + JSON.stringify(res && res.result ? res.result.value : null));
      }
      if (POPUP_CHECK && side.kind === 'ours' && label === 'popup') {
        const evalJs = async (expression) => {
          const out = await pageWs.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
          return out && out.result ? out.result.value : null;
        };
        const before = await evalJs("({ remote: document.getElementById('modeRemote')?.className || '', toggle: document.getElementById('connToggle')?.getAttribute('aria-checked') })");
        await evalJs("document.getElementById('modeRemote').click()");
        await sleep(350);
        const remoteMode = await evalJs("({ remote: document.getElementById('modeRemote')?.className || '', local: document.getElementById('modeLocal')?.className || '', pairHidden: document.getElementById('pairDetails')?.hidden })");
        await evalJs("document.getElementById('modeLocal').click()");
        await sleep(250);
        const toggleBefore = await evalJs("document.getElementById('connToggle')?.getAttribute('aria-checked')");
        await evalJs("document.getElementById('connToggle').click()");
        await sleep(300);
        const toggleAfter = await evalJs("document.getElementById('connToggle')?.getAttribute('aria-checked')");
        const okMode = String(remoteMode.remote).includes('on') && !String(remoteMode.local).includes('on');
        const okToggle = toggleAfter !== toggleBefore;
        console.log('  popup-check: mode=' + JSON.stringify(remoteMode) + ' toggle ' + toggleBefore + '->' + toggleAfter + ' => ' + (okMode && okToggle ? 'PASS' : 'FAIL'));
        if (!(okMode && okToggle)) failed += 1;
        const shot2 = await pageWs.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        writeFileSync(path.join(sideOut, 'popup-conn-settings.png'), Buffer.from(shot2.data, 'base64'));
        await evalJs("document.getElementById('modeLocal').click()").catch(() => {});
      }
      console.log('  ' + label + ': ' + buf.length + ' bytes');
    } finally { pageWs.close(); }
    if (tabId) await browser.send('Runtime.evaluate', { expression: 'chrome.tabs.remove(' + Number(tabId) + ')' }, sessionId).catch(() => {});
    await sleep(250);
  }
  browser.close();
}

let seedServer = null;
let seedUrlValue = '';
async function startSeedServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>UI 数据态夹具</title><h1>UI 数据态夹具</h1><button id="btn">Submit Query</button><div id="result">idle</div>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  seedServer = server;
  seedUrlValue = 'http://127.0.0.1:' + server.address().port + '/';
  return seedUrlValue;
}

const workRoot = mkdtempSync(path.join(tmpdir(), 'ui-shots-e2e-'));
if (WITH_DATA || RUNTIME) { await startSeedServer(); runtimeUrl = seedUrlValue; }
const wanted = SIDE === 'all' ? ['ours', 'bsk'] : [SIDE];
let failed = 0;
for (const name of wanted) {
  let side = null;
  try {
    side = name === 'ours' ? await startOurs(workRoot) : await startBsk(workRoot);
    if (RUNTIME) await captureRuntime(side);
    else await captureSide(side, workRoot);
  } catch (error) {
    failed += 1;
    console.error(name + ' 截图失败：' + (error && error.message ? error.message : error));
  } finally {
    if (side) { killTree(side.browser && side.browser.pid); killTree(side.daemon && side.daemon.pid); }
    await sleep(1500);
  }
}
if (seedServer) { try { seedServer.server.close(); } catch { /* ignore */ } }
if (!KEEP) { try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
// 截图基线：记录每张 PNG 的 sha256+bytes；--check 时报告漂移（视觉回归提示，不做像素 diff）
const shots = {};
if (existsSync(OUT)) {
  for (const side of ['ours', 'bsk']) {
    const dir = path.join(OUT, side);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.png')) continue;
      const buf = readFileSync(path.join(dir, name));
      shots[side + '/' + name] = { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
    }
  }
}
if (UPDATE_BASELINE) {
  writeFileSync(BASELINE, JSON.stringify({ generatedAt: new Date().toISOString(), shots }, null, 2) + '\n', 'utf8');
  console.log('baseline updated: ' + path.relative(ROOT, BASELINE));
} else if (process.argv.includes('--check') && existsSync(BASELINE)) {
  // 截图含实时数据（端口/版本/时间线），因此用“尺寸漂移 ±15%”做回归信号；hash 变化只报告不失败。
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')).shots || {};
  const drift = [];
  const changed = [];
  for (const key of Object.keys(shots)) {
    const before = base[key];
    if (!before) { drift.push(key + '(new)'); continue; }
    if (before.sha256 !== shots[key].sha256) changed.push(key);
    const ratio = Math.abs(shots[key].bytes - before.bytes) / Math.max(1, before.bytes);
    if (ratio > 0.15) drift.push(key + '(' + Math.round(ratio * 100) + '%)');
  }
  if (changed.length) console.log('screenshot changed (info): ' + changed.join(', '));
  if (drift.length) { console.error('截图尺寸显著漂移：' + drift.join(', ')); failed += 1; }
  else console.log('screenshot baseline: clean (' + Object.keys(shots).length + ' shots)');
}
console.log(JSON.stringify({ ok: failed === 0, failed, out: path.relative(ROOT, OUT) }, null, 2));
if (failed) process.exitCode = 1;
