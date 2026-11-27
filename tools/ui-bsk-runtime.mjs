#!/usr/bin/env node
// tools/ui-bsk-runtime.mjs —— 抓取参考实现（0.5.0）执行期间的页面浮层截图。
//
// 路线：临时 BSK_HOME + `bsk daemon start --foreground` + 复制扩展 + 有头 Edge（用户窗口先开 fixture 页）；
// 再 `bsk open` 建 Agent Window，按场景触发 borrow / request-help / record / full-page screenshot，
// 期间用 CDP 对 fixture 页面（用户窗口与 Agent Window 各一个）截图。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs, prepareBrowserProfile } from './browser-launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'ui-shots-runtime', 'bsk');
const BSK_BIN = path.resolve(ROOT, process.env.BSK_BIN || 'ref/bsk-0.5.0-bin/bsk.exe');
const BSK_EXT = path.resolve(ROOT, process.env.BSK_EXT || 'ref/bsk-0.5.0-ext');
const EDGE = [process.env.BB_BROWSER_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function killTree(pid) { if (!pid) return; try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
async function waitFor(fn, timeoutMs = 30000, interval = 300) {
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
    send(method, params = {}) { const id = nextId++; ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })); },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}
function run(file, args, env, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: ROOT, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => { killTree(child.pid); resolve({ exit: 'TIMEOUT', out }); }, timeoutMs);
    child.on('exit', () => { clearTimeout(timer); resolve({ exit: 0, out }); });
    child.on('error', () => { clearTimeout(timer); resolve({ exit: -1, out }); });
  });
}

const work = mkdtempSync(path.join(tmpdir(), 'bsk-runtime-'));
const bskHome = path.join(ROOT, '.tmp', 'ui-runtime', 'bsk-home-' + Date.now());
mkdirSync(bskHome, { recursive: true });
mkdirSync(OUT, { recursive: true });
const env = { BSK_HOME: bskHome, BSK_AUTO_START: '0' };
let daemon = null; let browser = null; let fixtureServer = null;
try {
  // 夹具页（用户窗口先打开它）
  fixtureServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>BSK 运行时夹具</title><h1>BSK 运行时夹具</h1><button id="btn">Submit Query</button><div id="result">idle</div><div style="height:600px"></div>');
  });
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  const fixture = 'http://127.0.0.1:' + fixtureServer.address().port + '/';
  daemon = spawn(BSK_BIN, ['daemon', 'start', '--foreground'], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  const ready = await waitFor(async () => (await run(BSK_BIN, ['status', '--json'], env)).out.includes('"browsers"'), 40000);
  if (!ready) throw new Error('BSK daemon 未就绪：' + (await run(BSK_BIN, ['status', '--json'], env)).out.slice(0, 300));
  const extDir = path.join(work, 'ext'); cpSync(BSK_EXT, extDir, { recursive: true });
  const profile = path.join(work, 'profile'); mkdirSync(profile, { recursive: true });
  prepareBrowserProfile(profile);
  const args = browserArgs({ profileDir: profile, extensionDir: extDir, windowSize: '1280,900' });
  const idx = args.indexOf('about:blank'); if (idx >= 0) args.splice(idx, 1); args.push(fixture);
  browser = spawn(EDGE, args.concat(['--remote-debugging-port=0']), { stdio: 'ignore', windowsHide: false });
  const connected = await waitFor(async () => {
    const out = (await run(BSK_BIN, ['browsers', '--json'], env)).out;
    return out.includes('"instance_id"') || out.includes('instance_id');
  }, 60000);
  if (!connected) throw new Error('BSK 扩展未连接');
  const portFile = path.join(profile, 'DevToolsActivePort');
  const info = await waitFor(() => { if (!existsSync(portFile)) return null; const l = readFileSync(portFile, 'utf8').trim().split(/\r?\n/); return l[0] ? { port: Number(l[0]) } : null; }, 30000);
  if (!info) throw new Error('DevToolsActivePort 未出现');
  const bsk = (argv, timeoutMs) => run(BSK_BIN, argv, env, timeoutMs);
  await bsk(['open', fixture, '--focus'], 30000);
  await sleep(1500);
  const shotAll = async (prefix) => {
    const listing = await (await fetch('http://127.0.0.1:' + info.port + '/json/list')).json();
    const pages = listing.filter((item) => item.type === 'page' && String(item.url).includes('127.0.0.1'));
    let index = 0;
    for (const pageTarget of pages) {
      index += 1;
      const pageWs = await cdpConnect(pageTarget.webSocketDebuggerUrl);
      try {
        await pageWs.send('Page.enable');
        await pageWs.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
        await sleep(600);
        const shot = await pageWs.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const buf = Buffer.from(shot.data, 'base64');
        const file = path.join(OUT, prefix + '-' + index + '.png');
        writeFileSync(file, buf);
        console.log(prefix + '-' + index + ': ' + buf.length + ' bytes');
      } finally { pageWs.close(); }
    }
  };
  await shotAll('control-overlay');
  // 2) 协助卡片
  try {
    const help = spawn(BSK_BIN, ['request-help', '--prompt', '运行时 UI 截图：请完成一次人工确认'], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
    await sleep(1800);
    await shotAll('help-card');
    killTree(help.pid);
    await sleep(400);
  } catch (error) { console.error('help 截图失败：' + (error && error.message ? error.message : error)); }
  // 3) 录制浮层
  try {
    const recOut = path.join(ROOT, '.tmp', 'ui-runtime', 'bsk-record');
    const rec = spawn(BSK_BIN, ['record', 'start', '--url', fixture, '--output', recOut], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
    await sleep(2200);
    await shotAll('record-overlay');
    await bsk(['record', 'stop', '--output', recOut], 20000);
    killTree(rec.pid);
  } catch (error) { console.error('record 截图失败：' + (error && error.message ? error.message : error)); }
  // 4) 整页截图进度（多采样：浮层只在采集窗口出现）
  try {
    const outPng = path.join(ROOT, '.tmp', 'ui-runtime', 'bsk-full.png');
    const shot = spawn(BSK_BIN, ['screenshot', '--full-page', '--out', outPng], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
    for (const delay of [250, 600, 1200]) {
      await sleep(delay);
      await shotAll('longshot-progress-' + delay);
    }
    await sleep(2500);
    killTree(shot.pid);
  } catch (error) { console.error('longshot 截图失败：' + (error && error.message ? error.message : error)); }
  // 5) 视频录制状态
  try {
    const video = spawn(BSK_BIN, ['video', 'start', '--duration', '20s'], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
    await sleep(1500);
    await shotAll('video-status');
    await bsk(['video', 'stop', '--out', path.join(ROOT, '.tmp', 'ui-runtime', 'bsk-video.mp4')], 20000);
    killTree(video.pid);
  } catch (error) { console.error('video 截图失败：' + (error && error.message ? error.message : error)); }
  // 6) 借用确认（最后跑，避免遮挡其他浮层）
  try {
    const list = (await bsk(['tab', 'list', '--scope', 'user', '--json'], 20000)).out;
    let parsed = null;
    const raw = list.trim();
    try { parsed = JSON.parse(raw); } catch { const start = raw.search(/[\[{]/); const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}')); if (start >= 0 && end > start) { try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { /* ignore */ } } }
    const tabs = Array.isArray(parsed) ? parsed : (parsed.tabs || []);
    const id = tabs.length ? (tabs[0].tab_id || tabs[0].tabId || tabs[0].id) : null;
    if (id) {
      const borrow = spawn(BSK_BIN, ['tab', 'borrow', String(id)], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
      await sleep(1800);
      await shotAll('borrow-confirm');
      // 真实 UIA 点击“允许”，再截借用后状态
      try {
        const uia = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'uia-click.ps1'), '-Name', '允许', '-WindowText', 'BSK 运行时夹具'], { encoding: 'utf8' });
        await new Promise((resolve) => uia.on('exit', resolve));
        await sleep(1200);
        await shotAll('borrow-after-allow');
      } catch { /* UIA 不可用则跳过 */ }
      killTree(borrow.pid);
      await sleep(400);
    }
  } catch (error) { console.error('borrow 截图失败：' + (error && error.message ? error.message : error)); }
} finally {
  killTree(browser && browser.pid);
  killTree(daemon && daemon.pid);
  try { fixtureServer && fixtureServer.close(); } catch { /* ignore */ }
  await sleep(800);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(JSON.stringify({ ok: true, out: path.relative(ROOT, OUT) }, null, 2));
