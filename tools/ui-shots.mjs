#!/usr/bin/env node
// tools/ui-shots.mjs —— 有头 Edge + CDP 逐页截图扩展 UI（用于 UI/功能对比与视觉基线）。
//
// Edge 会阻止 CDP 直接顶层导航到 chrome-extension:// 页面（ERR_BLOCKED_BY_CLIENT），
// 因此这里改用扩展 service worker 里的 chrome.tabs.create()（扩展上下文可信）打开页面，
// 再通过页面级 CDP 截图；截完用 chrome.tabs.remove 关掉。
//
// 用法：
//   node tools/ui-shots.mjs [--side ours|bsk|all] [--out docs/ui-shots]
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs, prepareBrowserProfile } from './browser-launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const SIDE = arg('--side', 'all');
const OUT = path.resolve(ROOT, arg('--out', 'docs/ui-shots'));
const EDGE = [process.env.BB_BROWSER_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => existsSync(p));
if (!EDGE) { console.error('找不到 Edge'); process.exit(2); }

const SIDES = {
  ours: {
    name: 'BridgeDeck',
    ext: path.join(ROOT, 'extension'),
    pages: [
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
  },
  bsk: {
    name: 'BrowserSkill',
    ext: path.join(ROOT, 'ref', 'bsk-0.5.0-ext'),
    pages: [
      ['popup', 'popup.html', 420, 780],
      ['audit', 'audit.html', 1200, 900],
      ['debug', 'debug.html', 1200, 900],
      ['long-screenshot', 'long-screenshot.html', 1000, 900],
      ['video', 'video.html', 1000, 900],
    ],
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function unpackedExtensionId(dir) {
  const hash = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 32);
  return hash.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}
async function waitFor(fn, timeoutMs = 20000, interval = 200) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(interval);
  }
  if (last) console.error('waitFor timeout:', last.message || last);
  return null;
}
async function cdpConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (event) => reject(new Error('ws error')), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result || {});
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

async function captureSide(name, config) {
  const manifestPath = path.join(config.ext, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('缺少扩展：' + config.ext);
  // Edge 对含中文路径的 --load-extension 可能静默失败（表现为 chrome-extension 页 ERR_FILE_NOT_FOUND），
  // 先复制到 ASCII 临时目录再加载（与 E2E 的做法一致）。
  const extDir = mkdtempSync(path.join(tmpdir(), 'ui-ext-' + name + '-'));
  cpSync(config.ext, extDir, { recursive: true });
  const profile = mkdtempSync(path.join(tmpdir(), 'ui-shots-' + name + '-'));
  const sideOut = path.join(OUT, name);
  mkdirSync(sideOut, { recursive: true });
  prepareBrowserProfile(profile);
  const child = spawn(EDGE, browserArgs({ profileDir: profile, extensionDir: extDir, windowSize: '1280,900' }).concat(['--remote-debugging-port=0']), { stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  let browser = null;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const info = await waitFor(() => {
      if (!existsSync(portFile)) return null;
      const lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      return lines[0] ? { port: Number(lines[0]), path: lines[1] || '' } : null;
    }, 25000);
    if (!info) throw new Error('DevToolsActivePort 未出现');
    const wsPath = info.path.startsWith('/') ? info.path : '/' + info.path;
    browser = await cdpConnect('ws://127.0.0.1:' + info.port + wsPath);
    const manifest = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
    const nameHint = String(manifest.name || config.name || '').toLowerCase();
    const extensionId = unpackedExtensionId(extDir);
    console.log(name + ': computedId=' + extensionId + ' manifest=' + manifest.name);
    // 用本地 http 页唤醒扩展内容脚本 → 内容脚本连 SW → SW 启动（边缘内置扩展的 SW 会被名称过滤排除）。
    const fixture = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>wake</title><h1>wake</h1>'); });
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const fixtureUrl = 'http://127.0.0.1:' + fixture.address().port + '/';
    const wakeTarget = await browser.send('Target.createTarget', { url: fixtureUrl }).catch(() => null);
    const sw = await waitFor(async () => {
      const { targetInfos } = await browser.send('Target.getTargets');
      const infos = targetInfos.filter((item) => item.type === 'service_worker' || item.type === 'page');
      if (!infos.some((item) => item.type === 'service_worker')) console.error('targets:', infos.map((i) => i.type + ':' + i.url + ' title=' + i.title).join(' | '));
      return targetInfos.find((item) => item.type === 'service_worker' && item.url.includes('/background.js') && String(item.title || '').toLowerCase().includes(nameHint)) || null;
    }, 20000);
    if (!sw) {
      const { targetInfos } = await browser.send('Target.getTargets');
      throw new Error('未找到扩展 service worker；targets=' + targetInfos.map((item) => item.type + ':' + item.url).join(' | '));
    }
    const realId = String(sw.url).split('/')[2];
    console.log(name + ': realId=' + realId + ' swTitle=' + sw.title);
    const attached = await browser.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    const sessionId = attached.sessionId;
    if (!sessionId) throw new Error('attachToTarget 没有 sessionId');
    await browser.send('Runtime.enable', {}, sessionId);
    const results = [];
    for (const page of config.pages) {
      const label = page[0];
      const rel = page[1];
      const width = page[2];
      const height = page[3];
      const expression = 'new Promise(function (resolve) { chrome.tabs.create({ url: chrome.runtime.getURL(' + JSON.stringify(rel) + '), active: true }, function (tab) { resolve(tab && tab.id); }); })';
      const created = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      const tabId = created && created.result ? created.result.value : null;
      const pageTarget = await waitFor(async () => {
        const listing = await (await fetch('http://127.0.0.1:' + info.port + '/json/list')).json();
        return listing.find((item) => item.type === 'page' && String(item.url).includes(rel)) || null;
      }, 15000);
      if (!pageTarget) throw new Error('扩展页未打开：' + rel);
      const pageWs = await cdpConnect(pageTarget.webSocketDebuggerUrl);
      try {
        await pageWs.send('Page.enable');
        await pageWs.send('Runtime.enable');
        await pageWs.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await waitFor(async () => {
          const ready = await pageWs.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
          return ready && ready.result && ready.result.value === 'complete';
        }, 15000);
        await sleep(800);
        const shot = await pageWs.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const buf = Buffer.from(shot.data, 'base64');
        writeFileSync(path.join(sideOut, label + '.png'), buf);
        results.push({ label, bytes: buf.length });
        console.log('  ' + label + ': ' + buf.length + ' bytes');
      } finally {
        pageWs.close();
      }
      if (tabId) {
        await browser.send('Runtime.evaluate', { expression: 'chrome.tabs.remove(' + Number(tabId) + ')' }, sessionId).catch(() => {});
      }
      await sleep(200);
    }
    try { fixture.close(); } catch { /* ignore */ }
    if (wakeTarget && wakeTarget.targetId) await browser.send('Target.closeTarget', { targetId: wakeTarget.targetId }).catch(() => {});
    return results;
  } finally {
    if (browser) browser.close();
    try { child.kill(); } catch { /* ignore */ }
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* profile 可能仍被占用 */ }
    try { rmSync(extDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const wanted = SIDE === 'all' ? Object.keys(SIDES) : [SIDE];
let failed = 0;
for (const name of wanted) {
  try {
    await captureSide(name, SIDES[name]);
  } catch (error) {
    failed += 1;
    console.error(name + ' 截图失败：' + (error && error.message ? error.message : error));
  }
}
console.log(JSON.stringify({ ok: failed === 0, failed, out: path.relative(ROOT, OUT) }, null, 2));
if (failed) process.exitCode = 1;
