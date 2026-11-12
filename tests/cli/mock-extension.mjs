// tests/cli/mock-extension.mjs — 模拟浏览器扩展（零依赖）。
//
// 用 lib/ws.mjs 的 connectWs 连 daemon 的 /ws，按 docs/PROTOCOL.md §3：
//   - 连上后发 hello，收 hello-ack（重连时带上上次 instanceId 作为提示）
//   - 收到 ping 回 pong
//   - 收到 cmd 按 method 回 { type:"res", id, ok:true, result } / { ok:false, error }
//
// 用途：不依赖真实浏览器地自测 daemon + CLI 全链路（tests/cli/selftest.mjs）。
// 简化：window.ensureAgent 每次都新建一个 agent 窗口/tab，便于测试多 session；真实扩展会复用。

import zlib from 'node:zlib';
import { connectWs } from '../../lib/ws.mjs';

const EXT_VERSION = '0.1.2';
const BROWSER_VERSION = '156.0.4314.58';

const OBSERVATION = [
  '- document "Mock Page"',
  '  - navigation',
  '    - link "More" [@e1]',
  '  - heading "Mock Page" [level=1]',
  '  - textbox "Search" [@e2]',
  '  - button "Go" [@e3]',
].join('\n');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.BB_PORT) || 0,
    browser: 'edge',
    instanceId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') { opts.port = Number(argv[i + 1]); i += 1; }
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length));
    else if (arg === '--browser') { opts.browser = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--browser=')) opts.browser = arg.slice('--browser='.length);
    else if (arg === '--instance-id') { opts.instanceId = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--instance-id=')) opts.instanceId = arg.slice('--instance-id='.length);
    else if (arg === '-h' || arg === '--help') {
      console.log('用法：node tests/cli/mock-extension.mjs --port <daemonPort> [--browser edge|chrome] [--instance-id <hex8>]');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  if (!opts.port) {
    console.error('需要 --port <daemonPort>（或设置 BB_PORT）');
    process.exit(2);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// mock 状态
// ---------------------------------------------------------------------------

let instanceId = opts.instanceId; // hello 里带上，用于重连时沿用 instanceId
let stopped = false;
let connection = null;
let currentUrl = 'about:blank';
let nextTabId = 12;
let nextWindowId = 3;
let mockSettings = { instanceLabel: '', borrowConfirm: true, allowHelp: true, pageGuard: true, longShotMode: 'auto' };
const agentTabs = new Map(); // tabId -> { tabId, windowId, url, title }
const userTabs = new Map(); // tabId -> { tabId, windowId, url, title }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

// ---------------------------------------------------------------------------
// 一张真实的 300x200 PNG（用于 screenshot 回包，CLI 会落盘成文件）
// ---------------------------------------------------------------------------

function crc32(buffer) {
  const table = crc32.table || (crc32.table = (() => {
    const result = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      result[n] = c;
    }
    return result;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = Math.floor((x / width) * 255);
      raw[offset + 1] = Math.floor((y / height) * 255);
      raw[offset + 2] = 180;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const SCREENSHOT_PNG = makePng(300, 200);
const SCREENSHOT_DATA_URL = `data:image/png;base64,${SCREENSHOT_PNG.toString('base64')}`;

// ---------------------------------------------------------------------------
// 命令实现（按 PROTOCOL §5 的 result 形状回包）
// ---------------------------------------------------------------------------

function createAgentTab() {
  const tabId = nextTabId;
  const windowId = nextWindowId;
  nextTabId += 1;
  nextWindowId += 1;
  const tab = { tabId, windowId, url: 'about:blank', title: 'Mock Page' };
  agentTabs.set(tabId, tab);
  return { tabId, windowId };
}

function tabView(tab) {
  return {
    tabId: tab.tabId,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    active: true,
  };
}

function evaluateExpression(expression) {
  try {
    // 只用于测试表达式（selftest 传的是常量表达式）。
    return Function(`"use strict"; return (${String(expression)});`)();
  } catch {
    return null;
  }
}

function dispatchCommand(method, params = {}) {
  const tabId = params.tabId;
  switch (method) {
    case 'window.ensureAgent':
    case 'window.newAgent':
      return createAgentTab();
    case 'window.close':
      // mock 不真正关窗，避免用例间互相影响。
      return { ok: true, windowId: params.windowId };
    case 'tab.list': {
      const scope = params.scope === 'user' ? 'user' : 'agent';
      const source = scope === 'user' ? userTabs : agentTabs;
      return { tabs: [...source.values()].map(tabView) };
    }
    case 'tab.new': {
      const tab = { tabId: nextTabId, windowId: nextWindowId, url: params.url || 'about:blank', title: 'Mock Tab' };
      nextTabId += 1;
      nextWindowId += 1;
      agentTabs.set(tab.tabId, tab);
      return { tabId: tab.tabId, windowId: tab.windowId };
    }
    case 'tab.close':
      // mock 不真正删 tab，避免自测用例的执行顺序互相影响。
      return { ok: true };
    case 'tab.select':
      return { ok: true };
    case 'window.resize':
      return { ok: true };
    case 'navigate': {
      currentUrl = String(params.url || 'about:blank');
      const tab = agentTabs.get(tabId);
      if (tab) tab.url = currentUrl;
      return { url: currentUrl, title: 'Mock Page' };
    }
    case 'reload':
    case 'navigate-back':
    case 'navigate-forward':
      return { ok: true };
    case 'wait-ms':
      return { ok: true };
    case 'wait-for-navigation':
      return { url: currentUrl };
    case 'wait-for-element':
      return { ok: true };
    case 'observe':
      return { url: currentUrl, title: 'Mock Page', observation: OBSERVATION, refs: 3 };
    case 'snapshot':
      return { text: '- document "Mock Page"\n  - heading "Mock Page" [level=1]' };
    case 'get-html':
      return {
        html: '<!doctype html><html><body><h1>Mock Page</h1><input id="q"><button id="btn">Go</button><div id="out"></div></body></html>',
        url: currentUrl,
      };
    case 'screenshot':
      return { dataUrl: SCREENSHOT_DATA_URL, width: 300, height: 200 };
    case 'evaluate': {
      const value = evaluateExpression(params.expression);
      return { value: value === undefined ? null : value };
    }
    case 'console':
      return { entries: [{ level: 'log', text: 'hello console', ts: Date.now() }] };
    case 'click':
    case 'hover':
    case 'fill':
    case 'press':
    case 'select':
    case 'focus':
    case 'blur':
    case 'scroll-to':
    case 'drag':
    case 'wheel':
    case 'dialog.arm':
    case 'dialog.disarm':
    case 'dialog.handle':
    case 'network.start':
    case 'network.stop':
    case 'emulate':
    case 'tab.borrow':
    case 'tab.return':
    case 'debugger.detach':
    case 'screenshot.manual.start':
      return { ok: true };
    case 'read':
      return {
        fields: [
          { tag: 'input', type: 'text', name: 'kw', value: 'mock', disabled: false, readonly: false, required: false, contentEditable: false },
        ],
      };
    case 'extract':
      return {
        kind: 'table',
        columns: [{ key: 'c1', label: '姓名' }, { key: 'c2', label: '城市' }],
        rows: [{ c1: '张三', c2: '北京' }],
        rowCount: 1,
        truncated: false,
        warnings: [],
      };
    case 'upload':
      return { ok: true, names: (params.files || []).map((file) => (file && file.name) || '').filter(Boolean) };
    case 'request-help':
      return { action: 'done' };
    case 'download':
      return { downloadId: 1, filename: '/tmp/mock-download.bin', bytes: 12, state: 'complete', url: currentUrl };
    case 'plan':
      return { steps: (params.steps || []).map((step, index) => ({ index, method: step.method, ok: true, result: { ok: true } })), completed: (params.steps || []).length, failedAt: null };
    case 'step':
      return { action: { ok: true }, observation: { text: OBSERVATION, refs: 3, changed: 1 } };
    case 'dialog.list':
      return { dialogs: [{ id: 1, type: 'confirm', message: 'mock?', action: 'dismiss', at: Date.now() }], armed: true };
    case 'network.list':
      return { entries: [{ id: 1, method: 'GET', url: currentUrl, status: 200, type: 'xmlhttprequest', startedAt: Date.now(), durationMs: 3, requestBytes: 0, responseBytes: 12, error: null, fromCache: false, pageUrl: currentUrl }], active: true, bodies: false, total: 1 };
    case 'network.detail':
      return { entry: { id: 1, method: 'GET', url: currentUrl, status: 200 } };
    case 'network.replay':
      return { status: 200, headers: {}, body: '{"ok":true}', durationMs: 4 };
    case 'screenshot.manual.frame':
      return { ok: true, frames: 1, width: 300, height: 200 };
    case 'screenshot.manual.save':
      return { ok: true, dataUrl: SCREENSHOT_DATA_URL, frames: 1, width: 300, height: 200 };
    case 'settings.get':
      return { settings: mockSettings, label: mockSettings.instanceLabel };
    case 'settings.set':
      mockSettings = { ...mockSettings, ...(params.patch || {}) };
      return { settings: mockSettings };
    case 'diagnostics.ui':
      return {
        ok: true,
        popup: { path: 'ui/popup.html', ok: true, bytes: 100 },
        options: { path: 'ui/options.html', ok: true, bytes: 100 },
        icons: [{ size: 16, ok: true }, { size: 32, ok: true }, { size: 48, ok: true }, { size: 128, ok: true }],
        packageVersion: EXT_VERSION,
      };
    default:
      fail('E_UNKNOWN_METHOD', `unknown method: ${method}`);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// WS 会话
// ---------------------------------------------------------------------------

function handleMessage(conn, raw, isBinary) {
  if (isBinary) return;
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.type === 'hello-ack') {
    instanceId = message.instanceId;
    console.log(`[mock] hello-ack instanceId=${message.instanceId} daemonVersion=${message.daemonVersion}`);
    return;
  }
  if (message.type === 'ping') {
    conn.sendJson({ type: 'pong' });
    return;
  }
  if (message.type === 'pong') return;
  if (message.type === 'cmd') {
    const params = message.params || {};
    // 测试钩子：evaluate "delay:<ms>" 故意延迟回包，用于验证 daemon 超时与迟到回包丢弃。
    if (message.method === 'evaluate' && typeof params.expression === 'string' && params.expression.startsWith('delay:')) {
      const delayMs = Number(params.expression.slice('delay:'.length)) || 0;
      setTimeout(() => {
        try {
          conn.sendJson({ type: 'res', id: message.id, ok: true, result: { value: `late:${delayMs}` } });
        } catch { /* 连接可能已关闭 */ }
      }, delayMs);
      return;
    }
    try {
      const result = dispatchCommand(message.method, params);
      conn.sendJson({ type: 'res', id: message.id, ok: true, result });
    } catch (err) {
      conn.sendJson({
        type: 'res',
        id: message.id,
        ok: false,
        error: { code: err.code || 'E_INTERNAL', message: err.message || String(err) },
      });
    }
  }
}

function runConnection(conn) {
  const hello = {
    type: 'hello',
    protocol: '1.8',
    capabilities: ['observe', 'dialog'],
    extVersion: EXT_VERSION,
    browser: opts.browser,
    browserVersion: BROWSER_VERSION,
    userAgent: 'browser-bridge-mock-extension',
  };
  if (instanceId) hello.instanceId = instanceId;
  conn.sendJson(hello);
  conn.on('message', (raw, isBinary) => handleMessage(conn, raw, isBinary));
  return new Promise((resolve) => {
    conn.on('close', resolve);
    conn.on('error', () => { /* 等待 close 事件 */ });
  });
}

async function main() {
  const url = `ws://127.0.0.1:${opts.port}/ws?role=extension&v=${EXT_VERSION}`;
  while (!stopped) {
    try {
      const conn = await connectWs(url, { timeoutMs: 3000 });
      connection = conn;
      console.log(`[mock] connected ${url}${instanceId ? ` (instanceId hint ${instanceId})` : ''}`);
      await runConnection(conn);
      if (stopped) break;
      console.log('[mock] connection closed, reconnecting in 1s');
    } catch (err) {
      if (stopped) break;
      console.error(`[mock] connect failed: ${err && err.message ? err.message : err}; retry in 1s`);
    }
    await sleep(1000);
  }
}

function shutdown() {
  stopped = true;
  try { if (connection && !connection.closed) connection.close(1000, 'mock shutdown'); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(0), 50).unref?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(`[mock] fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
